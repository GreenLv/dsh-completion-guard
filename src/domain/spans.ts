/**
 * 0.6.0 source-span helpers (C01).
 *
 * Spans are UTF-8 BYTE half-open intervals `[start, end)` inside the original
 * root message text. All conversions go through TextEncoder byte counting —
 * JavaScript string indices are never allowed to masquerade as cross-language
 * positions, so a Python reader agrees with TypeScript on every boundary.
 */

const encoder = new TextEncoder()

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).length
}

/** Byte offset of `index` inside `text`: the UTF-8 length of the prefix. */
export function utf8ByteOffset(text: string, index: number): number {
  return utf8ByteLength(text.slice(0, index))
}

export type SpanClass = 'instruction' | 'adoption' | 'question' | 'constraint'

/**
 * The coverage class of one captured clause: a prohibition is a constraint,
 * an informational reading is a question, an adopted block stays adoption,
 * and everything else is an instruction. Nothing captured is left unclassed.
 */
export function spanClassOf(kind: string, directive: string | undefined, authority: string): SpanClass {
  if (authority === 'root_adoption') return 'adoption'
  if (kind === 'prohibition') return 'constraint'
  if (directive === 'informational' || directive === 'narrative') return 'question'
  return 'instruction'
}
