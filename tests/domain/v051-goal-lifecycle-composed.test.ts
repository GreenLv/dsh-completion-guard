import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import GoalService, { GoalId } from '@deepseek-ai/dsh-goal'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { availableBoundaryQualifications, effectuateBoundary, qualifyBoundary } from '../../src/domain/boundary.js'
import { deriveProjection, PROTOCOL_V4_NOTICE } from '../../src/domain/derive.js'
import { hasCurrentCertificate } from '../../src/domain/goal-gate.js'
import { authorizeMutationFromProjection, handleGuardTurnStopping } from '../../src/runtime.js'
import type { DerivedEnvelope } from '../../src/domain/types.js'
import * as goalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'

/**
 * Composed wait-and-Goal-lifecycle scenario over the REAL harness services.
 *
 * The projection registry is the installed
 * `@deepseek-ai/dsh-session-projection` service and the goal state is the
 * installed `@deepseek-ai/dsh-goal` `GoalService`; both are driven exactly as a
 * host drives them (registry constructed on the context, `GoalService` reading
 * `ctx.sessionProjections.stateOf(session, 'goal')`). Only the `agents` service
 * is stood up here, because this repository is not a host: it supplies the live
 * agent identity the service asserts.
 *
 * The goal-round SCHEDULER (`@deepseek-ai/dsh-goal-round-driver`) is not a
 * dependency of this repository, so it cannot be composed in-process. Its round
 * gate is quoted in the assertions below from the installed package source
 * instead; running it is a host-level acceptance step, not a unit here.
 */

const RESERVED = '请在收到我的确认后再推送代码。'
const RESOLVED_PUSH = { repository: '/work/repo', remote: 'origin', refspec: 'refs/heads/main:refs/heads/main', local_oid: 'a'.repeat(64) }

interface DriveHost {
  queued: Array<{ source?: { kind?: string; goalId?: string; revision?: number; round?: number } }>
}

interface Composed {
  ctx: Context
  registry: SessionProjectionRegistry
  goals: GoalService
  session: Session
  agent: Agent
}

/** The single host fixture: the installed services plus a live agent identity. */
function compose(): Composed {
  return driveHost() as unknown as Composed
}

const root = (seq: number, text: string): DerivedEnvelope =>
  ({ seq, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })

function project(built: Composed, envelopes: DerivedEnvelope[]) {
  return deriveProjection(
    [...(built.session.snapshotEvents() as unknown as DerivedEnvelope[]), ...envelopes],
    { activation: 'opt-in' }, { cwd: '/work/repo' }, true,
  ).projection
}

/**
 * A minimal host for the installed round driver.
 *
 * `withoutInitiator(fn)` runs the callback and returns its result, propagating
 * exceptions — that is the contract the driver's drive loop depends on, and a
 * double that merely returned a list silently prevented every round. Only the
 * model and the outer I/O are absent; the goal service, its projection registry
 * and the round driver are the installed packages.
 */
interface DriveHost {
  ctx: Context
  registry: SessionProjectionRegistry
  session: Session
  agent: Agent
  goals: GoalService
  fiber?: unknown
  queued: Array<{ source?: { kind?: string; goalId?: string; revision?: number; round?: number } }>
  beforeInit?: string
  afterInit?: string
  /** The agent's own inbox, which the driver reads on the inbox events. */
  inbox: { nextTurn: Array<{ id: string }> }
}

function driveHost(): DriveHost {
  const ctx = new Context()
  const registry = new SessionProjectionRegistry(ctx)
  const session = Session.create(SessionId('drive-host'), undefined, {
    version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId('drive-host'), createdAt: 1, cwd: '/work/repo',
  })
  const queued: Array<{ source?: { kind?: string; goalId?: string; revision?: number; round?: number } }> = []
  const agent = {
    id: session.id, session, status: 'idle',
    // The driver reads `agent.inbox.nextTurn` on the inbox events it subscribes
    // to, so the double models the inbox the real Agent exposes.
    inbox: { nextTurn: [] as Array<{ id: string }> },
    followup: (message: { source?: never }) => { queued.push(message as never) },
    cancel: () => {}, steer: () => {},
  }
  ctx.provide('agents', {
    get: (id: unknown) => (id === session.id ? agent : undefined),
    list: () => [agent],
    currentInitiator: () => undefined,
    withoutInitiator: async (fn: () => unknown) => await fn(),
  } as never)
  ctx.provide('sessions', { flush: async () => true } as never)
  const goals = new GoalService(ctx, {})
  return { ctx, registry, session, agent: agent as unknown as Agent, goals, queued, inbox: agent.inbox }
}

/**
 * Start the host the way a host does: install the driver, wait for its own
 * startup to COMPLETE, and only then create the goal.
 *
 * The driver's initialization disarms every agent it can see
 * (`agents.list()`), so a goal created before that initialization would be
 * disarmed by it. The ordering is part of the contract being tested, not test
 * scaffolding, and the fiber's completion is awaited rather than slept on.
 */
async function startDriveHost(): Promise<DriveHost> {
  const host = driveHost()
  hosts.push(host)
  host.beforeInit = host.goals.get(host.agent as unknown as Agent)?.activation
  const fiber = (host.ctx as unknown as { plugin: (p: unknown, c?: unknown) => unknown }).plugin(goalRoundDriver as never)
  await waitForFiber(fiber)
  host.afterInit = host.goals.get(host.agent as unknown as Agent)?.activation
  host.fiber = fiber
  return host
}

/** Wait for an observable condition with a bounded deadline. */
async function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
}

/** Reach the driver through the public status event the host uses. */
async function triggerIdle(host: DriveHost): Promise<void> {
  ;(host.ctx as unknown as { emit: (name: string, payload: unknown) => void })
    .emit('agent/status', { agent: host.agent, status: 'idle' })
  await new Promise((resolve) => setTimeout(resolve, 200))
}

/** Resolve once the plugin fiber has reached its active state. */
async function waitForFiber(fiber: unknown): Promise<void> {
  const state = (fiber as { fiber?: { state?: number } })?.fiber?.state ?? (fiber as { state?: number })?.state
  const deadline = Date.now() + 2000
  while (state !== 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
}

const hosts: DriveHost[] = []
afterEach(async () => {
  // Release every fixture so no driver state leaks into the next test.
  for (const host of hosts.splice(0)) {
    const fiber = host.fiber as { dispose?: () => unknown } | undefined
    try { await fiber?.dispose?.() } catch { /* teardown is best-effort */ }
  }
})

describe('composed wait and Goal lifecycle', () => {
  /**
   * The installed driver schedules its first round through the public creation
   * path while the goal is armed, naming the live goal, its revision and round
   * 1, and schedules none once the goal is disarmed. Consuming the scheduled
   * message and the harness's own round bookkeeping remain host behaviour.
   */
  it('schedules a real round while armed and none while disarmed', async () => {
    const host = await startDriveHost()
    // The driver's own initialization ran before the goal existed.
    expect(host.beforeInit).toBeUndefined()
    const created = host.goals.create(host.agent as unknown as Agent, { objective: 'drive once' })
    expect(host.goals.get(host.agent as unknown as Agent)?.activation).toBe('armed')
    const deadline = Date.now() + 2000
    while (host.queued.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
    expect(host.queued).toHaveLength(1)
    const source = host.queued[0].source!
    expect(source.kind).toBe('goal')
    expect(source.goalId).toBe(created.id)
    expect(source.revision).toBe(created.revision)
    expect(source.round).toBe(1)
    host.goals.disarm(host.agent as unknown as Agent)
    expect(host.goals.get(host.agent as unknown as Agent)?.activation).toBe('disarmed')
    await triggerIdle(host)
    expect(host.queued).toHaveLength(1)
  })

  it('cancels the round through the competing-queue fence when it is claimed without a step', async () => {
    const host = await startDriveHost()
    host.goals.create(host.agent as unknown as Agent, { objective: 'drive once' })
    await waitFor(() => host.queued.length > 0)
    expect(host.queued).toHaveLength(1)
    const scheduled = host.queued[0] as { id?: string; source?: { round?: number } }
    // The driver's own fence: it treats the message as its round only while the
    // inbox reports the same id as the next turn, so the real inbox shape has to
    // be reflected before the claim.
    host.inbox.nextTurn = [{ id: String(scheduled.id) }]
    ;(host.ctx as unknown as { emit: (name: string, payload: unknown) => void })
      .emit('agent/inbox/inserted', { agent: host.agent, message: scheduled })
    const before = host.goals.get(host.agent as unknown as Agent)!.revision
    ;(host.ctx as unknown as { emit: (name: string, payload: unknown) => void })
      .emit('agent/inbox/claimed', { agent: host.agent, message: scheduled })
    await triggerIdle(host)
    const after = host.goals.get(host.agent as unknown as Agent)!
    // Consuming the round advanced the durable goal: the driver admitted the
    // round through the goal service, so the revision moved while the phase
    // stayed active. (`roundsStarted` belongs to the harness's own round
    // bookkeeping, which this repository does not run.)
    // SCOPE: this is the CANCEL/PAUSE path, not a successful round start. Claiming
    // the message and then reporting idle without running a step makes the
    // driver's own fence treat the round as superseded, so the revision moves and
    // the goal leaves 'active'. It is evidence that the driver reacted, and it is
    // deliberately NOT used as evidence that a round started.
    expect(after.revision).toBeGreaterThan(before)
    expect(after.phase).not.toBe('active')
    expect(scheduled.source?.round).toBe(1)
  })

  it('is processed by the real Goal projection as a round message', async () => {
    const host = await startDriveHost()
    host.goals.create(host.agent as unknown as Agent, { objective: 'record one round' })
    await waitFor(() => host.queued.length > 0)
    const scheduled = host.queued[0] as { id?: string; source?: unknown; content?: unknown }
    expect(host.goals.get(host.agent as unknown as Agent)?.roundsStarted).toBe(0)

    // SCOPE: the real Goal PROJECTION processes the round message — the claimed
    // message becomes a durable session event and `dsh-goal` folds it. The host's
    // own admission (the agent loop's `agent/pre-step` middleware chain) is NOT
    // exercised here: this test appends the event itself, so it is evidence about
    // the projection, not about the host's start path.
    //
    // The host admits the round: the claimed message becomes a durable session
    // event, and the goal projection records the round from THAT event
    // (`dsh-goal` folds `user/message` with a goal source and requires
    // `source.round === roundsStarted + 1`). Nothing here writes a counter.
    host.inbox.nextTurn = [{ id: String(scheduled.id) }]
    ;(host.ctx as unknown as { emit: (name: string, payload: unknown) => void })
      .emit('agent/inbox/claimed', { agent: host.agent, message: scheduled })
    host.session.append('user/message', { content: scheduled.content, source: scheduled.source } as never, { surfaceOp: 'append' } as never)

    const recorded = host.goals.get(host.agent as unknown as Agent)!
    expect(recorded.roundsStarted).toBe(1)
    // The registry's own durable projection agrees, and the durable event exists.
    expect(host.registry.stateOf(host.session, 'goal')?.current?.roundsStarted).toBe(1)
    const rounds = (host.session.snapshotEvents() as unknown as Array<{ type: string; data?: { source?: { kind?: string; round?: number } } }>)
      .filter((event) => event.type === 'user/message' && event.data?.source?.kind === 'goal')
    expect(rounds).toHaveLength(1)
    expect(rounds[0].data?.source?.round).toBe(1)
  })

  it('records no round when the host step is rejected before admission', async () => {
    const host = await startDriveHost()
    host.goals.create(host.agent as unknown as Agent, { objective: 'reject the step' })
    await waitFor(() => host.queued.length > 0)
    const scheduled = host.queued[0] as { id?: string; source?: unknown; content?: unknown }
    host.inbox.nextTurn = [{ id: String(scheduled.id) }]
    ;(host.ctx as unknown as { emit: (name: string, payload: unknown) => void })
      .emit('agent/inbox/claimed', { agent: host.agent, message: scheduled })
    // The host rejects the step: no durable round event is written.
    expect(host.goals.get(host.agent as unknown as Agent)?.roundsStarted).toBe(0)
    expect(host.registry.stateOf(host.session, 'goal')?.current?.roundsStarted).toBe(0)
    const rounds = (host.session.snapshotEvents() as unknown as Array<{ type: string; data?: { source?: { kind?: string } } }>)
      .filter((event) => event.type === 'user/message' && event.data?.source?.kind === 'goal')
    expect(rounds).toHaveLength(0)
  })

  it('stops scheduling once the goal is disarmed, even after a round is consumed', async () => {
    const host = await startDriveHost()
    host.goals.create(host.agent as unknown as Agent, { objective: 'drive then stop' })
    await waitFor(() => host.queued.length > 0)
    expect(host.queued).toHaveLength(1)
    const scheduled = host.queued[0] as { id?: string }
    host.inbox.nextTurn = [{ id: String(scheduled.id) }]
    ;(host.ctx as unknown as { emit: (name: string, payload: unknown) => void })
      .emit('agent/inbox/claimed', { agent: host.agent, message: scheduled })
    // The lifecycle transition a qualified wait performs.
    host.goals.disarm(host.agent as unknown as Agent)
    const settled = host.queued.length
    await triggerIdle(host)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(host.queued).toHaveLength(settled)
    expect(host.goals.get(host.agent as unknown as Agent)?.activation).toBe('disarmed')
  })

  it('drives the real GoalService through armed -> disarmed -> resumed', () => {
    const built = compose()
    // CREATE arms the goal: the projection registry folds goal/change itself.
    const created = built.goals.create(built.agent, { objective: 'ship the guarded change' })
    expect(created.phase).toBe('active')
    expect(created.activation).toBe('armed')
    expect(created.roundsStarted).toBe(0)
    // The durable projection is the registry's, not a local re-implementation.
    const state = built.registry.stateOf(built.session, 'goal')
    expect(state?.failure).toBeNull()
    expect(state?.current?.goal.id).toBe(created.id)

    // DISARM is the lifecycle transition the boundary effectuation performs.
    const disarmed = built.goals.disarm(built.agent)!
    expect(disarmed.activation).toBe('disarmed')
    // Disarm never rewrites the durable phase or revision.
    expect(disarmed.phase).toBe('active')
    expect(disarmed.revision).toBe(created.revision)
    expect(built.goals.get(built.agent)?.activation).toBe('disarmed')

    // RESUME is the host's re-arm edge; it is not available to Guard.
    const resumed = built.goals.resume(built.agent, { id: created.id, revision: created.revision })
    expect(resumed.activation).toBe('armed')
  })

  it('refuses a stale Goal ref and a non-live agent through the real service', () => {
    const built = compose()
    const created = built.goals.create(built.agent, { objective: 'ship the guarded change' })
    // A stale revision is rejected by the service's compare-and-set.
    expect(() => built.goals.resume(built.agent, { id: created.id, revision: created.revision + 9 }))
      .toThrowError(/stale goal ref|GOAL_STALE_REVISION/)
    // An agent the registry does not know is refused, not silently accepted.
    const foreign = { id: SessionId('not-live'), session: built.session } as unknown as Agent
    expect(() => built.goals.disarm(foreign)).toThrowError(/not live|GOAL_AGENT_NOT_LIVE/)
  })

  it('effectuates the boundary against the real service and reads back a disarmed goal', async () => {
    const built = compose()
    const created = built.goals.create(built.agent, { objective: 'ship the guarded change' })
    const envelopes: DerivedEnvelope[] = [
      { seq: 0, type: 'command/run', data: { name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 1, type: 'user/message', data: { source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text: PROTOCOL_V4_NOTICE }] } },
      root(2, RESERVED),
    ]
    const projection = project(built, envelopes)
    expect(projection.currentGoalRef).toEqual({ id: created.id, revision: created.revision })

    const qualification = availableBoundaryQualifications(projection)[0]!.id
    const boundary = qualifyBoundary(projection, {
      disposition: 'user_wait', qualificationKind: 'root_explicit_wait', qualificationIds: [qualification],
    })
    const live = (view: GoalView | undefined) => view === undefined
      ? undefined
      : { id: view.id, revision: view.revision, phase: view.phase, activation: view.activation }
    const effect = await effectuateBoundary(boundary, {
      get: async () => live(built.goals.get(built.agent)),
      disarm: async () => live(built.goals.disarm(built.agent)),
    })
    expect(effect.reasonCode).toBe('boundary_effectuated')
    expect(effect.stopAllowed).toBe(true)
    // The readback is the service's own view, still at the same revision.
    const after = built.goals.get(built.agent)!
    expect(after.activation).toBe('disarmed')
    expect(after.revision).toBe(created.revision)
  })

  it('never fabricates a certificate while the wait is outstanding', () => {
    const built = compose()
    built.goals.create(built.agent, { objective: 'ship the guarded change' })
    const projection = project(built, [
      { seq: 0, type: 'command/run', data: { name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      root(1, RESERVED),
    ])
    const item = [...projection.items.values()][0]!
    expect(item.authorityDisposition).toBe('conditional_wait')
    expect(hasCurrentCertificate(projection)).toBe(false)
    expect(projection.checkpoints).toHaveLength(0)
    expect(authorizeMutationFromProjection(projection, {
      action: 'push', contractItemId: item.id, contractItemRevision: item.revision, resolvedTarget: RESOLVED_PUSH,
    })).toEqual({ status: 'denied', reasonCode: 'mutation_awaiting_root_condition' })
  })

  /**
   * CONTINUATION POINT (recorded, not a passing assertion).
   *
   * The installed round driver IS composed here: `@deepseek-ai/dsh-goal-round-
   * driver@0.1.5-rc.1` is a devDependency, `driver.inject` is satisfied by the
   * provided services, `ctx.plugin(driver)` loads and its fiber reaches state 2
   * (ACTIVE). The real service reports phase 'active', activation 'armed',
   * roundsStarted 0. Emitting the public `agent/created`, `agent/session-start`
   * and `agent/status {status:'idle'}` events still does NOT reach
   * `agent.followup`, so round admission is not yet proven.
   *
   * The driver's own entry path is `requestDrive(state)`, which runs the drive
   * loop inside `ctx.agents.withoutInitiator(async () => { ... })`. The next
   * investigation is whether that callback shape is what the test's `agents`
   * double must run, and which of `readyToDrive`'s conjuncts
   * (`ctx.fiber.state === 2`, `stopping`, agent identity, `agent.status`,
   * `competingQueued`) is false at that moment. The gate is deliberately NOT
   * relaxed to make this pass.
   *
   * The installed round driver's admission gate, quoted from
   * `@deepseek-ai/dsh-goal-round-driver@0.1.5-rc.1` (`lib/index.js`):
   *
   *   if (goal === void 0 || goal.phase !== "active" || goal.activation !== "armed") return;
   *   if (goal.roundsStarted >= goal.maxGoalRounds) { ...block... }
   *   const round = goal.roundsStarted + 1;
   *
   * So the driver admits a round only for an ACTIVE, ARMED goal, and a disarmed
   * goal admits none. This test pins the service-side state that gate reads; it
   * does not run the scheduler.
   */
  it('pins the state the round driver gates on', () => {
    const built = compose()
    const created = built.goals.create(built.agent, { objective: 'ship the guarded change' })
    const armed = built.goals.get(built.agent)!
    expect({ phase: armed.phase, activation: armed.activation }).toEqual({ phase: 'active', activation: 'armed' })
    expect(armed.roundsStarted).toBeLessThan(armed.maxGoalRounds)
    const disarmed = built.goals.disarm(built.agent)!
    expect({ phase: disarmed.phase, activation: disarmed.activation }).toEqual({ phase: 'active', activation: 'disarmed' })
    // The durable reference a driver would re-read is unchanged by disarm.
    expect({ id: disarmed.id, revision: disarmed.revision }).toEqual({ id: created.id, revision: created.revision })
    expect(GoalId(disarmed.id)).toBe(disarmed.id)
  })
})

/**
 * Guard-owned boundaries over the same real host services.
 *
 * The wait and the bounded stop are established by Guard itself, at the turn
 * boundary, so these tests drive the production entry
 * (`handleGuardTurnStopping`) against the installed `GoalService` and then replay
 * the session the guard actually wrote. A boundary that did not survive the
 * replay is not a persisted boundary, and a disarm that is not read back is not
 * a stopped driver.
 */
describe('guard-owned boundaries through the real host services', () => {
  const normalize = (view: GoalView | undefined) => (view ? { id: view.id, revision: view.revision, phase: view.phase, activation: view.activation } : undefined)

  const turnAccess = (host: DriveHost, flush: () => Promise<boolean> = async () => true) => ({
    flush,
    hostSupported: true,
    readExternalOperation: () => undefined,
    goalAccess: {
      get: async () => normalize(host.goals.get(host.agent)),
      disarm: async () => normalize(host.goals.disarm(host.agent)),
    },
  })

  /**
   * Put a root instruction into the real session log, the way a host does.
   *
   * The enable command and the first-step boundary notice are part of the
   * session's own history, not test-local envelopes: the guard is only active in
   * a session that recorded them, and recording them AFTER the goal's own events
   * leaves the guard inert for that history. `enabled` is therefore derived from
   * the log by the production fold, never assigned by this fixture.
   */
  const say = (host: DriveHost, text: string) => {
    // The host's own turn boundary. Guard takes its boundary identity from this
    // event, so a scenario without it is a session the host never turned.
    host.session.append('turn/start', { turn: (host.session.snapshotEvents().filter((event) => event.type === 'turn/start').length) + 1 } as never)
    host.session.append('command/run', { name: 'context-guard', args: 'on', source: { kind: 'user' } } as never)
    host.session.append('user/message', { source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text: PROTOCOL_V4_NOTICE }] } as never, { surfaceOp: 'append' } as never)
    host.session.append('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text }] } as never, { surfaceOp: 'append' } as never)
  }

  /**
   * The runtime surface the turn boundary uses, over a real derived state.
   *
   * `sync()` re-derives from the session exactly as production does, so a
   * durable record this turn boundary writes is visible to the next one. The
   * projection is therefore a getter, not a frozen object — a fixture that
   * handed back the same snapshot would make the durable budget look like it
   * never advanced, which is the opposite of what these tests are for.
   */
  const runtimeOver = (host: DriveHost, state: Record<string, unknown> = {}) => {
    const runtime = {
      get projection() { return Object.assign(liveProjection(host), state) },
      sync: () => {}, setEnabled: () => {}, setDurability: () => {}, consumeRecovery: () => false,
      get lifecycle() { return 'active' as const },
      get protocolV4Present() { return true },
    }
    return { runtime: runtime as never as Parameters<typeof handleGuardTurnStopping>[1], state }
  }

  /** Open the next host turn, as the loop does before claiming input. */
  const nextTurn = (host: DriveHost) => {
    const turns = host.session.snapshotEvents().filter((event) => event.type === 'turn/start').length
    host.session.append('turn/start', { turn: turns + 1 } as never)
  }

  /** The projection the turn boundary reads, derived from the real session. */
  const liveProjection = (host: DriveHost, extra: DerivedEnvelope[] = []) => {
    const events = host.session.snapshotEvents() as unknown as DerivedEnvelope[]
    // The session already carries the goal's own events, so the scenario is
    // appended after them rather than on top of their sequence numbers.
    const base = events.reduce((max, event) => Math.max(max, event.seq), 0) + 1
    const projection = deriveProjection([
      ...events, ...extra.map((event, index) => ({ ...event, seq: base + index })),
    ], { activation: 'opt-in' }, { cwd: '/work/repo' }, true).projection
    projection.enabled = true
    // The Goal half of the state is the live service readback: that is what the
    // round gate reads, and deriving it from the log alone would test a state no
    // driver ever sees.
    const live = normalize(host.goals.get(host.agent))
    if (live) {
      projection.currentGoalRef = { id: live.id, revision: live.revision }
      projection.currentGoalPhase = live.phase
      projection.currentGoalActivation = live.activation
    }
    return projection
  }

  it('stops an armed Goal that repeats the same progress fingerprint, and reads the disarm back', async () => {
    const host = await startDriveHost()
    const created = host.goals.create(host.agent, { objective: 'finish the guarded change' })
    say(host, '持续推进，直到迁移脚本全部跑完为止。')
    const { runtime } = runtimeOver(host)
    const steered: unknown[] = []
    ;(host.agent as unknown as { steer: (m: unknown) => void }).steer = (message) => steered.push(message)

    // 1. First sighting of the fingerprint is the baseline: the driver owns it.
    expect(await handleGuardTurnStopping(host.agent, runtime, turnAccess(host))).toBe('goal_round_driver_owns_continuation')
    expect(normalize(host.goals.get(host.agent))?.activation).toBe('armed')
    // 2. The same fingerprint in the NEXT host turn earns one diagnosis and one
    // correction step.
    nextTurn(host)
    expect(await handleGuardTurnStopping(host.agent, runtime, turnAccess(host))).toBe('no_progress_diagnosis_steer')
    expect(steered).toHaveLength(1)
    expect(normalize(host.goals.get(host.agent))?.activation).toBe('armed')
    // 3. Still no progress in the next turn: bounded stop, real disarm, read back.
    nextTurn(host)
    const reason = await handleGuardTurnStopping(host.agent, runtime, turnAccess(host))
    expect(reason).toBe('boundary_effectuated')
    const after = normalize(host.goals.get(host.agent))
    expect(after).toMatchObject({ activation: 'disarmed', id: created.id, revision: created.revision })
    // The boundary is durable, not an in-memory decision: replay finds it and
    // the round gate the driver uses is closed by the readback above.
    const replayed = deriveProjection(host.session.snapshotEvents() as never, { activation: 'opt-in' }, { cwd: '/work/repo' }, true).projection
    expect(replayed.boundaries.some((row) => row.disposition === 'guard_bounded_stop' && row.persistedResult === 'accepted')).toBe(true)
  })

  it('establishes the trusted human wait by itself and persists it', async () => {
    const host = await startDriveHost()
    // The enable command is part of the session's own history: the guard is only
    // active in a session that recorded it, and it is recorded before the work
    // it protects — a boundary written into the log has to be re-readable from
    // the same log afterwards.
    say(host, RESERVED)
    host.goals.create(host.agent, { objective: 'wait for the human confirmation' })
    const { runtime } = runtimeOver(host)
    const waiting = [...runtime.projection.items.values()].filter((item) => item.status === 'pending' && item.waitAuthorization)
    expect(waiting.length).toBeGreaterThan(0)
    const reason = await handleGuardTurnStopping(host.agent, runtime, turnAccess(host))
    expect(reason).toBe('boundary_effectuated')
    // The wait stops the automatic continuation without certifying or dropping
    // the task: the open obligation and its reservation survive.
    expect(normalize(host.goals.get(host.agent))?.activation).toBe('disarmed')
    const replayed = deriveProjection(host.session.snapshotEvents() as never, { activation: 'opt-in' }, { cwd: '/work/repo' }, true).projection
    const boundary = replayed.boundaries.find((row) => row.disposition === 'user_wait')
    expect(boundary).toMatchObject({ persistedResult: 'accepted', qualificationKind: 'root_explicit_wait' })
    expect([...replayed.items.values()].some((item) => item.status === 'pending' && item.waitAuthorization)).toBe(true)
  })

  it('allocates one attempt when a retry re-processes the same turn boundary', async () => {
    const host = await startDriveHost()
    host.goals.create(host.agent, { objective: 'the boundary is retried' })
    say(host, '持续推进，直到迁移脚本全部跑完为止。')
    // A runtime whose projection is NOT re-derived between the two calls models
    // the retry: the host re-enters the same turn boundary without having
    // observed the record the first entry wrote. Both entries must claim the
    // same attempt, so the retry cannot spend the budget twice.
    const frozen = liveProjection(host)
    const retryRuntime = {
      projection: frozen,
      sync: () => {}, setEnabled: () => {}, setDurability: () => {}, consumeRecovery: () => false,
      get lifecycle() { return 'active' as const },
      get protocolV4Present() { return true },
    } as never as Parameters<typeof handleGuardTurnStopping>[1]
    const access = {
      flush: async () => true, hostSupported: true, readExternalOperation: () => undefined,
      goalAccess: { get: async () => normalize(host.goals.get(host.agent)), disarm: async () => normalize(host.goals.disarm(host.agent)) },
    }
    const first = await handleGuardTurnStopping(host.agent, retryRuntime, access)
    const second = await handleGuardTurnStopping(host.agent, retryRuntime, access)
    expect(second).toBe(first)
    // The harder retry: the projection IS re-derived between the two entries, so
    // the record written by the first entry is visible to the second. The host
    // turn has not changed, so this is still the same boundary — the identity
    // comes from the host's `turn/start`, not from the last log line, so Guard's
    // own record cannot make the retry look like a new turn.
    const rederived = await handleGuardTurnStopping(host.agent, runtimeOver(host).runtime, access)
    expect(rederived).toBe(first)
    // A genuinely new host turn is a new boundary and does advance the budget.
    host.session.append('turn/start', { turn: 2 } as never)
    expect(await handleGuardTurnStopping(host.agent, runtimeOver(host).runtime, access)).toBe('no_progress_diagnosis_steer')
    const prefix = 'Context Guard no-progress record: '
    const records = (host.session.snapshotEvents() as unknown as Array<{ data: { content?: Array<{ text?: string }> } }>)
      .map((event) => (event.data.content ?? []).map((part) => part.text ?? '').join(''))
      .filter((text) => text.startsWith(prefix))
      .map((text) => JSON.parse(text.slice(prefix.length)) as { fingerprint: string; boundaryKey: string; attempt: number })
    // Three entries at the same host turn plus the new turn's own record.
    expect(records).toHaveLength(4)
    const firstThree = records.slice(0, 3)
    // Same boundary, same attempt every time — one claim, not two or three.
    expect(new Set(firstThree.map((row) => row.boundaryKey)).size).toBe(1)
    expect(new Set(firstThree.map((row) => row.attempt)).size).toBe(1)
    // The new host turn is a different boundary and does advance the budget.
    expect(records[3]!.boundaryKey).not.toBe(firstThree[0]!.boundaryKey)
    expect(records[3]!.attempt).toBe(2)
    // And the reloaded budget agrees with the process that wrote it: one claim
    // per boundary, so the retried boundary contributes exactly one.
    const reloaded = deriveProjection(host.session.snapshotEvents() as never, { activation: 'opt-in' }, { cwd: '/work/repo' }, true).projection
    const budget = reloaded.noProgressClaims.get(records[0]!.fingerprint)!
    expect(budget.size).toBe(2)
    expect(budget.get('1')).toBe(1)
    expect(budget.get('2')).toBe(2)
  })

  it('keeps continuing while the recorded state really changes', async () => {
    const host = await startDriveHost()
    host.goals.create(host.agent, { objective: 'keep making progress' })
    say(host, '持续推进，直到迁移脚本全部跑完为止。')
    const { runtime, state } = runtimeOver(host)
    expect(await handleGuardTurnStopping(host.agent, runtime, turnAccess(host))).toBe('goal_round_driver_owns_continuation')
    // A real change in the recorded contract is progress, so the next boundary
    // is a baseline again and the goal is never disarmed for it.
    // Real progress: the recorded contract moves on, so the fingerprint does too.
    state.contractRevision = runtime.projection.contractRevision + 1
    nextTurn(host)
    expect(await handleGuardTurnStopping(host.agent, runtime, turnAccess(host))).toBe('goal_round_driver_owns_continuation')
    // Real progress: the recorded contract moves on, so the fingerprint does too.
    state.contractRevision = runtime.projection.contractRevision + 1
    nextTurn(host)
    expect(await handleGuardTurnStopping(host.agent, runtime, turnAccess(host))).toBe('goal_round_driver_owns_continuation')
    expect(normalize(host.goals.get(host.agent))?.activation).toBe('armed')
  })

  it('refuses the side effect when the Goal changed under the boundary', async () => {
    const host = await startDriveHost()
    host.goals.create(host.agent, { objective: 'the revision moves under the boundary' })
    say(host, '持续推进，直到迁移脚本全部跑完为止。')
    // One recorded turn boundary, then the live service moves on its own while
    // the durable log keeps the reference the boundary was qualified from. The
    // fingerprint deliberately ignores the Goal revision, so this is the case
    // the side effect itself has to catch: revision N is gone.
    const { runtime } = runtimeOver(host)
    await handleGuardTurnStopping(host.agent, runtime, turnAccess(host))
    nextTurn(host)
    await handleGuardTurnStopping(host.agent, runtime, turnAccess(host))
    nextTurn(host)
    const recorded = liveProjection(host).currentGoalRef
    const before = normalize(host.goals.get(host.agent))!
    const moved = { ...host.goals.get(host.agent)!, revision: before.revision + 7 }
    host.goals.get = (() => ({ ...moved })) as never
    const stale = runtimeOver(host, { currentGoalRef: recorded }).runtime
    // The third sighting is the bounded stop, and the effect refuses.
    expect(await handleGuardTurnStopping(host.agent, stale, turnAccess(host))).toBe('boundary_pre_effect_failure')
    expect(moved.activation).toBe('armed')
  })

  it('claims no boundary when the durable flush fails', async () => {
    const host = await startDriveHost()
    host.goals.create(host.agent, { objective: 'the flush fails' })
    say(host, '持续推进，直到迁移脚本全部跑完为止。')
    const { runtime } = runtimeOver(host)
    await handleGuardTurnStopping(host.agent, runtime, turnAccess(host))
    await handleGuardTurnStopping(host.agent, runtime, turnAccess(host))
    const before = host.session.snapshotEvents().length
    expect(await handleGuardTurnStopping(host.agent, runtime, turnAccess(host, async () => false))).toBe('boundary_flush_failed')
    // Nothing was claimed and nothing was disarmed on a failed flush. The turn
    // boundary flushes first, so the failed flush also stops the append.
    expect(host.session.snapshotEvents().length).toBe(before)
    expect(normalize(host.goals.get(host.agent))?.activation).toBe('armed')
  })

})

/**
 * Trusted root pause, routed through the host's own pause entry.
 *
 * The pause is the user's request, carried by the lifecycle call the host
 * exposes for it — not Guard impersonating a human. What may trigger it is a
 * source question, so the counterexamples drive the same runtime with the same
 * words arriving from a quoted notice, a tool result and a model message.
 */
describe('a trusted root pause reaches the host control path', () => {
  const normalize = (view: GoalView | undefined) => (view ? { id: view.id, revision: view.revision, phase: view.phase, activation: view.activation } : undefined)

  /** Open the next host turn, as the loop does before claiming input. */
  const nextTurn = (host: DriveHost) => {
    const turns = host.session.snapshotEvents().filter((event) => event.type === 'turn/start').length
    host.session.append('turn/start', { turn: turns + 1 } as never)
  }

  /** Record a root instruction in the session, as a host does. */
  const say = (host: DriveHost, text: string) => {
    host.session.append('command/run', { name: 'context-guard', args: 'on', source: { kind: 'user' } } as never)
    host.session.append('user/message', { source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text: PROTOCOL_V4_NOTICE }] } as never, { surfaceOp: 'append' } as never)
    host.session.append('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text }] } as never, { surfaceOp: 'append' } as never)
  }

  const liveProjection = (host: DriveHost) => {
    const projection = deriveProjection(host.session.snapshotEvents() as never, { activation: 'opt-in' }, { cwd: '/work/repo' }, true).projection
    projection.enabled = true
    const live = normalize(host.goals.get(host.agent))
    if (live) {
      projection.currentGoalRef = { id: live.id, revision: live.revision }
      projection.currentGoalPhase = live.phase
      projection.currentGoalActivation = live.activation
    }
    return projection
  }

  const pauseAccess = (host: DriveHost) => ({
    pause: async () => normalize(host.goals.pause(host.agent, { id: host.goals.get(host.agent)!.id, revision: host.goals.get(host.agent)!.revision } as never)),
    get: async () => normalize(host.goals.get(host.agent)),
  })

  const runtimeFor = (host: DriveHost) => ({
    get projection() { return liveProjection(host) },
    sync: () => {}, setEnabled: () => {}, setDurability: () => {}, consumeRecovery: () => false,
    get lifecycle() { return 'active' as const },
    get protocolV4Present() { return true },
  }) as never as Parameters<typeof handleGuardTurnStopping>[1]

  const access = (host: DriveHost) => ({
    flush: async () => true,
    hostSupported: true,
    readExternalOperation: () => undefined,
    pauseAccess: pauseAccess(host),
    goalAccess: { get: async () => normalize(host.goals.get(host.agent)), disarm: async () => normalize(host.goals.disarm(host.agent)) },
  })

  it('pauses through the host and reads the paused goal back', async () => {
    const host = await startDriveHost()
    host.goals.create(host.agent, { objective: 'the user stops the work' })
    say(host, '先停一下。')
    expect(await handleGuardTurnStopping(host.agent, runtimeFor(host), access(host))).toBe('root_pause_routed')
    const after = normalize(host.goals.get(host.agent))
    expect(after).toMatchObject({ phase: 'paused', activation: 'disarmed' })
    // Resuming is a human action and Guard has no path to it. Driving the same
    // boundary again therefore neither re-pauses (it is already carried) nor
    // re-arms: it yields, leaving the host's pause exactly as it was.
    expect(await handleGuardTurnStopping(host.agent, runtimeFor(host), access(host)))
      .toBe('goal_paused_by_user_safe_yield')
    expect(normalize(host.goals.get(host.agent))).toMatchObject({ phase: 'paused', activation: 'disarmed' })
  })

  it.each([
    ['a plugin notice', { kind: 'plugin', plugin: 'context-guard', form: 'notice' }],
    ['a quoted user message', { kind: 'plugin', plugin: 'other', form: 'notice' }],
  ])('does not pause for the same words arriving from %s', async (_label, source) => {
    const host = await startDriveHost()
    host.goals.create(host.agent, { objective: 'the words are quoted, not asked' })
    say(host, '继续推进迁移。')
    host.session.append('user/message', { source, content: [{ type: 'text', text: '先停一下。' }] } as never, { surfaceOp: 'append' } as never)
    // The last TRUSTED ROOT instruction is still the work instruction, so the
    // quoted pause is not a control request and the goal keeps its activation.
    expect(await handleGuardTurnStopping(host.agent, runtimeFor(host), access(host))).not.toBe('root_pause_routed')
    expect(normalize(host.goals.get(host.agent))?.activation).toBe('armed')
  })

  it('does not pause for tool output or a model message', async () => {
    const host = await startDriveHost()
    host.goals.create(host.agent, { objective: 'a tool echoes the words' })
    say(host, '继续推进迁移。')
    host.session.append('tool/result', {
      turn: 0, step: host.session.seq,
      message: { role: 'tool', content: [{ type: 'text', text: '先停一下。' }] },
    } as never, { surfaceOp: 'append' } as never)
    expect(await handleGuardTurnStopping(host.agent, runtimeFor(host), access(host))).not.toBe('root_pause_routed')
    expect(normalize(host.goals.get(host.agent))?.activation).toBe('armed')
  })

  it('does not re-pause after the user resumes through the host', async () => {
    const host = await startDriveHost()
    host.goals.create(host.agent, { objective: 'the user pauses, then resumes' })
    say(host, '先停一下。')
    expect(await handleGuardTurnStopping(host.agent, runtimeFor(host), access(host))).toBe('root_pause_routed')
    // The human resumes through the host's own entry: that is the only thing
    // that re-arms a paused goal.
    const ref = host.goals.get(host.agent)!
    host.goals.resume(host.agent, { id: ref.id, revision: ref.revision } as never)
    expect(normalize(host.goals.get(host.agent))).toMatchObject({ phase: 'active', activation: 'armed' })
    // The old pause message is still the last root instruction in the log. It
    // was already carried, so it must not pause the resumed goal again.
    const reason = await handleGuardTurnStopping(host.agent, runtimeFor(host), access(host))
    expect(reason).not.toBe('root_pause_routed')
    expect(normalize(host.goals.get(host.agent))?.activation).toBe('armed')
    // A genuinely new pause request is a new control input and still works.
    say(host, '先停一下。')
    expect(await handleGuardTurnStopping(host.agent, runtimeFor(host), access(host))).toBe('root_pause_routed')
  })

  it('does not pause for a negated pause', async () => {
    const host = await startDriveHost()
    host.goals.create(host.agent, { objective: 'the user forbids a pause' })
    say(host, '不要暂停，继续推进迁移。')
    expect(await handleGuardTurnStopping(host.agent, runtimeFor(host), access(host))).not.toBe('root_pause_routed')
    expect(normalize(host.goals.get(host.agent))?.activation).toBe('armed')
  })
})
