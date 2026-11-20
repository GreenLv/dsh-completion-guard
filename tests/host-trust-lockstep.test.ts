import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const state = vi.hoisted(() => ({ probe: vi.fn((_archives: unknown, _targets: string[]) => ({ schema: 'guard-host-contract/v2', checks: ['controlled_probe'], failures: [] })) }))
vi.mock('../src/domain/host-contract-probe.js', async original => ({
  ...await original<typeof import('../src/domain/host-contract-probe.js')>(), runHostContractProbe: state.probe,
}))
vi.mock('../src/domain/rc022-rc5-byte-audit-manifest.js', async () => {
  const { createHash } = await import('node:crypto')
  const { hostManifestLoadingDigest } = await import('../src/domain/host-contract-program.js')
  const source = 'export const fixture = true\n'
  const manifests = [
    { name: '@deepseek-ai/dsh', version: '0.2.2-rc.5', type: 'module', exports: { import: './lib/index.js', default: './lib/index.js' },
      dependencies: { '@deepseek-ai/dsh-session': '0.2.2-rc.5', 'fixture-external': '1.0.0' } },
    { name: '@deepseek-ai/dsh-session', version: '0.2.2-rc.5', type: 'module', exports: { '.': './lib/index.js' } },
  ]
  return { default: { schema: 'dsh-host-byte-audit/v1', hostVersion: '0.2.2-rc.5', upstreamCommit: '0'.repeat(40), auditedPlatforms: [],
    packages: manifests.map(manifest => ({ name: manifest.name, version: manifest.version, integrity: '', tarball: '', sha256: '',
      loadingDigest: hostManifestLoadingDigest(JSON.stringify(manifest)),
      modules: { 'package.json': createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
        'lib/index.js': createHash('sha256').update(source).digest('hex') } })) } }
})
import { acquireHostTrust } from '../src/domain/host-trust.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); state.probe.mockClear() })
function archive(files: Record<string, Buffer>): Buffer {
  const blocks: Buffer[] = []
  for (const [name, bytes] of Object.entries(files)) {
    const header = Buffer.alloc(512)
    header.write(`package/${name}`)
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124)
    header[156] = 48; header.fill(32, 148, 156)
    header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148)
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512))
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}

function fixture(change?: 'external' | 'extra' | 'exports' | 'edge-version' | 'edge-integrity') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'host-lockstep-'))); roots.push(root)
  const source = Buffer.from('export const fixture = true\n')
  const manifests = [
    { name: '@deepseek-ai/dsh', version: '0.2.2-rc.4', type: 'module', exports: { import: './lib/index.js', default: './lib/index.js' },
      dependencies: { '@deepseek-ai/dsh-session': '0.2.2-rc.4', 'fixture-external': change === 'external' ? '2.0.0' : '1.0.0' } },
    { name: '@deepseek-ai/dsh-session', version: '0.2.2-rc.4', type: 'module', exports: { '.': './lib/index.js' } },
    { name: 'fixture-external', version: change === 'external' ? '2.0.0' : '1.0.0', type: 'module', exports: { '.': './lib/index.js' } },
  ]
  if (change === 'exports') manifests[0].exports = { default: './lib/index.js', import: './lib/index.js' }
  const entries = manifests.map(manifest => {
    const files: Record<string, Buffer> = { 'package.json': Buffer.from(JSON.stringify(manifest)), 'lib/index.js': source }
    if (change === 'extra' && manifest.name === '@deepseek-ai/dsh') files['lib/extra.js'] = Buffer.from('export const extra = true\n')
    const bytes = archive(files)
    return { name: manifest.name, version: manifest.version, bytes, integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') }
  })
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input), prefix = 'https://registry.npmjs.org/'
    const parts = url.slice(prefix.length).split('/'), row = entries.find(entry => entry.name === decodeURIComponent(parts[0]))
    if (!row) return new Response('', { status: 404 })
    if (parts[1] === 'archive') return new Response(new Uint8Array(row.bytes))
    return Response.json({ name: row.name, version: row.version, dist: { integrity: row.integrity, tarball: `${prefix}${encodeURIComponent(row.name)}/archive` } })
  }) as typeof fetch
  return { root, entries, fetcher, identity: (name: string) => {
    const row = entries.find(entry => entry.name === name)!
    if (name === '@deepseek-ai/dsh-session' && change === 'edge-version') return { ...row, version: '0.2.2-rc.9' }
    if (name === '@deepseek-ai/dsh-session' && change === 'edge-integrity') return { ...row, integrity: 'sha512-' + Buffer.alloc(64, 9).toString('base64') }
    return row
  } }
}

it('qualifies exact internal lockstep rewrites only after checking the actual importer edge', async () => {
  const f = fixture()
  const trust = await acquireHostTrust(f.entries.slice(0, 2), f.fetcher, { profileRoot: f.root, dependencyIdentity: f.identity })
  const receipt = JSON.parse(readFileSync(join(f.root, '.dsh-completion-guard', 'host-contracts', trust.contract.receiptDigest + '.json'), 'utf8'))
  expect(receipt.checks).toContain('reviewed_program_equivalence:@deepseek-ai/dsh')
  expect(state.probe).not.toHaveBeenCalled()
})

it.each(['external', 'extra', 'exports'] as const)('probes a %s change instead of treating it as an equivalent rewrite', async change => {
  const f = fixture(change)
  await acquireHostTrust(f.entries.slice(0, 2), f.fetcher, { profileRoot: f.root, dependencyIdentity: f.identity })
  expect(state.probe).toHaveBeenCalled()
  expect(state.probe.mock.calls[0][1]).toContain('@deepseek-ai/dsh')
})

it.each(['edge-version', 'edge-integrity'] as const)('refuses a rewritten importer edge with %s mismatch', async change => {
  const f = fixture(change)
  await expect(acquireHostTrust(f.entries.slice(0, 2), f.fetcher, { profileRoot: f.root, dependencyIdentity: f.identity }))
    .rejects.toMatchObject({ code: change === 'edge-version' ? 'host_contract_probe_dependency_unbound' : 'host_contract_probe_dependency_conflict' })
})
