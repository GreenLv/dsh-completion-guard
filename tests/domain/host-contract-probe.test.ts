import { afterEach, describe, it, expect } from 'vitest'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { execFileSync } from 'node:child_process'
import ts from 'typescript'
import { createRequire } from 'node:module'
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runHostContractProbe, type ProbeArchive } from '../../src/domain/host-contract-probe.js'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { acquireHostTrust, qualifyHostTrust } from '../../src/domain/host-trust.js'
import { hostProgramDigest } from '../../src/domain/host-contract-program.js'
import { auditedHostImplementation } from '../../src/domain/host-resolver.js'

// Each case runs synchronous, confined Node children. Yield between cases so
// worker RPC replies are processed even when this file takes over a minute.
afterEach(async () => { await yieldToEventLoop() })

/** Copies fixture SDK dependencies into the probe stage, never loads SDK code
 * in the oracle process. Registry provenance is tested at acquisition separately. */
function sdkArchives(targets: string[] = ['@deepseek-ai/dsh-session']): ProbeArchive[] {
  const archives: ProbeArchive[] = [], seen = new Set<string>()
  const collect = (name: string, anchor: string) => {
    if (seen.has(name)) return
    const resolver = createRequire(anchor)
    let entry: string
    try { entry = resolver.resolve(name) } catch {
      try { entry = createRequire(join(process.cwd(), 'tests/fixtures/host-composition/package.json')).resolve(name) } catch { return }
    }
    let root = dirname(entry)
    while (!existsSync(join(root, 'package.json'))) root = dirname(root)
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    if (manifest.name !== name) throw new Error('fixture package scope mismatch')
    seen.add(name)
    const files: Record<string, Buffer> = {}
    const walk = (dir: string, prefix: string) => {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        if (item.name === 'node_modules') continue
        const file = prefix + item.name
        if (item.isDirectory()) walk(join(dir, item.name), file + '/')
        else if (/\.(?:[cm]?js|json)$/.test(file)) files[file] = readFileSync(join(dir, item.name))
      }
    }
    walk(root, '')
    archives.push({ name, files })
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) collect(dependency, join(root, 'package.json'))
  }
  for (const target of targets) collect(target, join(process.cwd(), 'package.json'))
  return archives
}
const TARGET = '@deepseek-ai/dsh-session'
function changedArchives(change: (source: string) => string): ProbeArchive[] {
  const archives = sdkArchives()
  const session = archives.find(row => row.name === TARGET)!
  session.files['lib/index.js'] = Buffer.from(change(session.files['lib/index.js'].toString()))
  return archives
}
describe('stable host behavioral qualification in a confined new Node process', () => {
  it('accepts an executable program change with unchanged Session V4 behavior', () => {
    const result = runHostContractProbe(changedArchives(source => source + '\nexport const contractFixtureRevision = 2;\n'), [TARGET])
    expect(result.failures).toEqual([])
    expect(result.checks).toEqual(expect.arrayContaining(['session.api', 'session.envelope', 'session.immutable', 'session.stable', 'session.restore_gap', 'session.restore_unknown', 'session.fork_unknown']))
  })
  it.each([
    ['API', (s: string) => s.replace('Session, SessionForkError, SessionId', 'SessionForkError, SessionId')],
    ['sequence', (s: string) => s + '\nSession.fromRestore = (id, seed, header) => Session.create(id, undefined, header);\n'],
    ['unknown outcome', (s: string) => s.replace('ToolOutcomeUnknownError', 'KnownSuccess')],
    ['event delivery', (s: string) => s.replace('if (callbacks !== void 0 && entry !== void 0) invokeContainedSessionObservers', 'if (false) invokeContainedSessionObservers')],
    ['durability', (s: string) => s + '\nSessionStore.prototype.flush = async () => false;\n'],
    ['immutability', (s: string) => s.replace('this.log.push(mode === "snapshot" ? deepFreeze(snapshot) : snapshot)', 'this.log.push(snapshot)')],
  ])('rejects incompatible %s behavior', (_label, change) => {
    const original = sdkArchives().find(row => row.name === TARGET)!.files['lib/index.js'].toString()
    expect(change(original)).not.toBe(original)
    expect(runHostContractProbe(changedArchives(change), [TARGET]).failures).toEqual(['host_contract_session_incompatible'])
  })
  it('denies filesystem writes by acquired code', () => {
    const result = runHostContractProbe(changedArchives(source => "import { writeFileSync as deniedWrite } from 'node:fs'; deniedWrite('probe-side-effect','forbidden');\n" + source), [TARGET])
    expect(result.failures).toEqual(['host_contract_session_incompatible'])
  })
  it('program equivalence ignores comments and formatting but preserves behavior', () => {
    expect(hostProgramDigest('export const value = 1')).toBe(hostProgramDigest('// comment\n export const value=0x1;'))
    expect(hostProgramDigest('export const value = 1')).not.toBe(hostProgramDigest('export const value = 2'))
  })
})

function fixtureTar(files: Record<string, Buffer>): Buffer {
  const blocks: Buffer[] = []
  for (const [file, content] of Object.entries(files)) {
    const name = 'package/' + file
    if (Buffer.byteLength(name) >= 100) throw new Error('fixture tar name too long')
    const header = Buffer.alloc(512)
    header.write(name, 0, 100); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116)
    header.write(content.length.toString(8).padStart(11, '0') + '\0', 124); header.fill(32, 148, 156); header.write('0', 156)
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0)
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148)
    blocks.push(header, content, Buffer.alloc((512 - content.length % 512) % 512))
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}
it('issues a receipt for a registry-acquired program change and refuses transferred byte bindings', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qualified-contract-')))
  try {
    const archives = changedArchives(source => source + '\nexport const compatibleFixtureRevision = 3;\n')
    const entries = archives.map(archive => {
      const manifest = JSON.parse(archive.files['package.json'].toString())
      if (archive.name === TARGET) { manifest.version = '0.2.1-rc.1'; archive.files['package.json'] = Buffer.from(JSON.stringify(manifest)) }
      const bytes = fixtureTar(archive.files)
      return { bytes, name: archive.name, version: manifest.version as string, integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') }
    })
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input)
      const archive = entries.find(row => url === 'https://registry.npmjs.org/' + encodeURIComponent(row.name) + '/' + encodeURIComponent(row.version))
      if (archive) return new Response(JSON.stringify({ name: archive.name, version: archive.version, dist: { integrity: archive.integrity, tarball: 'https://registry.npmjs.org/fixture/' + encodeURIComponent(archive.name) + '.tgz' } }))
      const tar = entries.find(row => url === 'https://registry.npmjs.org/fixture/' + encodeURIComponent(row.name) + '.tgz')
      return tar ? new Response(new Uint8Array(tar.bytes)) : new Response('', { status: 404 })
    }) as typeof fetch
    const session = entries.find(row => row.name === TARGET)!
    const trust = await acquireHostTrust([session], fetcher, { profileRoot: root, dependencyIdentity: name => entries.find(row => row.name === name)! })
    expect(qualifyHostTrust(trust, root).packages[0].version).toBe('0.2.1-rc.1')
    const changed = structuredClone(trust)
    changed.packages[0].modules['lib/index.js'] = '0'.repeat(64)
    expect(() => qualifyHostTrust(changed, root)).toThrow('host_trust_contract_binding_mismatch')
    expect(() => qualifyHostTrust(trust)).toThrow('host_trust_contract_receipt_missing')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it.each(['@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-commands', '@deepseek-ai/dsh-llm'])('qualifies the consumed %s contract after a harmless program change', target => {
  const archives = sdkArchives([target, TARGET])
  const archive = archives.find(row => row.name === target)!
  archive.files['lib/index.js'] = Buffer.from(archive.files['lib/index.js'].toString() + '\nexport const compatibleContractRevision = 1;\n')
  expect(runHostContractProbe(archives, [target]).failures).toEqual([])
})

it('rejects an AgentRegistry that loses created-event initialization', () => {
  const target = '@deepseek-ai/dsh-agent', archives = sdkArchives([target, TARGET])
  const archive = archives.find(row => row.name === target)!
  archive.files['lib/index.js'] = Buffer.from(archive.files['lib/index.js'].toString() + '\nAgentRegistry.prototype.announce = async () => {};\n')
  expect(runHostContractProbe(archives, [target]).failures).toEqual(['host_contract_behavior_incompatible:' + target])
})

it('preserves observable tagged-template raw text in the program fingerprint', () => {
  const first = 'export const observed = String.raw`a`;', second = String.raw`export const observed = String.raw\`\x61\`;`.replaceAll('\\`', '`')
  const actual = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `const sources=${JSON.stringify([first, second])};const values=[];for(const source of sources)values.push((await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))).observed);console.log(JSON.stringify(values));`], { encoding: 'utf8', env: process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {} }))
  expect(actual).toEqual(['a', String.raw`\x61`])
  expect(hostProgramDigest(first)).not.toBe(hostProgramDigest(second))
})

it('rejects a ToolRuntime that silently cancels monotonic guards', () => {
  const target = '@deepseek-ai/dsh-tools', archives = sdkArchives([target, TARGET])
  const archive = archives.find(row => row.name === target)!
  archive.files['lib/index.js'] = Buffer.from(archive.files['lib/index.js'].toString() + '\nToolRuntime.prototype.guard = function () { return () => {}; };\n')
  expect(runHostContractProbe(archives, [target]).failures).not.toEqual([])
})

it('qualifies actual AgentLoop creation, resume and fork after a harmless program change', () => {
  const target = '@deepseek-ai/dsh-agent-loop', archives = sdkArchives([target, TARGET])
  const archive = archives.find(row => row.name === target)!
  archive.files['lib/index.js'] = Buffer.from(archive.files['lib/index.js'].toString() + '\nexport const compatibleLoopRevision = 1;\n')
  const result = runHostContractProbe(archives, [target])
  expect(result.failures).toEqual([])
  expect(result.checks).toEqual(expect.arrayContaining(['loop.created', 'loop.resume_unknown', 'loop.fork_unknown']))
})
it.each(['create', 'resume', 'createAgent'])('rejects broken AgentLoop %s behavior', method => {
  const target = '@deepseek-ai/dsh-agent-loop', archives = sdkArchives([target, TARGET])
  const archive = archives.find(row => row.name === target)!
  archive.files['lib/index.js'] = Buffer.from(archive.files['lib/index.js'].toString() + `\nAgentLoop.prototype.${method} = async () => undefined;\n`)
  expect(runHostContractProbe(archives, [target]).failures).not.toEqual([])
})

it.each([
  ['prepare guard boundary', 'const originalPrepare = ToolRuntime.prototype.prepareExecution; ToolRuntime.prototype.prepareExecution = function(input, next) { const original = this.guardReason; this.guardReason = () => undefined; return originalPrepare.call(this, input, next).finally(() => { this.guardReason = original }); };'],
  ['execution', 'ToolRuntime.prototype.execute = async () => ({ isError: false });'],
])('rejects broken ToolRuntime %s behavior', (_label, change) => {
  const target = '@deepseek-ai/dsh-tools', archives = sdkArchives([target, TARGET])
  const archive = archives.find(row => row.name === target)!
  archive.files['lib/index.js'] = Buffer.from(archive.files['lib/index.js'].toString() + '\n' + change)
  expect(runHostContractProbe(archives, [target]).failures).toEqual(['host_contract_behavior_incompatible:' + target])
})


function redirectedTools(mode: string, broken: boolean): ProbeArchive[] {
  const archives = sdkArchives(['@deepseek-ai/dsh-tools', TARGET])
  const target = archives.find(a => a.name === '@deepseek-ai/dsh-tools')!
  const manifest = JSON.parse(target.files['package.json'].toString())
  manifest.version = '0.2.1-rc.1'
  const entry = './lib/alternate.js'
  if (mode === 'exports') manifest.exports['.'] = entry
  if (mode === 'main') { delete manifest.exports; manifest.main = entry }
  if (mode === 'active') manifest.exports['.'] = { node: entry, default: './lib/index.js' }
  if (mode === 'inactive') manifest.exports['.'] = { 'fixture-inactive-entry': entry, default: './lib/index.js' }
  if (mode === 'no-match') manifest.exports['.'] = { 'fixture-inactive-entry': entry }
  if (mode === 'different') manifest.exports['.'] = { import: entry, require: './lib/index.js' }
  target.files['package.json'] = Buffer.from(JSON.stringify(manifest))
  target.files['lib/alternate.js'] = Buffer.from("export * from './index.js';\n" + (broken ? "import {ToolRuntime} from './index.js';ToolRuntime.prototype.guard=()=>()=>{};\n" : ''))
  return archives
}
async function acquireToolsFixture(archives: ProbeArchive[], root: string) {
  const entries = archives.map(a => { const m = JSON.parse(a.files['package.json'].toString()), bytes = fixtureTar(a.files); return { name: a.name, version: m.version as string, bytes, integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') } })
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input), m = entries.find(r => url === 'https://registry.npmjs.org/' + encodeURIComponent(r.name) + '/' + encodeURIComponent(r.version))
    if (m) return new Response(JSON.stringify({ name: m.name, version: m.version, dist: { integrity: m.integrity, tarball: 'https://registry.npmjs.org/fixture/' + encodeURIComponent(m.name) + '.tgz' } }))
    const a = entries.find(r => url === 'https://registry.npmjs.org/fixture/' + encodeURIComponent(r.name) + '.tgz')
    return a ? new Response(new Uint8Array(a.bytes)) : new Response('', { status: 404 })
  }) as typeof fetch
  return acquireHostTrust([entries.find(r => r.name === '@deepseek-ai/dsh-tools')!], fetcher, { profileRoot: root, dependencyIdentity: name => entries.find(r => r.name === name)! })
}
function toolsEntryOracle(archives: ProbeArchive[], root: string) {
  for (const a of archives) for (const [file, bytes] of Object.entries(a.files)) {
    const path = join(root, 'node_modules', a.name, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes)
  }
  const names = new Set(archives.map(a => a.name)), records: Record<string, unknown> = { '.': { url: '..', dependencies: Object.fromEntries([...names].map(name => [name, name])) } }
  for (const a of archives) { const m = JSON.parse(a.files['package.json'].toString()); records[a.name] = { url: './' + a.name, dependencies: Object.fromEntries(Object.keys({ ...m.dependencies, ...m.peerDependencies, ...m.optionalDependencies }).filter(n => names.has(n)).map(n => [n, n])) } }
  writeFileSync(join(root, 'package.json'), '{}'); writeFileSync(join(root, 'node_modules/.package-map.json'), JSON.stringify({ packages: records }))
  writeFileSync(join(root, 'oracle.mjs'), `import{Context}from '@deepseek-ai/cordis';import{SystemPrompt}from '@deepseek-ai/dsh-system-prompt';import{ToolRuntime,defineTool}from '@deepseek-ai/dsh-tools';import{Session}from '@deepseek-ai/dsh-session';const c=new Context();new SystemPrompt(c,{});const rt=new ToolRuntime(c,{});let effects=0;rt.register(defineTool({name:'effect_probe',description:'fixture',parameters:{},output:{schema:{type:'object',properties:{status:{type:'string',required:true}},additionalProperties:false},render:()=>[{type:'text',text:'ok'}]},execute:async()=>{effects++;return{status:'ok'}}}));rt.guard(()=> 'deny');const result=await rt.execute({agent:{id:'fixture',session:Session.create('fixture'),ctx:c},callId:'fixture',name:'effect_probe',arguments:{},signal:new AbortController().signal});console.log(JSON.stringify({isError:result.isError,effects}));`)
  return JSON.parse(execFileSync(process.execPath, [join(root, 'oracle.mjs')], { cwd: root, encoding: 'utf8', env: process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}, timeout: 20_000 }))
}
describe('qualification of the actual active package entry', () => {
  it.each(['exports', 'main', 'active'])('accepts a compatible %s entry and binds the full production byte/route audit', async mode => {
    const archives = redirectedTools(mode, false), root = realpathSync(mkdtempSync(join(tmpdir(), 'active-entry-positive-')))
    try {
      expect(toolsEntryOracle(archives, root)).toEqual({ isError: true, effects: 0 })
      const trust = await acquireToolsFixture(archives, root)
      const receipt = JSON.parse(readFileSync(join(root, '.dsh-completion-guard/host-contracts', trust.contract.receiptDigest + '.json'), 'utf8'))
      expect(receipt.checks).toContain('loading.import.behavior')
      expect(receipt.checks).not.toContain('reviewed_program_equivalence:@deepseek-ai/dsh-tools')
      expect(auditedHostImplementation(root, root, undefined, [...trust.packages, ...(trust.probeDependencies ?? [])])).toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it.each(['exports', 'main', 'active'])('refuses a %s entry that cancels guards although the old module is intact', async mode => {
    const archives = redirectedTools(mode, true), root = realpathSync(mkdtempSync(join(tmpdir(), 'active-entry-negative-')))
    try {
      expect(toolsEntryOracle(archives, root)).toEqual({ isError: false, effects: 1 })
      expect(runHostContractProbe(archives, ['@deepseek-ai/dsh-tools']).failures).toContain('host_contract_behavior_incompatible:@deepseek-ai/dsh-tools')
      await expect(acquireToolsFixture(archives, root)).rejects.toThrow('host_contract_behavior_incompatible:@deepseek-ai/dsh-tools')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it.each(['different', 'no-match'])('refuses %s loading branches instead of qualifying the old module', mode => {
    expect(runHostContractProbe(redirectedTools(mode, false), ['@deepseek-ai/dsh-tools']).failures).toContain('host_contract_entry_incompatible:@deepseek-ai/dsh-tools')
  })
  it('keeps an inactive bad entry harmless through actual bare imports and both loading lanes', async () => {
    const archives = redirectedTools('inactive', true), root = realpathSync(mkdtempSync(join(tmpdir(), 'inactive-entry-')))
    try {
      expect(toolsEntryOracle(archives, root)).toEqual({ isError: true, effects: 0 })
      const trust = await acquireToolsFixture(archives, root)
      expect(auditedHostImplementation(root, root, undefined, [...trust.packages, ...(trust.probeDependencies ?? [])])).toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('allows an unconsumed module while retaining reviewed entry qualification', async () => {
    const archives = redirectedTools('unused', true), root = realpathSync(mkdtempSync(join(tmpdir(), 'unused-entry-')))
    try {
      expect(toolsEntryOracle(archives, root)).toEqual({ isError: true, effects: 0 })
      const trust = await acquireToolsFixture(archives, root)
      const receipt = JSON.parse(readFileSync(join(root, '.dsh-completion-guard/host-contracts', trust.contract.receiptDigest + '.json'), 'utf8'))
      expect(receipt.checks).toContain('reviewed_program_bytes:@deepseek-ai/dsh-tools')
      expect(receipt.checks).toContain('tools.guard_denial')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

it('qualifies dependency entries through actual resolution and rejects a broken Cordis dependency', async () => {
  for (const broken of [false, true]) {
    const archives = redirectedTools('unused', false), dependency = archives.find(a => a.name === '@deepseek-ai/cordis')!
    const manifest = JSON.parse(dependency.files['package.json'].toString()); manifest.exports['.'] = './lib/alternate.js'
    dependency.files['package.json'] = Buffer.from(JSON.stringify(manifest))
    dependency.files['lib/alternate.js'] = Buffer.from("export * from './index.js';\n" + (broken ? "import {Context} from './index.js';Context.prototype.parallel=async()=>{};\n" : ''))
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dependency-entry-')))
    try {
      if (broken) await expect(acquireToolsFixture(archives, root)).rejects.toThrow('host_contract_behavior_incompatible:@deepseek-ai/cordis')
      else {
        const trust = await acquireToolsFixture(archives, root)
        expect(auditedHostImplementation(root, root, undefined, [...trust.packages, ...(trust.probeDependencies ?? [])])).toBe(false) // not yet installed
        expect(toolsEntryOracle(archives, root)).toEqual({ isError: true, effects: 0 })
        expect(auditedHostImplementation(root, root, undefined, [...trust.packages, ...(trust.probeDependencies ?? [])])).toBe(true)
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

it('records resolution-only CJS coverage when this Node cannot require ESM', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'require-capability-')))
  try {
    const archives = sdkArchives(['@deepseek-ai/dsh-tools', TARGET])
    toolsEntryOracle(archives, root)
    writeFileSync(join(root, 'package.json'), '{"type":"module"}')
    for (const module of ['host-contract-probe', 'host-node-conditions']) writeFileSync(join(root, module + '.js'), ts.transpileModule(readFileSync(join(process.cwd(), 'src/domain', module + '.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText)
    writeFileSync(join(root, 'coverage.mjs'), "import{runHostContractProbe}from './host-contract-probe.js';import{readFileSync}from'node:fs';const a=JSON.parse(readFileSync('archives.json'));for(const p of a)for(const [f,b]of Object.entries(p.files))p.files[f]=Buffer.from(b,'base64');console.log(JSON.stringify(runHostContractProbe(a,['@deepseek-ai/dsh-tools'])));")
    writeFileSync(join(root, 'archives.json'), JSON.stringify(archives.map(a => ({ name: a.name, files: Object.fromEntries(Object.entries(a.files).map(([f,b]) => [f,b.toString('base64')])) }))))
    const result = JSON.parse(execFileSync(process.execPath, ['--no-experimental-require-module', join(root, 'coverage.mjs')], { cwd: root, encoding: 'utf8', env: process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}, timeout: 20_000 }))
    expect(result.failures).toEqual([])
    expect(result.checks).toContain('loading.import.behavior')
    expect(result.checks).toContain('loading.require.behavior_unavailable')
    expect(result.checks).not.toContain('loading.require.behavior')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
