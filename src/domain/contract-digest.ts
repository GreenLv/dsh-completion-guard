import { sha256 } from './canonicalize.js'
import type { GuardProjection } from './types.js'

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}
/** One authoritative contract identity shared by checkpoints and boundaries. */
export function currentContractDigest(projection: GuardProjection): string {
  const rows = [...projection.items.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((item) => [
      item.id, item.revision, item.kind, item.status, item.textSha256,
      item.semanticAction ?? null, item.requestedTarget ?? null,
    ])
  return sha256(stable(rows))
}
