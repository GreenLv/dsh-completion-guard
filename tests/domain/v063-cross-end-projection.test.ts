import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { deriveProjection, PROTOCOL_V5_NOTICE, legacyRecordsNeedingReview } from '../../src/domain/derive.js'
import { interpretMessage } from '../../src/domain/semantics.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import type { DerivedEnvelope } from '../../src/domain/types.js'

/**
 * 0.6.3 T08: the cross-end projection ledger.
 *
 * WHAT THIS IS
 *
 * Each ledger case states the NORMALIZED PROJECTION DSH commits to — the number
 * of obligations, the information span, the execution texts, whether delivery
 * may close execution, and the target source — beside the recorded Codex fact
 * and an explicit disposition. The DSH side is measured here through the
 * production derivation; the Codex side is read from the recordings produced by
 * `scripts/record_cross_end_oracle.py` executing the installed module.
 *
 * WHAT THIS IS NOT
 *
 * A native Codex acceptance. No Codex host turn runs here. Cases whose Codex
 * side has no equivalent entry point are `not-applicable`, never `aligned`, and
 * a case whose two ends differ is `not-aligned` on purpose.
 */

interface LedgerCase {
  id: string
  text: string
  dshProjection: {
    executionObligations?: number | string
    informationSpans?: number | string
    undecidedObligations?: number | string
    informationTexts?: string[]
    executionTexts?: string[]
    deliveryMayCloseExecution?: boolean | string
    note?: string
  }
  codexSide: {
    measured: boolean
    source?: string
    replyOnlyRequestShape?: boolean | null
    contractMode?: string | null
    contractReason?: string | null
    obligations?: number | null
    clauseOperations?: string[]
    canonicalCommit?: string
  }
  disposition: 'aligned' | 'partial-equivalent' | 'not-aligned' | 'not-applicable'
  reason: string
}

interface Ledger {
  ledgerVersion: string
  codexSource: {
    version: string
    moduleSha256: string
    shapeFixture: string
    shapeEntryPoints: string[]
    factsFixture: string
    note: string
  }
  dispositions: string[]
  cases: LedgerCase[]
  notCompared: Array<{ capability: string; reason: string }>
}

interface ShapeCase {
  id: string
  text: string
  reply_only_request_shape: boolean
  contract_mode: string
  contract_reason: string
  obligations: number
  clause_operations: Array<string | null>
}

interface ShapeRecording {
  recordingVersion: string
  productVersion: string
  moduleSha256: string
  entryPoint: string
  executedHere: string[]
  note: string
  cases: ShapeCase[]
}

const ledger = JSON.parse(
  readFileSync(new URL('../fixtures/cross-end/core_alignment_0_6_3.json', import.meta.url), 'utf8'),
) as Ledger

const facts = JSON.parse(
  readFileSync(new URL('../fixtures/cross-end/codex-0.13.9.facts.json', import.meta.url), 'utf8'),
) as { moduleSha256: string; cases: Array<{ id: string; text: string; obligations: number; contract_mode: string; contract_reason: string }> }

/**
 * The reply-only shape recording, produced in this batch by executing the
 * installed module's own delivery judge on exactly these inputs. It is the
 * measured Codex counterpart the ledger cites; the ledger never infers it.
 */
const shape = JSON.parse(
  readFileSync(new URL('../fixtures/cross-end/codex-0.13.9.shape.json', import.meta.url), 'utf8'),
) as ShapeRecording

const shapeCase = (id: string): ShapeCase => {
  const found = shape.cases.find((entry) => entry.id === id)
  expect(found, `recorded Codex shape case ${id}`).toBeDefined()
  return found!
}

const scope = { cwd: '/workspace/repo-a', sessionHeader: { version: 3, id: 'v063-cross-end', createdAt: 1 } }
let seq = 0
const reset = () => { seq = 0 }
const notice = (): DerivedEnvelope => ({ seq: seq++, type: 'user/message', data: {
  source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice' },
  content: [{ type: 'text', text: PROTOCOL_V5_NOTICE }],
} })
const user = (text: string, turn: number): DerivedEnvelope => ({ seq: seq++, type: 'user/message', data: {
  turn, source: { kind: 'user' }, content: [{ type: 'text', text }],
} })
const assistant = (turn: number, text: string): DerivedEnvelope => ({ seq: seq++, type: 'assistant/message', data: {
  turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] },
} })
const turnEnd = (turn: number): DerivedEnvelope => ({ seq: seq++, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })

function projectionOf(text: string) {
  reset()
  return deriveProjection([
    notice(),
    { seq: seq++, type: 'turn/start', data: { turn: 1 } } as DerivedEnvelope,
    user(text, 1),
    assistant(1, '已收到。'),
    turnEnd(1),
  ], { activation: 'always' }, scope, true).projection
}

const caseById = (id: string): LedgerCase => {
  const found = ledger.cases.find((entry) => entry.id === id)
  expect(found, `ledger case ${id}`).toBeDefined()
  return found!
}

describe('0.6.3 T08: cross-end semantic projection ledger', () => {
  it('binds the ledger to a recording measured in this batch, and to the same module', () => {
    // Revision 4 (narrowed contract): the Chinese mixed-conjunction case is one
    // undecided obligation instead of a question plus an order.
    expect(ledger.ledgerVersion).toBe('4')
    expect(ledger.codexSource.version).toBe('0.13.9')
    // The shape recording was EXECUTED in this batch; its module identity is the
    // same module the older fixtures were recorded from.
    expect(shape.moduleSha256).toBe(facts.moduleSha256)
    expect(ledger.codexSource.moduleSha256).toBe(shape.moduleSha256)
    expect(shape.executedHere).toContain('_reply_only_request_shape')
    expect(shape.note).toContain('not a native Codex task acceptance')
    expect(ledger.codexSource.note).toContain('recorded in this batch')
    // Every case carries the reason for its disposition and a measured Codex
    // side; a disposition outside the ledger vocabulary is a defect.
    for (const entry of ledger.cases) {
      expect(entry.reason.length, entry.id).toBeGreaterThan(20)
      expect(ledger.dispositions, entry.id).toContain(entry.disposition)
      expect(entry.codexSide.measured, entry.id).toBe(true)
    }
  })

  it('every ledger case matches the measured Codex recording byte for byte', () => {
    for (const entry of ledger.cases) {
      if (entry.codexSide.replyOnlyRequestShape === null) {
        // The non-semantic digest case cites the pin instead of a shape probe.
        expect(entry.id).toBe('shared-digest-and-fixture-contract')
        continue
      }
      const recorded = shapeCase(entry.id)
      expect(recorded.text, entry.id).toBe(entry.text)
      expect(entry.codexSide.replyOnlyRequestShape, entry.id).toBe(recorded.reply_only_request_shape)
      expect(entry.codexSide.contractMode, entry.id).toBe(recorded.contract_mode)
      expect(entry.codexSide.contractReason, entry.id).toBe(recorded.contract_reason)
      expect(entry.codexSide.obligations, entry.id).toBe(recorded.obligations)
    }
  })

  it('the measured Codex delivery judgement refuses to close ANY of these inputs', () => {
    // This is the fact the ledger is built on: on the whole batch, Codex's own
    // reply-only gate returns false. Alignment therefore cannot be claimed for
    // any family where DSH closes a range.
    const booleanCases = shape.cases.filter((entry) => entry.reply_only_request_shape !== null)
    expect(booleanCases.length).toBe(12)
    for (const entry of booleanCases) expect(entry.reply_only_request_shape, entry.id).toBe(false)
  })

  it('the DSH projection of every mixed request keeps its execution, and matches the ledger', () => {
    for (const id of ['mixed-comma-run-zh', 'mixed-comma-run-en', 'mixed-conjunction-zh', 'mixed-conjunction-en']) {
      const entry = caseById(id)
      const items = [...projectionOf(entry.text).items.values()]
      const information = items.filter((item) => item.authorityDisposition === 'informational')
      const execution = items.filter((item) => item.authorityDisposition === 'executable_now'
        || item.authorityDisposition === 'conditional_wait')
      // The two conjunction cases are UNDECIDED by contract (a coordinated predicate
      // inside an investigation complement is not authority), so the ledger records
      // that reading instead of a question plus an order.
      const undecided = items.filter((item) => item.authorityDisposition === 'unresolved')
      expect(information.length, id).toBe(entry.dshProjection.informationSpans)
      expect(execution.length, id).toBe(entry.dshProjection.executionObligations)
      expect(undecided.length, id).toBe(entry.dshProjection.undecidedObligations ?? 0)
      for (const item of undecided) expect(item.status, `${id}: ${item.normalizedText}`).toBe('pending')
      for (const text of entry.dshProjection.informationTexts!) {
        expect(information.some((item) => item.normalizedText.includes(text)), `${id}: ${text}`).toBe(true)
      }
      for (const text of entry.dshProjection.executionTexts!) {
        expect(items.some((item) => item.normalizedText.includes(text)), `${id}: ${text}`).toBe(true)
      }
      // A zero-tool final answer must not remove any execution obligation.
      for (const item of execution) {
        expect(item.status, `${id}: ${item.normalizedText}`).toBe('pending')
        expect(item.answeredBy, `${id}: ${item.normalizedText}`).toBeUndefined()
      }
      expect(entry.dshProjection.deliveryMayCloseExecution, id).toBe(false)
    }
  })

  it('records the mixed and pure-question families as NOT aligned, in the dangerous direction', () => {
    for (const id of ['mixed-comma-run-zh', 'mixed-comma-run-en', 'pure-question-zh', 'pure-question-en']) {
      const entry = caseById(id)
      expect(entry.disposition, id).toBe('not-aligned')
      // The measured Codex judgement refuses closure while DSH closes the
      // information range — the difference is stated, not smoothed over.
      expect(entry.codexSide.replyOnlyRequestShape, id).toBe(false)
      expect(entry.reason, id).toMatch(/Codex|measured/i)
    }
  })

  it('keeps the pure question as the positive control, and 吧 as an order', () => {
    const question = caseById('pure-question-zh')
    const scopes = interpretMessage(question.text)
    expect(scopes).toHaveLength(1)
    expect(scopes[0]!.authorityDisposition).toBe('informational')
    const questionItems = [...projectionOf(question.text).items.values()]
    expect(questionItems).toHaveLength(1)
    expect(questionItems[0]!.status).toBe('answered')

    const suggestion = caseById('suggestion-particle-zh')
    const suggestionItems = [...projectionOf(suggestion.text).items.values()]
    expect(suggestionItems).toHaveLength(1)
    expect(suggestionItems[0]!.authorityDisposition).toBe('executable_now')
    expect(suggestionItems[0]!.status).toBe('pending')
  })

  it('records the unnamed-repository family as NOT aligned, with both ends measured', () => {
    const entry = caseById('unnamed-repository-zh')
    const recorded = shapeCase('unnamed-repository-zh')
    expect(recorded.text).toBe(entry.text)
    expect(recorded.obligations).toBe(entry.codexSide.obligations)
    expect(recorded.clause_operations).toContain('remote_push')

    const items = [...projectionOf(entry.text).items.values()]
    const gitItems = items.filter((item) => item.semanticAction === 'commit' || item.semanticAction === 'push')
    expect(gitItems.length).toBe(entry.dshProjection.executionObligations)
    for (const item of gitItems) {
      expect(item.targetSource?.kind).toBe('environment_default')
      expect(item.targetCaptureStatus).toBe('clarification_required')
      expect(authorizeMutationFromProjection(projectionOf(entry.text), {
        action: item.semanticAction as 'commit' | 'push',
        contractItemId: item.id, contractItemRevision: item.revision,
        resolvedTarget: { repository: '/workspace/repo-a', branch: 'main', remote: 'origin', refspec: 'main' },
      }).status).toBe('denied')
    }
    expect(entry.disposition).toBe('not-aligned')
    expect(entry.reason).toContain('capability difference')
  })

  it('keeps the shared byte-level contract aligned and the unmeasured capabilities visible', () => {
    expect(caseById('shared-digest-and-fixture-contract').disposition).toBe('aligned')
    expect(ledger.notCompared.map((entry) => entry.capability).sort()).toEqual([
      'cross-repository follow-up reference',
      'legacy answered-record eligibility',
      'prepare/execute same-input compatibility',
    ])
    for (const entry of ledger.notCompared) expect(entry.reason.length).toBeGreaterThan(30)
    // A capability with no measured Codex counterpart must say so, and must not
    // be labelled not-applicable merely because it was not measured.
    const followUp = ledger.notCompared.find((entry) => entry.capability === 'cross-repository follow-up reference')!
    expect(followUp.reason).toContain('not measured')
  })

  it('the 0.6.3 eligibility layer does not read a recorded Codex case as a DSH pass', () => {
    reset()
    const projection = deriveProjection([
      notice(),
      { seq: seq++, type: 'turn/start', data: { turn: 1 } } as DerivedEnvelope,
      user(caseById('mixed-comma-run-zh').text, 1),
      assistant(1, '已收到。'),
      turnEnd(1),
    ], { activation: 'always' }, scope, true).projection
    expect(legacyRecordsNeedingReview(projection)).toEqual([])
    expect([...projection.items.values()].some((item) => item.status === 'passed')).toBe(false)
  })
})
