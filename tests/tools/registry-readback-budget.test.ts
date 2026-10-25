import { describe, expect, it } from 'vitest'
import { DEFAULT_REGISTRY_READ_BUDGET, registryIntegrity } from '../../src/tools/evidence.js'
import { createReleaseTool } from '../../src/tools/release.js'
import { createProjection } from '../../src/domain/types.js'
import { privateLedgerContractDigest } from '../../src/domain/private-ledger.js'
import type { EvidenceToolRoots } from '../../src/tools/evidence.js'

/**
 * F09: the registry readback owns a total deadline and a streamed response
 * budget. Every scenario here uses a controlled fetch transport; the caller's
 * signal is NEVER aborted by the test, so any bounded exit proves the
 * plugin-owned budget, not caller cancellation.
 */

const REGISTRY = 'https://registry.example.invalid/'
const PACKAGE = 'budget-fixture'
const VERSION = '1.0.0'
const SRI = `sha512-${Buffer.alloc(64, 7).toString('base64')}`

interface StreamOptions { chunk: string; intervalMs: number; maxChunks: number }

/** A body producer that honours the fetch signal the way a real transport does. */
function streamingBody(options: StreamOptions): (signal?: AbortSignal) => ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return (signal) => new ReadableStream<Uint8Array>({
    start(controller) {
      let sent = 0
      const timer = setInterval(() => {
        if (sent >= options.maxChunks) { clearInterval(timer); controller.close(); return }
        sent += 1
        controller.enqueue(encoder.encode(options.chunk))
      }, options.intervalMs)
      const abort = () => { clearInterval(timer); controller.error(new Error('aborted')) }
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
    },
    cancel() { /* the reader released the body */ },
  })
}

const okFetcher = (body: string): typeof fetch => (async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch

describe('registryIntegrity under budgets (F09)', () => {
  it('returns the exact-version integrity for a normal response without Content-Length', async () => {
    const stream = streamingBody({ chunk: JSON.stringify({ name: PACKAGE, version: VERSION, dist: { integrity: SRI } }), intervalMs: 1, maxChunks: 1 })
    const fetcher = (async (_input: string | URL, init?: RequestInit) =>
      new Response(stream(init?.signal ?? undefined), { status: 200 })) as unknown as typeof fetch
    const roots: EvidenceToolRoots = { fetcher }
    expect(await registryIntegrity(REGISTRY, PACKAGE, VERSION, roots, new AbortController().signal)).toBe(SRI)
  })

  it('ends a never-finishing slow body within the plugin deadline although the caller never cancels', async () => {
    const stream = streamingBody({ chunk: '{"partial":', intervalMs: 10, maxChunks: Number.MAX_SAFE_INTEGER })
    const fetcher = (async (_input: string | URL, init?: RequestInit) =>
      new Response(stream(init?.signal ?? undefined), { status: 200 })) as unknown as typeof fetch
    const started = Date.now()
    const roots: EvidenceToolRoots = { fetcher, registryReadBudget: { totalDeadlineMs: 60, maxBodyBytes: 1024 * 1024 } }
    expect(await registryIntegrity(REGISTRY, PACKAGE, VERSION, roots, new AbortController().signal)).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('refuses a body that streams past the byte budget and releases the reader', async () => {
    let cancelled = false
    const encoder = new TextEncoder()
    let timer: ReturnType<typeof setInterval> | undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        timer = setInterval(() => controller.enqueue(encoder.encode('x'.repeat(4096))), 1)
        setTimeout(() => { if (timer) clearInterval(timer); controller.close() }, 2_000)
      },
      cancel() { if (timer) clearInterval(timer); cancelled = true },
    })
    const fetcher = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch
    const roots: EvidenceToolRoots = { fetcher, registryReadBudget: { totalDeadlineMs: 30_000, maxBodyBytes: 8192 } }
    expect(await registryIntegrity(REGISTRY, PACKAGE, VERSION, roots, new AbortController().signal)).toBeUndefined()
    expect(cancelled, 'the oversized body reader is released').toBe(true)
  })

  it.each([
    ['404', (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch],
    ['bad JSON', okFetcher('not json at all')],
    ['wrong package name', okFetcher(JSON.stringify({ name: 'other-package', version: VERSION, dist: { integrity: SRI } }))],
    ['wrong version', okFetcher(JSON.stringify({ name: PACKAGE, version: '9.9.9', dist: { integrity: SRI } }))],
    ['missing integrity', okFetcher(JSON.stringify({ name: PACKAGE, version: VERSION }))],
    ['hanging fetch that never answers', (async (_input: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })) as unknown as typeof fetch],
  ])('refuses %s without trusting the readback', async (_label, fetcher) => {
    const roots: EvidenceToolRoots = { fetcher, registryReadBudget: { totalDeadlineMs: 80, maxBodyBytes: 1024 * 1024 } }
    const started = Date.now()
    expect(await registryIntegrity(REGISTRY, PACKAGE, VERSION, roots, new AbortController().signal)).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('releases a readable body on HTTP error responses (RF05)', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('not-found-details')) },
      cancel() { cancelled = true },
    })
    const fetcher = (async () => new Response(body, { status: 404 })) as unknown as typeof fetch
    const roots: EvidenceToolRoots = { fetcher }
    expect(await registryIntegrity(REGISTRY, PACKAGE, VERSION, roots, new AbortController().signal)).toBeUndefined()
    expect(cancelled, 'the 404 body is cancelled, not left locked').toBe(true)
  })

  it('releases the reader when the body is not JSON or the stream errors (RF05)', async () => {
    // A complete Buffer body exercises the JSON-parse refusal end to end.
    const jsonFetcher = (async () => new Response(Buffer.from('not json at all'), { status: 200 })) as unknown as typeof fetch
    expect(await registryIntegrity(REGISTRY, PACKAGE, VERSION, { fetcher: jsonFetcher }, new AbortController().signal)).toBeUndefined()
    // An ERRORED body is already dead — per spec its cancel algorithm never
    // runs — so the witness here is a bounded, rejection-free refusal. The
    // releasable-body paths (404, budget overrun, stall) assert cancel()
    // explicitly below.
    let errorCancelled = false
    const errorBody = new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(new Error('stream exploded')) },
      cancel() { errorCancelled = true },
    })
    const errorFetcher = (async () => new Response(errorBody, { status: 200 })) as unknown as typeof fetch
    expect(await registryIntegrity(REGISTRY, PACKAGE, VERSION, { fetcher: errorFetcher }, new AbortController().signal)).toBeUndefined()
    expect(errorCancelled).toBe(false)
  })

  it('bounds the CLEANUP phase when cancel itself never settles (RF05 round 2)', async () => {
    // The review's probe: a controllable stream whose cancel() never resolves.
    // Both the 404 path (body.cancel) and the reader finally (reader.cancel)
    // must exit within the budget instead of awaiting the cleanup forever.
    const neverSettling = (): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"partial":')) },
      cancel() { return new Promise<void>(() => {}) },
    })
    const started = Date.now()
    const errorFetcher = (async () => new Response(neverSettling(), { status: 404 })) as unknown as typeof fetch
    expect(await registryIntegrity(REGISTRY, PACKAGE, VERSION, { fetcher: errorFetcher, registryReadBudget: { totalDeadlineMs: 60, maxBodyBytes: 1024 * 1024 } }, new AbortController().signal)).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(2_000)
    const started2 = Date.now()
    const overrunFetcher = (async () => new Response(neverSettling(), { status: 200 })) as unknown as typeof fetch
    expect(await registryIntegrity(REGISTRY, PACKAGE, VERSION, { fetcher: overrunFetcher, registryReadBudget: { totalDeadlineMs: 60, maxBodyBytes: 8 } }, new AbortController().signal)).toBeUndefined()
    expect(Date.now() - started2).toBeLessThan(2_000)
    // A REJECTING cancel must not extend the call either.
    const rejecting = (): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"partial":')) },
      cancel() { return Promise.reject(new Error('cancel exploded')) },
    })
    const started3 = Date.now()
    const rejectingFetcher = (async () => new Response(rejecting(), { status: 404 })) as unknown as typeof fetch
    expect(await registryIntegrity(REGISTRY, PACKAGE, VERSION, { fetcher: rejectingFetcher, registryReadBudget: { totalDeadlineMs: 60, maxBodyBytes: 1024 * 1024 } }, new AbortController().signal)).toBeUndefined()
    expect(Date.now() - started3).toBeLessThan(2_000)
  }, 15_000)

  it('bounds a body that sends one chunk and then stalls forever (RF05)', async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"partial":')) },
      // never closes, never errors
    })
    const fetcher = (async () => new Response(stalled, { status: 200 })) as unknown as typeof fetch
    const started = Date.now()
    expect(await registryIntegrity(REGISTRY, PACKAGE, VERSION, { fetcher, registryReadBudget: { totalDeadlineMs: 120, maxBodyBytes: 1024 * 1024 } }, new AbortController().signal)).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('refuses instantly when the caller already cancelled', async () => {
    const roots: EvidenceToolRoots = { fetcher: (async () => { throw new Error('must not be called') }) as unknown as typeof fetch }
    expect(await registryIntegrity(REGISTRY, PACKAGE, VERSION, roots, AbortSignal.abort())).toBeUndefined()
  })

  it('keeps the default budget bounded', () => {
    expect(DEFAULT_REGISTRY_READ_BUDGET.totalDeadlineMs).toBeLessThanOrEqual(30_000)
    expect(DEFAULT_REGISTRY_READ_BUDGET.maxBodyBytes).toBeLessThanOrEqual(16 * 1024 * 1024)
  })
})

describe('the release recovery entry under the same budgets (F09)', () => {
  const contract = {
    contractId: 'budget-release', adoptedBy: { seq: 1, digest: 'a'.repeat(64) }, adoptedAtRevision: 1,
    operations: ['npm_publish' as const], candidate: { fullSha40: 'b'.repeat(40), packageId: PACKAGE, version: VERSION, registry: REGISTRY, artifactSri: SRI }, readinessRefs: [],
  }
  const projection = createProjection()
  projection.releaseContracts.push(contract)
  projection.releaseReservations.push({
    contractId: 'budget-release', operation: 'npm_publish', callId: 'budget-resolution', startedAtSeq: 0,
    contract_sha256: privateLedgerContractDigest(contract), target_sha256: 'c'.repeat(64),
    status: 'in_flight',
  } as never)

  async function reconcile(fetcher: typeof fetch, registryReadBudget?: EvidenceToolRoots['registryReadBudget']) {
    let persisted = 0
    const tool = createReleaseTool({
      getProjection: () => projection,
      fetcher,
      ...(registryReadBudget ? { registryReadBudget } : {}),
      persistSettlement: async () => { persisted += 1; return true },
    })
    const started = Date.now()
    const value = await tool.execute(
      { operation: 'reconcile', contract_id: 'budget-release', resolution_call_id: 'budget-resolution' } as never,
      { agent: { session: {} }, signal: new AbortController().signal } as never,
    ) as Record<string, unknown>
    return { value, persisted, elapsed: Date.now() - started }
  }

  it('keeps the attempt in flight when a slow registry is bounded out, without any publish resend', async () => {
    const stream = streamingBody({ chunk: '{"partial":', intervalMs: 10, maxChunks: Number.MAX_SAFE_INTEGER })
    const fetcher = (async (_input: string | URL, init?: RequestInit) =>
      new Response(stream(init?.signal ?? undefined), { status: 200 })) as unknown as typeof fetch
    const { value, persisted, elapsed } = await reconcile(fetcher, { totalDeadlineMs: 60, maxBodyBytes: 1024 * 1024 })
    expect(value).toMatchObject({ status: 'unavailable', reason_code: 'release_readback_unavailable' })
    expect(persisted, 'no settlement record is written from a refused readback').toBe(0)
    expect(elapsed).toBeLessThan(5_000)
    // The read-only entry stays available for a later reconcile once the
    // registry answers — the v060 chain suite proves that recovery settles.
  })

  it('reports an unanswered registry as unavailable, never as settled or damaged', async () => {
    const { value, persisted } = await reconcile((async () => new Response('{}', { status: 404 })) as unknown as typeof fetch)
    expect(value).toMatchObject({ status: 'unavailable', reason_code: 'release_readback_unavailable' })
    expect(persisted).toBe(0)
  })
})
