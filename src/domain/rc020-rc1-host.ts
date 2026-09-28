import audit from '../../manifests/rc020-rc1-byte-audit.json' with { type: 'json' }
import type { PackageRow } from './digest.js'

/** One source for verified registry identities and published executable bytes.
 * Bound to the published dsh-v0.2.0-rc.1 tarballs (upstream
 * 4878cdabd87d4041bdaff61d04c966883b9fd07a). Native platform acceptance
 * remains a separate, currently pending fact. */
export const RC020_RC1_HOST_PACKAGES: PackageRow[] = audit.packages.map(({ name, version, integrity }) => ({ name, version, integrity }))
