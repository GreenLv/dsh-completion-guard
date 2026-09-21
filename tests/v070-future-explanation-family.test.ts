import { describe, expect, it } from 'vitest'
import { Session, SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { deriveProjection, PROTOCOL_V6_NOTICE } from '../src/domain/derive.js'
import { renderRecoveryPacket } from '../src/domain/recovery.js'
import { currentActionBases, decideTurnBoundary } from '../src/domain/stop-policy.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'
import { presentExplanationHead } from '../src/domain/semantics.js'

const HOST = { ...evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' }),
  auditedForegroundRenderers: ['bash' as const] }
const scope = { cwd: '/work', sessionHeader: {
  version: SESSION_FORMAT_VERSION, id: 'v070-future-explanation', createdAt: 1, seedLength: 0, delegationDepth: 0,
} }

function task(root: string) {
  const id = SessionId('v070-future-explanation')
  const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, isSeeded: false, id, createdAt: 1, cwd: '/work' })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }],
    source: { kind: 'plugin', plugin: 'context-guard', form: 'notice', summary: 'v6' } }), { surfaceOp: 'append' })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: root }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const derive = () => deriveProjection(session.snapshotEvents() as never, { activation: 'always' }, scope, true, HOST).projection
  const deliver = (answer = 'This observation would compare actual test time and useful benefit later.') => {
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
      content: [{ type: 'text', text: answer }], source: { provider: 'fixture', model: 'fixture' },
    }) } as never, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  }
  const reload = () => Session.fromRestore(id, structuredClone(session.snapshotEvents()) as never,
    { version: SESSION_FORMAT_VERSION, isSeeded: false, id, createdAt: 1, cwd: '/work' }, SessionLogOffset(0), 'detached')
  return { session, derive, deliver, reload }
}

function currentExplanation(projection: ReturnType<ReturnType<typeof task>['derive']>, part: string) {
  return [...projection.items.values()].find((item) => item.normalizedText.includes(part))
}

describe('A13 present explanation beside future observation', () => {
  it('parses a preposition plus present frame before the matrix explanation', () => {
    expect(presentExplanationHead('For now, describe what a later evaluation would measure.')).toBeDefined()
    const p = task('For now, describe what a later evaluation would measure.').derive()
    expect([...p.items.values()].find((i) => i.kind === 'requirement')).toMatchObject({
      taskKind: 'inquiry', authorityDisposition: 'informational',
    })
  })
  it('keeps an action named only inside a how-to explanation as its object', () => {
    const p = task('For this turn, explain how to run npm test.').derive()
    expect([...p.items.values()].find((i) => i.kind === 'requirement')).toMatchObject({
      taskKind: 'inquiry', authorityDisposition: 'informational',
    })
    expect(currentActionBases(p)).toEqual([])
  })
  const positive = [
    ['en exact', 'At a future time, observe whether this isolated project would benefit from a faster test. For this turn, only explain that future observation. Do not run tests or modify files now.', 'only explain'],
    ['zh synonym', '以后再观察这个项目的测试是否值得提速。本轮只说明届时需要观察什么；现在不要运行测试，也不要修改文件。', '只说明'],
    ['en holdout', 'Later, see if faster tests would help. Today, describe the planned observation without executing it.', 'describe'],
    ['zh holdout', '将来再看测试提速是否有用。现在请讲清楚后续观察的判断依据。', '讲清楚'],
  ] as const
  for (const [name, root, part] of positive) {
    it(`${name}: present explanation closes on its own trusted final`, () => {
      const f = task(root)
      const before = f.derive()
      const item = currentExplanation(before, part)
      expect(item, name).toBeDefined()
      expect(item).toMatchObject({ taskKind: 'inquiry', authorityDisposition: 'informational', status: 'pending' })
      expect(currentActionBases(before)).toEqual([])
      expect(decideTurnBoundary(before)).toMatchObject({ action: 'stop' })
      const packet = renderRecoveryPacket(before)
      expect(packet).not.toContain(`[${item!.id}] interpretation_unresolved`)
      f.deliver()
      const after = f.derive()
      expect(after.items.get(item!.id)).toMatchObject({ status: 'answered' })
      const restored = f.reload()
      const replay = deriveProjection(restored.snapshotEvents() as never, { activation: 'always' }, scope, true, HOST).projection
      expect(replay.items.get(item!.id)).toMatchObject({ status: 'answered' })
    })
  }

  it('preserves a real current test beside a future benefit statement', () => {
    const f = task('At a future time, observe whether tests need speeding up. For this turn, run npm test and report the actual result.')
    const before = f.derive()
    const test = [...before.items.values()].find((item) => item.semanticAction === 'test')
    expect(test).toMatchObject({ status: 'pending', taskKind: 'action' })
    f.deliver('I have not run the test.')
    expect(f.derive().items.get(test!.id)).toMatchObject({ status: 'pending' })
  })

  it('preserves a Chinese present test beside future observation', () => {
    const f = task('以后观察提速收益。本轮运行项目的测试并报告实际结果。')
    const before = f.derive()
    const test = [...before.items.values()].find((item) => item.semanticAction === 'test')
    expect(test).toMatchObject({ status: 'pending', taskKind: 'action' })
    f.deliver('尚未运行测试。')
    expect(f.derive().items.get(test!.id)).toMatchObject({ status: 'pending' })
  })

  it('keeps a separate present test when an explanation precedes it', () => {
    const f = task('Explain what to observe later. Then run npm test now.')
    const before = f.derive()
    expect(currentExplanation(before, 'Explain')).toMatchObject({ taskKind: 'inquiry' })
    expect([...before.items.values()].find((item) => item.semanticAction === 'test')).toMatchObject({ status: 'pending', taskKind: 'action' })
  })

  it('keeps a Chinese cross-sentence test beside an explanation', () => {
    const f = task('先说明将来应观察什么。然后现在运行项目测试。')
    const before = f.derive()
    expect(currentExplanation(before, '说明')).toMatchObject({ taskKind: 'inquiry' })
    expect([...before.items.values()].find((item) => item.semanticAction === 'test')).toMatchObject({ status: 'pending', taskKind: 'action' })
  })

  it('does not promote a quoted instruction into a second authority', () => {
    const f = task('The note says “For this turn, only explain the future observation.” Summarize what the note says.')
    const before = f.derive()
    expect([...before.items.values()].filter((item) => item.kind === 'requirement' && item.status === 'pending')).toHaveLength(1)
    expect(currentActionBases(before)).toEqual([])
  })

  it('does not answer a reported or conditional explanation as a present request', () => {
    for (const root of [
      'The reviewer said to explain the future observation.',
      'If tests pass, explain the future observation.',
      'Tomorrow, explain the future observation.',
      '日志说本轮说明以后应观察什么。',
      '如果测试通过，本轮说明将来应观察什么。',
    ]) {
      const f = task(root)
      f.derive()
      f.deliver()
      expect([...f.derive().items.values()].some((item) => item.status === 'answered'
        && (item.normalizedText.includes('explain') || item.normalizedText.includes('说明')))).toBe(false)
    }
  })

  it('binds a repeated conditional explanation only to its own source span', () => {
    const f = task('如果测试通过，本轮说明观察方法。如果测试通过，本轮说明观察方法。现在说明评价方法。')
    const before = f.derive()
    const conditional = [...before.items.values()].filter((item) => item.normalizedText.startsWith('如果测试通过'))
    expect(conditional).toHaveLength(2)
    expect(conditional.every((item) => item.authorityDisposition === 'conditional_wait')).toBe(true)
    const present = currentExplanation(before, '现在说明评价方法')
    expect(present).toMatchObject({ taskKind: 'inquiry', authorityDisposition: 'informational' })
    f.deliver()
    const after = f.derive()
    expect(after.items.get(present!.id)).toMatchObject({ status: 'answered' })
    expect(conditional.every((item) => after.items.get(item.id)?.status !== 'answered')).toBe(true)
    expect(after.items.get(conditional[1]!.id)).toMatchObject({ status: 'pending' })
  })

  it('does not carry a condition across a sentence boundary', () => {
    const f = task('如果测试通过。现在说明评价方法。')
    expect(currentExplanation(f.derive(), '现在说明评价方法')).toMatchObject({
      taskKind: 'inquiry', authorityDisposition: 'informational',
    })
  })

  it('keeps an independently sourced test after a present explanation', () => {
    const f = task('For this turn, describe the planned observation, then run npm test.')
    const before = f.derive()
    expect(currentExplanation(before, 'describe')).toMatchObject({ taskKind: 'inquiry' })
    const test = [...before.items.values()].find((item) => item.semanticAction === 'test')
    expect(test).toMatchObject({ taskKind: 'action', status: 'pending' })
    f.deliver()
    expect(f.derive().items.get(test!.id)).toMatchObject({ status: 'pending' })
  })

  it('keeps an unknown residue unresolved rather than answering the whole clause', () => {
    const f = task('Explain the future observation and handle whatever else is necessary.')
    const before = f.derive()
    expect([...before.items.values()].some((item) => item.authorityDisposition === 'unresolved')).toBe(true)
    f.deliver()
    expect([...f.derive().items.values()].some((item) => item.status === 'pending' && item.authorityDisposition === 'unresolved')).toBe(true)
  })

  it('does not backfill the first Stop or create persistence from bare Continue', () => {
    const f = task('At a future time, observe whether tests need speeding up. For this turn, only explain the observation.')
    f.deliver()
    const first = f.derive()
    expect(currentActionBases(first)).toEqual([])
    expect(decideTurnBoundary(first)).toMatchObject({ action: 'stop' })
    f.session.append('turn/start', { turn: 2 })
    f.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Continue.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const second = f.derive()
    expect(currentActionBases(second)).toEqual([])
    expect(decideTurnBoundary(second, 'Continue.')).toMatchObject({ action: 'stop' })
  })
})
