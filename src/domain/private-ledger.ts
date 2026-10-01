import { closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs'
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
 * CG-083-BUG01/R2: the writer lock carries an owner identity instead of being
 * an anonymous O_EXCL file. A crashed writer used to leave a lock that
 * blocked every later append and initialize forever. A lock whose owner is
 * PROVABLY dead (same host, recorded pid answers ESRCH) is recovered by
 * ATOMICALLY RENAMING the dead owner's file out of the lock pathname — never
 * by unlinking the pathname, which could delete a live writer's fresh lock.
 * While the dead file still occupies the pathname no one can create a new
 * lock (O_EXCL fails), so the file moved by the rename is exactly the one
 * that was verified; after the rename the pathname is free and acquirers
 * race fairly through O_EXCL. Recovery of the writer lock is serialized by a
 * recovery lock with the same owner protocol, so two recoverers can never
 * both act; the recovery lock's own dead-owner file is renamed out the same
 * way, so a crash inside a recovery cannot wedge the ledger permanently. An
 * unknown owner — a legacy empty lock from an older version, a foreign host,
 * a live pid, or an unparsable record — keeps the fail-closed refusal with
 * the observed state available through {@link writerLockState}; the supported
 * manual recovery for such a lock is removing the named lock file, which
 * carries no ledger data.
 */
const WRITER_LOCK_VERSION = 2
const WRITER_LOCK_NAME = '.writer.lock'
const RECOVERY_LOCK_NAME = '.writer.lock.recovery'
const STALE_LOCK_SUFFIX = '.stale'
interface WriterLockRecord { version: 2; nonce: string; pid: number; hostname: string; created_at_epoch_ms: number }
interface HeldLock { fd: number; nonce: string }

export type WriterLockState = 'absent' | 'held' | 'abandoned_recoverable' | 'unknown_owner'

/** Read-only diagnostics for a lock that blocks acquisition (CG-083-BUG01). */
export function writerLockState(root: string): WriterLockState {
  return lockStateFor(join(root, WRITER_LOCK_NAME))
}

function lockStateFor(path: string): WriterLockState {
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

function provablyDeadOwner(path: string): boolean {
  const record = readLockRecord(path)
  return record !== undefined && record !== 'legacy'
    && record.hostname === hostname() && !processExists(record.pid)
}

/**
 * One named owner-identified lock file. `serialized` marks that stale
 * recovery must run under the recovery lock (the writer lock); the recovery
 * lock itself recovers its own dead owner directly, because only recovery
 * participants ever contend for it and their critical section is bounded.
 */
class OwnerFileLock {
  constructor(private readonly root: string, private readonly name: string, private readonly serialized: boolean) {}

  private get path(): string { return join(this.root, this.name) }
  private get stalePath(): string { return join(this.root, `${this.name}${STALE_LOCK_SUFFIX}`) }

  acquire(): HeldLock | undefined {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let fd: number
      try {
        fd = openRegular(this.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (!this.recoverStale()) return undefined
        continue
      }
      try {
        const nonce = randomBytes(16).toString('hex')
        const record: WriterLockRecord = {
          version: WRITER_LOCK_VERSION,
          nonce,
          pid: process.pid,
          hostname: hostname(),
          created_at_epoch_ms: Date.now(),
        }
        writeAll(fd, `${canonical(record)}\n`)
        fsyncSync(fd)
        return { fd, nonce }
      } catch (error) {
        // The lock could not be recorded: leave nothing at the pathname.
        try { closeSync(fd) } catch { /* already closed */ }
        try { unlinkSync(this.path) } catch { /* best effort */ }
        throw error
      }
    }
    return undefined
  }

  /** Move a provably dead owner's file out of the pathname atomically. */
  private recoverStale(): boolean {
    if (!provablyDeadOwner(this.path)) return false
    if (!this.serialized) return this.renameStaleOut()
    const recovery = new OwnerFileLock(this.root, RECOVERY_LOCK_NAME, false)
    const held = recovery.acquire()
    if (!held) return false
    // Release the RECOVERY lock itself (the writer-lock pathname currently
    // holds nothing: the dead owner's file has been renamed away).
    try { return this.renameStaleOut() } finally { recovery.release(held) }
  }

  private renameStaleOut(): boolean {
    // Re-verify under serialization, then RENAME. rename(2) is atomic and
    // moves the exact verified file; the pathname becomes free for the fair
    // O_EXCL race and no later acquisition can be evicted by us.
    if (!provablyDeadOwner(this.path)) return false
    try { renameSync(this.path, this.stalePath); return true } catch (error) {
      // ENOENT: another serialized recoverer already moved it.
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
    }
  }

  /** Conditional release: only the file that still carries OUR nonce. */
  release(held: HeldLock): void {
    try { closeSync(held.fd) } catch { /* already closed */ }
    let current: WriterLockRecord | 'legacy' | undefined
    try { current = readLockRecord(this.path) } catch { return }
    if (current !== 'legacy' && current !== undefined && current.nonce === held.nonce) {
      try { unlinkSync(this.path) } catch { /* best effort */ }
    }
  }
}

function acquireWriterLock(root: string): HeldLock | undefined {
  return new OwnerFileLock(root, WRITER_LOCK_NAME, true).acquire()
}

function releaseWriterLock(root: string, held: HeldLock | undefined): void {
  if (held === undefined) return
  new OwnerFileLock(root, WRITER_LOCK_NAME, true).release(held)
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
