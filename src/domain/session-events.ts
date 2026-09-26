/**
 * Read a validated, stable event snapshot from the DSH Session V4 API.
 *
 * Exact rc.2 still exposes the deprecated synchronous snapshotEvents() API.
 * This adapter retains that existing dependency; it does not promise support
 * for remote history or add a fallback to a legacy events getter.
 *
 * Guard is a READER of the durable log, so the envelope check below is the one
 * part of log validation it owns itself. The host validates a session it
 * constructs or restores; Guard additionally refuses a snapshot that is not a
 * sequence of event envelopes, because a projection that silently dropped or
 * mis-numbered an event would fabricate contract state rather than report a
 * damaged log.
 *
 * The V4 contract also asks a reader to refuse an unrecognized event type that
 * is not marked `ignorable`. Guard does NOT implement that half, deliberately:
 * the host's persistence reader already refuses such a log before publishing a
 * Session, and a whitelist of event types Guard happens to know would
 * false-refuse a healthy host whose composition registers a required event type
 * through a third-party plugin. The full rationale is in
 * `UPSTREAM_API_AUDIT.md`; revisit it there rather than adding a whitelist here.
 */
export const SESSION_API_UNSUPPORTED = 'session_api_unsupported'
export const SESSION_EVENT_ENVELOPE_INVALID = 'session_event_envelope_invalid'

export class SessionApiError extends Error {
  readonly code: string

  constructor(message: string, code: string = SESSION_API_UNSUPPORTED) {
    super(message)
    this.name = 'SessionApiError'
    this.code = code
  }
}

/** The V4 session surface Guard reads: one bounded, immutable event snapshot. */
export interface V4SessionLike {
  snapshotEvents(fromSeq?: number, toSeqExclusive?: number): readonly unknown[]
}

/**
 * Refuse a snapshot that is not a contiguous, correctly enveloped V4 log.
 *
 * `seq` must be a non-negative safe integer and `type` a non-empty string.
 * Contiguity is checked against the snapshot's own first sequence rather than
 * against zero, because a ranged read legitimately starts later.
 */
function assertEventEnvelopes(events: readonly unknown[]): void {
  let expected: number | undefined
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new SessionApiError(`snapshot event ${index} is not an object`, SESSION_EVENT_ENVELOPE_INVALID)
    }
    const record = event as { seq?: unknown; type?: unknown }
    if (typeof record.type !== 'string' || record.type.length === 0) {
      throw new SessionApiError(`snapshot event ${index} has no event type`, SESSION_EVENT_ENVELOPE_INVALID)
    }
    if (typeof record.seq !== 'number' || !Number.isSafeInteger(record.seq) || record.seq < 0) {
      throw new SessionApiError(`snapshot event ${index} has no sequence number`, SESSION_EVENT_ENVELOPE_INVALID)
    }
    if (expected !== undefined && record.seq !== expected) {
      throw new SessionApiError(`snapshot event ${index} breaks sequence contiguity`, SESSION_EVENT_ENVELOPE_INVALID)
    }
    expected = record.seq + 1
  }
}

export function snapshotSessionEvents(session: unknown): readonly unknown[] {
  if (!session || typeof session !== 'object') {
    throw new SessionApiError('a DSH Session object is required')
  }
  const source = session as { snapshotEvents?: unknown }
  if (typeof source.snapshotEvents !== 'function') {
    throw new SessionApiError('session does not expose the DSH Session V4 snapshotEvents() API')
  }
  const events = (source.snapshotEvents as () => unknown).call(session)
  if (!Array.isArray(events)) {
    throw new SessionApiError('snapshotEvents() did not return an event list')
  }
  assertEventEnvelopes(events)
  return events
}
