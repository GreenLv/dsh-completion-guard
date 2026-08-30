import { availableBoundaryQualifications, qualifyBoundary } from '../../src/domain/boundary.js'
import { certifyCheckpoint, type CheckpointResult } from '../../src/domain/checkpoint.js'
import { classifyUserInteraction } from '../../src/domain/conversation.js'
import { captureClause } from '../../src/domain/capture.js'
import { segmentAuthorityBlocks } from '../../src/domain/contract-segment.js'
import { deriveProjection } from '../../src/domain/derive.js'
import { goalCompletionDenial, hasCurrentCertificate } from '../../src/domain/goal-gate.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from '../../src/domain/host-lock.js'
import { ACTION_MANIFEST, isStatefulAction, semanticActionFromText, type SemanticAction } from '../../src/domain/protocol-manifest.js'
import { recoveryDigest, renderRecoveryPacket } from '../../src/domain/recovery.js'
import { sha256 } from '../../src/domain/canonicalize.js'
import { decideTurnBoundary, observeAssistantOutcome } from '../../src/domain/stop-policy.js'
import type {
  BoundaryDisposition, BoundaryQualificationKind, DerivedEnvelope, EvidenceBinding,
  GuardCheckpoint, GuardProjection, TargetTuple,
} from '../../src/domain/types.js'

export interface PortableEvent { type: string; [key: string]: unknown }
export interface PortableExpect {
  completed: boolean
  completion_allowed: boolean
  force_continue: boolean
  pending_preserved: boolean
  boundary: { disposition: string; persistedResult: string } | null
  integrity: string
  reason_codes: string[]
  offendingEvidenceIds?: string[]
}
export interface PortableCase { id: string; events: PortableEvent[]; expect: PortableExpect }

export interface PortableProduction {
  deriveProjection: typeof deriveProjection
  certifyCheckpoint: typeof certifyCheckpoint
  qualifyBoundary: typeof qualifyBoundary
  goalCompletionDenial: typeof goalCompletionDenial
  decideTurnBoundary: typeof decideTurnBoundary
  hasCurrentCertificate: typeof hasCurrentCertificate
}

export const PORTABLE_PRODUCTION: PortableProduction = {
  deriveProjection, certifyCheckpoint, qualifyBoundary, goalCompletionDenial, decideTurnBoundary, hasCurrentCertificate,
}

const WORKDIR = '/synthetic/workspace'
const X1 = '11'.repeat(32)
const X2 = '22'.repeat(32)
const PORTABLE_HOST_LOCK = evaluateHostLock(
  EXPECTED_HOST_PACKAGES.filter((row) => row.name !== '@deepseek-ai/dsh-goal' && row.name !== '@deepseek-ai/dsh-tool-goal'),
  { platform: 'posix', profileKind: 'web' },
)

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function textContent(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text }]
}

function checkpointJson(checkpoint: GuardCheckpoint): Record<string, unknown> {
  return {
    stop_protocol_version: checkpoint.stopProtocolVersion, certificate_version: checkpoint.certificateVersion,
    epoch: checkpoint.epoch, session_ref_digest: checkpoint.sessionRefDigest, host_lock_digest: checkpoint.hostLockDigest,
    contract_revision: checkpoint.contractRevision, contract_sha256: checkpoint.contractSha256,
    open_digest: checkpoint.openDigest, evidence_sha256: checkpoint.evidenceSha256,
    binding_digest: checkpoint.bindingDigest, certification_digest: checkpoint.certificationDigest,
    goal_ref: checkpoint.goalRef ?? null,
  }
}

function statefulTarget(action: SemanticAction, requested: TargetTuple | undefined): { resolved: TargetTuple; observed: TargetTuple; params: TargetTuple } {
  const repository = typeof requested?.repository === 'string' ? requested.repository : WORKDIR
  switch (action) {
    case 'install':
    case 'apply': {
      const packageId = typeof requested?.package_id === 'string' ? requested.package_id : 'synthetic-plugin'
      const version = typeof requested?.version === 'string' ? requested.version : '1.2.3'
      const profile = typeof requested?.profile === 'string' ? requested.profile : 'synthetic-profile'
      const resolved = { package_id: packageId, version, integrity_digest: X1, profile }
      return { resolved, observed: { ...resolved }, params: { ...resolved } }
    }
    case 'create':
    case 'modify': {
      const artifact = typeof requested?.artifact_id === 'string' ? requested.artifact_id : `${WORKDIR}/synthetic-artifact.txt`
      const scope = typeof requested?.scope === 'string' ? requested.scope : WORKDIR
      return {
        resolved: { artifact_id: artifact, scope, pre_digest: action === 'create' ? 'absent' : X1, change_set_digest: X2 },
        observed: { post_digest: '33'.repeat(32) }, params: { post_digest: '33'.repeat(32) },
      }
    }
    case 'pull': return {
      resolved: { repository, remote: 'origin', refspec: 'refs/heads/main', upstream_oid: X2, pre_head_oid: X1, pull_mode: 'ff-only' },
      observed: { post_head_oid: X2, tracking_ref_oid: X2 },
      params: { upstream_oid: X2, pre_head_oid: X1, pull_mode: 'ff-only' },
    }
    case 'fetch': return {
      resolved: { repository, remote: 'origin', refspec: 'refs/heads/main:refs/remotes/origin/main', upstream_oid: X2, pre_head_oid: X1 },
      observed: { tracking_ref_oid: X2, post_head_oid: X1 }, params: { upstream_oid: X2, pre_head_oid: X1 },
    }
    case 'push': return {
      resolved: { repository, remote: 'origin', refspec: 'refs/heads/main:refs/heads/main', local_oid: X1 },
      observed: { remote_oid: X1 }, params: { local_oid: X1 },
    }
    case 'commit': return {
      resolved: { repository, branch: 'main', change_set_digest: X1, pre_head_oid: X2 },
      observed: { post_head_oid: '33'.repeat(32), pre_head_oid: X2 }, params: { pre_head_oid: X2, change_set_digest: X1 },
    }
    case 'restart': {
      const service = typeof requested?.service_id === 'string' ? requested.service_id : 'synthetic-service'
      return {
        resolved: { service_id: service, pre_generation: 'generation-1' },
        observed: { new_generation: 'generation-2', health: 'healthy' },
        params: { pre_generation: 'generation-1', health: 'healthy' },
      }
    }
    case 'publish': {
      const artifact = typeof requested?.artifact_id === 'string' ? requested.artifact_id : 'synthetic-package'
      const version = typeof requested?.version === 'string' ? requested.version : '1.2.3'
      const registry = typeof requested?.registry === 'string' ? requested.registry : 'https://registry.example.invalid/'
      const resolved = { artifact_id: artifact, version, registry, integrity_digest: X1 }
      return { resolved, observed: { ...resolved }, params: { ...resolved } }
    }
    default: throw new Error(`portable fixture has no stateful expansion for ${action}`)
  }
}

function expectedParams(action: SemanticAction, resolved: TargetTuple, observed: TargetTuple): TargetTuple {
  switch (action) {
    case 'pull': return { pull_mode: resolved.pull_mode!, upstream_oid: resolved.upstream_oid!, pre_head_oid: resolved.pre_head_oid! }
    case 'fetch': return { upstream_oid: resolved.upstream_oid!, pre_head_oid: resolved.pre_head_oid! }
    case 'push': return { local_oid: resolved.local_oid! }
    case 'commit': return { pre_head_oid: resolved.pre_head_oid!, change_set_digest: resolved.change_set_digest! }
    case 'create':
    case 'modify': return { post_digest: observed.post_digest! }
    case 'install':
    case 'apply': return Object.fromEntries(['package_id', 'version', 'integrity_digest', 'profile'].map((key) => [key, resolved[key]]))
    case 'restart': return { pre_generation: resolved.pre_generation!, health: observed.health! }
    case 'publish': return Object.fromEntries(['artifact_id', 'version', 'registry', 'integrity_digest'].map((key) => [key, resolved[key]]))
    case 'inspect_remote_updates': return { remote: resolved.remote!, version: resolved.version!, upstream_oid: observed.upstream_oid! }
    default: return { expected_outcome: { k: 'e', v: 'success' }, min_matches: 1 }
  }
}

/**
 * Portable root events are semantic fixtures, not DSH command strings. Map a
 * stateful event that lacks v0.3 authority fields to one canonical synthetic
 * root instruction. This is action-generic, calls production capture to decide
 * whether adaptation is needed, and never keys on fixture ids or prose.
 */
function productionRootText(text: string): string {
  const action = semanticActionFromText(text)
  if (!isStatefulAction(action)) return text
  const captured = captureClause(text, 'portable-probe', 'R-portable-probe', 1, { cwd: WORKDIR })
  if (captured.targetCaptureStatus !== 'clarification_required') return text
  const target = statefulTarget(action, undefined).resolved
  const preserveAuthorityFacets = (instruction: string): string => [
    instruction,
    ...(captured.waitAuthorization ? ['Wait for your confirmation before continuing.'] : []),
    ...(captured.deferAuthorization ? ['Explicitly defer this work to the next iteration.'] : []),
    ...(captured.persistenceAuthorization ? ['Keep working until this task is complete.'] : []),
  ].join(' ')
  switch (action) {
    case 'install': return preserveAuthorityFacets(`Install package ${String(target.package_id)}@${String(target.version)} in profile ${String(target.profile)}.`)
    case 'apply': return preserveAuthorityFacets(`Apply package ${String(target.package_id)}@${String(target.version)} in profile ${String(target.profile)}.`)
    case 'create': return preserveAuthorityFacets(`Create ${String(target.artifact_id)}.`)
    case 'modify': return preserveAuthorityFacets(`Modify ${String(target.artifact_id)}.`)
    case 'restart': return preserveAuthorityFacets(`Restart service ${String(target.service_id)}.`)
    case 'commit': return preserveAuthorityFacets(`Commit repository ${String(target.repository)} on branch ${String(target.branch)}.`)
    case 'push': return preserveAuthorityFacets(`Push repository ${String(target.repository)} to remote ${String(target.remote)} refspec ${String(target.refspec)}.`)
    case 'publish': return preserveAuthorityFacets(`Publish package ${String(target.artifact_id)} version ${String(target.version)} to registry ${String(target.registry)}.`)
    case 'pull': return preserveAuthorityFacets(`Pull repository ${String(target.repository)} from remote ${String(target.remote)} refspec ${String(target.refspec)}.`)
    case 'fetch': return preserveAuthorityFacets(`Fetch repository ${String(target.repository)} from remote ${String(target.remote)} refspec ${String(target.refspec)}.`)
  }
}

class NativeSessionAdapter {
  readonly events: DerivedEnvelope[] = []
  readonly evidenceByFixtureId = new Map<string, string>()
  readonly statefulResolutionByAction = new Map<SemanticAction, string>()
  readonly statefulShapeByAction = new Map<SemanticAction, ReturnType<typeof statefulTarget>>()
  seq = 0
  calls = 0

  constructor(readonly production: PortableProduction) {
    this.append('command/run', { name: 'context-guard', args: 'on', source: { kind: 'user' } })
  }

  append(type: string, data?: unknown): DerivedEnvelope {
    const event = { seq: ++this.seq, type, ...(data === undefined ? {} : { data }) }
    this.events.push(event)
    return event
  }

  projection(): GuardProjection {
    return this.production.deriveProjection(
      this.events, { activation: 'opt-in' },
      { cwd: WORKDIR, sessionHeader: { version: 1, id: 'portable-session', createdAt: 1 } }, true,
      PORTABLE_HOST_LOCK,
    ).projection
  }

  root(text: string): { before: GuardProjection; after: GuardProjection } {
    const before = this.projection()
    this.append('user/message', { content: textContent(text), source: { kind: 'user' } })
    return { before, after: this.projection() }
  }

  delegated(event: PortableEvent): { before: GuardProjection; after: GuardProjection } {
    const before = this.projection()
    this.append('user/message', {
      content: textContent(String(event.text ?? '')),
      source: { kind: String(event.lineage ?? 'plugin'), plugin: 'portable-fixture', form: 'notice' },
    })
    return { before, after: this.projection() }
  }

  private tool(name: string, args: Record<string, unknown>, options: { meta?: unknown; error?: unknown; text?: string } = {}): string {
    const callId = `portable-call-${++this.calls}`
    this.append('tool/call', { callId, name, arguments: JSON.stringify(args) })
    this.append('tool/result', {
      message: { source: { callId }, content: textContent(options.text ?? '{}') },
      ...(options.meta === undefined ? {} : { meta: options.meta }),
      ...(options.error === undefined ? {} : { error: options.error }),
    })
    const evidence = [...this.projection().evidence.values()].find((row) => row.callId === callId)
    if (!evidence) throw new Error(`production derive did not create evidence for ${callId}`)
    return evidence.id
  }

  private structuredEvidence(action: SemanticAction, role: 'resolution' | 'effect' | 'state', resolved: TargetTuple, observed?: TargetTuple, extra?: Record<string, unknown>): string {
    const adapterId = ['pull', 'fetch', 'push', 'commit'].includes(action) ? 'context-guard.git.v1' : 'context-guard.package.v1'
    return this.tool('context_guard_evidence', { semantic_action: action, evidence_role: role }, {
      meta: { contextGuard: {
        adapterId, adapterVersion: '1.0.0', semanticAction: action, evidenceRole: role,
        resolvedTarget: resolved, ...(observed ? { observedState: observed } : {}), ...extra,
      } },
    })
  }

  evidence(event: PortableEvent): void {
    const fixtureId = String(event.evidenceId)
    const action = String(event.semanticAction ?? 'generic_run') as SemanticAction
    if (event.externalOperationRef) {
      const external = asRecord(event.externalOperationRef)
      const id = this.tool('context_guard_external_operation', { operation_id: String(external.id ?? fixtureId) }, {
        meta: { contextGuardExternalOperation: {
          id: String(external.id ?? fixtureId), adapterId: 'context-guard.external-operation.v1', status: String(external.status ?? 'unknown'),
        } },
      })
      this.evidenceByFixtureId.set(fixtureId, id)
      return
    }
    if (isStatefulAction(action)) {
      const projection = this.projection()
      const item = [...projection.items.values()].find((row) => row.status === 'pending' && row.semanticAction === action)
      let shape = this.statefulShapeByAction.get(action)
      if (!shape) {
        shape = statefulTarget(action, item?.requestedTarget)
        this.statefulShapeByAction.set(action, shape)
      }
      if (!this.statefulResolutionByAction.has(action)) {
        const expectedTransition = {
          predicateId: ACTION_MANIFEST.actions[action].predicateId,
          version: 1,
          predParamsKind: 'inline',
          parameters: shape.params,
        }
        this.statefulResolutionByAction.set(action, this.structuredEvidence(action, 'resolution', shape.resolved, undefined, {
          expectedTransition,
          expectedTransitionDigest: sha256(stable(expectedTransition)),
        }))
      }
      const observed = asRecord(event.observedState)
      const role = Object.keys(observed).length > 0 ? 'state' as const : 'effect' as const
      const id = this.structuredEvidence(action, role, shape.resolved, role === 'state' ? shape.observed : undefined)
      this.evidenceByFixtureId.set(fixtureId, id)
      return
    }

    const outcome = String(event.outcome ?? 'unknown')
    const parseStatus = String(event.parseStatus ?? '')
    const subjects = Array.isArray(event.subjects) ? event.subjects.map(String) : []
    const artifact = subjects.find((subject) => subject.startsWith('/'))
    if (action === 'verify' && artifact) {
      const id = this.tool('read_file', { file_path: artifact }, {
        meta: { path: artifact }, ...(outcome === 'failure' ? { error: { code: 'PORTABLE_FAILURE' } } : {}),
      })
      this.evidenceByFixtureId.set(fixtureId, id)
      return
    }
    const command = parseStatus.startsWith('unsupported')
      ? 'echo portable; echo unsupported'
      : action === 'test' || action === 'verify' ? 'python -m unittest' : 'git status'
    const id = this.tool('bash', { command, workdir: WORKDIR }, {
      meta: { exitCode: outcome === 'failure' ? 1 : 0 },
      ...(outcome === 'failure' ? { error: { code: 'PORTABLE_FAILURE' } } : {}),
    })
    this.evidenceByFixtureId.set(fixtureId, id)
  }

  bindingFor(event: PortableEvent, projection: GuardProjection): EvidenceBinding[] {
    const fixtureIds = Array.isArray(event.evidenceIds) ? event.evidenceIds.map(String) : []
    const item = [...projection.items.values()].find((row) => row.status === 'pending' && row.kind !== 'prohibition')
    if (!item) return []
    const mapped = fixtureIds.map((id) => this.evidenceByFixtureId.get(id) ?? id)
    const action = item.semanticAction ?? 'generic_run'
    if (isStatefulAction(action)) {
      const resolution = this.statefulResolutionByAction.get(action)
      const shape = this.statefulShapeByAction.get(action)
      if (!shape) return [{ itemId: item.id, evidenceIds: mapped }]
      const stateIds = mapped.filter((id) => projection.evidence.get(id)?.evidenceRole === 'state')
      const effect = mapped.find((id) => projection.evidence.get(id)?.evidenceRole === 'effect')
      const evidenceIds = [...(resolution ? [resolution] : []), ...mapped]
      const frozenTransition = resolution ? projection.evidence.get(resolution)?.expectedTransition : undefined
      return [{
        itemId: item.id, evidenceIds, semanticAction: action,
        requestedTarget: item.requestedTarget, resolvedTarget: shape.resolved,
        ...(stateIds.length ? { observedState: shape.observed } : {}),
        expectedTransition: frozenTransition,
        ...(resolution ? { resolutionEvidenceId: resolution } : {}),
        ...(effect ? { effectEvidenceId: effect } : {}), stateEvidenceIds: stateIds,
      }]
    }
    const effect = mapped.find((id) => (projection.evidence.get(id)?.evidenceRole ?? 'effect') === 'effect') ?? mapped[0]
    const fact = effect ? projection.evidence.get(effect) : undefined
    const spec = ACTION_MANIFEST.actions[action]
    const resolvedTarget = Object.fromEntries(spec.resolvedTargetKeys
      .filter((key) => Object.hasOwn(fact?.resolvedTarget ?? {}, key))
      .map((key) => [key, fact!.resolvedTarget![key]]))
    const observedState = Object.fromEntries(spec.observedStateKeys
      .filter((key) => Object.hasOwn(fact?.observedState ?? {}, key))
      .map((key) => [key, fact!.observedState![key]]))
    return [{
      itemId: item.id, evidenceIds: mapped, semanticAction: action,
      requestedTarget: item.requestedTarget, resolvedTarget,
      observedState,
      expectedTransition: { predicateId: spec.predicateId, version: 1, predParamsKind: 'inline', parameters: expectedParams(action, resolvedTarget, observedState) },
      ...(effect ? { effectEvidenceId: effect } : {}),
    }]
  }

  persistCheckpoint(bindings: EvidenceBinding[], result: CheckpointResult, recordedCertificate?: Record<string, unknown>): GuardProjection {
    const callId = `portable-call-${++this.calls}`
    const args = { bindings: bindings.map((binding) => ({
      item_id: binding.itemId, evidence_ids: binding.evidenceIds, semantic_action: binding.semanticAction,
      requested_target: binding.requestedTarget, resolved_target: binding.resolvedTarget, observed_state: binding.observedState,
      expected_transition: binding.expectedTransition ? {
        predicate_id: binding.expectedTransition.predicateId, version: binding.expectedTransition.version,
        pred_params_kind: binding.expectedTransition.predParamsKind, parameters: binding.expectedTransition.parameters,
      } : undefined,
      resolution_evidence_id: binding.resolutionEvidenceId, effect_evidence_id: binding.effectEvidenceId,
      state_evidence_ids: binding.stateEvidenceIds,
    })) }
    this.append('tool/call', { callId, name: 'context_guard_checkpoint', arguments: JSON.stringify(args) })
    this.append('tool/result', { message: { source: { callId }, content: textContent(JSON.stringify({
      status: result.status, ...(result.checkpoint ? { certificate: recordedCertificate ?? checkpointJson(result.checkpoint) } : {}),
    })) } })
    return this.projection()
  }

  persistBoundary(disposition: BoundaryDisposition): GuardProjection {
    const projection = this.projection()
    const available = availableBoundaryQualifications(projection).filter((row) => row.disposition === disposition)
    const fallbackKind: Record<BoundaryDisposition, BoundaryQualificationKind> = {
      user_wait: 'root_explicit_wait', external_wait: 'external_operation_pending', deferred: 'root_explicit_defer',
    }
    const request = {
      disposition, qualificationKind: available[0]?.kind ?? fallbackKind[disposition],
      qualificationIds: available.length ? available.map((row) => row.id) : ['portable-unqualified'],
      callId: `portable-call-${this.calls + 1}`,
    }
    const candidate = this.production.qualifyBoundary(projection, request)
    const callId = `portable-call-${++this.calls}`
    this.append('tool/call', { callId, name: 'context_guard_boundary', arguments: JSON.stringify({
      disposition: request.disposition, qualification_kind: request.qualificationKind, qualification_ids: request.qualificationIds,
    }) })
    this.append('tool/result', { message: { source: { callId }, content: textContent(JSON.stringify({
      status: candidate.persistedResult, boundary: { candidate_sha256: candidate.candidateSha256 },
    })) } })
    return this.projection()
  }
}

function replayReason(
  event: PortableEvent,
  production: PortableProduction,
  currentProjection: GuardProjection,
): 'stale_epoch' | 'stale_contract_revision' | 'stale_host_lock' | 'replayed_certificate_rejected' {
  const seed = new NativeSessionAdapter(production)
  seed.root('验证 synthetic portable replay scope')
  seed.evidence({ type: 'tool_result', evidenceId: 'E-replay-seed', semanticAction: 'verify', outcome: 'success' })
  const projection = seed.projection()
  const bindings = seed.bindingFor({ type: 'checkpoint_request', evidenceIds: ['E-replay-seed'] }, projection)
  const certified = production.certifyCheckpoint(projection, bindings, 'C-portable-replay', false)
  if (!certified.checkpoint) throw new Error('production could not create the portable replay seed certificate')
  const replay = asRecord(event.replayedCertificate)
  if ((event.evidenceIds as unknown[] | undefined)?.length) {
    const forged = checkpointJson(certified.checkpoint)
    forged.certification_digest = '00'.repeat(32)
    const replayed = seed.persistCheckpoint(bindings, certified, forged)
    if (!replayed.integrityViolations.includes('certificate_replay_mismatch')) {
      throw new Error('production replay accepted a forged portable certificate')
    }
    return 'replayed_certificate_rejected'
  }
  production.certifyCheckpoint(projection, bindings, certified.checkpoint.id, true)
  if (Number(replay.epoch) !== projection.epoch) projection.epoch += 1
  else if (Number(replay.contractRevision) < currentProjection.contractRevision) projection.contractRevision += 1
  else projection.hostLockDigest = 'ff'.repeat(32)
  if (production.hasCurrentCertificate(projection)) throw new Error('production accepted a stale portable certificate')
  const reason = projection.certificateStatusReason
  if (reason === 'stale_epoch' || reason === 'stale_contract_revision' || reason === 'stale_host_lock') return reason
  throw new Error(`unexpected production replay reason: ${String(reason)}`)
}

/** Thin fixture-to-production adapter; it owns no independent guard state. */
export function runPortableCase(testCase: PortableCase, production: PortableProduction = PORTABLE_PRODUCTION): PortableExpect {
  const session = new NativeSessionAdapter(production)
  const reasons = new Set<string>()
  const offending = new Set<string>()
  let projection = session.projection()
  let boundary: PortableExpect['boundary'] = null
  let directGoalCompleted = false
  let lastRecovery: string | undefined
  let duplicateRecoveries = 0
  let completionRequests = 0
  let forceContinue = false
  let portableIntegrity: 'ok' | 'unknown' | 'violation' = 'ok'

  for (const event of testCase.events) {
    if (event.type === 'root_message') {
      const text = String(event.text ?? '')
      const blocks = segmentAuthorityBlocks(text)
      const { before, after } = session.root(productionRootText(text))
      projection = after
      if (classifyUserInteraction(text) === 'conversational' && after.items.size === before.items.size) reasons.add('chatter_not_captured')
      if (blocks.some((block) => !block.capture)) reasons.add('reference_not_promoted')
      if (blocks.some((block) => block.kind === 'uncertain')) reasons.add('uncertain_fail_closed')
      if (blocks.some((block) => block.capture) && (blocks.some((block) => !block.capture) || /^[^。]+。请/.test(text))) reasons.add('mixed_clause_instruction_captured')
      if ([...after.items.values()].some((item) => item.authority === 'root_adoption')) reasons.add('adoption_promotion_applied')
      if (/清单.{0,8}(?:很有用|useful)[:：]/i.test(text) && after.items.size > before.items.size) reasons.add('uncertain_fail_closed')
      continue
    }
    if (event.type === 'delegated_message') {
      const { before, after } = session.delegated(event)
      projection = after
      if (after.contractRevision === before.contractRevision) reasons.add('delegated_message_not_contract')
      continue
    }
    if (event.type === 'tool_result') {
      session.evidence(event)
      projection = session.projection()
      continue
    }
    if (event.type === 'checkpoint_request') {
      const replay = asRecord(event.replayedCertificate)
      if (Object.keys(replay).length) {
        reasons.add(replayReason(event, production, session.projection()))
        continue
      }
      const before = session.projection()
      const bindings = session.bindingFor(event, before)
      const result = production.certifyCheckpoint(before, bindings, `C-portable-${session.calls + 1}`, false)
      for (const rejection of result.rejectedBindings) {
        reasons.add(rejection.reasonCode)
        for (const id of rejection.offendingEvidenceIds ?? []) {
          const fixtureId = [...session.evidenceByFixtureId.entries()].find(([, actual]) => actual === id)?.[0] ?? id
          offending.add(fixtureId)
        }
      }
      projection = session.persistCheckpoint(bindings, result)
      if (result.status === 'certified' && production.hasCurrentCertificate(projection)) reasons.add('completion_with_valid_certificate')
      continue
    }
    if (event.type === 'boundary_request') {
      projection = session.persistBoundary(String(event.disposition) as BoundaryDisposition)
      const persisted = projection.boundaries.at(-1)
      boundary = persisted ? { disposition: persisted.disposition, persistedResult: persisted.persistedResult } : null
      if (persisted) reasons.add(persisted.reasonCode)
      if (String(event.disposition) === 'external_wait' && [...projection.evidence.values()].some((row) => row.outcome === 'failure')) reasons.add('evidence_outcome_not_success')
      continue
    }
    if (event.type === 'goal_change') {
      if (event.action !== 'complete') {
        const before = session.projection()
        session.append('goal/change', { operation: String(event.action), goal: { id: 'portable-goal', revision: Number(event.revision ?? 1), phase: 'active' } })
        projection = session.projection()
        if (projection.contractRevision === before.contractRevision) reasons.add('goal_event_not_contract')
      } else if (event.producer === 'model_tool') {
        session.append('goal/change', { operation: 'resume', goal: {
          id: 'portable-goal', revision: Number(event.revision ?? 1), phase: 'active',
        } })
        projection = session.projection()
        const denial = production.goalCompletionDenial(projection, 'update_goal', {
          goal_id: 'portable-goal', revision: Number(event.revision ?? 1), action: 'complete',
        })
        if (denial) reasons.add('goal_complete_denied_without_certificate')
      } else {
        session.append('goal/change', { operation: 'complete', goal: { id: 'portable-goal', revision: Number(event.revision ?? 1), phase: 'complete' } })
        projection = session.projection()
        directGoalCompleted = projection.currentGoalPhase === 'complete'
        if (projection.integrityViolations.includes('goal_completion_without_certificate')) {
          portableIntegrity = 'violation'
          reasons.add('goal_completion_without_certificate')
          reasons.add('integrity_violation')
        }
      }
      continue
    }
    if (event.type === 'compact') {
      session.append('compaction/summary', { summary: 'bounded portable summary' })
      projection = session.projection()
      continue
    }
    if (event.type === 'resume') {
      if (event.integrity === 'corrupt') {
        session.append('goal/change', { operation: 'complete', goal: { id: 'portable-corrupt', revision: 1, phase: 'complete' } })
        portableIntegrity = 'unknown'
      } else {
        session.append('command/run', { name: 'context-guard', args: 'off', source: { kind: 'user' } })
        session.append('command/run', { name: 'context-guard', args: 'on', source: { kind: 'user' } })
      }
      projection = session.projection()
      if (event.integrity === 'corrupt' && projection.integrity !== 'valid') reasons.add('integrity_violation')
      if (event.recoveryBody === 'duplicate') {
        const packet = renderRecoveryPacket(projection)
        recoveryDigest(packet, projection)
        if (packet === lastRecovery) duplicateRecoveries += 1
        lastRecovery = packet
        reasons.add('staged_control_not_reused')
        if (duplicateRecoveries > 0) reasons.add('recovery_body_deduplicated')
      }
      continue
    }
    if (event.type === 'completion_request') {
      completionRequests += 1
      projection = session.projection()
      const decision = production.decideTurnBoundary(projection)
      const observed = observeAssistantOutcome(String(event.claim ?? ''))
      if (production.hasCurrentCertificate(projection)) reasons.add('completion_with_valid_certificate')
      else if (observed.kind === 'completion_claim' || !/先停一下/.test(String(event.claim ?? ''))) reasons.add('completion_without_certificate')
      else if (decision.reason === 'safe_yield_pending_preserved') reasons.add('safe_yield_pending_preserved')
      if (decision.action === 'continue') {
        forceContinue = true
        reasons.add('protocol_correction_steer')
      }
    }
  }

  projection = session.projection()
  production.decideTurnBoundary(projection)
  if (completionRequests > 1) reasons.add('stop_metamorphic_equivalent')
  if (projection.evidence.size >= 3) {
    renderRecoveryPacket(projection)
    reasons.add('retention_bounded_total_recorded')
  }
  const completionAllowed = production.hasCurrentCertificate(projection)
  const completed = completionAllowed || directGoalCompleted
  return {
    completed, completion_allowed: completionAllowed, force_continue: forceContinue,
    pending_preserved: !completionAllowed, boundary,
    integrity: portableIntegrity,
    reason_codes: [...reasons], ...(offending.size ? { offendingEvidenceIds: [...offending] } : {}),
  }
}

const STATEFUL_INSTRUCTION: Readonly<Record<string, string>> = {
  install: 'install package synthetic-plugin@1.2.3 profile synthetic-profile',
  apply: 'apply package synthetic-plugin@1.2.3 profile synthetic-profile',
  create: `create ${WORKDIR}/synthetic-artifact.txt`,
  modify: `modify ${WORKDIR}/synthetic-artifact.txt`,
  restart: 'restart service synthetic-service',
  commit: `commit repository ${WORKDIR} branch main`,
  push: `push repository ${WORKDIR} remote origin refspec refs/heads/main:refs/heads/main`,
  publish: 'publish package synthetic-package@1.2.3 registry https://registry.example.invalid/',
  pull: `pull repository ${WORKDIR} remote origin refspec refs/heads/main`,
  fetch: `fetch repository ${WORKDIR} remote origin refspec refs/heads/main:refs/remotes/origin/main`,
}

/** Drive one complete role closure through native events and the certifier. */
export function runStatefulProductionClosure(action: SemanticAction, production: PortableProduction = PORTABLE_PRODUCTION): PortableExpect {
  const instruction = STATEFUL_INSTRUCTION[action]
  if (!instruction || !isStatefulAction(action)) throw new Error(`not a stateful portable action: ${action}`)
  return runPortableCase({
    id: `stateful-${action}-production-closure`,
    events: [
      { type: 'root_message', text: instruction },
      { type: 'tool_result', evidenceId: `E-${action}-effect`, semanticAction: action, outcome: 'success' },
      { type: 'tool_result', evidenceId: `E-${action}-state`, semanticAction: action, outcome: 'success', observedState: { present: true } },
      { type: 'checkpoint_request', evidenceIds: [`E-${action}-effect`, `E-${action}-state`] },
    ],
    expect: {
      completed: true, completion_allowed: true, force_continue: false, pending_preserved: false,
      boundary: null, integrity: 'ok', reason_codes: ['completion_with_valid_certificate'],
    },
  }, production)
}
