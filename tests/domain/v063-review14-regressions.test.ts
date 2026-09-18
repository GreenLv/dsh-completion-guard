import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { interpretMessage, isQuestionScopeNeedingReview } from '../../src/domain/semantics.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { type DerivedEnvelope } from '../../src/domain/types.js'
import { expectNarrowedUndecided } from './narrowed-contract.js'

/**
 * The fourteenth review's counterexamples, kept as regression coverage.
 *
 * The thirteenth repair round had closed an investigation's complement only when a
 * KNOWN action predicate appeared inside it and no word from an actor list stood in
 * it — i.e. closure was still granted by the ABSENCE of a protection pattern. The
 * review showed the consequence: a STATE WORD that is an action's object or modifier
 * was accepted as proof, so all four of these authorized a restart:
 *
 * - `Check whether the technicians install available updates and restart service api.`
 * - `Check whether the technicians archive completed jobs and restart service api.`
 * - `检查程序是否安装更新并重启 api 服务。`
 * - `确认小王是否更新依赖并重启 api 服务。`
 *
 * The repair replaces the absent-pattern test with a positive one: the complement
 * must PREDICATE a state. This file pins the reviewer's four cases, the siblings of
 * the same root cause that the positive rule must also refuse, and the proven state
 * questions whose coordinated orders must keep their authority.
 *
 * Expectations come from the contract, never from the implementation.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-review14', createdAt: 1 } }

let seq = 0
function derive(texts: string | string[]) {
  if (typeof texts === 'string') texts = [texts]
  seq = 0
  const events: DerivedEnvelope[] = [{
    seq: seq++, type: 'user/message', data: {
      source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' },
      content: [{ type: 'text', text: PROTOCOL_V5_NOTICE }],
    },
  }]
  texts.forEach((text, index) => {
    const turn = index + 1
    events.push(
      { seq: seq++, type: 'turn/start', data: { turn } },
      { seq: seq++, type: 'user/message', data: { turn, source: { kind: 'user' }, content: [{ type: 'text', text }] } },
      { seq: seq++, type: 'assistant/message', data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '收到。' }] } } },
      { seq: seq++, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
    )
  })
  return deriveProjection(events, config, scope, true).projection
}

function authorizations(projection: ReturnType<typeof derive>): string[] {
  const out: string[] = []
  for (const item of projection.items.values()) {
    for (const action of [item.semanticAction, ...(item.actionPlan ?? []).map((entry) => entry.action)]) {
      if (!action || action === 'generic_run') continue
      const planTarget = (item.actionPlan ?? []).find((entry) => entry.action === action)?.requestedTarget
      out.push(`${action}:${authorizeMutationFromProjection(projection, {
        action, contractItemId: item.id, contractItemRevision: item.revision,
        resolvedTarget: planTarget ?? item.requestedTarget ?? {},
      } as never).status}`)
    }
  }
  return out
}

/** The reviewer's four cases, verbatim. */
const REVIEW_CASES = [
  'Check whether the technicians install available updates and restart service api.',
  'Check whether the technicians archive completed jobs and restart service api.',
  '检查程序是否安装更新并重启 api 服务。',
  '确认小王是否更新依赖并重启 api 服务。',
]

/**
 * Siblings of the same root cause: a state word sits inside an action's object, its
 * modifier, its relative clause, or behind a causative verb — none of which makes it
 * the complement's predicate.
 */
const STATE_WORD_IN_ACTION_OBJECT = [
  'Check whether the technicians install the available updates and restart service api.',
  'Check whether the technicians install updates that are available and restart service api.',
  'Check whether the technicians make the cache valid and restart service api.',
  'Check whether the technicians keep the queue empty and restart service api.',
  '检查是否完成迁移并重启 api 服务。',
  '检查是否有人安装有效的配置并重启 api 服务。',
  '检查是否由值班人员保留空闲的副本并重启 api 服务。',
  '检查一下安装 foo 并重启 api 服务是不是安全。',
]

describe('review 14 / K1: closure needs a state PREDICATE, not a state word', () => {
  it.each([...REVIEW_CASES, ...STATE_WORD_IN_ACTION_OBJECT])(
    '%s is one undecided obligation that authorizes nothing', (text) => {
      const projection = derive(text)
      const items = [...projection.items.values()]
      expect(items.length, text).toBe(1)
      expect(items[0]!.authorityDisposition, text).toBe('unresolved')
      expect(isQuestionScopeNeedingReview(items[0]!.normalizedText), text).toBe(true)
      for (const decision of authorizations(projection)) {
        expect(decision.endsWith(':authorized'), `${text} / ${decision}`).toBe(false)
      }
    })

  it.each(REVIEW_CASES)('%s is refused by preparation too', async (text) => {
    const projection = derive(text)
    const item = [...projection.items.values()][0]!
    const prepared = await createPrepareTool({ getProjection: () => projection }).execute({
      item_id: item.id, semantic_action: item.semanticAction ?? 'restart',
      requested_target: item.requestedTarget ?? {},
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(prepared.compatibility.status, text).not.toBe('compatible')
  })

  it.each([
    ['检查服务是否正常并记录变更。', '记录变更'],
    ['确认磁盘空间是否充足并清理临时文件。', '清理临时文件'],
    ['确认缓存是否有效并安装依赖。', '安装依赖'],
    ['确认锁文件是否最新并安装依赖。', '安装依赖'],
    ['检查是否有新版本并记录变更。', '记录变更'],
    ['检查是否有更新并安装新主题。', '安装新主题'],
    ['Check whether the cache is valid and install the package.', 'install the package'],
    ['Verify whether the lock file is current and install the package.', 'install the package'],
  ])('%s predicates a state, so the coordinated order keeps its authority', (text, _needle) => {
    // 合同调整 (0.6.3 收窄合同): the coordinated action stays one undecided
    // obligation and is no longer auto-authorized.
    expectNarrowedUndecided(text)
  })

  it('合同调整: a SEPARATE clause keeps its authority, only a coordination inside one governed clause is narrowed', () => {
    const scopes = interpretMessage('检查是否存在更新；安装新主题；')
    expect(
      scopes.some((entry) => entry.authorityDisposition === 'executable_now' && entry.text.includes('安装新主题')),
      JSON.stringify(scopes.map((entry) => [entry.authorityDisposition, entry.text])),
    ).toBe(true)
  })

  it.each([
    '检查是否有新版本。',
    '检查是否存在更新。',
    'Verify whether the disk is full.',
    '检查部署脚本是否已经完成迁移。',
  ])('%s stays an answerable question, not a scope needing review', (text) => {
    const scopes = interpretMessage(text)
    expect(
      scopes.some((entry) => entry.authorityDisposition === 'informational'),
      JSON.stringify(scopes.map((entry) => [entry.authorityDisposition, entry.text])),
    ).toBe(true)
    expect(isQuestionScopeNeedingReview(text)).toBe(false)
  })

  it('a separate sentence after the investigation is still authority', () => {
    const projection = derive('确认是否有同事重建索引。然后重启 api 服务。')
    const restart = [...projection.items.values()].find((item) => item.normalizedText.includes('重启 api 服务'))
    expect(restart?.authorityDisposition).toBe('executable_now')
  })

  it('a plain order keeps its authority beside the refused shapes', () => {
    const projection = derive('安装更新并重启 api 服务。')
    expect([...projection.items.values()].some((item) => item.authorityDisposition === 'executable_now')).toBe(true)
  })
})
