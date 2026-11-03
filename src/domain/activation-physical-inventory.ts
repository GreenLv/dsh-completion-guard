import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { activationDigest } from './session-activation.js'
import { satisfiesSupportedHostRange } from './host-version.js'

/** The census is not a proof: every generation must be verified by the
 * qualified SDK verifier before it can be consumed by an inventory guard. */
type Compression = 'none' | 'zstd'
type Stamp = { dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string; mode: string; nlink: string }
export interface ActivationPhysicalGeneration {
  readonly relativePath: string
  readonly projectSegment: string
  readonly sessionSegment: string
  readonly version: number
  readonly format: 'jsonl'
  readonly compression: Compression
  readonly contentSha256: string
  readonly identity: Readonly<Stamp>
}
export interface ActivationPhysicalCensus {
  readonly kind: 'unverified'
  readonly root: string
  readonly compression: Compression
  readonly backendSha256: string
  readonly censusSha256: string
  readonly multiGenerationSessionCount: number
  readonly generations: readonly ActivationPhysicalGeneration[]
}
export interface ActivationGenerationObservation {
  readonly relativePath: string
  readonly contentSha256: string
  readonly version: number
  readonly sessionId: string
  readonly birthIdentitySha256: string
}
export interface ActivationGenerationSelection {
  readonly projectSegment: string
  readonly sessionSegment: string
  readonly selectedRelativePath: string
  readonly selectedVersion: number
}
export interface ActivationGenerationVerification {
  readonly generations: readonly ActivationGenerationObservation[]
  readonly selections: readonly ActivationGenerationSelection[]
}
const validatedInventory: unique symbol = Symbol('validated physical inventory')
/** Only the verifier adapter can issue this branded, in-process proof. */
export interface ActivationPhysicalInventory {
  readonly kind: 'validated'
  readonly sha256: string
  readonly censusSha256: string
  readonly sessionSegments: readonly string[]
  readonly [validatedInventory]: true
}
const issuedProofs = new WeakSet<object>()
const issuedCensuses = new WeakSet<object>()
function stamp(path: string, kind: 'directory' | 'file', requireIdentity = true): Stamp {
  const stat = lstatSync(path, { bigint: true })
  if (requireIdentity && stat.ino === 0n) throw new Error('activation_inventory_identity_unavailable')
  if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())
    || (kind === 'file' && stat.nlink !== 1n)) throw new Error('activation_inventory_unsupported')
  return { dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs), mode: String(stat.mode), nlink: String(stat.nlink) }
}
function fileDigest(path: string, expected: Stamp): string {
  const fd = openSync(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW))
  try {
    const stat = fstatSync(fd, { bigint: true })
    if (!stat.isFile() || String(stat.dev) !== expected.dev || String(stat.ino) !== expected.ino || stat.nlink !== 1n) throw new Error('activation_inventory_changed')
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024)
    for (;;) { const length = readSync(fd, buffer, 0, buffer.length, null); if (length === 0) break; hash.update(buffer.subarray(0, length)) }
    const final = fstatSync(fd, { bigint: true })
    if (!final.isFile() || String(final.dev) !== expected.dev || String(final.ino) !== expected.ino
      || String(final.size) !== expected.size || String(final.mtimeNs) !== expected.mtimeNs
      || String(final.ctimeNs) !== expected.ctimeNs || String(final.mode) !== expected.mode || String(final.nlink) !== expected.nlink
      || activationDigest(stamp(path, 'file')) !== activationDigest(expected)) throw new Error('activation_inventory_changed')
    return hash.digest('hex')
  } finally { closeSync(fd) }
}
function pathSegment(id: string): string {
  if (!id) throw new Error('activation_inventory_invalid')
  if (id === '.' || id === '..') return [...id].map(() => '~002E').join('')
  let out = ''
  for (let i = 0; i < id.length; i++) {
    const c = id[i]
    out += /^[A-Za-z0-9._-]$/u.test(c) ? c : `~${id.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}
/** Bound to the actual root, encoding and independently identified backend.
 * Unknown layouts and links fail closed; all generations are fingerprinted. */
export function captureActivationPhysicalInventory(root: string, compression: Compression, backendSha256: string): ActivationPhysicalCensus {
  if (!['none', 'zstd'].includes(compression) || !/^[a-f0-9]{64}$/u.test(backendSha256)) throw new Error('activation_inventory_unsupported')
  const absolute = resolve(root)
  // Do not allow a linked root or ancestor to redirect a census. On macOS the
  // system /tmp alias is allowed only after the caller supplies the real path.
  let parent = absolute
  const ancestors: Array<{ path: string; stamp: Stamp }> = []
  while (true) {
    ancestors.push({ path: parent, stamp: stamp(parent, 'directory', parent === absolute) })
    const next = dirname(parent); if (next === parent) break; parent = next
  }
  if (realpathSync(absolute) !== absolute) throw new Error('activation_inventory_unsupported')
  const records: Array<{ path: string; kind: string; stamp: Stamp; contentSha256?: string }> = []
  const sessionSegments: string[] = []
  const generations: ActivationPhysicalGeneration[] = []
  function directory(path: string, relative: string): string[] {
    const before = stamp(path, 'directory')
    const entries = readdirSync(path).sort()
    if (entries.length > 100_000 || records.length > 200_000) throw new Error('activation_inventory_unsupported')
    records.push({ path: relative, kind: 'directory', stamp: before })
    const after = stamp(path, 'directory')
    if (activationDigest(before) !== activationDigest(after)) throw new Error('activation_inventory_changed')
    return entries
  }
  const projects = directory(absolute, '.')
  for (const project of projects) {
    const projectPath = join(absolute, project)
    for (const session of directory(projectPath, project)) {
      const sessionPath = join(projectPath, session)
      const entries = directory(sessionPath, `${project}/${session}`)
      let generationCount = 0
      const versions = new Set<number>()
      for (const name of entries) {
        const path = join(sessionPath, name)
        const metadata = stamp(path, 'file')
        if (name === 'session.lock') { records.push({ path: `${project}/${session}/${name}`, kind: 'lock', stamp: metadata }); continue }
        const match = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/u.exec(name)
        if (!match || (match[2] ? 'zstd' : 'none') !== compression
          || (match[1] && (!Number.isSafeInteger(Number(match[1])) || Number(match[1]) > 4))) throw new Error('activation_inventory_unsupported')
        const version = match[1] ? Number(match[1]) : 0
        if (versions.has(version)) throw new Error('activation_inventory_unsupported')
        versions.add(version); generationCount++
        const relativePath = `${project}/${session}/${name}`, contentSha256 = fileDigest(path, metadata)
        records.push({ path: relativePath, kind: 'generation', stamp: metadata, contentSha256 })
        generations.push(Object.freeze({ relativePath, projectSegment: project, sessionSegment: session,
          version, format: 'jsonl', compression, contentSha256, identity: Object.freeze({ ...metadata }) }))
      }
      if (!generationCount) throw new Error('activation_inventory_incomplete')
      sessionSegments.push(session)
    }
  }
  if (new Set(sessionSegments).size !== sessionSegments.length) throw new Error('activation_inventory_incomplete')
  // Re-read every recorded inode after traversal, catching mutation within the
  // census as well as between this census and the SDK list/open/stat pass.
  for (const row of records) {
    const path = row.path === '.' ? absolute : join(absolute, row.path)
    if (activationDigest(stamp(path, row.kind === 'directory' ? 'directory' : 'file')) !== activationDigest(row.stamp)) throw new Error('activation_inventory_changed')
  }
  // Recheck ancestor identity as well as leaf entries; do not bind mutable
  // directory timestamps outside the storage root to unrelated user activity.
  for (const row of ancestors) {
    const current = stamp(row.path, 'directory', row.path === absolute)
    if (current.dev !== row.stamp.dev || current.ino !== row.stamp.ino || current.mode !== row.stamp.mode)
      throw new Error('activation_inventory_changed')
  }
  const counts = new Map<string, number>()
  for (const g of generations) {
    const key = `${g.projectSegment}/${g.sessionSegment}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const multiGenerationSessionCount = [...counts.values()].filter(count => count > 1).length
  const census: ActivationPhysicalCensus = Object.freeze({ kind: 'unverified', root: absolute, compression, backendSha256, multiGenerationSessionCount,
    censusSha256: activationDigest({ schema: 'dsh-activation-physical-inventory/v1', root: absolute, compression, backendSha256, records }),
    generations: Object.freeze(generations) })
  issuedCensuses.add(census)
  return census
}
export function assertActivationPhysicalRows(physical: ActivationPhysicalInventory, rows: readonly { header: unknown }[]): void {
  const expected = rows.map(row => {
    const id = (row.header as { id?: unknown })?.id
    if (typeof id !== 'string') throw new Error('activation_inventory_invalid')
    return pathSegment(id)
  }).sort()
  if (expected.length !== physical.sessionSegments.length || new Set(expected).size !== expected.length
    || expected.some((value, index) => value !== physical.sessionSegments[index])) throw new Error('activation_inventory_incomplete')
}

/** Certify only after the supplied qualified verifier has strictly checked each
 * generation and independently observed the SDK's selected generation. The
 * adapter owns decoder qualification; a census alone has no proof digest. */
export async function verifyActivationPhysicalInventory(
  census: ActivationPhysicalCensus,
  verifier: (value: ActivationPhysicalCensus) => Promise<ActivationGenerationVerification>,
  recapture: () => ActivationPhysicalCensus,
): Promise<ActivationPhysicalInventory> {
  if (!census || !issuedCensuses.has(census) || census.kind !== 'unverified' || typeof verifier !== 'function') throw new Error('activation_inventory_invalid')
  const before = recapture()
  if (!issuedCensuses.has(before) || before.censusSha256 !== census.censusSha256) throw new Error('activation_inventory_changed')
  const sessions = new Map<string, ActivationPhysicalGeneration[]>()
  for (const generation of census.generations) {
    const key = `${generation.projectSegment}/${generation.sessionSegment}`
    const rows = sessions.get(key) ?? []; rows.push(generation); sessions.set(key, rows)
  }
  const multi = new Map([...sessions].filter(([, rows]) => rows.length > 1))
  // The ordinary one-generation SDK open may legitimately report an official
  // unsupported format. Do not turn that pending case into a strict failure.
  let result: ActivationGenerationVerification = { generations: [], selections: [] }
  let verifierFailed = false, verifierError: unknown
  try { if (multi.size) result = await verifier(census) }
  catch (error) { verifierFailed = true; verifierError = error }
  const after = recapture()
  if (!issuedCensuses.has(after) || after.censusSha256 !== census.censusSha256) throw new Error('activation_inventory_changed')
  if (verifierFailed) throw verifierError
  const expectedCount = [...multi.values()].reduce((sum, rows) => sum + rows.length, 0)
  if (!result || !Array.isArray(result.generations) || !Array.isArray(result.selections)
    || result.generations.length !== expectedCount) throw new Error('activation_inventory_incomplete')
  const observations = new Map<string, ActivationGenerationObservation>()
  for (const row of result.generations) {
    if (!row || typeof row.relativePath !== 'string' || observations.has(row.relativePath)
      || typeof row.contentSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(row.contentSha256)
      || typeof row.birthIdentitySha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(row.birthIdentitySha256)
      || typeof row.sessionId !== 'string') throw new Error('activation_inventory_invalid')
    observations.set(row.relativePath, row)
  }
  const birth = new Map<string, string>()
  for (const [key, generations] of multi) for (const generation of generations) {
    const observation = observations.get(generation.relativePath)
    if (!observation || observation.version !== generation.version || observation.contentSha256 !== generation.contentSha256
      || pathSegment(observation.sessionId) !== generation.sessionSegment) throw new Error('activation_inventory_incomplete')
    if (birth.has(key) && birth.get(key) !== observation.birthIdentitySha256) throw new Error('activation_inventory_incomplete')
    birth.set(key, observation.birthIdentitySha256)
  }
  if (result.selections.length !== multi.size) throw new Error('activation_inventory_incomplete')
  const selections = new Map<string, ActivationGenerationSelection>()
  for (const selection of result.selections) {
    if (!selection || typeof selection.projectSegment !== 'string' || typeof selection.sessionSegment !== 'string') throw new Error('activation_inventory_invalid')
    const key = `${selection.projectSegment}/${selection.sessionSegment}`
    if (selections.has(key)) throw new Error('activation_inventory_invalid')
    const rows = multi.get(key), latest = rows?.reduce((a, b) => a.version > b.version ? a : b)
    if (!latest || latest.version !== selection.selectedVersion || latest.relativePath !== selection.selectedRelativePath)
      throw new Error('activation_inventory_incomplete')
    selections.set(key, selection)
  }
  const isMulti = multi.size > 0
  const sha256 = isMulti ? activationDigest({ schema: 'dsh-activation-physical-inventory/v2',
    censusSha256: census.censusSha256,
    generations: [...result.generations].sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0),
    selections: [...result.selections].sort((a, b) => a.selectedRelativePath < b.selectedRelativePath ? -1 : a.selectedRelativePath > b.selectedRelativePath ? 1 : 0),
  }) : census.censusSha256
  const proof: ActivationPhysicalInventory = Object.freeze({ kind: 'validated', sha256, censusSha256: census.censusSha256,
    sessionSegments: Object.freeze([...sessions.values()].map(rows => rows[0]!.sessionSegment).sort()), [validatedInventory]: true as const })
  issuedProofs.add(proof)
  return proof
}

/** Wrap the SDK seam; lightweight recensus surrounds every SDK list without
 * repeatedly mounting or decoding already verified generations. */
export function guardActivationInventory<T extends { list(): Promise<readonly { header: unknown }[]> }>(
  persistence: T, initial: ActivationPhysicalInventory, recapture: () => ActivationPhysicalCensus,
): { initial: ActivationPhysicalInventory; check: () => ActivationPhysicalInventory; list: () => ReturnType<T['list']> } {
  if (!initial || !issuedProofs.has(initial)) throw new Error('activation_inventory_proof_required')
  const check = () => {
    const current = recapture()
    if (!current || !issuedCensuses.has(current) || current.censusSha256 !== initial.censusSha256)
      throw new Error('activation_inventory_changed')
    return initial
  }
  const list = async () => {
    const before = check(), rows = await persistence.list(), after = check()
    if (before.sha256 !== after.sha256) throw new Error('activation_inventory_changed')
    assertActivationPhysicalRows(after, rows)
    return rows
  }
  return { initial, check, list: list as () => ReturnType<T['list']> }
}

/** Resolve the two official plugin export forms without trusting their shape. */
export function resolveActivationPersistencePlugin(module: { default?: unknown; apply?: unknown }): unknown {
  const plugin = module.default ?? module
  if (typeof plugin !== 'function' && (!plugin || typeof plugin !== 'object'
    || typeof (plugin as { apply?: unknown }).apply !== 'function')) throw new Error('activation_backend_module_invalid')
  return plugin
}

/** Qualify the JSONL implementation by its reviewed module bytes and loader
 * shape; the release version itself is recorded, not an allowlist. */
export function assertActivationBackendIdentity(manifestValue: unknown, actualModules: Record<string, string>, reviewedModules: Record<string, string>): void {
  const manifest = manifestValue as { name?: unknown; version?: unknown; type?: unknown; main?: unknown; imports?: unknown; exports?: Record<string, unknown> }
  const entry = manifest?.exports?.['.'] as Record<string, unknown> | undefined
  if (manifest?.name !== '@deepseek-ai/dsh-session-persistence-jsonl' || typeof manifest.version !== 'string'
    || !satisfiesSupportedHostRange(manifest.version) || manifest.type !== 'module' || manifest.main !== 'lib/index.js'
    || manifest.imports !== undefined || !entry || typeof entry !== 'object' || Array.isArray(entry)
    || entry.default !== './lib/index.js' || Object.keys(entry).some(key => key !== 'types' && key !== 'default')
    || (entry.types !== undefined && entry.types !== './lib/types/index.d.ts')) throw new Error('activation_backend_unreviewed')
  const reviewed = Object.fromEntries(Object.entries(reviewedModules).filter(([name]) => name !== 'package.json'))
  if (activationDigest(actualModules) !== activationDigest(reviewed)) throw new Error('activation_backend_unreviewed')
}
