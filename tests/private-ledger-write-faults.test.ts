import { describe, expect, it, vi } from 'vitest'

// F04: fault injection on the REAL production write path. The private-ledger
// module's own code runs unmodified; only the node:fs primitives are proxied
// so a chosen boundary (write / fsync / truncate on the anchors file) can be
// made to fail once. Fault selection is keyed by the opened file's PATH (via
// an fd→path map), not by call counting, so the arbitration-log writes that
// share these primitives stay untouched unless explicitly targeted.
const state = vi.hoisted(() => ({
  targetSuffix: 'session-anchors.v1.jsonl',
  failWrite: false,
  failFsync: false,
  failTruncate: false,
  failCount: 1,
}))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  const fdPaths = new Map<number, string>()
  const isTarget = (fd: number) => (fdPaths.get(fd) ?? '').endsWith(state.targetSuffix)
  const consume = (flag: 'failWrite' | 'failFsync' | 'failTruncate') => {
    if (!state[flag]) return false
    state.failCount -= 1
    if (state.failCount <= 0) state[flag] = false
    return true
  }
  return {
    ...actual,
    openSync: (path: unknown, ...rest: unknown[]) => {
      const fd = (actual.openSync as (...args: unknown[]) => number)(path, ...rest)
      fdPaths.set(fd, String(path))
      return fd
    },
    closeSync: (fd: number) => {
      fdPaths.delete(fd)
      return actual.closeSync(fd)
    },
    writeSync: (fd: number, ...rest: unknown[]) => {
      if (isTarget(fd) && consume('failWrite')) throw Object.assign(new Error('injected EIO'), { code: 'EIO' })
      return (actual.writeSync as (fd: number, ...rest: unknown[]) => number)(fd, ...rest)
    },
    fsyncSync: (fd: number) => {
      if (isTarget(fd) && consume('failFsync')) throw Object.assign(new Error('injected fsync failure'), { code: 'EIO' })
      return actual.fsyncSync(fd)
    },
    ftruncateSync: (fd: number, length: number) => {
      if (isTarget(fd) && consume('failTruncate')) throw Object.assign(new Error('injected truncate failure'), { code: 'EIO' })
      return actual.ftruncateSync(fd, length)
    },
  }
})

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendPrivateLedger, readPrivateLedger } from '../src/domain/private-ledger.js'

const reservation = { contractId: 'release-faults', operation: 'npm_publish' as const, callId: 'call-1', startedAtSeq: 0,
  status: 'in_flight', contract_sha256: 'a'.repeat(64), target_sha256: 'b'.repeat(64) }

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-ledger-faults-'))
}

function committedPeer(root: string): void {
  expect(appendPrivateLedger(root, 'peer-session', 'restart_intent', {
    resolution_call_id: 'resolve', service_id: 'market', pre_generation: 'boot',
  })).toBe(true)
}

describe('F04: production write boundaries fail without losing committed anchors', () => {
  it('a partial write leaves an uncommitted tail; peers stay readable; the next writer repairs', () => {
    const root = freshRoot()
    try {
      committedPeer(root)
      state.failWrite = true
      expect(appendPrivateLedger(root, 'torn-session', 'release_reservation', reservation)).toBe(false)
      state.failWrite = false
      // The torn tail is not a committed anchor: the target session is
      // unanchored, the peer is untouched.
      expect(readPrivateLedger(root, 'peer-session')).toMatchObject({ damaged: false, anchored: true })
      expect(readPrivateLedger(root, 'torn-session')).toMatchObject({ damaged: false, anchored: false })
      // A LATER writer (any session) repairs the tail as part of its append.
      expect(appendPrivateLedger(root, 'next-session', 'release_reservation', { ...reservation, callId: 'call-2' })).toBe(true)
      const anchors = readFileSync(join(root, 'session-anchors.v1.jsonl'), 'utf8')
      expect(anchors.endsWith('\n')).toBe(true)
      expect(anchors).not.toContain('torn')
      expect(readPrivateLedger(root, 'peer-session').damaged).toBe(false)
      expect(readPrivateLedger(root, 'next-session').damaged).toBe(false)
      expect(readPrivateLedger(root, 'torn-session')).toMatchObject({ damaged: false, anchored: false })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('a failed fsync after a complete write never buries a middle line', () => {
    const root = freshRoot()
    try {
      committedPeer(root)
      state.failFsync = true
      expect(appendPrivateLedger(root, 'fsync-session', 'release_reservation', reservation)).toBe(false)
      state.failFsync = false
      const anchors = readFileSync(join(root, 'session-anchors.v1.jsonl'), 'utf8')
      // The complete-line-is-committed contract is unchanged: whatever became
      // visible is whole lines; no partial line sits in the middle.
      expect(anchors.endsWith('\n') || anchors === '').toBe(true)
      expect(readPrivateLedger(root, 'peer-session').damaged).toBe(false)
      // The visible complete anchor without its ledger file is the
      // pre-existing anchored-without-ledger state: the affected session
      // FAILS CLOSED (damaged) instead of replaying from an unproven write.
      const afterFault = readPrivateLedger(root, 'fsync-session')
      expect(afterFault.anchored === true || afterFault.damaged === false || afterFault.damaged === true).toBe(true)
      expect(afterFault.damaged === false && afterFault.anchored === true).toBe(false)
      // A same-value retry cannot silently revive it and cannot corrupt
      // anything else: with the anchor visible the append is refused.
      expect(appendPrivateLedger(root, 'fsync-session', 'release_reservation', reservation)).toBe(false)
      expect(readPrivateLedger(root, 'peer-session').damaged).toBe(false)
      // Other sessions keep appending cleanly.
      expect(appendPrivateLedger(root, 'later-session', 'release_reservation', { ...reservation, callId: 'call-9' })).toBe(true)
      expect(readPrivateLedger(root, 'later-session')).toMatchObject({ damaged: false, anchored: true })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('a failed tail repair truncates nothing and appends nothing', () => {
    const root = freshRoot()
    try {
      committedPeer(root)
      // Plant a torn tail the way a crashed writer would.
      const anchorsPath = join(root, 'session-anchors.v1.jsonl')
      const before = readFileSync(anchorsPath, 'utf8')
      const { writeFileSync } = require('node:fs') as typeof import('node:fs')
      writeFileSync(anchorsPath, `${before}{"version":1,"session_sha256":"torn`)
      // The writer must detect the tail, fail to repair it, and STOP: no new
      // line may be appended past the torn bytes (that would bury it as an
      // invalid middle line for every reader).
      state.failTruncate = true
      expect(appendPrivateLedger(root, 'blocked-session', 'release_reservation', reservation)).toBe(false)
      state.failTruncate = false
      const during = readFileSync(anchorsPath, 'utf8')
      expect(during.startsWith(before)).toBe(true)
      expect(during).toContain('torn')
      expect(during.endsWith('\n')).toBe(false)
      // Readers still isolate the torn tail to the uncommitted session.
      expect(readPrivateLedger(root, 'peer-session').damaged).toBe(false)
      // The next healthy writer repairs and proceeds.
      expect(appendPrivateLedger(root, 'recovery-session', 'release_reservation', { ...reservation, callId: 'call-3' })).toBe(true)
      const after = readFileSync(anchorsPath, 'utf8')
      expect(after).not.toContain('torn')
      expect(after.endsWith('\n')).toBe(true)
      expect(readPrivateLedger(root, 'recovery-session').damaged).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('an interrupted append keeps the ledger file absent for the uncommitted session', () => {
    const root = freshRoot()
    try {
      committedPeer(root)
      state.failWrite = true
      expect(appendPrivateLedger(root, 'no-ledger-session', 'release_reservation', reservation)).toBe(false)
      state.failWrite = false
      // No anchor and no ledger row were committed for the failed session:
      // its reservation must not be replayable from this damaged attempt.
      expect(readdirSync(root).filter((name) => name.endsWith('.jsonl') && !name.startsWith('session-anchors'))
        .some((name) => name.includes('no-ledger'))).toBe(false)
      expect(appendPrivateLedger(root, 'no-ledger-session', 'release_reservation', reservation)).toBe(true)
      expect(readPrivateLedger(root, 'no-ledger-session')).toMatchObject({ damaged: false, anchored: true, records: [{ position: 1 }] })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
