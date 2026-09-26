import { it, expect } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { createProjection } from '../../src/domain/types.js'
import { normalizeReleaseContract, releasePreEffectDecision, RELEASE_RESERVATION_PREFIX, RELEASE_SETTLEMENT_PREFIX } from '../../src/domain/release.js'
import { createProofManifestV2, bindProofV2ToProjection } from '../../src/domain/proof.js'
import { deriveTrustedDeliveries } from '../../src/domain/delivery.js'
import { currentUnitHasOpenWork, opensNewUnit, explicitlyLinkedToCurrentUnit } from '../../src/domain/work-unit.js'
import { certificateClosure } from '../../src/domain/closure.js'
import { createCheckpointTool } from '../../src/tools/checkpoint.js'
import { createContextGuardCommand } from '../../src/commands/context-guard.js'

const sha='a'.repeat(40), digest='b'.repeat(64)
const config={activation:'always' as const}
const scope={cwd:'/repo',sessionHeader:{version:3,id:'review',createdAt:1}}
const contract={contractId:'rel',operations:['npm_publish'],candidate:{repository:'repo-A',ref:'refs/heads/main',fullSha40:sha,version:'0.6.0',artifactDigest:digest},readinessRefs:['nonexistent']}
const notice=(seq:number,text:string)=>({seq,type:'user/message',data:{source:{kind:'plugin',plugin:'context-guard',form:'notice'},content:[{type:'text',text}]}})
const base=()=>[notice(0,PROTOCOL_V5_NOTICE),{seq:1,type:'command/run',data:{name:'context-guard',args:`release adopt ${JSON.stringify(contract)}`,source:{kind:'user'}}}]
const req={operation:'npm_publish' as const,observed:{fullSha40:sha,version:'0.6.0',artifactSha256:digest},resolvedTarget:{artifact_id:'unrelated-package',version:'0.6.0',registry:'https://other.invalid'}}

/**
 * R1 (corrected expectation, 0.6.0 repair).
 *
 * The reviewer's probe asserted that a contract carrying a 64-hex
 * `artifactDigest` must GRANT when the request carries an npm `sha512-...` SRI
 * under the same field name. Those are two different identities, and granting
 * on that pair is exactly the conflation F04 asks to remove, so the literal
 * expectation is not satisfiable by a design that really binds the bytes.
 * The requirement underneath it — a legitimate release bound to the real
 * artifact must be grantable, and a mismatched identity must be refused — is
 * asserted here in the corrected typed shape, and positively in
 * tests/domain/v060-release-migration.test.ts and tests/tools/evidence.test.ts.
 */
it('R1: a SHA-256 contract is never granted on an SRI, and each identity is compared with its own kind',()=>{
 const p=deriveProjection(base(),config,scope,true).projection
 // The legacy alias is split by KIND instead of compared across kinds.
 const asSha=normalizeReleaseContract({...contract,candidate:{fullSha40:sha,artifactDigest:digest}},{seq:1,digest:'x'})
 const asSri=normalizeReleaseContract({...contract,candidate:{fullSha40:sha,artifactDigest:'sha512-'+Buffer.alloc(64).toString('base64')}},{seq:1,digest:'x'})
 expect(asSha.contract?.candidate.artifactSha256).toBe(digest)
 expect(asSha.contract?.candidate.artifactSri).toBeUndefined()
 expect(asSri.contract?.candidate.artifactSri).toBe('sha512-'+Buffer.alloc(64).toString('base64'))
 expect(asSri.contract?.candidate.artifactSha256).toBeUndefined()
 // The contract here names a SHA-256; a producer that cannot observe one is
 // refused instead of being compared against a different identity.
 const actual=releasePreEffectDecision(p,{...req,observed:{...req.observed,artifactSri:'sha512-'+Buffer.alloc(64).toString('base64')}})
 console.log('R1',actual)
 expect(actual.status).toBe('denied')
})
it('R2: missing observed repository/ref and invented readiness must not grant',()=>{
 const p=deriveProjection(base(),config,scope,true).projection
 const actual=releasePreEffectDecision(p,req)
 console.log('R2',actual)
 expect(actual.status).toBe('denied')
})
it('R3: failed with no readback must retain unknown-effect reservation',()=>{
 const record={contractId:'rel',operation:'npm_publish',callId:'res-1'}
 const p=deriveProjection([...base(),notice(2,RELEASE_RESERVATION_PREFIX+JSON.stringify({...record,startedAtSeq:2,status:'in_flight'})),notice(3,RELEASE_SETTLEMENT_PREFIX+JSON.stringify({...record,settledAtSeq:3,outcome:'failed',readback:'unavailable'}))],config,scope,true).projection
 expect(releasePreEffectDecision(p,req).status).toBe('denied')
})
it('R4: readback settlement can reconcile an earlier unconfirmed record',()=>{
 const record={contractId:'rel',operation:'npm_publish',callId:'res-1'}
 const p=deriveProjection([...base(),notice(2,RELEASE_RESERVATION_PREFIX+JSON.stringify({...record,startedAtSeq:2,status:'in_flight'})),notice(3,RELEASE_SETTLEMENT_PREFIX+JSON.stringify({...record,settledAtSeq:3,outcome:'unconfirmed',readback:'unavailable'})),notice(4,RELEASE_SETTLEMENT_PREFIX+JSON.stringify({...record,settledAtSeq:4,outcome:'settled',readback:{kind:'npm_integrity',identity:digest}}))],config,scope,true).projection
 expect(releasePreEffectDecision(p,req).reasonCode).toBe('release_operation_consumed')
})
it('R5: fact and manifest about B cannot discharge item asking A',()=>{
 const p=createProjection()
 p.items.set('R001',{id:'R001',status:'pending',verification:{enforced:true,surface:'artifact',subject:'/repo/A'},requestedTarget:{scope:'/repo/A'}} as any)
 p.evidence.set('E0001',{id:'E0001',epoch:p.epoch,toolName:'read',outcome:'success',subjects:['/repo/B'],capabilities:['filesystem-read'],operations:[{op:'read',path:'/repo/B'}],surfaces:['artifact'],evidenceRole:'state'} as any)
 const m=createProofManifestV2([{obligationId:'R001',kind:'subject_readback',surface:'artifact',subjectIds:['/repo/B'],sourceIds:['read'],operation:'read',evidenceIds:['E0001']}])
 expect(bindProofV2ToProjection(p,m).length).toBeGreaterThan(0)
})
it('R6: pending child prevents implicit switch after parent finishes',()=>{
 const p=createProjection();p.boundaryProtocol=5;p.currentUnitId='U001'
 p.units.set('U001',{unitId:'U001',openedAtSeq:1,rootInputRefs:[],headline:'parent'})
 p.units.set('U002',{unitId:'U002',parentUnitId:'U001',openedAtSeq:2,rootInputRefs:[],headline:'child'})
 p.items.set('R001',{id:'R001',unitId:'U001',status:'passed',kind:'requirement'} as any)
 p.items.set('R002',{id:'R002',unitId:'U002',status:'pending',kind:'requirement'} as any)
 expect(certificateClosure(p).itemIds).toContain('R002')
 expect(opensNewUnit(p,'继续检查文档',true,currentUnitHasOpenWork(p))).toBe(false)
})
it('R7: assistant text arriving after completed end is not delivery',()=>{
 expect(deriveTrustedDeliveries([{seq:1,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}},{seq:2,type:'assistant/message',data:{turn:1,step:1,message:{content:[{type:'text',text:'late'}]}}}])).toEqual([])
})
it('R8: earlier assistant is not final when host has a later step',()=>{
 expect(deriveTrustedDeliveries([{seq:1,type:'assistant/message',data:{turn:1,step:1,message:{content:[{type:'text',text:'intermediate'}]}}},{seq:2,type:'step/start',data:{turn:1,step:2}},{seq:3,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}])).toEqual([])
})
it('R9: a certified answered inquiry must survive checkpoint replay',async()=>{
 // 0.6.1: an explanation request is an unresolved clause until the model
 // records its interpretation through the structured pathway; the recorded
 // fact plus this turn's delivery closes it.
 const events:any[]=[notice(0,PROTOCOL_V5_NOTICE),{seq:1,type:'turn/start',data:{turn:1}},{seq:2,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'请解释这个流程'}]}},{seq:3,type:'tool/call',data:{turn:1,callId:'interp',name:'context_guard_interpret',arguments:JSON.stringify({item_id:'R001',information_spans:[{start:0,end:21}],unknown_spans:[]})}},{seq:4,type:'tool/result',data:{turn:1,message:{ source: { kind: 'tool', callId:'interp' }, role: 'tool', toolCallId: 'interp', isError: false, content: [{type:'text',text:JSON.stringify({status:'recorded',item_id:'R001',item_revision:1,kind:'clause',spans:[{part_index:0,start:0,end:21}],information_spans:[{start:0,end:21}],unknown_spans:[]})}] }}},{seq:5,type:'assistant/message',data:{turn:1,step:1,message:{content:[{type:'text',text:'流程说明。'}]}}},{seq:6,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}]
 const p=deriveProjection(events,config,scope,true).projection
 const result:any=await createCheckpointTool(()=>p,()=>{}).execute({bindings:[]},undefined as never)
 expect(result.status).toBe('certified')
 const replay=deriveProjection([...events,{seq:7,type:'tool/call',data:{callId:'cp',name:'context_guard_checkpoint',arguments:'{"bindings":[]}'}},{seq:8,type:'tool/result',data:{message:{ source: { kind: 'tool', callId:'cp' }, role: 'tool', toolCallId: 'cp', isError: false, content: [{type:'text',text:JSON.stringify(result)}] }}}],config,scope,true).projection
 console.log('R9',replay.integrity,replay.integrityViolations)
 expect(replay.integrity).toBe('valid')
})
it('R10: old certificate remains replayable after appending v5 boundary',async()=>{
 const events:any[]=[notice(0,'Context Guard protocol boundary: v4.0.0')]
 const p=deriveProjection(events,config,scope,true).projection
 const result:any=await createCheckpointTool(()=>p,()=>{}).execute({bindings:[]},undefined as never)
 expect(result.status).toBe('certified')
 const replay=deriveProjection([...events,{seq:1,type:'tool/call',data:{callId:'cp',name:'context_guard_checkpoint',arguments:'{"bindings":[]}'}},{seq:2,type:'tool/result',data:{message:{ source: { kind: 'tool', callId:'cp' }, role: 'tool', toolCallId: 'cp', isError: false, content: [{type:'text',text:JSON.stringify(result)}] }}},notice(3,PROTOCOL_V5_NOTICE)],config,scope,true).projection
 console.log('R10',replay.integrity,replay.integrityViolations)
 expect(replay.integrity).toBe('valid')
})
it('R11: valid public adopt command must not report an error',()=>{
 const p=deriveProjection(base(),config,scope,true).projection
 const command=createContextGuardCommand(()=>p,()=>{},()=>0)
 const result:any=command.handler({agent:{},rawInput:`release adopt ${JSON.stringify(contract)}`} as any)
 expect(result.kind).toBe('success')
})
it('R12: revoking a contract must deny its next effect',()=>{
 const p=deriveProjection([...base(),{seq:2,type:'command/run',data:{name:'context-guard',args:'release revoke rel',source:{kind:'user'}}}],config,scope,true).projection
 expect(releasePreEffectDecision(p,req).status).toBe('denied')
})
it('R13: explicit existing item reference must not crash derivation',()=>{
 const p=createProjection();p.items.set('R001',{id:'R001'} as any)
 expect(()=>explicitlyLinkedToCurrentUnit(p,'继续 R001')).not.toThrow()
 expect(explicitlyLinkedToCurrentUnit(p,'继续 R001')).toBe(true)
})
it('R14: damaged release reservation must block release without corrupting ordinary work',()=>{
 const p=deriveProjection([...base(),notice(2,RELEASE_RESERVATION_PREFIX+JSON.stringify({contractId:'rel',operation:'npm_publish',callId:'res-1',startedAtSeq:'damaged',status:'in_flight'}))],config,scope,true).projection
 expect(p.integrity).toBe('valid')
 expect(releasePreEffectDecision(p,req).status).toBe('denied')
})
it('R15: certificate replay must be invariant to JSON property order',async()=>{
 const events:any[]=[notice(0,PROTOCOL_V5_NOTICE),{seq:1,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'更新文档'}]}},{seq:2,type:'command/run',data:{name:'context-guard',args:'clear',source:{kind:'user'}}}]
 const p=deriveProjection(events,config,scope,true).projection
 const result:any=await createCheckpointTool(()=>p,()=>{}).execute({bindings:[]},undefined as never)
 expect(result.status).toBe('certified');expect(result.certificate.unit_id).toBeDefined()
 const replay=(record:any)=>deriveProjection([...events,{seq:3,type:'tool/call',data:{callId:'cp',name:'context_guard_checkpoint',arguments:'{"bindings":[]}'}},{seq:4,type:'tool/result',data:{message:{ source: { kind: 'tool', callId:'cp' }, role: 'tool', toolCallId: 'cp', isError: false, content: [{type:'text',text:JSON.stringify(record)}] }}}],config,scope,true).projection
 const {unit_id,unit_closure_digest,...rest}=result.certificate
 const reordered={...result,certificate:{...rest,unit_id,unit_closure_digest}}
 console.log('R15 original/reordered',replay(result).integrity,replay(reordered).integrity)
 expect(replay(result).integrity).toBe(replay(reordered).integrity)
})

it('FOLLOWUP F01: adding v5 must not retroactively answer a pre-v5 inquiry',()=>{
 const events:any[]=[notice(0,'Context Guard protocol boundary: v4.0.0'),{seq:1,type:'turn/start',data:{turn:1}},{seq:2,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'请解释这个流程'}]}},{seq:3,type:'assistant/message',data:{turn:1,step:1,message:{content:[{type:'text',text:'说明'}]}}},{seq:4,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}];
 const before=deriveProjection(events,config,scope,true).projection; const after=deriveProjection([...events,notice(5,PROTOCOL_V5_NOTICE)],config,scope,true).projection;
 console.log('LEGACY before/after',[...before.items.values()].map(i=>i.status),[...after.items.values()].map(i=>i.status));
 expect([...after.items.values()].map(i=>i.status)).toEqual([...before.items.values()].map(i=>i.status));
});
