import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.js'
import { resolveConfig } from '../src/config.js'
import { EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'

describe('loader contract', () => {
  it('exposes a named apply function and no default export', async () => {
    expect(typeof plugin.apply).toBe('function')
    expect(plugin.name).toBe('context-guard')
    expect('default' in plugin).toBe(false)
  })

  it('declares the sessions service dependency', () => {
    expect(plugin.inject).toContain('sessions')
    expect(plugin.inject).toContain('commands')
  })

  it('resolves activation config with opt-in default', () => {
    expect(resolveConfig({}).activation).toBe('opt-in')
    expect(resolveConfig({ activation: 'always' }).activation).toBe('always')
    expect(() => resolveConfig({ activation: 'bogus' })).toThrow(/opt-in/)
    expect(resolveConfig({
      hostLockPackages: EXPECTED_HOST_PACKAGES,
      hostLockPlatform: 'posix',
      hostLockProfile: 'web',
    })).toMatchObject({
      hostLockPackages: expect.any(Array),
      hostLockPlatform: 'posix',
      hostLockProfile: 'web',
    })
    expect(resolveConfig({
      hostLockPackages: EXPECTED_HOST_PACKAGES,
      hostLockPlatform: 'posix',
      hostLockProfile: 'web',
    }).hostLockPackages).toHaveLength(EXPECTED_HOST_PACKAGES.length)
    expect(() => resolveConfig({ hostLockPackages: EXPECTED_HOST_PACKAGES })).toThrow(/injected together/)
    expect(() => resolveConfig({ hostLockPlatform: 'darwin' })).toThrow(/posix/)
    expect(() => resolveConfig({ hostLockPackages: 'nearest-lock' })).toThrow(/array/)
  })
})
