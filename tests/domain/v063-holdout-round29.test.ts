import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { interpretMessage, isQuestionScopeNeedingReview } from '../../src/domain/semantics.js'
import { captureClause } from '../../src/domain/capture.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope } from '../../src/domain/types.js'
import { expectNarrowedUndecided } from './narrowed-contract.js'

/**
 * 0.6.3 hold-out round 29 — regression coverage (was the independent set).
 *
 * Round 28 found that the Chinese subject rule needed an action predicate, so it is
 * regression coverage. Round 29 sweeps the whole family's boundary once more with
 * wording this batch has never used, so that the two sides of every rule are pinned
 * together:
 *
 * - an actor complement whose predicate is a rotation, a migration or a refresh;
 * - a state question about an object, which keeps its coordinated order;
 * - a complement that coordinates two OBJECT lists, which is not two actions;
 * - the plain orders and the separate sentences either side of the boundary;
 * - preparation, inheritance and eligibility beside those shapes.
 *
 * It found nothing of its own, but the THIRTEENTH review then showed the
 * complement rule still needed evidence the surface cannot supply (a recognised
 * predicate, a subject in one particular position), and that repair changed the
 * source, so it is REGRESSION COVERAGE and round 30 is the current independent set.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-holdout29', createdAt: 1 } }

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

describe('hold-out 29 / K1: both sides of the actor boundary', () => {
  it.each([
    '确认运维同事是否迁移数据库并重启 api 服务。',
    '检查发布脚本是否刷新缓存并部署新版本。',
    'Check whether the release scripts refresh the cache and deploy the new version.',
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
    ['确认缓存是否有效并安装依赖。', '安装依赖'],
    ['检查磁盘空间是否充足并清理临时文件。', '清理临时文件'],
  ])('%s is a state question about an object: the coordinated order survives', (text, _needle) => {
    // 合同调整 (0.6.3 收窄合同): the coordinated action stays one undecided
    // obligation and is no longer auto-authorized.
    expectNarrowedUndecided(text)
  })

  it('an object list coordinated inside a question is not two actions', () => {
    // 合同调整 clarification: this shape is NOT superseded — the coordinator joins
    // OBJECTS, so it keeps the answerable lane under the narrowed contract too.
    const scopes = interpretMessage('检查日志和配置是否有变化。')
    expect(scopes.some((entry) => entry.authorityDisposition === 'informational')).toBe(true)
    expect(isQuestionScopeNeedingReview('检查日志和配置是否有变化。')).toBe(false)
  })

  it('the plain order keeps its authority', () => {
    const projection = derive('迁移数据库并重启 api 服务。')
    expect([...projection.items.values()].some((item) => item.authorityDisposition === 'executable_now')).toBe(true)
  })

  it('preparation refuses the actor complement and accepts the separate sentence', async () => {
    const question = derive('确认运维同事是否迁移数据库并重启 api 服务。')
    const questionItem = [...question.items.values()][0]!
    const refused = await createPrepareTool({ getProjection: () => question }).execute({
      item_id: questionItem.id, semantic_action: questionItem.semanticAction ?? 'restart',
      requested_target: questionItem.requestedTarget ?? {},
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(refused.compatibility.status).not.toBe('compatible')

    const order = derive('确认运维同事是否迁移数据库。然后重启 api 服务。')
    const restart = [...order.items.values()].find((item) => item.normalizedText.includes('重启 api 服务'))
    expect(restart?.authorityDisposition).toBe('executable_now')
  })
})

describe('hold-out 29 / K2: inheritance beside the actor boundary', () => {
  it('an agreeing pair is inherited whole', () => {
    const projection = derive(['提交仓库 /repo-u 分支 main。', '提交仓库 /repo-u 分支 main。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.targetCaptureStatus).toBe('resolved')
    expect(last.requestedTarget).toEqual({ repository: '/repo-u', branch: 'main' })
  })

  it('a conflicting pair leaves only the branch open', () => {
    const projection = derive(['提交仓库 /repo-u 分支 main。', '提交仓库 /repo-u 分支 release。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.requestedTarget).toEqual({ repository: '/repo-u' })
    expect(last.targetCaptureReasonCode).toBe('requested_target_field_ambiguous')
  })

  it('a single target is unaffected', () => {
    const item = captureClause('提交仓库 /repo-u 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus).toBe('resolved')
  })

  it('an actor-complement item holds no authority with a resolved target', () => {
    const projection = createProjection()
    projection.enabled = true
    const derived = derive('确认运维同事是否迁移数据库并重启 api 服务。')
    for (const item of derived.items.values()) projection.items.set(item.id, item)
    for (const decision of authorizations(projection)) expect(decision.endsWith(':authorized')).toBe(false)
  })
})
