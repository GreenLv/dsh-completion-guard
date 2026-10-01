// FROZEN BASELINE ORACLE (CG-083-V1): exact 913a4c7a6f0f600f4146ef4af694d3af6e477ef2 copy of src/domain/contract-digest.ts. Do not edit except wholesale replacement.
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
