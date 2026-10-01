// FROZEN BASELINE ORACLE (CG-083-V1): exact 913a4c7a6f0f600f4146ef4af694d3af6e477ef2 copy of src/domain/supersession.ts. Do not edit except wholesale replacement.
import type { GuardItem } from './types.js'

export function supersedeItem(items: Map<string, GuardItem>, oldId: string, replacement: GuardItem): boolean {
  const old = items.get(oldId)
  if (!old || old.status === 'superseded') return false
  old.status = 'superseded'
  old.supersededBy = replacement.id
  items.set(replacement.id, replacement)
  return true
}
