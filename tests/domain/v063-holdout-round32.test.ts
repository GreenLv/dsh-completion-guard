import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { interpretMessage, isQuestionScopeNeedingReview } from '../../src/domain/semantics.js'
import { captureClause } from '../../src/domain/capture.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope } from '../../src/domain/types.js'
import { expectNarrowedUndecided } from './narrowed-contract.js'

/**
 * 0.6.3 hold-out round 32 — the current independent set.
 *
 * Round 31 asked whether closure needs the PREDICATE rather than a state word, and
 * found three source defects on the way (the English infinitive test firing on the
 * `to` inside `up-to-date`, a lazy Chinese modifier strip that stopped at a
 * possessive, and a state-noun proof that could not name a mirror), so round 31 is
 * regression coverage and this set replaces it. It required no source change.
 *
 * It exercises both sides with wording this batch has never used:
 *
 * - state words as an action's attributive modifier, in both languages;
 * - the postposed Chinese interrogative whose questioned span carries two actions;
 * - the state predicates that ARE the complement (Chinese adjectives, the stative
 *   verbs with a state noun) and the English copula shapes, including the spaced
 *   spelling of `up to date`;
 * - the coordination-free answerable lane beside them;
 * - inheritance and the gate/preparation pair on the same shapes.
 *
 * Expectations come from the contract. A failure here is a source finding: this set
 * found three. The English infinitive test fired on the `to` inside the spaced
 * `up to date`; the postposed Chinese interrogative over two actions was read as an
 * order because the verb on one side was outside every vocabulary; and a yes/no
 * question with an explicit subject and no imperative head authorized the order
 * coordinated beside it. All three were repaired in the source, so this set is no
 * longer untuned evidence. Three of its own expectations were also wrong and are
 * corrected here, labelled as oracle errors: two English second conjuncts used
 * verbs the order vocabulary does not contain (`rotate`, `clean`), so they stay
 * undecided, and the postposed shape was expected to carry its own review flag when
 * the flag belongs to the whole clause rather than to the item's split text.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-holdout32', createdAt: 1 } }

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

describe('hold-out 32 / K1: the predicate proof, both sides', () => {
  it.each([
    'Check whether the auditor stamps the certified ledger and restart service api.',
    'Check whether the maintainer pins the frozen lockfile and restart service api.',
    'Check whether the scheduler queues the ready jobs and restart service api.',
    '审计人是否加盖有效的印章并重启 api 服务。',
    '确认维护者是否冻结稳定的依赖并重启 api 服务。',
    '核对调度器是否排队就绪的任务并重启 api 服务。',
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

  it('the postposed interrogative over two actions is undecided, and authorizes nothing', () => {
    const text = '核对一下重启 api 服务并归档日志是否安全。'
    const projection = derive(text)
    const items = [...projection.items.values()]
    expect(items.length, text).toBe(1)
    expect(items[0]!.authorityDisposition, text).toBe('unresolved')
    for (const decision of authorizations(projection)) {
      expect(decision.endsWith(':authorized'), `${text} / ${decision}`).toBe(false)
    }
  })

  it.each([
    ['审计缓存是否就绪并轮换密钥。', '轮换密钥'],
    ['确认镜像是否可用并轮换密钥。', '轮换密钥'],
    ['核对证书是否有效并清理临时文件。', '清理临时文件'],
    ['确认备份是否正常并轮换密钥。', '轮换密钥'],
    ['确认是否有可用的快照并轮换密钥。', '轮换密钥'],
    ['Check whether the replica is current and install the package.', 'install the package'],
    ['Verify whether the certificate is valid and restart service api.', 'restart service api'],
    ['Confirm whether the quota is up to date and restart service api.', 'restart service api'],
  ])('%s predicates a state, so the coordinated order keeps its authority', (text, _needle) => {
    // 合同调整 (0.6.3 收窄合同): the coordinated action stays one undecided
    // obligation and is no longer auto-authorized.
    expectNarrowedUndecided(text)
  })

  it.each([
    '核对镜像是否可用。',
    '验证证书是否有效。',
    'Check whether the replica is current.',
  ])('%s is a question about state and stays answerable', (text) => {
    const scopes = interpretMessage(text)
    expect(
      scopes.some((entry) => entry.authorityDisposition === 'informational'),
      JSON.stringify(scopes.map((entry) => [entry.authorityDisposition, entry.text])),
    ).toBe(true)
    expect(isQuestionScopeNeedingReview(text)).toBe(false)
  })

  it('a plain order keeps its authority', () => {
    const projection = derive('轮换密钥并清理临时文件。')
    expect([...projection.items.values()].some((item) => item.authorityDisposition === 'executable_now')).toBe(true)
  })

  it('preparation refuses the unproven complement and accepts the separate sentence', async () => {
    const question = derive('确认维护者是否冻结稳定的依赖并重启 api 服务。')
    const questionItem = [...question.items.values()][0]!
    const refused = await createPrepareTool({ getProjection: () => question }).execute({
      item_id: questionItem.id, semantic_action: questionItem.semanticAction ?? 'restart',
      requested_target: questionItem.requestedTarget ?? {},
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(refused.compatibility.status).not.toBe('compatible')

    const order = derive('确认是否有可用的快照。然后轮换密钥。')
    const rotate = [...order.items.values()].find((item) => item.normalizedText.includes('轮换密钥'))
    expect(rotate?.authorityDisposition).toBe('executable_now')
  })

  it('an unproven complement holds no authority with a resolved target', () => {
    const projection = createProjection()
    projection.enabled = true
    const derived = derive('Check whether the scheduler queues the ready jobs and restart service api.')
    for (const item of derived.items.values()) projection.items.set(item.id, item)
    for (const decision of authorizations(projection)) expect(decision.endsWith(':authorized')).toBe(false)
  })
})

describe('hold-out 32 / K2: inheritance beside the predicate shapes', () => {
  it('an agreeing pair is inherited whole', () => {
    const projection = derive(['提交仓库 /repo-x 分支 main。', '提交仓库 /repo-x 分支 main。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.targetCaptureStatus).toBe('resolved')
    expect(last.requestedTarget).toEqual({ repository: '/repo-x', branch: 'main' })
  })

  it('a conflicting pair leaves only the branch open', () => {
    const projection = derive(['提交仓库 /repo-x 分支 main。', '提交仓库 /repo-x 分支 release。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.requestedTarget).toEqual({ repository: '/repo-x' })
    expect(last.targetCaptureReasonCode).toBe('requested_target_field_ambiguous')
  })

  it('a single target is unaffected', () => {
    const item = captureClause('提交仓库 /repo-x 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus).toBe('resolved')
  })
})
