import type { GuardProjection, WorkUnit } from './types.js'

/**
 * Work-unit derivation rules (0.6.0, C04). Units are derived from the durable
 * message stream — nothing is ever written to the log — so the classification
 * below must stay deterministic and conservative: an ambiguous relation keeps
 * the current unit rather than inventing a new one, and a mis-assigned
 * obligation is recoverable through clarification, never through a silent
 * unit rewrite.
 *
 * The rules are the frozen P0 §3 C04 decision, in evaluation order:
 *
 * 1. The session's first root task message opens U001.
 * 2. A message explicitly linked to the current unit (item-ID reference,
 *    rebind control, a direct answer while an inquiry is open) stays in it.
 * 3. When the current unit has no open executable obligations left, a
 *    directive-bearing message opens a new unit; the old one is switched away,
 *    never retroactively closed.
 * 4. While the current unit still has open work, only an EXPLICIT switch
 *    marker (closed vocabulary, fixture-pinned) opens a new unit; anything
 *    else stays in the current unit.
 * 5. A DELEGATION-marked message opens a CHILD unit of the current unit. The
 *    child's open obligations are required descendants of the parent's
 *    closure (C04), so the parent cannot be certified while the delegated
 *    work is open, and the delegated result itself never closes the parent.
 */

/** Explicit task-switch markers; a closed vocabulary pinned by the v2 fixture. */
const SWITCH_MARKER = new RegExp([
  // A Han marker ends its span at the following punctuation or space; a \b
  // assertion would never match there, because Han characters are not \w.
  '^(?:另外|此外|另一(?:件事|个任务|个话题)|换个?话题|下一个任务|新任务|下一个问题|先做(?:另一|别的))[：:，,。。\\s]',
  '^(?:now\\s+a\\s+)?(?:different|new|separate)\\s+task\\b',
  '^next\\s+task\\b',
  '^(?:on\\s+a\\s+related\\s+note|by\\s+the\\s+way)\\b',
].join('|'), 'i')

/**
 * Explicit delegation markers; the same closed-vocabulary discipline as the
 * switch markers, pinned by the v2 fixture. Only a root message that actually
 * hands work to a subagent/subtask opens a child unit — "let the subagent …",
 * "delegate … to a subagent", "spawn a subagent …".
 */
const DELEGATION_MARKER = new RegExp([
  '(?:让|由|交给|委派给?|派给|安排)(?:一个)?(?:子代理|子任务|子会话|小助手)',
  '(?:子代理|子任务|子会话)(?:去|来|负责|执行|完成)',
  '\\bdelegate\\s+(?:this|it|the\\s+\\w+|\\w+)\\s+to\\s+(?:a\\s+|the\\s+)?(?:subagent|sub-agent|child\\s+agent)\\b',
  '\\b(?:spawn|dispatch|hand\\s+(?:this|it)\\s+off\\s+to)\\s+(?:a\\s+|the\\s+)?(?:subagent|sub-agent|child\\s+agent)\\b',
  '\\bsub-?agent\\s+(?:should|must|to)\\s+\\w+',
].join('|'), 'i')

/** An explicit reference to a contract item identity (R001/A001/P001/U001). */
const ITEM_REFERENCE = /\b(?:[RAPU]\d{3})\b/

/**
 * Whether a root message hands its work to a delegated sub-unit. A delegation
 * marker is an explicit, closed-vocabulary act: a mere mention of a subagent,
 * or a question about one, never opens a child unit.
 */
export function hasDelegationMarker(text: string): boolean {
  return DELEGATION_MARKER.test(text)
}

/**
 * Whether a root message opens a new work unit rather than joining the
 * current one. `directiveBearing` says the message produced (or would
 * produce) requirement/acceptance work; `openWorkInCurrentUnit` is evaluated
 * against the state BEFORE the message is captured.
 */
export function opensNewUnit(
  projection: GuardProjection,
  text: string,
  directiveBearing: boolean,
  openWorkInCurrentUnit: boolean,
): boolean {
  void projection
  if (!directiveBearing) return false
  // A delegation marker opens a CHILD unit regardless of the affinity default;
  // the caller distinguishes the child case through {@link opensChildUnit}.
  if (DELEGATION_MARKER.test(text)) return true
  // Rule 4's explicit marker outranks the affinity default.
  if (SWITCH_MARKER.test(text)) return true
  // Rule 3: a finished (or not-yet-opened) current unit hands over to a new one.
  return !openWorkInCurrentUnit
}

/**
 * Whether this message opens a child (delegated) unit of the current unit
 * rather than a sibling. Only meaningful together with {@link opensNewUnit}.
 */
export function opensChildUnit(projection: GuardProjection, text: string): boolean {
  return projection.currentUnitId !== undefined && DELEGATION_MARKER.test(text)
}

/** Whether the message explicitly links itself to the current unit's items. */
export function explicitlyLinkedToCurrentUnit(projection: GuardProjection, text: string): boolean {
  if (ITEM_REFERENCE.test(text)) {
    // A reference counts as linkage only when it names something that exists.
    for (const match of text.matchAll(ITEM_REFERENCE)) {
      if (projection.items.has(match[1])) return true
    }
  }
  return false
}

/** The next unit identity in the session's sequence. */
export function nextUnitId(projection: GuardProjection): string {
  let max = 0
  for (const unitId of projection.units.keys()) {
    const num = Number(unitId.slice(1))
    if (Number.isInteger(num) && num > max) max = num
  }
  return `U${String(max + 1).padStart(3, '0')}`
}

/**
 * Open a work unit.
 *
 * A SIBLING unit (no parent) becomes current and switches the previous current
 * unit away: that is a task switch, and the old unit's residual work stays
 * visible but no longer blocks the new task.
 *
 * A CHILD unit (delegated sub-unit) does NOT become current. The parent keeps
 * owning the session's certified scope, so the parent's own obligations are
 * never dropped when it delegates part of the work — the child's obligations
 * join the parent's closure as required descendants instead (C04). The child
 * is only ever created under an existing parent; a stray parent id would
 * create an orphan lineage, so it is dropped.
 */
export function openUnit(projection: GuardProjection, seq: number, headline: string, parentUnitId?: string): WorkUnit {
  const unitId = nextUnitId(projection)
  const parent = parentUnitId !== undefined && projection.units.has(parentUnitId) ? parentUnitId : undefined
  if (parent === undefined) {
    const previous = projection.currentUnitId !== undefined
      ? projection.units.get(projection.currentUnitId)
      : undefined
    if (previous && previous.switchedAwayAtSeq === undefined) previous.switchedAwayAtSeq = seq
    projection.currentUnitId = unitId
  }
  const unit: WorkUnit = {
    unitId, openedAtSeq: seq, rootInputRefs: [{ seq }], headline,
    ...(parent !== undefined ? { parentUnitId: parent } : {}),
  }
  projection.units.set(unitId, unit)
  return unit
}

/** Fold one later root message into the current unit's input references. */
export function foldIntoCurrentUnit(projection: GuardProjection, seq: number): void {
  const unit = projection.currentUnitId !== undefined ? projection.units.get(projection.currentUnitId) : undefined
  if (unit) unit.rootInputRefs.push({ seq })
}

/**
 * The ancestors of `unitId`, nearest first. Lineage is derived from the
 * derived `parentUnitId` chain; a cycle (impossible from the derivation, but
 * possible in a hand-built projection) terminates instead of hanging.
 */
export function unitAncestorIds(projection: GuardProjection, unitId: string): string[] {
  const ancestors: string[] = []
  const seen = new Set<string>([unitId])
  let cursor = projection.units.get(unitId)?.parentUnitId
  while (cursor !== undefined && !seen.has(cursor)) {
    ancestors.push(cursor)
    seen.add(cursor)
    cursor = projection.units.get(cursor)?.parentUnitId
  }
  return ancestors
}

/**
 * Every required descendant of `unitId`, in stable unit order: the units whose
 * `parentUnitId` chain reaches `unitId`. The closure of a unit includes the
 * open obligations of this set (C04).
 */
export function unitDescendantIds(projection: GuardProjection, unitId: string): string[] {
  const descendants: string[] = []
  const seen = new Set<string>([unitId])
  const queue = [unitId]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const unit of projection.units.values()) {
      if (unit.parentUnitId !== current || seen.has(unit.unitId)) continue
      seen.add(unit.unitId)
      descendants.push(unit.unitId)
      queue.push(unit.unitId)
    }
  }
  return descendants.sort()
}

/** Record one delegated round-trip inside a unit as bounded audit evidence. */
export function recordDelegation(
  projection: GuardProjection,
  unitId: string,
  ref: { callId: string; resultSeq: number; toolName: string; status: 'completed' | 'failed' | 'unknown' },
): void {
  const unit = projection.units.get(unitId)
  if (!unit) return
  const refs = unit.delegationRefs ?? []
  if (refs.some((entry) => entry.callId === ref.callId)) return
  refs.push({ ...ref })
  unit.delegationRefs = refs
}

/**
 * Whether the current unit still holds open executable work — the rule-3
 * handover test, evaluated BEFORE the new message's items are inserted.
 */
export function currentUnitHasOpenWork(projection: GuardProjection): boolean {
  if (projection.currentUnitId === undefined) return false
  return [...projection.items.values()].some((item) =>
    item.status === 'pending'
    && item.unitId === projection.currentUnitId
    && item.kind !== 'prohibition')
}
