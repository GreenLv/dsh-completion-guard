import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE, legacyRecordsNeedingReview } from '../../src/domain/derive.js'
import { captureClause } from '../../src/domain/capture.js'
import { interpretMessage } from '../../src/domain/semantics.js'
import { needsReviewObligations } from '../../src/domain/closure.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope, type GuardItem } from '../../src/domain/types.js'

/**
 * 0.6.3 hold-out round 3 — NOW REGRESSION COVERAGE.
 *
 * This set produced findings and the repairs changed the source, so it is
 * regression coverage; `v063-holdout-round4.test.ts` is the current independent
 * set.
 *
 * 0.6.3 hold-out round 3 — the replacement independent set.
 *
 * Round 2 produced nine findings and those repairs changed the source, so round
 * 2 is regression coverage now and cannot be hold-out evidence. Round 3 was
 * written after those repairs, against the task contract, using wording and
 * combinations absent from every earlier set and from both review batches:
 *
 * - English object clauses with an interrogative noun phrase ("Write a status
 *   line noting whether the deploy succeeded") in more verbs than round 2 used;
 * - `when`/`once` conditional tails, and the "check when …" counterpart where
 *   the interrogative IS the object;
 * - repository fields named ACROSS the follow-up rather than in one clause;
 * - a prohibition whose identity is only partially named, and a prohibition on
 *   a second repository;
 * - prepare/action agreement for a blocked adapter and for a target that
 *   resolves to a different repository than the item selected;
 * - eligibility over a required-descendant unit and over a pass-then-answered
 *   pair in the same unit.
 *
 * Every expectation is written from the contract. A failure here is a finding
 * to repair in the source.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/service', sessionHeader: { version: 3, id: 'v063-holdout3', createdAt: 1 } }

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

describe('hold-out 3 / K1: object clauses and conditionals are work, not answers', () => {
  it.each([
    'Write a status line noting whether the deploy succeeded.',
    'Produce a checklist listing whether each service is healthy.',
    'Draft a note capturing whether the migration finished.',
    'Emit a summary reporting whether the cache was warm.',
  ])('%s stays open work', (text) => {
    const items = itemsOf([text])
    expect(items.length, text).toBeGreaterThan(0)
    for (const item of items) {
      expect(item.authorityDisposition, text).not.toBe('informational')
      expect(item.status, text).toBe('pending')
    }
  })

  it.each([
    'Deploy the build if the smoke test passes.',
    'Restart the service once the migration finishes.',
    'Run the suite when the lock clears.',
  ])('%s is held as a condition, never executed or answered', (text) => {
    const items = itemsOf([text])
    expect(items.length, text).toBeGreaterThan(0)
    for (const item of items) {
      expect(item.status, text).toBe('pending')
      expect(item.authorityDisposition, text).not.toBe('informational')
    }
  })

  it.each([
    'Check whether the deploy succeeded.',
    'Verify if the migration finished.',
    'Check when the cache was last warmed.',
  ])('%s asks about its object and stays answerable', (text) => {
    const scopes = interpretMessage(text)
    expect(scopes.length, text).toBe(1)
    expect(scopes[0]!.authorityDisposition, text).toBe('informational')
    for (const item of itemsOf([text])) {
      expect(item.authorityDisposition, text).not.toBe('executable_now')
    }
  })

  it('合同调整: an interrogative inside a coordinated object protects the clause', () => {
    // 合同调整 (0.6.3 收窄合同): the coordinated order used to split into two
    // executable readings. A clause whose own span carries an interrogative that the
    // head reader cannot classify is now PROTECTED — undecided, indivisible, and
    // authorizing nothing — because nothing proves the first order is independent of
    // the question. The obligation is still captured with both actions.
    const scopes = interpretMessage('创建文件 /tmp/x 并记录测试是否通过。')
    expect(scopes.every((entry) => entry.authorityDisposition !== 'executable_now')).toBe(true)
    const items = itemsOf(['创建文件 /tmp/x 并记录测试是否通过。'])
    expect(items.length).toBeGreaterThanOrEqual(1)
    expect(items.some((item) => item.status === 'pending')).toBe(true)
  })

  it('an object clause followed by a live order keeps the order', () => {
    const scopes = interpretMessage('Write a status line noting whether the deploy succeeded, then restart the service.')
    // The first clause is an order whose artifact must RECORD the outcome, so
    // it is never an answer range; the restart is its own live order.
    expect(scopes.filter((entry) => entry.authorityDisposition === 'informational'), 'no answer range exists').toHaveLength(0)
    expect(scopes.some((entry) => entry.authorityDisposition === 'executable_now')).toBe(true)
    const items = itemsOf(['Write a status line noting whether the deploy succeeded, then restart the service.'])
    expect(items.some((item) => item.semanticAction === 'restart' && item.status === 'pending')).toBe(true)
  })
})

describe('hold-out 3 / K2: repository fields named across the follow-up', () => {
  it('a follow-up that names only the branch inherits the repository around it', () => {
    const items = itemsOf(['提交仓库 /srv/service 分支 stable。', '推送分支 release。'])
    const push = items.find((item) => item.semanticAction === 'push')!
    // A branch named inside a TRANSFER order is that order's refspec ("push the
    // release branch"), so it is recorded as a refspec while the repository is
    // inherited around it.
    expect(push.requestedTarget).toMatchObject({ repository: '/srv/service', refspec: 'release' })
    expect(push.targetSource?.kind).toBe('unit_inherited')
    expect(push.targetCaptureStatus).toBe('resolved')
  })

  it('a commit follow-up that names only the branch inherits around it', () => {
    const items = itemsOf(['提交仓库 /srv/service 分支 stable。', '提交分支 release。'])
    const followUp = items.at(-1)!
    expect(followUp.requestedTarget).toMatchObject({ repository: '/srv/service', branch: 'release' })
    expect(followUp.targetCaptureStatus).toBe('resolved')
  })

  it('a follow-up that names only the remote inherits the repository around it', () => {
    const items = itemsOf(['推送仓库 /srv/service remote upstream refspec refs/heads/main。', '推送远端 origin。'])
    const second = items.at(-1)!
    expect(second.requestedTarget).toMatchObject({ repository: '/srv/service', remote: 'origin' })
    expect(second.targetCaptureStatus).toBe('resolved')
  })

  it('a follow-up that names a different repository keeps its own choice', () => {
    const items = itemsOf(['提交仓库 /srv/service 分支 main。', '推送仓库 /srv/other 分支 main。'])
    const push = items.find((item) => item.semanticAction === 'push')!
    expect(push.requestedTarget).toMatchObject({ repository: '/srv/other' })
    expect(push.targetSource?.kind).toBe('explicit_label')
  })

  it('inheriting a branch does not make the inherited branch authorizable elsewhere', () => {
    const projection = derive(['提交仓库 /srv/service 分支 stable。', '提交分支 release。'])
    const followUp = [...projection.items.values()].at(-1)!
    expect(authorizeMutationFromProjection(projection, {
      action: 'commit', contractItemId: followUp.id, contractItemRevision: followUp.revision,
      resolvedTarget: { repository: '/srv/service', branch: 'stable' },
    })).toMatchObject({ status: 'denied', reasonCode: 'mutation_requested_target_mismatch' })
  })

  it('two repositories named in one message stay ambiguous for the follow-up', () => {
    const items = itemsOf([
      '推送仓库 /srv/service remote upstream refspec refs/heads/main。',
      '推送仓库 /srv/other remote upstream refspec refs/heads/main。',
      '拉取。',
    ])
    const pull = items.find((item) => item.semanticAction === 'pull')!
    expect(pull.targetCaptureStatus).toBe('clarification_required')
    expect(pull.targetCaptureReasonCode).toBe('requested_target_repository_ambiguous')
  })
})

describe('hold-out 3 / K2: prohibitions and boundaries around prepare', () => {
  it('a prohibition naming only the repository still blocks that repository', async () => {
    // The requirement names a complete selector, so the ONLY blocker under test
    // is the ban: the prohibition names just the repository, which matches the
    // requirement's declared identity.
    const projection = derive(['推送仓库 /srv/other remote upstream refspec refs/heads/main。不要推送仓库 /srv/other。'])
    const requirement = [...projection.items.values()]
      .find((item) => item.kind === 'requirement' && item.semanticAction === 'push')!
    const response = await createPrepareTool({ getProjection: () => projection }).execute(
      { item_id: requirement.id, semantic_action: 'push' } as never, undefined as never,
    ) as { compatibility: { status: string; reason_codes: string[] } }
    expect(response.compatibility.status).toBe('blocked')
    expect(response.compatibility.reason_codes).toContain('conflicting_prohibition')
  })

  it('a prohibition on another repository leaves the prohibition input clear', async () => {
    const projection = derive(['推送仓库 /srv/service 分支 main。不要推送仓库 /srv/other。'])
    const requirement = [...projection.items.values()]
      .find((item) => item.kind === 'requirement' && item.semanticAction === 'push')!
    const response = await createPrepareTool({ getProjection: () => projection }).execute(
      { item_id: requirement.id, semantic_action: 'push' } as never, undefined as never,
    ) as { compatibility: { status: string; reason_codes: string[] } }
    // The ban names a DIFFERENT repository, so it is not the blocking reason.
    // What blocks is the item's own target lacking the required refspec: the
    // gate would refuse a mutation on it too.
    expect(response.compatibility.reason_codes).not.toContain('conflicting_prohibition')
    expect(response.compatibility.reason_codes).toContain('target_not_authorizing')
    expect(response.compatibility.status).toBe('blocked')
  })

  it('a prohibition of a DIFFERENT action does not block', async () => {
    const projection = derive(['提交仓库 /srv/service 分支 main。不要推送仓库 /srv/service 分支 main。'])
    const requirement = [...projection.items.values()]
      .find((item) => item.kind === 'requirement' && item.semanticAction === 'commit')!
    const response = await createPrepareTool({ getProjection: () => projection }).execute(
      { item_id: requirement.id, semantic_action: 'commit' } as never, undefined as never,
    ) as { compatibility: { status: string } }
    expect(response.compatibility.status).toBe('compatible')
  })
})

describe('hold-out 3 / K3: prepare and action agree on the same snapshot', () => {
  const prepareFor = async (projection: ReturnType<typeof createProjection>, item: GuardItem, action: string) => {
    projection.items.set(item.id, item)
    return createPrepareTool({ getProjection: () => projection }).execute(
      { item_id: item.id, semantic_action: action } as never, undefined as never,
    ) as Promise<Record<string, unknown>>
  }

  it('a resolution that lands on another repository is refused by both lanes', async () => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause('提交仓库 /srv/service 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/service' })
    const prepared = await prepareFor(projection, item, 'commit')
    // Prepare renders the assumption, and the gate refuses a different target.
    expect(prepared.status).toBe('prepared')
    expect(authorizeMutationFromProjection(projection, {
      action: 'commit', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { repository: '/srv/other', branch: 'main' },
    })).toMatchObject({ status: 'denied', reasonCode: 'mutation_requested_target_mismatch' })
  })

  it('a prohibition that arrives after preparation blocks the action', async () => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause('提交仓库 /srv/service 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/service' })
    const first = await prepareFor(projection, item, 'commit')
    expect((first.compatibility as { status: string }).status).toBe('compatible')
    const ban = captureClause('不要提交仓库 /srv/service 分支 main。', 'm2', 'P001', 2, { cwd: '/srv/service' })
    ban.kind = 'prohibition'
    ban.semanticAction = 'commit'
    ban.requestedTarget = { repository: '/srv/service', branch: 'main' }
    projection.items.set(ban.id, ban)
    const second = await prepareFor(projection, item, 'commit')
    expect((second.compatibility as { status: string }).status).toBe('blocked')
    expect((second.compatibility as { reason_codes: string[] }).reason_codes).toContain('conflicting_prohibition')
  })

  it('a caller target that differs is refused by BOTH lanes', async () => {
    // The caller's target is what the gate will compare, so preparation judges
    // THAT target against the obligation's own selection. A different branch is
    // `incompatible` here and denied there — one conclusion, two lanes.
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause('提交仓库 /srv/service 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/service' })
    projection.items.set(item.id, item)
    const response = await createPrepareTool({ getProjection: () => projection }).execute({
      item_id: item.id, semantic_action: 'commit',
      requested_target: { repository: '/srv/service', branch: 'experiment' },
    } as never, undefined as never) as Record<string, unknown>
    expect(response.status).toBe('incompatible')
    expect(response.reason_code).toBe('requested_resolved_target_mismatch')
    expect((response.compatibility as { target_compatible: boolean }).target_compatible).toBe(false)
    expect(response.evidence_input_contract).toBeUndefined()
    expect(authorizeMutationFromProjection(projection, {
      action: 'commit', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { repository: '/srv/service', branch: 'experiment' },
    })).toMatchObject({ status: 'denied', reasonCode: 'mutation_requested_target_mismatch' })
  })

  it('a caller target that MATCHES is compatible and still carries no authority', async () => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause('提交仓库 /srv/service 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/service' })
    projection.items.set(item.id, item)
    const response = await createPrepareTool({ getProjection: () => projection }).execute({
      item_id: item.id, semantic_action: 'commit',
      requested_target: { repository: '/srv/service', branch: 'main' },
    } as never, undefined as never) as Record<string, unknown>
    expect(response.status).toBe('prepared')
    expect(response.recipe_only).toBe(true)
    expect((response.compatibility as { status: string }).status).toBe('compatible')
    expect(response.caller_target_is_proposal).toBeUndefined()
    expect(authorizeMutationFromProjection(projection, {
      action: 'commit', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { repository: '/srv/service', branch: 'main' },
    }).status).not.toBe('denied')
  })
})

describe('hold-out 3 / K4: eligibility scope and the repair-round invariants', () => {
  const legacy = (over: Partial<GuardItem>): GuardItem => {
    const base: GuardItem = { ...captureClause('占位', 'm1', 'R001', 1, { cwd: '/srv/service' }), ...over }
    delete base.targetSource
    return base
  }

  it('a reviewed record in a required descendant unit blocks the parent', () => {
    const p = createProjection()
    p.enabled = true
    p.boundaryProtocol = 5
    p.currentUnitId = 'U001'
    p.units.set('U001', { unitId: 'U001', openedAtSeq: 1, rootInputRefs: [{ seq: 1 }], headline: 'parent' })
    p.units.set('U002', { unitId: 'U002', openedAtSeq: 2, rootInputRefs: [{ seq: 2 }], headline: 'child', parentUnitId: 'U001' })
    const item = legacy({
      unitId: 'U002', status: 'answered',
      needsReview: { reason: 'legacy_mixed_information_scope', checkId: 'eligibility:0.6.3', recordedAtRevision: 1 },
    })
    p.items.set(item.id, item)
    expect(needsReviewObligations(p).map((row) => row.id)).toEqual([item.id])
  })

  it('a sibling unit record never blocks the current one', () => {
    const p = createProjection()
    p.enabled = true
    p.boundaryProtocol = 5
    p.currentUnitId = 'U001'
    p.units.set('U001', { unitId: 'U001', openedAtSeq: 1, rootInputRefs: [{ seq: 1 }], headline: 'current' })
    p.units.set('U003', { unitId: 'U003', openedAtSeq: 3, rootInputRefs: [{ seq: 3 }], headline: 'sibling' })
    const item = legacy({
      unitId: 'U003', status: 'passed',
      needsReview: { reason: 'legacy_environment_default_target', checkId: 'eligibility:0.6.3', recordedAtRevision: 1 },
    })
    p.items.set(item.id, item)
    expect(needsReviewObligations(p)).toHaveLength(0)
  })

  it('a pass-then-answered pair in one unit is fully covered by the check', () => {
    const p = createProjection()
    p.enabled = true
    p.boundaryProtocol = 5
    p.currentUnitId = 'U001'
    const passed = legacy({
      id: 'R001', unitId: 'U001', status: 'passed',
      normalizedText: '安装主题 A，检查是否有更新。',
      needsReview: { reason: 'legacy_mixed_information_scope', checkId: 'eligibility:0.6.3', recordedAtRevision: 1 },
    })
    const answered = legacy({
      id: 'R002', unitId: 'U001', status: 'answered',
      normalizedText: '主题是否有新版本吗？',
      needsReview: { reason: 'legacy_environment_default_target', checkId: 'eligibility:0.6.3', recordedAtRevision: 1 },
    })
    p.items.set(passed.id, passed)
    p.items.set(answered.id, answered)
    expect(needsReviewObligations(p).map((row) => row.id).sort()).toEqual(['R001', 'R002'])
  })

  it('the current reader never marks a fresh capture, and the upgrade check still catches it from bytes', () => {
    const projection = derive([{ text: '安装主题 A，检查是否有更新。' }])
    // The current partition is correct, so no review fact is manufactured.
    expect(legacyRecordsNeedingReview(projection)).toEqual([])
    expect([...projection.items.values()].every((item) => item.needsReview === undefined)).toBe(true)
    // The same bytes read as an earlier release's single answered record ARE
    // flagged, which is what makes the upgrade safe.
    const historical = createProjection()
    historical.enabled = true
    const record = legacy({
      normalizedText: '安装主题 A，检查是否有更新。',
      directive: 'informational', authorityDisposition: 'informational', taskKind: 'inquiry',
      status: 'answered',
    })
    historical.items.set(record.id, record)
    expect(legacyRecordsNeedingReview(historical)).toHaveLength(1)
  })
})
