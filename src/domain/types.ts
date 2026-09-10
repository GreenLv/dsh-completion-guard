export type GuardItemKind = 'requirement' | 'acceptance' | 'prohibition'
export type GuardItemStatus = 'pending' | 'passed' | 'superseded'
export type GuardIntegrity = 'valid' | 'unknown' | 'corrupt'
export type EvidenceOutcome = 'success' | 'failure' | 'unknown' | 'durability-unknown'
export type GuardOperation = 'create' | 'write' | 'modify' | 'read' | 'run' | 'verify'
export type TargetValue = boolean | number | string | { k: 'b' | 'i' | 's' | 'e' | 'x'; v: unknown }
export type TargetTuple = Record<string, TargetValue>
export type EvidenceRole = 'resolution' | 'effect' | 'state'
export type EvidenceParseStatus = 'supported' | 'unsupported_statement_operator' | 'unsupported_command' | 'malformed_quote' | 'adapter_unavailable'
export type HostStatus = 'supported' | 'unsupported' | 'unavailable'
export type TargetCaptureStatus = 'resolved' | 'clarification_required'
export type TargetCaptureReasonCode =
  | 'requested_target_package_id_missing'
  | 'requested_target_artifact_id_missing'
  | 'requested_target_repository_missing'
  | 'requested_target_service_id_missing'
  | 'requested_target_registry_missing_or_invalid'

export interface GoalRef {
  id: string
  revision: number
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
  authority?: 'root_instruction' | 'root_adoption' | 'legacy_authority_unclassified'
  legacyFlags?: Array<'legacy_generic_run' | 'legacy_authority_unclassified'>
  /** v0.5 intent layer: inquiries keep the obligation but are not machine certifiable. */
  taskKind?: 'inquiry' | 'action'
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
  externalOperationRef?: ExternalOperation
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
  bindings: EvidenceBinding[]
  goalRef?: GoalRef
  certificationDigest: string
  result: 'certified' | 'incomplete' | 'unknown'
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
  epoch: number
  contractRevision: number
  rebindProposals: Map<string, import('./rebind.js').RebindProposal>
  items: Map<string, GuardItem>
  evidence: Map<string, GuardEvidence>
  checkpoints: GuardCheckpoint[]
  boundaries: GuardBoundary[]
  externalOperations: Map<string, ExternalOperation>
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
  /** Log-derived count of rejected rebind attempts by stable attempt key; survives reload. */
  rebindRejections: Map<string, number>
  integrity: GuardIntegrity
}

export function createProjection(): GuardProjection {
  return {
    enabled: false,
    epoch: 0,
    contractRevision: 0,
    rebindProposals: new Map(),
    items: new Map(),
    evidence: new Map(),
    checkpoints: [],
    boundaries: [],
    externalOperations: new Map(),
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
}

export interface DerivedEnvelope {
  seq: number
  type: string
  data?: unknown
}
