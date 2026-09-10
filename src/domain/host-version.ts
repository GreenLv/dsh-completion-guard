/**
 * DSH host version support policy.
 *
 * Context Guard 0.5.1 supports **DSH >= 0.1.5-rc.1** and nothing older. The
 * policy is one value with one comparison, used by the install entry
 * (`peerDependencies`), by the runtime host readback, and by the decision tests
 * — so the advertised range and the enforced range cannot drift apart.
 *
 * ## Why a range is not enough on its own
 *
 * npm's SemVer prerelease rule is narrower than "0.1.5-rc.1 or newer": a
 * version carrying a prerelease satisfies a comparator set only when some
 * comparator in that set names the SAME `major.minor.patch` tuple and itself
 * carries a prerelease. For the range `>=0.1.5-rc.1` that means:
 *
 * | Candidate          | Satisfies `>=0.1.5-rc.1` | Why |
 * | ---                | ---                      | --- |
 * | `0.1.5-rc.1`       | yes | the bound itself |
 * | `0.1.5-rc.2`       | yes | same tuple, comparator has a prerelease |
 * | `0.1.5`            | yes | a release is ordered after its own prereleases |
 * | `0.1.6`, `0.2.0`   | yes | higher release |
 * | `0.1.6-rc.1`       | **no** | prerelease of a DIFFERENT tuple |
 * | `0.2.0-rc.1`       | **no** | prerelease of a DIFFERENT tuple |
 * | `0.1.4`, `0.1.5-alpha.9` | no | below the bound |
 *
 * No finite SemVer range expresses "every future prerelease at any base", and
 * an unconditional `*` would drop the lower bound entirely. The range is
 * therefore the honest, conservative install-time statement, and this module is
 * the explicit runtime/decision path for the policy itself: {@link
 * compareHostVersions} accepts a future different-base RC by the documented
 * policy while {@link evaluateMinimumHostVersion} still refuses anything below
 * the minimum. An unobserved new-base RC remains `unverified` for host-lock
 * purposes — the version policy never substitutes for the exact-graph host
 * audit.
 */

/** Lowest supported DSH host version. DSH packages version independently of Cordis. */
export const MIN_SUPPORTED_HOST_VERSION = '0.1.5-rc.1'

/**
 * The exact npm range published in `peerDependencies`. It is deliberately the
 * plain lower bound plus the documented prerelease caveat above.
 */
export const SUPPORTED_HOST_RANGE: string = `>=${MIN_SUPPORTED_HOST_VERSION}`

export interface ParsedHostVersion {
  major: number
  minor: number
  patch: number
  /** Dot-separated prerelease identifiers; empty for a release version. */
  prerelease: readonly string[]
}

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function parseHostVersion(value: string): ParsedHostVersion | undefined {
  const match = VERSION_PATTERN.exec(value.trim())
  if (!match) return undefined
  const parts: number[] = [match[1], match[2], match[3]].map(Number)
  if (parts.some((part) => !Number.isSafeInteger(part) || part < 0)) return undefined
  const prerelease = match[4] ? match[4].split('.') : []
  if (prerelease.some((identifier) => identifier.length === 0)) return undefined
  return { major: parts[0], minor: parts[1], patch: parts[2], prerelease }
}

function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  // A release outranks any of its own prereleases.
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const left = a[index]
    const right = b[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) {
      const difference = Number(left) - Number(right)
      if (difference !== 0) return difference < 0 ? -1 : 1
      continue
    }
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

/**
 * SemVer precedence comparison, including the prerelease rules. Returns
 * `undefined` for a value that is not a version this module can order, so an
 * unparseable host version fails closed rather than sorting as "newer".
 */
export function compareHostVersions(a: string, b: string): number | undefined {
  const left = parseHostVersion(a)
  const right = parseHostVersion(b)
  if (!left || !right) return undefined
  if (left.major !== right.major) return left.major < right.major ? -1 : 1
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1
  return comparePrerelease(left.prerelease, right.prerelease)
}

export type HostVersionStatus = 'supported' | 'below_minimum' | 'unparseable'

export interface HostVersionDecision {
  status: HostVersionStatus
  version: string
  minimum: string
  reasonCode: 'host_version_supported' | 'host_version_below_minimum' | 'host_version_unparseable'
}

/** Decide the version-policy half of host support. Never a substitute for the graph lock. */
export function evaluateMinimumHostVersion(
  version: string,
  minimum: string = MIN_SUPPORTED_HOST_VERSION,
): HostVersionDecision {
  const comparison = compareHostVersions(version, minimum)
  if (comparison === undefined) {
    return { status: 'unparseable', version, minimum, reasonCode: 'host_version_unparseable' }
  }
  return comparison < 0
    ? { status: 'below_minimum', version, minimum, reasonCode: 'host_version_below_minimum' }
    : { status: 'supported', version, minimum, reasonCode: 'host_version_supported' }
}

/**
 * Whether npm's own range resolution would admit this version for
 * {@link SUPPORTED_HOST_RANGE}. Used by the decision tests to keep the
 * documented prerelease table true, and by diagnostics to explain why an
 * install did not resolve.
 */
export function satisfiesSupportedHostRange(version: string): boolean {
  const candidate = parseHostVersion(version)
  const bound = parseHostVersion(MIN_SUPPORTED_HOST_VERSION)!
  if (!candidate) return false
  const comparison = compareHostVersions(version, MIN_SUPPORTED_HOST_VERSION)!
  if (comparison < 0) return false
  if (candidate.prerelease.length === 0) return true
  // A prerelease only resolves when a comparator in the set shares its tuple
  // and carries a prerelease; the sole comparator is the lower bound.
  return candidate.major === bound.major && candidate.minor === bound.minor && candidate.patch === bound.patch
}
