import { normalizeClause, sanitizeClauseText, sha256 } from './canonicalize.js'
import { COMMAND_SURFACE_MANIFEST } from './manifest.js'
import type { GuardItem, GuardItemKind, GuardOperation } from './types.js'

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

const METHOD_TOOL = '(?:bash|shell|powershell|pwsh|git|read|write|edit|node|python|python3|npm|pnpm|tsc|vitest)'
const METHOD_ALIASES: Record<string, string> = { powershell: 'pwsh', python3: 'python' }
const METHOD_PATTERNS = [
  new RegExp(`(?:用|使用|通过|借助|利用|以)\\s*(${METHOD_TOOL})\\b`, 'i'),
  new RegExp(`\\b(?:via|using|use|with)\\s+(?:the\\s+)?(${METHOD_TOOL})\\b`, 'i'),
  new RegExp(`\\b(${METHOD_TOOL})\\s+(?:创建|写入|生成|修改|执行|运行|rename|create|write|modify)\\b`, 'i'),
]

/**
 * Detect an explicitly named tool/method in a clause ("使用 bash 创建",
 * "via bash", "bash to create"). Returns the canonical tool id (e.g. 'bash')
 * or undefined when no explicit method is named.
 */
export function extractMethod(text: string): string | undefined {
  for (const pattern of METHOD_PATTERNS) {
    const match = text.match(pattern)
    if (match) {
      const raw = match[1].toLowerCase()
      return METHOD_ALIASES[raw] ?? raw
    }
  }
  return undefined
}

const OPERATION_PATTERNS: Array<[GuardOperation, RegExp]> = COMMAND_SURFACE_MANIFEST.operationVerbs.map((entry) => [entry.op, new RegExp(entry.pattern, 'i')])

/**
 * Whether a whole user message reads as an informational report (acceptance
 * receipt, progress summary, pasted log) rather than a task instruction.
 * Evaluation is deliberately conservative: reports are detected only when the
 * shape is clearly report-like (markdown headings, bold key/value lines, list
 * or table rows, evidence terms) AND no sentence opens with an imperative, and
 * any question mark keeps the message a task. False positives here would drop
 * real instructions, so plain short sentences are never treated as reports.
 */
export function isInformationalMessage(text: string): boolean {
  if (!text.trim()) return false
  if (/[？?]|是否|是不是/.test(text)) return false
  const lines = text.split(/\r?\n/)
  const titledLines = lines.filter((line) => /^\s{0,3}#{1,6}\s+/.test(line)).length
  const evidenceLines = lines.filter((line) => /^\s*(?:[-*|]\s{0,2}|\*\*.+?\*\*)/.test(line)).length
  const evidenceTerms = (text.match(/\b(?:commit|passed|failed|exit\s+code|checkpoint|verify|回执|汇总|状态|通过|全绿|验收|读回|回读)\b|✓|\b[0-9a-f]{40}\b/g) ?? []).length
  const reportShape = (titledLines >= 1 && evidenceTerms >= 2)
    || (evidenceLines >= 2 && evidenceTerms >= 2)
    || evidenceTerms >= 4
  if (!reportShape) return false
  const imperativeLead = /^(?:请|请你|麻烦|帮我|需要你|你看看|看一下|检查一下|分析|列出|回顾|修复|推送|安装|确认|验证|能否|能不能)/i
  const sentences = text.split(/(?<=[。！？；\n])|(?<=[.!?])(?=\s|$)/)
  return !sentences.some((sentence) => imperativeLead.test(sentence.trim()))
}

/**
 * Detect an explicit operation/effect in a clause ("创建" → create,
 * "读取" → read, "运行" → run). Returns the first operation named, or undefined
 * when the clause requests no specific effect.
 */
export function extractOperation(text: string): GuardOperation | undefined {
  for (const [operation, pattern] of OPERATION_PATTERNS) {
    if (pattern.test(text)) return operation
  }
  return undefined
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

export function extractArtifactPaths(text: string): string[] {
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
  method?: string,
  operation?: GuardOperation,
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
      : { enforced: true, surface, subject, method, operation },
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
  const method = extractMethod(body)
  const operation = extractOperation(body)
  return captureItem(kind, body, sourceMessageId, id, revision, subject, surface, method, operation)
}
