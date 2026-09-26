import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'

export interface DependencyAuditGraph {
  modules: string
  records: Record<string, { url?: unknown; dependencies?: unknown }>
  reachable: Set<string>
  packages: Map<string, { root: string; manifest: Record<string, unknown>; files: string[] }>
}

const within = (root: string, path: string): boolean => path.startsWith(root + sep)

/** rc.2's authenticated exports have only types/default conditions. Do not use
 * CJS resolution as an ESM oracle if a future manifest introduces other branches.
 * Wildcard source exports are not runtime entrypoints in the published audit.
 */
function runtimeExports(manifest: Record<string, unknown>): Map<string, string> {
  const result = new Map<string, string>()
  const entries = manifest.exports
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('missing audited exports')
  for (const [key, value] of Object.entries(entries)) {
    if (key.includes('*')) continue
    let target: unknown = value
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (Object.keys(value).some(condition => condition !== 'types' && condition !== 'default')) throw new Error('unaudited export conditions')
      target = (value as Record<string, unknown>).default
    }
    if (typeof target !== 'string' || !target.startsWith('./')) throw new Error('invalid export target')
    if (/\.(?:m?js|cjs|json)$/.test(target)) result.set(key, target)
  }
  return result
}

/** Authenticate dependency *edges*, after authenticating mapped package bytes.
 * rc.2 app-boot leaves installation imports native. Within a profile, local
 * candidates win; only their absence permits interception to installation
 * packages. A mapped but missing local edge never becomes a runtime fallback.
 * All audited module locations are checked, including nested subpath importers.
 */
export function auditHostDependencyRoutes(graphs: readonly DependencyAuditGraph[], profileRoot: string): boolean {
  try {
    const installation = graphs[0]
    if (!installation) return false
    const profile = realpathSync(profileRoot)
    for (const graph of graphs) {
      const isProfile = graph !== installation
      for (const id of graph.reachable) {
        const record = graph.records[id]
        if (id !== '.' && typeof record.url !== 'string') return false
        const configuredRoot = resolve(graph.modules, String(record.url))
        if (id !== '.' && !existsSync(configuredRoot)
          && !Object.keys(record.dependencies as object).some(name => graph.packages.has(name) || installation.packages.has(name))) continue
        const root = id === '.' ? dirname(graph.modules) : realpathSync(resolve(graph.modules, String(record.url)))
        if (id !== '.' && !within(graph.modules, root)) return false
        const manifestPath = join(root, 'package.json')
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
        const mapped = record.dependencies as Record<string, string>
        const declared = { ...(manifest.dependencies as object), ...(manifest.peerDependencies as object), ...(manifest.optionalDependencies as object) }
        const names = new Set([...Object.keys(declared), ...Object.keys(mapped)].filter(name => graph.packages.has(name) || installation.packages.has(name)))
        if (names.size === 0) continue
        const own = graph.packages.get(String(manifest.name))
        const importers = new Set([manifestPath])
        if (own?.root === root) {
          for (const file of own.files) if (/\.(?:m?js|cjs)$/.test(file)) importers.add(join(root, file))
        } else if (typeof manifest.main === 'string') {
          const main = realpathSync(createRequire(manifestPath).resolve(resolve(root, manifest.main)))
          if (!within(root, main)) return false
          importers.add(main)
        }
        for (const name of names) {
          const local = graph.packages.get(name)
          const installed = installation.packages.get(name)
          if (!local && !installed) continue // Noncritical packages are outside this byte contract.
          const targetId = mapped[name]
          if (targetId !== undefined) {
            const target = graph.records[targetId]
            if (!graph.reachable.has(targetId) || typeof target?.url !== 'string'
              || !local || realpathSync(resolve(graph.modules, target.url)) !== local.root) return false
          } else if (!isProfile || local) return false
          const expected = local ?? installed!
          const exports = runtimeExports(expected.manifest)
          // Bare dependency resolution depends on the importer directory.
          const directories = new Map([...importers].map(path => [dirname(path), path]))
          for (const importer of directories.values()) {
            const require = createRequire(importer)
            // Inspect native search paths before calling resolve: an active
            // official loader must not conceal a package-map/local-path mismatch.
            const paths = require.resolve.paths(name) ?? []
            const localPaths = isProfile ? paths.filter(path => within(profile, path)) : paths
            const selected = localPaths.map(path => join(path, name)).find(path => existsSync(path))
            if (selected) {
              if (!statSync(selected).isDirectory() || realpathSync(selected) !== expected.root) return false
            } else if (!isProfile || local || !installed) return false
            for (const [subpath, target] of exports) {
              const wanted = realpathSync(resolve(expected.root, target))
              if (!within(expected.root, wanted) || !expected.files.includes(target.slice(2))) return false
              // Profile fallback is the official interception route, not Node's
              // unrelated ancestor fallback. Installation/local routes remain native.
              if (selected) {
                const request = name + (subpath === '.' ? '' : subpath.slice(1))
                if (realpathSync(require.resolve(request)) !== wanted) return false
              }
            }
          }
        }
      }
    }
    return true
  } catch { return false }
}
