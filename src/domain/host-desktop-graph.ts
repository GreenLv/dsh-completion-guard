import { createRequire } from 'node:module'
import { join, sep } from 'node:path'
import type { Stats } from 'node:fs'
import { createHash } from 'node:crypto'
import { createHostAuditSession, type HostAuditSession } from './host-audit-session.js'
import type { DependencyAuditGraph } from './host-dependency-audit.js'
import { readAsarFile, readAsarIndex } from './host-desktop.js'
import type { AuditedPackageExpectation } from './host-resolver.js'

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
