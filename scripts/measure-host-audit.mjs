#!/usr/bin/env node
// Source harness for production attach/replay/checkpoint/publish/Goal/Stop.
// --synthesize downloads the reviewed archives into a new disposable graph.
// --measure runs five fresh source-harness workers, observing full validations.
// No daily host is started; external mutations are mocked. Use --installed-graph
// only when the explicit roots are a real installation, rather than fixtures.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync, cpSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
// CG-083-VAL02: the measurement baseline is the CURRENT cohort manifest
// (rc020-rc2-byte-audit.json). `rc020-rc1-byte-audit.json` is retained as
// history for replaying older reports; selecting it is an explicit
// `--manifest` decision, never the default.
const defaultManifest = new URL('../manifests/rc020-rc2-byte-audit.json', import.meta.url)
const manifestFlag = argv.indexOf('--manifest')
const manifestPath = manifestFlag > 0 ? argv[manifestFlag + 1] : undefined
const manifest = JSON.parse(readFileSync(manifestPath ?? defaultManifest, 'utf8'))
const desktopDigestFlag = argv.indexOf('--desktop-digest')

function synthesize(targetDir) {
  if (existsSync(targetDir)) throw new Error('synthesis requires a new unused directory')
  mkdirSync(targetDir, { recursive: true })
  const modules = join(targetDir, 'runtime', 'node_modules')
  const records = { '.': { url: '..', dependencies: {} } }
  // Pass 1: extract every cohort tarball and keep each real manifest.
  const extracted = []
  for (const [index, row] of manifest.packages.entries()) {
    const url = row.tarball
    const tgz = join(targetDir, `.tgz-${index}`)
    execFileSync('curl', ['-sfL', '--retry', '3', '-o', tgz, url], { stdio: 'pipe' })
    const sha = createHash('sha256').update(readFileSync(tgz)).digest('hex')
    if (sha !== row.sha256) throw new Error(`tarball sha mismatch for ${row.name}`)
    const id = `${row.name}@${row.version}`
    const relative = `./active/package-${index}`
    const packageRoot = join(modules, relative)
    mkdirSync(packageRoot, { recursive: true })
    execFileSync('tar', ['-xzf', tgz, '-C', packageRoot, '--strip-components', '1'], { stdio: 'pipe' })
    rmSync(tgz, { force: true })
    const manifestJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
    extracted.push({ row, id, relative, manifestJson })
  }
  // Pass 2: declare the ACTUAL dependency edges the real manifests declare,
  // mapped onto cohort record ids. The route audit authenticates exactly these
  // edges, so a synthesized graph without them is not a host graph.
  const idByName = new Map(extracted.map(({ row, id }) => [row.name, id]))
  const names = new Set(idByName.keys())
  for (const { row, id, relative, manifestJson } of extracted) {
    const name = row.name
    const declared = {
      ...(manifestJson.dependencies ?? {}),
      ...(manifestJson.peerDependencies ?? {}),
      ...(manifestJson.optionalDependencies ?? {}),
    }
    const mapped = {}
    for (const depName of Object.keys(declared)) {
      if (names.has(depName)) mapped[depName] = idByName.get(depName)
    }
    records[id] = { url: relative, dependencies: mapped }
  }
  // The root package carries every cohort package as a direct dependency,
  // like a real runtime root.
  records['.'] = { url: '..', dependencies: Object.fromEntries(extracted.map(({ row, id }) => [row.name, id])) }
  mkdirSync(join(modules, '@deepseek-ai'), { recursive: true })
  for (const { row, id, relative } of extracted) {
    const bare = join(modules, row.name)
    if (!existsSync(bare)) {
      mkdirSync(dirname(bare), { recursive: true })
      symlinkSync(join(modules, relative), bare, 'junction')
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
  const repo = fileURLToPath(new URL('../', import.meta.url))
  const graphKind = argv.includes('--installed-graph') ? 'installed-graph/source-harness' : 'synthetic/source-harness'
  const results = [], raw = []
  const vitest = join(repo, 'node_modules', 'vitest', 'vitest.mjs')
  for (let index = 0; index < 5; index++) {
    const out = execFileSync(process.execPath, [vitest, 'run', 'tests/v081-host-protocol-measurement.test.ts', '--maxWorkers', '1'], {
    cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, DSH_MEASURE_RUNTIME: runtimeRoot, DSH_MEASURE_PROFILE: profileRoot,
      DSH_MEASURE_KIND: profile, DSH_MEASURE_GRAPH_KIND: graphKind,
      ...(profile === 'desktop'
        ? { DSH_MEASURE_DESKTOP_DIGEST: desktopDigestFlag > 0 ? argv[desktopDigestFlag + 1] : '' }
        : {}) },
  })
    raw.push(out)
    const match = out.match(/DSH_HOST_MEASUREMENT=(.+)/)
    if (!match) throw new Error('production measurement did not emit its observed result')
    results.push(JSON.parse(match[1]))
  }
  const files = [...new Set([...execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'src', 'manifests', 'package.json', 'pnpm-lock.yaml',
    'scripts/measure-host-audit.mjs', 'tests/v081-host-protocol-measurement.test.ts'], { cwd: repo, encoding: 'utf8' }).trim().split('\n'),
    'src/domain/host-trust.ts', 'tests/v081-host-protocol-measurement.test.ts'])].sort()
  const sourceSha256 = Object.fromEntries(files.map((file) => [file, createHash('sha256').update(readFileSync(join(repo, file))).digest('hex')]))
  const entries = Object.fromEntries(results[0].measurements.map(({ entry }) => {
    const samples = results.map((r) => r.measurements.find((m) => m.entry === entry))
    const sorted = samples.map((s) => s.wall_ms).sort((a, b) => a - b)
    return [entry, { samples, median_ms: sorted[2], p95_nearest_rank_ms: sorted.at(-1) }]
  }))
  console.log(JSON.stringify({ schema: 'dsh-host-entry-measurement/v1', profile, graph_kind: graphKind,
    manifest: { path: manifestPath ? String(manifestPath) : 'manifests/rc020-rc2-byte-audit.json',
      sha256: createHash('sha256').update(readFileSync(manifestPath ?? defaultManifest)).digest('hex') },
    note: 'Five fresh Vitest worker processes; cold is first production attach in each. OS cache is not dropped. Wall clock includes actual entry awaits and final veto. Audits observed through onHostLockValidation. External publish effects are mocked; no DSH host is launched.',
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    source_sha256: sourceSha256, artifact: null, artifact_note: 'source harness; no exact tgz acceptance claim',
    installed_graph_inputs: [runtimeRoot, profileRoot].map((root) => Object.fromEntries(['package.json', 'pnpm-lock.yaml', 'node_modules/.package-map.json'].map((file) => [file, createHash('sha256').update(readFileSync(join(root, file))).digest('hex')]))),
    processes: results.length, results, entries, raw_outputs: raw,
  }, null, 2))
}

const mode = argv[0]
const measureFlag = argv.indexOf('--measure')
if (mode === '--synthesize') synthesize(argv[1])
else if (measureFlag >= 0) measure(argv[measureFlag + 1], argv[measureFlag + 2], argv[measureFlag + 3] ?? 'web')
else {
  console.error('usage: measure-host-audit.mjs --synthesize <dir> | --measure [--manifest <path>] [--desktop-digest <sha256>] <runtimeRoot> <profileRoot> [web|headless|desktop]')
  process.exit(1)
}
