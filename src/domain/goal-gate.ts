import type { GuardProjection } from './types.js'

export function hasCurrentCertificate(projection: GuardProjection): boolean {
  const checkpoint = projection.checkpoints.at(-1)
  let reason: string | undefined
  if (projection.integrity !== 'valid') reason = 'integrity_invalid'
  else if (projection.hostStatus !== 'supported') reason = 'host_lock_unsupported'
  else if (!checkpoint || checkpoint.result !== 'certified') reason = 'certificate_missing'
  else if (checkpoint.epoch !== projection.epoch) reason = 'stale_epoch'
  else if (checkpoint.sessionRefDigest !== projection.sessionRefDigest) reason = 'foreign_session'
  else if (checkpoint.hostLockDigest !== projection.hostLockDigest) reason = 'stale_host_lock'
  else if (checkpoint.contractRevision !== projection.contractRevision) reason = 'stale_contract_revision'
  else if (projection.currentGoalRef
    ? checkpoint.goalRef?.id !== projection.currentGoalRef.id || checkpoint.goalRef.revision !== projection.currentGoalRef.revision
    : checkpoint.goalRef !== undefined) reason = 'stale_goal_ref'
  projection.certificateStatusReason = reason
  return reason === undefined
}

/**
 * Denies `update_goal(action=complete)` while the guard is enabled and no
 * current completion certificate exists. The gate itself has no bypass; a
 * workflow that genuinely finished but cannot certify (for example a contract
 * polluted by session-layer talk, or evidence that lives in another session)
 * has three explicit remediation routes:
 *
 * 1. `/context-guard off` disables the guard, so completion is no longer
 *    gated. Use only after the user confirms the work is actually done.
 * 2. `/context-guard clear` supersedes every pending requirement and
 *    acceptance under a `CLEAR:<revision>` sentinel (prohibitions are
 *    retained) and bumps the contract revision; an empty-binding checkpoint
 *    can then certify while the guard stays enabled.
 * 3. `update_goal(action=blocked)` records the blocker truthfully, which is
 *    never denied by this gate.
 */
export function goalCompletionDenial(
  projection: GuardProjection,
  toolName: string,
  argumentsValue: unknown,
  configuredToolName = 'update_goal',
): string | undefined {
  if (toolName !== configuredToolName || typeof argumentsValue !== 'object' || argumentsValue === null) return undefined
  const action = (argumentsValue as { action?: unknown }).action
  if (action !== 'complete') return undefined
  if (!projection.enabled) return undefined
  const args = argumentsValue as { goal_id?: unknown; revision?: unknown }
  if (projection.hostStatus !== 'supported') {
    return `Context Guard denial [stale_host]: host lock is unsupported or unavailable (${projection.hostReasonCode ?? 'unknown_host'}).`
  }
  if (!projection.currentGoalRef) return 'Context Guard denial [no_goal]: no current Goal reference is available.'
  if (args.goal_id !== projection.currentGoalRef.id || args.revision !== projection.currentGoalRef.revision) {
    return 'Context Guard denial [stale_goal_ref]: update_goal must use the exact current goal_id and revision.'
  }
  if (hasCurrentCertificate(projection)) return undefined
  if (projection.certificateStatusReason === 'stale_host_lock') {
    return 'Context Guard denial [stale_host]: the completion certificate belongs to a different host identity.'
  }
  if (projection.certificateStatusReason === 'stale_goal_ref') {
    return 'Context Guard denial [stale_goal_ref]: the completion certificate belongs to a different Goal reference.'
  }
  return projection.integrity === 'valid'
    ? 'Context Guard denial [certificate_missing]: a current completion certificate is required.'
    : 'Context Guard denial [certificate_missing]: integrity is unknown or corrupt, so no current certificate is usable.'
}
