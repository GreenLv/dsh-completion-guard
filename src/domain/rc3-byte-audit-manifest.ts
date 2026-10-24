import audit from '../../manifests/rc021-rc3-byte-audit.json' with { type: 'json' }

/**
 * Module wrapper for the frozen rc.3 byte-audit manifest (same vitest-4 mock
 * seam rationale as byte-audit-manifest: one mockable TypeScript module; the
 * physical JSON stays the single source of truth). Kept SEPARATE from the
 * rc.2 wrapper so a suite narrowing the rc.2 manifest never widens the rc.3
 * cohort.
 */
export default audit
