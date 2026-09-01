import { describe, expect, it } from 'vitest'
import {
  PROOF_PROTOCOL_VERSION,
  bindProofToProjection,
  canonicalProjection,
  createProofManifest,
  proofDigest,
  proofEvidenceConstraints,
  sessionQuery,
  validateProofManifest,
  type ProofObligation,
} from '../../src/domain/proof.js'
import { createProjection, type GuardEvidence, type GuardItem, type GuardProjection } from '../../src/domain/types.js'

const obligation = (overrides: Partial<ProofObligation> = {}): ProofObligation => ({
  obligationId: 'R001',
  kind: 'subject_readback',
  surface: 'artifact',
  subjectIds: ['src/example.py'],
  evidenceIds: ['E0001'],
  ...overrides,
})

const item = (overrides: Partial<GuardItem> = {}): GuardItem => ({
  id: 'R001',
  revision: 1,
  kind: 'requirement',
  sourceMessageId: 'm1',
  normalizedText: 'secret requirement text',
  textSha256: 'f'.repeat(64),
  status: 'pending',
  verification: { enforced: true },
  ...overrides,
})

const evidence = (overrides: Partial<GuardEvidence> = {}): GuardEvidence => ({
  id: 'E0001',
  epoch: 1,
  callId: 'c1',
  rootCallId: 'c1',
  toolName: 'read',
  toolResultSeq: 1,
  outcome: 'success',
  capabilities: ['filesystem-read'],
  subjects: ['src/example.py'],
  surfaces: ['artifact'],
  boundedSummarySha256: 'a'.repeat(64),
  operations: [{ op: 'read', path: 'src/example.py' }],
  ...overrides,
})

function projectionWith(overrides: Partial<GuardProjection> = {}, items: GuardItem[] = [], records: GuardEvidence[] = []): GuardProjection {
  const projection = createProjection()
  projection.integrity = 'valid'
  projection.hostStatus = 'supported'
  projection.hostCohortId = 'dsh-0.1.2-alpha.3'
  for (const entry of items) projection.items.set(entry.id, entry)
  for (const record of records) projection.evidence.set(record.id, record)
  return Object.assign(projection, overrides)
}

/** A projection whose replayed state actually satisfies the base obligation. */
function boundProjection(overrides: Partial<GuardProjection> = {}): GuardProjection {
  return projectionWith(overrides, [item()], [evidence()])
}

const raw = (obligations: unknown[], assetSetSha256?: string) => ({
  proofProtocolVersion: PROOF_PROTOCOL_VERSION,
  obligations,
  ...(assetSetSha256 !== undefined ? { assetSetSha256 } : {}),
  proofSha256: proofDigest(obligations as never, assetSetSha256),
})

describe('v0.4.0 proof manifest integrity (S1)', () => {
  it('round-trips a created manifest, including the asset-set digest', () => {
    const manifest = createProofManifest([
      obligation(),
      obligation({ obligationId: 'R002', kind: 'scope_coverage', surface: 'scope', subjectIds: ['/repo'], evidenceIds: ['E0002'] }),
    ], 'a'.repeat(64))
    expect(manifest.proofProtocolVersion).toBe(PROOF_PROTOCOL_VERSION)
    expect(manifest.assetSetSha256).toBe('a'.repeat(64))
    expect(validateProofManifest(manifest)).toEqual([])
  })

  it('rejects a tampered obligation and a tampered asset-set digest via the sealed digest', () => {
    const manifest = createProofManifest([obligation()], 'b'.repeat(64))
    const tamperedObligation = JSON.parse(JSON.stringify(manifest))
    tamperedObligation.obligations[0].subjectIds = ['src/other.py']
    expect(validateProofManifest(tamperedObligation)).toContain('proof_digest_mismatch')
    const tamperedAssetSet = JSON.parse(JSON.stringify(manifest))
    tamperedAssetSet.assetSetSha256 = 'c'.repeat(64)
    expect(validateProofManifest(tamperedAssetSet)).toContain('proof_digest_mismatch')
  })

  it('rejects duplicate obligation ids, unsupported kinds and surfaces, malformed entries', () => {
    expect(validateProofManifest(raw([obligation(), obligation()]))).toContain('proof_obligation_id_duplicate_or_invalid')
    expect(validateProofManifest(raw([obligation({ kind: 'echo_only' as never })]))).toContain('proof_kind_unsupported')
    expect(validateProofManifest(raw([obligation({ surface: 'memory' as never })]))).toContain('proof_surface_unsupported')
    expect(validateProofManifest(raw(['not-an-object']))).toContain('proof_obligation_invalid')
    expect(validateProofManifest({ proofProtocolVersion: PROOF_PROTOCOL_VERSION, obligations: 'missing', proofSha256: 'a'.repeat(64) })).toContain('proof_obligations_missing')
    expect(validateProofManifest(raw([obligation()], 'nope'))).toContain('proof_asset_set_digest_invalid')
  })

  it('rejects opaque or empty subjects and empty or duplicate evidence bindings', () => {
    expect(validateProofManifest(raw([obligation({ subjectIds: ['codex:unsupported/unc'] })]))).toContain('proof_subject_invalid')
    expect(validateProofManifest(raw([obligation({ subjectIds: [] })]))).toContain('proof_subject_invalid')
    expect(validateProofManifest(raw([obligation({ evidenceIds: [] })]))).toContain('proof_evidence_invalid')
    expect(validateProofManifest(raw([obligation({ evidenceIds: ['E0001', 'E0001'] })]))).toContain('proof_evidence_invalid')
  })

  it('requires expected and observed scope digests to be present and equal', () => {
    const hex = (character: string) => character.repeat(64)
    const equal = raw([obligation({ expectedScopeDigest: hex('5'), observedScopeDigest: hex('5') })])
    expect(validateProofManifest(equal)).toEqual([])
    const diverged = raw([obligation({ expectedScopeDigest: hex('5'), observedScopeDigest: hex('6') })])
    expect(validateProofManifest(diverged)).toContain('proof_scope_digest_mismatch')
    const observedOnly = raw([obligation({ observedScopeDigest: hex('6') })])
    expect(validateProofManifest(observedOnly)).toContain('proof_scope_digest_mismatch')
    const malformed = raw([obligation({ expectedScopeDigest: 'nope' })])
    expect(validateProofManifest(malformed)).toContain('proof_scope_digest_invalid')
    const wrongVersion = JSON.parse(JSON.stringify(createProofManifest([obligation()])))
    wrongVersion.proofProtocolVersion = '0.3.0'
    expect(validateProofManifest(wrongVersion)).toContain('proof_protocol_version_mismatch')
  })

  it('normalizes obligation ordering and bindings deterministically', () => {
    const first = createProofManifest([
      obligation({ obligationId: 'R002' }),
      obligation({ obligationId: 'R001', evidenceIds: ['E0002', 'E0001'], subjectIds: ['b.py', 'a.py'] }),
    ])
    const second = createProofManifest([
      obligation({ obligationId: 'R001', evidenceIds: ['E0001', 'E0002'], subjectIds: ['a.py', 'b.py'] }),
      obligation({ obligationId: 'R002' }),
    ])
    expect(first).toEqual(second)
    expect(first.proofSha256).toBe(proofDigest(first.obligations))
  })
})

describe('v0.4.0 proof-to-projection binding (S1)', () => {
  it('rejects a well-formed proof that references an empty projection', () => {
    const proof = createProofManifest([obligation()])
    expect(bindProofToProjection(projectionWith(), proof)).toEqual(['proof_obligation_unbound'])
    const query = sessionQuery(projectionWith(), proof)
    expect(query.state).toBe('corrupt')
    expect(query.reasonCode).toBe('proof_unbound')
    expect(query.proof).toBeUndefined()
  })

  it('rejects unknown evidence ids and cross-item evidence reuse', () => {
    const proof = createProofManifest([obligation({ evidenceIds: ['E9999'] })])
    expect(bindProofToProjection(boundProjection(), proof)).toEqual(['proof_evidence_unknown'])
    const foreign = createProofManifest([obligation({ subjectIds: ['src/other.py'] })])
    expect(bindProofToProjection(boundProjection(), foreign)).toEqual(['proof_evidence_constraint_failed'])
  })

  it('rejects unknown, superseded, and non-pending obligations', () => {
    const unknown = createProofManifest([obligation({ obligationId: 'R999' })])
    expect(bindProofToProjection(boundProjection(), unknown)).toEqual(['proof_obligation_unbound'])
    const superseded = createProofManifest([obligation()])
    expect(bindProofToProjection(
      projectionWith({}, [item({ status: 'superseded' })], [evidence()]),
      superseded,
    )).toEqual(['proof_obligation_not_pending'])
    const passed = createProofManifest([obligation()])
    expect(bindProofToProjection(
      projectionWith({}, [item({ status: 'passed' })], [evidence()]),
      passed,
    )).toEqual(['proof_obligation_not_pending'])
  })

  it('binds the obligation surface to the item verification surface and scopes to the item target', () => {
    const surfaceClash = createProofManifest([obligation()])
    expect(bindProofToProjection(
      projectionWith({}, [item({ verification: { enforced: true, surface: 'ui' } })], [evidence()]),
      surfaceClash,
    )).toEqual(['proof_surface_unbound'])
    const scopeProof = createProofManifest([obligation({
      obligationId: 'R001', kind: 'scope_coverage', surface: 'scope', subjectIds: ['/repo'], evidenceIds: ['E0001'],
    })])
    const scopeItem = item({ verification: { enforced: true, subject: '/repo' }, requestedTarget: { scope: '/repo' } })
    const scopeRecord = evidence({ subjects: ['/repo'], surfaces: ['scope'], operations: [{ op: 'run', path: '/repo' }] })
    expect(bindProofToProjection(projectionWith({}, [scopeItem], [scopeRecord]), scopeProof)).toEqual([])
    const unboundScope = createProofManifest([obligation({
      obligationId: 'R001', kind: 'scope_coverage', surface: 'scope', subjectIds: ['/elsewhere'], evidenceIds: ['E0001'],
    })])
    expect(bindProofToProjection(projectionWith({}, [scopeItem], [scopeRecord]), unboundScope)).toEqual([
      'proof_evidence_constraint_failed',
      'proof_scope_subject_unbound',
    ])
  })

  it('binds a fully bound proof and returns valid only on a supported host', () => {
    const proof = createProofManifest([obligation()])
    expect(bindProofToProjection(boundProjection(), proof)).toEqual([])
    expect(sessionQuery(boundProjection(), proof)).toMatchObject({ state: 'valid', cohortId: 'dsh-0.1.2-alpha.3' })
    expect(sessionQuery(boundProjection({ hostStatus: 'unsupported' }), proof).state).toBe('unknown')
    expect(sessionQuery(boundProjection({ integrity: 'corrupt' }), proof).state).toBe('corrupt')
  })
})

describe('v0.4.0 canonical projection (S1)', () => {
  it('projects only bounded, digest-oriented state without raw log text', () => {
    const projection = projectionWith({}, [item()], [evidence()])
    const view = canonicalProjection(projection)
    expect(JSON.stringify(view)).not.toContain('secret requirement text')
    expect(view).toMatchObject({ epoch: 0, contractRevision: 0, hostStatus: 'supported', hostCohortId: 'dsh-0.1.2-alpha.3', integrity: 'valid' })
    // Deterministic: two identically built projections project byte-equal.
    expect(canonicalProjection(projectionWith({}, [item()], [evidence()]))).toEqual(view)
  })
})

describe('v0.4.0 proof evidence constraints (S1)', () => {
  it('accepts matching subject, surface, outcome, and kind-specific operations', () => {
    expect(proofEvidenceConstraints(evidence(), obligation())).toBe(true)
    expect(proofEvidenceConstraints(evidence(), obligation({ kind: 'scope_coverage', surface: 'scope', subjectIds: ['/repo'] }))).toBe(false)
  })

  it('fails closed on failure outcomes, extra surfaces, foreign subjects, and wrong roles', () => {
    expect(proofEvidenceConstraints(evidence({ outcome: 'failure' }), obligation())).toBe(false)
    expect(proofEvidenceConstraints(evidence({ surfaces: ['artifact', 'scope'] }), obligation())).toBe(false)
    expect(proofEvidenceConstraints(evidence({ subjects: ['src/other.py'] }), obligation())).toBe(false)
    expect(proofEvidenceConstraints(evidence(), obligation({ kind: 'state_verification' }))).toBe(false)
    expect(proofEvidenceConstraints(
      evidence({ evidenceRole: 'state', operations: [] }),
      obligation({ kind: 'state_verification' }),
    )).toBe(true)
  })
})
