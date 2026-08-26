import { normalizeClause, sanitizeClauseText, sha256 } from './canonicalize.js'
import type { GuardItem, GuardItemKind } from './types.js'

const CLAUSE_PATTERNS: Array<[GuardItemKind, RegExp]> = [
  ['prohibition', /^(?:(?:do not|don't|never)(?![A-Za-z0-9_./@\\-])|禁止|不要|不得)\s*(.+)$/i],
  ['acceptance', /^(?:verify|confirm|ensure|验收|确认|确保)\s*(.+)$/i],
]

export interface ClassifiedClause {
  kind: GuardItemKind
  body: string
}

export function classifyClause(text: string): ClassifiedClause {
  const normalizedText = normalizeClause(text)
  for (const [kind, pattern] of CLAUSE_PATTERNS) {
    const match = normalizedText.match(pattern)
    if (match) return { kind, body: normalizeClause(match[1].replace(/^[:：,，\s]+/, '')) }
  }
  return { kind: 'requirement', body: normalizedText }
}

export interface CaptureScope {
  /** Session working directory; used as the scope subject when no artifact path is named. */
  cwd?: string
}

const EXTENSION = '(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|c|cpp|h|hpp|cs|rb|php|vue|svelte|md|mdx|json|jsonc|yml|yaml|toml|ini|cfg|sh|bash|zsh|fish|ps1|html|css|scss|less|sql|txt|lock|mod|sum|env|patch|diff|pkl|tf|hcl|proto)'
const EXTENSION_TAIL = new RegExp(`\\.${EXTENSION}(?:$|[^A-Za-z0-9])`, 'i')

function isArtifactCandidate(value: string): boolean {
  return EXTENSION_TAIL.test(value)
}

/** Wrapped path spellings: backticks, double/single quotes, and parentheses. */
const WRAPPED_PATH = /`([^`]+)`|"([^"]+)"|'([^']+)'|\(([^()]+)\)/g

function extractArtifactPaths(text: string): string[] {
  const found = new Set<string>()
  const push = (candidate: string) => {
    const trimmed = candidate.trim()
    if (trimmed && isArtifactCandidate(trimmed)) found.add(trimmed)
  }
  for (const match of text.matchAll(WRAPPED_PATH)) {
    push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? '')
  }
  // Bare tokens (no whitespace), Unicode-inclusive; strip trailing punctuation.
  for (const token of text.split(/[\s,;，；]+/)) {
    const bare = token.replace(/^[('"]+|['")]+$/g, '').replace(/[。！？；.!?，,；:：]+$/, '')
    if (bare && !bare.includes('`') && isArtifactCandidate(bare)) found.add(bare)
  }
  return [...found]
}

/**
 * Split a single human message into independently tracked clauses. Sentence
 * boundaries and embedded prohibition keywords delimit segments so a compound
 * instruction such as "Modify src/a.ts and src/b.ts. Do not push." yields
 * separate items instead of collapsing into one artifact.
 */
export interface ClauseSegment {
  kind: GuardItemKind
  body: string
  paths: string[]
}

export function segmentClauses(text: string): ClauseSegment[] {
  const normalized = normalizeClause(text)
  if (!normalized) return []
  const parts = normalized
    .split(/(?<=[。！？；])|(?<=[.!?])(?=\s|$)|(?<=(?:^|[\s。！？；.!?，,；:]))(?=(?:(?:do not|don't|never)(?![A-Za-z0-9_./@\\-])|禁止|不要|不得))/i)
    .map((part) => part.trim())
    .filter(Boolean)
  const segments: ClauseSegment[] = []
  for (const part of parts) {
    const { kind, body } = classifyClause(part)
    segments.push({ kind, body, paths: extractArtifactPaths(body) })
  }
  return segments
}

/**
 * Build a GuardItem from an already-classified clause body and a resolved
 * verification subject/surface.
 */
export function captureItem(
  kind: GuardItemKind,
  body: string,
  sourceMessageId: string,
  id: string,
  revision: number,
  subject: string,
  surface: 'artifact' | 'scope',
): GuardItem {
  const sanitized = sanitizeClauseText(body)
  return {
    id,
    revision,
    kind,
    sourceMessageId,
    normalizedText: sanitized,
    textSha256: sha256(sanitized),
    status: 'pending',
    verification: kind === 'prohibition'
      ? { enforced: false, surface, subject }
      : { enforced: true, surface, subject },
  }
}

/**
 * Capture one contract clause. Every captured item receives a concrete
 * verification contract: a named artifact path (artifact surface) or the
 * session scope (scope surface), so an unrelated file read can never close it.
 */
export function captureClause(
  text: string,
  sourceMessageId: string,
  id: string,
  revision: number,
  scope: CaptureScope = {},
): GuardItem {
  const { kind, body } = classifyClause(text)
  const path = extractArtifactPaths(sanitizeClauseText(body))[0] ?? ''
  const surface = path ? 'artifact' as const : 'scope' as const
  const subject = path || scope.cwd || 'scope'
  return captureItem(kind, body, sourceMessageId, id, revision, subject, surface)
}
