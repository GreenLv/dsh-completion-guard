/** Strict consumer for the native warm-scope/v1 runner.
 * It never turns a failed/partial result into a passing result. */
const HEX40=/^[0-9a-f]{40}$/, HEX64=/^[0-9a-f]{64}$/
const stages=['warm','baseline','redirect_prepared','redirect_oracle','redirect','redirect_restored','deny_prepared','deny_oracle','deny','deny_restored']
const exact=(v, keys)=>v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).sort().join('\0')===[...keys].sort().join('\0')
const positive=x=>Number.isSafeInteger(x)&&x>0
export function validateWarmResult(result,expected) {
  if(!exact(expected,['source_commit','artifact_sha256','driver_sha256']))return false
  if(!HEX40.test(expected.source_commit)||!HEX64.test(expected.artifact_sha256)||!HEX64.test(expected.driver_sha256))return false
  if(!exact(result,['schema','status','source_commit','artifact_sha256','driver_sha256','platform','host','profiles','cleanup']))return false
  if(result.schema!=='dsh-native-warm-scope/v1'||result.status!=='passed'||!['windows','macos'].includes(result.platform)||result.source_commit!==expected.source_commit||result.artifact_sha256!==expected.artifact_sha256||result.driver_sha256!==expected.driver_sha256)return false
  // This source's native run must name its selected reviewed host. Earlier
  // receipts retain their original source/schema consumer; historical rows
  // cannot qualify a current run on a host below the raised support floor.
  if(!exact(result.host,['version','node_version','runtime_sha256','node_sha256'])||result.host.version!=='0.2.2-rc.3'||typeof result.host.node_version!=='string'||result.host.node_version.length===0||!HEX64.test(result.host.runtime_sha256)||!HEX64.test(result.host.node_sha256))return false
  if(!exact(result.cleanup,['status','remaining_ids'])||result.cleanup.status!=='passed'||!Array.isArray(result.cleanup.remaining_ids)||result.cleanup.remaining_ids.length)return false
  if(!exact(result.profiles,['web','headless']))return false
  for(const name of ['web','headless']) {
    const p=result.profiles[name]
    if(!exact(p,['pid','host_lock_digest','steps'])||!positive(p.pid)||!HEX64.test(p.host_lock_digest)||!Array.isArray(p.steps)||p.steps.length!==stages.length)return false
    if(p.steps.some((row,i)=>!row || row.stage!==stages[i]))return false
    const [warm,base,rp,ro,rd,rr,dp,do_,dd,dr]=p.steps
    if(!exact(warm,['stage','status','resident_pid','oracle_pid'])||warm.status!=='passed'||warm.resident_pid!==p.pid||!positive(warm.oracle_pid)||warm.oracle_pid===p.pid)return false
    for(const [row,kind] of [[ro,'redirect'],[do_,'deny']])if(!exact(row,['stage','status','oracle_pid','kind'])||row.status!=='passed'||row.kind!==kind||!positive(row.oracle_pid)||row.oracle_pid===p.pid)return false
    if(!exact(base,['stage','status','effect_count','reason_code','audit_before','audit_after','lock_status','lock_reason'])||base.status!=='completed'||base.effect_count!==1||base.reason_code!=='action_completed'||!Number.isSafeInteger(base.audit_before)||base.audit_before<0||!Number.isSafeInteger(base.audit_after)||base.audit_after<=base.audit_before||base.lock_status!=='supported'||base.lock_reason!==null)return false
    const count=base.effect_count
    for(const [row,n] of [[rp,count],[dp,count+1]]) if(!exact(row,['stage','status','ticket_id','effect_count'])||row.status!=='passed'||!(/^[a-f0-9]{24}$/).test(row.ticket_id)||row.effect_count!==n)return false
    if(rp.ticket_id===dp.ticket_id)return false
    let lastAudit=base.audit_after
    for(const [row,status,number,ticket] of [[rd,'unavailable',count,rp.ticket_id],[rr,'completed',count+1,rp.ticket_id],[dd,'unavailable',count+1,dp.ticket_id],[dr,'completed',count+2,dp.ticket_id]]) {
      if(!exact(row,['stage','status','effect_count','reason_code','ticket_id','audit_before','audit_after','lock_status','lock_reason'])||row.status!==status||row.effect_count!==number||row.ticket_id!==ticket||!Number.isSafeInteger(row.audit_before)||!Number.isSafeInteger(row.audit_after)||row.audit_before<lastAudit||row.audit_after<=row.audit_before)return false
      lastAudit=row.audit_after
      if(status==='unavailable' && !['host_capability_unavailable','host_implementation_bytes_mismatch','host_lock_installed_graph_drift','pre_effect_host_veto_refused'].includes(row.reason_code))return false
      if(status==='unavailable' && (row.lock_status!=='unsupported'||row.lock_reason!=='host_lock_installed_graph_drift'))return false
      if(status==='completed' && (row.reason_code!=='action_completed'||row.lock_status!=='supported'||row.lock_reason!==null))return false
    }
  }
  return result.profiles.web.pid!==result.profiles.headless.pid
}
