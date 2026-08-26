import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.js'
import { resolveConfig } from '../src/config.js'

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
  })
})
