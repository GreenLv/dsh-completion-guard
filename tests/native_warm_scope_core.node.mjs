import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runWarmScope } from '../scripts/native_warm_scope_core.mjs'
import { resolveWarmRuntime } from '../scripts/native_warm_host_probe.mjs'

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'dcg-warm-unit-')); t.after(()=>rm(root,{recursive:true,force:true}))
  const dir=join(root,'node_modules','consumer','lib'), target=join(root,'node_modules','@scope','target')
  await mkdir(dir,{recursive:true}); await mkdir(target,{recursive:true})
  const importer=join(dir,'index.js'); await writeFile(importer,'module.exports = 1\n')
  await writeFile(join(target,'package.json'),JSON.stringify({name:'@scope/target',exports:{'.':'./index.js'}}))
  await writeFile(join(target,'index.js'),'module.exports = 2\n')
  return {root,importer,scope:join(dir,'package.json'),dependency:'@scope/target'}
}
const prepare=async mode=>({id:(mode==='redirect'?'a':'b').repeat(24),unconsumed:true,effectCount:mode==='redirect'?1:2})
function adapter(change){let count=0,audit=0;return async (stage,ticket)=>{if(change)await change(stage);const auditBefore=audit++;const safe=stage==='baseline'||stage.endsWith('_restored');const base={auditBefore,auditAfter:audit,ticketId:ticket?.id,lockStatus:safe?'supported':'unsupported',lockReason:safe?null:'host_lock_installed_graph_drift'};if(stage==='baseline'||stage.endsWith('_restored'))return {...base,status:'completed',reason_code:'action_completed',effectCount:++count};return {...base,status:'unavailable',reason_code:'host_implementation_bytes_mismatch',effectCount:count}}}
test('positive, both drift denials and recovery share one process',async t=>{const f=await fixture(t);const result=await runWarmScope({fixtureRoot:f.root,importer:f.importer,dependency:f.dependency,prepare,perform:adapter()});assert.equal(result.status,'passed',JSON.stringify(result));assert.equal(result.stages.filter(x=>x.status==='completed').length,3);assert.equal(result.stages.filter(x=>x.status==='unavailable').length,2);assert.equal(result.stages.find(x=>x.stage==='warm').resident_pid,process.pid);assert.equal(result.cleanup,'passed');await assert.rejects(readFile(f.scope),{code:'ENOENT'})})
test('fails closed when drift incorrectly permits an effect and restores scope',async t=>{const f=await fixture(t);const perform=async (stage,ticket)=>({status:'completed',reason_code:'action_completed',effectCount:stage==='baseline'?1:2,auditBefore:0,auditAfter:1,ticketId:ticket?.id,lockStatus:stage==='baseline'?'supported':'unsupported',lockReason:stage==='baseline'?null:'host_lock_installed_graph_drift'});const r=await runWarmScope({fixtureRoot:f.root,importer:f.importer,dependency:f.dependency,prepare,perform});assert.equal(r.status,'failed');assert.equal(r.failure.code,'ACTION_OR_EFFECT_MISMATCH');assert.equal(r.cleanup,'passed');await assert.rejects(readFile(f.scope),{code:'ENOENT'})})
test('preserves a pre-existing scope',async t=>{const f=await fixture(t);await writeFile(f.scope,'owner data');const r=await runWarmScope({fixtureRoot:f.root,importer:f.importer,dependency:f.dependency,prepare,perform:adapter()});assert.equal(r.failure.code,'SCOPE_EXISTS');assert.equal(await readFile(f.scope,'utf8'),'owner data')})
test('preserves externally changed scope and reports cleanup failure',async t=>{const f=await fixture(t);const r=await runWarmScope({fixtureRoot:f.root,importer:f.importer,dependency:f.dependency,prepare,perform:adapter(async stage=>{if(stage==='redirect')await writeFile(f.scope,'changed by owner')})});assert.equal(r.status,'failed');assert.equal(r.failure.code,'SCOPE_CHANGED');assert.equal(r.cleanup,'failed_preserved');assert.equal(await readFile(f.scope,'utf8'),'changed by owner')})
test('rejects importer outside the fixture before mutation',async t=>{const f=await fixture(t);const other=await mkdtemp(join(tmpdir(),'dcg-outside-'));t.after(()=>rm(other,{recursive:true,force:true}));const r=await runWarmScope({fixtureRoot:other,importer:f.importer,dependency:f.dependency,prepare,perform:adapter()});assert.equal(r.failure.code,'FIXTURE_ESCAPE');await assert.rejects(readFile(f.scope),{code:'ENOENT'})})
test('oracle failure returns a redacted stage result',async t=>{const f=await fixture(t);const r=await runWarmScope({fixtureRoot:f.root,importer:f.importer,dependency:f.dependency,prepare,perform:adapter(),oracle:async()=>{throw Object.assign(new Error(f.root),{code:'ORACLE_FAILED'})}});assert.equal(r.failure.code,'ORACLE_FAILED');assert.equal(JSON.stringify(r).includes(f.root),false)})
test('unknown child state preserves owned scope and marks cleanup failed',async t=>{const f=await fixture(t);let calls=0;const {freshResolve}=await import('../scripts/native_warm_scope_core.mjs');const oracle=async(...args)=>{calls++;if(calls===2)throw Object.assign(new Error('timeout'),{code:'ORACLE_TIMEOUT',childStateUnknown:true});return freshResolve(...args)};const r=await runWarmScope({fixtureRoot:f.root,importer:f.importer,dependency:f.dependency,prepare,perform:adapter(),oracle});assert.equal(r.failure.child_state_unknown,true);assert.equal(r.cleanup,'failed_preserved');assert.notEqual(await readFile(f.scope,'utf8'),'')})
test('refuses a consumed or malformed ticket before scope creation',async t=>{
  for(const invalid of [{id:'a'.repeat(24),unconsumed:false,effectCount:1},{id:'bad',unconsumed:true,effectCount:1},{id:'a'.repeat(24),unconsumed:true,effectCount:2}]){
    const f=await fixture(t),r=await runWarmScope({fixtureRoot:f.root,importer:f.importer,dependency:f.dependency,prepare:async()=>invalid,perform:adapter()})
    assert.equal(r.failure.code,'PREPARE_FAILED');assert.equal(r.failure.stage,'redirect_prepare');assert.equal(r.cleanup,'passed')
    assert.deepEqual(r.stages.map(row=>row.stage),['warm','baseline']);await assert.rejects(readFile(f.scope),{code:'ENOENT'})
  }
})
test('refuses stale audit or unobserved graph drift and removes only its own scope',async t=>{
  for(const mode of ['stale_audit','supported_lock']){
    const f=await fixture(t),normal=adapter()
    const perform=async(stage,ticket)=>{const value=await normal(stage,ticket);if(stage==='redirect'){
      if(mode==='stale_audit')value.auditAfter=value.auditBefore
      else {value.lockStatus='supported';value.lockReason=null}
    }return value}
    const r=await runWarmScope({fixtureRoot:f.root,importer:f.importer,dependency:f.dependency,prepare,perform})
    assert.equal(r.failure.code,'ACTION_OR_EFFECT_MISMATCH');assert.equal(r.failure.stage,'redirect');assert.equal(r.cleanup,'passed')
    const failed=r.stages.find(row=>row.stage==='redirect_failed_observed');assert.equal(failed.effect_count,1)
    await assert.rejects(readFile(f.scope),{code:'ENOENT'})
  }
})

async function installedRuntime(t,layout,{escapeAnchor=false,escapeSession=false,escapeDependency=false,externalImporterDependency=false,mismatch=false,missingSession=false,missingDependency=false}={}) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'dcg-warm-route-')));t.after(()=>rm(root,{recursive:true,force:true}))
  const runtime=join(root,'runtime'), scope='@deepseek-ai'
  const moduleDir=join(runtime,'node_modules',scope)
  const outside=join(root,'outside')
  const realDir=(name)=>layout==='hoisted'?join(moduleDir,name):join(runtime,'node_modules','.pnpm',name,'node_modules',scope,name)
  const localDir=(name)=>layout==='hoisted'?moduleDir:join(runtime,'node_modules','.pnpm',name,'node_modules',scope)
  const dsh=escapeAnchor?join(outside,'dsh'):realDir('dsh')
  const session=escapeSession?join(outside,'dsh-session'):realDir('dsh-session')
  const llm=escapeDependency?join(outside,'dsh-llm'):realDir('dsh-llm')
  const alternate=externalImporterDependency?join(outside,'alternate-llm'):realDir('alternate-llm')
  const link=async(target,path)=>{await mkdir(dirname(path),{recursive:true});await symlink(target,path,process.platform==='win32'?'junction':'dir')}
  for(const dir of [dsh,...(missingDependency?[]:[llm]),...(missingSession?[]:[session]),...((mismatch||externalImporterDependency)?[alternate]:[])])await mkdir(dir,{recursive:true})
  await writeFile(join(dsh,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh',version:'0.2.2-rc.3'}))
  async function addLlm(dir){await writeFile(join(dir,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh-llm',exports:{'.':'./index.js'}}));await writeFile(join(dir,'index.js'),'module.exports = 2\n')}
  if(!missingDependency)await addLlm(llm);if(mismatch||externalImporterDependency)await addLlm(alternate)
  if(!missingSession){await mkdir(join(session,'lib'));await writeFile(join(session,'lib','index.js'),'module.exports = 1\n');await writeFile(join(session,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh-session',main:'./lib/index.js'}))}
  if(layout==='isolated') {
    await link(dsh,join(moduleDir,'dsh'))
    if(!missingSession)await link(session,join(localDir('dsh'),'dsh-session'))
    if(!missingDependency)await link(llm,join(localDir('dsh'),'dsh-llm'))
    if(!missingSession&&!missingDependency)await link((mismatch||externalImporterDependency)?alternate:llm,join(localDir('dsh-session'),'dsh-llm'))
  } else {
    if(escapeAnchor)await link(dsh,join(moduleDir,'dsh'))
    if(escapeSession)await link(session,join(moduleDir,'dsh-session'))
    if(escapeDependency)await link(llm,join(moduleDir,'dsh-llm'))
    if(mismatch||externalImporterDependency)await link(alternate,join(session,'node_modules',scope,'dsh-llm'))
  }
  return {root,runtime,session,llm,dsh,scope:join(session,'lib','package.json')}
}

for(const layout of ['isolated','hoisted'])test(`uses installed DSH SDK route through all warm stages on ${layout}`,async t=>{
  const f=await installedRuntime(t,layout), sdk=resolveWarmRuntime({fixtureRoot:f.root,runtimeRoot:f.runtime})
  assert.equal(sdk.importer,await realpath(join(f.session,'lib','index.js')))
  assert.equal(sdk.dependency,await realpath(join(f.llm,'index.js')))
  const r=await runWarmScope({fixtureRoot:f.root,importer:sdk.importer,dependency:'@deepseek-ai/dsh-llm',prepare,perform:adapter()})
  assert.equal(r.status,'passed',JSON.stringify(r))
  assert.deepEqual(r.stages.map(x=>x.stage),['warm','baseline','redirect_prepared','redirect_oracle','redirect','redirect_restored','deny_prepared','deny_oracle','deny','deny_restored'])
  assert.equal(r.cleanup,'passed');await assert.rejects(readFile(f.scope),{code:'ENOENT'})
})

test('missing SDK, external anchor and external SDK entries fail before scope mutation',async t=>{
  for(const layout of ['isolated','hoisted'])for(const options of [{missingSession:true},{missingDependency:true},{escapeAnchor:true},{escapeSession:true},{escapeDependency:true},{externalImporterDependency:true}]){
    const f=await installedRuntime(t,layout,options)
    assert.throws(()=>resolveWarmRuntime({fixtureRoot:f.root,runtimeRoot:f.runtime}),error=>
      options.missingSession||options.missingDependency?['MODULE_NOT_FOUND','SDK_ESCAPE'].includes(error.code):error.code===(options.escapeAnchor?'ANCHOR_ESCAPE':'SDK_ESCAPE'))
    if(!options.missingSession)await assert.rejects(readFile(f.scope),{code:'ENOENT'})
  }
})

test('a different importer dependency route or existing local scope is refused',async t=>{
  for(const layout of ['isolated','hoisted']){
    const mismatch=await installedRuntime(t,layout,{mismatch:true})
    assert.throws(()=>resolveWarmRuntime({fixtureRoot:mismatch.root,runtimeRoot:mismatch.runtime}),{code:'SDK_ROUTE_MISMATCH'})
  }
  const f=await installedRuntime(t,'hoisted')
  await writeFile(f.scope,'owner-data')
  assert.throws(()=>resolveWarmRuntime({fixtureRoot:f.root,runtimeRoot:f.runtime}),{code:'SCOPE_EXISTS'})
  assert.equal(await readFile(f.scope,'utf8'),'owner-data')
  assert.throws(()=>resolveWarmRuntime({fixtureRoot:f.runtime,runtimeRoot:f.root}),{code:'RUNTIME_ESCAPE'})
  assert.throws(()=>resolveWarmRuntime({fixtureRoot:f.root}),{code:'INPUT_INVALID'})
})
