//#region src/domain/canonicalize.d.ts
declare function normalizeClause(text: string): string;
/**
* Canonicalize a filesystem path for subject matching. Windows-style paths are
* normalized (drive letter, both separator kinds, `.`/`..`, duplicate
* separators) and case-folded, because Windows paths compare case-insensitively
* and treat `/` and `\` as equivalent. POSIX-style paths are normalized but
* keep their case, so a case-sensitive filesystem is never made insensitive.
* Exactly one canonicalizer is shared by contract capture and evidence
* extraction so a Windows contract subject and a Windows evidence subject match.
*/
declare function canonicalizePath(value: string): string;
declare function sha256(text: string): string;
declare function digestStrings(values: readonly string[]): string;
declare function sanitizeClauseText(text: string): string;
declare function sanitizeUrl(value: string): string;
//#endregion
//#region src/domain/types.d.ts
type GuardItemKind = "requirement" | "acceptance" | "prohibition";
type GuardItemStatus = "pending" | "passed" | "superseded";
type GuardIntegrity = "valid" | "unknown" | "corrupt";
type EvidenceOutcome = "success" | "failure" | "unknown";
type GuardOperation = "create" | "write" | "modify" | "read" | "run" | "verify";
interface VerificationContract {
  subject?: string;
  surface?: "artifact" | "ui" | "visual" | "scope";
  enforced: boolean;
  /** Explicitly-required tool/method (e.g. 'bash'); when set, a successful
  * evidence from that tool must be present in addition to artifact/scope
  * coverage before the item can close. */
  method?: string;
  /** Explicitly-required operation/effect (e.g. 'create', 'read'). When set
  * alongside `method`, the method evidence must have performed that operation
  * on the same canonical subject — mentioning the file is not enough. */
  operation?: GuardOperation;
}
interface GuardItem {
  id: string;
  revision: number;
  kind: GuardItemKind;
  sourceMessageId: string;
  normalizedText: string;
  textSha256: string;
  status: GuardItemStatus;
  supersededBy?: string;
  verification: VerificationContract;
}
interface GuardEvidence {
  id: string;
  epoch: number;
  callId: string;
  rootCallId: string;
  toolName: string;
  toolResultSeq: number;
  outcome: EvidenceOutcome;
  capabilities: string[];
  subjects: string[];
  surfaces: Array<"artifact" | "ui" | "visual" | "scope">;
  boundedSummarySha256: string;
  /** Executables invoked by a shell-tool command (e.g. 'pnpm', 'git'); present
  * only for command evidence, so an executable-method constraint ("使用 pnpm")
  * can be verified against the command that actually ran. */
  executables?: string[];
  /** Operations with their paths, parsed from the evidence's command or tool
  * payload (quote-aware). A subject mention alone proves nothing; the evidence
  * must show the requested operation on the target. */
  operations?: Array<{
    op: GuardOperation;
    path?: string;
  }>;
}
interface EvidenceBinding {
  itemId: string;
  evidenceIds: string[];
}
interface GuardCheckpoint {
  id: string;
  epoch: number;
  contractRevision: number;
  openDigest: string;
  bindingDigest: string;
  bindings: EvidenceBinding[];
  result: "certified" | "incomplete" | "unknown";
}
interface GuardProjection {
  enabled: boolean;
  epoch: number;
  contractRevision: number;
  items: Map<string, GuardItem>;
  evidence: Map<string, GuardEvidence>;
  checkpoints: GuardCheckpoint[];
  lastObservedSourceSeq: number;
  lastGuardEventSeq: number;
  lastRecoveryDigest?: string;
  continuationAttempts: Map<number, number>;
  integrity: GuardIntegrity;
}
declare function createProjection(): GuardProjection;
interface DeriveScope {
  /** Session working directory; used as the scope subject for captured clauses. */
  cwd?: string;
}
interface DeriveConfig {
  activation: "opt-in" | "always";
}
interface DeriveResult {
  projection: GuardProjection;
  /** True when the log contains a compaction summary the agent must recover from. */
  compacted: boolean;
  /** True when an off→on enablement transition was derived in this log. */
  enablementTransitioned: boolean;
  /** Sequence of the last compaction summary in the log, or -1 when none. */
  lastCompactionSeq: number;
}
interface DerivedEnvelope {
  seq: number;
  type: string;
  data?: unknown;
}
//#endregion
//#region src/domain/capture.d.ts
interface ClassifiedClause {
  kind: GuardItemKind;
  body: string;
}
declare function classifyClause(text: string): ClassifiedClause;
/**
* Detect an explicitly named tool/method in a clause ("使用 bash 创建",
* "via bash", "bash to create"). Returns the canonical tool id (e.g. 'bash')
* or undefined when no explicit method is named.
*/
declare function extractMethod(text: string): string | undefined;
/**
* Whether a whole user message reads as an informational report (acceptance
* receipt, progress summary, pasted log) rather than a task instruction.
* Evaluation is deliberately conservative: reports are detected only when the
* shape is clearly report-like (markdown headings, bold key/value lines, list
* or table rows, evidence terms) AND no sentence opens with an imperative, and
* any question mark keeps the message a task. False positives here would drop
* real instructions, so plain short sentences are never treated as reports.
*/
declare function isInformationalMessage(text: string): boolean;
/**
* Detect an explicit operation/effect in a clause ("创建" → create,
* "读取" → read, "运行" → run). Returns the first operation named, or undefined
* when the clause requests no specific effect.
*/
declare function extractOperation(text: string): GuardOperation | undefined;
interface CaptureScope {
  /** Session working directory; used as the scope subject when no artifact path is named. */
  cwd?: string;
}
declare function extractArtifactPaths(text: string): string[];
/**
* Split a single human message into independently tracked clauses. Sentence
* boundaries and embedded prohibition keywords delimit segments so a compound
* instruction such as "Modify src/a.ts and src/b.ts. Do not push." yields
* separate items instead of collapsing into one artifact.
*/
interface ClauseSegment {
  kind: GuardItemKind;
  body: string;
  paths: string[];
}
declare function segmentClauses(text: string): ClauseSegment[];
/**
* Build a GuardItem from an already-classified clause body and a resolved
* verification subject/surface.
*/
declare function captureItem(kind: GuardItemKind, body: string, sourceMessageId: string, id: string, revision: number, subject: string, surface: "artifact" | "scope", method?: string, operation?: GuardOperation): GuardItem;
/**
* Capture one contract clause. Every captured item receives a concrete
* verification contract: a named artifact path (artifact surface) or the
* session scope (scope surface), so an unrelated file read can never close it.
*/
declare function captureClause(text: string, sourceMessageId: string, id: string, revision: number, scope?: CaptureScope): GuardItem;
//#endregion
//#region src/domain/checkpoint.d.ts
interface RejectedBinding {
  itemId: string;
  reason: string;
  hint?: string;
}
interface CheckpointResult {
  status: GuardCheckpoint["result"];
  contractRevision: number;
  openItems: string[];
  rejectedBindings: RejectedBinding[];
  checkpoint?: GuardCheckpoint;
}
declare function certifyCheckpoint(projection: GuardProjection, bindings: EvidenceBinding[], id: string): CheckpointResult;
//#endregion
//#region src/domain/conversation.d.ts
type UserInteractionKind = "instruction" | "conversational";
/**
* Classify a direct user message (or one clause of it) as an actionable
* `instruction` or a session-layer `conversational` utterance. Only
* conversational results drop capture, so the classifier fails closed:
* everything it cannot confidently recognize as session-layer talk stays an
* instruction and is captured exactly as before.
*
* Order matters: progression and prohibition leads first, then strong task
* features (artifact path, explicit method, or a non-negated operation verb
* outside progression/meta spans), then the meta-question and meta-comment
* forms, and finally a progression lead over a featureless remainder.
*/
declare function classifyUserInteraction(text: string): UserInteractionKind;
//#endregion
//#region src/domain/derive.d.ts
/**
* Pure, deterministic re-derivation of the guard projection from the DSH
* native event log. Context Guard never writes custom session events, so every
* piece of state is derived from `command/run`, `user/message`, `tool/call`,
* `tool/result`, `tool/code-dispatch-start`, `tool/code-dispatch`, and
* `compaction/summary`.
*/
declare function deriveProjection(sourceEvents: readonly DerivedEnvelope[], config: DeriveConfig, scope: DeriveScope, durableConfirmed: boolean): DeriveResult;
//#endregion
//#region src/domain/evidence.d.ts
interface ToolCallInput {
  callId: string;
  name: string;
  arguments: string;
  /** Code-mode dispatch root; falls back to `callId` when the harness does not carry one. */
  rootCallId?: string;
}
interface ToolResultInput {
  seq: number;
  error?: unknown;
  meta?: unknown;
  textContent: string;
}
declare function extractTextContent(content: readonly unknown[]): string;
interface ToolOperation {
  op: GuardOperation;
  path?: string;
}
declare function isDeterministicCheck(command: string): boolean;
interface ToolSubject {
  capabilities: string[];
  subjects: string[];
  surfaces: Array<"artifact" | "ui" | "visual" | "scope">;
  outcome?: EvidenceOutcome;
  executables?: string[];
  operations?: ToolOperation[];
}
declare function extractToolSubject(call: ToolCallInput, result: ToolResultInput, defaultCwd?: string): ToolSubject;
declare function evidenceFromPersistedToolResult(call: ToolCallInput, result: ToolResultInput, epoch: number, evidenceId: string, defaultCwd?: string): GuardEvidence;
declare function withDurability(evidence: GuardEvidence, confirmed: boolean): GuardEvidence;
//#endregion
//#region src/domain/goal-gate.d.ts
declare function hasCurrentCertificate(projection: GuardProjection): boolean;
/**
* Denies `update_goal(action=complete)` while the guard is enabled and no
* current completion certificate exists. The gate itself has no bypass; a
* workflow that genuinely finished but cannot certify (for example a contract
* polluted by session-layer talk, or evidence that lives in another session)
* has three explicit remediation routes:
*
* 1. `/context-guard off` disables the guard, so completion is no longer
*    gated. Use only after the user confirms the work is actually done.
* 2. `/context-guard clear` supersedes every pending requirement and
*    acceptance under a `CLEAR:<revision>` sentinel (prohibitions are
*    retained) and bumps the contract revision; an empty-binding checkpoint
*    can then certify while the guard stays enabled.
* 3. `update_goal(action=blocked)` records the blocker truthfully, which is
*    never denied by this gate.
*/
declare function goalCompletionDenial(projection: GuardProjection, toolName: string, argumentsValue: unknown, configuredToolName?: string): string | undefined;
//#endregion
//#region src/domain/manifest.d.ts
/**
* The single source of truth for the certifiable command surface (v0.2).
*
* Every enumeration that decides which command shapes can produce evidence
* lives HERE, loaded by the parsers and by the contract capture. Adding a tool
* or a task verb is a data change, not a code change. The manifest is shipped
* with the package and is intentionally NOT runtime-writable: widening the
* surface lowers the evidence bar, so it must change only through a reviewed
* release, never through local configuration.
*/
interface OperationVerbEntry {
  op: GuardOperation;
  /** RegExp source, matched case-insensitively; array order = priority. */
  pattern: string;
}
interface CommandSurfaceManifest {
  /** POSIX file-effect tools (`printf`, `echo`, `touch`, `cat`). */
  fileTools: string[];
  /** POSIX read-only inspection tools; pathish args become read effects. */
  readTools: string[];
  /** POSIX run-executable whitelist (any supported simple command gets run semantics). */
  runExecutables: string[];
  /** PowerShell external-executable whitelist (mirrors runExecutables). */
  pwshExternalExecutables: string[];
  /**
  * Clause verb → operation mapping. Order matters: the first matching group
  * wins, and the group order is create → modify → read → verify → run.
  */
  operationVerbs: OperationVerbEntry[];
}
declare const COMMAND_SURFACE_MANIFEST: CommandSurfaceManifest;
interface ManifestIssue {
  path: string;
  message: string;
}
/**
* Validate the manifest invariants the parsers and capture depend on:
* - every collection is non-empty, sorted-case-insensitively, and duplicate-free
* - external executables mirror the POSIX run set exactly
* - verb groups exist once, in the documented priority order, and compile
* (they compile by construction when validated, so a typo cannot silently
* widen or break the surface).
*/
declare function validateManifest(manifest?: CommandSurfaceManifest): ManifestIssue[];
//#endregion
//#region src/domain/matching.d.ts
declare function isVerifyingCapability(evidence: GuardEvidence): boolean;
/** The facets a single evidence contributes to for an item. */
interface EvidenceFacetCoverage {
  artifact: boolean;
  effect: boolean;
  method: boolean;
  verify: boolean;
  run: boolean;
}
declare function evidenceCoverage(item: GuardItem, evidence: GuardEvidence): EvidenceFacetCoverage;
/**
* Whether a single evidence can close an enforced item on its own. This is the
* conservative per-evidence check; the certifier additionally verifies that the
* whole binding satisfies every required facet.
*/
declare function evidenceMatchesItem(item: GuardItem, evidence: GuardEvidence): boolean;
/**
* Whether a whole binding (a set of evidence ids) satisfies the fixed v0.1
* binding invariants:
*
* - run: the method (or run) evidence alone closes the contract — no extra
*   read or unrelated deterministic-check is required.
* - create/write/modify: BOTH a method evidence (method + operation + subject)
*   and a state-verification evidence on the same subject are required.
* - read: a successful read evidence matching method, read operation and
*   subject satisfies the method side and the object side at once.
* - verify: only explicit read/verify/deterministic-check evidence on the
*   subject closes; unrelated scope calls cannot be spliced in.
* - explicit method without a parsable operation fails closed.
* - a non-enforced item (prohibition) is acknowledged by any valid success
*   evidence.
*/
declare function bindingSatisfies(projection: GuardProjection, item: GuardItem, evidenceIds: string[]): boolean;
//#endregion
//#region src/domain/recovery.d.ts
interface RecoveryOptions {
  rejectedBindings?: Array<{
    itemId: string;
    reason: string;
  }>;
  charBudget?: number;
}
declare const DEFAULT_RECOVERY_CHAR_BUDGET = 4e3;
/**
* An actionable one-line hint for how an open item's verification contract can
* be closed. It never weakens the contract; it only names the missing facet so
* the agent can produce the right evidence shape instead of reverse-engineering
* the guard. When `evidenceIds` is given, the hint accounts for what those
* evidence already cover.
*/
declare function closingHint(projection: GuardProjection, item: GuardItem, evidenceIds?: string[]): string;
declare function openItems(projection: GuardProjection): GuardItem[];
/**
* Content identity of a rendered recovery packet, bound to the contract
* revision and epoch it was rendered from. The runtime compares digests before
* re-injecting, so a repeatedly re-armed recovery with unchanged content is
* injected once instead of looping (v0.2.1).
*/
declare function recoveryDigest(packet: string, projection: GuardProjection): string;
declare function renderRecoveryPacket(projection: GuardProjection, options?: RecoveryOptions): string;
//#endregion
//#region src/domain/shell-parse.d.ts
/**
* v0.1 certifiable command subset parser.
*
* This is NOT a general Bash or PowerShell static analyzer. Only a small,
* auditable grammar is supported: a single foreground simple command whose
* grammar parses fully. Anything else returns `status: 'unsupported'` (or
* `'malformed'` for unterminated quotes) with EMPTY executables and operations,
* so an unrecognized command can never certify an operation. False negatives
* are preferred over false positives: uncertain commands stay incomplete.
*/
type ShellParseStatus = "supported" | "unsupported" | "malformed";
interface ParsedShell {
  status: ShellParseStatus;
  /** Human-readable reason when the command is not supported (or malformed). */
  reason?: string;
  executables: string[];
  operations: Array<{
    op: GuardOperation;
    path?: string;
  }>;
  malformed: boolean;
}
/**
* Whether an executable carries run semantics (as opposed to the tiny
* file/read tool subset). Used for scope-subject attribution of a pathless
* run operation; `echo` or `cat` never becomes a subject-carrying run.
*/
declare function isRunExecutable(executable: string): boolean;
/**
* Parse one POSIX shell command against the v0.1 supported surface: a single
* foreground simple command made of an env-assignment prefix, one whitelisted
* executable and literal arguments, with at most one `>`/`>>` redirect to a
* literal path. Compound syntax (`;`, `&&`, `||`, pipes, background, subshells,
* command substitution, heredocs, unclosed quotes, dynamic eval/source,
* variable/glob paths) makes the WHOLE command unsupported with no partial
* results.
*/
declare function parseShellCommand(command: string): ParsedShell;
/**
* Parse one PowerShell command against the v0.2 subset: a single, directly
* invoked whitelisted cmdlet (Set-Content / Add-Content / New-Item /
* Out-File / Get-Content) whose path comes from an explicit named path
* parameter, or a whitelisted external executable (git, pnpm, node, …) with
* all-literal arguments. Unquoted `N>&M` diagnostic stream duplication is
* stripped. Multi-statements (`;`), pipelines (`|`), the call operator (`&`),
* script blocks, dot sourcing, .NET/dynamic invocation,
* variable/expression/subexpression paths, positional paths, and unknown
* parameters make the WHOLE command unsupported.
*/
declare function parsePwshCommand(command: string): ParsedShell;
//#endregion
//#region src/domain/stop-policy.d.ts
type CompletionDisposition = "complete" | "user_wait" | "external_wait" | "report";
declare function isWholeTaskCompletionClaim(text: string): boolean;
declare function classifyCompletionClaim(text: string): CompletionDisposition;
interface TurnStoppingDecision {
  action: "continue" | "stop";
  reason?: string;
}
declare function decideTurnStopping(projection: GuardProjection, assistantText: string, turn: number, maxAttempts: number): TurnStoppingDecision;
declare function latestAssistantText(events: readonly {
  type: string;
  data: unknown;
}[]): string;
//#endregion
//#region src/domain/supersession.d.ts
declare function supersedeItem(items: Map<string, GuardItem>, oldId: string, replacement: GuardItem): boolean;
//#endregion
export { extractOperation as $, hasCurrentCertificate as A, UserInteractionKind as B, isVerifyingCapability as C, sha256 as Ct, OperationVerbEntry as D, ManifestIssue as E, extractTextContent as F, CaptureScope as G, CheckpointResult as H, extractToolSubject as I, captureClause as J, ClassifiedClause as K, isDeterministicCheck as L, ToolResultInput as M, ToolSubject as N, validateManifest as O, evidenceFromPersistedToolResult as P, extractMethod as Q, withDurability as R, evidenceMatchesItem as S, sanitizeUrl as St, CommandSurfaceManifest as T, RejectedBinding as U, classifyUserInteraction as V, certifyCheckpoint as W, classifyClause as X, captureItem as Y, extractArtifactPaths as Z, recoveryDigest as _, createProjection as _t, decideTurnStopping as a, DerivedEnvelope as at, bindingSatisfies as b, normalizeClause as bt, ParsedShell as c, GuardCheckpoint as ct, parsePwshCommand as d, GuardItem as dt, isInformationalMessage as et, parseShellCommand as f, GuardItemKind as ft, openItems as g, VerificationContract as gt, closingHint as h, GuardProjection as ht, classifyCompletionClaim as i, DeriveScope as it, ToolCallInput as j, goalCompletionDenial as k, ShellParseStatus as l, GuardEvidence as lt, RecoveryOptions as m, GuardOperation as mt, CompletionDisposition as n, DeriveConfig as nt, isWholeTaskCompletionClaim as o, EvidenceBinding as ot, DEFAULT_RECOVERY_CHAR_BUDGET as p, GuardItemStatus as pt, ClauseSegment as q, TurnStoppingDecision as r, DeriveResult as rt, latestAssistantText as s, EvidenceOutcome as st, supersedeItem as t, segmentClauses as tt, isRunExecutable as u, GuardIntegrity as ut, renderRecoveryPacket as v, canonicalizePath as vt, COMMAND_SURFACE_MANIFEST as w, evidenceCoverage as x, sanitizeClauseText as xt, EvidenceFacetCoverage as y, digestStrings as yt, deriveProjection as z };