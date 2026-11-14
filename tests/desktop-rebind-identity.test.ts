import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Keep the probe controlled while exercising the real Desktop ASAR reader,
// registry identity acquisition, archive SRI and dependency receipt chain.
vi.mock('../src/domain/host-contract-probe.js', async original => ({
  ...await original<typeof import('../src/domain/host-contract-probe.js')>(),
  runHostContractProbe: () => ({ schema: 'guard-host-contract/v2', checks: ['controlled_probe'], failures: [] }),
}))
import { prepareDesktopHostTrust } from '../src/domain/host-resolver.js'

const roots: string[] = []
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }) })
function asar(files: Record<string, Buffer>): Buffer {
  const root: Record<string, any> = {}; let offset = 0
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split('/'); let node = root
    for (const part of parts.slice(0, -1)) node = (node[part] ??= { files: {} }).files
    node[parts.at(-1)!] = { size: content.length, offset: String(offset) }; offset += content.length
  }
  const json = Buffer.from(JSON.stringify({ files: root })), padding = Buffer.alloc((4 - json.length % 4) % 4)
  const header = Buffer.alloc(16); header.writeUInt32LE(4, 0); header.writeUInt32LE(8 + json.length + padding.length, 4); header.writeUInt32LE(4 + json.length + padding.length, 8); header.writeUInt32LE(json.length, 12)
  return Buffer.concat([header, json, padding, ...Object.values(files)])
}
function archive(manifest: object): Buffer {
  const data = Buffer.from(JSON.stringify(manifest)), header = Buffer.alloc(512)
  header.write('package/package.json'); header.write(data.length.toString(8).padStart(11, '0') + '\0', 124); header[156] = 48
  header.fill(32, 148, 156); header.write([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148)
  return gzipSync(Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512), Buffer.alloc(1024)]))
}
function fixture(mode: 'ok' | 'metadata' | 'archive' | 'missing' = 'ok') {
  const root = mkdtempSync(join(tmpdir(), 'guard-desktop-rebind-')); roots.push(root)
  const version = '0.2.2-rc.3', aux = '@example/probe-helper'
  const manifests = [
    { name: '@deepseek-ai/dsh', version },
    { name: '@deepseek-ai/cordis', version: '4.1.0', dependencies: { [aux]: '1.0.0' } },
    { name: aux, version: '1.0.0' },
  ]
  const runtime = { name: '@deepseek-ai/dsh-desktop-runtime', version, dependencies: { '@deepseek-ai/dsh': version, '@deepseek-ai/cordis': '4.1.0' } }
  const metadata = { platform: process.platform, arch: process.arch, release: { version, nodeVersion: '24.9.0', pnpmVersion: '11.28.5' }, files: [{ path: 'x', sha256: '0'.repeat(64) }] }
  const files: Record<string, Buffer> = { 'dsh/package.json': Buffer.from(JSON.stringify(runtime)), 'dsh/desktop-runtime.json': Buffer.from(JSON.stringify(metadata)), 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js': Buffer.from('') }
  if (mode !== 'missing') files[`dsh/node_modules/${aux}/package.json`] = Buffer.from(JSON.stringify(manifests[2]))
  const app = join(root, 'app.asar'); writeFileSync(app, asar(files))
  const rows = manifests.map(m => { const bytes = archive(m); return { ...m, bytes, integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') } })
  let auxMetadataCalls = 0
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input)
    const row = rows.find(r => url === `https://registry.npmjs.org/${encodeURIComponent(r.name)}/${encodeURIComponent(r.version)}`)
    if (row) {
      if (row.name === aux) auxMetadataCalls++
      return new Response(JSON.stringify({ name: mode === 'metadata' && row.name === aux && auxMetadataCalls === 2 ? 'wrong' : row.name, version: row.version, dist: { integrity: row.integrity, tarball: `https://registry.npmjs.org/fixture/${encodeURIComponent(row.name)}` } }))
    }
    const tar = rows.find(r => url === `https://registry.npmjs.org/fixture/${encodeURIComponent(r.name)}`)
    if (!tar) return new Response('', { status: 404 })
    return new Response(new Uint8Array(mode === 'archive' && tar.name === aux ? Buffer.from('tampered') : tar.bytes))
  }) as typeof fetch
  return { root, app, fetcher, aux }
}
it('acquires the exact Desktop transitive identity and binds registry SRI', async () => {
  const f = fixture(); const trust = await prepareDesktopHostTrust(f.app, f.root, f.fetcher)
  expect(trust.probeDependencies).toEqual(expect.arrayContaining([expect.objectContaining({ name: f.aux, version: '1.0.0', integrity: expect.stringMatching(/^sha512-/) })]))
})
it.each([['metadata', 'host_trust_registry_identity_mismatch'], ['archive', 'host_trust_archive_integrity_mismatch'], ['missing', 'host_contract_probe_dependency_unbound']] as const)('refuses %s in the Desktop production acquisition path', async (mode, code) => {
  const f = fixture(mode); await expect(prepareDesktopHostTrust(f.app, f.root, f.fetcher)).rejects.toMatchObject({ code })
})
