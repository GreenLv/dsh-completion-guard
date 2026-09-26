import { describe, expect, it } from 'vitest'
import { cpSync, symlinkSync, realpathSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import audit from '../manifests/rc017-rc2-byte-audit.json' with {type:'json'}
import manifest from '../manifests/supported-host.v1.json' with {type:'json'}
import { RC017_RC2_HOST_PACKAGES } from '../src/domain/rc017-rc2-host.js'
import { auditedHostImplementation, packageRowsFromActiveGraph, auditedForegroundRenderers } from '../src/domain/host-resolver.js'
import { evaluateHostLock } from '../src/domain/host-lock.js'

describe('rc.2 published identity and executable-byte audit', () => {
  it('keeps the public registry exactly equal to its single audited input source', () => {
    expect(manifest.cohorts).toHaveLength(1)
    expect(manifest.cohorts[0].packages).toEqual(RC017_RC2_HOST_PACKAGES)
    expect(manifest.cohorts[0].auditedPlatforms).toEqual([])
    expect(audit.packages.every(p=>Object.keys(p.modules).length>0)).toBe(true)
    expect(audit.packages.every(p=>/^[a-f0-9]{64}$/.test(p.sha256))).toBe(true)
  })
  it.runIf(Boolean(process.env.DSH_RUNTIME_ROOT))('verifies the installed graph, rejects byte drift and never mutates the provided host', () => {
    const runtime=process.env.DSH_RUNTIME_ROOT!
    const modules=join(runtime,'node_modules')
    const mapText=readFileSync(join(modules,'.package-map.json'),'utf8')
    const rows=packageRowsFromActiveGraph(mapText,readFileSync(join(runtime,'pnpm-lock.yaml'),'utf8'),modules)
    expect(evaluateHostLock(rows,{platform:'posix',profileKind:'web'}).status).toBe('supported')
    expect(auditedHostImplementation(runtime,runtime)).toBe(true)
    expect(auditedForegroundRenderers(runtime,runtime)).toEqual(['bash','pwsh'])
    const clone=realpathSync(mkdtempSync(join(tmpdir(),'rc2-byte-audit-')))
    try {
      const records=JSON.parse(mapText).packages
      const copied: Record<string,unknown>={'.':{url:'..',dependencies:{}}}
      const dependencies: Record<string,string>={}
      for(const p of audit.packages){
        const ids=Object.keys(records).filter(id=>id===p.name||id.startsWith(p.name+'@'))
        expect(ids).toHaveLength(1)
        const src=resolve(modules,records[ids[0]].url)
        const dst=join(clone,'node_modules',p.name)
        mkdirSync(dst,{recursive:true});copyFileSync(join(src,'package.json'),join(dst,'package.json'))
        for(const file of Object.keys(p.modules)){mkdirSync(dirname(join(dst,file)),{recursive:true});copyFileSync(join(src,file),join(dst,file))}
        const pkg=JSON.parse(readFileSync(join(dst,'package.json'),'utf8'))
        const edges=Object.fromEntries(Object.keys({...pkg.dependencies,...pkg.peerDependencies}).filter(name=>audit.packages.some(row=>row.name===name)).map(name=>[name,name]))
        dependencies[p.name]=p.name;copied[p.name]={url:'./'+p.name,dependencies:edges}
      }
      copied['.']={url:'..',dependencies}
      writeFileSync(join(clone,'package.json'),JSON.stringify({dependencies:Object.fromEntries(Object.keys(dependencies).map(name=>[name,'*']))}))
      writeFileSync(join(clone,'node_modules','.package-map.json'),JSON.stringify({packages:copied}))
      expect(auditedHostImplementation(clone,clone)).toBe(true)
      // Review counterexample: map/lock/bytes still point at the genuine
      // session, while an installation importer sees a different package.
      const shadow=join(clone,'node_modules/@deepseek-ai/dsh-agent-loop/node_modules/@deepseek-ai/dsh-session')
      cpSync(join(clone,'node_modules/@deepseek-ai/dsh-session'),shadow,{recursive:true})
      expect(execFileSync(process.execPath,['--input-type=module','-e',`import {createRequire} from 'node:module'; console.log(createRequire(${JSON.stringify(join(clone,'node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'))}).resolve('@deepseek-ai/dsh-session'))`],{encoding:'utf8'}).trim()).toBe(join(shadow,'lib/index.js'))
      expect(auditedHostImplementation(clone,clone)).toBe(false)
      rmSync(shadow,{recursive:true})
      // A normal dependency symlink to the mapped instance is accepted.
      const normal=join(clone,'node_modules/@deepseek-ai/dsh-tool-jobs/node_modules/@deepseek-ai/dsh-session')
      mkdirSync(dirname(normal),{recursive:true})
      symlinkSync(join(clone,'node_modules/@deepseek-ai/dsh-session'),normal,'junction')
      expect(auditedHostImplementation(clone,clone)).toBe(true)
      rmSync(normal,{recursive:true})
      const duplicate='@deepseek-ai/dsh-session@0.1.7-rc.2(duplicate)'
      copied[duplicate]=copied['@deepseek-ai/dsh-session']
      dependencies.duplicate=duplicate
      writeFileSync(join(clone,'node_modules','.package-map.json'),JSON.stringify({packages:copied}))
      expect(auditedHostImplementation(clone,clone)).toBe(false)
      delete copied[duplicate];delete dependencies.duplicate
      writeFileSync(join(clone,'node_modules','.package-map.json'),JSON.stringify({packages:copied}))
      const entry=join(clone,'node_modules','@deepseek-ai/dsh-session/lib/index.js')
      writeFileSync(entry,readFileSync(entry,'utf8')+'\n// modified\n')
      expect(auditedHostImplementation(clone,clone)).toBe(false)
    } finally {rmSync(clone,{recursive:true,force:true})}
  }, 20_000)
  it.runIf(Boolean(process.env.DSH_RUNTIME_ROOT))('matches the official rc.2 profile loader for ESM and CJS without a local peer', () => {
    const runtime=process.env.DSH_RUNTIME_ROOT!
    const modules=join(runtime,'node_modules')
    const records=JSON.parse(readFileSync(join(modules,'.package-map.json'),'utf8')).packages
    const packageRoot=(name:string):string=>realpathSync(resolve(modules,records[Object.keys(records).find(id=>id===name||id.startsWith(name+'@'))!].url))
    const temp=realpathSync(mkdtempSync(join(tmpdir(),'rc2-official-loader-')))
    try {
      const profile=join(temp,'profiles/headless')
      const importer=join(profile,'node_modules/probe/index.mjs')
      mkdirSync(dirname(importer),{recursive:true})
      writeFileSync(importer, `import {createRequire} from 'node:module'; export default {esm:import.meta.resolve('@deepseek-ai/dsh-session'),cjs:createRequire(import.meta.url).resolve('@deepseek-ai/dsh-session')}`)
      const session=packageRoot('@deepseek-ai/dsh-session')
      const resolution={profilesDir:join(temp,'profiles'),profileDir:profile,localPackageNames:['probe'],linkedRoots:[],entries:[{name:'@deepseek-ai/dsh-session',packageDir:session,declarer:join(packageRoot('@deepseek-ai/dsh-agent-loop'),'package.json'),version:'0.1.7-rc.2',scope:'installation'}]}
      const script=`import {setEnvironmentData} from 'node:worker_threads'; setEnvironmentData('@deepseek-ai/dsh-app-boot/profile-resolution',{resolution:${JSON.stringify(resolution)}}); await import(${JSON.stringify(pathToFileURL(join(packageRoot('@deepseek-ai/dsh-app-boot'),'lib/worker/profile-resolution-bootstrap.js')).href)}); console.log(JSON.stringify((await import(${JSON.stringify(pathToFileURL(importer).href)})).default))`
      const actual=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'}))
      expect(actual).toEqual({esm:pathToFileURL(join(session,'lib/index.js')).href,cjs:join(session,'lib/index.js')})
    } finally {rmSync(temp,{recursive:true,force:true})}
  })

})
