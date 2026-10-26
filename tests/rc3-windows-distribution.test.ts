import { describe, expect, it } from 'vitest'
import { desktopDistributionSupplement, hasDesktopDistributionHeader } from '../src/domain/host-desktop-distribution.js'
// Public program identities independently read on Windows and matched to the
// signed PE resource and official updater digest. This portable test does not
// fake an Authenticode or native installed-graph pass.
const observed = {
  headerSha256: 'c30a30589e62c5c571f73c27ca22b94bb0d931815f2a2e122ae1c7dc904ab594',
  platform: 'win32', arch: 'x64', hostVersion: '0.2.1-rc.3', runtimeVersion: '0.2.1-rc.3', desktopVersion: '0.2.1-rc.3', pnpmVersion: '11.28.5',
  desktopManifestSha256: 'ac5d5922a061519322befb742e8b8285197d6ca975a2a38e8049ef37c67e63d2',
  manifest: { name: '@deepseek-ai/dsh-desktop', version: '0.2.1-rc.3', dshBuildCommit: 'be72761ee1a6736ebcdf4f3739363b083ae53c98', dshBuildDirty: false },
}
describe('registered rc.3 Windows distribution identity', () => {
  it('recognizes the independently signed header and complete distribution tuple', () => {
    expect(hasDesktopDistributionHeader(observed.headerSha256, 'win32')).toBe(true)
    expect(desktopDistributionSupplement(observed)?.digest).toMatch(/^[a-f0-9]{64}$/)
  })
  it.each([
    { platform: 'darwin' }, { arch: 'arm64' }, { hostVersion: '0.2.1-rc.2' }, { runtimeVersion: '0.2.1-rc.2' },
    { pnpmVersion: '11.22.0' }, { desktopManifestSha256: '0'.repeat(64) },
    { manifest: { ...observed.manifest, dshBuildDirty: true } },
    { manifest: { ...observed.manifest, dshBuildCommit: '0'.repeat(40) } },
  ])('refuses a changed independently bound tuple field %j', patch => {
    expect(desktopDistributionSupplement({ ...observed, ...patch })).toBeUndefined()
  })
})
