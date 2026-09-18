import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { captureClause } from '../../src/domain/capture.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope, type GuardItem } from '../../src/domain/types.js'

/**
 * The third independent review's counterexamples, kept as regressions.
 *
 * Three defects were returned:
 *
 * 1. an English PURPOSE clause behind the action ("Create a file /tmp/status.txt
 *    TO SHOW what changed", "Create a script … TO CHECK the status") was read as
 *    the clause's own question, because `REPORTED_QUESTION` and
 *    `INVESTIGATION_OF_STATE` matched anywhere in the clause;
 * 2. a `Please` preface moved the verb's character position past its own length
 *    in `interrogativeTakesIfObject`, so `Please check if …` fell back to the
 *    condition splitter;
 * 3. preparation stopped comparing the SUPPLIED target and compared the
 *    obligation's target with itself, so a different target read compatible
 *    while the gate denied it.
 *
 * The reviewer's cases and expectations are kept here in this repository's
 * typing, plus the positive controls that keep the repairs from over-reaching.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/repo-a', sessionHeader: { version: 3, id: 'v063-review3', createdAt: 1 } }

let seq = 0
function derive(texts: string[]) {
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

const itemsOf = (texts: string[]) => [...derive(texts).items.values()]

describe('review 3 / P1: a purpose or relative clause never makes the clause a question', () => {
  it.each([
    'Create a file /tmp/status.txt to show what changed.',
    'Create a script /tmp/check.sh to check the status.',
  ])('%s keeps the creation obligation open', (text) => {
    const items = itemsOf([text])
    expect(items.some((item) => item.status === 'pending' && item.authorityDisposition !== 'informational'), text).toBe(true)
    for (const item of items) expect(item.authorityDisposition, text).not.toBe('informational')
  })

  it.each([
    'Create a file /tmp/status.txt to explain how the build works.',
    'Write a note /tmp/n.txt to describe which service failed.',
    'Generate a script /tmp/s.sh to determine when the cache expires.',
    'Create a file /tmp/x.txt to show whether the tests passed.',
  ])('%s is work in every purpose-clause variant', (text) => {
    const items = itemsOf([text])
    expect(items.length, text).toBeGreaterThan(0)
    for (const item of items) expect(item.authorityDisposition, text).not.toBe('informational')
  })

  it.each([
    'Tell me what changed in the build and why.',
    'Explain whether the cache is warm.',
    'Show me which service failed.',
    'Check if the package is installed.',
    'Check whether an update exists.',
  ])('%s is still a genuine question', (text) => {
    const items = itemsOf([text])
    // The question is captured as information or dropped as session talk; it is
    // never recorded as execution work.
    for (const item of items) expect(item.authorityDisposition, text).not.toBe('executable_now')
  })

  it('a purpose clause attached to an order stays one order', () => {
    const items = itemsOf(['Create a script /tmp/check.sh to check the status.'])
    expect(items).toHaveLength(1)
    expect(items[0]!.semanticAction).toBe('create')
    expect(items[0]!.status).toBe('pending')
  })
})

describe('review 3 / P2: a request preface never changes the reading', () => {
  it.each([
    'Please check if the package is installed.',
    'please check whether the package is installed.',
    'Please verify if the build passed.',
    'Please confirm whether the deploy finished.',
    'Please check when the cache was last warmed.',
    'Check if the package is installed.',
  ])('%s is an information request, not a conditional wait', (text) => {
    const items = itemsOf([text])
    for (const item of items) {
      expect(item.authorityDisposition, text).not.toBe('conditional_wait')
      expect(item.authorityDisposition, text).not.toBe('executable_now')
    }
  })

  it('the same check WITHOUT a preface reads the same way', () => {
    const withPreface = itemsOf(['Please check if the package is installed.'])
    const without = itemsOf(['Check if the package is installed.'])
    expect(withPreface.map((item) => item.authorityDisposition))
      .toEqual(without.map((item) => item.authorityDisposition))
  })

  it('a preface in front of a real order still leaves an order', () => {
    const items = itemsOf(['Please install the package if available.'])
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((item) => item.authorityDisposition !== 'informational')).toBe(true)
    expect(items.some((item) => item.status === 'pending')).toBe(true)
  })
})

describe('review 3 / P2: the two lanes compare the SAME supplied target', () => {
  const withItem = (text: string) => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause(text, 'm1', 'R001', 1, { cwd: '/repo-a' })
    projection.items.set(item.id, item)
    return { projection, item }
  }
  const prepareWith = async (projection: ReturnType<typeof createProjection>, item: GuardItem, action: string, target?: Record<string, unknown>) =>
    createPrepareTool({ getProjection: () => projection }).execute(
      { item_id: item.id, semantic_action: action, ...(target === undefined ? {} : { requested_target: target }) } as never,
      undefined as never,
    ) as Promise<Record<string, unknown>>
  const gateWith = (projection: ReturnType<typeof createProjection>, item: GuardItem, action: string, target: Record<string, unknown>) =>
    authorizeMutationFromProjection(projection, {
      action: action as never, contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: target as Parameters<typeof authorizeMutationFromProjection>[1]['resolvedTarget'],
    })

  it('a different repository and branch is incompatible and denied', async () => {
    const { projection, item } = withItem('提交仓库 /repo-b 分支 main。')
    const target = { repository: '/repo-c', branch: 'release' }
    const prepared = await prepareWith(projection, item, 'commit', target)
    const compatibility = prepared.compatibility as { status: string; target_compatible: boolean }
    expect(compatibility.target_compatible).toBe(false)
    expect(compatibility.status).toBe('incompatible')
    expect(prepared.reason_code).toBe('requested_resolved_target_mismatch')
    expect(gateWith(projection, item, 'commit', target)).toMatchObject({ status: 'denied', reasonCode: 'mutation_requested_target_mismatch' })
  })

  it('the matching target is compatible and authorized', async () => {
    const { projection, item } = withItem('提交仓库 /repo-b 分支 main。')
    const target = { repository: '/repo-b', branch: 'main' }
    const prepared = await prepareWith(projection, item, 'commit', target)
    expect((prepared.compatibility as { status: string }).status).toBe('compatible')
    expect(gateWith(projection, item, 'commit', target).status).not.toBe('denied')
  })

  it('a target the gate cannot authorize is blocked, even when it is the item\\u2019s own', async () => {
    // A commit that names only its repository: the gate requires the branch, so
    // preparation reports blocked instead of compatible.
    const { projection, item } = withItem('提交仓库 /repo-b 的变更。')
    const prepared = await prepareWith(projection, item, 'commit')
    expect((prepared.compatibility as { status: string }).status).toBe('blocked')
    expect((prepared.compatibility as { reason_codes: string[] }).reason_codes).toContain('target_not_authorizing')
  })

  it('every preparation verdict agrees with the gate on the same inputs', async () => {
    const shapes: Array<[string, string, Record<string, unknown>]> = [
      ['提交仓库 /repo-b 分支 main。', 'commit', { repository: '/repo-b', branch: 'main' }],
      ['提交仓库 /repo-b 分支 main。', 'commit', { repository: '/repo-c', branch: 'main' }],
      ['提交仓库 /repo-b 分支 main。', 'commit', { repository: '/repo-b', branch: 'other' }],
      ['推送仓库 /repo-b remote upstream refspec refs/heads/main。', 'push', { repository: '/repo-b', remote: 'upstream', refspec: 'refs/heads/main' }],
      ['推送仓库 /repo-b remote upstream refspec refs/heads/main。', 'push', { repository: '/repo-c', remote: 'upstream', refspec: 'refs/heads/main' }],
      ['重启 synthetic 服务。', 'restart', { service_id: 'synthetic' }],
    ]
    for (const [text, action, target] of shapes) {
      const { projection, item } = withItem(text)
      const prepared = await prepareWith(projection, item, action, target)
      const status = (prepared.compatibility as { status: string }).status
      const decision = gateWith(projection, item, action, target)
      if (status === 'incompatible') expect(decision.status, `${text} ${action}`).toBe('denied')
      if (status === 'compatible') expect(decision.status, `${text} ${action}`).not.toBe('denied')
    }
  })
})
