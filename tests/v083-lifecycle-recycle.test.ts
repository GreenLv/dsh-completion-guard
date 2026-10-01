import { expect, it, vi } from 'vitest'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as deriveModule from '../src/domain/derive.js'
import { apply } from '../src/runtime.js'

// CG-083-V3 (round 3): resource-recycle check with OBSERVABLE disposal. The
// previous version counted only root-ctx handler rows while every per-agent
// disposer was a no-op, so a leak would have been invisible. Here the test
// double issues REAL disposer functions: each agent-level tools.register /
// guard / ctx.on registration increments a live counter and its disposer
// decrements it. After 100 attach/switch/dispose cycles the count must return
// to zero, the runtime must be rebuilt from scratch on re-attach (runtime map
// released), and a deliberately leaking control run must be detected.

function append(session: Session, type: string, data: unknown): void {
  const surface = type === 'user/message'
  ;(session as unknown as { append(t: string, d: unknown, o?: unknown): void })
    .append(type, data, surface ? { surfaceOp: 'append' } : undefined)
}

function buildHarness(): {
  handlers: Record<string, Array<(payload: unknown, next?: unknown) => unknown>>
  live: () => number
  leakNext: () => void
  takeDisposer: () => () => void
} {
  const handlers: Record<string, Array<(payload: unknown, next?: unknown) => unknown>> = {}
  let liveCount = 0
  let issued = 0
  let brokenAt = -1
  return {
    handlers,
    live: () => liveCount,
    leakNext: () => { brokenAt = issued + 1 },
    takeDisposer: (): (() => void) => {
      issued += 1
      const mine = issued
      liveCount += 1
      return () => {
        if (mine !== brokenAt && liveCount > 0) liveCount -= 1
      }
    },
  }
}

function setupApply(harness: ReturnType<typeof buildHarness>) {
  const ctx = {
    commands: { register: () => () => {} },
    on: (name: string, handler: unknown) => { (harness.handlers[name] ??= []).push(handler as never); return () => {} },
    get: () => undefined,
    sessions: { flush: async () => true },
  }
  apply(ctx as never, { activation: 'always' } as never, {})
  return harness.handlers
}

it('per-agent registrations return to zero after 100 attach/switch/dispose cycles', async () => {
  const derive = vi.spyOn(deriveModule, 'deriveProjection')
  try {
    const harness = buildHarness()
    const handlers = setupApply(harness)
    const agentCreated = handlers['agent/created'] ?? []
    const agentDisposed = handlers['agent/disposed'] ?? []
    const preStep = handlers['agent/pre-step'] ?? []

    const runCycle = async (cycle: number): Promise<{ agent: unknown }> => {
      const session = Session.create(SessionId('recycle'), undefined, {
        version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId('recycle'), createdAt: 1, cwd: '/work',
      })
      append(session, 'user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `Cycle ${cycle}: run the tests.` }] }))
      const agent = {
        session, steer: () => {},
        ctx: {
          tools: {
            register: () => harness.takeDisposer(),
            guard: () => harness.takeDisposer(),
            get: () => undefined,
          },
          get: () => undefined,
          on: () => harness.takeDisposer(),
        },
      } as never
      for (const handler of agentCreated) (handler as (payload: unknown) => void)({ agent, source: 'startup' })
      for (const handler of preStep) {
        await (handler as (payload: unknown, next: unknown) => Promise<unknown>)({ agent }, async () => ({ kind: 'enter', messages: [] }))
      }
      return { agent }
    }

    for (let cycle = 0; cycle < 100; cycle += 1) {
      const { agent } = await runCycle(cycle)
      for (const handler of agentDisposed) (handler as (payload: unknown) => void)({ agent })
      if (cycle % 25 === 0) expect(harness.live(), `cycle ${cycle}`).toBe(0)
    }
    expect(harness.live(), 'all per-agent registrations released after 100 cycles').toBe(0)

    // Runtime-map release: re-attaching the SAME agent object must rebuild
    // from scratch (a fresh derive), proving the cached runtime was dropped.
    const { agent: lastAgent } = await runCycle(100)
    const deriveAfter = derive.mock.calls.length
    for (const handler of agentDisposed) (handler as (payload: unknown) => void)({ agent: lastAgent })
    for (const handler of agentCreated) (handler as (payload: unknown) => void)({ agent: lastAgent, source: 'startup' })
    expect(derive.mock.calls.length, 're-attach after dispose rebuilds the runtime').toBeGreaterThan(deriveAfter)
    for (const handler of agentDisposed) (handler as (payload: unknown) => void)({ agent: lastAgent })
    expect(harness.live()).toBe(0)

    // Sensitivity: when a disposer is sabotaged into a leak, the counter MUST
    // expose it (this is what makes the zero assertions above meaningful).
    const leakHarness = buildHarness()
    const leakHandlers = setupApply(leakHarness)
    const leakSession = Session.create(SessionId('recycle'), undefined, {
      version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId('recycle'), createdAt: 1, cwd: '/work',
    })
    const leakAgent = {
      session: leakSession, steer: () => {},
      ctx: {
        tools: { register: () => leakHarness.takeDisposer(), guard: () => leakHarness.takeDisposer(), get: () => undefined },
        get: () => undefined,
        on: () => leakHarness.takeDisposer(),
      },
    } as never
    leakHarness.leakNext()
    for (const handler of leakHandlers['agent/created'] ?? []) (handler as (payload: unknown) => void)({ agent: leakAgent, source: 'startup' })
    const leakedBefore = leakHarness.live()
    for (const handler of leakHandlers['agent/disposed'] ?? []) (handler as (payload: unknown) => void)({ agent: leakAgent })
    expect(leakedBefore, 'harness counted real registrations').toBeGreaterThan(0)
    expect(leakHarness.live(), 'sabotaged disposer detected as a leak').toBeGreaterThan(0)
  } finally {
    derive.mockRestore()
  }
}, 300_000)
