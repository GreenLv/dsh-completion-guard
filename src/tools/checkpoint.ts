import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { certifyCheckpoint } from '../domain/checkpoint.js'
import { ACTION_MANIFEST, isStatefulAction } from '../domain/protocol-manifest.js'
import { availableBoundaryQualifications } from '../domain/boundary.js'
import type { EvidenceBinding, ExpectedTransition, GuardEvidence, GuardItem, GuardProjection, TargetTuple } from '../domain/types.js'

export interface CheckpointArgs {
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
  }>
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
  return [...projection.evidence.values()].filter((evidence) => evidence.epoch === projection.epoch
    && evidence.outcome === 'success'
    && evidence.semanticAction === item.semanticAction)
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
  return {
    id: item.id,
    kind: item.kind,
    semantic_action: action,
    requested_target: targetForTool(item.requestedTarget),
    certifiable: action !== 'generic_run' && ACTION_MANIFEST.actions[action].evidenceProducer === 'supported'
      && !item.legacyFlags?.length && item.targetCaptureStatus !== 'clarification_required',
    producer_disposition: ACTION_MANIFEST.actions[action].evidenceProducer,
    ...(item.targetCaptureStatus ? { target_capture_status: item.targetCaptureStatus } : {}),
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
  } as Record<string, JsonValue>
}

export function createCheckpointTool(
  getProjection: () => GuardProjection | undefined,
  onRejected: () => void,
  prepare: () => Promise<boolean> = async () => true,
): ToolDefinition {
  return defineTool({
    name: 'context_guard_checkpoint',
    description: 'Request a completion certificate from existing durable evidence.',
    parameters: {
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
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['certified', 'incomplete', 'unknown'] },
          contract_revision: { type: 'integer' },
          open_items: { type: 'array', items: { type: 'object', additionalProperties: true } },
          available_evidence: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
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
          available_qualifications: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
            id: { type: 'string' }, kind: { type: 'string' }, disposition: { type: 'string' }, source: { type: 'string' }, status: { type: 'string' },
          } } },
          rejected_bindings: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
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
      }))
      const result = certifyCheckpoint(projection, bindings, `C${projection.checkpoints.length + 1}`, false)
      if (!result.checkpoint) onRejected()
      const available_evidence = [...projection.evidence.values()]
        .filter((evidence) => evidence.epoch === projection.epoch && evidence.outcome === 'success')
        .sort((a, b) => (a.id < b.id ? -1 : 1))
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
          adapter_disposition: evidence.parseStatus === 'supported' ? 'citable' as const : 'unavailable' as const,
          ...(evidence.reasonCode ? { reason_code: evidence.reasonCode } : {}),
        }))
      return {
        status: result.status,
        contract_revision: result.contractRevision,
        open_items: result.openItems.map((id) => projection.items.get(id)).filter((item): item is GuardItem => Boolean(item)).map((item) => openItemForTool(projection, item)),
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
          certification_digest: result.checkpoint.certificationDigest,
          goal_ref: result.checkpoint.goalRef ?? null,
        } } : {}),
      }
    },
  })
}
