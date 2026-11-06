import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,cpSync,rmSync} from 'node:fs';import {test} from 'vitest';import {fileURLToPath} from 'node:url';import {tmpdir}from'node:os';import{join,dirname,relative}from'node:path';import{spawnSync}from'node:child_process';import{createRequire}from'node:module'
const testRepo=fileURLToPath(new URL('..',import.meta.url)), script=join(testRepo,'scripts/generate-activation-catalog-cohort.mjs')
test('regenerates scoped closure and rejects ambiguous routes', () => {
const parent=mkdtempSync(join(tmpdir(),'dcg-generator-tests-'))
try {
cpSync(dirname(createRequire(join(testRepo,'package.json')).resolve('typescript/package.json')),join(parent,'node_modules/typescript'),{recursive:true})
function file(path,data){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,data)}
function fixture(){const root=mkdtempSync(join(parent,'case-'));file(join(root,'package.json'),'{}');mkdirSync(join(root,'scripts'),{recursive:true});copyFileSync(script,join(root,'scripts/generate-activation-catalog-cohort.mjs'));mkdirSync(join(root,'node_modules'),{recursive:true});return root}
function pkg(root,base,name,content='export {}', exports={'.':'./lib/index.js','./package.json':'./package.json'}){const dir=join(root,base,'node_modules',name);file(join(dir,'package.json'),JSON.stringify({name,type:'module',exports}));file(join(dir,'lib/index.js'),content);return dir}
function initialize(){const root=fixture();pkg(root,'','@deepseek-ai/dsh-session-persistence-jsonl');return root}
function run(root){return spawnSync(process.execPath,[join(root,'scripts/generate-activation-catalog-cohort.mjs'),join(root,'out.json')],{encoding:'utf8'})}
let results=[]
{
 const root=initialize();pkg(root,'','@deepseek-ai/dsh-session-format-catalog',`import '@deepseek-ai/demo';`);const demo=pkg(root,'','@deepseek-ai/demo',`export default 'import'`,{'.':{import:'./lib/index.js',require:'./lib/cjs.cjs'},'./package.json':'./package.json'});file(join(demo,'lib/cjs.cjs'),"module.exports='require'");const p=run(root);if(p.status!==0)throw Error(p.stderr);const output=JSON.parse(readFileSync(join(root,'out.json')));const edge=output.modules.find(x=>x.package==='@deepseek-ai/dsh-session-format-catalog').edges[0];if(edge.target!=='@deepseek-ai/demo::lib/index.js')throw Error(JSON.stringify(edge));results.push({case:'conditional import',exit:p.status,target:edge.target})
}
{
 const root=initialize();pkg(root,'','@deepseek-ai/dsh-session-format-catalog',`import '@deepseek-ai/a';import '@deepseek-ai/b';`);const a=pkg(root,'','@deepseek-ai/a',`import '@deepseek-ai/shared';`),b=pkg(root,'','@deepseek-ai/b',`import '@deepseek-ai/shared';`);pkg(root,'','@deepseek-ai/shared');pkg(root,relative(root,a),'@deepseek-ai/shared');pkg(root,relative(root,b),'@deepseek-ai/shared');const p=run(root);if(p.status===0||!p.stderr.includes('multiple instances'))throw Error(p.stderr);results.push({case:'multiple instances',exit:p.status,error:'multiple instances'})
}
{
 const root=initialize();const catalog=pkg(root,'','@deepseek-ai/dsh-session-format-catalog',`import '../../escape.js';`);file(join(catalog,'../../escape.js'),"export {}") // resolve from lib requires three parent segments
 file(join(catalog,'../escape.js'),"export {}")
 const p=run(root);if(p.status===0||!p.stderr.includes('edge escapes package'))throw Error(p.stderr);results.push({case:'relative escape',exit:p.status,error:'edge escapes package'})
}
{
 const root=initialize();pkg(root,'','@deepseek-ai/dsh-session-format-catalog',`import '@deepseek-ai/missing';`);const p=run(root);if(p.status===0)throw Error('unresolved package accepted');results.push({case:'missing official dependency',exit:p.status})
}
{
 const root=initialize();pkg(root,'','@deepseek-ai/dsh-session-format-catalog',`const specifier='@deepseek-ai/demo';import(specifier)`);const p=run(root);if(p.status===0||!p.stderr.includes('non-literal import'))throw Error(p.stderr);results.push({case:'nonliteral dynamic import',exit:p.status,error:'non-literal import'})
}
{
 const root=initialize();pkg(root,'','@deepseek-ai/dsh-session-format-catalog',`import 'rrule';`);const cjs=pkg(root,'','rrule',`require('demo-conditional')`);const conditional=pkg(root,'','demo-conditional',`export default 'import'`,{'.':{import:'./lib/index.js',require:'./lib/require.cjs'}});file(join(conditional,'lib/require.cjs'),"module.exports='require'");const p=run(root);if(p.status!==0)throw Error(p.stderr);const output=JSON.parse(readFileSync(join(root,'out.json'))), mod=output.modules.find(x=>x.package==='rrule'),edge=mod.edges.find(x=>x.specifier==='demo-conditional');if(edge.target!=='demo-conditional::lib/require.cjs')throw Error(JSON.stringify(edge));results.push({case:'CJS require conditions plus hidden package.json',exit:p.status,target:edge.target})
}
{
 const root=initialize();pkg(root,'','@deepseek-ai/dsh-session-format-catalog',`const req = require; req('rrule')`);const p=run(root);if(p.status===0||!p.stderr.includes('unsupported require reference'))throw Error(p.stderr);results.push({case:'aliased require refused',exit:p.status})
}
if(results.length!==7)throw Error('missing cases')
} finally { rmSync(parent,{recursive:true,force:true}) }
}, 60000)
