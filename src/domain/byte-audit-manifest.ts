import audit from '../../manifests/rc021-rc2-byte-audit.json' with { type: 'json' }

/**
 * Module wrapper for the frozen rc.2 byte-audit manifest. vitest 4 no longer
 * applies vi.mock to JSON modules imported transitively from source files, so
 * the audited baseline flows through this TypeScript module: consumers bind
 * to one mockable seam while production keeps importing the exact frozen JSON
 * bytes (tsdown inlines them into dist unchanged).
 */
export default audit as unknown as ByteAuditManifest

/** Structural shape shared by every audited byte-audit manifest
 * (`dsh-host-byte-audit/v1`). The rc.2/rc.3/rc.5 manifests are byte-identical
 * cohorts so their literal JSON types used to coincide; the 0.2.2-rc.1
 * manifest has a different package set, so consumers that hold all audited
 * manifests in one collection type against this widened interface instead of
 * one manifest's literal tuple type. Field-level audit semantics are
 * unchanged: modules/programs stay per-file SHA-256 maps and loadingDigest
 * stays the canonical package-manifest field digest. */
export interface ByteAuditPackageRow {
  name: string
  version: string
  integrity: string
  tarball: string
  sha256: string
  modules: Record<string, string>
  programs: Record<string, string>
  loadingDigest: string
}

export interface ByteAuditManifest {
  schema: string
  hostVersion: string
  upstreamCommit: string
  auditedPlatforms: readonly string[]
  packages: readonly ByteAuditPackageRow[]
}
