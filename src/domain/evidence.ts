import { sanitizeUrl, sha256 } from './canonicalize.js'
import { parsePwshCommand, parseShellCommand, isRunExecutable } from './shell-parse.js'
import type { EvidenceOutcome, GuardEvidence, GuardOperation } from './types.js'

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

/** Resolve a relative command path reference against the command workdir. */
function resolveCommandPath(reference: string, cwd: string | undefined): string {
  if (!cwd) return reference
  if (/^[A-Za-z]:[\\/]/.test(reference) || reference.startsWith('//') || reference.startsWith('\\\\') || reference.startsWith('/') || reference.startsWith('\\')) return reference
  return `${cwd.replace(/[\\/]+$/, '')}/${reference}`
}

interface ToolOperation {
  op: GuardOperation
  path?: string
}

interface CommandAnalysis {
  status: 'supported' | 'unsupported' | 'malformed'
  reason?: string
  executables: string[]
  operations: ToolOperation[]
  subjects: string[]
}

/**
 * Analyze a shell/pwsh command against the v0.1 supported surface. Only a
 * fully supported command produces executables/operations; unsupported or
 * malformed syntax yields EMPTY executables and operations (fail-closed), so a
 * partially understood command can never certify an operation.
 */
function analyzeCommand(command: string, workdir: unknown, toolName: string): CommandAnalysis {
  const cwd = typeof workdir === 'string' ? workdir : undefined
  const parsed = toolName === 'pwsh'
    ? parsePwshCommand(command)
    : parseShellCommand(command)
  if (parsed.status !== 'supported') {
    return {
      status: parsed.status,
      reason: parsed.reason,
      executables: [],
      operations: [],
      subjects: cwd ? [cwd] : [],
    }
  }
  const operations = parsed.operations.map((entry) => {
    let path = entry.path !== undefined ? resolveCommandPath(entry.path, cwd) : undefined
    // Scope-run attribution: a pathless run of a real whitelisted executable is
    // attributed to the command cwd, so a run contract on the scope directory
    // can be closed by the command that actually ran there.
    if (path === undefined && entry.op === 'run' && cwd !== undefined &&
      parsed.executables.some((executable) => isRunExecutable(executable))) {
      path = cwd
    }
    return { op: entry.op, ...(path !== undefined ? { path } : {}) }
  })
  const subjects = unique([...(cwd ? [cwd] : []), ...operations
    .map((entry) => entry.path)
    .filter((path): path is string => path !== undefined)])
  return {
    status: parsed.status,
    reason: parsed.reason,
    executables: parsed.executables,
    operations,
    subjects,
  }
}

/**
 * Terminal markers are only recognized as INDEPENDENT COMPLETE LINES at the end
 * of the rendered result (the DSH rendering protocol). A marker-like substring
 * in ordinary stdout — `documentation says [timed out after 1000ms] but command
 * succeeded` — is not a terminal fact.
 *
 * Two renderer families exist. The session shell tools (`dsh-tool-bash` /
 * `dsh-tool-pwsh`) append `[exit code: N]` (non-zero only), `[killed by
 * signal: S]`, `[sandbox: ...]`, and `[timed out after Nms]` as trailing
 * lines. The persistent shell tools (`dsh-tool-bash-persistent` /
 * `dsh-tool-pwsh-persistent`) use a non-zero-only `[exit code: N]` for the
 * normal path but render timeout and shell-session-exit reports as
 * `[shell exited: code N]` / `[shell killed by signal: S]` / `[shell exited]`
 * (or a prose timeout intro at the head) followed by a prose reset line
 * (`The persistent bash shell was reset; ...`). The reset prose is not a
 * terminal marker itself, so the scan strips a trailing reset line first and
 * treats the timeout intro as a negative fact only when a reset line
 * confirms the report came from the persistent renderer — a clean result
 * that merely echoes such prose must stay a clean success.
 */
interface TerminalFacts {
  exitCode?: number
  negative: boolean
}

const PERSISTENT_RESET_LINE = /^The persistent (?:bash|pwsh) shell was reset;/
const PERSISTENT_TIMEOUT_INTRO = /^Your command timed out after \d+ seconds or experienced an OOM error\. Below is partial output:$/

function extractTerminalFacts(textContent: string): TerminalFacts {
  const lines = textContent.split(/\r?\n/)
  let index = lines.length - 1
  while (index >= 0 && lines[index].trim() === '') index -= 1
  // The persistent renderers append a prose reset line after every marker;
  // skip it so the marker scan below can see the terminal facts above it.
  const resetStripped = index >= 0 && PERSISTENT_RESET_LINE.test(lines[index].trim())
  if (resetStripped) {
    index -= 1
    while (index >= 0 && lines[index].trim() === '') index -= 1
  }
  const timeoutIntroAtHead = resetStripped && lines.length > 0 && PERSISTENT_TIMEOUT_INTRO.test(lines[0].trim())
  let exitCode: number | undefined
  let negative = timeoutIntroAtHead
  while (index >= 0) {
    const line = lines[index].trim()
    const exitMatch = line.match(/^\[(?:exit code|shell exited: code)\s*:?\s*(\d+)\]$/)
    const negativeLine = /^\[(?:timed out|sandbox[^\]]*|killed by signal[^\]]*|shell killed by signal[^\]]*|shell exited|interrupted[^\]]*)[^\]]*\]$/i.test(line)
    if (exitMatch) {
      // The last terminal exit marker is authoritative. Earlier adjacent
      // markers may be retained only as context, never as an override.
      if (exitCode === undefined) exitCode = Number(exitMatch[1])
    } else if (negativeLine) {
      negative = true
    } else {
      break
    }
    index -= 1
  }
  return { exitCode, negative }
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
  /\bpython(?:3)?\s+-m\s+(?:unittest|doctest|pytest)\b/,
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
  executables?: string[]
  operations?: ToolOperation[]
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

/** Resolve relative artifact subjects against the session scope cwd. */
function resolveSubjectPaths(values: string[], cwd: string | undefined): string[] {
  return cwd ? values.map((value) => resolveCommandPath(value, cwd)) : values
}

export function extractToolSubject(call: ToolCallInput, result: ToolResultInput, defaultCwd?: string): ToolSubject {
  const args = parseArguments(call.arguments)
  switch (call.name) {
    case 'read':
    case 'read_file': {
      const subjects = unique(resolveSubjectPaths([...metaPaths(result.meta), ...argsPaths(args)], defaultCwd))
      return {
        capabilities: ['filesystem-read'],
        subjects,
        surfaces: ['artifact'],
        operations: subjects.map((path) => ({ op: 'read', path })),
      }
    }
    case 'write':
    case 'write_file': {
      const subjects = unique(resolveSubjectPaths([...metaPaths(result.meta), ...argsPaths(args)], defaultCwd))
      return {
        capabilities: ['filesystem-write'],
        subjects,
        surfaces: ['artifact'],
        operations: subjects.map((path) => ({ op: 'create', path })),
      }
    }
    case 'edit':
    case 'edit_file': {
      const subjects = unique(resolveSubjectPaths([...metaPaths(result.meta), ...argsPaths(args)], defaultCwd))
      return {
        capabilities: ['filesystem-edit'],
        subjects,
        surfaces: ['artifact'],
        operations: subjects.map((path) => ({ op: 'modify', path })),
      }
    }
    case 'bash':
    case 'shell':
    case 'pwsh': {
      const command = typeof args.command === 'string' ? args.command : ''
      const terminal = extractTerminalFacts(result.textContent)
      const backgrounded = args.run_in_background === true
      const commandDetails = analyzeCommand(command, typeof args.workdir === 'string' ? args.workdir : defaultCwd, call.name)
      const deterministic = commandDetails.status === 'supported' && !backgrounded && isDeterministicCheck(command)
      // The pinned DSH bash/pwsh renderers append markers only for negative
      // terminal facts or non-zero exits. A completed foreground result with
      // no such marker is therefore a clean success for those two registered
      // tools. The generic `shell` alias has no verified renderer contract and
      // remains fail-closed when no explicit exit marker is present.
      const outcome: EvidenceOutcome = backgrounded
        ? 'unknown'
        : result.error || terminal.negative
          ? 'failure'
          : terminal.exitCode === undefined
            ? (call.name === 'bash' || call.name === 'pwsh' ? 'success' : 'unknown')
            : terminal.exitCode === 0 ? 'success' : 'failure'
      return {
        capabilities: ['shell', ...(deterministic ? ['deterministic-check'] : [])],
        subjects: unique(commandDetails.subjects),
        surfaces: ['scope'],
        outcome,
        executables: commandDetails.executables,
        operations: commandDetails.operations,
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
  defaultCwd?: string,
): GuardEvidence {
  const subject = extractToolSubject(call, result, defaultCwd)
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
    ...(subject.executables?.length ? { executables: subject.executables } : {}),
    ...(subject.operations?.length ? { operations: subject.operations } : {}),
  }
}

export function withDurability(evidence: GuardEvidence, confirmed: boolean): GuardEvidence {
  if (confirmed) return evidence
  return { ...evidence, outcome: 'unknown' }
}
