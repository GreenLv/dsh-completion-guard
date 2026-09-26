import { RC017_RC2_HOST_PACKAGES } from '../../src/domain/rc017-rc2-host.js'
import { evaluateHostLock } from '../../src/domain/host-lock.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { it, expect } from 'vitest'
import { deriveProjection } from '../../src/domain/derive.js'
import { createCheckpointTool } from '../../src/tools/checkpoint.js'
const probeModule = new URL('../../scripts/native_host_probe.mjs', import.meta.url).href

it('projects the same renderer-attested host lock as the live runtime', async () => {
 const { probeHostLock } = await import(new URL('../../scripts/native_host_probe_v070.mjs', import.meta.url).href)
 const graph = evaluateHostLock(RC017_RC2_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' })
 expect(graph.status).toBe('supported')
 const config = { runtimeRoot: '/isolated/runtime', profileRoot: '/isolated/profile',
  hostPackages: RC017_RC2_HOST_PACKAGES, profile: 'web' }
 const domain = { evaluateHostLock, readActiveHostGraph: () => RC017_RC2_HOST_PACKAGES,
  auditedForegroundRenderers: () => ['bash'] }
 const live = probeHostLock(domain, config, 'posix')
 const attestedDigest = createHash('sha256')
  .update(`dsh.core-host-renderer/v1\0${graph.digest}\0bash`).digest('hex')
 expect(live).toMatchObject({ status: 'supported', digest: attestedDigest,
  auditedForegroundRenderers: ['bash'] })
 expect(live.digest).not.toBe(graph.digest)
 expect(probeHostLock({ ...domain, auditedForegroundRenderers: () => [] }, config, 'posix').digest).toBe(graph.digest)
 const drift = probeHostLock({ ...domain, readActiveHostGraph: () => [] }, config, 'posix')
 expect(drift.status).not.toBe('supported')
 expect(drift.digest).not.toBe(attestedDigest)
})

it('requires default ordinary feedback without a certificate or binding template', async () => {
 const { assertOrdinaryCheckpoint } = await import(new URL('../../scripts/native_host_probe_v070.mjs', import.meta.url).href)
 const incomplete = { status: 'incomplete', feedback_source: 'confirmed_core_v2',
  certificate_status: 'not_requested', open_items: [{ id: 'R001', reason_code: 'insufficient' }] }
 const observed = { ...incomplete, status: 'observed', open_items: [] }
 expect(() => assertOrdinaryCheckpoint(incomplete, 'incomplete')).not.toThrow()
 expect(() => assertOrdinaryCheckpoint(observed, 'observed')).not.toThrow()
 for (const invalid of [
  { ...observed, certificate: { certificate_version: '4' } },
  { ...observed, certificate_status: 'bound' },
  { ...incomplete, open_items: [{ id: 'R001', binding_template: { semantic_action: 'test' } }] },
  { ...observed, feedback_source: 'historical_item_status' },
 ]) expect(() => assertOrdinaryCheckpoint(invalid, invalid.status)).toThrow()
})

it('executes the native npm fixture with the intended exit status on the platform shell', async () => {
 const { nativeTestFixturePackage } = await import(new URL('../../scripts/native_host_probe_v070.mjs', import.meta.url).href)
 const cwd = mkdtempSync(join(tmpdir(), 'dsh-native-script-'))
 try {
  for (const [name, exitCode] of [['native-test-fixture', 0], ['native-goal-fixture', 0], ['native-goal-fixture', 1]] as const) {
   const fixture = nativeTestFixturePackage(exitCode, name)
   expect(JSON.parse(fixture).name).toBe(name)
   expect(JSON.parse(fixture).scripts.test).toBe(`node -e "process.exit(${exitCode})"`)
   writeFileSync(join(cwd, 'package.json'), fixture)
   const result = spawnSync('npm test', { cwd, shell: true, encoding: 'utf8', timeout: 30_000 })
   expect(result.error).toBeUndefined()
   expect(result.signal).toBeNull()
   expect(result.status).toBe(exitCode)
  }
 } finally {
  rmSync(cwd, { recursive: true, force: true })
 }
// Three bounded npm child processes can each use 30 seconds on a loaded CI host.
}, 100_000)

it('requires a completed successful foreground command before requesting a test certificate', async () => {
 const { assertTestCommandSucceeded, shellTerminalFacts } = await import(probeModule)
 const success = { kind: 'foreground', exitCode: 0, timedOut: false, aborted: false }
 expect(() => assertTestCommandSucceeded(success)).not.toThrow()
 for (const value of [undefined, {}, { ...success, exitCode: 1 }, { ...success, exitCode: undefined },
  { ...success, kind: 'background' }, { ...success, timedOut: true }, { ...success, aborted: true }]) {
  expect(() => assertTestCommandSucceeded(value)).toThrow()
 }
 expect(shellTerminalFacts({ ...success, exitCode: 1, stdout: { text: 'private output' }, stderr: { text: 'private path' } }))
  .toEqual({ kind: 'foreground', exit_code: 1, timed_out: false, aborted: false })
})

it.each(['short', 'long'])('retrieves a %s Windows test template through the native driver and certifies it', async length => {
 const { readProbeTestBinding, readProbeItem } = await import(probeModule)
 const cwd = 'C:\\Users\\green\\AppData\\Local\\Temp\\' + (length === 'long' ? 'isolated-home-'.repeat(18) : '') + 'dsh-guard-host-abcdefgh\\work'
 const p = deriveProjection([
  { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Run pnpm test.' }] } },
  { seq: 2, type: 'tool/call', data: { callId: 'native-12345-1', name: 'pwsh', arguments: JSON.stringify({ command: 'pnpm test' }) } },
  { seq: 3, type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'native-12345-1' }, role: 'tool', toolCallId: 'native-12345-1', isError: false, content: [{ type: 'text', text: '> node fixture.cjs' }] } } },
 ], { activation: 'always' }, { cwd }, true, evaluateHostLock(RC017_RC2_HOST_PACKAGES, { platform: 'windows', profileKind: 'web' })).projection
 const tool = createCheckpointTool(() => p, () => {})
 const call = async (name: string, args: never) => {
  expect(name).toBe('context_guard_checkpoint')
  return tool.execute(args, undefined as never)
 }
 const page = await tool.execute({ bindings: [] }, undefined as never) as { open_items: Array<{ omitted?: boolean; binding_template?: unknown; detail_id?: string }> }
 expect(page.open_items[0].omitted === true).toBe(length === 'long')
 // 0.6.2 D062-01: a summarized row KEEPS the binding_template, because a
 // caller that must close this item needs it; only optional prose is dropped,
 // and the row stays explicitly marked omitted and retrievable by detail_id.
 expect(page.open_items[0].binding_template).toBeDefined()
 if (length === 'long') expect(page.open_items[0].detail_id).toBeDefined()
 const binding = await readProbeTestBinding(call, page)
 expect(binding).toMatchObject({ semantic_action: 'test', evidence_ids: ['E0001'] })
 expect(await tool.execute({ bindings: [binding] }, undefined as never)).toMatchObject({ status: 'certified', certificate: expect.any(Object) })
 // Model the persisted passed row: default checkpoint pages exclude it, but
 // explicit item queries and every detail continuation must retain its scope.
 const item = [...p.items.values()][0]
 item.status = 'passed'
 const passedPage = await tool.execute({ bindings: [], item_ids: [item.id] }, undefined as never)
 expect((await readProbeItem(call, passedPage, item.id)).status).toBe('passed')
})

it('persists bound progress and detects async and synchronous operation deadlines', async () => {
 const { createProbeProgress } = await import(new URL('../../scripts/native_host_probe_v070.mjs', import.meta.url).href)
 const { readFileSync } = await import('node:fs')
 const { vi } = await import('vitest')
 const folder = mkdtempSync(join(tmpdir(), 'probe-progress-'))
 const progressOutput = join(folder, 'stages.jsonl')
 const config = { progressOutput, sourceCommit: 'a'.repeat(40), artifactSha256: 'b'.repeat(64), nonce: 'unit', profile: 'headless' }
 try {
  const progress = createProbeProgress(config, 'c'.repeat(64))
  expect(await progress.timed('import_domain', async () => 7)).toBe(7)
  await expect(progress.timed('import_domain', async () => { throw new Error('/private/token') })).rejects.toThrow()
  vi.useFakeTimers()
  const hanging = progress.timed('tool_read', () => new Promise(() => {}))
  const rejection = expect(hanging).rejects.toMatchObject({ code: 'PROBE_OPERATION_TIMEOUT' })
  await vi.advanceTimersByTimeAsync(30000)
  await rejection
  await expect(progress.timed('root_prestep', () => { vi.setSystemTime(Date.now() + 30001); return 1 })).rejects.toMatchObject({ code: 'PROBE_OPERATION_TIMEOUT' })
  vi.useRealTimers()
  const text = readFileSync(progressOutput, 'utf8')
  const rows = text.trim().split('\n').map(line => JSON.parse(line))
  expect(rows.every(row => row.source_commit === config.sourceCommit && row.artifact_sha256 === config.artifactSha256 && row.nonce === 'unit')).toBe(true)
  expect(rows.filter(row => row.status === 'timed_out')).toHaveLength(2)
  expect(text).not.toContain('/private/token')
 } finally { vi.useRealTimers(); rmSync(folder, { recursive: true, force: true }) }
})

it('writes a failed probe receipt when initialization imports fail', async () => {
 const { apply } = await import(new URL('../../scripts/native_host_probe_v070.mjs', import.meta.url).href)
 const { readFileSync } = await import('node:fs')
 const folder = mkdtempSync(join(tmpdir(), 'probe-init-'))
 let ready: (() => Promise<void>) | undefined
 try {
  apply({ effect: (fn: () => unknown) => fn(), appReady: { onReady: (fn: () => Promise<void>) => { ready = fn } } },
   { runtimeRoot: folder, profileRoot: folder, output: join(folder, 'probe'), nonce: 'init' })
  await ready!()
  const result = JSON.parse(readFileSync(join(folder, `probe.${process.pid}.json`), 'utf8'))
  expect(result.status).toBe('failed')
  expect(result.cases[0].id).toBe('initialize_runtime')
  expect(result.real_model_request).toBe(false)
 } finally { rmSync(folder, { recursive: true, force: true }) }
})
