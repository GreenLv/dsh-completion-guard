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
//#region src/domain/protocol-manifest.d.ts
declare const STOP_PROTOCOL_VERSION = "2.0.0";
declare const CERTIFICATE_VERSION = "1";
declare const ACTION_MANIFEST_VERSION = 1;
declare const SUPPORTED_EVIDENCE_ADAPTERS: Readonly<Record<string, string>>;
declare const SEMANTIC_ACTIONS: readonly ["inspect_remote_updates", "install", "apply", "create", "modify", "test", "verify", "pull", "fetch", "commit", "push", "restart", "publish", "generic_run"];
type SemanticAction = (typeof SEMANTIC_ACTIONS)[number];
type StatefulAction = "install" | "apply" | "create" | "modify" | "restart" | "commit" | "push" | "publish" | "pull" | "fetch";
declare const STATEFUL_ACTIONS: readonly StatefulAction[];
interface ActionSpec {
  stateful: boolean;
  evidenceProducer: "supported" | "unavailable";
  resolvedTargetKeys: string[];
  observedStateKeys: string[];
  predicateId: string;
  commandManifestIds: string[];
}
interface ActionManifest {
  version: number;
  actions: Record<SemanticAction, ActionSpec>;
  compatibility: Record<SemanticAction, SemanticAction[]>;
}
declare const ACTION_MANIFEST: ActionManifest;
declare function semanticActionFromText(text: string): SemanticAction;
declare function semanticActionFromCommand(command: string): SemanticAction;
declare function isStatefulAction(action: SemanticAction): action is StatefulAction;
declare function actionCompatible(required: SemanticAction, observed: SemanticAction): boolean;
declare function validateActionTarget(action: SemanticAction, resolved: TargetTuple | undefined, observed: TargetTuple | undefined): boolean;
/**
* Compare identities captured from the root instruction with a complete
* adapter-resolved target. Requested targets are partial by design: only
* explicitly named identities (plus the active repository scope) are frozen.
*/
declare function requestedTargetMatchesResolved(action: StatefulAction, requested: TargetTuple | undefined, resolved: TargetTuple | undefined): boolean;
/** A mutation requires every user-selectable identity field, not a partial match. */
declare function requestedTargetAuthorizesMutation(action: StatefulAction, requested: TargetTuple | undefined, resolved: TargetTuple | undefined): boolean;
declare function validateActionManifest(): string[];
//#endregion
//#region src/domain/digest.d.ts
type TypedObject = {
  k: "b" | "i" | "s" | "e" | "x";
  v: unknown;
};
type Typed = boolean | number | string | TypedObject;
interface SessionHeader {
  version: number;
  id: string;
  createdAt: number;
  parentSession?: string;
  seedLength?: number;
  agentPreset?: string;
  origin?: string;
  delegationDepth?: number;
}
interface CapabilityRow {
  name: string;
  value: Typed;
}
interface PackageRow {
  name: string;
  version?: string;
  integrity?: string;
}
//#endregion
//#region src/domain/types.d.ts
type GuardItemKind = "requirement" | "acceptance" | "prohibition";
type GuardItemStatus = "pending" | "passed" | "superseded";
type GuardIntegrity = "valid" | "unknown" | "corrupt";
type EvidenceOutcome = "success" | "failure" | "unknown" | "durability-unknown";
type GuardOperation = "create" | "write" | "modify" | "read" | "run" | "verify";
type TargetValue = boolean | number | string | {
  k: "b" | "i" | "s" | "e" | "x";
  v: unknown;
};
type TargetTuple = Record<string, TargetValue>;
type EvidenceRole = "resolution" | "effect" | "state";
type EvidenceParseStatus = "supported" | "unsupported_statement_operator" | "unsupported_command" | "malformed_quote" | "adapter_unavailable";
type HostStatus = "supported" | "unsupported" | "unavailable";
type TargetCaptureStatus = "resolved" | "clarification_required";
type TargetCaptureReasonCode = "requested_target_package_id_missing" | "requested_target_artifact_id_missing" | "requested_target_repository_missing" | "requested_target_service_id_missing" | "requested_target_registry_missing_or_invalid";
interface GoalRef {
  id: string;
  revision: number;
}
interface WaitAuthorization {
  kind: "root_explicit_wait" | "user_decision_item";
  id: string;
}
interface DeferAuthorization {
  kind: "root_explicit_defer";
  id: string;
}
interface PersistenceAuthorization {
  kind: "root_explicit_persistence";
  id: string;
}
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
  semanticAction?: SemanticAction;
  requestedTarget?: TargetTuple;
  targetCaptureStatus?: TargetCaptureStatus;
  targetCaptureReasonCode?: TargetCaptureReasonCode;
  authority?: "root_instruction" | "root_adoption" | "legacy_authority_unclassified";
  legacyFlags?: Array<"legacy_generic_run" | "legacy_authority_unclassified">;
  waitAuthorization?: WaitAuthorization;
  deferAuthorization?: DeferAuthorization;
  persistenceAuthorization?: PersistenceAuthorization;
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
  semanticAction?: SemanticAction;
  evidenceRole?: EvidenceRole;
  resolvedTarget?: TargetTuple;
  observedState?: TargetTuple;
  /** Immutable predicate frozen by a trusted resolution producer before effect. */
  expectedTransition?: ExpectedTransition;
  /** Stable JSON sha256 of expectedTransition, minted by the same resolution producer. */
  expectedTransitionDigest?: string;
  parseStatus?: EvidenceParseStatus;
  reasonCode?: string;
  adapterId?: string;
  adapterVersion?: string;
  externalOperationRef?: ExternalOperation;
}
interface ExpectedTransition {
  predicateId: string;
  version: number;
  predParamsKind: "inline";
  parameters?: TargetTuple;
  parametersDigest?: string;
}
interface EvidenceBinding {
  itemId: string;
  evidenceIds: string[];
  semanticAction?: SemanticAction;
  requestedTarget?: TargetTuple;
  resolvedTarget?: TargetTuple;
  observedState?: TargetTuple;
  expectedTransition?: ExpectedTransition;
  resolutionEvidenceId?: string;
  effectEvidenceId?: string;
  stateEvidenceIds?: string[];
}
interface GuardCheckpoint {
  id: string;
  stopProtocolVersion: string;
  certificateVersion: string;
  epoch: number;
  sessionRefDigest: string;
  hostLockDigest: string;
  contractRevision: number;
  contractSha256: string;
  openDigest: string;
  evidenceSha256: string;
  bindingDigest: string;
  bindings: EvidenceBinding[];
  goalRef?: GoalRef;
  certificationDigest: string;
  result: "certified" | "incomplete" | "unknown";
}
type BoundaryDisposition = "user_wait" | "external_wait" | "deferred";
type BoundaryQualificationKind = "user_decision_item" | "root_explicit_wait" | "external_operation_pending" | "root_explicit_defer";
interface GuardBoundary {
  protocolVersion: "1";
  id: string;
  disposition: BoundaryDisposition;
  qualificationKind: BoundaryQualificationKind;
  qualificationIds: string[];
  epoch: number;
  contractRevision: number;
  contractSha256: string;
  goalRef?: GoalRef;
  candidateSha256: string;
  callId?: string;
  persistedResult: "accepted" | "rejected" | "unknown";
  reasonCode: string;
}
interface ExternalOperation {
  id: string;
  epoch: number;
  adapterId: string;
  status: "running" | "pending" | "completed" | "failed" | "unknown";
}
interface GuardProjection {
  enabled: boolean;
  epoch: number;
  contractRevision: number;
  items: Map<string, GuardItem>;
  evidence: Map<string, GuardEvidence>;
  checkpoints: GuardCheckpoint[];
  boundaries: GuardBoundary[];
  externalOperations: Map<string, ExternalOperation>;
  sessionRefDigest: string;
  hostLockDigest: string;
  hostStatus: HostStatus;
  hostReasonCode?: string;
  /** Readback of the audited cohort bound into `hostLockDigest`. */
  hostCohortId?: string;
  currentGoalRef?: GoalRef;
  currentGoalPhase?: "active" | "paused" | "blocked" | "complete";
  currentGoalActivation?: "armed" | "disarmed";
  certificateStatusReason?: string;
  integrityViolations: string[];
  lastObservedSourceSeq: number;
  lastGuardEventSeq: number;
  lastRecoveryDigest?: string;
  continuationAttempts: Map<number, number>;
  /** Process-local one-shot fallback counters keyed by epoch + contract revision. */
  persistenceCorrectionAttempts: Map<string, number>;
  integrity: GuardIntegrity;
}
declare function createProjection(): GuardProjection;
interface DeriveScope {
  /** Session working directory; used as the scope subject for captured clauses. */
  cwd?: string;
  sessionHeader?: SessionHeader;
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
//#region src/domain/boundary.d.ts
interface BoundaryRequest {
  disposition: BoundaryDisposition;
  qualificationKind: BoundaryQualificationKind;
  qualificationIds: string[];
  callId?: string;
}
interface BoundaryQualification {
  id: string;
  kind: BoundaryQualificationKind;
  disposition: BoundaryDisposition;
  source: "root_contract" | "trusted_adapter";
  status: "pending" | "running";
}
/** Bounded, replay-derived qualifications that callers may cite verbatim. */
declare function availableBoundaryQualifications(projection: GuardProjection): BoundaryQualification[];
declare function qualifyBoundary(projection: GuardProjection, request: BoundaryRequest): GuardBoundary;
/**
* Reconstruct the immutable candidate against the latest replay projection.
* A persisted acceptance is not effectuation authority after any contract,
* Goal, epoch, or qualification change.
*/
declare function isCurrentAcceptedBoundary(projection: GuardProjection, boundary: GuardBoundary): boolean;
interface GoalActivationState extends GoalRef {
  phase: "active" | "paused" | "blocked" | "complete";
  activation: "armed" | "disarmed";
}
interface GoalBoundaryAccess {
  get(): Promise<GoalActivationState | undefined>;
  disarm(): Promise<GoalActivationState | undefined>;
  /** Final live adapter readback immediately before any Goal mutation. */
  requalify?: () => Promise<boolean>;
}
interface BoundaryEffectuation {
  boundaryId: string;
  goalRef?: GoalRef;
  reasonCode: "boundary_effectuated" | "boundary_no_goal_safe_yield" | "boundary_already_disarmed" | "boundary_pre_effect_failure" | "boundary_readback_still_armed" | "boundary_post_effect_unknown" | "boundary_goal_ref_stale" | "boundary_not_accepted";
  stopAllowed: boolean;
  resumeRequired: boolean;
}
/**
* Effectuate only a replay-confirmed accepted boundary. The first disarm result
* and an independent get() must both read the same active Goal ref as disarmed.
* A failure after disarm may have taken effect is never auto-rearmed.
*/
declare function effectuateBoundary(boundary: GuardBoundary, access: GoalBoundaryAccess): Promise<BoundaryEffectuation>;
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
  reasonCode: string;
  offendingEvidenceIds?: string[];
  hint?: string;
}
interface CheckpointResult {
  status: GuardCheckpoint["result"];
  contractRevision: number;
  openItems: string[];
  rejectedBindings: RejectedBinding[];
  checkpoint?: GuardCheckpoint;
}
declare function certifyCheckpoint(projection: GuardProjection, bindings: EvidenceBinding[], id: string, commit?: boolean): CheckpointResult;
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
//#region src/domain/contract-segment.d.ts
type AuthorityBlockKind = "instruction" | "reference" | "quoted" | "code" | "uncertain";
type AuthorityKind = "root_instruction" | "root_adoption" | "none";
interface AuthorityBlock {
  kind: AuthorityBlockKind;
  authority: AuthorityKind;
  text: string;
  capture: boolean;
  blockId: string;
}
/**
* Split a direct root-user message into authority blocks before clause capture.
* Framed reports, blockquotes and fenced code remain in the native DSH log but
* never become Guard items. Uncertain prose is captured fail-closed. Explicit
* adoption can promote only the referenced section, never the whole report by
* virtue of normative words inside the report itself.
*/
declare function segmentAuthorityBlocks(text: string, priorRootMessages?: readonly string[]): AuthorityBlock[];
declare function authorityCaptureCounts(blocks: readonly AuthorityBlock[]): Record<string, number>;
//#endregion
//#region src/domain/contract-digest.d.ts
/** One authoritative contract identity shared by checkpoints and boundaries. */
declare function currentContractDigest(projection: GuardProjection): string;
//#endregion
//#region src/domain/host-lock.d.ts
type HostLockStatus = "supported" | "unsupported" | "unavailable";
type HostPlatform = "posix" | "windows";
type HostProfileKind = "headless" | "web";
interface HostCohort {
  /** Stable cohort identity; bound into every hostLockDigest via `host_cohort`. */
  id: string;
  manifestVersion: number;
  supportedGoalVersions: string[];
  /**
  * Platforms where this cohort's exact package graph was extracted from a
  * native host and audited. Other platforms fail closed; integrity must not
  * be inferred across platforms.
  */
  auditedPlatforms: readonly HostPlatform[];
  packages: PackageRow[];
  capabilities: CapabilityRow[];
}
/**
* alpha.2 audited package identities (second registry cohort), hoisted so the
* alpha.2 + dshmarket 1.39.0 cohort can reuse the exact natively audited rows
* with only the dshmarket identity substituted.
*/
declare const ALPHA2_HOST_PACKAGES: PackageRow[];
/**
* The exact graph the Windows daily runtime realized when it upgraded
* dshmarket to 1.39.0 on an otherwise alpha.2 install — the combination whose
* rejection was Guard 0.3.2's real web_control failure. It is one audited
* whole-graph cohort: alpha.2 rows keep their native macOS/Windows audit
* identities and the dshmarket 1.39.0 identity is the authoritative row from
* the 2026-09-01 alpha.3 annex audit. Guard 0.4.0 supports this combination.
*/
declare const ALPHA2_DSHMARKET_139_HOST_PACKAGES: PackageRow[];
/**
* Audited host cohort registry. The rc.2 cohort keeps the exact identities
* audited for 0.3.0/0.3.1 on macOS and Windows. The alpha.2 cohort carries the
* exact package graph extracted from native macOS and Windows DSH
* `0.1.2-alpha.2` / dshmarket `1.38.1` runtimes. The alpha.2+dshmarket-1.39.0
* cohort carries the exact upgraded-Windows graph. The alpha.3 cohort carries
* the graph audited in the 2026-09-01 annex. The rc.1 cohort carries the exact
* runtime plus dshmarket 1.41.0 graph audited natively on macOS, then confirmed
* on Windows: the 2026-09-04 native Windows rc.1 runtime graph (dshmarket
* 1.41.0) was extracted from the runtime lockfile and verified row-for-row
* identical (name, version, registry integrity) to the posix extraction before
* this cohort was widened. Graphs that mix cohorts, lack
* rows, duplicate rows, or use identities outside every registered cohort
* fail closed.
*/
declare const HOST_COHORTS: readonly HostCohort[];
/**
* rc.2 audited package identities (first registry cohort). The audited
* cohort is an atomic whole-graph contract (CG-DSH-001): any drifted,
* duplicated, unknown-version, unbound, OR MISSING row fails the whole lock
* closed (`host_lock_missing`); no capability inherits independence from a
* partially present graph.
*/
declare const EXPECTED_HOST_PACKAGES: PackageRow[];
declare const BASE_HOST_PACKAGES: ReadonlySet<string>;
declare const GOAL_HOST_PACKAGES: ReadonlySet<string>;
type HostCapabilityId = "agent_loop" | "terminal_posix" | "terminal_windows" | "dsh_cli" | "plugin_inventory" | "web_control" | "jobs" | "filesystem";
declare const HOST_CAPABILITY_PACKAGE_GROUPS: Readonly<Record<HostCapabilityId, ReadonlySet<string>>>;
interface HostCapabilityEvaluation {
  id: string;
  status: HostLockStatus;
  digest: string;
  requiredPackages: string[];
  missingPackages: string[];
  reasonCode?: "host_capability_missing" | "host_capability_version_mismatch" | "host_capability_integrity_mismatch" | "host_capability_duplicate_package" | "host_capability_context_missing" | "host_capability_request_unsupported";
}
interface HostLockEvaluation {
  status: HostLockStatus;
  digest: string;
  goalAvailable: boolean;
  reasonCode?: "host_lock_missing" | "host_lock_version_mismatch" | "host_lock_integrity_mismatch" | "host_lock_unknown_package" | "host_lock_duplicate_package" | "host_lock_goal_graph_incomplete" | "host_lock_goal_capability_mismatch" | "host_lock_cohort_mixed_graph" | "host_lock_cohort_unbound_identity" | "host_lock_cohort_platform_not_audited";
  packages: PackageRow[];
  capabilities: Record<HostCapabilityId, HostCapabilityEvaluation>;
  platform?: HostPlatform;
  profileKind?: HostProfileKind;
  liveGoalAvailable?: boolean;
  /** Readback of the audited cohort the supplied graph was evaluated against. */
  cohortId?: string;
  /** Audited cohort rows absent from the supplied graph (diagnostic). */
  missingPackages?: string[];
}
interface HostLockContext {
  platform?: HostPlatform;
  profileKind?: HostProfileKind;
  capabilityId?: string;
}
type HostCohortSelectionReason = "host_cohort_unknown_package" | "host_cohort_version_mismatch" | "host_cohort_integrity_mismatch" | "host_cohort_mixed_graph" | "host_cohort_incomplete_graph" | "host_cohort_unbound_identity" | "host_cohort_platform_not_audited";
interface HostCohortSelection {
  /**
  * Cohort used for expected-row lookups and digest identity. When the graph
  * does not consistently match one cohort this is the deterministic
  * closest-cohort fallback (most exact row matches, then registry order) and
  * `consistent` is false, so evaluation fails closed downstream.
  */
  cohort: HostCohort;
  /**
  * True only when every supplied row exactly matches the selected cohort
  * AND every audited cohort row is present: the audited cohort is an atomic
  * whole-graph contract, so a graph missing audited rows (missing packages)
  * never selects consistently.
  */
  consistent: boolean;
  reasonCode?: HostCohortSelectionReason;
}
/**
* Atomically select the audited cohort for one supplied package graph. A
* graph matches a cohort only when every row carries version and integrity,
* each exactly equals that cohort's audited row, and the graph covers the
* complete audited cohort (missing packages fail closed); graphs that mix
* rows from different cohorts, use versions unknown to the registry, or
* target a platform the cohort was never audited on never select
* consistently.
*/
declare function selectHostCohort(rows: readonly PackageRow[], platform?: HostPlatform): HostCohortSelection;
declare function evaluateHostLock(rows: readonly PackageRow[], context?: HostLockContext): HostLockEvaluation;
interface HostCapabilityRequest {
  action: SemanticAction;
  platform?: HostPlatform;
  profileKind?: HostProfileKind;
}
/** Evaluate only the packages needed for one effect/readback capability. */
declare function evaluateHostCapability(evaluation: HostLockEvaluation, request: HostCapabilityRequest): HostCapabilityEvaluation;
/**
* Bind external_wait qualification and pre-effect requalification to the
* exact jobs service definition, local provider, and live controller graph.
* This is deliberately independent of the global/base lock so profiles that
* do not support background jobs can still use unrelated Guard actions.
*/
declare function evaluateExternalWaitCapability(evaluation: HostLockEvaluation): HostCapabilityEvaluation;
type HostToolSurface = "bash" | "pwsh" | "filesystem";
/**
* Gate automatically replayed ordinary tool results by the exact host
* capability that owns their registration and outcome surface. Tool names are
* intentionally separate from semantic actions: a `bash` result on Windows,
* or a `pwsh` result on POSIX, is not evidence from the active host stack.
*/
declare function evaluateToolSurfaceCapability(evaluation: HostLockEvaluation, surface: HostToolSurface): HostCapabilityEvaluation;
/** Bind the injected Goal graph to the live Goal service for this agent. */
declare function bindLiveGoalCapability(evaluation: HostLockEvaluation, liveGoalAvailable: boolean): HostLockEvaluation;
type AuditedExecutable = "git" | "npm" | "pnpm" | "dsh";
interface ExecutableIdentity {
  executable: AuditedExecutable;
  realpath: string;
  version: string;
  interpreterRealpath?: string;
  interpreterVersion?: string;
}
interface ExecutableIdentityBinding {
  status: HostLockStatus;
  digest: string;
  identity?: ExecutableIdentity;
  reasonCode?: "executable_identity_missing" | "executable_realpath_invalid" | "executable_identity_drift";
}
/** Bind resolution and effect to the exact same canonical executable tuple. */
declare function bindExecutableIdentity(resolution: ExecutableIdentity | undefined, effect: ExecutableIdentity | undefined): ExecutableIdentityBinding;
declare const DEFAULT_HOST_LOCK: HostLockEvaluation;
//#endregion
//#region src/domain/derive.d.ts
declare const PROTOCOL_V3_NOTICE = "Context Guard protocol boundary: v3.0.0";
/**
* Pure, deterministic re-derivation of the guard projection from the DSH
* native event log. Context Guard never writes custom session events, so every
* piece of state is derived from `command/run`, `user/message`, `tool/call`,
* `tool/result`, `tool/code-dispatch-start`, `tool/code-dispatch`, and
* `compaction/summary`.
*/
declare function deriveProjection(sourceEvents: readonly DerivedEnvelope[], config: DeriveConfig, scope: DeriveScope, durableConfirmed: boolean, hostLock?: HostLockEvaluation): DeriveResult;
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
  semanticAction?: SemanticAction;
  evidenceRole?: EvidenceRole;
  resolvedTarget?: TargetTuple;
  observedState?: TargetTuple;
  expectedTransition?: ExpectedTransition;
  expectedTransitionDigest?: string;
  parseStatus?: EvidenceParseStatus;
  reasonCode?: string;
  adapterId?: string;
  adapterVersion?: string;
  externalOperationRef?: ExternalOperation;
}
declare function extractToolSubject(call: ToolCallInput, result: ToolResultInput, defaultCwd?: string, hostLock?: HostLockEvaluation): ToolSubject;
declare function evidenceFromPersistedToolResult(call: ToolCallInput, result: ToolResultInput, epoch: number, evidenceId: string, defaultCwd?: string, hostLock?: HostLockEvaluation): GuardEvidence;
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
type CanonicalCommandSurface = "bash" | "pwsh";
interface CanonicalArgv {
  status: ShellParseStatus;
  reason?: string;
  argv: string[];
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
/**
* Return canonical argv for the same literal, single-command grammar used by
* the production capture parser. This is intentionally stricter than the
* operation parser: environment prefixes and redirects are rejected because
* a stateful command manifest must bind the executable and every argument
* directly. Callers must still validate the executable-specific argv shape.
*/
declare function canonicalArgvFromCommand(command: string, surface: CanonicalCommandSurface): CanonicalArgv;
//#endregion
//#region src/domain/git-adapter.d.ts
type GitAdapterAction = "inspect_remote_updates" | "pull" | "fetch" | "commit" | "push";
declare const GIT_COMMAND_MANIFEST_IDS: {
  readonly inspect_remote_updates: "git.ls_remote_exact.v2";
  readonly pull: "git.pull_ff_only_explicit.v2";
  readonly fetch: "git.fetch_tracking_explicit.v2";
  readonly commit: "git.commit_index_tree.v2";
  readonly push: "git.push_explicit_refs.v2";
};
interface GitCommandManifest {
  manifestVersion: 2;
  manifestId: (typeof GIT_COMMAND_MANIFEST_IDS)[GitAdapterAction];
  action: GitAdapterAction;
  surface: CanonicalCommandSurface;
  argv: string[];
  remote?: string;
  sourceRef?: string;
  destinationRef?: string;
  trackingRef?: string;
}
interface GitCommandRejected {
  status: "rejected";
  reasonCode: "shell_command_unsupported" | "git_global_option_forbidden" | "git_alias_or_subcommand_forbidden" | "git_argv_shape_forbidden" | "git_remote_forbidden" | "git_ref_forbidden" | "git_tracking_ref_forbidden";
}
interface GitCommandAccepted {
  status: "accepted";
  manifest: GitCommandManifest;
}
type GitCommandParseResult = GitCommandAccepted | GitCommandRejected;
interface GitTargetIdentity {
  repository: string;
  remote?: string;
  /** Canonical v3 target key; explicit identities remain separate in the command manifest. */
  refspec?: string;
}
interface GitPrestateEnvelope {
  envelopeVersion: "git.prestate.v1";
  action: GitAdapterAction;
  commandManifestId: string;
  targetIdentityDigest: string;
  stateTupleDigest: string;
}
interface GitPrestateCheck {
  valid: boolean;
  reasonCode?: "command_manifest_drift" | "target_identity_drift" | "prestate_drift";
}
interface GitEffectRunner {
  (file: "git", argv: string[], repository: string): Promise<void>;
}
interface GitEffectExecution {
  status: "executed" | "rejected";
  reasonCode?: GitPrestateCheck["reasonCode"] | "repository_missing";
}
interface LinearCommitReadback {
  /** Commit reached after the guarded effect. */
  postHeadOid: string;
  /** The sole parent parsed from the post-commit object. */
  preHeadOid: string;
}
/**
* Parse only the audited Git argv shapes. The shell words come from the
* production shell parser; this module does not maintain an independent split
* or quoting implementation. Global `git -C`/`git -c`, aliases, force/delete,
* wildcard refspecs, and implicit HEAD/ref destinations fail closed because
* none occur in an accepted exact shape.
*/
declare function parseGitCommandManifest(command: string, surface: CanonicalCommandSurface): GitCommandParseResult;
/** Bind the command's explicit remote/ref identities to the canonical target. */
declare function gitCommandMatchesTarget(manifest: GitCommandManifest, target: GitTargetIdentity): boolean;
/**
* Normalize the read-only `git ls-files --stage -z` surface. Only stage-zero
* entries are certifiable; the digest binds mode, blob OID, and raw path bytes
* without asking Git to create an object (in particular, never `write-tree`).
*/
declare function commitIndexSnapshotDigest(indexEntries: Uint8Array): string | undefined;
/** Normalize the committed `git ls-tree -r -z <oid>` surface to the same tuple. */
declare function commitTreeSnapshotDigest(treeEntries: Uint8Array): string | undefined;
/**
* Parse the raw `git rev-list --parents -n 1 HEAD` surface and accept only a
* linear commit whose sole parent is the exact resolved pre-effect HEAD.
* Root commits, merge commits, a substituted first parent, malformed output,
* and a no-op/self-parent tuple all fail closed.
*/
declare function verifiedLinearCommitReadback(rawParents: Uint8Array, expectedPreHeadOid: string): LinearCommitReadback | undefined;
declare function createGitPrestateEnvelope(manifest: GitCommandManifest, target: GitTargetIdentity, stateTuple: Readonly<Record<string, string | Uint8Array>>): GitPrestateEnvelope;
/**
* Mandatory resolution-to-effect gate. Call immediately before invoking Git;
* any command, target, ref/OID, remote, branch, or raw index tuple drift makes
* the previously resolved operation unusable.
*/
declare function revalidateGitPrestate(resolved: GitPrestateEnvelope, manifest: GitCommandManifest, target: GitTargetIdentity, currentStateTuple: Readonly<Record<string, string | Uint8Array>>): GitPrestateCheck;
/** Execute the exact resolved argv only after the mandatory live recheck. */
declare function executeRevalidatedGitEffect(resolved: GitPrestateEnvelope, manifest: GitCommandManifest, target: GitTargetIdentity, currentStateTuple: Readonly<Record<string, string | Uint8Array>>, runner: GitEffectRunner): Promise<GitEffectExecution>;
//#endregion
//#region src/domain/host-resolver.d.ts
declare class HostProfileError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}
/**
* Read only the bounded package identities used by the host lock from a pnpm
* v9 lockfile. Multiple resolved versions are preserved as separate rows so
* callers cannot silently select a nearest instance.
*/
declare function packageRowsFromPnpmLock(text: string): PackageRow[];
declare function resolveInstalledHostLock(moduleUrl?: string): HostLockEvaluation;
/**
* Resolve only package identities reachable from the active pnpm importer.
* Historical snapshots elsewhere in the lockfile are deliberately ignored;
* two reachable peer variants of a critical package remain a duplicate and
* are returned twice so evaluateHostLock can fail closed with a bounded code.
*/
declare function packageRowsFromActiveGraph(packageMapText: string, lockText: string, nodeModulesRoot?: string): PackageRow[];
interface ActiveProfileHostLock {
  evaluation: HostLockEvaluation;
  runtimeRoot: string;
  profileRoot: string;
  pluginVersion: string;
  platform: HostPlatform;
  profileKind: HostProfileKind;
}
/** Read and validate the actual runtime graph plus the installed profile plugin. */
declare function resolveActiveProfileHostLock(runtimeRoot: string, profileRoot: string, expectedPluginVersion: string): ActiveProfileHostLock;
/** Atomically inject a repeatable managed patch into the selected profile only. */
declare function injectActiveProfileHostLock(input: ActiveProfileHostLock): string;
/** Extract the bounded host tuple from DSH's composed YAML dump. */
declare function hostLockRowsFromComposedDump(text: string): PackageRow[];
declare function hostLockContextFromComposedDump(text: string): {
  platform?: HostPlatform;
  profileKind?: HostProfileKind;
};
declare function verifyComposedHostLockDump(text: string, expected: HostLockEvaluation): HostLockEvaluation;
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
//#region src/domain/proof.d.ts
declare const PROOF_PROTOCOL_VERSION = "0.4.0";
declare const PROOF_KINDS: readonly ["subject_readback", "scope_coverage", "state_verification"];
type ProofKind = (typeof PROOF_KINDS)[number];
type ProofSurface = "artifact" | "ui" | "visual" | "scope";
interface ProofObligation {
  obligationId: string;
  kind: ProofKind;
  surface: ProofSurface;
  subjectIds: string[];
  evidenceIds: string[];
  expectedScopeDigest?: string;
  observedScopeDigest?: string;
}
interface ProofManifest {
  proofProtocolVersion: typeof PROOF_PROTOCOL_VERSION;
  obligations: ProofObligation[];
  proofSha256: string;
  assetSetSha256?: string;
}
interface SessionQuery {
  sessionRefDigest: string;
  epoch: number;
  contractRevision: number;
  state: "valid" | "unknown" | "corrupt";
  proof?: ProofManifest;
  cohortId?: string;
  /** Set only when a presented proof made the query unverifiable. */
  reasonCode?: "proof_invalid" | "proof_unbound";
}
/**
* The manifest digest root includes every integrity-bearing field, so a
* tampered asset-set digest is exactly as detectable as a tampered obligation.
*/
declare function proofDigest(obligations: readonly ProofObligation[], assetSetSha256?: string): string;
declare function validateProofManifest(manifest: unknown): string[];
declare function createProofManifest(obligations: readonly ProofObligation[], assetSetSha256?: string): ProofManifest;
/**
* Bind a structurally valid proof to the actual replayed projection: every
* obligation must name a pending item, every evidence id must exist in the
* projection, and every bound evidence must satisfy the obligation's kind,
* surface, subject, and outcome constraints. An empty projection therefore
* rejects any proof, and cross-item or foreign evidence can never bind.
*/
declare function bindProofToProjection(projection: GuardProjection, proof: ProofManifest): string[];
declare function canonicalProjection(projection: GuardProjection): Record<string, unknown>;
declare function sessionQuery(projection: GuardProjection, proof?: ProofManifest): SessionQuery;
declare function proofEvidenceConstraints(evidence: GuardEvidence, obligation: ProofObligation): boolean;
//#endregion
//#region src/domain/alpha3-host.d.ts
/** Exact 34-row alpha.3 runtime/web graph from the 2026-09-01 annex audit. */
declare const ALPHA3_HOST_PACKAGES: PackageRow[];
//#endregion
//#region src/domain/recovery.d.ts
interface RecoveryOptions {
  rejectedBindings?: Array<{
    itemId: string;
    reason: string;
    reasonCode?: string;
    offendingEvidenceIds?: string[];
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
//#region src/domain/rc1-host.d.ts
/** Exact 34-row rc.1 runtime/web graph from the 2026-09-03 native macOS audit. */
declare const RC1_HOST_PACKAGES: PackageRow[];
//#endregion
//#region src/domain/session-events.d.ts
/**
* Read a stable snapshot from both legacy DSH Sessions and the rc.1 Session
* API. rc.1 replaced the public `events` getter with `snapshotEvents()`; the
* structural adapter keeps older audited cohorts working without widening the
* accepted event contract.
*/
declare function snapshotSessionEvents(session: unknown): readonly unknown[];
//#endregion
//#region src/domain/stop-policy.d.ts
type CompletionDisposition = "complete" | "user_wait" | "external_wait" | "report";
declare function isWholeTaskCompletionClaim(text: string): boolean;
declare function classifyCompletionClaim(text: string): CompletionDisposition;
interface TurnStoppingDecision {
  action: "continue" | "stop";
  reason?: string;
}
interface AssistantOutcomeObservation {
  kind: "completion_claim" | "user_wait_claim" | "external_wait_claim" | "report";
  reasonCode: string;
}
/** Assistant prose is retained only as a bounded diagnostic observation. */
declare function observeAssistantOutcome(text: string): AssistantOutcomeObservation;
/**
* Stop Protocol 2.0 decision. This function deliberately has no assistant-text
* parameter: completion wording, quotation, negation and translation cannot
* steer the protocol. A structured root persistence authorization may request
* one fallback correction; subsequent attempts safe-yield. An active, armed
* Goal remains exclusively owned by the host Goal Round Driver.
*/
declare function decideTurnBoundary(projection: GuardProjection): TurnStoppingDecision;
declare function decideTurnStopping(projection: GuardProjection, _assistantText: string, _turn: number, _maxAttempts: number): TurnStoppingDecision;
declare function latestAssistantText(events: readonly {
  type: string;
  data: unknown;
}[]): string;
//#endregion
//#region src/domain/supersession.d.ts
declare function supersedeItem(items: Map<string, GuardItem>, oldId: string, replacement: GuardItem): boolean;
//#endregion
export { verifyComposedHostLockDump as $, DerivedEnvelope as $n, HostCapabilityRequest as $t, proofDigest as A, captureClause as An, CERTIFICATE_VERSION as Ar, ToolCallInput as At, CommandSurfaceManifest as B, BoundaryRequest as Bn, requestedTargetMatchesResolved as Br, ALPHA2_DSHMARKET_139_HOST_PACKAGES as Bt, ProofManifest as C, classifyUserInteraction as Cn, WaitAuthorization as Cr, ShellParseStatus as Ct, bindProofToProjection as D, CaptureScope as Dn, ACTION_MANIFEST_VERSION as Dr, parseShellCommand as Dt, SessionQuery as E, certifyCheckpoint as En, ACTION_MANIFEST as Er, parsePwshCommand as Et, bindingSatisfies as F, extractOperation as Fn, SemanticAction as Fr, extractToolSubject as Ft, HostProfileError as G, isCurrentAcceptedBoundary as Gn, canonicalizePath as Gr, EXPECTED_HOST_PACKAGES as Gt, OperationVerbEntry as H, GoalBoundaryAccess as Hn, semanticActionFromText as Hr, AuditedExecutable as Ht, evidenceCoverage as I, isInformationalMessage as In, StatefulAction as Ir, isDeterministicCheck as It, injectActiveProfileHostLock as J, BoundaryQualificationKind as Jn, sanitizeClauseText as Jr, GOAL_HOST_PACKAGES as Jt, hostLockContextFromComposedDump as K, qualifyBoundary as Kn, digestStrings as Kr, ExecutableIdentity as Kt, evidenceMatchesItem as L, segmentClauses as Ln, actionCompatible as Lr, withDurability as Lt, sessionQuery as M, classifyClause as Mn, STATEFUL_ACTIONS as Mr, ToolSubject as Mt, validateProofManifest as N, extractArtifactPaths as Nn, STOP_PROTOCOL_VERSION as Nr, evidenceFromPersistedToolResult as Nt, canonicalProjection as O, ClassifiedClause as On, ActionManifest as Or, goalCompletionDenial as Ot, EvidenceFacetCoverage as P, extractMethod as Pn, SUPPORTED_EVIDENCE_ADAPTERS as Pr, extractTextContent as Pt, resolveInstalledHostLock as Q, DeriveScope as Qn, HostCapabilityId as Qt, isVerifyingCapability as R, BoundaryEffectuation as Rn, isStatefulAction as Rr, PROTOCOL_V3_NOTICE as Rt, ProofKind as S, UserInteractionKind as Sn, VerificationContract as Sr, ParsedShell as St, ProofSurface as T, RejectedBinding as Tn, PackageRow as Tr, isRunExecutable as Tt, validateManifest as U, availableBoundaryQualifications as Un, validateActionManifest as Ur, BASE_HOST_PACKAGES as Ut, ManifestIssue as V, GoalActivationState as Vn, semanticActionFromCommand as Vr, ALPHA2_HOST_PACKAGES as Vt, ActiveProfileHostLock as W, effectuateBoundary as Wn, validateActionTarget as Wr, DEFAULT_HOST_LOCK as Wt, packageRowsFromPnpmLock as X, DeriveConfig as Xn, sha256 as Xr, HOST_COHORTS as Xt, packageRowsFromActiveGraph as Y, DeferAuthorization as Yn, sanitizeUrl as Yr, HOST_CAPABILITY_PACKAGE_GROUPS as Yt, resolveActiveProfileHostLock as Z, DeriveResult as Zn, HostCapabilityEvaluation as Zt, recoveryDigest as _, AuthorityBlock as _n, PersistenceAuthorization as _r, parseGitCommandManifest as _t, classifyCompletionClaim as a, HostLockStatus as an, ExternalOperation as ar, GitCommandRejected as at, PROOF_KINDS as b, authorityCaptureCounts as bn, TargetTuple as br, CanonicalArgv as bt, isWholeTaskCompletionClaim as c, HostToolSurface as cn, GuardCheckpoint as cr, GitPrestateCheck as ct, snapshotSessionEvents as d, evaluateExternalWaitCapability as dn, GuardItem as dr, LinearCommitReadback as dt, HostCohort as en, EvidenceBinding as er, GIT_COMMAND_MANIFEST_IDS as et, RC1_HOST_PACKAGES as f, evaluateHostCapability as fn, GuardItemKind as fr, commitIndexSnapshotDigest as ft, openItems as g, currentContractDigest as gn, HostStatus as gr, gitCommandMatchesTarget as gt, closingHint as h, selectHostCohort as hn, GuardProjection as hr, executeRevalidatedGitEffect as ht, TurnStoppingDecision as i, HostLockEvaluation as in, ExpectedTransition as ir, GitCommandParseResult as it, proofEvidenceConstraints as j, captureItem as jn, SEMANTIC_ACTIONS as jr, ToolResultInput as jt, createProofManifest as k, ClauseSegment as kn, ActionSpec as kr, hasCurrentCertificate as kt, latestAssistantText as l, bindExecutableIdentity as ln, GuardEvidence as lr, GitPrestateEnvelope as lt, RecoveryOptions as m, evaluateToolSurfaceCapability as mn, GuardOperation as mr, createGitPrestateEnvelope as mt, AssistantOutcomeObservation as n, HostCohortSelectionReason as nn, EvidenceParseStatus as nr, GitCommandAccepted as nt, decideTurnBoundary as o, HostPlatform as on, GoalRef as or, GitEffectExecution as ot, DEFAULT_RECOVERY_CHAR_BUDGET as p, evaluateHostLock as pn, GuardItemStatus as pr, commitTreeSnapshotDigest as pt, hostLockRowsFromComposedDump as q, BoundaryDisposition as qn, normalizeClause as qr, ExecutableIdentityBinding as qt, CompletionDisposition as r, HostLockContext as rn, EvidenceRole as rr, GitCommandManifest as rt, decideTurnStopping as s, HostProfileKind as sn, GuardBoundary as sr, GitEffectRunner as st, supersedeItem as t, HostCohortSelection as tn, EvidenceOutcome as tr, GitAdapterAction as tt, observeAssistantOutcome as u, bindLiveGoalCapability as un, GuardIntegrity as ur, GitTargetIdentity as ut, renderRecoveryPacket as v, AuthorityBlockKind as vn, TargetCaptureReasonCode as vr, revalidateGitPrestate as vt, ProofObligation as w, CheckpointResult as wn, createProjection as wr, canonicalArgvFromCommand as wt, PROOF_PROTOCOL_VERSION as x, segmentAuthorityBlocks as xn, TargetValue as xr, CanonicalCommandSurface as xt, ALPHA3_HOST_PACKAGES as y, AuthorityKind as yn, TargetCaptureStatus as yr, verifiedLinearCommitReadback as yt, COMMAND_SURFACE_MANIFEST as z, BoundaryQualification as zn, requestedTargetAuthorizesMutation as zr, deriveProjection as zt };