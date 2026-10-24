import { createHash } from 'node:crypto'
import qualification from './desktop-distribution-manifest.js'

export interface DesktopDistributionIdentity {
  headerSha256: string
  platform: string
  arch: string
  hostVersion: string
  runtimeVersion: string
  desktopVersion: string
  pnpmVersion: string
  desktopManifestSha256: string
  manifest: Record<string, unknown>
}

export interface DesktopDistributionSupplement {
  digest: string
  files: readonly { package: string; version: string; path: string; bytes: number; sha256: string }[]
}

/** A local ASAR table cannot authorize executable bytes. These independently
 * acquired release/header and historical-source pins are the only supplement
 * to the registry inventory, and only inside the signed Desktop adapter.
 * OS carrier verification remains mandatory at every public resolver entry.
 */
export function hasDesktopDistributionHeader(header: string, platform: string): boolean {
  return qualification.distributions.some(row => row.asarHeaderSha256 === header && row.platform === platform)
}

export function desktopDistributionSupplement(identity: DesktopDistributionIdentity): DesktopDistributionSupplement | undefined {
  const row = qualification.distributions.find(row => row.asarHeaderSha256 === identity.headerSha256
    && row.platform === identity.platform && row.arch === identity.arch
    && row.version === identity.hostVersion && row.version === identity.desktopVersion
    && row.runtimeVersion === identity.runtimeVersion && row.pnpmVersion === identity.pnpmVersion
    && row.desktopManifestSha256 === identity.desktopManifestSha256
    && identity.manifest.name === '@deepseek-ai/dsh-desktop' && identity.manifest.version === row.version
    && identity.manifest.dshBuildCommit === row.buildCommit && identity.manifest.dshBuildDirty === row.buildDirty)
  if (!row) return undefined
  return { digest: createHash('sha256').update('dsh.desktop-distribution/v1\0')
    .update(JSON.stringify({ provenance: qualification.provenance, files: qualification.files, distribution: row })).digest('hex'),
  files: qualification.files }
}
