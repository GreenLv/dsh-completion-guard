import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync, type Stats } from 'node:fs'
import { createRequire } from 'node:module'

/**
 * Memo table for ONE bounded host-lock validation operation.
 *
 * A full validation re-reads the same real paths, manifests, search paths and
 * export targets from several cooperating audits. Resolution results are
 * reused strictly inside this operation: the table lives and dies with one
 * audit call, is never shared across entries, and is never a substitute for
 * revalidation — a later entry always performs its own fresh reads. There are
 * deliberately no timestamps, mtimes, sizes or cross-call caches here.
 */
export interface HostAuditSession {
  /** Memoized `realpathSync`; identical inputs return the identical result. */
  realpath(path: string): string
  /** Memoized `existsSync`, including the negative result. */
  exists(path: string): boolean
  /** Memoized `statSync`. */
  stat(path: string): Stats
  /** Memoized file read (bytes). */
  readFile(path: string): Buffer
  /** Memoized `JSON.parse` of an object file; parse errors propagate. */
  readJson(path: string): Record<string, unknown>
  /** Memoized SHA-256 of file bytes. */
  fileDigest(path: string): string
  /** Memoized `createRequire` for one importer path. */
  requireFor(importer: string): NodeRequire
  /** Memoized `require.resolve.paths(name)` for one importer. */
  resolvePaths(importer: string, name: string): readonly string[]
  /** Memoized `require.resolve(request)` for one importer. */
  requireResolve(importer: string, request: string): string
  /** Generic operation-scoped memo for derived structures (parsed graphs, indexes). */
  memo<T>(key: string, compute: () => T): T
}

interface CacheEntry {
  settled: boolean
  error?: unknown
  value?: unknown
}

export function createHostAuditSession(): HostAuditSession {
  const cache = new Map<string, CacheEntry>()
  const once = <T>(key: string, compute: () => T): T => {
    const hit = cache.get(key)
    if (hit?.settled) {
      if (hit.error !== undefined) throw hit.error
      return hit.value as T
    }
    try {
      const value = compute()
      cache.set(key, { settled: true, value })
      return value
    } catch (error) {
      // A read error is a verdict input, not a transient state: the same path
      // failing twice inside one audit must stay a failure.
      cache.set(key, { settled: true, error })
      throw error
    }
  }
  return {
    realpath: (path) => once(`realpath:${path}`, () => realpathSync(path)),
    exists: (path) => once(`exists:${path}`, () => existsSync(path)),
    stat: (path) => once(`stat:${path}`, () => statSync(path)),
    readFile: (path) => once(`read:${path}`, () => readFileSync(path)),
    readJson: (path) => once(`json:${path}`, () => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>),
    fileDigest: (path) => once(`digest:${path}`, () => createFileDigest(readFileSync(path))),
    requireFor: (importer) => once(`require:${importer}`, () => createRequire(importer)),
    resolvePaths: (importer, name) => once(`paths:${importer}\u0000${name}`, () => createRequire(importer).resolve.paths(name) ?? []),
    requireResolve: (importer, request) => once(`resolve:${importer}\u0000${request}`, () => createRequire(importer).resolve(request)),
    memo: once,
  }
}

function createFileDigest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}
