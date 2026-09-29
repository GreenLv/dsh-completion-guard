import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Real new-host (rc.020) recovery entries. The host event production chain is
 * the fixture's own composition — the real agent loop, real ToolCallRecovery,
 * real persistence backend and the session package's own recovery functions —
 * never hand-appended events. The test contributes only the deterministic
 * model, one registered side-effectful tool with an execution counter, and
 * Guard's projection read over the produced durable log.
 */
const FIXTURE = new URL('./fixtures/host-composition/node_modules/@deepseek-ai/', import.meta.url)
const load = (pkg: string) => import(new URL(`${pkg}/lib/index.js`, FIXTURE).href)

interface Host {
  ctx: Record<string, unknown>
  agent: { session: { snapshotEvents: () => Array<{ type: string; data: Record<string, unknown> }> };
    followup: (m: unknown) => unknown; wakeDriver: () => unknown; whenIdle: () => Promise<unknown> }
  effects: { count: number }
  sessionRoot: string
  fiber: { dispose?: () => unknown }
}

const liveHosts: Host[] = []
afterEach(async () => {
  while (liveHosts.length > 0) {
    const host = liveHosts.pop()!
    try { await host.fiber.dispose?.() } catch { /* best effort */ }
  }
})

async function startRecoveryHost(sessionRoot = mkdtempSync(join(tmpdir(), 'cg-rc020-recovery-')), options: { renderFails?: boolean; createAgent?: boolean; hangMidFlight?: boolean } = {}) {
  const { Context } = await load('cordis')
  const loop = await load('dsh-agent-loop')
  const agentSdk = await load('dsh-agent')
  const projection = await load('dsh-session-projection')
  const prompt = await load('dsh-system-prompt')
  const toolsSdk = await load('dsh-tools')
  const sessionSdk = await load('dsh-session')
  const persistenceJsonl = await load('dsh-session-persistence-jsonl')
  const ctx = new (Context as new () => Record<string, unknown>)()
  void new (agentSdk.AgentRegistry as new (ctx: unknown) => unknown)(ctx)
  void new (projection.SessionProjectionRegistry as new (ctx: unknown) => unknown)(ctx)
  void new (prompt.SystemPrompt as new (ctx: unknown, config: unknown) => unknown)(ctx, {
    includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: '', personaSuffix: '', toolOrder: undefined,
  })
  void new (toolsSdk.ToolRuntime as new (ctx: unknown, config?: unknown) => unknown)(ctx)
  void new (sessionSdk.SessionStore as new (ctx: unknown) => unknown)(ctx)
  void new (persistenceJsonl.default as new (ctx: unknown, config: unknown) => unknown)(ctx, { root: sessionRoot, compression: undefined })
  const effects = { count: 0 }
  const runtime = (ctx as unknown as { get: (n: string) => { register: (d: unknown) => unknown } }).get('tools')
  runtime.register({
    name: 'effect_probe',
    description: 'a registered real tool whose execution IS a side effect',
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { status: { type: 'string' } } },
      // When armed, result PROCESSING throws after the effect ran: the loop's
      // step-failure entry (ToolCallRecovery in the step runner) then closes
      // the recorded call with the conservative unknown result.
      render: () => {
        if (options.renderFails) throw new Error('fixture: result processing failed')
        return [{ type: 'text' as const, text: 'ok' }]
      },
    },
    execute: async () => {
      effects.count += 1
      if (options.hangMidFlight) {
        // The real abandoned-crash shape: the process dies while the tool is
        // executing. The durable log ends at tool/call with no result.
        await new Promise(() => { /* never settles; host A is abandoned */ })
      }
      return { status: 'effect done' }
    },
  })
  let streamIndex = 0
  ;(ctx as unknown as { provide: (n: string, v: unknown) => void }).provide('llm', {
    prepareCall: async (config: unknown) => ({ config, retryPolicy: { maxAttempts: 1 }, stream: () => {
      streamIndex += 1
      if (streamIndex === 1) return (async function* () {
        yield { type: 'text-delta', index: 0, text: 'Running the effect probe.' }
        yield { type: 'tool-call-delta', index: 1, id: 'probe-call-1', name: 'effect_probe', argumentsDelta: '{}' }
        yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'probe-call-1', name: 'effect_probe', arguments: '{}' } }
        yield { type: 'finish', reason: 'tool_calls' }
      })()
      throw new Error('fixture: model provider crashed mid-step')
    } }),
    stream: () => { throw new Error('fixture: legacy stream entrypoint must not be used') },
  })
  const fiber = (ctx as unknown as { plugin: (p: unknown) => unknown }).plugin(loop.AgentLoop as never)
  await Promise.resolve(fiber)
  const agent = options.createAgent === false
    ? undefined
    : await (ctx as unknown as { get: (n: string) => { create: (id: string, o?: unknown, m?: unknown) => Promise<unknown> } })
      .get('agentLoop').create('rc020-recovery-agent', { provider: 'fixture', model: 'fixture-model' }, { cwd: '/work' })
  const host: Host = { ctx, effects, sessionRoot, fiber: fiber as Host['fiber'], agent: agent as Host['agent'] }
  liveHosts.push(host)
  return host
}

type Event = { type: string; data: Record<string, unknown> }
const resultsOf = (events: readonly Event[]) => events
  .filter((event) => event.type === 'tool/result')
  .map((event) => {
    const message = event.data.message as { isError?: boolean; content?: Array<{ text?: string }>; toolCallId?: string }
    const error = event.data.error as { name?: string } | undefined
    return { toolCallId: message?.toolCallId, isError: message?.isError === true, errorName: error?.name, text: message?.content?.[0]?.text ?? '' }
  })

const loadBase = async () => {
  const { Context } = await load('cordis')
  const agentSdk = await load('dsh-agent')
  const projectionSdk = await load('dsh-session-projection')
  const prompt = await load('dsh-system-prompt')
  const toolsSdk = await load('dsh-tools')
  const loop = await load('dsh-agent-loop')
  const sessionSdk = await load('dsh-session')
  const persistenceJsonl = await load('dsh-session-persistence-jsonl')
  return { Context, agentSdk, projectionSdk, prompt, toolsSdk, loop, sessionSdk, persistenceJsonl }
}
const Guard = () => import('../src/runtime.js') as Promise<{ authorizeMutationFromProjection: (p: unknown, r: unknown) => unknown }>
const Derive = () => import('../src/domain/derive.js')
const HostLock = () => import('../src/domain/host-lock.js')
const projectionOf = async (events: readonly Event[], sessionId: string) => {
  const { deriveProjection, PROTOCOL_V6_NOTICE } = await Derive()
  const { evaluateHostLock, EXPECTED_HOST_PACKAGES } = await HostLock()
  const HOST = { ...evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' }), auditedForegroundRenderers: ['bash'] }
  const withNotice = [
    { seq: 0, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }] } },
    ...events.map((event, index) => ({ ...event, seq: index + 1 })),
  ]
  const scope = { cwd: '/work', sessionHeader: { version: 4, id: sessionId, createdAt: 1, seedLength: 0, delegationDepth: 0 } }
  const projection = deriveProjection(withNotice as never, { activation: 'always' }, scope, true, HOST as never).projection
  projection.durabilityWatermark = 'confirmed'
  return projection
}

const INSTALL_TARGET = { package_id: 'package-fixture', version: '2.0.0', integrity_digest: 'sha512-fixture', profile: 'web' }

describe('rc.020 real recovery entries keep unknown outcomes from authorizing side effects', () => {
  it('agent-loop failed step: the loop itself closes the recorded call as unknown; the effect is not re-run or authorized', async () => {
    const host = await startRecoveryHost(undefined, { renderFails: true })
    const llmSdk = await load('dsh-llm')
    host.agent.followup((llmSdk.createUserMessage as (i: unknown) => unknown)({
      content: [{ type: 'text', text: '安装 package-fixture@2.0.0 到 profile web。' }], source: { kind: 'user' },
    }))
    host.agent.wakeDriver()
    try { await host.agent.whenIdle() } catch { /* the failed step surfaces at idle */ }
    // The side effect ran exactly once. The loop's own step-failure entry then
    // persisted the conservative unknown result for the recorded call.
    expect(host.effects.count).toBe(1)
    const unknown = resultsOf(host.agent.session.snapshotEvents()).filter((row) => row.toolCallId === 'probe-call-1' && row.isError)
    expect(unknown).toHaveLength(1)
    expect(unknown[0]!.text).toBeTruthy()
    const projection = await projectionOf(host.agent.session.snapshotEvents(), 'rc020-recovery-agent')
    const install = [...projection.items.values()].find((row) => row.semanticAction === 'install')
    expect(install, JSON.stringify([...projection.items.values()].map((row) => ({ id: row.id, action: row.semanticAction, status: row.status })))).toBeDefined()
    expect(install!.status).toBe('pending')
    const { authorizeMutationFromProjection } = await Guard()
    expect(authorizeMutationFromProjection(projection, { action: 'install', contractItemId: install!.id,
      contractItemRevision: install!.revision, resolvedTarget: INSTALL_TARGET })).toMatchObject({ status: 'denied' })
    expect(host.effects.count).toBe(1)
  })

  it('registered resume: agentLoop.resume consumes the drained log, appends the host recovery itself, and the resumed agent re-derives the refusal', async () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), 'cg-rc020-reload-'))
    const host = await startRecoveryHost(sessionRoot, { hangMidFlight: true })
    const llmSdk = await load('dsh-llm')
    host.agent.followup((llmSdk.createUserMessage as (i: unknown) => unknown)({
      content: [{ type: 'text', text: '安装 package-fixture@2.0.0 到 profile web。' }], source: { kind: 'user' },
    }))
    host.agent.wakeDriver()
    for (let waited = 0; waited < 100; waited += 1) {
      const hasCall = host.agent.session.snapshotEvents().some((event) => event.type === 'tool/call')
      const hasResult = host.agent.session.snapshotEvents().some((event) => event.type === 'tool/result')
      if (hasCall && !hasResult) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(host.agent.session.snapshotEvents().some((event) => event.type === 'tool/call')).toBe(true)
    const backend = (host.ctx as unknown as { sessionPersistence?: { tracker?: { writers?: Map<string, { drainBuffered: () => Promise<unknown>; close: () => Promise<unknown> }> } } }).sessionPersistence!
    const writerA = backend.tracker!.writers!.get('rc020-recovery-agent')!
    await writerA.drainBuffered()
    await writerA.close()
    // Host A's loop is abandoned mid-flight (its driver is stuck on the hung
    // tool); it is NOT disposed — dispose would drain the driver and block.
    // The bounded pending promise keeps no active handle alive.
    liveHosts.splice(liveHosts.indexOf(host), 1)

    const { Context } = await load('cordis')
    const loop = await load('dsh-agent-loop')
    const agentSdk = await load('dsh-agent')
    const projectionSdk = await load('dsh-session-projection')
    const prompt = await load('dsh-system-prompt')
    const toolsSdk = await load('dsh-tools')
    const sessionSdk = await load('dsh-session')
    const persistenceJsonl = await load('dsh-session-persistence-jsonl')
    const ctx = new (Context as new () => Record<string, unknown>)()
    void new (agentSdk.AgentRegistry as new (ctx: unknown) => unknown)(ctx)
    void new (projectionSdk.SessionProjectionRegistry as new (ctx: unknown) => unknown)(ctx)
    void new (prompt.SystemPrompt as new (ctx: unknown, config: unknown) => unknown)(ctx, {
      includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: '', personaSuffix: '', toolOrder: undefined,
    })
    void new (toolsSdk.ToolRuntime as new (ctx: unknown, config?: unknown) => unknown)(ctx)
    void new (sessionSdk.SessionStore as new (ctx: unknown) => unknown)(ctx)
    void new (persistenceJsonl.default as new (ctx: unknown, config: unknown) => unknown)(ctx, { root: sessionRoot, compression: undefined })
    void new (loop.AgentLoop as unknown as new (ctx: unknown, config: unknown) => unknown)(ctx, { agents: [] })
    const persistenceB = (ctx as unknown as { get: (n: string) => unknown }).get('sessionPersistence')
    void persistenceB
    const resumedHandle = await (ctx as unknown as { get: (n: string) => { resume: (owner: unknown, o: { resumeSessionId: string }) => Promise<unknown> } })
      .get('agentLoop').resume(ctx as never, { resumeSessionId: 'rc020-recovery-agent' })
    const resumedAgent = (resumedHandle as unknown as { agent: { session: { snapshotEvents: () => Array<{ type: string; data: Record<string, unknown> }> } } }).agent
    const events = resumedAgent.session.snapshotEvents()
    const unknown = resultsOf(events).filter((row) => row.toolCallId === 'probe-call-1' && row.isError)
    expect(unknown).toHaveLength(1)
    expect(unknown[0]!.errorName).toBe('ToolOutcomeUnknownError')
    expect(unknown[0]!.text).toMatch(/outcome is unknown|Do not retry blindly/)
    expect(events.filter((event) => event.type === 'turn/end').at(-1)!.data).toMatchObject({ reason: { kind: 'interrupted' } })
    const projection = await projectionOf(events, 'rc020-recovery-agent')
    const install = [...projection.items.values()].find((row) => row.semanticAction === 'install')
    expect(install!.status).toBe('pending')
    const { authorizeMutationFromProjection } = await Guard()
    expect(authorizeMutationFromProjection(projection, { action: 'install', contractItemId: install!.id,
      contractItemRevision: install!.revision, resolvedTarget: INSTALL_TARGET })).toMatchObject({ status: 'denied' })
  })

  it('registered fork: the seed becomes a REAL created agent whose durable log carries the forked closers; the fork refuses the effect', async () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), 'cg-rc020-fork-'))
    const host = await startRecoveryHost(sessionRoot, { hangMidFlight: true })
    const llmSdk = await load('dsh-llm')
    host.agent.followup((llmSdk.createUserMessage as (i: unknown) => unknown)({
      content: [{ type: 'text', text: '安装 package-fixture@2.0.0 到 profile web。' }], source: { kind: 'user' },
    }))
    host.agent.wakeDriver()
    for (let waited = 0; waited < 100; waited += 1) {
      const hasCall = host.agent.session.snapshotEvents().some((event) => event.type === 'tool/call')
      const hasResult = host.agent.session.snapshotEvents().some((event) => event.type === 'tool/result')
      if (hasCall && !hasResult) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const persisted = host.agent.session.snapshotEvents()
    // The seed's boundary must sit inside the OPEN tail (turn open, tool call
    // recorded, no result) — the true crash shape for a fork cut mid-flight.
    let boundary = persisted.length - 1
    while (boundary > 0 && persisted[boundary]!.type !== 'tool/call') boundary -= 1
    expect(persisted[boundary]!.type).toBe('tool/call')
    const backend = (host.ctx as unknown as { sessionPersistence?: { tracker?: { writers?: Map<string, { drainBuffered: () => Promise<unknown>; close: () => Promise<unknown> }> } } }).sessionPersistence!
    const writerA = backend.tracker!.writers!.get('rc020-recovery-agent')!
    await writerA.drainBuffered()
    await writerA.close()
    liveHosts.splice(liveHosts.indexOf(host), 1)
    const sessionPkg = await import(new URL('dsh-session/lib/index.js', FIXTURE).href) as unknown as {
      buildForkSeed: (e: unknown, b: number) => Array<{ type: string; data: Record<string, unknown> }> }
    const seed = sessionPkg.buildForkSeed(persisted, boundary)
    const seedResults = resultsOf(seed).filter((row) => row.toolCallId === 'probe-call-1' && row.isError)
    expect(seedResults).toHaveLength(1)
    expect(seedResults[0]!.errorName).toBe('ToolOutcomeUnknownError')
    expect(seedResults[0]!.text).toContain('inherited by this branch')
    const { Context, agentSdk, projectionSdk, prompt, toolsSdk, sessionSdk, persistenceJsonl, loop } = await loadBase()
    const forkCtx = new (Context as new () => Record<string, unknown>)()
    void new (agentSdk.AgentRegistry as new (ctx: unknown) => unknown)(forkCtx)
    void new (projectionSdk.SessionProjectionRegistry as new (ctx: unknown) => unknown)(forkCtx)
    void new (prompt.SystemPrompt as new (ctx: unknown, config: unknown) => unknown)(forkCtx, {
      includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: '', personaSuffix: '', toolOrder: undefined,
    })
    void new (toolsSdk.ToolRuntime as new (ctx: unknown, config?: unknown) => unknown)(forkCtx)
    void new (sessionSdk.SessionStore as new (ctx: unknown) => unknown)(forkCtx)
    void new (persistenceJsonl.default as new (ctx: unknown, config: unknown) => unknown)(forkCtx, { root: mkdtempSync(join(tmpdir(), 'cg-rc020-fork-seed-')), compression: undefined })
    void new (loop.AgentLoop as unknown as new (ctx: unknown, config: unknown) => unknown)(forkCtx, { agents: [] })
    // createAgent is the registered lifecycle entry that accepts the fork
    // seed; the published handle is { agent, dispose }.
    const loopService = (forkCtx as unknown as { get: (n: string) => { createAgent: (owner: unknown, o: unknown) => Promise<unknown> } }).get('agentLoop')
    const handle = await loopService.createAgent(forkCtx as never, {
      sessionId: 'rc020-fork-agent',
      seed: seed.map((event, index) => ({ ...event, seq: index })) as unknown,
      meta: { version: 4, isSeeded: true, createdAt: 2, cwd: '/work' },
      inheritedEventCount: seed.length,
      agentOptions: { provider: 'fixture', model: 'fixture-model' },
    })
    const forkedAgent = (handle as unknown as { agent: { session: { snapshotEvents: () => Array<{ type: string; data: Record<string, unknown> }> } } }).agent
    const forkedEvents = forkedAgent.session.snapshotEvents()
    expect(forkedEvents.filter((event) => event.type === 'turn/end').at(-1)!.data).toMatchObject({ reason: { kind: 'forked' } })
    const projection = await projectionOf(forkedEvents, 'rc020-fork-agent')
    const install = [...projection.items.values()].find((row) => row.semanticAction === 'install')
    expect(install).toBeDefined()
    expect(install!.status).toBe('pending')
    const { authorizeMutationFromProjection } = await Guard()
    expect(authorizeMutationFromProjection(projection, { action: 'install', contractItemId: install!.id,
      contractItemRevision: install!.revision, resolvedTarget: INSTALL_TARGET })).toMatchObject({ status: 'denied' })
  })
})
