import type { GuardItem, GuardProjection } from './types.js'
import { sha256 } from './canonicalize.js'
import { evidenceCoverage } from './matching.js'
import { deriveItemDiagnosis, itemDiagnosis, relevantEvidence } from './diagnostics.js'
import { isStatefulAction } from './protocol-manifest.js'
import { DEPENDENCY_FREE_ONLY_CONDITION, type CapabilityGap, type CapabilityRemedy } from './capability-semantics.js'

export interface RecoveryOptions {
  rejectedBindings?: Array<{ itemId: string; reason: string; reasonCode?: string; offendingEvidenceIds?: string[] }>
  charBudget?: number
}

export const DEFAULT_RECOVERY_CHAR_BUDGET = 4000
export const MIN_RECOVERY_CHAR_BUDGET = 512
const COMPLETION_RULE = 'Supported actions certify through matching durable evidence (checkpoint). Investigations and explanations outside the supported set can be delivered honestly but stay uncertified. A qualified safe end preserves pending work; it is not completion.'

/**
 * 0.6.2 D062-03: the standing condition a removal or cleanup outcome must keep.
 * The guard cannot observe another process's cwd or handles, so it states the
 * condition instead of inferring "no dependants" from a clean tree, an empty
 * `git worktree list`, or a directory that merely looks empty. This is one
 * shared wording, not an incident phrase list, and it never claims the plugin
 * can block a dangerous removal on its own.
 */
export const CLEANUP_CONDITION_RULE: string = 'A removal counts only for the objects PROVEN dependency-free; report metadata, content and directory removal separately from dependency status ('
  + DEPENDENCY_FREE_ONLY_CONDITION.join(', ')
  + '), keep unknown-dependency objects and failures visible, and never repeat a blocked delete, kill a holder, or restart to force it.'

/**
 * The same condition at a medium budget (0.6.2 review): shorter than the full
 * rule, and still explicit that an unknown dependant forbids the claim.
 */
export const CLEANUP_CONDITION_RULE_SHORT: string = 'Removal counts only for objects PROVEN dependency-free; unknown dependants stay visible and are never deleted.'

/**
 * The same condition at emergency budget (0.6.2 review). A packet with fewer
 * than 1000 characters cannot carry the longer sentences AND its own rules, so
 * the condition is compressed — but it is NEVER omitted: the one thing a compact
 * packet must not lose is that an unknown dependant forbids a removal claim.
 */
export const CLEANUP_CONDITION_RULE_COMPACT: string = 'Removal requires proven no-dependants.'

/**
 * Pick the longest form of the condition the packet's budget can actually
 * afford. The caller reserves this line's length before any optional row, so
 * the condition is never the text that gets clipped.
 */
export function cleanupConditionFor(budget: number): string {
  if (budget >= DEFAULT_RECOVERY_CHAR_BUDGET) return CLEANUP_CONDITION_RULE
  if (budget >= 1000) return CLEANUP_CONDITION_RULE_SHORT
  return CLEANUP_CONDITION_RULE_COMPACT
}

/**
 * Whether this gap needs the cleanup condition spelled out. The condition
 * belongs to every uncertifiable lane that could describe removal-like work —
 * which the guard cannot identify from text — so it rides the CAPABILITY
 * limitation itself, never a vocabulary of destructive verbs.
 */
export function carriesCleanupCondition(gap: CapabilityGap): boolean {
  return gap === 'missing_adapter'
    || gap === 'legacy_migration_required'
    || gap === 'historical_preevidence_missing'
    || gap === 'operation_unattributable'
    || gap === 'interpretation_unknown'
}

/** One reachable-remedy phrase per remedy kind, shared by every lane. */
function remedyText(remedy: CapabilityRemedy, fallback: string): string {
  switch (remedy) {
    case 'collect_evidence': return 'Collect matching evidence; checkpoint'
    case 'readback_only': return 'Read back observed state; do not re-execute'
    case 'none': return 'Recorded as unresolved; only a fresh explicit instruction resolves it'
    case 'record_interpretation': return 'Read the attachment; record context_guard_interpret; then answer'
    case 'supply_target': return 'Supply the exact target; then collect evidence and checkpoint'
    case 'await_root_input': return 'Wait for the trusted root input; keep the obligation pending'
    case 'deliver_answer': return 'Deliver the actual answer; a completed turn closes it'
    case 'report_uncertified': return 'Deliver honestly; stays uncertified unless a fresh instruction names a supported action'
    case 'restore_host': return 'Restore audited host/adapter capability'
    case 'fresh_root_instruction': return 'Report the actual outcome as uncertified; only a fresh explicit instruction reaches its migration lane'
    case 'report_uncertified_capability_gap': return 'Report the observable result as uncertified; this build has no adapter for the action'
  }
  return fallback
}

/**
 * An actionable one-line hint for how an open item's verification contract can
 * be closed. It never weakens the contract; it only names the missing facet so
 * the agent can produce the right evidence shape instead of reverse-engineering
 * the guard. When `evidenceIds` is given, the hint accounts for what those
 * evidence already cover.
 */
export function closingHint(projection: GuardProjection, item: GuardItem, evidenceIds?: string[]): string {
  if (item.semanticAction === 'generic_run') return itemDiagnosis(projection, item).next_step
  const verification = item.verification
  const parts: string[] = []
  if (evidenceIds?.length) {
    const coverage = evidenceIds
      .map((id) => projection.evidence.get(id))
      .filter((value) => value !== undefined)
      .map((value) => evidenceCoverage(item, value!))
    const any = coverage.some((facet) => facet.artifact || facet.effect || facet.method || facet.verify || facet.run)
    if (!any) parts.push('cited evidence matches no facet')
  }
  if (verification.method) parts.push(`method '${verification.method}'`)
  if (verification.subject && verification.surface === 'artifact') parts.push(`subject '${verification.subject}'`)
  if (verification.subject && verification.surface === 'scope') parts.push('in the scope directory')
  const operation = verification.operation
  if (item.semanticAction && isStatefulAction(item.semanticAction)) {
    parts.push(`needs ${item.semanticAction} resolution + effect + independent state readback with the same resolved target`)
  } else if (operation === 'run') {
    parts.push('needs a scope run effect: a whitelisted executable (git/pnpm/python/dsh/...) without pipes, `;` or `&&`, e.g. `python -m unittest`')
  } else if (operation === 'create' || operation === 'write' || operation === 'modify') {
    parts.push('needs an effect evidence AND an independent same-subject state verification (read tool or a deterministic check)')
  } else if (operation === 'verify') {
    parts.push('needs a read or deterministic-check evidence on the contract subject')
  } else if (operation === 'read') {
    parts.push('needs a read evidence on the contract subject')
  } else {
    parts.push('needs a state-verification evidence (read tool, or a deterministic check run in scope) matching the subject')
  }
  return parts.join('; ')
}

export function openItems(projection: GuardProjection): GuardItem[] {
  return [...projection.items.values()]
    .filter((item) => item.status === 'pending')
    .sort((a, b) => (a.revision - b.revision) || (a.id < b.id ? -1 : 1))
}

/**
 * Content identity of a rendered recovery packet, bound to the contract
 * revision and epoch it was rendered from. The runtime compares digests before
 * re-injecting, so a repeatedly re-armed recovery with unchanged content is
 * injected once instead of looping (v0.2.1).
 */
export function recoveryDigest(packet: string, projection: GuardProjection): string {
  const items = openItems(projection)
  const evidence = [...projection.evidence.values()].filter(row => items.some(item => relevantEvidence(projection, item, row)))
  return sha256(JSON.stringify({ packet, revision: projection.contractRevision, epoch: projection.epoch, host: projection.hostLockDigest, evidence }))
}

export function renderRecoveryPacket(projection: GuardProjection, options: RecoveryOptions = {}): string {
  const budget = options.charBudget ?? DEFAULT_RECOVERY_CHAR_BUDGET
  if (!Number.isSafeInteger(budget) || budget < MIN_RECOVERY_CHAR_BUDGET) throw new RangeError('recovery charBudget must be an integer >= 512')
  const clip = (text: string, size: number) => text.length <= size ? text : text.slice(0, size - 1) + '…'
  const items = openItems(projection).sort((a, b) => Number(b.kind === 'prohibition') - Number(a.kind === 'prohibition') || b.revision - a.revision || a.id.localeCompare(b.id))
  const rejected = options.rejectedBindings ?? (projection.lastCheckpointRejectionRevision === projection.contractRevision ? projection.lastCheckpointRejections : []) ?? []
  const compact = budget < 1000
  // The packet's own rules must survive the optional rows. The completion rule
  // is kept in its full form while it fits, and is replaced by the compact
  // single-line form (which still says "uncertified") before any item row is
  // allowed to squeeze it. This is what keeps a large obligation count from
  // silently dropping the rule text (0.6.2 review).
  const COMPLETION_RULE_COMPACT = 'Checkpoint required before completion. Qualified safe end preserves pending work; it is not completion.'
  const lines = [`Context Guard: ${items.length} pending; revision ${projection.contractRevision}.`, compact ? COMPLETION_RULE_COMPACT : COMPLETION_RULE]
  const completionRuleIndex = 1
  // 0.6.2 D062-03: the applicable "only dependency-free objects" condition is
  // stated ONCE per packet, before any optional row can consume the budget, so
  // it survives truncation instead of being clipped off the end of one item's
  // line. It is emitted while a capability-limited obligation is open, in the
  // full form when the budget allows and in the compact form otherwise — the
  // condition is never dropped for a small packet (0.6.2 review).
  const cleanupConditionApplies = items.some((item) => carriesCleanupCondition(deriveItemDiagnosis(projection, item).capability.gap))
  if (cleanupConditionApplies) lines.push(cleanupConditionFor(budget))
  const pointer = 'Details/omissions: context_guard_checkpoint (item_ids, evidence_scope=history, cursor).'
  // Reserve the complete footer before any optional row, including long IDs
  // and rejection diagnostics. Counts must never disappear under pressure.
  const evidence = [...projection.evidence.values()].filter(e => items.some(item => relevantEvidence(projection, item, e)))
    .sort((a, b) => b.toolResultSeq - a.toolResultSeq || a.id.localeCompare(b.id))
  const footer = (count: number, refusals: number, shown: number) => `${items.length - count} items folded; ${rejected.length - refusals} rejections folded; ${evidence.length - shown} relevant evidence rows folded. Full ledger remains enforced.`
  // The reserve is computed from the header lines AS THEY STAND — including the
  // condition line added above. Computing it from the two starting lines let the
  // condition line silently consume the space that guaranteed room for the rules
  // and the first requirement row (0.6.2 review).
  const reserve = () => lines.join('\n').length + pointer.length + footer(0, 0, 0).length + 3
  let remaining = budget - reserve()
  const add = (line: string, cap: number) => {
    if (remaining < 30) return false
    const text = clip(line, Math.min(cap, remaining))
    // An optional row must never be the reason the rules became unreadable: if
    // this row would consume the completion rule, shorten the rule first and
    // give the freed characters back to the budget.
    if (!compact && remaining - (text.length + 1) < COMPLETION_RULE.length) {
      const current = lines[completionRuleIndex]!
      if (current.length > COMPLETION_RULE_COMPACT.length) {
        remaining += current.length - COMPLETION_RULE_COMPACT.length
        lines[completionRuleIndex] = COMPLETION_RULE_COMPACT
      }
    }
    // The condition line is part of the reserve above, so a small packet can
    // never spend on item rows the space the condition was promised.

    lines.push(text)
    remaining -= text.length + 1
    return true
  }
  const constraints = items.filter(item => item.kind === 'prohibition')
  const work = items.filter(item => item.kind !== 'prohibition')
  let count = 0, refusals = 0, shown = 0
  const constraint = (item: GuardItem) => {
    if (add(`DO NOT [${clip(item.id, 20)}] ${clip(item.normalizedText, compact ? 18 : 100)}`, compact ? 45 : 140)) count++
  }
  const requirement = (item: GuardItem) => {
    const diagnosis = deriveItemDiagnosis(projection, item)
    if (diagnosis.reason_code === 'root_condition_pending') {
      if (add(`[${clip(item.id, 20)}] root_condition_pending; wait for trusted root: ${item.resumeEvent ?? item.condition ?? item.normalizedText}; do not execute before release`, compact ? 160 : 310)) count++
      return
    }
    // 0.6.2 D062-01: the remedy comes from the shared capability projection, so
    // the packet can no longer tell the user to re-word a request this build
    // simply cannot certify. 0.6.2 D062-03: a capability-limited lane also
    // carries the applicable "only dependency-free objects" condition.
    const remedy = remedyText(diagnosis.capability.remedy, diagnosis.next_action.resume_condition ?? 'No further action needed.')
    const body = compact ? remedy : diagnosis.next_action.resume_condition ?? remedy
    if (add(`[${clip(item.id, 20)}] ${diagnosis.reason_code}; ${body}; ${clip(item.normalizedText, 70)}`, compact ? 110 : 310)) count++
  }
  // Each category gets a slot before optional diagnostics can consume space.
  if (constraints[0]) constraint(constraints[0])
  if (work[0]) requirement(work[0])
  if (!compact) {
    for (const item of work.slice(1, 4)) requirement(item)
    for (const item of constraints.slice(1, 4)) constraint(item)
    for (const binding of rejected.slice(0, 4)) {
      if (add(`rejected ${clip(binding.itemId, 30)}: ${clip(binding.reasonCode ?? binding.reason, 120)}`, 170)) refusals++
    }
    for (const item of work.slice(0, 4)) if (itemDiagnosis(projection, item).certifiable) add(`closing hint [${clip(item.id, 20)}]: ${closingHint(projection, item)}`, 240)
    for (const row of evidence.slice(0, 4)) if (add(`evidence ${clip(row.id, 40)} action=${row.semanticAction} role=${row.evidenceRole ?? 'effect'}`, 140)) shown++
  }
  lines.push(footer(count, refusals, shown), pointer)
  return lines.join('\n')
}
