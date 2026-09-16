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
/**
* 0.6.0 v5-session identity (P0 §1): v2 certificates bind a work unit's
* closure instead of the whole session. Version-1 identity keeps its
* historical meaning for legacy sessions and is never silently re-read.
*/
declare const STOP_PROTOCOL_VERSION_V2 = "3.0.0";
declare const CERTIFICATE_VERSION_V2 = "2";
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
/** The single identity field a root instruction must name for this action. */
declare function requestedIdentityKey(action: SemanticAction): string | undefined;
/**
* The 0.6.0 bounded file-choice vocabulary (C07/S03): artifact-type nouns a
* root instruction may use instead of an exact path. The assistant may pick
* the exact file INSIDE the captured scope and inside the type, and the
* choice is frozen by the resolution producer before any effect. An absent
* extension set (`file`) admits any file the producer accepts.
*/
declare const BOUNDED_ARTIFACT_TYPES: Readonly<Record<string, ReadonlySet<string> | null>>;
/**
* Whether a bounded-choice requested target authorizes this resolved target:
* the resolved artifact must live inside the captured scope and match the
* captured type. The exact file name is the assistant's bounded decision,
* frozen by resolution — never a root-named identity substitution.
*/
declare function boundedArtifactChoiceMatches(action: SemanticAction, requested: TargetTuple | undefined, resolved: TargetTuple | undefined): boolean;
/**
* Compare identities captured from the root instruction with a complete
* adapter-resolved target. Requested targets are partial by design: only
* explicitly named identities (plus the active repository scope) are frozen.
* A bounded artifact choice (scope + type, C07) matches when the resolved
* exact file is inside the scope and of the captured type.
*/
declare function requestedTargetMatchesResolved(action: StatefulAction, requested: TargetTuple | undefined, resolved: TargetTuple | undefined): boolean;
/** A mutation requires every user-selectable identity field, not a partial match. */
declare function requestedTargetAuthorizesMutation(action: StatefulAction, requested: TargetTuple | undefined, resolved: TargetTuple | undefined): boolean;
declare function validateActionManifest(): string[];
//#endregion
//#region src/domain/semantics.d.ts
/**
* The single interpretation of a root-user instruction.
*
* Before 0.5.1, capture, mutation authorization and boundary qualification each
* re-guessed what one sentence meant, and the guesses disagreed: the incident
* instruction "按 P0—P4 完成本地实现、测试和文档，在跨平台验证前停止，不推送、
* 不正式发布。" was captured as a *push* obligation, so the only certifiable item
* demanded the very action its own text forbade.
*
* This module answers the question once. It partitions the message into
* semantic scopes first, then reads the action inside each scope, so:
*
* 1. a prohibition's scope covers every coordinated action it governs, and a
*    prohibition constrains execution instead of creating an obligation to
*    perform the forbidden action;
* 2. only an explicit, agent-owned, unconditional directive becomes an
*    immediately executable duty — naming an action is not authorizing it;
* 3. a conditional directive stays unexecuted until its condition holds, and a
*    human-owned action never becomes agent work;
* 4. quotation and code keep an action visible but never grant authority;
* 5. an interpretation that cannot be resolved reads conservatively and is not
*    executed.
*
* No rule here keys on a session id, an event sequence, a file name, or a fixed
* phrase list for one incident sentence: the rules are polarity, scope,
* executee and condition, so paraphrases, mixed languages, word-order changes
* and punctuation changes agree with the original.
*/
/**
* How one message is read.
*
* `coordinationSplit` is the one historical granularity switch: a message
* captured before the 0.4.2 capture boundary keeps a coordinated action in one
* clause, exactly as that release recorded it. Every semantic rule (polarity,
* executee, condition, quotation) applies identically in both modes, so replay
* stability never depends on re-reading an older message with newer semantics.
*/
interface InterpretOptions {
  coordinationSplit?: boolean;
}
/** What one scope does with the action it names. */
type DirectiveClass = "directive" | "prohibition" | "conditional" | "informational" | "narrative" | "unresolved";
/** Who is expected to perform the action. */
type Executee = "agent" | "user" | "unresolved";
/** How the scope's authority reads. */
type AuthorityDisposition = "executable_now" | "conditional_wait" | "human_actor" | "informational" | "prohibition" | "unresolved";
interface ScopeInterpretation {
  /** Verbatim scope text, trimmed: the audit record of what was read. */
  text: string;
  /** The action-bearing text with leading connectors and negators removed. */
  body: string;
  directive: DirectiveClass;
  executee: Executee;
  /** The unresolved condition that must hold before the action may run. */
  condition?: string;
  /** The event that ends a human wait, when the source names one. */
  resumeEvent?: string;
  /** True only for an explicit, agent-owned, unconditional instruction. */
  immediatelyExecutable: boolean;
  authorityDisposition: AuthorityDisposition;
  /** Explicitly named tool/method, when the scope names one. */
  method?: string;
  /** Stable identity of this interpretation, reproducible from the same bytes. */
  fingerprint: string;
}
/**
* The contract kind a scope maps to. A prohibition and an acceptance keep their
* own lanes; everything else is a requirement. Acceptance is decided from the
* clause's own head verb, so "确保构建通过" stays an acceptance while a
* conditional or prohibition clause is never mislabelled.
*/
declare function kindOfScope(directive: DirectiveClass, body?: string): GuardItemKind;
declare function maskCodeSpans(text: string): string;
/** Interpret one already-segmented clause. */
declare function interpretClause(text: string, options?: InterpretOptions): ScopeInterpretation;
/** Interpret a whole message into independent scopes, in source order. */
declare function interpretMessage(text: string, options?: InterpretOptions): ScopeInterpretation[];
/**
* Whether the item is an executable obligation right now. A prohibition is a
* standing constraint, a human-owned action belongs to the user, a conditional
* action waits for its condition, and an explanation is not work. None of them
* may block completion or be certified as agent work.
*
* An item without an interpretation is a legacy or fixture item created before
* this module existed; it keeps its historical executable reading.
*/
declare function isExecutableItem(item: {
  kind?: string;
  executee?: Executee;
  authorityDisposition?: AuthorityDisposition;
  waitAuthorization?: unknown;
}): boolean;
/** Whether an item is an open obligation for certification purposes. */
declare function isOpenObligation(item: GuardItem): boolean;
/**
* The action a scope names. `semanticActionFromText` maps the command surface,
* but a prohibition keeps a bare verb as its body ("不要提交并推送" → 提交并推送),
* and the closed CJK vocabulary is consulted first so such a ban is still
* recorded against the action it forbids.
*/
declare function semanticActionOfScope(body: string, source?: string, isProhibition?: boolean): ReturnType<typeof semanticActionFromText>;
/**
* Every stateful action the clause names, in source order. A clause may order
* more than one ("安装插件，重启 DSH"); each is a separate evidence obligation
* even though the clause stays one top-level item.
*/
declare function statefulActionsOfScope(body: string): StatefulAction[];
/** Actions this interpretation names, in source order (diagnostics only). */
declare function namedActions(text: string): string[];
//#endregion
//#region src/domain/capability-semantics.d.ts
/**
* 0.6.2 D062-01/D062-02: the shared, versioned semantics for WHAT the guard
* knows, WHY it cannot certify, and WHICH remedy is actually reachable.
*
* The verdict is deliberately one closed projection instead of a pile of
* ad-hoc strings, because every consumer (prepare, checkpoint detail, recovery
* packet, rebind query, status) must render the same answer. Two failure modes
* are excluded by construction:
*
* 1. The guard never turns its own missing adapter into a user-authority gap.
*    An unsupported capability says "complete the work honestly and do not
*    claim a certificate"; it never asks the user to restate the request as
*    install/modify, and it never asks for input the user already gave.
* 2. The guard never claims a fact it did not read. `declaredExitCode:
*    'unknown'` stays unknown however successful the host tool call looked,
*    and an opaque compound runner stays `operationAttribution: 'unknown'`
*    rather than inheriting the last command's exit status.
*
* The taxonomy is written once here and consumed by every lane, so a future
* capability must declare its own gap kind and remedy instead of drifting into
* a sentence list. Nothing in this module mutates contract, evidence, digest,
* certificate, or historical record state.
*/
/** Fine-grained, mutually exclusive reasons a contract item is not certified. */
type CapabilityGap = "none" | "closed" | "constraint" | "interpretation_unknown" | "missing_adapter" | "target_missing" | "input_ambiguous" | "legacy_migration_required" | "host_unavailable" | "historical_preevidence_missing" | "operation_unattributable" | "condition_pending" | "delivery_pending";
/** The reachable remedy for one gap. `remedy` is the machine-readable form of
* `next_action`; the two are produced together so they cannot disagree. */
type CapabilityRemedy = "none" | "collect_evidence" | "supply_target" | "await_root_input" | "deliver_answer" | "record_interpretation" | "report_uncertified" | "report_uncertified_capability_gap" | "restore_host" | "readback_only" | "fresh_root_instruction";
interface CapabilityFact {
  /**
  * Whether this obligation's OWN action belongs to the certification action
  * set in the installed cohort. It is deliberately independent of
  * authorization: `false` says the build has no such capability, NEVER that
  * the user did not authorize the work, and NEVER that the work may not be
  * done. A `generic_run` obligation has no concrete action to support.
  */
  actionSupported: boolean;
  /** A durable certification path exists for this item's own contract. */
  certifiable: boolean;
  gap: CapabilityGap;
  remedy: CapabilityRemedy;
  /** Reason codes that describe the evidence chain, never new authority. */
  blockingReasonCodes: string[];
}
/**
* Whether the item's obligation has a certification path in this cohort at
* all. A generic_run item names no concrete action: the manifest still has a
* generic entry (the guard may run and observe ordinary commands) but no
* user-level completion contract can be certified from it, so the item is
* uncertifiable while ordinary execution remains entirely permitted.
*/
declare function actionHasCertificationPath(action: SemanticAction, legacyMigration: boolean): boolean;
/** The capability classification of an item's own obligation contract. */
declare function capabilityFactOf(item: GuardItem): CapabilityFact;
/**
* What the console itself declared about the process. `declaredExitCode` is
* `'unknown'` unless a real marker or a structured host fact said otherwise:
* a host tool call that was not marked as an error is NOT a read exit code.
*/
type ProcessExitStatus = number | "unknown";
/**
* Why `outcome` says what it says, so a display or a consumer never reads more
* than the source supports.
*/
type ProcessOutcomeReason = "declared_exit_code" | "declared_negative_marker" | "host_error_flag" | "unmarked_renderer_success" | "marker_unclassified" | "backgrounded" | "text_scan_inconclusive";
/**
* How far the console let the guard attribute effects to the obligation's own
* operation. `unknown` is the honest answer for every opaque compound runner:
* the last command's success never covers an earlier failure.
*/
type OperationAttribution = "single_operation" | "declared_per_operation" | "unknown";
/** A credible per-operation subset the host itself declared. */
interface DeclaredOperationResult {
  action: string;
  outcome: "success" | "failure" | "unknown";
}
/** Which source declared the terminal facts this reading is based on. */
type ProcessFactSource = "run_declaration" | "structured_meta" | "rendered_markers";
interface DerivedProcessFacts {
  /** What the host tool call returned, before any interpretation. */
  hostToolReturned: "result" | "error";
  /** The console's own exit status, or `unknown` when never read. */
  declaredExitCode: ProcessExitStatus;
  /** Whether an explicit terminal marker (positive or negative) was read. */
  terminalMarkerRead: boolean;
  /** The outcome THIS LAYER derives from its own sources. It is deliberately a
  * separate value from the frozen evidence `outcome`: the frozen field keeps
  * the historical rule (0.6.1 and earlier read only `meta.exitCode` and the
  * rendered markers, never the run declaration), while this layer reads the
  * run declaration first. The two may therefore differ, and when they do the
  * difference is stated in `frozenOutcomeConflict` rather than hidden by
  * rewriting the historical field. */
  outcome: "success" | "failure" | "unknown";
  /** Why this layer's outcome is what it is. */
  outcomeReason: ProcessOutcomeReason;
  /** The highest-priority source that declared the facts used here. */
  source: ProcessFactSource;
  /** True when this layer's outcome differs from the frozen evidence
  * `outcome`. A consumer that needs the historical reading uses the frozen
  * field; a consumer that needs the run's own declaration uses this layer and
  * can see that the two disagree. */
  frozenOutcomeConflict: boolean;
  /** How far the guard could attribute effects to the operation. */
  operationAttribution: OperationAttribution;
  /** Exactly the sub-results a trusted producer declared, if any. */
  declaredOperationResults?: DeclaredOperationResult[];
}
/**
* `partial_failure` may be reported only from a credible structured
* per-operation result, and only for the exact declared subset. `unknown`
* stays unknown: the guard never reconstructs a per-operation verdict from
* stderr text, and never widens a declared subset into a claim about the rest.
*/
declare function partialFailureOf(facts: DerivedProcessFacts): {
  failed: DeclaredOperationResult[];
} | undefined;
/** The one-line consequence of a gap kind, shared so no lane re-invents it. */
declare function capabilityConsequence(gap: CapabilityGap): string;
/**
* D062-03: the applicable condition every removal-like outcome must carry.
* "Clean" or "no longer listed" never proves "no dependants", so a completed
* subset stays reported as the subset it is. These are the execution-side
* facts the guard can name but cannot observe; it states them instead of
* inventing a generic remover or promising an automatic block.
*/
declare const DEPENDENCY_FREE_ONLY_CONDITION: readonly string[];
/** The per-object dependency status a report must keep separate. */
type DependencyStatus = "dependency_free" | "in_use" | "unknown";
/** Whether one candidate object may enter the automatic removal set. */
declare function admissibleForRemoval(status: DependencyStatus): boolean;
interface RemovalOutcomeReport {
  metadataRemoved: "yes" | "no" | "unknown";
  contentRemoved: "yes" | "no" | "partial" | "unknown";
  directoryRemoved: "yes" | "no" | "unknown";
}
/** Only an object proven dependency-free AND fully removed may read as done. */
declare function removalIsComplete(report: RemovalOutcomeReport, status: DependencyStatus): boolean;
/** A partially removed object or an unknown dependant is never "no impact". */
declare function removalIsPartiallyKnown(report: RemovalOutcomeReport, status: DependencyStatus): boolean;
//#endregion
//#region src/domain/rebind.d.ts
interface RebindArgs {
  operation: "propose" | "query" | "withdraw";
  item_id?: string;
  proposal_id?: string;
  clauses?: string[];
  clarification_item_ids?: string[];
}
interface RebindProposal {
  id: string;
  digest: string;
  session: string;
  epoch: number;
  contractRevision: number;
  itemId: string;
  itemRevision: number;
  sourceMessageId: string;
  originalText: string;
  clauses: string[];
  clarificationItemIds: string[];
  candidates: Array<{
    sourceText: string;
    action: GuardItem["semanticAction"];
    requestedTarget: GuardItem["requestedTarget"];
    acceptance: GuardItem["verification"];
    sourceMessageId: string;
    rootItemId: string | null;
    rootRevision: number | null;
  }>;
  status: "pending" | "confirmed" | "withdrawn" | "stale";
  confirmationEvent?: string;
  replacementIds?: string[];
  /** Proposals created under the 0.5 protocol carry their replay schema. */
  protocol?: "v050";
  /** Matching control line observed during a non-durable replay (not applied). */
  observedUnconfirmedEvent?: string;
}
/** Bounded alignment facts for a mismatched partition, budget-aware. */
interface BoundedSource {
  length: number;
  sha256: string;
  text?: string;
  head?: string;
  tail?: string;
}
/** Typed propose outcomes; `undefined` never hides WHY a proposal failed. */
type ProposeOutcome = {
  ok: true;
  proposal: RebindProposal;
} | {
  ok: false;
  reasonCode: "item_not_found" | "item_not_pending" | "unsupported_clarification" | "partition_mismatch" | "payload_too_large" | "no_certification_gain";
  /** Bounded alignment facts for partition mismatches, within the 12 KiB budget. */
  source?: BoundedSource;
};
/** Exact source partition is deliberately conservative: a proposal cannot
* invent authority or silently discard a difficult acceptance clause. */
declare function proposeRebind(p: GuardProjection, args: RebindArgs): RebindProposal | undefined;
/** 0.5 proposer with typed failures and the no-certification-gain gate. */
declare function proposeRebindOutcome(p: GuardProjection, args: RebindArgs): ProposeOutcome;
/**
* Frozen v0.4.2/v0.4.3 proposer: identical semantics to the 0.4 releases,
* without the 0.5 no-gain gate or typed failures. Used ONLY to replay
* historical tool results and historical confirmations faithfully.
*/
declare function proposeRebindV042(p: GuardProjection, args: RebindArgs): RebindProposal | undefined;
/** Stable attempt key: item identity, exact inputs, and outcome class. Identical
* retries collapse onto it no matter how many unrelated log rows intervene. */
declare function rebindAttemptKey(p: GuardProjection, args: RebindArgs, reasonCode: string): string;
declare function rebindResponse(p: GuardProjection, args: RebindArgs): Record<string, unknown>;
/**
* Replay validation with version dispatch (A12): structured v0.5 results
* match semantically (display text may evolve); results carrying the frozen
* 0.4 response shapes validate against the frozen 0.4 rules exactly. Anything
* else is tampered or unknown and never replays.
*/
declare function replayRebindResult(p: GuardProjection, args: RebindArgs, recorded: Record<string, unknown>): void;
/** Invoked only for a canonical root user message, never tool or plugin text.
* The single durable confirmation event is the atomic transaction commit:
* the confirmation validates against the state BEFORE this message, and the
* caller processes the remaining text afterwards with its own semantics. */
declare function confirmRebind(p: GuardProjection, proposalId: string, eventId: string, durable: boolean): boolean;
//#endregion
//#region src/domain/release.d.ts
declare const RELEASE_OPERATIONS: readonly ["npm_publish", "git_tag", "github_release_create", "github_release_update", "github_release_delete", "composite_runner"];
type ReleaseOperation = (typeof RELEASE_OPERATIONS)[number];
/**
* The candidate identity a release contract freezes. Each field names exactly
* one measurable identity; all are optional except the full commit, because a
* contract that names nothing cannot be checked against anything.
*/
interface ReleaseCandidate {
  /** The commit the artifact was built from (the artifact's embedded gitHead). */
  fullSha40: string;
  /** The ref that commit must be on, when the surface can observe a ref. */
  ref?: string;
  /** Repository identity (owner/name or clone URL). */
  repository?: string;
  /** Package or artifact name. */
  packageId?: string;
  /** Exact released version. */
  version?: string;
  /** SHA-256 of the exact artifact bytes (64 lowercase hex). */
  artifactSha256?: string;
  /** npm integrity of the exact artifact bytes (`sha512-<base64>`). */
  artifactSri?: string;
  /** The registry the artifact is published to (canonical base URL). */
  registry?: string;
}
interface ReleaseContract {
  contractId: string;
  adoptedBy: {
    seq: number;
    digest: string;
  };
  /**
  * The contract revision the candidate scope was FROZEN at. The closure
  * certificate must be the one that certified exactly this revision: a later
  * obligation (including the release instruction itself) does not invalidate
  * the accepted candidate, while a certificate minted after the adoption — or
  * a candidate whose content moved on — is refused.
  */
  adoptedAtRevision: number;
  operations: ReleaseOperation[];
  candidate: ReleaseCandidate;
  readinessRefs: string[];
  closureCertRef?: string;
  /**
  * The closure certificate as it existed AT ADOPTION, frozen by identity.
  *
  * Comparing only the revision let a log entry ADD the certificate after the
  * adoption and still ratify it: the adoption would be validated by evidence
  * that did not exist when it was made. Freezing the certification digest (and
  * its epoch/revision) pins the exact certificate the adopter relied on, so a
  * certificate that appears later — even one that reuses the same id — is
  * refused. Absent means the adopter named a closure that did not exist yet,
  * which is equally refused: a later log entry can never supply it.
  */
  frozenClosure?: {
    id: string;
    certificationDigest: string;
    epoch: number;
    contractRevision: number;
  };
  expiresAtEpochMs?: number;
  /** Durable root revocation; the record is kept for audit, never deleted. */
  revokedAtSeq?: number;
}
interface ReleaseReservation {
  contractId: string;
  operation: ReleaseOperation;
  callId: string;
  startedAtSeq: number;
  status: "in_flight";
  /**
  * The npm SRI the trusted producer read when the reservation was written.
  * Recorded so a contract that froze only the byte SHA-256 can still be
  * reconciled by a registry readback: without it, a SHA-256-only contract
  * would be permanently unsettleable.
  */
  observedArtifactSri?: string;
}
type ReleaseOutcome = "settled" | "unconfirmed" | "unknown" | "failed" | "not_effected";
interface ReleaseSettlement {
  contractId: string;
  operation: ReleaseOperation;
  callId: string;
  settledAtSeq: number;
  /** A trusted readback identity, or the reason no producer exists. */
  readback: {
    kind: "npm_integrity" | "git_ref" | "github_release";
    identity: string;
  } | "unavailable";
  outcome: ReleaseOutcome;
}
/**
* The identity a trusted producer observed for the candidate. Every field is
* optional because a given surface can observe only some of them; a field the
* contract declares but the producer does not observe is a refusal, never a
* silent pass.
*/
interface ReleaseObservedIdentity {
  fullSha40?: string;
  /** The ref NAME the candidate is expected to be on. */
  ref?: string;
  /** The commit that ref resolves to, read by the audited git producer. */
  refSha?: string;
  repository?: string;
  packageId?: string;
  version?: string;
  artifactSha256?: string;
  artifactSri?: string;
  registry?: string;
}
interface ReleaseGateDecision {
  status: "granted" | "denied";
  reasonCode: string;
  contractId?: string;
}
//#endregion
//#region src/domain/host-selection.d.ts
/**
* Trusted host-native selection adapter (0.6.0 DS06-D, C07/S06).
*
* Only a PAIRED durable tool round-trip can form a trusted user selection:
* a `tool/call` whose arguments pose a question with explicit options, and
* its successful `tool/result` carrying the answer, bound by the same
* callId in the same session. Pasted answer text, a model restatement, or
* the answer of another call can never form a selection. Path selections
* and sandbox approvals are separate facts and are recorded separately.
*
* The question tool's name is a host tool-bundle surface: the adapter
* matches a bounded allowlist supplied by the caller (production wires the
* names audited for the running cohort; native acceptance pins them).
*/
interface TrustedSelection {
  callId: string;
  /** Sequence of the tool/result event that settled the selection. */
  resultSeq: number;
  turn: number | undefined;
  toolName: string;
  questionId: string | undefined;
  question: string | undefined;
  options: string[];
  /** The answer the user actually chose, verbatim from the paired result. */
  selected: string;
  /** A directory selection narrows where bounded file choices may land. */
  kind: "directory" | "value";
}
//#endregion
//#region src/domain/digest.d.ts
type TypedObject = {
  k: "b" | "i" | "s" | "e" | "x";
  v: unknown;
};
type Typed = boolean | number | string | TypedObject;
interface SessionHeader {
  /**
  * DSH Session format version stamped into the durable header. Guard supports
  * only the V3 session format (`3`); any other value is a different digest
  * domain input rather than being reinterpreted as V3.
  */
  version: number;
  id: string;
  createdAt: number;
  parentSession?: string;
  /**
  * Durable fork-inherited prefix length.
  *
  * DSH Session V3 moved this value out of the header onto the `Session`
  * itself as `inheritedEventCount` (durably marked by `session/end-seed`); the
  * meaning is unchanged, so the token keeps its historical name and the `v3`
  * digest domain keeps every byte-mirrored vector identical.
  *
  * V3's `header.isSeeded` marker is deliberately NOT added as a digest input.
  * It is not needed for identity — `parentSession`, `seedLength`,
  * `delegationDepth` and `origin` already bind the fork lineage, and `id` plus
  * `createdAt` separate distinct sessions — while adding any field (even an
  * optional one) would change every existing digest, because an absent
  * optional field still encodes a presence-0 row. Changing the shared digest
  * domain is an upstream semantic decision with its own cross-repository
  * parity gate; a host upgrade must not make it silently.
  */
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
/**
* `answered` (0.6.0, C03) marks an information-slot obligation closed by a
* trusted delivery fact: the host-confirmed final answer of a completed turn.
* It certifies only that delivery happened — never accuracy, sufficiency, or
* that any execution happened. Legacy sessions (no v5 boundary) never mint it.
*/
type GuardItemStatus = "pending" | "answered" | "passed" | "superseded";
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
/**
* 0.6.0 source span (C01): a UTF-8 byte half-open interval `[start, end)`
* inside the ORIGINAL root message text (before any normalization), bound to
* that message's content digest. Offsets are byte offsets computed with
* TextEncoder — never string indices — so Python and TypeScript agree on the
* same positions.
*/
interface SourceSpan {
  /** Index of the message part the span anchors to (0 = text). */
  partIndex: number;
  start: number;
  end: number;
  class: "instruction" | "adoption" | "question" | "constraint";
}
/** 0.6.0 per-message coverage summary (C01), bounded to the last 16 messages. */
interface MessageCoverage {
  seq: number;
  rawTextSha256: string;
  byteLength: number;
  /** Number of obligation spans the message contributed to items. */
  coveredSpans: number;
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
/**
* 0.6.1 (W060-01): the durable identity of one non-text root input part. The
* asset obligation binds the exact message sequence, part index and content
* digest of the ORIGINAL input — never a model description of it — so an
* interpretation can only ever be recorded against the asset it interpreted.
*/
interface AssetObligation {
  /** Sequence of the root message that carried the part. */
  messageSeq: number;
  /** Index of the non-text part inside that message. */
  partIndex: number;
  /** sha256 of the canonical JSON of the part: the media identity. */
  mediaSha256: string;
}
/**
* 0.6.1 (W060-01): one durable per-asset interpretation record, derived from a
* confirmed `context_guard_interpret` result that replay re-validated against
* the contract (call arguments, item, revision, asset identity). It is the
* model's explicit declaration that it read THAT obligation's asset in THAT
* host turn; it never proves the interpretation is correct, and it closes
* nothing by itself — an asset obligation closes only when a delivery of the
* interpretation's own turn exists. Absent from logs written before this
* entrypoint existed, which is what keeps upgrade replays from retroactively
* interpreting old assets.
*/
interface AssetInterpretationFact {
  itemId: string;
  resultSeq: number;
  /** The host turn the interpretation happened in. */
  turn: number;
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
  supersededByItems?: string[];
  reboundFrom?: {
    itemId: string;
    proposalId: string;
    confirmationEvent: string;
  };
  verification: VerificationContract;
  semanticAction?: SemanticAction;
  requestedTarget?: TargetTuple;
  targetCaptureStatus?: TargetCaptureStatus;
  targetCaptureReasonCode?: TargetCaptureReasonCode;
  authority?: "root_instruction" | "root_adoption" | "legacy_authority_unclassified";
  legacyFlags?: Array<"legacy_generic_run" | "legacy_authority_unclassified">;
  /** v0.5 intent layer: inquiries keep the obligation but are not machine certifiable. */
  taskKind?: "inquiry" | "action";
  /**
  * v0.5.1 interpretation layer, derived from the same source bytes as
  * {@link normalizedText} by `domain/semantics.ts`. These fields record what
  * the message actually authorized, so a prohibition, a human-owned action, a
  * conditional action and an explanation can never become an agent obligation.
  * Absent on legacy items, which keep their historical executable reading.
  */
  directive?: DirectiveClass;
  executee?: Executee;
  authorityDisposition?: AuthorityDisposition;
  /** The unresolved condition guarding a `conditional_wait` item. */
  condition?: string;
  /** The event that ends a human wait, when the source names one. */
  resumeEvent?: string;
  /** Stable identity of the interpretation these fields came from. */
  interpretationFingerprint?: string;
  /**
  * Every stateful action this item's clause names, in source order, with the
  * target captured for each. A clause may order more than one action
  * ("安装插件，重启 DSH"): the item stays one top-level obligation, and every
  * action it names needs its own matching evidence before it can close.
  */
  actionPlan?: Array<{
    action: "install" | "apply" | "create" | "modify" | "restart" | "commit" | "push" | "publish" | "pull" | "fetch";
    requestedTarget: TargetTuple;
    targetCaptureStatus: TargetCaptureStatus;
    targetCaptureReasonCode?: TargetCaptureReasonCode;
  }>;
  waitAuthorization?: WaitAuthorization;
  deferAuthorization?: DeferAuthorization;
  persistenceAuthorization?: PersistenceAuthorization;
  /**
  * 0.6.0 C01 provenance: the content digest of the original root message
  * text and the UTF-8 byte spans inside it that this item's clause came
  * from. Absent on legacy items, which keep their historical reading.
  */
  rawTextSha256?: string;
  spans?: SourceSpan[];
  /**
  * 0.6.0 work-unit assignment (C04), present only for obligations captured
  * after a v5 protocol boundary in a non-delegated session. Legacy items keep
  * the whole-session contract and carry no unit.
  */
  unitId?: string;
  /**
  * The trusted delivery fact that closed an information-slot item: the host's
  * completed turn and its final assistant message. Derived from durable
  * events, never from assistant prose alone.
  */
  answeredBy?: {
    turn: number;
    responseSeq: number;
    responseSha256: string;
  };
  /**
  * 0.6.0 C08: the pending obligation this item atomically superseded through
  * a verbatim general clarification. Audit trail only — the superseded item
  * keeps its own history.
  */
  clarifiesItemId?: string;
  /**
  * 0.6.1 (W060-01 review round 10): set on the sub-items created when an
  * unresolved clause is superseded by its recorded interpretation
  * partition. Names the superseded unresolved obligation; the information
  * sub-items close through the interpreting turn's delivery, while unknown
  * and undeclared sub-spans stay pending.
  */
  interpretedFromUnresolved?: string;
  /**
  * 0.6.1 (W060-01): present only on an asset-interpretation obligation. The
  * item's information slot closes through the SAME trusted-delivery fact as
  * any inquiry of its turn; the closing answers the request that carried the
  * asset, never the correctness of the interpretation, and visual-comparison
  * proof (strict surface 'visual') stays a separate obligation. Absent on
  * every other item, so legacy and ordinary text items are unchanged.
  */
  asset?: AssetObligation;
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
  /**
  * 0.6.2 D062-02: the LAYERED reading of a shell result, kept beside — never
  * instead of — the frozen `outcome`/`parseStatus` pair. It separates four
  * different claims the historical single `outcome` conflated: what the host
  * tool call returned, what the console actually declared about the process
  * (an exit code and its signal, or `unknown` when none was read), how far the
  * effect could be attributed to this obligation's own operation, and the
  * resulting business outcome. It is derived at replay from the same bytes, is
  * excluded from every historical digest and certificate domain, and never
  * rewrites an old `outcome`. Only shell-tool facts carry it.
  */
  processFacts?: DerivedProcessFacts;
  /**
  * 0.6.0 C04: this fact came from a delegated subagent/task round-trip. A
  * delegated result is BOUNDED evidence for the parent unit — it is recorded
  * and visible, and it can never close a parent obligation or a parent unit
  * by itself. Set only by the derivation, never by a caller.
  */
  delegatedSubtask?: true;
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
  /**
  * Per-action closure for a clause that ordered several actions. Every entry
  * of {@link GuardItem.actionPlan} needs its own entry here: one action's
  * evidence never covers another action, and two instances of the same action
  * on different targets are two separate entries.
  */
  actionBindings?: BindingActionClosure[];
}
interface BindingActionClosure {
  action: StatefulAction;
  evidenceIds: string[];
  resolvedTarget: TargetTuple;
  /** Position of this action in the clause's instruction order. */
  order: number;
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
  /**
  * 0.6.0 v2 certificate (v5 sessions only): the unit whose closure was
  * certified. Version-1 certificates keep the whole-session contract and
  * never carry a unit.
  */
  unitId?: string;
  /** v2 certificates: the digest of the certified unit's open closure. */
  unitClosureDigest?: string;
}
/**
* One 0.6.0 work unit (C04): the obligations captured from one root task and
* their closure state. Units are derived from the durable message stream, so
* they replay deterministically; no unit state is ever written to the log.
*/
interface WorkUnit {
  unitId: string;
  /** Sequence of the root message that opened the unit. */
  openedAtSeq: number;
  /** Root messages folded into this unit, in source order. */
  rootInputRefs: Array<{
    seq: number;
  }>;
  /** The normalized text of the unit's opening instruction (bounded audit). */
  headline: string;
  /** Sequence at which a newer unit became current, when superseded as current. */
  switchedAwayAtSeq?: number;
  /**
  * The unit this one descends from. A delegation-marked root message opens a
  * CHILD unit of the current unit (C04): the child's open obligations are part
  * of the parent's required closure, so the parent can never be certified
  * while a delegated sub-unit still has open work. An ordinary task switch
  * opens a sibling instead, which is why its residual work never blocks the
  * newer unit's certificate.
  */
  parentUnitId?: string;
  /**
  * Delegated round-trips that entered this unit as bounded evidence (C04).
  * Recorded for audit only: a subagent's completion is never a parent
  * completion.
  */
  delegationRefs?: DelegationRef[];
}
/** One durable delegated round-trip observed inside a session. */
interface DelegationRef {
  /** The tool call that requested the delegation. */
  callId: string;
  /** Sequence of the paired result event. */
  resultSeq: number;
  /** Audited delegation tool that produced the result. */
  toolName: string;
  /** Whether the delegated round-trip reported success. */
  status: "completed" | "failed" | "unknown";
}
type BoundaryDisposition = "user_wait" | "external_wait" | "deferred" | "guard_bounded_stop";
type BoundaryQualificationKind = "user_decision_item" | "root_explicit_wait" | "external_operation_pending" | "root_explicit_defer" | "guard_no_progress";
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
  rebindProposals: Map<string, RebindProposal>;
  items: Map<string, GuardItem>;
  evidence: Map<string, GuardEvidence>;
  checkpoints: GuardCheckpoint[];
  boundaries: GuardBoundary[];
  externalOperations: Map<string, ExternalOperation>;
  /**
  * 0.6.0 work units keyed by unit id, and the id of the unit currently
  * receiving captured work. Derived; present only after a v5 boundary.
  */
  units: Map<string, WorkUnit>;
  currentUnitId?: string;
  /**
  * The session's rule mode: `5` once a v5 protocol boundary exists in the log,
  * `undefined` (legacy) before it. Determines certificate version, closure
  * scope, and whether delivery/unit semantics are active.
  */
  boundaryProtocol?: 5;
  /** 0.6.0 responsibility tier (C06), from the effective configuration. */
  policy: "standard" | "strict" | "release";
  /** 0.6.0 C01 coverage summaries, one per captured root message (last 16). */
  coverage: MessageCoverage[];
  /**
  * 0.6.0 C10 explicit release records, derived from the durable plugin-notice
  * channel. A release is never implicit: without an adopted contract the
  * release gate denies every operation. A malformed record is reported through
  * {@link releaseDiagnostics} and never makes the whole projection corrupt, so
  * damaged release state cannot block unrelated ordinary work.
  */
  releaseContracts: ReleaseContract[];
  releaseReservations: ReleaseReservation[];
  releaseSettlements: ReleaseSettlement[];
  /** Bounded audit of rejected release records (never raw payloads). */
  releaseDiagnostics: Array<{
    seq: number;
    reasonCode: string;
  }>;
  /**
  * True when a release record could not be read back. Damaged release state
  * blocks RELEASE operations with `release_state_damaged` while leaving the
  * projection's own integrity and all ordinary work untouched: the plugin
  * reports what it cannot read instead of quietly forgetting it.
  */
  releaseStateDamaged: boolean;
  /**
  * 0.6.0 C07 trusted host selections, derived only from paired durable
  * question-tool round-trips (last 16). A directory selection narrows where
  * a bounded file choice may land for obligations of the same unit.
  */
  trustedSelections: TrustedSelection[];
  /**
  * 0.6.1 (W060-01): the derived per-asset interpretation records (bounded to
  * the last 64), one per confirmed `context_guard_interpret` result. Derived,
  * never written by a caller.
  */
  interpretationFacts: AssetInterpretationFact[];
  /**
  * 0.6.0 C07 sandbox approvals, derived from the host's own
  * `approval/asked` + `approval/decided` audit pair (last 16). Recorded for
  * provenance only: an approval is never a target authority.
  */
  approvals: Array<{
    id: string;
    seq: number;
    toolName?: string;
    outcome: "allowed-once" | "rejected" | "cancelled" | "unavailable";
  }>;
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
  lastCheckpointRejections?: Array<{
    itemId: string;
    reason: string;
    reasonCode?: string;
    offendingEvidenceIds?: string[];
  }>;
  lastCheckpointRejectionRevision?: number;
  /** Bounded fact about the latest rejected confirmation attempt (never raw text). */
  lastConfirmationRejection?: {
    eventSeq: number;
    kind: "malformed" | "ambiguous";
    reason: string;
  };
  continuationAttempts: Map<number, number>;
  /** Process-local one-shot fallback counters keyed by epoch + contract revision. */
  persistenceCorrectionAttempts: Map<string, number>;
  /**
  * The no-progress budget, rebuilt from the durable log.
  *
  * Keyed by progress fingerprint, then by the boundary the claim was decided
  * at, holding the attempt number that boundary was given. Keyed by boundary
  * rather than counted per fingerprint on purpose: the same boundary processed
  * twice — a retry, with or without the projection being re-derived in between
  * — maps to the same key and therefore the same attempt, so a retry cannot
  * spend the budget twice, while a genuinely new boundary adds a new key.
  */
  noProgressClaims: Map<string, Map<string, number>>;
  /**
  * Root event sequences whose control request Guard already carried to the
  * host. A pause is a one-shot input: once the host has paused, the same
  * message stays in the log forever, and re-reading it must not re-pause a goal
  * the human has since resumed.
  */
  handledControlSeqs: Set<number>;
  /**
  * The host turn the projection is currently in, taken from the host's own
  * durable `turn/start` event. This is the turn boundary's identity: the host
  * opens it before it claims input or runs pre-step, so it is stable across a
  * reload, it does not move when Guard writes its own bookkeeping, and a retry
  * of the same turn re-reads the same number.
  */
  hostTurn?: number;
  /**
  * Runtime-owned durability watermark (0.6.0 fresh-projection contract): the
  * result of the most recent flush performed by a public read/control entry.
  * `confirmed` means the last entry observed a durable log, `failed` means a
  * flush was refused or threw, and `unknown` means no flush has been observed
  * yet. A `failed` watermark must make read entries report unavailability —
  * never a stale-cache projection and never an empty ledger. Preserved
  * across rebuilds like the other runtime-owned liveness state.
  */
  durabilityWatermark: "confirmed" | "failed" | "unknown";
  /** Log-derived count of rejected rebind attempts by stable attempt key; survives reload. */
  rebindRejections: Map<string, number>;
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
  /** 0.6.0 responsibility tier (C06); standard by default. */
  policy?: "standard" | "strict" | "release";
}
interface DeriveResult {
  projection: GuardProjection;
  /** True when the log contains a compaction summary the agent must recover from. */
  compacted: boolean;
  /** True when an off→on enablement transition was derived in this log. */
  enablementTransitioned: boolean;
  /** Sequence of the last compaction summary in the log, or -1 when none. */
  lastCompactionSeq: number;
  /** True when a real root user input (text or asset) is present while enabled. */
  realRootInputSeen: boolean;
  /** True when the durable log carries the 0.5 first-step protocol boundary. */
  protocolV4Present: boolean;
  /** True when the durable log carries the 0.6 first-step protocol boundary. */
  boundaryV5: boolean;
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
/**
* Whether a clause opens with an explicit ban. The lane question ("is this a
* constraint or a duty?") is answered by {@link ScopeInterpretation}; this stays
* exported because the framing/segmentation callers ask it directly.
*/
declare function classifyClause(text: string): GuardItemKind;
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
* boundaries and negations delimit segments so a compound instruction such as
* "Modify src/a.ts and src/b.ts. Do not push." yields separate items instead of
* collapsing into one artifact.
*
* Segmentation asks {@link interpretMessage} where the semantic scopes are, so a
* negation keeps its whole coordinated span ("不推送、不发布" is two
* prohibitions, not one requirement) and a mixed sentence keeps both executees.
*/
interface ClauseSegment {
  kind: GuardItemKind;
  /** Action-bearing text used for target, method and operation extraction. */
  body: string;
  /** Verbatim source scope, kept for the audit record. */
  text: string;
  paths: string[];
  /** The one interpretation this segment came from; never re-derived downstream. */
  interpretation: ScopeInterpretation;
}
declare function segmentClauses(text: string, options?: InterpretOptions): ClauseSegment[];
/**
* Build a GuardItem from an already-classified clause body and a resolved
* verification subject/surface.
*
* The optional `interpretation` carries the scope reading taken from the same
* bytes. It is passed through rather than re-derived, so the obligation lane and
* the authority of one clause cannot disagree between callers.
*/
declare function captureItem(kind: GuardItemKind, body: string, sourceMessageId: string, id: string, revision: number, subject: string, surface: "artifact" | "scope", method?: string, operation?: GuardOperation, interpretation?: ScopeInterpretation): GuardItem;
/**
* Capture one contract clause. Every captured item receives a concrete
* verification contract: a named artifact path (artifact surface) or the
* session scope (scope surface), so an unrelated file read can never close it.
*/
declare function captureClause(text: string, sourceMessageId: string, id: string, revision: number, scope?: CaptureScope, options?: InterpretOptions): GuardItem;
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
//#region src/domain/confirm-parse.d.ts
/**
* 0.5 confirmation-line grammar (A10/A11).
*
* A durable root message may carry AT MOST ONE rebind confirmation as a
* restricted top-level control line; everything after it is follow-up content
* processed with its own semantics. The parser is intentionally conservative:
* - only the first non-empty top-level line can be a control line;
* - lines inside code fences, quoted lines, and blockquote/forward wrappers
*   are data, never control;
* - an embedded or mid-sentence control string is `malformed`, never a
*   confirmation;
* - a matching control line that is NOT in first position, or an explicit
*   reversal in the remainder, makes the whole message `ambiguous` (stays
*   unconfirmed; no partial effect).
*/
type ParsedConfirmation = {
  kind: "none";
} | {
  kind: "malformed";
  reason: "embedded_control_text" | "inside_code_fence" | "quoted";
} | {
  kind: "ambiguous";
  reason: "multiple_control_lines" | "late_control_line" | "reversal_in_remainder";
} | {
  kind: "confirm";
  proposalId: string;
  remainder: string;
};
declare const CONFIRM_LINE_PATTERN: RegExp;
/** Parse control without rewriting the follow-up's authority wrappers. */
declare function parseConfirmationMessage(text: string): ParsedConfirmation;
/** Whether a recorded tool/result carries the frozen v0.4.x response shape. */
declare function isFrozenV042RebindResponse(recorded: unknown): boolean;
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
type TaskIntent = "inquiry" | "action";
/**
* Separate intent layer (v0.5): whether the captured work is an inquiry about
* state or an ordered change. Intent NEVER drops capture or weakens
* protection — an inquiry keeps its original obligation; it only changes what
* certification support the diagnosis reports (inquiries are not machine
* certifiable by the current adapters and must not be re-bound).
*/
declare function classifyTaskIntent(text: string): TaskIntent;
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
//#region src/domain/host-version.d.ts
/**
* DSH host version support policy.
*
* Context Guard 0.5.2 supports exactly the two registered DSH host releases:
* `0.1.5-rc.2` (latest) and `0.1.5-rc.1` (verified minimum). Package discovery,
* npm installation, and the exported support range use the same newest-first
* exact union, so an unregistered stable or future prerelease is never advertised
* merely because it sorts above the minimum.
*
* The minimum comparison remains a diagnostic layer for distinguishing an old
* host from an at-or-above-floor but unregistered host. It never substitutes for
* the exact support set or the complete 33-package host graph.
*/
/** Lowest supported DSH host version. DSH packages version independently of Cordis. */
declare const MIN_SUPPORTED_HOST_VERSION = "0.1.5-rc.1";
/** Latest DSH release with a registered complete host graph. */
declare const LATEST_SUPPORTED_HOST_VERSION = "0.1.5-rc.2";
/** Exact endpoints supported by the current release, newest first. */
declare const SUPPORTED_HOST_VERSIONS: readonly string[];
/** Exact npm range shared by package discovery and peer dependency declarations. */
declare const SUPPORTED_HOST_RANGE: string;
interface ParsedHostVersion {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers; empty for a release version. */
  prerelease: readonly string[];
}
declare function parseHostVersion(value: string): ParsedHostVersion | undefined;
/**
* SemVer precedence comparison, including the prerelease rules. Returns
* `undefined` for a value that is not a version this module can order, so an
* unparseable host version fails closed rather than sorting as "newer".
*/
declare function compareHostVersions(a: string, b: string): number | undefined;
type HostVersionStatus = "supported" | "below_minimum" | "unparseable";
interface HostVersionDecision {
  status: HostVersionStatus;
  version: string;
  minimum: string;
  reasonCode: "host_version_supported" | "host_version_below_minimum" | "host_version_unparseable";
}
/** Decide the version-policy half of host support. Never a substitute for the graph lock. */
declare function evaluateMinimumHostVersion(version: string, minimum?: string): HostVersionDecision;
/** Whether npm's exact public support union admits this host version. */
declare function satisfiesSupportedHostRange(version: string): boolean;
//#endregion
//#region src/domain/host-lock.d.ts
type HostLockStatus = "supported" | "unsupported" | "unavailable";
type HostPlatform = "posix" | "windows";
type HostProfileKind = "headless" | "web";
/**
* How a cohort's package rows were established. Bound into every host-lock
* digest through the `host_audit_provenance` capability row, so a certificate
* records whether the exact graph it used was loaded on a native host or only
* resolved from the registry.
*/
type HostAuditProvenance = "native-audited" | "registry-derived-pending-native-audit";
interface HostCohort {
  /** Stable cohort identity; bound into every hostLockDigest via `host_cohort`. */
  id: string;
  manifestVersion: number;
  supportedGoalVersions: string[];
  /**
  * Platforms where this cohort's exact package graph was extracted from a
  * native host and audited. A cohort with no native audit has an empty list
  * here even while it accepts evaluations — see {@link acceptedPlatforms}.
  */
  auditedPlatforms: readonly HostPlatform[];
  /**
  * Platforms on which the cohort may evaluate to `supported`. This is the
  * gating list; a platform outside it fails closed with
  * `host_cohort_platform_not_audited`. `auditedPlatforms` remains the stricter
  * fact and `auditProvenance` states which one a certificate actually rests
  * on, so a registry-derived graph is never silently reported as a native pass.
  */
  acceptedPlatforms: readonly HostPlatform[];
  auditProvenance: HostAuditProvenance;
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
* Historical audited host cohort registry. Every entry keeps the exact package
* identities audited natively for a past Guard release (CG-DSH-001 whole-graph
* contracts). These are historical verification facts only: since 0.5.1 the
* active support targets are `0.1.5-rc.1` and `0.1.5-rc.2`, so an installed graph from any of
* these cohorts — including previous RCs and alphas — is no longer an active
* support entry and fails closed in `evaluateHostLock`.
*/
declare const LEGACY_HOST_COHORTS: readonly HostCohort[];
/** Baseline cohort retained for callers that need a default fixture. */
declare const ACTIVE_HOST_COHORT_ID = "dsh-0.1.5-rc.1";
declare const ACTIVE_HOST_COHORT_IDS: readonly string[];
/** Core-lock/v1 separates optional market identity from the audited DSH graph.
* The active support targets are the exact registered rc.1 and rc.2 graphs:
* historical cohorts stay in `LEGACY_HOST_COHORTS` as verification data but are
* never silently re-labelled as accepted active locks, and an installed
* historical graph fails closed under `evaluateHostLock`. The version policy
* (the exact rc.2-or-rc.1 public set) and the graph lock are separate
* judgments: a host that has not been registered here is "unverified / pending
* audit", never supported by version order alone.
*/
declare const HOST_COHORTS: readonly HostCohort[];
/**
* Baseline fixture package identities (DSH 0.1.5-rc.1). The cohort
* is an atomic whole-graph contract (CG-DSH-001): any drifted, duplicated,
* unknown-version, unbound, OR MISSING row fails the whole lock closed
* (`host_lock_missing`); no capability inherits independence from a partially
* present graph.
*/
declare const EXPECTED_HOST_PACKAGES: PackageRow[];
/**
* The `@deepseek-ai/dsh` launcher version of the baseline fixture, read from the
* cohort rows rather than hardcoded, so a cohort bump cannot leave a stale
* literal behind in the target-inspection path.
*/
declare const ACTIVE_HOST_LAUNCHER_VERSION: string | undefined;
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
  reasonCode?: "host_lock_migration_required" | "host_lock_installed_graph_drift" | "host_lock_missing" | "host_lock_version_mismatch" | "host_lock_version_below_minimum" | "host_lock_version_unparseable" | "host_lock_integrity_mismatch" | "host_lock_unknown_package" | "host_lock_duplicate_package" | "host_lock_goal_graph_incomplete" | "host_lock_goal_capability_mismatch" | "host_lock_cohort_mixed_graph" | "host_lock_cohort_unbound_identity" | "host_lock_cohort_platform_not_audited";
  packages: PackageRow[];
  capabilities: Record<HostCapabilityId, HostCapabilityEvaluation>;
  platform?: HostPlatform;
  profileKind?: HostProfileKind;
  liveGoalAvailable?: boolean;
  /**
  * The version-policy half of host support, decided separately from the graph.
  * A host below the minimum is refused here even when its graph matches an
  * audited cohort, and an in-range version never substitutes for the
  * exact-graph audit: the two are independent facts, both reported.
  */
  hostVersion?: HostVersionDecision;
  /** Readback of the audited cohort the supplied graph was evaluated against. */
  cohortId?: string;
  /**
  * Readback of how that cohort's rows were established. `registry-derived-
  * pending-native-audit` means the exact published graph was verified but no
  * native host load has happened yet; a certificate must never present that as
  * a native pass.
  */
  auditProvenance?: HostAuditProvenance;
  /** Audited cohort rows absent from the supplied graph (diagnostic). */
  missingPackages?: string[];
}
interface HostLockContext {
  platform?: HostPlatform;
  profileKind?: HostProfileKind;
  capabilityId?: string;
  /**
  * The DSH host version the graph was read from, when the caller read one.
  * Supplying it turns the version policy into a production decision; omitting
  * it leaves the version question unanswered rather than assumed supported.
  */
  hostVersion?: string;
}
/**
* The host version a package graph records, for the version-policy decision.
*
* Every DSH package versions with the host, so the graph's own `dsh` row is the
* version the caller is running. A graph without that row leaves the version
* unknown, and an unknown version is not treated as supported.
*/
declare function hostVersionFromPackages(rows: readonly PackageRow[]): string | undefined;
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
/**
* Audited delegation tool names (C04/DS06-B). A tool result from one of these
* is a subagent's answer: bounded evidence for the unit that asked for it, and
* never a parent completion. The real names are a host tool-bundle surface —
* native acceptance pins the audited cohort, exactly like the question-tool
* allowlist — so this list is the production default and can be overridden by
* an audited cohort.
*/
declare const DEFAULT_DELEGATION_TOOL_NAMES: readonly string[];
declare const CAPTURE_V042_NOTICE = "Context Guard capture boundary: v0.4.2";
declare const PROTOCOL_V3_NOTICE = "Context Guard protocol boundary: v3.0.0";
/**
* 0.5.0 first-step boundary: written at the first real root input step (never
* at session start), before the constrained root message in the same batch.
* It implies the v3 protocol and v0.4.2 capture semantics and marks the cut
* where the 0.5 confirmation syntax becomes active; earlier notices keep
* their historical meaning for replay.
*/
declare const PROTOCOL_V4_NOTICE = "Context Guard protocol boundary: v4.0.0";
/**
* 0.6.0 first-step boundary: same placement discipline as v4. It cuts the
* work-unit, delivery, and certificate-v2 semantics (P0 §1): messages before
* it keep their historical rules, messages after it are captured into work
* units and close through unit-closure certificates and trusted deliveries.
* An old binary ignores this notice (plugin source, unmatched pattern), so the
* fail direction on rollback is closed, never a misread.
*/
declare const PROTOCOL_V5_NOTICE = "Context Guard protocol boundary: v5.0.0";
/**
* Pure, deterministic re-derivation of the guard projection from the DSH
* native event log. Context Guard never writes custom session events, so every
* piece of state is derived from `command/run`, `user/message`, `tool/call`,
* `tool/result`, `tool/ptc-dispatch-start`, `tool/ptc-dispatch`, and
* `compaction/summary`.
*/
declare function deriveProjection(sourceEvents: readonly DerivedEnvelope[], config: DeriveConfig, scope: DeriveScope, durableConfirmed: boolean, hostLock?: HostLockEvaluation): DeriveResult;
//#endregion
//#region src/domain/reason-class.d.ts
/**
* The seven unified reason-class labels (0.6.0 C12).
*
* Every fine-grained `reason_code` maps onto exactly one class, so a caller can
* branch on the class while the existing codes keep their exact meaning and
* their existing tests. The mapping table below is the frozen table; the
* fallback for an unmapped code is `source_insufficient`, never a new class —
* an unknown code must not silently become a different kind of failure.
*/
type ReasonClass = "parameter_missing" | "source_insufficient" | "condition_unmet" | "producer_capability_unavailable" | "historical_gap" | "integrity_failure" | "policy_boundary";
//#endregion
//#region src/domain/diagnostics.d.ts
type TaskKind = "inquiry" | "action" | "deliverable" | "constraint" | "unresolved";
type CertificationSupport = "supported" | "unsupported" | "needs_target" | "needs_evidence" | "unavailable";
/**
* Whether anything can still be repaired, and by whom (0.5, corrected by 0.6.2
* D062-01). `user_input_required` means a real root choice was never made
* (a genuinely absent identity or target selection) — never a capability this
* build simply does not have, and never a request to re-word an instruction.
*/
type Repairability = "agent_repairable" | "user_input_required" | "unsupported" | "historical_gap" | "none";
interface DiagnosisNextAction {
  kind: "report_only" | "collect_evidence" | "checkpoint" | "clarify_target" | "restore_host" | "none";
  tool?: string;
  required_input?: string;
  resume_condition?: string;
}
/** The single unified diagnosis shared by checkpoint, recovery, rebind,
* evidence/action, and status surfaces (v0.5). It states what certification
* can do, never invents targets, evidence IDs, or authority. */
interface UnifiedItemDiagnosis {
  item_id: string;
  item_revision: number;
  contract_revision: number;
  task_kind: TaskKind;
  certification: CertificationSupport;
  reason_code: string;
  /** The seven-class label this fine-grained reason code belongs to (C12). */
  reason_class: ReasonClass;
  repairability: Repairability;
  /**
  * 0.6.2 D062-01: WHAT the guard knows and WHICH remedy is reachable, shared
  * by every consumer. `reason_code` stays the fine display code; the
  * capability fact explains the remedy, so no lane infers a root cause — or
  * invents a reachable path — from one enum.
  */
  capability: CapabilityFact;
  missing_fields: string[];
  missing_facets: Array<"resolution" | "effect" | "state">;
  next_action: DiagnosisNextAction;
  /** Stable over unchanged inputs; identical retries collapse onto it. */
  attempt_fingerprint: string;
}
/**
* The pure repair judge. It decides between: fixable from existing evidence,
* missing pre-evidence, missing a user target choice, not supported by any
* adapter, an executed-without-evidence historical gap, or nothing to do —
* and it NEVER recommends a rebind that cannot change certification.
*/
/**
* The unified diagnosis, with the frozen seven-class label attached (C12).
*
* The class is derived from whatever `reason_code` the judge decides, so a new
* branch cannot drift from the classification table.
*/
declare function deriveItemDiagnosis(p: GuardProjection, item: GuardItem): UnifiedItemDiagnosis;
/** Legacy compact view, now derived from the single unified diagnosis. */
declare function itemDiagnosis(p: GuardProjection, item: GuardItem): {
  certifiable: boolean;
  reason_code: string;
  next_step: string;
};
declare function evidenceAvailabilityReason(evidence: GuardEvidence): string | undefined;
/** Shared display filter; certification remains the full domain check. */
declare function relevantEvidence(p: GuardProjection, item: GuardItem, evidence: GuardEvidence): boolean;
/**
* The bounded, one-phrase form of a reachable remedy (0.6.2 D062-01). The
* capability consequence above is the full explanation; a bounded page lists
* many items, so it uses this phrase and leaves the prose to the detail and
* preparation surfaces. Both come from the SAME capability fact.
*/
declare function capabilityRemedyPhrase(remedy: CapabilityRemedy): string;
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
  /** 0.6.2 D062-02: the layered shell reading, present only for shell tools. */
  processFacts?: DerivedProcessFacts;
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
  reasonCode?: GitPrestateCheck["reasonCode"] | "repository_missing" | "effect_already_applied";
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
/**
* Canonical command templates, derived from the SAME audited argv shapes the
* parser accepts above. Guidance surfaces (context_guard_prepare) render these
* so a tool description can never advertise a command the executor rejects.
*/
declare const GIT_COMMAND_TEMPLATES: Partial<Record<GitAdapterAction, Record<string, unknown>>>;
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
declare function packageRowsFromPnpmLock(text: string, names?: readonly string[]): PackageRow[];
/**
* The production host verdict: the version floor and the exact-graph audit,
* combined into the one answer a caller acts on.
*
* The two facts stay separable — `hostVersion` is always reported on the
* evaluation — but a host below the supported floor is refused here even when
* its graph matches an audited cohort, because no graph can lift a version
* floor. Keeping this combination out of `evaluateHostLock` leaves that
* function a pure graph audit, so a graph verdict is never overwritten by a
* version verdict inside it.
*/
declare function combineHostPolicy(evaluation: HostLockEvaluation): HostLockEvaluation;
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
/** Read exact reachable critical rows without requiring Guard installation.
* Used by target preflight before a legacy profile can be migrated.
*/
declare function readActiveHostGraph(runtimeRoot: string, profileRoot: string): PackageRow[];
interface TargetHostGraph {
  packages: PackageRow[];
  profileGraph: {
    state: "active_importer" | "dependency_free_headless";
    manifestSha256?: string;
    bundles?: PackageRow[];
  };
}
/**
* Pre-install inspection only. A fresh rc.1 Headless profile can use its two
* installation-owned bundles without a private importer. Never extend this
* absence rule to inject or runtime replay, which still call the strict reader.
*/
declare function inspectTargetHostGraph(runtimeRoot: string, profileRoot: string): TargetHostGraph;
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
declare function verifyComposedHostLockDump(text: string, expected: HostLockEvaluation, roots?: Pick<ActiveProfileHostLock, "runtimeRoot" | "profileRoot">): HostLockEvaluation;
//#endregion
//#region src/domain/lifecycle.d.ts
/**
* Runtime-owned startup lifecycle. It expresses the activation strategy of a
* session, never contract or certification state: `armed` means protection is
* enabled and waiting for the first real root user input, `active` means that
* input has entered a step, and `disabled` means an explicit `off` (or an
* opt-in session without `on`). Certification still depends only on durable
* root events, the current contract, and the evidence chain.
*/
type LifecyclePhase = "armed" | "active" | "disabled";
interface FirstStepInjection {
  /** Versioned protocol boundary appended before this step's messages. */
  boundary: string;
  /** Compact first-step guidance describing the activated protection. */
  guidance: string;
}
/** One claimed pre-step message: a validated host `UserMessage`. */
interface ClaimedMessage {
  source?: {
    kind?: unknown;
    plugin?: unknown;
  };
  content?: unknown;
}
/**
* Pure preview of one claimed pre-step batch. Messages claimed by the loop are
* NOT yet persisted as `user/message` events at pre-step time, so this reads
* only the validated claim: it never writes contract items, evidence, or
* authority. A message activates protection when it carries a root user source
* and real content — non-empty text, or any non-text part (image/attachment).
* Whitespace-only messages with no other parts are real input but state no
* task, so they neither activate nor produce contract items.
*/
declare function claimedBatchHasRealRootInput(messages: readonly unknown[]): boolean;
interface FirstStepPreviewInput {
  activation: "opt-in" | "always";
  /** Log-derived enablement: an explicit `off` suppresses `always` until `on`. */
  enabled: boolean;
  /** The durable log already contains a v5 (0.6) Guard boundary. */
  boundaryV5Present?: boolean;
  /** The durable log already contains a v4 (or newer) Guard boundary. */
  boundaryPresent: boolean;
  /** The session is a delegated/subagent session, never a root conversation. */
  delegated: boolean;
  /** 0.6.1 (W060-05): the effective responsibility tier shapes the guidance. */
  policy?: "standard" | "strict" | "release";
}
/**
* Pure decision for the first-step activation injection when protection is enabled. The
* boundary must precede the first constrained root message inside the SAME
* persisted step batch; guidance is compact and never claims a recovery that
* did not happen. `opt-in` reaches this path only after its explicit `on` command. Delegated sessions receive neither: their
* scope arrives through the parent's delegation prompt (A04).
*
* A session without a v5 boundary receives the 0.6 boundary: it cuts the
* work-unit/delivery/certificate-v2 semantics at exactly this message. A
* session that already has v5 injects nothing.
*/
declare function previewFirstStepInjection(input: FirstStepPreviewInput, claimedRealInput: boolean): FirstStepInjection | undefined;
/**
* Compact first-step guidance: protection has started, what it protects, and
* when the guarded producer path is needed. 0.6.1 (W060-05): the stateful
* workflow is stated CONDITIONALLY — only an obligation whose own clause
* demands a certified stateful action runs through prepare/producer/checkpoint.
* The 0.6.0 text demanded that order for every stateful action unconditionally,
* which ordinary business work correctly read as a Guard approval gate.
* Ordinary answers, investigations, and ordinary tool work are never gated, and
* missing Guard evidence is never a reason to repeat a completed action.
*/
declare function firstStepGuidance(policy?: "standard" | "strict" | "release"): string;
declare const FIRST_STEP_GUIDANCE: string;
/**
* Lifecycle phase derived from durable facts. `enabled` is the log-derived
* enablement (`always`, or the explicit `on`/`off` command sequence), and
* `realInputSeen` records that a real root user input already entered a step.
* Pure over its inputs so status display and tests cannot drift from the
* injection decision.
*/
declare function lifecyclePhase(input: {
  enabled: boolean;
  realInputSeen: boolean;
}): LifecyclePhase;
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
declare const PROOF_PROTOCOL_VERSION_V2 = "0.6.0";
/** The v2 digest domain; the v1 domain string is untouched. */
declare const PROOF_MANIFEST_DOMAIN_V2 = "ccg.proofManifest.v2";
declare const PROOF_KINDS_V2: readonly ["subject_readback", "scope_coverage", "state_verification", "input_asset_check", "output_visual_readback", "object_url_readback", "execution_fact", "external_fact"];
type ProofKindV2 = (typeof PROOF_KINDS_V2)[number];
/** Host surfaces that can carry a proof producer in the audited cohort. */
type ProofHostSurface = "native_read" | "native_write_edit" | "shell" | "web" | "jobs" | "subagent" | "visual_capture";
interface ProofObligationV2 {
  obligationId: string;
  kind: ProofKindV2;
  surface: ProofSurface;
  /** The current subject identities this obligation binds. */
  subjectIds: string[];
  /** Producer/source identities a satisfying fact must originate from. */
  sourceIds: string[];
  /** The operation the fact must have actually performed. */
  operation: GuardOperation;
  evidenceIds: string[];
  expectedScopeDigest?: string;
  observedScopeDigest?: string;
}
interface ProofManifestV2 {
  proofProtocolVersion: typeof PROOF_PROTOCOL_VERSION_V2;
  obligations: ProofObligationV2[];
  proofSha256: string;
}
/**
* The frozen capability requirement per proof kind. `capabilities` is the set
* a satisfying fact must intersect; `readbackRequired` demands an actual read
* or verify operation (never a bare successful call); `requiredRole` pins the
* fact to the resolution/effect/state role the semantics need; and
* `supportedSurfaces` lists the audited host surfaces that can produce it.
*/
interface ProofKindCapability {
  kind: ProofKindV2;
  capabilities: string[];
  readbackRequired: boolean;
  requiredRole?: EvidenceRole;
  operationOnSubject: boolean;
  supportedSurfaces: ProofHostSurface[];
  /** Host surfaces in the audited cohort that CANNOT produce this fact. */
  unavailableSurfaces: ProofHostSurface[];
}
declare const PROOF_CAPABILITY_MATRIX: Readonly<Record<ProofKindV2, ProofKindCapability>>;
/** The host surface names a fact's tool/adapter identity maps to. */
declare function proofHostSurfacesOf(evidence: GuardEvidence): ProofHostSurface[];
declare function proofDigestV2(obligations: readonly ProofObligationV2[]): string;
declare function createProofManifestV2(obligations: readonly ProofObligationV2[]): ProofManifestV2;
declare function validateProofManifestV2(manifest: unknown): string[];
/**
* Why one fact cannot discharge one v2 obligation, or `undefined` when it can.
* The checks are ordered so the reported reason names the first unmet
* requirement: missing producer capability, wrong role, absent readback, wrong
* source, wrong subject, wrong operation.
*/
declare function proofV2Rejection(evidence: GuardEvidence, obligation: ProofObligationV2): string | undefined;
/**
* The subjects an item's own obligation requires. They come from the item's
* frozen verification contract and captured target — never from the proof
* manifest, which is exactly what a proof must be checked against.
*/
declare function requiredSubjectsOf(item: GuardItem): string[];
/** The frozen coverage digest of a subject set: sorted, then hashed. */
declare function scopeCoverageDigest(subjects: readonly string[]): string;
/** Whether the fact performed an operation the kind accepts. */
declare function proofOperationMatches(evidence: GuardEvidence, obligation: ProofObligationV2): boolean;
/**
* Bind a v2 manifest to the live projection; [] means every obligation binds.
*
* The binding is the whole chain the review demanded, in one place:
* the user's obligation (frozen subject and scope on the ITEM) → the trusted
* producer fact (qualified by the same availability rules ordinary evidence
* uses) → the declared source → the declared operation and its order relative
* to the effect → the real coverage set. Only then is the obligation
* discharged. A manifest that describes a different subject than the item
* asked about fails even when the manifest and the facts agree with each
* other.
*/
declare function bindProofV2ToProjection(projection: GuardProjection, manifest: ProofManifestV2): string[];
/** The v2 session query; the v1 `sessionQuery` keeps its own frozen behaviour. */
interface SessionQueryV2 {
  sessionRefDigest: string;
  epoch: number;
  contractRevision: number;
  state: "valid" | "unknown" | "corrupt";
  proof?: ProofManifestV2;
  cohortId?: string;
  reasonCode?: "proof_invalid" | "proof_unbound";
}
declare function sessionQueryV2(projection: GuardProjection, proof?: ProofManifestV2): SessionQueryV2;
/**
* The capability report for one proof kind against the facts a cohort actually
* produced: `unavailable` with a stable reason when no producer is observable,
* never a silent pass.
*/
declare function proofCapabilityReport(kind: ProofKindV2, facts: Iterable<GuardEvidence>): {
  status: "supported" | "unavailable";
  reasonCode?: string;
};
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
declare const MIN_RECOVERY_CHAR_BUDGET = 512;
/**
* 0.6.2 D062-03: the standing condition a removal or cleanup outcome must keep.
* The guard cannot observe another process's cwd or handles, so it states the
* condition instead of inferring "no dependants" from a clean tree, an empty
* `git worktree list`, or a directory that merely looks empty. This is one
* shared wording, not an incident phrase list, and it never claims the plugin
* can block a dangerous removal on its own.
*/
declare const CLEANUP_CONDITION_RULE: string;
/**
* The same condition at a medium budget (0.6.2 review): shorter than the full
* rule, and still explicit that an unknown dependant forbids the claim.
*/
declare const CLEANUP_CONDITION_RULE_SHORT: string;
/**
* The same condition at emergency budget (0.6.2 review). A packet with fewer
* than 1000 characters cannot carry the longer sentences AND its own rules, so
* the condition is compressed — but it is NEVER omitted: the one thing a compact
* packet must not lose is that an unknown dependant forbids a removal claim.
*/
declare const CLEANUP_CONDITION_RULE_COMPACT: string;
/**
* Pick the longest form of the condition the packet's budget can actually
* afford. The caller reserves this line's length before any optional row, so
* the condition is never the text that gets clipped.
*/
declare function cleanupConditionFor(budget: number): string;
/**
* Whether this gap needs the cleanup condition spelled out. The condition
* belongs to every uncertifiable lane that could describe removal-like work —
* which the guard cannot identify from text — so it rides the CAPABILITY
* limitation itself, never a vocabulary of destructive verbs.
*/
declare function carriesCleanupCondition(gap: CapabilityGap): boolean;
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
//#region src/domain/rc015-host.d.ts
/**
* Exact 33-row DSH 0.1.5-rc.1 core graph.
*
* Provenance: every row is the npm registry `dist.integrity` of the exact
* published tarball for the named version, read from
* `https://registry.npmjs.org/<name>/0.1.5-rc.1` (and `4.0.2` for
* `@deepseek-ai/cordis`, which is versioned independently of DSH). The single
* resolver for this graph is an isolated DSH installation plus the repository
* worktree lockfile, both installed from the public registry.
*
* This is a REGISTRY-DERIVED graph, not a natively audited one: the cohort
* carries `auditedPlatforms: []` until a native macOS/Windows host audit runs,
* and `auditProvenance: 'registry-derived-pending-native-audit'` is bound into
* the host-lock digest so a certificate can never claim a native pass this round
* did not produce. (`acceptedPlatforms` is the separate, wider gate: this cohort
* accepts evaluation on both platforms while claiming an audit on neither.)
* `dshmarket` is deliberately absent: market identity is verified independently
* by the action adapter and never participates in the core lock.
*
* The row-name set is unchanged from the historical 0.1.2-rc.1 cohort's 33
* core rows: no package entered or left the audited core graph, so a future
* reader must not infer a graph change from the version bump alone. The count
* is asserted from this list, never assumed.
*/
declare const RC015_HOST_PACKAGES: PackageRow[];
//#endregion
//#region src/domain/rc015-rc2-host.d.ts
/** Exact npm registry identities for DSH 0.1.5-rc.2 (Cordis 4.0.2).
* Native acceptance is recorded separately; these rows are registry-derived.
*/
declare const RC015_RC2_HOST_PACKAGES: PackageRow[];
//#endregion
//#region src/domain/session-events.d.ts
/**
* Read a validated, stable event snapshot from the DSH Session V3 API.
*
* Session V3 replaced the V2 `events` getter with `snapshotEvents()`. Context
* Guard supports only the V3 API: a session object that does not expose that
* method is an unsupported host, never a reason to fall back to a legacy
* accessor. Failing loud here keeps a V2-shaped object from being projected as
* if its events had V3 semantics — the two vocabularies differ (surfaces,
* `assistant/chunk` vs embedded streams, `session/end-seed` payload), so a
* silent fallback would derive contract state from a log it cannot read.
*
* Guard is a READER of the durable log, so the envelope check below is the one
* part of log validation it owns itself. The host validates a session it
* constructs or restores; Guard additionally refuses a snapshot that is not a
* sequence of event envelopes, because a projection that silently dropped or
* mis-numbered an event would fabricate contract state rather than report a
* damaged log.
*
* The V3 contract also asks a reader to refuse an unrecognized event type that
* is not marked `ignorable`. Guard does NOT implement that half, deliberately:
* the host's persistence reader already refuses such a log before publishing a
* Session, and a whitelist of event types Guard happens to know would
* false-refuse a healthy host whose composition registers a required event type
* through a third-party plugin. The full rationale is in
* `UPSTREAM_API_AUDIT.md`; revisit it there rather than adding a whitelist here.
*/
declare const SESSION_API_UNSUPPORTED = "session_api_unsupported";
declare const SESSION_EVENT_ENVELOPE_INVALID = "session_event_envelope_invalid";
declare class SessionApiError extends Error {
  readonly code: string;
  constructor(message: string, code?: string);
}
/** The V3 session surface Guard reads: one bounded, immutable event snapshot. */
interface V3SessionLike {
  snapshotEvents(fromSeq?: number, toSeqExclusive?: number): readonly unknown[];
}
declare function snapshotSessionEvents(session: unknown): readonly unknown[];
//#endregion
//#region src/domain/stop-policy.d.ts
/**
* What "relevant progress" means, as one value.
*
* The inputs are the recorded state a caller could not have faked without
* changing the work itself: the epoch and contract revision, the open items and
* their blockers, the qualified evidence set, the boundary qualifications
* available right now, and the Goal's identity and activation. Deliberately
* absent: timestamps, event counts, wording, checkpoint bodies, and the Goal
* *revision* — editing a Goal's text is not progress, and treating it as such
* would let a re-statement reset the stop budget.
*/
/**
* How many times the same progress fingerprint must be observed at a turn
* boundary before Guard stops the automatic continuation.
*
* The first sighting is a baseline, not a stalled turn: it is the state a turn
* either advanced to or started from, and the host's driver owns continuation
* there. The second sighting is the first turn that produced nothing new, which
* earns the one diagnosis and correction opportunity. The third is the bounded
* stop. The count is a resource bound on repetition, never a way to declare the
* task finished.
*/
declare const NO_PROGRESS_TURNS_BEFORE_STOP = 3;
/** Marks the durable no-progress record; replay reads the budget from these. */
declare const NO_PROGRESS_RECORD_PREFIX = "Context Guard no-progress record: ";
/**
* The identity of the turn boundary a decision is taken at.
*
* Guard does not own the host's turn counter, and a retry must be recognisable
* as the same boundary rather than as a new one. The last durable event is that
* identity: it is derivable from the log alone, it is stable across a reload,
* and it only advances when the session actually records something new.
*/
declare function decisionBoundaryKey(projection: GuardProjection): number | undefined;
declare function progressFingerprint(projection: GuardProjection): string;
type CompletionDisposition = "complete" | "user_wait" | "external_wait" | "report";
declare function isWholeTaskCompletionClaim(text: string): boolean;
declare function classifyCompletionClaim(text: string): CompletionDisposition;
interface TurnStoppingDecision {
  action: "continue" | "stop";
  reason?: string;
  /**
  * The no-progress attempt this decision asks the caller to record durably.
  * Recording is the caller's job because it is a durable side effect; deciding
  * is this function's job and must stay free of them.
  */
  noProgressClaim?: {
    fingerprint: string;
    boundaryKey: string;
    attempt: number;
  };
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
/**
* Whether the last trusted ROOT instruction asked to pause.
*
* The source filter is the contract, not a heuristic: a quoted log, a tool
* result, a plugin notice or a model message is not a `user/message` with
* `source.kind === 'user'`, so none of them can reach this function at all, and
* neither can the model's own summary of one. A negated pause ("不要暂停") is not
* a pause request, and the check is anchored to a clause head so a pause word
* mentioned inside a longer instruction is not a control request.
*/
declare function latestRootInstruction(events: readonly {
  type: string;
  seq?: number;
  data: unknown;
}[]): {
  text: string;
  seq: number;
} | undefined;
/** Marks a root control request Guard has already carried to the host. */
declare const CONTROL_RECORD_PREFIX = "Context Guard control record: ";
declare function isRootPauseRequest(text: string): boolean;
declare function latestAssistantText(events: readonly {
  type: string;
  data: unknown;
}[]): string;
//#endregion
//#region src/domain/supersession.d.ts
declare function supersedeItem(items: Map<string, GuardItem>, oldId: string, replacement: GuardItem): boolean;
//#endregion
export { ProofSurface as $, ScopeInterpretation as $a, GuardItemStatus as $i, deriveProjection as $n, TaskIntent as $r, GIT_COMMAND_MANIFEST_IDS as $t, MIN_RECOVERY_CHAR_BUDGET as A, CapabilityFact as Aa, AssetObligation as Ai, ToolCallInput as An, semanticActionFromText as Ao, evaluateExternalWaitCapability as Ar, ClaimedMessage as At, PROOF_KINDS as B, ProcessOutcomeReason as Ba, EvidenceBinding as Bi, Repairability as Bn, ParsedHostVersion as Br, HostProfileError as Bt, RC015_RC2_HOST_PACKAGES as C, confirmRebind as Ca, GoalActivationState as Ci, ShellParseStatus as Cn, actionCompatible as Co, HostLockStatus as Cr, evidenceMatchesItem as Ct, CLEANUP_CONDITION_RULE_COMPACT as D, rebindAttemptKey as Da, isCurrentAcceptedBoundary as Di, parseShellCommand as Dn, requestedTargetAuthorizesMutation as Do, LEGACY_HOST_COHORTS as Dr, ManifestIssue as Dt, CLEANUP_CONDITION_RULE as E, proposeRebindV042 as Ea, effectuateBoundary as Ei, parsePwshCommand as En, requestedIdentityKey as Eo, HostToolSurface as Er, CommandSurfaceManifest as Et, openItems as F, DependencyStatus as Fa, DelegationRef as Fi, extractToolSubject as Fn, normalizeClause as Fo, selectHostCohort as Fr, claimedBatchHasRealRootInput as Ft, ProofHostSurface as G, capabilityFactOf as Ga, ExternalOperation as Gi, evidenceAvailabilityReason as Gn, parseHostVersion as Gr, injectActiveProfileHostLock as Gt, PROOF_MANIFEST_DOMAIN_V2 as H, actionHasCertificationPath as Ha, EvidenceParseStatus as Hi, UnifiedItemDiagnosis as Hn, SUPPORTED_HOST_VERSIONS as Hr, combineHostPolicy as Ht, recoveryDigest as I, DerivedProcessFacts as Ia, DeriveConfig as Ii, isDeterministicCheck as In, sanitizeClauseText as Io, HostVersionDecision as Ir, firstStepGuidance as It, ProofKindV2 as J, removalIsPartiallyKnown as Ja, GuardCheckpoint as Ji, CAPTURE_V042_NOTICE as Jn, AuthorityBlock as Jr, packageRowsFromPnpmLock as Jt, ProofKind as K, partialFailureOf as Ka, GoalRef as Ki, itemDiagnosis as Kn, satisfiesSupportedHostRange as Kr, inspectTargetHostGraph as Kt, renderRecoveryPacket as L, OperationAttribution as La, DeriveResult as Li, withDurability as Ln, sanitizeUrl as Lo, HostVersionStatus as Lr, lifecyclePhase as Lt, carriesCleanupCondition as M, CapabilityRemedy as Ma, BoundaryDisposition as Mi, ToolSubject as Mn, validateActionTarget as Mo, evaluateHostLock as Mr, FirstStepInjection as Mt, cleanupConditionFor as N, DEPENDENCY_FREE_ONLY_CONDITION as Na, BoundaryQualificationKind as Ni, evidenceFromPersistedToolResult as Nn, canonicalizePath as No, evaluateToolSurfaceCapability as Nr, FirstStepPreviewInput as Nt, CLEANUP_CONDITION_RULE_SHORT as O, rebindResponse as Oa, qualifyBoundary as Oi, goalCompletionDenial as On, requestedTargetMatchesResolved as Oo, bindExecutableIdentity as Or, OperationVerbEntry as Ot, closingHint as P, DeclaredOperationResult as Pa, DeferAuthorization as Pi, extractTextContent as Pn, digestStrings as Po, hostVersionFromPackages as Pr, LifecyclePhase as Pt, ProofObligationV2 as Q, InterpretOptions as Qa, GuardItemKind as Qi, PROTOCOL_V5_NOTICE as Qn, segmentAuthorityBlocks as Qr, verifyComposedHostLockDump as Qt, ALPHA3_HOST_PACKAGES as R, ProcessExitStatus as Ra, DeriveScope as Ri, CertificationSupport as Rn, sha256 as Ro, LATEST_SUPPORTED_HOST_VERSION as Rr, previewFirstStepInjection as Rt, snapshotSessionEvents as S, RebindProposal as Sa, BoundaryRequest as Si, ParsedShell as Sn, StatefulAction as So, HostLockEvaluation as Sr, evidenceCoverage as St, RC1_HOST_PACKAGES as T, proposeRebindOutcome as Ta, availableBoundaryQualifications as Ti, isRunExecutable as Tn, isStatefulAction as To, HostProfileKind as Tr, COMMAND_SURFACE_MANIFEST as Tt, PROOF_PROTOCOL_VERSION as U, admissibleForRemoval as Ua, EvidenceRole as Ui, capabilityRemedyPhrase as Un, compareHostVersions as Ur, hostLockContextFromComposedDump as Ut, PROOF_KINDS_V2 as V, RemovalOutcomeReport as Va, EvidenceOutcome as Vi, TaskKind as Vn, SUPPORTED_HOST_RANGE as Vr, TargetHostGraph as Vt, PROOF_PROTOCOL_VERSION_V2 as W, capabilityConsequence as Wa, ExpectedTransition as Wi, deriveItemDiagnosis as Wn, evaluateMinimumHostVersion as Wr, hostLockRowsFromComposedDump as Wt, ProofManifestV2 as X, DirectiveClass as Xa, GuardIntegrity as Xi, PROTOCOL_V3_NOTICE as Xn, AuthorityKind as Xr, resolveActiveProfileHostLock as Xt, ProofManifest as Y, AuthorityDisposition as Ya, GuardEvidence as Yi, DEFAULT_DELEGATION_TOOL_NAMES as Yn, AuthorityBlockKind as Yr, readActiveHostGraph as Yt, ProofObligation as Z, Executee as Za, GuardItem as Zi, PROTOCOL_V4_NOTICE as Zn, authorityCaptureCounts as Zr, resolveInstalledHostLock as Zt, progressFingerprint as _, ReleaseOperation as _a, extractOperation as _i, parseGitCommandManifest as _n, STATEFUL_ACTIONS as _o, HostCapabilityRequest as _r, sessionQueryV2 as _t, NO_PROGRESS_RECORD_PREFIX as a, SourceSpan as aa, isFrozenV042RebindResponse as ai, GitCommandRejected as an, maskCodeSpans as ao, AuditedExecutable as ar, createProofManifest as at, SessionApiError as b, ProposeOutcome as ba, BoundaryEffectuation as bi, CanonicalArgv as bn, SUPPORTED_EVIDENCE_ADAPTERS as bo, HostCohortSelectionReason as br, EvidenceFacetCoverage as bt, classifyCompletionClaim as c, TargetTuple as ca, RejectedBinding as ci, GitPrestateCheck as cn, statefulActionsOfScope as co, EXPECTED_HOST_PACKAGES as cr, proofDigest as ct, decisionBoundaryKey as d, WaitAuthorization as da, ClauseSegment as di, LinearCommitReadback as dn, ActionManifest as do, GOAL_HOST_PACKAGES as dr, proofHostSurfacesOf as dt, GuardOperation as ea, UserInteractionKind as ei, GIT_COMMAND_TEMPLATES as en, interpretClause as eo, ACTIVE_HOST_COHORT_ID as er, SessionQuery as et, isRootPauseRequest as f, WorkUnit as fa, captureClause as fi, commitIndexSnapshotDigest as fn, ActionSpec as fo, HOST_CAPABILITY_PACKAGE_GROUPS as fr, proofOperationMatches as ft, observeAssistantOutcome as g, ReleaseObservedIdentity as ga, extractMethod as gi, gitCommandMatchesTarget as gn, SEMANTIC_ACTIONS as go, HostCapabilityId as gr, sessionQuery as gt, latestRootInstruction as h, ReleaseGateDecision as ha, extractArtifactPaths as hi, executeRevalidatedGitEffect as hn, CERTIFICATE_VERSION_V2 as ho, HostCapabilityEvaluation as hr, scopeCoverageDigest as ht, CompletionDisposition as i, PersistenceAuthorization as ia, ParsedConfirmation as ii, GitCommandParseResult as in, kindOfScope as io, ALPHA2_HOST_PACKAGES as ir, canonicalProjection as it, RecoveryOptions as j, CapabilityGap as ja, BindingActionClosure as ji, ToolResultInput as jn, validateActionManifest as jo, evaluateHostCapability as jr, FIRST_STEP_GUIDANCE as jt, DEFAULT_RECOVERY_CHAR_BUDGET as k, replayRebindResult as ka, AssetInterpretationFact as ki, hasCurrentCertificate as kn, semanticActionFromCommand as ko, bindLiveGoalCapability as kr, validateManifest as kt, decideTurnBoundary as l, TargetValue as la, certifyCheckpoint as li, GitPrestateEnvelope as ln, ACTION_MANIFEST as lo, ExecutableIdentity as lr, proofDigestV2 as lt, latestAssistantText as m, PackageRow as ma, classifyClause as mi, createGitPrestateEnvelope as mn, CERTIFICATE_VERSION as mo, HostAuditProvenance as mr, requiredSubjectsOf as mt, AssistantOutcomeObservation as n, HostStatus as na, classifyUserInteraction as ni, GitCommandAccepted as nn, isExecutableItem as no, ACTIVE_HOST_LAUNCHER_VERSION as nr, bindProofToProjection as nt, NO_PROGRESS_TURNS_BEFORE_STOP as o, TargetCaptureReasonCode as oa, parseConfirmationMessage as oi, GitEffectExecution as on, namedActions as oo, BASE_HOST_PACKAGES as or, createProofManifestV2 as ot, isWholeTaskCompletionClaim as p, createProjection as pa, captureItem as pi, commitTreeSnapshotDigest as pn, BOUNDED_ARTIFACT_TYPES as po, HOST_COHORTS as pr, proofV2Rejection as pt, ProofKindCapability as q, removalIsComplete as qa, GuardBoundary as qi, relevantEvidence as qn, currentContractDigest as qr, packageRowsFromActiveGraph as qt, CONTROL_RECORD_PREFIX as r, MessageCoverage as ra, CONFIRM_LINE_PATTERN as ri, GitCommandManifest as rn, isOpenObligation as ro, ALPHA2_DSHMARKET_139_HOST_PACKAGES as rr, bindProofV2ToProjection as rt, TurnStoppingDecision as s, TargetCaptureStatus as sa, CheckpointResult as si, GitEffectRunner as sn, semanticActionOfScope as so, DEFAULT_HOST_LOCK as sr, proofCapabilityReport as st, supersedeItem as t, GuardProjection as ta, classifyTaskIntent as ti, GitAdapterAction as tn, interpretMessage as to, ACTIVE_HOST_COHORT_IDS as tr, SessionQueryV2 as tt, decideTurnStopping as u, VerificationContract as ua, CaptureScope as ui, GitTargetIdentity as un, ACTION_MANIFEST_VERSION as uo, ExecutableIdentityBinding as ur, proofEvidenceConstraints as ut, SESSION_API_UNSUPPORTED as v, ReleaseSettlement as va, isInformationalMessage as vi, revalidateGitPrestate as vn, STOP_PROTOCOL_VERSION as vo, HostCohort as vr, validateProofManifest as vt, RC015_HOST_PACKAGES as w, proposeRebind as wa, GoalBoundaryAccess as wi, canonicalArgvFromCommand as wn, boundedArtifactChoiceMatches as wo, HostPlatform as wr, isVerifyingCapability as wt, V3SessionLike as x, RebindArgs as xa, BoundaryQualification as xi, CanonicalCommandSurface as xn, SemanticAction as xo, HostLockContext as xr, bindingSatisfies as xt, SESSION_EVENT_ENVELOPE_INVALID as y, BoundedSource as ya, segmentClauses as yi, verifiedLinearCommitReadback as yn, STOP_PROTOCOL_VERSION_V2 as yo, HostCohortSelection as yr, validateProofManifestV2 as yt, PROOF_CAPABILITY_MATRIX as z, ProcessFactSource as za, DerivedEnvelope as zi, DiagnosisNextAction as zn, MIN_SUPPORTED_HOST_VERSION as zr, ActiveProfileHostLock as zt };