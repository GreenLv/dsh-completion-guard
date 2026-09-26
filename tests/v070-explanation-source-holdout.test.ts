import { describe, expect, it } from 'vitest'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { deriveProjection, PROTOCOL_V6_NOTICE } from '../src/domain/derive.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'
import { currentActionBases } from '../src/domain/stop-policy.js'

// Expectations were independently frozen before inspecting the repaired parser.
function project(text: string) {
  const id = SessionId('explanation-source-holdout')
  const header = { version: SESSION_FORMAT_VERSION, isSeeded: false, id,
    createdAt: 1, cwd: '/work' } as const
  const session = Session.create(id, undefined, header)
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }],
    source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice', summary: 'v6' },
  }), { surfaceOp: 'append' })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  return deriveProjection(session.snapshotEvents() as never, { activation: 'always' },
    { cwd: '/work', sessionHeader: { version: SESSION_FORMAT_VERSION, id,
      createdAt: 1, seedLength: 0, delegationDepth: 0 } }, true,
    evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' })).projection
}

describe('independent current explanation source holdouts', () => {
  for (const text of [
    'For now, describe what a later evaluation would measure.',
    'Only explain how to run npm test.',
    '这一轮请说明以后怎样比较测试耗时。',
  ]) {
    it(`retains the current information duty: ${text}`, () => {
      const projection = project(text)
      const requirements = [...projection.items.values()].filter(item => item.kind === 'requirement')
      expect(requirements.some(item => item.taskKind === 'inquiry'
        && item.authorityDisposition === 'informational')).toBe(true)
      expect(requirements.some(item => item.taskKind === 'action')).toBe(false)
      expect(currentActionBases(projection)).toEqual([])
    })
  }

  it('separates future observation from a present explanation', () => {
    const projection = project('Observe performance next month. Explain the proposed observation now.')
    expect([...projection.items.values()].some(item => item.taskKind === 'inquiry'
      && item.authorityDisposition === 'informational')).toBe(true)
    expect(currentActionBases(projection)).toEqual([])
  })

  it('keeps repeated condition spans attached to their own explanation', () => {
    const projection = project('If checks pass, explain the first result. If checks pass, explain the second result.')
    expect([...projection.items.values()].some(item => item.kind === 'requirement'
      && item.authorityDisposition === 'informational')).toBe(false)
    expect(currentActionBases(projection)).toEqual([])
  })

  for (const text of [
    'The note says: "For now, explain the future test observation."',
    'Should I explain the observation now or run npm test?',
  ]) {
    it(`does not manufacture execution authority: ${text}`, () => {
      expect(currentActionBases(project(text))).toEqual([])
    })
  }

  for (const text of [
    'Explain the future observation; run npm test now.',
    'Run npm test now and explain the actual result.',
  ]) {
    it(`keeps the real test obligation: ${text}`, () => {
      const projection = project(text)
      expect([...projection.items.values()].some(item => item.semanticAction === 'test'
        && item.taskKind === 'action' && item.status === 'pending')).toBe(true)
    })
  }
})
