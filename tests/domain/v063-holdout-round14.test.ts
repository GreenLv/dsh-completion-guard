import { describe, expect, it } from 'vitest'
import { deriveProjection, legacyRecordsNeedingReview, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { interpretMessage, isQuestionScopeNeedingReview } from '../../src/domain/semantics.js'
import { captureClause } from '../../src/domain/capture.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope, type GuardItem } from '../../src/domain/types.js'

/**
 * 0.6.3 hold-out round 14 — regression coverage (was the independent set).
 *
 * Round 13 found two source defects of the question-scope family (a temporal
 * interrogative read as a condition, and a Chinese question with a subject
 * pronoun), so it is regression coverage. Round 14 was written after the twelfth
 * repair round, in shape families absent from rounds 1-13 and the ten review
 * batches:
 *
 * - further temporal and modal question heads in both languages (`When do we …`,
 *   `何时…`, a question that asks WHEN with a full conditional-looking tail);
 * - the CONTRAST that must stay conditional (`When the tests pass, install …`) and
 *   the contrast that must stay a question;
 * - a question whose verb is outside the vocabulary, which must not become
 *   executable through any path;
 * - a question scope in a later clause of a multi-clause message, and a question
 *   followed by an explicitly separate instruction;
 * - per-field inheritance where the agreeing fields outnumber the conflicting one;
 * - eligibility on a recorded temporal question and on a recorded conditional
 *   order.
 *
 * It found one more source defect of the same family — the Chinese temporal
 * interrogatives (何时/什么时候) were missing from the question vocabulary, so such
 * a clause lost its question scope and split — which was repaired, and two of its
 * own expectations were wrong. It is therefore REGRESSION COVERAGE and round 15 is
 * the current independent set.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-holdout14', createdAt: 1 } }

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

describe('hold-out 14 / K1: temporal and modal questions govern their clause', () => {
  it.each([
    'When do we install foo and restart service api?',
    'What is the command that installs foo and restarts service api?',
    '何时安装 foo 并重启 api 服务？',
    '他们怎么做才能安装 foo 并重启 api 服务？',
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

  it('a real conditional order keeps its conditional reading', () => {
    const projection = derive('When the tests pass, install the package.')
    const item = [...projection.items.values()][0]!
    expect(item.authorityDisposition).toBe('conditional_wait')
    expect(isQuestionScopeNeedingReview(item.normalizedText)).toBe(false)
  })

  it('a question whose verb is outside the vocabulary is still not executable', () => {
    const projection = derive('How do I repack the archives and rotate the credentials?')
    const items = [...projection.items.values()]
    expect(items.every((item) => item.authorityDisposition !== 'executable_now'), JSON.stringify(items.map((i) => [i.normalizedText, i.authorityDisposition]))).toBe(true)
    for (const decision of authorizations(projection)) {
      expect(decision.endsWith(':authorized')).toBe(false)
    }
  })

  it('a question in a later clause keeps its own scope', () => {
    const scopes = interpretMessage('Update README.md. How do I install foo and restart service api?')
    expect(scopes.some((entry) => entry.authorityDisposition === 'executable_now' && entry.text.includes('Update README.md'))).toBe(true)
    expect(scopes.some((entry) => entry.authorityDisposition === 'unresolved' && entry.text.includes('install foo'))).toBe(true)
  })

  it('a question followed by its own sentence keeps the instruction separate', () => {
    const projection = derive('How do I deploy the release? Then restart service api.')
    const restart = [...projection.items.values()].find((item) => item.semanticAction === 'restart')
    expect(restart?.authorityDisposition).toBe('executable_now')
  })

  it('preparation refuses the same question scope the gate refuses', async () => {
    const projection = createProjection()
    projection.enabled = true
    const derived = derive('When do we install foo and restart service api?')
    const item = [...derived.items.values()][0]!
    projection.items.set(item.id, item)
    const prepared = await createPrepareTool({ getProjection: () => projection }).execute({
      item_id: item.id, semantic_action: item.semanticAction ?? 'install',
      requested_target: item.requestedTarget ?? {},
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(prepared.compatibility.status).not.toBe('compatible')
  })
})

describe('hold-out 14 / K2: one conflicting field beside two agreeing ones', () => {
  it('only the conflicting field stays open', () => {
    const projection = derive([
      '拉取仓库 /repo-f remote origin refspec refs/heads/main。',
      '拉取仓库 /repo-f remote origin refspec refs/heads/release。',
      '拉取。',
    ])
    const last = [...projection.items.values()].at(-1)!
    expect(last.requestedTarget).toMatchObject({ repository: '/repo-f', remote: 'origin' })
    expect(last.requestedTarget?.refspec).toBeUndefined()
    expect(last.targetCaptureStatus).toBe('clarification_required')
    expect(last.targetCaptureReasonCode).toBe('requested_target_field_ambiguous')
  })

  it('a clause naming the conflicting field itself is resolved', () => {
    const projection = derive([
      '拉取仓库 /repo-f remote origin refspec refs/heads/main。',
      '拉取仓库 /repo-f remote origin refspec refs/heads/release。',
      '拉取 refspec refs/heads/release。',
    ])
    const last = [...projection.items.values()].at(-1)!
    expect(last.targetCaptureStatus).toBe('resolved')
    expect(last.requestedTarget).toMatchObject({ repository: '/repo-f', remote: 'origin', refspec: 'refs/heads/release' })
  })

  it('a single full target is unaffected', () => {
    const item = captureClause('拉取仓库 /repo-f remote origin refspec refs/heads/main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus).toBe('resolved')
  })
})

describe('hold-out 14 / K4: eligibility on the two temporal shapes', () => {
  const legacy = (text: string): GuardItem => ({
    ...captureClause('占位', 'm1', 'R001', 1, { cwd: '/srv/app' }),
    normalizedText: text,
    directive: 'informational', authorityDisposition: 'informational', taskKind: 'inquiry',
    status: 'answered',
  })

  it('a recorded temporal question is reported for review', () => {
    // The earlier release read it as information (a question word at the head)
    // while today's reading leaves it undecided, so its recorded answer must not be
    // inherited as a current pass.
    const projection = createProjection()
    projection.enabled = true
    const record = legacy('When do we install foo and restart service api?')
    projection.items.set(record.id, record)
    expect(interpretMessage(record.normalizedText).every((entry) => entry.authorityDisposition === 'unresolved')).toBe(true)
    expect(legacyRecordsNeedingReview(projection).map((finding) => finding.reason)).toEqual(['legacy_mixed_information_scope'])
  })

  it('a recorded conditional order is reported for review too', () => {
    // Oracle correction: the LEGACY rule treats a leading "when" as a question
    // marker, so this text was recorded as information; today's reading is a
    // conditional order, so the old answer is not a current pass. Reporting it is
    // the safe direction — the record names work.
    const projection = createProjection()
    projection.enabled = true
    const record = legacy('When the tests pass, install the package.')
    projection.items.set(record.id, record)
    expect(interpretMessage(record.normalizedText).every((entry) => entry.authorityDisposition !== 'informational')).toBe(true)
    expect(legacyRecordsNeedingReview(projection).map((finding) => finding.reason)).toEqual(['legacy_mixed_information_scope'])
  })
})
