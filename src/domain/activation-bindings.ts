import type { Stats } from 'node:fs'
import { closeSync, constants, existsSync, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { sha256 } from './canonicalize.js'
import { resolvePrivateLedgerRoot, withPrivateWriterLock } from './private-ledger.js'
import { activationCanonical, activationDigest, activationJson, validateActivationBinding,
  type InitialActivation, type SessionActivationBinding, type SessionActivationRead, type SessionBirthIdentity } from './session-activation.js'

export function resolveActivationBindingsRoot(dshHome: string | undefined, osHome: string = homedir()): string {
  const ledger = resolvePrivateLedgerRoot(undefined, dshHome, osHome)
  if (!ledger) throw new Error('activation_home_unavailable')
  return join(dirname(ledger), 'activation-bindings-v1')
}
export const activationBindingPath = (root: string, id: string): string => join(root, `${sha256(`dsh/session-activation/v1\0${id}`)}.json`)
function safeStat(path: string, directory: boolean): Stats {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
    || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) throw new Error('activation_storage_unsafe')
  return stat
}
function safeAncestors(path: string): void {
  // Windows owner/ACL qualification is a native capability; lstat still
  // rejects ancestor links. POSIX permits only root-owned system aliases.
  let parent = dirname(path)
  while (true) {
    const stat = lstatSync(parent)
    const systemAlias = process.platform === 'darwin' && stat.uid === 0 && ['/var', '/tmp'].includes(parent)
    if ((stat.isSymbolicLink() && !systemAlias) || (!stat.isSymbolicLink() && !stat.isDirectory())
      || (process.getuid && stat.uid !== process.getuid() && stat.uid !== 0)
      || (process.getuid && !stat.isSymbolicLink() && (stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)) {
      throw new Error('activation_storage_unsafe')
    }
    const next = dirname(parent)
    if (next === parent) break
    parent = next
  }
}
function readRegular(path: string): string {
  const entry = safeStat(path, false)
  const fd = openSync(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW))
  try {
    const stat = fstatSync(fd), current = safeStat(path, false)
    if (!stat.isFile() || stat.dev !== entry.dev || stat.ino !== entry.ino || stat.dev !== current.dev || stat.ino !== current.ino
      || stat.size > 16 * 1024 * 1024) throw new Error('activation_storage_unsafe')
    return readFileSync(fd, 'utf8')
  } finally { closeSync(fd) }
}
function errorCode(error: unknown): string {
  return error instanceof Error && /^activation_[a-z_]+$/u.test(error.message) ? error.message : 'activation_storage_unavailable'
}
function requireCompletedPublication(path: string): void {
  try { lstatSync(`${path}.pending`); throw new Error('activation_publication_incomplete') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
function readActivationBindingInternal(root: string, identity: SessionBirthIdentity | string, explicit?: InitialActivation, incompleteRead = false): SessionActivationRead {
  try {
    if (!existsSync(root)) {
      try { lstatSync(root); throw new Error('activation_storage_unsafe') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      return { status: 'unavailable', reasonCode: 'activation_mode_unknown', key: 'missing-root' }
    }
    safeAncestors(root); safeStat(root, true)
    const id = typeof identity === 'string' ? identity : identity.id
    const path = activationBindingPath(root, id)
    if (!incompleteRead) requireCompletedPublication(path)
    if (!existsSync(path)) {
      // lstat distinguishes a dangling symlink from an absent slot.
      try { lstatSync(path); throw new Error('activation_storage_unsafe') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      return { status: 'unavailable', reasonCode: 'activation_mode_unknown', key: 'missing' }
    }
    const bytes = readRegular(path)
    const binding = validateActivationBinding(activationJson(bytes))
    if (binding.identity.id !== id || (typeof identity !== 'string' && activationCanonical(binding.identity) !== activationCanonical(identity))) throw new Error('activation_identity_conflict')
    if (explicit && explicit !== binding.initialMode) throw new Error('activation_mode_conflict')
    // A new publisher may have created pending after the first check, then
    // linked a visible final while this reader opened it. Recheck before use.
    if (!incompleteRead) requireCompletedPublication(path)
    return { status: 'bound', mode: binding.initialMode, binding, key: sha256(bytes) }
  } catch (error) {
    const reasonCode = errorCode(error)
    return { status: 'unavailable', reasonCode, key: reasonCode }
  }
}
export function readActivationBinding(root: string, identity: SessionBirthIdentity, explicit?: InitialActivation): SessionActivationRead {
  return readActivationBindingInternal(root, identity, explicit)
}
/** Re-entry never infers a successful file flush from valid bytes. */
function flushExistingRegular(path: string, expectedBytes: string, prefix: string): void {
  const entry = safeStat(path, false)
  let fd: number
  try { fd = openSync(path, constants.O_RDWR | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)) }
  catch { throw new Error(`${prefix}_open_failed`) }
  try {
    const stat = fstatSync(fd), current = safeStat(path, false)
    let bytes: string
    try { bytes = readFileSync(fd, 'utf8') } catch { throw new Error(`${prefix}_readback_failed`) }
    if (!stat.isFile() || stat.dev !== entry.dev || stat.ino !== entry.ino || current.dev !== stat.dev || current.ino !== stat.ino
      || bytes !== expectedBytes) throw new Error(`${prefix}_identity_changed`)
    try { fsyncSync(fd) } catch { throw new Error(`${prefix}_flush_failed`) }
  } finally { closeSync(fd) }
  try {
    const bytes = readRegular(path), after = safeStat(path, false)
    if (after.dev !== entry.dev || after.ino !== entry.ino || bytes !== expectedBytes) throw new Error(`${prefix}_identity_changed`)
  } catch { throw new Error(`${prefix}_readback_failed`) }
}
function publicationBarrier(root: string, path: string, expected: SessionActivationBinding, platform: NodeJS.Platform = process.platform): string {
  const expectedBytes = activationCanonical(expected) + '\n'
  const published = safeStat(path, false)
  if (platform === 'win32') {
    flushExistingRegular(path, expectedBytes, 'activation_publication')
  } else {
    const dir = openSync(root, constants.O_RDONLY)
    try { fsyncSync(dir) } catch { throw new Error('activation_directory_durability_unavailable') } finally { closeSync(dir) }
  }
  try {
    const bytes = readRegular(path)
    const after = safeStat(path, false)
    if (after.dev !== published.dev || after.ino !== published.ino || bytes !== expectedBytes) throw new Error('activation_publication_identity_changed')
    return sha256(bytes)
  } catch { throw new Error('activation_publication_readback_failed') }
}
export function writeActivationBinding(root: string, identity: SessionBirthIdentity, mode: InitialActivation,
  source: SessionActivationBinding['source'], provenanceSha256: string): SessionActivationRead & { created?: boolean } {
  try {
    if (resolve(root) !== root) throw new Error('activation_storage_unsafe')
    let existing = dirname(root)
    while (!existsSync(existing)) { const next = dirname(existing); if (next === existing) break; existing = next }
    safeAncestors(join(existing, 'probe'))
    mkdirSync(root, { recursive: true, mode: 0o700 }); safeAncestors(root); safeStat(root, true)
    return withPrivateWriterLock(root, () => {
      const path = activationBindingPath(root, identity.id), temporary = `${path}.pending`
      const current = readActivationBinding(root, identity)
      if (current.status === 'bound') {
        if (current.mode !== mode) throw new Error('activation_mode_conflict')
        return { ...current, created: false }
      }
      if (!['activation_mode_unknown', 'activation_publication_incomplete'].includes(current.reasonCode)) return current
      let binding: SessionActivationBinding
      let created = false
      // A retained exclusive temporary is an incomplete publication, not a
      // second final or a global birth-intent log. Only controlled same-value
      // writing can complete its barrier; ordinary readers always refuse it.
      if (existsSync(temporary)) {
        binding = validateActivationBinding(activationJson(readRegular(temporary)))
        if (activationCanonical(binding.identity) !== activationCanonical(identity)) throw new Error('activation_identity_conflict')
        if (binding.initialMode !== mode) throw new Error('activation_mode_conflict')
        flushExistingRegular(temporary, activationCanonical(binding) + '\n', 'activation_temporary')
      } else {
        if (current.reasonCode === 'activation_publication_incomplete') throw new Error('activation_storage_unsafe')
        const unsigned = { schema: 'dsh-session-activation/v1' as const, identity, initialMode: mode, source, provenanceSha256 }
        binding = { ...unsigned, sha256: activationDigest(unsigned) }
        validateActivationBinding(binding)
        const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
        try {
          const bytes = Buffer.from(activationCanonical(binding) + '\n')
          let offset = 0
          while (offset < bytes.length) { const n = writeSync(fd, bytes, offset, bytes.length - offset); if (n <= 0) throw new Error('activation_write_incomplete'); offset += n }
          try { fsyncSync(fd) } catch { throw new Error('activation_temporary_flush_failed') }
        } finally { closeSync(fd) }
        created = true
      }
      const final = readActivationBindingInternal(root, identity, mode, true)
      if (final.status === 'bound') {
        const pendingStat = safeStat(temporary, false), finalStat = safeStat(path, false)
        if (pendingStat.dev !== finalStat.dev || pendingStat.ino !== finalStat.ino
          || activationCanonical(final.binding) !== activationCanonical(binding)) throw new Error('activation_publication_identity_changed')
      } else if (final.reasonCode === 'activation_mode_unknown') {
        linkSync(temporary, path) // Never replace an existing final slot.
      } else return final
      const key = publicationBarrier(root, path, binding)
      // The required final publication barrier and independent readback are
      // complete before removing the temporary. Cleanup durability is separate.
      unlinkSync(temporary)
      return { status: 'bound' as const, mode, binding, key, created }
    })
  } catch (error) {
    const reasonCode = errorCode(error)
    return { status: 'unavailable', reasonCode, key: reasonCode }
  }
}

export interface ActivationMigrationEntry { identity: SessionBirthIdentity; mode: InitialActivation; cohort: string }
export interface ActivationMigrationReceipt {
  schema: 'dsh-activation-migration/v1'
  entries: ActivationMigrationEntry[]
  inputs: Record<string, string>
  sha256: string
}
export function createActivationMigrationReceipt(entries: ActivationMigrationEntry[], inputs: Record<string, string>): ActivationMigrationReceipt {
  const unsigned = { schema: 'dsh-activation-migration/v1' as const, entries: [...entries].sort((a,b) => a.identity.id.localeCompare(b.identity.id)), inputs }
  const receipt = { ...unsigned, sha256: activationDigest(unsigned) }
  validateActivationMigrationReceipt(receipt)
  return receipt
}
export function validateActivationMigrationReceipt(value: unknown): ActivationMigrationReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('activation_receipt_invalid')
  const r = value as ActivationMigrationReceipt
  if (Object.keys(r).sort().join(',') !== 'entries,inputs,schema,sha256' || r.schema !== 'dsh-activation-migration/v1'
    || !Array.isArray(r.entries) || !r.entries.length || !r.inputs || typeof r.inputs !== 'object' || Array.isArray(r.inputs)
    || !Object.keys(r.inputs).length || Object.values(r.inputs).some(d => typeof d !== 'string' || !/^[a-f0-9]{64}$/u.test(d))) throw new Error('activation_receipt_invalid')
  const ids = new Set<string>()
  for (const entry of r.entries) {
    const probe = { schema: 'dsh-session-activation/v1' as const, identity: entry.identity, initialMode: entry.mode,
      source: 'legacy_adoption' as const, provenanceSha256: '0'.repeat(64) }
    validateActivationBinding({ ...probe, sha256: activationDigest(probe) })
    if (Object.keys(entry).sort().join(',') !== 'cohort,identity,mode' || typeof entry.cohort !== 'string' || !entry.cohort || ids.has(entry.identity.id)) throw new Error('activation_receipt_invalid')
    ids.add(entry.identity.id)
  }
  const { sha256: digest, ...unsigned } = r
  if (digest !== activationDigest(unsigned)) throw new Error('activation_receipt_digest_invalid')
  return r
}
export function readActivationMigrationReceipt(path: string): ActivationMigrationReceipt {
  return validateActivationMigrationReceipt(activationJson(readRegular(path)))
}
export function adoptActivationReceipt(root: string, receipt: ActivationMigrationReceipt, verifyOnly = false): {
  status: 'complete' | 'partial'; entries: Array<{ id: string; status: string; reasonCode?: string; created?: boolean }>
} {
  validateActivationMigrationReceipt(receipt)
  const entries = receipt.entries.map(entry => {
    const result = verifyOnly ? readActivationBinding(root, entry.identity, entry.mode)
      : writeActivationBinding(root, entry.identity, entry.mode, 'legacy_adoption', receipt.sha256)
    return result.status === 'bound' ? { id: entry.identity.id, status: 'bound', ...('created' in result ? { created: result.created as boolean } : {}) }
      : { id: entry.identity.id, status: 'unavailable', reasonCode: result.reasonCode }
  })
  return { status: entries.every(e => e.status === 'bound') ? 'complete' : 'partial', entries }
}

/** Fresh creation is a qualified public lifecycle contract, not an issuer token. */
export function resolveSessionActivation(root: string, identity: SessionBirthIdentity,
  requested: { activation: InitialActivation; activationSource?: 'default' | 'explicit' },
  source: string | undefined, qualifiedPublicIdentity: boolean): SessionActivationRead {
  const explicit = requested.activationSource === 'explicit' ? requested.activation : undefined
  const current = readActivationBinding(root, identity, explicit)
  if (current.status === 'bound' || current.reasonCode !== 'activation_mode_unknown') return current
  if (source !== 'startup' || !qualifiedPublicIdentity) return { status: 'unavailable',
    reasonCode: source === 'startup' ? 'activation_source_unavailable' : 'activation_mode_unknown', key: 'unbound' }
  if (identity.isSeeded || identity.parentSession) {
    if (!identity.parentSession) return { status: 'unavailable', reasonCode: 'activation_parent_unknown', key: 'parent' }
    // Parent birth identity is stored in its immutable slot. The host owns
    // the exact fork cut; no inherited event count or marker guesses a mode.
    const parent = readActivationBindingInternal(root, identity.parentSession, explicit)
    if (parent.status !== 'bound') {
      const reasonCode = parent.reasonCode === 'activation_mode_unknown' ? 'activation_parent_unknown' : parent.reasonCode
      return { status: 'unavailable', reasonCode, key: reasonCode }
    }
    return writeActivationBinding(root, identity, parent.mode, 'fork_inheritance', parent.binding.sha256)
  }
  return writeActivationBinding(root, identity, requested.activation, 'fresh_creation',
    activationDigest({ contract: 'qualified-dsh-rc2-public-startup/v1', identity }))
}

/** Portable owning tests exercise the platform branch; not host qualification. */
export const __activationBindingInternals: { publicationBarrier: typeof publicationBarrier } = { publicationBarrier }
