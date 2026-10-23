import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { apply, createRuntime } from '../src/runtime.js'
import { resolveConfig } from '../src/config.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'
import { activationBindingPath, readActivationBinding, writeActivationBinding } from '../src/domain/activation-bindings.js'
import { sessionBirthIdentity } from '../src/domain/session-activation.js'
import { privateStorageToolDenial } from '../src/domain/private-storage-guard.js'
import { __writerLockInternals as lockInternals } from '../src/domain/private-ledger.js'
const directories: string[] = []
function root() { const path = mkdtempSync(join(tmpdir(), 'mode-runtime-')); directories.push(path); return path }
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { force: true, recursive: true }) })
const HOST = { ...evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' }), goalAvailable: false }
function harness(activation?: 'opt-in' | 'always', qualification = true, existing?: Session) {
  const path = root(), agents = new Map(), sessions = new Map(), handlers = new Map<string, Array<(arg: any, next?: any) => any>>()
  const tools = new Map(), guards: Array<(exec: any) => string | undefined> = []
  const ctx = { commands: { register: () => {} }, get: (name: string) => name === 'agents' && qualification ? { get: (id: string) => agents.get(id), list: () => [...agents.values()] } : undefined,
    sessions: { get: (id: string) => sessions.get(id), flush: async () => true },
    on: (name: string, handler: any) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); return () => {} } }
  const makeAgent = (session: Session) => ({ id: session.id, session, steer: () => {}, ctx: { get: () => undefined,
    tools: { get: (name: string) => tools.get(name), register: (tool: any) => { tools.set(tool.name, tool); return () => {} }, guard: (guard: any) => { guards.push(guard); return () => {} } } } })
  if (existing) { const agent = makeAgent(existing); agents.set(agent.id, agent); sessions.set(existing.id, existing) }
  apply(ctx as never, { activation }, { hostLock: HOST, activationBindingsRoot: path, privateLedgerRoot: join(path, 'ledger') })
  async function attach(session: Session, source: 'startup' | 'resume' | 'compact' | 'clear') {
    const agent = makeAgent(session)
    agents.set(agent.id, agent); sessions.set(session.id, session)
    for (const handler of handlers.get('agent/created') ?? []) await handler({ agent, source })
    return agent
  }
  return { path, attach, tools, guards, handlers }
}
const claim = () => createUserMessage({ content: [{ type: 'text', text: 'Explain the implementation.' }], source: { kind: 'user' } })
describe('production apply initial mode resolution', () => {
  it('late-attaches a public live empty session without inventing a startup mode', () => {
    const session = Session.create(SessionId('late-existing')), h = harness(undefined, true, session)
    expect(h.guards[0]({ name: 'update_goal', arguments: { action: 'complete' } })).toContain('activation_mode_unknown')
    expect(readActivationBinding(h.path, sessionBirthIdentity(session.header, session.inheritedEventCount))).toMatchObject({ reasonCode: 'activation_mode_unknown' })
    expect(session.seq).toBe(0)
  })
  it('qualifies public startup, binds the actual default, keeps T0 empty and delivers first-step protection', async () => {
    const h = harness(), session = Session.create(SessionId('default-public-birth')), agent = await h.attach(session, 'startup')
    const identity = sessionBirthIdentity(session.header, session.inheritedEventCount)
    expect(readActivationBinding(h.path, identity)).toMatchObject({ status: 'bound', mode: 'always', binding: { source: 'fresh_creation' } })
    expect(session.seq).toBe(0)
    const message = claim(), preStep = h.handlers.get('agent/pre-step')![0]
    const entered = await preStep({ agent, messages: [message] }, async () => ({ kind: 'enter', messages: [message] }))
    expect(entered.messages).toHaveLength(3)
    expect(entered.messages[0].content[0].text).toContain('protocol boundary: v6')
  })
  it('resumes an adopted old empty opt-in session under the new default without selecting always', async () => {
    const h = harness(), session = Session.create(SessionId('legacy-empty'))
    const identity = sessionBirthIdentity(session.header, session.inheritedEventCount)
    writeActivationBinding(h.path, identity, 'opt-in', 'legacy_adoption', '1'.repeat(64))
    const path = activationBindingPath(h.path, identity.id), before = readFileSync(path), agent = await h.attach(session, 'resume')
    const message = claim()
    const entered = await h.handlers.get('agent/pre-step')![0]({ agent, messages: [message] }, async () => ({ kind: 'enter', messages: [message] }))
    expect(entered.messages).toEqual([message]); expect(session.seq).toBe(0); expect(readFileSync(path)).toEqual(before)
  })
  it.each(['resume', 'compact', 'clear'] as const)('does not create an unknown binding at %s or run correction loops', async source => {
    const h = harness(), session = Session.create(SessionId(`unknown-${source}`)), agent = await h.attach(session, source)
    expect(readActivationBinding(h.path, sessionBirthIdentity(session.header, session.inheritedEventCount))).toMatchObject({ reasonCode: 'activation_mode_unknown' })
    for (let i = 0; i < 3; i++) {
      const entered = await h.handlers.get('agent/pre-step')![0]({ agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
      expect(entered.messages).toEqual([])
      expect(h.guards[0]({ name: 'update_goal', arguments: { action: 'complete' } })).toContain('activation_mode_unknown')
    }
    expect(session.seq).toBe(0)
  })
  it('rejects unqualified startup and contradictory explicit profile while ordinary tools remain available', async () => {
    const h = harness(undefined, false), session = Session.create(SessionId('unqualified')), agent = await h.attach(session, 'startup')
    expect(h.guards[0]({ name: 'update_goal', arguments: { action: 'complete' } })).toContain('activation_source_unavailable')
    expect(h.guards[0]({ name: 'read', arguments: { file_path: '/work/app.ts' } })).toBeUndefined()
    const explicit = harness('always'), old = Session.create(SessionId('explicit-conflict'))
    writeActivationBinding(explicit.path, sessionBirthIdentity(old.header, old.inheritedEventCount), 'opt-in', 'legacy_adoption', '1'.repeat(64))
    await explicit.attach(old, 'resume')
    expect(explicit.guards[0]({ name: 'update_goal', arguments: { action: 'complete' } })).toContain('activation_mode_conflict')
    expect(agent.session.seq).toBe(0)
  })
})
describe('fresh mode read invalidates the projection cache', () => {
  it('detects deleted/replaced bindings on unchanged event snapshots, and denies certification', () => {
    const path = root(), session = Session.create(SessionId('fresh-mode-read'))
    const identity = sessionBirthIdentity(session.header, session.inheritedEventCount), file = activationBindingPath(path, identity.id)
    writeActivationBinding(path, identity, 'always', 'fresh_creation', '1'.repeat(64))
    const runtime = createRuntime({ session } as never, resolveConfig({}), HOST, undefined, undefined, undefined, undefined,
      () => readActivationBinding(path, sessionBirthIdentity(session.header, session.inheritedEventCount)))
    expect(runtime.projection.enabled).toBe(true)
    const before = readFileSync(file, 'utf8')
    unlinkSync(file); runtime.sync()
    expect(runtime.projection.integrityViolations).toContain('activation_mode_unknown')
    expect(runtime.projection.enabled).toBe(false)
    writeFileSync(file, before + '\n', { mode: 0o600 }); runtime.sync()
    expect(runtime.projection.integrityViolations).toContain('activation_binding_changed')
    expect(runtime.projection.integrity).toBe('unknown')
  })
  it('protects resolved private file targets and named shell access, without gating unrelated files', () => {
    const path = root(), cwd = root()
    expect(privateStorageToolDenial('edit', { file_path: join(path, 'one.json') }, cwd, [path])).toContain('activation_private_storage_protected')
    expect(privateStorageToolDenial('bash', { command: 'rm -rf ~/.dsh/completion-guard/activation-bindings-v1' }, cwd, [path])).toContain('activation_private_storage_protected')
    expect(privateStorageToolDenial('write', { file_path: 'app.ts' }, cwd, [path])).toBeUndefined()
  })
  it('protects the official workdir parameter and fails closed without a trusted cwd (F02)', async () => {
    const work = root(), priv = join(work, 'private')
    mkdirSync(priv)
    symlinkSync(priv, join(work, 'alias'))
    // The official rc.2 Bash/Pwsh parameter is `workdir`; absolute, relative,
    // and symlink-aliased spellings must all resolve to the protected root.
    expect(privateStorageToolDenial('bash', { command: 'cat one.json', workdir: join(work, 'private') }, work, [priv])).toContain('activation_private_storage_protected')
    expect(privateStorageToolDenial('pwsh', { command: 'Get-Content one.json', workdir: 'private' }, work, [priv])).toContain('activation_private_storage_protected')
    expect(privateStorageToolDenial('bash', { command: 'cat one.json', workdir: 'alias' }, work, [priv])).toContain('activation_private_storage_protected')
    expect(privateStorageToolDenial('bash', { command: 'cat one.json', workdir: join(work, 'elsewhere') }, work, [priv])).toBeUndefined()
    // A relative target without a trusted base cannot be proven either way.
    expect(privateStorageToolDenial('bash', { command: 'cat one.json', workdir: 'private' }, undefined, [priv])).toContain('activation_private_storage_protected')
    expect(privateStorageToolDenial('write', { file_path: 'one.json' }, undefined, [priv])).toContain('activation_private_storage_protected')
    // Omitting workdir runs in the host's current directory; that directory
    // itself landing inside private storage stays denied.
    expect(privateStorageToolDenial('bash', { command: 'ls' }, priv, [priv])).toContain('activation_private_storage_protected')
    expect(privateStorageToolDenial('bash', { command: 'ls' }, work, [priv])).toBeUndefined()
    expect(privateStorageToolDenial('write', { file_path: join(work, 'one.json') }, undefined, [priv])).toBeUndefined()
    // The same matrix through the REGISTERED production guard, not the helper.
    const h = harness(), session = Session.create(SessionId('guard-workdir'))
    await h.attach(session, 'startup')
    const registered = h.guards[0]!
    expect(registered({ name: 'bash', arguments: { command: 'cat one.json', workdir: join(h.path, 'activation-bindings-v1') } })).toContain('activation_private_storage_protected')
    expect(registered({ name: 'pwsh', arguments: { command: 'Get-Content one.json', workdir: h.path } })).toContain('activation_private_storage_protected')
    expect(registered({ name: 'bash', arguments: { command: 'ls', workdir: work } })).toBeUndefined()
    expect(registered({ name: 'read', arguments: { file_path: join(work, 'app.ts') } })).toBeUndefined()
  })
})

describe('F05: a qualified first creation survives a brief writer-lock race', () => {
  it('retries the same creation after the lock is released and binds exactly once', async () => {
    const h = harness(), session = Session.create(SessionId('f05-recovery'))
    const held = lockInternals.acquire(h.path)
    expect(held).toBeDefined()
    const agent = await h.attach(session, 'startup')
    const identity = sessionBirthIdentity(session.header, session.inheritedEventCount)
    // The creation lost the race and nothing was written.
    expect(h.guards[0]({ name: 'update_goal', arguments: { action: 'complete' } })).toContain('activation_writer_unavailable')
    expect(readActivationBinding(h.path, identity)).toMatchObject({ reasonCode: 'activation_mode_unknown' })
    // The lock frees; the next sync retries the SAME qualified creation.
    lockInternals.release(h.path, held)
    const message = claim()
    const entered = await h.handlers.get('agent/pre-step')![0]({ agent, messages: [message] }, async () => ({ kind: 'enter', messages: [message] }))
    expect(entered.messages[0].content[0].text).toContain('protocol boundary: v6')
    expect(readActivationBinding(h.path, identity)).toMatchObject({ status: 'bound', mode: 'always' })
    // Exactly one binding file: the retry is idempotent, never a second record.
    expect(readdirSync(h.path).filter((name) => name.endsWith('.json') && !name.startsWith('pending.'))).toHaveLength(1)
    expect(h.guards[0]({ name: 'update_goal', arguments: { action: 'complete' } })).not.toContain('activation_writer_unavailable')
  })

  it('stops retrying after the bounded budget and keeps the clear writer status', async () => {
    const h = harness(), session = Session.create(SessionId('f05-budget'))
    const held = lockInternals.acquire(h.path)
    const agent = await h.attach(session, 'startup')
    expect(h.guards[0]({ name: 'update_goal', arguments: { action: 'complete' } })).toContain('activation_writer_unavailable')
    for (let index = 0; index < 10; index += 1) {
      await h.handlers.get('agent/pre-step')![0]({ agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
    }
    // Budget exhausted: releasing the lock afterwards does not resurrect the
    // creation — the session keeps its explicit bounded status.
    lockInternals.release(h.path, held)
    await h.handlers.get('agent/pre-step')![0]({ agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
    expect(h.guards[0]({ name: 'update_goal', arguments: { action: 'complete' } })).toContain('activation_writer_unavailable')
    expect(readActivationBinding(h.path, sessionBirthIdentity(session.header, session.inheritedEventCount))).toMatchObject({ reasonCode: 'activation_mode_unknown' })
  })

  it('never recreates a binding that was created and then deleted', async () => {
    const h = harness(), session = Session.create(SessionId('f05-deleted'))
    const agent = await h.attach(session, 'startup')
    const identity = sessionBirthIdentity(session.header, session.inheritedEventCount)
    expect(readActivationBinding(h.path, identity).status).toBe('bound')
    unlinkSync(activationBindingPath(h.path, identity.id))
    const message = claim()
    await h.handlers.get('agent/pre-step')![0]({ agent, messages: [message] }, async () => ({ kind: 'enter', messages: [message] }))
    expect(h.guards[0]({ name: 'update_goal', arguments: { action: 'complete' } })).toContain('activation_mode_unknown')
    expect(readActivationBinding(h.path, identity)).toMatchObject({ reasonCode: 'activation_mode_unknown' })
  })
})
