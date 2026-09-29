import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import baseline from '../../manifests/rc020-rc1-byte-audit.json' with { type: 'json' }
import type { PackageRow } from './digest.js'
import { mkdirSync, readFileSync, writeFileSync, lstatSync, realpathSync, existsSync } from 'node:fs'
import { join, sep } from 'node:path'
import { hostProgramDigest } from './host-contract-program.js'
import { HOST_CONTRACT_SCHEMA, runHostContractProbe, type ProbeArchive } from './host-contract-probe.js'
import { hostNodeConditions } from './host-node-conditions.js'
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
  qualification: 'guard-host-contract/v1'
  packages: HostTrustedPackage[]
  probeDependencies?: HostTrustedPackage[]
  contract: { schema: typeof HOST_CONTRACT_SCHEMA; receiptDigest: string; bindingDigest: string; conditionsDigest: string }
  /** Recomputed qualification, not caller-reported compatibility. */
  unqualifiedOptionalPackages?: string[]
}
export class HostTrustError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'HostTrustError' }
}
const fail = (code: string): never => { throw new HostTrustError(code) }

interface ContractReceipt {
  schema: typeof HOST_CONTRACT_SCHEMA
  bindingDigest: string
  conditionsDigest: string
  checks: string[]
  unqualifiedOptionalPackages: string[]
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => current && typeof current === 'object' && !Array.isArray(current)
    ? Object.fromEntries(Object.entries(current).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : current)
}
const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex')
function bindingDigest(packages: readonly HostTrustedPackage[], dependencies: readonly HostTrustedPackage[] = []): string {
  return hash([...packages, ...dependencies].sort((a, b) => a.name < b.name ? -1 : 1))
}
function receiptPath(profileRoot: string, digest: string): string {
  return join(profileRoot, '.dsh-completion-guard', 'host-contracts', digest + '.json')
}
function readReceipt(profileRoot: string | undefined, trust: HostRebindTrust): ContractReceipt {
  if (!profileRoot || trust.contract?.schema !== HOST_CONTRACT_SCHEMA || !/^[a-f0-9]{64}$/.test(trust.contract.receiptDigest)) return fail('host_trust_contract_receipt_missing')
  const root = realpathSync(profileRoot), path = receiptPath(root, trust.contract.receiptDigest)
  try {
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || realpathSync(path) !== path || !path.startsWith(root + sep)) return fail('host_trust_contract_receipt_invalid')
    const bytes = readFileSync(path)
    if (bytes.length > 256 * 1024) return fail('host_trust_contract_receipt_invalid')
    const receipt = JSON.parse(bytes.toString()) as ContractReceipt
    if (receipt.schema !== HOST_CONTRACT_SCHEMA || hash(receipt) !== trust.contract.receiptDigest
      || receipt.bindingDigest !== bindingDigest(trust.packages, trust.probeDependencies)
      || receipt.bindingDigest !== trust.contract.bindingDigest
      || receipt.conditionsDigest !== hostNodeConditions().digest
      || receipt.conditionsDigest !== trust.contract.conditionsDigest
      || !Array.isArray(receipt.checks) || !receipt.checks.length || !Array.isArray(receipt.unqualifiedOptionalPackages)) return fail('host_trust_contract_binding_mismatch')
    return receipt
  } catch (error) { if (error instanceof HostTrustError) throw error; return fail('host_trust_contract_receipt_missing') }
}
/** Validate generator-issued operator-owned authority. The descriptor cannot
 * assert compatibility: changed bytes require the independently issued cache
 * receipt, whose complete byte graph and startup conditions are bound. */
export function qualifyHostTrust(value: unknown, profileRoot?: string): HostRebindTrust {
  const trust = value as HostRebindTrust | undefined
  if (trust?.schema !== 'dsh-host-registry-trust/v1' || trust.source !== 'https://registry.npmjs.org/'
    || trust.qualification !== HOST_CONTRACT_SCHEMA || !Array.isArray(trust.packages)) return fail('host_trust_source_untrusted')
  const known = new Set(baseline.packages.map((p) => p.name)), names = new Set<string>()
  for (const row of [...trust.packages, ...(trust.probeDependencies ?? [])]) {
    if (!row || names.has(row.name) || !parseHostVersion(row.version) || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(row.integrity)
      || !row.modules || Array.isArray(row.modules) || !/^[a-f0-9]{64}$/.test(row.modules['package.json'])) return fail('host_trust_identity_invalid')
    for (const [file, digest] of Object.entries(row.modules)) if (!/^[a-f0-9]{64}$/.test(digest) || file.startsWith('/') || file.includes('\\') || file.split('/').some((part) => !part || part === '.' || part === '..')) return fail('host_trust_identity_invalid')
    names.add(row.name)
  }
  if (trust.packages.some((row) => !known.has(row.name))) return fail('host_trust_identity_invalid')
  const receipt = readReceipt(profileRoot, trust)
  return JSON.parse(JSON.stringify({ ...trust, unqualifiedOptionalPackages: receipt.unqualifiedOptionalPackages })) as HostRebindTrust
}
export function parseHostTrust(text: string, profileRoot?: string): HostRebindTrust {
  if (text.length > 4 * 1024 * 1024) return fail('host_trust_identity_invalid')
  try { return qualifyHostTrust(JSON.parse(text), profileRoot) } catch (error) {
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
export function registryArchiveFiles(bytes: Buffer, row: PackageRow): Record<string, Buffer> {
  if (bytes.length === 0 || bytes.length > 64 * 1024 * 1024
    || `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== row.integrity) return fail('host_trust_archive_integrity_mismatch')
  const tar = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 })
  const seen = new Set<string>(), files: Record<string, Buffer> = {}
  let manifest: Record<string, unknown> | undefined
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    const type = header[156]
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim()
    if (!/^[0-7]+$/.test(sizeText) || prefix || !name.startsWith('package/')
      || name.includes('\\') || name.includes('\0') || name.slice(8).split('/').some((part, index, parts) => part === '..' || part === '.' || (!part && index !== parts.length - 1)) || seen.has(name)) return fail('host_trust_archive_invalid')
    seen.add(name)
    const size = Number.parseInt(sizeText, 8), start = offset + 512, end = start + size
    if (!Number.isSafeInteger(size) || end > tar.length || ![0, 48, 53].includes(type)) return fail('host_trust_archive_invalid')
    if (type === 0 || type === 48) {
      const file = name.slice(8), content = tar.subarray(start, end)
      if (file === 'package.json') manifest = JSON.parse(content.toString('utf8')) as Record<string, unknown>
      if (/\.(?:[cm]?js|json)$/.test(file)) files[file] = Buffer.from(content)
    }
    offset = start + Math.ceil(size / 512) * 512
  }
  if (manifest?.name !== row.name || manifest.version !== row.version) return fail('host_trust_archive_identity_mismatch')
  return files
}
export function registryArchiveModules(bytes: Buffer, row: PackageRow): Record<string, string> {
  return Object.fromEntries(Object.entries(registryArchiveFiles(bytes, row)).map(([file, content]) => [file, createHash('sha256').update(content).digest('hex')]))
}

/** Fetch exact public registry identity at trusted inspect/rebind time.
 * Lockfile integrity is compared with HTTPS registry metadata AND archive bytes.
 * The production origin is fixed; tests can inject a fetch transport. */
export interface HostTrustAcquisitionOptions {
  profileRoot: string
  dependencyIdentity?: (name: string, importer: string) => PackageRow
}
export async function acquireHostTrust(rows: readonly PackageRow[], fetcher: typeof fetch = fetch,
  options?: HostTrustAcquisitionOptions): Promise<HostRebindTrust> {
  const packages: HostTrustedPackage[] = [], dependencies: HostTrustedPackage[] = [], archives: ProbeArchive[] = []
  const acquire = async (row: PackageRow): Promise<HostTrustedPackage> => {
    if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(row.name) || row.name.length > 214
      || !row.version || !parseHostVersion(row.version) || !row.integrity) return fail('host_trust_identity_invalid')
    const response = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(row.name)}/${encodeURIComponent(row.version)}`,
      { signal: AbortSignal.timeout(30_000), redirect: 'error' })
    if (!response.ok) return fail('host_trust_registry_unavailable')
    const metadata = await response.json() as { name?: string; version?: string; dist?: { integrity?: string; tarball?: string } }
    if (metadata.name !== row.name || metadata.version !== row.version || metadata.dist?.integrity !== row.integrity) return fail('host_trust_registry_identity_mismatch')
    const url = new URL(metadata.dist?.tarball ?? '')
    if (url.origin !== 'https://registry.npmjs.org' || url.username || url.password) return fail('host_trust_source_untrusted')
    const archive = await fetcher(url, { signal: AbortSignal.timeout(30_000), redirect: 'error' })
    if (!archive.ok) return fail('host_trust_registry_unavailable')
    const files = registryArchiveFiles(Buffer.from(await archive.arrayBuffer()), row)
    archives.push({ name: row.name, files })
    return { name: row.name, version: row.version, integrity: row.integrity,
      modules: Object.fromEntries(Object.entries(files).map(([file, content]) => [file, createHash('sha256').update(content).digest('hex')])) }
  }
  for (const row of rows) packages.push(await acquire(row))
  if (!options?.profileRoot) return fail('host_trust_receipt_root_missing')
  const targets: string[] = [], checks: string[] = []
  for (const row of packages) {
    const reference = baseline.packages.find((p) => p.name === row.name)
    if (!reference) return fail('host_trust_identity_invalid')
    const files = archives.find((a) => a.name === row.name)!.files
    const same = Object.entries(reference.modules).filter(([file]) => file !== 'package.json').every(([file, digest]) => {
      if (!files[file]) return false
      if (row.modules[file] === digest) return true
      const programs = (reference as unknown as { programs?: Record<string, string> }).programs
      try { return !!programs?.[file] && hostProgramDigest(files[file].toString('utf8')) === programs[file] } catch { return false }
    })
    if (same) checks.push('reviewed_program_equivalence:' + row.name)
    else targets.push(row.name)
  }
  // Only changed consumed programs execute. Follow their actual installed
  // imports to independently acquired dependency identities; no range/latest
  // selection and no local manifest/SRI assertion establishes provenance.
  const visited = new Set<string>(), queue = [...targets]
  while (queue.length) {
    const name = queue.shift()!
    if (visited.has(name)) continue
    visited.add(name)
    if (visited.size > 160) return fail('host_contract_probe_graph_too_large')
    const archive = archives.find((a) => a.name === name)!
    const manifest = JSON.parse(archive.files['package.json'].toString()) as { dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }> }
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }).filter((dependency) => !manifest.peerDependenciesMeta?.[dependency]?.optional || dependency in (manifest.dependencies ?? {}))) {
      if (!archives.some((a) => a.name === dependency)) {
        const identity = options.dependencyIdentity?.(dependency, name)
        if (!identity) return fail('host_contract_probe_dependency_unbound')
        dependencies.push(await acquire(identity))
      }
      queue.push(dependency)
    }
  }
  const result = targets.length ? runHostContractProbe(archives, targets) : { schema: HOST_CONTRACT_SCHEMA, checks: [], failures: [] }
  const coreFailure = result.failures.find((code) => code !== 'host_contract_goal_qualification_required')
  if (coreFailure) return fail(coreFailure)
  const optional = result.failures.length ? targets.filter((name) => ['@deepseek-ai/dsh-goal', '@deepseek-ai/dsh-tool-goal'].includes(name)) : []
  const receipt: ContractReceipt = { schema: HOST_CONTRACT_SCHEMA, bindingDigest: bindingDigest(packages, dependencies),
    conditionsDigest: hostNodeConditions().digest, checks: [...checks, ...result.checks].sort(), unqualifiedOptionalPackages: optional.sort() }
  const receiptDigest = hash(receipt), path = receiptPath(realpathSync(options.profileRoot), receiptDigest)
  const profile = realpathSync(options.profileRoot)
  for (const parent of [join(profile, '.dsh-completion-guard'), join(profile, '.dsh-completion-guard', 'host-contracts')]) {
    if (existsSync(parent)) {
      if (lstatSync(parent).isSymbolicLink() || !lstatSync(parent).isDirectory() || realpathSync(parent) !== parent) return fail('host_trust_contract_receipt_invalid')
    } else mkdirSync(parent, { mode: 0o700 })
  }
  if (!existsSync(path)) writeFileSync(path, canonical(receipt), { flag: 'wx', mode: 0o600 })
  const trust: HostRebindTrust = { schema: 'dsh-host-registry-trust/v1', source: 'https://registry.npmjs.org/',
    qualification: HOST_CONTRACT_SCHEMA, packages, probeDependencies: dependencies,
    contract: { schema: HOST_CONTRACT_SCHEMA, bindingDigest: receipt.bindingDigest, receiptDigest, conditionsDigest: receipt.conditionsDigest } }
  return qualifyHostTrust(trust, options.profileRoot)
}
