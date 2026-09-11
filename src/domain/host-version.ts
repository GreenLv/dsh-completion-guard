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
export const MIN_SUPPORTED_HOST_VERSION = '0.1.5-rc.1'

/** Latest DSH release with a registered complete host graph. */
export const LATEST_SUPPORTED_HOST_VERSION = '0.1.5-rc.2'

/** Exact endpoints supported by the current release, newest first. */
export const SUPPORTED_HOST_VERSIONS: readonly string[] = [
  LATEST_SUPPORTED_HOST_VERSION,
  MIN_SUPPORTED_HOST_VERSION,
] as const

/** Exact npm range shared by package discovery and peer dependency declarations. */
export const SUPPORTED_HOST_RANGE: string = SUPPORTED_HOST_VERSIONS.join(' || ')

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

/** Whether npm's exact public support union admits this host version. */
export function satisfiesSupportedHostRange(version: string): boolean {
  const normalized = version.trim()
  if (!parseHostVersion(normalized)) return false
  return SUPPORTED_HOST_VERSIONS.some(
    (supported) => compareHostVersions(normalized, supported) === 0,
  )
}
