import { describe, expect, it, vi, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync, statSync, utimesSync, realpathSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync, cpSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { execFileSync } from 'node:child_process'
import { apply } from '../src/runtime.js'
import { executableIdentity } from '../src/tools/evidence.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES, type HostLockEvaluation } from '../src/domain/host-lock.js'
import { readActiveHostGraph } from '../src/domain/host-resolver.js'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../src/domain/derive.js'
import { applyPrivateLedger, readPrivateLedger } from '../src/domain/private-ledger.js'
import { createHostAuditSession } from '../src/domain/host-audit-session.js'

// Real production ENTRIES over a real rc.2-shaped host: the same session
// drives the registered checkpoint tool, the registered action tool (whose
// publish decision crosses three host-lock gates) and the registered
// completion guard, counting FULL validations through the runtime's own
// observer seam and refusing a host mutated between two consecutive entries.
// The synthetic byte-audit manifest gives the audits one real hashed module
// per package; published-tarball identity stays with v080-rc017-host.test.ts.
const { AUDITED_MODULE_TEXT, canonicalManifest } = vi.hoisted(() => ({
  AUDITED_MODULE_TEXT: 'export const auditedModule = true\n',
  canonicalManifest: (name: string, version: string) => JSON.stringify({
    name, version, exports: { '.': { types: './index.d.ts', default: './lib/index.js' } },
  }),
}))
vi.mock('../manifests/rc017-rc2-byte-audit.json', async (original) => {
  const { createHash } = await import('node:crypto')
  const auditedModuleDigest = createHash('sha256').update(AUDITED_MODULE_TEXT).digest('hex')
  const source = await original<{ default: { packages: Array<Record<string, unknown>> } }>()
  return { default: { ...source.default, packages: source.default.packages.map((p) => ({
    ...p, sha256: '0'.repeat(64), tarball: '',
    // The published audit hashes package.json too: the manifest the JSON
    // parsers read and the bytes the digest check reads are the same file.
    modules: {
      'package.json': createHash('sha256').update(canonicalManifest(p.name as string, p.version as string)).digest('hex'),
      'lib/index.js': auditedModuleDigest,
    },
  })) } }
})

const SHA = 'f'.repeat(40)
const PACKAGE = 'fixture-entry'
const VERSION = '1.0.0'
const REGISTRY = 'https://registry.example.invalid/'

const temporaryRoots: string[] = []
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rm(root, { recursive: true, force: true })
})

function makeHost() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'v081-entry-drift-')))
  temporaryRoots.push(root)
  const runtimeRoot = join(root, 'runtime')
  const profileRoot = join(root, 'profile')
  const modulesRoot = join(runtimeRoot, 'node_modules')
  mkdirSync(modulesRoot, { recursive: true })
  const packages: Record<string, { url: string; dependencies: Record<string, string> }> = {
    '.': { url: '..', dependencies: {} },
  }
  for (const [index, row] of EXPECTED_HOST_PACKAGES.entries()) {
    const id = `${row.name}@${row.version}`
    const relative = `./active/package-${index}`
    packages['.'].dependencies[row.name] = id
    packages[id] = { url: relative, dependencies: {} }
    const packageRoot = join(modulesRoot, relative)
    mkdirSync(packageRoot, { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), canonicalManifest(row.name, row.version!))
    mkdirSync(join(packageRoot, 'lib'), { recursive: true })
    writeFileSync(join(packageRoot, 'lib', 'index.js'), AUDITED_MODULE_TEXT)
  }
  mkdirSync(join(modulesRoot, '@deepseek-ai'), { recursive: true })
  for (const row of EXPECTED_HOST_PACKAGES) {
    symlinkSync(join(modulesRoot, packages[`${row.name}@${row.version}`].url), join(modulesRoot, row.name), 'junction')
  }
  writeFileSync(join(runtimeRoot, 'package.json'), '{}')
  const lockYaml = [
    "lockfileVersion: '9.0'", '', 'packages:',
    ...EXPECTED_HOST_PACKAGES.flatMap((row) => [
      `  '${row.name}@${row.version}':`,
      `    resolution: {integrity: ${row.integrity}}`,
      '',
    ]),
    'snapshots:', '',
  ].join('\n')
  writeFileSync(join(runtimeRoot, 'pnpm-lock.yaml'), lockYaml)
  writeFileSync(join(modulesRoot, '.package-map.json'), JSON.stringify({ packages }))
  const profileModules = join(profileRoot, 'node_modules')
  const sessionIndex = EXPECTED_HOST_PACKAGES.findIndex((row) => row.name === '@deepseek-ai/dsh-session')
  const sessionRow = EXPECTED_HOST_PACKAGES[sessionIndex]
  const sessionCopy = join(profileModules, '.pnpm', 'session', 'node_modules', '@deepseek-ai', 'dsh-session')
  mkdirSync(sessionCopy, { recursive: true })
  cpSync(join(modulesRoot, `./active/package-${sessionIndex}`), sessionCopy, { recursive: true })
  mkdirSync(join(profileModules, '@deepseek-ai'), { recursive: true })
  symlinkSync(sessionCopy, join(profileModules, '@deepseek-ai', 'dsh-session'), 'junction')
  mkdirSync(join(profileModules, 'plugin'), { recursive: true })
  writeFileSync(join(profileModules, 'plugin', 'package.json'), JSON.stringify({
    name: 'plugin', version: '1.0.0',
    dependencies: { '@deepseek-ai/dsh-session': sessionRow.version },
  }))
  writeFileSync(join(profileRoot, 'package.json'), '{}')
  writeFileSync(join(profileRoot, 'pnpm-lock.yaml'), [
    "lockfileVersion: '9.0'", '', 'packages:',
    `  '${sessionRow.name}@${sessionRow.version}':`,
    `    resolution: {integrity: ${sessionRow.integrity}}`,
    '', 'snapshots:', '',
  ].join('\n'))
  writeFileSync(join(profileModules, '.package-map.json'), JSON.stringify({ packages: {
    '.': { url: '..', dependencies: { plugin: 'plugin' } },
    plugin: { url: './plugin', dependencies: { '@deepseek-ai/dsh-session': `${sessionRow.name}@${sessionRow.version}` } },
    [`${sessionRow.name}@${sessionRow.version}`]: { url: './.pnpm/session/node_modules/@deepseek-ai/dsh-session', dependencies: {} },
  } }))
  const rows = readActiveHostGraph(runtimeRoot, profileRoot)
  return {
    root, runtimeRoot, profileRoot, packages, rows,
    sessionPackageDir: join(modulesRoot, `./active/package-${sessionIndex}`),
    config: {
      activation: 'always' as const,
      policy: 'release' as const,
      hostLockPolicy: 'dsh-core/v1',
      hostLockRuntimeRoot: runtimeRoot,
      hostLockProfileRoot: profileRoot,
      hostLockPlatform: 'posix' as const,
      hostLockProfile: 'headless' as const,
      hostLockPackages: rows,
    },
  }
}

/** Same byte count and mtime, different bytes: no metadata fingerprint may
 * stand in for the audited bytes. */
function driftSessionBytes(host: ReturnType<typeof makeHost>): { original: string; stamp: { atime: Date; mtime: Date } } {
  const entry = join(host.sessionPackageDir, 'lib', 'index.js')
  const original = readFileSync(entry, 'utf8')
  const stamp = { atime: statSync(entry).atime, mtime: statSync(entry).mtime }
  const mutated = original.replace('true', 'fals')
  expect(mutated).toHaveLength(original.length)
  expect(mutated).not.toBe(original)
  return { original, stamp }
}

function applyDrift(host: ReturnType<typeof makeHost>, original: string, stamp: { atime: Date; mtime: Date }): void {
  const entry = join(host.sessionPackageDir, 'lib', 'index.js')
  writeFileSync(entry, original.replace('true', 'fals'))
  utimesSync(entry, stamp.atime, stamp.mtime)
}

function restoreSessionBytes(host: ReturnType<typeof makeHost>, original: string, stamp: { atime: Date; mtime: Date }): void {
  const entry = join(host.sessionPackageDir, 'lib', 'index.js')
  writeFileSync(entry, original)
  utimesSync(entry, stamp.atime, stamp.mtime)
}

interface RegisteredTool {
  name: string
  execute?: (args: never, exec: never) => Promise<Record<string, unknown>>
  output?: { presentationMeta?: (args: unknown, value: unknown) => unknown }
}

function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('000644 \0', 100, 8, 'ascii')
  header.write('000000 \0', 108, 8, 'ascii')
  header.write('000000 \0', 116, 8, 'ascii')
  header.write(`${size.toString(8).padStart(11, '0')} `, 124, 12, 'ascii')
  header.write('00000000000 ', 136, 8, 'ascii')
  header.write('        ', 148, 8, 'ascii')
  header.write('0', 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return header
}

async function packFixture(root: string, name: string, version: string, gitHead: string): Promise<string> {
  const output = join(root, 'packs')
  await mkdir(output, { recursive: true })
  const manifest = Buffer.from(JSON.stringify({
    name, version, files: ['index.js'], gitHead,
    repository: { type: 'git', url: 'https://github.com/GreenLv/dsh-completion-guard.git' },
  }), 'utf8')
  const padding = Buffer.alloc((512 - (manifest.length % 512)) % 512)
  const tar = Buffer.concat([
    tarHeader('package/package.json', manifest.length), manifest, padding,
    tarHeader('package/index.js', 3), Buffer.from('x\n\n', 'utf8'),
    Buffer.alloc(1024),
  ])
  const path = join(output, `${name}-${version}.tgz`)
  await writeFile(path, gzipSync(tar, { level: 9 }))
  return path
}

function execution(session: Session, callId: string, name: string) {
  return {
    callId, rootCallId: callId, name, arguments: {},
    agent: { session }, signal: new AbortController().signal,
    deferContext: () => {}, concludeTurn: () => {}, token: Symbol('test'),
  } as never
}

function append(session: Session, type: string, data: unknown, options?: unknown): void {
  ;(session as unknown as { append(type: string, data: unknown, options?: unknown): void }).append(type, data, options)
}

function notice(session: Session, text: string): void {
  append(session, 'user/message', {
    source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice' },
    content: [{ type: 'text', text }],
  }, { surfaceOp: 'append' })
}

function command(session: Session, args: string): void {
  append(session, 'command/run', { commandId: `cmd-${session.seq}`, name: 'context-guard', args, source: { kind: 'user' } })
}

async function runTool(
  session: Session,
  tools: RegisteredTool[],
  name: string,
  callId: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const tool = tools.find((entry) => entry.name === name)!
  append(session, 'tool/call', { turn: 1, step: session.seq, callId, name, arguments: JSON.stringify(args) })
  const value = await tool.execute!(args as never, execution(session, callId, name)) as Record<string, unknown>
  const meta = tool.output?.presentationMeta?.(args, value)
  append(session, 'tool/result', {
    turn: 1, step: session.seq,
    message: createToolResultMessage({ callId: callId as never, content: [{ type: 'text', text: JSON.stringify(value) }], isError: false }),
    ...(meta ? { meta } : {}),
  }, { surfaceOp: 'append' })
  return value
}

function projectionOf(session: Session, ledgerRoot: string) {
  const projection = deriveProjection(session.snapshotEvents() as never,
    { activation: 'always', policy: 'release' }, { cwd: String(session.header.cwd) }, true).projection
  applyPrivateLedger(projection, readPrivateLedger(ledgerRoot, {
    sessionId: String(session.id),
    sessionHeader: structuredClone(session.header) as unknown as Record<string, unknown>,
    cwd: String(session.header.cwd), hostLockDigest: '',
  }))
  return projection
}

function startRuntime(session: Session, host: ReturnType<typeof makeHost>, seams: {
  commandRunner?: () => Promise<void>
  fetcher?: typeof fetch
  privateLedgerRoot: string
  onAsyncPreparation?: () => void
  readExecutableIdentity?: typeof executableIdentity
  onAudit?: (count: number) => void
}) {
  const tools: RegisteredTool[] = []
  const guards: Array<(exec: { name?: string; arguments?: unknown }) => string | undefined> = []
  const handlers = new Map<string, Array<(payload: unknown) => unknown>>()
  // A pinned-shaped update_goal tool and a Goal service readback make the
  // live Goal binding agree with the audited graph, exactly as a real rc.2
  // host with the Goal pair would.
  const fakeUpdateGoal = {
    name: 'update_goal',
    parameters: { type: 'object', required: ['action', 'goal_id', 'revision'], properties: {
      action: { type: 'string', enum: ['edit', 'pause', 'resume', 'complete', 'blocked'] },
      goal_id: { type: 'string' }, revision: { type: 'number' },
      blocked_reason: { type: 'string' }, max_goal_rounds: { type: 'number' }, objective: { type: 'string' },
    } },
    execute: async () => ({}),
  }
  const goalsService = { get: () => undefined, disarm: () => undefined }
  const ctx = {
    commands: { register: () => () => {} },
    on: (name: string, handler: unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), handler as never]); return () => {} },
    get: (name: string) => name === 'goals' ? goalsService : undefined,
    sessions: { flush: async () => { seams.onAsyncPreparation?.(); return true } },
  }
  const validations: number[] = []
  apply(ctx as never, { ...host.config }, {
    ...(seams.commandRunner ? { commandRunner: seams.commandRunner } : {}),
    ...(seams.fetcher ? { fetcher: seams.fetcher } : {}),
    ...(seams.readExecutableIdentity ? { readExecutableIdentity: seams.readExecutableIdentity } : {}),
    allowLoopbackHttpRegistry: true,
    privateLedgerRoot: seams.privateLedgerRoot,
    onHostLockValidation: () => {
      validations.push(1)
      seams.onAudit?.(validations.length)
    },
  })
  const agent = {
    session,
    steer: () => {},
    ctx: {
      tools: {
        register: (tool: RegisteredTool) => { tools.push(tool); return () => {} },
        guard: (callback: (exec: { name?: string; arguments?: unknown }) => string | undefined) => { guards.push(callback); return () => {} },
        get: (name: string) => name === 'update_goal' ? fakeUpdateGoal : undefined,
      },
      get: (name: string) => name === 'goals' ? goalsService : undefined,
    },
  }
  for (const handler of handlers.get('agent/created') ?? []) {
    (handler as (payload: unknown) => void)({ agent, source: 'startup' })
  }
  return { tools, guards, validations, agent: agent as unknown as Agent }
}

/**
 * One publish chain over the real apply() wiring, reusable by several
 * entry-level failure tests. The fetcher can observe the registry readback
 * moment, which is the async read-only preparation inside the publish entry.
 */
async function publishChain(setup: {
  onAsyncPreparation?: () => void
  withRef?: boolean
  onIdentityRead?: (executable: string) => void
  onAudit?: (count: number) => void
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cg-entry-'))
  temporaryRoots.push(root)
  const host = makeHost()
  const published: string[][] = []
  const registryState = { integrity: `sha512-${Buffer.alloc(64, 5).toString('base64')}` }
  const fetcher = (async (input: string | URL) => {
    const url = String(input)
    if (!url.startsWith(REGISTRY)) return new Response('{}', { status: 404 })
    const name = decodeURIComponent(url.slice(REGISTRY.length).replace(/\/+$/, ''))
    return new Response(JSON.stringify({
      name,
      versions: { [VERSION]: { name, version: VERSION, dist: { integrity: registryState.integrity } } },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  if (setup.withRef) {
    // A real repository so the adopted contract's ref resolves through the
    // production git path inside the release gate.
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    git(['init', '-b', 'main'])
    git(['config', 'user.email', 'chain@example.invalid'])
    git(['config', 'user.name', 'chain'])
    writeFileSync(join(root, 'README.md'), 'chain\n')
    git(['add', 'README.md'])
    git(['commit', '-m', 'chain'])
  }
  const headSha = setup.withRef
    ? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    : SHA
  const tgz = await packFixture(root, PACKAGE, VERSION, headSha)
  const session = Session.create(SessionId('entry-drift'), undefined, {
    version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId('entry-drift'), createdAt: 1, cwd: root,
  })
  const runtime = startRuntime(session, host, {
    commandRunner: async () => { published.push([]) },
    fetcher, privateLedgerRoot: join(root, 'private-ledger'),
    onAsyncPreparation: setup.onAsyncPreparation,
    onAudit: setup.onAudit,
    // The hook observes the executable-identity reads; the release gate's ref
    // resolution reads the GIT identity between its fresh validation and the
    // effect on the pre-fix runtime.
    readExecutableIdentity: setup.onIdentityRead
      ? async (executable, signal) => {
        setup.onIdentityRead!(executable)
        return executableIdentity(executable, signal)
      }
      : undefined,
  })
  const { tools, guards, validations } = runtime
  const byName = (name: string) => tools.find((tool) => tool.name === name)!
  expect(byName('context_guard_action')).toBeDefined()
  // Startup attach performed exactly one full validation.
  expect(validations).toHaveLength(1)

  notice(session, PROTOCOL_V5_NOTICE)
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '创建 report.txt' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  command(session, 'clear')

  const closure = await runTool(session, tools, 'context_guard_checkpoint', 'closure', { bindings: [] })
  expect(closure.status, JSON.stringify(closure)).toBe('certified')
  expect(validations).toHaveLength(2)

  const resolution = await runTool(session, tools, 'context_guard_evidence', 'chain-resolution', {
    semantic_action: 'publish', evidence_role: 'resolution',
    selector: { artifact_id: PACKAGE, version: VERSION, registry: REGISTRY },
    command_manifest: { manifest_id: 'npm.publish_tgz.v1', tgz_path: tgz },
  }) as unknown as { status: string; resolved_target: Record<string, string>; target_digest: string }
  expect(resolution.status, JSON.stringify(resolution)).toBe('supported')
  const sri = resolution.resolved_target.integrity_digest
  const artifactSha256 = createHash('sha256').update(readFileSync(tgz)).digest('hex')
  command(session, `release adopt ${JSON.stringify({
    contractId: 'rel-entry', operations: ['npm_publish'],
    candidate: { fullSha40: headSha, repository: 'https://github.com/GreenLv/dsh-completion-guard.git',
      packageId: PACKAGE, version: VERSION, artifactSha256, artifactSri: sri, registry: REGISTRY,
      ...(setup.withRef ? { ref: 'refs/heads/main' } : {}) },
    readinessRefs: [], closureCertRef: 'C1',
  })}`)
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `Publish package ${PACKAGE} version ${VERSION} registry ${REGISTRY}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const releaseItem = [...projectionOf(session, join(root, 'private-ledger')).items.values()]
    .find((entry) => entry.status === 'pending' && entry.semanticAction === 'publish')
  expect(releaseItem, 'the release instruction captured a publish obligation').toBeDefined()
  return {
    root, host, session, tools, guards, validations, published, registryState,
    resolution: resolution as { status: string; resolved_target: Record<string, string>; target_digest: string },
    releaseItem: releaseItem!,
    action: (callId: string) => runTool(session, tools, 'context_guard_action', callId, {
      semantic_action: 'publish', resolution_call_id: 'chain-resolution',
      target_digest: resolution.target_digest, contract_item_id: releaseItem!.id, contract_item_revision: releaseItem!.revision,
    }),
  }
}

describe('real production entries validate freshly and share one audit per decision', () => {
  it('charges one validation to the checkpoint entry and one to the whole publish entry, and refuses drift between entries', async () => {
    const chain = await publishChain()
    const { host, session, tools, guards, validations, published } = chain
    void session; void tools

    expect(validations, 'after evidence resolution and adoption').toHaveLength(2)
    // Drift between the certification entry and the publish entry: the action
    // entry validates freshly and refuses fail-closed before any effect.
    const drift = driftSessionBytes(host)
    applyDrift(host, drift.original, drift.stamp)
    const refused = await chain.action('drifted-action')
    expect(refused.status, JSON.stringify(refused)).toBe('unavailable')
    expect(refused.reason_code).toBe('host_capability_unavailable')
    expect(published).toHaveLength(0)
    expect(validations).toHaveLength(3)
    restoreSessionBytes(host, drift.original, drift.stamp)

    // A publish decision crosses THREE host-lock gates — capability check,
    // mutation authorization, release pre-effect — plus the FINAL pre-effect
    // veto taken after the effect path's last await: two full validations for
    // the whole entry, the second of which is the one the effect obeys.
    const value = await chain.action('chain-action')
    if (value.status !== 'completed') {
      throw new Error(`publish did not complete: ${JSON.stringify(value)}`)
    }
    expect(published).toHaveLength(1)
    expect(validations).toHaveLength(5)

    // The completion guard is its own entry: it validates freshly for exactly
    // the update_goal(complete) calls and refuses a drifted host.
    expect(guards).toHaveLength(1)
    applyDrift(host, drift.original, drift.stamp)
    const denial = guards[0]!({ name: 'update_goal', arguments: { action: 'complete', goal_id: 'g', revision: 1 } })
    expect(denial).toContain('stale_host')
    expect(validations).toHaveLength(6)
    // A guard on an unrelated tool never pays for an audit.
    expect(guards[0]!({ name: 'bash', arguments: {} })).toBeUndefined()
    expect(validations).toHaveLength(6)
    restoreSessionBytes(host, drift.original, drift.stamp)
  })

  it('refuses publish when the host drifts after the last audit, before the effect starts', async () => {
    // The release gate resolves the adopted contract's ref through a real git
    // subprocess — an await INSIDE the gate, after its fresh validation on the
    // pre-fix runtime and before the effect. Same byte count and mtime,
    // different audited bytes: drift landing in that window must never let the
    // effect start.
    let armed = false
    let drifted = false
    const chain = await publishChain({
      withRef: true,
      onIdentityRead: (executable) => {
        if (!armed || executable !== 'git' || drifted) return
        drifted = true
        const d = driftSessionBytes(chain.host)
        applyDrift(chain.host, d.original, d.stamp)
      },
    })
    armed = true
    const value = await chain.action('pre-effect-drift-action')
    expect(value.status, JSON.stringify(value)).toBe('unavailable')
    expect(chain.published).toHaveLength(0)
    // Refused with-ref entry: capability stretch + the release gate's own
    // fresh validation after the ref-resolution await = 2 audits.
    expect(chain.validations).toHaveLength(4)
    const stamp = { atime: statSync(join(chain.host.sessionPackageDir, 'lib', 'index.js')).atime,
      mtime: statSync(join(chain.host.sessionPackageDir, 'lib', 'index.js')).mtime }
    restoreSessionBytes(chain.host, AUDITED_MODULE_TEXT, stamp)
    // A SUCCESSFUL with-ref publish costs THREE full validations for the
    // entry: the capability stretch, the release gate after the ref await,
    // and the final pre-effect veto after the tgz readback.
    const ok = await chain.action('with-ref-success')
    expect(ok.status, JSON.stringify(ok)).toBe('completed')
    expect(chain.published).toHaveLength(1)
    expect(chain.validations).toHaveLength(7)
  })

  it('refuses post-reservation drift through the wired final veto', async () => {
    let chain: Awaited<ReturnType<typeof publishChain>>
    chain = await publishChain({ onAudit: (count) => {
      if (count !== 3) return
      queueMicrotask(() => {
        const d = driftSessionBytes(chain.host)
        applyDrift(chain.host, d.original, d.stamp)
      })
    } })
    const value = await chain.action('post-reservation-drift')
    expect({ status: value.status, effects: chain.published.length }).toEqual({ status: 'unavailable', effects: 0 })
  })

  it('refuses publish when the host drifts during the entry\'s async preparation', async () => {
    // The durability flush is the publish entry's first async await, before
    // the host-lock gates. Same byte count and mtime, different audited
    // bytes: the drift lands inside the entry, before its final host-lock
    // judgement — an audit taken before the await must not authorize the
    // effect.
    let armed = false
    const chain = await publishChain({
      onAsyncPreparation: () => {
        if (!armed) return
        const d = driftSessionBytes(chain.host)
        applyDrift(chain.host, d.original, d.stamp)
      },
    })
    armed = true
    const value = await chain.action('mid-preparation-action')
    expect(value.status, JSON.stringify(value)).toBe('unavailable')
    expect(chain.published).toHaveLength(0)
    expect(chain.validations, 'the entry still validates for its own decision').toHaveLength(3)
  })
})
