import { describe, expect, it } from 'vitest'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { deriveProjection, PROTOCOL_V4_NOTICE } from '../../src/domain/derive.js'

/**
 * Activation order is the user's choice, not a contract the guard may assume.
 *
 * A session that starts work and enables the guard afterwards is an ordinary
 * history — the incident this work comes from is one — so both orders must
 * capture identically. This was in doubt while a composed fixture reported
 * `enabled: true` with an empty item set; the ordering hypothesis was tested
 * here rather than assumed, and it is disproved: the guard reads the same in
 * either order when the history is the session's own.
 */
const enabledFirstOrAfter = (goalFirst: boolean) => {
  const session = Session.create(SessionId('activation-order'), undefined, {
    version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId('activation-order'), createdAt: 1, cwd: '/work/repo',
  })
  const enable = () => {
    session.append('command/run', { name: 'context-guard', args: 'on', source: { kind: 'user' } } as never)
    session.append('user/message', { source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text: PROTOCOL_V4_NOTICE }] } as never, { surfaceOp: 'append' } as never)
  }
  const goal = () => session.append('goal/change', {
    kind: 'goal/change', version: 1, operation: 'create',
    goal: { id: 'g-order', revision: 1, objective: 'ship it', phase: 'active', maxGoalRounds: 256 },
    roundsStarted: 0, createdAt: 1, updatedAt: 1,
  } as never)
  const ask = () => session.append('user/message', {
    source: { kind: 'user' }, content: [{ type: 'text', text: '请在收到我的确认后再推送代码。' }],
  } as never, { surfaceOp: 'append' } as never)

  if (goalFirst) { goal(); enable(); ask() } else { enable(); ask(); goal() }
  const projection = deriveProjection(session.snapshotEvents() as never, { activation: 'opt-in' }, { cwd: '/work/repo' }, true).projection
  return projection
}

describe('enabling the guard before or after work exists', () => {
  it.each([['after the Goal exists', true], ['before the Goal exists', false]])('captures the same obligation %s', (_label, goalFirst) => {
    const projection = enabledFirstOrAfter(goalFirst)
    expect(projection.enabled).toBe(true)
    expect(projection.epoch).toBe(1)
    const items = [...projection.items.values()]
    expect(items).toHaveLength(1)
    expect(items[0]!.authorityDisposition).toBe('conditional_wait')
    expect(items[0]!.waitAuthorization?.kind).toBe('root_explicit_wait')
  })

  it('records the Goal the session created in either order', () => {
    for (const goalFirst of [true, false]) {
      const projection = enabledFirstOrAfter(goalFirst)
      expect(projection.currentGoalRef?.id).toBe('g-order')
      expect(projection.currentGoalPhase).toBe('active')
    }
  })
})
