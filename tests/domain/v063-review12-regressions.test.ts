import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { isQuestionScopeNeedingReview } from '../../src/domain/semantics.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection } from '../../src/domain/types.js'
import type { DerivedEnvelope } from '../../src/domain/types.js'
import { expectNarrowedUndecided } from './narrowed-contract.js'
/**
 * The TWELFTH independent review's counterexamples, kept as regressions.
 *
 * The review closed the investigation family: the actor of a coordinated predicate
 * inside an investigation complement may be the SCRIPT or the STAFF, not the
 * assistant, so the complement can coordinate its own predicates on its own
 * subject. `investigationComplementIsOpen` had required a modal or an infinitive, so
 * a plain declarative complement escaped and its second predicate became root
 * authority.
 *
 * The repair reads the DECLARATIVE complement structurally, per language: Chinese
 * puts the subject before the subordinator and the action directly after it
 * (检查[运维人员]是否[安装]…), while English puts the subject after the subordinator
 * and the action takes an object (whether [the deployment scripts] [install foo]).
 * A state question with no predicate of its own (是否有新版本, whether an update
 * exists) has neither signal, so the Chinese counterpart keeps its second order, and
 * the English counterpart — where a vocabulary verb cannot be told from a noun — is
 * kept UNDECIDED rather than authorized.
 */
const config = { activation: 'always' as const }
const scope = { cwd: '/repo-a', sessionHeader: { version: 3, id: 'v063-review12', createdAt: 1 } }
let seq = 0
function derive(texts: string[]) {
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
describe('review 12 / F1: a declarative complement carries its own actor', () => {
  it.each([
    'Check whether the deployment scripts install foo and restart service api.',
    '检查运维人员是否安装 foo 并重启 api 服务。',
  ])('%s is one undecided obligation that authorizes nothing', (text) => {
    const projection = derive([text])
    const items = [...projection.items.values()]
    expect(items.length, text).toBe(1)
    expect(items[0]!.authorityDisposition, text).toBe('unresolved')
    expect(isQuestionScopeNeedingReview(items[0]!.normalizedText), text).toBe(true)
    for (const decision of authorizations(projection)) {
      expect(decision.endsWith(':authorized'), `${text} / ${decision}`).toBe(false)
    }
  })
  it('preparation refuses the same item', async () => {
    const projection = createProjection()
    projection.enabled = true
    const derived = derive(['检查运维人员是否安装 foo 并重启 api 服务。'])
    const item = [...derived.items.values()][0]!
    projection.items.set(item.id, item)
    const prepared = await createPrepareTool({ getProjection: () => projection }).execute({
      item_id: item.id, semantic_action: item.semanticAction ?? 'install',
      requested_target: item.requestedTarget ?? {},
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(prepared.compatibility.status).not.toBe('compatible')
  })
  it('a state question with no predicate of its own keeps its second order', () => {
    // 合同调整 (0.6.3 收窄合同): the coordinated action stays one
    // undecided obligation and is no longer auto-authorized.
    expectNarrowedUndecided('检查是否有新版本并且安装这个主题。')
  })
  it('an explicitly separate instruction after the investigation is authority', () => {
    // The investigation item may itself carry an install in its action plan, so the
    // SECOND item — the separate sentence — is the one to assert on.
    const projection = derive(['Check whether the deployment scripts install foo. Then install the package.'])
    const order = [...projection.items.values()].find((item) => item.normalizedText.includes('install the package'))
    expect(order?.authorityDisposition, JSON.stringify([...projection.items.values()].map((i) => [i.normalizedText, i.authorityDisposition]))).toBe('executable_now')
    expect(order?.status).toBe('pending')
  })
  it('the earlier question and explanation scopes stay closed', () => {
    for (const text of [
      'How do I install foo and restart service api safely?',
      'Explain how you install foo and restart service api.',
    ]) {
      const projection = derive([text])
      for (const decision of authorizations(projection)) {
        expect(decision.endsWith(':authorized'), `${text} / ${decision}`).toBe(false)
      }
    }
  })
})