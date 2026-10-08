import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
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
})
