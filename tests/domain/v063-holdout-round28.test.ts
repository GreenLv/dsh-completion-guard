import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { interpretMessage, isQuestionScopeNeedingReview } from '../../src/domain/semantics.js'
import { captureClause } from '../../src/domain/capture.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope } from '../../src/domain/types.js'
import { expectNarrowedUndecided } from './narrowed-contract.js'

/**
 * 0.6.3 hold-out round 28 — regression coverage (was the independent set).
 *
 * Round 27 found the coordination-free `that` complement, so it is regression
 * coverage. Round 28 is a final sweep over the boundary conditions of the whole
 * question / explanation / investigation family, in wording this batch has never
 * used:
 *
 * - a pure `that` verification beside its coordinated form;
 * - a `whether` complement that coordinates two STATE clauses with their own
 *   subjects;
 * - pure Chinese investigations beside their coordinated forms;
 * - the plain orders and the separate sentences either side of the boundary;
 * - the gate, preparation, inheritance and eligibility beside those shapes.
 *
 * It found one more source defect of the same family: the Chinese subject rule had
 * to require an ACTION predicate inside the complement (the rotation verb was also
 * missing from the work vocabulary), so a state question about an object kept its
 * order while an actor's action did not. That was repaired, so this set is
 * REGRESSION COVERAGE and round 29 is the current independent set.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-holdout28', createdAt: 1 } }

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

describe('hold-out 28 / K1: the boundary conditions of the family', () => {
  it.each([
    'Verify that the operator rotates the keys and redeploys the service.',
    '确认运维人员是否轮换密钥并部署新版本。',
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

  it('a coordination of two STATE clauses grants no authority either', () => {
    // Oracle correction: this English shape has no action predicate inside the
    // complement, so the clause is split rather than governed. The contract point is
    // that nothing in it is authority and the second part is not an order.
    const projection = derive('Check whether the migration completed and the schema is current.')
    const items = [...projection.items.values()]
    expect(items.some((item) => item.authorityDisposition === 'executable_now')).toBe(false)
    for (const decision of authorizations(projection)) expect(decision.endsWith(':authorized')).toBe(false)
    expect(items.every((item) => item.status === 'pending' || item.authorityDisposition === 'informational')).toBe(true)
  })

  it.each([
    'Verify that the operator rotates the keys.',
    '检查运维人员是否轮换密钥。',
    'Check whether the migration completed.',
  ])('%s asks for a verification and stays answerable', (text) => {
    const scopes = interpretMessage(text)
    expect(scopes.some((entry) => entry.authorityDisposition === 'informational'), JSON.stringify(scopes.map((entry) => [entry.authorityDisposition, entry.text]))).toBe(true)
    expect(isQuestionScopeNeedingReview(text)).toBe(false)
  })

  it('the state-question complement keeps its second order', () => {
    // 合同调整 (0.6.3 收窄合同): the coordinated action stays one
    // undecided obligation and is no longer auto-authorized.
    expectNarrowedUndecided('检查是否有新版本并且安装这个主题。')
  })

  it('a plain order keeps its authority', () => {
    const projection = derive('安装 foo 并重启 api 服务。')
    expect([...projection.items.values()].some((item) => item.authorityDisposition === 'executable_now')).toBe(true)
  })

  it('preparation refuses the boundary and accepts the separate sentence', async () => {
    const question = derive('确认运维人员是否轮换密钥并部署新版本。')
    const questionItem = [...question.items.values()][0]!
    const refused = await createPrepareTool({ getProjection: () => question }).execute({
      item_id: questionItem.id, semantic_action: questionItem.semanticAction ?? 'restart',
      requested_target: questionItem.requestedTarget ?? {},
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(refused.compatibility.status).not.toBe('compatible')

    const order = derive('确认运维人员是否轮换密钥。然后安装依赖。')
    const install = [...order.items.values()].find((item) => item.normalizedText.includes('安装依赖'))
    expect(install?.authorityDisposition).toBe('executable_now')
  })
})

describe('hold-out 28 / K2: inheritance beside the family boundary', () => {
  it('an agreeing pair is inherited whole', () => {
    const projection = derive(['提交仓库 /repo-t 分支 main。', '提交仓库 /repo-t 分支 main。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.targetCaptureStatus).toBe('resolved')
    expect(last.requestedTarget).toEqual({ repository: '/repo-t', branch: 'main' })
  })

  it('a conflicting pair leaves only the branch open', () => {
    const projection = derive(['提交仓库 /repo-t 分支 main。', '提交仓库 /repo-t 分支 release。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.requestedTarget).toEqual({ repository: '/repo-t' })
    expect(last.targetCaptureReasonCode).toBe('requested_target_field_ambiguous')
  })

  it('a single target is unaffected', () => {
    const item = captureClause('提交仓库 /repo-t 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus).toBe('resolved')
  })

  it('a boundary item holds no authority with a resolved target', () => {
    const projection = createProjection()
    projection.enabled = true
    const derived = derive('Verify that the operator rotates the keys and redeploys the service.')
    for (const item of derived.items.values()) projection.items.set(item.id, item)
    for (const decision of authorizations(projection)) expect(decision.endsWith(':authorized')).toBe(false)
  })
})
