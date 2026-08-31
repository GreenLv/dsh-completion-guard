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
  HOST_COHORTS,
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
    // CG-DSH-001: the dev lockfile is not the complete audited host graph, so
    // as a host lock it fails closed and names the missing audited rows.
    const installed = resolveInstalledHostLock(new URL('../../src/domain/host-resolver.ts', import.meta.url).href)
    expect(installed.status).toBe('unavailable')
    expect(installed.reasonCode).toBe('host_lock_missing')
    expect(installed.missingPackages).toContain('@deepseek-ai/dsh-tool-jobs')
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
    expect(host.packageGroups.jobs).toEqual([...HOST_CAPABILITY_PACKAGE_GROUPS.jobs])
    expect(host.packageGroups.filesystem).toEqual([...HOST_CAPABILITY_PACKAGE_GROUPS.filesystem])
    expect(host.cohorts).toHaveLength(HOST_COHORTS.length)
    for (const [index, cohort] of HOST_COHORTS.entries()) {
      const entry = host.cohorts[index]
      expect(entry.id).toBe(cohort.id)
      expect(entry.manifestVersion).toBe(cohort.manifestVersion)
      expect(entry.supportedGoalVersions).toEqual(cohort.supportedGoalVersions)
      expect(entry.auditedPlatforms).toEqual([...cohort.auditedPlatforms])
      expect(entry.packages).toEqual(cohort.packages)
    }
    expect(HOST_COHORTS[0].capabilities).toContainEqual({
      name: 'host_cohort', value: { k: 's', v: 'dsh-0.1.1-rc.2' },
    })
    expect(HOST_COHORTS[1].capabilities).toContainEqual({
      name: 'host_cohort', value: { k: 's', v: 'dsh-0.1.2-alpha.2' },
    })
    expect(HOST_COHORTS[0].capabilities).toContainEqual({
      name: 'external_wait_jobs_readback', value: { k: 's', v: 'dsh.jobs.v1' },
    })
    expect(HOST_COHORTS[0].capabilities).toContainEqual({
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

  it('accepts only the audited exact resolved host lock and fails closed on missing rows', () => {
    const withGoal = evaluateHostLock(EXPECTED_HOST_PACKAGES)
    expect(withGoal.status).toBe('supported')
    expect(withGoal.goalAvailable).toBe(true)
    expect(withGoal.cohortId).toBe('dsh-0.1.1-rc.2')
    // CG-DSH-001: the audited cohort is one indivisible whole-graph contract;
    // a graph missing audited rows (Goal rows included) fails closed.
    const withoutGoal = evaluateHostLock(EXPECTED_HOST_PACKAGES.filter((row) => !['@deepseek-ai/dsh-goal', '@deepseek-ai/dsh-tool-goal'].includes(row.name)))
    expect(withoutGoal.status).toBe('unavailable')
    expect(withoutGoal.reasonCode).toBe('host_lock_missing')
    expect(withoutGoal.missingPackages).toEqual(['@deepseek-ai/dsh-goal', '@deepseek-ai/dsh-tool-goal'])
    expect(withoutGoal.digest).not.toBe(withGoal.digest)
    expect(HOST_COHORTS[0].supportedGoalVersions).toEqual(['0.1.1-rc.2'])
  })

  it('fails closed for unknown versions, missing critical packages, and integrity drift', () => {
    const unknownVersion = EXPECTED_HOST_PACKAGES.map((row) => row.name === '@deepseek-ai/dsh-agent'
      ? { ...row, version: '0.1.1-rc.3' }
      : row)
    expect(evaluateHostLock(unknownVersion).status).toBe('unsupported')
    const missingSession = evaluateHostLock(EXPECTED_HOST_PACKAGES.filter((row) => row.name !== '@deepseek-ai/dsh-session'))
    expect(missingSession.status).toBe('unavailable')
    expect(missingSession.reasonCode).toBe('host_lock_missing')
    expect(missingSession.missingPackages).toEqual(['@deepseek-ai/dsh-session'])
    const drifted = EXPECTED_HOST_PACKAGES.map((row) => row.name === '@deepseek-ai/cordis'
      ? { ...row, integrity: 'sha512-drift' }
      : row)
    expect(evaluateHostLock(drifted).status).toBe('unsupported')
  })
})
