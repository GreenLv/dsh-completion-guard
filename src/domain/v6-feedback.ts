import type { GuardItem, GuardProjection } from './types.js'
import { needsReviewObligations } from './closure.js'
import { releaseContractFor } from './release.js'

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
  const core = projection.coreV2
  if (projection.integrity !== 'valid' || projection.durabilityWatermark !== 'confirmed'
    || core?.schema !== 'core-state/v2' || typeof core.certifiable !== 'boolean'
    || !core.predicates || typeof core.predicates !== 'object' || Array.isArray(core.predicates)
    || !Array.isArray(core.unmet_requirements) || !Array.isArray(core.current_actions)) {
    return { status: 'unknown', reasonCode: 'core_projection_unavailable', openIds: [], predicates: {}, currentActions: [] }
  }
  const predicates = core.predicates as Record<string, unknown>
  const openIds = core.unmet_requirements as unknown[]
  if (openIds.some((id) => typeof id !== 'string' || !Object.hasOwn(predicates, id))
    || Object.values(predicates).some((value) => typeof value !== 'string')) {
    return { status: 'unknown', reasonCode: 'core_projection_unavailable', openIds: [], predicates: {}, currentActions: [] }
  }
  if (Object.keys(predicates).some((id) => !sourceItemForCoreRequirement(projection, id))) {
    return { status: 'unknown', reasonCode: 'core_requirement_source_unavailable', openIds: [], predicates: {}, currentActions: [] }
  }
  if (!core.certifiable && openIds.length === 0) {
    return { status: 'unknown', reasonCode: 'core_coverage_unresolved', openIds: [],
      predicates: predicates as Record<string, string>, currentActions: [] }
  }
  return {
    status: core.certifiable ? 'observed' : 'incomplete',
    reasonCode: core.certifiable ? 'ordinary_current_closure_observed' : 'current_closure_unmet',
    openIds: openIds as string[],
    predicates: predicates as Record<string, string>,
    currentActions: core.current_actions as Array<Record<string, unknown>>,
  }
}
