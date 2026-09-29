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

describe('fresh restricted exports interpreter Node equivalence', () => {
  const kinds = ['default-first', 'require-first', 'unsupported-active-condition', 'mixed-map', 'parent-segment', 'node-modules-segment'] as const
  it.each([false,true].flatMap(profile => kinds.map(kind=>({profile,kind}))))('refuses $kind fresh Node mismatch (profile=$profile)', ({profile,kind})=>{
    const f=fixture(profile)
    if (profile) {
      const local=pkg(f.p,dep)
      f.p.records[parent].dependencies={ [dep]:dep }
      const link=join(f.p.modules,'.pnpm/loop/node_modules',dep)
      mkdirSync(dirname(link),{recursive:true});symlinkSync(local,link,'junction')
    }
    const importDir=join(f.source,'lib')
    const wantedRoot=f.p.packages.get(dep)!.root
    const link=(rel:string,fileName:string)=>{
      const dst=join(importDir,rel);mkdirSync(dirname(dst),{recursive:true})
      symlinkSync(join(wantedRoot,fileName),dst,'file')
    }
    link('ok.js','lib/index.js');link('ok-sub.js','lib/sub.js');link('ok-package.json','package.json')
    file(join(importDir,'wrong.js'),'export const wrong=true')
    let dot:unknown='./ok.js'
    if(kind==='default-first') dot={default:'./wrong.js',require:'./ok.js'}
    if(kind==='require-first') dot={require:'./wrong.js',node:'./ok.js'}
    if(kind==='unsupported-active-condition') dot={'node-addons':'./wrong.js',require:'./ok.js'}
    if(kind==='parent-segment'){link('../ok.js','lib/index.js');dot='./../ok.js'}
    if(kind==='node-modules-segment'){link('node_modules/ok.js','lib/index.js');dot='./node_modules/ok.js'}
    const exports:Record<string,unknown>={'.':dot,'./sub':'./ok-sub.js','./package.json':'./ok-package.json'}
    if(kind==='mixed-map') exports.default='./wrong.js'
    file(join(importDir,'package.json'),JSON.stringify({name:dep,exports}))
    const importer=join(importDir,'index.js')
    const code="import {createRequire} from 'node:module';try{console.log(JSON.stringify({resolved:createRequire(process.argv[1]).resolve(process.argv[2])}))}catch(e){console.log(JSON.stringify({error:e.code}))}"
    const fresh=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',code,importer,dep],{encoding:'utf8'}))
    if(kind==='default-first'||kind==='require-first'||kind==='unsupported-active-condition') expect(fresh.resolved).toBe(join(importDir,'wrong.js'))
    else expect(fresh.error).toBe(kind==='mixed-map'?'ERR_INVALID_PACKAGE_CONFIG':'ERR_INVALID_PACKAGE_TARGET')
    expect(auditHostDependencyRoutes(f.graphs,f.profileRoot)).toBe(false)
  })
  it.each([false,true].flatMap(profile=>[false,true].map(pattern=>({profile,pattern}))))('accepts normal conditional self route and an exact export alongside an unrelated pattern (profile=$profile, pattern=$pattern)', ({profile,pattern})=>{
    const f=fixture(profile)
    if(profile){ const local=pkg(f.p,dep);f.p.records[parent].dependencies={ [dep]:dep };const dir=join(f.p.modules,'.pnpm/loop/node_modules',dep);mkdirSync(dirname(dir),{recursive:true});symlinkSync(local,dir,'junction') }
    const lib=join(f.source,'lib'), root=f.p.packages.get(dep)!.root
    for(const [local,fileName] of [['ok.js','lib/index.js'],['ok-sub.js','lib/sub.js'],['ok-package.json','package.json']])symlinkSync(join(root,fileName),join(lib,local),'file')
    file(join(lib,'wrong.js'),'export const wrong=true')
    // Prior manifest used {require:ok, default:wrong}: safe for CJS only, a real
// ESM import loaded wrong.js. Replaced with a condition inactive in BOTH
// lanes before a safe default — genuinely dual-lane-safe.
    file(join(lib,'package.json'),JSON.stringify({name:dep,exports:{'.':{'fixture-inactive-condition':'./wrong.js',default:'./ok.js'},'./sub':'./ok-sub.js','./package.json':'./ok-package.json',...(pattern?{'./lib/*':'./lib/*'}:{})}}))
    expect(createRequire(join(lib,'index.js')).resolve(dep)).toBe(join(root,'lib/index.js'))
    expect(auditHostDependencyRoutes(f.graphs,f.profileRoot)).toBe(true)
  })
})
