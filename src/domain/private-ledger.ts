import { closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { hostname } from 'node:os'
import { randomBytes } from 'node:crypto'
import { sha256 } from './canonicalize.js'
import { normalizeReservation, normalizeSettlement, OUTCOME_STRENGTH, readbackSettlesContract } from './release.js'
import type { GuardProjection } from './types.js'

export type PrivateLedgerKind = 'release_reservation' | 'release_settlement' | 'restart_intent'
export interface PrivateLedgerContext { sessionId: string; sessionHeader: Record<string, unknown>; cwd: string; hostLockDigest: string }
export interface PrivateLedgerRecord { version: 1; session_sha256: string; context_sha256: string; position: number; prior_sha256: string | null; kind: PrivateLedgerKind; payload: Record<string, unknown>; record_sha256: string }
export interface PrivateLedgerSnapshot { records: PrivateLedgerRecord[]; damaged: boolean; anchored?: boolean }

const normalizeContext = (value: PrivateLedgerContext | string): PrivateLedgerContext => typeof value === 'string'
  ? { sessionId: value, sessionHeader: { id: value }, cwd: '/', hostLockDigest: 'test-seam' } : value

const canonical = (value: unknown): string => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError('private_ledger_non_json_number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  throw new TypeError('private_ledger_non_json_value')
}
const digestRecord = (record: Omit<PrivateLedgerRecord, 'record_sha256'>): string => sha256(canonical(record))
const sessionDigest = (sessionId: string): string => sha256(`dsh-completion-guard/private-ledger/v1\0${sessionId}`)
const contextDigest = (context: PrivateLedgerContext, root: string): string => sha256(canonical({ session_sha256: sessionDigest(context.sessionId), session_header: context.sessionHeader, cwd_sha256: sha256(context.cwd), host_lock_sha256: context.hostLockDigest, ledger_root_sha256: sha256(realpathSync(root)) }))
const ledgerPath = (root: string, context: PrivateLedgerContext): string => join(root, `${sessionDigest(context.sessionId)}.jsonl`)
const anchorPath = (root: string): string => join(root, 'session-anchors.v1.jsonl')

export const privateLedgerContractDigest = (contract: unknown): string => {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return sha256(canonical(contract))
  const { revokedAtSeq: _mutableRevocation, ...immutable } = contract as Record<string, unknown>
  return sha256(canonical(immutable))
}
export const privateLedgerTargetDigest = (target: unknown): string => sha256(canonical(target))

/** Mirrors the audited dsh-home-paths precedence without importing another host package. */
export function resolvePrivateLedgerRoot(configured: string | undefined, envHome: string | undefined, osHome: string): string | undefined {
  const selected = configured ?? (envHome?.trim() ? envHome : join(osHome, '.dsh'))
  if (!selected || !osHome) return undefined
  const expanded = selected === '~' ? osHome
    : selected.startsWith('~/') || selected.startsWith('~\\') ? join(osHome, selected.slice(2)) : selected
  return join(resolve(expanded), 'completion-guard', 'private-ledger-v1')
}

function ensureRoot(root: string): void {
  if (resolve(root) !== root) throw new Error('private_ledger_root_not_normalized')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const stat = lstatSync(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('private_ledger_root_unsafe')
}
function openRegular(path: string, flags: number, mode = 0o600): number {
  const fd = openSync(path, flags | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW), mode)
  const stat = fstatSync(fd)
  if (!stat.isFile()) { closeSync(fd); throw new Error('private_ledger_file_unsafe') }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) fchmodSync(fd, 0o600)
  return fd
}
function writeAll(fd: number, text: string): void {
  const bytes = Buffer.from(text); let offset = 0
  while (offset < bytes.length) { const written = writeSync(fd, bytes, offset, bytes.length - offset); if (written <= 0) throw new Error('private_ledger_partial_write'); offset += written }
}
function syncDirectory(root: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(root, constants.O_RDONLY)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
function readAnchors(root: string): Map<string, string> {
  const path = anchorPath(root)
  if (!existsSync(path)) return new Map()
  const fd = openRegular(path, constants.O_RDONLY); let raw: string
  try { raw = readFileSync(fd, 'utf8') } finally { closeSync(fd) }
  if (raw && !raw.endsWith('\n')) throw new Error('private_ledger_anchor_truncated')
  const anchors = new Map<string, string>()
  for (const line of raw.split('\n').filter(Boolean)) {
    const value = JSON.parse(line) as Record<string, unknown>
    const unsigned = { version: 1, session_sha256: value.session_sha256, context_sha256: value.context_sha256 }
    if (value.version !== 1 || typeof value.session_sha256 !== 'string' || typeof value.context_sha256 !== 'string' || value.anchor_sha256 !== sha256(canonical(unsigned))) throw new Error('private_ledger_anchor_invalid')
    const existing = anchors.get(value.session_sha256)
    if (existing && existing !== value.context_sha256) throw new Error('private_ledger_anchor_conflict')
    anchors.set(value.session_sha256, value.context_sha256)
  }
  return anchors
}

/**
 * The one full ledger read+chain-verify, shared by the read and append paths
 * (CG-083-PERF05: an append used to re-read the anchors AND the whole ledger
 * after already reading the anchors under the lock). Callers must already
 * hold the writer lock or accept the unlocked-read race the public API had.
 * Returns `undefined` for "ledger file missing" so callers can distinguish
 * the anchored-but-missing (damaged) case from an empty ledger.
 */
function readVerifiedLedgerRecords(root: string, context: PrivateLedgerContext, session: string,
  expectedContext: string): PrivateLedgerRecord[] | undefined {
  const path = ledgerPath(root, context)
  if (!existsSync(path)) return undefined
  const fd = openRegular(path, constants.O_RDONLY); let raw: string
  try { raw = readFileSync(fd, 'utf8') } finally { closeSync(fd) }
  if (raw && !raw.endsWith('\n')) return undefined
  const records: PrivateLedgerRecord[] = []; let prior: string | null = null
  for (const [index, line] of raw.split('\n').filter(Boolean).entries()) {
    const value = JSON.parse(line) as PrivateLedgerRecord; const { record_sha256, ...unsigned } = value
    if (value.version !== 1 || value.session_sha256 !== session || value.context_sha256 !== expectedContext || value.position !== index + 1 || value.prior_sha256 !== prior || !['release_reservation','release_settlement','restart_intent'].includes(value.kind) || !value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload) || record_sha256 !== digestRecord(unsigned)) return undefined
    records.push(value); prior = record_sha256
  }
  return records
}

/**
 * CG-083-BUG01/R2/F1 (revision 2): slot + pending + evict-intent writer lock.
 * See docs/WRITER_LOCK_PROTOCOL.md "Revision 2" for the state machine and the
 * linearization argument. Summary:
 *
 * - `slot.json` IS the holder: present = one writer inside its critical
 *   section. It is a hard link to a complete owner record; its content never
 *   changes while present (invariant S1), so a recovery decision made on its
 *   current nonce can be executed safely.
 * - A candidate creates `pending.<nonce>.json` (O_EXCL), writes its owner
 *   record and hard-links it to `slot.json`. link() is the atomic admission:
 *   EEXIST means someone else holds. Pending files carry no authority.
 * - Recovery of a PROVABLY dead slot owner (same host, ESRCH only) creates
 *   `evict-intent` O_EXCL (atomic, blocks nothing for reading but marks the
 *   linearization), then re-reads the slot and unlinks it ONLY if the current
 *   nonce is still the observed dead one. A delayed recoverer whose
 *   observation is stale reads a different (live) nonce and aborts — it can
 *   never evict a live holder (L1/L2). A recoverer that dies holding the
 *   intent is adopted by the next actor through its own provably dead creator
 *   record.
 * - Legacy root-level `.writer.lock` files from version <=2 are never
 *   modified by this protocol; their presence REFUSES acquisition (L3) so
 *   old and new writers never share the write section.
 */
const WRITER_LOCK_VERSION = 3
const SLOT_NAME = 'slot.json'
const PENDING_PREFIX = 'pending.'
const INTENT_NAME = 'evict-intent'
const LEGACY_LOCK_PATHS = ['.writer.lock', '.writer.lock.stale', '.writer.lock.recovery']
interface WriterLockRecord { version: 3; nonce: string; pid: number; hostname: string; created_at_epoch_ms: number }
interface HeldLock { nonce: string }

export type WriterLockState = 'absent' | 'held' | 'abandoned_recoverable' | 'unknown_owner'

function slotPath(root: string): string { return join(root, SLOT_NAME) }
function pendingPath(root: string, nonce: string): string { return join(root, `${PENDING_PREFIX}${nonce}.json`) }
function intentPath(root: string): string { return join(root, INTENT_NAME) }

function readRecord(path: string, versions: readonly number[] = [WRITER_LOCK_VERSION]): WriterLockRecord | 'legacy' | undefined {
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch { return undefined }
  if (!raw.trim()) return 'legacy'
  try {
    const value = JSON.parse(raw) as Partial<WriterLockRecord>
    if (value && (versions as readonly number[]).includes(value.version as number)
      && typeof value.nonce === 'string' && (value.nonce.length === 32 || (value.version as number) === 2)
      && typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 0
      && typeof value.hostname === 'string' && typeof value.created_at_epoch_ms === 'number') return value as WriterLockRecord
  } catch { /* unparsable record */ }
  return 'legacy'
}

interface IntentRecord { evicting: string; nonce: string; pid: number; hostname: string; created_at_epoch_ms: number }

function readIntent(path: string): IntentRecord | 'legacy' | undefined {
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch { return undefined }
  if (!raw.trim()) return 'legacy'
  try {
    const value = JSON.parse(raw) as Partial<IntentRecord>
    if (value && typeof value.evicting === 'string' && typeof value.nonce === 'string' && value.nonce.length === 32
      && typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 0
      && typeof value.hostname === 'string') return value as IntentRecord
  } catch { /* unparsable record */ }
  return 'legacy'
}

/** Only ESRCH proves a recorded owner is gone; any other answer refuses. */
function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function recordIsProvablyDead(record: WriterLockRecord): boolean {
  return record.hostname === hostname() && !processExists(record.pid)
}

/**
 * Classification shared by the slot and legacy diagnostics: a well-formed
 * record of the RUNNING protocol reports held / abandoned_recoverable; any
 * other state (other version, other host, unparsable, anonymous) is an
 * unknown owner and refuses fail-closed (L3).
 */
function classifyRecord(record: WriterLockRecord | 'legacy' | undefined): WriterLockState | undefined {
  if (record === undefined) return undefined
  if (record === 'legacy') return 'unknown_owner'
  if (record.hostname !== hostname()) return 'unknown_owner'
  return processExists(record.pid) ? 'held' : 'abandoned_recoverable'
}

/** Read-only diagnostics for the current holder or a blocking legacy lock. */
export function writerLockState(root: string): WriterLockState {
  const slot = classifyRecord(readRecord(slotPath(root)))
  if (slot !== undefined) return slot
  for (const name of LEGACY_LOCK_PATHS) {
    const legacy = classifyRecord(readRecord(join(root, name), [WRITER_LOCK_VERSION, 2]))
    if (legacy !== undefined) return legacy
  }
  return 'absent'
}

/** Test/ops helper: the current slot file (undefined when no holder). */
export function currentWriterLockFile(root: string): string | undefined {
  return existsSync(slotPath(root)) ? slotPath(root) : undefined
}

/** Unlink a path when it exists; other errors propagate. */
function unlinkIfExists(path: string): void {
  try { unlinkSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/**
 * Recovery handshake for a provably dead slot owner (docs/WRITER_LOCK_PROTOCOL.md
 * Revision 2, recovery steps 1–2). Returns true when this call finalized the
 * eviction (slot removed), false when the slot content no longer names the
 * dead owner (stale observation — abort) or another live intent creator owns
 * the handshake.
 */
function evictDeadHolder(root: string, dead: WriterLockRecord): boolean {
  const intent: IntentRecord = {
    evicting: dead.nonce,
    nonce: randomBytes(16).toString('hex'),
    pid: process.pid,
    hostname: hostname(),
    created_at_epoch_ms: Date.now(),
  }
  let fd: number
  try {
    fd = openRegular(intentPath(root), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const winner = readIntent(intentPath(root))
    if (winner === undefined || winner === 'legacy') return false
    // The creator is provably dead: adopt the handshake (unlink and recreate).
    if (!recordIsProvablyDead({ version: WRITER_LOCK_VERSION, nonce: winner.nonce, pid: winner.pid,
      hostname: winner.hostname, created_at_epoch_ms: winner.created_at_epoch_ms })) {
      return false // a live recoverer owns the handshake; refuse this round
    }
    try { unlinkSync(intentPath(root)) } catch (adoptError) {
      if ((adoptError as NodeJS.ErrnoException).code !== 'ENOENT') return false
    }
    try {
      fd = openRegular(intentPath(root), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)
    } catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw retryError
    }
  }
  try {
    const record: IntentRecord = {
      evicting: intent.evicting, nonce: intent.nonce, pid: intent.pid,
      hostname: intent.hostname, created_at_epoch_ms: intent.created_at_epoch_ms,
    }
    writeAll(fd, `${canonical(record)}\n`)
    fsyncSync(fd)
  } finally {
    try { closeSync(fd) } catch { /* already closed */ }
  }
  try {
    // Linearization: re-read the slot WITH the intent in place and finalize
    // only on the exact dead nonce. While present, slot content is immutable
    // (S1); a new holder cannot appear between this read and the unlink
    // because admission requires the slot to be absent.
    const current = readRecord(slotPath(root))
    if (current !== undefined && current !== 'legacy' && current.nonce === dead.nonce) {
      unlinkIfExists(slotPath(root))
      unlinkIfExists(pendingPath(root, dead.nonce))
      return true
    }
    return false
  } finally {
    unlinkIfExists(intentPath(root))
  }
}

/** Remove this actor's pending file by name (identity-safe GC). */
function removeOwnPending(root: string, nonce: string): void {
  unlinkIfExists(pendingPath(root, nonce))
}

/** GC a pending file whose creator is provably dead (by name). */
function gcDeadPending(root: string, nonce: string): void {
  const record = readRecord(pendingPath(root, nonce))
  if (record !== undefined && record !== 'legacy' && recordIsProvablyDead(record)) {
    unlinkIfExists(pendingPath(root, nonce))
  }
}

/**
 * Acquire the writer lock. Returns the held nonce, or undefined when
 * acquisition is refused (live/unknown holder, legacy lock, live intent
 * creator, or contention). See docs/WRITER_LOCK_PROTOCOL.md Revision 2.
 */
function acquireWriterLock(root: string): HeldLock | undefined {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    // L3: a legacy root-level lock (version <=2) must never be shared with
    // the v3 write section. Refuse without touching its bytes.
    for (const name of LEGACY_LOCK_PATHS) {
      const legacy = readRecord(join(root, name), [WRITER_LOCK_VERSION, 2])
      if (legacy !== undefined) return undefined
    }
    // GC pass over ALL pending files: identity-safe by name, only provably
    // dead creators are removed (a live candidate may be mid-link).
    for (const entry of readdirSync(root)) {
      if (!entry.startsWith(PENDING_PREFIX)) continue
      const candidate = readRecord(join(root, entry))
      if (candidate !== undefined && candidate !== 'legacy' && recordIsProvablyDead(candidate)) {
        unlinkIfExists(join(root, entry))
      }
    }
    const nonce = randomBytes(16).toString('hex')
    let pendingFd: number
    try {
      pendingFd = openRegular(pendingPath(root, nonce), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') { gcDeadPending(root, nonce); continue }
      throw error
    }
    let own: WriterLockRecord
    try {
      own = { version: WRITER_LOCK_VERSION, nonce, pid: process.pid, hostname: hostname(), created_at_epoch_ms: Date.now() }
      writeAll(pendingFd, `${canonical(own)}\n`)
      fsyncSync(pendingFd)
    } catch (error) {
      try { closeSync(pendingFd) } catch { /* already closed */ }
      removeOwnPending(root, nonce)
      throw error
    }
    try { closeSync(pendingFd) } catch { /* already closed */ }
    try {
      // Atomic admission: link succeeds only when the slot is absent.
      linkSync(pendingPath(root, nonce), slotPath(root))
      return { nonce }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        removeOwnPending(root, nonce)
        throw error
      }
    }
    // Slot taken: decide from its CURRENT record.
    const holder = readRecord(slotPath(root))
    if (holder !== undefined && holder !== 'legacy' && recordIsProvablyDead(holder)) {
      if (evictDeadHolder(root, holder)) continue // recovered; retry admission
      removeOwnPending(root, nonce)
      return undefined
    }
    removeOwnPending(root, nonce)
    return undefined
  }
  return undefined
}

function releaseWriterLock(root: string, held: HeldLock | undefined): void {
  if (held === undefined) return
  const holder = readRecord(slotPath(root))
  if (holder !== undefined && holder !== 'legacy' && holder.nonce === held.nonce) {
    unlinkIfExists(slotPath(root))
  }
  removeOwnPending(root, held.nonce)
}

/**
 * Test-only deterministic-interleaving hooks (docs/WRITER_LOCK_PROTOCOL.md
 * Revision 2 test obligations). They expose the protocol's atomic steps so
 * tests can pause a real process between an observation and its action
 * WITHOUT reimplementing the protocol; production callers ignore this export.
 */
export const __writerLockInternals = {
  acquire: (root: string): HeldLock | undefined => acquireWriterLock(root),
  release: (root: string, held: HeldLock | undefined): void => releaseWriterLock(root, held),
  readSlot: (root: string): WriterLockRecord | 'legacy' | undefined => readRecord(slotPath(root)),
  slotPath: (root: string): string => slotPath(root),
  evictDeadHolder: (root: string, dead: WriterLockRecord): boolean => evictDeadHolder(root, dead),
  /** L2 fixture: phase 1 — create a pending candidate (no authority). */
  prepareCandidate: (root: string, nonce: string): WriterLockRecord => {
    const own: WriterLockRecord = {
      version: WRITER_LOCK_VERSION, nonce,
      pid: process.pid, hostname: hostname(), created_at_epoch_ms: Date.now(),
    }
    const fd = openRegular(pendingPath(root, nonce), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)
    try { writeAll(fd, `${canonical(own)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
    return own
  },
  /** L2 fixture: phase 2 — attempt atomic admission against the live slot. */
  linkCandidate: (root: string, nonce: string): 'linked' | 'eexist' => {
    try {
      linkSync(pendingPath(root, nonce), slotPath(root))
      return 'linked'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'eexist'
      throw error
    }
  },
  createIntent: (root: string, evicting: string): boolean => {
    const intent: IntentRecord = {
      evicting, nonce: randomBytes(16).toString('hex'), pid: process.pid,
      hostname: hostname(), created_at_epoch_ms: Date.now(),
    }
    try {
      const fd = openRegular(intentPath(root), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)
      try { writeAll(fd, `${canonical(intent)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
  },
}

export function readPrivateLedger(root: string | undefined, input: PrivateLedgerContext | string): PrivateLedgerSnapshot {
  if (!root) return { records: [], damaged: true, anchored: false }
  try {
    const context = normalizeContext(input)
    if (!existsSync(root)) return { records: [], damaged: false, anchored: false }
    const rootStat = lstatSync(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { records: [], damaged: true, anchored: false }
    const session = sessionDigest(context.sessionId); const expectedContext = contextDigest(context, root); const anchored = readAnchors(root).get(session)
    if (anchored !== undefined && anchored !== expectedContext) return { records: [], damaged: true, anchored: true }
    if (anchored === undefined) {
      // Historical rule: a ledger FILE without an anchor is damaged state,
      // while a missing file for an unanchored session is simply unused.
      if (existsSync(ledgerPath(root, context))) return { records: [], damaged: true, anchored: false }
      return { records: [], damaged: false, anchored: false }
    }
    const records = readVerifiedLedgerRecords(root, context, session, expectedContext)
    if (records === undefined) return { records: [], damaged: true, anchored: true }
    return { records, damaged: false, anchored: true }
  } catch { return { records: [], damaged: true, anchored: false } }
}

/** Establish the provider-invisible anchor when a live runtime observes a new adoption. */
export function initializePrivateLedger(root: string | undefined, input: PrivateLedgerContext | string): boolean {
  if (!root) return false
  let lockFd: HeldLock | undefined
  try {
    const context = normalizeContext(input); ensureRoot(root)
    lockFd = acquireWriterLock(root)
    if (lockFd === undefined) return false
    const session = sessionDigest(context.sessionId); const expectedContext = contextDigest(context, root)
    const anchors = readAnchors(root); const anchored = anchors.get(session)
    if (anchored !== undefined) return anchored === expectedContext
    const unsignedAnchor = { version: 1, session_sha256: session, context_sha256: expectedContext }
    const fd = openRegular(anchorPath(root), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND)
    try { writeAll(fd, `${canonical({ ...unsignedAnchor, anchor_sha256: sha256(canonical(unsignedAnchor)) })}\n`); fsyncSync(fd) } finally { closeSync(fd) }
    const ledgerFd = openRegular(ledgerPath(root, context), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)
    try { fsyncSync(ledgerFd) } finally { closeSync(ledgerFd) }
    syncDirectory(root); return true
  } catch { return false } finally {
    releaseWriterLock(root, lockFd)
  }
}

export function appendPrivateLedger(root: string | undefined, input: PrivateLedgerContext | string, kind: PrivateLedgerKind, payload: Record<string, unknown>): boolean {
  if (!root) return false
  let lockFd: HeldLock | undefined
  try {
    const context = normalizeContext(input)
    ensureRoot(root)
    lockFd = acquireWriterLock(root)
    if (lockFd === undefined) return false
    const session = sessionDigest(context.sessionId); const expectedContext = contextDigest(context, root); const anchored = readAnchors(root).get(session)
    if (anchored !== undefined && anchored !== expectedContext) return false
    // CG-083-PERF05: the ledger is read and chain-verified ONCE under this
    // lock (the append used to re-read the anchors and the whole ledger after
    // the read above). Cross-entry freshness is unchanged: every entry takes
    // its own lock and re-reads the current files.
    let records: PrivateLedgerRecord[] = []
    if (anchored !== undefined) {
      const verified = readVerifiedLedgerRecords(root, context, session, expectedContext)
      if (verified === undefined) return false
      records = verified
    } else {
      const unsignedAnchor = { version: 1, session_sha256: session, context_sha256: expectedContext }
      const fd = openRegular(anchorPath(root), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND)
      try { writeAll(fd, `${canonical({ ...unsignedAnchor, anchor_sha256: sha256(canonical(unsignedAnchor)) })}\n`); fsyncSync(fd) } finally { closeSync(fd) }
      syncDirectory(root)
    }
    if (kind === 'release_settlement') {
      const settlement = normalizeSettlement(payload)
      const reservation = settlement && [...records].reverse().find((record) => record.kind === 'release_reservation' && record.payload.contractId === settlement.contractId && record.payload.operation === settlement.operation && record.payload.callId === settlement.callId)
      if (!reservation) return false
      payload = { ...payload, reservation_sha256: reservation.record_sha256, contract_sha256: reservation.payload.contract_sha256, target_sha256: reservation.payload.target_sha256 }
    }
    const unsigned: Omit<PrivateLedgerRecord, 'record_sha256'> = { version: 1, session_sha256: session, context_sha256: expectedContext, position: records.length + 1, prior_sha256: records.at(-1)?.record_sha256 ?? null, kind, payload }
    const record: PrivateLedgerRecord = { ...unsigned, record_sha256: digestRecord(unsigned) }
    const fd = openRegular(ledgerPath(root, context), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND)
    try { writeAll(fd, `${canonical(record)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
    syncDirectory(root)
    return true
  } catch { return false } finally {
    releaseWriterLock(root, lockFd)
  }
}

export function applyPrivateLedger(projection: GuardProjection, snapshot: PrivateLedgerSnapshot): void {
  if (snapshot.damaged || projection.releaseContracts.length > 0 && snapshot.anchored === false) {
    projection.releaseStateDamaged = true
    if (!projection.releaseDiagnostics.some((row) => row.reasonCode === 'private_ledger_damaged')) projection.releaseDiagnostics.push({ seq: 0, reasonCode: 'private_ledger_damaged' })
    return
  }
  const reservations = new Map<string, PrivateLedgerRecord>()
  for (const record of snapshot.records) {
    if (record.kind === 'release_reservation') {
      const normalized = normalizeReservation(record.payload); const contract = normalized && projection.releaseContracts.find((entry) => entry.contractId === normalized.contractId)
      if (!normalized || !contract || record.payload.contract_sha256 !== privateLedgerContractDigest(contract) || typeof record.payload.target_sha256 !== 'string') { projection.releaseStateDamaged = true; continue }
      const key = `${normalized.contractId}\0${normalized.operation}\0${normalized.callId}`
      if (reservations.has(key)) { projection.releaseStateDamaged = true; continue }
      reservations.set(key, record)
      const existing = projection.releaseReservations.find((entry) => entry.callId === normalized.callId)
      if (existing && (existing.contractId !== normalized.contractId || existing.operation !== normalized.operation)) { projection.releaseStateDamaged = true; continue }
      if (!existing) projection.releaseReservations.push({ ...normalized, startedAtSeq: 0, ledgerPosition: record.position })
    } else if (record.kind === 'release_settlement') {
      const normalized = normalizeSettlement(record.payload); const key = normalized && `${normalized.contractId}\0${normalized.operation}\0${normalized.callId}`; const reservationRecord = key ? reservations.get(key) : undefined; const contract = normalized && projection.releaseContracts.find((entry) => entry.contractId === normalized.contractId)
      const source = record.payload.settlement_source
      const readbackVerdict = normalized && contract ? readbackSettlesContract(contract, normalized.readback,
        reservationRecord ? normalizeReservation(reservationRecord.payload)?.observedArtifactSri : undefined) : undefined
      if (!normalized || !reservationRecord || !contract || (source !== 'effect' && source !== 'reconcile')
        || (normalized.outcome === 'not_effected' && source !== 'effect')
        || (source === 'reconcile' && normalized.readback === 'unavailable')
        || record.payload.reservation_sha256 !== reservationRecord.record_sha256
        || record.payload.contract_sha256 !== reservationRecord.payload.contract_sha256
        || record.payload.target_sha256 !== reservationRecord.payload.target_sha256
        || (normalized.outcome === 'settled' && readbackVerdict !== 'settled')
        || (source === 'reconcile' && readbackVerdict === 'mismatch')) { projection.releaseStateDamaged = true; continue }
      const pinned = { ...normalized, settledAtSeq: 0, ledgerPosition: record.position }
      const index = projection.releaseSettlements.findIndex((entry) => entry.contractId === pinned.contractId && entry.operation === pinned.operation && entry.callId === pinned.callId)
      if (index < 0) projection.releaseSettlements.push(pinned)
      else if (OUTCOME_STRENGTH[pinned.outcome] >= OUTCOME_STRENGTH[projection.releaseSettlements[index]!.outcome]) projection.releaseSettlements[index] = pinned
    }
  }
}

export function hasPrivateRestartIntent(snapshot: PrivateLedgerSnapshot, resolutionCallId: string, serviceId: string, preGeneration: string): boolean {
  return !snapshot.damaged && snapshot.records.some((record) => record.kind === 'restart_intent' && record.payload.resolution_call_id === resolutionCallId && record.payload.service_id === serviceId && record.payload.pre_generation === preGeneration)
}
