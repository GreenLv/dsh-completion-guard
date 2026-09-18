import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { interpretMessage, isQuestionScopeNeedingReview } from '../../src/domain/semantics.js'
import { classifyUserInteraction } from '../../src/domain/conversation.js'
import { captureClause } from '../../src/domain/capture.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope } from '../../src/domain/types.js'
import { expectNarrowedUndecided } from './narrowed-contract.js'

/**
 * 0.6.3 hold-out round 35 — the current independent set.
 *
 * Round 34 widened the state-predicate proof for two shapes it found (a Chinese
 * predicate with no copula — `队列是否为空` — and a state noun outside the proof
 * vocabulary — `可用的租约`), so it is regression coverage and this set replaces it.
 * It required no source change.
 *
 * Wording this batch has never used:
 *
 * - the stative and adjective shapes in Chinese, including the ones round 34 added;
 * - the subject question and the imperative question side by side;
 * - the classifier and the reader agreeing that a governed clause is work;
 * - the pure question that adds no obligation;
 * - inheritance and the gate/preparation pair.
 *
 * Expectations come from the contract. A failure here is a source finding. One of
 * this set's own expectations was wrong when it was first written and is corrected
 * here as an oracle error: `话题还不错呢？` is a yes/no question that covers its whole
 * clause, so it belongs in the answerable lane (`呢` asks about the sentence, as the
 * pinned `主题是不是需要更新呢？` does); the contract point the row tests is that the
 * lane is never execution, not that the lane is absent.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-holdout35', createdAt: 1 } }

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

describe('hold-out 35 / K1: proof on both sides, and no dropped governed clause', () => {
  it.each([
    '保管员是否重排工单并重启 api 服务。',
    '保管员是不是回收租户并轮换密钥。',
    '保管员有没有腾空队列并重启 api 服务。',
    'Check whether the steward retags the approved artefacts and restart service api.',
  ])('%s keeps one undecided obligation that authorizes nothing', (text) => {
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
    '保管员是否重排工单并重启 api 服务。',
    '保管员是不是回收租户并轮换密钥。',
  ])('%s is captured as work, not discarded as session talk', (text) => {
    expect(classifyUserInteraction(text), text).toBe('instruction')
  })

  it.each([
    ['队列是否为空并清理临时文件。', '清理临时文件'],
    ['工单是否为空并轮换密钥。', '轮换密钥'],
    ['确认是否存在可用的租约并轮换密钥。', '轮换密钥'],
    ['确认是否存在可用的工单并清理临时文件。', '清理临时文件'],
    ['Check whether the steward plane is stable and restart service api.', 'restart service api'],
    ['Verify whether the retention policy is current and install the package.', 'install the package'],
  ])('%s predicates a state, so the coordinated order keeps its authority', (text, _needle) => {
    // 合同调整 (0.6.3 收窄合同): the coordinated action stays one undecided
    // obligation and is no longer auto-authorized.
    expectNarrowedUndecided(text)
  })

  it.each([
    ['保管员是否回收租户？', true],
    ['话题还不错呢？', true],
  ])('%s: the answerable lane is decided by the question, never by authority (%s)', (text, answerable) => {
    const scopes = interpretMessage(text)
    const hasInformation = scopes.some((entry) => entry.authorityDisposition === 'informational')
    expect(hasInformation, JSON.stringify(scopes.map((entry) => [entry.authorityDisposition, entry.text]))).toBe(answerable)
    expect(scopes.every((entry) => entry.authorityDisposition !== 'executable_now'), text).toBe(true)
  })

  it('a plain order keeps its authority', () => {
    const projection = derive('清理临时文件并轮换密钥。')
    expect([...projection.items.values()].some((item) => item.authorityDisposition === 'executable_now')).toBe(true)
  })

  it('preparation refuses the governed clause and accepts the separate sentence', async () => {
    const question = derive('保管员是不是回收租户并轮换密钥。')
    const questionItem = [...question.items.values()][0]!
    const refused = await createPrepareTool({ getProjection: () => question }).execute({
      item_id: questionItem.id, semantic_action: questionItem.semanticAction ?? 'rotate',
      requested_target: questionItem.requestedTarget ?? {},
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(refused.compatibility.status).not.toBe('compatible')

    const order = derive('确认是否存在可用的工单。然后清理临时文件。')
    const cleanup = [...order.items.values()].find((item) => item.normalizedText.includes('清理临时文件'))
    expect(cleanup?.authorityDisposition).toBe('executable_now')
  })

  it('a governed clause holds no authority with a resolved target', () => {
    const projection = createProjection()
    projection.enabled = true
    const derived = derive('Check whether the steward retags the approved artefacts and restart service api.')
    for (const item of derived.items.values()) projection.items.set(item.id, item)
    for (const decision of authorizations(projection)) expect(decision.endsWith(':authorized')).toBe(false)
  })
})

describe('hold-out 35 / K2: inheritance beside the predicate shapes', () => {
  it('an agreeing pair is inherited whole', () => {
    const projection = derive(['提交仓库 /repo-w2 分支 main。', '提交仓库 /repo-w2 分支 main。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.targetCaptureStatus).toBe('resolved')
    expect(last.requestedTarget).toEqual({ repository: '/repo-w2', branch: 'main' })
  })

  it('a conflicting pair leaves only the branch open', () => {
    const projection = derive(['提交仓库 /repo-w2 分支 main。', '提交仓库 /repo-w2 分支 release。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.requestedTarget).toEqual({ repository: '/repo-w2' })
    expect(last.targetCaptureReasonCode).toBe('requested_target_field_ambiguous')
  })

  it('a single target is unaffected', () => {
    const item = captureClause('提交仓库 /repo-w2 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus).toBe('resolved')
  })
})
