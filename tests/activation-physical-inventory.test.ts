import { afterEach, describe, expect, it } from 'vitest'
import { linkSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { captureActivationPhysicalInventory, assertActivationPhysicalRows, guardActivationInventory, resolveActivationPersistencePlugin, verifyActivationPhysicalInventory, type ActivationPhysicalCensus, type ActivationGenerationVerification } from '../src/domain/activation-physical-inventory.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'activation-physical-'))); dirs.push(root)
  const storage = join(root, 'sessions'); mkdirSync(storage)
  const add = (id: string, file = 'session.v4.jsonl.zstd', bytes = 'synthetic opaque bytes') => {
    const dir = join(storage, '_no-cwd', id); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, file), bytes); return join(dir, file)
  }
  return { root, storage, add }
}
const rows = (...ids: string[]) => ids.map(id => ({ header: { id }, revision: 'r1' }))
const capture = (root: string, compression: 'zstd' | 'none' = 'zstd') => captureActivationPhysicalInventory(root, compression, 'a'.repeat(64))
const simulatedVerifier = async (census: ActivationPhysicalCensus): Promise<ActivationGenerationVerification> => {
  const sessions = new Map<string, typeof census.generations[number]>()
  const counts = new Map<string, number>()
  for (const g of census.generations) { const k = `${g.projectSegment}/${g.sessionSegment}`; counts.set(k, (counts.get(k) ?? 0) + 1) }
  const multi = census.generations.filter(g => (counts.get(`${g.projectSegment}/${g.sessionSegment}`) ?? 0) > 1)
  for (const generation of multi) {
    const key = `${generation.projectSegment}/${generation.sessionSegment}`, current = sessions.get(key)
    if (!current || current.version < generation.version) sessions.set(key, generation)
  }
  return { generations: multi.map(g => ({ relativePath: g.relativePath, contentSha256: g.contentSha256,
    version: g.version, sessionId: g.sessionSegment, birthIdentitySha256: 'b'.repeat(64) })),
  selections: [...sessions.values()].map(g => ({ projectSegment: g.projectSegment, sessionSegment: g.sessionSegment,
    selectedRelativePath: g.relativePath, selectedVersion: g.version })) }
}
const verified = async (root: string) => verifyActivationPhysicalInventory(capture(root), simulatedVerifier, () => capture(root))

describe('activation physical completeness fence', () => {
  it('retains official default and namespace plugin shapes and rejects invalid exports', () => {
    const plugin = () => undefined, namespace = { apply: () => undefined }
    expect(resolveActivationPersistencePlugin({ default: plugin })).toBe(plugin)
    expect(resolveActivationPersistencePlugin(namespace)).toBe(namespace)
    expect(() => resolveActivationPersistencePlugin({ default: {} })).toThrow('activation_backend_module_invalid')
  })
  it('rejects a hidden corrupt or future generation even beside a listed valid session', async () => {
    for (const file of ['session.v4.jsonl.zstd', 'session.v5.jsonl.zstd']) {
      const f = fixture(); f.add('valid'); const bad = f.add('hidden', file, 'invalid or future')
      const before = readFileSync(bad)
      if (file.includes('v5')) expect(() => capture(f.storage)).toThrow('activation_inventory_unsupported')
      else { const awaited = await verified(f.storage); expect(() => assertActivationPhysicalRows(awaited, rows('valid'))).toThrow('activation_inventory_incomplete') }
      expect(readFileSync(bad)).toEqual(before)
    }
  })
  it('accepts an existing empty root and rejects hidden rows, wrong encoding, links and missing roots', async () => {
    const f = fixture(); expect((await verified(f.storage)).sessionSegments).toEqual([])
    expect(() => capture(join(f.root, 'missing'))).toThrow()
    f.add('hidden'); const hidden = await verified(f.storage); expect(() => assertActivationPhysicalRows(hidden, [])).toThrow('activation_inventory_incomplete')
    const g = fixture(); g.add('a', 'session.v4.jsonl'); expect(() => capture(g.storage)).toThrow('activation_inventory_unsupported')
    const h = fixture(); const file = h.add('a'); symlinkSync(file, join(h.storage, '_no-cwd', 'a', 'other.jsonl.zstd')); expect(() => capture(h.storage)).toThrow('activation_inventory_unsupported')
  })
  it('rejects future generations within a visible session', () => {
    for (const second of ['session.v5.jsonl.zstd']) {
      const f = fixture(); f.add('a'); f.add('a', second)
      expect(() => capture(f.storage)).toThrow('activation_inventory_unsupported')
    }
  })
  it('refuses physical mutation during the SDK listing even when listed IDs do not change', async () => {
    const f = fixture(); f.add('a')
    const guarded = guardActivationInventory({ list: async () => { f.add('hidden'); return rows('a') } }, await verified(f.storage), () => capture(f.storage))
    await expect(guarded.list()).rejects.toThrow('activation_inventory_changed')
  })
  it('binds serializer, root, metadata and additions while allowing exact physical-to-list rows', async () => {
    const f = fixture(); const file = f.add('a'); f.add('b')
    const before = capture(f.storage); const awaited = await verified(f.storage); expect(() => assertActivationPhysicalRows(awaited, rows('a', 'b'))).not.toThrow()
    const metadata = statSync(file)
    writeFileSync(file, Buffer.alloc(metadata.size, 0x78)); utimesSync(file, metadata.atime, metadata.mtime)
    expect(capture(f.storage).censusSha256).not.toBe(before.censusSha256)
    const second = capture(f.storage); f.add('c'); expect(capture(f.storage).censusSha256).not.toBe(second.censusSha256)
    expect(captureActivationPhysicalInventory(f.storage, 'zstd', 'b'.repeat(64)).censusSha256).not.toBe(capture(f.storage).censusSha256)
  })
})

describe('multi-generation census admission', () => {
  it('retains the v1 physical digest and never calls strict verifier for single generations', async () => {
    const f = fixture(); f.add('a'); const census = capture(f.storage)
    const proof = await verifyActivationPhysicalInventory(census, async () => { throw new Error('must_not_run') }, () => capture(f.storage))
    expect(proof.sha256).toBe(census.censusSha256)
    expect(proof.sessionSegments).toEqual(['a'])
    expect(proof.kind).toBe('validated')
  })
  it('binds all multi-generation confirmations and the SDK-selected latest generation', async () => {
    const f = fixture(); f.add('a'); f.add('a', 'session.jsonl.zstd'); f.add('a', 'session.v3.jsonl.zstd'); f.add('b')
    const census = capture(f.storage)
    expect(census.multiGenerationSessionCount).toBe(1)
    expect(census.generations.filter(g => g.sessionSegment === 'a').map(g => g.version)).toEqual([0, 3, 4])
    expect(census.generations.every(g => g.format === 'jsonl' && g.compression === 'zstd' && g.contentSha256.length === 64)).toBe(true)
    const proof = await verifyActivationPhysicalInventory(census, simulatedVerifier, () => capture(f.storage))
    expect(proof.sha256).not.toBe(census.censusSha256)
    expect(proof.sessionSegments).toEqual(['a', 'b'])
    expect(() => assertActivationPhysicalRows(proof, rows('a', 'b'))).not.toThrow()
    const guarded = guardActivationInventory({ list: async () => rows('a', 'b') }, proof, () => capture(f.storage))
    await expect(guarded.list()).resolves.toEqual(rows('a', 'b'))
  })
  it('runs the multi verifier once while every SDK list fences with raw recensus', async () => {
    const f = fixture(); f.add('a'); f.add('a', 'session.v3.jsonl.zstd')
    let verifierCalls = 0, captures = 0
    const recapture = () => { captures++; return capture(f.storage) }
    const proof = await verifyActivationPhysicalInventory(capture(f.storage), async c => { verifierCalls++; return simulatedVerifier(c) }, recapture)
    expect(verifierCalls).toBe(1); expect(captures).toBe(2)
    const fence = guardActivationInventory({ list: async () => rows('a') }, proof, recapture)
    expect(fence.check()).toBe(proof); await fence.list(); await fence.list()
    expect(verifierCalls).toBe(1); expect(captures).toBe(7)
  })
  it('checks physical census again even if strict verification throws', async () => {
    const f = fixture(); f.add('a'); f.add('a', 'session.v3.jsonl.zstd')
    let captures = 0
    await expect(verifyActivationPhysicalInventory(capture(f.storage), async () => { throw new Error('strict_failure') }, () => { captures++; return capture(f.storage) })).rejects.toThrow('strict_failure')
    expect(captures).toBe(2)
  })
  it('rejects forged census and forged physical proof objects', async () => {
    const f = fixture(); f.add('a'); const census = capture(f.storage)
    await expect(verifyActivationPhysicalInventory({ ...census }, simulatedVerifier, () => capture(f.storage))).rejects.toThrow('activation_inventory_invalid')
    expect(() => guardActivationInventory({ list: async () => [] }, { kind: 'validated', sha256: census.censusSha256 } as never, () => capture(f.storage))).toThrow('activation_inventory_proof_required')
  })
  it('rejects incomplete, duplicated, stale, wrong-ID, mismatched-identity, and wrong-selection verifier results', async () => {
    const f = fixture(); f.add('a'); f.add('a', 'session.v3.jsonl.zstd')
    const changes: Array<(v: ActivationGenerationVerification) => ActivationGenerationVerification> = [
      v => ({ ...v, generations: v.generations.slice(0, 1) }),
      v => ({ ...v, generations: [v.generations[0]!, v.generations[0]!] }),
      v => ({ ...v, generations: [{ ...v.generations[0]!, contentSha256: '0'.repeat(64) }, v.generations[1]!] }),
      v => ({ ...v, generations: [{ ...v.generations[0]!, sessionId: 'other' }, v.generations[1]!] }),
      v => ({ ...v, generations: [{ ...v.generations[0]!, birthIdentitySha256: '0'.repeat(64) }, v.generations[1]!] }),
      v => ({ ...v, selections: [{ ...v.selections[0]!, selectedVersion: 3 }] }),
      v => ({ ...v, selections: [] }),
    ]
    for (const change of changes) {
      const census = capture(f.storage)
      await expect(verifyActivationPhysicalInventory(census, async c => change(await simulatedVerifier(c)), () => capture(f.storage))).rejects.toThrow(/activation_inventory_(?:incomplete|invalid)/)
    }
    await expect(verifyActivationPhysicalInventory(capture(f.storage), async () => { throw new Error('strict_validation_failed') }, () => capture(f.storage))).rejects.toThrow('strict_validation_failed')
  })
  it('refuses a file replacement during multi-generation verification and later additions at the guard', async () => {
    const f = fixture(); const file = f.add('a'); f.add('a', 'session.v3.jsonl.zstd')
    const census = capture(f.storage)
    await expect(verifyActivationPhysicalInventory(census, async c => { writeFileSync(file, 'changed'); return simulatedVerifier(c) }, () => capture(f.storage))).rejects.toThrow('activation_inventory_changed')
    const proof = await verified(f.storage), fence = guardActivationInventory({ list: async () => rows('a') }, proof, () => capture(f.storage))
    f.add('b'); expect(() => fence.check()).toThrow('activation_inventory_changed')
  })
  it('rejects hardlinks, duplicate session segments across projects, no generations and noncanonical versions', () => {
    const a = fixture(); const first = a.add('a'); linkSync(first, join(a.storage, '_no-cwd', 'a', 'session.v3.jsonl.zstd'))
    expect(() => capture(a.storage)).toThrow('activation_inventory_unsupported')
    const b = fixture(); b.add('a'); mkdirSync(join(b.storage, 'other', 'a'), { recursive: true }); writeFileSync(join(b.storage, 'other', 'a', 'session.v4.jsonl.zstd'), 'other')
    expect(() => capture(b.storage)).toThrow('activation_inventory_incomplete')
    const c = fixture(); mkdirSync(join(c.storage, '_no-cwd', 'a'), { recursive: true }); writeFileSync(join(c.storage, '_no-cwd', 'a', 'session.lock'), '')
    expect(() => capture(c.storage)).toThrow('activation_inventory_incomplete')
    for (const name of ['session.v0.jsonl.zstd', 'session.v01.jsonl.zstd', 'session.v5.jsonl.zstd']) {
      const d = fixture(); d.add('a', name); expect(() => capture(d.storage)).toThrow('activation_inventory_unsupported')
    }
  })
  it('exposes immutable unverified descriptors and cannot certify without a verifier', async () => {
    const f = fixture(); f.add('a'); f.add('a', 'session.v3.jsonl.zstd')
    const census = capture(f.storage)
    expect(census.kind).toBe('unverified')
    expect(census.generations.map(g => g.version)).toEqual([3, 4])
    expect(census.generations.every(g => g.projectSegment === '_no-cwd' && g.sessionSegment === 'a')).toBe(true)
    expect(census).not.toHaveProperty('sha256')
    expect(Object.isFrozen(census.generations[0])).toBe(true)
  })
})
