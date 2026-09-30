import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

// Exercise the shipped CLI and real importer-state selector in a fresh Node.
// Only the selected audit is intercepted: its sentinel proves the CLI route,
// never a successful byte/signature audit. Native acceptance exercises both.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'guard-desktop-cli-')); roots.push(root)
  mkdirSync(join(root, 'bin'))
  mkdirSync(join(root, 'dist', 'domain'), { recursive: true })
  const profile = join(root, 'profile'); mkdirSync(profile)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', version: '0.8.2' }))
  const cli = join(root, 'bin', 'host-lock.mjs')
  writeFileSync(cli, readFileSync(new URL('../bin/dsh-completion-guard-host-lock.mjs', import.meta.url)))
  const domain = new URL('../dist/domain/index.js', import.meta.url).href
  writeFileSync(join(root, 'dist', 'domain', 'index.js'), `
    import { hasDesktopImporterState } from ${JSON.stringify(domain)};
    export { hasDesktopImporterState };
    const refused = code => { throw Object.assign(new Error(code), { code }); };
    export const resolveActiveProfileHostLock = () => refused('test_active_audit_selected');
    export const inspectDesktopTargetGraph = (_, profile) => refused(hasDesktopImporterState(profile)
      ? 'target_profile_unmanaged_modules' : 'test_pre_install_selected');
    export const injectActiveProfileHostLock = () => refused('unexpected_inject');
    export const prepareActiveHostTrust = () => refused('unexpected_network');
    export const prepareTargetHostTrust = prepareActiveHostTrust;
    export const prepareDesktopHostTrust = prepareActiveHostTrust;
    export const inspectTargetHostGraph = () => refused('unexpected_cli_profile');
    export const evaluateConfiguredHostLock = () => refused('unexpected_evaluation');
    export const verifyComposedHostLockDump = () => refused('unexpected_dump');
  `)
  const run = (command: string) => {
    const result = spawnSync(process.execPath, [cli, command, '--profile', 'desktop',
      '--runtime-root', join(root, 'app.asar'), '--profile-root', profile], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(1)
    expect(result.stdout).toBe('')
    return JSON.parse(result.stderr).reason_code as string
  }
  return { root, profile, run }
}

describe('Desktop CLI importer selection', () => {
  it('keeps only inspect and inspect-graph eligible for dependency-free target inspection', () => {
    const f = fixture()
    expect(f.run('inspect')).toBe('test_pre_install_selected')
    expect(f.run('inspect-graph')).toBe('test_pre_install_selected')
    for (const command of ['inject', 'verify-dump', 'dump-desktop']) {
      expect(f.run(command)).toBe('test_active_audit_selected')
    }
  })

  it.each(['package-map', 'physical-index', 'malformed-index', 'empty-modules', 'lock-only', 'fallback-only', 'dangling-modules'])
  ('routes installed or partial state to the active audit: %s', (state) => {
    const f = fixture(), modules = join(f.profile, 'node_modules')
    if (['package-map', 'physical-index', 'malformed-index', 'empty-modules'].includes(state)) mkdirSync(modules)
    if (state === 'package-map') writeFileSync(join(modules, '.package-map.json'), '{}')
    if (state === 'physical-index') writeFileSync(join(modules, '.modules.yaml'), JSON.stringify({ nodeLinker: 'hoisted', layoutVersion: 5, packageManager: 'pnpm@11.7.0' }))
    if (state === 'malformed-index') writeFileSync(join(modules, '.modules.yaml'), 'invalid')
    if (state === 'lock-only') writeFileSync(join(f.profile, 'pnpm-lock.yaml'), '{}')
    if (state === 'fallback-only') mkdirSync(join(f.profile, '.dsh-module-fallback'))
    if (state === 'dangling-modules') {
      const target = join(f.root, 'removed-target'); mkdirSync(target)
      symlinkSync(target, modules, 'junction'); rmSync(target, { recursive: true })
    }
    for (const command of ['inspect', 'inject', 'verify-dump', 'dump-desktop']) {
      expect(f.run(command)).toBe('test_active_audit_selected')
    }
    expect(f.run('inspect-graph')).toBe('target_profile_unmanaged_modules')
  })
})
