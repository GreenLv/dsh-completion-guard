import { expect, it, vi } from 'vitest'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createRuntime } from '../src/runtime.js'

function session(text: string) {
  const value = Session.create(SessionId('review-cache'), undefined, {
    version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId('review-cache'), createdAt: 1, cwd: '/work',
  })
  value.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
  return value
}

it('does not reuse a projection when the current snapshot API fails without a seq change', () => {
  const source = session('Explain the first requirement.')
  const runtime = createRuntime({ session: source } as never, { activation: 'always' } as never)
  const reader = vi.spyOn(source, 'snapshotEvents').mockImplementation(() => { throw new Error('snapshot unavailable') })
  try {
    runtime.sync()
    expect(runtime.projection.integrity).toBe('unknown')
    expect(runtime.projection.integrityViolations).toContain('session_snapshot_failed')
  } finally { reader.mockRestore() }
})

it('does not reuse a projection across distinct immutable snapshots with equal lengths', () => {
  const source = session('Explain the first requirement.')
  const replacement = session('Run the tests.').snapshotEvents()
  const runtime = createRuntime({ session: source } as never, { activation: 'always' } as never)
  const reader = vi.spyOn(source, 'snapshotEvents').mockReturnValue(replacement)
  try {
    const fresh = createRuntime({ session: source } as never, { activation: 'always' } as never)
    expect([...fresh.projection.items.values()].some(item => item.normalizedText.includes('Run the tests'))).toBe(true)
    runtime.sync()
    expect([...runtime.projection.items.values()].some(item => item.normalizedText.includes('Run the tests'))).toBe(true)
  } finally { reader.mockRestore() }
})
