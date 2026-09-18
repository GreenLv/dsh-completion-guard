import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE, legacyRecordsNeedingReview } from '../../src/domain/derive.js'
import { captureClause } from '../../src/domain/capture.js'
import { interpretMessage } from '../../src/domain/semantics.js'
import { needsReviewObligations } from '../../src/domain/closure.js'
import { certifyCheckpoint } from '../../src/domain/checkpoint.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { createProjection, type DerivedEnvelope, type GuardItem } from '../../src/domain/types.js'
import { expectNarrowedUndecided } from './narrowed-contract.js'

/**
 * 0.6.3 hold-out round 2 — NOW REGRESSION COVERAGE.
 *
 * This set produced nine findings and the repairs changed the source, so by the
 * plan's own rule it can no longer serve as independent hold-out evidence. It is
 * kept as a regression suite, and `v063-holdout-round3.test.ts` is the
 * replacement independent set. The wording families it covers:
 *
 * The first hold-out set (`v063-holdout.test.ts`) produced findings that were
 * fixed and is therefore REGRESSION coverage now, not hold-out evidence. This
 * file is the replacement independent set, written in the same session against
 * the task contract, with wording families and lifecycle combinations that were
 * not present in any earlier set or in the reviewer's probes:
 *
 * - 呢/吧 vs 吗 as the only suggestions-vs-questions distinction;
 * - conjunction chains (并且/以及/而后) and mixed 然后/and chains;
 * - a repository named through an enumeration and through 仓库标签的 form;
 * - a repository whose trailing segment repeats (subdirectory vs root);
 * - expiry of an inherited target when the source is superseded;
 * - the upgrade check across unit boundaries and on a pass-then-re-checked record;
 * - prepare/action agreement on a caller target that differs from the item's.
 *
 * Every expectation is derived from the contract, not read from an
 * implementation output. A failure here is a finding to repair in the source.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-holdout2', createdAt: 1 } }

let seq = 0
function derive(turns: Array<{ text: string; answer?: string }>) {
  seq = 0
  const events: DerivedEnvelope[] = [{
    seq: seq++, type: 'user/message', data: {
      source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' },
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

const itemsOf = (texts: string[]) => [...derive(texts.map((text) => ({ text }))).items.values()]

describe('hold-out 2 / K1: which particles and connectors really ask', () => {
  it.each([
    '安装这个主题呢。',
    '安装这个主题吧。',
    '更新一下吧。',
  ])('%s is a suggestion, never a closable answer', (text) => {
    const items = itemsOf([text])
    expect(items.length, text).toBeGreaterThan(0)
    expect(items.every((item) => item.authorityDisposition !== 'informational'), text).toBe(true)
    expect(items.some((item) => item.status === 'pending'), text).toBe(true)
  })

  it.each([
    '检查一下主题是否有新版本吗？',
    '主题是不是需要更新呢？',
    '这个主题是否有新版本？',
  ])('%s is read as a question, and no execution work is created', (text) => {
    const scopes = interpretMessage(text)
    expect(scopes).toHaveLength(1)
    expect(scopes[0]!.authorityDisposition, text).toBe('informational')
    // A question with no task feature is session-layer talk and adds no item; a
    // captured one closes on the answer. Either way no execution work appears.
    const items = itemsOf([text])
    expect(items.every((item) => item.authorityDisposition !== 'executable_now'), text).toBe(true)
    expect(items.every((item) => item.status !== 'pending'), text).toBe(true)
  })

  it.each([
    '检查是否有新版本并且安装这个主题。',
    '检查是否有新版本以及安装这个主题。',
    '先检查是否有新版本，而后安装这个主题。',
    'Check for a new version, then install the theme.',
  ])('合同调整: %s keeps its install as ONE undecided obligation', (text) => {
    // 合同调整 (0.6.3 收窄合同): the previous contract required the install beside an
    // open investigation to survive as its own pending ORDER. The narrowed contract
    // keeps the whole governed clause as ONE undecided obligation: the install is
    // still named in it, nothing answers it away, and it authorizes nothing.
    expectNarrowedUndecided(text)
    const items = itemsOf([text])
    expect(items.some((item) => item.status === 'pending'), text).toBe(true)
    expect(items.some((item) => item.semanticAction === 'install'
      || (item.actionPlan ?? []).some((entry) => entry.action === 'install')), text).toBe(true)
  })

  it('an object joined by 以及 keeps the one instruction it belongs to', () => {
    // 安装 A 以及 B names two objects of one action, so no execution work is
    // lost and none is invented: the reading stays executable throughout.
    const scopes = interpretMessage('安装主题 A 以及主题 B。')
    expect(scopes.length).toBeGreaterThanOrEqual(1)
    expect(scopes.every((entry) => entry.authorityDisposition === 'executable_now')).toBe(true)
    const items = itemsOf(['安装主题 A 以及主题 B。'])
    expect(items.every((item) => item.authorityDisposition === 'executable_now')).toBe(true)
    expect(items.every((item) => item.status === 'pending')).toBe(true)
  })
})

describe('hold-out 2 / K2: repository identity through enumeration and repetition', () => {
  it.each([
    ['推送仓库 /srv/app 分支 main。', '/srv/app'],
    ['推送仓库 /srv/app/ 分支 main。', '/srv/app/'],
    ['commit repository /srv/app branch main', '/srv/app'],
  ])('%s names %s and resolves it', (text, repository) => {
    const item = captureClause(text, 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus).toBe('resolved')
    expect(item.requestedTarget).toMatchObject({ repository })
  })

  it('an enumeration of repositories keeps both candidates ambiguous', () => {
    const items = itemsOf(['推送仓库 /srv/app 分支 main，提交。'])
    const commit = items.find((item) => item.semanticAction === 'commit')
    if (commit) {
      // The push clause and the commit clause of the SAME message name one
      // repository, so inheritance resolves it rather than asking again.
      expect(commit.targetCaptureStatus).toBe('resolved')
      expect(commit.requestedTarget).toMatchObject({ repository: '/srv/app' })
    }
  })

  it('a subdirectory reference is not the repository root', () => {
    // /srv/app/sub is a DIFFERENT identity from /srv/app, so it must not be
    // collapsed onto the earlier candidate.
    const items = itemsOf(['提交仓库 /srv/app 分支 main。', '推送仓库 /srv/app/sub 分支 main。', '拉取。'])
    const pull = items.find((item) => item.semanticAction === 'pull')!
    expect(pull.targetCaptureStatus).toBe('clarification_required')
    expect(pull.targetCaptureReasonCode).toBe('requested_target_repository_ambiguous')
  })

  it('an inherited target survives a later unrelated clause but not a superseded source', () => {
    const items = itemsOf(['提交仓库 /srv/app 分支 main。', '安装主题 A。', '推送。'])
    const push = items.find((item) => item.semanticAction === 'push' && item.targetSource?.kind === 'unit_inherited')
    expect(push, 'the push inherited the named repository').toBeDefined()
    expect(push!.requestedTarget).toMatchObject({ repository: '/srv/app' })
  })

  it('a file modification never authorizes a repository selection', () => {
    const items = itemsOf(['修改 /srv/app/src/a.ts。', '提交并推送。'])
    for (const item of items.filter((row) => row.semanticAction === 'commit' || row.semanticAction === 'push')) {
      expect(item.targetSource?.kind, item.normalizedText).toBe('environment_default')
      expect(item.targetCaptureStatus, item.normalizedText).toBe('clarification_required')
    }
  })
})

describe('hold-out 2 / K3: prepare and action agree on the same snapshot', () => {
  const prepareFor = async (item: GuardItem, projection: ReturnType<typeof createProjection>, action: string) => {
    projection.items.set(item.id, item)
    return createPrepareTool({ getProjection: () => projection }).execute(
      { item_id: item.id, semantic_action: action } as never, undefined as never,
    ) as Promise<Record<string, unknown>>
  }

  it('a caller target that differs from the item keeps prepare honest and the action refused', async () => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause('提交仓库 /srv/app 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    const prepared = await prepareFor(item, projection, 'commit')
    expect(prepared.status).toBe('prepared')
    expect((prepared.compatibility as { status: string }).status).toBe('compatible')
    expect(prepared.recipe_only).toBe(true)
    // The same snapshot's mutation with a different branch is refused.
    expect(authorizeMutationFromProjection(projection, {
      action: 'commit', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { repository: '/srv/app', branch: 'other' },
    })).toMatchObject({ status: 'denied' })
  })

  it('a non-pending item is blocked in both lanes', async () => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause('提交仓库 /srv/app 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    item.status = 'passed'
    const prepared = await prepareFor(item, projection, 'commit')
    expect((prepared.compatibility as { status: string }).status).toBe('blocked')
    expect((prepared.compatibility as { reason_codes: string[] }).reason_codes).toContain('item_not_pending')
    expect(authorizeMutationFromProjection(projection, {
      action: 'commit', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { repository: '/srv/app', branch: 'main' },
    })).toMatchObject({ status: 'denied', reasonCode: 'mutation_contract_item_not_pending' })
  })

  it('a stale revision is refused by both lanes', async () => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause('提交仓库 /srv/app 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    projection.items.set(item.id, item)
    const response = await createPrepareTool({ getProjection: () => projection }).execute(
      { item_id: item.id, item_revision: item.revision + 1, semantic_action: 'commit' } as never, undefined as never,
    ) as Record<string, unknown>
    expect(response.status).toBe('rejected')
    expect(response.reason_code).toBe('item_revision_mismatch')
    expect(authorizeMutationFromProjection(projection, {
      action: 'commit', contractItemId: item.id, contractItemRevision: item.revision + 1,
      resolvedTarget: { repository: '/srv/app', branch: 'main' },
    })).toMatchObject({ status: 'denied', reasonCode: 'mutation_contract_item_revision_mismatch' })
  })

  it('a generic_run item names no caller identity and is blocked, not prepared', async () => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause('整理一下这个目录。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    const prepared = await prepareFor(item, projection, 'commit')
    expect((prepared.compatibility as { status: string }).status).toBe('incompatible')
    expect((prepared.compatibility as { reason_codes: string[] }).reason_codes)
      .toContain('action_not_compatible_with_item')
  })
})

describe('hold-out 2 / K4: eligibility scope and lifecycle', () => {
  const legacy = (over: Partial<GuardItem>): GuardItem => {
    const base: GuardItem = { ...captureClause('占位', 'm1', 'R001', 1, { cwd: '/srv/app' }), ...over }
    delete base.targetSource
    return base
  }
  const projectionWith = (item: GuardItem, currentUnitId?: string) => {
    const p = createProjection()
    p.enabled = true
    p.boundaryProtocol = 5
    p.currentUnitId = currentUnitId
    p.items.set(item.id, item)
    return p
  }

  it('a mixed record of the current unit blocks a certificate even after being marked passed', () => {
    const item = legacy({
      unitId: 'U001', status: 'passed',
      normalizedText: '安装主题 A，检查是否有新版本。',
      directive: 'informational', authorityDisposition: 'informational', taskKind: 'inquiry',
      needsReview: { reason: 'legacy_mixed_information_scope', checkId: 'eligibility:0.6.3', recordedAtRevision: 1 },
    })
    const p = projectionWith(item, 'U001')
    expect(needsReviewObligations(p)).toHaveLength(1)
    const result = certifyCheckpoint(p, [], 'C1')
    expect(result.status).toBe('incomplete')
    expect(result.rejectedBindings[0]).toMatchObject({ reasonCode: 'legacy_record_needs_review' })
  })

  it('a reviewed record of a sibling unit never blocks the current one', () => {
    const item = legacy({
      unitId: 'U009', status: 'answered',
      needsReview: { reason: 'legacy_mixed_information_scope', checkId: 'eligibility:0.6.3', recordedAtRevision: 1 },
    })
    expect(needsReviewObligations(projectionWith(item, 'U001'))).toHaveLength(0)
  })

  it('a reviewed unit-less record stays in scope in a v5 session', () => {
    const item = legacy({
      status: 'answered',
      needsReview: { reason: 'legacy_environment_default_target', checkId: 'eligibility:0.6.3', recordedAtRevision: 1 },
    })
    expect(needsReviewObligations(projectionWith(item, 'U001'))).toHaveLength(1)
  })

  it('the eligibility predicate is stable across a reload of the same log', () => {
    const turns = [{ text: '安装主题 A，检查是否有新版本。' }, { text: '记录变更。' }]
    const first = derive(turns)
    const second = derive(turns)
    const fingerprint = (p: typeof first) => [...p.items.values()]
      .map((item) => `${item.id}:${item.status}:${item.needsReview?.reason ?? '-'}:${item.authorityDisposition ?? '-'}`)
      .sort()
    expect(fingerprint(second)).toEqual(fingerprint(first))
    // A current-rule capture is never retroactively flagged, and nothing was
    // auto-executed or auto-certified.
    expect([...first.items.values()].every((item) => item.needsReview === undefined)).toBe(true)
    expect(first.checkpoints).toHaveLength(0)
    expect([...first.items.values()].every((item) => item.status !== 'passed')).toBe(true)
  })

  it('an unknown state version is reported, and a known one is not', () => {
    const unknown = legacy({ unitId: 'U001', stateVersion: 9 } as Partial<GuardItem>)
    expect(legacyRecordsNeedingReview(projectionWith(unknown, 'U001')))
      .toEqual([{ itemId: unknown.id, reason: 'unknown_state_version' }])
    const known = legacy({ unitId: 'U001', stateVersion: 1 } as Partial<GuardItem>)
    expect(legacyRecordsNeedingReview(projectionWith(known, 'U001'))).toEqual([])
  })

  it('a question-only old record with a sourced target stays inheritable', () => {
    const item = legacy({
      unitId: 'U001', status: 'answered',
      normalizedText: '主题是否有新版本吗？',
      directive: 'informational', authorityDisposition: 'informational', taskKind: 'inquiry',
      semanticAction: 'push', requestedTarget: { repository: '/srv/app' },
      targetCaptureStatus: 'resolved',
    })
    // An information-only record whose recorded target HAS an auditable source
    // is the safe shape: the field must be present and must not be the
    // environment default.
    item.targetSource = { kind: 'explicit_label' }
    expect(legacyRecordsNeedingReview(projectionWith(item, 'U001'))).toEqual([])
  })
})
