#!/usr/bin/env node
// Regenerate the host byte-audit manifest from the published 0.2.0-rc.1
// tarballs. Per package: download the exact registry tarball, verify its
// SHA-256 against the reviewed study, then hash every `lib/**/*.{js,cjs,mjs}` module
// plus package.json. The study's per-tarball SHA-256 and registry SRI are the
// identity inputs; this script only derives per-file digests.
import { parse } from 'acorn'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

const studyPath = process.argv[2]
const outputPath = process.argv[3] ?? 'manifests/rc020-rc1-byte-audit.json'
if (!studyPath) {
  console.error('usage: generate-rc020-byte-audit.mjs <reviewed-input-study.json> [output-manifest.json]\n\nThe reviewed input is the maintainer-reviewed upstream study binding the exact\ncohort tarballs; it is supplied explicitly per run and never hardcoded.')
  process.exit(1)
}
const study = JSON.parse(readFileSync(studyPath, 'utf8'))
const upstreamCommit = study.upstream.commit
const hostVersion = study.upstream.version

const work = mkdtempSync(join(tmpdir(), 'rc020-audit-'))
try {
  const packages = study.package_bindings.map((binding) => {
    const url = `https://registry.npmjs.org/${binding.name}/-/${binding.name.split('/')[1] ?? binding.name}-${binding.new_version}.tgz`
    const tgzPath = join(work, binding.name.replaceAll('/', '_') + '.tgz')
    execFileSync('curl', ['-sfL', '--retry', '3', '-o', tgzPath, url], { stdio: 'pipe' })
    const tarballSha = createHash('sha256').update(readFileSync(tgzPath)).digest('hex')
    if (tarballSha !== binding.new_tarball_sha256) {
      throw new Error(`tarball sha mismatch for ${binding.name}: ${tarballSha}`)
    }
    const integrity = 'sha512-' + createHash('sha512').update(readFileSync(tgzPath)).digest('base64')
    if (integrity !== binding.new_integrity) {
      throw new Error(`integrity mismatch for ${binding.name}`)
    }
    return { binding, url, tarballSha, integrity }
  })
  const rows = packages.map(({ binding, url, tarballSha, integrity }) => {
    const prefix = 'package/'
    const list = execFileSync('tar', ['-tzf', join(work, binding.name.replaceAll('/', '_') + '.tgz')], { encoding: 'utf8' })
      .split('\n').filter((line) => line.startsWith(prefix + 'lib/') && /\.(?:[cm]?js)$/.test(line))
    const modules = {}, programs = {}
    for (const entry of [...list, prefix + 'package.json'].sort()) {
      const content = execFileSync('tar', ['-xzf', join(work, binding.name.replaceAll('/', '_') + '.tgz'), '-O', entry], { maxBuffer: 64 * 1024 * 1024 })
      const file = entry.slice(prefix.length)
      modules[file] = createHash('sha256').update(content).digest('hex')
      if (file !== 'package.json') {
        const ast = parse(content.toString('utf8'), { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true })
        const normalized = JSON.stringify(ast, function (key, value) { return (['start', 'end', 'loc'].includes(key) && typeof this.type === 'string') || (key === 'raw' && this.type === 'Literal') ? undefined : typeof value === 'bigint' ? { bigint: String(value) } : value })
        programs[file] = createHash('sha256').update(normalized).digest('hex')
      }
    }
    return {
      name: binding.name,
      version: binding.new_version,
      integrity,
      tarball: url,
      sha256: tarballSha,
      modules,
      programs,
    }
  })
  const manifest = {
    schema: 'dsh-host-byte-audit/v1',
    hostVersion,
    upstreamCommit,
    auditedPlatforms: [],
    packages: rows,
  }
  writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + '\n')
  console.log('written', outputPath, 'packages:', rows.length)
} finally {
  rmSync(work, { recursive: true, force: true })
}
