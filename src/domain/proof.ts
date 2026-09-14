import { createHash } from 'node:crypto'
import { evidenceAvailabilityReason } from './diagnostics.js'
import type { EvidenceRole, GuardEvidence, GuardItem, GuardOperation, GuardProjection } from './types.js'

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

/* ------------------------------------------------------------------------ *
 * 0.6.0 proof v2 (C09 / DS06-E)
 *
 * The v1 three-kind manifest and its `ccg.proofManifest.v1` digest stay frozen:
 * an old record is read by the old rules and never re-interpreted. The v2
 * manifest covers the full capability matrix, binds each fact to a current
 * SUBJECT, a SOURCE (the producer the fact must come from) and an OPERATION,
 * and refuses to promote an unobservable result to a satisfied obligation:
 *
 * - tool success is only ever an `execution_fact`; it is never a visual fact.
 *   `output_visual_readback` additionally requires a fact that carries a
 *   visual-readback capability and an actual read on the subject, so a browser
 *   call that merely succeeded cannot prove the artifact was looked at.
 * - `input_asset_check` requires a PRIOR-state fact (role `resolution`) that
 *   actually read the asset, so a post-hoc read cannot be relabelled as the
 *   pre-effect check.
 * - `external_fact` requires a real external-operation reference that has
 *   completed.
 * - When the audited cohort exposes no producer for a kind, binding returns
 *   `proof_producer_capability_unavailable` rather than a silent pass.
 * ------------------------------------------------------------------------ */

export const PROOF_PROTOCOL_VERSION_V2 = '0.6.0'
/** The v2 digest domain; the v1 domain string is untouched. */
export const PROOF_MANIFEST_DOMAIN_V2 = 'ccg.proofManifest.v2'

export const PROOF_KINDS_V2 = [
  'subject_readback', 'scope_coverage', 'state_verification',
  'input_asset_check', 'output_visual_readback', 'object_url_readback',
  'execution_fact', 'external_fact',
] as const
export type ProofKindV2 = (typeof PROOF_KINDS_V2)[number]

/** Host surfaces that can carry a proof producer in the audited cohort. */
export type ProofHostSurface = 'native_read' | 'native_write_edit' | 'shell' | 'web' | 'jobs' | 'subagent' | 'visual_capture'

export interface ProofObligationV2 {
  obligationId: string
  kind: ProofKindV2
  surface: ProofSurface
  /** The current subject identities this obligation binds. */
  subjectIds: string[]
  /** Producer/source identities a satisfying fact must originate from. */
  sourceIds: string[]
  /** The operation the fact must have actually performed. */
  operation: GuardOperation
  evidenceIds: string[]
  expectedScopeDigest?: string
  observedScopeDigest?: string
}

export interface ProofManifestV2 {
  proofProtocolVersion: typeof PROOF_PROTOCOL_VERSION_V2
  obligations: ProofObligationV2[]
  proofSha256: string
}

/**
 * The frozen capability requirement per proof kind. `capabilities` is the set
 * a satisfying fact must intersect; `readbackRequired` demands an actual read
 * or verify operation (never a bare successful call); `requiredRole` pins the
 * fact to the resolution/effect/state role the semantics need; and
 * `supportedSurfaces` lists the audited host surfaces that can produce it.
 */
export interface ProofKindCapability {
  kind: ProofKindV2
  capabilities: string[]
  readbackRequired: boolean
  requiredRole?: EvidenceRole
  operationOnSubject: boolean
  supportedSurfaces: ProofHostSurface[]
  /** Host surfaces in the audited cohort that CANNOT produce this fact. */
  unavailableSurfaces: ProofHostSurface[]
}

const ALL_SURFACES: readonly ProofHostSurface[] = ['native_read', 'native_write_edit', 'shell', 'web', 'jobs', 'subagent', 'visual_capture']

function surfaces(supported: readonly ProofHostSurface[]): { supportedSurfaces: ProofHostSurface[]; unavailableSurfaces: ProofHostSurface[] } {
  return {
    supportedSurfaces: [...supported],
    unavailableSurfaces: ALL_SURFACES.filter((surface) => !supported.includes(surface)),
  }
}

export const PROOF_CAPABILITY_MATRIX: Readonly<Record<ProofKindV2, ProofKindCapability>> = {
  subject_readback: {
    kind: 'subject_readback', capabilities: ['filesystem-read', 'verify', 'deterministic-check'],
    readbackRequired: true, operationOnSubject: true, ...surfaces(['native_read', 'shell']),
  },
  scope_coverage: {
    kind: 'scope_coverage', capabilities: ['filesystem-read', 'verify', 'deterministic-check', 'web-fetch'],
    readbackRequired: true, operationOnSubject: false, ...surfaces(['native_read', 'shell', 'web']),
  },
  state_verification: {
    kind: 'state_verification', capabilities: ['filesystem-read', 'web-fetch', 'deterministic-check'],
    readbackRequired: true, requiredRole: 'state', operationOnSubject: false, ...surfaces(['native_read', 'web']),
  },
  input_asset_check: {
    kind: 'input_asset_check', capabilities: ['filesystem-read', 'web-fetch'],
    readbackRequired: true, requiredRole: 'resolution', operationOnSubject: true, ...surfaces(['native_read', 'web']),
  },
  output_visual_readback: {
    kind: 'output_visual_readback', capabilities: ['visual-readback'],
    readbackRequired: true, operationOnSubject: true, ...surfaces(['visual_capture']),
  },
  object_url_readback: {
    kind: 'object_url_readback', capabilities: ['web-fetch'],
    readbackRequired: true, operationOnSubject: true, ...surfaces(['web']),
  },
  execution_fact: {
    kind: 'execution_fact', capabilities: [],
    readbackRequired: false, requiredRole: 'effect', operationOnSubject: false, ...surfaces(['shell', 'native_write_edit', 'native_read', 'web', 'jobs', 'subagent']),
  },
  external_fact: {
    kind: 'external_fact', capabilities: [],
    readbackRequired: false, operationOnSubject: false, ...surfaces(['jobs', 'subagent']),
  },
}

/** The host surface names a fact's tool/adapter identity maps to. */
export function proofHostSurfacesOf(evidence: GuardEvidence): ProofHostSurface[] {
  const surface = new Set<ProofHostSurface>()
  if (evidence.externalOperationRef) surface.add('jobs')
  if (evidence.delegatedSubtask) surface.add('subagent')
  if (evidence.capabilities.includes('visual-readback')) surface.add('visual_capture')
  if (evidence.capabilities.includes('web-fetch')) surface.add('web')
  const writeTools = new Set(['write', 'edit', 'write_file', 'edit_file'])
  if (writeTools.has(evidence.toolName)) surface.add('native_write_edit')
  const readTools = new Set(['read', 'read_file', 'web_fetch', 'web_fetch_url', 'web_search'])
  if (readTools.has(evidence.toolName)) surface.add('native_read')
  if (['bash', 'shell', 'pwsh'].includes(evidence.toolName)) surface.add('shell')
  if (evidence.capabilities.includes('filesystem-read')) surface.add('native_read')
  return [...surface].sort()
}

function digestV2(value: unknown): string {
  return createHash('sha256').update(`${PROOF_MANIFEST_DOMAIN_V2}\n`, 'utf8').update(stable(value), 'utf8').digest('hex')
}

export function proofDigestV2(obligations: readonly ProofObligationV2[]): string {
  return digestV2({ proofProtocolVersion: PROOF_PROTOCOL_VERSION_V2, obligations: [...obligations] })
}

export function createProofManifestV2(obligations: readonly ProofObligationV2[]): ProofManifestV2 {
  const normalized = obligations.map((obligation) => ({
    obligationId: obligation.obligationId,
    kind: obligation.kind,
    surface: obligation.surface,
    subjectIds: [...obligation.subjectIds].sort(),
    sourceIds: [...obligation.sourceIds].sort(),
    operation: obligation.operation,
    evidenceIds: [...obligation.evidenceIds].sort(),
    ...(obligation.expectedScopeDigest ? { expectedScopeDigest: obligation.expectedScopeDigest } : {}),
    ...(obligation.observedScopeDigest ? { observedScopeDigest: obligation.observedScopeDigest } : {}),
  })).sort((a, b) => a.obligationId.localeCompare(b.obligationId))
  const manifest: ProofManifestV2 = {
    proofProtocolVersion: PROOF_PROTOCOL_VERSION_V2,
    obligations: normalized,
    proofSha256: proofDigestV2(normalized),
  }
  const errors = validateProofManifestV2(manifest)
  if (errors.length) throw new Error(`proof v2 manifest rejected: ${errors.join(',')}`)
  return manifest
}

export function validateProofManifestV2(manifest: unknown): string[] {
  const errors: string[] = []
  if (!manifest || typeof manifest !== 'object') return ['proof_manifest_invalid']
  const value = manifest as Record<string, unknown>
  if (value.proofProtocolVersion !== PROOF_PROTOCOL_VERSION_V2) errors.push('proof_protocol_version_mismatch')
  if (!Array.isArray(value.obligations)) errors.push('proof_obligations_missing')
  if (typeof value.proofSha256 !== 'string' || !validDigest(value.proofSha256)) errors.push('proof_digest_invalid')
  const obligations = Array.isArray(value.obligations) ? value.obligations : []
  const ids = new Set<string>()
  for (const raw of obligations) {
    if (!raw || typeof raw !== 'object') { errors.push('proof_obligation_invalid'); continue }
    const obligation = raw as Record<string, unknown>
    if (typeof obligation.obligationId !== 'string' || !obligation.obligationId || ids.has(obligation.obligationId)) errors.push('proof_obligation_id_duplicate_or_invalid')
    if (typeof obligation.obligationId === 'string') ids.add(obligation.obligationId)
    if (!(PROOF_KINDS_V2 as readonly unknown[]).includes(obligation.kind)) errors.push('proof_kind_unsupported')
    if (!['artifact', 'ui', 'visual', 'scope'].includes(String(obligation.surface))) errors.push('proof_surface_unsupported')
    if (!['create', 'write', 'modify', 'read', 'run', 'verify'].includes(String(obligation.operation))) errors.push('proof_operation_unsupported')
    // A v2 obligation binds a current subject AND a source: a fact with no
    // subject or no declared producer can never be attributed to one.
    if (!Array.isArray(obligation.subjectIds) || obligation.subjectIds.length === 0
      || obligation.subjectIds.some((id) => typeof id !== 'string' || !id)) errors.push('proof_subject_invalid')
    if (!Array.isArray(obligation.sourceIds) || obligation.sourceIds.length === 0
      || obligation.sourceIds.some((id) => typeof id !== 'string' || !id)) errors.push('proof_source_invalid')
    if (!Array.isArray(obligation.evidenceIds) || obligation.evidenceIds.length === 0
      || obligation.evidenceIds.some((id) => typeof id !== 'string' || !id)
      || new Set(obligation.evidenceIds).size !== obligation.evidenceIds.length) errors.push('proof_evidence_invalid')
    const expected = obligation.expectedScopeDigest
    const observed = obligation.observedScopeDigest
    for (const digestValue of [expected, observed]) {
      if (digestValue !== undefined && (typeof digestValue !== 'string' || !validDigest(digestValue))) errors.push('proof_scope_digest_invalid')
    }
    if (expected !== observed) errors.push('proof_scope_digest_mismatch')
  }
  if (errors.length === 0 && value.proofSha256 !== proofDigestV2(obligations as ProofObligationV2[])) errors.push('proof_digest_mismatch')
  return [...new Set(errors)]
}

/**
 * Why one fact cannot discharge one v2 obligation, or `undefined` when it can.
 * The checks are ordered so the reported reason names the first unmet
 * requirement: missing producer capability, wrong role, absent readback, wrong
 * source, wrong subject, wrong operation.
 */
export function proofV2Rejection(evidence: GuardEvidence, obligation: ProofObligationV2): string | undefined {
  const spec = PROOF_CAPABILITY_MATRIX[obligation.kind]
  if (evidence.delegatedSubtask) return 'proof_source_bounded_delegation'
  if (obligation.sourceIds.length > 0 && !obligation.sourceIds.includes(evidence.toolName) && !obligation.sourceIds.includes(evidence.adapterId ?? '')) {
    return 'proof_source_unbound'
  }
  if (evidence.outcome !== 'success') return 'proof_evidence_outcome_invalid'
  // An external fact is identified by its external-operation reference, not by
  // a local producer surface: the reference is checked first so a plain local
  // fact is reported as "no external fact" rather than as a surface mismatch.
  if (obligation.kind === 'external_fact') {
    if (!evidence.externalOperationRef) return 'proof_external_fact_unavailable'
    if (evidence.externalOperationRef.status !== 'completed') return 'proof_external_fact_incomplete'
  }
  const available = proofHostSurfacesOf(evidence)
  if (available.length === 0 || !available.some((surface) => spec.supportedSurfaces.includes(surface))) {
    return 'proof_producer_capability_unavailable'
  }
  if (spec.capabilities.length > 0 && !spec.capabilities.some((capability) => evidence.capabilities.includes(capability))) {
    return 'proof_producer_capability_unavailable'
  }
  if (spec.requiredRole !== undefined && evidence.evidenceRole !== spec.requiredRole) return 'proof_role_unbound'
  if (spec.readbackRequired) {
    const operations = evidence.operations ?? []
    if (!operations.some((entry) => entry.op === 'read' || entry.op === 'verify')) return 'proof_readback_unavailable'
    if (spec.operationOnSubject && obligation.subjectIds.length > 0) {
      const subjects = evidence.subjects
      if (!obligation.subjectIds.every((subject) => subjects.some((value) => value === subject))) return 'proof_subject_unbound'
    }
  }
  if (obligation.kind === 'state_verification' && evidence.surfaces.length > 0 && !evidence.surfaces.includes(obligation.surface)) return 'proof_surface_unbound'
  if (obligation.kind === 'execution_fact' && !(evidence.operations ?? []).some((entry) => entry.op === obligation.operation)) {
    return 'proof_operation_unbound'
  }
  return undefined
}

/**
 * The subjects an item's own obligation requires. They come from the item's
 * frozen verification contract and captured target — never from the proof
 * manifest, which is exactly what a proof must be checked against.
 */
export function requiredSubjectsOf(item: GuardItem): string[] {
  const values = new Set<string>()
  const subject = item.verification.subject
  if (typeof subject === 'string' && subject.length > 0 && subject !== 'scope') values.add(subject)
  const target = item.requestedTarget ?? {}
  // The session scope is a required subject only for a scope-surface
  // obligation: for an artifact obligation the enclosing directory is a bound,
  // not something the evidence has to read.
  if (item.verification.surface === 'scope') {
    const scope = target.scope
    if (typeof scope === 'string' && scope.length > 0 && scope !== 'scope') values.add(scope)
  }
  for (const key of ['artifact_id', 'package_id', 'service_id', 'repository']) {
    const value = target[key]
    if (typeof value === 'string' && value.length > 0 && value !== 'scope') values.add(value)
  }
  return [...values].sort()
}

/** The frozen coverage digest of a subject set: sorted, then hashed. */
export function scopeCoverageDigest(subjects: readonly string[]): string {
  return createHash('sha256').update('ccg.proofScopeCoverage.v2\n', 'utf8')
    .update(JSON.stringify([...subjects].sort()), 'utf8').digest('hex')
}

/**
 * Operations a fact may perform to discharge one proof kind. `execution_fact`
 * is bound to the obligation's own declared operation; the readback kinds
 * accept only an actual read or verify, so a bare successful call never
 * satisfies them.
 */
const KIND_OPERATIONS: Readonly<Record<ProofKindV2, readonly GuardOperation[] | 'declared'>> = {
  subject_readback: ['read', 'verify'],
  scope_coverage: ['run', 'verify'],
  state_verification: ['read', 'verify'],
  input_asset_check: ['read', 'verify'],
  output_visual_readback: ['read', 'verify'],
  object_url_readback: ['read', 'verify'],
  execution_fact: 'declared',
  external_fact: [],
}

/** Whether the fact performed an operation the kind accepts. */
export function proofOperationMatches(evidence: GuardEvidence, obligation: ProofObligationV2): boolean {
  const allowed = KIND_OPERATIONS[obligation.kind]
  const operations = evidence.operations ?? []
  if (allowed === 'declared') return operations.some((entry) => entry.op === obligation.operation)
  if (allowed.length === 0) return true
  return operations.some((entry) => allowed.includes(entry.op))
}

/**
 * Bind a v2 manifest to the live projection; [] means every obligation binds.
 *
 * The binding is the whole chain the review demanded, in one place:
 * the user's obligation (frozen subject and scope on the ITEM) → the trusted
 * producer fact (qualified by the same availability rules ordinary evidence
 * uses) → the declared source → the declared operation and its order relative
 * to the effect → the real coverage set. Only then is the obligation
 * discharged. A manifest that describes a different subject than the item
 * asked about fails even when the manifest and the facts agree with each
 * other.
 */
export function bindProofV2ToProjection(projection: GuardProjection, manifest: ProofManifestV2): string[] {
  const errors: string[] = []
  for (const obligation of manifest.obligations) {
    const item = projection.items.get(obligation.obligationId)
    if (!item) { errors.push('proof_obligation_unbound'); continue }
    if (item.status !== 'pending') { errors.push('proof_obligation_not_pending'); continue }
    if (item.verification.surface !== undefined && item.verification.surface !== obligation.surface) errors.push('proof_surface_unbound')
    const required = requiredSubjectsOf(item)
    if (required.length > 0) {
      // The manifest may not claim a subject the item never asked about, and it
      // must bind every subject the item does require. The two failures are
      // reported separately: a foreign subject is an identity error, a partial
      // one is an incomplete scope.
      if (!obligation.subjectIds.every((subject) => required.includes(subject))) { errors.push('proof_subject_unbound'); continue }
      if (!required.every((subject) => obligation.subjectIds.includes(subject))) { errors.push('proof_scope_incomplete'); continue }
    }
    const cited: GuardEvidence[] = []
    for (const evidenceId of obligation.evidenceIds) {
      const evidence = projection.evidence.get(evidenceId)
      if (!evidence) { errors.push('proof_evidence_unknown'); continue }
      // Reuse the ordinary qualification rules: wrong epoch, an unreadable or
      // unsupported adapter, a non-success outcome, an undetermined action and
      // a bounded delegated result are all unavailable proof sources.
      const availability = evidenceAvailabilityReason(evidence)
      if (availability !== undefined) { errors.push(availability); continue }
      if (evidence.epoch !== projection.epoch) { errors.push('proof_evidence_wrong_epoch'); continue }
      if (obligation.subjectIds.length > 0 && !evidence.subjects.some((subject) => obligation.subjectIds.includes(subject))) {
        errors.push('proof_subject_unbound'); continue
      }
      if (!proofOperationMatches(evidence, obligation)) { errors.push('proof_operation_unbound'); continue }
      const rejection = proofV2Rejection(evidence, obligation)
      if (rejection) { errors.push(rejection); continue }
      cited.push(evidence)
    }
    if (cited.length === 0 && obligation.evidenceIds.length > 0) continue
    if (required.length > 0 && !required.every((subject) => cited.some((fact) => fact.subjects.includes(subject)))) {
      errors.push('proof_scope_incomplete')
      continue
    }
    if (obligation.kind === 'input_asset_check') {
      // A pre-effect check that ran after the effect proves nothing about the
      // input. Any effect fact on the same subject with an earlier sequence is
      // a contradiction, not a proof.
      const firstCheck = Math.min(...cited.map((fact) => fact.toolResultSeq))
      const earlierEffect = [...projection.evidence.values()].some((fact) =>
        fact.evidenceRole === 'effect'
        && required.some((subject) => fact.subjects.includes(subject))
        && fact.toolResultSeq < firstCheck)
      if (earlierEffect) { errors.push('proof_input_check_after_effect'); continue }
    }
    if (obligation.kind === 'scope_coverage') {
      // A declared expectation must be discharged against the REAL sets: the
      // subjects the item requires and the subjects the facts actually covered.
      const covered = [...new Set(cited.flatMap((fact) => fact.subjects))].sort()
      if (obligation.expectedScopeDigest !== undefined && obligation.expectedScopeDigest !== scopeCoverageDigest(required)) {
        errors.push('proof_scope_digest_unbound'); continue
      }
      if (obligation.observedScopeDigest !== undefined && obligation.observedScopeDigest !== scopeCoverageDigest(covered)) {
        errors.push('proof_scope_digest_unbound'); continue
      }
    }
  }
  return [...new Set(errors)]
}

/** The v2 session query; the v1 `sessionQuery` keeps its own frozen behaviour. */
export interface SessionQueryV2 {
  sessionRefDigest: string
  epoch: number
  contractRevision: number
  state: 'valid' | 'unknown' | 'corrupt'
  proof?: ProofManifestV2
  cohortId?: string
  reasonCode?: 'proof_invalid' | 'proof_unbound'
}

export function sessionQueryV2(projection: GuardProjection, proof?: ProofManifestV2): SessionQueryV2 {
  if (proof) {
    const structural = validateProofManifestV2(proof)
    if (structural.length) {
      return { sessionRefDigest: projection.sessionRefDigest, epoch: projection.epoch, contractRevision: projection.contractRevision, state: 'corrupt', reasonCode: 'proof_invalid', cohortId: projection.hostCohortId }
    }
    const binding = bindProofV2ToProjection(projection, proof)
    if (binding.length) {
      return { sessionRefDigest: projection.sessionRefDigest, epoch: projection.epoch, contractRevision: projection.contractRevision, state: 'corrupt', reasonCode: 'proof_unbound', cohortId: projection.hostCohortId }
    }
  }
  const state: SessionQueryV2['state'] = projection.integrity === 'valid'
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

/**
 * The capability report for one proof kind against the facts a cohort actually
 * produced: `unavailable` with a stable reason when no producer is observable,
 * never a silent pass.
 */
export function proofCapabilityReport(kind: ProofKindV2, facts: Iterable<GuardEvidence>): { status: 'supported' | 'unavailable'; reasonCode?: string } {
  for (const fact of facts) {
    if (fact.outcome !== 'success') continue
    // The probe uses the fact's own subject so the subject rule does not mask a
    // producer that this cohort genuinely has.
    const probe: ProofObligationV2 = {
      obligationId: 'probe', kind, surface: 'artifact',
      subjectIds: fact.subjects.slice(0, 1), sourceIds: [], operation: 'verify', evidenceIds: [],
    }
    if (probe.subjectIds.length === 0) probe.subjectIds = ['probe']
    if (proofV2Rejection(fact, probe) === undefined) return { status: 'supported' }
  }
  return { status: 'unavailable', reasonCode: 'proof_producer_capability_unavailable' }
}
