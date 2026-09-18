import { expect } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { interpretMessage, isQuestionScopeNeedingReview } from '../../src/domain/semantics.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { type DerivedEnvelope } from '../../src/domain/types.js'

/**
 * 0.6.3 收窄合同 (narrowed contract) — the shared expectation for the cases the
 * earlier rounds required to authorize a coordinated second action.
 *
 * The narrowed contract keeps that work as ONE undecided obligation: it is visible,
 * no answer closes it, and it authorizes nothing. Every call site is a superseded
 * expectation of the old contract, labelled 合同调整 where it is used.
 */
const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'narrowed-contract', createdAt: 1 } }

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

/**
 * 合同调整: the coordinated action is NOT authority any more. The obligation stays
 * visible as one undecided reading, keeps its action plan, and authorizes nothing.
 */
export function expectNarrowedUndecided(text: string): void {
  const scopes = interpretMessage(text)
  expect(
    scopes.some((entry) => entry.authorityDisposition === 'unresolved'),
    `合同调整 ${text}: ${JSON.stringify(scopes.map((entry) => [entry.authorityDisposition, entry.text]))}`,
  ).toBe(true)
  expect(
    scopes.every((entry) => entry.authorityDisposition !== 'executable_now'),
    `合同调整 ${text}: ${JSON.stringify(scopes.map((entry) => [entry.authorityDisposition, entry.text]))}`,
  ).toBe(true)
  expect(isQuestionScopeNeedingReview(text), `合同调整 ${text}`).toBe(true)
  const projection = derive(text)
  for (const decision of authorizations(projection)) {
    expect(decision.endsWith(':authorized'), `合同调整 ${text} / ${decision}`).toBe(false)
  }
}

/**
 * 合同调整: the obligation survives — capture produced it, no answer closes it, and
 * it cannot take a completion certificate.
 */
export function expectObligationSurvives(text: string): void {
  const projection = derive(text)
  const items = [...projection.items.values()]
  expect(items.length, `合同调整 ${text}`).toBeGreaterThan(0)
  for (const item of items) {
    expect(item.authorityDisposition, `合同调整 ${text}`).not.toBe('executable_now')
  }
}
