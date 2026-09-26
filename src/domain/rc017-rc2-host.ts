import audit from '../../manifests/rc017-rc2-byte-audit.json' with { type: 'json' }
import type { PackageRow } from './digest.js'

/** One source for verified registry identities and published executable bytes.
 * Native platform acceptance remains a separate, currently pending fact. */
export const RC017_RC2_HOST_PACKAGES: PackageRow[] = audit.packages.map(({ name, version, integrity }) => ({ name, version, integrity }))
