import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import baseline from '../../manifests/rc020-rc1-byte-audit.json' with { type: 'json' }
import type { PackageRow } from './digest.js'
import { parseHostVersion } from './host-version.js'

export interface HostTrustedPackage extends PackageRow {
  version: string
  integrity: string
  modules: Record<string, string>
}
/** Operator-owned output of registry acquisition, never package self-report. */
export interface HostRebindTrust {
  schema: 'dsh-host-registry-trust/v1'
  source: 'https://registry.npmjs.org/'
  qualification: 'reviewed-implementation-equivalence/v1'
  packages: HostTrustedPackage[]
  /** Recomputed qualification, not caller-reported compatibility. */
  unqualifiedOptionalPackages?: string[]
}
export class HostTrustError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'HostTrustError' }
}
const fail = (code: string): never => { throw new HostTrustError(code) }

/** Qualify consumed implementation semantics independently of version/metadata.
 * Manifest changes may describe a compatible release; unknown executable bytes
 * cannot inherit this adapter's reviewed Session/API behavior. */
export function qualifyHostTrust(value: unknown): HostRebindTrust {
  const trust = value as HostRebindTrust | undefined
  if (trust?.schema !== 'dsh-host-registry-trust/v1' || trust.source !== 'https://registry.npmjs.org/'
    || trust.qualification !== 'reviewed-implementation-equivalence/v1' || !Array.isArray(trust.packages)) {
    return fail('host_trust_source_untrusted')
  }
  const known = new Map(baseline.packages.map((p) => [p.name, p]))
  const names = new Set<string>()
  const unqualifiedOptionalPackages: string[] = []
  for (const row of trust.packages) {
    const reference = known.get(row.name)
    if (!reference || names.has(row.name) || !parseHostVersion(row.version)
      || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(row.integrity) || !row.modules
      || typeof row.modules !== 'object' || Array.isArray(row.modules)) return fail('host_trust_identity_invalid')
    names.add(row.name)
    const expected = reference.modules as unknown as Record<string, string>
    const executable = Object.keys(expected).filter((file) => file !== 'package.json').sort()
    const supplied = Object.keys(row.modules).filter((file) => file !== 'package.json').sort()
    if (JSON.stringify(executable) !== JSON.stringify(supplied)
      || executable.some((file) => row.modules[file] !== expected[file])) {
      if (row.name === '@deepseek-ai/dsh-goal' || row.name === '@deepseek-ai/dsh-tool-goal') unqualifiedOptionalPackages.push(row.name)
      else return fail(row.name === '@deepseek-ai/dsh-session' ? 'host_contract_session_incompatible' : 'host_contract_api_qualification_required')
    }
    if (!/^[a-f0-9]{64}$/.test(row.modules['package.json'])) return fail('host_trust_identity_invalid')
  }
  // Copy: config callers cannot mutate authority after evaluation.
  return JSON.parse(JSON.stringify({ ...trust, unqualifiedOptionalPackages: unqualifiedOptionalPackages.sort() })) as HostRebindTrust
}
export function parseHostTrust(text: string): HostRebindTrust {
  if (text.length > 2 * 1024 * 1024) return fail('host_trust_identity_invalid')
  try { return qualifyHostTrust(JSON.parse(text)) } catch (error) {
    if (error instanceof HostTrustError) throw error
    return fail('host_trust_identity_invalid')
  }
}
export function hostTrustDigest(trust: HostRebindTrust): string {
  const packages = [...trust.packages].sort((a, b) => a.name.localeCompare(b.name)).map((row) => ({
    name: row.name, version: row.version, integrity: row.integrity,
    modules: Object.fromEntries(Object.entries(row.modules).sort(([a], [b]) => a.localeCompare(b))),
  }))
  return createHash('sha256').update(JSON.stringify({ ...trust, packages })).digest('hex')
}

/** Closed-world regular-file tar projection. Never extract or execute archives. */
export function registryArchiveModules(bytes: Buffer, row: PackageRow): Record<string, string> {
  if (bytes.length === 0 || bytes.length > 64 * 1024 * 1024
    || `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== row.integrity) return fail('host_trust_archive_integrity_mismatch')
  const tar = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 })
  const seen = new Set<string>(), modules: Record<string, string> = {}
  let manifest: Record<string, unknown> | undefined
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    const type = header[156]
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim()
    if (!/^[0-7]+$/.test(sizeText) || prefix || !name.startsWith('package/')
      || name.split('/').some((part) => part === '..' || part === '.') || seen.has(name)) return fail('host_trust_archive_invalid')
    seen.add(name)
    const size = Number.parseInt(sizeText, 8), start = offset + 512, end = start + size
    if (!Number.isSafeInteger(size) || end > tar.length || ![0, 48, 53].includes(type)) return fail('host_trust_archive_invalid')
    if (type === 0 || type === 48) {
      const file = name.slice(8), content = tar.subarray(start, end)
      if (file === 'package.json') manifest = JSON.parse(content.toString('utf8')) as Record<string, unknown>
      if (file === 'package.json' || (file.startsWith('lib/') && /\.(?:[cm]?js)$/.test(file))) modules[file] = createHash('sha256').update(content).digest('hex')
    }
    offset = start + Math.ceil(size / 512) * 512
  }
  if (manifest?.name !== row.name || manifest.version !== row.version) return fail('host_trust_archive_identity_mismatch')
  return modules
}

/** Fetch exact public registry identity at trusted inspect/rebind time.
 * Lockfile integrity is compared with HTTPS registry metadata AND archive bytes.
 * The production origin is fixed; tests can inject a fetch transport. */
export async function acquireHostTrust(rows: readonly PackageRow[], fetcher: typeof fetch = fetch): Promise<HostRebindTrust> {
  const packages: HostTrustedPackage[] = []
  for (const row of rows) {
    if (!row.version || !parseHostVersion(row.version) || !row.integrity) return fail('host_trust_identity_invalid')
    const response = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(row.name)}/${encodeURIComponent(row.version)}`,
      { signal: AbortSignal.timeout(30_000), redirect: 'error' })
    if (!response.ok) return fail('host_trust_registry_unavailable')
    const metadata = await response.json() as { name?: string; version?: string; dist?: { integrity?: string; tarball?: string } }
    if (metadata.name !== row.name || metadata.version !== row.version || metadata.dist?.integrity !== row.integrity) return fail('host_trust_registry_identity_mismatch')
    const url = new URL(metadata.dist?.tarball ?? '')
    if (url.origin !== 'https://registry.npmjs.org' || url.username || url.password) return fail('host_trust_source_untrusted')
    const archive = await fetcher(url, { signal: AbortSignal.timeout(30_000), redirect: 'error' })
    if (!archive.ok) return fail('host_trust_registry_unavailable')
    packages.push({ name: row.name, version: row.version, integrity: row.integrity,
      modules: registryArchiveModules(Buffer.from(await archive.arrayBuffer()), row) })
  }
  return qualifyHostTrust({ schema: 'dsh-host-registry-trust/v1', source: 'https://registry.npmjs.org/',
    qualification: 'reviewed-implementation-equivalence/v1', packages })
}
