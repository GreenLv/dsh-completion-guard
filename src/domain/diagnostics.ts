import { sha256 } from './canonicalize.js'
import { ACTION_MANIFEST, SUPPORTED_EVIDENCE_ADAPTERS, actionCompatible, isStatefulAction, requestedTargetMatchesResolved } from './protocol-manifest.js'
import type { GuardEvidence, GuardItem, GuardProjection } from './types.js'
import { reasonClassOf, type ReasonClass } from './reason-class.js'

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
  /** The seven-class label this fine-grained reason code belongs to (C12). */
  reason_class: ReasonClass
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

/**
 * The evidence roles the item's OWN obligation contract requires (0.6.1,
 * W060-04). A stateful change needs the full resolution/effect/state chain; a
 * read-only verification (inspect, test, verify, generic readback) needs ONE
 * matching fact in the `effect` role — exactly the manifest `simpleRecord`
 * accepts. Asking every obligation for all three roles made prepare and
 * diagnosis demand a change chain a read-only verification can never produce.
 */
function requiredEvidenceRoles(item: GuardItem): Array<'resolution' | 'effect' | 'state'> {
  return isStatefulAction(item.semanticAction ?? 'generic_run')
    ? ['resolution', 'effect', 'state']
    : ['effect']
}

function evidenceFacets(p: GuardProjection, item: GuardItem): Array<'resolution' | 'effect' | 'state'> {
  const present = new Set<'resolution' | 'effect' | 'state'>()
  for (const evidence of p.evidence.values()) {
    if (!relevantEvidence(p, item, evidence)) continue
    if (evidence.evidenceRole) present.add(evidence.evidenceRole)
  }
  return requiredEvidenceRoles(item).filter((facet) => !present.has(facet))
}

/**
 * An ordinary shell command whose TEXT ANCHORED at command position to this
 * obligation's action completed successfully, but which failed closed
 * parsing, so per-command execution cannot be established (0.6.1, W060-05).
 * Only the pre-existing head-anchored action signal counts: the guard does
 * NOT scan compound text for actions, because quoted data and short-circuit
 * control flow would fabricate observations. A failed command is not a
 * signal either.
 */
function unattributedExecutionOf(p: GuardProjection, item: GuardItem): GuardEvidence | undefined {
  const action = item.semanticAction
  if (!action || action === 'generic_run') return undefined
  for (const evidence of p.evidence.values()) {
    if (evidence.outcome !== 'success') continue
    if (evidence.parseStatus === undefined || evidence.parseStatus === 'supported') continue
    if (!['bash', 'pwsh', 'shell'].includes(evidence.toolName)) continue
    if (evidence.semanticAction !== undefined && evidence.semanticAction !== 'generic_run'
      && actionCompatible(action, evidence.semanticAction)) return evidence
  }
  return undefined
}

/**
 * The pure repair judge. It decides between: fixable from existing evidence,
 * missing pre-evidence, missing a user target choice, not supported by any
 * adapter, an executed-without-evidence historical gap, or nothing to do —
 * and it NEVER recommends a rebind that cannot change certification.
 */
/**
 * The unified diagnosis, with the frozen seven-class label attached (C12).
 *
 * The class is derived from whatever `reason_code` the judge decides, so a new
 * branch cannot drift from the classification table.
 */
export function deriveItemDiagnosis(p: GuardProjection, item: GuardItem): UnifiedItemDiagnosis {
  const diagnosis = judgeItemDiagnosis(p, item)
  return { ...diagnosis, reason_class: reasonClassOf(diagnosis.reason_code) }
}

function judgeItemDiagnosis(p: GuardProjection, item: GuardItem): Omit<UnifiedItemDiagnosis, 'reason_class'> {
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
  if (item.status === 'answered') {
    // C03: a trusted delivery closed this information obligation. It certifies
    // delivery only — never accuracy or any execution.
    return {
      ...base, certification: 'supported', reason_code: 'answer_delivered', repairability: 'none',
      missing_fields: [], missing_facets: [],
      next_action: { kind: 'none', resume_condition: 'The host-confirmed final answer was delivered; no further binding needed.' },
      attempt_fingerprint: fingerprint(p, item, 'answer_delivered'),
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
  if (kind === 'inquiry') {
    // 0.6.0 D06-02: the inquiry lane is judged before any target capture, so
    // an inquiry whose change-verb maps to a stateful action is still answered
    // by delivery, never routed through target clarification or rebind.
    // 0.6.1 (W060-01): an attachment obligation additionally needs its own
    // interpretation record before its turn's answer can close it.
    const closable = p.boundaryProtocol === 5
    if (item.asset !== undefined && !p.interpretationFacts.some((fact) => fact.itemId === item.id)) {
      return {
        ...base,
        certification: 'unsupported',
        reason_code: 'asset_interpretation_required',
        repairability: 'unsupported',
        missing_fields: [],
        missing_facets: [],
        next_action: {
          kind: 'report_only',
          tool: 'context_guard_interpret',
          required_input: `the item ID of the interpreted attachment (${item.id})`,
          resume_condition: 'Read the attachment, record it with context_guard_interpret for this item, and deliver the actual answer; the host-confirmed final response of a completed turn then closes this item. The record proves the asset was read, never that the interpretation is correct.',
        },
        attempt_fingerprint: fingerprint(p, item, 'asset_interpretation_required'),
      }
    }
    return {
      ...base,
      certification: 'unsupported',
      reason_code: closable ? 'inquiry_awaiting_delivery' : 'inquiry_non_certifiable',
      repairability: 'unsupported',
      missing_fields: [],
      missing_facets: [],
      next_action: {
        kind: 'report_only',
        resume_condition: closable
          ? 'Deliver the actual answer; the host-confirmed final response of a completed turn closes this item.'
          : 'Complete the investigation and report the actual answer; the item stays recorded as uncertified. No confirmation or rebind changes this.',
      },
      attempt_fingerprint: fingerprint(p, item, closable ? 'inquiry_awaiting_delivery' : 'inquiry_non_certifiable'),
    }
  }
  // 0.6.1 (W060-02): the interpretation lane is judged before any target or
  // evidence machinery, so a conservatively-downgraded clause is never
  // re-read as executable work.
  if (item.authorityDisposition === 'informational') {
    const closable = p.boundaryProtocol === 5
    return {
      ...base,
      certification: 'unsupported',
      reason_code: closable ? 'information_awaiting_delivery' : 'information_non_certifiable',
      repairability: 'unsupported',
      missing_fields: [],
      missing_facets: [],
      next_action: {
        kind: 'report_only',
        resume_condition: closable
          ? 'The trusted final response of this turn closes the recorded statement; it certifies the answer was delivered, never its accuracy.'
          : 'The recorded statement stays open as uncertified information; no confirmation, rebind, or execution changes this.',
      },
      attempt_fingerprint: fingerprint(p, item, closable ? 'information_awaiting_delivery' : 'information_non_certifiable'),
    }
  }
  if (item.authorityDisposition === 'unresolved') {
    return {
      ...base,
      certification: 'unsupported',
      reason_code: 'interpretation_unresolved',
      repairability: 'none',
      missing_fields: [],
      missing_facets: [],
      next_action: {
        kind: 'report_only',
        resume_condition: 'The clause could not be read as a concrete instruction; it stays recorded, non-executable, and never closes by delivery. A new explicit root instruction naming a supported action supersedes it.',
      },
      attempt_fingerprint: fingerprint(p, item, 'interpretation_unresolved'),
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
    return {
      ...base,
      certification: 'unsupported',
      reason_code: 'generic_run_non_certifiable',
      repairability: 'user_input_required',
      missing_fields: [],
      next_action: {
        kind: 'report_only',
        required_input: 'a concrete supported action and target for this obligation',
        resume_condition: 'A rebind proposal mapping this obligation to a concrete supported action and target is the only thing that replaces it; after the durable confirmation the original is superseded atomically. Similar re-phrasing changes nothing.',
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
  // An ordinary shell command beginning with this action completed earlier,
  // but the command could not be securely parsed, so whether it actually
  // performed the action CANNOT BE ESTABLISHED (0.6.1, W060-05). The verdict
  // claims nothing about execution — it records the guard's inability to
  // attribute compound-shell effects. The obligation stays uncertified:
  // check actual current state read-only first, never repeat the action to
  // mint evidence, never assert the action never ran. It fires only while NO
  // attributable role evidence exists — once a producer-chain fact is present
  // the item follows its normal evidence path.
  const statefulChain = isStatefulAction(action)
  const hasAttributableEvidence = requiredEvidenceRoles(item).some((role) => !missing_facets.includes(role))
  const unattributed = hasAttributableEvidence ? undefined : unattributedExecutionOf(p, item)
  if (unattributed) {
    return {
      ...base,
      certification: 'unsupported',
      reason_code: 'execution_unattributable',
      repairability: 'historical_gap',
      missing_fields: [],
      next_action: {
        kind: 'report_only',
        resume_condition: 'An ordinary shell command beginning with this action succeeded earlier in the session, but the command could not be securely parsed, so whether it performed the action cannot be established. Check the actual current state with a read-only command first. The obligation stays uncertified; perform the action through the guarded producer path only if the state shows it has not happened and the instruction still calls for it; never repeat an action to mint evidence, and do not assert it never ran.',
      },
      attempt_fingerprint: fingerprint(p, item, 'execution_unattributable'),
    }
  }
  // An effect already recorded without its resolution prestate is a
  // historical gap: readback honestly, never re-execute to mint evidence.
  // Stateful-only (0.6.1, W060-04): a read-only verification never has a
  // change-chain prestate to lose, so it can never fall into this lane.
  if (statefulChain && missing_facets.includes('resolution') && !missing_facets.includes('effect')) {
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
      resume_condition: statefulChain
        ? 'Collect the matching durable evidence in resolution/effect/state order, then checkpoint.'
        : 'Collect the single matching durable verification fact, then checkpoint.',
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
  // C04: a delegated subagent's answer is bounded evidence. It is recorded,
  // shown, and auditable, and it never closes a parent obligation — a
  // subagent finishing is not the parent task finishing.
  if (evidence.delegatedSubtask) return 'delegated_result_bounded'
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
