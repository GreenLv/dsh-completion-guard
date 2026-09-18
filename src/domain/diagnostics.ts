import { sha256 } from './canonicalize.js'
import { ACTION_MANIFEST, SUPPORTED_EVIDENCE_ADAPTERS, actionCompatible, isStatefulAction, requestedTargetMatchesResolved } from './protocol-manifest.js'
import type { GuardEvidence, GuardItem, GuardProjection } from './types.js'
import { reasonClassOf, type ReasonClass } from './reason-class.js'
import {
  capabilityConsequence,
  capabilityFactOf,
  type CapabilityFact,
  type CapabilityGap,
  type CapabilityRemedy,
} from './capability-semantics.js'

export type TaskKind = 'inquiry' | 'action' | 'deliverable' | 'constraint' | 'unresolved'
export type CertificationSupport = 'supported' | 'unsupported' | 'needs_target' | 'needs_evidence' | 'unavailable'
/**
 * Whether anything can still be repaired, and by whom (0.5, corrected by 0.6.2
 * D062-01). `user_input_required` means a real root choice was never made
 * (a genuinely absent identity or target selection) — never a capability this
 * build simply does not have, and never a request to re-word an instruction.
 */
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
  /**
   * 0.6.2 D062-01: WHAT the guard knows and WHICH remedy is reachable, shared
   * by every consumer. `reason_code` stays the fine display code; the
   * capability fact explains the remedy, so no lane infers a root cause — or
   * invents a reachable path — from one enum.
   */
  capability: CapabilityFact
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
 * obligation's action completed successfully, but whose effect on the
 * obligation could not be attributed (0.6.1 W060-05; layered by 0.6.2
 * D062-02). The signal is the same either way — the operation-attribution
 * fact when the fact carries one, and the frozen parse status otherwise:
 * a command whose effect cannot be attributed cannot certify an obligation.
 *
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
    const unattributed = evidence.processFacts
      ? evidence.processFacts.operationAttribution === 'unknown'
      : evidence.parseStatus !== undefined && evidence.parseStatus !== 'supported'
    if (!unattributed) continue
    if (!['bash', 'pwsh', 'shell'].includes(evidence.toolName)) continue
    if (evidence.semanticAction !== undefined && evidence.semanticAction !== 'generic_run'
      && actionCompatible(action, evidence.semanticAction)) return evidence
  }
  return undefined
}

/**
 * The honest wording for an unattributable shell effect (0.6.2 D062-02). The
 * two causes are DIFFERENT facts and must not share one sentence: a command
 * that failed closed parsing was not securely parsed, while a compound runner
 * whose operation layer is unknown simply has no independent per-operation
 * result. Both refuse to claim execution either way, and both forbid
 * re-running the action to mint evidence.
 */
function unattributedExecutionCondition(evidence: GuardEvidence): string {
  const parsed = evidence.parseStatus === undefined || evidence.parseStatus === 'supported'
  const cause = parsed
    ? 'An ordinary shell command beginning with this action ran earlier in the session as an opaque multi-operation script, and the host declared no independent per-operation result, so whether it performed this action cannot be established'
    : 'An ordinary shell command beginning with this action succeeded earlier in the session, but the command could not be securely parsed, so whether it performed the action cannot be established'
  return `${cause}. Check the actual current state with a read-only command first. The obligation stays uncertified; perform the action through the guarded producer path only if the state shows it has not happened and the instruction still calls for it; never repeat an action to mint evidence, and do not assert it never ran.`
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

  /**
   * 0.6.2 D062-01: every verdict carries the shared capability fact for its own
   * gap. The per-lane override only names the gap KIND; the consequence text
   * and the reachable-remedy rules stay in one place, so a new branch cannot
   * drift into demanding user input for a capability this build lacks.
   */
  const verdict = (
    override: { certifiable?: boolean; gap: CapabilityGap; remedy: CapabilityRemedy; missing_facets?: UnifiedItemDiagnosis['missing_facets'] } & Omit<
      Omit<UnifiedItemDiagnosis, 'reason_class'>, 'item_id' | 'item_revision' | 'contract_revision' | 'task_kind' | 'missing_facets' | 'capability'
    >,
  ): Omit<UnifiedItemDiagnosis, 'reason_class'> => {
    const declared = capabilityFactOf(item)
    const capability: CapabilityFact = {
      actionSupported: declared.actionSupported,
      certifiable: override.certifiable ?? false,
      gap: override.gap,
      remedy: override.remedy,
      blockingReasonCodes: override.reason_code === 'missing_evidence' || override.reason_code === 'certified' || override.reason_code === 'answer_delivered'
        ? []
        : [override.reason_code],
    }
    const { certifiable: _certifiable, remedy: _remedy, gap: _gap, missing_facets: overrideFacets, ...rest } = override
    return { ...base, ...rest, ...(overrideFacets !== undefined ? { missing_facets: overrideFacets } : {}), capability }
  }

  if (item.kind === 'prohibition') {
    return verdict({
      gap: 'constraint', remedy: 'none',
      certification: 'unsupported',
      reason_code: 'prohibition_active',
      repairability: 'none',
      missing_fields: [],
      next_action: { kind: 'none', resume_condition: capabilityConsequence('constraint') },
      attempt_fingerprint: fingerprint(p, item, 'prohibition_active'),
    })
  }
  const action = item.semanticAction ?? 'generic_run'
  if (item.status === 'passed') {
    return verdict({
      gap: 'closed', remedy: 'none', certifiable: true,
      certification: 'supported', reason_code: 'certified', repairability: 'none', missing_fields: [],
      next_action: { kind: 'none', resume_condition: capabilityConsequence('closed') },
      attempt_fingerprint: fingerprint(p, item, 'certified'),
    })
  }
  if (item.status === 'answered') {
    // C03: a trusted delivery closed this information obligation. It certifies
    // delivery only — never accuracy or any execution.
    return verdict({
      gap: 'closed', remedy: 'none', certifiable: true,
      certification: 'supported', reason_code: 'answer_delivered', repairability: 'none',
      missing_fields: [], missing_facets: [],
      next_action: { kind: 'none', resume_condition: 'The host-confirmed final answer was delivered; no further binding needed.' },
      attempt_fingerprint: fingerprint(p, item, 'answer_delivered'),
    })
  }
  if (item.status === 'pending' && item.waitAuthorization?.kind === 'root_explicit_wait') {
    return verdict({
      gap: 'condition_pending', remedy: 'await_root_input',
      certification: 'unavailable', reason_code: 'root_condition_pending',
      // Only a real root choice is user input. The root already said "wait", so
      // the guard keeps the item open instead of asking the user again.
      repairability: 'user_input_required', missing_fields: [], missing_facets: [],
      next_action: {
        kind: 'none',
        resume_condition: `Wait for the matching trusted root input: ${item.resumeEvent ?? item.condition ?? item.normalizedText}. ${capabilityConsequence('condition_pending')}`,
      },
      attempt_fingerprint: fingerprint(p, item, 'root_condition_pending'),
    })
  }
  if (kind === 'inquiry') {
    // 0.6.0 D06-02: the inquiry lane is judged before any target capture, so
    // an inquiry whose change-verb maps to a stateful action is still answered
    // by delivery, never routed through target clarification or rebind.
    // 0.6.1 (W060-01): an attachment obligation additionally needs its own
    // interpretation record before its turn's answer can close it.
    const closable = p.boundaryProtocol !== undefined && p.boundaryProtocol >= 5
    if (item.asset !== undefined && !p.interpretationFacts.some((fact) => fact.itemId === item.id)) {
      return verdict({
        gap: 'delivery_pending', remedy: 'record_interpretation',
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
      })
    }
    return verdict({
      gap: closable ? 'delivery_pending' : 'interpretation_unknown',
      remedy: closable ? 'deliver_answer' : 'report_uncertified',
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
    })
  }
  // 0.6.1 (W060-02): the interpretation lane is judged before any target or
  // evidence machinery, so a conservatively-downgraded clause is never
  // re-read as executable work.
  if (item.authorityDisposition === 'informational') {
    const closable = p.boundaryProtocol !== undefined && p.boundaryProtocol >= 5
    return verdict({
      gap: closable ? 'delivery_pending' : 'interpretation_unknown',
      remedy: closable ? 'deliver_answer' : 'report_uncertified',
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
    })
  }
  if (item.authorityDisposition === 'unresolved') {
    return verdict({
      gap: 'interpretation_unknown', remedy: 'fresh_root_instruction',
      certification: 'unsupported',
      reason_code: 'interpretation_unresolved',
      repairability: 'none',
      missing_fields: [],
      missing_facets: [],
      next_action: {
        kind: 'report_only',
        resume_condition: capabilityConsequence('interpretation_unknown'),
      },
      attempt_fingerprint: fingerprint(p, item, 'interpretation_unresolved'),
    })
  }
  if (action !== 'generic_run' && !item.legacyFlags?.length && item.targetCaptureStatus === 'clarification_required') {
    const missingFields = item.targetCaptureReasonCode ? [TARGET_FIELD_REASONS[item.targetCaptureReasonCode] ?? item.targetCaptureReasonCode] : []
    return verdict({
      // A certification path exists for this action; the identity it must bind
      // to is the one thing the root never named, so the item is certifiable
      // once that field arrives. `certification: needs_target` states the same
      // thing for the legacy enum consumers.
      gap: 'target_missing', remedy: 'supply_target', certifiable: true,
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
    })
  }
  if (action === 'generic_run' || item.legacyFlags?.length) {
    // 0.6.2 D062-01 (W061-01): the historical answer asked the user for input
    // and pointed at a rebind. Neither is applicable here. A concrete action
    // the installed cohort has no certification adapter for is a CAPABILITY
    // fact, not a missing authorization: the work stays authorized and
    // ordinary, the item stays uncertified, and the guard says so instead of
    // recommending that the user restate the request as install/modify. The
    // one reachable replacement path — a fresh explicit root instruction
    // recorded through the item's own migration lane — is named as exactly
    // that, and only for a pre-0.5 item whose migration lane requires it.
    const legacyMigration = (item.legacyFlags?.length ?? 0) > 0
    return verdict({
      gap: legacyMigration ? 'legacy_migration_required' : 'missing_adapter',
      remedy: legacyMigration ? 'fresh_root_instruction' : 'report_uncertified_capability_gap',
      certification: 'unsupported',
      reason_code: 'generic_run_non_certifiable',
      repairability: legacyMigration ? 'historical_gap' : 'unsupported',
      missing_fields: [],
      next_action: {
        kind: 'report_only',
        resume_condition: capabilityConsequence(legacyMigration ? 'legacy_migration_required' : 'missing_adapter'),
      },
      attempt_fingerprint: fingerprint(p, item, 'generic_run_non_certifiable'),
    })
  }
  if (p.hostStatus !== 'supported') {
    return verdict({
      gap: 'host_unavailable', remedy: 'restore_host',
      certification: 'unavailable', reason_code: 'host_unavailable', repairability: 'unsupported', missing_fields: [],
      next_action: { kind: 'restore_host', resume_condition: 'Restore the audited host cohort; keep pending work visible at a qualified safe boundary.' },
      attempt_fingerprint: fingerprint(p, item, 'host_unavailable'),
    })
  }
  if (ACTION_MANIFEST.actions[action].evidenceProducer !== 'supported') {
    // The action is real, the target is known, and only the audited producer
    // is absent from this cohort: the reachable remedy is restoring that
    // capability, not asking the user for a different instruction.
    return verdict({
      gap: 'missing_adapter', remedy: 'restore_host',
      certification: 'unavailable', reason_code: 'adapter_unavailable', repairability: 'unsupported', missing_fields: [],
      next_action: { kind: 'restore_host', resume_condition: 'The audited adapter for this action is unavailable in the installed cohort.' },
      attempt_fingerprint: fingerprint(p, item, 'adapter_unavailable'),
    })
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
    return verdict({
      gap: 'operation_unattributable', remedy: 'readback_only',
      certification: 'unsupported',
      reason_code: 'execution_unattributable',
      repairability: 'historical_gap',
      missing_fields: [],
      next_action: {
        kind: 'report_only',
        resume_condition: unattributedExecutionCondition(unattributed),
      },
      attempt_fingerprint: fingerprint(p, item, 'execution_unattributable'),
    })
  }
  // An effect already recorded without its resolution prestate is a
  // historical gap: readback honestly, never re-execute to mint evidence.
  // Stateful-only (0.6.1, W060-04): a read-only verification never has a
  // change-chain prestate to lose, so it can never fall into this lane.
  if (statefulChain && missing_facets.includes('resolution') && !missing_facets.includes('effect')) {
    return verdict({
      gap: 'historical_preevidence_missing', remedy: 'readback_only',
      certification: 'unsupported',
      reason_code: 'historical_evidence_gap',
      repairability: 'historical_gap',
      missing_fields: [],
      next_action: {
        kind: 'report_only',
        resume_condition: 'Record the observed state as read-only fact; do not repeat the action to mint missing prestate evidence.',
      },
      attempt_fingerprint: fingerprint(p, item, 'historical_evidence_gap'),
    })
  }
  return verdict({
    gap: 'none', remedy: 'collect_evidence', certifiable: true,
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
  })
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

/**
 * The bounded, one-phrase form of a reachable remedy (0.6.2 D062-01). The
 * capability consequence above is the full explanation; a bounded page lists
 * many items, so it uses this phrase and leaves the prose to the detail and
 * preparation surfaces. Both come from the SAME capability fact.
 */
export function capabilityRemedyPhrase(remedy: CapabilityRemedy): string {
  switch (remedy) {
    case 'none': return 'No further action needed'
    case 'collect_evidence': return 'Collect matching evidence; then checkpoint'
    case 'supply_target': return 'Supply the exact target; then collect evidence'
    case 'await_root_input': return 'Wait for the trusted root input; keep pending'
    case 'deliver_answer': return 'Deliver the actual answer'
    case 'record_interpretation': return 'Read the attachment; record context_guard_interpret'
    case 'report_uncertified': return 'Report honestly; stays uncertified'
    case 'report_uncertified_capability_gap': return 'Report as uncertified'
    case 'restore_host': return 'Restore the audited host/adapter capability'
    case 'readback_only': return 'Read back the current state; do not re-execute'
    case 'fresh_root_instruction': return 'Report the actual outcome as uncertified'
  }
}
