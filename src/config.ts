import z from '@deepseek-ai/schemastery'
import type { PackageRow } from './domain/digest.js'
import type { HostPlatform, HostProfileKind } from './domain/host-lock.js'

export const Config: z<{
  activation: string
  hostLockPackages?: PackageRow[]
  hostLockPlatform?: HostPlatform
  hostLockProfile?: HostProfileKind
}> = z.object({
  activation: z.string().default('opt-in'),
  hostLockPlatform: z.string() as z<HostPlatform>,
  hostLockProfile: z.string() as z<HostProfileKind>,
  hostLockPackages: z.array(z.object({
    name: z.string().required(),
    version: z.string(),
    integrity: z.string(),
  })),
})

export interface ResolvedConfig {
  activation: 'opt-in' | 'always'
  hostLockPackages?: PackageRow[]
  hostLockPlatform?: HostPlatform
  hostLockProfile?: HostProfileKind
}

export function resolveConfig(config: {
  activation?: unknown
  hostLockPackages?: unknown
  hostLockPlatform?: unknown
  hostLockProfile?: unknown
}): ResolvedConfig {
  const activation = config.activation ?? 'opt-in'
  if (activation !== 'opt-in' && activation !== 'always') {
    throw new TypeError(`activation must be "opt-in" or "always", received ${JSON.stringify(activation)}`)
  }
  let hostLockPackages: PackageRow[] | undefined
  if (config.hostLockPackages !== undefined) {
    if (!Array.isArray(config.hostLockPackages)) throw new TypeError('hostLockPackages must be an array')
    hostLockPackages = config.hostLockPackages.map((entry) => {
      if (!entry || typeof entry !== 'object') throw new TypeError('hostLockPackages entries must be objects')
      const row = entry as Record<string, unknown>
      if (typeof row.name !== 'string' || !row.name) throw new TypeError('hostLockPackages.name must be a non-empty string')
      if (row.version !== undefined && typeof row.version !== 'string') throw new TypeError('hostLockPackages.version must be a string')
      if (row.integrity !== undefined && typeof row.integrity !== 'string') throw new TypeError('hostLockPackages.integrity must be a string')
      return { name: row.name, ...(row.version ? { version: row.version } : {}), ...(row.integrity ? { integrity: row.integrity } : {}) }
    })
  }
  if (config.hostLockPlatform !== undefined && config.hostLockPlatform !== 'posix' && config.hostLockPlatform !== 'windows') {
    throw new TypeError('hostLockPlatform must be "posix" or "windows"')
  }
  if (config.hostLockProfile !== undefined && config.hostLockProfile !== 'headless' && config.hostLockProfile !== 'web') {
    throw new TypeError('hostLockProfile must be "headless" or "web"')
  }
  const hasHostRows = hostLockPackages !== undefined
  if (hasHostRows !== (config.hostLockPlatform !== undefined) || hasHostRows !== (config.hostLockProfile !== undefined)) {
    throw new TypeError('hostLockPackages, hostLockPlatform, and hostLockProfile must be injected together')
  }
  return {
    activation,
    ...(hostLockPackages ? { hostLockPackages } : {}),
    ...(config.hostLockPlatform ? { hostLockPlatform: config.hostLockPlatform } : {}),
    ...(config.hostLockProfile ? { hostLockProfile: config.hostLockProfile } : {}),
  }
}
