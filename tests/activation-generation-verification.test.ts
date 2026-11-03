import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as zlib from 'node:zlib'
import { activationDigest } from '../src/domain/session-activation.js'
import { verifyActivationGenerations, type ActivationGenerationDescriptor } from '../src/domain/activation-generation-verification.js'
const require = createRequire(import.meta.url)
const backendRequire = createRequire(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl'))
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
const backend = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href)
const { historicalSessionFormatCatalog, sessionFormatCatalog } = await import(pathToFileURL(backendRequire.resolve('@deepseek-ai/dsh-session-format-catalog')).href)
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}) })
async function openSnapshot(root: string, compression: 'none'|'zstd') {
  const context = new Context(); const child = context.plugin(backend.default ?? backend, {root, compression}); await child.await()
  return { persistence: context.sessionPersistence, close: async () => { await context.fiber.dispose() } }
}
function descriptors(root: string, compression: 'none'|'zstd'): ActivationGenerationDescriptor[] {
  const out: ActivationGenerationDescriptor[] = []
  for (const project of readdirSync(root)) for (const session of readdirSync(join(root,project))) for (const name of readdirSync(join(root,project,session))) {
    const m=/^session(?:\.v([1-4]))?\.jsonl(?:\.zstd)?$/u.exec(name); if (!m) continue
    const relativePath=`${project}/${session}/${name}`, path=join(root,relativePath), s=lstatSync(path,{bigint:true})
    const identity={dev:String(s.dev),ino:String(s.ino),size:String(s.size),mtimeNs:String(s.mtimeNs),ctimeNs:String(s.ctimeNs),mode:String(s.mode),nlink:String(s.nlink)}
    out.push({relativePath,projectSegment:project,sessionSegment:session,version:m[1]?Number(m[1]):0,compression,contentSha256:createHash('sha256').update(readFileSync(path)).digest('hex'),identity})
  }
  return out
}
function encode(header: unknown, compression: 'none'|'zstd') {
  const plain=Buffer.from(JSON.stringify(header)+'\n');return compression==='none'?plain:zlib.zstdCompressSync(plain)
}
async function fixture(compression: 'none'|'zstd', fork=false) {
 const root=realpathSync(mkdtempSync(join(tmpdir(),'dsh-multigen-test-'))); roots.push(root)
 const sdk=await openSnapshot(root,compression)
 if(fork){const p=await sdk.persistence.create({version:4,id:'parent',createdAt:1,isSeeded:false,delegationDepth:0});await p.flush();await p.close()}
 const dir=join(root,'_no-cwd','child');mkdirSync(dir,{recursive:true})
 const suffix=compression==='zstd'?'.zstd':''
 const base={type:'session',id:'child',createdAt:2,delegationDepth:0,...(fork?{parentSession:'parent'}:{})}
 writeFileSync(join(dir,`session.v3.jsonl${suffix}`),Buffer.concat([encode({...base,version:3,isSeeded:fork},compression),...(fork?[encode({type:'session/end-seed',seq:0,time:1,data:{}},compression),encode({type:'session/end-seed',seq:1,time:1,data:{inherited:true}},compression)]:[])]))
 const h=await sdk.persistence.open('child','write');await h.flush();await h.close();await sdk.close()
 writeFileSync(join(dir,`session.v1.jsonl${suffix}`),Buffer.concat([encode({...base,version:1,...(fork?{seedLength:1}:{})},compression),...(fork?[encode({type:'session/end-seed',seq:0,time:1,data:{}},compression)]:[])]))
 writeFileSync(join(dir,`session.jsonl${suffix}`),Buffer.concat([encode({...base,version:0,...(fork?{seedLength:1}:{})},compression),...(fork?[encode({type:'session/end-seed',seq:0,time:1,data:{}},compression)]:[])]))
 const rows=descriptors(root,compression), census='a'.repeat(64)
 const args={root,compression,generations:rows,censusSha256:census,capture:()=>census,openSnapshot,catalogs:{historical:historicalSessionFormatCatalog,current:sessionFormatCatalog}}
 return {root,dir,suffix,args,base}
}
describe('SDK generation verification',()=>{
 it.each(['none','zstd'] as const)('validates v1/v3/v4 %s with a separate parent context',async compression=>{
  const f=await fixture(compression,true);const output=await verifyActivationGenerations(f.args)
  expect(output.generations.map(x=>x.version).sort()).toEqual([0,1,3,4]);expect(new Set(output.generations.map(x=>x.birthIdentitySha256))).toEqual(new Set([activationDigest({id:'child',createdAt:2,isSeeded:true,inheritedEventCount:1,delegationDepth:0,parentSession:'parent'})]))
  expect(output.selections).toMatchObject([{sessionSegment:'child',selectedVersion:4}]);expect(readdirSync(f.dir).sort()).toContain(`session.v1.jsonl${f.suffix}`)
 },30000)
 it.each(['none','zstd'] as const)('rejects hidden invalid or torn %s generations',async compression=>{
  for(const kind of ['badrow','torn','wrongid','birthconflict']){
   const f=await fixture(compression);const path=join(f.dir,`session.v1.jsonl${f.suffix}`)
   const head={...f.base,version:1,...(kind==='wrongid'?{id:'elsewhere'}:{}),...(kind==='birthconflict'?{createdAt:3}:{})}
   let plain=JSON.stringify(head)+'\n';if(kind==='badrow')plain+='{"type":"bad"}\n';if(kind==='torn')plain+='{"type":'
   const bytes=Buffer.from(plain);writeFileSync(path,compression==='none'?bytes:zlib.zstdCompressSync(bytes));f.args.generations=descriptors(f.root,compression)
   await expect(verifyActivationGenerations(f.args)).rejects.toThrow()
  }
 },60000)
 it('rejects truncated zstd frames and cleans private workspace',async()=>{
  const f=await fixture('zstd');const path=join(f.dir,`session.v1.jsonl${f.suffix}`), bytes=readFileSync(path);writeFileSync(path,bytes.subarray(0,-1));f.args.generations=descriptors(f.root,'zstd')
  const before=new Set(readdirSync(tmpdir()).filter(x=>x.startsWith('dsh-generation-check-')))
  await expect(verifyActivationGenerations(f.args)).rejects.toThrow()
  expect(readdirSync(tmpdir()).filter(x=>x.startsWith('dsh-generation-check-')).filter(x=>!before.has(x))).toEqual([])
 })
 it('rejects a linked generation rather than following it',async()=>{
  const f=await fixture('none'), path=join(f.dir,'session.v1.jsonl'), bytes=readFileSync(path);rmSync(path);const other=join(f.root,'other');writeFileSync(other,bytes);try { symlinkSync(other,path,'file') } catch (error) { if (process.platform !== 'win32' || !['EPERM','EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; linkSync(other,path) }
  await expect(verifyActivationGenerations(f.args)).rejects.toThrow()
 })
 it('refuses a scratch base inside source even through a symlink before copying',async()=>{
  const f=await fixture('none'), link=join(f.root,'scratch-link');symlinkSync(f.root,link,process.platform==='win32'?'junction':'dir')
  const variables=process.platform==='win32'?['TEMP','TMP']:['TMPDIR'];const previous=variables.map(key=>process.env[key])
  try { for(const key of variables)process.env[key]=link;await expect(verifyActivationGenerations(f.args)).rejects.toThrow() }
  finally { variables.forEach((key,i)=>{if(previous[i]===undefined)delete process.env[key];else process.env[key]=previous[i]}) }
  expect(readdirSync(f.root).filter(name=>name.startsWith('dsh-generation-check-'))).toEqual([])
 })
 it('rejects changed census after the snapshot is copied',async()=>{
  const f=await fixture('none');let calls=0;f.args.capture=()=>++calls===1?f.args.censusSha256:'b'.repeat(64)
  await expect(verifyActivationGenerations(f.args)).rejects.toThrow('activation_generation_unverified')
 })

 it('keeps single-generation SDK cases outside strict verification',async()=>{
  const f=await fixture('none');f.args.generations=f.args.generations.filter(x=>x.version===4);f.args.openSnapshot=async()=>{throw new Error('must not open')};
  expect(await verifyActivationGenerations(f.args)).toEqual({generations:[],selections:[]})
 })
 it('refuses future versions and changed source identity',async()=>{
  const f=await fixture('none');f.args.generations[0].version=5;await expect(verifyActivationGenerations(f.args)).rejects.toThrow()
  f.args.generations=descriptors(f.root,'none');writeFileSync(join(f.dir,'session.v1.jsonl'),'changed after census\n');await expect(verifyActivationGenerations(f.args)).rejects.toThrow()
 })
 it('leaves the original multi-generation files byte-identical after verification',async()=>{
  const f=await fixture('none');const before=f.args.generations.map(g=>[g.relativePath,readFileSync(join(f.root,g.relativePath)).toString('hex')])
  await verifyActivationGenerations(f.args);for(const [path,hex] of before)expect(readFileSync(join(f.root,path)).toString('hex')).toBe(hex)
 })

 it('strictly reads 160000 complete records in one compressed frame without argument expansion',async()=>{
  const f=await fixture('zstd');const path=join(f.dir,'session.v1.jsonl.zstd')
  const records=Array.from({length:160000},(_,seq)=>JSON.stringify({type:'session/end-seed',seq,time:1,data:{}})).join('\n')+'\n'
  writeFileSync(path,Buffer.concat([encode({...f.base,version:1},'zstd'),zlib.zstdCompressSync(Buffer.from(records))]))
  f.args.generations=descriptors(f.root,'zstd');const result=await verifyActivationGenerations(f.args)
  expect(result.generations).toHaveLength(4)
 },120000)

 it('rejects a forged SDK physical revision even when the session identity matches',async()=>{
  const f=await fixture('none'), original=f.args.openSnapshot
  f.args.openSnapshot=async(root,compression)=>{
   const result=await original(root,compression), service=result.persistence
   return {...result,persistence:{stat:async(id:never)=>{const row=await service.stat(id);return row?{...row,revision:`bad:${row.revision}`} : row},open:(id:never,access:'read')=>service.open(id,access)}}
  }
  await expect(verifyActivationGenerations(f.args)).rejects.toThrow('activation_generation_unverified')
 })

 it.skipIf(process.platform !== 'win32').each(['R','M'])('refuses inherited Everyone %s access before copying',async permission=>{
  const f=await fixture('none'), unsafe=realpathSync(mkdtempSync(join(tmpdir(),'dsh-unsafe-acl-')));roots.push(unsafe)
  const root=process.env.SystemRoot;if(!root)throw new Error('SystemRoot unavailable')
  execFileSync(join(root,'System32','icacls.exe'),[unsafe,'/grant',`*S-1-1-0:(OI)(CI)${permission}`],{stdio:'ignore'})
  const temp=process.env.TEMP,tmp=process.env.TMP
  try { process.env.TEMP=unsafe;process.env.TMP=unsafe;await expect(verifyActivationGenerations(f.args)).rejects.toThrow() }
  finally { if(temp===undefined)delete process.env.TEMP;else process.env.TEMP=temp;if(tmp===undefined)delete process.env.TMP;else process.env.TMP=tmp }
  expect(readdirSync(unsafe).filter(name=>name.startsWith('dsh-generation-check-'))).toEqual([])
 })

})
