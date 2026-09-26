import './message-source.js'
import { auditedHostImplementation } from './domain/host-resolver.js'
import { JobId } from '@deepseek-ai/dsh-jobs'
import { createRebindTool } from './tools/rebind.js'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from './domain/digest.js'
import {
  createProjection,
  type BoundaryDisposition,
  type BoundaryQualificationKind,
  type GuardBoundary,
  type GuardProjection,
} from './domain/types.js'
import { CONTROL_RECORD_PREFIX, isRootPauseRequest, latestRootInstruction, NO_PROGRESS_RECORD_PREFIX, progressFingerprint } from './domain/stop-policy.js'
import { deriveProjection, PROTOCOL_V6_NOTICE } from './domain/derive.js'
import { projectSessionCoreV2 } from './core-v2/session.js'
import { itemHoldsExecutionAuthority } from './domain/semantics.js'
import { claimedBatchHasRealRootInput, lifecyclePhase, previewFirstStepInjection, type LifecyclePhase } from './domain/lifecycle.js'
import { goalCompletionDenial } from './domain/goal-gate.js'
import { decideTurnBoundary } from './domain/stop-policy.js'
import { recoveryDigest, renderRecoveryPacket, recoveryTitle, type RecoveryCause } from './domain/recovery.js'
import { currentV6Feedback } from './domain/v6-feedback.js'
import { createCheckpointTool } from './tools/checkpoint.js'
import { createBoundaryTool } from './tools/boundary.js'
import { createPrepareTool } from './tools/prepare.js'
import { createInterpretTool } from './tools/interpret.js'
import { createReleaseTool } from './tools/release.js'
import { createNativeFileObserver, createNativeGitObserver, createTestReadinessObserver } from './tools/observe.js'
import { GIT_COMMAND_TEMPLATES, type GitAdapterAction } from './domain/git-adapter.js'
import {
  createActionTool,
  createEvidenceTool,
  type EvidenceToolRoots,
  type MutationAuthorizationDecision,
  type MutationAuthorizationRequest,
} from './tools/evidence.js'
import {
  createExternalOperationTool,
  type ExternalOperationCapability,
  type ExternalOperationSnapshot,
} from './tools/external-operation.js'
import {
  BOUNDARY_RECORD_PREFIX,
  effectuateBoundary,
  isCurrentAcceptedBoundary,
  qualifyBoundary,
  type GoalActivationState,
  type GoalBoundaryAccess,
} from './domain/boundary.js'
import {
  bindLiveGoalCapability,
  DEFAULT_HOST_LOCK,
  evaluateExternalWaitCapability,
  evaluateHostCapability,
  evaluateHostLock,
  type HostCapabilityEvaluation,
  type HostLockEvaluation,
} from './domain/host-lock.js'
import { requestedTargetAuthorizesMutation, requestedTargetMatchesResolved, type StatefulAction } from './domain/protocol-manifest.js'
import { actionHasAdapter, evaluateCompatibility } from './domain/compatibility.js'
import {
  readbackSettlesContract, releaseContractFor, releasePreEffectDecision, reservationFor,
  type ReleaseSettlement,
} from './domain/release.js'
import { createContextGuardCommand } from './commands/context-guard.js'
import { resolveConfig, type ResolvedConfig } from './config.js'
import { auditedDefaultWorkdirProvider, auditedForegroundRenderers, readActiveHostGraph } from './domain/host-resolver.js'
import { SessionApiError, snapshotSessionEvents } from './domain/session-events.js'
import { captureHostWorkdir, HOST_WORKDIR_PREFIX, sourcedNamedTestRoot } from './domain/host-workdir.js'
import { resolveAuditedRef } from './tools/evidence.js'
import { SESSION_FORMAT_VERSION as SUPPORTED_SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { appendPrivateLedger, applyPrivateLedger, hasPrivateRestartIntent, initializePrivateLedger, privateLedgerContractDigest,
  privateLedgerTargetDigest, readPrivateLedger, resolvePrivateLedgerRoot,
  type PrivateLedgerSnapshot } from './domain/private-ledger.js'

export const name = 'context-guard'
// Native readback and test-readiness tools require the host filesystem. Cordis
// refuses a service property read that was not declared in `inject`; without
// this declaration, session-start aborted halfway through tool registration.
export const inject = ['sessions', 'commands', 'fs'] as const

/**
 * GuardRuntime
 *
 * Context Guard derives all of its state from DSH-native session events
 * (`command/run`, `user/message`, `tool/call`, `tool/result`,
 * `compaction/summary`) and never appends custom event types, which the
 * persistence layer of the current harness would refuse to reload.
 */
export interface GuardRuntime {
  readonly projection: GuardProjection
  readonly session: Session
  /** Startup lifecycle: armed (waiting for the first real root input), active, or disabled. */
  readonly lifecycle: LifecyclePhase
  /** The durable log already carries the 0.5 first-step protocol boundary. */
  readonly protocolV4Present: boolean
  /** The durable log already carries the 0.6 first-step protocol boundary. */
  readonly protocolV5Present: boolean
  readonly protocolV6Present?: boolean
  sync(): void
  setEnabled(_enabled: boolean): void
  setDurability(confirmed: boolean): void
  markRecoveryNeeded(cause?: RecoveryCause): void
  consumeRecovery(): boolean
  /**
   * Why recovery is currently armed, recorded where the arm happened so the
   * injected title can name the real trigger. Empty when armed without an
   * auditable cause; the neutral title never fabricates compaction or resume
   * (DSH-RF-02). Cleared by {@link consumeRecovery}.
   */
  readonly recoveryCauses?: readonly string[]
}

export type RuntimeHostCapabilityEvaluator = (action: StatefulAction) => HostCapabilityEvaluation

/**
 * Bind an explicit mutation to one live root-owned contract item. Resolution
 * evidence is intentionally not authority: every effect rechecks the current
 * projection immediately before any command, HTTP request, or durable intent.
 */
export function authorizeMutationFromProjection(
  projection: GuardProjection,
  request: MutationAuthorizationRequest,
): MutationAuthorizationDecision {
  if (!projection.enabled) return { status: 'denied', reasonCode: 'mutation_guard_disabled' }
  if (projection.integrity !== 'valid') return { status: 'denied', reasonCode: 'mutation_integrity_unavailable' }
  if (projection.hostStatus !== 'supported') return { status: 'denied', reasonCode: 'mutation_host_lock_unavailable' }
  const item = projection.items.get(request.contractItemId)
  if (!item) return { status: 'denied', reasonCode: 'mutation_contract_item_missing' }
  if (!Number.isSafeInteger(request.contractItemRevision) || item.revision !== request.contractItemRevision) {
    return { status: 'denied', reasonCode: 'mutation_contract_item_revision_mismatch' }
  }
  if (item.status !== 'pending') return { status: 'denied', reasonCode: 'mutation_contract_item_not_pending' }
  // 0.6.3 K3: the SAME judgement `context_guard_prepare` renders is evaluated
  // here before any effect, so preparation and execution cannot disagree about
  // an item/action/target combination. The mutation denial codes below stay the
  // historical names the execution lane already reports; the shared verdict
  // only decides whether the assumption is even the item's own.
  const compatibility = evaluateCompatibility({
    action: request.action,
    itemAction: item.semanticAction ?? 'generic_run',
    itemRevision: request.contractItemRevision,
    currentRevision: item.revision,
    itemKind: item.kind,
    itemStatus: item.status,
    authority: item.authority,
    legacyFlags: item.legacyFlags,
    authorityDisposition: item.authorityDisposition,
    waitAuthorization: item.waitAuthorization,
    reboundFrom: item.reboundFrom,
    originalAuthority: item.reboundFrom
      ? (() => {
          const original = projection.items.get(item.reboundFrom.itemId)
          return original ? { semanticAction: original.semanticAction, requestedTarget: original.requestedTarget } : undefined
        })()
      : undefined,
    targetCaptureStatus: item.targetCaptureStatus,
    targetSourceKind: item.targetSource?.kind,
    requestedTarget: item.requestedTarget,
    adapterSupported: actionHasAdapter(request.action),
  }, (requested, resolved) => requestedTargetMatchesResolved(request.action, requested, resolved))
  if (compatibility.status === 'incompatible') {
    return compatibility.reasonCodes.includes('action_not_compatible_with_item')
      ? { status: 'denied', reasonCode: 'mutation_semantic_action_mismatch' }
      : { status: 'denied', reasonCode: 'rebind_does_not_authorize_mutation' }
  }
  // A root instruction that reserves the action for its own later confirmation
  // withholds execution authority: the obligation stays recorded and open, but
  // the mutation is refused until the root actually releases the wait. This is
  // checked before the target comparison so the refusal is reported for the
  // condition that caused it rather than as a target mismatch.
  if (item.authorityDisposition === 'conditional_wait' || item.waitAuthorization) {
    return {
      status: 'denied',
      reasonCode: item.authorityDisposition === 'conditional_wait'
        ? 'mutation_awaiting_root_condition'
        : 'mutation_awaiting_root_wait',
    }
  }
  if (item.authorityDisposition === 'human_actor') return { status: 'denied', reasonCode: 'mutation_human_executor' }
  if (item.kind !== 'requirement' || item.verification.enforced !== true) {
    return { status: 'denied', reasonCode: 'mutation_contract_item_not_authorizing' }
  }
  if (item.authority !== 'root_instruction' && item.authority !== 'root_adoption') {
    return { status: 'denied', reasonCode: 'mutation_root_authority_unavailable' }
  }
  if (item.legacyFlags?.length) return { status: 'denied', reasonCode: 'mutation_legacy_rebind_required' }
  if (item.reboundFrom) {
    const original = projection.items.get(item.reboundFrom.itemId)
    // A replacement retaining the original source may only use the original
    // action and target authority. A later root clarification keeps its own
    // independent source and was already authorizing before mapping.
    if (original?.sourceMessageId === item.sourceMessageId
      && (original.semanticAction !== request.action
        || !requestedTargetAuthorizesMutation(request.action, original.requestedTarget, request.resolvedTarget))) {
      return { status: 'denied', reasonCode: 'rebind_does_not_authorize_mutation' }
    }
  }
  if (item.semanticAction !== request.action) return { status: 'denied', reasonCode: 'mutation_semantic_action_mismatch' }
  if (item.targetCaptureStatus !== 'resolved') return { status: 'denied', reasonCode: 'mutation_target_clarification_required' }
  // 0.6.3 K2: the session's own working directory is environment context, never
  // a root selection. An obligation left on that default is refused explicitly
  // so the refusal names the real gap instead of looking like a target
  // mismatch, and so a caller cannot read the environment as authorization.
  if (item.targetSource?.kind === 'environment_default') {
    return { status: 'denied', reasonCode: 'mutation_target_environment_default' }
  }
  // A bounded file choice (C07) may land inside a directory the user picked
  // through a trusted host question in the same unit: the answer is root
  // authority from an audited tool source, recorded separately from sandbox
  // approvals. Any other target mismatch stays denied.
  const boundedAuthorized = (scope: unknown): boolean =>
    requestedTargetAuthorizesMutation(request.action, { ...item.requestedTarget, scope } as typeof item.requestedTarget, request.resolvedTarget)
  const selectionAuthorized = projection.trustedSelections.some((selection) =>
    selection.kind === 'directory'
    && typeof item.requestedTarget?.artifact_type === 'string'
    && item.unitId !== undefined
    && boundedAuthorized(selection.selected))
  if (!requestedTargetAuthorizesMutation(request.action, item.requestedTarget, request.resolvedTarget) && !selectionAuthorized) {
    return { status: 'denied', reasonCode: 'mutation_requested_target_mismatch' }
  }
  const conflictingProhibition = [...projection.items.values()].some((candidate) => (
    candidate.status === 'pending'
    && candidate.kind === 'prohibition'
    && (candidate.authority === 'root_instruction' || candidate.authority === 'root_adoption')
    && !candidate.legacyFlags?.length
    && candidate.semanticAction === request.action
    // A prohibition is a deny constraint, not positive authority: captured
    // identity fields may be partial, but each must match this resolution.
    && requestedTargetMatchesResolved(request.action, candidate.requestedTarget, request.resolvedTarget)
  ))
  if (conflictingProhibition) {
    return { status: 'denied', reasonCode: 'mutation_conflicting_prohibition' }
  }
  // Last resort before authorizing (review 9): an explanation whose sentence
  // mentions an action is not authority, because the action may be exactly what
  // the root asked to have explained — the absence of a protection pattern is
  // never proof that it left that scope. A question is barred for the same
  // reason. An `unresolved` clause that is NOT an explanation's scope keeps the
  // behaviour it always had, so an unrecognised instruction form is still
  // evaluated on its action and target. Every earlier refusal keeps reporting the
  // reason it always did.
  if (!itemHoldsExecutionAuthority(item)) {
    return { status: 'denied', reasonCode: 'mutation_item_not_executable' }
  }
  return { status: 'authorized', reasonCode: 'mutation_root_contract_authorized' }
}

export const PROTOCOL_CORRECTION_NOTICE = 'Context Guard protocol correction: root-authorized work remains pending; continue with tools or obtain a typed boundary.'

export interface RuntimeTurnStoppingAccess {
  flush(): Promise<boolean>
  goalAccess?: GoalBoundaryAccess
  /**
   * The host's own pause entry. Routing a real user's pause request here is not
   * impersonating a human: the human asked, and this is the lifecycle call that
   * carries their request. Guard never resumes through it — re-arming stays a
   * human action.
   */
  pauseAccess?: {
    pause(): Promise<GoalActivationState | undefined>
    get(): Promise<GoalActivationState | undefined>
  }
  hostSupported: boolean
  externalWaitCapability?: ExternalOperationCapability
  readExternalOperation(id: string): ExternalOperationSnapshot | undefined
}


/**
 * Establish a Guard-owned boundary as a durable producer notice. V4 Stop hooks
 * run outside tool steps, so replay requalifies the notice request and verifies
 * its candidate digest instead of inventing a tool call/result envelope.
 *
 * Returns the boundary only after the durable flush succeeded. A failed flush
 * reports the failure instead of a boundary, because an unflushed record must
 * never be read back as an established boundary.
 */
async function establishBoundary(
  agent: Agent,
  runtime: GuardRuntime,
  flush: () => Promise<boolean>,
  request: { disposition: BoundaryDisposition; qualificationKind: BoundaryQualificationKind; qualificationIds: string[] },
): Promise<{ boundary?: GuardBoundary; reasonCode: string }> {
  const projection = runtime.projection
  const candidate = qualifyBoundary(projection, request)
  if (candidate.persistedResult !== 'accepted') return { reasonCode: candidate.reasonCode }
  const session = agent.session as unknown as {
    seq: number
    append: (type: string, data: unknown, options?: unknown) => unknown
  }
  // A Stop hook is outside a tool step. V4 forbids invented tool/call
  // envelopes; persist a producer-owned notice and revalidate it on replay.
  session.append('user/message', pluginNoticeMessage(
    `${BOUNDARY_RECORD_PREFIX}${JSON.stringify({ request, candidate_sha256: candidate.candidateSha256 })}`,
    'recording a qualified stop boundary',
  ), { surfaceOp: 'append' })
  let durable = false
  try {
    durable = await flush()
  } catch {
    durable = false
  }
  runtime.setDurability(durable)
  runtime.sync()
  if (!durable) return { reasonCode: 'boundary_flush_failed' }
  return { boundary: candidate, reasonCode: candidate.reasonCode }
}

/**
 * Effectuate a boundary Guard established in this turn, with the Goal revision
 * re-checked at the moment of the side effect.
 *
 * The progress fingerprint deliberately ignores the Goal revision, because an
 * edited Goal text is not progress. That is a statement about *detecting*
 * progress, not permission to act on a stale reference: before disarming, the
 * boundary's own Goal identity and revision are compared with the live readback,
 * so a Goal that changed under the boundary is refused rather than disarmed.
 */
async function effectuateOwnBoundary(
  runtime: GuardRuntime,
  boundary: GuardBoundary,
  access: RuntimeTurnStoppingAccess,
): Promise<string> {
  const goalAccess = access.goalAccess ?? { get: async () => undefined, disarm: async () => undefined }
  const recorded = boundary.goalRef
  const effect = await effectuateBoundary(boundary, {
    ...goalAccess,
    requalify: async () => {
      const live = await goalAccess.get()
      if (!live || !recorded) return false
      return live.id === recorded.id && live.revision === recorded.revision && live.activation === 'armed'
    },
  })
  if (effect.resumeRequired) {
    runtime.projection.integrity = 'unknown'
    runtime.projection.integrityViolations.push(effect.reasonCode)
  }
  return effect.reasonCode
}

/** Production Stop boundary: durable replay first, then immutable/live checks. */
export async function handleGuardTurnStopping(
  agent: Agent,
  runtime: GuardRuntime,
  access: RuntimeTurnStoppingAccess,
): Promise<string> {
  // A rejected flush is as fatal as a false one: the V3 store rejects a flush
  // for a session that is no longer live (detached, prepared-but-not-entered,
  // or disposed), and an exception is not evidence that the durable log caught
  // up. Both paths report the boundary as failed and issue nothing.
  let durable = false
  try {
    durable = await access.flush()
  } catch {
    durable = false
  }
  runtime.setDurability(durable)
  runtime.sync()
  if (!durable) return 'boundary_flush_failed'

  // A trusted root pause request outranks the old Goal's continuation: the user
  // stopped the work, so Guard routes that request to the host's own pause entry
  // and reads back what the host did. The source filter is what keeps quoted
  // text, tool output and model text from reaching this branch.
  const rootInstruction = latestRootInstruction(
    (agent.session as unknown as { snapshotEvents?: () => Array<{ type: string; seq?: number; data: unknown }> } | undefined)
      ?.snapshotEvents?.() ?? [],
  )
  // A pause is carried ONCE. The message stays in the log forever, so the
  // question is not "did the user ever ask to pause" but "is there a pause
  // request Guard has not carried yet" — otherwise a goal the human resumed
  // through the host would be paused again by the same old message.
  const pendingPause = rootInstruction !== undefined
    && isRootPauseRequest(rootInstruction.text)
    && !runtime.projection.handledControlSeqs.has(rootInstruction.seq)
  if (pendingPause && access.pauseAccess) {
    const session = agent.session as unknown as { seq: number; append: (type: string, data: unknown, options?: unknown) => unknown }
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${CONTROL_RECORD_PREFIX}${JSON.stringify({ kind: 'root_pause', rootSeq: rootInstruction.seq })}` }],
      source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice', summary: boundContextSummary('carrying the root pause request to the host') },
    }), { surfaceOp: 'append' })
    // An already-paused goal is the same outcome, not an error: the host refuses
    // to pause a goal that is not active, and a user pause that was already
    // carried must not be reported as a failure on the next turn boundary.
    const current = await access.pauseAccess.get()
    const paused = current?.phase === 'paused' && current.activation === 'disarmed'
      ? current
      : await access.pauseAccess.pause()
    const readback = await access.pauseAccess.get()
    if (!paused || paused.activation !== 'disarmed' || readback?.activation !== 'disarmed') {
      runtime.projection.integrity = 'unknown'
      runtime.projection.integrityViolations.push('root_pause_readback_failed')
      return 'root_pause_readback_failed'
    }
    return 'root_pause_routed'
  }

  const decision = decideTurnBoundary(runtime.projection, rootInstruction?.text)
  // Spend the no-progress budget in the log, not in memory: the record is what
  // makes the bound survive a reload and what makes a replayed decision
  // idempotent, because the attempt it claims is stored in a set.
  if (decision.noProgressClaim) {
    const record = `${NO_PROGRESS_RECORD_PREFIX}${JSON.stringify(decision.noProgressClaim)}`
    const session = agent.session as unknown as { seq: number; append: (type: string, data: unknown, options?: unknown) => unknown }
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: record }],
      source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice', summary: boundContextSummary('recording a turn boundary without relevant progress') },
    }), { surfaceOp: 'append' })
    let recorded = false
    try {
      recorded = await access.flush()
    } catch {
      recorded = false
    }
    runtime.setDurability(recorded)
    runtime.sync()
    if (!recorded) return 'boundary_flush_failed'
  }
  if (decision.action === 'continue') {
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: PROTOCOL_CORRECTION_NOTICE }],
      source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice', summary: boundContextSummary('requesting the one allowed protocol correction step') },
    }))
    return decision.reason ?? 'protocol_correction_steer'
  }
  // Guard-owned stops and waits are established here, in the turn boundary,
  // rather than waiting for the model to call the boundary tool: a bounded stop
  // and a human wait are the guard's own reading of the session, and requiring
  // a model round trip for them is how a stalled task stays stalled.
  if (decision.reason === 'no_progress_bounded_disarm') {
    if (!access.goalAccess || !access.hostSupported) {
      runtime.projection.integrity = 'unknown'
      runtime.projection.integrityViolations.push('boundary_host_lock_unsupported')
      return 'boundary_host_lock_unsupported'
    }
    const established = await establishBoundary(agent, runtime, access.flush, {
      disposition: 'guard_bounded_stop',
      qualificationKind: 'guard_no_progress',
      qualificationIds: [progressFingerprint(runtime.projection)],
    })
    if (!established.boundary) return established.reasonCode
    return await effectuateOwnBoundary(runtime, established.boundary, access)
  }
  if (decision.reason === 'goal_round_driver_owns_continuation' && access.goalAccess) {
    // A trusted root human wait disarms the automatic continuation without
    // touching the open items: the work stays recorded and uncertified, and the
    // only thing that moves again is a matching trusted root input.
    const waiting = [...runtime.projection.items.values()]
      .filter((item) => item.status === 'pending' && item.waitAuthorization)
      .map((item) => item.waitAuthorization!.id)
      .sort()
    const current = runtime.projection.boundaries.at(-1)
    const alreadyCurrent = current && isCurrentAcceptedBoundary(runtime.projection, current)
      && current.disposition === 'user_wait'
      && current.qualificationIds.slice().sort().join(',') === waiting.join(',')
    if (waiting.length > 0 && !alreadyCurrent) {
      if (!access.hostSupported) {
        runtime.projection.integrity = 'unknown'
        runtime.projection.integrityViolations.push('boundary_host_lock_unsupported')
        return 'boundary_host_lock_unsupported'
      }
      const established = await establishBoundary(agent, runtime, access.flush, {
        disposition: 'user_wait',
        qualificationKind: 'root_explicit_wait',
        qualificationIds: waiting,
      })
      if (established.boundary) return await effectuateOwnBoundary(runtime, established.boundary, access)
      // A wait that cannot be established is reported, not asserted: the open
      // items keep their reservation and the caller sees why nothing stopped.
      return established.reasonCode
    }
  }
  if (decision.reason !== 'accepted_boundary_pending_effectuation') return decision.reason ?? 'safe_yield_pending_preserved'

  const boundary = runtime.projection.boundaries.at(-1)
  if (!boundary || !isCurrentAcceptedBoundary(runtime.projection, boundary)) return 'boundary_candidate_stale'
  if (boundary.goalRef && (!access.goalAccess || !access.hostSupported)) {
    runtime.projection.integrity = 'unknown'
    runtime.projection.integrityViolations.push('boundary_host_lock_unsupported')
    return 'boundary_host_lock_unsupported'
  }

  const requalify = boundary.disposition === 'external_wait'
    ? async () => access.externalWaitCapability?.status === 'supported'
      && boundary.qualificationIds.every((id) => {
        const row = access.readExternalOperation(id)
        return row?.status === 'running' || row?.status === 'pending'
      })
    : undefined
  const goalAccess = access.goalAccess ?? {
    get: async () => undefined,
    disarm: async () => undefined,
  }
  const effect = await effectuateBoundary(boundary, { ...goalAccess, ...(requalify ? { requalify } : {}) })
  if (effect.resumeRequired) {
    runtime.projection.integrity = 'unknown'
    runtime.projection.integrityViolations.push(effect.reasonCode)
  }
  return effect.reasonCode
}

export function createHostCapabilityEvaluator(hostLock: HostLockEvaluation): RuntimeHostCapabilityEvaluator {
  return (action) => evaluateHostCapability(hostLock, { action })
}

/**
 * Durable session identity for the certificate binding, read from the
 * DSH Session V3 header plus the Session-owned inherited prefix length.
 *
 * Session V3 stamps `version: 3`, requires the `isSeeded` fork-lineage marker,
 * and moved the inherited-prefix length off the header onto the `Session`
 * (`inheritedEventCount`). Anything else is not a V3 identity: returning
 * `undefined` makes the projection report `session_ref_unavailable` instead of
 * certifying against a guessed identity.
 */
function sessionHeaderForDigest(session: Session): SessionHeader | undefined {
  const raw = session.header as unknown as Record<string, unknown> | undefined
  if (!raw || raw.version !== SUPPORTED_SESSION_FORMAT_VERSION) return undefined
  if (typeof raw.id !== 'string' || typeof raw.createdAt !== 'number') return undefined
  if (typeof raw.isSeeded !== 'boolean') return undefined
  const inherited = (session as unknown as { inheritedEventCount?: unknown }).inheritedEventCount
  if (typeof inherited !== 'number' || !Number.isSafeInteger(inherited) || inherited < 0) return undefined
  return {
    version: raw.version, id: raw.id, createdAt: raw.createdAt,
    ...(typeof raw.parentSession === 'string' ? { parentSession: raw.parentSession } : {}),
    // V3 carries the same durable fact under a new owner: the inherited prefix
    // length moved from the header to the Session. The digest token keeps its
    // historical name so no certificate digest changes shape on a host upgrade.
    seedLength: inherited,
    ...(typeof raw.agentPreset === 'string' ? { agentPreset: raw.agentPreset } : {}),
    ...(typeof raw.origin === 'string' ? { origin: raw.origin } : {}),
    // DSH JSONL persistence materializes an omitted root depth as zero.
    // Hash that same persisted identity before and after a resume.
    delegationDepth: typeof raw.delegationDepth === 'number' ? raw.delegationDepth : 0,
  }
}

export function createRuntime(
  agent: Agent,
  config: ResolvedConfig,
  hostLock: HostLockEvaluation = DEFAULT_HOST_LOCK,
  readGoalState?: () => unknown,
  refreshHostLock?: () => HostLockEvaluation,
  readPrivateRecords?: () => PrivateLedgerSnapshot,
  initializePrivateRecords?: () => boolean,
): GuardRuntime {
  const projection = createProjection()
  const session = agent.session
  let pendingRecovery = false
  let pendingRecoveryCauses = new Set<RecoveryCause>()
  let durabilityConfirmed = false
  let durabilityWatermark: GuardProjection['durabilityWatermark'] = 'unknown'
  let observedEpoch = -1
  let observedCompactionSeq = -1
  let observedContractRevision = -1
  let protocolV4Present = false
  let protocolV5Present = false
  let protocolV6Present = false
  let realRootInputSeen = false
  let lifecycle: LifecyclePhase = 'armed'
  let synchronizedOnce = false
  const continuationAttempts = projection.continuationAttempts
  const persistenceCorrectionAttempts = projection.persistenceCorrectionAttempts

  const rebuild = () => {
    const previousReleaseContracts = projection.releaseContracts.length
    if (refreshHostLock) hostLock = refreshHostLock()
    const header = session.header as { cwd?: unknown } | undefined
    // The recovery digest is runtime-owned liveness state like the per-turn
    // attempt cap; Object.assign would otherwise flush it with the fresh
    // projection's undefined.
    const priorRecoveryDigest = projection.lastRecoveryDigest
    const sessionHeader = sessionHeaderForDigest(session)
    let events: readonly unknown[]
    try {
      events = snapshotSessionEvents(session)
    } catch (error) {
      // A session that does not expose the V3 snapshot API is an unsupported
      // host, not an empty log: fail closed and keep the previous derivation
      // instead of projecting a session whose events were never read.
      const code = error instanceof SessionApiError ? error.code : 'session_snapshot_failed'
      projection.integrity = 'unknown'
      if (!projection.integrityViolations.includes(code)) projection.integrityViolations.push(code)
      return
    }
    const derived = deriveProjection(
      events as Parameters<typeof deriveProjection>[0],
      { activation: config.activation, policy: config.policy },
      { cwd: typeof header?.cwd === 'string' ? header.cwd : '', sessionHeader },
      durabilityConfirmed,
      hostLock,
    )
    Object.assign(projection, derived.projection)
    if (readPrivateRecords) {
      let privateSnapshot = readPrivateRecords()
      if (!synchronizedOnce && events.length === 0 && !privateSnapshot.damaged && !privateSnapshot.anchored
        && initializePrivateRecords?.()) privateSnapshot = readPrivateRecords()
      if (projection.releaseContracts.length > 0 && !privateSnapshot.damaged && !privateSnapshot.anchored) {
        if (synchronizedOnce && previousReleaseContracts === 0 && initializePrivateRecords?.()) privateSnapshot = readPrivateRecords()
        else privateSnapshot = { records: [], damaged: true, anchored: false }
      }
      applyPrivateLedger(projection, privateSnapshot)
    }
    synchronizedOnce = true
    if (!sessionHeader) {
      projection.integrity = 'unknown'
      if (!projection.integrityViolations.includes('session_ref_unavailable')) {
        projection.integrityViolations.push('session_ref_unavailable')
      }
    }
    if (readGoalState) {
      try {
        const state = normalizeGoalState(readGoalState())
        if (state && projection.currentGoalRef?.id === state.id && projection.currentGoalRef.revision === state.revision) {
          projection.currentGoalPhase = state.phase
          projection.currentGoalActivation = state.activation
        }
      } catch {
        projection.integrity = 'unknown'
        projection.integrityViolations.push('goal_readback_unavailable')
      }
    }
    // Liveness state must survive rebuilds: the per-turn attempt cap, the
    // one-shot recovery arm, and the durability watermark are owned by the
    // runtime, not the projection.
    projection.continuationAttempts = continuationAttempts
    projection.persistenceCorrectionAttempts = persistenceCorrectionAttempts
    projection.lastRecoveryDigest = priorRecoveryDigest
    projection.durabilityWatermark = durabilityWatermark
    if (projection.boundaryProtocol === 6 && durabilityWatermark === 'confirmed') {
      try {
        const displayOrigins: NonNullable<GuardProjection['coreV2RequirementOrigins']> = new Map()
        projection.coreV2 = projectSessionCoreV2(session.snapshotEvents() as never, projection, displayOrigins)
        projection.coreV2RequirementOrigins = projection.coreV2 ? displayOrigins : undefined
        projection.coreV2Reason = projection.coreV2 ? undefined : 'source_not_projectable'
      } catch {
        projection.coreV2 = undefined
        projection.coreV2RequirementOrigins = undefined
        projection.coreV2Reason = 'projection_failed'
      }
    }
    // Startup lifecycle facts for the first-step injection decision and the
    // status surface: the v4 boundary and the real-input observation are both
    // derived from the same durable log as the contract.
    protocolV4Present = derived.protocolV4Present
    protocolV5Present = derived.boundaryV5
    protocolV6Present = derived.boundaryV6
    realRootInputSeen = derived.realRootInputSeen
    lifecycle = lifecyclePhase({ enabled: projection.enabled, realInputSeen: realRootInputSeen })
    // A newly observed epoch means enablement transitioned since the last
    // rebuild; the first rebuild only records the baseline. Recovery re-arms
    // and the content dedup forgets the last packet, so the first reminder
    // after a transition is always injected.
    if (observedEpoch >= 0 && derived.projection.epoch > observedEpoch) {
      pendingRecovery = true
      pendingRecoveryCauses.add('guard_reenabled')
      projection.lastRecoveryDigest = undefined
    }
    observedEpoch = derived.projection.epoch
    if (observedContractRevision >= 0 && projection.contractRevision !== observedContractRevision) {
      pendingRecovery = true
      pendingRecoveryCauses.add('contract_updated')
    }
    observedContractRevision = projection.contractRevision
    // Compaction summaries stay in the historical log forever, so only re-arm
    // recovery when a NEW summary is observed, keyed by its sequence.
    if (derived.lastCompactionSeq > observedCompactionSeq) {
      pendingRecovery = true
      pendingRecoveryCauses.add('compaction')
      projection.lastRecoveryDigest = undefined
      observedCompactionSeq = derived.lastCompactionSeq
    }
  }

  const sync = () => {
    rebuild()
  }

  const setEnabled = (_enabled: boolean) => {
    // Enablement is derived from the already-logged `command/run`; this entry
    // point only re-syncs so the projection reflects the new state.
    rebuild()
  }

  const setDurability = (confirmed: boolean) => {
    durabilityConfirmed = confirmed
    // The watermark is runtime-owned liveness state like the attempt caps: it
    // records what the most recent public entry observed, and a rebuild must
    // not reset it to the fresh projection's default.
    durabilityWatermark = confirmed ? 'confirmed' : 'failed'
    projection.durabilityWatermark = durabilityWatermark
  }
  const markRecoveryNeeded = (cause?: RecoveryCause) => {
    pendingRecovery = true
    pendingRecoveryCauses.add(cause ?? 'explicit')
  }
  const consumeRecovery = () => {
    const was = pendingRecovery
    pendingRecovery = false
    pendingRecoveryCauses = new Set()
    return was
  }

  rebuild()
  return {
    projection,
    session,
    get lifecycle() { return lifecycle },
    get protocolV4Present() { return protocolV4Present },
    get protocolV5Present() { return protocolV5Present },
    get protocolV6Present() { return protocolV6Present },
    get recoveryCauses() { return [...pendingRecoveryCauses] },
    sync,
    setEnabled,
    setDurability,
    markRecoveryNeeded,
    consumeRecovery,
  }
}

/** The durable session working directory, when the V3 header carries one. */
function sessionCwd(session: Session): string | undefined {
  const header = session.header as { cwd?: unknown } | undefined
  return typeof header?.cwd === 'string' && header.cwd.length > 0 ? header.cwd : undefined
}

/** A bounded signal for a short trusted readback performed by the gate. */
function requestSignal(): AbortSignal {
  return AbortSignal.timeout(5_000)
}

/** Delegated/subagent sessions never receive root-conversation injections. */
function isDelegatedSession(session: Session): boolean {
  const header = session.header as { parentSession?: unknown; delegationDepth?: unknown; origin?: unknown } | undefined
  return header?.origin === 'subagent'
    || (typeof header?.delegationDepth === 'number' && header.delegationDepth > 0)
    || typeof header?.parentSession === 'string'
}

/** Never reinterpret a legacy injected snapshot as freshly accepted core/v1. */
export function revalidateCoreLock(config: ResolvedConfig, expected: HostLockEvaluation): HostLockEvaluation {
  if (config.hostLockPolicy !== 'dsh-core/v1' || !config.hostLockRuntimeRoot || !config.hostLockProfileRoot) {
    return { ...expected, status: 'unavailable', goalAvailable: false, reasonCode: 'host_lock_migration_required' }
  }
  try {
    const actual = evaluateHostLock(readActiveHostGraph(config.hostLockRuntimeRoot, config.hostLockProfileRoot), {
      platform: config.hostLockPlatform, profileKind: config.hostLockProfile,
    })
    if (actual.status !== 'supported') return actual
    if (actual.digest !== expected.digest) return { ...actual, status: 'unsupported', goalAvailable: false, reasonCode: 'host_lock_installed_graph_drift' }
    if (!auditedHostImplementation(config.hostLockRuntimeRoot, config.hostLockProfileRoot)) return { ...actual, status: 'unsupported', goalAvailable: false, reasonCode: 'host_lock_installed_graph_drift' }
    const audited = auditedForegroundRenderers(config.hostLockRuntimeRoot, config.hostLockProfileRoot)
    return audited.length ? { ...actual, auditedForegroundRenderers: audited,
      digest: createHash('sha256').update(`dsh.core-host-renderer/v1\0${actual.digest}\0${audited.join(',')}`).digest('hex') } : actual
  } catch {
    return { ...expected, status: 'unavailable', goalAvailable: false, reasonCode: 'host_lock_missing' }
  }
}

/** Observe one actual Host dispatch through Cordis without joining its gate. */
export function registerPassiveHostWorkdirObserver(agent: Agent, hostLockAtCall: () => HostLockEvaluation,
  attestedRouteAtCall: (tool: 'bash' | 'pwsh', provider: unknown, policyProvider: unknown) => Promise<boolean> | boolean,
  sourcedRootAtCall?: (exec: { arguments: unknown }) => number | undefined): () => void {
  if (typeof agent.ctx.on !== 'function') return () => {}
  const pending = new WeakMap<object, ReturnType<typeof captureHostWorkdir>>()
  const pre = agent.ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.agent === agent && (exec.name === 'bash' || exec.name === 'pwsh')) {
      try {
        // Context.get is the read-only service lookup without an inject
        // requirement. The same scoped sandboxPolicy service is used by the
        // audited Bash producer. A missing service produces no receipt.
        const policy = agent.ctx.get('sandboxPolicy') as { resolve(request: { session: Session }): unknown } | undefined
        const receipt = captureHostWorkdir(agent.session, exec, hostLockAtCall(), policy,
          await attestedRouteAtCall(exec.name, agent.ctx.get('shell'), policy), sourcedRootAtCall?.(exec) ?? null)
        if (receipt) pending.set(exec, receipt)
      } catch { /* Observation failure cannot deny an ordinary Host tool. */ }
    }
    return next()
  })
  const post = agent.ctx.on('tools/post-execute', async (exec, _result, next) => {
    const decision = await next()
    const receipt = pending.get(exec)
    pending.delete(exec)
    if (!receipt || exec.agent !== agent) return decision
    const context = createUserMessage({
      content: [{ type: 'text', text: `${HOST_WORKDIR_PREFIX}${JSON.stringify(receipt)}` }],
      source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice', summary: 'read-only Host workdir observation' },
    })
    return { ...decision, additionalContexts: [...decision.additionalContexts ?? [], context] }
  })
  return () => { pre(); post() }
}

/**
 * Executor and network seams for acceptance runs. They replace ONLY the two
 * things a deterministic test cannot do for real — spawning the mutation
 * binary and reaching the registry — and never the authorization gate, the
 * reservation/settlement records, or the evidence producers. Production
 * callers omit them and get the real implementations.
 */
export interface RuntimeExecutorSeams {
  commandRunner?: EvidenceToolRoots['commandRunner']
  fetcher?: EvidenceToolRoots['fetcher']
  allowLoopbackHttpRegistry?: boolean
  /**
   * Pin the audited host cohort instead of reading a live profile graph. An
   * acceptance run that already declared its cohort needs this because the
   * migration revalidation reads real filesystem roots; it replaces ONLY the
   * host-lock EVALUATION. The release ticket gate, the reservation and
   * settlement records, the evidence producers and the replay stay production
   * code, and the host lock keeps its own dedicated suites and native
   * acceptance.
   */
  hostLock?: HostLockEvaluation
  /** Isolated acceptance override for the provider-invisible durable ledger. */
  privateLedgerRoot?: string
}

export function apply(ctx: Context, rawConfig: {
  activation?: unknown
  hostLockPackages?: unknown
  hostLockPlatform?: unknown
  hostLockProfile?: unknown
  hostLockPolicy?: unknown
  hostLockRuntimeRoot?: unknown
  hostLockProfileRoot?: unknown
} = {}, seams: RuntimeExecutorSeams = {}): void {
  const config: ResolvedConfig = resolveConfig(rawConfig)
  // Runtime authority must come from the active profile/package graph, not a
  // nearest lockfile (profiles and the DSH runtime have separate locks). The
  // acceptance installer injects this bounded identity; absence is unknown.
  const installedHostLock = seams.hostLock ?? evaluateHostLock(config.hostLockPackages ?? [], {
    platform: config.hostLockPlatform,
    profileKind: config.hostLockProfile,
  })
  const runtimes = new Map<Agent, GuardRuntime>()
  const privateLedgerRoot = seams.privateLedgerRoot
    ?? resolvePrivateLedgerRoot(undefined, process.env.DSH_HOME, homedir())
  const hostLocks = new Map<Agent, HostLockEvaluation>()
  const ledgerContext = (agent: Agent, fallback: HostLockEvaluation = installedHostLock) => ({
    sessionId: String(agent.session.id),
    sessionHeader: structuredClone(agent.session.header) as unknown as Record<string, unknown>,
    cwd: sessionCwd(agent.session) ?? '', hostLockDigest: (hostLocks.get(agent) ?? fallback).digest,
  })
  const registrations = new Map<Agent, Array<() => unknown>>()
  const detach = (agent: Agent) => {
    const disposers = registrations.get(agent)
    registrations.delete(agent)
    for (const dispose of disposers?.slice().reverse() ?? []) dispose()
    runtimes.delete(agent)
    hostLocks.delete(agent)
  }
  ctx.effect?.(() => () => { for (const agent of registrations.keys()) detach(agent) })
  ctx.on('agent/disposed', ({ agent }) => { detach(agent) })
  const ensure = (agent: Agent) => {
    let runtime = runtimes.get(agent)
    if (!runtime) {
      const goals = optionalGoalService(ctx, agent)
      const refreshHostLock = () => {
        const evaluated = seams.hostLock ?? revalidateCoreLock(config, installedHostLock)
        const current = bindLiveGoalCapability(evaluated, Boolean(goals) && hasPinnedUpdateGoalTool(agent))
        hostLocks.set(agent, current)
        return current
      }
      const agentHostLock = refreshHostLock()
      runtime = createRuntime(agent, config, agentHostLock, goals ? () => goals.get(agent) : undefined, refreshHostLock,
        privateLedgerRoot ? () => readPrivateLedger(privateLedgerRoot, ledgerContext(agent, agentHostLock)) : undefined,
        privateLedgerRoot ? () => initializePrivateLedger(privateLedgerRoot, ledgerContext(agent, agentHostLock)) : undefined)
      runtimes.set(agent, runtime)
      hostLocks.set(agent, agentHostLock)
    }
    return runtime
  }

  // Register the slash command on the root commands service so it is visible
  // in the Web command directory and participates in first-slash parsing. The
  // per-agent runtime is resolved from the handler's `agent`.
  ctx.commands.register(createContextGuardCommand(
    (agent) => ensure(agent).projection,
    (agent, enabled) => ensure(agent).setEnabled(enabled),
    (agent) => ensure(agent).sync(),
    (agent) => ensure(agent).lifecycle,
  ))

  // T0 stays silent: agent/created registers tools and the runtime, reads
  // history, and arms recovery for resume/compact. It never appends Guard
  // messages, so a fresh session remains blank (seq 0) and the Web mode
  // picker can still stage a preset before the first real input.
  const attach = (agent: Agent, source?: string): undefined => {
    if (registrations.has(agent)) {
      if (source === 'resume' || source === 'compact') {
        const runtime = ensure(agent)
        runtime.sync()
        runtime.projection.lastRecoveryDigest = undefined
        runtime.markRecoveryNeeded(source === 'resume' ? 'resume' : 'compaction')
      }
      return
    }
    const disposers: Array<() => unknown> = []
    registrations.set(agent, disposers)
    const own = (dispose: (() => unknown) | void) => { if (dispose) disposers.push(dispose) }
    const ownedTools = {
      register: (...args: Parameters<typeof agent.ctx.tools.register>) => own(agent.ctx.tools.register(...args)),
      guard: (...args: Parameters<typeof agent.ctx.tools.guard>) => own(agent.ctx.tools.guard(...args)),
    }
    try {
    const runtime = ensure(agent)
    runtime.sync()
    if (source === 'resume' || source === 'compact') {
      // Forgetting the last injected digest guarantees the post-resume or
      // post-compaction reminder is injected at least once, even when the
      // packet content is unchanged.
      runtime.projection.lastRecoveryDigest = undefined
      runtime.markRecoveryNeeded(source === 'resume' ? 'resume' : 'compaction')
    }
    // Passive call-time Host context. This listener never changes the tool
    // decision: a missing policy, physical identity or durable note only makes
    // later completion evidence insufficient. The Host has already appended
    // tool/call before invoking this waterfall, so the note can bind its seq.
    own(registerPassiveHostWorkdirObserver(agent, () => seams.hostLock ?? revalidateCoreLock(config, installedHostLock),
      (tool, provider, policy) => config.hostLockRuntimeRoot && config.hostLockProfileRoot
        ? auditedDefaultWorkdirProvider(config.hostLockRuntimeRoot, config.hostLockProfileRoot, tool, provider, policy)
        : false,
      (exec) => {
        runtime.sync()
        return sourcedNamedTestRoot(runtime.projection, agent.session, exec.arguments)
      }))
    ownedTools.register(createRebindTool(() => runtime.projection, async () => {
      const durable = await ctx.sessions.flush(agent.session)
      runtime.setDurability(durable)
      runtime.sync()
      return durable
    }))
    ownedTools.register(createCheckpointTool(
      () => runtime.projection,
      () => runtime.markRecoveryNeeded('checkpoint_followup'),
      async () => {
        const durable = await ctx.sessions.flush(agent.session)
        runtime.setDurability(durable)
        runtime.sync()
        return durable
      },
    ))
    ownedTools.register(createBoundaryTool(
      () => runtime.projection,
      async () => {
        const durable = await ctx.sessions.flush(agent.session)
        runtime.setDurability(durable)
        runtime.sync()
        return durable
      },
      () => runtime.markRecoveryNeeded('boundary_update'),
    ))
    /** Persist release state outside provider-visible Session history. */
    const persistReleaseRecord = async (toolAgent: Agent, kind: 'release_reservation' | 'release_settlement',
      payload: Record<string, unknown>): Promise<boolean> => {
      if (toolAgent.session !== agent.session) return false
      if (!sessionCwd(agent.session)) return false
      const durable = appendPrivateLedger(privateLedgerRoot, ledgerContext(agent), kind, payload)
      runtime.sync()
      return durable
    }
    const evidenceOptions: EvidenceToolRoots & { hostCapability: RuntimeHostCapabilityEvaluator } = {
      hostCapability: createHostCapabilityEvaluator(hostLocks.get(agent) ?? installedHostLock),
      ...(seams.commandRunner ? { commandRunner: seams.commandRunner } : {}),
      ...(seams.fetcher ? { fetcher: seams.fetcher } : {}),
      ...(seams.allowLoopbackHttpRegistry ? { allowLoopbackHttpRegistry: true } : {}),
      prepareMutation: async (toolAgent) => {
        if (toolAgent.session !== agent.session) return false
        const durable = await ctx.sessions.flush(agent.session)
        runtime.setDurability(durable)
        runtime.sync()
        return durable
      },
      authorizeMutation: (request) => {
        // prepareMutation has already flushed and replayed the exact session.
        // A final sync keeps authorization bound to any synchronous append
        // performed between the durable gate and this check.
        runtime.sync()
        return authorizeMutationFromProjection(runtime.projection, request)
      },
      marketOrigin: optionalMarketOrigin(ctx, agent),
      hasRestartIntent: (resolutionCallId, serviceId, preGeneration) => hasPrivateRestartIntent(
        readPrivateLedger(privateLedgerRoot, ledgerContext(agent)), resolutionCallId, serviceId, preGeneration),
      // C10 explicit release: the gate is consulted before any publish effect.
      // It applies once a contract has been adopted OR the session policy is
      // `release`; before that, publishing keeps its existing Guard-owned
      // mutation authorization chain and nothing new is required. A granted
      // decision persists the one-shot reservation BEFORE the effect, and a
      // reservation that cannot be made durable is a denial, not a warning.
      releaseGate: async (request) => {
        runtime.sync()
        const projection = runtime.projection
        const applicable = projection.policy === 'release' || projection.releaseContracts.length > 0
        if (!applicable) return { status: 'denied', reasonCode: 'release_contract_not_adopted' }
        // The candidate identity comes from trusted readers: the action tool
        // read the artifact, and the runtime resolves the ref an ADOPTED
        // CONTRACT names, because that contract is the only closed, reachable
        // path for a ref (a model-supplied one would not be authority).
        const observed = { ...request.observed }
        const declaredContract = releaseContractFor(projection, request.operation)
        const declaredRef = declaredContract?.candidate.ref
        if (declaredRef !== undefined && observed.ref === undefined) {
          const cwd = sessionCwd(runtime.session)
          const refSha = await resolveAuditedRef(cwd, declaredRef, evidenceOptions, requestSignal())
          if (refSha !== undefined) {
            observed.ref = declaredRef
            observed.refSha = refSha
          }
        }
        const decision = releasePreEffectDecision(projection, {
          operation: request.operation,
          observed,
          resolvedTarget: request.resolvedTarget,
          nowEpochMs: Date.now(),
        })
        if (decision.status !== 'granted' || decision.contractId === undefined) {
          return { status: 'denied', reasonCode: decision.reasonCode }
        }
        const grantedContract = projection.releaseContracts.find((entry) => entry.contractId === decision.contractId)
        if (!grantedContract) return { status: 'denied', reasonCode: 'release_state_damaged' }
        const persisted = await persistReleaseRecord(agent, 'release_reservation', {
          contractId: decision.contractId,
          operation: request.operation,
          callId: request.callId,
          startedAtSeq: 0,
          status: 'in_flight',
          contract_sha256: privateLedgerContractDigest(grantedContract),
          target_sha256: privateLedgerTargetDigest(request.resolvedTarget),
          // Record the SRI the producer read, so a contract that froze only the
          // byte SHA-256 can still be reconciled later instead of becoming
          // permanently unsettleable.
          ...(observed.artifactSri !== undefined ? { observedArtifactSri: observed.artifactSri } : {}),
        })
        return persisted
          ? { status: 'granted', reasonCode: decision.reasonCode, contractId: decision.contractId }
          : { status: 'denied', reasonCode: 'release_reservation_not_durable' }
      },
      releaseSettle: async (request) => {
        // The runtime owns the final outcome because only it can compare the
        // readback with the adopted contract. A readback that names DIFFERENT
        // bytes than the contract froze is not a settlement: the attempt stays
        // unknown and locked, and the mismatch is reported.
        const contractId = request.contractId
          ?? releaseContractFor(runtime.projection, request.operation)?.contractId
          ?? 'unknown'
        const contract = runtime.projection.releaseContracts.find((entry) => entry.contractId === contractId)
        const reservation = reservationFor(runtime.projection, contractId, request.callId)
        let outcome: ReleaseSettlement['outcome'] = request.effect === 'not_effected' ? 'not_effected' : 'unknown'
        if (request.effect === 'completed' && contract) {
          const settled = readbackSettlesContract(contract, request.readback, reservation?.observedArtifactSri)
          outcome = settled === 'settled' ? 'settled' : 'unknown'
        }
        await persistReleaseRecord(agent, 'release_settlement', {
          // The settlement belongs to the contract the granted reservation
          // belonged to. Derive pins settledAtSeq to the durable event, so the
          // payload's placeholder cannot be forged by a replay.
          contractId,
          operation: request.operation,
          callId: request.callId,
          settledAtSeq: 0,
          readback: request.readback,
          outcome,
          settlement_source: 'effect',
        })
      },
      persistRestartIntent: async (toolAgent, intent) => {
        if (toolAgent.session !== agent.session) return false
        if (!sessionCwd(agent.session)) return false
        const snapshot = readPrivateLedger(privateLedgerRoot, ledgerContext(agent))
        if (snapshot.damaged || !snapshot.anchored) return false
        const durable = appendPrivateLedger(privateLedgerRoot, ledgerContext(agent), 'restart_intent', {
          resolution_call_id: intent.resolutionCallId,
          service_id: intent.serviceId,
          pre_generation: intent.preGeneration,
        })
        runtime.sync()
        return durable
      },
    }
    ownedTools.register(createEvidenceTool(evidenceOptions))
    ownedTools.register(createNativeFileObserver({
      fs: (ctx as unknown as Parameters<typeof createNativeFileObserver>[0]).fs,
      flush: (session) => ctx.sessions.flush(session as Session),
    }))
    ownedTools.register(createNativeGitObserver({ flush: (session) => ctx.sessions.flush(session as never) }))
    ownedTools.register(createTestReadinessObserver({
      getProjection: () => runtime.projection,
      fs: (ctx as unknown as Parameters<typeof createTestReadinessObserver>[0]).fs,
      flush: (session) => ctx.sessions.flush(session as Session),
    }))
    ownedTools.register(createActionTool(evidenceOptions))
    ownedTools.register(createPrepareTool({
      getProjection: () => runtime.projection,
      hostCapability: (action) => {
        const evaluation = createHostCapabilityEvaluator(hostLocks.get(agent) ?? installedHostLock)(action)
        return { status: evaluation.status, reasonCode: evaluation.reasonCode }
      },
      commandTemplate: (action) => GIT_COMMAND_TEMPLATES[action as GitAdapterAction],
      // 0.6.0 fresh projection: prepare is a public read entry, so it must see
      // the input this step persisted — a pre-step sync alone is older than the
      // step's own root message, which is how a correct ID still missed.
      refreshProjection: async () => {
        const durable = await ctx.sessions.flush(agent.session)
        runtime.setDurability(durable)
        runtime.sync()
        return durable
      },
    }))
    ownedTools.register(createInterpretTool({
      getProjection: () => runtime.projection,
      refreshProjection: async () => {
        const durable = await ctx.sessions.flush(agent.session)
        runtime.setDurability(durable)
        runtime.sync()
        return durable
      },
    }))
    ownedTools.register(createReleaseTool({
      getProjection: () => runtime.projection,
      fetcher: evidenceOptions.fetcher,
      ...(evidenceOptions.allowLoopbackHttpRegistry ? { allowLoopbackHttpRegistry: true } : {}),
      persistSettlement: async (request) => persistReleaseRecord(request.agent as Agent, 'release_settlement', {
        contractId: request.contractId,
        operation: request.operation,
        callId: request.callId,
        settledAtSeq: 0,
        readback: request.readback,
        outcome: request.outcome,
        settlement_source: 'reconcile',
      }),
    }))
    ownedTools.register(createExternalOperationTool(
      (id, toolAgent) => readExternalOperation(ctx, toolAgent as Agent | undefined, id),
      () => evaluateExternalWaitCapability(hostLocks.get(agent) ?? installedHostLock),
    ))
    ownedTools.guard((exec) => goalCompletionDenial(
      runtime.projection,
      exec.name,
      exec.arguments,
    ))
    } catch (error) {
      detach(agent)
      throw error
    }
  }
  ctx.on('agent/created', ({ agent, source, signal }) => {
    signal?.throwIfAborted()
    return attach(agent, source)
  })
  // rc.2 does not replay creation when a plugin is enabled on live agents.
  // Attach existing agents once, without inventing a startup/resume cause.
  for (const agent of ctx.get?.('agents')?.list() ?? []) attach(agent)
  // T1 activation: the loop claims this step's input before persisting it, so
  // first-step injections are decided from the validated claim (pure preview)
  // and delivered INSIDE the same step batch, ahead of the root message. The
  // formal projection still derives only from durable events.
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const durability = await ctx.sessions.flush(agent.session)
    const runtime = ensure(agent)
    runtime.setDurability(durability)
    runtime.sync()
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const injected: ReturnType<typeof createUserMessage>[] = []
    const delegated = isDelegatedSession(agent.session)
    let boundaryPending = !runtime.protocolV6Present
    const firstStep = previewFirstStepInjection(
      { activation: config.activation, enabled: runtime.projection.enabled, boundaryV5Present: runtime.protocolV5Present, boundaryV6Present: runtime.protocolV6Present, targetProtocol: 6, boundaryPresent: runtime.protocolV4Present, delegated, policy: runtime.projection.policy },
      claimedBatchHasRealRootInput(decision.messages),
    )
    if (firstStep) {
      injected.push(pluginNoticeMessage(firstStep.boundary, 'Context Guard recorded a replay version boundary'))
      if (runtime.lifecycle === 'armed') injected.push(pluginNoticeMessage(firstStep.guidance, 'Context Guard first-step protection guidance'))
      boundaryPending = false
    }
    // Read the auditable trigger set BEFORE consuming the arm: the consume
    // clears it, and the title must still name why this reminder exists.
    const armedRecoveryCauses = runtime.recoveryCauses ?? []
    if (runtime.projection.enabled && runtime.consumeRecovery()) {
      // Open work is judged by the SAME view the packet renders (DSH-RF-01):
      // in the default v6 ordinary lane a confirmed-observed closure has
      // nothing current to recover, while standing prohibitions and an
      // unavailable view still deserve their bounded reminder. Outside that
      // lane the historical pending/rejection semantics decide.
      const current = currentV6Feedback(runtime.projection)
      const standingConstraints = current
        ? Object.values(current.predicates).filter((state) => state === 'constraint_active').length
        : 0
      const hasOpenWork = current
        ? current.status !== 'observed' || standingConstraints > 0
        : [...runtime.projection.items.values()].some((item) => item.status === 'pending')
      const hasRejections = current === undefined
        && (runtime.projection.lastCheckpointRejections?.length ?? 0) > 0
      const recovery = hasOpenWork || hasRejections
        ? renderRecoveryPacket(runtime.projection, { charBudget: 4000 })
        : undefined
      const digest = recovery ? recoveryDigest(recovery, runtime.projection) : undefined
      if (recovery && digest !== runtime.projection.lastRecoveryDigest) {
        // Content dedup (v0.2.1): a rejection loop with an unchanged packet
        // injects once; new evidence or a new contract changes the digest and
        // is reminded again.
        runtime.projection.lastRecoveryDigest = digest
        // The first 0.5 write into a pre-0.5 session is the explicit version
        // cut: duties and certificates before it keep their historical rules.
        // At most one boundary rides per step, never one per injection path.
        if (boundaryPending && !delegated) {
          injected.push(pluginNoticeMessage(PROTOCOL_V6_NOTICE, 'Context Guard recorded a replay version boundary'))
          boundaryPending = false
        }
        // The title names the auditable trigger(s); an unknown cause renders
        // the neutral form instead of claiming compaction or resume that never
        // happened (DSH-RF-02).
        const title = recoveryTitle(armedRecoveryCauses)
        injected.push(createUserMessage({
          content: [{ type: 'text', text: `${title}\n${recovery}` }],
          source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice', summary: boundContextSummary('recovering open task requirements') },
        }))
      }
    }
    if (injected.length > 0) decision.messages = [...injected, ...decision.messages]
    return decision
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const runtime = ensure(agent)
    const goals = optionalGoalService(ctx, agent)
    await handleGuardTurnStopping(agent, runtime, {
      flush: () => ctx.sessions.flush(agent.session),
      hostSupported: runtime.projection.hostStatus === 'supported',
      externalWaitCapability: evaluateExternalWaitCapability(hostLocks.get(agent) ?? installedHostLock),
      ...(goals ? { goalAccess: {
        get: async () => normalizeGoalState(await goals.get(agent)),
        disarm: async () => normalizeGoalState(await goals.disarm(agent)),
      } } : {}),
      readExternalOperation: (id) => readExternalOperation(ctx, agent, id),
    })
  })
}

export function readExternalOperation(ctx: Context, agent: Agent | undefined, id: string): ExternalOperationSnapshot | undefined {
  if (!agent || !id) return undefined
  if (!agent.session || agent.id !== agent.session.id) return undefined
  try {
    const service = agent.ctx.get('jobs') ?? ctx.get('jobs')
    if (!service) return undefined
    const row = service.get(JobId(id), agent.id)
    if (!row || row.id !== id) return undefined
    const status: ExternalOperationSnapshot['status'] = row.status === 'running' ? 'running'
      : row.status === 'stopping' ? 'pending'
        : row.status === 'completed' ? 'completed'
          : row.status === 'killed' || row.status === 'failed' ? 'failed' : 'unknown'
    return { id, status, adapterId: 'dsh.jobs.v1' }
  } catch {
    return undefined
  }
}

function optionalMarketOrigin(ctx: Context, agent: Agent): string | undefined {
  for (const owner of [agent.ctx, ctx] as unknown as Array<{ get?: (name: string) => unknown }>) {
    try {
      const service = owner.get?.('webServer') as { host?: unknown; port?: unknown } | undefined
      if (!service || (service.host !== '127.0.0.1' && service.host !== '::1')
        || typeof service.port !== 'number' || !Number.isInteger(service.port) || service.port < 1 || service.port > 65535) continue
      return `http://${service.host === '::1' ? '[::1]' : '127.0.0.1'}:${service.port}`
    } catch {
      // Headless profiles intentionally do not expose the Web carrier.
    }
  }
  return undefined
}

/** Build one host-approved plugin notice user/message for step-batch delivery. */
function pluginNoticeMessage(text: string, summaryLabel: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice', summary: boundContextSummary(summaryLabel) },
  })
}

interface OptionalGoalService {
  get(agent: Agent): unknown | Promise<unknown>
  disarm(agent: Agent): unknown | Promise<unknown>
}

export function hasPinnedUpdateGoalTool(agent: Agent): boolean {
  try {
    const runtime = (agent.ctx as unknown as { tools?: { get?: (name: string, scope?: unknown) => unknown } }).tools
    const tool = runtime?.get?.('update_goal', agent)
    if (!tool || typeof tool !== 'object') return false
    const row = tool as Record<string, unknown>
    if (row.name !== 'update_goal' || typeof row.execute !== 'function') return false
    const parameters = row.parameters as Record<string, unknown> | undefined
    if (!parameters || parameters.type !== 'object' || !parameters.properties || typeof parameters.properties !== 'object') return false
    const fields = parameters.properties as Record<string, unknown>
    const requiredNames = parameters.required
    if (!Array.isArray(requiredNames)
      || JSON.stringify([...requiredNames].sort()) !== JSON.stringify(['action', 'goal_id', 'revision'])) return false
    if (JSON.stringify(Object.keys(fields).sort()) !== JSON.stringify([
      'action', 'blocked_reason', 'goal_id', 'max_goal_rounds', 'objective', 'revision',
    ])) return false
    const required = (name: string, type: string) => {
      const field = fields[name]
      return Boolean(field && typeof field === 'object'
        && (field as Record<string, unknown>).type === type
        && requiredNames.includes(name))
    }
    const action = fields.action as Record<string, unknown> | undefined
    return required('goal_id', 'string') && required('revision', 'number') && required('action', 'string')
      && Array.isArray(action?.enum)
      && JSON.stringify(action.enum) === JSON.stringify(['edit', 'pause', 'resume', 'complete', 'blocked'])
  } catch {
    return false
  }
}

function optionalGoalService(ctx: Context, agent: Agent): OptionalGoalService | undefined {
  for (const owner of [agent.ctx, ctx] as unknown as Array<{ get?: (name: string) => unknown }>) {
    try {
      const service = owner.get?.('goals') as Partial<OptionalGoalService> | undefined
      if (service && typeof service.get === 'function' && typeof service.disarm === 'function') return service as OptionalGoalService
    } catch {
      // Optional peer: a profile without Goal must still load.
    }
  }
  return undefined
}

function normalizeGoalState(value: unknown): GoalActivationState | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const goal = (record.goal && typeof record.goal === 'object' ? record.goal : record) as Record<string, unknown>
  const id = goal.id
  const revision = goal.revision
  const phase = goal.phase
  const activation = record.activation ?? goal.activation
  if (typeof id !== 'string' || typeof revision !== 'number') return undefined
  if (!['active', 'paused', 'blocked', 'complete'].includes(String(phase))) return undefined
  if (activation !== 'armed' && activation !== 'disarmed') return undefined
  return { id, revision, phase: phase as GoalActivationState['phase'], activation }
}
