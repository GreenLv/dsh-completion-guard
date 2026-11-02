import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { activationDigest } from './session-activation.js'
import { satisfiesSupportedHostRange } from './host-version.js'

/** Read-only byte fingerprints; log headers and bodies are never parsed or emitted. */
export interface ActivationPhysicalInventory { sha256: string; sessionSegments: string[] }
type Compression = 'none' | 'zstd'
type Stamp = { dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string; mode: string; nlink: string }
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
    if (activationDigest(stamp(path, 'file')) !== activationDigest(expected)) throw new Error('activation_inventory_changed')
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
export function captureActivationPhysicalInventory(root: string, compression: Compression, backendSha256: string): ActivationPhysicalInventory {
  if (!['none', 'zstd'].includes(compression) || !/^[a-f0-9]{64}$/u.test(backendSha256)) throw new Error('activation_inventory_unsupported')
  const absolute = resolve(root)
  // Do not allow a linked root or ancestor to redirect a census. On macOS the
  // system /tmp alias is allowed only after the caller supplies the real path.
  let parent = absolute
  while (true) {
    stamp(parent, 'directory', parent === absolute)
    const next = dirname(parent); if (next === parent) break; parent = next
  }
  if (realpathSync(absolute) !== absolute) throw new Error('activation_inventory_unsupported')
  const records: Array<{ path: string; kind: string; stamp: Stamp; contentSha256?: string }> = []
  const sessionSegments: string[] = []
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
      let generations = 0
      for (const name of entries) {
        const path = join(sessionPath, name)
        const metadata = stamp(path, 'file')
        if (name === 'session.lock') { records.push({ path: `${project}/${session}/${name}`, kind: 'lock', stamp: metadata }); continue }
        const match = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/u.exec(name)
        if (!match || (match[2] ? 'zstd' : 'none') !== compression
          || (match[1] && (!Number.isSafeInteger(Number(match[1])) || Number(match[1]) > 4))) throw new Error('activation_inventory_unsupported')
        generations++
        records.push({ path: `${project}/${session}/${name}`, kind: 'generation', stamp: metadata, contentSha256: fileDigest(path, metadata) })
      }
      if (!generations) throw new Error('activation_inventory_incomplete')
      if (generations !== 1) throw new Error('activation_inventory_unsupported')
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
  return { sha256: activationDigest({ schema: 'dsh-activation-physical-inventory/v1', root: absolute, compression, backendSha256, records }), sessionSegments: sessionSegments.sort() }
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

/** Wrap the SDK seam without treating the seam itself as a physical census. */
export function guardActivationInventory<T extends { list(): Promise<readonly { header: unknown }[]> }>(
  persistence: T, capture: () => ActivationPhysicalInventory,
): { initial: ActivationPhysicalInventory; check: () => ActivationPhysicalInventory; list: () => ReturnType<T['list']> } {
  const initial = capture()
  const check = () => {
    const current = capture()
    if (current.sha256 !== initial.sha256) throw new Error('activation_inventory_changed')
    return current
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
