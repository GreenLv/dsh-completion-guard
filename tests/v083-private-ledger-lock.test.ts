import { expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { appendPrivateLedger, initializePrivateLedger, readPrivateLedger, writerLockState } from '../src/domain/private-ledger.js'
import type { PrivateLedgerContext } from '../src/domain/private-ledger.js'

// CG-083-BUG01: the private-ledger writer lock carries an owner identity and
// recovers a lock whose owner is PROVABLY dead, while every unknown or live
// owner keeps the fail-closed refusal with an actionable state.

const context: PrivateLedgerContext = {
  sessionId: 'lock-test-session',
  sessionHeader: { id: 'lock-test-session', version: 4 },
  cwd: '/work', hostLockDigest: 'digest',
}

const deadPid = (() => {
  // A pid that does not exist on this host. PID reuse means the recorded
  // owner could in principle be a DIFFERENT live process; on this host the
  // refusal path is exercised separately with a provably live pid, and the
  // recovery only ever trusts a hostname match plus a dead pid.
  for (let pid = 40000; pid < 50000; pid += 1) {
    try { process.kill(pid, 0) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return pid
    }
  }
  throw new Error('no free pid found for the fixture')
})()

function lockPath(root: string): string {
  return join(root, '.writer.lock')
}

function writeDeadOwnerLock(root: string): void {
  writeFileSync(lockPath(root), JSON.stringify({
    version: 2, nonce: randomBytes(16).toString('hex'), pid: deadPid,
    hostname: hostname(), created_at_epoch_ms: Date.now(),
  }) + '\n', 'utf8')
}

it('recovers a lock left by a provably dead writer and appends', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-lock-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    // Simulate a crash between lock creation and cleanup: the current lock
    // file is replaced by one naming a dead owner.
    writeDeadOwnerLock(root)
    expect(writerLockState(root)).toBe('abandoned_recoverable')
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'c1', serviceId: 's', preGeneration: 'g' })).toBe(true)
    expect(existsSync(lockPath(root))).toBe(false)
    const snapshot = readPrivateLedger(root, context)
    expect(snapshot.damaged).toBe(false)
    expect(snapshot.records).toHaveLength(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('never steals a lock held by a live owner and keeps its content intact', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-lock-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    // This process is provably alive: an append from "another writer" must
    // refuse and leave the lock exactly as it was.
    const held = JSON.stringify({
      version: 2, nonce: randomBytes(16).toString('hex'), pid: process.pid,
      hostname: hostname(), created_at_epoch_ms: Date.now(),
    }) + '\n'
    writeFileSync(lockPath(root), held, 'utf8')
    expect(writerLockState(root)).toBe('held')
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'c2', serviceId: 's', preGeneration: 'g' })).toBe(false)
    expect(readFileSync(lockPath(root), 'utf8')).toBe(held)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('refuses legacy anonymous locks from older versions without deleting them', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-lock-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    writeFileSync(lockPath(root), '', 'utf8')
    expect(writerLockState(root)).toBe('unknown_owner')
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'c3', serviceId: 's', preGeneration: 'g' })).toBe(false)
    expect(existsSync(lockPath(root))).toBe(true)
    expect(readFileSync(lockPath(root), 'utf8')).toBe('')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('refuses a lock owned by a foreign host', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-lock-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    writeFileSync(lockPath(root), JSON.stringify({
      version: 2, nonce: randomBytes(16).toString('hex'), pid: deadPid,
      hostname: 'some-other-host.example', created_at_epoch_ms: Date.now(),
    }) + '\n', 'utf8')
    expect(writerLockState(root)).toBe('unknown_owner')
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'c4', serviceId: 's', preGeneration: 'g' })).toBe(false)
    expect(existsSync(lockPath(root))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('keeps sequential appends correct and the lock released', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-lock-'))
  try {
    for (let index = 0; index < 4; index += 1) {
      expect(appendPrivateLedger(root, context, 'restart_intent', {
        resolutionCallId: `c${index}`, serviceId: 's', preGeneration: 'g',
      })).toBe(true)
      expect(existsSync(lockPath(root))).toBe(false)
    }
    const snapshot = readPrivateLedger(root, context)
    expect(snapshot.records.map((record) => record.position)).toEqual([1, 2, 3, 4])
    expect(writerLockState(root)).toBe('absent')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
