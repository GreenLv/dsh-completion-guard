import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { interpretMessage, isQuestionScopeNeedingReview } from '../../src/domain/semantics.js'
import { captureClause } from '../../src/domain/capture.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope } from '../../src/domain/types.js'

/**
 * 0.6.3 hold-out round 22 — regression coverage (was the independent set).
 *
 * Round 21 found two more source defects of the question/complement family, so it
 * is regression coverage. Round 22 covers the remaining POSITIONS of the
 * interrogative, in wording this batch has never used:
 *
 * - an auxiliary-led English question whose object is an infinitive list;
 * - a Chinese question with the marker at the very end and an action before it;
 * - a Chinese question with the marker at the end and NO action before it, which
 *   must keep the closable lane;
 * - a purpose span that contains the interrogative, which must keep its order;
 * - the gate and preparation on both sides;
 * - inheritance and eligibility beside those shapes.
 *
 * It found one more source defect of the same family: the yes/no interrogatives
 * (是否/是不是) were missing from the question vocabulary, so a verb-fronted question
 * ending on 是否可行 split into executable children. That was repaired, so this set
 * is REGRESSION COVERAGE and round 23 is the current independent set.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-holdout22', createdAt: 1 } }

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

describe('hold-out 22 / K1: the remaining positions of the interrogative', () => {
  it.each([
    'Is it safe to install foo and restart service api?',
    'Are we allowed to install foo and restart service api?',
    '安装 foo 并重启 api 服务是否可行？',
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

  it('a question with no action before the marker keeps the closable lane', () => {
    const scopes = interpretMessage('文档是否需要更新？')
    expect(scopes.some((entry) => entry.authorityDisposition === 'informational'), JSON.stringify(scopes.map((entry) => [entry.authorityDisposition, entry.text]))).toBe(true)
    expect(isQuestionScopeNeedingReview('文档是否需要更新？')).toBe(false)
  })

  it.each([
    ['Rotate the logs to check if the disk is full.', 'Rotate the logs'],
    ['Archive the logs to record whether the shard failed.', 'Archive the logs'],
  ])('%s keeps its order: the interrogative is a purpose span', (text, needle) => {
    const scopes = interpretMessage(text)
    expect(scopes.some((entry) => entry.authorityDisposition !== 'informational' && entry.text.includes(needle)), JSON.stringify(scopes.map((entry) => [entry.authorityDisposition, entry.text]))).toBe(true)
  })

  it('preparation refuses the question and accepts the separate instruction', async () => {
    const question = derive('Is it safe to install foo and restart service api?')
    const questionItem = [...question.items.values()][0]!
    const refused = await createPrepareTool({ getProjection: () => question }).execute({
      item_id: questionItem.id, semantic_action: questionItem.semanticAction ?? 'install',
      requested_target: questionItem.requestedTarget ?? {},
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(refused.compatibility.status).not.toBe('compatible')

    const order = derive('Is it safe to install foo? Then restart service api.')
    const restart = [...order.items.values()].find((item) => item.semanticAction === 'restart')
    expect(restart?.authorityDisposition).toBe('executable_now')
  })
})

describe('hold-out 22 / K2: inheritance beside the boundary shapes', () => {
  it('an agreeing pair is inherited whole', () => {
    const projection = derive(['提交仓库 /repo-n 分支 main。', '提交仓库 /repo-n 分支 main。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.targetCaptureStatus).toBe('resolved')
    expect(last.requestedTarget).toEqual({ repository: '/repo-n', branch: 'main' })
  })

  it('a conflicting pair leaves only the branch open', () => {
    const projection = derive(['提交仓库 /repo-n 分支 main。', '提交仓库 /repo-n 分支 release。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.requestedTarget).toEqual({ repository: '/repo-n' })
    expect(last.targetCaptureReasonCode).toBe('requested_target_field_ambiguous')
  })

  it('a single target is unaffected', () => {
    const item = captureClause('提交仓库 /repo-n 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus).toBe('resolved')
  })

  it('a question scope item holds no authority with a resolved target', () => {
    const projection = createProjection()
    projection.enabled = true
    const derived = derive('安装 foo 并重启 api 服务是否可行？')
    for (const item of derived.items.values()) projection.items.set(item.id, item)
    for (const decision of authorizations(projection)) expect(decision.endsWith(':authorized')).toBe(false)
  })
})
