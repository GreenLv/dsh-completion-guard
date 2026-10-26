#!/usr/bin/env node
/** Task-owned Web preparation only; does not replace native-acceptance/v2. */
import { readFileSync, writeFileSync, existsSync, createWriteStream } from 'node:fs'
import { resolve, join, dirname, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { once } from 'node:events'
import { validateFixture, DriverError } from './measure-session-switch.mjs'

export function preparationInputs({ fixturePath, runtimeRoot, artifact, artifactRecord, output }) {
  const fixture = validateFixture(JSON.parse(readFileSync(fixturePath, 'utf8')))
  const release = JSON.parse(readFileSync(artifactRecord, 'utf8'))
  const digest = createHash('sha256').update(readFileSync(artifact)).digest('hex')
  if (release.name !== 'dsh-completion-guard' || release.gitHead !== fixture.sourceCommit || release.sha256 !== digest || release.size !== readFileSync(artifact).length || fixture.artifactSha256 !== digest || release.filename !== basename(artifact)) throw new DriverError(2, 'fixture/frozen release identity mismatch')
  if (existsSync(output)) throw new DriverError(2, 'preparation output exists')
  const cli = join(resolve(runtimeRoot), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(cli)) throw new DriverError(3, 'official runtime CLI missing')
  const runtime = JSON.parse(readFileSync(join(dirname(dirname(cli)), 'package.json'), 'utf8'))
  if (runtime.version !== fixture.hostVersion) throw new DriverError(3, 'runtime version differs from fixture')
  const url = new URL(fixture.frontendUrl)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/') throw new DriverError(2, 'preparation requires explicit http://127.0.0.1:PORT/ frontend')
  return { fixture, release, digest, cli, port: url.port, runtimeRoot: resolve(runtimeRoot), output: resolve(output) }
}
export async function prepare(options, { preflight = false, serve = false, mode = 'seed', seedFixture, seedReceiptSha256 } = {}) {
  const inputs = preparationInputs(options), { fixture, release, digest, cli, port, runtimeRoot, output } = inputs
  if (!['seed', 'observe'].includes(mode)) throw new DriverError(2, 'unknown preparation mode')
  if (mode === 'observe' && (!seedFixture || !/^[a-f0-9]{64}$/.test(seedReceiptSha256 ?? '') || createHash('sha256').update(readFileSync(seedFixture)).digest('hex') !== seedReceiptSha256)) throw new DriverError(2, 'observe requires exact prior seed receipt bytes')
  // Isolated native execution environment: no ambient credential layers or
  // daily .env files; the model route points only at a closed loopback socket.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|ComSpec|TEMP|TMP|LANG|LC_.*|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(key)))
  Object.assign(environment, { DSH_HOME: fixture.home, AGENTS_HOME: join(fixture.home, 'agents'), DSH_UI_FIXTURE_KEY: 'inert-local-fixture' })
  const run = args => execFileSync(process.execPath, args, { cwd: fixture.cwd, env: environment, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 })
  const nodeVersion = run(['--version']).trim() // same-invocation child capability
  if (preflight) {
    const report = { schema: 'dsh-ui-preparation/v1', status: 'preflight_passed', sourceCommit: release.gitHead, artifactSha256: digest, nodeVersion, runtimeVersion: fixture.hostVersion, mode, installs: false, hostStarted: false, nativeAcceptance: 'not_run' }
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); return report
  }
  const stages = [], result = { schema: 'dsh-ui-preparation/v1', status: 'failed', sourceCommit: release.gitHead, artifactSha256: digest, fixturePath: resolve(options.fixturePath), profileRoot: fixture.profileRoot, stages, mode, hostStarted: false, nativeAcceptance: 'not_run' }
  let child, log
  const stopped = new AbortController(), stop = () => stopped.abort()
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try {
    if (mode === 'seed') {
      stages.push('install')
      run([cli, 'plugin', '--profile', 'web', 'add', '--ignore-scripts', '--config.auto-install-peers=false', resolve(options.artifact)])
    }
    const installed = join(fixture.profileRoot, 'node_modules', 'dsh-completion-guard')
    const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
    if (manifest.gitHead !== release.gitHead || manifest.version !== release.version) throw new DriverError(5, 'installed manifest differs from frozen release')
    const locker = join(installed, 'bin', 'dsh-completion-guard-host-lock.mjs'), lock = ['--profile', 'web', '--runtime-root', runtimeRoot, '--profile-root', fixture.profileRoot]
    stages.push('inspect')
    const inspected = JSON.parse(run([locker, 'inspect', ...lock]))
    if (inspected.status !== 'supported') throw new DriverError(5, 'installed graph refused')
    let injected = inspected
    if (mode === 'seed') { stages.push('inject'); injected = JSON.parse(run([locker, 'inject', ...lock])) }
    if (injected.status !== 'supported') throw new DriverError(5, 'host lock injection refused')
    const yamlModule = await import(pathToFileURL(createRequire(cli).resolve('js-yaml')).href)
    const profilePatches = (yamlModule.default ?? yamlModule).load(readFileSync(join(fixture.profileRoot, 'cordis.patch.yml'), 'utf8'))
    const guardConfig = profilePatches.find(row => row.id === 'context-guard' && row.config?.hostLockPackages)?.config
    if (!guardConfig) throw new DriverError(5, 'injected Guard configuration unavailable')
    guardConfig.activation = 'always'
    const protectedOutput = mode === 'observe' ? resolve(seedFixture) : output + '.protected-fixture.json'
    const observerReady = output + '.observer-ready.json'
    const overlay = output + '.isolation.patch.yml'
    writeFileSync(overlay, JSON.stringify([
      { id: 'context-guard', config: guardConfig },
      { insert: [{ id: 'guard-ui-session-fixture', name: new URL('./ui-session-host-fixture.mjs', import.meta.url).href, config: { fixturePath: resolve(options.fixturePath), runtimeRoot, guardConfig, output: protectedOutput, mode, ...(mode === 'observe' ? { seedReceiptSha256, runOutput: observerReady } : {}) } }] },
      { id: 'goal-round-driver', disabled: true },
      { id: 'session-log-deepseek', disabled: true },
      { id: 'session-telemetry-otel', disabled: true },
      { id: 'llm-deepseek-api-key', config: { baseURL: 'http://127.0.0.1:1/anthropic', apiKeyEnv: 'DSH_UI_FIXTURE_KEY' } },
    ]), { flag: 'wx' })
    stages.push('dump_and_verify')
    const composed = output + '.composed.yml'
    writeFileSync(composed, run([cli, '--profile', 'web', '--patch', overlay, '--dump-config']), { flag: 'wx' })
    const verified = JSON.parse(run([locker, 'verify-dump', ...lock, '--dump-config', composed]))
    if (verified.status !== 'supported') throw new DriverError(5, 'composed lock refused')
    result.status = 'prepared'; result.protectedFixtureOutput = protectedOutput; result.hostLockDigest = injected.host_lock_digest
    if (serve) {
      stages.push('host_start')
      log = createWriteStream(output + '.host.log', { flags: 'wx' })
      child = spawn(process.execPath, [cli, '--profile', 'web', '--patch', overlay, '--host', '127.0.0.1', '--port', port, '--no-open'], { cwd: fixture.cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
      child.stdout.pipe(log); child.stderr.pipe(log)
      await once(child, 'spawn')
      result.hostStarted = true; result.ownedPid = child.pid; result.status = 'host_running'
      const bootDeadline = Date.now() + 120000
      while (!existsSync(mode === 'observe' ? observerReady : protectedOutput)) {
        if (stopped.signal.aborted) throw new DriverError(130, 'interrupted during protected fixture creation')
        if (existsSync((mode === 'observe' ? observerReady : protectedOutput) + '.failed.json') || child.exitCode !== null) throw new DriverError(5, 'protected fixture creation failed')
        if (Date.now() > bootDeadline) throw new DriverError(5, 'protected fixture creation timed out')
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      if (mode === 'observe') { const observed = JSON.parse(readFileSync(observerReady, 'utf8')); if (observed.status !== 'observer_ready' || observed.seedReceiptSha256 !== seedReceiptSha256 || observed.nonce !== fixture.nonce) throw new DriverError(5, 'observer readiness identity mismatch') }
      const protectedFixture = validateFixture(JSON.parse(readFileSync(protectedOutput, 'utf8')), true)
      if (protectedFixture.protection.guardVersion !== release.version) throw new DriverError(5, 'loaded fixture Guard version mismatch')
      result.protection = protectedFixture.protection
      writeFileSync(output + '.ready.json', JSON.stringify({ ...result, readiness: 'protected_fixture_persisted; driver still verifies rendered identities and live protection' }, null, 2) + '\n', { flag: 'wx' })
      await new Promise((resolveWait, reject) => {
        const finished = () => resolveWait()
        const gone = code => reject(new DriverError(5, 'owned host exited before stop', { code }))
        stopped.signal.addEventListener('abort', finished, { once: true }); child.once('exit', gone)
        if (stopped.signal.aborted) resolveWait()
        result.detachSignals = () => { stopped.signal.removeEventListener('abort', finished); child.removeListener('exit', gone) }
      })
      result.status = 'stopped'
    }
  } catch (error) { result.status = 'failed'; result.reason = error.message; throw error }
  finally {
    result.detachSignals?.(); delete result.detachSignals
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop)
    if (child?.pid) {
      try {
        if (process.platform === 'win32') {
          execFileSync(join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { timeout: 10000, stdio: 'ignore' })
          await Promise.race([child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, 'exit'), new Promise((_, reject) => { const timer = setTimeout(() => reject(new DriverError(5, 'owned host stop timed out')), 5000); timer.unref() })])
        } else {
          const alive = () => { try { process.kill(-child.pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
          if (alive()) process.kill(-child.pid, 'SIGTERM')
          const deadline = Date.now() + 5000
          while (alive() && Date.now() < deadline) await new Promise(resolveWait => setTimeout(resolveWait, 50))
          if (alive()) process.kill(-child.pid, 'SIGKILL')
          const forcedDeadline = Date.now() + 2000
          while (alive() && Date.now() < forcedDeadline) await new Promise(resolveWait => setTimeout(resolveWait, 50))
          if (alive()) throw new DriverError(5, 'owned process group remains after bounded cleanup')
        }
        result.ownedHostStopped = true
      } catch (error) { result.status = 'failed'; result.cleanupError = error.message; process.exitCode = 5 }
    }
    if (child && !result.ownedHostStopped) { result.status = 'failed'; result.cleanupError ??= 'owned process tree cleanup not established'; process.exitCode = 5 }
    log?.end()
    writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  }
  return result
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), option = key => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1] }
  const options = { fixturePath: option('--fixture'), runtimeRoot: option('--runtime-root'), artifact: option('--artifact'), artifactRecord: option('--artifact-record'), output: option('--output') }
  if (Object.values(options).some(v => !v)) { console.error('usage: --fixture FILE --runtime-root PATH --artifact TGZ --artifact-record release-artifact.json --output NEW.json [--preflight|--serve]'); process.exitCode = 2 }
  else prepare(options, { preflight: args.includes('--preflight'), serve: args.includes('--serve'), mode: option('--mode') ?? 'seed', seedFixture: option('--seed-fixture'), seedReceiptSha256: option('--seed-sha256') }).then(result => console.log(JSON.stringify({ status: result.status, output: options.output })), error => { console.error(JSON.stringify({ status: 'failed', reason: error.message })); process.exitCode = error.code ?? 3 })
}
