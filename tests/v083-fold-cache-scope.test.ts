import { expect, it } from 'vitest'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { deriveProjection, PROTOCOL_V6_NOTICE } from '../src/domain/derive.js'
import { snapshotSessionEvents } from '../src/domain/session-events.js'

// CG-083-R5: the fold's per-derive seq index must be scoped to ONE derive
// call over the exact array that call consumes. The exported derive API does
// not promise that the caller's array is immutable, so appending to the same
// array between derives must be visible to the second derive (root locator
// contexts included); a genuinely frozen snapshot must stay stable.

function makeEvents(): Array<Record<string, unknown>> {
  const session = Session.create(SessionId('fold-cache'), undefined, {
    version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId('fold-cache'), createdAt: 1, cwd: '/work',
  })
  const append = (type: string, data: unknown, surface?: boolean) =>
    (session as unknown as { append(t: string, d: unknown, o?: unknown): void }).append(type, data, surface ? { surfaceOp: 'append' } : undefined)
  append('user/message', { source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }] }, true)
  append('user/message', { source: { kind: 'user' }, turn: 1, content: [{ type: 'text', text: 'Fix src/app.ts and run the tests.' }] }, true)
  // Copy: the official Session's snapshot is already a frozen array; the
  // mutable-array scenario is exactly the unverified caller shape.
  return [...snapshotSessionEvents(session)] as Array<Record<string, unknown>>
}

const fold = (events: readonly unknown[]) => deriveProjection(events as never,
  { activation: 'always', policy: 'release' },
  { cwd: '/work', sessionHeader: { version: SESSION_FORMAT_VERSION, id: 'fold-cache', createdAt: 1, seedLength: 0, delegationDepth: 0 } },
  true)

it('sees events appended into the same mutable array between derives', () => {
  const events = makeEvents()
  const first = fold(events)
  const locatorSeqsBefore = [...first.projection.rootLocatorContexts.keys()]
  // Append a second root input directly into the SAME array, exactly the
  // shape the original review counterexample used.
  events.push({
    seq: events.length, type: 'user/message',
    data: { source: { kind: 'user' }, turn: 1, content: [{ type: 'text', text: 'Add the readme section too.' }] },
  })
  const second = fold(events)
  expect([...second.projection.items.values()].some((item) => item.normalizedText.includes('readme section'))).toBe(true)
  // The root locator context must cover the NEW root input as well.
  const locatorSeqsAfter = [...second.projection.rootLocatorContexts.keys()]
  expect(locatorSeqsAfter.length).toBeGreaterThan(locatorSeqsBefore.length)
  expect(locatorSeqsBefore).toEqual(expect.arrayContaining([first.projection.v6BoundarySeq !== undefined ? 1 : locatorSeqsBefore[0]]))
  void locatorSeqsBefore
})

it('is stable for a genuinely frozen snapshot (positive control)', () => {
  const events = makeEvents()
  const frozen = Object.freeze([...events])
  const one = fold(frozen)
  const two = fold(frozen)
  expect(JSON.stringify(two.projection.rootLocatorContexts)).toBe(JSON.stringify(one.projection.rootLocatorContexts))
  expect(two.projection.rootLocatorIdentity).toBe(one.projection.rootLocatorIdentity)
})
