import test from 'node:test'
import assert from 'node:assert/strict'
import {validateWarmResult} from '../scripts/native_warm_scope_consumer.mjs'
const expected={source_commit:'a'.repeat(40),artifact_sha256:'b'.repeat(64),driver_sha256:'c'.repeat(64)}
function profile(pid){const a='a'.repeat(24),b='b'.repeat(24);return {pid,host_lock_digest:'d'.repeat(64),steps:[
{stage:'warm',status:'passed',resident_pid:pid,oracle_pid:pid+2},
{stage:'baseline',status:'completed',effect_count:1,reason_code:'action_completed',audit_before:1,audit_after:2,lock_status:'supported',lock_reason:null},
{stage:'redirect_prepared',status:'passed',ticket_id:a,effect_count:1},
{stage:'redirect_oracle',status:'passed',oracle_pid:pid+3,kind:'redirect'},
{stage:'redirect',status:'unavailable',effect_count:1,ticket_id:a,audit_before:2,audit_after:3,reason_code:'host_implementation_bytes_mismatch',lock_status:'unsupported',lock_reason:'host_lock_installed_graph_drift'},
{stage:'redirect_restored',status:'completed',effect_count:2,ticket_id:a,audit_before:3,audit_after:4,reason_code:'action_completed',lock_status:'supported',lock_reason:null},
{stage:'deny_prepared',status:'passed',ticket_id:b,effect_count:2},
{stage:'deny_oracle',status:'passed',oracle_pid:pid+4,kind:'deny'},
{stage:'deny',status:'unavailable',effect_count:2,ticket_id:b,audit_before:4,audit_after:5,reason_code:'host_implementation_bytes_mismatch',lock_status:'unsupported',lock_reason:'host_lock_installed_graph_drift'},
{stage:'deny_restored',status:'completed',effect_count:3,ticket_id:b,audit_before:5,audit_after:6,reason_code:'action_completed',lock_status:'supported',lock_reason:null}]}}
function result(){return {schema:'dsh-native-warm-scope/v1',status:'passed',...expected,platform:'windows',host:{version:'0.2.2-rc.1',node_version:'24.18.0',runtime_sha256:'e'.repeat(64),node_sha256:'f'.repeat(64)},profiles:{web:profile(101),headless:profile(201)},cleanup:{status:'passed',remaining_ids:[]}}}
const step=(r,name)=>r.profiles.web.steps.find(x=>x.stage===name)
test('accepts only the complete bound stage matrix',()=>{assert.equal(validateWarmResult(result(),expected),true)})
test('rejects incorrect subject, stale audit, consumed reservation, leaked effect, wrong oracle and cleanup',()=>{for(const mutate of [r=>r.source_commit='f'.repeat(40),r=>r.profiles.web.steps.splice(3,1),r=>step(r,'redirect').effect_count++,r=>step(r,'redirect_oracle').oracle_pid=r.profiles.web.pid,r=>r.cleanup.status='failed',r=>r.profiles.headless.pid=r.profiles.web.pid,r=>step(r,'redirect').unexpected=true,r=>step(r,'redirect').reason_code='release_operation_consumed',r=>step(r,'redirect').reason_code=null,r=>r.host.version='0.2.1-rc.3',r=>step(r,'redirect').audit_after=step(r,'redirect').audit_before,r=>step(r,'redirect_restored').ticket_id='f'.repeat(24),r=>step(r,'deny_prepared').ticket_id=step(r,'redirect_prepared').ticket_id]){const r=result();mutate(r);assert.equal(validateWarmResult(r,expected),false)}})
test('generic capability denial needs independent drift witness',()=>{const r=result();step(r,'redirect').reason_code='host_capability_unavailable';assert.equal(validateWarmResult(r,expected),true);step(r,'redirect').lock_status='supported';step(r,'redirect').lock_reason=null;assert.equal(validateWarmResult(r,expected),false)})

test('current native observations refuse historical and unreviewed hosts',()=>{for(const version of ['0.2.0-rc.2','0.2.1-rc.3','0.2.1-rc.5','0.2.1','0.2.2-rc.0','0.2.2-rc.2']){const r=result();r.host.version=version;assert.equal(validateWarmResult(r,expected),false,version)}})
