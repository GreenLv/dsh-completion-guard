import audit from '../../manifests/rc022-rc5-byte-audit.json' with { type: 'json' }
import type { ByteAuditManifest } from './byte-audit-manifest.js'

/** Registry-authenticated rc.5 bytes, independently retained from older hosts. */
export default audit as unknown as ByteAuditManifest
