import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activationBindingPath, adoptActivationReceipt, createActivationMigrationReceipt, readActivationBinding,
  resolveActivationBindingsRoot, resolveSessionActivation, writeActivationBinding } from '../src/domain/activation-bindings.js'
import { activationDigest, activationJson, sessionBirthIdentity } from '../src/domain/session-activation.js'
import { inspectActivationInventory, prepareActivationMigration } from '../src/domain/activation-migration.js'
const dirs: string[] = []
function root() { const dir = mkdtempSync(join(tmpdir(), 'dsh-activation-')); dirs.push(dir); return dir }
const birth = (id = 'one', overrides = {}) => sessionBirthIdentity({ version: 4, id, createdAt: 1, isSeeded: false, ...overrides }, 0)
const digest = '1'.repeat(64)
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
describe('session mode write-once store', () => {
  it('uses the same official home expansion and blank environment fallback as the private ledger', () => {
    const home = join(tmpdir(), 'fixture-home')
    expect(resolveActivationBindingsRoot('~/.dsh', home)).toBe(join(home, '.dsh', 'completion-guard', 'activation-bindings-v1'))
    expect(resolveActivationBindingsRoot('~', home)).toBe(join(home, 'completion-guard', 'activation-bindings-v1'))
    expect(resolveActivationBindingsRoot('~\\.dsh', home)).toBe(join(home, '.dsh', 'completion-guard', 'activation-bindings-v1'))
    expect(resolveActivationBindingsRoot('  ', home)).toBe(resolveActivationBindingsRoot(undefined, home))
  })
  it('binds qualified fresh creation and restores an empty identity without reselecting its mode', () => {
    const dir = root(), identity = birth()
    expect(resolveSessionActivation(dir, identity, { activation: 'always', activationSource: 'default' }, 'startup', true)).toMatchObject({ status: 'bound', mode: 'always' })
    expect(resolveSessionActivation(dir, identity, { activation: 'opt-in', activationSource: 'default' }, 'resume', true)).toMatchObject({ status: 'bound', mode: 'always' })
    expect(resolveSessionActivation(dir, identity, { activation: 'opt-in', activationSource: 'explicit' }, 'resume', true)).toMatchObject({ status: 'unavailable', reasonCode: 'activation_mode_conflict' })
  })
  it.each(['resume', 'clear', 'compact', undefined])('never guesses missing restore mode at %s', source => {
    expect(resolveSessionActivation(root(), birth(), { activation: 'always' }, source, true)).toMatchObject({ reasonCode: 'activation_mode_unknown' })
  })
  it('refuses an unqualified startup and exact same id with different birth', () => {
    const dir = root()
    expect(resolveSessionActivation(dir, birth(), { activation: 'always' }, 'startup', false)).toMatchObject({ reasonCode: 'activation_source_unavailable' })
    writeActivationBinding(dir, birth(), 'opt-in', 'legacy_adoption', digest)
    expect(writeActivationBinding(dir, birth('one', { createdAt: 2 }), 'always', 'fresh_creation', digest)).toMatchObject({ reasonCode: 'activation_identity_conflict' })
  })
  it('preserves original bytes and provenance on exact repeated adoption or orphan creation', () => {
    const dir = root(), identity = birth()
    expect(writeActivationBinding(dir, identity, 'opt-in', 'legacy_adoption', digest)).toMatchObject({ status: 'bound', created: true })
    const path = activationBindingPath(dir, identity.id), before = readFileSync(path)
    expect(writeActivationBinding(dir, identity, 'opt-in', 'fresh_creation', '2'.repeat(64))).toMatchObject({ status: 'bound', created: false })
    expect(readFileSync(path)).toEqual(before)
    expect(writeActivationBinding(dir, identity, 'always', 'fresh_creation', digest)).toMatchObject({ reasonCode: 'activation_mode_conflict' })
    expect(readFileSync(path)).toEqual(before)
  })
  it('inherits parent mode, keeps exact cut, and refuses a conflicting explicit profile', () => {
    const dir = root(), parent = birth('parent')
    writeActivationBinding(dir, parent, 'opt-in', 'legacy_adoption', digest)
    const child = sessionBirthIdentity({ version: 4, id: 'child', createdAt: 2, isSeeded: true, parentSession: 'parent' }, 3)
    expect(resolveSessionActivation(dir, child, { activation: 'always', activationSource: 'default' }, 'startup', true)).toMatchObject({ status: 'bound', mode: 'opt-in', binding: { identity: { inheritedEventCount: 3 } } })
    const other = { ...child, id: 'conflict' }
    expect(resolveSessionActivation(dir, other, { activation: 'always', activationSource: 'explicit' }, 'startup', true)).toMatchObject({ reasonCode: 'activation_mode_conflict' })
    expect(resolveSessionActivation(dir, { ...other, parentSession: 'absent' }, { activation: 'always' }, 'startup', true)).toMatchObject({ reasonCode: 'activation_parent_unknown' })
  })
  it('freshly refuses truncated, duplicate-key, digest-damaged, missing and unsafe files', () => {
    const dir = root(), identity = birth(), path = activationBindingPath(dir, identity.id)
    writeActivationBinding(dir, identity, 'always', 'fresh_creation', digest)
    const good = readFileSync(path, 'utf8')
    for (const bad of ['{', good.replace('"initialMode":"always"', '"initialMode":"opt-in"'), good.replace('{', '{"schema":"duplicate",')]) {
      writeFileSync(path, bad); expect(readActivationBinding(dir, identity).status).toBe('unavailable')
    }
    writeFileSync(path, good); chmodSync(path, 0o644)
    if (process.platform !== 'win32') expect(readActivationBinding(dir, identity)).toMatchObject({ reasonCode: 'activation_storage_unsafe' })
    unlinkSync(path); expect(readActivationBinding(dir, identity)).toMatchObject({ reasonCode: 'activation_mode_unknown' })
    symlinkSync(join(dir, 'absent'), path); expect(readActivationBinding(dir, identity)).toMatchObject({ reasonCode: 'activation_storage_unsafe' })
  })
  it('keeps birth mode across cwd/preset changes and verified cross-home transfer; rejects linked ancestry', () => {
    const dir = root(), other = root(), identity = birth()
    writeActivationBinding(dir, identity, 'opt-in', 'legacy_adoption', digest)
    const moved = birth('one', { cwd: '/another/workspace', agentPreset: 'minimal' })
    expect(moved).toEqual(identity)
    writeFileSync(activationBindingPath(other, identity.id), readFileSync(activationBindingPath(dir, identity.id)), { mode: 0o600 })
    expect(readActivationBinding(other, moved)).toMatchObject({ status: 'bound', mode: 'opt-in' })
    const parent = root(), alias = join(parent, 'alias')
    symlinkSync(other, alias, 'junction')
    expect(writeActivationBinding(join(alias, 'nested'), birth('new'), 'always', 'fresh_creation', digest)).toMatchObject({ reasonCode: 'activation_storage_unsafe' })
  })
  it('rejects duplicate escaped keys and malformed identity', () => {
    expect(() => activationJson('{"id":1,"\\u0069d":2}')).toThrow('activation_json_duplicate_key')
    expect(() => birth('one', { createdAt: -1 })).toThrow('activation_identity_unavailable')
  })
})
describe('legacy migration inventory and receipt', () => {
  it('recovers per row, reports partial conflicts, and verifies missing bindings without creating them', () => {
    const dir = root(), entries = [birth('a'), birth('b')].map(identity => ({ identity, mode: 'opt-in' as const, cohort: 'old' }))
    const receipt = createActivationMigrationReceipt(entries, { inventory: digest })
    writeActivationBinding(dir, entries[1].identity, 'always', 'fresh_creation', digest)
    expect(adoptActivationReceipt(dir, receipt)).toMatchObject({ status: 'partial', entries: [{ id: 'a', created: true }, { id: 'b', reasonCode: 'activation_mode_conflict' }] })
    expect(adoptActivationReceipt(dir, receipt)).toMatchObject({ status: 'partial', entries: [{ created: false }, {}] })
    unlinkSync(activationBindingPath(dir, 'a'))
    expect(adoptActivationReceipt(dir, receipt, true).entries[0]).toMatchObject({ reasonCode: 'activation_mode_unknown' })
    expect(adoptActivationReceipt(dir, receipt).entries[0]).toMatchObject({ created: true })
    expect(() => createActivationMigrationReceipt([], { inventory: digest })).toThrow()
  })
  it('requires exact mapping for mixed cohorts; uniform trusted old modes include empty sessions', () => {
    const inventory = [birth('a'), birth('b')], prior = { schema: 'dsh-activation-prior-modes/v1' as const,
      previousPackage: { name: 'dsh-completion-guard' as const, version: '0.8.4', sha256: digest }, sourceSha256: digest,
      cohorts: [{ name: 'web', mode: 'opt-in' as const }, { name: 'desktop', mode: 'always' as const }] }
    expect(prepareActivationMigration(inventory, prior)).toMatchObject({ status: 'pending', missing: ['a', 'b'] })
    expect(prepareActivationMigration(inventory, { ...prior, cohorts: [prior.cohorts[0]] })).toMatchObject({ status: 'ready', receipt: { entries: [{ mode: 'opt-in' }, { mode: 'opt-in' }] } })
    expect(prepareActivationMigration(inventory, { ...prior, cohorts: prior.cohorts.map((c, i) => ({ ...c, sessionIds: [inventory[i].id] })) }).status).toBe('ready')
    expect(() => prepareActivationMigration(inventory, { ...prior, previousPackage: { ...prior.previousPackage, version: '0.9.0' } })).toThrow('activation_prior_modes_invalid')
  })
  it('uses read handles for exact inherited cut, emits no bodies and detects identity/revision changes', async () => {
    const header = { version: 4, id: 'a', createdAt: 1, isSeeded: true, parentSession: 'p' }, revision = Symbol('rev')
    let closed = 0
    const persistence = { list: async () => [{ header, revision }], stat: async () => ({ header, revision }),
      open: async () => ({ header, inheritedEventCount: 4, close: async () => { closed++ } }) }
    expect(await inspectActivationInventory(persistence)).toEqual([sessionBirthIdentity(header, 4)])
    expect(closed).toBe(1)
    expect(activationDigest(await inspectActivationInventory(persistence))).toMatch(/^[a-f0-9]{64}$/)
    await expect(inspectActivationInventory({ ...persistence, stat: async () => ({ header, revision: Symbol() }) })).rejects.toThrow('activation_inventory_changed')
  })
})
