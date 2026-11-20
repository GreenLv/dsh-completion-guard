/** Execute an explicitly preserved predecessor build; never use current writers. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1])
const directory = resolve(args.get('--module-dir') ?? '')
const commit = args.get('--source-commit')
const output = args.get('--output')
const anchor = args.get('--sdk-anchor')
const predecessor = args.get('--predecessor-version') ?? '0.13.0'
assert.ok(args.get('--module-dir') && anchor && output && /^[a-f0-9]{40}$/.test(commit ?? ''),
  'required: --module-dir <old dist> --source-commit <full SHA> --sdk-anchor <old SDK package.json> --output <new JSON>')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
function inventory(root, prefix = 'dist') {
  return Object.fromEntries(readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(row => row.isDirectory() ? Object.entries(inventory(join(root, row.name), `${prefix}/${row.name}`))
      : [[`${prefix}/${row.name}`, sha(readFileSync(join(root, row.name)))]]))
}
const moduleHashes = inventory(directory)
const published = {
  '0.13.1': {
    sourceCommit: '38ea950380fffda88d9b48d5cdedd2c6ba6f0c61',
    sha256: 'db1471029c06e535bf2da0e431ecd484f29c1e2e3509d134696bec8334b11075',
    sdkRc: 'rc2',
    candidateId: '132',
  },
  '0.13.2': {
    sourceCommit: '9935379fd92b72ffe88845c1fcb9a831f4d303c2',
    sha256: 'b908296b444d6a242baccc81daf6a920caa04b968cf56bf79a4e8e8c4a13b2c5',
    sdkRc: 'rc3',
    candidateId: '133',
  },
}
const predecessorIdentity = Object.hasOwn(published, predecessor) ? published[predecessor] : undefined
if (predecessorIdentity) {
  const tgz = args.get('--predecessor-tgz')
  assert.ok(tgz, `${predecessor} requires the exact published predecessor tgz`)
  assert.equal(commit, predecessorIdentity.sourceCommit)
  assert.equal(sha(readFileSync(tgz)), predecessorIdentity.sha256)
  const pkg = JSON.parse(execFileSync('tar', ['-xOf', tgz, 'package/package.json'], { encoding: 'utf8' }))
  assert.equal(pkg.version, predecessor); assert.equal(pkg.gitHead, commit)
  const names = execFileSync('tar', ['-tf', tgz], { encoding: 'utf8' }).trim().split('\n').filter(name => name.startsWith('package/dist/')).sort()
  assert.deepEqual(names, Object.keys(moduleHashes).map(name => `package/${name}`).sort())
  for (const name of names) assert.equal(sha(execFileSync('tar', ['-xOf', tgz, name], { maxBuffer: 16 * 1024 * 1024 })), moduleHashes[name.slice('package/'.length)])
} else assert.equal(predecessor, '0.13.0')
const old = await import(pathToFileURL(join(directory, 'domain/index.js')).href)
const sdk = createRequire(resolve(anchor))
const sdkRc = predecessorIdentity?.sdkRc ?? 'rc1'
const sdkVersion = `0.2.2-rc.${sdkRc.slice(2)}`
const audited = JSON.parse(readFileSync(new URL(`../manifests/rc022-${sdkRc}-byte-audit.json`, import.meta.url), 'utf8'))
const sdkModules = {}
for (const name of ['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-persistence-jsonl', '@deepseek-ai/dsh-llm']) {
  const base = dirname(sdk.resolve(`${name}/package.json`))
  const row = audited.packages.find(row => row.name === name)
  assert.equal(JSON.parse(readFileSync(join(base, 'package.json'))).version, sdkVersion)
  for (const [file, digest] of Object.entries(row.modules)) assert.equal(sha(readFileSync(join(base, file))), digest)
  sdkModules[name] = { version: row.version, integrity: row.integrity, modules: row.modules }
}
const { Context } = await import(pathToFileURL(sdk.resolve('@deepseek-ai/cordis')).href)
const persistence = await import(pathToFileURL(sdk.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href)
const { createUserMessage } = await import(pathToFileURL(sdk.resolve('@deepseek-ai/dsh-llm')).href)
const temporary = mkdtempSync(join(tmpdir(), 'guard-predecessor-recorder-'))
const rows = []
try {
  for (const profile of ['web', 'headless', 'desktop']) for (const mode of ['opt-in', 'always']) {
    const header = { version: 4, id: `guard-v${predecessorIdentity?.candidateId ?? '131'}-predecessor-${profile}-${mode}`, createdAt: 1, isSeeded: false, delegationDepth: 0 }
    const identity = old.sessionBirthIdentity(header, 0)
    const source = mode === 'opt-in' ? 'legacy_adoption' : 'fresh_creation'
    const provenance = sha(`synthetic predecessor ${profile} ${mode}`)
    assert.equal(old.writeActivationBinding(temporary, identity, mode, source, provenance).status, 'bound')
    const bytes = readFileSync(old.activationBindingPath(temporary, identity.id))
    const messages = ['Keep the first synthetic upgrade task pending.', 'Keep the second synthetic upgrade task pending.']
    const logs = {}
    for (const compression of ['none', 'zstd']) {
      const ctx = new Context()
      await ctx.plugin(persistence.apply ?? persistence.default ?? persistence, { root: join(temporary, 'logs', profile, mode, compression), compression }).await()
      try {
        const handle = await ctx.sessionPersistence.create(header)
        try {
          await handle.append(messages.map((text, seq) => ({ seq, time: 1 + seq, type: 'user/message', surfaceOp: 'append',
            data: { ...createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), id: `${header.id}-message-${seq}` } })))
          await handle.flush()
        } finally { await handle.close() }
        const location = (await ctx.sessionPersistence.stat(header.id)).location
        assert.equal(location.kind, 'jsonl')
        const physical = readFileSync(location.path)
        const reader = await ctx.sessionPersistence.open(header.id, 'read')
        try { assert.equal((await reader.read()).events.length, 2) } finally { await reader.close() }
        logs[compression] = { bytes: physical.toString('base64'), sha256: sha(physical) }
      } finally { await ctx.fiber.dispose() }
    }
    rows.push({ profile, mode, header, binding: bytes.toString('utf8'), bindingSha256: sha(bytes), messages, logs })
  }
  const fixture = { schema: 'dsh-predecessor-activation-fixture/v1', predecessorVersion: predecessor,
    sourceCommit: commit, writerEntry: 'dist/domain/index.js', moduleHashes, sdkModules,
    ...(predecessorIdentity ? { predecessorTgzSha256: predecessorIdentity.sha256 } : {}),
    boundary: `Bindings emitted by Guard ${predecessor}; physical none/zstd logs emitted and reopened by the audited DSH ${sdkVersion} backend. Messages are synthetic upgrade inputs, not captured user history.`, rows }
  writeFileSync(output, JSON.stringify(fixture, null, 2) + '\n', { flag: 'wx' })
} finally { rmSync(temporary, { recursive: true, force: true }) }
