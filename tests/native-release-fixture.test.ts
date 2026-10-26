import { expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error The repository-owned native fixture is an unbundled Node entrypoint.
const { runNativeReleaseFixture } = await import('../scripts/native_release_fixture_v070.mjs')

it('runs the actual release fixture with exact-version registry responses, in-flight refusal, reconciliation and no republish', async () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-native-release-owning-'))
  const repository = fileURLToPath(new URL('../', import.meta.url))
  vi.stubEnv('DSH_HOME', join(root, 'dsh-home'))
  try {
    const runtimeRoot = join(root, 'runtime'), profileRoot = join(root, 'profile')
    // This is only a module-resolution anchor, not a synthetic native-host
    // qualification. The Session/LLM implementations are the real pinned SDK;
    // product.apply loads the committed dist through its ordinary package path.
    const anchor = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    mkdirSync(dirname(anchor), { recursive: true })
    writeFileSync(anchor, JSON.stringify({ name: '@deepseek-ai/dsh', private: true }))
    const link = (target: string, path: string) => symlinkSync(realpathSync(target), path, process.platform === 'win32' ? 'junction' : 'dir')
    for (const name of ['dsh-session', 'dsh-llm']) link(join(repository, 'node_modules', '@deepseek-ai', name), join(runtimeRoot, 'node_modules', '@deepseek-ai', name))
    mkdirSync(join(profileRoot, 'node_modules'), { recursive: true })
    link(repository, join(profileRoot, 'node_modules', 'dsh-completion-guard'))
    const manifest = JSON.parse(readFileSync(join(repository, 'manifests', 'supported-host.v1.json'), 'utf8'))
    const hostPackages = manifest.cohorts.find((row: { id: string }) => row.id === 'dsh-0.2.1-rc.3-core-v1').packages
    const result = await runNativeReleaseFixture({ runtimeRoot, profileRoot, workRoot: join(root, 'work'), nonce: 'owning-release', profile: 'web', hostPackages })
    expect(result).toEqual({ positive: true, negative: true, mock_only: true })
  } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) }
})
