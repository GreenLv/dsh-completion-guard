import { expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { appendPrivateLedger, initializePrivateLedger, readPrivateLedger, writerLockState, currentWriterLockFile, currentGenerationDir } from '../src/domain/private-ledger.js'
import type { PrivateLedgerContext } from '../src/domain/private-ledger.js'

// CG-083-BUG01/R2/F1: the generation-protocol writer lock. Locks live inside
// the current `gen-NNNNNNNN` directory; recovery ADVANCES the generation and
// never mutates another actor's file; only ESRCH proves death.

const context: PrivateLedgerContext = {
  sessionId: 'lock-test-session',
  sessionHeader: { id: 'lock-test-session', version: 4 },
  cwd: '/work', hostLockDigest: 'digest',
}

const deadPid = (() => {
  for (let pid = 40000; pid < 50000; pid += 1) {
    try { process.kill(pid, 0) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return pid
    }
  }
  throw new Error('no free pid found for the fixture')
})()

function writeDeadOwnerLock(root: string): void {
  const dir = currentGenerationDir(root)
  if (!dir) throw new Error('no generation directory')
  writeFileSync(join(dir, '.writer.lock'), JSON.stringify({
    version: 3, nonce: randomBytes(16).toString('hex'), pid: deadPid,
    hostname: hostname(), created_at_epoch_ms: Date.now(),
  }) + '\n', 'utf8')
}

it('recovers a dead owner by advancing the generation; the dead file is abandoned, not mutated', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-lock-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    writeDeadOwnerLock(root)
    const deadDir = currentGenerationDir(root)!
    const deadPath = join(deadDir, '.writer.lock')
    const deadBytes = readFileSync(deadPath, 'utf8')
    // Read-only observation never mutates the dead generation.
    expect(writerLockState(root)).toBe('abandoned_recoverable')
    expect(readFileSync(deadPath, 'utf8')).toBe(deadBytes)
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'c1', serviceId: 's', preGeneration: 'g' })).toBe(true)
    // The append ran in a NEW generation — the dead lock was never reused,
    // and recovery itself never renamed or unlinked it (it may only later be
    // PRUNED by the current-lock holder, protocol §5).
    expect(currentGenerationDir(root)).not.toBe(deadDir)
    expect(currentGenerationDir(root)).toBe(join(root, 'gen-00000002'))
    expect(existsSync(currentWriterLockFile(root)!)).toBe(false)
    const snapshot = readPrivateLedger(root, context)
    expect(snapshot.damaged).toBe(false)
    expect(snapshot.records).toHaveLength(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('never steals a lock held by a live owner (PID reuse included)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-lock-live-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    const held = JSON.stringify({
      version: 3, nonce: randomBytes(16).toString('hex'), pid: process.pid,
      hostname: hostname(), created_at_epoch_ms: Date.now(),
    }) + '\n'
    writeFileSync(join(currentGenerationDir(root)!, '.writer.lock'), held, 'utf8')
    expect(writerLockState(root)).toBe('held')
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'c2', serviceId: 's', preGeneration: 'g' })).toBe(false)
    expect(readFileSync(join(currentGenerationDir(root)!, '.writer.lock'), 'utf8')).toBe(held)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('refuses legacy/anonymous/foreign-owner locks left by older versions without touching them', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-lock-legacy-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    const dir = currentGenerationDir(root)!
    // Legacy root-level artifacts are ignored by the protocol entirely.
    writeFileSync(join(root, '.writer.lock'), '', 'utf8')
    // An old-format record inside the current generation is an unknown owner.
    writeFileSync(join(dir, '.writer.lock'), JSON.stringify({
      version: 2, nonce: randomBytes(16).toString('hex'), pid: deadPid,
      hostname: hostname(), created_at_epoch_ms: Date.now(),
    }) + '\n', 'utf8')
    expect(writerLockState(root)).toBe('unknown_owner')
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'c3', serviceId: 's', preGeneration: 'g' })).toBe(false)
    expect(readFileSync(join(dir, '.writer.lock'), 'utf8')).toContain('"version":2')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('refuses a foreign-host dead-owner lock', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-lock-foreign-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    writeFileSync(join(currentGenerationDir(root)!, '.writer.lock'), JSON.stringify({
      version: 3, nonce: randomBytes(16).toString('hex'), pid: deadPid,
      hostname: 'some-other-host.example', created_at_epoch_ms: Date.now(),
    }) + '\n', 'utf8')
    expect(writerLockState(root)).toBe('unknown_owner')
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'c4', serviceId: 's', preGeneration: 'g' })).toBe(false)
    expect(existsSync(join(currentGenerationDir(root)!, '.writer.lock'))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('keeps sequential appends correct, the lock released, and one generation', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-lock-seq-'))
  try {
    for (let index = 0; index < 4; index += 1) {
      expect(appendPrivateLedger(root, context, 'restart_intent', {
        resolutionCallId: `c${index}`, serviceId: 's', preGeneration: 'g',
      })).toBe(true)
      expect(existsSync(currentWriterLockFile(root)!)).toBe(false)
    }
    const snapshot = readPrivateLedger(root, context)
    expect(snapshot.records.map((record) => record.position)).toEqual([1, 2, 3, 4])
    expect(writerLockState(root)).toBe('absent')
    expect(currentGenerationDir(root)).toBe(join(root, 'gen-00000001'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('recovers a ZERO-LENGTH lock left by a creator killed mid-record (BUG-01 window)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-lock-zero-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    // A writer that died between O_EXCL creation and its owner-record write.
    writeFileSync(join(currentGenerationDir(root)!, '.writer.lock'), '', 'utf8')
    expect(writerLockState(root)).toBe('abandoned_recoverable')
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'z1', serviceId: 's', preGeneration: 'g' })).toBe(true)
    expect(readPrivateLedger(root, context).records).toHaveLength(1)
    expect(currentGenerationDir(root)).toBe(join(root, 'gen-00000002'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('prunes abandoned generations once the current lock is held', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-lock-prune-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    // Two crash generations accumulate; each following append (which holds the
    // current lock) prunes strictly older generations.
    writeDeadOwnerLock(root)
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'p1', serviceId: 's', preGeneration: 'g' })).toBe(true)
    writeDeadOwnerLock(root)
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'p2', serviceId: 's', preGeneration: 'g' })).toBe(true)
    const generations = readdirSync(root).filter((entry) => entry.startsWith('gen-'))
    expect(generations).toEqual(['gen-00000003'])
    expect(readPrivateLedger(root, context).records.map((record) => record.position)).toEqual([1, 2])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
