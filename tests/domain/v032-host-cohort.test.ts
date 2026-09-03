import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  BASE_HOST_PACKAGES,
  EXPECTED_HOST_PACKAGES,
  HOST_COHORTS,
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

  it('selects each audited cohort atomically from its exact package graph', () => {
    const rc2 = selectHostCohort(EXPECTED_HOST_PACKAGES)
    expect(rc2.consistent).toBe(true)
    expect(rc2.cohort.id).toBe('dsh-0.1.1-rc.2')
    const alpha2 = selectHostCohort(alpha2Cohort.packages, 'posix')
    expect(alpha2.consistent).toBe(true)
    expect(alpha2.cohort.id).toBe('dsh-0.1.2-alpha.2')
    const alpha3 = evaluateHostLock(alpha3Cohort.packages, { platform: 'posix', profileKind: 'web' })
    expect(alpha3).toMatchObject({ status: 'supported', cohortId: 'dsh-0.1.2-alpha.3' })
    expect(alpha3.capabilities.web_control.status).toBe('supported')
    const rc1 = evaluateHostLock(rc1Cohort.packages, { platform: 'posix', profileKind: 'web' })
    expect(rc1).toMatchObject({ status: 'supported', cohortId: 'dsh-0.1.2-rc.1' })
    expect(rc1.capabilities.web_control.status).toBe('supported')
    // CG-DSH-001: the audited cohort is one indivisible whole-graph contract;
    // a graph missing audited rows never selects consistently.
    const baseOnly = selectHostCohort(EXPECTED_HOST_PACKAGES.filter((row) => BASE_HOST_PACKAGES.has(row.name)))
    expect(baseOnly.consistent).toBe(false)
    expect(baseOnly.cohort.id).toBe('dsh-0.1.1-rc.2')
    expect(baseOnly.reasonCode).toBe('host_cohort_incomplete_graph')
    const missingMarket = evaluateHostLock(
      EXPECTED_HOST_PACKAGES.filter((row) => row.name !== 'dshmarket'),
      { platform: 'posix', profileKind: 'headless' },
    )
    expect(missingMarket.status).toBe('unavailable')
    expect(missingMarket.reasonCode).toBe('host_lock_missing')
    expect(missingMarket.missingPackages).toEqual(['dshmarket'])
  })

  it('fails closed on mixed cohort graphs, and the mixture wins over unrelated drift', () => {
    const mixed = [
      ...EXPECTED_HOST_PACKAGES.filter((row) => BASE_HOST_PACKAGES.has(row.name)),
      ...alpha2Cohort.packages.filter((row) => ['@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-shell'].includes(row.name)),
    ]
    const selection = selectHostCohort(mixed, 'posix')
    expect(selection.consistent).toBe(false)
    expect(selection.reasonCode).toBe('host_cohort_mixed_graph')
    const evaluation = evaluateHostLock(mixed, { platform: 'posix', profileKind: 'headless' })
    expect(evaluation.status).toBe('unsupported')
    expect(evaluation.reasonCode).toBe('host_lock_cohort_mixed_graph')
    // A drifted row on top of a mixture must not hide the mixture.
    const mixedAndDrifted = [
      ...mixed,
      { ...EXPECTED_HOST_PACKAGES.find((row) => row.name === 'dshmarket')!, integrity: 'sha512-drift' },
    ]
    expect(selectHostCohort(mixedAndDrifted, 'posix').reasonCode).toBe('host_cohort_mixed_graph')
  })

  it('accepts the exact alpha.2 graph on its audited Windows platform', () => {
    const windowsAlpha = evaluateHostLock(alpha2Cohort.packages, { platform: 'windows', profileKind: 'web' })
    expect(windowsAlpha.status).toBe('supported')
    expect(windowsAlpha.reasonCode).toBeUndefined()
    expect(windowsAlpha.cohortId).toBe('dsh-0.1.2-alpha.2')
    const selection = selectHostCohort(alpha2Cohort.packages, 'windows')
    expect(selection.consistent).toBe(true)
    expect(selection.reasonCode).toBeUndefined()
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
      cohortId: 'dsh-0.1.2-rc.1',
    })
    expect(selectHostCohort(RC1_HOST_PACKAGES, 'posix')).toMatchObject({
      consistent: true,
      cohort: { id: 'dsh-0.1.2-rc.1' },
    })
  })

  it('fails the whole lock closed on single-cohort optional-row drift and duplicates', () => {
    const driftedMarket = EXPECTED_HOST_PACKAGES.map((row) => row.name === 'dshmarket'
      ? { ...row, integrity: 'sha512-drift' }
      : row)
    const evaluation = evaluateHostLock(driftedMarket, { platform: 'posix', profileKind: 'headless' })
    // CG-DSH-001: the audited cohort is an atomic whole-graph contract. An
    // integrity-drifted optional row fails the entire lock closed — it can
    // never leave the lock `supported` while only closing its own group.
    expect(evaluation.status).toBe('unsupported')
    expect(evaluation.reasonCode).toBe('host_lock_integrity_mismatch')
    expect(evaluation.cohortId).toBe('dsh-0.1.1-rc.2')
    const driftedBase = EXPECTED_HOST_PACKAGES.map((row) => row.name === '@deepseek-ai/dsh-session'
      ? { ...row, integrity: 'sha512-drift' }
      : row)
    expect(evaluateHostLock(driftedBase).status).toBe('unsupported')
    expect(evaluateHostLock(driftedBase).reasonCode).toBe('host_lock_integrity_mismatch')
    // A duplicated optional row is equally uncertifiable: whole-lock failure.
    const duplicatedOptional = [
      ...EXPECTED_HOST_PACKAGES,
      ...EXPECTED_HOST_PACKAGES.filter((row) => row.name === 'dshmarket'),
    ]
    const duplicateEvaluation = evaluateHostLock(duplicatedOptional, { platform: 'posix', profileKind: 'headless' })
    expect(duplicateEvaluation.status).toBe('unavailable')
    expect(duplicateEvaluation.reasonCode).toBe('host_lock_duplicate_package')
    // An optional row without a bound identity fails closed as well.
    const unboundOptional = EXPECTED_HOST_PACKAGES.map((row) => row.name === 'dshmarket'
      ? { name: row.name }
      : row)
    expect(evaluateHostLock(unboundOptional, { platform: 'posix' })).toMatchObject({
      status: 'unsupported',
      reasonCode: 'host_lock_cohort_unbound_identity',
    })
  })

  it('classifies unknown names, unknown versions, and unbound identities fail-closed', () => {
    expect(selectHostCohort([{ name: '@deepseek-ai/unknown' }]).reasonCode).toBe('host_cohort_unknown_package')
    expect(evaluateHostLock([{ name: '@deepseek-ai/unknown' }]).reasonCode).toBe('host_lock_unknown_package')
    // A version registered in NO cohort stays a version mismatch.
    const unknownVersion = alpha2Cohort.packages.map((row) => row.name === '@deepseek-ai/dsh-agent'
      ? { ...row, version: '0.1.2-beta.1' }
      : row)
    expect(selectHostCohort(unknownVersion, 'posix').reasonCode).toBe('host_cohort_version_mismatch')
    expect(evaluateHostLock(unknownVersion, { platform: 'posix' }).status).toBe('unsupported')
    // A version known from another cohort with a foreign integrity is an
    // integrity mismatch: alpha.3 version carried with the alpha.2 integrity.
    const foreignIntegrity = alpha2Cohort.packages.map((row) => row.name === '@deepseek-ai/dsh-agent'
      ? { ...row, version: '0.1.2-alpha.3' }
      : row)
    expect(selectHostCohort(foreignIntegrity, 'posix').reasonCode).toBe('host_cohort_integrity_mismatch')
    expect(evaluateHostLock(foreignIntegrity, { platform: 'posix' }).status).toBe('unsupported')
    expect(selectHostCohort([{ name: '@deepseek-ai/dsh-agent' }]).reasonCode).toBe('host_cohort_unbound_identity')
    const integrityDrift = alpha2Cohort.packages.map((row) => row.name === '@deepseek-ai/dsh-goal'
      ? { ...row, integrity: 'sha512-drift' }
      : row)
    expect(selectHostCohort(integrityDrift, 'posix').reasonCode).toBe('host_cohort_integrity_mismatch')
    expect(selectHostCohort([], 'posix').consistent).toBe(false)
  })

  it('binds hostLockDigest to the cohort identity so a cohort switch stales old certificates', () => {
    const rc2 = evaluateHostLock(EXPECTED_HOST_PACKAGES)
    const alpha2 = evaluateHostLock(alpha2Cohort.packages, { platform: 'posix' })
    const alpha2Market139 = evaluateHostLock(ALPHA2_DSHMARKET_139_HOST_PACKAGES, { platform: 'posix' })
    const alpha3 = evaluateHostLock(ALPHA3_HOST_PACKAGES, { platform: 'posix' })
    const rc1 = evaluateHostLock(RC1_HOST_PACKAGES, { platform: 'posix' })
    expect(rc2.status).toBe('supported')
    expect(alpha2.status).toBe('supported')
    expect(alpha2Market139.status).toBe('supported')
    expect(alpha3.status).toBe('supported')
    expect(rc1.status).toBe('supported')
    // The `host_cohort` row and per-cohort supportedGoalVersions feed digest
    // v3, so audited cohorts can never share a hostLockDigest and a
    // certificate frozen under one cohort cannot re-derive under another.
    expect(new Set([rc2.digest, alpha2.digest, alpha2Market139.digest, alpha3.digest, rc1.digest]).size).toBe(5)
    expect(rc2.digest).toMatch(/^[0-9a-f]{64}$/)
    // The same rows evaluated for a different capability keep the cohort root.
    const rc2Again = evaluateHostLock(EXPECTED_HOST_PACKAGES)
    expect(rc2Again.digest).toBe(rc2.digest)
  })

  it('accepts peer dependency ranges covering all five audited cohorts', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as Record<string, Record<string, string>>
    const peers = manifest.peerDependencies
    expect(peers['@deepseek-ai/cordis']).toBe('4.0.1 || 4.0.2')
    for (const name of ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-commands', '@deepseek-ai/dsh-goal', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-tool-goal', '@deepseek-ai/dsh-tools']) {
      expect(peers[name]).toBe('0.1.1-rc.2 || 0.1.2-alpha.2 || 0.1.2-alpha.3 || 0.1.2-rc.1')
    }
    // No floating ranges: compatibility must never widen beyond the audited sets.
    for (const range of Object.values(peers)) {
      expect(range).not.toMatch(/[\^~>=<]/)
      expect(range).not.toMatch(/0\.1\.x/)
    }
  })
})

describe('v0.4.0 dshmarket web_control compatibility projection (W1)', () => {
  // The supported host profiles, one row per audited combination. Every row
  // must lock `supported` with a working `web_control` capability projection;
  // dshmarket is the authoritative web_control audit input in each cohort.
  const supportedCombinations = [
    { label: 'rc.2 + dshmarket 1.36.0', rows: rc2Cohort.packages, cohort: 'dsh-0.1.1-rc.2', dshmarket: '1.36.0' },
    { label: 'alpha.2 + dshmarket 1.38.1', rows: alpha2Cohort.packages, cohort: 'dsh-0.1.2-alpha.2', dshmarket: '1.38.1' },
    { label: 'alpha.2 + dshmarket 1.39.0 (upgraded Windows path)', rows: alpha2Market139Cohort.packages, cohort: 'dsh-0.1.2-alpha.2-dshmarket-1.39.0', dshmarket: '1.39.0' },
    { label: 'alpha.3 + dshmarket 1.39.0', rows: alpha3Cohort.packages, cohort: 'dsh-0.1.2-alpha.3', dshmarket: '1.39.0' },
  ] as const
  for (const combination of supportedCombinations) {
    it(`locks supported with working web_control: ${combination.label}`, () => {
      expect(combination.rows.find((row) => row.name === 'dshmarket')?.version).toBe(combination.dshmarket)
      const evaluation = evaluateHostLock(combination.rows, { platform: 'posix', profileKind: 'web' })
      expect(evaluation).toMatchObject({ status: 'supported', cohortId: combination.cohort })
      expect(evaluation.capabilities.web_control.status).toBe('supported')
      const windows = evaluateHostLock(combination.rows, { platform: 'windows', profileKind: 'web' })
      expect(windows.status).toBe('supported')
      expect(evaluateHostCapability(evaluation, { action: 'apply', platform: 'windows', profileKind: 'web' }).status).toBe('supported')
    })
  }

  it('locks the native macOS rc.1 + dshmarket 1.41.0 graph as supported', () => {
    const evaluation = evaluateHostLock(rc1Cohort.packages, { platform: 'posix', profileKind: 'web' })
    expect(evaluation).toMatchObject({ status: 'supported', cohortId: 'dsh-0.1.2-rc.1' })
    expect(evaluation.capabilities.web_control.status).toBe('supported')
    expect(evaluateHostCapability(evaluation, { action: 'apply', platform: 'posix', profileKind: 'web' }).status).toBe('supported')
  })

  // Windows 1.39.0 regression closed: the daily Windows runtime once upgraded
  // dshmarket to 1.39.0 while every other package stayed alpha.2, and Guard
  // 0.3.2 rejected that exact graph. Guard 0.4.0 selects it atomically as its
  // own audited cohort with a supported web_control projection on Windows.
  it('supports the Windows alpha.2 + dshmarket 1.39.0 upgrade graph as its own audited cohort', () => {
    const windowsUpgraded = alpha2Cohort.packages.map((row) => row.name === 'dshmarket'
      ? { name: 'dshmarket', version: '1.39.0', integrity: alpha3Cohort.packages.find((entry) => entry.name === 'dshmarket')!.integrity }
      : row)
    const selection = selectHostCohort(windowsUpgraded, 'windows')
    expect(selection.consistent).toBe(true)
    expect(selection.cohort.id).toBe('dsh-0.1.2-alpha.2-dshmarket-1.39.0')
    const evaluation = evaluateHostLock(windowsUpgraded, { platform: 'windows', profileKind: 'web' })
    expect(evaluation).toMatchObject({ status: 'supported', cohortId: 'dsh-0.1.2-alpha.2-dshmarket-1.39.0' })
    expect(evaluation.capabilities.web_control.status).toBe('supported')
    expect(evaluateHostCapability(evaluation, { action: 'apply', platform: 'windows', profileKind: 'web' }).status).toBe('supported')
  })

  // Cross-cohort dshmarket substitution that matches NO registered cohort is
  // still a mixed graph. (alpha.2 + 1.39.0 is registered above and supported.)
  const mixedCombinations = [
    { label: 'alpha.3 rows with dshmarket 1.38.1', base: alpha3Cohort, market: alpha2Cohort },
    { label: 'rc.2 rows with dshmarket 1.38.1', base: rc2Cohort, market: alpha2Cohort },
    { label: 'alpha.2 rows with dshmarket 1.36.0', base: alpha2Cohort, market: rc2Cohort },
    { label: 'alpha.3 rows with dshmarket 1.41.0', base: alpha3Cohort, market: rc1Cohort },
    { label: 'rc.1 rows with dshmarket 1.39.0', base: rc1Cohort, market: alpha3Cohort },
  ] as const
  for (const combination of mixedCombinations) {
    it(`rejects the unregistered mixed graph: ${combination.label}`, () => {
      const marketRow = combination.market.packages.find((row) => row.name === 'dshmarket')!
      const mixed = combination.base.packages.map((row) => row.name === 'dshmarket' ? marketRow : row)
      const evaluation = evaluateHostLock(mixed, { platform: 'posix', profileKind: 'web' })
      expect(evaluation.status).toBe('unsupported')
      expect(evaluation.reasonCode).toBe('host_lock_cohort_mixed_graph')
    })
  }

  it('keeps skin-center outside every audited cohort and rejects it as an unknown package', () => {
    for (const cohort of HOST_COHORTS) {
      expect(cohort.packages.some((row) => row.name.includes('skin-center'))).toBe(false)
    }
    const withSkinCenter = [...alpha3Cohort.packages, {
      name: '@linxin666/dsh-client-ui-skin-center', version: '0.3.11', integrity: 'sha512-AAAA',
    }]
    expect(selectHostCohort(withSkinCenter, 'posix').reasonCode).toBe('host_cohort_unknown_package')
    expect(evaluateHostLock(withSkinCenter, { platform: 'posix', profileKind: 'web' }).status).toBe('unsupported')
  })

  it('fails web_control projection closed when the web graph rows are missing or drifted', () => {
    const withoutWebApp = alpha3Cohort.packages.filter((row) => row.name !== '@deepseek-ai/dsh-web-app')
    const missing = evaluateHostLock(withoutWebApp, { platform: 'posix', profileKind: 'web' })
    expect(missing.status).toBe('unavailable')
    expect(missing.reasonCode).toBe('host_lock_missing')
    const drifted = alpha3Cohort.packages.map((row) => row.name === 'dshmarket'
      ? { ...row, integrity: 'sha512-drift' }
      : row)
    const driftedEvaluation = evaluateHostLock(drifted, { platform: 'posix', profileKind: 'web' })
    expect(driftedEvaluation.status).toBe('unsupported')
    expect(driftedEvaluation.capabilities.web_control.status).not.toBe('supported')
  })
})
