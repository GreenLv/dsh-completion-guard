import { expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { appendPrivateLedger, initializePrivateLedger, readPrivateLedger, writerLockState, currentWriterLockFile, __writerLockInternals } from '../src/domain/private-ledger.js'
import type { PrivateLedgerContext } from '../src/domain/private-ledger.js'

// CG-083-F1 round 3: REAL-parallelism and DETERMINISTIC interleavings for the
// slot + pending + evict-intent protocol (docs/WRITER_LOCK_PROTOCOL.md
// Revision 2). The review's L1/L2 counterexamples become standing regressions:
// a recoverer with a stale dead observation must abort, and a candidate paused
// in the pending phase must never enter or be evicted.

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

function writeDeadSlot(root: string): void {
  writeFileSync(join(root, 'slot.json'), JSON.stringify({
    version: 3, nonce: randomBytes(16).toString('hex'), pid: deadPid,
    hostname: hostname(), created_at_epoch_ms: Date.now(),
  }) + '\n', 'utf8')
}

let bundlePromise: Promise<string> | undefined
async function bundledRunner(): Promise<string> {
  bundlePromise ??= (async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'dsh-cg-runner-')), 'ledger-runner.mjs')
    const pnpmDir = join(process.cwd(), 'node_modules', '.pnpm')
    const esbuildDir = readdirSync(pnpmDir).find((entry) => /^esbuild@\d+\.\d+\.\d+$/.test(entry))
    if (!esbuildDir) throw new Error('esbuild is not installed in this workspace')
    const require = createRequire(join(pnpmDir, esbuildDir, 'node_modules', 'esbuild', 'package.json'))
    const esbuild = require('esbuild') as { build(options: unknown): Promise<unknown> }
    await esbuild.build({
      entryPoints: [join(process.cwd(), 'tests', 'helpers', 'ledger-runner.ts')],
      bundle: true, platform: 'node', format: 'esm', outfile: out,
    })
    return out
  })()
  return bundlePromise
}

async function raceChildren(runner: string, root: string, labels: string[], withBarrier = true): Promise<Array<{ label: string; code: number; stdout: string; stderr: string }>> {
  const barrier = join(root, 'start-barrier')
  if (withBarrier) writeFileSync(barrier, 'go: when deleted\n')
  const children = labels.map((label) => spawn(process.execPath, [runner, root, label, ...(withBarrier ? [barrier] : [])], {
    stdio: ['ignore', 'pipe', 'pipe'],
  }))
  const collected = children.map((child, index) => new Promise<{ label: string; code: number; stdout: string; stderr: string }>((resolve) => {
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => resolve({ label: labels[index]!, code: code ?? -1, stdout, stderr }))
  }))
  if (withBarrier) rmSync(barrier)
  return Promise.all(collected)
}

it('four simultaneously released processes race recovery and append; the chain stays unique and contiguous', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-r3-mp-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    writeDeadSlot(root)
    const runner = await bundledRunner()
    const results = await raceChildren(runner, root, ['a', 'b', 'c', 'd'])
    for (const row of results) {
      expect(row.stderr, `child ${row.label} stderr: ${row.stderr.slice(-500)}`).toBe('')
      expect(row.code, `child ${row.label} exit`).toBe(0)
    }
    const snapshot = readPrivateLedger(root, context)
    const totalSucceeded = results.reduce((sum, row) => sum + (JSON.parse(row.stdout) as { succeeded: number }).succeeded, 0)
    expect(snapshot.damaged).toBe(false)
    expect(snapshot.records.map((record) => record.position)).toEqual(snapshot.records.map((_, index) => index + 1))
    expect(snapshot.records.length).toBe(totalSucceeded)
    expect(new Set(snapshot.records.map((record) => String(record.payload.resolutionCallId))).size).toBe(snapshot.records.length)
    expect(totalSucceeded).toBeGreaterThanOrEqual(1)
    expect(existsSync(currentWriterLockFile(root)!)).toBe(false)
    // One more acquire sweeps every pending file whose creator is dead.
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'sweep', serviceId: 's', preGeneration: 'g' })).toBe(true)
    expect(readdirSync(root).filter((name) => name.startsWith('pending.'))).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)

it('L1 (standing regression): a stale dead-slot observation cannot evict a live holder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-r3-l1-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    // A dead holder appears; process A observes it (stale observation) and
    // then PAUSES. B recovers the same dead holder and ENTERS its critical
    // section. A's delayed finalize must abort and B must finish.
    writeDeadSlot(root)
    const stale = __writerLockInternals.readSlot(root)
    expect(stale).toBeDefined()
    expect(stale).not.toBe('legacy')
    const deadNonce = (stale as { nonce: string }).nonce
    // B recovers and holds: run one append in a child and WAIT until it is
    // inside the critical section (slot present with a live pid), then run
    // A's delayed finalize from THIS process.
    const runner = await bundledRunner()
    const child = spawn(process.execPath, [runner, root, 'slowappend'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const deadline = Date.now() + 30_000
    let bHolding = false
    while (Date.now() < deadline) {
      const slotFile = currentWriterLockFile(root)
      if (slotFile !== undefined && existsSync(slotFile)) {
        const holder = __writerLockInternals.readSlot(root)
        if (holder !== 'legacy' && holder !== undefined && holder.nonce !== deadNonce) { bHolding = true; break }
      }
      if (child.exitCode !== null) break
    }
    expect(bHolding, 'child B entered its critical section').toBe(true)
    // A's delayed finalize with the STALE dead nonce must not evict B.
    const finalized = __writerLockInternals.evictDeadHolder(root, stale as { version: 3; nonce: string; pid: number; hostname: string; created_at_epoch_ms: number })
    expect(finalized, 'stale observation must abort').toBe(false)
    // B completes and its records are intact.
    await new Promise<void>((resolve) => child.on('close', () => resolve()))
    const snapshot = readPrivateLedger(root, context)
    expect(snapshot.damaged).toBe(false)
    expect(snapshot.records.length).toBeGreaterThanOrEqual(1)
    expect(existsSync(currentWriterLockFile(root)!)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)

it('L2 (standing regression): a paused pending-phase candidate cannot enter or be evicted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-r3-l2-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    const runner = await bundledRunner()
    // B creates its pending file (no authority), pauses on the barrier; A
    // (parent) takes the slot with a full append; B resumes: link fails
    // EEXIST, candidate refuses, A's slot is never evicted.
    const barrier = join(root, 'start-barrier')
    writeFileSync(barrier, 'go: when deleted\n')
    const child = spawn(process.execPath, [runner, root, 'slowpending', barrier], { stdio: ['ignore', 'pipe', 'pipe'] })
    const deadline = Date.now() + 30_000
    let prepared = false
    while (Date.now() < deadline) {
      if (readdirSync(root).some((name) => name.startsWith('pending.'))) { prepared = true; break }
      if (child.exitCode !== null) break
    }
    expect(prepared, 'child created its pending candidate').toBe(true)
    // The parent HOLDS the slot across the child's resume (a plain append
    // would release before the child links).
    const held = __writerLockInternals.acquire(root)
    expect(held, 'parent acquired the slot').toBeDefined()
    rmSync(barrier)
    let stdout = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    await new Promise<void>((resolve) => child.on('close', () => resolve()))
    const outcome = JSON.parse(stdout) as { refused: boolean; holderIsParent: boolean }
    expect(outcome, `child outcome: ${stdout}`).toMatchObject({ refused: true, holderIsParent: true })
    // Parent releases; the ledger was never written under the paused
    // candidate (no authority), and a normal append works afterwards.
    __writerLockInternals.release(root, held)
    expect(existsSync(currentWriterLockFile(root)!)).toBe(false)
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'post-l2', serviceId: 's', preGeneration: 'g' })).toBe(true)
    const snapshot = readPrivateLedger(root, context)
    expect(snapshot.damaged).toBe(false)
    expect(snapshot.records).toHaveLength(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)

it('a child killed INSIDE the critical section does not wedge the ledger', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-r3-crash-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    const runner = await bundledRunner()
    const child = spawn(process.execPath, [runner, root, 'repeat'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let killed = false
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const lockPath = currentWriterLockFile(root)
      if (lockPath !== undefined && existsSync(lockPath)) {
        process.kill(child.pid!, 'SIGKILL')
        killed = true
        break
      }
      if (child.exitCode !== null) break
    }
    await new Promise<void>((resolve) => child.on('close', () => resolve()))
    expect(killed, 'parent caught the child inside the critical section').toBe(true)
    expect(existsSync(currentWriterLockFile(root)!)).toBe(true)
    expect(writerLockState(root)).toBe('abandoned_recoverable')
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'after-crash', serviceId: 's', preGeneration: 'g' })).toBe(true)
    const snapshot = readPrivateLedger(root, context)
    expect(snapshot.damaged).toBe(false)
    expect(snapshot.records.length).toBeGreaterThanOrEqual(1)
    expect(existsSync(currentWriterLockFile(root)!)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)

it('refuses a symlinked slot instead of following it', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-r3-link-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    const outside = mkdtempSync(join(tmpdir(), 'dsh-cg-r3-outside-'))
    try {
      writeFileSync(join(outside, 'target'), '', 'utf8')
      rmSync(join(root, 'slot.json'), { force: true })
      symlinkSync(join(outside, 'target'), join(root, 'slot.json'))
      expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'c3', serviceId: 's', preGeneration: 'g' })).toBe(false)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
