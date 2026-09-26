import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { interpretMessage, isQuestionScopeNeedingReview } from '../../src/domain/semantics.js'
import { captureClause } from '../../src/domain/capture.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope } from '../../src/domain/types.js'
import { expectNarrowedUndecided } from './narrowed-contract.js'

/**
 * 0.6.3 hold-out round 27 — regression coverage (was the independent set).
 *
 * Round 26 found the declarative `that` complement still authorized, so it is
 * regression coverage. Round 27 covers that boundary and the contrasts around it in
 * wording this batch has never used:
 *
 * - `that` complements with different investigation heads and actors;
 * - a `that` complement with no coordination, which keeps the answerable lane;
 * - the `whether` state question that keeps its second order beside them;
 * - a relative clause after `that`, which must not be read as a complement;
 * - the separate instruction that stays authority;
 * - inheritance and eligibility beside those shapes.
 *
 * It found one more source defect of the same family: an investigation of a
 * declarative `that` clause with NO coordination was read as an instruction instead
 * of an answerable verification. That was repaired, so this set is REGRESSION
 * COVERAGE and round 28 is the current independent set.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-holdout27', createdAt: 1 } }

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

describe('hold-out 27 / K1: the declarative that complement', () => {
  it.each([
    'Check that the migration completed and restart the worker.',
    'Confirm that the operator rotated the credentials and redeployed the service.',
    'Determine that the scripts install foo and restart service api.',
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

  it('a that complement with no coordination keeps the answerable lane', () => {
    const scopes = interpretMessage('Check that the migration completed.')
    expect(scopes.some((entry) => entry.authorityDisposition === 'informational'), JSON.stringify(scopes.map((entry) => [entry.authorityDisposition, entry.text]))).toBe(true)
    expect(isQuestionScopeNeedingReview('Check that the migration completed.')).toBe(false)
  })

  it('a relative clause after that is not a complement', () => {
    const scopes = interpretMessage('Rotate the keys that the operator listed and redeploy the service.')
    expect(scopes.some((entry) => entry.authorityDisposition !== 'informational'), JSON.stringify(scopes.map((entry) => [entry.authorityDisposition, entry.text]))).toBe(true)
  })

  it('a whether state question keeps its second order', () => {
    // 合同调整 (0.6.3 收窄合同): the coordinated action stays one
    // undecided obligation and is no longer auto-authorized.
    expectNarrowedUndecided('Verify whether the lock file is current and install the package.')
  })

  it('a separate sentence after the that complement is authority', () => {
    const projection = derive('Check that the migration completed. Then restart the worker.')
    const order = [...projection.items.values()].find((item) => item.normalizedText.includes('restart the worker'))
    expect(order?.authorityDisposition, JSON.stringify([...projection.items.values()].map((i) => [i.normalizedText, i.authorityDisposition]))).toBe('executable_now')
  })
})

describe('hold-out 27 / K2: inheritance beside the that-complement shapes', () => {
  it('an agreeing pair is inherited whole', () => {
    const projection = derive(['提交仓库 /repo-s 分支 main。', '提交仓库 /repo-s 分支 main。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.targetCaptureStatus).toBe('resolved')
    expect(last.requestedTarget).toEqual({ repository: '/repo-s', branch: 'main' })
  })

  it('a conflicting pair leaves only the branch open', () => {
    const projection = derive(['提交仓库 /repo-s 分支 main。', '提交仓库 /repo-s 分支 dev。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.requestedTarget).toEqual({ repository: '/repo-s' })
    expect(last.targetCaptureReasonCode).toBe('requested_target_field_ambiguous')
  })

  it('a single target is unaffected', () => {
    const item = captureClause('提交仓库 /repo-s 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus).toBe('resolved')
  })

  it('a that-complement item holds no authority with a resolved target', () => {
    const projection = createProjection()
    projection.enabled = true
    const derived = derive('Check that the migration completed and restart the worker.')
    for (const item of derived.items.values()) projection.items.set(item.id, item)
    for (const decision of authorizations(projection)) expect(decision.endsWith(':authorized')).toBe(false)
  })
})
