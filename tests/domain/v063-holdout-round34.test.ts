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
 * 0.6.3 hold-out round 34 — the current independent set.
 *
 * Round 33 found one source defect: a clause whose question governs a coordinated
 * order was classified as session talk, so the message produced NO obligation and the
 * order vanished instead of staying visible and undecided. The classifier now consumes
 * the reader's own predicate. Round 33 is therefore regression coverage, and this set
 * replaces it. It required no source change.
 *
 * Wording this batch has never used, exercising the same invariant from new angles:
 *
 * - the message-level classifier must never drop a governed clause: a state question
 *   whose complement carries an order; a bare-subject question whose coordination is
 *   the order; a postposed interrogative over two actions;
 * - a genuinely question-only message stays session talk;
 * - the state predicates that close the complement, in both languages;
 * - the answerable lane, with and without the question mark;
 * - inheritance and the gate/preparation pair.
 *
 * Expectations come from the contract. A failure here is a source finding.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-holdout34', createdAt: 1 } }

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

describe('hold-out 34 / K1: a governed clause is never dropped, and never authority', () => {
  it.each([
    '柜员是否重排归档并重启 api 服务。',
    '柜员是不是回收租约并轮换密钥。',
    '编排器有没有排空队列并重启 api 服务。',
    'Check whether the inspector retags the frozen artefacts and restart service api.',
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
    '柜员是否重排归档并重启 api 服务。',
    '编排器有没有排空队列并重启 api 服务。',
  ])('%s is captured, not discarded as session talk', (text) => {
    expect(classifyUserInteraction(text), text).toBe('instruction')
  })

  it.each([
    '主题是不是需要更新呢？',
    '这个话题还不错呢？',
  ])('%s is question-only talk and creates no obligation', (text) => {
    expect(classifyUserInteraction(text), text).toBe('conversational')
  })

  it('a yes/no question that names a work word still adds no authority', () => {
    // Oracle correction inside this set: a question whose own word is a work verb
    // (`这份文档写得好吗？`) is captured and stays informational — the same lane the
    // pinned `这个 bug 需要修复吗？` has. It is never authority.
    const text = '这份文档写得好吗？'
    for (const scope of interpretMessage(text)) {
      expect(scope.authorityDisposition, text).toBe('informational')
    }
  })

  it.each([
    ['租约是否有效并轮换密钥。', '轮换密钥'],
    ['队列是否为空并清理临时文件。', '清理临时文件'],
    ['确认是否存在可用的租约并轮换密钥。', '轮换密钥'],
    ['Check whether the orchestration plane is stable and restart service api.', 'restart service api'],
    ['Verify whether the frozen artefacts are current and install the package.', 'install the package'],
  ])('%s predicates a state, so the coordinated order keeps its authority', (text, _needle) => {
    // 合同调整 (0.6.3 收窄合同): the coordinated action stays one undecided
    // obligation and is no longer auto-authorized.
    expectNarrowedUndecided(text)
  })

  it('a question-only message adds no obligation and authorizes nothing', () => {
    // Oracle correction inside this set: `核对一下归档日志并归档副本是否正常。` is a
    // question whose questioned span is coordinated, and it names no order outside
    // the question, so it is session talk exactly as the pinned question-only shapes
    // are. The contract point is that nothing in it is authority.
    const text = '核对一下归档日志并归档副本是否正常。'
    const scopes = interpretMessage(text)
    expect(scopes.every((entry) => entry.authorityDisposition !== 'executable_now'),
      JSON.stringify(scopes.map((entry) => [entry.authorityDisposition, entry.text]))).toBe(true)
  })

  it.each([
    ['柜员是否回收租约？', true],
    // 合同调整/oracle: a clause whose own predicate is a yes/no question asks with or
    // without the question mark, so the answerable lane follows the QUESTION rather
    // than the punctuation. The earlier reading tied the lane to the mark.
    ['柜员是否回收租约。', true],
  ])('%s: the answerable lane follows the question mark (%s)', (text, answerable) => {
    const scopes = interpretMessage(text)
    const hasInformation = scopes.some((entry) => entry.authorityDisposition === 'informational')
    expect(hasInformation, JSON.stringify(scopes.map((entry) => [entry.authorityDisposition, entry.text]))).toBe(answerable)
    // Either way nothing in it is authority.
    expect(scopes.every((entry) => entry.authorityDisposition !== 'executable_now'), text).toBe(true)
  })

  it('a plain order keeps its authority', () => {
    const projection = derive('轮换密钥并清理临时文件。')
    expect([...projection.items.values()].some((item) => item.authorityDisposition === 'executable_now')).toBe(true)
  })

  it('preparation refuses the governed clause and accepts the separate sentence', async () => {
    const question = derive('柜员是不是回收租约并轮换密钥。')
    const questionItem = [...question.items.values()][0]!
    const refused = await createPrepareTool({ getProjection: () => question }).execute({
      item_id: questionItem.id, semantic_action: questionItem.semanticAction ?? 'rotate',
      requested_target: questionItem.requestedTarget ?? {},
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(refused.compatibility.status).not.toBe('compatible')

    const order = derive('确认是否存在可用的租约。然后轮换密钥。')
    const rotate = [...order.items.values()].find((item) => item.normalizedText.includes('轮换密钥'))
    expect(rotate?.authorityDisposition).toBe('executable_now')
  })

  it('a governed clause holds no authority with a resolved target', () => {
    const projection = createProjection()
    projection.enabled = true
    const derived = derive('Check whether the inspector retags the frozen artefacts and restart service api.')
    for (const item of derived.items.values()) projection.items.set(item.id, item)
    for (const decision of authorizations(projection)) expect(decision.endsWith(':authorized')).toBe(false)
  })
})

describe('hold-out 34 / K2: inheritance beside the predicate shapes', () => {
  it('an agreeing pair is inherited whole', () => {
    const projection = derive(['提交仓库 /repo-z 分支 main。', '提交仓库 /repo-z 分支 main。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.targetCaptureStatus).toBe('resolved')
    expect(last.requestedTarget).toEqual({ repository: '/repo-z', branch: 'main' })
  })

  it('a conflicting pair leaves only the branch open', () => {
    const projection = derive(['提交仓库 /repo-z 分支 main。', '提交仓库 /repo-z 分支 release。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.requestedTarget).toEqual({ repository: '/repo-z' })
    expect(last.targetCaptureReasonCode).toBe('requested_target_field_ambiguous')
  })

  it('a single target is unaffected', () => {
    const item = captureClause('提交仓库 /repo-z 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus).toBe('resolved')
  })
})
