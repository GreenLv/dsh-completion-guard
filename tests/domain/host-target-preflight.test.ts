import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RC1_HOST_PACKAGES } from '../../src/domain/rc1-host.js'
import { evaluateHostLock } from '../../src/domain/host-lock.js'
import { inspectTargetHostGraph, readActiveHostGraph, resolveActiveProfileHostLock } from '../../src/domain/host-resolver.js'
import { revalidateCoreLock } from '../../src/runtime.js'

const roots: string[] = []
const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']
const version = '0.1.2-rc.1'
const core = RC1_HOST_PACKAGES.filter((row) => row.name !== 'dshmarket')
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function json(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}
function lock(rows: typeof core) {
  return ["lockfileVersion: '9.0'", 'packages:', ...rows.flatMap((row) => [
    `  '${row.name}@${row.version}':`, `    resolution: {integrity: ${row.integrity}}`, '',
  ]), 'snapshots:', ''].join('\n')
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-target-preflight-')); roots.push(root)
  const runtime = join(root, 'runtime'); const profile = join(root, 'profiles', 'headless')
  const modules = join(runtime, 'node_modules')
  const records: Record<string, { url: string; dependencies: Record<string, string> }> = {
    '.': { url: '..', dependencies: {} },
  }
  for (const row of [...core, ...bundles.map((name) => ({ name, version, integrity: 'sha512-synthetic-bundle' }))]) {
    const id = `${row.name}@${row.version}`
    records['.'].dependencies[row.name] = id
    records[id] = { url: `./${row.name}`, dependencies: {} }
    json(join(modules, row.name, 'package.json'), {
      name: row.name, version: row.version,
      ...(bundles.includes(row.name) ? { dsh: { bundle: { patch: './cordis.patch.yml' } } } : {}),
    })
    if (bundles.includes(row.name)) writeFileSync(join(modules, row.name, 'cordis.patch.yml'), '[]\n')
  }
  const mapPath = join(modules, '.package-map.json')
  json(mapPath, { packages: records })
  writeFileSync(join(runtime, 'pnpm-lock.yaml'), lock([...core, ...bundles.map((name) => ({ name, version, integrity: 'sha512-synthetic-bundle' }))]))
  const manifestPath = join(profile, 'package.json')
  json(manifestPath, { dsh: { profile: { bundles } } })
  // The reported Windows input has only the manifest and a historical root
  // config; no patch/workspace/map/lock/modules. No daily path is accessed.
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  return { root, runtime, profile, modules, mapPath, manifestPath, records }
}
function installGuard(f: ReturnType<typeof fixture>) {
  json(f.manifestPath, { dependencies: { 'dsh-completion-guard': 'file:fixture.tgz' }, dsh: { profile: { bundles: [...bundles, 'dsh-completion-guard'] } } })
  json(join(f.profile, 'node_modules', 'dsh-completion-guard', 'package.json'), { name: 'dsh-completion-guard', version: '0.4.3' })
  json(join(f.profile, 'node_modules', '.package-map.json'), { packages: {
    '.': { url: '..', dependencies: { 'dsh-completion-guard': 'dsh-completion-guard' } },
    'dsh-completion-guard': { url: './dsh-completion-guard', dependencies: {} },
  } })
  writeFileSync(join(f.profile, 'pnpm-lock.yaml'), lock([{ name: 'dsh-completion-guard', version: '0.4.3', integrity: 'sha512-synthetic-guard' }]))
}

describe('dependency-free Headless target inspection', () => {
  it('recognizes the static Windows counterexample without installing, healing or certifying a profile importer', () => {
    const f = fixture()
    const before = readdirSync(f.profile).map((name) => [name, readFileSync(join(f.profile, name), 'utf8')])
    const target = inspectTargetHostGraph(f.runtime, f.profile)
    expect(target.profileGraph).toMatchObject({ state: 'dependency_free_headless', manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(target.profileGraph.bundles?.map((row) => [row.name, row.version])).toEqual(bundles.map((name) => [name, version]))
    expect(target.packages).toEqual(core)
    expect(readdirSync(f.profile).map((name) => [name, readFileSync(join(f.profile, name), 'utf8')])).toEqual(before)
    expect(() => readActiveHostGraph(f.runtime, f.profile)).toThrow()
    expect(() => resolveActiveProfileHostLock(f.runtime, f.profile, '0.4.3')).toThrow()
  })

  it('exposes pre-install scope through the shipped CLI without permitting installed inspection', () => {
    const f = fixture()
    const cli = fileURLToPath(new URL('../../bin/dsh-completion-guard-host-lock.mjs', import.meta.url))
    const args = ['--runtime-root', f.runtime, '--profile-root', f.profile]
    const target = spawnSync(process.execPath, [cli, 'inspect-graph', ...args], { encoding: 'utf8' })
    expect(target.status, target.stderr).toBe(0)
    expect(JSON.parse(target.stdout)).toMatchObject({ inspection_scope: 'pre_install_target', profile_graph: { state: 'dependency_free_headless' }, profile: 'headless', package_count: 33 })
    const installed = spawnSync(process.execPath, [cli, 'inspect', ...args], { encoding: 'utf8' })
    expect(installed.status).toBe(1)
    expect(JSON.parse(installed.stderr)).toMatchObject({ reason_code: 'active_graph_missing' })
    json(f.manifestPath, { dependencies: { missing: '1.0.0' }, dsh: { profile: { bundles } } })
    const rejected = spawnSync(process.execPath, [cli, 'inspect-graph', ...args], { encoding: 'utf8' })
    expect(rejected.status).toBe(1)
    expect(JSON.parse(rejected.stderr)).toMatchObject({ reason_code: 'target_profile_dependency_uninstalled' })
  })

  it('accepts explicit empty dependencies and initialized patch/workspace without creating an importer', () => {
    const f = fixture()
    json(f.manifestPath, { dependencies: {}, dsh: { profile: { bundles, patchReload: 'startup' } } })
    writeFileSync(join(f.profile, 'cordis.patch.yml'), '[]\n')
    writeFileSync(join(f.profile, 'pnpm-workspace.yaml'), 'packages: []\n')
    expect(inspectTargetHostGraph(f.runtime, f.profile).profileGraph.state).toBe('dependency_free_headless')
  })

  it.each(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'bundledDependencies', 'bundleDependencies'])('rejects %s declarations without an installed importer', (key) => {
    const f = fixture()
    json(f.manifestPath, { [key]: { 'dsh-completion-guard': '0.4.3' }, dsh: { profile: { bundles } } })
    expect(() => inspectTargetHostGraph(f.runtime, f.profile)).toThrow(/declares dependencies/)
  })

  it.each(['pnpm-lock.yaml', 'node_modules/.package-map.json'])('rejects a partial importer with only %s', (name) => {
    const f = fixture(); json(join(f.profile, name), {})
    expect(() => inspectTargetHostGraph(f.runtime, f.profile)).toThrow(/partial profile importer/)
  })

  it.each(['node_modules', '.dsh-module-fallback'])('rejects unexplained %s even when empty', (name) => {
    const f = fixture(); mkdirSync(join(f.profile, name))
    expect(() => inspectTargetHostGraph(f.runtime, f.profile)).toThrow(/modules exist/)
  })

  it.each([
    [...bundles, 'dsh-completion-guard'], [...bundles, 'dsh-context-guard'],
    ['@deepseek-ai/dsh-base'], [...bundles].reverse(), ['@deepseek-ai/dsh-base', 'foreign'],
  ])('rejects unrecognized or plugin-bearing bundle tuple %j', (...tuple) => {
    const f = fixture(); json(f.manifestPath, { dsh: { profile: { bundles: tuple } } })
    expect(() => inspectTargetHostGraph(f.runtime, f.profile)).toThrow(/Headless bundle tuple/)
  })

  it.each(['bad-version', 'wrong-map', 'missing-patch', 'escaped-patch'])('rejects invalid installation-owned bundle: %s', (mutation) => {
    const f = fixture(); const name = bundles[0]; const root = join(f.modules, name)
    if (mutation === 'bad-version') json(join(root, 'package.json'), { name, version: '99.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } })
    if (mutation === 'wrong-map') { f.records[`${name}@${version}`].url = './@deepseek-ai/dsh'; json(f.mapPath, { packages: f.records }) }
    if (mutation === 'missing-patch') rmSync(join(root, 'cordis.patch.yml'))
    if (mutation === 'escaped-patch') {
      const outside = join(f.root, 'outside.yml'); writeFileSync(outside, '[]\n')
      json(join(root, 'package.json'), { name, version, dsh: { bundle: { patch: relative(root, outside) } } })
    }
    expect(() => inspectTargetHostGraph(f.runtime, f.profile)).toThrow()
  })

  it('rejects a bundle resolved outside the installation even with a matching manifest', () => {
    const f = fixture(); const outside = join(f.root, 'foreign-bundle')
    json(join(outside, 'package.json'), { name: bundles[0], version, dsh: { bundle: { patch: './cordis.patch.yml' } } })
    writeFileSync(join(outside, 'cordis.patch.yml'), '[]\n')
    rmSync(join(f.modules, bundles[0]), { recursive: true })
    symlinkSync(outside, join(f.modules, bundles[0]), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => inspectTargetHostGraph(f.runtime, f.profile)).toThrow(/installation-owned/)
  })

  it('verifies visible parent fallback provenance and rejects a foreign same-version shadow', () => {
    const f = fixture(); const link = join(dirname(f.profile), 'node_modules', '@deepseek-ai', 'dsh-session')
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(join(f.modules, '@deepseek-ai/dsh-session'), link, process.platform === 'win32' ? 'junction' : 'dir')
    expect(inspectTargetHostGraph(f.runtime, f.profile).profileGraph.state).toBe('dependency_free_headless')
    unlinkSync(link)
    json(join(link, 'package.json'), { name: '@deepseek-ai/dsh-session', version })
    expect(() => inspectTargetHostGraph(f.runtime, f.profile)).toThrow(/lookup differs/)
  })

  it.each(['missing-core', 'mixed-core', 'duplicate-core', 'malformed-map', 'broken-edge', 'invalid-lock'])('never substitutes an invalid runtime: %s', (mutation) => {
    const f = fixture(); const name = '@deepseek-ai/dsh-session'; const id = `${name}@${version}`
    if (mutation === 'missing-core') delete f.records['.'].dependencies[name]
    if (mutation === 'mixed-core') json(join(f.modules, name, 'package.json'), { name, version: '0.1.2-alpha.3' })
    if (mutation === 'duplicate-core') { f.records[`${id}(duplicate)`] = f.records[id]; f.records['.'].dependencies.alias = `${id}(duplicate)` }
    if (mutation === 'broken-edge') f.records['.'].dependencies.foreign = 'absent'
    json(f.mapPath, { packages: f.records })
    if (mutation === 'malformed-map') writeFileSync(f.mapPath, '{}')
    if (mutation === 'invalid-lock') writeFileSync(join(f.runtime, 'pnpm-lock.yaml'), 'broken')
    expect(() => inspectTargetHostGraph(f.runtime, f.profile)).toThrow()
  })

  it('moves to strict installed graph checks and cannot reuse the empty-profile exception after installation', () => {
    const f = fixture(); expect(inspectTargetHostGraph(f.runtime, f.profile).profileGraph.state).toBe('dependency_free_headless')
    installGuard(f)
    expect(inspectTargetHostGraph(f.runtime, f.profile).profileGraph.state).toBe('active_importer')
    const active = resolveActiveProfileHostLock(f.runtime, f.profile, '0.4.3')
    expect(active.evaluation.status).toBe('supported')
    rmSync(join(f.profile, 'pnpm-lock.yaml'))
    rmSync(join(f.profile, 'node_modules', '.package-map.json'))
    expect(() => inspectTargetHostGraph(f.runtime, f.profile)).toThrow()
    expect(() => resolveActiveProfileHostLock(f.runtime, f.profile, '0.4.3')).toThrow()
    const config = { hostLockPolicy: 'dsh-core/v1', hostLockRuntimeRoot: f.runtime, hostLockProfileRoot: f.profile, hostLockPlatform: active.platform, hostLockProfile: active.profileKind }
    expect(revalidateCoreLock(config as Parameters<typeof revalidateCoreLock>[0], evaluateHostLock(core))).toMatchObject({ status: 'unavailable' })
  })

  it.each(['malformed-map', 'broken-edge', 'invalid-lock'])('does not hide damaged profile importer behind complete runtime rows: %s', (mutation) => {
    const f = fixture(); installGuard(f)
    if (mutation === 'malformed-map') writeFileSync(join(f.profile, 'node_modules', '.package-map.json'), '{}')
    if (mutation === 'broken-edge') json(join(f.profile, 'node_modules', '.package-map.json'), { packages: { '.': { url: '..', dependencies: { missing: 'absent' } } } })
    if (mutation === 'invalid-lock') writeFileSync(join(f.profile, 'pnpm-lock.yaml'), 'broken')
    expect(() => inspectTargetHostGraph(f.runtime, f.profile)).toThrow()
    expect(() => resolveActiveProfileHostLock(f.runtime, f.profile, '0.4.3')).toThrow()
  })
})
