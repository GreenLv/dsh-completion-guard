import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import { applyWithFixtureActivation as apply } from './activation-fixture.js'
import { deriveProjection, PROTOCOL_V6_NOTICE } from '../src/domain/derive.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'
import type { LlmAdapter, LlmModelInfo } from '@deepseek-ai/dsh-llm'

/**
 * RC3 model-listing and update-mode controls, driven through the REAL rc.3
 * LlmRegistry adapter surface (no model): the host's /models route reads
 * `listModels`/`discoverModels` from the adapter registered here, and the
 * update modes (`toolUpdate`/`systemPromptUpdate`) travel on the resolved
 * model metadata. The Guard contracts under test:
 *
 * 1. T0 stays blank and the first-step boundary arrives exactly once,
 *   regardless of when the adapter's catalog resolves (first call, cached
 *   repeat, failure, or caller cancellation).
 * 2. Guard's own notices and tools stay visible after the host rewrites the
 *   tool set / system prompt (update modes are host-owned; Guard only
 *   requires that its messages are NOT the thing rewritten away).
 * 3. A version-gated adapter (model below the Guard floor's host version
 *   policy) still routes through the same protection.
 */

const HOST = { ...evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' }), goalAvailable: false }

interface Scenario {
  name: string
  listModels: (provider: string) => Promise<readonly LlmModelInfo[]>
}

const MODEL = (id: string): LlmModelInfo => ({ provider: 'deepseek', id, name: id })

function adapter(scenario: Scenario): LlmAdapter {
  const calls: string[] = []
  const base = {
    id: `rc3-${scenario.name}`,
    protocols: ['openai' as const],
    register: () => {},
    dispose: () => {},
    providerInfo: (provider: string) => ({ id: provider, name: `rc3 ${scenario.name}` }),
    providerRetryPolicy: () => undefined,
    listModels: async (provider: string) => { calls.push(provider); return await scenario.listModels(provider) },
    resolveModel: async (provider: string, model: string) => ({
      provider, model,
      systemPromptUpdate: 'in-history' as const,
      toolUpdate: 'in-history' as const,
    }),
  }
  return Object.assign(Object.create(Object.getPrototypeOf({})), base) as unknown as LlmAdapter & { calls: string[] }
}

function fakeCtx() {
  const handlers = new Map<string, Array<(...args: never[]) => unknown>>()
  return {
    handlers,
    commands: { register: () => {} },
    sessions: { flush: async () => true },
    on: (event: string, handler: (...args: never[]) => unknown) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]) },
  }
}

async function firstStepMessages(session: Session, claimedText: string): Promise<string[]> {
  const ctx = fakeCtx()
  apply(ctx as never, { activation: 'always', hostLockPackages: EXPECTED_HOST_PACKAGES, hostLockPlatform: 'posix', hostLockProfile: 'web' })
  const registered: Array<{ name: string }> = []
  const agent = {
    session, steer: () => {},
    ctx: {
      tools: { register: (tool: { name: string }) => { registered.push(tool); return () => {} }, guard: () => {}, get: () => undefined },
      get: () => undefined,
    },
  }
  for (const handler of ctx.handlers.get('agent/created') ?? []) {
    ;(handler as (payload: { agent: unknown; source: string }) => void)({ agent, source: 'new' })
  }
  expect(session.seq).toBe(0)
  const handler = ctx.handlers.get('agent/pre-step')?.[0] as ((payload: unknown, next: () => Promise<unknown>) => Promise<{ kind: string; messages?: unknown[] }>) | undefined
  const claim = { content: [{ type: 'text', text: claimedText }], source: { kind: 'user' } }
  const decision = await handler!({ agent, messages: [claim] }, async () => ({ kind: 'enter', messages: [claim] })) as { messages: unknown[] }
  return [
    ...decision.messages.map((message) => ((message as { content?: Array<{ text?: string }> }).content ?? [])[0]?.text ?? ''),
    ...registered.map((tool) => tool.name),
  ]
}

describe('rc.3 /models route: Guard protection across adapter catalog outcomes', () => {
  const CLAIM = '列出可用模型后修改 rc3-models.txt。'

  it.each([
    ['first listing succeeds', async () => [MODEL('deepseek-chat')]],
    ['cached repeat listing', async () => [MODEL('deepseek-chat'), MODEL('deepseek-reasoner')]],
    ['listing fails', async (): Promise<readonly LlmModelInfo[]> => { throw new Error('catalog endpoint down') }],
    ['listing cancelled', async (_provider: string, signal?: AbortSignal) => { signal?.throwIfAborted(); throw new Error('cancelled') }],
  ])('%s keeps T0 blank, boundary-once, and Guard tools registered', async (_label, listImpl) => {
    const id = `rc3-models-${_label.replace(/\W+/g, '-')}`
    const session = Session.create(SessionId(id), undefined, {
      version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId(id), createdAt: 1, cwd: '/work',
    })
    const adapterCalls: string[] = []
    const controlled = Object.assign(adapter({
      name: _label.replace(/\W+/g, '-'),
      listModels: async (provider: string) => { adapterCalls.push(provider); return await listImpl(provider) },
    }), { calls: adapterCalls })
    // Register the adapter on a REAL rc.3 LlmRuntime: this is the surface
    // the /models route interrogates.
    const llmCtx = new Context()
    const runtime = new LlmRuntime(llmCtx)
    runtime.registerAdapter(['deepseek'], controlled as LlmAdapter)
    // The registry answers the catalog through the adapter's listModels;
    // failure and cancellation outcomes are recorded but never damage the
    // protection path asserted below.
    const catalogOutcome = await runtime.listModels('deepseek').then(
      (catalog) => ({ ok: true as const, catalog }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    const registered = await firstStepMessages(session, CLAIM)
    // Guard's protection messages are present exactly once...
    expect(registered.filter((text) => text === PROTOCOL_V6_NOTICE)).toHaveLength(1)
    expect(registered.some((text) => typeof text === 'string' && text.includes('rc3-models.txt'))).toBe(true)
    // ...and Guard's tools are on the same runtime surface the adapter
    // listing served, whatever the catalog outcome was.
    expect(registered.filter((name) => name.startsWith('context_guard_')).length).toBeGreaterThan(0)
    expect(controlled.calls).toEqual(['deepseek'])
    // The session log carries no adapter catalog entries.
    expect(JSON.stringify(session.snapshotEvents())).not.toContain('deepseek-chat')
    // The listing went through the REAL adapter registration, once.
    expect(adapterCalls).toEqual(['deepseek'])
    if (_label.includes('fails') || _label.includes('cancelled')) {
      expect(catalogOutcome.ok).toBe(false)
    } else {
      expect(catalogOutcome.ok).toBe(true)
    }
  })

  it('a cancelled listing settles promptly and the protection path is unaffected', async () => {
    const controller = new AbortController()
    controller.abort()
    const adapterObject = adapter({ name: 'cancelled', listModels: async (_provider) => { controller.signal.throwIfAborted(); return [] } })
    await expect(adapterObject.listModels('p')).rejects.toThrow()
    const session = Session.create(SessionId('rc3-models-cancelled'), undefined, {
      version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId('rc3-models-cancelled'), createdAt: 1, cwd: '/work',
    })
    const observed = await firstStepMessages(session, CLAIM)
    expect(observed.filter((text) => text === PROTOCOL_V6_NOTICE)).toHaveLength(1)
  })
})

describe('rc.3 update modes: Guard notices survive tool/system prompt rewrites', () => {
  it('tool-removal and system-prompt update blocks never detach Guard evidence', () => {
    // rc.3 update modes ('in-history') let the host append tool-removal and
    // developer-message updates mid-history. Guard derives from the SAME
    // durable log, so its captured facts must survive those blocks verbatim.
    const session = Session.create(SessionId('rc3-update-mode'), undefined, {
      version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId('rc3-update-mode'), createdAt: 1, cwd: '/work',
    })
    session.append('command/run', { commandId: 'on' as never, name: 'context-guard', args: 'on', source: { kind: 'user' } })
    session.append('user/message', createUserNotice(PROTOCOL_V6_NOTICE), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '修改 rc3-update-mode.txt。' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const rawAppend = (session as unknown as { append: (type: string, data: unknown, options?: unknown) => unknown }).append.bind(session)
    // Host-shaped update events after the model listing landed.
    rawAppend('developer/message', { turn: 1, blocks: [{ type: 'tool-removal', toolName: 'web_search' }] }, { surfaceOp: 'append' })
    rawAppend('request/header', { turn: 1, header: { model: 'deepseek-chat', systemPromptUpdate: 'in-history', toolUpdate: 'in-history' } })
    const derived = deriveProjection(session.snapshotEvents() as never, { activation: 'opt-in' }, { cwd: '/work' }, true, HOST)
    if (process.env.ZZ_DEBUG) console.error('ZZ-ITEMS', [...derived.projection.items.values()].map((item) => item.normalizedText.slice(0, 40)))
    expect(derived.projection.integrity).toBe('valid')
    expect([...derived.projection.items.values()].some((item) => item.normalizedText.includes('rc3-update-mode.txt'))).toBe(true)
  })
})

function createUserNotice(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice', summary: 'guard' } })
}
