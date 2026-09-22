import type { GuardItem, GuardProjection } from './types.js'
import { needsReviewObligations } from './closure.js'
import { releaseContractFor } from './release.js'
import { unitAncestorIds } from './work-unit.js'

/** Display provenance is produced while the core requirement is constructed,
 * never inferred from the shape of its ID. */
export function sourceItemForCoreRequirement(projection: GuardProjection, id: string): {
  item: GuardItem
  origin?: NonNullable<GuardProjection['coreV2RequirementOrigins']> extends Map<string, infer T> ? T : never
} | undefined {
  const item = projection.items.get(id)
  if (item) return { item }
  const origin = projection.coreV2RequirementOrigins?.get(id)
  if (!origin) return undefined
  const source = projection.items.get(origin.itemId)
  if (!source?.observerMethod || !source.observerMethod.tools.includes(origin.action as never)
    || !Number.isSafeInteger(origin.sourceStart) || !Number.isSafeInteger(origin.sourceEnd)
    || origin.sourceStart < 0 || origin.sourceEnd <= origin.sourceStart
    || !source.spans?.some((span) => span.partIndex === 0 && span.start === origin.sourceStart
      && span.end <= origin.sourceEnd)) return undefined
  return { item: source, origin }
}

/** The default ordinary feedback scope, before inspecting current core facts. */
export function defaultV6OrdinaryFeedbackScope(projection: GuardProjection): boolean {
  const currentReleaseWork = [...projection.items.values()].some((item) => {
    if (item.semanticAction !== 'publish' || item.unitId !== projection.currentUnitId || item.status !== 'pending') return false
    const target = item.requestedTarget
    // A missing field does not prove a different candidate. Keep the adopted
    // release path until a root-sourced target actually contradicts it; never
    // fill the missing target from the contract itself.
    return projection.releaseContracts.some((record) => {
      const contract = releaseContractFor(projection, 'npm_publish', record.contractId)
      return contract !== undefined
        && (target?.artifact_id === undefined || target.artifact_id === contract.candidate.packageId)
        && (target?.version === undefined || target.version === contract.candidate.version)
        && (target?.registry === undefined || target.registry === contract.candidate.registry)
    })
  })
  return projection.boundaryProtocol === 6 && !projection.goalCompletionAdopted
    && projection.policy !== 'release'
    && !currentReleaseWork
}

interface VerifiedCore {
  certifiable: boolean
  predicates: Record<string, string>
  openIds: string[]
  currentActions: Array<Record<string, unknown>>
}

/**
 * The core object's verified shape, or the reason it cannot be read as
 * evidence. Durability, integrity, schema, field types, id consistency and
 * surfaced-source provenance are ONE chain shared by every consumer — the
 * current view and the condition-release trust check below — so no lane can
 * decide a differently-shaped core object is trustworthy (review R2F3).
 */
function verifiedCore(projection: GuardProjection): { reason: string } | { core: VerifiedCore } {
  const core = projection.coreV2
  if (projection.integrity !== 'valid' || projection.durabilityWatermark !== 'confirmed'
    || core?.schema !== 'core-state/v2' || typeof core.certifiable !== 'boolean'
    || !core.predicates || typeof core.predicates !== 'object' || Array.isArray(core.predicates)
    || !Array.isArray(core.unmet_requirements) || !Array.isArray(core.current_actions)) {
    return { reason: 'core_projection_unavailable' }
  }
  const predicates = core.predicates as Record<string, unknown>
  const openIds = core.unmet_requirements as unknown[]
  if (openIds.some((id) => typeof id !== 'string' || !Object.hasOwn(predicates, id))
    || Object.values(predicates).some((value) => typeof value !== 'string')) {
    return { reason: 'core_projection_unavailable' }
  }
  // Display provenance is required for the ids this feedback SURFACES: the
  // open work AND every constraint state it reports (recovery's standing DO
  // NOT rows and checkpoint's active_constraints both render the latter). A
  // core artifact the view never lists — for example the non-required
  // `intent:` requirement a bare resume-speech root produces — has no
  // projection item by design; demanding one collapsed the whole view to
  // unknown after an ordinary "continue" (DSH-RF family, 2026-09-22). The
  // distinction is semantic (surfaced or not), never an ID-prefix exemption:
  // a surfaced constraint without a verifiable source fails closed
  // (review F3, 2026-09-22).
  const surfaced = [...(openIds as string[]), ...Object.entries(predicates as Record<string, string>)
    .filter(([, state]) => state.startsWith('constraint_')).map(([id]) => id)]
  if (surfaced.some((id) => !sourceItemForCoreRequirement(projection, id))) {
    return { reason: 'core_requirement_source_unavailable' }
  }
  return {
    core: {
      certifiable: core.certifiable,
      predicates: predicates as Record<string, string>,
      openIds: openIds as string[],
      currentActions: core.current_actions as Array<Record<string, unknown>>,
    },
  }
}

/**
 * The core's condition-release map, but ONLY from a core object that passed
 * the full verification chain above. A corrupt, unconfirmed or unsourceable
 * core's `released` fields are not evidence and must never discharge a
 * durable root boundary: without a verified map the caller keeps the
 * boundary (review R2F3). Host-lock availability is deliberately NOT part of
 * this check — an unavailable host does not by itself unmake a verified
 * release.
 */
export function v6VerifiedCoreConditions(projection: GuardProjection): Record<string, string> | undefined {
  const verified = verifiedCore(projection)
  if ('reason' in verified) return undefined
  const conditions = projection.coreV2?.conditions
  if (!conditions || typeof conditions !== 'object' || Array.isArray(conditions)) return undefined
  return Object.fromEntries(Object.entries(conditions as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

/**
 * Whether a durable item is a root wait that is CURRENTLY pending: the record
 * carries a wait, the item is still open, it belongs to the current unit's
 * lineage (the current unit or an applicable ancestor — a switched-away
 * sibling's pending audit record is history, not current debt), and no
 * verified core release has discharged it. A record that merely CONTAINS a
 * wait field is history, not a current confirmation debt — recovery, prepare
 * detail and the boundary selector all derive the current state from this
 * ONE predicate (scope included) so the surfaces cannot disagree (reviews
 * R4F1/R5).
 */
export function isV6PendingRootWait(projection: GuardProjection, item: GuardItem | undefined): boolean {
  if (!item || item.status !== 'pending') return false
  if (item.waitAuthorization === undefined && item.authorityDisposition !== 'conditional_wait') return false
  const current = projection.currentUnitId
  if (item.unitId === undefined || current === undefined) return false
  if (item.unitId !== current && !unitAncestorIds(projection, current).includes(item.unitId)) return false
  return (v6VerifiedCoreConditions(projection) ?? {})[`condition:${item.id}`] !== 'released'
}

/** A display-only view of the confirmed shared-core closure. Historical item
 * status is deliberately not rewritten: it can still be audited or certified
 * under an explicitly adopted contract, but cannot become default v6 debt. */
export function currentV6Feedback(projection: GuardProjection): {
  status: 'observed' | 'incomplete' | 'unknown'
  reasonCode: string
  openIds: string[]
  predicates: Record<string, string>
  currentActions: Array<Record<string, unknown>>
} | undefined {
  if (!defaultV6OrdinaryFeedbackScope(projection)) return undefined
  if (projection.hostStatus !== 'supported') {
    return { status: 'unknown', reasonCode: 'host_lock_unsupported', openIds: [], predicates: {}, currentActions: [] }
  }
  const needsReview = needsReviewObligations(projection)
  if (needsReview.length > 0) {
    return { status: 'incomplete', reasonCode: 'legacy_record_needs_review',
      openIds: needsReview.map((item) => item.id),
      predicates: Object.fromEntries(needsReview.map((item) => [item.id, 'legacy_review'])), currentActions: [] }
  }
  const verified = verifiedCore(projection)
  if ('reason' in verified) {
    return { status: 'unknown', reasonCode: verified.reason, openIds: [], predicates: {}, currentActions: [] }
  }
  if (!verified.core.certifiable && verified.core.openIds.length === 0) {
    return { status: 'unknown', reasonCode: 'core_coverage_unresolved', openIds: [],
      predicates: verified.core.predicates, currentActions: [] }
  }
  return {
    status: verified.core.certifiable ? 'observed' : 'incomplete',
    reasonCode: verified.core.certifiable ? 'ordinary_current_closure_observed' : 'current_closure_unmet',
    openIds: verified.core.openIds,
    predicates: verified.core.predicates,
    currentActions: verified.core.currentActions,
  }
}
