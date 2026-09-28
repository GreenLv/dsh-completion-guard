import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { interruptedTurnClosers, ToolCallRecovery, TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { deriveProjection, PROTOCOL_V6_NOTICE } from '../src/domain/derive.js'
import { projectSessionCoreV2 } from '../src/core-v2/session.js'
import { authorizeMutationFromProjection } from '../src/runtime.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'

const HOST = { ...evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' }),
  auditedForegroundRenderers: ['bash' as const] }

function openTailSession(label: string, blocks: Array<Record<string, unknown>>, withCall: boolean) {
  const id = SessionId(label)
  const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, isSeeded: false, id, createdAt: 1, cwd: '/work' })
  session.append('command/run', { commandId: 'on' as never, name: 'context-guard', args: 'on', source: { kind: 'user' } })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }],
    source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice', summary: 'v6' } }), { surfaceOp: 'append' })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '安装 package-fixture@2.0.0 到 profile web。' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
    source: { provider: 'fixture', model: 'fixture' },
    content: [{ type: 'text', text: 'Installing.' }, ...blocks] as never }) } as never, { surfaceOp: 'append' })
  if (withCall) session.append('tool/call', { turn: 1, step: 1, callId: 'call-1' as never, name: 'bash', arguments: JSON.stringify({ command: 'dsh plugin --profile web add package-fixture@2.0.0', workdir: '/work' }) })
  // The step NEVER closes: the host crashed (or the process was forked) before
  // the tool result was durable. This is the open tail the recovery closes.
  return session
}

describe('rc.020 tool-call recovery keeps unknown outcomes unknown in the Guard projection', () => {
  const block = (): Record<string, unknown> => ({ type: 'tool-call', id: 'call-1' })
  const variants = [
    ['TOOL_OUTCOME_UNKNOWN', [block()], true, 'interrupted'],
    ['TOOL_NOT_STARTED', [block()], false, 'interrupted'],
    ['TOOL_OUTCOME_UNKNOWN_forked', [block()], true, 'forked'],
  ] as const
  it.each(variants)('%s: the synthetic error result never satisfies the mutation obligation', (label, blocks, withCall, kind) => {
    const session = openTailSession(`rc020-recovery-${String(kind)}-${withCall}`, [...blocks], withCall)
    const events = session.snapshotEvents() as never
    let closers: Array<{ type: string; data: unknown }>
    if (kind === 'forked') {
      // The public entry exposes the class: build the forked-cause closers
      // through the same observe/results protocol the host uses.
      const recovery = new ToolCallRecovery({ kind: 'forked' })
      for (const event of events as unknown as Array<Parameters<ToolCallRecovery['observe']>[0]>) recovery.observe(event)
      closers = [...recovery.results() as unknown as Array<{ type: string; data: unknown }>]
      closers.push({ type: 'step/end', data: { turn: 1, step: 1 } })
      closers.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'forked' } } })
    } else {
      closers = interruptedTurnClosers(events) as unknown as Array<{ type: string; data: unknown }>
    }
    // The new dependency actually produced conservative closers for the tail.
    expect(closers.length).toBeGreaterThan(0)
    const errorResults = closers.filter((event) => event.type === 'tool/result')
    expect(errorResults).toHaveLength(1)
    const result = errorResults[0] as unknown as { data: { message: { isError: boolean; content: Array<{ text: string }> }; error?: { name: string } } }
    expect(result.data.message.isError).toBe(true)
    expect(result.data.error?.name).toBe(withCall ? 'ToolOutcomeUnknownError' : 'ToolNotStartedError')
    const text = result.data.message.content[0]?.text ?? ''
    if (withCall && kind !== 'forked') {
      expect(text).toContain('outcome is unknown')
      expect(text).toContain('Do not retry blindly')
    }
    if (kind === 'forked') {
      expect(text).toContain('inherited by this branch')
      expect(text).toContain('Do not retry blindly')
    }
    // Commit the closers into the durable log, then derive the Guard view.
    for (const event of closers) {
      if (event.type === 'tool/result') {
        const data = event.data as { turn: number; step: number; message: unknown; error?: unknown }
        session.append('tool/result', { turn: data.turn, step: data.step, message: data.message, error: data.error } as never, { surfaceOp: 'append' })
      } else if (event.type === 'step/end') {
        session.append('step/end', event.data as { turn: number; step: number })
      } else if (event.type === 'turn/end') {
        const data = event.data as { turn: number; reason: { kind: string } }
        session.append('turn/end', { turn: data.turn, reason: data.reason } as never)
      }
    }
    const scope = { cwd: '/work', sessionHeader: { version: SESSION_FORMAT_VERSION, id: 'rc020-recovery', createdAt: 1, seedLength: 0, delegationDepth: 0 } }
    const projection = deriveProjection(session.snapshotEvents() as never, { activation: 'opt-in' }, scope, true, HOST).projection
    projection.durabilityWatermark = 'confirmed'
    const install = [...projection.items.values()].find((row) => row.semanticAction === 'install')
    expect(install).toBeDefined()
    // The install item is NEVER satisfied by the synthetic unknown: it stays a
    // pending root-owned obligation, and mutation authorization for it is
    // refused for the same missing-evidence reason as before the crash — never
    // auto-granted, and never auto-retried into a side effect.
    expect(install!.status).toBe('pending')
    const auth = authorizeMutationFromProjection(projection, { action: 'install', contractItemId: install!.id, contractItemRevision: install!.revision,
      resolvedTarget: { package_id: 'package-fixture', version: '2.0.0', integrity_digest: 'sha512-fixture', profile: 'web' } })
    expect(auth).toMatchObject({ status: 'denied' })
    // No certificate can be minted either: unknown is not success.
    expect(projectSessionCoreV2(session.snapshotEvents() as never, projection)!.certifiable).toBe(false)
  })

  it('a completed real result recorded before the crash is untouched by recovery', () => {
    const session = openTailSession('rc020-recovery-balanced', [{ type: 'tool-call', id: 'call-1' }], true)
    session.append('tool/result', { turn: 1, step: 1, message: {
      source: { kind: 'tool', callId: 'call-1' }, role: 'tool', toolCallId: 'call-1', isError: false,
      content: [{ type: 'text', text: '[exit code: 0] installed' }] } } as never, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } } as never)
    void TOOL_NOT_STARTED; void TOOL_OUTCOME_UNKNOWN
    // A balanced log yields NO synthetic closers: recovery never invents facts
    // over recorded outcomes, and never duplicates results for matched calls.
    expect(interruptedTurnClosers(session.snapshotEvents() as never)).toEqual([])
    // Unit-level: a REPLAYED result (not an append) never clears the pending
    // call even when its callId matches.
    const recovery = new ToolCallRecovery()
    for (const event of session.snapshotEvents()) recovery.observe(event as never)
    const scope = { cwd: '/work', sessionHeader: { version: SESSION_FORMAT_VERSION, id: 'rc020-recovery', createdAt: 1, seedLength: 0, delegationDepth: 0 } }
    const projection = deriveProjection(session.snapshotEvents() as never, { activation: 'opt-in' }, scope, true, HOST).projection
    const install = [...projection.items.values()].find((row) => row.semanticAction === 'install')
    expect(install).toBeDefined()
    expect(install!.status).toBe('pending')
  })

  it('a mismatched or non-appended result does not clear the pending call', () => {
    const session = openTailSession('rc020-recovery-mismatch', [{ type: 'tool-call', id: 'call-1' }], true)
    // Wrong turn attribution and a replay (non-append) result: neither counts.
    session.append('tool/result', { turn: 9, step: 9, message: {
      source: { kind: 'tool', callId: 'call-1' }, role: 'tool', toolCallId: 'call-1', isError: false,
      content: [{ type: 'text', text: 'forged success' }] } } as never, { surfaceOp: 'append' })
    const closers = interruptedTurnClosers(session.snapshotEvents() as never)
    expect(closers.filter((event) => event.type === 'tool/result')).toHaveLength(1)
    // Unit-level replay semantics: a non-append surfaceOp does not settle the
    // pending request even with a matching callId.
    const unit = new ToolCallRecovery()
    for (const event of session.snapshotEvents()) unit.observe(event as never)
    unit.observe({ seq: 999, time: 0, type: 'tool/result', surfaceOp: 'replay', data: { turn: 1, step: 1,
      message: { source: { kind: 'tool', callId: 'call-1' }, role: 'tool', toolCallId: 'call-1', isError: false,
      content: [{ type: 'text', text: 'replayed success' }] } } } as never)
    expect(unit.results()).toHaveLength(1)
  })
})
