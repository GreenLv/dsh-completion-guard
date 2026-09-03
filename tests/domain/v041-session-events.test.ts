import { describe, expect, it } from 'vitest'
import { snapshotSessionEvents } from '../../src/domain/session-events.js'

describe('DSH Session event snapshot compatibility', () => {
  it('uses the rc.1 snapshotEvents API when it is available', () => {
    const events = [{ seq: 0, type: 'user/message' }]
    let calls = 0
    expect(snapshotSessionEvents({
      snapshotEvents() {
        calls += 1
        return events
      },
      get events() {
        throw new Error('legacy getter must not be touched')
      },
    })).toBe(events)
    expect(calls).toBe(1)
  })

  it('keeps the legacy events getter for older audited DSH cohorts', () => {
    const events = [{ seq: 0, type: 'command/run' }]
    expect(snapshotSessionEvents({ events })).toBe(events)
  })

  it('fails closed to an empty snapshot for malformed hosts', () => {
    expect(snapshotSessionEvents(undefined)).toEqual([])
    expect(snapshotSessionEvents({ snapshotEvents: () => 'not-an-array', events: [] })).toEqual([])
  })
})
