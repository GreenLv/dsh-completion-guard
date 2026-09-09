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

/** Resolve rows folded by the public checkpoint response budget. */
export async function readProbeItem(call, page, itemId) {
  const row = page.open_items.find(item => item.id === itemId)
  assert.ok(row)
  if (!row.omitted) return row
  let offset = 0
  let snapshot
  let text = ''
  for (let count = 0; count < 128; count++) {
    const detail = await call('context_guard_checkpoint', { bindings: [], detail_id: row.detail_id,
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
    let createUserMessage, createToolResultMessage, sessionId
    let proposalId
    const driverDigest = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex')
    const check = async (id, fn) => {
      failedCase = id
      await fn()
      rows.push({ id, status: 'passed' })
    }
    let ordinal = 0
    const root = async text => {
      operation = 'root_flush'
      handle.agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      assert.equal(await ctx.sessions.flush(handle.agent.session), true)
    }
    const call = async (name, args) => {
      const agent = handle.agent
      const callId = `native-${process.pid}-${++ordinal}`
      agent.session.append('tool/call', { turn: 1, step: ordinal, callId, name, arguments: JSON.stringify(args) })
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
        turn: 1, step: ordinal,
        message: createToolResultMessage({ callId, content: result.content, isError: result.isError }),
        ...(result.error ? { error: result.error } : {}), ...(result.meta ? { meta: result.meta } : {}),
      }, { surfaceOp: 'append' })
      operation = 'tool_result_flush'
      assert.equal(await ctx.sessions.flush(agent.session), true)
      operation = 'tool_result_success'
      assert.equal(result.isError, false, name)
      if (name === 'context_guard_checkpoint') assert.ok(Buffer.byteLength(JSON.stringify(result.value)) <= 12288)
      return result.value
    }
    try {
      const runtime = runtimeRequire(config.runtimeRoot)
      ;({ createUserMessage, createToolResultMessage } = await import(pathToFileURL(runtime.resolve('@deepseek-ai/dsh-llm')).href))
      const { SessionId } = await import(pathToFileURL(runtime.resolve('@deepseek-ai/dsh-session')).href)
      sessionId = SessionId(`guard-native-${config.nonce}`)
      if (existsSync(`${config.output}.complete`)) {
        mode = 'restart'
        const prior = JSON.parse(readFileSync(`${config.output}.complete`, 'utf8'))
        assert.equal(prior.nonce, config.nonce)
        assert.equal(prior.driver_sha256, driverDigest)
        proposalId = prior.proposal_id
        await check('persisted_restart_resume', async () => {
          handle = await createProbeAgent(ctx, sessionId, config.workRoot, true)
          assert.equal((await call('context_guard_checkpoint', { bindings: [] })).status, 'incomplete')
          assert.equal((await call('context_guard_rebind', { operation: 'query', proposal_id: proposalId })).status, 'confirmed')
        })
        return
      }
      handle = await createProbeAgent(ctx, sessionId, config.workRoot)
      await check('nonempty_test_certificate', async () => {
        await root('Run pnpm test.')
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
        const certificate = await call('context_guard_checkpoint', { bindings: [template] })
        operation = 'certificate_issued'
        assert.equal(certificate.status, 'certified')
        assert.ok(certificate.certificate)
      })
      await check('package_update_rebind_certificate', async () => {
        await root('更新验收插件')
        await root(`把更新验收插件明确为 apply package guard-acceptance-fixture@2.0.0 profile ${config.profile}`)
        const before = await call('context_guard_checkpoint', { bindings: [] })
        const old = before.open_items.find(row => row.reason_code === 'generic_run_non_certifiable')
        const clarified = before.open_items.find(row => row.semantic_action === 'apply')
        operation = 'package_source_items_present'
        assert.ok(old && clarified)
        const proposed = await call('context_guard_rebind', { operation: 'propose', item_id: old.id,
          clauses: [old.text], clarification_item_ids: [clarified.id] })
        assert.equal(proposed.status, 'proposed')
        // v0.5 confirmation transaction: control line first, trailing
        // explanation request keeps its conversational meaning.
        await root(`确认重绑定 ${proposed.proposal.id}\n\n这个提案是什么意思？请简单解释。`)
        proposalId = proposed.proposal.id
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
        assert.equal((await call('context_guard_rebind', { operation: 'query', proposal_id: proposalId })).status, 'confirmed')
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
      if (mode === 'initial' && result.status === 'passed') writeFileSync(`${config.output}.complete`, JSON.stringify({ nonce: config.nonce, driver_sha256: driverDigest, proposal_id: proposalId }))
      const output = `${config.output}.${process.pid}.json`
      writeFileSync(`${output}.tmp`, JSON.stringify(result))
      renameSync(`${output}.tmp`, output)
    }
  }), 'native acceptance readiness')
}
