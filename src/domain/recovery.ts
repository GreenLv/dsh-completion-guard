import type { GuardItem, GuardProjection } from './types.js'
import { sha256 } from './canonicalize.js'
import { evidenceCoverage } from './matching.js'
import { deriveItemDiagnosis, itemDiagnosis, relevantEvidence } from './diagnostics.js'
import { isStatefulAction } from './protocol-manifest.js'
import { DEPENDENCY_FREE_ONLY_CONDITION, type CapabilityGap, type CapabilityRemedy } from './capability-semantics.js'
import { needsReviewObligations } from './closure.js'
import { currentV6Feedback, isV6PendingRootWait, sourceItemForCoreRequirement, v6VerifiedCoreConditions } from './v6-feedback.js'
import { unitAncestorIds } from './work-unit.js'

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
 * Why recovery is armed, recorded where the arm happens so the injected title
 * can name the real trigger instead of guessing one. An arm without an
 * auditable cause renders a neutral title, never a fabricated compaction or
 * resume (DSH-RF-02).
 */
export type RecoveryCause = 'compaction' | 'resume' | 'guard_reenabled' | 'contract_updated' | 'checkpoint_followup' | 'boundary_update' | 'explicit'

/** The accurate injection title for one armed recovery (DSH-RF-02). */
export function recoveryTitle(causes: readonly string[]): string {
  const compact = new Set(causes)
  const compacted = compact.has('compaction')
  const resumed = compact.has('resume')
  if (compacted && resumed) return 'Open task requirements (recovered after compaction or resume):'
  if (compacted) return 'Open task requirements (recovered after compaction):'
  if (resumed) return 'Open task requirements (recovered after resume):'
  if (compact.has('guard_reenabled')) return 'Open task requirements (Guard re-enabled):'
  if (compact.has('checkpoint_followup')) return 'Open task requirements (checkpoint follow-up):'
  if (compact.has('boundary_update')) return 'Open task requirements (boundary update):'
  if (compact.has('contract_updated')) return 'Open task requirements (contract updated):'
  return 'Open task requirements:'
}

/**
 * The v6 ordinary completion rule. The legacy rule states the pre-v6 protocol's
 * checkpoint gate; repeating it in the ordinary lane taught models that a
 * Guard checkpoint is a prerequisite for ordinary completion (DSH-RF-01), so
 * this lane states its own rule: completion is READ from persisted host facts,
 * uncertified work is still delivered honestly, and no Guard step authorizes
 * ordinary execution.
 */
export const V6_ORDINARY_COMPLETION_RULE = 'Ordinary completion is read from persisted host tool results and independent readback; uncertified work is delivered honestly and stays uncertified. No Guard checkpoint, binding, or target re-authorization is a prerequisite for ordinary work.'

/** The same rule at a medium budget. */
export const V6_ORDINARY_COMPLETION_RULE_SHORT = 'Ordinary completion is read from persisted host results; uncertified work is delivered honestly and needs no Guard checkpoint or re-authorization.'

/** The same rule at emergency budget — still never a checkpoint prerequisite. */
export const V6_ORDINARY_COMPLETION_RULE_COMPACT = 'Ordinary completion is read from persisted host results; no Guard checkpoint or re-authorization is required.'

function v6CompletionRuleFor(budget: number): string {
  if (budget >= DEFAULT_RECOVERY_CHAR_BUDGET) return V6_ORDINARY_COMPLETION_RULE
  if (budget >= 1000) return V6_ORDINARY_COMPLETION_RULE_SHORT
  return V6_ORDINARY_COMPLETION_RULE_COMPACT
}

/** The current-unit core conditions, trusted only through the shared
 * verification chain: an unverified core's release fields never discharge a
 * root boundary (review R2F3). */

/** Pending durable items inside the current unit's lineage (the current unit
 * plus applicable ancestors). This is the v6 scope every current-guidance
 * surface draws from — boundaries, the cleanup condition, and the digest. */
function currentLineagePendingItems(projection: GuardProjection): GuardItem[] {
  const current = projection.currentUnitId
  if (current === undefined) return []
  const lineage = new Set([current, ...unitAncestorIds(projection, current)])
  return [...projection.items.values()].filter((item) =>
    item.status === 'pending' && item.unitId !== undefined && lineage.has(item.unitId))
}

/**
 * The durable root authorization boundaries applicable to the CURRENT work:
 * pending prohibitions and root waits whose release is not verified, scoped to
 * the current unit's lineage. Historical sibling units and superseded records
 * stay auditable but never re-enter current guidance (RF08, review R2F2). One
 * selector, shared by both renderer lanes and the recovery digest, so no
 * surface can disagree about which boundaries are in force. Prohibitions are
 * selected from the DURABLE RECORD's kind, never from the core predicate: a
 * prohibition the core cannot verify (legacy_review) is still a prohibition
 * and still renders as DO NOT (coverage audit H1).
 */
export function v6CurrentRootBoundaries(projection: GuardProjection): {
  prohibitions: GuardItem[]
  waits: GuardItem[]
} {
  const sort = (a: GuardItem, b: GuardItem) => (b.revision - a.revision) || a.id.localeCompare(b.id)
  const applicable = currentLineagePendingItems(projection)
  return {
    prohibitions: applicable.filter((item) => item.kind === 'prohibition').sort(sort),
    waits: applicable.filter((item) => isV6PendingRootWait(projection, item)).sort(sort),
  }
}

/**
 * Content identity of a rendered recovery packet, bound to the contract
 * revision and epoch it was rendered from. The runtime compares digests before
 * re-injecting, so a repeatedly re-armed recovery with unchanged content is
 * injected once instead of looping (v0.2.1).
 *
 * In the default v6 ordinary lane the identity binds to the DISPLAYED current
 * feedback (status, predicates, open requirements, wait conditions) instead of
 * the legacy pending/evidence inventory: unrelated historical evidence changes
 * no predicate, so it must not re-arm the reminder, while a new requirement, a
 * failed result, a released wait, or an integrity change must (DSH-RF-01).
 * The core waterline (`as_of`) is deliberately excluded — it moves on every
 * event, which is exactly the noise the old digest turned into reminders.
 */
export function recoveryDigest(packet: string, projection: GuardProjection): string {
  const current = currentV6Feedback(projection)
  if (current) {
    // The unknown lane's packet carries the durable root boundaries, so the
    // SAME selector's ids join the identity: a prohibition superseded or a
    // wait released while the view stays unknown must still refresh the
    // reminder, while switched-away sibling history cannot (reviews F2/R2F2).
    const boundaries = current.status === 'unknown' && projection.integrity === 'valid'
      ? (() => {
        const selected = v6CurrentRootBoundaries(projection)
        return [...selected.prohibitions, ...selected.waits].map((item) => item.id).sort()
      })()
      : undefined
    return sha256(JSON.stringify({
      lane: 'v6-ordinary-recovery', packet,
      revision: projection.contractRevision, epoch: projection.epoch,
      host: projection.hostLockDigest, integrity: projection.integrity,
      unit: projection.currentUnitId ?? null,
      status: current.status, reason: current.reasonCode,
      open: current.openIds, predicates: current.predicates,
      conditions: v6VerifiedCoreConditions(projection) ?? null,
      boundaries,
    }))
  }
  const items = openItems(projection)
  const evidence = [...projection.evidence.values()].filter(row => items.some(item => relevantEvidence(projection, item, row)))
  return sha256(JSON.stringify({ packet, revision: projection.contractRevision, epoch: projection.epoch, host: projection.hostLockDigest, evidence }))
}

export function renderRecoveryPacket(projection: GuardProjection, options: RecoveryOptions = {}): string {
  const budget = options.charBudget ?? DEFAULT_RECOVERY_CHAR_BUDGET
  if (!Number.isSafeInteger(budget) || budget < MIN_RECOVERY_CHAR_BUDGET) throw new RangeError('recovery charBudget must be an integer >= 512')
  // The default v6 ordinary lane consumes the SAME confirmed core-v2 view
  // prepare and checkpoint consume (DSH-RF-01). Sessions outside that lane —
  // pre-v6 boundaries, an adopted Goal, a release policy, or adopted release
  // work — keep the historical strict rendering and its checks.
  const current = currentV6Feedback(projection)
  if (current) return renderV6RecoveryPacket(projection, current, budget)
  return renderLegacyRecoveryPacket(projection, options, budget)
}

/**
 * The v6 ordinary recovery packet. Every row comes from the current core
 * predicates and their sourced items: satisfied work is not re-reported,
 * genuinely unmet work stays visible with its reachable host-tool remedy,
 * standing prohibitions stay standing, an unresolved root wait keeps its exact
 * resume event, and an unavailable view reports itself as unknown instead of
 * regressing to the legacy qualification diagnosis.
 *
 * Root authorization boundaries — standing prohibitions and unreleased root
 * waits — outrank ordinary work rows at EVERY budget and survive an
 * unavailable core view (when the root sources themselves are verifiable):
 * a compact packet may fold work, never the boundary (review F1/F2).
 */
function renderV6RecoveryPacket(
  projection: GuardProjection,
  current: NonNullable<ReturnType<typeof currentV6Feedback>>,
  budget: number,
): string {
  const clip = (text: string, size: number) => text.length <= size ? text : text.slice(0, size - 1) + '…'
  const compact = budget < 1000
  const pointer = 'Details/omissions: context_guard_prepare (discovery) and context_guard_checkpoint.'
  const lines: string[] = []
  const ruleLineIndex = 1

  const isPendingWait = (item: GuardItem | undefined): boolean => isV6PendingRootWait(projection, item)
  // Both lanes draw prohibitions from the SAME durable, lineage-scoped
  // selector: a prohibition the core cannot verify (legacy_review) is still a
  // prohibition and still renders as DO NOT — polarity never depends on the
  // core supporting that constraint shape (coverage audit H1).
  const { prohibitions: durableProhibitions } = v6CurrentRootBoundaries(projection)
  // The 0.6.2 D062-03 cleanup condition rides the CAPABILITY limitation of the
  // current lineage's open work, exactly as the historical lane carries it —
  // the v6 migration must keep promising it (coverage audit H2).
  const cleanupApplies = currentLineagePendingItems(projection)
    .some((item) => carriesCleanupCondition(deriveItemDiagnosis(projection, item).capability.gap))
  // Boundary rows carry protected semantic fields: the exact release event
  // (a confirmation token is only useful verbatim) and the do-not-execute
  // instruction. They are NEVER string-clipped — space is planned for the
  // complete row first, the generic rule and the footer's explanatory tail
  // are compressed next, and only a truthful pointer row replaces text that
  // cannot fit whole (review R2F1).
  const waitBoundaryRow = (item: GuardItem): string =>
    `[${clip(item.id, 20)}] root_condition_pending; wait for trusted root: ${item.resumeEvent ?? item.condition ?? item.normalizedText}; do not execute before release`
  const waitBoundaryReference = (item: GuardItem): string =>
    `[${clip(item.id, 20)}] root_condition_pending; exact condition: context_guard_prepare; do not execute before release`
  const constraintBoundaryRow = (item: GuardItem, state?: string): string => {
    const base = `DO NOT [${clip(item.id, 20)}] ${item.normalizedText}`
    if (state === 'constraint_violated') return `${base} — VIOLATED by a sourced host mutation; report it; do not repeat`
    if (state === 'constraint_unresolved') return `${base} — current host facts cannot establish whether this was respected`
    return base
  }
  const constraintBoundaryReference = (item: GuardItem): string =>
    `DO NOT [${clip(item.id, 20)}] exact text: context_guard_prepare`

  if (current.status === 'unknown') {
    const unknownRuleFull = 'Current-fact recovery is unavailable: nothing here claims completion, authorization, or certification. The durable root boundaries listed below stay in force; retry the current view after the named condition is restored.'
    const unknownRuleCompact = 'Current facts unavailable; nothing here claims completion or authorization; the durable root boundaries below stay in force.'
    lines.push(`Context Guard: current closure unknown (${current.reasonCode}); revision ${projection.contractRevision}.`)
    lines.push(compact ? unknownRuleCompact : unknownRuleFull)
    if (cleanupApplies) lines.push(cleanupConditionFor(budget))
    const unknownRuleTiers = [unknownRuleFull, unknownRuleCompact]
    // The unknown view states its own limit; the KNOWN root authorization
    // boundaries are durable contract facts the projection still carries, and
    // losing them with the view would hand a context-free model back its
    // prohibitions and waits precisely when recovery is unreliable (review F2).
    // Their scope is the SAME selector the digest uses — the current unit's
    // lineage — so switched-away sibling history cannot come back as current
    // guidance, and only a verified core release can drop a wait (R2F2/R2F3).
    if (projection.integrity !== 'valid') {
      lines.push(compact
        ? 'Root source integrity is unverifiable: known constraints cannot be safely recovered here; do not treat any boundary as preserved.'
        : 'Root source integrity is unverifiable, so the known prohibitions and waits cannot be safely recovered in this packet; do not treat any boundary as preserved, and re-establish them with the root before acting.')
    } else {
      const { waits } = v6CurrentRootBoundaries(projection)
      const footer = (constraintsShown: number, waitsShown: number) => compact
        ? `${durableProhibitions.length - constraintsShown} constraint folded; ${waits.length - waitsShown} wait folded.`
        : `${durableProhibitions.length - constraintsShown} constraint rows folded; ${waits.length - waitsShown} wait rows folded.`
      let remaining = budget - (lines.join('\n').length + pointer.length + footer(0, 0).length + 3)
      const budget2 = makeV6RowBudget(lines, unknownRuleTiers, ruleLineIndex, () => remaining, (value) => { remaining = value })
      let constraintsShown = 0, waitsShown = 0
      for (const item of durableProhibitions.slice(0, compact ? 1 : 4)) {
        if (budget2.addBoundary(constraintBoundaryRow(item), constraintBoundaryReference(item))) constraintsShown++
      }
      for (const item of waits.slice(0, compact ? 1 : 4)) {
        if (budget2.addBoundary(waitBoundaryRow(item), waitBoundaryReference(item))) waitsShown++
      }
      lines.push(footer(constraintsShown, waitsShown))
    }
    lines.push(pointer)
    return lines.join('\n')
  }

  if (current.status === 'observed') {
    lines.push(`Context Guard: current ordinary closure observed; revision ${projection.contractRevision}; 0 unmet current requirements${durableProhibitions.length > 0 ? `; ${durableProhibitions.length} standing constraint${durableProhibitions.length === 1 ? '' : 's'}` : ''}.`)
    lines.push(v6CompletionRuleFor(budget))
  } else {
    lines.push(`Context Guard: ${current.openIds.length} unmet current requirement${current.openIds.length === 1 ? '' : 's'}; revision ${projection.contractRevision}.`)
    lines.push(v6CompletionRuleFor(budget))
  }
  // Like the historical lane, the condition line is part of the reserve: a
  // large obligation count can never clip the dependency-free promise.
  if (cleanupApplies) lines.push(cleanupConditionFor(budget))

  // 0.6.3 K4 stays visible on this lane too: a record an earlier rule set
  // closed cannot be inherited and blocks certificates until the root resolves
  // it — one bounded row before any optional requirement row.
  if (current.reasonCode === 'legacy_record_needs_review') {
    const shown = current.openIds.slice(0, 2).map((id) => clip(id, 20)).join('; ')
    const more = current.openIds.length > 2 ? ` (+${current.openIds.length - 2} more)` : ''
    lines.push(`NEEDS REVIEW: ${shown}${more} — a record from an earlier rule set cannot be inherited; resolve it with the root before certifying.`)
  }

  const requirementRow = (id: string): { reason: string; body: string } => {
    const state = current.predicates[id]
    const sourced = sourceItemForCoreRequirement(projection, id)
    const item = sourced?.item
    if (state === 'insufficient' && sourced?.origin !== undefined) {
      return { reason: state, body: compact
        ? `run the read-only ${sourced.origin.action}; its persisted result records it`
        : `run the read-only ${sourced.origin.action} named by the root requirement; its persisted result records this method` }
    }
    if (state === 'insufficient' && item !== undefined
      && (item.taskKind === 'inquiry' || item.authorityDisposition === 'informational')) {
      return { reason: state, body: compact
        ? 'deliver the answer; the completed turn closes it'
        : 'deliver the actual answer; the final response of the completed turn closes it' }
    }
    if (state === 'insufficient') {
      return { reason: state, body: compact
        ? 'unmet from persisted facts; do it with host tools; never re-run a completed action'
        : 'still unmet from persisted host facts; do the work with host tools and let the persisted result or an independent readback show it; never re-run a completed action to mint evidence' }
    }
    if (state === 'legacy_review') {
      return { reason: state, body: compact
        ? 'not certifiable from current facts; ordinary host work continues; stays uncertified'
        : 'recorded but not certifiable from current confirmed facts; continue ordinary host work; stays uncertified unless a fresh root instruction adopts a certified path' }
    }
    if (state === 'constraint_violated') {
      return { reason: state, body: compact
        ? 'a sourced host mutation violated this prohibition; report; do not repeat'
        : 'a sourced host mutation violated this prohibition; report it; do not repeat it' }
    }
    if (state === 'constraint_unresolved') {
      return { reason: state, body: compact
        ? 'host facts cannot establish this prohibition was respected'
        : 'current host facts cannot establish whether this prohibition was respected' }
    }
    return { reason: state ?? 'unmet', body: 'answer this sourced requirement with the current Host observation or final delivery' }
  }

  const openRows = current.status === 'incomplete' ? current.openIds : []
  // Reviews F1/R2F1/H1: waits outrank ordinary work and are never clipped,
  // and a prohibition NEVER renders as ordinary work — its DO NOT row comes
  // from the durable selector above, so it is excluded from the work rows and
  // their fold count. The core's id order is arbitrary with respect to
  // authorization; a compact packet that slices it can fold the one row that
  // says "do not execute before release".
  const waitItems = openRows
    .map((id) => sourceItemForCoreRequirement(projection, id)?.item)
    .filter((item): item is GuardItem => isPendingWait(item))
  const waitRowIds = new Set(waitItems.map((item) => item.id))
  const prohibitionRowIds = new Set(durableProhibitions.map((item) => item.id))
  const workRows = openRows.filter((id) => !waitRowIds.has(id) && !prohibitionRowIds.has(id))
  const footer = (constraintsShown: number, waitsShown: number, shown: number) => compact
    ? `${durableProhibitions.length - constraintsShown} constraint folded; ${waitItems.length - waitsShown} wait folded; ${workRows.length - shown} work folded.`
    : `${durableProhibitions.length - constraintsShown} constraint rows folded; ${waitItems.length - waitsShown} wait rows folded; ${workRows.length - shown} requirement rows folded. Current scope is the confirmed core; older records stay historical.`
  let remaining = budget - (lines.join('\n').length + pointer.length + footer(0, 0, 0).length + 3)
  const rowBudget = makeV6RowBudget(lines,
    [v6CompletionRuleFor(budget), budget >= DEFAULT_RECOVERY_CHAR_BUDGET ? V6_ORDINARY_COMPLETION_RULE_SHORT : V6_ORDINARY_COMPLETION_RULE_COMPACT,
      V6_ORDINARY_COMPLETION_RULE_COMPACT].filter((tier, index, tiers) => tiers.indexOf(tier) === index),
    ruleLineIndex, () => remaining, (value) => { remaining = value })
  let constraintsShown = 0, waitsShown = 0, shown = 0
  const constraintLimit = compact ? 1 : 4
  for (const item of durableProhibitions.slice(0, constraintLimit)) {
    if (rowBudget.addBoundary(constraintBoundaryRow(item, current.predicates[item.id]), constraintBoundaryReference(item))) constraintsShown++
  }
  const waitLimit = compact ? 1 : 4
  for (const item of waitItems.slice(0, waitLimit)) {
    if (rowBudget.addBoundary(waitBoundaryRow(item), waitBoundaryReference(item))) waitsShown++
  }
  const rowLimit = compact ? 1 : 4
  for (const id of workRows.slice(0, rowLimit)) {
    const row = requirementRow(id)
    const item = sourceItemForCoreRequirement(projection, id)?.item
    const text = item ? clip(item.normalizedText, 70) : ''
    if (rowBudget.add(`[${clip(id, 20)}] ${row.reason}; ${row.body}; ${text}`, compact ? 110 : 310)) shown++
  }
  lines.push(footer(constraintsShown, waitsShown, shown), pointer)
  return lines.join('\n')
}

/**
 * The v6 lane's bounded row budget. Ordinary rows clip when tight. Boundary
 * rows — a standing prohibition or a root wait — are NEVER clipped: the
 * complete row is planned first, the generic rule is compressed next, and a
 * row that still cannot fit whole falls back to a truthful pointer row or
 * folds with its count. A displayed boundary is therefore always semantically
 * complete, and "0 folded" always means exactly that (reviews F1/R2F1).
 */
function makeV6RowBudget(
  lines: string[],
  ruleTiers: readonly string[],
  ruleLineIndex: number,
  getRemaining: () => number,
  setRemaining: (value: number) => void,
): { add: (line: string, cap: number) => boolean; addBoundary: (full: string, reference: string) => boolean } {
  const tryWhole = (line: string): boolean => {
    const remaining = getRemaining()
    if (remaining < line.length + 1) return false
    lines.push(line)
    setRemaining(remaining - (line.length + 1))
    return true
  }
  const add = (line: string, cap: number): boolean => {
    const remaining = getRemaining()
    if (remaining < 30) return false
    const text = line.length <= Math.min(cap, remaining) ? line : line.slice(0, Math.min(cap, remaining) - 1) + '…'
    lines.push(text)
    setRemaining(remaining - (text.length + 1))
    return true
  }
  const shortenRule = (): boolean => {
    const currentRule = lines[ruleLineIndex] as string
    const next = ruleTiers[ruleTiers.indexOf(currentRule) + 1]
    if (next === undefined) return false
    setRemaining(getRemaining() + currentRule.length - next.length)
    lines[ruleLineIndex] = next
    return true
  }
  const addBoundary = (full: string, reference: string): boolean => {
    if (tryWhole(full)) return true
    while (shortenRule()) {
      if (tryWhole(full)) return true
    }
    return tryWhole(reference)
  }
  return { add, addBoundary }
}

function renderLegacyRecoveryPacket(projection: GuardProjection, options: RecoveryOptions, budget: number): string {
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
  // 0.6.3 K4: a record an earlier release closed, and which the upgrade
  // eligibility layer refused to inherit, blocks the current certificate and
  // Goal completion. Leaving it out of the packet would make that obstruction
  // invisible on the operator's own surface, so one bounded row names it before
  // any optional item row can spend the budget.
  const needsReview = needsReviewObligations(projection)
  if (needsReview.length > 0) {
    const shown = needsReview.slice(0, 2).map((item) => `[${clip(item.id, 20)}] ${item.needsReview!.reason}`).join('; ')
    const more = needsReview.length > 2 ? ` (+${needsReview.length - 2} more)` : ''
    lines.push(`NEEDS REVIEW: ${shown}${more} — a record from an earlier rule set cannot be inherited; resolve it with the root before certifying.`)
  }
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
