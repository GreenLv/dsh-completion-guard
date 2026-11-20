import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'vitest'
import * as domain from '../src/domain/index.js'

// Exercise the locked rc.5 SDK graph and write only to a temporary session root.
const runtime = process.cwd()
const store = join(runtime, 'node_modules', '.pnpm')
const entries = await readdir(store)
async function sdk(name) {
  const matches = entries.filter(entry => entry.startsWith(`@deepseek-ai+${name}@0.2.2-rc.5`))
  assert.equal(matches.length, 1, `${name} has an ambiguous SDK identity`)
  const path = join(store, matches[0], 'node_modules', '@deepseek-ai', name, 'lib', 'index.js')
  return import(pathToFileURL(path).href)
}
const agentLoop = await sdk('dsh-agent-loop')
const adapter = await sdk('dsh-llm-deepseek')
const llm = await sdk('dsh-llm')
const session = await sdk('dsh-session')
const persistence = await sdk('dsh-session-persistence-jsonl')
const projections = await sdk('dsh-session-projection')
const agents = await sdk('dsh-agent')
const prompt = await sdk('dsh-system-prompt')
const tools = await sdk('dsh-tools')
const executor = await sdk('dsh-tool-executor-native')
const agentLoopDir = entries.find(entry => entry.startsWith('@deepseek-ai+dsh-agent-loop@0.2.2-rc.5'))
const requireFromLoop = createRequire(join(store, agentLoopDir, 'node_modules', '@deepseek-ai', 'dsh-agent-loop', 'package.json'))
const { Context } = await import(pathToFileURL(requireFromLoop.resolve('@deepseek-ai/cordis')).href)

const model = 'deepseek-v4-flash'
function events(reason) {
  return [
    { type: 'message_start', message: { id: 'message-fixture', model, usage: { input_tokens: 12, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Created report.txt.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]
}

async function inspectTurn(reason, compression) {
  const root = await mkdtemp(join(tmpdir(), 'dcg-refusal-sdk-'))
  const ctx = new Context()
  const priorFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://mock.invalid/anthropic/v1/messages')
    assert.equal(init.method, 'POST')
    calls += 1
    const body = events(reason).map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    for (const [plugin, config] of [
      [session.default, {}],
      [projections.default, {}],
      [agents.default, {}],
      [prompt.default, {}],
      [tools.default, {}],
      [executor, {}],
      [llm.default, {}],
      [persistence.apply, { root, compression }],
      [agentLoop.default, {}],
    ]) await ctx.plugin(plugin, config).await()
    ctx.llm.registerAdapter(['deepseek-official'], new adapter.DeepSeekAdapter({
      options: () => adapter.resolveAdapterOptions({ baseURL: 'https://mock.invalid/anthropic' }),
      resolveAuth: async () => ({ headers: {} }),
      resolveUserId: () => 'local-fixture',
      prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
    }))
    const id = session.SessionId(`refusal-fixture-${reason}-${compression}`)
    const handle = await ctx.agents.create({ sessionId: id, agentOptions: { provider: 'deepseek-official', model } })
    handle.agent.followup(llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Create report.txt.' }] }))
    await handle.agent.whenIdle()
    const live = handle.agent.session.snapshotEvents()
    assert.equal(calls, 1, JSON.stringify(live))
    await ctx.sessions.flush(handle.agent.session)
    await handle.dispose()
    const reader = await ctx.sessionPersistence.open(id, 'read')
    try {
      const stored = (await reader.read()).events
      assert.deepEqual(stored, live)
      return { events: stored, header: reader.header }
    } finally {
      await reader.close()
    }
  } finally {
    globalThis.fetch = priorFetch
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

test('real rc.5 Agent and JSONL worker preserve refused and completed turns', async () => {
  for (const compression of ['none', 'zstd']) {
    const refusedResult = await inspectTurn('refusal', compression)
    const completedResult = await inspectTurn('end_turn', compression)
    const refused = refusedResult.events
    const completed = completedResult.events
    const refusalAttempt = refused.find(event => event.type === 'assistant/attempt')
    assert.ok(refusalAttempt)
    assert.equal(refused.some(event => event.type === 'assistant/message'), false)
    const records = refusalAttempt.data.stream.filter(entry => entry.type === 'chunk').map(entry => entry.chunk)
    assert.deepEqual(records.find(chunk => chunk.type === 'usage')?.usage, { inputTokens: 12, outputTokens: 5, totalTokens: 17 })
    assert.deepEqual(records.at(-1).reason, { kind: 'error', failure: { message: 'DeepSeek refused to answer under its content safety review', code: 'CONTENT_REFUSED' } })
    assert.equal(refused.at(-1).type, 'turn/end')
    assert.equal(refused.at(-1).data.reason.kind, 'error')
    assert.equal(refused.at(-1).data.reason.error.code, 'CONTENT_REFUSED')
    assert.ok(completed.some(event => event.type === 'assistant/message'))
    assert.equal(completed.at(-1).type, 'turn/end')
    assert.equal(completed.at(-1).data.reason.kind, 'completed')
    {
      const scope = result => ({ cwd: process.cwd(), sessionHeader: { version: result.header.version, id: result.header.id, createdAt: result.header.createdAt } })
      const refusedProjection = domain.deriveProjection(refused, { activation: 'always' }, scope(refusedResult), true).projection
      const completedProjection = domain.deriveProjection(completed, { activation: 'always' }, scope(completedResult), true).projection
      for (const projection of [refusedProjection, completedProjection]) {
        const requirement = projection.items.get('R001')
        assert.equal(requirement?.normalizedText, 'Create report.txt.')
        assert.equal(requirement?.status, 'pending')
        assert.equal(projection.evidence.size, 0)
      }
    }
  }
})
