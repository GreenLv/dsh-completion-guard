/** Same-process scope-drift control primitive, not a native acceptance runner.
 * The caller owns the isolated fixture, Guard adapter and durable result.
 * No network access or host/package installation is performed here. */
import { realpath, readFile, open, unlink, lstat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, relative, sep } from 'node:path'
import { spawn } from 'node:child_process'

function beneath(root, child) {
  const r = relative(root, child)
  return r !== '' && r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r)
}
async function requireAbsent(path) {
  try { await lstat(path) } catch (e) { if (e.code === 'ENOENT') return; throw e }
  throw Object.assign(new Error('scope already exists'), { code: 'SCOPE_EXISTS' })
}
const childProgram = `import { createRequire } from 'node:module'; try { const path = createRequire(process.argv[1]).resolve(process.argv[2]); console.log(JSON.stringify({pid:process.pid,path})); } catch(e) { console.log(JSON.stringify({pid:process.pid,error:e.code || 'UNKNOWN'})); }`
export async function freshResolve(importer, dependency, node = process.execPath) {
  return await new Promise((resolve, reject) => {
    const p = spawn(node, ['--input-type=module', '-e', childProgram, importer, dependency], { stdio:['ignore','pipe','pipe'], windowsHide:true })
    let out = '', err = '', finished = false
    const timeout = setTimeout(() => { p.kill(); if(!finished){finished=true; reject(Object.assign(new Error('fresh oracle timeout'),{code:'ORACLE_TIMEOUT',childStateUnknown:true}))} }, 15000)
    p.stdout.on('data', b => { out += b; if(out.length > 8192) p.kill() })
    p.stderr.on('data', b => { err += b; if(err.length > 8192) p.kill() })
    p.on('error', e => { clearTimeout(timeout); if(!finished){finished=true;reject(e)} })
    p.on('close', code => { clearTimeout(timeout); if(finished)return; finished=true; try { if(code!==0 || out.length>8192 || err.length>8192) throw Error('oracle exit'); const v=JSON.parse(out); if(!Number.isSafeInteger(v.pid) || v.pid===process.pid)throw Error('oracle identity'); resolve(v) } catch { reject(Object.assign(new Error('fresh oracle invalid'),{code:'ORACLE_INVALID'})) } })
  })
}
/** adapter.prepare(mode) returns a unique unconsumed ticket; perform(stage, ticket)
 * returns {status, effectCount, auditBefore, auditAfter, ticketId}; onStage receives
 * redacted facts as stages finish. The adapter must use the production lock
 * refresh and a strictly inert local effect; that is outside this primitive. */
export async function runWarmScope({fixtureRoot, importer, dependency, prepare, perform, onStage = () => {}, oracle = freshResolve}) {
  const rows = []; let stage = 'validate'; let installed = null; let scope; let result
  async function emit(row){rows.push(row); await onStage(row)}
  async function act(label, expected, count, ticket) {
    const v = await perform(label, ticket)
    const reasonAllowed=['host_capability_unavailable','host_implementation_bytes_mismatch','host_lock_installed_graph_drift','pre_effect_host_veto_refused'].includes(v?.reason_code)
    const lockOk=expected==='unavailable' ? v?.lockStatus==='unsupported' && v?.lockReason==='host_lock_installed_graph_drift' : v?.lockStatus==='supported' && v?.lockReason===null
    const ok=v && v.status===expected && v.effectCount===count && v.ticketId===ticket.id && Number.isSafeInteger(v.auditBefore) && Number.isSafeInteger(v.auditAfter) && v.auditAfter>v.auditBefore && lockOk && (expected==='unavailable'?reasonAllowed:v.reason_code==='action_completed')
    const row={stage:label,status:v?.status??'missing',effect_count:v?.effectCount??null,ticket_id:v?.ticketId??null,audit_before:v?.auditBefore??null,audit_after:v?.auditAfter??null,reason_code:typeof v?.reason_code==='string' && /^[a-z0-9_]{1,80}$/.test(v.reason_code)?v.reason_code:null,lock_status:v?.lockStatus??null,lock_reason:v?.lockReason??null}
    if(!ok){await emit({...row,stage:label+'_failed_observed'});throw Object.assign(new Error('unexpected action, audit, lock, or effect count'),{code:'ACTION_OR_EFFECT_MISMATCH'})}
    await emit(row)
  }
  try {
    if (!isAbsolute(fixtureRoot) || !isAbsolute(importer) || typeof dependency !== 'string' || !dependency.startsWith('@') || typeof perform !== 'function' || typeof prepare !== 'function') throw Object.assign(new Error('invalid input'),{code:'INPUT_INVALID'})
    const root=await realpath(fixtureRoot), imp=await realpath(importer), dir=await realpath(dirname(imp))
    if (!beneath(root, imp) || !beneath(root, dir)) throw Object.assign(new Error('importer outside fixture'),{code:'FIXTURE_ESCAPE'})
    scope=dir + sep + 'package.json'; await requireAbsent(scope)
    stage='warm'; const target=createRequire(imp).resolve(dependency); const expected=await realpath(target)
    if (!beneath(root,expected)) throw Object.assign(new Error('resolved target outside fixture'),{code:'TARGET_ESCAPE'})
    let f=await oracle(imp,dependency); if(!f.path || await realpath(f.path)!==expected)throw Object.assign(new Error('fresh baseline mismatch'),{code:'ORACLE_BASELINE'})
    await emit({stage:'warm',status:'passed',resident_pid:process.pid,oracle_pid:f.pid})
    stage='baseline'; const initial=await perform('baseline'); if(!initial || initial.status!=='completed' || initial.effectCount!==1 || !Number.isSafeInteger(initial.auditBefore) || !Number.isSafeInteger(initial.auditAfter) || initial.auditAfter<=initial.auditBefore || initial.lockStatus!=='supported' || initial.lockReason!==null || initial.reason_code!=='action_completed')throw Object.assign(new Error('baseline failed'),{code:'BASELINE_FAILED'})
    let count=initial.effectCount; await emit({stage:'baseline',status:initial.status,effect_count:count,reason_code:initial.reason_code,audit_before:initial.auditBefore,audit_after:initial.auditAfter,lock_status:initial.lockStatus,lock_reason:initial.lockReason})
    for(const mode of ['redirect','deny']) {
      stage=mode+'_prepare'; const ticket=await prepare(mode)
      if (!ticket || !/^[a-f0-9]{24}$/.test(ticket.id) || ticket.unconsumed!==true || ticket.effectCount!==count) throw Object.assign(new Error('unconsumed ticket unavailable'),{code:'PREPARE_FAILED'})
      await emit({stage:mode+'_prepared',status:'passed',ticket_id:ticket.id,effect_count:count})
      stage=mode; const spec=mode==='redirect'?{name:dependency,exports:{'.':'./'+imp.slice(dir.length+1)}}:{name:dependency,exports:{'.':null}}
      const bytes=Buffer.from(JSON.stringify(spec)); const file=await open(scope,'wx'); installed=bytes; try { await file.writeFile(bytes) } finally { await file.close() }
      f=await oracle(imp,dependency)
      if(mode==='redirect' ? (!f.path || await realpath(f.path)!==imp || imp===expected) : f.error!=='ERR_PACKAGE_PATH_NOT_EXPORTED') throw Object.assign(new Error('fresh oracle did not witness drift'),{code:'ORACLE_DRIFT'})
      await emit({stage:mode+'_oracle',status:'passed',oracle_pid:f.pid,kind:mode})
      await act(mode,'unavailable',count,ticket)
      stage=mode+'_restore'; const now=await readFile(scope); if(!now.equals(installed))throw Object.assign(new Error('scope changed externally'),{code:'SCOPE_CHANGED'})
      await unlink(scope); installed=null; f=await oracle(imp,dependency); if(!f.path || await realpath(f.path)!==expected)throw Object.assign(new Error('fresh oracle did not restore'),{code:'ORACLE_RESTORE'})
      await act(mode+'_restored','completed',++count,ticket)
    }
    result={status:'passed',resident_pid:process.pid,stages:rows,cleanup:'passed'}
  } catch (e) {
    let cleanup=e.childStateUnknown===true ? 'failed_preserved' : 'passed'
    if(installed && e.childStateUnknown!==true) { try { const now=await readFile(scope); if(!now.equals(installed))throw Error('changed'); await unlink(scope) } catch { cleanup='failed_preserved' } }
    result={status:'failed',resident_pid:process.pid,stages:rows,failure:{stage,code:typeof e.code==='string'?e.code:'UNEXPECTED',child_state_unknown:e.childStateUnknown===true},cleanup}
  }
  return result
}
