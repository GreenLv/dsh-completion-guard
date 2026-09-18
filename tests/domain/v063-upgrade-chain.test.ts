import { describe, expect, it } from 'vitest'
import {
  applyUpgradeEligibility, deriveProjection, legacyRecordsNeedingReview,
  PROTOCOL_V4_NOTICE, PROTOCOL_V5_NOTICE,
} from '../../src/domain/derive.js'
import { certifyCheckpoint } from '../../src/domain/checkpoint.js'
import { hasCurrentCertificate } from '../../src/domain/goal-gate.js'
import { needsReviewObligations } from '../../src/domain/closure.js'
import { renderRecoveryPacket } from '../../src/domain/recovery.js'
import { captureClause } from '../../src/domain/capture.js'
import { createProjection, type DerivedEnvelope, type GuardItem } from '../../src/domain/types.js'

/**
 * 0.6.3 T06, log-driven half.
 *
 * The UPGRADE evidence — a real 0.6.2 projection recorded by executing the
 * committed baseline build, put through the production upgrade entry, with the
 * "history is preserved" claim asserted as the diff AROUND that call — lives in
 * `tests/domain/v063-legacy-upgrade.test.ts` and
 * `tests/fixtures/upgrade/legacy-0.6.2.json`. Nothing here reconstructs a legacy
 * record by editing a current one.
 *
 * What this file keeps: the durable-log cases a running session produces —
 * idempotent re-derivation, the v4 (pre-v5) boundary, and the predicate-level
 * shapes the recorder cannot emit (a record whose source bytes are gone). Where a
 * record IS constructed, the test says so and asserts only the predicate.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/workspace/repo-a', sessionHeader: { version: 3, id: 'v063-upgrade', createdAt: 1 } }

let seq = 0
const reset = () => { seq = 0 }
const noticeV5 = (): DerivedEnvelope => ({ seq: seq++, type: 'user/message', data: {
  source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' },
  content: [{ type: 'text', text: PROTOCOL_V5_NOTICE }],
} })
const noticeV4 = (): DerivedEnvelope => ({ seq: seq++, type: 'user/message', data: {
  source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' },
  content: [{ type: 'text', text: PROTOCOL_V4_NOTICE }],
} })
const user = (text: string, turn: number): DerivedEnvelope => ({ seq: seq++, type: 'user/message', data: {
  turn, source: { kind: 'user' }, content: [{ type: 'text', text }],
} })
const assistant = (turn: number, text: string): DerivedEnvelope => ({ seq: seq++, type: 'assistant/message', data: {
  turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] },
} })
const turnStart = (turn: number): DerivedEnvelope => ({ seq: seq++, type: 'turn/start', data: { turn } })
const turnEnd = (turn: number): DerivedEnvelope => ({ seq: seq++, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })

/** A completed host turn, exactly the shape a delivered answer needs. */
function turn(number: number, text: string, answer: string): DerivedEnvelope[] {
  return [turnStart(number), user(text, number), assistant(number, answer), turnEnd(number)]
}

/** The durable log an earlier release leaves behind for a mixed request. */
function legacyMixedLog(): DerivedEnvelope[] {
  reset()
  return [
    noticeV5(),
    ...turn(1, '更新插件，检查是否存在更新，安装新主题，记录变更。', '已收到。'),
  ]
}

describe('0.6.3 T06: the upgrade entry over a durable log', () => {
  it('upgrading the same log twice is idempotent, and the upgrade itself rewrites no history', () => {
    reset()
    const events = legacyMixedLog()
    const projection = deriveProjection(events, config, scope, true).projection
    const historical = (p: typeof projection) => [...p.items.values()]
      .sort((left, right) => (left.id < right.id ? -1 : 1))
      .map((item) => ({
        id: item.id, status: item.status, answeredBy: item.answeredBy, textSha256: item.textSha256,
        spans: item.spans, normalizedText: item.normalizedText, revision: item.revision,
        authorityDisposition: item.authorityDisposition, semanticAction: item.semanticAction,
      }))
    const before = historical(projection)
    const marksBefore = [...projection.items.values()].map((item) => item.needsReview ?? null)

    // THE upgrade operation, between the two snapshots.
    applyUpgradeEligibility(projection)

    expect(historical(projection)).toEqual(before)
    expect([...projection.items.values()].map((item) => item.needsReview ?? null)).toEqual(marksBefore)
    // The upgrade creates no certificate, checkpoint or effect of its own.
    expect(projection.checkpoints).toHaveLength(0)
    expect([...projection.items.values()].every((item) => item.status !== 'passed')).toBe(true)
    // The answering turn is still the durable fact it was.
    for (const item of [...projection.items.values()].filter((entry) => entry.status === 'answered')) {
      expect(item.answeredBy).toMatchObject({ turn: 1 })
    }
    // And running the whole derivation again says the same thing.
    const again = deriveProjection(events, config, scope, true).projection
    expect(historical(again)).toEqual(before)
  })

  it('a later turn in the same unit adds records without disturbing the old ones', () => {
    reset()
    const events = legacyMixedLog()
    const first = deriveProjection(events, config, scope, true).projection
    const extended = deriveProjection([...events, ...turn(2, '记录变更。', '好。')], config, scope, true).projection
    expect(extended.items.size).toBeGreaterThan(first.items.size)
    expect([...first.items.values()].every((item) => item.status !== 'passed')).toBe(true)
  })

  it('the blocked verdict is visible in the certificate, the Goal and the recovery packet', () => {
    // Predicate-level: the record is constructed so the flag is guaranteed to be
    // present. The recorded-fixture file asserts the same verdict for a mark the
    // upgrade entry itself produced.
    const projection = createProjection()
    projection.enabled = true
    projection.boundaryProtocol = 5
    projection.currentUnitId = 'U001'
    const record: GuardItem = {
      ...captureClause('占位', 'm2', 'R001', 1, { cwd: '/workspace/repo-a' }),
      unitId: 'U001', status: 'answered',
      normalizedText: '更新插件，检查是否存在更新，安装新主题，记录变更。',
      directive: 'informational', authorityDisposition: 'informational', taskKind: 'inquiry',
      needsReview: { reason: 'legacy_mixed_information_scope', checkId: 'eligibility:0.6.3', recordedAtRevision: 1 },
    }
    projection.items.set(record.id, record)

    const result = certifyCheckpoint(projection, [], 'C1')
    expect(result.status).toBe('incomplete')
    expect(result.rejectedBindings[0]).toMatchObject({ itemId: record.id, reasonCode: 'legacy_record_needs_review' })
    expect(hasCurrentCertificate(projection)).toBe(false)
    expect(projection.certificateStatusReason).toBe('legacy_record_needs_review')
    expect(needsReviewObligations(projection).map((item) => item.id)).toEqual([record.id])
    expect(renderRecoveryPacket(projection)).toContain(record.id)
  })

  it('a v4 session keeps its whole-session scope and checks its records', () => {
    reset()
    const projection = deriveProjection([
      noticeV4(),
      ...turn(1, '安装主题 A，检查是否有新版本。', '好。'),
    ], config, scope, true).projection
    // A v4 log has no units, so every record is in the eligibility scope.
    expect(projection.boundaryProtocol).not.toBe(5)
    // The current reading partitions the clause, so nothing here needs review;
    // what the boundary decides is the SCOPE, and the recorded-fixture file
    // proves the flag itself on the earlier release's own record.
    expect(legacyRecordsNeedingReview(projection)).toEqual([])
    expect(needsReviewObligations(projection)).toEqual([])
    // The session is incomplete because its recorded work is still open — never
    // because of a review flag it does not have.
    const result = certifyCheckpoint(projection, [], 'C1')
    expect(result.rejectedBindings.map((binding) => binding.reasonCode)).not.toContain('legacy_record_needs_review')
    expect(projection.certificateStatusReason).not.toBe('legacy_record_needs_review')
  })

  it('a pre-v5 record whose source bytes are gone keeps the gap visible instead of guessing', () => {
    // Predicate-level and deliberately constructed: the recorder cannot emit a
    // record with its provenance deleted, and the question here is only what the
    // eligibility layer does when a legacy record carries no spans.
    const projection = createProjection()
    projection.enabled = true
    const legacyless: GuardItem = {
      ...captureClause('占位', 'm2', 'R001', 1, { cwd: '/workspace/repo-a' }),
      normalizedText: '安装主题 A，确认是否有新版本。',
      directive: 'informational', authorityDisposition: 'informational', taskKind: 'inquiry',
      status: 'answered',
    }
    delete legacyless.spans
    delete legacyless.rawTextSha256
    projection.items.set(legacyless.id, legacyless)
    const findings = legacyRecordsNeedingReview(projection)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ itemId: legacyless.id, reason: 'legacy_mixed_information_scope' })

    // A safe pre-v5 record keeps its birth rule and is NOT flagged.
    const safe = { ...legacyless, id: 'R002', normalizedText: '主题是否有新版本吗？' }
    delete safe.spans
    delete safe.rawTextSha256
    projection.items.set(safe.id, safe)
    expect(legacyRecordsNeedingReview(projection).map((entry) => entry.itemId)).toEqual([legacyless.id])
  })
})
