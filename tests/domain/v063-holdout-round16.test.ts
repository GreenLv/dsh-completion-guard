import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { interpretMessage, isQuestionScopeNeedingReview } from '../../src/domain/semantics.js'
import { captureClause } from '../../src/domain/capture.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import type { DerivedEnvelope } from '../../src/domain/types.js'

/**
 * 0.6.3 hold-out round 16 — regression coverage (was the independent set).
 *
 * Round 15 found two more interrogatives missing from the question vocabulary, so
 * it is regression coverage. Round 16 covers the remaining members of the closed
 * class and, above all, the CONTRASTS that keep the rule honest: the same words
 * inside a purpose or relative span, as an object, or with a quantity — none of
 * which may turn a real order into an undecided question scope.
 *
 * It found THREE source defects of the same family — a verb-fronted interrogative
 * (`安装多少依赖并重启 …？`), a question word that is also listed as a relative
 * pronoun (`Who owns … ?`, which `englishInterrogativeIsMatrix` treated as a
 * subordinate boundary and therefore read as an instruction), and the fragment
 * test that had to see the action behind the interrogative — so it is REGRESSION
 * COVERAGE and round 17 is the current independent set. Two of its own
 * expectations were also wrong and are recorded in place.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-holdout16', createdAt: 1 } }

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

describe('hold-out 16 / K1: the rest of the closed class governs', () => {
  it.each([
    '哪个步骤安装 foo 并重启 api 服务？',
    '安装多少依赖并重启 api 服务？',
    '什么时候安装 foo 并重启 api 服务？',
    'Whose credentials install foo and restart service api?',
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
    // The contrast: the same words inside a purpose or relative span belong to the
    // action, so the clause keeps its order and its authority.
    ['Archive the logs to record who changed what.', 'Archive the logs'],
    ['Rotate the credentials that the survey flagged.', 'Rotate the credentials'],
    ['Compress the archives for whoever audits them.', 'Compress the archives'],
  ])('%s keeps its order', (text, needle) => {
    const scopes = interpretMessage(text)
    expect(scopes.some((entry) => entry.authorityDisposition !== 'informational' && entry.text.includes(needle)), JSON.stringify(scopes.map((entry) => [entry.authorityDisposition, entry.text]))).toBe(true)
  })

  it('a quantity in an order does not make it a question', () => {
    const projection = derive('Install 3 packages and restart service api.')
    const items = [...projection.items.values()]
    expect(items.some((item) => item.authorityDisposition === 'executable_now'), JSON.stringify(items.map((i) => [i.normalizedText, i.authorityDisposition]))).toBe(true)
    expect(items.some((item) => isQuestionScopeNeedingReview(item.normalizedText))).toBe(false)
  })

  it('a question head still governs when the message continues with an order', () => {
    // Oracle correction: the question names no action of its own, so it keeps the
    // closable lane; the second sentence is the instruction.
    const scopes = interpretMessage('Who installs foo? Update README.md.')
    expect(scopes.some((entry) => entry.authorityDisposition === 'informational' && entry.text.includes('Who installs foo'))).toBe(true)
    expect(scopes.some((entry) => entry.authorityDisposition === 'executable_now' && entry.text.includes('Update README.md'))).toBe(true)
  })

  it('a purely informational question keeps its closable lane', () => {
    // Oracle correction: a question that names no action creates no contract item
    // at all, so the reading is asserted at the scope level.
    const scopes = interpretMessage('Who owns the release process?')
    expect(scopes).toHaveLength(1)
    expect(scopes[0]!.authorityDisposition).toBe('informational')
    expect(isQuestionScopeNeedingReview(scopes[0]!.text)).toBe(false)
  })
})

describe('hold-out 16 / K2: inheritance beside a question scope', () => {
  it('an agreeing pair is inherited whole', () => {
    const projection = derive(['提交仓库 /repo-h 分支 main。', '提交仓库 /repo-h 分支 main。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.targetCaptureStatus).toBe('resolved')
    expect(last.requestedTarget).toEqual({ repository: '/repo-h', branch: 'main' })
  })

  it('a conflicting pair leaves the branch open', () => {
    const projection = derive(['提交仓库 /repo-h 分支 main。', '提交仓库 /repo-h 分支 dev。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.requestedTarget).toEqual({ repository: '/repo-h' })
    expect(last.targetCaptureReasonCode).toBe('requested_target_field_ambiguous')
  })

  it('a single target is unaffected', () => {
    const item = captureClause('提交仓库 /repo-h 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus).toBe('resolved')
  })
})
