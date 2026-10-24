import audit from '../../manifests/rc021-rc2-byte-audit.json' with { type: 'json' }

/**
 * Module wrapper for the frozen rc.2 byte-audit manifest. vitest 4 no longer
 * applies vi.mock to JSON modules imported transitively from source files, so
 * the audited baseline flows through this TypeScript module: consumers bind
 * to one mockable seam while production keeps importing the exact frozen JSON
 * bytes (tsdown inlines them into dist unchanged).
 */
export default audit
