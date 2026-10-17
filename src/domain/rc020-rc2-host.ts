import audit from '../../manifests/rc020-rc2-byte-audit.json' with { type: 'json' }
import type { PackageRow } from './digest.js'

/** One source for verified registry identities and published executable bytes.
 * Historical evidence for the 0.2.0-rc.2 floor era: bound to the published
 * dsh-v0.2.0-rc.2 tarballs (upstream 639ed015397290b3745d163aafe02ffee4aa3f84).
 * The active cohort reads `rc021-rc2-host.ts`; these rows back the
 * below-floor refusal tests and prior-certificate history only. */
export const RC020_RC2_HOST_PACKAGES: PackageRow[] = audit.packages.map(({ name, version, integrity }) => ({ name, version, integrity }))
