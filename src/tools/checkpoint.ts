import { checkpointPage, type PageQuery } from './checkpoint-page.js'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { capabilityRemedyPhrase, deriveItemDiagnosis, itemDiagnosis, relevantEvidence, evidenceAvailabilityReason } from '../domain/diagnostics.js'
import { certifyCheckpoint } from '../domain/checkpoint.js'
import { ACTION_MANIFEST, isStatefulAction } from '../domain/protocol-manifest.js'
import { availableBoundaryQualifications } from '../domain/boundary.js'
import { bindProofV2ToProjection, validateProofManifestV2, type ProofManifestV2 } from '../domain/proof.js'
import type { BindingActionClosure, EvidenceBinding, ExpectedTransition, GuardEvidence, GuardItem, GuardProjection, TargetTuple } from '../domain/types.js'
import { currentV6Feedback, sourceItemForCoreRequirement } from '../domain/v6-feedback.js'

export interface CheckpointArgs extends PageQuery {
  bindings: Array<{
    item_id: string
    evidence_ids: string[]
    semantic_action?: EvidenceBinding['semanticAction']
    requested_target?: EvidenceBinding['requestedTarget']
    resolved_target?: EvidenceBinding['resolvedTarget']
    observed_state?: EvidenceBinding['observedState']
    expected_transition?: {
      predicate_id: string
      version: number
      pred_params_kind: 'inline'
      parameters?: EvidenceBinding['requestedTarget']
      parameters_digest?: string
    }
    resolution_evidence_id?: string
    effect_evidence_id?: string
    state_evidence_ids?: string[]
    action_bindings?: Array<{
      action: BindingActionClosure['action']
      evidence_ids: string[]
      resolved_target: BindingActionClosure['resolvedTarget']
      order: number
    }>
  }>
  proof?: ProofManifestV2
}

function targetForTool(target: EvidenceBinding['resolvedTarget']): Record<string, JsonValue> {
  if (!target) return {}
  return Object.fromEntries(Object.entries(target).map(([key, value]) => {
    if (typeof value !== 'object' || value === null) return [key, value]
    const raw = value.v
    const jsonValue: JsonValue = raw === null || ['string', 'number', 'boolean'].includes(typeof raw)
      ? raw as JsonValue
      : String(raw)
    return [key, { k: value.k, v: jsonValue }]
  }))
}

function expectedParameters(action: NonNullable<GuardItem['semanticAction']>, resolved: TargetTuple, observed: TargetTuple): TargetTuple {
  if (action === 'inspect_remote_updates') {
    return { ...pick(resolved, ['remote', 'version']), ...pick(observed, ['upstream_oid']) }
  }
  return { expected_outcome: { k: 'e', v: 'success' }, min_matches: 1 }
}

function expectedTransitionForTool(transition: ExpectedTransition): Record<string, JsonValue> {
  return {
    predicate_id: transition.predicateId,
    version: transition.version,
    pred_params_kind: transition.predParamsKind,
    ...(transition.parameters ? { parameters: targetForTool(transition.parameters) } : {}),
    ...(transition.parametersDigest ? { parameters_digest: transition.parametersDigest } : {}),
  }
}

function pick(tuple: TargetTuple, keys: string[]): TargetTuple {
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(tuple, key)).map((key) => [key, tuple[key]]))
}

function sameTuple(left: TargetTuple | undefined, right: TargetTuple | undefined): boolean {
  const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(',')}}`
      : JSON.stringify(value)
  return stable(left ?? {}) === stable(right ?? {})
}

function evidenceForAction(projection: GuardProjection, item: GuardItem): GuardEvidence[] {
  return [...projection.evidence.values()].filter((evidence) => relevantEvidence(projection, item, evidence))
}

function bindingTemplate(projection: GuardProjection, item: GuardItem): Record<string, JsonValue> | undefined {
  const action = item.semanticAction
  if (!action || action === 'generic_run') return undefined
  const evidence = evidenceForAction(projection, item)
  const effect = evidence.find((entry) => (entry.evidenceRole ?? 'effect') === 'effect')
  if (!effect?.resolvedTarget) return undefined
  const resolved = effect.resolvedTarget
  const resolution = isStatefulAction(action)
    ? evidence.find((entry) => entry.evidenceRole === 'resolution' && sameTuple(entry.resolvedTarget, resolved))
    : undefined
  const states = isStatefulAction(action)
    ? evidence.filter((entry) => entry.evidenceRole === 'state' && sameTuple(entry.resolvedTarget, resolved))
    : []
  if (isStatefulAction(action) && (!resolution || states.length === 0)) return undefined
  if (isStatefulAction(action) && (!resolution?.expectedTransition?.parameters || !resolution.expectedTransitionDigest)) return undefined
  const observed: TargetTuple = isStatefulAction(action)
    ? Object.assign({}, ...states.map((entry) => entry.observedState ?? {}))
    : effect.observedState ?? {}
  const expectedTransition: ExpectedTransition = isStatefulAction(action)
    ? resolution!.expectedTransition!
    : {
        predicateId: ACTION_MANIFEST.actions[action].predicateId,
        version: 1,
        predParamsKind: 'inline',
        parameters: expectedParameters(action, resolved, observed),
      }
  return {
    item_id: item.id,
    evidence_ids: (isStatefulAction(action) ? [resolution!.id, effect.id, ...states.map((entry) => entry.id)] : [effect.id]) as JsonValue,
    semantic_action: action,
    requested_target: targetForTool(item.requestedTarget),
    resolved_target: targetForTool(resolved),
    observed_state: targetForTool(observed),
    expected_transition: expectedTransitionForTool(expectedTransition),
    ...(isStatefulAction(action) ? {
      resolution_evidence_id: resolution!.id,
      effect_evidence_id: effect.id,
      state_evidence_ids: states.map((entry) => entry.id),
    } : { effect_evidence_id: effect.id }),
  } as Record<string, JsonValue>
}

function openItemForTool(projection: GuardProjection, item: GuardItem): Record<string, JsonValue> {
  const action = item.semanticAction ?? 'generic_run'
  const spec = ACTION_MANIFEST.actions[action]
  const template = bindingTemplate(projection, item)
  const diagnosis = deriveItemDiagnosis(projection, item)
  const compact = itemDiagnosis(projection, item)
  const row = {
    id: item.id,
    revision: item.revision,
    status: item.status,
    ...(item.supersededByItems ? { superseded_by_items: item.supersededByItems } : {}),
    ...(item.supersededBy ? { superseded_by: item.supersededBy } : {}),
    ...(item.reboundFrom ? { rebound_from: item.reboundFrom } : {}),
    text: item.normalizedText,
    kind: item.kind,
    semantic_action: action,
    requested_target: targetForTool(item.requestedTarget),
    certifiable: compact.certifiable,
    reason_code: diagnosis.reason_code,
    // The bounded page keeps the item row small: the remedy phrase is the
    // machine-readable capability remedy (0.6.2 D062-01), not the full
    // resume-condition prose, which the detail/prepare surfaces carry. A
    // declared ROOT WAIT is the exception — its exact resume event is the one
    // fact a caller must not lose, so that condition travels verbatim.
    next_step: diagnosis.capability.remedy === 'await_root_input'
      ? (diagnosis.next_action.resume_condition ?? capabilityRemedyPhrase(diagnosis.capability.remedy)).slice(0, 240)
      : capabilityRemedyPhrase(diagnosis.capability.remedy),
    ...(item.targetCaptureStatus ? { target_capture_status: item.targetCaptureStatus } : {}),
    // 0.6.2 D062-01: the shared capability fact travels with the item, so a
    // consumer learns WHY certification is unavailable and WHICH remedy is
    // reachable instead of inferring a user-input gap from one enum.
    capability: {
      action_supported: diagnosis.capability.actionSupported,
      certifiable: diagnosis.capability.certifiable,
      gap: diagnosis.capability.gap,
      remedy: diagnosis.capability.remedy,
    },
    producer_disposition: ACTION_MANIFEST.actions[action].evidenceProducer,
    ...(item.targetCaptureReasonCode ? { target_capture_reason_code: item.targetCaptureReasonCode } : {}),
    predicate: {
      predicate_id: spec.predicateId,
      version: 1,
      parameters_source: isStatefulAction(action) ? 'resolution_evidence_expected_transition' : 'versioned_action_manifest',
      resolved_target_keys: spec.resolvedTargetKeys,
      observed_state_keys: spec.observedStateKeys,
      pred_params_kind: 'inline',
    },
    ...(template ? { binding_template: template } : {}),
  }
  return row as Record<string, JsonValue>
}

export function createCheckpointTool(
  getProjection: () => GuardProjection | undefined,
  onRejected: () => void,
  prepare: () => Promise<boolean> = async () => true,
): ToolDefinition {
  return defineTool({
    name: 'context_guard_checkpoint',
    description: 'Read current ordinary closure from confirmed observations; request a certificate only for an explicitly adopted proof, Goal, or release contract.',
    parameters: {
      item_ids: { type: 'array', items: { type: 'string' } },
      evidence_ids: { type: 'array', items: { type: 'string' } },
      evidence_scope: { type: 'string', enum: ['relevant', 'history'] },
      cursor: { type: 'string' },
      limit: { type: 'integer' },
      detail_id: { type: 'string' },
      detail_offset: { type: 'integer' },
      detail_snapshot: { type: 'string' },
      // C09/S09: an optional v2 proof manifest. It is validated and bound
      // against the replayed projection through the production entry, so a
      // manifest that does not bind the item's own subjects, source, operation
      // and coverage cannot be presented as proof.
      proof: { type: 'object', additionalProperties: true },
      bindings: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            item_id: { type: 'string', required: true },
            evidence_ids: { type: 'array', required: true, items: { type: 'string' } },
            semantic_action: { type: 'string' },
            requested_target: { type: 'object', additionalProperties: true },
            resolved_target: { type: 'object', additionalProperties: true },
            observed_state: { type: 'object', additionalProperties: true },
            expected_transition: {
              type: 'object',
              additionalProperties: false,
              properties: {
                predicate_id: { type: 'string', required: true },
                version: { type: 'integer', required: true },
                pred_params_kind: { type: 'string', required: true, enum: ['inline'] },
                parameters: { type: 'object', additionalProperties: true },
                parameters_digest: { type: 'string' },
              },
            },
            resolution_evidence_id: { type: 'string' },
            effect_evidence_id: { type: 'string' },
            state_evidence_ids: { type: 'array', items: { type: 'string' } },
            action_bindings: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  action: { type: 'string', required: true },
                  evidence_ids: { type: 'array', required: true, items: { type: 'string' } },
                  resolved_target: { type: 'object', required: true, additionalProperties: true },
                  order: { type: 'integer', required: true },
                },
              },
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          blockers: { type: 'object', additionalProperties: true },
          pagination: { type: 'object', additionalProperties: true },
          proof_state: {
            type: 'object', additionalProperties: false,
            properties: {
              status: { type: 'string', enum: ['absent', 'bound', 'rejected', 'invalid'] },
              reason_codes: { type: 'array', items: { type: 'string' } },
            },
          },
          reason_code: { type: 'string' },
          next_step: { type: 'string' },
          detail_id: { type: 'string' },
          detail_offset: { type: 'integer' },
          detail_chunk: { type: 'string' },
          next_detail_offset: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          snapshot: { type: 'string' },
          status: { type: 'string', enum: ['certified', 'observed', 'incomplete', 'unknown'] },
          feedback_source: { type: 'string', enum: ['confirmed_core_v2'] },
          current_actions: { type: 'array', items: { type: 'object', additionalProperties: true } },
          current_action_total: { type: 'integer' },
          certificate_status: { type: 'string', enum: ['not_requested'] },
          contract_revision: { type: 'integer' },
          active_constraints: { type: 'array', items: { type: 'object', additionalProperties: true } },
          open_items: { type: 'array', items: { type: 'object', additionalProperties: true } },
          available_evidence: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                id: { type: 'string' },
                call_id: { type: 'string' },
                tool: { type: 'string' },
                subjects: { type: 'array', items: { type: 'string' } },
                surfaces: { type: 'array', items: { type: 'string' } },
                outcome: { type: 'string' },
                capabilities: { type: 'array', items: { type: 'string' } },
                operations: { type: 'array', items: { type: 'string' } },
                executables: { type: 'array', items: { type: 'string' } },
                semantic_action: { type: 'string' },
                evidence_role: { type: 'string', enum: ['resolution', 'effect', 'state'] },
                resolved_target: { type: 'object', additionalProperties: true },
                observed_state: { type: 'object', additionalProperties: true },
                expected_transition: { type: 'object', additionalProperties: true },
                expected_transition_digest: { type: 'string' },
                parse_status: { type: 'string' },
                reason_code: { type: 'string' },
                adapter_id: { type: 'string' },
                adapter_version: { type: 'string' },
                adapter_disposition: { type: 'string', enum: ['citable', 'unavailable'] },
              },
            },
          },
          available_qualifications: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {
            id: { type: 'string' }, kind: { type: 'string' }, disposition: { type: 'string' }, source: { type: 'string' }, status: { type: 'string' },
          } } },
          rejected_bindings: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                item_id: { type: 'string' },
                reason: { type: 'string' },
                reason_code: { type: 'string' },
                offending_evidence_ids: { type: 'array', items: { type: 'string' } },
                hint: { type: 'string' },
              },
            },
          },
          certificate: {
            type: 'object', additionalProperties: false,
            properties: {
              stop_protocol_version: { type: 'string' }, certificate_version: { type: 'string' }, epoch: { type: 'integer' },
              session_ref_digest: { type: 'string' }, host_lock_digest: { type: 'string' }, contract_revision: { type: 'integer' },
              contract_sha256: { type: 'string' }, open_digest: { type: 'string' }, evidence_sha256: { type: 'string' },
              binding_digest: { type: 'string' }, certification_digest: { type: 'string' },
              unit_id: { type: 'string' }, unit_closure_digest: { type: 'string' },
              root_locator_identity: { type: 'string' },
              native_observations: { type: 'object', additionalProperties: false, properties: {
                schema: { type: 'string', required: true }, digests: { type: 'array', required: true, items: { type: 'string' } },
              } },
              goal_ref: { oneOf: [
                { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, revision: { type: 'integer' } } },
                { type: 'null' },
              ] },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(rawArgs) {
      const args = rawArgs as unknown as CheckpointArgs
      const durable = await prepare()
      const projection = getProjection()
      if (!durable || !projection) {
        onRejected()
        return { status: 'unknown' as const, contract_revision: 0, open_items: [], available_evidence: [], available_qualifications: [], rejected_bindings: [] }
      }
      const currentFeedback = args.proof === undefined ? currentV6Feedback(projection) : undefined
      if (currentFeedback) {
        const openRows = currentFeedback.openIds.map((id) => {
          const sourced = sourceItemForCoreRequirement(projection, id)
          return {
            id, reason_code: currentFeedback.predicates[id],
            ...(sourced ? { source_item_id: sourced.item.id, revision: sourced.item.revision,
              kind: sourced.item.kind, text: sourced.item.normalizedText } : {}),
            ...(sourced?.origin ? { source_start: sourced.origin.sourceStart, source_end: sourced.origin.sourceEnd,
              semantic_action: sourced.origin.action, target: sourced.origin.target } : {}),
            next_step: 'Answer this sourced requirement using the current Host observation or final delivery; ordinary Guard bindings are not required.',
          }
        })
        const constraints = Object.entries(currentFeedback.predicates)
          .filter(([, state]) => state === 'constraint_active' || state === 'constraint_unresolved' || state === 'constraint_violated')
          .map(([id, state]) => ({ id, reason_code: state }))
        return checkpointPage(projection, args, {
          status: currentFeedback.status,
          reason_code: currentFeedback.reasonCode,
          current_feedback: true,
          contract_revision: projection.contractRevision,
          blocking_total: openRows.length,
          open_items: openRows,
          active_constraints: constraints,
          available_evidence: [], available_qualifications: [], rejected_bindings: [],
          current_actions: currentFeedback.currentActions,
        })
      }
      const bindings: EvidenceBinding[] = args.bindings.map((binding) => ({
        itemId: binding.item_id,
        evidenceIds: binding.evidence_ids,
        ...(binding.semantic_action ? { semanticAction: binding.semantic_action } : {}),
        ...(binding.requested_target ? { requestedTarget: binding.requested_target } : {}),
        ...(binding.resolved_target ? { resolvedTarget: binding.resolved_target } : {}),
        ...(binding.observed_state ? { observedState: binding.observed_state } : {}),
        ...(binding.expected_transition ? { expectedTransition: {
          predicateId: binding.expected_transition.predicate_id,
          version: binding.expected_transition.version,
          predParamsKind: binding.expected_transition.pred_params_kind,
          ...(binding.expected_transition.parameters ? { parameters: binding.expected_transition.parameters } : {}),
          ...(binding.expected_transition.parameters_digest ? { parametersDigest: binding.expected_transition.parameters_digest } : {}),
        } } : {}),
        ...(binding.resolution_evidence_id ? { resolutionEvidenceId: binding.resolution_evidence_id } : {}),
        ...(binding.effect_evidence_id ? { effectEvidenceId: binding.effect_evidence_id } : {}),
        ...(binding.state_evidence_ids ? { stateEvidenceIds: binding.state_evidence_ids } : {}),
        ...(binding.action_bindings ? { actionBindings: binding.action_bindings.map((closure) => ({
          action: closure.action,
          evidenceIds: closure.evidence_ids,
          resolvedTarget: closure.resolved_target,
          order: closure.order,
        })) } : {}),
      }))
      // A presented proof is bound BEFORE any certificate is issued: an
      // unbound proof makes the query fail closed with its exact reasons
      // instead of yielding a certificate that ignores it.
      let proofState: { status: 'absent' | 'bound' | 'rejected' | 'invalid'; reason_codes: string[] } = { status: 'absent', reason_codes: [] }
      if (args.proof !== undefined) {
        const structural = validateProofManifestV2(args.proof)
        if (structural.length) proofState = { status: 'invalid', reason_codes: structural }
        else {
          const binding = bindProofV2ToProjection(projection, args.proof)
          proofState = binding.length
            ? { status: 'rejected', reason_codes: binding }
            : { status: 'bound', reason_codes: [] }
        }
      }
      const result = proofState.status === 'rejected' || proofState.status === 'invalid'
        ? { status: 'incomplete' as const, contractRevision: projection.contractRevision, openItems: [], rejectedBindings: [] }
        : certifyCheckpoint(projection, bindings, `C${projection.checkpoints.length + 1}`, false)
      if (proofState.status === 'rejected' || proofState.status === 'invalid') {
        for (const code of proofState.reason_codes) {
          result.rejectedBindings.push({ itemId: '*', reason: 'the presented proof does not bind the current contract', reasonCode: code })
        }
      }
      if (!result.checkpoint) onRejected()
      const available_evidence = [...projection.evidence.values()]
        .filter((evidence) => evidence.epoch === projection.epoch && (args.evidence_scope === 'history' || [...projection.items.values()].some(item => item.status === 'pending' && relevantEvidence(projection, item, evidence))))
        .sort((a, b) => b.toolResultSeq - a.toolResultSeq || (a.id < b.id ? -1 : 1))
        .map((evidence) => ({
          id: evidence.id,
          call_id: evidence.callId,
          tool: evidence.toolName,
          subjects: evidence.subjects,
          surfaces: evidence.surfaces,
          outcome: evidence.outcome,
          capabilities: evidence.capabilities,
          operations: (evidence.operations ?? []).map((entry) => entry.op),
          executables: evidence.executables ?? [],
          semantic_action: evidence.semanticAction ?? 'generic_run',
          evidence_role: evidence.evidenceRole ?? 'effect',
          resolved_target: targetForTool(evidence.resolvedTarget),
          observed_state: targetForTool(evidence.observedState),
          ...(evidence.expectedTransition ? { expected_transition: expectedTransitionForTool(evidence.expectedTransition) } : {}),
          ...(evidence.expectedTransitionDigest ? { expected_transition_digest: evidence.expectedTransitionDigest } : {}),
          parse_status: evidence.parseStatus ?? 'adapter_unavailable',
          ...(evidence.adapterId ? { adapter_id: evidence.adapterId } : {}),
          ...(evidence.adapterVersion ? { adapter_version: evidence.adapterVersion } : {}),
          adapter_disposition: evidenceAvailabilityReason(evidence) === undefined ? 'citable' as const : 'unavailable' as const,
          ...(evidenceAvailabilityReason(evidence) ? { reason_code: evidenceAvailabilityReason(evidence) } : {}),
          // 0.6.2 D062-02: the derived layers, so a caller never reads the old
          // `outcome: success` as "an exit code of 0 was read". These are
          // display/consumer facts, excluded from every certificate domain.
          //
          // `source` and `frozen_outcome_conflict` are part of the contract, not
          // optional decoration: the frozen `outcome` deliberately keeps the
          // pre-0.6.2 rule, so a caller that sees `process_outcome` differ from
          // `outcome` must be able to learn WHICH source declared it and that
          // the two readings disagree (0.6.2 review). Omitting them left the
          // caller with two unexplained values.
          ...(evidence.processFacts ? {
            process_facts: {
              host_tool_returned: evidence.processFacts.hostToolReturned,
              declared_exit_code: evidence.processFacts.declaredExitCode === 'unknown' ? 'unknown' as const : evidence.processFacts.declaredExitCode,
              terminal_marker_read: evidence.processFacts.terminalMarkerRead,
              process_outcome: evidence.processFacts.outcome,
              outcome_reason: evidence.processFacts.outcomeReason,
              source: evidence.processFacts.source,
              frozen_outcome_conflict: evidence.processFacts.frozenOutcomeConflict,
              operation_attribution: evidence.processFacts.operationAttribution,
              ...(evidence.processFacts.declaredOperationResults ? {
                declared_operation_results: evidence.processFacts.declaredOperationResults.map((row) => ({
                  action: row.action, outcome: row.outcome,
                })),
              } : {}),
            },
          } : {}),
        }))
      return checkpointPage(projection, args, {
        status: result.status,
        proof_state: proofState,
        contract_revision: result.contractRevision,
        blocking_total: result.openItems.length,
        open_items: (args.item_ids?.length ? args.item_ids : result.openItems).map((id) => projection.items.get(id)).filter((item): item is GuardItem => Boolean(item)).sort((a, b) => b.revision - a.revision || a.id.localeCompare(b.id)).map((item) => openItemForTool(projection, item)),
        active_constraints: [...projection.items.values()].filter(item => item.kind === 'prohibition' && item.status === 'pending').map(item => openItemForTool(projection, item)),
        available_evidence,
        available_qualifications: availableBoundaryQualifications(projection).map((row) => ({
          id: row.id, kind: row.kind, disposition: row.disposition, source: row.source, status: row.status,
        })),
        rejected_bindings: result.rejectedBindings.map((binding) => ({
          item_id: binding.itemId,
          reason: binding.reason,
          reason_code: binding.reasonCode,
          ...(binding.offendingEvidenceIds ? { offending_evidence_ids: binding.offendingEvidenceIds } : {}),
          ...(binding.hint !== undefined ? { hint: binding.hint } : {}),
        })),
        ...(result.checkpoint ? { certificate: {
          stop_protocol_version: result.checkpoint.stopProtocolVersion,
          certificate_version: result.checkpoint.certificateVersion,
          epoch: result.checkpoint.epoch,
          session_ref_digest: result.checkpoint.sessionRefDigest,
          host_lock_digest: result.checkpoint.hostLockDigest,
          contract_revision: result.checkpoint.contractRevision,
          contract_sha256: result.checkpoint.contractSha256,
          open_digest: result.checkpoint.openDigest,
          evidence_sha256: result.checkpoint.evidenceSha256,
          binding_digest: result.checkpoint.bindingDigest,
          ...(result.checkpoint.nativeObservations ? { native_observations: result.checkpoint.nativeObservations } : {}),
          ...(result.checkpoint.rootLocatorIdentity ? { root_locator_identity: result.checkpoint.rootLocatorIdentity } : {}),
          certification_digest: result.checkpoint.certificationDigest,
          ...(result.checkpoint.unitId !== undefined ? {
            unit_id: result.checkpoint.unitId,
            unit_closure_digest: result.checkpoint.unitClosureDigest,
          } : {}),
          goal_ref: result.checkpoint.goalRef ?? null,
        } } : {}),
      })
    },
  })
}
