import { describe, expect, it } from 'vitest'
import { deriveProjection, legacyRecordsNeedingReview, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { interpretMessage } from '../../src/domain/semantics.js'
import { captureClause } from '../../src/domain/capture.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope, type GuardItem } from '../../src/domain/types.js'

/**
 * 0.6.3 hold-out round 11 — regression coverage (was the independent set).
 *
 * Round 10 found nothing of its own, but the EIGHTH review then found that the
 * explanation scope was still pattern-based and tightened the "and then" control,
 * so round 10 is regression coverage. Round 11 was written after the ninth repair
 * round, in shape families absent from rounds 1-10 and the eight review batches:
 *
 * - explanation complements the pattern never covered: another modal
 *   (`could`, `should`, `might`), a `whether` complement with a modal, a
 *   manner complement with a very long object, and the Chinese manner form;
 * - the same heads whose complement is NOT open, where the coordination opens a
 *   new predicate and the order must survive;
 * - an explicitly separate instruction after an explanation, in both languages;
 * - an explanation of a quoted command, which is undecidable rather than
 *   answerable;
 * - the abbreviation-plus-prefaced-question residue with a different question
 *   word;
 * - per-field inheritance with a conflicting remote on one repository beside the
 *   agreeing case;
 * - eligibility on a recorded bare-wh order and on a recorded explanation.
 *
 * It found nothing of its own, but the NINTH review then required that an
 * explanation's scope never authorize an action it mentions, and that repair
 * changed this set's own reading (an explanation with an action residue is
 * undecided rather than informational), so it is REGRESSION COVERAGE and round 12
 * is the current independent set.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-holdout11', createdAt: 1 } }

let seq = 0
function derive(input: Array<string | { text: string; answer?: string }> | string) {
  if (typeof input === 'string') input = [input]
  seq = 0
  const events: DerivedEnvelope[] = [{
    seq: seq++, type: 'user/message', data: {
      source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' },
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

describe('hold-out 11 / K1: an open complement governs, a closed one does not', () => {
  it.each([
    'Describe how I could migrate the database and restart service api.',
    'Explain whether we should roll back the release and redeploy the service.',
    'Explain how I might install the optional development package with its recommended configuration, its peer dependencies and its migration notes and restart service api.',
    '说明一下我可以如何迁移数据库并重启 api 服务。',
  ])('%s is one explanation and authorizes nothing', (text) => {
    const projection = derive(text)
    const items = [...projection.items.values()]
    expect(items.length, text).toBeGreaterThan(0)
    for (const item of items) {
      expect(item.authorityDisposition, text).not.toBe('executable_now')
      expect(authorizeMutationFromProjection(projection, {
        action: 'restart', contractItemId: item.id, contractItemRevision: item.revision,
        resolvedTarget: { service_id: 'api' },
      }).status, text).not.toBe('authorized')
    }
  })

  it.each([
    ['Tell me which shard failed and archive the logs.', 'archive'],
    ['Explain the incident, rotate every credential and redeploy.', 'rotate'],
    ['说明一下哪里失败了并归档日志。', '归档'],
  ])('%s opens a new predicate: the order survives', (text, needle) => {
    const scopes = interpretMessage(text)
    const work = scopes.filter((entry) => entry.authorityDisposition !== 'informational').map((entry) => entry.text).join('｜')
    expect(work, text).toContain(needle)
  })

  it.each([
    'Describe the migration. Then restart service api.',
    '说明一下迁移步骤。然后重启 api 服务。',
  ])('%s orders the restart', async (text) => {
    const projection = derive(text)
    const restart = [...projection.items.values()].find((item) => item.semanticAction === 'restart')
    expect(restart, JSON.stringify([...projection.items.values()].map((i) => [i.normalizedText, i.authorityDisposition]))).toBeDefined()
    expect(restart!.authorityDisposition).toBe('executable_now')
    const prepared = await createPrepareTool({ getProjection: () => projection }).execute({
      item_id: restart!.id, semantic_action: 'restart', requested_target: { service_id: 'api' },
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(prepared.compatibility.status).toBe('compatible')
  })

  it('an explanation of a quoted command is undecidable, not answerable', () => {
    const scopes = interpretMessage('Explain `git rebase`.')
    expect(scopes.some((entry) => entry.authorityDisposition === 'informational')).toBe(false)
  })

  it('a question that stands beside an order keeps the order', () => {
    const scopes = interpretMessage('Which shard failed, and compress the archives?')
    expect(scopes.some((entry) => entry.authorityDisposition !== 'informational' && entry.text.includes('compress'))).toBe(true)
  })
})

describe('hold-out 11 / K1: the residue rule with another question word', () => {
  it('the deployment before the question stays owed', () => {
    const items = itemsOf([{ text: 'Deploy the release etc. please tell me which shard failed?', answer: '收到。' }])
    expect(items.some((item) => item.normalizedText.includes('Deploy the release') && item.status === 'pending'), JSON.stringify(items.map((i) => [i.normalizedText, i.status, i.authorityDisposition]))).toBe(true)
  })

  it('a yes/no question still covers its clause', () => {
    const items = itemsOf(['Is the migration finished?'])
    for (const item of items) expect(item.authorityDisposition).toBe('informational')
  })
})

describe('hold-out 11 / K2: a conflicting remote beside an agreeing push', () => {
  it('the conflicting field is left open and the agreeing one is kept', () => {
    const projection = derive([
      '推送仓库 /repo-b remote origin refspec refs/heads/main。',
      '推送仓库 /repo-b remote backup refspec refs/heads/main。',
      '推送。',
    ])
    const last = [...projection.items.values()].at(-1)!
    expect(last.requestedTarget?.repository).toBe('/repo-b')
    expect(last.requestedTarget?.refspec).toBe('refs/heads/main')
    expect(last.requestedTarget?.remote).toBeUndefined()
    expect(last.targetCaptureStatus).toBe('clarification_required')
    expect(last.targetCaptureReasonCode).toBe('requested_target_field_ambiguous')
  })

  it('an agreeing pair is still inherited whole', () => {
    const projection = derive([
      '提交仓库 /repo-c 分支 main。',
      '提交仓库 /repo-c 分支 main。',
      '提交。',
    ])
    const last = [...projection.items.values()].at(-1)!
    expect(last.targetCaptureStatus).toBe('resolved')
    expect(last.requestedTarget).toEqual({ repository: '/repo-c', branch: 'main' })
  })

  it('a single repository with one branch is unaffected', () => {
    const item = captureClause('提交仓库 /repo-c 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus).toBe('resolved')
  })
})

describe('hold-out 11 / K4: eligibility on the two explanation shapes', () => {
  const legacy = (text: string): GuardItem => ({
    ...captureClause('占位', 'm1', 'R001', 1, { cwd: '/srv/app' }),
    normalizedText: text,
    directive: 'informational', authorityDisposition: 'informational', taskKind: 'inquiry',
    status: 'answered',
  })

  it('a recorded bare-wh order beside a question is checked', () => {
    const projection = createProjection()
    projection.enabled = true
    const record = legacy('Rotate the logs and check whether the disk is full.')
    projection.items.set(record.id, record)
    expect(legacyRecordsNeedingReview(projection).map((finding) => finding.reason)).toEqual(['legacy_mixed_information_scope'])
  })

  it('a recorded explanation is still inheritable', () => {
    const projection = createProjection()
    projection.enabled = true
    const record = legacy('Explain how I can install foo and restart service api.')
    projection.items.set(record.id, record)
    expect(legacyRecordsNeedingReview(projection)).toEqual([])
  })
})
