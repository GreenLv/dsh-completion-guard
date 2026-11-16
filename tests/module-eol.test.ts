import { expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'

const importedEntries = ['measure-session-switch.mjs', 'create-ui-session-fixture.mjs', 'prepare-ui-session-fixture.mjs', 'ui-session-host-fixture.mjs']

// Separate both native checkout cases so a cold Windows process startup is
// attributable to a specific case. The 12 s per-case bound is a fixture
// budget, not a product performance threshold. Each child also has a bound.
for (const label of ['unprotected', 'protected'] as const) {
  it(`real Git checkout ${label} preserves the expected EOL and Node parses every module`, () => {
    const temporary = mkdtempSync(join(tmpdir(), 'guard-module-eol-'))
    let phase = 'prepare'
    const started = performance.now()
    const deadline = started + 12000
    const timings: string[] = []
    const run = (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
      const budget = Math.floor(deadline - performance.now())
      if (budget <= 0) throw new Error('fixture deadline exhausted')
      const begin = performance.now()
      try { return execFileSync(command, args, { ...options, encoding: 'utf8', timeout: budget, killSignal: 'SIGKILL' }) }
      finally { timings.push(`${phase}=${Math.round(performance.now() - begin)}ms`) }
    }
    try {
      const emptyConfig = join(temporary, 'empty-git-config')
      writeFileSync(emptyConfig, '')
      const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig }
      const repository = join(temporary, label), checkout = join(temporary, label + '-checkout')
      mkdirSync(repository); mkdirSync(checkout)
      const git = (...args: string[]) => run('git', ['-c', 'core.autocrlf=true', '-c', 'core.eol=crlf', '-c', 'core.safecrlf=false', '-c', `core.attributesFile=${emptyConfig}`, ...args], { cwd: repository, env })
      phase = 'checkout'
      git('init', '--quiet')
      writeFileSync(join(repository, '.gitattributes'), label === 'protected' ? readFileSync('.gitattributes', 'utf8') : '')
      for (const entry of importedEntries) {
        const source = readFileSync(resolve('scripts', entry))
        expect(source.includes(Buffer.from('\r\n')), entry).toBe(false)
        const target = join(repository, 'scripts', entry)
        mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, source)
      }
      git('add', '--', '.gitattributes', 'scripts')
      git('checkout-index', '--all', '--force', `--prefix=${checkout.replaceAll('\\', '/')}/`)
      const relatives = importedEntries.map(entry => `scripts/${entry}`)
      phase = 'attributes'
      const attrs = git('check-attr', 'eol', '--', ...relatives).trim().split(/\r?\n/)
      expect(attrs).toHaveLength(relatives.length)
      for (const [index, relative] of relatives.entries()) {
        expect(attrs[index].endsWith(label === 'protected' ? ': lf' : ': unspecified')).toBe(true)
        const bytes = readFileSync(join(checkout, relative))
        expect(bytes.includes(Buffer.from('\r\n')), relative).toBe(label !== 'protected')
        phase = `node-check:${relative}`
        run(process.execPath, ['--check', join(checkout, relative)])
      }
      console.info(`module EOL ${label}: ${timings.join(' ')}`)
    } catch (error) {
      throw new Error(`module EOL fixture failed in ${phase} after ${Math.round(performance.now() - started)} ms`, { cause: error })
    } finally { rmSync(temporary, { recursive: true, force: true }) }
  }, 18000)
}
