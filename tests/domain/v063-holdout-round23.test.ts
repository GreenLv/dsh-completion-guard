import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { interpretMessage, isQuestionScopeNeedingReview } from '../../src/domain/semantics.js'
import { captureClause } from '../../src/domain/capture.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope } from '../../src/domain/types.js'

/**
 * 0.6.3 hold-out round 23 — regression coverage (was the independent set).
 *
 * Round 22 found the yes/no interrogatives missing from the question vocabulary,
 * so it is regression coverage. Round 23 exercises the remaining members of that
 * closed class at the head of a clause, in wording this batch has never used,
 * together with the orders that must keep their authority:
 *
 * - every Chinese yes/no and modal interrogative at the head of a coordinated
 *   action list;
 * - English modal and impersonal questions of the same shape;
 * - the plain order of the same words, and the stray-question-mark order;
 * - a question naming no action, which keeps the closable lane;
 * - inheritance beside those shapes.
 *
 * It found one more source defect of the same family: the Chinese A-不-A
 * interrogatives (要不要/该不该) were read by the NEGATION path as prohibitions
 * ("不要安装…" plus a stray "要"), because the 不 of the reduplication looked like a
 * negator. The A-不-A test now runs on the 不 inside whichever negator matched, so
 * the question survives and a real prohibition ("不要安装…") does not. Round 24 is
 * the current independent set.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-holdout23', createdAt: 1 } }

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

describe('hold-out 23 / K1: the yes/no and modal interrogatives at the head', () => {
  it.each([
    '是不是应该安装 foo 并重启 api 服务？',
    '能否安装 foo 并重启 api 服务？',
    '要不要安装 foo 并重启 api 服务？',
    '该不该安装 foo 并重启 api 服务？',
    'Should we install foo and restart service api?',
    'Would it be wise to install foo and restart service api?',
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
    '安装 foo 并重启 api 服务。',
    'Install foo and restart service api.',
  ])('%s is an order and keeps its reading', (text) => {
    const projection = derive(text)
    const items = [...projection.items.values()]
    expect(items.some((item) => item.authorityDisposition === 'executable_now'), JSON.stringify(items.map((i) => [i.normalizedText, i.authorityDisposition]))).toBe(true)
    expect(items.some((item) => isQuestionScopeNeedingReview(item.normalizedText))).toBe(false)
  })

  it('a stray question mark with no interrogative stays an order', () => {
    const projection = derive('安装依赖？')
    const item = [...projection.items.values()][0]!
    expect(item.authorityDisposition).not.toBe('informational')
    expect(isQuestionScopeNeedingReview(item.normalizedText)).toBe(false)
  })

  it('a question naming no action keeps the closable lane', () => {
    const scopes = interpretMessage('这个文档是不是已经过期？')
    expect(scopes.some((entry) => entry.authorityDisposition === 'informational'), JSON.stringify(scopes.map((entry) => [entry.authorityDisposition, entry.text]))).toBe(true)
  })

  it('an explicitly separate instruction after the question is authority', () => {
    const projection = derive('能不能安装 foo？Then restart service api.')
    const restart = [...projection.items.values()].find((item) => item.semanticAction === 'restart')
    expect(restart?.authorityDisposition).toBe('executable_now')
  })
})

describe('hold-out 23 / K2: inheritance beside the question shapes', () => {
  it('an agreeing pair is inherited whole', () => {
    const projection = derive(['提交仓库 /repo-o 分支 main。', '提交仓库 /repo-o 分支 main。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.targetCaptureStatus).toBe('resolved')
    expect(last.requestedTarget).toEqual({ repository: '/repo-o', branch: 'main' })
  })

  it('a conflicting pair leaves only the branch open', () => {
    const projection = derive(['提交仓库 /repo-o 分支 main。', '提交仓库 /repo-o 分支 dev。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.requestedTarget).toEqual({ repository: '/repo-o' })
    expect(last.targetCaptureReasonCode).toBe('requested_target_field_ambiguous')
  })

  it('a single target is unaffected', () => {
    const item = captureClause('提交仓库 /repo-o 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus).toBe('resolved')
  })

  it('a question scope item holds no authority with a resolved target', () => {
    const projection = createProjection()
    projection.enabled = true
    const derived = derive('是不是应该安装 foo 并重启 api 服务？')
    for (const item of derived.items.values()) projection.items.set(item.id, item)
    for (const decision of authorizations(projection)) expect(decision.endsWith(':authorized')).toBe(false)
  })
})
