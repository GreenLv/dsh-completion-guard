import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { isQuestionScopeNeedingReview } from '../../src/domain/semantics.js'
import { captureClause } from '../../src/domain/capture.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import type { DerivedEnvelope } from '../../src/domain/types.js'
import { expectNarrowedUndecided } from './narrowed-contract.js'
/**
 * 0.6.3 hold-out round 20 — regression coverage (was the independent set).
 *
 * Round 19 found that an investigation complement opening with `if` was still cut
 * by the condition splitter, so it is regression coverage. Round 20 exercises the
 * remaining combinations of that boundary in wording this batch has never used:
 *
 * - `if`-complements with the modal before and after the verb, in both languages;
 * - a genuine CONDITION that must stay conditional beside them;
 * - an investigation complement behind a request preface;
 * - the gate and preparation on both sides;
 * - inheritance and eligibility beside those shapes.
 *
 * It found two more source defects of the same family: an `if`-complement was
 * still taken by the condition splitter when a second instruction was coordinated
 * (the head test and the clause test had been conflated), and the investigation's
 * informational reading then swallowed that second order. Both were repaired, so
 * this set is REGRESSION COVERAGE and round 21 is the current independent set.
 */
const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-holdout20', createdAt: 1 } }
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
describe('hold-out 20 / K1: the if-complement boundary', () => {
  it.each([
    'Determine if we can install foo and restart service api safely.',
    'Check if we are allowed to install foo and restart service api.',
    '请检查是否可以安装 foo 并重启 api 服务。',
    '麻烦确认是否需要安装 foo 并重启 api 服务。',
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
    ['Install the package if the lock file is current.', 'conditional_wait'],
    ['Restart service api if the deployment succeeded.', 'conditional_wait'],
    ['Deploy the release when the tests pass.', 'conditional_wait'],
  ] as const)('%s keeps its conditional reading', (text, disposition) => {
    const projection = derive(text)
    const item = [...projection.items.values()][0]!
    expect(item.authorityDisposition, text).toBe(disposition)
    expect(isQuestionScopeNeedingReview(item.normalizedText), text).toBe(false)
  })
  it('the boundary holds in preparation and in the gate', async () => {
    const refused = derive('Determine if we can install foo and restart service api safely.')
    const refusedItem = [...refused.items.values()][0]!
    const refusedResult = await createPrepareTool({ getProjection: () => refused }).execute({
      item_id: refusedItem.id, semantic_action: refusedItem.semanticAction ?? 'install',
      requested_target: refusedItem.requestedTarget ?? {},
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(refusedResult.compatibility.status).not.toBe('compatible')
    for (const decision of authorizations(refused)) expect(decision.endsWith(':authorized')).toBe(false)
    const conditional = derive('Install the package if the lock file is current.')
    const conditionalItem = [...conditional.items.values()][0]!
    expect(authorizeMutationFromProjection(conditional, {
      action: 'install', contractItemId: conditionalItem.id, contractItemRevision: conditionalItem.revision,
      resolvedTarget: conditionalItem.requestedTarget ?? {},
    } as never).status).toBe('denied')
  })
  it('a fact-stating complement keeps its second order', () => {
    // 合同调整 (0.6.3 收窄合同): the coordinated action stays one
    // undecided obligation and is no longer auto-authorized.
    expectNarrowedUndecided('Check if the lock file is current and install the package.')
  })
})
describe('hold-out 20 / K2: inheritance beside the if-complement shapes', () => {
  it('an agreeing pair is inherited whole', () => {
    const projection = derive(['提交仓库 /repo-l 分支 main。', '提交仓库 /repo-l 分支 main。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.targetCaptureStatus).toBe('resolved')
    expect(last.requestedTarget).toEqual({ repository: '/repo-l', branch: 'main' })
  })
  it('a conflicting pair leaves only the branch open', () => {
    const projection = derive(['提交仓库 /repo-l 分支 main。', '提交仓库 /repo-l 分支 next。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.requestedTarget).toEqual({ repository: '/repo-l' })
    expect(last.targetCaptureReasonCode).toBe('requested_target_field_ambiguous')
  })
  it('a single target is unaffected', () => {
    const item = captureClause('提交仓库 /repo-l 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus).toBe('resolved')
  })
})