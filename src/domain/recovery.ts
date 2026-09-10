import type { GuardItem, GuardProjection } from './types.js'
import { sha256 } from './canonicalize.js'
import { evidenceCoverage } from './matching.js'
import { deriveItemDiagnosis, itemDiagnosis, relevantEvidence } from './diagnostics.js'
import { isStatefulAction } from './protocol-manifest.js'

export interface RecoveryOptions {
  rejectedBindings?: Array<{ itemId: string; reason: string; reasonCode?: string; offendingEvidenceIds?: string[] }>
  charBudget?: number
}

export const DEFAULT_RECOVERY_CHAR_BUDGET = 4000
export const MIN_RECOVERY_CHAR_BUDGET = 512
const COMPLETION_RULE = 'Supported actions certify through matching durable evidence (checkpoint). Investigations and explanations outside the supported set can be delivered honestly but stay uncertified. A qualified safe end preserves pending work; it is not completion.'

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
  const lines = [`Context Guard: ${items.length} pending; revision ${projection.contractRevision}.`, compact
    ? 'Checkpoint required before completion. Qualified safe end preserves pending work; it is not completion.' : COMPLETION_RULE]
  const pointer = 'Details/omissions: context_guard_checkpoint (item_ids, evidence_scope=history, cursor).'
  // Reserve the complete footer before any optional row, including long IDs
  // and rejection diagnostics. Counts must never disappear under pressure.
  const evidence = [...projection.evidence.values()].filter(e => items.some(item => relevantEvidence(projection, item, e)))
    .sort((a, b) => b.toolResultSeq - a.toolResultSeq || a.id.localeCompare(b.id))
  const footer = (count: number, refusals: number, shown: number) => `${items.length - count} items folded; ${rejected.length - refusals} rejections folded; ${evidence.length - shown} relevant evidence rows folded. Full ledger remains enforced.`
  let remaining = budget - lines.join('\n').length - pointer.length - footer(0, 0, 0).length - 3
  const add = (line: string, cap: number) => {
    if (remaining < 30) return false
    const text = clip(line, Math.min(cap, remaining))
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
    const remedy = diagnosis.repairability === 'agent_repairable'
      ? 'Collect matching evidence; checkpoint'
      : diagnosis.repairability === 'historical_gap'
        ? 'Read back observed state; do not re-execute'
          : diagnosis.certification === 'unsupported'
            ? 'Deliver honestly; stays uncertified unless a fresh instruction names a supported action'
              : 'Restore audited host/adapter capability'
    if (add(`[${clip(item.id, 20)}] ${diagnosis.reason_code}; ${compact ? remedy : diagnosis.next_action.resume_condition ?? remedy}; ${clip(item.normalizedText, 70)}`, compact ? 110 : 310)) count++
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
