import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import { RC020_RC2_HOST_PACKAGES } from '../src/domain/rc020-rc2-host.js'
import {
  auditDesktopInstalledImplementation,
  readAsarIndex,
  readAsarFile,
  readDesktopAppRuntime,
  readDesktopDependency,
  readDesktopTargetGraph,
  DESKTOP_PROFILE_PACKAGE_NAME,
} from '../src/domain/host-desktop.js'
import { evaluateConfiguredHostLock, injectActiveProfileHostLock, inspectDesktopTargetGraph, resolveActiveProfileHostLock, revalidateDesktopCoreLock, verifyComposedHostLockDump } from '../src/domain/host-resolver.js'
import { evaluateHostCapability, evaluateHostLock, type HostProfileKind } from '../src/domain/host-lock.js'
import { resolveConfig } from '../src/config.js'
import { revalidateCoreLock } from '../src/runtime.js'

// ---------------------------------------------------------------------------
// Synthetic official app bundle. The asar container is fully specified: a
// 16-byte pickle prefix, the JSON index, then the file bytes at
// (8 + headerSize) + offset.
// ---------------------------------------------------------------------------

const SYNTHETIC_LIB_BYTES = 'export const synthetic = true\n'
// These portable fixtures exercise graph/audit logic, not OS signature trust.
vi.mock('../src/domain/host-desktop-identity.js', () => ({
  verifyDesktopCarrier: (archive: string) => archive,
}))
const SYNTHETIC_MODULES: Record<string, string> = {
  'package.json': 'SYNTHETIC_PACKAGE_JSON_PLACEHOLDER',
  'lib/index.js': createHash('sha256').update(SYNTHETIC_LIB_BYTES).digest('hex'),
}

function syntheticManifestBytes(name: string, version: string): Buffer {
  // The exact bytes hashed into the synthetic module inventory.
  return Buffer.from(JSON.stringify({ name, version, type: 'module', main: 'lib/index.js' }) + '\n', 'utf8')
}

interface AsarFileSpec { path: string; content: Buffer }

function buildAsar(files: readonly AsarFileSpec[]): Buffer {
  const root: Record<string, Record<string, unknown>> = {}
  let offset = 0
  for (const file of files) {
    const parts = file.path.split('/')
    let node = root
    for (const part of parts.slice(0, -1)) node = (node[part] ??= { files: {} } as Record<string, unknown>).files as Record<string, Record<string, unknown>>
    node[parts.at(-1)!] = { size: file.content.length, offset: String(offset) }
    offset += file.content.length
  }
  const json = Buffer.from(JSON.stringify({ files: root }), 'utf8')
  const padding = Buffer.alloc((4 - (json.length % 4)) % 4)
  const headerSize = 8 + json.length + padding.length
  const prefix = Buffer.alloc(16)
  prefix.writeUInt32LE(4, 0)
  prefix.writeUInt32LE(headerSize, 4)
  prefix.writeUInt32LE(headerSize - 4, 8)
  prefix.writeUInt32LE(json.length, 12)
  const body = Buffer.concat(files.map((file) => file.content))
  return Buffer.concat([prefix, json, padding, body])
}

const RC2_VERSION = '0.2.0-rc.2'
// The official per-file digest table attests every installed byte; the
// synthetic table covers exactly the synthetic bundle's files.
function makeDesktopMetadata(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    release: { schemaVersion: 1, version: RC2_VERSION, hostProtocolVersion: 4, nodeVersion: '24.21.0', pnpmVersion: '11.7.0' },
    platform: 'darwin',
    arch: 'arm64',
    sharedPackages: [],
    files: RC020_RC2_HOST_PACKAGES.flatMap((row) => [
      { path: `node_modules/${row.name}/package.json`, bytes: 10, sha256: createHash('sha256').update(syntheticManifestBytes(row.name, row.version as string)).digest('hex'), executable: false },
      { path: `node_modules/${row.name}/lib/index.js`, bytes: 30, sha256: SYNTHETIC_MODULES['lib/index.js'], executable: false },
    ]),
  }
}

function bundleFileSpecs(options?: { hostVersion?: string; metadata?: Record<string, unknown>; carrier?: boolean }): AsarFileSpec[] {
  const hostVersion = options?.hostVersion ?? RC2_VERSION
  const metadata = options?.metadata ?? makeDesktopMetadata()
  const manifest = {
    name: '@deepseek-ai/dsh-desktop-runtime',
    private: true,
    version: hostVersion,
    type: 'module',
    dependencies: Object.fromEntries(RC020_RC2_HOST_PACKAGES.map((row) => [row.name, row.version])),
  }
  const files: AsarFileSpec[] = [
    { path: 'dsh/package.json', content: Buffer.from(JSON.stringify(manifest), 'utf8') },
    { path: 'dsh/desktop-runtime.json', content: Buffer.from(JSON.stringify(metadata), 'utf8') },
  ]
  if (options?.carrier !== false) {
    files.push({ path: 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js', content: Buffer.from('export {}\n', 'utf8') })
  }
  for (const row of RC020_RC2_HOST_PACKAGES) {
    files.push({ path: `dsh/node_modules/${row.name}/package.json`, content: syntheticManifestBytes(row.name, row.version as string) })
    files.push({ path: `dsh/node_modules/${row.name}/lib/index.js`, content: Buffer.from(SYNTHETIC_LIB_BYTES, 'utf8') })
  }
  return files
}

function writeAsar(files: readonly AsarFileSpec[], directory: string): string {
  const path = join(directory, 'app.asar')
  writeFileSync(path, buildAsar(files))
  return path
}

// The synthetic bundle's module digests are bound into the mocked audit, so
// the byte audit below verifies the exact files the test wrote.
vi.mock('../manifests/rc020-rc2-byte-audit.json', async (original) => {
  const { createHash } = await import('node:crypto')
  const source = await original<{ default: { packages: Array<Record<string, unknown>> }; [key: string]: unknown }>()
  const libDigest = createHash('sha256').update('export const synthetic = true\n').digest('hex')
  const packages = source.default.packages.map((row) => ({
    ...row,
    modules: {
      'package.json': createHash('sha256').update(JSON.stringify({ name: row.name, version: row.version, type: 'module', main: 'lib/index.js' }) + '\n', 'utf8').digest('hex'),
      'lib/index.js': libDigest,
    },
  }))
  return { default: { ...source.default, packages } }
})

const temporaryRoots: string[] = []
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-desktop-'))
  temporaryRoots.push(root)
  return root
}
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function writeDesktopProfile(root: string, options?: {
  name?: string
  bundles?: string[]
  dependencies?: Record<string, string>
  withModules?: boolean
  pluginVersion?: string
}): string {
  const profile = join(root, 'profiles', 'desktop')
  mkdirSync(profile, { recursive: true })
  const manifest: Record<string, unknown> = {
    name: options?.name ?? DESKTOP_PROFILE_PACKAGE_NAME,
    private: true,
    dependencies: options?.dependencies ?? {},
    dsh: { profile: { bundles: options?.bundles ?? [
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app',
      '@deepseek-ai/dsh-experimental-auto-review', '@deepseek-ai/dsh-experimental-schedule-bundle',
      ...(options?.withModules ? ['dsh-completion-guard'] : []),
    ] } },
  }
  writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest, null, 2))
  if (options?.withModules) {
    const modules = join(profile, 'node_modules')
    mkdirSync(join(modules, 'dsh-completion-guard'), { recursive: true })
    writeFileSync(join(modules, 'dsh-completion-guard', 'package.json'), JSON.stringify({ name: 'dsh-completion-guard', version: options.pluginVersion }))
    writeFileSync(join(profile, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\npackages: {}\nsnapshots:\n")
    writeFileSync(join(modules, '.package-map.json'), JSON.stringify({ packages: { '.': { url: '..', dependencies: { 'dsh-completion-guard': 'dsh-completion-guard' } }, 'dsh-completion-guard': { url: './dsh-completion-guard', dependencies: {} } } }))
  }
  return profile
}

// ---------------------------------------------------------------------------

describe('desktop asar adapter', () => {
  it('reads the official runtime identity in place from the app bundle', () => {
    const root = temporaryRoot()
    const asar = writeAsar(bundleFileSpecs(), root)
    const runtime = readDesktopAppRuntime(asar)
    expect(runtime.hostVersion).toBe(RC2_VERSION)
    expect(runtime.runtimeVersion).toBe(RC2_VERSION)
    expect(runtime.metadata.fileTableEntries).toBe(92)
    expect(runtime.rows.map((row) => row.name).sort()).toEqual(RC020_RC2_HOST_PACKAGES.map((row) => row.name).sort())
    expect(runtime.rows.every((row) => row.integrity === undefined)).toBe(true)
    // The exact bundle bytes are bound, and a tampered header is a new identity.
    expect(runtime.headerSha256).toBe(readAsarIndex(asar).headerSha256)
  })

  it('reads a dependency manifest entry through the bounded asar reader', () => {
    const root = temporaryRoot()
    const asar = writeAsar(bundleFileSpecs(), root)
    expect(readDesktopDependency(asar, '@deepseek-ai/dsh-session')).toEqual({ name: '@deepseek-ai/dsh-session', version: RC2_VERSION })
    expect(() => readDesktopDependency(asar, '@deepseek-ai/dsh-nonexistent')).toThrow()
  })

  it('fails closed on a bundle without the official carrier, manifest, or metadata', () => {
    const root = temporaryRoot()
    const withoutCarrier = writeAsar(bundleFileSpecs({ carrier: false }), root)
    expect(() => readDesktopAppRuntime(withoutCarrier)).toThrowError(/carrier/)
    const foreign = writeAsar(bundleFileSpecs().map((file) => file.path === 'dsh/package.json'
      ? { ...file, content: Buffer.from(JSON.stringify({ name: '@evil/desktop-runtime', version: RC2_VERSION, dependencies: {} }), 'utf8') }
      : file), root)
    expect(() => readDesktopAppRuntime(foreign)).toThrowError(/official desktop runtime/)
    const stale = writeAsar(bundleFileSpecs({ hostVersion: '0.2.0-rc.1' }), root)
    expect(() => readDesktopAppRuntime(stale)).toThrowError(/admitted host version/)
    const incomplete = writeAsar(bundleFileSpecs({ metadata: { ...makeDesktopMetadata(), release: { schemaVersion: 1, version: 'not-a-version', hostProtocolVersion: 4, nodeVersion: '24.21.0', pnpmVersion: '11.7.0' } } }), root)
    expect(() => readDesktopAppRuntime(incomplete)).toThrowError(/metadata/)
    const noFileTable = writeAsar(bundleFileSpecs({ metadata: { ...makeDesktopMetadata(), files: [] } }), root)
    expect(() => readDesktopAppRuntime(noFileTable)).toThrowError(/metadata/)
    expect(() => readDesktopAppRuntime(join(root, 'missing.asar'))).toThrowError(/not found/)
  })
})

describe('desktop installed-byte audit', () => {
  it('refuses an extra executable even when a replacement table self-attests it', () => {
    const root = temporaryRoot()
    const path = 'node_modules/@deepseek-ai/dsh-session/lib/redirect.js'
    const content = Buffer.from('export const redirected = true\n')
    const metadata = makeDesktopMetadata()
    ;(metadata.files as Array<unknown>).push({ path, sha256: createHash('sha256').update(content).digest('hex') })
    const files = bundleFileSpecs({ metadata })
    files.push({ path: `dsh/${path}`, content })
    const expectations = RC020_RC2_HOST_PACKAGES.map((row) => ({
      name: row.name, version: row.version, modules: {
        'package.json': createHash('sha256').update(syntheticManifestBytes(row.name, row.version as string)).digest('hex'),
        'lib/index.js': SYNTHETIC_MODULES['lib/index.js'],
      },
    }))
    expect(auditDesktopInstalledImplementation(writeAsar(files, root), expectations)).toBe(false)
  })
  it('verifies the closed module inventory of every critical package', () => {
    const root = temporaryRoot()
    const asar = writeAsar(bundleFileSpecs(), root)
    const expectations = RC020_RC2_HOST_PACKAGES.map((row) => ({
      name: row.name, version: row.version, modules: {
        'package.json': createHash('sha256').update(syntheticManifestBytes(row.name, row.version as string)).digest('hex'),
        'lib/index.js': SYNTHETIC_MODULES['lib/index.js'],
      },
    }))
    expect(auditDesktopInstalledImplementation(asar, expectations)).toBe(true)
    // One changed byte anywhere in an audited package is a failed audit.
    const tampered = writeAsar(bundleFileSpecs().map((file) => file.path === 'dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js'
      ? { ...file, content: Buffer.from(SYNTHETIC_LIB_BYTES.replace('true', 'false'), 'utf8') }
      : file), root)
    expect(auditDesktopInstalledImplementation(tampered, expectations)).toBe(false)
    // A missing package fails closed.
    const shortExpectations = expectations.slice(0, -1)
    expect(auditDesktopInstalledImplementation(asar, shortExpectations)).toBe(false)
  })

  it('refuses a critical package that also exists nested inside the app graph', async () => {
    const root = temporaryRoot()
    const files = bundleFileSpecs()
    files.push({ path: 'dsh/node_modules/@deepseek-ai/dsh-tool-jobs/node_modules/@deepseek-ai/dsh-session/package.json', content: Buffer.from('{}\n', 'utf8') })
    files.push({ path: 'dsh/node_modules/@deepseek-ai/dsh-tool-jobs/node_modules/@deepseek-ai/dsh-session/lib/index.js', content: Buffer.from('shadow\n', 'utf8') })
    const asar = writeAsar(files, root)
    const expectations = RC020_RC2_HOST_PACKAGES.map((row) => ({
      name: row.name, version: row.version, modules: {
        'package.json': createHash('sha256').update(syntheticManifestBytes(row.name, row.version as string)).digest('hex'),
        'lib/index.js': SYNTHETIC_MODULES['lib/index.js'],
      },
    }))
    expect(() => auditDesktopInstalledImplementation(asar, expectations)).toThrowError(/nested/)
  })
})

describe('desktop profile identity and preflight', () => {
  it('inspects the dependency-free desktop profile against the official bundle', () => {
    const root = temporaryRoot()
    const asar = writeAsar(bundleFileSpecs(), root)
    const profile = writeDesktopProfile(root)
    const target = inspectDesktopTargetGraph(asar, profile)
    expect(target.profileGraph.state).toBe('dependency_free_desktop')
    expect(target.packages.map((row) => row.name).sort()).toEqual(RC020_RC2_HOST_PACKAGES.map((row) => row.name).sort())
  })

  it('fails closed on a foreign profile name, conflicting bundles, or declared dependencies', () => {
    const root = temporaryRoot()
    const asar = writeAsar(bundleFileSpecs(), root)
    expect(() => inspectDesktopTargetGraph(asar, writeDesktopProfile(root, { name: 'dsh-profile-web' }))).toThrowError(/not the Desktop-owned/)
    expect(() => inspectDesktopTargetGraph(asar, writeDesktopProfile(root, { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dshmarket'] }))).toThrowError(/web\/headless-only bundle/)
    expect(() => inspectDesktopTargetGraph(asar, writeDesktopProfile(root, { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless'] }))).toThrowError(/web\/headless-only bundle/)
    expect(() => inspectDesktopTargetGraph(asar, writeDesktopProfile(root, { dependencies: { 'dsh-completion-guard': '0.8.2' } }))).toThrowError(/without an importer/)
  })
})

describe('desktop runtime attach (revalidation)', () => {
  it('carries the full injected identity through composition and the production runtime entry', () => {
    const root = temporaryRoot(), asar = writeAsar(bundleFileSpecs(), root), profile = importerProfile(root)
    const active = resolveActiveProfileHostLock(asar, profile, '0.8.2')
    const patch = injectActiveProfileHostLock(active)
    const text = readFileSync(patch, 'utf8')
    expect(text).toContain(`hostLockDesktopDigest: "${active.evaluation.digest}"`)
    expect(verifyComposedHostLockDump(text, active.evaluation, active).digest).toBe(active.evaluation.digest)
    const config = resolveConfig({ activation: 'always', hostLockPackages: active.evaluation.packages,
      hostLockPlatform: active.platform, hostLockProfile: 'desktop', hostLockPolicy: 'dsh-core/v1',
      hostLockRuntimeRoot: asar, hostLockProfileRoot: profile, hostLockDesktopDigest: active.evaluation.digest })
    const expected = evaluateConfiguredHostLock(config.hostLockPackages!, { platform: active.platform, profileKind: 'desktop' })
    expect(revalidateCoreLock(config, expected)).toMatchObject({ status: 'supported', digest: active.evaluation.digest })
    expect(revalidateCoreLock({ ...config, hostLockDesktopDigest: undefined }, expected)).toMatchObject({
      status: 'unavailable', reasonCode: 'host_lock_migration_required' })
    expect(revalidateCoreLock({ ...config, hostLockDesktopDigest: 'a'.repeat(64) }, expected)).toMatchObject({
      status: 'unsupported', reasonCode: 'host_lock_installed_graph_drift' })
    const changedRows = config.hostLockPackages!.map(row => row.name === '@deepseek-ai/dsh-session'
      ? { ...row, integrity: 'sha512-untrusted' } : row)
    expect(revalidateCoreLock({ ...config, hostLockPackages: changedRows }, expected).status).not.toBe('supported')
    for (const altered of [text.replace(active.evaluation.digest, 'a'.repeat(64)),
      text.replace(/^    hostLockDesktopDigest:.*\n/m, ''),
      text.replace(/^    hostLockDesktopDigest:(.*)$/m, '    hostLockDesktopDigest:$1\n    hostLockDesktopDigest:$1')]) {
      expect(() => verifyComposedHostLockDump(altered, active.evaluation, active)).toThrow(/Desktop identity/)
    }
    writeAsar(bundleFileSpecs({ metadata: { ...makeDesktopMetadata(), arch: 'x64' } }), root)
    expect(revalidateCoreLock(config, expected)).toMatchObject({ status: 'unsupported', reasonCode: 'host_lock_installed_graph_drift' })
  })
  function importerProfile(root: string): string {
    const profile = writeDesktopProfile(root, {
      withModules: true, pluginVersion: '0.8.2',
      dependencies: { 'dsh-completion-guard': '0.8.2' },
    })
    return profile
  }

  function physicalImporterProfile(root: string): string {
    const profile = importerProfile(root)
    rmSync(join(profile, 'node_modules', '.package-map.json'))
    writeFileSync(join(profile, 'node_modules', '.modules.yaml'), JSON.stringify({
      nodeLinker: 'hoisted', layoutVersion: 5, packageManager: 'pnpm@11.7.0',
      hoistedLocations: { 'dsh-completion-guard@file:../guard.tgz': ['node_modules/dsh-completion-guard'] },
    }))
    const guard = join(profile, 'node_modules', 'dsh-completion-guard')
    mkdirSync(join(guard, 'dist'))
    writeFileSync(join(guard, 'dist', 'index.js'), 'export const name = "context-guard"\n')
    writeFileSync(join(guard, 'package.json'), JSON.stringify({ name: 'dsh-completion-guard', version: '0.8.2',
      main: 'dist/index.js', peerDependencies: { '@deepseek-ai/dsh-session': '>=0.2.0-rc.2' } }))
    return profile
  }

  it('accepts the bundled pnpm 11.7 physical importer and freshly binds its index', () => {
    const root = temporaryRoot(), asar = writeAsar(bundleFileSpecs(), root)
    const profile = physicalImporterProfile(root)
    const active = resolveActiveProfileHostLock(asar, profile, '0.8.2')
    expect(revalidateDesktopCoreLock(asar, profile, active.evaluation).digest).toBe(active.evaluation.digest)
    const path = join(profile, 'node_modules', '.modules.yaml')
    const metadata = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify({ ...metadata, prunedAt: 'different index bytes' }))
    expect(revalidateDesktopCoreLock(asar, profile, active.evaluation).digest).not.toBe(active.evaluation.digest)
  })

  it.each(['unsupported-manager', 'wrong-linker', 'omitted-package', 'invented-package', 'escaped-location', 'missing-index'])
  ('refuses an invalid physical importer: %s', (change) => {
    const root = temporaryRoot(), asar = writeAsar(bundleFileSpecs(), root)
    const profile = physicalImporterProfile(root)
    const path = join(profile, 'node_modules', '.modules.yaml')
    const metadata = JSON.parse(readFileSync(path, 'utf8'))
    if (change === 'unsupported-manager') metadata.packageManager = 'pnpm@99.0.0'
    if (change === 'wrong-linker') metadata.nodeLinker = 'isolated'
    if (change === 'omitted-package') metadata.hoistedLocations = {}
    if (change === 'invented-package') metadata.hoistedLocations['absent@1.0.0'] = ['node_modules/absent']
    if (change === 'escaped-location') metadata.hoistedLocations['dsh-completion-guard@file:../guard.tgz'] = ['node_modules/../outside']
    writeFileSync(path, JSON.stringify(metadata))
    if (change === 'missing-index') rmSync(path)
    expect(() => resolveActiveProfileHostLock(asar, profile, '0.8.2')).toThrow()
  })

  it('audits local critical bytes and rejects nested duplicates in a physical importer', () => {
    const root = temporaryRoot(), asar = writeAsar(bundleFileSpecs(), root)
    const profile = physicalImporterProfile(root)
    const row = RC020_RC2_HOST_PACKAGES.find(row => row.name === '@deepseek-ai/dsh-session')!
    const local = join(profile, 'node_modules', row.name)
    mkdirSync(join(local, 'lib'), { recursive: true })
    writeFileSync(join(local, 'package.json'), syntheticManifestBytes(row.name, row.version!))
    writeFileSync(join(local, 'lib', 'index.js'), SYNTHETIC_LIB_BYTES)
    // A nearer package omitted from pnpm's index must never become fallback.
    expect(() => resolveActiveProfileHostLock(asar, profile, '0.8.2')).toThrow()
    const path = join(profile, 'node_modules', '.modules.yaml')
    const metadata = JSON.parse(readFileSync(path, 'utf8'))
    metadata.hoistedLocations[`${row.name}@${row.version}`] = ['node_modules/' + row.name]
    writeFileSync(path, JSON.stringify(metadata))
    writeFileSync(join(profile, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\npackages:\n  '${row.name}@${row.version}':\n    resolution: {integrity: ${row.integrity}}\nsnapshots: {}\n`)
    const active = resolveActiveProfileHostLock(asar, profile, '0.8.2')
    writeFileSync(join(local, 'lib', 'index.js'), 'export const synthetic = false\n')
    expect(revalidateDesktopCoreLock(asar, profile, active.evaluation).status).toBe('unsupported')
    writeFileSync(join(local, 'lib', 'index.js'), SYNTHETIC_LIB_BYTES)
    const nestedId = 'dsh-completion-guard/node_modules/' + row.name
    const nested = join(profile, 'node_modules', nestedId)
    mkdirSync(join(nested, 'lib'), { recursive: true })
    writeFileSync(join(nested, 'package.json'), syntheticManifestBytes(row.name, row.version!))
    writeFileSync(join(nested, 'lib', 'index.js'), SYNTHETIC_LIB_BYTES)
    metadata.hoistedLocations[`${row.name}@${row.version}`].push('node_modules/' + nestedId)
    writeFileSync(path, JSON.stringify(metadata))
    expect(() => resolveActiveProfileHostLock(asar, profile, '0.8.2')).toThrow()
  })

  it('rejects a nearer critical shadow below the physical Guard entrypoint', () => {
    const root = temporaryRoot(), asar = writeAsar(bundleFileSpecs(), root)
    const profile = physicalImporterProfile(root)
    const shadow = join(profile, 'node_modules/dsh-completion-guard/dist/node_modules/@deepseek-ai/dsh-session')
    mkdirSync(join(shadow, 'lib'), { recursive: true })
    writeFileSync(join(shadow, 'package.json'), syntheticManifestBytes('@deepseek-ai/dsh-session', RC2_VERSION))
    writeFileSync(join(shadow, 'lib', 'index.js'), SYNTHETIC_LIB_BYTES)
    expect(() => resolveActiveProfileHostLock(asar, profile, '0.8.2')).toThrow()
  })

  it('rejects a physical importer index redirected outside its profile', () => {
    const root = temporaryRoot(), asar = writeAsar(bundleFileSpecs(), root)
    const profile = physicalImporterProfile(root), path = join(profile, 'node_modules/.modules.yaml')
    const outside = join(root, 'external-index.json')
    writeFileSync(outside, readFileSync(path))
    rmSync(path)
    symlinkSync(outside, path)
    expect(() => resolveActiveProfileHostLock(asar, profile, '0.8.2')).toThrow()
  })

  it('does not treat a pre-install profile as an active protected installation', () => {
    const root = temporaryRoot()
    const asar = writeAsar(bundleFileSpecs(), root)
    expect(() => resolveActiveProfileHostLock(asar, writeDesktopProfile(root), '0.8.2')).toThrow(/importer/)
  })

  it('rejects a changed package entry route despite matching package version and module bytes', () => {
    const root = temporaryRoot()
    const files = bundleFileSpecs().map((file) => file.path === 'dsh/node_modules/@deepseek-ai/dsh-session/package.json'
      ? { ...file, content: Buffer.from(JSON.stringify({ name: '@deepseek-ai/dsh-session', version: RC2_VERSION, type: 'module', main: 'lib/missing.js' }) + '\n') }
      : file)
    const metadata = makeDesktopMetadata()
    const table = metadata.files as Array<{ path: string; sha256: string }>
    const manifest = files.find(file => file.path === 'dsh/node_modules/@deepseek-ai/dsh-session/package.json')!
    table.find(row => row.path === 'node_modules/@deepseek-ai/dsh-session/package.json')!.sha256 = createHash('sha256').update(manifest.content).digest('hex')
    const asar = writeAsar(files.map(file => file.path === 'dsh/desktop-runtime.json' ? { ...file, content: Buffer.from(JSON.stringify(metadata)) } : file), root)
    expect(() => resolveActiveProfileHostLock(asar, importerProfile(root), '0.8.2')).toThrow(/qualified published implementation/)
  })

  it('authenticates locally selected critical peers rather than deduplicating their claimed identity', () => {
    const root = temporaryRoot()
    const asar = writeAsar(bundleFileSpecs(), root)
    const profile = importerProfile(root)
    const row = RC020_RC2_HOST_PACKAGES.find(row => row.name === '@deepseek-ai/dsh-session')!
    const packageRoot = join(profile, 'node_modules', row.name)
    mkdirSync(join(packageRoot, 'lib'), { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), syntheticManifestBytes(row.name, row.version!))
    writeFileSync(join(packageRoot, 'lib', 'index.js'), SYNTHETIC_LIB_BYTES)
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
    manifest.dependencies[row.name] = row.version
    writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest))
    writeFileSync(join(profile, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\npackages:\n  '${row.name}@${row.version}':\n    resolution: {integrity: ${row.integrity}}\nsnapshots: {}\n`)
    const mapPath = join(profile, 'node_modules', '.package-map.json')
    const map = JSON.parse(readFileSync(mapPath, 'utf8'))
    map.packages['.'].dependencies[row.name] = row.name
    map.packages[row.name] = { url: './' + row.name, dependencies: { [row.name]: row.name } }
    writeFileSync(mapPath, JSON.stringify(map))
    const active = resolveActiveProfileHostLock(asar, profile, '0.8.2')
    expect(active.evaluation.status).toBe('supported')
    writeFileSync(join(packageRoot, 'lib', 'index.js'), 'export const synthetic = false\n')
    expect(revalidateDesktopCoreLock(asar, profile, active.evaluation).status).toBe('unsupported')
    writeFileSync(join(packageRoot, 'lib', 'index.js'), SYNTHETIC_LIB_BYTES)
    expect(revalidateDesktopCoreLock(asar, profile, active.evaluation).digest).toBe(active.evaluation.digest)
  })

  it('refuses a receipt directory symlink before writing outside the profile', () => {
    const root = temporaryRoot()
    const asar = writeAsar(bundleFileSpecs(), root)
    const profile = importerProfile(root)
    const outside = join(root, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(profile, '.dsh-completion-guard'), 'junction')
    expect(() => resolveActiveProfileHostLock(asar, profile, '0.8.2')).toThrow(/physical directory/)
    expect(() => readFileSync(join(outside, 'desktop'))).toThrow()
  })

  it('inject-shape resolution and fresh revalidation agree on the digest', () => {
    const root = temporaryRoot()
    const asar = writeAsar(bundleFileSpecs(), root)
    const profile = importerProfile(root)
    const active = resolveActiveProfileHostLock(asar, profile, '0.8.2')
    expect(active.profileKind).toBe('desktop')
    expect(realpathSync(active.runtimeRoot)).toBe(realpathSync(asar))
    expect(active.evaluation.status).toBe('supported')
    const revalidated = revalidateDesktopCoreLock(asar, profile, active.evaluation)
    expect(revalidated.status).toBe('supported')
    expect(revalidated.digest).toBe(active.evaluation.digest)
  })

  it('binds archive metadata changes into the injected identity', () => {
    const root = temporaryRoot()
    const asar = writeAsar(bundleFileSpecs(), root)
    const profile = importerProfile(root)
    const active = resolveActiveProfileHostLock(asar, profile, '0.8.2')
    const metadata = { ...makeDesktopMetadata(), arch: 'x64' }
    writeAsar(bundleFileSpecs({ metadata }), root)
    const changed = revalidateDesktopCoreLock(asar, profile, active.evaluation)
    expect(changed.status !== 'supported' || changed.digest !== active.evaluation.digest).toBe(true)
  })

  it('a plugin version mismatch in the profile importer refuses the desktop lock', () => {
    const root = temporaryRoot()
    const asar = writeAsar(bundleFileSpecs(), root)
    const profile = writeDesktopProfile(root, {
      withModules: true, pluginVersion: '0.8.1',
      dependencies: { 'dsh-completion-guard': '0.8.1' },
    })
    expect(() => resolveActiveProfileHostLock(asar, profile, '0.8.2')).toThrowError(/plugin identity/)
  })
})

describe('desktop host-lock identity', () => {
  it('desktop is an accepted injected profile kind and is bound into the digest', () => {
    const resolved = resolveConfig({
      hostLockPackages: RC020_RC2_HOST_PACKAGES,
      hostLockPlatform: 'posix',
      hostLockProfile: 'desktop',
    })
    expect(resolved.hostLockProfile).toBe('desktop')
    const desktop = evaluateHostLock(RC020_RC2_HOST_PACKAGES, { platform: 'posix', profileKind: 'desktop' })
    const web = evaluateHostLock(RC020_RC2_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' })
    const headless = evaluateHostLock(RC020_RC2_HOST_PACKAGES, { platform: 'posix', profileKind: 'headless' })
    expect(new Set([desktop.digest, web.digest, headless.digest]).size).toBe(3)
    expect(desktop.status).toBe('supported')
  })

  it('a desktop profile never receives the web restart capability', () => {
    const desktop = evaluateHostLock(RC020_RC2_HOST_PACKAGES, { platform: 'posix', profileKind: 'desktop' })
    const web = evaluateHostLock(RC020_RC2_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' })
    expect(evaluateHostCapability(web, { action: 'restart', platform: 'posix', profileKind: 'web' }).status).toBe('supported')
    const restart = evaluateHostCapability(desktop, { action: 'restart', platform: 'posix', profileKind: 'desktop' })
    expect(restart.status).toBe('unavailable')
    expect(restart.reasonCode).toBe('host_capability_request_unsupported')
  })

  it('an unknown injected profile kind is still rejected by the config schema', () => {
    expect(() => resolveConfig({
      hostLockPackages: RC020_RC2_HOST_PACKAGES, hostLockPlatform: 'posix',
      hostLockProfile: 'electron' as unknown as HostProfileKind,
    })).toThrow(/hostLockProfile/)
  })
})
