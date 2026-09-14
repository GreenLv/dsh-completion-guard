import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V4_NOTICE, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import {
  inFlightReservation, isContractRevoked, normalizeReleaseContract, readbackSettlesContract,
  releaseContractFor, releaseCoverage, releasePreEffectDecision, settledOperations,
  RELEASE_OPERATION_SURFACES, RELEASE_RESERVATION_PREFIX, RELEASE_SETTLEMENT_PREFIX,
} from '../../src/domain/release.js'
import { certifyCheckpoint } from '../../src/domain/checkpoint.js'
import { migrationReport } from '../../src/domain/migration.js'
import { reasonClassOf } from '../../src/domain/reason-class.js'
import { createContextGuardCommand } from '../../src/commands/context-guard.js'
import { createProjection, type DerivedEnvelope } from '../../src/domain/types.js'

const config = { activation: 'always' as const }
const scope = { cwd: '/repo', sessionHeader: { version: 3, id: 'v060-release', createdAt: 1 } }

let seq = 0
const reset = () => { seq = 0 }
const notice = (text: string): DerivedEnvelope => ({ seq: seq++, type: 'user/message', data: {
  source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' },
  content: [{ type: 'text', text }],
} })
const v5 = (): DerivedEnvelope => notice(PROTOCOL_V5_NOTICE)
const command = (args: string): DerivedEnvelope => ({ seq: seq++, type: 'command/run', data: {
  name: 'context-guard', args, source: { kind: 'user' },
} })
const user = (text: string): DerivedEnvelope => ({ seq: seq++, type: 'user/message', data: {
  source: { kind: 'user' }, content: [{ type: 'text', text }],
} })

const SHA = 'a'.repeat(40)
const SHA256 = 'c'.repeat(64)
const SRI = `sha512-${Buffer.alloc(64, 7).toString('base64')}`
const OTHER_SHA = 'b'.repeat(40)
const OTHER_SHA256 = 'd'.repeat(64)
const PACKAGE = 'dsh-completion-guard'
const VERSION = '0.6.0'
const REGISTRY = 'https://registry.npmjs.org/'
const REPOSITORY = 'https://github.com/GreenLv/dsh-completion-guard.git'
const REF = 'refs/heads/main'

const CONTRACT = {
  contractId: 'rel-1',
  operations: ['npm_publish'],
  candidate: {
    fullSha40: SHA, ref: REF, repository: REPOSITORY, packageId: PACKAGE, version: VERSION,
    artifactSha256: SHA256, artifactSri: SRI, registry: REGISTRY,
  },
  readinessRefs: ['C1'],
  closureCertRef: 'C1',
  expiresAtEpochMs: 4_000_000_000_000,
}
const adoptLine = (contract: Record<string, unknown> = CONTRACT): string => JSON.stringify(contract)

const OBSERVED = {
  fullSha40: SHA, ref: REF, refSha: SHA, repository: REPOSITORY, packageId: PACKAGE, version: VERSION,
  artifactSha256: SHA256, artifactSri: SRI, registry: REGISTRY,
}
const RESOLVED = { artifact_id: PACKAGE, version: VERSION, registry: REGISTRY, integrity_digest: SRI }
const request = (overrides: Record<string, unknown> = {}) => ({
  operation: 'npm_publish' as const,
  observed: { ...OBSERVED } as Record<string, string | undefined>,
  resolvedTarget: { ...RESOLVED },
  nowEpochMs: 1_700_000_000_000,
  ...overrides,
} as Parameters<typeof releasePreEffectDecision>[1])

/**
 * The certificate the fixture's closure reference names. It is minted by the
 * production certifier over the same prefix the replay uses, so the gate's
 * closure check is exercised against a real checkpoint, never a fabrication.
 */
let cachedRecord: Record<string, unknown> | undefined
let cachedPrefix: DerivedEnvelope[] | undefined
function closureFixture(): { prefix: DerivedEnvelope[]; record: Record<string, unknown> } {
  if (cachedRecord && cachedPrefix) return { prefix: cachedPrefix, record: cachedRecord }
  reset()
  // A v5 session only certifies a UNIT closure, so the fixture opens U001 with a
  // real root message and then clears it: the certificate is a genuine v2
  // unit-closure certificate over an empty closure.
  const prefix: DerivedEnvelope[] = [v5(), user('创建 report.txt'), command('clear')]
  const before = deriveProjection(prefix, config, scope, true).projection
  const result = certifyCheckpoint(before, [], 'C1', false)
  if (!result.checkpoint) throw new Error('test fixture failed to certify its closure')
  const checkpoint = result.checkpoint
  cachedPrefix = prefix
  cachedRecord = {
    status: 'certified',
    certificate: {
      stop_protocol_version: checkpoint.stopProtocolVersion, certificate_version: checkpoint.certificateVersion,
      epoch: checkpoint.epoch, session_ref_digest: checkpoint.sessionRefDigest, host_lock_digest: checkpoint.hostLockDigest,
      contract_revision: checkpoint.contractRevision, contract_sha256: checkpoint.contractSha256,
      open_digest: checkpoint.openDigest, evidence_sha256: checkpoint.evidenceSha256,
      binding_digest: checkpoint.bindingDigest, certification_digest: checkpoint.certificationDigest,
      goal_ref: checkpoint.goalRef ?? null,
      ...(checkpoint.unitId !== undefined ? { unit_id: checkpoint.unitId, unit_closure_digest: checkpoint.unitClosureDigest } : {}),
    },
  }
  return { prefix: cachedPrefix, record: cachedRecord }
}

/** A projection whose replay really carries a certified closure at C1. */
function withClosure(extra: DerivedEnvelope[] = []) {
  const { prefix, record } = closureFixture()
  const suffix: DerivedEnvelope[] = [
    { seq: 100, type: 'tool/call', data: { callId: 'closure-cp', name: 'context_guard_checkpoint', arguments: '{"bindings":[]}' } },
    { seq: 101, type: 'tool/result', data: { message: { source: { callId: 'closure-cp' }, content: [{ type: 'text', text: JSON.stringify(record) }] } } },
    ...extra,
  ]
  const projection = deriveProjection([...prefix, ...suffix], config, scope, true).projection
  if (!projection.checkpoints.some((checkpoint) => checkpoint.result === 'certified')) {
    throw new Error('test fixture failed to replay its certified closure')
  }
  return projection
}

/** The same certified closure, plus an explicit root adoption. */
function adopted(extra: DerivedEnvelope[] = []) {
  return withClosure([
    { seq: 200, type: 'command/run', data: { name: 'context-guard', args: `release adopt ${adoptLine()}`, source: { kind: 'user' } } },
    ...extra,
  ])
}

/** The certified closure plus the adoption of one specific contract. */
function adoptOnly(contract: Record<string, unknown>) {
  return withClosure([
    { seq: 200, type: 'command/run', data: { name: 'context-guard', args: `release adopt ${adoptLine(contract)}`, source: { kind: 'user' } } },
  ])
}

describe('0.6.0 C10: adoption is explicit, durable, and replayable', () => {
  it('a root command adopts exactly one contract with its full typed candidate', () => {
    const p = adopted()
    expect(p.releaseContracts).toHaveLength(1)
    expect(p.releaseContracts[0]).toMatchObject({
      contractId: 'rel-1',
      operations: ['npm_publish'],
      candidate: { fullSha40: SHA, packageId: PACKAGE, version: VERSION, artifactSha256: SHA256, artifactSri: SRI, repository: REPOSITORY, ref: REF },
      readinessRefs: ['C1'], closureCertRef: 'C1',
    })
    // Idempotent: replaying the same log adopts the same single contract.
    const { prefix } = closureFixture()
    expect(deriveProjection([
      ...prefix, command(`release adopt ${adoptLine()}`), command(`release adopt ${adoptLine()}`),
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
    expect(releasePreEffectDecision(p, request()).reasonCode).toBe('release_contract_required')
  })

  it('a contract naming an unprotectable operation is refused at adoption', () => {
    reset()
    const p = deriveProjection([v5(), command(`release adopt ${adoptLine({ ...CONTRACT, operations: ['git_tag', 'npm_publish'] })}`)], config, scope, true).projection
    expect(p.releaseContracts).toHaveLength(0)
    expect(p.releaseDiagnostics.map((entry) => entry.reasonCode)).toContain('release_operation_unrouted')
    // The gap is attributed honestly: a missing Guard route is an approved
    // scope reduction, while an opaque runner is a host boundary.
    expect(RELEASE_OPERATION_SURFACES.git_tag).toEqual({
      surface: 'none', protectable: false, reasonCode: 'release_operation_unrouted', attribution: 'scope_reduction',
    })
    expect(RELEASE_OPERATION_SURFACES.composite_runner).toMatchObject({ reasonCode: 'release_runner_opaque', attribution: 'host_boundary' })
    expect(RELEASE_OPERATION_SURFACES.npm_publish).toMatchObject({ protectable: true, attribution: 'implemented' })
  })

  it('invalid adopt input is a usage error: it never poisons a valid contract', () => {
    const before = adopted()
    expect(releasePreEffectDecision(before, request()).status).toBe('granted')
    // A real user types a broken adoption after a valid one exists.
    const after = adopted([{ seq: 201, type: 'command/run', data: {
      name: 'context-guard', args: 'release adopt {not json}', source: { kind: 'user' },
    } }])
    expect(after.releaseDiagnostics.map((entry) => entry.reasonCode)).toContain('release_operations_missing')
    // The release state is NOT damaged, and the valid contract still authorizes.
    expect(after.releaseStateDamaged).toBe(false)
    expect(releasePreEffectDecision(after, request()).status).toBe('granted')
    // A readable-but-mistyped contract is equally a usage error.
    const mistyped = adopted([{ seq: 201, type: 'command/run', data: {
      name: 'context-guard', args: `release adopt ${adoptLine({ ...CONTRACT, candidate: { fullSha40: 'nope' } })}`, source: { kind: 'user' },
    } }])
    expect(mistyped.releaseStateDamaged).toBe(false)
    expect(releasePreEffectDecision(mistyped, request()).status).toBe('granted')
  })

  it('a malformed or mistyped adoption is refused with its exact reason and never corrupts the projection', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...CONTRACT, candidate: { ref: 'main', fullSha40: 'nope' } }, 'release_candidate_sha_invalid'],
      [{ ...CONTRACT, operations: [] }, 'release_operations_missing'],
      [{ ...CONTRACT, operations: ['teleport'] }, 'release_operation_unknown'],
      [{ ...CONTRACT, expiresAtEpochMs: -1 }, 'release_expiry_invalid'],
      [{ ...CONTRACT, candidate: { ...CONTRACT.candidate, artifactSha256: 'zz' } }, 'release_candidate_sha256_invalid'],
      [{ ...CONTRACT, candidate: { ...CONTRACT.candidate, artifactSri: 'sha512-not base64!!' } }, 'release_candidate_sri_invalid'],
      [{ ...CONTRACT, candidate: { ...CONTRACT.candidate, unexpected: 1 } }, 'release_candidate_field_unknown'],
      [{ ...CONTRACT, candidate: { ...CONTRACT.candidate, artifactDigest: 'neither-hex-nor-sri' } }, 'release_candidate_artifact_digest_invalid'],
    ]
    for (const [contract, reason] of cases) {
      reset()
      const p = deriveProjection([v5(), command(`release adopt ${adoptLine(contract)}`)], config, scope, true).projection
      expect(p.releaseContracts, JSON.stringify(contract)).toHaveLength(0)
      expect(p.releaseDiagnostics.map((entry) => entry.reasonCode), JSON.stringify(contract)).toContain(reason)
      // A malformed USER command never touches ordinary work and never marks
      // the persisted release state damaged.
      expect(p.integrity).toBe('valid')
      expect(p.enabled).toBe(true)
      expect(p.releaseStateDamaged).toBe(false)
    }
  })

  it('accepts the legacy artifactDigest alias by KIND instead of conflating SHA-256 with an SRI', () => {
    const asSha = normalizeReleaseContract({ ...CONTRACT, candidate: { fullSha40: SHA, artifactDigest: SHA256 } }, { seq: 1, digest: 'x' })
    expect(asSha.errors).toEqual([])
    expect(asSha.contract?.candidate).toMatchObject({ artifactSha256: SHA256 })
    expect(asSha.contract?.candidate.artifactSri).toBeUndefined()
    const asSri = normalizeReleaseContract({ ...CONTRACT, candidate: { fullSha40: SHA, artifactDigest: SRI } }, { seq: 1, digest: 'x' })
    expect(asSri.errors).toEqual([])
    expect(asSri.contract?.candidate).toMatchObject({ artifactSri: SRI })
    expect(asSri.contract?.candidate.artifactSha256).toBeUndefined()
  })

  it('a derived contract id is deterministic when the adopter does not supply one', () => {
    const body = { ...CONTRACT } as Record<string, unknown>
    delete body.contractId
    expect(normalizeReleaseContract(body, { seq: 3, digest: 'd'.repeat(64) }).contract?.contractId)
      .toBe(normalizeReleaseContract(body, { seq: 9, digest: 'e'.repeat(64) }).contract?.contractId)
  })

  it('the public adopt command reports exactly what the durable command adopts', () => {
    const p = adopted()
    const handler = createContextGuardCommand(() => p, () => {}, () => {})
    const result = handler.handler({ agent: {}, rawInput: `release adopt ${adoptLine()}` } as never) as { kind: string; text: string }
    expect(result.kind).toBe('success')
    expect(JSON.parse(result.text)).toMatchObject({
      status: 'adopted', contract_id: 'rel-1',
      candidate: { packageId: PACKAGE, artifactSri: SRI },
    })
    const rejected = handler.handler({ agent: {}, rawInput: 'release adopt {not json}' } as never) as { kind: string }
    expect(rejected.kind).toBe('error')
  })
})

describe('0.6.0 C10: revoking a contract is durable and keeps its audit', () => {
  it('a root revoke denies the next effect, preserves the record and keeps in-flight responsibility', () => {
    const reserved = notice(`${RELEASE_RESERVATION_PREFIX}${JSON.stringify({
      contractId: 'rel-1', operation: 'npm_publish', callId: 'res-1', startedAtSeq: 0, status: 'in_flight',
    })}`)
    const before = withClosure([
      { seq: 200, type: 'command/run', data: { name: 'context-guard', args: `release adopt ${adoptLine()}`, source: { kind: 'user' } } },
      reserved,
    ])
    expect(releasePreEffectDecision(before, request()).reasonCode).toBe('release_operation_in_flight')

    const revoked = adopted([reserved, command('release revoke rel-1')])
    // The audit record survives; only its authority is withdrawn.
    expect(revoked.releaseContracts).toHaveLength(1)
    expect(revoked.releaseContracts[0]!.revokedAtSeq).toBeDefined()
    expect(isContractRevoked(revoked, 'rel-1')).toBe(true)
    expect(releaseContractFor(revoked, 'npm_publish')).toBeUndefined()
    expect(releasePreEffectDecision(revoked, request()).reasonCode).toBe('release_contract_revoked')
    // The in-flight reservation is still visible, so its readback remains owed.
    expect(revoked.releaseReservations).toHaveLength(1)

    // A revoke for an unknown contract is a bounded diagnostic, not corruption.
    const unknown = adopted([command('release revoke rel-nope')])
    expect(unknown.integrity).toBe('valid')
    expect(unknown.releaseDiagnostics.map((entry) => entry.reasonCode)).toContain('release_contract_revocation_unknown')
  })

  it('the public revoke command reports the recorded state', () => {
    const revoked = adopted([command('release revoke rel-1')])
    const handler = createContextGuardCommand(() => revoked, () => {}, () => {})
    const result = handler.handler({ agent: {}, rawInput: 'release revoke rel-1' } as never) as { kind: string; text: string }
    expect(result.kind).toBe('success')
    expect(JSON.parse(result.text)).toMatchObject({ status: 'revoked', contract_id: 'rel-1' })
    const missing = handler.handler({ agent: {}, rawInput: 'release revoke rel-nope' } as never) as { kind: string }
    expect(missing.kind).toBe('error')
  })
})

describe('0.6.0 C10: the pre-effect gate binds the artifact identity it observed', () => {
  it('grants only when every declared identity matches the observed one', () => {
    const p = adopted()
    expect(releasePreEffectDecision(p, request())).toMatchObject({ status: 'granted', contractId: 'rel-1', reasonCode: 'release_contract_granted' })
    const denials: Array<[Record<string, string | undefined>, string]> = [
      [{ fullSha40: OTHER_SHA }, 'release_candidate_sha_mismatch'],
      [{ fullSha40: undefined }, 'release_candidate_sha_unresolved'],
      [{ ref: 'refs/heads/other' }, 'release_candidate_ref_mismatch'],
      [{ refSha: OTHER_SHA }, 'release_ref_commit_mismatch'],
      [{ ref: undefined }, 'release_candidate_ref_unresolved'],
      [{ repository: 'https://github.com/other/other.git' }, 'release_candidate_repository_mismatch'],
      [{ packageId: 'other-package' }, 'release_candidate_package_mismatch'],
      [{ version: '9.9.9' }, 'release_candidate_version_mismatch'],
      [{ artifactSha256: OTHER_SHA256 }, 'release_candidate_artifact_mismatch'],
      [{ artifactSha256: undefined }, 'release_artifact_sha256_unresolved'],
      [{ artifactSri: `sha512-${Buffer.alloc(64, 9).toString('base64')}` }, 'release_candidate_artifact_sri_mismatch'],
      [{ artifactSri: undefined }, 'release_artifact_sri_unresolved'],
      [{ registry: 'https://other.invalid/' }, 'release_candidate_registry_mismatch'],
    ]
    for (const [patch, reason] of denials) {
      const observed = { ...OBSERVED, ...patch }
      expect(releasePreEffectDecision(p, request({ observed })).reasonCode, JSON.stringify(patch)).toBe(reason)
    }
  })

  it('refuses an operation the contract does not cover and an unresolvable surface', () => {
    const p = adopted()
    // A named contract that does not exist is reported as not-adopted when the
    // session does have other contracts.
    expect(releasePreEffectDecision(p, request({ contractId: 'rel-other' })).reasonCode).toBe('release_operation_not_adopted')
    expect(releasePreEffectDecision(p, { operation: 'git_tag', observed: OBSERVED }).reasonCode).toBe('release_operation_unrouted')
    expect(releasePreEffectDecision(p, { operation: 'composite_runner', observed: OBSERVED }).reasonCode).toBe('release_runner_opaque')
    expect(releaseContractFor(p, 'git_tag')).toBeUndefined()
  })

  it('binds the resolved target to the contract, not merely to the command manifest', () => {
    const p = adopted()
    expect(releasePreEffectDecision(p, request({ resolvedTarget: { artifact_id: 'other-package', version: VERSION, registry: REGISTRY } })).reasonCode)
      .toBe('release_target_package_mismatch')
    expect(releasePreEffectDecision(p, request({ resolvedTarget: { artifact_id: PACKAGE, version: '1.0.0', registry: REGISTRY } })).reasonCode)
      .toBe('release_target_version_mismatch')
    expect(releasePreEffectDecision(p, request({ resolvedTarget: { artifact_id: PACKAGE, version: VERSION, registry: 'https://other.invalid/' } })).reasonCode)
      .toBe('release_target_registry_mismatch')
    expect(releasePreEffectDecision(p, request({ resolvedTarget: { artifact_id: PACKAGE, registry: REGISTRY } })).reasonCode)
      .toBe('release_target_unresolved')
  })

  it('refuses an invented readiness or closure reference', () => {
    const invented = adoptOnly({ ...CONTRACT, readinessRefs: ['nonexistent'] })
    expect(releasePreEffectDecision(invented, request()).reasonCode).toBe('release_readiness_unresolved')

    const noClosure = adoptOnly({ ...CONTRACT, readinessRefs: [], closureCertRef: 'C9' })
    expect(releasePreEffectDecision(noClosure, request()).reasonCode).toBe('release_closure_unresolved')
  })

  it('requires a measurable artifact digest, so omitting one cannot bypass the binding', () => {
    const noDigest = adoptOnly({
      ...CONTRACT, candidate: { fullSha40: SHA, repository: REPOSITORY, packageId: PACKAGE, version: VERSION, registry: REGISTRY },
    })
    expect(noDigest.releaseContracts).toHaveLength(1)
    expect(releasePreEffectDecision(noDigest, request({ observed: { ...OBSERVED, artifactSha256: undefined, artifactSri: undefined } })).reasonCode)
      .toBe('release_artifact_identity_required')
  })

  it('denies an expired contract and refuses to guess when the clock is unavailable', () => {
    const p = adopted()
    expect(releasePreEffectDecision(p, request({ nowEpochMs: 4_000_000_000_001 })).reasonCode).toBe('release_contract_expired')
    const withoutClock = request()
    delete (withoutClock as { nowEpochMs?: number }).nowEpochMs
    expect(releasePreEffectDecision(p, withoutClock).reasonCode).toBe('release_expiry_unevaluable')
  })
})

describe('0.6.0 C10: reservations distinguish a proven no-effect from an unknown effect', () => {
  const reservation = (callId = 'res-1') => notice(`${RELEASE_RESERVATION_PREFIX}${JSON.stringify({
    contractId: 'rel-1', operation: 'npm_publish', callId, startedAtSeq: 0, status: 'in_flight',
  })}`)
  const settlement = (callId: string, outcome: string, readback: unknown = 'unavailable') => notice(`${RELEASE_SETTLEMENT_PREFIX}${JSON.stringify({
    contractId: 'rel-1', operation: 'npm_publish', callId, settledAtSeq: 0, outcome, readback,
  })}`)

  it('a proven pre-effect no-effect releases the lock; every unknown outcome keeps it', () => {
    expect(releasePreEffectDecision(adopted([reservation(), settlement('res-1', 'not_effected')]), request()).status).toBe('granted')
    for (const outcome of ['failed', 'unknown', 'unconfirmed']) {
      const locked = adopted([reservation(), settlement('res-1', outcome)])
      expect(releasePreEffectDecision(locked, request()).reasonCode, outcome).toBe('release_operation_in_flight')
      expect(inFlightReservation(locked, 'rel-1', 'npm_publish')?.callId).toBe('res-1')
    }
  })

  it('a later trusted readback reconciles an unconfirmed attempt into a settlement', () => {
    const p = adopted([
      reservation(),
      settlement('res-1', 'unconfirmed'),
      settlement('res-1', 'settled', { kind: 'npm_integrity', identity: SRI }),
    ])
    expect(p.releaseSettlements).toHaveLength(1)
    expect(p.releaseSettlements[0]).toMatchObject({ outcome: 'settled', readback: { identity: SRI } })
    expect(settledOperations(p, 'rel-1')).toEqual(['npm_publish'])
    expect(releasePreEffectDecision(p, request()).reasonCode).toBe('release_operation_consumed')
  })

  it('a settled release is never downgraded by a later weaker record', () => {
    const p = adopted([
      reservation(),
      settlement('res-1', 'settled', { kind: 'npm_integrity', identity: SRI }),
      settlement('res-1', 'failed'),
    ])
    expect(p.releaseSettlements[0]).toMatchObject({ outcome: 'settled' })
    expect(releasePreEffectDecision(p, request()).reasonCode).toBe('release_operation_consumed')
  })

  it('a consumed ticket refuses the replay', () => {
    const p = adopted([reservation(), settlement('res-1', 'settled', { kind: 'npm_integrity', identity: SRI })])
    expect(releasePreEffectDecision(p, request()).reasonCode).toBe('release_operation_consumed')
  })

  it('a readback naming different bytes is not a settlement, and it damages the release state durably', () => {
    const p = adopted([reservation(), settlement('res-1', 'settled', { kind: 'npm_integrity', identity: `sha512-${Buffer.alloc(64, 3).toString('base64')}` })])
    expect(p.releaseStateDamaged).toBe(true)
    expect(releasePreEffectDecision(p, request()).reasonCode).toBe('release_state_damaged')
    // Damage is scoped to release: ordinary work keeps its own integrity.
    expect(p.integrity).toBe('valid')
  })

  it('the readback comparison is explicit about identity', () => {
    const contract = normalizeReleaseContract(CONTRACT, { seq: 1, digest: 'x' }).contract!
    expect(readbackSettlesContract(contract, { kind: 'npm_integrity', identity: SRI })).toBe('settled')
    expect(readbackSettlesContract(contract, { kind: 'npm_integrity', identity: `sha512-${Buffer.alloc(64, 5).toString('base64')}` })).toBe('mismatch')
    expect(readbackSettlesContract(contract, 'unavailable')).toBe('unconfirmed')
  })

  it('a damaged reservation blocks release without corrupting ordinary work', () => {
    const p = adopted([notice(`${RELEASE_RESERVATION_PREFIX}${JSON.stringify({
      contractId: 'rel-1', operation: 'npm_publish', callId: 'res-1', startedAtSeq: 'damaged', status: 'in_flight',
    })}`)])
    expect(p.integrity).toBe('valid')
    expect(p.releaseStateDamaged).toBe(true)
    expect(p.releaseDiagnostics.map((entry) => entry.reasonCode)).toContain('release_reservation_malformed')
    expect(releasePreEffectDecision(p, request()).reasonCode).toBe('release_state_damaged')
  })

  it('reports the coverage surface per adopted operation and classifies its reasons', () => {
    const p = adopted()
    expect(releaseCoverage(p.releaseContracts[0]!)).toEqual([
      { operation: 'npm_publish', surface: 'context_guard_action', protectable: true, reasonCode: 'release_operation_protectable', attribution: 'implemented' },
    ])
    for (const code of [
      'release_contract_required', 'release_operation_consumed', 'release_runner_opaque',
      'release_candidate_sha_mismatch', 'release_artifact_sri_unresolved', 'release_state_damaged',
      'release_closure_unresolved', 'release_contract_revoked', 'strict_proof_required',
    ]) {
      expect(reasonClassOf(code), code).toBe('policy_boundary')
    }
  })
})

describe('0.6.0 C10: adoption is ratified only by evidence that already existed', () => {
  it('a certificate minted AFTER adoption cannot ratify the adoption', () => {
    const { prefix } = closureFixture()
    // The contract names C1, but at this watermark C1 does not exist yet: the
    // adopter relied on nothing, and a later log entry must not be able to
    // supply it.
    const closureOnly = adoptLine({ ...CONTRACT, readinessRefs: [] })
    const adoptedEarly = deriveProjection([
      ...prefix,
      command(`release adopt ${closureOnly}`),
    ], config, scope, true).projection
    expect(adoptedEarly.releaseContracts).toHaveLength(1)
    expect(adoptedEarly.releaseContracts[0]!.frozenClosure).toBeUndefined()
    expect(adoptedEarly.checkpoints).toHaveLength(0)
    expect(releasePreEffectDecision(adoptedEarly, request()).reasonCode).toBe('release_closure_unresolved')

    // The real certificate is produced afterwards, exactly as the review's
    // counterexample does.
    const { record } = closureFixture()
    const late = deriveProjection([
      ...prefix,
      command(`release adopt ${closureOnly}`),
      { seq: 100, type: 'tool/call', data: { callId: 'closure-cp', name: 'context_guard_checkpoint', arguments: '{"bindings":[]}' } },
      { seq: 101, type: 'tool/result', data: { message: { source: { callId: 'closure-cp' }, content: [{ type: 'text', text: JSON.stringify(record) }] } } },
    ], config, scope, true).projection
    expect(late.integrity).toBe('valid')
    expect(late.checkpoints.some((checkpoint) => checkpoint.result === 'certified')).toBe(true)
    // Still refused: the certificate did not exist when the contract was made.
    expect(releasePreEffectDecision(late, request()).reasonCode).toBe('release_closure_unresolved')
  })

  it('a certificate that existed at adoption is frozen by identity and stays valid later', () => {
    const p = adopted()
    const frozen = p.releaseContracts[0]!.frozenClosure
    expect(frozen).toBeDefined()
    expect(frozen!.id).toBe('C1')
    expect(frozen!.certificationDigest).toMatch(/^[0-9a-f]{64}$/)
    // A later obligation (the release instruction) does not invalidate it...
    const afterNewTask = adopted([{ seq: 201, type: 'user/message', data: {
      source: { kind: 'user' }, content: [{ type: 'text', text: `Publish package ${PACKAGE} version ${VERSION} registry ${REGISTRY}` }],
    } }])
    expect(releasePreEffectDecision(afterNewTask, request()).status).toBe('granted')
    // Another pending obligation after adoption also preserves the frozen closure.
    const { record } = closureFixture()
    const shadowed = deriveProjection([
      ...closureFixture().prefix,
      { seq: 100, type: 'tool/call', data: { callId: 'closure-cp', name: 'context_guard_checkpoint', arguments: '{"bindings":[]}' } },
      { seq: 101, type: 'tool/result', data: { message: { source: { callId: 'closure-cp' }, content: [{ type: 'text', text: JSON.stringify(record) }] } } },
      { seq: 200, type: 'command/run', data: { name: 'context-guard', args: `release adopt ${adoptLine()}`, source: { kind: 'user' } } },
      { seq: 201, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '创建 report.txt' }] } },
    ], config, scope, true).projection
    expect(releasePreEffectDecision(shadowed, request()).status).toBe('granted')
  })
})

describe('0.6.0 C12: migration reports the rule set actually in force', () => {
  it('a legacy session keeps the v4 contract and needs no rollback action', () => {
    const report = migrationReport(createProjection())
    expect(report).toMatchObject({ ruleMode: 'legacy-v4', certificateVersion: '1', unitClosure: false, rollbackRequiresStateSnapshot: false })
    expect(report.reasonCodes).toContain('legacy_session_keeps_v4_contract')
    expect(report.historyOnlyCertificateVersions).toEqual([])
  })

  it('a v5 session certifies through v2 and requires a snapshot to roll back', () => {
    reset()
    const p = deriveProjection([v5()], config, scope, true).projection
    const report = migrationReport(p)
    expect(report).toMatchObject({ ruleMode: 'v5', certificateVersion: '2', stopProtocolVersion: '3.0.0', unitClosure: true, rollbackRequiresStateSnapshot: true })
    expect(report.historyOnlyCertificateVersions).toEqual(['1'])
    expect(report.rollbackInstruction).toContain('state snapshot')
    expect(report.preservedDigestDomains).toContain('ccg.proofManifest.v1')
    expect(report.preservedDigestDomains).toContain('ccg.certificationDigest.v3')
  })

  it('a certificate recorded before the v5 boundary keeps its own rule set', () => {
    reset()
    const prefix: DerivedEnvelope[] = [notice(PROTOCOL_V4_NOTICE), command('clear')]
    const before = deriveProjection(prefix, config, scope, true).projection
    expect(before.boundaryProtocol).toBeUndefined()
    expect(migrationReport(before)).toMatchObject({ ruleMode: 'legacy-v4', certificateVersion: '1' })
    expect(certifyCheckpoint(before, [], 'C1', false).status).toBe('certified')
    expect(migrationReport(before).unitClosure).toBe(false)
  })
})

 it('FOLLOWUP F05-F06: release status must be read-only for the release state',()=>{
 const before=adopted(); expect(releasePreEffectDecision(before,request()).status).toBe('granted');
 const after=adopted([{seq:201,type:'command/run',data:{name:'context-guard',args:'release status',source:{kind:'user'}}}]);
 console.log('STATUS',after.releaseDiagnostics,releasePreEffectDecision(after,request()));
 expect(after.releaseStateDamaged).toBe(false);
 });

it('FOLLOWUP F04: a new authorized release task must not invalidate the accepted candidate closure',()=>{
 const p=adopted([{seq:201,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'Publish package dsh-completion-guard version 0.6.0 registry https://registry.npmjs.org/'}]}}]);
 console.log('CLOSURE',releasePreEffectDecision(p,request()),p.contractRevision,p.checkpoints.map(c=>c.contractRevision));
 expect(releasePreEffectDecision(p,request()).status).toBe('granted');
});

it('FOLLOWUP F04: a closure already stale BEFORE adoption cannot certify the adopted candidate', () => {
 const p = withClosure([
 {seq:150,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'创建 report.txt'}]}},
 {seq:200,type:'command/run',data:{name:'context-guard',args:`release adopt ${adoptLine()}`,source:{kind:'user'}}},
 ]);
 expect(p.integrity).toBe('valid');
 expect([...p.items.values()].some(i=>i.status==='pending')).toBe(true);
 expect(p.releaseContracts[0]!.adoptedAtRevision).toBeGreaterThan(p.checkpoints[0]!.contractRevision);
 expect(releasePreEffectDecision(p,request()).reasonCode).toBe('release_closure_unresolved');
});
