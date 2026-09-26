import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { interpretMessage } from '../../src/domain/semantics.js'
import { captureClause } from '../../src/domain/capture.js'
import type { DerivedEnvelope } from '../../src/domain/types.js'

/**
 * The SIXTH independent review's counterexamples, kept as regressions.
 *
 * Three defects, all the same invariant failing in three places: an EXECUTION
 * residue must survive whatever the surrounding question, punctuation or
 * abbreviation looks like, and a name the root gave must not be re-judged by its
 * extension.
 *
 * F1. `What changed and archive the logs?` produced NO item, while the same
 *     sentence with a comma kept the archive. The session-talk classifier split
 *     fragments on punctuation only, so the coordinator was invisible to it (and
 *     the semantic layer never ran). It now splits with the SEMANTIC layer's own
 *     `splitTextFragments`, and in the clause layer a fragment that asks nothing
 *     and carries its own action head is an instruction whatever mark ends it.
 * F2. `Install the package etc. What changed?` was one information range: the
 *     abbreviation exception applied unconditionally, so `etc.` swallowed the
 *     sentence end and the trailing question mark decided the whole message. An
 *     abbreviation now keeps the run whole only when what follows CONTINUES the
 *     sentence (a lower-case word, a digit, a closing mark).
 * F3. `提交仓库 /repo-b.js 与 /repo-c.js。` silently resolved to the first: the
 *     candidate list filtered out anything with a file extension, while the
 *     first-object reader accepted it. Extensions are no longer identity
 *     evidence; a file argument in another clause is excluded by the join rule.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-review6', createdAt: 1 } }

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

describe('review 6 / F1: a question never deletes a later instruction, with or without punctuation', () => {
  it.each([
    'What changed and archive the logs?',
    'What changed, and archive the logs?',
    'What changed, archive the logs.',
    'What changed? Please archive the logs.',
  ])('%s keeps a pending obligation', (text) => {
    const items = itemsOf([text])
    expect(items.length, text).toBeGreaterThan(0)
    expect(items.some((item) => item.status === 'pending' && item.normalizedText.includes('archive')), text).toBe(true)
  })

  it('the unpunctuated order survives the answering turn', () => {
    const items = itemsOf([{ text: 'What changed and archive the logs?', answer: '收到。' }])
    expect(items.some((item) => item.normalizedText.includes('archive') && item.status === 'pending')).toBe(true)
  })

  it('a Chinese question beside a coordinated order keeps the order', () => {
    const scopes = interpretMessage('什么变了并归档日志？')
    expect(scopes.some((entry) => entry.authorityDisposition !== 'informational' && entry.text.includes('归档'))).toBe(true)
  })

  it.each([
    'What changed?',
    'Is there any update for the plugin?',
    '主题是不是需要更新呢？',
  ])('%s is still only a question', (text) => {
    const items = itemsOf([text])
    for (const item of items) expect(item.authorityDisposition, text).toBe('informational')
  })
})

describe('review 6 / F2: an abbreviation cannot swallow a sentence end', () => {
  it('the order before the abbreviation survives the answering turn', () => {
    const items = itemsOf([{ text: 'Install the package etc. What changed?', answer: '收到。' }])
    const order = items.find((item) => item.normalizedText.includes('Install the package'))
    expect(order).toBeDefined()
    expect(order!.authorityDisposition).not.toBe('informational')
    expect(order!.status).toBe('pending')
  })

  it.each([
    // An abbreviation that CONTINUES a sentence keeps it whole.
    ['See e.g. the log file for this run.', 1],
    ['Fix the bug. i.e. correct the parser.', 2],
    // A version number and a following sentence are separate.
    ['Release 0.6.3. Then report back.', 2],
    ['Install the package. What changed?', 2],
    ['Install the package etc. What changed?', 2],
  ] as const)('%s splits as the reading requires', (text, count) => {
    expect(interpretMessage(text), text).toHaveLength(count)
  })

  it('the continuation rule is about CONTENT, not the abbreviation', () => {
    // The same abbreviation class in both positions: continuing a sentence, and
    // starting a new one.
    expect(interpretMessage('See e.g. the current log file runs fine.')).toHaveLength(1)
    expect(interpretMessage('Fix the bug. i.e. correct the parser.')).toHaveLength(2)
    // A question after an abbreviation is a NEW sentence in either case: the
    // abbreviation may not widen the range a question mark delivers.
    expect(interpretMessage('Archive it etc. What changed?')).toHaveLength(2)
    expect(interpretMessage('Archive it etc. what changed?')).toHaveLength(2)
  })
})

describe('review 6 / F3: an extension is not evidence of identity', () => {
  it.each([
    '提交仓库 /repo-b.js 与 /repo-c.js。',
    '提交仓库 /repo-b.py 和仓库 /repo-c.py。',
  ])('%s records the ambiguity instead of choosing', (text) => {
    const item = [...derive([text]).items.values()].find((entry) => entry.semanticAction === 'commit')!
    expect(item.targetCaptureStatus, text).toBe('clarification_required')
    expect(item.targetCaptureReasonCode, text).toBe('requested_target_repository_ambiguous')
  })

  it('a repository with an extension is still a valid single target', () => {
    const item = captureClause('提交仓库 /repo-a.js 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus).toBe('resolved')
    expect(item.requestedTarget).toMatchObject({ repository: '/repo-a.js', branch: 'main' })
  })

  it('a file argument in another clause is not an alternative', () => {
    for (const text of ['提交仓库 /repo-a，运行 /tmp/script.sh。', '提交仓库 /repo-a，查看 /tmp/logs 里的日志。']) {
      const item = captureClause(text, 'm1', 'R001', 1, { cwd: '/srv/app' })
      expect(item.targetCaptureStatus, text).toBe('resolved')
    }
  })

  it('a claimed field value is still never a repository candidate', () => {
    const item = captureClause('推送仓库 /repo-a remote origin refspec refs/heads/main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus).toBe('resolved')
    expect(item.requestedTarget).toEqual({ repository: '/repo-a', remote: 'origin', refspec: 'refs/heads/main' })
  })

  it('two spellings of one repository are still one candidate', () => {
    const item = captureClause('提交仓库 /repo-a 与 /repo-a/。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus).toBe('resolved')
    expect(item.targetCaptureReasonCode).toBeUndefined()
  })
})
