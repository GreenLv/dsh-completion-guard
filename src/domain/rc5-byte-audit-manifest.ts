import audit from '../../manifests/rc021-rc5-byte-audit.json' with { type: 'json' }
import type { ByteAuditManifest } from './byte-audit-manifest.js'

/**
 * Module wrapper for the frozen rc.5 byte-audit manifest (same vitest-4 mock
 * seam rationale as byte-audit-manifest: one mockable TypeScript module; the
 * physical JSON stays the single source of truth). Kept SEPARATE from the
 * rc.2/rc.3 wrappers so a suite narrowing an older manifest never widens the
 * rc.5 cohort.
 */
export default audit as unknown as ByteAuditManifest
