import type { GuardItem, GuardProjection } from './types.js'
import { evidenceCoverage } from './matching.js'

export interface RecoveryOptions {
  rejectedBindings?: Array<{ itemId: string; reason: string }>
  charBudget?: number
}

export const DEFAULT_RECOVERY_CHAR_BUDGET = 4000
const MAX_RECOVERY_ITEMS = 8
const MAX_RECOVERY_EVIDENCE = 20
const MORE_ITEMS_RULE = (remaining: number) => `…(${remaining} more open items; the full list is in the checkpoint tool response)`
const MORE_EVIDENCE_RULE = (remaining: number) => `…(${remaining} more evidence rows)`
const COMPLETION_RULE = 'Obtain a Context Guard checkpoint from matching durable evidence before claiming completion.'

/**
 * An actionable one-line hint for how an open item's verification contract can
 * be closed. It never weakens the contract; it only names the missing facet so
 * the agent can produce the right evidence shape instead of reverse-engineering
 * the guard. When `evidenceIds` is given, the hint accounts for what those
 * evidence already cover.
 */
export function closingHint(projection: GuardProjection, item: GuardItem, evidenceIds?: string[]): string {
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
  if (operation === 'run') {
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

export function renderRecoveryPacket(projection: GuardProjection, options: RecoveryOptions = {}): string {
  const budget = options.charBudget ?? DEFAULT_RECOVERY_CHAR_BUDGET
  const lines: string[] = []
  let used = 0
  const push = (line: string) => {
    if (used + line.length + 1 > budget) return false
    lines.push(line)
    used += line.length + 1
    return true
  }

  const items = openItems(projection)
  const listedIds = new Set<string>()
  const pushItems = (list: GuardItem[], render: (item: GuardItem) => string): boolean => {
    let count = 0
    for (const item of list) {
      if (count >= MAX_RECOVERY_ITEMS) {
        // Best-effort fold notice; evidence rows that follow stay valuable.
        push(MORE_ITEMS_RULE(list.length - count))
        return true
      }
      if (!push(render(item))) return false
      listedIds.add(item.id)
      count += 1
    }
    return true
  }
  const requirementItems = items.filter((item) => item.kind === 'requirement')
  if (!pushItems(requirementItems, (item) => `[${item.id}] ${item.normalizedText}`)) return finalize()
  const prohibitionItems = items.filter((item) => item.kind === 'prohibition')
  if (!pushItems(prohibitionItems, (item) => `[${item.id}] DO NOT ${item.normalizedText}`)) return finalize()
  const acceptanceItems = items.filter((item) => item.kind === 'acceptance')
  if (!pushItems(acceptanceItems, (item) => `[${item.id}] VERIFY ${item.normalizedText}`)) return finalize()
  // Surface the real evidence IDs the model may cite, so a checkpoint attempt
  // can bind actual evidence instead of guessing identifiers.
  const citableEvidence = [...projection.evidence.values()]
    .filter((evidence) => evidence.epoch === projection.epoch && evidence.outcome === 'success')
    .sort((a, b) => (a.id < b.id ? -1 : 1))
  let evidenceCount = 0
  for (const evidence of citableEvidence) {
    if (evidenceCount >= MAX_RECOVERY_EVIDENCE) {
      push(MORE_EVIDENCE_RULE(citableEvidence.length - evidenceCount))
      break
    }
    if (!push(`evidence ${evidence.id} ${evidence.toolName} ${evidence.subjects.join(',') || '-'} ${evidence.surfaces.join(',')}`)) return finalize()
    evidenceCount += 1
  }
  for (const item of [...projection.items.values()].filter((item) => item.status === 'superseded')) {
    if (item.supersededBy && !push(`[${item.id} -> ${item.supersededBy}]`)) return finalize()
  }
  for (const binding of options.rejectedBindings ?? []) {
    if (!push(`rejected ${binding.itemId}: ${binding.reason}`)) return finalize()
  }
  // Best-effort actionable hints for the LISTED items only: folded items never
  // leak back through the hint lines, and hints never displace the prioritized
  // item and evidence lines when the budget is tight.
  for (const item of items) {
    if (item.kind === 'prohibition' || !listedIds.has(item.id)) continue
    push(`closing hint [${item.id}]: ${closingHint(projection, item)}`)
  }
  push(COMPLETION_RULE)
  return finalize()

  function finalize() {
    return lines.join('\n')
  }
}
