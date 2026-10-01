import type { GuardItem, GuardItemKind } from './types.js'

/**
 * CG-083-PERF02: per-fold indexes over the projection's item map.
 *
 * The historical fold answered two questions with a full scan per insertion:
 * "what is the next numeric id for this kind" and "is there already a pending
 * item with the same kind, text digest and verification subject". With N
 * items that made capture itself O(N²) — the dominant term of a long history
 * projection. The indexes below keep the EXACT scan semantics (including the
 * kind filter of `nextId`, the id-prefix-only filter of `nextNumericId`, and
 * the live `status === 'pending'` check of the duplicate search) while making
 * each lookup O(1) amortized.
 *
 * The index is keyed by the item-map identity: every derive call builds a
 * fresh projection, so each fold gets its own index and nothing survives into
 * the next rebuild. Every insertion point into `projection.items` must call
 * {@link registerFoldItem} — there are exactly four (capture insert,
 * clause-partition sub-items, supersession replacements, and rebind
 * replacements), and the differential harness in
 * `tests/v083-projection-index-differential.test.ts` compares both paths.
 *
 * Set `DSH_GUARD_DISABLE_INDEXES=1` to force the original full-scan paths;
 * the fast path is a pure lookup structure and never changes a verdict.
 */

interface ItemFoldIndex {
  /** Max numeric suffix per item KIND, mirroring nextId's kind-filtered scan. */
  idCounters: Map<GuardItemKind, number>
  /** Max numeric suffix per literal ID PREFIX, mirroring nextNumericId. */
  prefixCounters: Map<string, number>
  /** kind\0textSha256\0subject → ids in insertion order. */
  duplicates: Map<string, string[]>
}

const itemFoldIndexes = new WeakMap<Map<string, GuardItem>, ItemFoldIndex>()

export const KIND_PREFIXES: Readonly<Record<GuardItemKind, string>> = {
  requirement: 'R',
  acceptance: 'A',
  prohibition: 'P',
}

export function indexesEnabled(): boolean {
  return process.env.DSH_GUARD_DISABLE_INDEXES !== '1'
}

function foldIndexOf(items: Map<string, GuardItem>): ItemFoldIndex {
  let index = itemFoldIndexes.get(items)
  if (!index) {
    index = { idCounters: new Map(), prefixCounters: new Map(), duplicates: new Map() }
    itemFoldIndexes.set(items, index)
  }
  return index
}

/** Register one insertion into the item map. Cheap and idempotent per id. */
export function registerFoldItem(items: Map<string, GuardItem>, item: GuardItem): void {
  if (!indexesEnabled()) return
  const index = foldIndexOf(items)
  const kindMax = index.idCounters.get(item.kind)
  const kindNum = Number(item.id.slice(KIND_PREFIXES[item.kind].length))
  if (Number.isInteger(kindNum) && (kindMax === undefined || kindNum > kindMax)) {
    index.idCounters.set(item.kind, kindNum)
  }
  for (const prefix of Object.values(KIND_PREFIXES)) {
    if (!item.id.startsWith(prefix)) continue
    const num = Number(item.id.slice(prefix.length))
    const max = index.prefixCounters.get(prefix)
    if (Number.isInteger(num) && (max === undefined || num > max)) index.prefixCounters.set(prefix, num)
  }
  const key = `${item.kind}\0${item.textSha256}\0${item.verification.subject}`
  const bucket = index.duplicates.get(key)
  if (bucket) bucket.push(item.id)
  else index.duplicates.set(key, [item.id])
}

/** nextId, with the same result as the historical full scan. */
export function nextIdFromIndex(items: Map<string, GuardItem>, kind: GuardItemKind): string | undefined {
  if (!indexesEnabled()) return undefined
  const index = foldIndexOf(items)
  const max = index.idCounters.get(kind)
  if (max === undefined) {
    // First query for this kind pays one scan to seed the counter, so a
    // projection that was mutated before this module existed stays exact.
    // The historical scan seeds `max = 0`, so an empty map yields 001.
    let seeded = 0
    for (const item of items.values()) {
      if (item.kind !== kind) continue
      const num = Number(item.id.slice(KIND_PREFIXES[kind].length))
      if (Number.isInteger(num) && num > seeded) seeded = num
    }
    index.idCounters.set(kind, seeded)
    return `${KIND_PREFIXES[kind]}${String(seeded + 1).padStart(3, '0')}`
  }
  return `${KIND_PREFIXES[kind]}${String(max + 1).padStart(3, '0')}`
}

/** nextNumericId (literal prefix scan over all kinds), same result. */
export function nextNumericIdFromIndex(items: Map<string, GuardItem>, prefix: string): number | undefined {
  if (!indexesEnabled()) return undefined
  const index = foldIndexOf(items)
  const max = index.prefixCounters.get(prefix)
  if (max === undefined) {
    let seeded = 0
    for (const item of items.values()) {
      if (!item.id.startsWith(prefix)) continue
      const num = Number(item.id.slice(prefix.length))
      if (Number.isInteger(num) && num > seeded) seeded = num
    }
    index.prefixCounters.set(prefix, seeded)
    return seeded + 1
  }
  return max + 1
}

/** The pending duplicate the historical scan would have found, if any. */
export function findPendingDuplicateFromIndex(items: Map<string, GuardItem>,
  kind: GuardItemKind, textSha256: string, subject: string): GuardItem | undefined {
  if (!indexesEnabled()) return undefined
  const index = foldIndexOf(items)
  const bucket = index.duplicates.get(`${kind}\0${textSha256}\0${subject}`)
  if (!bucket) return undefined
  for (const id of bucket) {
    const existing = items.get(id)
    if (existing && existing.status === 'pending' && existing.textSha256 === textSha256
      && existing.verification.subject === subject) return existing
  }
  return undefined
}
