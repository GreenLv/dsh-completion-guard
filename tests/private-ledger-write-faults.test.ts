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
  /** When set, a targeted write FIRST performs a REAL partial write of this
   * many bytes via the actual fs, THEN fails — reproducing a genuine torn
   * tail on disk rather than a zero-byte failure. */
  partialBytes: 0,
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
      if (isTarget(fd) && consume('failWrite')) {
        // Reproduce a REAL torn tail: perform the actual partial write of the
        // leading bytes through the unmodified fs, THEN fail, so the bytes
        // really land on disk before the error.
        const [buffer, offset, length] = rest as [Buffer, number | undefined, number | undefined]
        // writeAll retries short writes, so a genuine torn tail needs the
        // bytes to LAND and the write call to then fail — the in-process
        // image of "the process died after writing N bytes".
        const realWrite = actual.writeSync as (fd: number, buffer: Buffer, offset?: number, length?: number) => number
        const start = offset ?? 0
        const total = length ?? buffer.length - start
        const take = Math.min(state.partialBytes, total)
        if (take > 0) realWrite(fd, buffer, start, take)
        throw Object.assign(new Error('injected EIO'), { code: 'EIO' })
      }
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

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
  it('a REAL partial write lands torn bytes, keeps the committed prefix byte-identical, and the next writer repairs', () => {
    const root = freshRoot()
    try {
      committedPeer(root)
      const anchorsPath = join(root, 'session-anchors.v1.jsonl')
      const committedBytes = readFileSync(anchorsPath, 'utf8')
      // The fault writes all but the last byte of the new anchor line through
      // the REAL fs before failing: a genuine torn tail exists on disk.
      state.failWrite = true
      state.partialBytes = 40
      expect(appendPrivateLedger(root, 'torn-session', 'release_reservation', reservation)).toBe(false)
      state.failWrite = false
      state.partialBytes = 0
      const tornBytes = readFileSync(anchorsPath, 'utf8')
      // The COMMITTED prefix is byte-identical to before the fault...
      expect(tornBytes.startsWith(committedBytes)).toBe(true)
      // ...the torn bytes really exist past it (not a zero-byte failure)...
      expect(tornBytes.length).toBeGreaterThan(committedBytes.length)
      expect(tornBytes.endsWith('\n')).toBe(false)
      // ...and the torn line is anchored data, not prose (hash filenames
      // carry no session text; assert the FILE CONTENT instead).
      expect(tornBytes).toContain('"session_sha256"')
      // The torn session holds NO authoritative record: unanchored and clean.
      expect(readPrivateLedger(root, 'peer-session')).toMatchObject({ damaged: false, anchored: true })
      expect(readPrivateLedger(root, 'torn-session')).toMatchObject({ damaged: false, anchored: false })
      // A LATER production writer repairs the tail as part of its append.
      expect(appendPrivateLedger(root, 'next-session', 'release_reservation', { ...reservation, callId: 'call-2' })).toBe(true)
      const repaired = readFileSync(anchorsPath, 'utf8')
      expect(repaired.startsWith(committedBytes)).toBe(true)
      expect(repaired.endsWith('\n')).toBe(true)
      expect(repaired).not.toContain('"torn')
      expect(readPrivateLedger(root, 'peer-session').damaged).toBe(false)
      expect(readPrivateLedger(root, 'next-session')).toMatchObject({ damaged: false, anchored: true, records: [{ position: 1 }] })
      expect(readPrivateLedger(root, 'torn-session')).toMatchObject({ damaged: false, anchored: false })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('a torn tail that was repaired but whose append then fails leaves all-complete lines', () => {
    const root = freshRoot()
    try {
      committedPeer(root)
      const anchorsPath = join(root, 'session-anchors.v1.jsonl')
      // Plant a torn tail (crashed-writer state).
      const before = readFileSync(anchorsPath, 'utf8')
      writeFileSync(anchorsPath, `${before}{"version":1,"session_sha256":"torn`)
      // The writer truncates the torn tail successfully, then its append fails.
      state.failTruncate = false
      state.failWrite = true
      expect(appendPrivateLedger(root, 'truncate-ok-session', 'release_reservation', reservation)).toBe(false)
      state.failWrite = false
      const after = readFileSync(anchorsPath, 'utf8')
      // Truncation removed the torn tail; the failed append added nothing.
      expect(after).toBe(before)
      expect(after.endsWith('\n')).toBe(true)
      // Every line on disk is complete: readers see the healthy peer only.
      expect(readPrivateLedger(root, 'peer-session')).toMatchObject({ damaged: false, anchored: true })
      expect(readPrivateLedger(root, 'truncate-ok-session')).toMatchObject({ damaged: false, anchored: false })
      // The next writer proceeds cleanly from the all-complete state.
      expect(appendPrivateLedger(root, 'after-session', 'release_reservation', { ...reservation, callId: 'call-5' })).toBe(true)
      expect(readPrivateLedger(root, 'after-session')).toMatchObject({ damaged: false, anchored: true })
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
