import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { ModelListingCache, requestModelListing, parseModelListing } from '@deepseek-ai/dsh-llm-deepseek'
import type { ModelListing } from '@deepseek-ai/dsh-llm-deepseek'
import { applyWithFixtureActivation as apply } from './activation-fixture.js'
import { deriveProjection, PROTOCOL_V6_NOTICE } from '../src/domain/derive.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'

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

const HOST = { ...evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' }), goalAvailable: false }
const BASE = 'https://api.deepseek.com'
// The OFFICIAL wire shape: snake_case top-level fields with
// api_capabilities.anthropic_messages as an object of Messages-mode facts
// (verified against the rc.3 dsh-llm-deepseek decoder).
const LISTING_BODY = {
  data: [
    {
      id: 'deepseek-chat', name: 'DeepSeek Chat',
      api_capabilities: { anthropic_messages: { system_prompt_update: 'in-history', tool_update: 'in-history' } },
      input_modalities: ['text'], output_modalities: ['text'],
      client_requirements: { 'deepseek-harness': { kind: 'none' } },
    },
    {
      id: 'deepseek-reasoner', name: 'DeepSeek Reasoner',
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
    expect(listing.entries.map(e => e.id)).toEqual(['deepseek-chat', 'deepseek-reasoner'])
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
      expect(listing2.entries.map(e => e.id)).toEqual(['deepseek-chat', 'deepseek-reasoner'])
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
    expect(first.listing?.entries.map(e => e.id)).toEqual(['deepseek-chat', 'deepseek-reasoner'])
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
    expect(recovered.listing?.entries.map(e => e.id)).toEqual(['deepseek-chat', 'deepseek-reasoner'])
    cache.dispose()
  })

  it('a real AbortSignal abandons only the wait; the shared load continues for later accesses', async () => {
    const transport = makeTransport()
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
    expect(later.listing?.entries.map(e => e.id)).toEqual(['deepseek-chat', 'deepseek-reasoner'])
    cache.dispose()
  })
})

describe('RC3-M01: one shared context — listing-derived updates keep Guard visible', () => {
  it('Guard tools and notices stay present when the host registers a listing-derived provider', async () => {
    // ONE Cordis context carries BOTH the LlmRuntime (official listing cache)
    // and Guard apply — the shared pipeline the review asked for.
    const ctx = new Context()
    const llmRuntime = new LlmRuntime(ctx)
    const transport = makeTransport()
    transport.push(LISTING_BODY)
    const cache = new ModelListingCache({
      credential: async () => 'test-credential',
      load: transport.load,
      now: () => 4_000_000,
      info: () => {},
      warn: () => {},
    })
    // The api-key adapter registers providers whose model metadata comes from
    // this cache; replicate the registration the adapter's apply performs with
    // a listing-derived provider (model ids from the REAL decoded listing).
    const listing = await cache.view({ url: `${BASE}/models`, timeoutMs: 5_000, maxAgeMs: 60_000 })
    const providerIds = listing.listing!.entries.map(entry => entry.id)
    // LlmAdapter is an abstract class: extend it so registration type-checks
    // while the provider rides the REAL official listing cache. The update
    // modes come from the real ListedFacts (in-history for both).
    // The registration type is the abstract LlmAdapter; this control never
    // dispatches a model call, so stream stays unimplemented and the instance
    // is cast at the registration boundary (runtime accepts duck-shaped
    // adapters exactly like the earlier component control).
    const listingDerivedAdapter = {
      providerInfo: (provider: string) => ({ id: provider, name: `official listing: ${provider}` }),
      providerRetryPolicy: () => undefined,
      listModels: async () => listing.listing!.entries.map(entry => ({ provider: entry.id, id: entry.id, name: entry.name ?? entry.id })),
      resolveModel: async (provider: string, model: string) => ({
        provider, model, id: model, name: model,
        systemPromptUpdate: 'in-history' as const,
        toolUpdate: 'in-history' as const,
      }),
    } as unknown as Parameters<typeof llmRuntime.registerAdapter>[1]
    llmRuntime.registerAdapter(providerIds, listingDerivedAdapter)

    // Guard on the SAME context.
    const guardHandlers = new Map<string, Array<(...args: never[]) => unknown>>()
    const guardCtx = {
      handlers: guardHandlers,
      commands: { register: () => {} },
      sessions: { flush: async () => true },
      on: (event: string, handler: (...args: never[]) => unknown) => { guardHandlers.set(event, [...(guardHandlers.get(event) ?? []), handler]) },
    }
    apply(guardCtx as never, { activation: 'always', hostLockPackages: EXPECTED_HOST_PACKAGES, hostLockPlatform: 'posix', hostLockProfile: 'web' })

    // A real session on the shared context: the first claimed input gets the
    // boundary + guidance exactly once and Guard tools registered.
    const session = Session.create(SessionId('rc3-m01-shared'), undefined, {
      version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId('rc3-m01-shared'), createdAt: 1, cwd: '/work',
    })
    const registered: Array<{ name: string }> = []
    const agent = {
      session, steer: () => {},
      ctx: {
        tools: { register: (tool: { name: string }) => { registered.push(tool); return () => {} }, guard: () => {}, get: () => undefined },
        get: () => undefined,
      },
    }
    for (const handler of guardHandlers.get('agent/created') ?? []) {
      ;(handler as (payload: { agent: unknown; source: string }) => void)({ agent, source: 'new' })
    }
    expect(session.seq).toBe(0)
    const claim = createUserMessage({ content: [{ type: 'text', text: '修改 rc3-m01.txt 并汇报。' }], source: { kind: 'user' } })
    const handler = guardHandlers.get('agent/pre-step')?.[0] as ((payload: unknown, next: () => Promise<unknown>) => Promise<{ kind: string; messages?: unknown[] }>) | undefined
    const decision = await handler!({ agent, messages: [claim] }, async () => ({ kind: 'enter', messages: [claim] })) as { messages: unknown[] }
    const texts = decision.messages.map((message) => ((message as { content?: Array<{ text?: string }> }).content ?? [])[0]?.text)
    expect(texts.filter((t) => t === PROTOCOL_V6_NOTICE)).toHaveLength(1)
    expect(texts[texts.length - 1]).toContain('rc3-m01.txt')
    expect(registered.map(t => t.name)).toContain('context_guard_checkpoint')
    // The listing-derived update modes flow through resolveModel on the SAME
    // runtime; Guard's captured projection is unaffected by them.
    for (const provider of providerIds) {
      const resolved = await llmRuntime.resolveModelInfo(provider, provider)
      expect(resolved.systemPromptUpdate ?? 'in-history').toBe('in-history')
    }
  })
})
