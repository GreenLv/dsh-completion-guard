import { createHash } from 'node:crypto'

export function normalizeClause(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
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
  value = value.replace(PLAIN_KEY, (_match) => `${_match.slice(0, 3)}-<redacted>`)
  // Strip URL query strings and fragments: both routinely carry credentials.
  value = value.replace(/https?:\/\/[^\s'"`，。)]+[?#][^\s'"`，。)]*/g, (match) => {
    const cut = Math.min(
      ...['?', '#'].map((marker) => {
        const index = match.indexOf(marker)
        return index === -1 ? Infinity : index
      }),
    )
    return cut === Infinity ? match : `${match.slice(0, cut)}\u2026`
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
  return cut === Infinity ? value : value.slice(0, cut)
}
