/** Loaded only by the versioned task-owned UI preparation overlay. */
import { writeUtf8Atomic, readJsonFile, readUtf8File, parseJsonBytes } from './ui-fixture-io.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { validateFixture } from './measure-session-switch.mjs'
import { appendFixtureHistory, fixtureMetrics } from './create-ui-session-fixture.mjs'
import { runtimeRequire, createProbeAgent } from './native_host_probe.mjs'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export function verifyObservationInput({ plan, priorBytes, seedReceiptSha256, packageManifest, producerSha256, probeSha256, agents, domain }) {
  if (!/^[a-f0-9]{64}$/.test(seedReceiptSha256 ?? '') || hash(priorBytes) !== seedReceiptSha256) throw new Error('observe seed receipt bytes mismatch')
  const prior = validateFixture(parseJsonBytes(priorBytes), true)
  for (const key of ['schema', 'ownership', 'surface', 'nonce', 'hostVersion', 'sourceCommit', 'artifactSha256', 'home', 'profileRoot', 'frontendUrl', 'cwd', 'preludeTurns', 'distribution', 'outputBytes', 'protocol', 'producerSha256']) if (JSON.stringify(prior[key]) !== JSON.stringify(plan[key])) throw new Error(`observe fixture identity mismatch: ${key}`)
  if (!/^[a-f0-9]{64}$/.test(plan.artifactSha256 ?? '') || plan.sourceCommit !== packageManifest.gitHead || prior.protection.guardGitHead !== packageManifest.gitHead || prior.protection.guardVersion !== packageManifest.version || prior.producerSha256 !== producerSha256 || prior.protection.probeSha256 !== probeSha256) throw new Error('observe producer/probe/package identity mismatch')
  for (let i = 0; i < prior.sessions.length; i++) {
    const row = prior.sessions[i], expected = plan.sessions[i]
    if (row.id !== expected.id || row.marker !== expected.marker || agents.get(row.id)) throw new Error('observe target identity or already-live target')
    const identity = row.protection.birthIdentity
    if (identity?.id !== row.id) throw new Error('observe birth identity missing')
    const binding = domain.readActivationBinding(domain.resolveActivationBindingsRoot(plan.home, homedir()), identity)
    if (binding.status !== 'bound' || binding.mode !== 'always' || binding.binding.source !== 'fresh_creation' || binding.binding.sha256 !== row.protection.bindingSha256) throw new Error('observe protected binding missing or changed')
  }
  return prior
}
export const hasLoadedGuardTool = agent => Boolean(agent.ctx.tools.get('context_guard_checkpoint', agent))
export function readLiveProtectionSessions(ctx, sessions, domain, home) {
  return sessions.map(row => {
    const agent = ctx.agents.get(row.id)
    if (!agent) return { id: row.id, live: false }
    if (agent.id !== row.id || String(agent.session.id) !== row.id) throw new Error('live fixture agent identity mismatch')
    const binding = domain.readActivationBinding(domain.resolveActivationBindingsRoot(home, homedir()), domain.sessionBirthIdentity(agent.session.header, agent.session.inheritedEventCount))
    return { id: row.id, live: true, mode: binding.status === 'bound' ? binding.mode : null, registeredGuardTool: hasLoadedGuardTool(agent) }
  })
}
export const name = 'guard-ui-session-fixture'
export const inject = ['agents', 'sessions', 'sessionPersistence', 'appReady', 'connection']
export function apply(ctx, config) {
  ctx.effect(() => ctx.appReady.onReady(async () => {
    const sessions = []
    try {
      const fixture = validateFixture(readJsonFile(config.fixturePath))
      const installed = join(fixture.profileRoot, 'node_modules', 'dsh-completion-guard')
      const packageManifest = readJsonFile(join(installed, 'package.json'))
      const domain = await import(pathToFileURL(join(installed, 'dist', 'domain', 'index.js')).href)
      const require = runtimeRequire(config.runtimeRoot)
      const { createUserMessage, createToolResultMessage, createAssistantMessage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href)
      const context = { platform: process.platform === 'win32' ? 'windows' : 'posix', profileKind: fixture.surface ?? 'web' }
      const host = fixture.surface === 'desktop'
        ? domain.revalidateDesktopCoreLock(config.guardConfig.hostLockRuntimeRoot, fixture.profileRoot, domain.evaluateHostLock(config.guardConfig.hostLockPackages, context), config.guardConfig.hostLockTrust)
        : domain.evaluateActiveHostLock(config.runtimeRoot, fixture.profileRoot, context, undefined, config.guardConfig.hostLockTrust)
      if (fixture.surface === 'desktop' && host.digest !== config.guardConfig.hostLockDesktopDigest) throw new Error('UI Desktop injected identity differs from carrier')
      if (host.packages?.find(row => row.name === '@deepseek-ai/dsh')?.version !== fixture.hostVersion) throw new Error('UI fixture runtime version mismatch')
      if (host.status !== 'supported') throw new Error('UI fixture host qualification unavailable')
      const probeSha256 = hash(readFileSync(new URL(import.meta.url)))
      const producerSha256 = hash(readFileSync(new URL('./create-ui-session-fixture.mjs', import.meta.url)))
      if (fixture.producerSha256 !== producerSha256 || fixture.sourceCommit !== packageManifest.gitHead || !/^[a-f0-9]{64}$/.test(fixture.artifactSha256 ?? '')) throw new Error('UI fixture producer/artifact/source identity mismatch')
      if (!['seed', 'observe'].includes(config.mode ?? 'seed')) throw new Error('unknown UI fixture mode')
      if (config.mode === 'observe') {
        if (!config.runOutput || config.runOutput === config.output) throw new Error('observe requires a distinct new run output')
        const prior = verifyObservationInput({ plan: fixture, priorBytes: readFileSync(config.output), seedReceiptSha256: config.seedReceiptSha256, packageManifest, producerSha256, probeSha256, agents: ctx.agents, domain })
        sessions.push(...prior.sessions)
      } else for (const planned of fixture.sessions) {
        const handle = await createProbeAgent(ctx, planned.id, fixture.cwd)
        try {
          const agent = handle.agent, session = agent.session
          const binding = domain.readActivationBinding(domain.resolveActivationBindingsRoot(fixture.home, homedir()), domain.sessionBirthIdentity(session.header, session.inheritedEventCount))
          if (binding.status !== 'bound' || binding.mode !== 'always' || binding.binding.source !== 'fresh_creation') throw new Error('UI fixture is not protected by qualified fresh creation')
          if (!hasLoadedGuardTool(agent)) throw new Error('UI fixture Guard tool not loaded')
          appendFixtureHistory(session, { ...fixture, marker: planned.marker }, { createUserMessage, createToolResultMessage, createAssistantMessage })
          if (!await ctx.sessions.flush(session)) throw new Error('UI fixture durability unavailable')
          sessions.push({ ...planned, eventCount: session.seq, protection: { mode: binding.mode, bindingSource: binding.binding.source, bindingSha256: binding.binding.sha256, birthIdentity: binding.binding.identity, registeredGuardTool: true } })
        } finally { await handle.dispose() }
        const reader = await ctx.sessionPersistence.open(planned.id, 'read')
        try {
          const read = await reader.read()
          if (reader.header.id !== planned.id || !read.events.some(e => e.type === 'user/message' && e.data.content?.some(c => c.type === 'text' && c.text === planned.marker))) throw new Error('UI fixture persisted protected history mismatch')
          sessions.at(-1).persistedReadbackVerified = true
          Object.assign(sessions.at(-1), fixtureMetrics(read.events))
        } finally { await reader.close() }
      }
      const statusPath = `/api/guard-ui-fixture/${fixture.nonce}`
      ctx.effect(() => ctx.connection.fetch.register({ path: statusPath, methods: ['GET'], requestBody: 'buffered', fetch: () => Response.json({
        schema: 'dsh-ui-live-protection/v1', nonce: fixture.nonce, guardVersion: packageManifest.version, guardGitHead: packageManifest.gitHead,
        sessions: readLiveProtectionSessions(ctx, sessions, domain, fixture.home),
      }) }), 'read-only live UI fixture protection')
      const result = { ...fixture, sessions, protection: { schema: 'dsh-ui-protected-fixture/v1', status: 'verified', guardVersion: packageManifest.version, guardGitHead: packageManifest.gitHead, mode: 'always', hostLockStatus: host.status, hostLockDigest: host.digest, statusPath, probeSha256 } }
      if (config.mode === 'observe') writeUtf8Atomic(config.runOutput, JSON.stringify({ schema: 'dsh-ui-observer-run/v1', status: 'observer_ready', sourceCommit: fixture.sourceCommit, artifactSha256: fixture.artifactSha256, seedReceiptSha256: config.seedReceiptSha256, nonce: fixture.nonce, processId: process.pid, noSessionCreateAppendReadOrPromote: true, probeSha256 }) + '\n', { flag: 'wx' })
      else writeUtf8Atomic(config.output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
    } catch (error) {
      const failureBase = config.mode === 'observe' ? config.runOutput : config.output
      if (typeof failureBase === 'string') writeUtf8Atomic(failureBase + '.failed.json', JSON.stringify({ status: 'failed', reason: error.message, sessions, realModelRequests: 0 }) + '\n', { flag: 'wx' })
      throw error
    }
  }), 'protected UI fixture creation')
}
