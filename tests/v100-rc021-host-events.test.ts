import { describe, expect, it } from 'vitest'
import { realpathSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { deriveProjection, PROTOCOL_V6_NOTICE } from '../src/domain/derive.js'
import { cwdEpochsFromEvents, effectiveCwdAt, WORKING_DIRECTORY_CHANGE_EVENT } from '../src/domain/cwd-timeline.js'
import { captureHostWorkdir, HOST_WORKDIR_PREFIX, hostWorkdirForCall } from '../src/domain/host-workdir.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'
import { snapshotSessionEvents } from '../src/domain/session-events.js'
import type { DerivedEnvelope } from '../src/domain/types.js'

const HOST = evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' })
const HOST_WITH_RENDERER = { ...HOST, auditedForegroundRenderers: ['bash' as const] }
const HEADER = { version: SESSION_FORMAT_VERSION, id: 'rc021', createdAt: 1, seedLength: 0, delegationDepth: 0 } as const
const derive = (events: readonly DerivedEnvelope[]) => deriveProjection(events, { activation: 'always' },
  { cwd: '/work/repo', sessionHeader: HEADER }, true, HOST)

let seq = 0
const env = (type: string, data: unknown): DerivedEnvelope => ({ seq: ++seq, type, data })
const userRoot = (text: string, turn = 1): DerivedEnvelope => env('user/message',
  { source: { kind: 'user' }, turn, content: [{ type: 'text', text }] })
const reset = (): void => { seq = 0 }

describe('CG021-03: durable job lifecycle records are bounded, non-completing facts', () => {
  it('records a well-formed registered/settled pair and refines the external-wait row without completing anything', () => {
    reset()
    const jobBase = { jobId: 'bash-1', owner: 'rc021', kind: 'bash', label: 'bounded integration job', startedAt: 100 }
    const events = [
      env('job/registered', { ...jobBase, toolCall: { callId: 'c1', rootCallId: 'c1' } }),
      userRoot('部署完成后告诉我。'),
      env('tool/call', { turn: 1, step: 1, callId: 'op1', name: 'context_guard_external_operation', arguments: JSON.stringify({ operation_id: 'bash-1' }) }),
      env('tool/result', { turn: 1, step: 1,
        message: createToolResultMessage({ callId: 'op1' as never, content: [{ type: 'text', text: 'running' }], isError: false }),
        meta: { contextGuardExternalOperation: { id: 'bash-1', adapterId: 'dsh.jobs.v1', status: 'running' } } }),
      env('job/settled', { ...jobBase, toolCall: { callId: 'c1', rootCallId: 'c1' }, finishedAt: 200, status: 'completed', cause: 'producer', producerReported: true }),
    ]
    const { projection } = derive(events)
    const job = projection.jobLifecycle?.get('bash-1')
    expect(job).toMatchObject({ owner: 'rc021', kind: 'bash', registeredAtSeq: 1,
      toolCall: { callId: 'c1', rootCallId: 'c1' },
      settled: { settledAtSeq: 5, status: 'completed', cause: 'producer', producerReported: true } })
    // The live poll said "running"; the durable settlement ends the wait.
    expect(projection.externalOperations.get('bash-1')?.status).toBe('completed')
    // ...but the obligation itself is untouched: settlement is never closure.
    const item = [...projection.items.values()][0]
    expect(item?.status).toBe('pending')
    expect(projection.checkpoints).toHaveLength(0)
    expect(projection.integrity).toBe('valid')
  })

  it('a completed settlement without the producer report is UNCONFIRMED, never success', () => {
    reset()
    const jobBase = { jobId: 'bash-2', owner: 'rc021', kind: 'bash', label: 'forced settle', startedAt: 100 }
    const events = [
      env('job/registered', jobBase),
      userRoot('跑完集成测试后收尾。'),
      env('tool/call', { turn: 1, step: 1, callId: 'op2', name: 'context_guard_external_operation', arguments: JSON.stringify({ operation_id: 'bash-2' }) }),
      env('tool/result', { turn: 1, step: 1,
        message: createToolResultMessage({ callId: 'op2' as never, content: [{ type: 'text', text: 'running' }], isError: false }),
        meta: { contextGuardExternalOperation: { id: 'bash-2', adapterId: 'dsh.jobs.v1', status: 'running' } } }),
      env('job/settled', { ...jobBase, finishedAt: 200, status: 'completed', cause: 'teardown', producerReported: false }),
    ]
    const { projection } = derive(events)
    expect(projection.externalOperations.get('bash-2')?.status).toBe('unknown')
    expect(projection.integrity).toBe('valid')
  })

  it('killed and failed settlements are explicit failures; owner is the ORIGINAL session, not a fork', () => {
    reset()
    const jobBase = { jobId: 'bash-3', owner: 'original-session', kind: 'bash', label: 'long render', startedAt: 1 }
    const opPair = (callId: string, jobId: string): DerivedEnvelope[] => [
      env('tool/call', { turn: 1, step: 1, callId, name: 'context_guard_external_operation', arguments: JSON.stringify({ operation_id: jobId }) }),
      env('tool/result', { turn: 1, step: 1,
        message: createToolResultMessage({ callId: callId as never, content: [{ type: 'text', text: 'running' }], isError: false }),
        meta: { contextGuardExternalOperation: { id: jobId, adapterId: 'dsh.jobs.v1', status: 'running' } } }),
    ]
    const events = [
      env('job/registered', jobBase),
      ...opPair('op3', 'bash-3'),
      userRoot('渲染完检查产物。'),
      env('job/settled', { ...jobBase, finishedAt: 2, status: 'killed', cause: 'kill', producerReported: true }),
      env('job/registered', { ...jobBase, jobId: 'bash-4' }),
      ...opPair('op4', 'bash-4'),
      env('job/settled', { ...jobBase, jobId: 'bash-4', finishedAt: 3, status: 'failed', cause: 'producer', producerReported: false }),
    ]
    const { projection } = derive(events)
    expect(projection.externalOperations.get('bash-3')?.status).toBe('failed')
    expect(projection.externalOperations.get('bash-4')?.status).toBe('failed')
    expect(projection.jobLifecycle?.get('bash-3')?.owner).toBe('original-session')
  })

  it('fails closed on a settled-without-registered log, malformed rows, and conflicting facts', () => {
    reset()
    const base = { jobId: 'bash-5', owner: 'rc021', kind: 'bash', label: 'x', startedAt: 1 }
    const orphan = derive([env('job/settled', { ...base, finishedAt: 2, status: 'completed', cause: 'producer', producerReported: true })])
    expect(orphan.projection.integrity).toBe('corrupt')
    expect(orphan.projection.integrityViolations).toContain('job_settled_unregistered')
    const malformed = derive([env('job/registered', { ...base, jobId: '' })])
    expect(malformed.projection.integrity).toBe('corrupt')
    expect(malformed.projection.integrityViolations).toContain('job_lifecycle_invalid')
    const badSettle = derive([
      env('job/registered', base),
      env('job/settled', { ...base, finishedAt: 2, status: 'completed', cause: 'producer', producerReported: 'yes' }),
    ])
    expect(badSettle.projection.integrityViolations).toContain('job_lifecycle_invalid')
    const conflict = derive([
      env('job/registered', base),
      env('job/settled', { ...base, finishedAt: 2, status: 'killed', cause: 'kill', producerReported: true }),
      env('job/settled', { ...base, finishedAt: 3, status: 'completed', cause: 'producer', producerReported: true }),
    ])
    expect(conflict.projection.integrityViolations).toContain('job_settled_conflict')
    const reRegistered = derive([
      env('job/registered', base),
      env('job/registered', { ...base, owner: 'someone-else' }),
    ])
    expect(reRegistered.projection.integrityViolations).toContain('job_registered_conflict')
    // Pre-0.2.1 logs carry no job events and no jobLifecycle map at all.
    reset()
    expect(derive([userRoot('普通任务。')]).projection.jobLifecycle).toBeUndefined()
  })
})

describe('CG021-04: plugin records and foreign events stay ignorable, seq-stable, non-capturing', () => {
  it('plugin: records interleaved around a tool pair never break pairing or capture', () => {
    reset()
    const events = [
      userRoot('修复 src/app.ts。'),
      env('plugin:other-plugin/state', { note: 'experimental record', ignored: true }),
      env('tool/call', { turn: 1, step: 1, callId: 'e1', name: 'edit', arguments: JSON.stringify({ file_path: '/work/repo/src/app.ts', old_string: 'a', new_string: 'b' }) }),
      env('plugin:another/ledger', { seq: 'between call and result' }),
      env('tool/result', { turn: 1, step: 1,
        message: createToolResultMessage({ callId: 'e1' as never, content: [{ type: 'text', text: 'ok' }], isError: false }) }),
      env('plugin:x/y', { tail: true }),
    ]
    const { projection } = derive(events)
    expect(projection.integrity).toBe('valid')
    // The call/result pair is matched by callId, not adjacency: the interleaved
    // records do not orphan the evidence.
    expect([...projection.evidence.values()].filter((fact) => fact.callId === 'e1')).toHaveLength(1)
    // A record is not a user instruction: nothing is captured FROM its payload.
    expect([...projection.items.values()].every((item) => !item.normalizedText.includes('experimental record'))).toBe(true)
    expect([...projection.evidence.values()].every((fact) => fact.callId !== 'between call and result')).toBe(true)
  })

  it('team inbox and required-but-unhandled host events neither capture nor corrupt', () => {
    reset()
    const events = [
      userRoot('整理目录后运行 npm test。'),
      env('team/member', { memberId: 'm1', role: 'peer' }),
      env('team/message/queued', { messageId: 'q1', toMember: 'm1' }),
      env('team/message/delivered', { messageId: 'q1', inboxSeq: 5 }),
      env('agent/inbox/spliced', { count: 1 }),
      env('subagent/catalog', { entries: [] }),
      env('turn/start', { turn: 1 }),
      env('assistant/message', { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: '完成。' }] } }),
      env('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    const { projection } = derive(events)
    expect(projection.integrity).toBe('valid')
    expect(projection.checkpoints).toHaveLength(0)
    // Reception is not completion: the direct-inbox delivery left the
    // obligation open exactly as the older outbox world did.
    expect([...projection.items.values()].some((item) => item.status === 'pending')).toBe(true)
  })

  it('snapshot envelope checks keep counting unknown types, so seq continuity is preserved', () => {
    reset()
    const events = [
      userRoot('任务。'),
      env('future-host/required-event', { v: 1 }),
      env('plugin:namespaced/record', { v: 2 }),
    ]
    const { projection } = derive(events)
    expect(projection.integrity).toBe('valid')
  })
})

describe('CG021-05: subagent completion stays bounded; Goal pause never completes', () => {
  it('a 0.2.1 `subagent` tool result is bounded evidence and never closes the parent obligation', () => {
    reset()
    const events = [
      userRoot('父任务：整理仓库并运行 npm test。'),
      env('turn/start', { turn: 1 }),
      env('tool/call', { turn: 1, step: 1, callId: 'sub1', name: 'subagent', arguments: JSON.stringify({ prompt: 'run tests' }) }),
      env('tool/result', { turn: 1, step: 1,
        message: createToolResultMessage({ callId: 'sub1' as never, content: [{ type: 'text', text: 'all tests passed' }], isError: false }) }),
      env('assistant/message', { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: '子代理已全部完成。' }] } }),
      env('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    const { projection } = derive(events)
    const fact = [...projection.evidence.values()].find((entry) => entry.callId === 'sub1')
    expect(fact?.delegatedSubtask).toBe(true)
    const item = [...projection.items.values()].find((entry) => entry.normalizedText.includes('npm test'))
    expect(item?.status).toBe('pending')
    expect(projection.checkpoints).toHaveLength(0)
  })

  it('a paused goal with an assistant completion claim records no completion certificate', () => {
    reset()
    const events = [
      userRoot('迁移数据库。'),
      env('goal/change', { operation: 'edit', phase: 'active', goal: { id: 'g1', revision: 2, objective: 'migrate', phase: 'active', maxGoalRounds: 3, version: 1, roundsStarted: 1, createdAt: 1, updatedAt: 2 } }),
      env('goal/change', { operation: 'edit', phase: 'paused', goal: { id: 'g1', revision: 3, objective: 'migrate', phase: 'paused', maxGoalRounds: 3, version: 1, roundsStarted: 1, createdAt: 1, updatedAt: 3 } }),
      env('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '迁移已经完成，可以结束了。' }] } }),
      env('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    const { projection } = derive(events)
    expect(projection.currentGoalPhase).toBe('paused')
    expect(projection.checkpoints).toHaveLength(0)
    expect(projection.integrity).toBe('valid')
  })
})

describe('CG021-06: cwd epochs bind evidence identity to the committed timeline', () => {
  it('builds epochs, collapses no-op repeats, and fails closed on an unreadable change', () => {
    const epochs = cwdEpochsFromEvents([
      { seq: 1, type: 'user/message', data: {} },
      { seq: 2, type: WORKING_DIRECTORY_CHANGE_EVENT, data: { cwd: '/work/other' } },
      // A no-op change to the already-effective directory adds no epoch.
      { seq: 3, type: WORKING_DIRECTORY_CHANGE_EVENT, data: { cwd: '/work/other' } },
      { seq: 4, type: WORKING_DIRECTORY_CHANGE_EVENT, data: { cwd: 'D:\\work\\win' } },
    ], '/work/repo')
    expect(epochs).toEqual([
      { seq: 2, cwd: '/work/other' },
      { seq: 4, cwd: 'D:\\work\\win' },
    ])
    expect(effectiveCwdAt(epochs, '/work/repo', 1)).toBe('/work/repo')
    expect(effectiveCwdAt(epochs, '/work/repo', 2)).toBe('/work/other')
    expect(effectiveCwdAt(epochs, '/work/repo', 3)).toBe('/work/other')
    expect(effectiveCwdAt(epochs, '/work/repo', 4)).toBe('D:\\work\\win')
    expect(effectiveCwdAt(epochs, '/work/repo', 99)).toBe('D:\\work\\win')
    // No change events: an empty timeline — the header governed everywhere and
    // derive publishes no cwdEpochs at all for such logs.
    expect(cwdEpochsFromEvents([{ seq: 1, type: 'user/message', data: {} }], '/work/repo')).toEqual([])
    for (const bad of [{ cwd: '' }, { cwd: 7 }, { cwd: 'relative/path' }]) {
      expect(cwdEpochsFromEvents([{ seq: 1, type: WORKING_DIRECTORY_CHANGE_EVENT, data: bad }], '/work/repo')).toBeUndefined()
    }
  })

  it('derives per-epoch captures: pre-change roots keep the header base, post-change roots bind the new base', () => {
    reset()
    const events = [
      env('user/message',
        { source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }] }),
      userRoot('修复 src/a.ts 并总结。'),
      env('working-directory/change', { cwd: '/work/other' }),
      userRoot('修复 src/b.ts。'),
    ]
    const { projection } = derive(events)
    expect(projection.cwdEpochs).toEqual([{ seq: 3, cwd: '/work/other' }])
    const baseBySeq = (text: string): string | undefined => {
      const item = [...projection.items.values()].find((entry) => entry.normalizedText.includes(text))
      const rootSeq = /^m(\d+)/u.exec(item!.sourceMessageId)
      return projection.rootLocatorContexts.get(Number(rootSeq![1]))?.base
    }
    expect(baseBySeq('src/a.ts')).toBe('/work/repo')
    expect(baseBySeq('src/b.ts')).toBe('/work/other')
  })

  it('corrupts the projection on a malformed working-directory change', () => {
    reset()
    const { projection } = derive([
      userRoot('任务。'),
      env('working-directory/change', { cwd: 'not-absolute' }),
    ])
    expect(projection.integrity).toBe('corrupt')
    expect(projection.integrityViolations).toContain('working_directory_change_invalid')
  })

  it('emits a v1 receipt inside the header epoch and an epoch-bound v2 receipt after a change', () => {
    const headerDir = realpathSync(mkdtempSync(join(tmpdir(), 'rc021-header-')))
    const changedDir = realpathSync(mkdtempSync(join(tmpdir(), 'rc021-changed-')))
    try {
      const id = SessionId('rc021-workdir')
      const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, isSeeded: false, id, createdAt: 1, cwd: headerDir })
      const appendRaw = session.append.bind(session) as (type: string, data: unknown, options?: unknown) => unknown
      const append = (type: string, data: unknown, surface = false): void => {
        appendRaw(type, data, surface ? { surfaceOp: 'append' } : undefined)
      }
      append('user/message', createUserMessage({ content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }],
        source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice', summary: 'v6' } }), true)
      append('turn/start', { turn: 1 })
      append('user/message', createUserMessage({ content: [{ type: 'text', text: `Run npm test in ${headerDir}.` }],
        source: { kind: 'user' } }), true)
      const makeExec = (callId: string): unknown => ({ agent: { session }, callId, rootCallId: callId, name: 'bash',
        arguments: { command: 'npm test' }, signal: new AbortController().signal })
      const policy = { resolve: () => ({ sessionId: id, workspaceRoot: headerDir }) }
      appendRaw('tool/call', { turn: 1, step: 1, callId: 'w1', name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) })
      const v1Receipt = captureHostWorkdir(session, makeExec('w1') as never, HOST_WITH_RENDERER, policy, true)
      appendRaw('user/message', createUserMessage({
        content: [{ type: 'text', text: `${HOST_WORKDIR_PREFIX}${JSON.stringify(v1Receipt)}` }],
        source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice', summary: 'call-time workdir' },
      }), { surfaceOp: 'append' })
      expect(v1Receipt?.version).toBe(1)
      expect(v1Receipt?.headerCwd).toBe(headerDir)
      expect(v1Receipt?.effectiveCwd).toBe(headerDir)
      expect(v1Receipt?.originCwd).toBeUndefined()
      const changeSeq = (appendRaw(WORKING_DIRECTORY_CHANGE_EVENT, { cwd: changedDir }) as { seq: number }).seq
      append('user/message', createUserMessage({ content: [{ type: 'text', text: `再跑一次 npm test。` }],
        source: { kind: 'user' } }), true)
      const args2 = JSON.stringify({ command: 'npm test' })
      appendRaw('tool/call', { turn: 1, step: 2, callId: 'w2', name: 'bash', arguments: args2 })
      const exec2 = { agent: { session }, callId: 'w2', rootCallId: 'w2', name: 'bash',
        arguments: { command: 'npm test' }, signal: new AbortController().signal }
      const v2Receipt = captureHostWorkdir(session, exec2 as never, HOST_WITH_RENDERER, policy, true)
      expect(v2Receipt?.version).toBe(2)
      expect(v2Receipt?.effectiveCwd).toBe(changedDir)
      expect(v2Receipt?.originCwd).toBe(headerDir)
      expect(v2Receipt?.cwdEpochSeq).toBe(changeSeq)
      // Replay: the v2 notice re-validates against the SAME log...
      appendRaw('tool/result', { turn: 1, step: 2,
        message: createToolResultMessage({ callId: 'w2' as never, content: [{ type: 'text', text: 'ok' }], isError: false }) }, { surfaceOp: 'append' })
      appendRaw('user/message', createUserMessage({
        content: [{ type: 'text', text: `${HOST_WORKDIR_PREFIX}${JSON.stringify(v2Receipt)}` }],
        source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice', summary: 'call-time workdir' },
      }), { surfaceOp: 'append' })
      const snapshot = snapshotSessionEvents(session) as never
      const call2 = (snapshot as DerivedEnvelope[]).find((event) => event.type === 'tool/call'
        && (event.data as Record<string, unknown>).callId === 'w2')!
      const result2 = (snapshot as DerivedEnvelope[]).find((event) => event.type === 'tool/result')!
      const root2Seq = Math.max(...(snapshot as DerivedEnvelope[]).filter((event) => event.type === 'user/message'
        && ((event.data as Record<string, unknown>).source as Record<string, unknown>)?.kind === 'user').map((event) => event.seq))
      const replayed = hostWorkdirForCall(snapshot, call2, result2,
        root2Seq, (v2Receipt as { sessionRefDigest: string }).sessionRefDigest, HOST_WITH_RENDERER.digest, changedDir)
      expect(replayed).toBe(changedDir)
      // ...and a v2 notice copied next to DIFFERENT directory history cannot.
      const tampered = hostWorkdirForCall([{ seq: 1, type: 'user/message', data: {} } as never],
        { seq: 2, type: 'tool/call', data: { callId: 'w2', name: 'bash', arguments: args2 } } as never,
        { seq: 3, type: 'tool/result', data: {} } as never,
        1, (v2Receipt as { sessionRefDigest: string }).sessionRefDigest, HOST.digest, changedDir)
      expect(tampered).toBeUndefined()
    } finally {
      rmSync(headerDir, { recursive: true, force: true })
      rmSync(changedDir, { recursive: true, force: true })
    }
  })
})
