/** Versioned 0.7 no-model probe. Loaded only in the disposable native host.
 * Ordinary mutations use the host's own tools; Guard observes current closure.
 * Certificates belong to explicitly adopted proof, Goal, or release paths. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createProbeAgent, readProbeItem, runtimeRequire, shellTerminalFacts } from './native_host_probe.mjs'
import { runNativeReleaseFixture } from './native_release_fixture_v070.mjs'

export const name = 'completion-guard-native-probe-v070'
export const inject = ['agents', 'sessions', 'sessionPersistence', 'appReady']
const DRIVER_FILES = ['native_host_probe.mjs', 'native_host_probe_v070.mjs', 'native_release_fixture_v070.mjs']
export function driverDigest() {
  const digest = createHash('sha256').update('dsh.native-probe.v070\n')
  for (const name of DRIVER_FILES) digest.update(name).update('\0')
    .update(createHash('sha256').update(readFileSync(new URL(name, import.meta.url))).digest('hex')).update('\n')
  return digest.digest('hex')
}

const INITIAL_CASES = [
  'v070_root_v6_delivery', 'v070_ordinary_file_edit_readback',
  'v070_ordinary_test_and_checkpoint', 'v070_future_vs_current_stop',
  'v070_short_resume_and_persistence', 'v070_legacy_migration',
  'v070_goal_adoption_current_closure', 'v070_explicit_release_minimum',
  'v070_history_compaction_restart',
]
const textOf = event => Array.isArray(event?.data?.content)
  ? event.data.content.filter(part => part?.type === 'text').map(part => part.text).join('') : ''

// npm runs package scripts through the platform shell. Double quotes preserve
// the JavaScript expression in both POSIX shells and Windows cmd.exe; single
// quotes are literal characters in cmd.exe and can turn a failing test green.
export function nativeTestFixturePackage(exitCode, name = 'native-test-fixture') {
  assert.ok(exitCode === 0 || exitCode === 1)
  assert.ok(name === 'native-test-fixture' || name === 'native-goal-fixture')
  return `${JSON.stringify({ name, private: true,
    scripts: { test: `node -e "process.exit(${exitCode})"` } })}\n`
}

/** Derive readback with the same active graph and renderer bytes as the
 * registered Guard runtime. A package-list-only digest is stale whenever the
 * runtime binds an audited foreground renderer into its Host Lock. */
export function probeHostLock(domain, config, platform) {
  const context = { platform, profileKind: config.profile }
  const expected = domain.evaluateHostLock(config.hostPackages, context)
  const actual = domain.evaluateHostLock(domain.readActiveHostGraph(config.runtimeRoot, config.profileRoot), context)
  if (actual.status !== 'supported') return actual
  if (actual.digest !== expected.digest) return {
    ...actual, status: 'unsupported', goalAvailable: false, reasonCode: 'host_lock_installed_graph_drift',
  }
  const audited = domain.auditedForegroundRenderers(config.runtimeRoot, config.profileRoot)
  return audited.length ? { ...actual, auditedForegroundRenderers: audited,
    digest: createHash('sha256').update(`dsh.core-host-renderer/v1\0${actual.digest}\0${audited.join(',')}`).digest('hex'),
  } : actual
}

/** The ordinary v6 read surface cannot issue a certificate or an old binding.
 * Keep this check independent of the caller's desired completion state. */
export function assertOrdinaryCheckpoint(value, status) {
  assert.equal(value?.status, status)
  assert.equal(value?.feedback_source, 'confirmed_core_v2')
  assert.equal(value?.certificate_status, 'not_requested')
  assert.equal(value?.certificate, undefined)
  assert.equal(value?.proof_state, undefined)
  assert.ok(Array.isArray(value?.open_items))
  assert.ok(value.open_items.every(row => row.binding_template === undefined))
}

export function apply(ctx, config) {
  ctx.effect(() => ctx.appReady.onReady(async () => {
    const digest = driverDigest()
    const runtime = runtimeRequire(config.runtimeRoot)
    const { createUserMessage, createToolResultMessage } = await import(pathToFileURL(runtime.resolve('@deepseek-ai/dsh-llm')).href)
    const { SessionId } = await import(pathToFileURL(runtime.resolve('@deepseek-ai/dsh-session')).href)
    const domain = await import(pathToFileURL(join(config.profileRoot, 'node_modules', 'dsh-completion-guard', 'dist', 'domain', 'index.js')).href)
    const rows = []
    let handle
    let current = 'initialize_runtime'
    let operation = 'initialize'
    let lastTool = null
    let ordinal = 0
    let turnOrdinal = 0
    let mode = 'initial'
    const sessionFor = label => SessionId(`guard-native-${config.nonce}-${label}`)
    const open = async (label, resume = false) => {
      if (handle) await handle.dispose()
      handle = await createProbeAgent(ctx, sessionFor(label), config.workRoot, resume)
      ordinal = 0
      turnOrdinal = 0
      return handle.agent
    }
    const events = () => handle.agent.session.snapshotEvents()
    const projection = () => {
      const hostLock = probeHostLock(domain, config, process.platform === 'win32' ? 'windows' : 'posix')
      const agent = handle.agent
      const raw = agent.session.header
      // The host's V3 header also contains cwd/isSeeded, which are not digest
      // fields. Use the same immutable session identity inputs as runtime.ts.
      const scope = { cwd: raw.cwd, sessionHeader: {
        version: raw.version, id: raw.id, createdAt: raw.createdAt,
        ...(typeof raw.parentSession === 'string' ? { parentSession: raw.parentSession } : {}),
        seedLength: agent.session.inheritedEventCount,
        ...(typeof raw.agentPreset === 'string' ? { agentPreset: raw.agentPreset } : {}),
        ...(typeof raw.origin === 'string' ? { origin: raw.origin } : {}),
        delegationDepth: typeof raw.delegationDepth === 'number' ? raw.delegationDepth : 0,
      } }
      const view = domain.deriveProjection(events(), { activation: 'always' }, scope, true, hostLock).projection
      view.durabilityWatermark = 'confirmed'
      view.coreV2 = domain.projectSessionCoreV2(events(), view)
      return view
    }
    const flush = async () => assert.equal(await ctx.sessions.flush(handle.agent.session), true)
    const root = async phrase => {
      operation = 'root_pre_step'
      const turn = ++turnOrdinal
      const message = createUserMessage({ content: [{ type: 'text', text: phrase }], source: { kind: 'user' } })
      const decision = await handle.agent.ctx.waterfall('agent/pre-step', {
        agent: handle.agent, messages: [message], turn, step: ++ordinal, signal: AbortSignal.timeout(30000),
      }, async () => ({ kind: 'enter', messages: [message] }))
      assert.equal(decision.kind, 'enter')
      handle.agent.session.append('turn/start', { turn })
      for (const entry of decision.messages) handle.agent.session.append('user/message', entry, { surfaceOp: 'append' })
      await flush()
    }
    const tool = async (name, args, expectSuccess = true) => {
      const agent = handle.agent
      const callId = `native-v070-${process.pid}-${++ordinal}`
      agent.session.append('tool/call', { turn: turnOrdinal, step: ordinal, callId, name, arguments: JSON.stringify(args) })
      operation = `tool_${name}`
      const result = await agent.ctx.tools.execute({ callId, name, arguments: args, agent, signal: AbortSignal.timeout(30000) })
      lastTool = { name, registered: Boolean(agent.ctx.tools.get(name, agent)),
        is_error: result.isError, status: typeof result.value?.status === 'string' ? result.value.status : null,
        error_code: typeof result.error?.info?.code === 'string' ? result.error.info.code : null,
        ...(['bash', 'pwsh'].includes(name) ? { terminal: shellTerminalFacts(result.value) } : {}) }
      agent.session.append('tool/result', {
        turn: turnOrdinal, step: ordinal,
        message: createToolResultMessage({ callId, content: result.content, isError: result.isError }),
        ...(result.error ? { error: result.error } : {}), ...(result.meta ? { meta: result.meta } : {}),
      }, { surfaceOp: 'append' })
      operation = 'tool_result_flush'
      await flush()
      if (expectSuccess) assert.equal(result.isError, false, `${name} host result`)
      return { callId, value: result.value, result }
    }
    const check = async (id, fn) => {
      current = id
      operation = id
      const pair = await fn()
      assert.equal(pair.positive, true, `${id} positive`)
      assert.equal(pair.negative, true, `${id} negative`)
      rows.push({ id, status: 'passed', positive: true, negative: true })
    }
    try {
      if (existsSync(`${config.output}.complete`)) {
        mode = 'restart'
        const receipt = JSON.parse(readFileSync(`${config.output}.complete`, 'utf8'))
        assert.equal(receipt.nonce, config.nonce)
        assert.equal(receipt.driver_sha256, digest)
        await check('v070_persisted_restart_resume', async () => {
          await open('history', true)
          const page = (await tool('context_guard_checkpoint', { bindings: [], evidence_scope: 'history', limit: 1 })).value
          assert.ok(page.pagination)
          assert.ok(events().some(event => event.type === 'compaction/summary'))
          assert.ok(events().some(event => event.type === 'user/message' && event.data?.source?.kind === 'user'))
          return { positive: true, negative: page.status !== 'certified' || !!page.certificate }
        })
      } else {
        await check('v070_root_v6_delivery', async () => {
          await open('root')
          assert.equal(events().filter(event => event.type === 'user/message').length, 0)
          await root('Explain the isolated acceptance fixture.')
          const messages = events().filter(event => event.type === 'user/message')
          assert.equal(messages[0].data.source.plugin, 'context-guard')
          assert.equal(textOf(messages[0]), 'Context Guard protocol boundary: v6.0.0')
          assert.equal(messages.filter(event => event.data.source.kind === 'user').length, 1)
          assert.equal(textOf(messages.at(-1)), 'Explain the isolated acceptance fixture.')
          return { positive: true, negative: !messages.some(event => textOf(event) === 'Context Guard protocol boundary: v5.0.0') }
        })
        await check('v070_ordinary_file_edit_readback', async () => {
          await open('file')
          const path = join(config.workRoot, `native-v070-${config.nonce}-${config.profile}.txt`)
          writeFileSync(path, 'before\n')
          await root(`Modify ${path} to native-v070.`)
          const before = await tool('context_guard_checkpoint', { bindings: [] })
          assertOrdinaryCheckpoint(before.value, 'incomplete')
          await tool('read', { file_path: path })
          const edit = await tool('edit', { file_path: path, old_string: 'before', new_string: 'native-v070' })
          const observed = await tool('context_guard_observe_file', { effect_call_id: edit.callId })
          assert.equal(observed.value.status, 'observed')
          assert.equal(observed.value.path, path)
          assert.equal(observed.value.sha256, createHash('sha256').update('native-v070\n').digest('hex'))
          const read = await tool('read', { file_path: path })
          assert.equal(read.value.path, path)
          assert.equal(readFileSync(path, 'utf8'), 'native-v070\n')
          assertOrdinaryCheckpoint((await tool('context_guard_checkpoint', { bindings: [] })).value, 'observed')
          const wrong = await tool('context_guard_observe_file', { effect_call_id: 'never-existed' })
          assert.equal(wrong.value.status, 'unavailable')
          return { positive: true, negative: true }
        })
        await check('v070_ordinary_test_and_checkpoint', async () => {
          await open('test')
          writeFileSync(join(config.workRoot, 'package.json'), nativeTestFixturePackage(0))
          await root(`Run npm test in ${config.workRoot}.`)
          const pending = (await tool('context_guard_checkpoint', { bindings: [] })).value
          assertOrdinaryCheckpoint(pending, 'incomplete')
          const item = pending.open_items.find(row => row.semantic_action === 'test')
          assert.ok(item)
          const readiness = (await tool('context_guard_observe_test_readiness', { item_id: item.id })).value
          assert.equal(readiness.status, 'ready')
          const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
          const fields = handle.agent.ctx.tools.get(shell, handle.agent)?.parameters?.properties ?? {}
          const executed = await tool(shell, { command: 'npm test', workdir: config.workRoot,
            ...(fields.description ? { description: 'Run isolated native acceptance fixture' } : {}) })
          assert.deepEqual(shellTerminalFacts(executed.value), { kind: 'foreground', exit_code: 0, timed_out: false, aborted: false })
          const observed = (await tool('context_guard_checkpoint', { bindings: [] })).value
          assertOrdinaryCheckpoint(observed, 'observed')
          assert.equal(observed.open_items.length, 0)
          assert.ok(events().some(event => event.type === 'tool/result' && event.data?.message?.source?.callId === executed.callId))
          const noOrdinaryExecutor = await tool('context_guard_action', { semantic_action: 'install',
            resolution_call_id: 'absent-ordinary', target_digest: '0'.repeat(64),
            contract_item_id: item.id, contract_item_revision: 1 })
          assert.equal(noOrdinaryExecutor.value?.status, 'unavailable')
          assert.equal(noOrdinaryExecutor.value?.reason_code, 'ordinary_action_migrated_to_host_tools')
          await open('test-failed')
          writeFileSync(join(config.workRoot, 'package.json'), nativeTestFixturePackage(1))
          await root(`Run npm test in ${config.workRoot}.`)
          const failedPending = (await tool('context_guard_checkpoint', { bindings: [] })).value
          assertOrdinaryCheckpoint(failedPending, 'incomplete')
          const failedItem = failedPending.open_items.find(row => row.semantic_action === 'test')
          assert.ok(failedItem)
          assert.equal((await tool('context_guard_observe_test_readiness', { item_id: failedItem.id })).value.status, 'ready')
          const failed = await tool(shell, { command: 'npm test', workdir: config.workRoot,
            ...(fields.description ? { description: 'Run failing isolated native fixture' } : {}) }, false)
          assert.equal(failed.result.isError || shellTerminalFacts(failed.value).exit_code !== 0, true)
          assertOrdinaryCheckpoint((await tool('context_guard_checkpoint', { bindings: [] })).value, 'incomplete')
          return { positive: true, negative: true }
        })
        await check('v070_future_vs_current_stop', async () => {
          await open('future')
          await root('Explain the fixture now; any future performance benefit can be observed later.')
          const future = projection()
          assert.equal(domain.currentActionBases(future).length, 0)
          assert.equal(domain.decideTurnBoundary(future).action, 'stop')
          await open('current')
          await root(`Run npm test in ${config.workRoot} before finishing.`)
          const item = (await tool('context_guard_checkpoint', { bindings: [] })).value.open_items.find(row => row.semantic_action === 'test')
          assert.ok(item)
          assert.equal((await tool('context_guard_observe_test_readiness', { item_id: item.id })).value.status, 'ready')
          const current = projection()
          assert.ok(domain.currentActionBases(current).some(action => action.action === 'test'))
          return { positive: true, negative: true }
        })
        await check('v070_short_resume_and_persistence', async () => {
          await open('resume-ready')
          await root(`Run npm test in ${config.workRoot}.`)
          const item = (await tool('context_guard_checkpoint', { bindings: [] })).value.open_items.find(row => row.semantic_action === 'test')
          assert.ok(item)
          assert.equal((await tool('context_guard_observe_test_readiness', { item_id: item.id })).value.status, 'ready')
          await root('继续')
          const ready = projection()
          const action = domain.decideTurnBoundary(ready, '继续')
          assert.equal(action.reason, 'resume_with_actionable_work')
          assert.equal([...ready.items.values()].some(item => item.persistenceAuthorization?.kind === 'root_explicit_persistence'), false)
          await open('resume-empty')
          await root('继续')
          const empty = projection()
          assert.equal(domain.decideTurnBoundary(empty, '继续').action, 'stop')
          assert.equal([...empty.items.values()].some(item => item.persistenceAuthorization?.kind === 'root_explicit_persistence'), false)
          return { positive: true, negative: true }
        })
        await check('v070_legacy_migration', async () => {
          await open('migration')
          // Persisted pre-v6 content is a historical fixture. It is deliberately
          // appended before the first real pre-step emits this version's notice.
          handle.agent.session.append('user/message', createUserMessage({
            content: [{ type: 'text', text: 'Update the demo plugin and wait for approval.' }], source: { kind: 'user' },
          }), { surfaceOp: 'append' })
          await flush()
          await root('Continue with the current isolated fixture.')
          const migrated = projection()
          assert.equal(migrated.boundaryProtocol, 6)
          assert.ok(events().some(event => textOf(event) === 'Update the demo plugin and wait for approval.'))
          assert.equal(domain.currentActionBases(migrated).some(action => action.source === 'old_generic'), false)
          assert.notEqual((await tool('context_guard_checkpoint', { bindings: [] })).value.status, 'certified')
          return { positive: true, negative: true }
        })
        await check('v070_goal_adoption_current_closure', async () => {
          await open('goal')
          const goals = handle.agent.ctx.get?.('goals') ?? ctx.get?.('goals')
          assert.ok(goals && typeof goals.create === 'function')
          const goal = goals.create(handle.agent, { objective: 'Run the isolated fixture test' })
          handle.agent.session.append('command/run', { name: 'context-guard', args: 'on', source: { kind: 'user' } })
          await flush()
          const goalWork = config.workRoot
          writeFileSync(join(goalWork, 'package.json'), nativeTestFixturePackage(0, 'native-goal-fixture'))
          await root(`Run npm test in ${goalWork}.`)
          const item = (await tool('context_guard_checkpoint', { bindings: [] })).value.open_items.find(row => row.semantic_action === 'test')
          assert.ok(item)
          assert.equal((await tool('context_guard_observe_test_readiness', { item_id: item.id })).value.status, 'ready')
          const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
          const fields = handle.agent.ctx.tools.get(shell, handle.agent)?.parameters?.properties ?? {}
          const args = { command: 'npm test', workdir: goalWork,
            ...(fields.description ? { description: 'Run isolated Goal fixture' } : {}) }
          const success = await tool(shell, args)
          assert.equal(shellTerminalFacts(success.value).exit_code, 0)
          const page = (await tool('context_guard_checkpoint', { bindings: [] })).value
          const binding = (await readProbeItem((name, args) => tool(name, args).then(result => result.value), page, item.id)).binding_template
          assert.ok(binding)
          const certificate = (await tool('context_guard_checkpoint', { bindings: [binding] })).value
          assert.equal(certificate.status, 'certified')
          assert.equal(certificate.certificate.goal_ref?.id, goal.id)
          assert.equal(domain.goalCompletionDenial(projection(), 'update_goal', { action: 'complete', goal_id: goal.id, revision: goal.revision }), undefined)
          const packagePath = join(goalWork, 'package.json')
          await tool('read', { file_path: packagePath })
          await tool('write', { file_path: packagePath, content: nativeTestFixturePackage(1, 'native-goal-fixture') })
          const failed = await tool(shell, args, false)
          assert.equal(failed.result.isError || shellTerminalFacts(failed.value).exit_code !== 0, true)
          const latest = projection()
          assert.equal(latest.coreV2?.certifiable, false)
          assert.match(domain.goalCompletionDenial(latest, 'update_goal', { action: 'complete', goal_id: goal.id, revision: goal.revision }) ?? '', /current_closure_unmet/)
          assert.equal(domain.goalCompletionDenial(latest, 'update_goal', { action: 'blocked', goal_id: goal.id, revision: goal.revision }), undefined)
          return { positive: true, negative: true }
        })
        // The explicit release case has a separate mock registry path; it may
        // never execute npm publish or contact a public registry.
        await check('v070_explicit_release_minimum', async () => {
          return runNativeReleaseFixture(config)
        })
        await check('v070_history_compaction_restart', async () => {
          await open('history')
          await root('Explain the isolated acceptance history.')
          const page = (await tool('context_guard_checkpoint', { bindings: [], evidence_scope: 'history', limit: 1 })).value
          assert.ok(page.pagination)
          handle.agent.session.append('compaction/summary', {
            compactionId: 'native-v070', summary: [], shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [],
            shadowedTokenCount: 0, provider: 'native-driver', model: 'none',
          })
          await flush()
          await open('history', true)
          assert.ok(events().some(event => event.type === 'compaction/summary'))
          const resumed = (await tool('context_guard_checkpoint', { bindings: [], evidence_scope: 'history', limit: 1 })).value
          assert.ok(resumed.pagination)
          assert.notEqual(resumed.status, 'certified')
          return { positive: true, negative: true }
        })
      }
    } catch (error) {
      rows.push({ id: current, status: 'failed', positive: false, negative: false, operation, last_tool: lastTool,
        error_code: /^[A-Z_]{1,60}$/.test(error?.code ?? '') ? error.code : 'PROBE_ASSERTION_FAILED' })
    } finally {
      if (handle) { try { await handle.dispose() } catch { rows.push({ id: 'v070_agent_cleanup', status: 'failed', positive: false, negative: false }) } }
      const result = { schema: 'dsh-native-host-probe/v2', nonce: config.nonce, pid: process.pid, mode,
        driver_sha256: digest, status: rows.length === (mode === 'initial' ? INITIAL_CASES.length : 1)
          && rows.every(row => row.status === 'passed') ? 'passed' : 'failed',
        cases: rows, real_model_request: false }
      if (mode === 'initial' && result.status === 'passed') writeFileSync(`${config.output}.complete`, JSON.stringify({ nonce: config.nonce, driver_sha256: digest }))
      writeFileSync(`${config.output}.${process.pid}.json.tmp`, JSON.stringify(result))
      renameSync(`${config.output}.${process.pid}.json.tmp`, `${config.output}.${process.pid}.json`)
    }
  }), 'native 0.7 acceptance readiness')
}
