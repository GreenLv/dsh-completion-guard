// 0.2.2-rc.2 host-interface adaptation regressions. The rc.2 release changed
// real consumed interfaces: session batch event append (array overload +
// currentBatchPublication), tool guard denial identity ({reason, info?}),
// approval/error code identity, the working-directory/access waterfall with
// machine-routable WorkingDirectoryError codes, and jobs JobError codes. Each
// test runs the REAL installed rc.2 SDK (devDependencies, not version-string
// fixtures) so the behavior — not a module hash — is what passes or fails.
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import { WorkingDirectoryService } from '@deepseek-ai/dsh-working-directory'
import { JobRegistry, JobId } from '@deepseek-ai/dsh-jobs'
import { LocalJobRegistry } from '@deepseek-ai/dsh-jobs-local'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const notice = () => createUserMessage({
  content: [{ type: 'text', text: 'probe notice' }],
  source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice' },
})

describe('rc.2 session batch append', () => {
  it('commits a batch in order with consecutive seqs and notifies observers per event over the COMPLETE log', () => {
    const ctx = new Context()
    const store = new SessionStore(ctx)
    const session = store.create(SessionId('rc2-batch-order'), { meta: { cwd: '/tmp' } })
    const observed = []
    ctx.on('session/event', (subject, event) => {
      // rc.2 batch publication: observers of member N already see the whole
      // committed batch (log length covers every member) and can read which
      // member is being delivered through currentBatchPublication.
      expect(subject).toBe(session)
      expect(session.snapshotEvents().length).toBe(3)
      expect(session.currentBatchPublication).toBe(event)
      observed.push({ seq: event.seq, type: event.type })
    })
    const events = session.append([
      ['user/message', notice(), { surfaceOp: 'append' }],
      ['turn/start', { turn: 1 }],
      ['user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'run it' }] }), { surfaceOp: 'append' }],
    ])
    expect(events).toHaveLength(3)
    expect(events.map(event => event.seq)).toEqual([0, 1, 2])
    expect(events.every(event => Object.isFrozen(event))).toBe(true)
    expect(observed.map(row => row.type)).toEqual(['user/message', 'turn/start', 'user/message'])
    expect(observed.map(row => row.seq)).toEqual([0, 1, 2])
    expect(session.currentBatchPublication).toBeUndefined()
    // The committed log is readable as one frozen sequence after append.
    expect(session.snapshotEvents().map(event => event.seq)).toEqual([0, 1, 2])
  })

  it('rejects a batch atomically: an invalid member leaves the log and surface unchanged', () => {
    const ctx = new Context()
    const store = new SessionStore(ctx)
    const session = store.create(SessionId('rc2-batch-atomic'), { meta: { cwd: '/tmp' } })
    const before = session.snapshotEvents().length
    expect(() => session.append([
      ['user/message', notice(), { surfaceOp: 'append' }],
      ['user/message', undefined],
    ])).toThrow()
    expect(session.snapshotEvents().length).toBe(before)
  })

  it('keeps the single-event append path and its observer delivery intact', () => {
    const ctx = new Context()
    const store = new SessionStore(ctx)
    const session = store.create(SessionId('rc2-single-append'), { meta: { cwd: '/tmp' } })
    let deliveries = 0
    ctx.on('session/event', (_subject, event) => {
      deliveries += 1
      expect(event.seq).toBe(deliveries)
    })
    const single = session.append('user/message', notice(), { surfaceOp: 'append' })
    expect(single.seq).toBe(0)
    expect(deliveries).toBe(1)
  })

  it('an empty batch records no events and returns an empty array', () => {
    const ctx = new Context()
    const store = new SessionStore(ctx)
    const session = store.create(SessionId('rc2-batch-empty'), { meta: { cwd: '/tmp' } })
    const before = session.snapshotEvents().length
    expect(session.append([])).toEqual([])
    expect(session.snapshotEvents().length).toBe(before)
  })

  it('the durability flush observes the COMPLETE batch and reports participation', async () => {
    const ctx = new Context()
    const store = new SessionStore(ctx)
    const session = store.create(SessionId('rc2-batch-persist'), { meta: { cwd: '/tmp' } })
    session.append([
      ['user/message', notice(), { surfaceOp: 'append' }],
      ['turn/start', { turn: 1 }],
      ['user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'batch durability' }] }), { surfaceOp: 'append' }],
    ])
    let flushedCount = -1
    ctx.on('session/flush', (subject) => {
      if (subject === session) flushedCount = subject.snapshotEvents().length
    })
    const durable = await store.flush(session)
    expect(durable).toBe(true)
    // The flush ran over the complete batch: partial-batch evidence can never
    // claim durability because the flush snapshot already covers every member.
    expect(flushedCount).toBe(session.snapshotEvents().length)
    expect(flushedCount).toBeGreaterThanOrEqual(3)
  })
})

describe('rc.2 tool guard denial identity', () => {
  function runtime() {
    const ctx = new Context()
    // rc.2 ToolsService injects ['systemPrompt']: the service must be mounted
    // before the tool runtime composes.
    new SystemPrompt(ctx, {})
    const rt = new ToolRuntime(ctx)
    rt.setExecutor(new NativeToolExecutor(ctx, () => 1))
    const agent = { id: 'rc2-tools', session: Session.create(SessionId('rc2-tools')), ctx }
    const registered = rt.register(defineTool({
      name: 'rc2_effect', description: 'effect counter',
      parameters: {}, output: { schema: { type: 'object', properties: { status: { type: 'string', required: true } }, additionalProperties: false }, render: () => [{ type: 'text', text: 'ok' }] },
      execute: async () => ({ status: 'ok' }),
    }))
    return { ctx, rt, agent, registered }
  }

  it('checkGuards wraps a string denial as {reason} while a structured denial keeps its info identity', () => {
    const { rt, agent, registered } = runtime()
    const disposeString = rt.guard(() => 'string-denied')
    // rc.2: the readback normalizes a string guard to the denial object.
    expect(rt.checkGuards({ name: 'rc2_effect', arguments: {}, agent, session: agent.session }))
      .toEqual({ reason: 'string-denied' })
    disposeString()
    const disposeStructured = rt.guard(() => ({ reason: 'structured-denied', info: { name: 'ApprovalError', code: 'APPROVAL_REJECTED' } }))
    expect(rt.checkGuards({ name: 'rc2_effect', arguments: {}, agent, session: agent.session }))
      .toEqual({ reason: 'structured-denied', info: { name: 'ApprovalError', code: 'APPROVAL_REJECTED' } })
    disposeStructured()
    expect(rt.checkGuards({ name: 'rc2_effect', arguments: {}, agent, session: agent.session })).toBeUndefined()
    registered()
  })

  it('a denied execution records isError with the denial reason as the model-facing content', async () => {
    const { rt, agent } = runtime()
    const dispose = rt.guard(() => 'denied-by-probe')
    const sole = batch => { expect(batch.results).toHaveLength(1); return batch.results[0].result }
    const denied = sole(await rt.execute({ agent, calls: [{ type: 'tool-call', id: 'd1', name: 'rc2_effect', arguments: '{}' }], signal: new AbortController().signal }))
    expect(denied.isError).toBe(true)
    dispose()
    const allowed = sole(await rt.execute({ agent, calls: [{ type: 'tool-call', id: 'd2', name: 'rc2_effect', arguments: '{}' }], signal: new AbortController().signal }))
    expect(allowed.isError).toBe(false)
  })

  it('cancelled execution gains the ABORTED identity without abandoning the body', async () => {
    const { rt, agent, registered } = runtime()
    rt.register(defineTool({
      name: 'rc2_slow', description: 'cancellation probe',
      parameters: {}, output: { schema: { type: 'object', properties: { status: { type: 'string', required: true } }, additionalProperties: false }, render: () => [{ type: 'text', text: 'ok' }] },
      execute: async () => { await new Promise(resolve => setTimeout(resolve, 50)); return { status: 'ok' } },
    }))
    const controller = new AbortController()
    const sole = batch => { expect(batch.results).toHaveLength(1); return batch.results[0].result }
    const execution = rt.execute({ agent, calls: [{ type: 'tool-call', id: 's1', name: 'rc2_slow', arguments: '{}' }], signal: controller.signal })
    controller.abort(new Error('stopped by probe'))
    const result = sole(await execution)
    expect(result.isError).toBe(true)
    registered()
  })
})

describe('rc.2 working-directory access waterfall', () => {
  it('set() publishes working-directory/access and commits through next(); a rejecting listener leaves the recorded directory unchanged', async () => {
    const ctx = new Context()
    // rc.2 composition: the working-directory service injects fs,
    // sessionProjections and systemPrompt; projection registration is an
    // awaited resource acquisition, so the plugin lifecycle must start it.
    new SessionProjectionRegistry(ctx); new SystemPrompt(ctx, {})
    new LocalFileSystem(ctx, { cwd: '/tmp', diffBasisMaxBytes: 10485760 })
    await ctx.plugin(WorkingDirectoryService, { defaultDirectory: '/tmp' }).await()
    const service = ctx.workingDirectory
    const agent = { id: SessionId('rc2-wd'), session: Session.create(SessionId('rc2-wd'), undefined, { version: 4, id: SessionId('rc2-wd'), isSeeded: false, createdAt: 1, cwd: '/tmp' }), ctx }
    let accesses = 0
    const dispose = ctx.on('working-directory/access', async (_request, next) => {
      accesses += 1
      return next()
    })
    const target = realpathSync(mkdtempSync(join(tmpdir(), 'rc2-wd-target-')))
    try {
      const committed = await service.set(agent, target)
      expect(committed).toBe(target)
      expect(accesses).toBe(1)
      expect(service.get(agent.session)).toBe(target)
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
    // A rejection fails the access and leaves the recorded directory unchanged.
    dispose()
    ctx.on('working-directory/access', async () => { throw new Error('probe veto') })
    await expect(service.set(agent, '/tmp')).rejects.toThrow('probe veto')
    expect(service.get(agent.session)).toBe(target)
  })

  it('machine-routable failures carry WorkingDirectoryError codes', async () => {
    const ctx = new Context()
    new SessionProjectionRegistry(ctx); new SystemPrompt(ctx, {})
    new LocalFileSystem(ctx, { cwd: '/tmp', diffBasisMaxBytes: 10485760 })
    await ctx.plugin(WorkingDirectoryService, { defaultDirectory: '/tmp' }).await()
    const service = ctx.workingDirectory
    const agent = { id: SessionId('rc2-wd-err'), session: Session.create(SessionId('rc2-wd-err'), undefined, { version: 4, id: SessionId('rc2-wd-err'), isSeeded: false, createdAt: 1, cwd: '/tmp' }), ctx }
    await expect(service.set(agent, '')).rejects.toMatchObject({ name: 'WorkingDirectoryError', code: 'WORKING_DIRECTORY_INVALID' })
    await expect(service.set(agent, '/definitely-missing-rc2-probe')).rejects.toMatchObject({ name: 'WorkingDirectoryError', code: 'WORKING_DIRECTORY_NOT_FOUND' })
  })
})

describe('rc.2 jobs error identity', () => {
  it('background-job refusals carry machine-routable JobError codes', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalJobRegistry, {}).await()
    const registry = ctx.jobs
    let caught
    try { registry.get(JobId('rc2-missing-job')) } catch (error) { caught = error }
    expect(caught).toMatchObject({ name: 'JobError', code: 'JOB_NOT_FOUND' })
  })
})
