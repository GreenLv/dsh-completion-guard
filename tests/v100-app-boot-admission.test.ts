import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

// CG021-07: the version-admission VECTOR is judged by the OFFICIAL production
// consumer (`evaluatePluginCompatibility` from the pinned 0.2.1-rc.2
// dsh-app-boot in this repository's own dependency closure), not only by
// Guard's own floor helper. This is the same function the market/plugin
// carrier runs; the native market card remains a separate Codex acceptance.
function loadAppBoot(): { evaluatePluginCompatibility: (manifest: unknown, exemptions?: unknown, runtimeVersion?: string) => { requirements: Record<string, string>; exempted?: boolean } | undefined } {
  // Follow the actual locked producer -> shell-env -> app-boot dependency
  // route. pnpm may hash virtual-store directory names on Windows.
  const root = createRequire(import.meta.url)
  const producer = createRequire(root.resolve('@deepseek-ai/dsh-tool-bash'))
  const shellEnv = createRequire(producer.resolve('@deepseek-ai/dsh-shell-env'))
  const entry = shellEnv.resolve('@deepseek-ai/dsh-app-boot')
  const actual = JSON.parse(readFileSync(shellEnv.resolve('@deepseek-ai/dsh-app-boot/package.json'), 'utf8'))
  const audit = JSON.parse(readFileSync(new URL('../manifests/rc021-rc2-byte-audit.json', import.meta.url), 'utf8')) as {
    packages: Array<{ name: string; version: string; modules: Record<string, string> }>
  }
  const pinned = audit.packages.find(row => row.name === '@deepseek-ai/dsh-app-boot')
  if (!pinned || actual.name !== pinned.name || actual.version !== pinned.version
    || !readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8').includes(`'${pinned.name}@${pinned.version}':`)
    || createHash('sha256').update(readFileSync(entry)).digest('hex') !== pinned.modules['lib/index.js']) {
    throw new Error('fixture: resolved official app-boot identity differs from pinned lock/audit')
  }
  return shellEnv('@deepseek-ai/dsh-app-boot')
}

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
  engines: Record<string, string>
  dsh: { engines: Record<string, string> }
  peerDependencies: Record<string, string>
}

describe('CG021-07: official app-boot admission over the 0.2.1-rc.2 floor', () => {
  const { evaluatePluginCompatibility } = loadAppBoot()

  it('keeps the shipped dual-layer declaration consistent', () => {
    expect(manifest.engines.dsh).toBe('>=0.2.1-rc.2')
    expect(manifest.dsh.engines.dsh).toBe('>=0.2.1-rc.2')
    for (const [name, range] of Object.entries(manifest.peerDependencies)) {
      if (name === '@deepseek-ai/cordis') continue
      expect(range, name).toBe('>=0.2.1-rc.2')
    }
  })

  it('admits the floor, later RCs, stable and future versions through the REAL consumer', () => {
    for (const version of ['0.2.1-rc.2', '0.2.1-rc.3', '0.2.1', '0.2.2-rc.1', '0.2.2', '0.3.0', '1.0.0', '0.2.1-rc.2+build.7']) {
      expect(evaluatePluginCompatibility(manifest, {}, version), version).toBeUndefined()
    }
  })

  it('refuses 0.2.0-rc.2 and 0.2.1-rc.1 with the declared engines range', () => {
    for (const version of ['0.2.0-rc.2', '0.2.1-rc.1']) {
      const issue = evaluatePluginCompatibility(manifest, {}, version)
      expect(issue, version).toMatchObject({ requirements: { 'engines.dsh': '>=0.2.1-rc.2' }, exempted: false })
    }
  })

  it('fails closed on an unparseable runtime version instead of admitting it', () => {
    expect(() => evaluatePluginCompatibility(manifest, {}, 'nonsense-v')).toThrow()
    expect(() => evaluatePluginCompatibility(manifest, {}, '01.2.0')).toThrow()
  })

  it('without top-level engines the dsh peers decide; workspace peer ranges refer to the running runtime', () => {
    const { engines: _engines, ...peersOnly } = manifest
    expect(evaluatePluginCompatibility(peersOnly, {}, '0.2.1-rc.2')).toBeUndefined()
    const below = evaluatePluginCompatibility(peersOnly, {}, '0.2.1-rc.1')
    expect(below?.requirements).toMatchObject({ '@deepseek-ai/dsh-session': '>=0.2.1-rc.2' })
    // The peers-only surface accepts workspace ranges the way production
    // carriers emit them: they resolve against the CURRENT runtime — i.e. a
    // workspace peer always satisfies whatever runtime is running, which is
    // exactly why the shipped manifest declares explicit ranges instead.
    const workspacePeers = {
      ...peersOnly,
      peerDependencies: Object.fromEntries(Object.entries(peersOnly.peerDependencies)
        .map(([name, range]) => [name, name === '@deepseek-ai/cordis' ? range : 'workspace:^'])),
    }
    expect(evaluatePluginCompatibility(workspacePeers, {}, '0.2.1-rc.2')).toBeUndefined()
    expect(evaluatePluginCompatibility(workspacePeers, {}, '0.2.0-rc.2')).toBeUndefined()
  })

  it('a top-level engines.dsh decides ALONE: the nested dsh.engines field is not the consumer gate', () => {
    // This documents why both layers must carry the SAME range in the real
    // manifest: a consumer that only reads the top-level field must not be
    // silently stricter or looser than one reading the nested one.
    const strictNested = { ...manifest, dsh: { ...manifest.dsh, engines: { dsh: '>=9.9.9' } } }
    expect(evaluatePluginCompatibility(strictNested, {}, '0.2.1-rc.2')).toBeUndefined()
    const strictTop = { ...manifest, engines: { ...manifest.engines, dsh: '>=9.9.9' } }
    expect(evaluatePluginCompatibility(strictTop, {}, '0.2.1-rc.2')?.requirements['engines.dsh']).toBe('>=9.9.9')
  })

  it('a nested-only declaration still admits through the peers at the floor', () => {
    const nestedOnly = { ...manifest, engines: { node: manifest.engines.node } }
    delete (nestedOnly as Record<string, unknown>).engines
    ;(nestedOnly as Record<string, unknown>).dsh = manifest.dsh
    expect(evaluatePluginCompatibility(nestedOnly, {}, '0.2.1-rc.2')).toBeUndefined()
    expect(evaluatePluginCompatibility(nestedOnly, {}, '0.2.1-rc.1')).toBeDefined()
  })
})
