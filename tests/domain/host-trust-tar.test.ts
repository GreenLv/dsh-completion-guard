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

function paxHeader(kind: 'x' | 'g', records: Record<string, string> | Buffer): Buffer {
  const body = Buffer.isBuffer(records) ? records : Buffer.from(Object.entries(records).map(([key, value]) => {
    const text = `${key}=${value}\n`
    let length = Buffer.byteLength(text) + 2
    while (Buffer.byteLength(`${length} ${text}`) !== length) length = Buffer.byteLength(`${length} ${text}`)
    return `${length} ${text}`
  }).join(''))
  const block = Buffer.alloc(512)
  block.write('PaxHeader/test'); block[156] = kind.charCodeAt(0)
  block.write(octal(body.length, 12), 124, 12, 'ascii'); fixChecksum(block)
  return Buffer.concat([block, ...padBody(body)])
}

function segments(...parts: Buffer[]): Buffer {
  return Buffer.concat([...parts.map(part => part.subarray(0, part.length - 1024)), Buffer.alloc(1024)])
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

describe('registry archive PAX and normalized-entry closure', () => {
  const row = () => makeRow('@deepseek-ai/dsh-fixture')
  const member = (name: string, content: Buffer, typeflag?: number) => tar([{ name, content, typeflag }])
  const ext = (kind: 'x' | 'g', value: Record<string, string> | Buffer) => Buffer.concat([paxHeader(kind, value), Buffer.alloc(1024)])
  const check = (parts: Buffer[], accepted: boolean) => {
    const identity = row(), bytes = gzip(segments(...parts), identity)
    if (accepted) return registryArchiveFiles(bytes, identity)
    expect(() => registryArchiveFiles(bytes, identity)).toThrow(HostTrustError)
    return undefined
  }
  const main = () => member('package/package.json', manifest)

  it('uses local PAX path and size ahead of global values', () => {
    const escaping = [ext('g', { path: 'package/package.json' }), ext('x', { path: 'package/package.json' }), main(),
      ext('x', { path: '../outside.js' }), main()]
    check(escaping, false)
    const projected = check([main(), ext('g', { size: '3' }), ext('x', { size: '2' }), member('package/x.json', Buffer.from('{}'))], true)
    expect(projected?.['x.json']).toEqual(Buffer.from('{}'))
  })

  it.each([
    Buffer.from('999 path=../escape.js\n'),
    Buffer.from('18 path=package/x'),
    Buffer.from('14 size=2junk\n'),
    paxHeader('x', { path: '../outside.js' }).subarray(512, 512 + 2),
  ])('rejects malformed PAX bodies without silently using stored paths', body => {
    check([main(), ext('x', body), member('package/lib/x.js', Buffer.from('x'))], false)
  })

  it.each<Record<string, string>>([{ 'GNU.sparse.map': '0,1' }, { linkpath: '../escape' }, { 'NODETAR.type': 'SymbolicLink' }, { 'NODETAR.follow': 'true' }, { 'SCHILY.nlink': '2' }])
  ('rejects PAX fields that change member semantics: %j', records => {
    check([main(), ext('x', records), member('package/lib/x.js', Buffer.from('x'))], false)
  })

  it('accepts observed NODETAR metadata without treating it as file content or identity', () => {
    const fields = { 'NODETAR.type': 'File', 'NODETAR.follow': 'false', 'NODETAR.depth': '1', 'NODETAR.blksize': '4096', 'NODETAR.blocks': '8', 'NODETAR.ignoreFiles.0': '.npmignore', 'NODETAR.package.name': 'example', 'SCHILY.dev': '1', 'SCHILY.ino': '2', 'SCHILY.nlink': '1', uid: '1', gid: '1' }
    expect(check([main(), ext('x', fields), member('package/lib/x.js', Buffer.from('x'))], true)?.['lib/x.js'].toString()).toBe('x')
  })

  it('refuses pending and repeated PAX records', () => {
    check([main(), ext('x', { path: 'package/x.js' })], false)
    const single = paxHeader('x', { path: 'package/x.js' })
    const count = Number.parseInt(single.subarray(124, 136).toString('ascii'), 8)
    const body = single.subarray(512, 512 + count)
    check([main(), ext('x', Buffer.concat([body, body])), member('package/x.js', Buffer.from('x'))], false)
  })

  it('checks root type, root duplication, and file/directory collisions in both orders', () => {
    for (const type of [0x30, 0x31, 0x32]) check([member('package', Buffer.alloc(0), type), main()], false)
    const directory = member('package/', Buffer.alloc(0), 0x35)
    check([directory, directory, main()], false)
    const file = member('package/lib/x.js', Buffer.from('x')), dir = member('package/lib/x.js', Buffer.alloc(0), 0x35)
    check([main(), dir, file], false); check([main(), file, dir], false)
    const child = member('package/lib/x.js/child.js', Buffer.from('x'))
    check([main(), file, child], false); check([main(), child, file], false)
  })

  it('rejects identical raw repeats while accepting identical dot aliases', () => {
    const file = member('package/lib/x.js', Buffer.from('x'))
    check([main(), file, file], false)
    expect(check([main(), file, member('package/./lib/x.js', Buffer.from('x'))], true)?.['lib/x.js'].toString()).toBe('x')
  })

  it('accepts a normalized leading dot root', () => {
    expect(check([member('./package/package.json', manifest), member('./package/lib/x.js', Buffer.from('x'))], true)?.['lib/x.js'].toString()).toBe('x')
  })
})
