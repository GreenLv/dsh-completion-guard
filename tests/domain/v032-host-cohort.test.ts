import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  BASE_HOST_PACKAGES,
  EXPECTED_HOST_PACKAGES,
  HOST_COHORTS as CORE_HOST_COHORTS,
  LEGACY_HOST_COHORTS as HOST_COHORTS,
  evaluateHostCapability,
  evaluateHostLock,
  selectHostCohort,
} from '../../src/domain/host-lock.js'
import { ALPHA3_HOST_PACKAGES } from '../../src/domain/alpha3-host.js'
import { RC1_HOST_PACKAGES } from '../../src/domain/rc1-host.js'
import { ALPHA2_HOST_PACKAGES, ALPHA2_DSHMARKET_139_HOST_PACKAGES } from '../../src/domain/host-lock.js'

const rc2Cohort = HOST_COHORTS.find((cohort) => cohort.id === 'dsh-0.1.1-rc.2')!
const alpha2Cohort = HOST_COHORTS.find((cohort) => cohort.id === 'dsh-0.1.2-alpha.2')!
const alpha2Market139Cohort = HOST_COHORTS.find((cohort) => cohort.id === 'dsh-0.1.2-alpha.2-dshmarket-1.39.0')!
const alpha3Cohort = HOST_COHORTS.find((cohort) => cohort.id === 'dsh-0.1.2-alpha.3')!
const rc1Cohort = HOST_COHORTS.find((cohort) => cohort.id === 'dsh-0.1.2-rc.1')!

describe('audited host cohort registry', () => {
  it('registers exactly the five audited cohorts with disjoint audited graphs', () => {
    expect(HOST_COHORTS.map((cohort) => cohort.id)).toEqual([
      'dsh-0.1.1-rc.2',
      'dsh-0.1.2-alpha.2',
      'dsh-0.1.2-alpha.2-dshmarket-1.39.0',
      'dsh-0.1.2-alpha.3',
      'dsh-0.1.2-rc.1',
    ])
    for (const cohort of HOST_COHORTS) {
      expect(cohort.packages).toHaveLength(34)
      expect(new Set(cohort.packages.map((row) => row.name)).size).toBe(34)
      expect(cohort.packages.every((row) => row.version && row.integrity?.startsWith('sha512-'))).toBe(true)
      expect(cohort.capabilities[0]).toEqual({ name: 'host_cohort', value: { k: 's', v: cohort.id } })
    }
    expect(rc2Cohort.auditedPlatforms).toEqual(['posix', 'windows'])
    expect(alpha2Cohort.auditedPlatforms).toEqual(['posix', 'windows'])
    expect(alpha2Market139Cohort.auditedPlatforms).toEqual(['posix', 'windows'])
    expect(alpha3Cohort.auditedPlatforms).toEqual(['posix', 'windows'])
    expect(rc1Cohort.auditedPlatforms).toEqual(['posix', 'windows'])
    // All audited cohorts use one complete package-name universe.
    expect(rc2Cohort.packages.map((row) => row.name).sort()).toEqual(alpha2Cohort.packages.map((row) => row.name).sort())
    expect(alpha3Cohort.packages.map((row) => row.name).sort()).toEqual(alpha2Cohort.packages.map((row) => row.name).sort())
    expect(rc1Cohort.packages.map((row) => row.name).sort()).toEqual(alpha2Cohort.packages.map((row) => row.name).sort())
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

  it('selects the active rc.1 cohort atomically and closes historical cohorts', () => {
    // 0.5.0 support policy: the active allowlist is exactly rc.1. Historical
    // audited graphs keep their identities in LEGACY_HOST_COHORTS as
    // verification data but are no longer active support entries.
    const active = selectHostCohort(EXPECTED_HOST_PACKAGES)
    expect(active.consistent).toBe(true)
    expect(active.cohort.id).toBe('dsh-0.1.2-rc.1-core-v1')
    const rc2 = selectHostCohort(rc2Cohort.packages, 'posix')
    expect(rc2.consistent).toBe(false)
    expect(rc2.reasonCode).toBe('host_cohort_version_mismatch')
    const alpha2 = selectHostCohort(alpha2Cohort.packages, 'posix')
    expect(alpha2.consistent).toBe(false)
    const alpha3 = evaluateHostLock(alpha3Cohort.packages, { platform: 'posix', profileKind: 'web' })
    expect(alpha3.status).toBe('unsupported')
    expect(alpha3.reasonCode).toBe('host_lock_version_mismatch')
    const rc1 = evaluateHostLock(rc1Cohort.packages, { platform: 'posix', profileKind: 'web' })
    expect(rc1).toMatchObject({ status: 'supported', cohortId: 'dsh-0.1.2-rc.1-core-v1' })
    expect(rc1.capabilities.web_control.status).toBe('supported')
    // CG-DSH-001: the audited cohort is one indivisible whole-graph contract;
    // a graph missing audited rows never selects consistently.
    const baseOnly = selectHostCohort(EXPECTED_HOST_PACKAGES.filter((row) => BASE_HOST_PACKAGES.has(row.name)))
    expect(baseOnly.consistent).toBe(false)
    expect(baseOnly.cohort.id).toBe('dsh-0.1.2-rc.1-core-v1')
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
    // With one active cohort the former cross-cohort mixture signal degrades
    // to the stricter outcome: foreign rows match no active version, so the
    // graph is a version mismatch — closed either way, and the reason stays
    // stable under unrelated market drift.
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

  it('selects rc.1 consistently on Windows after the 2026-09-04 native Windows audit', () => {
    // CG-DSH-001: the windows platform joined the rc.1 cohort only after the
    // live Windows rc.1 graph was extracted and verified row-for-row identical
    // to the posix rows; unlisted host cohorts still fail closed.
    expect(selectHostCohort(RC1_HOST_PACKAGES, 'windows')).toMatchObject({
      consistent: true,
    })
    expect(evaluateHostLock(RC1_HOST_PACKAGES, { platform: 'windows', profileKind: 'web' })).toMatchObject({
      status: 'supported',
      cohortId: 'dsh-0.1.2-rc.1-core-v1',
    })
    expect(selectHostCohort(RC1_HOST_PACKAGES, 'posix')).toMatchObject({
      consistent: true,
      cohort: { id: 'dsh-0.1.2-rc.1-core-v1' },
    })
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
    // A version known from the active cohort with a foreign integrity is an
    // integrity mismatch: the rc.1 version carried with drifted integrity.
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
    // Only the active rc.1 graph certifies; historical audited graphs fail
    // closed instead of producing a supported lock under any digest.
    const rc1 = evaluateHostLock(RC1_HOST_PACKAGES, { platform: 'posix' })
    expect(rc1.status).toBe('supported')
    expect(rc1.digest).toMatch(/^[0-9a-f]{64}$/)
    const rc1Again = evaluateHostLock(RC1_HOST_PACKAGES, { platform: 'posix' })
    expect(rc1Again.digest).toBe(rc1.digest)
    for (const historical of [rc2Cohort.packages, alpha2Cohort.packages, ALPHA2_DSHMARKET_139_HOST_PACKAGES, ALPHA3_HOST_PACKAGES]) {
      expect(evaluateHostLock(historical, { platform: 'posix' }).status).toBe('unsupported')
    }
  })

  it('advertises the exact rc.1 installation target only', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as Record<string, Record<string, string>>
    const peers = manifest.peerDependencies
    expect(peers['@deepseek-ai/cordis']).toBe('4.0.2')
    for (const name of ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-commands', '@deepseek-ai/dsh-goal', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-tool-goal', '@deepseek-ai/dsh-tools']) {
      expect(peers[name]).toBe('0.1.2-rc.1')
    }
    // No floating ranges and no historical/alpha identifiers: compatibility
    // must never widen beyond the one audited active cohort.
    for (const range of Object.values(peers)) {
      expect(range).not.toMatch(/[\^~>=<|]/)
      expect(range).not.toMatch(/0\.1\.x/)
      expect(range).not.toMatch(/alpha/)
      expect(range).not.toMatch(/0\.1\.1/)
    }
  })
})

describe('v0.4.0 dshmarket web_control compatibility projection (W1)', () => {
  // Historical dshmarket combinations keep their audited identities, but the
  // 0.5.0 active allowlist is rc.1-only: every historical combination now
  // fails closed instead of locking supported, on both platforms.
  const historicalCombinations = [
    { label: 'rc.2 + dshmarket 1.36.0', rows: rc2Cohort.packages },
    { label: 'alpha.2 + dshmarket 1.38.1', rows: alpha2Cohort.packages },
    { label: 'alpha.2 + dshmarket 1.39.0 (upgraded Windows path)', rows: alpha2Market139Cohort.packages },
    { label: 'alpha.3 + dshmarket 1.39.0', rows: alpha3Cohort.packages },
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

  it('locks the rc.1 + dshmarket 1.41.0 graphs as the supported web_control target on both platforms', () => {
    for (const platform of ['posix', 'windows'] as const) {
      const evaluation = evaluateHostLock(rc1Cohort.packages, { platform, profileKind: 'web' })
      expect(evaluation).toMatchObject({ status: 'supported', cohortId: 'dsh-0.1.2-rc.1-core-v1' })
      expect(evaluation.capabilities.web_control.status).toBe('supported')
      expect(evaluateHostCapability(evaluation, { action: 'apply', platform, profileKind: 'web' }).status).toBe('supported')
    }
  })

  // Cross-cohort dshmarket substitution that matches NO registered cohort is
  // still a mixed graph; every historical core stays closed either way.
  const mixedCombinations = [
    { label: 'alpha.3 rows with dshmarket 1.38.1', base: alpha3Cohort, market: alpha2Cohort },
    { label: 'rc.2 rows with dshmarket 1.38.1', base: rc2Cohort, market: alpha2Cohort },
    { label: 'alpha.2 rows with dshmarket 1.36.0', base: alpha2Cohort, market: rc2Cohort },
    { label: 'alpha.3 rows with dshmarket 1.41.0', base: alpha3Cohort, market: rc1Cohort },
    { label: 'rc.1 rows with dshmarket 1.39.0', base: rc1Cohort, market: alpha3Cohort },
  ] as const
  for (const combination of mixedCombinations) {
    it(`keeps the same core across market substitutions: ${combination.label}`, () => {
      const marketRow = combination.market.packages.find((row) => row.name === 'dshmarket')!
      const mixed = combination.base.packages.map((row) => row.name === 'dshmarket' ? marketRow : row)
      const evaluation = evaluateHostLock(mixed, { platform: 'posix', profileKind: 'web' })
      // dshmarket substitution never changes the core verdict: the rc.1 core
      // stays supported under any market row, historical cores stay closed.
      if (combination.base === rc1Cohort) {
        expect(evaluation.status).toBe('supported')
        expect(evaluation.reasonCode).toBeUndefined()
      } else {
        expect(evaluation.status).toBe('unsupported')
      }
    })
  }

  it('keeps skin-center outside every audited cohort and rejects it as an unknown package', () => {
    for (const cohort of HOST_COHORTS) {
      expect(cohort.packages.some((row) => row.name.includes('skin-center'))).toBe(false)
    }
    const withSkinCenter = [...rc1Cohort.packages, {
      name: '@linxin666/dsh-client-ui-skin-center', version: '0.3.11', integrity: 'sha512-AAAA',
    }]
    expect(selectHostCohort(withSkinCenter, 'posix').reasonCode).toBe('host_cohort_unknown_package')
    expect(evaluateHostLock(withSkinCenter, { platform: 'posix', profileKind: 'web' }).status).toBe('unsupported')
  })

  it('fails web_control projection closed when the web graph rows are missing or drifted', () => {
    const withoutWebApp = rc1Cohort.packages.filter((row) => row.name !== '@deepseek-ai/dsh-web-app')
    const missing = evaluateHostLock(withoutWebApp, { platform: 'posix', profileKind: 'web' })
    expect(missing.status).toBe('unavailable')
    expect(missing.reasonCode).toBe('host_lock_missing')
    const drifted = rc1Cohort.packages.map((row) => row.name === '@deepseek-ai/dsh-web-app'
      ? { ...row, integrity: 'sha512-drift' }
      : row)
    const driftedEvaluation = evaluateHostLock(drifted, { platform: 'posix', profileKind: 'web' })
    expect(driftedEvaluation.status).toBe('unsupported')
    expect(driftedEvaluation.capabilities.web_control.status).not.toBe('supported')
  })
})

 describe('core lock policy identity', () => {
  it('exports only the active rc.1 exact DSH core with an explicit new manifest policy', () => {
    expect(CORE_HOST_COHORTS).toHaveLength(1)
    expect(CORE_HOST_COHORTS[0].id).toBe('dsh-0.1.2-rc.1-core-v1')
    for (const core of CORE_HOST_COHORTS) {
      expect(core.manifestVersion).toBe(2)
      expect(core.packages).toHaveLength(33)
      expect(core.packages.some((row) => row.name === 'dshmarket')).toBe(false)
      expect(core.capabilities).toContainEqual({ name: 'host_lock_policy', value: { k: 's', v: 'dsh-core/v1' } })
    }
  })
})
