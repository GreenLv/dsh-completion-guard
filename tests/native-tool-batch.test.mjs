import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import { Session, SessionId, KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const require = createRequire(import.meta.url)
const backendRequire = createRequire(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl'))
const { restoreReleasedV4Artifact } = await import(pathToFileURL(backendRequire.resolve('@deepseek-ai/dsh-session-format-v3-to-v4')).href)
import { privateStorageToolDenial } from '../src/domain/private-storage-guard.js'
import { startProbeTurn, appendProbeToolStep, executeProbeTool, finishProbeToolCall } from '../scripts/native_host_probe.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const live=[]
afterEach(async()=>{while(live.length) await live.pop().fiber.dispose()})
function fixture() {
 const ctx=new Context(); live.push(ctx); new SystemPrompt(ctx,{})
 const runtime=new ToolRuntime(ctx); runtime.setExecutor(new NativeToolExecutor(ctx))
 const id=SessionId('native-batch-regression');const session=Session.create(id,undefined,{version:4,id,isSeeded:false,createdAt:1,delegationDepth:0})
 const agent={session,ctx};let effects=0
 runtime.register({name:'write',description:'guarded effect',parameters:{type:'object',properties:{file_path:{type:'string'}},required:['file_path']},
  output:{schema:{type:'object',properties:{status:{type:'string'}},required:['status']},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
  execute:async()=>{effects++;return {status:'executed'}}})
 return {ctx,runtime,session,agent,effects:()=>effects}
}
function step(f,id,args) {
 startProbeTurn(f.session)
 f.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Run a probe.'}]}),{surfaceOp:'append'})
 return appendProbeToolStep(f.session,createAssistantMessage,id,'write',args)
}

describe('native SDK batch probe',()=>{
 it('reproduces the old SDK call shape failing before any tool effect',async()=>{
  const f=fixture(),agent=f.agent
  let caught
  try {await f.runtime.execute({callId:'old',name:'write',arguments:{file_path:'/tmp/x'},agent,signal:new AbortController().signal})} catch(error){caught=error}
  expect(caught?.name).toBe('ToolBatchExecutionError'); expect(caught?.cause?.message).toMatch(/map/);expect(f.effects()).toBe(0)
 })
 it('commits exactly one real SDK call and result and V4 reader accepts the framed session',async()=>{
  const f=fixture(),args={file_path:join(tmpdir(),'public-probe')},coords=step(f,'real-call',args)
  const result=await executeProbeTool(f.agent,coords,'real-call','write',args,new AbortController().signal)
  finishProbeToolCall(f.session,coords)
  expect(result.isError).toBe(false);expect(result.value).toEqual({status:'executed'});expect(f.effects()).toBe(1)
  const events=f.session.snapshotEvents(), calls=events.filter(e=>e.type==='tool/call'), results=events.filter(e=>e.type==='tool/result')
  expect(calls).toHaveLength(1);expect(results).toHaveLength(1)
  expect(calls[0].data).toMatchObject({callId:'real-call',name:'write',arguments:JSON.stringify(args)})
  expect(results[0].data.message).toMatchObject({source:{kind:'tool',callId:'real-call'},toolCallId:'real-call',isError:false})
  const oldPredicate = (event, id) => event.type === 'tool/result' && event.data?.message?.source?.callId === id
  const newPredicate = (event, id) => event.type === 'tool/result' && event.data?.message?.toolCallId === id
  expect(oldPredicate(results[0], 'real-call')).toBe(true)
  expect(newPredicate(results[0], 'real-call')).toBe(true)
  expect(oldPredicate(results[0], 'wrong-call')).toBe(false)
  expect(newPredicate(results[0], 'wrong-call')).toBe(false)
  expect(results[0].sourceEventSeqs).toEqual([calls[0].seq])
  expect(()=>restoreReleasedV4Artifact({header:f.session.header,inheritedEventCount:0,events},KNOWN_SESSION_EVENT_TYPES)).not.toThrow()
 })
 it('uses the real Guard private-storage refusal in the SDK pipeline without executing the effect',async()=>{
  const f=fixture(),privateRoot=join(tmpdir(),'guard-private'),args={file_path:join(privateRoot,'binding.json')}
  f.runtime.guard(exec=>privateStorageToolDenial(exec.name,exec.arguments,undefined,[privateRoot]))
  const coords=step(f,'denied',args),result=await executeProbeTool(f.agent,coords,'denied','write',args,new AbortController().signal)
  finishProbeToolCall(f.session,coords)
  expect(result.isError).toBe(true);expect(result.content.map(x=>x.text).join('')).toContain('activation_private_storage_protected');expect(f.effects()).toBe(0)
  const events=f.session.snapshotEvents(),calls=events.filter(e=>e.type==='tool/call'),results=events.filter(e=>e.type==='tool/result')
  expect(calls).toHaveLength(1);expect(results).toHaveLength(1);expect(results[0].data.message.isError).toBe(true)
  expect(results[0].sourceEventSeqs).toEqual([calls[0].seq])
  expect(()=>restoreReleasedV4Artifact({header:f.session.header,inheritedEventCount:0,events},KNOWN_SESSION_EVENT_TYPES)).not.toThrow()
 })
 it.each([
  {name:'missing settlement',results:[]},
  {name:'multiple settlements',results:[{callId:'x',result:{isError:false,content:[]}},{callId:'x',result:{isError:false,content:[]}}]},
  {name:'wrong identity',results:[{callId:'other',result:{isError:false,content:[]}}]},
  {name:'missing result payload',results:[{callId:'x'}]},
 ])('refuses $name',async row=>{
  const batch={results:row.results,additionalContexts:[],concluded:false};const agent={ctx:{tools:{execute:async input=>{expect(input.calls).toEqual([{type:'tool-call',id:'x',name:'write',arguments:'{}'}]);expect(input.log).toEqual({turn:1,step:1});return batch}}}}
  await expect(executeProbeTool(agent,{turn:1,step:1},'x','write',{},new AbortController().signal)).rejects.toThrow()
 })
 it.each([{additionalContexts:[{}],concluded:false},{additionalContexts:[],concluded:true}])('refuses to discard contexts or turn conclusion',async rest=>{
  const agent={ctx:{tools:{execute:async()=>({results:[{callId:'x',result:{isError:false,content:[]}}],...rest})}}}
  await expect(executeProbeTool(agent,{turn:1,step:1},'x','write',{},new AbortController().signal)).rejects.toThrow(/discard/)
 })
})
