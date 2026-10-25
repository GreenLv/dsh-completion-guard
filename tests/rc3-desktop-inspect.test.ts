import { describe, expect, it, vi } from 'vitest'

// RC3-D01 end-to-end: the desktop preflight entry (inspectDesktopTargetGraph,
// the function behind `inspect-graph` and native preflight) must qualify an
// rc.3 app bundle through the rc.3 audited manifest — the previous behavior
// pinned cohortIntegrityRows and the default expectations to rc.2 and failed
// every rc.3 runtime with desktop_runtime_unqualified. The bundle is built
// from the rc.3 audited manifest (vi.mock narrows the modules exactly like
// the rc.2 suites do); the profile is a dependency-free legal Desktop shape.
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
// real rc.3 CDN package already passed codesign in this round's acquisition
// study); the synthetic archive here exercises the graph/audit logic only.
vi.mock('../src/domain/host-desktop-identity.js', () => ({
  verifyDesktopCarrier: (archive: string) => archive,
}))
vi.mock('../src/domain/rc3-byte-audit-manifest.js', async (original) => {
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
import rc3Manifest from '../src/domain/rc3-byte-audit-manifest.js'
import distributionPins from '../src/domain/desktop-distribution-manifest.js'

const RC3 = '0.2.1-rc.3'
const LIB_BYTES = 'export const synthetic = true\n'
const SYNTHETIC_LIB_SHA = createHash('sha256').update(LIB_BYTES).digest('hex')

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
  contents: ReadonlyMap<string, Buffer>): AsarFileSpec[] {
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
      name: '@deepseek-ai/dsh-desktop-runtime', version: RC3,
      dependencies: Object.fromEntries(rc3Manifest.packages.map((row) => [row.name, row.version])),
    }), 'utf8'),
  }]
  // Package bytes come from the SAME contents the digest table attests, so
  // each package manifest carries its own true version (cordis stays 4.0.5).
  for (const entry of metadata.files as Array<{ path: string }>) {
    const archivePath = `dsh/${entry.path}`
    const content = contents.get(archivePath)
    if (content === undefined) throw new Error(`bundle spec missing bytes for ${archivePath}`)
    specs.push({ path: archivePath, content })
  }
  return specs
}


describe('RC3-D01: desktop preflight qualifies an rc.3 app through the rc.3 cohort', () => {
  it('inspectDesktopTargetGraph succeeds for a synthetic rc.3 bundle where the rc.2 pin used to refuse it', () => {
    const root = mkdtempSync(join(tmpdir(), 'rc3-desktop-'))
    try {
      // The official per-file digest table: every installed byte attested.
      const fileRows: Array<{ path: string; sha256: string }> = []
      const contents = new Map<string, Buffer>()
      const desktopManifest = Buffer.from(JSON.stringify({
        name: '@deepseek-ai/dsh-desktop', version: RC3,
        dshBuildCommit: 'c'.repeat(40), dshBuildDirty: false,
      }))
      for (const row of rc3Manifest.packages) {
        const manifestBytes = syntheticManifestBytes(row.name, row.version!)
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
        platform: process.platform, arch: 'synthetic', version: RC3,
        release: { schemaVersion: 1, version: RC3, hostProtocolVersion: 4, nodeVersion: '24.21.0', pnpmVersion: '11.28.5' },
        files: fileRows.map(({ path }) => ({ path: path.replace(/^dsh\//, ''), sha256: '' })),
      }
      // second pass: fill real sha256 per file path now that contents are known
      // The official table keys files as `node_modules/<name>/<file>`
      // relative to the dsh/ graph root (the audit looks up
      // `dsh/node_modules/${name}/${file}`) — verified against the real rc.3
      // CDN bundle's desktop-runtime.json.
      metadata.files = fileRows.map(({ path }) => ({
        path: path.replace(/^dsh\//, ''),
        sha256: createHash('sha256').update(contents.get(path)!).digest('hex'),
      }))
      const files = bundleFileSpecs(metadata, desktopManifest, contents)
      const asar = writeAsar(files)
      const asarPath = join(root, 'app.asar')
      writeFileSync(asarPath, asar)
      const writtenIndex = readAsarIndex(asarPath)
      console.error('ZZ-INDEX dsh.files keys:', Object.keys(writtenIndex.root.files?.dsh?.files ?? {}),
        '| node_modules keys:', Object.keys(writtenIndex.root.files?.dsh?.files?.node_modules?.files ?? {}).slice(0, 6))
      const headerSha = readAsarIndex(asarPath).headerSha256
      // Register the synthetic rc.3 distribution (same flow as the manifest's
      // real darwin-arm64 rc.3 row).
      distributionPins.distributions = [{
        id: `desktop-${RC3}-synthetic`, platform: process.platform, arch: 'synthetic',
        version: RC3, runtimeVersion: RC3, pnpmVersion: '11.28.5',
        asarHeaderSha256: headerSha,
        desktopManifestSha256: createHash('sha256').update(desktopManifest).digest('hex'),
        buildCommit: 'c'.repeat(40), buildDirty: false,
        releaseUrl: 'synthetic', releaseSha512: '', vendorTeam: '', vendorIdentifier: '',
      }]
      distributionPins.files = []

      // Legal dependency-free Desktop profile: the app-owned manifest with
      // the official bundle tuple and NO importer state.
      const profileRoot = join(root, 'profile')
      mkdirSync(profileRoot, { recursive: true })
      writeFileSync(join(profileRoot, 'package.json'), JSON.stringify({
        name: DESKTOP_PROFILE_PACKAGE_NAME, version: RC3,
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
      }))

      const target = inspectDesktopTargetGraph(asarPath, profileRoot)
      expect(target.runtime.hostVersion).toBe(RC3)
      expect(target.packages.filter((row) => row.name === '@deepseek-ai/cordis')).toHaveLength(1)
      // The rc.3 rows flow through: the launcher is rc.3, not the old rc.2 pin.
      expect(target.packages.find((row) => row.name === '@deepseek-ai/dsh')?.version).toBe(RC3)
    } finally {
      rmSync(root, { recursive: true, force: true })
      distributionPins.distributions = []
      distributionPins.files = []
    }
  })
})
