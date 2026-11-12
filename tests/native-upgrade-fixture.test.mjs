import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import * as domain from '../src/domain/index.js'
import { predecessorActivationFixture, runPredecessorActivationFixture } from '../scripts/native_upgrade_fixture_v131.mjs'

const dirs = []
afterEach(() => { for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true }) })
it('binds both modes on every native profile to the executed 0.13.0 writer and its exact module inventory', () => {
  const fixture = predecessorActivationFixture()
  expect(new Set(fixture.rows.map(row => row.profile))).toEqual(new Set(['web', 'headless', 'desktop']))
  expect(fixture.moduleHashes['dist/domain/index.js']).toMatch(/^[a-f0-9]{64}$/)
  for (const row of fixture.rows) {
    expect(domain.validateActivationBinding(JSON.parse(row.binding))).toMatchObject({ initialMode: row.mode })
    expect(row.messages.length).toBeGreaterThanOrEqual(2)
  }
})

it.each(['web', 'headless', 'desktop'].flatMap(profile => ['none', 'zstd'].map(compression => [profile, compression])))('preserves old binding bytes and a nonempty official %s/%s log on two restores', async (profile, compression) => {
  const root = mkdtempSync(join(tmpdir(), 'guard-native-upgrade-')); dirs.push(root)
  const require = createRequire(join(process.cwd(), 'package.json'))
  const persistence = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href)
  const ctx = new Context()
  const plugin = ctx.plugin(persistence.default ?? persistence, { root: join(root, 'logs'), compression })
  await plugin.await()
  const handles = new Map()
  const save = async session => {
    const handle = handles.get(session.id)
    const before = (await handle.read()).events.length
    await handle.append(session.snapshotEvents().slice(before))
    await handle.flush()
    return true
  }
  // Real official storage and Session framing exercise the helper's public
  // API chain. Actual Agent/Guard loading remains a separate native gate.
  const adapter = { sessionPersistence: ctx.sessionPersistence, sessions: { flush: save } }
  const createProbeAgent = async (_ctx, id) => {
    const h = await ctx.sessionPersistence.open(id, 'write')
    handles.set(id, h)
    const session = Session.create(id, (await h.read()).events, h.header, h.inheritedEventCount)
    return { agent: { session }, dispose: async () => { try { await save(session) } finally { await h.close(); handles.delete(id) } } }
  }
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  try {
    expect(await runPredecessorActivationFixture({ ctx: adapter, config: { profile, workRoot: root }, domain,
      SessionId, createUserMessage, createProbeAgent })).toEqual({ positive: true, negative: true })
    expect(handles.size).toBe(0)
    for (const row of predecessorActivationFixture().rows.filter(row => row.profile === profile)) {
      const binding = domain.activationBindingPath(domain.resolveActivationBindingsRoot(root), row.header.id)
      expect(readFileSync(binding, 'utf8')).toBe(row.binding)
      const reader = await ctx.sessionPersistence.open(SessionId(row.header.id), 'read')
      try { expect((await reader.read()).events.filter(event => event.type === 'user/message')).toHaveLength(2) }
      finally { await reader.close() }
    }
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    for (const h of handles.values()) await h.close()
    await ctx.fiber.dispose()
  }
}, 30_000)
