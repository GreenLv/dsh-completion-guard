import { createRequire } from 'node:module'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION, Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { createRuntime, apply, handleGuardTurnStopping, revalidateCoreLock } from '../src/runtime.js'
import { readActiveHostGraph } from '../src/domain/host-resolver.js'
import { createHostAuditSession, type HostAuditSession } from '../src/domain/host-audit-session.js'
import { DEFAULT_HOST_LOCK, evaluateHostLock, EXPECTED_HOST_PACKAGES, type HostLockEvaluation } from '../src/domain/host-lock.js'

// This family isolates the host-lock validation BOUNDARY: how many full
// validations one attach, one resume, one plain sync, and two adjacent
// security-sensitive entries perform, and that a host mutated between two
// consecutive authorized entries is refused by the second one. Published-byte
// integrity against the real rc.2 tarballs stays with v080-rc017-host.test.ts;
// here the byte-audit manifest is narrowed to one synthetic audited module per
// package so the byte-hash, export, route and symlink checks run for real.
const { AUDITED_MODULE_TEXT, canonicalManifest } = vi.hoisted(() => ({
  AUDITED_MODULE_TEXT: 'export const auditedModule = true\n',
  canonicalManifest: (name: string, version: string) => JSON.stringify({
    name, version, exports: { '.': { types: './index.d.ts', default: './lib/index.js' } },
  }),
}))
vi.mock('../manifests/rc020-rc1-byte-audit.json', async (original) => {
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

const temporaryRoots: string[] = []
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * A synthetic but fully exercised rc.2-shaped host: the complete audited
 * cohort reachable from the runtime importer, junction symlinks for the native
 * bare route, real hashed module bytes, and a profile half with its own
 * importer. Returns the rows the graph produces so callers pin the expected
 * lock digest.
 */
function makeHost() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'v081-entry-validation-')))
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
  // The profile half carries its own importer with a mapped, byte-identical
  // critical copy, so the audits walk both graphs and the profile's native
  // route check is exercised exactly like a real plugin profile.
  const profileModules = join(profileRoot, 'node_modules')
  const sessionIndex = EXPECTED_HOST_PACKAGES.findIndex((row) => row.name === '@deepseek-ai/dsh-session')
  const sessionRow = EXPECTED_HOST_PACKAGES[sessionIndex]
  const sessionCopy = join(profileModules, '.pnpm', 'session', 'node_modules', '@deepseek-ai', 'dsh-session')
  mkdirSync(sessionCopy, { recursive: true })
  cpSync(join(modulesRoot, `./active/package-${sessionIndex}`), sessionCopy, { recursive: true })
  // The native search route for the plugin importer must reach the mapped
  // copy: the bare junction is the legitimate profile route.
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
  const config = {
    activation: 'always' as const,
    hostLockPolicy: 'dsh-core/v1',
    hostLockRuntimeRoot: runtimeRoot,
    hostLockProfileRoot: profileRoot,
    hostLockPlatform: 'posix' as const,
    hostLockProfile: 'headless' as const,
  }
  return { root, runtimeRoot, profileRoot, packages, rows, config }
}

/** The expected lock for the fixture: same rows, same digest composition. */
function expectedLockFor(host: ReturnType<typeof makeHost>): HostLockEvaluation {
  return evaluateHostLock(host.rows, { platform: 'posix', profileKind: 'headless' })
}

function fakeAgent(session: Session): Agent {
  return { id: session.id, session, status: 'idle', steer: () => {} } as unknown as Agent
}

function sessionWithId(id: string, createdAt: number): Session {
  return Session.create(SessionId(id), undefined, {
    version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId(id), createdAt, cwd: '/work/repo',
  })
}

function pluginHost(config: Record<string, unknown>, hostRows: unknown[], onValidation: () => void):
  { ctx: Context; registry: AgentRegistry; agent: Agent } {
  const ctx = new Context()
  const registry = new AgentRegistry(ctx)
  new SessionStore(ctx)
  new LocalFileSystem(ctx, { cwd: process.cwd(), diffBasisMaxBytes: 10485760 })
  new SystemPrompt(ctx, {} as never)
  new ToolRuntime(ctx, {})
  new CommandRuntime(ctx)
  const session = sessionWithId('v081-plugin', 1)
  const rawAgent = { id: session.id, session, ctx, status: 'idle', steer: () => {} }
  apply(ctx, { ...config, hostLockPackages: hostRows }, { onHostLockValidation: onValidation })
  return { ctx, registry, agent: rawAgent as unknown as Agent }
}

describe('one attach performs exactly one full host-lock validation', () => {
  it('shares the attach validation across plain syncs, and validates once per fresh entry', () => {
    let counter = 0
    // The initial lock is an explicit input: createRuntime's first rebuild
    // consumes it and never rescans on its own. apply() performs the one
    // attach-time validation (see the next test).
    const runtime = createRuntime(fakeAgent(sessionWithId('v081-count', 1)), { activation: 'always' },
      DEFAULT_HOST_LOCK, undefined, () => { counter += 1; return DEFAULT_HOST_LOCK })
    expect(counter).toBe(0)
    // Plain projection refreshes — pre-step, resume replay, command readback,
    // event replay — consume the shared result without rescanning the host.
    runtime.sync()
    runtime.sync()
    // Toggling protection keeps its historical fresh validation.
    runtime.setEnabled(false)
    expect(counter).toBe(1)
    runtime.sync()
    expect(counter).toBe(1)
    // Each security-sensitive entry validates freshly, once per entry.
    runtime.sync({ revalidateHostLock: true })
    runtime.sync({ revalidateHostLock: true })
    expect(counter).toBe(3)
  })

  it('performs one validation per startup attach and one per resume attach, with no extra scans', async () => {
    const host = makeHost()
    let validations = 0
    const { registry, agent } = pluginHost({ ...host.config }, host.rows, () => { validations += 1 })
    const detach = await registry.register(agent)
    // Startup attach: ensure → createRuntime → attach.sync is ONE validation.
    expect(validations).toBe(1)
    detach()
    // A resume-sourced attach goes through the same single validation; the
    // resume replay itself adds none.
    const { registry: registry2, agent: agent2 } = pluginHost({ ...host.config }, host.rows, () => { validations += 1 })
    registry2.enter(agent2, undefined)
    await registry2.announce(agent2, 'resume')
    expect(validations).toBe(2)
  })

  it('charges one fresh validation to each Goal/Stop boundary decision', async () => {
    let counter = 0
    const runtime = createRuntime(fakeAgent(sessionWithId('v081-stop', 1)), { activation: 'always' },
      DEFAULT_HOST_LOCK, undefined, () => { counter += 1; return DEFAULT_HOST_LOCK })
    runtime.sync()
    expect(counter).toBe(0)
    const access = { flush: async () => true, hostSupported: true, readExternalOperation: () => undefined }
    const agent = fakeAgent(sessionWithId('v081-stop', 1))
    await handleGuardTurnStopping(agent, runtime, access)
    expect(counter).toBe(1)
    // A second consecutive Goal/Stop entry validates again instead of reusing
    // the first entry's result.
    await handleGuardTurnStopping(agent, runtime, access)
    expect(counter).toBe(2)
  })
})

describe('concurrent entries of one agent never share a validation result', () => {
  it('gives each entry its own fresh audit even when another entry is open', async () => {
    let counter = 0
    const audits: string[] = []
    let hostState: 'clean' | 'drifted' = 'clean'
    const runtime = createRuntime(fakeAgent(sessionWithId('v081-concurrent', 1)), { activation: 'always' },
      DEFAULT_HOST_LOCK, undefined, () => {
        counter += 1
        audits.push(hostState)
        return hostState === 'clean' ? DEFAULT_HOST_LOCK
          : { ...DEFAULT_HOST_LOCK, status: 'unsupported' as const, goalAvailable: false,
            reasonCode: 'host_lock_installed_graph_drift' as const }
      })
    expect(counter).toBe(0)
    let releaseEntry1!: () => void
    const entry1Barrier = new Promise<void>((resolve) => { releaseEntry1 = resolve })
    let releaseEntry2!: () => void
    const entry2Barrier = new Promise<void>((resolve) => { releaseEntry2 = resolve })

    // Entry 1 pauses before its first fresh request; entry 2 validates and
    // stays open. When entry 1 resumes on a drifted host, it must audit for
    // itself — reusing entry 2's open result would authorize on stale facts.
    const entry1 = runtime.runHostLockEntry(async () => {
      await entry1Barrier
      runtime.sync({ revalidateHostLock: true })
      const judged = runtime.projection.hostStatus
      runtime.sync({ revalidateHostLock: true })
      expect(runtime.projection.hostStatus).toBe(judged)
      return judged
    })
    const entry2 = runtime.runHostLockEntry(async () => {
      runtime.sync({ revalidateHostLock: true })
      const judged = runtime.projection.hostStatus
      await entry2Barrier
      return judged
    })
    hostState = 'drifted'
    releaseEntry1()
    const judged1 = await entry1
    releaseEntry2()
    const judged2 = await entry2
    expect(judged2).toBe('supported')
    expect(judged1).toBe('unsupported')
    expect(audits).toEqual(['clean', 'drifted'])
  })
})

describe('drift between two consecutive authorized entries is refused', () => {
  it('refuses a same-size, same-mtime real-byte replacement between two fresh validations', () => {
    const host = makeHost()
    const config = host.config
    const expected = expectedLockFor(host)
    expect(revalidateCoreLock(config, expected).status).toBe('supported')
    const entry = join(host.runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-session')
    // The bare route is a junction; mutate the module file behind the mapped
    // root so both the byte audit and any metadata fingerprint see the file.
    const mappedEntry = join(host.runtimeRoot, 'node_modules', 'active', 'package-' +
      EXPECTED_HOST_PACKAGES.findIndex((row) => row.name === '@deepseek-ai/dsh-session'), 'lib', 'index.js')
    void entry
    const original = readFileSync(mappedEntry, 'utf8')
    const stamp = statSync(mappedEntry)
    // Same byte length, different content, restored mtime: no metadata
    // fingerprint may stand in for the bytes.
    const mutated = original.replace('true', 'fals')
    expect(mutated).toHaveLength(original.length)
    expect(mutated).not.toBe(original)
    writeFileSync(mappedEntry, mutated)
    utimesSync(mappedEntry, stamp.atime, stamp.mtime)
    expect(Math.abs(statSync(mappedEntry).mtimeMs - stamp.mtimeMs)).toBeLessThan(1)
    expect(revalidateCoreLock(config, expected))
      .toMatchObject({ status: 'unsupported', reasonCode: 'host_lock_installed_graph_drift' })
    // Restoring the exact bytes with the same mtime revalidates.
    writeFileSync(mappedEntry, original)
    utimesSync(mappedEntry, stamp.atime, stamp.mtime)
    expect(revalidateCoreLock(config, expected).status).toBe('supported')
  })

  it('refuses a reachable critical duplicate introduced between two fresh validations', () => {
    const host = makeHost()
    const config = host.config
    const expected = expectedLockFor(host)
    expect(revalidateCoreLock(config, expected).status).toBe('supported')
    const victim = EXPECTED_HOST_PACKAGES[0]
    const duplicateId = `${victim.name}@${victim.version}(late-peer)`
    host.packages[duplicateId] = { url: './active/late-duplicate', dependencies: {} }
    host.packages['.'].dependencies.late = duplicateId
    writeFileSync(join(host.runtimeRoot, 'node_modules', '.package-map.json'), JSON.stringify({ packages: host.packages }))
    expect(revalidateCoreLock(config, expected).status).not.toBe('supported')
    delete host.packages[duplicateId]
    delete host.packages['.'].dependencies.late
    writeFileSync(join(host.runtimeRoot, 'node_modules', '.package-map.json'), JSON.stringify({ packages: host.packages }))
    expect(revalidateCoreLock(config, expected).status).toBe('supported')
  })

  it('refuses a nearer profile shadow with identical bytes installed between two fresh validations', () => {
    const host = makeHost()
    const config = host.config
    const expected = expectedLockFor(host)
    expect(revalidateCoreLock(config, expected).status).toBe('supported')
    // Identical audited bytes and manifest; only the nearer profile-local
    // native route differs from the mapped installation.
    const shadow = join(host.profileRoot, 'node_modules', 'plugin', 'node_modules', '@deepseek-ai', 'dsh-session')
    mkdirSync(shadow, { recursive: true })
    cpSync(join(host.profileRoot, 'node_modules', '.pnpm', 'session', 'node_modules', '@deepseek-ai', 'dsh-session'), shadow, { recursive: true })
    expect(revalidateCoreLock(config, expected))
      .toMatchObject({ status: 'unsupported', reasonCode: 'host_lock_installed_graph_drift' })
    rmSync(shadow, { recursive: true, force: true })
    expect(revalidateCoreLock(config, expected).status).toBe('supported')
  })

  it('refuses export-target and symlink drift introduced between two fresh validations', () => {
    const host = makeHost()
    const config = host.config
    const expected = expectedLockFor(host)
    const victim = EXPECTED_HOST_PACKAGES[0]
    const packageRoot = join(host.runtimeRoot, 'node_modules', 'active', 'package-0')
    expect(victim.name.length).toBeGreaterThan(0)
    expect(revalidateCoreLock(config, expected).status).toBe('supported')
    const manifestPath = join(packageRoot, 'package.json')
    // The canonical manifest is the only byte form the audited digest accepts;
    // any export rewrite also changes the manifest bytes, so the byte audit
    // and the route audit both fail closed on a redirect.
    // Redirecting the export to a file the byte inventory never authenticated
    // is refused (manifest bytes and route target both drift).
    writeFileSync(join(packageRoot, 'lib', 'escaped.js'), AUDITED_MODULE_TEXT)
    writeFileSync(manifestPath, JSON.stringify({
      name: victim.name, version: victim.version,
      exports: { '.': { types: './index.d.ts', default: './lib/escaped.js' } },
    }))
    expect(revalidateCoreLock(config, expected).status).not.toBe('supported')
    // An export target that is a symlink escaping the authenticated package
    // root is refused as well (canonical manifest restored, module symlinked).
    rmSync(join(packageRoot, 'lib', 'escaped.js'))
    writeFileSync(join(host.root, 'outside.js'), AUDITED_MODULE_TEXT)
    writeFileSync(manifestPath, canonicalManifest(victim.name, victim.version!))
    rmSync(join(packageRoot, 'lib', 'index.js'))
    symlinkSync(join(host.root, 'outside.js'), join(packageRoot, 'lib', 'index.js'))
    expect(revalidateCoreLock(config, expected).status).not.toBe('supported')
    // Restoring the real audited bytes revalidates.
    rmSync(join(packageRoot, 'lib', 'index.js'))
    writeFileSync(join(packageRoot, 'lib', 'index.js'), AUDITED_MODULE_TEXT)
    expect(revalidateCoreLock(config, expected).status).toBe('supported')
  })

  it('refuses a mapped edge removed from the importer between two fresh validations', () => {
    const host = makeHost()
    const config = host.config
    const expected = expectedLockFor(host)
    expect(revalidateCoreLock(config, expected).status).toBe('supported')
    // Drop one critical dependency edge from the root importer record but keep
    // the mapped package directory: the graph readback and the route audit
    // must both fail closed.
    const victim = EXPECTED_HOST_PACKAGES[0]
    const victimId = `${victim.name}@${victim.version}`
    expect(host.packages['.'].dependencies[victim.name]).toBe(victimId)
    delete host.packages['.'].dependencies[victim.name]
    writeFileSync(join(host.runtimeRoot, 'node_modules', '.package-map.json'), JSON.stringify({ packages: host.packages }))
    expect(revalidateCoreLock(config, expected).status).not.toBe('supported')
    host.packages['.'].dependencies[victim.name] = victimId
    writeFileSync(join(host.runtimeRoot, 'node_modules', '.package-map.json'), JSON.stringify({ packages: host.packages }))
    expect(revalidateCoreLock(config, expected).status).toBe('supported')
  })
})

describe('one audit physically reads each path at most once', () => {
  it('counts physical byte reads across manifests, maps and hashed modules', () => {
    const host = makeHost()
    const physicalReads = new Map<string, number>()
    const inner = createHostAuditSession((path) => {
      physicalReads.set(path, (physicalReads.get(path) ?? 0) + 1)
    })
    const counting: HostAuditSession = {
      realpath: (path) => inner.realpath(path),
      exists: (path) => inner.exists(path),
      stat: (path) => inner.stat(path),
      readFile: (path) => inner.readFile(path),
      readJson: (path) => inner.readJson(path),
      fileDigest: (path) => inner.fileDigest(path),
      requireFor: (importer) => inner.requireFor(importer),
      resolvePaths: (importer, name) => inner.resolvePaths(importer, name),
      requireResolve: (importer, request) => inner.requireResolve(importer, request),
      memo: <T,>(key: string, compute: () => T) => inner.memo(key, compute),
    }
    const verdict = revalidateCoreLock(host.config, expectedLockFor(host), counting)
    if (verdict.status !== 'supported') console.log('PROBE verdict:', verdict.status, verdict.reasonCode)
    expect(verdict.status).toBe('supported')
    // One physical read per path per validation: JSON parsers and digest
    // checks share the same bytes, and the graph readback, byte audit and
    // route audit converge on one memo key.
    const duplicated = [...physicalReads.entries()].filter(([, count]) => count > 1)
    expect(duplicated, `duplicate physical reads: ${JSON.stringify(duplicated)}`).toEqual([])
    // 46 manifests + 46 audited modules (+ the profile's session copy) + 2
    // package maps + 2 lockfiles at minimum.
    expect(physicalReads.size).toBeGreaterThanOrEqual(92)
  })
})


describe('review: full host validation must reject importer self-reference drift', () => {
  it('rejects a nested self-reference without any authenticated critical package bytes changing', () => {
    const host = makeHost()
    const dep = '@deepseek-ai/dsh-session'
    const row = EXPECTED_HOST_PACKAGES.find(p => p.name === dep)!
    const id = `${row.name}@${row.version}`
    const consumer = join(host.runtimeRoot, 'node_modules', 'consumer')
    mkdirSync(join(consumer, 'lib'), { recursive: true })
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({
      name: 'consumer', version: '1.0.0', main: './lib/index.js', dependencies: { [dep]: row.version },
    }))
    writeFileSync(join(consumer, 'lib/index.js'), 'export const unauthenticated = true\n')
    host.packages['.'].dependencies.consumer = 'consumer'
    host.packages.consumer = { url: './consumer', dependencies: { [dep]: id } }
    writeFileSync(join(host.runtimeRoot, 'node_modules', '.package-map.json'), JSON.stringify({ packages: host.packages }))
    host.rows = readActiveHostGraph(host.runtimeRoot, host.profileRoot)
    const expected = expectedLockFor(host)
    expect(revalidateCoreLock(host.config, expected).status).toBe('supported')
    writeFileSync(join(consumer, 'lib/package.json'), JSON.stringify({
      name: dep, exports: { '.': './index.js' },
    }))
    expect(createRequire(join(consumer, 'lib/index.js')).resolve(dep)).toBe(join(consumer, 'lib/index.js'))
    expect(revalidateCoreLock(host.config, expected).status).not.toBe('supported')
  })
})
