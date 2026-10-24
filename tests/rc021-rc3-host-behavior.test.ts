import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { applyWithFixtureActivation as apply } from './activation-fixture.js'
import { deriveProjection, PROTOCOL_V6_NOTICE } from '../src/domain/derive.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'
import { ACTIVE_HOST_COHORT_IDS } from '../src/domain/host-lock.js'

/**
 * rc.3 host behavior controls, exercised through the real rc.3 SDK with no
 * model. The host's new navigation/draft/model-listing features change WHAT
 * the host may claim or update between steps; Guard's contracts are that T0
 * stays silent, first protection arrives exactly once, and protection notices
 * and Guard tools survive tool/system-prompt updates. Where a feature is
 * host-application-internal (the composer draft itself, the /models HTTP
 * route), the control exercises the observable session/runtime surface the
 * feature feeds instead of pretending to drive the UI.
 */

const HOST = { ...evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' }), goalAvailable: false }

function fakeCtx() {
  const handlers = new Map<string, Array<(...args: never[]) => unknown>>()
  return {
    handlers,
    commands: { register: () => {} },
    sessions: { flush: async () => true },
    on: (event: string, handler: (...args: never[]) => unknown) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]) },
  }
}

function guardedAgent(session: Session) {
  const registered: Array<{ name: string }> = []
  const agent = {
    session, steer: () => {},
    ctx: {
      tools: { register: (tool: { name: string }) => { registered.push(tool); return () => {} }, guard: () => {}, get: () => undefined },
      get: () => undefined,
    },
  }
  return { registered, agent: agent as unknown as Agent }
}

function startGuard(ctx: ReturnType<typeof fakeCtx>, agent: Agent, source = 'new'): void {
  for (const handler of ctx.handlers.get('agent/created') ?? []) {
    ;(handler as (payload: { agent: Agent; source: string }) => void)({ agent, source })
  }
}

async function preStep(ctx: ReturnType<typeof fakeCtx>, agent: Agent, messages: unknown[]) {
  const handler = ctx.handlers.get('agent/pre-step')?.[0] as ((payload: unknown, next: () => Promise<unknown>) => Promise<{ kind: string; messages?: unknown[] }>) | undefined
  return await handler!({ agent, messages }, async () => ({ kind: 'enter', messages })) as { kind: string; messages: unknown[] }
}

function guardApply(ctx: ReturnType<typeof fakeCtx>) {
  apply(ctx as never, { activation: 'always', hostLockPackages: EXPECTED_HOST_PACKAGES, hostLockPlatform: 'posix', hostLockProfile: 'web' })
}

describe('rc.3 T0/first-activation across preset and draft-reuse shapes', () => {
  const headers = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId(id), createdAt: 1, cwd: '/work', ...extra,
  })
  const claim = () => createUserMessage({ content: [{ type: 'text', text: '修改 rc3-demo.txt 并汇报。' }], source: { kind: 'user' } })

  it.each([
    ['plain new session', {}],
    ['agentPreset session (Creator-style preset header)', { agentPreset: 'creator' }],
    ['research preset session', { agentPreset: 'research' }],
  ])('%s keeps T0 silent and injects the boundary exactly once', async (_label, extra) => {
    const id = `rc3-t0-${Object.values(extra).join('-') || 'plain'}`
    const session = Session.create(SessionId(id), undefined, headers(id, extra) as never)
    const ctx = fakeCtx()
    guardApply(ctx)
    const { registered, agent } = guardedAgent(session)
    // T0: nothing persisted.
    expect(session.seq).toBe(0)
    expect(session.snapshotEvents()).toHaveLength(0)
    startGuard(ctx, agent)
    expect(session.seq).toBe(0)
    // The first REAL claimed input gets boundary + guidance exactly once,
    // regardless of which preset the host used to create the session.
    const decision = await preStep(ctx, agent, [claim()])
    const texts = decision.messages.map((message) => ((message as { content?: Array<{ text?: string }> }).content ?? [])[0]?.text)
    expect(texts.filter((text) => text === PROTOCOL_V6_NOTICE)).toHaveLength(1)
    expect(texts[texts.length - 1]).toContain('rc3-demo.txt')
    // Guard's tool surface registered on the rc.3 SDK.
    expect(registered.map((tool) => tool.name)).toContain('context_guard_checkpoint')
  })

  it('draft-reuse-shaped sessions (same preset, fresh id) do not share activation state', async () => {
    // The host may prefill a new session's composer from an unsent draft of
    // another session. Whatever arrives as the first claimed batch, each new
    // session binds its own activation and never inherits another's.
    const ctx = fakeCtx()
    guardApply(ctx)
    const first = Session.create(SessionId('rc3-draft-a'), undefined, headers('rc3-draft-a', { agentPreset: 'creator' }) as never)
    const second = Session.create(SessionId('rc3-draft-b'), undefined, headers('rc3-draft-b', { agentPreset: 'creator' }) as never)
    const a = guardedAgent(first)
    const b = guardedAgent(second)
    startGuard(ctx, a.agent)
    startGuard(ctx, b.agent)
    const sharedDraftText = '继续上一会话未发送的草稿内容'
    const claim = createUserMessage({ content: [{ type: 'text', text: sharedDraftText }], source: { kind: 'user' } })
    // The host persists each entered step (claims then injections).
    const persist = async (agent: Agent, session: Session) => {
      const decision = await preStep(ctx, agent, [claim])
      const raw = (session as unknown as { append: (type: string, data: unknown, options?: unknown) => unknown }).append.bind(session)
      raw('turn/start', { turn: 1 })
      for (const message of decision.messages) raw('user/message', message, { surfaceOp: 'append' })
      raw('step/start', { turn: 1, step: 1 })
      raw('step/end', { turn: 1, step: 1 })
      raw('turn/end', { turn: 1, reason: { kind: 'completed' } })
    }
    await persist(a.agent, first)
    await persist(b.agent, second)
    const boundaries = (session: Session) => session.snapshotEvents()
      .filter((event) => (event as { data?: { content?: Array<{ text?: string }> } }).data?.content?.[0]?.text === PROTOCOL_V6_NOTICE)
    expect(boundaries(first)).toHaveLength(1)
    expect(boundaries(second)).toHaveLength(1)
  })

  it('host tool/system-prompt update events do not disturb the projection', () => {
    // rc.3's model listing can rewrite tool and system-prompt capabilities.
    // Whatever update events the host appends, Guard derives no obligations,
    // no evidence and no integrity violations from them.
    const session = Session.create(SessionId('rc3-toolupdate'), undefined, headers('rc3-toolupdate') as never)
    session.append('command/run', { commandId: 'on' as never, name: 'context-guard', args: 'on', source: { kind: 'user' } })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Context Guard protocol boundary: v6.0.0' }], source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice', summary: 'v6' } }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '修改 rc3-update.txt。' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const rawAppend = (session as unknown as { append: (type: string, data: unknown, options?: unknown) => unknown }).append.bind(session)
    rawAppend('request/header', { turn: 1, header: { model: 'deepseek-chat', toolsUpdated: true } })
    rawAppend('assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '（模型列表已更新）' }] } }, { surfaceOp: 'append' })
    const derived = deriveProjection(session.snapshotEvents() as never, { activation: 'opt-in' }, { cwd: '/work' }, true, HOST)
    expect(derived.projection.integrity).toBe('valid')
    expect([...derived.projection.items.values()].filter((item) => item.normalizedText.includes('模型列表已更新'))).toHaveLength(0)
    expect([...derived.projection.items.values()].some((item) => item.normalizedText.includes('rc3-update.txt'))).toBe(true)
  })
})

describe('rc.3 Guard tool surface survives host updates', () => {
  it('persisted Guard notices survive snapshot round trips verbatim', () => {
    // The system prompt is host-owned; the Guard-observable contract is that
    // the notice text injected into the session log is not mutated by a
    // snapshot/re-render round trip on the rc.3 SDK.
    const session = Session.create(SessionId('rc3-sysprompt'), undefined, { version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId('rc3-sysprompt'), createdAt: 1, cwd: '/work' } as never)
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }], source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice', summary: 'v6' } }), { surfaceOp: 'append' })
    const persisted = (session.snapshotEvents()[0] as { data?: { content?: Array<{ text?: string }> } }).data?.content?.[0]?.text
    expect(persisted).toBe(PROTOCOL_V6_NOTICE)
    // The rc.3 SystemPrompt still constructs on the shared ctx.
    const ctx = new Context()
    expect(new SystemPrompt(ctx, {})).toBeInstanceOf(SystemPrompt)
  })
})

describe('rc.3 cohort advertisement', () => {
  it('the runtime advertises both active cohorts with the rc.2 baseline first', () => {
    expect(ACTIVE_HOST_COHORT_IDS).toEqual(['dsh-0.2.1-rc.2', 'dsh-0.2.1-rc.3'])
  })
})
