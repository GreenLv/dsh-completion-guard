import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE, legacyRecordsNeedingReview } from '../../src/domain/derive.js'
import { captureClause } from '../../src/domain/capture.js'
import { interpretMessage } from '../../src/domain/semantics.js'
import { needsReviewObligations } from '../../src/domain/closure.js'
import { certifyCheckpoint } from '../../src/domain/checkpoint.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope, type GuardItem, type GuardProjection } from '../../src/domain/types.js'

/**
 * 0.6.3 hold-out round 6 — regression coverage (was the independent set).
 *
 * Round 5 produced a finding (the interaction classifier masked a purpose
 * clause before segmentation) and its repair changed the source, so round 5 is
 * regression coverage now. Round 6 was written after that repair AND after the
 * fifth repair round, against the task contract, in shape families absent from
 * rounds 1-5, the four review batches and the fifth repair set:
 *
 * - a Chinese order followed by a Chinese question as two sentences, and a
 *   newline-separated English pair, neither of which any earlier set used;
 * - a prohibition beside an unrelated order;
 * - 本仓库 (the current-repository deixis) as a target source, and a pull that
 *   names only a branch;
 * - a fully spelled publish target and a caller that drops a field the
 *   obligation named;
 * - eligibility on a pre-v5 session whose record belongs to ANOTHER unit, which
 *   keeps its birth rule only while the session is pre-v5.
 *
 * Expectations come from the contract. A failure here is a source finding.
 *
 * The fifth review returned three defects (F1-F3) whose repairs changed the
 * source, so this set is REGRESSION COVERAGE now and round 7 is the current
 * independent set. Three of its own expectations were also wrong when it first
 * ran; they are recorded rather than hidden, and per the plan's rule a set whose
 * oracle was revised does not count as untuned evidence either:
 *
 * - "Archive the logs. Then check whether the disk is full." closes its
 *   investigation and leaves the order pending, but the investigation lane was
 *   `acceptance`/`executable_now` behind the preface "Then". The assertion was
 *   first narrowed to the contract property, and the SIXTH repair round then
 *   removed the discrepancy at its root (an English sequencing preface no longer
 *   changes what a clause asks), so the case below now also pins the information
 *   lane the contract requires;
 * - "拉取分支 develop" records the branch as the transfer order's REFSPEC, which
 *   is the rule the review-2 repair pinned for push, not as a `branch` field;
 * - a publish target's registry identity is the canonical base the repository's
 *   own canonicalizer produces (`https://registry.npmjs.org/`), so a caller that
 *   supplies the root's unnormalized spelling does not match the obligation. The
 *   set now uses the recorded identity, and still checks that a different
 *   registry is refused.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-holdout6', createdAt: 1 } }

let seq = 0
function derive(input: Array<string | { text: string; answer?: string }>) {
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

/**
 * A PRE-v5 session. The derived type pins the boundary protocol to the current
 * one, so a historical projection writes the older value through a narrow cast;
 * only the eligibility scope reads it (a pre-v5 session keeps the birth rules,
 * so a record of another unit is still checked).
 */
function asPreV5(projection: GuardProjection): GuardProjection {
  (projection as { boundaryProtocol?: number }).boundaryProtocol = 4
  return projection
}

describe('hold-out 6 / K1: two sentences, two readings, in families not yet used', () => {
  it.each([
    ['同步远端。哪些请求失败了？', '同步远端。', '哪些请求失败了？'],
    ['提交这些改动。What failed in CI?', '提交这些改动。', 'What failed in CI?'],
    ['Deploy the build.\nHow far did it get?', 'Deploy the build.', 'How far did it get?'],
  ] as const)('%s keeps the order and the question', (text, order, question) => {
    const scopes = interpretMessage(text)
    const informational = scopes.filter((entry) => entry.authorityDisposition === 'informational')
    expect(informational.length, text).toBe(1)
    expect(informational[0]!.text, text).toContain(question)
    const work = scopes.filter((entry) => entry.authorityDisposition !== 'informational')
    expect(work.length, text).toBeGreaterThanOrEqual(1)
    expect(work.map((entry) => entry.text).join('｜'), text).toContain(order)
    const items = itemsOf([text])
    expect(items.some((item) => item.status === 'pending' && item.authorityDisposition !== 'informational'), text).toBe(true)
  })

  it('a prohibition beside an unrelated order keeps both lanes', () => {
    const items = itemsOf(['不要提交这个分支。安装新主题。'])
    expect(items.some((item) => item.kind === 'prohibition'), JSON.stringify(items.map((i) => [i.kind, i.directive, i.normalizedText]))).toBe(true)
    expect(items.some((item) => item.semanticAction === 'install')).toBe(true)
  })

  it('a reported question behind an order is the order, not the clause question', () => {
    const scopes = interpretMessage('Stop the service; then tell me why it crashed.')
    expect(scopes.length).toBeGreaterThanOrEqual(2)
    const work = scopes.filter((entry) => entry.authorityDisposition !== 'informational')
    expect(work.length).toBeGreaterThanOrEqual(1)
    expect(work.map((entry) => entry.text).join('｜')).toContain('Stop the service')
  })

  it('an order followed by an investigation closes only the investigation', () => {
    const projection = derive([{ text: 'Archive the logs. Then check whether the disk is full.', answer: '磁盘还有 40% 空间。' }])
    const items = [...projection.items.values()]
    // The investigation range is what the answer closed, and it is closed.
    const investigation = items.find((item) => item.normalizedText.includes('check whether'))
    expect(investigation).toBeDefined()
    expect(investigation!.status).not.toBe('pending')
    // The lane the contract requires, pinned after the sixth repair round made
    // an English sequencing preface transparent to the investigation head.
    expect(investigation!.authorityDisposition).toBe('informational')
    // The order the same message gave is still open.
    const order = items.find((item) => item.normalizedText.includes('Archive'))
    expect(order).toBeDefined()
    expect(order!.status).toBe('pending')
  })
})

describe('hold-out 6 / K2: target provenance in further spellings', () => {
  it('本仓库 is the current repository, and only that repository authorizes', async () => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause('提交本仓库 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    projection.items.set(item.id, item)
    expect(item.targetCaptureStatus).toBe('resolved')
    expect(item.targetSource?.kind).toBe('explicit_current_repository')
    expect(item.requestedTarget).toMatchObject({ repository: '/srv/app', branch: 'main' })

    const tool = createPrepareTool({ getProjection: () => projection })
    const matching = await tool.execute(
      { item_id: item.id, semantic_action: 'commit', requested_target: { repository: '/srv/app', branch: 'main' } } as never,
      undefined as never,
    ) as { compatibility: { status: string } }
    expect(matching.compatibility.status).toBe('compatible')
    expect(authorizeMutationFromProjection(projection, {
      action: 'commit', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { repository: '/srv/app', branch: 'main' },
    }).status).not.toBe('denied')

    const other = await tool.execute(
      { item_id: item.id, semantic_action: 'commit', requested_target: { repository: '/srv/other', branch: 'main' } } as never,
      undefined as never,
    ) as { compatibility: { status: string } }
    expect(other.compatibility.status).not.toBe('compatible')
    expect(authorizeMutationFromProjection(projection, {
      action: 'commit', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { repository: '/srv/other', branch: 'main' },
    }).status).toBe('denied')
  })

  it('a pull that names only a branch waits for the repository', () => {
    const items = itemsOf(['拉取分支 develop。'])
    expect(items).toHaveLength(1)
    const item = items[0]!
    expect(item.targetCaptureStatus).toBe('clarification_required')
    expect(item.targetCaptureReasonCode).toBe('requested_target_repository_missing')
    // A branch named inside a TRANSFER order is that order's refspec (the rule
    // the review-2 repair pinned for push), and it survives the clarification.
    expect(item.requestedTarget?.refspec).toBe('develop')
  })

  it('a refspec spelled as a ref is the refspec, and a different one is refused', async () => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause('推送仓库 /srv/app remote upstream refspec refs/heads/main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    projection.items.set(item.id, item)
    expect(item.requestedTarget).toMatchObject({ repository: '/srv/app', remote: 'upstream', refspec: 'refs/heads/main' })
    const tool = createPrepareTool({ getProjection: () => projection })
    const same = await tool.execute(
      { item_id: item.id, semantic_action: 'push', requested_target: { repository: '/srv/app', remote: 'upstream', refspec: 'refs/heads/main' } } as never,
      undefined as never,
    ) as { compatibility: { status: string } }
    expect(same.compatibility.status).toBe('compatible')
    const different = await tool.execute(
      { item_id: item.id, semantic_action: 'push', requested_target: { repository: '/srv/app', remote: 'upstream', refspec: 'refs/heads/release' } } as never,
      undefined as never,
    ) as { status: string; compatibility: { status: string } }
    expect(different.compatibility.status).not.toBe('compatible')
    expect(authorizeMutationFromProjection(projection, {
      action: 'push', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { repository: '/srv/app', remote: 'upstream', refspec: 'refs/heads/release' },
    }).status).toBe('denied')
  })
})

describe('hold-out 6 / K3: one judgement for prepare and execution', () => {
  it('a restart answers the same question in both lanes', async () => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause('重启 synthetic 服务。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    projection.items.set(item.id, item)
    const tool = createPrepareTool({ getProjection: () => projection })
    const same = await tool.execute(
      { item_id: item.id, semantic_action: 'restart', requested_target: { service_id: 'synthetic' } } as never,
      undefined as never,
    ) as { compatibility: { status: string } }
    expect(same.compatibility.status).toBe('compatible')
    expect(authorizeMutationFromProjection(projection, {
      action: 'restart', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { service_id: 'synthetic' },
    }).status).not.toBe('denied')

    const different = await tool.execute(
      { item_id: item.id, semantic_action: 'restart', requested_target: { service_id: 'production' } } as never,
      undefined as never,
    ) as { compatibility: { status: string } }
    expect(different.compatibility.status).not.toBe('compatible')
    expect(authorizeMutationFromProjection(projection, {
      action: 'restart', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { service_id: 'production' },
    }).status).toBe('denied')
  })

  it('a caller cannot drop a field the obligation named', async () => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause('提交仓库 /srv/app 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    projection.items.set(item.id, item)
    expect(item.requestedTarget).toMatchObject({ repository: '/srv/app', branch: 'main' })
    const prepared = await createPrepareTool({ getProjection: () => projection }).execute(
      { item_id: item.id, semantic_action: 'commit', requested_target: { repository: '/srv/app' } } as never,
      undefined as never,
    ) as { status: string; compatibility: { status: string } }
    // A target that covers FEWER identity fields than the obligation is not an
    // execution of it, however well the fields it does carry agree.
    expect(prepared.compatibility.status).not.toBe('compatible')
    expect(authorizeMutationFromProjection(projection, {
      action: 'commit', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { repository: '/srv/app' },
    }).status).toBe('denied')
  })

  it('a fully spelled publish target is the target the root wrote', async () => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause(
      '发布制品 dsh-completion-guard 版本 0.6.3 registry https://registry.npmjs.org。',
      'm1', 'R001', 1, { cwd: '/srv/app' },
    )
    projection.items.set(item.id, item)
    expect(item.targetCaptureStatus).toBe('resolved')
    // The registry identity is the canonical base the capture recorded (the
    // repository's own canonicalizer normalizes the trailing separator), and the
    // caller that uses it agrees with the obligation.
    expect(item.requestedTarget?.registry).toBe('https://registry.npmjs.org/')
    const tool = createPrepareTool({ getProjection: () => projection })
    const matching = await tool.execute({
      item_id: item.id, semantic_action: 'publish', requested_target: item.requestedTarget,
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(matching.compatibility.status).toBe('compatible')
    expect(authorizeMutationFromProjection(projection, {
      action: 'publish', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: item.requestedTarget as never,
    }).status).not.toBe('denied')

    const otherRegistry = await tool.execute({
      item_id: item.id, semantic_action: 'publish',
      requested_target: { artifact_id: 'dsh-completion-guard', version: '0.6.3', registry: 'https://registry.example.com/' },
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(otherRegistry.compatibility.status).not.toBe('compatible')
  })
})

describe('hold-out 6 / K4: eligibility keeps its own scope', () => {
  it('a pre-v5 session still checks a record of another unit', () => {
    const projection = asPreV5(createProjection())
    projection.enabled = true
    projection.currentUnitId = 'U001'
    const record: GuardItem = {
      ...captureClause('占位', 'm1', 'R001', 1, { cwd: '/srv/app' }),
      unitId: 'U009', status: 'answered',
      normalizedText: 'Compress /var/logs to check which shard failed and install the CLI.',
      directive: 'informational', authorityDisposition: 'informational', taskKind: 'inquiry',
    }
    projection.items.set(record.id, record)
    // Pre-v5 keeps its birth rules: every record is in scope.
    expect(legacyRecordsNeedingReview(projection).map((finding) => finding.itemId)).toEqual([record.id])
    expect(legacyRecordsNeedingReview(projection)[0]!.reason).toBe('legacy_mixed_information_scope')
  })

  it('a v5 session does not reach into another unit', () => {
    const projection = createProjection()
    projection.enabled = true
    projection.boundaryProtocol = 5
    projection.currentUnitId = 'U001'
    const record: GuardItem = {
      ...captureClause('占位', 'm1', 'R001', 1, { cwd: '/srv/app' }),
      unitId: 'U009', status: 'answered',
      normalizedText: 'Compress /var/logs to check which shard failed and install the CLI.',
      directive: 'informational', authorityDisposition: 'informational', taskKind: 'inquiry',
    }
    projection.items.set(record.id, record)
    expect(legacyRecordsNeedingReview(projection)).toEqual([])
  })

  it('a pure question of the same shape is not flagged', () => {
    const projection = createProjection()
    projection.enabled = true
    const record: GuardItem = {
      ...captureClause('占位', 'm1', 'R001', 1, { cwd: '/srv/app' }),
      status: 'answered',
      normalizedText: '确认是否有新版本。',
      directive: 'informational', authorityDisposition: 'informational', taskKind: 'inquiry',
    }
    projection.items.set(record.id, record)
    expect(legacyRecordsNeedingReview(projection)).toEqual([])
  })

  it('a flagged unit-less record blocks the certificate and the goal', () => {
    const projection = asPreV5(createProjection())
    projection.enabled = true
    const record: GuardItem = {
      ...captureClause('占位', 'm1', 'R001', 1, { cwd: '/srv/app' }),
      status: 'answered',
      needsReview: { reason: 'legacy_mixed_information_scope', checkId: 'eligibility:0.6.3', recordedAtRevision: 1 },
    }
    projection.items.set(record.id, record)
    expect(needsReviewObligations(projection).map((item) => item.id)).toEqual([record.id])
    const result = certifyCheckpoint(projection, [], 'C1')
    expect(result.status).toBe('incomplete')
    expect(result.rejectedBindings[0]).toMatchObject({ itemId: record.id, reasonCode: 'legacy_record_needs_review' })
  })
})
