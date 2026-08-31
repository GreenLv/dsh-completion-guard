import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  BASE_HOST_PACKAGES,
  EXPECTED_HOST_PACKAGES,
  HOST_COHORTS,
  evaluateHostLock,
  selectHostCohort,
} from '../../src/domain/host-lock.js'

const rc2Cohort = HOST_COHORTS.find((cohort) => cohort.id === 'dsh-0.1.1-rc.2')!
const alpha2Cohort = HOST_COHORTS.find((cohort) => cohort.id === 'dsh-0.1.2-alpha.2')!

describe('v0.3.2 audited host cohort registry', () => {
  it('registers exactly the two audited cohorts with disjoint audited graphs', () => {
    expect(HOST_COHORTS.map((cohort) => cohort.id)).toEqual(['dsh-0.1.1-rc.2', 'dsh-0.1.2-alpha.2'])
    for (const cohort of HOST_COHORTS) {
      expect(cohort.packages).toHaveLength(34)
      expect(new Set(cohort.packages.map((row) => row.name)).size).toBe(34)
      expect(cohort.packages.every((row) => row.version && row.integrity?.startsWith('sha512-'))).toBe(true)
      expect(cohort.capabilities[0]).toEqual({ name: 'host_cohort', value: { k: 's', v: cohort.id } })
    }
    expect(rc2Cohort.auditedPlatforms).toEqual(['posix', 'windows'])
    expect(alpha2Cohort.auditedPlatforms).toEqual(['posix'])
    // Both cohorts audit the same package-name universe; only identities differ.
    expect(rc2Cohort.packages.map((row) => row.name).sort()).toEqual(alpha2Cohort.packages.map((row) => row.name).sort())
    const alphaVersions = new Set(alpha2Cohort.packages.map((row) => row.version))
    expect(alphaVersions).toEqual(new Set(['0.1.2-alpha.2', '4.0.2', '1.38.1']))
    expect(alpha2Cohort.packages.find((row) => row.name === '@deepseek-ai/cordis')?.version).toBe('4.0.2')
    expect(alpha2Cohort.packages.find((row) => row.name === 'dshmarket')?.version).toBe('1.38.1')
  })

  it('selects each audited cohort atomically from its exact package graph', () => {
    const rc2 = selectHostCohort(EXPECTED_HOST_PACKAGES)
    expect(rc2.consistent).toBe(true)
    expect(rc2.cohort.id).toBe('dsh-0.1.1-rc.2')
    const alpha2 = selectHostCohort(alpha2Cohort.packages, 'posix')
    expect(alpha2.consistent).toBe(true)
    expect(alpha2.cohort.id).toBe('dsh-0.1.2-alpha.2')
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

  it('fails closed when the only matching cohort was never audited on the active platform', () => {
    const windowsAlpha = evaluateHostLock(alpha2Cohort.packages, { platform: 'windows', profileKind: 'web' })
    expect(windowsAlpha.status).toBe('unsupported')
    expect(windowsAlpha.reasonCode).toBe('host_lock_cohort_platform_not_audited')
    expect(windowsAlpha.cohortId).toBe('dsh-0.1.2-alpha.2')
    const selection = selectHostCohort(alpha2Cohort.packages, 'windows')
    expect(selection.reasonCode).toBe('host_cohort_platform_not_audited')
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
    const unknownVersion = alpha2Cohort.packages.map((row) => row.name === '@deepseek-ai/dsh-agent'
      ? { ...row, version: '0.1.2-alpha.3' }
      : row)
    expect(selectHostCohort(unknownVersion, 'posix').reasonCode).toBe('host_cohort_version_mismatch')
    expect(evaluateHostLock(unknownVersion, { platform: 'posix' }).status).toBe('unsupported')
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
    expect(rc2.status).toBe('supported')
    expect(alpha2.status).toBe('supported')
    // The `host_cohort` row and per-cohort supportedGoalVersions feed digest
    // v3, so the two audited cohorts can never share a hostLockDigest and a
    // certificate frozen under one cohort cannot re-derive under the other.
    expect(rc2.digest).not.toBe(alpha2.digest)
    expect(rc2.digest).toMatch(/^[0-9a-f]{64}$/)
    // The same rows evaluated for a different capability keep the cohort root.
    const rc2Again = evaluateHostLock(EXPECTED_HOST_PACKAGES)
    expect(rc2Again.digest).toBe(rc2.digest)
  })

  it('accepts peer dependency ranges for exactly the two audited cohorts', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as Record<string, Record<string, string>>
    const peers = manifest.peerDependencies
    expect(peers['@deepseek-ai/cordis']).toBe('4.0.1 || 4.0.2')
    for (const name of ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-commands', '@deepseek-ai/dsh-goal', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-tool-goal', '@deepseek-ai/dsh-tools']) {
      expect(peers[name]).toBe('0.1.1-rc.2 || 0.1.2-alpha.2')
    }
    // No floating ranges: compatibility must never widen beyond the audited sets.
    for (const range of Object.values(peers)) {
      expect(range).not.toMatch(/[\^~>=<]/)
      expect(range).not.toMatch(/0\.1\.x/)
    }
  })
})
