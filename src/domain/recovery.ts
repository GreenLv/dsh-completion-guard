import type { GuardItem, GuardProjection } from './types.js'

export interface RecoveryOptions {
  rejectedBindings?: Array<{ itemId: string; reason: string }>
  charBudget?: number
}

export const DEFAULT_RECOVERY_CHAR_BUDGET = 4000
const COMPLETION_RULE = 'Obtain a Context Guard checkpoint from matching durable evidence before claiming completion.'

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
  for (const item of items.filter((item) => item.kind === 'requirement')) {
    if (!push(`[${item.id}] ${item.normalizedText}`)) return finalize()
  }
  for (const item of items.filter((item) => item.kind === 'prohibition')) {
    if (!push(`[${item.id}] DO NOT ${item.normalizedText}`)) return finalize()
  }
  for (const item of items.filter((item) => item.kind === 'acceptance')) {
    if (!push(`[${item.id}] VERIFY ${item.normalizedText}`)) return finalize()
  }
  // Surface the real evidence IDs the model may cite, so a checkpoint attempt
  // can bind actual evidence instead of guessing identifiers.
  const citableEvidence = [...projection.evidence.values()]
    .filter((evidence) => evidence.epoch === projection.epoch && evidence.outcome === 'success')
    .sort((a, b) => (a.id < b.id ? -1 : 1))
  for (const evidence of citableEvidence) {
    if (!push(`evidence ${evidence.id} ${evidence.toolName} ${evidence.subjects.join(',') || '-'} ${evidence.surfaces.join(',')}`)) return finalize()
  }
  for (const item of [...projection.items.values()].filter((item) => item.status === 'superseded')) {
    if (item.supersededBy && !push(`[${item.id} -> ${item.supersededBy}]`)) return finalize()
  }
  for (const binding of options.rejectedBindings ?? []) {
    if (!push(`rejected ${binding.itemId}: ${binding.reason}`)) return finalize()
  }
  push(COMPLETION_RULE)
  return finalize()

  function finalize() {
    return lines.join('\n')
  }
}
