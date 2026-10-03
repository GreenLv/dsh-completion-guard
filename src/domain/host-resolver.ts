import { auditHostDependencyRoutes, reachableIdsByName, type DependencyAuditGraph } from './host-dependency-audit.js'
import { createHostAuditSession, type HostAuditSession } from './host-audit-session.js'
import hostByteAudit from '../../manifests/rc020-rc2-byte-audit.json' with { type: 'json' }
import { physicalFs } from './host-physical-fs.js'
const { existsSync, lstatSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } = physicalFs
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  HOST_COHORTS,
  evaluateHostLock,
  evaluateGraphDerivedHostLock,
  type HostLockContext,
  type HostLockEvaluation,
  type HostPlatform,
  type HostProfileKind,
} from './host-lock.js'
import { satisfiesSupportedHostRange } from './host-version.js'
import { acquireHostTrust, hostTrustDigest, parseHostTrust, qualifyHostTrust, type HostRebindTrust, HostTrustError } from './host-trust.js'
import type { PackageRow } from './digest.js'
import { verifyDesktopCarrier } from './host-desktop-identity.js'
import { desktopDependencyGraph, desktopHoistedProfileGraph } from './host-desktop-graph.js'
import {
  auditDesktopInstalledImplementation,
  readDesktopAppRuntime,
  readDesktopDependency,
  readDesktopTargetGraph,
  readAsarFile,
  readAsarIndex,
  writeDesktopRuntimeReceipt,
  DESKTOP_PROFILE_PACKAGE_NAME,
  type DesktopAppRuntime,
} from './host-desktop.js'

/**
 * Names registered in any cohort; rows outside the union are unknown.
 *
 * Sorted, not inherited from cohort row order: the active cohort's own listing
 * order is a presentation choice, and letting it decide the resolution order of
 * `packageRowsFromPnpmLock` would make an unrelated cohort re-ordering look like
 * a lock-reading change.
 */
const CRITICAL_NAMES: readonly string[] = [...new Set(HOST_COHORTS.flatMap((cohort) => cohort.packages.map((row) => row.name)))]
  .sort((a, b) => a.localeCompare(b))
const HOST_LOCK_MARKER_BEGIN = '# >>> BEGIN DSH COMPLETION GUARD HOST LOCK (managed) >>>'
const HOST_LOCK_MARKER_END = '# <<< END DSH COMPLETION GUARD HOST LOCK (managed) <<<'

export class HostProfileError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'HostProfileError'
  }
}

function findUp(start: string, filename: string): string | undefined {
  let directory = start
  while (true) {
    const candidate = join(directory, filename)
    if (existsSync(candidate)) return candidate
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/**
 * Read only the bounded package identities used by the host lock from a pnpm
 * v9 lockfile. Multiple resolved versions are preserved as separate rows so
 * callers cannot silently select a nearest instance.
 */
export function packageRowsFromPnpmLock(text: string, names: readonly string[] = CRITICAL_NAMES): PackageRow[] {
  const rows = new Map<string, PackageRow[]>()
  const lines = text.split(/\r?\n/)
  const packagesStart = lines.findIndex((line) => line === 'packages:')
  const snapshotsStart = lines.findIndex((line) => line === 'snapshots:')
  if (packagesStart < 0) return []
  const end = snapshotsStart > packagesStart ? snapshotsStart : lines.length
  for (let index = packagesStart + 1; index < end; index += 1) {
    const match = lines[index].match(/^  '?((?:@[^/'\s]+\/)?[^@'\s]+)@([^':\s]+)'?:\s*$/)
    if (!match || !names.includes(match[1])) continue
    let integrity: string | undefined
    for (let cursor = index + 1; cursor < lines.length && !/^  \S/.test(lines[cursor]); cursor += 1) {
      const resolution = lines[cursor].match(/^    resolution: \{[^}]*\bintegrity: ([^,}\s]+)[^}]*\}\s*$/)
      if (resolution) { integrity = resolution[1]; break }
    }
    const entries = rows.get(match[1]) ?? []
    entries.push({ name: match[1], version: match[2], ...(integrity ? { integrity } : {}) })
    rows.set(match[1], entries)
  }
  return names.flatMap((name) => {
    const entries = rows.get(name) ?? []
    if (entries.length === 0) return []
    return entries
  })
}

/**
 * The production host verdict: the version floor and the exact-graph audit,
 * combined into the one answer a caller acts on.
 *
 * The two facts stay separable — `hostVersion` is always reported on the
 * evaluation — but a host below the supported floor is refused here even when
 * its graph matches an audited cohort, because no graph can lift a version
 * floor. Keeping this combination out of `evaluateHostLock` leaves that
 * function a pure graph audit, so a graph verdict is never overwritten by a
 * version verdict inside it.
 */
export function combineHostPolicy(evaluation: HostLockEvaluation): HostLockEvaluation {
  const version = evaluation.hostVersion
  if (version?.status !== 'below_minimum' && version?.status !== 'unparseable') return evaluation
  return {
    ...evaluation,
    status: 'unsupported',
    goalAvailable: false,
    reasonCode: version.status === 'below_minimum' ? 'host_lock_version_below_minimum' : 'host_lock_version_unparseable',
  }
}

export function resolveInstalledHostLock(moduleUrl: string = import.meta.url): HostLockEvaluation {
  const lockPath = findUp(dirname(fileURLToPath(moduleUrl)), 'pnpm-lock.yaml')
  if (!lockPath) return combineHostPolicy(evaluateHostLock([]))
  try {
    return combineHostPolicy(evaluateHostLock(packageRowsFromPnpmLock(readFileSync(lockPath, 'utf8'))))
  } catch {
    return combineHostPolicy(evaluateHostLock([]))
  }
}

interface PackageMapRecord {
  url?: unknown
  dependencies?: unknown
}

function activeGraphRecords(packageMapText: string): { records: Record<string, PackageMapRecord>; reachable: Set<string> } {
  let document: unknown
  try { document = JSON.parse(packageMapText) } catch { throw new HostProfileError('active_graph_invalid', 'invalid package map') }
  if (!document || typeof document !== 'object') throw new HostProfileError('active_graph_invalid', 'invalid reachable package map')
  const packages = (document as { packages?: unknown }).packages
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) throw new HostProfileError('active_graph_invalid', 'invalid reachable package map')
  const records = packages as Record<string, PackageMapRecord>
  if (!records['.'] || Object.keys(records).length > 20_000) throw new HostProfileError('active_graph_invalid', 'invalid reachable package map')
  const reachable = new Set<string>()
  const queue = ['.']
  while (queue.length > 0 && reachable.size <= 20_000) {
    const id = queue.shift()!
    if (reachable.has(id)) continue
    const record = records[id]
    if (!record || typeof record !== 'object') throw new HostProfileError('active_graph_invalid', 'invalid reachable package map')
    reachable.add(id)
    if (!record.dependencies || typeof record.dependencies !== 'object' || Array.isArray(record.dependencies)) {
      throw new HostProfileError('active_graph_invalid', 'invalid reachable dependencies')
    }
    for (const target of Object.values(record.dependencies as Record<string, unknown>)) {
      if (typeof target !== 'string' || !target) throw new HostProfileError('active_graph_invalid', 'invalid dependency target')
      if (target !== '.' && !reachable.has(target)) queue.push(target)
    }
  }
  if (queue.length > 0) throw new HostProfileError('active_graph_invalid', 'invalid reachable package map')

  return { records, reachable }
}

/**
 * Resolve only package identities reachable from the active pnpm importer.
 * Historical snapshots elsewhere in the lockfile are deliberately ignored;
 * two reachable peer variants of a critical package remain a duplicate and
 * are returned twice so evaluateHostLock can fail closed with a bounded code.
 */
export function packageRowsFromActiveGraph(
  packageMapText: string,
  lockText: string,
  nodeModulesRoot?: string,
  providedSession?: HostAuditSession,
): PackageRow[] {
  const session = providedSession ?? createHostAuditSession()
  const { records, reachable } = activeGraphRecords(packageMapText)
  return packageRowsFromGraph(records, reachable, lockText, nodeModulesRoot, session)
}

function packageRowsFromGraph(
  records: ReturnType<typeof activeGraphRecords>['records'],
  reachable: Set<string>,
  lockText: string,
  nodeModulesRoot: string | undefined,
  session: HostAuditSession,
): PackageRow[] {
  if (!/^lockfileVersion: ['"]?9\.0['"]?\s*$/m.test(lockText) || !/^packages:(?:\s*\{\})?\s*$/m.test(lockText)) {
    throw new HostProfileError('active_graph_invalid', 'invalid pnpm lockfile shape')
  }

  const locked = packageRowsFromPnpmLock(lockText)
  const rows: PackageRow[] = []
  for (const name of CRITICAL_NAMES) {
    const ids = [...reachable].filter((id) => id === name || id.startsWith(`${name}@`))
    for (const id of ids) {
      let version = id === name ? '' : id.slice(name.length + 1).split('(', 1)[0]
      let installedManifest: Record<string, unknown> | undefined
      if (nodeModulesRoot) {
        const record = records[id]
        if (!record || typeof record.url !== 'string') {
          rows.push({ name })
          continue
        }
        try {
          const modules = session.realpath(nodeModulesRoot)
          const manifestPath = session.realpath(resolve(modules, record.url, 'package.json'))
          if (!manifestPath.startsWith(`${modules}${sep}`)) {
            rows.push({ name })
            continue
          }
          installedManifest = session.readJson(manifestPath)
          if (installedManifest.name !== name || typeof installedManifest.version !== 'string'
            || (version && installedManifest.version !== version)) {
            rows.push({ name })
            continue
          }
          version = installedManifest.version
        } catch {
          rows.push({ name })
          continue
        }
      }
      if (!version) {
        rows.push({ name })
        continue
      }
      const candidates = locked.filter((row) => row.name === name && row.version === version && row.integrity)
      if (candidates.length !== 1) {
        rows.push({ name, ...(version ? { version } : {}) })
        continue
      }
      rows.push(candidates[0])
    }
  }
  return rows
}

export interface ActiveProfileHostLock {
  evaluation: HostLockEvaluation
  runtimeRoot: string
  profileRoot: string
  pluginVersion: string
  platform: HostPlatform
  profileKind: HostProfileKind
  trust?: HostRebindTrust
}

/** Read exact reachable critical rows without requiring Guard installation.
 * Used by target preflight before a legacy profile can be migrated.
 */
export function readActiveHostGraph(runtimeRoot: string, profileRoot: string, providedSession?: HostAuditSession): PackageRow[] {
  const session = providedSession ?? createHostAuditSession()
  const runtime = resolve(runtimeRoot)
  const profile = resolve(profileRoot)
  const mapPath = join(runtime, 'node_modules', '.package-map.json')
  const lockPath = join(runtime, 'pnpm-lock.yaml')
  const profileMapPath = join(profile, 'node_modules', '.package-map.json')
  const profileLockPath = join(profile, 'pnpm-lock.yaml')
  // One parsed graph per map file per audit: the same parse is reused by the
  // byte audit and the dependency-route audit through the shared session.
  const runtimeGraph = session.memo(`graph:${mapPath}`, () => activeGraphRecords(session.readFile(mapPath).toString('utf8')))
  const profileGraph = session.memo(`graph:${profileMapPath}`, () => activeGraphRecords(session.readFile(profileMapPath).toString('utf8')))
  const runtimeRows = packageRowsFromGraph(
    runtimeGraph.records,
    runtimeGraph.reachable,
    session.readFile(lockPath).toString('utf8'),
    join(runtime, 'node_modules'),
    session,
  )
  const profileRows = packageRowsFromGraph(
    profileGraph.records,
    profileGraph.reachable,
    session.readFile(profileLockPath).toString('utf8'),
    join(profile, 'node_modules'),
    session,
  )
  // Preserve duplicates within either active graph (two reachable variants are
  // ambiguous), while deduplicating only the same identity repeated across the
  // runtime/profile boundary.
  const runtimeKeys = new Set(runtimeRows.map((row) => `${row.name}\u0000${row.version ?? ''}\u0000${row.integrity ?? ''}`))
  const rows = [
    ...runtimeRows,
    ...profileRows.filter((row) => !runtimeKeys.has(`${row.name}\u0000${row.version ?? ''}\u0000${row.integrity ?? ''}`)),
  ]
  return rows
}

/** Version/identity evaluation of operator-owned registry expectations. */
export function evaluateConfiguredHostLock(rows: readonly PackageRow[], context: HostLockContext,
  trustText?: string, profileRoot?: string): HostLockEvaluation {
  if (!trustText) return combineHostPolicy(evaluateHostLock(rows, context))
  const trust = parseHostTrust(trustText, profileRoot)
  const evaluation = combineHostPolicy(evaluateGraphDerivedHostLock(rows, { ...context, trustDigest: hostTrustDigest(trust) },
    (row) => trust.packages.some((p) => p.name === row.name && p.version === row.version && p.integrity === row.integrity)))
  return trust.unqualifiedOptionalPackages?.length && evaluation.status === 'supported'
    ? { ...evaluation, goalAvailable: false, goalQualificationFailure: 'host_contract_goal_qualification_required' }
    : evaluation
}

/** Complete production composition; no graph-only result grants authority. */
export function evaluateActiveHostLock(runtime: string, profile: string, context: HostLockContext,
  session: HostAuditSession = createHostAuditSession(), trustText?: string): HostLockEvaluation {
  const rows = readActiveHostGraph(runtime, profile, session)
  const evaluation = evaluateConfiguredHostLock(rows, context, trustText, profile)
  if (evaluation.status !== 'supported') return evaluation
  const trust = trustText ? parseHostTrust(trustText, profile) : undefined
  const expectations = trust ? [...trust.packages, ...(trust.probeDependencies ?? [])] : undefined
  if (!auditedHostImplementation(runtime, profile, session, expectations)) {
    return { ...evaluation, status: 'unsupported', goalAvailable: false, reasonCode: 'host_lock_installed_graph_drift' }
  }
  return evaluation
}

/** Trusted acquisition only; consumers never use local SRI as provenance. */
export async function prepareActiveHostTrust(runtime: string, profile: string,
  fetcher: typeof fetch = fetch): Promise<HostRebindTrust> {
  return acquireHostTrust(readActiveHostGraph(runtime, profile), fetcher, {
    profileRoot: profile,
    dependencyIdentity: (name, importer) => probeDependencyIdentity(runtime, profile, name, importer),
  })
}

function probeDependencyIdentity(runtime: string, profile: string, name: string, importer: string): PackageRow {
  for (const owner of [runtime, profile]) {
    const modules = join(owner, 'node_modules'), mapPath = join(modules, '.package-map.json')
    if (!existsSync(mapPath)) continue
    const { records, reachable } = activeGraphRecords(readFileSync(mapPath, 'utf8'))
    const id = [...reachable].find((key) => key === importer || key.startsWith(importer + '@'))
    if (!id || typeof records[id]?.url !== 'string') continue
    const anchor = join(realpathSync(resolve(modules, records[id].url as string)), 'package.json')
    const packageRoot = packageFromAnchor(anchor, name)
    if (!packageRoot) continue
    for (const graphRoot of [runtime, profile]) {
      if (!existsSync(join(graphRoot, 'node_modules'))) continue
      const graphModules = realpathSync(join(graphRoot, 'node_modules'))
      const graph = activeGraphRecords(readFileSync(join(graphModules, '.package-map.json'), 'utf8'))
      const ids = [...graph.reachable].filter((key) => key === name || key.startsWith(name + '@'))
      if (ids.length !== 1 || typeof graph.records[ids[0]]?.url !== 'string'
        || realpathSync(resolve(graphModules, graph.records[ids[0]].url as string)) !== packageRoot) continue
      if (!within(graphModules, packageRoot)) continue
      const manifest = readJsonObject(join(packageRoot, 'package.json'), 'host_contract_probe_dependency_unbound')
      const matches = packageRowsFromPnpmLock(readFileSync(join(graphRoot, 'pnpm-lock.yaml'), 'utf8'), [name])
        .filter((row) => row.version === manifest.version && row.integrity)
      if (manifest.name === name && matches.length === 1) return matches[0]
    }
  }
  throw new HostProfileError('host_contract_probe_dependency_unbound', 'probe dependency lacks an exact installed registry identity')
}

/** Verify published executable bytes at the reachable runtime/profile roots.
 * Registry SRI and installed manifests alone cannot authenticate loaded code.
 * Missing, duplicate, escaped or modified modules never pass this audit.
 *
 * All filesystem resolution within one call is memoized through a single
 * {@link HostAuditSession}; callers may thread one in to share the parsed
 * graphs and digests with the other audits of the same validation operation.
 */
export interface AuditedPackageExpectation {
  name: string
  version?: string
  /** Required published per-file digests; absence never authenticates bytes. */
  modules?: Record<string, string>
}

/** Byte and dual-lane route audit over both graphs. Expectations are either
 * the published baseline or operator-owned, registry-acquired qualified module
 * digests. A missing digest set never authenticates unknown implementation. */
export function auditedHostImplementation(runtimeRoot: string, profileRoot: string,
  providedSession?: HostAuditSession, expectations?: readonly AuditedPackageExpectation[],
  installationGraph?: DependencyAuditGraph, profileInstallationGraph?: DependencyAuditGraph): boolean {
  const session = providedSession ?? createHostAuditSession()
  try {
    const expectedPackages: readonly AuditedPackageExpectation[] = expectations ?? (hostByteAudit.packages as unknown as readonly AuditedPackageExpectation[])
    const seen = new Set<string>(installationGraph?.packages.keys())
    const graphs: DependencyAuditGraph[] = installationGraph ? [installationGraph] : []
    for (const rootPath of new Set([runtimeRoot, profileRoot])) {
      if (installationGraph && rootPath === runtimeRoot) continue
      const modulesPath = join(rootPath, 'node_modules')
      const supplied = rootPath === profileRoot ? profileInstallationGraph : undefined
      if (!supplied && !session.exists(join(modulesPath, '.package-map.json'))) {
        if (rootPath === runtimeRoot) return false
        continue
      }
      const modules = supplied?.modules ?? session.realpath(modulesPath)
      const mapPath = join(modules, '.package-map.json')
      const { records, reachable } = supplied ?? session.memo(`graph:${mapPath}`,
        () => activeGraphRecords(session.readFile(mapPath).toString('utf8')))
      const graph: DependencyAuditGraph = { modules, records, reachable, packages: new Map() }
      graphs.push(graph)
      // One name→reachable-IDs index replaces filtering the whole reachable
      // set once per audited package.
      const index = reachableIdsByName(graph, session)
      for (const expected of expectedPackages) {
        const ids = index.get(expected.name) ?? []
        if (ids.length > 1) return false
        if (!ids.length) continue
        const url = records[ids[0]]?.url
        if (typeof url !== 'string' || !url.startsWith('./')) return false
        const root = session.realpath(resolve(modules, url))
        if (!root.startsWith(`${modules}${sep}`)) return false
        const manifest = session.readJson(join(root, 'package.json'))
        if (manifest.name !== expected.name) return false
        if (expected.version !== undefined && manifest.version !== expected.version) return false
        if (!expected.modules) return false
        // Enumerate the audited module set: the expectation's declared files
        // when present; otherwise every lib/**/*.js under the package root
        // plus the manifest itself, so the digests genuinely cover the bytes.
        const declared = expected.modules
          ? Object.keys(expected.modules)
          : [join(root, 'package.json'), ...walkLibFiles(session, root)]
        if (expectations) {
          // A qualified archive is a closed executable/JSON inventory. New
          // installed files cannot silently inherit an earlier receipt.
          const actual = qualifiedModuleFiles(session, root).sort()
          if (JSON.stringify(actual) !== JSON.stringify(Object.keys(expected.modules).sort())) return false
        }
        const computedDigests: Record<string, string> = {}
        for (const file of declared) {
          const rel = file.startsWith(root + sep) ? file.slice(root.length + 1) : file
          const target = session.realpath(join(root, rel))
          if (!target.startsWith(`${root}${sep}`) || !session.stat(target).isFile()) return false
          const digest = session.fileDigest(target)
          if (expected.modules && expected.modules[rel] !== undefined && expected.modules[rel] !== digest) return false
          computedDigests[rel] = digest
        }
        // Auxiliary libraries may publish distinct CJS/ESM implementations.
        // Both qualified file sets remain authenticated; critical adapter
        // packages retain their one-target dual-lane contract.
        graph.packages.set(expected.name, { root, manifest, files: Object.keys(computedDigests), independentLanes: !!expectations && !CRITICAL_NAMES.includes(expected.name) })
        seen.add(expected.name)
      }
    }
    return expectedPackages.every((entry) => seen.has(entry.name))
      && auditHostDependencyRoutes(graphs, profileRoot, session)
  } catch { return false }
}

function qualifiedModuleFiles(session: HostAuditSession, root: string): string[] {
  if (!session.listDir) throw new Error('qualified inventory reader unavailable')
  const files: string[] = []
  const walk = (directory: string, prefix: string, depth: number): void => {
    if (depth > 32) throw new Error('qualified inventory too deep')
    for (const entry of session.listDir!(directory)) {
      if (entry.name === 'node_modules') continue
      const file = prefix + entry.name, path = join(directory, entry.name)
      if (!entry.isFile && !entry.isDirectory) throw new Error('qualified inventory special file')
      if (entry.isDirectory) walk(path, file + '/', depth + 1)
      else if (/\.(?:[cm]?js|json)$/.test(file)) files.push(file)
      if (files.length > 10000) throw new Error('qualified inventory too large')
    }
  }
  walk(root, '', 0)
  return files
}

/** Every lib JS file below a package root, discovered through the same
 * session reads (realpath/exists/stat) as the rest of the audit. */
function walkLibFiles(session: HostAuditSession, root: string): string[] {
  const found: string[] = []
  const listDir = session.listDir
  if (!listDir) return found
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return
    for (const entry of listDir(dir)) {
      const full = join(dir, entry.name)
      if (entry.isDirectory) walk(full, depth + 1)
      else if (entry.isFile && /\.m?js$/.test(entry.name)) found.push(full)
    }
  }
  walk(join(root, 'lib'), 0)
  return found
}

// The reviewed 0.2.0-rc.2 foreground tools have these exact published bytes
// (the shell renderer bytes are unchanged from rc.1 — that package is not in
// the rc.2 JS-change set, re-verified against the published 0.2.0-rc.2
// tarballs; the bash/pwsh tool descriptions changed, so their bytes moved).
// This is a separate check from npm SRI: a modified installed lib/index.js
// must not inherit the graph's markerless-terminal interpretation.
const AUDITED_FOREGROUND_BYTES: Readonly<Record<string, string>> = {
  '@deepseek-ai/dsh-tool-bash': '0c63a09e4b80ec22db256eac4ecab6f7de3a342e16ec590348a40c5f356eff1a',
  '@deepseek-ai/dsh-tool-pwsh': '1a49cd8de831423a4ae0a2c57a4674a64cec538f64ae603aaa2c388d78aec790',
  '@deepseek-ai/dsh-shell': '6c5aa32fda2d92ef827d949480fd32cb4867f811ce06e875e70c59ab2c9261b1',
}

// The default-workdir route is a separate, narrower attestation than
// foreground-result rendering. It covers the policy's physical root choice
// and the local executor that receives the tool's explicit workdir DTO.
// All five bytes are unchanged from rc.1 (re-verified against the published
// 0.2.0-rc.2 tarballs).
const AUDITED_DEFAULT_WORKDIR_BYTES: Readonly<Record<string, string>> = {
  '@deepseek-ai/dsh-sandbox-policy': '772ca58f0f786d6cb4d839deb621634c31097c13228d81b14e3f3153d0524924',
  '@deepseek-ai/dsh-sandbox': 'b56373befbfcfe281c17c8892e9a4b2cdcb96851290b3ed0ff56b08915e2f743',
  '@deepseek-ai/dsh-bash-sandbox': '0f788f99113ba7411eb33af71cdafabd07b73cf012c1715c819e03f3f77f342d',
  '@deepseek-ai/dsh-bash-local': '6d9b4426b8455198b79de398f57c0f5693e7292411059b66d5ac5eba608b59cb',
  '@deepseek-ai/dsh-pwsh-local': '8b7b57eb7f6c597caa5ee72e4dfd88cec7b5ac51e450ed3521b6b6b29306b88e',
}

// The audited byte maps bind to the audited cohort's exact host version, so
// the renderer identity regex tracks the manifest instead of a hardcoded
// literal that a cohort bump could strand.
const AUDITED_HOST_VERSION_REGEX: string = hostByteAudit.hostVersion.replaceAll('.', '\\.')
export function activeRendererModule(nodeModulesRoot: string, name: string,
  providedSession?: HostAuditSession): { bytes: string; path: string } | undefined {
  const session = providedSession ?? createHostAuditSession()
  const modules = session.realpath(nodeModulesRoot)
  const mapPath = join(modules, '.package-map.json')
  const { records, reachable } = session.memo(`graph:${mapPath}`,
    () => activeGraphRecords(session.readFile(mapPath).toString('utf8')))
  const ids = session.memo(`renderer-ids:${modules}\u0000${name}`, () =>
    [...reachable].filter((id) => id === name || id.startsWith(`${name}@`)))
  if (ids.length !== 1) return undefined
  const id = ids[0]!
  const version = AUDITED_DEFAULT_WORKDIR_BYTES[name] || AUDITED_FOREGROUND_BYTES[name] ? AUDITED_HOST_VERSION_REGEX : undefined
  if (!version || (id !== name && !new RegExp(`^${name.replace('/', '\\/')}@${version}(?:\\(|$)`).test(id))) return undefined
  const url = records[id]?.url
  if (typeof url !== 'string' || (url !== `./${name}` && !url.startsWith('./.pnpm/'))) return undefined
  const root = session.realpath(resolve(modules, url))
  if (!root.startsWith(`${modules}${sep}`)) return undefined
  const manifest = session.readJson(join(root, 'package.json'))
  if (manifest.name !== name || typeof manifest.version !== 'string' || !satisfiesSupportedHostRange(manifest.version)) return undefined
  if (id !== name && manifest.version !== id.slice(name.length + 1).split('(', 1)[0]) return undefined
  const bytesPath = join(root, 'lib', 'index.js')
  const target = session.realpath(bytesPath)
  if (!target.startsWith(`${root}${sep}`) || !session.stat(target).isFile()) return undefined
  return { bytes: session.fileDigest(target), path: target }
}

function activeRendererBytes(nodeModulesRoot: string, name: string, session?: HostAuditSession): string | undefined {
  return activeRendererModule(nodeModulesRoot, name, session)?.bytes
}

function selectedRuntimeRenderer(runtimeRoot: string, name: string, session: HostAuditSession): { bytes: string; path: string } | undefined {
  if (!session.stat(runtimeRoot).isFile()) return activeRendererModule(join(runtimeRoot, 'node_modules'), name, session)
  const index = session.memo(`desktop-index:${runtimeRoot}`, () => readAsarIndex(runtimeRoot))
  const entry = `dsh/node_modules/${name}/lib/index.js`
  try {
    const bytes = session.memo(`desktop-renderer:${runtimeRoot}\0${name}`, () => readAsarFile(runtimeRoot, index, entry))
    return { bytes: createHash('sha256').update(bytes).digest('hex'), path: join(runtimeRoot, 'dsh', 'node_modules', name, 'lib', 'index.js') }
  } catch { return undefined }
}

/** Verify active, reachable producer bytes without reading credentials or
 * accepting historical package-map entries. Missing/ambiguous paths fail
 * closed for the ordinary markerless-test shortcut. */
export function auditedForegroundRenderers(runtimeRoot: string, profileRoot: string,
  providedSession?: HostAuditSession): Array<'bash' | 'pwsh'> {
  const session = providedSession ?? createHostAuditSession()
  const roots = [join(runtimeRoot, 'node_modules'), join(profileRoot, 'node_modules')]
  const checked = (name: string): boolean => {
    const found: string[] = []
    for (const root of roots) {
      try {
        const value = root === roots[0] ? selectedRuntimeRenderer(runtimeRoot, name, session)?.bytes : activeRendererBytes(root, name, session)
        if (value) found.push(value)
      } catch { /* package absent in this half of the active graph */ }
    }
    return found.length > 0 && found.every((value) => value === AUDITED_FOREGROUND_BYTES[name])
  }
  if (!checked('@deepseek-ai/dsh-shell')) return []
  return [
    ...(checked('@deepseek-ai/dsh-tool-bash') ? ['bash' as const] : []),
    ...(checked('@deepseek-ai/dsh-tool-pwsh') ? ['pwsh' as const] : []),
  ]
}

/** Exact active implementation route for call-time omitted-workdir evidence. */
export function auditedDefaultWorkdirHost(runtimeRoot: string, profileRoot: string,
  tool: 'bash' | 'pwsh', providedSession?: HostAuditSession): boolean {
  const session = providedSession ?? createHostAuditSession()
  if (!auditedForegroundRenderers(runtimeRoot, profileRoot, session).includes(tool)) return false
  const names = tool === 'bash'
    ? ['@deepseek-ai/dsh-sandbox-policy', '@deepseek-ai/dsh-sandbox',
      '@deepseek-ai/dsh-bash-sandbox', '@deepseek-ai/dsh-bash-local']
    : ['@deepseek-ai/dsh-pwsh-local']
  for (const name of names) {
    const found: string[] = []
    for (const root of [runtimeRoot, profileRoot]) {
      try {
        const digest = root === runtimeRoot ? selectedRuntimeRenderer(runtimeRoot, name, session)?.bytes : activeRendererBytes(join(root, 'node_modules'), name, session)
        if (digest) found.push(digest)
      } catch { /* package absent in this half of the graph */ }
    }
    if (!found.length || !found.every((digest) => digest === AUDITED_DEFAULT_WORKDIR_BYTES[name])) return false
  }
  return true
}

/**
 * The active graph alone does not prove which shell service this Agent uses.
 * Match the scoped service's exact constructor to the audited active module,
 * rejecting another provider with the same public service interface/name.
 */
export async function auditedDefaultWorkdirProvider(runtimeRoot: string, profileRoot: string,
  tool: 'bash' | 'pwsh', provider: unknown, policyProvider?: unknown,
  providedSession?: HostAuditSession): Promise<boolean> {
  const session = providedSession ?? createHostAuditSession()
  if (!auditedDefaultWorkdirHost(runtimeRoot, profileRoot, tool, session)
    || !provider || typeof provider !== 'object') return false
  const matchesActiveClass = async (name: string, exportName: string, value: unknown): Promise<boolean> => {
    if (!value || typeof value !== 'object') return false
    const paths = new Set<string>()
    for (const root of [runtimeRoot, profileRoot]) {
      try {
        const module = root === runtimeRoot ? selectedRuntimeRenderer(runtimeRoot, name, session) : activeRendererModule(join(root, 'node_modules'), name, session)
        if (module?.bytes === AUDITED_DEFAULT_WORKDIR_BYTES[name]) paths.add(module.path)
      } catch { /* absent active package in this graph half */ }
    }
    // Two distinct active modules are ambiguous even when their files match.
    if (paths.size !== 1) return false
    try {
      const module = await import(pathToFileURL([...paths][0]!).href) as Record<string, unknown>
      // Cordis returns a scoped traceable proxy for Service instances. Its
      // original symbol yields the active provider fiber's underlying value.
      const original = (value as Record<symbol, unknown>)[Symbol.for('cordis.original')]
      const active = original && typeof original === 'object' ? original : value
      return typeof module[exportName] === 'function'
        && (active as { constructor?: unknown }).constructor === module[exportName]
    } catch { return false }
  }
  const shell = tool === 'bash'
    ? await matchesActiveClass('@deepseek-ai/dsh-bash-sandbox', 'SandboxBashExecutor', provider)
    : await matchesActiveClass('@deepseek-ai/dsh-pwsh-local', 'PwshLocalExecutor', provider)
  return shell && (tool === 'pwsh'
    || await matchesActiveClass('@deepseek-ai/dsh-sandbox-policy', 'SandboxPolicyService', policyProvider))
}

export interface TargetHostGraph {
  packages: PackageRow[]
  profileGraph: {
    state: 'active_importer' | 'dependency_free_headless'
    manifestSha256?: string
    bundles?: PackageRow[]
  }
}

function pathPresent(path: string): boolean {
  try { lstatSync(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function within(root: string, path: string): boolean {
  return path.startsWith(`${root}${sep}`)
}

/** Same static lookup order as DSH; do not load/normalize/heal a daily profile. */
function packageFromAnchor(anchor: string, name: string): string | undefined {
  for (const directory of createRequire(anchor).resolve.paths(name) ?? []) {
    const candidate = join(directory, name)
    if (pathPresent(candidate)) {
      // A dangling or malformed first entry is not a reason to try a fallback.
      if (!existsSync(join(candidate, 'package.json'))) {
        throw new HostProfileError('target_bundle_unresolved', 'invalid resolver-visible package')
      }
      return realpathSync(candidate)
    }
  }
  return undefined
}

/**
 * Pre-install inspection only. A fresh rc.1 Headless profile can use its two
 * installation-owned bundles without a private importer. Never extend this
 * absence rule to inject or runtime replay, which still call the strict reader.
 */
function readTargetHostGraph(runtimeRoot: string, profileRoot: string): TargetHostGraph {
  const runtime = realpathSync(runtimeRoot)
  const profile = realpathSync(profileRoot)
  const mapPath = join(profile, 'node_modules', '.package-map.json')
  const lockPath = join(profile, 'pnpm-lock.yaml')
  if (pathPresent(mapPath) && pathPresent(lockPath)) {
    return { packages: readActiveHostGraph(runtime, profile), profileGraph: { state: 'active_importer' } }
  }
  if (pathPresent(mapPath) || pathPresent(lockPath)) {
    throw new HostProfileError('active_graph_missing', 'partial profile importer')
  }
  if (pathPresent(join(profile, 'node_modules')) || pathPresent(join(profile, '.dsh-module-fallback'))) {
    throw new HostProfileError('target_profile_unmanaged_modules', 'profile modules exist without an importer')
  }
  const manifestPath = join(profile, 'package.json')
  const manifest = readJsonObject(manifestPath, 'profile_manifest_invalid')
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies']) {
    const value = manifest[key]
    if (value !== undefined && (!value || typeof value !== 'object' || Object.keys(value).length !== 0 || (Array.isArray(value) && !['bundledDependencies', 'bundleDependencies'].includes(key)))) {
      throw new HostProfileError('target_profile_dependency_uninstalled', 'profile declares dependencies without an importer')
    }
  }
  const dsh = manifest.dsh as { profile?: { bundles?: unknown } } | undefined
  const bundles = dsh?.profile?.bundles
  // rc.2 ships two exact Headless tuples: the classic template and the
  // installation-owned tuple that also carries the web app bundle (which the
  // installation ships anyway). Anything else is not the Headless target.
  const names = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']
  const installationOwned = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless']
  const bundleList = Array.isArray(bundles) ? bundles.map(String) : undefined
  if (!bundleList || (JSON.stringify(bundleList) !== JSON.stringify(names) && JSON.stringify(bundleList) !== JSON.stringify(installationOwned))) {
    throw new HostProfileError('target_profile_bundles_unsupported', 'not the installation-owned Headless bundle tuple')
  }
  const modules = realpathSync(join(runtime, 'node_modules'))
  const mapText = readFileSync(join(modules, '.package-map.json'), 'utf8')
  const lockText = readFileSync(join(runtime, 'pnpm-lock.yaml'), 'utf8')
  const rows = packageRowsFromActiveGraph(mapText, lockText, modules)
  const { records, reachable } = activeGraphRecords(mapText)
  const launcher = realpathSync(join(modules, '@deepseek-ai', 'dsh'))
  const anchor = join(launcher, 'package.json')
  const host = readJsonObject(anchor, 'target_runtime_unsupported')
  // pnpm's hoisted map uses bare package names; the installed manifest and
  // exact mapped realpath below remain authoritative for either key shape.
  const launcherId = [...reachable].filter((id) => id === '@deepseek-ai/dsh' || id.startsWith('@deepseek-ai/dsh@'))
  if (launcherId.length !== 1 || host.name !== '@deepseek-ai/dsh' || host.version !== rows.find((row) => row.name === '@deepseek-ai/dsh')?.version
    || typeof records[launcherId[0]].url !== 'string'
    || realpathSync(resolve(modules, records[launcherId[0]].url as string)) !== launcher || !within(modules, launcher)) {
    throw new HostProfileError('target_runtime_unsupported', 'launcher differs from the active runtime importer')
  }
  const bundleRows = names.map((name): PackageRow => {
    const packageRoot = packageFromAnchor(anchor, name)
    const ids = [...reachable].filter((id) => id === name || id.startsWith(`${name}@`))
    if (!packageRoot || !within(modules, packageRoot) || ids.length !== 1) {
      throw new HostProfileError('target_bundle_unresolved', 'bundle is not uniquely installation-owned')
    }
    const record = records[ids[0]]
    if (typeof record.url !== 'string' || realpathSync(resolve(modules, record.url)) !== packageRoot) {
      throw new HostProfileError('target_bundle_origin_mismatch', 'bundle differs from active runtime mapping')
    }
    const installed = readJsonObject(join(packageRoot, 'package.json'), 'target_bundle_invalid')
    const bundle = installed.dsh as { bundle?: { patch?: unknown } } | undefined
    const patch = bundle?.bundle?.patch
    const locked = packageRowsFromPnpmLock(lockText, [name])
      .filter((row) => row.version === host.version && row.integrity)
    if (installed.name !== name || installed.version !== host.version || locked.length !== 1
      || (ids[0] !== name && ids[0].split('(', 1)[0] !== `${name}@${host.version}`)
      || typeof patch !== 'string' || isAbsolute(patch) || !within(packageRoot, realpathSync(resolve(packageRoot, patch)))
      || !statSync(resolve(packageRoot, patch)).isFile()) {
      throw new HostProfileError('target_bundle_invalid', 'bundle identity or patch is not installation-owned')
    }
    return locked[0]
  })
  // A parent module fallback is optional before first boot. If one is visible,
  // it must point at the same installed packages; never trust a foreign shadow.
  for (const name of [...CRITICAL_NAMES, ...names]) {
    const visible = packageFromAnchor(manifestPath, name)
    if (!visible) continue
    const ids = [...reachable].filter((id) => id === name || id.startsWith(`${name}@`))
    if (ids.length !== 1 || typeof records[ids[0]].url !== 'string'
      || !within(modules, visible) || realpathSync(resolve(modules, records[ids[0]].url as string)) !== visible) {
      throw new HostProfileError('target_profile_module_shadow', 'profile lookup differs from the audited installation')
    }
  }
  return {
    packages: rows,
    profileGraph: {
      state: 'dependency_free_headless',
      manifestSha256: createHash('sha256').update(readFileSync(manifestPath)).digest('hex'),
      bundles: bundleRows,
    },
  }
}

/** The pre-install path consumes the same qualified identities and byte/route
 * audit as active-profile entries; structural discovery grants no authority. */
export function inspectTargetHostGraph(runtime: string, profile: string, trust?: HostRebindTrust): TargetHostGraph {
  const target = readTargetHostGraph(runtime, profile)
  const evaluation = evaluateConfiguredHostLock(target.packages, {
    platform: process.platform === 'win32' ? 'windows' : 'posix',
    ...(target.profileGraph.state === 'dependency_free_headless' ? { profileKind: 'headless' as const } : {}),
  }, trust ? JSON.stringify(trust) : undefined, profile)
  const expectations = trust ? [...trust.packages, ...(trust.probeDependencies ?? [])] : undefined
  if (evaluation.status !== 'supported' || !auditedHostImplementation(runtime, profile, undefined, expectations)) {
    throw new HostProfileError('target_runtime_unsupported', 'pre-install target fails host qualification or byte/route audit')
  }
  return target
}
export async function prepareTargetHostTrust(runtime: string, profile: string, fetcher: typeof fetch = fetch): Promise<HostRebindTrust> {
  return acquireHostTrust(readTargetHostGraph(runtime, profile).packages, fetcher, {
    profileRoot: profile, dependencyIdentity: (name, importer) => probeDependencyIdentity(runtime, profile, name, importer),
  })
}

/** Read and validate the actual runtime graph plus the installed profile plugin. */
export function resolveActiveProfileHostLock(
  runtimeRoot: string,
  profileRoot: string,
  expectedPluginVersion: string,
  providedTrust?: HostRebindTrust,
): ActiveProfileHostLock {
  const runtime = resolve(runtimeRoot)
  const profile = resolve(profileRoot)
  // Desktop identity comes first: the Desktop-owned profile carries the Web
  // app bundle too, so any bundle-based inference would misidentify it.
  const desktopCheckManifestPath = join(profile, 'package.json')
  if (existsSync(desktopCheckManifestPath)) {
    const manifest = readJsonObject(desktopCheckManifestPath, 'profile_manifest_invalid')
    if (manifest.name === DESKTOP_PROFILE_PACKAGE_NAME) {
      return resolveDesktopProfileHostLock(runtimeRoot, profileRoot, expectedPluginVersion, providedTrust)
    }
  }
  const lockPath = join(runtime, 'pnpm-lock.yaml')
  const mapPath = join(runtime, 'node_modules', '.package-map.json')
  const profileManifestPath = join(profile, 'package.json')
  const pluginManifestPath = join(profile, 'node_modules', 'dsh-completion-guard', 'package.json')
  const profileLockPath = join(profile, 'pnpm-lock.yaml')
  const profileMapPath = join(profile, 'node_modules', '.package-map.json')
  for (const path of [lockPath, mapPath, profileLockPath, profileMapPath, profileManifestPath, pluginManifestPath]) {
    if (!existsSync(path)) throw new HostProfileError('active_graph_missing', `required active graph file is missing: ${path}`)
  }
  const session = createHostAuditSession()
  const trust = providedTrust ? qualifyHostTrust(providedTrust, profile) : undefined
  const profileManifest = readJsonObject(profileManifestPath, 'profile_manifest_invalid')
  const installedPlugin = readJsonObject(pluginManifestPath, 'installed_plugin_invalid')
  const dependencies = profileManifest.dependencies
  const profileConfig = profileManifest.dsh && typeof profileManifest.dsh === 'object'
    ? (profileManifest.dsh as Record<string, unknown>).profile
    : undefined
  const bundles = profileConfig && typeof profileConfig === 'object' ? (profileConfig as Record<string, unknown>).bundles : undefined
  if (!dependencies || typeof dependencies !== 'object'
    || typeof (dependencies as Record<string, unknown>)['dsh-completion-guard'] !== 'string'
    || !Array.isArray(bundles) || !bundles.includes('dsh-completion-guard')) {
    throw new HostProfileError('profile_plugin_unbound', 'profile does not bind the dsh-completion-guard dependency and bundle')
  }
  if (installedPlugin.name !== 'dsh-completion-guard' || installedPlugin.version !== expectedPluginVersion) {
    throw new HostProfileError('profile_plugin_version_mismatch', 'installed profile plugin identity does not match the generator version')
  }
  // Profile identity: the official Desktop name wins (its bundle list also
  // contains the web app, so web markers must never shadow it) and is
  // dispatched to the dedicated Desktop resolver above, so it never reaches
  // the CLI-managed inference here. The headless marker beats web markers
  // because the rc.2 installation-owned headless tuple carries the web app
  // too; dshmarket/web-app then mean web for the non-Desktop profiles.
  const bundleList = Array.isArray(bundles) ? bundles.map(String) : []
  const isDesktopProfile = profileManifest.name === DESKTOP_PROFILE_PACKAGE_NAME
  const profileKind: HostProfileKind = isDesktopProfile
    ? 'desktop'
    : bundleList.includes('@deepseek-ai/dsh-headless')
      ? 'headless'
      : bundleList.includes('@deepseek-ai/dsh-web-app') || bundleList.includes('dshmarket') ? 'web' : 'headless'
  const platform: HostPlatform = process.platform === 'win32' ? 'windows' : 'posix'
  const evaluation = evaluateActiveHostLock(runtime, profile, { platform, profileKind }, session, trust ? JSON.stringify(trust) : undefined)
  if (evaluation.status !== 'supported') {
    throw new HostProfileError(evaluation.reasonCode === 'host_lock_installed_graph_drift' ? 'host_implementation_bytes_mismatch' : evaluation.reasonCode ?? 'active_graph_unavailable',
      evaluation.reasonCode === 'host_lock_installed_graph_drift' ? 'reachable host modules differ from the qualified published implementation' : 'active runtime graph does not match the supported host manifest')
  }
  return { evaluation, runtimeRoot: runtime, profileRoot: profile, pluginVersion: expectedPluginVersion, platform, profileKind, ...(trust ? { trust } : {}) }
}

function asarRowsWithIntegrity(runtime: DesktopAppRuntime, source: readonly { name: string; version: string; integrity: string }[]): PackageRow[] {
  // The asar manifest declares name+version only; the integrity bound into
  // the evaluation is the ACQUIRED registry identity for exactly that
  // name@version — a row the acquisition never qualified fails closed.
  const byName = new Map(source.map((row) => [row.name, row]))
  return runtime.rows.map((row) => {
    const qualified = byName.get(row.name)
    if (!qualified || qualified.version !== row.version) {
      throw new HostProfileError('desktop_runtime_unqualified', `the app runtime row ${row.name}@${row.version} has no acquired registry identity`)
    }
    return { name: row.name, version: row.version, integrity: qualified.integrity }
  })
}

function desktopProfileRows(profileRoot: string, session?: HostAuditSession): PackageRow[] {
  // When the app's plugin manager has installed plugins, the profile half of
  // the graph is a real importer; read it with the strict standard reader.
  // A dependency-free desktop profile contributes no rows of its own.
  const auditSession = session ?? createHostAuditSession()
  const lockPath = join(profileRoot, 'pnpm-lock.yaml')
  const layout = desktopProfileLayout(profileRoot, auditSession)
  if (!layout && !existsSync(lockPath)) return []
  if (!layout || !existsSync(lockPath)) throw new HostProfileError('active_graph_missing', 'partial desktop profile importer')
  const graph = layout.graph
  return packageRowsFromGraph(graph.records, graph.reachable, auditSession.readFile(lockPath).toString('utf8'), join(profileRoot, 'node_modules'), auditSession)
}

function desktopProfileLayout(profile: string, session: HostAuditSession):
  { graph: DependencyAuditGraph; identityPath: string; kind: string } | undefined {
  return session.memo(`desktop-profile-layout:${profile}`, () => {
    const modules = join(profile, 'node_modules'), mapPath = join(modules, '.package-map.json')
    if (session.exists(mapPath)) {
      const parsed = activeGraphRecords(session.readFile(mapPath).toString('utf8'))
      return { graph: { ...parsed, modules: session.realpath(modules), packages: new Map() }, identityPath: mapPath, kind: 'package-map' }
    }
    const metadataPath = join(modules, '.modules.yaml')
    if (!session.exists(metadataPath)) return undefined
    try {
      return { graph: desktopHoistedProfileGraph(profile, session), identityPath: metadataPath, kind: 'pnpm-11.7-hoisted' }
    } catch {
      throw new HostProfileError('active_graph_invalid', 'Desktop physical importer index does not match its installed tree')
    }
  })
}

/** Complete Desktop composition: the official app bundle is the runtime half,
 * the Desktop-managed profile is the profile half. No structural discovery
 * grants authority — the installed asar bytes are verified against the same
 * qualification chain a CLI graph rebind uses. */
export function resolveDesktopProfileHostLock(
  appAsarPath: string,
  profileRoot: string,
  expectedPluginVersion: string,
  providedTrust?: HostRebindTrust,
): ActiveProfileHostLock {
  const profile = resolve(profileRoot)
  const runtime = readDesktopAppRuntime(appAsarPath)
  const trust = providedTrust ? qualifyHostTrust(providedTrust, profile) : undefined
  verifyDesktopPluginIdentity(profile, expectedPluginVersion)
  const evaluation = reevaluateDesktopCoreLock(appAsarPath, profileRoot, trust)
  if (evaluation.status !== 'supported') throw new HostProfileError('host_implementation_bytes_mismatch',
    'the Desktop graph does not match the qualified published implementation')
  writeDesktopRuntimeReceipt(profile, runtime)
  return { evaluation, runtimeRoot: runtime.asarRealpath, profileRoot: profile, pluginVersion: expectedPluginVersion, platform: process.platform === 'win32' ? 'windows' : 'posix', profileKind: 'desktop', ...(trust ? { trust } : {}) }
}

/** An active Desktop lock requires a real installed Guard importer. The
 * dependency-free application-owned profile has its own preinstall path. */
function verifyDesktopPluginIdentity(profileRoot: string, expectedPluginVersion: string): void {
  const importerMap = join(profileRoot, 'node_modules', '.package-map.json')
  if (!existsSync(importerMap) && !existsSync(join(profileRoot, 'node_modules', '.modules.yaml'))) {
    throw new HostProfileError('profile_plugin_unbound', 'the desktop profile has no installed plugin importer')
  }
  const profile = readJsonObject(join(profileRoot, 'package.json'), 'profile_manifest_invalid')
  const dsh = profile.dsh && typeof profile.dsh === 'object' ? profile.dsh as Record<string, unknown> : {}
  const settings = dsh.profile && typeof dsh.profile === 'object' ? dsh.profile as Record<string, unknown> : {}
  const bundles = Array.isArray(settings.bundles) ? settings.bundles : []
  const dependencies = profile.dependencies && typeof profile.dependencies === 'object' ? profile.dependencies as Record<string, unknown> : {}
  // The Desktop identity requires the official bundle tuple bound to the
  // installed plugin. Third-party profile plugins such as dshmarket are
  // ordinary profile imports: their package name neither conflicts with the
  // Desktop tuple nor grants any trust — graph, byte and route audits still
  // cover everything they introduce.
  if (profile.name !== DESKTOP_PROFILE_PACKAGE_NAME || typeof dependencies['dsh-completion-guard'] !== 'string'
    || !bundles.includes('dsh-completion-guard') || !bundles.includes('@deepseek-ai/dsh-base')
    || !bundles.includes('@deepseek-ai/dsh-web-app') || bundles.includes('@deepseek-ai/dsh-headless')) {
    throw new HostProfileError('profile_plugin_unbound', 'the desktop profile does not bind the installed plugin and official bundles')
  }
  const pluginManifestPath = join(profileRoot, 'node_modules', 'dsh-completion-guard', 'package.json')
  if (!existsSync(pluginManifestPath)) {
    throw new HostProfileError('profile_plugin_unbound', 'the desktop profile importer does not carry the dsh-completion-guard plugin')
  }
  const installedPlugin = readJsonObject(pluginManifestPath, 'installed_plugin_invalid')
  if (installedPlugin.name !== 'dsh-completion-guard' || installedPlugin.version !== expectedPluginVersion) {
    throw new HostProfileError('profile_plugin_version_mismatch', 'installed profile plugin identity does not match the generator version')
  }
}

/** One desktop evaluation: graph readback (app rows + profile importer rows),
 * qualification, and the installed-byte audit. Shared by inject and every
 * fresh runtime revalidation, so both compute the same digest. */
function reevaluateDesktopCoreLock(appAsarPath: string, profileRoot: string,
  trust: HostRebindTrust | undefined): HostLockEvaluation {
  const profile = resolve(profileRoot)
  const session = createHostAuditSession()
  // CG-083-PERF03: ONE operation-scoped audit session for the whole desktop
  // validation — runtime identity, byte audit, archive graph, physical layout
  // and renderer audit share the same memoized asar index/bytes/digests. The
  // session dies with this validation; no result crosses an entry boundary.
  const runtime = readDesktopAppRuntime(appAsarPath, session)
  const executable = verifyDesktopCarrier(runtime.asarRealpath, runtime.headerSha256)
  const pluginManifestPath = join(profile, 'node_modules', 'dsh-completion-guard', 'package.json')
  const installedPlugin = session.readJson(pluginManifestPath)
  verifyDesktopPluginIdentity(profile, String(installedPlugin.version))
  const profileRows = desktopProfileRows(profile, session)
  const runtimeRows = asarRowsWithIntegrity(runtime, trust ? [...trust.packages, ...(trust.probeDependencies ?? [])] : cohortIntegrityRows(runtime))
  const runtimeKeys = new Set(runtimeRows.map((row) => `${row.name}\u0000${row.version ?? ''}\u0000${row.integrity ?? ''}`))
  const rows = [...runtimeRows, ...profileRows.filter((row) => !runtimeKeys.has(`${row.name}\u0000${row.version ?? ''}\u0000${row.integrity ?? ''}`))]
  const platform: HostPlatform = process.platform === 'win32' ? 'windows' : 'posix'
  const evaluation = evaluateConfiguredHostLock(rows, { platform, profileKind: 'desktop' }, trust ? JSON.stringify(trust) : undefined, profile)
  if (evaluation.status !== 'supported') return evaluation
  const expectations = trust ? [...trust.packages, ...(trust.probeDependencies ?? [])] : hostByteAudit.packages as unknown as readonly AuditedPackageExpectation[]
  if (!auditDesktopInstalledImplementation(runtime.asarRealpath, expectations, session)) {
    return { ...evaluation, status: 'unsupported', goalAvailable: false, reasonCode: 'host_lock_installed_graph_drift' }
  }
  const archiveGraph = desktopDependencyGraph(runtime.asarRealpath, expectations, session)
  const layout = desktopProfileLayout(profile, session)!
  if (!auditedHostImplementation(join(runtime.asarRealpath, 'dsh'), profile, archiveGraph.session, expectations, archiveGraph.graph, layout.graph)) {
    return { ...evaluation, status: 'unsupported', goalAvailable: false, reasonCode: 'host_lock_installed_graph_drift' }
  }
  // Runtime and profile identity must survive fresh validation: a changed app
  // header, metadata, manifest, archive path or profile is a different lock.
  const profileManifest = session.fileDigest(join(profile, 'package.json'))
  const digest = createHash('sha256').update('dsh.desktop-core-host/v1\0')
    .update(evaluation.digest).update('\0').update(runtime.asarRealpath).update('\0')
    .update(runtime.headerSha256).update('\0').update(runtime.manifestSha256).update('\0')
    .update(runtime.metadataSha256).update('\0').update(executable).update('\0').update(session.fileDigest(executable)).update('\0')
    .update(profile).update('\0').update(profileManifest).update('\0')
    .update(session.fileDigest(pluginManifestPath)).update('\0')
    .update(layout.kind).update('\0').update(session.fileDigest(layout.identityPath)).update('\0')
    .update(session.fileDigest(join(profile, 'pnpm-lock.yaml'))).digest('hex')
  const audited = auditedForegroundRenderers(runtime.asarRealpath, profile, session)
  return audited.length ? { ...evaluation, auditedForegroundRenderers: audited,
    digest: createHash('sha256').update(`dsh.core-host-renderer/v1\0${digest}\0${audited.join(',')}`).digest('hex') } : { ...evaluation, digest }
}

/** The audited cohort rows, used as the registry-derived expectation source
 * when no operator trust is supplied. A runtime row whose version the audited
 * cohort never registered cannot be attested this way and fails closed. */
function cohortIntegrityRows(runtime: DesktopAppRuntime): Array<{ name: string; version: string; integrity: string }> {
  const auditRows = new Map(hostByteAudit.packages.map((row) => [row.name as string, row as unknown as { name: string; version: string; integrity: string }]))
  return runtime.rows.map((row) => {
    const audited = auditRows.get(row.name)
    if (!audited || audited.version !== row.version) {
      throw new HostProfileError('desktop_runtime_unqualified', `the app runtime row ${row.name}@${row.version} is not the audited cohort identity; acquire registry trust to qualify it`)
    }
    return audited
  })
}

/** Desktop pre-install inspection: the Desktop-owned dependency-free profile
 * plus the official app bundle, evaluated and byte-audited like any target. */
export function inspectDesktopTargetGraph(appAsarPath: string, profileRoot: string, trust?: HostRebindTrust): { packages: PackageRow[]; runtime: DesktopAppRuntime; profileGraph: { state: 'dependency_free_desktop'; manifestSha256: string; bundles: string[] } } {
  const target = readDesktopTargetGraph(appAsarPath, profileRoot)
  verifyDesktopCarrier(target.runtime.asarRealpath, target.runtime.headerSha256)
  const runtimeRows = asarRowsWithIntegrity(target.runtime, trust ? [...trust.packages, ...(trust.probeDependencies ?? [])] : cohortIntegrityRows(target.runtime))
  const evaluation = evaluateConfiguredHostLock(runtimeRows, {
    platform: process.platform === 'win32' ? 'windows' : 'posix',
    profileKind: 'desktop',
  }, trust ? JSON.stringify(trust) : undefined, profileRoot)
  const expectations = trust ? [...trust.packages, ...(trust.probeDependencies ?? [])] : hostByteAudit.packages as unknown as readonly AuditedPackageExpectation[]
  if (evaluation.status !== 'supported' || !auditDesktopInstalledImplementation(target.runtime.asarRealpath, expectations)) {
    throw new HostProfileError('target_runtime_unsupported', 'desktop pre-install target fails host qualification or byte audit')
  }
  const archiveGraph = desktopDependencyGraph(target.runtime.asarRealpath, expectations)
  if (!auditedHostImplementation(join(target.runtime.asarRealpath, 'dsh'), resolve(profileRoot), archiveGraph.session, expectations, archiveGraph.graph)) {
    throw new HostProfileError('target_runtime_unsupported', 'desktop pre-install target fails dependency route audit')
  }
  return { packages: runtimeRows, runtime: target.runtime, profileGraph: target.profileGraph }
}

/** Fresh runtime readback for an injected desktop lock: the same evaluation
 * chain the inject path used, so the digest the runtime compares against its
 * injected expectation is computed identically. */
export function revalidateDesktopCoreLock(appAsarPath: string, profileRoot: string,
  expected: HostLockEvaluation, trustText?: string): HostLockEvaluation {
  void expected
  const trust = trustText ? parseHostTrust(trustText, resolve(profileRoot)) : undefined
  return reevaluateDesktopCoreLock(appAsarPath, profileRoot, trust)
}

/** Registry acquisition for the Desktop graph: the app manifest pins exact
 * versions; the INTEGRITY comes from the registry metadata for exactly that
 * name@version, and the archive bytes are verified by the same acquisition
 * and host-contract probe a CLI rebind uses. */
export async function prepareDesktopHostTrust(appAsarPath: string, profileRoot: string,
  fetcher: typeof fetch = fetch): Promise<HostRebindTrust> {
  const runtime = readDesktopAppRuntime(appAsarPath)
  const qualified: PackageRow[] = []
  for (const row of runtime.rows) {
    if (!row.version) throw new HostTrustError('host_trust_identity_invalid')
    const response = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(row.name)}/${encodeURIComponent(row.version)}`,
      { signal: AbortSignal.timeout(30_000), redirect: 'error' })
    if (!response.ok) throw new HostTrustError('host_trust_registry_unavailable')
    const metadata = await response.json() as { name?: string; version?: string; dist?: { integrity?: string } }
    const integrity = metadata.dist?.integrity
    if (metadata.name !== row.name || metadata.version !== row.version || typeof integrity !== 'string') {
      throw new HostTrustError('host_trust_registry_identity_mismatch')
    }
    qualified.push({ name: row.name, version: row.version, integrity })
  }
  return acquireHostTrust(qualified, fetcher, {
    profileRoot,
    // Every probe dependency the consumed adapters import resolves from the
    // same official app graph, by exact top-level manifest identity.
    dependencyIdentity: (name) => readDesktopDependency(appAsarPath, name),
  })
}

function readJsonObject(path: string, code: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    // The bounded code below is the public diagnostic; parser details may
    // include paths or implementation-specific text and are not propagated.
  }
  throw new HostProfileError(code, `invalid JSON object: ${path}`)
}

function yamlQuote(value: string): string {
  return JSON.stringify(value)
}

function renderManagedPatch(
  rows: readonly PackageRow[],
  platform: HostPlatform,
  profileKind: HostProfileKind,
  activation?: string,
  runtimeRoot?: string,
  profileRoot?: string,
  trust?: HostRebindTrust,
  desktopDigest?: string,
): string {
  const lines = [HOST_LOCK_MARKER_BEGIN, '- id: context-guard', '  name: dsh-completion-guard', '  config:']
  lines.push('    hostLockPolicy: "dsh-core/v1"')
  if (runtimeRoot) lines.push(`    hostLockRuntimeRoot: ${yamlQuote(runtimeRoot)}`)
  if (profileRoot) lines.push(`    hostLockProfileRoot: ${yamlQuote(profileRoot)}`)
  if (activation) lines.push(`    activation: ${yamlQuote(activation)}`)
  lines.push(`    hostLockPlatform: ${yamlQuote(platform)}`)
  lines.push(`    hostLockProfile: ${yamlQuote(profileKind)}`)
  if (trust) lines.push(`    hostLockTrust: ${yamlQuote(JSON.stringify(trust))}`)
  if (profileKind === 'desktop' && desktopDigest) lines.push(`    hostLockDesktopDigest: ${yamlQuote(desktopDigest)}`)
  lines.push('    hostLockPackages:')
  for (const row of rows) {
    lines.push(`      - name: ${yamlQuote(row.name)}`)
    lines.push(`        version: ${yamlQuote(row.version ?? '')}`)
    lines.push(`        integrity: ${yamlQuote(row.integrity ?? '')}`)
  }
  lines.push(HOST_LOCK_MARKER_END)
  return `${lines.join('\n')}\n`
}

function stripManagedPatch(text: string): { base: string; prior?: string } {
  const begin = text.indexOf(HOST_LOCK_MARKER_BEGIN)
  const end = text.indexOf(HOST_LOCK_MARKER_END)
  if (begin < 0 && end < 0) return { base: text }
  if (begin < 0 || end < begin || text.indexOf(HOST_LOCK_MARKER_BEGIN, begin + 1) >= 0 || text.indexOf(HOST_LOCK_MARKER_END, end + 1) >= 0) {
    throw new HostProfileError('profile_patch_marker_invalid', 'managed host-lock marker is missing or duplicated')
  }
  const after = end + HOST_LOCK_MARKER_END.length
  const prior = text.slice(begin, after)
  return { base: `${text.slice(0, begin).trimEnd()}\n${text.slice(after).trimStart()}`, prior }
}

function activationFromPatch(text: string): string | undefined {
  const lines = text.split(/\r?\n/)
  const starts = lines.flatMap((line, index) => /^- id:\s*["']?context-guard["']?\s*$/.test(line) ? [index] : [])
  const entries = starts.map((start) => {
    let end = lines.length
    for (let index = start + 1; index < lines.length; index += 1) {
      if (lines[index].startsWith('- ')) { end = index; break }
    }
    return lines.slice(start + 1, end).join('\n')
  }).filter((entry) => {
    // A separate disabled-only override cannot change activation or host-lock
    // identity. Preserve it byte-for-byte in the base patch, including order.
    const fields = entry.split(/\r?\n/).filter((line) => line.trim() && !line.trimStart().startsWith('#'))
    return !(fields.length === 1 && /^ {2}disabled:\s*(?:true|false)\s*(?:#.*)?$/.test(fields[0]))
  })
  if (entries.length > 1) throw new HostProfileError('profile_patch_duplicate_target', 'multiple unmanaged context-guard configurations are ambiguous')
  if (entries.length === 0) return undefined
  const entry = entries[0]
  const name = entry.match(/^\s{2}name:\s*(.+?)\s*$/m)?.[1]?.replace(/^['"]|['"]$/g, '')
  if (name && name !== 'dsh-completion-guard') throw new HostProfileError('profile_patch_name_mismatch', 'context-guard patch targets a different package')
  if (/^\s{4}hostLockPackages:\s*$/m.test(entry)) {
    throw new HostProfileError('profile_patch_unmanaged_host_lock', 'unmanaged hostLockPackages must be removed before managed injection')
  }
  const value = entry.match(/^\s{4}activation:\s*(.+?)\s*$/m)?.[1]
  return value?.replace(/^['"]|['"]$/g, '')
}

function activationFromManagedPatch(text: string): string | undefined {
  const value = text.match(/^\s{4}activation:\s*(.+?)\s*$/m)?.[1]
  return value ? parseYamlScalar(value) : undefined
}

/** Preserve template comments while replacing a sole top-level `[]` sentinel. */
function normalizeEmptyPatchBase(text: string): string {
  const lines = text.split(/\r?\n/)
  const meaningful = lines.flatMap((line, index) => {
    const trimmed = line.trim()
    return trimmed && !trimmed.startsWith('#') ? [index] : []
  })
  if (meaningful.length !== 1 || lines[meaningful[0]].trim() !== '[]') return text
  return lines.filter((_line, index) => index !== meaningful[0]).join('\n')
}

/** Atomically inject a repeatable managed patch into the selected profile only. */
export function injectActiveProfileHostLock(input: ActiveProfileHostLock): string {
  if (input.evaluation.status !== 'supported') throw new HostProfileError('profile_host_lock_unsupported',
    'an unsupported host cannot replace the managed lock')
  const patchPath = join(input.profileRoot, 'cordis.patch.yml')
  const original = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  const stripped = stripManagedPatch(original)
  const base = normalizeEmptyPatchBase(stripped.base)
  const activation = activationFromPatch(base)
    ?? (stripped.prior ? activationFromManagedPatch(stripped.prior) : undefined)
  const managed = renderManagedPatch(
    input.evaluation.packages.filter((row) => row.version && row.integrity),
    input.platform,
    input.profileKind,
    activation,
    input.runtimeRoot,
    input.profileRoot,
    input.trust,
    input.profileKind === 'desktop' ? input.evaluation.digest : undefined,
  )
  const next = `${base.trimEnd()}${base.trim() ? '\n\n' : ''}${managed}`
  const temporary = `${patchPath}.context-guard-${process.pid}.tmp`
  writeFileSync(temporary, next, { encoding: 'utf8', flag: 'wx' })
  renameSync(temporary, patchPath)
  return patchPath
}

function parseYamlScalar(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('"')) {
    try { return JSON.parse(trimmed) } catch { return '' }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'")
  return trimmed
}

function parseYamlField(entry: readonly string[], index: number, value: string): string {
  const indicator = value.trim()
  if (!['>', '>-', '>+', '|', '|-', '|+'].includes(indicator)) return parseYamlScalar(value)
  const parts: string[] = []
  for (let cursor = index + 1; cursor < entry.length; cursor += 1) {
    const indentation = (entry[index].match(/^\s*/)?.[0].length ?? 8) + 2
    const blockLine = entry[cursor].match(new RegExp(`^\\s{${indentation}}(.*)$`))
    if (!blockLine) break
    parts.push(blockLine[1])
  }
  return parts.join(indicator.startsWith('>') ? ' ' : '\n').trim()
}

/** Extract the bounded host tuple from DSH's composed YAML dump. */
export function hostLockRowsFromComposedDump(text: string): PackageRow[] {
  const lines = text.split(/\r?\n/)
  const starts: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (/^- id:\s*["']?context-guard["']?\s*$/.test(lines[index])) starts.push(index)
  }
  if (starts.length !== 1) return []
  const start = starts[0]
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith('- ')) { end = index; break }
  }
  const entry = lines.slice(start, end)
  const name = entry.find((line) => /^\s{2}name:/.test(line))?.replace(/^\s{2}name:\s*/, '')
  if (!name || parseYamlScalar(name) !== 'dsh-completion-guard') return []
  const hostIndex = entry.findIndex((line) => /^\s{4}hostLockPackages:\s*$/.test(line))
  if (hostIndex < 0) return []
  const rows: PackageRow[] = []
  for (let index = hostIndex + 1; index < entry.length; index += 1) {
    const nameMatch = entry[index].match(/^\s{6}- name:\s*(.+?)\s*$/)
    if (!nameMatch) {
      if (/^\s{4}\S/.test(entry[index])) break
      continue
    }
    const row: PackageRow = { name: parseYamlScalar(nameMatch[1]) }
    for (let cursor = index + 1; cursor < entry.length; cursor += 1) {
      if (/^\s{6}- name:/.test(entry[cursor]) || /^\s{4}\S/.test(entry[cursor])) break
      const field = entry[cursor].match(/^\s{8}(version|integrity):\s*(.+?)\s*$/)
      if (field) row[field[1] as 'version' | 'integrity'] = parseYamlField(entry, cursor, field[2])
    }
    rows.push(row)
  }
  return rows
}

export function hostLockContextFromComposedDump(text: string): { platform?: HostPlatform; profileKind?: HostProfileKind } {
  const lines = text.split(/\r?\n/)
  const starts = lines.flatMap((line, index) => /^- id:\s*["']?context-guard["']?\s*$/.test(line) ? [index] : [])
  if (starts.length !== 1) return {}
  const start = starts[0]
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith('- ')) { end = index; break }
  }
  const entry = lines.slice(start, end)
  const platformValue = entry.find((line) => /^\s{4}hostLockPlatform:/.test(line))?.replace(/^\s{4}hostLockPlatform:\s*/, '')
  const profileValue = entry.find((line) => /^\s{4}hostLockProfile:/.test(line))?.replace(/^\s{4}hostLockProfile:\s*/, '')
  const platform = platformValue ? parseYamlScalar(platformValue) : undefined
  const profileKind = profileValue ? parseYamlScalar(profileValue) : undefined
  return {
    ...(platform === 'posix' || platform === 'windows' ? { platform } : {}),
    ...(profileKind === 'headless' || profileKind === 'web' || profileKind === 'desktop' ? { profileKind } : {}),
  }
}

export function verifyComposedHostLockDump(
  text: string, expected: HostLockEvaluation,
  roots?: Pick<ActiveProfileHostLock, 'runtimeRoot' | 'profileRoot'>,
): HostLockEvaluation {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^- id:\s*["']?context-guard["']?\s*$/.test(line))
  const tail = lines.slice(start + 1)
  const end = tail.findIndex((line) => line.startsWith('- '))
  const entry = end < 0 ? tail : tail.slice(0, end)
  const settings: Record<string, string> = {}
  for (const key of ['hostLockPolicy', 'hostLockRuntimeRoot', 'hostLockProfileRoot']) {
    const matches = entry.flatMap((line, index) => line.startsWith(`    ${key}:`) ? [index] : [])
    if (matches.length !== 1) throw new HostProfileError('host_lock_readback_mismatch', 'composed config host lock does not match the active graph')
    const index = matches[0]
    settings[key] = parseYamlField(entry, index, entry[index].slice(entry[index].indexOf(':') + 1))
  }
  if (settings.hostLockPolicy !== 'dsh-core/v1'
    || !isAbsolute(settings.hostLockRuntimeRoot) || !isAbsolute(settings.hostLockProfileRoot)
    || (roots && (resolve(settings.hostLockRuntimeRoot) !== resolve(roots.runtimeRoot)
      || resolve(settings.hostLockProfileRoot) !== resolve(roots.profileRoot)))) {
    throw new HostProfileError('host_lock_readback_mismatch', 'composed config host lock does not match the active graph')
  }
  const context = hostLockContextFromComposedDump(text)
  const trustLines = entry.flatMap((line, index) => line.startsWith('    hostLockTrust:') ? [index] : [])
  if (trustLines.length > 1) throw new HostProfileError('host_lock_readback_mismatch', 'duplicate trust description')
  const trustIndex = trustLines[0]
  const trustText = trustIndex === undefined ? undefined : parseYamlField(entry, trustIndex, entry[trustIndex].slice(entry[trustIndex].indexOf(':') + 1))
  const actual = evaluateConfiguredHostLock(hostLockRowsFromComposedDump(text), context, trustText, settings.hostLockProfileRoot)
  if (context.profileKind === 'desktop') {
    const lines = entry.filter(line => line.startsWith('    hostLockDesktopDigest:'))
    const stored = lines.length === 1 ? parseYamlScalar(lines[0].slice(lines[0].indexOf(':') + 1)) : undefined
    const expectedRows = evaluateConfiguredHostLock(expected.packages, {
      platform: expected.platform, profileKind: 'desktop',
    }, trustText, settings.hostLockProfileRoot)
    if (!roots || actual.status !== 'supported' || actual.digest !== expectedRows.digest
      || stored !== expected.digest || !/^[a-f0-9]{64}$/.test(stored ?? '')) {
      throw new HostProfileError('host_lock_readback_mismatch', 'composed Desktop identity does not match the active graph')
    }
    return { ...actual, digest: expected.digest, auditedForegroundRenderers: expected.auditedForegroundRenderers }
  }
  if (actual.status !== 'supported' || actual.digest !== expected.digest) {
    throw new HostProfileError('host_lock_readback_mismatch', 'composed config host lock does not match the active graph')
  }
  return actual
}
