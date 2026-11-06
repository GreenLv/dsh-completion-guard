import audit from './rc022-rc1-byte-audit-manifest.js'
import type { PackageRow } from './digest.js'

/** One source for verified registry identities and published executable bytes.
 * Bound to the published dsh-v0.2.2-rc.1 tarballs (upstream
 * 66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db). This cohort is a REAL interface
 * migration, not a rc.3→rc.5-style byte-stable bump: the tools service moved
 * to batch execution with per-step admission (ToolBatchInput/ToolBatchResult),
 * executors split into native/PTC plugins (dsh-tool-executor-native /
 * dsh-tool-executor-ptc), session projection registration became an awaited
 * resource acquisition, official-bundle constants moved to
 * @deepseek-ai/dsh-official-bundles, and the fs core gained dsh-fs-patch.
 * The closure therefore extends the reviewed rc.5 core set with those five
 * members (Cordis advances to 4.1.0) and every tarball is re-verified against
 * the registry (SRI + SHA-256) — no "bytes unchanged" conclusion is reused.
 * Cohort admission is separate from native platform acceptance. The rc.5 and
 * rc.3 rows stay available in `rc021-rc5-host.ts`/`rc021-rc3-host.ts` as
 * historical evidence below this release's floor. */
export const RC022_RC1_HOST_PACKAGES: PackageRow[] = audit.packages.map(({ name, version, integrity }) => ({ name, version, integrity }))
