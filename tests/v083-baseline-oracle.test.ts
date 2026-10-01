import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { deriveProjection as candidateDerive, PROTOCOL_V6_NOTICE } from '../src/domain/derive.js'
import { projectSessionCoreV2 as candidateCore } from '../src/core-v2/session.js'
import { deriveProjection as baselineDerive } from './helpers/baseline-oracle/derive.js'
import { projectSessionCoreV2 as baselineCore } from './helpers/baseline-oracle/session-v2.js'
import { snapshotSessionEvents } from '../src/domain/session-events.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'

// CG-083-V1 INDEPENDENT ORACLE: the candidate fold and core/v2 adapter are
// compared against the FROZEN 0.8.2 implementation (tests/fixtures/baseline-
// oracle, exact snapshot of commit 913a4c7) — not against the candidate with
// a flag flipped. The fixture family covers the paths the optimization
// touches with a REAL session header (so the root-locator cache is active),
// rebind proposal/confirmation, observer methods, trusted deliveries,
// readiness and readback evidence, boundaries, duplicates, prohibitions and
// failure/unknown results — and every event prefix.

const HOST = evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' })
const HEADER = { version: SESSION_FORMAT_VERSION, id: 'oracle', createdAt: 1, seedLength: 0, delegationDepth: 0 } as const

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => {
    if (entry instanceof Map) return { __map: [...entry.entries()].map(([k, v]) => [String(k), canonical(v)]) }
    if (entry instanceof Set) return { __set: [...entry.values()].map((v) => canonical(v)).sort() }
    return entry
  }, 1)
}

type Append = (type: string, data: unknown, surface?: boolean) => void

function makeSession(id: string): { session: Session; append: Append } {
  const session = Session.create(SessionId(id), undefined, {
    version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId(id), createdAt: 1, cwd: '/work/repo',
  })
  const append: Append = (type, data, surface) =>
    (session as unknown as { append(t: string, d: unknown, o?: unknown): void }).append(type, data, surface ? { surfaceOp: 'append' } : undefined)
  return { session, append }
}

/** Interleaved family: roots, tools, guards, observers, boundaries, units. */
function buildScenario(append: Append): void {
  append('user/message', { source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }] }, true)
  append('turn/start', { turn: 1 })
  // Rebind flow first: a proposal then a confirmed replacement.
  append('user/message', { source: { kind: 'user' }, turn: 1, content: [{ type: 'text', text: '重启 worker 服务。' }] }, true)
  append('tool/call', { turn: 1, step: 3, callId: 'rb1', name: 'context_guard_rebind', arguments: JSON.stringify({ proposal_id: 'P1', item_id: 'R001', action: 'restart', target: { service_id: 'worker' }, resolution: { method: 'explicit_root_clarification' } }) })
  append('tool/result', { turn: 1, step: 3, message: createToolResultMessage({ callId: 'rb1' as never, content: [{ type: 'text', text: JSON.stringify({ status: 'proposed', proposal_id: 'P1' }) }], isError: false }) }, true)
  append('user/message', { source: { kind: 'user' }, turn: 1, content: [{ type: 'text', text: '确认 P1' }] }, true)
  // Duplicate clause + prohibition + test + edit + readback coordination.
  append('user/message', { source: { kind: 'user' }, turn: 1, content: [{ type: 'text', text: '修复 src/app.ts 并运行测试。禁止推送 main 分支。检查改动后的文件。' }] }, true)
  for (const [index, tool] of ['edit', 'bash', 'bash', 'context_guard_observe_file', 'context_guard_observe_test_readiness'].entries()) {
    const callId = `sc-${index}`
    append('tool/call', { turn: 1, step: 5 + index, callId, name: tool, arguments: JSON.stringify(tool === 'bash' ? { command: 'npm test' } : tool === 'edit' ? { file_path: '/work/repo/src/app.ts', old_string: 'a', new_string: 'b' } : { effect_call_id: `sc-0`, item_id: 'R002', scope: '/work/repo' }) })
    const meta = tool === 'context_guard_observe_file'
      ? { contextGuardNativeFile: { effectCallId: 'sc-0', path: '/work/repo/src/app.ts', sha256: 'a'.repeat(64), action: 'modify' } }
      : tool === 'context_guard_observe_test_readiness'
        ? { contextGuardTestReadiness: { itemId: 'R002', scope: '/work/repo', predicate: 'test_passed', manifestSha256: 'b'.repeat(64) } }
        : undefined
    append('tool/result', { turn: 1, step: 5 + index, message: createToolResultMessage({ callId: callId as never, content: [{ type: 'text', text: tool === 'bash' && index === 2 ? 'failed\n[exit code: 1]' : 'ok' }], isError: false }), ...(meta ? { meta } : {}) }, true)
  }
  append('assistant/message', { turn: 1, step: 12, message: { role: 'assistant', content: [{ type: 'text', text: '修复完成并已验证。' }] } }, true)
  append('turn/end', { turn: 1 })
  append('command/run', { name: 'context-guard', source: { kind: 'user' }, args: 'release adopt {"contractId":"c1","operation":"publish","candidate":{"name":"pkg","version":"1.0.0"}}' })
  append('goal/change', { operation: 'edit', goal: { id: 'g1' as never, revision: 2, objective: 'x', phase: 'active', maxGoalRounds: 3, version: 1, roundsStarted: 0, createdAt: 1, updatedAt: 1 }, phase: 'active' })
  append('turn/start', { turn: 2 })
  append('user/message', { source: { kind: 'user' }, turn: 2, content: [{ type: 'text', text: '解释部署流水线的工作方式。' }] }, true)
  append('assistant/message', { turn: 2, step: 17, message: { role: 'assistant', content: [{ type: 'text', text: '流水线分三个阶段。' }] } }, true)
  append('turn/end', { turn: 2 })
  append('approval/asked', { id: 'ap1', toolName: 'bash' })
  append('approval/decided', { id: 'ap1', outcome: 'allowed-once' })
  append('compaction/summary', { summary: 'compacted' })
}

function fold(events: readonly unknown[], derive: typeof candidateDerive, core: typeof candidateCore): string {
  const derived = derive(events as never,
    { activation: 'always', policy: 'release' },
    { cwd: '/work/repo', sessionHeader: HEADER },
    true,
    HOST)
  const coreOut = core(events as never, { ...derived.projection, durabilityWatermark: 'confirmed' })
  return canonical({ projection: derived.projection, core: coreOut, compacted: derived.compacted, realRootInputSeen: derived.realRootInputSeen })
}

describe('CG-083-V1 independent baseline oracle', () => {
  const { session, append } = makeSession('oracle-scenario')
  buildScenario(append)
  const events = snapshotSessionEvents(session)
  expect(events.length).toBeGreaterThan(20)

  it('candidate equals the frozen 0.8.2 implementation on every event prefix', () => {
    for (let prefix = 1; prefix <= events.length; prefix += 1) {
      const baseline = fold(events.slice(0, prefix), baselineDerive as never, baselineCore as never)
      const candidate = fold(events.slice(0, prefix), candidateDerive, candidateCore)
      expect(candidate, `prefix ${prefix}/${events.length}`).toBe(baseline)
    }
  })

  it('candidate equals the frozen implementation on the legacy (boundary-after-history) fold', () => {
    const { session: legacySession, append: legacyAppend } = makeSession('oracle-legacy')
    legacyAppend('user/message', { source: { kind: 'user' }, turn: 1, content: [{ type: 'text', text: 'Fix src/app.ts and run the tests.' }] }, true)
    legacyAppend('tool/call', { turn: 1, step: 2, callId: 'l1', name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) })
    legacyAppend('tool/result', { turn: 1, step: 2, message: createToolResultMessage({ callId: 'l1' as never, content: [{ type: 'text', text: 'ok' }], isError: false }) }, true)
    legacyAppend('user/message', { source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }] }, true)
    const legacyEvents = snapshotSessionEvents(legacySession)
    expect(fold(legacyEvents, candidateDerive, candidateCore)).toBe(fold(legacyEvents, baselineDerive as never, baselineCore as never))
  })

  it('keeps the core adapter reachable on the full scenario', () => {
    const snapshot = fold(events, candidateDerive, candidateCore)
    expect(snapshot).toContain('core-state/v2')
  })
})
