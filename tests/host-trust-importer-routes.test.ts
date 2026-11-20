import { expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeDependencyResolver } from '../src/domain/host-resolver.js'

const importer = '@deepseek-ai/dsh-agent'
const dependency = 'fixture-dependency'
const importerIntegrity = 'sha512-' + 'A'.repeat(86) + '=='
const firstIntegrity = 'sha512-' + 'B'.repeat(86) + '=='
const secondIntegrity = 'sha512-' + 'C'.repeat(86) + '=='

function graph(root: string, version: string, integrity: string) {
  const modules = join(root, 'node_modules')
  for (const [name, packageVersion] of [[importer, '1.0.0'], [dependency, version]]) {
    const directory = join(modules, name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version: packageVersion }))
  }
  writeFileSync(join(modules, '.package-map.json'), JSON.stringify({ packages: {
    '.': { url: '..', dependencies: { [importer]: importer, [dependency]: dependency } },
    [importer]: { url: `./${importer}`, dependencies: { [dependency]: dependency } },
    [dependency]: { url: `./${dependency}`, dependencies: {} },
  } }))
  writeFileSync(join(root, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\npackages:\n  '${importer}@1.0.0':\n    resolution: {integrity: ${importerIntegrity}}\n  '${dependency}@${version}':\n    resolution: {integrity: ${integrity}}\nsnapshots:\n`)
}

it('checks every reachable importer in runtime and profile and refuses a shadowed dependency', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-importer-routes-'))
  try {
    const runtime = join(root, 'runtime'), profile = join(root, 'profile')
    graph(runtime, '1.0.0', firstIntegrity)
    graph(profile, '1.0.0', firstIntegrity)
    const identity = { name: importer, version: '1.0.0', integrity: importerIntegrity }
    expect(probeDependencyResolver(runtime, profile)(dependency, importer, new AbortController().signal, identity))
      .toMatchObject({ name: dependency, version: '1.0.0', integrity: firstIntegrity })

    graph(profile, '2.0.0', secondIntegrity)
    expect(() => probeDependencyResolver(runtime, profile)(dependency, importer, new AbortController().signal, identity))
      .toThrow('importer routes resolve to conflicting identities')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
