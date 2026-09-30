import { describe, expect, it, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, symlinkSync, cpSync, rmSync, renameSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'
import { evaluateActiveHostLock, readActiveHostGraph, inspectTargetHostGraph } from '../src/domain/host-resolver.js'
vi.setConfig({ testTimeout: 60_000 })
// Synthetic DSH 0.2.0-rc.1 identities exercise complete production admission.
// Each critical package has one real hashed module and its manifest. Published
// module bytes are checked separately in v080-rc017-host.test.ts with an
// explicit DSH_RUNTIME_ROOT; neither lane starts a host or uses a model.
const { AUDITED_MODULE_TEXT, canonicalManifest } = vi.hoisted(() => ({
  AUDITED_MODULE_TEXT: 'export const auditedModule = true\n',
  canonicalManifest: (name: string, version: string) => JSON.stringify({
    name, version, ...(name === '@deepseek-ai/dsh' ? { dependencies: { '@deepseek-ai/cordis': '4.0.4' } } : {}), exports: { '.': { types: './index.d.ts', default: './lib/index.js' } },
  }),
}))
vi.mock('../manifests/rc020-rc2-byte-audit.json', async (original) => {
  const { createHash } = await import('node:crypto')
  const { hostProgramDigest, hostManifestLoadingDigest } = await import('../src/domain/host-contract-program.js')
  const auditedModuleDigest = createHash('sha256').update(AUDITED_MODULE_TEXT).digest('hex')
  const source = await original<{ default: { packages: Array<Record<string, unknown>> } }>()
  return { default: { ...source.default, packages: source.default.packages.map((p) => ({
    ...p, sha256: '0'.repeat(64), tarball: '',
    // The published audit hashes package.json too: the manifest the JSON
    // parsers read and the bytes the digest check reads are the same file.
    loadingDigest: hostManifestLoadingDigest(canonicalManifest(p.name as string, p.version as string)),
    programs: { 'lib/index.js': hostProgramDigest(AUDITED_MODULE_TEXT) },
    modules: {
      'package.json': createHash('sha256').update(canonicalManifest(p.name as string, p.version as string)).digest('hex'),
      'lib/index.js': auditedModuleDigest,
    },
  })) } }
})


const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function makeHost(hoisted = true, profileHoisted = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'v081-entry-drift-')))
  temporaryRoots.push(root)
  const runtimeRoot = join(root, 'runtime')
  const profileRoot = join(root, 'profile')
  const modulesRoot = join(runtimeRoot, 'node_modules')
  mkdirSync(modulesRoot, { recursive: true })
  const packages: Record<string, { url: string; dependencies: Record<string, string> }> = {
    '.': { url: '..', dependencies: {} },
  }
  for (const [index, row] of EXPECTED_HOST_PACKAGES.entries()) {
    const id = hoisted ? row.name : `${row.name}@${row.version}`
    const relative = hoisted ? `./${row.name}` : `./active/package-${index}`
    packages['.'].dependencies[row.name] = id
    packages[id] = { url: relative, dependencies: hoisted ? { [row.name]: id } : {} }
    if (!hoisted && row.name === '@deepseek-ai/dsh') packages[id].dependencies['@deepseek-ai/cordis'] = '@deepseek-ai/cordis@4.0.4'
    const packageRoot = join(modulesRoot, relative)
    mkdirSync(packageRoot, { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), canonicalManifest(row.name, row.version!))
    mkdirSync(join(packageRoot, 'lib'), { recursive: true })
    writeFileSync(join(packageRoot, 'lib', 'index.js'), AUDITED_MODULE_TEXT)
  }
  mkdirSync(join(modulesRoot, '@deepseek-ai'), { recursive: true })
  for (const row of hoisted ? [] : EXPECTED_HOST_PACKAGES) {
    symlinkSync(join(modulesRoot, packages[`${row.name}@${row.version}`].url), join(modulesRoot, row.name), 'junction')
  }
  writeFileSync(join(runtimeRoot, 'package.json'), '{}')
  const lockYaml = [
    "lockfileVersion: '9.0'", '', 'packages:',
    ...EXPECTED_HOST_PACKAGES.flatMap((row) => [
      `  '${row.name}@${row.version}':`,
      `    resolution: {integrity: ${row.integrity}}`,
      '',
    ]),
    'snapshots:', '',
  ].join('\n')
  writeFileSync(join(runtimeRoot, 'pnpm-lock.yaml'), lockYaml)
  writeFileSync(join(modulesRoot, '.package-map.json'), JSON.stringify({ packages }))
  const profileModules = join(profileRoot, 'node_modules')
  const sessionIndex = EXPECTED_HOST_PACKAGES.findIndex((row) => row.name === '@deepseek-ai/dsh-session')
  const sessionRow = EXPECTED_HOST_PACKAGES[sessionIndex]
  const sessionCopy = profileHoisted ? join(profileModules, sessionRow.name) : join(profileModules, '.pnpm', 'session', 'node_modules', '@deepseek-ai', 'dsh-session')
  mkdirSync(sessionCopy, { recursive: true })
  cpSync(join(modulesRoot, hoisted ? sessionRow.name : `./active/package-${sessionIndex}`), sessionCopy, { recursive: true })
  mkdirSync(join(profileModules, '@deepseek-ai'), { recursive: true })
  if (!profileHoisted) symlinkSync(sessionCopy, join(profileModules, '@deepseek-ai', 'dsh-session'), 'junction')
  mkdirSync(join(profileModules, 'plugin'), { recursive: true })
  writeFileSync(join(profileModules, 'plugin', 'package.json'), JSON.stringify({
    name: 'plugin', version: '1.0.0', main: './lib/index.js',
    dependencies: { '@deepseek-ai/dsh-session': sessionRow.version },
  }))
  mkdirSync(join(profileModules, 'plugin/lib'), { recursive: true })
  writeFileSync(join(profileModules, 'plugin/lib/index.js'), AUDITED_MODULE_TEXT)
  writeFileSync(join(profileRoot, 'package.json'), '{}')
  writeFileSync(join(profileRoot, 'pnpm-lock.yaml'), [
    "lockfileVersion: '9.0'", '', 'packages:',
    `  '${sessionRow.name}@${sessionRow.version}':`,
    `    resolution: {integrity: ${sessionRow.integrity}}`,
    '', 'snapshots:', '',
  ].join('\n'))
  const profilePackages = profileHoisted ? {
    '.': { url: '..', dependencies: { plugin: 'plugin', [sessionRow.name]: sessionRow.name } },
    plugin: { url: './plugin', dependencies: { plugin: 'plugin' } },
    [sessionRow.name]: { url: './' + sessionRow.name, dependencies: { [sessionRow.name]: sessionRow.name } },
  } : {
    '.': { url: '..', dependencies: { plugin: 'plugin' } },
    plugin: { url: './plugin', dependencies: { '@deepseek-ai/dsh-session': `${sessionRow.name}@${sessionRow.version}` } },
    [`${sessionRow.name}@${sessionRow.version}`]: { url: './.pnpm/session/node_modules/@deepseek-ai/dsh-session', dependencies: {} },
  }
  writeFileSync(join(profileModules, '.package-map.json'), JSON.stringify({ packages: profilePackages }))
  const rows = readActiveHostGraph(runtimeRoot, profileRoot)
  return {
    root, runtimeRoot, profileRoot, packages, profilePackages, rows,
    sessionPackageDir: join(modulesRoot, hoisted ? sessionRow.name : `./active/package-${sessionIndex}`),
    config: {
      activation: 'always' as const,
      policy: 'release' as const,
      hostLockPolicy: 'dsh-core/v1',
      hostLockTrust: undefined as string | undefined,
      hostLockRuntimeRoot: runtimeRoot,
      hostLockProfileRoot: profileRoot,
      hostLockPlatform: 'posix' as const,
      hostLockProfile: 'headless' as const,
      hostLockPackages: rows,
    },
  }
}


const dep = '@deepseek-ai/cordis'
const app = '@deepseek-ai/dsh'
function saveMap(h: ReturnType<typeof makeHost>) {
  writeFileSync(join(h.runtimeRoot, 'node_modules/.package-map.json'), JSON.stringify({ packages: h.packages }))
}
function audit(h: ReturnType<typeof makeHost>) {
  // Complete identity acquisition and production byte/route admission, with a
  // new audit session on EVERY call, never just the dependency helper.
  expect(Array.isArray(readActiveHostGraph(h.runtimeRoot, h.profileRoot))).toBe(true)
  return evaluateActiveHostLock(h.runtimeRoot, h.profileRoot, { platform: 'posix', profileKind: 'headless' }).status
}
function native(h: ReturnType<typeof makeHost>) {
  return nativeFrom(join(h.runtimeRoot, 'node_modules', app, 'lib/index.js'), dep)
}
function nativeFrom(importer: string, name: string) {
  const cjs = execFileSync(process.execPath, ['-e', `console.log(require('node:module').createRequire(${JSON.stringify(importer)}).resolve(${JSON.stringify(name)}))`], { encoding: 'utf8' }).trim()
  const oracle = join(dirname(importer), 'oracle.mjs')
  writeFileSync(oracle, `console.log(import.meta.resolve(${JSON.stringify(name)}))`)
  const esm = fileURLToPath(execFileSync(process.execPath, [oracle], { encoding: 'utf8' }).trim())
  return { cjs: realpathSync(cjs), esm: realpathSync(esm) }
}
describe('full host admission for standard hoisted package maps', () => {
  it('admits declared sibling dependencies absent from self-only records, matching independent fresh Node lanes', () => {
    const h = makeHost()
    expect(h.packages[app].dependencies).toEqual({ [app]: app })
    const wanted = realpathSync(join(h.runtimeRoot, 'node_modules', dep, 'lib/index.js'))
    expect(native(h)).toEqual({ cjs: wanted, esm: wanted })
    expect(audit(h)).toBe('supported')
    expect(inspectTargetHostGraph(h.runtimeRoot, h.profileRoot).packages.length).toBeGreaterThan(40)
  })
  it.each([false, true])('admits profile-local hoisted siblings with runtime hoisted=%s, rejecting fresh index loss/conflict and shadow then restoring', runtimeHoisted => {
    const h = makeHost(runtimeHoisted, true)
    const name = '@deepseek-ai/dsh-session'
    const modules = join(h.profileRoot, 'node_modules')
    const importer = join(modules, 'plugin/lib/index.js')
    const wanted = realpathSync(join(modules, name, 'lib/index.js'))
    expect(nativeFrom(importer, name)).toEqual({ cjs: wanted, esm: wanted })
    expect(audit(h)).toBe('supported')
    expect(inspectTargetHostGraph(h.runtimeRoot, h.profileRoot).packages.length).toBeGreaterThan(40)
    for (const mode of ['missing-index', 'conflicting-index', 'shadow']) {
      const rootIndex = h.profilePackages['.'].dependencies as Record<string, string>
      const shadow = join(dirname(importer), 'node_modules', name)
      if (mode === 'missing-index') delete rootIndex[name]
      if (mode === 'conflicting-index') rootIndex[name] = 'plugin'
      if (mode === 'shadow') {
        mkdirSync(dirname(shadow), { recursive: true })
        cpSync(join(modules, name), shadow, { recursive: true })
        expect(nativeFrom(importer, name)).toEqual({ cjs: join(shadow, 'lib/index.js'), esm: join(shadow, 'lib/index.js') })
      }
      writeFileSync(join(modules, '.package-map.json'), JSON.stringify({ packages: h.profilePackages }))
      expect(['unsupported', 'unavailable']).toContain(audit(h))
      expect(() => inspectTargetHostGraph(h.runtimeRoot, h.profileRoot)).toThrow()
      if (mode === 'shadow') rmSync(shadow, { recursive: true, force: true })
      rootIndex[name] = name
      writeFileSync(join(modules, '.package-map.json'), JSON.stringify({ packages: h.profilePackages }))
      expect(audit(h)).toBe('supported')
    }
  })
  it('preserves a complete isolated map and rejects its missing declared edge', () => {
    const h = makeHost(false)
    expect(audit(h)).toBe('supported')
    delete h.packages[`${app}@0.2.0-rc.2`].dependencies[dep]
    saveMap(h)
    expect(['unsupported', 'unavailable']).toContain(audit(h))
  })
  it.each(['mapped-conflict', 'wrong-root', 'missing-root', 'unreachable-duplicate', 'scope-redirect', 'scope-deny', 'nearer-shadow', 'outside-symlink'] as const)('rejects %s in a new full audit after admission, and admits restoration', mode => {
    const h = makeHost()
    expect(audit(h)).toBe('supported')
    const modules = join(h.runtimeRoot, 'node_modules')
    const original = JSON.stringify(h.packages)
    const mutations: string[] = []
    const stash = join(h.root, 'stashed-cordis')
    if (mode === 'mapped-conflict') h.packages[app].dependencies[dep] = app
    if (mode === 'wrong-root') h.packages['.'].dependencies[dep] = app
    if (mode === 'missing-root') delete h.packages['.'].dependencies[dep]
    if (mode === 'unreachable-duplicate') {
      const id = `${app}/node_modules/${dep}`
      h.packages[id] = { url: './' + id, dependencies: { [dep]: id } }
      // Deliberately unreachable: name authority cannot be borrowed from root.
    }
    if (mode === 'scope-redirect' || mode === 'scope-deny') {
      const scope = join(modules, app, 'lib/package.json')
      writeFileSync(scope, JSON.stringify({ name: dep, exports: { '.': mode === 'scope-deny' ? null : './redirect.js' } }))
      writeFileSync(join(dirname(scope), 'redirect.js'), AUDITED_MODULE_TEXT)
      mutations.push(scope, join(dirname(scope), 'redirect.js'))
    }
    if (mode === 'nearer-shadow') {
      const shadow = join(modules, app, 'lib/node_modules', dep)
      mkdirSync(shadow, { recursive: true })
      writeFileSync(join(shadow, 'package.json'), canonicalManifest(dep, '4.0.4'))
      mkdirSync(join(shadow, 'lib')); writeFileSync(join(shadow, 'lib/index.js'), AUDITED_MODULE_TEXT)
      mutations.push(join(modules, app, 'lib/node_modules'))
      const result = native(h)
      expect(result.cjs).toBe(join(shadow, 'lib/index.js'))
      expect(result.esm).toBe(join(shadow, 'lib/index.js'))
    }
    if (mode === 'outside-symlink') {
      const installed = join(modules, dep)
      renameSync(installed, stash)
      symlinkSync(stash, installed, 'junction')
      mutations.push(installed)
    }
    saveMap(h)
    expect(['unsupported', 'unavailable']).toContain(audit(h))
    expect(() => inspectTargetHostGraph(h.runtimeRoot, h.profileRoot)).toThrow()
    for (const path of mutations) rmSync(path, { force: true, recursive: true })
    if (mode === 'outside-symlink') renameSync(stash, join(modules, dep))
    h.packages = JSON.parse(original)
    saveMap(h)
    expect(audit(h)).toBe('supported')
  })
})
