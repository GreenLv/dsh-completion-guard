import audit from './rc3-byte-audit-manifest.js'
import type { PackageRow } from './digest.js'

/** One source for verified registry identities and published executable bytes.
 * Bound to the published dsh-v0.2.1-rc.3 tarballs (upstream
 * 1f81c047fc48fa190a683e469daa699857e9afe8). The rc.2→rc.3 study verified that
 * every core-cohort package's executable bytes are UNCHANGED (the four rc.3
 * functional commits touch only UI/llm-route packages outside this cohort) and
 * that only manifest version/dependency fields were rewritten; Cordis remains
 * the shared 4.0.5 release in both graphs. Cohort admission is separate from
 * native platform acceptance, which remains pending for rc.3. The rc.2 rows
 * stay available in `rc021-rc2-host.ts` as a supported path. */
export const RC021_RC3_HOST_PACKAGES: PackageRow[] = audit.packages.map(({ name, version, integrity }) => ({ name, version, integrity }))
