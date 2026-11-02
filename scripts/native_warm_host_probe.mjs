/** Versioned no-model host probe. Loaded by an isolated real DSH host only. */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createProbeAgent, runtimeRequire, startProbeTurn, appendProbeToolCall, finishProbeToolCall } from './native_host_probe.mjs'
import { warmGuardState } from './native_warm_guard_plugin.mjs'
import { runWarmScope } from './native_warm_scope_core.mjs'
export const name='completion-guard-native-warm-scope'
export const inject=['agents','sessions','sessionPersistence','appReady']
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
export function apply(ctx,config) {
  ctx.effect(()=>ctx.appReady.onReady(async()=>{
    const handles=[]; let current='initialize'; let result
    try {
      const state=warmGuardState(config.nonce); assert.ok(state,'wrapper is not loaded')
      const require=runtimeRequire(config.runtimeRoot)
      const {SessionId}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')).href)
      const {createUserMessage,createToolResultMessage,createAssistantMessage}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href)
      const domain=await import(pathToFileURL(join(config.profileRoot,'node_modules','dsh-completion-guard','dist','domain','index.js')).href)
      const digest=sha(readFileSync(config.releaseTgz)); let ordinal=0
      const expectedSri='sha512-'+createHash('sha512').update(readFileSync(config.releaseTgz)).digest('base64')
      assert.equal(config.integrity,expectedSri)
      const registered=['context_guard_checkpoint','context_guard_evidence','context_guard_action','context_guard_release']
      async function makeTicket(label) {
        current='prepare_'+label
        const id=randomBytes(12).toString('hex')
        const handle=await createProbeAgent(ctx,SessionId(`native-warm-${config.nonce}-${id}`),config.workRoot)
        handles.push(handle)
        const agent=handle.agent,session=agent.session
        assert.ok(registered.every(name=>agent.ctx.tools.get(name,agent)),'Guard tools missing')
        const append=(type,data,options)=>session.append(type,data,options)
        startProbeTurn(session)
        append('user/message',createUserMessage({source:{kind:'context-guard',plugin:'context-guard',form:'notice'},content:[{type:'text',text:domain.PROTOCOL_V5_NOTICE}]}),{surfaceOp:'append'})
        append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Create release preparation report.txt'}]}),{surfaceOp:'append'})
        append('command/run',{commandId:`warm-clear-${id}`,name:'context-guard',args:'clear',source:{kind:'user'}})
        assert.equal(await ctx.sessions.flush(session),true)
        const call=async(name,args)=>{
          const callId=`warm-${id}-${++ordinal}`
          const coordinates=appendProbeToolCall(session,createAssistantMessage,callId,name,args)
          const response=await agent.ctx.tools.execute({callId,name,arguments:args,agent,signal:AbortSignal.timeout(120000)})
          append('tool/result',{...coordinates,message:createToolResultMessage({callId,content:response.content,isError:response.isError}),
            ...(response.error?{error:response.error}:{}),...(response.meta?{meta:response.meta}:{})},{surfaceOp:'append'})
          finishProbeToolCall(session,coordinates); assert.equal(await ctx.sessions.flush(session),true)
          assert.equal(response.isError,false,`${name} transport`)
          return {callId,value:response.value}
        }
        current='checkpoint_'+label
        const checkpoint=await call('context_guard_checkpoint',{bindings:[]})
        assert.equal(checkpoint.value.status,'certified','actual checkpoint must certify')
        current='resolution_'+label
        const evidence=await call('context_guard_evidence',{semantic_action:'publish',evidence_role:'resolution',
          selector:{artifact_id:config.packageName,version:config.packageVersion,registry:state.registry},
          command_manifest:{manifest_id:'npm.publish_tgz.v1',tgz_path:config.releaseTgz}})
        assert.equal(evidence.value.status,'supported')
        assert.equal(evidence.value.resolved_target.integrity_digest,expectedSri)
        current='adopt_'+label
        const adopt={contractId:`warm-${id}`,operations:['npm_publish'],candidate:{fullSha40:config.fixtureGitHead,
          repository:'https://github.com/GreenLv/dsh-completion-guard.git',packageId:config.packageName,version:config.packageVersion,
          artifactSha256:digest,artifactSri:expectedSri,registry:state.registry},readinessRefs:[],closureCertRef:'C1'}
        append('command/run',{commandId:`warm-adopt-${id}`,name:'context-guard',args:`release adopt ${JSON.stringify(adopt)}`,source:{kind:'user'}})
        append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:`Publish package ${config.packageName} version ${config.packageVersion} registry ${state.registry}`}]}),{surfaceOp:'append'})
        assert.equal(await ctx.sessions.flush(session),true)
        const projection=domain.deriveProjection(session.snapshotEvents(),{activation:'always',policy:'release'},
          {cwd:config.workRoot},true).projection
        const item=[...projection.items.values()].find(x=>x.status==='pending' && x.semanticAction==='publish')
        assert.ok(item,'publish root obligation missing')
        current='reservation_'+label
        const status=await call('context_guard_release',{operation:'status'})
        assert.ok(!status.value.state_damaged)
        assert.ok(!status.value.reservations.some(row=>row.resolution_call_id===evidence.callId),'resolution already reserved')
        return {id,unconsumed:true,effectCount:state.effectCount(),call,handle,args:{semantic_action:'publish',resolution_call_id:evidence.callId,
          target_digest:evidence.value.target_digest,contract_item_id:item.id,contract_item_revision:item.revision}}
      }
      let baseline
      async function perform(label,ticket) {
        current='action_'+label
        if(label==='baseline') baseline=await makeTicket('baseline')
        const t=ticket??baseline
        const auditBefore=state.auditCount();const answer=await t.call('context_guard_action',t.args);const auditAfter=state.auditCount()
        // Independent same-process readback of the current production graph;
        // it does not replace the Guard action's own counted validation.
        const lock=domain.evaluateActiveHostLock(config.runtimeRoot,config.profileRoot,{
          platform:process.platform==='win32'?'windows':'posix',profileKind:config.profile})
        return {status:answer.value.status,reason_code:answer.value.reason_code??null,effectCount:state.effectCount(),
          ticketId:t.id,auditBefore,auditAfter,lockStatus:lock.status,lockReason:lock.reasonCode??null}
      }
      const stages=[]
      result=await runWarmScope({fixtureRoot:config.fixtureRoot,importer:config.importer,dependency:'@deepseek-ai/dsh-llm',
        prepare:makeTicket,perform,onStage:row=>{stages.push(row);appendFileSync(config.progress,JSON.stringify({nonce:config.nonce,profile:config.profile,...row})+'\n')}})
      if(result.status!=='passed'){current='scope_run';throw Object.assign(new Error('scope run failed'),{scopeResult:result})}
      current='dispose_agents'
      for(const handle of handles) await handle.dispose()
      handles.length=0
      result={schema:'dsh-native-warm-probe/v1',status:'passed',nonce:config.nonce,profile:config.profile,pid:process.pid,
        source_commit:config.sourceCommit,artifact_sha256:config.artifactSha256,driver_sha256:config.driverSha256,
        host_lock_digest:config.hostLockDigest,steps:stages,cleanup:'passed'}
    } catch(error) {
      let cleanup=error?.scopeResult?.cleanup==='failed_preserved'?'failed_preserved':'passed'
      for(const handle of handles)try{await handle.dispose()}catch{cleanup='failed'}
      result={schema:'dsh-native-warm-probe/v1',status:'failed',nonce:config.nonce,profile:config.profile,pid:process.pid,
        source_commit:config.sourceCommit,artifact_sha256:config.artifactSha256,driver_sha256:config.driverSha256,
        failure:{stage:current,type:error?.constructor?.name??'Error',scope:error?.scopeResult?.failure??null},cleanup}
    }
    writeFileSync(config.output+'.tmp',JSON.stringify(result),{flag:'wx'})
    renameSync(config.output+'.tmp',config.output)
  }))
}
