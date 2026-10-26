#!/usr/bin/env node
/** Task-owned Web preparation only; does not replace native-acceptance/v2. */
import { writeUtf8Atomic, readJsonFile, readUtf8File, parseJsonBytes } from './ui-fixture-io.mjs'
import { readFileSync, existsSync, createWriteStream, mkdirSync } from 'node:fs'
import { resolve, join, dirname, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { once } from 'node:events'
import { runtimeRequire } from './native_host_probe.mjs'
import { validateFixture, DriverError, errorExitCode, startupWebUrl } from './measure-session-switch.mjs'

export async function readOfficialPatches(runtimeRoot, path) {
  const require = runtimeRequire(runtimeRoot)
  const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)
  if (typeof boot.loadOverlayPatches !== 'function') throw new DriverError(3, 'official overlay parser unavailable')
  readUtf8File(path)
  return boot.loadOverlayPatches('dsh', path)
}
export async function readInjectedGuardConfig(runtimeRoot, profileRoot) {
  const patches = await readOfficialPatches(runtimeRoot, join(profileRoot, 'cordis.patch.yml'))
  const guards = patches.filter(row => row.id === 'context-guard' && row.config && typeof row.config === 'object' && !Array.isArray(row.config) && Array.isArray(row.config.hostLockPackages))
  if (guards.length !== 1) throw new DriverError(5, 'injected Guard configuration missing or ambiguous')
  return guards[0].config
}
export function verifyNoModelComposition(entries) {
  const api = entries.filter(row => row.name === '@deepseek-ai/dsh-llm-deepseek-api-key')
  if (api.length !== 1 || api[0].disabled === true || api[0].config?.baseURL !== 'http://127.0.0.1:1/anthropic' || api[0].config?.apiKeyEnv !== 'DSH_UI_FIXTURE_KEY') throw new DriverError(5, 'inert official model route not composed')
  const disabled = new Set(['@deepseek-ai/dsh-llm-pi-ai', '@deepseek-ai/dsh-llm-deepseek-account', '@deepseek-ai/dsh-deepseek-account-platform', '@deepseek-ai/dsh-api-account-controller', '@deepseek-ai/dsh-client-ui-settings-account', '@deepseek-ai/dsh-session-title-first-prompt-llm'])
  if (entries.some(row => disabled.has(row.name) && row.disabled !== true)) throw new DriverError(5, 'background model/account route remains active')
  return { officialApiKeyRoute: 'inert-loopback', otherProvidersAndTitles: 'disabled', modelExecution: 'not_requested' }
}

export function anonymousLoopbackProxyEnvironment(environment) {
  const selected = {}
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
    const candidates = []
    for (const spelling of [key, key.toLowerCase()]) {
      const value = environment[spelling]
      if (!value) continue
      let canonical
      try {
        if (typeof value !== 'string' || /[\u0000-\u0020]/.test(value)) throw new Error()
        const explicit = /^(https?):\/\/(\[[^\]]+\]|[^/:?#]+):(\d+)\/?$/i.exec(value)
        const url = new URL(value), port = Number(explicit?.[3])
        if (!explicit || !['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || value.includes('@') || url.username || url.password || !Number.isInteger(port) || port < 1 || port > 65535 || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error()
        canonical = `${url.protocol}//${url.hostname}:${port}`
      } catch { throw new DriverError(3, 'install_proxy_unsupported') }
      candidates.push(canonical)
    }
    if (new Set(candidates).size > 1) throw new DriverError(3, 'install_proxy_ambiguous')
    if (candidates.length) selected[key] = selected[key.toLowerCase()] = candidates[0]
  }
  if (Object.keys(selected).length) selected.NO_PROXY = selected.no_proxy = 'localhost,127.0.0.1,::1'
  return selected
}

const exitedChild = child => child.exitCode !== null || child.signalCode !== null
async function waitChildExit(child, deadline) {
  if (exitedChild(child)) return true
  const remaining = deadline - Date.now()
  if (remaining <= 0) return false
  return new Promise((resolveWait, reject) => {
    let timer
    const finish = (value, error) => {
      clearTimeout(timer); child.removeListener('exit', onExit); child.removeListener('error', onError)
      if (error) reject(error); else resolveWait(value)
    }
    const onExit = () => finish(true), onError = error => finish(false, error)
    child.once('exit', onExit); child.once('error', onError)
    timer = setTimeout(() => finish(false), remaining)
    if (exitedChild(child)) finish(true)
  })
}
/** Reap the known leader before probing its group; EPERM always refuses.
 * A reaped leader alone is insufficient: every successful exit also proves
 * the owned process group absent. Budgets include waiting and group checks.
 */
export async function stopOwnedPosixChild(child, { termBudgetMs = 5000, killBudgetMs = 2000, kill = process.kill.bind(process) } = {}) {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) throw new DriverError(5, 'owned child identity unavailable')
  const alive = () => { try { kill(-child.pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
  const signalGroup = signal => { try { kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error } }
  const waitGroupGone = async deadline => {
    while (alive()) {
      if (Date.now() >= deadline) return false
      await new Promise(resolveWait => setTimeout(resolveWait, Math.min(50, Math.max(1, deadline - Date.now()))))
    }
    return true
  }
  const termDeadline = Date.now() + termBudgetMs
  if (alive()) signalGroup('SIGTERM')
  if (await waitChildExit(child, termDeadline) && await waitGroupGone(termDeadline)) return
  const killDeadline = Date.now() + killBudgetMs
  signalGroup('SIGKILL')
  if (await waitChildExit(child, killDeadline) && await waitGroupGone(killDeadline)) return
  throw new DriverError(5, 'owned child exit or process group cleanup not established within budget')
}

export function preparationInputs({ fixturePath, runtimeRoot, artifact, artifactRecord, output }) {
  const fixture = validateFixture(readJsonFile(fixturePath))
  const release = readJsonFile(artifactRecord)
  const digest = createHash('sha256').update(readFileSync(artifact)).digest('hex')
  if (release.name !== 'dsh-completion-guard' || release.gitHead !== fixture.sourceCommit || release.sha256 !== digest || release.size !== readFileSync(artifact).length || fixture.artifactSha256 !== digest || release.filename !== basename(artifact)) throw new DriverError(2, 'fixture/frozen release identity mismatch')
  if (existsSync(output)) throw new DriverError(2, 'preparation output exists')
  const cli = join(resolve(runtimeRoot), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(cli)) throw new DriverError(3, 'official runtime CLI missing')
  const runtime = readJsonFile(join(dirname(dirname(cli)), 'package.json'))
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
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|ComSpec|PATHEXT|LANG|LC_.*)$/i.test(key)))
  Object.assign(environment, anonymousLoopbackProxyEnvironment(process.env))
  const drive = process.platform === 'win32' ? fixture.home.slice(0, 2) : ''
  Object.assign(environment, { HOME: fixture.home, USERPROFILE: fixture.home, HOMEDRIVE: drive, HOMEPATH: fixture.home.slice(drive.length),
    DSH_HOME: fixture.home, AGENTS_HOME: join(fixture.home, 'agents'), DSH_UI_FIXTURE_KEY: 'inert-local-fixture',
    APPDATA: join(fixture.home, 'AppData', 'Roaming'), LOCALAPPDATA: join(fixture.home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(fixture.home, 'config'), XDG_CACHE_HOME: join(fixture.home, 'cache'), XDG_DATA_HOME: join(fixture.home, 'data'),
    TMPDIR: join(fixture.home, 'tmp'), TMP: join(fixture.home, 'tmp'), TEMP: join(fixture.home, 'tmp'), DSH_TELEMETRY_DISABLED: '1' })
  for (const name of ['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'TMPDIR']) mkdirSync(environment[name], { recursive: true })
  for (const name of ['user', 'global']) {
    const path = join(fixture.home, `ui-${name}.npmrc`)
    if (!existsSync(path)) writeUtf8Atomic(path, '', { flag: 'wx' })
    else if (readUtf8File(path) !== '') throw new DriverError(3, 'task npm configuration changed')
    environment[`npm_config_${name}config`] = path
  }
  const run = args => execFileSync(process.execPath, args, { cwd: fixture.cwd, env: environment, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 })
  const nodeVersion = run(['--version']).trim() // same-invocation child capability
  if (preflight) {
    const report = { schema: 'dsh-ui-preparation/v1', status: 'preflight_passed', sourceCommit: release.gitHead, artifactSha256: digest, nodeVersion, runtimeVersion: fixture.hostVersion, mode, installs: false, hostStarted: false, nativeAcceptance: 'not_run' }
    writeUtf8Atomic(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); return report
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
    const manifest = readJsonFile(join(installed, 'package.json'))
    if (manifest.gitHead !== release.gitHead || manifest.version !== release.version) throw new DriverError(5, 'installed manifest differs from frozen release')
    const locker = join(installed, 'bin', 'dsh-completion-guard-host-lock.mjs'), lock = ['--profile', 'web', '--runtime-root', runtimeRoot, '--profile-root', fixture.profileRoot]
    stages.push('inspect')
    const inspected = JSON.parse(run([locker, 'inspect', ...lock]))
    if (inspected.status !== 'supported') throw new DriverError(5, 'installed graph refused')
    let injected = inspected
    if (mode === 'seed') { stages.push('inject'); injected = JSON.parse(run([locker, 'inject', ...lock])) }
    if (injected.status !== 'supported') throw new DriverError(5, 'host lock injection refused')
    const guardConfig = await readInjectedGuardConfig(runtimeRoot, fixture.profileRoot)
    guardConfig.activation = 'always'
    const protectedOutput = mode === 'observe' ? resolve(seedFixture) : output + '.protected-fixture.json'
    const observerReady = output + '.observer-ready.json'
    const overlay = output + '.isolation.patch.yml'
    writeUtf8Atomic(overlay, JSON.stringify([
      { id: 'context-guard', config: guardConfig },
      { insert: [{ id: 'guard-ui-session-fixture', name: new URL('./ui-session-host-fixture.mjs', import.meta.url).href, config: { fixturePath: resolve(options.fixturePath), runtimeRoot, guardConfig, output: protectedOutput, mode, ...(mode === 'observe' ? { seedReceiptSha256, runOutput: observerReady } : {}) } }] },
      { id: 'goal-round-driver', disabled: true },
      { id: 'session-title-llm', disabled: true },
      { id: 'llm-pi-ai', disabled: true },
      { id: 'llm-deepseek-account', disabled: true },
      { id: 'deepseek-account', disabled: true },
      { id: 'account-controller', disabled: true },
      { id: 'ui-settings-account', disabled: true },
      { id: 'session-log-deepseek', disabled: true },
      { id: 'session-telemetry-otel', disabled: true },
      { id: 'llm-deepseek', config: { baseURL: 'http://127.0.0.1:1/anthropic', apiKeyEnv: 'DSH_UI_FIXTURE_KEY' } },
    ]), { flag: 'wx' })
    stages.push('dump_and_verify')
    const composed = output + '.composed.yml'
    writeUtf8Atomic(composed, run([cli, '--profile', 'web', '--patch', overlay, '--dump-config']), { flag: 'wx' })
    const verified = JSON.parse(run([locker, 'verify-dump', ...lock, '--dump-config', composed]))
    if (verified.status !== 'supported') throw new DriverError(5, 'composed lock refused')
    result.noModelComposition = verifyNoModelComposition(await readOfficialPatches(runtimeRoot, composed))
    const homeCheck = JSON.parse(run(['-e', 'process.stdout.write(JSON.stringify({home:require("node:os").homedir(),secretEnvPresent:["OPENAI_API_KEY","DEEPSEEK_API_KEY","NODE_OPTIONS"].some(k=>Boolean(process.env[k]))}))']))
    if (resolve(homeCheck.home) !== resolve(fixture.home) || homeCheck.secretEnvPresent) throw new DriverError(5, 'owned HOME isolation unavailable')
    result.environmentIsolation = { homeBound: true, ambientSecretsExcluded: true }
    result.status = 'prepared'; result.protectedFixtureOutput = protectedOutput; result.hostLockDigest = injected.host_lock_digest
    if (serve) {
      stages.push('host_start')
      log = createWriteStream(output + '.host.log', { flags: 'wx', mode: 0o600 })
      result.ownedSpawnEpochMs = Date.now()
      child = spawn(process.execPath, [cli, '--profile', 'web', '--patch', overlay, '--host', '127.0.0.1', '--port', port, '--no-open'], { cwd: fixture.cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
      child.stdout.pipe(log); child.stderr.pipe(log)
      await once(child, 'spawn')
      result.ownedSpawnedEventEpochMs = Date.now()
      result.hostStarted = true; result.ownedPid = child.pid; result.status = 'host_running'
      const bootDeadline = Date.now() + 120000
      while (!existsSync(mode === 'observe' ? observerReady : protectedOutput)) {
        if (stopped.signal.aborted) throw new DriverError(130, 'interrupted during protected fixture creation')
        if (existsSync((mode === 'observe' ? observerReady : protectedOutput) + '.failed.json') || child.exitCode !== null) throw new DriverError(5, 'protected fixture creation failed')
        if (Date.now() > bootDeadline) throw new DriverError(5, 'protected fixture creation timed out')
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      if (mode === 'observe') { const observed = readJsonFile(observerReady); if (observed.status !== 'observer_ready' || observed.seedReceiptSha256 !== seedReceiptSha256 || observed.nonce !== fixture.nonce) throw new DriverError(5, 'observer readiness identity mismatch') }
      const protectedFixture = validateFixture(readJsonFile(protectedOutput), true)
      if (protectedFixture.protection.guardVersion !== release.version) throw new DriverError(5, 'loaded fixture Guard version mismatch')
      result.protection = protectedFixture.protection
      while (true) {
        try { startupWebUrl(readFileSync(output + '.host.log'), fixture.frontendUrl); break }
        catch (error) { if (error.message !== 'startup auth URL unavailable' || Date.now() > bootDeadline || child.exitCode !== null || stopped.signal.aborted) throw error }
        await new Promise(resolveWait => setTimeout(resolveWait, 50))
      }
      result.frontendAuthReady = true
      writeUtf8Atomic(output + '.ready.json', JSON.stringify({ ...result, readiness: 'protected_fixture_persisted; driver still verifies rendered identities and live protection' }, null, 2) + '\n', { flag: 'wx' })
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
          await stopOwnedPosixChild(child)
        }
        result.ownedHostStopped = true
      } catch (error) { result.status = 'failed'; result.cleanupError = error.message; process.exitCode = 5 }
    }
    if (child && !result.ownedHostStopped) { result.status = 'failed'; result.cleanupError ??= 'owned process tree cleanup not established'; process.exitCode = 5 }
    log?.end()
    writeUtf8Atomic(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  }
  return result
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), option = key => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1] }
  const options = { fixturePath: option('--fixture'), runtimeRoot: option('--runtime-root'), artifact: option('--artifact'), artifactRecord: option('--artifact-record'), output: option('--output') }
  if (Object.values(options).some(v => !v)) { console.error('usage: --fixture FILE --runtime-root PATH --artifact TGZ --artifact-record release-artifact.json --output NEW.json [--preflight|--serve]'); process.exitCode = 2 }
  else prepare(options, { preflight: args.includes('--preflight'), serve: args.includes('--serve'), mode: option('--mode') ?? 'seed', seedFixture: option('--seed-fixture'), seedReceiptSha256: option('--seed-sha256') }).then(result => console.log(JSON.stringify({ status: result.status, output: options.output })), error => { console.error(JSON.stringify({ status: 'failed', reason: error.message })); process.exitCode = errorExitCode(error) })
}
