import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error The native Node fixture producer is intentionally an .mjs entrypoint.
const { createFixture } = await import('../scripts/create-ui-session-fixture.mjs')
describe('versioned UI fixture uses official persisted Session handles without models', () => {
  it('creates A/B, flushes/closes and reopens with the official reader before exporting identities', async () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-ui-producer-'))
    const home = join(root, 'dsh-home'), output = join(root, 'fixture.json')
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => { throw new Error('fixture must not contact a network') }
    try {
      const result = await createFixture({ home, output, frontendUrl: 'http://127.0.0.1:43123', sourceCommit: 'a'.repeat(40), preludeTurns: 2 })
      expect(result.sessions).toHaveLength(2)
      expect(result.sessions.every((s: { eventCount: number; persistedReadbackVerified: boolean }) => s.eventCount === 9 && s.persistedReadbackVerified)).toBe(true)
      expect(result.sessions[0].marker).not.toBe(result.sessions[1].marker)
      expect(result.realModelRequests).toBe(0)
      expect(JSON.parse(readFileSync(output, 'utf8')).sourceCommit).toBe('a'.repeat(40))
      expect(readdirSync(join(home, 'sessions')).length).toBeGreaterThan(0)
      const before = readFileSync(output)
      await expect(createFixture({ home, output, frontendUrl: result.frontendUrl, sourceCommit: 'a'.repeat(40) })).rejects.toThrow('unused')
      expect(readFileSync(output)).toEqual(before)
    } finally { globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }) }
  })
  it.each(['roots', 'tool'])('records actual persisted %s history distribution and byte density', async distribution => {
    const root = mkdtempSync(join(tmpdir(), 'guard-ui-shape-'))
    try {
      const fixture = await createFixture({ home: join(root, 'home'), output: join(root, 'fixture.json'), frontendUrl: 'http://127.0.0.1:43123/', sourceCommit: 'a'.repeat(40), preludeTurns: 2, distribution, outputBytes: 1024 })
      for (const row of fixture.sessions) {
        expect(row.eventCount).toBe(distribution === 'roots' ? 9 : 39)
        expect(row.rootInputCount).toBe(3)
        expect(row.toolResultCount).toBe(distribution === 'roots' ? 0 : 6)
        expect(row.rootInputDensity).toBe(3 / row.eventCount)
        expect(row.serializedEventBytes).toBeGreaterThan(distribution === 'roots' ? 100 : 2048)
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

// @ts-expect-error Native driver has no declaration build.
const { validateDesktopOwnership } = await import('../scripts/measure-session-switch.mjs')
it('binds a Desktop plan to its separate profile and an exact task owner receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-desktop-plan-'))
  try {
    const home = join(root, 'home'), fixture = await createFixture({ home, output: join(root, 'fixture.json'), frontendUrl: 'dsh-app://app/', sourceCommit: 'c'.repeat(40), surface: 'desktop', deferHostSeeding: true })
    expect(fixture.profileRoot).toBe(join(home, 'profiles', 'desktop'))
    expect(fixture.sessions.every((s: { persistedReadbackVerified: boolean }) => !s.persistedReadbackVerified)).toBe(true)
    const receipt = { schema: 'dsh-ui-desktop-owner/v1', fixtureNonce: fixture.nonce, sourceCommit: fixture.sourceCommit, hostVersion: fixture.hostVersion, home, userDataDir: join(home, 'desktop-user-data'), cdpUrl: 'http://127.0.0.1:43123', rendererUrl: 'dsh-app://app/', targetId: 'task-owned-main', processId: 123, carrierSha256: 'd'.repeat(64) }
    mkdirSync(receipt.userDataDir)
    expect(validateDesktopOwnership(receipt, fixture, receipt.cdpUrl)).toEqual(receipt)
    for (const patch of [{ sourceCommit: 'f'.repeat(40) }, { home: '/daily' }, { userDataDir: '/daily' }, { rendererUrl: 'file:///daily' }, { cdpUrl: 'http://127.0.0.1:9999' }, { processId: 0 }, { carrierSha256: '' }]) expect(() => validateDesktopOwnership({ ...receipt, ...patch }, fixture, receipt.cdpUrl)).toThrow()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// @ts-expect-error Native Node entrypoint, no TypeScript declaration build.
const { prepare } = await import('../scripts/prepare-ui-session-fixture.mjs')
import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
it('preparation preflight binds canonical identity and a child capability without installing or starting a host', async () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-ui-prepare-'))
  try {
    const home = join(root, 'home'), fixturePath = join(root, 'fixture.json'), runtimeRoot = join(root, 'runtime')
    const artifact = join(root, 'accepted.tgz'), record = join(root, 'release-artifact.json'), output = join(root, 'preflight.json')
    const bytes = Buffer.from('identity-only fixture; archive acceptance belongs to canonical release gate')
    const sha256 = createHash('sha256').update(bytes).digest('hex'), sourceCommit = 'b'.repeat(40)
    await createFixture({ home, output: fixturePath, frontendUrl: 'http://127.0.0.1:43123/', sourceCommit, artifactSha256: sha256 })
    const pkg = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(join(pkg, 'lib'), { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version: '0.2.1-rc.3' }))
    writeFileSync(join(pkg, 'lib', 'bin.js'), 'throw new Error("preflight must not execute host")')
    writeFileSync(artifact, bytes)
    writeFileSync(record, JSON.stringify({ name: 'dsh-completion-guard', gitHead: sourceCommit, sha256, size: bytes.length, filename: 'accepted.tgz' }))
    const result = await prepare({ fixturePath, runtimeRoot, artifact, artifactRecord: record, output }, { preflight: true })
    expect(result).toMatchObject({ status: 'preflight_passed', installs: false, hostStarted: false, nativeAcceptance: 'not_run' })
    expect(result.nodeVersion).toMatch(/^v\d/)
    await expect(prepare({ fixturePath, runtimeRoot, artifact, artifactRecord: record, output }, { preflight: true })).rejects.toThrow('output exists')
    writeFileSync(artifact, 'changed')
    await expect(prepare({ fixturePath, runtimeRoot, artifact, artifactRecord: record, output: join(root, 'bad.json') }, { preflight: true })).rejects.toThrow('identity mismatch')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
it('RC3-CLI01 inventory and an explicitly sourced fixture-mode adoption use the real rc.3 namespace backend', async () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-rc3-cli-'))
  try {
    const home = join(root, 'home'), fixture = await createFixture({ home, output: join(root, 'fixture.json'), frontendUrl: 'http://127.0.0.1:43123/', sourceCommit: 'c'.repeat(40) })
    const entry = fileURLToPath(new URL('../bin/dsh-completion-guard-activation.mjs', import.meta.url))
    const common = ['--runtime-anchor', fileURLToPath(new URL('../package.json', import.meta.url)), '--persistence-root', join(home, 'sessions')]
    const run = (operation: string, args: string[]) => spawnSync(process.execPath, [entry, operation, ...common, ...args], { encoding: 'utf8' })
    const inventory = join(root, 'inventory.json'), scan = run('inventory', ['--output', inventory])
    expect(scan.status, scan.stderr).toBe(0)
    expect(JSON.parse(scan.stdout)).toMatchObject({ totalCount: 2, readableCount: 2 })
    // This is a synthetic compatibility control, not a statement about old
    // user modes. The production performance path uses real fresh creation.
    const prior = join(root, 'synthetic-prior.json'), receipt = join(root, 'receipt.json')
    writeFileSync(prior, JSON.stringify({ schema: 'dsh-activation-prior-modes/v1', previousPackage: { name: 'dsh-completion-guard', version: '0.10.0', sha256: '1'.repeat(64) }, sourceSha256: '2'.repeat(64), cohorts: [{ name: 'synthetic-source-control-only', mode: 'always', sessionIds: fixture.sessions.map((s: { id: string }) => s.id) }] }))
    const inspected = run('inspect', ['--prior-modes', prior, '--output', receipt])
    expect(inspected.status, inspected.stderr).toBe(0)
    const adopted = run('adopt', ['--receipt', receipt, '--dsh-home', home])
    expect(adopted.status, adopted.stderr).toBe(0)
    expect(JSON.parse(adopted.stdout).status).toBe('complete')
    expect(run('verify', ['--receipt', receipt, '--dsh-home', home]).status).toBe(0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// @ts-expect-error Native observer module has no declaration build.
const { verifyObservationInput } = await import('../scripts/ui-session-host-fixture.mjs')
import * as domain from '../src/domain/index.js'
import { homedir } from 'node:os'
it('observer-only mode validates prior identities/bindings without creating, reading or promoting histories', async () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-ui-observe-'))
  try {
    const plan = await createFixture({ home: join(root, 'home'), output: join(root, 'plan.json'), frontendUrl: 'http://127.0.0.1:43123/', sourceCommit: 'c'.repeat(40), artifactSha256: 'd'.repeat(64) })
    const bindingRoot = domain.resolveActivationBindingsRoot(plan.home, homedir())
    const rows = plan.sessions.map((row: { id: string }) => {
      // Receipt/binding identity controls, not a native fresh-creation claim.
      const birthIdentity = domain.sessionBirthIdentity({ version: 4, id: row.id, createdAt: 1, isSeeded: false }, 0)
      const written = domain.writeActivationBinding(bindingRoot, birthIdentity, 'always', 'fresh_creation', '0'.repeat(64))
      if (written.status !== 'bound') throw new Error(written.reasonCode)
      return { ...row, protection: { mode: 'always', bindingSource: 'fresh_creation', birthIdentity, bindingSha256: written.binding.sha256, registeredGuardTool: true } }
    })
    const probeSha256 = createHash('sha256').update(readFileSync(new URL('../scripts/ui-session-host-fixture.mjs', import.meta.url))).digest('hex')
    const prior = { ...plan, sessions: rows, protection: { schema: 'dsh-ui-protected-fixture/v1', status: 'verified', guardGitHead: plan.sourceCommit, guardVersion: '0.11.0', hostLockStatus: 'supported', mode: 'always', statusPath: `/api/guard-ui-fixture/${plan.nonce}`, probeSha256 } }
    const priorBytes = Buffer.from(JSON.stringify(prior)), seedReceiptSha256 = createHash('sha256').update(priorBytes).digest('hex')
    const inputs = { plan, priorBytes, seedReceiptSha256, packageManifest: { gitHead: plan.sourceCommit, version: '0.11.0' }, producerSha256: plan.producerSha256, probeSha256, agents: { get: () => undefined }, domain }
    expect(verifyObservationInput(inputs).sessions).toHaveLength(2)
    for (const patch of [{ seedReceiptSha256: '0'.repeat(64) }, { probeSha256: '0'.repeat(64) }, { producerSha256: '0'.repeat(64) }, { packageManifest: { gitHead: plan.sourceCommit, version: '0.10.0' } }, { agents: { get: () => ({}) } }, ...['nonce', 'sourceCommit', 'artifactSha256', 'home', 'profileRoot', 'hostVersion'].map(key => ({ plan: { ...plan, [key]: 'mismatched' } }))]) expect(() => verifyObservationInput({ ...inputs, ...patch })).toThrow()
    rmSync(domain.activationBindingPath(bindingRoot, rows[0].id))
    expect(() => verifyObservationInput(inputs)).toThrow('binding missing or changed')
    // No persistence, create, append or promotion service is even provided to
    // this production observer validator; only read-only registry lookup.
  } finally { rmSync(root, { recursive: true, force: true }) }
})
