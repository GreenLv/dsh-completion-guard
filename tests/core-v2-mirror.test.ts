import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

type Manifest = { status: string; canonical_commit?: string; upstream?: { canonical_commit: string }; files: Array<{
  source_path: string; sha256: string; mirrors: Array<{ path: string; sha256: string }>
}> }

describe('core/v2 upstream source mirrors', () => {
  const repo = fileURLToPath(new URL('..', import.meta.url))
  const manifestPath = 'tests/fixtures/conformance/core_v2/UPSTREAM_PIN.json'

  function fixture(run: (root: string, manifest: Manifest) => void): void {
    const root = mkdtempSync(join(tmpdir(), 'dsh-core-v2-pin-'))
    try {
      const manifest = JSON.parse(readFileSync(join(repo, manifestPath), 'utf8')) as Manifest
      const paths = new Set([manifestPath, ...manifest.files.flatMap((entry) => entry.mirrors.map((mirror) => mirror.path))])
      for (const path of paths) {
        mkdirSync(dirname(join(root, path)), { recursive: true })
        copyFileSync(join(repo, path), join(root, path))
      }
      mkdirSync(join(root, 'scripts'))
      copyFileSync(join(repo, 'scripts/verify-core-v2-mirror.mjs'), join(root, 'scripts/verify-core-v2-mirror.mjs'))
      run(root, manifest)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  function check(root: string, ...args: string[]): { status: number | null; stderr: string } {
    const result = spawnSync(process.execPath, ['scripts/verify-core-v2-mirror.mjs', ...args], { cwd: root, encoding: 'utf8' })
    return { status: result.status, stderr: result.stderr }
  }

  it('matches every declared local mirror byte and keeps the identity boundary explicit', () => {
    const output = execFileSync(process.execPath, ['scripts/verify-core-v2-mirror.mjs'], {
      cwd: repo, encoding: 'utf8',
    })
    const receipt = JSON.parse(output) as {
      status: string; canonical_commit: string | null; sources: number; mirrors: number; upstream_checked: boolean
    }
    expect(receipt.sources).toBe(10)
    expect(receipt.mirrors).toBe(8)
    expect(receipt.upstream_checked).toBe(false)
    expect(receipt.status).toBe('commit-bound-source-mirror')
    expect(receipt.canonical_commit).toMatch(/^[0-9a-f]{40}$/)
  })

  it('rejects a commit-bound identity without a full real commit ID', () => {
    fixture((root, manifest) => {
      manifest.status = 'commit-bound-source-mirror'
      manifest.canonical_commit = '1234'
      writeFileSync(join(root, manifestPath), JSON.stringify(manifest))
      expect(check(root)).toMatchObject({ status: 1, stderr: expect.stringContaining('real full upstream commit') })
    })
  })

  it('rejects a repeated same-hash mirror entry', () => {
    fixture((root, manifest) => {
      manifest.files[0]!.mirrors.push({ ...manifest.files[0]!.mirrors[0]! })
      writeFileSync(join(root, manifestPath), JSON.stringify(manifest))
      expect(check(root)).toMatchObject({ status: 1, stderr: expect.stringContaining('source-to-mirror mapping') })
    })
  })

  it('rejects a missing required runtime mirror', () => {
    fixture((root, manifest) => {
      manifest.files[0]!.mirrors.pop()
      writeFileSync(join(root, manifestPath), JSON.stringify(manifest))
      expect(check(root)).toMatchObject({ status: 1, stderr: expect.stringContaining('source-to-mirror mapping') })
    })
  })

  it('rejects a symlink even when its target has the pinned bytes', () => {
    fixture((root, manifest) => {
      const path = manifest.files[0]!.mirrors[0]!.path
      renameSync(join(root, path), join(root, `${path}.real`))
      symlinkSync(`${basename(path)}.real`, join(root, path))
      expect(check(root)).toMatchObject({ status: 1, stderr: expect.stringContaining('symlink in mirror path') })
    })
  })

  it('checks committed upstream bytes even when its working tree disagrees in either direction', () => {
    fixture((root, manifest) => {
      const upstream = join(root, 'upstream')
      mkdirSync(upstream)
      for (const entry of manifest.files) {
        const bytes = entry.mirrors.length
          ? readFileSync(join(root, entry.mirrors[0]!.path))
          : Buffer.from(`reference: ${entry.source_path}\n`)
        const hash = createHash('sha256').update(bytes).digest('hex')
        entry.sha256 = hash
        for (const mirror of entry.mirrors) mirror.sha256 = hash
        mkdirSync(dirname(join(upstream, entry.source_path)), { recursive: true })
        writeFileSync(join(upstream, entry.source_path), bytes)
      }
      const git = (...args: string[]): string => execFileSync('git', args, { cwd: upstream, encoding: 'utf8' }).trim()
      git('init', '-q')
      git('add', '--all')
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'source')
      const correctCommit = git('rev-parse', 'HEAD')
      manifest.canonical_commit = correctCommit
      manifest.upstream = { canonical_commit: correctCommit }
      writeFileSync(join(root, manifestPath), JSON.stringify(manifest))

      const wirePath = join(upstream, 'docs/CORE_V2_WIRE.md')
      const originalWire = readFileSync(wirePath)
      writeFileSync(wirePath, 'dirty working tree differs from pinned commit\n')
      expect(check(root, '--upstream-repo', upstream).status).toBe(0)

      git('add', '--all')
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'wrong source')
      manifest.canonical_commit = git('rev-parse', 'HEAD')
      manifest.upstream = { canonical_commit: manifest.canonical_commit }
      writeFileSync(join(root, manifestPath), JSON.stringify(manifest))
      writeFileSync(wirePath, originalWire)
      expect(check(root, '--upstream-repo', upstream)).toMatchObject({
        status: 1, stderr: expect.stringContaining('upstream byte mismatch: docs/CORE_V2_WIRE.md'),
      })
    })
  })
})
