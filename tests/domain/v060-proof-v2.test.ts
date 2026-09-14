import { describe, expect, it } from 'vitest'
import {
  PROOF_CAPABILITY_MATRIX, PROOF_KINDS_V2, PROOF_PROTOCOL_VERSION_V2,
  bindProofV2ToProjection, createProofManifestV2, proofCapabilityReport, proofDigestV2,
  proofHostSurfacesOf, proofV2Rejection, sessionQueryV2, validateProofManifestV2,
  type ProofObligationV2,
} from '../../src/domain/proof.js'
import { createProjection, type GuardEvidence, type GuardItem, type GuardProjection } from '../../src/domain/types.js'

function evidence(overrides: Partial<GuardEvidence> = {}): GuardEvidence {
  return {
    id: 'E0001', epoch: 0, callId: 'call-1', rootCallId: 'call-1', toolName: 'read', toolResultSeq: 5,
    outcome: 'success', capabilities: ['filesystem-read'], subjects: ['/repo/report.md'],
    surfaces: ['artifact'], boundedSummarySha256: 'a'.repeat(64),
    operations: [{ op: 'read', path: '/repo/report.md' }], evidenceRole: 'state', parseStatus: 'supported',
    ...overrides,
  }
}

function item(overrides: Partial<GuardItem> = {}): GuardItem {
  return {
    id: 'R001', revision: 1, kind: 'requirement', sourceMessageId: 'm2', normalizedText: 'read the report',
    textSha256: 'b'.repeat(64), status: 'pending',
    verification: { enforced: true, surface: 'artifact', subject: '/repo/report.md', operation: 'read' },
    semanticAction: 'verify', requestedTarget: { scope: '/repo' }, targetCaptureStatus: 'resolved', taskKind: 'action',
    ...overrides,
  } as GuardItem
}

function projectionWith(facts: GuardEvidence[], items: GuardItem[] = [item()]): GuardProjection {
  const p = createProjection()
  p.enabled = true
  for (const fact of facts) p.evidence.set(fact.id, fact)
  for (const entry of items) p.items.set(entry.id, entry)
  return p
}

function obligation(overrides: Partial<ProofObligationV2> = {}): ProofObligationV2 {
  return {
    obligationId: 'R001', kind: 'subject_readback', surface: 'artifact',
    subjectIds: ['/repo/report.md'], sourceIds: ['read'], operation: 'read', evidenceIds: ['E0001'],
    ...overrides,
  }
}

describe('0.6.0 proof v2 (C09/S09): the frozen v1 domain is untouched', () => {
  it('a v2 manifest is not a v1 manifest and the domains differ', () => {
    const v2 = createProofManifestV2([obligation()])
    expect(v2.proofProtocolVersion).toBe(PROOF_PROTOCOL_VERSION_V2)
    expect(validateProofManifestV2(v2)).toEqual([])
    expect(validateProofManifestV2({ ...v2, proofProtocolVersion: '0.4.0' })).toContain('proof_protocol_version_mismatch')
    // The v2 digest is a different domain, so the same obligations hash
    // differently — a v1 record can never be re-read as a v2 one.
    expect(v2.proofSha256).toBe(proofDigestV2(v2.obligations))
    expect(proofDigestV2([obligation()])).not.toBe(proofDigestV2([obligation({ subjectIds: ['/other'] })]))
  })

  it('a v2 obligation must bind a subject, a source, and a real operation', () => {
    const raw = (overrides: Partial<ProofObligationV2>) => ({
      proofProtocolVersion: PROOF_PROTOCOL_VERSION_V2,
      obligations: [obligation(overrides)],
      proofSha256: '0'.repeat(64),
    })
    expect(validateProofManifestV2(raw({ subjectIds: [] }))).toContain('proof_subject_invalid')
    expect(validateProofManifestV2(raw({ sourceIds: [] }))).toContain('proof_source_invalid')
    expect(validateProofManifestV2(raw({ operation: 'teleport' as never }))).toContain('proof_operation_unsupported')
    expect(validateProofManifestV2(raw({ kind: 'vibes' as never }))).toContain('proof_kind_unsupported')
    expect(validateProofManifestV2({ proofProtocolVersion: PROOF_PROTOCOL_VERSION_V2, obligations: [obligation()], proofSha256: '1'.repeat(64) }))
      .toContain('proof_digest_mismatch')
    // A declared scope expectation must be discharged by an equal observation.
    const undisclosed = obligation({ expectedScopeDigest: 'a'.repeat(64) })
    expect(validateProofManifestV2({ proofProtocolVersion: PROOF_PROTOCOL_VERSION_V2, obligations: [undisclosed], proofSha256: proofDigestV2([undisclosed]) }))
      .toContain('proof_scope_digest_mismatch')
  })

  it('every v2 kind declares a capability requirement and an honest surface split', () => {
    for (const kind of PROOF_KINDS_V2) {
      const spec = PROOF_CAPABILITY_MATRIX[kind]
      expect(spec.kind).toBe(kind)
      expect(spec.supportedSurfaces.length + spec.unavailableSurfaces.length).toBe(7)
      expect(spec.supportedSurfaces.some((surface) => spec.unavailableSurfaces.includes(surface))).toBe(false)
    }
    // Visual readback has exactly one producer surface, and a terminal has none.
    expect(PROOF_CAPABILITY_MATRIX.output_visual_readback.supportedSurfaces).toEqual(['visual_capture'])
    expect(PROOF_CAPABILITY_MATRIX.output_visual_readback.unavailableSurfaces).toContain('shell')
    expect(PROOF_CAPABILITY_MATRIX.output_visual_readback.readbackRequired).toBe(true)
  })
})

describe('0.6.0 proof v2 (C09/S09): a successful tool call is not a visual fact', () => {
  it('an ordinary read satisfies subject_readback but never output_visual_readback', () => {
    const fact = evidence()
    expect(proofV2Rejection(fact, obligation())).toBeUndefined()
    expect(proofV2Rejection(fact, obligation({ kind: 'output_visual_readback', surface: 'visual' })))
      .toBe('proof_producer_capability_unavailable')
  })

  it('a browser call that only succeeded proves nothing was looked at', () => {
    // The call succeeded and reports a visual surface, but carries neither the
    // visual-readback capability nor an actual read on the subject.
    const clicked = evidence({
      id: 'E0002', toolName: 'browser_click', capabilities: ['browser'], subjects: ['https://example.invalid/a'],
      operations: [{ op: 'run' }], surfaces: ['visual'],
    })
    expect(proofV2Rejection(clicked, obligation({ kind: 'output_visual_readback', surface: 'visual', subjectIds: ['https://example.invalid/a'], sourceIds: ['browser_click'], operation: 'read' })))
      .toBe('proof_producer_capability_unavailable')

    // With the capability but still no readback, the failure is the readback.
    const noRead = evidence({
      id: 'E0003', toolName: 'screenshot', capabilities: ['visual-readback'], subjects: ['/repo/out.png'],
      operations: [], surfaces: ['visual'],
    })
    expect(proofV2Rejection(noRead, obligation({ kind: 'output_visual_readback', surface: 'visual', subjectIds: ['/repo/out.png'], sourceIds: ['screenshot'], operation: 'read' })))
      .toBe('proof_readback_unavailable')

    // A real visual readback discharges it.
    const read = evidence({
      id: 'E0004', toolName: 'screenshot', capabilities: ['visual-readback'], subjects: ['/repo/out.png'],
      operations: [{ op: 'read', path: '/repo/out.png' }], surfaces: ['visual'],
    })
    expect(proofV2Rejection(read, obligation({ kind: 'output_visual_readback', surface: 'visual', subjectIds: ['/repo/out.png'], sourceIds: ['screenshot'], operation: 'read' })))
      .toBeUndefined()
  })

  it('an input asset check must be a prior-state fact, not a post-hoc read', () => {
    const post = evidence({ evidenceRole: 'effect' })
    const pre = evidence({ evidenceRole: 'resolution' })
    const check = obligation({ kind: 'input_asset_check', operation: 'read' })
    expect(proofV2Rejection(post, check)).toBe('proof_role_unbound')
    expect(proofV2Rejection(pre, check)).toBeUndefined()
  })

  it('an external fact needs a real completed external operation', () => {
    const running = evidence({ externalOperationRef: { id: 'op-1', epoch: 0, adapterId: 'dsh.jobs.v1', status: 'running' } })
    const done = evidence({ externalOperationRef: { id: 'op-1', epoch: 0, adapterId: 'dsh.jobs.v1', status: 'completed' } })
    const plain = evidence()
    const external = obligation({ kind: 'external_fact', operation: 'run', sourceIds: [] })
    expect(proofV2Rejection(plain, external)).toBe('proof_external_fact_unavailable')
    expect(proofV2Rejection(running, external)).toBe('proof_external_fact_incomplete')
    expect(proofV2Rejection(done, external)).toBeUndefined()
  })

  it('a delegated subagent result is never a proof source', () => {
    const delegated = evidence({ delegatedSubtask: true })
    expect(proofV2Rejection(delegated, obligation())).toBe('proof_source_bounded_delegation')
  })

  it('an execution fact is bound to the operation it actually performed', () => {
    const fact = evidence({ operations: [{ op: 'run' }], evidenceRole: 'effect' })
    expect(proofV2Rejection(fact, obligation({ kind: 'execution_fact', operation: 'run' }))).toBeUndefined()
    expect(proofV2Rejection(fact, obligation({ kind: 'execution_fact', operation: 'create' }))).toBe('proof_operation_unbound')
  })
})

describe('0.6.0 proof v2 (C09/S09): subject, source, and producer binding', () => {
  it('binds only a fact from the declared source about the declared subject', () => {
    const p = projectionWith([evidence()])
    const good = createProofManifestV2([obligation()])
    expect(bindProofV2ToProjection(p, good)).toEqual([])

    const wrongSource = createProofManifestV2([obligation({ sourceIds: ['bash'] })])
    expect(bindProofV2ToProjection(p, wrongSource)).toContain('proof_source_unbound')

    const wrongSubject = createProofManifestV2([obligation({ subjectIds: ['/repo/other.md'] })])
    expect(bindProofV2ToProjection(p, wrongSubject)).toContain('proof_subject_unbound')
  })

  it('binds by adapter identity as well as tool identity', () => {
    const fact = evidence({ toolName: 'context_guard_evidence', adapterId: 'context-guard.git.v1', adapterVersion: '1.0.0' })
    const p = projectionWith([fact])
    const byAdapter = createProofManifestV2([obligation({ sourceIds: ['context-guard.git.v1'] })])
    expect(bindProofV2ToProjection(p, byAdapter)).toEqual([])
  })

  it('rejects a foreign, stale, or non-pending obligation', () => {
    const p = projectionWith([evidence()])
    expect(bindProofV2ToProjection(p, createProofManifestV2([obligation({ obligationId: 'R999' })]))).toContain('proof_obligation_unbound')
    expect(bindProofV2ToProjection(projectionWith([evidence()], [item({ status: 'passed' })]), createProofManifestV2([obligation()])))
      .toContain('proof_obligation_not_pending')
    const stale = evidence({ epoch: 3 })
    expect(bindProofV2ToProjection(projectionWith([stale]), createProofManifestV2([obligation()]))).toContain('proof_evidence_wrong_epoch')
    // A surface clash between the item's contract and the obligation.
    const visual = createProofManifestV2([obligation({ surface: 'scope' })])
    expect(bindProofV2ToProjection(p, visual)).toContain('proof_surface_unbound')
  })

  it('a scope obligation must bind the item scope or subject', () => {
    const scopeItem = item({ requestedTarget: { scope: '/repo' }, verification: { enforced: true, surface: 'scope', subject: '/repo', operation: 'verify' } })
    const fact = evidence({ capabilities: ['deterministic-check'], surfaces: ['scope'], operations: [{ op: 'verify' }], subjects: ['/repo'] })
    const p = projectionWith([fact], [scopeItem])
    const good = createProofManifestV2([obligation({ kind: 'scope_coverage', surface: 'scope', subjectIds: ['/repo'], sourceIds: ['read'], operation: 'verify' })])
    expect(bindProofV2ToProjection(p, good)).toEqual([])
    const foreign = createProofManifestV2([obligation({ kind: 'scope_coverage', surface: 'scope', subjectIds: ['/elsewhere'], sourceIds: ['read'], operation: 'verify' })])
    expect(bindProofV2ToProjection(p, foreign)).toContain('proof_subject_unbound')
  })

  it('a cohort with no producer reports unavailable instead of passing', () => {
    const facts = [evidence()]
    expect(proofCapabilityReport('subject_readback', facts)).toEqual({ status: 'supported' })
    expect(proofCapabilityReport('output_visual_readback', facts)).toEqual({ status: 'unavailable', reasonCode: 'proof_producer_capability_unavailable' })
    expect(proofCapabilityReport('external_fact', facts)).toEqual({ status: 'unavailable', reasonCode: 'proof_producer_capability_unavailable' })
    // An unobservable cohort is unavailable, never silently satisfied.
    expect(proofCapabilityReport('subject_readback', [])).toEqual({ status: 'unavailable', reasonCode: 'proof_producer_capability_unavailable' })
  })

  it('the session query fails closed on a malformed or unbound v2 proof', () => {
    const p = projectionWith([evidence()])
    expect(sessionQueryV2(p, createProofManifestV2([obligation()]))).toMatchObject({ state: 'valid' })
    expect(sessionQueryV2(p, { ...createProofManifestV2([obligation()]), proofSha256: '0'.repeat(64) })).toMatchObject({ state: 'corrupt', reasonCode: 'proof_invalid' })
    expect(sessionQueryV2(p, createProofManifestV2([obligation({ obligationId: 'R999' })]))).toMatchObject({ state: 'corrupt', reasonCode: 'proof_unbound' })
  })

  it('classifies which host surface a fact can come from', () => {
    expect(proofHostSurfacesOf(evidence())).toEqual(['native_read'])
    expect(proofHostSurfacesOf(evidence({ toolName: 'bash', capabilities: [] }))).toEqual(['shell'])
    expect(proofHostSurfacesOf(evidence({ toolName: 'write', capabilities: [] }))).toEqual(['native_write_edit'])
    expect(proofHostSurfacesOf(evidence({ toolName: 'web_fetch', capabilities: ['web-fetch'] }))).toEqual(['native_read', 'web'])
    expect(proofHostSurfacesOf(evidence({ delegatedSubtask: true }))).toEqual(['native_read', 'subagent'])
    expect(proofHostSurfacesOf(evidence({ externalOperationRef: { id: 'op', epoch: 0, adapterId: 'dsh.jobs.v1', status: 'completed' } })))
      .toEqual(['jobs', 'native_read'])
  })
})
