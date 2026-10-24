import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'

const gunzipAsync = promisify(gunzip)

/**
 * Auditable tar subset used for release identity (F01/F08).
 *
 * npm consumes a tarball by extracting it; this reader never extracts, so it
 * must either model the supported members exactly or refuse the archive. A
 * member whose semantics this parser cannot reproduce byte-for-byte (links,
 * PAX/GNU extension headers, devices, paths outside `package/`, duplicate
 * normalized paths) makes the projected manifest unprovable against what npm
 * would actually read, so the archive is rejected instead of guessed at.
 */
export interface TgzBudget {
  /** Hard cap on compressed input bytes actually read from the file. */
  maxCompressedBytes: number
  /** Hard cap on total decompressed tar bytes. */
  maxDecompressedBytes: number
  /** Hard cap on a single member's declared size. */
  maxMemberBytes: number
  /** Hard cap on member (header block) count. */
  maxMemberCount: number
  /** Hard cap on the package/package.json member. */
  maxManifestBytes: number
}

export const DEFAULT_TGZ_BUDGET: TgzBudget = {
  maxCompressedBytes: 128 * 1024 * 1024,
  maxDecompressedBytes: 256 * 1024 * 1024,
  maxMemberBytes: 256 * 1024 * 1024,
  maxMemberCount: 65_536,
  maxManifestBytes: 1024 * 1024,
}

export type TgzRejectionCode =
  | 'tgz_path_invalid'
  | 'tgz_cancelled'
  | 'tgz_missing'
  | 'tgz_not_regular_file'
  | 'tgz_empty'
  | 'tgz_compressed_budget_exceeded'
  | 'tgz_gzip_corrupt'
  | 'tgz_decompressed_budget_exceeded'
  | 'tgz_tar_corrupt'
  | 'tgz_tar_checksum_invalid'
  | 'tgz_format_unsupported'
  | 'tgz_member_type_unsupported'
  | 'tgz_member_path_unsupported'
  | 'tgz_duplicate_member'
  | 'tgz_member_budget_exceeded'
  | 'tgz_member_count_exceeded'
  | 'tgz_manifest_budget_exceeded'
  | 'tgz_trailing_bytes'
  | 'tgz_manifest_missing'
  | 'tgz_manifest_invalid'

export interface TgzIdentity {
  name: string
  version: string
  /** npm integrity (SHA-512 SRI) of the exact compressed bytes. */
  integrity: string
  /** SHA-256 of the exact compressed bytes — a DIFFERENT identity from the SRI. */
  sha256: string
  /** The commit the packer embedded in the manifest, when it recorded one. */
  gitHead?: string
  /** The repository declared by the packed manifest, when present. */
  repository?: string
}

export type TgzReadResult =
  | { status: 'ok'; identity: TgzIdentity }
  | { status: 'rejected'; reasonCode: TgzRejectionCode }

type TarManifestResult = { status: 'ok'; manifest: Buffer } | { status: 'rejected'; reasonCode: TgzRejectionCode }

const BLOCK = 512
const OCTAL_SIZE = /^[0-7]+$/
const POSIX_MAGIC = Buffer.from('ustar\0', 'ascii')
const POSIX_VERSION = Buffer.from('00', 'ascii')

/** NUL-terminated string field; bytes after the first NUL must be NUL. */
function tarStringField(block: Buffer, start: number, end: number): string | undefined {
  const raw = block.subarray(start, end)
  const terminator = raw.indexOf(0)
  if (terminator >= 0 && raw.subarray(terminator + 1).some((byte) => byte !== 0)) return undefined
  return (terminator < 0 ? raw : raw.subarray(0, terminator)).toString('utf8')
}

/** Unsigned header checksum: the checksum field counts as eight spaces. */
function tarChecksumValid(block: Buffer): boolean {
  const field = block.subarray(148, 156)
  let digitsEnd = field.findIndex((byte) => byte === 0 || byte === 0x20)
  if (digitsEnd < 0) digitsEnd = field.length
  const stored = field.subarray(0, digitsEnd).toString('ascii')
  if (!stored.length || !OCTAL_SIZE.test(stored)) return false
  let sum = 0
  for (let index = 0; index < block.length; index += 1) sum += index >= 148 && index < 156 ? 32 : block[index]!
  return Number.parseInt(stored, 8) === sum
}

/**
 * npm-compatible path projection for one member: POSIX ustar prefix joins the
 * name, `.` and empty components collapse, `..`/backslash/absolute/Windows
 * drive components and anything outside `package/<nonempty...>` are refused.
 */
function normalizeMemberPath(prefix: string, name: string): string | undefined {
  if (name.includes('\\') || prefix.includes('\\')) return undefined
  const full = prefix ? `${prefix}/${name}` : name
  if (full.startsWith('/')) return undefined
  const parts: string[] = []
  for (const part of full.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..' || /^[A-Za-z]:$/.test(part)) return undefined
    parts.push(part)
  }
  if (parts.length < 2 || parts[0] !== 'package') return undefined
  return parts.join('/')
}

function parseTar(tar: Buffer, budget: TgzBudget): TarManifestResult {
  const seen = new Set<string>()
  let manifest: Buffer | undefined
  let members = 0
  let terminated = false
  for (let offset = 0; offset + BLOCK <= tar.length;) {
    const header = tar.subarray(offset, offset + BLOCK)
    if (header.every((byte) => byte === 0)) {
      // End-of-archive marker: only NUL padding may follow it.
      if (!tar.subarray(offset).every((byte) => byte === 0)) return { status: 'rejected', reasonCode: 'tgz_trailing_bytes' }
      terminated = true
      break
    }
    members += 1
    if (members > budget.maxMemberCount) return { status: 'rejected', reasonCode: 'tgz_member_count_exceeded' }
    if (!tarChecksumValid(header)) return { status: 'rejected', reasonCode: 'tgz_tar_checksum_invalid' }
    const posix = header.subarray(257, 263).equals(POSIX_MAGIC) && header.subarray(263, 265).equals(POSIX_VERSION)
    const noMagic = header.subarray(257, 265).every((byte) => byte === 0)
    if (!posix && !noMagic) return { status: 'rejected', reasonCode: 'tgz_format_unsupported' }
    const typeflag: number = header[156]!
    if (typeflag !== 0 && typeflag !== 0x30 && typeflag !== 0x35) return { status: 'rejected', reasonCode: 'tgz_member_type_unsupported' }
    const name = tarStringField(header, 0, 100)
    // A v7 header (no magic) defines no prefix field; it must be all NUL.
    const prefix = posix ? tarStringField(header, 345, 500)
      : header.subarray(345, 500).every((byte) => byte === 0) ? '' : undefined
    if (name === undefined || prefix === undefined) return { status: 'rejected', reasonCode: 'tgz_tar_corrupt' }
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim()
    if (!OCTAL_SIZE.test(sizeText)) return { status: 'rejected', reasonCode: 'tgz_tar_corrupt' }
    const size = Number.parseInt(sizeText, 8)
    const bodyStart = offset + BLOCK
    const bodyEnd = bodyStart + size
    if (!Number.isSafeInteger(size) || size < 0 || bodyEnd > tar.length) return { status: 'rejected', reasonCode: 'tgz_tar_corrupt' }
    if (size > budget.maxMemberBytes) return { status: 'rejected', reasonCode: 'tgz_member_budget_exceeded' }
    const path = normalizeMemberPath(prefix, name)
    if (path === undefined) return { status: 'rejected', reasonCode: 'tgz_member_path_unsupported' }
    if (seen.has(path)) return { status: 'rejected', reasonCode: 'tgz_duplicate_member' }
    seen.add(path)
    if (path === 'package/package.json' && typeflag !== 0x35) {
      if (size > budget.maxManifestBytes) return { status: 'rejected', reasonCode: 'tgz_manifest_budget_exceeded' }
      manifest = tar.subarray(bodyStart, bodyEnd)
    }
    offset = bodyStart + Math.ceil(size / BLOCK) * BLOCK
  }
  if (!terminated) return { status: 'rejected', reasonCode: 'tgz_tar_corrupt' }
  if (manifest === undefined) return { status: 'rejected', reasonCode: 'tgz_manifest_missing' }
  return { status: 'ok', manifest }
}

/** Read the release identity of a local tgz under explicit resource budgets. */
export async function readTgzIdentity(path: string, options?: { signal?: AbortSignal; budget?: TgzBudget }): Promise<TgzReadResult> {
  const budget = options?.budget ?? DEFAULT_TGZ_BUDGET
  if (typeof path !== 'string' || !isAbsolute(path) || !path.endsWith('.tgz')) return { status: 'rejected', reasonCode: 'tgz_path_invalid' }
  if (options?.signal?.aborted) return { status: 'rejected', reasonCode: 'tgz_cancelled' }
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, 'r')
  } catch {
    return { status: 'rejected', reasonCode: 'tgz_missing' }
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) return { status: 'rejected', reasonCode: 'tgz_not_regular_file' }
    // RF01: the stat size is advisory only. Read to end-of-file in bounded
    // chunks and keep reading while the file keeps growing; the identity binds
    // the COMPLETE bytes actually read, never a fstat-sized prefix. A file
    // that grows past the budget is refused, and cancellation is honored
    // between chunks.
    const chunks: Buffer[] = []
    let received = 0
    let position = 0
    let eofStable = false
    while (!eofStable) {
      if (options?.signal?.aborted) return { status: 'rejected', reasonCode: 'tgz_cancelled' }
      const chunk = Buffer.alloc(256 * 1024)
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position)
      if (bytesRead > 0) {
        position += bytesRead
        received += bytesRead
        if (received > budget.maxCompressedBytes) return { status: 'rejected', reasonCode: 'tgz_compressed_budget_exceeded' }
        chunks.push(chunk.subarray(0, bytesRead))
      }
      if (bytesRead < chunk.length) {
        // Short read or EOF: only treat the stream as settled when a fresh
        // stat confirms no bytes were appended past what we have read.
        const current = await handle.stat()
        eofStable = current.size <= position
      }
    }
    if (received === 0) return { status: 'rejected', reasonCode: 'tgz_empty' }
    const bytes = Buffer.concat(chunks)
    let tar: Buffer
    try {
      tar = await gunzipAsync(bytes, { maxOutputLength: budget.maxDecompressedBytes })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') return { status: 'rejected', reasonCode: 'tgz_decompressed_budget_exceeded' }
      return { status: 'rejected', reasonCode: 'tgz_gzip_corrupt' }
    }
    if (options?.signal?.aborted) return { status: 'rejected', reasonCode: 'tgz_cancelled' }
    const parsed = parseTar(tar, budget)
    if (parsed.status !== 'ok') return parsed
    let manifestJson: unknown
    try {
      manifestJson = JSON.parse(parsed.manifest.toString('utf8'))
    } catch {
      return { status: 'rejected', reasonCode: 'tgz_manifest_invalid' }
    }
    const manifest = manifestJson && typeof manifestJson === 'object' && !Array.isArray(manifestJson)
      ? manifestJson as Record<string, unknown> : undefined
    if (!manifest) return { status: 'rejected', reasonCode: 'tgz_manifest_invalid' }
    const name = typeof manifest.name === 'string' ? manifest.name : undefined
    const version = typeof manifest.version === 'string' ? manifest.version : undefined
    if (!name || !version) return { status: 'rejected', reasonCode: 'tgz_manifest_invalid' }
    const gitHead = typeof manifest.gitHead === 'string' && /^[0-9a-f]{40}$/.test(manifest.gitHead) ? manifest.gitHead : undefined
    const repositoryField = manifest.repository
    const repository = typeof repositoryField === 'string' ? repositoryField
      : repositoryField && typeof repositoryField === 'object' && !Array.isArray(repositoryField)
        && typeof (repositoryField as Record<string, unknown>).url === 'string'
        ? (repositoryField as Record<string, unknown>).url as string : undefined
    return {
      status: 'ok',
      identity: {
        name, version,
        integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        ...(gitHead ? { gitHead } : {}),
        ...(repository ? { repository } : {}),
      },
    }
  } finally {
    await handle.close()
  }
}
