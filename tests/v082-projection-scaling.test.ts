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
  PROTOCOL_V6_NOTICE,
} from '../src/domain/derive.js'
import { projectSessionCoreV2 } from '../src/core-v2/session.js'
import { snapshotSessionEvents } from '../src/domain/session-events.js'
import { appendPrivateLedger, initializePrivateLedger, readPrivateLedger } from '../src/domain/private-ledger.js'
import type { PrivateLedgerContext } from '../src/domain/private-ledger.js'
import { apply } from '../src/runtime.js'
import type { Agent } from '@deepseek-ai/dsh-agent'

// CG-RC2-003 projection-scaling harness (0.8.3 revision, CG-083-VAL01).
// Measurement-only: this file is skipped unless DSH_PROJECTION_MEASUREMENT=1
// is set, and it is driven by scripts/measure-projection-scaling.mjs, which
// runs five fresh workers per event-count size and aggregates median/p95.
//
// The fixture is a NORMAL confirmed v6 session: the exact PROTOCOL_V6_NOTICE
// is the FIRST durable user message, so the whole history folds under the v6
// boundary (the previous revision appended a combined `V5\nV6` notice per
// slab, which the exact-match recognizer never accepted, and put the real v6
// boundary after all history — the body was therefore a legacy fold and the
// numbers did not describe the production v6 path). The production mount and
// confirmed sync go through the real apply() handlers: agent/created attach
// and an agent/pre-step flush→setDurability(true)→sync, which is the only path
// that sets the confirmed durability watermark and runs the core/v2
// projection. A second pre-step measures the unchanged-session warm sync. A
// legacy variant (boundary AFTER the history) is measured separately so the
// legacy/migration fold keeps its own observed baseline. Peak RSS is sampled
// on an interval during each measured window, not read once at the end.
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
interface Measurement {
  entry: string
  events: number
  wall_ms: number
  rss_bytes: number
  peak_rss_bytes: number
  physical_reads: number
  read_bytes: number
  projection_calls: number
}

const measurements: Measurement[] = []
const rssSamples: Array<{ at: number; rss: number }> = []
let sampler: ReturnType<typeof setInterval> | undefined
function startSampler(): void {
  if (sampler) return
  sampler = setInterval(() => { rssSamples.push({ at: performance.now(), rss: process.memoryUsage.rss() }) }, 5)
  sampler.unref?.()
}
function stopSampler(): void {
  if (sampler) { clearInterval(sampler); sampler = undefined }
}
function begin(): { at: number; first: number } {
  io.reads = 0
  io.bytes = 0
  projections.mockClear()
  const first = rssSamples.length
  return { at: performance.now(), first }
}
function record(entry: string, events: number, window: { at: number; first: number }, wall_ms: number, suffix = ''): void {
  let peak = process.memoryUsage.rss()
  for (let index = window.first; index < rssSamples.length; index += 1) peak = Math.max(peak, rssSamples[index]!.rss)
  measurements.push({ entry: `${entry}${suffix}`, events, wall_ms, rss_bytes: process.memoryUsage.rss(), peak_rss_bytes: peak,
    physical_reads: io.reads, read_bytes: io.bytes, projection_calls: projections.mock.calls.length })
}

function append(session: Session, type: string, data: unknown, options?: unknown): void {
  ;(session as unknown as { append(type: string, data: unknown, options?: unknown): void }).append(type, data, options)
}

/** One realistic agent-turn slab: root input and three tool round-trips (one
 * with a long text result). The v6 boundary is NOT part of the slab; a normal
 * session writes it once, before any history. */
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
}

/** CG-083-V2 root-input-dense distribution: N independent simple root
 * requests and nothing else (the plan's "3,000 root inputs" shape). */
function appendRootDense(session: Session, count: number): void {
  for (let index = 0; index < count; index += 1) {
    const turn = index + 1
    append(session, 'turn/start', { turn })
    append(session, 'user/message', {
      source: { kind: 'user' },
      content: [{ type: 'text', text: `Explain requirement ${index} of this task and continue with step ${index}.` }],
    }, { surfaceOp: 'append' })
    append(session, 'assistant/message', { turn, step: session.seq, message: { role: 'assistant', content: [{ type: 'text', text: `Requirement ${index} acknowledged.` }] } }, { surfaceOp: 'append' })
    append(session, 'turn/end', { turn })
  }
}

function createSession(root: string, id: string): Session {
  return Session.create(SessionId(id), undefined, {
    version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId(id), createdAt: 1, cwd: root,
  })
}

/** CG-083-VAL01: the v6 boundary is the first durable message and must be
 * recognized as one — the whole log folds under boundaryProtocol 6. */
function appendV6Boundary(session: Session): void {
  append(session, 'user/message', {
    source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' },
    content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }],
  }, { surfaceOp: 'append' })
}

async function seedLedger(root: string, records: number, payloadBytes: number, context: PrivateLedgerContext,
  anchorSessions = 0): Promise<string> {
  const ledgerRoot = join(root, 'private-ledger')
  initializePrivateLedger(ledgerRoot, context)
  // CG-083-PERF05: the shared anchors table grows with EVERY session, so the
  // ledger read must also be measured under anchor-count pressure, not only
  // with this session's own record count.
  for (let anchor = 0; anchor < anchorSessions; anchor += 1) {
    initializePrivateLedger(ledgerRoot, { ...context, sessionId: `${context.sessionId}-anchor-${anchor}` })
  }
  for (let index = 0; index < records; index += 1) {
    appendPrivateLedger(ledgerRoot, context, 'restart_intent', {
      resolutionCallId: `call-${index}`, serviceId: 'fixture', preGeneration: 'g1',
      note: 'p'.repeat(payloadBytes),
    })
  }
  return ledgerRoot
}

/**
 * CG-083-V2 distribution knob (set by the driver):
 *  - `tool` (default): the historical interleaved tool-dense slab, one long
 *    output per slab (byte gradient kept separate from the event gradient);
 *  - `roots`: root-input-dense — N independent root requests, no tool events
 *    (the plan's "3,000 root inputs" scenario);
 *  - `longout`: the tool slab with a FIXED moderate event count but a byte
 *    gradient, isolating per-output byte cost from event count.
 */
type Distribution = 'tool' | 'roots' | 'longout'
async function measureSize(events: number, distribution: Distribution = 'tool'): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cg-scaling-'))
  const suffix = distribution === 'tool' ? '' : `:${distribution}`
  try {
    const session = createSession(root, 'projection-scaling')
    // The 0-event control must be a genuinely empty session: the boundary
    // notice is itself a durable event and part of the workload.
    if (events > 0) appendV6Boundary(session)
    // The byte gradient for tool/longout distributions (kept separate from
    // the event gradient).
    const longOutputBytes = distribution === 'longout'
      ? (events >= 10000 ? 200_000 : 20_000)
      : (events >= 10000 ? 200_000 : 2_000)
    if (distribution === 'roots') {
      appendRootDense(session, events)
    } else {
      for (let index = 0; index < Math.ceil(events / 6) && session.seq < events; index += 1) {
        appendTurnSlab(session, index, longOutputBytes)
      }
    }
    const actualEvents = session.snapshotEvents().length
    const eventsRead = snapshotSessionEvents(session)

    // 0. The whole log must fold as a real v6 session: boundary protocol 6,
    // a non-empty contract, and a projectable core snapshot. These assertions
    // make it impossible to report numbers from a fixture that silently fell
    // back to a legacy fold or an empty contract.
    {
      const derived = deriveProjection(eventsRead as never,
        { activation: 'always', policy: 'release' },
        { cwd: String(session.header.cwd) }, true)
      if (events > 0) {
        expect(derived.projection.boundaryProtocol).toBe(6)
        expect(derived.projection.items.size).toBeGreaterThan(0)
        expect(derived.projection.sessionRefDigest).toBeTruthy()
        const core = projectSessionCoreV2(eventsRead as never,
          { ...derived.projection, durabilityWatermark: 'confirmed' })
        expect(core).toBeDefined()
      } else {
        expect(derived.projection.items.size).toBe(0)
      }
    }

    // 1. Session snapshot (V4 read + envelope validation).
    let window = begin()
    snapshotSessionEvents(session)
    record('snapshot', actualEvents, window, performance.now() - window.at, suffix)

    // 2. Full projection derivation (pure fold over the whole log).
    window = begin()
    const derived = deriveProjection(eventsRead as never,
      { activation: 'always', policy: 'release' },
      { cwd: String(session.header.cwd) }, true)
    record('derive_projection', actualEvents, window, performance.now() - window.at, suffix)
    void derived

    // 2b. Legacy/migration对照: the same history with the boundary AFTER it
    // folds under the legacy rules. Reported separately, never mixed into the
    // normal v6 entries.
    {
      const legacy = createSession(root, 'projection-scaling-legacy')
      if (distribution === 'roots') appendRootDense(legacy, events)
      else {
        for (let index = 0; index < Math.ceil(events / 6) && legacy.seq < events; index += 1) {
          appendTurnSlab(legacy, index, longOutputBytes)
        }
      }
      appendV6Boundary(legacy)
      const legacyEvents = snapshotSessionEvents(legacy)
      window = begin()
      const legacyDerived = deriveProjection(legacyEvents as never,
        { activation: 'always', policy: 'release' },
        { cwd: String(legacy.header.cwd) }, true)
      record('derive_projection_legacy', actualEvents, window, performance.now() - window.at, suffix)
      expect(legacyDerived.projection.boundaryProtocol).toBe(6)
    }

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
    window = begin()
    apply(ctx as never, { activation: 'always', policy: 'release' } as never, {
      commandRunner, privateLedgerRoot: ledgerRoot,
    })
    const agent = {
      session, steer: () => {},
      ctx: { tools: { register: () => () => {}, guard: () => () => {}, get: () => undefined }, get: () => undefined },
    }
    for (const handler of handlers['agent/created'] ?? []) (handler as (payload: unknown) => void)({ agent, source: 'startup' })
    // CG-083-V3: this entry follows the semantics pre-check, the snapshot,
    // the derive and the legacy derive in this worker, so it is a FIRST
    // MOUNT of a new runtime in a warm process, not a cold first operation.
    record('first_mount_warm_process', actualEvents, window, performance.now() - window.at, suffix)

    // 4. The production confirmed path: one agent/pre-step flush→
    // setDurability(true)→sync. This is the only entry whose durability
    // watermark is 'confirmed', so it is also the entry that must run the
    // core/v2 projection — the previous fixture measured a mount whose
    // durability was never confirmed and could not reach it.
    const runPreStep = async (): Promise<void> => {
      for (const handler of handlers['agent/pre-step'] ?? []) {
        await (handler as unknown as (payload: unknown, next: unknown) => Promise<unknown>)(
          { agent }, async () => ({ kind: 'enter', messages: [] }),
        )
      }
    }
    window = begin()
    await runPreStep()
    record('confirmed_sync_first', actualEvents, window, performance.now() - window.at, suffix)

    // 4b. Unchanged warm sync: the same session, no new durable events. The
    // production path must not re-run the history fold for this entry.
    window = begin()
    await runPreStep()
    record('warm_sync', actualEvents, window, performance.now() - window.at, suffix)

    // 5. Private-ledger read: short (4 records) and long (400 records with a
    // sized payload) ledgers, full chain verification on every read. The
    // read context is the mounted session's own (what production passes).
    const context: PrivateLedgerContext = {
      sessionId: String(session.id),
      sessionHeader: structuredClone(session.header) as unknown as Record<string, unknown>,
      cwd: String(session.header.cwd), hostLockDigest: '',
    }
    const ledgerCases: ReadonlyArray<readonly [string, number, number, number]> = [
      ['private_ledger_short', 4, 200, 0],
      ['private_ledger_long', 400, 2000, 0],
      ['private_ledger_1000_anchors', 4, 200, 1000],
    ]
    for (const [entry, records, payloadBytes, anchorSessions] of ledgerCases) {
      const caseRoot = await mkdtemp(join(tmpdir(), 'dsh-cg-ledger-'))
      try {
        const seeded = await seedLedger(caseRoot, records, payloadBytes, context, anchorSessions)
        window = begin()
        const snapshot = readPrivateLedger(seeded, context)
        const wall = performance.now() - window.at
        expect(snapshot.damaged).toBe(false)
        expect(snapshot.anchored).toBe(true)
        record(entry, records, window, wall)
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
  // CG-083-V2: a spec is either `size` (default tool distribution) or
  // `size:distribution`. Example: 3000:roots,3000,10000:longout
  const specs = (process.env.DSH_PROJECTION_SIZES ?? '0,100,1000,10000')
    .split(',').map((value) => value.trim()).filter(Boolean)
  startSampler()
  try {
    for (const spec of specs) {
      const [sizeText, distributionText] = spec.split(':')
      const size = Number.parseInt(sizeText, 10)
      if (!Number.isSafeInteger(size) || size < 0) continue
      const distribution = (['tool', 'roots', 'longout'] as const).includes(distributionText as never)
        ? distributionText as Distribution : 'tool'
      await measureSize(size, distribution)
    }
  } finally {
    stopSampler()
  }
  expect(measurements.length).toBeGreaterThan(0)
  // Emitted for scripts/measure-projection-scaling.mjs; buffered consoles can
  // reorder lines, so the marker carries the whole payload on one line.
  // V3: the worker reports its own pid so the driver can attribute samples.
  console.log(`DSH_PROJECTION_MEASUREMENT=${JSON.stringify({ classification: 'synthetic', worker_pid: process.pid, measurements })}`)
})
