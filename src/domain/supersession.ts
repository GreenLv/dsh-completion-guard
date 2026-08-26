import type { GuardItem } from './types.js'

export function supersedeItem(items: Map<string, GuardItem>, oldId: string, replacement: GuardItem): boolean {
  const old = items.get(oldId)
  if (!old || old.status === 'superseded') return false
  old.status = 'superseded'
  old.supersededBy = replacement.id
  items.set(replacement.id, replacement)
  return true
}
