import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { interpretMessage, isQuestionScopeNeedingReview } from '../../src/domain/semantics.js'
import { captureClause } from '../../src/domain/capture.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope } from '../../src/domain/types.js'

/**
 * 0.6.3 hold-out round 17 — regression coverage (was the independent set).
 *
 * Round 16 found three source defects in the question-scope family, so it is
 * regression coverage. Round 17 exercises the shapes that family has not yet
 * covered, in wording this batch has never used:
 *
 * - question words that double as relative pronouns, as QUESTION heads;
 * - verb-fronted interrogatives with a quantity or a count;
 * - relative and purpose clauses that must stay the action's object, not a
 *   question head;
 * - a mixed message whose question fragment carries no action of its own;
 * - a stray question mark with no interrogative, which stays an order;
 * - inheritance and eligibility beside those shapes.
 *
 * It found one more source defect of the same family: the action in front of the
 * interrogative may sit behind a modal or a state word ("需要安装多少依赖"), which
 * the head-only residue test missed, so the clause split into executable children.
 * It is therefore REGRESSION COVERAGE and round 18 is the current independent set;
 * one of its own expectations was also wrong and is recorded in place.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-holdout17', createdAt: 1 } }

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

describe('hold-out 17 / K1: relative-pronoun questions and verb-fronted interrogatives', () => {
  it.each([
    'Who restarts service api and installs foo?',
    'Which script installs foo and restarts service api?',
    '需要安装多少依赖并重启 api 服务？',
    '这些步骤安装哪些依赖并重启 api 服务？',
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
    ['Archive the logs that record which shard failed.', 'Archive the logs'],
    ['Compress the archives for whoever audits them.', 'Compress the archives'],
    ['Rotate the credentials to see who accessed them.', 'Rotate the credentials'],
  ])('%s keeps its order: the clause is the action\u2019s object', (text, needle) => {
    const scopes = interpretMessage(text)
    expect(scopes.some((entry) => entry.authorityDisposition !== 'informational' && entry.text.includes(needle)), JSON.stringify(scopes.map((entry) => [entry.authorityDisposition, entry.text]))).toBe(true)
  })

  it('a question fragment with no action of its own is a separate range', () => {
    const scopes = interpretMessage('Rotate the logs, and which shard failed?')
    expect(scopes.some((entry) => entry.authorityDisposition === 'informational' && entry.text.includes('which shard failed'))).toBe(true)
    expect(scopes.some((entry) => entry.authorityDisposition !== 'informational' && entry.text.includes('Rotate the logs'))).toBe(true)
  })

  it('a stray question mark with no interrogative stays an order', () => {
    const projection = derive('安装依赖？')
    const item = [...projection.items.values()][0]!
    expect(item.authorityDisposition).not.toBe('informational')
    expect(isQuestionScopeNeedingReview(item.normalizedText)).toBe(false)
  })

  it('an explicitly separate instruction after a question head is authority', () => {
    // Oracle correction: the question itself creates no obligation (it names no
    // coordinated action), so the instruction to assert on is the second sentence.
    const projection = derive('Who restarts service api? Then install the package.')
    const install = [...projection.items.values()].find((item) => item.semanticAction === 'install')
    expect(install?.authorityDisposition, JSON.stringify([...projection.items.values()].map((i) => [i.normalizedText, i.authorityDisposition]))).toBe('executable_now')
  })
})

describe('hold-out 17 / K2: inheritance beside the question shapes', () => {
  it('an agreeing pair is inherited whole', () => {
    const projection = derive(['提交仓库 /repo-i 分支 main。', '提交仓库 /repo-i 分支 main。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.targetCaptureStatus).toBe('resolved')
    expect(last.requestedTarget).toEqual({ repository: '/repo-i', branch: 'main' })
  })

  it('a conflicting pair leaves the branch open', () => {
    const projection = derive(['提交仓库 /repo-i 分支 main。', '提交仓库 /repo-i 分支 hotfix。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.requestedTarget).toEqual({ repository: '/repo-i' })
    expect(last.targetCaptureReasonCode).toBe('requested_target_field_ambiguous')
  })

  it('a single target is unaffected', () => {
    const item = captureClause('提交仓库 /repo-i 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus).toBe('resolved')
  })

  it('a question scope item holds no authority even with a resolved target', () => {
    const projection = createProjection()
    projection.enabled = true
    projection.hostStatus = 'supported'
    const derived = derive('Who restarts service api and installs foo?')
    for (const item of derived.items.values()) projection.items.set(item.id, item)
    for (const decision of authorizations(projection)) expect(decision.endsWith(':authorized')).toBe(false)
  })
})
