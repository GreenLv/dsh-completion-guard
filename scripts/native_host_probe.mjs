/** Loaded only by native_acceptance.py in its disposable real DSH profile.
 * Drives the actual AgentRegistry, ToolRuntime and Session persistence without
 * a model request. It is not a synthetic replacement for those services. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

export const name = 'completion-guard-native-probe'
export const inject = ['agents', 'sessions', 'tools', 'sessionPersistence']

export function apply(ctx, config) {
  ctx.on('ready', async () => {
    const rows = []
    let handle
    const check = (id, fn) => fn().then(() => rows.push({ id, status: 'passed' }))
    const runtime = createRequire(join(config.runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    const { createUserMessage, createToolResultMessage } = await import(runtime.resolve('@deepseek-ai/dsh-llm'))
    const { SessionId } = await import(runtime.resolve('@deepseek-ai/dsh-session'))
    const sessionId = SessionId(`guard-native-${config.nonce}-${process.pid}`)
    let ordinal = 0
    const root = async text => {
      handle.agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      assert.equal(await ctx.sessions.flush(handle.agent.session), true)
    }
    const call = async (name, args) => {
      const agent = handle.agent
      const callId = `native-${++ordinal}`
      agent.session.append('tool/call', { turn: 1, step: ordinal, callId, name, arguments: JSON.stringify(args) })
      const result = await agent.ctx.tools.execute({ callId, name, arguments: args, agent, signal: AbortSignal.timeout(30000) })
      agent.session.append('tool/result', {
        turn: 1, step: ordinal,
        message: createToolResultMessage({ callId, content: result.content, isError: result.isError }),
        ...(result.error ? { error: result.error } : {}), ...(result.meta ? { meta: result.meta } : {}),
      }, { surfaceOp: 'append' })
      assert.equal(await ctx.sessions.flush(agent.session), true)
      assert.equal(result.isError, false, name)
      if (name === 'context_guard_checkpoint') assert.ok(Buffer.byteLength(JSON.stringify(result.value)) <= 12288)
      return result.value
    }
    try {
      handle = await ctx.agents.create({ sessionId, meta: { cwd: config.workRoot } })
      await check('nonempty_test_certificate', async () => {
        await root('Run pnpm test.')
        await call(process.platform === 'win32' ? 'pwsh' : 'bash', { command: 'pnpm test' })
        const pending = await call('context_guard_checkpoint', { bindings: [] })
        assert.equal(pending.status, 'incomplete')
        const template = pending.open_items.find(row => row.binding_template)?.binding_template
        assert.ok(template)
        const certificate = await call('context_guard_checkpoint', { bindings: [template] })
        assert.equal(certificate.status, 'certified')
        assert.ok(certificate.certificate)
      })
      await check('package_update_rebind_certificate', async () => {
        await root('更新验收插件')
        await root(`把更新验收插件明确为 apply package guard-acceptance-fixture@2.0.0 profile ${config.profile}`)
        const before = await call('context_guard_checkpoint', { bindings: [] })
        const old = before.open_items.find(row => row.reason_code === 'generic_run_non_certifiable')
        const clarified = before.open_items.find(row => row.semantic_action === 'apply')
        assert.ok(old && clarified)
        const proposed = await call('context_guard_rebind', { operation: 'propose', item_id: old.id,
          clauses: [old.text], clarification_item_ids: [clarified.id] })
        assert.equal(proposed.status, 'proposed')
        await root(`确认重绑定 ${proposed.proposal.id}`)
        const resolution = await call('context_guard_evidence', { semantic_action: 'apply', evidence_role: 'resolution',
          selector: { package_id: 'guard-acceptance-fixture', version: '2.0.0', profile: config.profile },
          command_manifest: { manifest_id: 'dsh.plugin_add_tgz.apply.v1', tgz_path: config.fixtureTgz } })
        assert.equal(resolution.status, 'supported')
        const resolutionCall = `native-${ordinal}`
        const effect = await call('context_guard_action', { semantic_action: 'apply', resolution_call_id: resolutionCall,
          contract_item_id: clarified.id, contract_item_revision: clarified.revision,
          target_digest: resolution.target_digest })
        assert.equal(effect.status, 'completed')
        const effectCall = `native-${ordinal}`
        for (const evidence_role of ['effect', 'state']) {
          assert.equal((await call('context_guard_evidence', { semantic_action: 'apply', evidence_role,
            resolution_call_id: resolutionCall, effect_call_id: effectCall })).status, 'supported')
        }
        const page = await call('context_guard_checkpoint', { bindings: [] })
        const binding = page.open_items.find(row => row.id === clarified.id)?.binding_template
        assert.ok(binding)
        assert.equal((await call('context_guard_checkpoint', { bindings: [binding] })).status, 'certified')
      })
      let proposalId
      await check('generic_pending_and_rebind_roundtrip', async () => {
        await root('更新演示插件并检查 GUI 效果')
        const pending = await call('context_guard_checkpoint', { bindings: [] })
        assert.equal(pending.status, 'incomplete')
        const item = pending.open_items.find(row => row.reason_code === 'generic_run_non_certifiable')
        assert.ok(item)
        const proposal = await call('context_guard_rebind', { operation: 'propose', item_id: item.id, clauses: [item.text] })
        assert.equal(proposal.status, 'proposed')
        proposalId = proposal.proposal.id
        await root(`确认重绑定 ${proposalId}`)
        assert.equal((await call('context_guard_rebind', { operation: 'query', proposal_id: proposalId })).status, 'confirmed')
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
        handle = await ctx.agents.resume({ resumeSessionId: sessionId })
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
    } catch {
      rows.push({ id: 'host_probe', status: 'failed' })
    } finally {
      if (handle) {
        try { await handle.dispose() } catch { rows.push({ id: 'agent_cleanup', status: 'failed' }) }
      }
      const result = { schema: 'dsh-native-host-probe/v1', nonce: config.nonce, pid: process.pid,
        driver_sha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),
        status: rows.length === 6 && rows.every(row => row.status === 'passed') ? 'passed' : 'failed',
        cases: rows, real_model_request: false }
      const output = `${config.output}.${process.pid}.json`
      writeFileSync(`${output}.tmp`, JSON.stringify(result))
      renameSync(`${output}.tmp`, output)
    }
  })
}
