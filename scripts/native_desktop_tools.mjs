/** Native acceptance driver for the application's real Desktop backend.
 * init/probe run under the signed carrier's Electron Node mode. host owns
 * one IPC child with exactly the production DesktopHostProcess arguments.
 * This does not open the graphical shell or request a model.
 * Read-only audits use the same carrier, with all output paths new and outside
 * the carrier/profile. Arguments after mode, archive, profile, output:
 * audit-resolution HOME KEY_FILE before|after; use the same real profile.
 * audit-resolution-compare BEFORE AFTER KEY_FILE authenticates both observations.
 * audit-config BEFORE_DUMP AFTER_DUMP compares non-Guard composed values in memory.
 * audit-control BEFORE_DUMP AFTER_DUMP additionally checks Guard settings and
 * an enabled control outside its managed block; repeat after each injection.
 * audit-cache BEFORE_JSON AFTER_JSON DECLARATION BEFORE_WORKSPACE AFTER_WORKSPACE
 * only classifies a declared supported workspace cache delta. The supplied
 * files and carrier must themselves be authenticated by the caller. These are
 * narrow checks: none proves installation, official host-lock or loading.
 *
 * Operator sequence (not run automatically by native or daily workflows):
 * Set ELECTRON_RUN_AS_NODE=1 and invoke the verified Desktop executable with
 * --expose-internals, this script, and the following positional arguments.
 * Use the physical original PROFILE and HOME, a private 32-byte random KEY,
 * and new OUT files outside the archive/profile for every invocation:
 *   audit-resolution ARCHIVE PROFILE BEFORE HOME KEY before
 *   [perform the authorized change on that same original profile]
 *   audit-resolution ARCHIVE PROFILE AFTER HOME KEY after
 *   audit-resolution-compare ARCHIVE PROFILE RESULT BEFORE AFTER KEY
 * After each official enable/inject and fresh dump, compare with the original:
 *   audit-control ARCHIVE PROFILE RESULT BEFORE_DUMP AFTER_DUMP
 * audit-config uses the same arguments when control placement is not in scope.
 * Use audit-cache only for its explicitly declared supported cache exception;
 * preserve strict-difference evidence and investigate any other delta. Record
 * the actual collection timing and separately verify host-lock and loading. */
import { createRequire } from 'node:module'
import { execFileSync, spawn } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { captureOfficialResolution, checkControlPlacement, classifyWorkspaceCache, compareGuardConfiguration,
  compareNonGuardConfiguration, compareResolution, configurationShape, sealResolution, verifyResolution } from './native_profile_preservation.mjs'

const [mode, archive, profile, output, marketNonce, marketExpectedVersion, extra, oldWorkspace, newWorkspace] = process.argv.slice(2)
if (!['init', 'probe', 'host', 'audit-resolution', 'audit-config', 'audit-control', 'audit-cache', 'audit-resolution-compare'].includes(mode) || !archive || !profile) throw Error('Desktop driver inputs missing')
const runtime = join(archive, 'dsh')
const anchor = join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const resources = dirname(archive)
if (mode !== 'host') {
  const require = createRequire(anchor)
  const bootModule = require.resolve('@deepseek-ai/dsh-app-boot')
  const boot = await import(pathToFileURL(bootModule).href)
  if (mode === 'init') {
    const { PROFILE_TEMPLATES } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-official-bundles')).href)
    await boot.initProfile(profile, PROFILE_TEMPLATES.web.bundles)
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
  } else if (mode.startsWith('audit-')) {
    try {
    if (!output || !marketNonce || !marketExpectedVersion) throw Error('preservation audit inputs missing')
    const inside = (parent, child) => { const path = relative(resolve(parent), resolve(child)); return path === '' || (path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path)) }
    const outputParent = realpathSync(dirname(output))
    if (inside(realpathSync(profile), outputParent) || inside(realpathSync(archive), outputParent)) throw Error('audit output must be outside observed trees')
    const bootRequire = createRequire(bootModule)
    const yaml = bootRequire('js-yaml')
    const include = await import(pathToFileURL(bootRequire.resolve('@deepseek-ai/cordis-plugin-include')).href)
    const read = path => new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path))
    const parseRows = text => {
      if (text.split(/\r?\n/).every(line => !line.trim() || line.trimStart().startsWith('#'))) return []
      return yaml.load(text, { schema: include.entryListSchema })
    }
    let result
    if (mode === 'audit-resolution') {
      if (!['before', 'after'].includes(extra)) throw Error('resolution_phase_invalid')
      const key = readFileSync(marketExpectedVersion)
      const modules = [bootRequire.resolve('@deepseek-ai/cordis-plugin-include'),
        bootRequire.resolve('@deepseek-ai/cordis-plugin-loader'), require.resolve('@deepseek-ai/dsh-official-bundles'),
        join(dirname(bootModule), 'worker/profile-resolution-bootstrap.js')]
      result = await captureOfficialResolution({ boot, anchor, profile, home: marketNonce,
        carrier: { executable: process.execPath, bootModule, driver: fileURLToPath(import.meta.url), modules } }, key)
      result = sealResolution(result, key, extra)
    } else if (mode === 'audit-resolution-compare') {
      if (!extra) throw Error('resolution key missing')
      const before = JSON.parse(read(marketNonce)), after = JSON.parse(read(marketExpectedVersion))
      const key = readFileSync(extra)
      const verifiedBefore = verifyResolution(before, key), verifiedAfter = verifyResolution(after, key)
      if (verifiedBefore.phase !== 'before' || verifiedAfter.phase !== 'after') throw Error('resolution_phase_invalid')
      const select = ({ profile, carrier, resolution, entries }) => ({ profile, carrier, resolution, entries })
      result = compareResolution(select(verifiedBefore), select(verifiedAfter))
    } else if (mode === 'audit-config' || mode === 'audit-control') {
      const before = parseRows(read(marketNonce)), after = parseRows(read(marketExpectedVersion))
      result = { ...compareNonGuardConfiguration(before, after),
        beforeShape: configurationShape(before), afterShape: configurationShape(after) }
      if (mode === 'audit-control') {
        result.guard = compareGuardConfiguration(before, after)
        result.control = checkControlPlacement(read(join(profile, 'cordis.patch.yml')), after, parseRows)
        if (result.guard.status !== 'matched') result.status = 'changed'
      }
    } else {
      if (!extra || !oldWorkspace || !newWorkspace) throw Error('cache declaration or workspace comparison missing')
      const strictJson = path => {
        const raw = read(path), json = JSON.parse(raw), parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA })
        if (!isDeepStrictEqual(json, parsed)) throw Error('cache strict JSON mismatch')
        return json
      }
      const beforeText = read(marketNonce), afterText = read(marketExpectedVersion)
      result = { ...classifyWorkspaceCache(strictJson(marketNonce), strictJson(marketExpectedVersion), strictJson(extra),
        readFileSync(oldWorkspace), readFileSync(newWorkspace)),
        strict_bytes: beforeText === afterText ? 'equal' : 'different' }
    }
    writeFileSync(output, JSON.stringify(result) + '\n', { flag: 'wx', mode: 0o600 })
    if (['changed', 'changed_or_unbound'].includes(result.status)) process.exitCode = 1
    } catch (error) {
      // Parser and filesystem errors may embed raw private configuration.
      const reason = /^[a-z][a-z0-9_]{0,70}$/.test(error?.message ?? '') ? error.message : 'unclassified'
      process.stderr.write(`preservation_audit_failed: ${reason}\n`)
      process.exitCode = 1
    }
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
