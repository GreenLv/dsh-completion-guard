import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { createProjection, type GuardProjection } from './domain/types.js'
import { deriveProjection } from './domain/derive.js'
import { goalCompletionDenial } from './domain/goal-gate.js'
import { decideTurnStopping, latestAssistantText } from './domain/stop-policy.js'
import { recoveryDigest, renderRecoveryPacket } from './domain/recovery.js'
import { createCheckpointTool } from './tools/checkpoint.js'
import { createContextGuardCommand } from './commands/context-guard.js'
import { resolveConfig, type ResolvedConfig } from './config.js'

const MAX_CONTINUATION_ATTEMPTS_PER_TURN = 2

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
  sync(): void
  setEnabled(_enabled: boolean): void
  setDurability(confirmed: boolean): void
  markRecoveryNeeded(): void
  consumeRecovery(): boolean
}

export function createRuntime(agent: Agent, config: ResolvedConfig): GuardRuntime {
  const projection = createProjection()
  const session = agent.session
  let pendingRecovery = false
  let durabilityConfirmed = false
  let observedEpoch = -1
  let observedCompactionSeq = -1
  const continuationAttempts = projection.continuationAttempts

  const rebuild = () => {
    const header = session.header as { cwd?: unknown } | undefined
    // The recovery digest is runtime-owned liveness state like the per-turn
    // attempt cap; Object.assign would otherwise flush it with the fresh
    // projection's undefined.
    const priorRecoveryDigest = projection.lastRecoveryDigest
    const derived = deriveProjection(
      session.events as unknown as Parameters<typeof deriveProjection>[0],
      { activation: config.activation },
      { cwd: typeof header?.cwd === 'string' ? header.cwd : '' },
      durabilityConfirmed,
    )
    Object.assign(projection, derived.projection)
    // Liveness state must survive rebuilds: the per-turn attempt cap and the
    // one-shot recovery arm are owned by the runtime, not the projection.
    projection.continuationAttempts = continuationAttempts
    projection.lastRecoveryDigest = priorRecoveryDigest
    // A newly observed epoch means enablement transitioned since the last
    // rebuild; the first rebuild only records the baseline. Recovery re-arms
    // and the content dedup forgets the last packet, so the first reminder
    // after a transition is always injected.
    if (observedEpoch >= 0 && derived.projection.epoch > observedEpoch) {
      pendingRecovery = true
      projection.lastRecoveryDigest = undefined
    }
    observedEpoch = derived.projection.epoch
    // Compaction summaries stay in the historical log forever, so only re-arm
    // recovery when a NEW summary is observed, keyed by its sequence.
    if (derived.lastCompactionSeq > observedCompactionSeq) {
      pendingRecovery = true
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
  return { projection, session, sync, setEnabled, setDurability, markRecoveryNeeded, consumeRecovery }
}

export function apply(ctx: Context, rawConfig: { activation?: unknown } = {}): void {
  const config: ResolvedConfig = resolveConfig(rawConfig)
  const runtimes = new Map<Agent, GuardRuntime>()
  const ensure = (agent: Agent) => {
    let runtime = runtimes.get(agent)
    if (!runtime) {
      runtime = createRuntime(agent, config)
      runtimes.set(agent, runtime)
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
  ))

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
    agent.ctx.tools.register(createCheckpointTool(
      () => runtime.projection,
      () => runtime.markRecoveryNeeded(),
    ))
    agent.ctx.tools.guard((exec) => goalCompletionDenial(
      runtime.projection,
      exec.name,
      exec.arguments,
    ))
  })
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const durability = await ctx.sessions.flush(agent.session)
    const runtime = ensure(agent)
    runtime.setDurability(durability)
    runtime.sync()
    const decision = await next()
    if (decision.kind === 'enter' && runtime.projection.enabled && runtime.consumeRecovery()) {
      const recovery = renderRecoveryPacket(runtime.projection, { charBudget: 4000 })
      const digest = recovery ? recoveryDigest(recovery, runtime.projection) : undefined
      if (recovery && digest !== runtime.projection.lastRecoveryDigest) {
        // Content dedup (v0.2.1): a rejection loop with an unchanged packet
        // injects once; new evidence or a new contract changes the digest and
        // is reminded again.
        runtime.projection.lastRecoveryDigest = digest
        decision.messages = [...decision.messages, createUserMessage({
          content: [{ type: 'text', text: `Open task requirements (recovered after compaction or resume):\n${recovery}` }],
          source: { kind: 'plugin', plugin: 'context-guard', form: 'notice', summary: boundContextSummary('recovering open task requirements') },
        })]
      }
    }
    return decision
  })
  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    const durability = await ctx.sessions.flush(agent.session)
    const runtime = ensure(agent)
    runtime.setDurability(durability)
    runtime.sync()
    const assistantText = latestAssistantText(runtime.session.events)
    const decision = decideTurnStopping(runtime.projection, assistantText, turn, MAX_CONTINUATION_ATTEMPTS_PER_TURN)
    if (decision.action === 'continue') {
      const recovery = renderRecoveryPacket(runtime.projection, { charBudget: 4000 })
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: `Completion is not certified. ${recovery}` }],
        source: { kind: 'plugin', plugin: 'context-guard', form: 'notice', summary: boundContextSummary('completion requires a Context Guard checkpoint') },
      }))
    }
  })
}
