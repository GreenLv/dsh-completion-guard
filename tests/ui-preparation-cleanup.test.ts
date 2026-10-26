import { expect, it } from 'vitest'
import { EventEmitter, once } from 'node:events'
import { spawn } from 'node:child_process'
// @ts-expect-error Native operator entrypoint has no declaration build.
const { stopOwnedPosixChild } = await import('../scripts/prepare-ui-session-fixture.mjs')
const error = (code: string) => Object.assign(new Error('kill ' + code), { code })
function childFixture() {
  return Object.assign(new EventEmitter(), { pid: 424242, exitCode: null as number | null, signalCode: null as string | null })
}
function reap(child: ReturnType<typeof childFixture>) { child.signalCode = 'SIGTERM'; child.emit('exit', null, 'SIGTERM') }
it('UI-PREP-CLEANUP-01 reaps the known child before probing the zombie window, then proves the group absent', async () => {
  const child = childFixture(), calls: Array<string | number> = []; let stopped = false
  const kill = (_pid: number, signal: string | number) => {
    calls.push(signal)
    if (signal === 'SIGTERM') { stopped = true; setImmediate(() => reap(child)); return true }
    if (stopped && child.signalCode === null) throw error('EPERM') // actual observed zombie window
    if (stopped) throw error('ESRCH')
    return true
  }
  await stopOwnedPosixChild(child, { kill, termBudgetMs: 100, killBudgetMs: 50 })
  expect(calls).toEqual([0, 'SIGTERM', 0])
  expect(child.listenerCount('exit')).toBe(0)
})
it.each(['pre-TERM', 'TERM', 'post-reap'])('refuses EPERM at %s, rather than interpreting permission failure as gone', async stage => {
  const child = childFixture()
  const kill = (_pid: number, signal: string | number) => {
    if (stage === 'pre-TERM' || stage === 'TERM' && signal === 'SIGTERM' || stage === 'post-reap' && child.signalCode !== null) throw error('EPERM')
    if (signal === 'SIGTERM') setImmediate(() => reap(child))
    return true
  }
  await expect(stopOwnedPosixChild(child, { kill, termBudgetMs: 30, killBudgetMs: 10 })).rejects.toMatchObject({ code: 'EPERM' })
})
it('does not certify a reaped leader while live group members remain, and escalates only within the fixed budgets', async () => {
  const child = childFixture(), calls: Array<string | number> = []; let gone = false
  const kill = (_pid: number, signal: string | number) => {
    calls.push(signal)
    if (signal === 'SIGTERM') setImmediate(() => reap(child))
    if (signal === 'SIGKILL') gone = true
    if (signal === 0 && gone) throw error('ESRCH')
    return true
  }
  await stopOwnedPosixChild(child, { kill, termBudgetMs: 15, killBudgetMs: 15 })
  expect(calls).toContain('SIGKILL')
})
it('waits for known exit after KILL before probing, and refuses a leader whose exit never settles', async () => {
  const child = childFixture(); let killed = false
  const kill = (_pid: number, signal: string | number) => {
    if (signal === 'SIGKILL') { killed = true; setImmediate(() => reap(child)); return true }
    if (killed && child.signalCode === null) throw error('EPERM')
    if (killed) throw error('ESRCH')
    return true
  }
  await stopOwnedPosixChild(child, { kill, termBudgetMs: 10, killBudgetMs: 30 })
  const pending = childFixture(); const start = performance.now()
  await expect(stopOwnedPosixChild(pending, { kill: () => true, termBudgetMs: 10, killBudgetMs: 10 })).rejects.toMatchObject({ code: 5 })
  expect(performance.now() - start).toBeLessThan(500)
  expect(pending.listenerCount('exit')).toBe(0)
})
it.each(['refused-KILL', 'residual-group'])('fails closed for %s after the TERM budget', async kind => {
  const child = childFixture()
  const kill = (_pid: number, signal: string | number) => {
    if (signal === 'SIGTERM') setImmediate(() => reap(child))
    if (signal === 'SIGKILL' && kind === 'refused-KILL') throw error('EPERM')
    return true
  }
  await expect(stopOwnedPosixChild(child, { kill, termBudgetMs: 10, killBudgetMs: 10 })).rejects.toMatchObject({ code: kind === 'refused-KILL' ? 'EPERM' : 5 })
})
it('refuses a spawn without an owned PID before signalling', async () => {
  let called = false
  await expect(stopOwnedPosixChild({ pid: undefined }, { kill: () => { called = true } })).rejects.toMatchObject({ code: 5 })
  expect(called).toBe(false)
})
it.skipIf(process.platform === 'win32')('reaps and verifies a real disposable detached Node process group', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' })
  await once(child, 'spawn')
  try {
    await stopOwnedPosixChild(child, { termBudgetMs: 1000, killBudgetMs: 1000 })
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    expect(() => process.kill(-child.pid!, 0)).toThrow()
  } finally {
    try { process.kill(-child.pid!, 'SIGKILL') } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e }
  }
})
