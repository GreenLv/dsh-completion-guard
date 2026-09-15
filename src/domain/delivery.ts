import { sha256 } from './canonicalize.js'
import { extractTextContent } from './evidence.js'
import type { DerivedEnvelope } from './types.js'

/**
 * Trusted answer delivery (0.6.0, C03).
 *
 * A delivery fact exists only when the HOST says the turn completed normally
 * AND the turn's own structure shows that the answer really was the last thing
 * the turn produced. The frozen composition criterion, all parts required:
 *
 * 1. the turn has a `turn/start`, so the turn is a complete host turn;
 * 2. exactly one `turn/end` for that turn, with `reason.kind === 'completed'` —
 *    a repeated or abnormal end is ambiguous and delivers nothing;
 * 3. the turn's highest host step is known (from `step/start`/`step/end` and
 *    the assistant messages themselves), and the final message sits in that
 *    step — an earlier step's text is an intermediate answer, even when no
 *    later text was written;
 * 4. that message carries no `interrupted` marker and has non-empty text;
 * 5. it appears BEFORE the `turn/end` — text that arrives after the turn ended
 *    belongs to nothing and can never be retro-fitted onto the completed turn.
 *
 * `assistant/attempt` records, aborted/errored/interrupted turns, other turns'
 * replies, and delegated sessions can never bind a delivery. A delivery proves
 * only that an answer was handed to the user — never that it was accurate,
 * sufficient, or that any execution happened.
 */

export interface TrustedDelivery {
  turn: number
  turnEndSeq: number
  responseSeq: number
  responseSha256: string
}

interface AssistantRecord {
  seq: number
  step: number
  text: string
  interrupted: boolean
}

interface TurnFacts {
  started: boolean
  steps: Set<number>
  assistants: AssistantRecord[]
  ends: Array<{ seq: number; kind: string }>
}

function assistantTextOf(data: unknown): string {
  const record = data as { message?: { content?: Array<{ type?: string; text?: string }> } } | undefined
  return (record?.message?.content ?? [])
    .filter((part) => part?.type === 'text')
    .map((part) => part?.text ?? '')
    .join('\n')
}

function integerField(data: unknown, field: string): number | undefined {
  const value = (data as Record<string, unknown> | undefined)?.[field]
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

/**
 * Derive the trusted deliveries from the event log. Deterministic: a replay of
 * identical events yields identical facts.
 */
export function deriveTrustedDeliveries(events: readonly DerivedEnvelope[]): TrustedDelivery[] {
  const turns = new Map<number, TurnFacts>()
  const factsFor = (turn: number): TurnFacts => {
    let facts = turns.get(turn)
    if (!facts) {
      facts = { started: false, steps: new Set(), assistants: [], ends: [] }
      turns.set(turn, facts)
    }
    return facts
  }

  for (const event of events) {
    switch (event.type) {
      case 'turn/start': {
        const turn = integerField(event.data, 'turn')
        if (turn !== undefined) factsFor(turn).started = true
        break
      }
      case 'step/start':
      case 'step/end': {
        const turn = integerField(event.data, 'turn')
        const step = integerField(event.data, 'step')
        if (turn !== undefined && step !== undefined) factsFor(turn).steps.add(step)
        break
      }
      case 'assistant/message': {
        const turn = integerField(event.data, 'turn')
        const step = integerField(event.data, 'step')
        if (turn === undefined || step === undefined) break
        const facts = factsFor(turn)
        facts.steps.add(step)
        facts.assistants.push({
          seq: event.seq,
          step,
          text: assistantTextOf(event.data),
          interrupted: (event.data as { interrupted?: unknown } | undefined)?.interrupted === true,
        })
        break
      }
      case 'turn/end': {
        const turn = integerField(event.data, 'turn')
        if (turn === undefined) break
        const reason = (event.data as { reason?: { kind?: unknown } } | undefined)?.reason
        factsFor(turn).ends.push({ seq: event.seq, kind: typeof reason?.kind === 'string' ? reason.kind : '' })
        break
      }
      default:
        break
    }
  }

  const deliveries: TrustedDelivery[] = []
  for (const [turn, facts] of turns) {
    if (!facts.started) continue
    // A repeated or abnormal turn end is ambiguous: nothing is delivered.
    if (facts.ends.length !== 1) continue
    const end = facts.ends[0]!
    if (end.kind !== 'completed') continue
    if (facts.steps.size === 0) continue
    const finalStep = Math.max(...facts.steps)
    const inFinalStep = facts.assistants.filter((row) =>
      row.step === finalStep && row.seq < end.seq && !row.interrupted && row.text.trim().length > 0)
    if (inFinalStep.length === 0) continue
    const final = inFinalStep.reduce((left, right) => (right.seq > left.seq ? right : left))
    // Nothing else the turn produced may follow the claimed final answer.
    if (facts.assistants.some((row) => row.seq > final.seq && row.seq < end.seq)) continue
    deliveries.push({
      turn,
      turnEndSeq: end.seq,
      responseSeq: final.seq,
      responseSha256: sha256(final.text),
    })
  }
  return deliveries.sort((left, right) => left.turnEndSeq - right.turnEndSeq)
}

/**
 * The information-slot items a delivery closes: obligations captured from a
 * root message inside the delivered turn, in the unit that turn's input
 * belonged to (or in one of that unit's delegated sub-units), whose semantic
 * slot is information (an inquiry or an explanation request). Execution,
 * constraints, and unknowns are never closed by delivery, and neither are
 * questions from earlier messages.
 *
 * An ATTACHMENT obligation (one with an `asset` identity) closes through its
 * CURRENT interpretation instead of its original message (0.6.1 W060-01
 * review): a re-interpreted old asset would otherwise never close, because
 * its root message can no longer belong to a live turn. The binding is the
 * interpretation fact itself — the delivery must be the answer of the turn
 * that recorded the interpretation, and the fact must exist at the delivery
 * watermark. The final answer — even a real one — still never interprets
 * images on the model's behalf.
 */
export function informationItemIdsForDelivery(
  items: ReadonlyMap<string, { status: string; unitId?: string; sourceMessageId: string; taskKind?: string; authorityDisposition?: string; kind: string; asset?: unknown }>,
  delivery: TrustedDelivery,
  turnRootInputSeqs: ReadonlySet<number>,
  eligibleUnitIds: ReadonlySet<string> | undefined,
  interpretationFacts?: ReadonlyArray<{ itemId: string; turn: number; resultSeq: number }>,
): string[] {
  const closed: string[] = []
  for (const [itemId, item] of items) {
    if (item.status !== 'pending') continue
    if (item.kind === 'prohibition') continue
    const isAssetObligation = item.asset !== undefined && item.asset !== null
    // Unit discipline binds every obligation that was captured INTO a unit.
    // A unit-less item reaches its own gate below: assets keep it (a
    // unit-less opening asset closes only through its current
    // interpretation), and any other unit-less item is pre-v5 and already
    // excluded from delivery closure by the derivation's boundary check.
    if (item.unitId !== undefined && eligibleUnitIds !== undefined && !eligibleUnitIds.has(item.unitId)) continue
    const informationSlot = item.taskKind === 'inquiry'
      || (item.authorityDisposition === 'informational' && item.kind === 'requirement')
    const isAssetObligation2 = item.asset !== undefined && item.asset !== null
    if (isAssetObligation) {
      const interpretedThisTurn = (interpretationFacts ?? []).some((fact) =>
        fact.itemId === itemId && fact.turn === delivery.turn && fact.resultSeq <= delivery.turnEndSeq)
      if (!interpretedThisTurn) continue
      closed.push(itemId)
      continue
    }
    if (informationSlot) {
      // Two closable routes for an information obligation: an EXPLICIT
      // interpretation partition recorded for it this turn (a sub-item of a
      // superseded unresolved clause — review round 10), or the clause's own
      // root message belonging to the delivered turn (a grammatical
      // question, a past report, an output request). A whole-item
      // confirmation without a partition never closes anything.
      const interpretedThisTurn = (interpretationFacts ?? []).some((fact) =>
        fact.itemId === itemId && fact.turn === delivery.turn && fact.resultSeq <= delivery.turnEndSeq)
      const sourceSeq = /^m(\d+)(?::|$)/.exec(item.sourceMessageId)
      if (!interpretedThisTurn && (!sourceSeq || !turnRootInputSeqs.has(Number(sourceSeq[1])))) continue
      closed.push(itemId)
      continue
    }
    // Non-asset, non-informational, unresolved WITHOUT a partition: stays
    // pending. A whole-item interpretation confirmation is forbidden —
    // reading a clause does not answer its execution or unknown demands.
    continue
  }
  void delivery
  return closed
}

/** Bounded helper: extract text content already shared with the evidence reader. */
export { extractTextContent }
