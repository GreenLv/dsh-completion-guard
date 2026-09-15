import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { GuardProjection } from '../domain/types.js'

export interface InterpretToolOptions {
  getProjection: () => GuardProjection | undefined
  /**
   * 0.6.0 fresh-projection entry: flush, re-snapshot, and re-derive before
   * reading, so the attachment captured from THIS step's input is visible.
   */
  refreshProjection?: () => Promise<boolean>
}

/**
 * The per-asset interpretation entrypoint (0.6.1, W060-01).
 *
 * The model calls this AFTER actually reading one attached asset, passing the
 * obligation's item ID (from context_guard_prepare discovery). The tool
 * validates the obligation against the live contract and echoes the asset
 * identity the CONTRACT holds — never an identity the caller asserts. The
 * confirmed result is the durable interpretation record; replay derives the
 * fact from it.
 *
 * Deliberately minimal by contract (repair plan P0 §3): input is one item ID;
 * rejection reasons are enumerated; the state transition is
 * `uninterpreted → interpreted` on that one obligation; replay derives the
 * fact from the persisted result; and migration is birth-rule safe — logs
 * written before this entrypoint existed contain no records, so their assets
 * keep `pending` and can only close through CURRENT interpretation events.
 *
 * Separation of facts (W060-01): this record proves the attachment was read
 * and associated with its request — never that the reading is correct, and
 * never that any execution happened. It closes nothing by itself: the
 * obligation closes only when the host-confirmed final answer of the same
 * turn is also delivered, and a strict visual-readback proof stays its own
 * obligation.
 */
/** One validated sub-span of an interpretation partition. */
export interface PartitionSpan {
  start: number
  end: number
}

export interface InterpretationPartition {
  information: PartitionSpan[]
  unknown: PartitionSpan[]
}

function parsePartition(args: Record<string, unknown>, extent: { start: number; end: number }): InterpretationPartition | { error: string } {
  const read = (key: string): PartitionSpan[] | undefined => {
    const raw = args[key]
    if (raw === undefined) return undefined
    if (!Array.isArray(raw)) return undefined
    const spans: PartitionSpan[] = []
    for (const entry of raw) {
      const record = entry as Record<string, unknown> | undefined
      const start = record?.start
      const end = record?.end
      if (typeof start !== 'number' || !Number.isSafeInteger(start)
        || typeof end !== 'number' || !Number.isSafeInteger(end) || start >= end) return undefined
      spans.push({ start, end })
    }
    return spans
  }
  const information = read('information_spans')
  const unknown = read('unknown_spans')
  if (information === undefined || unknown === undefined) return { error: 'interpretation_partition_required' }
  if (information.length === 0) return { error: 'interpretation_partition_required' }
  // Coverage: every sub-span must sit inside the obligation's full input
  // extent; association: the sub-spans must not overlap each other.
  const all = [...information, ...unknown]
  for (const span of all) {
    if (span.start < extent.start || span.end > extent.end) return { error: 'interpretation_span_outside_input' }
  }
  const ordered = [...all].sort((left, right) => left.start - right.start || left.end - right.end)
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.start < ordered[index - 1]!.end) return { error: 'interpretation_spans_overlap' }
  }
  return { information, unknown }
}

/** The byte extent that covers every source span of one item. */
function itemExtent(spans: ReadonlyArray<{ start: number; end: number }>): { start: number; end: number } {
  return {
    start: Math.min(...spans.map((span) => span.start)),
    end: Math.max(...spans.map((span) => span.end)),
  }
}

export function createInterpretTool(options: InterpretToolOptions): ToolDefinition {
  return defineTool({
    name: 'context_guard_interpret',
    description: 'Record the interpretation of one unresolved obligation: pass the item ID from context_guard_prepare plus the partition of its input spans you read as information (information_spans) and the sub-spans you could not resolve (unknown_spans); for an attached asset, the partition is unnecessary. Contract bookkeeping only — performs no action, grants no authority. Information sub-spans close when this turn\'s host-confirmed final answer is delivered; unknown sub-spans remain pending obligations. Correctness is never certified.',
    parameters: {
      item_id: { type: 'string', required: true },
      information_spans: { type: 'array', items: { type: 'object', additionalProperties: true } },
      unknown_spans: { type: 'array', items: { type: 'object', additionalProperties: true } },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(rawArgs) {
      const args = rawArgs as { item_id?: unknown }
      const reject = (reason_code: string) => ({ status: 'rejected' as const, reason_code })
      if (options.refreshProjection) {
        let durable = false
        try {
          durable = await options.refreshProjection() === true
        } catch {
          durable = false
        }
        // The attachment was captured from this step's input; a failed flush
        // means the obligation may not be visible yet and nothing read back
        // would be trustworthy.
        if (!durable) return { status: 'unknown' as const, reason_code: 'projection_durability_unavailable' }
      }
      const p = options.getProjection()
      if (!p || !p.enabled || p.integrity !== 'valid') return reject('guard_unavailable')
      const itemId = typeof args.item_id === 'string' ? args.item_id.trim() : ''
      if (!itemId) return reject('item_not_found')
      const item = p.items.get(itemId)
      if (!item) return reject('item_not_found')
      if (item.status !== 'pending') return reject('item_not_pending')
      // Two obligation kinds are interpretable: an attached asset, and an
      // unresolved clause whose surface reading could not be resolved (a
      // declarative may or may not be a task requirement). Anything else has
      // its own closure lane already.
      if (!item.asset && item.authorityDisposition !== 'unresolved') return reject('not_interpretable')
      // The identity echo comes from the CONTRACT, not from the caller: the
      // model names which obligation it interpreted, and the guard binds the
      // identity it captured from the durable input itself — the asset triple
      // for attachments, the FULL source spans for a clause. The revision
      // lets replay re-validate the receipt against the exact obligation
      // generation it answered.
      if (item.asset) {
        return {
          status: 'recorded',
          item_id: item.id,
          item_revision: item.revision,
          kind: 'asset',
          asset: {
            message_seq: item.asset.messageSeq,
            part_index: item.asset.partIndex,
            media_sha256: item.asset.mediaSha256,
          },
          note: 'Interpretation recorded for this asset obligation. It closes when the host-confirmed final answer of this interpreting turn is delivered; this record never certifies the interpretation\'s correctness and never authorizes or proves any execution.',
        } as Record<string, JsonValue>
      }
      if (!item.spans || item.spans.length === 0) return reject('item_spans_unavailable')
      // 0.6.1 review round 10: an unresolved clause is unresolved precisely
      // because it may MIX an information demand with execution or still
      // unknown sub-demands. The interpretation is therefore a PARTITION, not
      // a whole-item confirmation: the caller submits the sub-spans it read
      // as information and the sub-spans it could not resolve. The guard
      // validates coverage and association against the contract's full input
      // spans; the information sub-item closes with this turn's delivery and
      // every unknown/execution sub-span remains a pending obligation.
      const extent = itemExtent(item.spans)
      const partition = parsePartition(args, extent)
      if ('error' in partition) return reject(partition.error)
      return {
        status: 'recorded',
        item_id: item.id,
        item_revision: item.revision,
        kind: 'clause',
        spans: item.spans.map((span) => ({ part_index: span.partIndex, start: span.start, end: span.end })),
        information_spans: partition.information.map((span) => ({ start: span.start, end: span.end })),
        unknown_spans: partition.unknown.map((span) => ({ start: span.start, end: span.end })),
        note: 'Interpretation partition recorded for this unresolved clause: information sub-spans close when the host-confirmed final answer of this interpreting turn is delivered; every unknown sub-span remains a pending obligation and must still be resolved or performed. This record never certifies correctness and never authorizes any execution.',
      } as Record<string, JsonValue>
    },
  })
}
