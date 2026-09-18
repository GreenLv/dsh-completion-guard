import { sanitizeUrl, sha256 } from './canonicalize.js'
import { evaluateToolSurfaceCapability, type HostLockEvaluation, type HostToolSurface } from './host-lock.js'
import { parsePwshCommand, parseShellCommand, isRunExecutable } from './shell-parse.js'
import { SEMANTIC_ACTIONS, SUPPORTED_EVIDENCE_ADAPTERS, semanticActionFromCommand, semanticActionFromText, type SemanticAction } from './protocol-manifest.js'
import type { DerivedProcessFacts, ProcessFactSource, ProcessOutcomeReason } from './capability-semantics.js'
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
 * Renderer audit for the DSH 0.1.5-rc.1 support baseline:
 *
 * - The bundled session shell tools (`dsh-tool-bash` / `dsh-tool-pwsh`, the two
 *   registered by the `@deepseek-ai/dsh-base` profile) append `[exit code: N]`
 *   (NON-ZERO only), `[killed by signal: S]`, `[sandbox: ...]`, and
 *   `[timed out after Nms]` as trailing lines. Their marker logic is unchanged
 *   between 0.1.2-rc.1 and 0.1.5-rc.1, so a completed foreground result with no
 *   marker at all is still a clean success — but ONLY for those two names, and
 *   only when the host lock proves that pinned graph.
 * - The persistent shell tools (`dsh-tool-bash-persistent`, out of the default
 *   bundle) render `[shell exited: code N]` / `[shell killed by signal: S]` /
 *   `[shell exited]`, and 0.1.5-rc.1 added two markers this scanner must know:
 *   `[Command finished with exit code N]` on the normal completion path and
 *   `[Command timed out or OOM]` on the timeout path. Recognizing them keeps a
 *   persistent-renderer result classified by its own marker instead of falling
 *   through to the unmarked rule, which belongs to the session renderer alone.
 *   The audited cohort admits `dsh-tool-bash` / `dsh-tool-pwsh` and not the
 *   persistent package, so such a host fails the whole graph lock closed too.
 * - Either family may append the prose reset line `The persistent bash shell
 *   was reset; ...`, which is not a marker itself, so the scan strips a
 *   trailing reset line first and treats the timeout intro as a negative fact
 *   only when a reset line confirms the report came from the persistent
 *   renderer — a clean result that merely echoes such prose stays a clean
 *   success.
 */
interface TerminalFacts {
  exitCode?: number
  negative: boolean
  /** An explicit terminal marker was recognized (success or failure). */
  marked: boolean
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
    return { exitCode: typeof rawExit === 'number' ? rawExit : undefined, negative: true, marked: true }
  }
  if (typeof rawExit === 'number') return { exitCode: rawExit, negative: false, marked: true }
  return undefined
}

/** `[exit code: N]`, `[shell exited: code N]`, `[Command finished with exit code N]`. */
const TERMINAL_EXIT_MARKER = /^\[(?:exit code|shell exited: code|command finished with exit code)\s*:?\s*(\d+)\]$/
/** Negative markers with no exit code of their own. */
const TERMINAL_NEGATIVE_MARKER = /^\[(?:timed out[^\]]*|sandbox[^\]]*|killed by signal[^\]]*|shell killed by signal[^\]]*|shell exited|command timed out or oom|interrupted[^\]]*)\]$/

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
  let marked = timeoutIntroAtHead
  while (index >= 0) {
    const line = lines[index].trim().toLowerCase()
    const exitMatch = line.match(TERMINAL_EXIT_MARKER)
    if (exitMatch) {
      // The last terminal exit marker is authoritative. Earlier adjacent
      // markers may be retained only as context, never as an override.
      if (exitCode === undefined) exitCode = Number(exitMatch[1])
      marked = true
    } else if (TERMINAL_NEGATIVE_MARKER.test(line)) {
      negative = true
      marked = true
    } else {
      break
    }
    index -= 1
  }
  return { exitCode, negative, marked }
}

/**
 * 0.6.2 D062-02: one trusted structured producer declaration, if the host
 * rendered per-operation results. Absence is the honest common case: the
 * pinned DSH renderers declare a whole-result terminal marker only, so no
 * per-operation producer exists and the attribution stays `unknown`.
 */
function declaredOperationResults(meta: unknown): DerivedProcessFacts['declaredOperationResults'] {
  const declared = asRecord(asRecord(meta)?.contextGuardProcess)?.operationResults
  if (!Array.isArray(declared) || declared.length === 0 || declared.length > 64) return undefined
  const rows: NonNullable<DerivedProcessFacts['declaredOperationResults']> = []
  for (const raw of declared) {
    const row = asRecord(raw)
    const action = typeof row?.action === 'string' ? row.action : undefined
    const outcome = row?.outcome
    if (!action || (outcome !== 'success' && outcome !== 'failure' && outcome !== 'unknown')) return undefined
    rows.push({ action, outcome })
  }
  return rows
}

/**
 * The trusted run-level declaration in `meta.contextGuardProcess`. This is the
 * highest-priority source: it is the run's own statement about the process, so
 * an explicit `exitCode` here outranks the generic `meta.exitCode`.
 */
function declaredStructuredTerminal(meta: unknown): { exitCode?: number; signal: boolean } | undefined {
  const record = asRecord(asRecord(meta)?.contextGuardProcess)
  if (!record) return undefined
  const rawExit = record.exitCode ?? record.exit_code
  const signal = record.signal
  if (signal !== undefined && signal !== null) return { ...(typeof rawExit === 'number' ? { exitCode: rawExit } : {}), signal: true }
  if (typeof rawExit === 'number') return { exitCode: rawExit, signal: false }
  return undefined
}

/**
 * The HISTORICAL terminal-fact rule, unchanged since 0.6.1: the generic
 * structured `meta` fact, else the rendered text markers. It deliberately does
 * NOT read the trusted `contextGuardProcess` run declaration — that source is
 * new in 0.6.2 and reading it here would change the frozen `outcome` of
 * already-recorded evidence, which is a summary input and therefore historical
 * (0.6.2 review of D062-02).
 */
function legacyTerminalFacts(meta: unknown, textContent: string): TerminalFacts {
  return structuredTerminalFacts(meta) ?? extractTerminalFacts(textContent)
}

/**
 * The terminal facts the DERIVED layer reads, in priority order (0.6.2 D062-02
 * review): the trusted run declaration first, then the generic structured fact,
 * then the rendered markers. This never feeds the frozen `outcome`; it feeds
 * `processFacts` only, which states its own `source` and whether it disagrees
 * with the frozen reading.
 */
function resolveDeclaredTerminalFacts(meta: unknown, textContent: string): { facts: TerminalFacts; source: ProcessFactSource } {
  const namespace = declaredStructuredTerminal(meta)
  if (namespace) return { facts: { exitCode: namespace.exitCode, negative: namespace.signal, marked: true }, source: 'run_declaration' }
  const structured = structuredTerminalFacts(meta)
  if (structured) return { facts: structured, source: 'structured_meta' }
  return { facts: extractTerminalFacts(textContent), source: 'rendered_markers' }
}

/**
 * The one outcome rule for a shell result, shared by the frozen evidence field
 * and the derived reading. Their different fact sources may yield different verdicts.
 * The bundled DSH session shell renderers (`dsh-tool-bash` / `dsh-tool-pwsh`)
 * append markers only for negative terminal facts or non-zero exits, so a
 * completed foreground result with no marker is a clean success for those two
 * registered tools alone; the generic `shell` alias has no verified renderer
 * contract and an unclassifiable marker stays `unknown`.
 */
function shellOutcome(
  surface: 'bash' | 'pwsh' | 'shell',
  terminal: TerminalFacts,
  resultError: unknown,
  backgrounded: boolean,
): 'success' | 'failure' | 'unknown' {
  if (backgrounded) return 'unknown'
  if (resultError || terminal.negative) return 'failure'
  if (terminal.exitCode === undefined) {
    return (surface === 'bash' || surface === 'pwsh') && !terminal.marked ? 'success' : 'unknown'
  }
  return terminal.exitCode === 0 ? 'success' : 'failure'
}

/**
 * The layered shell reading (0.6.2 D062-02; source priority fixed by the
 * 0.6.2 review). Every field is derived from the same persisted result the
 * historical `outcome` was derived from, so replay is deterministic and no
 * historical fact is reinterpreted:
 *
 * - `hostToolReturned` is the host's own return, nothing more;
 * - `declaredExitCode` is `'unknown'` unless a real fact declared it, and an
 *   unmarked success is NOT a read exit code of 0;
 * - `operationAttribution` stays `'unknown'` for an opaque compound runner, so
 *   the last command's success can never cover an earlier failure;
 * - `outcome` uses the same evaluator with independently selected facts; a
 *   disagreement with the historical field is explicitly reported.
 *
 * SOURCE PRIORITY for the process terminal facts, highest first:
 *
 *   1. the trusted `contextGuardProcess` namespace — the run's OWN declaration
 *      of what the process did. An explicit `exitCode` here is read as declared
 *      even when the generic `meta.exitCode` says something else; the namespace
 *      is the more specific statement and never loses to the generic one.
 *   2. any other structured terminal fact the renderer put in `meta`
 *      (`meta.exitCode` / `meta.exit_code` / `meta.signal`).
 *   3. the rendered text markers of the audited renderers.
 *
 * A namespace declaration never overrides the frozen `outcome`, because the
 * frozen value is the historical record and this batch must not rewrite it; the
 * derived layer records its source and conflict flag instead of changing history.
 */
function shellProcessFacts(
  meta: unknown,
  textContent: string,
  frozenOutcome: EvidenceOutcome,
  resultError: unknown,
  surface: 'bash' | 'pwsh' | 'shell',
  backgrounded: boolean,
  parseStatus: EvidenceParseStatus,
): DerivedProcessFacts {
  const { facts: terminal, source } = resolveDeclaredTerminalFacts(meta, textContent)
  const declaredOperations = declaredOperationResults(meta)
  const operationAttribution: DerivedProcessFacts['operationAttribution'] = declaredOperations
    ? 'declared_per_operation'
    : parseStatus === 'supported' && !backgrounded
      ? 'single_operation'
      : 'unknown'
  const outcome = shellOutcome(surface, terminal, resultError, backgrounded)
  let outcomeReason: ProcessOutcomeReason
  if (backgrounded) outcomeReason = 'backgrounded'
  else if (resultError) outcomeReason = 'host_error_flag'
  else if (terminal.negative) outcomeReason = 'declared_negative_marker'
  else if (terminal.exitCode !== undefined) outcomeReason = 'declared_exit_code'
  else if (outcome === 'success') outcomeReason = 'unmarked_renderer_success'
  else if (terminal.marked) outcomeReason = 'marker_unclassified'
  else outcomeReason = 'text_scan_inconclusive'
  return {
    hostToolReturned: resultError ? 'error' : 'result',
    declaredExitCode: terminal.exitCode ?? 'unknown',
    terminalMarkerRead: terminal.marked,
    outcome,
    outcomeReason,
    source,
    // A divergence is reported, never resolved by rewriting the historical
    // field: the frozen `outcome` keeps the 0.6.1 rule even when the run's own
    // declaration disagrees with it.
    frozenOutcomeConflict: outcome !== frozenOutcome,
    operationAttribution,
    ...(declaredOperations ? { declaredOperationResults: declaredOperations } : {}),
  }
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
  causedByCallId?: string
  nativeCanonicalPath?: string
  nativeCanonicalBase?: string
  nativeGitTreeOid?: string
  nativeGitParentOid?: string
  readinessForItemId?: string
  readinessPredicate?: string
  readinessManifestSha256?: string
  readinessEffectCallId?: string
  readinessSelectedPath?: string
  readinessScriptName?: string
  readinessInputSha256?: string
  /** 0.6.2 D062-02: the layered shell reading, present only for shell tools. */
  processFacts?: DerivedProcessFacts
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

/** A file tool acts on its call argument. Presentation metadata may describe
 * that same file, but cannot introduce another operation target. A differing
 * display path needs an independent filesystem identity readback before it
 * can be trusted as an alias. */
function nativeFileSubjects(args: Record<string, unknown>, meta: unknown, cwd: string | undefined): {
  subjects: string[]; operationTargets: string[]; coherent: boolean
} {
  const callTargets = unique(resolveSubjectPaths(argsPaths(args), cwd))
  const displayed = unique(resolveSubjectPaths(metaPaths(meta), cwd))
  const coherent = callTargets.length === 1 && displayed.every((path) => path === callTargets[0])
  return { subjects: unique([...callTargets, ...displayed]), operationTargets: coherent ? callTargets : [], coherent }
}

export function extractToolSubject(
  call: ToolCallInput,
  result: ToolResultInput,
  defaultCwd?: string,
  hostLock?: HostLockEvaluation,
): ToolSubject {
  const args = parseArguments(call.arguments)
  if (call.name === 'context_guard_observe_file') {
    const native = asRecord(asRecord(result.meta)?.contextGuardNativeFile)
    const effectCallId = native?.effectCallId
    const path = native?.path
    const digest = native?.sha256
    if (typeof effectCallId === 'string' && typeof path === 'string' && typeof digest === 'string'
      && /^[0-9a-f]{64}$/.test(digest) && (native?.action === 'create' || native?.action === 'modify')) {
      return {
        capabilities: ['filesystem-read'], subjects: [path], surfaces: ['artifact'],
        operations: [{ op: 'read', path }], semanticAction: native.action,
        evidenceRole: 'state', resolvedTarget: { artifact_id: path }, observedState: { post_digest: digest },
        parseStatus: 'supported', adapterId: 'context-guard.native-file.v1', adapterVersion: '1.0.0',
        causedByCallId: effectCallId,
        ...(typeof native.canonicalPath === 'string' && typeof native.canonicalBase === 'string'
          ? { nativeCanonicalPath: native.canonicalPath, nativeCanonicalBase: native.canonicalBase } : {}),
      }
    }
    return { capabilities: [], subjects: [], surfaces: [], outcome: 'unknown', parseStatus: 'adapter_unavailable', reasonCode: 'native_file_readback_unavailable' }
  }
  if (call.name === 'context_guard_observe_git') {
    const native = asRecord(asRecord(result.meta)?.contextGuardNativeGit)
    const action = native?.action
    const repository = native?.repository
    const postOid = native?.postOid
    const cause = native?.effectCallId
    if ((action === 'commit' || action === 'push') && typeof repository === 'string' && typeof cause === 'string'
      && typeof postOid === 'string' && /^[0-9a-f]{40,64}$/.test(postOid)) {
      const remote = native?.remote; const refspec = native?.refspec
      const parentOid = native?.parentOid; const treeOid = native?.treeOid
      if (action === 'commit' && (typeof parentOid !== 'string' || typeof treeOid !== 'string'
        || !/^[0-9a-f]{40,64}$/.test(parentOid) || !/^[0-9a-f]{40,64}$/.test(treeOid))) {
        return { capabilities: [], subjects: [], surfaces: [], outcome: 'unknown', parseStatus: 'adapter_unavailable', reasonCode: 'native_git_readback_unavailable' }
      }
      if (action === 'push' && (typeof remote !== 'string' || typeof refspec !== 'string')) {
        return { capabilities: [], subjects: [], surfaces: [], outcome: 'unknown', parseStatus: 'adapter_unavailable', reasonCode: 'native_git_readback_unavailable' }
      }
      return {
        capabilities: ['git-readback'], subjects: [repository], surfaces: ['scope'], operations: [{ op: 'read', path: repository }],
        semanticAction: action, evidenceRole: 'state',
        resolvedTarget: { repository, ...(action === 'push' ? { remote: remote as string, refspec: refspec as string } : { branch: native?.branch as string }) },
        observedState: { post_head_oid: postOid, ...(action === 'push' ? { remote_oid: postOid } : {}) },
        ...(action === 'commit' ? { nativeGitParentOid: parentOid as string, nativeGitTreeOid: treeOid as string } : {}),
        parseStatus: 'supported', adapterId: 'context-guard.native-git.v1', adapterVersion: '1.0.0', causedByCallId: cause,
      }
    }
    return { capabilities: [], subjects: [], surfaces: [], outcome: 'unknown', parseStatus: 'adapter_unavailable', reasonCode: 'native_git_readback_unavailable' }
  }
  if (call.name === 'context_guard_observe_test_readiness') {
    const ready = asRecord(asRecord(result.meta)?.contextGuardTestReadiness)
    const assessment = ready?.predicate === 'verification_passed'
    if (typeof ready?.itemId === 'string' && typeof ready.scope === 'string'
      && (ready.predicate === 'test_passed' || assessment)
      && typeof ready.manifestSha256 === 'string' && /^[0-9a-f]{64}$/.test(ready.manifestSha256)) {
      if (assessment && (typeof ready.effectCallId !== 'string'
        || typeof ready.selectedPath !== 'string' || !ready.selectedPath
        || !['test', 'benchmark'].includes(String(ready.scriptName))
        || typeof ready.inputSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(ready.inputSha256)
        || (ready.effectCallId === '' && ready.inputSha256 !== ready.manifestSha256))) {
        return { capabilities: [], subjects: [], surfaces: [], outcome: 'unknown', parseStatus: 'adapter_unavailable', reasonCode: 'assessment_readiness_unavailable' }
      }
      return { capabilities: ['test-input-readiness'], subjects: [ready.scope], surfaces: ['scope'],
        semanticAction: 'verify', evidenceRole: 'state', resolvedTarget: { scope: ready.scope },
        parseStatus: 'supported', adapterId: 'context-guard.test-readiness.v1', adapterVersion: '1.0.0',
        readinessForItemId: ready.itemId, readinessPredicate: ready.predicate as string, readinessManifestSha256: ready.manifestSha256,
        ...(assessment ? { readinessEffectCallId: ready.effectCallId as string, readinessSelectedPath: ready.selectedPath as string,
          readinessScriptName: ready.scriptName as string, readinessInputSha256: ready.inputSha256 as string } : {}) }
    }
    return { capabilities: [], subjects: [], surfaces: [], outcome: 'unknown', parseStatus: 'adapter_unavailable', reasonCode: 'test_readiness_unavailable' }
  }
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
      const { subjects, operationTargets, coherent } = nativeFileSubjects(args, result.meta, defaultCwd)
      return capabilityGatedSubject({
        capabilities: ['filesystem-read'],
        subjects,
        surfaces: ['artifact'],
        operations: operationTargets.map((path) => ({ op: 'read', path })),
        semanticAction: structured?.semanticAction ?? 'verify',
        evidenceRole: structured?.evidenceRole ?? 'effect',
        // The artifact identity remains in the bounded subject/operation tuple.
        // The non-stateful verify command manifest is deliberately closed to
        // its canonical target key (`scope`) so callers cannot smuggle an
        // ignored cross-branch artifact field into the binding record.
        resolvedTarget: structured?.resolvedTarget ?? { scope: defaultCwd ?? 'scope' },
        ...(structured?.observedState ? { observedState: structured.observedState } : {}),
        parseStatus: coherent ? 'supported' : 'adapter_unavailable',
        ...(coherent ? {} : { outcome: 'unknown', reasonCode: 'native_file_target_unverified' }),
        adapterId: structured?.adapterId ?? 'dsh.read.v1', adapterVersion: structured?.adapterVersion ?? '1.0.0',
      }, 'filesystem', hostLock)
    }
    case 'write':
    case 'write_file': {
      const { subjects, operationTargets, coherent } = nativeFileSubjects(args, result.meta, defaultCwd)
      return capabilityGatedSubject({
        capabilities: ['filesystem-write'],
        subjects,
        surfaces: ['artifact'],
        operations: operationTargets.map((path) => ({ op: 'create', path })),
        semanticAction: structured?.semanticAction ?? 'create', evidenceRole: structured?.evidenceRole ?? 'effect',
        resolvedTarget: structured?.resolvedTarget ?? { ...(operationTargets[0] ? { artifact_id: operationTargets[0] } : {}), scope: defaultCwd ?? 'scope' },
        parseStatus: coherent ? 'supported' : 'adapter_unavailable',
        ...(coherent ? {} : { outcome: 'unknown', reasonCode: 'native_file_target_unverified' }),
        adapterId: structured?.adapterId ?? 'dsh.write.v1', adapterVersion: structured?.adapterVersion ?? '1.0.0',
      }, 'filesystem', hostLock)
    }
    case 'edit':
    case 'edit_file': {
      const { subjects, operationTargets, coherent } = nativeFileSubjects(args, result.meta, defaultCwd)
      return capabilityGatedSubject({
        capabilities: ['filesystem-edit'],
        subjects,
        surfaces: ['artifact'],
        operations: operationTargets.map((path) => ({ op: 'modify', path })),
        semanticAction: structured?.semanticAction ?? 'modify', evidenceRole: structured?.evidenceRole ?? 'effect',
        resolvedTarget: structured?.resolvedTarget ?? { ...(operationTargets[0] ? { artifact_id: operationTargets[0] } : {}), scope: defaultCwd ?? 'scope' },
        parseStatus: coherent ? 'supported' : 'adapter_unavailable',
        ...(coherent ? {} : { outcome: 'unknown', reasonCode: 'native_file_target_unverified' }),
        adapterId: structured?.adapterId ?? 'dsh.edit.v1', adapterVersion: structured?.adapterVersion ?? '1.0.0',
      }, 'filesystem', hostLock)
    }
    case 'bash':
    case 'shell':
    case 'pwsh': {
      const command = typeof args.command === 'string' ? args.command : ''
      const backgrounded = args.run_in_background === true
      const commandDetails = analyzeCommand(command, typeof args.workdir === 'string' ? args.workdir : defaultCwd, call.name)
      const commandCwd = typeof args.workdir === 'string' ? args.workdir : defaultCwd
      const action = structured?.semanticAction ?? semanticActionFromCommand(command)
      const deterministic = commandDetails.status === 'supported' && !backgrounded && isDeterministicCheck(command)
      // The bundled DSH session shell renderers (`dsh-tool-bash` / `dsh-tool-pwsh`)
      // append markers only for negative terminal facts or non-zero exits; a
      // completed foreground result with no marker is therefore a clean success
      // for those two registered tools. That rule is NOT generalized: the
      // generic `shell` alias has no verified renderer contract, and a result
      // that carries a marker this scanner cannot classify stays `unknown`
      // rather than being promoted to success (0.1.5-rc.1 added the
      // persistent-renderer `[Command finished with exit code N]` and
      // `[Command timed out or OOM]` markers).
      // 0.6.2 D062-02: the frozen `outcome` keeps the HISTORICAL rule, so
      // already-recorded evidence digests do not move. The derived layer reads
      // the trusted run declaration first and reports its own verdict, its
      // source, and whether it disagrees with the frozen reading.
      const terminal = legacyTerminalFacts(result.meta, result.textContent)
      const surface = call.name as 'bash' | 'pwsh' | 'shell'
      const outcome = shellOutcome(surface, terminal, result.error, backgrounded)
      const processFacts = shellProcessFacts(
        result.meta, result.textContent, outcome, result.error, surface,
        backgrounded, parseStatus(commandDetails).parseStatus,
      )
      const subject: ToolSubject = {
        capabilities: ['shell', ...(deterministic ? ['deterministic-check'] : [])],
        subjects: unique(commandDetails.subjects),
        surfaces: ['scope'],
        outcome,
        processFacts,
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
    ...(subject.causedByCallId ? { causedByCallId: subject.causedByCallId } : {}),
    ...(subject.nativeCanonicalPath ? { nativeCanonicalPath: subject.nativeCanonicalPath } : {}),
    ...(subject.nativeCanonicalBase ? { nativeCanonicalBase: subject.nativeCanonicalBase } : {}),
    ...(subject.nativeGitTreeOid ? { nativeGitTreeOid: subject.nativeGitTreeOid } : {}),
    ...(subject.nativeGitParentOid ? { nativeGitParentOid: subject.nativeGitParentOid } : {}),
    ...(subject.readinessForItemId ? { readinessForItemId: subject.readinessForItemId } : {}),
    ...(subject.readinessPredicate ? { readinessPredicate: subject.readinessPredicate } : {}),
    ...(subject.readinessManifestSha256 ? { readinessManifestSha256: subject.readinessManifestSha256 } : {}),
    ...(subject.readinessEffectCallId ? { readinessEffectCallId: subject.readinessEffectCallId } : {}),
    ...(subject.readinessSelectedPath ? { readinessSelectedPath: subject.readinessSelectedPath } : {}),
    ...(subject.readinessScriptName ? { readinessScriptName: subject.readinessScriptName } : {}),
    ...(subject.readinessInputSha256 ? { readinessInputSha256: subject.readinessInputSha256 } : {}),
    // 0.6.2 D062-02: the layered shell reading is DERIVED and excluded from
    // every frozen digest/certificate domain. The host result's own error flag
    // is the ONE thing this wrapper may add on top of the subject's reading: the
    // wrapper is what knows about it, and both the frozen field above and the
    // layered reading must show it. Every other derived field — including a
    // trusted run declaration's exit code — preserves the independent derived
    // verdict and its conflict flag.
    ...(subject.processFacts ? {
      processFacts: subject.processFacts.hostToolReturned === (result.error ? 'error' : 'result')
        ? subject.processFacts
        : {
            ...subject.processFacts,
            hostToolReturned: result.error ? 'error' as const : 'result' as const,
            // The host result's own error flag is the one fact this wrapper
            // adds; it applies to both layers, and the conflict flag follows.
            ...(result.error ? { outcome: 'failure' as const, outcomeReason: 'host_error_flag' as const } : {}),
            frozenOutcomeConflict: (result.error ? 'failure' : subject.processFacts.outcome) !== outcome,
          },
    } : {}),
    ...(subject.externalOperationRef ? { externalOperationRef: { ...subject.externalOperationRef, epoch } } : {}),
  }
}

export function withDurability(evidence: GuardEvidence, confirmed: boolean): GuardEvidence {
  if (confirmed) return evidence
  return { ...evidence, outcome: 'durability-unknown' }
}
