import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE, legacyRecordsNeedingReview } from '../../src/domain/derive.js'
import { captureClause } from '../../src/domain/capture.js'
import { interpretMessage } from '../../src/domain/semantics.js'
import { needsReviewObligations } from '../../src/domain/closure.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope, type GuardItem } from '../../src/domain/types.js'

/**
 * 0.6.3 hold-out round 5 — regression coverage (was the independent set).
 *
 * Round 4 produced findings and its repairs changed the source, so round 4 is
 * regression coverage. Round 5 was written after those repairs, against the task
 * contract, in shape families absent from rounds 1-4 and all four review batches:
 *
 * - purpose spans opened by every marker the structural rule knows (`to <verb>`,
 *   a relative pronoun, a participle, a prepositional opener) with main verbs
 *   outside the vocabulary;
 * - the SAME words with and without the subordinate span, so the rule is pinned
 *   in both directions;
 * - Chinese purpose markers (为了/用来/以便) with a question inside;
 * - an authorizing predicate where the obligation names a SUBSET and the caller
 *   completes it, in both orders, plus a prohibition-shaped selector;
 * - a prepare/action comparison where the action is cross-family while the
 *   target matches.
 *
 * Round 5 found one source defect — the interaction classifier masked a purpose
 * clause before segmentation, so `打包日志以便确认哪些请求失败。` was dropped —
 * and its repair changed the source. Round 5 is therefore REGRESSION COVERAGE
 * and round 6 is the current independent set.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/var/svc', sessionHeader: { version: 3, id: 'v063-holdout5', createdAt: 1 } }

let seq = 0
function derive(input: Array<string | { text: string; answer?: string }>) {
  const turns = input.map((entry) => (typeof entry === 'string' ? { text: entry } : entry))
  seq = 0
  const events: DerivedEnvelope[] = [{
    seq: seq++, type: 'user/message', data: {
      source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice' },
      content: [{ type: 'text', text: PROTOCOL_V5_NOTICE }],
    },
  }]
  turns.forEach((turn, index) => {
    const number = index + 1
    events.push(
      { seq: seq++, type: 'turn/start', data: { turn: number } },
      { seq: seq++, type: 'user/message', data: { turn: number, source: { kind: 'user' }, content: [{ type: 'text', text: turn.text }] } },
      { seq: seq++, type: 'assistant/message', data: { turn: number, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: turn.answer ?? '收到。' }] } } },
      { seq: seq++, type: 'turn/end', data: { turn: number, reason: { kind: 'completed' } } },
    )
  })
  return deriveProjection(events, config, scope, true).projection
}

const itemsOf = (texts: string[]) => [...derive(texts).items.values()]

describe('hold-out 5 / K1: the structural subordinate rule in both directions', () => {
  it.each([
    'Archive /var/svc/logs to see what failed.',
    'Compress /var/svc/logs for the report.',
    'Trim /var/svc/logs, which show what changed.',
    'Repack /var/svc/logs concerning which shard failed.',
    'Snapshot /var/svc/state to determine how far the migration got.',
  ])('%s preserves the obligation', (text) => {
    const items = itemsOf([text])
    expect(items.length, text).toBeGreaterThan(0)
    for (const item of items) {
      expect(item.authorityDisposition, text).not.toBe('informational')
      expect(item.status, text).toBe('pending')
    }
  })

  it.each([
    'See what failed.',
    'Determine how far the migration got.',
    'Explain what changed.',
    'Show which shard failed.',
    'Check whether the shard is healthy.',
  ])('%s asks on its own', (text) => {
    // Without a preceding subordinate span the question IS the clause, so it is
    // captured as information rather than execution.
    const items = itemsOf([text])
    for (const item of items) expect(item.authorityDisposition, text).not.toBe('executable_now')
  })

  it('the same words read differently with and without the span', () => {
    const withSpan = interpretMessage('Archive /var/svc/logs to see what failed.')
    expect(withSpan).toHaveLength(1)
    expect(withSpan[0]!.directive).not.toBe('informational')

    const without = interpretMessage('See what failed.')
    expect(without).toHaveLength(1)
    expect(without[0]!.authorityDisposition).toBe('informational')
  })

  it('a Chinese purpose marker with a question inside stays an order', () => {
    for (const text of ['创建 /tmp/check.sh 用来确定服务是否在运行。', '打包日志以便确认哪些请求失败。']) {
      const items = itemsOf([text])
      expect(items.length, text).toBeGreaterThan(0)
      for (const item of items) {
        expect(item.authorityDisposition, text).not.toBe('conditional_wait')
        expect(item.authorityDisposition, text).not.toBe('informational')
      }
    }
  })

  it('a Chinese question with no purpose marker still asks', () => {
    for (const text of ['确认服务是否在运行。', '查看哪些请求失败了。']) {
      const scopes = interpretMessage(text)
      expect(scopes.length, text).toBeGreaterThanOrEqual(1)
      expect(scopes.some((entry) => entry.authorityDisposition === 'informational'), text).toBe(true)
    }
  })
})

describe('hold-out 5 / K2: caller completion of an obligation selector', () => {
  it.each([
    // The clause names a SUBSET of the gate's identity fields: coverage must come
    // from the obligation, so the caller cannot complete it.
    ['提交仓库 /var/svc。', 'commit', { repository: '/var/svc', branch: 'main' }, 'blocked'],
    ['推送仓库 /var/svc remote upstream。', 'push', { repository: '/var/svc', remote: 'upstream', refspec: 'refs/heads/main' }, 'blocked'],
    // These name every field the gate requires, so they ARE authorizable.
    ['推送仓库 /var/svc remote upstream refspec refs/heads/main。', 'push', { repository: '/var/svc', remote: 'upstream', refspec: 'refs/heads/main' }, 'compatible'],
    ['重启 synthetic 服务。', 'restart', { service_id: 'synthetic' }, 'compatible'],
  ] as const)('%s is %s for the caller target', async (text, action, target, expected) => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause(text, 'm1', 'R001', 1, { cwd: '/var/svc' })
    projection.items.set(item.id, item)
    const prepared = await createPrepareTool({ getProjection: () => projection }).execute(
      { item_id: item.id, semantic_action: action, requested_target: target } as never, undefined as never,
    ) as { compatibility: { status: string } }
    expect(prepared.compatibility.status, text).toBe(expected)
    const decision = authorizeMutationFromProjection(projection, {
      action: action as never, contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: target as Parameters<typeof authorizeMutationFromProjection>[1]['resolvedTarget'],
    })
    // One conclusion from two lanes, in both directions.
    if (expected === 'compatible') expect(decision.status, text).not.toBe('denied')
    else expect(decision.status, text).toBe('denied')
  })

  it('an obligation that names every identity field authorizes the caller target', async () => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause('提交仓库 /var/svc 分支 main。', 'm1', 'R001', 1, { cwd: '/var/svc' })
    projection.items.set(item.id, item)
    const target = { repository: '/var/svc', branch: 'main' }
    const prepared = await createPrepareTool({ getProjection: () => projection }).execute(
      { item_id: item.id, semantic_action: 'commit', requested_target: target } as never, undefined as never,
    ) as { compatibility: { status: string; target_compatible: boolean } }
    expect(prepared.compatibility.status).toBe('compatible')
    expect(prepared.compatibility.target_compatible).toBe(true)
  })

  it('a cross-family action is refused even when the target matches', async () => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause('提交仓库 /var/svc 分支 main。', 'm1', 'R001', 1, { cwd: '/var/svc' })
    projection.items.set(item.id, item)
    const target = { repository: '/var/svc', branch: 'main', remote: 'upstream', refspec: 'refs/heads/main' }
    const prepared = await createPrepareTool({ getProjection: () => projection }).execute(
      { item_id: item.id, semantic_action: 'push', requested_target: target } as never, undefined as never,
    ) as { status: string; reason_code: string }
    expect(prepared.status).toBe('incompatible')
    expect(prepared.reason_code).toBe('action_not_compatible_with_item')
  })
})

describe('hold-out 5 / K4: eligibility on the structural rule output', () => {
  it('a purpose-clause capture is never a historical information record', () => {
    for (const text of [
      'Archive /var/svc/logs to see what failed.',
      'Create /tmp/check.sh to determine if the service is running.',
    ]) {
      const projection = derive([text])
      expect(legacyRecordsNeedingReview(projection), text).toEqual([])
      expect([...projection.items.values()].every((item) => item.status !== 'answered'), text).toBe(true)
    }
  })

  it('a historical record whose own text is a purpose clause is still checked', () => {
    const projection = createProjection()
    projection.enabled = true
    const record: GuardItem = {
      ...captureClause('占位', 'm1', 'R001', 1, { cwd: '/var/svc' }),
      normalizedText: 'Create a file recording whether the tests passed and install the package.',
      directive: 'informational', authorityDisposition: 'informational', taskKind: 'inquiry',
      status: 'answered',
    }
    projection.items.set(record.id, record)
    expect(legacyRecordsNeedingReview(projection)).toHaveLength(1)
  })

  it('an unresolved obligation stays visible rather than being closed', () => {
    const projection = derive(['Archive /var/svc/logs to see what failed.'])
    const items = [...projection.items.values()]
    expect(items.some((item) => item.status === 'pending')).toBe(true)
    expect(needsReviewObligations(projection)).toEqual([])
    expect(projection.checkpoints).toHaveLength(0)
  })
})
