import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import {
  RELEASE_CONTRACT_PREFIX, RELEASE_OPERATION_SURFACES, RELEASE_SETTLEMENT_PREFIX,
  inFlightReservation, normalizeReleaseContract, releaseContractFor, releaseCoverage,
  releasePreEffectDecision, settledOperations,
} from '../../src/domain/release.js'
import { migrationReport } from '../../src/domain/migration.js'
import { reasonClassOf } from '../../src/domain/reason-class.js'
import { createProjection, type DerivedEnvelope } from '../../src/domain/types.js'

const config = { activation: 'always' as const }
const scope = { cwd: '/repo', sessionHeader: { version: 3, id: 'v060-release', createdAt: 1 } }

let seq = 0
const reset = () => { seq = 0 }
const notice = (text: string): DerivedEnvelope => ({ seq: seq++, type: 'user/message', data: {
  source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' },
  content: [{ type: 'text', text }],
} })
const command = (args: string): DerivedEnvelope => ({ seq: seq++, type: 'command/run', data: {
  name: 'context-guard', args, source: { kind: 'user' },
} })
const v5Notice = (): DerivedEnvelope => ({ seq: seq++, type: 'user/message', data: {
  source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' },
  content: [{ type: 'text', text: PROTOCOL_V5_NOTICE }],
} })

const SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)
const DIGEST = 'c'.repeat(64)
const CONTRACT = {
  contractId: 'rel-1',
  operations: ['npm_publish'],
  candidate: { repository: 'GreenLv/dsh-completion-guard', ref: 'refs/heads/main', fullSha40: SHA, artifactDigest: DIGEST, version: '0.6.0' },
  readinessRefs: ['C1'],
  expiresAtEpochMs: 4_000_000_000_000,
}
const adoptLine = (contract: Record<string, unknown> = CONTRACT): string => JSON.stringify(contract)
const RESOLVED = { artifact_id: 'dsh-completion-guard', version: '0.6.0', registry: 'https://registry.npmjs.org/', integrity_digest: DIGEST }

function observed() {
  reset()
  const events = [
    v5Notice(),
    command(`release adopt ${adoptLine()}`),
  ]
  return deriveProjection(events, config, scope, true).projection
}

describe('0.6.0 C10: adoption is explicit, durable, and replayable', () => {
  it('a root command adopts exactly one contract with its candidate and operations', () => {
    const p = observed()
    expect(p.releaseContracts).toHaveLength(1)
    expect(p.releaseContracts[0]).toMatchObject({
      contractId: 'rel-1', operations: ['npm_publish'],
      candidate: { fullSha40: SHA, version: '0.6.0', artifactDigest: DIGEST },
    })
    // Idempotent: replaying the same log adopts the same single contract.
    expect(deriveProjection([
      v5Notice(), command(`release adopt ${adoptLine()}`), command(`release adopt ${adoptLine()}`),
    ], config, scope, true).projection.releaseContracts).toHaveLength(1)
  })

  it('a keyword, a Skill or an installation never adopts a contract', () => {
    reset()
    const events = [
      { seq: seq++, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '请执行 release 发布 0.6.0' }] } },
      { seq: seq++, type: 'user/message', data: { source: { kind: 'model' }, content: [{ type: 'text', text: `release adopt ${adoptLine()}` }] } },
    ]
    const p = deriveProjection(events, config, scope, true).projection
    expect(p.releaseContracts).toHaveLength(0)
    expect(releasePreEffectDecision(p, { operation: 'npm_publish', candidate: { fullSha40: SHA }, resolvedTarget: RESOLVED }).reasonCode)
      .toBe('release_contract_required')
  })

  it('a contract naming an unprotectable operation is refused at adoption', () => {
    reset()
    const events = [
      v5Notice(),
      command(`release adopt ${adoptLine({ ...CONTRACT, operations: ['git_tag', 'npm_publish'] })}`),
    ]
    const p = deriveProjection(events, config, scope, true).projection
    expect(p.releaseContracts).toHaveLength(0)
    expect(p.releaseDiagnostics.map((entry) => entry.reasonCode)).toContain('release_operation_unprotectable')
    // The blanket surface report is machine-readable and never suggests bash.
    expect(RELEASE_OPERATION_SURFACES.git_tag).toEqual({ surface: 'none', protectable: false, reasonCode: 'release_operation_unprotectable' })
    expect(RELEASE_OPERATION_SURFACES.composite_runner.reasonCode).toBe('release_runner_opaque')
    expect(RELEASE_OPERATION_SURFACES.npm_publish.protectable).toBe(true)
  })

  it('a malformed adoption is refused with its exact reason and never corrupts the projection', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...CONTRACT, candidate: { ref: 'main', fullSha40: 'nope' } }, 'release_candidate_sha_invalid'],
      [{ ...CONTRACT, candidate: { fullSha40: SHA } }, 'release_candidate_ref_missing'],
      [{ ...CONTRACT, operations: [] }, 'release_operations_missing'],
      [{ ...CONTRACT, operations: ['teleport'] }, 'release_operation_unknown'],
      [{ ...CONTRACT, expiresAtEpochMs: -1 }, 'release_expiry_invalid'],
    ]
    for (const [contract, reason] of cases) {
      reset()
      const p = deriveProjection([v5Notice(), command(`release adopt ${adoptLine(contract)}`)], config, scope, true).projection
      expect(p.releaseContracts, JSON.stringify(contract)).toHaveLength(0)
      expect(p.releaseDiagnostics.map((entry) => entry.reasonCode), JSON.stringify(contract)).toContain(reason)
      // Damaged release state never blocks unrelated ordinary work.
      expect(p.integrity).toBe('valid')
      expect(p.enabled).toBe(true)
    }
  })

  it('a derived contract id is deterministic when the adopter does not supply one', () => {
    const body = { ...CONTRACT } as Record<string, unknown>
    delete body.contractId
    expect(normalizeReleaseContract(body, { seq: 3, digest: 'd'.repeat(64) }).contract?.contractId)
      .toBe(normalizeReleaseContract(body, { seq: 9, digest: 'e'.repeat(64) }).contract?.contractId)
  })
})

describe('0.6.0 C10: the pre-effect gate refuses every wrong ticket', () => {
  const request = () => ({ operation: 'npm_publish' as const, candidate: { fullSha40: SHA, version: '0.6.0', artifactDigest: DIGEST }, resolvedTarget: RESOLVED, nowEpochMs: 1_700_000_000_000 })

  it('grants the exact candidate and denies the wrong one', () => {
    const p = observed()
    expect(releasePreEffectDecision(p, request())).toMatchObject({ status: 'granted', contractId: 'rel-1', reasonCode: 'release_contract_granted' })
    expect(releasePreEffectDecision(p, { ...request(), candidate: { ...request().candidate, fullSha40: OTHER_SHA } }).reasonCode)
      .toBe('release_candidate_sha_mismatch')
    expect(releasePreEffectDecision(p, { ...request(), candidate: { fullSha40: SHA } }).reasonCode)
      .toBe('release_artifact_digest_unresolved')
    expect(releasePreEffectDecision(p, { ...request(), candidate: { ...request().candidate, artifactDigest: 'f'.repeat(64) } }).reasonCode)
      .toBe('release_candidate_artifact_mismatch')
    expect(releasePreEffectDecision(p, { ...request(), candidate: { ...request().candidate, ref: 'refs/heads/other' } }).reasonCode)
      .toBe('release_candidate_ref_mismatch')
    expect(releasePreEffectDecision(p, { ...request(), candidate: { ...request().candidate, repository: 'other/repo' } }).reasonCode)
      .toBe('release_candidate_repository_mismatch')
    expect(releasePreEffectDecision(p, { ...request(), candidate: { ...request().candidate, version: '9.9.9' } }).reasonCode)
      .toBe('release_candidate_version_mismatch')
  })

  it('denies an unresolved target, an operation the contract does not cover, and an unrelated contract', () => {
    const p = observed()
    expect(releasePreEffectDecision(p, { ...request(), resolvedTarget: { artifact_id: 'x', registry: 'https://registry.npmjs.org/' } }).reasonCode)
      .toBe('release_target_unresolved')
    expect(releasePreEffectDecision(p, { operation: 'git_tag', candidate: { fullSha40: SHA } }).reasonCode)
      .toBe('release_operation_unprotectable')
    expect(releasePreEffectDecision(p, { operation: 'github_release_create', candidate: { fullSha40: SHA } }).reasonCode)
      .toBe('release_operation_unprotectable')
    expect(releasePreEffectDecision(p, { operation: 'composite_runner', candidate: { fullSha40: SHA } }).reasonCode)
      .toBe('release_runner_opaque')
    // A named contract that does not exist is reported as not-adopted, not as
    // a missing contract: the session does have release state, just not this one.
    expect(releasePreEffectDecision(p, { ...request(), contractId: 'rel-other' }).reasonCode).toBe('release_operation_not_adopted')
    expect(releaseContractFor(p, 'npm_publish')?.contractId).toBe('rel-1')
    expect(releaseContractFor(p, 'git_tag')).toBeUndefined()
  })

  it('denies an expired contract and refuses to guess when the clock is unavailable', () => {
    const p = observed()
    expect(releasePreEffectDecision(p, { ...request(), nowEpochMs: 4_000_000_000_001 }).reasonCode).toBe('release_contract_expired')
    const { nowEpochMs: _dropped, ...withoutClock } = request()
    expect(releasePreEffectDecision(p, withoutClock).reasonCode).toBe('release_expiry_unevaluable')
  })

  it('a settled operation is consumed exactly once and a replay is refused', () => {
    reset()
    const events = [
      v5Notice(),
      command(`release adopt ${adoptLine()}`),
      notice(`${RELEASE_SETTLEMENT_PREFIX}${JSON.stringify({
        contractId: 'rel-1', operation: 'npm_publish', callId: 'res-1', settledAtSeq: 0,
        readback: { kind: 'npm_integrity', identity: DIGEST }, outcome: 'settled',
      })}`),
    ]
    const p = deriveProjection(events, config, scope, true).projection
    expect(settledOperations(p, 'rel-1')).toEqual(['npm_publish'])
    expect(releasePreEffectDecision(p, request()).reasonCode).toBe('release_operation_consumed')
  })

  it('an unresolved effect stays in flight and is never re-sent', () => {
    reset()
    const events = [
      v5Notice(),
      command(`release adopt ${adoptLine()}`),
      notice(`Context Guard release reservation v1: ${JSON.stringify({
        contractId: 'rel-1', operation: 'npm_publish', callId: 'res-1', startedAtSeq: 0, status: 'in_flight',
      })}`),
    ]
    const p = deriveProjection(events, config, scope, true).projection
    expect(p.releaseReservations).toHaveLength(1)
    // Derive pins the durable event sequence, so a replay cannot forge it.
    expect(p.releaseReservations[0]!.startedAtSeq).toBe(2)
    expect(inFlightReservation(p, 'rel-1', 'npm_publish')?.callId).toBe('res-1')
    expect(releasePreEffectDecision(p, request()).reasonCode).toBe('release_operation_in_flight')
  })

  it('an unconfirmed settlement keeps the in-flight protection; a failed one does not consume', () => {
    const withSettlement = (outcome: string) => {
      reset()
      return deriveProjection([
        v5Notice(),
        command(`release adopt ${adoptLine()}`),
        notice(`Context Guard release reservation v1: ${JSON.stringify({ contractId: 'rel-1', operation: 'npm_publish', callId: 'res-1', startedAtSeq: 0, status: 'in_flight' })}`),
        notice(`${RELEASE_SETTLEMENT_PREFIX}${JSON.stringify({ contractId: 'rel-1', operation: 'npm_publish', callId: 'res-1', settledAtSeq: 0, readback: 'unavailable', outcome })}`),
      ], config, scope, true).projection
    }
    const unconfirmed = withSettlement('unconfirmed')
    expect(unconfirmed.releaseSettlements[0]!.readback).toBe('unavailable')
    expect(releasePreEffectDecision(unconfirmed, request()).reasonCode).toBe('release_operation_in_flight')

    const failed = withSettlement('failed')
    expect(releasePreEffectDecision(failed, request()).status).toBe('granted')
    expect(settledOperations(failed, 'rel-1')).toEqual([])
  })

  it('reports the coverage surface per adopted operation', () => {
    const p = observed()
    expect(releaseCoverage(p.releaseContracts[0]!)).toEqual([
      { operation: 'npm_publish', surface: 'context_guard_action', protectable: true, reasonCode: 'release_operation_protectable' },
    ])
  })

  it('a release reason code always classifies as a policy boundary', () => {
    for (const code of ['release_contract_required', 'release_operation_consumed', 'release_runner_opaque', 'release_candidate_sha_mismatch', 'strict_proof_required']) {
      expect(reasonClassOf(code), code).toBe('policy_boundary')
    }
  })
})

describe('0.6.0 C12: migration reports the rule set actually in force', () => {
  it('a legacy session keeps the v4 contract and needs no rollback action', () => {
    const p = createProjection()
    const report = migrationReport(p)
    expect(report).toMatchObject({ ruleMode: 'legacy-v4', certificateVersion: '1', unitClosure: false, rollbackRequiresStateSnapshot: false })
    expect(report.reasonCodes).toContain('legacy_session_keeps_v4_contract')
    expect(report.historyOnlyCertificateVersions).toEqual([])
  })

  it('a v5 session certifies through v2 and requires a snapshot to roll back', () => {
    reset()
    const p = deriveProjection([v5Notice()], config, scope, true).projection
    const report = migrationReport(p)
    expect(report).toMatchObject({
      ruleMode: 'v5', certificateVersion: '2', stopProtocolVersion: '3.0.0',
      unitClosure: true, rollbackRequiresStateSnapshot: true,
    })
    expect(report.historyOnlyCertificateVersions).toEqual(['1'])
    expect(report.rollbackInstruction).toContain('state snapshot')
    // The frozen domains are never rewritten by a migration.
    expect(report.preservedDigestDomains).toContain('ccg.proofManifest.v1')
    expect(report.preservedDigestDomains).toContain('ccg.certificationDigest.v3')
  })
})
