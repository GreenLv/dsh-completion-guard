import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalJobRegistry } from '@deepseek-ai/dsh-jobs-local'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { deriveProjection } from '../../src/domain/derive.js'
import { availableBoundaryQualifications } from '../../src/domain/boundary.js'
import { createBoundaryTool } from '../../src/tools/boundary.js'
import { createExternalOperationTool } from '../../src/tools/external-operation.js'
import { readExternalOperation } from '../../src/runtime.js'

function append(session: Session, type: string, data: unknown, options?: unknown): void {
  ;(session as unknown as { append(type: string, data: unknown, options?: unknown): void }).append(type, data, options)
}

function toolCall(session: Session, id: string, name: string, args: unknown): void {
  append(session, 'tool/call', { turn: 1, step: session.seq, callId: id, name, arguments: JSON.stringify(args) })
}

function toolResult(session: Session, id: string, value: unknown, meta?: unknown): void {
  append(session, 'tool/result', {
    turn: 1, step: session.seq,
    message: { role: 'user', content: [{ type: 'tool-result', toolCallId: id, content: [{ type: 'text', text: JSON.stringify(value) }] }], source: { kind: 'tool', callId: id } },
    ...(meta ? { meta } : {}),
  }, { surfaceOp: 'append' })
}

describe('typed boundary production sources', () => {
  it('reads the pinned LocalJobRegistry snapshot shape rather than a synthetic status object', async () => {
    const ctx = new Context()
    const jobs = new LocalJobRegistry(ctx, { maxConcurrentJobsPerOwner: 2 })
    const detachController = jobs.attachController('context-guard-integration')
    let settle!: (value: { status: 'completed' }) => void
    const done = new Promise<{ status: 'completed' }>((resolve) => { settle = resolve })
    const id = jobs.start({
      kind: 'bash',
      label: 'bounded integration job',
      run: () => ({ cancel: () => {}, done }),
    })
    const agent = { ctx: { get: (name: string) => name === 'jobs' ? jobs : undefined } } as unknown as Agent

    const pinnedSnapshot = jobs.get(id)
    expect(pinnedSnapshot).toMatchObject({
      id: 'bash-1', kind: 'bash', label: 'bounded integration job', status: 'running', reported: false,
    })
    expect(readExternalOperation({} as never, agent, String(id))).toEqual({
      id: 'bash-1', status: 'running', adapterId: 'dsh.jobs.v1',
    })

    settle({ status: 'completed' })
    await done
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(readExternalOperation({} as never, agent, String(id))).toEqual({
      id: 'bash-1', status: 'completed', adapterId: 'dsh.jobs.v1',
    })
    detachController()
  })

  it.each([
    ['running', 'running'], ['stopping', 'pending'], ['completed', 'completed'], ['killed', 'failed'], ['failed', 'failed'],
  ] as const)('maps pinned ctx.jobs status %s to %s without parsing output text', (hostStatus, expected) => {
    const jobs = { get: (id: string) => ({ id, kind: 'bash', label: 'bounded', status: hostStatus, startedAt: 1, reported: false }) }
    const agent = { ctx: { get: (name: string) => name === 'jobs' ? jobs : undefined } } as unknown as Agent
    expect(readExternalOperation({} as never, agent, 'bash-1')).toEqual({ id: 'bash-1', status: expected, adapterId: 'dsh.jobs.v1' })
  })

  it('round-trips live jobs readback through derive, boundary tool, and persisted replay', async () => {
    const session = Session.create(SessionId('boundary-external-session'))
    append(session, 'command/run', { commandId: 'on', name: 'context-guard', args: 'on', source: { kind: 'user' } })
    const jobs = { get: (id: string) => ({ id, kind: 'bash', label: 'bounded', status: 'running', startedAt: 1, reported: false }) }
    const agent = { session, ctx: { get: (name: string) => name === 'jobs' ? jobs : undefined } } as unknown as Agent
    const reader = (id: string) => readExternalOperation({} as never, agent, id)
    const external = createExternalOperationTool(reader, () => ({ status: 'supported', digest: 'a'.repeat(64) }))
    const externalArgs = { operation_id: 'bash-1' }
    toolCall(session, 'external-read', 'context_guard_external_operation', externalArgs)
    const value = await external.execute(externalArgs, { agent } as never)
    const meta = external.output.presentationMeta?.(externalArgs, value as never)
    toolResult(session, 'external-read', value, meta)

    let projection = deriveProjection(session.events as never, { activation: 'opt-in' }, {}, true).projection
    expect(availableBoundaryQualifications(projection)).toEqual([{
      id: 'bash-1', kind: 'external_operation_pending', disposition: 'external_wait', source: 'trusted_adapter', status: 'running',
    }])

    const boundary = createBoundaryTool(() => projection, async () => true, () => {})
    const boundaryArgs = { disposition: 'external_wait' as const, qualification_kind: 'external_operation_pending' as const, qualification_ids: ['bash-1'] }
    toolCall(session, 'boundary-call', 'context_guard_boundary', boundaryArgs)
    const boundaryValue = await boundary.execute(boundaryArgs, undefined as never)
    expect(boundaryValue).toMatchObject({ status: 'accepted' })
    toolResult(session, 'boundary-call', boundaryValue)

    projection = deriveProjection(session.events as never, { activation: 'opt-in' }, {}, true).projection
    expect(projection.boundaries).toHaveLength(1)
    expect(projection.boundaries[0]).toMatchObject({ persistedResult: 'accepted', qualificationIds: ['bash-1'] })
  })

  it('fails closed before reading ctx.jobs when the jobs host capability is missing', async () => {
    let reads = 0
    const external = createExternalOperationTool(() => {
      reads += 1
      return { id: 'bash-1', status: 'running', adapterId: 'dsh.jobs.v1' }
    }, () => ({ status: 'unavailable', digest: 'b'.repeat(64) }))
    await expect(external.execute({ operation_id: 'bash-1' }, { agent: {} } as never)).resolves.toEqual({
      status: 'unknown',
      operation_id: 'bash-1',
      reason_code: 'host_jobs_capability_unavailable',
      adapter_id: 'dsh.jobs.v1',
    })
    expect(reads).toBe(0)
  })

  it('rejects removed policy_defer input instead of exposing an unreachable capability', async () => {
    const projection = deriveProjection([], { activation: 'always' }, {}, true).projection
    const tool = createBoundaryTool(() => projection, async () => true, () => {})
    await expect(tool.execute({
      disposition: 'deferred', qualification_kind: 'policy_defer', qualification_ids: ['policy:1'],
    } as never, undefined as never)).rejects.toThrow(/qualification_kind.*must be one of/)
  })
})
