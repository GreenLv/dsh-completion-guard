import { RC017_RC2_HOST_PACKAGES } from './rc017-rc2-host.js'
import { createHash } from 'node:crypto'
import { hostLockDigest, type CapabilityRow, type PackageRow } from './digest.js'
import { SEMANTIC_ACTIONS, type SemanticAction } from './protocol-manifest.js'
import { evaluateMinimumHostVersion, type HostVersionDecision } from './host-version.js'

export type HostLockStatus = 'supported' | 'unsupported' | 'unavailable'
export type HostPlatform = 'posix' | 'windows'
export type HostProfileKind = 'headless' | 'web'

/**
 * Capability expectations shared by every registered cohort.
 *
 * Every row is a host contract Guard actually consumes, re-checked against the
 * 0.1.7-rc.2 package surfaces: `ctx.sessions.flush()` still returns whether a
 * durability listener participated; `tools.guard()` is still a monotonic
 * post-policy denial; the Goal service still exposes `get`/`disarm` with a
 * disarming `pause`; the `update_goal` tool is still the pinned pre-commit gate;
 * `ctx.jobs.get()` still yields the `dsh.jobs.v1` status vocabulary; and
 * `dsh-tool-fs` still registers `read`/`write`/`edit` with the same parameter
 * and result contract (`dsh.fs-tools.v1`).
 *
 * Session V4 is bound by the exact package set and header version, not by a
 * permissive capability alias. Existing snapshotEvents() reads remain valid
 * only for this pinned local Session implementation.
 */
const AUDITED_CAPABILITY_ROWS: readonly CapabilityRow[] = [
  { name: 'goal_complete_precommit_guard', value: { k: 's', v: 'required' } },
  { name: 'goal_disarm_readback', value: { k: 's', v: 'required' } },
  { name: 'session_flush_before_control', value: { k: 's', v: 'required' } },
  { name: 'tool_guard_monotonic', value: { k: 's', v: 'required' } },
  { name: 'host_capability_model', value: { k: 's', v: 'action-platform-v1' } },
  { name: 'external_wait_jobs_readback', value: { k: 's', v: 'dsh.jobs.v1' } },
  { name: 'filesystem_tool_contract', value: { k: 's', v: 'dsh.fs-tools.v1' } },
  ...SEMANTIC_ACTIONS.map((action) => ({ name: 'supported_action', value: { k: 's' as const, v: action } })),
]

/**
 * How a cohort's package rows were established. Bound into every host-lock
 * digest through the `host_audit_provenance` capability row, so a certificate
 * records whether the exact graph it used was loaded on a native host or only
 * resolved from the registry.
 */
export type HostAuditProvenance = 'native-audited' | 'registry-derived-pending-native-audit'

export interface HostCohort {
  /** Stable cohort identity; bound into every hostLockDigest via `host_cohort`. */
  id: string
  manifestVersion: number
  supportedGoalVersions: string[]
  /**
   * Platforms where this cohort's exact package graph was extracted from a
   * native host and audited. A cohort with no native audit has an empty list
   * here even while it accepts evaluations — see {@link acceptedPlatforms}.
   */
  auditedPlatforms: readonly HostPlatform[]
  /**
   * Platforms on which the cohort may evaluate to `supported`. This is the
   * gating list; a platform outside it fails closed with
   * `host_cohort_platform_not_audited`. `auditedPlatforms` remains the stricter
   * fact and `auditProvenance` states which one a certificate actually rests
   * on, so a registry-derived graph is never silently reported as a native pass.
   */
  acceptedPlatforms: readonly HostPlatform[]
  auditProvenance: HostAuditProvenance
  packages: PackageRow[]
  capabilities: CapabilityRow[]
}

function defineCohort(
  id: string,
  supportedGoalVersions: string[],
  auditedPlatforms: readonly HostPlatform[],
  packages: PackageRow[],
  auditProvenance: HostAuditProvenance = 'native-audited',
  acceptedPlatforms: readonly HostPlatform[] = auditedPlatforms,
): HostCohort {
  return {
    id,
    manifestVersion: 1,
    supportedGoalVersions,
    auditedPlatforms,
    acceptedPlatforms,
    auditProvenance,
    packages,
    capabilities: [
      { name: 'host_cohort', value: { k: 's', v: id } },
      { name: 'host_audit_provenance', value: { k: 's', v: auditProvenance } },
      ...AUDITED_CAPABILITY_ROWS,
    ],
  }
}

/** Baseline cohort retained for callers that need a default fixture. */
export const ACTIVE_HOST_COHORT_ID = 'dsh-0.1.7-rc.2'
export const ACTIVE_HOST_COHORT_IDS: readonly string[] = [ACTIVE_HOST_COHORT_ID]

/** Core-lock/v1 separates optional market identity from the rc.2 critical
 * graph. Historical cohorts live only in test data. Version ordering cannot
 * authorize an unregistered graph, and graph identity is separate from native
 * acceptance of a Guard artifact.
 */
export const HOST_COHORTS: readonly HostCohort[] = [
  defineCohort(ACTIVE_HOST_COHORT_ID, ['0.1.7-rc.2'], [], RC017_RC2_HOST_PACKAGES,
    'registry-derived-pending-native-audit', ['posix', 'windows']),
]
  .filter((cohort) => ACTIVE_HOST_COHORT_IDS.includes(cohort.id))
  .map((cohort) => ({
    ...cohort,
    id: `${cohort.id}-core-v1`,
    manifestVersion: 2,
    packages: cohort.packages.filter((row) => row.name !== 'dshmarket'),
    capabilities: [
      { name: 'host_cohort', value: { k: 's' as const, v: `${cohort.id}-core-v1` } },
      { name: 'host_lock_policy', value: { k: 's' as const, v: 'dsh-core/v1' } },
      { name: 'host_audit_provenance', value: { k: 's' as const, v: cohort.auditProvenance } },
      ...AUDITED_CAPABILITY_ROWS,
    ],
  }))

/**
 * Baseline fixture package identities (DSH 0.1.7-rc.2). The cohort
 * is an atomic whole-graph contract (CG-DSH-001): any drifted, duplicated,
 * unknown-version, unbound, OR MISSING row fails the whole lock closed
 * (`host_lock_missing`); no capability inherits independence from a partially
 * present graph.
 */
export const EXPECTED_HOST_PACKAGES: PackageRow[] = HOST_COHORTS[0].packages

/**
 * The `@deepseek-ai/dsh` launcher version of the baseline fixture, read from the
 * cohort rows rather than hardcoded, so a cohort bump cannot leave a stale
 * literal behind in the target-inspection path.
 */
export const ACTIVE_HOST_LAUNCHER_VERSION: string | undefined =
  EXPECTED_HOST_PACKAGES.find((row) => row.name === '@deepseek-ai/dsh')?.version

const packageNames = (...names: string[]): ReadonlySet<string> => new Set(names)

export const BASE_HOST_PACKAGES: ReadonlySet<string> = packageNames(
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-tools',
)

export const GOAL_HOST_PACKAGES: ReadonlySet<string> = packageNames('@deepseek-ai/dsh-goal', '@deepseek-ai/dsh-tool-goal')

export type HostCapabilityId =
  | 'agent_loop'
  | 'terminal_posix'
  | 'terminal_windows'
  | 'dsh_cli'
  | 'plugin_inventory'
  | 'web_control'
  | 'jobs'
  | 'filesystem'

export const HOST_CAPABILITY_PACKAGE_GROUPS: Readonly<Record<HostCapabilityId, ReadonlySet<string>>> = {
  agent_loop: packageNames('@deepseek-ai/dsh-agent-loop'),
  terminal_posix: packageNames(
    '@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-shell', '@deepseek-ai/dsh-subprocess-local',
    '@deepseek-ai/dsh-bash-sandbox', '@deepseek-ai/dsh-shell-env',
  ),
  terminal_windows: packageNames(
    '@deepseek-ai/dsh-tool-pwsh', '@deepseek-ai/dsh-shell', '@deepseek-ai/dsh-subprocess-local',
    '@deepseek-ai/dsh-pwsh-sandbox', '@deepseek-ai/dsh-shell-env',
  ),
  dsh_cli: packageNames('@deepseek-ai/dsh'),
  plugin_inventory: packageNames('@deepseek-ai/dsh-host-plugin-inventory'),
  web_control: packageNames('@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-web-app'),
  // `dsh-jobs` owns the lifecycle/status contract, `dsh-jobs-local` is the
  // process-local provider behind ctx.jobs, and `dsh-tool-jobs` attaches the
  // controller without which the pinned registry refuses job admission.
  jobs: packageNames('@deepseek-ai/dsh-jobs', '@deepseek-ai/dsh-jobs-local', '@deepseek-ai/dsh-tool-jobs'),
  // `dsh-tool-fs` owns the exact read/write/edit schemas, results, and
  // presentation surface. The rest of this group is the mounted local,
  // observation, sandbox-policy, and approval chain that decides whether a
  // persisted result denotes the same protected filesystem effect.
  filesystem: packageNames(
    '@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-fs', '@deepseek-ai/dsh-fs-local',
    '@deepseek-ai/dsh-fs-sandbox', '@deepseek-ai/dsh-fs-observation-policy',
    '@deepseek-ai/dsh-sandbox', '@deepseek-ai/dsh-sandbox-policy', '@deepseek-ai/dsh-user-approval',
    '@deepseek-ai/dsh-attachment', '@deepseek-ai/dsh-system-prompt',
  ),
}

export interface HostCapabilityEvaluation {
  id: string
  status: HostLockStatus
  digest: string
  requiredPackages: string[]
  missingPackages: string[]
  reasonCode?:
    | 'host_capability_missing'
    | 'host_capability_version_mismatch'
    | 'host_capability_integrity_mismatch'
    | 'host_capability_duplicate_package'
    | 'host_capability_context_missing'
    | 'host_capability_request_unsupported'
}

export interface HostLockEvaluation {
  status: HostLockStatus
  digest: string
  /** Read-only byte attestation of the active foreground shell renderer and
   * its shared terminal decoder. Set only by production active-graph readback;
   * the package version/SRI graph alone does not establish renderer behavior. */
  auditedForegroundRenderers?: Array<'bash' | 'pwsh'>
  goalAvailable: boolean
  reasonCode?:
    | 'host_lock_migration_required'
    | 'host_lock_installed_graph_drift'
    | 'host_lock_missing'
    | 'host_lock_version_mismatch'
    | 'host_lock_version_below_minimum'
    | 'host_lock_version_unparseable'
    | 'host_lock_integrity_mismatch'
    | 'host_lock_unknown_package'
    | 'host_lock_duplicate_package'
    | 'host_lock_goal_graph_incomplete'
    | 'host_lock_goal_capability_mismatch'
    | 'host_lock_cohort_mixed_graph'
    | 'host_lock_cohort_unbound_identity'
    | 'host_lock_cohort_platform_not_audited'
  packages: PackageRow[]
  capabilities: Record<HostCapabilityId, HostCapabilityEvaluation>
  platform?: HostPlatform
  profileKind?: HostProfileKind
  liveGoalAvailable?: boolean
  /**
   * The version-policy half of host support, decided separately from the graph.
   * A host below the minimum is refused here even when its graph matches an
   * audited cohort, and an in-range version never substitutes for the
   * exact-graph audit: the two are independent facts, both reported.
   */
  hostVersion?: HostVersionDecision
  /** Readback of the audited cohort the supplied graph was evaluated against. */
  cohortId?: string
  /**
   * Readback of how that cohort's rows were established. `registry-derived-
   * pending-native-audit` means the exact published graph was verified but no
   * native host load has happened yet; a certificate must never present that as
   * a native pass.
   */
  auditProvenance?: HostAuditProvenance
  /** Audited cohort rows absent from the supplied graph (diagnostic). */
  missingPackages?: string[]
}

export interface HostLockContext {
  platform?: HostPlatform
  profileKind?: HostProfileKind
  capabilityId?: string
  /**
   * The DSH host version the graph was read from, when the caller read one.
   * Supplying it turns the version policy into a production decision; omitting
   * it leaves the version question unanswered rather than assumed supported.
   */
  hostVersion?: string
}

/**
 * The host version a package graph records, for the version-policy decision.
 *
 * Every DSH package versions with the host, so the graph's own `dsh` row is the
 * version the caller is running. A graph without that row leaves the version
 * unknown, and an unknown version is not treated as supported.
 */
export function hostVersionFromPackages(rows: readonly PackageRow[]): string | undefined {
  const host = rows.find((row) => row.name === '@deepseek-ai/dsh')
  return host?.version
}

export type HostCohortSelectionReason =
  | 'host_cohort_unknown_package'
  | 'host_cohort_version_mismatch'
  | 'host_cohort_integrity_mismatch'
  | 'host_cohort_mixed_graph'
  | 'host_cohort_incomplete_graph'
  | 'host_cohort_unbound_identity'
  | 'host_cohort_platform_not_audited'

export interface HostCohortSelection {
  /**
   * Cohort used for expected-row lookups and digest identity. When the graph
   * does not consistently match one cohort this is the deterministic
   * closest-cohort fallback (most exact row matches, then registry order) and
   * `consistent` is false, so evaluation fails closed downstream.
   */
  cohort: HostCohort
  /**
   * True only when every supplied row exactly matches the selected cohort
   * AND every audited cohort row is present: the audited cohort is an atomic
   * whole-graph contract, so a graph missing audited rows (missing packages)
   * never selects consistently.
   */
  consistent: boolean
  reasonCode?: HostCohortSelectionReason
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
export function selectHostCohort(
  rows: readonly PackageRow[],
  platform?: HostPlatform,
): HostCohortSelection {
  rows = rows.filter((row) => row.name !== 'dshmarket')
  const registryNames = new Set(HOST_COHORTS.flatMap((cohort) => cohort.packages.map((row) => row.name)))
  if (rows.some((row) => !registryNames.has(row.name))) {
    return { cohort: HOST_COHORTS[0], consistent: false, reasonCode: 'host_cohort_unknown_package' }
  }
  if (rows.length === 0) {
    return { cohort: HOST_COHORTS[0], consistent: false, reasonCode: 'host_cohort_unbound_identity' }
  }
  // Per row: the cohorts whose audited row matches this row's version, and
  // among those, the cohorts whose full identity matches exactly.
  const bound = rows.filter((row) => row.version !== undefined && row.integrity !== undefined)
  const unboundCount = rows.length - bound.length
  const versionMatches = bound.map((row) => HOST_COHORTS.filter((cohort) =>
    cohort.packages.some((p) => p.name === row.name && p.version === row.version)))
  const identityMatches = bound.map((row, index) => versionMatches[index].filter((cohort) =>
    cohort.packages.some((p) => p.name === row.name && p.version === row.version && p.integrity === row.integrity)))
  // A complete smaller audited graph must not be shadowed by a superset.
  // This still requires every supplied identity and every cohort row exactly once.
  const candidates = HOST_COHORTS.filter((cohort) => identityMatches.every((matches) => matches.includes(cohort)))
  const completeCandidates = candidates.filter((cohort) => cohort.packages.length === rows.length
    && cohort.packages.every((expected) => rows.filter((row) => row.name === expected.name).length === 1))
  const consistentCohort = completeCandidates[0] ?? candidates[0]
  if (consistentCohort !== undefined && unboundCount === 0) {
    if (platform && !consistentCohort.acceptedPlatforms.includes(platform)) {
      // The exact graph is registered, but it is not accepted on this platform;
      // integrity must not be inferred across platforms.
      return { cohort: consistentCohort, consistent: false, reasonCode: 'host_cohort_platform_not_audited' }
    }
    const suppliedCounts = new Map<string, number>()
    for (const row of rows) suppliedCounts.set(row.name, (suppliedCounts.get(row.name) ?? 0) + 1)
    const complete = consistentCohort.packages.every((row) => (suppliedCounts.get(row.name) ?? 0) === 1)
      && rows.length === consistentCohort.packages.length
    if (!complete) {
      // CG-DSH-001: the audited cohort is one indivisible whole-graph
      // contract — a graph missing audited rows (or carrying duplicates)
      // never selects consistently and fails closed downstream.
      return { cohort: consistentCohort, consistent: false, reasonCode: 'host_cohort_incomplete_graph' }
    }
    return { cohort: consistentCohort, consistent: true }
  }
  // Mixture signal first: when the rows that do exactly match some cohort
  // are not all covered by one cohort, the graph mixes cohorts even if
  // unrelated drifted rows are present.
  const matchingIndices = identityMatches.flatMap((matches, index) => matches.length > 0 ? [index] : [])
  const mixtureCovered = HOST_COHORTS.filter((cohort) => matchingIndices.every((index) => identityMatches[index].includes(cohort)))
  let reasonCode: HostCohortSelectionReason
  if (matchingIndices.length > 0 && mixtureCovered.length === 0) {
    reasonCode = 'host_cohort_mixed_graph'
  } else if (bound.length > 0 && versionMatches.some((matches) => matches.length === 0)) {
    // At least one row's version (or name) is audited in no cohort.
    reasonCode = 'host_cohort_version_mismatch'
  } else if (bound.length > 0 && identityMatches.some((matches) => matches.length === 0)) {
    // Every version is audited somewhere, but at least one integrity never
    // matches the cohort that carries that version.
    reasonCode = 'host_cohort_integrity_mismatch'
  } else {
    reasonCode = 'host_cohort_unbound_identity'
  }
  // Deterministic closest-cohort fallback for expected-row lookups and
  // digest diagnostics: most exact identity matches, then registry order.
  const fallback = [...HOST_COHORTS].sort((a, b) => {
    const scoreOf = (cohort: HostCohort) => identityMatches.filter((matches) => matches.includes(cohort)).length
    return scoreOf(b) - scoreOf(a) || HOST_COHORTS.indexOf(a) - HOST_COHORTS.indexOf(b)
  })[0]
  return { cohort: fallback, consistent: false, reasonCode }
}

function stableRows(rows: readonly PackageRow[]): PackageRow[] {
  return [...rows].map((row) => ({ ...row })).sort((a, b) =>
    a.name.localeCompare(b.name)
      || (a.version ?? '').localeCompare(b.version ?? '')
      || (a.integrity ?? '').localeCompare(b.integrity ?? ''))
}

function statusForPackages(
  id: string,
  rows: readonly PackageRow[],
  requiredNames: ReadonlySet<string>,
  cohort: HostCohort,
): HostCapabilityEvaluation {
  const requiredPackages = [...requiredNames].sort()
  const relevant = rows.filter((row) => requiredNames.has(row.name))
  const counts = new Map<string, number>()
  for (const row of relevant) counts.set(row.name, (counts.get(row.name) ?? 0) + 1)
  const missingPackages = requiredPackages.filter((name) => !counts.has(name))
  const digest = safeHostLockDigest(relevant, { capabilityId: id }, cohort)
  if ([...counts.values()].some((count) => count > 1)) {
    return { id, status: 'unavailable', digest, requiredPackages, missingPackages, reasonCode: 'host_capability_duplicate_package' }
  }
  if (missingPackages.length > 0) {
    return { id, status: 'unavailable', digest, requiredPackages, missingPackages, reasonCode: 'host_capability_missing' }
  }
  const expected = new Map(cohort.packages.map((row) => [row.name, row]))
  for (const row of relevant) {
    const pinned = expected.get(row.name)!
    if (!row.version || !row.integrity) {
      return { id, status: 'unavailable', digest, requiredPackages, missingPackages, reasonCode: 'host_capability_missing' }
    }
    if (row.version !== pinned.version) {
      return { id, status: 'unsupported', digest, requiredPackages, missingPackages, reasonCode: 'host_capability_version_mismatch' }
    }
    if (row.integrity !== pinned.integrity) {
      return { id, status: 'unsupported', digest, requiredPackages, missingPackages, reasonCode: 'host_capability_integrity_mismatch' }
    }
  }
  return { id, status: 'supported', digest, requiredPackages, missingPackages }
}

function capabilityEvaluations(rows: readonly PackageRow[], cohort: HostCohort): Record<HostCapabilityId, HostCapabilityEvaluation> {
  return Object.fromEntries(Object.entries(HOST_CAPABILITY_PACKAGE_GROUPS).map(([id, packages]) => (
    [id, statusForPackages(id, rows, packages, cohort)]
  ))) as Record<HostCapabilityId, HostCapabilityEvaluation>
}

function cohortForEvaluation(evaluation: Pick<HostLockEvaluation, 'cohortId'>): HostCohort {
  return HOST_COHORTS.find((cohort) => cohort.id === evaluation.cohortId) ?? HOST_COHORTS[0]
}

export function evaluateHostLock(rows: readonly PackageRow[], context: HostLockContext = {}): HostLockEvaluation {
  const supplied = stableRows(rows.filter((row) => row.name !== 'dshmarket'))
  const selection = selectHostCohort(supplied, context.platform)
  const cohort = selection.cohort
  const capabilities = capabilityEvaluations(supplied, cohort)
  const counts = new Map<string, number>()
  for (const row of supplied) counts.set(row.name, (counts.get(row.name) ?? 0) + 1)
  const goalRows = [...GOAL_HOST_PACKAGES].filter((name) => counts.has(name))
  const goalAvailable = goalRows.length === GOAL_HOST_PACKAGES.size
  const digest = safeHostLockDigest(supplied, context, cohort)
  const base = statusForPackages('base', supplied, BASE_HOST_PACKAGES, cohort)
  const missingPackages = cohort.packages
    .map((row) => row.name)
    .filter((name) => (counts.get(name) ?? 0) === 0)
    .sort((a, b) => a.localeCompare(b))
  const registryNames = new Set(HOST_COHORTS.flatMap((entry) => entry.packages.map((row) => row.name)))
  const unknown = supplied.find((row) => !registryNames.has(row.name))
  // The version policy is decided before the graph, and independently of it.
  // Reading the version from the graph when the caller did not name one keeps
  // the decision on the production path rather than in a test-only function,
  // and a graph that records no version leaves the question unanswered instead
  // of answered "supported".
  const hostVersionValue = context.hostVersion ?? hostVersionFromPackages(supplied)
  const hostVersion = hostVersionValue === undefined ? undefined : evaluateMinimumHostVersion(hostVersionValue)
  const baseResult = {
    digest,
    goalAvailable,
    packages: supplied,
    capabilities,
    cohortId: cohort.id,
    auditProvenance: cohort.auditProvenance,
    missingPackages,
    ...(hostVersion ? { hostVersion } : {}),
    ...(context.platform ? { platform: context.platform } : {}),
    ...(context.profileKind ? { profileKind: context.profileKind } : {}),
  }
  if (unknown) return { ...baseResult, status: 'unsupported', reasonCode: 'host_lock_unknown_package' }
  // CG-DSH-001: duplicates are a whole-graph failure, not a critical-row-only
  // one — a duplicated optional row is equally uncertifiable.
  if (supplied.some((row) => (counts.get(row.name) ?? 0) > 1)) {
    return { ...baseResult, status: 'unavailable', goalAvailable: false, reasonCode: 'host_lock_duplicate_package' }
  }
  if (goalRows.length > 0 && !goalAvailable) {
    return { ...baseResult, status: 'unavailable', goalAvailable: false, reasonCode: 'host_lock_goal_graph_incomplete' }
  }
  if (base.status !== 'supported') {
    const reasonCode = base.reasonCode === 'host_capability_version_mismatch'
      ? 'host_lock_version_mismatch'
      : base.reasonCode === 'host_capability_integrity_mismatch'
        ? 'host_lock_integrity_mismatch'
        : base.reasonCode === 'host_capability_duplicate_package'
          ? 'host_lock_duplicate_package'
          : 'host_lock_missing'
    return { ...baseResult, status: base.status, reasonCode }
  }
  if (goalAvailable) {
    const goal = statusForPackages('goal', supplied, GOAL_HOST_PACKAGES, cohort)
    if (goal.status !== 'supported') {
      return {
        ...baseResult,
        status: goal.status,
        goalAvailable: false,
        reasonCode: goal.reasonCode === 'host_capability_version_mismatch'
          ? 'host_lock_version_mismatch'
          : goal.reasonCode === 'host_capability_integrity_mismatch'
            ? 'host_lock_integrity_mismatch'
            : 'host_lock_missing',
      }
    }
  }
  // CG-DSH-001: cohort selection is atomic over the whole audited graph.
  // Every inconsistency — cross-cohort mixtures, never-audited platforms,
  // unknown versions, drifted integrity, unbound identities, or missing
  // audited rows, in required or optional packages — fails the whole lock
  // closed; a drifted or missing optional row can never leave the lock
  // `supported`.
  if (!selection.consistent) {
    // Identity mismatches with the audited cohort are `unsupported`; graphs
    // that cannot certify the host at all (missing rows) are `unavailable`.
    const reasonBySelection: Record<HostCohortSelectionReason, { status: HostLockStatus; reasonCode: NonNullable<HostLockEvaluation['reasonCode']> }> = {
      host_cohort_unknown_package: { status: 'unsupported', reasonCode: 'host_lock_unknown_package' },
      host_cohort_version_mismatch: { status: 'unsupported', reasonCode: 'host_lock_version_mismatch' },
      host_cohort_integrity_mismatch: { status: 'unsupported', reasonCode: 'host_lock_integrity_mismatch' },
      host_cohort_mixed_graph: { status: 'unsupported', reasonCode: 'host_lock_cohort_mixed_graph' },
      host_cohort_incomplete_graph: { status: 'unavailable', reasonCode: 'host_lock_missing' },
      host_cohort_unbound_identity: { status: 'unsupported', reasonCode: 'host_lock_cohort_unbound_identity' },
      host_cohort_platform_not_audited: { status: 'unsupported', reasonCode: 'host_lock_cohort_platform_not_audited' },
    }
    const failure = reasonBySelection[selection.reasonCode ?? 'host_cohort_unbound_identity']
    return {
      ...baseResult,
      status: failure.status,
      goalAvailable: false,
      reasonCode: failure.reasonCode,
    }
  }
  // Below the minimum is refused whatever the graph says: the floor is not a
  // graph property, so a lock that happened to match can never lift it. It is
  // decided last on purpose — a graph that already failed keeps its own graph
  // verdict, because the version policy and the exact-graph audit are
  // independent facts and neither may be reported as the other.
  if (hostVersion?.status === 'below_minimum' || hostVersion?.status === 'unparseable' || hostVersion?.status === 'unregistered') {
    return {
      ...baseResult,
      status: 'unsupported',
      goalAvailable: false,
      reasonCode: hostVersion.status === 'below_minimum' ? 'host_lock_version_below_minimum' : hostVersion.status === 'unregistered' ? 'host_lock_version_mismatch' : 'host_lock_version_unparseable',
    }
  }
  return { ...baseResult, status: 'supported' }
}

const TERMINAL_ACTIONS: ReadonlySet<SemanticAction> = new Set([
  'inspect_remote_updates', 'install', 'apply', 'test', 'verify', 'pull', 'fetch',
  'commit', 'push', 'publish', 'generic_run',
])

export interface HostCapabilityRequest {
  action: SemanticAction
  platform?: HostPlatform
  profileKind?: HostProfileKind
}

/** Evaluate only the packages needed for one effect/readback capability. */
export function evaluateHostCapability(
  evaluation: HostLockEvaluation,
  request: HostCapabilityRequest,
): HostCapabilityEvaluation {
  const platform = request.platform ?? evaluation.platform
  const profileKind = request.profileKind ?? evaluation.profileKind
  const groups: HostCapabilityId[] = ['agent_loop']
  if (TERMINAL_ACTIONS.has(request.action)) {
    if (!platform) {
      return {
        id: `action.${request.action}`,
        status: 'unavailable',
        digest: evaluation.digest,
        requiredPackages: [],
        missingPackages: [],
        reasonCode: 'host_capability_context_missing',
      }
    }
    groups.push(platform === 'windows' ? 'terminal_windows' : 'terminal_posix')
  }
  if (request.action === 'create' || request.action === 'modify') groups.push('filesystem')
  if (request.action === 'install' || request.action === 'apply') groups.push('dsh_cli')
  if (request.action === 'apply') groups.push('plugin_inventory')
  if (request.action === 'restart' && profileKind === 'web') groups.push('web_control')
  if (request.action === 'restart' && profileKind !== 'web') {
    return {
      id: 'action.restart',
      status: 'unavailable',
      digest: evaluation.digest,
      requiredPackages: [],
      missingPackages: [],
      reasonCode: profileKind ? 'host_capability_request_unsupported' : 'host_capability_context_missing',
    }
  }
  const required = new Set<string>(BASE_HOST_PACKAGES)
  for (const group of groups) for (const name of HOST_CAPABILITY_PACKAGE_GROUPS[group]) required.add(name)
  const result = statusForPackages(`action.${request.action}.${platform ?? 'native'}.${profileKind ?? 'unknown'}`, evaluation.packages, required, cohortForEvaluation(evaluation))
  if (evaluation.status !== 'supported') {
    return { ...result, status: evaluation.status, digest: evaluation.digest }
  }
  return result
}

/**
 * Bind external_wait qualification and pre-effect requalification to the
 * exact jobs service definition, local provider, and live controller graph.
 * This is deliberately independent of the global/base lock so profiles that
 * do not support background jobs can still use unrelated Guard actions.
 */
export function evaluateExternalWaitCapability(
  evaluation: HostLockEvaluation,
): HostCapabilityEvaluation {
  const required = new Set<string>(BASE_HOST_PACKAGES)
  for (const name of HOST_CAPABILITY_PACKAGE_GROUPS.jobs) required.add(name)
  const result = statusForPackages('boundary.external_wait.jobs', evaluation.packages, required, cohortForEvaluation(evaluation))
  if (evaluation.status !== 'supported') {
    return { ...result, status: evaluation.status, digest: evaluation.digest }
  }
  return result
}

export type HostToolSurface = 'bash' | 'pwsh' | 'filesystem'

/**
 * Gate automatically replayed ordinary tool results by the exact host
 * capability that owns their registration and outcome surface. Tool names are
 * intentionally separate from semantic actions: a `bash` result on Windows,
 * or a `pwsh` result on POSIX, is not evidence from the active host stack.
 */
export function evaluateToolSurfaceCapability(
  evaluation: HostLockEvaluation,
  surface: HostToolSurface,
): HostCapabilityEvaluation {
  const platform = evaluation.platform
  if (surface !== 'filesystem' && !platform) {
    return {
      id: `tool.${surface}.unknown`, status: 'unavailable', digest: evaluation.digest,
      requiredPackages: [], missingPackages: [], reasonCode: 'host_capability_context_missing',
    }
  }
  if ((surface === 'bash' && platform !== 'posix') || (surface === 'pwsh' && platform !== 'windows')) {
    return {
      id: `tool.${surface}.${platform}`, status: 'unsupported', digest: evaluation.digest,
      requiredPackages: [], missingPackages: [], reasonCode: 'host_capability_request_unsupported',
    }
  }
  const groups: HostCapabilityId[] = ['agent_loop']
  if (surface === 'filesystem') groups.push('filesystem')
  if (surface === 'bash') groups.push('terminal_posix')
  if (surface === 'pwsh') groups.push('terminal_windows')
  const required = new Set<string>(BASE_HOST_PACKAGES)
  for (const group of groups) for (const name of HOST_CAPABILITY_PACKAGE_GROUPS[group]) required.add(name)
  const result = statusForPackages(`tool.${surface}.${platform ?? 'native'}`, evaluation.packages, required, cohortForEvaluation(evaluation))
  if (evaluation.status !== 'supported') {
    return { ...result, status: evaluation.status, digest: evaluation.digest }
  }
  return result
}

function safeHostLockDigest(packages: readonly PackageRow[], context: HostLockContext = {}, cohort: HostCohort): string {
  try {
    // The cohort manifest (including its `host_cohort` identity row and its
    // own supportedGoalVersions) is the digest root, so certificates are
    // bound to the audited cohort and a cohort switch invalidates them.
    const capabilities = [
      ...cohort.capabilities,
      ...(context.platform ? [{ name: 'active_platform', value: { k: 's' as const, v: context.platform } }] : []),
      ...(context.profileKind ? [{ name: 'active_profile', value: { k: 's' as const, v: context.profileKind } }] : []),
      ...(context.capabilityId ? [{ name: 'active_capability', value: { k: 's' as const, v: context.capabilityId } }] : []),
    ]
    return hostLockDigest({
      manifestVersion: cohort.manifestVersion,
      supportedGoalVersions: [...cohort.supportedGoalVersions],
      capabilities,
      packages: [...packages],
    })
  } catch {
    const bounded = {
      packages: packages.map((row) => [String(row.name), row.version ?? null, row.integrity ?? null]),
      platform: context.platform ?? null,
      profileKind: context.profileKind ?? null,
      capabilityId: context.capabilityId ?? null,
    }
    return createHash('sha256')
      .update('ccg.invalidHostLockDigest.v1\n', 'utf8')
      .update(JSON.stringify(bounded), 'utf8')
      .digest('hex')
  }
}

/** Bind the injected Goal graph to the live Goal service for this agent. */
export function bindLiveGoalCapability(
  evaluation: HostLockEvaluation,
  liveGoalAvailable: boolean,
): HostLockEvaluation {
  if (evaluation.status !== 'supported') return { ...evaluation, liveGoalAvailable }
  if (evaluation.goalAvailable !== liveGoalAvailable) {
    return {
      ...evaluation,
      status: 'unavailable',
      reasonCode: 'host_lock_goal_capability_mismatch',
      liveGoalAvailable,
    }
  }
  return { ...evaluation, liveGoalAvailable }
}

export type AuditedExecutable = 'git' | 'npm' | 'pnpm' | 'dsh'

export interface ExecutableIdentity {
  executable: AuditedExecutable
  realpath: string
  version: string
  interpreterRealpath?: string
  interpreterVersion?: string
}

export interface ExecutableIdentityBinding {
  status: HostLockStatus
  digest: string
  identity?: ExecutableIdentity
  reasonCode?: 'executable_identity_missing' | 'executable_realpath_invalid' | 'executable_identity_drift'
}

function executableDigest(identity: ExecutableIdentity | undefined): string {
  return createHash('sha256')
    .update('ccg.executableIdentity.v1\n', 'utf8')
    .update(JSON.stringify(identity ?? null), 'utf8')
    .digest('hex')
}

function validExecutableIdentity(identity: ExecutableIdentity | undefined): identity is ExecutableIdentity {
  if (!identity || !['git', 'npm', 'pnpm', 'dsh'].includes(identity.executable)) return false
  if (!identity.version || /[\r\n\0]/.test(identity.version)) return false
  if (!(identity.realpath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(identity.realpath))
    || /[\r\n\0]/.test(identity.realpath)) return false
  const interpreterFields = [identity.interpreterRealpath, identity.interpreterVersion]
  if (interpreterFields.every((value) => value === undefined)) return true
  return typeof identity.interpreterRealpath === 'string'
    && /^[A-Za-z]:[\\/]/.test(identity.interpreterRealpath)
    && !/[\r\n\0]/.test(identity.interpreterRealpath)
    && typeof identity.interpreterVersion === 'string'
    && identity.interpreterVersion.length > 0
    && !/[\r\n\0]/.test(identity.interpreterVersion)
}

/** Bind resolution and effect to the exact same canonical executable tuple. */
export function bindExecutableIdentity(
  resolution: ExecutableIdentity | undefined,
  effect: ExecutableIdentity | undefined,
): ExecutableIdentityBinding {
  if (!resolution || !effect) {
    return { status: 'unavailable', digest: executableDigest(resolution), reasonCode: 'executable_identity_missing' }
  }
  if (!validExecutableIdentity(resolution) || !validExecutableIdentity(effect)) {
    return { status: 'unavailable', digest: executableDigest(resolution), reasonCode: 'executable_realpath_invalid' }
  }
  if (resolution.executable !== effect.executable
    || resolution.realpath !== effect.realpath
    || resolution.version !== effect.version
    || resolution.interpreterRealpath !== effect.interpreterRealpath
    || resolution.interpreterVersion !== effect.interpreterVersion) {
    return { status: 'unsupported', digest: executableDigest(resolution), reasonCode: 'executable_identity_drift' }
  }
  return { status: 'supported', digest: executableDigest(resolution), identity: { ...resolution } }
}

// CG-DSH-001: the default host identity is the complete audited cohort graph
// (fail-closed would make every derivation without an explicit host readback
// unusable); callers that evaluate a real host always pass an explicit lock.
export const DEFAULT_HOST_LOCK: HostLockEvaluation = evaluateHostLock(EXPECTED_HOST_PACKAGES)
