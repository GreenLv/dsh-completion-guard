import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HOST_COHORTS, EXPECTED_HOST_PACKAGES, evaluateHostLock } from '../../src/domain/host-lock.js'
import { RC021_RC5_HOST_PACKAGES } from '../../src/domain/rc021-rc5-host.js'
import { RC021_RC3_HOST_PACKAGES } from '../../src/domain/rc021-rc3-host.js'
import { satisfiesSupportedHostRange, compareHostVersions, MIN_SUPPORTED_HOST_VERSION } from '../../src/domain/host-version.js'
import rc5Manifest from '../../src/domain/rc5-byte-audit-manifest.js'

/**
 * rc.5 cohort qualification: the cohort binds the exact published rc.5
 * tarballs, whose bytes the rc.3→rc.5 study verified against the registry
 * (SRI + SHA-256) and against the rc.3 tarballs (lib bytes byte-identical,
 * dependency routing unchanged). These tests keep the manifest, the cohort
 * and the version gate bound to those verified identities.
 */

describe('rc.5 cohort qualification', () => {
  it('uses rc.5 as the sole current cohort and default fixture', () => {
    expect(HOST_COHORTS.map((cohort) => cohort.id)).toEqual(['dsh-0.2.1-rc.5-core-v1'])
    expect(HOST_COHORTS[0]!.packages).toEqual(RC021_RC5_HOST_PACKAGES)
    expect(EXPECTED_HOST_PACKAGES).toEqual(RC021_RC5_HOST_PACKAGES)
  })

  it('binds 46 rc.5 rows plus the shared cordis 4.0.5 release', () => {
    expect(RC021_RC5_HOST_PACKAGES).toHaveLength(47)
    const cordis = RC021_RC5_HOST_PACKAGES.find((row) => row.name === '@deepseek-ai/cordis')
    expect(cordis).toMatchObject({ version: '4.0.5' })
    for (const row of RC021_RC5_HOST_PACKAGES) {
      if (row.name === '@deepseek-ai/cordis') continue
      expect(row.version, row.name).toBe('0.2.1-rc.5')
    }
  })

  it('keeps the manifest bound to the registry-verified tarball digests', () => {
    // Registry readback evidence (public packument dist.integrity values,
    // independently re-verified during the rc.3→rc.5 byte study). The manifest
    // rows must carry exactly these published identities.
    const registryVerified: Record<string, { version: string; integrity: string }> = {
      '@deepseek-ai/dsh': { version: '0.2.1-rc.5', integrity: 'sha512-WkyJZv4zl9sCAxSzRctGm58m0rilGqwR6pniBiLOz5CPDfHfDuAUicg0AAazXI7oj/Cph6/cjNTncA/rpLTXpw==' },
      '@deepseek-ai/dsh-agent': { version: '0.2.1-rc.5', integrity: 'sha512-mHNbxag0rZVNHaXZvr4OhiveaTTGMNPEpzO4nS8ohOQiQL0MWqA7brwtjBbaAlB3aMZ13tbHGHINpFlXdu8J3Q==' },
      '@deepseek-ai/dsh-session': { version: '0.2.1-rc.5', integrity: 'sha512-A5NdQFgeY4qi29+lBzgZiOloiFe+E1iBbIRjJTplee79rswYGUUmUZYmOvAcdmk4tERkY2S9htuc+V+jNifqRw==' },
      '@deepseek-ai/dsh-tools': { version: '0.2.1-rc.5', integrity: 'sha512-tOEMsbG1jH4EV80xcGucfeWsKHLjnETjRLtSnyFrVl2oma95tzTHBjti5MK60IvT2ijcCWhx8CrUKcqRksfDPA==' },
      '@deepseek-ai/dsh-commands': { version: '0.2.1-rc.5', integrity: 'sha512-6jzjcag7rj4Ljk5si0RogCykv/fuwXpSysbgqzwPffYPDIZbupW0wTdngLKFVRkSUCSTDQTfjMSoku6xowkINA==' },
      // dsh-http-proxy is in the app graph (its undici pin is the documented
      // exception) but not in the 47-package core cohort audited here.
      '@deepseek-ai/cordis': { version: '4.0.5', integrity: 'sha512-Sktq5axy0owk9PdnivBRNOJjHEVEibCt0+TDDZcv0+UH2KS1M910fX4kn5y45YFsrpZIi1mJf/1s5VzywMUnyg==' },
    }
    for (const [name, expected] of Object.entries(registryVerified)) {
      const row = rc5Manifest.packages.find((entry) => entry.name === name)
      expect(row, name).toBeDefined()
      expect(row!.version, name).toBe(expected.version)
      expect(row!.integrity, name).toBe(expected.integrity)
    }
    // The launcher row names the rc.5 upstream commit's released artifact set.
    expect(rc5Manifest.upstreamCommit).toBe('b830ec950faba0a46dda564be3e2d854afed94f1')
    expect(rc5Manifest.hostVersion).toBe('0.2.1-rc.5')
  })

  it('evaluates the rc.5 rows to a supported rc.5 lock and refuses below-floor graphs', () => {
    const rc5Lock = evaluateHostLock(RC021_RC5_HOST_PACKAGES, { platform: 'posix', profileKind: 'headless' })
    expect(rc5Lock.status, JSON.stringify(rc5Lock.reasonCode)).toBe('supported')
    expect(rc5Lock.cohortId).toBe('dsh-0.2.1-rc.5-core-v1')
    const rc3Lock = evaluateHostLock(RC021_RC3_HOST_PACKAGES, { platform: 'posix', profileKind: 'headless' })
    expect(rc3Lock.status).toBe('unsupported')
    expect(rc3Lock.hostVersion).toMatchObject({ status: 'below_minimum', minimum: '0.2.1-rc.5' })
    // Graph identity is per cohort: an rc.5 row swapped into the rc.3 set is
    // not the rc.3 lock.
    const mixed = [...RC021_RC3_HOST_PACKAGES.map((row) => row.name === '@deepseek-ai/dsh-session' ? { ...row, version: '0.2.1-rc.5' } : row)]
    const mixedLock = evaluateHostLock(mixed, { platform: 'posix', profileKind: 'headless' })
    expect(mixedLock.status !== 'supported' || mixedLock.cohortId !== 'dsh-0.2.1-rc.3-core-v1').toBe(true)
  })

  it('enforces the rc.5 floor while preserving historical identities', () => {
    expect(MIN_SUPPORTED_HOST_VERSION).toBe('0.2.1-rc.5')
    expect(satisfiesSupportedHostRange('0.2.1-rc.5')).toBe(true)
    expect(satisfiesSupportedHostRange('0.2.1-rc.4')).toBe(false)
    expect(satisfiesSupportedHostRange('0.2.1-rc.3')).toBe(false)
    expect(compareHostVersions('0.2.1-rc.5', '0.2.1-rc.3')).toBeGreaterThan(0)
  })

  it('keeps the rc.3 lib bytes as the rc.5 lib bytes (study invariant)', () => {
    // The rc.3→rc.5 study diffed every executable/JSON file of every cohort
    // package: zero changes, and dependency routing is unchanged. The
    // manifests therefore share per-file digests for every file except the
    // rewritten package.json manifests.
    const rc3 = JSON.parse(readFileSync(new URL('../../manifests/rc021-rc3-byte-audit.json', import.meta.url), 'utf8')) as typeof rc5Manifest
    for (const row5 of rc5Manifest.packages) {
      const row3 = rc3.packages.find((entry) => entry.name === row5.name)
      expect(row3, row5.name).toBeDefined()
      const files5 = Object.keys(row5.modules).filter((file) => file !== 'package.json')
      const modules3 = row3!.modules as unknown as Record<string, string>
      for (const file of files5) {
        expect(modules3[file], `${row5.name}/${file}`).toBe((row5.modules as unknown as Record<string, string>)[file])
      }
      // The loading digest deliberately excludes the version field, so a
      // version-only manifest rewrite keeps it; only a row whose package.json
      // bytes are identical (the untouched cordis 4.0.5 release) is pinned to
      // an identical loading digest here.
      if ((row5.modules as unknown as Record<string, string>)['package.json']
        === (row3!.modules as unknown as Record<string, string>)['package.json']) {
        expect(row5.loadingDigest, row5.name).toBe(row3!.loadingDigest)
      }
    }
  })
})
