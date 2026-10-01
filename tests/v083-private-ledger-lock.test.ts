import { expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { appendPrivateLedger, initializePrivateLedger, readPrivateLedger, writerLockState } from '../src/domain/private-ledger.js'
import type { PrivateLedgerContext } from '../src/domain/private-ledger.js'

// CG-083-BUG01/R2/F1 revision 2: slot + pending + evict-intent protocol.
// The holder is slot.json (a hard link to a complete owner record); recovery
// requires the evict-intent handshake and aborts on a stale observation; only
// ESRCH proves death; legacy root locks REFUSE (L3).

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

function slotPath(root: string): string {
  return join(root, 'slot.json')
}

function writeDeadSlot(root: string): void {
  writeFileSync(slotPath(root), JSON.stringify({
    version: 3, nonce: randomBytes(16).toString('hex'), pid: deadPid,
    hostname: hostname(), created_at_epoch_ms: Date.now(),
  }) + '\n', 'utf8')
}

it('recovers a provably dead slot holder and keeps the chain intact', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-lock-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    writeDeadSlot(root)
    expect(writerLockState(root)).toBe('abandoned_recoverable')
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'c1', serviceId: 's', preGeneration: 'g' })).toBe(true)
    expect(existsSync(slotPath(root))).toBe(false)
    const snapshot = readPrivateLedger(root, context)
    expect(snapshot.damaged).toBe(false)
    expect(snapshot.records).toHaveLength(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('never steals a slot held by a live owner (PID reuse included)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-lock-live-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    const held = JSON.stringify({
      version: 3, nonce: randomBytes(16).toString('hex'), pid: process.pid,
      hostname: hostname(), created_at_epoch_ms: Date.now(),
    }) + '\n'
    writeFileSync(slotPath(root), held, 'utf8')
    expect(writerLockState(root)).toBe('held')
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'c2', serviceId: 's', preGeneration: 'g' })).toBe(false)
    expect(readFileSync(slotPath(root), 'utf8')).toBe(held)
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

it('refuses a foreign-host dead-owner slot', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-lock-foreign-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    writeFileSync(slotPath(root), JSON.stringify({
      version: 3, nonce: randomBytes(16).toString('hex'), pid: deadPid,
      hostname: 'some-other-host.example', created_at_epoch_ms: Date.now(),
    }) + '\n', 'utf8')
    expect(writerLockState(root)).toBe('unknown_owner')
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'c5', serviceId: 's', preGeneration: 'g' })).toBe(false)
    expect(existsSync(slotPath(root))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('keeps sequential appends correct with the slot released', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-lock-seq-'))
  try {
    for (let index = 0; index < 4; index += 1) {
      expect(appendPrivateLedger(root, context, 'restart_intent', {
        resolutionCallId: `c${index}`, serviceId: 's', preGeneration: 'g',
      })).toBe(true)
      expect(existsSync(slotPath(root))).toBe(false)
    }
    const snapshot = readPrivateLedger(root, context)
    expect(snapshot.records.map((record) => record.position)).toEqual([1, 2, 3, 4])
    expect(writerLockState(root)).toBe('absent')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('garbage-collects a pending file left by a provably dead creator', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-lock-pending-'))
  try {
    expect(initializePrivateLedger(root, context)).toBe(true)
    // A creator that died before linking leaves pending.<nonce>.json; the
    // next acquire GCs it by name (identity-safe), including the retry path
    // where its own nonce collides with the dead leftover.
    const deadNonce = randomBytes(16).toString('hex')
    writeFileSync(join(root, `pending.${deadNonce}.json`), JSON.stringify({
      version: 3, nonce: deadNonce, pid: deadPid,
      hostname: hostname(), created_at_epoch_ms: Date.now(),
    }) + '\n', 'utf8')
    expect(appendPrivateLedger(root, context, 'restart_intent', { resolutionCallId: 'z1', serviceId: 's', preGeneration: 'g' })).toBe(true)
    expect(existsSync(join(root, `pending.${deadNonce}.json`))).toBe(false)
    const leftovers = readdirSync(root).filter((name) => name.startsWith('pending.'))
    expect(leftovers).toEqual([])
    expect(readPrivateLedger(root, context).records).toHaveLength(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
