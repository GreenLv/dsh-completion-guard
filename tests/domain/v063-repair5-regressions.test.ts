import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE, legacyRecordsNeedingReview } from '../../src/domain/derive.js'
import { captureClause } from '../../src/domain/capture.js'
import { interpretMessage } from '../../src/domain/semantics.js'
import { needsReviewObligations } from '../../src/domain/closure.js'
import { createProjection, type DerivedEnvelope, type GuardItem } from '../../src/domain/types.js'
import { expectNarrowedUndecided } from './narrowed-contract.js'

/**
 * The FIFTH repair round. These counterexamples were found by adjacency
 * self-review of the fourth round's structural rule, not returned by a reviewer,
 * and they are kept here exactly as they were found.
 *
 * Three defects, all in the K1/K2 fail-OPEN direction:
 *
 * 1. the English ASCII full stop was invisible to the clause splitter, so
 *    "Install the package. What changed?" stayed ONE run, ended interrogatively
 *    and was read as pure information: the order vanished and the record closed
 *    as answered. The Chinese `。` split the same message correctly, which is how
 *    the asymmetry survived four rounds;
 * 2. a coordinated fragment that carries its OWN instruction was still read as
 *    the sentence's question when the sentence ended with "?": in "What changed,
 *    and update the README?" the order was answered away;
 * 3. a clause that offered SEVERAL repositories ("提交仓库 /repo-b 与 /repo-c")
 *    silently resolved to the first one, which is a guess about which repository
 *    the root meant.
 *
 * Positive controls keep each repair from over-reaching: an abbreviation, a
 * version number, a file name and a lowercase continuation are not sentence
 * ends; a question behind a coordinating conjunction stays a question; and a
 * clause that names one repository, one branch or one remote is unaffected.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-repair5', createdAt: 1 } }

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

const itemsOf = (texts: Array<string | { text: string; answer?: string }>) => [...derive(texts).items.values()]

describe('repair 5 / P1: an English sentence end is a clause boundary', () => {
  it.each([
    'Install the package. What changed?',
    'Install the package. What changed in the build?',
    'Install the package. what changed?',
    'Install the package. 什么变了？',
  ])('%s keeps BOTH ranges', (text) => {
    const scopes = interpretMessage(text)
    expect(scopes.length, text).toBeGreaterThanOrEqual(2)
    expect(scopes.some((entry) => entry.authorityDisposition === 'informational'), text).toBe(true)
    expect(scopes.some((entry) => entry.authorityDisposition !== 'informational'), text).toBe(true)
    const items = itemsOf([text])
    // Before the repair the order was swallowed WHOLE: nothing was pending.
    expect(items.some((item) => item.status === 'pending'), text).toBe(true)
    expect(items.every((item) => item.authorityDisposition === 'informational'), text).toBe(false)
  })

  it('an order first and a question second closes only the question when answered', () => {
    const projection = derive([{ text: 'Install the package. Check whether an update exists.', answer: '已是最新版本。' }])
    const items = [...projection.items.values()]
    const order = items.find((item) => item.authorityDisposition !== 'informational')
    expect(order).toBeDefined()
    expect(order!.status).toBe('pending')
    // The answer closed the question range and nothing else.
    expect(items.some((item) => item.authorityDisposition === 'informational' && item.status === 'answered')).toBe(true)
    expect(needsReviewObligations(projection)).toEqual([])
  })

  it('the lowercase continuation is a sentence too', () => {
    const projection = derive([{ text: 'Install the package. what changed in the build?', answer: '已改为 0.6.3。' }])
    const items = [...projection.items.values()]
    expect(items.some((item) => item.authorityDisposition !== 'informational' && item.status === 'pending')).toBe(true)
    expect(items.some((item) => item.authorityDisposition === 'informational' && item.status === 'answered')).toBe(true)
  })

  it.each([
    // An abbreviation, a version number, a file name and a lowercase word that
    // opens nothing are NOT sentence ends.
    ['See e.g. the log file for this run.', 1],
    ['发布包 dsh-completion-guard 版本 0.6.3。', 1],
    ['Bump the version to 0.6.4 and commit the manifest.', 1],
  ] as const)('%s stays one clause', (text, count) => {
    expect(interpretMessage(text), text).toHaveLength(count)
    expect(itemsOf([text]), text).toHaveLength(count)
  })

  it('a legacy record of the repaired shape is flagged for review', () => {
    const projection = createProjection()
    projection.enabled = true
    const record: GuardItem = {
      ...captureClause('占位', 'm1', 'R001', 1, { cwd: '/srv/app' }),
      normalizedText: 'Install the package. What changed?',
      directive: 'informational', authorityDisposition: 'informational', taskKind: 'inquiry',
      status: 'answered',
    }
    projection.items.set(record.id, record)
    expect(legacyRecordsNeedingReview(projection)).toHaveLength(1)
  })
})

describe('repair 5 / P2: a coordinated clause with its own instruction is work', () => {
  it('合同调整: a question and an order in one sentence are one undecided obligation', () => {
    // 合同调整 (0.6.3 收窄合同): the ordering fragment used to survive the
    // sentence-final question mark as its own order. A question and an order in one
    // sentence cannot be told apart reliably, so the obligation is kept UNDECIDED:
    // it stays pending, and it authorizes nothing.
    expectNarrowedUndecided('What changed, and update the README?')
    const items = itemsOf(['What changed, and update the README?'])
    expect(items.some((item) => item.status === 'pending')).toBe(true)
  })

  it.each([
    '然后检查是否有新版本。',
    '接着检查是否有更新。',
    '并且检查是否存在冲突。',
  ])('%s is still a question: the conjunction is a preface', (text) => {
    const scopes = interpretMessage(text)
    expect(scopes.length, text).toBeGreaterThanOrEqual(1)
    expect(scopes.some((entry) => entry.authorityDisposition === 'informational'), text).toBe(true)
  })

  it('a question behind a conjunction stays a question', () => {
    const scopes = interpretMessage('Update the README, and what changed?')
    expect(scopes.some((entry) => entry.authorityDisposition === 'informational')).toBe(true)
  })
})

describe('repair 5 / P3: two repositories in one clause are not a selection', () => {
  it.each([
    '提交仓库 /repo-b 与 /repo-c。',
    '提交仓库 /repo-b 或 /repo-c。',
    '推送仓库 /repo-a 和 /repo-b remote origin。',
  ])('%s asks which repository', (text) => {
    const items = itemsOf([text])
    expect(items.length, text).toBeGreaterThan(0)
    for (const item of items) {
      expect(item.targetCaptureStatus, text).toBe('clarification_required')
      expect(item.targetCaptureReasonCode, text).toBe('requested_target_repository_ambiguous')
      expect(item.requestedTarget?.repository, text).toBeUndefined()
    }
  })

  it('the fields the clause DID name are kept for the decision', () => {
    const items = itemsOf(['提交仓库 /repo-b 与 /repo-c 分支 main。'])
    expect(items).toHaveLength(1)
    expect(items[0]!.requestedTarget).toMatchObject({ branch: 'main' })
    expect(items[0]!.requestedTarget?.repository).toBeUndefined()
  })

  it.each([
    '提交仓库 /repo-a 分支 main。',
    '推送仓库 /repo-a remote origin refspec refs/heads/main:refs/heads/main。',
    '提交当前仓库 分支 main。',
  ])('%s is unaffected: one repository, one selection', (text) => {
    const items = itemsOf([text])
    expect(items).toHaveLength(1)
    expect(items[0]!.targetCaptureStatus, text).toBe('resolved')
    expect(items[0]!.requestedTarget?.repository, text).toBeDefined()
  })

  it('an unrelated path in the same clause is not a repository candidate', () => {
    const items = itemsOf(['提交仓库 /repo-a 分支 main。'])
    expect(items[0]!.targetCaptureStatus).toBe('resolved')
  })
})
