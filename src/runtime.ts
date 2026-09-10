import { createRebindTool } from './tools/rebind.js'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from './domain/digest.js'
import { createProjection, type GuardProjection } from './domain/types.js'
import { deriveProjection, PROTOCOL_V4_NOTICE } from './domain/derive.js'
import { claimedBatchHasRealRootInput, lifecyclePhase, previewFirstStepInjection, type LifecyclePhase } from './domain/lifecycle.js'
import { goalCompletionDenial } from './domain/goal-gate.js'
import { decideTurnBoundary } from './domain/stop-policy.js'
import { recoveryDigest, renderRecoveryPacket } from './domain/recovery.js'
import { createCheckpointTool } from './tools/checkpoint.js'
import { createBoundaryTool } from './tools/boundary.js'
import { createPrepareTool } from './tools/prepare.js'
import { GIT_COMMAND_TEMPLATES, type GitAdapterAction } from './domain/git-adapter.js'
import {
  createActionTool,
  createEvidenceTool,
  RESTART_INTENT_PREFIX,
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
  effectuateBoundary,
  isCurrentAcceptedBoundary,
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
import { createContextGuardCommand } from './commands/context-guard.js'
import { resolveConfig, type ResolvedConfig } from './config.js'
import { readActiveHostGraph } from './domain/host-resolver.js'
import { snapshotSessionEvents } from './domain/session-events.js'

export const name = 'context-guard'
export const inject = ['sessions', 'commands'] as const

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
  sync(): void
  setEnabled(_enabled: boolean): void
  setDurability(confirmed: boolean): void
  markRecoveryNeeded(): void
  consumeRecovery(): boolean
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
  if (!requestedTargetAuthorizesMutation(request.action, item.requestedTarget, request.resolvedTarget)) {
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
  return { status: 'authorized', reasonCode: 'mutation_root_contract_authorized' }
}

export const PROTOCOL_CORRECTION_NOTICE = 'Context Guard protocol correction: root-authorized work remains pending; continue with tools or obtain a typed boundary.'

export interface RuntimeTurnStoppingAccess {
  flush(): Promise<boolean>
  goalAccess?: GoalBoundaryAccess
  hostSupported: boolean
  externalWaitCapability?: ExternalOperationCapability
  readExternalOperation(id: string): ExternalOperationSnapshot | undefined
}

/** Production Stop boundary: durable replay first, then immutable/live checks. */
export async function handleGuardTurnStopping(
  agent: Agent,
  runtime: GuardRuntime,
  access: RuntimeTurnStoppingAccess,
): Promise<string> {
  const durable = await access.flush()
  runtime.setDurability(durable)
  runtime.sync()
  if (!durable) return 'boundary_flush_failed'

  const decision = decideTurnBoundary(runtime.projection)
  if (decision.action === 'continue') {
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: PROTOCOL_CORRECTION_NOTICE }],
      source: { kind: 'plugin', plugin: 'context-guard', form: 'notice', summary: boundContextSummary('requesting the one allowed protocol correction step') },
    }))
    return decision.reason ?? 'protocol_correction_steer'
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

function sessionHeaderForDigest(session: Session): SessionHeader | undefined {
  const raw = session.header as unknown as Record<string, unknown> | undefined
  if (!raw || typeof raw.version !== 'number' || typeof raw.id !== 'string' || typeof raw.createdAt !== 'number') return undefined
  return {
    version: raw.version, id: raw.id, createdAt: raw.createdAt,
    ...(typeof raw.parentSession === 'string' ? { parentSession: raw.parentSession } : {}),
    ...(typeof raw.seedLength === 'number' ? { seedLength: raw.seedLength } : {}),
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
): GuardRuntime {
  const projection = createProjection()
  const session = agent.session
  let pendingRecovery = false
  let durabilityConfirmed = false
  let observedEpoch = -1
  let observedCompactionSeq = -1
  let observedContractRevision = -1
  let protocolV4Present = false
  let realRootInputSeen = false
  let lifecycle: LifecyclePhase = 'armed'
  const continuationAttempts = projection.continuationAttempts
  const persistenceCorrectionAttempts = projection.persistenceCorrectionAttempts

  const rebuild = () => {
    if (refreshHostLock) hostLock = refreshHostLock()
    const header = session.header as { cwd?: unknown } | undefined
    // The recovery digest is runtime-owned liveness state like the per-turn
    // attempt cap; Object.assign would otherwise flush it with the fresh
    // projection's undefined.
    const priorRecoveryDigest = projection.lastRecoveryDigest
    const derived = deriveProjection(
      snapshotSessionEvents(session) as Parameters<typeof deriveProjection>[0],
      { activation: config.activation },
      { cwd: typeof header?.cwd === 'string' ? header.cwd : '', sessionHeader: sessionHeaderForDigest(session) },
      durabilityConfirmed,
      hostLock,
    )
    Object.assign(projection, derived.projection)
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
    // Liveness state must survive rebuilds: the per-turn attempt cap and the
    // one-shot recovery arm are owned by the runtime, not the projection.
    projection.continuationAttempts = continuationAttempts
    projection.persistenceCorrectionAttempts = persistenceCorrectionAttempts
    projection.lastRecoveryDigest = priorRecoveryDigest
    // Startup lifecycle facts for the first-step injection decision and the
    // status surface: the v4 boundary and the real-input observation are both
    // derived from the same durable log as the contract.
    protocolV4Present = derived.protocolV4Present
    realRootInputSeen = derived.realRootInputSeen
    lifecycle = lifecyclePhase({ enabled: projection.enabled, realInputSeen: realRootInputSeen })
    // A newly observed epoch means enablement transitioned since the last
    // rebuild; the first rebuild only records the baseline. Recovery re-arms
    // and the content dedup forgets the last packet, so the first reminder
    // after a transition is always injected.
    if (observedEpoch >= 0 && derived.projection.epoch > observedEpoch) {
      pendingRecovery = true
      projection.lastRecoveryDigest = undefined
    }
    observedEpoch = derived.projection.epoch
    if (observedContractRevision >= 0 && projection.contractRevision !== observedContractRevision) pendingRecovery = true
    observedContractRevision = projection.contractRevision
    // Compaction summaries stay in the historical log forever, so only re-arm
    // recovery when a NEW summary is observed, keyed by its sequence.
    if (derived.lastCompactionSeq > observedCompactionSeq) {
      pendingRecovery = true
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
  }
  const markRecoveryNeeded = () => {
    pendingRecovery = true
  }
  const consumeRecovery = () => {
    const was = pendingRecovery
    pendingRecovery = false
    return was
  }

  rebuild()
  return {
    projection,
    session,
    get lifecycle() { return lifecycle },
    get protocolV4Present() { return protocolV4Present },
    sync,
    setEnabled,
    setDurability,
    markRecoveryNeeded,
    consumeRecovery,
  }
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
    return actual
  } catch {
    return { ...expected, status: 'unavailable', goalAvailable: false, reasonCode: 'host_lock_missing' }
  }
}

export function apply(ctx: Context, rawConfig: {
  activation?: unknown
  hostLockPackages?: unknown
  hostLockPlatform?: unknown
  hostLockProfile?: unknown
  hostLockPolicy?: unknown
  hostLockRuntimeRoot?: unknown
  hostLockProfileRoot?: unknown
} = {}): void {
  const config: ResolvedConfig = resolveConfig(rawConfig)
  // Runtime authority must come from the active profile/package graph, not a
  // nearest lockfile (profiles and the DSH runtime have separate locks). The
  // acceptance installer injects this bounded identity; absence is unknown.
  const installedHostLock = evaluateHostLock(config.hostLockPackages ?? [], {
    platform: config.hostLockPlatform,
    profileKind: config.hostLockProfile,
  })
  const runtimes = new Map<Agent, GuardRuntime>()
  const hostLocks = new Map<Agent, HostLockEvaluation>()
  const registeredAgents = new WeakSet<Agent>()
  const ensure = (agent: Agent) => {
    let runtime = runtimes.get(agent)
    if (!runtime) {
      const goals = optionalGoalService(ctx, agent)
      const refreshHostLock = () => {
        const current = bindLiveGoalCapability(revalidateCoreLock(config, installedHostLock), Boolean(goals) && hasPinnedUpdateGoalTool(agent))
        hostLocks.set(agent, current)
        return current
      }
      const agentHostLock = refreshHostLock()
      runtime = createRuntime(agent, config, agentHostLock, goals ? () => goals.get(agent) : undefined, refreshHostLock)
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

  // T0 stays silent: session-start registers tools and the runtime, reads
  // history, and arms recovery for resume/compact. It never appends Guard
  // messages, so a fresh session remains blank (seq 0) and the Web mode
  // picker can still stage a preset before the first real input.
  ctx.on('agent/session-start', ({ agent, source }) => {
    const runtime = ensure(agent)
    runtime.sync()
    if (source === 'resume' || source === 'compact') {
      // Forgetting the last injected digest guarantees the post-resume or
      // post-compaction reminder is injected at least once, even when the
      // packet content is unchanged.
      runtime.projection.lastRecoveryDigest = undefined
      runtime.markRecoveryNeeded()
    }
    if (registeredAgents.has(agent)) return
    registeredAgents.add(agent)
    agent.ctx.tools.register(createRebindTool(() => runtime.projection, async () => {
      const durable = await ctx.sessions.flush(agent.session)
      runtime.setDurability(durable)
      runtime.sync()
      return durable
    }))
    agent.ctx.tools.register(createCheckpointTool(
      () => runtime.projection,
      () => runtime.markRecoveryNeeded(),
      async () => {
        const durable = await ctx.sessions.flush(agent.session)
        runtime.setDurability(durable)
        runtime.sync()
        return durable
      },
    ))
    agent.ctx.tools.register(createBoundaryTool(
      () => runtime.projection,
      async () => {
        const durable = await ctx.sessions.flush(agent.session)
        runtime.setDurability(durable)
        runtime.sync()
        return durable
      },
      () => runtime.markRecoveryNeeded(),
    ))
    const evidenceOptions: EvidenceToolRoots & { hostCapability: RuntimeHostCapabilityEvaluator } = {
      hostCapability: createHostCapabilityEvaluator(hostLocks.get(agent) ?? installedHostLock),
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
      persistRestartIntent: async (toolAgent, intent) => {
        const session = toolAgent.session as Session
        const append = (session as unknown as { append: (type: string, data: unknown, options?: unknown) => unknown }).append.bind(session)
        append('user/message', createUserMessage({
          content: [{ type: 'text', text: `${RESTART_INTENT_PREFIX}${JSON.stringify({
            resolution_call_id: intent.resolutionCallId,
            service_id: intent.serviceId,
            pre_generation: intent.preGeneration,
          })}` }],
          source: { kind: 'plugin', plugin: 'context-guard', form: 'notice', summary: boundContextSummary('persisting a restart handoff intent') },
        }), { surfaceOp: 'append' })
        const durable = await ctx.sessions.flush(session)
        runtime.setDurability(durable)
        runtime.sync()
        return durable
      },
    }
    agent.ctx.tools.register(createEvidenceTool(evidenceOptions))
    agent.ctx.tools.register(createActionTool(evidenceOptions))
    agent.ctx.tools.register(createPrepareTool({
      getProjection: () => runtime.projection,
      hostCapability: (action) => {
        const evaluation = createHostCapabilityEvaluator(hostLocks.get(agent) ?? installedHostLock)(action)
        return { status: evaluation.status, reasonCode: evaluation.reasonCode }
      },
      commandTemplate: (action) => GIT_COMMAND_TEMPLATES[action as GitAdapterAction],
    }))
    agent.ctx.tools.register(createExternalOperationTool(
      (id, toolAgent) => readExternalOperation(ctx, toolAgent as Agent | undefined, id),
      () => evaluateExternalWaitCapability(hostLocks.get(agent) ?? installedHostLock),
    ))
    agent.ctx.tools.guard((exec) => goalCompletionDenial(
      runtime.projection,
      exec.name,
      exec.arguments,
    ))
  })
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
    let boundaryPending = !runtime.protocolV4Present
    const firstStep = previewFirstStepInjection(
      { activation: config.activation, enabled: runtime.projection.enabled, boundaryPresent: runtime.protocolV4Present, delegated },
      claimedBatchHasRealRootInput(decision.messages),
    )
    if (firstStep) {
      injected.push(pluginNoticeMessage(firstStep.boundary, 'Context Guard recorded a replay version boundary'))
      if (runtime.lifecycle === 'armed') injected.push(pluginNoticeMessage(firstStep.guidance, 'Context Guard first-step protection guidance'))
      boundaryPending = false
    }
    if (runtime.projection.enabled && runtime.consumeRecovery()) {
      // A session with nothing open has nothing to recover: a "0 pending"
      // packet is noise, not a reminder.
      const hasOpenWork = [...runtime.projection.items.values()].some((item) => item.status === 'pending')
      const hasRejections = (runtime.projection.lastCheckpointRejections?.length ?? 0) > 0
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
          injected.push(pluginNoticeMessage(PROTOCOL_V4_NOTICE, 'Context Guard recorded a replay version boundary'))
          boundaryPending = false
        }
        injected.push(createUserMessage({
          content: [{ type: 'text', text: `Open task requirements (recovered after compaction or resume):\n${recovery}` }],
          source: { kind: 'plugin', plugin: 'context-guard', form: 'notice', summary: boundContextSummary('recovering open task requirements') },
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
  for (const owner of [agent.ctx, ctx] as unknown as Array<{ get?: (name: string) => unknown; jobs?: unknown }>) {
    try {
      const service = owner.get?.('jobs') ?? owner.jobs
      if (!service || typeof service !== 'object') continue
      const row = typeof (service as { get?: unknown }).get === 'function'
        ? (service as { get(id: string, agent: Agent): unknown }).get(id, agent) as Record<string, unknown> | undefined : undefined
      if (!row) return undefined
      const raw = String(row.status ?? 'unknown')
      const status: ExternalOperationSnapshot['status'] = raw === 'running' ? 'running'
        : raw === 'stopping' ? 'pending'
          : raw === 'completed' ? 'completed'
            : raw === 'killed' || raw === 'failed' ? 'failed' : 'unknown'
      return { id, status, adapterId: 'dsh.jobs.v1' }
    } catch {
      return undefined
    }
  }
  return undefined
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
    source: { kind: 'plugin', plugin: 'context-guard', form: 'notice', summary: boundContextSummary(summaryLabel) },
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
