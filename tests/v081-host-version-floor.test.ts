import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { evaluateGraphDerivedHostLock, evaluateHostLock, HOST_COHORTS } from '../src/domain/host-lock.js'
import type { PackageRow } from '../src/domain/digest.js'
import {
  evaluateMinimumHostVersion,
  HOST_VALIDATED_VERSIONS,
  MIN_SUPPORTED_HOST_VERSION,
  satisfiesSupportedHostRange,
  SUPPORTED_HOST_RANGE,
} from '../src/domain/host-version.js'
import { RC021_RC2_HOST_PACKAGES } from '../src/domain/rc021-rc2-host.js'
import { RC020_RC2_HOST_PACKAGES } from '../src/domain/rc020-rc2-host.js'

describe('0.10.0 floor-admission host version policy', () => {
  // Independent row-verifier oracle for the pure helper (not provenance acquisition): a row's integrity is valid
  // only when the install lockfile declares the same package@version with the
  // same SRI (production must additionally acquire registry metadata and archive bytes).
  const lockYaml = [
    "lockfileVersion: '9.0'", '', 'packages:',
    ...RC021_RC2_HOST_PACKAGES.map((row) => [
      `  '${row.name}@0.2.2-rc.1':`,
      `    resolution: {integrity: ${row.integrity}}`,
      '',
    ]).flat(),
    'snapshots:', '',
  ].join('\n')
  const verifyFromLock = (row: PackageRow): boolean =>
    row.integrity !== undefined && lockYaml.includes(`'${row.name}@${row.version}':`)
    && lockYaml.includes(row.integrity!)
  it('version admission: floor, later same-tuple RC, stable, patch/minor RC and higher major admit; below-floor refuses', () => {
    expect(SUPPORTED_HOST_RANGE).toBe('>=0.2.1-rc.2')
    for (const version of ['0.2.1-rc.2', '0.2.1-rc.3', '0.2.1', '0.2.2-rc.1', '0.2.2', '0.3.0', '1.0.0', '0.2.1-rc.2+build.7']) {
      expect(satisfiesSupportedHostRange(version), version).toBe(true)
      expect(evaluateMinimumHostVersion(version)).toMatchObject({ status: 'supported', reasonCode: 'host_version_supported' })
    }
    for (const version of ['0.1.7-rc.2', '0.1.8', '0.2.0-alpha.9', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.0', '0.2.1-rc.0', '0.2.1-rc.1']) {
      expect(satisfiesSupportedHostRange(version), version).toBe(false)
      expect(evaluateMinimumHostVersion(version)).toMatchObject({ status: 'below_minimum', reasonCode: 'host_version_below_minimum' })
    }
    for (const bad of ['01.2.0', '0.2.1-rc.01', '0.2.1+bad..meta', '0.2.1-', 'v0.2.2']) expect(evaluateMinimumHostVersion(bad).status, bad).toBe('unparseable')
    expect(evaluateMinimumHostVersion('nonsense-v')).toMatchObject({ status: 'unparseable' })
  })

  it('the validated-versions list is an evidence ledger, not an admission whitelist', () => {
    expect(HOST_VALIDATED_VERSIONS).toContain(MIN_SUPPORTED_HOST_VERSION)
    // A future version admits even though it has NO evidence row…
    expect(satisfiesSupportedHostRange('9.9.9')).toBe(true)
    expect(HOST_VALIDATED_VERSIONS).not.toContain('9.9.9')
    // …and the ledger name/shape states evidence, not admission. The 0.2.0
    // rows keep their historical standing below the current floor.
    expect(HOST_VALIDATED_VERSIONS).toContain('0.2.0-rc.2')
    expect(HOST_VALIDATED_VERSIONS.length).toBeLessThan(4)
  })

  it('the pure evaluator binds a verified future graph rebinds to a graph-derived cohort', () => {
    // Future manifests: same 46 names, version 0.2.2-rc.1, real byte
    // digests in the lockfile (install-time evidence).
    const rows = RC021_RC2_HOST_PACKAGES.map((row) => ({ ...row, version: '0.2.2-rc.1' }))
    const rebound = evaluateGraphDerivedHostLock(rows, { platform: 'posix', profileKind: 'web' }, verifyFromLock)
    expect(rebound.status).toBe('supported')
    expect(rebound.auditProvenance).toBe('graph-derived-rebind-pending-native-audit')
    expect(rebound.cohortId).toMatch(/^graph-derived-/)
    expect(rebound.packages.every((row) => row.version === '0.2.2-rc.1')).toBe(true)
    expect(rebound.hostVersion).toMatchObject({ status: 'supported', version: '0.2.2-rc.1' })
    // The audited 0.2.1-rc.2 cohort stays strict for the same rows.
    expect(evaluateHostLock(rows, { platform: 'posix', profileKind: 'web' }).status).toBe('unsupported')
    // The exact 0.2.1-rc.2 rows are the audited baseline and stay supported.
    expect(evaluateHostLock(RC021_RC2_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' }).status).toBe('supported')
    // The superseded 0.2.0-rc.2 graph keeps its published identity but no
    // longer matches any cohort: the graph verdict is reported on its own
    // (the version floor decides last in the production combination).
    for (const platform of ['posix', 'windows'] as const) {
      const evaluation = evaluateHostLock(RC020_RC2_HOST_PACKAGES, { platform })
      expect(evaluation.status).toBe('unsupported')
      expect(evaluation.reasonCode).toBe('host_lock_version_mismatch')
    }
  })

  it('a future graph whose lockfile lacks the claimed SRI never rebinds', () => {
    // Integrity self-reported by rows but ABSENT from the install lockfile:
    // self-report is not install-time evidence.
    const rows = RC021_RC2_HOST_PACKAGES.map((row) => ({ ...row, version: '0.2.2-rc.1' }))
    const rebound = evaluateGraphDerivedHostLock(rows, { platform: 'posix', profileKind: 'web' }, () => false)
    expect(rebound.status).toBe('unsupported')
    expect(rebound.reasonCode).toBe('host_lock_integrity_mismatch')
    // A forged integrity value fails the same evidence check: the real
    // verifier (production wiring reads the install lockfile) does not find
    // the forged digest, so self-report never proves identity.
    const forged = evaluateGraphDerivedHostLock(
      RC021_RC2_HOST_PACKAGES.map((row) => ({ ...row, integrity: 'sha512-forged' })),
      { platform: 'posix', profileKind: 'web' }, verifyFromLock,
    )
    expect(forged.status).toBe('unsupported')
    expect(forged.reasonCode).toBe('host_lock_integrity_mismatch')
  })

  it('below-floor future-shaped graphs refuse at the version gate inside the rebind', () => {
    const rows = RC021_RC2_HOST_PACKAGES.map((row) => ({ ...row, version: '0.2.1-rc.0' }))
    const rebound = evaluateGraphDerivedHostLock(rows, { platform: 'posix', profileKind: 'web' }, () => true)
    expect(rebound.status).toBe('unsupported')
    expect(rebound.reasonCode).toBe('host_lock_version_below_minimum')
    expect(HOST_COHORTS.map((cohort) => cohort.id)).toEqual(['dsh-0.2.1-rc.2-core-v1'])
  })

  it('the floor SemVer matrix matches the recorded consumer evidence', () => {
    const matrix = JSON.parse(readFileSync(new URL('../benchmarks/incidents/acceptance/semver-matrix.json', import.meta.url), 'utf8'))
    expect(matrix.range).toBe('>=0.2.1-rc.2')
    // includePrerelease:true reproduces the declared floor; the PLAIN npm
    // range does NOT admit later-tuple RCs (0.2.2-rc.1, 0.3.0-rc.1) — the
    // recorded consumer limitation.
    for (const c of matrix.cases as Array<{ version: string; plain_satisfies: boolean; includePrerelease_true: boolean }>) {
      if (c.version === '0.2.2-rc.1' || c.version === '0.3.0-rc.1') {
        expect(c.plain_satisfies, `${c.version} plain`).toBe(false)
        expect(c.includePrerelease_true, `${c.version} includePrerelease`).toBe(true)
      }
    }
  })
})
