// Task-owned subprocess: the parent provides an isolated fixture and owns cleanup.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runNativeReleaseFixture } from '../scripts/native_release_fixture_v070.mjs'

const [root, repository] = process.argv.slice(2)
const started = performance.now()
const phase = name => process.stdout.write(`${name} ${Math.round(performance.now() - started)}ms\n`)
phase('worker_start')
try {
  const audit = JSON.parse(readFileSync(join(repository, 'manifests', 'rc022-rc3-byte-audit.json'), 'utf8'))
  const hostPackages = audit.packages.map(({ name, version, integrity }) => ({ name, version, integrity }))
  const result = await runNativeReleaseFixture({ runtimeRoot: join(root, 'runtime'), profileRoot: join(root, 'profile'),
    workRoot: join(root, 'work'), nonce: 'owning-release', profile: 'web', hostPackages, onPhase: phase })
  phase('execute_complete')
  process.stdout.write(`${JSON.stringify(result)}\n`)
} catch (error) {
  process.stderr.write(`fixture_worker_failed ${error?.stack ?? error}\n`)
  process.exitCode = 1
}
