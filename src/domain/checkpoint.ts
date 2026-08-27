import { digestStrings, sha256 } from './canonicalize.js'
import { bindingSatisfies } from './matching.js'
import { closingHint } from './recovery.js'
import type { EvidenceBinding, GuardCheckpoint, GuardProjection } from './types.js'

export interface RejectedBinding {
  itemId: string
  reason: string
  hint?: string
}

export interface CheckpointResult {
  status: GuardCheckpoint['result']
  contractRevision: number
  openItems: string[]
  rejectedBindings: RejectedBinding[]
  checkpoint?: GuardCheckpoint
}

export function certifyCheckpoint(projection: GuardProjection, bindings: EvidenceBinding[], id: string): CheckpointResult {
  if (projection.integrity !== 'valid') {
    return { status: 'unknown', contractRevision: projection.contractRevision, openItems: openItems(projection), rejectedBindings: [] }
  }
  const rejectedBindings: RejectedBinding[] = []
  for (const binding of bindings) {
    const item = projection.items.get(binding.itemId)
    if (!item || item.status === 'superseded') {
      rejectedBindings.push({ itemId: binding.itemId, reason: 'item is missing or superseded' })
      continue
    }
    if (!binding.evidenceIds.length) {
      rejectedBindings.push({ itemId: binding.itemId, reason: 'no evidence cited', hint: closingHint(projection, item) })
      continue
    }
    if (!bindingSatisfies(projection, item, binding.evidenceIds)) {
      rejectedBindings.push({
        itemId: binding.itemId,
        reason: 'evidence does not match the current verification contract',
        hint: closingHint(projection, item, binding.evidenceIds),
      })
      continue
    }
  }
  const open = openItems(projection).filter((itemId) => !bindings.some((binding) => binding.itemId === itemId))
  if (rejectedBindings.length || open.length) {
    return { status: 'incomplete', contractRevision: projection.contractRevision, openItems: openItems(projection), rejectedBindings }
  }
  const openDigest = digestStrings(openItems(projection))
  const bindingDigest = sha256(JSON.stringify(bindings))
  const checkpoint: GuardCheckpoint = {
    id,
    epoch: projection.epoch,
    contractRevision: projection.contractRevision,
    openDigest,
    bindingDigest,
    bindings,
    result: 'certified',
  }
  projection.checkpoints.push(checkpoint)
  for (const binding of bindings) {
    projection.items.get(binding.itemId)!.status = 'passed'
  }
  return { status: 'certified', contractRevision: projection.contractRevision, openItems: [], rejectedBindings: [], checkpoint }
}

function openItems(projection: GuardProjection): string[] {
  return [...projection.items.values()]
    .filter((item) => item.status === 'pending' && item.kind !== 'prohibition')
    .map((item) => item.id)
}
