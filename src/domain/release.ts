import { sha256 } from './canonicalize.js'
import type { GuardProjection, TargetTuple } from './types.js'

/**
 * Explicit release adoption and single-use tickets (0.6.0 C10 / DS06-F).
 *
 * A release is never implicit. "release", a loaded Skill, or an installation
 * never activates this profile: a root user must explicitly ADOPT a release
 * contract that names the exact candidate, and every effect must then match
 * that contract and spend a one-shot reservation.
 *
 * Three durable records carry the state machine (P0 §5), all written through
 * the plugin-notice channel the host already persists:
 *
 * - `contract`    — the adopted scope: operations, the exact candidate, the
 *                   readiness/closure references and an optional expiry.
 * - `reservation` — written BEFORE any effect; the operation is `in_flight`
 *                   from that moment, so a crash cannot be mistaken for "never
 *                   started" and the operation is never blindly re-sent.
 * - `settlement`  — written after the effect. Its outcome distinguishes a
 *                   PROVEN no-effect (`not_effected`, which releases the lock)
 *                   from an UNKNOWN effect (`unknown`/`failed`/`unconfirmed`,
 *                   which keeps the lock until a trusted readback reconciles
 *                   it) and from a `settled` release.
 *
 * CANDIDATE IDENTITY IS TYPED, NOT CONFLATED. A release artifact has several
 * genuinely different identities — the commit it was built from, the SHA-256 of
 * the exact bytes, npm's SHA-512 SRI, the package name, the version, the
 * repository, the ref and the target registry. Each is a separate field and is
 * compared with its own observed value read from a trusted producer. Comparing,
 * say, a 64-hex SHA-256 against an SRI can never succeed, so a legitimate
 * release would have been permanently refused; and accepting a model-supplied
 * SHA instead of the artifact's embedded one would bind nothing. Every field
 * the contract declares must be OBSERVED, so omitting evidence is a refusal,
 * never a bypass.
 *
 * COVERAGE SURFACE (frozen wording): only the surfaces Guard itself routes can
 * be protected. Operations with no Guard execution surface are refused before
 * any effect, and the plugin never suggests falling back to a plain shell
 * command. A trusted in-process caller that bypasses Guard entirely is a host
 * trust boundary and is disclosed as such in the documentation, not pretended
 * away.
 */

export const RELEASE_CONTRACT_PREFIX = 'Context Guard release contract v1: '
export const RELEASE_RESERVATION_PREFIX = 'Context Guard release reservation v1: '
export const RELEASE_SETTLEMENT_PREFIX = 'Context Guard release settlement v1: '
export const RELEASE_REVOCATION_PREFIX = 'Context Guard release revocation v1: '

export const RELEASE_OPERATIONS = [
  'npm_publish', 'git_tag', 'github_release_create', 'github_release_update',
  'github_release_delete', 'composite_runner',
] as const
export type ReleaseOperation = (typeof RELEASE_OPERATIONS)[number]

/**
 * Where the operation would actually execute, whether Guard can protect it, and
 * an honest attribution of any gap.
 *
 * The attribution matters and is deliberately not uniform. "The host cannot be
 * intercepted" and "this release did not build the route" are different facts:
 * a missing Guard-owned route is an IMPLEMENTATION gap that a later release can
 * close, while a composite runner that resolves arbitrary work through an
 * opaque boundary is a host/boundary limitation. Presenting the first as the
 * second would misreport the remaining work, so each row says which it is.
 */
export interface ReleaseOperationSurface {
  surface: 'context_guard_action' | 'none'
  protectable: boolean
  reasonCode: 'release_operation_protectable' | 'release_operation_unrouted' | 'release_runner_opaque'
  attribution: 'implemented' | 'scope_reduction' | 'host_boundary'
}

/**
 * The routing table for this release. `git_tag` and the GitHub Release
 * operations have no Guard-owned execution route yet; the coordinator
 * explicitly approved that staged scope reduction on 2026-09-14, and the new
 * route is the way each of them becomes protectable. A composite runner stays
 * opaque by construction.
 */
export const RELEASE_OPERATION_SURFACES: Readonly<Record<ReleaseOperation, ReleaseOperationSurface>> = {
  npm_publish: { surface: 'context_guard_action', protectable: true, reasonCode: 'release_operation_protectable', attribution: 'implemented' },
  git_tag: { surface: 'none', protectable: false, reasonCode: 'release_operation_unrouted', attribution: 'scope_reduction' },
  github_release_create: { surface: 'none', protectable: false, reasonCode: 'release_operation_unrouted', attribution: 'scope_reduction' },
  github_release_update: { surface: 'none', protectable: false, reasonCode: 'release_operation_unrouted', attribution: 'scope_reduction' },
  github_release_delete: { surface: 'none', protectable: false, reasonCode: 'release_operation_unrouted', attribution: 'scope_reduction' },
  composite_runner: { surface: 'none', protectable: false, reasonCode: 'release_runner_opaque', attribution: 'host_boundary' },
}

/**
 * The candidate identity a release contract freezes. Each field names exactly
 * one measurable identity; all are optional except the full commit, because a
 * contract that names nothing cannot be checked against anything.
 */
export interface ReleaseCandidate {
  /** The commit the artifact was built from (the artifact's embedded gitHead). */
  fullSha40: string
  /** The ref that commit must be on, when the surface can observe a ref. */
  ref?: string
  /** Repository identity (owner/name or clone URL). */
  repository?: string
  /** Package or artifact name. */
  packageId?: string
  /** Exact released version. */
  version?: string
  /** SHA-256 of the exact artifact bytes (64 lowercase hex). */
  artifactSha256?: string
  /** npm integrity of the exact artifact bytes (`sha512-<base64>`). */
  artifactSri?: string
  /** The registry the artifact is published to (canonical base URL). */
  registry?: string
}

export interface ReleaseContract {
  contractId: string
  adoptedBy: { seq: number; digest: string }
  operations: ReleaseOperation[]
  candidate: ReleaseCandidate
  readinessRefs: string[]
  closureCertRef?: string
  expiresAtEpochMs?: number
  /** Durable root revocation; the record is kept for audit, never deleted. */
  revokedAtSeq?: number
}

export interface ReleaseReservation {
  contractId: string
  operation: ReleaseOperation
  callId: string
  startedAtSeq: number
  status: 'in_flight'
}

export type ReleaseOutcome = 'settled' | 'unconfirmed' | 'unknown' | 'failed' | 'not_effected'

export interface ReleaseSettlement {
  contractId: string
  operation: ReleaseOperation
  callId: string
  settledAtSeq: number
  /** A trusted readback identity, or the reason no producer exists. */
  readback: { kind: 'npm_integrity' | 'git_ref' | 'github_release'; identity: string } | 'unavailable'
  outcome: ReleaseOutcome
}

const FULL_SHA40 = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const SRI = /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/

/**
 * How strongly an outcome resolves the reservation. A `settled` release is
 * never downgraded by a later record, while a stronger record reconciles a
 * weaker one — that is how a trusted readback recovers an earlier unconfirmed
 * attempt instead of being discarded.
 */
export const OUTCOME_STRENGTH: Readonly<Record<ReleaseOutcome, number>> = {
  not_effected: 0, unknown: 1, failed: 1, unconfirmed: 2, settled: 3,
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * Normalize a candidate release contract from a root adoption payload. Every
 * field is validated: an unparsable or partial adoption is refused rather than
 * approximated, because a half-specified contract would authorize an
 * unspecified candidate.
 */
export function normalizeReleaseContract(raw: unknown, adoptedBy: { seq: number; digest: string }): { contract?: ReleaseContract; errors: string[] } {
  const errors: string[] = []
  const value = asRecord(raw)
  if (!value) return { errors: ['release_contract_malformed'] }
  const operations: ReleaseOperation[] = []
  if (!Array.isArray(value.operations) || value.operations.length === 0) errors.push('release_operations_missing')
  else {
    for (const entry of value.operations) {
      if (typeof entry !== 'string' || !(RELEASE_OPERATIONS as readonly string[]).includes(entry)) {
        errors.push('release_operation_unknown')
        continue
      }
      const operation = entry as ReleaseOperation
      if (!RELEASE_OPERATION_SURFACES[operation].protectable) {
        errors.push(RELEASE_OPERATION_SURFACES[operation].reasonCode)
        continue
      }
      if (!operations.includes(operation)) operations.push(operation)
    }
  }
  const candidate = asRecord(value.candidate)
  if (!candidate) errors.push('release_candidate_missing')
  // An unknown candidate field is refused rather than ignored: silently
  // dropping it would leave the contract bound to less than it claims while
  // still looking complete. The one legacy alias is `artifactDigest`, whose
  // KIND is decided by its own shape — a 64-hex value is a byte SHA-256 and an
  // `sha512-...` value is an npm SRI. Conflating the two is exactly the defect
  // this typed binding exists to remove, so the alias is split, never compared
  // across kinds.
  const CANDIDATE_FIELDS = ['fullSha40', 'ref', 'repository', 'packageId', 'version', 'artifactSha256', 'artifactSri', 'registry', 'artifactDigest']
  for (const key of Object.keys(candidate ?? {})) {
    if (!CANDIDATE_FIELDS.includes(key)) errors.push('release_candidate_field_unknown')
  }
  const fullSha40 = optionalString(candidate?.fullSha40) ?? ''
  if (!FULL_SHA40.test(fullSha40)) errors.push('release_candidate_sha_invalid')
  const ref = optionalString(candidate?.ref)
  const repository = optionalString(candidate?.repository)
  const packageId = optionalString(candidate?.packageId)
  const version = optionalString(candidate?.version)
  let artifactSha256 = optionalString(candidate?.artifactSha256)
  let artifactSri = optionalString(candidate?.artifactSri)
  const legacyDigest = optionalString(candidate?.artifactDigest)
  if (legacyDigest !== undefined) {
    if (SHA256.test(legacyDigest)) artifactSha256 ??= legacyDigest
    else if (SRI.test(legacyDigest)) artifactSri ??= legacyDigest
    else errors.push('release_candidate_artifact_digest_invalid')
  }
  const registry = optionalString(candidate?.registry)
  if (artifactSha256 !== undefined && !SHA256.test(artifactSha256)) errors.push('release_candidate_sha256_invalid')
  if (artifactSri !== undefined && !SRI.test(artifactSri)) errors.push('release_candidate_sri_invalid')
  const readinessRefs = Array.isArray(value.readinessRefs)
    ? value.readinessRefs.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : []
  const closureCertRef = optionalString(value.closureCertRef)
  let expiresAtEpochMs: number | undefined
  if (value.expiresAtEpochMs !== undefined) {
    if (typeof value.expiresAtEpochMs !== 'number' || !Number.isSafeInteger(value.expiresAtEpochMs) || value.expiresAtEpochMs <= 0) {
      errors.push('release_expiry_invalid')
    } else expiresAtEpochMs = value.expiresAtEpochMs
  }
  if (errors.length) return { errors: [...new Set(errors)] }
  // The contract id is an IDENTIFIER, not authority: when the adopter does not
  // supply one, it is derived deterministically from the adoption payload, so a
  // replay reproduces it exactly and two different adoptions never collide.
  const suppliedId = optionalString(value.contractId)
  const body = {
    operations: [...operations].sort(),
    candidate: {
      fullSha40,
      ...(ref ? { ref } : {}), ...(repository ? { repository } : {}), ...(packageId ? { packageId } : {}),
      ...(version ? { version } : {}), ...(artifactSha256 ? { artifactSha256 } : {}),
      ...(artifactSri ? { artifactSri } : {}), ...(registry ? { registry } : {}),
    },
    readinessRefs: [...readinessRefs].sort(),
    ...(closureCertRef ? { closureCertRef } : {}),
    ...(expiresAtEpochMs !== undefined ? { expiresAtEpochMs } : {}),
  }
  const contractId = suppliedId ?? `rel-${sha256(JSON.stringify(body)).slice(0, 16)}`
  return {
    contract: {
      contractId,
      adoptedBy,
      operations: operations.sort(),
      candidate: body.candidate,
      readinessRefs: body.readinessRefs,
      ...(closureCertRef ? { closureCertRef } : {}),
      ...(expiresAtEpochMs !== undefined ? { expiresAtEpochMs } : {}),
    },
    errors: [],
  }
}

export function normalizeReservation(raw: unknown): ReleaseReservation | undefined {
  const value = asRecord(raw)
  if (!value) return undefined
  const contractId = optionalString(value.contractId)
  const operation = optionalString(value.operation)
  const callId = optionalString(value.callId)
  const startedAtSeq = value.startedAtSeq
  if (!contractId || !callId) return undefined
  if (!operation || !(RELEASE_OPERATIONS as readonly string[]).includes(operation)) return undefined
  if (typeof startedAtSeq !== 'number' || !Number.isSafeInteger(startedAtSeq)) return undefined
  return { contractId, operation: operation as ReleaseOperation, callId, startedAtSeq, status: 'in_flight' }
}

export const RELEASE_OUTCOMES: readonly ReleaseOutcome[] = ['settled', 'unconfirmed', 'unknown', 'failed', 'not_effected']

export function normalizeSettlement(raw: unknown): ReleaseSettlement | undefined {
  const value = asRecord(raw)
  if (!value) return undefined
  const contractId = optionalString(value.contractId)
  const operation = optionalString(value.operation)
  const callId = optionalString(value.callId)
  const settledAtSeq = value.settledAtSeq
  const outcome = optionalString(value.outcome)
  if (!contractId || !callId) return undefined
  if (!operation || !(RELEASE_OPERATIONS as readonly string[]).includes(operation)) return undefined
  if (typeof settledAtSeq !== 'number' || !Number.isSafeInteger(settledAtSeq)) return undefined
  if (!outcome || !RELEASE_OUTCOMES.includes(outcome as ReleaseOutcome)) return undefined
  const readbackRaw = asRecord(value.readback)
  const kind = readbackRaw?.kind
  const readback = readbackRaw && (kind === 'npm_integrity' || kind === 'git_ref' || kind === 'github_release')
    && optionalString(readbackRaw.identity)
    ? { kind, identity: optionalString(readbackRaw.identity)! } as ReleaseSettlement['readback']
    : 'unavailable' as const
  return { contractId, operation: operation as ReleaseOperation, callId, settledAtSeq, readback, outcome: outcome as ReleaseOutcome }
}

/** The adopted, not-revoked contract that covers an operation, newest first. */
export function releaseContractFor(projection: GuardProjection, operation: ReleaseOperation, contractId?: string): ReleaseContract | undefined {
  const contracts = projection.releaseContracts.filter((contract) => (
    contract.revokedAtSeq === undefined
    && (contractId === undefined || contract.contractId === contractId)
    && contract.operations.includes(operation)
  ))
  return contracts.length ? contracts[contracts.length - 1] : undefined
}

/** Whether a contract was explicitly revoked by a durable root command. */
export function isContractRevoked(projection: GuardProjection, contractId: string): boolean {
  return projection.releaseContracts.some((contract) => contract.contractId === contractId && contract.revokedAtSeq !== undefined)
}

/**
 * The reconciled settlement per (contract, operation, callId): the strongest
 * outcome wins, ties resolve to the later record. A `settled` release is never
 * revoked by a later weaker record.
 */
function reconciledSettlements(projection: GuardProjection, contractId: string, operation: ReleaseOperation): ReleaseSettlement[] {
  const byCall = new Map<string, ReleaseSettlement>()
  for (const settlement of projection.releaseSettlements) {
    if (settlement.contractId !== contractId || settlement.operation !== operation) continue
    const existing = byCall.get(settlement.callId)
    if (!existing) { byCall.set(settlement.callId, settlement); continue }
    const stronger = OUTCOME_STRENGTH[settlement.outcome] > OUTCOME_STRENGTH[existing.outcome]
    const newer = OUTCOME_STRENGTH[settlement.outcome] === OUTCOME_STRENGTH[existing.outcome]
      && settlement.settledAtSeq >= existing.settledAtSeq
    if (stronger || newer) byCall.set(settlement.callId, settlement)
  }
  return [...byCall.values()]
}

/** Whether a settlement releases the one-shot lock: settled, or proven no-effect. */
function releasesLock(settlement: ReleaseSettlement): boolean {
  return settlement.outcome === 'settled' || settlement.outcome === 'not_effected'
}

/** The in-flight (unresolved) reservation for one contract operation, if any. */
export function inFlightReservation(projection: GuardProjection, contractId: string, operation: ReleaseOperation): ReleaseReservation | undefined {
  const settled = reconciledSettlements(projection, contractId, operation)
  for (const reservation of projection.releaseReservations) {
    if (reservation.contractId !== contractId || reservation.operation !== operation) continue
    const resolution = settled.find((settlement) => settlement.callId === reservation.callId)
    if (!resolution || !releasesLock(resolution)) return reservation
  }
  return undefined
}

/** Whether a contract operation has already been consumed by a settled effect. */
export function settledOperations(projection: GuardProjection, contractId: string): ReleaseOperation[] {
  const consumed: ReleaseOperation[] = []
  for (const settlement of projection.releaseSettlements) {
    if (settlement.contractId !== contractId) continue
    if (settlement.outcome !== 'settled') continue
    if (!consumed.includes(settlement.operation)) consumed.push(settlement.operation)
  }
  return consumed.sort()
}

/**
 * The identity a trusted producer observed for the candidate. Every field is
 * optional because a given surface can observe only some of them; a field the
 * contract declares but the producer does not observe is a refusal, never a
 * silent pass.
 */
export interface ReleaseObservedIdentity {
  fullSha40?: string
  ref?: string
  repository?: string
  packageId?: string
  version?: string
  artifactSha256?: string
  artifactSri?: string
  registry?: string
}

export interface ReleaseGateRequest {
  operation: ReleaseOperation
  /** What the trusted producer read. Never a model-supplied assertion. */
  observed: ReleaseObservedIdentity
  /** Identity named in the resolved target, when the operation has one. */
  resolvedTarget?: TargetTuple
  /** Wall-clock milliseconds; absent means expiry cannot be evaluated. */
  nowEpochMs?: number
  /** An explicit contract id the caller believes it is using. */
  contractId?: string
}

export interface ReleaseGateDecision {
  status: 'granted' | 'denied'
  reasonCode: string
  contractId?: string
}

/** One declared field, its observed counterpart, and the refusal when it differs. */
interface FieldComparison {
  field: keyof ReleaseObservedIdentity
  label: string
  unresolvedCode: string
  mismatchCode: string
}

const CANDIDATE_FIELD_CODES: readonly FieldComparison[] = [
  { field: 'fullSha40', label: 'commit', unresolvedCode: 'release_candidate_sha_unresolved', mismatchCode: 'release_candidate_sha_mismatch' },
  { field: 'ref', label: 'ref', unresolvedCode: 'release_candidate_ref_unresolved', mismatchCode: 'release_candidate_ref_mismatch' },
  { field: 'repository', label: 'repository', unresolvedCode: 'release_candidate_repository_unresolved', mismatchCode: 'release_candidate_repository_mismatch' },
  { field: 'packageId', label: 'package', unresolvedCode: 'release_candidate_package_unresolved', mismatchCode: 'release_candidate_package_mismatch' },
  { field: 'version', label: 'version', unresolvedCode: 'release_candidate_version_unresolved', mismatchCode: 'release_candidate_version_mismatch' },
  { field: 'artifactSha256', label: 'artifact SHA-256', unresolvedCode: 'release_artifact_sha256_unresolved', mismatchCode: 'release_candidate_artifact_mismatch' },
  { field: 'artifactSri', label: 'artifact SRI', unresolvedCode: 'release_artifact_sri_unresolved', mismatchCode: 'release_candidate_artifact_sri_mismatch' },
  { field: 'registry', label: 'registry', unresolvedCode: 'release_candidate_registry_unresolved', mismatchCode: 'release_candidate_registry_mismatch' },
]

/** A readiness reference resolves to a real, already-established fact. */
function readinessResolves(projection: GuardProjection, ref: string): boolean {
  if (projection.checkpoints.some((checkpoint) => checkpoint.id === ref && checkpoint.result === 'certified')) return true
  if (projection.boundaries.some((boundary) => boundary.id === ref)) return true
  return projection.items.get(ref)?.status === 'passed'
}

/**
 * The pre-effect release decision. Order matters: an unprotectable surface and
 * a damaged release state are refused before expiry or candidate checks,
 * because running an unprotected operation is never made acceptable by a valid
 * ticket, and because unreadable release state must not authorize anything.
 */
export function releasePreEffectDecision(projection: GuardProjection, request: ReleaseGateRequest): ReleaseGateDecision {
  const surface = RELEASE_OPERATION_SURFACES[request.operation]
  if (!surface.protectable) return { status: 'denied', reasonCode: surface.reasonCode }
  // Damaged release state blocks RELEASE operations only. Ordinary work keeps
  // its own rules: the projection's integrity is deliberately untouched here.
  if (projection.releaseStateDamaged) return { status: 'denied', reasonCode: 'release_state_damaged' }
  const contract = releaseContractFor(projection, request.operation, request.contractId)
  if (!contract) {
    // Name the real reason: a session that never adopted anything needs a
    // contract, a session whose only matching contract was revoked is revoked,
    // and a session with other contracts simply does not cover this operation.
    const revokedOnly = projection.releaseContracts.some((entry) =>
      entry.revokedAtSeq !== undefined
      && entry.operations.includes(request.operation)
      && (request.contractId === undefined || entry.contractId === request.contractId))
    if (revokedOnly) return { status: 'denied', reasonCode: 'release_contract_revoked' }
    if (request.contractId !== undefined && isContractRevoked(projection, request.contractId)) {
      return { status: 'denied', reasonCode: 'release_contract_revoked' }
    }
    return { status: 'denied', reasonCode: projection.releaseContracts.length === 0
      ? 'release_contract_required'
      : 'release_operation_not_adopted' }
  }
  if (contract.expiresAtEpochMs !== undefined) {
    if (request.nowEpochMs === undefined) return { status: 'denied', reasonCode: 'release_expiry_unevaluable', contractId: contract.contractId }
    if (request.nowEpochMs >= contract.expiresAtEpochMs) return { status: 'denied', reasonCode: 'release_contract_expired', contractId: contract.contractId }
  }
  // Consumption and in-flight protection are checked before identity so a
  // replay of an already-consumed ticket is reported as a replay, never as a
  // mismatch a caller could "fix" by changing the candidate.
  if (settledOperations(projection, contract.contractId).includes(request.operation)) {
    return { status: 'denied', reasonCode: 'release_operation_consumed', contractId: contract.contractId }
  }
  if (inFlightReservation(projection, contract.contractId, request.operation)) {
    return { status: 'denied', reasonCode: 'release_operation_in_flight', contractId: contract.contractId }
  }
  // Readiness and closure identity must name facts that really exist.
  for (const ref of contract.readinessRefs) {
    if (!readinessResolves(projection, ref)) {
      return { status: 'denied', reasonCode: 'release_readiness_unresolved', contractId: contract.contractId }
    }
  }
  const closureRef = contract.closureCertRef
  const closure = closureRef !== undefined ? projection.checkpoints.find((checkpoint) => checkpoint.id === closureRef) : undefined
  if (!closure || closure.result !== 'certified' || closure.epoch !== projection.epoch
    || closure.contractRevision !== projection.contractRevision) {
    return { status: 'denied', reasonCode: 'release_closure_unresolved', contractId: contract.contractId }
  }
  // The artifact must be bound to its bytes by at least one measurable digest:
  // a contract that names a commit but no artifact digest would authorize
  // "whatever npm builds", which is exactly what this profile exists to stop.
  if (contract.candidate.artifactSha256 === undefined && contract.candidate.artifactSri === undefined) {
    return { status: 'denied', reasonCode: 'release_artifact_identity_required', contractId: contract.contractId }
  }
  const candidate = contract.candidate
  const observedIdentity: ReleaseObservedIdentity = request.observed ?? {}
  const compared: Array<[FieldComparison, string]> = []
  for (const entry of CANDIDATE_FIELD_CODES) {
    const declared = candidate[entry.field as keyof ReleaseCandidate]
    if (typeof declared !== 'string') continue
    compared.push([entry, declared])
  }
  for (const [entry, declared] of compared) {
    const observed = observedIdentity[entry.field]
    if (observed === undefined) return { status: 'denied', reasonCode: entry.unresolvedCode, contractId: contract.contractId }
    if (observed !== declared) return { status: 'denied', reasonCode: entry.mismatchCode, contractId: contract.contractId }
  }
  // The resolved target must be the artifact the contract names, not merely a
  // target that happens to satisfy the command manifest.
  const resolved = request.resolvedTarget
  if (resolved === undefined) return { status: 'denied', reasonCode: 'release_target_unresolved', contractId: contract.contractId }
  if (resolved.version === undefined) return { status: 'denied', reasonCode: 'release_target_unresolved', contractId: contract.contractId }
  if (candidate.packageId !== undefined && resolved.artifact_id !== candidate.packageId) {
    return { status: 'denied', reasonCode: 'release_target_package_mismatch', contractId: contract.contractId }
  }
  if (candidate.version !== undefined && resolved.version !== candidate.version) {
    return { status: 'denied', reasonCode: 'release_target_version_mismatch', contractId: contract.contractId }
  }
  if (candidate.registry !== undefined && resolved.registry !== candidate.registry) {
    return { status: 'denied', reasonCode: 'release_target_registry_mismatch', contractId: contract.contractId }
  }
  return { status: 'granted', reasonCode: 'release_contract_granted', contractId: contract.contractId }
}

/**
 * Whether a trusted readback settles the attempt: the readback must name the
 * SAME artifact identity the contract froze. A registry that answers with a
 * different integrity proves the wrong bytes are published, which is an
 * unknown outcome for this contract, never a settlement.
 */
export function readbackSettlesContract(contract: ReleaseContract, readback: { kind: string; identity: string } | 'unavailable'): 'settled' | 'unconfirmed' | 'mismatch' {
  if (readback === 'unavailable') return 'unconfirmed'
  if (readback.kind !== 'npm_integrity') return 'unconfirmed'
  if (contract.candidate.artifactSri === undefined) return 'unconfirmed'
  return readback.identity === contract.candidate.artifactSri ? 'settled' : 'mismatch'
}

/** The coverage report for one contract: which adopted operations Guard can protect. */
export function releaseCoverage(contract: ReleaseContract): Array<{ operation: ReleaseOperation } & ReleaseOperationSurface> {
  return [...contract.operations].sort().map((operation) => ({ operation, ...RELEASE_OPERATION_SURFACES[operation] }))
}
