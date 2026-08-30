import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  ACTION_MANIFEST,
  SEMANTIC_ACTIONS,
  STATEFUL_ACTIONS,
  SUPPORTED_EVIDENCE_ADAPTERS,
  semanticActionFromCommand,
  semanticActionFromText,
  validateActionManifest,
} from '../../src/domain/protocol-manifest.js'
import {
  EXPECTED_HOST_PACKAGES,
  HOST_CAPABILITY_PACKAGE_GROUPS,
  SUPPORTED_HOST_MANIFEST,
  evaluateExternalWaitCapability,
  evaluateHostLock,
} from '../../src/domain/host-lock.js'
import { packageRowsFromPnpmLock, resolveInstalledHostLock } from '../../src/domain/host-resolver.js'

describe('v0.3 versioned manifests', () => {
  it('reads exact critical package identities from the installed pnpm lock', () => {
    const rows = packageRowsFromPnpmLock(readFileSync('pnpm-lock.yaml', 'utf8'))
    expect(rows.map((row) => row.name)).toEqual([
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-commands',
      '@deepseek-ai/dsh-goal',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-tool-goal',
      '@deepseek-ai/dsh-jobs',
      '@deepseek-ai/dsh-jobs-local',
      '@deepseek-ai/dsh-tool-fs',
      '@deepseek-ai/dsh-fs',
      '@deepseek-ai/dsh-fs-local',
      '@deepseek-ai/dsh-fs-sandbox',
      '@deepseek-ai/dsh-fs-observation-policy',
      '@deepseek-ai/dsh-sandbox',
      '@deepseek-ai/dsh-sandbox-policy',
      '@deepseek-ai/dsh-user-approval',
      '@deepseek-ai/dsh-attachment',
      '@deepseek-ai/dsh-system-prompt',
    ])
    expect(rows.every((row) => row.version && row.integrity?.startsWith('sha512-'))).toBe(true)
    const installed = resolveInstalledHostLock(new URL('../../src/domain/host-resolver.ts', import.meta.url).href)
    expect(installed.status).toBe('supported')
    expect(evaluateExternalWaitCapability(installed)).toMatchObject({
      status: 'unavailable', missingPackages: ['@deepseek-ai/dsh-tool-jobs'],
    })
  })

  it('keeps the shipped machine-readable manifests aligned with runtime constants', () => {
    const actions = JSON.parse(readFileSync('manifests/action-manifest.v1.json', 'utf8'))
    const host = JSON.parse(readFileSync('manifests/supported-host.v1.json', 'utf8'))
    expect(actions.version).toBe(ACTION_MANIFEST.version)
    expect(actions.semanticActions).toEqual(SEMANTIC_ACTIONS)
    expect(actions.statefulActions).toEqual(STATEFUL_ACTIONS)
    expect(actions.evidenceAdapters).toEqual(SUPPORTED_EVIDENCE_ADAPTERS)
    expect(actions.actions).toEqual(ACTION_MANIFEST.actions)
    expect(actions.compatibility).toEqual(ACTION_MANIFEST.compatibility)
    expect(host.manifestVersion).toBe(SUPPORTED_HOST_MANIFEST.manifestVersion)
    expect(host.supportedGoalVersions).toEqual(SUPPORTED_HOST_MANIFEST.supportedGoalVersions)
    expect(host.packages).toEqual(EXPECTED_HOST_PACKAGES)
    expect(host.capabilities.external_wait_jobs_readback).toBe('dsh.jobs.v1')
    expect(host.capabilities.filesystem_tool_contract).toBe('dsh.fs-tools.v1')
    expect(host.capabilities.packageGroups.jobs).toEqual([...HOST_CAPABILITY_PACKAGE_GROUPS.jobs])
    expect(host.capabilities.packageGroups.filesystem).toEqual([...HOST_CAPABILITY_PACKAGE_GROUPS.filesystem])
    expect(SUPPORTED_HOST_MANIFEST.capabilities).toContainEqual({
      name: 'external_wait_jobs_readback', value: { k: 's', v: 'dsh.jobs.v1' },
    })
    expect(SUPPORTED_HOST_MANIFEST.capabilities).toContainEqual({
      name: 'filesystem_tool_contract', value: { k: 's', v: 'dsh.fs-tools.v1' },
    })
  })

  it('freezes the full semantic and stateful action sets', () => {
    expect(SEMANTIC_ACTIONS).toEqual([
      'inspect_remote_updates', 'install', 'apply', 'create', 'modify',
      'test', 'verify', 'pull', 'fetch', 'commit', 'push', 'restart',
      'publish', 'generic_run',
    ])
    expect(STATEFUL_ACTIONS).toEqual([
      'install', 'apply', 'create', 'modify', 'restart',
      'commit', 'push', 'publish', 'pull', 'fetch',
    ])
    expect(validateActionManifest()).toEqual([])
    for (const action of STATEFUL_ACTIONS) {
      expect(ACTION_MANIFEST.actions[action].stateful).toBe(true)
      expect(ACTION_MANIFEST.actions[action].resolvedTargetKeys.length).toBeGreaterThan(0)
      expect(ACTION_MANIFEST.actions[action].observedStateKeys.length).toBeGreaterThan(0)
    }
    expect(ACTION_MANIFEST.actions.install.commandManifestIds).toEqual(['dsh.plugin_add_tgz.install.v1'])
    expect(ACTION_MANIFEST.actions.apply.commandManifestIds).toEqual(['dsh.plugin_add_tgz.apply.v1'])
    expect(ACTION_MANIFEST.actions.restart.commandManifestIds).toEqual(['dshmarket.restart.v1'])
    expect(ACTION_MANIFEST.actions.publish.commandManifestIds).toEqual(['npm.publish_tgz.v1'])
  })

  it('classifies exact commands without treating generic run as a wildcard', () => {
    expect(semanticActionFromCommand('python -m unittest scripts/test_report.py')).toBe('test')
    expect(semanticActionFromCommand('git pull --ff-only origin main')).toBe('pull')
    expect(semanticActionFromCommand('git fetch origin main')).toBe('fetch')
    expect(semanticActionFromCommand('git commit -m release')).toBe('commit')
    expect(semanticActionFromCommand('git push origin main')).toBe('push')
    expect(semanticActionFromCommand('dsh plugin --profile web add skin@1.2.3')).toBe('install')
    expect(semanticActionFromCommand('node scripts/report.js')).toBe('generic_run')
  })

  it('keeps unittest evidence separate from install/pull/commit/push clauses', () => {
    expect(semanticActionFromText('运行 python -m unittest 验证测试')).toBe('test')
    expect(semanticActionFromText('安装插件')).toBe('install')
    expect(semanticActionFromText('拉取 origin/main')).toBe('pull')
    expect(semanticActionFromText('提交变更')).toBe('commit')
    expect(semanticActionFromText('推送到远端')).toBe('push')
  })

  it('accepts only the audited exact resolved host lock and permits Goal absence', () => {
    const withGoal = evaluateHostLock(EXPECTED_HOST_PACKAGES)
    expect(withGoal.status).toBe('supported')
    expect(withGoal.goalAvailable).toBe(true)
    const withoutGoal = evaluateHostLock(EXPECTED_HOST_PACKAGES.filter((row) => !['@deepseek-ai/dsh-goal', '@deepseek-ai/dsh-tool-goal'].includes(row.name)))
    expect(withoutGoal.status).toBe('supported')
    expect(withoutGoal.goalAvailable).toBe(false)
    expect(withoutGoal.digest).not.toBe(withGoal.digest)
    expect(SUPPORTED_HOST_MANIFEST.supportedGoalVersions).toEqual(['0.1.1-rc.2'])
  })

  it('fails closed for unknown versions, missing critical packages, and integrity drift', () => {
    const unknownVersion = EXPECTED_HOST_PACKAGES.map((row) => row.name === '@deepseek-ai/dsh-agent'
      ? { ...row, version: '0.1.1-rc.3' }
      : row)
    expect(evaluateHostLock(unknownVersion).status).toBe('unsupported')
    expect(evaluateHostLock(EXPECTED_HOST_PACKAGES.filter((row) => row.name !== '@deepseek-ai/dsh-session')).status).toBe('unavailable')
    const drifted = EXPECTED_HOST_PACKAGES.map((row) => row.name === '@deepseek-ai/cordis'
      ? { ...row, integrity: 'sha512-drift' }
      : row)
    expect(evaluateHostLock(drifted).status).toBe('unsupported')
  })
})
