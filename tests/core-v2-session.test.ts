import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V6_NOTICE, rootLocatorFlavor } from '../src/domain/derive.js'
import { projectSessionCoreV2, sessionCoreSnapshot } from '../src/core-v2/session.js'
import type { DerivedEnvelope } from '../src/domain/types.js'
import { replayRawV2 } from '../src/raw-replay.js'
import { createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createTestReadinessObserver } from '../src/tools/observe.js'
import { requestedTargetMatchesResolved } from '../src/domain/protocol-manifest.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'
import { currentActionBases, decideTurnBoundary } from '../src/domain/stop-policy.js'
import { createRuntime } from '../src/runtime.js'
import { createHash } from 'node:crypto'
import { evidenceFromPersistedToolResult } from '../src/domain/evidence.js'
const HOST = evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' })
const note = { seq: 1, type: 'user/message', data: { source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }] } } as DerivedEnvelope
function replay(root: string) {
  const events: DerivedEnvelope[] = [note, { seq: 2, type: 'turn/start', data: { turn: 1 } },
    { seq: 3, type: 'user/message', data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: root }] } }]
  const projection = deriveProjection(events, { activation: 'always' }, { cwd: '/work' }, true).projection
  projection.durabilityWatermark = 'confirmed'
  return { events, projection }
}
describe('Session to core/v2 host adapter', () => {
  it('takes a root locator only from the real Session header through runtime', () => {
    const cwd = '/work'
    const id = SessionId('real-posix-root-flavor')
    const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, isSeeded: false, id, createdAt: 1, cwd })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }],
      source: { kind: 'plugin', plugin: 'context-guard', form: 'notice', summary: 'v6' } }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Modify /work/A.txt.' }],
      source: { kind: 'user' } }), { surfaceOp: 'append' })
    const events = session.snapshotEvents() as never
    const withoutHeader = deriveProjection(events, { activation: 'always' }, { cwd }, true, HOST).projection
    withoutHeader.durabilityWatermark = 'confirmed'
    expect((sessionCoreSnapshot(events, withoutHeader)?.sources as Array<Record<string, unknown>>)
      ?.find((source) => source.kind === 'root' && String(source.text).startsWith('Modify')))
      .not.toHaveProperty('locator_base')
    const runtime = createRuntime({ session } as never, { activation: 'always' } as never, HOST)
    runtime.setDurability(true); runtime.sync()
    expect((sessionCoreSnapshot(events, runtime.projection)?.sources as Array<Record<string, unknown>>)
      ?.find((source) => source.kind === 'root' && String(source.text).startsWith('Modify')))
      .toMatchObject({ locator_base: cwd, locator_flavor: 'posix' })
  })
  it('classifies immutable root bases without ambient drive, case or separator normalization', () => {
    expect(rootLocatorFlavor('/work')).toBe('posix')
    expect(rootLocatorFlavor('C:\\Work')).toBe('windows')
    for (const unknown of ['C:Work', '\\Work', 'C:/Work', 'C:\\Work\\..\\Other',
      'C:\\Work\\\\Other', '\\\\server\\share', '/work\\other']) expect(rootLocatorFlavor(unknown)).toBeUndefined()
  })
  it.skipIf(process.platform !== 'win32')('projects a real Windows Session header with its drive flavor', () => {
    const cwd = process.cwd()
    expect(rootLocatorFlavor(cwd)).toBe('windows')
    const id = SessionId('real-windows-root-flavor')
    const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, isSeeded: false, id, createdAt: 1, cwd })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }],
      source: { kind: 'plugin', plugin: 'context-guard', form: 'notice', summary: 'v6' } }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `Modify ${cwd}\\A.txt.` }],
      source: { kind: 'user' } }), { surfaceOp: 'append' })
    const events = session.snapshotEvents() as never
    const withoutHeader = deriveProjection(events, { activation: 'always' }, { cwd }, true, HOST).projection
    withoutHeader.durabilityWatermark = 'confirmed'
    expect((sessionCoreSnapshot(events, withoutHeader)?.sources as Array<Record<string, unknown>>)
      ?.find((source) => source.kind === 'root' && String(source.text).startsWith('Modify')))
      .not.toHaveProperty('locator_base')
    // Runtime obtains the immutable header through the real Session API. The
    // root text and ambient cwd alone cannot supply a locator identity.
    const runtime = createRuntime({ session } as never, { activation: 'always' } as never, HOST)
    runtime.setDurability(true)
    runtime.sync()
    const root = (sessionCoreSnapshot(events, runtime.projection)?.sources as Array<Record<string, unknown>>)
      ?.find((source) => source.kind === 'root' && String(source.text).startsWith('Modify'))
    expect(root).toMatchObject({ locator_base: cwd, locator_flavor: 'windows' })
  })
  it('keeps a root-named Windows drive repository as one absolute identity', () => {
    const cwd = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\dsh-native-git-AbCd12\\work'
    const id = SessionId('windows-absolute-repository')
    const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, isSeeded: false, id, createdAt: 1, cwd: '/work' })
    session.append('command/run', { commandId: 'on' as never, name: 'context-guard', args: 'on', source: { kind: 'user' } })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `Commit changes in repository ${cwd}.` }],
      source: { kind: 'user' } }), { surfaceOp: 'append' })
    const projection = deriveProjection(session.snapshotEvents() as never, { activation: 'always' }, { cwd: '/work' }, true, HOST).projection
    const item = [...projection.items.values()].find((entry) => entry.semanticAction === 'commit')!
    expect(item.requestedTarget?.repository).toBe(cwd)
    expect(requestedTargetMatchesResolved('commit', item.requestedTarget, { repository: cwd, branch: 'main' })).toBe(true)
    expect(requestedTargetMatchesResolved('commit', item.requestedTarget, { repository: cwd.toLowerCase(), branch: 'main' })).toBe(false)
    expect(requestedTargetMatchesResolved('commit', item.requestedTarget, { repository: cwd.replaceAll('\\', '/'), branch: 'main' })).toBe(false)
  })
  it('projects exact root bytes and a pending edit without fabricating a state fact', () => {
    const { events, projection } = replay('Modify /work/alpha.txt.')
    const snapshot = sessionCoreSnapshot(events, projection)!
    expect(snapshot).toBeDefined()
    expect(snapshot.facts).toEqual([])
    expect((snapshot.requirements as Array<Record<string, unknown>>)[0]).toMatchObject({ kind: 'execution', action: 'modify', target: '/work/alpha.txt' })
    expect(projectSessionCoreV2(events, projection)).toMatchObject({ certifiable: false })
  })
  it('retains unknown coverage for a quoted future observation', () => {
    const { events, projection } = replay('After completion, maybe observe the future benefit for /work/alpha.txt.')
    expect(projectSessionCoreV2(events, projection)?.certifiable).toBe(false)
  })
  it('refuses unconfirmed event watermarks', () => {
    const { events, projection } = replay('Modify /work/alpha.txt.')
    projection.durabilityWatermark = 'unknown'
    expect(sessionCoreSnapshot(events, projection)).toBeUndefined()
  })
  it.each(['edit', 'edit_file', 'write', 'write_file'])('uses the %s call file_path and never treats conflicting result metadata as another mutation', (toolName) => {
    const call = { callId: 'file-target', name: toolName, arguments: JSON.stringify({ file_path: '/work/A.txt' }) }
    const conflict = evidenceFromPersistedToolResult(call, { seq: 5, meta: { path: '/work/B.txt' }, textContent: 'ok' }, 1, 'E-conflict', '/work', HOST)
    expect(conflict.subjects).toEqual(['/work/A.txt', '/work/B.txt'])
    expect(conflict.operations ?? []).toEqual([])
    expect(conflict.outcome).toBe('unknown')
    const ordinary = evidenceFromPersistedToolResult(call, { seq: 5, textContent: 'ok' }, 1, 'E-ordinary', '/work', HOST)
    expect(ordinary.subjects).toEqual(['/work/A.txt'])
    expect(ordinary.operations).toEqual([{ op: toolName.startsWith('edit') ? 'modify' : 'create', path: '/work/A.txt' }])
    expect(ordinary.outcome).toBe('success')
  })
  it('keeps a conflicting file result out of the production core fact stream', () => {
    const { events } = replay('Modify /work/B.txt.')
    events.push({ seq: 4, type: 'tool/call', data: { turn: 1, step: 1, callId: 'wrong-file', name: 'edit',
      arguments: JSON.stringify({ file_path: '/work/A.txt', old_string: 'old', new_string: 'new' }) } })
    events.push({ seq: 5, type: 'tool/result', data: { turn: 1, step: 1,
      message: createToolResultMessage({ callId: 'wrong-file' as never, content: [{ type: 'text', text: 'edited' }], isError: false }),
      meta: { path: '/work/B.txt' } } })
    const projection = deriveProjection(events, { activation: 'always' }, { cwd: '/work' }, true, HOST).projection
    projection.durabilityWatermark = 'confirmed'
    const snapshot = sessionCoreSnapshot(events, projection)!
    expect((snapshot.facts as Array<Record<string, unknown>>).some((fact) => fact.predicate === 'file_modified' && fact.target === '/work/B.txt')).toBe(false)
    expect(projectSessionCoreV2(events, projection)?.certifiable).toBe(false)
  })
  it('projects a no-metadata native edit under its persisted call target', () => {
    const { events } = replay('Modify /work/A.txt.')
    events.push({ seq: 4, type: 'tool/call', data: { turn: 1, step: 1, callId: 'actual-file', name: 'edit',
      arguments: JSON.stringify({ file_path: '/work/A.txt', old_string: 'old', new_string: 'new' }) } })
    events.push({ seq: 5, type: 'tool/result', data: { turn: 1, step: 1,
      message: createToolResultMessage({ callId: 'actual-file' as never, content: [{ type: 'text', text: 'edited' }], isError: false }) } })
    const projection = deriveProjection(events, { activation: 'always' }, { cwd: '/work' }, true, HOST).projection
    projection.durabilityWatermark = 'confirmed'
    const snapshot = sessionCoreSnapshot(events, projection)!
    expect((snapshot.sources as Array<Record<string, unknown>>).find((source) => source.id === 'call:actual-file')).toMatchObject({ target: '/work/A.txt', target_kind: 'filesystem' })
    expect((snapshot.facts as Array<Record<string, unknown>>).find((fact) => fact.call_source_id === 'call:actual-file')).toMatchObject({ target: '/work/A.txt' })
  })
  it('replays an ordinary explanation through Session, delivery, core and registered Stop', async () => {
    const result = await replayRawV2({ root: '检查一下插件是否有更新吗？', final: '已检查远端，本地插件 2.0.0 已是最新版本。' })
    expect(result.stop_core_projection).toMatchObject({ certifiable: false, predicates: { R001: 'insufficient' } })
    expect(result.post_turn_core_projection).toMatchObject({ certifiable: true, predicates: { R001: 'satisfied' }, stop: 'ordinary_end' })
    expect(result.stop).toBe('safe_yield_pending_preserved')
    expect(result.items).toMatchObject([{ status: 'answered', disposition: 'informational' }])
  })
  it('keeps a ready test actionable across a short resume in the same work unit', () => {
    const first: DerivedEnvelope[] = [note, { seq: 2, type: 'turn/start', data: { turn: 1 } },
      { seq: 3, type: 'user/message', data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: 'Run pnpm test in /work.' }] } }]
    const initial = deriveProjection(first, { activation: 'always' }, { cwd: '/work' }, true, HOST).projection
    const item = [...initial.items.values()].find((row) => row.semanticAction === 'test')!
    expect(item).toBeDefined()
    const manifest = '{"scripts":{"test":"vitest run"}}'
    const sha = createHash('sha256').update(manifest).digest('hex')
    const call: DerivedEnvelope = { seq: 4, type: 'tool/call', data: { turn: 1, step: 1, callId: 'ready-1', name: 'context_guard_observe_test_readiness', arguments: JSON.stringify({ item_id: item.id }) } }
    const result: DerivedEnvelope = { seq: 5, type: 'tool/result', data: { turn: 1, step: 1,
      message: createToolResultMessage({ callId: 'ready-1' as never, content: [{ type: 'text', text: JSON.stringify({ status: 'ready', scope: '/work', manifest_sha256: sha }) }], isError: false }),
      meta: { contextGuardTestReadiness: { itemId: item.id, scope: '/work', manifestSha256: sha, predicate: 'test_passed' } } } }
    const resumed: DerivedEnvelope = { seq: 6, type: 'user/message', data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: '继续。' }] } }
    const events = [...first, call, result, resumed]
    const projection = deriveProjection(events, { activation: 'always' }, { cwd: '/work' }, true, HOST).projection
    projection.durabilityWatermark = 'confirmed'
    projection.coreV2 = projectSessionCoreV2(events, projection)
    expect(projection.coreV2?.current_actions).toMatchObject([{ requirement_id: item.id, action: 'test_verify' }])
    expect(currentActionBases(projection)).toMatchObject([{ itemId: item.id, action: 'test' }])
    expect(decideTurnBoundary(projection, '继续。')).toMatchObject({ action: 'continue', reason: 'resume_with_actionable_work' })
  })
  it.each([
    '按既定计划执行本轮修复并运行测试。',
    'Please fix this issue and run the focused tests.',
    '完成修改和测试。',
  ])('binds original root test wording to an actual package input selection: %s', async (root) => {
    const id = SessionId(`raw-test-ready-${Buffer.from(root).toString('hex').slice(0, 16)}`)
    const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, isSeeded: false, id, createdAt: 1, cwd: '/work' })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }],
      source: { kind: 'plugin', plugin: 'context-guard', form: 'notice', summary: 'v6' } }), { surfaceOp: 'append' })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: root }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const initial = deriveProjection(session.snapshotEvents() as never, { activation: 'always' }, { cwd: '/work' }, true, HOST).projection
    const test = [...initial.items.values()].find((item) => item.semanticAction === 'test')!
    expect(test).toBeDefined()
    const manifest = '{"scripts":{"test":"vitest run"}}'
    const observer = createTestReadinessObserver({ flush: async () => true, getProjection: () => initial, fs: {
      resolve: async (path) => ({ displayPath: path }),
      stat: async () => ({ type: 'file', version: 'v1', size: manifest.length }),
      readText: async () => manifest,
    } })
    const observed = await observer.execute({ item_id: test.id }, { agent: { session }, signal: new AbortController().signal } as never) as Record<string, unknown>
    expect(observed.status).toBe('ready')
    session.append('tool/call', { turn: 1, step: 1, callId: 'test-ready' as never,
      name: 'context_guard_observe_test_readiness', arguments: JSON.stringify({ item_id: test.id }) })
    session.append('tool/result', { turn: 1, step: 1,
      message: createToolResultMessage({ callId: 'test-ready' as never, content: [{ type: 'text', text: JSON.stringify(observed) }], isError: false }),
      meta: { contextGuardTestReadiness: { itemId: test.id, scope: observed.scope, manifestSha256: observed.manifest_sha256, predicate: 'test_passed' } },
    } as never, { surfaceOp: 'append' })
    const events = session.snapshotEvents() as never
    const projection = deriveProjection(events, { activation: 'always' }, { cwd: '/work' }, true, HOST).projection
    projection.durabilityWatermark = 'confirmed'
    const snapshot = sessionCoreSnapshot(events, projection)!
    const hostResult = (snapshot.sources as Array<Record<string, unknown>>).find((source) => source.kind === 'host_result')!
    expect(hostResult).toBeDefined()
    expect(hostResult).not.toHaveProperty('target')
    expect(hostResult).not.toHaveProperty('target_kind')
    const core = projectSessionCoreV2(events, projection)!
    expect(core.current_actions).toMatchObject([{ requirement_id: test.id, action: 'test_verify', target: '/work' }])
    expect(core.predicates).toMatchObject({ [test.id]: 'insufficient' })
    expect(currentActionBases(projection, false).some((basis) => basis.itemId === test.id)).toBe(true)
    session.append('tool/call', { turn: 1, step: 2, callId: 'native-test-result' as never,
      name: 'bash', arguments: JSON.stringify({ command: 'pnpm test', workdir: '/work' }) })
    session.append('tool/result', { turn: 1, step: 2,
      message: createToolResultMessage({ callId: 'native-test-result' as never,
        content: [{ type: 'text', text: '10 tests passed' }], isError: false }),
    } as never, { surfaceOp: 'append' })
    const completedEvents = session.snapshotEvents() as never
    const completed = deriveProjection(completedEvents, { activation: 'always' }, { cwd: '/work' }, true, HOST).projection
    completed.durabilityWatermark = 'confirmed'
    expect(projectSessionCoreV2(completedEvents, completed)).toMatchObject({ predicates: { [test.id]: 'satisfied' } })
  })
  it.each([
    ['现在评估这次修改的效果并给出结果。', 'test'],
    ['立刻测量本次改动的吞吐收益。', 'benchmark'],
  ])('makes a present assessment actionable only after a real changed file and %s script', async (root, scriptName) => {
    const id = SessionId(`assessment-ready-${scriptName}`)
    const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, isSeeded: false, id, createdAt: 1, cwd: '/work' })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }],
      source: { kind: 'plugin', plugin: 'context-guard', form: 'notice', summary: 'v6' } }), { surfaceOp: 'append' })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: root }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId: 'edit-assessment' as never,
      name: 'edit', arguments: JSON.stringify({ file_path: '/work/A', old_string: 'old', new_string: 'new' }) })
    session.append('tool/result', { turn: 1, step: 1,
      message: createToolResultMessage({ callId: 'edit-assessment' as never, content: [{ type: 'text', text: 'edited' }], isError: false }),
    } as never, { surfaceOp: 'append' })
    const initial = deriveProjection(session.snapshotEvents() as never, { activation: 'always' }, { cwd: '/work' }, true, HOST).projection
    const item = [...initial.items.values()].find((entry) => entry.semanticAction === 'verify')!
    expect(item).toBeDefined()
    const manifest = JSON.stringify({ scripts: { [scriptName]: 'node local-check.js' } })
    const observer = createTestReadinessObserver({ flush: async () => true, getProjection: () => initial, fs: {
      resolve: async (path) => ({ displayPath: path }),
      stat: async () => ({ type: 'file', version: 'stable', size: 100 }),
      readText: async (target) => (target as { displayPath: string }).displayPath.endsWith('package.json') ? manifest : 'new',
    } })
    const observed = await observer.execute({ item_id: item.id }, { agent: { session }, signal: new AbortController().signal } as never) as Record<string, unknown>
    expect(observed).toMatchObject({ status: 'ready', predicate: 'verification_passed', script_name: scriptName,
      selected_path: '/work/A', effect_call_id: 'edit-assessment' })
    session.append('tool/call', { turn: 1, step: 2, callId: 'assessment-ready' as never,
      name: 'context_guard_observe_test_readiness', arguments: JSON.stringify({ item_id: item.id }) })
    session.append('tool/result', { turn: 1, step: 2,
      message: createToolResultMessage({ callId: 'assessment-ready' as never, content: [{ type: 'text', text: JSON.stringify(observed) }], isError: false }),
      meta: { contextGuardTestReadiness: { itemId: item.id, scope: observed.scope, manifestSha256: observed.manifest_sha256,
        predicate: observed.predicate, scriptName: observed.script_name, selectedPath: observed.selected_path,
        effectCallId: observed.effect_call_id, inputSha256: observed.input_sha256 } },
    } as never, { surfaceOp: 'append' })
    const events = session.snapshotEvents() as never
    const projection = deriveProjection(events, { activation: 'always' }, { cwd: '/work' }, true, HOST).projection
    projection.durabilityWatermark = 'confirmed'
    const core = projectSessionCoreV2(events, projection)!
    expect(core.current_actions).toMatchObject([{ requirement_id: item.id, action: 'evaluate_current_effect', target: '/work' }])
    expect(core.predicates).toMatchObject({ [item.id]: 'insufficient' })
  })
  it('selects a real benchmark manifest for an existing change without forcing a new edit', async () => {
    const root = '立刻测量本次改动的吞吐收益。'
    const id = SessionId('assessment-existing-change')
    const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, isSeeded: false, id, createdAt: 1, cwd: '/work' })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }],
      source: { kind: 'plugin', plugin: 'context-guard', form: 'notice', summary: 'v6' } }), { surfaceOp: 'append' })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: root }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const initial = deriveProjection(session.snapshotEvents() as never, { activation: 'always' }, { cwd: '/work' }, true, HOST).projection
    const item = [...initial.items.values()].find((entry) => entry.semanticAction === 'verify')!
    const manifest = '{"scripts":{"benchmark":"node bench.js"}}'
    const observer = createTestReadinessObserver({ flush: async () => true, getProjection: () => initial, fs: {
      resolve: async (path) => ({ displayPath: path }),
      stat: async () => ({ type: 'file', version: 'stable', size: manifest.length }),
      readText: async () => manifest,
    } })
    const observed = await observer.execute({ item_id: item.id }, { agent: { session }, signal: new AbortController().signal } as never) as Record<string, unknown>
    expect(observed).toMatchObject({ status: 'ready', selected_path: '/work/package.json', effect_call_id: '' })
    session.append('tool/call', { turn: 1, step: 1, callId: 'readiness-existing' as never,
      name: 'context_guard_observe_test_readiness', arguments: JSON.stringify({ item_id: item.id }) })
    session.append('tool/result', { turn: 1, step: 1,
      message: createToolResultMessage({ callId: 'readiness-existing' as never, content: [{ type: 'text', text: JSON.stringify(observed) }], isError: false }),
      meta: { contextGuardTestReadiness: { itemId: item.id, scope: observed.scope, manifestSha256: observed.manifest_sha256,
        predicate: observed.predicate, scriptName: observed.script_name, selectedPath: observed.selected_path,
        effectCallId: observed.effect_call_id, inputSha256: observed.input_sha256 } },
    } as never, { surfaceOp: 'append' })
    const events = session.snapshotEvents() as never
    const projection = deriveProjection(events, { activation: 'always' }, { cwd: '/work' }, true, HOST).projection
    projection.durabilityWatermark = 'confirmed'
    const core = projectSessionCoreV2(events, projection)!
    expect(core.current_actions).toMatchObject([{ requirement_id: item.id, action: 'evaluate_current_effect', target: '/work' }])
  })

  it('uses the latest same-target test outcome across persisted Session replay', () => {
    const id = SessionId('latest-test-outcome')
    const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, isSeeded: false, id, createdAt: 1, cwd: '/work' })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }],
      source: { kind: 'plugin', plugin: 'context-guard', form: 'notice', summary: 'v6' } }), { surfaceOp: 'append' })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Run pnpm test in /work.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const project = () => {
      const events = session.snapshotEvents() as never
      const projection = deriveProjection(events, { activation: 'always' }, { cwd: '/work' }, true, HOST).projection
      projection.durabilityWatermark = 'confirmed'
      return { projection, core: projectSessionCoreV2(events, projection)! }
    }
    const item = [...project().projection.items.values()].find((entry) => entry.semanticAction === 'test')!
    const sha = 'a'.repeat(64)
    session.append('tool/call', { turn: 1, step: 1, callId: 'ready-latest' as never,
      name: 'context_guard_observe_test_readiness', arguments: JSON.stringify({ item_id: item.id }) })
    session.append('tool/result', { turn: 1, step: 1,
      message: createToolResultMessage({ callId: 'ready-latest' as never, content: [{ type: 'text', text: 'ready' }], isError: false }),
      meta: { contextGuardTestReadiness: { itemId: item.id, scope: '/work', manifestSha256: sha, predicate: 'test_passed' } },
    } as never, { surfaceOp: 'append' })
    const run = (callId: string, step: number, workdir: string, outcome: 'success' | 'failure' | 'unknown') => {
      session.append('tool/call', { turn: 1, step, callId: callId as never,
        name: 'bash', arguments: JSON.stringify({ command: 'pnpm test', workdir, ...(outcome === 'unknown' ? { run_in_background: true } : {}) }) })
      session.append('tool/result', { turn: 1, step,
        ...(outcome === 'failure' ? { error: { name: 'ProcessError', message: 'test command failed' } } : {}),
        message: createToolResultMessage({ callId: callId as never,
          content: [{ type: 'text', text: outcome === 'success' ? '10 tests passed' : outcome === 'failure' ? '1 test failed' : 'output still pending' }], isError: outcome === 'failure' }),
      } as never, { surfaceOp: 'append' })
    }
    run('run-success', 2, '/work', 'success')
    let state = project()
    expect(state.core.predicates).toMatchObject({ [item.id]: 'satisfied' })
    expect(currentActionBases(state.projection, false)).toEqual([])
    run('run-wrong-target', 3, '/other', 'failure')
    state = project()
    expect(state.core.predicates).toMatchObject({ [item.id]: 'satisfied' })
    run('run-unknown', 4, '/work', 'unknown')
    state = project()
    expect(state.core.predicates).toMatchObject({ [item.id]: 'insufficient' })
    expect(currentActionBases(state.projection, false)).toMatchObject([{ itemId: item.id, action: 'test' }])
    run('run-failure', 5, '/work', 'failure')
    state = project()
    expect(state.core.predicates).toMatchObject({ [item.id]: 'insufficient' })
    expect(state.core.current_actions).toMatchObject([{ requirement_id: item.id, action: 'test_verify' }])
    expect(currentActionBases(state.projection, false)).toMatchObject([{ itemId: item.id, action: 'test' }])
    run('run-recovery', 6, '/work', 'success')
    state = project()
    expect(state.core.predicates).toMatchObject({ [item.id]: 'satisfied' })
    expect(currentActionBases(state.projection, false)).toEqual([])
  })
})
