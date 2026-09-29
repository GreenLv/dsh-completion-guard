import { describe, expect, it } from 'vitest'
import { evaluateHostLock, hostVersionFromPackages } from '../../src/domain/host-lock.js'
import { combineHostPolicy } from '../../src/domain/host-resolver.js'
import { RC020_RC1_HOST_PACKAGES } from '../../src/domain/rc020-rc1-host.js'
import { MIN_SUPPORTED_HOST_VERSION } from '../../src/domain/host-version.js'

/**
 * The minimum-version policy at the production host decision.
 *
 * `evaluateMinimumHostVersion` is not a decision test helper: it is consulted by
 * `evaluateHostLock`, the function the runtime and the host-lock CLI both use.
 * The four outcomes the plan requires are four different results here, and none
 * of them is allowed to stand in for another:
 *
 * - below the minimum: refused by the version floor, whatever the graph says;
 * - in range but unaudited: still refused, because the version policy never
 *   substitutes for the exact-graph audit;
 * - exact audited graph: accepted;
 * - damaged version: refused as unparseable rather than sorted as "newer".
 *
 * The graph is the real audited cohort, so a version outcome cannot be caused by
 * a graph the fixture invented.
 */

const withHostVersion = (version: string) => RC020_RC1_HOST_PACKAGES
  .map((row) => (row.name === '@deepseek-ai/dsh' ? { ...row, version } : row))

describe('the minimum host version is decided by the production host entry', () => {
  it.each([
    ['0.1.4', 'host_lock_version_below_minimum', 'below_minimum'],
    ['0.1.5-alpha.9', 'host_lock_version_below_minimum', 'below_minimum'],
    ['0.0.9', 'host_lock_version_below_minimum', 'below_minimum'],
  ])('refuses %s below the floor', (version, reasonCode, status) => {
    // The floor is applied by the production host verdict, not by the pure graph
    // audit, so a graph verdict can never be overwritten by a version verdict.
    const decision = combineHostPolicy(evaluateHostLock(withHostVersion(version)))
    expect(decision).toMatchObject({ status: 'unsupported', reasonCode })
    expect(decision.hostVersion).toMatchObject({ status, minimum: MIN_SUPPORTED_HOST_VERSION, version })
  })

  it.each(['0.1.7-rc.2', '0.1.8-rc.2'])('classifies %s as the retired old host line: below the only supported floor', (version) => {
    // 0.2.0-rc.1 is the ONLY supported cohort; the whole 0.1.7.x line is
    // retired, so "below the floor" is the correct verdict, not merely
    // "unregistered".
    const decision = combineHostPolicy(evaluateHostLock(withHostVersion(version)))
    expect(decision).toMatchObject({ status: 'unsupported', reasonCode: 'host_lock_version_below_minimum' })
    expect(decision.hostVersion).toMatchObject({ status: 'below_minimum', version })
  })

  it.each(['0.2.0-rc.2', '0.2.0', '0.2.1', '1.0.0'])('admits %s above the floor at the version gate; the graph half still refuses unobserved graphs', (version) => {
    const decision = evaluateHostLock(withHostVersion(version))
    // At or above the floor: the version half admits…
    expect(decision.hostVersion).toMatchObject({ status: 'supported', version })
    // …and the graph/byte audit still refuses, so a higher version never
    // becomes a certification because the version number is high enough.
    expect(decision.status).toBe('unsupported')
    expect(decision.reasonCode).not.toBe('host_lock_version_below_minimum')
  })

  it('accepts the exact audited cohort at the floor', () => {
    const decision = evaluateHostLock(RC020_RC1_HOST_PACKAGES)
    expect(hostVersionFromPackages(RC020_RC1_HOST_PACKAGES)).toBe(MIN_SUPPORTED_HOST_VERSION)
    expect(decision).toMatchObject({ status: 'supported', hostVersion: { status: 'supported' } })
  })

  it('refuses a damaged version instead of ordering it as newer', () => {
    for (const damaged of ['banana', '0.1.5.rc.1', '0.1.5-', '', 'v0.1.5-rc.1']) {
      const decision = combineHostPolicy(evaluateHostLock(withHostVersion(damaged)))
      expect(decision).toMatchObject({ status: 'unsupported', reasonCode: 'host_lock_version_unparseable' })
    }
  })

  it('leaves the version question unanswered when the graph records none', () => {
    // A graph without the host row is not evidence of a supported version: the
    // decision is absent rather than "supported", so no caller can read a
    // missing version as a pass.
    const rows = RC020_RC1_HOST_PACKAGES.filter((row) => row.name !== '@deepseek-ai/dsh')
    const decision = evaluateHostLock(rows)
    expect(decision.hostVersion).toBeUndefined()
  })
})
