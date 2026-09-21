import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V6_NOTICE } from '../src/domain/derive.js'
import { projectSessionCoreV2, sessionCoreSnapshot } from '../src/core-v2/session.js'
import type { DerivedEnvelope } from '../src/domain/types.js'
import { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'
import { auditedForegroundRenderers } from '../src/domain/host-resolver.js'
import { createRuntime } from '../src/runtime.js'

const note = { seq: 1, type: 'user/message', data: { source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' },
  content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }] } } as DerivedEnvelope

function projectionFor(root: string) {
  const events: DerivedEnvelope[] = [note, { seq: 2, type: 'turn/start', data: { turn: 1 } },
    { seq: 3, type: 'user/message', data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: root }] } }]
  const projection = deriveProjection(events, { activation: 'always' }, { cwd: '/work' }, true).projection
  projection.durabilityWatermark = 'confirmed'
  return { events, projection }
}

describe('v0.7.0 explicit read-only observer methods', () => {
  it.runIf(Boolean(process.env.DSH_RUNTIME_ROOT))('attests active installed foreground renderer bytes, not only package versions', () => {
    const root = process.env.DSH_RUNTIME_ROOT!
    expect(auditedForegroundRenderers(root, root)).toEqual(['bash', 'pwsh'])
  })
  it('retains the root method source and its separate file/test observer obligations', () => {
    const root = 'In this isolated workspace, modify the existing config.txt so it contains exactly mode=on followed by one newline. Run npm test and read config.txt back with host tools. Use the read-only context_guard_observe_file and context_guard_observe_test_readiness tools for the corresponding current requirements. Report what each observation establishes and the actual result.'
    const { events, projection } = projectionFor(root)
    const method = [...projection.items.values()].find((item) => item.normalizedText.includes('context_guard_observe_file'))
    expect(method).toBeDefined()
    expect((method as unknown as { observerMethod?: unknown }).observerMethod).toMatchObject({
      tools: ['context_guard_observe_file', 'context_guard_observe_test_readiness'],
    })
    expect(method!.observerMethod!.targetItemIds.map((id) => projection.items.get(id)?.semanticAction)).toEqual(['verify', 'test'])
    const snapshot = sessionCoreSnapshot(events, projection)!
    const methodRequirements = (snapshot.requirements as Array<Record<string, unknown>>)
      .filter((requirement) => String(requirement.id).startsWith(`${method!.id}:observer:`))
    expect(methodRequirements).toHaveLength(2)
    expect(methodRequirements.every((requirement) => requirement.required === true)).toBe(true)
    expect(projectSessionCoreV2(events, projection)?.certifiable).toBe(false)
  })

  it('keeps a quoted observer name and a different business use unresolved', () => {
    for (const root of [
      'Explain why the log says "Use context_guard_observe_file".',
      'Edit config.txt. Use the publisher to deploy the package.',
    ]) {
      const { projection } = projectionFor(root)
      expect([...projection.items.values()].some((item) => (item as unknown as { observerMethod?: unknown }).observerMethod)).toBe(false)
    }
  })

  it('does not upgrade an old generic method clause from persisted pre-v6 text', () => {
    const root = 'Run npm test in /work. Use context_guard_observe_test_readiness for this test.'
    const events: DerivedEnvelope[] = [
      { seq: 1, type: 'turn/start', data: { turn: 1 } },
      { seq: 2, type: 'user/message', data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: root }] } },
      { seq: 3, type: 'user/message', data: { source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' },
        content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }] } },
      { seq: 4, type: 'turn/start', data: { turn: 2 } },
      { seq: 5, type: 'user/message', data: { turn: 2, source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue.' }] } },
    ]
    const projection = deriveProjection(events, { activation: 'always' }, { cwd: '/work' }, true).projection
    expect([...projection.items.values()].some((item) => item.observerMethod)).toBe(false)
    const snapshot = sessionCoreSnapshot(events, projection)
    expect((snapshot?.requirements as Array<Record<string, unknown>> | undefined)?.some((requirement) =>
      requirement.predicate === 'observer_method_completed')).not.toBe(true)
  })

  it.each([
    'Run pnpm test in /work. Use context_guard_observe_test_readiness and context_guard_observe_secret tools for this test.',
    'Run pnpm test in /work. Use context_guard_observe_test_readiness and delete /work/config.txt.',
    'Run pnpm test in /work. Use context_guard_observe_test_readiness and publish the package.',
    'Run pnpm test in /work. Use context_guard_observe_test_readiness for this test; then perform another operation.',
    'Run pnpm test in /work. Do not use context_guard_observe_test_readiness for this test.',
  ])('does not close a mixed, unknown or negated method clause: %s', (root) => {
    const { events, projection } = projectionFor(root)
    const methods = [...projection.items.values()].filter((item) => item.observerMethod)
    const snapshot = sessionCoreSnapshot(events, projection)!
    const methodIds = new Set(methods.map((item) => item.id))
    const unresolved = (snapshot.requirements as Array<Record<string, unknown>>).some((requirement) =>
      requirement.kind === 'unknown' && !methodIds.has(String(requirement.id)))
    expect(methods.length === 0 || unresolved).toBe(true)
    expect(projectSessionCoreV2(events, projection)?.certifiable).toBe(false)
  })

  it('keeps an explicit pass requirement unmet on the same completed failing test run', () => {
    const { events } = projectionFor('Run npm test and make the tests pass.')
    events.push({ seq: 4, type: 'tool/call', data: { turn: 1, step: 1, callId: 'failed-test', name: 'bash',
      arguments: JSON.stringify({ command: 'npm test', workdir: '/work' }) } })
    events.push({ seq: 5, type: 'tool/result', data: { turn: 1, step: 1,
      message: createToolResultMessage({ callId: 'failed-test' as never,
        content: [{ type: 'text', text: '> fixture@1.0.0 test\n> node test.cjs\n1 test failed\n[exit code: 1]' }], isError: false }) } })
    const graph = evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' })
    const projection = deriveProjection(events, { activation: 'always' }, { cwd: '/work' }, true,
      { ...graph, auditedForegroundRenderers: ['bash'], digest: 'ab'.repeat(32) }).projection
    projection.durabilityWatermark = 'confirmed'
    const snapshot = sessionCoreSnapshot(events, projection)!
    expect((snapshot.requirements as Array<Record<string, unknown>>).find((requirement) => requirement.action === 'test_verify')?.predicate).toBe('test_passed')
    expect(projectSessionCoreV2(events, projection)?.certifiable).toBe(false)
  })

  it('binds the named readiness method to its original test and persisted Host result', () => {
    const root = 'Run pnpm test in /work. Use the read-only context_guard_observe_test_readiness tool for this current test.'
    const { events } = projectionFor(root)
    const initial = deriveProjection(events, { activation: 'always' }, { cwd: '/work' }, true).projection
    const test = [...initial.items.values()].find((item) => item.semanticAction === 'test')!
    const method = [...initial.items.values()].find((item) => item.observerMethod)!
    expect(test).toBeDefined()
    expect(method?.observerMethod?.targetItemIds).toEqual([test.id])
    events.push({ seq: 4, type: 'tool/call', data: { turn: 1, step: 1, callId: 'ready', name: 'context_guard_observe_test_readiness',
      arguments: JSON.stringify({ item_id: test.id }) } })
    events.push({ seq: 5, type: 'tool/result', data: { turn: 1, step: 1,
      message: createToolResultMessage({ callId: 'ready' as never, content: [{ type: 'text', text: JSON.stringify({ status: 'ready', scope: '/work', manifest_sha256: 'a'.repeat(64) }) }], isError: false }),
      meta: { contextGuardTestReadiness: { itemId: test.id, scope: '/work', manifestSha256: 'a'.repeat(64), predicate: 'test_passed' } } } })
    const projection = deriveProjection(events, { activation: 'always' }, { cwd: '/work' }, true).projection
    projection.durabilityWatermark = 'confirmed'
    const core = projectSessionCoreV2(events, projection)!
    expect(core.predicates).toMatchObject({ [`${method.id}:observer:1`]: 'satisfied' })
    expect(projection.items.get(method.id)?.status).toBe('passed')
    expect(core.certifiable).toBe(false) // The actual test has not run yet.
  })

  it('uses the exact root bytes for a work-unit method with no literal target', () => {
    const { events } = projectionFor('Run npm test now. Use the read-only context_guard_observe_test_readiness tool for this test.')
    const initial = deriveProjection(events, { activation: 'always' }, { cwd: '/work' }, true).projection
    const test = [...initial.items.values()].find((item) => item.semanticAction === 'test')!
    const method = [...initial.items.values()].find((item) => item.observerMethod)!
    expect(test).toBeDefined(); expect(method).toBeDefined()
    events.push({ seq: 4, type: 'tool/call', data: { turn: 1, step: 1, callId: 'ready-work-unit',
      name: 'context_guard_observe_test_readiness', arguments: JSON.stringify({ item_id: test.id }) } })
    events.push({ seq: 5, type: 'tool/result', data: { turn: 1, step: 1,
      message: createToolResultMessage({ callId: 'ready-work-unit' as never,
        content: [{ type: 'text', text: 'ready' }], isError: false }),
      meta: { contextGuardTestReadiness: { itemId: test.id, scope: '/work', manifestSha256: 'a'.repeat(64), predicate: 'test_passed' } } } })
    const projection = deriveProjection(events, { activation: 'always' }, { cwd: '/work' }, true).projection
    projection.durabilityWatermark = 'confirmed'
    const snapshot = sessionCoreSnapshot(events, projection)!
    const requirement = (snapshot.requirements as Array<Record<string, unknown>>).find((entry) => entry.id === `${method.id}:observer:1`)!
    const origin = requirement.target_origin as Record<string, unknown>
    const source = origin.root_constraint_source as { start: number; end: number }
    expect(origin.root_constraint).toBe(Buffer.from('Run npm test now. Use the read-only context_guard_observe_test_readiness tool for this test.')
      .subarray(source.start, source.end).toString('utf8'))
    expect(projectSessionCoreV2(events, projection)?.predicates).toMatchObject({ [`${method.id}:observer:1`]: 'satisfied' })
  })

  it('requires both independently sourced observers before the method closes on reload', () => {
    const root = 'Modify /work/config.txt. Run pnpm test in /work. Use the read-only context_guard_observe_file and context_guard_observe_test_readiness tools for the corresponding current requirements.'
    const { events } = projectionFor(root)
    const initial = deriveProjection(events, { activation: 'always' }, { cwd: '/work' }, true).projection
    const method = [...initial.items.values()].find((item) => item.observerMethod)!
    const test = [...initial.items.values()].find((item) => item.semanticAction === 'test')!
    expect(method?.observerMethod?.tools).toEqual(['context_guard_observe_file', 'context_guard_observe_test_readiness'])
    events.push({ seq: 4, type: 'tool/call', data: { turn: 1, step: 1, callId: 'edit', name: 'edit',
      arguments: JSON.stringify({ file_path: '/work/config.txt', old_string: 'off', new_string: 'on' }) } })
    events.push({ seq: 5, type: 'tool/result', data: { turn: 1, step: 1,
      message: createToolResultMessage({ callId: 'edit' as never, content: [{ type: 'text', text: 'edited' }], isError: false }) } })
    events.push({ seq: 6, type: 'tool/call', data: { turn: 1, step: 2, callId: 'file', name: 'context_guard_observe_file',
      arguments: JSON.stringify({ effect_call_id: 'edit' }) } })
    events.push({ seq: 7, type: 'tool/result', data: { turn: 1, step: 2,
      message: createToolResultMessage({ callId: 'file' as never, content: [{ type: 'text', text: 'observed' }], isError: false }),
      meta: { contextGuardNativeFile: { effectCallId: 'edit', path: '/work/config.txt', sha256: 'b'.repeat(64), action: 'modify' } } } })
    const one = deriveProjection(events, { activation: 'always' }, { cwd: '/work' }, true).projection
    one.durabilityWatermark = 'confirmed'
    expect(one.items.get(method.id)?.status).toBe('pending')
    expect(projectSessionCoreV2(events, one)?.predicates).toMatchObject({ [`${method.id}:observer:1`]: 'satisfied' })
    expect((projectSessionCoreV2(events, one)?.predicates as Record<string, unknown>)?.[`${method.id}:observer:2`]).not.toBe('satisfied')
    events.push({ seq: 8, type: 'tool/call', data: { turn: 1, step: 3, callId: 'ready', name: 'context_guard_observe_test_readiness',
      arguments: JSON.stringify({ item_id: test.id }) } })
    events.push({ seq: 9, type: 'tool/result', data: { turn: 1, step: 3,
      message: createToolResultMessage({ callId: 'ready' as never, content: [{ type: 'text', text: 'ready' }], isError: false }),
      meta: { contextGuardTestReadiness: { itemId: test.id, scope: '/work', manifestSha256: 'a'.repeat(64), predicate: 'test_passed' } } } })
    const full = deriveProjection(events, { activation: 'always' }, { cwd: '/work' }, true).projection
    full.durabilityWatermark = 'confirmed'
    expect(full.items.get(method.id)?.status).toBe('passed')
    expect(projectSessionCoreV2(events, full)?.predicates).toMatchObject({ [`${method.id}:observer:1`]: 'satisfied', [`${method.id}:observer:2`]: 'satisfied' })
    expect(projectSessionCoreV2(events.slice(0, 8), one)?.certifiable).toBe(false)
  })

  it('keeps direct identifier objects distinct from following report work', () => {
    const root = 'Run npm test now. Use the read-only `context_guard_observe_test_readiness` tool for this current test and report the actual result.'
    const { projection } = projectionFor(root)
    expect([...projection.items.values()].filter((item) => item.observerMethod)).toHaveLength(1)
    expect([...projection.items.values()].some((item) => item.normalizedText.startsWith('report the actual result.'))).toBe(true)
  })

  it('identifies Chinese and file-method source roles', () => {
    const roots = [
      '现在运行本项目的 npm test，并为这项测试调用只读 `context_guard_observe_test_readiness` 核查就绪，再如实报告运行结果。',
      'Modify config.txt to mode=on plus newline. For that current file change, consult `context_guard_observe_file` in read-only mode, then read the file back and report what happened.',
    ]
    for (const root of roots) {
      const { projection } = projectionFor(root)
      expect([...projection.items.values()].filter((item) => item.observerMethod)).toHaveLength(1)
      expect([...projection.items.values()].filter((item) => item.observerMethod)[0]?.observerMethod?.tools)
        .toEqual([root.includes('test_readiness') ? 'context_guard_observe_test_readiness' : 'context_guard_observe_file'])
    }
  })

  it('separates coordinated observer methods from their work and later obligations', () => {
    const cases = [
      { root: 'Run npm test now and use `context_guard_observe_test_readiness` for this current requirement.',
        actions: ['test'], methods: 1 },
      { root: 'Modify config.txt and use `context_guard_observe_file` for that change; then delete obsolete.txt.',
        actions: ['modify', 'generic_run'], methods: 1 },
      { root: 'Run npm test and use `context_guard_observe_test_readiness` for that test. Then evaluate the current change and report it.',
        actions: ['test', 'verify', 'generic_run'], methods: 1 },
    ]
    for (const { root, actions, methods } of cases) {
      const { projection } = projectionFor(root)
      const items = [...projection.items.values()]
      expect(items.filter((item) => item.observerMethod), root).toHaveLength(methods)
      expect(items.filter((item) => !item.observerMethod).map((item) => item.semanticAction), root)
        .toEqual(actions)
    }
  })

  it('keeps report and anaphoric readback as separate duties after an observer method', () => {
    const chinese = projectionFor('现在运行本项目的 npm test，并为这项测试调用只读 `context_guard_observe_test_readiness` 核查就绪，再如实报告运行结果。').projection
    expect([...chinese.items.values()].map((item) => [item.semanticAction, item.authorityDisposition]))
      .toEqual([['test', 'executable_now'], ['generic_run', 'unresolved'], ['generic_run', 'informational']])
    const english = projectionFor('Modify config.txt to mode=on plus newline. For that current file change, consult `context_guard_observe_file` in read-only mode, then read the file back and report what happened.').projection
    expect([...english.items.values()].map((item) => [item.semanticAction, item.authorityDisposition]))
      .toEqual([['modify', 'executable_now'], ['generic_run', 'unresolved'], ['verify', 'executable_now'], ['generic_run', 'informational']])
    const items = [...english.items.values()]
    const root = 'Modify config.txt to mode=on plus newline. For that current file change, consult `context_guard_observe_file` in read-only mode, then read the file back and report what happened.'
    for (const item of items) {
      const source = item.spans?.[0]
      expect(source, item.id).toBeDefined()
      expect(Buffer.from(root).subarray(source!.start, source!.end).toString().trim().endsWith(item.normalizedText), item.id).toBe(true)
    }
    const { events } = projectionFor(root)
    const requirements = sessionCoreSnapshot(events, english)?.requirements as Array<Record<string, unknown>>
    expect(requirements.find((requirement) => requirement.action === 'readback')?.predicate).toBe('file_content_checked')
    expect(requirements.find((requirement) => requirement.action === 'answer')?.predicate).toBe('answer_delivered')
  })

  it('satisfies a coordinated readiness method without fabricating the test outcome', () => {
    const root = 'Run npm test now and use `context_guard_observe_test_readiness` for this current requirement.'
    const { events, projection: initial } = projectionFor(root)
    const test = [...initial.items.values()].find((item) => item.semanticAction === 'test')!
    const method = [...initial.items.values()].find((item) => item.observerMethod)!
    events.push({ seq: 4, type: 'tool/call', data: { turn: 1, step: 1, callId: 'ready-coordinated',
      name: 'context_guard_observe_test_readiness', arguments: JSON.stringify({ item_id: test.id }) } })
    events.push({ seq: 5, type: 'tool/result', data: { turn: 1, step: 1,
      message: createToolResultMessage({ callId: 'ready-coordinated' as never,
        content: [{ type: 'text', text: 'ready' }], isError: false }),
      meta: { contextGuardTestReadiness: { itemId: test.id, scope: '/work',
        manifestSha256: 'a'.repeat(64), predicate: 'test_passed' } } } })
    const projection = deriveProjection(events, { activation: 'always' }, { cwd: '/work' }, true).projection
    projection.durabilityWatermark = 'confirmed'
    expect(projectSessionCoreV2(events, projection)?.predicates).toMatchObject({
      [method.id + ':observer:1']: 'satisfied', [test.id]: 'insufficient',
    })
    expect(projectSessionCoreV2(events, projection)?.certifiable).toBe(false)
  })

  it('keeps an independent delete unmet after the coordinated file observation succeeds', () => {
    const root = 'Modify config.txt and use `context_guard_observe_file` for that change; then delete obsolete.txt.'
    const { events, projection: initial } = projectionFor(root)
    const method = [...initial.items.values()].find((item) => item.observerMethod)!
    const extra = [...initial.items.values()].find((item) => item.normalizedText.includes('delete obsolete.txt'))!
    events.push({ seq: 4, type: 'tool/call', data: { turn: 1, step: 1, callId: 'edit-config', name: 'edit',
      arguments: JSON.stringify({ file_path: '/work/config.txt', old_string: 'off', new_string: 'on' }) } })
    events.push({ seq: 5, type: 'tool/result', data: { turn: 1, step: 1,
      message: createToolResultMessage({ callId: 'edit-config' as never,
        content: [{ type: 'text', text: 'edited' }], isError: false }) } })
    events.push({ seq: 6, type: 'tool/call', data: { turn: 1, step: 2, callId: 'observe-config',
      name: 'context_guard_observe_file', arguments: JSON.stringify({ effect_call_id: 'edit-config' }) } })
    events.push({ seq: 7, type: 'tool/result', data: { turn: 1, step: 2,
      message: createToolResultMessage({ callId: 'observe-config' as never,
        content: [{ type: 'text', text: 'observed' }], isError: false }),
      meta: { contextGuardNativeFile: { effectCallId: 'edit-config', path: '/work/config.txt',
        sha256: 'b'.repeat(64), action: 'modify' } } } })
    const projection = deriveProjection(events, { activation: 'always' }, { cwd: '/work' }, true).projection
    projection.durabilityWatermark = 'confirmed'
    const core = projectSessionCoreV2(events, projection)!
    expect(core.predicates).toMatchObject({ [method.id + ':observer:1']: 'satisfied' })
    expect((core.predicates as Record<string, unknown>)[extra.id]).not.toBe('satisfied')
    expect(core.certifiable).toBe(false)
  })

  it('does not let a later root borrow a method antecedent from an earlier root', () => {
    const { events } = projectionFor('Modify config.txt and use its current file observer.')
    const firstIds = new Set(deriveProjection(events, { activation: 'always' }, { cwd: '/work' }, true).projection.items.keys())
    events.push({ seq: 4, type: 'turn/start', data: { turn: 2 } })
    events.push({ seq: 5, type: 'user/message', data: { turn: 2, source: { kind: 'user' },
      content: [{ type: 'text', text: 'Use `context_guard_observe_file` for that change.' }] } })
    const projection = deriveProjection(events, { activation: 'always' }, { cwd: '/work' }, true).projection
    const later = [...projection.items.values()].filter((item) => !firstIds.has(item.id))
    expect(later).toHaveLength(1)
    expect(later[0]?.observerMethod).toBeUndefined()
  })

  it('separates run completion from accurate report delivery for a named test', () => {
    const { events, projection } = projectionFor('Run npm test and report its actual result.')
    const rows = sessionCoreSnapshot(events, projection)?.requirements as Array<Record<string, unknown>>
    expect(rows.map((entry) => [entry.action, entry.predicate])).toEqual([
      ['test_verify', 'test_run_completed'], ['answer', 'answer_delivered'],
    ])
  })

  it('accepts a completed named Host test without an unrequested Guard readiness call only with renderer attestation', () => {
    const { events } = projectionFor('Run npm test and report its actual result.')
    events.push({ seq: 4, type: 'tool/call', data: { turn: 1, step: 1, callId: 'native-test', name: 'bash',
      arguments: JSON.stringify({ command: 'npm test', workdir: '/work' }) } })
    events.push({ seq: 5, type: 'tool/result', data: { turn: 1, step: 1,
      message: createToolResultMessage({ callId: 'native-test' as never, content: [{ type: 'text', text: '2 tests passed' }], isError: false }) } })
    const graph = evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' })
    const trusted = deriveProjection(events, { activation: 'always' }, { cwd: '/work' }, true,
      { ...graph, auditedForegroundRenderers: ['bash'], digest: 'ab'.repeat(32) }).projection
    trusted.durabilityWatermark = 'confirmed'
    expect(projectSessionCoreV2(events, trusted)?.predicates).toMatchObject({ R001: 'satisfied', R002: 'insufficient' })
    const unattested = deriveProjection(events, { activation: 'always' }, { cwd: '/work' }, true, graph).projection
    unattested.durabilityWatermark = 'confirmed'
    expect((projectSessionCoreV2(events, unattested)?.predicates as Record<string, unknown>)?.R001).not.toBe('satisfied')
  })

  it('keeps an exact named test effect available inside the full observer-control root', () => {
    const root = 'In this isolated workspace, modify the existing config.txt so it contains exactly mode=on followed by one newline. Run npm test and read config.txt back with host tools. Use the read-only context_guard_observe_file and context_guard_observe_test_readiness tools for the corresponding current requirements. Report what each observation establishes and the actual result.'
    const { events } = projectionFor(root)
    events.push({ seq: 4, type: 'tool/call', data: { turn: 1, step: 1, callId: 'native-test', name: 'bash',
      arguments: JSON.stringify({ command: 'npm test', workdir: '/work' }) } })
    events.push({ seq: 5, type: 'tool/result', data: { turn: 1, step: 1,
      message: createToolResultMessage({ callId: 'native-test' as never,
        content: [{ type: 'text', text: '> test\n> node test.cjs\n' }], isError: false }) } })
    const graph = evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' })
    const projection = deriveProjection(events, { activation: 'always' }, { cwd: '/work' }, true,
      { ...graph, auditedForegroundRenderers: ['bash'], digest: 'ab'.repeat(32) }).projection
    projection.durabilityWatermark = 'confirmed'
    const test = [...projection.items.values()].find((item) => item.semanticAction === 'test')!
    expect(projectSessionCoreV2(events, projection)?.predicates).toMatchObject({ [test.id]: 'satisfied' })
  })

  it('replays the Host test and method facts from a persisted Session at each watermark', () => {
    const id = SessionId('v070-observer-reload')
    const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, isSeeded: false, id, createdAt: 1, cwd: '/work' })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }],
      source: { kind: 'plugin', plugin: 'context-guard', form: 'notice', summary: 'v6' } }), { surfaceOp: 'append' })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text',
      text: 'Run npm test in /work. Use context_guard_observe_test_readiness for this current test.' }],
      source: { kind: 'user' } }), { surfaceOp: 'append' })
    const graph = evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' })
    const host = { ...graph, auditedForegroundRenderers: ['bash' as const], digest: 'ab'.repeat(32) }
    const replay = () => {
      const restored = Session.fromRestore(id, structuredClone(session.snapshotEvents()) as never,
        structuredClone(session.header) as never, SessionLogOffset(0), 'detached')
      const events = restored.snapshotEvents() as unknown as DerivedEnvelope[]
      const runtime = createRuntime({ session: restored } as never, { activation: 'always' } as never, host)
      runtime.setDurability(true); runtime.sync()
      const projection = runtime.projection
      return { projection, core: projectSessionCoreV2(events, projection)! }
    }
    const initial = replay()
    const test = [...initial.projection.items.values()].find((item) => item.semanticAction === 'test')!
    const method = [...initial.projection.items.values()].find((item) => item.observerMethod)!
    expect(initial.core.predicates).toMatchObject({ [test.id]: 'insufficient', [`${method.id}:observer:1`]: 'insufficient' })
    session.append('tool/call', { turn: 1, step: 1, callId: 'native-test' as never, name: 'bash',
      arguments: JSON.stringify({ command: 'npm test', workdir: '/work' }) })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'native-test' as never,
      content: [{ type: 'text', text: '2 tests passed' }], isError: false }) } as never, { surfaceOp: 'append' })
    const ran = replay()
    expect(ran.core.predicates).toMatchObject({ [test.id]: 'satisfied', [`${method.id}:observer:1`]: 'insufficient' })
    session.append('tool/call', { turn: 1, step: 2, callId: 'ready' as never, name: 'context_guard_observe_test_readiness',
      arguments: JSON.stringify({ item_id: test.id }) })
    session.append('tool/result', { turn: 1, step: 2, message: createToolResultMessage({ callId: 'ready' as never,
      content: [{ type: 'text', text: JSON.stringify({ status: 'ready', scope: '/work', manifest_sha256: 'a'.repeat(64) }) }], isError: false }),
      meta: { contextGuardTestReadiness: { itemId: test.id, scope: '/work', manifestSha256: 'a'.repeat(64), predicate: 'test_passed' } } } as never,
    { surfaceOp: 'append' })
    const observed = replay()
    expect(observed.core.predicates).toMatchObject({ [test.id]: 'satisfied', [`${method.id}:observer:1`]: 'satisfied' })
    expect(observed.projection.items.get(method.id)?.status).toBe('passed')
  })

  it('keeps the same exact renderer rule available for a Windows-shaped pwsh Host call', () => {
    const root = 'Run npm test in C:\\Work.'
    const events: DerivedEnvelope[] = [note, { seq: 2, type: 'turn/start', data: { turn: 1 } },
      { seq: 3, type: 'user/message', data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: root }] } },
      { seq: 4, type: 'tool/call', data: { turn: 1, step: 1, callId: 'win-test', name: 'pwsh',
        arguments: JSON.stringify({ command: 'npm test', workdir: 'C:\\Work' }) } },
      { seq: 5, type: 'tool/result', data: { turn: 1, step: 1,
        message: createToolResultMessage({ callId: 'win-test' as never, content: [{ type: 'text', text: '2 tests passed' }], isError: false }) } }]
    const graph = evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'windows', profileKind: 'web' })
    const projection = deriveProjection(events, { activation: 'always' }, { cwd: 'C:\\Work' }, true,
      { ...graph, auditedForegroundRenderers: ['pwsh'], digest: 'ab'.repeat(32) }).projection
    projection.durabilityWatermark = 'confirmed'
    expect(projectSessionCoreV2(events, projection)?.predicates).toMatchObject({ R001: 'satisfied' })
  })

  it.each([
    ['2 tests passed', 'npm test completed: tests passed.', false, 'satisfied', 'satisfied'],
    ['2 tests passed', 'npm test completed with exit code 0.', false, 'satisfied', 'satisfied'],
    ['> fixture@1.0.0 test\n> node test.cjs\n1 test failed\n[exit code: 1]', 'npm test completed with exit code 1; tests failed.', false, 'insufficient', 'insufficient'],
    ['npm error Missing script: "test"\n[exit code: 1]', 'npm test completed with exit code 1.', false, 'insufficient', 'insufficient'],
    ['[sandbox: file access denied under workspace-write mode]\n[exit code: 1]', 'npm test completed with exit code 1.', false, 'insufficient', 'insufficient'],
    ['1 test failed\n[exit code: 1]', 'npm test completed with exit code **1**; tests failed.', true, 'insufficient', 'satisfied'],
    ['2 tests passed', 'npm test completed: tests failed.', false, 'satisfied', 'insufficient'],
    ['2 tests passed', 'npm test completed: tests passed, but exit code 1.', false, 'satisfied', 'insufficient'],
  ])('keeps run outcome, truthful report, and error boundary separate: %s', (output, final, isError, expectedRun, expectedReport) => {
    const { events } = projectionFor('Run npm test and report its actual result.')
    events.push({ seq: 4, type: 'tool/call', data: { turn: 1, step: 1, callId: 'native-test', name: 'bash',
      arguments: JSON.stringify({ command: 'npm test', workdir: '/work' }) } })
    events.push({ seq: 5, type: 'tool/result', data: { turn: 1, step: 1,
      message: createToolResultMessage({ callId: 'native-test' as never, content: [{ type: 'text', text: output }], isError }) } })
    events.push({ seq: 6, type: 'assistant/message', data: { turn: 1, step: 2,
      message: { role: 'assistant', content: [{ type: 'text', text: final }] } } })
    events.push({ seq: 7, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    const graph = evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' })
    const projection = deriveProjection(events, { activation: 'always' }, { cwd: '/work' }, true,
      { ...graph, auditedForegroundRenderers: ['bash'], digest: 'ab'.repeat(32) }).projection
    projection.durabilityWatermark = 'confirmed'
    const core = projectSessionCoreV2(events, projection)!
    expect(core.predicates).toMatchObject({ R001: expectedRun })
    expect(core.predicates).toMatchObject({ R002: expectedReport })
    if (expectedRun === 'satisfied' && expectedReport === 'satisfied') expect(core.certifiable).toBe(true)
  })

})
