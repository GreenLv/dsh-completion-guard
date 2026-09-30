import { physicalFs } from './host-physical-fs.js'
const { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } = physicalFs
import { createHash } from 'node:crypto'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { PackageRow } from './digest.js'
import { HostProfileError } from './host-resolver.js'
import { parseHostVersion, satisfiesSupportedHostRange } from './host-version.js'
import type { AuditedPackageExpectation } from './host-resolver.js'

/**
 * Official Desktop adapter (CG-RC2-002).
 *
 * The Desktop app is the only authority for the `desktop` profile: its
 * `package.json` is named `dsh-profile-desktop`, its dependency graph lives
 * inside the signed `app.asar` of the installation, and there is no pnpm
 * package map or lockfile to read. This adapter therefore reads the official
 * graph IN PLACE from the asar container — it never unpacks the bundle and
 * never fabricates a map. The identities the manifest declares are qualified
 * through the same registry acquisition and host-contract probe as a CLI
 * graph rebind (`acquireDesktopHostTrust`), and the actually installed bytes
 * are verified file-by-file from the asar against that qualification
 * (`auditDesktopInstalledImplementation`). Every mismatch fails closed.
 *
 * The asar container format is a flat archive: a JSON header (with per-file
 * offsets) followed by the file bytes. Reading a file means header lookup +
 * one bounded positioned read, so an audited file set costs no more I/O than
 * reading the same files from a directory, and a tampered byte changes its
 * digest exactly as on disk.
 */

export const DESKTOP_PROFILE_PACKAGE_NAME = 'dsh-profile-desktop'
export const DESKTOP_RUNTIME_PACKAGE_NAME = '@deepseek-ai/dsh-desktop-runtime'
const DESKTOP_RUNTIME_MANIFEST_ENTRY = 'dsh/package.json'
const DESKTOP_RUNTIME_METADATA_ENTRY = 'dsh/desktop-runtime.json'
const DESKTOP_GRAPH_ROOT = 'dsh/node_modules'
const DESKTOP_CARRIER_ENTRY = 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'
const MAX_ASAR_HEADER_BYTES = 128 * 1024 * 1024
const MAX_ASAR_FILE_BYTES = 64 * 1024 * 1024

interface AsarNode {
  files?: Record<string, AsarNode>
  size?: number
  offset?: string
  unpacked?: boolean
  integrity?: unknown
}

export interface AsarIndex {
  dataOffset: number
  root: AsarNode
  headerSha256: string
  fileCount: number
}

/** Read the asar header (the JSON index) without extracting any payload. */
export function readAsarIndex(archivePath: string): AsarIndex {
  const header = Buffer.alloc(16)
  const fd = openSync(archivePath, 'r')
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size < 16) throw new HostProfileError('desktop_app_invalid', 'asar archive is too small')
    if (readSync(fd, header, 0, 16, 0) !== 16) throw new HostProfileError('desktop_app_invalid', 'asar header is truncated')
    const magic = header.readUInt32LE(0)
    const headerSize = header.readUInt32LE(4)
    const innerPayloadSize = header.readUInt32LE(8)
    const jsonSize = header.readUInt32LE(12)
    // Chroma Pickle layout: [4][headerSize][headerSize-4][jsonSize][json...]
    // where headerSize counts everything from offset 8, and the inner payload
    // size is the JSON size plus its 4-byte length field and padding.
    if (magic !== 4 || headerSize < jsonSize + 8 || innerPayloadSize !== headerSize - 4
      || jsonSize <= 0 || jsonSize > MAX_ASAR_HEADER_BYTES) {
      throw new HostProfileError('desktop_app_invalid', 'asar header is malformed')
    }
    const json = Buffer.alloc(jsonSize)
    if (readSync(fd, json, 0, jsonSize, 16) !== jsonSize) throw new HostProfileError('desktop_app_invalid', 'asar header is truncated')
    let root: AsarNode
    try { root = JSON.parse(json.toString('utf8')) as AsarNode } catch {
      throw new HostProfileError('desktop_app_invalid', 'asar header is not valid JSON')
    }
    if (!root || typeof root !== 'object' || !root.files || typeof root.files !== 'object') {
      throw new HostProfileError('desktop_app_invalid', 'asar header has no file index')
    }
    let fileCount = 0
    const count = (node: AsarNode, depth: number): void => {
      if (depth > 64 || fileCount > 2_000_000) throw new HostProfileError('desktop_app_invalid', 'asar index is too deep or too large')
      if (!node.files) { fileCount += 1; return }
      for (const child of Object.values(node.files)) count(child, depth + 1)
    }
    count(root, 0)
    return { dataOffset: 8 + headerSize, root, headerSha256: createHash('sha256').update(json).digest('hex'), fileCount }
  } finally {
    closeSync(fd)
  }
}

function asarNode(index: AsarIndex, pathParts: readonly string[]): AsarNode | undefined {
  let node = index.root
  for (const part of pathParts) {
    if (!node.files || typeof node.files !== 'object') return undefined
    node = node.files[part]
    if (!node) return undefined
  }
  return node
}

/**
 * Read one file's exact bytes from the asar in place. Unpacked entries are
 * read from the sibling `app.asar.unpacked` tree, which is where the app
 * itself loads them; a path that escapes that tree fails closed.
 */
export function readAsarFile(archivePath: string, index: AsarIndex, entryPath: string): Buffer {
  const parts = entryPath.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) {
    throw new HostProfileError('desktop_app_invalid', 'asar entry path is not canonical')
  }
  const node = asarNode(index, parts)
  if (!node || node.files) throw new HostProfileError('desktop_app_invalid', `asar entry is not a file: ${entryPath}`)
  if (!Number.isSafeInteger(node.size) || node.size! < 0 || (!node.unpacked
    && (typeof node.offset !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(node.offset) || !Number.isSafeInteger(Number(node.offset))))) {
    throw new HostProfileError('desktop_app_invalid', `asar entry has no bounded offset: ${entryPath}`)
  }
  const size = node.size!
  if (size > MAX_ASAR_FILE_BYTES) throw new HostProfileError('desktop_app_invalid', `asar entry is too large: ${entryPath}`)
  const verify = (bytes: Buffer): Buffer => {
    if (bytes.length !== size) throw new HostProfileError('desktop_app_invalid', 'asar file size mismatch')
    if (isRecord(node.integrity) && (node.integrity.algorithm !== 'SHA256'
      || node.integrity.hash !== createHash('sha256').update(bytes).digest('hex'))) {
      throw new HostProfileError('desktop_app_invalid', 'asar file integrity mismatch')
    }
    return bytes
  }
  if (node.unpacked) {
    const realArchive = realpathSync(archivePath)
    const unpackedRoot = `${realArchive}.unpacked`
    const target = realpathSync(join(unpackedRoot, ...parts))
    if (!target.startsWith(`${unpackedRoot}${sep}`)) {
      throw new HostProfileError('desktop_app_invalid', `unpacked entry escapes the app bundle: ${entryPath}`)
    }
    const fd = openSync(target, 'r')
    try {
      if (fstatSync(fd).size !== size) throw new HostProfileError('desktop_app_invalid', 'unpacked file size mismatch')
      const bytes = Buffer.alloc(size)
      if (size && readSync(fd, bytes, 0, size, 0) !== size) throw new HostProfileError('desktop_app_invalid', 'unpacked file truncated')
      return verify(bytes)
    } finally { closeSync(fd) }
  }
  const start = index.dataOffset + Number(node.offset)
  const buffer = Buffer.alloc(size)
  const fd = openSync(archivePath, 'r')
  try {
    if (!Number.isSafeInteger(start) || start < index.dataOffset || start + size > fstatSync(fd).size) {
      throw new HostProfileError('desktop_app_invalid', 'asar file offset escapes the archive')
    }
    if (size > 0 && readSync(fd, buffer, 0, size, start) !== size) {
      throw new HostProfileError('desktop_app_invalid', `asar entry is truncated: ${entryPath}`)
    }
  } finally {
    closeSync(fd)
  }
  return verify(buffer)
}

export interface DesktopAppRuntime {
  /** Absolute path of the app bundle archive the rows were read from. */
  asarRealpath: string
  headerSha256: string
  manifestSha256: string
  metadataSha256: string
  /** DSH host version the official runtime manifest pins for `@deepseek-ai/dsh`. */
  hostVersion: string
  /** Version of the `@deepseek-ai/dsh-desktop-runtime` private manifest. */
  runtimeVersion: string
  metadata: {
    desktopVersion: string
    platform: string
    arch: string
    node: string
    pnpm: string
    /** Count of the official per-file digest table entries bound by the metadata hash. */
    fileTableEntries: number
  }
  /** Version-only rows for the critical names the official manifest declares. */
  rows: PackageRow[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Read the official Desktop runtime graph from the app bundle. `appAsarPath`
 * is the absolute path of `app.asar` (a file, not a directory). The runtime
 * identity binds: the asar header itself, the `@deepseek-ai/dsh-desktop-runtime`
 * manifest, the `desktop-runtime.json` metadata block, and the official CLI
 * carrier entry the app installs.
 */
export function readDesktopAppRuntime(appAsarPath: string): DesktopAppRuntime {
  if (!isAbsolute(appAsarPath)) throw new HostProfileError('desktop_app_invalid', 'the app archive path must be absolute')
  if (!existsSync(appAsarPath) || !lstatSync(appAsarPath).isFile()) {
    throw new HostProfileError('desktop_app_missing', 'the official app archive was not found')
  }
  const asarRealpath = realpathSync(appAsarPath)
  const index = readAsarIndex(asarRealpath)
  if (!asarNode(index, DESKTOP_CARRIER_ENTRY.split('/'))) {
    throw new HostProfileError('desktop_app_invalid', 'the official CLI carrier entry is missing from the app bundle')
  }
  // The carrier's bytes must agree with the header authenticated by the OS
  // signature verifier, not merely occupy a plausible archive pathname.
  readAsarFile(asarRealpath, index, DESKTOP_CARRIER_ENTRY)
  const manifestBytes = readAsarFile(asarRealpath, index, DESKTOP_RUNTIME_MANIFEST_ENTRY)
  const metadataBytes = readAsarFile(asarRealpath, index, DESKTOP_RUNTIME_METADATA_ENTRY)
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as Record<string, unknown>
  const metadata = JSON.parse(metadataBytes.toString('utf8')) as Record<string, unknown>
  if (manifest.name !== DESKTOP_RUNTIME_PACKAGE_NAME) {
    throw new HostProfileError('desktop_app_invalid', 'the app runtime manifest is not the official desktop runtime')
  }
  const runtimeVersion = typeof manifest.version === 'string' ? manifest.version : ''
  if (!parseHostVersion(runtimeVersion) || !satisfiesSupportedHostRange(runtimeVersion)) {
    throw new HostProfileError('desktop_host_version_below_minimum', 'the app runtime version is not an admitted host version')
  }
  const dependencies = isRecord(manifest.dependencies) ? manifest.dependencies : undefined
  if (!dependencies) throw new HostProfileError('desktop_app_invalid', 'the app runtime manifest declares no dependencies')
  const dshVersion = dependencies['@deepseek-ai/dsh']
  if (typeof dshVersion !== 'string' || dshVersion !== runtimeVersion) {
    throw new HostProfileError('desktop_app_invalid', 'the app runtime does not pin the audited DSH version')
  }
  const desktopVersion = isRecord(metadata.release) && typeof metadata.release.version === 'string' ? metadata.release.version : ''
  const nodeVersion = isRecord(metadata.release) && typeof metadata.release.nodeVersion === 'string' ? metadata.release.nodeVersion : ''
  const pnpmVersion = isRecord(metadata.release) && typeof metadata.release.pnpmVersion === 'string' ? metadata.release.pnpmVersion : ''
  const fileTable = Array.isArray(metadata.files) ? metadata.files : []
  if (!parseHostVersion(desktopVersion) || !satisfiesSupportedHostRange(desktopVersion)
    || typeof metadata.platform !== 'string' || !metadata.platform
    || typeof metadata.arch !== 'string' || !metadata.arch
    || !nodeVersion || !pnpmVersion
    || fileTable.length === 0 || fileTable.length > 200_000
    || !fileTable.every((entry) => isRecord(entry) && typeof entry.path === 'string' && !!entry.path
      && !entry.path.startsWith('/') && !entry.path.includes('\\') && !entry.path.includes('..')
      && /^[a-f0-9]{64}$/.test(String(entry.sha256)))) {
    throw new HostProfileError('desktop_app_invalid', 'the desktop runtime metadata block is incomplete')
  }
  // The official bundle ships its own complete per-file digest table; the raw
  // bytes of that table (already hashed into metadataSha256) bind the whole
  // file inventory into the runtime identity.
  void fileTable
  // The profile half of the graph is the app bundle itself: every critical
  // name the official manifest pins contributes one version-only row.
  // Integrity is deliberately absent — it is acquired from the registry in
  // `acquireDesktopHostTrust`, never asserted by the app.
  const { CRITICAL_NAME_SET } = criticalNames()
  const rows: PackageRow[] = []
  for (const [name, version] of Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))) {
    if (!CRITICAL_NAME_SET.has(name)) continue
    if (typeof version !== 'string' || !parseHostVersion(version)) {
      throw new HostProfileError('desktop_app_invalid', `the app pins an unparsable version for ${name}`)
    }
    rows.push({ name, version })
  }
  return {
    asarRealpath,
    headerSha256: index.headerSha256,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    metadataSha256: createHash('sha256').update(metadataBytes).digest('hex'),
    hostVersion: dshVersion,
    runtimeVersion,
    metadata: {
      desktopVersion,
      platform: String(metadata.platform),
      arch: String(metadata.arch),
      node: nodeVersion,
      pnpm: pnpmVersion,
      fileTableEntries: fileTable.length,
    },
    rows,
  }
}

// Imported late to keep this module independent of the cohort definition at
// type level while still failing closed on an unknown critical name set.
import { HOST_COHORTS } from './host-lock.js'
function criticalNames(): { CRITICAL_NAME_SET: ReadonlySet<string> } {
  return { CRITICAL_NAME_SET: new Set(HOST_COHORTS.flatMap((cohort) => cohort.packages.map((row) => row.name))) }
}

export interface DesktopTargetGraph {
  packages: PackageRow[]
  profileGraph: {
    state: 'dependency_free_desktop'
    manifestSha256: string
    bundles: string[]
  }
  runtime: DesktopAppRuntime
}

function readJsonObjectFile(path: string, code: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (isRecord(value)) return value
  } catch { /* bounded code below */ }
  throw new HostProfileError(code, `invalid JSON object: ${path}`)
}

/** Importer state selects the active audit; its presence grants no trust. */
export function hasDesktopImporterState(profileRoot: string): boolean {
  return ['node_modules', '.dsh-module-fallback', 'pnpm-lock.yaml'].some((name) => {
    try { lstatSync(join(profileRoot, name)); return true } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  })
}

/**
 * Pre-install inspection of a Desktop target: the profile must be the
 * Desktop-owned dependency-free profile, and the runtime half must come from
 * the official app bundle. Structural discovery grants no authority — the
 * caller must still qualify and byte-audit before any install decision.
 */
export function readDesktopTargetGraph(appAsarPath: string, profileRoot: string): DesktopTargetGraph {
  const profile = resolve(profileRoot)
  const manifestPath = join(profile, 'package.json')
  const manifest = readJsonObjectFile(manifestPath, 'profile_manifest_invalid')
  if (manifest.name !== DESKTOP_PROFILE_PACKAGE_NAME) {
    throw new HostProfileError('target_profile_not_desktop', 'the profile is not the Desktop-owned dsh-profile-desktop')
  }
  if (hasDesktopImporterState(profile)) {
    throw new HostProfileError('target_profile_unmanaged_modules', 'desktop profiles are managed by the app: importer state exists')
  }
  const dependencies = isRecord(manifest.dependencies) ? manifest.dependencies : {}
  if (Object.keys(dependencies).length > 0) {
    throw new HostProfileError('target_profile_dependency_uninstalled', 'the desktop profile declares dependencies without an importer')
  }
  const dsh = isRecord(manifest.dsh) ? manifest.dsh : undefined
  const profileConfig = isRecord(dsh?.profile) ? dsh.profile : undefined
  const bundles = profileConfig?.bundles
  if (!Array.isArray(bundles) || !bundles.includes('@deepseek-ai/dsh-base') || !bundles.includes('@deepseek-ai/dsh-web-app')) {
    throw new HostProfileError('target_profile_bundles_unsupported', 'not the official Desktop bundle tuple')
  }
  if (bundles.includes('@deepseek-ai/dsh-headless') || bundles.includes('dshmarket')) {
    throw new HostProfileError('desktop_profile_bundle_conflict', 'the desktop profile carries a web/headless-only bundle')
  }
  const runtime = readDesktopAppRuntime(appAsarPath)
  return {
    packages: runtime.rows,
    profileGraph: {
      state: 'dependency_free_desktop',
      manifestSha256: createHash('sha256').update(readFileSync(manifestPath)).digest('hex'),
      bundles: bundles.map(String),
    },
    runtime,
  }
}

/**
 * Verify the actually installed app bytes against the acquired qualification.
 * Each critical package's closed module inventory (every `.cm?js|json` file
 * under its asar root plus its manifest) is digested from the asar in place
 * and compared with the trust rows; any extra, missing, or changed file fails
 * closed. A critical package that also appears NESTED anywhere in the app
 * graph is an ambiguity no adapter resolves, so its presence fails closed
 * before any digest is computed.
 */
export function auditDesktopInstalledImplementation(appAsarPath: string,
  expectations: readonly AuditedPackageExpectation[]): boolean {
  try {
    const realArchive = realpathSync(appAsarPath)
    const index = readAsarIndex(realArchive)
    const { CRITICAL_NAME_SET } = criticalNames()
    // Ambiguity scan over the header only: any second (nested) occurrence of
    // a critical package name inside the app graph makes resolution
    // path-dependent, and no single "the" implementation exists to attest.
    const topLevelRoot = DESKTOP_GRAPH_ROOT.split('/')
    const scan = (node: AsarNode, parts: readonly string[], depth: number): void => {
      if (depth > 64) throw new HostProfileError('desktop_app_invalid', 'asar index is too deep')
      if (node.files) {
        for (const [name, child] of Object.entries(node.files)) {
          scan(child, [...parts, name], depth + 1)
        }
        return
      }
      const relative = parts.join('/')
      if (!relative.endsWith('/package.json')) return
      for (const critical of CRITICAL_NAME_SET) {
        if (relative === `${DESKTOP_GRAPH_ROOT}/${critical}/package.json`) continue
        if (relative.endsWith(`/node_modules/${critical}/package.json`)) {
          throw new HostProfileError('desktop_graph_ambiguous', `critical package ${critical} is nested inside the app graph`)
        }
      }
    }
    scan(index.root, [], 0)
    // The bundle's own official per-file digest table (from
    // `dsh/desktop-runtime.json`): the packager's attestation of every
    // installed byte. It is the ONLY accepted authority for a rewritten
    // manifest, never for the executable modules themselves.
    const fileTable = new Map<string, string>()
    const metadataBytes = readAsarFile(realArchive, index, DESKTOP_RUNTIME_METADATA_ENTRY)
    const metadata = JSON.parse(metadataBytes.toString('utf8')) as { files?: unknown }
    if (Array.isArray(metadata.files)) {
      for (const entry of metadata.files) {
        if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).path === 'string'
          && /^[a-f0-9]{64}$/.test(String((entry as Record<string, unknown>).sha256))) {
          fileTable.set(`dsh/${(entry as Record<string, unknown>).path as string}`, String((entry as Record<string, unknown>).sha256))
        }
      }
    }
    for (const expected of expectations) {
      const parts = [...topLevelRoot, ...expected.name.split('/')]
      const node = asarNode(index, parts)
      if (!node || !node.files) return false
      const manifestBytes = readAsarFile(realArchive, index, [...parts, 'package.json'].join('/'))
      const manifest = JSON.parse(manifestBytes.toString('utf8')) as Record<string, unknown>
      if (manifest.name !== expected.name || manifest.version !== expected.version) return false
      const inventory: string[] = []
      const walk = (current: AsarNode, prefix: readonly string[], depth: number): void => {
        if (depth > 32 || inventory.length > 10_000) throw new HostProfileError('desktop_app_invalid', 'package inventory is too deep or too large')
        if (current.files) {
          for (const [name, child] of Object.entries(current.files)) {
            if (name === 'node_modules') continue
            walk(child, [...prefix, name], depth + 1)
          }
          return
        }
        const file = prefix.join('/')
        if (/\.(?:[cm]?js|json)$/.test(file)) inventory.push(file)
      }
      walk(node, [], 0)
      // An archive cannot authorize additional programs with its own table.
      // Close the executable inventory against the acquired registry modules.
      const registryFiles = Object.keys(expected.modules ?? {})
      if (inventory.some((file) => !registryFiles.includes(file))) return false
      // Closed world: the bundle's OWN official digest table must attest
      // every single file under the package root; an unattested file (or a
      // table digest disagreement) fails the whole audit.
      for (const file of inventory) {
        const tableEntry = fileTable.get(`${DESKTOP_GRAPH_ROOT}/${expected.name}/${file}`)
        if (tableEntry === undefined) return false
        const attested = createHash('sha256').update(readAsarFile(realArchive, index, [...parts, ...file.split('/')].join('/'))).digest('hex')
        if (tableEntry !== attested) return false
      }
      // Registry equality: every audited module matches the published
      // tarball digest. The packager-rewritten package.json manifest is the
      // one accepted divergence: its identity fields were checked above and
      // its bytes are attested by the official table, while an executable
      // module whose bytes differ from the published tarball always fails.
      for (const file of Object.keys(expected.modules ?? {})) {
        const actual = createHash('sha256').update(readAsarFile(realArchive, index, [...parts, ...file.split('/')].join('/'))).digest('hex')
        if (expected.modules![file] === actual) continue
        if (file === 'package.json') continue
        return false
      }
    }
    return true
  } catch (error) {
    if (error instanceof HostProfileError && error.code === 'desktop_graph_ambiguous') throw error
    return false
  }
}

/** Persist the app-bundle identity next to the profile contract receipts so a
 * native annex can bind its readback to the exact inspected bundle. */
export function writeDesktopRuntimeReceipt(profileRoot: string, runtime: DesktopAppRuntime): string {
  const receipt = {
    schema: 'dsh-desktop-runtime-readback/v1',
    asarRealpath: runtime.asarRealpath,
    headerSha256: runtime.headerSha256,
    manifestSha256: runtime.manifestSha256,
    metadataSha256: runtime.metadataSha256,
    hostVersion: runtime.hostVersion,
    runtimeVersion: runtime.runtimeVersion,
    metadata: runtime.metadata,
    rows: runtime.rows,
  }
  const directory = join(realpathSync(profileRoot), '.dsh-completion-guard')
  for (const dir of [directory, join(directory, 'desktop')]) {
    try { mkdirSync(dir, { mode: 0o700 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== dir) {
      throw new HostProfileError('desktop_receipt_path_invalid', 'desktop receipt directory is not a contained physical directory')
    }
  }
  const path = join(directory, 'desktop', `${runtime.manifestSha256}.json`)
  if (!existsSync(path)) writeFileSync(path, JSON.stringify(receipt, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return path
}

export const DESKTOP_IDENTITY_FACTS: Readonly<{
  profilePackageName: typeof DESKTOP_PROFILE_PACKAGE_NAME
  runtimePackageName: typeof DESKTOP_RUNTIME_PACKAGE_NAME
  carrierEntry: string
}> = {
  profilePackageName: DESKTOP_PROFILE_PACKAGE_NAME,
  runtimePackageName: DESKTOP_RUNTIME_PACKAGE_NAME,
  carrierEntry: DESKTOP_CARRIER_ENTRY,
} as const

/**
 * Resolve one dependency's exact installed identity from the official app
 * graph by its top-level manifest. Used by the host-contract probe's
 * dependency acquisition; a name with no top-level manifest is unbound (the
 * installed-byte audit separately refuses nested critical duplicates, so a
 * nested-only dependency can never be silently resolved here).
 */
export function readDesktopDependency(appAsarPath: string, name: string): PackageRow {
  const realArchive = realpathSync(appAsarPath)
  const index = readAsarIndex(realArchive)
  const manifestPath = `${DESKTOP_GRAPH_ROOT}/${name}/package.json`
  if (!asarNode(index, manifestPath.split('/'))) {
    throw new HostProfileError('host_contract_probe_dependency_unbound', `dependency ${name} has no top-level manifest in the app graph`)
  }
  const bytes = readAsarFile(realArchive, index, manifestPath)
  const manifest = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
  if (manifest.name !== name || typeof manifest.version !== 'string' || !parseHostVersion(manifest.version)) {
    throw new HostProfileError('host_contract_probe_dependency_unbound', `dependency ${name} has an invalid manifest identity`)
  }
  return { name, version: manifest.version }
}
