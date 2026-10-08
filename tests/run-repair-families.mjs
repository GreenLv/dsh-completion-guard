#!/usr/bin/env node
// Repository-only diagnostic bundles. Not a full candidate or native gate.
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const families = Object.freeze({
  'session-activation': [
    'tests/activation-bindings.test.ts', 'tests/activation-runtime.test.ts',
    'tests/activation-publication.test.ts', 'tests/activation-concurrent.test.ts',
    'tests/activation-canonical-parity.test.ts',
    'tests/loader.test.ts', 'tests/runtime.test.ts', 'tests/lifecycle.test.ts',
  ],
  'desktop-importer': [
    'tests/v082-desktop-locations.test.ts',
    'tests/v082-desktop-cli.test.ts',
    'tests/v082-desktop-profile.test.ts',
    'tests/v082-desktop-carrier.test.ts',
    'tests/domain/host-node-conditions.test.ts',
  ],
  'rc017-adaptation': [
    'tests/v080-rc017-host.test.ts',
    'tests/domain/host-dependency-audit.test.ts',
    'tests/domain/v030-host-lock.test.ts',
    'tests/v080-rc017-lifecycle.test.ts',
    'tests/v080-rc017-session.test.ts',
    'tests/v080-rc017-shell.test.ts',
    'tests/domain/v051-host-loop.test.ts',
    'tests/domain/v051-goal-lifecycle-composed.test.ts',
    'tests/host-workdir-v070.test.ts',
    'tests/v6-recovery-feedback.test.ts',
  ],
  'host-contract-qualification': [
    'tests/v081-hoisted-host.test.ts',
    'tests/domain/host-contract-probe.test.ts',
    'tests/domain/host-node-conditions.test.ts',
    'tests/domain/host-target-preflight.test.ts',
    'tests/domain/host-dependency-audit.review-72d32e7.local.test.ts',
    'tests/domain/host-dependency-audit.warm-review.test.ts',
    'tests/v081-production-entry-drift.test.ts',
    'tests/v081-host-version-floor.test.ts',
  ],
  qualification: [
    'tests/domain/v063-narrowed-contract.test.ts',
    'tests/domain/v063-holdout-round34.test.ts',
    'tests/domain/v063-holdout-round35.test.ts',
    'tests/tools/v063-host-materialization.test.ts',
  ],
  'target-identity': [
    'tests/domain/v063-target-family.test.ts',
    'tests/domain/v063-narrowed-contract.test.ts',
    'tests/domain/v063-core-alignment.test.ts',
    'tests/tools/v063-host-materialization.test.ts',
  ],
  'checkpoint-input': [
    'tests/v083-predicate-input-boundary.test.ts',
    'tests/v083-checkpoint-binding-feedback.test.ts',
    'tests/tools/checkpoint.test.ts',
    'tests/tools/native-checkpoint-details.test.ts',
    'tests/domain/digest-v3.test.ts',
    'tests/domain/portable-semantics.test.ts',
  ],
  upgrade: [
    'tests/domain/v063-upgrade-chain.test.ts',
    'tests/domain/v063-legacy-upgrade.test.ts',
    'tests/domain/v063-cross-end-projection.test.ts',
    'tests/tools/v063-host-lifecycle.test.ts',
    'tests/v6-recovery-feedback.test.ts',
  ],
})

export function selectFiles(names) {
  if (!names.length) throw new Error('Choose one or more families, or all; use --list for coverage.')
  for (const name of names) {
    if (name !== 'all' && !Object.hasOwn(families, name)) throw new Error(`Unknown family: ${name}`)
  }
  const selected = names.includes('all') ? Object.keys(families) : names
  return [...new Set(selected.flatMap(name => families[name]))].sort()
}

export function run(names, { repoRoot = root, spawn = spawnSync } = {}) {
  const files = selectFiles(names)
  const runner = resolve(repoRoot, 'node_modules/vitest/vitest.mjs')
  for (const file of [...files, 'node_modules/vitest/vitest.mjs']) {
    if (!existsSync(resolve(repoRoot, file))) throw new Error(`Missing required input: ${file}`)
  }
  // No shell or pnpm shim: the same invocation works on Windows and macOS.
  // Vitest reports file, case, assertion and stack; preserve its actual exit status.
  process.stdout.write(`Repair families: ${names.join(', ')}\n${files.join('\n')}\n`)
  const result = spawn(process.execPath, [runner, 'run', ...files], { cwd: repoRoot, stdio: 'inherit', shell: false })
  if (result.error) throw result.error
  if (result.signal || !Number.isInteger(result.status)) throw new Error(`Runner interrupted: ${result.signal ?? 'no status'}`)
  return result.status
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const names = process.argv.slice(2)
    if (names.length === 1 && names[0] === '--list') {
      process.stdout.write(`${JSON.stringify(families, null, 2)}\nSee tests/repair-families.md for coverage limits.\n`)
    } else {
      process.exitCode = run(names)
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 2
  }
}
