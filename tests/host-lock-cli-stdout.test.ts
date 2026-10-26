import { afterEach, expect, it } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'guard-cli-stdout-')); roots.push(root)
  mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'dist/domain'), { recursive: true })
  const cli = join(root, 'bin/host-lock.mjs'), archive = join(root, 'carrier/resources/app.asar'), profile = join(root, 'profile')
  mkdirSync(profile); mkdirSync(archive, { recursive: true })
  copyFileSync(new URL('../bin/dsh-completion-guard-host-lock.mjs', import.meta.url), cli)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', version: '0.11.0' }))
  // Only audit results are controlled. The actual shipped CLI, actual child
  // script and real OS pipes exercise output/branch/exit behavior. These
  // controls do not claim vendor signature, package graph or native admission.
  writeFileSync(join(root, 'dist/domain/index.js'), `
    import {appendFileSync} from 'node:fs';
    const packages=Array.from({length:2500},(_,i)=>({name:'package-'+i+'中文'.repeat(20),version:'1.0.0',integrity:'sha512-fixture'}));
    const evaluate=()=>({status:process.env.CONTROL_STATUS??'supported',platform:'posix',profileKind:process.env.CONTROL_PROFILE??'web',capabilities:{},packages});
    export const evaluateConfiguredHostLock=evaluate;
    export const hasDesktopImporterState=()=>false;
    const target=()=>({packages,profileGraph:{state:'controlled'},runtime:{asarRealpath:'fixture',metadata:{},hostVersion:{version:'0.2.1-rc.3'}}});
    export const inspectDesktopTargetGraph=target;export const inspectTargetHostGraph=target;
    export const resolveActiveProfileHostLock=()=>{appendFileSync(process.env.CONTROL_ACTIVE,'active');return {runtimeRoot:${JSON.stringify(archive)},profileRoot:${JSON.stringify(profile)},profileKind:process.env.CONTROL_PROFILE??'web',evaluation:evaluate()}};
    export const injectActiveProfileHostLock=()=>{throw Object.assign(Error('unexpected mutation'),{code:'unexpected_mutation'})};
    export const prepareActiveHostTrust=()=>{throw Error('unexpected network')};export const prepareTargetHostTrust=prepareActiveHostTrust;export const prepareDesktopHostTrust=prepareActiveHostTrust;
    export const verifyComposedHostLockDump=()=>{};
  `)
  const run = async (command: string, profileKind = 'web', status = 'supported', closed = false) => {
    const child = spawn(process.execPath, [cli, command, '--profile', profileKind, '--runtime-root', archive, '--profile-root', profile, '--dump-config', join(root, 'dump.yml')], { env: { ...process.env, CONTROL_STATUS: status, CONTROL_PROFILE: profileKind, CONTROL_ACTIVE: join(root, 'active'), CONTROL_PAYLOAD: join(root, 'payload.txt'), CONTROL_PROFILE_ROOT: profile }, stdio: ['ignore', 'pipe', 'pipe'] })
    const errors: Buffer[] = [], chunks: Buffer[] = []
    child.stderr.on('data', chunk => errors.push(chunk))
    if (closed) child.stdout.destroy()
    else child.stdout.on('data', chunk => { chunks.push(chunk); child.stdout.pause(); setTimeout(() => child.stdout.resume(), 1) })
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    return { code, bytes: Buffer.concat(chunks), stderr: Buffer.concat(errors).toString('utf8') }
  }
  return { root, cli, archive, profile, run }
}
it('CLI-STDOUT-01 drains large graph success/refusal pipes and returns before active mutation paths', async () => {
  const f = fixture()
  for (const profile of ['web', 'desktop']) for (const status of ['supported', 'unavailable']) for (const command of profile === 'desktop' ? ['inspect', 'inspect-graph'] : ['inspect-graph']) {
    const result = await f.run(command, profile, status)
    expect(result.code, result.stderr).toBe(status === 'supported' ? 0 : 1)
    expect(result.bytes.length).toBeGreaterThan(256 * 1024)
    const value = JSON.parse(result.bytes.toString('utf8'))
    expect(value.status).toBe(status); expect(value.packages).toHaveLength(2500)
    expect(value.packages.at(-1).name).toBe('package-2499' + '中文'.repeat(20))
  }
  expect(() => readFileSync(join(f.root, 'active'))).toThrow()
})
it('drains the real inner dump script and outer Desktop pipe byte for byte above the pipe buffer', async () => {
  const f = fixture(), executable = process.platform === 'darwin' ? join(dirname(dirname(f.archive)), 'MacOS/DeepSeek Harness') : join(dirname(dirname(f.archive)), 'DeepSeek Harness.exe')
  mkdirSync(dirname(executable), { recursive: true }); copyFileSync(process.execPath, executable)
  const modules = join(f.archive, 'dsh/node_modules/@deepseek-ai')
  mkdirSync(join(modules, 'dsh'), { recursive: true }); mkdirSync(join(modules, 'dsh-app-boot'))
  writeFileSync(join(modules, 'dsh/package.json'), JSON.stringify({ type: 'module', exports: { './profile-boot': './profile-boot.js' } }))
  writeFileSync(join(modules, 'dsh/profile-boot.js'), `export const prepareProfile=()=>({dir:process.env.CONTROL_PROFILE_ROOT,layers:[],patchPath:'absent'});export const PROFILE_ROOT_FILENAME='cordis.yml';export const homePatchPath=()=> 'absent';`)
  writeFileSync(join(modules, 'dsh-app-boot/package.json'), JSON.stringify({ type: 'module', main: 'index.js' }))
  writeFileSync(join(modules, 'dsh-app-boot/index.js'), `import {readFileSync} from 'node:fs';export const loadOptionalPatches=()=>undefined;export const renderConfigDump=()=>readFileSync(process.env.CONTROL_PAYLOAD,'utf8');`)
  const payload = Buffer.from('- id: controlled\n  config:\n    text: "' + '中文内容'.repeat(50000) + '"\n# COMPLETE-EOF\n')
  writeFileSync(join(f.root, 'payload.txt'), payload)
  const result = await f.run('dump-desktop', 'desktop')
  expect(result.code, result.stderr).toBe(0)
  expect(result.bytes).toEqual(payload)
  expect(createHash('sha256').update(result.bytes).digest('hex')).toBe(createHash('sha256').update(payload).digest('hex'))
  const refused = await f.run('dump-desktop', 'desktop', 'unavailable')
  expect(refused.code).toBe(1); expect(refused.bytes.length).toBe(0)
})
it('fails for closed consumers and malformed commands without an unhandled stream error', async () => {
  const f = fixture(), closed = await f.run('inspect-graph', 'web', 'supported', true)
  expect(closed.code).toBe(1); expect(JSON.parse(closed.stderr).reason_code).toBe('EPIPE')
  const invalid = await f.run('unknown')
  expect(invalid.code).toBe(1); expect(JSON.parse(invalid.stderr).status).toBe('unavailable')
})
it('labels verify-dump as lock-field readback rather than full configuration validation', async () => {
  const f = fixture(); writeFileSync(join(f.root, 'dump.yml'), "- id: unrelated\n  name: 'truncated")
  const result = await f.run('verify-dump')
  expect(result.code).toBe(0)
  expect(JSON.parse(result.bytes.toString('utf8'))).toMatchObject({ verification_scope: 'guard_host_lock_fields', configuration_syntax: 'not_checked' })
})
