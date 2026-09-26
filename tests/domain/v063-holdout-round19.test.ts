import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { interpretMessage, isQuestionScopeNeedingReview } from '../../src/domain/semantics.js'
import { captureClause } from '../../src/domain/capture.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope } from '../../src/domain/types.js'
import { expectNarrowedUndecided } from './narrowed-contract.js'

/**
 * 0.6.3 hold-out round 19 — regression coverage (was the independent set).
 *
 * Round 18 found nothing of its own, but the ELEVENTH review then showed an
 * investigation IMPERATIVE governs an open complement, so round 18 is regression
 * coverage. Round 19 covers the combinations that repair has not yet been exercised
 * on, in wording this batch has never used:
 *
 * - investigations whose complement opens with a modal, an infinitive or a
 *   necessity word, in both languages, with the coordinator in different positions;
 * - the same investigations whose complement states a FACT, which must keep the
 *   second order;
 * - a noun-phrase complement (`check the safety of installing …`), which is not an
 *   open complement;
 * - preparation and the gate on both sides of the boundary;
 * - inheritance and eligibility beside those shapes.
 *
 * It found one more source defect of the same family: an investigation whose
 * complement opens with `if` (rather than `whether`) was still taken by the
 * CONDITION splitter, which cut it into a bare check plus a conditional order. That
 * was repaired, so this set is REGRESSION COVERAGE and round 20 is the current
 * independent set.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-holdout19', createdAt: 1 } }

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

describe('hold-out 19 / K1: an open investigation complement governs its actions', () => {
  it.each([
    'Confirm whether it is advisable to install foo and restart service api.',
    'Determine if we can install foo and restart service api safely.',
    '检查是否可以安装 foo 并重启 api 服务。',
    '确认是否应该安装 foo 并重启 api 服务。',
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

  it('确认锁文件是否最新并安装依赖。 states a fact, so the second order survives', () => {
    // 合同调整 (0.6.3 收窄合同): the coordinated action stays one
    // undecided obligation and is no longer auto-authorized.
    expectNarrowedUndecided('确认锁文件是否最新并安装依赖。')
  })

  it('an English complement whose head is a vocabulary verb stays visible, not authorized', () => {
    // Oracle correction (review 12): `the release exists` cannot be told apart from
    // a subject + predicate complement on the surface, so the obligation is kept
    // undecided rather than authorized.
    const projection = derive('Check whether the release exists and install the package.')
    const items = [...projection.items.values()]
    expect(items.every((item) => item.authorityDisposition !== 'informational')).toBe(true)
    expect(items.every((item) => item.authorityDisposition !== 'executable_now')).toBe(true)
    for (const item of items) expect(item.status).toBe('pending')
  })

  it('a noun-phrase complement is not an open complement', () => {
    const scopes = interpretMessage('Check the safety of installing foo and restart service api.')
    expect(scopes.some((entry) => entry.authorityDisposition !== 'informational'), JSON.stringify(scopes.map((entry) => [entry.authorityDisposition, entry.text]))).toBe(true)
  })

  it('preparation and the gate agree on both sides of the boundary', async () => {
    const refusedProjection = createProjection()
    refusedProjection.enabled = true
    const refusedItem = [...derive('Confirm whether it is advisable to install foo and restart service api.').items.values()][0]!
    refusedProjection.items.set(refusedItem.id, refusedItem)
    const refused = await createPrepareTool({ getProjection: () => refusedProjection }).execute({
      item_id: refusedItem.id, semantic_action: refusedItem.semanticAction ?? 'install',
      requested_target: refusedItem.requestedTarget ?? {},
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(refused.compatibility.status).not.toBe('compatible')

    const allowedItem = [...derive('Check whether the release exists and install the package.').items.values()]
      .find((item) => item.semanticAction === 'install')!
    const allowed = await createPrepareTool({ getProjection: () => derive('Check whether the release exists and install the package.') }).execute({
      item_id: allowedItem.id, semantic_action: 'install', requested_target: allowedItem.requestedTarget ?? {},
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(allowed.compatibility.status).not.toBe('incompatible')
  })
})

describe('hold-out 19 / K2: inheritance beside the investigation shapes', () => {
  it('an agreeing pair is inherited whole', () => {
    const projection = derive(['提交仓库 /repo-k 分支 main。', '提交仓库 /repo-k 分支 main。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.targetCaptureStatus).toBe('resolved')
    expect(last.requestedTarget).toEqual({ repository: '/repo-k', branch: 'main' })
  })

  it('a conflicting pair leaves only the branch open', () => {
    const projection = derive(['提交仓库 /repo-k 分支 main。', '提交仓库 /repo-k 分支 hotfix。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.requestedTarget).toEqual({ repository: '/repo-k' })
    expect(last.targetCaptureReasonCode).toBe('requested_target_field_ambiguous')
  })

  it('a single target is unaffected', () => {
    const item = captureClause('提交仓库 /repo-k 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus).toBe('resolved')
  })
})
