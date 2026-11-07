// Real SDK/headless composition; isolated HOME only, no model or user profile.
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath,pathToFileURL} from 'node:url'
const repository=fileURLToPath(new URL('..',import.meta.url))
const runtime=process.env.DSH_RUNTIME_ROOT

test('headless startup enables real sandbox filesystem and Guard tools', {skip:!runtime,timeout:60000},()=>{
 const root=mkdtempSync(join(tmpdir(),'guard-headless-composition-'))
 try{
  const probe=join(root,'probe.mjs')
  const probeImport=pathToFileURL(join(repository,'scripts/native_host_probe.mjs')).href
  writeFileSync(probe,`import {writeFileSync} from 'node:fs';\nimport {createProbeAgent} from ${JSON.stringify(probeImport)};\nexport const name='isolated-headless-regression'; export const inject=['agents','sessions','appReady'];\nexport function apply(ctx,cfg){ctx.effect(()=>ctx.appReady.onReady(async()=>{const result={startup:!!ctx.get('headlessStartup'),sandboxPolicy:!!ctx.get('sandboxPolicy'),fs:!!ctx.get('fs')};let h;try{h=await createProbeAgent(ctx,'isolated-headless-'+cfg.mode,cfg.work);result.tools=['context_guard_checkpoint','context_guard_observe_test_readiness'].map(name=>!!h.agent.ctx.tools.get(name,h.agent));await h.dispose();result.cleanup='passed'}catch(e){result.error=e?.constructor?.name??'Error';try{await h?.dispose()}catch{result.cleanup='failed'}}writeFileSync(cfg.output,JSON.stringify(result));ctx.get('appExit')(0)}))}\n`)
  const entry=pathToFileURL(join(repository,'dist/index.js')).href
  const cli=join(resolve(runtime),'node_modules','@deepseek-ai','dsh','lib','bin.js')
  for(const enabled of [false,true]){
   const mode=enabled?'enabled':'disabled',work=join(root,mode,'work'),home=join(root,mode,'home'),dsh=join(root,mode,'dsh'),temp=join(root,mode,'temp')
   for(const d of [work,home,dsh,temp])mkdirSync(d,{recursive:true})
   const output=join(root,mode,'result.json'),overlay=join(root,mode,'overlay.json')
   const patches=[{insert:[{id:'headless-diagnostic',name:pathToFileURL(probe).href,config:{mode,work,output}},{id:'context-guard',name:entry,config:{activation:'always'}}]},{id:'goal-round-driver',disabled:true},{id:'headless-runner',disabled:true}]
   if(!enabled)patches.push({id:'headless-startup',disabled:true})
   writeFileSync(overlay,JSON.stringify(patches))
   const env={PATH:process.env.PATH??'',HOME:home,USERPROFILE:home,DSH_HOME:dsh,TMPDIR:temp,TEMP:temp,TMP:temp,DSH_TELEMETRY_DISABLED:'1',DSH_TOOLS_MODE:'native'}
   for(const key of ['SystemRoot','SYSTEMROOT','COMSPEC','PATHEXT','WINDIR'])if(process.env[key])env[key]=process.env[key]
   const child=spawnSync(process.execPath,[cli,'--profile','headless','--patch',overlay,'Context Guard isolated acceptance probe'],{cwd:work,env,encoding:'utf8',timeout:30000})
   assert.equal(child.status,0,`isolated ${mode} process failed`)
   const seen=JSON.parse(readFileSync(output,'utf8'))
   assert.deepEqual(seen,{startup:enabled,sandboxPolicy:enabled,fs:enabled,tools:[enabled,enabled],cleanup:'passed'})
  }
 }finally{rmSync(root,{recursive:true,force:true})}
})
