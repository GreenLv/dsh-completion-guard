import { describe, expect, it } from 'vitest'
import { canonicalRegistryBase, npmEscapedPackageName } from '../../src/domain/registry.js'

describe('v0.3 canonical registry identity', () => {
  it('normalizes one safe HTTPS base and the npm scoped packument route', () => {
    expect(canonicalRegistryBase('https://REGISTRY.EXAMPLE:443/npm')).toBe('https://registry.example/npm/')
    expect(canonicalRegistryBase('https://registry.example/npm/')).toBe('https://registry.example/npm/')
    expect(new URL(npmEscapedPackageName('@scope/pkg'), 'https://registry.example/npm/').toString())
      .toBe('https://registry.example/npm/@scope%2fpkg')
  })

  it.each([
    'http://registry.example/',
    'https://user:password@registry.example/',
    'https://registry.example/?token=x',
    'https://registry.example/#fragment',
    'https://registry.example/npm//private',
    'https://registry.example/npm/../private',
    'https://registry.example/npm/%2e%2e/private',
    'https://registry.example/npm/%2fprivate',
    'https://registry.example\\evil/',
    'https://registry.example./',
    'https://registry.example/\r\nX-Evil: yes',
  ])('rejects ambiguous or unsafe registry %s', (value) => {
    expect(canonicalRegistryBase(value)).toBeUndefined()
  })

  it('allows HTTP only for an explicit literal-loopback test seam', () => {
    expect(canonicalRegistryBase('http://127.0.0.1:4873/', { allowLoopbackHttp: true }))
      .toBe('http://127.0.0.1:4873/')
    expect(canonicalRegistryBase('http://localhost:4873/', { allowLoopbackHttp: true })).toBeUndefined()
    expect(canonicalRegistryBase('http://127.0.0.1:4873/')).toBeUndefined()
  })
})
