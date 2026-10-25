import { createHash } from 'node:crypto'
import * as path from 'node:path'

export function normalizeClause(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

// A path is Windows-style when it carries a drive letter, a UNC prefix (in
// either separator spelling), or any backslash separator; everything else is
// treated as POSIX-style.
function isWindowsStylePath(value: string): boolean {
  return /^[A-Za-z]:/.test(value) || value.startsWith('\\\\') || value.startsWith('//') || value.includes('\\')
}

/**
 * Canonicalize a filesystem path for subject matching. Windows-style paths are
 * normalized (drive letter, both separator kinds, `.`/`..`, duplicate
 * separators) and case-folded, because Windows paths compare case-insensitively
 * and treat `/` and `\` as equivalent. POSIX-style paths are normalized but
 * keep their case, so a case-sensitive filesystem is never made insensitive.
 * Exactly one canonicalizer is shared by contract capture and evidence
 * extraction so a Windows contract subject and a Windows evidence subject match.
 */
export function canonicalizePath(value: string): string {
  if (!value) return value
  return isWindowsStylePath(value)
    ? path.win32.normalize(value).toLowerCase()
    : path.posix.normalize(value)
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function digestStrings(values: readonly string[]): string {
  return sha256(values.slice().sort().join('\n'))
}

const KEYS = '(?:authorization|proxy-authorization|api[-_]?key|token|cookie|set-cookie|password|secret|session[-_]?id)'
const SENSITIVE_KEYS = `("${KEYS}"|'${KEYS}'|${KEYS})`
// Header values (Authorization, Cookie, etc.) are redacted whole to the end of
// the clause: Basic credentials, bearer tokens, and `;`-separated cookie pairs
// must never survive a generic single-token match.
const HEADER_VALUE = /(authorization|proxy-authorization|cookie|set-cookie)\s*:\s*.+$/gi
const DOUBLE_QUOTED = new RegExp(`${SENSITIVE_KEYS}\\s*[:=]\\s*"(?:\\\\.|[^"\\\\])*"`, 'gi')
const SINGLE_QUOTED = new RegExp(`${SENSITIVE_KEYS}\\s*[:=]\\s*'(?:\\\\.|[^'\\\\])*'`, 'gi')
const UNCLOSED_DOUBLE = new RegExp(`${SENSITIVE_KEYS}\\s*[:=]\\s*"(?:\\\\.|[^"\\\\])*\\\\?$`, 'gi')
const UNCLOSED_SINGLE = new RegExp(`${SENSITIVE_KEYS}\\s*[:=]\\s*'(?:\\\\.|[^'\\\\])*\\\\?$`, 'gi')
const BARE_VALUE = new RegExp(`${SENSITIVE_KEYS}\\s*[:=]\\s*[^\\s,;'"\`)\\]}]+`, 'gi')
const BEARER_TOKEN = /\bbearer\s+[A-Za-z0-9._~+/=-]+/gi
const PLAIN_KEY = /\b(?:sk|pk|ak)-[a-zA-Z0-9_-]{16,}\b/g
// Bounded well-known token FAMILIES (GitHub app/user PAT spellings). Shape
// recognition only: this is not a claim about arbitrary secret formats.
const NAMED_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{22,})\b/g
// URL userinfo: everything in the authority up to the first '/', '?' or '#'
// before an '@' is `user[:password]`. Removing it keeps every other byte.
const URL_USERINFO = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*@/

/**
 * Structurally trim one prose span down to the URL it actually contains
 * (RF03, round 2): RFC 3986 sub-delims — including `(` and `)` — are legal
 * INSIDE the authority and path, so a parenthesis may end the span only when
 * it is prose punctuation, not part of the URL. Markdown's balance rule
 * decides that deterministically: strip trailing `)` while the span has more
 * closing than opening parentheses. A `)` in the middle of the span (e.g.
 * inside the userinfo `oper)ator:`) never sees this rule; only the tail is
 * examined. `(see https://x)` keeps the outer paren outside; a URL that
 * really ends in a balanced `(…)` keeps it.
 */
function trimSpanToUrl(match: string): string {
  const openCount = (match.match(/\(/g) ?? []).length
  let span = match
  while (span.endsWith(')') && (span.match(/\)/g) ?? []).length > openCount) span = span.slice(0, -1)
  return span
}

/** Structurally remove `user:password@` from a URL; other bytes unchanged. */
export function stripUrlCredentials(value: string): string {
  return URL_USERINFO.test(value) ? value.replace(URL_USERINFO, (match) => match.slice(0, match.indexOf('//') + 2)) : value
}

export function sanitizeClauseText(text: string): string {
  let value = text
  const label = (key: string) => `${key.replace(/^["']|["']$/g, '')}=<redacted>`
  // Bearer before headers: the header matcher would otherwise consume only
  // the word "Bearer" and leave the token value behind.
  value = value.replace(BEARER_TOKEN, 'bearer <redacted>')
  value = value.replace(HEADER_VALUE, (_match, key: string) => `${key}=<redacted>`)
  // Quoted values first (escape-aware), then unclosed-quote fail-closed, then bare.
  value = value.replace(DOUBLE_QUOTED, (_match, key: string) => label(key))
  value = value.replace(SINGLE_QUOTED, (_match, key: string) => label(key))
  value = value.replace(UNCLOSED_DOUBLE, (_match, key: string) => label(key))
  value = value.replace(UNCLOSED_SINGLE, (_match, key: string) => label(key))
  value = value.replace(BARE_VALUE, (_match, key: string) => label(key))
  value = value.replace(PLAIN_KEY, (match) => `${match.slice(0, 3)}-<redacted>`)
  value = value.replace(NAMED_TOKEN, (match) => `${match.slice(0, match.indexOf('_') + 1)}<redacted>`)
  // URL credentials and query/fragment are structural, not label-shaped.
  // RF03: the clause matcher follows URL authority semantics like sanitizeUrl
  // does — the scheme is case-insensitive (HTTPS:// is the same scheme), the
  // scheme grammar covers every RFC 3986 scheme (userinfo is not http-only),
  // RFC 3986 sub-delims (`!$&'()*+,;=`) are legal authority/path characters,
  // and only the tail parenthesis is prose punctuation, decided by the
  // balance rule in trimSpanToUrl. Remaining text boundaries (whitespace,
  // quotes, CJK punctuation) end the raw span before that rule runs.
  value = value.replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"`，。]+/g, (match) => {
    const span = trimSpanToUrl(match)
    // Parentheses stripped by the balance rule belong to the surrounding
    // prose: they are appended back to the replacement verbatim so the
    // sentence keeps its own brackets while the URL loses its credentials.
    const restoredParens = ')'.repeat(match.length - span.length)
    const cut = Math.min(
      ...['?', '#'].map((marker) => {
        const index = span.indexOf(marker)
        return index === -1 ? Infinity : index
      }),
    )
    const withoutQuery = cut === Infinity ? span : span.slice(0, cut)
    return `${stripUrlCredentials(withoutQuery)}${cut === Infinity ? '' : '\u2026'}${restoredParens}`
  })
  return value
}

export function sanitizeUrl(value: string): string {
  const cut = Math.min(
    ...['?', '#'].map((marker) => {
      const index = value.indexOf(marker)
      return index === -1 ? Infinity : index
    }),
  )
  return stripUrlCredentials(cut === Infinity ? value : value.slice(0, cut))
}
