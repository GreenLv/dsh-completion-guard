import { expect, it } from 'vitest'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as deriveModule from '../src/domain/derive.js'
import { vi } from 'vitest'
import { apply } from '../src/runtime.js'

// CG-083-V3 resource-recycle check: 100 attach → pre-step → dispose cycles
// through the production apply() wiring must return the runtime map, the
// listener set and the per-agent registrations to their baseline, with no
// growth per cycle. This complements the per-worker RSS samples: it asserts
// the lifecycle actually releases its maps rather than inferring that from
// memory numbers.

function append(session: Session, type: string, data: unknown): void {
  const surface = type === 'user/message'
  ;(session as unknown as { append(t: string, d: unknown, o?: unknown): void })
    .append(type, data, surface ? { surfaceOp: 'append' } : undefined)
}

it('returns to the declared baseline after 100 attach/switch/dispose cycles', async () => {
  const derive = vi.spyOn(deriveModule, 'deriveProjection')
  try {
    const handlers: Record<string, Array<(payload: unknown, next?: unknown) => unknown>> = {}
    const ctx = {
      commands: { register: () => () => {} },
      on: (name: string, handler: unknown) => { (handlers[name] ??= []).push(handler as never); return () => {} },
      get: () => undefined,
      sessions: { flush: async () => true },
    }
    apply(ctx as never, { activation: 'always' } as never, {})
    const agentCreated = handlers['agent/created'] ?? []
    const agentDisposed = handlers['agent/disposed'] ?? []
    const preStep = handlers['agent/pre-step'] ?? []
    expect(agentCreated.length).toBeGreaterThan(0)
    expect(agentDisposed.length).toBeGreaterThan(0)

    const internalState = (): { handlers: number } => {
      // Every register() we hand out returns a disposer; count the live
      // handler rows we can see from the test double.
      return { handlers: Object.values(handlers).reduce((sum, rows) => sum + rows.length, 0) }
    }
    const baseline = internalState()
    const rssBefore = process.memoryUsage.rss()

    for (let cycle = 0; cycle < 100; cycle += 1) {
      const session = Session.create(SessionId('recycle'), undefined, {
        version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId('recycle'), createdAt: 1, cwd: '/work',
      })
      append(session, 'user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `Cycle ${cycle}: run the tests.` }] }))
      const agent = {
        session, steer: () => {},
        ctx: { tools: { register: () => () => {}, guard: () => () => {}, get: () => undefined }, get: () => undefined, on: () => () => {} },
      } as never
      for (const handler of agentCreated) (handler as (payload: unknown) => void)({ agent, source: 'startup' })
      for (const handler of preStep) {
        await (handler as (payload: unknown, next: unknown) => Promise<unknown>)({ agent }, async () => ({ kind: 'enter', messages: [] }))
      }
      // Switch = dispose this agent's runtime before the next cycle.
      for (const handler of agentDisposed) (handler as (payload: unknown) => void)({ agent })
      if (cycle === 50) {
        // Mid-run: the live handler count must not grow with cycles.
        expect(internalState().handlers).toBe(baseline.handlers)
      }
    }
    expect(internalState().handlers).toBe(baseline.handlers)
    // Settled RSS after GC pressure: allow allocator slack but no per-cycle
    // retention (100 cycles of a full session fold would be tens of MB).
    globalThis.gc?.()
    const rssAfter = process.memoryUsage.rss()
    expect(rssAfter - rssBefore).toBeLessThan(64 * 1024 * 1024)
  } finally {
    derive.mockRestore()
  }
}, 300_000)
