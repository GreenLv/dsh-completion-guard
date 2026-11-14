import rc2 from './byte-audit-manifest.js'
import rc3 from './rc3-byte-audit-manifest.js'
import rc5 from './rc5-byte-audit-manifest.js'
import rc022rc1 from './rc022-rc1-byte-audit-manifest.js'
import rc022rc2 from './rc022-rc2-byte-audit-manifest.js'
import rc022rc3 from './rc022-rc3-byte-audit-manifest.js'
import type { ByteAuditManifest } from './byte-audit-manifest.js'

/**
 * Version-selected audited cohort manifest (RC3-D01, extended through
 * 0.2.2-rc.3): every registry-derived expectation source — desktop cohort
 * integrity rows, default audit expectations, renderer identity regexes —
 * must follow the ACTUAL acquired runtime version instead of being pinned to
 * one historical manifest. All manifests share one audited schema; the rc.3
 * and rc.5 lib bytes are byte-identical to rc.2 (verified per file by the
 * respective studies), so only the version string differs between those
 * expectation sets. The 0.2.2-rc.1, 0.2.2-rc.2 and 0.2.2-rc.3 manifests are
 * NOT byte-stable with them: each study re-verified every tarball against
 * the registry after real interface changes (rc.3 rewrites package manifests
 * and changes dsh-official-bundles bytes), and rc.3 is the default for
 * unknown versions. The 0.2.2-rc.1 manifest stays an independently selected
 * qualified state, never a fallback alias for newer graphs.
 */
export const AUDITED_HOST_MANIFESTS: readonly ByteAuditManifest[] = [rc2, rc3, rc5, rc022rc1, rc022rc2, rc022rc3]

/** The audited manifest whose hostVersion matches, defaulting to the
 * 0.2.2-rc.3 baseline for callers whose graph version is not one of the
 * audited releases (those fail closed downstream on the version mismatch).
 * The rc.2/0.2.1 rows below the current floor remain available as historical
 * evidence sources; they never reopen admission. */
export function auditedManifestFor(version: string | undefined | null): ByteAuditManifest {
  return AUDITED_HOST_MANIFESTS.find((manifest) => manifest.hostVersion === version) ?? rc022rc3
}

/** True when the version has a registered audited manifest. */
export function hasAuditedManifest(version: string | undefined | null): boolean {
  return AUDITED_HOST_MANIFESTS.some((manifest) => manifest.hostVersion === version)
}

/** Alternation regex covering every audited host version, for id matchers.
 * Wrapped in a non-capturing group: callers splice it into larger anchored
 * patterns, and a bare alternation would break their `^` anchoring. */
export const AUDITED_HOST_VERSIONS_REGEX: string = `(?:${AUDITED_HOST_MANIFESTS
  .map((manifest) => manifest.hostVersion.replaceAll('.', '\\.'))
  .join('|')})`

export default auditedManifestFor
