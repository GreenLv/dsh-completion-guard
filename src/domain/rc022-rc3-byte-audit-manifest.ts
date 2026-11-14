import audit from '../../manifests/rc022-rc3-byte-audit.json' with { type: 'json' }
import type { ByteAuditManifest } from './byte-audit-manifest.js'

/**
 * Module wrapper for the frozen 0.2.2-rc.3 byte-audit manifest (same vitest-4
 * mock seam rationale as the other wrappers: one mockable TypeScript module;
 * the physical JSON stays the single source of truth). Kept SEPARATE from the
 * rc.2 wrapper so a suite narrowing the 0.2.2-rc.3 manifest never widens or
 * rewrites the retained 0.2.2-rc.2 cohort: both remain real published states.
 */
export default audit as unknown as ByteAuditManifest
