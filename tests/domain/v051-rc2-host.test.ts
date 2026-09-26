import { describe, expect, it } from 'vitest'
import { RC015_HOST_PACKAGES } from '../helpers/rc015-host.js'
import { RC015_RC2_HOST_PACKAGES } from '../helpers/rc015-rc2-host.js'
import { RC017_RC2_HOST_PACKAGES } from '../../src/domain/rc017-rc2-host.js'
import { HOST_COHORTS, evaluateHostLock } from '../../src/domain/host-lock.js'

describe('sole rc.2 cohort', () => {
  for (const platform of ['posix', 'windows'] as const) it(`rejects historical, mixed and incomplete graphs on ${platform}`, () => {
    expect(evaluateHostLock(RC017_RC2_HOST_PACKAGES, { platform })).toMatchObject({status: 'supported', cohortId: 'dsh-0.1.7-rc.2-core-v1', auditProvenance: 'registry-derived-pending-native-audit'})
    for (const old of [RC015_HOST_PACKAGES, RC015_RC2_HOST_PACKAGES]) {
      expect(evaluateHostLock(old, { platform }).status).toBe('unsupported')
      for (const row of old.filter(r => r.name.startsWith('@deepseek-ai/dsh'))) {
        const mixed = RC017_RC2_HOST_PACKAGES.map(r => r.name === row.name ? row : r)
        expect(evaluateHostLock(mixed, { platform }).status).not.toBe('supported')
      }
    }
    for (const row of RC017_RC2_HOST_PACKAGES) expect(evaluateHostLock(RC017_RC2_HOST_PACKAGES.filter(r => r !== row), { platform }).status).not.toBe('supported')
  })
  it('rejects rc.1, stable, future RC and forged integrity', () => {
    for (const version of ['0.1.7-rc.1', '0.1.7', '0.1.7-rc.3']) expect(evaluateHostLock(RC017_RC2_HOST_PACKAGES.map(r => r.version === '0.1.7-rc.2' ? {...r, version} : r)).status).toBe('unsupported')
    expect(evaluateHostLock(RC017_RC2_HOST_PACKAGES.map(r => ({...r, integrity: 'sha512-forged'}))).status).toBe('unsupported')
    expect(HOST_COHORTS.map(c => c.id)).toEqual(['dsh-0.1.7-rc.2-core-v1'])
  })
})
