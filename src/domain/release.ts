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
 * - `contract`   — the adopted scope: operations, the exact candidate, the
 *                  readiness/closure references and an optional expiry.
 * - `reservation` — written BEFORE any effect; the operation is `in_flight`
 *                  from that moment, so a crash cannot be mistaken for "never
 *                  started" and the operation is never blindly re-sent.
 * - `settlement`  — written after the effect, from a TRUSTED readback when one
 *                  exists. Without a readback producer the attempt stays
 *                  `unconfirmed`, which keeps the in-flight protection and
 *                  reports `release_readback_unavailable` instead of claiming
 *                  a verified release.
 *
 * COVERAGE SURFACE (frozen wording): only the surfaces Guard itself routes can
 * be protected. `npm_publish` runs through the Guard-owned action tool and is
 * therefore protectable. `git_tag`, the GitHub Release operations and any
 * composite/opaque runner have NO interception point in this host, so a
 * contract that requires them is refused before any effect with
 * `release_operation_unprotectable` / `release_runner_opaque` — Guard never
 * suggests falling back to a plain shell command. A trusted in-process caller
 * that bypasses Guard entirely is a host trust boundary and is disclosed as
 * such in the documentation, not pretended away.
 */

export const RELEASE_CONTRACT_PREFIX = 'Context Guard release contract v1: '
export const RELEASE_RESERVATION_PREFIX = 'Context Guard release reservation v1: '
export const RELEASE_SETTLEMENT_PREFIX = 'Context Guard release settlement v1: '

export const RELEASE_OPERATIONS = [
  'npm_publish', 'git_tag', 'github_release_create', 'github_release_update',
  'github_release_delete', 'composite_runner',
] as const
export type ReleaseOperation = (typeof RELEASE_OPERATIONS)[number]

/** Where the operation would actually execute, and whether Guard can protect it. */
export interface ReleaseOperationSurface {
  /** The Guard-owned surface that runs the operation, when one exists. */
  surface: 'context_guard_action' | 'none'
  protectable: boolean
  reasonCode: 'release_operation_protectable' | 'release_operation_unprotectable' | 'release_runner_opaque'
}

export const RELEASE_OPERATION_SURFACES: Readonly<Record<ReleaseOperation, ReleaseOperationSurface>> = {
  npm_publish: { surface: 'context_guard_action', protectable: true, reasonCode: 'release_operation_protectable' },
  // No Guard route exists for a tag or a GitHub Release in this host, and a
  // composite runner is opaque by definition: both fail closed before effect.
  git_tag: { surface: 'none', protectable: false, reasonCode: 'release_operation_unprotectable' },
  github_release_create: { surface: 'none', protectable: false, reasonCode: 'release_operation_unprotectable' },
  github_release_update: { surface: 'none', protectable: false, reasonCode: 'release_operation_unprotectable' },
  github_release_delete: { surface: 'none', protectable: false, reasonCode: 'release_operation_unprotectable' },
  composite_runner: { surface: 'none', protectable: false, reasonCode: 'release_runner_opaque' },
}

export interface ReleaseCandidate {
  repository?: string
  ref: string
  fullSha40: string
  artifactDigest?: string
  version?: string
}

export interface ReleaseContract {
  contractId: string
  /** The durable root event that adopted the contract. */
  adoptedBy: { seq: number; digest: string }
  operations: ReleaseOperation[]
  candidate: ReleaseCandidate
  readinessRefs: string[]
  closureCertRef?: string
  expiresAtEpochMs?: number
}

export interface ReleaseReservation {
  contractId: string
  operation: ReleaseOperation
  /** The resolution call the effect is bound to; the replay key. */
  callId: string
  startedAtSeq: number
  status: 'in_flight'
}

export interface ReleaseSettlement {
  contractId: string
  operation: ReleaseOperation
  callId: string
  settledAtSeq: number
  /** A trusted readback identity, or the reason no producer exists. */
  readback: { kind: 'npm_integrity' | 'git_ref' | 'github_release'; identity: string } | 'unavailable'
  outcome: 'settled' | 'unconfirmed' | 'failed'
}

const FULL_SHA40 = /^[0-9a-f]{40}$/
const DIGEST64 = /^[0-9a-f]{64}$/

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
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
  const ref = typeof candidate?.ref === 'string' ? candidate.ref.trim() : ''
  const fullSha40 = typeof candidate?.fullSha40 === 'string' ? candidate.fullSha40.trim() : ''
  if (!ref) errors.push('release_candidate_ref_missing')
  if (!FULL_SHA40.test(fullSha40)) errors.push('release_candidate_sha_invalid')
  const repository = typeof candidate?.repository === 'string' && candidate.repository.trim() ? candidate.repository.trim() : undefined
  const version = typeof candidate?.version === 'string' && candidate.version.trim() ? candidate.version.trim() : undefined
  const artifactDigest = typeof candidate?.artifactDigest === 'string' ? candidate.artifactDigest.trim() : undefined
  if (artifactDigest !== undefined && !DIGEST64.test(artifactDigest)) errors.push('release_candidate_artifact_digest_invalid')
  const readinessRefs = Array.isArray(value.readinessRefs)
    ? value.readinessRefs.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : []
  const closureCertRef = typeof value.closureCertRef === 'string' && value.closureCertRef ? value.closureCertRef : undefined
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
  const suppliedId = typeof value.contractId === 'string' && value.contractId.trim() ? value.contractId.trim() : undefined
  const body = {
    operations: [...operations].sort(),
    candidate: { ...(repository ? { repository } : {}), ref, fullSha40, ...(artifactDigest ? { artifactDigest } : {}), ...(version ? { version } : {}) },
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
  const contractId = typeof value.contractId === 'string' ? value.contractId : ''
  const operation = typeof value.operation === 'string' ? value.operation : ''
  const callId = typeof value.callId === 'string' ? value.callId : ''
  const startedAtSeq = value.startedAtSeq
  if (!contractId || !callId) return undefined
  if (!(RELEASE_OPERATIONS as readonly string[]).includes(operation)) return undefined
  if (typeof startedAtSeq !== 'number' || !Number.isSafeInteger(startedAtSeq)) return undefined
  return { contractId, operation: operation as ReleaseOperation, callId, startedAtSeq, status: 'in_flight' }
}

export function normalizeSettlement(raw: unknown): ReleaseSettlement | undefined {
  const value = asRecord(raw)
  if (!value) return undefined
  const contractId = typeof value.contractId === 'string' ? value.contractId : ''
  const operation = typeof value.operation === 'string' ? value.operation : ''
  const callId = typeof value.callId === 'string' ? value.callId : ''
  const settledAtSeq = value.settledAtSeq
  const outcome = typeof value.outcome === 'string' ? value.outcome : ''
  if (!contractId || !callId) return undefined
  if (!(RELEASE_OPERATIONS as readonly string[]).includes(operation)) return undefined
  if (typeof settledAtSeq !== 'number' || !Number.isSafeInteger(settledAtSeq)) return undefined
  if (outcome !== 'settled' && outcome !== 'unconfirmed' && outcome !== 'failed') return undefined
  const readbackRaw = asRecord(value.readback)
  const kind = readbackRaw?.kind
  const readback = readbackRaw && (kind === 'npm_integrity' || kind === 'git_ref' || kind === 'github_release')
    && typeof readbackRaw.identity === 'string' && readbackRaw.identity
    ? { kind, identity: readbackRaw.identity } as ReleaseSettlement['readback']
    : 'unavailable' as const
  return { contractId, operation: operation as ReleaseOperation, callId, settledAtSeq, readback, outcome }
}

/** The adopted contract that covers an operation, newest adoption first. */
export function releaseContractFor(projection: GuardProjection, operation: ReleaseOperation, contractId?: string): ReleaseContract | undefined {
  const contracts = projection.releaseContracts.filter((contract) => (
    (contractId === undefined || contract.contractId === contractId)
    && contract.operations.includes(operation)
  ))
  return contracts.length ? contracts[contracts.length - 1] : undefined
}

/** The in-flight (unsettled) reservation for one contract operation, if any. */
export function inFlightReservation(projection: GuardProjection, contractId: string, operation: ReleaseOperation): ReleaseReservation | undefined {
  for (const reservation of projection.releaseReservations) {
    if (reservation.contractId !== contractId || reservation.operation !== operation) continue
    const settled = projection.releaseSettlements.some((settlement) => (
      settlement.contractId === contractId && settlement.operation === operation && settlement.callId === reservation.callId
      && settlement.outcome !== 'unconfirmed'
    ))
    if (!settled) return reservation
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

export interface ReleaseGateRequest {
  operation: ReleaseOperation
  /** The candidate the caller is about to release. */
  candidate: Partial<ReleaseCandidate> & { fullSha40?: string }
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

/**
 * The pre-effect release decision. Order matters: an unprotectable surface is
 * refused before expiry or candidate checks, because running an unprotected
 * operation is never made acceptable by a valid ticket.
 */
export function releasePreEffectDecision(projection: GuardProjection, request: ReleaseGateRequest): ReleaseGateDecision {
  const surface = RELEASE_OPERATION_SURFACES[request.operation]
  if (!surface.protectable) return { status: 'denied', reasonCode: surface.reasonCode }
  const contract = releaseContractFor(projection, request.operation, request.contractId)
  if (!contract) {
    return { status: 'denied', reasonCode: projection.releaseContracts.length === 0
      ? 'release_contract_required'
      : 'release_operation_not_adopted' }
  }
  if (contract.expiresAtEpochMs !== undefined) {
    if (request.nowEpochMs === undefined) return { status: 'denied', reasonCode: 'release_expiry_unevaluable', contractId: contract.contractId }
    if (request.nowEpochMs >= contract.expiresAtEpochMs) return { status: 'denied', reasonCode: 'release_contract_expired', contractId: contract.contractId }
  }
  // Consumption and in-flight protection are checked before the candidate so a
  // replay of an already-consumed ticket is reported as a replay, never as a
  // candidate mismatch that a caller could "fix" by changing the candidate.
  if (settledOperations(projection, contract.contractId).includes(request.operation)) {
    return { status: 'denied', reasonCode: 'release_operation_consumed', contractId: contract.contractId }
  }
  if (inFlightReservation(projection, contract.contractId, request.operation)) {
    return { status: 'denied', reasonCode: 'release_operation_in_flight', contractId: contract.contractId }
  }
  const candidate = contract.candidate
  const requested = request.candidate
  if (requested.fullSha40 === undefined || requested.fullSha40 !== candidate.fullSha40) {
    return { status: 'denied', reasonCode: 'release_candidate_sha_mismatch', contractId: contract.contractId }
  }
  if (requested.ref !== undefined && requested.ref !== candidate.ref) {
    return { status: 'denied', reasonCode: 'release_candidate_ref_mismatch', contractId: contract.contractId }
  }
  if (requested.repository !== undefined && candidate.repository !== undefined && requested.repository !== candidate.repository) {
    return { status: 'denied', reasonCode: 'release_candidate_repository_mismatch', contractId: contract.contractId }
  }
  if (candidate.artifactDigest !== undefined) {
    if (requested.artifactDigest === undefined) return { status: 'denied', reasonCode: 'release_artifact_digest_unresolved', contractId: contract.contractId }
    if (requested.artifactDigest !== candidate.artifactDigest) return { status: 'denied', reasonCode: 'release_candidate_artifact_mismatch', contractId: contract.contractId }
  }
  if (candidate.version !== undefined && requested.version !== undefined && requested.version !== candidate.version) {
    return { status: 'denied', reasonCode: 'release_candidate_version_mismatch', contractId: contract.contractId }
  }
  // A protected operation must be bound to a concrete resolution: an unresolved
  // target is refused instead of defaulting to whatever the effect resolves.
  if (request.operation === 'npm_publish' && request.resolvedTarget?.version === undefined) {
    return { status: 'denied', reasonCode: 'release_target_unresolved', contractId: contract.contractId }
  }
  return { status: 'granted', reasonCode: 'release_contract_granted', contractId: contract.contractId }
}

/**
 * The coverage report for one contract: which adopted operations Guard can
 * actually protect, and which it must refuse. Used by diagnostics and by the
 * adoption record itself, so a contract never implies coverage it cannot have.
 */
export function releaseCoverage(contract: ReleaseContract): Array<{ operation: ReleaseOperation } & ReleaseOperationSurface> {
  return [...contract.operations].sort().map((operation) => ({ operation, ...RELEASE_OPERATION_SURFACES[operation] }))
}
