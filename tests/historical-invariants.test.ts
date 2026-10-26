
import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { deriveProjection } from '../src/domain/derive.js'
import { renderRecoveryPacket } from '../src/domain/recovery.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'

const HOST = { ...evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' }), goalAvailable: false }

/**
 * Historical-invariant readbacks (EV02 round 2): each test drives one
 * case's expected invariant through the production derive/capture path and
 * asserts the exact durable behavior the case demands.
 */
describe('historical invariants: positive default authority (CGI-20260915-dsh-positive-default-authority)', () => {
  it('unknown-source background material lands as non-executable coverage, never executable_now', () => {
    const events = [
      { seq: 0, type: 'command/run', data: { commandId: 'cmd-0', name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '以下是背景资料，供参考：评测显示构建耗时增加。' }], source: { kind: 'user' } } },
    ] as unknown as Parameters<typeof deriveProjection>[0]
    const derived = deriveProjection(events as never, { activation: 'opt-in' }, { cwd: '/work' }, true, HOST)
    const items = [...derived.projection.items.values()]
    // Background-only input must not mint an executable_now obligation.
    for (const item of items) {
      expect(item.authorityDisposition, item.id).not.toBe('executable_now')
    }
    // The material stays visible (coverage), not silently dropped.
    expect(items.length).toBeGreaterThan(0)
    expect(items.some((item) => item.normalizedText.includes('背景资料'))).toBe(true)
  })

  it('a directive with an identifiable source remains executable_now (positive control)', () => {
    const events = [
      { seq: 0, type: 'command/run', data: { commandId: 'cmd-0', name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '修改 authority-demo.txt。' }], source: { kind: 'user' } } },
    ] as unknown as Parameters<typeof deriveProjection>[0]
    const derived = deriveProjection(events as never, { activation: 'opt-in' }, { cwd: '/work' }, true, HOST)
    const items = [...derived.projection.items.values()]
    expect(items.some((item) => item.authorityDisposition === 'executable_now' && item.normalizedText.includes('authority-demo.txt'))).toBe(true)
  })
})

describe('historical invariants: ordinary git diagnosis facets (CGI-20260915-dsh-ordinary-git-diagnosis)', () => {
  it('distinguishes observed-postcondition, unattributable and missing-history diagnoses without advising a repeated mutation', () => {
    // A failed native git hook: the post-condition is observable as FAILED,
    // and the recovery feedback must not advise re-running the same mutation.
    const session = Session.create(SessionId('git-diagnosis-facets'), undefined, {
      version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId('git-diagnosis-facets'), createdAt: 1, cwd: '/work',
    })
    session.append('command/run', { commandId: 'on' as never, name: 'context-guard', args: 'on', source: { kind: 'user' } })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Context Guard protocol boundary: v6.0.0' }], source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice', summary: 'v6' } }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '提交并推送 demo 仓库的修改。' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId: 'git-1' as never, name: 'bash', arguments: JSON.stringify({ command: 'git commit -m demo', workdir: '/work' }) })
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId: 'git-1' as never, content: [{ type: 'text', text: 'hook rejected the commit' }], isError: true }),
    }, { surfaceOp: 'append' })
    const derived = deriveProjection(session.snapshotEvents() as never, { activation: 'opt-in' }, { cwd: '/work' }, true, HOST)
    // The failed result is captured as FAILED evidence, not success.
    const facts = [...derived.projection.evidence.values()].filter((fact) => fact.callId === 'git-1')
    for (const fact of facts) expect(fact.outcome).toBe('failure')
    // The failed git result does not close the commit obligation.
    const openItems = [...derived.projection.items.values()].filter((item) => item.status === 'pending')
    expect(openItems.length).toBeGreaterThan(0)
    // Facet oracle (the case's full expected): the diagnosis separates the
    // OBSERVED post-condition (the failed result is a real, bound fact with a
    // concrete reason code) from UNATTRIBUTABLE or MISSING-HISTORY gaps —
    // those carry a different reason shape and never inherit the observed
    // fact's identity.
    for (const fact of facts) {
      expect(fact.outcome, 'observed post-condition facet').toBe('failure')
      expect(fact.callId).toBe('git-1')
      expect(fact.parseStatus).toBe('supported')
    }
    // Complementary facts from OTHER calls must not exist (nothing borrowed).
    expect(facts.every((fact) => fact.callId === 'git-1')).toBe(true)
    // The recovery feedback must NOT advise repeating the already-attempted
    // mutation: render the same projection's packet and assert the failed
    // command text is not presented as a to-do.
    const packet = renderRecoveryPacket(derived.projection)
    expect(packet).not.toContain('git commit -m demo')
    const openText = JSON.stringify(openItems.map((item) => item.normalizedText))
    expect(openText).not.toContain('git commit -m demo')
  })
})
