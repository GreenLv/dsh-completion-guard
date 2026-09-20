import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { createNativeFileObserver, createNativeGitObserver, createTestReadinessObserver } from '../src/tools/observe.js'
import { deriveProjection } from '../src/domain/derive.js'
import { certifyCheckpoint } from '../src/domain/checkpoint.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'
import { goalCompletionDenial } from '../src/domain/goal-gate.js'
import { currentActionBases, decideTurnBoundary } from '../src/domain/stop-policy.js'
import { createCheckpointTool } from '../src/tools/checkpoint.js'
import { createPrepareTool } from '../src/tools/prepare.js'
import { projectSessionCoreV2 } from '../src/core-v2/session.js'
import { requestedTargetMatchesResolved } from '../src/domain/protocol-manifest.js'

const HOST = { ...evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' }),
  auditedForegroundRenderers: ['bash' as const] }
const gitExec = promisify(execFile)
function appendCall(session: Session, id: string, name: string, args: object): void {
  session.append('tool/call', { turn: 1, step: 1, callId: id as never, name, arguments: JSON.stringify(args) })
}
function appendResult(session: Session, id: string, text: string, meta?: JsonValue): void {
  session.append('tool/result', {
    turn: 1, step: 1,
    message: createToolResultMessage({ callId: id as never, content: [{ type: 'text', text }], isError: false }),
    ...(meta ? { meta } : {}),
  }, { surfaceOp: 'append' })
}

describe('native host file result and independent readback', () => {
  it('does not treat an always-on observation profile as Goal completion adoption', () => {
    const session = Session.create(SessionId('native-goal-observation'), undefined, { version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId('native-goal-observation'), createdAt: 1, cwd: '/work' })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Context Guard protocol boundary: v6.0.0' }], source: { kind: 'plugin', plugin: 'context-guard', form: 'notice', summary: 'v6' } }), { surfaceOp: 'append' })
    const observed = deriveProjection(session.snapshotEvents() as never, { activation: 'always' }, { cwd: '/work' }, true, HOST).projection
    observed.currentGoalRef = { id: 'g', revision: 1 }
    expect(observed.enabled).toBe(true)
    expect(observed.goalCompletionAdopted).toBe(false)
    expect(goalCompletionDenial(observed, 'update_goal', { action: 'complete', goal_id: 'g', revision: 1 })).toBeUndefined()
    session.append('command/run', { commandId: 'adopt' as never, name: 'context-guard', args: 'on', source: { kind: 'user' } })
    const adopted = deriveProjection(session.snapshotEvents() as never, { activation: 'always' }, { cwd: '/work' }, true, HOST).projection
    adopted.currentGoalRef = { id: 'g', revision: 1 }
    expect(adopted.goalCompletionAdopted).toBe(true)
    expect(goalCompletionDenial(adopted, 'update_goal', { action: 'complete', goal_id: 'g', revision: 1 })).toContain('certificate_missing')
  })
  it('certifies an observed edit without a Guard execution qualification or resolution call', async () => {
    const session = Session.create(SessionId('native-file-v2'), undefined, { version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId('native-file-v2'), createdAt: 1, cwd: '/work' })
    session.append('command/run', { commandId: 'on' as never, name: 'context-guard', args: 'on', source: { kind: 'user' } })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Context Guard protocol boundary: v6.0.0' }], source: { kind: 'plugin', plugin: 'context-guard', form: 'notice', summary: 'v6' } }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Modify /work/alpha.txt.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    appendCall(session, 'edit-1', 'edit', { file_path: '/work/alpha.txt', old_string: 'before', new_string: 'after' })
    appendResult(session, 'edit-1', 'edited')
    const content = 'after\n'
    const observer = createNativeFileObserver({ flush: async () => true, fs: {
      resolve: async (path) => ({ displayPath: path }),
      stat: async () => ({ type: 'file', version: 'v2', size: content.length }),
      readText: async () => content,
    } })
    const observed = await observer.execute({ effect_call_id: 'edit-1' }, { agent: { session }, signal: new AbortController().signal } as never) as { status: string; sha256: string; path: string; effect_call_id: string; action: string }
    expect(observed.status).toBe('observed')
    expect(observed.sha256).toBe(createHash('sha256').update(content).digest('hex'))
    appendCall(session, 'readback-1', 'context_guard_observe_file', { effect_call_id: 'edit-1' })
    appendResult(session, 'readback-1', JSON.stringify(observed), { contextGuardNativeFile: { effectCallId: observed.effect_call_id, path: observed.path, sha256: observed.sha256, action: observed.action } })
    const projection = deriveProjection(session.snapshotEvents() as never, { activation: 'opt-in' }, { cwd: '/work' }, true, HOST).projection
    projection.durabilityWatermark = 'confirmed'
    expect(projectSessionCoreV2(session.snapshotEvents() as never, projection)).toMatchObject({ predicates: { R001: 'satisfied' }, certifiable: true })
    const item = [...projection.items.values()].find((row) => row.semanticAction === 'modify')!
    expect(item).toBeDefined()
    const prepared = await createPrepareTool({ getProjection: () => projection }).execute({ item_id: item.id, item_revision: item.revision } as never, undefined as never) as Record<string, unknown>
    expect(prepared).toMatchObject({ status: 'observed', reason_code: 'ordinary_execution_host_owned' })
    expect(prepared).not.toHaveProperty('required_evidence_order')
    const effect = [...projection.evidence.values()].find((row) => row.callId === 'edit-1')!
    const state = [...projection.evidence.values()].find((row) => row.callId === 'readback-1')!
    projection.evidence.set(state.id, { ...state, causedByCallId: 'missing-effect' })
    expect(projectSessionCoreV2(session.snapshotEvents() as never, projection)).toMatchObject({ certifiable: false, predicates: { R001: 'insufficient' } })
    projection.evidence.set(state.id, state)
    projection.coreV2 = projectSessionCoreV2(session.snapshotEvents() as never, projection)
    const binding = { itemId: item.id, evidenceIds: [effect.id, state.id], semanticAction: 'modify' as const,
      requestedTarget: item.requestedTarget, resolvedTarget: { artifact_id: '/work/alpha.txt', scope: '/work' },
      observedState: { post_digest: observed.sha256 }, effectEvidenceId: effect.id, stateEvidenceIds: [state.id] }
    const result = certifyCheckpoint(projection, [binding], 'C-native', false)
    expect(result.status, JSON.stringify(result.rejectedBindings)).toBe('certified')
    expect(result.checkpoint).toMatchObject({ certificateVersion: '3', nativeObservations: { schema: 'dsh.native-observation/v1', digests: [expect.stringMatching(/^[0-9a-f]{64}$/)] } })
    const checkpointArgs = { bindings: [{ item_id: item.id, evidence_ids: [effect.id, state.id], semantic_action: 'modify',
      requested_target: item.requestedTarget, resolved_target: binding.resolvedTarget, observed_state: binding.observedState,
      effect_evidence_id: effect.id, state_evidence_ids: [state.id] }] }
    const checkpointTool = createCheckpointTool(() => projection, () => {})
    const materialized = await checkpointTool.execute(checkpointArgs as never, undefined as never) as { status: string; certificate: Record<string, unknown> }
    expect(materialized).toMatchObject({ status: 'certified', certificate: { native_observations: { schema: 'dsh.native-observation/v1' } } })
    appendCall(session, 'checkpoint-native', 'context_guard_checkpoint', checkpointArgs)
    appendResult(session, 'checkpoint-native', JSON.stringify(materialized))
    const replayed = deriveProjection(session.snapshotEvents() as never, { activation: 'opt-in' }, { cwd: '/work' }, true, HOST).projection
    expect(replayed.integrity, JSON.stringify(replayed.integrityViolations)).toBe('valid')
    expect(replayed.checkpoints.at(-1)?.certificateVersion).toBe('3')
    const broken = certifyCheckpoint(projection, [{ ...binding, stateEvidenceIds: [effect.id] }], 'C-broken', false)
    expect(broken.status).toBe('incomplete')
    const changedCause = { ...state, causedByCallId: 'different-edit' }
    projection.evidence.set(state.id, changedCause)
    expect(certifyCheckpoint(projection, [binding], 'C-tampered', false)).toMatchObject({ status: 'incomplete' })
    projection.evidence.set(state.id, { ...state, observedState: { post_digest: 'f'.repeat(64) } })
    expect(certifyCheckpoint(projection, [binding], 'C-changed-fact', false)).toMatchObject({ status: 'incomplete' })
  })
  it('certifies one foreground host test and rejects a partial compound result', () => {
    const make = (id: string, command: string, text: string) => {
      const session = Session.create(SessionId(id), undefined, { version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId(id), createdAt: 1, cwd: '/work' })
      session.append('command/run', { commandId: 'on' as never, name: 'context-guard', args: 'on', source: { kind: 'user' } })
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Context Guard protocol boundary: v6.0.0' }], source: { kind: 'plugin', plugin: 'context-guard', form: 'notice', summary: 'v6' } }), { surfaceOp: 'append' })
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Run pnpm test in /work.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      appendCall(session, 'test-1', 'bash', { command, workdir: '/work' })
      appendResult(session, 'test-1', text)
      const projection = deriveProjection(session.snapshotEvents() as never, { activation: 'opt-in' }, { cwd: '/work' }, true, HOST).projection
      const item = [...projection.items.values()].find((row) => row.semanticAction === 'test')!
      const effect = [...projection.evidence.values()].find((row) => row.callId === 'test-1')!
      const binding = { itemId: item.id, evidenceIds: [effect.id], semanticAction: 'test' as const,
        requestedTarget: item.requestedTarget, resolvedTarget: effect.resolvedTarget, observedState: {},
        expectedTransition: { predicateId: 'pred.test.outcome', version: 1 as const, predParamsKind: 'inline' as const, parameters: { expected_outcome: { k: 'e' as const, v: 'success' }, min_matches: 1 } },
        effectEvidenceId: effect.id }
      projection.durabilityWatermark = 'confirmed'
      projection.coreV2 = projectSessionCoreV2(session.snapshotEvents() as never, projection)
      return { projection, effect, binding, events: session.snapshotEvents() }
    }
    const good = make('native-test-good', 'pnpm test', '10 tests passed')
    expect(projectSessionCoreV2(good.events as never, good.projection)).toMatchObject({ predicates: { R001: 'satisfied' }, certifiable: true })
    expect(good.effect.processFacts).toMatchObject({ outcome: 'success', operationAttribution: 'single_operation' })
    const goodResult = certifyCheckpoint(good.projection, [good.binding], 'C-test', false)
    expect(goodResult, JSON.stringify(goodResult.rejectedBindings)).toMatchObject({ status: 'certified' })
    const bad = make('native-test-compound', 'false; pnpm test', '10 tests passed')
    expect(certifyCheckpoint(bad.projection, [bad.binding], 'C-compound', false)).toMatchObject({ status: 'incomplete' })
  })
  it('reads back a native commit and push from fixed Git queries after persisted results', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-native-git-'))
    const remote = join(root, 'origin.git'); const work = join(root, 'work')
    await gitExec('git', ['init', '--bare', remote]); await gitExec('git', ['init', '-b', 'main', work])
    await gitExec('git', ['-C', work, 'config', 'user.name', 'Fixture'])
    await gitExec('git', ['-C', work, 'config', 'user.email', 'fixture@example.invalid'])
    await gitExec('git', ['-C', work, 'remote', 'add', 'origin', remote])
    await writeFile(join(work, 'a.txt'), 'first\n'); await gitExec('git', ['-C', work, 'add', 'a.txt'])
    await gitExec('git', ['-C', work, 'commit', '-m', 'first'])
    await writeFile(join(work, 'a.txt'), 'second\n'); await gitExec('git', ['-C', work, 'add', 'a.txt'])
    const session = Session.create(SessionId('native-git-v2'), undefined, { version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId('native-git-v2'), createdAt: 1, cwd: work })
    session.append('command/run', { commandId: 'on' as never, name: 'context-guard', args: 'on', source: { kind: 'user' } })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `Commit changes in repository ${work}.` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    appendCall(session, 'native-commit', 'bash', { command: 'git commit -m second', workdir: work })
    const commitOutput = await gitExec('git', ['-C', work, 'commit', '-m', 'second'])
    appendResult(session, 'native-commit', commitOutput.stdout)
    const observer = createNativeGitObserver({ flush: async () => true })
    const commit = await observer.execute({ effect_call_id: 'native-commit' }, { agent: { session }, signal: new AbortController().signal } as never) as { status: string; post_oid: string; parent_oid: string; tree_oid: string }
    expect(commit, JSON.stringify(commit)).toMatchObject({ status: 'observed', post_oid: expect.stringMatching(/^[0-9a-f]{40}$/), parent_oid: expect.any(String), tree_oid: expect.any(String) })
    appendCall(session, 'git-readback', 'context_guard_observe_git', { effect_call_id: 'native-commit' })
    appendResult(session, 'git-readback', JSON.stringify(commit), { contextGuardNativeGit: {
      effectCallId: 'native-commit', action: 'commit', repository: work, branch: 'main', remote: '', refspec: '',
      postOid: commit.post_oid, parentOid: commit.parent_oid, treeOid: commit.tree_oid,
    } })
    const projection = deriveProjection(session.snapshotEvents() as never, { activation: 'opt-in' }, { cwd: work }, true, HOST).projection
    const item = [...projection.items.values()].find((row) => row.semanticAction === 'commit')!
    expect(item).toBeDefined()
    expect(item.requestedTarget?.repository, JSON.stringify(item.requestedTarget)).toBe(work)
    expect(requestedTargetMatchesResolved('commit', item.requestedTarget, { repository: work, branch: 'main' }),
      JSON.stringify({ requested: item.requestedTarget, resolved: { repository: work, branch: 'main' } })).toBe(true)
    const effect = [...projection.evidence.values()].find((row) => row.callId === 'native-commit')!
    const state = [...projection.evidence.values()].find((row) => row.callId === 'git-readback')!
    const commitBinding = { itemId: item.id, evidenceIds: [effect.id, state.id], semanticAction: 'commit' as const,
      requestedTarget: item.requestedTarget, resolvedTarget: { repository: work, branch: 'main' },
      observedState: { post_head_oid: commit.post_oid },
      effectEvidenceId: effect.id, stateEvidenceIds: [state.id] }
    const certified = certifyCheckpoint(projection, [commitBinding], 'C-native-git', false)
    expect(certified, JSON.stringify(certified.rejectedBindings)).toMatchObject({ status: 'certified' })
    expect(certifyCheckpoint(projection, [{ ...commitBinding, resolvedTarget: { repository: work, branch: 'other' } }], 'C-wrong-branch', false))
      .toMatchObject({ status: 'incomplete' })
    projection.evidence.set(state.id, { ...state, nativeGitTreeOid: 'f'.repeat(40) })
    const changedTree = certifyCheckpoint(projection, [commitBinding], 'C-changed-tree', false)
    expect(changedTree.status).toBe('certified')
    expect(changedTree.checkpoint?.certificationDigest).not.toBe(certified.checkpoint?.certificationDigest)
    projection.evidence.set(state.id, state)
    appendCall(session, 'amend-attempt', 'bash', { command: 'git commit -m second --amend', workdir: work })
    appendResult(session, 'amend-attempt', commitOutput.stdout)
    expect(await observer.execute({ effect_call_id: 'amend-attempt' }, { agent: { session }, signal: new AbortController().signal } as never))
      .toMatchObject({ status: 'unavailable', reason_code: 'native_git_effect_output_unbound' })
    const pushSession = Session.create(SessionId('native-push-v2'), undefined, { version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId('native-push-v2'), createdAt: 1, cwd: work })
    pushSession.append('command/run', { commandId: 'on' as never, name: 'context-guard', args: 'on', source: { kind: 'user' } })
    pushSession.append('user/message', createUserMessage({ content: [{ type: 'text', text: `Push repository ${work} to remote origin refspec refs/heads/main:refs/heads/main.` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    appendCall(pushSession, 'native-push', 'bash', { command: 'git push origin refs/heads/main:refs/heads/main', workdir: work })
    const pushed = await gitExec('git', ['-C', work, 'push', 'origin', 'refs/heads/main:refs/heads/main'])
    appendResult(pushSession, 'native-push', pushed.stderr)
    const push = await observer.execute({ effect_call_id: 'native-push' }, { agent: { session: pushSession }, signal: new AbortController().signal } as never) as { status: string; post_oid: string; reason_code: string; remote: string; refspec: string }
    expect(push).toMatchObject({ status: 'observed', post_oid: commit.post_oid })
    appendCall(pushSession, 'push-readback', 'context_guard_observe_git', { effect_call_id: 'native-push' })
    appendResult(pushSession, 'push-readback', JSON.stringify(push), { contextGuardNativeGit: {
      effectCallId: 'native-push', action: 'push', repository: work, branch: 'main', remote: push.remote,
      refspec: push.refspec, postOid: push.post_oid, parentOid: '', treeOid: '',
    } })
    const pushProjection = deriveProjection(pushSession.snapshotEvents() as never, { activation: 'opt-in' }, { cwd: work }, true, HOST).projection
    const pushItem = [...pushProjection.items.values()].find((row) => row.semanticAction === 'push')!
    expect(pushItem).toBeDefined()
    const pushEffect = [...pushProjection.evidence.values()].find((row) => row.callId === 'native-push')!
    const pushState = [...pushProjection.evidence.values()].find((row) => row.callId === 'push-readback')!
    const pushBinding = { itemId: pushItem.id, evidenceIds: [pushEffect.id, pushState.id], semanticAction: 'push' as const,
      requestedTarget: pushItem.requestedTarget, resolvedTarget: { repository: work, remote: 'origin', refspec: push.refspec, local_oid: push.post_oid },
      observedState: { post_head_oid: push.post_oid, remote_oid: push.post_oid }, effectEvidenceId: pushEffect.id,
      stateEvidenceIds: [pushState.id] }
    const pushCertificate = certifyCheckpoint(pushProjection, [pushBinding], 'C-native-push', false)
    expect(pushCertificate, JSON.stringify(pushCertificate.rejectedBindings)).toMatchObject({ status: 'certified' })
  })
  it('keeps future observations separate from a ready current test and later resume', async () => {
    const eventsFor = (roots: string[]) => {
      const events: Array<{ seq: number; type: string; data: unknown }> = [
        { seq: 1, type: 'command/run', data: { name: 'context-guard', args: 'on', source: { kind: 'user' } } },
        { seq: 2, type: 'turn/start', data: { turn: 1 } },
        ...roots.map((text, index) => ({ seq: 3 + index, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })),
      ]
      return events
    }
    const derive = (events: ReturnType<typeof eventsFor>) => deriveProjection(events as never, { activation: 'opt-in' }, { cwd: '/work' }, true, HOST).projection
    const future = derive(eventsFor(['按既定计划完成本轮修复。实际收益仍需后续使用观察。改动保持未提交。']))
    expect(currentActionBases(future)).toEqual([])
    expect(decideTurnBoundary(future)).toMatchObject({ action: 'stop', reason: 'safe_yield_pending_preserved' })
    const testEvents = eventsFor(['运行 pnpm test。', '持续推进，直到本轮测试完成为止。'])
    const beforeReady = derive(testEvents)
    const item = [...beforeReady.items.values()].find((row) => row.semanticAction === 'test')!
    expect(currentActionBases(beforeReady)).toEqual([])
    const manifest = '{"scripts":{"test":"vitest run"}}'
    const readinessTool = createTestReadinessObserver({ getProjection: () => beforeReady, flush: async () => true, fs: {
      resolve: async (path) => ({ displayPath: path }), stat: async () => ({ type: 'file', version: 'v1', size: manifest.length }), readText: async () => manifest,
    } })
    const ready = await readinessTool.execute({ item_id: item.id }, { agent: { session: {} }, signal: new AbortController().signal } as never) as { status: string; scope: string; manifest_sha256: string }
    expect(ready.status).toBe('ready')
    testEvents.push({ seq: 5, type: 'tool/call', data: { turn: 1, step: 1, callId: 'ready-1', name: 'context_guard_observe_test_readiness', arguments: JSON.stringify({ item_id: item.id }) } })
    testEvents.push({ seq: 6, type: 'tool/result', data: { turn: 1, step: 1,
      message: createToolResultMessage({ callId: 'ready-1' as never, content: [{ type: 'text', text: JSON.stringify(ready) }], isError: false }),
      meta: { contextGuardTestReadiness: { itemId: item.id, scope: ready.scope, manifestSha256: ready.manifest_sha256, predicate: 'test_passed' } },
    } })
    const missingTest = derive(testEvents)
    expect(currentActionBases(missingTest)).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'test', owner: 'assistant', unmetPredicate: 'test_passed' })]))
    expect(decideTurnBoundary(missingTest)).toMatchObject({ action: 'continue', reason: 'explicit_user_persistence' })
    const resumeEvents = eventsFor(['运行 pnpm test。', '继续。'])
    resumeEvents.push({ ...testEvents[4]!, seq: 5 }, { ...testEvents[5]!, seq: 6 })
    const resumed = derive(resumeEvents)
    expect(decideTurnBoundary(resumed, '继续。')).toMatchObject({ action: 'continue', reason: 'resume_with_actionable_work' })
  })
})
