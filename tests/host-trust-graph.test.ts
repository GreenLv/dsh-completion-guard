import { expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

vi.mock('../src/domain/host-contract-probe.js', async original => ({
  ...await original<typeof import('../src/domain/host-contract-probe.js')>(),
  runHostContractProbe: () => ({ schema: 'guard-host-contract/v2', checks: ['controlled_probe'], failures: [] }),
}))
import { acquireHostTrust, qualifyHostTrust } from '../src/domain/host-trust.js'

function fixture(name: string, dependencies: Record<string, string> = {}) {
  const version = '1.0.0'
  const manifest = Buffer.from(JSON.stringify({ name, version, dependencies }))
  const header = Buffer.alloc(512)
  header.write('package/package.json')
  header.write(manifest.length.toString(8).padStart(11, '0') + '\0', 124)
  header[156] = 48
  header.fill(32, 148, 156)
  header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148)
  const bytes = gzipSync(Buffer.concat([header, manifest, Buffer.alloc((512 - manifest.length % 512) % 512), Buffer.alloc(1024)]))
  return { name, version, integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'), bytes }
}

function transport(rows: ReturnType<typeof fixture>[]) {
  let requests = 0
  const byName = new Map(rows.map(row => [row.name, row]))
  const fetcher = (async (input: string | URL | Request) => {
    requests++
    const url = String(input)
    const prefix = 'https://registry.npmjs.org/'
    const parts = url.slice(prefix.length).split('/')
    const name = decodeURIComponent(parts[0])
    const row = byName.get(name)
    if (!row) return new Response('', { status: 404 })
    if (parts[1] === 'archive') return new Response(new Uint8Array(row.bytes))
    return Response.json({ name, version: row.version, dist: { integrity: row.integrity, tarball: `${prefix}${encodeURIComponent(name)}/archive` } })
  }) as typeof fetch
  return { byName, fetcher, requests: () => requests }
}

it('qualifies more than 160 unique dependency nodes through the acquisition entry', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'host-graph-large-')))
  try {
    const names = Array.from({ length: 170 }, (_, index) => `fixture-${index}`)
    const parent = fixture('@deepseek-ai/dsh-session', Object.fromEntries(names.map(name => [name, '1.0.0'])))
    const registry = transport([parent, ...names.map(name => fixture(name))])
    const trust = await acquireHostTrust([parent], registry.fetcher, {
      profileRoot: root,
      dependencyIdentity: name => registry.byName.get(name)!,
    })
    expect(trust.probeDependencies).toHaveLength(170)
    expect(qualifyHostTrust(trust, root).contract.receiptDigest).toMatch(/^[a-f0-9]{64}$/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('refuses two importer edges resolving the same name to different identities', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'host-graph-conflict-')))
  try {
    const shared = fixture('fixture-shared')
    const session = fixture('@deepseek-ai/dsh-session', { 'fixture-shared': '1.0.0' })
    const agent = fixture('@deepseek-ai/dsh-agent', { 'fixture-shared': '1.0.0' })
    const registry = transport([session, agent, shared])
    await expect(acquireHostTrust([session, agent], registry.fetcher, {
      profileRoot: root,
      dependencyIdentity: (name, importer) => importer === agent.name
        ? { ...shared, version: '2.0.0' }
        : registry.byName.get(name)!,
    })).rejects.toMatchObject({ code: 'host_contract_probe_dependency_conflict' })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('stops at the package budget before requesting another dependency identity', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'host-graph-limit-')))
  try {
    const names = Array.from({ length: 1024 }, (_, index) => `fixture-${index}`)
    const parent = fixture('@deepseek-ai/dsh-session', Object.fromEntries(names.map(name => [name, '1.0.0'])))
    const registry = transport([parent, ...names.map(name => fixture(name))])
    const resolve = vi.fn((name: string) => registry.byName.get(name)!)
    await expect(acquireHostTrust([parent], registry.fetcher, { profileRoot: root, dependencyIdentity: resolve }))
      .rejects.toMatchObject({ code: 'host_contract_probe_graph_too_large' })
    expect(resolve).toHaveBeenCalledTimes(1023)
    expect(registry.requests()).toBe(2048)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('cancels an oversized registry metadata stream', async () => {
  const parent = fixture('@deepseek-ai/dsh-session')
  let cancelled = false
  const fetcher = (async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)) },
    cancel() { cancelled = true },
  }))) as typeof fetch
  await expect(acquireHostTrust([parent], fetcher)).rejects.toMatchObject({ code: 'host_trust_registry_metadata_too_large' })
  expect(cancelled).toBe(true)
})

it('bounds an unresponsive request with the shared operation deadline', async () => {
  const parent = fixture('@deepseek-ai/dsh-session')
  const controller = new AbortController()
  const fetcher = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch
  const timer = setTimeout(() => controller.abort(), 10)
  try {
    await expect(acquireHostTrust([parent], fetcher, { profileRoot: tmpdir(), signal: controller.signal }))
      .rejects.toMatchObject({ code: 'host_contract_probe_timeout' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  } finally { clearTimeout(timer) }
})

it('reports a bounded package and metadata stage when registry transport resets', async () => {
  const parent = fixture('@deepseek-ai/dsh-session')
  const fetcher = (async () => { throw new Error('private transport detail') }) as typeof fetch
  await expect(acquireHostTrust([parent], fetcher)).rejects.toMatchObject({
    code: 'host_trust_registry_unavailable',
    detail: 'package @deepseek-ai/dsh-session@1.0.0: metadata request failed',
  })
})

it.each(['null', '{invalid'])('refuses malformed registry metadata %s', async body => {
  const parent = fixture('@deepseek-ai/dsh-session')
  const fetcher = (async () => new Response(body)) as typeof fetch
  await expect(acquireHostTrust([parent], fetcher)).rejects.toMatchObject({ code: 'host_trust_registry_metadata_invalid' })
})
