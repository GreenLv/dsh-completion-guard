import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { interpretMessage } from '../../src/domain/semantics.js'
import { isExplanationScope } from '../../src/domain/semantics.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection } from '../../src/domain/types.js'
import type { DerivedEnvelope } from '../../src/domain/types.js'

/**
 * The NINTH independent review's counterexamples, kept as regressions.
 *
 * The review found that the explanation scope was STILL keyed on words: the
 * open-complement test looked for `to` or a modal, so
 * `Explain how you install foo and restart service api.` — a finite complement
 * with neither — escaped it and the restart became authority. It stated the rule
 * that closes the family: **only proof that an action has LEFT the explanation's
 * scope may grant execution authority; a protection pattern that did not match is
 * never that proof.**
 *
 * The repair is structural on both sides:
 * - a sentence an explanation heads is decided as ONE scope, before any
 *   partition, and it is `unresolved` (not information, not instruction) whenever
 *   a coordinated part carries an action of its own (`isExplanationScope`);
 * - the mutation gate and preparation refuse such an item as a LAST RESORT, so
 *   every earlier refusal keeps reporting the reason it always did, and an
 *   `unresolved` clause that is NOT an explanation's scope keeps the behaviour it
 *   always had (an unrecognised instruction form is still judged on its action
 *   and target).
 *
 * Authority now requires proof: an explicitly separate instruction — its own
 * sentence — in English and in Chinese.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/repo-a', sessionHeader: { version: 3, id: 'v063-review9', createdAt: 1 } }

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

/** Every action the item's plan names, decided against its own target. */
function decisions(projection: ReturnType<typeof derive>) {
  const out: Array<{ action: string; status: string }> = []
  for (const item of projection.items.values()) {
    for (const action of [item.semanticAction, ...(item.actionPlan ?? []).map((entry) => entry.action)]) {
      if (!action || action === 'generic_run') continue
      const resolvedTarget = action === 'restart' ? { service_id: 'api' }
        : action === 'install' || action === 'apply' ? { package_id: 'foo', version: '0.6.3', profile: 'default' }
          : {}
      out.push({
        action,
        status: authorizeMutationFromProjection(projection, {
          action, contractItemId: item.id, contractItemRevision: item.revision, resolvedTarget,
        } as never).status,
      })
    }
  }
  return out
}

describe('review 9 / F1: only proof of leaving the explanation grants authority', () => {
  it.each([
    // The two shapes the review returned.
    'Explain how you install foo and restart service api.',
    'Explain why we install foo and restart service api.',
    // The shapes earlier rounds fixed must keep holding.
    'Explain how I can install foo and restart service api.',
    'Explain how to install foo and restart service api.',
    'Describe installing foo and restarting service api.',
    '解释一下如何安装并重启服务。',
  ])('%s is one undecided obligation that authorizes nothing', (text) => {
    const projection = derive([text])
    const items = [...projection.items.values()]
    expect(items.length, text).toBe(1)
    expect(items[0]!.authorityDisposition, text).toBe('unresolved')
    for (const decision of decisions(projection)) {
      expect(decision.status, `${text} / ${decision.action}`).not.toBe('authorized')
    }
  })

  it.each([
    // Proof of a separate instruction: its own sentence.
    'Explain how I can install foo. Then restart service api.',
    'Explain how the team deploys. Then restart service api.',
    '解释一下部署流程。然后重启 api 服务。',
  ])('%s still authorizes the separate instruction', async (text) => {
    const projection = derive([text])
    const restart = [...projection.items.values()].find((item) => item.semanticAction === 'restart')
    expect(restart, JSON.stringify([...projection.items.values()].map((i) => [i.normalizedText, i.authorityDisposition]))).toBeDefined()
    expect(restart!.authorityDisposition).toBe('executable_now')
    expect(authorizeMutationFromProjection(projection, {
      action: 'restart', contractItemId: restart!.id, contractItemRevision: restart!.revision,
      resolvedTarget: { service_id: 'api' },
    }).status).not.toBe('denied')
    const prepared = await createPrepareTool({ getProjection: () => projection }).execute({
      item_id: restart!.id, semantic_action: 'restart', requested_target: { service_id: 'api' },
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(prepared.compatibility.status).toBe('compatible')
  })

  it('the rule is scoped to explanations: an unrecognised instruction form keeps its path', () => {
    // The root's explicit restatement ("把应用包 … 明确为 apply") is a DIRECTIVE with
    // an unrecognised operation word, not an explanation: its reading is granted, and
    // the gate still judges the action and target exactly as before instead of
    // refusing on the disposition. 合同调整: the bare `应用包 …` form lost its
    // grant when the qualification became a positive director finding.
    const projection = derive(['把应用包 foo 版本 0.6.3 配置档 default 明确为 apply'])
    const item = [...projection.items.values()][0]!
    expect(item.authorityDisposition).toBe('unresolved')
    expect(isExplanationScope(item.normalizedText)).toBe(false)
    expect(authorizeMutationFromProjection(projection, {
      action: 'apply', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { package_id: 'foo', version: '0.6.3', profile: 'default' },
    }).status).not.toBe('denied')
  })

  it('a question beside an order keeps the order', () => {
    for (const text of ['What changed and archive the logs?', '什么变了并归档日志？']) {
      const scopes = interpretMessage(text)
      expect(scopes.some((entry) => entry.authorityDisposition !== 'informational'), text).toBe(true)
    }
  })

  it('a pure reported question keeps its closable lane', () => {
    // No action residue inside the explanation's sentence, so it stays an
    // answerable information request.
    const projection = derive(['Tell me what changed in the build and why.'])
    const item = [...projection.items.values()][0]!
    expect(isExplanationScope(item.normalizedText)).toBe(false)
    expect(item.authorityDisposition).toBe('informational')
  })

  it('an explanation of a quoted command stays undecidable', () => {
    const projection = derive(['Explain `git rebase`.'])
    const item = [...projection.items.values()][0]!
    expect(item.authorityDisposition).toBe('unresolved')
    // 合同调整: the restriction flag is now the qualification the gate consumes, so an
    // explanation of a quoted command reports the restricted scope it always was
    // (undecidable, and authorizing nothing).
    expect(isExplanationScope(item.normalizedText)).toBe(true)
  })

  it('preparation refuses the same explanation the gate refuses', async () => {
    const projection = createProjection()
    projection.enabled = true
    const derived = derive(['Explain how you install foo and restart service api.'])
    const item = [...derived.items.values()][0]!
    projection.items.set(item.id, item)
    const prepared = await createPrepareTool({ getProjection: () => projection }).execute({
      item_id: item.id, semantic_action: 'restart', requested_target: { service_id: 'api' },
    } as never, undefined as never) as { status: string; reason_code?: string; compatibility: { status: string } }
    expect(prepared.compatibility.status).not.toBe('compatible')
    expect(authorizeMutationFromProjection(projection, {
      action: 'restart', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { service_id: 'api' },
    }).status).toBe('denied')
  })
})
