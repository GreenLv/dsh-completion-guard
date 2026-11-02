import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { captureActivationPhysicalInventory, assertActivationPhysicalRows, guardActivationInventory, resolveActivationPersistencePlugin } from '../src/domain/activation-physical-inventory.js'

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

describe('activation physical completeness fence', () => {
  it('retains official default and namespace plugin shapes and rejects invalid exports', () => {
    const plugin = () => undefined, namespace = { apply: () => undefined }
    expect(resolveActivationPersistencePlugin({ default: plugin })).toBe(plugin)
    expect(resolveActivationPersistencePlugin(namespace)).toBe(namespace)
    expect(() => resolveActivationPersistencePlugin({ default: {} })).toThrow('activation_backend_module_invalid')
  })
  it('rejects a hidden corrupt or future generation even beside a listed valid session', () => {
    for (const file of ['session.v4.jsonl.zstd', 'session.v5.jsonl.zstd']) {
      const f = fixture(); f.add('valid'); const bad = f.add('hidden', file, 'invalid or future')
      const before = readFileSync(bad)
      if (file.includes('v5')) expect(() => capture(f.storage)).toThrow('activation_inventory_unsupported')
      else expect(() => assertActivationPhysicalRows(capture(f.storage), rows('valid'))).toThrow('activation_inventory_incomplete')
      expect(readFileSync(bad)).toEqual(before)
    }
  })
  it('accepts an existing empty root and rejects hidden rows, wrong encoding, links and missing roots', () => {
    const f = fixture(); expect(capture(f.storage).sessionSegments).toEqual([])
    expect(() => capture(join(f.root, 'missing'))).toThrow()
    f.add('hidden'); expect(() => assertActivationPhysicalRows(capture(f.storage), [])).toThrow('activation_inventory_incomplete')
    const g = fixture(); g.add('a', 'session.v4.jsonl'); expect(() => capture(g.storage)).toThrow('activation_inventory_unsupported')
    const h = fixture(); const file = h.add('a'); symlinkSync(file, join(h.storage, '_no-cwd', 'a', 'other.jsonl.zstd')); expect(() => capture(h.storage)).toThrow('activation_inventory_unsupported')
  })
  it('rejects multiple generations and future generations within a visible session', () => {
    for (const second of ['session.v3.jsonl.zstd', 'session.v5.jsonl.zstd']) {
      const f = fixture(); f.add('a'); f.add('a', second)
      expect(() => capture(f.storage)).toThrow('activation_inventory_unsupported')
    }
  })
  it('refuses physical mutation during the SDK listing even when listed IDs do not change', async () => {
    const f = fixture(); f.add('a')
    const guarded = guardActivationInventory({ list: async () => { f.add('hidden'); return rows('a') } }, () => capture(f.storage))
    await expect(guarded.list()).rejects.toThrow('activation_inventory_changed')
  })
  it('binds serializer, root, metadata and additions while allowing exact physical-to-list rows', () => {
    const f = fixture(); const file = f.add('a'); f.add('b')
    const before = capture(f.storage); expect(() => assertActivationPhysicalRows(before, rows('a', 'b'))).not.toThrow()
    const metadata = statSync(file)
    writeFileSync(file, Buffer.alloc(metadata.size, 0x78)); utimesSync(file, metadata.atime, metadata.mtime)
    expect(capture(f.storage).sha256).not.toBe(before.sha256)
    const second = capture(f.storage); f.add('c'); expect(capture(f.storage).sha256).not.toBe(second.sha256)
    expect(captureActivationPhysicalInventory(f.storage, 'zstd', 'b'.repeat(64)).sha256).not.toBe(capture(f.storage).sha256)
  })
})
