import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ACTIVE_HOST_COHORT_ID, EXPECTED_HOST_PACKAGES, evaluateGraphDerivedHostLock } from '../src/domain/host-lock.js'
import { evaluateConfiguredHostLock } from '../src/domain/host-resolver.js'
import { auditedManifestFor } from '../src/domain/audited-cohort-selection.js'
import { RC021_RC3_HOST_PACKAGES } from '../src/domain/rc021-rc3-host.js'
import { RC021_RC2_HOST_PACKAGES } from '../src/domain/rc021-rc2-host.js'
import { RC021_RC5_HOST_PACKAGES } from '../src/domain/rc021-rc5-host.js'
import { RC022_RC1_HOST_PACKAGES } from '../src/domain/rc022-rc1-host.js'

describe('0.13.0 0.2.2-rc.1 floor and default production contract', () => {
  it('keeps one active cohort, retires rc.5/rc.3 to historical evidence, and keeps rc.1 as the default', () => {
    const manifest = JSON.parse(readFileSync('manifests/supported-host.v1.json', 'utf8'))
    expect(manifest.cohorts.map((row: { id: string }) => row.id)).toEqual(['dsh-0.2.2-rc.1-core-v1'])
    expect(manifest.historicalCohorts.map((row: { id: string }) => row.id)).toEqual([
      'dsh-0.2.1-rc.5-core-v1', 'dsh-0.2.1-rc.3-core-v1', 'dsh-0.2.1-rc.2-core-v1',
    ])
    expect(manifest.cohorts[0].packages).toEqual(RC022_RC1_HOST_PACKAGES)
    expect(manifest.historicalCohorts[0].packages).toEqual(RC021_RC5_HOST_PACKAGES)
    expect(manifest.historicalCohorts[1].packages).toEqual(RC021_RC3_HOST_PACKAGES)
    expect(manifest.historicalCohorts[2].packages).toEqual(RC021_RC2_HOST_PACKAGES)
    expect(ACTIVE_HOST_COHORT_ID).toBe('dsh-0.2.2-rc.1')
    expect(EXPECTED_HOST_PACKAGES).toEqual(RC022_RC1_HOST_PACKAGES)
    expect(auditedManifestFor(undefined).hostVersion).toBe('0.2.2-rc.1')
    expect(auditedManifestFor('0.2.2-rc.1').hostVersion).toBe('0.2.2-rc.1')
    // The pre-floor audited manifests stay available as historical evidence
    // sources; they never reopen admission.
    expect(auditedManifestFor('0.2.1-rc.3').hostVersion).toBe('0.2.1-rc.3')
    expect(auditedManifestFor('0.2.1-rc.5').hostVersion).toBe('0.2.1-rc.5')
    expect(auditedManifestFor('0.2.1-rc.2').hostVersion).toBe('0.2.1-rc.2')
  })

  for (const platform of ['posix', 'windows'] as const) {
    for (const profileKind of ['web', 'headless'] as const) {
      it(`admits the exact rc.1 cohort, rejects every pre-floor graph and fails closed on mixed or altered graphs on ${platform}/${profileKind}`, () => {
        const context = { platform, profileKind }
        expect(evaluateConfiguredHostLock(RC022_RC1_HOST_PACKAGES, context)).toMatchObject({
          status: 'supported', cohortId: 'dsh-0.2.2-rc.1-core-v1',
          hostVersion: { status: 'supported', version: '0.2.2-rc.1', minimum: '0.2.2-rc.1' },
        })
        const altered = RC022_RC1_HOST_PACKAGES.map(row => row.name === '@deepseek-ai/dsh-session' ? { ...row, integrity: 'sha512-forged' } : row)
        expect(evaluateConfiguredHostLock(altered, context).status).toBe('unsupported')
        // The formerly active rc.3/rc.5 cohorts are historical evidence below
        // the raised floor: their exact reviewed graphs no longer admit, and
        // no receipt, cohort or receipt digest from them reopens the door.
        for (const [rows, version] of [[RC021_RC3_HOST_PACKAGES, '0.2.1-rc.3'], [RC021_RC5_HOST_PACKAGES, '0.2.1-rc.5']] as const) {
          expect(evaluateConfiguredHostLock(rows, context)).toMatchObject({
            status: 'unsupported', reasonCode: 'host_lock_version_below_minimum',
            hostVersion: { status: 'below_minimum', version, minimum: '0.2.2-rc.1' },
          })
        }
        const mixed = RC022_RC1_HOST_PACKAGES.map(row => row.name === '@deepseek-ai/dsh-session' ? RC021_RC5_HOST_PACKAGES.find(other => other.name === row.name)! : row)
        expect(evaluateConfiguredHostLock(mixed, context).status).toBe('unsupported')
        expect(evaluateConfiguredHostLock(RC021_RC2_HOST_PACKAGES, context)).toMatchObject({
          status: 'unsupported', reasonCode: 'host_lock_version_below_minimum',
          hostVersion: { status: 'below_minimum', version: '0.2.1-rc.2' },
        })
        let rowVerificationCalls = 0
        const retired = evaluateGraphDerivedHostLock(RC021_RC2_HOST_PACKAGES, context, () => {
          rowVerificationCalls++
          return true
        })
        expect(retired).toMatchObject({ status: 'unsupported', reasonCode: 'host_lock_version_below_minimum' })
        expect(rowVerificationCalls).toBe(0)
      })
    }
  }
})
