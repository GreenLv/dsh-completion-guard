import type { GuardItem, GuardProjection, TargetSourceKind } from './types.js'
import { ACTION_MANIFEST, actionCompatible, isStatefulAction, requestedIdentityKey, type SemanticAction } from './protocol-manifest.js'

/**
 * 0.6.3 K3: ONE compatibility judgement shared by preparation and execution.
 *
 * 0.6.2 let `context_guard_prepare` accept an arbitrary action/target override
 * and answer `status: prepared` with that override's recipe while the runtime
 * later refused the same action for the same item. The model was walked into an
 * unreachable path, and the two surfaces could disagree because each carried
 * its own copy of the rules.
 *
 * This module is the single decision. It is PURE: item revision, scope, action,
 * the provenance of the requested target, the resolved target and the audited
 * host capability in, one structured verdict out. Nothing here grants
 * authority — it only says whether the caller's own assumption is compatible
 * with the current obligation, and names the reachable next step.
 *
 * The dimensions stay separate on purpose, because they are different facts:
 *
 * - semantic compatibility — does the action belong to the item's own reading?
 * - target compatibility — is the resolved target the one the root selected?
 * - execution readiness — is this snapshot's obligation pending, authorized and
 *   free of an outstanding condition or constraint?
 * - adapter capability — does the installed cohort have a producer at all?
 */

/**
 * The action the caller intends, and its own target where the caller supplied
 * one. `targetSourceKind` is the provenance of the ITEM's requested target; a
 * caller-supplied `requestedTarget` is never authority and is treated as an
 * assumption about the intended target.
 */
export interface CompatibilityInput {
  /** Semantic action the caller intends for this item. */
  action: SemanticAction
  /** The item's own reading, used for the semantic comparison. */
  itemAction: SemanticAction
  /** Item/contract revision the caller read. */
  itemRevision?: number
  /** The live item's current revision. */
  currentRevision?: number
  itemKind?: GuardItem['kind']
  itemStatus?: GuardItem['status']
  authority?: GuardItem['authority']
  legacyFlags?: GuardItem['legacyFlags']
  itemDirective?: GuardItem['directive']
  authorityDisposition?: GuardItem['authorityDisposition']
  /** Whether the item's own clause is a question scope needing review (review 9/10). */
  /** The record's own qualification, read from the item (never re-derived here). */
  holdsExecutionAuthority?: boolean
  waitAuthorization?: unknown
  reboundFrom?: GuardItem['reboundFrom']
  originalAuthority?: { semanticAction?: SemanticAction; requestedTarget?: GuardItem['requestedTarget'] }
  /** The item's own target capture state. */
  targetCaptureStatus?: GuardItem['targetCaptureStatus']
  targetCaptureReasonCode?: GuardItem['targetCaptureReasonCode']
  /** The provenance of the item's requested target (0.6.3 K2). */
  targetSourceKind?: TargetSourceKind
  /** The item's own requested target. */
  requestedTarget?: GuardItem['requestedTarget']
  /** The target the caller resolved or intends. */
  resolvedTarget?: GuardItem['requestedTarget']
  /**
   * Whether the gate's own authorizing predicate accepts this target. Omitted
   * when the caller cannot evaluate it, in which case the target comparison
   * alone decides.
   */
  targetAuthorizes?: boolean
  /** Trusted host selections available in the current projection. */
  boundedSelectionAuthorized?: boolean
  /** An outstanding prohibition on the same action and target. */
  conflictingProhibition?: boolean
  /** Projection-level preconditions. */
  enabled?: boolean
  integrity?: GuardProjection['integrity']
  hostStatus?: GuardProjection['hostStatus']
  /** Whether a certification adapter exists for this action in this cohort. */
  adapterSupported?: boolean
}

/**
 * `compatible` means the caller's assumption matches the current obligation and
 * nothing about this snapshot blocks it. `incompatible` means the caller is
 * asking for something this obligation does not say (a different action or a
 * target the root did not select): the verdict is final for the assumption and
 * names the item's own action instead. `blocked` means the assumption matches
 * but this snapshot cannot execute yet — a wait, a fresh revision, a host lock,
 * a capability. The distinction is what keeps prepare from rendering an
 * executable recipe for an item the runtime will refuse.
 */
export type CompatibilityStatus = 'compatible' | 'incompatible' | 'blocked'

export type CompatibilityReasonCode =
  | 'item_revision_mismatch'
  | 'guard_disabled'
  | 'guard_integrity_unavailable'
  | 'host_lock_unavailable'
  | 'prohibition_active'
  | 'item_not_pending'
  | 'item_not_authorizing'
  | 'root_authority_unavailable'
  | 'legacy_rebind_required'
  | 'rebind_does_not_authorize_action'
  | 'action_not_compatible_with_item'
  | 'target_clarification_required'
  | 'target_environment_default'
  | 'awaiting_root_condition'
  | 'awaiting_root_wait'
  | 'human_executor'
  /**
   * 0.6.3 K1: the item's own reading is not explicitly executable (an
   * explanation, a question or an unknown action), so it is not authority.
   */
  | 'item_not_executable'
  | 'requested_resolved_target_mismatch'
  /**
   * The target this snapshot holds cannot authorize the action at all: the
   * mutation gate requires every user-selectable identity field, so a target
   * that does not carry them (or whose declared identity does not match) would
   * be refused even when it is the item's own.
   */
  | 'target_not_authorizing'
  | 'conflicting_prohibition'
  | 'adapter_unavailable'

export interface CompatibilityVerdict {
  status: CompatibilityStatus
  reasonCodes: CompatibilityReasonCode[]
  /** The action the item's own reading names, when the caller's differs. */
  itemAction?: SemanticAction
  /** The caller's assumption, echoed for the response. */
  assumedAction: SemanticAction
  /** The identity field this action must name before resolution is possible. */
  requiredIdentityField?: string
  /**
   * A separately stated certification judgement: whether a durable
   * certification path exists for this action in this cohort. It is NOT part of
   * `status` — a missing adapter never makes a root instruction incompatible,
   * and authorization never depends on it.
   */
  certifiable: boolean
  /** The exact semantic difference, when the caller's action does not belong. */
  semanticsCompatible: boolean
  /** Whether the resolved target is the one the item's own reading selected. */
  targetCompatible: boolean
}

/** The identity field a caller must supply for this action, when it has one. */
export function requiredIdentityFieldOf(action: SemanticAction): string | undefined {
  return requestedIdentityKey(action)
}

/**
 * The single compatibility judgement. `input.resolvedTarget` is compared with
 * the item's own requested target using the caller-supplied relation, so this
 * module never re-implements target identity: the caller passes the same
 * predicate it would use when authorizing.
 */
export function evaluateCompatibility(
  input: CompatibilityInput,
  targetMatches: (requested: GuardItem['requestedTarget'], resolved: GuardItem['requestedTarget']) => boolean,
): CompatibilityVerdict {
  const identityField = requiredIdentityFieldOf(input.action)
  const base = {
    assumedAction: input.action,
    ...(identityField !== undefined ? { requiredIdentityField: identityField } : {}),
    itemAction: input.itemAction,
    certifiable: input.adapterSupported === true || !isStatefulAction(input.action),
    // The assumed action is the caller's own; the item's action is what the
    // snapshot actually authorizes. Both are reported so a verdict never hides
    // which one it compared.

  }
  const incompatible = (reasonCode: CompatibilityReasonCode): CompatibilityVerdict => ({
    ...base, status: 'incompatible', reasonCodes: [reasonCode],
    semanticsCompatible: reasonCode !== 'action_not_compatible_with_item' && reasonCode !== 'rebind_does_not_authorize_action',
    targetCompatible: reasonCode !== 'requested_resolved_target_mismatch',
  })
  const blocked = (reasonCode: CompatibilityReasonCode): CompatibilityVerdict => ({
    ...base, status: 'blocked', reasonCodes: [reasonCode], semanticsCompatible: true, targetCompatible: true,
  })

  // --- the assumption itself -------------------------------------------------
  if (input.itemRevision !== undefined && input.currentRevision !== undefined
    && input.itemRevision !== input.currentRevision) {
    return { ...blocked('item_revision_mismatch'), certifiable: false }
  }
  if (input.action !== input.itemAction && !actionCompatible(input.itemAction, input.action)) {
    return incompatible('action_not_compatible_with_item')
  }
  if (input.reboundFrom && input.originalAuthority?.semanticAction === input.itemAction
    && input.originalAuthority.semanticAction !== input.action) {
    return incompatible('rebind_does_not_authorize_action')
  }
  // The target the caller resolved must be the one this obligation selected —
  // but ONLY when the obligation actually selected one. An obligation whose
  // target is still unresolved has no selection to contradict, so an explicit
  // caller target is a PROPOSAL (reported as such, never as authority) rather
  // than an incompatible assumption.
  const itemSelectedTarget = input.targetCaptureStatus === 'resolved'
    && input.targetSourceKind !== 'environment_default'
  if (input.action === input.itemAction && input.resolvedTarget !== undefined
    && itemSelectedTarget && !input.boundedSelectionAuthorized
    && !targetMatches(input.requestedTarget, input.resolvedTarget)) {
    return { ...incompatible('requested_resolved_target_mismatch'), semanticsCompatible: true, targetCompatible: false }
  }

  // --- this snapshot's readiness --------------------------------------------
  if (input.enabled === false) return blocked('guard_disabled')
  if (input.integrity !== undefined && input.integrity !== 'valid') return blocked('guard_integrity_unavailable')
  if (input.hostStatus !== undefined && input.hostStatus !== 'supported') return blocked('host_lock_unavailable')
  if (input.itemKind === 'prohibition') return blocked('prohibition_active')
  if (input.itemStatus !== undefined && input.itemStatus !== 'pending') return blocked('item_not_pending')
  if (input.itemKind !== undefined && input.itemKind !== 'requirement') return blocked('item_not_authorizing')
  if (input.authority !== undefined && input.authority !== 'root_instruction' && input.authority !== 'root_adoption') {
    return blocked('root_authority_unavailable')
  }
  if (input.legacyFlags?.length) return blocked('legacy_rebind_required')
  if (input.authorityDisposition === 'conditional_wait') return blocked('awaiting_root_condition')
  if (input.waitAuthorization !== undefined) return blocked('awaiting_root_wait')
  if (input.authorityDisposition === 'human_actor') return blocked('human_executor')
  if (input.targetCaptureStatus !== undefined && input.targetCaptureStatus !== 'resolved') {
    return blocked('target_clarification_required')
  }
  if (input.targetSourceKind === 'environment_default') return blocked('target_environment_default')
  // The gate needs the FULL user-selectable identity, not merely a matching
  // prefix of what the item happens to carry. When no caller target was
  // supplied the assumption is the item's own selection, and a selection the
  // gate would refuse is reported as blocked rather than compatible.
  if (input.resolvedTarget !== undefined && input.targetAuthorizes === false) {
    return { ...blocked('target_not_authorizing'), targetCompatible: false }
  }
  if (input.conflictingProhibition) return blocked('conflicting_prohibition')
  if (input.adapterSupported === false && isStatefulAction(input.action)) return blocked('adapter_unavailable')
  // Same last-resort rule as the gate (review 9): a reading that is not
  // explicitly executable cannot authorize a mutation, and an EXPLANATION whose
  // sentence mentions an action is not authority even though the surface reader
  // left it undecided — the action may be what the root asked to have explained.
  if (input.holdsExecutionAuthority === false) return blocked('item_not_executable')
  return { ...base, status: 'compatible', reasonCodes: [], semanticsCompatible: true, targetCompatible: true }
}

/**
 * Whether the installed cohort can certify this action at all. Kept separate
 * from {@link evaluateCompatibility} so a caller never reads a capability gap
 * as a permission or an interpretation problem.
 */
export function actionHasAdapter(action: SemanticAction): boolean {
  if (!isStatefulAction(action)) return true
  return ACTION_MANIFEST.actions[action].evidenceProducer === 'supported'
}
