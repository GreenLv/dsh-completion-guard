// Isolated macOS/POSIX source probe, not a versioned native-artifact annex.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as domain from '../dist/domain/index.js'

test('rc.2 actual local bash terminal, cancellation and Jobs promotion', {timeout:15000,skip: !process.env.DSH_RUNTIME_ROOT || process.platform === 'win32'}, async () => {
  const require = createRequire(realpathSync(join(process.env.DSH_RUNTIME_ROOT, 'node_modules/@deepseek-ai/dsh/package.json')))
  const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/'+name)).href)
  const [{Context},{LocalSubprocessRuntime},{LocalBashExecutor},{LocalJobRegistry},bash,{Session,SessionId},{createToolResultMessage},{AgentRegistry}] = await Promise.all([
    load('cordis'),load('dsh-subprocess-local'),load('dsh-bash-local'),load('dsh-jobs-local'),load('dsh-tool-bash'),load('dsh-session'),load('dsh-llm'),load('dsh-agent'),
  ])
  const ctx = new Context()
  const root = mkdtempSync(join(tmpdir(),'rc2-bash-'))
  new LocalSubprocessRuntime(ctx)
  const config=Object.fromEntries(Object.entries({cwd:root,timeoutMs:5000,maxTimeoutMs:5000,maxOutputBytes:65536,maxSpillBytes:65536,graceMs:100}).map(([k,v])=>[k,{get:()=>v}]))
  const shell=new LocalBashExecutor(ctx,config)
  const jobs=new LocalJobRegistry(ctx,{maxConcurrentJobsPerOwner:10,retainBytes:262144,settledRetainBytes:16384,pumpPollMs:10})
  const controller=jobs.attachController('isolated-shell-probe')
  const session=Session.create(SessionId('real-shell-owner'))
  const agent={id:session.id,session,ctx,status:"idle"}
  const agents=new AgentRegistry(ctx)
  const detach=await agents.register(agent)
  let tool
  // Actual published tool producer/executor; only the registry/prompt seam is controlled.
  const toolCtx={shell, shellEnv:{collect:()=>({})},get:()=>jobs,logger:{warn:message=>{throw new Error(message)}},
    systemPrompt:{section:()=>{},getSectionOrder:()=>0},tools:{register:value=>{tool=value;return ()=>{}}},
    inject:(_names,callback)=>callback({jobs,effect:()=>{}})}
  const outcome=text=>{
    const host={...domain.evaluateHostLock(domain.EXPECTED_HOST_PACKAGES,{platform:'posix',profileKind:'headless'}),auditedForegroundRenderers:['bash']}
    const events=[
      {seq:0,type:'user/message',data:{source:{kind:'context-guard',plugin:'context-guard',form:'notice'},content:[{type:'text',text:domain.PROTOCOL_V6_NOTICE}]}},
      {seq:1,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'Run npm test.'}]}},
      {seq:2,type:'tool/call',data:{callId:'run',name:'bash',arguments:JSON.stringify({command:'npm test',workdir:root})}},
      {seq:3,type:'tool/result',data:{message:createToolResultMessage({callId:'run',content:[{type:'text',text}],isError:false})}},
    ]
    return [...domain.deriveProjection(events,{activation:'always'},{cwd:root},true,host).projection.evidence.values()][0].outcome
  }
  const exec=signal=>({agent,callId:'probe',signal})
  try {
    bash.apply(toolCtx,{enableRunInBackground:false})
    for(const [command,wanted] of [["printf 'PASS\\n'",'success'],["printf 'PASS\\n'; exit 7",'failure']]){
      const args={command,workdir:root,description:"isolated acceptance probe"}
      const value=await tool.execute(args,exec(new AbortController().signal))
      assert.equal(outcome(tool.output.render(args,value).map(p=>p.text).join('\n')),wanted)
    }
    const abort=new AbortController()
    const timer=setTimeout(()=>abort.abort(),30)
    try { await assert.rejects(tool.execute({command:'sleep 2',workdir:root,description:'cancellation probe'},exec(abort.signal))) } finally {clearTimeout(timer)}
    bash.apply(toolCtx,{enableRunInBackground:true,promoteOnTimeout:true})
    const args={command:"printf 'PASS\\n[exit code: 0]\\n'; sleep 1",workdir:root,timeoutMs:300,description:"promotion probe"}
    const value=await tool.execute(args,exec(new AbortController().signal))
    assert.equal(value.kind,'promoted')
    assert.equal(outcome(tool.output.render(args,value).map(p=>p.text).join('\n')),'unknown')
    assert.equal(jobs.get(value.jobId,agent.id).status,'running')
    assert.throws(()=>jobs.get(value.jobId,SessionId('foreign')))
    await new Promise(resolve=>setTimeout(resolve,1200))
    assert.equal(jobs.get(value.jobId,agent.id).status,'completed')
    // Completion in Jobs does not upgrade the old partial call's evidence.
    assert.equal(outcome(tool.output.render(args,value).map(p=>p.text).join('\n')),'unknown')
  } finally {await detach();controller();await ctx.fiber.dispose();rmSync(root,{recursive:true,force:true})}
})

test('native probe framing survives the actual rc.2 V4 relationship reader', {skip:!process.env.DSH_RUNTIME_ROOT}, async () => {
  const require=createRequire(realpathSync(join(process.env.DSH_RUNTIME_ROOT,'node_modules/@deepseek-ai/dsh/package.json')))
  const load=name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)).href)
  const [{Session,SessionId,KNOWN_SESSION_EVENT_TYPES},{createAssistantMessage,createUserMessage,createToolResultMessage},format,probe]=await Promise.all([
    load('dsh-session'),load('dsh-llm'),load('dsh-session-format-v3-to-v4'),import('../scripts/native_host_probe.mjs'),
  ])
  const session=Session.create(SessionId('probe-framing'),undefined,{version:4,id:SessionId('probe-framing'),isSeeded:false,createdAt:1,delegationDepth:0})
  for(let i=0;i<2;i++){
    probe.startProbeTurn(session)
    session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Inspect fixture.'}]}),{surfaceOp:'append'})
    const coordinates=probe.appendProbeToolCall(session,createAssistantMessage,`call-${i}`,'read',{file_path:'/fixture'})
    session.append('tool/result',{...coordinates,message:createToolResultMessage({callId:`call-${i}`,content:[{type:'text',text:'fixture'}],isError:false})},{surfaceOp:'append'})
    probe.finishProbeToolCall(session,coordinates)
  }
  probe.appendProbeCompaction(session,'fixture-compact')
  const artifact={header:session.header,inheritedEventCount:0,events:session.snapshotEvents()}
  assert.doesNotThrow(()=>format.restoreReleasedV4Artifact(artifact,KNOWN_SESSION_EVENT_TYPES))
  const broken={...artifact,events:artifact.events.filter(e=>e.type!=='assistant/message').map((e,seq)=>({...e,seq}))}
  assert.throws(()=>format.assertReleasedV4Relationships(broken,KNOWN_SESSION_EVENT_TYPES),/advertised tool lifecycle/)
})
