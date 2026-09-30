/** Native acceptance driver for the application's real Desktop backend.
 * init/probe run under the signed carrier's Electron Node mode. host owns
 * one IPC child with exactly the production DesktopHostProcess arguments.
 * This does not open the graphical shell or request a model. */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { createWriteStream, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const [mode, archive, profile, output] = process.argv.slice(2)
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
    guard.config.activation = 'always'
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
  try {
    const deadline = Date.now() + 480_000
    while (!exit && !fatal && !stopping && Date.now() < deadline) {
      const receipts = (await import('node:fs')).readdirSync(dirname(output))
        .filter(name => name.startsWith(output.split(/[\\/]/).at(-1) + '.probe.') && name.endsWith('.json'))
      if (ready && receipts.length) break
      await delay(250)
    }
  } finally {
    await stop(); log.end()
    writeFileSync(output + '.driver.json', JSON.stringify({ schema: 'dsh-desktop-driver/v1',
      ready, fatal, shutdown_acknowledged: shutdown, exit_code: exit?.code ?? null,
      signal: exit?.signal ?? null, pid: child.pid }), { flag: 'wx', mode: 0o600 })
  }
  if (!ready || fatal || !shutdown || exit?.code !== 0) process.exitCode = 1
}
