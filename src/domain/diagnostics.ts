import { ACTION_MANIFEST, SUPPORTED_EVIDENCE_ADAPTERS, actionCompatible, isStatefulAction, requestedTargetMatchesResolved } from './protocol-manifest.js'
import type { GuardEvidence, GuardItem, GuardProjection } from './types.js'

export function itemDiagnosis(p: GuardProjection, item: GuardItem): { certifiable: boolean; reason_code: string; next_step: string } {
  if (item.kind === 'prohibition') return { certifiable: false, reason_code: 'prohibition_active', next_step: 'Keep this constraint enforced; it is not a completion evidence obligation.' }
  const action = item.semanticAction ?? 'generic_run'
  const reason = item.status === 'passed' ? 'certified'
    : action === 'generic_run' ? 'generic_run_non_certifiable'
      : item.legacyFlags?.length || item.targetCaptureStatus === 'clarification_required' ? 'target_clarification_required'
        : p.hostStatus !== 'supported' ? 'host_unavailable'
          : ACTION_MANIFEST.actions[action].evidenceProducer !== 'supported' ? 'adapter_unavailable' : 'missing_evidence'
  return {
    certifiable: reason === 'missing_evidence' || reason === 'certified',
    reason_code: reason,
    next_step: reason === 'certified' ? 'No further binding needed.'
      : reason === 'generic_run_non_certifiable' || reason === 'target_clarification_required'
        ? 'Use context_guard_rebind to propose explicit clauses for root-user confirmation; preserve unsupported work pending. Rebinding grants no execution permission.'
        : reason === 'missing_evidence' ? 'Collect matching durable evidence, then call context_guard_checkpoint with bindings.'
          : 'Restore the audited host/adapter capability before certification; keep pending work visible at a qualified safe boundary.',
  }
}

const NATIVE_ADAPTERS = new Set(['dsh.bash.v1', 'dsh.pwsh.v1', 'dsh.shell.v1', 'dsh.read.v1', 'dsh.write.v1', 'dsh.edit.v1', 'dsh.web.v1'])

export function evidenceAvailabilityReason(evidence: GuardEvidence): string | undefined {
  if (evidence.parseStatus !== 'supported') return evidence.reasonCode ?? evidence.parseStatus ?? 'adapter_unavailable'
  if (!evidence.adapterId || !evidence.adapterVersion || (SUPPORTED_EVIDENCE_ADAPTERS[evidence.adapterId] ?? (NATIVE_ADAPTERS.has(evidence.adapterId) ? '1.0.0' : undefined)) !== evidence.adapterVersion) return 'adapter_unavailable'
  if (evidence.outcome !== 'success') return 'evidence_outcome_not_success'
  if (!evidence.semanticAction || evidence.semanticAction === 'generic_run') return 'generic_run_non_certifiable'
  return undefined
}

/** Shared display filter; certification remains the full domain check. */
export function relevantEvidence(p: GuardProjection, item: GuardItem, evidence: GuardEvidence): boolean {
  const action = item.semanticAction
  if (!action || action === 'generic_run' || !actionCompatible(action, evidence.semanticAction ?? 'generic_run') || evidence.epoch !== p.epoch
    || evidenceAvailabilityReason(evidence) !== undefined) return false
  if (item.reboundFrom) {
    const source = /^m(\d+)(?::|$)/.exec(item.sourceMessageId)
    if (!source || evidence.toolResultSeq < Number(source[1])) return false
  }
  if (isStatefulAction(action)) return requestedTargetMatchesResolved(action, item.requestedTarget, evidence.resolvedTarget)
  const value = (entry: unknown) => JSON.stringify(entry && typeof entry === 'object' && 'v' in entry ? entry.v : entry)
  return !!item.requestedTarget && Object.entries(item.requestedTarget).every(([key, entry]) =>
    evidence.resolvedTarget && value(entry) === value(evidence.resolvedTarget[key]))
}
