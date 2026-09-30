import audit from '../../manifests/rc020-rc2-byte-audit.json' with { type: 'json' }
import type { PackageRow } from './digest.js'

/** One source for verified registry identities and published executable bytes.
 * Bound to the published dsh-v0.2.0-rc.2 tarballs (upstream
 * 639ed015397290b3745d163aafe02ffee4aa3f84). Native platform acceptance
 * remains a separate, currently pending fact. The rc.1 rows remain available
 * in `rc020-rc1-host.ts` as historical evidence. */
export const RC020_RC2_HOST_PACKAGES: PackageRow[] = audit.packages.map(({ name, version, integrity }) => ({ name, version, integrity }))
