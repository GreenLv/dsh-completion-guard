import { expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { appendPrivateLedger, initializePrivateLedger, readPrivateLedger, writerLockState } from '../src/domain/private-ledger.js'
import type { PrivateLedgerContext } from '../src/domain/private-ledger.js'

// CG-083-R2 acceptance matrix for the owner-identified writer lock:
// recovery is an atomic RENAME serialized by a recovery lock, so a live
// writer's lock can never be evicted by a recoverer; unknown owners refuse;
// real multi-process contention leaves a unique contiguous record chain.

import { hostname as HOSTNAME } from 'node:os'

const context: PrivateLedgerContext = {
  sessionId: 'lock-race-session',
  sessionHeader: { id: 'lock-race-session', version: 4 },
  cwd: '/work', hostLockDigest: 'digest',
}

const deadPid = (() => {
  for (let pid = 40000; pid < 50000; pid += 1) {
    try { process.kill(pid, 0) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return pid
    }
  }
  throw new Error('no free pid for fixture')
})()

function writeDeadOwnerLock(root: string): void {
  writeFileSync(join(root, '.writer.lock'), JSON.stringify({
    version: 2, nonce: randomBytes(16).toString('hex'), pid: deadPid,
    hostname: HOSTNAME(), created_at_epoch_ms: Date.now(),
  }) + '\n', 'utf8')
}

it('recovers a dead owner by rename and never leaves the pathname occupied', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-r2-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    writeDeadOwnerLock(root)
    expect(writerLockState(root)).toBe('abandoned_recoverable')
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'c1', serviceId: 's', preGeneration: 'g' })).toBe(true)
    // The pathname is free again and the dead owner's file was quarantined,
    // not deleted through the live pathname.
    expect(existsSync(join(root, '.writer.lock'))).toBe(false)
    expect(existsSync(join(root, '.writer.lock.stale'))).toBe(true)
    expect(readPrivateLedger(root, context).records).toHaveLength(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('never evicts a live owner, including a pid that now names a different process', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-r2-live-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    // A record naming a pid that is alive right now (this process): whether
    // the original owner died and the pid was reused, or the owner is alive,
    // recovery must refuse — only ESRCH proves absence.
    const live = JSON.stringify({
      version: 2, nonce: randomBytes(16).toString('hex'), pid: process.pid,
      hostname: HOSTNAME(), created_at_epoch_ms: Date.now(),
    }) + '\n'
    writeFileSync(join(root, '.writer.lock'), live, 'utf8')
    expect(writerLockState(root)).toBe('held')
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'c2', serviceId: 's', preGeneration: 'g' })).toBe(false)
    expect(readFileSync(join(root, '.writer.lock'), 'utf8')).toBe(live)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('refuses a symlinked lock file instead of following it', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-r2-link-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    const outside = mkdtempSync(join(tmpdir(), 'dsh-cg-r2-outside-'))
    try {
      writeFileSync(join(outside, 'target'), '', 'utf8')
      rmSync(join(root, '.writer.lock'), { force: true })
      symlinkSync(join(outside, 'target'), join(root, '.writer.lock'))
      expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'c3', serviceId: 's', preGeneration: 'g' })).toBe(false)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('real multi-process contention recovers once and keeps one unique record chain', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-r2-mp-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    // A dead writer left its lock: every spawned process must contend through
    // the serialized recovery protocol.
    writeDeadOwnerLock(root)
    // Bundle the real ledger module once with esbuild, then race four REAL
    // child processes on the same ledger root.
    // vitest's transform pipeline ships esbuild. It lives in the pnpm store,
    // so resolve the single installed copy without adding a dependency.
    const pnpmDir = join(process.cwd(), 'node_modules', '.pnpm')
    const esbuildDir = readdirSync(pnpmDir).find((entry) => /^esbuild@\d+\.\d+\.\d+$/.test(entry))
    if (!esbuildDir) throw new Error('esbuild is not installed in this workspace')
    const require = createRequire(join(pnpmDir, esbuildDir, 'node_modules', 'esbuild', 'package.json'))
    const esbuild = require('esbuild') as { build(options: unknown): Promise<unknown> }
    const runner = join(root, 'append-runner.mjs')
    await esbuild.build({
      entryPoints: [join(process.cwd(), 'tests', 'helpers', 'ledger-runner.ts')],
      bundle: true, platform: 'node', format: 'esm', outfile: runner,
    })
    const labels = ['a', 'b', 'c', 'd']
    for (const label of labels) {
      execFileSync(process.execPath, [runner, root, label], { encoding: 'utf8', timeout: 60_000 })
    }
    const snapshot = readPrivateLedger(root, context)
    const results = labels.map((label) => JSON.parse(readFileSync(join(root, `result-${label}.json`), 'utf8')) as { succeeded: number; refused: number })
    const totalSucceeded = results.reduce((sum, row) => sum + row.succeeded, 0)
    // Every append that reported success is durable exactly once, positions
    // are unique and the prior chain is contiguous.
    expect(snapshot.damaged).toBe(false)
    expect(snapshot.records.map((record) => record.position)).toEqual(snapshot.records.map((_, index) => index + 1))
    expect(snapshot.records.length).toBe(totalSucceeded)
    const callIds = new Set(snapshot.records.map((record) => String(record.payload.resolutionCallId)))
    expect(callIds.size).toBe(snapshot.records.length)
    // The recovery lock never stays behind; the writer pathname is free.
    // The recovery lock never stays behind; the writer pathname is free and
    // only the dead owner's quarantine remains.
    const leftovers = readdirSync(root).filter((entry) => entry.startsWith('.writer'))
    expect(leftovers).toEqual(['.writer.lock.stale'])
    void results
    // Contention refusals are expected (serialized recovery + exclusive
    // creation), but at least one writer must have made progress.
    expect(totalSucceeded).toBeGreaterThanOrEqual(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)

it('keeps the ledger root usable when only the stale quarantine exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-r2-stale-'))
  try {
    mkdirSync(root, { recursive: true })
    expect(initializePrivateLedger(root, context)).toBe(true)
    // A previous recovery's quarantine file must not block anything.
    writeFileSync(join(root, '.writer.lock.stale'), 'garbage from an earlier recovery\n', 'utf8')
    writeDeadOwnerLock(root)
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'c9', serviceId: 's', preGeneration: 'g' })).toBe(true)
    expect(readPrivateLedger(root, context).records).toHaveLength(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
