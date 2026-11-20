import audit from './rc022-rc5-byte-audit-manifest.js'
import type { PackageRow } from './digest.js'

/** Exact published rc.5 core identities. Native acceptance is separate. */
export const RC022_RC5_HOST_PACKAGES: PackageRow[] = audit.packages.map(({ name, version, integrity }) => ({ name, version, integrity }))
