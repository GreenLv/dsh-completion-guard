import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { interpretMessage, isQuestionScopeNeedingReview } from '../../src/domain/semantics.js'
import { captureClause } from '../../src/domain/capture.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope } from '../../src/domain/types.js'

/**
 * 0.6.3 hold-out round 24 — regression coverage (was the independent set).
 *
 * Round 23 found the Chinese A-不-A interrogatives being read as prohibitions, so it
 * is regression coverage. Round 24 covers the rest of that reduplication class and
 * the English forms of the same question, in wording this batch has never used,
 * with the prohibitions that must survive beside them:
 *
 * - further A-不-A interrogatives at the head of a coordinated action list;
 * - English necessity and permission questions of the same shape;
 * - the prohibitions and negated orders that must keep their reading;
 * - a plain order of the same words;
 * - inheritance and eligibility beside those shapes.
 *
 * It found three more source defects of the same family: the A-不-A class was not
 * recognised structurally (需不需要/可不可以/对不对), a question about a single action
 * was still executable, and the postposed-interrogative rule accepted an ordinary
 * OBJECT list ("检查一下本地插件和皮肤是否有更新", where 和 joins two nouns) as a
 * coordination of actions. All were repaired, so this set is REGRESSION COVERAGE and
 * round 25 is the current independent set; one of its own expectations was corrected
 * in place.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-holdout24', createdAt: 1 } }

let seq = 0
function derive(texts: string | string[]) {
  if (typeof texts === 'string') texts = [texts]
  seq = 0
  const events: DerivedEnvelope[] = [{
    seq: seq++, type: 'user/message', data: {
      source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice' },
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

describe('hold-out 24 / K1: the A-不-A class and the English necessity questions', () => {
  it.each([
    '需不需要安装 foo 并重启 api 服务？',
    '可不可以安装 foo 并重启 api 服务？',
    '对不对，安装 foo 并重启 api 服务？',
    'Is it necessary to install foo and restart service api?',
    'Do we need to install foo and restart service api?',
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
    ['不要安装 foo 并重启 api 服务。', 'prohibition'],
    ['不应该安装 foo 并重启 api 服务。', 'prohibition'],
  ] as const)('%s keeps its prohibition', (text, directive) => {
    const scopes = interpretMessage(text)
    expect(scopes.some((entry) => entry.directive === directive), JSON.stringify(scopes.map((entry) => [entry.directive, entry.authorityDisposition, entry.text]))).toBe(true)
    expect(scopes.every((entry) => entry.authorityDisposition !== 'executable_now'), JSON.stringify(scopes.map((entry) => [entry.directive, entry.text]))).toBe(true)
  })

  it('the plain order of the same words stays an order', () => {
    const projection = derive('安装 foo 并重启 api 服务。')
    const items = [...projection.items.values()]
    expect(items.some((item) => item.authorityDisposition === 'executable_now'), JSON.stringify(items.map((i) => [i.normalizedText, i.authorityDisposition]))).toBe(true)
    expect(items.some((item) => isQuestionScopeNeedingReview(item.normalizedText))).toBe(false)
  })

  it('a question about one action keeps the closable lane and grants no authority', () => {
    // Oracle correction: a QUESTION that mentions one action is an answerable
    // information request, not an instruction — the earlier expectation only
    // required "not executable", but the contract is the closable lane.
    const scopes = interpretMessage('这份文档可不可以更新？')
    expect(scopes.some((entry) => entry.authorityDisposition === 'informational'), JSON.stringify(scopes.map((entry) => [entry.authorityDisposition, entry.text]))).toBe(true)
    const projection = derive('这份文档可不可以更新？')
    for (const item of projection.items.values()) {
      expect(authorizeMutationFromProjection(projection, {
        action: item.semanticAction ?? 'generic_run', contractItemId: item.id,
        contractItemRevision: item.revision, resolvedTarget: item.requestedTarget ?? {},
      } as never).status).not.toBe('authorized')
    }
  })
})

describe('hold-out 24 / K2: inheritance beside the reduplication shapes', () => {
  it('an agreeing pair is inherited whole', () => {
    const projection = derive(['提交仓库 /repo-p 分支 main。', '提交仓库 /repo-p 分支 main。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.targetCaptureStatus).toBe('resolved')
    expect(last.requestedTarget).toEqual({ repository: '/repo-p', branch: 'main' })
  })

  it('a conflicting pair leaves only the branch open', () => {
    const projection = derive(['提交仓库 /repo-p 分支 main。', '提交仓库 /repo-p 分支 release。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.requestedTarget).toEqual({ repository: '/repo-p' })
    expect(last.targetCaptureReasonCode).toBe('requested_target_field_ambiguous')
  })

  it('a single target is unaffected', () => {
    const item = captureClause('提交仓库 /repo-p 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus).toBe('resolved')
  })

  it('a question scope item holds no authority with a resolved target', () => {
    const projection = createProjection()
    projection.enabled = true
    const derived = derive('需不需要安装 foo 并重启 api 服务？')
    for (const item of derived.items.values()) projection.items.set(item.id, item)
    for (const decision of authorizations(projection)) expect(decision.endsWith(':authorized')).toBe(false)
  })
})
