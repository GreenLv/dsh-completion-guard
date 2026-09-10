import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply } from '../src/runtime.js'
import { deriveProjection, PROTOCOL_V3_NOTICE, PROTOCOL_V4_NOTICE } from '../src/domain/derive.js'
import { certifyCheckpoint } from '../src/domain/checkpoint.js'
import { FIRST_STEP_GUIDANCE } from '../src/domain/lifecycle.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'

// The audited rc.1 active cohort is the test lock (0.5.0 support policy).
const TEST_HOST_ROWS = EXPECTED_HOST_PACKAGES
const TEST_HOST_LOCK = evaluateHostLock(TEST_HOST_ROWS, { platform: 'posix', profileKind: 'web' })

interface CheckpointTool { name: string; execute: (args: unknown, exec?: unknown) => Promise<unknown> }
type PreStepHandler = (payload: unknown, next: () => Promise<unknown>) => Promise<{ kind: string; messages?: unknown[] }>

function fakeCtx() {
  const handlers = new Map<string, Array<(...args: never[]) => unknown>>()
  return {
    handlers,
    commands: { register: () => {} },
    sessions: { flush: async () => true },
    on: (event: string, handler: (...args: never[]) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
    },
  }
}

const PINNED_UPDATE_GOAL_TOOL = {
  name: 'update_goal',
  execute: () => undefined,
  parameters: {
    type: 'object',
    required: ['goal_id', 'revision', 'action'],
    properties: {
      goal_id: { type: 'string' },
      revision: { type: 'number' },
      action: { type: 'string', enum: ['edit', 'pause', 'resume', 'complete', 'blocked'] },
      objective: { type: 'string' },
      max_goal_rounds: { type: 'number' },
      blocked_reason: { type: 'string' },
    },
  },
}

function guardedAgent(session: Session) {
  const registered: CheckpointTool[] = []
  const agent = {
    session,
    steer: () => {},
    ctx: {
      tools: {
        register: (tool: CheckpointTool) => registered.push(tool),
        guard: () => {},
        get: (name: string) => (name === 'update_goal' ? PINNED_UPDATE_GOAL_TOOL : undefined),
      },
      get: (name: string) => (name === 'goals' ? { get: () => undefined, disarm: async () => undefined } : undefined),
    },
  }
  return { agent: agent as unknown as Agent, registered }
}

function startGuard(ctx: ReturnType<typeof fakeCtx>, agent: Agent, source: string) {
  for (const handler of ctx.handlers.get('agent/session-start') ?? []) {
    ;(handler as (payload: { agent: Agent; source: string }) => void)({ agent, source })
  }
}

async function runPreStep(
  ctx: ReturnType<typeof fakeCtx>,
  agent: Agent,
  claimed: unknown[] = [],
  next?: () => Promise<unknown>,
): Promise<{ kind: string; messages: unknown[] }> {
  const handler = ctx.handlers.get('agent/pre-step')?.[0] as PreStepHandler | undefined
  const decision = await handler!({ agent, messages: claimed }, next ?? (async () => ({ kind: 'enter', messages: claimed }))) as { kind: string; messages: unknown[] }
  return { kind: decision.kind, messages: decision.messages ?? [] }
}

function rawAppend(session: Session): (type: string, data: unknown, opts?: unknown) => unknown {
  return (session as unknown as { append: (type: string, data: unknown, opts?: unknown) => unknown }).append.bind(session)
}

function enableCommand(session: Session, subcommand = 'on') {
  rawAppend(session)('command/run', { commandId: `cmd-${session.seq}`, name: 'context-guard', args: subcommand, source: { kind: 'user' } })
}

function userText(session: Session, text: string) {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

/** Guard plugin-notice events among the durable log. */
function guardNotices(session: Session): unknown[] {
  return session.snapshotEvents().filter((event) => {
    const data = (event as { type?: unknown; data?: unknown }).data as { source?: { kind?: unknown; plugin?: unknown } } | undefined
    return (event as { type?: unknown }).type === 'user/message' && data?.source?.kind === 'plugin' && data?.source?.plugin === 'context-guard'
  })
}

/** Simulate the host loop persisting one entered step (claims then notices). */
function persistStep(session: Session, messages: unknown[]) {
  const turn = 1 + [...session.snapshotEvents()].filter((event) => (event as { type?: unknown }).type === 'turn/start').length
  rawAppend(session)('turn/start', { turn })
  for (const message of messages) {
    rawAppend(session)('user/message', message, { surfaceOp: 'append' })
  }
  rawAppend(session)('step/start', { turn, step: 1 })
  rawAppend(session)('step/end', { turn, step: 1 })
  rawAppend(session)('turn/end', { turn, reason: { kind: 'completed' } })
}

function guardApply(ctx: ReturnType<typeof fakeCtx>, activation: 'opt-in' | 'always') {
  apply(ctx as never, {
    activation, hostLockPackages: TEST_HOST_ROWS, hostLockPlatform: 'posix', hostLockProfile: 'web',
  })
}

describe('A01: fresh empty sessions stay silent at T0', () => {
  for (const activation of ['always', 'opt-in'] as const) {
    it(`${activation}: session-start, status, and refresh append nothing and keep the session blank`, () => {
      const session = Session.create(SessionId(`a01-${activation}`))
      const ctx = fakeCtx()
      guardApply(ctx, activation)
      const { agent } = guardedAgent(session)
      const before = session.seq
      startGuard(ctx, agent, 'new')
      startGuard(ctx, agent, 'new')
      // Model request count is derived from durable events: none exist.
      expect(session.snapshotEvents().some((event) => (event as { type?: unknown }).type === 'step/start')).toBe(false)
      expect(guardNotices(session)).toHaveLength(0)
      expect(session.seq).toBe(before)

      // An empty claimed batch (status query path) injects nothing either.
      const { agent: agent2 } = guardedAgent(session)
      startGuard(ctx, agent2, 'new')
      expect(guardNotices(session)).toHaveLength(0)

      // Web readback contract: seq 0 means blank for the cold session-list
      // fallback, and no turn/start means the server-side preset stays
      // switchable. Guard wrote nothing, so both hold.
      expect(session.seq).toBe(0)
    })
  }

  it('always: the first real claimed input activates with boundary-first delivery exactly once', async () => {
    const session = Session.create(SessionId('a01-activation'))
    const ctx = fakeCtx()
    guardApply(ctx, 'always')
    const { agent } = guardedAgent(session)
    startGuard(ctx, agent, 'new')

    const claimed = createUserMessage({ content: [{ type: 'text', text: '修改 guard-demo.txt 并汇报结果。' }], source: { kind: 'user' } })
    const decision = await runPreStep(ctx, agent, [claimed])
    expect(decision.kind).toBe('enter')
    // Boundary and guidance precede the root message inside the same batch.
    expect(decision.messages).toHaveLength(3)
    const texts = decision.messages.map((message) => {
      const data = (message as { content?: Array<{ text?: string }> }).content ?? []
      return data[0]?.text
    })
    expect(texts[0]).toBe(PROTOCOL_V4_NOTICE)
    expect(texts[1]).toBe(FIRST_STEP_GUIDANCE)
    expect(texts[2]).toContain('guard-demo.txt')

    // Persisting the step makes the boundary durable ahead of the root input.
    persistStep(session, decision.messages)
    const derived = deriveProjection(session.snapshotEvents() as never, { activation: 'always' }, { cwd: '/work' }, true, TEST_HOST_LOCK)
    expect(derived.protocolV4Present).toBe(true)
    expect(derived.realRootInputSeen).toBe(true)
    expect([...derived.projection.items.values()].some((item) => item.normalizedText.includes('guard-demo.txt'))).toBe(true)

    // The next step never injects a second boundary; the revision-change
    // reminder may flow once, but the v4 cut happens exactly once.
    const again = await runPreStep(ctx, agent, [createUserMessage({ content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } })])
    expect(again.messages.filter((message) => ((message as { content?: Array<{ text?: string }> }).content ?? [])[0]?.text === PROTOCOL_V4_NOTICE)).toHaveLength(0)
  })
})

describe('A02: first real input is covered exactly once, including asset-only input', () => {
  it('an image-only first input activates protection but creates no empty contract certificate', async () => {
    const session = Session.create(SessionId('a02-image-only'))
    const ctx = fakeCtx()
    guardApply(ctx, 'always')
    const { agent } = guardedAgent(session)
    startGuard(ctx, agent, 'new')

    const imageOnly = createUserMessage({ content: [{ type: 'image', attachment: { id: 'att-1' } } as never], source: { kind: 'user' } })
    const decision = await runPreStep(ctx, agent, [imageOnly])
    expect(decision.messages).toHaveLength(3)
    persistStep(session, decision.messages)

    const derived = deriveProjection(session.snapshotEvents() as never, { activation: 'always' }, { cwd: '/work' }, true, TEST_HOST_LOCK)
    expect(derived.realRootInputSeen).toBe(true)
    expect(derived.projection.items.size).toBe(1)
    expect([...derived.projection.items.values()][0].sourceMessageId).toMatch(/:asset:0$/)
    expect(certifyCheckpoint(derived.projection, [], 'asset-check', false).status).toBe('incomplete')
  })

  it('a whitespace-only message neither activates nor fabricates a task', async () => {
    const session = Session.create(SessionId('a02-whitespace'))
    const ctx = fakeCtx()
    guardApply(ctx, 'always')
    const { agent } = guardedAgent(session)
    startGuard(ctx, agent, 'new')

    const decision = await runPreStep(ctx, agent, [createUserMessage({ content: [{ type: 'text', text: '   \n  ' }], source: { kind: 'user' } })])
    expect(decision.messages).toHaveLength(1)
    const followUp = await runPreStep(ctx, agent, [createUserMessage({ content: [{ type: 'text', text: '修复登录 bug' }], source: { kind: 'user' } })])
    expect(followUp.messages).toHaveLength(3)
  })
})

describe('A03/A04: rejected, canceled, filtered, and non-root batches never activate', () => {
  it('a rejected step injects nothing and the next legal input still activates', async () => {
    const session = Session.create(SessionId('a03-reject'))
    const ctx = fakeCtx()
    guardApply(ctx, 'always')
    const { agent } = guardedAgent(session)
    startGuard(ctx, agent, 'new')

    const claimed = [createUserMessage({ content: [{ type: 'text', text: '修改 a.txt' }], source: { kind: 'user' } })]
    const rejected = await runPreStep(ctx, agent, claimed, async () => ({ kind: 'reject' }))
    expect(rejected.kind).toBe('reject')
    expect(rejected.messages).toHaveLength(0)
    expect(guardNotices(session)).toHaveLength(0)

    const retried = await runPreStep(ctx, agent, claimed)
    expect(retried.messages).toHaveLength(3)
    expect((retried.messages[0] as { content: Array<{ text: string }> }).content[0].text).toBe(PROTOCOL_V4_NOTICE)
  })

  it('plugin, tool, and imported batches do not root-activate; delegated sessions never inject', async () => {
    const session = Session.create(SessionId('a04-nonroot'))
    const ctx = fakeCtx()
    guardApply(ctx, 'always')
    const { agent } = guardedAgent(session)
    startGuard(ctx, agent, 'new')

    // Plugin and tool-source claims are not root user input.
    const pluginClaim = createUserMessage({ content: [{ type: 'text', text: '修改 b.txt' }], source: { kind: 'plugin', plugin: 'other', form: 'notice', summary: 'other' } as never })
    const toolClaim = createUserMessage({ content: [{ type: 'text', text: '修改 b.txt' }], source: { kind: 'tool', callId: 'c1' as never } })
    expect((await runPreStep(ctx, agent, [pluginClaim])).messages).toHaveLength(1)
    expect((await runPreStep(ctx, agent, [toolClaim])).messages).toHaveLength(1)
    expect(guardNotices(session)).toHaveLength(0)

    // A delegated (subagent) session never receives root-conversation injections.
    const sub = Session.create(SessionId('a04-sub'), undefined, {
      version: 0, isSeeded: false, id: SessionId('a04-sub'), createdAt: 1, cwd: '/work', origin: 'subagent', delegationDepth: 1,
    })
    const subGuard = guardedAgent(sub)
    startGuard(ctx, subGuard.agent, 'new')
    const subDecision = await runPreStep(ctx, subGuard.agent, [createUserMessage({ content: [{ type: 'text', text: '修改 c.txt' }], source: { kind: 'user' } })])
    expect(subDecision.messages).toHaveLength(1)
  })
})

describe('A05: explicit commands, presets, and concurrent sessions', () => {
  it('an explicit off suppresses always until on, and activation never fabricates input', async () => {
    const session = Session.create(SessionId('a05-off'))
    enableCommand(session, 'off')
    const ctx = fakeCtx()
    guardApply(ctx, 'always')
    const { agent } = guardedAgent(session)
    startGuard(ctx, agent, 'new')

    const claimed = [createUserMessage({ content: [{ type: 'text', text: '修改 d.txt' }], source: { kind: 'user' } })]
    expect((await runPreStep(ctx, agent, claimed)).messages).toHaveLength(1)
    enableCommand(session, 'on')
    expect((await runPreStep(ctx, agent, claimed)).messages).toHaveLength(3)
  })

  it('two concurrent sessions inject independently and never share activation state', async () => {
    const ctx = fakeCtx()
    guardApply(ctx, 'always')
    const first = Session.create(SessionId('a05-s1'))
    const second = Session.create(SessionId('a05-s2'))
    const agent1 = guardedAgent(first)
    const agent2 = guardedAgent(second)
    startGuard(ctx, agent1.agent, 'new')
    startGuard(ctx, agent2.agent, 'new')

    const claimed = [createUserMessage({ content: [{ type: 'text', text: '修改 e.txt' }], source: { kind: 'user' } })]
    const d1 = await runPreStep(ctx, agent1.agent, claimed)
    expect(d1.messages).toHaveLength(3)
    // The second session has its own first step and its own boundary.
    const d2 = await runPreStep(ctx, agent2.agent, claimed)
    expect(d2.messages).toHaveLength(3)
    expect(guardNotices(first)).toHaveLength(0)
    expect(guardNotices(second)).toHaveLength(0)
  })
})

describe('A06: resume, compaction, and old-session upgrade', () => {
  it('resume delivers recovery at the next entered step without re-injecting the boundary', async () => {
    const session = Session.create(SessionId('a06-resume'))
    const ctx = fakeCtx()
    guardApply(ctx, 'always')
    const { agent, registered } = guardedAgent(session)
    startGuard(ctx, agent, 'new')
    const claimed = [createUserMessage({ content: [{ type: 'text', text: '修改 f.txt 并运行 pnpm test' }], source: { kind: 'user' } })]
    const first = await runPreStep(ctx, agent, claimed)
    persistStep(session, first.messages)

    // A rejected checkpoint arms recovery; the delivery happens on the next
    // entered step and carries no duplicate boundary.
    await registered.find((tool) => tool.name === 'context_guard_checkpoint')!.execute({ bindings: [{ item_id: 'R001', evidence_ids: ['E9999'] }] })
    startGuard(ctx, agent, 'resume')
    const resumed = await runPreStep(ctx, agent, claimed)
    expect(resumed.messages).toHaveLength(2)
    const texts = resumed.messages.map((message) => ((message as { content?: Array<{ text?: string }> }).content ?? [])[0]?.text)
    expect(texts.filter((text) => text === PROTOCOL_V4_NOTICE)).toHaveLength(0)
    expect(texts.some((text) => String(text).includes('recovered after compaction or resume'))).toBe(true)
  })

  it('a pre-0.5 session gains the v4 cut at the first 0.5 write and keeps historical interpretation', async () => {
    const session = Session.create(SessionId('a06-legacy'))
    // Old-style T0 notices exist as history from a pre-0.5 session.
    rawAppend(session)('user/message', createUserMessage({
      content: [{ type: 'text', text: PROTOCOL_V3_NOTICE }],
      source: { kind: 'plugin', plugin: 'context-guard', form: 'notice', summary: 'legacy' },
    }), { surfaceOp: 'append' })
    enableCommand(session, 'on')
    userText(session, '修改 g.txt')
    const baseline = deriveProjection(session.snapshotEvents() as never, { activation: 'opt-in' }, { cwd: '/work' }, true, TEST_HOST_LOCK)
    expect(baseline.protocolV4Present).toBe(false)

    const ctx = fakeCtx()
    guardApply(ctx, 'opt-in')
    const { agent } = guardedAgent(session)
    startGuard(ctx, agent, 'resume')
    const decision = await runPreStep(ctx, agent, [createUserMessage({ content: [{ type: 'text', text: '还有后续要求' }], source: { kind: 'user' } })])
    // The first 0.5 write is the explicit cut: v4 boundary, then the recovery
    // packet, then the claimed input.
    expect(decision.messages).toHaveLength(3)
    expect((decision.messages[0] as { content: Array<{ text: string }> }).content[0].text).toBe(PROTOCOL_V4_NOTICE)
    persistStep(session, decision.messages)
    const after = deriveProjection(session.snapshotEvents() as never, { activation: 'opt-in' }, { cwd: '/work' }, true, TEST_HOST_LOCK)
    expect(after.protocolV4Present).toBe(true)
    // Historical interpretation is frozen: the pre-cut item keeps its exact
    // captured identity while the new input captures normally.
    const beforeItem = [...baseline.projection.items.values()][0]
    const afterItem = [...after.projection.items.values()].find((item) => item.normalizedText === beforeItem!.normalizedText)
    expect(afterItem).toMatchObject({ authority: beforeItem!.authority, status: beforeItem!.status })
    expect([...after.projection.items.values()].some((item) => item.normalizedText.includes('后续要求'))).toBe(true)
  })
})

it('does not activate when a downstream pre-step gate filters the claimed root input', async () => {
  const session = Session.create(SessionId('filtered-root'))
  const ctx = fakeCtx()
  guardApply(ctx, 'always')
  const { agent } = guardedAgent(session)
  startGuard(ctx, agent, 'new')
  const claimed = [createUserMessage({ content: [{ type: 'text', text: '请检查代码' }], source: { kind: 'user' } })]
  const filtered = await runPreStep(ctx, agent, claimed, async () => ({ kind: 'enter', messages: [] }))
  expect(filtered.messages).toEqual([])
  const retried = await runPreStep(ctx, agent, claimed)
  expect(retried.messages).toHaveLength(3)
})

it('explicit opt-in records the v4 boundary ahead of its first protected input', async () => {
  const session = Session.create(SessionId('opt-in-v4'))
  const ctx = fakeCtx()
  guardApply(ctx, 'opt-in')
  const { agent } = guardedAgent(session)
  startGuard(ctx, agent, 'new')
  enableCommand(session)
  const claimed = [createUserMessage({ content: [{ type: 'text', text: '请检查配置' }], source: { kind: 'user' } })]
  const step = await runPreStep(ctx, agent, claimed)
  expect(step.messages).toHaveLength(3)
  persistStep(session, step.messages)
  const derived = deriveProjection(session.snapshotEvents() as never, { activation: 'opt-in' }, { cwd: '/work' }, true, TEST_HOST_LOCK)
  expect(derived.protocolV4Present).toBe(true)
  expect(derived.projection.items.size).toBeGreaterThan(0)
})
