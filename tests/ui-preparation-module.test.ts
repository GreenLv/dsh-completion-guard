import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
// @ts-expect-error Native operator entrypoint has no declaration build.
const { readInjectedGuardConfig } = await import('../scripts/prepare-ui-session-fixture.mjs')
// @ts-expect-error Native operator entrypoint has no declaration build.
const { errorExitCode } = await import('../scripts/measure-session-switch.mjs')

it('uses the real official boot parser through a physical dependency anchor, for YAML and JSON Unicode patches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-ui-boot-'))
  try {
    const require = createRequire(import.meta.url)
    const sdk = dirname(require.resolve('@deepseek-ai/dsh-fs-local/package.json'))
    const runtime = join(root, 'runtime'), profile = join(root, 'profile')
    const launcher = join(runtime, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(dirname(launcher), { recursive: true }); mkdirSync(profile)
    // Physical routing control only: the real SDK package owns a boot-parser
    // dependency, just as the real launcher does. No host is started here.
    symlinkSync(realpathSync(sdk), launcher, process.platform === 'win32' ? 'junction' : 'dir')
    const patch = join(profile, 'cordis.patch.yml')
    for (const content of ['- id: context-guard\n  config:\n    hostLockPackages: []\n    note: "中文配置"\n', JSON.stringify([{ id: 'context-guard', config: { hostLockPackages: [], note: '中文配置' } }])]) {
      writeFileSync(patch, content)
      expect(await readInjectedGuardConfig(runtime, profile)).toEqual({ hostLockPackages: [], note: '中文配置' })
      expect(readFileSync(patch, 'utf8')).toBe(content)
    }
    for (const content of ['not: array', '- id: [', '[]', JSON.stringify(Array(2).fill({ id: 'context-guard', config: { hostLockPackages: [] } }))]) {
      writeFileSync(patch, content)
      await expect(readInjectedGuardConfig(runtime, profile)).rejects.toThrow()
    }
    const missing = join(root, 'missing-runtime')
    mkdirSync(join(missing, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
    writeFileSync(join(missing, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), '{}')
    // Plain Node is the actual CLI path: do not let Vitest's dependency
    // resolver fallback make a missing runtime dependency look available.
    const broken = join(missing, 'node_modules', '@deepseek-ai', 'dsh-app-boot')
    mkdirSync(broken)
    writeFileSync(join(broken, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-app-boot', main: 'absent.js' }))
    const code = `import {readInjectedGuardConfig} from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'scripts/prepare-ui-session-fixture.mjs')).href)};import {errorExitCode} from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'scripts/measure-session-switch.mjs')).href)};try{await readInjectedGuardConfig(${JSON.stringify(missing)},${JSON.stringify(profile)})}catch(error){console.log(JSON.stringify({code:error.code,exit:errorExitCode(error)}));process.exitCode=errorExitCode(error)}`
    const environment = { ...process.env }; delete environment.NODE_PATH; delete environment.NODE_OPTIONS
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: environment })
    expect(child.status).toBe(3)
    expect(JSON.parse(child.stdout)).toEqual({ code: 'MODULE_NOT_FOUND', exit: 3 })
    expect(child.stderr).not.toContain('ERR_INVALID_ARG_TYPE')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
it.each([['MODULE_NOT_FOUND', 3], ['ENOENT', 3], [undefined, 3], [0, 3], [-1, 3], [256, 3], [2, 2], [5, 5], [130, 130]])('maps error code %s to an integer nonzero exit', (code, expected) => {
  expect(errorExitCode({ code })).toBe(expected)
})

it('consumes only a unique complete official same-origin auth URL without relaxing authentication', async () => {
  // @ts-expect-error Native operator entrypoint has no declaration build.
  const { startupWebUrl } = await import('../scripts/measure-session-switch.mjs')
  const base = 'http://127.0.0.1:34567/'
  const url = base + '?token=private-fixture-token'
  expect(startupWebUrl(Buffer.from(`startup ${url}\n`), base)).toBe(url)
  expect(startupWebUrl(Buffer.from(`startup ${url}\nrepeat ${url}\n`), base)).toBe(url)
  for (const line of [url, base + '\n', 'http://127.0.0.1:34568/?token=private-fixture-token\n', base + '?token=a&token=b\n', base + '?token=a&other=b\n', base + '?token=a\n' + base + '?token=b\n']) {
    expect(() => startupWebUrl(Buffer.from(line), base)).toThrow()
  }
})

it('publishes complete private UTF-8 metadata and preserves existing evidence; malformed UTF-8 fails closed', async () => {
  // @ts-expect-error Native operator entrypoint has no declaration build.
  const { writeUtf8Atomic, readJsonFile } = await import('../scripts/ui-fixture-io.mjs')
  const root = mkdtempSync(join(tmpdir(), 'guard-ui-atomic-'))
  try {
    const path = join(root, 'ready.json'), value = { note: '中文配置', values: Array(1000).fill('完整') }
    writeUtf8Atomic(path, JSON.stringify(value), { flag: 'wx' })
    expect(readJsonFile(path)).toEqual(value)
    expect(() => writeUtf8Atomic(path, '{}')).toThrow('preserved')
    expect(readJsonFile(path)).toEqual(value)
    writeFileSync(join(root, 'invalid.json'), Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]))
    expect(() => readJsonFile(join(root, 'invalid.json'))).toThrow()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('verifies actual composed official model routes rather than trusting overlay IDs', async () => {
  // @ts-expect-error Native operator entrypoint has no declaration build.
  const { verifyNoModelComposition } = await import('../scripts/prepare-ui-session-fixture.mjs')
  const api = { name: '@deepseek-ai/dsh-llm-deepseek-api-key', config: { baseURL: 'http://127.0.0.1:1/anthropic', apiKeyEnv: 'DSH_UI_FIXTURE_KEY' } }
  expect(verifyNoModelComposition([api, { name: '@deepseek-ai/dsh-session-title-first-prompt-llm', disabled: true }])).toMatchObject({ modelExecution: 'not_requested' })
  expect(() => verifyNoModelComposition([{ ...api, config: {} }])).toThrow()
  expect(() => verifyNoModelComposition([api, { name: '@deepseek-ai/dsh-session-title-first-prompt-llm' }])).toThrow()
  expect(() => verifyNoModelComposition([api, { name: '@deepseek-ai/dsh-llm-pi-ai' }])).toThrow()
})


it('inherits only anonymous explicit loopback proxy aliases with native-equivalent refusal controls', async () => {
  // @ts-expect-error Native operator entrypoint has no declaration build.
  const { anonymousLoopbackProxyEnvironment: select } = await import('../scripts/prepare-ui-session-fixture.mjs')
  expect(select({ HTTP_PROXY: 'http://127.0.0.1:34567/', http_proxy: 'http://127.0.0.1:34567', DEEPSEEK_API_KEY: 'excluded', NO_PROXY: '*' })).toEqual({ HTTP_PROXY: 'http://127.0.0.1:34567', http_proxy: 'http://127.0.0.1:34567', NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1' })
  expect(select({ https_proxy: 'https://[::1]:443/' }).HTTPS_PROXY).toBe('https://[::1]:443')
  expect(select({})).toEqual({})
  expect(() => select({ HTTP_PROXY: 'http://localhost:34567', http_proxy: 'http://localhost:34568' })).toThrow('install_proxy_ambiguous')
  for (const value of ['http://user:private@127.0.0.1:34567', 'http://@127.0.0.1:34567', 'http://remote.example:34567', 'socks5://127.0.0.1:34567', 'http://127.0.0.1', 'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:34567/path', 'http://127.0.0.1:34567?secret=value', 'http://127.0.0.1:34567#fragment', ' http://127.0.0.1:34567']) {
    expect(() => select({ HTTP_PROXY: value })).toThrow('install_proxy_unsupported')
  }
})
