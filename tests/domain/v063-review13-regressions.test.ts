import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { interpretMessage, isQuestionScopeNeedingReview } from '../../src/domain/semantics.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection } from '../../src/domain/types.js'
import type { DerivedEnvelope } from '../../src/domain/types.js'
import { expectNarrowedUndecided } from './narrowed-contract.js'

/**
 * The THIRTEENTH independent review's counterexamples, kept as regressions.
 *
 * Two lines of attack, one root cause: the scope still needed evidence the surface
 * cannot supply. The complement only closed when a KNOWN action predicate was
 * recognised (`archive`/`归档`/`bootstrap` were not) or when the Chinese subject
 * stood in the one position the rule expected (before the subordinator — "是否有人
 * 安装…" and "是否由运维人员安装…" put it after).
 *
 * The rule is therefore inverted: an investigation's complement GOVERNS by default,
 * and closing it requires positive proof that the question is about a STATE — the
 * subordinator opens the complement, no actor of its own stands on either side of
 * it, no modal or infinitive governs an action there, and the complement names a
 * state. An unrecognised predicate, an unmatched subject position, or any other
 * absence of a protection pattern is never proof that the complement closed.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/repo-a', sessionHeader: { version: 3, id: 'v063-review13', createdAt: 1 } }

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

describe('review 13 / F1: an unrecognised predicate is not proof that the complement closed', () => {
  it.each([
    'Check whether the operators archive the logs and restart service api.',
    'Check whether the operators bootstrap the environment and restart service api.',
    '检查运维人员是否归档日志并重启 api 服务。',
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
})

describe('review 13 / F2: the subject position after the subordinator is still a subject', () => {
  it.each([
    '确认是否有人安装 foo 并重启 api 服务。',
    '检查是否由运维人员安装 foo 并重启 api 服务。',
  ])('%s is one undecided obligation that authorizes nothing', (text) => {
    const projection = derive([text])
    const items = [...projection.items.values()]
    expect(items.length, text).toBe(1)
    expect(items[0]!.authorityDisposition, text).toBe('unresolved')
    for (const decision of authorizations(projection)) {
      expect(decision.endsWith(':authorized'), `${text} / ${decision}`).toBe(false)
    }
  })

  it('preparation refuses the same items', async () => {
    for (const text of [
      'Check whether the operators archive the logs and restart service api.',
      '检查是否由运维人员安装 foo 并重启 api 服务。',
    ]) {
      const projection = createProjection()
      projection.enabled = true
      const derived = derive([text])
      const item = [...derived.items.values()][0]!
      projection.items.set(item.id, item)
      const prepared = await createPrepareTool({ getProjection: () => projection }).execute({
        item_id: item.id, semantic_action: item.semanticAction ?? 'install',
        requested_target: item.requestedTarget ?? {},
      } as never, undefined as never) as { compatibility: { status: string } }
      expect(prepared.compatibility.status, text).not.toBe('compatible')
    }
  })
})

describe('review 13 / positive proof: a state question keeps its second order', () => {
  it.each([
    ['检查是否有新版本并且安装这个主题。', '安装这个主题'],
    ['确认缓存是否有效并安装依赖。', '安装依赖'],
    ['Verify whether the lock file is current and install the package.', 'install the package'],
  ])('%s keeps its coordinated order', (text, _needle) => {
    // 合同调整 (0.6.3 收窄合同): the coordinated action stays one undecided
    // obligation and is no longer auto-authorized.
    expectNarrowedUndecided(text)
  })

  it('a coordination-free verification stays answerable', () => {
    for (const text of ['Check that the migration completed.', '检查运维人员是否轮换密钥。']) {
      const scopes = interpretMessage(text)
      expect(scopes.some((entry) => entry.authorityDisposition === 'informational'), JSON.stringify(scopes.map((entry) => [entry.authorityDisposition, entry.text]))).toBe(true)
    }
  })

  it('an explicitly separate instruction is still authority', () => {
    const projection = derive(['Check whether the operators archive the logs. Then restart service api.'])
    const restart = [...projection.items.values()].find((item) => item.normalizedText.includes('restart service api'))
    expect(restart?.authorityDisposition).toBe('executable_now')
  })
})
