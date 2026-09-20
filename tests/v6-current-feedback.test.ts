import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { Session, SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { deriveProjection, PROTOCOL_V6_NOTICE } from '../src/domain/derive.js'
import { projectSessionCoreV2 } from '../src/core-v2/session.js'
import { createPrepareTool } from '../src/tools/prepare.js'
import { createCheckpointTool } from '../src/tools/checkpoint.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'
import { defaultV6OrdinaryFeedbackScope } from '../src/domain/v6-feedback.js'

const HOST = { ...evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' }),
  auditedForegroundRenderers: ['bash' as const] }

function fixture(root = 'Run pnpm test in /work.') {
  const id = SessionId('v6-current-feedback')
  const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, isSeeded: false, id, createdAt: 1, cwd: '/work' })
  const scope = { cwd: '/work', sessionHeader: { version: SESSION_FORMAT_VERSION, id: String(id), createdAt: 1, seedLength: 0, delegationDepth: 0 } }
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }],
    source: { kind: 'plugin', plugin: 'context-guard', form: 'notice', summary: 'v6' } }), { surfaceOp: 'append' })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: root }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const derive = () => {
    const events = session.snapshotEvents() as never
    const projection = deriveProjection(events, { activation: 'always' }, scope, true, HOST).projection
    projection.durabilityWatermark = 'confirmed'
    const origins: NonNullable<typeof projection.coreV2RequirementOrigins> = new Map()
    projection.coreV2 = projectSessionCoreV2(events, projection, origins)
    projection.coreV2RequirementOrigins = origins
    return projection
  }
  return { session, derive }
}

function appendTest(session: Session, id: string, failed = false, command = 'pnpm test') {
  session.append('tool/call', { turn: 1, step: 1, callId: id as never, name: 'bash', arguments: JSON.stringify({ command, workdir: '/work' }) })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: id as never,
    content: [{ type: 'text', text: failed ? '1 test failed' : '10 tests passed' }], isError: failed }),
    ...(failed ? { error: { name: 'ProcessError', message: 'failed' } } : {}) } as never, { surfaceOp: 'append' })
}

describe('default v6 current feedback', () => {
  it('keeps a sourced root test action in a materialized ordinary checkpoint row', async () => {
    const { derive } = fixture('Run npm test in /work.')
    const projection = derive()
    const ctx = new Context()
    new SystemPrompt(ctx, {})
    const runtime = new ToolRuntime(ctx)
    runtime.register(createCheckpointTool(() => projection, () => {}))
    const response = await runtime.execute({ callId: 'native-root-test-checkpoint' as never,
      name: 'context_guard_checkpoint', arguments: { bindings: [] }, signal: new AbortController().signal })
    expect(response.isError).toBe(false)
    expect(response.value).toMatchObject({ status: 'incomplete', feedback_source: 'confirmed_core_v2',
      open_items: [expect.objectContaining({ id: 'R001', source_item_id: 'R001',
        semantic_action: 'test', reason_code: 'insufficient' })] })
    delete projection.items.get('R001')!.semanticAction
    const unknown = await runtime.execute({ callId: 'unknown-root-test-checkpoint' as never,
      name: 'context_guard_checkpoint', arguments: { bindings: [] }, signal: new AbortController().signal })
    expect(unknown.isError).toBe(false)
    expect((unknown.value as { open_items: Array<Record<string, unknown>> }).open_items[0]).not.toHaveProperty('semantic_action')
  })
  it('retains root action provenance when a long ordinary row is summarized', async () => {
    const { derive } = fixture('Run npm test in /work.')
    const projection = derive()
    projection.items.get('R001')!.normalizedText += ' details'.repeat(400)
    const page = await createCheckpointTool(() => projection, () => {}).execute({ bindings: [] } as never, undefined as never) as {
      open_items: Array<Record<string, unknown>>
    }
    expect(page.open_items[0]).toMatchObject({ id: 'R001', omitted: true, source_item_id: 'R001',
      semantic_action: 'test', reason_code: 'insufficient' })
  })
  it('retains the original native create/readback root as an incomplete pre-effect state case', async () => {
    const { derive } = fixture('Create /work/alpha.txt with the native fixture content and read it back.')
    const projection = derive()
    const result = await createCheckpointTool(() => projection, () => {}).execute({ bindings: [] } as never, undefined as never) as Record<string, unknown>
    expect(result).toMatchObject({ status: 'incomplete', feedback_source: 'confirmed_core_v2', certificate_status: 'not_requested' })
    expect(result).not.toHaveProperty('certificate')
    expect(projection.coreV2?.certifiable).toBe(false)
  })
  it('observes a matched native npm test and reopens on its later failed result', async () => {
    const { session, derive } = fixture('Run npm test in /work.')
    const read = async () => createCheckpointTool(() => derive(), () => {}).execute({ bindings: [] } as never, undefined as never) as Promise<Record<string, unknown>>
    expect(await read()).toMatchObject({ status: 'incomplete', feedback_source: 'confirmed_core_v2' })
    appendTest(session, 'npm-success', false, 'npm test')
    expect(await read()).toMatchObject({ status: 'observed', open_items: [], certificate_status: 'not_requested' })
    appendTest(session, 'npm-failed', true, 'npm test')
    const failed = await read()
    expect(failed).toMatchObject({ status: 'incomplete', feedback_source: 'confirmed_core_v2' })
    expect(failed).not.toHaveProperty('certificate')
  })
  it('keeps the native modify/readback fixture on the ordinary observed path', async () => {
    const path = '/work/alpha.txt'
    const { session, derive } = fixture(`Modify ${path} to native-v070.`)
    const before = derive()
    const checkpoint = (projection: ReturnType<typeof derive>) => createCheckpointTool(() => projection, () => {})
    const pending = await checkpoint(before).execute({ bindings: [] } as never, undefined as never) as Record<string, unknown>
    expect(pending).toMatchObject({ status: 'incomplete', feedback_source: 'confirmed_core_v2' })
    expect(pending).not.toHaveProperty('certificate')
    session.append('tool/call', { turn: 1, step: 1, callId: 'file-edit' as never, name: 'edit',
      arguments: JSON.stringify({ file_path: path, old_string: 'before', new_string: 'native-v070' }) })
    session.append('tool/result', { turn: 1, step: 1,
      message: createToolResultMessage({ callId: 'file-edit' as never, content: [{ type: 'text', text: 'edited' }], isError: false }) },
    { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 2, callId: 'file-observe' as never, name: 'context_guard_observe_file',
      arguments: JSON.stringify({ effect_call_id: 'file-edit' }) })
    const digest = 'a'.repeat(64)
    session.append('tool/result', { turn: 1, step: 2,
      message: createToolResultMessage({ callId: 'file-observe' as never,
        content: [{ type: 'text', text: JSON.stringify({ status: 'observed', path, sha256: digest, action: 'modify', effect_call_id: 'file-edit' }) }], isError: false }),
      meta: { contextGuardNativeFile: { effectCallId: 'file-edit', path, sha256: digest, action: 'modify' } } } as never,
    { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 3, callId: 'file-read' as never, name: 'read',
      arguments: JSON.stringify({ file_path: path }) })
    session.append('tool/result', { turn: 1, step: 3,
      message: createToolResultMessage({ callId: 'file-read' as never,
        content: [{ type: 'text', text: 'native-v070\n' }], isError: false }), meta: { path } } as never,
    { surfaceOp: 'append' })
    const after = derive()
    const result = await checkpoint(after).execute({ bindings: [] } as never, undefined as never) as Record<string, unknown>
    expect(result.status, JSON.stringify(after.coreV2)).toBe('observed')
    expect(result).toMatchObject({ feedback_source: 'confirmed_core_v2', certificate_status: 'not_requested' })
    expect(result).not.toHaveProperty('certificate')
  })
  it('shows a derived observer requirement with its original source before and after persisted readback', async () => {
    const { session, derive } = fixture('Run pnpm test in /work. Use the read-only context_guard_observe_test_readiness tool for this current test.')
    const before = derive()
    const method = [...before.items.values()].find((item) => item.observerMethod)!
    const test = [...before.items.values()].find((item) => item.semanticAction === 'test')!
    const id = `${method.id}:observer:1`
    expect(before.coreV2?.predicates).toMatchObject({ [id]: 'insufficient' })
    const prepareTool = createPrepareTool({ getProjection: () => before })
    const discovery = await prepareTool.execute({} as never, undefined as never) as Record<string, unknown>
    expect(discovery).toMatchObject({ status: 'prepared', items: expect.arrayContaining([
      expect.objectContaining({ id, source_item_id: method.id, semantic_action: 'context_guard_observe_test_readiness' }),
    ]) })
    const direct = await prepareTool.execute({ item_id: id } as never, undefined as never) as Record<string, unknown>
    expect(direct).toMatchObject({ status: 'incomplete', item: { id, source_item_id: method.id, status: 'insufficient' } })
    const source = await prepareTool.execute({ item_id: method.id } as never, undefined as never) as Record<string, unknown>
    expect(source).toMatchObject({ status: 'incomplete', item: { id: method.id,
      related_requirement_ids: expect.arrayContaining([id]) } })
    const checkpoint = await createCheckpointTool(() => before, () => {}).execute({ bindings: [], detail_id: id } as never, undefined as never) as Record<string, unknown>
    expect(JSON.stringify(checkpoint)).toContain(method.id)
    const derivedRow = await createCheckpointTool(() => before, () => {}).execute({ bindings: [], item_ids: [id] } as never, undefined as never) as { open_items: Array<Record<string, unknown>> }
    expect(derivedRow.open_items[0]).toMatchObject({ id, source_item_id: method.id,
      semantic_action: 'context_guard_observe_test_readiness', reason_code: 'insufficient' })
    session.append('tool/call', { turn: 1, step: 1, callId: 'ready' as never, name: 'context_guard_observe_test_readiness',
      arguments: JSON.stringify({ item_id: test.id }) })
    session.append('tool/result', { turn: 1, step: 1,
      message: createToolResultMessage({ callId: 'ready' as never,
        content: [{ type: 'text', text: JSON.stringify({ status: 'ready', scope: '/work', manifest_sha256: 'a'.repeat(64) }) }], isError: false }),
      meta: { contextGuardTestReadiness: { itemId: test.id, scope: '/work', manifestSha256: 'a'.repeat(64), predicate: 'test_passed' } } } as never, { surfaceOp: 'append' })
    const replay = Session.fromRestore(session.id, structuredClone(session.snapshotEvents()) as never,
      structuredClone(session.header) as never, SessionLogOffset(0), 'detached')
    const events = replay.snapshotEvents() as never
    const restored = deriveProjection(events, { activation: 'always' },
      { cwd: '/work', sessionHeader: { version: SESSION_FORMAT_VERSION, id: String(session.id), createdAt: 1, seedLength: 0, delegationDepth: 0 } }, true, HOST).projection
    restored.durabilityWatermark = 'confirmed'
    const origins: NonNullable<typeof restored.coreV2RequirementOrigins> = new Map()
    restored.coreV2 = projectSessionCoreV2(events, restored, origins)
    restored.coreV2RequirementOrigins = origins
    expect(restored.coreV2?.predicates).toMatchObject({ [id]: 'satisfied' })
    const after = await createPrepareTool({ getProjection: () => restored }).execute({ item_id: id } as never, undefined as never) as Record<string, unknown>
    expect(after).toMatchObject({ status: 'observed', item: { id, source_item_id: method.id, status: 'satisfied' } })
  })

  it('diagnoses one derived method exactly while the parent retains both independent methods', async () => {
    const root = 'Run npm test in /work. Read /work/config.txt back with host tools. Use the read-only context_guard_observe_file and context_guard_observe_test_readiness tools for the corresponding current requirements.'
    const { session, derive } = fixture(root)
    const initial = derive()
    const method = [...initial.items.values()].find((item) => item.observerMethod?.tools.length === 2)!
    expect(method).toBeDefined()
    const fileId = `${method.id}:observer:1`
    const readyId = `${method.id}:observer:2`
    expect(initial.coreV2?.predicates).toMatchObject({ [fileId]: 'insufficient', [readyId]: 'insufficient' })
    const testId = method.observerMethod!.targetItemIds[1]!
    session.append('tool/call', { turn: 1, step: 1, callId: 'one-method' as never, name: 'context_guard_observe_test_readiness',
      arguments: JSON.stringify({ item_id: testId }) })
    session.append('tool/result', { turn: 1, step: 1,
      message: createToolResultMessage({ callId: 'one-method' as never,
        content: [{ type: 'text', text: JSON.stringify({ status: 'ready', scope: '/work', manifest_sha256: 'b'.repeat(64) }) }], isError: false }),
      meta: { contextGuardTestReadiness: { itemId: testId, scope: '/work', manifestSha256: 'b'.repeat(64), predicate: 'test_passed' } } } as never,
    { surfaceOp: 'append' })
    const projection = derive()
    expect(projection.coreV2?.predicates).toMatchObject({ [fileId]: 'insufficient', [readyId]: 'satisfied' })
    const tool = createPrepareTool({ getProjection: () => projection })
    const ready = await tool.execute({ item_id: readyId } as never, undefined as never) as Record<string, unknown>
    expect(ready).toMatchObject({ status: 'observed', item: { id: readyId, status: 'satisfied', related_requirement_ids: [readyId] } })
    const file = await tool.execute({ item_id: fileId } as never, undefined as never) as Record<string, unknown>
    expect(file).toMatchObject({ status: 'incomplete', item: { id: fileId, status: 'insufficient' } })
    const parent = await tool.execute({ item_id: method.id } as never, undefined as never) as Record<string, unknown>
    expect(parent).toMatchObject({ status: 'incomplete', item: { id: method.id,
      related_requirement_ids: expect.arrayContaining([fileId, readyId]) } })
  })
  it('does not re-list an ordinary test satisfied by its persisted Host result as a new binding debt', async () => {
    const { session, derive } = fixture()
    appendTest(session, 'test-1')
    const projection = derive()
    expect(projection.coreV2?.predicates).toMatchObject({ R001: 'satisfied' })
    expect(projection.items.get('R001')?.status).toBe('pending')
    const prepare = await createPrepareTool({ getProjection: () => projection }).execute({} as never, undefined as never) as Record<string, unknown>
    expect(prepare).toMatchObject({ total_open: 0 })
    const checkpoint = await createCheckpointTool(() => projection, () => {}).execute({ bindings: [] } as never, undefined as never) as Record<string, unknown>
    expect(checkpoint).toMatchObject({ status: 'observed', open_items: [] })
    expect(checkpoint).not.toHaveProperty('certificate')
    expect(checkpoint).not.toHaveProperty('binding_template')
    const restored = derive()
    const afterReload = await createCheckpointTool(() => restored, () => {}).execute({ bindings: [] } as never, undefined as never) as Record<string, unknown>
    expect(afterReload).toMatchObject({ status: 'observed', open_items: [], feedback_source: 'confirmed_core_v2' })
    const replay = Session.fromRestore(session.id, structuredClone(session.snapshotEvents()) as never,
      structuredClone(session.header) as never, SessionLogOffset(0), 'detached')
    const events = replay.snapshotEvents() as never
    const persisted = deriveProjection(events, { activation: 'always' },
      { cwd: '/work', sessionHeader: { version: SESSION_FORMAT_VERSION, id: String(session.id), createdAt: 1, seedLength: 0, delegationDepth: 0 } }, true, HOST).projection
    persisted.durabilityWatermark = 'confirmed'
    persisted.coreV2 = projectSessionCoreV2(events, persisted)
    const persistedFeedback = await createCheckpointTool(() => persisted, () => {}).execute({ bindings: [] } as never, undefined as never) as Record<string, unknown>
    expect(persistedFeedback).toMatchObject({ status: 'observed', open_items: [], feedback_source: 'confirmed_core_v2' })
  })

  it('keeps a genuinely unrun or latest failed test insufficient without manufacturing a qualification or retry', async () => {
    const { session, derive } = fixture()
    const tool = (projection: ReturnType<typeof derive>) => createCheckpointTool(() => projection, () => {})
    const before = derive()
    expect(before.coreV2?.predicates).toMatchObject({ R001: 'insufficient' })
    const unrun = await tool(before).execute({ bindings: [] } as never, undefined as never) as Record<string, unknown>
    expect(unrun).toMatchObject({ status: 'incomplete', open_items: [{ id: 'R001', reason_code: 'insufficient' }] })
    expect((unrun.open_items as Array<Record<string, unknown>>)[0]).not.toHaveProperty('binding_template')
    appendTest(session, 'test-success')
    expect(derive().coreV2?.predicates).toMatchObject({ R001: 'satisfied' })
    appendTest(session, 'test-failure', true)
    const failed = derive()
    expect(failed.coreV2?.predicates).toMatchObject({ R001: 'insufficient' })
    const after = await tool(failed).execute({ bindings: [] } as never, undefined as never) as Record<string, unknown>
    expect(after).toMatchObject({ status: 'incomplete', open_items: [{ id: 'R001', reason_code: 'insufficient' }] })
    expect(after).not.toHaveProperty('certificate')
  })

  it('does not count a successful Host call on another target as the current test', async () => {
    const { session, derive } = fixture()
    session.append('tool/call', { turn: 1, step: 1, callId: 'wrong-workdir' as never, name: 'bash',
      arguments: JSON.stringify({ command: 'pnpm test', workdir: '/other' }) })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'wrong-workdir' as never,
      content: [{ type: 'text', text: '10 tests passed' }], isError: false }) }, { surfaceOp: 'append' })
    const projection = derive()
    expect((projection.coreV2?.predicates as Record<string, string> | undefined)?.R001).not.toBe('satisfied')
    const result = await createCheckpointTool(() => projection, () => {}).execute({ bindings: [] } as never, undefined as never) as Record<string, unknown>
    expect(result.status).not.toBe('observed')
    expect(result.certificate).toBeUndefined()
  })

  it('keeps a sourced forbidden-file mutation visible instead of calling an empty action list complete', async () => {
    const { session, derive } = fixture('请只修改 packages/api/src/request.ts。错误日志还提到了 packages/web/src/request.ts，但本轮不要动后者。')
    const before = derive()
    expect(before.coreV2?.predicates).toMatchObject({ P001: 'constraint_active' })
    const active = await createPrepareTool({ getProjection: () => before }).execute({ item_id: 'P001' } as never, undefined as never) as Record<string, unknown>
    expect(active).toMatchObject({ status: 'active', reason_code: 'constraint_active' })
    const unresolvedCore = { ...before.coreV2, predicates: { ...(before.coreV2?.predicates as Record<string, unknown>), P001: 'constraint_unresolved' }, certifiable: false,
      unmet_requirements: ['P001'] }
    const unresolved = { ...before, coreV2: unresolvedCore }
    const unknown = await createPrepareTool({ getProjection: () => unresolved }).execute({ item_id: 'P001' } as never, undefined as never) as Record<string, unknown>
    expect(unknown).toMatchObject({ status: 'unknown', reason_code: 'constraint_unresolved' })
    session.append('tool/call', { turn: 1, step: 1, callId: 'forbidden-edit' as never, name: 'edit',
      arguments: JSON.stringify({ file_path: '/work/packages/web/src/request.ts', old_string: 'old', new_string: 'new' }) })
    session.append('tool/result', { turn: 1, step: 1,
      message: createToolResultMessage({ callId: 'forbidden-edit' as never,
        content: [{ type: 'text', text: 'done' }], isError: false }) }, { surfaceOp: 'append' })
    const projection = derive()
    expect(Object.values(projection.coreV2?.predicates ?? {})).toContain('constraint_violated')
    const violation = await createPrepareTool({ getProjection: () => projection }).execute({ item_id: 'P001' } as never, undefined as never) as Record<string, unknown>
    expect(violation).toMatchObject({ status: 'incomplete', reason_code: 'constraint_violated' })
    const feedback = await createCheckpointTool(() => projection, () => {}).execute({ bindings: [] } as never, undefined as never) as Record<string, unknown>
    expect(feedback.status).not.toBe('observed')
    expect(JSON.stringify(feedback)).toContain('constraint_violated')
  })

  it('reports unavailable shared-core projection as unknown instead of falling back to old pending debt', async () => {
    const { derive } = fixture()
    const projection = derive()
    projection.coreV2 = undefined
    const prepared = await createPrepareTool({ getProjection: () => projection }).execute({} as never, undefined as never) as Record<string, unknown>
    expect(prepared).toMatchObject({ status: 'unknown', reason_code: 'core_projection_unavailable' })
    const checkpoint = await createCheckpointTool(() => projection, () => {}).execute({ bindings: [] } as never, undefined as never) as Record<string, unknown>
    expect(checkpoint).toMatchObject({ status: 'unknown', reason_code: 'core_projection_unavailable', open_items: [] })
  })

  it('does not call a stale Host identity observed even if an older core object says complete', async () => {
    const { session, derive } = fixture()
    appendTest(session, 'stale-host-test')
    const projection = derive()
    expect(projection.coreV2?.certifiable).toBe(true)
    projection.hostStatus = 'unavailable'
    const result = await createCheckpointTool(() => projection, () => {}).execute({ bindings: [] } as never, undefined as never) as Record<string, unknown>
    expect(result).toMatchObject({ status: 'unknown', reason_code: 'host_lock_unsupported', open_items: [] })
  })

  it('leaves only sourced delivery open after the actual test and closes it only after the final turn', async () => {
    const { session, derive } = fixture('Run npm test and report its actual result.')
    appendTest(session, 'test-report', false, 'npm test')
    const beforeFinal = derive()
    expect(beforeFinal.coreV2?.predicates).toMatchObject({ R001: 'satisfied', R002: 'insufficient' })
    const pending = await createCheckpointTool(() => beforeFinal, () => {}).execute({ bindings: [] } as never, undefined as never) as Record<string, unknown>
    expect(pending).toMatchObject({ status: 'incomplete', open_items: [{ id: 'R002' }] })
    expect((pending.open_items as Array<{ id: string }>).map((row) => row.id)).toEqual(['R002'])
    session.append('assistant/message', { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'npm test completed: tests passed.' }] } } as never, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } } as never)
    const delivered = derive()
    expect(delivered.coreV2?.predicates).toMatchObject({ R001: 'satisfied', R002: 'satisfied' })
    const response = await createCheckpointTool(() => delivered, () => {}).execute({ bindings: [] } as never, undefined as never) as Record<string, unknown>
    expect(response).toMatchObject({ status: 'observed', open_items: [] })
  })

  it('does not let a revoked or unrelated release record revive historical ordinary debt', async () => {
    const { session, derive } = fixture()
    appendTest(session, 'release-history-test')
    const projection = derive()
    projection.releaseContracts.push({ contractId: 'old', revokedAtSeq: 3, operations: ['npm_publish'], adoptedBy: { seq: 2, digest: 'a' }, adoptedAtRevision: 1 } as never)
    projection.releaseContracts.push({ contractId: 'other-operation', operations: ['git_tag'], adoptedBy: { seq: 2, digest: 'b' }, adoptedAtRevision: 1 } as never)
    const ordinary = await createCheckpointTool(() => projection, () => {}).execute({ bindings: [] } as never, undefined as never) as Record<string, unknown>
    expect(ordinary).toMatchObject({ status: 'observed', open_items: [], feedback_source: 'confirmed_core_v2' })
    const testItem = projection.items.get('R001')!
    projection.items.set('P001', { ...testItem, id: 'P001', semanticAction: 'publish', status: 'pending', unitId: projection.currentUnitId,
      requestedTarget: { artifact_id: 'pkg', version: '0.7.0', registry: 'https://registry.example.test/' } })
    const unrelated = await createCheckpointTool(() => projection, () => {}).execute({ bindings: [] } as never, undefined as never) as Record<string, unknown>
    expect(unrelated.feedback_source).toBe('confirmed_core_v2')
    projection.releaseContracts.push({ contractId: 'other-candidate', operations: ['npm_publish'], adoptedBy: { seq: 2, digest: 'c' }, adoptedAtRevision: 1,
      candidate: { packageId: 'other', version: '0.7.0', registry: 'https://registry.example.test/' } } as never)
    const otherCandidate = await createCheckpointTool(() => projection, () => {}).execute({ bindings: [] } as never, undefined as never) as Record<string, unknown>
    expect(otherCandidate.feedback_source).toBe('confirmed_core_v2')
    projection.releaseContracts.push({ contractId: 'current-publish', operations: ['npm_publish'], adoptedBy: { seq: 2, digest: 'd' }, adoptedAtRevision: 1,
      candidate: { packageId: 'pkg', version: '0.7.0', registry: 'https://registry.example.test/' } } as never)
    const explicit = await createCheckpointTool(() => projection, () => {}).execute({ bindings: [] } as never, undefined as never) as Record<string, unknown>
    expect(explicit.feedback_source).toBeUndefined()
    expect(explicit.status).not.toBe('observed')
  })

  it('keeps an adopted npm release protected when the root did not provide enough target identity', () => {
    const { derive } = fixture('Publish package fixture@0.7.0.')
    const projection = derive()
    const item = [...projection.items.values()].find((entry) => entry.semanticAction === 'publish')!
    expect(item).toBeDefined()
    expect(item.requestedTarget).toEqual({})
    projection.releaseContracts.push({ contractId: 'fixture-publish', operations: ['npm_publish'],
      adoptedBy: { seq: 2, digest: 'd' }, adoptedAtRevision: 1,
      candidate: { packageId: 'fixture', version: '0.7.0', registry: 'https://registry.example.test/' } } as never)
    expect(defaultV6OrdinaryFeedbackScope(projection)).toBe(false)
    // The contract does not supply the missing registry to the user item.
    expect(item.requestedTarget).toEqual({})
    item.requestedTarget = { artifact_id: 'other' }
    expect(defaultV6OrdinaryFeedbackScope(projection)).toBe(true)
  })

  it('keeps an explicitly presented proof on the certificate path', async () => {
    const { session, derive } = fixture()
    appendTest(session, 'proof-test')
    const projection = derive()
    const result = await createCheckpointTool(() => projection, () => {}).execute({ bindings: [], proof: {} } as never, undefined as never) as Record<string, unknown>
    expect(result.feedback_source).toBeUndefined()
    expect(result.proof_state).toMatchObject({ status: 'invalid' })
    expect(result.status).toBe('incomplete')
  })

  it('does not let a migrated legacy review marker disappear behind an otherwise complete current core', async () => {
    const { session, derive } = fixture()
    appendTest(session, 'migration-test')
    const projection = derive()
    expect(projection.coreV2?.certifiable).toBe(true)
    projection.items.get('R001')!.needsReview = { reason: 'legacy_v6_generic_action', checkId: 'migration-test', recordedAtRevision: 1 }
    const result = await createCheckpointTool(() => projection, () => {}).execute({ bindings: [] } as never, undefined as never) as Record<string, unknown>
    expect(result).toMatchObject({ status: 'incomplete', reason_code: 'legacy_record_needs_review',
      open_items: [{ id: 'R001', reason_code: 'legacy_review' }] })
  })

  it('invalidates a discovery cursor when only the confirmed core waterline changes', async () => {
    const { derive } = fixture()
    const projection = derive()
    const original = projection.items.get('R001')!
    const ids = Array.from({ length: 9 }, (_, index) => `R${String(index + 1).padStart(3, '0')}`)
    for (const id of ids) projection.items.set(id, { ...original, id })
    projection.coreV2 = { ...projection.coreV2, schema: 'core-state/v2', certifiable: false, as_of: 10,
      unmet_requirements: ids, predicates: Object.fromEntries(ids.map((id) => [id, 'insufficient'])), current_actions: [] }
    const tool = createPrepareTool({ getProjection: () => projection })
    const first = await tool.execute({} as never, undefined as never) as { has_more: boolean; next_cursor: string }
    expect(first.has_more).toBe(true)
    projection.coreV2 = { ...projection.coreV2, as_of: 11 }
    const stale = await tool.execute({ page_cursor: first.next_cursor } as never, undefined as never) as Record<string, unknown>
    expect(stale).toMatchObject({ status: 'rejected', reason_code: 'discovery_cursor_stale' })
  })

  it('replays ordinary feedback without turning ignored old bindings into new qualification debt', async () => {
    const { session, derive } = fixture()
    appendTest(session, 'ordinary-before-checkpoint')
    const projection = derive()
    const args = { bindings: [{ item_id: 'R001', evidence_ids: ['old-qualification'] }] }
    const feedback = await createCheckpointTool(() => projection, () => {}).execute(args as never, undefined as never) as Record<string, unknown>
    expect(feedback).toMatchObject({ status: 'observed', feedback_source: 'confirmed_core_v2', open_items: [] })
    session.append('tool/call', { turn: 1, step: 2, callId: 'ordinary-feedback' as never,
      name: 'context_guard_checkpoint', arguments: JSON.stringify(args) })
    session.append('tool/result', { turn: 1, step: 2,
      message: createToolResultMessage({ callId: 'ordinary-feedback' as never,
        content: [{ type: 'text', text: JSON.stringify(feedback) }], isError: false }) }, { surfaceOp: 'append' })
    const replay = derive()
    expect(replay.checkpoints).toHaveLength(0)
    expect(replay.lastCheckpointRejections).toBeUndefined()
    expect(replay.coreV2?.predicates).toMatchObject({ R001: 'satisfied' })
  })
})
