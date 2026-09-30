import { expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V6_NOTICE } from '../src/domain/derive.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'
import { createToolResultMessage } from '@deepseek-ai/dsh-llm'

/**
 * CG-RC2-005 repair: the rc.2 renderer appends its terminal marker as the
 * LAST line of a foreground result. Guard's no-marker success shortcut must
 * apply only when the readable tail is genuinely unmarked. A marker that is
 * followed by any other line (prose edited in after the marker, or a
 * corrupted marker line) means the renderer's terminal statement is not the
 * last statement and its exit code is unreadable — the evidence must fail
 * closed to `unknown` instead of reporting the unmarked-renderer success,
 * which a nonzero exit could hide behind.
 *
 * Discovered by reproducing the real rc.2 renderer output and appending a
 * prose tail: before the fix the frozen outcome was `success` with reason
 * `unmarked_renderer_success` even though the visible `[exit code: 1]`
 * marker declared a failure.
 */
function evidenceFor(name: 'bash' | 'pwsh', text: string) {
  const host = { ...evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: name === 'bash' ? 'posix' : 'windows', profileKind: 'headless' }), auditedForegroundRenderers: [name] }
  const events = [
    { seq: 0, type: 'user/message', data: { source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }] } },
    { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Run npm test.' }] } },
    { seq: 2, type: 'tool/call', data: { callId: 'run' as never, name, arguments: '{}' } },
    { seq: 3, type: 'tool/result', data: { message: createToolResultMessage({ callId: 'run' as never, content: [{ type: 'text', text }], isError: false }) } },
  ]
  return [...deriveProjection(events, { activation: 'always' }, { cwd: '/work' }, true, host).projection.evidence.values()][0]
}

it('an obscured terminal marker fails closed instead of reading as an unmarked success', () => {
  for (const surface of ['bash', 'pwsh'] as const) {
    expect(evidenceFor(surface, 'x\n[exit code: 1]\nprose').outcome, `${surface} failure obscured`).toBe('unknown')
    expect(evidenceFor(surface, 'PASS\n[exit code: 0]\nprose').outcome, `${surface} success obscured`).toBe('unknown')
  }
})

it('clean terminal statements keep their verdicts', () => {
  expect(evidenceFor('bash', 'PASS\n[exit code: 0]').outcome).toBe('success')
  expect(evidenceFor('bash', 'x\n[exit code: 1]').outcome).toBe('failure')
  expect(evidenceFor('bash', 'PASS').outcome).toBe('success')
  expect(evidenceFor('pwsh', 'PASS').outcome).toBe('success')
})

it('whitespace-only and CRLF tails are still the readable tail', () => {
  expect(evidenceFor('bash', 'PASS\n[exit code: 0]\n   \n').outcome).toBe('success')
  expect(evidenceFor('bash', 'x\r\n[exit code: 1]').outcome).toBe('failure')
})
