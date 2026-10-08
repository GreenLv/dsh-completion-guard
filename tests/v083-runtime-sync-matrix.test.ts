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

it('reuses completed frozen subtree proofs after append without trusting new mutable data', () => {
  const session = newSession('Explain the existing requirement.')
  const original = session.snapshotEvents()[0]!
  const names = Object.getOwnPropertyNames
  let oldVisits = 0
  const inspect = vi.spyOn(Object, 'getOwnPropertyNames').mockImplementation(value => {
    if (value === original) oldVisits += 1
    return names(value)
  })
  const derive = vi.spyOn(deriveModule, 'deriveProjection')
  try {
    const runtime = makeRuntime(session)
    runtime.sync() // Establish the proof for the first frozen snapshot.
    expect(oldVisits).toBe(1)
    session.append('user/message', createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'Run the tests.' }] }), { surfaceOp: 'append' })
    runtime.sync()
    runtime.sync()
    expect(oldVisits, 'old frozen event is not recursively inspected again').toBe(1)
    const calls = derive.mock.calls.length
    const mutable = structuredClone(session.snapshotEvents().at(-1)!)
    const read = vi.spyOn(session, 'snapshotEvents').mockReturnValue(Object.freeze([original, mutable]))
    try {
      runtime.sync()
      runtime.sync()
      expect(derive.mock.calls.length).toBe(calls + 2)
    } finally { read.mockRestore() }
  } finally {
    inspect.mockRestore()
    derive.mockRestore()
  }
})

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

it('never serves the fast path for a snapshot whose immutability is not provable', () => {
  const derive = vi.spyOn(deriveModule, 'deriveProjection')
  try {
    // 1. A session view that hands out the SAME MUTABLE array: an append
    // between syncs must be visible (the review's before=1/after=1/forced=2
    // counterexample must now read before=1, after=2).
    const mutableSession = newSession('Explain the first requirement.')
    const events = [...mutableSession.snapshotEvents()]
    const mutableReader = vi.spyOn(mutableSession, 'snapshotEvents').mockReturnValue(events as never)
    try {
      const runtime = makeRuntime(mutableSession)
      expect([...runtime.projection.items.values()].length).toBe(1)
      runtime.sync()
      expect(derive.mock.calls.length).toBe(2) // not provable: rebuilt
      events.push({
        seq: events.length as never, type: 'user/message',
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Run the tests.' }] },
      } as never)
      runtime.sync()
      expect([...runtime.projection.items.values()].some((item) => item.normalizedText.includes('Run the tests'))).toBe(true)
      expect(derive.mock.calls.length).toBe(3)
    } finally { mutableReader.mockRestore() }

    // 2. A frozen array with SHALLOW-FROZEN elements (data not frozen):
    // in-place field mutation must be visible, so the fast path must not
    // engage. Synthetic clone — official events are already deep-frozen.
    const shallowSession = newSession('Explain the first requirement.')
    const shallowEvents = Object.freeze([...shallowSession.snapshotEvents()].map((element) => Object.freeze(structuredClone(element))))
    const shallowReader = vi.spyOn(shallowSession, 'snapshotEvents').mockReturnValue(shallowEvents as never)
    try {
      const runtime = makeRuntime(shallowSession)
      runtime.sync()
      const calls = derive.mock.calls.length
      const element = shallowEvents[0] as { data?: { content?: Array<{ text?: string }> } }
      element.data!.content![0]!.text = 'Run the tests now.'
      runtime.sync()
      expect(derive.mock.calls.length, 'shallow-frozen snapshot: full rebuild').toBe(calls + 1)
      expect([...runtime.projection.items.values()].some((item) => item.normalizedText.includes('Run the tests now'))).toBe(true)
    } finally { shallowReader.mockRestore() }

    // 3. Positive control: a DEEP-FROZEN snapshot takes the fast path.
    const deepSession = newSession('Explain the first requirement.')
    const deepEvents = structuredClone(deepSession.snapshotEvents()) as unknown[]
    const deepFreeze = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return
      for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key])
      Object.freeze(value)
    }
    deepFreeze(deepEvents)
    const deepReader = vi.spyOn(deepSession, 'snapshotEvents').mockReturnValue(deepEvents as never)
    try {
      const runtime = makeRuntime(deepSession)
      const afterInit = derive.mock.calls.length
      runtime.sync()
      expect(derive.mock.calls.length, 'deep-frozen snapshot: fast path').toBe(afterInit)
      runtime.sync()
      expect(derive.mock.calls.length).toBe(afterInit)
    } finally { deepReader.mockRestore() }

    // 3b. F2 round-3: a frozen container whose property is an ACCESSOR is
    // not provable — the getter's return value follows its closure. The fast
    // path must never engage, and a closure change must be visible.
    {
      const getterSession = newSession('Explain the first requirement.')
      let hiddenText = 'Explain the first requirement.'
      const getterEvents = [structuredClone((getterSession.snapshotEvents() as unknown as Array<Record<string, unknown>>)[0] as Record<string, unknown>)]
      const part = (getterEvents[0] as { data: { content: Array<{ type: string; text: string }> } }).data
      Object.defineProperty(part.content, 0, {
        enumerable: true,
        get() { return { type: 'text', text: hiddenText } },
      })
      // Freeze every container along the chain (array, envelope, data, content).
      Object.freeze(part.content)
      Object.freeze(part)
      Object.freeze(getterEvents[0])
      Object.freeze(getterEvents)
      const getterReader = vi.spyOn(getterSession, 'snapshotEvents').mockReturnValue(getterEvents as never)
      try {
        const runtime = makeRuntime(getterSession)
        runtime.sync()
        const calls = derive.mock.calls.length
        expect([...runtime.projection.items.values()].some((item) => item.normalizedText.includes('Explain the first'))).toBe(true)
        hiddenText = 'Run the tests now.'
        runtime.sync()
        expect(derive.mock.calls.length, 'accessor snapshot: full rebuild, never cached').toBe(calls + 1)
        expect([...runtime.projection.items.values()].some((item) => item.normalizedText.includes('Run the tests now'))).toBe(true)
      } finally { getterReader.mockRestore() }
    }

    // 3c. F2 round-5: a NON-ENUMERABLE accessor on frozen containers is
    // equally unprovable — Object.keys would have skipped it, so the proof
    // must enumerate all owned keys. The fast path must never engage.
    {
      const neSession = newSession('Explain the first requirement.')
      let hiddenText = 'Explain the first requirement.'
      const neEvents = [structuredClone((neSession.snapshotEvents() as unknown as Array<Record<string, unknown>>)[0] as Record<string, unknown>)]
      const neData = (neEvents[0] as { data: { content: Array<{ type: string; text: string }> } }).data
      Object.defineProperty(neData.content, 0, {
        enumerable: false,
        get() { return { type: 'text', text: hiddenText } },
      })
      Object.freeze(neData.content)
      Object.freeze(neData)
      Object.freeze(neEvents[0])
      Object.freeze(neEvents)
      const neReader = vi.spyOn(neSession, 'snapshotEvents').mockReturnValue(neEvents as never)
      try {
        const runtime = makeRuntime(neSession)
        runtime.sync()
        const calls = derive.mock.calls.length
        expect([...runtime.projection.items.values()].some((item) => item.normalizedText.includes('Explain the first'))).toBe(true)
        hiddenText = 'Run the tests now.'
        runtime.sync()
        expect(derive.mock.calls.length, 'non-enumerable accessor snapshot: full rebuild').toBe(calls + 1)
        expect([...runtime.projection.items.values()].some((item) => item.normalizedText.includes('Run the tests now'))).toBe(true)
      } finally { neReader.mockRestore() }
    }

    // 4. Positive control: the OFFICIAL Session snapshot is deeply frozen and
    // reuses its array, so the production host keeps the fast path.
    const official = newSession('Explain the first requirement.')
    const officialRuntime = makeRuntime(official)
    const afterInit = derive.mock.calls.length
    officialRuntime.sync()
    expect(derive.mock.calls.length, 'official frozen snapshot: fast path').toBe(afterInit)
    officialRuntime.sync()
    expect(derive.mock.calls.length).toBe(afterInit)
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

it('never publishes a cyclic or budget-unfinished parent proof, even after completed children are cached', () => {
  const derive = vi.spyOn(deriveModule, 'deriveProjection')
  try {
    for (const kind of ['cycle', 'budget', 'depth'] as const) {
      const session = newSession('Run the tests.')
      const event = structuredClone(session.snapshotEvents()[0]!) as unknown as Record<string, unknown>
      if (kind === 'cycle') {
        const cycle: Record<string, unknown> = {}
        cycle.self = cycle
        event.extra = Object.freeze(cycle)
      } else if (kind === 'depth') {
        let nested: object = Object.freeze({})
        for (let depth = 0; depth < 20_000; depth += 1) nested = Object.freeze({ child: nested })
        event.extra = nested
      } else {
        // The accessor lies beyond the first proof's node budget. Completed
        // siblings may be reused, but neither pass may bless the parent.
        const tail = Object.freeze(Object.defineProperty({}, 'hidden', { get: () => 'changes' }))
        event.extra = Object.freeze([...Array.from({ length: 400_010 }, () => Object.freeze({})), tail])
      }
      const data = event.data as { content: Array<unknown>; source: object }
      data.content.forEach(Object.freeze)
      Object.freeze(data.content)
      Object.freeze(data.source)
      Object.freeze(data)
      Object.freeze(event)
      const reader = vi.spyOn(session, 'snapshotEvents').mockReturnValue(Object.freeze([event]) as never)
      try {
        const runtime = makeRuntime(session)
        const count = derive.mock.calls.length
        runtime.sync()
        runtime.sync()
        expect(derive.mock.calls.length, kind).toBe(count + 2)
        expect(runtime.projection.items.size).toBeGreaterThan(0)
      } finally { reader.mockRestore() }
    }
  } finally { derive.mockRestore() }
})


it('rejects inherited accessor content and never shares subtree proofs across runtimes', () => {
  const session = newSession()
  let text = 'Explain the existing requirement.'
  const proto = { get content() { return Object.freeze([Object.freeze({ type: 'text', text })]) } }
  const data = Object.freeze(Object.assign(Object.create(proto), { source: Object.freeze({ kind: 'user' }) }))
  const event = Object.freeze({ seq: 0, type: 'user/message', data })
  const reader = vi.spyOn(session, 'snapshotEvents').mockReturnValue(Object.freeze([event]) as never)
  const derive = vi.spyOn(deriveModule, 'deriveProjection')
  try {
    const runtime = makeRuntime(session)
    runtime.sync()
    const count = derive.mock.calls.length
    text = 'Run the tests.'
    runtime.sync()
    expect(derive.mock.calls.length).toBe(count + 1)
    expect([...runtime.projection.items.values()].map(item => item.normalizedText)).toContain(text)
    const restarted = makeRuntime(session)
    restarted.sync()
    expect(derive.mock.calls.length).toBe(count + 3)
  } finally { reader.mockRestore(); derive.mockRestore() }

  const frozenSession = newSession('Run the tests.')
  const frozen = frozenSession.snapshotEvents()[0]!
  const names = Object.getOwnPropertyNames
  let inspections = 0
  const inspect = vi.spyOn(Object, 'getOwnPropertyNames').mockImplementation(value => {
    if (value === frozen) inspections += 1
    return names(value)
  })
  try {
    makeRuntime(frozenSession).sync()
    makeRuntime(frozenSession).sync()
    expect(inspections).toBe(2)
  } finally { inspect.mockRestore() }
})
