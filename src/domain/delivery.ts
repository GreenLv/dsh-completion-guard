import { sha256 } from './canonicalize.js'
import { extractTextContent } from './evidence.js'
import type { DerivedEnvelope } from './types.js'

/**
 * Trusted answer delivery (0.6.0, C03).
 *
 * A delivery fact exists only when the HOST says the turn completed normally.
 * The frozen composition criterion, all four parts required:
 *
 * 1. an `assistant/message` event for turn T;
 * 2. at the turn's highest step number (the final step);
 * 3. carrying no `interrupted` marker (a cancelled mid-stream prefix);
 * 4. followed by `turn/end { turn: T, reason.kind: 'completed' }`.
 *
 * `assistant/attempt` records, aborted/errored/interrupted turns, other
 * turns' replies, and delegated sessions can never bind a delivery. A delivery
 * proves only that an answer was handed to the user — never that it was
 * accurate, sufficient, or that any execution happened.
 */

export interface TrustedDelivery {
  turn: number
  turnEndSeq: number
  responseSeq: number
  responseSha256: string
}

interface AssistantRecord {
  seq: number
  turn: number
  step: number
  text: string
  interrupted: boolean
}

function assistantTextOf(data: unknown): string {
  const record = data as { message?: { content?: Array<{ type?: string; text?: string }> } } | undefined
  return (record?.message?.content ?? [])
    .filter((part) => part?.type === 'text')
    .map((part) => part?.text ?? '')
    .join('\n')
}

/**
 * Derive the trusted deliveries from the event log. Deterministic: a replay of
 * identical events yields identical facts.
 */
export function deriveTrustedDeliveries(events: readonly DerivedEnvelope[]): TrustedDelivery[] {
  const assistants = new Map<number, AssistantRecord[]>()
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const data = (event.data ?? {}) as { turn?: unknown; step?: unknown; interrupted?: unknown }
    if (typeof data.turn !== 'number' || !Number.isSafeInteger(data.turn)) continue
    if (typeof data.step !== 'number' || !Number.isSafeInteger(data.step)) continue
    assistants.set(data.turn, [
      ...(assistants.get(data.turn) ?? []),
      {
        seq: event.seq,
        turn: data.turn,
        step: data.step,
        text: assistantTextOf(event.data),
        interrupted: data.interrupted === true,
      },
    ])
  }
  const deliveries: TrustedDelivery[] = []
  for (const event of events) {
    if (event.type !== 'turn/end') continue
    const data = (event.data ?? {}) as { turn?: unknown; reason?: { kind?: unknown } }
    if (typeof data.turn !== 'number' || !Number.isSafeInteger(data.turn)) continue
    if (data.reason?.kind !== 'completed') continue
    const candidates = assistants.get(data.turn) ?? []
    const finalStep = Math.max(...candidates.map((row) => row.step), -1)
    const final = candidates.find((row) => row.step === finalStep && !row.interrupted && row.text.trim().length > 0)
    if (!final) continue
    deliveries.push({
      turn: data.turn,
      turnEndSeq: event.seq,
      responseSeq: final.seq,
      responseSha256: sha256(final.text),
    })
  }
  return deliveries
}

/**
 * The information-slot items a delivery closes: obligations captured from a
 * root message inside the delivered turn, in the unit that turn's input
 * belonged to, whose semantic slot is information (an inquiry or an
 * explanation request). Execution, constraints, and unknowns are never closed
 * by delivery, and neither are questions from earlier messages.
 */
export function informationItemIdsForDelivery(
  items: ReadonlyMap<string, { status: string; unitId?: string; sourceMessageId: string; taskKind?: string; authorityDisposition?: string; kind: string }>,
  delivery: TrustedDelivery,
  turnRootInputSeqs: ReadonlySet<number>,
  unitId: string | undefined,
): string[] {
  const closed: string[] = []
  for (const [itemId, item] of items) {
    if (item.status !== 'pending') continue
    if (item.kind === 'prohibition') continue
    if (unitId !== undefined && item.unitId !== unitId) continue
    const sourceSeq = /^m(\d+)(?::|$)/.exec(item.sourceMessageId)
    if (!sourceSeq || !turnRootInputSeqs.has(Number(sourceSeq[1]))) continue
    const informationSlot = item.taskKind === 'inquiry'
      || (item.authorityDisposition === 'informational' && item.kind === 'requirement')
    if (informationSlot) closed.push(itemId)
  }
  void delivery
  return closed
}

/** Bounded helper: extract text content already shared with the evidence reader. */
export { extractTextContent }
