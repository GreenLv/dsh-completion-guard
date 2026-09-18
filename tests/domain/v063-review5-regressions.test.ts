import { describe, expect, it } from 'vitest'
import { deriveProjection, legacyRecordsNeedingReview, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { captureClause } from '../../src/domain/capture.js'
import { needsReviewObligations } from '../../src/domain/closure.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope } from '../../src/domain/types.js'

/**
 * The FIFTH independent review's counterexamples, kept as regressions.
 *
 * The review returned the batch with three defects and four failing assertions.
 * All three were repaired in the source; nothing in the expectations was
 * relaxed. What they were:
 *
 * F1. the ASCII sentence boundary was decided from the NEXT word, so a
 *     lower-case request preface kept the run whole and `Install the package.
 *     please report what changed?` stayed ONE information range — the install
 *     was answered away. The boundary is structural now (any period followed by
 *     whitespace and further text) and only an abbreviation or a period with no
 *     space after it keeps the run whole.
 * F2. the whole-message interaction classifier returned `conversational` as soon
 *     as a question term appeared, before any decomposition, so
 *     `What changed, and archive the logs?` produced NO item at all. A
 *     conversational verdict now has to show that every fragment either asks or
 *     says nothing, and a coordinated clause whose head is a Latin word outside
 *     every vocabulary is work the capture layer sees.
 * F3. the same-clause multi-repository rule required whitespace before the
 *     coordinator and could not step over a repeated field label, so
 *     `提交仓库 /repo-b、/repo-c。` and `提交仓库 /repo-b 和仓库 /repo-c。` still
 *     resolved to `/repo-b`. Candidates are enumerated by structure now.
 *
 * The review's earlier passing probes are kept here too, so one file holds the
 * whole set.
 */

const scope = { cwd: '/repo-a', sessionHeader: { version: 3, id: 'review063', createdAt: 1 } }

function derive(texts: Array<string | { text: string; answer?: string }>) {
  let seq = 0
  const events: DerivedEnvelope[] = [{
    seq: seq++, type: 'user/message', data: {
      source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' },
      content: [{ type: 'text', text: PROTOCOL_V5_NOTICE }],
    },
  }]
  texts.forEach((entry, index) => {
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
  return deriveProjection(events, { activation: 'always' }, scope, true).projection
}

const itemsOf = (texts: Array<string | { text: string; answer?: string }>) => [...derive(texts).items.values()]

describe('review 5 / F1: the sentence boundary is structural', () => {
  it.each([
    'Install the package. please report what changed?',
    'Install the package. kindly archive the logs.',
    'Install the package. 请把结果记录下来。',
  ])('%s keeps a pending obligation beside the question', (text) => {
    const items = itemsOf([text])
    expect(items.length, text).toBeGreaterThan(0)
    expect(items.some((item) => item.status === 'pending' && item.authorityDisposition !== 'informational'), text).toBe(true)
    expect(items.every((item) => item.authorityDisposition === 'informational'), text).toBe(false)
  })

  it('the install is not answered away by the question that follows it', () => {
    const items = itemsOf([{ text: 'Install the package. please report what changed?', answer: '收到。' }])
    const work = items.filter((item) => item.authorityDisposition !== 'informational')
    expect(work.length).toBeGreaterThan(0)
    for (const item of work) expect(item.status, item.normalizedText).toBe('pending')
  })

  it.each([
    ['See e.g. the log file for this run.', 1],
    ['See the docs, i.e. the README.', 1],
    ['发布包 dsh-completion-guard 版本 0.6.3。', 1],
    ['Bump the version to 0.6.4 and commit it.', 1],
  ] as const)('%s stays one clause: an abbreviation and a decimal are not sentence ends', (text, count) => {
    expect(itemsOf([text]), text).toHaveLength(count)
  })
})

describe('review 5 / F2: a question never deletes a later instruction', () => {
  it.each([
    'What changed, and archive the logs?',
    'What changed, archive the logs.',
    'What changed? Please archive the logs.',
  ])('%s keeps the archive obligation', (text) => {
    const items = itemsOf([text])
    expect(items.length, text).toBeGreaterThan(0)
    expect(items.some((item) => item.status === 'pending' && item.authorityDisposition !== 'informational'), text).toBe(true)
    expect(items.some((item) => item.normalizedText.includes('archive')), text).toBe(true)
  })

  it('the archive is still owed after the turn answers', () => {
    const items = itemsOf([{ text: 'What changed, and archive the logs?', answer: '收到。' }])
    expect(items.some((item) => item.normalizedText.includes('archive') && item.status === 'pending')).toBe(true)
  })

  it.each([
    'Check whether an update exists and install the package.',
    '安装新主题吧。',
  ])('execution must survive a zero-tool final: %s', (text) => {
    expect([...derive([text]).items.values()].some((item) => item.status === 'pending' && item.authorityDisposition !== 'informational')).toBe(true)
  })
})

describe('review 5 / F3: a clause that offers several repositories chooses none', () => {
  it.each([
    '提交仓库 /repo-b、/repo-c。',
    '提交仓库 /repo-b 和仓库 /repo-c。',
    '提交仓库 /repo-b和/repo-c。',
    '提交仓库 /repo-b 和 /repo-c。',
  ])('%s records the ambiguity', (text) => {
    const item = [...derive([text]).items.values()].find((entry) => entry.semanticAction === 'commit')!
    expect(item.targetCaptureStatus, text).toBe('clarification_required')
    expect(item.targetCaptureReasonCode, text).toBe('requested_target_repository_ambiguous')
  })

  it('one repository, one branch, one remote and one file argument are unaffected', () => {
    const single = [...derive(['提交仓库 /repo-b 分支 main。']).items.values()].at(-1)!
    expect(single.targetCaptureStatus).toBe('resolved')
    expect(single.requestedTarget?.repository).toBe('/repo-b')
    const branchOnly = captureClause('提交分支 release。', 'm1', 'R001', 1, { cwd: '/repo-a' })
    expect(branchOnly.targetCaptureStatus).toBe('clarification_required')
    const withFile = captureClause('提交仓库 /repo-a，运行 /tmp/script.sh。', 'm1', 'R001', 1, { cwd: '/repo-a' })
    expect(withFile.targetCaptureStatus).toBe('resolved')
  })
})

describe('review 5: the probes that already passed stay passing', () => {
  it('the same repository is one candidate across three references', () => {
    const items = [...derive(['提交仓库 /repo-b 分支 main。', '推送。', '拉取。']).items.values()]
    expect(items.at(-1)?.targetCaptureStatus).toBe('resolved')
    expect(items.at(-1)?.requestedTarget?.repository).toBe('/repo-b')
  })

  it('a legacy mixed record still needs review', () => {
    const projection = createProjection()
    const record = captureClause('占位', 'm1', 'R001', 1, { cwd: '/repo-a' })
    Object.assign(record, {
      normalizedText: 'Check whether an update exists and install the package.',
      directive: 'informational', authorityDisposition: 'informational', taskKind: 'inquiry', status: 'answered',
    })
    projection.items.set(record.id, record)
    expect(legacyRecordsNeedingReview(projection)).toHaveLength(1)
  })

  it('a passed legacy record still blocks inside its own unit', () => {
    const projection = createProjection()
    projection.boundaryProtocol = 5
    projection.currentUnitId = 'U001'
    const record = captureClause('提交仓库 /repo-b', 'm1', 'R001', 1, { cwd: '/repo-a' })
    record.unitId = 'U001'
    record.status = 'passed'
    record.needsReview = { reason: 'legacy_environment_default_target', checkId: 'eligibility:0.6.3', recordedAtRevision: 1 }
    projection.items.set(record.id, record)
    expect(needsReviewObligations(projection)).toHaveLength(1)
  })

  it('an answered sibling of another unit still does not block the current one', () => {
    const projection = createProjection()
    projection.boundaryProtocol = 5
    projection.currentUnitId = 'U002'
    const record = captureClause('占位', 'm1', 'R001', 1, { cwd: '/repo-a' })
    Object.assign(record, {
      unitId: 'U001', status: 'answered',
      needsReview: { reason: 'legacy_mixed_information_scope', checkId: 'eligibility:0.6.3', recordedAtRevision: 1 },
    })
    projection.items.set(record.id, record)
    expect(needsReviewObligations(projection)).toHaveLength(0)
  })

  it('a prohibition on another repository is not an authorized selection', () => {
    const projection = derive(['安装 foo 插件，不要推送仓库 /repo-b。', '提交。'])
    const commit = [...projection.items.values()].find((item) => item.semanticAction === 'commit')!
    expect(commit.targetCaptureStatus).toBe('clarification_required')
  })

  it('prepare exposes the same host-snapshot block the gate refuses on', async () => {
    const projection = createProjection()
    projection.enabled = true
    projection.hostStatus = 'unsupported'
    const item = captureClause('提交仓库 /repo-b 分支 main。', 'm1', 'R001', 1, { cwd: '/repo-a' })
    projection.items.set(item.id, item)
    const prepared = await createPrepareTool({ getProjection: () => projection }).execute(
      { item_id: item.id, semantic_action: 'commit' } as never, undefined as never,
    ) as { compatibility: { status: string } }
    expect(prepared.compatibility.status).toBe('blocked')
    expect(authorizeMutationFromProjection(projection, {
      action: 'commit', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { repository: '/repo-b', branch: 'main' },
    }).status).toBe('denied')
  })
})
