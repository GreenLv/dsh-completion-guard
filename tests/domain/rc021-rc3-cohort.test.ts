import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HOST_COHORTS, evaluateHostLock } from '../../src/domain/host-lock.js'
import { RC021_RC3_HOST_PACKAGES } from '../../src/domain/rc021-rc3-host.js'
import { satisfiesSupportedHostRange, compareHostVersions, MIN_SUPPORTED_HOST_VERSION } from '../../src/domain/host-version.js'
import rc3Manifest from '../../src/domain/rc3-byte-audit-manifest.js'

/**
 * The rc.3 cohort retains its exact published identities, bound by the
 * rc.2→rc.3 SRI and SHA-256 study. Since Guard 0.13.0 it is historical
 * evidence below the raised 0.2.2-rc.1 floor and no longer admits; the
 * recorded identities and byte invariants stay bound.
 */

describe('rc.3 cohort qualification as historical evidence', () => {
  it('retires the rc.3 cohort to the historical evidence set', () => {
    expect(HOST_COHORTS.map((cohort) => cohort.id)).toEqual(['dsh-0.2.2-rc.2-core-v1'])
    const manifest = JSON.parse(readFileSync('manifests/supported-host.v1.json', 'utf8'))
    expect(manifest.historicalCohorts.map((row: { id: string }) => row.id)).toContain('dsh-0.2.1-rc.3-core-v1')
  })

  it('binds 46 rc.3 rows plus the shared cordis 4.0.5 release', () => {
    expect(RC021_RC3_HOST_PACKAGES).toHaveLength(47)
    const cordis = RC021_RC3_HOST_PACKAGES.find((row) => row.name === '@deepseek-ai/cordis')
    expect(cordis).toMatchObject({ version: '4.0.5' })
    for (const row of RC021_RC3_HOST_PACKAGES) {
      if (row.name === '@deepseek-ai/cordis') continue
      expect(row.version, row.name).toBe('0.2.1-rc.3')
    }
  })

  it('keeps the manifest bound to the registry-verified tarball digests', () => {
    // Registry readback evidence (public packument dist.integrity values,
    // independently re-verified during the rc.2→rc.3 byte study). The manifest
    // rows must carry exactly these published identities.
    const registryVerified: Record<string, { version: string; integrity: string }> = {
      '@deepseek-ai/dsh': { version: '0.2.1-rc.3', integrity: 'sha512-H+E9HLnHf7fJqzen84Z9Bq8ggb5xbrcbyhZjXTJLE9NabHr3zteGvTRvdvGkxPl4ov80is4WLglFmSo+/olJjg==' },
      '@deepseek-ai/dsh-agent': { version: '0.2.1-rc.3', integrity: 'sha512-S6x/deneAsd+pOgecRLM1PC1No9O472kHjS9pS57nuTXi2Vtdo9l7qF+q7PfiHRezL5dxv5gUBQMORPmIYDNvQ==' },
      '@deepseek-ai/dsh-session': { version: '0.2.1-rc.3', integrity: 'sha512-z1Dfn6yB2YMm9iNThPHaIYCx0Y/mKjm+fMrWFtnPZmX0fJXVmTIr4RAfLF7ZFJk6qd52SUl8d2uX+uNbrPJESg==' },
      '@deepseek-ai/dsh-tools': { version: '0.2.1-rc.3', integrity: 'sha512-fHmhIFaztPt9+uvOlk3p4wXMU62F+TRe0ozVPasV3seIsFcxpca74QGSK5dFHICDhKIY1T9MUh0F3itMTdMi3A==' },
      '@deepseek-ai/dsh-commands': { version: '0.2.1-rc.3', integrity: 'sha512-Kuk7WW8aSEAgGaib45BtVQkUrSf1JaERJtvtZ2/YIt9e32SjAyMpIOHa0tcdpyjnNZ9dA2euw6bwxCAy0EGbEA==' },
      // dsh-http-proxy is in the app graph (its undici pin is the documented
      // exception) but not in the 47-package core cohort audited here.
      '@deepseek-ai/cordis': { version: '4.0.5', integrity: 'sha512-Sktq5axy0owk9PdnivBRNOJjHEVEibCt0+TDDZcv0+UH2KS1M910fX4kn5y45YFsrpZIi1mJf/1s5VzywMUnyg==' },
    }
    for (const [name, expected] of Object.entries(registryVerified)) {
      const row = rc3Manifest.packages.find((entry) => entry.name === name)
      expect(row, name).toBeDefined()
      expect(row!.version, name).toBe(expected.version)
      expect(row!.integrity, name).toBe(expected.integrity)
    }
    // The launcher row names the rc.3 upstream commit's released artifact set.
    expect(rc3Manifest.upstreamCommit).toBe('1f81c047fc48fa190a683e469daa699857e9afe8')
    expect(rc3Manifest.hostVersion).toBe('0.2.1-rc.3')
  })

  it('refuses the retired rc.3 graph at the raised version gate', () => {
    const rc3Lock = evaluateHostLock(RC021_RC3_HOST_PACKAGES, { platform: 'posix', profileKind: 'headless' })
    expect(rc3Lock.status).toBe('unsupported')
  })

  it('enforces the 0.2.2-rc.2 floor; the whole 0.2.1 tuple stays below it', () => {
    expect(MIN_SUPPORTED_HOST_VERSION).toBe('0.2.2-rc.2')
    expect(satisfiesSupportedHostRange('0.2.2-rc.2')).toBe(true)
    expect(satisfiesSupportedHostRange('0.2.1-rc.5')).toBe(false)
    expect(satisfiesSupportedHostRange('0.2.1-rc.3')).toBe(false)
    expect(satisfiesSupportedHostRange('0.2.1-rc.2')).toBe(false)
    expect(compareHostVersions('0.2.1-rc.5', '0.2.1-rc.3')).toBeGreaterThan(0)
    expect(compareHostVersions('0.2.1-rc.3', '0.2.1-rc.2')).toBeGreaterThan(0)
  })

  it('keeps the rc.2 lib bytes as the rc.3 lib bytes (study invariant)', () => {
    // The rc.2→rc.3 study diffed every executable/JSON file of every cohort
    // package: zero changes. The manifests therefore share per-file digests
    // for every file except the rewritten package.json manifests.
    const rc2 = JSON.parse(readFileSync(new URL('../../manifests/rc021-rc2-byte-audit.json', import.meta.url), 'utf8')) as typeof rc3Manifest
    for (const row3 of rc3Manifest.packages) {
      const row2 = rc2.packages.find((entry) => entry.name === row3.name)
      expect(row2, row3.name).toBeDefined()
      const files3 = Object.keys(row3.modules).filter((file) => file !== 'package.json')
      const modules2 = row2!.modules as unknown as Record<string, string>
      for (const file of files3) {
        expect(modules2[file], `${row3.name}/${file}`).toBe((row3.modules as unknown as Record<string, string>)[file])
      }
    }
  })
})
