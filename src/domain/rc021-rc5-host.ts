import audit from './rc5-byte-audit-manifest.js'
import type { PackageRow } from './digest.js'

/** One source for verified registry identities and published executable bytes.
 * Bound to the published dsh-v0.2.1-rc.5 tarballs (upstream
 * b830ec950faba0a46dda564be3e2d854afed94f1). The rc.3→rc.5 study verified that
 * every core-cohort package's executable bytes are UNCHANGED (the rc.4/rc.5
 * functional commits touch only client-UI rendering, MCP resource gating and
 * LLM account diagnostics outside this cohort) and that only manifest
 * version/dependency fields were rewritten; dependency routing is unchanged
 * and Cordis remains the shared 4.0.5 release. Cohort admission is separate
 * from native platform acceptance. The rc.3 rows stay available in
 * `rc021-rc3-host.ts` as historical evidence. */
export const RC021_RC5_HOST_PACKAGES: PackageRow[] = audit.packages.map(({ name, version, integrity }) => ({ name, version, integrity }))
