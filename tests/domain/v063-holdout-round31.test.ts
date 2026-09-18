import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { interpretMessage, isQuestionScopeNeedingReview } from '../../src/domain/semantics.js'
import { captureClause } from '../../src/domain/capture.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope } from '../../src/domain/types.js'
import { expectNarrowedUndecided } from './narrowed-contract.js'

/**
 * 0.6.3 hold-out round 31 — the current independent set.
 *
 * Round 30 was written for the inverted rule (governing by default, closing on a
 * state question), but the fourteenth review then showed that rule still accepted a
 * state WORD that was an action's object or modifier as proof, so the repair made
 * closure require a state PREDICATE. That repair changed the source, so round 30 is
 * regression coverage; this set is the replacement and required no source change.
 *
 * It exercises both sides with wording this batch has never used:
 *
 * - state words as an action's object, its attributive modifier, its relative clause
 *   and behind a causative verb, in both languages;
 * - predicates that ARE the complement: Chinese adjectives and the stative verbs
 *   (有/是/为/存在) that govern a state noun or another predicate;
 * - the English copula shapes;
 * - the coordination-free answerable lane beside them;
 * - inheritance and the gate/preparation pair on the same shapes.
 *
 * Expectations come from the contract. A failure here is a source finding: this set
 * found two. The English infinitive test fired on the `to` inside `up-to-date`, so a
 * copula state question never closed; and the Chinese modifier strip was lazy, so
 * `有可用的镜像` stopped at `的镜像` and the coordinated order lost its authority.
 * Both were repaired in the source, which is why this set is no longer untuned
 * evidence and round 32 replaces it. Two of its own expectations were also wrong and
 * are corrected in place, labelled as oracle errors: a coordination of two state
 * predications was expected to be an order, and a PROVEN state question was expected
 * to hold no authority.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-holdout31', createdAt: 1 } }

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

describe('hold-out 31 / K1: closure needs the predicate, both sides', () => {
  it.each([
    'Check whether the contractor ships the complete inventory and restart service api.',
    'Check whether the reviewer signs the approved manifest and restart service api.',
    'Check whether the operator keeps the queue empty until the migration lands and restart service api.',
    '核对承包商是否运送完好的封装并重启 api 服务。',
    '确认评审人是否签署有效的许可并重启 api 服务。',
    '确认承包商是否一直保持空闲的副本并重启 api 服务。',
    '核对一下安装 foo 并重启 api 服务是不是安全。',
  ])('%s is one undecided obligation that authorizes nothing', (text) => {
    const projection = derive(text)
    const items = [...projection.items.values()]
    expect(items.length, text).toBe(1)
    expect(items[0]!.authorityDisposition, text).toBe('unresolved')
    expect(isQuestionScopeNeedingReview(items[0]!.normalizedText), text).toBe(true)
    for (const decision of authorizations(projection)) {
      expect(decision.endsWith(':authorized'), `${text} / ${decision}`).toBe(false)
    }
  })

  it.each([
    ['核对缓存是否干净并轮换日志。', '轮换日志'],
    ['确认配置是否一致并清理临时文件。', '清理临时文件'],
    ['确认是否有可用的镜像并清理临时文件。', '清理临时文件'],
    ['Confirm whether the vault is empty and restart service api.', 'restart service api'],
    ['Verify whether the mirror is up-to-date and install the package.', 'install the package'],
  ])('%s predicates a state, so the coordinated order keeps its authority', (text, _needle) => {
    // 合同调整 (0.6.3 收窄合同): the coordinated action stays one undecided
    // obligation and is no longer auto-authorized.
    expectNarrowedUndecided(text)
  })

  it.each([
    '核对镜像是否健康。',
    '确认缓存是否干净。',
    'Check whether the queue is empty.',
  ])('%s is a question about state and stays answerable', (text) => {
    const scopes = interpretMessage(text)
    expect(
      scopes.some((entry) => entry.authorityDisposition === 'informational'),
      JSON.stringify(scopes.map((entry) => [entry.authorityDisposition, entry.text])),
    ).toBe(true)
    expect(isQuestionScopeNeedingReview(text)).toBe(false)
  })

  it('a coordination of two state predications authorizes nothing', () => {
    // Oracle correction inside this set: `可用` and `为最新` are both state
    // predications, so this sentence questions two states and contains no order at
    // all. The first draft expected the second conjunct to be execution, which the
    // contract never supports — the same correction round 28 recorded for the
    // English two-state clause.
    const scopes = interpretMessage('核对镜像是否可用并为最新。')
    expect(scopes.every((entry) => entry.authorityDisposition !== 'executable_now'),
      JSON.stringify(scopes.map((entry) => [entry.authorityDisposition, entry.text]))).toBe(true)
  })

  it('a plain order keeps its authority', () => {
    const projection = derive('轮换日志并重启 api 服务。')
    expect([...projection.items.values()].some((item) => item.authorityDisposition === 'executable_now')).toBe(true)
  })

  it('preparation refuses the unproven complement and accepts the separate sentence', async () => {
    const question = derive('核对承包商是否运送完好的封装并重启 api 服务。')
    const questionItem = [...question.items.values()][0]!
    const refused = await createPrepareTool({ getProjection: () => question }).execute({
      item_id: questionItem.id, semantic_action: questionItem.semanticAction ?? 'restart',
      requested_target: questionItem.requestedTarget ?? {},
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(refused.compatibility.status).not.toBe('compatible')

    const order = derive('确认是否有可用的镜像。然后清理临时文件。')
    const cleanup = [...order.items.values()].find((item) => item.normalizedText.includes('清理临时文件'))
    expect(cleanup?.authorityDisposition).toBe('executable_now')
  })

  it('an unproven complement holds no authority even with a resolved target', () => {
    const projection = createProjection()
    projection.enabled = true
    const derived = derive('Confirm whether the technician ships the complete inventory and restart service api.')
    for (const item of derived.items.values()) projection.items.set(item.id, item)
    for (const decision of authorizations(projection)) expect(decision.endsWith(':authorized')).toBe(false)
  })
})

describe('hold-out 31 / K2: inheritance beside the predicate shapes', () => {
  it('an agreeing pair is inherited whole', () => {
    const projection = derive(['提交仓库 /repo-w 分支 main。', '提交仓库 /repo-w 分支 main。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.targetCaptureStatus).toBe('resolved')
    expect(last.requestedTarget).toEqual({ repository: '/repo-w', branch: 'main' })
  })

  it('a conflicting pair leaves only the branch open', () => {
    const projection = derive(['提交仓库 /repo-w 分支 main。', '提交仓库 /repo-w 分支 release。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.requestedTarget).toEqual({ repository: '/repo-w' })
    expect(last.targetCaptureReasonCode).toBe('requested_target_field_ambiguous')
  })

  it('a single target is unaffected', () => {
    const item = captureClause('提交仓库 /repo-w 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus).toBe('resolved')
  })
})
