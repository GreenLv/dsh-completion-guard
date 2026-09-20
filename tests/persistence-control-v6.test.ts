import { describe, expect, it } from 'vitest'
import { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createRuntime, handleGuardTurnStopping } from '../src/runtime.js'
import { PROTOCOL_V6_NOTICE } from '../src/domain/derive.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'
import { createTestReadinessObserver } from '../src/tools/observe.js'
import { currentActionBases, decideTurnBoundary } from '../src/domain/stop-policy.js'
import { sessionCoreSnapshot } from '../src/core-v2/session.js'
import { projectCoreV2 } from '../src/core-v2/project.js'

const HOST = { ...evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' }),
  auditedForegroundRenderers: ['bash' as const] }
let nextSession = 0

async function readySession(persistent: boolean, initialRoot?: string) {
  const id = SessionId(`v6-root-control-${++nextSession}`)
  const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, isSeeded: false, id, createdAt: 1, cwd: '/work' })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }],
    source: { kind: 'plugin', plugin: 'context-guard', form: 'notice', summary: 'v6' } }), { surfaceOp: 'append' })
  session.append('turn/start', { turn: 1 })
  const first = initialRoot ?? (persistent ? '运行 pnpm test。持续推进，直到本轮测试完成为止。' : '运行 pnpm test。')
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: first }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const steers: unknown[] = []
  const agent = { session, steer: (message: unknown) => steers.push(message) }
  const runtime = createRuntime(agent as never, { activation: 'always' } as never, HOST, () => {})
  runtime.setDurability(true)
  runtime.sync()
  const item = [...runtime.projection.items.values()].find((row) => row.semanticAction === 'test' && row.status === 'pending')!
  expect(item).toBeDefined()
  const manifest = '{"scripts":{"test":"vitest run"}}'
  const observer = createTestReadinessObserver({ getProjection: () => runtime.projection, flush: async () => true, fs: {
    resolve: async (path) => ({ displayPath: path }),
    stat: async () => ({ type: 'file', version: 'v1', size: manifest.length }),
    readText: async () => manifest,
  } })
  const observed = await observer.execute({ item_id: item.id }, { agent, signal: new AbortController().signal } as never) as Record<string, unknown>
  expect(observed.status).toBe('ready')
  session.append('tool/call', { turn: 1, step: 1, callId: 'ready-1' as never,
    name: 'context_guard_observe_test_readiness', arguments: JSON.stringify({ item_id: item.id }) })
  session.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId: 'ready-1' as never,
      content: [{ type: 'text', text: JSON.stringify(observed) }], isError: false }),
    meta: { contextGuardTestReadiness: { itemId: item.id, scope: observed.scope,
      manifestSha256: observed.manifest_sha256, predicate: 'test_passed' } },
  } as never, { surfaceOp: 'append' })
  session.append('assistant/message', { turn: 1, step: 2,
    message: { role: 'assistant', content: [{ type: 'text', text: 'The selected test has not run.' }] } } as never,
  { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } } as never)
  runtime.sync()
  expect(currentActionBases(runtime.projection)).toMatchObject([{ itemId: item.id, action: 'test' }])
  let turn = 1
  function root(text: string) {
    turn += 1
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    runtime.sync()
  }
  function end() {
    session.append('assistant/message', { turn, step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'The question has been answered.' }] } } as never,
    { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: 'completed' } } as never)
    runtime.sync()
  }
  async function stop() {
    return handleGuardTurnStopping(agent as never, runtime, {
      flush: async () => true, hostSupported: true, readExternalOperation: () => undefined,
    } as never)
  }
  function completeTest() {
    turn += 1
    session.append('turn/start', { turn })
    session.append('tool/call', { turn, step: 1, callId: 'completed-native-test' as never,
      name: 'bash', arguments: JSON.stringify({ command: 'pnpm test', workdir: '/work' }) })
    session.append('tool/result', { turn, step: 1,
      message: createToolResultMessage({ callId: 'completed-native-test' as never,
        content: [{ type: 'text', text: '10 tests passed' }], isError: false }),
    } as never, { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: 'completed' } } as never)
    runtime.sync()
  }
  return { session, runtime, item, steers, root, end, stop, completeTest }
}

describe('v6 persistence is scoped to the current root task at each Stop watermark', () => {
  it('continues one ready same-root task under a direct compound until-complete control', async () => {
    const run = await readySession(true, '运行 pnpm test。不要停止,一直推进直到完成。')
    const snapshot = sessionCoreSnapshot(run.session.snapshotEvents() as never, run.runtime.projection) as Record<string, unknown>
    const core = projectCoreV2(snapshot)
    expect((snapshot.requirements as Array<Record<string, unknown>>).map((row) => row.id)).toEqual([run.item.id])
    expect(core.root_control_errors).toEqual([])
    expect(core.unknown_coverage).toEqual([])
    expect(core.root_control_states).toMatchObject({ [run.item.id]: 'persistent' })
    run.root('顺便解释一下这个函数为什么要处理空输入？')
    run.end()
    expect(await run.stop()).toBe('explicit_user_persistence')
    expect(run.steers).toHaveLength(1)
    const completedRun = await readySession(true, '运行 pnpm test。不要停止,一直推进直到完成。')
    completedRun.completeTest()
    const completed = sessionCoreSnapshot(completedRun.session.snapshotEvents() as never, completedRun.runtime.projection) as Record<string, unknown>
    const completeCore = projectCoreV2(completed)
    expect(completeCore.predicates).toMatchObject({ [completedRun.item.id]: 'satisfied' })
    expect(completeCore.certifiable).toBe(true)
  })

  it('keeps an explicitly scoped whole-task control across an information interlude', async () => {
    const run = await readySession(true, '运行 pnpm test。持续推进，直到当前任务完成。')
    const before = sessionCoreSnapshot(run.session.snapshotEvents() as never, run.runtime.projection) as Record<string, unknown>
    expect(before.root_controls).toMatchObject([{ kind: 'persistence' }])
    run.root('顺便解释一下这个函数为什么要处理空输入？')
    run.end()
    expect(await run.stop()).toBe('explicit_user_persistence')
    expect(run.steers).toHaveLength(1)
  })

  it('does not backfill a later host-selected test target into an earlier control receipt', async () => {
    const run = await readySession(true)
    const snapshot = sessionCoreSnapshot(run.session.snapshotEvents() as never, run.runtime.projection) as Record<string, unknown>
    const persistence = (snapshot.root_controls as Array<Record<string, unknown>>)
      .find((control) => control.kind === 'persistence')!
    expect(persistence).toBeDefined()
    expect((persistence.controlled_requirements as Array<Record<string, unknown>>)[0]?.target).toBeNull()
  })

  it('retains an old control receipt across a later root supersession without selecting the old item again', async () => {
    const run = await readySession(true)
    const before = sessionCoreSnapshot(run.session.snapshotEvents() as never, run.runtime.projection) as Record<string, unknown>
    expect((before.requirements as Array<Record<string, unknown>>).find((req) => req.id === run.item.id))
      .not.toHaveProperty('superseded_at_seq')
    run.root('运行 pnpm test。')
    const replacement = [...run.runtime.projection.items.values()].find((item) => item.id !== run.item.id
      && item.semanticAction === 'test' && item.status === 'pending')
    expect(run.runtime.projection.items.get(run.item.id)?.status).toBe('superseded')
    expect(replacement).toBeDefined()
    run.root('暂停本轮任务。')
    const snapshot = sessionCoreSnapshot(run.session.snapshotEvents() as never, run.runtime.projection) as Record<string, unknown>
    const controls = snapshot.root_controls as Array<Record<string, unknown>>
    const requirements = snapshot.requirements as Array<Record<string, unknown>>
    const predecessor = requirements.find((req) => req.id === run.item.id)!
    const successor = requirements.find((req) => req.id === replacement!.id)!
    expect(predecessor).toMatchObject({ status: 'superseded', supersession_source_id: (successor.source as Record<string, unknown>).source_id,
      superseded_at_seq: successor.seq, superseded_by_requirement_id: successor.id })
    expect(Number(successor.revision)).toBeGreaterThan(Number(predecessor.revision))
    const first = controls.find((control) => control.kind === 'persistence')!
    const pause = controls.find((control) => control.kind === 'pause')!
    expect((first.controlled_requirements as Array<Record<string, unknown>>).map((ref) => ref.requirement_id)).toEqual([run.item.id])
    expect((pause.controlled_requirements as Array<Record<string, unknown>>).map((ref) => ref.requirement_id)).toEqual([replacement!.id])
  })

  it('binds a named test control to the test action class rather than the whole work unit', async () => {
    const run = await readySession(true)
    run.root('先暂停本轮测试。')
    const snapshot = sessionCoreSnapshot(run.session.snapshotEvents() as never, run.runtime.projection) as Record<string, unknown>
    const pause = (snapshot.root_controls as Array<Record<string, unknown>>)
      .find((control) => control.kind === 'pause')!
    expect(pause).toBeDefined()
    expect(pause.scope_basis).toMatchObject({ kind: 'action_class', target: 'test_verify' })
    expect((pause.controlled_requirements as Array<Record<string, unknown>>).map((ref) => ref.requirement_id)).toEqual([run.item.id])
  })

  it('preserves an earlier scoped persistence instruction across a pure question, only for a ready unmet action', async () => {
    const run = await readySession(true)
    run.root('顺便解释一下这个函数为什么要处理空输入？')
    run.end()
    expect(currentActionBases(run.runtime.projection)).toMatchObject([{ itemId: run.item.id }])
    expect(await run.stop()).toBe('explicit_user_persistence')
    expect(run.steers).toHaveLength(1)
  })

  it('does not infer persistence from the same ready task and informational interlude', async () => {
    const run = await readySession(false)
    run.root('顺便解释一下这个函数为什么要处理空输入？')
    run.end()
    expect(await run.stop()).toBe('safe_yield_pending_preserved')
    expect(run.steers).toHaveLength(0)
  })

  it.each([
    '先暂停本轮测试，只解释一下这个函数为什么要处理空输入。',
    '取消本轮测试，只解释一下这个函数为什么要处理空输入。',
  ])('honors a later root control over the older persistence: %s', async (control) => {
    const run = await readySession(true)
    run.root(control)
    run.end()
    expect(await run.stop()).toBe('safe_yield_pending_preserved')
    expect(run.steers).toHaveLength(0)
  })

  it('a later explicit resume reopens only a paused ready task, without rewriting the paused Stop', async () => {
    const run = await readySession(true)
    run.root('先暂停本轮测试，只解释一下这个函数为什么要处理空输入。')
    run.end()
    expect(await run.stop()).toBe('safe_yield_pending_preserved')
    run.root('继续。')
    expect(decideTurnBoundary(run.runtime.projection, '继续。')).toMatchObject({ action: 'continue', reason: 'resume_with_actionable_work' })
  })

  it('a bare Continue does not restore a cancelled task', async () => {
    const run = await readySession(true)
    run.root('取消本轮测试，只解释一下这个函数为什么要处理空输入。')
    run.end()
    expect(await run.stop()).toBe('safe_yield_pending_preserved')
    run.root('继续。')
    expect(await run.stop()).toBe('safe_yield_pending_preserved')
  })
})

describe('v6 repair child relations come from the original root coordination', () => {
  async function snapshotFor(text: string, later?: string, mutate?: (runtime: ReturnType<typeof createRuntime>) => void) {
    const id = SessionId(`v6-root-relation-${++nextSession}`)
    const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, isSeeded: false, id, createdAt: 1, cwd: '/work' })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }],
      source: { kind: 'plugin', plugin: 'context-guard', form: 'notice', summary: 'v6' } }), { surfaceOp: 'append' })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const runtime = createRuntime({ session, steer: () => {} } as never, { activation: 'always' } as never, HOST, () => {})
    runtime.setDurability(true)
    runtime.sync()
    if (later) {
      session.append('turn/start', { turn: 2 })
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: later }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      runtime.sync()
    }
    mutate?.(runtime)
    return sessionCoreSnapshot(session.snapshotEvents() as never, runtime.projection) as Record<string, unknown>
  }

  it.each([
    ['修改 /work/A.ts 并运行针对 /work/A.ts 的测试。', true],
    ['修改 /work/A.ts 并运行测试。', true],
    ['修改 /work/A.ts 并运行针对 /work/B.ts 的测试。', false],
    ['修改 /work/A.ts 并运行针对 /work/../work/A.ts 的测试。', false],
  ])('binds only a directly coordinated same-object test to its edit parent: %s', async (root, bound) => {
    const snapshot = await snapshotFor(root)
    const reqs = snapshot.requirements as Array<Record<string, unknown>>
    const edit = reqs.find((req) => req.action === 'local_edit' || req.action === 'modify')
    const test = reqs.find((req) => req.action === 'test_verify')
    expect(edit).toBeDefined()
    expect(test).toBeDefined()
    expect(test!.parent_id).toBe(bound ? edit!.id : null)
  })

  it('scopes a later repair pause to its original edit and required test, excluding an unrelated same-unit test', async () => {
    const snapshot = await snapshotFor('修改 /work/A.ts 并运行测试。运行 pnpm test。', '暂停这项修复。')
    const reqs = snapshot.requirements as Array<Record<string, unknown>>
    const edit = reqs.find((req) => req.action === 'local_edit')!
    const child = reqs.find((req) => req.parent_id === edit.id)!
    const unrelated = reqs.find((req) => req.action === 'test_verify' && req.parent_id === null)!
    expect(edit).toBeDefined()
    expect(child).toBeDefined()
    expect(unrelated).toBeDefined()
    const pause = (snapshot.root_controls as Array<Record<string, unknown>>).find((row) => row.kind === 'pause')!
    expect(pause.scope_basis).toMatchObject({ kind: 'parent_task', target: edit.id })
    expect((pause.controlled_requirements as Array<Record<string, unknown>>).map((row) => row.requirement_id).sort())
      .toEqual([edit.id, child.id].sort())
    const core = projectCoreV2(snapshot)
    expect(core.root_control_errors).toEqual([])
    expect(core.root_control_states).toMatchObject({ [edit.id as string]: 'paused', [child.id as string]: 'paused' })
  })

  it('keeps more than one directly coordinated required test in the same repair closure', async () => {
    const snapshot = await snapshotFor('修改 /work/A.ts，并运行测试，并执行回归测试。', '暂停这项修复。')
    const reqs = snapshot.requirements as Array<Record<string, unknown>>
    const edit = reqs.find((req) => req.action === 'local_edit')!
    const children = reqs.filter((req) => req.parent_id === edit?.id)
    expect(edit).toBeDefined()
    expect(children).toHaveLength(2)
    const pause = (snapshot.root_controls as Array<Record<string, unknown>>).find((row) => row.kind === 'pause')!
    expect((pause.controlled_requirements as Array<Record<string, unknown>>)).toHaveLength(3)
    expect(projectCoreV2(snapshot).root_control_errors).toEqual([])
  })

  it('binds a compound until-complete control to one repair with multiple required tests', async () => {
    const snapshot = await snapshotFor('修改 /work/A.ts，并运行针对 /work/A.ts 的测试，并执行针对 /work/A.ts 的回归测试，不要停止,一直推进直到完成。')
    const reqs = snapshot.requirements as Array<Record<string, unknown>>
    const controls = snapshot.root_controls as Array<Record<string, unknown>>
    const parent = reqs.find((row) => row.action === 'local_edit')!
    const children = reqs.filter((row) => row.parent_id === parent?.id)
    const persistence = controls.find((row) => row.kind === 'persistence')!
    expect(children).toHaveLength(2)
    expect(reqs.filter((row) => row.kind === 'execution')).toHaveLength(3)
    expect(reqs.some((row) => row.kind === 'unknown')).toBe(false)
    expect((persistence.controlled_requirements as Array<Record<string, unknown>>)).toHaveLength(3)
    expect(projectCoreV2(snapshot).root_control_errors).toEqual([])
  })

  it('does not bind a compound omitted-object control to two independent root tasks', async () => {
    const snapshot = await snapshotFor('运行 pnpm test。运行 npm test。不要停止,一直推进直到完成。')
    const requirements = (snapshot.requirements as Array<Record<string, unknown>>)
      .filter((row) => row.kind === 'execution')
    expect(requirements).toHaveLength(2)
    const persistence = (snapshot.root_controls as Array<Record<string, unknown>>)
      .find((row) => row.kind === 'persistence')!
    expect(persistence).toBeDefined()
    expect(projectCoreV2(snapshot).root_control_errors).toContain(persistence.id)
  })

  it('does not erase a separate business clause after a compound control', async () => {
    const snapshot = await snapshotFor('运行 pnpm test。不要停止,一直推进直到完成。发布包。')
    const reqs = snapshot.requirements as Array<Record<string, unknown>>
    expect(reqs.some((row) => row.action === 'test_verify')).toBe(true)
    expect(reqs.some((row) => row.kind === 'execution' && row.action === 'publish')).toBe(true)
    expect(projectCoreV2(snapshot).certifiable).toBe(false)
  })

  it('does not turn a quoted compound phrase into a root persistence fact', async () => {
    const snapshot = await snapshotFor('运行 pnpm test。日志写着“不要停止,一直推进直到完成”。')
    expect((snapshot.root_controls as Array<Record<string, unknown>>).some((row) => row.kind === 'persistence')).toBe(false)
    expect((snapshot.requirements as Array<Record<string, unknown>>).some((row) => row.action === 'test_verify')).toBe(true)
  })

  it('keeps a deleted sibling root visible as unknown coverage, not a smaller certifiable current-unit catalog', async () => {
    const snapshot = await snapshotFor('修改 /work/A.ts 并运行测试。运行 pnpm test。', '取消当前任务。', (runtime) => {
      const sibling = [...runtime.projection.items.values()].find((item) => item.semanticAction === 'test'
        && item.normalizedText.includes('pnpm test'))!
      expect(sibling).toBeDefined()
      runtime.projection.items.delete(sibling.id)
    })
    expect((snapshot.coverage as Array<Record<string, unknown>>).some((part) => part.kind === 'unknown')).toBe(true)
    expect(projectCoreV2(snapshot).certifiable).toBe(false)
  })

  it('does not trust a current-unit control after every duty from an independent later root is removed', async () => {
    const snapshot = await snapshotFor('修改 /work/A.ts。', '运行 pnpm test。取消当前任务。', (runtime) => {
      const later = [...runtime.projection.items.values()].filter((item) => item.semanticAction === 'test')
      expect(later).toHaveLength(1)
      runtime.projection.items.delete(later[0]!.id)
    })
    expect((snapshot.coverage as Array<Record<string, unknown>>).some((part) => part.kind === 'unknown')).toBe(true)
    expect(projectCoreV2(snapshot).certifiable).toBe(false)
  })

  it('refuses a projection that drops both an independent root duty and its unit-ledger reference', async () => {
    const snapshot = await snapshotFor('修改 /work/A.ts。', '运行 pnpm test。取消当前任务。', (runtime) => {
      const later = [...runtime.projection.items.values()].find((item) => item.semanticAction === 'test')!
      runtime.projection.items.delete(later.id)
      const current = runtime.projection.units.get(runtime.projection.currentUnitId!)!
      current.rootInputRefs = current.rootInputRefs.filter((ref) => ref.seq !== 4)
    })
    expect(snapshot).toBeUndefined()
  })

  it('does not accept a forged later different-target root as trusted supersession', async () => {
    const snapshot = await snapshotFor('修改 /work/A.ts。', '修改 /work/B.ts。', (runtime) => {
      const rows = [...runtime.projection.items.values()].filter((item) => item.semanticAction === 'modify')
      expect(rows).toHaveLength(2)
      rows[0]!.status = 'superseded'
      rows[0]!.supersededBy = rows[1]!.id
    })
    const rows = snapshot.requirements as Array<Record<string, unknown>>
    const older = rows.find((req) => req.target === '/work/A.ts')!
    expect(older.status).toBe('superseded')
    expect(older.superseded_at_seq).toBeUndefined()
    expect(projectCoreV2(snapshot).certifiable).toBe(false)
  })

  it('does not turn a later same-target action with different root wording into an old-duty replacement', async () => {
    const snapshot = await snapshotFor('修改 /work/A.ts。', '再次修改 /work/A.ts。', (runtime) => {
      const rows = [...runtime.projection.items.values()].filter((item) => item.kind === 'requirement')
      expect(rows).toHaveLength(2)
      rows[0]!.status = 'superseded'
      rows[0]!.supersededBy = rows[1]!.id
      rows[1]!.semanticAction = 'modify'
      rows[1]!.authorityDisposition = 'executable_now'
      rows[1]!.requestedTarget = { artifact_id: '/work/A.ts' }
    })
    const older = (snapshot.requirements as Array<Record<string, unknown>>)
      .find((req) => req.source && (req.source as Record<string, unknown>).source_id === 'root:2')!
    expect(older.status).toBe('superseded')
    expect(older.superseded_at_seq).toBeUndefined()
    expect(projectCoreV2(snapshot).certifiable).toBe(false)
  })

  it('does not use current-unit cancellation to erase a separate explicit-proof obligation', async () => {
    const snapshot = await snapshotFor('修改 /work/A.ts 并运行测试。', '取消当前任务。', (runtime) => {
      const proof = [...runtime.projection.items.values()].find((item) => item.semanticAction === 'test')!
      proof.verification.surface = 'visual'
    })
    const reqs = snapshot.requirements as Array<Record<string, unknown>>
    const proof = reqs.find((row) => row.kind === 'proof')!
    const edit = reqs.find((row) => row.action === 'local_edit')!
    expect(proof).toMatchObject({ status: 'pending' })
    const cancel = (snapshot.root_controls as Array<Record<string, unknown>>).find((row) => row.kind === 'cancel')!
    expect((cancel.controlled_requirements as Array<Record<string, unknown>>).map((row) => row.requirement_id))
      .toEqual([edit.id])
    expect(projectCoreV2(snapshot).root_control_states).toMatchObject({ [edit.id as string]: 'cancelled' })
    expect((projectCoreV2(snapshot).root_control_states as Record<string, unknown>)[proof.id as string]).toBeUndefined()
  })
})
