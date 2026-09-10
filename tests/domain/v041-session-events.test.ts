import { describe, expect, it } from 'vitest'
import {
  SESSION_API_UNSUPPORTED,
  SESSION_EVENT_ENVELOPE_INVALID,
  SessionApiError,
  snapshotSessionEvents,
} from '../../src/domain/session-events.js'
import { createRuntime } from '../../src/runtime.js'
import { EXPECTED_HOST_PACKAGES, evaluateHostLock } from '../../src/domain/host-lock.js'

const HOST_LOCK = evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' })

function fakeAgent(session: unknown) {
  return { session } as never
}

/**
 * Guard 0.5.1 supports only the DSH Session V3 API. These cases pin the two
 * halves of that policy: the V3 `snapshotEvents()` surface is read exactly
 * once, and every non-V3 shape is refused loudly instead of being projected as
 * an empty or legacy log.
 */
describe('DSH Session V3 event snapshot contract', () => {
  it('reads exactly one V3 snapshotEvents() snapshot', () => {
    const events = [{ seq: 0, type: 'user/message' }]
    let calls = 0
    expect(snapshotSessionEvents({
      snapshotEvents() {
        calls += 1
        return events
      },
      get events() {
        throw new Error('a legacy getter must never be consulted')
      },
    })).toBe(events)
    expect(calls).toBe(1)
  })

  it('refuses a legacy V2 events getter instead of falling back to it', () => {
    const events = [{ seq: 0, type: 'command/run' }]
    expect(() => snapshotSessionEvents({ events })).toThrow(SessionApiError)
    try {
      snapshotSessionEvents({ events })
    } catch (error) {
      expect((error as SessionApiError).code).toBe(SESSION_API_UNSUPPORTED)
    }
  })

  it('refuses a missing session, a partial host, and a non-array snapshot', () => {
    for (const host of [undefined, null, {}, { snapshotEvents: 'nope' }]) {
      expect(() => snapshotSessionEvents(host)).toThrow(SessionApiError)
    }
    expect(() => snapshotSessionEvents({ snapshotEvents: () => 'not-an-array', events: [] })).toThrow(SessionApiError)
  })

  it('refuses a damaged log instead of projecting it into contract state', () => {
    // Guard is the reader here. A snapshot that is not a contiguous sequence of
    // event envelopes would make the projection silently drop or mis-number
    // events, so each case must raise the envelope code — the runtime then
    // reports integrity unknown rather than certifying from a damaged log.
    const damaged: unknown[][] = [
      [null],
      ['user/message'],
      [{}],
      [{ seq: 0 }],
      [{ type: 'user/message' }],
      [{ seq: -1, type: 'user/message' }],
      [{ seq: 1.5, type: 'user/message' }],
      [{ seq: Number.NaN, type: 'user/message' }],
      [{ seq: '0', type: 'user/message' }],
      [{ seq: 0, type: 7 }],
      [{ seq: 4, type: 'turn/start' }, { seq: 6, type: 'turn/end' }],
    ]
    for (const events of damaged) {
      let raised: unknown
      try {
        snapshotSessionEvents({ snapshotEvents: () => events })
      } catch (error) {
        raised = error
      }
      expect(raised, `expected a refusal for ${JSON.stringify(events)}`).toBeInstanceOf(SessionApiError)
      expect((raised as SessionApiError).code).toBe(SESSION_EVENT_ENVELOPE_INVALID)
    }
    // A ranged read legitimately starts later: contiguity is measured from the
    // snapshot's own first sequence, never from zero.
    const ranged = [{ seq: 12, type: 'user/message' }, { seq: 13, type: 'tool/call' }]
    expect(snapshotSessionEvents({ snapshotEvents: () => ranged })).toBe(ranged)
    expect(snapshotSessionEvents({ snapshotEvents: () => [] })).toEqual([])
  })

  it('reports a damaged log as unsupported integrity rather than as an empty session', () => {
    const runtime = createRuntime(fakeAgent({
      header: { version: 3, id: 'damaged', createdAt: 1, isSeeded: false },
      inheritedEventCount: 0,
      snapshotEvents: () => [{ seq: 0, type: 'turn/start' }, { seq: 2, type: 'turn/end' }],
    }), { activation: 'opt-in' }, HOST_LOCK)
    expect(runtime.projection.integrity).toBe('unknown')
    expect(runtime.projection.integrityViolations).toContain(SESSION_EVENT_ENVELOPE_INVALID)
    expect(runtime.projection.items.size).toBe(0)
  })
})
