import { expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, symlinkSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { appendPrivateLedger, initializePrivateLedger, readPrivateLedger, writerLockState, currentGenerationDir, currentWriterLockFile } from '../src/domain/private-ledger.js'
import type { PrivateLedgerContext } from '../src/domain/private-ledger.js'

// CG-083-F1: REAL-parallelism concurrency matrix for the generation-protocol
// writer lock (docs/WRITER_LOCK_PROTOCOL.md). The previous suite used
// execFileSync in a loop, which serialized the children and never raced them.
// Here bundled child processes block on a shared start barrier and are
// released together, each performing recovery-and-append under real
// contention; every atomic step's owner/file expectations are asserted.

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
  const dir = currentGenerationDir(root)
  if (!dir) throw new Error('no generation directory')
  writeFileSync(join(dir, '.writer.lock'), JSON.stringify({
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

/** Spawn children that block on a start barrier, then release them together. */
async function raceChildren(runner: string, root: string, labels: string[]): Promise<Array<{ label: string; code: number; stdout: string; stderr: string }>> {
  const barrier = join(root, 'start-barrier')
  writeFileSync(barrier, 'go: when deleted\n')
  const children = labels.map((label) => spawn(process.execPath, [runner, root, label, barrier], {
    stdio: ['ignore', 'pipe', 'pipe'],
  }))
  const collected = children.map((child, index) => new Promise<{ label: string; code: number; stdout: string; stderr: string }>((resolve) => {
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => resolve({ label: labels[index]!, code: code ?? -1, stdout, stderr }))
  }))
  rmSync(barrier)
  return Promise.all(collected)
}

it('four simultaneously released processes race recovery and append; the chain stays unique and contiguous', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-r2-mp-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    // One dead writer lock: every child must contend for recovery.
    writeDeadOwnerLock(root)
    const runner = await bundledRunner()
    const results = await raceChildren(runner, root, ['a', 'b', 'c', 'd'])
    for (const row of results) {
      expect(row.stderr, `child ${row.label} stderr: ${row.stderr.slice(-500)}`).toBe('')
      expect(row.code, `child ${row.label} exit`).toBe(0)
    }
    const snapshot = readPrivateLedger(root, context)
    const outcomes = results.map((row) => JSON.parse(row.stdout) as { label: string; succeeded: number; refused: number })
    const totalSucceeded = outcomes.reduce((sum, row) => sum + row.succeeded, 0)
    // Every success is durable exactly once; positions unique; prior chain contiguous.
    expect(snapshot.damaged).toBe(false)
    expect(snapshot.records.map((record) => record.position)).toEqual(snapshot.records.map((_, index) => index + 1))
    expect(snapshot.records.length).toBe(totalSucceeded)
    expect(new Set(snapshot.records.map((record) => String(record.payload.resolutionCallId))).size).toBe(snapshot.records.length)
    // Progress happened despite contention.
    expect(totalSucceeded).toBeGreaterThanOrEqual(1)
    // Post-condition: no live lock anywhere in any generation.
    expect(existsSync(currentWriterLockFile(root)!)).toBe(false)
    for (const entry of readdirSync(root).filter((name) => name.startsWith('gen-'))) {
      expect(existsSync(join(root, entry, '.writer.lock'))).toBe(false)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)

it('two children racing PLAIN acquire/release (no dead lock) still serialize the chain', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-r2-plain-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    const runner = await bundledRunner()
    const results = await raceChildren(runner, root, ['x', 'y'])
    for (const row of results) {
      expect(row.stderr, `child ${row.label} stderr: ${row.stderr.slice(-500)}`).toBe('')
      expect(row.code, `child ${row.label} exit`).toBe(0)
    }
    const snapshot = readPrivateLedger(root, context)
    const total = results.map((row) => JSON.parse(row.stdout) as { succeeded: number }).reduce((sum, row) => sum + row.succeeded, 0)
    expect(snapshot.damaged).toBe(false)
    expect(snapshot.records.length).toBe(total)
    expect(snapshot.records.map((record) => record.position)).toEqual(snapshot.records.map((_, index) => index + 1))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)

it('a child killed INSIDE the critical section does not wedge the ledger', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-r2-crash-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    const runner = await bundledRunner()
    // The repeat runner appends back-to-back; the parent polls for the lock
    // file and SIGKILLs the child the moment it is INSIDE the critical
    // section (lock exists), so no release/finally can run.
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
    // A normal writer must recover and continue the chain.
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'after-crash', serviceId: 's', preGeneration: 'g' })).toBe(true)
    const snapshot = readPrivateLedger(root, context)
    expect(snapshot.damaged).toBe(false)
    expect(snapshot.records.length).toBeGreaterThanOrEqual(1)
    expect(existsSync(currentWriterLockFile(root)!)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)

it('refuses a symlinked current-generation lock instead of following it', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-r2-link-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    const outside = mkdtempSync(join(tmpdir(), 'dsh-cg-r2-outside-'))
    try {
      writeFileSync(join(outside, 'target'), '', 'utf8')
      rmSync(join(currentGenerationDir(root)!, '.writer.lock'), { force: true })
      symlinkSync(join(outside, 'target'), join(currentGenerationDir(root)!, '.writer.lock'))
      expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'c3', serviceId: 's', preGeneration: 'g' })).toBe(false)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
