import { describe, expect, it } from 'vitest'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { deriveProjection, PROTOCOL_V6_NOTICE } from '../src/domain/derive.js'
import { projectSessionCoreV2 } from '../src/core-v2/session.js'
import { createCheckpointTool } from '../src/tools/checkpoint.js'
import { goalCompletionDenial } from '../src/domain/goal-gate.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'

const HOST = evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' })

function fixture() {
  const id = SessionId('v6-goal-current-closure')
  const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, isSeeded: false, id, createdAt: 1, cwd: '/work' })
  const scope = { cwd: '/work', sessionHeader: { version: SESSION_FORMAT_VERSION, id: String(id), createdAt: 1, seedLength: 0, delegationDepth: 0 } }
  session.append('command/run', { commandId: 'on' as never, name: 'context-guard', args: 'on', source: { kind: 'user' } })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }],
    source: { kind: 'plugin', plugin: 'context-guard', form: 'notice', summary: 'v6' } }), { surfaceOp: 'append' })
  session.append('goal/change', { kind: 'goal/change', version: 1, operation: 'create',
    goal: { id: 'g', revision: 1, objective: 'Run tests', phase: 'active', maxGoalRounds: 256 },
    roundsStarted: 1, createdAt: 1, updatedAt: 1 } as never)
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Run pnpm test in /work.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const call = (id: string, name: string, args: Record<string, unknown>, step: number) => session.append('tool/call',
    { turn: 1, step, callId: id as never, name, arguments: JSON.stringify(args) })
  const result = (id: string, text: string, step: number, failed = false) => session.append('tool/result',
    { turn: 1, step, message: createToolResultMessage({ callId: id as never,
      content: [{ type: 'text', text, ...(failed ? { isError: true } : {}) }], isError: failed }),
    ...(failed ? { error: { name: 'ProcessError', message: 'failed' } } : {}) } as never, { surfaceOp: 'append' })
  const derive = () => {
    const events = session.snapshotEvents() as never
    const projection = deriveProjection(events, { activation: 'opt-in' }, scope, true, HOST).projection
    projection.durabilityWatermark = 'confirmed'
    projection.coreV2 = projectSessionCoreV2(events, projection)
    return projection
  }
  return { session, call, result, derive }
}

describe('v6 adopted Goal current closure', () => {
  it('issues a v4 checkpoint from current core, replays it, then denies Goal completion after a later failed test', async () => {
    const { call, result, derive } = fixture()
    call('test-success', 'bash', { command: 'pnpm test', workdir: '/work' }, 1)
    result('test-success', '10 tests passed', 1)
    const projection = derive()
    const item = [...projection.items.values()].find((row) => row.semanticAction === 'test')!
    const effect = [...projection.evidence.values()].find((row) => row.callId === 'test-success')!
    expect(projection.coreV2?.certifiable).toBe(true)
    const args = { bindings: [{ item_id: item.id, evidence_ids: [effect.id], semantic_action: 'test',
      requested_target: item.requestedTarget, resolved_target: effect.resolvedTarget, observed_state: {},
      expected_transition: { predicate_id: 'pred.test.outcome', version: 1, pred_params_kind: 'inline',
        parameters: { expected_outcome: { k: 'e', v: 'success' }, min_matches: 1 } }, effect_evidence_id: effect.id }] }
    const tool = createCheckpointTool(() => projection, () => {})
    const issued = await tool.execute(args as never, undefined as never) as Record<string, unknown>
    expect(issued.status).toBe('certified')
    expect((issued.certificate as Record<string, unknown>).certificate_version).toBe('4')
    const context = new Context()
    new SystemPrompt(context, {})
    const hostTools = new ToolRuntime(context)
    hostTools.register(createCheckpointTool(() => projection, () => {}))
    const materialized = await hostTools.execute({ callId: 'checkpoint-v4-host' as never,
      name: 'context_guard_checkpoint', arguments: args, signal: new AbortController().signal })
    expect(materialized.isError, JSON.stringify(materialized.error)).toBe(false)
    expect((materialized.value as Record<string, unknown>).status).toBe('certified')
    call('checkpoint', 'context_guard_checkpoint', args, 2)
    result('checkpoint', JSON.stringify(issued), 2)
    const accepted = derive()
    expect(accepted.integrity).toBe('valid')
    expect(accepted.checkpoints).toHaveLength(1)
    expect(accepted.coreV2?.certifiable).toBe(true)
    expect(goalCompletionDenial(accepted, 'update_goal', { action: 'complete', goal_id: 'g', revision: 1 })).toBeUndefined()
    call('test-failure', 'bash', { command: 'pnpm test', workdir: '/work' }, 3)
    result('test-failure', '1 test failed', 3, true)
    const failed = derive()
    expect(failed.integrity).toBe('valid')
    expect(failed.checkpoints).toHaveLength(1)
    expect(failed.coreV2?.certifiable).toBe(false)
    expect(goalCompletionDenial(failed, 'update_goal', { action: 'complete', goal_id: 'g', revision: 1 })).toContain('current_closure_unmet')
    expect(goalCompletionDenial(failed, 'update_goal', { action: 'blocked', goal_id: 'g', revision: 1 })).toBeUndefined()
  })
  it('does not issue a new live checkpoint when a current required test has failed', async () => {
    const { call, result, derive } = fixture()
    call('test-failure', 'bash', { command: 'pnpm test', workdir: '/work' }, 1)
    result('test-failure', '1 test failed', 1, true)
    const projection = derive()
    expect(projection.coreV2?.certifiable).toBe(false)
    const tool = createCheckpointTool(() => projection, () => {})
    const issued = await tool.execute({ bindings: [] } as never, undefined as never) as Record<string, unknown>
    expect(issued.status).toBe('incomplete')
    expect(issued.certificate).toBeUndefined()
    expect(issued.rejected_bindings).toMatchObject([{ reason_code: 'current_closure_unmet' }])
  })
})
