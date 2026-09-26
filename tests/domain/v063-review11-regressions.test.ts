import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { isQuestionScopeNeedingReview } from '../../src/domain/semantics.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection } from '../../src/domain/types.js'
import type { DerivedEnvelope } from '../../src/domain/types.js'
import { expectNarrowedUndecided } from './narrowed-contract.js'
/**
 * The ELEVENTH independent review's counterexamples, kept as regressions.
 *
 * The review showed the last gap in the question-scope family: an INVESTIGATION
 * imperative was excluded from the governing set wholesale, so
 * `Check whether it is safe to install foo and restart service api.` split at the
 * coordinator and the two actions became authority. The imperative head does not
 * make its embedded actions authorized: the root asked to CHECK whether installing
 * and restarting is safe, should happen, or is needed.
 *
 * The repair distinguishes an independent instruction from an investigation
 * COMPLEMENT structurally: the complement must open with its own subordinator
 * (`whether`/`if`, 是否/有没有) AND carry a modal or an infinitive before the
 * coordinator (`to install`, `we should install`, 需要安装). A complement that
 * merely states a fact ("whether an update exists") keeps the second order it
 * always had, which is what the earlier reviews pinned.
 */
const config = { activation: 'always' as const }
const scope = { cwd: '/repo-a', sessionHeader: { version: 3, id: 'v063-review11', createdAt: 1 } }
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
/** Decide every action the item names against the item's OWN target. */
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
describe('review 11 / F1: an investigation complement is not authority', () => {
  it.each([
    'Check whether it is safe to install foo and restart service api.',
    'Check whether we should install foo and restart service api.',
    '检查是否需要安装 foo 并重启 api 服务。',
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
    const derived = derive(['Check whether it is safe to install foo and restart service api.'])
    const item = [...derived.items.values()][0]!
    projection.items.set(item.id, item)
    const prepared = await createPrepareTool({ getProjection: () => projection }).execute({
      item_id: item.id, semantic_action: item.semanticAction ?? 'install',
      requested_target: item.requestedTarget ?? {},
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(prepared.compatibility.status).not.toBe('compatible')
  })
  it.each([
    // A complement that states a state question with no predicate of its own keeps
    // the second order: two imperatives. (The English case whose complement head is
    // a vocabulary verb is asserted separately: it is undecided since review 12.)
    ['Verify whether the lock file is current and install the package.', 'install'],
    ['检查是否有新版本并且安装这个主题。', '安装'],
    ['Check for a new version, then install the theme.', 'install'],
  ])('%s keeps an order of its own', (text, _needle) => {
    // 合同调整 (0.6.3 收窄合同): the coordinated action stays one undecided
    // obligation and is no longer auto-authorized.
    expectNarrowedUndecided(text)
  })
  it('an English complement headed by a vocabulary verb stays visible, not authorized', () => {
    const projection = derive(['Check whether an update exists and install the package.'])
    const items = [...projection.items.values()]
    expect(items.every((item) => item.authorityDisposition !== 'informational')).toBe(true)
    expect(items.every((item) => item.authorityDisposition !== 'executable_now')).toBe(true)
    for (const item of items) expect(item.status).toBe('pending')
  })
  it('the same investigation with a separate instruction keeps the instruction', () => {
    const projection = derive(['Check whether it is safe to install foo. Then restart service api.'])
    const restart = [...projection.items.values()].find((item) => item.semanticAction === 'restart')
    expect(restart, JSON.stringify([...projection.items.values()].map((i) => [i.normalizedText, i.authorityDisposition]))).toBeDefined()
    expect(restart!.authorityDisposition).toBe('executable_now')
  })
  it('a question head still keeps the earlier shapes closed', () => {
    for (const text of ['How do I install foo and restart service api safely?', 'Explain how you install foo and restart service api.']) {
      const projection = derive([text])
      for (const decision of authorizations(projection)) {
        expect(decision.endsWith(':authorized'), `${text} / ${decision}`).toBe(false)
      }
    }
  })
})