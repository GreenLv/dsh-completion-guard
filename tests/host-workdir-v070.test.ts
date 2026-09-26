import { describe, expect, it } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { deriveProjection, PROTOCOL_V6_NOTICE } from '../src/domain/derive.js'
import { captureHostWorkdir, HOST_WORKDIR_PREFIX, hostWorkdirForCall, sourcedNamedTestRoot } from '../src/domain/host-workdir.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'
import { projectSessionCoreV2 } from '../src/core-v2/session.js'
import { registerPassiveHostWorkdirObserver } from '../src/runtime.js'
import { auditedDefaultWorkdirHost, auditedDefaultWorkdirProvider } from '../src/domain/host-resolver.js'

const host = { ...evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' }),
  auditedForegroundRenderers: ['bash' as const], digest: 'a1'.repeat(32) }

function scenario(options: { workdir?: string; policyRoot?: string; headerCwd?: string; command?: string } = {}) {
  const physical = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-host-workdir-')))
  const cwd = options.headerCwd ?? physical
  const id = SessionId('default-workdir-receipt')
  const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, isSeeded: false,
    id, createdAt: 1, cwd })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }],
    source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice', summary: 'v6' } }), { surfaceOp: 'append' })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `Run npm test in ${physical}.` }],
    source: { kind: 'user' } }), { surfaceOp: 'append' })
  const args = { command: options.command ?? 'npm test', ...(options.workdir ? { workdir: options.workdir } : {}) }
  const call = session.append('tool/call', { turn: 1, step: 1, callId: 'test-1' as never,
    name: 'bash', arguments: JSON.stringify(args) })
  const exec = { agent: { session }, callId: 'test-1', rootCallId: 'test-1', name: 'bash', arguments: args,
    signal: new AbortController().signal }
  const policy = { resolve: () => ({ sessionId: id, workspaceRoot: options.policyRoot ?? physical }) }
  const receipt = captureHostWorkdir(session, exec as never, host, policy, true)
  const appendReceipt = () => {
    if (receipt) session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${HOST_WORKDIR_PREFIX}${JSON.stringify(receipt)}` }],
      source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice', summary: 'call-time workdir' },
    }), { surfaceOp: 'append' })
  }
  const appendResult = () => session.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId: 'test-1' as never,
      content: [{ type: 'text', text: '> fixture@1.0.0 test\n> node test.cjs\n1 test passed' }], isError: false }),
  } as never, { surfaceOp: 'append' })
  const core = () => {
    const events = session.snapshotEvents() as never
    const projection = deriveProjection(events, { activation: 'always' },
      { cwd, sessionHeader: { version: SESSION_FORMAT_VERSION, id, createdAt: 1, seedLength: 0, delegationDepth: 0 } }, true, host).projection
    projection.durabilityWatermark = 'confirmed'
    return projectSessionCoreV2(events, projection)
  }
  return { physical, session, call, receipt, appendReceipt, appendResult, core,
    cleanup: () => rmSync(physical, { recursive: true, force: true }) }
}

describe('v0.7 call-time Host default-workdir observation', () => {
  it.runIf(Boolean(process.env.DSH_RUNTIME_ROOT))('attests the active rc.2 producer, policy and local executor bytes', async () => {
    const runtimeRoot = process.env.DSH_RUNTIME_ROOT!
    expect(auditedDefaultWorkdirHost(runtimeRoot, runtimeRoot, 'bash')).toBe(true)
    expect(auditedDefaultWorkdirHost(runtimeRoot, runtimeRoot, 'pwsh')).toBe(true)
    expect(auditedDefaultWorkdirHost('/no-such-runtime', '/no-such-profile', 'bash')).toBe(false)
    const provider = async (name: string, exported: string) => {
      const store = join(runtimeRoot, 'node_modules', '.pnpm')
      const entry = readdirSync(store).find((value) => value.startsWith(`@deepseek-ai+${name}@0.1.7-rc.2_`))!
      const path = join(store, entry, 'node_modules', '@deepseek-ai', name, 'lib', 'index.js')
      const module = await import(pathToFileURL(path).href) as Record<string, { prototype: object }>
      return Object.create(module[exported]!.prototype) as object
    }
    const bash = await provider('dsh-bash-sandbox', 'SandboxBashExecutor')
    const pwsh = await provider('dsh-pwsh-local', 'PwshLocalExecutor')
    const policyProvider = await provider('dsh-sandbox-policy', 'SandboxPolicyService')
    expect(await auditedDefaultWorkdirProvider(runtimeRoot, runtimeRoot, 'bash', bash, policyProvider)).toBe(true)
    expect(await auditedDefaultWorkdirProvider(runtimeRoot, runtimeRoot, 'pwsh', pwsh)).toBe(true)
    const scoped = new Context()
    scoped.provide('shell', bash as never)
    scoped.provide('sandboxPolicy', policyProvider as never)
    expect(await auditedDefaultWorkdirProvider(runtimeRoot, runtimeRoot, 'bash',
      scoped.get('shell'), scoped.get('sandboxPolicy'))).toBe(true)
    expect(await auditedDefaultWorkdirProvider(runtimeRoot, runtimeRoot, 'bash', bash,
      { resolve: () => ({ workspaceRoot: '/same-path' }), constructor: { name: 'SandboxPolicyService' } })).toBe(false)
    expect(await auditedDefaultWorkdirProvider(runtimeRoot, runtimeRoot, 'bash',
      Object.create({ constructor: { name: 'SandboxBashExecutor' } }))).toBe(false)
    expect(await auditedDefaultWorkdirProvider('/no-such-runtime', '/no-such-profile', 'bash', bash)).toBe(false)
    // A second reachable copy is ambiguous; an active same-version provider
    // whose implementation bytes changed is never rescued by the first root.
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-second-graph-')))
    try {
      const names = ['dsh-tool-bash', 'dsh-shell', 'dsh-sandbox-policy', 'dsh-sandbox',
        'dsh-bash-local', 'dsh-bash-sandbox']
      const dependencies: Record<string, string> = {}
      const packages: Record<string, { url: string; dependencies: Record<string, string> }> = {
        '.': { url: '..', dependencies },
      }
      const sourceStore = join(runtimeRoot, 'node_modules', '.pnpm')
      for (const name of names) {
        const slug = readdirSync(sourceStore).find((value) => value.startsWith(`@deepseek-ai+${name}@0.1.7-rc.2_`))!
        const source = join(sourceStore, slug, 'node_modules', '@deepseek-ai', name)
        const destination = join(other, 'node_modules', '.pnpm', slug, 'node_modules', '@deepseek-ai', name)
        mkdirSync(join(destination, 'lib'), { recursive: true })
        copyFileSync(join(source, 'package.json'), join(destination, 'package.json'))
        copyFileSync(join(source, 'lib', 'index.js'), join(destination, 'lib', 'index.js'))
        const id = `@deepseek-ai/${name}@0.1.7-rc.2(test)`
        dependencies[`@deepseek-ai/${name}`] = id
        packages[id] = { url: `./.pnpm/${slug}/node_modules/@deepseek-ai/${name}`, dependencies: {} }
      }
      writeFileSync(join(other, 'node_modules', '.package-map.json'), JSON.stringify({ packages }))
      expect(auditedDefaultWorkdirHost(runtimeRoot, other, 'bash')).toBe(true)
      expect(await auditedDefaultWorkdirProvider(runtimeRoot, other, 'bash', bash, policyProvider)).toBe(false)
      const policy = join(other, 'node_modules', '.pnpm',
        readdirSync(sourceStore).find((value) => value.startsWith('@deepseek-ai+dsh-sandbox-policy@0.1.7-rc.2_'))!,
        'node_modules', '@deepseek-ai', 'dsh-sandbox-policy', 'lib', 'index.js')
      writeFileSync(policy, `${readFileSync(policy, 'utf8')}\n// changed installed policy bytes`)
      expect(auditedDefaultWorkdirHost(runtimeRoot, other, 'bash')).toBe(false)
    } finally { rmSync(other, { recursive: true, force: true }) }
  })
  it('certifies a matching named test without asking for a Guard readiness tool, and survives replay', () => {
    const s = scenario()
    try {
      expect(s.receipt).toMatchObject({ toolName: 'bash', effectiveCwd: s.physical, policySource: 'bash-policy' })
      s.appendResult()
      s.appendReceipt()
      const first = s.core()!
      expect(first.certifiable).toBe(true)
      expect(Object.values(first.predicates as Record<string, unknown>)).toContain('satisfied')
      expect(s.core()).toEqual(first)
    } finally { s.cleanup() }
  })

  it('does not retrospectively grant old calls that lack a call-time receipt', () => {
    const s = scenario()
    try {
      s.appendResult()
      expect(s.core()?.certifiable).toBe(false)
    } finally { s.cleanup() }
  })

  it('keeps the original task root when a later information interlude precedes the Host call', () => {
    const physical = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-cross-turn-workdir-')))
    try {
      const id = SessionId('cross-turn-workdir')
      const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION,
        isSeeded: false, id, createdAt: 1, cwd: physical })
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }],
        source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice', summary: 'v6' } }), { surfaceOp: 'append' })
      session.append('turn/start', { turn: 1 })
      const task = session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `Run npm test in ${physical}.` }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      session.append('turn/start', { turn: 2 })
      const interlude = session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'What is the current status?' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      const args = { command: 'npm test' }
      const call = session.append('tool/call', { turn: 2, step: 1, callId: 'cross-turn-test' as never,
        name: 'bash', arguments: JSON.stringify(args) })
      const exec = { agent: { session }, callId: 'cross-turn-test', rootCallId: 'cross-turn-test',
        name: 'bash', arguments: args, signal: new AbortController().signal }
      const policy = { resolve: () => ({ sessionId: id, workspaceRoot: physical }) }
      expect(captureHostWorkdir(session, exec as never, host, policy, true)?.rootSeq).toBe(interlude.seq)
      expect(captureHostWorkdir(session, exec as never, host, policy, true, null)).toBeUndefined()
      const before = deriveProjection(session.snapshotEvents() as never, { activation: 'always' },
        { cwd: physical, sessionHeader: { version: SESSION_FORMAT_VERSION, id, createdAt: 1, seedLength: 0, delegationDepth: 0 } },
        true, host).projection
      expect(sourcedNamedTestRoot(before, session, args)).toBe(task.seq)
      const receipt = captureHostWorkdir(session, exec as never, host, policy, true,
        sourcedNamedTestRoot(before, session, args))
      expect(receipt?.rootSeq).toBe(task.seq)
      const result = session.append('tool/result', { turn: 2, step: 1,
        message: createToolResultMessage({ callId: 'cross-turn-test' as never,
          content: [{ type: 'text', text: '1 test passed' }], isError: false }),
      } as never, { surfaceOp: 'append' })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `${HOST_WORKDIR_PREFIX}${JSON.stringify(receipt)}` }],
        source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice', summary: 'call-time workdir' },
      }), { surfaceOp: 'append' })
      const events = session.snapshotEvents() as never
      const projection = deriveProjection(events, { activation: 'always' },
        { cwd: physical, sessionHeader: { version: SESSION_FORMAT_VERSION, id, createdAt: 1, seedLength: 0, delegationDepth: 0 } },
        true, host).projection
      expect(hostWorkdirForCall(events, call as never, result as never, task.seq,
        projection.sessionRefDigest, projection.hostLockDigest, physical)).toBe(physical)
      expect(hostWorkdirForCall(events, call as never, result as never, interlude.seq,
        projection.sessionRefDigest, projection.hostLockDigest, physical)).toBeUndefined()
    } finally { rmSync(physical, { recursive: true, force: true }) }
  })

  it('refuses an explicit different workdir, a changed policy root, and a missing physical header', () => {
    for (const options of [{ workdir: '/somewhere-else' }, { policyRoot: '/somewhere-else' },
      { headerCwd: '/missing-session-header-root' }]) {
      const s = scenario(options)
      try {
        expect(s.receipt).toBeUndefined()
        s.appendResult()
        expect(s.core()?.certifiable).toBe(false)
      } finally { s.cleanup() }
    }
  })

  it('rejects changed call identity and a legacy receipt inside the call/result interval', () => {
    const s = scenario()
    try {
      const result = s.appendResult()
      s.appendReceipt()
      const events = s.session.snapshotEvents() as never
      const projection = deriveProjection(events, { activation: 'always' },
        { cwd: s.physical, sessionHeader: { version: SESSION_FORMAT_VERSION, id: SessionId('default-workdir-receipt'), createdAt: 1,
          seedLength: 0, delegationDepth: 0 } }, true, host).projection
      expect(hostWorkdirForCall(events, s.call as never, result as never, 2, projection.sessionRefDigest,
        projection.hostLockDigest, s.physical)).toBe(s.physical)
      expect(hostWorkdirForCall(events, s.call as never, result as never, 999, projection.sessionRefDigest,
        projection.hostLockDigest, s.physical)).toBeUndefined()
      expect(hostWorkdirForCall(events, s.call as never, result as never, 2, projection.sessionRefDigest,
        'ff'.repeat(32), s.physical)).toBeUndefined()
      const fakeUser = { ...(events[5] as Record<string, unknown>), data: { ...(events[5] as { data: Record<string, unknown> }).data,
        source: { kind: 'user' } } }
      expect(hostWorkdirForCall([events[0], events[1], events[2], events[3], events[4], fakeUser] as never,
        s.call as never, result as never, 2, projection.sessionRefDigest,
        projection.hostLockDigest, s.physical)).toBeUndefined()
      const legacy = scenario()
      try {
        legacy.appendReceipt()
        const legacyResult = legacy.appendResult()
        const legacyEvents = legacy.session.snapshotEvents() as never
        const legacyProjection = deriveProjection(legacyEvents, { activation: 'always' },
          { cwd: legacy.physical }, true, host).projection
        expect(hostWorkdirForCall(legacyEvents, legacy.call as never, legacyResult as never, 2,
          legacyProjection.sessionRefDigest, legacyProjection.hostLockDigest, legacy.physical)).toBeUndefined()
      } finally { legacy.cleanup() }
    } finally { s.cleanup() }
  })

  it('does not use duplicate plugin notices or a later Host lock to certify an earlier call', () => {
    const s = scenario()
    try {
      s.appendResult()
      s.appendReceipt()
      s.appendReceipt()
      expect(s.core()?.certifiable).toBe(false)
    } finally { s.cleanup() }
    const stable = scenario()
    try {
      stable.appendResult()
      stable.appendReceipt()
      const restored = Session.fromRestore(stable.session.id, structuredClone(stable.session.snapshotEvents()),
        structuredClone(stable.session.header), SessionLogOffset(0), 'detached')
      const events = restored.snapshotEvents() as never
      const original = deriveProjection(events, { activation: 'always' },
        { cwd: stable.physical, sessionHeader: { version: SESSION_FORMAT_VERSION, id: restored.id, createdAt: 1,
          seedLength: 0, delegationDepth: 0 } }, true, host).projection
      original.durabilityWatermark = 'confirmed'
      expect(projectSessionCoreV2(events, original)?.certifiable).toBe(true)
      const drifted = deriveProjection(events, { activation: 'always' },
        { cwd: stable.physical, sessionHeader: { version: SESSION_FORMAT_VERSION, id: restored.id, createdAt: 1,
          seedLength: 0, delegationDepth: 0 } }, true,
        { ...host, digest: 'bb'.repeat(32) }).projection
      drifted.durabilityWatermark = 'confirmed'
      expect(projectSessionCoreV2(events, drifted)?.certifiable).toBe(false)
    } finally { stable.cleanup() }
  })

  it('does not confuse a concurrent call notice with this call or accept a duplicate for this call', () => {
    const s = scenario()
    try {
      s.appendResult()
      s.appendReceipt()
      s.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `${HOST_WORKDIR_PREFIX}${JSON.stringify({ ...s.receipt, callId: 'other-call' })}` }],
        source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice', summary: 'other call' },
      }), { surfaceOp: 'append' })
      expect(s.core()?.certifiable).toBe(true)
    } finally { s.cleanup() }
  })

  it('refuses a lexical filesystem alias and an unaudited producer before dispatch', () => {
    const s = scenario()
    const alias = `${s.physical}-alias`
    try {
      symlinkSync(s.physical, alias)
      const aliased = scenario({ headerCwd: alias })
      try { expect(aliased.receipt).toBeUndefined() } finally { aliased.cleanup() }
      const exec = { agent: { session: s.session }, callId: 'test-1', rootCallId: 'test-1', name: 'bash',
        arguments: { command: 'npm test' }, signal: new AbortController().signal }
      const policy = { resolve: () => ({ sessionId: s.session.id, workspaceRoot: s.physical }) }
      expect(captureHostWorkdir(s.session, exec as never,
        { ...host, auditedForegroundRenderers: [] }, policy, true)).toBeUndefined()
      expect(captureHostWorkdir(s.session, exec as never, host, undefined, true)).toBeUndefined()
      expect(captureHostWorkdir(s.session, exec as never, host, policy, false)).toBeUndefined()
    } finally { unlinkSync(alias); s.cleanup() }
  })

  it('records the same passive notice through the real Cordis tool waterfall', async () => {
    const s = scenario()
    try {
      const ctx = new Context()
      new SystemPrompt(ctx, {})
      const runtime = new ToolRuntime(ctx)
      ctx.provide('sandboxPolicy', { resolve: ({ session }: { session: Session }) =>
        ({ sessionId: session.id, workspaceRoot: s.physical }) } as never)
      const agent = { session: s.session, ctx } as never
      registerPassiveHostWorkdirObserver(agent, () => host, () => true, () => 2)
      runtime.register(defineTool({
        name: 'bash', description: 'isolated read-only registry probe',
        parameters: { command: { type: 'string', required: true } },
        output: { schema: { type: 'object', additionalProperties: false,
          properties: { status: { type: 'string', required: true } } },
        render: () => [{ type: 'text', text: 'ok' }] },
        execute: async () => ({ status: 'ok' }),
      }))
      const response = await runtime.execute({ agent, callId: 'test-1' as never,
        name: 'bash', arguments: { command: 'npm test' }, signal: new AbortController().signal })
      expect(response.isError).toBe(false)
      expect(response.additionalContexts).toHaveLength(1)
      expect(s.session.snapshotEvents().filter((event) => event.type === 'user/message'
        && String((event.data as { content?: ReadonlyArray<{ text?: string }> }).content?.[0]?.text ?? '').startsWith(HOST_WORKDIR_PREFIX))).toHaveLength(0)
      s.appendResult()
      s.session.append('user/message', response.additionalContexts![0]!, { surfaceOp: 'append' })
      expect(s.core()?.certifiable).toBe(true)
    } finally { s.cleanup() }
  })

  it('defers real parallel receipts until every result, including an earlier failure', async () => {
    const physical = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-host-batch-')))
    const id = SessionId('host-workdir-batch-order')
    const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, isSeeded: false,
      id, createdAt: 1, cwd: physical })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }],
      source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice', summary: 'v6' } }), { surfaceOp: 'append' })
    session.append('turn/start', { turn: 1 })
    const root = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `Run npm test in ${physical}.` }],
      source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
      source: { provider: 'fixture', model: 'fixture' }, content: [
        { type: 'tool-call', id: 'call-a' as never, name: 'bash', arguments: '{"command":"npm test"}' },
        { type: 'tool-call', id: 'call-b' as never, name: 'bash', arguments: '{"command":"pnpm test"}' },
      ],
    }) } as never, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId: 'call-a' as never, name: 'bash', arguments: '{"command":"npm test"}' })
    session.append('tool/call', { turn: 1, step: 1, callId: 'call-b' as never, name: 'bash', arguments: '{"command":"pnpm test"}' })
    try {
      const ctx = new Context(); new SystemPrompt(ctx, {}); const runtime = new ToolRuntime(ctx)
      ctx.provide('sandboxPolicy', { resolve: () => ({ sessionId: id, workspaceRoot: physical }) } as never)
      const agent = { session, ctx } as never
      registerPassiveHostWorkdirObserver(agent, () => host, () => true, () => root.seq)
      let failA!: () => void
      const waitA = new Promise<void>((resolve) => { failA = resolve })
      runtime.register(defineTool({ name: 'bash', description: 'parallel host fixture',
        parameters: { command: { type: 'string', required: true } },
        output: { schema: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', required: true } } },
          render: () => [{ type: 'text', text: 'done' }] },
        execute: async ({ command }) => { if (command === 'npm test') { await waitA; throw new Error('fixture failure') }; return { status: 'ok' } },
      }))
      const exec = (callId: string, command: string) => runtime.execute({ agent, callId: callId as never,
        name: 'bash', arguments: { command }, signal: new AbortController().signal })
      const pendingA = exec('call-a', 'npm test')
      const responseB = await exec('call-b', 'pnpm test')
      expect(session.snapshotEvents().some((event) => event.type === 'user/message'
        && JSON.stringify(event.data).includes(HOST_WORKDIR_PREFIX))).toBe(false)
      failA()
      const responseA = await pendingA
      expect(responseA.isError).toBe(true); expect(responseB.isError).toBe(false)
      for (const [callId, response] of [['call-a', responseA], ['call-b', responseB]] as const) session.append('tool/result', {
        turn: 1, step: 1, message: createToolResultMessage({ callId: callId as never,
          content: [{ type: 'text', text: response.isError ? 'failed' : 'ok' }], isError: response.isError }),
      } as never, { surfaceOp: 'append' })
      for (const response of [responseA, responseB]) for (const context of response.additionalContexts ?? []) {
        session.append('user/message', context, { surfaceOp: 'append' })
      }
      const messages = session.deriveMessages()
      expect(messages.slice(-4).map((message) => message.role)).toEqual(['tool', 'tool', 'user', 'user'])
      for (const [callId, response] of [['call-a', responseA], ['call-b', responseB]] as const) {
        const text = (response.additionalContexts?.[0]?.content[0] as { text?: string } | undefined)?.text ?? ''
        const receipt = JSON.parse(text.slice(HOST_WORKDIR_PREFIX.length))
        expect(receipt).toMatchObject({ callId, effectiveCwd: physical, rootSeq: root.seq })
      }
    } finally { rmSync(physical, { recursive: true, force: true }) }
  })

  it('leaves an ordinary tool host without the observation hook usable and uncredited', () => {
    const s = scenario()
    try {
      expect(() => registerPassiveHostWorkdirObserver({ session: s.session, ctx: {} } as never,
        () => host, () => true, () => 2)).not.toThrow()
      s.appendResult()
      expect(s.core()?.certifiable).toBe(false)
    } finally { s.cleanup() }
  })
})
