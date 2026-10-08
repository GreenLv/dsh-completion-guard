import { closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs'
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
  // Windows does not expose O_NOFOLLOW. Reject an existing link before open,
  // then verify the opened file against the current directory entry before
  // reading or writing through the descriptor.
  try {
    const entry = lstatSync(path)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('private_ledger_file_unsafe')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const fd = openSync(path, flags | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW), mode)
  try {
    const stat = fstatSync(fd)
    const entry = lstatSync(path)
    if (!stat.isFile() || !entry.isFile() || entry.isSymbolicLink()
      || stat.dev !== entry.dev || stat.ino !== entry.ino) throw new Error('private_ledger_file_unsafe')
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) fchmodSync(fd, 0o600)
    return fd
  } catch (error) {
    closeSync(fd)
    throw error
  }
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
 * CG-083-F1 (revision 3): arbitration-log writer lock with optimistic
 * concurrency control. See docs/WRITER_LOCK_PROTOCOL.md "Revision 3".
 *
 * All authority decisions are records appended to `arbitration.log` (atomicity
 * assumptions A1/A2 in the doc). A claim carries `prev` — the holder nonce the
 * claimant observed — and the deterministic replay grants it only if the
 * current holder at its log position equals `prev`. Recovery appends
 * `evict {prev: deadNonce}` after an ESRCH probe; a delayed recoverer's record
 * is adjudicated against the CURRENT holder and simply has no effect when the
 * holder changed (L1/L2 structurally impossible: nothing is ever deleted from
 * or done to a pathname on the basis of an older observation).
 *
 * Bidirectional v2 upgrade barrier (L3): the v3 critical section also holds
 * the v2-shaped root `.writer.lock` (O_EXCL, version-2-shaped owner record).
 * A live v2 writer refuses (file exists); v3 refuses while a live/unknown v2
 * record exists; a v2 record whose pid answers ESRCH is removed by name (v2
 * has no self-recovery) and the migration proceeds.
 */
const ARBITRATION_NAME = 'arbitration.log'
const LEGACY_V2_LOCK_NAME = '.writer.lock'
const PENDING_PREFIX = 'pending.'
const LOG_COMPACTION_RECORDS = 8192
interface WriterLockRecord { version: 2 | 3; nonce: string; pid: number; hostname: string; created_at_epoch_ms: number }
interface ArbitrationRecord {
  v: 3
  op: 'claim' | 'release' | 'evict'
  nonce: string
  pid: number
  hostname: string
  created_at_epoch_ms: number
  /** Expected holder nonce at the moment of observation (null = empty slot). */
  prev: string | null
}
interface HeldLock { nonce: string; ownedBarrier: boolean }
export interface ArbitrationHolder { nonce: string; pid: number; hostname: string; created_at_epoch_ms: number }

export type WriterLockState = 'absent' | 'held' | 'abandoned_recoverable' | 'unknown_owner'

function arbitrationPath(root: string): string { return join(root, ARBITRATION_NAME) }
function legacyV2Path(root: string): string { return join(root, LEGACY_V2_LOCK_NAME) }

/**
 * Parse the log (docs/WRITER_LOCK_PROTOCOL.md Revision 3.1, correction 3).
 * Unparseable lines — torn tails from a crash mid-append — are SKIPPED: they
 * never took effect, so skipping revokes nothing, and later complete records
 * stay visible (there is no truncation anywhere in the protocol, so a
 * truncate-and-revive race cannot exist). A final line without a trailing
 * newline is still replayed when it parses: it was fully written.
 */
function parseArbitration(root: string): ArbitrationRecord[] {
  let raw: string
  try { raw = readFileSync(arbitrationPath(root), 'utf8') } catch { return [] }
  const records: ArbitrationRecord[] = []
  for (const line of raw.split('\n')) {
    if (line === '') continue
    try {
      const value = JSON.parse(line) as Partial<ArbitrationRecord>
      if (value && value.v === 3
        && (value.op === 'claim' || value.op === 'release' || value.op === 'evict')
        && typeof value.nonce === 'string' && value.nonce.length === 32
        && typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 0
        && typeof value.hostname === 'string' && typeof value.created_at_epoch_ms === 'number'
        && (value.prev === null || typeof value.prev === 'string')) {
        records.push(value as ArbitrationRecord)
      }
    } catch { /* torn line: never took effect, skip */ }
  }
  return records
}

/**
 * Deterministic replay (docs/WRITER_LOCK_PROTOCOL.md Revision 3.1). A claim
 * is effective ONLY when the slot is empty: a claim recorded while another
 * holder is current (e.g. one whose barrier was stolen on a stale legacy
 * observation) is stored but INEFFECTIVE, and the claimant exits on its
 * read-back. Release/evict take effect only for the current holder nonce.
 */
function replayHolder(records: readonly ArbitrationRecord[]): ArbitrationHolder | null {
  let holder: ArbitrationHolder | null = null
  for (const record of records) {
    const isHolder = holder !== null && holder.nonce === record.prev
    if (record.op === 'claim') {
      if (holder === null) holder = { nonce: record.nonce, pid: record.pid, hostname: record.hostname, created_at_epoch_ms: record.created_at_epoch_ms }
    } else if (record.op === 'release' || record.op === 'evict') {
      if (isHolder) holder = null
    }
  }
  return holder
}

function readHolder(root: string): ArbitrationHolder | null {
  return replayHolder(parseArbitration(root))
}

/** Only ESRCH proves a recorded owner is gone; any other answer refuses. */
function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function unlinkIfExists(path: string): void {
  try { unlinkSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function appendArbitration(root: string, record: ArbitrationRecord): void {
  // Line alignment: if the log's last line is torn (no trailing newline — a
  // previous writer crashed mid-append), prepend a newline so this record
  // starts on its own line and stays visible to the replay. The check can
  // only race another crash-torn tail; a misaligned record is then skipped by
  // every replay and its writer exits fail-closed on the read-back — it can
  // never revoke the active holder or admit two holders (no truncation).
  let needsNewline = false
  try {
    const raw = readFileSync(arbitrationPath(root), 'utf8')
    needsNewline = raw.length > 0 && !raw.endsWith('\n')
  } catch { needsNewline = false }
  const fd = openRegular(arbitrationPath(root), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o600)
  try { writeAll(fd, `${needsNewline ? '\n' : ''}${canonical(record)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
}

/** Classification shared by diagnostics: structured v2 records classify by pid; anything else is unknown. */
function classifyLegacy(record: WriterLockRecord | 'legacy' | undefined): WriterLockState | undefined {
  if (record === undefined) return undefined
  if (record === 'legacy') return 'unknown_owner'
  if (record.hostname !== hostname()) return 'unknown_owner'
  return processExists(record.pid) ? 'held' : 'abandoned_recoverable'
}

function readLegacyV2(root: string): WriterLockRecord | 'legacy' | undefined {
  let raw: string
  try { raw = readFileSync(legacyV2Path(root), 'utf8') } catch { return undefined }
  if (!raw.trim()) return 'legacy'
  try {
    const value = JSON.parse(raw) as Partial<WriterLockRecord>
    if (value && (value.version === 2 || value.version === 3)
      && typeof value.nonce === 'string' && (value.nonce.length === 32 || value.version === 2)
      && typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 0
      && typeof value.hostname === 'string' && typeof value.created_at_epoch_ms === 'number') return value as WriterLockRecord
  } catch { /* unparsable */ }
  return 'legacy'
}

/** Read-only diagnostics: the arbitration holder, else the v2 upgrade barrier. */
export function writerLockState(root: string): WriterLockState {
  const holder = readHolder(root)
  if (holder !== null) {
    if (holder.hostname !== hostname()) return 'unknown_owner'
    return processExists(holder.pid) ? 'held' : 'abandoned_recoverable'
  }
  return classifyLegacy(readLegacyV2(root)) ?? 'absent'
}

/** Test/ops helper: the arbitration log file (undefined when no log exists). */
export function currentWriterLockFile(root: string): string | undefined {
  return existsSync(arbitrationPath(root)) ? arbitrationPath(root) : undefined
}

function pendingPath(root: string, nonce: string): string {
  return join(root, `${PENDING_PREFIX}${nonce}.json`)
}

function removeOwnPending(root: string, nonce: string): void {
  unlinkIfExists(pendingPath(root, nonce))
}

function readRecord(path: string): WriterLockRecord | 'legacy' | undefined {
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch { return undefined }
  if (!raw.trim()) return 'legacy'
  try {
    const value = JSON.parse(raw) as Partial<WriterLockRecord>
    if (value && (value.version === 2 || value.version === 3)
      && typeof value.nonce === 'string' && (value.nonce.length === 32 || value.version === 2)
      && typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 0
      && typeof value.hostname === 'string' && typeof value.created_at_epoch_ms === 'number') return value as WriterLockRecord
  } catch { /* unparsable record */ }
  return 'legacy'
}

function recordIsProvablyDead(record: WriterLockRecord): boolean {
  return record.hostname === hostname() && !processExists(record.pid)
}

/** Append one arbitration record (the ONLY mutation of the log). */
function appendLog(root: string, op: ArbitrationRecord['op'], nonce: string, prev: string | null): void {
  appendArbitration(root, {
    v: 3, op, nonce, prev,
    pid: process.pid, hostname: hostname(), created_at_epoch_ms: Date.now(),
  })
}

/**
 * Acquire the writer lock. Returns the held nonce, or undefined when refused
 * (live/unknown holder, v2 barrier, or a lost optimistic claim).
 */
/**
 * Admission (Revision 3.1 + 3.2). The v2-compat barrier is PUBLISHED
 * atomically: the writer prepares `pending.<nonce>` with its complete owner
 * record (write + fsync) and hard-links it to `.writer.lock` — the barrier
 * therefore never exists with empty or partial content from this protocol
 * (S2 closed: a crash before the link leaves only an inert pending file, and
 * a crash after it leaves a complete record naming a provably dead owner,
 * both recoverable). A barrier left by a crashed V2 WRITER (empty, partial,
 * or complete-with-dead-pid) is classified separately: unknown owners refuse
 * with the documented manual migration; a complete same-host record whose
 * pid answers ESRCH is ADOPTED untouched. The log claim is effective only on
 * an empty slot and is verified by read-back.
 */
function acquireWriterLock(root: string): HeldLock | undefined {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    // 0. Garbage-collect pending files whose creator is provably dead
    // (by-name, identity-safe; live creators and unparseable files are left).
    gcPendingFiles(root)
    // 1. Legacy barrier classification. Refuse on unknown/anonymous/foreign/
    // live owners; ADOPT a complete same-host record whose pid is provably
    // dead (the file keeps blocking v2 writers and stays for the documented
    // manual migration).
    let barrierState: 'absent' | 'adopted' | 'live' | 'unknown' = 'absent'
    const legacy = readLegacyV2(root)
    if (legacy !== undefined) {
      if (legacy === 'legacy') barrierState = 'unknown'
      else if (legacy.hostname !== hostname()) barrierState = 'unknown'
      else if (processExists(legacy.pid)) barrierState = 'live'
      else barrierState = 'adopted'
    }
    if (barrierState === 'unknown' || barrierState === 'live') return undefined
    // 2. Log holder liveness. Refuse live/foreign; evict provably dead.
    const observed = readHolder(root)
    if (observed !== null) {
      if (observed.hostname !== hostname()) return undefined
      if (!processExists(observed.pid)) {
        appendLog(root, 'evict', randomBytes(16).toString('hex'), observed.nonce)
        continue // the holder is now empty; re-classify and claim
      }
      return undefined
    }
    // 3. Claim on the empty slot. An adopted dead barrier file already blocks
    // v2 writers for our tenure; otherwise publish ours atomically.
    const nonce = randomBytes(16).toString('hex')
    let ownedBarrier = false
    if (barrierState === 'absent') {
      if (!publishBarrier(root, nonce)) continue // lost a publish race; re-classify
      ownedBarrier = true
    }
    appendLog(root, 'claim', nonce, null)
    const holder = readHolder(root)
    if (holder !== null && holder.nonce === nonce) {
      // Bounded growth inside the tenure (Revision 3.1, correction 4).
      compactLogInTenure(root, { nonce, ownedBarrier })
      return { nonce, ownedBarrier }
    }
    // Lost or ineffective: exit fail-closed. Remove only state this actor
    // created itself: a published barrier carries our nonce (checked), and
    // our pending file is removed by name; an adopted dead file stays.
    if (ownedBarrier) {
      const barrier = readLegacyV2(root)
      if (barrier !== undefined && barrier !== 'legacy' && barrier.nonce === nonce) {
        unlinkIfExists(legacyV2Path(root))
      }
    }
    unlinkIfExists(pendingPath(root, nonce))
    return undefined
  }
  return undefined
}

/**
 * Publish the v2-compat barrier atomically (Revision 3.2): write the complete
 * owner record to a unique pending file (O_EXCL + fsync), then hard-link it
 * onto the barrier pathname. link() succeeds only when the barrier is absent,
 * and the linked content is the fully written record — the barrier can never
 * be observed empty or partial from this protocol. Returns false when the
 * barrier exists (caller re-classifies).
 */
function publishBarrier(root: string, nonce: string): boolean {
  const pending = pendingPath(root, nonce)
  let fd: number
  try {
    fd = openRegular(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  try {
    const record: WriterLockRecord = {
      version: 2, nonce,
      pid: process.pid, hostname: hostname(), created_at_epoch_ms: Date.now(),
    }
    writeAll(fd, `${canonical(record)}\n`)
    fsyncSync(fd)
  } finally {
    try { closeSync(fd) } catch { /* already closed */ }
  }
  try {
    linkSync(pending, legacyV2Path(root))
    return true
  } catch (error) {
    unlinkIfExists(pending)
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

/** GC pending files whose embedded creator is provably dead (by name). */
function gcPendingFiles(root: string): void {
  let entries: string[]
  try { entries = readdirSync(root) } catch { return }
  for (const entry of entries) {
    if (!entry.startsWith(PENDING_PREFIX)) continue
    const record = readRecord(join(root, entry))
    if (record !== undefined && record !== 'legacy' && recordIsProvablyDead(record)) {
      unlinkIfExists(join(root, entry))
    }
  }
}

/**
 * Release (Revision 3.1): append the release record, then remove ONLY a
 * barrier this writer created in its own critical section (nonce-conditional).
 * An ADOPTED legacy barrier is left untouched — it keeps blocking v2 writers
 * until the documented manual migration removes it, and every later v3
 * admission re-adopts it.
 */
function releaseWriterLock(root: string, held: HeldLock | undefined): void {
  if (held === undefined) return
  appendLog(root, 'release', held.nonce, held.nonce)
  if (held.ownedBarrier) {
    const barrier = readLegacyV2(root)
    if (barrier !== undefined && barrier !== 'legacy' && barrier.nonce === held.nonce) {
      unlinkIfExists(legacyV2Path(root))
    }
  }
  removeOwnPending(root, held.nonce)
}

/** Compaction threshold; test-overridable via the internals hook. */
let compactionRecordThreshold = LOG_COMPACTION_RECORDS

/**
 * Compaction (Revision 3.1, correction 4): performed ONLY by the current
 * holder inside its verified critical section. During a live holder's tenure
 * no concurrent record can be effective (claims need an empty slot; evicts
 * need a dead holder), so the rename window cannot drop an effective record:
 * the baseline re-installs the holder, and readers see the old or the new
 * file, both replaying to the same holder. State-equivalence is asserted by
 * the lock tests.
 */
function compactLogInTenure(root: string, held: HeldLock): void {
  const records = parseArbitration(root)
  if (records.length <= compactionRecordThreshold) return
  const baseline: ArbitrationRecord = {
    v: 3, op: 'claim', nonce: held.nonce,
    pid: process.pid, hostname: hostname(), created_at_epoch_ms: Date.now(), prev: null,
  }
  const tmp = join(root, `${ARBITRATION_NAME}.compact`)
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600)
  try { writeAll(fd, `${canonical(baseline)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
  try { renameSync(tmp, arbitrationPath(root)) } catch { /* best effort; log stays oversized */ }
}

/**
 * Test-only deterministic-interleaving hooks (Revision 3 test obligations).
 * Expose the arbitration steps so tests can pause a real process between its
 * observation and its append WITHOUT reimplementing the protocol.
 */
export const __writerLockInternals = {
  readHolder: (root: string): ArbitrationHolder | null => readHolder(root),
  /** L4.3 fixture: run the same compaction the acquire path runs, mid-tenure. */
  compactInTenure: (root: string, held: HeldLock): void => compactLogInTenure(root, held),
  setCompactionThreshold: (n: number): void => { compactionRecordThreshold = n },
  /** Observe + append one evict with the observed holder as prev. */
  delayedEvict: (root: string, observed: ArbitrationHolder): void => {
    appendLog(root, 'evict', randomBytes(16).toString('hex'), observed.nonce)
  },
  acquire: (root: string): HeldLock | undefined => acquireWriterLock(root),
  release: (root: string, held: HeldLock | undefined): void => releaseWriterLock(root, held),
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

/** Shared production lock primitive; storage consumers keep independent schemas. */
export function withPrivateWriterLock<T>(root: string, operation: () => T): T {
  ensureRoot(root)
  const lock = acquireWriterLock(root)
  if (!lock) throw new Error('activation_writer_unavailable')
  try { return operation() } finally { releaseWriterLock(root, lock) }
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
