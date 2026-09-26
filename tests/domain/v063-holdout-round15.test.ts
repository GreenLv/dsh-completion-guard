import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { interpretMessage, isQuestionScopeNeedingReview } from '../../src/domain/semantics.js'
import { captureClause } from '../../src/domain/capture.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import type { DerivedEnvelope } from '../../src/domain/types.js'

/**
 * 0.6.3 hold-out round 15 — regression coverage (was the independent set).
 *
 * Round 14 found the Chinese temporal interrogatives missing from the question
 * vocabulary, so it is regression coverage. Round 15 exercises the CLOSED CLASS of
 * interrogative heads one by one, in sentences this batch has never used, together
 * with the contrast that each must keep:
 *
 * - every Chinese interrogative that can head a clause with a coordinated action;
 * - English question words and auxiliaries in the same shape;
 * - the same words as a CONDITION or as an OBJECT, which must keep their own
 *   reading instead of becoming a question scope;
 * - per-field inheritance and eligibility beside those shapes.
 *
 * It found two more members of the Chinese interrogative vocabulary missing
 * (谁 and 怎样), which let a question produce executable children, so it is
 * REGRESSION COVERAGE and round 16 is the current independent set; one of its own
 * expectations was also wrong and is recorded in place.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-holdout15', createdAt: 1 } }

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

describe('hold-out 15 / K1: the closed class of interrogative heads governs', () => {
  it.each([
    '怎样安装 foo 并重启 api 服务？',
    '多久需要安装一次 foo 并重启 api 服务？',
    '谁负责安装 foo 并重启 api 服务？',
    '哪些步骤可以安装 foo 并重启 api 服务？',
    '为什么应该安装 foo 并重启 api 服务？',
    'Where do we install foo and restart service api?',
    'Who installs foo and restarts service api?',
    'Which steps install foo and restart service api?',
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
    // The contrast: the same words as a CONDITION or as an OBJECT keep their own
    // reading instead of becoming a question scope.
    ['Install the package if the lock file is current.', 'conditional_wait'],
    ['Install the package when the tests pass.', 'conditional_wait'],
  ] as const)('%s keeps its conditional reading', (text, disposition) => {
    const projection = derive(text)
    const item = [...projection.items.values()][0]!
    expect(item.authorityDisposition, text).toBe(disposition)
    expect(isQuestionScopeNeedingReview(item.normalizedText), text).toBe(false)
  })

  it('a purpose clause is the action\u2019s object, not a question head', () => {
    const scopes = interpretMessage('Rotate the credentials to check which ones expired.')
    expect(scopes.some((entry) => entry.authorityDisposition !== 'informational'), JSON.stringify(scopes.map((entry) => [entry.authorityDisposition, entry.text]))).toBe(true)
  })

  it('a question head does not swallow an explicitly separate instruction', () => {
    const projection = derive('Which steps install foo? Then restart service api.')
    const restart = [...projection.items.values()].find((item) => item.semanticAction === 'restart')
    expect(restart?.authorityDisposition).toBe('executable_now')
  })

  it('an order-headed message keeps its orders beside a question', () => {
    // Oracle correction: the trailing coordinated clause is `unresolved` for its
    // own reason (an English clause opened by a conjunction), which is a visible
    // obligation without authority — not an executable one. The contract statement
    // is that nothing is dropped: exactly one information range, and at least two
    // further obligations that are not information.
    const scopes = interpretMessage('Update README.md, check whether the lock file is current, and repack the archives.')
    expect(scopes.filter((entry) => entry.authorityDisposition === 'informational')).toHaveLength(1)
    expect(scopes.filter((entry) => entry.authorityDisposition !== 'informational').length).toBeGreaterThanOrEqual(2)
  })
})

describe('hold-out 15 / K2: inheritance and the question scope side by side', () => {
  it('an agreeing pair is inherited whole', () => {
    const projection = derive([
      '提交仓库 /repo-g 分支 main。',
      '提交仓库 /repo-g 分支 main。',
      '提交。',
    ])
    const last = [...projection.items.values()].at(-1)!
    expect(last.targetCaptureStatus).toBe('resolved')
    expect(last.requestedTarget).toEqual({ repository: '/repo-g', branch: 'main' })
  })

  it('a conflicting pair leaves only the branch open', () => {
    const projection = derive([
      '提交仓库 /repo-g 分支 main。',
      '提交仓库 /repo-g 分支 release。',
      '提交。',
    ])
    const last = [...projection.items.values()].at(-1)!
    expect(last.requestedTarget).toEqual({ repository: '/repo-g' })
    expect(last.targetCaptureReasonCode).toBe('requested_target_field_ambiguous')
  })

  it('a single repository target is unaffected', () => {
    const item = captureClause('提交仓库 /repo-g 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus).toBe('resolved')
  })
})
