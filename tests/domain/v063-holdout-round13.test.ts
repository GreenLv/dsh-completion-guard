import { describe, expect, it } from 'vitest'
import { deriveProjection, legacyRecordsNeedingReview, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { interpretMessage, isQuestionScopeNeedingReview } from '../../src/domain/semantics.js'
import { captureClause } from '../../src/domain/capture.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope, type GuardItem } from '../../src/domain/types.js'
import { expectNarrowedUndecided } from './narrowed-contract.js'

/**
 * 0.6.3 hold-out round 13 — regression coverage (was the independent set).
 *
 * Round 12 found nothing of its own, but the TENTH review then required that a
 * bare question head carry its non-execution qualification into every child;
 * that repair changed the source, so round 12 is regression coverage. Round 13
 * was written after the eleventh repair round, in shape families absent from
 * rounds 1-12 and the ten review batches:
 *
 * - question heads the earlier sets never used: other question words (`When`,
 *   `Why`), a modal auxiliary (`Should we …`), a politeness preface around an
 *   explanation (`Could you describe …`), and Chinese subject variations;
 * - investigation IMPERATIVES whose coordinated order must keep its own
 *   execution authority, and mixed messages whose ORDER heads the clause;
 * - the refusal decided against the obligation's own captured target;
 * - per-field inheritance with a conflicting branch beside a third clause that
 *   names the branch itself, and with a conflicting remote/refspec pair;
 * - eligibility on a recorded question-scope text and on a recorded
 *   investigation-mixed text.
 *
 * It found TWO source defects in the same family — a temporal interrogative
 * (`When should I install … ?`, which the condition splitter cut into a bare order
 * plus a condition) and a Chinese question whose subject pronoun stands before the
 * interrogative (`你们如何安装 … 并重启 …`), which lost the question scope entirely
 * and produced executable children. Both were repaired, so this set is REGRESSION
 * COVERAGE and round 14 is the current independent set; three of its own
 * expectations were also wrong and are recorded in place.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-holdout13', createdAt: 1 } }

let seq = 0
function derive(texts: string | string[]) {
  if (typeof texts === 'string') texts = [texts]
  seq = 0
  const events: DerivedEnvelope[] = [{
    seq: seq++, type: 'user/message', data: {
      source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' },
      content: [{ type: 'text', text: PROTOCOL_V5_NOTICE }],
    },
  }]
  texts.forEach((text, index) => {
    const turn = index + 1
    events.push(
      { seq: seq++, type: 'turn/start', data: { turn } },
      { seq: seq++, type: 'user/message', data: { turn, source: { kind: 'user' }, content: [{ type: 'text', text }] } },
      { seq: seq++, type: 'assistant/message', data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '收到。' }] } } },
      { seq: seq++, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
    )
  })
  return deriveProjection(events, config, scope, true).projection
}

/** Decide every action the item names against the item's OWN target. */
function authorizations(projection: ReturnType<typeof derive>): string[] {
  const out: string[] = []
  for (const item of projection.items.values()) {
    for (const action of [item.semanticAction, ...(item.actionPlan ?? []).map((entry) => entry.action)]) {
      if (!action || action === 'generic_run') continue
      const planTarget = (item.actionPlan ?? []).find((entry) => entry.action === action)?.requestedTarget
      out.push(`${action}:${authorizeMutationFromProjection(projection, {
        action, contractItemId: item.id, contractItemRevision: item.revision,
        resolvedTarget: planTarget ?? item.requestedTarget ?? {},
      } as never).status}`)
    }
  }
  return out
}

describe('hold-out 13 / K1: every question form governs its own clause', () => {
  it.each([
    'When should I install foo and restart service api?',
    'Why would we install foo and restart service api safely?',
    'Should we install foo and restart service api safely?',
    'Could you describe how to install foo and restart service api?',
    '你们如何安装 foo 并重启 api 服务？',
  ])('%s is one undecided obligation that authorizes nothing', (text) => {
    const projection = derive(text)
    const items = [...projection.items.values()]
    expect(items.length, text).toBe(1)
    expect(items[0]!.authorityDisposition, text).toBe('unresolved')
    expect(isQuestionScopeNeedingReview(items[0]!.normalizedText), text).toBe(true)
    for (const decision of authorizations(projection)) {
      expect(decision.endsWith(':authorized'), `${text} / ${decision}`).toBe(false)
    }
  })

  it('preparation reports the same refusal as the gate', async () => {
    const projection = createProjection()
    projection.enabled = true
    const derived = derive('When should I install foo and restart service api?')
    const item = [...derived.items.values()][0]!
    projection.items.set(item.id, item)
    const prepared = await createPrepareTool({ getProjection: () => projection }).execute({
      item_id: item.id, semantic_action: item.semanticAction ?? 'install',
      requested_target: item.requestedTarget ?? {},
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(prepared.compatibility.status).not.toBe('compatible')
  })

  it.each([
    ['Verify whether the lock file is current and install the package.', 'install'],
    // A KNOWN action verb: an unknown one is `unresolved` for its own reason and
    // would not demonstrate that the order survived (oracle correction).
    ['检查磁盘空间是否充足并重启 api 服务。', '重启'],
  ])('%s keeps an order of its own: the imperative coordinates two orders', (text, _needle) => {
    // 合同调整 (0.6.3 收窄合同): the coordinated action stays one undecided
    // obligation and is no longer auto-authorized.
    expectNarrowedUndecided(text)
  })

  it('an order-headed mixed message keeps its question and its orders', () => {
    const scopes = interpretMessage('Install the package, check whether an update exists, and write a report.')
    expect(scopes.filter((entry) => entry.authorityDisposition === 'informational')).toHaveLength(1)
    expect(scopes.filter((entry) => entry.authorityDisposition === 'executable_now').length).toBeGreaterThanOrEqual(2)
  })

  it('a separate sentence after a question is authority', () => {
    const projection = derive('Explain the rollback steps. Then restart service api.')
    const restart = [...projection.items.values()].find((item) => item.semanticAction === 'restart')
    expect(restart?.authorityDisposition).toBe('executable_now')
  })
})

describe('hold-out 13 / K2: inheritance with a third clause naming the field', () => {
  it('a third clause that names the conflicting branch removes the conflict', () => {
    const projection = derive([
      '提交仓库 /repo-e 分支 main。',
      '提交仓库 /repo-e 分支 release。',
      '提交分支 release。',
    ])
    const last = [...projection.items.values()].at(-1)!
    expect(last.requestedTarget).toMatchObject({ repository: '/repo-e', branch: 'release' })
    expect(last.targetCaptureStatus).toBe('resolved')
  })

  it('a conflicting refspec leaves only that field open', () => {
    const projection = derive([
      '拉取仓库 /repo-e remote origin refspec refs/heads/main。',
      '拉取仓库 /repo-e remote origin refspec refs/heads/dev。',
      '拉取。',
    ])
    const last = [...projection.items.values()].at(-1)!
    expect(last.requestedTarget?.repository).toBe('/repo-e')
    expect(last.requestedTarget?.remote).toBe('origin')
    expect(last.requestedTarget?.refspec).toBeUndefined()
    expect(last.targetCaptureReasonCode).toBe('requested_target_field_ambiguous')
  })

  it('a single repository with one branch is unaffected', () => {
    const item = captureClause('提交仓库 /repo-e 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus).toBe('resolved')
    expect(item.requestedTarget).toEqual({ repository: '/repo-e', branch: 'main' })
  })
})

describe('hold-out 13 / K4: eligibility on the two reading shapes', () => {
  const legacy = (text: string): GuardItem => ({
    ...captureClause('占位', 'm1', 'R001', 1, { cwd: '/srv/app' }),
    normalizedText: text,
    directive: 'informational', authorityDisposition: 'informational', taskKind: 'inquiry',
    status: 'answered',
  })

  it('a recorded question-scope text is flagged: the old answer is not a current pass', () => {
    // Oracle correction: the legacy rule recognised this text as information
    // because it opens with a question word, while today's reading leaves it
    // undecided, so the recorded answer must go through review rather than being
    // inherited. Flagging is the safe direction.
    const projection = createProjection()
    projection.enabled = true
    const record = legacy('How do I install foo and restart service api safely?')
    projection.items.set(record.id, record)
    expect(legacyRecordsNeedingReview(projection).map((finding) => finding.reason)).toEqual(['legacy_mixed_information_scope'])
  })

  it('a recorded investigation-mixed text is flagged', () => {
    // Oracle correction: the earlier text carried no marker the LEGACY rule reads
    // as an information request, so it was never an informational record. The
    // standard shape is used instead.
    const projection = createProjection()
    projection.enabled = true
    const record = legacy('Check whether the lock file is current and install the package.')
    projection.items.set(record.id, record)
    expect(legacyRecordsNeedingReview(projection).map((finding) => finding.reason)).toEqual(['legacy_mixed_information_scope'])
  })
})
