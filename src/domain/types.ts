export type GuardItemKind = 'requirement' | 'acceptance' | 'prohibition'
/**
 * `answered` (0.6.0, C03) marks an information-slot obligation closed by a
 * trusted delivery fact: the host-confirmed final answer of a completed turn.
 * It certifies only that delivery happened — never accuracy, sufficiency, or
 * that any execution happened. Legacy sessions (no v5 boundary) never mint it.
 */
export type GuardItemStatus = 'pending' | 'answered' | 'passed' | 'superseded'
export type GuardIntegrity = 'valid' | 'unknown' | 'corrupt'
export type EvidenceOutcome = 'success' | 'failure' | 'unknown' | 'durability-unknown'
export type GuardOperation = 'create' | 'write' | 'modify' | 'read' | 'run' | 'verify'
/**
 * 0.6.3 K2: where an obligation's requested target came from. A target is a
 * user SELECTION only when the root named it or a trusted host selection made
 * it; an environment default (the session working directory, a recent tool
 * path, a model-supplied selector) resolves and corroborates a target the root
 * already allowed, and never manufactures root authority. An inherited target
 * comes from another obligation of the same work unit whose own source is
 * auditable.
 */
export type TargetSourceKind =
  | 'explicit_label'
  | 'explicit_path'
  | 'explicit_current_repository'
  | 'host_selection'
  | 'unit_inherited'
  | 'environment_default'

export interface TargetSource {
  kind: TargetSourceKind
  /** Source message id of the obligation a `unit_inherited` target came from. */
  inheritedFrom?: string
}

export type TargetValue = boolean | number | string | { k: 'b' | 'i' | 's' | 'e' | 'x'; v: unknown }
export type TargetTuple = Record<string, TargetValue>
export type EvidenceRole = 'resolution' | 'effect' | 'state'
export type EvidenceParseStatus = 'supported' | 'unsupported_statement_operator' | 'unsupported_command' | 'malformed_quote' | 'adapter_unavailable'
export type HostStatus = 'supported' | 'unsupported' | 'unavailable'
export type TargetCaptureStatus = 'resolved' | 'clarification_required'
/**
 * 0.6.3 K4: why a record captured under the rules of an EARLIER release can no
 * longer be reused as a current pass. The record itself is never rewritten —
 * its historical status (including `answered`) stays the historical fact it
 * was — but the current eligibility layer refuses to inherit it and the
 * obstruction blocks new certificates and Goal completion until the root
 * resolves it. It is deliberately a hard block, not a warning: 0.6.2 published
 * a mixed request as answered, and a warning would have left exactly that
 * misreading in force.
 */
export type NeedsReviewReason =
  /** An information reading that still names work of its own (F062-01). */
  | 'legacy_mixed_information_scope'
  /** A resolved target with no auditable source: the 0.6.2 environment default (F062-02). */
  | 'legacy_environment_default_target'
  /** The record's own state version is unknown to this build. */
  | 'unknown_state_version'
  /**
   * 0.6.3 (narrowed contract): the record predates execution qualification, so
   * nobody may read its stored disposition as authority. Its history is preserved
   * untouched; only its eligibility as a CURRENT pass is refused.
   */
  | 'legacy_missing_execution_qualification'
  | 'legacy_v6_generic_action'
  | 'legacy_v6_ordinary_certification'
  | 'legacy_v6_text_wait'

export interface NeedsReviewFact {
  reason: NeedsReviewReason
  /** Stable identity of the eligibility check that raised it. */
  checkId: string
  /** When the check was applied: this is an upgrade fact, not a birth fact. */
  recordedAtRevision: number
}
export type TargetCaptureReasonCode =
  | 'requested_target_package_id_missing'
  | 'requested_target_artifact_id_missing'
  | 'requested_target_repository_missing'
  /**
   * 0.6.3 K2: several equally sourced repository candidates exist in the
   * current work unit and the root must select one.
   */
  | 'requested_target_repository_ambiguous'
  /**
   * 0.6.3 K2: the repository is unique but another identity field (branch,
   * remote or refspec) differs across the candidates of that repository, so the
   * field is a choice the root has not made yet.
   */
  | 'requested_target_field_ambiguous'
  | 'requested_target_service_id_missing'
  | 'requested_target_registry_missing_or_invalid'

export interface GoalRef {
  id: string
  revision: number
}

/**
 * 0.6.0 source span (C01): a UTF-8 byte half-open interval `[start, end)`
 * inside the ORIGINAL root message text (before any normalization), bound to
 * that message's content digest. Offsets are byte offsets computed with
 * TextEncoder — never string indices — so Python and TypeScript agree on the
 * same positions.
 */
export interface SourceSpan {
  /** Index of the message part the span anchors to (0 = text). */
  partIndex: number
  start: number
  end: number
  class: 'instruction' | 'adoption' | 'question' | 'constraint'
}

/** 0.6.0 per-message coverage summary (C01), bounded to the last 16 messages. */
export interface MessageCoverage {
  seq: number
  rawTextSha256: string
  byteLength: number
  /** Number of obligation spans the message contributed to items. */
  coveredSpans: number
}

export interface WaitAuthorization {
  kind: 'root_explicit_wait' | 'user_decision_item'
  id: string
}

export interface DeferAuthorization {
  kind: 'root_explicit_defer'
  id: string
}

export interface PersistenceAuthorization {
  kind: 'root_explicit_persistence'
  id: string
}

export interface VerificationContract {
  subject?: string
  surface?: 'artifact' | 'ui' | 'visual' | 'scope'
  enforced: boolean
  /** Explicitly-required tool/method (e.g. 'bash'); when set, a successful
   * evidence from that tool must be present in addition to artifact/scope
   * coverage before the item can close. */
  method?: string
  /** Explicitly-required operation/effect (e.g. 'create', 'read'). When set
   * alongside `method`, the method evidence must have performed that operation
   * on the same canonical subject — mentioning the file is not enough. */
  operation?: GuardOperation
}

/**
 * 0.6.1 (W060-01): the durable identity of one non-text root input part. The
 * asset obligation binds the exact message sequence, part index and content
 * digest of the ORIGINAL input — never a model description of it — so an
 * interpretation can only ever be recorded against the asset it interpreted.
 */
export interface AssetObligation {
  /** Sequence of the root message that carried the part. */
  messageSeq: number
  /** Index of the non-text part inside that message. */
  partIndex: number
  /** sha256 of the canonical JSON of the part: the media identity. */
  mediaSha256: string
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
export interface AssetInterpretationFact {
  itemId: string
  resultSeq: number
  /** The host turn the interpretation happened in. */
  turn: number
}

export interface GuardItem {
  id: string
  revision: number
  kind: GuardItemKind
  sourceMessageId: string
  normalizedText: string
  textSha256: string
  status: GuardItemStatus
  supersededBy?: string
  supersededByItems?: string[]
  reboundFrom?: { itemId: string; proposalId: string; confirmationEvent: string }
  verification: VerificationContract
  semanticAction?: import('./protocol-manifest.js').SemanticAction
  requestedTarget?: TargetTuple
  targetCaptureStatus?: TargetCaptureStatus
  targetCaptureReasonCode?: TargetCaptureReasonCode
  /**
   * 0.6.3 K2 provenance of {@link requestedTarget}. Absent on items captured by
   * 0.6.2 and earlier, whose target reading is historical and evaluated by the
   * upgrade eligibility check rather than re-interpreted.
   */
  targetSource?: TargetSource
  /**
   * 0.6.3 K4: set by the upgrade eligibility check when this record cannot be
   * inherited as a current pass. It never overwrites the historical status.
   */
  needsReview?: NeedsReviewFact
  authority?: 'root_instruction' | 'root_adoption' | 'legacy_authority_unclassified'
  legacyFlags?: Array<'legacy_generic_run' | 'legacy_authority_unclassified'>
  /** v0.5 intent layer: inquiries keep the obligation but are not machine certifiable. */
  taskKind?: 'inquiry' | 'action' | 'context'
  /**
   * v0.5.1 interpretation layer, derived from the same source bytes as
   * {@link normalizedText} by `domain/semantics.ts`. These fields record what
   * the message actually authorized, so a prohibition, a human-owned action, a
   * conditional action and an explanation can never become an agent obligation.
   * Absent on legacy items, which keep their historical executable reading.
   */
  directive?: import('./semantics.js').DirectiveClass
  executee?: import('./semantics.js').Executee
  authorityDisposition?: import('./semantics.js').AuthorityDisposition
  /**
   * 0.6.3 (narrowed contract): whether this reading may host execution authority.
   * Established ONCE by the reader, before any partition, and inherited by every
   * child the partition produces. Absent on records captured before the
   * qualification existed: the gate and preparation refuse those rather than
   * reading their stored disposition as permission.
   */
  executionQualification?: import('./semantics.js').ExecutionQualification
  /** The unresolved condition guarding a `conditional_wait` item. */
  condition?: string
  /** The event that ends a human wait, when the source names one. */
  resumeEvent?: string
  /** Stable identity of the interpretation these fields came from. */
  interpretationFingerprint?: string
  /**
   * Every stateful action this item's clause names, in source order, with the
   * target captured for each. A clause may order more than one action
   * ("安装插件，重启 DSH"): the item stays one top-level obligation, and every
   * action it names needs its own matching evidence before it can close.
   */
  actionPlan?: Array<{
    action: 'install' | 'apply' | 'create' | 'modify' | 'restart' | 'commit' | 'push' | 'publish' | 'pull' | 'fetch'
    requestedTarget: TargetTuple
    targetCaptureStatus: TargetCaptureStatus
    targetCaptureReasonCode?: TargetCaptureReasonCode
  }>
  waitAuthorization?: WaitAuthorization
  deferAuthorization?: DeferAuthorization
  persistenceAuthorization?: PersistenceAuthorization
  /**
   * 0.6.0 C01 provenance: the content digest of the original root message
   * text and the UTF-8 byte spans inside it that this item's clause came
   * from. Absent on legacy items, which keep their historical reading.
   */
  rawTextSha256?: string
  spans?: SourceSpan[]
  /**
   * 0.6.0 work-unit assignment (C04), present only for obligations captured
   * after a v5 protocol boundary in a non-delegated session. Legacy items keep
   * the whole-session contract and carry no unit.
   */
  unitId?: string
  /**
   * The trusted delivery fact that closed an information-slot item: the host's
   * completed turn and its final assistant message. Derived from durable
   * events, never from assistant prose alone.
   */
  answeredBy?: { turn: number; responseSeq: number; responseSha256: string }
  /**
   * 0.6.0 C08: the pending obligation this item atomically superseded through
   * a verbatim general clarification. Audit trail only — the superseded item
   * keeps its own history.
   */
  clarifiesItemId?: string
  /**
   * 0.6.1 (W060-01 review round 10): set on the sub-items created when an
   * unresolved clause is superseded by its recorded interpretation
   * partition. Names the superseded unresolved obligation; the information
   * sub-items close through the interpreting turn's delivery, while unknown
   * and undeclared sub-spans stay pending.
   */
  interpretedFromUnresolved?: string
  /**
   * 0.6.1 (W060-01): present only on an asset-interpretation obligation. The
   * item's information slot closes through the SAME trusted-delivery fact as
   * any inquiry of its turn; the closing answers the request that carried the
   * asset, never the correctness of the interpretation, and visual-comparison
   * proof (strict surface 'visual') stays a separate obligation. Absent on
   * every other item, so legacy and ordinary text items are unchanged.
   */
  asset?: AssetObligation
}

export interface GuardEvidence {
  id: string
  epoch: number
  callId: string
  rootCallId: string
  toolName: string
  toolResultSeq: number
  outcome: EvidenceOutcome
  capabilities: string[]
  subjects: string[]
  surfaces: Array<'artifact' | 'ui' | 'visual' | 'scope'>
  boundedSummarySha256: string
  /** Executables invoked by a shell-tool command (e.g. 'pnpm', 'git'); present
   * only for command evidence, so an executable-method constraint ("使用 pnpm")
   * can be verified against the command that actually ran. */
  executables?: string[]
  /** Operations with their paths, parsed from the evidence's command or tool
   * payload (quote-aware). A subject mention alone proves nothing; the evidence
   * must show the requested operation on the target. */
  operations?: Array<{ op: GuardOperation; path?: string }>
  semanticAction?: import('./protocol-manifest.js').SemanticAction
  evidenceRole?: EvidenceRole
  resolvedTarget?: TargetTuple
  observedState?: TargetTuple
  /** Immutable predicate frozen by a trusted resolution producer before effect. */
  expectedTransition?: ExpectedTransition
  /** Stable JSON sha256 of expectedTransition, minted by the same resolution producer. */
  expectedTransitionDigest?: string
  parseStatus?: EvidenceParseStatus
  reasonCode?: string
  adapterId?: string
  adapterVersion?: string
  /** Current-version native readback is causally tied to a persisted host effect call. */
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
  externalOperationRef?: ExternalOperation
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
  processFacts?: import('./capability-semantics.js').DerivedProcessFacts
  /**
   * 0.6.0 C04: this fact came from a delegated subagent/task round-trip. A
   * delegated result is BOUNDED evidence for the parent unit — it is recorded
   * and visible, and it can never close a parent obligation or a parent unit
   * by itself. Set only by the derivation, never by a caller.
   */
  delegatedSubtask?: true
}

export interface ExpectedTransition {
  predicateId: string
  version: number
  predParamsKind: 'inline'
  parameters?: TargetTuple
  parametersDigest?: string
}

export interface EvidenceBinding {
  itemId: string
  evidenceIds: string[]
  semanticAction?: import('./protocol-manifest.js').SemanticAction
  requestedTarget?: TargetTuple
  resolvedTarget?: TargetTuple
  observedState?: TargetTuple
  expectedTransition?: ExpectedTransition
  resolutionEvidenceId?: string
  effectEvidenceId?: string
  stateEvidenceIds?: string[]
  /**
   * Per-action closure for a clause that ordered several actions. Every entry
   * of {@link GuardItem.actionPlan} needs its own entry here: one action's
   * evidence never covers another action, and two instances of the same action
   * on different targets are two separate entries.
   */
  actionBindings?: BindingActionClosure[]
}

export interface BindingActionClosure {
  action: import('./protocol-manifest.js').StatefulAction
  evidenceIds: string[]
  resolvedTarget: TargetTuple
  /** Position of this action in the clause's instruction order. */
  order: number
}

export interface GuardCheckpoint {
  id: string
  stopProtocolVersion: string
  certificateVersion: string
  epoch: number
  sessionRefDigest: string
  hostLockDigest: string
  contractRevision: number
  contractSha256: string
  openDigest: string
  evidenceSha256: string
  bindingDigest: string
  /** v3 DSH-native certificate extension; older certificate bytes stay intact. */
  nativeObservations?: { schema: 'dsh.native-observation/v1' | 'dsh.native-observation/v2'; digests: string[] }
  /** V6-only, root-time Session locator identity; outside historical digest_v3. */
  rootLocatorIdentity?: string
  bindings: EvidenceBinding[]
  goalRef?: GoalRef
  certificationDigest: string
  result: 'certified' | 'incomplete' | 'unknown'
  /** Derived persisted result watermark; excluded from historical certificate bytes. */
  recordedAtSeq?: number
  /**
   * 0.6.0 v2 certificate (v5 sessions only): the unit whose closure was
   * certified. Version-1 certificates keep the whole-session contract and
   * never carry a unit.
   */
  unitId?: string
  /** v2 certificates: the digest of the certified unit's open closure. */
  unitClosureDigest?: string
}

/**
 * One 0.6.0 work unit (C04): the obligations captured from one root task and
 * their closure state. Units are derived from the durable message stream, so
 * they replay deterministically; no unit state is ever written to the log.
 */
export interface WorkUnit {
  unitId: string
  /** Sequence of the root message that opened the unit. */
  openedAtSeq: number
  /** Root messages folded into this unit, in source order. */
  rootInputRefs: Array<{ seq: number }>
  /** The normalized text of the unit's opening instruction (bounded audit). */
  headline: string
  /** Sequence at which a newer unit became current, when superseded as current. */
  switchedAwayAtSeq?: number
  /**
   * The unit this one descends from. A delegation-marked root message opens a
   * CHILD unit of the current unit (C04): the child's open obligations are part
   * of the parent's required closure, so the parent can never be certified
   * while a delegated sub-unit still has open work. An ordinary task switch
   * opens a sibling instead, which is why its residual work never blocks the
   * newer unit's certificate.
   */
  parentUnitId?: string
  /**
   * Delegated round-trips that entered this unit as bounded evidence (C04).
   * Recorded for audit only: a subagent's completion is never a parent
   * completion.
   */
  delegationRefs?: DelegationRef[]
}

/** One durable delegated round-trip observed inside a session. */
export interface DelegationRef {
  /** The tool call that requested the delegation. */
  callId: string
  /** Sequence of the paired result event. */
  resultSeq: number
  /** Audited delegation tool that produced the result. */
  toolName: string
  /** Whether the delegated round-trip reported success. */
  status: 'completed' | 'failed' | 'unknown'
}

export type BoundaryDisposition = 'user_wait' | 'external_wait' | 'deferred' | 'guard_bounded_stop'
export type BoundaryQualificationKind = 'user_decision_item' | 'root_explicit_wait' | 'external_operation_pending' | 'root_explicit_defer' | 'guard_no_progress'

export interface GuardBoundary {
  protocolVersion: '1'
  id: string
  disposition: BoundaryDisposition
  qualificationKind: BoundaryQualificationKind
  qualificationIds: string[]
  epoch: number
  contractRevision: number
  contractSha256: string
  goalRef?: GoalRef
  candidateSha256: string
  callId?: string
  persistedResult: 'accepted' | 'rejected' | 'unknown'
  reasonCode: string
}

export interface ExternalOperation {
  id: string
  epoch: number
  adapterId: string
  status: 'running' | 'pending' | 'completed' | 'failed' | 'unknown'
}

export interface GuardProjection {
  enabled: boolean
  /** Explicit root /context-guard on adoption, never inferred from installation or always observation. */
  goalCompletionAdopted: boolean
  epoch: number
  contractRevision: number
  rebindProposals: Map<string, import('./rebind.js').RebindProposal>
  items: Map<string, GuardItem>
  evidence: Map<string, GuardEvidence>
  checkpoints: GuardCheckpoint[]
  boundaries: GuardBoundary[]
  externalOperations: Map<string, ExternalOperation>
  /**
   * 0.6.0 work units keyed by unit id, and the id of the unit currently
   * receiving captured work. Derived; present only after a v5 boundary.
   */
  units: Map<string, WorkUnit>
  currentUnitId?: string
  /**
   * The session's rule mode: `5` once a v5 protocol boundary exists in the log,
   * `undefined` (legacy) before it. Determines certificate version, closure
   * scope, and whether delivery/unit semantics are active.
   */
  boundaryProtocol?: 5 | 6
  v6BoundarySeq?: number
  /** Root-time locator bases from the durable Session header, never a later tool cwd. Windows relative resolution remains unavailable. */
  rootLocatorContexts: Map<number, { base: string; flavor: 'posix' | 'windows'; sha256: string }>
  /** V6 identity domain binds root bytes, original locator base and Session identity. */
  rootLocatorIdentity?: string
  /** Shared core/v2 projection from confirmed Session sources; absent when the adapter lacks exact source coverage. */
  coreV2?: Record<string, unknown>
  coreV2Reason?: 'source_not_projectable' | 'projection_failed'
  /** 0.6.0 responsibility tier (C06), from the effective configuration. */
  policy: 'standard' | 'strict' | 'release'
  /** 0.6.0 C01 coverage summaries, one per captured root message (last 16). */
  coverage: MessageCoverage[]
  /**
   * 0.6.0 C10 explicit release records, derived from the durable plugin-notice
   * channel. A release is never implicit: without an adopted contract the
   * release gate denies every operation. A malformed record is reported through
   * {@link releaseDiagnostics} and never makes the whole projection corrupt, so
   * damaged release state cannot block unrelated ordinary work.
   */
  releaseContracts: import('./release.js').ReleaseContract[]
  releaseReservations: import('./release.js').ReleaseReservation[]
  releaseSettlements: import('./release.js').ReleaseSettlement[]
  /** Bounded audit of rejected release records (never raw payloads). */
  releaseDiagnostics: Array<{ seq: number; reasonCode: string }>
  /**
   * True when a release record could not be read back. Damaged release state
   * blocks RELEASE operations with `release_state_damaged` while leaving the
   * projection's own integrity and all ordinary work untouched: the plugin
   * reports what it cannot read instead of quietly forgetting it.
   */
  releaseStateDamaged: boolean
  /**
   * 0.6.0 C07 trusted host selections, derived only from paired durable
   * question-tool round-trips (last 16). A directory selection narrows where
   * a bounded file choice may land for obligations of the same unit.
   */
  trustedSelections: import('./host-selection.js').TrustedSelection[]
  /**
   * 0.6.1 (W060-01): the derived per-asset interpretation records (bounded to
   * the last 64), one per confirmed `context_guard_interpret` result. Derived,
   * never written by a caller.
   */
  interpretationFacts: AssetInterpretationFact[]
  /**
   * 0.6.0 C07 sandbox approvals, derived from the host's own
   * `approval/asked` + `approval/decided` audit pair (last 16). Recorded for
   * provenance only: an approval is never a target authority.
   */
  approvals: Array<{ id: string; seq: number; toolName?: string; outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' }>
  sessionRefDigest: string
  hostLockDigest: string
  hostStatus: HostStatus
  hostReasonCode?: string
  /** Readback of the audited cohort bound into `hostLockDigest`. */
  hostCohortId?: string
  currentGoalRef?: GoalRef
  currentGoalPhase?: 'active' | 'paused' | 'blocked' | 'complete'
  currentGoalActivation?: 'armed' | 'disarmed'
  certificateStatusReason?: string
  integrityViolations: string[]
  lastObservedSourceSeq: number
  lastGuardEventSeq: number
  lastRecoveryDigest?: string
  lastCheckpointRejections?: Array<{ itemId: string; reason: string; reasonCode?: string; offendingEvidenceIds?: string[] }>
  lastCheckpointRejectionRevision?: number
  /** Bounded fact about the latest rejected confirmation attempt (never raw text). */
  lastConfirmationRejection?: { eventSeq: number; kind: 'malformed' | 'ambiguous'; reason: string }
  continuationAttempts: Map<number, number>
  /** Process-local one-shot fallback counters keyed by epoch + contract revision. */
  persistenceCorrectionAttempts: Map<string, number>
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
  noProgressClaims: Map<string, Map<string, number>>
  /**
   * Root event sequences whose control request Guard already carried to the
   * host. A pause is a one-shot input: once the host has paused, the same
   * message stays in the log forever, and re-reading it must not re-pause a goal
   * the human has since resumed.
   */
  handledControlSeqs: Set<number>
  /**
   * The host turn the projection is currently in, taken from the host's own
   * durable `turn/start` event. This is the turn boundary's identity: the host
   * opens it before it claims input or runs pre-step, so it is stable across a
   * reload, it does not move when Guard writes its own bookkeeping, and a retry
   * of the same turn re-reads the same number.
   */
  hostTurn?: number
  /**
   * Runtime-owned durability watermark (0.6.0 fresh-projection contract): the
   * result of the most recent flush performed by a public read/control entry.
   * `confirmed` means the last entry observed a durable log, `failed` means a
   * flush was refused or threw, and `unknown` means no flush has been observed
   * yet. A `failed` watermark must make read entries report unavailability —
   * never a stale-cache projection and never an empty ledger. Preserved
   * across rebuilds like the other runtime-owned liveness state.
   */
  durabilityWatermark: 'confirmed' | 'failed' | 'unknown'
  /** Log-derived count of rejected rebind attempts by stable attempt key; survives reload. */
  rebindRejections: Map<string, number>
  integrity: GuardIntegrity
}

export function createProjection(): GuardProjection {
  return {
    enabled: false,
    goalCompletionAdopted: false,
    epoch: 0,
    contractRevision: 0,
    rebindProposals: new Map(),
    items: new Map(),
    evidence: new Map(),
    checkpoints: [],
    boundaries: [],
    externalOperations: new Map(),
    units: new Map(),
    rootLocatorContexts: new Map(),
    coverage: [],
    releaseContracts: [],
    releaseReservations: [],
    releaseSettlements: [],
    releaseDiagnostics: [],
    releaseStateDamaged: false,
    policy: 'standard',
    trustedSelections: [],
    interpretationFacts: [],
    approvals: [],
    sessionRefDigest: '11'.repeat(32),
    hostLockDigest: '22'.repeat(32),
    hostStatus: 'supported',
    integrityViolations: [],
    lastObservedSourceSeq: -1,
    lastGuardEventSeq: -1,
    continuationAttempts: new Map(),
    persistenceCorrectionAttempts: new Map(),
    noProgressClaims: new Map(),
    handledControlSeqs: new Set(),
    rebindRejections: new Map(),
    durabilityWatermark: 'unknown',
    integrity: 'valid',
  }
}

export interface DeriveScope {
  /** Session working directory; used as the scope subject for captured clauses. */
  cwd?: string
  sessionHeader?: import('./digest.js').SessionHeader
}

export interface DeriveConfig {
  activation: 'opt-in' | 'always'
  /** 0.6.0 responsibility tier (C06); standard by default. */
  policy?: 'standard' | 'strict' | 'release'
}

export interface DeriveResult {
  projection: GuardProjection
  /** True when the log contains a compaction summary the agent must recover from. */
  compacted: boolean
  /** True when an off→on enablement transition was derived in this log. */
  enablementTransitioned: boolean
  /** Sequence of the last compaction summary in the log, or -1 when none. */
  lastCompactionSeq: number
  /** True when a real root user input (text or asset) is present while enabled. */
  realRootInputSeen: boolean
  /** True when the durable log carries the 0.5 first-step protocol boundary. */
  protocolV4Present: boolean
  /** True when the durable log carries the 0.6 first-step protocol boundary. */
  boundaryV5: boolean
  boundaryV6: boolean
}

export interface DerivedEnvelope {
  seq: number
  type: string
  data?: unknown
}
