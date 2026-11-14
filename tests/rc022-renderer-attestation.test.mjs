import {describe,it,expect} from 'vitest'
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,realpathSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import * as bash from '@deepseek-ai/dsh-tool-bash'
import * as pwsh from '@deepseek-ai/dsh-tool-pwsh'
import {createToolResultMessage,createUserMessage} from '@deepseek-ai/dsh-llm'
import {Session,SessionId} from '@deepseek-ai/dsh-session'
import {projectSessionCoreV2} from '../src/core-v2/session.js'
import {createCheckpointTool} from '../src/tools/checkpoint.js'
import audit from '../manifests/rc022-rc2-byte-audit.json' with {type:'json'}
// The rc.3 attestation rows re-bind the rc.2 study's lib digests (rc.2→rc.3
// changes no renderer lib bytes), so the rc.2 audit manifest still supplies
// the expected digests. The 0.2.1 rc.2 audited bytes stay the drift control:
// the five packages whose lib bytes rc.2 re-published must never accept the
// rc.1 row, and none of them impersonates the active rc.3 identity.
import historical from '../manifests/rc021-rc2-byte-audit.json' with {type:'json'}
import {createHostAuditSession} from '../src/domain/host-audit-session.js'
import {auditedForegroundRenderers,auditedDefaultWorkdirHost} from '../src/domain/host-resolver.js'
import {deriveProjection,PROTOCOL_V6_NOTICE} from '../src/domain/derive.js'
import {evaluateHostLock,EXPECTED_HOST_PACKAGES} from '../src/domain/host-lock.js'
const names=['dsh-tool-bash','dsh-tool-pwsh','dsh-shell','dsh-working-directory','dsh-sandbox-policy','dsh-sandbox','dsh-bash-sandbox','dsh-bash-local','dsh-pwsh-local']
const digest=Object.fromEntries(names.map(name=>[name,audit.packages.find(p=>p.name===`@deepseek-ai/${name}`).modules['lib/index.js']]))
function fixture(){const root=realpathSync(mkdtempSync(join(tmpdir(),'cg-rc022-renderers-'))),deps={},packages={'.':{url:'..',dependencies:deps}}
 for(const name of names){const packageName=`@deepseek-ai/${name}`,id=`${packageName}@0.2.2-rc.3`,dir=join(root,'node_modules',packageName);mkdirSync(join(dir,'lib'),{recursive:true});writeFileSync(join(dir,'package.json'),JSON.stringify({name:packageName,version:'0.2.2-rc.3'}));writeFileSync(join(dir,'lib/index.js'),'placeholder');deps[packageName]=id;packages[id]={url:`./${packageName}`,dependencies:{}}}
 writeFileSync(join(root,'node_modules','.package-map.json'),JSON.stringify({packages}));return root}
function audited(changed, replacement='0'.repeat(64)){const session=createHostAuditSession();session.fileDigest=path=>{const name=names.find(n=>path.endsWith(join('@deepseek-ai',n,'lib','index.js')));if(!name)throw Error('unexpected digest path');return changed===name?replacement:digest[name]};return session}
function evidence(name,text,attested=true){const host={...evaluateHostLock(EXPECTED_HOST_PACKAGES,{platform:name==='bash'?'posix':'windows',profileKind:'web'}),auditedForegroundRenderers:attested?[name]:[]};const events=[{seq:0,type:'user/message',data:{source:{kind:'context-guard',plugin:'context-guard',form:'notice'},content:[{type:'text',text:PROTOCOL_V6_NOTICE}]}},{seq:1,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'Run npm test.'}]}},{seq:2,type:'tool/call',data:{callId:'run',name,arguments:'{"command":"npm test","workdir":"/work"}'}},{seq:3,type:'tool/result',data:{message:createToolResultMessage({callId:'run',content:[{type:'text',text}],isError:false})}}];return [...deriveProjection(events,{activation:'always'},{cwd:'/work'},true,host).projection.evidence.values()][0]?.outcome}
async function checkpoint(name,text,attested){const id=SessionId('renderer-proof'),session=Session.create(id,undefined,{version:4,id,isSeeded:false,createdAt:1,cwd:'/work'});session.append('user/message',createUserMessage({source:{kind:'context-guard',plugin:'context-guard',form:'notice'},content:[{type:'text',text:PROTOCOL_V6_NOTICE}]}),{surfaceOp:'append'});session.append('turn/start',{turn:1});session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Run npm test in /work.'}]}),{surfaceOp:'append'});session.append('tool/call',{turn:1,step:1,callId:'run',name,arguments:JSON.stringify({command:'npm test',workdir:'/work'})});session.append('tool/result',{turn:1,step:1,message:createToolResultMessage({callId:'run',content:[{type:'text',text}],isError:false})},{surfaceOp:'append'});const events=session.snapshotEvents(),host={...evaluateHostLock(EXPECTED_HOST_PACKAGES,{platform:name==='bash'?'posix':'windows',profileKind:'web'}),auditedForegroundRenderers:attested?[name]:[]},scope={cwd:'/work',sessionHeader:{version:4,id,createdAt:1,seedLength:0,delegationDepth:0}};const projection=deriveProjection(events,{activation:'always'},scope,true,host).projection;projection.durabilityWatermark='confirmed';projection.coreV2=projectSessionCoreV2(events,projection);return createCheckpointTool(()=>projection,()=>{}).execute({bindings:[]},undefined)}
function renderer(plugin){let tool;const ctx={shell:{},shellEnv:{collect:()=>({})},get:()=>undefined,logger:{warn:()=>{}},systemPrompt:{section:()=>{},getSectionOrder:()=>0},tools:{register:value=>{tool=value;return()=>{}}},inject:(_names,cb)=>cb({effect:()=>{}})};plugin.apply(ctx,{enableRunInBackground:false});return value=>tool.output.render({},value)[0].text}

describe('0.2.2-rc.3 renderer and workdir attestation',()=>{
 it('accepts each registered current byte identity and rejects each drift for its owning lane',()=>{const root=fixture();try{
  expect(auditedForegroundRenderers(root,root,audited())).toEqual(['bash','pwsh'])
  expect(auditedDefaultWorkdirHost(root,root,'bash',audited())).toBe(true);expect(auditedDefaultWorkdirHost(root,root,'pwsh',audited())).toBe(true)
  const bashInputs=['dsh-tool-bash','dsh-shell','dsh-working-directory','dsh-sandbox-policy','dsh-sandbox','dsh-bash-sandbox','dsh-bash-local']
  const pwshInputs=['dsh-tool-pwsh','dsh-shell','dsh-working-directory','dsh-pwsh-local']
  for(const name of names){if(bashInputs.includes(name))expect(auditedDefaultWorkdirHost(root,root,'bash',audited(name)),name).toBe(false);if(pwshInputs.includes(name))expect(auditedDefaultWorkdirHost(root,root,'pwsh',audited(name)),name).toBe(false)}
  // Historical bytes remain archival evidence and cannot impersonate the
  // different bytes audited for the active 0.2.2-rc.3 package identity.
  for(const name of ['dsh-tool-bash','dsh-tool-pwsh','dsh-working-directory','dsh-sandbox-policy','dsh-sandbox']){
   const old=historical.packages.find(p=>p.name===`@deepseek-ai/${name}`).modules['lib/index.js'];expect(old).not.toBe(digest[name])
   if(bashInputs.includes(name))expect(auditedDefaultWorkdirHost(root,root,'bash',audited(name,old)),name).toBe(false)
   if(pwshInputs.includes(name))expect(auditedDefaultWorkdirHost(root,root,'pwsh',audited(name,old)),name).toBe(false)
  }
  expect(auditedForegroundRenderers(root,root,audited('dsh-tool-bash'))).toEqual(['pwsh']);expect(auditedForegroundRenderers(root,root,audited('dsh-tool-pwsh'))).toEqual(['bash']);expect(auditedForegroundRenderers(root,root,audited('dsh-shell'))).toEqual([])
 }finally{rmSync(root,{recursive:true,force:true})}})
 it.each([['bash',bash],['pwsh',pwsh]])('classifies the actual %s published renderer for success and negative outcomes',async(name,plugin)=>{
  const render=renderer(plugin),base={kind:'foreground',cwd:'/work',exitCode:0,signal:null,timedOut:false,aborted:false,timeoutMs:1000,stdout:{text:'done',truncated:false},stderr:{text:'',truncated:false}}
  const success=render(base);expect(evidence(name,success)).toBe('success');expect((await checkpoint(name,success,true)).status).toBe('observed');expect((await checkpoint(name,success,false)).status).toBe('incomplete')
  expect(evidence(name,render({...base,exitCode:7}))).toBe('failure')
  expect(evidence(name,render({...base,signal:'SIGTERM'}))).toBe('failure')
  expect(evidence(name,render({...base,timedOut:true}))).toBe('failure')
  expect(evidence(name,render({kind:'promoted',cwd:'/work',jobId:'job-1',timeoutMs:1000,output:'done'}))).toBe('unknown')
 })
})
