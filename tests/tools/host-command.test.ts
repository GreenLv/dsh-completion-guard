import { it, expect, describe } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createContextGuardCommand } from '../../src/commands/context-guard.js'
import { createProjection, type GuardProjection } from '../../src/domain/types.js'
import { deriveProjection } from '../../src/domain/derive.js'

/**
 * The slash command through the REAL host command registry.
 *
 * Guard's enablement has exactly one durable source: the `command/run` event the
 * host logs when a human submits `/context-guard on|off|clear`. Nothing had ever
 * driven that path — tests built the definition and called its handler directly —
 * so the plugin's central mechanism was verified only against a hand-written
 * event, never against the event the host actually writes.
 *
 * Running it for real surfaced one contract detail worth pinning: the host's
 * `args` is the verbatim text after the command name INCLUDING the separator
 * whitespace, so `/context-guard on` logs `args: " on"`. Guard trims before
 * splitting, so it works; a future change to either side that drops the trim,
 * or that assumes no leading space, now fails here.
 */

function harness() {
  const ctx = new Context()
  const commands = new CommandRuntime(ctx)
  const session = Session.create(SessionId('host-command'), undefined, {
    version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId('host-command'), createdAt: 1, cwd: '/work',
  })
  const projection: GuardProjection = createProjection()
  const agent = { session }
  commands.register(createContextGuardCommand(() => projection, () => {}, () => {}))
  const run = (line: string) => commands.execute(agent as never, line, [], new AbortController().signal)
  const derive = () => deriveProjection(
    session.snapshotEvents() as never, { activation: 'opt-in' }, { cwd: '/work' }, true,
  ).projection
  const userText = (text: string) => session.append(
    'user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' },
  )
  return { commands, session, agent, projection, run, derive, userText }
}

describe('slash command through the real DSH command registry', () => {
  it('accepts the definition and returns a well-formed CommandResult', async () => {
    const { commands, agent } = harness()
    expect(commands.find(agent as never, 'context-guard')).toBeDefined()
    expect(commands.list(agent as never).map((descriptor) => descriptor.name)).toContain('context-guard')
    for (const line of ['/context-guard status', '/context-guard diagnose', '/context-guard on', '/context-guard off']) {
      const settled = await harness().run(line)
      expect(settled?.result.kind, line).toBe('success')
      expect(typeof settled?.result.text, line).toBe('string')
    }
    const unknown = await harness().run('/context-guard nonsense')
    expect(unknown?.result).toMatchObject({ kind: 'error' })
  })

  it('does not resolve an unknown command line at all', async () => {
    const { run } = harness()
    expect(await run('/not-a-guard-command on')).toBeUndefined()
  })

  it('logs the paired lifecycle events Guard derives from', async () => {
    const { session, run } = harness()
    const settled = await run('/context-guard on')
    const events = session.snapshotEvents() as unknown as Array<{ type: string; data: Record<string, unknown> }>
    const lifecycle = events.filter((event) => event.type === 'command/run' || event.type === 'command/done')
    expect(lifecycle.map((event) => event.type)).toEqual(['command/run', 'command/done'])
    const [started, done] = lifecycle
    // The exact fields Guard reads. `args` carries the separator whitespace.
    expect(started.data).toMatchObject({ name: 'context-guard', source: { kind: 'user' } })
    expect(started.data.args).toBe(' on')
    expect(done.data).toMatchObject({ kind: 'success' })
    // Both halves share the pairing id the registry mints.
    expect(done.data.commandId).toBe(started.data.commandId)
    expect(settled?.commandId).toBe(started.data.commandId)
  })

  it('drives real enablement through the host event, not through the handler', async () => {
    const { run, derive } = harness()
    expect(derive().enabled).toBe(false)
    await run('/context-guard on')
    expect(derive()).toMatchObject({ enabled: true, epoch: 1 })
    await run('/context-guard off')
    expect(derive().enabled).toBe(false)
    // `on` again advances the epoch, so a re-enable is a distinct protected epoch.
    await run('/context-guard on')
    expect(derive()).toMatchObject({ enabled: true, epoch: 2 })
  })

  it('applies the host-logged clear to the re-derived contract', async () => {
    const { run, derive, userText } = harness()
    await run('/context-guard on')
    userText('修改 guard-demo.txt。不要 push。')
    const before = derive()
    const requirement = [...before.items.values()].find((item) => item.kind === 'requirement')!
    const prohibition = [...before.items.values()].find((item) => item.kind === 'prohibition')!
    expect(requirement.status).toBe('pending')

    await run('/context-guard clear')
    const after = derive()
    expect(after.items.get(requirement.id)!.status).toBe('superseded')
    expect(after.items.get(requirement.id)!.supersededBy).toMatch(/^CLEAR:\d+$/)
    expect(after.items.get(prohibition.id)!.status).toBe('pending')
    expect(after.contractRevision).toBeGreaterThan(before.contractRevision)
  })

  it('ignores a same-named command from a foreign source in the same log', async () => {
    // Enablement must come from a USER command, not merely from any event that
    // names the command. Appending a plugin-sourced command/run must not flip it.
    const { session, derive } = harness()
    session.append('command/run', {
      commandId: 'cmd-plugin', name: 'context-guard', args: 'on', source: { kind: 'plugin', plugin: 'other' },
    } as never)
    expect(derive().enabled).toBe(false)
  })
})
