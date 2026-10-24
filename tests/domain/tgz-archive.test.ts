import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { DEFAULT_TGZ_BUDGET, readTgzIdentity, type TgzBudget } from '../../src/domain/tgz-archive.js'

/**
 * F01/F08 regressions: the release identity reader must project exactly what
 * npm would extract from the SUPPORTED tar subset, refuse everything it cannot
 * model, and bound every resource it touches. Samples are synthetic; the npm
 * oracle is the pacote bundled with an actual npm installation, used offline.
 */

const BLOCK = 512

interface EntryOptions {
  name: string
  body?: Buffer
  prefix?: string
  /** Defaults to the regular-file typeflag '0'. */
  typeflag?: string
  /** 'posix' (default) | 'gnu' | 'none' (v7 header without magic). */
  magic?: 'posix' | 'gnu' | 'none'
  corruptChecksum?: boolean
  /** Overrides the size field instead of using body.length. */
  sizeOverride?: number
}

function entry(options: EntryOptions): Buffer {
  const body = options.body ?? Buffer.alloc(0)
  const header = Buffer.alloc(BLOCK)
  header.write(options.name.slice(0, 100), 0, 100, 'utf8')
  header.write('0000644\0', 100, 8, 'ascii')
  header.write('0000000\0', 108, 8, 'ascii')
  header.write('0000000\0', 116, 8, 'ascii')
  const size = options.sizeOverride ?? body.length
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
  header.write('        ', 148, 8, 'ascii')
  header.write(options.typeflag ?? '0', 156, 1, 'ascii')
  if (options.magic === 'none') {
    // leave magic/version bytes NUL
  } else if (options.magic === 'gnu') {
    header.write('ustar ', 257, 6, 'ascii')
    header.write(' \0', 263, 2, 'ascii')
  } else {
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
  }
  if (options.prefix) header.write(options.prefix.slice(0, 155), 345, 155, 'utf8')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  if (options.corruptChecksum) header.write('77777', 148, 5, 'ascii')
  const padding = Buffer.alloc((BLOCK - (body.length % BLOCK)) % BLOCK)
  return Buffer.concat([header, body, padding])
}

function manifestBody(name: string, version: string, extra: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({ name, version, ...extra }), 'utf8')
}

function canonicalTar(name = 'fixture-package', version = '1.0.0', extra: Record<string, unknown> = {}): Buffer {
  const manifest = manifestBody(name, version, extra)
  return Buffer.concat([
    entry({ name: 'package/package.json', body: manifest }),
    entry({ name: 'package/index.js', body: Buffer.from('x\n') }),
    Buffer.alloc(1024),
  ])
}

/** The review's 183-byte counterexample: prefix shadowing plus a ./ alias. */
function ambiguousCounterexampleTar(): Buffer {
  return Buffer.concat([
    entry({ name: 'package/package.json', body: manifestBody('review-intended-package', '1.0.0'), prefix: 'shadow' }),
    entry({ name: 'package/./package.json', body: manifestBody('review-other-package', '9.0.0') }),
    Buffer.alloc(1024),
  ])
}

async function writeTgz(dir: string, name: string, tar: Buffer): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, gzipSync(tar, { level: 9 }))
  return path
}

async function rejected(path: string, budget?: Partial<TgzBudget>): Promise<string> {
  const result = await readTgzIdentity(path, { budget: budget ? { ...DEFAULT_TGZ_BUDGET, ...budget } : undefined })
  return result.status === 'rejected' ? result.reasonCode : `ok:${result.identity.name}@${result.identity.version}`
}

describe('tgz identity: auditable tar subset (F01)', () => {
  it('reads a canonical pack with full identity fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tgz-'))
    try {
      const tar = canonicalTar('fixture-package', '2.3.4', {
        gitHead: 'a'.repeat(40),
        repository: { type: 'git', url: 'https://github.com/example/fixture.git' },
      })
      const path = await writeTgz(dir, 'fixture.tgz', tar)
      const result = await readTgzIdentity(path)
      expect(result.status).toBe('ok')
      if (result.status !== 'ok') return
      const compressed = gzipSync(tar, { level: 9 })
      expect(result.identity.name).toBe('fixture-package')
      expect(result.identity.version).toBe('2.3.4')
      expect(result.identity.gitHead).toBe('a'.repeat(40))
      expect(result.identity.repository).toBe('https://github.com/example/fixture.git')
      expect(result.identity.sha256).toBe(createHash('sha256').update(compressed).digest('hex'))
      expect(result.identity.integrity).toBe(`sha512-${createHash('sha512').update(compressed).digest('base64')}`)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('reads prefix, ./-alias and // members with npm path semantics', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tgz-'))
    try {
      const path = await writeTgz(dir, 'alias.tgz', Buffer.concat([
        entry({ name: 'package.json', prefix: 'package', body: manifestBody('prefixed-package', '1.0.0') }),
        entry({ name: './package/./dist//main.js', body: Buffer.from('y\n') }),
        entry({ name: 'package/dist/', typeflag: '5' }),
        Buffer.alloc(1024),
      ]))
      const result = await readTgzIdentity(path)
      expect(result.status === 'ok' && result.identity.name === 'prefixed-package'
        && result.identity.version === '1.0.0').toBe(true)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('accepts a v7 header without magic when the prefix area is NUL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tgz-'))
    try {
      const path = await writeTgz(dir, 'v7.tgz', Buffer.concat([
        entry({ name: 'package/package.json', body: manifestBody('v7-package', '0.0.1'), magic: 'none' }),
        Buffer.alloc(1024),
      ]))
      const result = await readTgzIdentity(path)
      expect(result.status === 'ok' && result.identity.name === 'v7-package').toBe(true)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('rejects the review counterexample instead of guessing the manifest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tgz-'))
    try {
      const path = await writeTgz(dir, 'ambiguous.tgz', ambiguousCounterexampleTar())
      expect(await rejected(path)).toBe('tgz_member_path_unsupported')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it.each([
    ['duplicate plain manifest members', [
      entry({ name: 'package/package.json', body: manifestBody('a', '1.0.0') }),
      entry({ name: 'package/package.json', body: manifestBody('b', '2.0.0') }),
      Buffer.alloc(1024),
    ], 'tgz_duplicate_member'],
    ['duplicate after ./ normalization', [
      entry({ name: 'package/package.json', body: manifestBody('a', '1.0.0') }),
      entry({ name: 'package/./package.json', body: manifestBody('b', '2.0.0') }),
      Buffer.alloc(1024),
    ], 'tgz_duplicate_member'],
    ['duplicate via ustar prefix', [
      entry({ name: 'package.json', prefix: 'package', body: manifestBody('a', '1.0.0') }),
      entry({ name: './package/package.json', body: manifestBody('b', '2.0.0') }),
      Buffer.alloc(1024),
    ], 'tgz_duplicate_member'],
    ['symlink member', [entry({ name: 'package/link', typeflag: '2' }), entry({ name: 'package/package.json', body: manifestBody('a', '1.0.0') }), Buffer.alloc(1024)], 'tgz_member_type_unsupported'],
    ['hardlink member', [entry({ name: 'package/link', typeflag: '1' }), entry({ name: 'package/package.json', body: manifestBody('a', '1.0.0') }), Buffer.alloc(1024)], 'tgz_member_type_unsupported'],
    ['PAX extended header member', [entry({ name: 'PaxHeaders/x', typeflag: 'x', body: Buffer.from('20 path=package/x\n') }), entry({ name: 'package/package.json', body: manifestBody('a', '1.0.0') }), Buffer.alloc(1024)], 'tgz_member_type_unsupported'],
    ['GNU long-name member', [entry({ name: '././@LongLink', typeflag: 'L', body: Buffer.from('package/'.repeat(20) + 'deep.json\n') }), entry({ name: 'package/package.json', body: manifestBody('a', '1.0.0') }), Buffer.alloc(1024)], 'tgz_member_type_unsupported'],
    ['GNU magic format', [entry({ name: 'package/package.json', body: manifestBody('a', '1.0.0'), magic: 'gnu' }), Buffer.alloc(1024)], 'tgz_format_unsupported'],
    ['bad header checksum', [entry({ name: 'package/package.json', body: manifestBody('a', '1.0.0'), corruptChecksum: true }), Buffer.alloc(1024)], 'tgz_tar_checksum_invalid'],
    ['traversal member', [entry({ name: 'package/../package.json', body: manifestBody('a', '1.0.0') }), Buffer.alloc(1024)], 'tgz_member_path_unsupported'],
    ['absolute member path', [entry({ name: '/package/package.json', body: manifestBody('a', '1.0.0') }), Buffer.alloc(1024)], 'tgz_member_path_unsupported'],
    ['member outside package root', [entry({ name: 'shadow/package/package.json', body: manifestBody('a', '1.0.0') }), Buffer.alloc(1024)], 'tgz_member_path_unsupported'],
    ['bare package root member', [entry({ name: 'package', typeflag: '5' }), Buffer.alloc(1024)], 'tgz_member_path_unsupported'],
    ['backslash in member path', [entry({ name: 'package\\package.json', body: manifestBody('a', '1.0.0') }), Buffer.alloc(1024)], 'tgz_member_path_unsupported'],
    ['windows drive member', [entry({ name: 'package/C:/x', body: Buffer.from('z') }), entry({ name: 'package/package.json', body: manifestBody('a', '1.0.0') }), Buffer.alloc(1024)], 'tgz_member_path_unsupported'],
    ['member size beyond archive end', [entry({ name: 'package/package.json', body: manifestBody('a', '1.0.0'), sizeOverride: 4096 }), Buffer.alloc(1024)], 'tgz_tar_corrupt'],
    ['nonzero bytes after end marker', [entry({ name: 'package/package.json', body: manifestBody('a', '1.0.0') }), Buffer.alloc(1024), Buffer.from('X'), Buffer.alloc(511)], 'tgz_trailing_bytes'],
    ['missing end-of-archive marker', [entry({ name: 'package/package.json', body: manifestBody('a', '1.0.0') })], 'tgz_tar_corrupt'],
    ['manifest not JSON', [entry({ name: 'package/package.json', body: Buffer.from('not json') }), Buffer.alloc(1024)], 'tgz_manifest_invalid'],
    ['manifest without version', [entry({ name: 'package/package.json', body: Buffer.from('{"name":"a"}') }), Buffer.alloc(1024)], 'tgz_manifest_invalid'],
    ['manifest JSON array', [entry({ name: 'package/package.json', body: Buffer.from('[]') }), Buffer.alloc(1024)], 'tgz_manifest_invalid'],
    ['no manifest member', [entry({ name: 'package/index.js', body: Buffer.from('x') }), Buffer.alloc(1024)], 'tgz_manifest_missing'],
  ])('rejects %s', async (_label, chunks, reasonCode) => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tgz-'))
    try {
      const path = await writeTgz(dir, 'case.tgz', Buffer.concat(chunks as Buffer[]))
      expect(await rejected(path)).toBe(reasonCode)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('rejects path-shaped and I/O failures with stable codes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tgz-'))
    try {
      expect(await rejected('relative.tgz')).toBe('tgz_path_invalid')
      expect(await rejected('archive.tar')).toBe('tgz_path_invalid')
      expect(await rejected(join(dir, 'missing.tgz'))).toBe('tgz_missing')
      expect(await rejected(dir)).toBe('tgz_path_invalid')
      const empty = join(dir, 'empty.tgz')
      await writeFile(empty, Buffer.alloc(0))
      expect(await rejected(empty)).toBe('tgz_empty')
      const aborted = await readTgzIdentity(join(dir, 'missing.tgz'), { signal: AbortSignal.abort() })
      expect(aborted.status === 'rejected' && aborted.reasonCode).toBe('tgz_cancelled')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('rejects a directory named like an archive', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tgz-'))
    try {
      await mkdir(join(dir, 'dir.tgz'))
      const result = await readTgzIdentity(join(dir, 'dir.tgz'))
      expect(result.status === 'rejected' && result.reasonCode).toBe('tgz_not_regular_file')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})

describe('tgz identity: resource budgets (F08)', () => {
  it('bounds the actual compressed read, not just the stat size', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tgz-'))
    try {
      const tar = canonicalTar()
      const compressed = gzipSync(tar, { level: 9 })
      const path = join(dir, 'budget.tgz')
      await writeFile(path, compressed)
      const exact = compressed.length
      expect(await rejected(path, { maxCompressedBytes: exact })).not.toBe('tgz_compressed_budget_exceeded')
      expect(await rejected(path, { maxCompressedBytes: exact - 1 })).toBe('tgz_compressed_budget_exceeded')
      // A file that grew past the budget after stat is still caught by the
      // bounded read: the reader keeps reading to the new EOF.
      await writeFile(path, Buffer.concat([compressed, Buffer.alloc(64)]))
      expect(await rejected(path, { maxCompressedBytes: exact })).toBe('tgz_compressed_budget_exceeded')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('binds the identity to the COMPLETE file bytes across stat/read growth (RF01)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tgz-'))
    try {
      const tar = canonicalTar('growth-fixture', '1.0.0')
      const compressed = gzipSync(tar, { level: 9 })
      const path = join(dir, 'growth.tgz')
      await writeFile(path, compressed)
      const baseline = await readTgzIdentity(path)
      expect(baseline.status).toBe('ok')
      if (baseline.status !== 'ok') return
      // The review's race, exercised from the reader's side: the file grew
      // before the first read picked it up (equivalent bytes-on-disk state as
      // "append after fstat, before read"). The reader must either bind the
      // full grown content or refuse — never return the old prefix identity.
      const grown = Buffer.concat([compressed, Buffer.alloc(64, 0x41)])
      await writeFile(path, grown)
      const result = await readTgzIdentity(path)
      if (result.status === 'ok') {
        expect(result.identity.sha256).toBe(createHash('sha256').update(grown).digest('hex'))
      } else {
        expect(result.reasonCode).toBe('tgz_gzip_corrupt')
      }
      expect(result.status === 'ok' && result.identity.sha256 === baseline.identity.sha256).toBe(false)
      // Multi-chunk files (>256KiB compressed) bind every chunk: the digest
      // equals the digest of the entire file on disk.
      const big = randomBytes(400 * 1024)
      const bigTar = Buffer.concat([
        entry({ name: 'package/package.json', body: manifestBody('big-growth', '1.0.0') }),
        entry({ name: 'package/payload.bin', body: big }),
        Buffer.alloc(1024),
      ])
      const bigPath = join(dir, 'big.tgz')
      await writeFile(bigPath, gzipSync(bigTar, { level: 0 }))
      const bigIdentity = await readTgzIdentity(bigPath)
      expect(bigIdentity.status).toBe('ok')
      if (bigIdentity.status !== 'ok') return
      const onDisk = await readFile(bigPath)
      expect(onDisk.length).toBeGreaterThan(256 * 1024)
      expect(bigIdentity.identity.sha256).toBe(createHash('sha256').update(onDisk).digest('hex'))
      // A truncated (shrunk) multi-chunk archive is refused, not prefix-accepted.
      await writeFile(bigPath, (await readFile(bigPath)).subarray(0, 100 * 1024))
      expect(await rejected(bigPath)).toBe('tgz_gzip_corrupt')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('bounds decompressed output at processing time regardless of ratio', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tgz-'))
    try {
      // ~1 MiB of zeros compresses to a few KiB: compressed-size checks alone
      // cannot see this member's real cost.
      const big = Buffer.alloc(1024 * 1024)
      const tar = Buffer.concat([
        entry({ name: 'package/package.json', body: manifestBody('ratio', '1.0.0') }),
        entry({ name: 'package/payload.bin', body: big }),
        Buffer.alloc(1024),
      ])
      const compressed = gzipSync(tar, { level: 9 })
      expect(compressed.length).toBeLessThan(64 * 1024)
      const path = join(dir, 'ratio.tgz')
      await writeFile(path, compressed)
      const decompressed = tar.length
      expect(await rejected(path, { maxDecompressedBytes: decompressed })).not.toBe('tgz_decompressed_budget_exceeded')
      expect(await rejected(path, { maxDecompressedBytes: decompressed - 1 })).toBe('tgz_decompressed_budget_exceeded')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('bounds single-member, member-count and manifest budgets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tgz-'))
    try {
      const tar = Buffer.concat([
        entry({ name: 'package/package.json', body: manifestBody('budgets', '1.0.0') }),
        entry({ name: 'package/one.js', body: Buffer.alloc(64) }),
        entry({ name: 'package/two.js', body: Buffer.alloc(16) }),
        Buffer.alloc(1024),
      ])
      const path = await writeTgz(dir, 'members.tgz', tar)
      expect(await rejected(path, { maxMemberCount: 3 })).not.toBe('tgz_member_count_exceeded')
      expect(await rejected(path, { maxMemberCount: 2 })).toBe('tgz_member_count_exceeded')
      expect(await rejected(path, { maxMemberBytes: 64 })).not.toBe('tgz_member_budget_exceeded')
      expect(await rejected(path, { maxMemberBytes: 63 })).toBe('tgz_member_budget_exceeded')
      const manifestLength = manifestBody('budgets', '1.0.0').length
      expect(await rejected(path, { maxManifestBytes: manifestLength })).not.toBe('tgz_manifest_budget_exceeded')
      expect(await rejected(path, { maxManifestBytes: manifestLength - 1 })).toBe('tgz_manifest_budget_exceeded')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('rejects corrupt and truncated gzip streams stably', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tgz-'))
    try {
      const tar = canonicalTar('gzip-case', '1.0.0')
      const compressed = gzipSync(tar, { level: 9 })
      const corrupted = Buffer.from(compressed)
      corrupted[corrupted.length - 20] ^= 0xff
      const corruptPath = join(dir, 'corrupt.tgz')
      await writeFile(corruptPath, corrupted)
      expect(await rejected(corruptPath)).toBe('tgz_gzip_corrupt')
      const truncated = join(dir, 'truncated.tgz')
      await writeFile(truncated, compressed.subarray(0, Math.floor(compressed.length / 2)))
      expect(await rejected(truncated)).toBe('tgz_gzip_corrupt')
      const truncatedTar = join(dir, 'truncated-tar.tgz')
      await writeFile(truncatedTar, gzipSync(tar.subarray(0, tar.length - 2048), { level: 9 }))
      expect(await rejected(truncatedTar)).toBeOneOf(['tgz_gzip_corrupt', 'tgz_tar_corrupt'])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})

/**
 * Offline npm oracle: the pacote bundled with a real npm installation reads
 * the same manifest name/version for every sample Guard ACCEPTS. Guard may be
 * stricter (rejecting samples npm would accept); it must never disagree about
 * the identity of a sample it accepts.
 */
function resolveNpmCli(): string {
  const candidates: string[] = []
  if (process.env.DSH_TEST_NPM_CLI) candidates.push(process.env.DSH_TEST_NPM_CLI)
  candidates.push(join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue
    const candidate = join(dir, 'npm')
    if (existsSync(candidate)) {
      try {
        const resolved = realpathSync(candidate)
        if (resolved.endsWith('npm-cli.js')) candidates.push(resolved)
      } catch { /* not an npm launcher */ }
    }
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`no npm CLI found for the pacote oracle (tried: ${candidates.join(', ')})`)
}

describe('tgz identity: offline npm/pacote oracle', () => {
  it('agrees with pacote on every accepted sample', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tgz-oracle-'))
    try {
      const npmCli = resolveNpmCli()
      const npmRequire = createRequire(npmCli)
      const pacote = npmRequire('pacote') as {
        manifest: (spec: string, options: Record<string, unknown>) => Promise<{ name?: string; version?: string }>
      }
      const pacoteVersion = npmRequire('pacote/package.json') as { version: string }
      const cache = join(dir, 'npm-cache')
      const samples: Array<[string, Buffer]> = [
        ['canonical.tgz', canonicalTar('oracle-canonical', '3.1.4', { gitHead: 'b'.repeat(40) })],
        ['alias.tgz', Buffer.concat([
          entry({ name: 'package/./package.json', body: manifestBody('oracle-alias', '2.0.0') }),
          entry({ name: './package/dist//main.js', body: Buffer.from('m\n') }),
          Buffer.alloc(1024),
        ])],
        ['prefixed.tgz', Buffer.concat([
          entry({ name: 'package.json', prefix: 'package', body: manifestBody('oracle-prefixed', '5.0.1') }),
          entry({ name: 'deep/main.js', prefix: 'package', body: Buffer.from('p\n') }),
          Buffer.alloc(1024),
        ])],
        ['long-name.tgz', Buffer.concat([
          entry({ name: 'package/package.json', body: manifestBody('oracle-long', '1.2.3') }),
          entry({ name: 'a'.repeat(60), prefix: 'package/' + 'd'.repeat(30), body: Buffer.from('l\n') }),
          Buffer.alloc(1024),
        ])],
      ]
      for (const [file, tar] of samples) {
        const path = await writeTgz(dir, file, tar)
        const result = await readTgzIdentity(path)
        expect(result.status, `${file}: Guard rejected a canonical-shaped sample`).toBe('ok')
        if (result.status !== 'ok') continue
        const npmManifest = await pacote.manifest(path, { cache, offline: true, ignoreScripts: true, fullMetadata: false })
        expect(`${result.identity.name}@${result.identity.version}`, `${file} vs pacote ${pacoteVersion.version}`)
          .toBe(`${npmManifest.name}@${npmManifest.version}`)
      }
      // The review counterexample stays rejected even though npm reads it:
      // that divergence is exactly why the archive must be refused.
      const counterexample = await writeTgz(dir, 'ambiguous.tgz', ambiguousCounterexampleTar())
      expect(await rejected(counterexample)).toBe('tgz_member_path_unsupported')
      const npmRead = await pacote.manifest(counterexample, { cache, offline: true, ignoreScripts: true })
      expect(`${npmRead.name}@${npmRead.version}`).toBe('review-other-package@9.0.0')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
