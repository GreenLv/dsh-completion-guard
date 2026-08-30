#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  injectActiveProfileHostLock,
  resolveActiveProfileHostLock,
  verifyComposedHostLockDump,
} from '../dist/domain/index.js'

function option(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${name}`)
  return process.argv[index + 1]
}

function summary(evaluation) {
  return {
    status: evaluation.status,
    host_lock_digest: evaluation.digest,
    goal_available: evaluation.goalAvailable,
    platform: evaluation.platform,
    profile: evaluation.profileKind,
    capabilities: Object.fromEntries(Object.entries(evaluation.capabilities)
      .map(([id, result]) => [id, result.status])),
    package_count: evaluation.packages.filter((row) => row.version && row.integrity).length,
  }
}

try {
  const command = process.argv[2]
  if (!['inspect', 'inject', 'verify-dump'].includes(command)) {
    throw new Error('usage: dsh-completion-guard-host-lock <inspect|inject|verify-dump> --runtime-root PATH --profile-root PATH [--dump-config FILE]')
  }
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const packageManifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  const active = resolveActiveProfileHostLock(
    option('--runtime-root'),
    option('--profile-root'),
    packageManifest.version,
  )
  if (command === 'inject') injectActiveProfileHostLock(active)
  if (command === 'verify-dump') {
    verifyComposedHostLockDump(readFileSync(option('--dump-config'), 'utf8'), active.evaluation)
  }
  process.stdout.write(`${JSON.stringify(summary(active.evaluation))}\n`)
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'host_lock_command_failed'
  process.stderr.write(`${JSON.stringify({ status: 'unavailable', reason_code: code })}\n`)
  process.exitCode = 1
}
