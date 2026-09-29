import { hostNodeConditions } from './host-node-conditions.js'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const HOST_CONTRACT_SCHEMA: 'guard-host-contract/v2' = 'guard-host-contract/v2'
export const HOST_CONTRACT_CONSUMERS = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-commands', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session-persistence', '@deepseek-ai/dsh-session-persistence-jsonl', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-goal', '@deepseek-ai/dsh-tool-goal'] as const
export interface ProbeArchive { name: string; files: Record<string, Buffer> }
export interface HostContractProbeResult { schema: typeof HOST_CONTRACT_SCHEMA; checks: string[]; failures: string[] }
/** The trusted driver is isolated from downloaded code. No host app, provider,
 * install script, user profile or credential is present in this process. */
const DRIVER = String.raw`
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports, createRequire } from 'node:module';
import dgram from 'node:dgram'; import http2 from 'node:http2';
import net from 'node:net'; import tls from 'node:tls'; import http from 'node:http'; import https from 'node:https'; import dns from 'node:dns';
const dnsPrototypes=[dns.Resolver.prototype,dns.promises.Resolver.prototype];
const deny=()=>{throw new Error('host_contract_probe_network_denied')};
for(const [module,keys] of [[net,['connect','createConnection','createServer']],[tls,['connect','createServer']],[http,['request','get','createServer']],[https,['request','get','createServer']],[dns,['lookup','resolve']]])for(const key of keys)module[key]=deny;
for(const key of Object.keys(dns.promises))if(typeof dns.promises[key]==='function')dns.promises[key]=deny;
net.Socket.prototype.connect=deny;net.Server.prototype.listen=deny;dgram.createSocket=deny;http2.connect=deny;
for(const prototype of dnsPrototypes)for(const key of Object.getOwnPropertyNames(prototype))if(key!=='constructor'&&typeof prototype[key]==='function'&&/^(resolve|reverse)/.test(key))prototype[key]=deny;
globalThis.fetch=deny; globalThis.WebSocket=undefined; syncBuiltinESMExports();
const spec=JSON.parse(readFileSync(join(process.cwd(),'probe.json'),'utf8'));
const checks=[],failures=[];const check=(id,value)=>{if(!value)throw new Error(id);checks.push(id)};
const require=createRequire(import.meta.url);
const load=(name)=>spec.lane==='require'?Promise.resolve(require(name)):import(name);
for(const name of spec.targets){try{const required=realpathSync(require.resolve(name)),imported=realpathSync(fileURLToPath(import.meta.resolve(name)));check('loading.dual_route:'+name,required===imported)}catch{failures.push('host_contract_entry_incompatible:'+name)}}
if(spec.lane==='resolve')checks.push('loading.require.behavior_unavailable');else checks.push('loading.'+spec.lane+'.behavior');
for(const name of spec.lane==='resolve'?[]:spec.targets){
 let behavior=false;
 try{
  const m=await load(name);
  if(name==='@deepseek-ai/dsh-session'){
   check('session.api',m.SESSION_FORMAT_VERSION===4&&typeof m.Session?.create==='function'&&typeof m.Session?.fromRestore==='function'&&typeof m.buildForkSeed==='function'&&typeof m.interruptedTurnClosers==='function'&&typeof m.SessionStore?.prototype.flush==='function');
   const cordis=await load('@deepseek-ai/cordis');const ctx=new cordis.Context();const store=new m.SessionStore(ctx);const live=store.create('contract-live',{meta:{cwd:process.cwd()}});
   check('session.flush_empty',await store.flush(live)===false);let delivery;ctx.on('session/event',(s,e)=>{delivery={s,e,committed:s.eventAt(e.seq)}});
   live.append('user/message',{id:'live-message',role:'user',source:{kind:'user'},content:[{type:'text',text:'live'}]},{surfaceOp:'append'});check('session.event_delivery',delivery?.s===live&&delivery?.e===delivery?.committed&&delivery.e.seq===0&&Object.isFrozen(delivery.e));
   let flushed=false;const off=ctx.on('session/flush',async()=>{await Promise.resolve();flushed=true});check('session.flush_awaited',await store.flush(live)===true&&flushed);off();
   const offFail=ctx.on('session/flush',()=>{throw new Error('fixture_flush_failure')});let failed=false;try{await store.flush(live)}catch{failed=true}check('session.flush_failure',failed);offFail();
   const header={version:4,isSeeded:false,id:'contract-session',createdAt:1,cwd:'/probe'};
   const session=m.Session.create('contract-session',undefined,header);
   check('session.empty',session.seq===0&&Array.isArray(session.snapshotEvents())&&session.snapshotEvents().length===0);
   const data={id:'contract-message',role:'user',source:{kind:'context-guard',plugin:'context-guard',form:'notice'},content:[{type:'text',text:'probe'}]};
   session.append('user/message',data,{surfaceOp:'append'});const first=session.snapshotEvents();
   check('session.envelope',first.length===1&&first[0].seq===0&&first[0].type==='user/message'&&session.eventAt(0)===first[0]);
   check('session.immutable',Object.isFrozen(first)&&Object.isFrozen(first[0])&&Object.isFrozen(first[0].data));
   data.content[0].text='changed';session.append('user/message',{...data,id:'contract-message-2',content:[{type:'text',text:'second'}]},{surfaceOp:'append'});
   check('session.stable',first.length===1&&first[0].data.content[0].text==='probe'&&session.snapshotEvents().length===2&&session.snapshotEvents()[1].seq===1);
   const seed=JSON.parse(JSON.stringify(first));const seeded=m.Session.create('contract-seeded',seed);
   check('session.seed_immutable',Object.isFrozen(seeded.eventAt(0))&&Object.isFrozen(seeded.eventAt(0).data));
   seed[0].data.content[0].text='mutated';check('session.seed_detached',seeded.eventAt(0).data.content[0].text==='probe');
   const restored=m.Session.fromRestore('contract-session',first,session.header,0,'shared-frozen');check('session.restore_preserved',restored.seq===2&&restored.eventAt(1).type==='session/end-seed'&&restored.eventAt(0).data.content[0].text==='probe');
   let refused=false;try{m.Session.fromRestore('contract-session',[{...first[0],seq:2}],header,0,'snapshot')}catch{refused=true}
   check('session.restore_gap',refused);
   const open=[{type:'turn/start',seq:0,time:1,data:{turn:1}},{type:'step/start',seq:1,time:1,data:{turn:1,step:1}},{type:'assistant/message',seq:2,time:1,data:{turn:1,step:1,message:{content:[{type:'tool-call',id:'effect',name:'effect_probe',arguments:{}}]}}},{type:'tool/call',seq:3,time:1,data:{turn:1,step:1,callId:'effect'}}];
   for(const [label,events]of[['restore',m.interruptedTurnClosers(open)],['fork',m.buildForkSeed(open,3)]]){
    const result=events.find(e=>e.type==='tool/result');check('session.'+label+'_unknown',result?.data?.message?.isError===true&&result?.data?.error?.name==='ToolOutcomeUnknownError'&&result?.data?.message?.content?.some(c=>typeof c.text==='string'&&c.text.length>0));
    check('session.'+label+'_balanced',events.some(e=>e.type==='step/end')&&events.some(e=>e.type==='turn/end'));
    if(label==='fork')check('session.fork_prefix',open.every((e,i)=>JSON.stringify(events[i])===JSON.stringify(e)));
    check('session.'+label+'_contiguous',events.every((e,i)=>e.seq===(label==='fork'?0:open.length)+i));
   }
  }else{
   const roles={
    '@deepseek-ai/cordis':['Context'],
    '@deepseek-ai/dsh-agent':['AgentRegistry'],
    '@deepseek-ai/dsh-agent-loop':['AgentLoop'],
    '@deepseek-ai/dsh-tools':['ToolRuntime','defineTool','validateArgs','validateJsonSchemaValue'],
    '@deepseek-ai/dsh-commands':['CommandRuntime'],
    '@deepseek-ai/dsh-llm':['createUserMessage','createToolResultMessage'],
    '@deepseek-ai/dsh-session-persistence':['SessionPersistence','validateStoredEvents'],
    '@deepseek-ai/dsh-session-persistence-jsonl':['default'],
    '@deepseek-ai/dsh-session-projection':['SessionProjectionRegistry'],
    '@deepseek-ai/dsh-goal':['GoalService','decodeGoalChange'],
    '@deepseek-ai/dsh-tool-goal':['apply'],
   };
   const methods={
    '@deepseek-ai/dsh-agent':{AgentRegistry:['create']},
    '@deepseek-ai/dsh-agent-loop':{AgentLoop:['create','resume','createAgent']},
    '@deepseek-ai/dsh-tools':{ToolRuntime:['register','guard','schemas','prepareExecution','execute']},
    '@deepseek-ai/dsh-commands':{CommandRuntime:['register']},
   };
   const required=roles[name];check(name+'.api',required?required.every(k=>typeof m[k]==='function'):typeof m.apply==='function'||typeof m.default==='function');
   for(const [cls,names]of Object.entries(methods[name]??{}))for(const method of names)check(name+'.'+method,typeof m[cls].prototype[method]==='function');
   behavior=true;
   if(name==='@deepseek-ai/dsh-agent-loop'){
    const cordis=await load('@deepseek-ai/cordis'),agents=await load('@deepseek-ai/dsh-agent'),sessions=await load('@deepseek-ai/dsh-session'),projection=await load('@deepseek-ai/dsh-session-projection'),prompt=await load('@deepseek-ai/dsh-system-prompt'),tools=await load('@deepseek-ai/dsh-tools'),llm=await load('@deepseek-ai/dsh-llm');
    // The persistence edge is a confined memory fixture. The created Agents,
    // event producer, registered resume/fork and recovery semantics are real.
    const logs=new Map();let effects=0;
    const handle=(data)=>({header:data.header,inheritedEventCount:data.inheritedEventCount,read:async()=>({events:data.events.slice(),eventState:'shared-frozen'}),append:async(events)=>{for(const e of events){if(e.seq!==data.events.length)throw new Error('fixture_noncontiguous');data.events.push(e)}},flush:async()=>{},close:async()=>{}});
    const compose=(producer=false)=>{
     const ctx=new cordis.Context();new agents.AgentRegistry(ctx);new projection.SessionProjectionRegistry(ctx);new prompt.SystemPrompt(ctx,{includeHarnessIdentity:false,includeRuntimeContext:false,personaPrefix:'',personaSuffix:''});new tools.ToolRuntime(ctx,{});new sessions.SessionStore(ctx);
     ctx.provide('sessionPersistence',{create:async(header,options)=>{const data={header,inheritedEventCount:options.inheritedEventCount,events:[]};logs.set(header.id,data);return handle(data)},open:async(id)=>handle(logs.get(id))});
     ctx.on('session/event',(session,event)=>{const data=logs.get(session.id);if(data){if(event.seq!==data.events.length)throw new Error('fixture_noncontiguous');data.events.push(event)}});ctx.on('session/flush',async()=>{});
     let streams=0;ctx.provide('llm',{prepareCall:async(config)=>({config,retryPolicy:{maxAttempts:1},stream:()=>{if(!producer||++streams!==1)throw new Error('fixture_no_model');return(async function*(){yield{type:'text-delta',index:0,text:'probe'};yield{type:'tool-call-delta',index:1,id:'loop-effect',name:'loop_effect',argumentsDelta:'{}'};yield{type:'block-end',index:1,block:{type:'tool-call',id:'loop-effect',name:'loop_effect',arguments:'{}'}};yield{type:'finish',reason:'tool_calls'}})()}})});
     ctx.tools.register(tools.defineTool({name:'loop_effect',description:'bounded fixture effect',parameters:{},output:{schema:{type:'object',properties:{status:{type:'string',required:true}},additionalProperties:false},render:()=>[{type:'text',text:'ok'}]},execute:async()=>{effects++;return new Promise(()=>{})}}));
     new m.AgentLoop(ctx,{agents:[],maxParallelToolCalls:{get:()=>1}});return ctx;
    };
    const first=compose(true);let initialized=false;first.on('agent/created',async()=>{await new Promise(resolve=>setTimeout(resolve,10));initialized=true});const agent=await first.agentLoop.create('loop-source',{provider:'fixture',model:'fixture-model'},{cwd:process.cwd()});check('loop.created',initialized&&agent?.id==='loop-source'&&first.agents.get(agent.id)===agent);
    agent.followup(llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text:'probe'}]}));agent.wakeDriver();
    for(let tries=0;tries<100&&(!agent.session.snapshotEvents().some(e=>e.type==='tool/call')||effects!==1);tries++)await new Promise(resolve=>setTimeout(resolve,5));
    const open=agent.session.snapshotEvents();const boundary=open.findLastIndex(e=>e.type==='tool/call');check('loop.open_effect',boundary>=0&&effects===1&&!open.some(e=>e.type==='tool/result'));
    const unknown=(events,kind)=>events.some(e=>e.type==='tool/result'&&e.data.error?.name==='ToolOutcomeUnknownError'&&e.data.message.isError===true&&e.data.message.content.some(c=>typeof c.text==='string'&&c.text.length>0))&&events.some(e=>e.type==='turn/end'&&e.data.reason?.kind===kind)&&events.every((e,i)=>e.seq===i);
    const resumedCtx=compose();const resumed=await resumedCtx.agentLoop.resume(resumedCtx,{resumeSessionId:'loop-source',agentOptions:{provider:'fixture',model:'fixture-model'}});check('loop.resume_unknown',unknown(resumed?.agent.session.snapshotEvents()??[],'interrupted')&&effects===1);await resumed.dispose();
    const forkCtx=compose();const seed=sessions.buildForkSeed(open,boundary);const fork=await forkCtx.agentLoop.createAgent(forkCtx,{sessionId:'loop-fork',seed,meta:{version:4,isSeeded:true,createdAt:2,cwd:process.cwd()},inheritedEventCount:boundary+1,agentOptions:{provider:'fixture',model:'fixture-model'}});check('loop.fork_unknown',unknown(fork?.agent.session.snapshotEvents()??[],'forked')&&effects===1);await fork.dispose();
   }
   if(name==='@deepseek-ai/dsh-agent'){
    const cordis=await load('@deepseek-ai/cordis'),sessions=await load('@deepseek-ai/dsh-session'),scope=await load('@deepseek-ai/dsh-scope');const ctx=new cordis.Context();const registry=new m.AgentRegistry(ctx);const store=new sessions.SessionStore(ctx);const session=store.create('contract-agent');const agent={id:session.id,session,ctx,status:'idle',steer:()=>{}};agent.ctx=scope.createScope(ctx,agent).ctx;let initialized=false;ctx.on('agent/created',async()=>{await new Promise(resolve=>setTimeout(resolve,10));initialized=true});const dispose=await registry.register(agent);check('agent.awaited_created',initialized&&registry.get(agent.id)===agent);dispose();check('agent.disposal',registry.get(agent.id)===undefined);
   }
   if(name==='@deepseek-ai/dsh-tools'){
    const cordis=await load('@deepseek-ai/cordis'),prompt=await load('@deepseek-ai/dsh-system-prompt'),sessions=await load('@deepseek-ai/dsh-session');const ctx=new cordis.Context();new prompt.SystemPrompt(ctx,{});const runtime=new m.ToolRuntime(ctx,{});const agent={id:'contract-tools',session:sessions.Session.create('contract-tools'),ctx};let effects=0;const unregister=runtime.register(m.defineTool({name:'contract_effect',description:'confined effect counter',parameters:{},output:{schema:{type:'object',properties:{status:{type:'string',required:true}},additionalProperties:false},render:()=>[{type:'text',text:'ok'}]},execute:async()=>{effects++;return {status:'ok'}}}));
    const input=(id)=>({agent,callId:id,name:'contract_effect',arguments:{},signal:new AbortController().signal});check('tools.normal_execution',(await runtime.execute(input('normal'))).isError===false&&effects===1);
    const dispose=runtime.guard(()=> 'contract-denied');const harmless=runtime.guard(()=>undefined);const off=ctx.on('tools/pre-execute',async()=>{await Promise.resolve();return {kind:'allow'}});
    const prepared=await runtime.prepareExecution(input('prepared-denial'),value=>value);check('tools.prepare_denial',prepared.kind!=='dispatch'&&prepared.result?.isError===true&&effects===1);check('tools.guard_denial',(await runtime.execute(input('denied'))).isError===true&&effects===1);off();harmless();dispose();
    check('tools.guard_disposal',(await runtime.execute(input('after-dispose'))).isError===false&&effects===2);unregister();check('tools.registration_disposal',(await runtime.execute(input('unregistered'))).isError===true&&effects===2);
    check('tools.valid_schema_value',m.validateJsonSchemaValue({type:'string'},'probe').length===0);check('tools.invalid_schema_value',m.validateJsonSchemaValue({type:'string'},12).length>0);
   }
   if(name==='@deepseek-ai/cordis'){
    const ctx=new m.Context();let count=0;const dispose=ctx.on('contract-probe',async()=>{await Promise.resolve();count++});await ctx.parallel('contract-probe');check('cordis.awaited_event',count===1);dispose();await ctx.parallel('contract-probe');check('cordis.disposal',count===1);
   }
   if(name==='@deepseek-ai/dsh-llm'){
    const u=m.createUserMessage({source:{kind:'user'},content:[{type:'text',text:'probe'}]});check('llm.user',u.role==='user'&&u.content[0].text==='probe');
    const t=m.createToolResultMessage({callId:'probe',isError:true,content:[{type:'text',text:'unknown'}]});check('llm.error',t.role==='tool'&&t.isError===true&&t.toolCallId==='probe');
   }
  }
 }catch{failures.push(name==='@deepseek-ai/dsh-session'?'host_contract_session_incompatible':name.startsWith('@deepseek-ai/dsh-goal')||name==='@deepseek-ai/dsh-tool-goal'?'host_contract_goal_qualification_required':(behavior?'host_contract_behavior_incompatible:':'host_contract_api_incompatible:')+name)}
}
console.log('DSH_CONTRACT_RESULT='+JSON.stringify({schema:'guard-host-contract/v2',checks:checks.sort(),failures:failures.sort()}));
`

export function runHostContractProbe(archives: readonly ProbeArchive[], targets: readonly string[]): HostContractProbeResult {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'guard-host-contract-')))
  try {
    for (const archive of archives) for (const [file, content] of Object.entries(archive.files)) {
      if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(archive.name)
        || file.startsWith('/') || file.includes('\\') || file.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('host_contract_probe_archive_invalid')
      const path = join(root, 'node_modules', archive.name, file)
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content)
    }
    writeFileSync(join(root, 'probe.mjs'), DRIVER)
    const env: Record<string, string> = {}
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot
    const conditions = hostNodeConditions()
    const combined: HostContractProbeResult = { schema: HOST_CONTRACT_SCHEMA, checks: [], failures: [] }
    // Separate processes avoid cross-lane module-cache or prototype mutations.
    for (const lane of ['import', conditions.requireModule ? 'require' : 'resolve']) {
      writeFileSync(join(root, 'probe.json'), JSON.stringify({ targets, lane }))
      const child = spawnSync(process.execPath, [...conditions.childArgs, process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission', `--allow-fs-read=${root}`, join(root, 'probe.mjs')], {
        cwd: root, env, encoding: 'utf8', timeout: 20_000, maxBuffer: 128 * 1024, windowsHide: true,
      })
      const line = child.stdout?.trim().split('\n').at(-1)
      if (child.status !== 0 || child.error || !line?.startsWith('DSH_CONTRACT_RESULT=')) throw new Error('host_contract_probe_isolation_unavailable')
      const result = JSON.parse(line.slice('DSH_CONTRACT_RESULT='.length)) as HostContractProbeResult
      if (result.schema !== HOST_CONTRACT_SCHEMA || !Array.isArray(result.checks) || !Array.isArray(result.failures)) throw new Error('host_contract_probe_result_invalid')
      combined.checks.push(...result.checks, ...result.checks.map(check => 'lane:' + lane + ':' + check)); combined.failures.push(...result.failures)
    }
    combined.checks = [...new Set(combined.checks)].sort()
    combined.failures = [...new Set(combined.failures)].sort()
    return combined
  } finally { rmSync(root, { recursive: true, force: true }) }
}
