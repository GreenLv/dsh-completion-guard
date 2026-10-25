import { describe, expect, it } from 'vitest'
import { registryIntegrity, type EvidenceToolRoots } from '../src/tools/evidence.js'

/**
 * RF05 round-3 abort matrix: the reviewer's probe — the 404 response promise
 * fulfilled, the caller aborts before the consumer resumes, the errored
 * body's cancel() rejects — must return undefined WITHIN the budget and must
 * not leak an unhandled AbortError. Each scenario asserts both the return
 * value and a clean rejection ledger.
 */

const REGISTRY = 'https://registry.example.invalid/'
const PKG = 'race-fixture'
const VER = '1.0.0'
const BUDGET = { totalDeadlineMs: 60, maxBodyBytes: 1024 * 1024 }

function textBody(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(text)) },
  })
}

/** Tracks unhandled rejections across one scenario; a clean run has none. */
async function withRejectionLedger(run: () => Promise<unknown>): Promise<{ unhandled: string[]; result: unknown }> {
  const unhandled: string[] = []
  const handler = (reason: unknown) => { unhandled.push(reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason)) }
  process.on('unhandledRejection', handler)
  try {
    const result = await run()
    // Yield a few macro-tasks so late rejections surface.
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 20))
    return { unhandled, result }
  } finally {
    process.off('unhandledRejection', handler)
  }
}

function rootsFor(response: Response | Promise<Response>): EvidenceToolRoots {
  return { fetcher: async () => await response, registryReadBudget: BUDGET }
}

describe('RF05 round-3: abort/delivery race matrix', () => {
  it('reviewer probe: 404 delivered, abort before consumer resume, cancel rejects — no unhandled rejection', async () => {
    // An errored body: once the transport aborts, cancel() rejects with the
    // same AbortError (matching what real transports do).
    const controller = new AbortController()
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode('details')) },
      cancel() { return Promise.reject(new DOMException('transport aborted', 'AbortError')) },
    })
    // Deliver the 404 first; abort on a later microtask boundary.
    const delivered = Promise.resolve(new Response(body, { status: 404 }))
    const response = await delivered
    queueMicrotask(() => controller.abort())
    const { unhandled, result } = await withRejectionLedger(() =>
      registryIntegrity(REGISTRY, PKG, VER, { ...rootsFor(response), registryReadBudget: BUDGET }, controller.signal))
    expect(result).toBeUndefined()
    expect(unhandled, JSON.stringify(unhandled)).toEqual([])
  })

  it('abort after response delivery with a locked reader: reader-cancel rejects are consumed', async () => {
    const controller = new AbortController()
    let cancelCalls = 0
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode('{"partial":')) },
      cancel() { cancelCalls += 1; return Promise.reject(new Error('cancel rejected mid-stream')) },
    })
    const response = await new Response(body, { status: 200 })
    queueMicrotask(() => controller.abort())
    const { unhandled, result } = await withRejectionLedger(async () =>
      await registryIntegrity(REGISTRY, PKG, VER, { fetcher: async () => response, registryReadBudget: BUDGET }, controller.signal))
    expect(result).toBeUndefined()
    expect(cancelCalls).toBeGreaterThan(0)
    expect(unhandled, JSON.stringify(unhandled)).toEqual([])
  })

  it.each([
    ['non-2xx with rejecting cancel', (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(new TextEncoder().encode('details')) },
        cancel() { return Promise.reject(new Error('cancel exploded')) },
      })
      return new Response(body, { status: 404 })
    })()],
    ['overrun with pending cancel', (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(new TextEncoder().encode('x'.repeat(4096))) },
        cancel() { return new Promise<void>(() => {}) },
      })
      return new Response(body, { status: 200 })
    })()],
  ])('%s: bounded exit, no unhandled rejection', async (_label, responsePromise) => {
    const response = await responsePromise
    const started = Date.now()
    const { unhandled, result } = await withRejectionLedger(async () =>
      await registryIntegrity(REGISTRY, PKG, VER, rootsFor(response), new AbortController().signal))
    expect(result).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(unhandled, JSON.stringify(unhandled)).toEqual([])
  }, 15_000)
})
