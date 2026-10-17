/** Reproduce the path oracle from immutable 0.9.0 Git blobs, never candidate output. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
const BASE = 'c190a8dc79f4a89ead953ee4cd400fb9568795cf'
const output = process.argv[2]
if (!output) throw Error('usage: node tests/helpers/generate-legacy090-path-oracle.mjs <new-output.json>')
const root = mkdtempSync(join(tmpdir(), 'dcg-frozen090-path-'))
const canonical = value => JSON.stringify(value, (_key, v) => v instanceof Map ? { map: [...v] } : v instanceof Set ? { set: [...v] } : v)
const hash = value => createHash('sha256').update(value).digest('hex')
const blob = path => execFileSync('git', ['show', `${BASE}:${path}`], { maxBuffer: 16 * 1024 * 1024 })
function certificateFact(e) {
  return { id: e.id, outcome: e.outcome, method: e.toolName,
    operations: (e.operations ?? []).map(x => x.op), executables: e.executables ?? [], subjects: e.subjects,
    surfaces: e.surfaces, semanticAction: e.semanticAction ?? 'generic_run', evidenceRole: e.evidenceRole ?? 'effect',
    resolvedTarget: e.resolvedTarget ?? {}, observedState: e.observedState, parseStatus: e.parseStatus ?? 'adapter_unavailable',
    reasonCode: e.reasonCode ?? (e.parseStatus ? undefined : 'adapter_unavailable'), adapterId: e.adapterId, adapterVersion: e.adapterVersion }
}
try {
  const files = ['package.json', ...execFileSync('git', ['ls-tree', '-r', '--name-only', BASE, '--', 'dist'], { encoding: 'utf8' }).trim().split('\n').filter(p => p.endsWith('.js'))]
  const anchors = files.map(path => { const bytes = blob(path); const target = join(root,path); mkdirSync(dirname(target),{recursive:true});writeFileSync(target,bytes);return {path,sha256:hash(bytes)} })
  const digestSource = blob('src/domain/digest.ts')
  writeFileSync(join(root,'frozen-digest.mjs'), ts.transpileModule(digestSource.toString(), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText)
  const baseline = await import(pathToFileURL(join(root,'dist/domain/index.js')).href)
  const encoder = await import(pathToFileURL(join(root,'frozen-digest.mjs')).href)
  const hostLocks = Object.fromEntries(['posix','windows'].map(platform => [platform, {
    ...baseline.evaluateHostLock(baseline.EXPECTED_HOST_PACKAGES,{platform,profileKind:'web'}), derivedCohort: baseline.HOST_COHORTS[0],
  }]))
  const bases = [
    {id:'posix',platform:'posix',cwd:'/work/alpha',workdirs:[undefined,'sub','./中文 空格','../Other','/absolute/Case','/','//server/share'],paths:['src/a.ts','/absolute/a.ts']},
    {id:'drive',platform:'windows',cwd:'C:\\Work\\中文 空格',workdirs:[undefined,'sub','child\\dir','..\\Other','D:\\Absolute\\Case','D:/Absolute/Case','\\\\server.example.com\\share\\Case'],paths:['src\\a.ts','D:\\Absolute\\a.ts']},
    {id:'unc',platform:'windows',cwd:'\\\\server.example.com\\share\\中文 空格',workdirs:[undefined,'sub','child\\dir','..\\Other','C:\\Absolute\\Case','\\\\other\\share\\Case'],paths:['src\\a.ts','\\\\other\\share\\a.ts']},
  ]
  const vectors=[]
  function add(base,name,args,ptc,label) {
    const data = { turn:1,step:1,name, ...(ptc ? { subCallId:'call',rootCallId:'root',arguments:args } : {callId:'call',arguments:JSON.stringify(args)}) }
    const result = ptc ? { turn:1,step:1,subCallId:'call',rootCallId:'root',name,content:[{type:'text',text:'PASS'}],isError:false }
      : { turn:1,step:1,message:{role:'tool',source:{kind:'tool',callId:'call'},content:[{type:'text',text:'PASS'}],isError:false} }
    const events=[{seq:0,type:ptc?'tool/ptc-dispatch-start':'tool/call',data}, {seq:1,type:'plugin:oracle/ignorable',data:{bounded:true}}, {seq:2,type:ptc?'tool/ptc-dispatch':'tool/result',data:result}]
    const prefixes=[]
    for(let length=0;length<=events.length;length++) {
      const p=baseline.deriveProjection(events.slice(0,length),{activation:'always'},{cwd:base.cwd},true,base.hostMode==='absent'?undefined:hostLocks[base.platform]).projection
      const evidence=[...p.evidence.values()]
      let certificateDigest
      try { certificateDigest={sha256:encoder.evidenceSha256Digest(evidence.map(certificateFact))} } catch(e) { certificateDigest={unencodable:e.message} }
      const { hostLockDigest: _hostLockDigest, hostCohortId: _hostCohortId, ...logState } = p
      prefixes.push({length,integrity:p.integrity,projection_identity_sha256:hash(canonical(p)),log_state_sha256:hash(canonical(logState)),evidence,evidence_identity_sha256:hash(JSON.stringify(evidence)),certificate_digest:certificateDigest})
    }
    vectors.push({id:`${base.id}-${base.hostMode}-${ptc?'ptc':'ordinary'}-${name}-${label}`,platform:base.platform,host_mode:base.hostMode,cwd:base.cwd,events,prefixes})
  }
  for(const entry of bases) for(const hostMode of ['qualified','absent']) for(const ptc of [false,true]) {
    const base = { ...entry, hostMode }
    for(const name of ['bash','pwsh','shell']) for(const [i,workdir] of base.workdirs.entries()) add(base,name,{command:'npm test',...(workdir===undefined?{}:{workdir})},ptc,`workdir${i}`)
    for(const name of ['read','write','edit']) for(const [i,file_path] of base.paths.entries()) add(base,name,{file_path,content:'after',old_string:'before',new_string:'after'},ptc,`path${i}`)
  }
  const value={schema:'dcg-legacy090-path-oracle/v1',baseline_commit:BASE,baseline_runtime_files:anchors,baseline_digest_source_sha256:hash(digestSource),generator:'tests/helpers/generate-legacy090-path-oracle.mjs',scope:'No working-directory/change events. Exact frozen evidence bytes and evidence certificate digest at every prefix. Full projection uses the identical explicit bound host input. Omitted host uses each product default: only hostLockDigest/hostCohortId intentionally change with the new host registry; every other projection field remains equal.',host_locks:hostLocks,vectors}
  writeFileSync(resolve(output),JSON.stringify(value,null,2)+'\n',{flag:'wx'})
  console.log(JSON.stringify({vectors:vectors.length,prefixes:vectors.reduce((n,v)=>n+v.prefixes.length,0),sha256:hash(JSON.stringify(value))}))
} finally { rmSync(root,{recursive:true,force:true}) }
