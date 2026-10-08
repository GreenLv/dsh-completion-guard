import { activationCanonical, activationDigest, sessionBirthIdentity, type InitialActivation, type SessionBirthIdentity } from './session-activation.js'
import { createActivationMigrationReceipt, type ActivationMigrationReceipt } from './activation-bindings.js'

/** Only the public persistence service is consumed. No event bodies are emitted. */
export interface ActivationInventoryPersistence {
  list(): Promise<readonly { header: unknown; revision: unknown }[]>
  open(id: never, access: 'read'): Promise<{ header: unknown; inheritedEventCount: unknown; close(): Promise<void> }>
  stat(id: never): Promise<{ header: unknown; revision: unknown } | undefined>
}
export async function inspectActivationInventory(persistence: ActivationInventoryPersistence): Promise<SessionBirthIdentity[]> {
  const rows = await persistence.list(), identities: SessionBirthIdentity[] = [], ids = new Set<string>()
  const beforeMetadata = new Map(rows.map(row => [String((row.header as { id?: unknown })?.id),
    { headerSha256: activationDigest(row.header), revision: row.revision }]))
  for (const row of rows) {
    const header = row.header as { id?: unknown }
    if (typeof header?.id !== 'string' || ids.has(header.id)) throw new Error('activation_inventory_invalid')
    ids.add(header.id)
    const handle = await persistence.open(header.id as never, 'read')
    try {
      const identity = sessionBirthIdentity(handle.header, handle.inheritedEventCount)
      const after = await persistence.stat(header.id as never)
      if (identity.id !== header.id || activationCanonical(row.header) !== activationCanonical(handle.header)
        || !after || after.revision !== row.revision || activationCanonical(after.header) !== activationCanonical(row.header)) {
        throw new Error('activation_inventory_changed')
      }
      identities.push(identity)
    } finally { await handle.close() }
  }
  const after = await persistence.list()
  if (after.length !== rows.length || after.some(row => !ids.has(String((row.header as { id?: unknown }).id)))
    || after.some(row => {
      const before = beforeMetadata.get(String((row.header as { id?: unknown }).id))
      return !before || row.revision !== before.revision || activationDigest(row.header) !== before.headerSha256
    })) throw new Error('activation_inventory_changed')
  return identities.sort((a, b) => a.id.localeCompare(b.id))
}
export interface ActivationPriorModes {
  schema: 'dsh-activation-prior-modes/v1'
  previousPackage: { name: 'dsh-completion-guard'; version: string; sha256: string }
  /** Exact source readback digest. An operator must establish these old modes before upgrade. */
  sourceSha256: string
  cohorts: Array<{ name: string; mode: InitialActivation; sessionIds?: string[] }>
}
export function prepareActivationMigration(inventory: SessionBirthIdentity[], prior: ActivationPriorModes, universeIds: string[] = inventory.map(i => i.id)): {
  status: 'ready' | 'pending'; missing: string[]; receipt?: ActivationMigrationReceipt
} {
  if (!prior || prior.schema !== 'dsh-activation-prior-modes/v1' || prior.previousPackage?.name !== 'dsh-completion-guard'
    || !/^0\.[0-8]\.\d+(?:[-+][\w.-]+)?$/u.test(prior.previousPackage.version)
    || !/^[a-f0-9]{64}$/u.test(prior.previousPackage.sha256) || !/^[a-f0-9]{64}$/u.test(prior.sourceSha256)
    || !Array.isArray(prior.cohorts) || !prior.cohorts.length) throw new Error('activation_prior_modes_invalid')
  const ids = new Set(inventory.map(i => i.id))
  if (ids.size !== inventory.length || !inventory.length) throw new Error('activation_inventory_invalid')
  const universe = new Set(universeIds)
  if (universe.size !== universeIds.length || inventory.some(i => !universe.has(i.id))) throw new Error('activation_inventory_invalid')
  for (const cohort of prior.cohorts) {
    if (!cohort || !cohort.name || !['opt-in', 'always'].includes(cohort.mode)
      || (cohort.sessionIds !== undefined && (!Array.isArray(cohort.sessionIds)
        || cohort.sessionIds.some(id => !universe.has(id)) || new Set(cohort.sessionIds).size !== cohort.sessionIds.length))) throw new Error('activation_prior_modes_invalid')
  }
  const uniform = new Set(prior.cohorts.map(c => c.mode)).size === 1
  const missing: string[] = [], entries = inventory.flatMap(identity => {
    const mapped = prior.cohorts.filter(c => c.sessionIds?.includes(identity.id))
    const choices = mapped.length ? mapped : uniform ? prior.cohorts : []
    if (!choices.length || new Set(choices.map(c => c.mode)).size !== 1) { missing.push(identity.id); return [] }
    return [{ identity, mode: choices[0].mode, cohort: choices.map(c => c.name).sort().join(',') }]
  })
  if (missing.length) return { status: 'pending', missing }
  return { status: 'ready', missing, receipt: createActivationMigrationReceipt(entries, {
    inventory: activationDigest(inventory), prior_modes: activationDigest(prior), previous_package: prior.previousPackage.sha256,
    source: prior.sourceSha256,
  }) }
}
export function verifyMigrationInventory(receipt: ActivationMigrationReceipt, inventory: SessionBirthIdentity[]): void {
  const current = new Map(inventory.map(identity => [identity.id, identity]))
  if (current.size !== inventory.length || inventory.length !== receipt.entries.length) throw new Error('activation_inventory_changed')
  for (const entry of receipt.entries) {
    const identity = current.get(entry.identity.id)
    if (!identity || activationCanonical(identity) !== activationCanonical(entry.identity)) throw new Error('activation_inventory_identity_conflict')
  }
}
