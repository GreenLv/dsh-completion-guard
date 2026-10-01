import { expect, it, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { execFileSync } from 'node:child_process'
import { apply } from '../src/runtime.js'
import { executableIdentity } from '../src/tools/evidence.js'
import { EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../src/domain/derive.js'
import { applyPrivateLedger, readPrivateLedger } from '../src/domain/private-ledger.js'

// Real production entries over explicit graph roots. Source calls register the
// same tools, guards and Stop handler as production; onHostLockValidation
// observes completed validations. No byte-audit fixture or replacement is used.
// Session persistence and external publish effects are isolated in temp roots.
interface RegisteredTool {
  name: string
  execute?: (args: never, exec: never) => Promise<Record<string, unknown>>
  output?: { presentationMeta?: (args: unknown, value: unknown) => unknown }
}

const SHA = 'f'.repeat(40)
const PACKAGE = 'fixture-entry'
const VERSION = '1.0.0'
const REGISTRY = 'https://registry.example.invalid/'

const temporaryRoots: string[] = []
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rm(root, { recursive: true, force: true })
})

function makeHost() {
  const runtimeRoot = process.env.DSH_MEASURE_RUNTIME!, profileRoot = process.env.DSH_MEASURE_PROFILE!
  if (!runtimeRoot || !profileRoot) throw new Error('measurement requires explicit installed/synthetic graph roots')
  // CG-083-VAL02: the measured cohort is declared explicitly. `web` and
  // `desktop` name their own profile kinds; anything else is `headless` and
  // must never silently pose as a Desktop measurement. The Desktop entry is a
  // real installed-app entry only: it measures the official app archive
  // (app.asar) against the digest the installed lock was injected with, which
  // the driver passes through DSH_MEASURE_DESKTOP_DIGEST.
  const kind = process.env.DSH_MEASURE_KIND === 'web' ? 'web' as const
    : process.env.DSH_MEASURE_KIND === 'desktop' ? 'desktop' as const : 'headless' as const
  if (kind === 'desktop' && !process.env.DSH_MEASURE_DESKTOP_DIGEST) {
    throw new Error('desktop measurement requires the injected DSH_MEASURE_DESKTOP_DIGEST')
  }
  return { runtimeRoot, profileRoot, config: {
    activation: 'always' as const, policy: 'release' as const, hostLockPolicy: 'dsh-core/v1',
    hostLockRuntimeRoot: runtimeRoot, hostLockProfileRoot: profileRoot,
    hostLockPlatform: process.platform === 'win32' ? 'windows' as const : 'posix' as const,
    hostLockProfile: kind,
    hostLockPackages: EXPECTED_HOST_PACKAGES,
    ...(kind === 'desktop' ? { hostLockDesktopDigest: process.env.DSH_MEASURE_DESKTOP_DIGEST } : {}),
  } }
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
  // live Goal binding agree with the audited graph, exactly as a real rc.1
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
  return { tools, guards, validations, handlers, agent: agent as unknown as Agent }
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
  const mountStart = performance.now()
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
  measurements.push({ entry: setup.withRef ? 'second_mount' : 'cold_mount', wall_ms: performance.now() - mountStart, audits: runtime.validations.length })
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

  const checkpointStart = performance.now()
  const checkpointCount = validations.length
  const closure = await runTool(session, tools, 'context_guard_checkpoint', 'closure', { bindings: [] })
  measurements.push({ entry: setup.withRef ? 'second_checkpoint' : 'checkpoint', wall_ms: performance.now() - checkpointStart, audits: validations.length - checkpointCount })
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
    root, host, session, tools, guards, validations, published, registryState, runtime,
    resolution: resolution as { status: string; resolved_target: Record<string, string>; target_digest: string },
    releaseItem: releaseItem!,
    action: (callId: string) => runTool(session, tools, 'context_guard_action', callId, {
      semantic_action: 'publish', resolution_call_id: 'chain-resolution',
      target_digest: resolution.target_digest, contract_item_id: releaseItem!.id, contract_item_revision: releaseItem!.revision,
    }),
  }
}

const measurements: Array<{ entry: string; wall_ms: number; audits: number }> = []

it.skipIf(!process.env.DSH_MEASURE_RUNTIME)('measures actual production entries over an explicit graph', async () => {
  const chain = await publishChain()
  const measure = async (entry: string, run: () => unknown) => {
    const before = chain.validations.length, start = performance.now()
    await run()
    measurements.push({ entry, wall_ms: performance.now() - start, audits: chain.validations.length - before })
  }
  await measure('ordinary_replay', () => {
    for (const handler of chain.runtime.handlers.get('agent/created') ?? []) {
      (handler as (payload: unknown) => void)({ agent: chain.runtime.agent, source: 'resume' })
    }
  })
  await measure('publish_no_ref', async () => {
    const result = await chain.action('measurement-publish')
    expect(result.status, JSON.stringify(result)).toBe('completed')
    expect(chain.published).toHaveLength(1)
  })
  await measure('goal_complete_guard', () => {
    chain.guards[0]({ name: 'update_goal', arguments: { action: 'complete', goal_id: 'measure', revision: 1 } })
  })
  await measure('turn_stop', async () => {
    for (const handler of chain.runtime.handlers.get('agent/turn-stopping') ?? []) {
      await (handler as (payload: unknown) => unknown)({ agent: chain.runtime.agent })
    }
  })
  const withRef = await publishChain({ withRef: true })
  const before = withRef.validations.length, start = performance.now()
  const result = await withRef.action('measurement-with-ref')
  expect(result.status, JSON.stringify(result)).toBe('completed')
  expect(withRef.published).toHaveLength(1)
  measurements.push({ entry: 'publish_with_ref', wall_ms: performance.now() - start, audits: withRef.validations.length - before })
  const expected: Record<string, number> = { cold_mount: 1, ordinary_replay: 0, checkpoint: 1, publish_no_ref: 2, publish_with_ref: 3, goal_complete_guard: 1, turn_stop: 1 }
  for (const [entry, count] of Object.entries(expected)) expect(measurements.find((m) => m.entry === entry)?.audits, entry).toBe(count)
  console.log('DSH_HOST_MEASUREMENT=' + JSON.stringify({ node: process.version, platform: process.platform,
    graph_kind: process.env.DSH_MEASURE_GRAPH_KIND ?? 'unclassified', profile: process.env.DSH_MEASURE_KIND, measurements }))
}, 60_000)
