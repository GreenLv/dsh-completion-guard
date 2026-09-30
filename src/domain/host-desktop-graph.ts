import { createRequire } from 'node:module'
import { join, sep, resolve } from 'node:path'
import type { Stats } from 'node:fs'
import { createHash } from 'node:crypto'
import { createHostAuditSession, type HostAuditSession } from './host-audit-session.js'
import type { DependencyAuditGraph } from './host-dependency-audit.js'
import { readAsarFile, readAsarIndex } from './host-desktop.js'
import type { AuditedPackageExpectation } from './host-resolver.js'

const packageNamePattern = /^(?:@[a-zA-Z0-9_-]+\/)?[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/

/** Canonical record ID, before resolving any filesystem path. */
export function desktopInstallationLocation(value: unknown, name: string,
  platform: NodeJS.Platform = process.platform): string {
  if (typeof value !== 'string') throw Error('Desktop installation location invalid')
  // pnpm writes native separators on Windows. Keep one forward-slash record
  // identity so equivalent spellings still collide in the index audit.
  const path = platform === 'win32' ? value.replaceAll('\\', '/') : value
  if (!path.startsWith('node_modules/')) throw Error('Desktop installation location invalid')
  const id = path.slice('node_modules/'.length), parts = id.split('/node_modules/')
  if (!parts.every(part => packageNamePattern.test(part)) || parts.at(-1) !== name) {
    throw Error('Desktop installation location invalid')
  }
  return id
}

/** Desktop's bundled pnpm 11.7 emits a physical hoisted tree and JSON
 * .modules.yaml, without a package map. Read that actual installation index;
 * never write a substitute map or infer registry trust from local metadata.
 * The ordinary byte/route auditor still authenticates every selected peer.
 */
export function desktopHoistedProfileGraph(profile: string, session: HostAuditSession): DependencyAuditGraph {
  const modules = session.realpath(join(profile, 'node_modules'))
  if (!modules.startsWith(session.realpath(profile) + sep)) throw Error('Desktop profile modules escape')
  const metadataPath = join(modules, '.modules.yaml')
  if (session.realpath(metadataPath) !== metadataPath) throw Error('Desktop installation index is linked')
  const bytes = session.readFile(metadataPath)
  if (bytes.length > 2 * 1024 * 1024) throw Error('Desktop installation index too large')
  const metadata = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
  if (metadata.nodeLinker !== 'hoisted' || metadata.layoutVersion !== 5 || metadata.packageManager !== 'pnpm@11.7.0'
    || !metadata.hoistedLocations || typeof metadata.hoistedLocations !== 'object' || Array.isArray(metadata.hoistedLocations)) {
    throw Error('Desktop installation index unsupported')
  }
  const names = packageNamePattern
  const records: DependencyAuditGraph['records'] = Object.create(null) as DependencyAuditGraph['records']
  records['.'] = { url: '..', dependencies: Object.create(null) as Record<string, string> }
  const rootIndex = records['.'].dependencies as Record<string, string>
  const locations = new Set<string>(), roots = new Set<string>()
  for (const [reference, paths] of Object.entries(metadata.hoistedLocations as Record<string, unknown>)) {
    const boundary = reference.indexOf('@', reference.startsWith('@') ? 1 : 0)
    const name = reference.slice(0, boundary), version = reference.slice(boundary + 1)
    if (boundary < 1 || !names.test(name) || !version || !Array.isArray(paths) || !paths.length) throw Error('Desktop installation reference invalid')
    for (const path of paths) {
      const id = desktopInstallationLocation(path, name), parts = id.split('/node_modules/')
      if (locations.has(id)) throw Error('Desktop installation location invalid')
      const configured = resolve(modules, id), root = session.realpath(configured)
      // This adapter covers the bundled physical hoisted layout only.
      if (root !== configured || !root.startsWith(modules + sep) || roots.has(root)) throw Error('Desktop installation location escaped or linked')
      const manifest = session.readJson(join(root, 'package.json'))
      if (manifest.name !== name || typeof manifest.version !== 'string'
        || (!version.startsWith('file:') && manifest.version !== version.split('(', 1)[0])) throw Error('Desktop installation identity mismatch')
      roots.add(root); locations.add(id)
      records[id] = { url: './' + id, dependencies: { [name]: id } }
      if (parts.length === 1) rootIndex[name] = id
      if (locations.size > 20_000) throw Error('Desktop installation index too large')
    }
  }
  // Reject omitted or invented physical packages. Traverse package-owned
  // node_modules only; lib-level shadows are checked by the route auditor.
  const actual = new Set<string>()
  const walk = (directory: string, prefix: string, depth: number): void => {
    if (depth > 32 || !session.listDir) throw Error('Desktop installation inventory unavailable')
    for (const item of session.listDir(directory)) {
      if (item.name.startsWith('.')) continue
      if (!item.isDirectory) throw Error('Desktop physical package expected')
      if (item.name.startsWith('@')) {
        for (const scoped of session.listDir(join(directory, item.name))) {
          const name = item.name + '/' + scoped.name
          if (!scoped.isDirectory || !names.test(name)) throw Error('Desktop scoped package invalid')
          visit(name)
        }
      } else {
        if (!names.test(item.name)) throw Error('Desktop physical package invalid')
        visit(item.name)
      }
    }
    function visit(name: string): void {
      const id = prefix + name, root = join(directory, name)
      actual.add(id)
      if (actual.size > 20_000) throw Error('Desktop installation inventory too large')
      const nested = join(root, 'node_modules')
      if (session.exists(nested)) walk(nested, id + '/node_modules/', depth + 1)
    }
  }
  walk(modules, '', 0)
  if (actual.size !== locations.size || [...actual].some(id => !locations.has(id))) throw Error('Desktop installation index differs from disk')
  return { modules, records, reachable: new Set(Object.keys(records)), packages: new Map() }
}

/** Present real ASAR entries to the existing fresh dual-lane route auditor.
 * This is an in-memory graph of the archive's actual namespace/manifests;
 * it never creates or asserts a pnpm package map for the app. */
export function desktopDependencyGraph(archive: string,
  expectations: readonly AuditedPackageExpectation[], base: HostAuditSession = createHostAuditSession()):
  { graph: DependencyAuditGraph; session: HostAuditSession } {
  const index = readAsarIndex(archive)
  const prefix = archive + sep
  const entry = (path: string): ReturnType<typeof lookup> | undefined => path.startsWith(prefix)
    ? lookup(path.slice(prefix.length).split(sep)) : undefined
  function lookup(parts: string[]): typeof index.root | undefined {
    let node = index.root
    for (const part of parts) {
      if (!node?.files || !part || part === '.' || part === '..') return undefined
      node = node.files[part]
    }
    return node
  }
  const session: HostAuditSession = {
    ...base,
    exists: (path) => path.startsWith(prefix) ? entry(path) !== undefined : base.exists(path),
    realpath: (path) => {
      if (!path.startsWith(prefix)) return base.realpath(path)
      if (!entry(path)) throw new Error('desktop route entry missing')
      return path
    },
    stat: (path) => {
      if (!path.startsWith(prefix)) return base.stat(path)
      const node = entry(path)
      if (!node) throw new Error('desktop route entry missing')
      return { isFile: () => !node.files, isDirectory: () => !!node.files } as Stats
    },
    readFile: (path) => path.startsWith(prefix) ? base.memo('asar-bytes:' + path,
      () => readAsarFile(archive, index, path.slice(prefix.length).split(sep).join('/'))) : base.readFile(path),
    readJson: (path) => path.startsWith(prefix) ? base.memo('asar-json:' + path,
      () => JSON.parse(session.readFile(path).toString('utf8')) as Record<string, unknown>) : base.readJson(path),
    fileDigest: (path) => path.startsWith(prefix) ? base.memo('asar-digest:' + path,
      () => createHash('sha256').update(session.readFile(path)).digest('hex')) : base.fileDigest(path),
    resolvePaths: (importer, name) => base.memo(`desktop-paths:${importer}\0${name}`,
      () => createRequire(importer).resolve.paths(name) ?? []),
  }
  const modules = join(archive, 'dsh', 'node_modules')
  const names = new Set(expectations.map(row => row.name))
  const records: DependencyAuditGraph['records'] = {
    '.': { url: '..', dependencies: Object.fromEntries([...names].map(name => [name, name])) },
  }
  const packages: DependencyAuditGraph['packages'] = new Map()
  for (const expected of expectations) {
    const root = join(modules, expected.name)
    const manifest = session.readJson(join(root, 'package.json'))
    const declared = { ...(manifest.dependencies as object), ...(manifest.peerDependencies as object), ...(manifest.optionalDependencies as object) }
    records[expected.name] = { url: './' + expected.name,
      dependencies: Object.fromEntries([...new Set([expected.name, ...Object.keys(declared).filter(name => names.has(name))])].map(name => [name, name])) }
    packages.set(expected.name, { root, manifest, files: Object.keys(expected.modules ?? {}) })
  }
  return { session, graph: { modules, records, reachable: new Set(Object.keys(records)), packages } }
}
