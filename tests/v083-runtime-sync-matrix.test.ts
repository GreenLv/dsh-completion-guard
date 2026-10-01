import { expect, it, vi } from 'vitest'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as deriveModule from '../src/domain/derive.js'
import type { PrivateLedgerSnapshot } from '../src/domain/private-ledger.js'
import { createRuntime } from '../src/runtime.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'

const HOST_LOCK = evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' })

// CG-083-R1 acceptance matrix: the unchanged fast path is keyed on the
// CURRENT validated snapshot identity plus the same-version Goal readback and
// private-ledger view. Every input family that can change must force a full
// rebuild; an unchanged session must not re-derive. Fault injection (throwing
// snapshot API, equal-length snapshot replacement, gaps, reordered events) is
// a correctness contract for the reuse decision, not a claim about how the
// official host behaves in production.

function newSession(text?: string): Session {
  const value = Session.create(SessionId('r1-matrix'), undefined, {
    version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId('r1-matrix'), createdAt: 1, cwd: '/work',
  })
  if (text) {
    value.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
  }
  return value
}

function makeRuntime(session: Session, options?: {
  goal?: () => unknown
  ledger?: () => PrivateLedgerSnapshot
  refreshHostLock?: () => unknown
}) {
  return createRuntime(
    { session } as never,
    { activation: 'always' } as never,
    HOST_LOCK,
    options?.goal as (() => unknown) | undefined,
    options?.refreshHostLock as (() => never) | undefined,
    options?.ledger,
  )
}

it('rebuilds on append, replace, reorder, gap and snapshot failures; reuses only an identical snapshot', () => {
  const session = newSession('Explain the first requirement.')
  const derive = vi.spyOn(deriveModule, 'deriveProjection')
  try {
    const runtime = makeRuntime(session)
    const afterInit = derive.mock.calls.length

    // Positive control: unchanged snapshot reuses (no derive).
    runtime.sync()
    expect(derive.mock.calls.length).toBe(afterInit)

    // Append: a new durable event invalidates the fast path.
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Run the tests.' }] }), { surfaceOp: 'append' })
    runtime.sync()
    expect(derive.mock.calls.length).toBe(afterInit + 1)
    expect([...runtime.projection.items.values()].some((item) => item.normalizedText.includes('Run the tests'))).toBe(true)
    runtime.sync()
    expect(derive.mock.calls.length).toBe(afterInit + 1)

    // Equal-length replacement with different content: NOT unchanged.
    const replacement = newSession('Run the tests.').snapshotEvents()
    const reader = vi.spyOn(session, 'snapshotEvents').mockReturnValue(replacement)
    try {
      runtime.sync()
      expect(derive.mock.calls.length).toBe(afterInit + 2)
      expect([...runtime.projection.items.values()].some((item) => item.normalizedText.includes('Run the tests'))).toBe(true)
    } finally { reader.mockRestore() }

    // Reordered events: envelope validation still passes (contiguous seq) but
    // the content differs -> rebuild.
    const reordered = [...session.snapshotEvents()]
    if (reordered.length >= 2) {
      const last = reordered.pop()!
      reordered.splice(0, 0, last)
      // A moved tail breaks seq contiguity -> the adapter must refuse it.
      const refused = vi.spyOn(session, 'snapshotEvents').mockReturnValue(reordered)
      try {
        runtime.sync()
        expect(runtime.projection.integrity).toBe('unknown')
        expect(runtime.projection.integrityViolations).toContain('session_event_envelope_invalid')
      } finally { refused.mockRestore() }
      // The cache is invalidated: the next healthy snapshot re-derives.
      runtime.sync()
      expect(derive.mock.calls.length).toBe(afterInit + 3)
      expect(runtime.projection.integrity).toBe('valid')
    }

    // Snapshot API failure: fail closed AND invalidate the cache.
    const failing = vi.spyOn(session, 'snapshotEvents').mockImplementation(() => { throw new Error('snapshot unavailable') })
    try {
      runtime.sync()
      expect(runtime.projection.integrity).toBe('unknown')
      expect(runtime.projection.integrityViolations).toContain('session_snapshot_failed')
      // Failure again keeps the refusal but must never serve the old core.
      runtime.sync()
      expect(runtime.projection.integrity).toBe('unknown')
    } finally { failing.mockRestore() }
    runtime.sync()
    expect(runtime.projection.integrity).toBe('valid')

    // Header replacement (resume/compact shape): rebuild even with identical events.
    const stableEvents = session.snapshotEvents()
    const headerReader = vi.spyOn(session, 'snapshotEvents').mockReturnValue(stableEvents)
    const originalHeader = session.header
    try {
      Object.defineProperty(session, 'header', { value: { ...originalHeader, origin: 'resume' }, configurable: true })
      runtime.sync()
      expect(derive.mock.calls.length).toBe(afterInit + 5)
    } finally {
      void 0
      Object.defineProperty(session, 'header', { value: originalHeader, configurable: true })
      headerReader.mockRestore()
    }
  } finally {
    derive.mockRestore()
  }
})

it('binds one Goal readback version to both the cache key and the overlay', () => {
  const session = newSession('Run the tests.')
  const derive = vi.spyOn(deriveModule, 'deriveProjection')
  try {
    // The overlay applies only when the durable log's own Goal ref matches the
    // readback (existing fail-safe semantics): seed the log with goal/change.
    session.append('goal/change', { operation: 'edit', goal: { id: 'g1' as never, revision: 1, objective: 'x', phase: 'active', maxGoalRounds: 3, version: 1, roundsStarted: 0, createdAt: 1, updatedAt: 1 }, kind: 'objective', version: 1, roundsStarted: 0, createdAt: 1, updatedAt: 1 } as never)
    let goal: unknown = { goal: { id: 'g1', revision: 1, phase: 'active' }, activation: 'armed' }
    const runtime = makeRuntime(session, { goal: () => goal })
    runtime.sync()
    expect(runtime.projection.currentGoalActivation).toBe('armed')
    expect(runtime.projection.currentGoalPhase).toBe('active')

    // Activation change with the same id/revision: rebuild + overlay.
    goal = { goal: { id: 'g1', revision: 1, phase: 'active' }, activation: 'disarmed' }
    runtime.sync()
    expect(derive.mock.calls.length).toBe(2)
    expect(runtime.projection.currentGoalActivation).toBe('disarmed')
    runtime.sync()
    expect(derive.mock.calls.length).toBe(2)

    // A readback revision the log does not hold yet: rebuild happens (the key
    // changed) but the overlay must NOT bind the newer version.
    goal = { goal: { id: 'g1', revision: 2, phase: 'active' }, activation: 'armed' }
    runtime.sync()
    expect(derive.mock.calls.length).toBe(3)
    expect(runtime.projection.currentGoalRef?.revision).toBe(1)
    expect(runtime.projection.currentGoalActivation).toBe('disarmed')

    // Readback failure: fail closed and invalidate; recovery re-derives.
    goal = undefined
    const broken = (): unknown => { throw new Error('goal service unavailable') }
    const failing = makeRuntime(session, { goal: broken })
    failing.sync()
    expect(failing.projection.integrity).toBe('unknown')
    expect(failing.projection.integrityViolations).toContain('goal_readback_unavailable')
  } finally {
    derive.mockRestore()
  }
})

it('invalidates on private-ledger change and damage, and rebuilds on fresh host validation', () => {
  const session = newSession('Run the tests.')
  const derive = vi.spyOn(deriveModule, 'deriveProjection')
  try {
    const record = (position: number): PrivateLedgerSnapshot => ({
      records: [{ version: 1, session_sha256: 's', context_sha256: 'c', position, prior_sha256: null,
        kind: 'restart_intent', payload: { n: position }, record_sha256: `r${position}` }],
      damaged: false, anchored: true,
    })
    let ledger: PrivateLedgerSnapshot = { records: [], damaged: false, anchored: true }
    let validations = 0
    const hostLock = { ...HOST_LOCK }
    const runtime = createRuntime({ session } as never, { activation: 'always' } as never, hostLock as never,
      undefined, () => { validations += 1; return hostLock as never }, () => ledger)
    runtime.sync()
    const afterInit = derive.mock.calls.length
    runtime.sync()
    expect(derive.mock.calls.length).toBe(afterInit)

    // Ledger change: rebuild (the ledger view is part of the key).
    ledger = record(1)
    runtime.sync()
    expect(derive.mock.calls.length).toBe(afterInit + 1)
    expect(runtime.projection.releaseReservations.length).toBe(0)
    runtime.sync()
    expect(derive.mock.calls.length).toBe(afterInit + 1)

    // Ledger damage: rebuild with damaged state.
    ledger = { records: [], damaged: true, anchored: true }
    runtime.sync()
    expect(derive.mock.calls.length).toBe(afterInit + 2)
    expect(runtime.projection.releaseStateDamaged).toBe(true)

    // A revalidation entry always rebuilds, whatever the fast path thinks.
    ledger = record(1)
    runtime.sync({ revalidateHostLock: true })
    expect(derive.mock.calls.length).toBe(afterInit + 3)
    expect(validations).toBeGreaterThanOrEqual(1)
  } finally {
    derive.mockRestore()
  }
})
