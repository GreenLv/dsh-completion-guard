import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { captureClause } from '../../src/domain/capture.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope } from '../../src/domain/types.js'

/**
 * The fourth independent review's counterexamples, kept as regressions.
 *
 * Three defects were returned:
 *
 * 1. a purpose clause behind an action word OUTSIDE the vocabulary ("Archive
 *    /tmp/logs to show what changed", "Compress /tmp/logs to check the status")
 *    was still read as the clause's question, because the gate needed a known
 *    verb to locate the head. The repaired gate is structural: a question word
 *    behind a `to <verb>` span, a relative pronoun, a participle or a
 *    prepositional opener belongs to that span, whatever the main verb is;
 * 2. preparation still made the authorizing predicate a tautology by passing the
 *    caller's target as BOTH the obligation's selection and the resolved target;
 * 3. an `if` inside a purpose clause ("Create /tmp/check.sh to determine if the
 *    service is running") was read as a condition on the creation.
 *
 * Positive controls are included so the structural rule cannot over-reach: a
 * question with no subordinate span still asks, and a real conditional order is
 * still conditional.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-review4', createdAt: 1 } }

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

const itemsOf = (texts: string[]) => [...derive(texts).items.values()]

describe('review 4 / P1: an out-of-vocabulary action still owns its purpose clause', () => {
  it.each([
    'Archive /tmp/logs to show what changed.',
    'Compress /tmp/logs to check the status.',
    'Rotate /tmp/logs to see what failed.',
    'Sync /tmp/data to determine which rows differ.',
  ])('%s keeps its obligation', (text) => {
    const items = itemsOf([text])
    expect(items.length, text).toBeGreaterThan(0)
    for (const item of items) {
      expect(item.authorityDisposition, text).not.toBe('informational')
      expect(item.status, text).toBe('pending')
    }
  })

  it('an unknown main verb is never silently promoted to information', () => {
    // The obligation is preserved conservatively; the reading may be unresolved,
    // which is exactly the required fail-closed direction.
    for (const text of ['Archive /tmp/logs to show what changed.', 'Rotate /tmp/logs for reporting.']) {
      const items = itemsOf([text])
      expect(items.every((item) => item.status !== 'answered'), text).toBe(true)
    }
  })

  it.each([
    'Check whether an update exists.',
    'Check if the package is installed.',
    'Tell me what changed in the build and why.',
    'What changed in the build?',
  ])('%s still asks, because no subordinate span precedes its question', (text) => {
    const items = itemsOf([text])
    for (const item of items) expect(item.authorityDisposition, text).not.toBe('executable_now')
  })
})

describe('review 4 / P2: a caller cannot supply the authority the root withheld', () => {
  it('a caller-supplied branch does not authorize an item that named only its repository', async () => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause('提交仓库 /repo-b。', 'm1', 'R001', 1, { cwd: '/repo-a' })
    projection.items.set(item.id, item)
    expect(item.requestedTarget).toMatchObject({ repository: '/repo-b' })
    expect(item.requestedTarget?.branch).toBeUndefined()
    const target = { repository: '/repo-b', branch: 'main' }
    const prepared = await createPrepareTool({ getProjection: () => projection }).execute(
      { item_id: item.id, semantic_action: 'commit', requested_target: target } as never, undefined as never,
    ) as { compatibility: { status: string } }
    expect(prepared.compatibility.status).not.toBe('compatible')
    expect(prepared.compatibility.status).toBe('blocked')
    expect(authorizeMutationFromProjection(projection, {
      action: 'commit', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: target as Parameters<typeof authorizeMutationFromProjection>[1]['resolvedTarget'],
    })).toMatchObject({ status: 'denied' })
  })

  it('an item that DID name the branch is authorizable from the caller target', async () => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause('提交仓库 /repo-b 分支 main。', 'm1', 'R001', 1, { cwd: '/repo-a' })
    projection.items.set(item.id, item)
    const target = { repository: '/repo-b', branch: 'main' }
    const prepared = await createPrepareTool({ getProjection: () => projection }).execute(
      { item_id: item.id, semantic_action: 'commit', requested_target: target } as never, undefined as never,
    ) as { compatibility: { status: string } }
    expect(prepared.compatibility.status).toBe('compatible')
    expect(authorizeMutationFromProjection(projection, {
      action: 'commit', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: target as Parameters<typeof authorizeMutationFromProjection>[1]['resolvedTarget'],
    }).status).not.toBe('denied')
  })

  it('the two lanes agree for every combination of complete and incomplete selectors', async () => {
    const shapes: Array<[string, string, Record<string, unknown>]> = [
      ['提交仓库 /repo-b 分支 main。', 'commit', { repository: '/repo-b', branch: 'main' }],
      ['提交仓库 /repo-b 分支 main。', 'commit', { repository: '/repo-b', branch: 'other' }],
      ['提交仓库 /repo-b。', 'commit', { repository: '/repo-b', branch: 'main' }],
      ['推送仓库 /repo-b remote upstream refspec refs/heads/main。', 'push', { repository: '/repo-b', remote: 'upstream', refspec: 'refs/heads/main' }],
      ['重启 synthetic 服务。', 'restart', { service_id: 'synthetic' }],
    ]
    for (const [text, action, target] of shapes) {
      const projection = createProjection()
      projection.enabled = true
      const item = captureClause(text, 'm1', 'R001', 1, { cwd: '/repo-a' })
      projection.items.set(item.id, item)
      const prepared = await createPrepareTool({ getProjection: () => projection }).execute(
        { item_id: item.id, semantic_action: action, requested_target: target } as never, undefined as never,
      ) as { compatibility: { status: string } }
      const decision = authorizeMutationFromProjection(projection, {
        action: action as never, contractItemId: item.id, contractItemRevision: item.revision,
        resolvedTarget: target as Parameters<typeof authorizeMutationFromProjection>[1]['resolvedTarget'],
      })
      const status = prepared.compatibility.status
      if (status === 'incompatible' || status === 'blocked') {
        expect(decision.status, `${text} ${action}`).toBe('denied')
      }
      if (status === 'compatible') expect(decision.status, `${text} ${action}`).not.toBe('denied')
    }
  })
})

describe('review 4 / P2: an interrogative inside a purpose clause is not a condition', () => {
  it.each([
    'Create /tmp/check.sh to determine if the service is running.',
    'Create /tmp/check.sh to check whether the service is running.',
    'Write /tmp/probe.sh to determine when the cache expires.',
    '创建 /tmp/check.sh 用来确定服务是否在运行。',
  ])('%s orders the creation unconditionally', (text) => {
    const items = itemsOf([text])
    expect(items.length, text).toBeGreaterThan(0)
    for (const item of items) {
      expect(item.authorityDisposition, text).not.toBe('conditional_wait')
      expect(item.authorityDisposition, text).not.toBe('informational')
      expect(item.status, text).toBe('pending')
    }
  })

  it('a real conditional order is still conditional', () => {
    for (const text of ['Deploy the build if the smoke test passes.', 'Restart the service once the migration finishes.']) {
      const items = itemsOf([text])
      expect(items.length, text).toBeGreaterThan(0)
      expect(items.some((item) => item.authorityDisposition === 'conditional_wait' || item.status === 'pending'), text).toBe(true)
      for (const item of items) expect(item.authorityDisposition, text).not.toBe('informational')
    }
  })

  it('a Chinese purpose marker also stops the condition reading', () => {
    const items = itemsOf(['创建 /tmp/check.sh 用来确定服务是否在运行。'])
    expect(items.every((item) => item.authorityDisposition !== 'conditional_wait')).toBe(true)
  })
})
