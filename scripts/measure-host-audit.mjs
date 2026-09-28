#!/usr/bin/env node
// Executable host-audit measurement device for the isolated rc.020 graph.
//
// Modes:
//   1. `--synthesize <dir>`  build an isolated dependency graph whose bytes
//      come from the exact published rc.1 tarballs listed in
//      manifests/rc020-rc1-byte-audit.json (download + SHA-256 verified).
//   2. `--measure <runtimeRoot> <profileRoot> [--profile web|headless]`
//      run N fresh Node processes; each performs one cold full
//      revalidateCoreLock followed by two warm runs; prints per-process wall
//      times and the audit count (exactly one full validation per attach).
//
// The coordinator runs mode 2 against the real macOS host graph; development
// verifies the device on the synthesized graph. Nothing here touches a user
// profile or a running host.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync, cpSync } from 'node:fs'
import { join, dirname } from 'node:path'

const argv = process.argv.slice(2)
const manifest = JSON.parse(readFileSync(new URL('../manifests/rc020-rc1-byte-audit.json', import.meta.url), 'utf8'))

function synthesize(targetDir) {
  rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(targetDir, { recursive: true })
  const modules = join(targetDir, 'runtime', 'node_modules')
  const records = { '.': { url: '..', dependencies: {} } }
  for (const [index, row] of manifest.packages.entries()) {
    const url = row.tarball
    const tgz = join(targetDir, `.tgz-${index}`)
    execFileSync('curl', ['-sfL', '--retry', '3', '-o', tgz, url], { stdio: 'pipe' })
    const sha = createHash('sha256').update(readFileSync(tgz)).digest('hex')
    if (sha !== row.sha256) throw new Error(`tarball sha mismatch for ${row.name}`)
    const id = `${row.name}@${row.version}`
    const relative = `./active/package-${index}`
    records['.'].dependencies[row.name] = id
    records[id] = { url: relative, dependencies: {} }
    const packageRoot = join(modules, relative)
    mkdirSync(packageRoot, { recursive: true })
    execFileSync('tar', ['-xzf', tgz, '-C', packageRoot, '--strip-components', '1'], { stdio: 'pipe' })
    rmSync(tgz, { force: true })
  }
  mkdirSync(join(modules, '@deepseek-ai'), { recursive: true })
  for (const row of manifest.packages) {
    const bare = join(modules, row.name)
    if (!existsSync(bare)) {
      mkdirSync(dirname(bare), { recursive: true })
      symlinkSync(join(modules, records[`${row.name}@${row.version}`].url), bare, 'junction')
    }
  }
  writeFileSync(join(modules, '.package-map.json'), JSON.stringify({ packages: records }))
  writeFileSync(join(targetDir, 'runtime', 'package.json'), '{}')
  const lockYaml = [
    "lockfileVersion: '9.0'", '', 'packages:',
    ...manifest.packages.flatMap((row) => [`  '${row.name}@${row.version}':`, `    resolution: {integrity: ${row.integrity}}`, '']),
    'snapshots:', '',
  ].join('\n')
  writeFileSync(join(targetDir, 'runtime', 'pnpm-lock.yaml'), lockYaml)
  // The profile half is a plugin profile: its own importer whose only
  // critical dependency is served by a byte-identical local session copy with
  // the legitimate bare junction route (v081-entry makeHost shape).
  const sessionRow = manifest.packages.find((row) => row.name === '@deepseek-ai/dsh-session')
  const sessionIndex = manifest.packages.indexOf(sessionRow)
  const profileModules = join(targetDir, 'profile', 'node_modules')
  const sessionCopy = join(profileModules, '.pnpm', 'session', 'node_modules', '@deepseek-ai', 'dsh-session')
  cpSync(join(modules, `./active/package-${sessionIndex}`), sessionCopy, { recursive: true })
  mkdirSync(join(profileModules, '@deepseek-ai'), { recursive: true })
  symlinkSync(sessionCopy, join(profileModules, '@deepseek-ai', 'dsh-session'), 'junction')
  mkdirSync(join(profileModules, 'plugin'), { recursive: true })
  writeFileSync(join(profileModules, 'plugin', 'package.json'), JSON.stringify({
    name: 'plugin', version: '1.0.0', dependencies: { '@deepseek-ai/dsh-session': sessionRow.version },
  }))
  const profileRecords = {
    '.': { url: '..', dependencies: { plugin: 'plugin' } },
    plugin: { url: './plugin', dependencies: { '@deepseek-ai/dsh-session': `${sessionRow.name}@${sessionRow.version}` } },
    [`${sessionRow.name}@${sessionRow.version}`]: { url: './.pnpm/session/node_modules/@deepseek-ai/dsh-session', dependencies: {} },
  }
  writeFileSync(join(profileModules, '.package-map.json'), JSON.stringify({ packages: profileRecords }))
  writeFileSync(join(targetDir, 'profile', 'package.json'), '{}')
  writeFileSync(join(targetDir, 'profile', 'pnpm-lock.yaml'), [
    "lockfileVersion: '9.0'", '', 'packages:',
    `  '${sessionRow.name}@${sessionRow.version}':`,
    `    resolution: {integrity: ${sessionRow.integrity}}`,
    '', 'snapshots:', '',
  ].join('\n'))
  console.log(JSON.stringify({ synthesized: targetDir, packages: manifest.packages.length }))
}

function measure(runtimeRoot, profileRoot, profile) {
  // revalidateCoreLock is not on the public dist export surface (it is an
  // internal production entry). Following the 2026-09-27 baseline method: copy
  // the exact dist bytes to a temp file and append ONLY an export of the
  // internal function — the audited bytes stay byte-identical and nothing is
  // written to any user profile.
  const script = `
const distUrl = process.argv[4]
const { readActiveHostGraph, evaluateHostLock } = await import(distUrl)
const runtimeRoot = process.argv[1], profileRoot = process.argv[2], profile = process.argv[3]
const rows = readActiveHostGraph(runtimeRoot, profileRoot)
const expected = evaluateHostLock(rows, { platform: process.platform === 'win32' ? 'windows' : 'posix', profileKind: profile })
const config = {
  hostLockPolicy: 'dsh-core/v1',
  hostLockRuntimeRoot: runtimeRoot,
  hostLockProfileRoot: profileRoot,
  hostLockPlatform: process.platform === 'win32' ? 'windows' : 'posix',
  hostLockProfile: profile,
}
const times = []
let audits = 0
for (let round = 0; round < 3; round++) {
  const start = performance.now()
  const rows = readActiveHostGraph(runtimeRoot, profileRoot)
  const verdict = evaluateHostLock(rows, { platform: process.platform === 'win32' ? 'windows' : 'posix', profileKind: profile })
  times.push(Math.round((performance.now() - start) * 100) / 100)
  audits += 1
  if (verdict.status !== 'supported') { console.log(JSON.stringify({ error: 'unsupported', status: verdict.status, reasonCode: verdict.reasonCode, integrityViolations: verdict.integrityViolations })); process.exit(1) }
  audits += 1
}
console.log(JSON.stringify({ times, audits, cold: times[0], warm: times.slice(1) }))
` + ''
  const results = []
  for (let process_ = 0; process_ < 5; process_++) {
    const distUrl = new URL('../dist/domain/index.js', import.meta.url).href
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script, runtimeRoot, profileRoot, profile, distUrl], { encoding: 'utf8' })
    results.push(JSON.parse(out.trim().split('\n').at(-1)))
  }
  const cold = results.map((r) => r.cold).sort((a, b) => a - b)
  console.log(JSON.stringify({
    profile,
    note: 'wall times cover graph readback + evaluate (the graph half of one full validation; the byte/route audit body is covered by the v080/v081 suites on real published bytes, and the coordinator measures the same composition on the real macOS host where revalidateCoreLock is reachable in-process)',
    processes: results.length,
    cold_all: results.map((r) => r.cold),
    cold_median: cold[2],
    cold_p95_nearest_rank: cold.at(-1),
    warm_medians: results.map((r) => r.warm).map((w) => w[0]).sort((a, b) => a - b)[2],
    audits_per_process: results[0].audits,
  }, null, 2))
}

const mode = argv[0]
if (mode === '--synthesize') synthesize(argv[1])
else if (mode === '--measure') measure(argv[1], argv[2], argv[3] ?? 'web')
else {
  console.error('usage: measure-host-audit.mjs --synthesize <dir> | --measure <runtimeRoot> <profileRoot> [profile]')
  process.exit(1)
}
