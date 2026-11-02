// A suffix is a nonempty sequence of ASCII letters or digits. Keep the same
// grammar for standalone names, relative paths and CJK-adjacent paths; no
// arbitrary extension-length limit is part of the filename contract.
const ASCII_SUFFIX = '[A-Za-z0-9]+'
const SUFFIX_AT_END = new RegExp(`\\.${ASCII_SUFFIX}$`, 'u')
const SUFFIX_BEFORE_CJK = new RegExp(`^(.*?\\.${ASCII_SUFFIX})([\\u3400-\\u9fff].*)$`, 'u')
const FILENAME = new RegExp(`(?<![\\p{L}\\p{N}_.])[\\p{L}\\p{N}_@+~.\\-]+\\.${ASCII_SUFFIX}(?![A-Za-z0-9_.])`, 'gu')

/**
 * Classification-only view of complete locator objects. It preserves UTF-16
 * offsets and newlines; callers retain the original source for authority
 * lexing, stored text, hashes and byte spans. Ambiguous prose stays visible.
 */
export function maskLocatorObjects(text: string): string {
  let view = text
  const blank = (value: string): string => value.replace(/[^\n]/g, ' ')
  const locator = /^(?:https?:\/\/|codex:\/\/|[A-Za-z]:[\\/]|\\\\|\/|\.{1,2}[\\/]|~\/)/i
  const bare = (value: string): boolean => {
    if (/[\s[\]()<>]/u.test(value)) return false
    const parts = value.split(/[\\/]/u)
    return SUFFIX_AT_END.test(parts.at(-1) ?? '')
  }
  // A slash sequence alone is ambiguous ("verify/test/build" may be an
  // instruction). Only an explicit object position makes an extensionless
  // relative path data; do not infer that from the number of segments.
  const relativeObject = (value: string, before: string, after: string): boolean => {
    if (/[\s[\]()<>\u3400-\u9fff]/u.test(value) || !/[\\/]/u.test(value)) return false
    return /(?:\b(?:read|open|load|view|inspect|browse|access|use|check|verify|in|from|at|under|within)\s+(?:(?:the|this|a)\s+)?|(?:读取|打开|查看|浏览|访问|路径|目录|位于)\s*|\]\(\s*)$/iu.test(before)
      || /^\s*中\s*(?:读取|查看|打开|浏览|访问)/u.test(after)
  }
  // A quoted single token can be a locator. Whitespace makes the quotation
  // ambiguous, so leave it to the later token scan and retain any prose.
  view = view.replace(/"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|“[^”\n]*”|‘[^’\n]*’|「[^」\n]*」|『[^』\n]*』/gu, (value, offset: number) => {
    const inner = value.slice(1, -1)
    if (/\s/u.test(inner)) return value
    return locator.test(inner) || bare(inner) || relativeObject(inner, view.slice(0, offset), view.slice(offset + value.length)) ? blank(value) : value
  })
  // Prefixes and relative paths must be complete tokens. Slash-joined actions
  // remain visible unless an explicit object position or suffix identifies data.
  view = view.replace(/(?<![\p{L}\p{N}_:/\\])(?:https?:\/\/|codex:\/\/|[A-Za-z]:[\\/]|\\\\|\/|\.{1,2}[\\/]|~\/)[^\s,;，；。!?！？'"`<>()[\]]+|(?<![\p{L}\p{N}_:/\\])(?:[\p{L}\p{N}_@.+~-]+[\\/])+[\p{L}\p{N}_@.+~\\/-]+/giu, (value, offset: number) => {
    const adjacent = SUFFIX_BEFORE_CJK.exec(value)
    if (adjacent && (locator.test(adjacent[1]!) || bare(adjacent[1]!))) return blank(adjacent[1]!) + adjacent[2]
    return locator.test(value) || bare(value) || relativeObject(value, view.slice(0, offset), view.slice(offset + value.length)) ? blank(value) : value
  })
  // A basename is data independent of the application's file extension.
  // CJK adjacent to the suffix remains visible as possible prose.
  return view.replace(FILENAME, blank)
}
