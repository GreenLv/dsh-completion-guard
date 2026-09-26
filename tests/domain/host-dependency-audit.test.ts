import { afterEach, describe, expect, it } from 'vitest'
import { realpathSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { auditHostDependencyRoutes, type DependencyAuditGraph } from '../../src/domain/host-dependency-audit.js'

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

describe('rc.2 mapped dependency edge family (native and profile interception)', () => {
  it.each([false, true])('accepts mapped pnpm identity / profile installation route (%s)', profile => {
    const f = fixture(profile)
    expect(auditHostDependencyRoutes(f.graphs, f.profileRoot)).toBe(true)
  })
  it.each([false, true])('rejects an unlisted nearer shadow with identical metadata and exports (%s)', profile => {
    const f = fixture(profile)
    const rogue = graph(join(f.home, 'rogue')); const copy = pkg(rogue, dep)
    const link = join(f.source, 'lib/node_modules', dep)
    mkdirSync(dirname(link), { recursive: true }); symlinkSync(copy, link, 'junction')
    expect(auditHostDependencyRoutes(f.graphs, f.profileRoot)).toBe(false)
  })
  it('rejects a missing native edge even with all mapped targets present', () => {
    const f = fixture(); rmSync(join(f.p.modules, '.pnpm/loop/node_modules', dep), { recursive: true })
    // Move the mapped package away from the ancestor node_modules path too.
    const mapped = f.runtime.packages.get(dep)!
    pkg(f.runtime, dep, [], '.pnpm/session/node_modules/' + dep)
    rmSync(mapped.root, { recursive: true })
    expect(auditHostDependencyRoutes(f.graphs, f.profileRoot)).toBe(false)
  })
  it.each([false, true])('rejects a map edge redirected to another package (%s)', profile => {
    const f = fixture(profile); f.p.records[parent].dependencies = { [dep]: parent }
    expect(auditHostDependencyRoutes(f.graphs, f.profileRoot)).toBe(false)
  })
  it('accepts a profile-local mapped critical copy with normal symlinks', () => {
    const f = fixture(true); pkg(f.p, dep)
    f.p.records[parent].dependencies = { [dep]: dep }
    expect(auditHostDependencyRoutes(f.graphs, f.profileRoot)).toBe(true)
  })
  it('does not fall back to installation when a mapped profile dependency is missing', () => {
    const f = fixture(true); const root = pkg(f.p, dep)
    f.p.records[parent].dependencies = { [dep]: dep }; rmSync(root, { recursive: true })
    expect(auditHostDependencyRoutes(f.graphs, f.profileRoot)).toBe(false)
  })
  it('rejects an export subpath symlink escaping the authenticated package', () => {
    const f = fixture(); const filePath = join(f.runtime.packages.get(dep)!.root, 'lib/sub.js')
    rmSync(filePath); file(join(f.home, 'outside.js'), 'export const ok = true')
    symlinkSync(join(f.home, 'outside.js'), filePath)
    expect(auditHostDependencyRoutes(f.graphs, f.profileRoot)).toBe(false)
  })
  it('refuses an unreviewed import/require conditional divergence', () => {
    const f = fixture(); f.runtime.packages.get(dep)!.manifest.exports = { '.': { import: './lib/sub.js', require: './lib/index.js' } }
    expect(auditHostDependencyRoutes(f.graphs, f.profileRoot)).toBe(false)
  })
})
