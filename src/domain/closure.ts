import { isStatefulAction, requestedIdentityKey, requestedTargetMatchesResolved, type StatefulAction } from './protocol-manifest.js'
import type { GuardItem, GuardProjection, TargetTuple } from './types.js'
import { unitAncestorIds, unitDescendantIds } from './work-unit.js'

/**
 * The single open-closure implementation (0.6.0, C02/C04/D06-03/D06-07).
 *
 * Before 0.6.0, checkpoint, recovery, diagnostics, and the Goal gate each
 * filtered pending obligations with their own slightly different rule, and the
 * answers could disagree. Every question about "what is open" now goes through
 * this module:
 *
 * - {@link visiblePendingItems} — everything still pending, constraints first
 *   in spirit: display surfaces (recovery, status, checkpoint pages) show
 *   prohibitions too, because a constraint is never finished work.
 * - {@link certifiableOpenItems} — the obligations a completion certificate
 *   answers for: pending, not a prohibition. Prohibitions are standing
 *   constraints, never counted work; `answered` items closed by a trusted
 *   delivery are no longer open; `passed` and `superseded` never were.
 * - {@link unitClosureItemIds} — the v5 unit closure: the certified scope of
 *   one work unit, which is the unit's OWN open obligations PLUS the open
 *   obligations of every required descendant unit.
 * - {@link ancestorConstraints} / {@link ancestorConstraintForBinding} — the
 *   ancestor units' standing constraints (prohibitions and unsatisfied
 *   conditions) that stay in force for a descendant's matching obligations.
 *
 * Legacy sessions (no v5 boundary) have no units: they certify the whole
 * session, exactly what {@link certifiableOpenItems} returns.
 */

/** Every pending item, in stable display order. Constraints stay visible. */
export function visiblePendingItems(projection: GuardProjection): GuardItem[] {
  return [...projection.items.values()]
    .filter((item) => item.status === 'pending')
    .sort((a, b) => (a.revision - b.revision) || (a.id < b.id ? -1 : 1))
}

/** The obligations a completion certificate answers for: open work, no constraints. */
export function certifiableOpenItems(projection: GuardProjection): GuardItem[] {
  return visiblePendingItems(projection).filter((item) => item.kind !== 'prohibition')
}

/**
 * 0.6.3 K4: the records in the certificate's own scope that the upgrade
 * eligibility check refused to inherit. They are NOT reopened as current debt
 * and no business effect is repeated — they block the CURRENT conclusion until
 * the root resolves them, which is what makes an old misreading stop being
 * silently carried forward. The scan deliberately includes records the
 * terminal filter would skip (`answered`), because that filter is exactly what
 * hid the 0.6.2 mixed-request misreading.
 */
export function needsReviewObligations(projection: GuardProjection): GuardItem[] {
  const ordering = (a: GuardItem, b: GuardItem): number => (a.revision - b.revision) || (a.id < b.id ? -1 : 1)
  const units = projection.boundaryProtocol === 5 && projection.currentUnitId !== undefined
    ? new Set<string>([projection.currentUnitId, ...unitDescendantIds(projection, projection.currentUnitId)])
    : undefined
  return [...projection.items.values()]
    .filter((item) => {
      if (item.needsReview === undefined) return false
      // The scope is the same one a certificate answers for — the current unit
      // and its required descendants — plus every unit-less (pre-v5) record,
      // which keeps its birth rules. The selection is made on the RECORD's own
      // scope, never on a terminal status: an item already `answered` or
      // `passed` inside this scope must still be seen, while a reviewed record
      // of another unit must not leak in (review P1/K4).
      if (item.unitId === undefined) return true
      if (units === undefined) return false
      return units.has(item.unitId)
    })
    .sort(ordering)
}

/**
 * The certifiable open obligations inside one work unit's closure: the unit's
 * own open work plus the open work of every required descendant unit.
 *
 * A delegated child unit is REQUIRED work of its parent (C04): the parent has
 * not finished while the sub-unit it handed work to still has open
 * obligations, so the parent's certificate must answer for them too. The
 * reverse is deliberately not true — a child may be certified while unrelated
 * residual work exists in an ancestor or a sibling, which is what keeps a task
 * switch from being blocked by history.
 */
export function unitClosureItemIds(projection: GuardProjection, unitId: string): string[] {
  // Units only exist under a v5 boundary. A legacy session certifies the whole
  // session, so asking for a unit closure there is a caller error, not a
  // silently-shrunk scope: report nothing rather than inventing a scope.
  if (projection.boundaryProtocol !== 5) return []
  const inClosure = new Set<string>([unitId, ...unitDescendantIds(projection, unitId)])
  return certifiableOpenItems(projection)
    .filter((item) => item.unitId !== undefined && inClosure.has(item.unitId))
    .map((item) => item.id)
}

/** Whether a standing constraint declares the same action identity as an item. */
function sameRequestedIdentity(action: StatefulAction, left: TargetTuple | undefined, right: TargetTuple | undefined): boolean {
  const key = requestedIdentityKey(action)
  if (!key) return false
  if (!left || !right || !Object.hasOwn(left, key) || !Object.hasOwn(right, key)) return false
  return JSON.stringify(left[key]) === JSON.stringify(right[key])
}

/** Whether a prohibition declares no identity at all — a blanket ban on the action. */
function isBlanketProhibition(action: StatefulAction, requested: TargetTuple | undefined): boolean {
  const key = requestedIdentityKey(action)
  if (!key) return false
  return !requested || !Object.hasOwn(requested, key)
}

/** The ancestor obligations that act as standing constraints on this unit. */
function standingAncestorConstraints(projection: GuardProjection, unitId: string): GuardItem[] {
  // Ancestor lineage is a v5 unit concept: a legacy session has no units and
  // therefore no ancestor constraints to inherit.
  if (projection.boundaryProtocol !== 5) return []
  const ancestors = unitAncestorIds(projection, unitId)
  if (ancestors.length === 0) return []
  return visiblePendingItems(projection).filter((item) => {
    if (item.unitId === undefined || !ancestors.includes(item.unitId)) return false
    if (item.kind === 'prohibition') return true
    return item.authorityDisposition === 'conditional_wait' || item.waitAuthorization !== undefined
  })
}

/**
 * Ancestor-unit constraints in force for `unitId`, for the display/diagnosis
 * surface: a pending prohibition, or a pending unsatisfied condition, declared
 * by an ancestor unit and matching one of the unit's closure obligations by
 * action and declared identity.
 *
 * Prohibitions are standing constraints across the whole session, so an
 * ancestor's ban binds a descendant's obligation on the same action/target. A
 * condition is the same: a root that reserved an action for its own later
 * confirmation does not lose that reservation because a later unit asked for
 * the action again. Comparison is deliberately conservative — a prohibition
 * that names no identity is a blanket ban on its action, a condition must name
 * the same identity on both sides — so a descendant never widens authority.
 */
export interface AncestorConstraint {
  constraintId: string
  constraintUnitId: string
  /** The descendant obligation the constraint blocks. */
  itemId: string
  kind: 'prohibition' | 'condition'
  reasonCode: 'ancestor_prohibition_active' | 'ancestor_condition_unsatisfied'
}

export function ancestorConstraints(projection: GuardProjection, unitId: string): AncestorConstraint[] {
  const standing = standingAncestorConstraints(projection, unitId)
  if (standing.length === 0) return []
  const closureItemIds = unitClosureItemIds(projection, unitId)
  if (closureItemIds.length === 0) return []
  const constraints: AncestorConstraint[] = []
  for (const constraint of standing) {
    const action = constraint.semanticAction
    if (!action || action === 'generic_run' || !isStatefulAction(action)) continue
    const blanket = constraint.kind === 'prohibition' && isBlanketProhibition(action, constraint.requestedTarget)
    for (const itemId of closureItemIds) {
      const item = projection.items.get(itemId)
      if (!item || item.kind === 'prohibition' || item.id === constraint.id) continue
      if (item.semanticAction !== action) continue
      if (!blanket && !sameRequestedIdentity(action, constraint.requestedTarget, item.requestedTarget)) continue
      constraints.push({
        constraintId: constraint.id,
        constraintUnitId: constraint.unitId!,
        itemId,
        kind: constraint.kind === 'prohibition' ? 'prohibition' : 'condition',
        reasonCode: constraint.kind === 'prohibition' ? 'ancestor_prohibition_active' : 'ancestor_condition_unsatisfied',
      })
      break
    }
  }
  return constraints
}

/**
 * The ancestor constraint that blocks certifying `item` against a resolved
 * target, if any. This is the authoritative judge used by the certifier: the
 * ancestor constraint is compared with the SAME conservative identity rule the
 * mutation authorization uses, so a ban or an unsatisfied condition cannot be
 * discharged by certifying a descendant obligation that resolves the target
 * the ancestor constrained.
 */
export function ancestorConstraintForBinding(
  projection: GuardProjection,
  item: GuardItem,
  resolvedTarget: TargetTuple | undefined,
): AncestorConstraint | undefined {
  if (item.unitId === undefined) return undefined
  const action = item.semanticAction
  if (!action || action === 'generic_run' || !isStatefulAction(action)) return undefined
  for (const constraint of standingAncestorConstraints(projection, item.unitId)) {
    if (constraint.id === item.id || constraint.semanticAction !== action) continue
    const blanket = constraint.kind === 'prohibition' && isBlanketProhibition(action, constraint.requestedTarget)
    const matches = blanket || requestedTargetMatchesResolved(action, constraint.requestedTarget, resolvedTarget)
    if (!matches) continue
    return {
      constraintId: constraint.id,
      constraintUnitId: constraint.unitId!,
      itemId: item.id,
      kind: constraint.kind === 'prohibition' ? 'prohibition' : 'condition',
      reasonCode: constraint.kind === 'prohibition' ? 'ancestor_prohibition_active' : 'ancestor_condition_unsatisfied',
    }
  }
  return undefined
}

/**
 * The closure a completion certificate must answer for right now.
 *
 * Legacy sessions certify the whole session. v5 sessions certify the current
 * work unit's closure PLUS every pre-v5 obligation: items captured before the
 * boundary carry no unit and keep their birth rules, so a unit certificate
 * must never silently shrink their scope (migration table, P0 §6).
 */
export function certificateClosure(projection: GuardProjection): { unitId?: string; itemIds: string[] } {
  if (projection.boundaryProtocol === 5) {
    const legacyIds = certifiableOpenItems(projection)
      .filter((item) => item.unitId === undefined)
      .map((item) => item.id)
    const unitIds = projection.currentUnitId !== undefined
      ? unitClosureItemIds(projection, projection.currentUnitId)
      : []
    return { unitId: projection.currentUnitId, itemIds: [...legacyIds, ...unitIds] }
  }
  return { itemIds: certifiableOpenItems(projection).map((item) => item.id) }
}
