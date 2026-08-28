import type { GuardProjection } from './types.js'

export function hasCurrentCertificate(projection: GuardProjection): boolean {
  const checkpoint = projection.checkpoints.at(-1)
  return projection.integrity === 'valid'
    && checkpoint?.result === 'certified'
    && checkpoint.epoch === projection.epoch
    && checkpoint.contractRevision === projection.contractRevision
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
  if (hasCurrentCertificate(projection)) return undefined
  return projection.integrity === 'valid'
    ? 'Context Guard requires a current completion certificate before Goal completion.'
    : 'Context Guard integrity is unknown or corrupt; Goal completion is denied.'
}
