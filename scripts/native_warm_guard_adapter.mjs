/** Controlled seam adapter; must be loaded by an actual isolated DSH host.
 * It installs the exact artifact's Guard apply() with dynamic host-lock roots.
 * No host-lock result is supplied or overridden; effect and registry are inert.
 * This module alone is not a host probe or acceptance result. */
import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
function inside(root,path){const rel=relative(root,path);return rel!==''&&rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel)}
export function installWarmGuard({ctx,product,config,fixtureRoot,releaseTgz,packageName,packageVersion,integrity}) {
  assert.equal(typeof product?.apply,'function')
  const root=realpathSync(fixtureRoot), runtime=realpathSync(config.hostLockRuntimeRoot), profile=realpathSync(config.hostLockProfileRoot), tgz=realpathSync(releaseTgz)
  assert.ok([runtime,profile,tgz].every(p=>inside(root,p)),'all paths must be in owned fixture')
  assert.equal(config.hostLockPolicy,'dsh-core/v1')
  assert.ok(['web','headless'].includes(config.hostLockProfile))
  assert.ok(Array.isArray(config.hostLockPackages) && config.hostLockPackages.length>0)
  assert.match(packageName,/^[a-z0-9][a-z0-9._-]{0,63}$/); assert.match(packageVersion,/^[0-9]+[.][0-9]+[.][0-9]+$/); assert.match(integrity,/^sha512-[A-Za-z0-9+/]{86}==$/)
  const registry='https://registry.example.invalid/'
  const exactUrl=registry+encodeURIComponent(packageName)+'/'+encodeURIComponent(packageVersion)
  let effectCount=0, auditCount=0
  const fetcher=async input=>{assert.equal(String(input),exactUrl,'network is forbidden');return Response.json({name:packageName,version:packageVersion,dist:{integrity}})}
  const commandRunner=async (file,args)=>{
    assert.equal(file,'npm'); assert.deepEqual(args,['publish',tgz,'--registry',registry,'--ignore-scripts'])
    effectCount++
  }
  // No `hostLock` seam: Guard must derive and refresh its configured graph.
  product.apply(ctx,config,{fetcher,commandRunner,onHostLockValidation:()=>{auditCount++}})
  return {registry,effectCount:()=>effectCount,auditCount:()=>auditCount}
}
