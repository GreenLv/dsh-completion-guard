import type { GuardItem, GuardProjection } from './types.js'

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
 *   one work unit. Legacy sessions (no v5 boundary) certify the whole session
 *   instead, which is exactly what {@link certifiableOpenItems} returns.
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

/** The certifiable open obligations inside one work unit's closure. */
export function unitClosureItemIds(projection: GuardProjection, unitId: string): string[] {
  return certifiableOpenItems(projection)
    .filter((item) => item.unitId === unitId)
    .map((item) => item.id)
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
