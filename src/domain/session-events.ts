/**
 * Read a stable snapshot from both legacy DSH Sessions and the rc.1 Session
 * API. rc.1 replaced the public `events` getter with `snapshotEvents()`; the
 * structural adapter keeps older audited cohorts working without widening the
 * accepted event contract.
 */
export function snapshotSessionEvents(session: unknown): readonly unknown[] {
  if (!session || typeof session !== 'object') return []
  const source = session as {
    snapshotEvents?: () => unknown
    events?: unknown
  }
  if (typeof source.snapshotEvents === 'function') {
    const events = source.snapshotEvents.call(session)
    return Array.isArray(events) ? events : []
  }
  return Array.isArray(source.events) ? source.events : []
}
