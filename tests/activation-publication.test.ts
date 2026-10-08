import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const state = vi.hoisted(() => ({ failure: '' as string, reads: 0, final: '', temporaryFailures: false, temporaryFlushes: 0, successfulTemporaryFlushes: 0, paths: new Map<number, string>() }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs,
    openSync: ((path: string, flags: number, mode?: number) => {
      if (state.failure === 'open' && path.endsWith('.json') && (flags & fs.constants.O_RDWR) === fs.constants.O_RDWR) throw new Error('injected open')
      const fd = fs.openSync(path, flags, mode); state.paths.set(fd, String(path)); return fd
    }),
    fsyncSync: ((fd: number) => {
      const path = state.paths.get(fd) ?? ''
      if (path.endsWith('.json.pending')) {
        state.temporaryFlushes++
        if (state.temporaryFailures) throw new Error('injected temporary flush')
        state.successfulTemporaryFlushes++
      }
      if (state.failure === 'flush' && path.endsWith('.json')) throw new Error('injected flush')
      if (state.failure === 'publication' && state.final && fs.existsSync(state.final)
        && (fs.fstatSync(fd).isDirectory() || path === state.final)) throw new Error('injected directory')
      return fs.fsyncSync(fd)
    }),
    readFileSync: ((path: any, ...args: any[]) => {
      if (state.failure === 'readback' && typeof path === 'number' && state.paths.get(path)?.endsWith('.json') && ++state.reads === 2) throw new Error('injected readback')
      return (fs.readFileSync as any)(path, ...args)
    }),
  }
})
import { mkdtempSync, readFileSync, rmSync, existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { __activationBindingInternals, activationBindingPath, adoptActivationReceipt, createActivationMigrationReceipt, readActivationBinding, resolveSessionActivation, writeActivationBinding } from '../src/domain/activation-bindings.js'
import { sessionBirthIdentity } from '../src/domain/session-activation.js'
import { createRuntime } from '../src/runtime.js'
import { resolveConfig } from '../src/config.js'
const directories: string[] = []
function root() { const path = mkdtempSync(join(tmpdir(), 'mode-publication-')); directories.push(path); return path }
const identity = sessionBirthIdentity({ version: 4, id: 'publish', createdAt: 1, isSeeded: false }, 0)
afterEach(() => { state.failure = ''; state.reads = 0; state.final = ''; state.temporaryFailures = false; state.temporaryFlushes = 0; state.successfulTemporaryFlushes = 0; state.paths.clear(); for (const path of directories.splice(0)) rmSync(path, { force: true, recursive: true }) })
describe('publication failure and controlled same-value recovery', () => {
  it('holds a post-link failure unavailable to independent readers and runtime initialization until controlled recovery', () => {
    const path = root(), file = activationBindingPath(path, identity.id)
    state.final = file
    state.failure = 'publication'
    expect(writeActivationBinding(path, identity, 'always', 'fresh_creation', '1'.repeat(64))).toMatchObject({ status: 'unavailable', reasonCode: process.platform === 'win32' ? 'activation_publication_flush_failed' : 'activation_directory_durability_unavailable' })
    expect(existsSync(file)).toBe(true); expect(existsSync(`${file}.pending`)).toBe(true)
    const before = readFileSync(file)
    state.failure = ''
    expect(readActivationBinding(path, identity)).toMatchObject({ reasonCode: 'activation_publication_incomplete' })
    const child = { ...identity, id: 'post-link-child', createdAt: 2, isSeeded: true, parentSession: identity.id }
    expect(resolveSessionActivation(path, child, { activation: 'opt-in', activationSource: 'default' }, 'startup', true))
      .toMatchObject({ status: 'unavailable', reasonCode: 'activation_publication_incomplete' })
    expect(existsSync(activationBindingPath(path, child.id))).toBe(false)
    const receipt = createActivationMigrationReceipt([{ identity, mode: 'always', cohort: 'verified-fixture' }], { source: '2'.repeat(64) })
    expect(adoptActivationReceipt(path, receipt, true)).toMatchObject({ status: 'partial', entries: [{ reasonCode: 'activation_publication_incomplete' }] })
    const session = { header: { version: 4, ...identity }, inheritedEventCount: 0, snapshotEvents: () => Object.freeze([]) }
    const runtime = createRuntime({ session } as never, resolveConfig({}), undefined, undefined, undefined, undefined, undefined,
      () => readActivationBinding(path, identity))
    runtime.sync(); expect(runtime.projection.enabled).toBe(false)
    expect(runtime.projection.integrityViolations).toContain('activation_publication_incomplete')
    expect(writeActivationBinding(path, identity, 'opt-in', 'legacy_adoption', '2'.repeat(64))).toMatchObject({ reasonCode: 'activation_mode_conflict' })
    expect(writeActivationBinding(path, identity, 'always', 'legacy_adoption', '2'.repeat(64))).toMatchObject({ status: 'bound', created: false })
    expect(readFileSync(file)).toEqual(before); expect(existsSync(`${file}.pending`)).toBe(false)
    expect(readActivationBinding(path, identity)).toMatchObject({ binding: { source: 'fresh_creation', provenanceSha256: '1'.repeat(64) } })
    runtime.sync(); expect(runtime.projection.enabled).toBe(true)
    expect(adoptActivationReceipt(path, receipt, true).status).toBe('complete')
    expect(resolveSessionActivation(path, child, { activation: 'opt-in', activationSource: 'default' }, 'startup', true)).toMatchObject({ status: 'bound', mode: 'always' })
    expect(resolveSessionActivation(path, { ...child, id: 'explicit-child' }, { activation: 'opt-in', activationSource: 'explicit' }, 'startup', true)).toMatchObject({ reasonCode: 'activation_mode_conflict' })
  })
  it('re-flushes a retained temporary after initial/re-entry failure before any consumer can bind it', () => {
    const path = root(), file = activationBindingPath(path, identity.id), temporary = `${file}.pending`
    const receipt = createActivationMigrationReceipt([{ identity, mode: 'always', cohort: 'verified-old-source' }], { source: '2'.repeat(64) })
    state.temporaryFailures = true
    expect(writeActivationBinding(path, identity, 'always', 'fresh_creation', '1'.repeat(64)))
      .toMatchObject({ status: 'unavailable', reasonCode: 'activation_temporary_flush_failed' })
    const before = readFileSync(temporary)
    expect(existsSync(file)).toBe(false)
    expect(state.temporaryFlushes).toBe(1); expect(state.successfulTemporaryFlushes).toBe(0)
    expect(readActivationBinding(path, identity)).toMatchObject({ reasonCode: 'activation_publication_incomplete' })
    expect(adoptActivationReceipt(path, receipt, true).status).toBe('partial')
    const child = { ...identity, id: 'temp-child', createdAt: 2, isSeeded: true, parentSession: identity.id }
    expect(resolveSessionActivation(path, child, { activation: 'always' }, 'startup', true)).toMatchObject({ reasonCode: 'activation_publication_incomplete' })
    expect(existsSync(activationBindingPath(path, child.id))).toBe(false)
    expect(writeActivationBinding(path, identity, 'opt-in', 'legacy_adoption', '2'.repeat(64))).toMatchObject({ reasonCode: 'activation_mode_conflict' })
    expect(state.temporaryFlushes).toBe(1)
    expect(adoptActivationReceipt(path, receipt)).toMatchObject({ status: 'partial', entries: [{ reasonCode: 'activation_temporary_flush_failed' }] })
    expect(state.temporaryFlushes).toBe(2); expect(state.successfulTemporaryFlushes).toBe(0)
    expect(existsSync(file)).toBe(false); expect(readFileSync(temporary)).toEqual(before)
    state.temporaryFailures = false
    expect(adoptActivationReceipt(path, receipt)).toMatchObject({ status: 'complete', entries: [{ created: false }] })
    expect(state.successfulTemporaryFlushes).toBe(1)
    expect(readFileSync(file)).toEqual(before)
    expect(readActivationBinding(path, identity)).toMatchObject({ status: 'bound', binding: { source: 'fresh_creation', provenanceSha256: '1'.repeat(64) } })
    expect(adoptActivationReceipt(path, receipt, true).status).toBe('complete')
    expect(resolveSessionActivation(path, child, { activation: 'opt-in', activationSource: 'default' }, 'startup', true)).toMatchObject({ status: 'bound', mode: 'always' })
  })
  it('refuses a malformed pending next to a valid final for parent, session, migration verify and recovery', () => {
    const path = root(), file = activationBindingPath(path, identity.id), temporary = `${file}.pending`
    state.final = file; state.failure = 'publication'
    expect(writeActivationBinding(path, identity, 'always', 'fresh_creation', '1'.repeat(64)).status).toBe('unavailable')
    state.failure = ''
    const before = readFileSync(file)
    unlinkSync(temporary); writeFileSync(temporary, '{', { mode: 0o600 })
    expect(readFileSync(file)).toEqual(before)
    expect(readActivationBinding(path, identity)).toMatchObject({ reasonCode: 'activation_publication_incomplete' })
    const child = { ...identity, id: 'bad-pending-child', createdAt: 2, isSeeded: true, parentSession: identity.id }
    expect(resolveSessionActivation(path, child, { activation: 'always' }, 'startup', true)).toMatchObject({ reasonCode: 'activation_publication_incomplete' })
    expect(existsSync(activationBindingPath(path, child.id))).toBe(false)
    const receipt = createActivationMigrationReceipt([{ identity, mode: 'always', cohort: 'source' }], { source: '2'.repeat(64) })
    expect(adoptActivationReceipt(path, receipt, true).status).toBe('partial')
    expect(adoptActivationReceipt(path, receipt).status).toBe('partial')
    expect(readFileSync(file)).toEqual(before); expect(readFileSync(temporary, 'utf8')).toBe('{')
  })
  it.each(['open', 'flush', 'readback'])('refuses the Windows published-file branch on %s failure without altering bytes', failure => {
    const path = root(), file = activationBindingPath(path, identity.id)
    const record = writeActivationBinding(path, identity, 'always', 'fresh_creation', '1'.repeat(64))
    expect(record.status).toBe('bound')
    if (record.status !== 'bound') return
    const before = readFileSync(file)
    state.failure = failure
    expect(() => __activationBindingInternals.publicationBarrier(path, file, record.binding, 'win32')).toThrow(/activation_publication_/)
    state.failure = ''
    expect(__activationBindingInternals.publicationBarrier(path, file, record.binding, 'win32')).toMatch(/^[a-f0-9]{64}$/)
    expect(readFileSync(file)).toEqual(before)
  })
})
