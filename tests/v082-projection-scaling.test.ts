import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import * as projectionModule from '../src/domain/derive.js'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import {
  deriveProjection,
  PROTOCOL_V5_NOTICE,
  PROTOCOL_V6_NOTICE,
} from '../src/domain/derive.js'
import { snapshotSessionEvents } from '../src/domain/session-events.js'
import { appendPrivateLedger, initializePrivateLedger, readPrivateLedger } from '../src/domain/private-ledger.js'
import type { PrivateLedgerContext } from '../src/domain/private-ledger.js'
import { apply } from '../src/runtime.js'
import type { Agent } from '@deepseek-ai/dsh-agent'

// CG-RC2-003 projection-scaling harness. Measurement-only: this file is
// skipped unless DSH_PROJECTION_MEASUREMENT=1 is set, and it is driven by
// scripts/measure-projection-scaling.mjs, which runs five fresh workers per
// event-count size and aggregates median/p95. The subject is the full-log
// projection path that every runtime entry pays: session snapshot, derive
// projection, the production apply() attach, and the private-ledger read
// (short vs long). Host-lock graph/byte audits are a separate, already
// measured surface (tests/v081-host-protocol-measurement.test.ts).
//
// Classification: synthetic. The session and ledger are synthetic fixtures in
// a temp root; no real host, no installed graph, and no real model runs here.

const io = vi.hoisted(() => ({ reads: 0, bytes: 0 }))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
    const value = fs.readFileSync(...args)
    io.reads += 1
    io.bytes += typeof value === 'string' ? Buffer.byteLength(value) : value.length
    return value
  } }
})
const projections = vi.spyOn(projectionModule, 'deriveProjection')
interface Measurement { entry: string; events: number; wall_ms: number; rss_bytes: number; physical_reads: number; read_bytes: number; projection_calls: number }

const measurements: Measurement[] = []
function begin(): number { io.reads = 0; io.bytes = 0; projections.mockClear(); return performance.now() }
function record(entry: string, events: number, wall_ms: number): void {
  measurements.push({ entry, events, wall_ms, rss_bytes: process.memoryUsage.rss(),
    physical_reads: io.reads, read_bytes: io.bytes, projection_calls: projections.mock.calls.length })
}

function append(session: Session, type: string, data: unknown, options?: unknown): void {
  ;(session as unknown as { append(type: string, data: unknown, options?: unknown): void }).append(type, data, options)
}

/** One realistic agent-turn slab: root input, three tool round-trips (one
 * with a long text result), a boundary notice, and a command. */
function appendTurnSlab(session: Session, index: number, longOutputBytes: number): void {
  const turn = index + 1
  append(session, 'user/message', {
    source: { kind: 'user' },
    content: [{ type: 'text', text: `Run scenario ${index}: inspect the fixture and report status.` }],
  }, { surfaceOp: 'append' })
  for (let call = 0; call < 3; call += 1) {
    const callId = `call-${index}-${call}`
    append(session, 'tool/call', { turn, step: session.seq, callId, name: 'bash', arguments: JSON.stringify({ command: `echo scenario-${index}-${call}` }) })
    const long = call === 1
      ? 'x'.repeat(longOutputBytes)
      : `scenario-${index}-${call} completed`
    append(session, 'tool/result', {
      turn, step: session.seq,
      message: createToolResultMessage({ callId: callId as never, content: [{ type: 'text', text: long }], isError: false }),
    }, { surfaceOp: 'append' })
  }
  append(session, 'user/message', {
    source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' },
    content: [{ type: 'text', text: `${PROTOCOL_V5_NOTICE}\n${PROTOCOL_V6_NOTICE}` }],
  }, { surfaceOp: 'append' })
}

async function seedLedger(root: string, records: number, payloadBytes: number, context: PrivateLedgerContext): Promise<string> {
  const ledgerRoot = join(root, 'private-ledger')
  initializePrivateLedger(ledgerRoot, context)
  for (let index = 0; index < records; index += 1) {
    appendPrivateLedger(ledgerRoot, context, 'restart_intent', {
      resolutionCallId: `call-${index}`, serviceId: 'fixture', preGeneration: 'g1',
      note: 'p'.repeat(payloadBytes),
    })
  }
  return ledgerRoot
}

async function measureSize(events: number): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cg-scaling-'))
  try {
    const session = Session.create(SessionId('projection-scaling'), undefined, {
      version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId('projection-scaling'), createdAt: 1, cwd: root,
    })
    // Eight events per slab; every slab includes one sized tool output.
    const slabs = Math.ceil(events / 6)
    const longOutputBytes = events >= 10000 ? 200_000 : 2_000
    for (let index = 0; index < slabs && session.seq < events; index += 1) {
      appendTurnSlab(session, index, longOutputBytes)
    }
    const boundary = {
      source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' },
      content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }],
    }
    append(session, 'user/message', boundary, { surfaceOp: 'append' })
    const actualEvents = session.snapshotEvents().length

    // 1. Session snapshot (V4 read + envelope validation).
    let start = begin()
    const eventsRead = snapshotSessionEvents(session)
    const snapshotMs = performance.now() - start
    record('snapshot', actualEvents, snapshotMs)

    // 2. Full projection derivation (pure fold over the whole log).
    start = begin()
    const derived = deriveProjection(eventsRead as never,
      { activation: 'always', policy: 'release' },
      { cwd: String(session.header.cwd) }, true)
    const deriveMs = performance.now() - start
    record('derive_projection', actualEvents, deriveMs)

    // 3. Production attach: apply() performs the first full rebuild and
    // private-ledger read through the real wiring.
    const ledgerRoot = join(root, 'private-ledger')
    const commandRunner = async () => {}
    const handlers: Record<string, Array<(payload: unknown) => void>> = {}
    const ctx = {
      commands: { register: () => () => {} },
      on: (name: string, handler: unknown) => { (handlers[name] ??= []).push(handler as never); return () => {} },
      get: () => undefined,
      sessions: { flush: async () => true },
    }
    start = begin()
    apply(ctx as never, { activation: 'always', policy: 'release' } as never, {
      commandRunner, privateLedgerRoot: ledgerRoot,
    })
    const agent = {
      session, steer: () => {},
      ctx: { tools: { register: () => () => {}, guard: () => () => {}, get: () => undefined }, get: () => undefined },
    }
    for (const handler of handlers['agent/created'] ?? []) (handler as (payload: unknown) => void)({ agent, source: 'startup' })
    const mountMs = performance.now() - start
    record('cold_mount', actualEvents, mountMs)
    void derived

    // 4. Private-ledger read: short (4 records) and long (400 records with a
    // sized payload) ledgers, full chain verification on every read. The
    // read context is the mounted session's own (what production passes).
    const context: PrivateLedgerContext = {
      sessionId: String(session.id),
      sessionHeader: structuredClone(session.header) as unknown as Record<string, unknown>,
      cwd: String(session.header.cwd), hostLockDigest: '',
    }
    for (const [entry, records, payloadBytes] of [['private_ledger_short', 4, 200], ['private_ledger_long', 400, 2000]] as const) {
      const caseRoot = await mkdtemp(join(tmpdir(), 'dsh-cg-ledger-'))
      try {
        const seeded = await seedLedger(caseRoot, records, payloadBytes, context)
        start = begin()
        const snapshot = readPrivateLedger(seeded, context)
        const wall = performance.now() - start
        expect(snapshot.damaged).toBe(false)
        expect(snapshot.anchored).toBe(true)
        record(entry, records, wall)
      } finally {
        await rm(caseRoot, { recursive: true, force: true })
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

it('projection scaling measurement (gated: DSH_PROJECTION_MEASUREMENT=1)', { timeout: 600_000 }, async () => {
  if (process.env.DSH_PROJECTION_MEASUREMENT !== '1') {
    // The regular matrix does not pay for the scaling fixture; the driver
    // script sets the gate and reads the emitted result.
    return
  }
  const sizes = (process.env.DSH_PROJECTION_SIZES ?? '0,100,1000,10000')
    .split(',').map((value) => Number.parseInt(value, 10)).filter((value) => Number.isSafeInteger(value) && value >= 0)
  for (const size of sizes) await measureSize(size)
  expect(measurements.length).toBeGreaterThan(0)
  // Emitted for scripts/measure-projection-scaling.mjs; buffered consoles can
  // reorder lines, so the marker carries the whole payload on one line.
  console.log(`DSH_PROJECTION_MEASUREMENT=${JSON.stringify({ classification: 'synthetic', measurements })}`)
})
