/** Loaded only by native_acceptance.py in its disposable real DSH profile.
 * Drives the actual AgentRegistry, ToolRuntime and Session persistence without
 * a model request. It is not a synthetic replacement for those services. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, renameSync, realpathSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

export const name = 'completion-guard-native-probe'
export const inject = ['agents', 'sessions', 'sessionPersistence', 'appReady']

export function runtimeRequire(runtimeRoot) {
  return createRequire(realpathSync(join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')))
}

export async function createProbeAgent(ctx, sessionId, workRoot, resume = false) {
  const presets = ctx.get('agentPresets')
  const preset = presets ? (await presets.resolve('standard')).id : undefined
  const setup = presets ? async agentCtx => { await presets.mount(agentCtx, preset) } : undefined
  const handle = resume
    ? await ctx.agents.resume({ resumeSessionId: sessionId, setup })
    : await ctx.agents.create({ sessionId, meta: { cwd: workRoot, ...(preset ? { agentPreset: preset } : {}) }, setup })
  await handle.agent.whenIdle()
  return handle
}

/** Deterministic probe framing only; these injected tool advertisements are not
 * model requests. Preserve rc.2's native turn/step/tool relationships so the
 * same log can be restored by the real persistence reader. */
function probePosition(session) {
  let turn = null, step = null, nextTurn = 1, nextStep = 1
  for (const event of session.snapshotEvents()) {
    if (event.type === 'turn/start') { turn = event.data.turn; nextTurn = turn + 1; nextStep = 1 }
    if (event.type === 'turn/end') turn = null
    if (event.type === 'step/start') step = event.data.step
    if (event.type === 'step/end') { nextStep = event.data.step + 1; step = null }
  }
  assert.equal(step, null, 'probe must not overlap an unfinished step')
  return { turn, nextTurn, nextStep }
}

export function startProbeTurn(session) {
  const position = probePosition(session)
  if (position.turn !== null) session.append('turn/end', { turn: position.turn, reason: {kind:'blocked'} })
  session.append('turn/start', { turn: position.nextTurn })
  return position.nextTurn
}

export function appendProbeToolCall(session, createAssistantMessage, callId, name, args) {
  let position = probePosition(session)
  if (position.turn === null) { startProbeTurn(session); position = probePosition(session) }
  const coordinates = { turn: position.turn, step: position.nextStep }
  session.append('step/start', coordinates)
  session.append('assistant/message', { ...coordinates, stream: [], message: createAssistantMessage({
    source: {provider:'native-probe',model:'deterministic-injection'},
    content: [{type:'tool-call',id:callId,name,arguments:JSON.stringify(args)}],
  }) }, {surfaceOp:'append'})
  session.append('tool/call', {...coordinates,callId,name,arguments:JSON.stringify(args)})
  return coordinates
}

export function finishProbeToolCall(session, coordinates) {
  session.append('step/end', coordinates)
}

/** A bounded injected compaction record for persistence tests, not model compaction. */
export function appendProbeCompaction(session, compactionId) {
  const {turn} = probePosition(session)
  const source = session.snapshotEvents().find(event => event.type === 'user/message' && event.surfaceOp === 'append')
  assert.ok(source, 'compaction probe needs a real surface span')
  session.append('compaction/start', {compactionId,turn})
  session.append('compaction/summary', {compactionId,summary:[],
    shadowedRange:{start:source.seq,end:source.seq},shadowedSeqs:[source.seq],
    shadowedTokenCount:0,provider:'native-probe',model:'deterministic-injection'})
  session.append('compaction/end', {compactionId,turn})
}

/** Resolve rows folded by the public checkpoint response budget. */
export async function readProbeItem(call, page, itemId) {
  const row = page.open_items.find(item => item.id === itemId)
  assert.ok(row)
  if (!row.omitted) return row
  let offset = 0
  let snapshot
  let text = ''
  for (let count = 0; count < 128; count++) {
    const detail = await call('context_guard_checkpoint', { bindings: [], item_ids: [itemId], detail_id: row.detail_id,
      detail_offset: offset, ...(snapshot ? { detail_snapshot: snapshot } : {}) })
    assert.equal(typeof detail.detail_chunk, 'string')
    if (snapshot) assert.equal(detail.snapshot, snapshot)
    snapshot = detail.snapshot
    text += detail.detail_chunk
    if (detail.next_detail_offset === null) {
      const item = JSON.parse(text).find(entry => entry.id === itemId)
      assert.ok(item)
      return item
    }
    assert.ok(detail.next_detail_offset > offset)
    offset = detail.next_detail_offset
  }
  throw new Error('checkpoint detail exceeded native probe bound')
}

export async function readProbeTestBinding(call, page) {
  for (const row of page.open_items) {
    const item = await readProbeItem(call, page, row.id)
    if (item.binding_template?.semantic_action === 'test') return item.binding_template
  }
  return undefined
}

/** Terminal success is independent of ToolRuntime.isError and checkpoint state. */
export function shellTerminalFacts(value) {
  return {
    kind: ['foreground', 'background'].includes(value?.kind) ? value.kind : null,
    exit_code: Number.isInteger(value?.exitCode) ? value.exitCode : null,
    timed_out: typeof value?.timedOut === 'boolean' ? value.timedOut : null,
    aborted: typeof value?.aborted === 'boolean' ? value.aborted : null,
  }
}

export function assertTestCommandSucceeded(value) {
  assert.deepEqual(shellTerminalFacts(value), {
    kind: 'foreground', exit_code: 0, timed_out: false, aborted: false,
  })
}

export function apply(ctx, config) {
  ctx.effect(() => ctx.appReady.onReady(async () => {
    const rows = []
    let handle
    let failedCase = 'initialize_runtime'
    let operation = 'initialize'
    let lastTool = null
    let mode = 'initial'
    let createUserMessage, createToolResultMessage, createAssistantMessage, sessionId
    let clarifiedItemId
    const driverDigest = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex')
    const check = async (id, fn) => {
      failedCase = id
      await fn()
      rows.push({ id, status: 'passed' })
    }
    let ordinal = 0
    const root = async text => {
      operation = 'root_flush'
      const agent = handle.agent
      const turn = startProbeTurn(agent.session)
      const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
      // Exercise the real registered pre-step waterfall before persisting the
      // driver input. This is hook delivery evidence, not a model request.
      const decision = await agent.ctx.waterfall('agent/pre-step', {
        agent, messages: [message], turn, step: ordinal + 1, signal: AbortSignal.timeout(30000),
      }, async () => ({ kind: 'enter', messages: [message] }))
      assert.equal(decision.kind, 'enter')
      for (const entry of decision.messages) agent.session.append('user/message', entry, { surfaceOp: 'append' })
      assert.equal(await ctx.sessions.flush(handle.agent.session), true)
    }
    const call = async (name, args) => {
      const agent = handle.agent
      const callId = `native-${process.pid}-${agent.session.seq}-${++ordinal}`
      const coordinates = appendProbeToolCall(agent.session, createAssistantMessage, callId, name, args)
      operation = `tool_${name}`
      const result = await agent.ctx.tools.execute({ callId, name, arguments: args, agent, signal: AbortSignal.timeout(30000) })
      const code = value => typeof value === 'string' && /^[a-zA-Z0-9_]{1,80}$/.test(value) ? value : null
      lastTool = { name, is_error: result.isError, status: code(result.value?.status), reason_code: code(result.value?.reason_code), error_code: code(result.error?.info?.code),
        ...(['pwsh', 'bash'].includes(name) ? { terminal: shellTerminalFacts(result.value) } : {}),
        blockers: result.value?.open_items?.map(row => code(row.reason_code)).filter(Boolean).slice(0, 8) ?? [],
        rejections: result.value?.rejected_bindings?.map(row => code(row.reason_code ?? row.reason)).filter(Boolean).slice(0, 8) ?? [],
        item_shapes: result.value?.open_items?.slice(0, 8).map(row => ({ omitted: row.omitted === true, has_detail: typeof row.detail_id === 'string', has_template: !!row.binding_template, action: code(row.semantic_action) })) ?? [],
        evidence_shapes: result.value?.available_evidence?.slice(0, 10).map(row => ({ parse: code(row.parse_status), disposition: code(row.adapter_disposition), reason: code(row.reason_code), action: code(row.semantic_action) })) ?? [] }
      agent.session.append('tool/result', {
        ...coordinates,
        message: createToolResultMessage({ callId, content: result.content, isError: result.isError }),
        ...(result.error ? { error: result.error } : {}), ...(result.meta ? { meta: result.meta } : {}),
      }, { surfaceOp: 'append' })
      finishProbeToolCall(agent.session, coordinates)
      operation = 'tool_result_flush'
      assert.equal(await ctx.sessions.flush(agent.session), true)
      operation = 'tool_result_success'
      assert.equal(result.isError, false, name)
      if (name === 'context_guard_checkpoint') assert.ok(Buffer.byteLength(JSON.stringify(result.value)) <= 12288)
      return result.value
    }
    try {
      const runtime = runtimeRequire(config.runtimeRoot)
      ;({ createUserMessage, createToolResultMessage, createAssistantMessage } = await import(pathToFileURL(runtime.resolve('@deepseek-ai/dsh-llm')).href))
      const { SessionId } = await import(pathToFileURL(runtime.resolve('@deepseek-ai/dsh-session')).href)
      sessionId = SessionId(`guard-native-${config.nonce}`)
      if (existsSync(`${config.output}.complete`)) {
        mode = 'restart'
        const prior = JSON.parse(readFileSync(`${config.output}.complete`, 'utf8'))
        assert.equal(prior.nonce, config.nonce)
        assert.equal(prior.driver_sha256, driverDigest)
        clarifiedItemId = prior.clarified_item_id
        await check('persisted_restart_resume', async () => {
          handle = await createProbeAgent(ctx, sessionId, config.workRoot, true)
          assert.equal((await call('context_guard_checkpoint', { bindings: [] })).status, 'incomplete')
          assert.equal((await readProbeItem(call, await call('context_guard_checkpoint', { bindings: [], item_ids: [clarifiedItemId] }), clarifiedItemId)).status, 'passed')
        })
        return
      }
      handle = await createProbeAgent(ctx, sessionId, config.workRoot)
      await check('nonempty_test_certificate', async () => {
        assert.equal(handle.agent.session.snapshotEvents().filter(event => event.type === 'user/message').length, 0)
        await root('Run pnpm test.')
        const messages = handle.agent.session.snapshotEvents().filter(event => event.type === 'user/message')
        assert.equal(messages[0].data.source.plugin, 'context-guard')
        assert.equal(messages[0].data.content[0].text, 'Context Guard protocol boundary: v5.0.0')
        assert.equal(messages.filter(event => event.data.source.kind === 'user').length, 1)
        const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
        const fields = handle.agent.ctx.tools.get(shell, handle.agent)?.parameters?.properties ?? {}
        const terminal = await call(shell, { command: 'pnpm test', ...(fields.description ? { description: 'Run isolated deterministic acceptance test' } : {}) })
        operation = 'test_command_success'
        assertTestCommandSucceeded(terminal)
        const pending = await call('context_guard_checkpoint', { bindings: [] })
        operation = 'checkpoint_incomplete'
        assert.equal(pending.status, 'incomplete')
        const template = await readProbeTestBinding(call, pending)
        operation = 'binding_template_present'
        assert.ok(template)
        // Regression: exercise the installed prepare output through the actual
        // host callback, whose supported capability has no reasonCode.
        for (const semantic_action of ['test', 'commit', 'push']) {
          const prepared = await call('context_guard_prepare', { item_id: template.item_id, semantic_action })
          assert.equal(prepared.status, semantic_action === 'test' ? 'prepared' : 'incompatible')
          if (semantic_action === 'test') assert.equal(prepared.host_capability.status, 'supported')
          if (semantic_action !== 'test') {
            assert.equal(prepared.compatibility.item_action, 'test')
            assert.equal(prepared.evidence_input_contract, undefined)
          }
        }
        const missingResolution = await call('context_guard_evidence', { semantic_action: 'commit', evidence_role: 'resolution' })
        assert.equal(missingResolution.reason_code, 'resolution_input_missing')
        assert.ok(missingResolution.missing_fields.includes('command_manifest.planned_tool'))
        const missingState = await call('context_guard_evidence', { semantic_action: 'push', evidence_role: 'state' })
        assert.equal(missingState.reason_code, 'producer_reference_missing')
        assert.ok(missingState.missing_fields.includes('resolution_call_id'))
        const certificate = await call('context_guard_checkpoint', { bindings: [template] })
        operation = 'certificate_issued'
        assert.equal(certificate.status, 'certified')
        assert.ok(certificate.certificate)
      })
      await check('package_update_rebind_certificate', async () => {
        // Keep this gate ID stable; v5 now resolves verbatim clarification
        // atomically instead of requiring the legacy proposal transaction.
        await root('更新验收插件')
        const generic = await call('context_guard_checkpoint', { bindings: [] })
        const old = generic.open_items.find(row => row.reason_code === 'generic_run_non_certifiable')
        assert.ok(old)
        await root(`把更新验收插件明确为 apply package guard-acceptance-fixture@2.0.0 profile ${config.profile}`)
        const before = await call('context_guard_checkpoint', { bindings: [] })
        const clarified = before.open_items.find(row => row.semantic_action === 'apply')
        operation = 'package_source_items_present'
        assert.ok(clarified)
        const prior = await call('context_guard_checkpoint', { bindings: [], item_ids: [old.id] })
        assert.equal((await readProbeItem(call, prior, old.id)).status, 'superseded')
        clarifiedItemId = clarified.id
        const resolution = await call('context_guard_evidence', { semantic_action: 'apply', evidence_role: 'resolution',
          selector: { package_id: 'guard-acceptance-fixture', version: '2.0.0', profile: config.profile },
          command_manifest: { manifest_id: 'dsh.plugin_add_tgz.apply.v1', tgz_path: config.fixtureTgz } })
        assert.equal(resolution.status, 'supported')
        const resolutionCall = `native-${process.pid}-${ordinal}`
        const effect = await call('context_guard_action', { semantic_action: 'apply', resolution_call_id: resolutionCall,
          contract_item_id: clarified.id, contract_item_revision: clarified.revision,
          target_digest: resolution.target_digest })
        assert.equal(effect.status, 'completed')
        const effectCall = `native-${process.pid}-${ordinal}`
        for (const evidence_role of ['effect', 'state']) {
          assert.equal((await call('context_guard_evidence', { semantic_action: 'apply', evidence_role,
            resolution_call_id: resolutionCall, effect_call_id: effectCall })).status, 'supported')
        }
        const page = await call('context_guard_checkpoint', { bindings: [] })
        const binding = (await readProbeItem(call, page, clarified.id)).binding_template
        operation = 'package_binding_template_present'
        assert.ok(binding)
        const certificate = await call('context_guard_checkpoint', { bindings: [binding] })
        operation = 'package_certificate_issued'
        assert.equal(certificate.status, 'certified')
      })
      await check('generic_pending_and_rebind_no_gain_refusal', async () => {
        await root('更新演示插件并检查 GUI 效果')
        const pending = await call('context_guard_checkpoint', { bindings: [] })
        assert.equal(pending.status, 'incomplete')
        const item = pending.open_items.find(row => row.reason_code === 'generic_run_non_certifiable')
        assert.ok(item)
        // v0.5: splitting an already-generic requirement into identical
        // generic clauses is refused instead of demanding a confirmation
        // that cannot improve certification. The item stays pending.
        const refusal = await call('context_guard_rebind', { operation: 'propose', item_id: item.id, clauses: [item.text] })
        assert.equal(refusal.status, 'rejected')
        assert.equal(refusal.reason_code, 'no_certification_gain')
        assert.equal((await call('context_guard_checkpoint', { bindings: [] })).status, 'incomplete')
      })
      // 0.6.3 native incident checks: real host delivery and persisted tools;
      // no business mutation and no model request are performed here.
      failedCase = 'mixed_request_and_cross_repository'
      await root('Check whether an update exists and install the package.')
      let incidentPage = await call('context_guard_checkpoint', { bindings: [] })
      const incidentRows = await Promise.all(incidentPage.open_items.map(row => readProbeItem(call, incidentPage, row.id)))
      const incident = incidentRows.find(row => row.text?.includes('Check whether an update exists'))
      assert.ok(incident)
      assert.equal(incident.status, 'pending')
      const incidentPrepare = await call('context_guard_prepare', { item_id: incident.id, semantic_action: 'install' })
      assert.notEqual(incidentPrepare.compatibility.status, 'compatible')
      assert.equal(incidentPage.status, 'incomplete')
      const repositoryA = join(config.workRoot, 'repository-a')
      const repositoryB = join(config.workRoot, 'repository-b')
      await root(`提交仓库 ${repositoryA} 分支 main。`)
      await root(`提交仓库 ${repositoryB} 分支 main。提交。`)
      incidentPage = await call('context_guard_checkpoint', { bindings: [] })
      const repositoryRows = await Promise.all(incidentPage.open_items.map(row => readProbeItem(call, incidentPage, row.id)))
      const selectedB = repositoryRows.find(row => row.semantic_action === 'commit' && row.text?.includes(repositoryB))
      assert.ok(selectedB)
      assert.equal(selectedB.requested_target.repository, repositoryB)
      const wrongRepository = await call('context_guard_prepare', { item_id: selectedB.id, semantic_action: 'commit', requested_target: { repository: repositoryA, branch: 'main' } })
      assert.equal(wrongRepository.status, 'incompatible')
      assert.equal((await call('context_guard_checkpoint', { bindings: [] })).status, 'incomplete')
      await check('history_pagination_roundtrip', async () => {
        const page = await call('context_guard_checkpoint', { bindings: [], evidence_scope: 'history', limit: 1 })
        assert.ok(page.available_evidence.length > 0)
        if (page.pagination.available_evidence.next_cursor) {
          const next = await call('context_guard_checkpoint', { bindings: [], evidence_scope: 'history', limit: 1, cursor: page.pagination.available_evidence.next_cursor })
          assert.notEqual(next.available_evidence[0].id, page.available_evidence[0].id)
        }
      })
      await check('compact_and_persisted_resume', async () => {
        handle.agent.session.append('compaction/summary', { compactionId: 'native', summary: [], shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [], shadowedTokenCount: 0, provider: 'native-driver', model: 'none' })
        assert.equal(await ctx.sessions.flush(handle.agent.session), true)
        await handle.dispose()
        handle = await createProbeAgent(ctx, sessionId, config.workRoot, true)
        assert.equal((await readProbeItem(call, await call('context_guard_checkpoint', { bindings: [], item_ids: [clarifiedItemId] }), clarifiedItemId)).status, 'passed')
        assert.equal((await call('context_guard_checkpoint', { bindings: [] })).status, 'incomplete')
      })
      await check('qualified_pending_boundary', async () => {
        await root('等待用户选择后继续')
        const pending = await call('context_guard_checkpoint', { bindings: [] })
        const qualification = pending.available_qualifications.find(row => row.kind === 'root_explicit_wait')
        assert.ok(qualification)
        const boundary = await call('context_guard_boundary', { disposition: 'user_wait', qualification_kind: qualification.kind, qualification_ids: [qualification.id] })
        assert.equal(boundary.status, 'accepted')
        assert.equal((await call('context_guard_checkpoint', { bindings: [] })).status, 'incomplete')
      })
    } catch (error) {
      rows.push({ id: failedCase, status: 'failed', operation, last_tool: lastTool, error_code: /^[A-Z_]{1,60}$/.test(error?.code ?? '') ? error.code : 'PROBE_ASSERTION_FAILED' })
    } finally {
      if (handle) {
        try { await handle.dispose() } catch { rows.push({ id: 'agent_cleanup', status: 'failed' }) }
      }
      const result = { schema: 'dsh-native-host-probe/v1', nonce: config.nonce, pid: process.pid,
        mode, driver_sha256: driverDigest,
        status: rows.length === (mode === 'initial' ? 6 : 1) && rows.every(row => row.status === 'passed') ? 'passed' : 'failed',
        cases: rows, real_model_request: false }
      if (mode === 'initial' && result.status === 'passed') writeFileSync(`${config.output}.complete`, JSON.stringify({ nonce: config.nonce, driver_sha256: driverDigest, clarified_item_id: clarifiedItemId }))
      const output = `${config.output}.${process.pid}.json`
      writeFileSync(`${output}.tmp`, JSON.stringify(result))
      renameSync(`${output}.tmp`, output)
    }
  }), 'native acceptance readiness')
}
