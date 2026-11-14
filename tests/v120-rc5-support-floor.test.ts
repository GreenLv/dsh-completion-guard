import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ACTIVE_HOST_COHORT_ID, EXPECTED_HOST_PACKAGES, evaluateGraphDerivedHostLock } from '../src/domain/host-lock.js'
import { evaluateConfiguredHostLock } from '../src/domain/host-resolver.js'
import { auditedManifestFor } from '../src/domain/audited-cohort-selection.js'
import { RC021_RC3_HOST_PACKAGES } from '../src/domain/rc021-rc3-host.js'
import { RC021_RC2_HOST_PACKAGES } from '../src/domain/rc021-rc2-host.js'
import { RC021_RC5_HOST_PACKAGES } from '../src/domain/rc021-rc5-host.js'
import { RC022_RC1_HOST_PACKAGES } from '../src/domain/rc022-rc1-host.js'
import { RC022_RC2_HOST_PACKAGES } from '../src/domain/rc022-rc2-host.js'
import { RC022_RC3_HOST_PACKAGES } from '../src/domain/rc022-rc3-host.js'

describe('0.13.2 >=0.2.2-rc.3 floor and default production contract', () => {
  it('keeps rc.3 as the sole active cohort, retires rc.2/rc.1/rc.5/rc.3 to historical evidence, and raises the floor', () => {
    const manifest = JSON.parse(readFileSync('manifests/supported-host.v1.json', 'utf8'))
    // The shipped supported-host rows record the 0.13.2 rc.3 baseline: the
    // rc.3 cohort is active, the retired 0.2.2-rc.2 upgrade source leads the
    // historical evidence list, and every entry keeps its exact audited
    // identities.
    expect(manifest.cohorts.map((row: { id: string }) => row.id)).toEqual(['dsh-0.2.2-rc.3-core-v1'])
    expect(manifest.historicalCohorts.map((row: { id: string }) => row.id)).toEqual([
      'dsh-0.2.2-rc.2-core-v1', 'dsh-0.2.2-rc.1-core-v1', 'dsh-0.2.1-rc.5-core-v1', 'dsh-0.2.1-rc.3-core-v1', 'dsh-0.2.1-rc.2-core-v1',
    ])
    expect(manifest.cohorts[0].packages).toEqual(RC022_RC3_HOST_PACKAGES)
    // The retired 0.2.2-rc.2 row keeps its recorded historical identity
    // verbatim: it is the retained upgrade source and refusal control, never
    // an admission channel after the 0.13.2 floor raise.
    expect(manifest.historicalCohorts[0].packages).toEqual(RC022_RC2_HOST_PACKAGES)
    expect(manifest.historicalCohorts[1].packages).toEqual(RC022_RC1_HOST_PACKAGES)
    expect(manifest.historicalCohorts[2].packages).toEqual(RC021_RC5_HOST_PACKAGES)
    expect(manifest.historicalCohorts[3].packages).toEqual(RC021_RC3_HOST_PACKAGES)
    expect(manifest.historicalCohorts[4].packages).toEqual(RC021_RC2_HOST_PACKAGES)
    expect(ACTIVE_HOST_COHORT_ID).toBe('dsh-0.2.2-rc.3')
    expect(EXPECTED_HOST_PACKAGES).toEqual(RC022_RC3_HOST_PACKAGES)
    expect(auditedManifestFor(undefined).hostVersion).toBe('0.2.2-rc.3')
    expect(auditedManifestFor('0.2.2-rc.3').hostVersion).toBe('0.2.2-rc.3')
    expect(auditedManifestFor('0.2.2-rc.2').hostVersion).toBe('0.2.2-rc.2')
    // The rc.1 audited manifest keeps its historical evidence identity; it is
    // byte/contract reference material, never an admission fallback.
    expect(auditedManifestFor('0.2.2-rc.1').hostVersion).toBe('0.2.2-rc.1')
    expect(auditedManifestFor('0.2.1-rc.3').hostVersion).toBe('0.2.1-rc.3')
    expect(auditedManifestFor('0.2.1-rc.5').hostVersion).toBe('0.2.1-rc.5')
    expect(auditedManifestFor('0.2.1-rc.2').hostVersion).toBe('0.2.1-rc.2')
  })

  for (const platform of ['posix', 'windows'] as const) {
    for (const profileKind of ['web', 'headless'] as const) {
      it(`admits the exact rc.3 cohort, refuses rc.2 and every pre-floor graph, and fails closed on mixed or altered graphs on ${platform}/${profileKind}`, () => {
        const context = { platform, profileKind }
        expect(evaluateConfiguredHostLock(RC022_RC3_HOST_PACKAGES, context)).toMatchObject({
          status: 'supported', cohortId: 'dsh-0.2.2-rc.3-core-v1',
          hostVersion: { status: 'supported', version: '0.2.2-rc.3', minimum: '0.2.2-rc.3' },
        })
        // The retained rc.2 graph refuses at the version gate: it is the
        // documented upgrade source, not an admission channel.
        expect(evaluateConfiguredHostLock(RC022_RC2_HOST_PACKAGES, context)).toMatchObject({
          status: 'unsupported', reasonCode: 'host_lock_version_below_minimum',
          hostVersion: { status: 'below_minimum', version: '0.2.2-rc.2', minimum: '0.2.2-rc.3' },
        })
        const altered = RC022_RC3_HOST_PACKAGES.map(row => row.name === '@deepseek-ai/dsh-session' ? { ...row, integrity: 'sha512-forged' } : row)
        expect(evaluateConfiguredHostLock(altered, context).status).toBe('unsupported')
        // The rc.2(0.2.2)/rc.5/rc.3(0.2.1) cohorts are historical evidence
        // below the raised floor: their exact reviewed graphs no longer admit,
        // and no receipt, cohort or receipt digest from them reopens the door.
        for (const [rows, version] of [[RC021_RC3_HOST_PACKAGES, '0.2.1-rc.3'], [RC021_RC5_HOST_PACKAGES, '0.2.1-rc.5'], [RC022_RC1_HOST_PACKAGES, '0.2.2-rc.1'], [RC022_RC2_HOST_PACKAGES, '0.2.2-rc.2']] as const) {
          expect(evaluateConfiguredHostLock(rows, context)).toMatchObject({
            status: 'unsupported', reasonCode: 'host_lock_version_below_minimum',
            hostVersion: { status: 'below_minimum', version, minimum: '0.2.2-rc.3' },
          })
        }
        const mixed = RC022_RC3_HOST_PACKAGES.map(row => row.name === '@deepseek-ai/dsh-session' ? RC022_RC2_HOST_PACKAGES.find(other => other.name === row.name)! : row)
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
