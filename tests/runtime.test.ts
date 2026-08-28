import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply, createRuntime } from '../src/runtime.js'
import { deriveProjection } from '../src/domain/derive.js'
import { certifyCheckpoint } from '../src/domain/checkpoint.js'
import { goalCompletionDenial } from '../src/domain/goal-gate.js'
import { recoveryDigest } from '../src/domain/recovery.js'
import { captureClause } from '../src/domain/capture.js'
import { createProjection } from '../src/domain/types.js'
import { createContextGuardCommand } from '../src/commands/context-guard.js'

function fakeAgent(session: Session): Agent {
  return { session } as unknown as Agent
}

function rawAppend(session: Session): (type: string, data: unknown, opts?: unknown) => unknown {
  return (session as unknown as { append: (type: string, data: unknown, opts?: unknown) => unknown }).append.bind(session)
}

const OPT_IN = { activation: 'opt-in' as const }
const ALWAYS = { activation: 'always' as const }

function enableCommand(session: Session, subcommand = 'on') {
  rawAppend(session)('command/run', { commandId: `cmd-${session.seq}`, name: 'context-guard', args: subcommand, source: { kind: 'user' } })
}

function userText(session: Session, text: string) {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

function toolCall(session: Session, callId: string, name: string, argumentsJson: string) {
  rawAppend(session)('tool/call', { turn: 1, step: 1, callId, name, arguments: argumentsJson })
}

function toolResult(session: Session, callId: string, text: string, meta?: unknown, error?: unknown) {
  rawAppend(session)('tool/result', {
    turn: 1,
    step: 1,
    message: {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
      source: { kind: 'tool', callId },
    },
    ...(meta !== undefined ? { meta } : {}),
    ...(error !== undefined ? { error } : {}),
  }, { surfaceOp: 'append' })
}

describe('runtime derivation', () => {
  it('derives enablement only from the native command/run log', () => {
    const session = Session.create(SessionId('derive-enable-session'))
    enableCommand(session, 'on')
    const runtime = createRuntime(fakeAgent(session), OPT_IN)
    expect(runtime.projection.enabled).toBe(true)
    expect(runtime.projection.epoch).toBe(1)

    enableCommand(session, 'off')
    runtime.sync()
    expect(runtime.projection.enabled).toBe(false)
    expect(runtime.projection.epoch).toBe(1)

    enableCommand(session, 'on')
    runtime.sync()
    expect(runtime.projection.enabled).toBe(true)
    expect(runtime.projection.epoch).toBe(2)
  })

  it('derives nothing before the first enable command (opt-in)', () => {
    const session = Session.create(SessionId('derive-optin-session'))
    userText(session, 'ship the artifact')
    const runtime = createRuntime(fakeAgent(session), OPT_IN)
    expect(runtime.projection.enabled).toBe(false)
    expect(runtime.projection.items.size).toBe(0)
  })

  it('starts enabled with always activation', () => {
    const session = Session.create(SessionId('derive-always-session'))
    const runtime = createRuntime(fakeAgent(session), ALWAYS)
    expect(runtime.projection.enabled).toBe(true)
  })

  it('replays existing messages under always while honoring later off and on commands', () => {
    const session = Session.create(SessionId('derive-always-replay-session'))
    userText(session, 'ship before.txt')
    enableCommand(session, 'off')
    userText(session, 'ship ignored.txt')
    enableCommand(session, 'on')
    userText(session, 'ship after.txt')

    const runtime = createRuntime(fakeAgent(session), ALWAYS)
    const clauses = [...runtime.projection.items.values()].map((item) => item.normalizedText)
    expect(runtime.projection.enabled).toBe(true)
    expect(clauses).toContain('ship before.txt')
    expect(clauses).not.toContain('ship ignored.txt')
    expect(clauses).toContain('ship after.txt')
  })

  it('marks recovery needed after a compaction summary', () => {
    const session = Session.create(SessionId('recovery-session'))
    enableCommand(session, 'on')
    const runtime = createRuntime(fakeAgent(session), OPT_IN)
    expect(runtime.consumeRecovery()).toBe(false)

    rawAppend(session)('compaction/summary', {
      compactionId: 'c1',
      summary: [],
      shadowedRange: { start: 0, end: 0 },
      shadowedSeqs: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    })
    runtime.sync()
    expect(runtime.consumeRecovery()).toBe(true)
    expect(runtime.consumeRecovery()).toBe(false)
  })

  it('round-trips markRecoveryNeeded and consumeRecovery', () => {
    const session = Session.create(SessionId('recovery-session-2'))
    const runtime = createRuntime(fakeAgent(session), OPT_IN)
    runtime.markRecoveryNeeded()
    expect(runtime.consumeRecovery()).toBe(true)
    expect(runtime.consumeRecovery()).toBe(false)
  })

  it('marks recovery needed once when enablement transitions on', () => {
    const session = Session.create(SessionId('enable-session'))
    const runtime = createRuntime(fakeAgent(session), OPT_IN)
    expect(runtime.consumeRecovery()).toBe(false)
    enableCommand(session, 'on')
    runtime.sync()
    expect(runtime.consumeRecovery()).toBe(true)
    runtime.sync()
    expect(runtime.consumeRecovery()).toBe(false)
  })

  it('never writes custom session event types (persistence boundary)', () => {
    const session = Session.create(SessionId('no-custom-events-session'))
    enableCommand(session, 'on')
    userText(session, "Don't touch the API")
    toolCall(session, 'c1', 'read', '{"file_path":"a.txt"}')
    toolResult(session, 'c1', 'ok', { path: 'a.txt' })
    const runtime = createRuntime(fakeAgent(session), OPT_IN)
    runtime.sync()
    toolCall(session, 'c2', 'context_guard_checkpoint', '{"bindings":[]}')
    toolResult(session, 'c2', JSON.stringify({ status: 'incomplete', contract_revision: 1, open_items: [], rejected_bindings: [] }))
    runtime.sync()
    const custom = session.events.filter((event) => event.type.startsWith('context-guard/'))
    expect(custom).toEqual([])
  })

  it('generates unique evidence IDs and skips the checkpoint tool', () => {
    const session = Session.create(SessionId('evidence-id-session'))
    enableCommand(session, 'on')
    const runtime = createRuntime(fakeAgent(session), OPT_IN)
    runtime.setDurability(true)

    toolCall(session, 'c1', 'bash', '{"command":"echo hi"}')
    toolResult(session, 'c1', 'ok')
    toolCall(session, 'c2', 'read', '{"file_path":"a.txt"}')
    toolResult(session, 'c2', 'ok', { path: 'a.txt' })
    toolCall(session, 'c3', 'context_guard_checkpoint', '{"bindings":[]}')
    toolResult(session, 'c3', JSON.stringify({ status: 'incomplete', contract_revision: 0, open_items: [], rejected_bindings: [] }))

    runtime.sync()
    const evidence = [...runtime.projection.evidence.values()]
    const ids = evidence.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(evidence.some((e) => e.toolName === 'context_guard_checkpoint')).toBe(false)
    expect(ids).toContain('E0001')
    expect(ids).toContain('E0002')
  })

  it('captures a prohibition contract from a direct human message', () => {
    const session = Session.create(SessionId('capture-session'))
    enableCommand(session, 'on')
    const runtime = createRuntime(fakeAgent(session), OPT_IN)
    userText(session, "Don't touch the API")
    runtime.sync()
    const prohibition = [...runtime.projection.items.values()].find((item) => item.kind === 'prohibition')
    expect(prohibition).toBeDefined()
    expect(prohibition?.id).toBe('P001')
    expect(prohibition?.normalizedText).toBe('touch the API')
  })

  it('re-derives certification and passed statuses from a resumed log', () => {
    const session = Session.create(SessionId('resume-session'))
    enableCommand(session, 'on')
    userText(session, 'verify the generated file src/app.ts')
    toolCall(session, 'c1', 'read', '{"file_path":"src/app.ts"}')
    toolResult(session, 'c1', 'ok', { path: 'src/app.ts' })

    const runtime = createRuntime(fakeAgent(session), OPT_IN)
    runtime.setDurability(true)
    runtime.sync()
    const itemId = [...runtime.projection.items.keys()][0]
    toolCall(session, 'c2', 'context_guard_checkpoint', JSON.stringify({ bindings: [{ item_id: itemId, evidence_ids: ['E0001'] }] }))
    toolResult(session, 'c2', JSON.stringify({ status: 'certified', contract_revision: 1, open_items: [], rejected_bindings: [] }))
    runtime.sync()
    expect(runtime.consumeRecovery()).toBe(false) // consumed earlier
    expect(runtime.projection.checkpoints).toHaveLength(1)
    expect(runtime.projection.items.get(itemId)?.status).toBe('passed')
    expect(runtime.projection.integrity).toBe('valid')

    // Rebuild over the same event log must reproduce the same state (resume path).
    const rebuilt = deriveProjection(session.events as never, OPT_IN, { cwd: '' }, true)
    expect(rebuilt.projection.checkpoints).toHaveLength(1)
    expect(rebuilt.projection.items.get(itemId)?.status).toBe('passed')
    expect(rebuilt.projection.integrity).toBe('valid')
  })

  it('flags corruption when a recorded certificate no longer re-derives', () => {
    const session = Session.create(SessionId('forged-cert-session'))
    enableCommand(session, 'on')
    userText(session, 'verify the generated file src/app.ts')
    // No evidence at all, but the recorded tool/result claims certification.
    toolCall(session, 'c1', 'context_guard_checkpoint', JSON.stringify({ bindings: [{ item_id: 'R001', evidence_ids: ['E9999'] }] }))
    toolResult(session, 'c1', JSON.stringify({ status: 'certified', contract_revision: 1, open_items: [], rejected_bindings: [] }))
    const runtime = createRuntime(fakeAgent(session), OPT_IN)
    runtime.setDurability(true)
    runtime.sync()
    expect(runtime.projection.integrity).toBe('corrupt')
  })
})

  it('preserves continuation attempts across rebuilds', () => {
    const session = Session.create(SessionId('attempts-session'))
    enableCommand(session, 'on')
    const runtime = createRuntime(fakeAgent(session), OPT_IN)
    runtime.projection.continuationAttempts.set(3, 2)
    runtime.sync()
    expect(runtime.projection.continuationAttempts.get(3)).toBe(2)
  })

  it('does not re-arm recovery from a historical compaction summary', () => {
    const session = Session.create(SessionId('compaction-once-session'))
    enableCommand(session, 'on')
    const runtime = createRuntime(fakeAgent(session), OPT_IN)
    rawAppend(session)('compaction/summary', {
      compactionId: 'c1', summary: [], shadowedRange: { start: 0, end: 0 },
      shadowedSeqs: [], shadowedTokenCount: 0, provider: 'p', model: 'm',
    })
    runtime.sync()
    expect(runtime.consumeRecovery()).toBe(true)
    runtime.sync()
    expect(runtime.consumeRecovery()).toBe(false)
  })

  it('binds the recovery digest to packet content, revision, and epoch (v0.2.1)', () => {
    const projection = createProjection()
    const packet = '[R001] ship the artifact'
    const digest = recoveryDigest(packet, projection)
    expect(recoveryDigest(packet, projection)).toBe(digest)
    expect(recoveryDigest(`${packet}!`, projection)).not.toBe(digest)
    projection.contractRevision = 2
    expect(recoveryDigest(packet, projection)).not.toBe(digest)
    projection.epoch = 3
    expect(recoveryDigest(packet, projection)).not.toBe(digest)
  })

  it('preserves the recovery digest across rebuilds and forgets it on enablement (v0.2.1)', () => {
    const session = Session.create(SessionId('recovery-digest-session'))
    enableCommand(session, 'on')
    const runtime = createRuntime(fakeAgent(session), OPT_IN)
    runtime.projection.lastRecoveryDigest = 'digest-1'
    runtime.sync()
    expect(runtime.projection.lastRecoveryDigest).toBe('digest-1')
    enableCommand(session, 'off')
    enableCommand(session, 'on')
    runtime.sync()
    expect(runtime.consumeRecovery()).toBe(true)
    expect(runtime.projection.lastRecoveryDigest).toBeUndefined()
  })

type PreStepHandler = (payload: { agent: Agent }, next: () => Promise<{ kind: string; messages: unknown[] }>) => Promise<{ kind: string; messages: unknown[] }>
type CheckpointTool = { execute: (args: { bindings: Array<{ item_id: string; evidence_ids: string[] }> }) => Promise<unknown> }

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

function guardedAgent(session: Session) {
  const registered: CheckpointTool[] = []
  const agent = {
    session,
    ctx: {
      tools: {
        register: (tool: CheckpointTool) => registered.push(tool),
        guard: () => {},
      },
    },
  }
  return { agent: agent as unknown as Agent, registered }
}

function startGuard(ctx: ReturnType<typeof fakeCtx>, agent: Agent, source: string) {
  for (const handler of ctx.handlers.get('agent/session-start') ?? []) {
    ;(handler as (payload: { agent: Agent; source: string }) => void)({ agent, source })
  }
}

async function runPreStep(ctx: ReturnType<typeof fakeCtx>, agent: Agent): Promise<number> {
  const handler = ctx.handlers.get('agent/pre-step')?.[0] as PreStepHandler | undefined
  const decision = await handler!({ agent }, async () => ({ kind: 'enter', messages: [] }))
  return decision.messages.length
}

async function rejectCheckpoint(registered: CheckpointTool[], itemId: string) {
  await registered[0].execute({ bindings: [{ item_id: itemId, evidence_ids: ['E9999'] }] })
}

describe('recovery injection dedup (v0.2.1)', () => {
  it('injects an unchanged packet once, dedups repeated rejections, and re-injects on new content', async () => {
    const session = Session.create(SessionId('recovery-dedup-session'))
    enableCommand(session, 'on')
    userText(session, 'ship the artifact')
    const ctx = fakeCtx()
    apply(ctx as never, { activation: 'opt-in' })
    const { agent, registered } = guardedAgent(session)
    startGuard(ctx, agent, 'new')

    expect(await runPreStep(ctx, agent)).toBe(0) // nothing armed
    await rejectCheckpoint(registered, 'R001')
    expect(await runPreStep(ctx, agent)).toBe(1) // first injection
    await rejectCheckpoint(registered, 'R001')
    expect(await runPreStep(ctx, agent)).toBe(0) // unchanged packet is deduped

    // New evidence changes the packet content, so the reminder flows again.
    toolCall(session, 'c1', 'bash', '{"command":"pnpm test","workdir":"/work"}')
    toolResult(session, 'c1', '[exit code: 0]')
    await rejectCheckpoint(registered, 'R001')
    expect(await runPreStep(ctx, agent)).toBe(1)
  })

  it('injects the post-resume reminder even when the packet is unchanged (v0.2.1)', async () => {
    const session = Session.create(SessionId('recovery-resume-session'))
    enableCommand(session, 'on')
    userText(session, 'ship the artifact')
    const ctx = fakeCtx()
    apply(ctx as never, { activation: 'opt-in' })
    const { agent, registered } = guardedAgent(session)
    startGuard(ctx, agent, 'new')
    await rejectCheckpoint(registered, 'R001')
    expect(await runPreStep(ctx, agent)).toBe(1)
    await rejectCheckpoint(registered, 'R001')
    expect(await runPreStep(ctx, agent)).toBe(0)
    startGuard(ctx, agent, 'resume')
    expect(await runPreStep(ctx, agent)).toBe(1)
  })
})

describe('context-guard clear command (v0.2.1)', () => {
  it('supersedes pending requirements/acceptances, keeps prohibitions, and unlocks completion', () => {
    const session = Session.create(SessionId('clear-session'))
    enableCommand(session, 'on')
    userText(session, '修改 guard-demo.txt。不要 push。')
    rawAppend(session)('command/run', { commandId: 'cmd-clear', name: 'context-guard', args: 'clear', source: { kind: 'user' } })

    const { projection } = deriveProjection(session.events as never, OPT_IN, { cwd: '/work' }, true)
    const items = [...projection.items.values()]
    const requirement = items.find((item) => item.kind === 'requirement')!
    const prohibition = items.find((item) => item.kind === 'prohibition')!
    expect(requirement.status).toBe('superseded')
    expect(requirement.supersededBy).toMatch(/^CLEAR:\d+$/)
    expect(prohibition.status).toBe('pending')

    // Replay is deterministic: a second derivation reports the same states.
    const replayed = deriveProjection(session.events as never, OPT_IN, { cwd: '/work' }, true)
    expect([...replayed.projection.items.values()].map((item) => [item.id, item.status]))
      .toEqual(items.map((item) => [item.id, item.status]))

    // An empty-binding checkpoint certifies the cleared contract…
    expect(certifyCheckpoint(projection, [], 'C001').status).toBe('certified')
    // …and the goal gate releases completion while the guard stays enabled.
    expect(goalCompletionDenial(projection, 'update_goal', { action: 'complete' })).toBeUndefined()
  })

  it('exposes clear through the slash command and reports the superseded count', () => {
    const projection = createProjection()
    projection.items.set('R001', captureClause('ship the artifact', 'm1', 'R001', 1, { cwd: '/work' }))
    const command = createContextGuardCommand(
      () => projection,
      () => {},
      () => {
        projection.items.get('R001')!.status = 'superseded'
      },
    )
    const handler = command.handler as unknown as (payload: { agent: Agent; rawInput: string }) => { kind: string; text: string }
    const cleared = handler({ agent: {} as Agent, rawInput: 'clear' })
    expect(cleared.kind).toBe('success')
    expect(cleared.text).toContain('1 requirement/acceptance item(s) superseded')
    const usage = handler({ agent: {} as Agent, rawInput: 'bogus' })
    expect(usage.kind).toBe('error')
    expect(usage.text).toContain('clear')
  })
})
