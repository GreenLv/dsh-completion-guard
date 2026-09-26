import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { isQuestionScopeNeedingReview } from '../../src/domain/semantics.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection } from '../../src/domain/types.js'
import type { DerivedEnvelope } from '../../src/domain/types.js'
import { expectNarrowedUndecided } from './narrowed-contract.js'
/**
 * The TENTH independent review's counterexamples, kept as regressions.
 *
 * The review showed the protection still depended on an EXPLANATION head: a bare
 * question (`如何…？`, `How do I …?`, `Can you explain …?`) was decomposed into an
 * information range plus a child that had LOST its parent question scope and was
 * marked `executable_now`, so the gate's last-resort refusal never saw it. It also
 * noted that some earlier negatives only looked safe because `api?` did not match
 * the target `api` — a text artifact, not semantic protection.
 *
 * The repair carries the qualification instead of re-guessing it: a clause a
 * QUESTION heads is decided ONCE, from that head, and is `unresolved` whenever it
 * also carries an action — so no child is ever created, and the gate and
 * preparation consume the same qualification.
 *
 * The boundary is kept where the earlier reviews put it: an investigation
 * IMPERATIVE (`Check whether …`, `检查是否…`) coordinates two imperatives, so the
 * second keeps its own order and its own execution authority.
 */
const config = { activation: 'always' as const }
const scope = { cwd: '/repo-a', sessionHeader: { version: 3, id: 'v063-review10', createdAt: 1 } }
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
describe('review 10 / F1: a question head carries its qualification into every child', () => {
  it.each([
    '如何安装 foo 并重启 api 服务？',
    'How do I install foo and restart service api safely?',
    'Can you explain how to install foo and restart service api safely?',
  ])('%s is one undecided obligation', (text) => {
    const projection = derive([text])
    const items = [...projection.items.values()]
    expect(items.length, text).toBe(1)
    expect(items[0]!.authorityDisposition, text).toBe('unresolved')
    expect(isQuestionScopeNeedingReview(items[0]!.normalizedText), text).toBe(true)
  })
  it('the refusal does not depend on the target text', () => {
    // The review's observation: a mismatch between "api?" and "api" made some
    // negatives look safe. Decide against the item's OWN captured target, so a
    // perfect match cannot hide the failure.
    for (const text of [
      'How do I install foo and restart service api safely?',
      '如何安装 foo 并重启 api 服务？',
    ]) {
      const projection = derive([text])
      for (const item of projection.items.values()) {
        for (const action of [item.semanticAction, ...(item.actionPlan ?? []).map((entry) => entry.action)]) {
          if (!action || action === 'generic_run') continue
          const planTarget = (item.actionPlan ?? []).find((entry) => entry.action === action)?.requestedTarget
          const resolvedTarget = planTarget ?? item.requestedTarget ?? {}
          expect(authorizeMutationFromProjection(projection, {
            action, contractItemId: item.id, contractItemRevision: item.revision, resolvedTarget,
          } as never).status, `${text} / ${action}`).not.toBe('authorized')
        }
      }
    }
  })
  it('preparation refuses the same item the gate refuses', async () => {
    const projection = createProjection()
    projection.enabled = true
    const derived = derive(['How do I install foo and restart service api safely?'])
    const item = [...derived.items.values()][0]!
    projection.items.set(item.id, item)
    const prepared = await createPrepareTool({ getProjection: () => projection }).execute({
      item_id: item.id, semantic_action: 'restart', requested_target: item.requestedTarget ?? {},
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(prepared.compatibility.status).not.toBe('compatible')
  })
  it.each([
    // An investigation whose complement states a state question coordinates two
    // orders; the second keeps its own execution authority (reviews 2/5/6). The
    // English shape whose complement's head is a vocabulary verb ("an update
    // exists") is UNDECIDED since the twelfth review, so it is asserted as a
    // visible obligation instead.
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
  it('a question that merely stands beside an order still keeps the order', () => {
    for (const text of ['What changed and archive the logs?', '什么变了并归档日志？']) {
      const projection = derive([text])
      expect([...projection.items.values()].some((item) => item.status === 'pending' && item.authorityDisposition !== 'informational'), text).toBe(true)
    }
  })
  it('an explicitly separate instruction after a question is still authority', () => {
    const projection = derive(['Help me understand the deploy. Then restart service api.'])
    const restart = [...projection.items.values()].find((item) => item.semanticAction === 'restart')
    expect(restart?.authorityDisposition).toBe('executable_now')
  })
})