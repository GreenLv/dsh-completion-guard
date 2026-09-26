import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V6_NOTICE } from '../../src/domain/derive.js'
import { sessionCoreSnapshot } from '../../src/core-v2/session.js'
import type { DerivedEnvelope } from '../../src/domain/types.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from '../../src/domain/host-lock.js'
import { persistedToolResultStatus } from '../../src/domain/evidence.js'

const HOST = evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'headless' })

type ResultShape = { outerError?: boolean; outerIsError?: boolean; messageIsError?: boolean;
  nested?: ReadonlyArray<{ callId?: string; isError?: boolean; text?: string }>; text?: string }

function replay(name: 'bash' | 'pwsh' | 'shell', result?: ResultShape) {
  const callId = 'test-call'
  const events: DerivedEnvelope[] = [
    { seq: 1, type: 'user/message', data: { source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice' },
      content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }] } },
    { seq: 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Run npm test.' }] } },
    { seq: 3, type: 'tool/call', data: { turn: 1, step: 1, callId, name,
      arguments: JSON.stringify({ command: 'npm test', workdir: '/work' }) } },
  ]
  if (result) events.push({ seq: 4, type: 'tool/result', data: {
    turn: 1, step: 1,
    ...(result.outerError ? { error: { name: 'SandboxUnavailableError', code: 'SANDBOX_UNAVAILABLE' } } : {}),
    ...(result.outerIsError ? { isError: true } : {}),
    message: { role: 'tool', source: { kind: 'tool', callId },
      toolCallId: result.nested?.length === 1 ? result.nested[0].callId ?? callId : undefined,
      isError: result.messageIsError || (result.nested?.length === 1 ? result.nested[0].isError : undefined),
      content: [{ type: 'text', text: result.nested?.[0]?.text ?? result.text ?? 'host result' }] },
  } })
  const projection = deriveProjection(events, { activation: 'always' }, { cwd: '/work' }, true, HOST).projection
  projection.durabilityWatermark = 'confirmed'
  return { evidence: [...projection.evidence.values()][0], core: sessionCoreSnapshot(events, projection) }
}

describe('v0.7 structured host result error priority', () => {
  it.each([
    ['nested sandbox denial', { nested: [{ isError: true, text: 'sandbox backend unavailable; no process started' }] }],
    ['nested denial over zero marker', { nested: [{ isError: true, text: '[exit code: 0]' }] }],
    ['outer error over zero marker', { outerError: true, nested: [{ isError: false, text: '[exit code: 0]' }] }],
    ['outer isError over zero marker', { outerIsError: true, nested: [{ isError: false, text: '[exit code: 0]' }] }],
    ['message isError over zero marker', { messageIsError: true, nested: [{ isError: false, text: '[exit code: 0]' }] }],
  ] as const)('%s cannot create a successful test fact', (_label, result) => {
    const { evidence, core } = replay('bash', result)
    expect(evidence.outcome).toBe('failure')
    expect(evidence.processFacts?.outcome).toBe('failure')
    expect(core?.facts).not.toEqual(expect.arrayContaining([expect.objectContaining({ outcome: 'success', predicate: 'test_outcome' })]))
  })

  it.each([
    ['mismatched nested call', { nested: [{ callId: 'different-call', isError: false, text: 'ok' }] }],
    ['conflicting nested returns', { nested: [{ isError: true, text: 'denied' }, { isError: false, text: 'ok' }] }],
    ['missing nested status', { nested: [{ text: 'ok' }] }],
    ['text-only renderer return', { text: '[exit code: 0]' }],
    ['empty content return', { nested: [] }],
  ] as const)('%s is insufficient evidence, not an observed process failure', (_label, result) => {
    const { evidence, core } = replay('bash', result)
    expect(evidence.outcome).toBe('unknown')
    expect(evidence.processFacts).toMatchObject({ outcome: 'unknown', hostToolReturned: 'result',
      outcomeReason: 'host_result_untrusted' })
    expect(core?.facts).not.toEqual(expect.arrayContaining([expect.objectContaining({ outcome: 'success', predicate: 'test_outcome' })]))
  })

  it('retains the audited markerless bash success without inventing an exit code', () => {
    const { evidence } = replay('bash', { nested: [{ isError: false, text: 'test finished' }] })
    expect(evidence.outcome).toBe('success')
    expect(evidence.processFacts).toMatchObject({ outcome: 'success', declaredExitCode: 'unknown',
      outcomeReason: 'unmarked_renderer_success' })
  })

  it('retains an explicit zero exit and rejects a nonzero exit', () => {
    expect(replay('bash', { nested: [{ isError: false, text: '[exit code: 0]' }] }).evidence.outcome).toBe('success')
    expect(replay('bash', { nested: [{ isError: false, text: '[exit code: 1]' }] }).evidence.outcome).toBe('failure')
  })

  it('does not apply audited bash renderer success to generic shell or an unreturned process', () => {
    expect(replay('shell', { nested: [{ isError: false, text: 'test finished' }] }).evidence.outcome).toBe('unknown')
    expect(replay('bash').evidence).toBeUndefined()
  })

  it('never replays a certified checkpoint carried by a failed host result', () => {
    const events: DerivedEnvelope[] = [
      { seq: 1, type: 'user/message', data: { source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice' },
        content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }] } },
      { seq: 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Run npm test.' }] } },
      { seq: 3, type: 'tool/call', data: { turn: 1, step: 1, callId: 'cp-1', name: 'context_guard_checkpoint',
        arguments: JSON.stringify({ bindings: [] }) } },
      { seq: 4, type: 'tool/result', data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'cp-1' }, role: 'tool', toolCallId: 'cp-1', isError: true, content: [{ type: 'text', text: JSON.stringify({ status: 'certified', certificate: {} }) }] } } },
    ]
    const projection = deriveProjection(events, { activation: 'always' }, { cwd: '/work' }, true, HOST).projection
    expect(projection.checkpoints).toHaveLength(0)
    expect(projection.items.size).toBeGreaterThan(0)
    expect(projection.integrity).toBe('valid')
  })

  it('does not replay a text-only certified receipt without an SDK nested return', () => {
    const events: DerivedEnvelope[] = [
      { seq: 1, type: 'user/message', data: { source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice' },
        content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }] } },
      { seq: 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Run npm test.' }] } },
      { seq: 3, type: 'tool/call', data: { turn: 1, step: 1, callId: 'cp-text', name: 'context_guard_checkpoint',
        arguments: '{"bindings":[]}' } },
      { seq: 4, type: 'tool/result', data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'cp-text' },
        content: [{ type: 'text', text: '{"status":"certified","certificate":{}}' }] } } },
    ]
    expect(deriveProjection(events, { activation: 'always' }, { cwd: '/work' }, true, HOST).projection.checkpoints).toHaveLength(0)
  })

  it('accepts only a matched successful PTC dispatch after its start event', () => {
    const dispatch = { subCallId: 'sub-1', rootCallId: 'root-1', parentCallId: 'parent-1', isError: false,
      content: [{ type: 'text', text: 'ok' }] }
    expect(persistedToolResultStatus(dispatch, 'sub-1', 'tool/ptc-dispatch', true)).toBe('clean')
    expect(persistedToolResultStatus(dispatch, 'sub-1', 'tool/ptc-dispatch', false)).toBe('unknown')
    expect(persistedToolResultStatus({ ...dispatch, subCallId: 'other' }, 'sub-1', 'tool/ptc-dispatch', true)).toBe('unknown')
    expect(persistedToolResultStatus({ ...dispatch, isError: undefined }, 'sub-1', 'tool/ptc-dispatch', true)).toBe('unknown')
    expect(persistedToolResultStatus(dispatch, 'sub-1')).toBe('unknown')
  })

  it('does not authenticate a nested return without its call identity', () => {
    const result = { message: { content: [{ type: 'tool-result', isError: false,
      content: [{ type: 'text', text: '[exit code: 0]' }] }] } }
    expect(persistedToolResultStatus(result, 'call-1')).toBe('unknown')
    expect(persistedToolResultStatus({ message: { content: [{ ...result.message.content[0], toolCallId: 'call-1' }] } }, 'call-1')).toBe('unknown')
  })

  it('does not let a dispatch result complete an ordinary call with the same id', () => {
    const base: DerivedEnvelope[] = [
      { seq: 1, type: 'user/message', data: { source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice' },
        content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }] } },
      { seq: 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Run npm test.' }] } },
      { seq: 3, type: 'tool/call', data: { turn: 1, step: 1, callId: 'same-id', name: 'bash',
        arguments: '{"command":"npm test","workdir":"/work"}' } },
    ]
    const dispatch: DerivedEnvelope = { seq: 4, type: 'tool/ptc-dispatch', data: {
      subCallId: 'same-id', rootCallId: 'root', parentCallId: 'parent', isError: false,
      content: [{ type: 'text', text: '[exit code: 0]' }],
    } }
    const ordinary = deriveProjection([...base, dispatch], { activation: 'always' }, { cwd: '/work' }, true, HOST).projection
    expect([...ordinary.evidence.values()]).not.toEqual(expect.arrayContaining([expect.objectContaining({ outcome: 'success' })]))

    const proper = deriveProjection([...base.slice(0, 2),
      { seq: 3, type: 'tool/ptc-dispatch-start', data: { subCallId: 'same-id', rootCallId: 'root',
        parentCallId: 'parent', name: 'bash', arguments: '{"command":"npm test","workdir":"/work"}' } },
      dispatch], { activation: 'always' }, { cwd: '/work' }, true, HOST).projection
    expect([...proper.evidence.values()]).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: 'success' })]))
  })

  it('marks a failed delegated host return as failed even when its text says completed', () => {
    const events: DerivedEnvelope[] = [
      { seq: 1, type: 'user/message', data: { source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice' },
        content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }] } },
      { seq: 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Create /work/a.txt.' }] } },
      { seq: 3, type: 'tool/call', data: { turn: 1, step: 1, callId: 'delegate-1', name: 'delegate_task',
        arguments: JSON.stringify({ prompt: 'Create /work/a.txt.' }) } },
      { seq: 4, type: 'tool/result', data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'delegate-1' }, role: 'tool', toolCallId: 'delegate-1', isError: true, content: [{ type: 'text', text: JSON.stringify({ status: 'completed' }) }] } } },
    ]
    const projection = deriveProjection(events, { activation: 'always' }, { cwd: '/work' }, true, HOST).projection
    expect([...projection.evidence.values()][0]).toMatchObject({ outcome: 'failure', delegatedSubtask: true })
    expect(projection.units.get('U001')?.delegationRefs?.[0]).toMatchObject({ status: 'failed' })
  })
})
