import type { DerivedEnvelope, JobLifecycleRecord } from './types.js'

/** Audit history alone never transfers control of a job to a fork or orphan. */
export function ownedJobLifecycle(job: JobLifecycleRecord | undefined, owner: string | undefined,
  events: readonly DerivedEnvelope[]): job is JobLifecycleRecord {
  if (!job || !owner || job.owner !== owner || job.registeredAtSeq === undefined) return false
  if (!job.toolCall) return true
  const { callId, rootCallId } = job.toolCall
  return events.some((event) => {
    if (event.seq >= job.registeredAtSeq!) return false
    const call = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {}
    return event.type === 'tool/call' && call.callId === callId && (call.rootCallId ?? call.callId) === rootCallId
      || event.type === 'tool/ptc-dispatch-start' && call.subCallId === callId && call.rootCallId === rootCallId
  })
}
