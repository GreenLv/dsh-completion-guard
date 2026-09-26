import { describe, expect, it } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
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
    const clone=mkdtempSync(join(tmpdir(),'rc2-byte-audit-'))
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
        dependencies[p.name]=p.name;copied[p.name]={url:'./'+p.name,dependencies:{}}
      }
      copied['.']={url:'..',dependencies}
      writeFileSync(join(clone,'node_modules','.package-map.json'),JSON.stringify({packages:copied}))
      expect(auditedHostImplementation(clone,clone)).toBe(true)
      const entry=join(clone,'node_modules','@deepseek-ai/dsh-session/lib/index.js')
      writeFileSync(entry,readFileSync(entry,'utf8')+'\n// modified\n')
      expect(auditedHostImplementation(clone,clone)).toBe(false)
    } finally {rmSync(clone,{recursive:true,force:true})}
  })
})
