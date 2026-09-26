import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { interpretMessage, isQuestionScopeNeedingReview } from '../../src/domain/semantics.js'
import { captureClause } from '../../src/domain/capture.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope } from '../../src/domain/types.js'

/**
 * 0.6.3 hold-out round 18 — regression coverage (was the independent set).
 *
 * Round 17 found one more source defect of the question-scope family (the action
 * in front of the interrogative can sit behind a modal), so it is regression
 * coverage. Round 18 covers the remaining COMBINATIONS of that family, in wording
 * this batch has never used, with the controls that keep it honest:
 *
 * - a modal in front of the action in both languages, and the same clause with the
 *   modal AFTER the interrogative;
 * - a coordinated question fragment that DOES carry an action, beside one that
 *   does not;
 * - an English `How many …` question with a long object;
 * - an order that must keep its authority in each of those messages;
 * - inheritance, preparation and eligibility beside those shapes.
 *
 * It found nothing of its own, but the ELEVENTH review then showed that an
 * investigation IMPERATIVE also governs its complement when that complement is open
 * (`Check whether it is safe to install … and restart …`), and that repair changed
 * the source, so it is REGRESSION COVERAGE and round 19 is the current independent
 * set.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-holdout18', createdAt: 1 } }

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

describe('hold-out 18 / K1: modals around the interrogative', () => {
  it.each([
    '需要安装多少依赖并重启 api 服务？',
    '可以安装哪些包并重启 api 服务？',
    'How many dependencies do we need to install and restart service api?',
    'How many packages can we install and restart service api at once?',
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

  it('a coordinated question fragment WITH an action governs the clause', () => {
    const scopes = interpretMessage('Rotate the logs, and how many shards it takes to install foo?')
    expect(scopes.every((entry) => entry.authorityDisposition !== 'executable_now'), JSON.stringify(scopes.map((entry) => [entry.authorityDisposition, entry.text]))).toBe(true)
  })

  it('a coordinated question fragment with NO action stays its own range', () => {
    const scopes = interpretMessage('Rotate the logs, and how many shards failed?')
    expect(scopes.some((entry) => entry.authorityDisposition === 'informational' && entry.text.includes('how many shards failed'))).toBe(true)
    expect(scopes.some((entry) => entry.authorityDisposition !== 'informational' && entry.text.includes('Rotate the logs'))).toBe(true)
  })

  it('an order-headed message keeps both orders beside the question', () => {
    const scopes = interpretMessage('Install the package, tell me how many shards failed, and rotate the logs.')
    expect(scopes.filter((entry) => entry.authorityDisposition === 'executable_now').length).toBeGreaterThanOrEqual(1)
    expect(scopes.some((entry) => entry.authorityDisposition === 'informational')).toBe(true)
  })

  it('preparation refuses a question scope and accepts its own sentence', async () => {
    const projection = createProjection()
    projection.enabled = true
    const question = derive('How many dependencies do we need to install and restart service api?')
    const questionItem = [...question.items.values()][0]!
    projection.items.set(questionItem.id, questionItem)
    const refused = await createPrepareTool({ getProjection: () => projection }).execute({
      item_id: questionItem.id, semantic_action: questionItem.semanticAction ?? 'install',
      requested_target: questionItem.requestedTarget ?? {},
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(refused.compatibility.status).not.toBe('compatible')

    const order = derive('How many dependencies do we need? Then install 3 packages.')
    const install = [...order.items.values()].find((item) => item.semanticAction === 'install')
    expect(install?.authorityDisposition).toBe('executable_now')
    if (install) {
      const allowed = await createPrepareTool({ getProjection: () => order }).execute({
        item_id: install.id, semantic_action: 'install', requested_target: install.requestedTarget ?? {},
      } as never, undefined as never) as { compatibility: { status: string } }
      expect(allowed.compatibility.status).not.toBe('incompatible')
    }
  })
})

describe('hold-out 18 / K2: inheritance and identity beside the question shapes', () => {
  it('an agreeing pair is inherited whole', () => {
    const projection = derive(['提交仓库 /repo-j 分支 main。', '提交仓库 /repo-j 分支 main。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.targetCaptureStatus).toBe('resolved')
    expect(last.requestedTarget).toEqual({ repository: '/repo-j', branch: 'main' })
  })

  it('a conflicting pair leaves only the branch open', () => {
    const projection = derive(['提交仓库 /repo-j 分支 main。', '提交仓库 /repo-j 分支 next。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.requestedTarget).toEqual({ repository: '/repo-j' })
    expect(last.targetCaptureReasonCode).toBe('requested_target_field_ambiguous')
  })

  it('two spellings of one repository remain one candidate', () => {
    const item = captureClause('提交仓库 /repo-j 与 /repo-j/。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus).toBe('resolved')
    expect(item.targetCaptureReasonCode).toBeUndefined()
  })
})
