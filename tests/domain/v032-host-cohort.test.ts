import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  ACTIVE_HOST_COHORT_ID,
  BASE_HOST_PACKAGES,
  EXPECTED_HOST_PACKAGES,
  HOST_COHORTS as CORE_HOST_COHORTS,
  LEGACY_HOST_COHORTS as HOST_COHORTS,
  evaluateHostCapability,
  evaluateHostLock,
  selectHostCohort,
} from '../../src/domain/host-lock.js'
import { hostLockDigest } from '../../src/domain/digest.js'
import { ALPHA3_HOST_PACKAGES } from '../../src/domain/alpha3-host.js'
import { RC1_HOST_PACKAGES } from '../../src/domain/rc1-host.js'
import { RC015_HOST_PACKAGES } from '../../src/domain/rc015-host.js'
import { ALPHA2_HOST_PACKAGES, ALPHA2_DSHMARKET_139_HOST_PACKAGES } from '../../src/domain/host-lock.js'
import {
  MIN_SUPPORTED_HOST_VERSION,
  SUPPORTED_HOST_RANGE,
  satisfiesSupportedHostRange,
} from '../../src/domain/host-version.js'

const rc2Cohort = HOST_COHORTS.find((cohort) => cohort.id === 'dsh-0.1.1-rc.2')!
const alpha2Cohort = HOST_COHORTS.find((cohort) => cohort.id === 'dsh-0.1.2-alpha.2')!
const alpha2Market139Cohort = HOST_COHORTS.find((cohort) => cohort.id === 'dsh-0.1.2-alpha.2-dshmarket-1.39.0')!
const alpha3Cohort = HOST_COHORTS.find((cohort) => cohort.id === 'dsh-0.1.2-alpha.3')!
const rc1Cohort = HOST_COHORTS.find((cohort) => cohort.id === 'dsh-0.1.2-rc.1')!
const rc015Cohort = HOST_COHORTS.find((cohort) => cohort.id === 'dsh-0.1.5-rc.1')!
const ACTIVE_COHORT_ID = `${ACTIVE_HOST_COHORT_ID}-core-v1`

describe('audited host cohort registry', () => {
  it('registers exactly the six cohorts with disjoint registered graphs', () => {
    expect(HOST_COHORTS.map((cohort) => cohort.id)).toEqual([
      'dsh-0.1.1-rc.2',
      'dsh-0.1.2-alpha.2',
      'dsh-0.1.2-alpha.2-dshmarket-1.39.0',
      'dsh-0.1.2-alpha.3',
      'dsh-0.1.2-rc.1',
      'dsh-0.1.5-rc.1',
    ])
    for (const cohort of HOST_COHORTS) {
      expect(new Set(cohort.packages.map((row) => row.name)).size).toBe(cohort.packages.length)
      expect(cohort.packages.every((row) => row.version && row.integrity?.startsWith('sha512-'))).toBe(true)
      expect(cohort.capabilities[0]).toEqual({ name: 'host_cohort', value: { k: 's', v: cohort.id } })
    }
    // Every older cohort carries the full 34-row market-inclusive identity; the
    // 0.1.5-rc.1 core excludes dshmarket by design (market identity is verified
    // by the action adapter, never by the core lock).
    for (const cohort of [rc2Cohort, alpha2Cohort, alpha2Market139Cohort, alpha3Cohort, rc1Cohort]) {
      expect(cohort.packages).toHaveLength(34)
    }
    expect(rc015Cohort.packages).toHaveLength(33)
    expect(rc015Cohort.packages.some((row) => row.name === 'dshmarket')).toBe(false)
    for (const cohort of [rc2Cohort, alpha2Cohort, alpha2Market139Cohort, alpha3Cohort, rc1Cohort]) {
      expect(cohort.auditedPlatforms).toEqual(['posix', 'windows'])
      expect(cohort.acceptedPlatforms).toEqual(['posix', 'windows'])
      expect(cohort.auditProvenance).toBe('native-audited')
    }
    // All cohorts use one complete package-name universe, minus the market row.
    const nameUniverse = rc2Cohort.packages.map((row) => row.name).sort()
    expect(alpha2Cohort.packages.map((row) => row.name).sort()).toEqual(nameUniverse)
    expect(alpha3Cohort.packages.map((row) => row.name).sort()).toEqual(nameUniverse)
    expect(rc1Cohort.packages.map((row) => row.name).sort()).toEqual(nameUniverse)
    expect(rc015Cohort.packages.map((row) => row.name).sort())
      .toEqual(nameUniverse.filter((name) => name !== 'dshmarket'))
    expect(alpha3Cohort.packages.find((row) => row.name === 'dshmarket')?.version).toBe('1.39.0')
    expect(alpha3Cohort.packages.some((row) => row.name.includes('skin-center'))).toBe(false)
    expect(rc1Cohort.packages.find((row) => row.name === 'dshmarket')?.version).toBe('1.41.0')
    expect(rc1Cohort.packages.some((row) => row.name.includes('skin-center'))).toBe(false)
    const alphaVersions = new Set(alpha2Cohort.packages.map((row) => row.version))
    expect(alphaVersions).toEqual(new Set(['0.1.2-alpha.2', '4.0.2', '1.38.1']))
    expect(alpha2Cohort.packages.find((row) => row.name === '@deepseek-ai/cordis')?.version).toBe('4.0.2')
    expect(alpha2Cohort.packages.find((row) => row.name === 'dshmarket')?.version).toBe('1.38.1')
  })

  it('carries the exact upgraded-Windows graph as one audited cohort (W1)', () => {
    // Only the dshmarket identity differs from the alpha.2 cohort; every other
    // row is byte-identical to the natively audited alpha.2 graph.
    const differing = ALPHA2_HOST_PACKAGES.filter((row) => {
      const counterpart = ALPHA2_DSHMARKET_139_HOST_PACKAGES.find((entry) => entry.name === row.name)!
      return counterpart.version !== row.version || counterpart.integrity !== row.integrity
    }).map((row) => row.name)
    expect(differing).toEqual(['dshmarket'])
    expect(alpha2Market139Cohort.packages.find((row) => row.name === 'dshmarket')).toEqual(
      alpha3Cohort.packages.find((row) => row.name === 'dshmarket'),
    )
    expect(alpha2Market139Cohort.supportedGoalVersions).toEqual(['0.1.2-alpha.2'])
    expect(alpha2Market139Cohort.packages.some((row) => row.name.includes('skin-center'))).toBe(false)
  })

  it('records the 0.1.5-rc.1 active cohort as registry-derived, not natively audited', () => {
    // The rows are the exact published registry identities, so the graph lock
    // can certify them, but no native host load has happened in this round:
    // the cohort must say so rather than implying a platform audit.
    expect(rc015Cohort.auditProvenance).toBe('registry-derived-pending-native-audit')
    expect(rc015Cohort.auditedPlatforms).toEqual([])
    expect(rc015Cohort.acceptedPlatforms).toEqual(['posix', 'windows'])
    expect(rc015Cohort.supportedGoalVersions).toEqual(['0.1.5-rc.1'])
    const evaluation = evaluateHostLock(RC015_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' })
    expect(evaluation.auditProvenance).toBe('registry-derived-pending-native-audit')
    expect(CORE_HOST_COHORTS[0].auditProvenance).toBe('registry-derived-pending-native-audit')
    expect(CORE_HOST_COHORTS[0].capabilities).toContainEqual({
      name: 'host_audit_provenance',
      value: { k: 's', v: 'registry-derived-pending-native-audit' },
    })
  })

  it('binds audit provenance into the digest, which is what stops a native certificate being reused', () => {
    // The whole "registry-derived but accepted" design rests on this: if the
    // provenance did not move the digest, a graph that was never loaded on a
    // native host would produce the SAME host identity as one that was, and a
    // certificate could be presented as a native pass. Presence of the row is
    // asserted elsewhere; here the digest itself is the assertion.
    const cohort = CORE_HOST_COHORTS[0]
    const context = { platform: 'posix' as const, profileKind: 'web' as const }
    const digestFor = (provenance: string) => hostLockDigest({
      manifestVersion: cohort.manifestVersion,
      supportedGoalVersions: [...cohort.supportedGoalVersions],
      capabilities: [
        ...cohort.capabilities.map((row) => row.name === 'host_audit_provenance'
          ? { name: row.name, value: { k: 's' as const, v: provenance } }
          : row),
        { name: 'active_platform', value: { k: 's' as const, v: context.platform } },
        { name: 'active_profile', value: { k: 's' as const, v: context.profileKind } },
      ],
      packages: [...cohort.packages],
    })
    const native = digestFor('native-audited')
    const registryDerived = digestFor('registry-derived-pending-native-audit')
    expect(registryDerived).not.toBe(native)
    // The replication above is faithful: it reproduces the digests the real
    // evaluation reports, so the difference is attributable to provenance alone.
    expect(registryDerived).toBe(evaluateHostLock(RC015_HOST_PACKAGES, context).digest)
    expect(cohort.auditProvenance).toBe('registry-derived-pending-native-audit')
    // The same graph evaluated as if it had been natively audited is exactly the
    // identity that must NOT be reachable in this round.
    expect(evaluateHostLock(RC015_HOST_PACKAGES, context).digest).not.toBe(native)
  })

  it('selects the active 0.1.5-rc.1 cohort atomically and closes every historical cohort', () => {
    // 0.5.1 support policy: the active allowlist is exactly 0.1.5-rc.1.
    // Historical audited graphs keep their identities in LEGACY_HOST_COHORTS as
    // verification data but are no longer active support entries.
    const active = selectHostCohort(EXPECTED_HOST_PACKAGES)
    expect(active.consistent).toBe(true)
    expect(active.cohort.id).toBe(ACTIVE_COHORT_ID)
    for (const historical of [rc2Cohort, alpha2Cohort, alpha2Market139Cohort, alpha3Cohort, rc1Cohort]) {
      expect(evaluateHostLock(historical.packages, { platform: 'posix', profileKind: 'web' }).status).toBe('unsupported')
    }
    const rc1 = evaluateHostLock(rc1Cohort.packages, { platform: 'posix', profileKind: 'web' })
    expect(rc1.status).toBe('unsupported')
    expect(rc1.reasonCode).toBe('host_lock_version_mismatch')
    const current = evaluateHostLock(rc015Cohort.packages, { platform: 'posix', profileKind: 'web' })
    expect(current).toMatchObject({ status: 'supported', cohortId: ACTIVE_COHORT_ID })
    expect(current.capabilities.web_control.status).toBe('supported')
    // CG-DSH-001: the audited cohort is one indivisible whole-graph contract;
    // a graph missing audited rows never selects consistently.
    const baseOnly = selectHostCohort(EXPECTED_HOST_PACKAGES.filter((row) => BASE_HOST_PACKAGES.has(row.name)))
    expect(baseOnly.consistent).toBe(false)
    expect(baseOnly.cohort.id).toBe(ACTIVE_COHORT_ID)
    expect(baseOnly.reasonCode).toBe('host_cohort_incomplete_graph')
    const missingMarket = evaluateHostLock(
      EXPECTED_HOST_PACKAGES.filter((row) => row.name !== 'dshmarket'),
      { platform: 'posix', profileKind: 'headless' },
    )
    expect(missingMarket.status).toBe('supported')
    expect(missingMarket.reasonCode).toBeUndefined()
    expect(missingMarket.missingPackages).toEqual([])
  })

  it('fails closed on graphs that mix active rows with foreign-cohort rows', () => {
    const mixed = [
      ...EXPECTED_HOST_PACKAGES.filter((row) => BASE_HOST_PACKAGES.has(row.name)),
      ...alpha2Cohort.packages.filter((row) => ['@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-shell'].includes(row.name)),
    ]
    const selection = selectHostCohort(mixed, 'posix')
    expect(selection.consistent).toBe(false)
    expect(selection.reasonCode).toBe('host_cohort_version_mismatch')
    const evaluation = evaluateHostLock(mixed, { platform: 'posix', profileKind: 'headless' })
    expect(evaluation.status).toBe('unsupported')
    expect(evaluation.reasonCode).toBe('host_lock_version_mismatch')
    const mixedAndDrifted = [
      ...mixed,
      { name: 'dshmarket', version: '99.0.0', integrity: 'sha512-drift' },
    ]
    expect(selectHostCohort(mixedAndDrifted, 'posix').reasonCode).toBe('host_cohort_version_mismatch')
  })

  it('fails the exact alpha.2 graph closed on its formerly audited Windows platform', () => {
    // The alpha.2 identities stay audited history, but the active allowlist no
    // longer admits them: an installed alpha.2 runtime is unsupported, on the
    // platform it was once audited on as everywhere else.
    const windowsAlpha = evaluateHostLock(alpha2Cohort.packages, { platform: 'windows', profileKind: 'web' })
    expect(windowsAlpha.status).toBe('unsupported')
    expect(windowsAlpha.reasonCode).toBe('host_lock_version_mismatch')
    const selection = selectHostCohort(alpha2Cohort.packages, 'windows')
    expect(selection.consistent).toBe(false)
    expect(selection.reasonCode).toBe('host_cohort_version_mismatch')
  })

  it('evaluates the active cohort identically on posix and windows without claiming a native audit', () => {
    // Both platforms resolve the same registry rows to the same verdict; the
    // difference from a natively audited cohort is reported through
    // `auditProvenance`, never hidden.
    for (const platform of ['posix', 'windows'] as const) {
      expect(selectHostCohort(RC015_HOST_PACKAGES, platform)).toMatchObject({
        consistent: true,
        cohort: { id: ACTIVE_COHORT_ID },
      })
      const evaluation = evaluateHostLock(RC015_HOST_PACKAGES, { platform, profileKind: 'web' })
      expect(evaluation).toMatchObject({ status: 'supported', cohortId: ACTIVE_COHORT_ID })
      expect(evaluation.auditProvenance).toBe('registry-derived-pending-native-audit')
    }
  })

  it('isolates market drift while core duplicates, missing identities and integrity changes fail closed', () => {
    const base = evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'headless' })
    for (const optionalRows of [
      [{ name: 'dshmarket', version: '99.0.0', integrity: 'sha512-drift' }],
      [{ name: 'dshmarket' }],
      [{ name: 'dshmarket' }, { name: 'dshmarket' }],
    ]) {
      const current = evaluateHostLock([...EXPECTED_HOST_PACKAGES, ...optionalRows], { platform: 'posix', profileKind: 'headless' })
      expect(current.status).toBe('supported')
      expect(current.digest).toBe(base.digest)
    }
    const drift = EXPECTED_HOST_PACKAGES.map((row) => row.name === '@deepseek-ai/dsh-session' ? { ...row, integrity: 'sha512-drift' } : row)
    expect(evaluateHostLock(drift).reasonCode).toBe('host_lock_integrity_mismatch')
    expect(evaluateHostLock([...EXPECTED_HOST_PACKAGES, EXPECTED_HOST_PACKAGES[0]]).reasonCode).toBe('host_lock_duplicate_package')
    const unbound = EXPECTED_HOST_PACKAGES.map((row) => row.name === '@deepseek-ai/dsh-session' ? { name: row.name } : row)
    expect(evaluateHostLock(unbound).status).not.toBe('supported')
  })

  it('classifies unknown names, unknown versions, and unbound identities fail-closed', () => {
    expect(selectHostCohort([{ name: '@deepseek-ai/unknown' }]).reasonCode).toBe('host_cohort_unknown_package')
    expect(evaluateHostLock([{ name: '@deepseek-ai/unknown' }]).reasonCode).toBe('host_lock_unknown_package')
    // A version registered in NO cohort stays a version mismatch — including
    // versions that were audited for now-historical cohorts.
    const unknownVersion = alpha2Cohort.packages.map((row) => row.name === '@deepseek-ai/dsh-agent'
      ? { ...row, version: '0.1.2-beta.1' }
      : row)
    expect(selectHostCohort(unknownVersion, 'posix').reasonCode).toBe('host_cohort_version_mismatch')
    expect(evaluateHostLock(unknownVersion, { platform: 'posix' }).status).toBe('unsupported')
    // A HIGHER version that no cohort registers is also a version mismatch: the
    // The exact rc.2-or-rc.1 policy never admits an unaudited graph.
    const futureVersion = EXPECTED_HOST_PACKAGES.map((row) => row.name === '@deepseek-ai/dsh-agent'
      ? { ...row, version: '0.1.6-rc.1' }
      : row)
    expect(selectHostCohort(futureVersion, 'posix').reasonCode).toBe('host_cohort_version_mismatch')
    expect(evaluateHostLock(futureVersion, { platform: 'posix' }).status).toBe('unsupported')
    // A version known from the active cohort with a foreign integrity is an
    // integrity mismatch.
    const foreignIntegrity = EXPECTED_HOST_PACKAGES.map((row) => row.name === '@deepseek-ai/dsh-agent'
      ? { ...row, integrity: 'sha512-foreign' }
      : row)
    expect(selectHostCohort(foreignIntegrity, 'posix').reasonCode).toBe('host_cohort_integrity_mismatch')
    expect(evaluateHostLock(foreignIntegrity, { platform: 'posix' }).status).toBe('unsupported')
    expect(selectHostCohort([{ name: '@deepseek-ai/dsh-agent' }]).reasonCode).toBe('host_cohort_unbound_identity')
    const integrityDrift = EXPECTED_HOST_PACKAGES.map((row) => row.name === '@deepseek-ai/dsh-goal'
      ? { ...row, integrity: 'sha512-drift' }
      : row)
    expect(selectHostCohort(integrityDrift, 'posix').reasonCode).toBe('host_cohort_integrity_mismatch')
    expect(selectHostCohort([], 'posix').consistent).toBe(false)
  })

  it('binds hostLockDigest to the active cohort so a cohort switch stales old certificates', () => {
    const current = evaluateHostLock(RC015_HOST_PACKAGES, { platform: 'posix' })
    expect(current.status).toBe('supported')
    expect(current.digest).toMatch(/^[0-9a-f]{64}$/)
    const again = evaluateHostLock(RC015_HOST_PACKAGES, { platform: 'posix' })
    expect(again.digest).toBe(current.digest)
    for (const historical of [
      rc2Cohort.packages, alpha2Cohort.packages, ALPHA2_DSHMARKET_139_HOST_PACKAGES,
      ALPHA3_HOST_PACKAGES, RC1_HOST_PACKAGES,
    ]) {
      expect(evaluateHostLock(historical, { platform: 'posix' }).status).toBe('unsupported')
    }
  })

  it('advertises only the verified minimum and latest DSH releases', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      engines: Record<string, string>
      dsh: { engines: Record<string, string> }
      peerDependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    const peers = manifest.peerDependencies
    expect(manifest.engines.dsh).toBe(SUPPORTED_HOST_RANGE)
    expect(manifest.dsh.engines.dsh).toBe(SUPPORTED_HOST_RANGE)
    expect(peers['@deepseek-ai/cordis']).toBe('^4.0.2')
    for (const name of ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-commands', '@deepseek-ai/dsh-goal', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-tool-goal', '@deepseek-ai/dsh-tools']) {
      expect(peers[name]).toBe(SUPPORTED_HOST_RANGE)
    }
    expect(SUPPORTED_HOST_RANGE).toBe('0.1.5-rc.2 || 0.1.5-rc.1')
    for (const version of ['0.1.5-rc.2', MIN_SUPPORTED_HOST_VERSION]) {
      expect(satisfiesSupportedHostRange(version)).toBe(true)
    }
    for (const version of ['0.1.5', '0.1.6', '0.1.6-rc.1', '0.2.0']) {
      expect(satisfiesSupportedHostRange(version)).toBe(false)
    }
    expect(Object.values(peers)).not.toContain('*')
    expect(Object.values(peers).some((range) => /0\.1\.1|alpha/.test(range))).toBe(false)
    // Development dependencies retain the verified minimum as the build baseline.
    for (const name of ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-tools']) {
      expect(manifest.devDependencies[name]).toBe(MIN_SUPPORTED_HOST_VERSION)
    }
  })
})

describe('v0.4.0 dshmarket web_control compatibility projection (W1)', () => {
  // Historical dshmarket combinations keep their audited identities, but the
  // active allowlist is 0.1.5-rc.1-only: every historical combination fails
  // closed instead of locking supported, on both platforms.
  const historicalCombinations = [
    { label: 'rc.2 + dshmarket 1.36.0', rows: rc2Cohort.packages },
    { label: 'alpha.2 + dshmarket 1.38.1', rows: alpha2Cohort.packages },
    { label: 'alpha.2 + dshmarket 1.39.0 (upgraded Windows path)', rows: alpha2Market139Cohort.packages },
    { label: 'alpha.3 + dshmarket 1.39.0', rows: alpha3Cohort.packages },
    { label: 'rc.1 + dshmarket 1.41.0', rows: rc1Cohort.packages },
  ] as const
  for (const combination of historicalCombinations) {
    it(`fails the historical combination closed: ${combination.label}`, () => {
      for (const platform of ['posix', 'windows'] as const) {
        const evaluation = evaluateHostLock(combination.rows, { platform, profileKind: 'web' })
        expect(evaluation.status).toBe('unsupported')
        expect(evaluateHostCapability(evaluation, { action: 'apply', platform, profileKind: 'web' }).status).not.toBe('supported')
      }
    })
  }

  it('locks the 0.1.5-rc.1 core as the supported web_control target on both platforms', () => {
    for (const platform of ['posix', 'windows'] as const) {
      const evaluation = evaluateHostLock(rc015Cohort.packages, { platform, profileKind: 'web' })
      expect(evaluation).toMatchObject({ status: 'supported', cohortId: ACTIVE_COHORT_ID })
      expect(evaluation.capabilities.web_control.status).toBe('supported')
      expect(evaluateHostCapability(evaluation, { action: 'apply', platform, profileKind: 'web' }).status).toBe('supported')
    }
  })

  it('keeps the same core verdict across dshmarket substitutions', () => {
    // dshmarket never participates in the core lock, so an installed market row
    // cannot change whether the core graph certifies — while a historical core
    // stays closed regardless of which market row accompanies it.
    const marketRow = rc1Cohort.packages.find((row) => row.name === 'dshmarket')!
    for (const extra of [[marketRow], [{ name: 'dshmarket', version: '99.0.0', integrity: 'sha512-drift' }]]) {
      const evaluation = evaluateHostLock([...rc015Cohort.packages, ...extra], { platform: 'posix', profileKind: 'web' })
      expect(evaluation.status).toBe('supported')
      expect(evaluation.reasonCode).toBeUndefined()
      expect(evaluation.digest).toBe(evaluateHostLock(rc015Cohort.packages, { platform: 'posix', profileKind: 'web' }).digest)
    }
    for (const historical of [alpha3Cohort, rc1Cohort]) {
      const mixed = historical.packages.map((row) => row.name === 'dshmarket' ? marketRow : row)
      expect(evaluateHostLock(mixed, { platform: 'posix', profileKind: 'web' }).status).toBe('unsupported')
    }
  })

  it('keeps skin-center outside every registered cohort and rejects it as an unknown package', () => {
    for (const cohort of HOST_COHORTS) {
      expect(cohort.packages.some((row) => row.name.includes('skin-center'))).toBe(false)
    }
    const withSkinCenter = [...rc015Cohort.packages, {
      name: '@linxin666/dsh-client-ui-skin-center', version: '0.3.20', integrity: 'sha512-AAAA',
    }]
    expect(selectHostCohort(withSkinCenter, 'posix').reasonCode).toBe('host_cohort_unknown_package')
    expect(evaluateHostLock(withSkinCenter, { platform: 'posix', profileKind: 'web' }).status).toBe('unsupported')
  })

  it('fails web_control projection closed when the web graph rows are missing or drifted', () => {
    const withoutWebApp = rc015Cohort.packages.filter((row) => row.name !== '@deepseek-ai/dsh-web-app')
    const missing = evaluateHostLock(withoutWebApp, { platform: 'posix', profileKind: 'web' })
    expect(missing.status).toBe('unavailable')
    expect(missing.reasonCode).toBe('host_lock_missing')
    const drifted = rc015Cohort.packages.map((row) => row.name === '@deepseek-ai/dsh-web-app'
      ? { ...row, integrity: 'sha512-drift' }
      : row)
    const driftedEvaluation = evaluateHostLock(drifted, { platform: 'posix', profileKind: 'web' })
    expect(driftedEvaluation.status).toBe('unsupported')
    expect(driftedEvaluation.capabilities.web_control.status).not.toBe('supported')
  })
})

describe('core lock policy identity', () => {
  it('exports only the active exact DSH core with an explicit new manifest policy', () => {
    expect(CORE_HOST_COHORTS).toHaveLength(2)
    expect(CORE_HOST_COHORTS[0].id).toBe(ACTIVE_COHORT_ID)
    for (const core of CORE_HOST_COHORTS) {
      expect(core.manifestVersion).toBe(2)
      expect(core.packages).toHaveLength(33)
      expect(core.packages.some((row) => row.name === 'dshmarket')).toBe(false)
      expect(core.capabilities).toContainEqual({ name: 'host_lock_policy', value: { k: 's', v: 'dsh-core/v1' } })
    }
  })
})
