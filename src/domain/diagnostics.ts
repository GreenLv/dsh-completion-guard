import { sha256 } from './canonicalize.js'
import { ACTION_MANIFEST, SUPPORTED_EVIDENCE_ADAPTERS, actionCompatible, isStatefulAction, requestedTargetMatchesResolved } from './protocol-manifest.js'
import type { GuardEvidence, GuardItem, GuardProjection } from './types.js'

export type TaskKind = 'inquiry' | 'action' | 'deliverable' | 'constraint' | 'unresolved'
export type CertificationSupport = 'supported' | 'unsupported' | 'needs_target' | 'needs_evidence' | 'unavailable'
export type Repairability = 'agent_repairable' | 'user_input_required' | 'unsupported' | 'historical_gap' | 'none'

export interface DiagnosisNextAction {
  kind: 'report_only' | 'collect_evidence' | 'checkpoint' | 'clarify_target' | 'restore_host' | 'none'
  tool?: string
  required_input?: string
  resume_condition?: string
}

/** The single unified diagnosis shared by checkpoint, recovery, rebind,
 * evidence/action, and status surfaces (v0.5). It states what certification
 * can do, never invents targets, evidence IDs, or authority. */
export interface UnifiedItemDiagnosis {
  item_id: string
  item_revision: number
  contract_revision: number
  task_kind: TaskKind
  certification: CertificationSupport
  reason_code: string
  repairability: Repairability
  missing_fields: string[]
  missing_facets: Array<'resolution' | 'effect' | 'state'>
  next_action: DiagnosisNextAction
  /** Stable over unchanged inputs; identical retries collapse onto it. */
  attempt_fingerprint: string
}

/** Bounded, honest task-kind classification for a captured item. */
function taskKindOf(item: GuardItem): TaskKind {
  if (item.kind === 'prohibition') return 'constraint'
  if (item.taskKind === 'inquiry') return 'inquiry'
  return 'action'
}

const TARGET_FIELD_REASONS: Record<string, string> = {
  requested_target_package_id_missing: 'package_id',
  requested_target_artifact_id_missing: 'artifact_id',
  requested_target_repository_missing: 'repository',
  requested_target_service_id_missing: 'service_id',
  requested_target_registry_missing_or_invalid: 'registry',
}

function evidenceFacets(p: GuardProjection, item: GuardItem): Array<'resolution' | 'effect' | 'state'> {
  const present = new Set<'resolution' | 'effect' | 'state'>()
  for (const evidence of p.evidence.values()) {
    if (!relevantEvidence(p, item, evidence)) continue
    if (evidence.evidenceRole) present.add(evidence.evidenceRole)
  }
  return (['resolution', 'effect', 'state'] as const).filter((facet) => !present.has(facet))
}

/**
 * The pure repair judge. It decides between: fixable from existing evidence,
 * missing pre-evidence, missing a user target choice, not supported by any
 * adapter, an executed-without-evidence historical gap, or nothing to do —
 * and it NEVER recommends a rebind that cannot change certification.
 */
export function deriveItemDiagnosis(p: GuardProjection, item: GuardItem): UnifiedItemDiagnosis {
  const kind = taskKindOf(item)
  const missing_facets = item.status === 'pending' && kind !== 'constraint' ? evidenceFacets(p, item) : []
  const base = { item_id: item.id, item_revision: item.revision, contract_revision: p.contractRevision, task_kind: kind, missing_facets }

  if (item.kind === 'prohibition') {
    return {
      ...base,
      certification: 'unsupported',
      reason_code: 'prohibition_active',
      repairability: 'none',
      missing_fields: [],
      next_action: { kind: 'none', resume_condition: 'Keep this constraint enforced; it is not a completion evidence obligation.' },
      attempt_fingerprint: fingerprint(p, item, 'prohibition_active'),
    }
  }
  const action = item.semanticAction ?? 'generic_run'
  if (item.status === 'passed') {
    return {
      ...base, certification: 'supported', reason_code: 'certified', repairability: 'none', missing_fields: [],
      next_action: { kind: 'none', resume_condition: 'No further binding needed.' },
      attempt_fingerprint: fingerprint(p, item, 'certified'),
    }
  }
  if (item.status === 'pending' && item.waitAuthorization?.kind === 'root_explicit_wait') {
    return {
      ...base, certification: 'unavailable', reason_code: 'root_condition_pending',
      repairability: 'user_input_required', missing_fields: [], missing_facets: [],
      next_action: {
        kind: 'none',
        resume_condition: `Wait for the matching trusted root input: ${item.resumeEvent ?? item.condition ?? item.normalizedText}. Keep this obligation pending; do not execute it or collect effect evidence before release.`,
      },
      attempt_fingerprint: fingerprint(p, item, 'root_condition_pending'),
    }
  }
  if (action !== 'generic_run' && !item.legacyFlags?.length && item.targetCaptureStatus === 'clarification_required') {
    const missingFields = item.targetCaptureReasonCode ? [TARGET_FIELD_REASONS[item.targetCaptureReasonCode] ?? item.targetCaptureReasonCode] : []
    return {
      ...base,
      certification: 'needs_target',
      reason_code: 'target_clarification_required',
      repairability: 'user_input_required',
      missing_fields: missingFields,
      next_action: {
        kind: 'clarify_target',
        tool: 'context_guard_prepare',
        required_input: missingFields.length > 0 ? `the exact ${missingFields.join(' and ')} for this action` : 'the exact target fields for this action',
        resume_condition: 'A root-user instruction supplying the exact target re-enables certification.',
      },
      attempt_fingerprint: fingerprint(p, item, 'target_clarification_required'),
    }
  }
  if (action === 'generic_run' || item.legacyFlags?.length) {
    if (kind === 'inquiry') {
      // Inquiries stay obligations but are not machine-certifiable: report
      // honestly instead of dragging the user through a pointless rebind.
      return {
        ...base,
        certification: 'unsupported',
        reason_code: 'inquiry_non_certifiable',
        repairability: 'unsupported',
        missing_fields: [],
        next_action: {
          kind: 'report_only',
          resume_condition: 'Complete the investigation and report the actual answer; the item stays recorded as uncertified. No confirmation or rebind changes this.',
        },
        attempt_fingerprint: fingerprint(p, item, 'inquiry_non_certifiable'),
      }
    }
    return {
      ...base,
      certification: 'unsupported',
      reason_code: 'generic_run_non_certifiable',
      repairability: 'user_input_required',
      missing_fields: [],
      next_action: {
        kind: 'report_only',
        required_input: 'a concrete supported action and target for this obligation',
        resume_condition: 'A fresh root-user instruction naming a supported action and exact target replaces the generic obligation; identical re-phrasing changes nothing.',
      },
      attempt_fingerprint: fingerprint(p, item, 'generic_run_non_certifiable'),
    }
  }
  if (p.hostStatus !== 'supported') {
    return {
      ...base, certification: 'unavailable', reason_code: 'host_unavailable', repairability: 'unsupported', missing_fields: [],
      next_action: { kind: 'restore_host', resume_condition: 'Restore the audited host cohort; keep pending work visible at a qualified safe boundary.' },
      attempt_fingerprint: fingerprint(p, item, 'host_unavailable'),
    }
  }
  if (ACTION_MANIFEST.actions[action].evidenceProducer !== 'supported') {
    return {
      ...base, certification: 'unavailable', reason_code: 'adapter_unavailable', repairability: 'unsupported', missing_fields: [],
      next_action: { kind: 'restore_host', resume_condition: 'The audited adapter for this action is unavailable in the installed cohort.' },
      attempt_fingerprint: fingerprint(p, item, 'adapter_unavailable'),
    }
  }
  // An effect already recorded without its resolution prestate is a
  // historical gap: readback honestly, never re-execute to mint evidence.
  if (missing_facets.includes('resolution') && !missing_facets.includes('effect')) {
    return {
      ...base,
      certification: 'unsupported',
      reason_code: 'historical_evidence_gap',
      repairability: 'historical_gap',
      missing_fields: [],
      next_action: {
        kind: 'report_only',
        resume_condition: 'Record the observed state as read-only fact; do not repeat the action to mint missing prestate evidence.',
      },
      attempt_fingerprint: fingerprint(p, item, 'historical_evidence_gap'),
    }
  }
  return {
    ...base,
    certification: 'needs_evidence',
    reason_code: 'missing_evidence',
    repairability: 'agent_repairable',
    missing_fields: [],
    next_action: {
      kind: 'collect_evidence',
      tool: 'context_guard_prepare',
      resume_condition: 'Collect the matching durable evidence in resolution/effect/state order, then checkpoint.',
    },
    attempt_fingerprint: fingerprint(p, item, 'missing_evidence'),
  }
}

function fingerprint(p: GuardProjection, item: GuardItem, reason: string): string {
  return sha256(JSON.stringify([item.id, item.revision, p.contractRevision, reason, item.verification.subject ?? null]))
}

/** Legacy compact view, now derived from the single unified diagnosis. */
export function itemDiagnosis(p: GuardProjection, item: GuardItem): { certifiable: boolean; reason_code: string; next_step: string } {
  const diagnosis = deriveItemDiagnosis(p, item)
  const nextStep = diagnosis.next_action.resume_condition
    ?? (diagnosis.next_action.kind === 'collect_evidence' ? 'Collect matching durable evidence, then call context_guard_checkpoint with bindings.' : diagnosis.next_action.required_input)
    ?? 'No further action needed.'
  return {
    certifiable: diagnosis.reason_code === 'missing_evidence' || diagnosis.reason_code === 'certified',
    reason_code: diagnosis.reason_code,
    next_step: nextStep,
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
