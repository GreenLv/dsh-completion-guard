import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config as ApiKeyConfig, apply as applyApiKey } from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { ModelListingCache, requestModelListing, parseModelListing } from '@deepseek-ai/dsh-llm-deepseek'
import type { ModelListing } from '@deepseek-ai/dsh-llm-deepseek'
import { applyWithFixtureActivation as apply } from './activation-fixture.js'
import { PROTOCOL_V6_NOTICE } from '../src/domain/derive.js'
import { EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'

/**
 * RC3-M01: the OFFICIAL rc.3 model-listing path under Guard protection, with
 * no model. The official `ModelListingCache` from `@deepseek-ai/dsh-llm-deepseek`
 * drives first-load, cache-hit, failure and cancellation through one controllable
 * `load` transport — the same dependencies object the api-key adapter mounts —
 * while Guard's `apply` runs on the SAME Cordis context, so the tools and
 * protection notices the host would send after a listing update are read back
 * from one shared pipeline. No login and no model request is involved: the
 * transport serves recorded bodies.
 */

const BASE = 'https://api.deepseek.com'
// The OFFICIAL wire shape: snake_case top-level fields with
// api_capabilities.anthropic_messages as an object of Messages-mode facts
// (verified against the rc.3 dsh-llm-deepseek decoder).
const LISTING_BODY = {
  data: [
    {
      id: 'deepseek-flash', name: 'DeepSeek Chat',
      api_capabilities: { anthropic_messages: { system_prompt_update: 'in-history', tool_update: 'in-history' } },
      input_modalities: ['text'], output_modalities: ['text'],
      client_requirements: { 'deepseek-harness': { kind: 'none' } },
    },
    {
      id: 'deepseek-v4-pro', name: 'DeepSeek Reasoner',
      api_capabilities: { anthropic_messages: {} },
      input_modalities: ['text'], output_modalities: ['text'],
      client_requirements: { 'deepseek-harness': { kind: 'none' } },
    },
  ],
}

/** A recorded-body transport: counts requests, serves a queue of outcomes. */
function makeTransport() {
  const calls: Array<{ url: string; signal: AbortSignal }> = []
  const queue: Array<() => Promise<ModelListing>> = []
  return {
    calls,
    queue,
    push(body: unknown) { queue.push(async () => parseModelListing(body)) },
    pushError(error: Error) { queue.push(async () => { throw error }) },
    load: async (url: string, _credential: string, signal: AbortSignal) => {
      calls.push({ url, signal })
      const next = queue.shift()
      if (!next) throw new Error('transport fixture exhausted')
      return await next()
    },
  }
}

describe('RC3-M01: official model listing cache under Guard protection', () => {
  it('requestModelListing decodes the official listing shape from a recorded body', async () => {
    const recorded = JSON.stringify(LISTING_BODY)
    const listing = parseModelListing(JSON.parse(recorded))
    expect(listing.entries.map(e => e.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    expect(listing.entries[0]!.capabilities.usable).toBe(true)
    // The real transport fetches the /models origin with the credential and
    // honors the signal — verified against a captured fetch.
    let capturedURL = '', capturedAuth = ''
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedURL = String(input)
      capturedAuth = String(new Headers(init?.headers).get('authorization') ?? '')
      return new Response(recorded, { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const listing2 = await requestModelListing(`${BASE}/models`, { authorization: 'Bearer recorded-test-credential' }, new AbortController().signal)
      expect(listing2.entries.map(e => e.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
      expect(capturedURL).toBe(`${BASE}/models`)
      expect(capturedAuth).toBe('Bearer recorded-test-credential')
    } finally { globalThis.fetch = originalFetch }
  })

  it('ModelListingCache: first load waits, cached repeats return the shared view, identity changes rescope', async () => {
    const transport = makeTransport()
    transport.push(LISTING_BODY)
    let clock = 1_000_000
    const cache = new ModelListingCache({
      credential: async () => 'test-credential',
      load: transport.load,
      now: () => clock,
      info: () => {},
      warn: () => {},
    })
    // First access waits for the load and publishes the view.
    const first = await cache.view({ url: `${BASE}/models`, timeoutMs: 5_000, maxAgeMs: 60_000 })
    expect(first.authenticated).toBe(true)
    expect(first.listing?.entries.map(e => e.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    expect(transport.calls).toHaveLength(1)
    // Cached repeat within maxAge: no new request.
    const cached = await cache.view({ url: `${BASE}/models`, timeoutMs: 5_000, maxAgeMs: 60_000 })
    expect(cached.listing?.entries).toHaveLength(2)
    expect(transport.calls).toHaveLength(1)
    // A stale view triggers exactly one background refresh (shared inflight).
    clock += 120_000
    transport.push(LISTING_BODY)
    const stale = await cache.view({ url: `${BASE}/models`, timeoutMs: 5_000, maxAgeMs: 60_000 })
    expect(stale.listing?.entries).toHaveLength(2)
    expect(transport.calls).toHaveLength(2)
    cache.dispose()
  })

  it('a failing load keeps the cache in a failing streak without faking a view, and later recovery republishes', async () => {
    const transport = makeTransport()
    transport.pushError(new Error('models endpoint down'))
    transport.push(LISTING_BODY)
    let clock = 2_000_000
    const cache = new ModelListingCache({
      credential: async () => 'test-credential',
      load: transport.load,
      now: () => clock,
      info: () => {},
      warn: () => {},
    })
    // A failed first load does NOT fake a view: the failing-streak access
    // resolves authenticated with no listing.
    const failingView = await cache.view({ url: `${BASE}/models`, timeoutMs: 5_000, maxAgeMs: 60_000 })
    expect(failingView.authenticated).toBe(true)
    expect(failingView.listing).toBeUndefined()
    // Recovery: invalidate() discards the failing streak and forces the next
    // access to load and republish the real listing.
    cache.invalidate()
    const recovered = await cache.view({ url: `${BASE}/models`, timeoutMs: 5_000, maxAgeMs: 60_000 })
    expect(recovered.listing?.entries.map(e => e.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    cache.dispose()
  })

  it('a real AbortSignal abandons only the wait; the shared load continues for later accesses', async () => {
    let releaseLoad: (listing: ModelListing) => void = () => {}
    const gated = new Promise<ModelListing>((resolve) => { releaseLoad = resolve })
    const cache = new ModelListingCache({
      credential: async () => 'test-credential',
      load: async () => await gated,
      now: () => 3_000_000,
      info: () => {},
      warn: () => {},
    })
    const settings = { url: `${BASE}/models`, timeoutMs: 5_000, maxAgeMs: 60_000 }
    const controller = new AbortController()
    const waiting = cache.view(settings, controller.signal)
    controller.abort()
    await expect(waiting).rejects.toThrow()
    // The shared load continues: releasing publishes the view for a later access.
    releaseLoad(parseModelListing(LISTING_BODY))
    const later = await cache.view(settings)
    expect(later.listing?.entries.map(e => e.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    cache.dispose()
  })
})

describe('RC3-M01: official adapter and Guard share one real Cordis request pipeline', () => {
  it('preserves Guard messages and registered schemas through listing-derived update modes into the official wire request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-official-listing-'))
    const originalFetch = globalThis.fetch
    vi.stubEnv('DSH_HOME', root)
    const ctx = new Context()
    const wire: Array<{ url: string; body?: Record<string, unknown> }> = []
    let listingRequests = 0, credential = 'recorded-test-credential'
    let mode: 'success' | 'failure' | 'pending' = 'success'
    let releasePending: (value: Response) => void = () => {}
    let enteredPending: () => void = () => {}
    const pendingResponse = new Promise<Response>(resolve => { releasePending = resolve })
    const pendingStarted = new Promise<void>(resolve => { enteredPending = resolve })
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/models')) {
        listingRequests += 1
        if (mode === 'failure') return new Response('recorded listing failure', { status: 503 })
        if (mode === 'pending') { enteredPending(); return await pendingResponse }
        const body = structuredClone(LISTING_BODY)
        body.data[1]!.client_requirements = { 'deepseek-harness': { min_version: '999.0.0' } } as never
        return Response.json(body)
      }
      wire.push({ url, body: JSON.parse(String(init?.body)) })
      // This controlled HTTP error terminates the official adapter stream;
      // no external network, real account or model is involved.
      return new Response('{"error":{"message":"recorded transport stop"}}', { status: 400 })
    }) as typeof fetch
    try {
      const registry = new AgentRegistry(ctx)
      const llm = new LlmRuntime(ctx)
      ctx.provide('launchEnvironment' as never, { get: () => undefined, getFrom: () => undefined } as never)
      ctx.provide('credentials' as never, { resolve: async () => ({ value: credential }) } as never)
      ctx.provide('commands' as never, { register: () => () => {} } as never)
      ctx.provide('sessions' as never, { flush: async () => true } as never)
      new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false } as never)
      new ToolRuntime(ctx)
      applyApiKey(ctx, ApiKeyConfig({}))
      apply(ctx, { activation: 'always', hostLockPackages: EXPECTED_HOST_PACKAGES, hostLockPlatform: 'posix', hostLockProfile: 'web' }, { privateLedgerRoot: root })
      const session = Session.create(SessionId('official-listing-shared'), undefined, {
        version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId('official-listing-shared'), createdAt: 1, cwd: '/work',
      })
      // Both the adapter and Guard observe this actual context. Only durability
      // and credential I/O above are controlled services; no duplicate event bus.
      const raw = { id: session.id, session, ctx, status: 'idle', steer: () => {} }
      raw.ctx = createScope(ctx, raw).ctx
      const agent = raw as unknown as Agent
      await registry.register(agent)
      expect(registry.get(session.id)).toBe(agent)
      expect(session.seq).toBe(0)
      const discovered = await llm.listModels('deepseek-official')
      expect(discovered.map(model => model.id)).toContain('deepseek-flash')
      await llm.listModels('deepseek-official')
      await expect(llm.prepareCall({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })).rejects.toThrow()
      expect(listingRequests).toBe(1)
      expect(session.seq).toBe(0) // listing never becomes session history
      const claim = createUserMessage({ content: [{ type: 'text', text: '修改 shared-pipeline.txt。' }], source: { kind: 'user' } })
      const decision = await ctx.waterfall(scopeTarget(agent, agent), 'agent/pre-step', { agent, messages: [claim], signal: new AbortController().signal, step: 1 } as never,
        async () => ({ kind: 'enter' as const, messages: [claim] }))
      expect(decision.kind).toBe('enter')
      if (decision.kind !== 'enter') throw new Error('expected entered step')
      const text = JSON.stringify(decision.messages)
      expect(text.split(PROTOCOL_V6_NOTICE).length - 1).toBe(1)
      const assembly = await ctx.systemPrompt.assemble({ scope: agent })
      expect(assembly.tools.map(tool => tool.name)).toContain('context_guard_checkpoint')
      const call = await llm.prepareCall({ provider: 'deepseek-official', model: 'deepseek-flash' })
      expect(call.systemPromptUpdate).toBe('in-history')
      expect(call.toolUpdate).toBe('in-history')
      for await (const _chunk of call.stream({ ...call.config, messages: decision.messages, tools: assembly.tools } as never)) { /* consume controlled failure */ }
      expect(wire).toHaveLength(1)
      const body = wire[0]!.body!
      expect(wire[0]!.url).toContain('/messages')
      expect(JSON.stringify(body.messages)).toContain(PROTOCOL_V6_NOTICE)
      expect(JSON.stringify(body.messages)).toContain('shared-pipeline.txt')
      expect(JSON.stringify(body.tools)).toContain('context_guard_checkpoint')
      expect(JSON.stringify(session.snapshotEvents())).not.toContain('DeepSeek Chat')
      // Exercise failure and cancellation through the SAME official adapter,
      // not just a standalone cache. Credential generation changes rescope
      // the real cache (the documented key-rotation path).
      credential = 'recorded-failure-generation'; mode = 'failure'
      const fallback = await llm.listModels('deepseek-official')
      expect(fallback.some(model => model.name === LISTING_BODY.data[0]!.name)).toBe(false)
      expect(listingRequests).toBe(2)
      expect((await ctx.systemPrompt.assemble({ scope: agent })).tools.map(tool => tool.name)).toContain('context_guard_checkpoint')
      credential = 'recorded-cancel-generation'; mode = 'pending'
      const abort = new AbortController()
      const waiting = llm.prepareCall({ provider: 'deepseek-official', model: 'deepseek-flash' }, abort.signal)
      await pendingStarted
      abort.abort()
      await expect(waiting).rejects.toThrow()
      const refreshed = structuredClone(LISTING_BODY)
      refreshed.data[0]!.api_capabilities.anthropic_messages.tool_update = 'addition-only' as never
      releasePending(Response.json(refreshed))
      const recovered = await llm.prepareCall({ provider: 'deepseek-official', model: 'deepseek-flash' })
      expect(recovered.toolUpdate).toBe('addition-only')
      expect(listingRequests).toBe(3) // caller abort did not cancel/repeat shared load
      expect((await ctx.systemPrompt.assemble({ scope: agent })).tools.map(tool => tool.name)).toContain('context_guard_checkpoint')
      expect(wire).toHaveLength(1)
      expect(JSON.stringify(session.snapshotEvents())).not.toContain('DeepSeek Chat')
    } finally {
      await ctx.fiber.dispose()
      globalThis.fetch = originalFetch
      vi.unstubAllEnvs()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
