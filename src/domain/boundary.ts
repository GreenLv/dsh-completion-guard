import { sha256 } from './canonicalize.js'
import { currentContractDigest } from './contract-digest.js'
import type {
  BoundaryDisposition,
  BoundaryQualificationKind,
  GoalRef,
  GuardBoundary,
  GuardProjection,
} from './types.js'

export interface BoundaryRequest {
  disposition: BoundaryDisposition
  qualificationKind: BoundaryQualificationKind
  qualificationIds: string[]
  callId?: string
}

export interface BoundaryQualification {
  id: string
  kind: BoundaryQualificationKind
  disposition: BoundaryDisposition
  source: 'root_contract' | 'trusted_adapter'
  status: 'pending' | 'running'
}

/** Bounded, replay-derived qualifications that callers may cite verbatim. */
export function availableBoundaryQualifications(projection: GuardProjection): BoundaryQualification[] {
  const rows: BoundaryQualification[] = []
  for (const item of projection.items.values()) {
    if (item.status !== 'pending') continue
    if (item.waitAuthorization) rows.push({
      id: item.waitAuthorization.id,
      kind: item.waitAuthorization.kind,
      disposition: 'user_wait',
      source: 'root_contract', status: 'pending',
    })
    if (item.deferAuthorization) rows.push({
      id: item.deferAuthorization.id,
      kind: item.deferAuthorization.kind,
      disposition: 'deferred',
      source: 'root_contract',
      status: 'pending',
    })
  }
  for (const operation of projection.externalOperations.values()) {
    if (operation.epoch !== projection.epoch || (operation.status !== 'pending' && operation.status !== 'running')) continue
    rows.push({
      id: operation.id, kind: 'external_operation_pending', disposition: 'external_wait',
      source: 'trusted_adapter', status: operation.status,
    })
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id)).slice(0, 32)
}

function qualificationReason(projection: GuardProjection, request: BoundaryRequest): string | undefined {
  const ids = new Set(request.qualificationIds)
  if (ids.size !== request.qualificationIds.length || ids.size === 0) return 'boundary_qualification_ids_invalid'
  if (request.disposition === 'user_wait') {
    if (request.qualificationKind !== 'root_explicit_wait' && request.qualificationKind !== 'user_decision_item') {
      return 'boundary_qualification_kind_mismatch'
    }
    const known = new Set([...projection.items.values()]
      .filter((item) => item.status === 'pending' && item.waitAuthorization?.kind === request.qualificationKind)
      .map((item) => item.waitAuthorization!.id))
    return request.qualificationIds.every((id) => known.has(id)) ? undefined : 'boundary_disposition_unqualified'
  }
  if (request.disposition === 'external_wait') {
    if (request.qualificationKind !== 'external_operation_pending') return 'boundary_qualification_kind_mismatch'
    return request.qualificationIds.every((id) => {
      const operation = projection.externalOperations.get(id)
      return operation?.epoch === projection.epoch && (operation.status === 'running' || operation.status === 'pending')
    }) ? undefined : 'boundary_disposition_unqualified'
  }
  if (request.qualificationKind !== 'root_explicit_defer') {
    return 'boundary_qualification_kind_mismatch'
  }
  const known = new Set([...projection.items.values()]
    .filter((item) => item.status === 'pending' && item.deferAuthorization?.kind === request.qualificationKind)
    .map((item) => item.deferAuthorization!.id))
  return request.qualificationIds.every((id) => known.has(id)) ? undefined : 'boundary_disposition_unqualified'
}

export function qualifyBoundary(projection: GuardProjection, request: BoundaryRequest): GuardBoundary {
  const contractSha256 = currentContractDigest(projection)
  const reason = projection.integrity !== 'valid'
    ? 'boundary_integrity_invalid'
    : projection.hostStatus !== 'supported' && projection.currentGoalRef
      ? 'boundary_host_lock_unsupported'
      : qualificationReason(projection, request)
  const manifest = {
    protocolVersion: '1', disposition: request.disposition,
    qualificationKind: request.qualificationKind,
    qualificationIds: [...request.qualificationIds].sort(), epoch: projection.epoch,
    contractRevision: projection.contractRevision, contractSha256,
    goalRef: projection.currentGoalRef ?? null,
  }
  const candidateSha256 = sha256(JSON.stringify(manifest))
  return {
    protocolVersion: '1', id: `B${projection.boundaries.length + 1}`,
    disposition: request.disposition, qualificationKind: request.qualificationKind,
    qualificationIds: [...request.qualificationIds], epoch: projection.epoch,
    contractRevision: projection.contractRevision, contractSha256,
    ...(projection.currentGoalRef ? { goalRef: { ...projection.currentGoalRef } } : {}),
    candidateSha256, ...(request.callId ? { callId: request.callId } : {}),
    persistedResult: reason ? 'rejected' : 'accepted',
    reasonCode: reason ?? 'boundary_persisted_accepted',
  }
}

/**
 * Reconstruct the immutable candidate against the latest replay projection.
 * A persisted acceptance is not effectuation authority after any contract,
 * Goal, epoch, or qualification change.
 */
export function isCurrentAcceptedBoundary(projection: GuardProjection, boundary: GuardBoundary): boolean {
  if (boundary.persistedResult !== 'accepted'
    || boundary.epoch !== projection.epoch
    || boundary.contractRevision !== projection.contractRevision
    || boundary.contractSha256 !== currentContractDigest(projection)) return false
  const currentGoal = projection.currentGoalRef
  if (boundary.goalRef
    ? !currentGoal || !sameRef(currentGoal, boundary.goalRef)
    : currentGoal !== undefined) return false
  const reconstructed = qualifyBoundary(projection, {
    disposition: boundary.disposition,
    qualificationKind: boundary.qualificationKind,
    qualificationIds: boundary.qualificationIds,
    ...(boundary.callId ? { callId: boundary.callId } : {}),
  })
  return reconstructed.persistedResult === 'accepted'
    && reconstructed.candidateSha256 === boundary.candidateSha256
}

export interface GoalActivationState extends GoalRef {
  phase: 'active' | 'paused' | 'blocked' | 'complete'
  activation: 'armed' | 'disarmed'
}

export interface GoalBoundaryAccess {
  get(): Promise<GoalActivationState | undefined>
  disarm(): Promise<GoalActivationState | undefined>
  /** Final live adapter readback immediately before any Goal mutation. */
  requalify?: () => Promise<boolean>
}

export interface BoundaryEffectuation {
  boundaryId: string
  goalRef?: GoalRef
  reasonCode: 'boundary_effectuated' | 'boundary_no_goal_safe_yield' | 'boundary_already_disarmed' | 'boundary_pre_effect_failure' | 'boundary_readback_still_armed' | 'boundary_post_effect_unknown' | 'boundary_goal_ref_stale' | 'boundary_not_accepted'
  stopAllowed: boolean
  resumeRequired: boolean
}

function sameRef(state: GoalRef | undefined, ref: GoalRef): boolean {
  return state?.id === ref.id && state.revision === ref.revision
}

/**
 * Effectuate only a replay-confirmed accepted boundary. The first disarm result
 * and an independent get() must both read the same active Goal ref as disarmed.
 * A failure after disarm may have taken effect is never auto-rearmed.
 */
export async function effectuateBoundary(boundary: GuardBoundary, access: GoalBoundaryAccess): Promise<BoundaryEffectuation> {
  const base = { boundaryId: boundary.id, ...(boundary.goalRef ? { goalRef: boundary.goalRef } : {}) }
  if (boundary.persistedResult !== 'accepted') return { ...base, reasonCode: 'boundary_not_accepted', stopAllowed: false, resumeRequired: false }
  if (access.requalify) {
    try {
      if (!await access.requalify()) {
        return { ...base, reasonCode: 'boundary_pre_effect_failure', stopAllowed: false, resumeRequired: false }
      }
    } catch {
      return { ...base, reasonCode: 'boundary_pre_effect_failure', stopAllowed: false, resumeRequired: false }
    }
  }
  if (!boundary.goalRef) return { ...base, reasonCode: 'boundary_no_goal_safe_yield', stopAllowed: true, resumeRequired: false }
  let before: GoalActivationState | undefined
  try {
    before = await access.get()
  } catch {
    return { ...base, reasonCode: 'boundary_pre_effect_failure', stopAllowed: false, resumeRequired: false }
  }
  if (!sameRef(before, boundary.goalRef) || before?.phase !== 'active') {
    return { ...base, reasonCode: 'boundary_goal_ref_stale', stopAllowed: false, resumeRequired: false }
  }
  if (before.activation === 'disarmed') {
    return { ...base, reasonCode: 'boundary_already_disarmed', stopAllowed: true, resumeRequired: false }
  }
  let firstReadback: GoalActivationState | undefined
  try {
    firstReadback = await access.disarm()
  } catch {
    return { ...base, reasonCode: 'boundary_post_effect_unknown', stopAllowed: false, resumeRequired: true }
  }
  if (!firstReadback || !sameRef(firstReadback, boundary.goalRef) || firstReadback.phase !== 'active') {
    return { ...base, reasonCode: 'boundary_post_effect_unknown', stopAllowed: false, resumeRequired: true }
  }
  if (firstReadback.activation !== 'disarmed') {
    return { ...base, reasonCode: 'boundary_readback_still_armed', stopAllowed: false, resumeRequired: false }
  }
  try {
    const independent = await access.get()
    if (!sameRef(independent, boundary.goalRef) || independent?.phase !== 'active') {
      return { ...base, reasonCode: 'boundary_post_effect_unknown', stopAllowed: false, resumeRequired: true }
    }
    if (independent.activation !== 'disarmed') {
      return { ...base, reasonCode: 'boundary_readback_still_armed', stopAllowed: false, resumeRequired: false }
    }
  } catch {
    return { ...base, reasonCode: 'boundary_post_effect_unknown', stopAllowed: false, resumeRequired: true }
  }
  return { ...base, reasonCode: 'boundary_effectuated', stopAllowed: true, resumeRequired: false }
}
