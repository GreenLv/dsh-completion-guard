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

/** Parse control without rewriting the follow-up's authority wrappers. */
export function parseConfirmationMessage(text: string): ParsedConfirmation {
  const lines = text.split(/\r?\n/)
  const firstIndex = lines.findIndex(line => line.trim().length > 0)
  if (firstIndex < 0) return { kind: 'none' }
  const first = lines[firstIndex].trim()
  const match = CONFIRM_LINE_PATTERN.exec(first)
  if (!match) {
    if (!/确认重绑定|RB-[a-f0-9]{24}/.test(text)) return { kind: 'none' }
    if (/^(?:`{3,}|~{3,})/.test(first)) return { kind: 'malformed', reason: 'inside_code_fence' }
    if (/^(?:>|["“'『「])/.test(first)) return { kind: 'malformed', reason: 'quoted' }
    if (lines.slice(firstIndex + 1).some(line => CONFIRM_LINE_PATTERN.test(line.trim()))) {
      return { kind: 'ambiguous', reason: 'late_control_line' }
    }
    return { kind: 'malformed', reason: 'embedded_control_text' }
  }
  const tail = lines.slice(firstIndex + 1)
  // Require the documented blank separator before any follow-up content.
  if (tail.some(line => line.trim()) && tail[0].trim()) {
    return { kind: 'ambiguous', reason: 'multiple_control_lines' }
  }
  let fence: { marker: string; length: number } | undefined
  for (const raw of tail) {
    const line = raw.trim()
    const marker = /^(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = { marker: marker[0], length: marker.length }
      else if (marker[0] === fence.marker && marker.length >= fence.length && line === marker) fence = undefined
      continue
    }
    if (fence || line.startsWith('>')) continue
    if (/确认重绑定|RB-[a-f0-9]{24}/.test(line)) return { kind: 'ambiguous', reason: 'multiple_control_lines' }
    if (REVERSAL_LEAD.test(line)) return { kind: 'ambiguous', reason: 'reversal_in_remainder' }
  }
  return { kind: 'confirm', proposalId: match[1], remainder: tail.join('\n').trim() }
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
