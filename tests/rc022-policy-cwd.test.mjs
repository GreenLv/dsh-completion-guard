import {it,expect} from 'vitest'
import {mkdtempSync,realpathSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import {Session,SessionId} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LocalFileSystem} from '@deepseek-ai/dsh-fs-local'
import {SandboxPolicyService} from '@deepseek-ai/dsh-sandbox-policy'
import {writableRoots} from '@deepseek-ai/dsh-sandbox'
import {captureHostWorkdir} from '../src/domain/host-workdir.js'
import {evaluateHostLock,EXPECTED_HOST_PACKAGES} from '../src/domain/host-lock.js'
const require=createRequire(import.meta.url),r=createRequire(require.resolve('@deepseek-ai/dsh-tool-bash'))
const {WorkingDirectoryService}=await import(pathToFileURL(r.resolve('@deepseek-ai/dsh-working-directory')).href)
it('uses rc1 initialized working-directory and sandbox policy while binding the actual default cwd',async()=>{
 const root=realpathSync.native(mkdtempSync(join(tmpdir(),'cg-rc022-cwd-'))),other=realpathSync.native(mkdtempSync(join(tmpdir(),'cg-rc022-extra-'))),ctx=new Context()
 try{
  new SessionProjectionRegistry(ctx);new SystemPrompt(ctx,{});new LocalFileSystem(ctx,{cwd:root,diffBasisMaxBytes:10485760})
  await ctx.plugin(WorkingDirectoryService,{defaultDirectory:root}).await()
  await ctx.plugin(SandboxPolicyService,{mode:'workspace-write',workspaceRoot:other,additionalWritableRoots:[other]}).await()
  const id=SessionId('cwd-rc022'),session=Session.create(id,undefined,{version:4,id,isSeeded:false,createdAt:1,cwd:root,delegationDepth:0}),agent={id,session,ctx,inject:()=>{}}
  expect(ctx.sandboxPolicy.resolve({session})).toMatchObject({sessionId:id,workspaceRoot:root,additionalWritableRoots:[other]})
  expect(await ctx.workingDirectory.ensure(agent)).toBe(root)
  session.append('turn/start',{turn:1});session.append('user/message',{source:{kind:'user'},content:[{type:'text',text:'Run npm test.'}]},{surfaceOp:'append'})
  session.append('tool/call',{turn:1,step:1,callId:'c1',name:'bash',arguments:'{"command":"npm test"}'})
  const host={...evaluateHostLock(EXPECTED_HOST_PACKAGES,{platform:'posix',profileKind:'web'}),auditedForegroundRenderers:['bash']}
  const receipt=captureHostWorkdir(session,{agent,callId:'c1',rootCallId:'c1',name:'bash',arguments:{command:'npm test'}},host,ctx.sandboxPolicy,true)
  expect(receipt).toMatchObject({effectiveCwd:root,headerCwd:root,policyRoot:root,policySource:'bash-policy'})
  await ctx.workingDirectory.set(agent,other);expect(await ctx.workingDirectory.ensure(agent)).toBe(other)
  expect(ctx.sandboxPolicy.resolve({session}).workspaceRoot).toBe(root)
  const roots=writableRoots(ctx.sandboxPolicy.resolve({session}));expect(roots).toContain(root);expect(roots).toContain(other)
  expect(()=>writableRoots({mode:'workspace-write',workspaceRoot:root,additionalWritableRoots:[join(root,'missing')]})).toThrow()
 } finally {await ctx.fiber.dispose();rmSync(root,{recursive:true,force:true});rmSync(other,{recursive:true,force:true})}
})
