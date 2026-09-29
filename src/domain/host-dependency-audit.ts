import { basename, join, dirname, relative, resolve, sep, isAbsolute } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createHostAuditSession, type HostAuditSession } from './host-audit-session.js'
import { hostNodeConditions } from './host-node-conditions.js'

export interface DependencyAuditGraph {
  modules: string
  records: Record<string, { url?: unknown; dependencies?: unknown }>
  reachable: Set<string>
  packages: Map<string, { root: string; manifest: Record<string, unknown>; files: string[]; independentLanes?: boolean }>
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
 * how fresh the audit's own memo table is. Within its support domain the
 * interpreter is NODE-EXACT:
 *
 * - exports shape: a string/null root target, a conditions object with no
 *   dot-prefixed keys, or a subpath map whose keys are all exactly '.' or
 *   start with './'. Mixing dot and non-dot keys is ERR_INVALID_PACKAGE_CONFIG.
 * - subpath lookup: the exact key wins; a sibling wildcard pattern never
 *   shadows a real exact key. Unrequested patterns/arrays/unmodellable shapes
 *   are OUTSIDE the support domain and fail closed — they never approximate.
 * - condition selection follows manifest key order and actual startup
 *   conditions, including CLI/NODE_OPTIONS custom conditions, node-addons and
 *   module-sync availability. Both require and import lanes must agree on the
 *   authenticated target. Invalid active branches and numeric keys fail closed;
 *   legal no-match branches continue to the next sibling.
 * - target validation happens BEFORE any URL normalization or realpath
 *   comparison, on the RAW target string: it must start with './', contain no
 *   backslash, no encoded separators (%2f/%5c), and no raw OR percent-encoded
 *   empty/'.'/'..'/'node_modules' (case-insensitive) segment — exactly the
 *   shapes Node rejects with ERR_INVALID_PACKAGE_TARGET. Normalization never
 *   launders illegal syntax, and realpath equal to the authenticated file is
 *   never sufficient for an illegal target.
 */
const NUMERIC_CONDITION_KEY = /^(?:0|[1-9][0-9]*)$/
const ENCODED_SEPARATOR = /%2f|%5c/i

/**
 * One loading lane's selection over a conditions entry. Four explicit states:
 * a resolved target string, an explicit deny (null), a legal no-match (the
 * lane's conditions skip this object entirely, so Node CONTINUES to the next
 * sibling key), and an invalid/unsupported input that must fail the route
 * instead of falling through. Numeric condition keys are
 * ERR_INVALID_PACKAGE_CONFIG; a matched branch whose value is neither
 * string/null/object is an invalid branch, never a fallback trigger.
 */
type LaneSelection = 'invalid' | 'deny' | 'no-match' | { target: string }

function selectLane(value: unknown, depth: number, lane: 'require' | 'import'): LaneSelection {
  if (value === null) return 'deny'
  if (typeof value === 'string') return { target: value }
  if (depth > 4 || !value || typeof value !== 'object' || Array.isArray(value)) return 'invalid'
  const conditions = value as Record<string, unknown>
  for (const key of Object.keys(conditions)) {
    if (NUMERIC_CONDITION_KEY.test(key)) return 'invalid'
  }
  const active = new Set(hostNodeConditions()[lane])
  for (const key of Object.keys(conditions)) {
    if (key === 'default' || active.has(key)) {
      const nested = selectLane(conditions[key], depth + 1, lane)
      if (nested === 'no-match') continue
      return nested
    }
  }
  return 'no-match'
}

/** Raw-target validation, per Node's ERR_INVALID_PACKAGE_TARGET rules. */
function rawTargetAllowed(target: string): boolean {
  if (!target.startsWith('./') || target.includes('\\') || ENCODED_SEPARATOR.test(target)) return false
  const rest = target.slice(2)
  if (rest === '') return false
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return false
    let decoded = segment
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return false
    }
    const lowered = decoded.toLowerCase()
    if (lowered === '.' || lowered === '..' || lowered === 'node_modules') return false
  }
  return true
}

/** True when every lane Node may actually load resolves to the wanted file. */
function interpretScopeRoute(session: HostAuditSession, scope: { dir: string; manifest: Record<string, unknown> },
  request: string, wanted: string, selectedLane?: 'require' | 'import'): boolean {
  const packageName = String(scope.manifest.name)
  const subpath = request === packageName ? '.' : '.' + request.slice(packageName.length)
  const rawExports = scope.manifest.exports
  let rootTarget: unknown
  let subpathMap: Record<string, unknown> | undefined
  if (rawExports === undefined) return true
  if (rawExports === null || typeof rawExports === 'string') {
    rootTarget = rawExports
  } else if (typeof rawExports === 'object' && !Array.isArray(rawExports)) {
    const keys = Object.keys(rawExports as Record<string, unknown>)
    const dotKeys = keys.filter((key) => key === '.' || key.startsWith('./'))
    if (dotKeys.length === 0 && keys.length > 0) {
      rootTarget = rawExports
    } else if (dotKeys.length === keys.length) {
      subpathMap = rawExports as Record<string, unknown>
    } else {
      return false
    }
  } else {
    return false
  }
  let entry: unknown
  if (subpathMap !== undefined) {
    if (!Object.hasOwn(subpathMap, subpath)) return false
    entry = subpathMap[subpath]
  } else {
    if (subpath !== '.') return false
    entry = rootTarget
  }
  // BOTH loading lanes must independently resolve to the authenticated file.
  // A require-lane proof says nothing about the import lane: Node selects
  // conditional exports separately per lane, so `{require: ok, default:
  // wrong}` and `{node: {import: wrong}, default: ok}` both load wrong.js for
  // a real ESM consumer. Each lane resolves on its own; the routes must agree.
  for (const lane of selectedLane ? [selectedLane] : ['require', 'import'] as const) {
    const selection = selectLane(entry, 0, lane)
    if (selection === 'no-match' || selection === 'deny' || selection === 'invalid') return false
    if (!rawTargetAllowed(selection.target)) return false
    let targetPath: string
    try {
      targetPath = fileURLToPath(new URL(selection.target, pathToFileURL(join(scope.dir, '/'))))
    } catch {
      return false
    }
    const scopeRelative = relative(scope.dir, targetPath)
    if (scopeRelative.startsWith('..') || isAbsolute(scopeRelative)) return false
    if (session.realpath(targetPath) !== wanted) return false
  }
  return true
}

/** Each declared runtime entry must resolve to the authenticated target in
 * both startup lanes. Wildcard source-only exports are not entrypoints. */
function runtimeExports(manifest: Record<string, unknown>, independentLanes = false): Array<{ subpath: string; target: string; lane?: 'require' | 'import' }> {
  const result: Array<{ subpath: string; target: string; lane?: 'require' | 'import' }> = []
  const raw = manifest.exports
  if (raw === undefined) {
    const main = manifest.main ?? './index.js'
    if (typeof main !== 'string') throw new Error('invalid main')
    const target = main.startsWith('./') ? main : './' + main
    if (!rawTargetAllowed(target)) throw new Error('invalid main')
    result.push({ subpath: '.', target })
    return result
  }
  const keys = raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.keys(raw) : []
  const dot = keys.filter(key => key === '.' || key.startsWith('./'))
  if (dot.length && dot.length !== keys.length) throw new Error('mixed exports')
  const entries: Array<[string, unknown]> = dot.length ? Object.entries(raw as Record<string, unknown>) : [['.', raw]]
  for (const [key, value] of entries) {
    if (key.includes('*')) continue
    const required = selectLane(value, 0, 'require'), imported = selectLane(value, 0, 'import')
    if (typeof required !== 'object' || typeof imported !== 'object' || (!independentLanes && required.target !== imported.target)
      || !rawTargetAllowed(required.target) || !rawTargetAllowed(imported.target)) throw new Error('unaudited export conditions')
    if (independentLanes) {
      for (const [lane, selection] of [['require', required], ['import', imported]] as const) {
        if (/\.(?:[cm]?js|json)$/.test(selection.target)) result.push({ subpath: key, target: selection.target, lane })
      }
    } else if (/\.(?:[cm]?js|json)$/.test(required.target)) result.push({ subpath: key, target: required.target })
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
    hostNodeConditions()
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
          // Resolve the importer's own main with fresh session reads, never
          // the resident resolver. Node's algorithm: LOAD_AS_FILE (exact, then
          // .js), then LOAD_AS_DIRECTORY — a directory main uses THAT
          // directory's package.json main recursively, and only falls back to
          // index.js when the directory carries no manifest. Guessing
          // index.js over a nested manifest audits the wrong entry file and
          // misses scopes declared beside the real main. Missing, non-file,
          // out-of-root and depth-exceeded forms fail closed.
          const resolveMain = (base: string, spec: string, depth: number): string | undefined => {
            if (depth > 4) return undefined
            const mainPath = resolve(base, spec)
            if (session.exists(mainPath) && session.stat(mainPath).isFile()) return mainPath
            if (session.exists(mainPath + '.js') && session.stat(mainPath + '.js').isFile()) return mainPath + '.js'
            if (!session.exists(mainPath) || !session.stat(mainPath).isDirectory()) return undefined
            const nestedManifestPath = join(mainPath, 'package.json')
            if (session.exists(nestedManifestPath)) {
              const nestedManifest = session.readJson(nestedManifestPath)
              if (typeof nestedManifest.main === 'string') {
                const nested = resolveMain(mainPath, nestedManifest.main, depth + 1)
                if (nested) return nested
                // A declared nested main that resolves to nothing is broken,
                // not a fallback trigger.
                return undefined
              }
            }
            const fallback = join(mainPath, 'index.js')
            return session.exists(fallback) && session.stat(fallback).isFile() ? fallback : undefined
          }
          const mainFile = resolveMain(root, manifest.main, 0)
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
          const exports = session.memo(`exports:${expected.root}`, () => runtimeExports(expected.manifest, expected.independentLanes))
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
            for (const { subpath, target, lane } of exports) {
              const wanted = session.memo(`wanted:${expected.root}\u0000${subpath}\u0000${lane ?? 'both'}`,
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
                if (selfApplies && !interpretScopeRoute(session, scope, request, wanted, lane)) return false
              }
            }
          }
        }
      }
    }
    return true
  } catch { return false }
}
