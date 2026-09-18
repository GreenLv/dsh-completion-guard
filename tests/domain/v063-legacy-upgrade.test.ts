import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { applyUpgradeEligibility, legacyRecordsNeedingReview } from '../../src/domain/derive.js'
import { certifyCheckpoint } from '../../src/domain/checkpoint.js'
import { hasCurrentCertificate } from '../../src/domain/goal-gate.js'
import { needsReviewObligations } from '../../src/domain/closure.js'
import { renderRecoveryPacket } from '../../src/domain/recovery.js'
import { createProjection, type GuardItem, type GuardProjection } from '../../src/domain/types.js'

/**
 * 0.6.3 T06 evidence: a REAL 0.6.2 projection upgraded by the PRODUCTION entry.
 *
 * The earlier evidence for this gate derived a log with the CURRENT reader and
 * then assigned the old shape onto the result by hand; its "history is
 * preserved" case even compared two snapshots with no operation between them.
 * Neither can show that a record the previous release actually wrote survives an
 * upgrade, so this file does not construct a legacy record at all:
 *
 * - `tests/fixtures/upgrade/legacy-0.6.2.json` is emitted by
 *   `scripts/record_legacy_upgrade_fixture.mjs`, which EXECUTES the committed
 *   0.6.2 build (`deriveProjection` from the baseline `dist/`) and stores the
 *   records it produced, with the baseline commit and every module hash. The
 *   mixed-request cases are the reproduced F062-01 defect: ONE information
 *   obligation spanning the whole clause. The fixture records BOTH real
 *   protocols — a session with no boundary notice, where the earlier release
 *   left the record `pending`, and a session that announced the v5 boundary,
 *   where the earlier release CLOSED it and wrote a delivered `answeredBy`;
 * - the upgrade is `applyUpgradeEligibility` — the exported entry the derivation
 *   itself calls at the end of `deriveProjection` — and every before/after
 *   comparison brackets THAT call, so the diff shows exactly what the upgrade
 *   changed;
 * - what this file does NOT claim: it drives the eligibility entry over the
 *   persisted records directly. Native host recovery (restoring a real profile,
 *   replaying a real session log through the runtime) remains unmeasured and is
 *   reported as such in the acceptance record.
 */

const FIXTURE_PATH = new URL('../fixtures/upgrade/legacy-0.6.2.json', import.meta.url)

interface LegacyRecord extends Partial<GuardItem> {
  id: string
  normalizedText: string
}
interface LegacyCase {
  caseId: string
  why: string
  turn: { text: string; answer: string; v5Notice?: boolean }
  boundaryProtocol: number | null
  records: LegacyRecord[]
}
interface LegacyFixture {
  recordingVersion: string
  product: string
  productVersion: string
  baselineCommit: string
  moduleEntry: string
  moduleSha256: string
  moduleHashes: Record<string, string>
  entryPoint: string
  cases: LegacyCase[]
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as LegacyFixture

function legacyCase(caseId: string): LegacyCase {
  const found = fixture.cases.find((entry) => entry.caseId === caseId)
  expect(found, caseId).toBeDefined()
  return found!
}

/** The persisted state of a 0.6.2 session: the records the earlier release wrote. */
function projectionOf(caseId: string, revision = 7): GuardProjection {
  const projection = createProjection()
  projection.enabled = true
  projection.contractRevision = revision
  const source = legacyCase(caseId)
  // The recorded protocol is part of the state: a v5 session attributes its
  // records to a work unit, and the eligibility scope is the CURRENT unit, so a
  // restored v5 projection names the unit those records belong to.
  if (source.boundaryProtocol === 5) projection.boundaryProtocol = 5
  const unitId = source.records.find((record) => record.unitId !== undefined)?.unitId
  if (unitId !== undefined) projection.currentUnitId = unitId
  for (const record of source.records) {
    // Each projection owns its records: the upgrade MUTATES the item it flags, so
    // sharing the parsed fixture between cases would leak one test's mark into
    // the next.
    projection.items.set(record.id, structuredClone(record) as GuardItem)
  }
  return projection
}

/** Everything the upgrade is forbidden to rewrite, as one comparable value. */
const historical = (projection: GuardProjection) => [...projection.items.values()]
  .sort((left, right) => (left.id < right.id ? -1 : 1))
  .map((item) => ({
    id: item.id,
    revision: item.revision,
    kind: item.kind,
    normalizedText: item.normalizedText,
    textSha256: item.textSha256,
    status: item.status,
    directive: item.directive,
    authorityDisposition: item.authorityDisposition,
    taskKind: item.taskKind,
    semanticAction: item.semanticAction,
    requestedTarget: item.requestedTarget,
    targetCaptureStatus: item.targetCaptureStatus,
    spans: item.spans,
    answeredBy: item.answeredBy,
  }))

const eligibility = (projection: GuardProjection) => [...projection.items.values()]
  .map((item) => ({ id: item.id, needsReview: item.needsReview ?? null }))
  .sort((left, right) => (left.id < right.id ? -1 : 1))

describe('0.6.3 T06 / recorded 0.6.2 projection', () => {
  it('the fixture is the earlier release\u2019s own output, not this batch\u2019s shape', () => {
    expect(fixture.recordingVersion).toBe('1')
    expect(fixture.product).toBe('dsh-completion-guard')
    expect(fixture.productVersion).toBe('0.6.2')
    expect(fixture.baselineCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(fixture.entryPoint).toContain('deriveProjection')
    // Every module the recording executed is bound to a hash, so the records can
    // be re-recorded and compared instead of being taken on trust.
    expect(fixture.moduleHashes[fixture.moduleEntry]).toBe(fixture.moduleSha256)
    expect(Object.keys(fixture.moduleHashes).length).toBeGreaterThanOrEqual(6)
    expect(Object.values(fixture.moduleHashes).every((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true)

    const mixed = legacyCase('legacy-0.6.2-mixed-chinese')
    expect(mixed.boundaryProtocol).toBeNull()
    expect(mixed.records).toHaveLength(1)
    const record = mixed.records[0]!
    // The defect itself: one information range covering the WHOLE mixed clause.
    expect(record.directive).toBe('informational')
    expect(record.authorityDisposition).toBe('informational')
    expect(record.taskKind).toBe('inquiry')
    expect(record.normalizedText).toBe(mixed.turn.text)
    expect(record.spans).toHaveLength(1)
    expect(record.spans![0]!.start).toBe(0)
    expect(record.spans![0]!.class).toBe('question')
    expect(record.status).toBe('pending')

    // The same input on a session that announced the v5 boundary: the earlier
    // release applied its delivery pass and CLOSED the whole mixed clause, so the
    // record the upgrade has to preserve carries a real answering turn.
    const closed = legacyCase('legacy-0.6.2-mixed-chinese-v5')
    expect(closed.boundaryProtocol).toBe(5)
    expect(closed.turn.v5Notice).toBe(true)
    const answered = closed.records[0]!
    expect(answered.status).toBe('answered')
    expect(answered.answeredBy).toMatchObject({ turn: 1, responseSeq: 3 })
    expect(answered.answeredBy?.responseSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(answered.normalizedText).toBe(closed.turn.text)
  })

  it.each([
    'legacy-0.6.2-mixed-chinese',
    'legacy-0.6.2-mixed-chinese-v5',
    'legacy-0.6.2-mixed-english-v5',
  ])(
    'the production upgrade entry refuses to inherit %s, and changes nothing else',
    (caseId) => {
      const projection = projectionOf(caseId)
      const before = historical(projection)
      expect(eligibility(projection)).toEqual([{ id: 'R001', needsReview: null }])

      // THE upgrade operation, between the two snapshots.
      applyUpgradeEligibility(projection)

      expect(eligibility(projection)).toEqual([{
        id: 'R001',
        needsReview: {
          reason: 'legacy_mixed_information_scope',
          checkId: 'eligibility:0.6.3',
          recordedAtRevision: 7,
        },
      }])
      // The record is history: the upgrade added the eligibility fact and
      // rewrote no other byte of it.
      expect(historical(projection)).toEqual(before)
      // The upgrade itself produces no certificate and no effect.
      expect(projection.checkpoints).toHaveLength(0)
      expect(hasCurrentCertificate(projection)).toBe(false)
      expect([...projection.items.values()].every((item) => item.status !== 'passed')).toBe(true)
    },
  )

  it('a supported pure-question record keeps its birth rule and is never flagged', () => {
    const projection = projectionOf('legacy-0.6.2-pure-question-v5')
    const before = historical(projection)
    applyUpgradeEligibility(projection)
    expect(eligibility(projection)).toEqual([{ id: 'R001', needsReview: null }])
    expect(historical(projection)).toEqual(before)
    expect(legacyRecordsNeedingReview(projection)).toEqual([])
  })

  it('a flagged record blocks the certificate and the Goal, and says so where an operator looks', () => {
    const projection = projectionOf('legacy-0.6.2-mixed-chinese')
    applyUpgradeEligibility(projection)
    const record = legacyCase('legacy-0.6.2-mixed-chinese').records[0]!
    expect(needsReviewObligations(projection).map((item) => item.id)).toEqual([record.id])
    const result = certifyCheckpoint(projection, [], 'C1')
    expect(result.status).toBe('incomplete')
    expect(result.rejectedBindings[0]).toMatchObject({ itemId: record.id, reasonCode: 'legacy_record_needs_review' })
    expect(hasCurrentCertificate(projection)).toBe(false)
    expect(projection.certificateStatusReason).toBe('legacy_record_needs_review')
    expect(renderRecoveryPacket(projection)).toContain(record.id)
  })

  it('the entry is idempotent: a replayed upgrade keeps the original fact and revision', () => {
    const projection = projectionOf('legacy-0.6.2-mixed-english-v5', 11)
    applyUpgradeEligibility(projection)
    const first = eligibility(projection)
    projection.contractRevision = 99
    applyUpgradeEligibility(projection)
    expect(eligibility(projection)).toEqual(first)
    expect(eligibility(projection)[0]!.needsReview?.recordedAtRevision).toBe(11)
  })

  it('a pre-v5 session keeps its unit-less records in scope', () => {
    // The no-notice 0.6.2 sample: the record carries no unit, so it is in the
    // eligibility scope whatever boundary the restored projection has.
    const projection = projectionOf('legacy-0.6.2-mixed-chinese')
    expect(projection.boundaryProtocol).toBeUndefined()
    expect(projection.items.get('R001')!.unitId).toBeUndefined()
    applyUpgradeEligibility(projection)
    expect(needsReviewObligations(projection)).toHaveLength(1)
    const result = certifyCheckpoint(projection, [], 'C1')
    expect(result.status).toBe('incomplete')
    expect(result.rejectedBindings[0]).toMatchObject({ reasonCode: 'legacy_record_needs_review' })
  })

  it('the answered legacy record keeps its delivered answer through the upgrade', () => {
    const projection = projectionOf('legacy-0.6.2-mixed-chinese-v5')
    const record = projection.items.get('R001')!
    const delivered = { ...record.answeredBy! }
    expect(record.status).toBe('answered')
    applyUpgradeEligibility(projection)
    // The mark is added and the delivery the earlier release recorded is not.
    expect(projection.items.get('R001')!.needsReview).toMatchObject({
      reason: 'legacy_mixed_information_scope',
      checkId: 'eligibility:0.6.3',
      recordedAtRevision: 7,
    })
    expect(projection.items.get('R001')!.status).toBe('answered')
    expect(projection.items.get('R001')!.answeredBy).toEqual(delivered)
    // And the delivered answer does not rescue the record: it still blocks.
    const result = certifyCheckpoint(projection, [], 'C1')
    expect(result.status).toBe('incomplete')
    expect(result.rejectedBindings[0]).toMatchObject({ itemId: 'R001', reasonCode: 'legacy_record_needs_review' })
  })
})
