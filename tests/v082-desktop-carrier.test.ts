import { afterEach, describe, expect, it } from 'vitest'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyDesktopCarrier } from '../src/domain/host-desktop-identity.js'
import { readAsarIndex } from '../src/domain/host-desktop.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
describe('Desktop vendor carrier authentication', () => {
  it('refuses an unsigned counterfeit even when its archive has a declared header identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-unsigned-desktop-'))
    roots.push(root)
    const installation = process.platform === 'darwin' ? join(root, 'Counterfeit.app', 'Contents') : root
    const resources = join(installation, process.platform === 'darwin' ? 'Resources' : 'resources')
    mkdirSync(resources, { recursive: true })
    const archive = join(resources, 'app.asar')
    writeFileSync(archive, 'counterfeit')
    writeFileSync(join(installation, 'DeepSeek Harness.exe'), 'unsigned executable')
    expect(() => verifyDesktopCarrier(archive, 'a'.repeat(64))).toThrow()
  })

  it('refuses a copied standalone archive outside its signed carrier', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-detached-desktop-'))
    roots.push(root)
    const archive = join(root, 'app.asar')
    writeFileSync(archive, 'detached')
    expect(() => verifyDesktopCarrier(archive, 'a'.repeat(64))).toThrow()
  })

  it.skipIf(!process.env.DSH_DESKTOP_ASAR)('authenticates the supplied real installed carrier and its exact header', () => {
    const archive = process.env.DSH_DESKTOP_ASAR!
    expect(verifyDesktopCarrier(archive, readAsarIndex(archive).headerSha256)).toMatch(/DeepSeek Harness(?:\.exe)?$/)
    expect(() => verifyDesktopCarrier(archive, 'a'.repeat(64))).toThrow(/header/)
  })

  it.skipIf(!process.env.DSH_DESKTOP_ASAR)('round-trips the production CLI through the real boot-free Desktop composition API', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-composition-'))
    roots.push(root)
    const profile = join(root, 'profiles', 'desktop'), installed = join(profile, 'node_modules', 'dsh-completion-guard')
    mkdirSync(installed, { recursive: true })
    for (const file of ['package.json', 'cordis.patch.yml', 'dist']) cpSync(join(process.cwd(), file), join(installed, file), { recursive: true })
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop', private: true,
      dependencies: { 'dsh-completion-guard': JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-completion-guard'] } } }))
    writeFileSync(join(profile, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\npackages: {}\nsnapshots: {}\n")
    writeFileSync(join(profile, 'node_modules', '.package-map.json'), JSON.stringify({ packages: {
      '.': { url: '..', dependencies: { 'dsh-completion-guard': 'guard' } },
      guard: { url: './dsh-completion-guard', dependencies: {} } } }))
    const cli = join(process.cwd(), 'bin', 'dsh-completion-guard-host-lock.mjs')
    const args = ['--profile', 'desktop', '--runtime-root', process.env.DSH_DESKTOP_ASAR!, '--profile-root', profile]
    const run = (command: string, extra: string[] = []) => execFileSync(process.execPath, [cli, command, ...args, ...extra], {
      encoding: 'utf8', timeout: 45_000, maxBuffer: 16 * 1024 * 1024,
    })
    const injected = JSON.parse(run('inject'))
    const dump = run('dump-desktop'), dumpFile = join(root, 'composed.yml')
    writeFileSync(dumpFile, dump)
    expect(dump).toContain('hostLockDesktopDigest:')
    const verified = JSON.parse(run('verify-dump', ['--dump-config', dumpFile]))
    expect(verified).toMatchObject({ status: 'supported', profile: 'desktop', host_lock_digest: injected.host_lock_digest })
    // This fixture exercises source composition against the real archive.
    // It is not an installed-tgz or loaded application acceptance result.
  }, 90_000)
})
