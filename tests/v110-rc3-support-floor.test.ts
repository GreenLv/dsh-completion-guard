import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ACTIVE_HOST_COHORT_ID, EXPECTED_HOST_PACKAGES, evaluateGraphDerivedHostLock } from '../src/domain/host-lock.js'
import { evaluateConfiguredHostLock } from '../src/domain/host-resolver.js'
import { auditedManifestFor } from '../src/domain/audited-cohort-selection.js'
import { RC021_RC2_HOST_PACKAGES } from '../src/domain/rc021-rc2-host.js'
import { RC021_RC3_HOST_PACKAGES } from '../src/domain/rc021-rc3-host.js'

describe('0.11.0 rc.3 support-floor production contract', () => {
  it('publishes rc.3 as current and preserves the exact rc.2 registry rows only as history', () => {
    const manifest = JSON.parse(readFileSync('manifests/supported-host.v1.json', 'utf8'))
    expect(manifest.cohorts.map((row: { id: string }) => row.id)).toEqual(['dsh-0.2.1-rc.3-core-v1'])
    expect(manifest.historicalCohorts.map((row: { id: string }) => row.id)).toEqual(['dsh-0.2.1-rc.2-core-v1'])
    expect(manifest.historicalCohorts[0].packages).toEqual(RC021_RC2_HOST_PACKAGES)
    expect(manifest.cohorts[0].packages).toEqual(RC021_RC3_HOST_PACKAGES)
    expect(ACTIVE_HOST_COHORT_ID).toBe('dsh-0.2.1-rc.3')
    expect(EXPECTED_HOST_PACKAGES).toEqual(RC021_RC3_HOST_PACKAGES)
    expect(auditedManifestFor(undefined).hostVersion).toBe('0.2.1-rc.3')
    expect(auditedManifestFor('0.2.1-rc.2').hostVersion).toBe('0.2.1-rc.2')
  })

  for (const platform of ['posix', 'windows'] as const) {
    it(`accepts the current exact graph and rejects the retired rc.2 through the real composed policy on ${platform}`, () => {
      const context = { platform, profileKind: 'headless' as const }
      expect(evaluateConfiguredHostLock(RC021_RC3_HOST_PACKAGES, context)).toMatchObject({
        status: 'supported', cohortId: 'dsh-0.2.1-rc.3-core-v1',
        hostVersion: { status: 'supported', minimum: '0.2.1-rc.3' },
      })
      expect(evaluateConfiguredHostLock(RC021_RC2_HOST_PACKAGES, context)).toMatchObject({
        status: 'unsupported', reasonCode: 'host_lock_version_below_minimum',
        hostVersion: { status: 'below_minimum', version: '0.2.1-rc.2' },
      })
      let rowVerificationCalls = 0
      const retiredTrustAttempt = evaluateGraphDerivedHostLock(RC021_RC2_HOST_PACKAGES, context, () => {
        rowVerificationCalls++
        return true
      })
      expect(retiredTrustAttempt).toMatchObject({ status: 'unsupported', reasonCode: 'host_lock_version_below_minimum' })
      expect(rowVerificationCalls).toBe(0)
    })
  }
})
