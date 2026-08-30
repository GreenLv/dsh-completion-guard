import { sanitizeUrl, sha256 } from './canonicalize.js'
import { evaluateToolSurfaceCapability, type HostLockEvaluation, type HostToolSurface } from './host-lock.js'
import { parsePwshCommand, parseShellCommand, isRunExecutable } from './shell-parse.js'
import { SEMANTIC_ACTIONS, SUPPORTED_EVIDENCE_ADAPTERS, semanticActionFromCommand, semanticActionFromText, type SemanticAction } from './protocol-manifest.js'
import type { EvidenceOutcome, EvidenceParseStatus, EvidenceRole, ExpectedTransition, GuardEvidence, GuardOperation, TargetTuple } from './types.js'

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

interface StructuredGuardMeta {
  adapterId: string
  adapterVersion: string
  semanticAction: SemanticAction
  evidenceRole: EvidenceRole
  resolvedTarget: TargetTuple
  observedState?: TargetTuple
  expectedTransition?: ExpectedTransition
  expectedTransitionDigest?: string
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function structuredGuardMeta(meta: unknown, toolName: string): StructuredGuardMeta | undefined {
  // Only the Guard-owned producer may mint role-bearing facts. Other tools can
  // carry arbitrary presentation metadata, but it is never certification authority.
  if (toolName !== 'context_guard_evidence') return undefined
  const outer = asRecord(meta)
  const value = asRecord(outer?.contextGuard ?? outer?.context_guard)
  if (!value) return undefined
  const action = value.semanticAction ?? value.semantic_action
  const role = value.evidenceRole ?? value.evidence_role
  const resolved = asRecord(value.resolvedTarget ?? value.resolved_target)
  const observed = asRecord(value.observedState ?? value.observed_state)
  const rawExpected = asRecord(value.expectedTransition)
  const expectedParameters = asRecord(rawExpected?.parameters)
  const expectedDigest = value.expectedTransitionDigest
  const expectedTransition = rawExpected
    && typeof rawExpected.predicateId === 'string'
    && rawExpected.version === 1
    && rawExpected.predParamsKind === 'inline'
    && expectedParameters
    && typeof expectedDigest === 'string'
    && expectedDigest === sha256(stable(rawExpected))
    ? rawExpected as unknown as ExpectedTransition
    : undefined
  if (typeof value.adapterId !== 'string' || typeof value.adapterVersion !== 'string') return undefined
  if (SUPPORTED_EVIDENCE_ADAPTERS[value.adapterId] !== value.adapterVersion) return undefined
  if (typeof action !== 'string' || typeof role !== 'string' || !resolved) return undefined
  if (!(SEMANTIC_ACTIONS as readonly string[]).includes(action)) return undefined
  if (!['resolution', 'effect', 'state'].includes(role)) return undefined
  if (role === 'state' && !observed) return undefined
  return {
    adapterId: value.adapterId,
    adapterVersion: value.adapterVersion,
    semanticAction: action as SemanticAction,
    evidenceRole: role as EvidenceRole,
    resolvedTarget: resolved as TargetTuple,
    ...(observed ? { observedState: observed as TargetTuple } : {}),
    ...(expectedTransition ? {
      expectedTransition,
      expectedTransitionDigest: expectedDigest as string,
    } : {}),
  }
}

function parseStatus(details: CommandAnalysis): { parseStatus: EvidenceParseStatus; reasonCode?: string } {
  if (details.status === 'supported') return { parseStatus: 'supported' }
  if (details.status === 'malformed') return { parseStatus: 'malformed_quote', reasonCode: 'malformed_quote' }
  if (details.reason?.includes('statement operator') || details.reason?.includes('compound')) {
    return { parseStatus: 'unsupported_statement_operator', reasonCode: 'unsupported_statement_operator' }
  }
  return { parseStatus: 'unsupported_command', reasonCode: 'unsupported_command' }
}

function weakResolvedTarget(action: SemanticAction, cwd: string | undefined, executables: readonly string[]): TargetTuple {
  if (action === 'verify') return cwd ? { scope: cwd } : {}
  if (action === 'test' || action === 'generic_run') {
    return { ...(cwd ? { scope: cwd } : {}), ...(executables[0] ? { executable: executables[0].toLowerCase() } : {}) }
  }
  if (['pull', 'fetch', 'commit', 'push', 'inspect_remote_updates'].includes(action)) {
    return cwd ? { repository: cwd } : {}
  }
  return cwd ? { scope: cwd } : {}
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

/**
 * Structured terminal facts from the tool/result meta (defensive): the pinned
 * shell renderers currently emit text markers only, but the underlying run
 * result carries exitCode/signal, so a future harness that surfaces them in
 * `meta` is trusted directly. Absent structured facts, text scanning remains
 * the fallback.
 */
function structuredTerminalFacts(meta: unknown): TerminalFacts | undefined {
  const record = asRecord(meta)
  if (!record) return undefined
  const rawExit = record.exitCode ?? record.exit_code
  const rawSignal = record.signal
  if (rawSignal !== undefined && rawSignal !== null) {
    return { exitCode: typeof rawExit === 'number' ? rawExit : undefined, negative: true }
  }
  if (typeof rawExit === 'number') return { exitCode: rawExit, negative: false }
  return undefined
}

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
const INSPECTION_COMMANDS = /\b(?:which|where|whereis|type|command\s+-v|grep|rg|cat|less|head|tail|find|ls|dir)\b|\s(?:--version|-V|-v|--help|-h)\s*$|\s(?:--version|--help)\b/i

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
  semanticAction?: SemanticAction
  evidenceRole?: EvidenceRole
  resolvedTarget?: TargetTuple
  observedState?: TargetTuple
  expectedTransition?: ExpectedTransition
  expectedTransitionDigest?: string
  parseStatus?: EvidenceParseStatus
  reasonCode?: string
  adapterId?: string
  adapterVersion?: string
  externalOperationRef?: import('./types.js').ExternalOperation
}

function capabilityGatedSubject(
  subject: ToolSubject,
  surface: HostToolSurface,
  hostLock: HostLockEvaluation | undefined,
): ToolSubject {
  if (!hostLock) return subject
  const capability = evaluateToolSurfaceCapability(hostLock, surface)
  if (capability.status === 'supported') return subject
  const reasonCode = capability.reasonCode === 'host_capability_request_unsupported'
    ? 'host_tool_platform_mismatch'
    : capability.reasonCode === 'host_capability_context_missing'
      ? 'host_tool_platform_context_missing'
      : `host_${surface === 'filesystem' ? 'filesystem' : 'terminal'}_capability_${(capability.reasonCode ?? 'unavailable').replace(/^host_capability_/, '')}`
  return {
    ...subject,
    capabilities: [],
    outcome: 'unknown',
    parseStatus: 'adapter_unavailable',
    reasonCode,
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

/** Resolve relative artifact subjects against the session scope cwd. */
function resolveSubjectPaths(values: string[], cwd: string | undefined): string[] {
  return cwd ? values.map((value) => resolveCommandPath(value, cwd)) : values
}

export function extractToolSubject(
  call: ToolCallInput,
  result: ToolResultInput,
  defaultCwd?: string,
  hostLock?: HostLockEvaluation,
): ToolSubject {
  const args = parseArguments(call.arguments)
  if (call.name === 'context_guard_external_operation') {
    const external = asRecord(asRecord(result.meta)?.contextGuardExternalOperation)
    const status = external?.status
    if (typeof external?.id === 'string' && typeof external.adapterId === 'string'
      && (status === 'running' || status === 'pending' || status === 'completed' || status === 'failed' || status === 'unknown')) {
      return {
        capabilities: ['external-operation-readback'], subjects: [], surfaces: [], outcome: status === 'unknown' ? 'unknown' : 'success',
        semanticAction: 'verify', evidenceRole: 'effect', resolvedTarget: { operation_id: external.id },
        parseStatus: 'supported', adapterId: 'context-guard.external-operation.v1', adapterVersion: '1.0.0',
        externalOperationRef: { id: external.id, epoch: 0, adapterId: external.adapterId, status },
      }
    }
    return { capabilities: ['external-operation-readback'], subjects: [], surfaces: [], outcome: 'unknown', parseStatus: 'adapter_unavailable', reasonCode: 'external_operation_unavailable' }
  }
  const structured = structuredGuardMeta(result.meta, call.name)
  if (call.name === 'context_guard_evidence' && !structured) {
    const disposition = asRecord(asRecord(result.meta)?.contextGuardDisposition)
    return {
      capabilities: ['guard-state-readback'], subjects: [], surfaces: [], outcome: 'unknown',
      semanticAction: typeof args.semantic_action === 'string' && (SEMANTIC_ACTIONS as readonly string[]).includes(args.semantic_action)
        ? args.semantic_action as SemanticAction : 'generic_run',
      evidenceRole: typeof args.evidence_role === 'string' && ['resolution', 'effect', 'state'].includes(args.evidence_role)
        ? args.evidence_role as EvidenceRole : 'effect',
      resolvedTarget: {}, parseStatus: 'adapter_unavailable',
      reasonCode: typeof disposition?.reasonCode === 'string' ? disposition.reasonCode : 'adapter_unavailable',
      adapterId: 'context-guard.unavailable.v1', adapterVersion: '1.0.0',
    }
  }
  const structuredFields = structured ? {
    semanticAction: structured.semanticAction,
    evidenceRole: structured.evidenceRole,
    resolvedTarget: structured.resolvedTarget,
    ...(structured.observedState ? { observedState: structured.observedState } : {}),
    ...(structured.expectedTransition ? {
      expectedTransition: structured.expectedTransition,
      expectedTransitionDigest: structured.expectedTransitionDigest,
    } : {}),
    parseStatus: 'supported' as const,
    adapterId: structured.adapterId,
    adapterVersion: structured.adapterVersion,
  } : {}
  if (call.name === 'context_guard_evidence' && structured) {
    const artifact = typeof structured.resolvedTarget.artifact_id === 'string' ? structured.resolvedTarget.artifact_id : undefined
    const scope = typeof structured.resolvedTarget.repository === 'string' ? structured.resolvedTarget.repository
      : typeof structured.resolvedTarget.profile === 'string' ? structured.resolvedTarget.profile
        : typeof structured.resolvedTarget.service_id === 'string' ? structured.resolvedTarget.service_id
          : typeof structured.resolvedTarget.registry === 'string' ? structured.resolvedTarget.registry : defaultCwd
    const subject = artifact ?? scope
    const surface = artifact ? 'artifact' as const : 'scope' as const
    return {
      capabilities: [structured.evidenceRole === 'state' ? 'independent-state-readback' : 'guard-stateful-observation'],
      subjects: subject ? [subject] : [surface], surfaces: [surface],
      operations: [{ op: structured.evidenceRole === 'effect' ? 'run' : 'read', ...(subject ? { path: subject } : {}) }],
      ...structuredFields,
    }
  }
  switch (call.name) {
    case 'read':
    case 'read_file': {
      const subjects = unique(resolveSubjectPaths([...metaPaths(result.meta), ...argsPaths(args)], defaultCwd))
      return capabilityGatedSubject({
        capabilities: ['filesystem-read'],
        subjects,
        surfaces: ['artifact'],
        operations: subjects.map((path) => ({ op: 'read', path })),
        semanticAction: structured?.semanticAction ?? 'verify',
        evidenceRole: structured?.evidenceRole ?? 'effect',
        // The artifact identity remains in the bounded subject/operation tuple.
        // The non-stateful verify command manifest is deliberately closed to
        // its canonical target key (`scope`) so callers cannot smuggle an
        // ignored cross-branch artifact field into the binding record.
        resolvedTarget: structured?.resolvedTarget ?? { scope: defaultCwd ?? 'scope' },
        ...(structured?.observedState ? { observedState: structured.observedState } : {}),
        parseStatus: 'supported', adapterId: structured?.adapterId ?? 'dsh.read.v1', adapterVersion: structured?.adapterVersion ?? '1.0.0',
      }, 'filesystem', hostLock)
    }
    case 'write':
    case 'write_file': {
      const subjects = unique(resolveSubjectPaths([...metaPaths(result.meta), ...argsPaths(args)], defaultCwd))
      return capabilityGatedSubject({
        capabilities: ['filesystem-write'],
        subjects,
        surfaces: ['artifact'],
        operations: subjects.map((path) => ({ op: 'create', path })),
        semanticAction: structured?.semanticAction ?? 'create', evidenceRole: structured?.evidenceRole ?? 'effect',
        resolvedTarget: structured?.resolvedTarget ?? { ...(subjects[0] ? { artifact_id: subjects[0] } : {}), scope: defaultCwd ?? 'scope' },
        parseStatus: 'supported', adapterId: structured?.adapterId ?? 'dsh.write.v1', adapterVersion: structured?.adapterVersion ?? '1.0.0',
      }, 'filesystem', hostLock)
    }
    case 'edit':
    case 'edit_file': {
      const subjects = unique(resolveSubjectPaths([...metaPaths(result.meta), ...argsPaths(args)], defaultCwd))
      return capabilityGatedSubject({
        capabilities: ['filesystem-edit'],
        subjects,
        surfaces: ['artifact'],
        operations: subjects.map((path) => ({ op: 'modify', path })),
        semanticAction: structured?.semanticAction ?? 'modify', evidenceRole: structured?.evidenceRole ?? 'effect',
        resolvedTarget: structured?.resolvedTarget ?? { ...(subjects[0] ? { artifact_id: subjects[0] } : {}), scope: defaultCwd ?? 'scope' },
        parseStatus: 'supported', adapterId: structured?.adapterId ?? 'dsh.edit.v1', adapterVersion: structured?.adapterVersion ?? '1.0.0',
      }, 'filesystem', hostLock)
    }
    case 'bash':
    case 'shell':
    case 'pwsh': {
      const command = typeof args.command === 'string' ? args.command : ''
      const terminal = structuredTerminalFacts(result.meta) ?? extractTerminalFacts(result.textContent)
      const backgrounded = args.run_in_background === true
      const commandDetails = analyzeCommand(command, typeof args.workdir === 'string' ? args.workdir : defaultCwd, call.name)
      const commandCwd = typeof args.workdir === 'string' ? args.workdir : defaultCwd
      const action = structured?.semanticAction ?? semanticActionFromCommand(command)
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
      const subject: ToolSubject = {
        capabilities: ['shell', ...(deterministic ? ['deterministic-check'] : [])],
        subjects: unique(commandDetails.subjects),
        surfaces: ['scope'],
        outcome,
        executables: commandDetails.executables,
        operations: commandDetails.operations,
        semanticAction: action,
        evidenceRole: structured?.evidenceRole ?? 'effect',
        resolvedTarget: structured?.resolvedTarget ?? weakResolvedTarget(action, commandCwd, commandDetails.executables),
        ...(structured?.observedState ? { observedState: structured.observedState } : {}),
        ...parseStatus(commandDetails),
        adapterId: structured?.adapterId ?? `dsh.${call.name}.v1`,
        adapterVersion: structured?.adapterVersion ?? '1.0.0',
      }
      return call.name === 'bash' || call.name === 'pwsh'
        ? capabilityGatedSubject(subject, call.name, hostLock)
        : subject
    }
    case 'web_search':
    case 'web_fetch':
    case 'web_fetch_url':
      return {
        capabilities: ['web-fetch'],
        subjects: unique([...metaUrls(result.meta), ...(typeof args.url === 'string' ? [sanitizeUrl(args.url)] : [])]),
        surfaces: ['ui'],
        semanticAction: structured?.semanticAction ?? semanticActionFromText(call.name),
        evidenceRole: structured?.evidenceRole ?? 'effect',
        resolvedTarget: structured?.resolvedTarget ?? { scope: 'web' },
        ...(structured?.observedState ? { observedState: structured.observedState } : {}),
        parseStatus: 'supported', adapterId: structured?.adapterId ?? 'dsh.web.v1', adapterVersion: structured?.adapterVersion ?? '1.0.0',
      }
    default:
      return { capabilities: ['generic'], subjects: [], surfaces: [], ...structuredFields }
  }
}

export function evidenceFromPersistedToolResult(
  call: ToolCallInput,
  result: ToolResultInput,
  epoch: number,
  evidenceId: string,
  defaultCwd?: string,
  hostLock?: HostLockEvaluation,
): GuardEvidence {
  const subject = extractToolSubject(call, result, defaultCwd, hostLock)
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
    ...(subject.semanticAction ? { semanticAction: subject.semanticAction } : {}),
    ...(subject.evidenceRole ? { evidenceRole: subject.evidenceRole } : {}),
    ...(subject.resolvedTarget ? { resolvedTarget: subject.resolvedTarget } : {}),
    ...(subject.observedState ? { observedState: subject.observedState } : {}),
    ...(subject.expectedTransition ? { expectedTransition: subject.expectedTransition } : {}),
    ...(subject.expectedTransitionDigest ? { expectedTransitionDigest: subject.expectedTransitionDigest } : {}),
    ...(subject.parseStatus ? { parseStatus: subject.parseStatus } : {}),
    ...(subject.reasonCode ? { reasonCode: subject.reasonCode } : {}),
    ...(subject.adapterId ? { adapterId: subject.adapterId } : {}),
    ...(subject.adapterVersion ? { adapterVersion: subject.adapterVersion } : {}),
    ...(subject.externalOperationRef ? { externalOperationRef: { ...subject.externalOperationRef, epoch } } : {}),
  }
}

export function withDurability(evidence: GuardEvidence, confirmed: boolean): GuardEvidence {
  if (confirmed) return evidence
  return { ...evidence, outcome: 'durability-unknown' }
}
