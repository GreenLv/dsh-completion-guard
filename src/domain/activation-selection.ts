import { activationCanonical, activationDigest, sessionBirthIdentity, type SessionBirthIdentity } from './session-activation.js'
import { createActivationMigrationReceipt, type ActivationMigrationReceipt } from './activation-bindings.js'
import { prepareActivationMigration, verifyMigrationInventory, type ActivationInventoryPersistence, type ActivationPriorModes } from './activation-migration.js'

type InventoryRow = { id: string; headerSha256: string; revisionSha256: string } & (
  { status: 'readable'; identity: SessionBirthIdentity } | { status: 'unsupported'; reason: 'session_format_unsupported' })
export interface ActivationInventorySnapshot {
  schema: 'dsh-activation-inventory/v1'
  rows: InventoryRow[]
  sha256: string
}
export interface ActivationMigrationSelection {
  schema: 'dsh-activation-selection/v1'
  inventorySha256: string
  include: string[]
  sha256: string
}
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v)
const keys = (v: object, expected: string) => Object.keys(v).sort().join(',') === expected
const sorted = <T extends { id: string }>(rows: T[]): T[] => rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const SCOPE = activationDigest('dsh-activation-selected-inventory/v1')

function metadata(row: { header: unknown; revision: unknown }) {
  const id = (row.header as { id?: unknown })?.id
  if (typeof id !== 'string' || !id) throw new Error('activation_inventory_invalid')
  if (typeof row.revision !== 'string' || !row.revision) throw new Error('activation_inventory_revision_unavailable')
  return { id, headerSha256: activationDigest(row.header), revisionSha256: activationDigest(row.revision) }
}
/** Only a physical runtime's official error-class predicate may classify open
 * refusals. Unknown errors/list/stat failures abort; they are never exclusions. */
export async function scanActivationInventory(persistence: ActivationInventoryPersistence,
  isFormatUnsupported: (error: unknown) => boolean): Promise<ActivationInventorySnapshot> {
  const listed = await persistence.list(), before = sorted(listed.map(metadata)), rows: InventoryRow[] = []
  if (new Set(before.map(r => r.id)).size !== before.length) throw new Error('activation_inventory_invalid')
  for (const row of before) {
    let handle: Awaited<ReturnType<ActivationInventoryPersistence['open']>> | undefined
    let formatUnsupported = false
    try { handle = await persistence.open(row.id as never, 'read') }
    catch (error) {
      if (!isFormatUnsupported(error)) throw error
      formatUnsupported = true
    }
    if (!handle && !formatUnsupported) throw new Error('activation_inventory_invalid')
    if (handle) {
      try {
        const identity = sessionBirthIdentity(handle.header, handle.inheritedEventCount)
        if (identity.id !== row.id || activationDigest(handle.header) !== row.headerSha256) throw new Error('activation_inventory_changed')
        rows.push({ ...row, status: 'readable', identity })
      } finally { await handle.close() }
    } else rows.push({ ...row, status: 'unsupported', reason: 'session_format_unsupported' })
    const after = await persistence.stat(row.id as never)
    if (!after || activationCanonical(metadata(after)) !== activationCanonical(row)) throw new Error('activation_inventory_changed')
  }
  const after = sorted((await persistence.list()).map(metadata))
  if (activationCanonical(before) !== activationCanonical(after)) throw new Error('activation_inventory_changed')
  const unsigned = { schema: 'dsh-activation-inventory/v1' as const, rows }
  return { ...unsigned, sha256: activationDigest(unsigned) }
}
export function validateActivationInventorySnapshot(value: unknown): ActivationInventorySnapshot {
  const snapshot = value as ActivationInventorySnapshot
  if (!snapshot || !keys(snapshot, 'rows,schema,sha256') || snapshot.schema !== 'dsh-activation-inventory/v1'
    || !Array.isArray(snapshot.rows) || !hex(snapshot.sha256)) throw new Error('activation_inventory_snapshot_invalid')
  const ids = new Set<string>()
  for (const row of snapshot.rows) {
    if (!row || typeof row.id !== 'string' || !row.id || ids.has(row.id) || !hex(row.headerSha256) || !hex(row.revisionSha256)) throw new Error('activation_inventory_snapshot_invalid')
    ids.add(row.id)
    if (row.status === 'readable') {
      if (!keys(row, 'headerSha256,id,identity,revisionSha256,status')
        || activationCanonical(sessionBirthIdentity({ ...row.identity, version: 4 }, row.identity?.inheritedEventCount)) !== activationCanonical(row.identity)
        || row.identity.id !== row.id) throw new Error('activation_inventory_snapshot_invalid')
    } else if (row.status !== 'unsupported' || !keys(row, 'headerSha256,id,reason,revisionSha256,status')
      || row.reason !== 'session_format_unsupported') throw new Error('activation_inventory_snapshot_invalid')
  }
  const { sha256, ...unsigned } = snapshot
  if (activationDigest(unsigned) !== sha256) throw new Error('activation_inventory_snapshot_invalid')
  return snapshot
}
export function validateActivationSelection(value: unknown): ActivationMigrationSelection {
  const selection = value as ActivationMigrationSelection
  if (!selection || !keys(selection, 'include,inventorySha256,schema,sha256') || selection.schema !== 'dsh-activation-selection/v1'
    || !hex(selection.inventorySha256) || !hex(selection.sha256) || !Array.isArray(selection.include) || !selection.include.length
    || selection.include.some(id => typeof id !== 'string' || !id) || new Set(selection.include).size !== selection.include.length) throw new Error('activation_selection_invalid')
  const { sha256, ...unsigned } = selection
  if (activationDigest(unsigned) !== sha256) throw new Error('activation_selection_invalid')
  return selection
}
export function selectedActivationInventory(snapshotValue: unknown, selectionValue: unknown): SessionBirthIdentity[] {
  const snapshot = validateActivationInventorySnapshot(snapshotValue), selection = validateActivationSelection(selectionValue)
  if (selection.inventorySha256 !== snapshot.sha256) throw new Error('activation_inventory_changed')
  const byId = new Map(snapshot.rows.map(row => [row.id, row]))
  return selection.include.map(id => {
    const row = byId.get(id)
    if (!row || row.status !== 'readable') throw new Error('activation_selection_unreadable')
    return row.identity
  })
}
export function createActivationSelection(snapshotValue: unknown, include: unknown): ActivationMigrationSelection {
  const snapshot = validateActivationInventorySnapshot(snapshotValue)
  if (!Array.isArray(include) || !include.length || include.some(id => typeof id !== 'string' || !id)
    || new Set(include).size !== include.length) throw new Error('activation_selection_invalid')
  const unsigned = { schema: 'dsh-activation-selection/v1' as const, inventorySha256: snapshot.sha256, include: [...include].sort() as string[] }
  const selection = { ...unsigned, sha256: activationDigest(unsigned) }
  selectedActivationInventory(snapshot, selection)
  return selection
}
export function activationSelectionPending(snapshot: ActivationInventorySnapshot, selection: ActivationMigrationSelection): Array<{ id: string; reason: 'session_format_unsupported' | 'not_selected' }> {
  selectedActivationInventory(snapshot, selection)
  return snapshot.rows.filter(row => !selection.include.includes(row.id)).map(row => ({ id: row.id,
    reason: row.status === 'unsupported' ? 'session_format_unsupported' : 'not_selected' }))
}
export function prepareSelectedActivationMigration(snapshot: ActivationInventorySnapshot, selection: ActivationMigrationSelection, prior: ActivationPriorModes): ReturnType<typeof prepareActivationMigration> {
  const inventory = selectedActivationInventory(snapshot, selection)
  const result = prepareActivationMigration(inventory, prior, snapshot.rows.map(r => r.id))
  if (!result.receipt) return result
  return { ...result, receipt: createActivationMigrationReceipt(result.receipt.entries,
    { ...result.receipt.inputs, inventory_snapshot: snapshot.sha256, selection: selection.sha256, scope: SCOPE }) }
}
export function isSelectedActivationReceipt(receipt: ActivationMigrationReceipt): boolean {
  return ['inventory_snapshot', 'selection', 'scope'].some(key => Object.hasOwn(receipt.inputs, key))
}
export function verifySelectedMigrationInventory(receipt: ActivationMigrationReceipt, snapshot: ActivationInventorySnapshot, selection: ActivationMigrationSelection): void {
  const inventory = selectedActivationInventory(snapshot, selection)
  if (receipt.inputs.inventory_snapshot !== snapshot.sha256 || receipt.inputs.selection !== selection.sha256
    || receipt.inputs.scope !== SCOPE || receipt.inputs.inventory !== activationDigest(inventory)) throw new Error('activation_selection_receipt_conflict')
  verifyMigrationInventory(receipt, inventory)
}
