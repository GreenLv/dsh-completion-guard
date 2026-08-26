import { digestStrings, sha256 } from './canonicalize.js'
import { evidenceMatchesItem } from './matching.js'
import type { EvidenceBinding, GuardCheckpoint, GuardProjection } from './types.js'

export interface CheckpointResult {
  status: GuardCheckpoint['result']
  contractRevision: number
  openItems: string[]
  rejectedBindings: Array<{ itemId: string; reason: string }>
  checkpoint?: GuardCheckpoint
}

export function certifyCheckpoint(projection: GuardProjection, bindings: EvidenceBinding[], id: string): CheckpointResult {
  if (projection.integrity !== 'valid') {
    return { status: 'unknown', contractRevision: projection.contractRevision, openItems: openItems(projection), rejectedBindings: [] }
  }
  const rejectedBindings: Array<{ itemId: string; reason: string }> = []
  for (const binding of bindings) {
    const item = projection.items.get(binding.itemId)
    if (!item || item.status === 'superseded') {
      rejectedBindings.push({ itemId: binding.itemId, reason: 'item is missing or superseded' })
      continue
    }
    if (!binding.evidenceIds.length) {
      rejectedBindings.push({ itemId: binding.itemId, reason: 'no evidence cited' })
      continue
    }
    for (const evidenceId of binding.evidenceIds) {
      const evidence = projection.evidence.get(evidenceId)
      if (!evidence || evidence.epoch !== projection.epoch || !evidenceMatchesItem(item, evidence)) {
        rejectedBindings.push({ itemId: binding.itemId, reason: `evidence ${evidenceId} does not match the current verification contract` })
      }
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
