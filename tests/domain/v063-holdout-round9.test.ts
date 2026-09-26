import { describe, expect, it } from 'vitest'
import { deriveProjection, legacyRecordsNeedingReview, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { interpretMessage } from '../../src/domain/semantics.js'
import { captureClause } from '../../src/domain/capture.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope, type GuardItem } from '../../src/domain/types.js'

/**
 * 0.6.3 hold-out round 9 — regression coverage (was the independent set).
 *
 * Round 8 found nothing, but the SIXTH review then returned three counterexamples
 * against the same invariant (an execution residue must survive the question, the
 * punctuation and the abbreviation around it, and a name the root gave must not
 * be re-judged by its extension); those repairs changed the source, so round 8 is
 * regression coverage. Round 9 was written after the repairs, in shape families
 * absent from rounds 1-8, the six review batches and both repair sets:
 *
 * - the question-then-work invariant with further unknown verbs, further English
 *   question words, and the Chinese coordinated spelling with a KNOWN head;
 * - the abbreviation tie-breaker in three positions: a question after `e.g.`, a
 *   question after `etc.`, and an ordinary continuation that must stay whole;
 * - archive-style extensions on BOTH sides of the coordinator, and the same
 *   extension on a single repository;
 * - an install target that names its profile, judged with prepare and the gate;
 * - eligibility on an unpunctuated English legacy request and on its
 *   question-only control.
 *
 * It found nothing of its own, but the SEVENTH review then returned three
 * counterexamples (an explanation must not become authority, a prefaced question
 * must not close the execution before it, and inheritance must judge every field)
 * whose repairs changed the source, so it is REGRESSION COVERAGE now and round 10
 * is the current independent set. Its expectations were never revised.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-holdout9', createdAt: 1 } }

let seq = 0
function derive(input: Array<string | { text: string; answer?: string }>) {
  seq = 0
  const events: DerivedEnvelope[] = [{
    seq: seq++, type: 'user/message', data: {
      source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice' },
      content: [{ type: 'text', text: PROTOCOL_V5_NOTICE }],
    },
  }]
  input.forEach((entry, index) => {
    const turn = index + 1
    const text = typeof entry === 'string' ? entry : entry.text
    const answer = typeof entry === 'string' ? '收到。' : entry.answer ?? '收到。'
    events.push(
      { seq: seq++, type: 'turn/start', data: { turn } },
      { seq: seq++, type: 'user/message', data: { turn, source: { kind: 'user' }, content: [{ type: 'text', text }] } },
      { seq: seq++, type: 'assistant/message', data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: answer }] } } },
      { seq: seq++, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
    )
  })
  return deriveProjection(events, config, scope, true).projection
}

const itemsOf = (input: Array<string | { text: string; answer?: string }>) => [...derive(input).items.values()]

describe('hold-out 9 / K1: the execution residue survives every spelling of the question', () => {
  it.each([
    ['What broke and rotate the logs?', 'rotate the logs'],
    ['Why did it fail and compress the archives?', 'compress the archives'],
    ['Which shard failed, rotate the logs?', 'rotate the logs'],
  ] as const)('%s keeps %s', (text, needle) => {
    const items = itemsOf([text])
    expect(items.length, text).toBeGreaterThan(0)
    expect(items.some((item) => item.status === 'pending' && item.normalizedText.includes(needle)), JSON.stringify(items.map((i) => [i.normalizedText, i.status, i.authorityDisposition]))).toBe(true)
  })

  it.each([
    ['什么变了并运行测试？', '运行测试'],
    ['哪里出错了并重跑回归？', '重跑回归'],
  ] as const)('%s keeps the coordinated order', (text, needle) => {
    const scopes = interpretMessage(text)
    expect(scopes.some((entry) => entry.authorityDisposition !== 'informational' && entry.text.includes(needle)), JSON.stringify(scopes.map((entry) => [entry.authorityDisposition, entry.text]))).toBe(true)
  })

  it('the residue is still owed after the turn answers', () => {
    const items = itemsOf([{ text: 'What broke and rotate the logs?', answer: '收到。' }])
    expect(items.some((item) => item.normalizedText.includes('rotate the logs') && item.status === 'pending')).toBe(true)
  })
})

describe('hold-out 9 / K1: an abbreviation never widens the range a question delivers', () => {
  it.each([
    ['Deploy the build e.g. What changed?', 2],
    ['Install it etc. why did it fail?', 2],
    ['See e.g. the log for this run.', 1],
    ['Fix the bug. i.e. correct the parser.', 2],
  ] as const)('%s splits as the reading requires', (text, count) => {
    expect(interpretMessage(text), text).toHaveLength(count)
  })

  it('the deployment before the abbreviation stays owed', () => {
    const items = itemsOf([{ text: 'Deploy the build e.g. What changed?', answer: '收到。' }])
    expect(items.some((item) => item.normalizedText.includes('Deploy the build') && item.status === 'pending')).toBe(true)
  })
})

describe('hold-out 9 / K2: extensions on either side of the coordinator', () => {
  it.each([
    '提交仓库 /repo-a.js 与 /repo-b.js 分支 main。',
    '提交仓库 /repo-a.zip 或 /repo-b.zip。',
    '拉取仓库 /repo-a.py 和仓库 /repo-b.py remote origin。',
  ])('%s is a choice, not a selection', (text) => {
    const item = captureClause(text, 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus, text).toBe('clarification_required')
    expect(item.targetCaptureReasonCode, text).toBe('requested_target_repository_ambiguous')
  })

  it('the fields the clause named survive the ambiguity', () => {
    const item = captureClause('提交仓库 /repo-a.js 与 /repo-b.js 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.requestedTarget).toMatchObject({ branch: 'main' })
    expect(item.requestedTarget?.repository).toBeUndefined()
  })

  it('one repository with an extension is still one selection', () => {
    const item = captureClause('提交仓库 /repo-a.zip 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus).toBe('resolved')
    expect(item.requestedTarget).toMatchObject({ repository: '/repo-a.zip', branch: 'main' })
  })
})

describe('hold-out 9 / K3: an install target is judged on the profile it named', () => {
  it('the same profile agrees in both lanes, and another one does not', async () => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause('安装包 foo 版本 0.6.3 配置档 default。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    projection.items.set(item.id, item)
    expect(item.requestedTarget).toMatchObject({ package_id: 'foo', version: '0.6.3', profile: 'default' })
    const tool = createPrepareTool({ getProjection: () => projection })
    const same = await tool.execute({
      item_id: item.id, semantic_action: 'install',
      requested_target: { package_id: 'foo', version: '0.6.3', profile: 'default' },
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(same.compatibility.status).toBe('compatible')
    expect(authorizeMutationFromProjection(projection, {
      action: 'install', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { package_id: 'foo', version: '0.6.3', profile: 'default' },
    }).status).not.toBe('denied')

    const otherProfile = await tool.execute({
      item_id: item.id, semantic_action: 'install',
      requested_target: { package_id: 'foo', version: '0.6.3', profile: 'production' },
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(otherProfile.compatibility.status).not.toBe('compatible')
    expect(authorizeMutationFromProjection(projection, {
      action: 'install', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { package_id: 'foo', version: '0.6.3', profile: 'production' },
    }).status).toBe('denied')
  })
})

describe('hold-out 9 / K4: eligibility on an unpunctuated legacy request', () => {
  const legacy = (text: string): GuardItem => ({
    ...captureClause('占位', 'm1', 'R001', 1, { cwd: '/srv/app' }),
    normalizedText: text,
    directive: 'informational', authorityDisposition: 'informational', taskKind: 'inquiry',
    status: 'answered',
  })

  it('an order coordinated with a question written by an earlier release is checked', () => {
    const projection = createProjection()
    projection.enabled = true
    const record = legacy('Fix the parser and confirm whether the tests pass.')
    projection.items.set(record.id, record)
    expect(legacyRecordsNeedingReview(projection).map((finding) => finding.reason)).toEqual(['legacy_mixed_information_scope'])
  })

  it('the question-only control is not flagged', () => {
    const projection = createProjection()
    projection.enabled = true
    const record = legacy('Confirm whether the tests pass.')
    projection.items.set(record.id, record)
    expect(legacyRecordsNeedingReview(projection)).toEqual([])
  })
})
