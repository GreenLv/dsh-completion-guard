import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply } from '../src/runtime.js'
import { EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'

/**
 * Registered tool surface.
 *
 * `agent/session-start` is where Guard installs everything the model can call
 * and the one monotonic guard that blocks `update_goal(action=complete)`
 * without a certificate. Nothing asserted that surface before this file: the
 * existing harnesses stub `tools.guard` to a no-op and only ever *use* the
 * checkpoint tool they happen to look up by name. A refactor that dropped a
 * registration, or that stopped installing the completion gate entirely, would
 * have left every local test green while removing the product's central
 * protection. The host-lock capability row
 * `goal_complete_precommit_guard: required` declares the contract; these cases
 * check that the contract is actually wired up.
 */

interface RegisteredTool {
  name: string
  description?: unknown
  parameters?: unknown
  output?: unknown
  execute?: unknown
}

function startGuardSession(options: { activation?: 'opt-in' | 'always'; config?: Record<string, unknown> } = {}) {
  const session = Session.create(SessionId('tool-surface'), undefined, {
    version: 3, isSeeded: false, id: SessionId('tool-surface'), createdAt: 1, cwd: '/work',
  })
  const tools: RegisteredTool[] = []
  const guards: Array<(exec: { name: string; arguments: unknown }) => string | undefined> = []
  const handlers = new Map<string, unknown[]>()
  const ctx = {
    commands: { register: () => () => {} },
    on: (name: string, handler: unknown) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler])
      return () => {}
    },
    get: () => undefined,
    sessions: { flush: async () => true },
  }
  apply(ctx as never, { activation: options.activation ?? 'always', ...options.config } as never)
  const agent = {
    session,
    steer: () => {},
    ctx: {
      tools: {
        register: (tool: RegisteredTool) => { tools.push(tool); return () => {} },
        guard: (guard: (exec: { name: string; arguments: unknown }) => string | undefined) => { guards.push(guard); return () => {} },
        get: () => undefined,
      },
      get: () => undefined,
    },
  }
  const start = (source: string) => {
    for (const handler of handlers.get('agent/session-start') ?? []) {
      (handler as (payload: unknown) => void)({ agent, source })
    }
  }
  start('startup')
  return { session, agent: agent as unknown as Agent, tools, guards, start }
}

const EXPECTED_TOOLS = [
  'context_guard_rebind',
  'context_guard_checkpoint',
  'context_guard_boundary',
  'context_guard_evidence',
  'context_guard_action',
  'context_guard_prepare',
  'context_guard_external_operation',
]

describe('registered tool surface', () => {
  it('registers exactly the Guard tool set in a stable order', () => {
    const { tools } = startGuardSession()
    expect(tools.map((tool) => tool.name)).toEqual(EXPECTED_TOOLS)
  })

  it('registers every tool with the definition fields the host requires', () => {
    // Since the pinned host validates a canonical output value, a definition
    // without `output` is rejected at registration time in a real host. Assert
    // the shape here so a build-time type slip cannot reach a native run.
    const { tools } = startGuardSession()
    for (const tool of tools) {
      expect(typeof tool.execute, `${tool.name}.execute`).toBe('function')
      expect(typeof tool.description, `${tool.name}.description`).toBe('string')
      expect(tool.parameters, `${tool.name}.parameters`).toMatchObject({ type: 'object' })
      const output = tool.output as { schema?: unknown; render?: unknown } | undefined
      expect(output, `${tool.name}.output`).toBeDefined()
      expect(output!.schema, `${tool.name}.output.schema`).toBeDefined()
      expect(typeof output!.render, `${tool.name}.output.render`).toBe('function')
    }
  })

  it('does not re-register tools when the session starts again', () => {
    const { tools, guards, start } = startGuardSession()
    const toolCount = tools.length
    const guardCount = guards.length
    start('resume')
    start('compact')
    expect(tools).toHaveLength(toolCount)
    expect(guards).toHaveLength(guardCount)
  })

  it('installs exactly one monotonic guard and it gates goal completion', () => {
    const { guards } = startGuardSession()
    expect(guards).toHaveLength(1)
    const guard = guards[0]
    // A completion request is denied (a non-empty reason, whatever the host
    // status) ...
    const denial = guard({ name: 'update_goal', arguments: { action: 'complete', goal_id: 'g1', revision: 1 } })
    expect(typeof denial).toBe('string')
    expect(denial).toMatch(/^Context Guard denial \[/)
    // ... while unrelated tools and unrelated actions pass through untouched.
    expect(guard({ name: 'update_goal', arguments: { action: 'blocked' } })).toBeUndefined()
    expect(guard({ name: 'update_goal', arguments: { action: 'pause' } })).toBeUndefined()
    expect(guard({ name: 'read', arguments: { action: 'complete' } })).toBeUndefined()
    expect(guard({ name: 'update_goal', arguments: undefined })).toBeUndefined()
  })

  it('keeps the completion gate installed when the host lock is unsupported', () => {
    // The gate must fail closed, not disappear, when Guard cannot verify the
    // host: an unavailable lock is exactly when a bypass would be most useful.
    // All three host-lock config keys are injected together because a partial
    // injection is rejected at configuration time.
    const { guards } = startGuardSession({
      config: {
        hostLockPackages: EXPECTED_HOST_PACKAGES.slice(0, 3),
        hostLockPlatform: 'posix',
        hostLockProfile: 'web',
      },
    })
    expect(guards).toHaveLength(1)
    const denial = guards[0]({ name: 'update_goal', arguments: { action: 'complete', goal_id: 'g1', revision: 1 } })
    expect(denial).toMatch(/^Context Guard denial \[(stale_host|no_goal|certificate_missing)\]/)
  })

  it('allows goal completion while the Guard is switched off in that session', () => {
    // The gate is a completion gate, not a blanket tool block: with protection
    // off the completion path is deliberately unrestricted. This pins the
    // enablement dependency so a future change cannot make the gate always-on
    // (or silently drop it) without a failing test.
    const { guards } = startGuardSession({ activation: 'opt-in' })
    expect(guards).toHaveLength(1)
    expect(guards[0]({ name: 'update_goal', arguments: { action: 'complete', goal_id: 'g1', revision: 1 } })).toBeUndefined()
  })

  it('refuses a mutating tool call that arrives without a caller agent', async () => {
    // `exec.agent` is the only identity a Guard tool has. A call with none must
    // be refused before any durability step, target resolution, or
    // authorization: there is no session to bind the claim to.
    const { tools } = startGuardSession()
    const action = tools.find((tool) => tool.name === 'context_guard_action')!
    const result = await (action.execute as (args: unknown, exec: unknown) => Promise<Record<string, unknown>>)(
      {
        semantic_action: 'commit',
        contract_item_id: 'R001',
        contract_item_revision: 1,
        resolution_call_id: 'call-1',
        target_digest: '0'.repeat(64),
      },
      { agent: undefined },
    )
    expect(result.status).toBe('unavailable')
    expect(result.reason_code).toBe('action_adapter_unavailable')
  })

  it('refuses a mutating tool call carrying a foreign agent', async () => {
    // The registered action tool binds to the exact session that registered
    // it: `prepareMutation` in runtime.ts returns false when
    // `toolAgent.session !== agent.session`, and target resolution reads the
    // CALLING agent's log. Under a host lock Guard cannot verify, the
    // capability gate refuses first — which is also fail-closed — so this case
    // pins the observable outcome rather than the inner branch.
    const { tools } = startGuardSession()
    const action = tools.find((tool) => tool.name === 'context_guard_action')!
    const foreign = Session.create(SessionId('foreign-session'), undefined, {
      version: 3, isSeeded: false, id: SessionId('foreign-session'), createdAt: 2, cwd: '/elsewhere',
    })
    const result = await (action.execute as (args: unknown, exec: unknown) => Promise<Record<string, unknown>>)(
      {
        semantic_action: 'commit',
        contract_item_id: 'R001',
        contract_item_revision: 1,
        resolution_call_id: 'call-1',
        target_digest: '0'.repeat(64),
      },
      { agent: { session: foreign }, signal: new AbortController().signal },
    )
    expect(result.status).toBe('unavailable')
    expect(typeof result.reason_code).toBe('string')
    expect(result.reason_code).not.toBe('')
  })
})
