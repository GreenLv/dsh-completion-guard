import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE, legacyRecordsNeedingReview } from '../../src/domain/derive.js'
import { captureClause } from '../../src/domain/capture.js'
import { interpretMessage } from '../../src/domain/semantics.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { createProjection, type DerivedEnvelope, type GuardItem } from '../../src/domain/types.js'

/**
 * 0.6.3 hold-out round 1 — NOW REGRESSION COVERAGE.
 *
 * This set produced findings; the repairs changed the source and two of its own
 * expectations were corrected, so it is regression coverage and not independent
 * hold-out evidence. `v063-holdout-round3.test.ts` is the current independent set.
 *
 * 0.6.3 hold-out set.
 *
 * These cases were NOT used to tune the K1–K4 implementation: they are
 * paraphrases, punctuation variants and lifecycle combinations designed against
 * the task contract after the implementation was frozen for this batch. They
 * use the same independent-expectation discipline as the core set — every
 * expectation is written from the contract, never copied from an implementation
 * output — and they are kept separate so a failure here is a real finding
 * rather than a retuned core case.
 *
 * The historical 0.6.3 batch report is linked from docs/README.md.
 * Once fixed, each hold-out failure becomes a regression case.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-holdout', createdAt: 1 } }

let seq = 0
const reset = () => { seq = 0 }
const notice = (): DerivedEnvelope => ({ seq: seq++, type: 'user/message', data: {
  source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' },
  content: [{ type: 'text', text: PROTOCOL_V5_NOTICE }],
} })
const user = (text: string, turn: number): DerivedEnvelope => ({ seq: seq++, type: 'user/message', data: {
  turn, source: { kind: 'user' }, content: [{ type: 'text', text }],
} })
const assistant = (turn: number, text: string): DerivedEnvelope => ({ seq: seq++, type: 'assistant/message', data: {
  turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] },
} })
const turnEnd = (turn: number): DerivedEnvelope => ({ seq: seq++, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
const turnStart = (turn: number): DerivedEnvelope => ({ seq: seq++, type: 'turn/start', data: { turn } })

function derive(turns: Array<{ text: string; answer: string }>) {
  reset()
  const events: DerivedEnvelope[] = [notice()]
  turns.forEach((turn, index) => {
    const number = index + 1
    events.push(turnStart(number), user(turn.text, number), assistant(number, turn.answer), turnEnd(number))
  })
  return deriveProjection(events, config, scope, true).projection
}

describe('0.6.3 hold-out: synonyms and punctuation must not change authorization', () => {
  it.each([
    '更新插件、检查是否有更新、安装新主题、记录变更。',
    '更新插件, 检查有没有更新, 安装新主题, 记录变更.',
    '请更新插件，检查一下是否有更新，并安装新主题，同时记录变更。',
    'Update the plugin; check whether an update exists; install the new theme; write the change log.',
  ])('keeps execution and information separate for %s', (text) => {
    const scopes = interpretMessage(text)
    const informational = scopes.filter((entry) => entry.authorityDisposition === 'informational')
    expect(informational, text).toHaveLength(1)
    const directives = scopes.filter((entry) => entry.authorityDisposition === 'executable_now')
    expect(directives.length, text).toBeGreaterThanOrEqual(2)
    const reading = scopes.map((entry) => entry.text).join('｜')
    // The synonym set must not change WHICH work is authorized: the plugin
    // update, the theme install and the change record are all still named.
    expect(reading, text).toMatch(/更新|update/i)
    expect(reading, text).toMatch(/安装|install/i)
    expect(reading, text).toMatch(/记录|write|report|log/i)
  })

  it('a mixed request in a v5 session still answers only its information range', () => {
    const projection = derive([{ text: '安装新主题，检查有没有更新，写出变更记录。', answer: '已检查，没有更新。' }])
    const items = [...projection.items.values()]
    expect(items.filter((item) => item.status === 'answered')).toHaveLength(1)
    expect(items.filter((item) => item.status === 'answered')[0]!.normalizedText).toContain('更新')
    expect(items.filter((item) => item.status === 'pending').length).toBeGreaterThanOrEqual(2)
  })

  it('a two-turn session keeps both turns\u2019 work open when neither has evidence', () => {
    const projection = derive([
      { text: '更新插件，检查是否成功。', answer: '已更新。' },
      { text: '安装新主题。', answer: '已安装。' },
    ])
    const work = [...projection.items.values()].filter((item) => item.authorityDisposition === 'executable_now')
    expect(work.length).toBeGreaterThanOrEqual(2)
    for (const item of work) expect(item.status).toBe('pending')
  })
})

describe('0.6.3 hold-out: target provenance under paraphrase', () => {
  it.each([
    ['提交 /srv/app 的改动', 'explicit_path', '/srv/app'],
    ['提交仓库 /srv/app 的改动', 'explicit_label', '/srv/app'],
    ['提交当前目录的改动', 'explicit_current_repository', '/srv/app'],
    ['commit repository /srv/app', 'explicit_label', '/srv/app'],
  ] as const)('%s resolves through %s', (text, kind, repository) => {
    const item = captureClause(text, 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.semanticAction).toBe('commit')
    expect(item.targetSource).toEqual({ kind })
    expect(item.targetCaptureStatus).toBe('resolved')
    expect(item.requestedTarget).toMatchObject({ repository })
  })

  it.each([
    '提交并推送。',
    'commit and push',
    '把改动提交并推送',
    '提交这个改动',
  ])('%s leaves the target unresolved instead of using the session directory', (text) => {
    const item = captureClause(text, 'm1', 'R001', 1, { cwd: '/srv/app' })
    if (item.semanticAction !== 'commit' && item.semanticAction !== 'push') return
    expect(item.targetSource).toEqual({ kind: 'environment_default' })
    expect(item.targetCaptureStatus).toBe('clarification_required')
    expect(item.targetCaptureReasonCode).toBe('requested_target_repository_missing')
  })

  it('a session that names the repository once lets the short follow-up inherit it', () => {
    const projection = derive([
      { text: '提交仓库 /srv/app 分支 release 的改动。', answer: '好。' },
      { text: '推送。', answer: '好。' },
    ])
    const push = [...projection.items.values()]
      .find((item) => item.sourceMessageId.startsWith('m') && item.semanticAction === 'push' && item.targetSource?.kind === 'unit_inherited')
    expect(push, 'the follow-up push inherited the unit target').toBeDefined()
    expect(push!.requestedTarget).toMatchObject({ repository: '/srv/app' })
  })
})

describe('0.6.3 hold-out: prepare and execute stay consistent under paraphrase', () => {
  const prepareFor = async (item: GuardItem, action: string) => {
    const projection = createProjection()
    projection.enabled = true
    projection.items.set(item.id, item)
    return createPrepareTool({ getProjection: () => projection }).execute(
      { item_id: item.id, semantic_action: action } as never, undefined as never,
    ) as Promise<Record<string, unknown>>
  }

  it('an install item refuses a restart override and names its own action', async () => {
    const item = captureClause('安装 synthetic-plugin 插件。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    const response = await prepareFor(item, 'restart')
    expect(response.status).toBe('incompatible')
    expect(response.reason_code).toBe('action_not_compatible_with_item')
    expect((response.compatibility as { item_action: string }).item_action).toBe('install')
  })

  it('the same install item prepares cleanly once the ROOT named its selector', async () => {
    // The gate takes coverage from the ROOT's own selection, so an instruction
    // that names the profile as well is the shape that can be authorized. A
    // caller cannot supply the missing authority.
    const item = captureClause('安装 synthetic-plugin@1.0.0 插件 profile default。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.requestedTarget).toMatchObject({ package_id: 'synthetic-plugin', version: '1.0.0', profile: 'default' })
    const projection = createProjection()
    projection.enabled = true
    projection.items.set(item.id, item)
    const response = await createPrepareTool({ getProjection: () => projection }).execute({
      item_id: item.id, semantic_action: 'install',
      requested_target: { package_id: 'synthetic-plugin', version: '1.0.0', profile: 'default' },
    } as never, undefined as never) as Record<string, unknown>
    expect(response.status).toBe('prepared')
    expect((response.compatibility as { status: string }).status).toBe('compatible')
    expect((response.compatibility as { target_compatible: boolean }).target_compatible).toBe(true)
  })

  it('a caller cannot supply the identity the root never named', async () => {
    // The clause names only the package; the caller adds the profile. Coverage
    // comes from the obligation, so preparation is blocked and the gate denies.
    const item = captureClause('安装 synthetic-plugin 插件。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    const projection = createProjection()
    projection.enabled = true
    projection.items.set(item.id, item)
    const callerTarget = { package_id: 'synthetic-plugin', version: '1.0.0', profile: 'default' }
    const response = await createPrepareTool({ getProjection: () => projection }).execute({
      item_id: item.id, semantic_action: 'install', requested_target: callerTarget,
    } as never, undefined as never) as Record<string, unknown>
    expect((response.compatibility as { status: string }).status).toBe('blocked')
    expect((response.compatibility as { reason_codes: string[] }).reason_codes).toContain('target_not_authorizing')
    expect(authorizeMutationFromProjection(projection, {
      action: 'install', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: callerTarget as Parameters<typeof authorizeMutationFromProjection>[1]['resolvedTarget'],
    })).toMatchObject({ status: 'denied' })
  })

  it('an item whose own target is incomplete is blocked, not compatible', async () => {
    const item = captureClause('安装 synthetic-plugin 插件。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    const response = await prepareFor(item, 'install')
    expect((response.compatibility as { status: string }).status).toBe('blocked')
    expect((response.compatibility as { reason_codes: string[] }).reason_codes).toContain('target_not_authorizing')
  })

  it('a legacy-flagged item is blocked in both lanes, not silently prepared', async () => {
    const item = captureClause('安装 synthetic-plugin 插件。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    item.legacyFlags = ['legacy_generic_run', 'legacy_authority_unclassified']
    const response = await prepareFor(item, 'install')
    expect((response.compatibility as { status: string }).status).toBe('blocked')
    expect((response.compatibility as { reason_codes: string[] }).reason_codes).toContain('legacy_rebind_required')
    const projection = createProjection()
    projection.enabled = true
    projection.items.set(item.id, item)
    expect(authorizeMutationFromProjection(projection, {
      action: 'install', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { package_id: 'synthetic-plugin', version: '1.0.0', profile: 'default' },
    })).toMatchObject({ reasonCode: 'mutation_legacy_rebind_required' })
  })
})

describe('0.6.3 hold-out: legacy eligibility does not reopen safe records', () => {
  const legacy = (over: Partial<GuardItem>): GuardItem => {
    const base: GuardItem = {
      ...captureClause('占位', 'm2', 'R001', 1, { cwd: '/srv/app' }),
      unitId: 'U001',
      ...over,
    }
    delete base.targetSource
    return base
  }
  const projectionWith = (item: GuardItem) => {
    const p = createProjection()
    p.enabled = true
    p.boundaryProtocol = 5
    p.currentUnitId = 'U001'
    p.items.set(item.id, item)
    return p
  }

  it.each([
    ['安装新主题，检查是否有更新。', 'legacy_mixed_information_scope'],
    ['安装新主题，确认是否成功。', 'legacy_mixed_information_scope'],
    ['更新插件，检查是否有更新，记录变更。', 'legacy_mixed_information_scope'],
  ])('%s is not inherited as a pass', (text, reason) => {
    const item = legacy({
      normalizedText: text, directive: 'informational', authorityDisposition: 'informational',
      taskKind: 'inquiry', status: 'answered',
    })
    expect(legacyRecordsNeedingReview(projectionWith(item)))
      .toEqual([{ itemId: item.id, reason }])
  })

  it.each([
    '检查一下插件是否有更新吗？',
    'Is there any update for the plugin?',
    '看看怎么弄',
  ])('%s stays safely inheritable', (text) => {
    const item = legacy({
      normalizedText: text, directive: 'informational', authorityDisposition: 'informational',
      taskKind: 'inquiry', status: 'answered',
    })
    expect(legacyRecordsNeedingReview(projectionWith(item))).toEqual([])
  })

  it('a legacy state version is reported instead of assumed', () => {
    const item = legacy({ stateVersion: 7 } as Partial<GuardItem>)
    expect(legacyRecordsNeedingReview(projectionWith(item)))
      .toEqual([{ itemId: item.id, reason: 'unknown_state_version' }])
  })
})
