import { basename, join, dirname, resolve, sep } from 'node:path'
import { createHostAuditSession, type HostAuditSession } from './host-audit-session.js'

export interface DependencyAuditGraph {
  modules: string
  records: Record<string, { url?: unknown; dependencies?: unknown }>
  reachable: Set<string>
  packages: Map<string, { root: string; manifest: Record<string, unknown>; files: string[] }>
}

const within = (root: string, path: string): boolean => path.startsWith(root + sep)

/**
 * The importer's nearest package scope, with Node's own walk semantics: from
 * the importing module's directory upward, the first directory containing a
 * package.json defines the scope, and a `node_modules` path component ends the
 * walk with no scope. Both the discovery and the read go through the fresh
 * audit session, so a scope introduced or changed between audits is observed
 * and a missing or unparseable manifest fails the audit closed.
 */
function nearestPackageScope(session: HostAuditSession, dir: string):
  { dir: string; path: string; manifest: Record<string, unknown> } | undefined {
  return session.memo(`scope:${dir}`, () => {
    let current = dir
    for (;;) {
      if (basename(current) === 'node_modules') return undefined
      const manifestPath = join(current, 'package.json')
      if (session.exists(manifestPath)) {
        // A corrupt scope manifest is a resolution input, not a transient read
        // error: throw so the audit reports the host unavailable.
        return { dir: current, path: manifestPath, manifest: session.readJson(manifestPath) }
      }
      const parent = dirname(current)
      if (parent === current) return undefined
      current = parent
    }
  })
}

/**
 * Restricted exports interpretation for a nearby package scope. The route
 * authority inside one audit is a fresh oracle over THIS audit's own bytes:
 * the resident `createRequire(...).resolve` keeps Node's internal package
 * manifests and path cache from earlier host activity, so a scope rewritten
 * after that warm-up would keep answering with the pre-drift route no matter
 * how fresh the audit's own memo table is. For the audited rc.2 surface the
 * CJS resolution is deterministic from the bytes, so this interpreter computes
 * the unique route itself and never consults warm resolver receipts.
 *
 * Conditions follow Node's CJS require set; wildcard patterns or shapes this
 * interpreter cannot decide are fail-closed, never approximated.
 */
function interpretScopeRoute(session: HostAuditSession, scope: { dir: string; manifest: Record<string, unknown> },
  request: string, wanted: string): boolean {
  const subpath = request === scope.manifest.name ? '.' : '.' + request.slice(String(scope.manifest.name).length)
  const target = (value: unknown, depth: number): string | null | undefined => {
    if (value === null) return null
    if (typeof value === 'string') return value
    if (depth > 4 || !value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const conditions = value as Record<string, unknown>
    for (const condition of ['node', 'require', 'default'] as const) {
      if (Object.hasOwn(conditions, condition)) return target(conditions[condition], depth + 1)
    }
    return undefined
  }
  let entries: unknown = scope.manifest.exports
  if (entries && typeof entries === 'object' && !Array.isArray(entries)
    && !Object.keys(entries as Record<string, unknown>).some((key) => key.includes('*'))) {
    entries = (entries as Record<string, unknown>)[subpath]
  }
  const resolvedTarget = target(entries, 0)
  // No matching export target: Node refuses the request (the route is broken).
  if (resolvedTarget === null || resolvedTarget === undefined || !resolvedTarget.startsWith('./')) return false
  // The self-route must land on exactly the authenticated file; anything else
  // (a redirect into the scope, a missing file) bypasses the audited bytes.
  return session.realpath(resolve(scope.dir, resolvedTarget)) === wanted
}

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

/** Index reachable IDs by critical package name: exact bare keys and pnpm's
 * versioned `name@version(...)` keys both belong to the name. Built once per
 * audit instead of filtering the reachable set once per expected package.
 */
export function reachableIdsByName(graph: DependencyAuditGraph, session: HostAuditSession): Map<string, string[]> {
  return session.memo(`name-index:${graph.modules}`, () => {
    const index = new Map<string, string[]>()
    for (const id of graph.reachable) {
      // Split `name` from `name@version(...)` exactly where the membership test
      // (`id === name || id.startsWith(name + '@')`) draws the line: a scoped
      // id's leading '@' is part of the name, and any later '@' — including one
      // inside a pnpm peer suffix like `name@ver(@scope/peer@ver)` — is the
      // version separator, so the FIRST '@' after the name is the split point.
      const separator = id[0] === '@' ? id.indexOf('@', 1) : id.indexOf('@')
      const name = id === '.' ? undefined : separator === -1 ? id : id.slice(0, separator)
      if (!name) continue
      const ids = index.get(name)
      if (ids) ids.push(id)
      else index.set(name, [id])
    }
    return index
  })
}

/** Authenticate dependency *edges*, after authenticating mapped package bytes.
 * rc.2 app-boot leaves installation imports native. Within a profile, local
 * candidates win; only their absence permits interception to installation
 * packages. A mapped but missing local edge never becomes a runtime fallback.
 * All audited module locations are checked, including nested subpath importers.
 *
 * Repeated real-path, importer, dependency and export resolutions are memoized
 * through one {@link HostAuditSession}; the session is created per call when
 * the caller does not thread one in, so results never outlive the audit.
 */
export function auditHostDependencyRoutes(graphs: readonly DependencyAuditGraph[], profileRoot: string,
  providedSession?: HostAuditSession): boolean {
  const session = providedSession ?? createHostAuditSession()
  try {
    const installation = graphs[0]
    if (!installation) return false
    const profile = session.realpath(profileRoot)
    for (const graph of graphs) {
      const isProfile = graph !== installation
      for (const id of graph.reachable) {
        const record = graph.records[id]
        if (id !== '.' && typeof record.url !== 'string') return false
        const configuredRoot = resolve(graph.modules, String(record.url))
        if (id !== '.' && !session.exists(configuredRoot)
          && !Object.keys(record.dependencies as object).some(name => graph.packages.has(name) || installation.packages.has(name))) continue
        const root = id === '.' ? dirname(graph.modules) : session.realpath(resolve(graph.modules, String(record.url)))
        if (id !== '.' && !within(graph.modules, root)) return false
        const manifestPath = join(root, 'package.json')
        const manifest = session.readJson(manifestPath)
        const mapped = record.dependencies as Record<string, string>
        const declared = { ...(manifest.dependencies as object), ...(manifest.peerDependencies as object), ...(manifest.optionalDependencies as object) }
        const names = new Set([...Object.keys(declared), ...Object.keys(mapped)].filter(name => graph.packages.has(name) || installation.packages.has(name)))
        if (names.size === 0) continue
        const own = graph.packages.get(String(manifest.name))
        const importers = new Set([manifestPath])
        if (own?.root === root) {
          for (const file of own.files) if (/\.(?:m?js|cjs)$/.test(file)) importers.add(join(root, file))
        } else if (typeof manifest.main === 'string') {
          // Resolve the importer's own main with fresh session reads, never the
          // resident resolver: LOAD_AS_FILE (exact, then .js) and
          // LOAD_AS_DIRECTORY (index.js) cover the supported surface.
          const mainPath = resolve(root, manifest.main)
          const mainFile = session.exists(mainPath) && session.stat(mainPath).isFile() ? mainPath
            : session.exists(mainPath + '.js') ? mainPath + '.js'
            : session.exists(join(mainPath, 'index.js')) ? join(mainPath, 'index.js')
            : undefined
          if (!mainFile) return false
          const main = session.realpath(mainFile)
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
              || !local || session.realpath(resolve(graph.modules, target.url)) !== local.root) return false
          } else if (!isProfile || local) return false
          const expected = local ?? installed!
          const exports = session.memo(`exports:${expected.root}`, () => runtimeExports(expected.manifest))
          // Bare dependency resolution depends on the importer directory.
          const directories = new Map([...importers].map(path => [dirname(path), path]))
          for (const importer of directories.values()) {
            // Inspect native search paths before calling resolve: an active
            // official loader must not conceal a package-map/local-path mismatch.
            const paths = session.resolvePaths(importer, name)
            const localPaths = isProfile ? paths.filter(path => within(profile, path)) : paths
            const selected = localPaths.map(path => join(path, name)).find(path => session.exists(path))
            if (selected) {
              if (!session.stat(selected).isDirectory() || session.realpath(selected) !== expected.root) return false
            } else if (!isProfile || local || !installed) return false
            for (const [subpath, target] of exports) {
              const wanted = session.memo(`wanted:${expected.root}\u0000${subpath}`,
                () => session.realpath(resolve(expected.root, target)))
              if (!within(expected.root, wanted) || !expected.files.includes(target.slice(2))) return false
              // Profile fallback is the official interception route, not Node's
              // unrelated ancestor fallback. Installation/local routes remain native.
              if (selected) {
                const request = name + (subpath === '.' ? '' : subpath.slice(1))
                // Fresh route proof, computed from THIS audit's bytes only. The
                // importer's nearest package scope decides Node's trySelf step:
                // when the scope's name equals the request's package name and
                // the manifest declares exports, the self-route takes over and
                // must land on exactly the authenticated file. Otherwise the
                // node_modules walk picks `selected` — already verified above
                // to realpath to expected.root — and the route is that root's
                // own exports target (`wanted`). The resident resolver is never
                // consulted: its internal package manifests and path cache can
                // hold pre-drift state from earlier host activity, which is
                // exactly the warm-process masking this gate exists to reject.
                const scope = nearestPackageScope(session, dirname(importer))
                const selfApplies = scope !== undefined
                  && scope.manifest.name === name && Object.hasOwn(scope.manifest, 'exports')
                if (selfApplies && !interpretScopeRoute(session, scope, request, wanted)) return false
              }
            }
          }
        }
      }
    }
    return true
  } catch { return false }
}
