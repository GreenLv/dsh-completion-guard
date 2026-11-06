import { describe, expect, it, vi } from 'vitest'

// RC5-D01 end-to-end (successor of the 0.11.0 RC3-D01 case), carried forward
// to the 0.13.0 floor: the desktop preflight entry (inspectDesktopTargetGraph,
// the function behind `inspect-graph` and native preflight) must qualify a
// 0.2.2-rc.1 app bundle through the 0.2.2-rc.1 audited manifest, while the
// formerly admitted rc.5 shape and the retired rc.2 shape both refuse below
// the raised floor. Each bundle is built from its own audited manifest
// (vi.mock narrows the modules exactly like the rc.2/rc.3 suites do); the
// profile is a dependency-free legal Desktop shape.
const state = vi.hoisted(() => ({ pins: {
  schema: 'dsh-desktop-distribution/v1',
  provenance: { repository: 'https://github.com/deepseek-ai/deepseek-harness' },
  files: [] as Array<{ package: string; version: string; path: string; bytes: number; sha256: string }>,
  distributions: [] as Array<Record<string, unknown>>,
} }))
vi.mock('../src/domain/desktop-distribution-manifest.js', async (original) => {
  const source = await original<{ default: unknown }>()
  return { default: structuredClone(source.default) }
})
// Portable fixture: the OS carrier signature check is a native gate (the
// real rc.5 CDN package already passed codesign in this round's acquisition
// study); the synthetic archive here exercises the graph/audit logic only.
vi.mock('../src/domain/host-desktop-identity.js', () => ({
  verifyDesktopCarrier: (archive: string) => archive,
}))
vi.mock('../src/domain/rc5-byte-audit-manifest.js', async (original) => {
  const { createHash } = await import('node:crypto')
  const libDigest = createHash('sha256').update('export const synthetic = true\n').digest('hex')
  const source = await original<{ default: { packages: Array<Record<string, unknown>> } }>()
  return { default: { ...source.default, packages: source.default.packages.map((row) => ({
    ...row,
    modules: {
      'package.json': createHash('sha256').update(JSON.stringify({ name: row.name, version: row.version, type: 'module', main: 'lib/index.js' }) + '\n', 'utf8').digest('hex'),
      'lib/index.js': libDigest,
    },
  })) } }
})
vi.mock('../src/domain/rc022-rc1-byte-audit-manifest.js', async (original) => {
  const { createHash } = await import('node:crypto')
  const libDigest = createHash('sha256').update('export const synthetic = true\n').digest('hex')
  const source = await original<{ default: { packages: Array<Record<string, unknown>> } }>()
  return { default: { ...source.default, packages: source.default.packages.map((row) => ({
    ...row,
    modules: {
      'package.json': createHash('sha256').update(JSON.stringify({ name: row.name, version: row.version, type: 'module', main: 'lib/index.js' }) + '\n', 'utf8').digest('hex'),
      'lib/index.js': libDigest,
    },
  })) } }
})

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { readAsarIndex, DESKTOP_PROFILE_PACKAGE_NAME } from '../src/domain/host-desktop.js'
import { inspectDesktopTargetGraph } from '../src/domain/host-resolver.js'
import rc5Manifest from '../src/domain/rc5-byte-audit-manifest.js'
import rc022Manifest from '../src/domain/rc022-rc1-byte-audit-manifest.js'
import distributionPins from '../src/domain/desktop-distribution-manifest.js'
import type { ByteAuditManifest } from '../src/domain/byte-audit-manifest.js'

/** The current admitted Desktop graph (floor `>=0.2.2-rc.1`). */
const RC1 = '0.2.2-rc.1'
/** Historical evidence rows below the floor: formerly admitted rc.5 and the
 * retired rc.2 shape. Both must refuse at the version gate. */
const RC5 = '0.2.1-rc.5'
const RC2 = '0.2.1-rc.2'
const LIB_BYTES = 'export const synthetic = true\n'

function syntheticManifestBytes(name: string, version: string): Buffer {
  return Buffer.from(JSON.stringify({ name, version, type: 'module', main: 'lib/index.js' }) + '\n', 'utf8')
}

interface AsarFileSpec { path: string; content: Buffer }

function writeAsar(files: readonly AsarFileSpec[]): Buffer {
  const root: Record<string, Record<string, unknown>> = {}
  let offset = 0
  for (const file of files) {
    const parts = file.path.split('/')
    let node = root
    for (const part of parts.slice(0, -1)) node = (node[part] ??= { files: {} } as Record<string, Record<string, unknown>>).files as Record<string, Record<string, unknown>>
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
  return Buffer.concat([prefix, json, padding, ...files.map((file) => file.content)])
}

function bundleFileSpecs(metadata: Record<string, unknown>, desktopManifest: Buffer,
  contents: ReadonlyMap<string, Buffer>, bundleVersion: string, manifest: ByteAuditManifest): AsarFileSpec[] {
  const specs: AsarFileSpec[] = [{ path: 'package.json', content: desktopManifest }, {
    path: 'dsh/desktop-runtime.json', content: Buffer.from(JSON.stringify(metadata), 'utf8'),
  }, {
    // The official CLI carrier entry must exist in the bundle.
    path: 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js', content: Buffer.from(LIB_BYTES, 'utf8'),
  }, {
    // The runtime graph root manifest: pins the launcher AND declares every
    // critical cohort name (readDesktopAppRuntime derives one version-only
    // row per declared critical dependency).
    path: 'dsh/package.json', content: Buffer.from(JSON.stringify({
      name: '@deepseek-ai/dsh-desktop-runtime', version: bundleVersion,
      dependencies: Object.fromEntries(manifest.packages.map((row) => [row.name, bundleVersion === manifest.hostVersion ? row.version : bundleVersion])),
    }), 'utf8'),
  }]
  // Package bytes come from the SAME contents the digest table attests, so
  // each package manifest carries its own true version (cordis keeps the
  // audited manifest's own version, e.g. 4.1.0 for 0.2.2-rc.1).
  for (const entry of metadata.files as Array<{ path: string }>) {
    const archivePath = `dsh/${entry.path}`
    const content = contents.get(archivePath)
    if (content === undefined) throw new Error(`bundle spec missing bytes for ${archivePath}`)
    specs.push({ path: archivePath, content })
  }
  return specs
}

/** Build a synthetic Desktop bundle at `version` from `manifest`'s rows. When
 * the version equals the manifest's own hostVersion the rows keep their true
 * versions; otherwise every row is pinned to the bundle version (the retired
 * rc.2 shape). */
function buildBundle(root: string, version: string, manifest: ByteAuditManifest): { asarPath: string; desktopManifest: Buffer } {
  const fileRows: Array<{ path: string; sha256: string }> = []
  const contents = new Map<string, Buffer>()
  const desktopManifest = Buffer.from(JSON.stringify({
    name: '@deepseek-ai/dsh-desktop', version,
    dshBuildCommit: 'c'.repeat(40), dshBuildDirty: false,
  }))
  for (const row of manifest.packages) {
    const rowVersion = version === manifest.hostVersion ? row.version : version
    const manifestBytes = syntheticManifestBytes(row.name, rowVersion)
    const entry = (file: string, bytes: Buffer) => {
      const path = `dsh/node_modules/${row.name}/${file}`
      contents.set(path, bytes)
      fileRows.push({ path, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
    entry('package.json', manifestBytes)
    for (const file of Object.keys(row.modules)) {
      if (file !== 'package.json') entry(file, Buffer.from(LIB_BYTES, 'utf8'))
    }
  }
  const metadata = {
    platform: process.platform, arch: 'synthetic', version,
    release: { schemaVersion: 1, version, hostProtocolVersion: 4, nodeVersion: '24.21.0', pnpmVersion: '11.28.5' },
    // The official table keys files as `node_modules/<name>/<file>` relative
    // to the dsh/ graph root (the audit looks up
    // `dsh/node_modules/${name}/${file}`), matching the real CDN bundles.
    files: fileRows.map(({ path }) => ({
      path: path.replace(/^dsh\//, ''),
      sha256: createHash('sha256').update(contents.get(path)!).digest('hex'),
    })),
  }
  const files = bundleFileSpecs(metadata, desktopManifest, contents, version, manifest)
  const asarPath = join(root, `app-${version}.asar`)
  writeFileSync(asarPath, writeAsar(files))
  return { asarPath, desktopManifest }
}

/** Register the synthetic distribution row for a built bundle (same flow as
 * the manifest's real darwin-arm64 rows) and write a legal dependency-free
 * Desktop profile: the app-owned manifest with the official bundle tuple and
 * NO importer state. */
function registerSyntheticDistribution(root: string, version: string, asarPath: string, desktopManifest: Buffer): string {
  distributionPins.distributions = [{
    id: `desktop-${version}-synthetic`, platform: process.platform, arch: 'synthetic',
    version, runtimeVersion: version, pnpmVersion: '11.28.5',
    asarHeaderSha256: readAsarIndex(asarPath).headerSha256,
    desktopManifestSha256: createHash('sha256').update(desktopManifest).digest('hex'),
    buildCommit: 'c'.repeat(40), buildDirty: false,
    releaseUrl: 'synthetic', releaseSha512: '', vendorTeam: '', vendorIdentifier: '',
  }]
  distributionPins.files = []
  const profileRoot = join(root, 'profile')
  mkdirSync(profileRoot, { recursive: true })
  writeFileSync(join(profileRoot, 'package.json'), JSON.stringify({
    name: DESKTOP_PROFILE_PACKAGE_NAME, version,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }))
  return profileRoot
}

describe('RC5-D01 (0.13.0 floor): desktop preflight qualifies the 0.2.2-rc.1 app through its own cohort', () => {
  it('inspectDesktopTargetGraph succeeds for a synthetic 0.2.2-rc.1 bundle built from the 0.2.2-rc.1 audited manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'rc022-desktop-'))
    try {
      expect(rc022Manifest.hostVersion).toBe(RC1)
      const { asarPath, desktopManifest } = buildBundle(root, RC1, rc022Manifest)
      const profileRoot = registerSyntheticDistribution(root, RC1, asarPath, desktopManifest)
      const target = inspectDesktopTargetGraph(asarPath, profileRoot)
      expect(target.runtime.hostVersion).toBe(RC1)
      // Cordis advanced to 4.1.0 in this cohort and is still exactly one row.
      const cordis = target.packages.filter((row) => row.name === '@deepseek-ai/cordis')
      expect(cordis).toHaveLength(1)
      expect(cordis[0]!.version).toBe('4.1.0')
      // The 0.2.2-rc.1 rows flow through: the launcher is 0.2.2-rc.1, not an old pin.
      expect(target.packages.find((row) => row.name === '@deepseek-ai/dsh')?.version).toBe(RC1)
      // The executor-split members introduced by this cohort are part of the graph.
      expect(target.packages.map((row) => row.name)).toEqual(expect.arrayContaining([
        '@deepseek-ai/dsh-tool-executor-native', '@deepseek-ai/dsh-tool-executor-ptc',
        '@deepseek-ai/dsh-official-bundles', '@deepseek-ai/dsh-fs-patch',
      ]))
    } finally {
      rmSync(root, { recursive: true, force: true })
      distributionPins.distributions = []
      distributionPins.files = []
    }
  })

  it.each([
    ['formerly admitted rc.5', RC5],
    ['retired rc.2-shaped', RC2],
  ])('refuses a %s bundle below the floor even with a registered distribution row', (_label, version) => {
    const root = mkdtempSync(join(tmpdir(), 'rc-desktop-refused-'))
    try {
      // Both historical shapes are built from the rc.5 audited manifest: the
      // rc.5 bundle keeps the rows' true versions, the rc.2 bundle pins every
      // row to rc.2 (as the retired distribution did).
      const { asarPath, desktopManifest } = buildBundle(root, version, rc5Manifest)
      const profileRoot = registerSyntheticDistribution(root, version, asarPath, desktopManifest)
      // Below the 0.13.0 floor (`>=0.2.2-rc.1`): the version gate refuses
      // before any cohort or byte audit runs; the registered synthetic
      // distribution row never reopens admission.
      try {
        inspectDesktopTargetGraph(asarPath, profileRoot)
        expect.unreachable(`the ${version} bundle must be refused`)
      } catch (error) {
        expect((error as { code?: string }).code).toBe('desktop_host_version_below_minimum')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
      distributionPins.distributions = []
      distributionPins.files = []
    }
  })
})
