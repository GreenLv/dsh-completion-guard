import { expect, it, vi } from 'vitest'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import * as deriveModule from '../src/domain/derive.js'
import { apply } from '../src/runtime.js'
import type { Agent } from '@deepseek-ai/dsh-agent'

// CG-083-PERF01/PERF04 production-path count locks:
//  - one attach performs at most ONE full projection of the log;
//  - an unchanged session sync replays no history fold;
//  - an ordinary shell call that cannot possibly produce a workdir receipt
//    performs ZERO full host audits; only a call that may produce one (a
//    foreground root `npm test` / `pnpm test`) pays for the fresh path.

function append(session: Session, type: string, data: unknown): void {
  const surface = type === 'user/message' || type === 'tool/result'
  ;(session as unknown as { append(type: string, data: unknown, options?: unknown): void })
    .append(type, data, surface ? { surfaceOp: 'append' } : undefined)
}

function harness() {
  const validations: number[] = []
  const handlers: Record<string, Array<(payload: unknown, next?: unknown) => unknown>> = {}
  const ctx = {
    commands: { register: () => () => {} },
    on: (name: string, handler: unknown) => { (handlers[name] ??= []).push(handler as never); return () => {} },
    get: () => undefined,
    sessions: { flush: async () => true },
  }
  apply(ctx as never, { activation: 'always' } as never, {
    // No hostLock seam: the migration revalidation is cheap and unavailable,
    // which keeps onHostLockValidation observable for every fresh validation
    // the passive observer performs.
    onHostLockValidation: () => { validations.push(1) },
  })
  return { handlers, validations }
}

function agentWith(session: Session, agentHandlers: Record<string, Array<(payload: unknown, next?: unknown) => unknown>> = {}): Agent {
  return {
    session,
    steer: () => {},
    ctx: {
      tools: { register: () => () => {}, guard: () => () => {}, get: () => undefined },
      get: () => undefined,
      on: (name: string, handler: unknown) => { (agentHandlers[name] ??= []).push(handler as never); return () => {} },
    },
  } as unknown as Agent
}

it('attaches with one projection and replays none for an unchanged session', async () => {
  const session = Session.create(SessionId('perf-counts'), undefined, {
    version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId('perf-counts'), createdAt: 1, cwd: '/work',
  })
  append(session, 'user/message', createUserMessage({ content: [{ type: 'text', text: 'Run the tests.' }], source: { kind: 'user' } }))
  append(session, 'tool/call', { turn: 1, step: 2, callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) })
  append(session, 'tool/result', { turn: 1, step: 2, message: createToolResultMessage({ callId: 'c1' as never, content: [{ type: 'text', text: 'ok' }], isError: false }) })

  const derive = vi.spyOn(deriveModule, 'deriveProjection')
  try {
    const { handlers } = harness()
    const agent = agentWith(session)
    const attach = () => {
      for (const handler of handlers['agent/created'] ?? []) (handler as (payload: unknown) => void)({ agent, source: 'startup' })
    }
    attach()
    // CG-083-PERF01: exactly one derive for the whole attach.
    expect(derive.mock.calls.length, 'one attach = one derive').toBe(1)
    // A re-delivered creation of the same agent must not re-derive either.
    attach()
    expect(derive.mock.calls.length, 're-delivered attach = still one derive').toBe(1)
    const preStep = async (): Promise<void> => {
      for (const handler of handlers['agent/pre-step'] ?? []) {
        await (handler as (payload: unknown, next: unknown) => Promise<unknown>)({ agent }, async () => ({ kind: 'enter', messages: [] }))
      }
    }
    // The first pre-step confirms durability (false -> confirmed): a real
    // input change, so the fold re-runs once.
    await preStep()
    expect(derive.mock.calls.length, 'durability confirmation = re-derived once').toBe(2)
    // Unchanged warm sync through the production pre-step: no re-derivation.
    await preStep()
    expect(derive.mock.calls.length, 'unchanged warm sync = still two derives').toBe(2)
    // A new durable event invalidates the fast path.
    append(session, 'user/message', createUserMessage({ content: [{ type: 'text', text: 'Continue.' }], source: { kind: 'user' } }))
    await preStep()
    expect(derive.mock.calls.length, 'new durable event = re-derived').toBe(3)
  } finally {
    derive.mockRestore()
  }
})

it('skips the full host audit for shells that cannot produce a receipt', async () => {
  const session = Session.create(SessionId('perf-counts-shell'), undefined, {
    version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId('perf-counts-shell'), createdAt: 1, cwd: '/work',
  })
  append(session, 'user/message', createUserMessage({ content: [{ type: 'text', text: 'Check the environment.' }], source: { kind: 'user' } }))
  const { handlers, validations } = harness()
  const agentHandlers: Record<string, Array<(payload: unknown, next?: unknown) => unknown>> = {}
  const agent = agentWith(session, agentHandlers)
  for (const handler of handlers['agent/created'] ?? []) (handler as (payload: unknown) => void)({ agent, source: 'startup' })
  const baseline = validations.length
  const preExecute = (agentHandlers['tools/pre-execute'] ?? []).at(-1)!
  const runPre = async (name: string, args: Record<string, unknown>, callId: string) => {
    const exec = {
      callId, rootCallId: callId, name, arguments: args, agent, parent: undefined,
      signal: new AbortController().signal,
    }
    const outcome = await (preExecute as (payload: unknown, next: () => Promise<string>) => Promise<string>)(exec, async () => 'next')
    expect(outcome).toBe('next')
  }
  // An ordinary echo, an echo with an explicit workdir and a background echo:
  // none can ever produce a receipt.
  await runPre('bash', { command: 'echo hello' }, 'echo-1')
  await runPre('bash', { command: 'echo hi', workdir: '/tmp' }, 'echo-2')
  await runPre('bash', { command: 'echo bg', run_in_background: true }, 'echo-3')
  expect(validations.length - baseline, 'ordinary shells: zero full audits').toBe(0)
  // A foreground root `npm test` MAY produce one: it keeps the fresh path.
  await runPre('bash', { command: 'npm test' }, 'test-1')
  expect(validations.length - baseline, 'possible receipt target: fresh audit runs').toBeGreaterThanOrEqual(1)
})
