import { digestStrings, sha256 } from './canonicalize.js'
import { currentContractDigest } from './contract-digest.js'
import {
  bindingDigest as deriveBindingDigest, bindingStateClosure, certificationDigest,
  evidenceSha256Digest, predParamsDigest, resolveAllowlist,
  type BindingRecord, type EvidenceFact, type Typed,
} from './digest.js'
import { bindingSatisfies, evidenceCoverage } from './matching.js'
import { closingHint } from './recovery.js'
import {
  ACTION_MANIFEST, CERTIFICATE_VERSION, STOP_PROTOCOL_VERSION,
  actionCompatible, isStatefulAction, requestedTargetMatchesResolved, validateActionTarget,
  type SemanticAction,
} from './protocol-manifest.js'
import type {
  EvidenceBinding, ExpectedTransition, GuardCheckpoint, GuardEvidence,
  GuardItem, GuardProjection, TargetTuple,
} from './types.js'

export interface RejectedBinding {
  itemId: string
  reason: string
  reasonCode: string
  offendingEvidenceIds?: string[]
  hint?: string
}

export interface CheckpointResult {
  status: GuardCheckpoint['result']
  contractRevision: number
  openItems: string[]
  rejectedBindings: RejectedBinding[]
  checkpoint?: GuardCheckpoint
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function tuplesEqual(left: TargetTuple | undefined, right: TargetTuple | undefined): boolean {
  return stable(left ?? {}) === stable(right ?? {})
}

function transitionsEqual(left: ExpectedTransition | undefined, right: ExpectedTransition | undefined): boolean {
  return stable(left) === stable(right)
}

function transitionIsSelfConsistent(action: SemanticAction, transition: ExpectedTransition | undefined): boolean {
  if (!transition?.parameters
    || transition.predicateId !== ACTION_MANIFEST.actions[action].predicateId
    || transition.version !== 1
    || transition.predParamsKind !== 'inline') return false
  const recomputed = predParamsDigest(transition.parameters as Record<string, Typed>, resolveAllowlist('product'))
  return transition.parametersDigest === undefined || transition.parametersDigest === recomputed
}

function evidenceFact(evidence: GuardEvidence): EvidenceFact {
  return {
    id: evidence.id, outcome: evidence.outcome, method: evidence.toolName,
    operations: (evidence.operations ?? []).map((entry) => entry.op),
    executables: evidence.executables ?? [], subjects: evidence.subjects,
    surfaces: evidence.surfaces, semanticAction: evidence.semanticAction ?? 'generic_run',
    evidenceRole: evidence.evidenceRole ?? 'effect', resolvedTarget: evidence.resolvedTarget ?? {},
    observedState: evidence.observedState, parseStatus: evidence.parseStatus ?? 'adapter_unavailable',
    reasonCode: evidence.reasonCode ?? (evidence.parseStatus ? undefined : 'adapter_unavailable'),
    adapterId: evidence.adapterId, adapterVersion: evidence.adapterVersion,
  }
}

function citedEvidence(projection: GuardProjection, binding: EvidenceBinding): GuardEvidence[] {
  return binding.evidenceIds.map((id) => projection.evidence.get(id)).filter((value): value is GuardEvidence => value !== undefined)
}

function evidenceProblem(projection: GuardProjection, item: GuardItem, binding: EvidenceBinding): RejectedBinding | undefined {
  const missing = binding.evidenceIds.filter((id) => !projection.evidence.has(id))
  if (missing.length) return { itemId: item.id, reason: 'cited evidence is missing', reasonCode: 'evidence_missing', offendingEvidenceIds: missing }
  const wrongEpoch = binding.evidenceIds.filter((id) => projection.evidence.get(id)?.epoch !== projection.epoch)
  if (wrongEpoch.length) return { itemId: item.id, reason: 'cited evidence belongs to a different epoch', reasonCode: 'evidence_wrong_epoch', offendingEvidenceIds: wrongEpoch }
  const notSuccess = binding.evidenceIds.filter((id) => projection.evidence.get(id)?.outcome !== 'success')
  if (notSuccess.length) return { itemId: item.id, reason: 'cited evidence outcome is not success', reasonCode: 'evidence_outcome_not_success', offendingEvidenceIds: notSuccess }

  const requiredAction = item.semanticAction ?? 'generic_run'
  const facts = citedEvidence(projection, binding)
  const incompatible = facts.filter((fact) => !actionCompatible(requiredAction, fact.semanticAction ?? 'generic_run'))
  if (incompatible.length) {
    const compatibleCount = facts.length - incompatible.length
    return {
      itemId: item.id,
      reason: compatibleCount > 0 ? 'binding contains evidence that matches no required facet' : 'semantic action does not match the contract',
      reasonCode: compatibleCount > 0 ? 'evidence_matches_no_facet' : 'semantic_action_mismatch',
      offendingEvidenceIds: incompatible.map((fact) => fact.id),
      hint: compatibleCount > 0 ? `remove unrelated evidence: ${incompatible.map((fact) => fact.id).join(', ')}` : closingHint(projection, item, binding.evidenceIds),
    }
  }
  if (!isStatefulAction(requiredAction)) {
    const noFacet = facts.filter((fact) => {
      const coverage = evidenceCoverage(item, fact)
      return !coverage.artifact && !coverage.effect && !coverage.method && !coverage.verify && !coverage.run
    })
    if (noFacet.length) return {
      itemId: item.id, reason: 'binding contains evidence that matches no required facet', reasonCode: 'evidence_matches_no_facet',
      offendingEvidenceIds: noFacet.map((fact) => fact.id), hint: `remove unrelated evidence: ${noFacet.map((fact) => fact.id).join(', ')}`,
    }
  }
  return undefined
}

function expectedTransitionMatches(action: SemanticAction, transition: ExpectedTransition, resolved: TargetTuple, observed: TargetTuple): boolean {
  const expectedPredicate = ACTION_MANIFEST.actions[action].predicateId
  if (transition.predicateId !== expectedPredicate || transition.version !== 1 || transition.predParamsKind !== 'inline' || !transition.parameters) return false
  const params = transition.parameters
  const recomputed = predParamsDigest(params as Record<string, Typed>, resolveAllowlist('product'))
  if (transition.parametersDigest && transition.parametersDigest !== recomputed) return false
  switch (action) {
    case 'install':
    case 'apply':
    case 'publish':
      return [action === 'publish' ? 'artifact_id' : 'package_id', 'version', 'integrity_digest', ...(action === 'publish' ? ['registry'] : ['profile'])]
        .every((key) => stable(observed[key]) === stable(resolved[key]) && stable(params[key]) === stable(resolved[key]))
    case 'create':
    case 'modify': return stable(observed.post_digest) === stable(params.post_digest)
    case 'restart': return stable(params.pre_generation) === stable(resolved.pre_generation)
      && stable(observed.new_generation) !== stable(resolved.pre_generation)
      && stable(observed.health) === stable(params.health)
    case 'commit': return stable(params.pre_head_oid) === stable(resolved.pre_head_oid)
      && stable(params.change_set_digest) === stable(resolved.change_set_digest)
      && stable(observed.pre_head_oid) === stable(resolved.pre_head_oid)
      && stable(observed.post_head_oid) !== stable(resolved.pre_head_oid)
    case 'push': return stable(observed.remote_oid) === stable(resolved.local_oid) && stable(params.local_oid) === stable(resolved.local_oid)
    case 'pull': return stable(resolved.pull_mode) === stable('ff-only') && stable(params.pull_mode) === stable('ff-only')
      && stable(params.upstream_oid) === stable(resolved.upstream_oid)
      && stable(params.pre_head_oid) === stable(resolved.pre_head_oid)
      && stable(observed.post_head_oid) === stable(resolved.upstream_oid)
      && stable(observed.tracking_ref_oid) === stable(resolved.upstream_oid)
    case 'fetch': return stable(params.upstream_oid) === stable(resolved.upstream_oid)
      && stable(params.pre_head_oid) === stable(resolved.pre_head_oid)
      && stable(observed.tracking_ref_oid) === stable(resolved.upstream_oid)
      && stable(observed.post_head_oid) === stable(resolved.pre_head_oid)
    default: return true
  }
}

function nonStatefulTransitionMatches(action: SemanticAction, transition: ExpectedTransition, resolved: TargetTuple, observed: TargetTuple): boolean {
  if (transition.predicateId !== ACTION_MANIFEST.actions[action].predicateId
    || transition.version !== 1
    || transition.predParamsKind !== 'inline'
    || !transition.parameters) return false
  const params = transition.parameters
  const recomputed = predParamsDigest(params as Record<string, Typed>, resolveAllowlist('product'))
  if (transition.parametersDigest && transition.parametersDigest !== recomputed) return false
  if (action === 'inspect_remote_updates') {
    return ['remote', 'version'].every((key) => stable(params[key]) === stable(resolved[key]))
      && stable(params.upstream_oid) === stable(observed.upstream_oid)
  }
  return stable(params) === stable({ expected_outcome: { k: 'e', v: 'success' }, min_matches: 1 })
}

function richStatefulRecord(projection: GuardProjection, item: GuardItem, binding: EvidenceBinding): { record?: BindingRecord; rejected?: RejectedBinding } {
  const action = item.semanticAction
  if (!action || !isStatefulAction(action)) {
    return { rejected: { itemId: item.id, reason: 'stateful certificate path received a non-stateful action', reasonCode: 'semantic_action_mismatch' } }
  }
  if (!binding.semanticAction || binding.semanticAction !== action) {
    return { rejected: { itemId: item.id, reason: 'binding semantic action differs from the contract', reasonCode: 'semantic_action_mismatch' } }
  }
  if (!tuplesEqual(binding.requestedTarget, item.requestedTarget)) {
    return { rejected: { itemId: item.id, reason: 'requested target differs from the captured contract', reasonCode: 'requested_target_mismatch' } }
  }
  if (!requestedTargetMatchesResolved(action, item.requestedTarget, binding.resolvedTarget)) {
    return { rejected: { itemId: item.id, reason: 'resolved target differs from an identity named in the root instruction', reasonCode: 'requested_resolved_target_mismatch' } }
  }
  if (ACTION_MANIFEST.actions[action].evidenceProducer !== 'supported') {
    return { rejected: { itemId: item.id, reason: 'the pinned host exposes no safe independent producer for this action', reasonCode: 'stateful_adapter_unavailable' } }
  }
  if (!binding.resolutionEvidenceId || !binding.effectEvidenceId || !(binding.stateEvidenceIds?.length)) {
    return { rejected: { itemId: item.id, reason: 'stateful action requires distinct resolution, effect, and state evidence', reasonCode: 'effect_only_insufficient_state_readback' } }
  }
  if (!validateActionTarget(action, binding.resolvedTarget, binding.observedState)) {
    return { rejected: { itemId: item.id, reason: 'resolved target or observed state is incomplete', reasonCode: 'state_closure_incomplete' } }
  }
  const resolution = projection.evidence.get(binding.resolutionEvidenceId)
  const effect = projection.evidence.get(binding.effectEvidenceId)
  const states = binding.stateEvidenceIds.map((id) => projection.evidence.get(id)).filter((value): value is GuardEvidence => value !== undefined)
  if (!resolution || !effect || states.length !== binding.stateEvidenceIds.length) {
    return { rejected: { itemId: item.id, reason: 'role evidence is missing', reasonCode: 'evidence_missing' } }
  }
  if (resolution.evidenceRole !== 'resolution') {
    return { rejected: { itemId: item.id, reason: 'resolution evidence is paired to the wrong role', reasonCode: 'binding_resolution_cross_pairing' } }
  }
  if (effect.evidenceRole !== 'effect' || states.some((state) => state.evidenceRole !== 'state')) {
    return { rejected: { itemId: item.id, reason: 'evidence role matrix is invalid', reasonCode: 'binding_role_mismatch' } }
  }
  if (resolution.id === effect.id || states.some((state) => state.id === resolution.id || state.id === effect.id)) {
    return { rejected: { itemId: item.id, reason: 'resolution, effect, and state evidence must be distinct', reasonCode: 'binding_role_mismatch' } }
  }
  if (!(resolution.toolResultSeq < effect.toolResultSeq)
    || states.some((state) => !(effect.toolResultSeq < state.toolResultSeq))) {
    return { rejected: { itemId: item.id, reason: 'resolution must precede effect and independent state readback', reasonCode: 'binding_role_order_invalid' } }
  }
  if (!tuplesEqual(binding.resolvedTarget, resolution.resolvedTarget)) {
    return { rejected: { itemId: item.id, reason: 'resolution evidence is paired to a different target', reasonCode: 'binding_resolution_cross_pairing' } }
  }
  if (!tuplesEqual(binding.resolvedTarget, effect.resolvedTarget) || states.some((state) => !tuplesEqual(binding.resolvedTarget, state.resolvedTarget))) {
    return { rejected: { itemId: item.id, reason: 'effect/state evidence is paired to a different target', reasonCode: 'binding_state_cross_pairing' } }
  }
  const mergedObserved: TargetTuple = {}
  for (const state of states) {
    for (const [key, value] of Object.entries(state.observedState ?? {})) {
      if (Object.hasOwn(mergedObserved, key)) return { rejected: { itemId: item.id, reason: 'state observations overlap', reasonCode: 'binding_state_observation_overlap' } }
      mergedObserved[key] = value
    }
  }
  if (!tuplesEqual(binding.observedState, mergedObserved)) {
    return { rejected: { itemId: item.id, reason: 'binding observed state does not close over state facts', reasonCode: 'binding_observed_state_mismatch' } }
  }
  if (!resolution.expectedTransition?.parameters) {
    return { rejected: { itemId: item.id, reason: 'resolution fact does not freeze expected transition parameters', reasonCode: 'resolution_expected_transition_missing' } }
  }
  if (!resolution.expectedTransitionDigest) {
    return { rejected: { itemId: item.id, reason: 'resolution fact does not bind an expected transition digest', reasonCode: 'resolution_expected_transition_digest_missing' } }
  }
  if (resolution.expectedTransitionDigest !== sha256(stable(resolution.expectedTransition))) {
    return { rejected: { itemId: item.id, reason: 'resolution expected transition digest does not match its stable payload', reasonCode: 'resolution_expected_transition_digest_mismatch' } }
  }
  if (!transitionIsSelfConsistent(action, resolution.expectedTransition)) {
    return { rejected: { itemId: item.id, reason: 'resolution fact contains an invalid expected transition', reasonCode: 'resolution_expected_transition_invalid' } }
  }
  if (!transitionsEqual(binding.expectedTransition, resolution.expectedTransition)) {
    return { rejected: { itemId: item.id, reason: 'binding expected transition differs from the cited resolution fact', reasonCode: 'binding_expected_transition_mismatch' } }
  }
  if (!expectedTransitionMatches(action, resolution.expectedTransition, binding.resolvedTarget!, binding.observedState!)) {
    return { rejected: { itemId: item.id, reason: 'observed state does not satisfy the versioned expected transition', reasonCode: 'expected_transition_mismatch' } }
  }
  const record: BindingRecord = {
    item: item.id, semanticAction: action,
    requestedTarget: binding.requestedTarget as Record<string, Typed>, resolvedTarget: binding.resolvedTarget as Record<string, Typed>,
    observedState: binding.observedState as Record<string, Typed>, predId: resolution.expectedTransition.predicateId,
    predVersion: resolution.expectedTransition.version, predParamsKind: 'inline',
    predParams: resolution.expectedTransition.parameters as Record<string, Typed>, predParamsAllowlist: 'product',
    resolutionEvidenceId: binding.resolutionEvidenceId, effectEvidenceId: binding.effectEvidenceId,
    stateEvidenceIds: binding.stateEvidenceIds,
  }
  try {
    bindingStateClosure({ binding: record, resolution: evidenceFact(resolution), effect: evidenceFact(effect), states: states.map(evidenceFact), evidenceFacts: citedEvidence(projection, binding).map(evidenceFact) })
  } catch (error) {
    return { rejected: { itemId: item.id, reason: error instanceof Error ? error.message : 'state closure rejected', reasonCode: 'binding_state_closure_rejected' } }
  }
  return { record }
}

function simpleRecord(projection: GuardProjection, item: GuardItem, binding: EvidenceBinding): { record?: BindingRecord; rejected?: RejectedBinding } {
  if (!bindingSatisfies(projection, item, binding.evidenceIds)) {
    return { rejected: { itemId: item.id, reason: 'evidence does not match the current verification contract', reasonCode: 'binding_missing_required_facet', hint: closingHint(projection, item, binding.evidenceIds) } }
  }
  const action = item.semanticAction ?? 'generic_run'
  if (!binding.semanticAction || binding.semanticAction !== action) {
    return { rejected: { itemId: item.id, reason: 'binding semantic action differs from the contract', reasonCode: 'semantic_action_mismatch' } }
  }
  if (!tuplesEqual(binding.requestedTarget, item.requestedTarget)) {
    return { rejected: { itemId: item.id, reason: 'requested target differs from the captured contract', reasonCode: 'requested_target_mismatch' } }
  }
  if (!binding.effectEvidenceId || binding.resolutionEvidenceId || (binding.stateEvidenceIds?.length ?? 0) > 0) {
    return { rejected: { itemId: item.id, reason: 'non-stateful binding requires exactly one explicit effect role and no stateful role fields', reasonCode: 'non_stateful_role_manifest_invalid' } }
  }
  const effect = projection.evidence.get(binding.effectEvidenceId)
  if (!effect || !binding.evidenceIds.includes(effect.id)) {
    return { rejected: { itemId: item.id, reason: 'effect evidence is missing from the cited evidence set', reasonCode: 'evidence_missing' } }
  }
  if ((effect.evidenceRole ?? 'effect') !== 'effect') {
    return { rejected: { itemId: item.id, reason: 'non-stateful evidence is paired to a non-effect role', reasonCode: 'binding_role_mismatch' } }
  }
  if (!bindingSatisfies(projection, item, [effect.id])) {
    return { rejected: { itemId: item.id, reason: 'the explicit effect alone does not bind every required method, capability, and subject facet', reasonCode: 'binding_missing_required_facet', hint: closingHint(projection, item, [effect.id]) } }
  }
  const effectAction = effect.semanticAction ?? 'generic_run'
  const effectTarget = effect.resolvedTarget ?? {}
  const effectObserved = effect.observedState ?? {}
  const compatibleProjection = Object.entries(binding.resolvedTarget ?? {}).every(([key, value]) => (
    Object.hasOwn(effectTarget, key) && stable(value) === stable(effectTarget[key])
  )) && Object.entries(binding.observedState ?? {}).every(([key, value]) => (
    Object.hasOwn(effectObserved, key) && stable(value) === stable(effectObserved[key])
  ))
  if (!compatibleProjection || (effectAction === action
    && (!tuplesEqual(binding.resolvedTarget, effectTarget) || !tuplesEqual(binding.observedState, effectObserved)))) {
    return { rejected: { itemId: item.id, reason: 'binding target does not match the cited effect evidence', reasonCode: 'binding_state_cross_pairing' } }
  }
  if (!validateActionTarget(effectAction, effectTarget, effectObserved)) {
    return { rejected: { itemId: item.id, reason: 'cited effect violates its own closed action manifest', reasonCode: 'resolved_target_incomplete' } }
  }
  if (!validateActionTarget(action, binding.resolvedTarget, binding.observedState ?? {})) {
    return { rejected: { itemId: item.id, reason: 'effect lacks the action target required by the command manifest', reasonCode: 'resolved_target_incomplete' } }
  }
  if (!binding.expectedTransition || !nonStatefulTransitionMatches(action, binding.expectedTransition, binding.resolvedTarget!, binding.observedState ?? {})) {
    return { rejected: { itemId: item.id, reason: 'non-stateful expected transition does not match the action manifest', reasonCode: 'expected_transition_mismatch' } }
  }
  return { record: {
    item: item.id, semanticAction: action, requestedTarget: binding.requestedTarget as Record<string, Typed>,
    resolvedTarget: binding.resolvedTarget as Record<string, Typed>, observedState: (binding.observedState ?? {}) as Record<string, Typed>,
    predId: binding.expectedTransition.predicateId, predVersion: binding.expectedTransition.version,
    predParamsKind: 'inline', predParams: binding.expectedTransition.parameters as Record<string, Typed>,
    predParamsAllowlist: 'product', effectEvidenceId: binding.effectEvidenceId, stateEvidenceIds: [],
  } }
}

export function certifyCheckpoint(projection: GuardProjection, bindings: EvidenceBinding[], id: string, commit = true): CheckpointResult {
  if (projection.integrity !== 'valid' || projection.hostStatus !== 'supported') {
    return { status: 'unknown', contractRevision: projection.contractRevision, openItems: openItems(projection), rejectedBindings: [] }
  }
  const rejectedBindings: RejectedBinding[] = []
  const records: BindingRecord[] = []
  const referencedFacts: EvidenceFact[] = []
  for (const binding of bindings) {
    const item = projection.items.get(binding.itemId)
    if (!item || item.status === 'superseded') {
      rejectedBindings.push({ itemId: binding.itemId, reason: 'item is missing or superseded', reasonCode: 'item_missing_or_superseded' }); continue
    }
    if (item.legacyFlags?.includes('legacy_authority_unclassified')) {
      rejectedBindings.push({ itemId: item.id, reason: 'legacy item authority cannot be proven', reasonCode: 'legacy_authority_unclassified' }); continue
    }
    if (item.legacyFlags?.includes('legacy_generic_run')) {
      rejectedBindings.push({ itemId: item.id, reason: 'legacy generic-run item is non-certifiable until deterministic rebind', reasonCode: 'legacy_generic_run_non_certifiable' }); continue
    }
    if (item.targetCaptureStatus === 'clarification_required') {
      rejectedBindings.push({
        itemId: item.id,
        reason: 'the root instruction does not identify an action-specific target; clarify or explicitly rebind the item',
        reasonCode: item.targetCaptureReasonCode ?? 'clarification_or_rebind_required',
        hint: closingHint(projection, item),
      }); continue
    }
    if (!binding.evidenceIds.length) {
      rejectedBindings.push({ itemId: item.id, reason: 'no evidence cited', reasonCode: 'binding_missing_required_facet', hint: closingHint(projection, item) }); continue
    }
    const problem = evidenceProblem(projection, item, binding)
    if (problem) { rejectedBindings.push(problem); continue }
    if ((item.semanticAction ?? 'generic_run') === 'generic_run') {
      rejectedBindings.push({ itemId: item.id, reason: 'generic run evidence cannot prove a user-level completion contract', reasonCode: 'generic_run_non_certifiable' }); continue
    }
    const built = isStatefulAction(item.semanticAction ?? 'generic_run') ? richStatefulRecord(projection, item, binding) : simpleRecord(projection, item, binding)
    if (built.rejected) { rejectedBindings.push(built.rejected); continue }
    records.push(built.record!)
    referencedFacts.push(...citedEvidence(projection, binding).map(evidenceFact))
  }
  const open = openItems(projection).filter((itemId) => !bindings.some((binding) => binding.itemId === itemId))
  if (rejectedBindings.length || open.length) return { status: 'incomplete', contractRevision: projection.contractRevision, openItems: openItems(projection), rejectedBindings }
  try {
    const contractSha256 = currentContractDigest(projection)
    const openDigest = digestStrings(openItems(projection))
    const evidenceSha256 = evidenceSha256Digest(referencedFacts)
    const bindingDigest = deriveBindingDigest(records, resolveAllowlist('product'))
    const certification = certificationDigest({
      stopProtocolVersion: STOP_PROTOCOL_VERSION, certificateVersion: CERTIFICATE_VERSION, epoch: projection.epoch,
      sessionRefDigest: projection.sessionRefDigest, hostLockDigest: projection.hostLockDigest,
      contractRevision: projection.contractRevision, contractSha256,
      ...(projection.currentGoalRef ? { goalRef: projection.currentGoalRef } : {}), openDigest, evidenceSha256, bindingDigest,
    })
    const checkpoint: GuardCheckpoint = {
      id, stopProtocolVersion: STOP_PROTOCOL_VERSION, certificateVersion: CERTIFICATE_VERSION, epoch: projection.epoch,
      sessionRefDigest: projection.sessionRefDigest, hostLockDigest: projection.hostLockDigest,
      contractRevision: projection.contractRevision, contractSha256, openDigest, evidenceSha256, bindingDigest, bindings,
      ...(projection.currentGoalRef ? { goalRef: { ...projection.currentGoalRef } } : {}),
      certificationDigest: certification, result: 'certified',
    }
    if (commit) {
      projection.checkpoints.push(checkpoint)
      for (const binding of bindings) projection.items.get(binding.itemId)!.status = 'passed'
      projection.certificateStatusReason = undefined
    }
    return { status: 'certified', contractRevision: projection.contractRevision, openItems: [], rejectedBindings: [], checkpoint }
  } catch (error) {
    return { status: 'incomplete', contractRevision: projection.contractRevision, openItems: openItems(projection), rejectedBindings: [{ itemId: '*', reason: error instanceof Error ? error.message : 'certificate manifest rejected', reasonCode: 'certificate_manifest_rejected' }] }
  }
}

function openItems(projection: GuardProjection): string[] {
  return [...projection.items.values()].filter((item) => item.status === 'pending' && item.kind !== 'prohibition').map((item) => item.id)
}
