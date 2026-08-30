import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EXPECTED_HOST_PACKAGES,
  evaluateHostLock,
  type HostLockEvaluation,
  type HostPlatform,
  type HostProfileKind,
} from './host-lock.js'
import type { PackageRow } from './digest.js'

const CRITICAL_NAMES: readonly string[] = EXPECTED_HOST_PACKAGES.map((row) => row.name)
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
export function packageRowsFromPnpmLock(text: string): PackageRow[] {
  const rows = new Map<string, PackageRow[]>()
  const lines = text.split(/\r?\n/)
  const packagesStart = lines.findIndex((line) => line === 'packages:')
  const snapshotsStart = lines.findIndex((line) => line === 'snapshots:')
  if (packagesStart < 0) return []
  const end = snapshotsStart > packagesStart ? snapshotsStart : lines.length
  for (let index = packagesStart + 1; index < end; index += 1) {
    const match = lines[index].match(/^  '?((?:@[^/'\s]+\/)?[^@'\s]+)@([^':\s]+)'?:\s*$/)
    if (!match || !CRITICAL_NAMES.includes(match[1])) continue
    let integrity: string | undefined
    for (let cursor = index + 1; cursor < lines.length && !/^  \S/.test(lines[cursor]); cursor += 1) {
      const resolution = lines[cursor].match(/^    resolution: \{[^}]*\bintegrity: ([^,}\s]+)[^}]*\}\s*$/)
      if (resolution) { integrity = resolution[1]; break }
    }
    const entries = rows.get(match[1]) ?? []
    entries.push({ name: match[1], version: match[2], ...(integrity ? { integrity } : {}) })
    rows.set(match[1], entries)
  }
  return CRITICAL_NAMES.flatMap((name) => {
    const entries = rows.get(name) ?? []
    if (entries.length === 0) return []
    return entries
  })
}

export function resolveInstalledHostLock(moduleUrl: string = import.meta.url): HostLockEvaluation {
  const lockPath = findUp(dirname(fileURLToPath(moduleUrl)), 'pnpm-lock.yaml')
  if (!lockPath) return evaluateHostLock([])
  try {
    return evaluateHostLock(packageRowsFromPnpmLock(readFileSync(lockPath, 'utf8')))
  } catch {
    return evaluateHostLock([])
  }
}

interface PackageMapRecord {
  url?: unknown
  dependencies?: unknown
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
): PackageRow[] {
  let document: unknown
  try { document = JSON.parse(packageMapText) } catch { return [] }
  if (!document || typeof document !== 'object') return []
  const packages = (document as { packages?: unknown }).packages
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) return []
  const records = packages as Record<string, PackageMapRecord>
  if (!records['.'] || Object.keys(records).length > 20_000) return []
  const reachable = new Set<string>()
  const queue = ['.']
  while (queue.length > 0 && reachable.size <= 20_000) {
    const id = queue.shift()!
    if (reachable.has(id)) continue
    const record = records[id]
    if (!record || typeof record !== 'object') return []
    reachable.add(id)
    if (!record.dependencies || typeof record.dependencies !== 'object' || Array.isArray(record.dependencies)) continue
    for (const target of Object.values(record.dependencies as Record<string, unknown>)) {
      if (typeof target === 'string' && target !== '.' && !reachable.has(target)) queue.push(target)
    }
  }
  if (queue.length > 0) return []

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
          const modules = resolve(nodeModulesRoot)
          const manifestPath = resolve(modules, record.url, 'package.json')
          if (!manifestPath.startsWith(`${modules}${sep}`)) {
            rows.push({ name })
            continue
          }
          installedManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
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
}

/** Read and validate the actual runtime graph plus the installed profile plugin. */
export function resolveActiveProfileHostLock(
  runtimeRoot: string,
  profileRoot: string,
  expectedPluginVersion: string,
): ActiveProfileHostLock {
  const runtime = resolve(runtimeRoot)
  const profile = resolve(profileRoot)
  const lockPath = join(runtime, 'pnpm-lock.yaml')
  const mapPath = join(runtime, 'node_modules', '.package-map.json')
  const profileManifestPath = join(profile, 'package.json')
  const pluginManifestPath = join(profile, 'node_modules', 'dsh-completion-guard', 'package.json')
  const profileLockPath = join(profile, 'pnpm-lock.yaml')
  const profileMapPath = join(profile, 'node_modules', '.package-map.json')
  for (const path of [lockPath, mapPath, profileLockPath, profileMapPath, profileManifestPath, pluginManifestPath]) {
    if (!existsSync(path)) throw new HostProfileError('active_graph_missing', `required active graph file is missing: ${path}`)
  }
  const runtimeRows = packageRowsFromActiveGraph(
    readFileSync(mapPath, 'utf8'),
    readFileSync(lockPath, 'utf8'),
    join(runtime, 'node_modules'),
  )
  const profileRows = packageRowsFromActiveGraph(
    readFileSync(profileMapPath, 'utf8'),
    readFileSync(profileLockPath, 'utf8'),
    join(profile, 'node_modules'),
  )
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
  const profileKind: HostProfileKind = bundles.includes('@deepseek-ai/dsh-web-app') || bundles.includes('dshmarket') ? 'web' : 'headless'
  const platform: HostPlatform = process.platform === 'win32' ? 'windows' : 'posix'
  // Preserve duplicates within either active graph (two reachable variants are
  // ambiguous), while deduplicating only the same identity repeated across the
  // runtime/profile boundary.
  const runtimeKeys = new Set(runtimeRows.map((row) => `${row.name}\u0000${row.version ?? ''}\u0000${row.integrity ?? ''}`))
  const rows = [
    ...runtimeRows,
    ...profileRows.filter((row) => !runtimeKeys.has(`${row.name}\u0000${row.version ?? ''}\u0000${row.integrity ?? ''}`)),
  ]
  const evaluation = evaluateHostLock(rows, { platform, profileKind })
  if (evaluation.status !== 'supported') {
    throw new HostProfileError(evaluation.reasonCode ?? 'active_graph_unavailable', 'active runtime graph does not match the supported host manifest')
  }
  return { evaluation, runtimeRoot: runtime, profileRoot: profile, pluginVersion: expectedPluginVersion, platform, profileKind }
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
): string {
  const lines = [HOST_LOCK_MARKER_BEGIN, '- id: context-guard', '  name: dsh-completion-guard', '  config:']
  if (activation) lines.push(`    activation: ${yamlQuote(activation)}`)
  lines.push(`    hostLockPlatform: ${yamlQuote(platform)}`)
  lines.push(`    hostLockProfile: ${yamlQuote(profileKind)}`)
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
  if (starts.length > 1) throw new HostProfileError('profile_patch_duplicate_target', 'multiple unmanaged context-guard patches are ambiguous')
  if (starts.length === 0) return undefined
  const start = starts[0]
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith('- ')) { end = index; break }
  }
  const entry = lines.slice(start + 1, end).join('\n')
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
    const blockLine = entry[cursor].match(/^\s{10}(.*)$/)
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
    ...(profileKind === 'headless' || profileKind === 'web' ? { profileKind } : {}),
  }
}

export function verifyComposedHostLockDump(text: string, expected: HostLockEvaluation): HostLockEvaluation {
  const context = hostLockContextFromComposedDump(text)
  const actual = evaluateHostLock(hostLockRowsFromComposedDump(text), context)
  if (actual.status !== 'supported' || actual.digest !== expected.digest) {
    throw new HostProfileError('host_lock_readback_mismatch', 'composed config host lock does not match the active graph')
  }
  return actual
}
