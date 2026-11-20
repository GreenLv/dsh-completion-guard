import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import rc2Baseline from './byte-audit-manifest.js'
import rc3Baseline from './rc3-byte-audit-manifest.js'
import rc5Baseline from './rc5-byte-audit-manifest.js'
import rc022rc1Baseline from './rc022-rc1-byte-audit-manifest.js'
import rc022rc2Baseline from './rc022-rc2-byte-audit-manifest.js'
import rc022rc3Baseline from './rc022-rc3-byte-audit-manifest.js'
import rc022rc5Baseline from './rc022-rc5-byte-audit-manifest.js'
import type { ByteAuditManifest } from './byte-audit-manifest.js'
import type { PackageRow } from './digest.js'
import { mkdirSync, readFileSync, writeFileSync, lstatSync, realpathSync, existsSync } from 'node:fs'
import { join, sep } from 'node:path'
import { hostProgramDigest, hostManifestLoadingDigest } from './host-contract-program.js'
import { HOST_CONTRACT_SCHEMA, HOST_CONTRACT_CONSUMERS, runHostContractProbe, type ProbeArchive } from './host-contract-probe.js'
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
  qualification: 'guard-host-contract/v2'
  packages: HostTrustedPackage[]
  probeDependencies?: HostTrustedPackage[]
  contract: { schema: typeof HOST_CONTRACT_SCHEMA; receiptDigest: string; bindingDigest: string; conditionsDigest: string }
  /** Recomputed qualification, not caller-reported compatibility. */
  unqualifiedOptionalPackages?: string[]
}
export class HostTrustError extends Error {
  /** Sanitized failure context (package/identity/member names and the rejected
   * condition). Never carries credentials, profiles or transport details. */
  constructor(readonly code: string, readonly detail?: string) { super(code); this.name = 'HostTrustError' }
}
const fail = (code: string, detail?: string): never => { throw new HostTrustError(code, detail) }

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
/** The reviewed executable-byte baseline for one acquired graph. The rc.3
 * and rc.5 cohorts' lib bytes are byte-identical to rc.2 but their package
 * manifests carry rewritten version/dependency fields, so the baseline must
 * match the ACQUIRED versions or every loading digest would spuriously
 * drift. All baselines come from the same audited-manifest schema. The
 * 0.2.2-rc.1 graph changed real bytes (executor split, batch tool execution,
 * official-bundle constants move), so it is its own reference; the 0.2.2-rc.2
 * graph changed further real bytes (session batch append, tool error
 * identity, working-directory access waterfall, sandbox-policy session
 * grants, jobs error codes), so it is its own reference; the 0.2.2-rc.3
 * graph rewrites the package manifests and changes the
 * dsh-official-bundles bytes (chat-export session import), so it is its own
 * reference and the default for graphs acquired above the current floor; the
 * pre-floor rows stay as historical evidence sources and the retained rc.1
 * graph stays its own reference, never an alias. */
function baselineFor(rows: readonly { name?: string; version?: string }[]): ByteAuditManifest {
  // Exact pre-floor graphs retain their own references; no receipt can
  // bypass the separate current floor. Everything else — including future
  // versions above the floor — starts from the 0.2.2-rc.3 baseline and must
  // qualify against it or fail closed on the byte mismatch.
  switch (rows.find((row) => row.name === '@deepseek-ai/dsh')?.version) {
    case '0.2.1-rc.2': return rc2Baseline
    case '0.2.1-rc.3': return rc3Baseline
    case '0.2.1-rc.5': return rc5Baseline
    case '0.2.2-rc.1': return rc022rc1Baseline
    case '0.2.2-rc.2': return rc022rc2Baseline
    case '0.2.2-rc.3': return rc022rc3Baseline
    default: return rc022rc5Baseline
  }
}
/** Every reviewed published state, for equivalence checks: a graph whose lib
 * bytes match ANY audited baseline while carrying another baseline's loading
 * digest is still one reviewed published state, so equivalence is accepted
 * only when loading AND modules come from the SAME reference row. The
 * 0.2.2-rc.1, 0.2.2-rc.2 and 0.2.2-rc.3 states are each byte-distinct from
 * every other audited state. */
const AUDITED_BASELINES: readonly ByteAuditManifest[] = [rc2Baseline, rc3Baseline, rc5Baseline, rc022rc1Baseline, rc022rc2Baseline, rc022rc3Baseline, rc022rc5Baseline]

/** Validate generator-issued operator-owned authority. The descriptor cannot
 * assert compatibility: changed bytes require the independently issued cache
 * receipt, whose complete byte graph and startup conditions are bound. */
export function qualifyHostTrust(value: unknown, profileRoot?: string): HostRebindTrust {
  const trust = value as HostRebindTrust | undefined
  if (trust?.schema !== 'dsh-host-registry-trust/v1' || trust.source !== 'https://registry.npmjs.org/'
    || trust.qualification !== HOST_CONTRACT_SCHEMA || !Array.isArray(trust.packages)) return fail('host_trust_source_untrusted')
  const known = new Set(baselineFor(trust.packages).packages.map((p) => p.name)), names = new Set<string>()
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

interface PaxRecords { path?: string; size?: number; nodeType?: string }
const paxMetadataKeys = new Set(['mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname', 'comment', 'SCHILY.dev', 'SCHILY.ino', 'SCHILY.nlink', 'LIBARCHIVE.creationtime'])
function archiveText(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return fail('host_trust_archive_invalid', 'archive contains invalid UTF-8') }
}
/** Parse the entire length-delimited PAX body. Unsupported semantic keys and
 * ambiguous/malformed records never fall back to the stored tar header. */
function parsePaxRecords(data: Buffer): PaxRecords {
  const records: PaxRecords = {}, seen = new Set<string>()
  for (let offset = 0; offset < data.length;) {
    const space = data.indexOf(0x20, offset)
    const lengthText = space < 0 ? '' : data.subarray(offset, space).toString('ascii')
    if (!/^[1-9][0-9]*$/.test(lengthText)) return fail('host_trust_archive_invalid', 'invalid PAX record length')
    const length = Number(lengthText), end = offset + length
    if (!Number.isSafeInteger(length) || length <= space - offset + 3 || end > data.length || data[end - 1] !== 0x0a) {
      return fail('host_trust_archive_invalid', 'incomplete PAX record')
    }
    const record = archiveText(data.subarray(space + 1, end - 1)), equals = record.indexOf('=')
    const key = record.slice(0, equals), value = record.slice(equals + 1)
    if (equals < 1 || !/^[A-Za-z0-9_.-]+$/.test(key) || seen.has(key) || value.includes('\0')) {
      return fail('host_trust_archive_invalid', 'invalid or duplicate PAX key')
    }
    seen.add(key)
    if (key === 'path') {
      if (!value) return fail('host_trust_archive_invalid', 'empty PAX path')
      records.path = value
    } else if (key === 'size') {
      if (!/^(?:0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) return fail('host_trust_archive_invalid', 'invalid PAX size')
      records.size = Number(value)
    } else if (key === 'NODETAR.type') {
      // This legacy npm metadata describes the same member; it must not
      // silently reinterpret a directory or link as a regular file.
      if (value !== 'File') return fail('host_trust_archive_invalid', 'unsupported NODETAR member type')
      records.nodeType = value
    } else if (key === 'NODETAR.follow') {
      if (value !== 'false') return fail('host_trust_archive_invalid', 'unsupported NODETAR follow')
    } else if (key === 'SCHILY.nlink') {
      if (value !== '1') return fail('host_trust_archive_invalid', 'unsupported PAX link count')
    } else if (/^NODETAR\.(?:depth|blksize|blocks)$/u.test(key)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return fail('host_trust_archive_invalid', 'invalid NODETAR numeric metadata')
    } else if (/^NODETAR\.ignoreFiles\.[0-9]+$/u.test(key) || /^NODETAR\.package\.[A-Za-z0-9_.-]+$/u.test(key)) {
      // Archive producer metadata; none of these fields changes tar semantics.
    } else if (!paxMetadataKeys.has(key)) {
      return fail('host_trust_archive_invalid', 'unsupported PAX semantic key')
    }
    offset = end
  }
  return records
}

/** Project regular JS/JSON files without extracting or executing the archive.
 * Supports ustar prefixes, PAX path/size, dot aliases and one publisher root.
 * Local PAX overrides global state; only an identical file at a DISTINCT dot
 * alias can repeat. Roots, directories and exact paths never bypass type or
 * duplicate checks. Unsupported extensions fail closed. */
export function registryArchiveFiles(bytes: Buffer, row: PackageRow): Record<string, Buffer> {
  if (bytes.length === 0 || bytes.length > 64 * 1024 * 1024
    || `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== row.integrity) return fail('host_trust_archive_integrity_mismatch')
  const tar = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 })
  const entries = new Map<string, { type: number; body: Buffer; paths: Set<string> }>(), parents = new Set<string>(), files: Record<string, Buffer> = {}
  let manifest: Record<string, unknown> | undefined, root: string | undefined
  let globalPax: PaxRecords = {}, localPax: PaxRecords | undefined, terminated = false
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) {
      if (tar.subarray(offset).some(byte => byte !== 0)) return fail('host_trust_archive_invalid', 'data after archive terminator')
      terminated = true
      break
    }
    const field = (start: number, end: number): string => {
      const bytes = header.subarray(start, end), nul = bytes.indexOf(0)
      return archiveText(nul < 0 ? bytes : bytes.subarray(0, nul))
    }
    const name = field(0, 100), prefix = field(345, 500), type = header[156]
    const sizeText = field(124, 136).trim(), start = offset + 512
    const declaredSize = /^[0-7]+$/.test(sizeText) ? Number.parseInt(sizeText, 8) : Number.NaN
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || start + declaredSize > tar.length) return fail('host_trust_archive_invalid', 'out-of-range tar size field')
    if (type === 120 || type === 103) {
      if (localPax !== undefined) return fail('host_trust_archive_invalid', 'unconsumed local PAX header')
      const records = parsePaxRecords(tar.subarray(start, start + declaredSize))
      if (type === 103) globalPax = { ...globalPax, ...records }
      else localPax = records
      offset = start + Math.ceil(declaredSize / 512) * 512
      continue
    }
    const stored = localPax?.path ?? globalPax.path ?? (prefix ? `${prefix}/${name}` : name)
    const size = localPax?.size ?? globalPax.size ?? declaredSize
    const nodeType = localPax?.nodeType ?? globalPax.nodeType
    localPax = undefined
    if (nodeType && type !== 0 && type !== 48) return fail('host_trust_archive_invalid', 'NODETAR type conflicts with tar member')
    if (!Number.isSafeInteger(size) || size < 0 || start + Math.ceil(size / 512) * 512 > tar.length) return fail('host_trust_archive_invalid', 'out-of-range tar member size')
    const body = tar.subarray(start, start + size)
    offset = start + Math.ceil(size / 512) * 512
    if (![0, 48, 53].includes(type) || (type === 53 && size !== 0)) return fail('host_trust_archive_invalid', `member '${stored}' has unsupported type or directory content`)
    if (stored.startsWith('/') || stored.includes('\\') || /[\u0000-\u001f\u007f]/u.test(stored)) return fail('host_trust_archive_invalid', `member '${stored}' is not a relative portable path`)
    const parts = stored.split('/'), trailingSlash = parts.at(-1) === ''
    if (trailingSlash) parts.pop()
    if (parts.some(part => part === '' || part === '..')) return fail('host_trust_archive_invalid', `member '${stored}' has no portable path under one root`)
    const normalized = parts.filter(part => part !== '.')
    if (!normalized.length) return fail('host_trust_archive_invalid', 'empty normalized member path')
    const member = normalized.join('/')
    root ??= normalized[0]
    if (normalized[0] !== root) return fail('host_trust_archive_invalid', `member '${member}' escapes the single root`)
    if ((member === root && type !== 53) || (trailingSlash && type !== 53)) return fail('host_trust_archive_invalid', `member '${member}' is not a directory`)
    if (type !== 53 && parents.has(member)) return fail('host_trust_archive_invalid', `member '${member}' conflicts with a directory`)
    for (let i = 1; i < normalized.length; i++) {
      const parent = normalized.slice(0, i).join('/')
      const entry = entries.get(parent)
      if (entry && entry.type !== 53) return fail('host_trust_archive_invalid', `member '${member}' conflicts with a file ancestor`)
      parents.add(parent)
    }
    const previous = entries.get(member)
    if (previous) {
      if (type === 53 || previous.type === 53 || previous.paths.has(stored) || !previous.body.equals(body)) return fail('host_trust_archive_invalid', `duplicate member '${member}'`)
      previous.paths.add(stored)
      continue
    }
    entries.set(member, { type, body, paths: new Set([stored]) })
    if (type === 53) continue
    const file = member.slice(root.length + 1)
    if (file === 'package.json') manifest = JSON.parse(archiveText(body)) as Record<string, unknown>
    if (/\.(?:[cm]?js|json)$/.test(file)) files[file] = Buffer.from(body)
  }
  if (!terminated || localPax !== undefined) return fail('host_trust_archive_invalid', 'incomplete archive or PAX state')
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
  /** An outer caller may include its own setup in the same operation budget. */
  signal?: AbortSignal
  /** Resolves the exact installed identity of a not-yet-acquired dependency
   * reached through a consumed adapter's imports. May be async: the Desktop
   * lane reads the app-graph manifest first and then completes the identity
   * with the trusted registry integrity for exactly that name@version. */
  dependencyIdentity?: (name: string, importer: string, signal: AbortSignal, importerIdentity: PackageRow) => PackageRow | Promise<PackageRow>
}

// A contract probe uses one flat package tree. Each importer must resolve a
// dependency to that same exact registry identity before it can be placed in
// the tree. Keep graph and download work bounded before fetching new nodes.
const MAX_PROBE_PACKAGES = 1024
const MAX_PROBE_EDGES = 8192
const MAX_PROBE_ARCHIVE_BYTES = 512 * 1024 * 1024
const MAX_PROBE_PROJECTED_BYTES = 1024 * 1024 * 1024
export const HOST_TRUST_DURATION_MS: number = 10 * 60_000

export async function awaitSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return fail('host_contract_probe_timeout')
  let onAbort: (() => void) | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new HostTrustError('host_contract_probe_timeout'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try { return await Promise.race([work, timeout]) }
  finally { if (onAbort) signal.removeEventListener('abort', onAbort) }
}

export async function readBoundedResponse(response: Response, limit: number, code: string, signal: AbortSignal, detail?: string): Promise<Buffer> {
  const reader = response.body?.getReader()
  if (!reader) return fail(code)
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await awaitSignal(reader.read(), signal)
      if (done) break
      size += value.byteLength
      if (size > limit) {
        void reader.cancel().catch(() => {})
        return fail(code, detail)
      }
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks, size)
  } catch (error) {
    if (error instanceof HostTrustError) throw error
    void reader.cancel().catch(() => {})
    return fail('host_trust_registry_unavailable', detail)
  } finally { reader.releaseLock() }
}

export function parseRegistryMetadata(bytes: Buffer, detail: string): { name?: string; version?: string; dist?: { integrity?: string; tarball?: string } } {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('host_trust_registry_metadata_invalid', detail)
    return value as { name?: string; version?: string; dist?: { integrity?: string; tarball?: string } }
  }
  catch { return fail('host_trust_registry_metadata_invalid', detail) }
}

export async function acquireHostTrust(rows: readonly PackageRow[], fetcher: typeof fetch = fetch,
  options?: HostTrustAcquisitionOptions): Promise<HostRebindTrust> {
  const packages: HostTrustedPackage[] = [], dependencies: HostTrustedPackage[] = [], archives: ProbeArchive[] = []
  const identities = new Map<string, PackageRow>()
  let archiveBytes = 0, projectedBytes = 0
  const duration = AbortSignal.timeout(HOST_TRUST_DURATION_MS)
  const deadline = options?.signal ? AbortSignal.any([options.signal, duration]) : duration
  const request = async (url: string, detail: string): Promise<{ response: Response; signal: AbortSignal }> => {
    if (deadline.aborted) return fail('host_contract_probe_timeout', detail)
    const signal = AbortSignal.any([deadline, AbortSignal.timeout(30_000)])
    try {
      const response = await awaitSignal(fetcher(url, { signal, redirect: 'error' }), signal)
      if (!response.ok) return fail('host_trust_registry_unavailable', detail)
      return { response, signal }
    } catch (error) {
      if (error instanceof HostTrustError) throw new HostTrustError(error.code, detail)
      return fail('host_trust_registry_unavailable', detail)
    }
  }
  if (rows.length > MAX_PROBE_PACKAGES || new Set(rows.map(row => row.name)).size !== rows.length) return fail('host_contract_probe_graph_too_large')
  // The equivalence baseline follows the acquired launcher version (rc.3 vs
  // rc.2); qualifiedHostTrust re-derives it the same way for validation.
  const baseline = baselineFor(rows)
  const acquire = async (row: PackageRow): Promise<HostTrustedPackage> => {
    if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(row.name) || row.name.length > 214
      || !row.version || !parseHostVersion(row.version) || !row.integrity) return fail('host_trust_identity_invalid')
    const metadataDetail = `package ${row.name}@${row.version}: metadata request failed`
    const fetchedMetadata = await request(`https://registry.npmjs.org/${encodeURIComponent(row.name)}/${encodeURIComponent(row.version)}`, metadataDetail)
    const metadata = parseRegistryMetadata(await readBoundedResponse(fetchedMetadata.response, 4 * 1024 * 1024, 'host_trust_registry_metadata_too_large', fetchedMetadata.signal, metadataDetail), metadataDetail)
    if (metadata.name !== row.name || metadata.version !== row.version || metadata.dist?.integrity !== row.integrity) return fail('host_trust_registry_identity_mismatch')
    const url = new URL(metadata.dist?.tarball ?? '')
    if (url.origin !== 'https://registry.npmjs.org' || url.username || url.password) return fail('host_trust_source_untrusted')
    const archiveDetail = `package ${row.name}@${row.version}: archive request failed`
    const archive = await request(url.href, archiveDetail)
    let files: Record<string, Buffer>
    try {
      const bytes = await readBoundedResponse(archive.response, Math.min(64 * 1024 * 1024, MAX_PROBE_ARCHIVE_BYTES - archiveBytes), 'host_contract_probe_archive_budget_exceeded', archive.signal, archiveDetail)
      archiveBytes += bytes.length
      files = registryArchiveFiles(bytes, row)
      projectedBytes += Object.values(files).reduce((sum, content) => sum + content.length, 0)
      if (projectedBytes > MAX_PROBE_PROJECTED_BYTES) return fail('host_contract_probe_archive_budget_exceeded')
    } catch (error) {
      if (error instanceof HostTrustError) {
        // Package-level context around the sanitized member detail; the
        // acquisition phase (identity/registry/SRI/tar projection) stays visible.
        throw new HostTrustError(error.code, `package ${row.name}@${row.version}${error.detail ? `: ${error.detail}` : ''}`)
      }
      throw error
    }
    archives.push({ name: row.name, files })
    identities.set(row.name, row)
    return { name: row.name, version: row.version, integrity: row.integrity,
      modules: Object.fromEntries(Object.entries(files).map(([file, content]) => [file, createHash('sha256').update(content).digest('hex')])) }
  }
  for (const row of rows) packages.push(await acquire(row))
  if (!options?.profileRoot) return fail('host_trust_receipt_root_missing')
  const targets: string[] = [], checks: string[] = [], equivalent = new Set<string>()
  const normalizedEdges: Array<{ importer: string; dependency: string; version: string }> = []
  const reviewedEquivalent = (row: HostTrustedPackage, files: Record<string, Buffer>, allowLockstepRewrite = false): boolean => {
    // The acquired bytes must match ONE reviewed published state. The rc.3/rc.5
    // manifests carry rewritten version/dependency fields over identical lib
    // bytes, so a graph can legitimately equal a newer baseline's loading
    // digest while its lib bytes equal the OLDER baselines too; require
    // loading AND modules from the SAME reference row.
    for (const manifest of AUDITED_BASELINES) {
      const reference = manifest.packages.find(p => p.name === row.name)
      if (!reference) continue
      const referenceDigest = (reference as unknown as { loadingDigest?: string }).loadingDigest
      let loadingDigest = hostManifestLoadingDigest(files['package.json'].toString())
      const launcherVersion = rows.find(packageRow => packageRow.name === '@deepseek-ai/dsh')?.version
      let normalized = false
      const rewritten: string[] = []
      // Official lockstep builds rewrite exact internal DSH dependency and peer
      // versions. Compare that narrowly normalized manifest against a reviewed
      // release, keeping names, all other fields and every executable byte bound.
      // This does not normalize a new range, an external dependency or code.
      if (allowLockstepRewrite && loadingDigest !== referenceDigest && launcherVersion && row.version === launcherVersion) {
        const published = JSON.parse(files['package.json'].toString()) as Record<string, unknown>
        for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
          const dependencies = published[field]
          if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue
          for (const [name, version] of Object.entries(dependencies)) {
            if ((name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) && version === launcherVersion) {
              ;(dependencies as Record<string, unknown>)[name] = manifest.hostVersion
              const optionalPeers = published.peerDependenciesMeta as Record<string, { optional?: boolean }> | undefined
              if (field === 'dependencies' || (field === 'peerDependencies' && !optionalPeers?.[name]?.optional)) rewritten.push(name)
            }
          }
        }
        loadingDigest = hostManifestLoadingDigest(JSON.stringify(published))
        normalized = true
      }
      if (loadingDigest !== referenceDigest) continue
      if (normalized) {
        const currentFiles = Object.keys(row.modules).filter(file => file !== 'package.json').sort()
        const referenceFiles = Object.keys(reference.modules).filter(file => file !== 'package.json').sort()
        if (JSON.stringify(currentFiles) !== JSON.stringify(referenceFiles)) continue
      }
      const modulesOk = Object.entries(reference.modules).filter(([file]) => file !== 'package.json').every(([file, digest]) => {
        if (!files[file]) return false
        if (row.modules[file] === digest) return true
        const programs = (reference as unknown as { programs?: Record<string, string> }).programs
        try { return !!programs?.[file] && hostProgramDigest(files[file].toString('utf8')) === programs[file] } catch { return false }
      })
      if (modulesOk) {
        if (normalized && launcherVersion) for (const dependency of rewritten) normalizedEdges.push({ importer: row.name, dependency, version: launcherVersion })
        return true
      }
    }
    return false
  }
  for (const row of packages) {
    const reference = baseline.packages.find((p) => p.name === row.name)
    if (!reference) return fail('host_trust_identity_invalid')
    const files = archives.find((a) => a.name === row.name)!.files
    const same = reviewedEquivalent(row, files, true)
    if (same) equivalent.add(row.name)
    else targets.push(row.name)
  }
  // Validate each rewritten edge against the actual importer's installed
  // dependency. Rows outside the critical inventory get their SRI from the
  // registry as well; version strings alone never establish that identity.
  const normalizedIntegrity = new Map<string, string>()
  if (normalizedEdges.length > MAX_PROBE_EDGES) return fail('host_contract_probe_graph_too_large')
  for (const edge of normalizedEdges) {
    const importerIdentity = identities.get(edge.importer)!
    const identity = await awaitSignal(Promise.resolve().then(() => options.dependencyIdentity?.(edge.dependency, edge.importer, deadline, importerIdentity)), deadline)
    if (!identity || identity.name !== edge.dependency || identity.version !== edge.version || !identity.integrity) {
      return fail('host_contract_probe_dependency_unbound')
    }
    const known = identities.get(identity.name)
    if (known && (known.version !== identity.version || known.integrity !== identity.integrity)) return fail('host_contract_probe_dependency_conflict')
    const previous = normalizedIntegrity.get(identity.name)
    if (previous && previous !== identity.integrity) return fail('host_contract_probe_dependency_conflict')
    if (!known && !previous) {
      const detail = `package ${identity.name}@${identity.version}: metadata request failed`
      const fetched = await request(`https://registry.npmjs.org/${encodeURIComponent(identity.name)}/${encodeURIComponent(identity.version)}`, detail)
      const metadata = parseRegistryMetadata(await readBoundedResponse(fetched.response, 4 * 1024 * 1024, 'host_trust_registry_metadata_too_large', fetched.signal, detail), detail)
      if (metadata.name !== identity.name || metadata.version !== identity.version || metadata.dist?.integrity !== identity.integrity) {
        return fail('host_trust_registry_identity_mismatch')
      }
      normalizedIntegrity.set(identity.name, identity.integrity)
    }
  }
  // Follow every consumed adapter's actual installed
  // imports to independently acquired dependency identities; no range/latest
  // selection and no local manifest/SRI assertion establishes provenance.
  const visited = new Set<string>(), queue = [...new Set([...targets, ...packages.filter(p => (HOST_CONTRACT_CONSUMERS as readonly string[]).includes(p.name)).map(p => p.name)])]
  let edges = 0
  while (queue.length) {
    const name = queue.shift()!
    if (visited.has(name)) continue
    visited.add(name)
    if (visited.size > MAX_PROBE_PACKAGES) return fail('host_contract_probe_graph_too_large')
    const archive = archives.find((a) => a.name === name)!
    const manifest = JSON.parse(archive.files['package.json'].toString()) as { dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }> }
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }).filter((dependency) => !manifest.peerDependenciesMeta?.[dependency]?.optional || dependency in (manifest.dependencies ?? {}))) {
      if (++edges > MAX_PROBE_EDGES) return fail('host_contract_probe_graph_too_large')
      if (!identities.has(dependency) && identities.size >= MAX_PROBE_PACKAGES) return fail('host_contract_probe_graph_too_large')
      const importerIdentity = identities.get(name)!
      const identity = await awaitSignal(Promise.resolve().then(() => options.dependencyIdentity?.(dependency, name, deadline, importerIdentity)), deadline)
      if (!identity || identity.name !== dependency || !identity.version || !identity.integrity) return fail('host_contract_probe_dependency_unbound')
      const existing = identities.get(dependency)
      if (existing && (existing.version !== identity.version || existing.integrity !== identity.integrity)) {
        return fail('host_contract_probe_dependency_conflict', `dependency ${dependency} resolves to conflicting identities`)
      }
      if (!existing) {
        if (identities.size >= MAX_PROBE_PACKAGES) return fail('host_contract_probe_graph_too_large')
        dependencies.push(await acquire(identity))
      }
      queue.push(dependency)
    }
  }
  for (const row of dependencies.filter(p => (HOST_CONTRACT_CONSUMERS as readonly string[]).includes(p.name))) {
    if (reviewedEquivalent(row, archives.find(a => a.name === row.name)!.files)) equivalent.add(row.name)
    else targets.push(row.name)
  }
  // Equivalence of an adapter's own old file is not equivalence of its
  // dependency graph. Unknown/changed dependencies are exercised through the
  // consumed adapters in both actual loading lanes and bound in the receipt.
  const graphEquivalent = (name: string, seen = new Set<string>()): boolean => {
    if (seen.has(name)) return true
    seen.add(name)
    if (!equivalent.has(name)) return false
    const archive = archives.find(a => a.name === name)!
    const manifest = JSON.parse(archive.files['package.json'].toString()) as { dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }> }
    return Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }).filter(n => !manifest.peerDependenciesMeta?.[n]?.optional || n in (manifest.dependencies ?? {})).every(n => graphEquivalent(n, seen))
  }
  for (const row of [...packages, ...dependencies.filter(p => (HOST_CONTRACT_CONSUMERS as readonly string[]).includes(p.name))]) if (equivalent.has(row.name)) {
    if ((HOST_CONTRACT_CONSUMERS as readonly string[]).includes(row.name) && !graphEquivalent(row.name)) {
      targets.push(row.name); checks.push('reviewed_program_bytes:' + row.name)
    } else checks.push('reviewed_program_equivalence:' + row.name)
  }
  const result = targets.length ? runHostContractProbe(archives, [...new Set(targets)]) : { schema: HOST_CONTRACT_SCHEMA, checks: [], failures: [] }
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
