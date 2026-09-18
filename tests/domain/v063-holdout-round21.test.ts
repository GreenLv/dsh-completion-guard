import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { interpretMessage, isQuestionScopeNeedingReview } from '../../src/domain/semantics.js'
import { captureClause } from '../../src/domain/capture.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope } from '../../src/domain/types.js'

/**
 * 0.6.3 hold-out round 21 — regression coverage (was the independent set).
 *
 * Round 20 found that the `if`-complement was still cut by the condition splitter
 * when a second instruction was coordinated, so it is regression coverage. Round 21
 * covers the remaining positions of that boundary, in wording this batch has never
 * used:
 *
 * - a request preface in front of the investigation, and the Chinese postposed
 *   `是否…安全` form;
 * - a temporal or purpose span inside the complement, where the actions belong to
 *   what is being checked;
 * - the contrast set: a fact-stating `if` complement, a real condition, and a
 *   noun-phrase complement;
 * - the gate and preparation on both sides;
 * - inheritance and eligibility beside those shapes.
 *
 * It found two more source defects of the same family: the Chinese
 * modal-bearing subordinators (能否/可否/能不能) were missing from the complement
 * vocabulary, and a POSTPOSED interrogative ("检查一下安装 foo 并重启 api 服务是否
 * 安全") puts the marker after the actions, so the complement test had to read it
 * in both positions and the residue test had to see the action behind the marker.
 * Both were repaired, so this set is REGRESSION COVERAGE and round 22 is the
 * current independent set.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-holdout21', createdAt: 1 } }

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

describe('hold-out 21 / K1: further positions of the investigation boundary', () => {
  it.each([
    'Please check if we can install foo and restart service api safely.',
    '检查一下安装 foo 并重启 api 服务是否安全。',
    '确认一下我们能否安装 foo 并重启 api 服务。',
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
    ['Check if the lock file is current and install the package.', 'install'],
    ['Check the safety of installing foo and restart service api.', 'installing'],
  ])('%s keeps an order or a task of its own', (text, needle) => {
    const scopes = interpretMessage(text)
    expect(scopes.some((entry) => entry.authorityDisposition !== 'informational' && entry.text.includes(needle)), JSON.stringify(scopes.map((entry) => [entry.authorityDisposition, entry.text]))).toBe(true)
  })

  it.each([
    ['Install the package if the lock file is current.', 'conditional_wait'],
    ['Restart service api if the deployment succeeded.', 'conditional_wait'],
  ] as const)('%s keeps its conditional reading', (text, disposition) => {
    const projection = derive(text)
    const item = [...projection.items.values()][0]!
    expect(item.authorityDisposition, text).toBe(disposition)
  })

  it('preparation refuses the investigation and accepts its own sentence', async () => {
    const question = derive('请检查是否可以安装 foo 并重启 api 服务。')
    const questionItem = [...question.items.values()][0]!
    const refused = await createPrepareTool({ getProjection: () => question }).execute({
      item_id: questionItem.id, semantic_action: questionItem.semanticAction ?? 'install',
      requested_target: questionItem.requestedTarget ?? {},
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(refused.compatibility.status).not.toBe('compatible')

    const order = derive('Check if the lock file is current. Then install the package.')
    const install = [...order.items.values()].find((item) => item.semanticAction === 'install')
    expect(install?.authorityDisposition).toBe('executable_now')
  })
})

describe('hold-out 21 / K2: inheritance beside the boundary shapes', () => {
  it('an agreeing pair is inherited whole', () => {
    const projection = derive(['推送仓库 /repo-m remote origin refspec refs/heads/main。', '推送仓库 /repo-m remote origin refspec refs/heads/main。', '推送。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.targetCaptureStatus).toBe('resolved')
    expect(last.requestedTarget).toEqual({ repository: '/repo-m', remote: 'origin', refspec: 'refs/heads/main' })
  })

  it('a conflicting remote leaves only that field open', () => {
    const projection = derive([
      '推送仓库 /repo-m remote origin refspec refs/heads/main。',
      '推送仓库 /repo-m remote backup refspec refs/heads/main。',
      '推送。',
    ])
    const last = [...projection.items.values()].at(-1)!
    expect(last.requestedTarget).toMatchObject({ repository: '/repo-m', refspec: 'refs/heads/main' })
    expect(last.requestedTarget?.remote).toBeUndefined()
    expect(last.targetCaptureReasonCode).toBe('requested_target_field_ambiguous')
  })

  it('a single target is unaffected', () => {
    const item = captureClause('推送仓库 /repo-m remote origin refspec refs/heads/main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus).toBe('resolved')
  })

  it('a question-scope item holds no authority with a resolved target', () => {
    const projection = createProjection()
    projection.enabled = true
    const derived = derive('Please check if we can install foo and restart service api safely.')
    for (const item of derived.items.values()) projection.items.set(item.id, item)
    for (const decision of authorizations(projection)) expect(decision.endsWith(':authorized')).toBe(false)
  })
})
