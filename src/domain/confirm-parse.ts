/**
 * 0.5 confirmation-line grammar (A10/A11).
 *
 * A durable root message may carry AT MOST ONE rebind confirmation as a
 * restricted top-level control line; everything after it is follow-up content
 * processed with its own semantics. The parser is intentionally conservative:
 * - only the first non-empty top-level line can be a control line;
 * - lines inside code fences, quoted lines, and blockquote/forward wrappers
 *   are data, never control;
 * - an embedded or mid-sentence control string is `malformed`, never a
 *   confirmation;
 * - a matching control line that is NOT in first position, or an explicit
 *   reversal in the remainder, makes the whole message `ambiguous` (stays
 *   unconfirmed; no partial effect).
 */
export type ParsedConfirmation =
  | { kind: 'none' }
  | { kind: 'malformed'; reason: 'embedded_control_text' | 'inside_code_fence' | 'quoted' }
  | { kind: 'ambiguous'; reason: 'multiple_control_lines' | 'late_control_line' | 'reversal_in_remainder' }
  | { kind: 'confirm'; proposalId: string; remainder: string }

export const CONFIRM_LINE_PATTERN: RegExp = /^确认重绑定 (RB-[a-f0-9]{24})$/

const REVERSAL_LEAD: RegExp = /^(?:不要确认|请勿确认|取消(?:确认|刚才的)?|撤销(?:确认|刚才的)?|先不(?:要)?确认|暂不确认|先别确认|别确认)/

interface Line { text: string; blank: boolean; fenced: boolean; quoted: boolean }

function classifyLines(text: string): Line[] {
  let fenced = false
  return text.split(/\r?\n/).map((raw) => {
    const trimmed = raw.trim()
    if (/^(?:```|~~~)/.test(trimmed)) fenced = !fenced
    // A line inside a fence is data; the fence markers themselves too.
    const isFenceRow = fenced || /^(?:```|~~~)/.test(trimmed)
    return {
      text: trimmed,
      blank: trimmed.length === 0,
      fenced: isFenceRow,
      quoted: trimmed.startsWith('>'),
    }
  })
}

/**
 * Parse one canonical root user message for a rebind confirmation. Pure and
 * deterministic over the message text alone.
 */
export function parseConfirmationMessage(text: string): ParsedConfirmation {
  const lines = classifyLines(text)
  const content = lines.filter((line) => !line.blank && !line.fenced)
  if (content.length === 0) return { kind: 'none' }

  const controlLines = content.filter((line) => CONFIRM_LINE_PATTERN.test(line.text))
  const mentionsControl = content.filter((line) => /确认重绑定|RB-[a-f0-9]{24}/.test(line.text))
  const first = content[0]

  // The whole first line is inside a quote or wraps the control text in
  // quotation marks: treated as quoted data, never a confirmation.
  if (first.quoted || /^["“'『「].*["”'』」]$/.test(first.text)) {
    return mentionsControl.length > 0
      ? { kind: 'malformed', reason: 'quoted' }
      : { kind: 'none' }
  }

  if (CONFIRM_LINE_PATTERN.test(first.text)) {
    if (controlLines.length > 1) return { kind: 'ambiguous', reason: 'multiple_control_lines' }
    const remainderLines = content.slice(1).map((line) => line.text)
    if (remainderLines.some((line) => CONFIRM_LINE_PATTERN.test(line) || /确认重绑定|RB-[a-f0-9]{24}/.test(line))) {
      return { kind: 'ambiguous', reason: 'multiple_control_lines' }
    }
    const remainder = remainderLines.join('\n').trim()
    if (remainder && REVERSAL_LEAD.test(remainder)) {
      return { kind: 'ambiguous', reason: 'reversal_in_remainder' }
    }
    return { kind: 'confirm', proposalId: CONFIRM_LINE_PATTERN.exec(first.text)![1], remainder }
  }

  // A control line appearing only LATER in the message is misplaced control:
  // ambiguous, never silently applied.
  if (controlLines.length > 0) return { kind: 'ambiguous', reason: 'late_control_line' }
  // Embedded control text in prose (same sentence, code spans, garbled IDs):
  // a format error the model can report, never a confirmation.
  if (mentionsControl.length > 0) return { kind: 'malformed', reason: 'embedded_control_text' }
  return { kind: 'none' }
}

/** Whether a recorded tool/result carries the frozen v0.4.x response shape. */
export function isFrozenV042RebindResponse(recorded: unknown): boolean {
  if (!recorded || typeof recorded !== 'object') return false
  const nextStep = (recorded as { next_step?: unknown }).next_step
  if (typeof nextStep !== 'string') return false
  return nextStep.startsWith('Root user must reply exactly: 确认重绑定 ')
    || nextStep === 'Supply 1-8 exact consecutive clauses covering the original text, including unsupported work; the proposal must fit 8 KiB. Clarification that changes meaning requires a new root-user instruction.'
    || nextStep === 'Propose again against the current contract.'
}
