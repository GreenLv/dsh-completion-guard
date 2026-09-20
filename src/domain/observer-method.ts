import { sha256 } from './canonicalize.js'
import { persistedToolResultStatus } from './evidence.js'
import type { DerivedEnvelope, GuardEvidence, GuardItem, GuardProjection } from './types.js'

const row = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}
const birthSeq = (item: GuardItem): number | undefined => {
  const match = /^m(\d+)(?::|$)/.exec(item.sourceMessageId)
  return match ? Number(match[1]) : undefined
}

/** The method is a root-sourced way to observe existing work. It is fulfilled
 * only by a real, later, same-turn Host exchange for that exact work item.
 * Old generic records and results before the v6 root can never enter here. */
export function observerMethodEvidence(
  projection: GuardProjection, events: readonly DerivedEnvelope[], method: GuardItem, index: number,
): GuardEvidence | undefined {
  const instruction = method.observerMethod
  const rootSeq = birthSeq(method)
  if (!instruction || rootSeq === undefined || projection.v6BoundarySeq === undefined
    || rootSeq <= projection.v6BoundarySeq || method.authority !== 'root_instruction') return undefined
  const root = events.find((event) => event.seq === rootSeq && event.type === 'user/message')
  const data = row(root?.data)
  if (row(data.source).kind !== 'user' || !Array.isArray(data.content)) return undefined
  const text = data.content.filter((part) => row(part).type === 'text').map((part) => String(row(part).text ?? '')).join('')
  if (sha256(text) !== method.rawTextSha256) return undefined
  const tool = instruction.tools[index]
  const related = projection.items.get(instruction.targetItemIds[index] ?? '')
  if (!tool || !related || related.rawTextSha256 !== method.rawTextSha256
    || related.unitId !== method.unitId || birthSeq(related) !== rootSeq) return undefined
  const target = tool === 'context_guard_observe_test_readiness' ? related.requestedTarget?.scope
    : related.requestedTarget?.artifact_id ?? (related.semanticAction === 'verify' ? related.requestedTarget?.scope : undefined)
  if (typeof target !== 'string' || !target) return undefined
  return [...projection.evidence.values()].find((fact) => {
    if (fact.toolName !== tool || fact.outcome !== 'success' || fact.parseStatus !== 'supported'
      || fact.epoch !== projection.epoch || !fact.subjects.includes(target)) return false
    const calls = events.filter((event) => event.type === 'tool/call' && row(event.data).callId === fact.callId)
    const results = events.filter((event) => {
      if (event.type !== 'tool/result') return false
      const content = row(row(event.data).message).content
      return Array.isArray(content) && content.some((part) => row(part).type === 'tool-result'
        && row(part).toolCallId === fact.callId)
    })
    if (calls.length !== 1 || results.length !== 1) return false
    const call = calls[0]!, result = results[0]!
    if (call.seq <= rootSeq || call.seq >= result.seq || result.seq !== fact.toolResultSeq
      || row(call.data).name !== tool || row(call.data).turn !== row(result.data).turn
      || row(call.data).step !== row(result.data).step
      || persistedToolResultStatus(result.data, fact.callId) !== 'clean') return false
    if (tool === 'context_guard_observe_test_readiness') return related.semanticAction === 'test'
      && fact.readinessForItemId === related.id && fact.readinessPredicate === 'test_passed'
    return (related.semanticAction === 'verify' || related.semanticAction === 'modify') && fact.evidenceRole === 'state'
      && [...projection.evidence.values()].some((effect) => effect.callId === fact.causedByCallId
        && effect.semanticAction === 'modify' && effect.outcome === 'success'
        && effect.evidenceRole === 'effect' && effect.toolResultSeq < fact.toolResultSeq
        && effect.subjects.includes(target))
  })
}
