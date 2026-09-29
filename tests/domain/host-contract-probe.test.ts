import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runHostContractProbe, type ProbeArchive } from '../../src/domain/host-contract-probe.js'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { acquireHostTrust, qualifyHostTrust } from '../../src/domain/host-trust.js'
import { hostProgramDigest } from '../../src/domain/host-contract-program.js'

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
