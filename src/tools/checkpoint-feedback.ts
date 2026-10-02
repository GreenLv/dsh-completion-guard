import { bindingIndividuallyAccepted, type CheckpointResult } from '../domain/checkpoint.js'
import { ancestorConstraintForBinding, certificateClosure, needsReviewObligations } from '../domain/closure.js'
import { sha256 } from '../domain/canonicalize.js'
import { confirmedV6CoreDiagnostic } from '../domain/v6-feedback.js'
import type { EvidenceBinding, GuardProjection } from '../domain/types.js'

export interface SigningFeedback {
  matched: Set<string>
  remaining: Set<string>
  summary: Record<string, unknown>
}

/** Request-local display evidence. Never marks items passed or mints a certificate. */
export function signingFeedback(p: GuardProjection, bindings: EvidenceBinding[], result: CheckpointResult,
  selected?: string[]): SigningFeedback | undefined {
  if (result.checkpoint || result.status !== 'incomplete' || p.integrity !== 'valid' || p.hostStatus !== 'supported') return undefined
  const scope = new Set([...certificateClosure(p).itemIds, ...needsReviewObligations(p).map(item => item.id)])
  const groups = new Map<string, EvidenceBinding[]>()
  for (const binding of bindings) {
    const bucket = groups.get(binding.itemId)
    if (bucket) bucket.push(binding)
    else groups.set(binding.itemId, [binding])
  }
  const core = confirmedV6CoreDiagnostic(p)
  const matched = new Set<string>()
  for (const [id, group] of groups) {
    const item = p.items.get(id), binding = group[0]!
    // Ambiguous, waiting, legacy and compound records keep their conservative
    // diagnosis. The actual signing path still owns every authority check.
    if (core?.openIds.includes(id) || !item || !scope.has(id) || group.length !== 1 || item.legacyFlags?.length || item.needsReview
      || item.waitAuthorization || item.authorityDisposition === 'conditional_wait' || item.actionPlan?.length
      || ancestorConstraintForBinding(p, item, binding.resolvedTarget)
      || result.rejectedBindings.some(row => row.itemId === id)
      || !bindingIndividuallyAccepted(p, item, binding)) continue
    matched.add(id)
  }
  const remaining = new Set([...scope].filter(id => !matched.has(id)))
  if (core) for (const id of core.openIds) remaining.add(id)
  for (const row of result.rejectedBindings) if (row.itemId !== '*') remaining.add(row.itemId)
  const reasons = new Map<string, number>()
  const sample: Array<{ id: string; reason_code: string }> = []
  const firstByReason = new Set<string>()
  for (const id of remaining) {
    const reason = core?.predicates[id] ?? 'binding_not_matched'
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
    if (sample.length < 4 && !firstByReason.has(reason)) {
      sample.push({ id: id.length <= 128 ? id : `sha256:${sha256(id)}`, reason_code: reason.slice(0, 160) })
      firstByReason.add(reason)
    }
  }
  const unresolvedGlobal = result.rejectedBindings.some(row => row.itemId === '*'
    && (row.reasonCode !== 'current_closure_unmet' || core === undefined || core.openIds.length === 0))
  return { matched, remaining, summary: {
    scope: 'whole_contract', scope_total: scope.size, matched_binding_total: matched.size,
    remaining_total: remaining.size, remaining_sample: sample,
    remaining_reason_counts: [...reasons].slice(0, 8).map(([reason_code, count]) => ({ reason_code, count })),
    folded_reason_count: Math.max(0, reasons.size - 8),
    filtered_out_total: selected?.length ? [...remaining].filter(id => !selected.includes(id)).length : 0,
    unresolved_global: unresolvedGlobal,
    next_step: matched.size
      ? 'Retain matched bindings; do not repeat their effects or resubmit the same partial checkpoint. Resolve remaining closure/proof blockers. Omit item_ids and cursor to inspect the whole scope; keep bindings and filters unchanged when continuing a cursor.'
      : 'Resolve the remaining closure/proof blockers. Omit item_ids and cursor to inspect the whole scope; keep bindings and filters unchanged when continuing a cursor.',
  } }
}
