import { describe, expect, it } from 'vitest'
import { RC015_HOST_PACKAGES } from '../../src/domain/rc015-host.js'
import { RC015_RC2_HOST_PACKAGES } from '../../src/domain/rc015-rc2-host.js'
import { evaluateHostLock, HOST_COHORTS, selectHostCohort } from '../../src/domain/host-lock.js'

describe('DSH 0.1.5 rc.1 and rc.2 exact support', () => {
  it.each(['posix', 'windows'] as const)('accepts each complete graph and rejects every mixed package on %s', (platform) => {
    for (const [version, rows] of [['rc.1', RC015_HOST_PACKAGES], ['rc.2', RC015_RC2_HOST_PACKAGES]] as const) {
      expect(evaluateHostLock(rows, { platform, profileKind: 'web' })).toMatchObject({
        status: 'supported', cohortId: `dsh-0.1.5-${version}-core-v1`,
        auditProvenance: 'registry-derived-pending-native-audit',
      })
    }
    for (const row of RC015_RC2_HOST_PACKAGES.filter((r) => r.name !== '@deepseek-ai/cordis')) {
      const mixed = RC015_HOST_PACKAGES.map((r) => r.name === row.name ? row : r)
      expect(selectHostCohort(mixed, platform).consistent).toBe(false)
      expect(evaluateHostLock(mixed, { platform }).status).toBe('unsupported')
      expect(evaluateHostLock(RC015_RC2_HOST_PACKAGES.filter((r) => r.name !== row.name), { platform }).status).toBe('unavailable')
    }
  })
  it('does not admit an unregistered later RC or forged integrity', () => {
    expect(HOST_COHORTS.map((r) => r.id)).toEqual(['dsh-0.1.5-rc.1-core-v1', 'dsh-0.1.5-rc.2-core-v1'])
    const future = RC015_RC2_HOST_PACKAGES.map((r) => r.version === '0.1.5-rc.2' ? { ...r, version: '0.1.5-rc.3' } : r)
    expect(evaluateHostLock(future).status).toBe('unsupported')
    const forged = RC015_RC2_HOST_PACKAGES.map((r) => ({ ...r, integrity: 'sha512-forged' }))
    expect(evaluateHostLock(forged).status).toBe('unsupported')
  })
})
