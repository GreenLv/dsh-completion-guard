import { describe, expect, it } from 'vitest'
import qualification from '../manifests/desktop-distribution.v1.json' with { type: 'json' }
import { desktopDistributionSupplement, hasDesktopDistributionHeader, type DesktopDistributionIdentity } from '../src/domain/host-desktop-distribution.js'

describe('Desktop distribution qualification identity', () => {
  function identity(row: typeof qualification.distributions[number]): DesktopDistributionIdentity {
    return { headerSha256: row.asarHeaderSha256, platform: row.platform, arch: row.arch,
      hostVersion: row.version, desktopVersion: row.version, runtimeVersion: row.runtimeVersion,
      pnpmVersion: row.pnpmVersion, desktopManifestSha256: row.desktopManifestSha256,
      manifest: { name: '@deepseek-ai/dsh-desktop', version: row.version,
        dshBuildCommit: row.buildCommit, dshBuildDirty: row.buildDirty } }
  }
  it('pins eight independently reproduced historical source programs, separate from registry inventories', () => {
    expect(qualification.schema).toBe('dsh-desktop-distribution-qualification/v1')
    expect(qualification.provenance.sourceCommit).toBe('3dce1c93d04494376118d574b862d51a7d2ec2f1')
    expect(qualification.provenance.removalCommit).toBe('f028f25667dbf378c83da80fbb29685b197d00e3')
    expect(qualification.files.map(row => row.package).sort()).toEqual([
      'agent', 'commands', 'goal', 'jobs', 'llm', 'session', 'tools', 'user-approval',
    ].map(name => `@deepseek-ai/dsh-${name}`).sort())
    for (const file of qualification.files) {
      expect(file.version).toBe('0.2.1-rc.2')
      expect(file.path).toBe('lib/types/invariant.js')
      expect(file.bytes).toBeGreaterThan(1000)
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(file.sourceSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(file.sourcePath).toMatch(/^packages\/.+\/src\/invariant\.ts$/)
    }
    expect(new Set(qualification.files.map(row => row.sha256)).size).toBe(8)
  })
  for (const row of qualification.distributions) {
    it(`${row.id} selects only its independently pinned release identity`, () => {
      const selected = desktopDistributionSupplement(identity(row))!
      expect(hasDesktopDistributionHeader(row.asarHeaderSha256, row.platform)).toBe(true)
      expect(selected.digest).toMatch(/^[a-f0-9]{64}$/)
      expect(selected.files).toEqual(qualification.files)
      expect(row.buildCommit).not.toBe(qualification.provenance.sourceCommit)
      expect(row.releaseUrl).toMatch(/^https:\/\/download\.deepseek\.com\/dsh-desk\/bin\//)
    })
    it.each(['headerSha256', 'platform', 'arch', 'hostVersion', 'runtimeVersion', 'desktopVersion', 'pnpmVersion', 'desktopManifestSha256'] as const)
    (`${row.id} rejects changed %s`, field => {
      expect(desktopDistributionSupplement({ ...identity(row), [field]: 'unqualified' })).toBeUndefined()
    })
    it.each([{ name: 'foreign' }, { version: '0.2.1-rc.1' }, { dshBuildCommit: '0'.repeat(40) }, { dshBuildDirty: true }])
    (`${row.id} rejects a changed signed manifest: %j`, patch => {
      const input = identity(row)
      expect(desktopDistributionSupplement({ ...input, manifest: { ...input.manifest, ...patch } })).toBeUndefined()
    })
  }
  it('does not grant qualification to an arbitrary self-declared header', () => {
    expect(hasDesktopDistributionHeader('a'.repeat(64), process.platform)).toBe(false)
  })
})
