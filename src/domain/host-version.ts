/** Version admission floor. Since 0.8.1 the public DSH support range is
 * `>=0.2.0-rc.1` with NO implied upper bound: every host version at or above
 * this floor (including later RCs on any tuple, stable and future releases)
 * passes VERSION ADMISSION. The floor only rises when a future Guard release
 * actively adopts a newer DSH; the runtime never raises it from a remote
 * `latest`. Ordering is strict SemVer with prerelease comparison and build
 * metadata ignored. Version admission is one gate of several — it never
 * claims native validation of a not-yet-tested host, and the graph/byte/
 * contract audits below still run on every admission. */
export const MIN_SUPPORTED_HOST_VERSION = '0.2.0-rc.1'
export const SUPPORTED_HOST_RANGE: string = `>=${MIN_SUPPORTED_HOST_VERSION}`
/** Versions with recorded first-hand host evidence. This is an EVIDENCE
 * ledger, NOT an admission whitelist: a missing row never refuses a
 * version-above-floor host. */
export const HOST_VALIDATED_VERSIONS: readonly string[] = ['0.2.0-rc.1']
/** Historical alias retained for evidence-list readers; the admission rule is
 * the floor above, never this list. */
export const SUPPORTED_HOST_VERSIONS: readonly string[] = HOST_VALIDATED_VERSIONS
export const LATEST_TESTED_HOST_VERSION: string = HOST_VALIDATED_VERSIONS.at(-1)!

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
  // Range admission is now the floor itself: any version at or above the
  // minimum is 'supported' at the version gate. There is deliberately no
  // 'unregistered' refusal — per-version native validation is a separate,
  // recorded fact (HOST_VALIDATED_VERSIONS), never an admission gate.
  return comparison < 0
    ? { status: 'below_minimum', version, minimum, reasonCode: 'host_version_below_minimum' }
    : { status: 'supported', version, minimum, reasonCode: 'host_version_supported' }
}

/** Version admission: at or above the floor by strict SemVer precedence
 * (prerelease-aware; build metadata ignored). `0.2.0-rc.0` and the whole
 * `0.1.7.x` line stay below the floor; `0.2.0-rc.1`, `0.2.0-rc.2`, `0.2.0`,
 * later patch/minor RCs and releases all admit. */
export function satisfiesSupportedHostRange(version: string): boolean {
  const normalized = version.trim()
  const parsed = parseHostVersion(normalized)
  if (!parsed) return false
  const floor = parseHostVersion(MIN_SUPPORTED_HOST_VERSION)!
  const comparable = { major: parsed.major, minor: parsed.minor, patch: parsed.patch, prerelease: parsed.prerelease }
  const floorComparable = { major: floor.major, minor: floor.minor, patch: floor.patch, prerelease: floor.prerelease }
  if (comparable.major !== floorComparable.major) return comparable.major > floorComparable.major
  if (comparable.minor !== floorComparable.minor) return comparable.minor > floorComparable.minor
  if (comparable.patch !== floorComparable.patch) return comparable.patch > floorComparable.patch
  return comparePrerelease(comparable.prerelease, floorComparable.prerelease) >= 0
}
