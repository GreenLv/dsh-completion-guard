import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync, cpSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { activationDigest } from '../src/domain/session-activation.js'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })))
// Each owned child has a 20-second timeout; the longest case launches up to
// sixteen sequential children, so its total budget covers their bounded limits.
const CHILD_TIMEOUT_MS = 20_000
const FULL_FLOW_TIMEOUT_MS = 350_000
const entry = fileURLToPath(new URL('../bin/dsh-completion-guard-activation.mjs', import.meta.url))
const anchor = join(process.cwd(), 'package.json')
function fixture(compression: 'zstd' | 'none' = 'zstd') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'guard-selection-cli-'))); dirs.push(root)
  const logs = join(root, 'logs'); mkdirSync(logs)
  const seed = `import {createRequire} from 'node:module';import{pathToFileURL}from'node:url';
    const r=createRequire(process.argv[1]);const {Context}=await import(pathToFileURL(r.resolve('@deepseek-ai/cordis')));
    const m=await import(pathToFileURL(r.resolve('@deepseek-ai/dsh-session-persistence-jsonl')));const c=new Context();
    const p=c.plugin(m.default??m,{root:process.argv[2],compression:process.argv[3]});await p.await();
    for(const [i,id] of ['a','b'].entries()){const h=await c.sessionPersistence.create({version:4,id,createdAt:i+1,isSeeded:false,delegationDepth:0});await h.flush();await h.close()};await c.fiber.dispose();`
  const seeded = spawnSync(process.execPath, ['--input-type=module', '-e', seed, anchor, logs, compression], { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGTERM' })
  if (seeded.status !== 0) throw new Error(seeded.stderr)
  const prior = join(root, 'prior.json'); writeFileSync(prior, JSON.stringify({ schema: 'dsh-activation-prior-modes/v1', previousPackage: { name: 'dsh-completion-guard', version: '0.11.0', sha256: '1'.repeat(64) }, sourceSha256: '2'.repeat(64), cohorts: [{ name: 'verified', mode: 'opt-in' }] }))
  const run = (operation: string, args: string[] = []) => spawnSync(process.execPath, [entry, operation,
    ...(operation === 'select' ? [] : ['--runtime-anchor', anchor, '--persistence-root', logs, '--compression', compression]), ...args], { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGTERM' })
  return { root, logs, prior, run, compression }
}
function output(root: string, name: string) { return join(root, name + '.json') }
function hidden(f: ReturnType<typeof fixture>, id = 'hidden', version = '4') {
  const path = join(f.logs, '_no-cwd', id); mkdirSync(path, { recursive: true })
  const file = join(path, `session.v${version}.jsonl${f.compression === 'zstd' ? '.zstd' : ''}`)
  writeFileSync(file, 'opaque corrupt fixture'); return file
}
it.each(['zstd', 'none'] as const)('official %s CLI binds complete physical inventory for full and selected workflows', compression => {
  const f = fixture(compression), report = output(f.root, 'inventory'), select = output(f.root, 'selection'), ids = output(f.root, 'ids'), receipt = output(f.root, 'receipt'), home = join(f.root, 'home')
  let result = f.run('inventory', ['--output', report]); expect(result.status, result.stderr).toBe(0)
  expect(f.run('inventory', ['--output', report]).stderr).toContain('activation_output_exists')
  expect(f.run('inspect', ['--selection', select, '--selection', select]).stderr).toContain('activation_cli_options_invalid')
  const snapshot = JSON.parse(readFileSync(report, 'utf8')); expect(snapshot.physicalSha256).toMatch(/^[a-f0-9]{64}$/); expect(snapshot.rows).toHaveLength(2)
  writeFileSync(ids, '["a"]'); expect(f.run('select', ['--inventory', report, '--include-file', ids, '--output', select]).status).toBe(0)
  result = f.run('inspect', ['--selection', select, '--prior-modes', f.prior, '--output', receipt]); expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({ status: 'ready', scope: 'receipt_selected', wholeInventoryStatus: 'not_claimed', includedCount: 1 })
  const args = ['--selection', select, '--receipt', receipt, '--dsh-home', home]
  expect(f.run('adopt', ['--receipt', receipt, '--dsh-home', home]).stderr).toContain('activation_selection_required')
  expect(f.run('verify', args).status).toBe(2)
  expect(JSON.parse(f.run('adopt', args).stdout).status).toBe('selected_complete')
  const repeated = JSON.parse(f.run('adopt', args).stdout)
  expect(repeated.entries.every((row: { created: boolean }) => row.created === false)).toBe(true)
  expect(f.run('verify', args).status).toBe(0)
  const bad = hidden(f); const before = readFileSync(bad)
  expect(f.run('verify', args).status).toBe(1)
  expect(readFileSync(bad)).toEqual(before)
}, FULL_FLOW_TIMEOUT_MS)
it('official CLI rejects hidden corrupt or future rows for inventory and whole inspect without writing outputs', () => {
  for (const version of ['4', '5']) {
    const f = fixture(), bad = hidden(f, 'hidden', version), before = readFileSync(bad), report = output(f.root, 'bad-report'), receipt = output(f.root, 'bad-receipt')
    expect(f.run('inventory', ['--output', report]).status).toBe(1)
    expect(f.run('inspect', ['--prior-modes', f.prior, '--output', receipt]).status).toBe(1)
    expect(existsSync(report)).toBe(false); expect(existsSync(receipt)).toBe(false); expect(readFileSync(bad)).toEqual(before)
  }
}, FULL_FLOW_TIMEOUT_MS)
it('old proofless receipts are named refusals before bindings can be written', () => {
  const f = fixture(), receipt = output(f.root, 'receipt'), old = output(f.root, 'old'), home = join(f.root, 'home')
  expect(f.run('inspect', ['--prior-modes', f.prior, '--output', receipt]).status).toBe(0)
  const value = JSON.parse(readFileSync(receipt, 'utf8')); delete value.inputs.physical_inventory; const { sha256: _old, ...unsigned } = value
  writeFileSync(old, JSON.stringify({ ...unsigned, sha256: activationDigest(unsigned) }), { mode: 0o600 })
  const result = f.run('adopt', ['--receipt', old, '--dsh-home', home]); expect(result.status).toBe(1)
  expect(result.stderr).toContain('activation_inventory_proof_required'); expect(existsSync(home)).toBe(false)
}, FULL_FLOW_TIMEOUT_MS)

it('a receipt cannot be transferred to another physical root with identical session bytes', () => {
  const f = fixture(), receipt = output(f.root, 'root-a-receipt'), home = join(f.root, 'new-home'), other = join(f.root, 'other-root')
  expect(f.run('inspect', ['--prior-modes', f.prior, '--output', receipt]).status).toBe(0)
  cpSync(f.logs, other, { recursive: true })
  const result = spawnSync(process.execPath, [entry, 'adopt', '--runtime-anchor', anchor, '--persistence-root', other,
    '--compression', f.compression, '--receipt', receipt, '--dsh-home', home], { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGTERM' })
  expect(result.status).toBe(1); expect(result.stderr).toContain('activation_inventory_changed'); expect(existsSync(home)).toBe(false)
}, FULL_FLOW_TIMEOUT_MS)

it('refuses an unreviewed backend before importing its code', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'guard-unreviewed-backend-'))); dirs.push(root)
  const runtime = join(root, 'runtime'), backend = join(runtime, 'node_modules/@deepseek-ai/dsh-session-persistence-jsonl')
  mkdirSync(join(backend, 'lib'), { recursive: true }); writeFileSync(join(runtime, 'package.json'), '{}')
  writeFileSync(join(backend, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-session-persistence-jsonl', version: '0.2.1-rc.5', type: 'module', exports: './lib/index.js' }))
  const marker = join(root, 'executed'); writeFileSync(join(backend, 'lib/index.js'), `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'executed');export default()=>{}`)
  const logs = join(root, 'logs'); mkdirSync(logs)
  const result = spawnSync(process.execPath, [entry, 'inventory', '--runtime-anchor', join(runtime, 'package.json'), '--persistence-root', logs, '--output', output(root, 'out')], { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGTERM' })
  expect(result.status).toBe(1); expect(result.stderr).toContain('activation_backend_unreviewed'); expect(existsSync(marker)).toBe(false)
}, FULL_FLOW_TIMEOUT_MS)

it('accepts byte-identical reviewed backend with a newer version and rejects changed executable files', () => {
  const f = fixture(), root = f.root
  const sourceRequire = createRequire(import.meta.url)
  const original = dirname(dirname(realpathSync(sourceRequire.resolve('@deepseek-ai/dsh-session-persistence-jsonl'))))
  const cordis = dirname(realpathSync(sourceRequire.resolve('@deepseek-ai/cordis/package.json')))
  const runtime = join(root, 'runtime'), scoped = join(runtime, 'node_modules', '@deepseek-ai'), backend = join(scoped, 'dsh-session-persistence-jsonl')
  mkdirSync(scoped, { recursive: true }); writeFileSync(join(runtime, 'package.json'), '{}'); cpSync(original, backend, { recursive: true })
  const kind = process.platform === 'win32' ? 'junction' : 'dir'
  rmSync(join(backend, 'node_modules'), { recursive: true, force: true })
  symlinkSync(dirname(dirname(original)), join(backend, 'node_modules'), kind)
  symlinkSync(cordis, join(scoped, 'cordis'), kind)
  const manifestPath = join(backend, 'package.json'), manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const storage = f.logs
  const run = (name: string) => spawnSync(process.execPath, [entry, 'inventory', '--runtime-anchor', join(runtime, 'package.json'), '--persistence-root', storage, '--output', output(root, name)], { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGTERM' })
  for (const [index, version] of ['0.2.1-rc.4', '0.2.2-rc.1', '9.0.0'].entries()) {
    manifest.version = version; writeFileSync(manifestPath, JSON.stringify(manifest))
    const accepted = run(`accepted-${index}`); expect(accepted.status, accepted.stderr).toBe(0)
    expect(JSON.parse(accepted.stdout)).toMatchObject({ status: 'inventory_scanned', totalCount: 2 })
  }
  manifest.version = '0.2.1-rc.2'; writeFileSync(manifestPath, JSON.stringify(manifest))
  expect(run('below-floor').stderr).toContain('activation_backend_unreviewed')
  manifest.version = '0.2.1-rc.4'; writeFileSync(manifestPath, JSON.stringify(manifest))
  const receipt = output(root, 'serializer-receipt'), home = join(root, 'serializer-home')
  const invoke = (op: string, args: string[]) => spawnSync(process.execPath, [entry, op, '--runtime-anchor', join(runtime, 'package.json'), '--persistence-root', storage, ...args], { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGTERM' })
  const inspected = invoke('inspect', ['--prior-modes', f.prior, '--output', receipt]); expect(inspected.status, inspected.stderr).toBe(0)
  manifest.version = '0.2.1-rc.5'; writeFileSync(manifestPath, JSON.stringify(manifest))
  const changedSerializer = invoke('adopt', ['--receipt', receipt, '--dsh-home', home])
  expect(changedSerializer.stderr).toContain('activation_inventory_changed'); expect(existsSync(home)).toBe(false)
  manifest.version = '0.2.1-rc.4'; writeFileSync(manifestPath, JSON.stringify(manifest))
  for (const file of ['lib/index.js', 'lib/worker.cjs']) {
    const path = join(backend, file), before = readFileSync(path); writeFileSync(path, Buffer.concat([before, Buffer.from('\n// changed\n')]))
    const rejected = run(file.includes('worker') ? 'worker' : 'entry')
    expect(rejected.status).toBe(1); expect(rejected.stderr).toContain('activation_backend_unreviewed')
    writeFileSync(path, before)
  }
}, FULL_FLOW_TIMEOUT_MS)
