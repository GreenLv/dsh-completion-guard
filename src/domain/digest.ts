import { createHash } from 'node:crypto'

/**
 * Digest v3 canonical manifest derivation for Context Guard certificates.
 *
 * This is the DSH-side implementation of the frozen cross-language digest
 * contract documented in `docs/SEMANTIC_COMPATIBILITY.md`. The canonical
 * fixture lives in codex-context-guard (`tests/fixtures/conformance/digest_v3`)
 * and is byte-mirrored under `tests/fixtures/conformance/digest_v3` together
 * with `UPSTREAM_PIN.json`; the vitest suite re-derives all 29 golden vectors
 * and fails on any byte difference. Any change to the algorithm, separators,
 * typed token language, allowlists, or serialization is a new digest version
 * and must regenerate the vectors in both repositories.
 *
 * Fail-closed rules pinned here: lone surrogates are rejected before hashing,
 * values are never Unicode-normalized, dynamic keys must match the snake_case
 * grammar, collections reject duplicate members, canonical maps sort by
 * semantic key bytes (never by encoded field bytes), and predicate digests are
 * always recomputed from the actual parameter payload.
 */

export class DigestError extends Error {}

export const DIGEST_VERSION = '3'

export const MAX_ENCODED_NAME_BYTES = 256
export const MAX_SEMANTIC_KEY_BYTES = 64
export const MAX_PACKAGE_NAME_BYTES = 128
export const MAX_VALUE_BYTES = 4096
export const MAX_FIELDS_PER_RECORD = 128
export const MAX_PRED_PARAMS_BYTES = 4096

const DYNAMIC_KEY_RE = /^[a-z0-9_]{1,64}$/
const PACKAGE_NAME_RE = /^[@a-z0-9._/-]{1,128}$/
const ENUM_TOKEN_RE = /^[a-z0-9][a-z0-9_-]*$/
const HEX_RE = /^[0-9a-f]+$/

export const SURFACE_ENUM = ['artifact', 'ui', 'visual', 'scope'] as const
export const OUTCOME_ENUM = ['success', 'failure', 'unknown', 'durability-unknown'] as const
export const EVIDENCE_ROLE_ENUM = ['resolution', 'effect', 'state'] as const
export const PRED_PARAMS_KIND_ENUM = ['inline', 'manifest'] as const

export type Surface = (typeof SURFACE_ENUM)[number]
export type Outcome = (typeof OUTCOME_ENUM)[number]
export type EvidenceRole = (typeof EVIDENCE_ROLE_ENUM)[number]
export type PredParamsKind = (typeof PRED_PARAMS_KIND_ENUM)[number]

/** Frozen canonical key vocabulary; product manifests draw allowlists from it. */
export const PRODUCT_KEY_VOCABULARY: readonly string[] = [
  'repository', 'remote', 'refspec', 'upstream_oid', 'pre_head_oid', 'post_head_oid',
  'tracking_ref_oid', 'pull_mode', 'branch', 'change_set_digest', 'local_oid',
  'remote_oid', 'package_id', 'version', 'integrity_digest', 'profile',
  'artifact_id', 'scope', 'pre_digest', 'post_digest', 'service_id',
  'pre_generation', 'new_generation', 'health', 'registry', 'executable',
  'expected_outcome', 'min_matches',
]

export type TypedObject = { k: 'b' | 'i' | 's' | 'e' | 'x'; v: unknown }
export type Typed = boolean | number | string | TypedObject

export interface SessionHeader {
  version: number
  id: string
  createdAt: number
  parentSession?: string
  seedLength?: number
  agentPreset?: string
  origin?: string
  delegationDepth?: number
}

export interface CapabilityRow {
  name: string
  value: Typed
}

export interface PackageRow {
  name: string
  version?: string
  integrity?: string
}

export interface HostLockManifest {
  manifestVersion: number
  supportedGoalVersions: string[]
  capabilities?: CapabilityRow[]
  packages?: PackageRow[]
}

export interface EvidenceFact {
  id: string
  outcome: Outcome
  method: string
  operations?: string[]
  executables?: string[]
  subjects?: string[]
  surfaces: Surface[]
  semanticAction: string
  evidenceRole: EvidenceRole
  resolvedTarget?: Record<string, Typed>
  observedState?: Record<string, Typed>
  parseStatus: string
  reasonCode?: string
  adapterId?: string
  adapterVersion?: string
}

export interface PredParamsInput {
  keyAllowlist?: 'product' | string[]
  params: Record<string, Typed>
}

export interface BindingRecord {
  item: string
  semanticAction: string
  requestedTarget?: Record<string, Typed>
  resolvedTarget?: Record<string, Typed>
  observedState?: Record<string, Typed>
  predId: string
  predVersion: number
  predParamsKind: PredParamsKind
  /** inline branch: the actual parameter payload (or a fixture vector ref before materialization). */
  predParams?: Record<string, Typed> | { ref: string }
  predParamsAllowlist?: 'product' | string[]
  /** manifest branch: the referenced manifest entry payload is required so the digest is recomputed. */
  predParamsRef?: string
  predParamsManifest?: Record<string, Typed>
  predParamsManifestAllowlist?: 'product' | string[]
  resolutionEvidenceId?: string
  effectEvidenceId: string
  stateEvidenceIds?: string[]
}

export interface CertificateInput {
  stopProtocolVersion: string
  certificateVersion: string
  epoch: number
  sessionRefDigest: string
  hostLockDigest: string
  contractRevision: number
  contractSha256: string
  goalRef?: { id: string; revision: number }
  openDigest: string
  evidenceSha256: string
  bindingDigest: string
}

function sha256Hex(payload: Buffer | string): string {
  return createHash('sha256').update(payload).digest('hex')
}

function isWellFormedString(value: string): boolean {
  // Equivalent to String.prototype.isWellFormed (ES2024): reject unpaired
  // surrogate code units without touching the project lib target.
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0xd800 || code > 0xdfff) continue
    if (code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++
        continue
      }
    }
    return false
  }
  return true
}

function utf8(value: string): Buffer {
  if (!isWellFormedString(value)) {
    throw new DigestError('string value contains unpaired surrogate code points')
  }
  return Buffer.from(value, 'utf8')
}

function expectHex(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length % 2 !== 0 || !HEX_RE.test(raw)) {
    throw new DigestError(`digest token must be lowercase hex: ${String(raw)}`)
  }
  return raw
}

function expectEnumToken(raw: unknown): string {
  if (typeof raw !== 'string' || !ENUM_TOKEN_RE.test(raw)) {
    throw new DigestError(`invalid enum token: ${String(raw)}`)
  }
  return raw
}

function expectInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new DigestError(`field ${label} must be an integer`)
  }
  return value
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new DigestError(`field ${label} must be a string`)
  }
  return value
}

/** Encode one typed value into its canonical token bytes. */
export function typedToken(value: Typed): Buffer {
  if (typeof value === 'boolean') return Buffer.from(value ? 'b:1' : 'b:0', 'utf8')
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new DigestError(`integer token must be a safe integer: ${String(value)}`)
    }
    return Buffer.from(`i:${value}`, 'utf8')
  }
  if (typeof value === 'string') return Buffer.concat([Buffer.from('s:', 'utf8'), utf8(value)])
  if (typeof value === 'object' && value !== null && 'k' in value) {
    if (Object.keys(value).length !== 2 || !('v' in value)) {
      throw new DigestError('typed token wrapper must carry exactly k and v')
    }
    const typed = value as TypedObject
    if (typed.k === 'b') {
      if (typeof typed.v !== 'boolean') {
        throw new DigestError(`boolean token payload must be a boolean: ${String(typed.v)}`)
      }
      return Buffer.from(typed.v ? 'b:1' : 'b:0', 'utf8')
    }
    if (typed.k === 'i') return Buffer.from(`i:${expectInt(typed.v, 'typed.i')}`, 'utf8')
    if (typed.k === 's') return Buffer.concat([Buffer.from('s:', 'utf8'), utf8(expectString(typed.v, 'typed.s'))])
    if (typed.k === 'e') return Buffer.from(`e:${expectEnumToken(typed.v)}`, 'utf8')
    if (typed.k === 'x') return Buffer.from(`x:${expectHex(typed.v)}`, 'utf8')
  }
  throw new DigestError(`unsupported typed value: ${String(value)}`)
}

/**
 * Encode one field: u32BE(nameLen) || name || presence || u32BE(valueLen) || value.
 * The primitive performs no grammar validation on purpose (manifest builders
 * enforce it); token=null encodes the absent null-domain form.
 */
export function field(name: string, token: Buffer | null): Buffer {
  const nameBytes = Buffer.from(name, 'utf8')
  if (nameBytes.length === 0 || nameBytes.length > MAX_ENCODED_NAME_BYTES) {
    throw new DigestError(`encoded field name must be 1..${MAX_ENCODED_NAME_BYTES} bytes: ${name}`)
  }
  const header = Buffer.alloc(9 + nameBytes.length)
  header.writeUInt32BE(nameBytes.length, 0)
  nameBytes.copy(header, 4)
  if (token === null) {
    header.writeUInt8(0, 4 + nameBytes.length)
    header.writeUInt32BE(0, 5 + nameBytes.length)
    return header
  }
  if (token.length > MAX_VALUE_BYTES) {
    throw new DigestError(`field value exceeds ${MAX_VALUE_BYTES} bytes: ${name}`)
  }
  header.writeUInt8(1, 4 + nameBytes.length)
  header.writeUInt32BE(token.length, 5 + nameBytes.length)
  return Buffer.concat([header, token])
}

/** Presence is decided before any stringification; enc only runs when present. */
export function optField(name: string, raw: unknown, enc: (value: unknown) => Buffer): Buffer {
  if (raw === undefined || raw === null) return field(name, null)
  return field(name, enc(raw))
}

function checkFieldCount(count: number): void {
  if (count > MAX_FIELDS_PER_RECORD) {
    throw new DigestError(`canonical record exceeds ${MAX_FIELDS_PER_RECORD} fields: ${count}`)
  }
}

function byUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/** Repeat same-name fields sorted by full typed value bytes; reject duplicates. */
export function encodeSet(name: string, items: Buffer[]): Buffer {
  const seen = new Set(items.map((item) => item.toString('hex')))
  if (seen.size !== items.length) {
    throw new DigestError(`set ${name} contains duplicate members`)
  }
  const sorted = [...items].sort(Buffer.compare)
  return Buffer.concat(sorted.map((token) => field(name, token)))
}

/** Sort by semantic key utf8 bytes (never by encoded bytes); duplicate keys fail closed. */
export function encodeMapRows(entries: [string, Buffer][], prefix = ''): Buffer {
  const keys = entries.map(([key]) => key)
  if (new Set(keys).size !== keys.length) {
    throw new DigestError(`duplicate semantic keys in map: ${keys.sort(byUtf8).join(',')}`)
  }
  for (const key of keys) {
    if (Buffer.byteLength(key, 'utf8') > MAX_SEMANTIC_KEY_BYTES) {
      throw new DigestError(`semantic key exceeds ${MAX_SEMANTIC_KEY_BYTES} bytes: ${key}`)
    }
  }
  const sorted = [...entries].sort((a, b) => byUtf8(a[0], b[0]))
  checkFieldCount(sorted.length)
  return Buffer.concat(sorted.map(([key, token]) => field(prefix + key, token)))
}

const PRODUCT_KEY_SET: ReadonlySet<string> = new Set(PRODUCT_KEY_VOCABULARY)

function tupleEntries(
  tuple: Record<string, Typed> | undefined,
  label: string,
  allowlist: ReadonlySet<string> = PRODUCT_KEY_SET,
): [string, Buffer][] {
  if (tuple === undefined || tuple === null) return []
  if (typeof tuple !== 'object') {
    throw new DigestError(`${label} must be an object`)
  }
  return Object.entries(tuple).map(([key, value]) => {
    if (!DYNAMIC_KEY_RE.test(key)) {
      throw new DigestError(`${label} key must match snake_case grammar: ${key}`)
    }
    if (!allowlist.has(key)) {
      throw new DigestError(`${label} key is not in the frozen key vocabulary: ${key}`)
    }
    return [key, typedToken(value)] as [string, Buffer]
  })
}

const SESSION_KEYS = ['version', 'id', 'createdAt', 'parentSession', 'seedLength', 'agentPreset', 'origin', 'delegationDepth']
const HOST_LOCK_KEYS = ['manifestVersion', 'supportedGoalVersions', 'capabilities', 'packages']
const CAPABILITY_KEYS = ['name', 'value']
const PACKAGE_KEYS = ['name', 'version', 'integrity']
const FACT_KEYS = [
  'id', 'outcome', 'method', 'operations', 'executables', 'subjects', 'surfaces',
  'semanticAction', 'evidenceRole', 'resolvedTarget', 'observedState', 'parseStatus',
  'reasonCode', 'adapterId', 'adapterVersion',
]
const BINDING_COMMON_KEYS = [
  'item', 'semanticAction', 'requestedTarget', 'resolvedTarget', 'observedState',
  'predId', 'predVersion', 'predParamsKind', 'resolutionEvidenceId',
  'effectEvidenceId', 'stateEvidenceIds',
]
const BINDING_INLINE_KEYS = ['predParams', 'predParamsAllowlist']
const BINDING_MANIFEST_KEYS = ['predParamsRef', 'predParamsManifest', 'predParamsManifestAllowlist']
const CERTIFICATE_KEYS = [
  'stopProtocolVersion', 'certificateVersion', 'epoch', 'sessionRefDigest',
  'hostLockDigest', 'contractRevision', 'contractSha256', 'goalRef', 'openDigest',
  'evidenceSha256', 'bindingDigest',
]
const GOAL_REF_KEYS = ['id', 'revision']

/** Closed-manifest guard: unknown input fields are rejected before hashing. */
function requireExactKeys(record: unknown, allowed: readonly string[], label: string): void {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    throw new DigestError(`${label} must be an object`)
  }
  for (const key of Object.keys(record as object)) {
    if (!allowed.includes(key)) {
      throw new DigestError(`${label} has unknown field: ${key}`)
    }
  }
}

export function sessionRefDigest(header: SessionHeader): string {
  requireExactKeys(header, SESSION_KEYS, 'session header')
  const optionalRecord = header as unknown as Record<string, unknown>
  for (const name of ['parentSession', 'agentPreset', 'origin']) {
    const value = optionalRecord[name]
    if (value !== undefined && value !== null && typeof value !== 'string') {
      throw new DigestError(`session field ${name} must be a string or absent`)
    }
  }
  for (const name of ['seedLength', 'delegationDepth']) {
    const value = optionalRecord[name]
    if (value !== undefined && value !== null && (typeof value !== 'number' || !Number.isSafeInteger(value))) {
      throw new DigestError(`session field ${name} must be an integer or absent`)
    }
  }
  const parts: Buffer[] = [Buffer.from('ccg.sessionRefDigest.v3\n', 'utf8')]
  let count = 0
  parts.push(field('formatVersion', typedToken(expectInt(header.version, 'version'))))
  parts.push(field('id', typedToken(expectString(header.id, 'id'))))
  parts.push(field('createdAt', typedToken(expectInt(header.createdAt, 'createdAt'))))
  count += 3
  parts.push(optField('parentSession', header.parentSession, (v) => typedToken(v as Typed)))
  parts.push(optField('seedLength', header.seedLength, (v) => typedToken(v as Typed)))
  parts.push(optField('agentPreset', header.agentPreset, (v) => typedToken(v as Typed)))
  parts.push(optField('origin', header.origin, (v) => typedToken(v as Typed)))
  parts.push(optField('delegationDepth', header.delegationDepth, (v) => typedToken(v as Typed)))
  count += 5
  checkFieldCount(count)
  return sha256Hex(Buffer.concat(parts))
}

export function hostLockDigest(manifest: HostLockManifest): string {
  requireExactKeys(manifest, HOST_LOCK_KEYS, 'host lock manifest')
  const parts: Buffer[] = [Buffer.from('ccg.hostLockDigest.v3\n', 'utf8')]
  let count = 0
  parts.push(field('manifestVersion', typedToken(expectInt(manifest.manifestVersion, 'manifestVersion'))))
  count += 1
  const versions = manifest.supportedGoalVersions
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new DigestError('supportedGoalVersions must be a non-empty list')
  }
  if (versions.some((v) => typeof v !== 'string')) {
    throw new DigestError('supportedGoalVersions entries must be strings')
  }
  parts.push(encodeSet('supportedGoalVersion', versions.map((v) => typedToken(v))))
  count += versions.length
  const rawCapabilities = (manifest as unknown as Record<string, unknown>).capabilities
  if (rawCapabilities !== undefined && !Array.isArray(rawCapabilities)) {
    throw new DigestError('capabilities must be a list or absent')
  }
  const rows = (rawCapabilities as CapabilityRow[] | undefined) ?? []
  const seen = new Set<string>()
  const sortedRows = [...rows].sort((a, b) => {
    const byName = byUtf8(a.name, b.name)
    return byName !== 0 ? byName : Buffer.compare(typedToken(a.value), typedToken(b.value))
  })
  for (const row of sortedRows) {
    requireExactKeys(row, CAPABILITY_KEYS, 'capability row')
    if (typeof row.name !== 'string' || !DYNAMIC_KEY_RE.test(row.name)) {
      throw new DigestError(`capability name must match snake_case grammar: ${String(row.name)}`)
    }
    const token = typedToken(row.value)
    const marker = `${row.name}\u0000${token.toString('hex')}`
    if (seen.has(marker)) {
      throw new DigestError(`duplicate capability row: ${row.name}`)
    }
    seen.add(marker)
    parts.push(optField(`cap:${row.name}`, token, (v) => v as Buffer))
    count += 1
  }
  const rawPackages = (manifest as unknown as Record<string, unknown>).packages
  if (rawPackages !== undefined && !Array.isArray(rawPackages)) {
    throw new DigestError('packages must be a list or absent')
  }
  const packages = (rawPackages as PackageRow[] | undefined) ?? []
  const names = packages.map((p) => expectString(p.name, 'package.name'))
  if (new Set(names).size !== names.length) {
    throw new DigestError('duplicate package rows')
  }
  for (const pkg of [...packages].sort((a, b) => byUtf8(a.name, b.name))) {
    requireExactKeys(pkg, PACKAGE_KEYS, 'package row')
    for (const label of ['version', 'integrity']) {
      const value = (pkg as unknown as Record<string, unknown>)[label]
      if (value !== undefined && value !== null && typeof value !== 'string') {
        throw new DigestError(`package field ${label} must be a string or absent`)
      }
    }
    if (!PACKAGE_NAME_RE.test(pkg.name)) {
      throw new DigestError(`invalid package name: ${pkg.name}`)
    }
    parts.push(optField(`pkg:${pkg.name}`, pkg.version, (v) => typedToken(v as Typed)))
    parts.push(optField(`integrity:${pkg.name}`, pkg.integrity, (v) => typedToken(v as Typed)))
    count += 2
  }
  checkFieldCount(count)
  return sha256Hex(Buffer.concat(parts))
}

export function evidenceFactBytes(
  fact: EvidenceFact,
  allowlist: ReadonlySet<string> = PRODUCT_KEY_SET,
): Buffer {
  requireExactKeys(fact, FACT_KEYS, 'evidence fact')
  if (!OUTCOME_ENUM.includes(fact.outcome)) {
    throw new DigestError(`outcome must be a canonical enum member: ${fact.outcome}`)
  }
  if (!EVIDENCE_ROLE_ENUM.includes(fact.evidenceRole)) {
    throw new DigestError(`evidenceRole must be a canonical enum member: ${fact.evidenceRole}`)
  }
  if (typeof fact.parseStatus !== 'string' || !DYNAMIC_KEY_RE.test(fact.parseStatus)) {
    throw new DigestError(`invalid parseStatus: ${fact.parseStatus}`)
  }
  if (fact.parseStatus !== 'supported' && (fact.reasonCode === undefined || fact.reasonCode === null)) {
    throw new DigestError('reasonCode must be present when parseStatus is not supported')
  }
  if (!Array.isArray(fact.surfaces) || fact.surfaces.length !== 1) {
    throw new DigestError('surfaces must carry exactly one canonical surface')
  }
  if (!SURFACE_ENUM.includes(fact.surfaces[0])) {
    throw new DigestError(`surface must be a canonical enum member: ${fact.surfaces[0]}`)
  }
  const resEntries = tupleEntries(fact.resolvedTarget, 'resolvedTarget', allowlist)
  const obsEntries = tupleEntries(fact.observedState, 'observedState', allowlist)
  if (fact.evidenceRole === 'resolution' || fact.evidenceRole === 'effect') {
    if (resEntries.length === 0) throw new DigestError(`${fact.evidenceRole} fact requires a resolvedTarget`)
    if (obsEntries.length > 0) throw new DigestError(`${fact.evidenceRole} fact must not carry observedState`)
  } else if (resEntries.length === 0 || obsEntries.length === 0) {
    throw new DigestError('state fact requires both resolvedTarget and observedState')
  }
  const parts: Buffer[] = [Buffer.from('ccg.evidenceFact.v3\n', 'utf8')]
  let count = 0
  parts.push(field('id', typedToken(expectString(fact.id, 'id'))))
  parts.push(field('outcome', Buffer.from(`e:${fact.outcome}`, 'utf8')))
  parts.push(field('method', typedToken(expectString(fact.method, 'method'))))
  count += 3
  for (const [listName, fieldName] of [
    ['operations', 'operation'],
    ['executables', 'executable'],
    ['subjects', 'subject'],
  ] as const) {
    const rawValues = (fact as unknown as Record<string, unknown>)[listName]
    if (rawValues !== undefined && !Array.isArray(rawValues)) {
      throw new DigestError(`${listName} must be a list or absent`)
    }
    const values = (rawValues as string[] | undefined) ?? []
    if (values.some((v) => typeof v !== 'string')) {
      throw new DigestError(`${listName} entries must be strings`)
    }
    parts.push(encodeSet(fieldName, values.map((v) => typedToken(v))))
    count += values.length
  }
  parts.push(field('surface', typedToken(fact.surfaces[0])))
  parts.push(field('semanticAction', typedToken(expectString(fact.semanticAction, 'semanticAction'))))
  parts.push(field('evidenceRole', Buffer.from(`e:${fact.evidenceRole}`, 'utf8')))
  parts.push(encodeMapRows(resEntries, 'res:'))
  parts.push(encodeMapRows(obsEntries, 'obs:'))
  parts.push(field('parseStatus', Buffer.from(`e:${fact.parseStatus}`, 'utf8')))
  count += 4 + resEntries.length + obsEntries.length
  for (const name of ['reasonCode', 'adapterId', 'adapterVersion'] as const) {
    const value = fact[name]
    if (value !== undefined && value !== null && typeof value !== 'string') {
      throw new DigestError(`evidence fact field ${name} must be a string or absent`)
    }
  }
  parts.push(optField('reasonCode', fact.reasonCode, (v) => typedToken(v as Typed)))
  parts.push(optField('adapterId', fact.adapterId, (v) => typedToken(v as Typed)))
  parts.push(optField('adapterVersion', fact.adapterVersion, (v) => typedToken(v as Typed)))
  count += 3
  checkFieldCount(count)
  return Buffer.concat(parts)
}

export function evidenceFactDigest(
  fact: EvidenceFact,
  allowlist: ReadonlySet<string> = PRODUCT_KEY_SET,
): string {
  return sha256Hex(evidenceFactBytes(fact, allowlist))
}

export function evidenceSha256Digest(
  facts: EvidenceFact[],
  allowlist: ReadonlySet<string> = PRODUCT_KEY_SET,
): string {
  const parts: Buffer[] = [Buffer.from('ccg.evidenceSha256.v3\n', 'utf8')]
  const seen = new Set<string>()
  const sorted = [...facts].sort((a, b) => byUtf8(a.id, b.id))
  for (const fact of sorted) {
    if (seen.has(fact.id)) {
      throw new DigestError(`duplicate evidence id: ${fact.id}`)
    }
    seen.add(fact.id)
    parts.push(field('id', typedToken(fact.id)))
    parts.push(field('fact', typedToken({ k: 'x', v: evidenceFactDigest(fact, allowlist) })))
  }
  checkFieldCount(facts.length * 2)
  return sha256Hex(Buffer.concat(parts))
}

export function resolveAllowlist(spec: 'product' | string[] | undefined | null): Set<string> {
  // Frozen explicit-null rule: absent or null maps to the product vocabulary,
  // matching the contract-wide null=absent convention for optional scalar
  // fields (both implementations, pinned by tests).
  if (spec === undefined || spec === null || spec === 'product') {
    return new Set(PRODUCT_KEY_VOCABULARY)
  }
  if (Array.isArray(spec)) {
    if (spec.some((item) => typeof item !== 'string')) {
      throw new DigestError('key allowlist entries must be strings')
    }
    return new Set(spec)
  }
  throw new DigestError(`unknown key allowlist: ${String(spec)}`)
}

export function predParamsBytes(params: Record<string, Typed>, allowlist: Set<string>): Buffer {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new DigestError('predParams must be an object')
  }
  checkFieldCount(Object.keys(params).length)
  for (const name of Object.keys(params)) {
    if (!DYNAMIC_KEY_RE.test(name)) {
      throw new DigestError(`predParams name must match snake_case grammar: ${name}`)
    }
    if (!allowlist.has(name)) {
      throw new DigestError(`predParams name is not in the frozen allowlist: ${name}`)
    }
  }
  const parts: Buffer[] = [Buffer.from('ccg.predParams.v3\n', 'utf8')]
  for (const name of Object.keys(params).sort(byUtf8)) {
    parts.push(field(name, typedToken(params[name])))
  }
  const payload = Buffer.concat(parts)
  if (payload.length > MAX_PRED_PARAMS_BYTES) {
    throw new DigestError(`predParams canonicalBytes exceed ${MAX_PRED_PARAMS_BYTES} bytes`)
  }
  return payload
}

export function predParamsDigest(params: Record<string, Typed>, allowlist: Set<string>): string {
  return sha256Hex(predParamsBytes(params, allowlist))
}

export function bindingRecordBytes(binding: BindingRecord, allowlist: Set<string>): Buffer {
  if (!PRED_PARAMS_KIND_ENUM.includes(binding.predParamsKind)) {
    throw new DigestError(`predParamsKind must be a canonical enum member: ${binding.predParamsKind}`)
  }
  // The predicate digest is always recomputed from the actual parameter
  // payload; a digest string alone is never authoritative.
  let params: Record<string, Typed>
  let predAllowlist: Set<string>
  if (binding.predParamsKind === 'inline') {
    if (typeof binding.predParams !== 'object' || binding.predParams === null || Array.isArray(binding.predParams) || 'ref' in binding.predParams) {
      throw new DigestError('inline binding requires the materialized predParams payload')
    }
    params = binding.predParams
    predAllowlist = resolveAllowlist(binding.predParamsAllowlist)
  } else {
    if (
      typeof binding.predParamsManifest !== 'object' ||
      binding.predParamsManifest === null ||
      Array.isArray(binding.predParamsManifest)
    ) {
      throw new DigestError('manifest binding requires the manifest entry payload')
    }
    params = binding.predParamsManifest
    predAllowlist = resolveAllowlist(binding.predParamsManifestAllowlist)
  }
  const branchKeys = binding.predParamsKind === 'inline' ? BINDING_INLINE_KEYS : BINDING_MANIFEST_KEYS
  requireExactKeys(binding, [...BINDING_COMMON_KEYS, ...branchKeys], 'binding record')
  const payload = predParamsBytes(params, predAllowlist)
  const recomputed = sha256Hex(payload)
  const parts: Buffer[] = [Buffer.from('ccg.binding.v3\n', 'utf8')]
  let count = 0
  parts.push(field('item', typedToken(expectString(binding.item, 'item'))))
  parts.push(field('semanticAction', typedToken(expectString(binding.semanticAction, 'semanticAction'))))
  count += 2
  parts.push(encodeMapRows(tupleEntries(binding.requestedTarget, 'requestedTarget', allowlist), 'req:'))
  parts.push(encodeMapRows(tupleEntries(binding.resolvedTarget, 'resolvedTarget', allowlist), 'res:'))
  parts.push(encodeMapRows(tupleEntries(binding.observedState, 'observedState', allowlist), 'obs:'))
  count += Object.keys(binding.requestedTarget ?? {}).length
  count += Object.keys(binding.resolvedTarget ?? {}).length
  count += Object.keys(binding.observedState ?? {}).length
  parts.push(field('predId', typedToken(expectString(binding.predId, 'predId'))))
  parts.push(field('predVersion', typedToken(expectInt(binding.predVersion, 'predVersion'))))
  parts.push(field('predParamsKind', Buffer.from(`e:${binding.predParamsKind}`, 'utf8')))
  count += 3
  if (binding.predParamsKind === 'inline') {
    parts.push(field('predParams', payload))
  } else {
    const ref = binding.predParamsRef
    if (typeof ref !== 'string' || ref.length === 0) {
      throw new DigestError('manifest binding requires predParamsRef')
    }
    parts.push(field('predParamsRef', typedToken(ref)))
  }
  parts.push(field('predParamsDigest', typedToken({ k: 'x', v: recomputed })))
  count += 2
  const resolutionId = binding.resolutionEvidenceId
  if (resolutionId !== undefined && resolutionId !== null && typeof resolutionId !== 'string') {
    throw new DigestError('resolutionEvidenceId must be a string or absent')
  }
  parts.push(optField('resolutionEvidenceId', resolutionId, (v) => typedToken(v as Typed)))
  parts.push(field('effectEvidenceId', typedToken(expectString(binding.effectEvidenceId, 'effectEvidenceId'))))
  count += 2
  const rawStateIds = (binding as unknown as Record<string, unknown>).stateEvidenceIds
  if (rawStateIds !== undefined && !Array.isArray(rawStateIds)) {
    throw new DigestError('stateEvidenceIds must be a list or absent')
  }
  const stateIds = (rawStateIds as string[] | undefined) ?? []
  if (stateIds.some((v) => typeof v !== 'string')) {
    throw new DigestError('stateEvidenceIds entries must be strings')
  }
  parts.push(encodeSet('stateEvidenceId', stateIds.map((v) => typedToken(v))))
  count += stateIds.length
  checkFieldCount(count)
  return Buffer.concat(parts)
}

export function bindingRecordDigest(binding: BindingRecord, allowlist: Set<string>): string {
  return sha256Hex(bindingRecordBytes(binding, allowlist))
}

export function bindingDigest(records: BindingRecord[], allowlist: Set<string>): string {
  const parts: Buffer[] = [Buffer.from('ccg.bindingDigest.v3\n', 'utf8')]
  const seen = new Set<string>()
  const rows = records.map((record) => {
    // JSON encoding is injective for string pairs, so items containing NUL
    // cannot alias another (item, semanticAction) tuple here.
    const tupleKey = JSON.stringify([record.item, record.semanticAction])
    if (seen.has(tupleKey)) {
      throw new DigestError(`duplicate (item, semanticAction) binding: ${record.item}/${record.semanticAction}`)
    }
    seen.add(tupleKey)
    return {
      item: record.item,
      semanticAction: record.semanticAction,
      digest: bindingRecordDigest(record, allowlist),
    }
  })
  // Frozen sort: compare (item, semanticAction) utf8 bytes as a tuple —
  // never a concatenated marker, which NUL-containing items would scramble.
  rows.sort((a, b) => {
    const byItem = byUtf8(a.item, b.item)
    return byItem !== 0 ? byItem : byUtf8(a.semanticAction, b.semanticAction)
  })
  for (const row of rows) {
    parts.push(field('binding', typedToken({ k: 'x', v: row.digest })))
  }
  checkFieldCount(records.length)
  return sha256Hex(Buffer.concat(parts))
}

export function certificationDigest(certificate: CertificateInput): string {
  requireExactKeys(certificate, CERTIFICATE_KEYS, 'certificate')
  const parts: Buffer[] = [Buffer.from('ccg.certificationDigest.v3\n', 'utf8')]
  let count = 0
  parts.push(field('stopProtocolVersion', typedToken(expectString(certificate.stopProtocolVersion, 'stopProtocolVersion'))))
  parts.push(field('certificateVersion', typedToken(expectString(certificate.certificateVersion, 'certificateVersion'))))
  parts.push(field('epoch', typedToken(expectInt(certificate.epoch, 'epoch'))))
  parts.push(field('sessionRefDigest', typedToken({ k: 'x', v: expectHex(certificate.sessionRefDigest) })))
  parts.push(field('hostLockDigest', typedToken({ k: 'x', v: expectHex(certificate.hostLockDigest) })))
  parts.push(field('contractRevision', typedToken(expectInt(certificate.contractRevision, 'contractRevision'))))
  parts.push(field('contractSha256', typedToken({ k: 'x', v: expectHex(certificate.contractSha256) })))
  count += 7
  const goalRef = certificate.goalRef
  if (goalRef !== undefined && goalRef !== null) {
    requireExactKeys(goalRef, GOAL_REF_KEYS, 'goalRef')
    parts.push(optField('goalRefId', expectString(goalRef.id, 'goalRef.id'), (v) => typedToken(v as Typed)))
    parts.push(optField('goalRefRevision', expectInt(goalRef.revision, 'goalRef.revision'), (v) => typedToken(v as Typed)))
  } else {
    parts.push(optField('goalRefId', null, () => Buffer.alloc(0)))
    parts.push(optField('goalRefRevision', null, () => Buffer.alloc(0)))
  }
  count += 2
  parts.push(field('openDigest', typedToken({ k: 'x', v: expectHex(certificate.openDigest) })))
  parts.push(field('evidenceSha256', typedToken({ k: 'x', v: expectHex(certificate.evidenceSha256) })))
  parts.push(field('bindingDigest', typedToken({ k: 'x', v: expectHex(certificate.bindingDigest) })))
  count += 3
  checkFieldCount(count)
  return sha256Hex(Buffer.concat(parts))
}

export function locatorDigest(rawLocator: string): string {
  if (typeof rawLocator !== 'string') {
    throw new DigestError('locator input must be a string')
  }
  return sha256Hex(Buffer.concat([Buffer.from('ccg.locator.v1\n', 'utf8'), utf8(rawLocator)]))
}

export interface StateClosureInput {
  binding: BindingRecord
  resolution: EvidenceFact
  effect: EvidenceFact
  states: EvidenceFact[]
  evidenceFacts?: EvidenceFact[]
}

/**
 * Verifier-side role matrix and binding closure. Digest derivation stays
 * pure; this mirrors the checks a proof verifier must run before accepting a
 * binding: res: rows byte-identical across all three roles, binding.obs equal
 * to the union of pairwise-disjoint state fact obs key sets, evidence ids
 * pairwise distinct, each id naming the fact that plays its role, and every
 * id present in the evidence set when one is supplied.
 */
export function bindingStateClosure(input: StateClosureInput): void {
  const { binding, resolution, effect, states } = input
  for (const [expectedRole, fact] of [
    ['resolution', resolution],
    ['effect', effect],
  ] as const) {
    if (fact.evidenceRole !== expectedRole) {
      throw new DigestError(`fact role mismatch: expected ${expectedRole}`)
    }
    if (!fact.resolvedTarget || Object.keys(fact.resolvedTarget).length === 0) {
      throw new DigestError(`${expectedRole} fact requires resolvedTarget`)
    }
    if (fact.observedState && Object.keys(fact.observedState).length > 0) {
      throw new DigestError(`${expectedRole} fact must not carry observedState`)
    }
  }
  for (const stateFact of states) {
    if (stateFact.evidenceRole !== 'state') {
      throw new DigestError('state list must only carry state facts')
    }
    if (!stateFact.resolvedTarget || Object.keys(stateFact.resolvedTarget).length === 0) {
      throw new DigestError('state fact requires resolvedTarget')
    }
    if (!stateFact.observedState || Object.keys(stateFact.observedState).length === 0) {
      throw new DigestError('state fact requires observedState')
    }
  }
  const bindingRes = encodeMapRows(tupleEntries(binding.resolvedTarget, 'resolvedTarget', PRODUCT_KEY_SET), 'res:')
  for (const fact of [resolution, effect, ...states]) {
    const factRes = encodeMapRows(tupleEntries(fact.resolvedTarget, 'resolvedTarget', PRODUCT_KEY_SET), 'res:')
    if (Buffer.compare(factRes, bindingRes) !== 0) {
      throw new DigestError('binding.res must equal every fact res rows byte for byte')
    }
  }
  const merged = new Map<string, string>()
  for (const stateFact of states) {
    for (const [key, token] of tupleEntries(stateFact.observedState, 'observedState')) {
      if (merged.has(key)) {
        throw new DigestError('observedState key sets must be pairwise disjoint across state facts')
      }
      merged.set(key, token.toString('hex'))
    }
  }
  const bindingObs = tupleEntries(binding.observedState, 'observedState')
  if (
    bindingObs.length !== merged.size ||
    bindingObs.some(([key, token]) => merged.get(key) !== token.toString('hex'))
  ) {
    throw new DigestError('binding.obs must equal the canonical union of state facts')
  }
  const ids = [
    binding.resolutionEvidenceId,
    binding.effectEvidenceId,
    ...(binding.stateEvidenceIds ?? []),
  ].filter((id): id is string => id !== undefined)
  if (new Set(ids).size !== ids.length) {
    throw new DigestError('resolution/effect/state evidence ids must be pairwise distinct')
  }
  if (binding.resolutionEvidenceId !== resolution.id) {
    throw new DigestError('resolutionEvidenceId must name the resolution fact')
  }
  if (binding.effectEvidenceId !== effect.id) {
    throw new DigestError('effectEvidenceId must name the effect fact')
  }
  const providedStateIds = states.map((fact) => fact.id)
  if (new Set(providedStateIds).size !== providedStateIds.length) {
    throw new DigestError('duplicate state fact id')
  }
  const stateIdSet = new Set(binding.stateEvidenceIds ?? [])
  if (stateIdSet.size !== states.length || states.some((fact) => !stateIdSet.has(fact.id))) {
    throw new DigestError('stateEvidenceIds must name exactly the referenced state facts')
  }
  if (input.evidenceFacts !== undefined) {
    // Bind fact content, not just ids: each referenced fact must be
    // byte-identical (same canonical digest) to the fact the evidenceSha256
    // set actually hashed under that id, and ids must be unique in the set.
    const knownFacts = new Map<string, EvidenceFact>()
    for (const setFact of input.evidenceFacts) {
      if (knownFacts.has(setFact.id)) {
        throw new DigestError(`duplicate evidence id in evidence set: ${setFact.id}`)
      }
      knownFacts.set(setFact.id, setFact)
    }
    const bindContent = (fact: EvidenceFact, roleId: string | undefined): void => {
      if (roleId === undefined) {
        throw new DigestError(`evidence ids missing from evidenceSha256 set: ${String(fact.id)}`)
      }
      const hashedFact = knownFacts.get(roleId)
      if (hashedFact === undefined) {
        throw new DigestError(`evidence ids missing from evidenceSha256 set: ${roleId}`)
      }
      if (evidenceFactDigest(fact) !== evidenceFactDigest(hashedFact)) {
        throw new DigestError(
          `evidence fact ${roleId} content differs from the fact hashed into evidenceSha256`,
        )
      }
    }
    bindContent(resolution, binding.resolutionEvidenceId)
    bindContent(effect, binding.effectEvidenceId)
    const providedStates = new Map<string, EvidenceFact>()
    for (const stateFact of states) {
      if (providedStates.has(stateFact.id)) {
        throw new DigestError(`duplicate state fact id: ${stateFact.id}`)
      }
      providedStates.set(stateFact.id, stateFact)
    }
    for (const [stateId, providedFact] of providedStates) {
      bindContent(providedFact, stateId)
    }
  }
}
