import { closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from 'node:fs'
import { join, resolve } from 'node:path'
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
const rootLockPath = (root: string): string => join(root, '.writer.lock')

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

export function readPrivateLedger(root: string | undefined, input: PrivateLedgerContext | string): PrivateLedgerSnapshot {
  if (!root) return { records: [], damaged: true, anchored: false }
  try {
    const context = normalizeContext(input)
    if (!existsSync(root)) return { records: [], damaged: false, anchored: false }
    const rootStat = lstatSync(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { records: [], damaged: true, anchored: false }
    const session = sessionDigest(context.sessionId); const expectedContext = contextDigest(context, root); const anchored = readAnchors(root).get(session)
    if (anchored !== undefined && anchored !== expectedContext) return { records: [], damaged: true, anchored: true }
    const path = ledgerPath(root, context)
    if (!existsSync(path)) return { records: [], damaged: anchored !== undefined, anchored: anchored !== undefined }
    if (anchored === undefined) return { records: [], damaged: true, anchored: false }
    const fd = openRegular(path, constants.O_RDONLY); let raw: string
    try { raw = readFileSync(fd, 'utf8') } finally { closeSync(fd) }
    if (raw && !raw.endsWith('\n')) return { records: [], damaged: true, anchored: true }
    const records: PrivateLedgerRecord[] = []; let prior: string | null = null
    for (const [index, line] of raw.split('\n').filter(Boolean).entries()) {
      const value = JSON.parse(line) as PrivateLedgerRecord; const { record_sha256, ...unsigned } = value
      if (value.version !== 1 || value.session_sha256 !== session || value.context_sha256 !== expectedContext || value.position !== index + 1 || value.prior_sha256 !== prior || !['release_reservation','release_settlement','restart_intent'].includes(value.kind) || !value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload) || record_sha256 !== digestRecord(unsigned)) return { records: [], damaged: true, anchored: true }
      records.push(value); prior = record_sha256
    }
    return { records, damaged: false, anchored: true }
  } catch { return { records: [], damaged: true, anchored: false } }
}

/** Establish the provider-invisible anchor when a live runtime observes a new adoption. */
export function initializePrivateLedger(root: string | undefined, input: PrivateLedgerContext | string): boolean {
  if (!root) return false
  let lockFd: number | undefined
  try {
    const context = normalizeContext(input); ensureRoot(root)
    lockFd = openRegular(rootLockPath(root), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)
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
    if (lockFd !== undefined) { try { closeSync(lockFd) } catch {}; try { unlinkSync(rootLockPath(root)) } catch {} }
  }
}

export function appendPrivateLedger(root: string | undefined, input: PrivateLedgerContext | string, kind: PrivateLedgerKind, payload: Record<string, unknown>): boolean {
  if (!root) return false
  let lockFd: number | undefined
  try {
    const context = normalizeContext(input)
    ensureRoot(root)
    lockFd = openRegular(rootLockPath(root), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)
    const session = sessionDigest(context.sessionId); const expectedContext = contextDigest(context, root); const anchors = readAnchors(root); const anchored = anchors.get(session)
    if (anchored !== undefined && anchored !== expectedContext) return false
    const snapshot = anchored === undefined ? { records: [], damaged: false } : readPrivateLedger(root, context)
    if (snapshot.damaged) return false
    if (anchored === undefined) {
      const unsignedAnchor = { version: 1, session_sha256: session, context_sha256: expectedContext }
      const fd = openRegular(anchorPath(root), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND)
      try { writeAll(fd, `${canonical({ ...unsignedAnchor, anchor_sha256: sha256(canonical(unsignedAnchor)) })}\n`); fsyncSync(fd) } finally { closeSync(fd) }
      syncDirectory(root)
    }
    if (kind === 'release_settlement') {
      const settlement = normalizeSettlement(payload)
      const reservation = settlement && [...snapshot.records].reverse().find((record) => record.kind === 'release_reservation' && record.payload.contractId === settlement.contractId && record.payload.operation === settlement.operation && record.payload.callId === settlement.callId)
      if (!reservation) return false
      payload = { ...payload, reservation_sha256: reservation.record_sha256, contract_sha256: reservation.payload.contract_sha256, target_sha256: reservation.payload.target_sha256 }
    }
    const unsigned: Omit<PrivateLedgerRecord, 'record_sha256'> = { version: 1, session_sha256: session, context_sha256: expectedContext, position: snapshot.records.length + 1, prior_sha256: snapshot.records.at(-1)?.record_sha256 ?? null, kind, payload }
    const record: PrivateLedgerRecord = { ...unsigned, record_sha256: digestRecord(unsigned) }
    const fd = openRegular(ledgerPath(root, context), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND)
    try { writeAll(fd, `${canonical(record)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
    syncDirectory(root)
    return true
  } catch { return false } finally {
    if (lockFd !== undefined) { try { closeSync(lockFd) } catch {}; try { unlinkSync(rootLockPath(root)) } catch {} }
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
