import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activationDigest } from '../src/domain/session-activation.js'
import { inspectActivationInventory, prepareActivationMigration, type ActivationPriorModes } from '../src/domain/activation-migration.js'
import { scanActivationInventory, createActivationSelection, prepareSelectedActivationMigration, verifySelectedMigrationInventory,
  activationSelectionPending, validateActivationInventorySnapshot, validateActivationSelection, isSelectedActivationReceipt } from '../src/domain/activation-selection.js'
import { adoptActivationReceipt, activationBindingPath } from '../src/domain/activation-bindings.js'
class Unsupported extends Error {}
const unsupported = (e: unknown) => e instanceof Unsupported
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(p => rmSync(p, { force: true, recursive: true })))
const prior: ActivationPriorModes = { schema: 'dsh-activation-prior-modes/v1', previousPackage: { name: 'dsh-completion-guard', version: '0.8.4', sha256: '1'.repeat(64) }, sourceSha256: '2'.repeat(64), cohorts: [{ name: 'verified', mode: 'opt-in' }] }
function fixture(all = false) {
  const records = ['a', 'b', 'old'].map((id, i) => ({ header: { id, version: 4, createdAt: i + 1, isSeeded: false }, revision: 'r0' }))
  const blocked = new Set(all ? [] : ['old']), closed: string[] = []
  const persistence = {
    list: async () => records.map(r => structuredClone(r)),
    open: async (id: never, access: 'read') => {
      expect(access).toBe('read')
      if (blocked.has(id)) throw new Unsupported('private source path and body')
      const record = records.find(r => r.header.id === id)!
      return { header: structuredClone(record.header), inheritedEventCount: 0, close: async () => { closed.push(id) } }
    },
    stat: async (id: never) => structuredClone(records.find(r => r.header.id === id)),
  }
  return { records, blocked, closed, persistence }
}
async function selected() {
  const f = fixture(), snapshot = await scanActivationInventory(f.persistence, unsupported)
  const selection = createActivationSelection(snapshot, ['a', 'b'])
  const receipt = prepareSelectedActivationMigration(snapshot, selection, prior).receipt!
  return { ...f, snapshot, selection, receipt }
}
describe('explicit selected-inventory migration', () => {
  it('classifies only known open refusal, covers all rows, closes readable handles, emits no error text', async () => {
    const f = fixture(), snapshot = await scanActivationInventory(f.persistence, unsupported)
    expect(snapshot.rows.map(r => [r.id, r.status])).toEqual([['a', 'readable'], ['b', 'readable'], ['old', 'unsupported']])
    expect(f.closed).toEqual(['a', 'b']); expect(JSON.stringify(snapshot)).not.toContain('private')
    expect(validateActivationInventorySnapshot(snapshot)).toEqual(snapshot)
  })
  it('keeps the full-inventory default fail-closed and full all-readable flow working', async () => {
    await expect(inspectActivationInventory(fixture().persistence)).rejects.toBeInstanceOf(Unsupported)
    const inventory = await inspectActivationInventory(fixture(true).persistence)
    expect(prepareActivationMigration(inventory, prior).receipt?.entries).toHaveLength(3)
  })
  it('supports selected partial-readable and all-readable inventories without claiming whole coverage', async () => {
    const f = await selected()
    verifySelectedMigrationInventory(f.receipt, f.snapshot, f.selection)
    expect(f.receipt.entries.map(r => [r.identity.id, r.mode])).toEqual([['a', 'opt-in'], ['b', 'opt-in']])
    expect(activationSelectionPending(f.snapshot, f.selection)).toEqual([{ id: 'old', reason: 'session_format_unsupported' }])
    const full = await scanActivationInventory(fixture(true).persistence, unsupported)
    const selection = createActivationSelection(full, ['a', 'b', 'old'])
    expect(prepareSelectedActivationMigration(full, selection, prior).receipt?.entries).toHaveLength(3)
    expect(activationSelectionPending(full, selection)).toEqual([])
    expect(activationSelectionPending(full, createActivationSelection(full, ['a']))).toEqual([{ id: 'b', reason: 'not_selected' }, { id: 'old', reason: 'not_selected' }])
  })
  it.each([[], ['unknown'], ['a', 'a'], ['old'], [null], 'a'].map(include => ({ include })))('refuses empty/unknown/duplicate/unreadable/non-array selection $include', async ({ include }) => {
    const { snapshot } = await selected()
    expect(() => createActivationSelection(snapshot, include)).toThrow(/activation_selection_/)
  })
  it('validates full source mappings while requiring exact selected old-mode coverage', async () => {
    const { snapshot, selection } = await selected()
    const mixed: ActivationPriorModes = { ...prior, cohorts: [{ name: 'one', mode: 'opt-in', sessionIds: ['a'] }, { name: 'excluded', mode: 'always', sessionIds: ['old'] }] }
    expect(prepareSelectedActivationMigration(snapshot, selection, mixed)).toMatchObject({ status: 'pending', missing: ['b'] })
    expect(() => prepareSelectedActivationMigration(snapshot, selection, { ...mixed, sourceSha256: '' })).toThrow('activation_prior_modes_invalid')
    expect(() => prepareSelectedActivationMigration(snapshot, selection, { ...mixed, cohorts: [{ name: 'bad', mode: 'always', sessionIds: ['unknown'] }] })).toThrow('activation_prior_modes_invalid')
  })
  it.each(['new', 'remove', 'replace', 'revision', 'unsupported_revision', 'readable', 'unreadable'])('refuses whole-inventory drift: %s', async kind => {
    const f = await selected()
    if (kind === 'new') f.records.push({ header: { id: 'new', version: 4, createdAt: 9, isSeeded: false }, revision: 'r0' })
    if (kind === 'remove') f.records.pop()
    if (kind === 'replace') f.records[0].header.createdAt++
    if (kind === 'revision') f.records[0].revision = 'r1'
    if (kind === 'unsupported_revision') f.records[2].revision = 'r1'
    if (kind === 'readable') f.blocked.delete('old')
    if (kind === 'unreadable') f.blocked.add('a')
    const changed = await scanActivationInventory(f.persistence, unsupported)
    expect(() => verifySelectedMigrationInventory(f.receipt, changed, f.selection)).toThrow('activation_inventory_changed')
  })
  it('refuses revision drift during scan including unsupported rows', async () => {
    const f = fixture(), stat = f.persistence.stat
    f.persistence.stat = async id => { const row = await stat(id); if (row) row.revision = 'changed'; return row }
    await expect(scanActivationInventory(f.persistence, unsupported)).rejects.toThrow('activation_inventory_changed')
  })
  it('refuses duplicate list IDs and same-cardinality replacement during final list', async () => {
    const f = fixture(); f.records.push(structuredClone(f.records[0]))
    await expect(scanActivationInventory(f.persistence, unsupported)).rejects.toThrow('activation_inventory_invalid')
    const g = fixture(), list = g.persistence.list; let calls = 0
    g.persistence.list = async () => { const rows = await list(); if (++calls === 2) rows[0].header.id = 'replacement'; return rows }
    await expect(scanActivationInventory(g.persistence, unsupported)).rejects.toThrow('activation_inventory_changed')
  })
  it('refuses malformed handles and non-serializable snapshot revisions; full default detects final-list revision drift', async () => {
    const f = fixture(); f.persistence.open = async () => undefined as never
    await expect(scanActivationInventory(f.persistence, unsupported)).rejects.toThrow('activation_inventory_invalid')
    const g = fixture(); g.records[0].revision = Symbol('opaque') as never
    g.persistence.list = async () => g.records.map(r => ({ header: { ...r.header }, revision: r.revision }))
    await expect(scanActivationInventory(g.persistence, unsupported)).rejects.toThrow('activation_inventory_revision_unavailable')
    const h = fixture(true), list = h.persistence.list; let calls = 0
    h.persistence.list = async () => { const rows = await list(); if (++calls === 2) rows[0].revision = 'changed'; return rows }
    await expect(inspectActivationInventory(h.persistence)).rejects.toThrow('activation_inventory_changed')
  })
  it('does not classify forged name, corruption, permissions or generic IO as unsupported', async () => {
    for (const error of [Object.assign(new Error('private path'), { name: 'SessionFormatUnsupportedError' }), new TypeError('corrupt'), Object.assign(new Error('denied'), { code: 'EACCES' })]) {
      const f = fixture(); f.persistence.open = async () => { throw error }
      await expect(scanActivationInventory(f.persistence, unsupported)).rejects.toBe(error)
    }
  })
  it('binds manifest, snapshot and selected receipt digests; refuses full or another selected receipt', async () => {
    const f = await selected()
    expect(isSelectedActivationReceipt(f.receipt)).toBe(true)
    const full = prepareActivationMigration(f.receipt.entries.map(r => r.identity), prior).receipt!
    expect(isSelectedActivationReceipt(full)).toBe(false)
    expect(() => verifySelectedMigrationInventory(full, f.snapshot, f.selection)).toThrow('activation_selection_receipt_conflict')
    const other = createActivationSelection(f.snapshot, ['a'])
    expect(() => verifySelectedMigrationInventory(f.receipt, f.snapshot, other)).toThrow('activation_selection_receipt_conflict')
    expect(() => validateActivationSelection({ ...f.selection, include: ['a'] })).toThrow('activation_selection_invalid')
    expect(() => validateActivationInventorySnapshot({ ...f.snapshot, rows: [] })).toThrow('activation_inventory_snapshot_invalid')
  })
  it('verify never writes; repeated adoption is byte-identical and leaves excluded IDs untouched', async () => {
    const f = await selected(), root = mkdtempSync(join(tmpdir(), 'activation-selected-')); dirs.push(root)
    verifySelectedMigrationInventory(f.receipt, f.snapshot, f.selection)
    expect(adoptActivationReceipt(root, f.receipt, true).status).toBe('partial')
    expect(adoptActivationReceipt(root, f.receipt).status).toBe('complete')
    const before = f.receipt.entries.map(r => readFileSync(activationBindingPath(root, r.identity.id)))
    expect(adoptActivationReceipt(root, f.receipt).entries.every(r => 'created' in r && r.created === false)).toBe(true)
    expect(f.receipt.entries.map(r => readFileSync(activationBindingPath(root, r.identity.id)))).toEqual(before)
    expect(adoptActivationReceipt(root, f.receipt, true).status).toBe('complete')
    expect(() => readFileSync(activationBindingPath(root, 'old'))).toThrow()
    expect(activationDigest(f.receipt.inputs)).toMatch(/^[a-f0-9]{64}$/)
  })
})
