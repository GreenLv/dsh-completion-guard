import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { interpretMessage } from '../../src/domain/semantics.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import type { DerivedEnvelope } from '../../src/domain/types.js'

/**
 * The EIGHTH independent review's counterexamples, kept as regressions.
 *
 * The review found that the explanation scope was still PATTERN-based: it needed
 * `to <verb>` and a fixed character window, so a finite complement
 * (`how I can …`), a `whether` complement, or a longer object let the scope
 * escape and the coordinated action became authority again. It also tightened one
 * control: `and then` can belong to the operation order BEING EXPLAINED, so it
 * must not be read as an actual instruction; an authorization positive control
 * has to be an explicitly separate instruction.
 *
 * The repair is structural: an explanation head governs its SENTENCE, and the
 * coordination belongs to the explanation exactly when the complement is still
 * open at the coordinator — an infinitive or a modal in English (`how to …`,
 * `how I can …`, `whether I should …`), a manner interrogative in Chinese
 * (如何/怎么/怎样). A bare wh-clause followed by a coordinator opens a new
 * predicate and keeps its order (`Tell me what changed and install the package.`),
 * and a sentence end always starts a new clause.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-review8', createdAt: 1 } }

let seq = 0
function derive(text: string) {
  seq = 0
  const events: DerivedEnvelope[] = [{
    seq: seq++, type: 'user/message', data: {
      source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' },
      content: [{ type: 'text', text: PROTOCOL_V5_NOTICE }],
    },
  }, { seq: seq++, type: 'turn/start', data: { turn: 1 } },
  { seq: seq++, type: 'user/message', data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text }] } },
  { seq: seq++, type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '收到。' }] } } },
  { seq: seq++, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }]
  return deriveProjection(events, config, scope, true).projection
}

describe('review 8 / F1: the explanation scope is the sentence, not a pattern', () => {
  it.each([
    // The three shapes the review returned: a finite complement, a whether
    // complement, and an object longer than any window.
    'Explain how I can install foo and restart service api.',
    'Explain whether I should install foo and restart service api.',
    'Explain how to install the optional development package with its recommended configuration and restart service api.',
    // The shapes that already worked must keep working.
    'Explain how to install foo and restart service api.',
    'Show me how to deploy the service and restart service api.',
    '解释一下如何安装并重启服务。',
  ])('%s creates no execution obligation and authorizes nothing', (text) => {
    const projection = derive(text)
    const items = [...projection.items.values()]
    expect(items.length, text).toBeGreaterThan(0)
    for (const item of items) {
      expect(item.authorityDisposition, text).not.toBe('executable_now')
      expect(authorizeMutationFromProjection(projection, {
        action: 'restart', contractItemId: item.id, contractItemRevision: item.revision,
        resolvedTarget: { service_id: 'api' },
      }).status, text).not.toBe('authorized')
    }
  })

  it('an explicitly separate instruction is still authority', async () => {
    for (const text of [
      'Explain how to deploy. Then restart service api.',
      '解释一下部署流程。然后重启 api 服务。',
    ]) {
      const projection = derive(text)
      const restart = [...projection.items.values()].find((item) => item.semanticAction === 'restart')
      expect(restart, JSON.stringify([...projection.items.values()].map((i) => [i.normalizedText, i.authorityDisposition]))).toBeDefined()
      expect(restart!.authorityDisposition).toBe('executable_now')
      const prepared = await createPrepareTool({ getProjection: () => projection }).execute({
        item_id: restart!.id, semantic_action: 'restart', requested_target: { service_id: 'api' },
      } as never, undefined as never) as { compatibility: { status: string } }
      expect(prepared.compatibility.status).toBe('compatible')
    }
  })

  it.each([
    // While the complement is open, a coordinator — "and then" included —
    // describes the operation order being explained, so it is not authority.
    'Explain how to deploy and then restart service api.',
    'Explain how to install foo, then restart service api.',
  ])('%s stays one explanation', (text) => {
    const projection = derive(text)
    expect([...projection.items.values()].every((item) => item.authorityDisposition !== 'executable_now'), JSON.stringify([...projection.items.values()].map((i) => [i.normalizedText, i.authorityDisposition]))).toBe(true)
    for (const item of projection.items.values()) {
      expect(authorizeMutationFromProjection(projection, {
        action: 'restart', contractItemId: item.id, contractItemRevision: item.revision,
        resolvedTarget: { service_id: 'api' },
      }).status).not.toBe('authorized')
    }
  })

  it.each([
    ['Tell me what changed and install the package.', 'install'],
    ['Explain the issue, sanitize all inputs.', 'sanitize'],
  ])('%s opens a new predicate: the order survives', (text, needle) => {
    const scopes = interpretMessage(text)
    const work = scopes.filter((entry) => entry.authorityDisposition !== 'informational').map((entry) => entry.text).join('｜')
    expect(work, text).toContain(needle)
  })

  it('an explanation of a quoted command is not information', () => {
    const scopes = interpretMessage('Explain `git push`.')
    expect(scopes.some((entry) => entry.authorityDisposition === 'informational')).toBe(false)
  })
})
