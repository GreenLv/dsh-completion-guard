import { describe, expect, it } from 'vitest'
import { deriveProjection, legacyRecordsNeedingReview, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { interpretMessage } from '../../src/domain/semantics.js'
import { classifyUserInteraction } from '../../src/domain/conversation.js'
import { captureClause } from '../../src/domain/capture.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope, type GuardItem } from '../../src/domain/types.js'

/**
 * 0.6.3 hold-out round 8 — regression coverage (was the independent set).
 *
 * Round 7 was written after the F1-F3 repairs and then found one source defect of
 * its own (the English `then` preface/boundary collision), so round 7 is
 * regression coverage. Round 8 was written after that repair, against the task
 * contract, in shape families absent from rounds 1-7, the five review batches,
 * the fifth and sixth repair sets and the recorded-fixture upgrade evidence:
 *
 * - every remaining English investigation preface (also/next/finally/please)
 *   with a state question, in both directions: the same words with an ORDER head
 *   stay an order;
 * - a comparative `than` inside a genuine question, which must keep asking;
 * - a mixed message where the order comes first and the prefaced investigation
 *   second;
 * - two spellings of ONE repository offered as alternatives, which must stay one
 *   selection;
 * - a pull whose caller differs only in the refspec;
 * - eligibility on a comma-joined Chinese order+question written by an earlier
 *   release, on a record that already carries a different review reason, and on
 *   a plain statement.
 *
 * It found no defect of its own, but the SIXTH review then produced three new
 * counterexamples against the same invariant and the repairs changed the source,
 * so it is REGRESSION COVERAGE now and round 9 is the current independent set.
 * Its expectations were never revised.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-holdout8', createdAt: 1 } }

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

describe('hold-out 8 / K1: a preface must not change what a clause asks', () => {
  it.each([
    'Also verify whether the lock file is current.',
    'Next confirm whether the branch is clean.',
    'Please determine whether the tests pass.',
    'Finally check whether the release exists.',
  ])('%s stays an information request', (text) => {
    const scopes = interpretMessage(text)
    expect(scopes.length, text).toBeGreaterThanOrEqual(1)
    expect(scopes.some((entry) => entry.authorityDisposition === 'informational'), text).toBe(true)
  })

  it.each([
    'Then commit the change.',
    'Also push the branch.',
    'Please update the README.md.',
  ])('%s is still an order: the preface precedes an action head', (text) => {
    const scopes = interpretMessage(text)
    const work = scopes.filter((entry) => entry.authorityDisposition !== 'informational')
    expect(work.length, text).toBeGreaterThanOrEqual(1)
    expect(scopes.some((entry) => entry.authorityDisposition === 'informational'), text).toBe(false)
  })

  it('a comparative than inside a real question does not silence it', () => {
    const scopes = interpretMessage('Check whether the new build is faster than the old one.')
    expect(scopes.some((entry) => entry.authorityDisposition === 'informational')).toBe(true)
  })

  it('an order plus a prefaced investigation keeps both lanes', () => {
    const items = itemsOf([{ text: 'Update README.md. Also verify whether the lock file is current.', answer: '锁文件是最新的。' }])
    expect(items.some((item) => item.status === 'pending' && item.normalizedText.includes('README')), JSON.stringify(items.map((i) => [i.normalizedText, i.status, i.authorityDisposition]))).toBe(true)
    expect(items.some((item) => item.normalizedText.includes('lock file') && item.status === 'answered')).toBe(true)
  })

  it('a message that only acknowledges stays conversational', () => {
    expect(classifyUserInteraction('好的，谢谢。')).toBe('conversational')
    expect(classifyUserInteraction('Of course.')).toBe('conversational')
  })
})

describe('hold-out 8 / K2: one repository spelled twice is one selection', () => {
  it('a trailing separator does not turn one repository into two', () => {
    const item = captureClause('提交仓库 /repo-a 与 /repo-a/。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureReasonCode).toBeUndefined()
    expect(item.targetCaptureStatus).toBe('resolved')
    expect(item.requestedTarget?.repository).toContain('/repo-a')
  })

  it('a coordinator followed by a branch field is not a second repository', () => {
    const item = captureClause('提交仓库 /repo-b 与 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus).toBe('resolved')
    expect(item.requestedTarget).toMatchObject({ repository: '/repo-b', branch: 'main' })
  })
})

describe('hold-out 8 / K3: one judgement for a pull', () => {
  it('a caller that differs only in the refspec is refused in both lanes', async () => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause('拉取仓库 /repo-a remote upstream refspec refs/heads/main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    projection.items.set(item.id, item)
    expect(item.targetCaptureStatus).toBe('resolved')
    const tool = createPrepareTool({ getProjection: () => projection })
    const same = await tool.execute({
      item_id: item.id, semantic_action: 'pull',
      requested_target: { repository: '/repo-a', remote: 'upstream', refspec: 'refs/heads/main' },
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(same.compatibility.status).toBe('compatible')
    expect(authorizeMutationFromProjection(projection, {
      action: 'pull', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { repository: '/repo-a', remote: 'upstream', refspec: 'refs/heads/main' },
    }).status).not.toBe('denied')

    const otherRef = await tool.execute({
      item_id: item.id, semantic_action: 'pull',
      requested_target: { repository: '/repo-a', remote: 'upstream', refspec: 'refs/heads/release' },
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(otherRef.compatibility.status).not.toBe('compatible')
    expect(authorizeMutationFromProjection(projection, {
      action: 'pull', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { repository: '/repo-a', remote: 'upstream', refspec: 'refs/heads/release' },
    }).status).toBe('denied')
  })
})

describe('hold-out 8 / K4: eligibility on further legacy shapes', () => {
  const legacy = (text: string): GuardItem => ({
    ...captureClause('占位', 'm1', 'R001', 1, { cwd: '/srv/app' }),
    normalizedText: text,
    directive: 'informational', authorityDisposition: 'informational', taskKind: 'inquiry',
    status: 'answered',
  })

  it('a Chinese comma-joined order beside a question written by an earlier release is checked', () => {
    const projection = createProjection()
    projection.enabled = true
    const record = legacy('归档日志，确认哪些请求失败。')
    projection.items.set(record.id, record)
    expect(legacyRecordsNeedingReview(projection).map((finding) => finding.reason)).toEqual(['legacy_mixed_information_scope'])
  })

  it('a plain statement recorded as information is not flagged', () => {
    const projection = createProjection()
    projection.enabled = true
    const record = legacy('The build finished in 12 seconds.')
    projection.items.set(record.id, record)
    expect(legacyRecordsNeedingReview(projection)).toEqual([])
  })

  it('a record that already carries a review reason is left exactly as it is', () => {
    const projection = createProjection()
    projection.enabled = true
    const record: GuardItem = {
      ...legacy('归档日志，确认哪些请求失败。'),
      needsReview: { reason: 'legacy_environment_default_target', checkId: 'eligibility:0.6.3', recordedAtRevision: 3 },
    }
    projection.items.set(record.id, record)
    expect(legacyRecordsNeedingReview(projection)).toEqual([])
    expect(record.needsReview?.reason).toBe('legacy_environment_default_target')
    expect(record.needsReview?.recordedAtRevision).toBe(3)
  })
})
