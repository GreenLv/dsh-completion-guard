import { expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))

// This is deliberately limited to a single owned Node worker. Its fixture
// mocks the registry and release command, and launches no descendant processes.
// A missing close after forced termination leaves the fixture for diagnosis.
function runOwned(args: string[], env: NodeJS.ProcessEnv, startMs: number, runMs: number) {
  return new Promise<{ code: number | null; pid: number | undefined; timedOut: boolean; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: repository, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', ready = false, timedOut = false
    let childError: Error | undefined
    let timer: NodeJS.Timeout
    let watchdog: NodeJS.Timeout | undefined
    const stop = () => {
      timedOut = true
      child.kill('SIGKILL')
      watchdog = setTimeout(() => reject(Object.assign(new Error('worker exit unknown'), { childStateUnknown: true })), 3000)
    }
    timer = setTimeout(stop, startMs)
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
      if (!ready && stdout.includes('worker_start')) { ready = true; clearTimeout(timer); timer = setTimeout(stop, runMs) }
      if (stdout.length > 65536 && !timedOut) { clearTimeout(timer); stop() }
    })
    child.stderr.on('data', chunk => { stderr += String(chunk); if (stderr.length > 65536 && !timedOut) { clearTimeout(timer); stop() } })
    child.once('error', error => {
      childError = error
      clearTimeout(timer)
      if (!watchdog) watchdog = setTimeout(() => reject(Object.assign(new Error('worker exit unknown'), { childStateUnknown: true })), 3000)
    })
    child.once('close', code => {
      clearTimeout(timer); if (watchdog) clearTimeout(watchdog)
      if (childError) reject(childError)
      else resolve({ code, pid: child.pid, timedOut, stdout, stderr })
    })
  })
}

it('runs the actual release fixture with exact-version registry responses, in-flight refusal, reconciliation and no republish', async () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-native-release-owning-'))
  let phase = 'prepare', safeToClean = true
  const started = performance.now()
  try {
    const runtimeRoot = join(root, 'runtime'), profileRoot = join(root, 'profile')
    const anchor = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    mkdirSync(dirname(anchor), { recursive: true })
    writeFileSync(anchor, JSON.stringify({ name: '@deepseek-ai/dsh', private: true }))
    const link = (target: string, path: string) => symlinkSync(realpathSync(target), path, process.platform === 'win32' ? 'junction' : 'dir')
    for (const name of ['dsh-session', 'dsh-llm']) link(join(repository, 'node_modules', '@deepseek-ai', name), join(runtimeRoot, 'node_modules', '@deepseek-ai', name))
    mkdirSync(join(profileRoot, 'node_modules'), { recursive: true })
    link(repository, join(profileRoot, 'node_modules', 'dsh-completion-guard'))
    const prepareMs = Math.round(performance.now() - started)
    phase = 'worker'
    const result = await runOwned([join(repository, 'tests/native-release-worker.mjs'), root, repository],
      { ...process.env, DSH_HOME: join(root, 'dsh-home') }, 8000, 12000)
    expect(result.timedOut, `${result.stdout}\n${result.stderr}`).toBe(false)
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout).toMatch(/load_start \d+ms/)
    expect(result.stdout).toMatch(/execute_start \d+ms/)
    expect(result.stdout).toMatch(/execute_complete \d+ms/)
    expect(result.stdout).toContain('{"positive":true,"negative":true,"mock_only":true}')
    console.info(`release fixture prepare=${prepareMs}ms; ${result.stdout.trim().replaceAll('\n', '; ')}`)
  } catch (error) {
    if ((error as { childStateUnknown?: boolean }).childStateUnknown) safeToClean = false
    throw new Error(`release fixture ${phase} failed after ${Math.round(performance.now() - started)}ms${safeToClean ? '' : `; retained ${root}`}`, { cause: error })
  } finally {
    if (safeToClean) {
      const cleanupStarted = performance.now()
      rmSync(root, { recursive: true, force: true })
      console.info(`release fixture cleanup=${Math.round(performance.now() - cleanupStarted)}ms`)
    }
  }
}, 26000)

it('terminates an uncooperative started worker before removing its fixture', async () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-release-timeout-'))
  let safeToClean = true
  try {
    const script = "process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(process.argv[1], String(process.pid)); process.stdout.write('worker_start\\n'); setInterval(() => {}, 1000)"
    const result = await runOwned(['-e', script, join(root, 'ready')], process.env, 8000, 250)
    expect(result.timedOut).toBe(true)
    expect(Number(readFileSync(join(root, 'ready'), 'utf8'))).toBe(result.pid)
    expect(result.code).not.toBe(0)
  } catch (error) {
    if ((error as { childStateUnknown?: boolean }).childStateUnknown) safeToClean = false
    throw error
  } finally { if (safeToClean) rmSync(root, { recursive: true, force: true }) }
  expect(existsSync(root)).toBe(false)
}, 12000)
