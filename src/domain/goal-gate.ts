import type { GuardProjection } from './types.js'

export function hasCurrentCertificate(projection: GuardProjection): boolean {
  const checkpoint = projection.checkpoints.at(-1)
  return projection.integrity === 'valid'
    && checkpoint?.result === 'certified'
    && checkpoint.epoch === projection.epoch
    && checkpoint.contractRevision === projection.contractRevision
}

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
