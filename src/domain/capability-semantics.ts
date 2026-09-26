import { ACTION_MANIFEST, isStatefulAction, type SemanticAction } from './protocol-manifest.js'
import type { GuardItem } from './types.js'

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
export type CapabilityGap =
  /** A reachable certification path exists; required facts are still missing. */
  | 'none'
  /** The obligation is already closed by its own rule (certified/answered). */
  | 'closed'
  /** A standing constraint to enforce, never a completion obligation. */
  | 'constraint'
  /** The clause could not be read as a concrete instruction at all. */
  | 'interpretation_unknown'
  /** The clause names a concrete action, but the installed cohort has no
   * certification adapter for it (this is the W061-01 cleanup case). */
  | 'missing_adapter'
  /** The action is certifiable but a caller-ownable identity was not named. */
  | 'target_missing'
  /** Several candidate targets exist and the root must select one. No reachable
   * lane currently produces this: capture either resolves a target or records
   * the exact missing field, and clause ambiguity is split into separate
   * obligations. It stays in the taxonomy so a future selection lane must
   * declare itself instead of being inferred from a generic reason code. */
  | 'input_ambiguous'
  /** A pre-v5 item whose certification path only its own migration replaces. */
  | 'legacy_migration_required'
  /** The audited host cohort itself is unavailable. */
  | 'host_unavailable'
  /** An effect or observation exists but its required pre-evidence is gone. */
  | 'historical_preevidence_missing'
  /** A shell result cannot be attributed to the obligation's operation. */
  | 'operation_unattributable'
  /** A declared condition or wait has not been released. */
  | 'condition_pending'
  /** An information obligation closes only through trusted delivery. */
  | 'delivery_pending'

/** The reachable remedy for one gap. `remedy` is the machine-readable form of
 * `next_action`; the two are produced together so they cannot disagree. */
export type CapabilityRemedy =
  /** Nothing to do; the item is closed or is a standing constraint. */
  | 'none'
  /** Record the remaining durable facts and checkpoint. */
  | 'collect_evidence'
  /** The root must name an identity only it can choose, then work resumes. */
  | 'supply_target'
  /** A trusted root input (or its release) is pending; keep the item open. */
  | 'await_root_input'
  /** Deliver the actual answer; a completed turn's trusted response closes it. */
  | 'deliver_answer'
  /** Read the attachment, record the interpretation, then answer. */
  | 'record_interpretation'
  /** Keep the recorded statement visible; it is never certified. */
  | 'report_uncertified'
  /** 0.6.2 D062-01 review: this build has no certification adapter for the
   * action the root actually named. Report the observable result and keep the
   * obligation uncertified. This is deliberately NOT `fresh_root_instruction`:
   * nothing about the user's instruction is missing, and the guard must not
   * carry a machine-readable request for a new instruction when the gap is its
   * own capability. */
  | 'report_uncertified_capability_gap'
  /** Re-establish the audited host cohort. */
  | 'restore_host'
  /** Re-read the current state; never repeat the action to mint evidence. */
  | 'readback_only'
  /** A fresh explicit root instruction (plus its confirmation where the
   * migration path requires one) is the only thing that supersedes it. */
  | 'fresh_root_instruction'

export interface CapabilityFact {
  /**
   * Whether this obligation's OWN action belongs to the certification action
   * set in the installed cohort. It is deliberately independent of
   * authorization: `false` says the build has no such capability, NEVER that
   * the user did not authorize the work, and NEVER that the work may not be
   * done. A `generic_run` obligation has no concrete action to support.
   */
  actionSupported: boolean
  /** A durable certification path exists for this item's own contract. */
  certifiable: boolean
  gap: CapabilityGap
  remedy: CapabilityRemedy
  /** Reason codes that describe the evidence chain, never new authority. */
  blockingReasonCodes: string[]
}

/**
 * Whether the item's obligation has a certification path in this cohort at
 * all. A generic_run item names no concrete action: the manifest still has a
 * generic entry (the guard may run and observe ordinary commands) but no
 * user-level completion contract can be certified from it, so the item is
 * uncertifiable while ordinary execution remains entirely permitted.
 */
export function actionHasCertificationPath(action: SemanticAction, legacyMigration: boolean): boolean {
  if (legacyMigration) return false
  if (action === 'generic_run') return false
  if (!isStatefulAction(action)) return true
  return ACTION_MANIFEST.actions[action].evidenceProducer === 'supported'
}

/** The capability classification of an item's own obligation contract. */
export function capabilityFactOf(item: GuardItem): CapabilityFact {
  const action = item.semanticAction ?? 'generic_run'
  const legacyMigration = (item.legacyFlags?.length ?? 0) > 0
  const certifiable = actionHasCertificationPath(action, legacyMigration)
  if (item.kind === 'prohibition') {
    return { actionSupported: false, certifiable: false, gap: 'constraint', remedy: 'none', blockingReasonCodes: [] }
  }
  if (!certifiable) {
    return {
      // Support is about the ACTION, not about certification: a pre-0.5 item
      // that names a concrete action is a supported action reached through its
      // own migration lane, while `generic_run` names no action at all.
      actionSupported: action !== 'generic_run',
      certifiable: false,
      gap: legacyMigration ? 'legacy_migration_required' : 'missing_adapter',
      // A pre-0.5 item genuinely needs a fresh instruction to reach its
      // migration lane; a current item that names an uncertifiable action does
      // not — its instruction is complete, only the capability is absent.
      remedy: legacyMigration ? 'fresh_root_instruction' : 'report_uncertified_capability_gap',
      blockingReasonCodes: [],
    }
  }
  return { actionSupported: true, certifiable: true, gap: 'none', remedy: 'collect_evidence', blockingReasonCodes: [] }
}

/* ------------------------------------------------------------------------- *
 * D062-02: layered shell completion facts
 * ------------------------------------------------------------------------- */

/**
 * What the console itself declared about the process. `declaredExitCode` is
 * `'unknown'` unless a real marker or a structured host fact said otherwise:
 * a host tool call that was not marked as an error is NOT a read exit code.
 */
export type ProcessExitStatus = number | 'unknown'

/**
 * Why `outcome` says what it says, so a display or a consumer never reads more
 * than the source supports.
 */
export type ProcessOutcomeReason =
  /** An explicit terminal marker declared the exit status. */
  | 'declared_exit_code'
  /** An explicit negative terminal marker (signal/timeout/sandbox/interrupt). */
  | 'declared_negative_marker'
  /** The host result itself carried the error flag. */
  | 'host_error_flag'
  /** A persisted return exists, but its nested status or call identity is ambiguous. */
  | 'host_result_untrusted'
  /** The audited session renderer appends markers only for negative facts, so
   * an unmarked completed foreground result is a clean success for that
   * renderer alone. */
  | 'unmarked_renderer_success'
  /** A marker this scanner cannot classify, or a renderer with no verified
   * contract: the process result stays unknown rather than being promoted. */
  | 'marker_unclassified'
  /** The call was backgrounded; its result is not a completion fact. */
  | 'backgrounded'
  /** The host retained only a lossy/truncated part of the process output. */
  | 'output_incomplete'
  /** Plain-text scanning without a structured terminal fact and without the
   * audited unmarked-renderer rule. */
  | 'text_scan_inconclusive'

/**
 * How far the console let the guard attribute effects to the obligation's own
 * operation. `unknown` is the honest answer for every opaque compound runner:
 * the last command's success never covers an earlier failure.
 */
export type OperationAttribution =
  /** One supported foreground command whose operation is attributable. */
  | 'single_operation'
  /** Several operations ran and the host declared a per-operation result. */
  | 'declared_per_operation'
  /** A compound/opaque script ran; no independent per-operation fact exists. */
  | 'unknown'

/** A credible per-operation subset the host itself declared. */
export interface DeclaredOperationResult {
  action: string
  outcome: 'success' | 'failure' | 'unknown'
}

/** Which source declared the terminal facts this reading is based on. */
export type ProcessFactSource = 'run_declaration' | 'structured_meta' | 'rendered_markers'

export interface DerivedProcessFacts {
  /** What the host tool call returned, before any interpretation. */
  hostToolReturned: 'result' | 'error'
  /** The console's own exit status, or `unknown` when never read. */
  declaredExitCode: ProcessExitStatus
  /** Whether an explicit terminal marker (positive or negative) was read. */
  terminalMarkerRead: boolean
  /** The outcome THIS LAYER derives from its own sources. It is deliberately a
   * separate value from the frozen evidence `outcome`: the frozen field keeps
   * the historical rule (0.6.1 and earlier read only `meta.exitCode` and the
   * rendered markers, never the run declaration), while this layer reads the
   * run declaration first. The two may therefore differ, and when they do the
   * difference is stated in `frozenOutcomeConflict` rather than hidden by
   * rewriting the historical field. */
  outcome: 'success' | 'failure' | 'unknown'
  /** Why this layer's outcome is what it is. */
  outcomeReason: ProcessOutcomeReason
  /** The highest-priority source that declared the facts used here. */
  source: ProcessFactSource
  /** True when this layer's outcome differs from the frozen evidence
   * `outcome`. A consumer that needs the historical reading uses the frozen
   * field; a consumer that needs the run's own declaration uses this layer and
   * can see that the two disagree. */
  frozenOutcomeConflict: boolean
  /** How far the guard could attribute effects to the operation. */
  operationAttribution: OperationAttribution
  /** Exactly the sub-results a trusted producer declared, if any. */
  declaredOperationResults?: DeclaredOperationResult[]
}

/**
 * `partial_failure` may be reported only from a credible structured
 * per-operation result, and only for the exact declared subset. `unknown`
 * stays unknown: the guard never reconstructs a per-operation verdict from
 * stderr text, and never widens a declared subset into a claim about the rest.
 */
export function partialFailureOf(facts: DerivedProcessFacts): { failed: DeclaredOperationResult[] } | undefined {
  const declared = facts.declaredOperationResults
  if (!declared?.length) return undefined
  if (facts.operationAttribution !== 'declared_per_operation') return undefined
  const failed = declared.filter((entry) => entry.outcome === 'failure')
  if (!failed.length) return undefined
  if (declared.some((entry) => entry.outcome === 'unknown')) return undefined
  return { failed }
}

/** The one-line consequence of a gap kind, shared so no lane re-invents it. */
export function capabilityConsequence(gap: CapabilityGap): string {
  switch (gap) {
    case 'missing_adapter':
      return 'No certification adapter exists for the exact action this obligation names. Complete the work honestly, keep the observable result, and report it as uncertified; do not claim a certificate, and do not demand that the user restate the request as some other supported action.'
    case 'interpretation_unknown':
      return 'The clause was not read as a concrete instruction. It stays recorded, non-executable, and never closes by delivery; a fresh explicit root instruction naming a concrete action supersedes it.'
    case 'legacy_migration_required':
      return 'A pre-0.5 obligation carries no concrete action. Only its own migration path replaces it: a fresh root instruction naming the action and target, followed by the rebind proposal that maps this item onto that recorded instruction.'
    case 'target_missing':
      return 'The action is supported, but an identity only the root can choose was never named. Supply exactly that field; the recorded obligation keeps its own meaning.'
    case 'input_ambiguous':
      return 'Several targets match. The root must select one before any stateful step; the guard never guesses.'
    case 'historical_preevidence_missing':
      return 'The observed effect has no recorded pre-evidence. Record the current state as a read-only fact; never repeat the action to mint the missing prestate.'
    case 'operation_unattributable':
      return 'The console could not attribute the effect to this obligation. Check the actual current state with a read-only command first, keep the obligation uncertified, never repeat the action to mint evidence, and do not assert that it never ran.'
    case 'condition_pending':
      return 'A declared condition or wait has not been released. Keep the obligation pending; do not execute it or collect effect evidence before release.'
    case 'delivery_pending':
      return 'Deliver the actual answer; the host-confirmed final response of a completed turn closes this obligation, and it certifies delivery only.'
    case 'host_unavailable':
      return 'The audited host cohort is unavailable. Restore it; keep pending work visible at a qualified safe boundary.'
    case 'constraint':
      return 'Keep this constraint enforced; it is not a completion evidence obligation.'
    case 'closed':
      return 'No further binding is needed.'
    case 'none':
      return 'Collect the matching durable evidence in its required order, then checkpoint.'
  }
}

/**
 * D062-03: the applicable condition every removal-like outcome must carry.
 * "Clean" or "no longer listed" never proves "no dependants", so a completed
 * subset stays reported as the subset it is. These are the execution-side
 * facts the guard can name but cannot observe; it states them instead of
 * inventing a generic remover or promising an automatic block.
 */
export const DEPENDENCY_FREE_ONLY_CONDITION: readonly string[] = [
  'git_unique_content',
  'dirty_or_untracked_or_ignored_entries',
  'task_process_cwd',
  'open_handles_and_running_processes',
  'runtime_links_and_external_consumers',
  'recovery_basis',
] as const

/** The per-object dependency status a report must keep separate. */
export type DependencyStatus = 'dependency_free' | 'in_use' | 'unknown'

/** Whether one candidate object may enter the automatic removal set. */
export function admissibleForRemoval(status: DependencyStatus): boolean {
  return status === 'dependency_free'
}

export interface RemovalOutcomeReport {
  metadataRemoved: 'yes' | 'no' | 'unknown'
  contentRemoved: 'yes' | 'no' | 'partial' | 'unknown'
  directoryRemoved: 'yes' | 'no' | 'unknown'
}

/** Only an object proven dependency-free AND fully removed may read as done. */
export function removalIsComplete(report: RemovalOutcomeReport, status: DependencyStatus): boolean {
  return status === 'dependency_free'
    && report.metadataRemoved === 'yes'
    && report.contentRemoved === 'yes'
    && report.directoryRemoved === 'yes'
}

/** A partially removed object or an unknown dependant is never "no impact". */
export function removalIsPartiallyKnown(report: RemovalOutcomeReport, status: DependencyStatus): boolean {
  return status !== 'dependency_free'
    || report.contentRemoved === 'partial'
    || report.directoryRemoved !== 'yes'
    || report.metadataRemoved !== 'yes'
}
