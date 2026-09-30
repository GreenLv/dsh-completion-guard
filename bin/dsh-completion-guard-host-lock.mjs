#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  injectActiveProfileHostLock,
  prepareActiveHostTrust,
  prepareTargetHostTrust,
  prepareDesktopHostTrust,
  inspectTargetHostGraph,
  inspectDesktopTargetGraph,
  evaluateConfiguredHostLock,
  resolveActiveProfileHostLock,
  verifyComposedHostLockDump,
} from '../dist/domain/index.js'

function option(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${name}`)
  return process.argv[index + 1]
}

function hasFlag(name) {
  return process.argv.includes(name)
}

// Explicit profile selection. `--profile desktop` requires the runtime root
// to be the official app archive (app.asar); the CLI runtime profiles keep
// their explicit managed roots. Omitting the flag keeps the documented
// bundle/name inference — desktop identity never comes from a bundle guess.
function selectedProfile() {
  if (!hasFlag('--profile')) return undefined
  const value = option('--profile')
  if (!['web', 'headless', 'desktop'].includes(value)) {
    throw new Error('profile must be "web", "headless", or "desktop"')
  }
  return value
}

function summary(evaluation) {
  return {
    status: evaluation.status,
    cohort_id: evaluation.cohortId,
    host_lock_digest: evaluation.digest,
    goal_available: evaluation.goalAvailable,
    ...(evaluation.goalQualificationFailure ? { goal_qualification_reason: evaluation.goalQualificationFailure } : {}),
    platform: evaluation.platform,
    profile: evaluation.profileKind,
    // How the cohort's rows were established. Without this in the READBACK, an
    // operator (or a native-acceptance annex built from it) sees "supported"
    // and a digest but cannot tell a natively audited graph from one that was
    // only resolved from the registry. The value is already bound into the
    // digest; this surfaces it so it cannot be read as a native pass.
    audit_provenance: evaluation.auditProvenance,
    // The version policy is a separate fact from the graph audit, so it is
    // read back separately: an operator must be able to tell "this host is too
    // old" from "this graph was never audited", and neither may be reported as
    // the other.
    host_version: evaluation.hostVersion ? {
      version: evaluation.hostVersion.version,
      minimum: evaluation.hostVersion.minimum,
      status: evaluation.hostVersion.status,
      reason_code: evaluation.hostVersion.reasonCode,
    } : { status: 'unrecorded', reason_code: 'host_version_not_recorded' },
    capabilities: Object.fromEntries(Object.entries(evaluation.capabilities)
      .map(([id, result]) => [id, result.status])),
    package_count: evaluation.packages.filter((row) => row.version && row.integrity).length,
  }
}

try {
  const command = process.argv[2]
  if (!['inspect', 'inspect-graph', 'inject', 'verify-dump', 'dump-desktop'].includes(command)) {
    throw new Error('usage: dsh-completion-guard-host-lock <inspect|inject|verify-dump|dump-desktop> --runtime-root PATH --profile-root PATH [--profile web|headless|desktop] [--dump-config FILE]')
  }
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const packageManifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  const profile = selectedProfile()
  if (profile === 'desktop' && (command === 'inspect-graph'
    || (command === 'inspect' && !existsSync(join(option('--profile-root'), 'node_modules', '.package-map.json'))))) {
    const runtimeRoot = option('--runtime-root')
    const profileRoot = option('--profile-root')
    const trust = hasFlag('--rebind-registry') ? await prepareDesktopHostTrust(runtimeRoot, profileRoot) : undefined
    const target = inspectDesktopTargetGraph(runtimeRoot, profileRoot, trust)
    const evaluation = evaluateConfiguredHostLock(target.packages, {
      platform: process.platform === 'win32' ? 'windows' : 'posix',
      profileKind: 'desktop',
    }, trust ? JSON.stringify(trust) : undefined, profileRoot)
    process.stdout.write(`${JSON.stringify({
      ...summary(evaluation),
      inspection_scope: 'pre_install_target',
      profile_graph: target.profileGraph,
      desktop_runtime: {
        asar_realpath: target.runtime.asarRealpath,
        manifest_sha256: target.runtime.manifestSha256,
        header_sha256: target.runtime.headerSha256,
        metadata_sha256: target.runtime.metadataSha256,
        host_version: target.runtime.hostVersion,
        desktop_version: target.runtime.metadata.desktopVersion,
        payload_file_count: target.runtime.metadata.fileTableEntries,
      },
      packages: target.packages,
    })}\n`)
    process.exit(evaluation.status === 'supported' ? 0 : 1)
  }
  if (command === 'inspect-graph') {
    const trust = hasFlag('--rebind-registry')
      ? await prepareTargetHostTrust(option('--runtime-root'), option('--profile-root')) : undefined
    const target = inspectTargetHostGraph(option('--runtime-root'), option('--profile-root'), trust)
    const rows = target.packages
    const evaluation = evaluateConfiguredHostLock(rows, {
      platform: process.platform === 'win32' ? 'windows' : 'posix',
      ...(target.profileGraph.state === 'dependency_free_headless' ? { profileKind: 'headless' } : {}),
    }, trust ? JSON.stringify(trust) : undefined, option('--profile-root'))
    process.stdout.write(`${JSON.stringify({ ...summary(evaluation), inspection_scope: 'pre_install_target', profile_graph: target.profileGraph, packages: rows })}\n`)
    process.exit(evaluation.status === 'supported' ? 0 : 1)
  }
  // Explicit registry rebind. Existing baseline inspection stays offline.
  const trust = hasFlag('--rebind-registry')
    ? await (profile === 'desktop' ? prepareDesktopHostTrust : prepareActiveHostTrust)(option('--runtime-root'), option('--profile-root')) : undefined
  const active = resolveActiveProfileHostLock(
    option('--runtime-root'),
    option('--profile-root'),
    packageManifest.version,
    trust,
  )
  if (profile !== undefined && active.profileKind !== profile) {
    throw new Error(`profile mismatch: requested ${profile}, resolved ${active.profileKind}`)
  }
  if (command === 'dump-desktop') {
    if (active.profileKind !== 'desktop' || active.evaluation.status !== 'supported') {
      throw new Error('dump-desktop requires a supported installed Desktop profile')
    }
    const archive = active.runtimeRoot, profileRoot = active.profileRoot
    const executable = process.platform === 'darwin'
      ? join(dirname(dirname(archive)), 'MacOS', 'DeepSeek Harness')
      : join(dirname(dirname(archive)), 'DeepSeek Harness.exe')
    const script = `
      import { createRequire } from 'node:module';
      import { join } from 'node:path';
      import { existsSync } from 'node:fs';
      import { pathToFileURL } from 'node:url';
      const [archive, profileRoot] = process.argv.slice(1);
      const require = createRequire(join(archive, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
      const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);
      const { prepareProfile, PROFILE_ROOT_FILENAME, homePatchPath } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh/profile-boot')).href);
      const loaded = prepareProfile('desktop');
      if (loaded.dir !== profileRoot) throw Error('Desktop dump profile identity differs');
      const layers = loaded.layers.map(layer => ({label: layer.packageName, patches: layer.patches}));
      if (existsSync(loaded.patchPath)) layers.push({label: loaded.patchPath, patches: loaded.patches});
      const home = homePatchPath(), patches = boot.loadOptionalPatches('dsh', home);
      if (patches !== undefined) layers.push({label: home, patches});
      process.stdout.write(boot.renderConfigDump('dsh', join(profileRoot, PROFILE_ROOT_FILENAME), layers));
    `
    const output = execFileSync(executable, ['--expose-internals', '--input-type=module', '-e', script, archive, profileRoot], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: dirname(dirname(profileRoot)) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    process.stdout.write(output)
    process.exit(0)
  }
  if (command === 'inject') injectActiveProfileHostLock(active)
  if (command === 'verify-dump') {
    verifyComposedHostLockDump(readFileSync(option('--dump-config') === '-' ? 0 : option('--dump-config'), 'utf8'), active.evaluation, active)
  }
  process.stdout.write(`${JSON.stringify(summary(active.evaluation))}\n`)
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'host_lock_command_failed'
  process.stderr.write(`${JSON.stringify({ status: 'unavailable', reason_code: code })}\n`)
  process.exitCode = 1
}
