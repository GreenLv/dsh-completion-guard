import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { interpretMessage, isQuestionScopeNeedingReview } from '../../src/domain/semantics.js'
import { captureClause } from '../../src/domain/capture.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope } from '../../src/domain/types.js'
import { expectNarrowedUndecided } from './narrowed-contract.js'

/**
 * 0.6.3 hold-out round 30 — the current independent set.
 *
 * Round 29 found nothing of its own, but the THIRTEENTH review then inverted the
 * complement rule (governing by default, closing only on positive proof of a state
 * question), so it is regression coverage. Round 30 exercises the two sides of that
 * inversion with wording this batch has never used:
 *
 * - unrecognised predicates of several kinds (archive/compress/rotate/reindex and
 *   Chinese 归档/压缩/重建索引) inside an actor complement;
 * - actors in every position: before the subordinator, after it, behind 由, behind
 *   whether, and an impersonal one;
 * - the proven state questions that must keep their coordinated order;
 * - the plain orders and the separate sentences either side;
 * - inheritance and eligibility beside those shapes.
 *
 * Expectations come from the contract. A failure here is a source finding.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-holdout30', createdAt: 1 } }

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

describe('hold-out 30 / K1: the inverted rule, both sides', () => {
  it.each([
    'Check whether the operators compress the archives and restart service api.',
    'Check whether the operators reindex the search index and restart service api.',
    '检查运维人员是否压缩归档并重启 api 服务。',
    '确认是否有同事重建索引并重启 api 服务。',
    '检查是否由值班人员刷新缓存并重启 api 服务。',
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
    ['检查服务是否正常并记录变更。', '记录变更'],
    ['确认磁盘空间是否充足并清理临时文件。', '清理临时文件'],
    ['Check whether the cache is valid and install the package.', 'install the package'],
  ])('%s is proven to be a state question: the coordinated order survives', (text, _needle) => {
    // 合同调整 (0.6.3 收窄合同): the coordinated action stays one undecided
    // obligation and is no longer auto-authorized.
    expectNarrowedUndecided(text)
  })

  it.each([
    '检查服务是否正常。',
    'Verify whether the disk is full.',
    '检查是否有新版本。',
  ])('%s is a question about state and stays answerable', (text) => {
    const scopes = interpretMessage(text)
    expect(scopes.some((entry) => entry.authorityDisposition === 'informational'), JSON.stringify(scopes.map((entry) => [entry.authorityDisposition, entry.text]))).toBe(true)
    expect(isQuestionScopeNeedingReview(text)).toBe(false)
  })

  it('a plain order keeps its authority', () => {
    const projection = derive('压缩归档并重启 api 服务。')
    expect([...projection.items.values()].some((item) => item.authorityDisposition === 'executable_now')).toBe(true)
  })

  it('preparation refuses the actor complement and accepts the separate sentence', async () => {
    const question = derive('确认是否有同事重建索引并重启 api 服务。')
    const questionItem = [...question.items.values()][0]!
    const refused = await createPrepareTool({ getProjection: () => question }).execute({
      item_id: questionItem.id, semantic_action: questionItem.semanticAction ?? 'restart',
      requested_target: questionItem.requestedTarget ?? {},
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(refused.compatibility.status).not.toBe('compatible')

    const order = derive('确认是否有同事重建索引。然后重启 api 服务。')
    const restart = [...order.items.values()].find((item) => item.normalizedText.includes('重启 api 服务'))
    expect(restart?.authorityDisposition).toBe('executable_now')
  })
})

describe('hold-out 30 / K2: inheritance beside the inverted-rule shapes', () => {
  it('an agreeing pair is inherited whole', () => {
    const projection = derive(['提交仓库 /repo-v 分支 main。', '提交仓库 /repo-v 分支 main。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.targetCaptureStatus).toBe('resolved')
    expect(last.requestedTarget).toEqual({ repository: '/repo-v', branch: 'main' })
  })

  it('a conflicting pair leaves only the branch open', () => {
    const projection = derive(['提交仓库 /repo-v 分支 main。', '提交仓库 /repo-v 分支 release。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.requestedTarget).toEqual({ repository: '/repo-v' })
    expect(last.targetCaptureReasonCode).toBe('requested_target_field_ambiguous')
  })

  it('a single target is unaffected', () => {
    const item = captureClause('提交仓库 /repo-v 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus).toBe('resolved')
  })

  it('an actor-complement item holds no authority with a resolved target', () => {
    const projection = createProjection()
    projection.enabled = true
    const derived = derive('Check whether the operators compress the archives and restart service api.')
    for (const item of derived.items.values()) projection.items.set(item.id, item)
    for (const decision of authorizations(projection)) expect(decision.endsWith(':authorized')).toBe(false)
  })
})
