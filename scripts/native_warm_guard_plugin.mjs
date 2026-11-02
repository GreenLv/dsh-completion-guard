/** Real-host plugin wrapper used by the native warm-scope runner.
 * Imports Guard from the isolated installed package.  Its only seams are a
 * local-only registry and inert publish counter; hostLock is never overridden. */
import assert from 'node:assert/strict'
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installWarmGuard } from './native_warm_guard_adapter.mjs'
export const name = 'context-guard'
export const inject = ['sessions','commands','fs']
const key=Symbol.for('dsh.native-warm-guard.fixture-state.v1')
export function warmGuardState(nonce) { return globalThis[key]?.get(nonce) }
export async function apply(ctx,config) {
  const warm=config.warm
  assert.ok(warm && typeof warm==='object')
  assert.match(warm.nonce,/^[a-f0-9]{24}$/)
  const root=realpathSync(warm.fixtureRoot), profile=realpathSync(config.hostLockProfileRoot)
  const pkg=realpathSync(join(profile,'node_modules','dsh-completion-guard'))
  const rel=relative(root,pkg)
  assert.ok(rel && rel!=='..' && !rel.startsWith('..'+sep) && !isAbsolute(rel),'package must be within fixture')
  const manifest=JSON.parse(readFileSync(join(pkg,'package.json'),'utf8'))
  assert.equal(manifest.name,'dsh-completion-guard');assert.equal(manifest.version,warm.guardVersion);assert.equal(manifest.gitHead,warm.sourceCommit)
  const entry=realpathSync(join(pkg,'dist','index.js'))
  const entryRel=relative(pkg,entry);assert.ok(entryRel && !entryRel.startsWith('..'+sep) && !isAbsolute(entryRel))
  const product=await import(pathToFileURL(entry).href)
  const map=globalThis[key]??=new Map();assert.equal(map.has(warm.nonce),false,'duplicate fixture nonce')
  const state=installWarmGuard({ctx,product,config,fixtureRoot:root,releaseTgz:warm.releaseTgz,
    packageName:warm.packageName,packageVersion:warm.packageVersion,integrity:warm.integrity})
  map.set(warm.nonce,state)
  ctx.effect(()=>()=>{map.delete(warm.nonce)})
}
