import qualification from '../../manifests/desktop-distribution.v1.json' with { type: 'json' }

/**
 * Module wrapper for the frozen Desktop distribution manifest (same reason as
 * byte-audit-manifest: one mockable TypeScript seam; the physical JSON stays
 * the single source of truth).
 */
export default qualification
