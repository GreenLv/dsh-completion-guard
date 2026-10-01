import { closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeSync } from 'node:fs'
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
 * CG-083-BUG01/R2/F1: generation-protocol writer lock. See
 * docs/WRITER_LOCK_PROTOCOL.md for the state machine and linearization
 * argument. Summary: the active generation is the highest-numbered
 * `gen-NNNNNNNN` directory; the lock file lives INSIDE it; recovery of a
 * provably dead lock creates the NEXT generation (atomic mkdir) and never
 * renames or unlinks any file another actor created; a writer verifies the
 * generation is still current AFTER acquiring and retries through the
 * next generation otherwise; release unlinks only the actor's own
 * nonce-verified file. Only ESRCH proves a recorded owner is gone; any other
 * liveness answer refuses fail-closed (PID reuse included).
 */
const WRITER_LOCK_VERSION = 3
const WRITER_LOCK_NAME = '.writer.lock'
const GENERATION_DIGITS = 8
interface WriterLockRecord { version: 3; nonce: string; pid: number; hostname: string; created_at_epoch_ms: number }
interface HeldLock { dir: string; nonce: string }

export type WriterLockState = 'absent' | 'held' | 'abandoned_recoverable' | 'unknown_owner'

/** Read-only diagnostics over the CURRENT generation's lock (CG-083-BUG01). */
export function writerLockState(root: string): WriterLockState {
  const dir = currentGeneration(root)
  if (dir === undefined) return 'absent'
  return lockStateFor(join(dir, WRITER_LOCK_NAME))
}

/** Test/ops helper: the current generation's lock file, if any generation exists. */
export function currentWriterLockFile(root: string): string | undefined {
  const dir = currentGeneration(root)
  return dir === undefined ? undefined : join(dir, WRITER_LOCK_NAME)
}

/** The active generation directory itself (test/ops helper). */
export function currentGenerationDir(root: string): string | undefined {
  return currentGeneration(root)
}

function lockStateFor(path: string): WriterLockState {
  let size: number | undefined
  try { size = lstatSync(path).size } catch { return 'absent' }
  if (size === 0) return 'abandoned_recoverable'
  const record = readLockRecord(path)
  if (record === undefined) return 'absent'
  if (record === 'legacy') return 'unknown_owner'
  if (record.hostname !== hostname()) return 'unknown_owner'
  return processExists(record.pid) ? 'held' : 'abandoned_recoverable'
}

function readLockRecord(path: string): WriterLockRecord | 'legacy' | undefined {
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch { return undefined }
  if (!raw.trim()) return 'legacy'
  try {
    const value = JSON.parse(raw) as Partial<WriterLockRecord>
    if (value && value.version === WRITER_LOCK_VERSION && typeof value.nonce === 'string' && value.nonce.length === 32
      && typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 0
      && typeof value.hostname === 'string' && typeof value.created_at_epoch_ms === 'number') return value as WriterLockRecord
  } catch { /* unparsable record */ }
  return 'legacy'
}

/** Only ESRCH proves the recorded owner is gone; any other answer refuses. */
function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * The lock is safe to recover: a provably dead recorded owner, or a
 * ZERO-LENGTH file — the creator died between O_EXCL creation and its owner
 * record. A live acquirer never enters its critical section before the
 * post-acquire generation verification, so recovering a mid-write file can
 * at worst make that acquirer release its own file and retry in the next
 * generation (docs/WRITER_LOCK_PROTOCOL.md §3).
 */
function lockIsRecoverable(path: string): boolean {
  let size: number | undefined
  try { size = lstatSync(path).size } catch { return false }
  if (size === 0) return true
  const record = readLockRecord(path)
  return record !== undefined && record !== 'legacy'
    && record.hostname === hostname() && !processExists(record.pid)
}

/** The active generation directory: the highest-numbered gen-NNNNNNNN. */
function currentGeneration(root: string): string | undefined {
  let best: { n: number; dir: string } | undefined
  let entries: string[]
  try { entries = readdirSync(root) } catch { return undefined }
  for (const entry of entries) {
    if (!entry.startsWith('gen-') || entry.length !== 4 + GENERATION_DIGITS) continue
    const n = Number.parseInt(entry.slice(4), 10)
    if (!Number.isSafeInteger(n) || n < 0) continue
    if (best === undefined || n > best.n) best = { n, dir: join(root, entry) }
  }
  return best?.dir
}

function nextGenerationDir(root: string): { dir: string; created: boolean } {
  const current = currentGeneration(root)
  const nextN = (current === undefined ? 0
    : Number.parseInt(current.slice(current.lastIndexOf('gen-') + 4), 10)) + 1
  const dir = join(root, `gen-${String(nextN).padStart(GENERATION_DIGITS, '0')}`)
  try {
    mkdirSync(dir, { mode: 0o700 })
    return { dir, created: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { dir, created: false }
    throw error
  }
}

function firstGenerationDir(root: string): { dir: string; created: boolean } {
  const dir = join(root, `gen-${'0'.repeat(GENERATION_DIGITS - 1)}1`)
  try {
    mkdirSync(dir, { mode: 0o700 })
    return { dir, created: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { dir, created: false }
    throw error
  }
}

/** Unlink the actor's OWN lock file: only when the content still carries its nonce. */
function releaseOwnLock(dir: string, nonce: string): void {
  const path = join(dir, WRITER_LOCK_NAME)
  const record = readLockRecord(path)
  if (record !== 'legacy' && record !== undefined && record.nonce === nonce) {
    try { unlinkSync(path) } catch { /* best effort */ }
  }
}

/**
 * Acquire the writer lock under the generation protocol. Returns the held
 * lock, or undefined when acquisition is refused (live/unknown owner in the
 * current generation). See docs/WRITER_LOCK_PROTOCOL.md §3.
 */
function acquireWriterLock(root: string): HeldLock | undefined {
  let dir = currentGeneration(root)
  if (dir === undefined) dir = firstGenerationDir(root).created
    ? join(root, `gen-${'0'.repeat(GENERATION_DIGITS - 1)}1`)
    : currentGeneration(root)!
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let fd: number
    try {
      fd = openRegular(join(dir, WRITER_LOCK_NAME), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (lockIsRecoverable(join(dir, WRITER_LOCK_NAME))) {
        // R: advance the generation. mkdir is the whole recovery; the dead
        // file is abandoned, never renamed or unlinked. Losing the creation
        // race is fine — the winner's generation becomes current for all.
        dir = nextGenerationDir(root).dir
        continue
      }
      return undefined
    }
    const nonce = randomBytes(16).toString('hex')
    try {
      const record: WriterLockRecord = {
        version: WRITER_LOCK_VERSION,
        nonce,
        pid: process.pid,
        hostname: hostname(),
        created_at_epoch_ms: Date.now(),
      }
      writeAll(fd, `${canonical(record)}\n`)
      fsyncSync(fd)
    } catch (error) {
      // Our own O_EXCL-created file failed to record: remove it. No other
      // actor can have replaced it (nothing in the protocol replaces foreign
      // files), so this unlink targets only what this actor created.
      try { unlinkSync(join(dir, WRITER_LOCK_NAME)) } catch { /* best effort */ }
      throw error
    } finally {
      try { closeSync(fd) } catch { /* already closed */ }
    }
    // V: the generation must still be current AFTER our acquire. A recovery
    // that advanced past G could only have observed our lock as dead, which
    // it is not while we hold it, so this re-read settles the linearization.
    const current = currentGeneration(root)
    if (current === dir) return { dir, nonce }
    releaseOwnLock(dir, nonce)
    dir = current ?? nextGenerationDir(root).dir
  }
  return undefined
}

function releaseWriterLock(root: string, held: HeldLock | undefined): void {
  if (held === undefined) return
  void root
  releaseOwnLock(held.dir, held.nonce)
}

/**
 * CG-083-PERF05 (F1 revision): prune abandoned generation directories. Only
 * the holder of the CURRENT generation's lock may prune, and only strictly
 * older generations — by docs/WRITER_LOCK_PROTOCOL.md §5 no non-current
 * generation can contain a live-content lock, so pruning cannot evict an
 * active writer. Bounded garbage per crash instead of unbounded growth.
 */
function pruneGenerations(root: string, held: HeldLock): void {
  const current = currentGeneration(root)
  if (current === undefined || current !== held.dir) return
  const currentN = Number.parseInt(current.slice(current.lastIndexOf('gen-') + 4), 10)
  let entries: string[]
  try { entries = readdirSync(root) } catch { return }
  for (const entry of entries) {
    if (!entry.startsWith('gen-') || entry.length !== 4 + GENERATION_DIGITS) continue
    const n = Number.parseInt(entry.slice(4), 10)
    if (!Number.isSafeInteger(n) || n < 0 || n >= currentN) continue
    try { rmSync(join(root, entry), { recursive: true, force: true }) } catch { /* best effort */ }
  }
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
    // Bounded garbage: while holding the CURRENT generation's lock, abandon
    // strictly older generations (docs/WRITER_LOCK_PROTOCOL.md §5).
    if (lockFd !== undefined) pruneGenerations(root, lockFd)
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
