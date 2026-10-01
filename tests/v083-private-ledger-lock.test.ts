import { expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { appendPrivateLedger, initializePrivateLedger, readPrivateLedger, writerLockState, __writerLockInternals } from '../src/domain/private-ledger.js'
import type { PrivateLedgerContext } from '../src/domain/private-ledger.js'

// CG-083-BUG01/R2/F1 revision 3: arbitration-log writer lock. The holder is
// the replayed log state; recovery appends an evict record; legacy root locks
// REFUSE (L3); only ESRCH proves death.

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

function writeDeadClaim(root: string): void {
  const nonce = randomBytes(16).toString('hex')
  const { openSync, writeSync, closeSync } = require('node:fs') as typeof import('node:fs')
  const fd = openSync(join(root, 'arbitration.log'), 'a')
  try {
    writeSync(fd, JSON.stringify({ v: 3, op: 'claim', nonce, pid: deadPid, hostname: hostname(), created_at_epoch_ms: Date.now(), prev: null }) + '\n')
  } finally {
    closeSync(fd)
  }
}

it('recovers a provably dead log holder and keeps the chain intact', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-lock-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    writeDeadClaim(root)
    expect(writerLockState(root)).toBe('abandoned_recoverable')
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'c1', serviceId: 's', preGeneration: 'g' })).toBe(true)
    expect(__writerLockInternals.readHolder(root)).toBeNull()
    const snapshot = readPrivateLedger(root, context)
    expect(snapshot.damaged).toBe(false)
    expect(snapshot.records).toHaveLength(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('never enters while a live holder claim is current (PID reuse included)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-lock-live-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    const held = __writerLockInternals.acquire(root)
    expect(held).toBeDefined()
    expect(writerLockState(root)).toBe('held')
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'c2', serviceId: 's', preGeneration: 'g' })).toBe(false)
    __writerLockInternals.release(root, held)
    expect(writerLockState(root)).toBe('absent')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('L3: legacy root locks REFUSE acquisition with bytes untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-lock-legacy-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    // (a) anonymous legacy lock (old crashed writer): unknown owner.
    writeFileSync(join(root, '.writer.lock'), '', 'utf8')
    expect(writerLockState(root)).toBe('unknown_owner')
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'c3', serviceId: 's', preGeneration: 'g' })).toBe(false)
    expect(readFileSync(join(root, '.writer.lock'), 'utf8')).toBe('')
    // (b) same-host LIVE v2 owner: held.
    rmSync(join(root, '.writer.lock'))
    writeFileSync(join(root, '.writer.lock'), JSON.stringify({
      version: 2, nonce: randomBytes(16).toString('hex'), pid: process.pid,
      hostname: hostname(), created_at_epoch_ms: Date.now(),
    }) + '\n', 'utf8')
    expect(writerLockState(root)).toBe('held')
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'c4', serviceId: 's', preGeneration: 'g' })).toBe(false)
    expect(existsSync(join(root, '.writer.lock'))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('L3 adopt: a provably dead v2 lock is adopted (append proceeds, bytes stay)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-lock-adopt-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    // A v2 writer crashed leaving its lock: the v3 protocol adopts the file
    // (never removes it) and proceeds; new v2 writers stay refused by the
    // file until the documented manual migration removes it.
    const deadV2 = JSON.stringify({
      version: 2, nonce: randomBytes(16).toString('hex'), pid: deadPid,
      hostname: hostname(), created_at_epoch_ms: Date.now(),
    }) + '\n'
    writeFileSync(join(root, '.writer.lock'), deadV2, 'utf8')
    expect(writerLockState(root)).toBe('abandoned_recoverable')
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'adopt-1', serviceId: 's', preGeneration: 'g' })).toBe(true)
    expect(readFileSync(join(root, '.writer.lock'), 'utf8')).toBe(deadV2)
    expect(readPrivateLedger(root, context).records).toHaveLength(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('refuses a foreign-host dead holder', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-lock-foreign-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    const { openSync, writeSync, closeSync } = require('node:fs') as typeof import('node:fs')
    const fd = openSync(join(root, 'arbitration.log'), 'a')
    try {
      writeSync(fd, JSON.stringify({ v: 3, op: 'claim', nonce: randomBytes(16).toString('hex'), pid: deadPid, hostname: 'some-other-host.example', created_at_epoch_ms: Date.now(), prev: null }) + '\n')
    } finally {
      closeSync(fd)
    }
    expect(writerLockState(root)).toBe('unknown_owner')
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'c5', serviceId: 's', preGeneration: 'g' })).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('keeps sequential appends correct with the holder released', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-lock-seq-'))
  try {
    for (let index = 0; index < 4; index += 1) {
      expect(appendPrivateLedger(root, context, 'restart_intent', {
        resolutionCallId: `c${index}`, serviceId: 's', preGeneration: 'g',
      })).toBe(true)
      expect(__writerLockInternals.readHolder(root)).toBeNull()
    }
    const snapshot = readPrivateLedger(root, context)
    expect(snapshot.records.map((record) => record.position)).toEqual([1, 2, 3, 4])
    expect(writerLockState(root)).toBe('absent')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
