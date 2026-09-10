import { describe, expect, it } from 'vitest'
import { interpretMessage } from '../../src/domain/semantics.js'
import { deriveProjection, PROTOCOL_V4_NOTICE } from '../../src/domain/derive.js'
import { decideTurnBoundary, progressFingerprint } from '../../src/domain/stop-policy.js'
import type { DerivedEnvelope } from '../../src/domain/types.js'

/**
 * How the current protocol partitions one message into obligations.
 *
 * The partition decides what the root is recorded as having asked for, so two
 * properties are load-bearing and are pinned here rather than left implicit:
 *
 * - no empty obligation: a clause that carries nothing must never become work
 *   the guard then demands a certificate for, and
 * - no truncated obligation: a clause must not end in the mark that separated
 *   it, because "更新皮肤中心、" no longer states what it orders and any later
 *   re-partition of it produces an empty clause.
 *
 * The historical granularity (`coordinationSplit: false`) is the one switch
 * that keeps a message recorded by the 0.4 line reading as that line read it;
 * both settings are exercised so neither can drift into the other.
 */

const MESSAGES = [
  '更新插件并检查 GUI 效果',
  '更新皮肤中心、在本地仓库记录',
  '请帮我安装 pkg@1.0.0 到 web 配置档，重启服务 api',
  '先测试；收到我的确认后再推送。',
  '修复代码，但不推送',
  '安装插件，重启 DSH',
  'Push repository /work/repo to remote origin refspec refs/heads/main.',
]

const project = (texts: string[], notice = true) => deriveProjection([
  ...(notice ? [{ seq: 0, type: 'user/message', data: { source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text: PROTOCOL_V4_NOTICE }] } } as DerivedEnvelope] : []),
  ...texts.map((text, index): DerivedEnvelope => ({ seq: index + 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })),
], { activation: 'always' }, { cwd: '/workspace' }, true).projection

const itemsOf = (text: string) => [...project([text]).items.values()]

describe('a coordinated instruction becomes one obligation per action', () => {
  it.each([
    ['更新皮肤中心、在本地仓库记录', ['更新皮肤中心', '、在本地仓库记录']],
    ['更新插件并检查 GUI 效果', ['更新插件', '检查 GUI 效果']],
  ])('partitions %s into %j', (text, expected) => {
    expect(itemsOf(text).map((item) => item.normalizedText)).toEqual(expected)
  })

  it('keeps one clause when the historical granularity is in force', () => {
    // The 0.4 boundary is the switch, and the switch is the session's durable
    // record — a message captured by the 0.4 line keeps that line's shape.
    expect(interpretMessage('更新皮肤中心、在本地仓库记录', { coordinationSplit: false })).toHaveLength(1)
    expect(interpretMessage('更新皮肤中心、在本地仓库记录', { coordinationSplit: true })).toHaveLength(2)
  })
})

describe('a partition records no empty and no truncated obligation', () => {
  it.each(MESSAGES)('records only obligations with content for %s', (text) => {
    const items = itemsOf(text)
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) {
      // An obligation the guard demands a certificate for has to say what it
      // is: a clause of pure punctuation is a partition artifact, not work.
      expect(item.normalizedText).toMatch(/[\p{L}\p{N}]/u)
    }
  })

  it.each(MESSAGES)('never ends an obligation on its separator for %s', (text) => {
    for (const item of itemsOf(text)) {
      expect(item.normalizedText.trim()).not.toMatch(/[、并且]$/u)
    }
  })

  it('gives the mark to the clause it opens, not to the one before it', () => {
    // The enumeration mark introduces the second action, so it belongs to that
    // clause and the clause keeps its own recorded text.
    const [, second] = itemsOf('更新皮肤中心、在本地仓库记录')
    expect(second!.normalizedText.startsWith('、')).toBe(true)
    expect(second!.id).toBe('R002')
  })
})

/**
 * The no-progress budget is durable state, not process memory.
 *
 * These cases drive the production decision and the production fold only: the
 * budget is written to the log and read back from it, so a reload restores it
 * and re-processing a record cannot spend it twice. A counter that reset on
 * reload would be a different contract — the bound would move every time the
 * host restarted the session — so "it resets" is a failure here, not a
 * conservative default.
 */
describe('the no-progress budget survives a reload', () => {
  // The boundary key names the event a decision was taken at.
  const RECORD = (fingerprint: string, boundaryKey: string, attempt: number) =>
    `Context Guard no-progress record: ${JSON.stringify({ fingerprint, boundaryKey, attempt })}`

  const record = (seq: number, text: string): DerivedEnvelope =>
    ({ seq, type: 'user/message', data: { source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text }] } })

  const armed = (texts: DerivedEnvelope[]) => deriveProjection([
    { seq: 0, type: 'command/run', data: { name: 'context-guard', args: 'on', source: { kind: 'user' } } },
    { seq: 1, type: 'user/message', data: { source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text: PROTOCOL_V4_NOTICE }] } },
    { seq: 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '持续推进，直到迁移脚本全部跑完为止。' }] } },
    ...texts,
  ], { activation: 'always' }, { cwd: '/workspace' }, true).projection

  /**
   * The projection as a reloaded session reads it: the durable log re-folded
   * with the Goal state the session already recorded, plus whatever records the
   * history contains. No in-process state is carried across.
   */
  const reload = (goalState: ReturnType<typeof armedWithGoal>, records: DerivedEnvelope[]) => {
    const projection = armed(records)
    projection.hostTurn = goalState.hostTurn
    projection.currentGoalRef = goalState.currentGoalRef
    projection.currentGoalPhase = goalState.currentGoalPhase
    projection.currentGoalActivation = goalState.currentGoalActivation
    return projection
  }

  const armedWithGoal = () => {
    // The host opens the turn; Guard takes the boundary identity from that
    // event rather than counting turns itself.
    const projection = deriveProjection([
      { seq: 0, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, type: 'command/run', data: { name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 2, type: 'user/message', data: { source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text: PROTOCOL_V4_NOTICE }] } },
      { seq: 3, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '持续推进，直到迁移脚本全部跑完为止。' }] } },
    ], { activation: 'always' }, { cwd: '/workspace' }, true).projection
    // Two earlier host turns already reached a decision about this state; the
    // session is now in the third, which is where the bound is reached.
    projection.hostTurn = 3
    projection.currentGoalRef = { id: 'goal-budget', revision: 4 }
    projection.currentGoalPhase = 'active'
    projection.currentGoalActivation = 'armed'
    return projection
  }

  it('reaches the bounded stop from a reloaded log with no in-process history', () => {
    const projection = armedWithGoal()
    const fingerprint = progressFingerprint(projection)
    // Nothing was observed in this process; the two prior boundaries are in the
    // log, and that is what the decision reads.
    const reloaded = reload(projection, [record(3, RECORD(fingerprint, '1', 1)), record(4, RECORD(fingerprint, '2', 2))])
    expect(decideTurnBoundary(reloaded)).toMatchObject({ action: 'stop', reason: 'no_progress_bounded_disarm' })
  })

  it('is idempotent: replaying the same log, or a duplicate record, changes nothing', () => {
    const projection = armedWithGoal()
    const fingerprint = progressFingerprint(projection)
    const log = [record(3, RECORD(fingerprint, '1', 1)), record(4, RECORD(fingerprint, '2', 2))]
    const once = reload(projection, log)
    const twice = reload(projection, log)
    expect([...twice.noProgressClaims.get(fingerprint)!]).toEqual([...once.noProgressClaims.get(fingerprint)!])
    expect(once.noProgressClaims.get(fingerprint)?.size).toBe(2)
    // The same attempt recorded again is the same claim, not a third one.
    // The same boundary recorded again is the same claim, not a third one —
    // this is the retry shape, where one boundary is processed twice.
    const duplicated = reload(projection, [...log, record(5, RECORD(fingerprint, '2', 2))])
    expect(duplicated.noProgressClaims.get(fingerprint)?.size).toBe(2)
    expect(decideTurnBoundary(duplicated)).toMatchObject({ reason: 'no_progress_bounded_disarm' })
  })

  it('re-evaluates on real progress instead of carrying the old budget', () => {
    const projection = armedWithGoal()
    const fingerprint = progressFingerprint(projection)
    const spent = reload(projection, [record(3, RECORD(fingerprint, '1', 1)), record(4, RECORD(fingerprint, '2', 2))])
    expect(decideTurnBoundary(spent)).toMatchObject({ reason: 'no_progress_bounded_disarm' })
    // The contract really moved, so this is a different fingerprint: a baseline
    // again, and the goal is not stopped for work that is progressing.
    spent.contractRevision += 1
    expect(decideTurnBoundary(spent)).toMatchObject({ action: 'stop', reason: 'goal_round_driver_owns_continuation' })
  })

  it('keeps a fingerprint that has no record at the baseline', () => {
    expect(decideTurnBoundary(armedWithGoal())).toMatchObject({
      action: 'stop', reason: 'goal_round_driver_owns_continuation',
    })
  })
})
