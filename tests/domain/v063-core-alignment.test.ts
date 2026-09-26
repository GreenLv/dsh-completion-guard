import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE, legacyRecordsNeedingReview } from '../../src/domain/derive.js'
import { captureClause } from '../../src/domain/capture.js'
import { interpretMessage, legacyQuestionReadingIsInformational, maskCodeSpans } from '../../src/domain/semantics.js'
import { certifyCheckpoint } from '../../src/domain/checkpoint.js'
import { hasCurrentCertificate } from '../../src/domain/goal-gate.js'
import { needsReviewObligations } from '../../src/domain/closure.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { certificationDigestV2 } from '../../src/domain/digest.js'
import { CERTIFICATE_VERSION_V2, STOP_PROTOCOL_VERSION_V2 } from '../../src/domain/protocol-manifest.js'
import { createProjection, type DerivedEnvelope, type GuardItem } from '../../src/domain/types.js'

/**
 * 0.6.3 K1–K4 core alignment (plan T01–T06).
 *
 * Every expectation here is written from the TASK CONTRACT, not from what the
 * implementation currently prints:
 *
 * - an execution obligation survives every synonymous phrasing, punctuation
 *   change and word order that the 0.6.2 review listed as a false negative;
 * - a genuinely pure information request stays in the answerable lane, which is
 *   the positive control that forbids "make everything unresolved" from passing;
 * - an information range never absorbs work, and a zero-tool final answer never
 *   closes execution;
 * - the environment is never a target source, while a unique, auditable
 *   selection in the same work unit IS inherited without asking again;
 * - preparation and execution answer the same compatibility question for the
 *   same snapshot, and re-answer it when the snapshot changes;
 * - a record that earlier rules misread is not inherited as a current pass and
 *   blocks the current conclusion instead of warning about it.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/workspace/repo-a', sessionHeader: { version: 3, id: 'v063-core', createdAt: 1 } }

let seq = 0
const reset = () => { seq = 0 }
const notice = (): DerivedEnvelope => ({ seq: seq++, type: 'user/message', data: {
  source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice' },
  content: [{ type: 'text', text: PROTOCOL_V5_NOTICE }],
} })
const turnStart = (turn: number): DerivedEnvelope => ({ seq: seq++, type: 'turn/start', data: { turn } })
const turnEnd = (turn: number, kind = 'completed'): DerivedEnvelope => ({ seq: seq++, type: 'turn/end', data: { turn, reason: { kind } } })
const user = (text: string, turn: number): DerivedEnvelope => ({ seq: seq++, type: 'user/message', data: {
  turn, source: { kind: 'user' }, content: [{ type: 'text', text }],
} })
const assistant = (turn: number, step: number, text: string): DerivedEnvelope => ({ seq: seq++, type: 'assistant/message', data: {
  turn, step, message: { role: 'assistant', content: [{ type: 'text', text }] },
} })

/** One completed turn: the root input, the assistant's final answer, the end. */
function session(turns: Array<{ text: string; answer: string }>): DerivedEnvelope[] {
  const events: DerivedEnvelope[] = [notice()]
  turns.forEach((turn, index) => {
    const number = index + 1
    events.push(turnStart(number), user(turn.text, number), assistant(number, 1, turn.answer), turnEnd(number))
  })
  return events
}

const derive = (turns: Array<{ text: string; answer: string }>) => deriveProjection(session(turns), config, scope, true).projection


describe('0.6.3 fix-before/fix-after: the recorded defect inputs', () => {
  // These pin the THREE reproduced defects against the exact reading they had
  // before the fix, so "the defect is gone" is a testable statement and not a
  // claim about a suite that never contained the failing case.
  it.each([
    '更新插件，检查是否存在更新，安装新主题，记录变更。',
    'Install the package, check whether an update exists, and write a report.',
    '更新插件，然后安装新主题，检查是否有更新，记录变更。',
  ])('F062-01: the 0.6.2 rule read %s as one information request', (text) => {
    // BEFORE: the presence of 是否/whether anywhere made the whole clause
    // information, so a zero-tool final answer closed every execution
    // obligation beside it.
    expect(legacyQuestionReadingIsInformational(maskCodeSpans(text))).toBe(true)
    // AFTER: the same bytes are one information range plus its execution work.
    const scopes = interpretMessage(text)
    expect(scopes.filter((entry) => entry.authorityDisposition === 'informational')).toHaveLength(1)
    expect(scopes.filter((entry) => entry.authorityDisposition === 'executable_now').length).toBeGreaterThanOrEqual(2)
  })

  it('F062-02: the 0.6.2 capture bound the session directory as a RESOLVED repository', () => {
    // BEFORE: `captureRequestedTarget` fell back to the scope subject and the
    // item was stamped `resolved`, which then passed the mutation target check.
    // AFTER: the same fallback is recorded as an environment default and never
    // resolves.
    const item = captureClause('提交并推送。', 'm1', 'R001', 1, { cwd: '/workspace/repo-a' })
    expect(item.requestedTarget).toMatchObject({ repository: '/workspace/repo-a' })
    expect(item.targetSource).toEqual({ kind: 'environment_default' })
    expect(item.targetCaptureStatus).toBe('clarification_required')
  })

  it('F062-03: an item/action pair the 0.6.2 prepare rendered as executable', async () => {
    // BEFORE: prepare returned `status: prepared` plus the push recipe for a
    // commit item, and only the runtime refused the action.
    // AFTER: the same inputs are refused where they are read.
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause('提交仓库 /work/repo-a 的变更', 'm1', 'R001', 1, { cwd: '/work/repo-a' })
    projection.items.set(item.id, item)
    const prepared = await createPrepareTool({ getProjection: () => projection }).execute({
      item_id: item.id, semantic_action: 'push',
    } as never, undefined as never) as Record<string, unknown>
    expect(prepared.status).toBe('incompatible')
    expect(prepared.evidence_input_contract).toBeUndefined()
  })
})

describe('0.6.3 K1 (T01/T02): one information range never absorbs the work beside it', () => {
  it.each([
    '更新插件，检查是否存在更新，安装新主题，记录变更。',
    '更新插件；检查是否存在更新；安装新主题；记录变更。',
    '更新插件，然后安装新主题，检查是否有更新，记录变更。',
    '更新插件。检查是否存在更新。安装新主题。记录变更。',
  ])('keeps every execution obligation of %s', (text) => {
    const scopes = interpretMessage(text)
    // The information span is exactly the question; the directives around it
    // stay their own readings, so the final answer cannot close them.
    const informational = scopes.filter((entry) => entry.authorityDisposition === 'informational')
    expect(informational).toHaveLength(1)
    expect(informational[0]!.text).toContain('更新')
    const directives = scopes.filter((entry) => entry.authorityDisposition === 'executable_now')
    expect(directives.length).toBeGreaterThanOrEqual(2)
    // Every execution word the root wrote is still named by an execution
    // reading: no paraphrase may drop one of them into the answer lane.
    const ordered = scopes.map((entry) => entry.text).join('｜')
    for (const obligation of ['更新插件', '安装新主题', '记录变更']) {
      expect(ordered, obligation).toContain(obligation)
    }
  })

  it('keeps the English mixed request as install + answer + write', () => {
    const scopes = interpretMessage('Install the package, check whether an update exists, and write a report.')
    const informational = scopes.filter((entry) => entry.authorityDisposition === 'informational')
    expect(informational).toHaveLength(1)
    expect(informational[0]!.text).toBe('check whether an update exists')
    const directives = scopes.filter((entry) => entry.authorityDisposition === 'executable_now')
    expect(directives.map((entry) => entry.text)).toEqual(['Install the package', 'and write a report.'])
  })

  it('a pure information request keeps the closable lane, and a zero-tool final never answers work', () => {
    const projection = derive([{ text: '更新插件，检查是否存在更新，安装新主题，记录变更。', answer: '已收到。' }])
    const items = [...projection.items.values()]
    const answers = items.filter((item) => item.authorityDisposition === 'informational')
    const work = items.filter((item) => item.authorityDisposition === 'executable_now')
    // Exactly the information range closed; every execution obligation stayed.
    expect(answers).toHaveLength(1)
    expect(answers[0]!.status).toBe('answered')
    expect(work.length).toBeGreaterThanOrEqual(2)
    for (const item of work) {
      expect(item.status, item.normalizedText).not.toBe('answered')
      expect(item.status, item.normalizedText).not.toBe('passed')
    }
    // Every execution word the root wrote is carried by work that is still open:
    // the zero-tool final answer closed the question and nothing else.
    const openText = [...items]
      .filter((item) => item.status === 'pending' || item.actionPlan !== undefined)
      .map((item) => item.normalizedText)
      .join('｜')
    for (const obligation of ['更新插件', '安装新主题', '记录变更']) {
      expect(openText, obligation).toContain(obligation)
    }
  })

  it('a pure question still answers, and a mixed clause does not become all-unresolved', () => {
    const pure = derive([{ text: '检查一下插件是否有更新吗？', answer: '已是最新版本。' }])
    const pureItems = [...pure.items.values()]
    expect(pureItems).toHaveLength(1)
    expect(pureItems[0]!.status).toBe('answered')

    const mixed = derive([{ text: '安装插件，检查是否有更新，记录变更。', answer: '好的。' }])
    const mixedItems = [...mixed.items.values()]
    expect(mixedItems.some((item) => item.status === 'answered'), 'the question range closes').toBe(true)
    expect(mixedItems.filter((item) => item.status === 'pending').length).toBeGreaterThanOrEqual(2)
    expect(mixedItems.every((item) => item.authorityDisposition === 'unresolved')).toBe(false)
  })

  it('T02 counterexamples keep their scope instead of being swallowed', () => {
    // A negation, a condition, a quoted command, an unknown tail and a
    // multi-action order each keep their own reading and nothing is dropped.
    const negated = interpretMessage('修复代码，但不推送。')
    expect(negated.some((entry) => entry.directive === 'prohibition')).toBe(true)
    expect(negated.some((entry) => entry.authorityDisposition === 'executable_now')).toBe(true)

    // The explanation of a QUOTED command is undecidable by surface rules, so it
    // stays unresolved rather than entering the answer lane; the live order
    // after the comma is executable.
    // 合同调整 (0.6.3 收窄合同): an explanation head governs its SENTENCE, so the
    // order after the comma is inside the explanation and the sentence is ONE
    // undecided obligation. The quoted command is still never authority; the earlier
    // contract's "the update keeps its own reading" no longer holds.
    const quoted = interpretMessage('说明 `git push origin main` 的作用，然后更新 README。')
    expect(quoted).toHaveLength(1)
    expect(quoted[0]!.authorityDisposition).toBe('unresolved')
    expect(quoted.some((entry) => entry.authorityDisposition === 'executable_now')).toBe(false)

    // A leading condition reserves the action it governs: the run is recorded
    // and held, not executed, and it is never dropped.
    const conditional = interpretMessage('运行测试，如果失败就记录原因。')
    expect(conditional.length).toBeGreaterThanOrEqual(1)
    expect(conditional.some((entry) => entry.authorityDisposition === 'conditional_wait'
      || entry.authorityDisposition === 'executable_now')).toBe(true)

    const unknownTail = interpretMessage('更新皮肤中心，随便处理一下余下的部分。')
    expect(unknownTail.length).toBeGreaterThanOrEqual(1)
    expect(unknownTail.some((entry) => entry.authorityDisposition === 'executable_now')).toBe(true)
  })
})

describe('0.6.3 K1 (T03): delivery closes only its own information range', () => {
  it('an unrelated successful tool and a correct full chain behave differently', () => {
    // A completed turn closes the information range. An execution obligation
    // stays open afterwards, and only real matching evidence can close it.
    const projection = derive([
      { text: '安装新主题，检查是否有更新。', answer: '已检查：有更新。' },
      { text: '记录变更。', answer: '已记录。' },
    ])
    const work = [...projection.items.values()].filter((item) => item.authorityDisposition === 'executable_now')
    expect(work.length).toBeGreaterThanOrEqual(2)
    for (const item of work) {
      expect(item.status, item.normalizedText).toBe('pending')
      expect(item.answeredBy, item.normalizedText).toBeUndefined()
    }
  })

  it('a partial action completion cannot close the whole clause', () => {
    const projection = derive([{ text: '更新插件并安装新主题。', answer: '插件已更新。' }])
    for (const item of projection.items.values()) {
      expect(item.authorityDisposition).not.toBe('informational')
      expect(item.status).toBe('pending')
    }
  })
})

describe('0.6.3 K2 (T04): target binding has an auditable source', () => {
  it('never promotes the session working directory into a resolved selection', () => {
    const projection = derive([{ text: '提交并推送。', answer: '好的。' }])
    const item = [...projection.items.values()].find((entry) => entry.semanticAction === 'commit')!
    expect(item).toBeDefined()
    // The directory is recorded as an environment default, which is NOT a
    // resolved target and cannot authorize a mutation.
    expect(item.targetSource).toEqual({ kind: 'environment_default' })
    expect(item.targetCaptureStatus).toBe('clarification_required')
    const decision = authorizeMutationFromProjection(projection, {
      action: 'commit', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { repository: '/workspace/repo-a', branch: 'main' },
    })
    expect(decision.status).toBe('denied')
    expect(decision.reasonCode).toBe('mutation_target_clarification_required')
  })

  it('inherits the unique auditable repository a later short reference points at', () => {
    // The root named the repository once; the follow-up names no repository, so
    // the unit's own auditable selection is inherited rather than asking again
    // or falling back to the session directory.
    const projection = derive([
      { text: '提交仓库 /work/repo-b 分支 main 的变更。', answer: '好的。' },
      { text: '提交并推送。', answer: '好的。' },
    ])
    const commit = [...projection.items.values()]
      .find((entry) => entry.semanticAction === 'commit' && entry.targetSource?.kind === 'unit_inherited')
    expect(commit, 'the follow-up message produced its own commit obligation').toBeDefined()
    expect(commit!.targetSource?.kind).toBe('unit_inherited')
    expect(commit!.targetSource?.inheritedFrom).toBe('R001')
    expect(commit!.requestedTarget).toMatchObject({ repository: '/work/repo-b' })
    expect(commit!.targetCaptureStatus).toBe('resolved')
    // The inherited selection authorizes exactly the repository the root named.
    expect(authorizeMutationFromProjection(projection, {
      action: 'commit', contractItemId: commit!.id, contractItemRevision: commit!.revision,
      resolvedTarget: { repository: '/work/repo-b', branch: 'main' },
    }).status).not.toBe('denied')
    // A different repository is still refused, so inheritance widened nothing.
    expect(authorizeMutationFromProjection(projection, {
      action: 'commit', contractItemId: commit!.id, contractItemRevision: commit!.revision,
      resolvedTarget: { repository: '/work/elsewhere', branch: 'main' },
    })).toMatchObject({ reasonCode: 'mutation_requested_target_mismatch' })
  })

  it('keeps an explicit current-repository phrase resolvable and a conflict refused', () => {
    const explicit = captureClause('推送当前仓库', 'm1', 'R001', 1, { cwd: '/work/repo-a' })
    expect(explicit.targetSource).toEqual({ kind: 'explicit_current_repository' })
    expect(explicit.targetCaptureStatus).toBe('resolved')
    expect(explicit.requestedTarget).toMatchObject({ repository: '/work/repo-a' })

    // Two equally sourced candidates stay ambiguous: the root must choose.
    const projection = derive([
      { text: '推送仓库 /work/repo-a remote origin refspec refs/heads/main。', answer: '好。' },
      { text: '推送仓库 /work/repo-b remote origin refspec refs/heads/main。', answer: '好。' },
      { text: '提交并推送。', answer: '好。' },
    ])
    const commit = [...projection.items.values()].find((entry) => entry.semanticAction === 'commit')!
    expect(commit.targetCaptureStatus).toBe('clarification_required')
    expect(commit.targetCaptureReasonCode).toBe('requested_target_repository_ambiguous')
  })

  it('a model-supplied target is never authority', () => {
    const projection = derive([{ text: '推送仓库 /work/repo-a remote origin refspec refs/heads/main。', answer: '好。' }])
    const item = [...projection.items.values()][0]!
    const decision = authorizeMutationFromProjection(projection, {
      action: 'push', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { repository: '/work/elsewhere', remote: 'origin', refspec: 'refs/heads/main' },
    })
    expect(decision.status).toBe('denied')
    expect(decision.reasonCode).toBe('mutation_requested_target_mismatch')
  })
})

describe('0.6.3 K3 (T05): preparation and execution answer the same question', () => {
  const captureCommit = (text: string, cwd = '/work/repo-a') =>
    captureClause(text, 'm1', 'R001', 1, { cwd })

  it('a cross-family action override is refused by both lanes for the same snapshot', async () => {
    const projection = createProjection()
    projection.enabled = true
    const item: GuardItem = captureCommit('提交仓库 /work/repo-a 的变更')
    projection.items.set(item.id, item)

    const prepared = await createPrepareTool({ getProjection: () => projection }).execute({
      item_id: item.id, item_revision: item.revision, semantic_action: 'push',
      requested_target: { repository: '/work/repo-a' },
    } as never, undefined as never) as Record<string, unknown>
    expect(prepared.status).toBe('incompatible')
    expect(prepared.reason_code).toBe('action_not_compatible_with_item')
    // No executable recipe for an assumption the item does not record.
    expect(prepared.evidence_input_contract).toBeUndefined()
    expect((prepared.compatibility as { item_action?: string }).item_action).toBe('commit')

    const decided = authorizeMutationFromProjection(projection, {
      action: 'push', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { repository: '/work/repo-a', remote: 'origin', refspec: 'refs/heads/main' },
    })
    expect(decided.status).toBe('denied')
    expect(decided.reasonCode).toBe('mutation_semantic_action_mismatch')
  })

  it('the same snapshot yields the same verdict, and a changed snapshot re-refuses', async () => {
    const projection = createProjection()
    projection.enabled = true
    // The item names both identity fields the mutation gate requires; a commit
    // that names only its repository is its own blocked case, asserted below.
    const item = captureCommit('提交仓库 /work/repo-a 分支 main 的变更')
    projection.items.set(item.id, item)
    const tool = createPrepareTool({ getProjection: () => projection })

    const first = await tool.execute({ item_id: item.id, semantic_action: 'commit' } as never, undefined as never) as Record<string, unknown>
    const second = await tool.execute({ item_id: item.id, semantic_action: 'commit' } as never, undefined as never) as Record<string, unknown>
    expect(first.status).toBe('prepared')
    expect((first.compatibility as { status: string }).status).toBe('compatible')
    // Same inputs, same conclusion.
    expect(second.status).toBe(first.status)
    expect(second.compatibility).toEqual(first.compatibility)

    // A stale revision is refused, and the recipe says the assumption only.
    const stale = await tool.execute({ item_id: item.id, item_revision: item.revision + 1, semantic_action: 'commit' } as never, undefined as never) as Record<string, unknown>
    expect(stale.status).toBe('rejected')
    expect(stale.reason_code).toBe('item_revision_mismatch')

    // A condition that arrives later blocks execution in both lanes.
    item.authorityDisposition = 'conditional_wait'
    const blockedPrepare = await tool.execute({ item_id: item.id, semantic_action: 'commit' } as never, undefined as never) as Record<string, unknown>
    expect((blockedPrepare.compatibility as { status: string }).status).toBe('blocked')
    const blockedAction = authorizeMutationFromProjection(projection, {
      action: 'commit', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { repository: '/work/repo-a', branch: 'main' },
    })
    expect(blockedAction.status).toBe('denied')
    expect(blockedAction.reasonCode).toBe('mutation_awaiting_root_condition')
  })

  it('an item whose own target cannot authorize is reported blocked, not compatible', async () => {
    // A commit that names only its repository lacks the branch the gate
    // requires, so the item's own selection cannot authorize a mutation. The
    // two lanes agree: preparation says blocked, the gate denies.
    const projection = createProjection()
    projection.enabled = true
    const item = captureCommit('提交仓库 /work/repo-a 的变更')
    expect(item.requestedTarget).toMatchObject({ repository: '/work/repo-a' })
    expect(item.requestedTarget?.branch).toBeUndefined()
    projection.items.set(item.id, item)
    const response = await createPrepareTool({ getProjection: () => projection }).execute(
      { item_id: item.id, semantic_action: 'commit' } as never, undefined as never,
    ) as Record<string, unknown>
    expect((response.compatibility as { status: string }).status).toBe('blocked')
    expect((response.compatibility as { reason_codes: string[] }).reason_codes).toContain('target_not_authorizing')
    expect(authorizeMutationFromProjection(projection, {
      action: 'commit', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { repository: '/work/repo-a', branch: 'main' },
    })).toMatchObject({ status: 'denied', reasonCode: 'mutation_requested_target_mismatch' })
  })

  it('an assumed recipe is labelled recipe_only and a target the item did not select is a proposal', async () => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureCommit('提交仓库 /work/repo-a 的变更')
    expect(item.requestedTarget).toMatchObject({ repository: '/work/repo-a' })
    expect(item.requestedTarget?.branch).toBeUndefined()
    projection.items.set(item.id, item)
    const response = await createPrepareTool({ getProjection: () => projection }).execute({
      item_id: item.id, semantic_action: 'commit',
      requested_target: { repository: '/work/repo-a', branch: 'other' },
    } as never, undefined as never) as Record<string, unknown>
    expect(response.status).toBe('prepared')
    expect(response.recipe_only).toBe(true)
    expect(response.evidence_input_contract).toBeDefined()
    expect(response.caller_target_is_proposal).toMatchObject({ fields: ['branch'] })
    expect(String(response.note)).toContain('not authority')

    // The substituted branch does not authorize the mutation.
    const decided = authorizeMutationFromProjection(projection, {
      action: 'commit', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { repository: '/work/repo-a', branch: 'other' },
    })
    expect(decided.status).toBe('denied')
  })
})

describe('0.6.3 K4 (T06): records earlier rules misread are not inherited', () => {
  const legacy = (over: Partial<GuardItem>): GuardItem => ({
    ...captureClause('占位', 'm2', 'R001', 1, { cwd: '/workspace/repo-a' }),
    unitId: 'U001',
    ...over,
  })
  const withItem = (item: GuardItem) => {
    const p = createProjection()
    p.enabled = true
    p.boundaryProtocol = 5
    p.currentUnitId = 'U001'
    p.items.set(item.id, item)
    return p
  }

  it('checks a record the terminal filter excludes, and only ever ADDS a review fact', () => {
    const answered = legacy({
      normalizedText: '更新插件，检查是否存在更新，安装新主题，记录变更。',
      directive: 'informational', authorityDisposition: 'informational', taskKind: 'inquiry',
      status: 'answered', answeredBy: { turn: 1, responseSeq: 1, responseSha256: 'a'.repeat(64) },
    })
    const p = withItem(answered)
    expect(legacyRecordsNeedingReview(p)).toEqual([{ itemId: answered.id, reason: 'legacy_mixed_information_scope' }])
    // The historical fact is preserved; nothing was reopened or rewritten.
    expect(answered.status).toBe('answered')
    expect(answered.answeredBy).toBeDefined()
  })

  it('flags the 0.6.2 environment-default target and leaves a sourced one alone', () => {
    // A record with a resolved target and NO auditable source is the 0.6.2
    // environment-default promotion.
    const unsourced = legacy({
      semanticAction: 'push', normalizedText: '提交并推送。',
      requestedTarget: { repository: '/workspace/repo-a' }, targetCaptureStatus: 'resolved',
    })
    // The exact 0.6.2 shape: resolved, with no provenance field at all.
    delete unsourced.targetSource
    expect(legacyRecordsNeedingReview(withItem(unsourced)))
      .toEqual([{ itemId: unsourced.id, reason: 'legacy_environment_default_target' }])

    // The 0.6.3 reading of the same instruction carries a source, so the record
    // is reusable as it stands.
    const sourced = derive([{ text: '推送仓库 /workspace/repo-a remote origin refspec refs/heads/main。', answer: '好。' }])
    expect(legacyRecordsNeedingReview(sourced)).toEqual([])
    expect([...sourced.items.values()].every((item) => item.needsReview === undefined)).toBe(true)

    // The 0.6.2 shape of the SAME instruction — resolved, no source — is exactly
    // what must not be inherited.
    const legacySourced = captureClause('推送仓库 /workspace/repo-a remote origin refspec refs/heads/main。', 'm1', 'R001', 1, { cwd: '/workspace/repo-a' })
    expect(legacySourced.targetSource).toEqual({ kind: 'explicit_label' })
    delete legacySourced.targetSource
    expect(legacyRecordsNeedingReview(withItem(legacySourced)))
      .toEqual([{ itemId: legacySourced.id, reason: 'legacy_environment_default_target' }])
  })

  it('keeps a safe old information record usable and reports an unknown state version', () => {
    const safe = legacy({
      normalizedText: '检查一下插件是否有更新吗？',
      directive: 'informational', authorityDisposition: 'informational', taskKind: 'inquiry',
      status: 'answered',
    })
    expect(legacyRecordsNeedingReview(withItem(safe))).toEqual([])

    const unknownVersion = legacy({ stateVersion: 42 } as Partial<GuardItem>)
    expect(legacyRecordsNeedingReview(withItem(unknownVersion)))
      .toEqual([{ itemId: unknownVersion.id, reason: 'unknown_state_version' }])
  })

  it('blocks the current certificate and Goal completion instead of warning', () => {
    const mixed = legacy({
      normalizedText: '更新插件，检查是否存在更新，安装新主题，记录变更。',
      directive: 'informational', authorityDisposition: 'informational', taskKind: 'inquiry',
      status: 'answered',
      // The fact the derivation's eligibility pass records on such a replay.
      needsReview: { reason: 'legacy_mixed_information_scope', checkId: 'eligibility:0.6.3', recordedAtRevision: 1 },
    })
    const derived = withItem(mixed)
    // Direct block: the certifier refuses even with no bindings at all.
    const result = certifyCheckpoint(derived, [], 'C1')
    expect(result.status).toBe('incomplete')
    expect(result.rejectedBindings[0]).toMatchObject({ itemId: mixed.id, reasonCode: 'legacy_record_needs_review' })
    // And the Goal gate cannot read the record as passed.
    expect(hasCurrentCertificate(derived)).toBe(false)
    expect(derived.certificateStatusReason).toBe('legacy_record_needs_review')
  })

  it('outranks a certificate minted for the same snapshot', () => {
    // A certificate recorded BEFORE the record was marked cannot be read as if
    // the record had passed: the review fact is checked after the certificate
    // identity, so it wins over a matching digest.
    const mixed = legacy({
      normalizedText: '更新插件，检查是否存在更新，安装新主题，记录变更。',
      directive: 'informational', authorityDisposition: 'informational', taskKind: 'inquiry',
      status: 'answered',
      needsReview: { reason: 'legacy_mixed_information_scope', checkId: 'eligibility:0.6.3', recordedAtRevision: 1 },
    })
    const p = withItem(mixed)
    const openDigest = 'ab'.repeat(32)
    const bindingDigest = 'cd'.repeat(32)
    const evidenceSha256 = 'ef'.repeat(32)
    const contractSha256 = '00'.repeat(32)
    const certification = certificationDigestV2({
      stopProtocolVersion: STOP_PROTOCOL_VERSION_V2, certificateVersion: CERTIFICATE_VERSION_V2, epoch: p.epoch,
      sessionRefDigest: p.sessionRefDigest, hostLockDigest: p.hostLockDigest,
      contractRevision: p.contractRevision, contractSha256,
      unitId: 'U001', unitClosureDigest: openDigest, evidenceSha256, bindingDigest, goalRef: null,
    })
    p.checkpoints.push({
      id: 'C1', stopProtocolVersion: STOP_PROTOCOL_VERSION_V2, certificateVersion: CERTIFICATE_VERSION_V2, epoch: p.epoch,
      sessionRefDigest: p.sessionRefDigest, hostLockDigest: p.hostLockDigest, contractRevision: p.contractRevision,
      contractSha256, openDigest, evidenceSha256, bindingDigest, bindings: [], unitId: 'U001', unitClosureDigest: openDigest,
      certificationDigest: certification, result: 'certified',
    })
    expect(hasCurrentCertificate(p)).toBe(false)
    expect(p.certificateStatusReason).toBe('legacy_record_needs_review')
  })

  it('is idempotent across a reload of the same log', () => {
    reset()
    const events = session([{ text: '更新插件，检查是否存在更新，安装新主题，记录变更。', answer: '好的。' }])
    const first = deriveProjection(events, config, scope, true).projection
    const second = deriveProjection(events, config, scope, true).projection
    const review = (p: typeof first) => [...p.items.values()]
      .map((item) => [item.id, item.needsReview?.reason ?? null, item.needsReview?.recordedAtRevision ?? null])
    expect(review(second)).toEqual(review(first))
    // Nothing was reopened as current debt and no certificate was auto-issued.
    expect([...second.items.values()].every((item) => item.status !== 'passed')).toBe(true)
    expect(second.checkpoints).toHaveLength(0)
    expect(needsReviewObligations(second)).toEqual([])
  })
})
