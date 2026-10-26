#!/usr/bin/env node
/** Versioned zero-model fixture producer. Uses the official rc.3 persistence
 * handles; never submits an Agent inbox message or starts a host/model. */
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createUserMessage, createToolResultMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { apply as applyPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { DriverError, validateFixture } from './measure-session-switch.mjs'

export function appendFixtureHistory(session, { marker, preludeTurns = 0, distribution = 'roots', outputBytes = 4096 }, constructors = { createUserMessage, createToolResultMessage, createAssistantMessage }) {
  if (!['roots', 'tool'].includes(distribution) || !Number.isSafeInteger(outputBytes) || outputBytes < 0 || outputBytes > 1048576) throw new DriverError(2, 'invalid history distribution/output byte budget')
  for (let turn = 1; turn <= preludeTurns + 1; turn++) {
    session.append('turn/start', { turn })
    session.append('user/message', constructors.createUserMessage({ content: [{ type: 'text', text: turn === preludeTurns + 1 ? marker : `Explain fixture requirement ${turn} and continue with step ${turn}.` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    if (distribution === 'tool' && turn <= preludeTurns) for (let call = 0; call < 3; call++) {
      const callId = `fixture-${turn}-${call}`, step = call + 1
      session.append('step/start', { turn, step })
      session.append('assistant/message', { turn, step, stream: [], message: constructors.createAssistantMessage({ source: { provider: 'fixture', model: 'synthetic-no-model' }, content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: JSON.stringify({ command: `echo synthetic-${turn}-${call}` }) }] }) }, { surfaceOp: 'append' })
      session.append('tool/call', { turn, step, callId, name: 'bash', arguments: JSON.stringify({ command: `echo synthetic-${turn}-${call}` }) })
      session.append('tool/result', { turn, step, message: constructors.createToolResultMessage({ callId, content: [{ type: 'text', text: call === 1 ? 'x'.repeat(outputBytes) : 'Synthetic completed output; no tool executed.' }], isError: false }) }, { surfaceOp: 'append' })
      session.append('step/end', { turn, step })
    }
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
}
export function fixtureMetrics(events) {
  const roots = events.filter(e => e.type === 'user/message' && e.data.source?.kind === 'user').length
  return { eventCount: events.length, serializedEventBytes: Buffer.byteLength(JSON.stringify(events)), rootInputCount: roots, rootInputDensity: events.length ? roots / events.length : 0, toolResultCount: events.filter(e => e.type === 'tool/result').length }
}
export async function seedSessions(persistence, { nonce, cwd, preludeTurns = 0, distribution = 'roots', outputBytes = 4096 }) {
  if (!Number.isSafeInteger(preludeTurns) || preludeTurns < 0 || preludeTurns > 10000) throw new DriverError(2, 'preludeTurns must be 0..10000')
  const sessions = []
  for (const suffix of ['a', 'b']) {
    const id = SessionId(`guard-ui-${nonce}-${suffix}`), marker = `GUARD-UI-HISTORY-${nonce}-${suffix}`
    const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, isSeeded: false, id, createdAt: Date.now(), cwd })
    appendFixtureHistory(session, { marker, preludeTurns, distribution, outputBytes })
    const writer = await persistence.create(session.header)
    try { await writer.append(session.snapshotEvents()); await writer.flush() } finally { await writer.close() }
    // A NEW official read handle validates on-disk bytes, not the writer's
    // in-memory projection. Export only after the exact marker is observed.
    const reader = await persistence.open(id, 'read')
    try {
      const result = await reader.read()
      if (reader.header.id !== id || result.events.length !== session.snapshotEvents().length || !result.events.some(e => e.type === 'user/message' && e.data.content?.some(c => c.type === 'text' && c.text === marker))) throw new DriverError(5, 'persisted fixture readback mismatch')
      sessions.push({ id, marker, ...fixtureMetrics(result.events), persistedReadbackVerified: true })
    } finally { await reader.close() }
  }
  return sessions
}
export async function createFixture({ home, frontendUrl, sourceCommit, artifactSha256, output, preludeTurns = 0, deferHostSeeding = false, hostVersion = '0.2.1-rc.3', distribution = 'roots', outputBytes = 4096, surface = 'web' }) {
  if (!['web', 'desktop'].includes(surface)) throw new DriverError(2, 'unsupported fixture surface')
  if (!['0.2.1-rc.2', '0.2.1-rc.3'].includes(hostVersion) || !Number.isSafeInteger(preludeTurns) || preludeTurns < 0 || preludeTurns > 10000) throw new DriverError(2, 'unsupported fixture host or history scale')
  if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? '') || (artifactSha256 !== undefined && !/^[a-f0-9]{64}$/.test(artifactSha256))) throw new DriverError(2, 'exact source/artifact identity required')
  if (!['roots', 'tool'].includes(distribution) || !Number.isSafeInteger(outputBytes) || outputBytes < 0 || outputBytes > 1048576) throw new DriverError(2, 'invalid history distribution/output byte budget')
  home = resolve(home)
  if (existsSync(home) || existsSync(output)) throw new DriverError(2, 'fixture HOME and output must be unused; existing state preserved')
  const nonce = randomUUID(), profileRoot = join(home, 'profiles', surface), cwd = join(home, 'ui-fixture-work')
  mkdirSync(profileRoot, { recursive: true }); mkdirSync(cwd)
  writeFileSync(join(home, '.guard-ui-fixture-owner.json'), JSON.stringify({ schema: 'dsh-ui-fixture-owner/v1', nonce, sourceCommit, output: resolve(output) }) + '\n', { flag: 'wx' })
  const ctx = new Context()
  try {
    let sessions
    if (deferHostSeeding) sessions = ['a', 'b'].map(suffix => ({ id: `guard-ui-${nonce}-${suffix}`, marker: `GUARD-UI-HISTORY-${nonce}-${suffix}`, persistedReadbackVerified: false }))
    else { await applyPersistence(ctx, { root: join(home, 'sessions') }); sessions = await seedSessions(ctx.sessionPersistence, { nonce, cwd, preludeTurns, distribution, outputBytes }) }
    const manifest = { schema: 'dsh-ui-fixture/v1', ownership: 'task-owned', surface, nonce, hostVersion, sourceCommit, ...(artifactSha256 ? { artifactSha256 } : {}), home, profileRoot, frontendUrl, cwd, preludeTurns, distribution, outputBytes, sessions, producerSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'), protocol: 'official-rc2-rc3-dom/v1', realModelRequests: 0 }
    validateFixture(manifest)
    writeFileSync(output, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
    return manifest
  } finally { await ctx.fiber.dispose() }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), option = key => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1] }
  if (!option('--home') || !option('--frontend-url') || !option('--source-commit') || !option('--output')) {
    console.error('usage: --home <UNUSED task HOME> --frontend-url <explicit loopback URL> --source-commit <40hex> --output <new.json> [--artifact-sha256 <64hex>] [--prelude-turns 0..10000]'); process.exitCode = 2
  } else createFixture({ home: option('--home'), frontendUrl: option('--frontend-url'), sourceCommit: option('--source-commit'), artifactSha256: option('--artifact-sha256'), output: option('--output'), preludeTurns: Number(option('--prelude-turns') ?? 0), deferHostSeeding: true, hostVersion: option('--host-version') ?? '0.2.1-rc.3', distribution: option('--distribution') ?? 'roots', outputBytes: Number(option('--output-bytes') ?? 4096), surface: option('--surface') ?? 'web' }).then(manifest => console.log(JSON.stringify({ written: option('--output'), sessions: manifest.sessions.map(s => ({ id: s.id, eventCount: s.eventCount })), persistedReadbackVerified: manifest.sessions.every(s => s.persistedReadbackVerified), protectedHostSeedingRequired: true, realModelRequests: 0 })), error => { console.error(JSON.stringify({ status: 'failed', reason: error.message, fixturePreserved: true })); process.exitCode = error.code ?? 3 })
}
