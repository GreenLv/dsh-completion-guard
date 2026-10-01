import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { deriveProjection, PROTOCOL_V6_NOTICE } from '../src/domain/derive.js'
import { projectSessionCoreV2 } from '../src/core-v2/session.js'
import { snapshotSessionEvents } from '../src/domain/session-events.js'

// CG-083-PERF02 differential oracle: the indexed fold and the indexed core/v2
// adapter must produce byte-identical observable state to the original
// full-scan paths over EVERY event prefix of the fixture. The toggle is the
// documented escape hatch (DSH_GUARD_DISABLE_INDEXES=1); this test is what
// makes it a real oracle instead of a debugging flag.

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => {
    if (entry instanceof Map) {
      return { __map: [...entry.entries()].map(([k, v]) => [String(k), canonical(v)]) }
    }
    if (entry instanceof Set) return { __set: [...entry.values()].map((v) => canonical(v)).sort() }
    return entry
  }, 2)
}

function append(session: Session, type: string, data: unknown): void {
  // Only message/result types are surface-eligible in the DSH V4 session;
  // everything else must be appended without a surface marker.
  const surface = ['user/message', 'assistant/message', 'tool/result', 'system/message', 'developer/message'].includes(type)
  ;(session as unknown as { append(type: string, data: unknown, options?: unknown): void })
    .append(type, data, surface ? { surfaceOp: 'append' } : undefined)
}

/** A fixture that exercises every capture path the fold indexes touch:
 * distinct and duplicate clauses, prohibitions, tests, edits, clarifications,
 * assets, long outputs, failure and unknown results, boundaries and units. */
function buildFixture(): Session {
  const session = Session.create(SessionId('index-differential'), undefined, {
    version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId('index-differential'), createdAt: 1, cwd: '/work/repo',
  })
  append(session, 'user/message', {
    source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' },
    content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }],
  })
  const roots = [
    'Run the tests and fix src/app.ts if they fail.',
    '禁止推送 main 分支。Run the tests.',
    'Run the tests.',
    'Explain how the deployment pipeline works. Then 修改 src/app.ts。',
    '提交仓库 /work/repo 并推送仓库 /work/repo。',
    '请完成以下任务',
  ]
  for (const [index, text] of roots.entries()) {
    append(session, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text }] })
    for (let call = 0; call < 3; call += 1) {
      const callId = `call-${index}-${call}`
      append(session, 'tool/call', { turn: index + 1, step: session.seq, callId, name: call === 2 ? 'edit' : 'bash',
        arguments: call === 2 ? JSON.stringify({ file_path: '/work/repo/src/app.ts', old_string: 'a', new_string: 'b' }) : JSON.stringify({ command: `npm test run-${index}-${call}` }) })
      const isError = call === 1
      append(session, 'tool/result', {
        turn: index + 1, step: session.seq,
        message: createToolResultMessage({ callId: callId as never, content: [{ type: 'text', text: isError ? `[exit code: 1]\nfailed` : `ok ${'x'.repeat(call === 0 ? 2000 : 20)}` }], isError }),
      })
    }
  }
  // A text-only continuation keeps the core adapter reachable: an uninterpreted
  // attachment obligation deliberately has no raw-text binding, so a session
  // whose current unit still owes one fail-closes to `source_not_projectable`
  // (pre-existing safe behavior, asserted by the core suites).
  append(session, 'user/message', {
    source: { kind: 'user' },
    content: [{ type: 'text', text: '继续' }],
  })
  append(session, 'command/run', { name: 'context-guard', source: { kind: 'user' }, args: 'release adopt {"contractId":"c1","operation":"publish","candidate":{"name":"pkg","version":"1.0.0"}}' })
  append(session, 'goal/change', { operation: 'edit', goal: { id: 'g1', revision: 3 }, phase: 'active' })
  append(session, 'compaction/summary', { summary: 'compacted' })
  append(session, 'turn/start', { turn: 9 })
  append(session, 'approval/asked', { id: 'ap1', toolName: 'bash' })
  append(session, 'approval/decided', { id: 'ap1', outcome: 'allowed-once' })
  return session
}

function fold(events: readonly unknown[], cwd: string): string {
  const derived = deriveProjection(events as never,
    { activation: 'always', policy: 'release' },
    { cwd },
    true)
  const core = projectSessionCoreV2(events as never, { ...derived.projection, durabilityWatermark: 'confirmed' })
  return canonical({ projection: derived.projection, core, compacted: derived.compacted, realRootInputSeen: derived.realRootInputSeen })
}

describe('CG-083-PERF02 index differential oracle', () => {
  const session = buildFixture()
  const events = snapshotSessionEvents(session)

  it('indexed fold equals the original full scan on every event prefix', () => {
    expect(events.length).toBeGreaterThan(30)
    for (let prefix = 0; prefix <= events.length; prefix += 1) {
      process.env.DSH_GUARD_DISABLE_INDEXES = '1'
      const original = fold(events.slice(0, prefix), '/work/repo')
      process.env.DSH_GUARD_DISABLE_INDEXES = '0'
      const indexed = fold(events.slice(0, prefix), '/work/repo')
      expect(indexed, `prefix ${prefix}/${events.length}`).toBe(original)
    }
    process.env.DSH_GUARD_DISABLE_INDEXES = ''
  })

  it('indexed core projection equals the original adapter on the full log', () => {
    process.env.DSH_GUARD_DISABLE_INDEXES = '1'
    const original = fold(events, '/work/repo')
    process.env.DSH_GUARD_DISABLE_INDEXES = '0'
    const indexed = fold(events, '/work/repo')
    process.env.DSH_GUARD_DISABLE_INDEXES = ''
    expect(indexed).toBe(original)
    // The fixture must reach the core adapter, not fall back to undefined.
    expect(original).toContain('core-state/v2')
  })
})
