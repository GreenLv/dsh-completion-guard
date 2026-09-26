import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { interpretMessage, isQuestionScopeNeedingReview } from '../../src/domain/semantics.js'
import { captureClause } from '../../src/domain/capture.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope } from '../../src/domain/types.js'
/**
 * 0.6.3 hold-out round 25 — regression coverage (was the independent set).
 *
 * Round 24 found the A-不-A class, the single-action question and the
 * postposed-interrogative rule still open, so it is regression coverage. Round 25
 * covers the shapes that repair has not been exercised on, in wording this batch
 * has never used:
 *
 * - an OBJECT list coordinated by 和/与 in a question, which must keep the
 *   answerable lane, beside the same words with an ACTION coordinated by 并;
 * - an investigation whose object list is joined by 和 and then asks at the end;
 * - a question about a single action in English and Chinese;
 * - the plain orders that must keep their authority;
 * - inheritance and eligibility beside those shapes.
 *
 * It found nothing of its own, but the TWELFTH review then showed a DECLARATIVE
 * investigation complement carries its own actor and predicates, and that repair
 * changed the source, so it is REGRESSION COVERAGE and round 26 is the current
 * independent set.
 */
const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-holdout25', createdAt: 1 } }
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
describe('hold-out 25 / K1: object lists versus action lists', () => {
  it.each([
    '确认本地插件和皮肤是否需要更新。',
    '检查一下日志和配置是否有变化。',
  ])('%s keeps the answerable lane: the coordinator joins OBJECTS', (text) => {
    // 合同调整 clarification: this block is NOT superseded — the coordinator joins
    // OBJECTS, so the clause stays the answerable lane under the narrowed contract
    // too. The question is what it always was; only the coordinated ACTION reading
    // was narrowed.
    const scopes = interpretMessage(text)
    expect(scopes.some((entry) => entry.authorityDisposition === 'informational'), JSON.stringify(scopes.map((entry) => [entry.authorityDisposition, entry.text]))).toBe(true)
    expect(isQuestionScopeNeedingReview(text)).toBe(false)
  })
  it.each([
    '检查一下安装 foo 并重启 api 服务是否安全。',
    '确认安装 foo 并重启 api 服务是否需要授权。',
  ])('%s is undecided: the coordinator joins ACTIONS', (text) => {
    const projection = derive(text)
    const items = [...projection.items.values()]
    expect(items.length, text).toBe(1)
    expect(items[0]!.authorityDisposition, text).toBe('unresolved')
    for (const decision of authorizations(projection)) {
      expect(decision.endsWith(':authorized'), `${text} / ${decision}`).toBe(false)
    }
  })
  it.each([
    '这份文档是不是需要更新？',
    'Is the lock file current and safe?',
  ])('%s asks about a single thing and grants no authority', (text) => {
    const projection = derive(text)
    for (const decision of authorizations(projection)) expect(decision.endsWith(':authorized'), `${text} / ${decision}`).toBe(false)
    for (const item of projection.items.values()) expect(item.authorityDisposition, text).not.toBe('executable_now')
  })
  it.each([
    '确认本地插件和皮肤是否需要更新，然后安装 foo。',
  ])('%s keeps the order beside the question', (text) => {
    const scopes = interpretMessage(text)
    expect(scopes.some((entry) => entry.authorityDisposition !== 'informational' && entry.text.includes('安装 foo')), JSON.stringify(scopes.map((entry) => [entry.authorityDisposition, entry.text]))).toBe(true)
  })
  it('a plain order keeps its authority', () => {
    const projection = derive('安装 foo 并重启 api 服务。')
    const items = [...projection.items.values()]
    expect(items.some((item) => item.authorityDisposition === 'executable_now'), JSON.stringify(items.map((i) => [i.normalizedText, i.authorityDisposition]))).toBe(true)
  })
})
describe('hold-out 25 / K2: inheritance beside the object-list shapes', () => {
  it('an agreeing pair is inherited whole', () => {
    const projection = derive(['提交仓库 /repo-q 分支 main。', '提交仓库 /repo-q 分支 main。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.targetCaptureStatus).toBe('resolved')
    expect(last.requestedTarget).toEqual({ repository: '/repo-q', branch: 'main' })
  })
  it('a conflicting pair leaves only the branch open', () => {
    const projection = derive(['提交仓库 /repo-q 分支 main。', '提交仓库 /repo-q 分支 release。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.requestedTarget).toEqual({ repository: '/repo-q' })
    expect(last.targetCaptureReasonCode).toBe('requested_target_field_ambiguous')
  })
  it('a single target is unaffected', () => {
    const item = captureClause('提交仓库 /repo-q 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus).toBe('resolved')
  })
  it('an object-list question creates no authority', () => {
    const projection = createProjection()
    projection.enabled = true
    const derived = derive('确认本地插件和皮肤是否需要更新。')
    for (const item of derived.items.values()) projection.items.set(item.id, item)
    for (const decision of authorizations(projection)) expect(decision.endsWith(':authorized')).toBe(false)
  })
})