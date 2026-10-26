import { expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'

const importedEntries = ['measure-session-switch.mjs', 'create-ui-session-fixture.mjs', 'prepare-ui-session-fixture.mjs', 'ui-session-host-fixture.mjs']

it('real Git checkout keeps imported executable modules LF even with autocrlf=true; native Node parses the checkout', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'guard-module-eol-'))
  try {
    const emptyConfig = join(temporary, 'empty-git-config')
    writeFileSync(emptyConfig, '')
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig }
    const exercise = (label: string, attributes: string) => {
      const repository = join(temporary, label), checkout = join(temporary, label + '-checkout')
      mkdirSync(repository); mkdirSync(checkout)
      const git = (...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=true', '-c', 'core.eol=crlf', '-c', 'core.safecrlf=false', '-c', `core.attributesFile=${emptyConfig}`, ...args], { cwd: repository, env, encoding: 'utf8' })
      git('init', '--quiet')
      writeFileSync(join(repository, '.gitattributes'), attributes)
      for (const entry of importedEntries) {
        const source = readFileSync(resolve('scripts', entry))
        // An existing Windows checkout may retain old CRLF after an attrs-only
        // fast-forward. Require actual LF bytes, not just the new declaration.
        expect(source.includes(Buffer.from('\r\n')), entry).toBe(false)
        const target = join(repository, 'scripts', entry)
        mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, source)
      }
      git('add', '--', '.gitattributes', 'scripts')
      git('checkout-index', '--all', '--force', `--prefix=${checkout.replaceAll('\\', '/')}/`)
      for (const entry of importedEntries) {
        const relative = `scripts/${entry}`
        const attributes = git('check-attr', 'eol', '--', relative).trim()
        const bytes = readFileSync(join(checkout, relative))
        expect(attributes.endsWith(label === 'protected' ? ': lf' : ': unspecified')).toBe(true)
        expect(bytes.includes(Buffer.from('\r\n')), relative).toBe(label !== 'protected')
        execFileSync(process.execPath, ['--check', join(checkout, relative)], { encoding: 'utf8' })
      }
    }
    exercise('unprotected', '') // proves that this Git invocation really emits CRLF
    exercise('protected', readFileSync('.gitattributes', 'utf8'))
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})
