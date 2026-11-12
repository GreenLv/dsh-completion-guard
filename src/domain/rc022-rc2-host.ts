import audit from './rc022-rc2-byte-audit-manifest.js'
import type { PackageRow } from './digest.js'

/** One source for verified registry identities and published executable bytes.
 * Bound to the published dsh-v0.2.2-rc.2 tarballs (upstream
 * ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c). This is an additive
 * interface cohort over the reviewed rc.1 graph: the same 51 audited
 * packages resolve at rc.2 versions (@deepseek-ai/cordis stays at the
 * reviewed 4.1.0), with real published-byte changes in the session batch
 * append, tool error identity, working-directory access waterfall,
 * sandbox-policy session grants, jobs error codes, plugin-manager update
 * flows and app-boot platform/env admission. Every tarball was re-verified
 * against the registry (SRI + SHA-256) during acquisition; no "bytes
 * unchanged" conclusion is reused from the rc.1 study. Cohort admission is
 * separate from native platform acceptance. The rc.1 rows stay available in
 * `rc022-rc1-host.ts` as a historical graph below the current floor. */
export const RC022_RC2_HOST_PACKAGES: PackageRow[] = audit.packages.map(({ name, version, integrity }) => ({ name, version, integrity }))
