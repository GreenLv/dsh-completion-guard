import { sanitizeUrl, sha256 } from './canonicalize.js'
import type { EvidenceOutcome, GuardEvidence } from './types.js'

export interface ToolCallInput {
  callId: string
  name: string
  arguments: string
  /** Code-mode dispatch root; falls back to `callId` when the harness does not carry one. */
  rootCallId?: string
}

export interface ToolResultInput {
  seq: number
  error?: unknown
  meta?: unknown
  textContent: string
}

function boundedSummary(value: string): string {
  return value.length > 240 ? `${value.slice(0, 237)}...` : value
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

export function extractTextContent(content: readonly unknown[]): string {
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (!record) continue
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
    if (record.type === 'tool-result' && Array.isArray(record.content)) {
      parts.push(extractTextContent(record.content))
    }
  }
  return parts.join('\n')
}

function metaPaths(meta: unknown): string[] {
  const record = asRecord(meta)
  if (!record) return []
  if (typeof record.path === 'string') return [record.path]
  if (Array.isArray(record.diffs)) {
    return record.diffs
      .map((diff) => asRecord(diff)?.path)
      .filter((path): path is string => typeof path === 'string')
  }
  return []
}

function argsPaths(args: Record<string, unknown>): string[] {
  const filePath = args.file_path
  if (typeof filePath === 'string') return [filePath]
  return []
}

function extractBashSubjects(command: string, workdir: unknown): string[] {
  const cwd = typeof workdir === 'string' ? [workdir] : []
  const paths = command.match(/(?:^|\s)([./~][^\s'"`]+)/g)?.map((value) => value.trim()) ?? []
  return [...cwd, ...paths]
}

function extractExitCode(textContent: string): number | undefined {
  // Only the LAST marker counts: a leading fake marker (e.g. echoed text)
  // must never mask a real trailing nonzero exit.
  const matches = [...textContent.matchAll(/\[exit code:\s*(\d+)\]/g)]
  const match = matches.at(-1)
  return match ? Number(match[1]) : undefined
}

function metaUrls(meta: unknown): string[] {
  const record = asRecord(meta)
  if (!record) return []
  if (typeof record.url === 'string') return [sanitizeUrl(record.url)]
  if (Array.isArray(record.sources)) {
    return record.sources
      .map((source) => asRecord(source)?.url)
      .filter((url): url is string => typeof url === 'string')
      .map((url) => sanitizeUrl(url))
  }
  return []
}

const DETERMINISTIC_CHECK_PATTERNS = [
  /\b(?:pnpm|npm|yarn|bun)\s+(?:test|tst|lint|check|typecheck|build)\b/,
  /\b(?:cargo|go|make|cmake|pytest|vitest|jest|eslint|tsc|mypy|ruff|prettier)\b/,
  /\b(?:mvn|gradle)\s+(?:test|check)\b/,
]

/** Prefixes that only quote or print a command without running a check. */
const NON_RUNNING_PREFIXES = [
  /^\s*(?:echo|printf|echo\s+-e|cat|tee|true|false|:|#)\b/,
  /\b(?:echo|printf)\s+[^|;&]*["'][^"']*(?:test|lint|build|check)[^"']*["'][^]|;&]*$/i,
]

/** Discovery/version/inspection commands, not verification runs. */
const INSPECTION_COMMANDS = /\b(?:which|where|whereis|type|command\s+-v|grep|rg|cat|less|head|tail|find|ls|dir)\b|\s(?:--version|-V|-v)\s*$|\s--version\b/i

/** Shell constructs that mask the real exit status or detach the check. */
const MASKING_CONSTRUCTS = [
  /\|\|/,
  /;/,
  /\|/,
  /(?:^|\s)&(?!&)\s*$/,
  /(?:^|\s)&(?!&)\s*(?:disown)?/,
  /\((?:.*\s&(?!&)\s*)\)\s*$/,
  /\b(?:nohup|setsid)\b/,
  /\|\s*(?:true|:)\s*$/,
]

export function isDeterministicCheck(command: string): boolean {
  const normalized = command.trim().replace(/\s+/g, ' ')
  if (!normalized || normalized.startsWith('#')) return false
  // A standalone `!` at any shell control position negates the exit status, so
  // a failing check becomes a false success. Reject it wherever it acts as an
  // operator (after start, space, `&&`, `||`, `;`, `|`, or an opening paren).
  if (/(?:^|[\s&|;(])\s*!(?=\s*[A-Za-z0-9/_.-])/.test(normalized)) return false
  if (NON_RUNNING_PREFIXES.some((pattern) => pattern.test(normalized))) return false
  if (INSPECTION_COMMANDS.test(normalized)) return false
  if (MASKING_CONSTRUCTS.some((pattern) => pattern.test(normalized))) return false
  // A leading `cd <dir> &&` wrapper is fine; `&&` chaining is allowed, pipes,
  // semicolons, and negation are not.
  const withoutCd = normalized.replace(/^cd\s+[^;&|]+\s*(?:&&|;)\s*/, '')
  return DETERMINISTIC_CHECK_PATTERNS.some((pattern) => pattern.test(withoutCd))
}

export interface ToolSubject {
  capabilities: string[]
  subjects: string[]
  surfaces: Array<'artifact' | 'ui' | 'visual' | 'scope'>
  outcome?: EvidenceOutcome
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

export function extractToolSubject(call: ToolCallInput, result: ToolResultInput): ToolSubject {
  const args = parseArguments(call.arguments)
  switch (call.name) {
    case 'read':
    case 'read_file':
      return {
        capabilities: ['filesystem-read'],
        subjects: unique([...metaPaths(result.meta), ...argsPaths(args)]),
        surfaces: ['artifact'],
      }
    case 'write':
    case 'write_file':
      return {
        capabilities: ['filesystem-write'],
        subjects: unique([...metaPaths(result.meta), ...argsPaths(args)]),
        surfaces: ['artifact'],
      }
    case 'edit':
    case 'edit_file':
      return {
        capabilities: ['filesystem-edit'],
        subjects: unique([...metaPaths(result.meta), ...argsPaths(args)]),
        surfaces: ['artifact'],
      }
    case 'bash':
    case 'shell': {
      const command = typeof args.command === 'string' ? args.command : ''
      const exitCode = extractExitCode(result.textContent)
      const backgrounded = args.run_in_background === true
      const deterministic = !backgrounded && isDeterministicCheck(command)
      const outcome: EvidenceOutcome = backgrounded || exitCode === undefined
        ? 'unknown'
        : exitCode === 0 ? 'success' : 'failure'
      return {
        capabilities: ['shell', ...(deterministic ? ['deterministic-check'] : [])],
        subjects: unique(extractBashSubjects(command, args.workdir)),
        surfaces: ['scope'],
        outcome,
      }
    }
    case 'web_search':
    case 'web_fetch':
    case 'web_fetch_url':
      return {
        capabilities: ['web-fetch'],
        subjects: unique([...metaUrls(result.meta), ...(typeof args.url === 'string' ? [sanitizeUrl(args.url)] : [])]),
        surfaces: ['ui'],
      }
    default:
      return { capabilities: ['generic'], subjects: [], surfaces: [] }
  }
}

export function evidenceFromPersistedToolResult(
  call: ToolCallInput,
  result: ToolResultInput,
  epoch: number,
  evidenceId: string,
): GuardEvidence {
  const subject = extractToolSubject(call, result)
  const outcome: EvidenceOutcome = result.error ? 'failure' : (subject.outcome ?? 'success')
  return {
    id: evidenceId,
    epoch,
    callId: call.callId,
    rootCallId: call.rootCallId ?? call.callId,
    toolName: call.name,
    toolResultSeq: result.seq,
    outcome,
    capabilities: subject.capabilities,
    subjects: subject.subjects,
    surfaces: subject.surfaces,
    boundedSummarySha256: sha256(boundedSummary(result.textContent)),
  }
}

export function withDurability(evidence: GuardEvidence, confirmed: boolean): GuardEvidence {
  if (confirmed) return evidence
  return { ...evidence, outcome: 'unknown' }
}
