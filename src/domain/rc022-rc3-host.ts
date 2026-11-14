import audit from './rc022-rc3-byte-audit-manifest.js'
import type { PackageRow } from './digest.js'

/** One source for verified registry identities and published executable bytes.
 * Bound to the published dsh-v0.2.2-rc.3 tarballs (upstream
 * 38a6a5c965aa99ab525161efb7cc5cf1fe62fced). This is an additive interface
 * cohort over the reviewed rc.2 graph: the same 51 audited packages resolve
 * at rc.3 versions (@deepseek-ai/cordis stays at the reviewed 4.1.0). The
 * rc.2→rc.3 upstream delta (6 commits, 515 files) changes real published
 * bytes only in `@deepseek-ai/dsh-official-bundles` (chat-export session
 * import constants); the other 50 packages keep byte-identical lib files
 * while 47 package manifests carry rewritten version/dependency fields, so
 * each row still re-verifies its own loading digest. Every tarball was
 * re-verified against the registry (SRI + SHA-256) during acquisition; no
 * "bytes unchanged" conclusion is reused from the rc.2 study. Cohort
 * admission is separate from native platform acceptance. The rc.2 rows stay
 * available in `rc022-rc2-host.ts` as a historical graph below the raised
 * floor. */
export const RC022_RC3_HOST_PACKAGES: PackageRow[] = audit.packages.map(({ name, version, integrity }) => ({ name, version, integrity }))
