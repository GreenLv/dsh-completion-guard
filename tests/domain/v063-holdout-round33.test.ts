import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { interpretMessage, isQuestionScopeNeedingReview } from '../../src/domain/semantics.js'
import { captureClause } from '../../src/domain/capture.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope } from '../../src/domain/types.js'
import { expectNarrowedUndecided } from './narrowed-contract.js'

/**
 * 0.6.3 hold-out round 33 — the current independent set.
 *
 * Round 32 found three source defects (the `to` inside the spaced `up to date`, the
 * postposed Chinese interrogative whose questioned span carried an unrecognised verb,
 * and a yes/no question with an explicit subject and no imperative head that
 * authorized the order beside it), so it is regression coverage and this set
 * replaces it. It required no source change.
 *
 * Wording this batch has never used, on both sides of the predicate proof:
 *
 * - a yes/no question that states its own subject and carries no imperative at all,
 *   coordinated with an order — governed, and authorizing nothing;
 * - the postposed interrogative whose questioned span carries the action;
 * - state predicates that close the complement: Chinese adjectives, the stative
 *   verbs, and the English copula shapes;
 * - the coordination-free answerable lane;
 * - inheritance and the gate/preparation pair on the same shapes.
 *
 * Expectations come from the contract. A failure here is a source finding: this set
 * found one. A clause whose question governs a coordinated order was classified as
 * session talk, so the message produced NO obligation at all — the order vanished
 * instead of staying visible and undecided. The classifier now consumes the reader's
 * own predicate, so both agree about what is work. One of this set's own expectations
 * was also wrong and is corrected here as an oracle error: the coordination-free
 * subject question carries the answerable lane only when it is written with a
 * question mark (`镜像是否可用？`; the unmarked form stays undecided, which is the
 * safe direction).
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-holdout33', createdAt: 1 } }

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

describe('hold-out 33 / K1: the predicate proof, both sides', () => {
  it.each([
    '维护者是否重排索引并重启 api 服务。',
    '审计员是不是替换凭据并轮换密钥。',
    '调度器有没有排空队列并重启 api 服务。',
    '核对一下归档日志并重启 api 服务是否完成。',
    'Check whether the inspector stamps the approved manifest and restart service api.',
  ])('%s is one undecided obligation that authorizes nothing', (text) => {
    const projection = derive(text)
    const items = [...projection.items.values()]
    expect(items.length, text).toBe(1)
    expect(items[0]!.authorityDisposition, text).toBe('unresolved')
    for (const decision of authorizations(projection)) {
      expect(decision.endsWith(':authorized'), `${text} / ${decision}`).toBe(false)
    }
    expect(isQuestionScopeNeedingReview(items[0]!.normalizedText), text).toBe(true)
  })

  it.each([
    ['镜像是否可用并轮换密钥。', '轮换密钥'],
    ['端口是否一致并清理临时文件。', '清理临时文件'],
    ['证书是否有效并轮换密钥。', '轮换密钥'],
    ['确认是否存在可用的补丁并轮换密钥。', '轮换密钥'],
    ['Check whether the replica set is stable and restart service api.', 'restart service api'],
    ['Verify whether the certificate chain is fresh and install the package.', 'install the package'],
    ['Confirm whether the replica is up to date and restart service api.', 'restart service api'],
  ])('%s predicates a state, so the coordinated order keeps its authority', (text, _needle) => {
    // 合同调整 (0.6.3 收窄合同): the coordinated action stays one undecided
    // obligation and is no longer auto-authorized.
    expectNarrowedUndecided(text)
  })

  it.each([
    '镜像是否可用？',
    '检查部署脚本是否已经完成迁移。',
    'Check whether the replica set is stable.',
  ])('%s is a question about state and stays answerable', (text) => {
    const scopes = interpretMessage(text)
    expect(
      scopes.some((entry) => entry.authorityDisposition === 'informational'),
      JSON.stringify(scopes.map((entry) => [entry.authorityDisposition, entry.text])),
    ).toBe(true)
  })

  it('a plain order keeps its authority', () => {
    const projection = derive('轮换密钥并清理临时文件。')
    expect([...projection.items.values()].some((item) => item.authorityDisposition === 'executable_now')).toBe(true)
  })

  it('preparation refuses the unproven complement and accepts the separate sentence', async () => {
    const question = derive('审计员是不是替换凭据并轮换密钥。')
    const questionItem = [...question.items.values()][0]!
    const refused = await createPrepareTool({ getProjection: () => question }).execute({
      item_id: questionItem.id, semantic_action: questionItem.semanticAction ?? 'rotate',
      requested_target: questionItem.requestedTarget ?? {},
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(refused.compatibility.status).not.toBe('compatible')

    const order = derive('确认是否存在可用的补丁。然后轮换密钥。')
    const rotate = [...order.items.values()].find((item) => item.normalizedText.includes('轮换密钥'))
    expect(rotate?.authorityDisposition).toBe('executable_now')
  })

  it('an unproven complement holds no authority with a resolved target', () => {
    const projection = createProjection()
    projection.enabled = true
    const derived = derive('Check whether the inspector stamps the approved manifest and restart service api.')
    for (const item of derived.items.values()) projection.items.set(item.id, item)
    for (const decision of authorizations(projection)) expect(decision.endsWith(':authorized')).toBe(false)
  })
})

describe('hold-out 33 / K2: inheritance beside the predicate shapes', () => {
  it('an agreeing pair is inherited whole', () => {
    const projection = derive(['提交仓库 /repo-y 分支 main。', '提交仓库 /repo-y 分支 main。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.targetCaptureStatus).toBe('resolved')
    expect(last.requestedTarget).toEqual({ repository: '/repo-y', branch: 'main' })
  })

  it('a conflicting pair leaves only the branch open', () => {
    const projection = derive(['提交仓库 /repo-y 分支 main。', '提交仓库 /repo-y 分支 release。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.requestedTarget).toEqual({ repository: '/repo-y' })
    expect(last.targetCaptureReasonCode).toBe('requested_target_field_ambiguous')
  })

  it('a single target is unaffected', () => {
    const item = captureClause('提交仓库 /repo-y 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus).toBe('resolved')
  })
})
