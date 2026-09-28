import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { realpathSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { auditHostDependencyRoutes, type DependencyAuditGraph } from '../../src/domain/host-dependency-audit.js'
import { createHostAuditSession, type HostAuditSession } from '../../src/domain/host-audit-session.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const dep = '@host/session'
const parent = '@host/loop'
function file(path: string, text: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
function graph(root: string): DependencyAuditGraph {
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  file(join(root, 'package.json'), '{}')
  return { modules: join(root, 'node_modules'), records: { '.': { url: '..', dependencies: {} } }, reachable: new Set(['.']), packages: new Map() }
}
function pkg(g: DependencyAuditGraph, name: string, deps: string[] = [], location = name) {
  const root = join(g.modules, location)
  const manifest = { name, version: '1.0.0', type: 'module', exports: { '.': { types: './index.d.ts', default: './lib/index.js' }, './sub': { default: './lib/sub.js' }, './package.json': './package.json' }, dependencies: Object.fromEntries(deps.map(n => [n, '1.0.0'])) }
  file(join(root, 'package.json'), JSON.stringify(manifest))
  file(join(root, 'lib/index.js'), 'export const ok = true')
  file(join(root, 'lib/sub.js'), 'export const ok = true')
  g.records[name] = { url: './' + location, dependencies: Object.fromEntries(deps.map(n => [n, n])) }
  g.reachable.add(name)
  g.packages.set(name, { root, manifest, files: ['package.json', 'lib/index.js', 'lib/sub.js'] })
  return root
}
function fixture(profile = false) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'host-dependency-edge-'))); dirs.push(home)
  const runtime = graph(join(home, 'runtime'))
  const p = profile ? graph(join(home, 'profiles', 'headless')) : runtime
  pkg(runtime, dep)
  const source = pkg(p, parent, [dep], '.pnpm/loop/node_modules/' + parent)
  if (profile) p.records[parent].dependencies = {} // official installation-provided peer
  else {
    const link = join(p.modules, '.pnpm/loop/node_modules', dep)
    mkdirSync(dirname(link), { recursive: true }); symlinkSync(runtime.packages.get(dep)!.root, link, 'junction')
  }
  return { home, runtime, p, source, graphs: profile ? [runtime, p] : [runtime], profileRoot: dirname(p.modules) }
}

describe('resident Node resolver freshness review', () => {
  const cases = [false, true].flatMap(profile => ['none', 'unrelated'].flatMap(initialScope =>
    ['redirect', 'deny'].map(mode => ({ profile, initialScope, mode }))))
  it.each(cases)('rejects $mode after a warmed $initialScope scope (profile=$profile)', ({ profile, initialScope, mode }) => {
    const f = fixture(profile)
    if (profile) {
      const local = pkg(f.p, dep)
      f.p.records[parent].dependencies = { [dep]: dep }
      const link = join(f.p.modules, '.pnpm/loop/node_modules', dep)
      mkdirSync(dirname(link), { recursive: true }); symlinkSync(local, link, 'junction')
    }
    const importer = join(f.source, 'lib/index.js')
    const scope = join(f.source, 'lib/package.json')
    const expected = join(f.p.packages.get(dep)!.root, 'lib/index.js')
    if (initialScope === 'unrelated') file(scope, JSON.stringify({ name: '@unrelated/scope', exports: { '.': './index.js' } }))
    // A running host has already loaded/resolved dependencies from this module.
    // A new createRequire and a new HostAuditSession cannot reset Node's own caches.
    expect(createRequire(importer).resolve(dep)).toBe(expected)
    expect(auditHostDependencyRoutes(f.graphs, f.profileRoot)).toBe(true)
    file(scope, JSON.stringify(mode === 'deny' ? { name: dep, exports: { '.': null } } : {
      name: dep, exports: { '.': './index.js', './sub': './sub.js', './package.json': './package.json' },
    }))
    // Independently establish the same current disk input in a fresh Node process.
    const code = "import {createRequire} from 'node:module';try{console.log(JSON.stringify({resolved:createRequire(process.argv[1]).resolve(process.argv[2])}))}catch(e){console.log(JSON.stringify({error:e.code}))}"
    const fresh = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code, importer, dep], { encoding: 'utf8' }))
    if (mode === 'deny') expect(fresh.error).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED')
    else expect(fresh.resolved).toBe(importer)
    const next = createHostAuditSession()
    expect(next.readJson(scope).name).toBe(dep) // Fresh bytes DO see the altered scope.
    expect(auditHostDependencyRoutes(f.graphs, f.profileRoot, next)).toBe(false)
  })
})
