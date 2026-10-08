/** Native acceptance driver for the application's real Desktop backend.
 * init/probe run under the signed carrier's Electron Node mode. host owns
 * one IPC child with exactly the production DesktopHostProcess arguments.
 * This does not open the graphical shell or request a model. */
import { createRequire } from 'node:module'
import { execFileSync, spawn } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const [mode, archive, profile, output, marketNonce, marketExpectedVersion] = process.argv.slice(2)
if (!['init', 'probe', 'host'].includes(mode) || !archive || !profile) throw Error('Desktop driver inputs missing')
const runtime = join(archive, 'dsh')
const anchor = join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const resources = dirname(archive)
if (mode !== 'host') {
  const require = createRequire(anchor)
  const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)
  if (mode === 'init') {
    boot.initProfile(profile, boot.PROFILE_TEMPLATES.web.bundles)
  } else if (mode === 'probe') {
    const patchFile = join(profile, 'cordis.patch.yml')
    const patches = boot.loadOverlayPatches('dsh', patchFile)
    const guard = patches.find(row => row.id === 'context-guard')
    if (!guard?.config) throw Error('Injected Desktop Guard config missing')
    delete guard.config.activation // Exercise the 0.9.0 default with per-session restore bindings.
    // The deterministic probe owns turn/step writes; retain goals services,
    // but disable the separate automatic round writer in this isolated profile.
    patches.push({ id: 'goal-round-driver', disabled: true })
    patches.push(JSON.parse(readFileSync(output, 'utf8')))
    writeFileSync(patchFile, JSON.stringify(patches))
  }
} else {
  if (!output) throw Error('Desktop host output missing')
  const executable = process.platform === 'darwin'
    ? join(dirname(resources), 'MacOS', 'DeepSeek Harness')
    : join(dirname(resources), 'DeepSeek Harness.exe')
  const support = join(resources, 'runtime')
  const log = createWriteStream(output + '.host.log', { flags: 'wx', mode: 0o600 })
  const child = spawn(executable, ['--expose-internals',
    join(runtime, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js'),
    runtime, profile, join(support, 'primary-runtime'), join(support, 'pnpm', 'bin', 'pnpm.mjs'), join(support, 'bin')],
  { cwd: profile, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
  let ready = false, shutdown = false, fatal = false, exit, stopping = false
  const closed = new Promise(resolve => child.once('exit', (code, signal) => { exit = { code, signal }; resolve() }))
  child.on('error', () => { fatal = true })
  child.on('message', message => {
    if (message?.type === 'ready') ready = true
    if (message?.type === 'fatal') fatal = true
    if (message?.type === 'shutdown-complete') shutdown = true
    // Authenticated URLs and platform credentials never enter the annex.
  })
  const stop = async () => {
    if (stopping) return
    stopping = true
    if (child.connected) child.send({ type: 'shutdown' })
    await Promise.race([closed, delay(20_000, undefined, { ref: false })])
    if (!exit) { child.kill(); await Promise.race([closed, delay(5_000, undefined, { ref: false })]) }
    if (!exit) { child.kill('SIGKILL'); await closed }
  }
  process.once('SIGTERM', () => { void stop() })
  process.once('SIGINT', () => { void stop() })
  // Real-market observation (desktop-market-coexistence/v1): while the owned
  // backend runs, discover its own loopback TCP listeners by PID and read the
  // market's versioned capabilities route over real HTTP. This observes the
  // actual loaded market instance of THIS backend; a missing, disabled or
  // broken market simply never matches and the receipt records not_observed.
  // Guarded by explicit argv so the existing desktop v2 run is unchanged.
  const marketObservation = marketNonce && marketExpectedVersion ? observeMarket(child) : null
  async function observeMarket(child) {
    const observation = { schema: 'dsh-desktop-market-observation/v1', nonce: marketNonce,
      expected_market_version: marketExpectedVersion, child_pid: child.pid, status: 'not_observed' }
    try {
      const deadline = Date.now() + 120_000
      while (!exit && !fatal && !stopping && Date.now() < deadline) {
        if (ready) {
          const ports = listeningPorts(child.pid)
          for (const port of ports.slice(0, 64)) {
            const payload = await capabilitiesPayload(port)
            if (!payload) continue
            if (payload.schema !== 'dsh-market/update-api/v1' || payload.apiVersion !== 1
              || payload.marketVersion !== marketExpectedVersion
              || payload.profile !== 'desktop' || payload.runtime !== 'desktop'
              || String(payload.bootId ?? '').split('-')[0] !== String(child.pid)) continue
            observation.status = 'observed'
            observation.port = port
            observation.observed_at = new Date().toISOString()
            observation.capabilities = payload
            break
          }
          if (observation.status === 'observed') break
        }
        await delay(1000, undefined, { ref: false })
      }
    } catch (error) {
      observation.error = String(error?.message ?? error).slice(0, 300)
    }
    writeFileSync(output + '.market.json', JSON.stringify(observation), { flag: 'wx', mode: 0o600 })
    return observation
  }
  try {
    const deadline = Date.now() + 480_000
    while (!exit && !fatal && !stopping && Date.now() < deadline) {
      const receipts = (await import('node:fs')).readdirSync(dirname(output))
        .filter(name => name.startsWith(output.split(/[\\/]/).at(-1) + '.probe.') && name.endsWith('.json'))
      if (ready && receipts.length && (!marketObservation || existsSync(output + '.market.json'))) break
      await delay(250)
    }
  } finally {
    if (marketObservation && !existsSync(output + '.market.json')) await marketObservation
    await stop(); log.end()
    writeFileSync(output + '.driver.json', JSON.stringify({ schema: 'dsh-desktop-driver/v1',
      ready, fatal, shutdown_acknowledged: shutdown, exit_code: exit?.code ?? null,
      signal: exit?.signal ?? null, pid: child.pid }), { flag: 'wx', mode: 0o600 })
  }
  if (!ready || fatal || !shutdown || exit?.code !== 0) process.exitCode = 1
}

/** Loopback TCP ports this exact child process is listening on. OS process
 * observation of an owned process only; no host internals are assumed. */
function listeningPorts(pid) {
  const ports = []
  if (process.platform === 'win32') {
    const table = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 15_000 })
    for (const line of table.split(/\r?\n/)) {
      const columns = line.trim().split(/\s+/)
      if (columns.length < 5 || columns[3] !== 'LISTENING' || columns[4] !== String(pid)) continue
      const port = Number(columns[1].split(':').pop())
      if (Number.isInteger(port) && port > 0 && port < 65536) ports.push(port)
    }
  } else {
    const table = execFileSync('lsof', ['-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-n', '-P'],
      { encoding: 'utf8', timeout: 15_000 })
    for (const line of table.split(/\r?\n/).slice(1)) {
      const match = line.match(/(?:127\.0\.0\.1|\[::1\]|\*):(\d+)\s+\(LISTEN\)/)
      if (match) ports.push(Number(match[1]))
    }
  }
  return [...new Set(ports)]
}

/** Read the market's versioned capabilities route over real loopback HTTP.
 * Returns the parsed payload only when the endpoint answers JSON; any other
 * answer (wrong port, non-market listener, proxy interference) is undefined. */
async function capabilitiesPayload(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/dsh-market/api/v1/capabilities`,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(1500), redirect: 'error' })
    if (!response.ok) return undefined
    const text = await response.text()
    if (text.length > 65536) return undefined
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
