import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { interpretMessage, isQuestionScopeNeedingReview } from '../../src/domain/semantics.js'
import { captureClause } from '../../src/domain/capture.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope } from '../../src/domain/types.js'
import { expectNarrowedUndecided } from './narrowed-contract.js'

/**
 * 0.6.3 hold-out round 26 — regression coverage (was the independent set).
 *
 * Round 25 found nothing of its own, but the TWELFTH review then established that a
 * declarative investigation complement carries its own actor, so it is regression
 * coverage. Round 26 covers that boundary in wording this batch has never used:
 *
 * - complements whose actor is a system or a role, in both languages, with the
 *   coordination in different positions;
 * - a complement with an actor but no coordination, which must keep the answerable
 *   lane;
 * - a complement whose state question has no predicate of its own, which keeps its
 *   second order;
 * - the separate instruction that stays authority;
 * - the gate, preparation, inheritance and eligibility beside those shapes.
 *
 * It found one more source defect of the same family: an investigation whose
 * complement is the DECLARATIVE clause after `that` ("Verify that the operator
 * rotates the credentials and redeploys the service") was still authorized. That was
 * repaired, so this set is REGRESSION COVERAGE and round 27 is the current
 * independent set.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-holdout26', createdAt: 1 } }

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

describe('hold-out 26 / K1: the complement\u2019s own actor', () => {
  it.each([
    'Check whether the migration scripts update the schema and restart the worker.',
    'Verify that the operator rotates the credentials and redeploys the service.',
    '确认值班同事是否部署新版本并重启 api 服务。',
    '看看自动化脚本是否安装依赖并清理缓存。',
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

  it('an actor without coordination keeps the answerable lane', () => {
    const scopes = interpretMessage('检查部署脚本是否已经完成迁移。')
    expect(scopes.some((entry) => entry.authorityDisposition === 'informational'), JSON.stringify(scopes.map((entry) => [entry.authorityDisposition, entry.text]))).toBe(true)
    expect(isQuestionScopeNeedingReview('检查部署脚本是否已经完成迁移。')).toBe(false)
  })

  it('a state question with no predicate of its own keeps its second order', () => {
    // 合同调整 (0.6.3 收窄合同): the coordinated action stays one
    // undecided obligation and is no longer auto-authorized.
    expectNarrowedUndecided('检查是否有新版本并记录变更。')
  })

  it('a separate sentence after the investigation is authority', async () => {
    const projection = derive('确认运维人员是否重启 api 服务。然后安装依赖。')
    const order = [...projection.items.values()].find((item) => item.normalizedText.includes('安装依赖'))
    expect(order?.authorityDisposition, JSON.stringify([...projection.items.values()].map((i) => [i.normalizedText, i.authorityDisposition]))).toBe('executable_now')
  })

  it('preparation refuses the complement and accepts the separate sentence', async () => {
    const question = derive('确认运维人员是否重启 api 服务。')
    const questionItem = [...question.items.values()][0]!
    const refused = await createPrepareTool({ getProjection: () => question }).execute({
      item_id: questionItem.id, semantic_action: questionItem.semanticAction ?? 'restart',
      requested_target: questionItem.requestedTarget ?? {},
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(refused.compatibility.status).not.toBe('compatible')
  })
})

describe('hold-out 26 / K2: inheritance beside the complement shapes', () => {
  it('an agreeing pair is inherited whole', () => {
    const projection = derive(['提交仓库 /repo-r 分支 main。', '提交仓库 /repo-r 分支 main。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.targetCaptureStatus).toBe('resolved')
    expect(last.requestedTarget).toEqual({ repository: '/repo-r', branch: 'main' })
  })

  it('a conflicting pair leaves only the branch open', () => {
    const projection = derive(['提交仓库 /repo-r 分支 main。', '提交仓库 /repo-r 分支 release。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.requestedTarget).toEqual({ repository: '/repo-r' })
    expect(last.targetCaptureReasonCode).toBe('requested_target_field_ambiguous')
  })

  it('a single target is unaffected', () => {
    const item = captureClause('提交仓库 /repo-r 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus).toBe('resolved')
  })

  it('a complement-scope item holds no authority with a resolved target', () => {
    const projection = createProjection()
    projection.enabled = true
    const derived = derive('Check whether the migration scripts update the schema and restart the worker.')
    for (const item of derived.items.values()) projection.items.set(item.id, item)
    for (const decision of authorizations(projection)) expect(decision.endsWith(':authorized')).toBe(false)
  })
})
