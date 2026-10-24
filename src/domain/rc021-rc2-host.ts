import audit from './byte-audit-manifest.js'
import type { PackageRow } from './digest.js'

/** One source for verified registry identities and published executable bytes.
 * Bound to the published dsh-v0.2.1-rc.2 tarballs (upstream
 * 687f282e8625c6b8d11ff58211a90524be2e4317; Cordis moved to 4.0.5 in the same
 * graph). Native platform acceptance remains a separate, currently pending
 * fact. The 0.2.0-rc.2 rows remain available in `rc020-rc2-host.ts` as
 * historical evidence. */
export const RC021_RC2_HOST_PACKAGES: PackageRow[] = audit.packages.map(({ name, version, integrity }) => ({ name, version, integrity }))
