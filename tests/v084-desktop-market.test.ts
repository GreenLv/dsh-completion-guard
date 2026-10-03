import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

import { RC020_RC2_HOST_PACKAGES } from '../src/domain/rc020-rc2-host.js'
import {
  readDesktopTargetGraph,
  DESKTOP_PROFILE_PACKAGE_NAME,
} from '../src/domain/host-desktop.js'
import {
  evaluateConfiguredHostLock,
  injectActiveProfileHostLock,
  inspectDesktopTargetGraph,
  resolveActiveProfileHostLock,
  revalidateDesktopCoreLock,
  verifyComposedHostLockDump,
} from '../src/domain/host-resolver.js'
import { evaluateHostCapability, evaluateHostLock, EXPECTED_HOST_PACKAGES, type HostProfileKind } from '../src/domain/host-lock.js'
import type { PackageRow } from '../src/domain/digest.js'
import { ACTION_MANIFEST } from '../src/domain/protocol-manifest.js'
import { resolveConfig } from '../src/config.js'
import { revalidateCoreLock } from '../src/runtime.js'

// DM01–DM16 regression matrix for Desktop + dshmarket coexistence (0.8.4).
// 0.8.3 hard-coded the market package name as a web/headless-only bundle and
// refused every official Desktop profile carrying it, through the pre-install
// target graph (`desktop_profile_bundle_conflict`) and the installed/runtime
// verification (`profile_plugin_unbound`). The market is an ordinary
// third-party profile plugin: its name must neither conflict with the
// official Desktop bundle tuple nor grant any trust. Every fail-closed gate
// around it — official identity, Guard binding, headless conflict, runtime
// and importer integrity, byte/route audits, lock digests — must keep
// rejecting the configurations in the negative controls. Drift assertions go
// through the production runtime entry `revalidateCoreLock`, which is the
// only place an injected digest is compared against a fresh validation.

vi.mock('../src/domain/host-desktop-identity.js', () => ({
  verifyDesktopCarrier: (archive: string) => archive,
}))

const SYNTHETIC_LIB_BYTES = 'export const synthetic = true\n'
const SYNTHETIC_MODULES: Record<string, string> = {
  'package.json': 'SYNTHETIC_PACKAGE_JSON_PLACEHOLDER',
  'lib/index.js': createHash('sha256').update(SYNTHETIC_LIB_BYTES).digest('hex'),
}

function syntheticManifestBytes(name: string, version: string): Buffer {
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
  return Buffer.concat([prefix, json, padding, Buffer.concat(files.map((file) => file.content))])
}

const RC2_VERSION = '0.2.0-rc.2'
const PLUGIN_VERSION = '0.8.4'
const OFFICIAL_DESKTOP_BUNDLES = [
  '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-experimental-auto-review', '@deepseek-ai/dsh-experimental-schedule-bundle',
]

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

function bundleFileSpecs(options?: { hostVersion?: string; metadata?: Record<string, unknown> }): AsarFileSpec[] {
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
    { path: 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js', content: Buffer.from('export {}\n', 'utf8') },
  ]
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
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-desktop-market-'))
  temporaryRoots.push(root)
  return root
}
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface ProfileOptions {
  name?: string
  /** Profile directory name below `<root>/profiles/` (default `desktop`). */
  dirName?: string
  bundles?: string[]
  dependencies?: Record<string, string>
  withModules?: boolean
  pluginVersion?: string
  /** Extra installed profile packages (e.g. the market) in the importer. */
  extraInstalled?: Array<{ name: string; version: string }>
  omitMap?: boolean
  omitLock?: boolean
}

function writeDesktopProfile(root: string, options?: ProfileOptions): string {
  const profile = join(root, 'profiles', options?.dirName ?? 'desktop')
  mkdirSync(profile, { recursive: true })
  const bundles = options?.bundles ?? [...OFFICIAL_DESKTOP_BUNDLES, ...(options?.withModules ? ['dsh-completion-guard'] : [])]
  const manifest: Record<string, unknown> = {
    name: options?.name ?? DESKTOP_PROFILE_PACKAGE_NAME,
    private: true,
    dependencies: options?.dependencies ?? (options?.withModules ? { 'dsh-completion-guard': options?.pluginVersion ?? PLUGIN_VERSION } : {}),
    dsh: { profile: { bundles } },
  }
  writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest, null, 2))
  if (options?.withModules) {
    const modules = join(profile, 'node_modules')
    const installed = [
      { name: 'dsh-completion-guard', version: options?.pluginVersion ?? PLUGIN_VERSION },
      ...(options?.extraInstalled ?? []),
    ]
    const mapPackages: Record<string, unknown> = { '.': { url: '..', dependencies: Object.fromEntries(installed.map((row) => [row.name, row.name])) } }
    for (const row of installed) {
      mkdirSync(join(modules, row.name), { recursive: true })
      writeFileSync(join(modules, row.name, 'package.json'), JSON.stringify({ name: row.name, version: row.version, dependencies: {} }))
      mapPackages[row.name] = { url: `./${row.name}`, dependencies: { [row.name]: row.name } }
    }
    if (!options?.omitMap) writeFileSync(join(modules, '.package-map.json'), JSON.stringify({ packages: mapPackages }))
    if (!options?.omitLock) writeFileSync(join(profile, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\npackages: {}\nsnapshots:\n")
  }
  return profile
}

/** pnpm 11.7 physical hoisted importer: every installed package must appear
 * both on disk and in the JSON .modules.yaml index. */
function writeHoistedProfile(root: string, options?: ProfileOptions): string {
  const profile = writeDesktopProfile(root, { ...options, omitMap: true, omitLock: false })
  const modules = join(profile, 'node_modules')
  const installed = [
    { name: 'dsh-completion-guard', version: options?.pluginVersion ?? PLUGIN_VERSION, reference: 'dsh-completion-guard@file:../guard.tgz' },
    ...(options?.extraInstalled ?? []).map((row) => ({ ...row, reference: `${row.name}@${row.version}` })),
  ]
  writeFileSync(join(modules, '.modules.yaml'), JSON.stringify({
    nodeLinker: 'hoisted', layoutVersion: 5, packageManager: 'pnpm@11.7.0',
    hoistedLocations: Object.fromEntries(installed.map((row) => [row.reference, [`node_modules/${row.name}`]])),
  }))
  const guard = join(modules, 'dsh-completion-guard')
  mkdirSync(join(guard, 'dist'), { recursive: true })
  writeFileSync(join(guard, 'dist', 'index.js'), 'export const name = "context-guard"\n')
  writeFileSync(join(guard, 'package.json'), JSON.stringify({ name: 'dsh-completion-guard', version: options?.pluginVersion ?? PLUGIN_VERSION,
    main: 'dist/index.js', peerDependencies: { '@deepseek-ai/dsh-session': '>=0.2.0-rc.2' } }))
  return profile
}

function desktopRuntimeConfig(asar: string, profile: string, digest: string, packages: readonly PackageRow[]) {
  return resolveConfig({ activation: 'always', hostLockPackages: packages, hostLockPlatform: process.platform === 'win32' ? 'windows' : 'posix',
    hostLockProfile: 'desktop', hostLockPolicy: 'dsh-core/v1', hostLockRuntimeRoot: asar, hostLockProfileRoot: profile,
    hostLockDesktopDigest: digest })
}

/** Simulates the app's plugin manager installing the market into the profile:
 * manifest bundles + dependency, the installed package, and — for the
 * package-map layout — the importer map entry. The pnpm-lock.yaml bytes are
 * left to the caller because the core lock reads no market row from it. */
function installMarketFixture(profile: string, options?: { map?: boolean }): void {
  const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } }
  }
  manifest.dependencies.dshmarket = '1.66.6'
  manifest.dsh.profile.bundles = [...manifest.dsh.profile.bundles, 'dshmarket']
  writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest, null, 2))
  mkdirSync(join(profile, 'node_modules', 'dshmarket'), { recursive: true })
  writeFileSync(join(profile, 'node_modules', 'dshmarket', 'package.json'), JSON.stringify({ name: 'dshmarket', version: '1.66.6', dependencies: {} }))
  if (options?.map === false) return
  const mapPath = join(profile, 'node_modules', '.package-map.json')
  const map = JSON.parse(readFileSync(mapPath, 'utf8')) as { packages: Record<string, { url?: string; dependencies: Record<string, string> }> }
  map.packages.dshmarket = { url: './dshmarket', dependencies: { dshmarket: 'dshmarket' } }
  map.packages['.'].dependencies.dshmarket = 'dshmarket'
  writeFileSync(mapPath, JSON.stringify({ packages: map.packages }))
}

function removeMarketFixture(profile: string, options?: { map?: boolean }): void {
  const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } }
  }
  delete manifest.dependencies.dshmarket
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name) => name !== 'dshmarket')
  writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest, null, 2))
  rmSync(join(profile, 'node_modules', 'dshmarket'), { recursive: true, force: true })
  if (options?.map === false) return
  const mapPath = join(profile, 'node_modules', '.package-map.json')
  const map = JSON.parse(readFileSync(mapPath, 'utf8')) as { packages: Record<string, { url?: string; dependencies: Record<string, string> }> }
  delete map.packages.dshmarket
  delete map.packages['.'].dependencies.dshmarket
  writeFileSync(mapPath, JSON.stringify({ packages: map.packages }))
}

describe('DM01/DM02 full-chain coexistence (package-map importer)', () => {
  function fullChain(root: string, bundles?: string[]) {
    const asar = writeAsar(bundleFileSpecs(), root)
    const profile = writeDesktopProfile(root, {
      withModules: true, pluginVersion: PLUGIN_VERSION, dependencies: { 'dsh-completion-guard': PLUGIN_VERSION }, bundles,
    })
    return { asar, profile }
  }

  it('DM01: without the market the whole chain stays desktop and supported', () => {
    const root = temporaryRoot()
    const { asar, profile } = fullChain(root)
    const target = inspectDesktopTargetGraph(asar, writeDesktopProfile(root, { dirName: 'dependency-free' }))
    expect(target.profileGraph.state).toBe('dependency_free_desktop')
    const active = resolveActiveProfileHostLock(asar, profile, PLUGIN_VERSION)
    expect(active.profileKind).toBe('desktop')
    expect(active.evaluation.status).toBe('supported')
    const patch = injectActiveProfileHostLock(active)
    const text = readFileSync(patch, 'utf8')
    expect(verifyComposedHostLockDump(text, active.evaluation, active).digest).toBe(active.evaluation.digest)
    const config = resolveConfig({ activation: 'always', hostLockPackages: active.evaluation.packages,
      hostLockPlatform: active.platform, hostLockProfile: 'desktop', hostLockPolicy: 'dsh-core/v1',
      hostLockRuntimeRoot: asar, hostLockProfileRoot: profile, hostLockDesktopDigest: active.evaluation.digest })
    expect(revalidateCoreLock(config, evaluateConfiguredHostLock(config.hostLockPackages!, { platform: active.platform, profileKind: 'desktop' })))
      .toMatchObject({ status: 'supported', digest: active.evaluation.digest })
  })

  it('DM02: with dshmarket the same chain stays desktop, supported, and Guard stays usable', () => {
    const root = temporaryRoot()
    const { asar, profile } = fullChain(root, [...OFFICIAL_DESKTOP_BUNDLES, 'dsh-completion-guard', 'dshmarket'])
    const preInstall = inspectDesktopTargetGraph(asar, writeDesktopProfile(root, {
      dirName: 'dependency-free', bundles: [...OFFICIAL_DESKTOP_BUNDLES, 'dshmarket'],
    }))
    expect(preInstall.profileGraph.state).toBe('dependency_free_desktop')
    expect(preInstall.profileGraph.bundles).toContain('dshmarket')
    const active = resolveActiveProfileHostLock(asar, profile, PLUGIN_VERSION)
    expect(active.profileKind).toBe('desktop')
    expect(active.evaluation.status).toBe('supported')
    expect(active.evaluation.goalAvailable).toBe(true)
    const patch = injectActiveProfileHostLock(active)
    const text = readFileSync(patch, 'utf8')
    expect(verifyComposedHostLockDump(text, active.evaluation, active).digest).toBe(active.evaluation.digest)
    const config = resolveConfig({ activation: 'always', hostLockPackages: active.evaluation.packages,
      hostLockPlatform: active.platform, hostLockProfile: 'desktop', hostLockPolicy: 'dsh-core/v1',
      hostLockRuntimeRoot: asar, hostLockProfileRoot: profile, hostLockDesktopDigest: active.evaluation.digest })
    expect(revalidateCoreLock(config, evaluateConfiguredHostLock(config.hostLockPackages!, { platform: active.platform, profileKind: 'desktop' })))
      .toMatchObject({ status: 'supported', digest: active.evaluation.digest })
    // The market contributes no rows to the core lock and the injected dump
    // never claims it.
    expect(text).not.toContain('dshmarket')
  })

  it('DM02-hoisted: the pnpm 11.7 physical importer accepts the market next to Guard', () => {
    const root = temporaryRoot()
    const asar = writeAsar(bundleFileSpecs(), root)
    const profile = writeHoistedProfile(root, {
      withModules: true, dependencies: { 'dsh-completion-guard': PLUGIN_VERSION, dshmarket: '1.66.6' },
      bundles: [...OFFICIAL_DESKTOP_BUNDLES, 'dsh-completion-guard', 'dshmarket'],
      extraInstalled: [{ name: 'dshmarket', version: '1.66.6' }],
    })
    const active = resolveActiveProfileHostLock(asar, profile, PLUGIN_VERSION)
    expect(active.profileKind).toBe('desktop')
    expect(active.evaluation.status).toBe('supported')
    expect(revalidateDesktopCoreLock(asar, profile, active.evaluation).digest).toBe(active.evaluation.digest)
  })
})

describe('DM03–DM06 classification and third-party scope', () => {
  it('DM03: another third-party profile plugin is classified like the market', () => {
    const root = temporaryRoot()
    const asar = writeAsar(bundleFileSpecs(), root)
    const profile = writeDesktopProfile(root, {
      withModules: true, dependencies: { 'dsh-completion-guard': PLUGIN_VERSION, 'third-party-tools': '2.0.0' },
      bundles: [...OFFICIAL_DESKTOP_BUNDLES, 'dsh-completion-guard', 'third-party-tools'],
      extraInstalled: [{ name: 'third-party-tools', version: '2.0.0' }],
    })
    const active = resolveActiveProfileHostLock(asar, profile, PLUGIN_VERSION)
    expect(active.profileKind).toBe('desktop')
    expect(active.evaluation.status).toBe('supported')
    const text = readFileSync(injectActiveProfileHostLock(active), 'utf8')
    expect(text).not.toContain('third-party-tools')
  })

  it('DM04: a declared market without installation or with a partial importer stays rejected', () => {
    const root = temporaryRoot()
    const asar = writeAsar(bundleFileSpecs(), root)
    // Pre-install: declaring the market (or Guard) as a dependency without an
    // importer is never activation evidence.
    expect(() => readDesktopTargetGraph(asar, writeDesktopProfile(root, {
      dirName: 'target', bundles: [...OFFICIAL_DESKTOP_BUNDLES, 'dshmarket'],
      dependencies: { dshmarket: '1.66.6' },
    }))).toThrowError(expect.objectContaining({ code: 'target_profile_dependency_uninstalled' }))
    // Active: an importer map without its lockfile is a partial importer.
    expect(() => resolveActiveProfileHostLock(asar, writeDesktopProfile(root, {
      dirName: 'partial', withModules: true, omitLock: true,
      bundles: [...OFFICIAL_DESKTOP_BUNDLES, 'dsh-completion-guard', 'dshmarket'],
      extraInstalled: [{ name: 'dshmarket', version: '1.66.6' }],
    }), PLUGIN_VERSION)).toThrowError(expect.objectContaining({ code: 'active_graph_missing' }))
    // Active: a dangling importer route (a '.' dependency referencing a
    // record that no longer exists) is an invalid package map under the
    // existing contract — market presence grants no exception.
    const profile = writeDesktopProfile(root, {
      dirName: 'dangling', withModules: true, dependencies: { 'dsh-completion-guard': PLUGIN_VERSION, dshmarket: '1.66.6' },
      bundles: [...OFFICIAL_DESKTOP_BUNDLES, 'dsh-completion-guard', 'dshmarket'],
    })
    const map = JSON.parse(readFileSync(join(profile, 'node_modules', '.package-map.json'), 'utf8')) as { packages: Record<string, unknown> }
    delete map.packages['dsh-completion-guard']
    writeFileSync(join(profile, 'node_modules', '.package-map.json'), JSON.stringify(map))
    expect(() => resolveActiveProfileHostLock(asar, profile, PLUGIN_VERSION))
      .toThrowError(expect.objectContaining({ code: 'active_graph_invalid' }))
  })

  it('DM05: the headless bundle conflicts with or without the market present', () => {
    const root = temporaryRoot()
    const asar = writeAsar(bundleFileSpecs(), root)
    for (const [index, bundles] of [
      [...OFFICIAL_DESKTOP_BUNDLES, '@deepseek-ai/dsh-headless'],
      [...OFFICIAL_DESKTOP_BUNDLES, '@deepseek-ai/dsh-headless', 'dshmarket'],
    ].entries()) {
      expect(() => inspectDesktopTargetGraph(asar, writeDesktopProfile(root, { dirName: `target-${index}`, bundles })))
        .toThrowError(expect.objectContaining({ code: 'desktop_profile_bundle_conflict' }))
      expect(() => resolveActiveProfileHostLock(asar, writeDesktopProfile(root, {
        dirName: `active-${index}`, withModules: true, dependencies: { 'dsh-completion-guard': PLUGIN_VERSION }, bundles,
      }), PLUGIN_VERSION)).toThrowError(expect.objectContaining({ code: 'profile_plugin_unbound' }))
    }
  })

  it('DM06: a foreign profile name with a Desktop tuple and market never gains Desktop authority', () => {
    const root = temporaryRoot()
    const asar = writeAsar(bundleFileSpecs(), root)
    expect(() => readDesktopTargetGraph(asar, writeDesktopProfile(root, {
      name: 'dsh-profile-web', bundles: [...OFFICIAL_DESKTOP_BUNDLES, 'dshmarket'],
    }))).toThrowError(expect.objectContaining({ code: 'target_profile_not_desktop' }))
    // The active resolver must dispatch the foreign name to the CLI-managed
    // path (which then fails on the missing runtime graph), never to the
    // dedicated Desktop resolver.
    expect(() => resolveActiveProfileHostLock(asar, writeDesktopProfile(root, {
      name: 'dsh-profile-web', withModules: true, dependencies: { 'dsh-completion-guard': PLUGIN_VERSION },
      bundles: [...OFFICIAL_DESKTOP_BUNDLES, 'dsh-completion-guard', 'dshmarket'],
    }), PLUGIN_VERSION)).toThrowError(expect.objectContaining({ code: 'active_graph_missing' }))
  })
})

describe('DM07–DM11 fail-closed identity and implementation gates', () => {
  it('DM07: missing Guard dependency, bundle, or installed package each refuse binding', () => {
    const root = temporaryRoot()
    const asar = writeAsar(bundleFileSpecs(), root)
    const bundles = [...OFFICIAL_DESKTOP_BUNDLES, 'dsh-completion-guard']
    // Dependency declaration missing, importer otherwise complete.
    expect(() => resolveActiveProfileHostLock(asar, writeDesktopProfile(root, {
      dirName: 'no-dependency', withModules: true, dependencies: {}, bundles,
    }), PLUGIN_VERSION)).toThrowError(expect.objectContaining({ code: 'profile_plugin_unbound' }))
    // Bundle entry missing while the dependency is declared.
    expect(() => resolveActiveProfileHostLock(asar, writeDesktopProfile(root, {
      dirName: 'no-bundle', withModules: true, dependencies: { 'dsh-completion-guard': PLUGIN_VERSION }, bundles: OFFICIAL_DESKTOP_BUNDLES,
    }), PLUGIN_VERSION)).toThrowError(expect.objectContaining({ code: 'profile_plugin_unbound' }))
    // Dependency and bundle bound, but nothing installed under the importer.
    expect(() => resolveActiveProfileHostLock(asar, writeDesktopProfile(root, {
      dirName: 'no-install', withModules: false, dependencies: { 'dsh-completion-guard': PLUGIN_VERSION }, bundles,
    }), PLUGIN_VERSION)).toThrowError(expect.objectContaining({ code: 'profile_plugin_unbound' }))
  })

  it('DM08: a wrong installed Guard identity is not repaired by any market presence', () => {
    const root = temporaryRoot()
    const asar = writeAsar(bundleFileSpecs(), root)
    expect(() => resolveActiveProfileHostLock(asar, writeDesktopProfile(root, {
      withModules: true, pluginVersion: '0.8.3', dependencies: { 'dsh-completion-guard': '0.8.3', dshmarket: '1.66.6' },
      bundles: [...OFFICIAL_DESKTOP_BUNDLES, 'dsh-completion-guard', 'dshmarket'],
      extraInstalled: [{ name: 'dshmarket', version: '1.66.6' }],
    }), PLUGIN_VERSION)).toThrowError(expect.objectContaining({ code: 'profile_plugin_version_mismatch' }))
  })

  it('DM09: an incomplete official tuple keeps its existing rejections', () => {
    const root = temporaryRoot()
    const asar = writeAsar(bundleFileSpecs(), root)
    expect(() => readDesktopTargetGraph(asar, writeDesktopProfile(root, {
      dirName: 'target-no-base', bundles: ['@deepseek-ai/dsh-base', 'dshmarket'],
    }))).toThrowError(expect.objectContaining({ code: 'target_profile_bundles_unsupported' }))
    expect(() => resolveActiveProfileHostLock(asar, writeDesktopProfile(root, {
      dirName: 'active-no-web-app', withModules: true, dependencies: { 'dsh-completion-guard': PLUGIN_VERSION },
      bundles: ['@deepseek-ai/dsh-base', 'dsh-completion-guard', 'dshmarket'],
    }), PLUGIN_VERSION)).toThrowError(expect.objectContaining({ code: 'profile_plugin_unbound' }))
  })

  it('DM10: forged carrier, unknown host version, or corrupted archive fail the active entry', () => {
    const root = temporaryRoot()
    const profile = writeDesktopProfile(root, { withModules: true, dependencies: { 'dsh-completion-guard': PLUGIN_VERSION } })
    const foreign = writeAsar(bundleFileSpecs().map((file) => file.path === 'dsh/package.json'
      ? { ...file, content: Buffer.from(JSON.stringify({ name: '@evil/desktop-runtime', version: RC2_VERSION, dependencies: {} }), 'utf8') }
      : file), root)
    expect(() => resolveActiveProfileHostLock(foreign, profile, PLUGIN_VERSION)).toThrowError(/official desktop runtime/)
    const stale = writeAsar(bundleFileSpecs({ hostVersion: '0.2.0-rc.1' }), root)
    expect(() => resolveActiveProfileHostLock(stale, profile, PLUGIN_VERSION)).toThrowError(/admitted host version/)
    const corrupted = join(root, 'corrupted.asar')
    writeFileSync(corrupted, Buffer.from('not an asar archive'))
    expect(() => resolveActiveProfileHostLock(corrupted, profile, PLUGIN_VERSION)).toThrowError()
  })

  it('DM11: market-introduced shadows and local drift stay outside the trusted graph', () => {
    const root = temporaryRoot()
    const asar = writeAsar(bundleFileSpecs(), root)
    // A market shipping a nested critical package under the hoisted layout
    // makes the physical index differ from disk (the nested inventory is not
    // in hoistedLocations) and the route audit must never bless it.
    const hoisted = writeHoistedProfile(root, {
      dirName: 'hoisted-shadow', withModules: true, dependencies: { 'dsh-completion-guard': PLUGIN_VERSION, dshmarket: '1.66.6' },
      bundles: [...OFFICIAL_DESKTOP_BUNDLES, 'dsh-completion-guard', 'dshmarket'],
      extraInstalled: [{ name: 'dshmarket', version: '1.66.6' }],
    })
    const shadow = join(hoisted, 'node_modules', 'dshmarket', 'node_modules', '@deepseek-ai', 'dsh-session')
    mkdirSync(join(shadow, 'lib'), { recursive: true })
    writeFileSync(join(shadow, 'package.json'), syntheticManifestBytes('@deepseek-ai/dsh-session', RC2_VERSION))
    writeFileSync(join(shadow, 'lib', 'index.js'), SYNTHETIC_LIB_BYTES.replace('true', 'shadowed'))
    expect(() => resolveActiveProfileHostLock(asar, hoisted, PLUGIN_VERSION)).toThrowError()
    // A local critical package byte change after a valid lock is drift.
    const profile = writeDesktopProfile(root, {
      dirName: 'local-drift', withModules: true, dependencies: { 'dsh-completion-guard': PLUGIN_VERSION },
    })
    const row = RC020_RC2_HOST_PACKAGES.find((row) => row.name === '@deepseek-ai/dsh-session')!
    const packageRoot = join(profile, 'node_modules', row.name)
    mkdirSync(join(packageRoot, 'lib'), { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), syntheticManifestBytes(row.name, row.version!))
    writeFileSync(join(packageRoot, 'lib', 'index.js'), SYNTHETIC_LIB_BYTES)
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    manifest.dependencies[row.name] = row.version!
    writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest))
    writeFileSync(join(profile, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\npackages:\n  '${row.name}@${row.version}':\n    resolution: {integrity: ${row.integrity}}\nsnapshots: {}\n`)
    const mapPath = join(profile, 'node_modules', '.package-map.json')
    const map = JSON.parse(readFileSync(mapPath, 'utf8')) as { packages: Record<string, { url?: string; dependencies: Record<string, string> }> }
    map.packages['.'].dependencies[row.name] = row.name
    map.packages[row.name] = { url: './' + row.name, dependencies: { [row.name]: row.name } }
    writeFileSync(mapPath, JSON.stringify(map))
    const active = resolveActiveProfileHostLock(asar, profile, PLUGIN_VERSION)
    writeFileSync(join(packageRoot, 'lib', 'index.js'), 'export const synthetic = false\n')
    expect(revalidateDesktopCoreLock(asar, profile, active.evaluation).status).toBe('unsupported')
  })
})

describe('DM12/DM13 market lifecycle and fresh revalidation', () => {
  it('DM12: installing or removing the market drifts the old lock and a formal rebind restores it', () => {
    const root = temporaryRoot()
    const asar = writeAsar(bundleFileSpecs(), root)
    const profile = writeDesktopProfile(root, { withModules: true, dependencies: { 'dsh-completion-guard': PLUGIN_VERSION } })
    const before = resolveActiveProfileHostLock(asar, profile, PLUGIN_VERSION)
    expect(before.evaluation.status).toBe('supported')
    const expectedBefore = evaluateConfiguredHostLock(before.evaluation.packages, { platform: before.platform, profileKind: 'desktop' })
    const configBefore = desktopRuntimeConfig(asar, profile, before.evaluation.digest, before.evaluation.packages)
    expect(revalidateCoreLock(configBefore, expectedBefore)).toMatchObject({ status: 'supported' })
    // The app installs the market into the same profile: the old lock must
    // refuse silently-trusted reuse through the production runtime entry.
    installMarketFixture(profile)
    const duringMarket = resolveActiveProfileHostLock(asar, profile, PLUGIN_VERSION)
    expect(duringMarket.profileKind).toBe('desktop')
    expect(duringMarket.evaluation.status).toBe('supported')
    expect(duringMarket.evaluation.digest).not.toBe(before.evaluation.digest)
    expect(revalidateCoreLock(configBefore, expectedBefore)).toMatchObject({
      status: 'unsupported', reasonCode: 'host_lock_installed_graph_drift' })
    // The app removes the market again: the market-era lock must not survive,
    // and the restored profile rebinds back to the original digest — no
    // digest copied from another profile or machine.
    removeMarketFixture(profile)
    expect(revalidateCoreLock(desktopRuntimeConfig(asar, profile, duringMarket.evaluation.digest, duringMarket.evaluation.packages), expectedBefore))
      .toMatchObject({ status: 'unsupported', reasonCode: 'host_lock_installed_graph_drift' })
    const restored = resolveActiveProfileHostLock(asar, profile, PLUGIN_VERSION)
    expect(restored.evaluation.status).toBe('supported')
    expect(restored.evaluation.digest).toBe(before.evaluation.digest)
  })

  it('DM12-hoisted: a market added to the physical index drifts and rebinds like any importer change', () => {
    const root = temporaryRoot()
    const asar = writeAsar(bundleFileSpecs(), root)
    const profile = writeHoistedProfile(root, { withModules: true, dependencies: { 'dsh-completion-guard': PLUGIN_VERSION } })
    const before = resolveActiveProfileHostLock(asar, profile, PLUGIN_VERSION)
    installMarketFixture(profile, { map: false })
    const metadataPath = join(profile, 'node_modules', '.modules.yaml')
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as { hoistedLocations: Record<string, string[]> }
    metadata.hoistedLocations['dshmarket@1.66.6'] = ['node_modules/dshmarket']
    writeFileSync(metadataPath, JSON.stringify(metadata))
    const duringMarket = resolveActiveProfileHostLock(asar, profile, PLUGIN_VERSION)
    expect(duringMarket.profileKind).toBe('desktop')
    expect(duringMarket.evaluation.status).toBe('supported')
    expect(duringMarket.evaluation.digest).not.toBe(before.evaluation.digest)
    expect(revalidateCoreLock(desktopRuntimeConfig(asar, profile, before.evaluation.digest, before.evaluation.packages),
      evaluateConfiguredHostLock(before.evaluation.packages, { platform: duringMarket.platform, profileKind: 'desktop' })))
      .toMatchObject({ status: 'unsupported', reasonCode: 'host_lock_installed_graph_drift' })
  })

  it('DM13: fresh revalidation observes profile, importer and lock changes without a success cache', () => {
    const root = temporaryRoot()
    const asar = writeAsar(bundleFileSpecs(), root)
    const profile = writeDesktopProfile(root, { withModules: true, dependencies: { 'dsh-completion-guard': PLUGIN_VERSION } })
    const active = resolveActiveProfileHostLock(asar, profile, PLUGIN_VERSION)
    const config = desktopRuntimeConfig(asar, profile, active.evaluation.digest, active.evaluation.packages)
    const expected = evaluateConfiguredHostLock(active.evaluation.packages, { platform: active.platform, profileKind: 'desktop' })
    expect(revalidateCoreLock(config, expected)).toMatchObject({ status: 'supported' })
    const manifestPath = join(profile, 'package.json')
    const original = readFileSync(manifestPath, 'utf8')
    const lockPath = join(profile, 'pnpm-lock.yaml')
    const originalLock = readFileSync(lockPath, 'utf8')
    // Profile manifest change (bundles extended with the market).
    const manifest = JSON.parse(original) as { dsh: { profile: { bundles: string[] } } }
    manifest.dsh.profile.bundles = [...manifest.dsh.profile.bundles, 'dshmarket']
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    expect(revalidateCoreLock(config, expected)).toMatchObject({ status: 'unsupported', reasonCode: 'host_lock_installed_graph_drift' })
    writeFileSync(manifestPath, original)
    expect(revalidateCoreLock(config, expected)).toMatchObject({ status: 'supported' })
    // Lockfile byte change.
    writeFileSync(lockPath, originalLock + '# touched\n')
    expect(revalidateCoreLock(config, expected)).toMatchObject({ status: 'unsupported', reasonCode: 'host_lock_installed_graph_drift' })
    writeFileSync(lockPath, originalLock)
    expect(revalidateCoreLock(config, expected)).toMatchObject({ status: 'supported' })
    // Archive metadata change stays bound (fresh audit, not a cached pass).
    writeAsar(bundleFileSpecs({ metadata: { ...makeDesktopMetadata(), arch: 'x64' } }), root)
    expect(revalidateCoreLock(config, expected)).toMatchObject({ status: 'unsupported', reasonCode: 'host_lock_installed_graph_drift' })
  })
})

// ---------------------------------------------------------------------------
// CLI-managed (non-Desktop) runtime fixture for the DM14/DM15 inference rows.
// ---------------------------------------------------------------------------

function makeCliRuntimeFixture(root: string): { runtimeRoot: string; profileRoot: string } {
  const runtimeRoot = join(root, 'runtime'), profileRoot = join(root, 'profile')
  const modulesRoot = join(runtimeRoot, 'node_modules')
  mkdirSync(modulesRoot, { recursive: true })
  mkdirSync(join(profileRoot, 'node_modules', 'dsh-completion-guard'), { recursive: true })
  const packages: Record<string, { url: string; dependencies: Record<string, string> }> = { '.': { url: '..', dependencies: {} } }
  const runtimeRows = EXPECTED_HOST_PACKAGES
  for (const [index, row] of runtimeRows.entries()) {
    const id = `${row.name}@${row.version}`
    const relative = `./active/package-${index}`
    packages['.'].dependencies[row.name] = id
    packages[id] = { url: relative, dependencies: {} }
    const packageRoot = join(modulesRoot, relative)
    mkdirSync(packageRoot, { recursive: true })
    mkdirSync(join(packageRoot, 'lib'), { recursive: true })
    writeFileSync(join(packageRoot, 'lib/index.js'), 'export const synthetic = true\n')
    // The same manifest bytes the byte-audit mock above binds, so the CLI
    // runtime fixture passes the published-digest audit like the asar one.
    writeFileSync(join(packageRoot, 'package.json'), syntheticManifestBytes(row.name, row.version as string))
  }
  mkdirSync(join(modulesRoot, '@deepseek-ai'), { recursive: true })
  for (const row of runtimeRows) {
    symlinkSync(join(modulesRoot, packages[`${row.name}@${row.version}`].url), join(modulesRoot, row.name), 'junction')
  }
  writeFileSync(join(runtimeRoot, 'package.json'), '{}')
  const lockYaml = (rows: readonly { name: string; version?: string; integrity?: string }[]) => [
    "lockfileVersion: '9.0'", '', 'packages:',
    ...rows.flatMap((row) => [`  '${row.name}@${row.version}':`, `    resolution: {integrity: ${row.integrity}}`, '']),
    'snapshots:', '',
  ].join('\n')
  writeFileSync(join(runtimeRoot, 'pnpm-lock.yaml'), lockYaml(runtimeRows))
  writeFileSync(join(modulesRoot, '.package-map.json'), JSON.stringify({ packages }))
  const profileModules = join(profileRoot, 'node_modules')
  mkdirSync(join(profileModules, 'dshmarket'), { recursive: true })
  writeFileSync(join(profileModules, 'dshmarket', 'package.json'), JSON.stringify({ name: 'dshmarket', version: '1.66.6' }))
  writeFileSync(join(profileRoot, 'pnpm-lock.yaml'), lockYaml([]))
  writeFileSync(join(profileModules, '.package-map.json'), JSON.stringify({
    packages: {
      '.': { url: '..', dependencies: { dshmarket: 'dshmarket', 'dsh-completion-guard': 'dsh-completion-guard' } },
      dshmarket: { url: './dshmarket', dependencies: {} },
      'dsh-completion-guard': { url: './dsh-completion-guard', dependencies: {} },
    },
  }))
  writeFileSync(join(profileRoot, 'node_modules', 'dsh-completion-guard', 'package.json'), JSON.stringify({
    name: 'dsh-completion-guard', version: PLUGIN_VERSION,
  }))
  return { runtimeRoot, profileRoot }
}

function writeCliProfileManifest(profileRoot: string, bundles: string[]): void {
  writeFileSync(join(profileRoot, 'package.json'), JSON.stringify({
    dependencies: { 'dsh-completion-guard': 'file:/synthetic/candidate.tgz', dshmarket: '1.66.6' },
    dsh: { profile: { bundles } },
  }))
}

describe('DM14/DM15/DM16 non-Desktop inferences and capabilities', () => {
  it('DM14: a non-Desktop web profile with the market keeps the web identity and lock behavior', () => {
    const root = temporaryRoot()
    const { runtimeRoot, profileRoot } = makeCliRuntimeFixture(root)
    writeCliProfileManifest(profileRoot, ['@deepseek-ai/dsh-web-app', 'dshmarket', 'dsh-completion-guard'])
    const active = resolveActiveProfileHostLock(runtimeRoot, profileRoot, PLUGIN_VERSION)
    expect(active.profileKind).toBe('web')
    expect(active.evaluation.status).toBe('supported')
    const text = readFileSync(injectActiveProfileHostLock(active), 'utf8')
    expect(text).toContain('hostLockProfile: "web"')
    expect(text).not.toContain('dshmarket')
  })

  it('DM15: the headless marker keeps priority over web/market markers', () => {
    const root = temporaryRoot()
    const { runtimeRoot, profileRoot } = makeCliRuntimeFixture(root)
    writeCliProfileManifest(profileRoot, ['@deepseek-ai/dsh-headless', '@deepseek-ai/dsh-web-app', 'dshmarket', 'dsh-completion-guard'])
    const active = resolveActiveProfileHostLock(runtimeRoot, profileRoot, PLUGIN_VERSION)
    expect(active.profileKind).toBe('headless')
    expect(active.evaluation.status).toBe('supported')
  })

  it('DM16: market restart stays web-only and Desktop coexistence grants no restart capability', () => {
    const root = temporaryRoot()
    const { runtimeRoot, profileRoot } = makeCliRuntimeFixture(root)
    writeCliProfileManifest(profileRoot, ['@deepseek-ai/dsh-web-app', 'dshmarket', 'dsh-completion-guard'])
    const web = resolveActiveProfileHostLock(runtimeRoot, profileRoot, PLUGIN_VERSION)
    expect(web.profileKind).toBe('web')
    expect(ACTION_MANIFEST.actions.restart.commandManifestIds).toEqual(['dshmarket.restart.v1'])
    expect(evaluateHostCapability(web.evaluation, { action: 'restart', platform: web.platform, profileKind: 'web' }).status).toBe('supported')
    const asar = writeAsar(bundleFileSpecs(), root)
    const desktopProfile = writeDesktopProfile(root, {
      withModules: true, dependencies: { 'dsh-completion-guard': PLUGIN_VERSION },
      bundles: [...OFFICIAL_DESKTOP_BUNDLES, 'dsh-completion-guard', 'dshmarket'],
      extraInstalled: [{ name: 'dshmarket', version: '1.66.6' }],
    })
    const desktop = resolveActiveProfileHostLock(asar, desktopProfile, PLUGIN_VERSION)
    expect(desktop.profileKind).toBe('desktop' as HostProfileKind)
    const restart = evaluateHostCapability(desktop.evaluation, { action: 'restart', platform: desktop.platform, profileKind: 'desktop' })
    expect(restart.status).toBe('unavailable')
    expect(restart.reasonCode).toBe('host_capability_request_unsupported')
    // The market is outside the core contract: the coexistence lock's core
    // row digest equals the plain desktop lock's. (The returned digest is the
    // outer desktop-core-host identity, which legitimately binds the profile
    // bytes and therefore differs once the market is installed.)
    const plain = resolveActiveProfileHostLock(asar, writeDesktopProfile(root, {
      dirName: 'plain-desktop', withModules: true, dependencies: { 'dsh-completion-guard': PLUGIN_VERSION },
    }), PLUGIN_VERSION)
    expect(evaluateHostLock(desktop.evaluation.packages, { platform: desktop.platform, profileKind: 'desktop' }).digest)
      .toBe(evaluateHostLock(plain.evaluation.packages, { platform: plain.platform, profileKind: 'desktop' }).digest)
  })
})

describe('DM02 entry identity binding', () => {
  it('the active runtime root of a market coexistence lock is the real asar identity', () => {
    const root = temporaryRoot()
    const asar = writeAsar(bundleFileSpecs(), root)
    const profile = writeDesktopProfile(root, {
      withModules: true, dependencies: { 'dsh-completion-guard': PLUGIN_VERSION },
      bundles: [...OFFICIAL_DESKTOP_BUNDLES, 'dsh-completion-guard', 'dshmarket'],
      extraInstalled: [{ name: 'dshmarket', version: '1.66.6' }],
    })
    const active = resolveActiveProfileHostLock(asar, profile, PLUGIN_VERSION)
    expect(realpathSync(active.runtimeRoot)).toBe(realpathSync(asar))
    expect(active.profileRoot).toBe(resolve(profile))
  })
})
