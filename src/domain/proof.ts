import { createHash } from 'node:crypto'
import type { GuardEvidence, GuardProjection } from './types.js'

export const PROOF_PROTOCOL_VERSION = '0.4.0'
export const PROOF_KINDS = ['subject_readback', 'scope_coverage', 'state_verification'] as const
export type ProofKind = (typeof PROOF_KINDS)[number]
export type ProofSurface = 'artifact' | 'ui' | 'visual' | 'scope'

export interface ProofObligation {
  obligationId: string
  kind: ProofKind
  surface: ProofSurface
  subjectIds: string[]
  evidenceIds: string[]
  expectedScopeDigest?: string
  observedScopeDigest?: string
}

export interface ProofManifest {
  proofProtocolVersion: typeof PROOF_PROTOCOL_VERSION
  obligations: ProofObligation[]
  proofSha256: string
  assetSetSha256?: string
}

export interface SessionQuery {
  sessionRefDigest: string
  epoch: number
  contractRevision: number
  state: 'valid' | 'unknown' | 'corrupt'
  proof?: ProofManifest
  cohortId?: string
  /** Set only when a presented proof made the query unverifiable. */
  reasonCode?: 'proof_invalid' | 'proof_unbound'
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
  return JSON.stringify(value)
}

function digest(value: unknown): string {
  return createHash('sha256').update('ccg.proofManifest.v1\n', 'utf8').update(stable(value), 'utf8').digest('hex')
}

function validDigest(value: string): boolean { return /^[0-9a-f]{64}$/.test(value) }

/**
 * The manifest digest root includes every integrity-bearing field, so a
 * tampered asset-set digest is exactly as detectable as a tampered obligation.
 */
export function proofDigest(obligations: readonly ProofObligation[], assetSetSha256?: string): string {
  return digest({
    proofProtocolVersion: PROOF_PROTOCOL_VERSION,
    obligations: [...obligations],
    ...(assetSetSha256 !== undefined ? { assetSetSha256 } : {}),
  })
}

export function validateProofManifest(manifest: unknown): string[] {
  const errors: string[] = []
  if (!manifest || typeof manifest !== 'object') return ['proof_manifest_invalid']
  const value = manifest as Record<string, unknown>
  if (value.proofProtocolVersion !== PROOF_PROTOCOL_VERSION) errors.push('proof_protocol_version_mismatch')
  if (!Array.isArray(value.obligations)) errors.push('proof_obligations_missing')
  if (value.assetSetSha256 !== undefined && (typeof value.assetSetSha256 !== 'string' || !validDigest(value.assetSetSha256))) errors.push('proof_asset_set_digest_invalid')
  if (typeof value.proofSha256 !== 'string' || !validDigest(value.proofSha256)) errors.push('proof_digest_invalid')
  const obligations = Array.isArray(value.obligations) ? value.obligations : []
  const ids = new Set<string>()
  for (const raw of obligations) {
    if (!raw || typeof raw !== 'object') { errors.push('proof_obligation_invalid'); continue }
    const obligation = raw as Record<string, unknown>
    if (typeof obligation.obligationId !== 'string' || ids.has(obligation.obligationId)) errors.push('proof_obligation_id_duplicate_or_invalid')
    if (typeof obligation.obligationId === 'string') ids.add(obligation.obligationId)
    if (!(PROOF_KINDS as readonly unknown[]).includes(obligation.kind)) errors.push('proof_kind_unsupported')
    if (!['artifact', 'ui', 'visual', 'scope'].includes(String(obligation.surface))) errors.push('proof_surface_unsupported')
    // An obligation with no subjects binds nothing and must not validate.
    if (!Array.isArray(obligation.subjectIds) || obligation.subjectIds.length === 0
      || obligation.subjectIds.some((id) => typeof id !== 'string' || id.startsWith('codex:unsupported/'))) errors.push('proof_subject_invalid')
    if (!Array.isArray(obligation.evidenceIds) || obligation.evidenceIds.length === 0 || new Set(obligation.evidenceIds).size !== obligation.evidenceIds.length) errors.push('proof_evidence_invalid')
    const expected = obligation.expectedScopeDigest
    const observed = obligation.observedScopeDigest
    for (const digestValue of [expected, observed]) {
      if (digestValue !== undefined && (typeof digestValue !== 'string' || !validDigest(digestValue))) errors.push('proof_scope_digest_invalid')
    }
    // A declared expectation must be discharged: observed must be present and
    // equal, so a projection that disagrees with the claimed scope can never
    // validate.
    if (expected !== undefined && observed !== expected) errors.push('proof_scope_digest_mismatch')
    if (expected === undefined && observed !== undefined) errors.push('proof_scope_digest_mismatch')
  }
  if (errors.length === 0) {
    const assetSet = typeof value.assetSetSha256 === 'string' ? value.assetSetSha256 : undefined
    if (value.proofSha256 !== proofDigest(obligations as ProofObligation[], assetSet)) errors.push('proof_digest_mismatch')
  }
  return [...new Set(errors)]
}

export function createProofManifest(obligations: readonly ProofObligation[], assetSetSha256?: string): ProofManifest {
  const normalized = obligations.map((obligation) => ({
    obligationId: obligation.obligationId,
    kind: obligation.kind,
    surface: obligation.surface,
    subjectIds: [...obligation.subjectIds].sort(),
    evidenceIds: [...obligation.evidenceIds].sort(),
    ...(obligation.expectedScopeDigest ? { expectedScopeDigest: obligation.expectedScopeDigest } : {}),
    ...(obligation.observedScopeDigest ? { observedScopeDigest: obligation.observedScopeDigest } : {}),
  })).sort((a, b) => a.obligationId.localeCompare(b.obligationId))
  const manifest: ProofManifest = {
    proofProtocolVersion: PROOF_PROTOCOL_VERSION,
    obligations: normalized,
    // assetSetSha256 is set before the digest so the sealed manifest covers it.
    ...(assetSetSha256 !== undefined ? { assetSetSha256 } : {}),
    proofSha256: proofDigest(normalized, assetSetSha256),
  }
  const errors = validateProofManifest(manifest)
  if (errors.length) throw new Error(`proof manifest rejected: ${errors.join(',')}`)
  return manifest
}

/**
 * Bind a structurally valid proof to the actual replayed projection: every
 * obligation must name a pending item, every evidence id must exist in the
 * projection, and every bound evidence must satisfy the obligation's kind,
 * surface, subject, and outcome constraints. An empty projection therefore
 * rejects any proof, and cross-item or foreign evidence can never bind.
 */
export function bindProofToProjection(projection: GuardProjection, proof: ProofManifest): string[] {
  const errors: string[] = []
  const items = projection.items
  const evidence = projection.evidence
  for (const obligation of proof.obligations) {
    const item = items.get(obligation.obligationId)
    if (!item) { errors.push('proof_obligation_unbound'); continue }
    if (item.status !== 'pending') { errors.push('proof_obligation_not_pending'); continue }
    // When the item declares its verification surface, the obligation must
    // agree; a visual obligation can never bind to an artifact-only item.
    if (item.verification.surface !== undefined && item.verification.surface !== obligation.surface) {
      errors.push('proof_surface_unbound')
    }
    const seen = new Set<string>()
    for (const evidenceId of obligation.evidenceIds) {
      const record = evidence.get(evidenceId)
      if (!record) { errors.push('proof_evidence_unknown'); continue }
      if (!seen.has(evidenceId)) seen.add(evidenceId)
      if (record.outcome !== 'success') { errors.push('proof_evidence_outcome_invalid'); continue }
      if (!proofEvidenceConstraints(record, obligation)) errors.push('proof_evidence_constraint_failed')
    }
    if (obligation.kind === 'scope_coverage') {
      const itemScope = item.requestedTarget?.scope
      const itemSubject = item.verification.subject
      const bound = obligation.subjectIds.every((subject) => subject === itemScope || subject === itemSubject)
      if (!bound) errors.push('proof_scope_subject_unbound')
    }
  }
  return [...new Set(errors)]
}

export function canonicalProjection(projection: GuardProjection): Record<string, unknown> {
  return {
    epoch: projection.epoch,
    contractRevision: projection.contractRevision,
    sessionRefDigest: projection.sessionRefDigest,
    hostLockDigest: projection.hostLockDigest,
    hostStatus: projection.hostStatus,
    hostCohortId: projection.hostCohortId,
    integrity: projection.integrity,
    items: [...projection.items.values()].map(({ id, revision, kind, status, semanticAction, requestedTarget, verification }) => ({ id, revision, kind, status, semanticAction, requestedTarget, verification })).sort((a, b) => a.id.localeCompare(b.id)),
    evidence: [...projection.evidence.values()].map(({ id, epoch, toolName, outcome, capabilities, subjects, surfaces, operations, semanticAction, evidenceRole, resolvedTarget, observedState }) => ({ id, epoch, toolName, outcome, capabilities, subjects, surfaces, operations, semanticAction, evidenceRole, resolvedTarget, observedState })).sort((a, b) => a.id.localeCompare(b.id)),
    checkpoints: projection.checkpoints.map(({ id, certificationDigest, result }) => ({ id, certificationDigest, result })),
  }
}

export function sessionQuery(projection: GuardProjection, proof?: ProofManifest): SessionQuery {
  // A malformed proof makes the whole query result corrupt: a replay must
  // never present an unverifiable proof as usable state.
  if (proof) {
    const structural = validateProofManifest(proof)
    if (structural.length) {
      return { sessionRefDigest: projection.sessionRefDigest, epoch: projection.epoch, contractRevision: projection.contractRevision, state: 'corrupt', reasonCode: 'proof_invalid', cohortId: projection.hostCohortId }
    }
    // A well-formed proof that does not bind to the replayed projection
    // (unknown obligations, foreign evidence, mismatched subjects) is equally
    // unverifiable and fails closed instead of returning valid.
    const binding = bindProofToProjection(projection, proof)
    if (binding.length) {
      return { sessionRefDigest: projection.sessionRefDigest, epoch: projection.epoch, contractRevision: projection.contractRevision, state: 'corrupt', reasonCode: 'proof_unbound', cohortId: projection.hostCohortId }
    }
  }
  // Fail closed: state is only `valid` with valid integrity AND a supported
  // host lock; an unsupported/unavailable host leaves the state uncertifiable
  // (`unknown`), never silently valid.
  const state: SessionQuery['state'] = projection.integrity === 'valid'
    ? (projection.hostStatus === 'supported' ? 'valid' : 'unknown')
    : projection.integrity
  return {
    sessionRefDigest: projection.sessionRefDigest,
    epoch: projection.epoch,
    contractRevision: projection.contractRevision,
    state,
    ...(proof ? { proof } : {}),
    cohortId: projection.hostCohortId,
  }
}

export function proofEvidenceConstraints(evidence: GuardEvidence, obligation: ProofObligation): boolean {
  if (evidence.outcome !== 'success' || evidence.surfaces.length !== 1 || evidence.surfaces[0] !== obligation.surface) return false
  if (!obligation.subjectIds.every((subject) => evidence.subjects.includes(subject))) return false
  if (obligation.kind === 'subject_readback' && !(evidence.operations ?? []).some(({ op }) => op === 'read' || op === 'verify')) return false
  if (obligation.kind === 'scope_coverage' && !(evidence.operations ?? []).some(({ op }) => op === 'run' || op === 'verify')) return false
  if (obligation.kind === 'state_verification' && evidence.evidenceRole !== 'state') return false
  return true
}
