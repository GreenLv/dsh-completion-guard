import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The real agent loop, end to end, over the isolated host fixture.
 *
 * STATUS: all THREE scenarios PASS on this fixture.
 *   1. normal: real admission, the production round write, the model call and
 *      the recorded answer — `OBSERVED {"preStepRuns":1,"decisions":["enter"],
 *      "errors":[],"claims":1,"llm":2}`.
 *   2. Guard stop: the goal is real and ARMED, the production Guard establishes
 *      the persisted boundary, the real `GoalService` reads back `disarmed`
 *      (`boundary_effectuated`), and neither a further round message nor a
 *      further model call happens — with no error and no cancellation. The
 *      counting baseline is taken AFTER the correction turn has settled and the
 *      boundary stop has taken effect, because the `no_progress_diagnosis_steer`
 *      turn legitimately steers one correction round that calls the model.
 *   3. reload: PASSES. Host A establishes the boundary through the production
 *      path (turns 1, 2 and the bounded stop at 3 — each decided by
 *      `handleGuardTurnStopping`, which writes its own records), flushes, and is
 *      really destroyed. Host B is built over the same temp JSONL root and reads
 *      the log back:
 *
 *        `<root>/_no-cwd/<session-id>/session.v3.jsonl.zstd`
 *        `list()` → `{ header, revision, sizeBytes }`
 *        `readStoredLog(path, expectedId)` — refuses a log whose stored identity
 *        is not the one requested, and validates every event
 *
 *      B asserts the boundary is still `accepted` with the same id and
 *      `candidateSha256`, the budget's boundary keys and attempts are unchanged
 *      (`{1:1, 2:2}`), and the open obligation survives. The retry then takes
 *      `accepted_boundary_pending_effectuation`: the persisted boundary is
 *      already current, so nothing is re-decided and no attempt is allocated,
 *      and a second disk read confirms the budget is untouched.
 *
 *      This scenario establishes RECOVERY OF THE BOUNDARY AND THE BUDGET, and
 *      that a retry does not duplicate a claim. It does NOT show that the stop's
 *      side effect has been re-applied after a restart: the decision reported
 *      that an accepted boundary is pending effectuation — the effect itself is
 *      re-run by whoever drives the boundary, not by this test.
 *
 * WHAT THE EARLIER CORRUPTION WAS: the host's reader requires every
 * `user/message` payload to carry a non-empty string `id` ("lacks an identified
 * message"). The scenarios had been SEEDING no-progress records by hand-writing
 * raw `{ source, content }` objects; production writes them through
 * `createUserMessage`, which does identify them. The seed was removed and the
 * budget is now spent through the production entry, so the log the reload reads
 * is one production actually wrote. This does NOT mean previously corrupted
 * sessions are recoverable — nothing migrates or repairs old data.
 * This file is deliberately kept in the tree as a runnable reproducer rather
 * than removed to keep the suite green. Run it on its own:
 *
 *     env -u NODE_PATH npx vitest run tests/domain/v051-host-loop.test.ts
 *
 * Everything real comes from `tests/fixtures/host-composition/node_modules`
 * (its own lockfile pins the whole `0.1.5-rc.1` set), so the repository's own
 * certified dependency graph is untouched. Only the LLM and the outer I/O are
 * simulated, and the LLM is deterministic.
 *
 * Registration facts established by RUNNING, not by class name:
 *   - `agents` is provided by CONSTRUCTING the real `AgentRegistry`; an extra
 *     `provide('agents', …)` fails with `service "agents" has been registered`;
 *   - `sessionProjections` is the same: `new SessionProjectionRegistry(ctx)`;
 *   - `SystemPrompt extends Service` with `constructor(scope)`, so it registers
 *     by construction too — `ctx.plugin(SystemPrompt)` installs nothing,
 *     because a Service class is not a plugin;
 *   - services that are only *read later* must not be faked with
 *     `provide(name, undefined)`: that silences the report instead of building
 *     the composition.
 *
 * LAST RUN: all eight services resolve —
 * `{"agents":true,"sessionProjections":true,"systemPrompt":true,"tools":true,
 * "sessions":true,"settings":true,"sessionPersistence":true,"llm":true}` — and
 * the scenario drives a real turn until the persistence backend is needed:
 * `TypeError: persistence.create is not a function`.
 *
 * Registration facts, each from the implementation's own `super(ctx, "…")`:
 *   agents → new AgentRegistry(ctx) · sessionProjections → new SessionProjectionRegistry(ctx)
 *   systemPrompt → new SystemPrompt(ctx, config) [config REQUIRED] · tools → new ToolRuntime(ctx, {}) [reads ctx.systemPrompt, so it comes after]
 *   sessions → new SessionStore(ctx) (dsh-session) · settings → new SettingsProvider(ctx)
 *   sessionPersistence → new SessionPersistence(ctx)
 *
 * PERSISTENCE (done): the concrete backend is
 * `@deepseek-ai/dsh-session-persistence-jsonl@0.1.5-rc.1`, installed in the
 * fixture; it is `constructor(ctx, config)` with `config.root` REQUIRED, and the
 * scenario points it at a `mkdtemp` directory so no daily data is touched.
 *
 * TURN API (established by running): `ctx.agentLoop.create(id, options)` returns
 * the loop's own agent, whose prototype carries `send`, `followup`, `kick`,
 * `whenIdle`, `turn`, `status`. `send(message, target, wakeup)` needs a target —
 * calling it without one crashes in the inbox lookup (`reading 'length'`);
 * `followup(input)` is the short form `send(input, 'next-turn', true)`.
 *
 * WHAT MADE IT RUN, in the order the observations located it:
 *   1. `kick()` is NOT the driver start — `turn()` throws "turn without driver
 *      reservation" and `kick()` swallows it. `wakeDriver()` reserves the running
 *      phase and starts the driver;
 *   2. the agent needs a route: without `provider`/`model` the turn dies at
 *      "has no provider/model" before anything is written;
 *   3. the model stub's chunks must match the accumulator: `text-delta` carries a
 *      non-negative integer `index`, and an extra terminal chunk is an
 *      "unreachable variant".
 *
 * NEXT CHANGE: the Guard stop scenario, on this same fixture — establish the
 * boundary through the production path, disarm through the real `GoalService`,
 * and assert no further round is written; then the reload scenario, which must
 * DISCARD the in-memory instance and re-read the JSONL session from the temp
 * root.
 */
const FIXTURE = new URL('../fixtures/host-composition/node_modules/@deepseek-ai/', import.meta.url)
const load = (pkg: string) => import(new URL(`${pkg}/lib/index.js`, FIXTURE).href)

/** A deterministic model: one text answer, no tools, no network. */
const deterministicLlm = (text: string, llmCalls: { prepare: number; stream: number }) => ({
  prepareCall: async (config: unknown) => {
    llmCalls.prepare += 1
    return {
      config,
      retryPolicy: { maxAttempts: 1 },
      stream: () => {
        llmCalls.stream += 1
        return (async function* () {
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'finish', reason: 'stop' }
        })()
      },
    }
  },
  stream: () => {
    llmCalls.stream += 1
    return (async function* () {
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'finish', reason: 'stop' }
    })()
  },
})

/**
 * One host, built the way the fixture's pinned packages require.
 *
 * Extracted so the three scenarios share exactly one composition instead of
 * three near-copies. `sessionRoot` is a throwaway directory per host, so a
 * scenario can also discard the host and re-read the same log from disk.
 */
interface LoopHost {
  ctx: Record<string, unknown>
  agent: {
    session: {
      snapshotEvents: () => Array<{ type: string; data: unknown }>
      append: (type: string, data: unknown, options?: unknown) => unknown
      flush?: () => Promise<unknown>
    }
    followup: (message: unknown) => unknown
    wakeDriver: () => unknown
    whenIdle: () => Promise<unknown>
    status: string
  }
  sessionRoot: string
  observed: { preStepRuns: number; decisions: string[]; errors: string[]; claims: number }
  fiber: { dispose?: () => unknown }
  llmCalls: { prepare: number; stream: number }
  hooks: { on: (name: string, handler: (payload: unknown, next?: unknown) => unknown) => void }
}


async function startLoopHost(
  sessionRoot = mkdtempSync(join(tmpdir(), 'cg-host-loop-')),
  options: { createAgent?: boolean } = {},
): Promise<LoopHost> {
  const { Context } = await load('cordis')
  const loop = await load('dsh-agent-loop')
  const agentSdk = await load('dsh-agent')
  const projection = await load('dsh-session-projection')
  const prompt = await load('dsh-system-prompt')
  const toolsSdk = await load('dsh-tools')
  const sessionSdk = await load('dsh-session')
  const persistenceJsonl = await load('dsh-session-persistence-jsonl')
  const settingsSdk = await load('dsh-settings')

  const ctx = new (Context as new () => Record<string, unknown>)()
  // Real services, each registered the way its own implementation does it.
  void new (agentSdk.AgentRegistry as new (ctx: unknown) => unknown)(ctx)
  void new (projection.SessionProjectionRegistry as new (ctx: unknown) => unknown)(ctx)
  // `constructor(ctx, config)`, and the config is not optional — omitting it
  // fails later at `config.toolOrder`.
  void new (prompt.SystemPrompt as new (ctx: unknown, config: unknown) => unknown)(ctx, {
    includeHarnessIdentity: true, includeRuntimeContext: true,
    personaPrefix: '', personaSuffix: '', toolOrder: undefined,
  })
  // Dependency order is the implementations' own: `ToolRuntime` reads
  // `ctx.systemPrompt` in its constructor, so the prompt service comes first.
  void new (toolsSdk.ToolRuntime as new (ctx: unknown, config?: unknown) => unknown)(ctx)
  void new (sessionSdk.SessionStore as new (ctx: unknown) => unknown)(ctx)
  // The concrete backend, not the abstract base. `root` is required, and a
  // throwaway directory keeps daily session data untouched.
  void new (persistenceJsonl.default as new (ctx: unknown, config: unknown) => unknown)(ctx, { root: sessionRoot, compression: undefined })
  void new (settingsSdk.SettingsProvider as new (ctx: unknown) => unknown)(ctx)
  const llmCalls = { prepare: 0, stream: 0 }
  ;(ctx as unknown as { provide: (name: string, value: unknown) => void }).provide('llm', deterministicLlm('recorded by the loop', llmCalls))

  const service = (name: string) => (ctx as unknown as { get: (n: string) => unknown }).get(name)
  console.log('SERVICES', JSON.stringify(Object.fromEntries(
    ['agents', 'sessionProjections', 'systemPrompt', 'tools', 'sessions', 'settings', 'sessionPersistence', 'llm']
      .map((name) => [name, service(name) !== undefined]),
  )))
  const missing = ['tools', 'sessions', 'settings', 'sessionPersistence'].filter((name) => service(name) === undefined)
  expect(missing, `the real loop still needs: ${missing.join(', ') || 'nothing'}`).toEqual([])

  const fiber = (ctx as unknown as { plugin: (p: unknown) => unknown }).plugin(loop.AgentLoop as never)
  await Promise.resolve(fiber)

  const observed: LoopHost['observed'] = { preStepRuns: 0, decisions: [], errors: [], claims: 0 }
  const hooks = ctx as unknown as LoopHost['hooks']
  // `agent/pre-step` counts PRE-STEP RUNS. The claim is a different fact and is
  // observed through the host's own `agent/inbox/claimed` event.
  hooks.on('agent/pre-step', async (payload: unknown, next: unknown) => {
    observed.preStepRuns += 1
    const decision = await (next as () => Promise<{ kind?: string }>)()
    observed.decisions.push(String(decision?.kind))
    return decision
  })
  hooks.on('agent/inbox/claimed', () => { observed.claims += 1 })
  hooks.on('agent/error', (payload: unknown) => {
    observed.errors.push(String((payload as { error?: unknown })?.error ?? payload))
  })

  // The reload host must NOT create the session: it exists on disk, and the
  // backend refuses a second create with `session "…" already exists`.
  const created = options.createAgent === false
    ? undefined
    : await (service('agentLoop') as { create: (id: string, options?: unknown) => Promise<unknown> })
      .create('loop-host-agent', { cwd: '/work/repo', provider: 'deterministic-fixture', model: 'fixture-model' })
  return { ctx, agent: created as LoopHost['agent'], sessionRoot, observed, llmCalls, hooks, fiber: fiber as LoopHost['fiber'] }
}

/** Enqueue one root message through the loop and run the turn to idle. */
async function runTurn(host: LoopHost, text: string) {
  const llmSdk = await load('dsh-llm')
  host.agent.followup((llmSdk.createUserMessage as (input: unknown) => unknown)({
    content: [{ type: 'text', text }], source: { kind: 'user' },
  }))
  // `kick()` is NOT the driver start: `turn()` throws "turn without driver
  // reservation" and `kick()` swallows it. `wakeDriver()` reserves the running
  // phase and starts the driver.
  host.agent.wakeDriver()
  await host.agent.whenIdle()
}

/**
 * The ROUND messages only: the inputs the loop admits into a step.
 * Guard's own notices are `user/message` events too (`source.kind === 'plugin'`),
 * and counting those as rounds would let bookkeeping look like progress.
 */
const roundMessages = (host: LoopHost) =>
  host.agent.session.snapshotEvents().filter((event) => event.type === 'user/message'
    && (event.data as { source?: { kind?: string } })?.source?.kind !== 'plugin')

describe('the real agent loop over the fixture host', () => {
  it('admits a root message and lets production write the round event', async () => {
    const host = await startLoopHost()
    const session = host.agent.session
    expect(session, 'create() must return the live agent with its durable session').toBeDefined()
    const before = roundMessages(host).length

    await runTurn(host, '记录这一轮。')
    console.log('OBSERVED', JSON.stringify({ ...host.observed, llm: host.llmCalls.prepare + host.llmCalls.stream }))

    const events = host.agent.session.snapshotEvents()
    // 1. PRODUCTION wrote the round event; this test never appends one.
    expect(roundMessages(host).length, 'the loop must write the round user/message itself').toBeGreaterThan(before)
    // 2. The turn really ran: the host opened it before claiming input.
    expect(events.some((event) => event.type === 'turn/start'), 'the host must open a turn').toBe(true)
    // 3. The deterministic model was actually consumed and answered, so a
    //    half-finished turn cannot pass as a complete one. The stub records its
    //    calls; an error path would leave the stream count at zero.
    expect(host.llmCalls.prepare, 'the loop must prepare exactly the injected model call').toBeGreaterThan(0)
    expect(host.llmCalls.stream, 'the model stream must be consumed').toBeGreaterThan(0)
    expect(events.some((event) => event.type === 'assistant/message'), 'the model answer must be recorded').toBe(true)
    expect(host.agent.status).not.toBe('error')
    expect(host.observed.errors).toEqual([])
    expect(host.observed.preStepRuns).toBeGreaterThan(0)
    expect(host.observed.decisions).toContain('enter')
  })
})

/**
 * Scenario 2: the Guard boundary stops the host that was otherwise able to keep
 * going. The loop, the session and the goal are real; only the model is a stub.
 */
describe('a persisted Guard boundary stops the real host', () => {
  it('disarms the armed goal and stops further rounds and model calls', async () => {
    const { handleGuardTurnStopping } = await import('../../src/runtime.js')
    const { deriveProjection } = await import('../../src/domain/derive.js')
    const GoalService = (await import('@deepseek-ai/dsh-goal')).default
    const host = await startLoopHost()
    await runTurn(host, '持续推进，直到迁移脚本全部跑完为止。')
    const roundsAfterFirstTurn = roundMessages(host).length
    const llmAfterFirstTurn = host.llmCalls.prepare + host.llmCalls.stream
    // The goal is real and armed: it CAN continue, which is what makes the stop
    // meaningful rather than an artefact of nothing being runnable.
    const goals = new GoalService(host.ctx as never, {})
    const created = goals.create(host.agent as never, { objective: 'finish the guarded change' })
    console.log('GOAL', JSON.stringify({ activation: goals.get(host.agent as never)?.activation, phase: goals.get(host.agent as never)?.phase }))

    const normalize = (view: { id: string; revision: number; phase: string; activation: string } | undefined) =>
      view
        ? {
          id: view.id, revision: view.revision,
          phase: view.phase as 'active' | 'paused' | 'blocked' | 'complete',
          activation: view.activation as 'armed' | 'disarmed',
        }
        : undefined
    const projection = deriveProjection(
      host.agent.session.snapshotEvents() as never, { activation: 'always' }, { cwd: '/work/repo' }, true,
    ).projection
    const live = goals.get(host.agent as never)!
    expect(live, 'the goal must exist before the boundary is established').toBeDefined()
    projection.enabled = true
    projection.hostTurn = 1
    projection.currentGoalRef = { id: live.id, revision: live.revision }
    projection.currentGoalPhase = live.phase
    projection.currentGoalActivation = live.activation as 'armed'
    // The budget is spent by the PRODUCTION entry, one host turn at a time —
    // never by hand-writing records. A hand-written `user/message` has no `id`,
    // and the host's own reader refuses such a log on reload ("lacks an
    // identified message"), so seeding it here would corrupt the session the
    // reload scenario has to read.
    const { progressFingerprint } = await import('../../src/domain/stop-policy.js')
    const fingerprint = progressFingerprint(projection)
    const runtimeFor = (turn: number) => ({
      get projection() {
        const derived = deriveProjection(host.agent.session.snapshotEvents() as never, { activation: 'always' }, { cwd: '/work/repo' }, true).projection
        derived.enabled = true
        derived.currentGoalRef = { id: live.id, revision: live.revision }
        derived.currentGoalPhase = live.phase
        derived.currentGoalActivation = live.activation as 'armed'
        derived.hostTurn = turn
        return derived
      },
      sync: () => {}, setEnabled: () => {}, setDurability: () => {}, consumeRecovery: () => false,
      get lifecycle() { return 'active' as const },
      get protocolV4Present() { return true },
    })
    const access = () => ({
      flush: async () => true,
      hostSupported: true,
      readExternalOperation: () => undefined,
      goalAccess: {
        get: async () => normalize(goals.get(host.agent as never) as never),
        disarm: async () => normalize(goals.disarm(host.agent as never) as never),
      },
    })
    // Two earlier host turns decided by the production entry, writing their own
    // durable records; the third is the bounded stop.
    expect(await handleGuardTurnStopping(host.agent as never, runtimeFor(1) as never, access()))
      .toBe('goal_round_driver_owns_continuation')
    expect(await handleGuardTurnStopping(host.agent as never, runtimeFor(2) as never, access()))
      .toBe('no_progress_diagnosis_steer')
    // The `no_progress_diagnosis_steer` above steers the agent, so its own
    // correction turn runs and calls the model. The baseline for "no further
    // model calls" is therefore taken AFTER that turn settles, not before it.
    await host.agent.whenIdle()
    const llmBeforeStop = host.llmCalls.prepare + host.llmCalls.stream
    const roundsBeforeStop = roundMessages(host).length
    const reason = await handleGuardTurnStopping(host.agent as never, runtimeFor(3) as never, access())
    console.log('STOP', JSON.stringify({ reason, goal: normalize(goals.get(host.agent as never) as never), created: created.id }))
    expect(reason).toBe('boundary_effectuated')
    expect(normalize(goals.get(host.agent as never) as never)).toMatchObject({ activation: 'disarmed', id: created.id })

    // No further progress, and not because anything errored or was cancelled:
    // the driver is simply no longer given a reason to run.
    expect(host.llmCalls.prepare + host.llmCalls.stream).toBe(llmBeforeStop)
    expect(roundMessages(host).length).toBe(roundsBeforeStop)
    void llmAfterFirstTurn; void roundsAfterFirstTurn
    expect(host.observed.errors).toEqual([])
    expect(host.agent.status).not.toBe('error')
  })
})

/**
 * Scenario 3: the boundary, the budget and the open obligation live on DISK.
 *
 * Host A establishes everything through the production path, flushes and is then
 * really destroyed; host B is built over the same temp JSONL root and reads the
 * session back. Nothing in-memory crosses: a fixture that kept the old `Session`
 * or projection would prove nothing about persistence.
 */
describe('the boundary and the budget survive a disk reload', () => {
  it('reads the same boundary, budget and open obligation back in a new host', async () => {
    const { handleGuardTurnStopping } = await import('../../src/runtime.js')
    const { deriveProjection } = await import('../../src/domain/derive.js')
    const { progressFingerprint } = await import('../../src/domain/stop-policy.js')
    const GoalService = (await import('@deepseek-ai/dsh-goal')).default

    const sessionRoot = mkdtempSync(join(tmpdir(), 'cg-host-reload-'))

    // ---- host A: the production path establishes and persists the boundary ----
    const a = await startLoopHost(sessionRoot)
    await runTurn(a, '持续推进，直到迁移脚本全部跑完为止。')
    const goalsA = new GoalService(a.ctx as never, {})
    const goal = goalsA.create(a.agent as never, { objective: 'finish the guarded change' })
    const normalize = (view: { id: string; revision: number; phase: string; activation: string } | undefined) =>
      view ? {
        id: view.id, revision: view.revision,
        phase: view.phase as 'active' | 'paused' | 'blocked' | 'complete',
        activation: view.activation as 'armed' | 'disarmed',
      } : undefined
    const projectionOf = (host: LoopHost, turn: number) => {
      const derived = deriveProjection(host.agent.session.snapshotEvents() as never, { activation: 'always' }, { cwd: '/work/repo' }, true).projection
      derived.enabled = true
      const live = goalsA.get(a.agent as never)!
      derived.currentGoalRef = { id: live.id, revision: live.revision }
      derived.currentGoalPhase = live.phase
      derived.currentGoalActivation = live.activation as 'armed'
      derived.hostTurn = turn
      return derived
    }
    const seeded = projectionOf(a, 1)
    const fingerprint = progressFingerprint(seeded)
    const runtimeOf = (host: LoopHost, turn: number) => ({
      get projection() { return projectionOf(host, turn) },
      sync: () => {}, setEnabled: () => {}, setDurability: () => {}, consumeRecovery: () => false,
      get lifecycle() { return 'active' as const },
      get protocolV4Present() { return true },
    })
    const accessOf = (host: LoopHost) => ({
      flush: async () => true,
      hostSupported: true,
      readExternalOperation: () => undefined,
      goalAccess: {
        get: async () => normalize(goalsA.get(host.agent as never) as never),
        disarm: async () => normalize(goalsA.disarm(host.agent as never) as never),
      },
    })
    // Two earlier host turns, each decided by the production entry, which writes
    // its own record durably. The third is the bounded stop.
    expect(await handleGuardTurnStopping(a.agent as never, runtimeOf(a, 1) as never, accessOf(a)))
      .toBe('goal_round_driver_owns_continuation')
    expect(await handleGuardTurnStopping(a.agent as never, runtimeOf(a, 2) as never, accessOf(a)))
      .toBe('no_progress_diagnosis_steer')
    const reason = await handleGuardTurnStopping(a.agent as never, runtimeOf(a, 3) as never, accessOf(a))
    expect(reason).toBe('boundary_effectuated')

    // What must come back from disk, recorded while A is still alive.
    const before = deriveProjection(a.agent.session.snapshotEvents() as never, { activation: 'always' }, { cwd: '/work/repo' }, true).projection
    const beforeBoundary = before.boundaries.find((row) => row.disposition === 'guard_bounded_stop')!
    const beforeBudget = Object.fromEntries([...(before.noProgressClaims.get(fingerprint) ?? new Map())])
    const beforeOpen = [...before.items.values()].filter((item) => item.status === 'pending').map((item) => `${item.id}:${item.kind}:${item.status}`)
    const sessionId = a.agent.session.snapshotEvents().length > 0 ? 'loop-host-agent' : ''
    expect(beforeBoundary, 'A must have persisted the boundary').toBeDefined()
    // The two seeded boundaries. The stop decision itself claims nothing: the
    // boundary carries the fingerprint instead.
    expect(Object.keys(beforeBudget).length).toBe(2)
    expect(beforeBoundary.qualificationIds[0]).toBe(fingerprint)

    // ---- destroy A for real ----
    const persistenceA = (a.ctx as never as { get: (n: string) => unknown }).get('sessionPersistence') as {
      flush?: (...args: unknown[]) => Promise<unknown>
      list?: () => Promise<unknown>
      open?: (...args: unknown[]) => Promise<unknown>
    }
    console.log('PERSISTENCE_API', JSON.stringify(Object.getOwnPropertyNames(Object.getPrototypeOf(persistenceA)).slice(0, 14)))
    await a.fiber.dispose?.()

    // ---- host B: a new instance over the same root, creating nothing ----
    const b = await startLoopHost(sessionRoot, { createAgent: false })
    const persistenceB = (b.ctx as never as { get: (n: string) => unknown }).get('sessionPersistence') as {
      list: () => Promise<Array<{ id?: string } | string>>
      readStoredLog: (path: unknown, expectedId: unknown) => Promise<{ events?: unknown[] } | unknown[]>
    }
    const listed = await persistenceB.list()
    console.log('DISK_LIST', JSON.stringify(listed).slice(0, 200))
    // `readStoredLog(path)` reads one stored log FILE, so the path comes from the
    // backend's own root. The layout is read from disk rather than assumed.
    const { readdirSync } = await import('node:fs')
    const files = readdirSync(sessionRoot, { recursive: true } as never).map(String)
    console.log('DISK_FILES', JSON.stringify(files))
    // The stored session is a directory per session holding the log file; the
    // file is picked by its extension so the directory cannot be mistaken for it.
    const sessionFile = files.find((name) => name.endsWith('.jsonl.zstd') || name.endsWith('.jsonl'))!
    // `readStoredLog(path, expectedId)`: it refuses a log whose stored identity
    // is not the one requested, which is itself a persistence guarantee.
    const stored = await persistenceB.readStoredLog(join(sessionRoot, sessionFile) as never, 'loop-host-agent' as never)
    const storedEvents = (Array.isArray(stored) ? stored : (stored as { events?: unknown[] }).events ?? []) as Array<{ type: string; data: unknown }>
    expect(storedEvents.length, 'the session must be readable from disk in a new host').toBeGreaterThan(0)

    const reloaded = deriveProjection(storedEvents as never, { activation: 'always' }, { cwd: '/work/repo' }, true).projection
    // 1. The same session's boundary is still accepted.
    const boundary = reloaded.boundaries.find((row) => row.disposition === 'guard_bounded_stop')
    expect(boundary).toMatchObject({
      id: beforeBoundary.id, persistedResult: 'accepted', candidateSha256: beforeBoundary.candidateSha256,
    })
    // 2. The budget's boundary keys and attempts are unchanged.
    expect(Object.fromEntries([...(reloaded.noProgressClaims.get(fingerprint) ?? new Map())])).toEqual(beforeBudget)
    // 3. The open obligation and its state are preserved.
    expect([...reloaded.items.values()].filter((item) => item.status === 'pending').map((item) => `${item.id}:${item.kind}:${item.status}`))
      .toEqual(beforeOpen)
    expect(sessionId).toBe('loop-host-agent')

    // 4. Retrying the same boundary after the reload adds no attempt. The
    //    projection, the decision and the qualification all run on what B read
    //    back from disk — nothing here references A's in-memory state.
    const { decideTurnBoundary } = await import('../../src/domain/stop-policy.js')
    const { qualifyBoundary } = await import('../../src/domain/boundary.js')
    reloaded.enabled = true
    // A retry arrives from the same host turn the boundary was decided at, where
    // the goal was still armed: the log B read back is that same log, and the
    // disarm is what the boundary did afterwards.
    reloaded.hostTurn = 3
    reloaded.currentGoalActivation = 'armed'
    const retried = decideTurnBoundary(reloaded)
    // The retry does not re-decide: the boundary A persisted is already the
    // current accepted boundary on disk, so the production decision takes that
    // path — which is why it allocates nothing.
    expect(retried).toMatchObject({ action: 'stop', reason: 'accepted_boundary_pending_effectuation' })
    // No claim is issued for a stop, so a retry cannot allocate one.
    expect(retried.noProgressClaim).toBeUndefined()
    // The boundary still qualifies against the reloaded state, and its identity
    // is the same one A persisted.
    expect(qualifyBoundary(reloaded, {
      disposition: 'guard_bounded_stop', qualificationKind: 'guard_no_progress', qualificationIds: [fingerprint],
    })).toMatchObject({ persistedResult: 'accepted', candidateSha256: beforeBoundary.candidateSha256 })

    // And the durable budget is unchanged by the retry: read the file again.
    const afterRetry = await persistenceB.readStoredLog(join(sessionRoot, sessionFile) as never, 'loop-host-agent' as never)
    const afterEvents = (Array.isArray(afterRetry) ? afterRetry : (afterRetry as { events?: unknown[] }).events ?? []) as Array<{ type: string; data: unknown }>
    const afterProjection = deriveProjection(afterEvents as never, { activation: 'always' }, { cwd: '/work/repo' }, true).projection
    expect(Object.fromEntries([...(afterProjection.noProgressClaims.get(fingerprint) ?? new Map())])).toEqual(beforeBudget)
  })
})
