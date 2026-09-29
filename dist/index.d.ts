import { $ as PROOF_MANIFEST_DOMAIN_V2, $a as WorkUnit, $i as extractOperation, $n as canonicalArgvFromCommand, $o as hasOrderedCoordination, $r as HostCohortSelectionReason, $s as digestStrings, $t as HostProfileError, A as V4SessionLike, Aa as GuardBoundary, Ai as AuthorityKind, An as GitAdapterAction, Ao as admissibleForRemoval, Ar as PROTOCOL_V6_NOTICE, As as ActionManifest, At as validateProofManifestV2, B as V6_ORDINARY_COMPLETION_RULE_COMPACT, Ba as MessageCoverage, Bi as parseConfirmationMessage, Bn as LinearCommitReadback, Bo as GRANTED_QUALIFICATION, Br as DEFAULT_HOST_LOCK, Bs as SemanticAction, Bt as validateManifest, C as observeAssistantOutcome, Ca as EvidenceBinding, Ci as compareHostVersions, Cn as acquireHostTrust, Co as DerivedProcessFacts, Cr as nativeFileTwoRole, Cs as restatedContentOf, Ct as proofOperationMatches, D as SESSION_API_UNSUPPORTED, Da as ExpectedTransition, Di as currentContractDigest, Dn as registryArchiveModules, Do as ProcessOutcomeReason, Dr as PROTOCOL_V3_NOTICE, Ds as verbIsNegated, Dt as sessionQuery, E as v6TestPredicate, Ea as EvidenceRole, Ei as satisfiesSupportedHostRange, En as qualifyHostTrust, Eo as ProcessFactSource, Er as DEFAULT_DELEGATION_TOOL_NAMES, Es as statefulActionsOfScope, Et as scopeCoverageDigest, F as DEFAULT_RECOVERY_CHAR_BUDGET, Fa as GuardItemKind, Fi as classifyTaskIntent, Fn as GitEffectExecution, Fo as removalIsPartiallyKnown, Fr as ACTIVE_HOST_COHORT_ID, Fs as SEMANTIC_ACTIONS, Ft as isVerifyingCapability, G as openItems, Ga as TargetCaptureReasonCode, Gi as CaptureScope, Gn as gitCommandMatchesTarget, Go as ScopeInterpretation, Gr as HOST_CAPABILITY_PACKAGE_GROUPS, Gs as requestedIdentityKey, Gt as LifecyclePhase, H as carriesCleanupCondition, Ha as NeedsReviewReason, Hi as RejectedBinding, Hn as commitTreeSnapshotDigest, Ho as LEGACY_QUALIFICATION, Hr as ExecutableIdentity, Hs as actionCompatible, Ht as FIRST_STEP_GUIDANCE, I as MIN_RECOVERY_CHAR_BUDGET, Ia as GuardItemStatus, Ii as classifyUserInteraction, In as GitEffectRunner, Io as AuthorityDisposition, Ir as ACTIVE_HOST_COHORT_IDS, Is as STATEFUL_ACTIONS, It as COMMAND_SURFACE_MANIFEST, J as renderRecoveryPacket, Ja as TargetSourceKind, Ji as captureItem, Jn as verifiedLinearCommitReadback, Jo as clauseAsksOwnQuestion, Jr as HostCapabilityEvaluation, Js as semanticActionFromCommand, Jt as firstStepGuidanceV6, K as recoveryDigest, Ka as TargetCaptureStatus, Ki as ClauseSegment, Kn as parseGitCommandManifest, Ko as actionVerbMatches, Kr as HOST_COHORTS, Ks as requestedTargetAuthorizesMutation, Kt as claimedBatchHasRealRootInput, L as RecoveryCause, La as GuardOperation, Li as CONFIRM_LINE_PATTERN, Ln as GitPrestateCheck, Lo as DirectiveClass, Lr as ACTIVE_HOST_LAUNCHER_VERSION, Ls as STOP_PROTOCOL_VERSION, Lt as CommandSurfaceManifest, M as CLEANUP_CONDITION_RULE, Ma as GuardEvidence, Mi as segmentAuthorityBlocks, Mn as GitCommandManifest, Mo as capabilityFactOf, Mr as deriveProjection, Ms as BOUNDED_ARTIFACT_TYPES, Mt as bindingSatisfies, N as CLEANUP_CONDITION_RULE_COMPACT, Na as GuardIntegrity, Ni as TaskIntent, Nn as GitCommandParseResult, No as partialFailureOf, Nr as legacyRecordsNeedingReview, Ns as CERTIFICATE_VERSION, Nt as evidenceCoverage, O as SESSION_EVENT_ENVELOPE_INVALID, Oa as ExternalOperation, Oi as AuthorityBlock, On as GIT_COMMAND_MANIFEST_IDS, Oo as RemovalOutcomeReport, Or as PROTOCOL_V4_NOTICE, Os as ACTION_MANIFEST, Ot as sessionQueryV2, P as CLEANUP_CONDITION_RULE_SHORT, Pa as GuardItem, Pi as UserInteractionKind, Pn as GitCommandRejected, Po as removalIsComplete, Pr as rootLocatorFlavor, Ps as CERTIFICATE_VERSION_V2, Pt as evidenceMatchesItem, Q as PROOF_KINDS_V2, Qa as WaitAuthorization, Qi as extractMethod, Qn as ShellParseStatus, Qo as governedClauseRestrictsExecution, Qr as HostCohortSelection, Qs as canonicalizePath, Qt as AuditedPackageExpectation, R as RecoveryOptions, Ra as GuardProjection, Ri as ParsedConfirmation, Rn as GitPrestateEnvelope, Ro as Executee, Rr as AuditedExecutable, Rs as STOP_PROTOCOL_VERSION_V2, Rt as ManifestIssue, S as latestRootInstruction, Sa as DerivedEnvelope, Si as SUPPORTED_HOST_VERSIONS, Sn as HostTrustedPackage, So as DependencyStatus, Sr as itemDiagnosis, Ss as reportingHeadGoverns, St as proofHostSurfacesOf, T as testOutcomePredicate, Ta as EvidenceParseStatus, Ti as parseHostVersion, Tn as parseHostTrust, To as ProcessExitStatus, Tr as CAPTURE_V042_NOTICE, Ts as splitTextFragments, Tt as requiredSubjectsOf, U as cleanupConditionFor, Ua as PersistenceAuthorization, Ui as bindingIndividuallyAccepted, Un as createGitPrestateEnvelope, Uo as QualificationReason, Ur as ExecutableIdentityBinding, Us as boundedArtifactChoiceMatches, Ut as FirstStepInjection, V as V6_ORDINARY_COMPLETION_RULE_SHORT, Va as NeedsReviewFact, Vi as CheckpointResult, Vn as commitIndexSnapshotDigest, Vo as InterpretOptions, Vr as EXPECTED_HOST_PACKAGES, Vs as StatefulAction, Vt as ClaimedMessage, W as closingHint, Wa as SourceSpan, Wi as certifyCheckpoint, Wn as executeRevalidatedGitEffect, Wo as QualificationStatus, Wr as GOAL_HOST_PACKAGES, Ws as isStatefulAction, Wt as FirstStepPreviewInput, X as PROOF_CAPABILITY_MATRIX, Xa as TargetValue, Xi as environmentDefaultRepositoryTarget, Xn as CanonicalCommandSurface, Xo as clauseIsProtected, Xr as HostCapabilityRequest, Xs as validateActionManifest, Xt as previewFirstStepInjection, Y as v6CurrentRootBoundaries, Ya as TargetTuple, Yi as classifyClause, Yn as CanonicalArgv, Yo as clauseIsGoverned, Yr as HostCapabilityId, Ys as semanticActionFromText, Yt as lifecyclePhase, Z as PROOF_KINDS, Za as VerificationContract, Zi as extractArtifactPaths, Zn as ParsedShell, Zo as explanationHasActionResidue, Zr as HostCohort, Zs as validateActionTarget, Zt as ActiveProfileHostLock, _ as decideTurnStopping, _a as DeferAuthorization, _i as HostVersionStatus, _n as resolveActiveProfileHostLock, _o as CapabilityFact, _r as TaskKind, _s as opensConditionLead, _t as createProofManifestV2, a as AssistantOutcomeObservation, aa as BoundaryRequest, ai as HostToolSurface, an as auditedHostImplementation, ao as ReleaseSettlement, ar as ToolCallInput, as as isExecutableItem, at as ProofKindV2, b as isWholeTaskCompletionClaim, ba as DeriveResult, bi as ParsedHostVersion, bn as HostRebindTrust, bo as DEPENDENCY_FREE_ONLY_CONDITION, br as deriveItemDiagnosis, bs as qualificationOfClause, bt as proofDigestV2, c as CurrentActionBasis, ca as availableBoundaryQualifications, ci as evaluateExternalWaitCapability, cn as evaluateConfiguredHostLock, co as RebindArgs, cr as evidenceFromPersistedToolResult, cs as isOpenObligation, ct as ProofObligation, d as TurnStoppingDecision, da as qualifyBoundary, di as evaluateHostLock, dn as injectActiveProfileHostLock, do as proposeRebind, dr as isDeterministicCheck, ds as itemHoldsExecutionAuthority, dt as SessionQuery, ea as isInformationalMessage, ec as normalizeClause, ei as HostLockContext, en as TargetHostGraph, eo as createProjection, er as isRunExecutable, es as hasQuestionScope, et as PROOF_PROTOCOL_VERSION, f as assessmentAction, fa as AssetInterpretationFact, fi as evaluateToolSurfaceCapability, fn as inspectTargetHostGraph, fo as proposeRebindOutcome, fr as persistedToolResultStatus, fs as kindOfScope, ft as SessionQueryV2, g as decideTurnBoundary, ga as BoundaryQualificationKind, gi as HostVersionDecision, gn as readActiveHostGraph, go as replayRebindResult, gr as Repairability, gs as namedActions, gt as createProofManifest, h as currentActionBases, ha as BoundaryDisposition, hi as HOST_VALIDATED_VERSIONS, hn as prepareActiveHostTrust, ho as rebindResponse, hr as DiagnosisNextAction, hs as maskQuotedSpans, ht as canonicalProjection, i as supersedeItem, ia as BoundaryQualification, ii as HostProfileKind, in as auditedForegroundRenderers, io as ReleaseOperation, ir as hasCurrentCertificate, is as introducesActionClause, it as ProofKindCapability, j as snapshotSessionEvents, ja as GuardCheckpoint, ji as authorityCaptureCounts, jn as GitCommandAccepted, jo as capabilityConsequence, jr as applyUpgradeEligibility, js as ActionSpec, jt as EvidenceFacetCoverage, k as SessionApiError, ka as GoalRef, ki as AuthorityBlockKind, kn as GIT_COMMAND_TEMPLATES, ko as actionHasCertificationPath, kr as PROTOCOL_V5_NOTICE, ks as ACTION_MANIFEST_VERSION, kt as validateProofManifest, l as NO_PROGRESS_RECORD_PREFIX, la as effectuateBoundary, li as evaluateGraphDerivedHostLock, ln as hostLockContextFromComposedDump, lo as RebindProposal, lr as extractTextContent, ls as isQuestionScopeNeedingReview, lt as ProofObligationV2, m as classifyCompletionClaim, ma as BindingActionClosure, mi as selectHostCohort, mn as packageRowsFromPnpmLock, mo as rebindAttemptKey, mr as CertificationSupport, ms as maskCodeSpans, mt as bindProofV2ToProjection, n as projectSessionCoreV2, na as BOUNDARY_RECORD_PREFIX, nc as sanitizeUrl, ni as HostLockStatus, nn as auditedDefaultWorkdirHost, no as ReleaseGateDecision, nr as parseShellCommand, ns as interpretClause, nt as ProofHostSurface, o as CONTROL_RECORD_PREFIX, oa as GoalActivationState, oi as bindExecutableIdentity, on as combineHostPolicy, oo as BoundedSource, or as ToolResultInput, os as isExplanationScope, ot as ProofManifest, p as assessmentOutcomePredicate, pa as AssetObligation, pi as hostVersionFromPackages, pn as packageRowsFromActiveGraph, po as proposeRebindV042, pr as withDurability, ps as legacyQuestionReadingIsInformational, pt as bindProofToProjection, q as recoveryTitle, qa as TargetSource, qi as captureClause, qn as revalidateGitPrestate, qo as clarifiedSpanOf, qr as HostAuditProvenance, qs as requestedTargetMatchesResolved, qt as firstStepGuidance, r as projectCoreV2, ra as BoundaryEffectuation, rc as sha256, ri as HostPlatform, rn as auditedDefaultWorkdirProvider, ro as ReleaseObservedIdentity, rr as goalCompletionDenial, rs as interpretMessage, rt as ProofKind, s as CompletionDisposition, sa as GoalBoundaryAccess, si as bindLiveGoalCapability, sn as evaluateActiveHostLock, so as ProposeOutcome, sr as ToolSubject, ss as isInformationalFragment, st as ProofManifestV2, t as RC020_RC1_HOST_PACKAGES, ta as segmentClauses, tc as sanitizeClauseText, ti as HostLockEvaluation, tn as activeRendererModule, to as PackageRow, tr as parsePwshCommand, ts as hasWorkPredicate, tt as PROOF_PROTOCOL_VERSION_V2, u as NO_PROGRESS_TURNS_BEFORE_STOP, ua as isCurrentAcceptedBoundary, ui as evaluateHostCapability, un as hostLockRowsFromComposedDump, uo as confirmRebind, ur as extractToolSubject, us as isRestatement, ut as ProofSurface, v as decisionBoundaryKey, va as DelegationRef, vi as LATEST_TESTED_HOST_VERSION, vn as resolveInstalledHostLock, vo as CapabilityGap, vr as UnifiedItemDiagnosis, vs as opensWithDirective, vt as proofCapabilityReport, w as progressFingerprint, wa as EvidenceOutcome, wi as evaluateMinimumHostVersion, wn as hostTrustDigest, wo as OperationAttribution, wr as relevantEvidence, ws as semanticActionOfScope, wt as proofV2Rejection, x as latestAssistantText, xa as DeriveScope, xi as SUPPORTED_HOST_RANGE, xn as HostTrustError, xo as DeclaredOperationResult, xr as evidenceAvailabilityReason, xs as questionHeadsClause, xt as proofEvidenceConstraints, y as isRootPauseRequest, ya as DeriveConfig, yi as MIN_SUPPORTED_HOST_VERSION, yn as verifyComposedHostLockDump, yo as CapabilityRemedy, yr as capabilityRemedyPhrase, ys as presentExplanationHead, yt as proofDigest, z as V6_ORDINARY_COMPLETION_RULE, za as HostStatus, zi as isFrozenV042RebindResponse, zn as GitTargetIdentity, zo as ExecutionQualification, zr as BASE_HOST_PACKAGES, zs as SUPPORTED_EVIDENCE_ADAPTERS, zt as OperationVerbEntry } from "./index-ul2SlrX1.js";
import "@deepseek-ai/dsh-llm";
import "@deepseek-ai/dsh-tools";
import { Session } from "@deepseek-ai/dsh-session";
import { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

//#region src/message-source.d.ts
declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "context-guard": {
      readonly kind: "context-guard";
      readonly plugin: "context-guard";
      readonly form: "notice";
      readonly summary: string;
    };
  }
}
//#endregion
//#region src/tools/evidence.d.ts
/** Trusted embedding evidence, never accepted from a model/tool or HTTP response.
* The embedding must bind its actual loaded provider to this process/service.
* Current DSH hosts expose no such verifier, so production restart stays
* unavailable while core Guard protection remains active.
*/
interface MarketInstanceBinding {
  origin: string;
  profile: string;
  version: string;
  integrity: string;
  loadedTreeSha256: string;
  processIdentity: string;
  bootId: string;
}
interface EvidenceToolRoots {
  /** Test/embedding override. Production derives the active profile from this installed module. */
  profile?: {
    name: string;
    path: string;
  };
  /** Derived from the live loopback webServer service; never accepted from tool input. */
  marketOrigin?: string;
  verifyMarketInstance?: (signal: AbortSignal) => Promise<MarketInstanceBinding | undefined>;
  /** Test seam for exact HTTP request/response contracts. */
  fetcher?: typeof fetch;
  /** Test seam for exact logical executable/argv execution. */
  commandRunner?: (file: string, args: string[], cwd?: string, signal?: AbortSignal) => Promise<void>;
  persistRestartIntent?: (agent: {
    session: unknown;
  }, intent: {
    resolutionCallId: string;
    serviceId: string;
    preGeneration: string;
  }) => Promise<boolean>;
  hasRestartIntent?: (resolutionCallId: string, serviceId: string, preGeneration: string) => boolean;
  /** Runtime-supplied, action-scoped host capability decision. */
  hostCapability?: (action: StatefulAction) => {
    status: "supported" | "unsupported" | "unavailable";
    digest: string;
  };
  /** Runtime-owned root-contract authorization. Absence is fail-closed. */
  authorizeMutation?: (request: MutationAuthorizationRequest) => MutationAuthorizationDecision;
  /** Flush and replay the resolution/contract chain before any side effect. */
  prepareMutation?: (agent: {
    session: unknown;
  }) => Promise<boolean>;
  /** Test seam for proving that durability/authority rejection precedes probes. */
  readExecutableIdentity?: (executable: AuditedExecutable, signal: AbortSignal) => Promise<ExecutableIdentity | undefined>;
  /** Test-only seam; production never enables HTTP registries. */
  allowLoopbackHttpRegistry?: boolean;
  /**
  * C10 release ticket gate, consulted before any release-class effect. Absent
  * means no release contract governs the session, so the existing Guard-owned
  * mutation authorization is the whole authority chain.
  */
  releaseGate?: (request: ReleaseGateToolRequest) => Promise<ReleaseGateDecision>;
  /**
  * The FINAL fresh host judgment of an action entry. Called after the
  * effect's own last await and immediately before the effect starts, with no
  * yield in between; `false` refuses the effect fail-closed. A pre-await
  * audit can therefore never authorize a post-await effect.
  */
  preEffectVeto?: () => boolean;
  /** C10 settlement record, written after the effect from a trusted readback. */
  releaseSettle?: (request: ReleaseSettlementToolRequest) => Promise<void>;
}
interface ReleaseGateToolRequest {
  agent: {
    session: unknown;
  };
  operation: ReleaseOperation;
  /** The resolution call the effect is bound to; the replay key. */
  callId: string;
  resolvedTarget: TargetTuple;
  /** What the trusted producers actually observed for this candidate. */
  observed: ReleaseObservedIdentity;
}
/**
* The outcome the executor can prove, before the runtime decides how it
* resolves the reservation:
* - `not_effected` — every pre-effect check refused, so no side effect ran;
* - `unknown` — the effect was attempted and its result cannot be established;
* - `completed` — the effect reported success (the runtime still compares the
*   readback identity before it settles anything).
*/
interface ReleaseSettlementToolRequest {
  agent: {
    session: unknown;
  };
  operation: ReleaseOperation;
  callId: string;
  /** The contract the granted reservation belonged to. */
  contractId?: string;
  effect: "completed" | "not_effected" | "unknown";
  readback: ReleaseSettlement["readback"];
}
interface MutationAuthorizationRequest {
  action: StatefulAction;
  contractItemId: string;
  contractItemRevision: number;
  resolvedTarget: TargetTuple;
}
interface MutationAuthorizationDecision {
  status: "authorized" | "denied";
  reasonCode: string;
}
//#endregion
//#region src/config.d.ts
declare const Config: z<{
  activation: string;
  policy?: string;
  hostLockPackages?: PackageRow[];
  hostLockPlatform?: HostPlatform;
  hostLockProfile?: HostProfileKind;
  hostLockPolicy?: string;
  hostLockRuntimeRoot?: string;
  hostLockProfileRoot?: string;
  hostLockTrust?: string;
}>;
//#endregion
//#region src/runtime.d.ts
declare const name = "context-guard";
declare const inject: readonly ["sessions", "commands", "fs"];
/**
* Executor and network seams for acceptance runs. They replace ONLY the two
* things a deterministic test cannot do for real — spawning the mutation
* binary and reaching the registry — and never the authorization gate, the
* reservation/settlement records, or the evidence producers. Production
* callers omit them and get the real implementations.
*/
interface RuntimeExecutorSeams {
  commandRunner?: EvidenceToolRoots["commandRunner"];
  fetcher?: EvidenceToolRoots["fetcher"];
  /** Isolated acceptance override for the executable-identity reader. */
  readExecutableIdentity?: EvidenceToolRoots["readExecutableIdentity"];
  allowLoopbackHttpRegistry?: boolean;
  /**
  * Pin the audited host cohort instead of reading a live profile graph. An
  * acceptance run that already declared its cohort needs this because the
  * migration revalidation reads real filesystem roots; it replaces ONLY the
  * host-lock EVALUATION. The release ticket gate, the reservation and
  * settlement records, the evidence producers and the replay stay production
  * code, and the host lock keeps its own dedicated suites and native
  * acceptance.
  */
  hostLock?: HostLockEvaluation;
  /** Isolated acceptance override for the provider-invisible durable ledger. */
  privateLedgerRoot?: string;
  /**
  * Invoked once per full host-lock validation the runtime actually performs —
  * the attach-time validation and every security-sensitive entry's fresh
  * validation. It observes; it never replaces the audit. Production callers
  * omit it, so deterministic tests and acceptance harnesses can count full
  * validations without instrumenting the filesystem.
  */
  onHostLockValidation?: () => void;
}
declare function apply(ctx: Context, rawConfig?: {
  activation?: unknown;
  hostLockPackages?: unknown;
  hostLockPlatform?: unknown;
  hostLockProfile?: unknown;
  hostLockPolicy?: unknown;
  hostLockRuntimeRoot?: unknown;
  hostLockProfileRoot?: unknown;
  hostLockTrust?: unknown;
}, seams?: RuntimeExecutorSeams): void;
//#endregion
//#region src/raw-replay.d.ts
interface RawReplayInput {
  root: string;
  final: string;
  cwd?: string;
  /** Synthetic host events, in persisted order; only for local replay. */
  events?: Array<{
    type: string;
    data: unknown;
  }>;
}
/** Local synthetic replay using the actual Session, derivation and registered
* Stop handler. It neither executes tools nor asserts a real model outcome. */
declare function replayRawV2(input: RawReplayInput): Promise<Record<string, unknown>>;
//#endregion
export { ACTION_MANIFEST, ACTION_MANIFEST_VERSION, ACTIVE_HOST_COHORT_ID, ACTIVE_HOST_COHORT_IDS, ACTIVE_HOST_LAUNCHER_VERSION, ActionManifest, ActionSpec, ActiveProfileHostLock, AssetInterpretationFact, AssetObligation, AssistantOutcomeObservation, AuditedExecutable, AuditedPackageExpectation, AuthorityBlock, AuthorityBlockKind, AuthorityDisposition, AuthorityKind, BASE_HOST_PACKAGES, BOUNDARY_RECORD_PREFIX, BOUNDED_ARTIFACT_TYPES, BindingActionClosure, BoundaryDisposition, BoundaryEffectuation, BoundaryQualification, BoundaryQualificationKind, BoundaryRequest, BoundedSource, CAPTURE_V042_NOTICE, CERTIFICATE_VERSION, CERTIFICATE_VERSION_V2, CLEANUP_CONDITION_RULE, CLEANUP_CONDITION_RULE_COMPACT, CLEANUP_CONDITION_RULE_SHORT, COMMAND_SURFACE_MANIFEST, CONFIRM_LINE_PATTERN, CONTROL_RECORD_PREFIX, CanonicalArgv, CanonicalCommandSurface, CapabilityFact, CapabilityGap, CapabilityRemedy, CaptureScope, CertificationSupport, CheckpointResult, ClaimedMessage, ClauseSegment, CommandSurfaceManifest, CompletionDisposition, Config, CurrentActionBasis, DEFAULT_DELEGATION_TOOL_NAMES, DEFAULT_HOST_LOCK, DEFAULT_RECOVERY_CHAR_BUDGET, DEPENDENCY_FREE_ONLY_CONDITION, DeclaredOperationResult, DeferAuthorization, DelegationRef, DependencyStatus, DeriveConfig, DeriveResult, DeriveScope, DerivedEnvelope, DerivedProcessFacts, DiagnosisNextAction, DirectiveClass, EXPECTED_HOST_PACKAGES, EvidenceBinding, EvidenceFacetCoverage, EvidenceOutcome, EvidenceParseStatus, EvidenceRole, ExecutableIdentity, ExecutableIdentityBinding, Executee, ExecutionQualification, ExpectedTransition, ExternalOperation, FIRST_STEP_GUIDANCE, FirstStepInjection, FirstStepPreviewInput, GIT_COMMAND_MANIFEST_IDS, GIT_COMMAND_TEMPLATES, GOAL_HOST_PACKAGES, GRANTED_QUALIFICATION, GitAdapterAction, GitCommandAccepted, GitCommandManifest, GitCommandParseResult, GitCommandRejected, GitEffectExecution, GitEffectRunner, GitPrestateCheck, GitPrestateEnvelope, GitTargetIdentity, GoalActivationState, GoalBoundaryAccess, GoalRef, GuardBoundary, GuardCheckpoint, GuardEvidence, GuardIntegrity, GuardItem, GuardItemKind, GuardItemStatus, GuardOperation, GuardProjection, HOST_CAPABILITY_PACKAGE_GROUPS, HOST_COHORTS, HOST_VALIDATED_VERSIONS, HostAuditProvenance, HostCapabilityEvaluation, HostCapabilityId, HostCapabilityRequest, HostCohort, HostCohortSelection, HostCohortSelectionReason, HostLockContext, HostLockEvaluation, HostLockStatus, HostPlatform, HostProfileError, HostProfileKind, HostRebindTrust, HostStatus, HostToolSurface, HostTrustError, HostTrustedPackage, HostVersionDecision, HostVersionStatus, InterpretOptions, LATEST_TESTED_HOST_VERSION, LEGACY_QUALIFICATION, LifecyclePhase, LinearCommitReadback, MIN_RECOVERY_CHAR_BUDGET, MIN_SUPPORTED_HOST_VERSION, ManifestIssue, MessageCoverage, NO_PROGRESS_RECORD_PREFIX, NO_PROGRESS_TURNS_BEFORE_STOP, NeedsReviewFact, NeedsReviewReason, OperationAttribution, OperationVerbEntry, PROOF_CAPABILITY_MATRIX, PROOF_KINDS, PROOF_KINDS_V2, PROOF_MANIFEST_DOMAIN_V2, PROOF_PROTOCOL_VERSION, PROOF_PROTOCOL_VERSION_V2, PROTOCOL_V3_NOTICE, PROTOCOL_V4_NOTICE, PROTOCOL_V5_NOTICE, PROTOCOL_V6_NOTICE, ParsedConfirmation, ParsedHostVersion, ParsedShell, PersistenceAuthorization, ProcessExitStatus, ProcessFactSource, ProcessOutcomeReason, ProofHostSurface, ProofKind, ProofKindCapability, ProofKindV2, ProofManifest, ProofManifestV2, ProofObligation, ProofObligationV2, ProofSurface, ProposeOutcome, QualificationReason, QualificationStatus, RC020_RC1_HOST_PACKAGES, RebindArgs, RebindProposal, RecoveryCause, RecoveryOptions, RejectedBinding, RemovalOutcomeReport, Repairability, SEMANTIC_ACTIONS, SESSION_API_UNSUPPORTED, SESSION_EVENT_ENVELOPE_INVALID, STATEFUL_ACTIONS, STOP_PROTOCOL_VERSION, STOP_PROTOCOL_VERSION_V2, SUPPORTED_EVIDENCE_ADAPTERS, SUPPORTED_HOST_RANGE, SUPPORTED_HOST_VERSIONS, ScopeInterpretation, SemanticAction, SessionApiError, SessionQuery, SessionQueryV2, ShellParseStatus, SourceSpan, StatefulAction, TargetCaptureReasonCode, TargetCaptureStatus, TargetHostGraph, TargetSource, TargetSourceKind, TargetTuple, TargetValue, TaskIntent, TaskKind, ToolCallInput, ToolResultInput, ToolSubject, TurnStoppingDecision, UnifiedItemDiagnosis, UserInteractionKind, V4SessionLike, V6_ORDINARY_COMPLETION_RULE, V6_ORDINARY_COMPLETION_RULE_COMPACT, V6_ORDINARY_COMPLETION_RULE_SHORT, VerificationContract, WaitAuthorization, WorkUnit, acquireHostTrust, actionCompatible, actionHasCertificationPath, actionVerbMatches, activeRendererModule, admissibleForRemoval, apply, applyUpgradeEligibility, assessmentAction, assessmentOutcomePredicate, auditedDefaultWorkdirHost, auditedDefaultWorkdirProvider, auditedForegroundRenderers, auditedHostImplementation, authorityCaptureCounts, availableBoundaryQualifications, bindExecutableIdentity, bindLiveGoalCapability, bindProofToProjection, bindProofV2ToProjection, bindingIndividuallyAccepted, bindingSatisfies, boundedArtifactChoiceMatches, canonicalArgvFromCommand, canonicalProjection, canonicalizePath, capabilityConsequence, capabilityFactOf, capabilityRemedyPhrase, captureClause, captureItem, carriesCleanupCondition, certifyCheckpoint, claimedBatchHasRealRootInput, clarifiedSpanOf, classifyClause, classifyCompletionClaim, classifyTaskIntent, classifyUserInteraction, clauseAsksOwnQuestion, clauseIsGoverned, clauseIsProtected, cleanupConditionFor, closingHint, combineHostPolicy, commitIndexSnapshotDigest, commitTreeSnapshotDigest, compareHostVersions, confirmRebind, createGitPrestateEnvelope, createProjection, createProofManifest, createProofManifestV2, currentActionBases, currentContractDigest, decideTurnBoundary, decideTurnStopping, decisionBoundaryKey, deriveItemDiagnosis, deriveProjection, digestStrings, effectuateBoundary, environmentDefaultRepositoryTarget, evaluateActiveHostLock, evaluateConfiguredHostLock, evaluateExternalWaitCapability, evaluateGraphDerivedHostLock, evaluateHostCapability, evaluateHostLock, evaluateMinimumHostVersion, evaluateToolSurfaceCapability, evidenceAvailabilityReason, evidenceCoverage, evidenceFromPersistedToolResult, evidenceMatchesItem, executeRevalidatedGitEffect, explanationHasActionResidue, extractArtifactPaths, extractMethod, extractOperation, extractTextContent, extractToolSubject, firstStepGuidance, firstStepGuidanceV6, gitCommandMatchesTarget, goalCompletionDenial, governedClauseRestrictsExecution, hasCurrentCertificate, hasOrderedCoordination, hasQuestionScope, hasWorkPredicate, hostLockContextFromComposedDump, hostLockRowsFromComposedDump, hostTrustDigest, hostVersionFromPackages, inject, injectActiveProfileHostLock, inspectTargetHostGraph, interpretClause, interpretMessage, introducesActionClause, isCurrentAcceptedBoundary, isDeterministicCheck, isExecutableItem, isExplanationScope, isFrozenV042RebindResponse, isInformationalFragment, isInformationalMessage, isOpenObligation, isQuestionScopeNeedingReview, isRestatement, isRootPauseRequest, isRunExecutable, isStatefulAction, isVerifyingCapability, isWholeTaskCompletionClaim, itemDiagnosis, itemHoldsExecutionAuthority, kindOfScope, latestAssistantText, latestRootInstruction, legacyQuestionReadingIsInformational, legacyRecordsNeedingReview, lifecyclePhase, maskCodeSpans, maskQuotedSpans, name, namedActions, nativeFileTwoRole, normalizeClause, observeAssistantOutcome, openItems, opensConditionLead, opensWithDirective, packageRowsFromActiveGraph, packageRowsFromPnpmLock, parseConfirmationMessage, parseGitCommandManifest, parseHostTrust, parseHostVersion, parsePwshCommand, parseShellCommand, partialFailureOf, persistedToolResultStatus, prepareActiveHostTrust, presentExplanationHead, previewFirstStepInjection, progressFingerprint, projectCoreV2, projectSessionCoreV2, proofCapabilityReport, proofDigest, proofDigestV2, proofEvidenceConstraints, proofHostSurfacesOf, proofOperationMatches, proofV2Rejection, proposeRebind, proposeRebindOutcome, proposeRebindV042, qualificationOfClause, qualifyBoundary, qualifyHostTrust, questionHeadsClause, readActiveHostGraph, rebindAttemptKey, rebindResponse, recoveryDigest, recoveryTitle, registryArchiveModules, relevantEvidence, removalIsComplete, removalIsPartiallyKnown, renderRecoveryPacket, replayRawV2, replayRebindResult, reportingHeadGoverns, requestedIdentityKey, requestedTargetAuthorizesMutation, requestedTargetMatchesResolved, requiredSubjectsOf, resolveActiveProfileHostLock, resolveInstalledHostLock, restatedContentOf, revalidateGitPrestate, rootLocatorFlavor, sanitizeClauseText, sanitizeUrl, satisfiesSupportedHostRange, scopeCoverageDigest, segmentAuthorityBlocks, segmentClauses, selectHostCohort, semanticActionFromCommand, semanticActionFromText, semanticActionOfScope, sessionQuery, sessionQueryV2, sha256, snapshotSessionEvents, splitTextFragments, statefulActionsOfScope, supersedeItem, testOutcomePredicate, v6CurrentRootBoundaries, v6TestPredicate, validateActionManifest, validateActionTarget, validateManifest, validateProofManifest, validateProofManifestV2, verbIsNegated, verifiedLinearCommitReadback, verifyComposedHostLockDump, withDurability };