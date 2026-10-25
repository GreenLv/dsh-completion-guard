import rc2 from './byte-audit-manifest.js'
import rc3 from './rc3-byte-audit-manifest.js'

/**
 * Version-selected audited cohort manifest (RC3-D01): every registry-derived
 * expectation source — desktop cohort integrity rows, default audit
 * expectations, renderer identity regexes — must follow the ACTUAL acquired
 * runtime version instead of being pinned to the rc.2 manifest. Both
 * manifests share one audited schema; the rc.3 lib bytes are byte-identical
 * to rc.2 (verified per file by the rc.2→rc.3 study), so only the version
 * string differs between the two expectation sets.
 */
export const AUDITED_HOST_MANIFESTS: readonly (typeof rc2)[] = [rc2, rc3]

/** The audited manifest whose hostVersion matches, defaulting to the rc.2
 * baseline for callers whose graph version is not one of the audited
 * releases (those fail closed downstream on the version mismatch). */
export function auditedManifestFor(version: string | undefined | null): typeof rc2 {
  return AUDITED_HOST_MANIFESTS.find((manifest) => manifest.hostVersion === version) ?? rc2
}

/** True when the version has a registered audited manifest. */
export function hasAuditedManifest(version: string | undefined | null): boolean {
  return AUDITED_HOST_MANIFESTS.some((manifest) => manifest.hostVersion === version)
}

/** Alternation regex covering every audited host version, for id matchers. */
export const AUDITED_HOST_VERSIONS_REGEX: string = AUDITED_HOST_MANIFESTS
  .map((manifest) => manifest.hostVersion.replaceAll('.', '\\.'))
  .join('|')

export default auditedManifestFor
