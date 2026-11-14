import { describe, it, expect } from 'vitest'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { registryArchiveFiles, HostTrustError } from '../../src/domain/host-trust.js'
import type { PackageRow } from '../../src/domain/digest.js'

// Registry archive projection. The published-tar encodings npm actually
// produces must all project; every path/type/integrity protection stays
// closed. Each case builds a synthetic tarball at the header level so the
// assertion names the exact encoding, not a fixture file.

const makeRow = (name: string, version = '0.2.2-rc.3'): PackageRow =>
  ({ name, version, integrity: 'sha512-' + 'A'.repeat(86) + '==' })

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0'
}

interface Member {
  /** Full stored path (name field). */
  name: string
  content?: Buffer
  type?: 'file' | 'dir'
  /** ustar prefix field; joined with `name` when set. */
  prefix?: string
  /** pax extended-header record applied to this member. */
  pax?: Record<string, string>
  /** Override the typeflag byte directly. */
  typeflag?: number
  /** Corrupt the stored size so the body overruns a later offset. */
  sizeOverride?: number
}

function header(member: Member, size: number): Buffer {
  const block = Buffer.alloc(512, 0)
  const name = member.name.slice(0, 100)
  block.write(member.name.slice(0, 100), 0, 100, 'utf8')
  if (member.prefix) block.write(member.prefix.slice(0, 155), 345, 155, 'utf8')
  block.write('0000000\0', 148, 8, 'ascii') // mode
  block.write('0000000\0', 156 - 8, 8, 'ascii')
  block[156] = member.typeflag ?? (member.type === 'dir' ? 0x35 : 0x30)
  block.write(octal(member.sizeOverride ?? size, 12), 124, 12, 'ascii')
  // Zero checksum placeholder replaced below.
  block.write('        ', 148, 8, 'ascii') // placeholder, fixed later
  const body = member.content ?? Buffer.alloc(0)
  return block
}

/** Builds a valid ustar archive with correct checksums; pax members get a
 * real extended header block with length-prefixed records. */
function tar(members: Member[]): Buffer {
  const blocks: Buffer[] = []
  for (const member of members) {
    const body = member.content ?? Buffer.alloc(0)
    if (member.pax) {
      const records = Object.entries(member.pax)
        .map(([key, value]) => `${key}=${value}\n`)
        .map((entry) => {
          let length = entry.length + 3 // digits + space grow with the number
          for (;;) {
            const candidate = `${length} ${entry}`
            if (candidate.length === length) return candidate
            length = candidate.length
          }
        })
        .join('')
      const paxBody = Buffer.from(records, 'utf8')
      const paxBlock = Buffer.alloc(512, 0)
      paxBlock.write('PaxHeader/fixture', 0, 100, 'utf8')
      paxBlock[156] = 0x78 // 'x'
      paxBlock.write(octal(paxBody.length, 12), 124, 12, 'ascii')
      fixChecksum(paxBlock)
      blocks.push(paxBlock, ...padBody(paxBody))
    }
    const block = Buffer.alloc(512, 0)
    block.write(member.name.slice(0, 100), 0, 100, 'utf8')
    if (member.prefix) block.write(member.prefix.slice(0, 155), 345, 155, 'utf8')
    block[156] = member.typeflag ?? (member.type === 'dir' ? 0x35 : 0x30)
    block.write(octal(member.sizeOverride ?? body.length, 12), 124, 12, 'ascii')
    fixChecksum(block)
    blocks.push(block, ...padBody(body))
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)])
}

function padBody(body: Buffer): Buffer[] {
  if (!body.length) return []
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512)
  body.copy(padded)
  return [padded]
}

function fixChecksum(block: Buffer): void {
  block.fill(' ', 148, 156)
  const sum = block.subarray(0, 512).reduce((total, byte) => total + byte, 0)
  block.write(octal(sum, 8), 148, 8, 'ascii')
}

function gzip(tarball: Buffer, rowIdentity: PackageRow): Buffer {
  const bytes = gzipSync(tarball)
  rowIdentity.integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  return bytes
}

const manifest = Buffer.from(JSON.stringify({ name: '@deepseek-ai/dsh-fixture', version: '0.2.2-rc.3' }), 'utf8')
const fixture = makeRow('@deepseek-ai/dsh-fixture')

describe('registry archive projection accepts every published tar encoding', () => {
  it('projects a plain package/ archive', () => {
    const bytes = gzip(tar([
      { name: 'package/', type: 'dir' },
      { name: 'package/package.json', content: manifest },
      { name: 'package/lib/index.js', content: Buffer.from('export {}\n') },
    ]), fixture)
    const files = registryArchiveFiles(bytes, fixture)
    expect(Object.keys(files).sort()).toEqual(['lib/index.js', 'package.json'])
  })

  it('joins ustar prefix-split long names (aws-sdk/smithy encoding)', () => {
    const bytes = gzip(tar([
      { name: 'getRecursionDetectionPlugin.browser.js', prefix: 'package/dist-es/submodules/client/middleware-recursion-detection', content: Buffer.from('export {}\n') },
      { name: 'package/package.json', content: manifest },
    ]), fixture)
    const files = registryArchiveFiles(bytes, fixture)
    expect(Object.keys(files).sort()).toEqual(['dist-es/submodules/client/middleware-recursion-detection/getRecursionDetectionPlugin.browser.js', 'package.json'])
  })

  it('applies pax path and size records (npm long-path encoding)', () => {
    const bytes = gzip(tar([
      { name: 'PaxHeader/package/package.json', pax: { path: 'package/package.json' }, content: manifest },
      { name: 'package/package.json', content: manifest },
    ]), fixture)
    const files = registryArchiveFiles(bytes, fixture)
    expect(Object.keys(files)).toEqual(['package.json'])
  })

  it('normalizes ./ segments npm pack emits', () => {
    const content = Buffer.from('export {}\n')
    const bytes = gzip(tar([
      { name: 'package/', type: 'dir' },
      { name: 'package/./dist/index.js', content },
      { name: 'package/dist/index.js', content },
      { name: 'package/package.json', content: manifest },
    ]), fixture)
    const files = registryArchiveFiles(bytes, fixture)
    expect(Object.keys(files).sort()).toEqual(['dist/index.js', 'package.json'])
  })

  it('accepts a publisher-chosen single root (DefinitelyTyped <name>/ layout)', () => {
    const bytes = gzip(tar([
      { name: 'retry/', type: 'dir' },
      { name: 'retry/LICENSE', content: Buffer.from('license') },
      { name: 'retry/package.json', content: manifest },
    ]), fixture)
    const files = registryArchiveFiles(bytes, fixture)
    // The projection keeps executable/JSON members only; LICENSE stays in the archive but is not a module digest input.
    expect(Object.keys(files).sort()).toEqual(['package.json'])
  })

  it('accepts the bare root directory member without a trailing slash', () => {
    const bytes = gzip(tar([
      { name: 'package', type: 'dir' },
      { name: 'package/package.json', content: manifest },
    ]), fixture)
    expect(Object.keys(registryArchiveFiles(bytes, fixture))).toEqual(['package.json'])
  })
})

describe('registry archive projection keeps the security closure closed', () => {
  const valid = (): { bytes: Buffer; identity: PackageRow } => {
    const identity = fixture
    return { bytes: gzip(tar([
      { name: 'package/', type: 'dir' },
      { name: 'package/package.json', content: manifest },
    ]), identity), identity }
  }

  const code = (run: () => unknown): string => {
    try { run() } catch (error) { if (error instanceof HostTrustError) return error.code }
    return 'no-failure'
  }

  it('refuses a whole-archive SRI mismatch', () => {
    const { bytes } = valid()
    const mismatched = { ...fixture, integrity: 'sha512-' + 'B'.repeat(86) + '==' }
    expect(code(() => registryArchiveFiles(bytes, mismatched))).toBe('host_trust_archive_integrity_mismatch')
  })

  it('refuses a .. escape through the name field', () => {
    const identity = fixture
    const bytes = gzip(tar([
      { name: 'package/../escape.json', content: Buffer.from('{}') },
      { name: 'package/package.json', content: manifest },
    ]), identity)
    expect(code(() => registryArchiveFiles(bytes, identity))).toBe('host_trust_archive_invalid')
  })

  it('refuses a .. escape through the ustar prefix field', () => {
    const identity = fixture
    const bytes = gzip(tar([
      { name: 'escape.json', prefix: 'package/..', content: Buffer.from('{}') },
      { name: 'package/package.json', content: manifest },
    ]), identity)
    expect(code(() => registryArchiveFiles(bytes, identity))).toBe('host_trust_archive_invalid')
  })

  it('refuses a .. escape through a pax path record', () => {
    const identity = fixture
    const bytes = gzip(tar([
      { name: 'PaxHeader/x', pax: { path: 'package/../escape.json' }, content: Buffer.from('{}') },
      { name: 'package/package.json', content: manifest },
    ]), identity)
    expect(code(() => registryArchiveFiles(bytes, identity))).toBe('host_trust_archive_invalid')
  })

  it('refuses an absolute, backslash or empty-segment path', () => {
    for (const name of ['/etc/passwd', 'package\\x.json', 'package//x.json']) {
      const identity = fixture
      const bytes = gzip(tar([
        { name, content: Buffer.from('{}') },
        { name: 'package/package.json', content: manifest },
      ]), identity)
      expect(code(() => registryArchiveFiles(bytes, identity)), name).toBe('host_trust_archive_invalid')
    }
  })

  it('refuses members outside the single root (mixed-root overlay)', () => {
    const identity = fixture
    const bytes = gzip(tar([
      { name: 'package/package.json', content: manifest },
      { name: 'other/overlay.json', content: Buffer.from('{}') },
    ]), identity)
    expect(code(() => registryArchiveFiles(bytes, identity))).toBe('host_trust_archive_invalid')
  })

  it('refuses duplicate members with divergent content', () => {
    const identity = fixture
    const bytes = gzip(tar([
      { name: 'package/./dist/index.js', content: Buffer.from('export a\n') },
      { name: 'package/dist/index.js', content: Buffer.from('export b\n') },
      { name: 'package/package.json', content: manifest },
    ]), identity)
    expect(code(() => registryArchiveFiles(bytes, identity))).toBe('host_trust_archive_invalid')
  })

  it('refuses hardlink, symlink and GNU longname typeflags', () => {
    for (const typeflag of [0x31, 0x32, 0x4c]) { // '1', '2', 'L'
      const identity = fixture
      const bytes = gzip(tar([
        { name: 'package/link', typeflag, content: Buffer.from('') },
        { name: 'package/package.json', content: manifest },
      ]), identity)
      expect(code(() => registryArchiveFiles(bytes, identity)), String(typeflag)).toBe('host_trust_archive_invalid')
    }
  })

  it('refuses an out-of-bounds member size', () => {
    const identity = fixture
    const bytes = gzip(tar([
      { name: 'package/x.json', content: Buffer.from('{}'), sizeOverride: 1 << 30 },
      { name: 'package/package.json', content: manifest },
    ]), identity)
    expect(code(() => registryArchiveFiles(bytes, identity))).toBe('host_trust_archive_invalid')
  })

  it('refuses a manifest identity mismatch', () => {
    const identity = fixture
    const bytes = gzip(tar([
      { name: 'package/package.json', content: Buffer.from(JSON.stringify({ name: '@deepseek-ai/other', version: '0.2.2-rc.3' })) },
    ]), identity)
    expect(code(() => registryArchiveFiles(bytes, identity))).toBe('host_trust_archive_identity_mismatch')
  })

  it('names the package and member in refusal detail', () => {
    const identity = fixture
    const bytes = gzip(tar([
      { name: 'package/../escape.json', content: Buffer.from('{}') },
      { name: 'package/package.json', content: manifest },
    ]), identity)
    try {
      registryArchiveFiles(bytes, identity)
      expect.unreachable('refusal expected')
    } catch (error) {
      expect(error).toBeInstanceOf(HostTrustError)
      const detail = (error as HostTrustError).detail
      expect(detail).toContain('escape.json')
    }
  })
})
