import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { realpathSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
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



describe('independent complete require plus import route proof',()=>{
  it.each([false,true].flatMap(profile=>['nested-import','require-default'].map(kind=>({profile,kind}))))('refuses ESM divergence $kind (profile=$profile)',({profile,kind})=>{
    const f=fixture(profile)
    if(profile){const local=pkg(f.p,dep);f.p.records[parent].dependencies={[dep]:dep};const dir=join(f.p.modules,'.pnpm/loop/node_modules',dep);mkdirSync(dirname(dir),{recursive:true});symlinkSync(local,dir,'junction')}
    expect(auditHostDependencyRoutes(f.graphs,f.profileRoot)).toBe(true)
    const lib=join(f.source,'lib'),wanted=f.p.packages.get(dep)!.root
    for(const [local,fileName] of [['ok.js','lib/index.js'],['ok-sub.js','lib/sub.js'],['ok-package.json','package.json']])symlinkSync(join(wanted,fileName),join(lib,local),'file')
    file(join(lib,'wrong.js'),'export const wrong=true')
    const dot=kind==='nested-import'?{node:{import:'./wrong.js'},default:'./ok.js'}:{require:'./ok.js',default:'./wrong.js'}
    file(join(lib,'package.json'),JSON.stringify({name:dep,exports:{'.':dot,'./sub':'./ok-sub.js','./package.json':'./ok-package.json'}}))
    file(join(lib,'oracle.mjs'),`console.log(JSON.stringify({resolved:import.meta.resolve('${dep}'),loadedWrong:(await import('${dep}')).wrong===true,loadedOk:(await import('${dep}')).ok===true}))`)
    const code="import {createRequire} from 'node:module';console.log(JSON.stringify({resolved:createRequire(process.argv[1]).resolve(process.argv[2])}))"
    const cjs=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',code,join(lib,'index.js'),dep],{encoding:'utf8'}))
    const esm=JSON.parse(execFileSync(process.execPath,[join(lib,'oracle.mjs')],{encoding:'utf8'}))
    expect(cjs.resolved).toBe(join(wanted,'lib/index.js'))
    expect(new URL(esm.resolved).pathname).toContain('/wrong.js');expect(esm.loadedWrong).toBe(true)
    const audit=auditHostDependencyRoutes(f.graphs,f.profileRoot)
    console.log(JSON.stringify({case:kind,level:'helper',profile,node:process.version,cjsTarget:'authenticated',esmTarget:'wrong',audit}))
    expect(audit).toBe(false)
  })
  it.each([false,true])('accepts a no-match fallback valid in BOTH lanes (profile=%s)',profile=>{
    const f=fixture(profile)
    if(profile){const local=pkg(f.p,dep);f.p.records[parent].dependencies={[dep]:dep};const dir=join(f.p.modules,'.pnpm/loop/node_modules',dep);mkdirSync(dirname(dir),{recursive:true});symlinkSync(local,dir,'junction')}
    const lib=join(f.source,'lib'),wanted=f.p.packages.get(dep)!.root
    for(const [local,fileName] of [['ok.js','lib/index.js'],['ok-sub.js','lib/sub.js'],['ok-package.json','package.json']])symlinkSync(join(wanted,fileName),join(lib,local),'file')
    file(join(lib,'package.json'),JSON.stringify({name:dep,exports:{'.':{node:{'fixture-inactive-condition':'./wrong.js'},default:'./ok.js'},'./sub':'./ok-sub.js','./package.json':'./ok-package.json'}}))
    file(join(lib,'oracle.mjs'),`console.log(JSON.stringify({resolved:import.meta.resolve('${dep}'),loadedWrong:(await import('${dep}')).wrong===true,loadedOk:(await import('${dep}')).ok===true}))`)
    const code="import {createRequire} from 'node:module';console.log(JSON.stringify({resolved:createRequire(process.argv[1]).resolve(process.argv[2])}))"
    const cjs=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',code,join(lib,'index.js'),dep],{encoding:'utf8'}))
    const esm=JSON.parse(execFileSync(process.execPath,[join(lib,'oracle.mjs')],{encoding:'utf8'}))
    expect(cjs.resolved).toBe(join(wanted,'lib/index.js'))
    expect(fileURLToPath(esm.resolved)).toBe(join(wanted,'lib/index.js'));expect(esm.loadedOk).toBe(true)
    expect(auditHostDependencyRoutes(f.graphs,f.profileRoot)).toBe(true)
  })
})
