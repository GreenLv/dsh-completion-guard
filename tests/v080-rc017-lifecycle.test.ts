import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { LocalJobRegistry } from '@deepseek-ai/dsh-jobs-local'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { apply, inject, readExternalOperation } from '../src/runtime.js'

function host() {
  const ctx = new Context()
  const agents = new AgentRegistry(ctx)
  new SessionStore(ctx)
  new LocalFileSystem(ctx, { cwd: process.cwd(), diffBasisMaxBytes: 10485760 })
  new SystemPrompt(ctx, {} as never)
  const tools = new ToolRuntime(ctx, {})
  new CommandRuntime(ctx)
  const session = Session.create(SessionId('rc2-owner'))
  const rawAgent = { id: session.id, session, ctx, status: 'idle', steer: () => {} }
  const scope = createScope(ctx, rawAgent)
  rawAgent.ctx = scope.ctx
  const agent = rawAgent as unknown as Agent
  return { ctx, agents, tools, agent, session }
}
const plugin = { inject, apply: (ctx: Context) => apply(ctx, { activation: 'always' }) }

describe('rc.2 real registry initialization and plugin ownership', () => {
  it('awaits created, keeps T0 blank, and removes tools on disable/re-enable and agent disposal', async () => {
    const h = host()
    const first = await h.ctx.plugin(plugin)
    const detach = await h.agents.register(h.agent)
    expect(h.session.seq).toBe(0)
    expect(h.tools.get('context_guard_checkpoint', h.agent)).toBeDefined()
    expect(h.tools.get('context_guard_checkpoint')).toBeUndefined()
    await first.dispose()
    expect(h.tools.get('context_guard_checkpoint', h.agent)).toBeUndefined()
    const second = await h.ctx.plugin(plugin)
    expect(h.tools.get('context_guard_checkpoint', h.agent)).toBeDefined()
    expect(h.session.seq).toBe(0)
    await detach()
    expect(h.tools.get('context_guard_checkpoint', h.agent)).toBeUndefined()
    await second.dispose()
    await h.ctx.fiber.dispose()
  })

  it('rolls back Guard registrations if a later serial initializer rejects', async () => {
    const h = host()
    const guard = await h.ctx.plugin(plugin)
    h.ctx.on('agent/created', async () => { throw new Error('initialization cancelled') })
    await expect(Promise.resolve(h.agents.register(h.agent))).rejects.toThrow('initialization cancelled')
    expect(h.agents.get(h.agent.id)).toBeUndefined()
    expect(h.tools.get('context_guard_checkpoint', h.agent)).toBeUndefined()
    expect(h.session.seq).toBe(0)
    await guard.dispose()
    await h.ctx.fiber.dispose()
  })

  it('refuses an already-cancelled creation signal before registering anything', async () => {
    const h=host()
    const guard=await h.ctx.plugin(plugin)
    const detach=h.agents.enter(h.agent, undefined)
    const cancellation=new AbortController()
    cancellation.abort(new Error('creation cancelled'))
    await expect(h.agents.announce(h.agent,'startup',cancellation.signal)).rejects.toThrow('creation cancelled')
    expect(h.tools.get('context_guard_checkpoint',h.agent)).toBeUndefined()
    expect(h.session.seq).toBe(0)
    detach()
    await guard.dispose()
    await h.ctx.fiber.dispose()
  })

  it('uses the same SessionId at the real JobsLocal owner fence', async () => {
    const h = host()
    const detach = await h.agents.register(h.agent)
    const jobs = new LocalJobRegistry(h.ctx, {})
    const controller = jobs.attachController('rc2-test')
    let settle!: (value: { status: 'completed' }) => void
    const done = new Promise<{ status: 'completed' }>((resolve) => { settle = resolve })
    const id = jobs.start({ kind: 'bash', owner: h.agent.id, label: 'bounded job', run: () => ({ cancel: () => {}, done }) })
    expect(readExternalOperation(h.ctx, h.agent, id)?.status).toBe('running')
    const otherSession = Session.create(SessionId('foreign'))
    const other = { ...h.agent, id: otherSession.id, session: otherSession } as Agent
    expect(readExternalOperation(h.ctx, other, id)).toBeUndefined()
    expect(readExternalOperation(h.ctx, h.agent, 'missing-1')).toBeUndefined()
    expect(readExternalOperation(h.ctx, { ...h.agent, id: otherSession.id } as Agent, id)).toBeUndefined()
    settle({ status: 'completed' })
    await done
    await Promise.resolve()
    expect(readExternalOperation(h.ctx, h.agent, id)?.status).toBe('completed')
    jobs.remove(id, h.agent.id)
    expect(readExternalOperation(h.ctx, h.agent, id)).toBeUndefined()
    controller()
    await detach()
    await h.ctx.fiber.dispose()
  })
})
