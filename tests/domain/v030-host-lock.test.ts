import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bindExecutableIdentity,
  bindLiveGoalCapability,
  EXPECTED_HOST_PACKAGES,
  GOAL_HOST_PACKAGES,
  HOST_CAPABILITY_PACKAGE_GROUPS,
  evaluateHostCapability,
  evaluateExternalWaitCapability,
  evaluateHostLock,
  evaluateToolSurfaceCapability,
} from '../../src/domain/host-lock.js'
import {
  HostProfileError,
  hostLockContextFromComposedDump,
  hostLockRowsFromComposedDump,
  injectActiveProfileHostLock,
  packageRowsFromActiveGraph,
  resolveActiveProfileHostLock,
  verifyComposedHostLockDump,
} from '../../src/domain/host-resolver.js'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function withoutGoal() {
  return EXPECTED_HOST_PACKAGES.filter((row) => !GOAL_HOST_PACKAGES.has(row.name))
}

function auditedRows(...names: string[]) {
  const selected = new Set(names)
  return EXPECTED_HOST_PACKAGES.filter((row) => selected.has(row.name))
}

describe('v0.3 host graph and live capability binding', () => {
  it('locks the real update_goal provider and treats the Goal graph as a pair', () => {
    expect(EXPECTED_HOST_PACKAGES).toContainEqual({
      name: '@deepseek-ai/dsh-tool-goal',
      version: '0.1.1-rc.2',
      integrity: 'sha512-kTECpE732uwlxRJr/jBZb1BqaxZzrA7Rv4KuM3eolvhoTJ5zjyiR2YHmDmCSfuI6zmA/BEfWss7D0mLbVtJEZA==',
    })
    // CG-DSH-001: a graph missing the whole Goal pair fails closed as an
    // incomplete audited graph; a partial Goal pair still names its own gap.
    const withoutGoalLock = evaluateHostLock(withoutGoal())
    expect(withoutGoalLock.status).toBe('unavailable')
    expect(withoutGoalLock.reasonCode).toBe('host_lock_missing')
    expect(withoutGoalLock.missingPackages).toEqual(['@deepseek-ai/dsh-goal', '@deepseek-ai/dsh-tool-goal'])
    for (const omitted of ['@deepseek-ai/dsh-goal', '@deepseek-ai/dsh-tool-goal']) {
      const partial = evaluateHostLock(EXPECTED_HOST_PACKAGES.filter((row) => row.name !== omitted))
      expect(partial.status).toBe('unavailable')
      expect(partial.reasonCode).toBe('host_lock_goal_graph_incomplete')
      expect(partial.goalAvailable).toBe(false)
    }
  })

  it('fails closed without throwing for duplicate critical rows', () => {
    const duplicate = [...EXPECTED_HOST_PACKAGES, { ...EXPECTED_HOST_PACKAGES[1] }]
    expect(() => evaluateHostLock(duplicate)).not.toThrow()
    expect(evaluateHostLock(duplicate)).toMatchObject({
      status: 'unavailable',
      reasonCode: 'host_lock_duplicate_package',
      goalAvailable: false,
    })
    expect(evaluateHostLock(duplicate).digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('evaluates POSIX and Windows terminal capabilities independently', () => {
    // The audited graph is complete: both terminal stacks are installed, and
    // the active platform selects which surface replay trusts.
    const posixLock = evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'headless' })
    expect(posixLock.status).toBe('supported')
    expect(evaluateHostCapability(posixLock, { action: 'commit' })).toMatchObject({ status: 'supported' })
    expect(evaluateHostCapability(posixLock, { action: 'commit', platform: 'windows' })).toMatchObject({ status: 'supported' })
    expect(posixLock.capabilities.terminal_windows.status).toBe('supported')
    expect(posixLock.capabilities.terminal_posix.status).toBe('supported')
    // A pwsh result can never be evidence from the active posix surface.
    expect(evaluateToolSurfaceCapability(posixLock, 'pwsh')).toMatchObject({
      status: 'unsupported',
      reasonCode: 'host_capability_request_unsupported',
    })
    expect(evaluateToolSurfaceCapability(posixLock, 'bash')).toMatchObject({ status: 'supported' })
    expect(evaluateHostCapability(posixLock, { action: 'create' }).digest)
      .not.toBe(evaluateHostCapability(posixLock, { action: 'modify' }).digest)

    const windowsDrift = evaluateHostLock(
      EXPECTED_HOST_PACKAGES.map((row) => row.name === '@deepseek-ai/dsh-tool-pwsh' ? { ...row, integrity: 'sha512-drift' } : row),
      { platform: 'posix', profileKind: 'headless' },
    )
    // CG-DSH-001: an integrity-drifted optional row fails the whole lock
    // closed, and every capability inherits the failed lock.
    expect(windowsDrift.status).toBe('unsupported')
    expect(windowsDrift.reasonCode).toBe('host_lock_integrity_mismatch')
    expect(evaluateHostCapability(windowsDrift, { action: 'commit' }).status).toBe('unsupported')
    expect(evaluateHostCapability(windowsDrift, { action: 'commit', platform: 'windows' })).toMatchObject({
      status: 'unsupported',
      reasonCode: 'host_capability_integrity_mismatch',
    })
  })

  it('supports the layered install/apply/Web requirements on the complete audited graph and fails closed on a missing controller', () => {
    const full = evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'headless' })
    expect(full.status).toBe('supported')
    expect(evaluateHostCapability(full, { action: 'install' }).status).toBe('supported')
    expect(evaluateHostCapability(full, { action: 'apply' }).status).toBe('supported')
    expect(evaluateHostCapability(full, { action: 'restart' })).toMatchObject({
      status: 'unavailable',
      reasonCode: 'host_capability_request_unsupported',
    })
    const web = evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' })
    expect(evaluateHostCapability(web, { action: 'apply' }).status).toBe('supported')
    expect(evaluateHostCapability(web, { action: 'restart' }).status).toBe('supported')
    // CG-DSH-001: a graph missing the dshmarket controller row fails the
    // whole lock closed and every capability inherits the failure.
    const missingMarket = evaluateHostLock(
      EXPECTED_HOST_PACKAGES.filter((row) => row.name !== 'dshmarket'),
      { platform: 'posix', profileKind: 'web' },
    )
    expect(missingMarket.status).toBe('unavailable')
    expect(missingMarket.reasonCode).toBe('host_lock_missing')
    expect(missingMarket.missingPackages).toEqual(['dshmarket'])
    expect(evaluateHostCapability(missingMarket, { action: 'apply' })).toMatchObject({
      status: 'unavailable',
      reasonCode: 'host_capability_missing',
    })
    expect(evaluateHostCapability(missingMarket, { action: 'commit' }).status).toBe('unavailable')
  })

  it('locks the filesystem registration/provider/sandbox chain without poisoning terminal actions', () => {
    // CG-DSH-001: a graph missing the filesystem chain fails the whole lock
    // closed (missing audited rows), so no action can certify from it.
    const withoutFilesystem = evaluateHostLock(
      EXPECTED_HOST_PACKAGES.filter((row) => !HOST_CAPABILITY_PACKAGE_GROUPS.filesystem.has(row.name)),
      { platform: 'posix', profileKind: 'headless' },
    )
    expect(withoutFilesystem.status).toBe('unavailable')
    expect(withoutFilesystem.reasonCode).toBe('host_lock_missing')
    expect(withoutFilesystem.missingPackages).toEqual([...HOST_CAPABILITY_PACKAGE_GROUPS.filesystem].sort())
    expect(evaluateHostCapability(withoutFilesystem, { action: 'create' }).status).toBe('unavailable')
    expect(evaluateHostCapability(withoutFilesystem, { action: 'modify' }).status).toBe('unavailable')
    expect(evaluateToolSurfaceCapability(withoutFilesystem, 'filesystem').status).toBe('unavailable')
    expect(evaluateToolSurfaceCapability(withoutFilesystem, 'bash').status).toBe('unavailable')

    const supported = evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'headless' })
    expect(evaluateHostCapability(supported, { action: 'create' }).status).toBe('supported')
    expect(evaluateHostCapability(supported, { action: 'modify' }).status).toBe('supported')
    expect(evaluateToolSurfaceCapability(supported, 'filesystem').status).toBe('supported')

    const drifted = evaluateHostLock(EXPECTED_HOST_PACKAGES.map((row) => row.name === '@deepseek-ai/dsh-tool-fs'
      ? { ...row, integrity: 'sha512-drift' }
      : row), { platform: 'posix', profileKind: 'headless' })
    // CG-DSH-001: a drifted optional row fails the whole lock closed.
    expect(drifted.status).toBe('unsupported')
    expect(drifted.reasonCode).toBe('host_lock_integrity_mismatch')
    expect(evaluateHostCapability(drifted, { action: 'create' })).toMatchObject({
      status: 'unsupported', reasonCode: 'host_capability_integrity_mismatch',
    })
    expect(evaluateHostCapability(drifted, { action: 'modify' }).status).toBe('unsupported')
    expect(evaluateHostCapability(drifted, { action: 'commit' }).status).toBe('unsupported')
    expect(evaluateToolSurfaceCapability(drifted, 'bash').status).toBe('unsupported')
  })

  it('locks external_wait jobs API/provider/controller as an independent capability', () => {
    // CG-DSH-001: a graph missing the jobs trio fails the whole lock closed.
    const minimal = evaluateHostLock(
      EXPECTED_HOST_PACKAGES.filter((row) => !['@deepseek-ai/dsh-jobs', '@deepseek-ai/dsh-jobs-local', '@deepseek-ai/dsh-tool-jobs'].includes(row.name)),
      { platform: 'posix', profileKind: 'headless' },
    )
    expect(minimal.status).toBe('unavailable')
    expect(minimal.reasonCode).toBe('host_lock_missing')
    expect(minimal.missingPackages).toEqual([
      '@deepseek-ai/dsh-jobs',
      '@deepseek-ai/dsh-jobs-local',
      '@deepseek-ai/dsh-tool-jobs',
    ])
    expect(evaluateExternalWaitCapability(minimal)).toMatchObject({
      status: 'unavailable',
      missingPackages: [
        '@deepseek-ai/dsh-jobs',
        '@deepseek-ai/dsh-jobs-local',
        '@deepseek-ai/dsh-tool-jobs',
      ],
    })

    const supported = evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'headless' })
    expect(evaluateExternalWaitCapability(supported)).toMatchObject({
      status: 'supported',
      id: 'boundary.external_wait.jobs',
    })
    // A version-drifted jobs provider fails the whole lock closed (CG-DSH-001);
    // external_wait and every other capability inherit the failed lock.
    const drifted = evaluateHostLock(
      EXPECTED_HOST_PACKAGES.map((row) => row.name === '@deepseek-ai/dsh-jobs-local'
        ? { ...row, version: '0.1.1-rc.3' }
        : row),
      { platform: 'posix', profileKind: 'headless' },
    )
    expect(drifted.status).toBe('unsupported')
    expect(drifted.reasonCode).toBe('host_lock_version_mismatch')
    expect(evaluateExternalWaitCapability(drifted)).toMatchObject({
      status: 'unsupported',
      reasonCode: 'host_capability_version_mismatch',
    })
    expect(evaluateHostCapability(drifted, { action: 'create' }).status).toBe('unsupported')
  })

  it('binds git/npm/pnpm/dsh realpath and version across resolution and effect', () => {
    const git = { executable: 'git' as const, realpath: '/usr/bin/git', version: 'git version 2.50.1' }
    expect(bindExecutableIdentity(git, { ...git })).toMatchObject({ status: 'supported', identity: git })
    expect(bindExecutableIdentity(git, { ...git, realpath: '/tmp/swapped/git' })).toMatchObject({
      status: 'unsupported', reasonCode: 'executable_identity_drift',
    })
    expect(bindExecutableIdentity(git, { ...git, version: 'git version 2.51.0' })).toMatchObject({
      status: 'unsupported', reasonCode: 'executable_identity_drift',
    })
    const dsh = { executable: 'dsh' as const, realpath: '/opt/dsh/bin/dsh', version: '0.1.1-rc.2' }
    expect(bindExecutableIdentity(dsh, { ...dsh })).toMatchObject({ status: 'supported', identity: dsh })
    const windowsDsh = {
      executable: 'dsh' as const,
      realpath: 'C:\\tools\\dsh.cmd',
      version: '0.1.1-rc.2',
      interpreterRealpath: 'C:\\Windows\\System32\\cmd.exe',
      interpreterVersion: 'Microsoft Windows [Version 10.0.26100.1]',
    }
    expect(bindExecutableIdentity(windowsDsh, { ...windowsDsh })).toMatchObject({
      status: 'supported', identity: windowsDsh,
    })
    expect(bindExecutableIdentity(windowsDsh, {
      ...windowsDsh,
      interpreterRealpath: 'C:\\tmp\\cmd.exe',
    })).toMatchObject({ status: 'unsupported', reasonCode: 'executable_identity_drift' })
    expect(bindExecutableIdentity(windowsDsh, {
      ...windowsDsh,
      interpreterVersion: 'Microsoft Windows [Version 10.0.99999.1]',
    })).toMatchObject({ status: 'unsupported', reasonCode: 'executable_identity_drift' })
    expect(bindExecutableIdentity(
      { ...windowsDsh, interpreterVersion: undefined },
      { ...windowsDsh, interpreterVersion: undefined },
    )).toMatchObject({ status: 'unavailable', reasonCode: 'executable_realpath_invalid' })
    expect(bindExecutableIdentity(
      { ...windowsDsh, interpreterRealpath: undefined },
      { ...windowsDsh, interpreterRealpath: undefined },
    )).toMatchObject({ status: 'unavailable', reasonCode: 'executable_realpath_invalid' })
    expect(bindExecutableIdentity(
      { executable: 'pnpm', realpath: 'node_modules/.bin/pnpm', version: '9.15.9' },
      { executable: 'pnpm', realpath: 'node_modules/.bin/pnpm', version: '9.15.9' },
    )).toMatchObject({ status: 'unavailable', reasonCode: 'executable_realpath_invalid' })
  })

  it('rejects both injected-graph/live-Goal capability inconsistencies', () => {
    // The complete audited graph carries the Goal pair, so a missing live
    // Goal peer fails the liveness binding.
    expect(bindLiveGoalCapability(evaluateHostLock(EXPECTED_HOST_PACKAGES), false)).toMatchObject({
      status: 'unavailable',
      reasonCode: 'host_lock_goal_capability_mismatch',
      liveGoalAvailable: false,
    })
    expect(bindLiveGoalCapability(evaluateHostLock(EXPECTED_HOST_PACKAGES), true).status).toBe('supported')
    // A graph missing the Goal pair cannot bind live Goal state at all: the
    // lock is already unavailable and the binding keeps that status.
    const missing = bindLiveGoalCapability(evaluateHostLock(withoutGoal()), true)
    expect(missing.status).toBe('unavailable')
    expect(missing.reasonCode).toBe('host_lock_missing')
    expect(missing.liveGoalAvailable).toBe(true)
  })
})

function makeActiveRoots() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-host-lock-'))
  temporaryRoots.push(root)
  const runtimeRoot = join(root, 'runtime')
  const profileRoot = join(root, 'profile')
  const modulesRoot = join(runtimeRoot, 'node_modules')
  mkdirSync(modulesRoot, { recursive: true })
  mkdirSync(join(profileRoot, 'node_modules', 'dsh-completion-guard'), { recursive: true })
  const packages: Record<string, { url: string; dependencies: Record<string, string> }> = {
    '.': { url: '..', dependencies: {} },
  }
  const runtimeRows = EXPECTED_HOST_PACKAGES.filter((row) => row.name !== 'dshmarket')
  for (const [index, row] of runtimeRows.entries()) {
    const id = `${row.name}@${row.version}`
    const relative = `./active/package-${index}`
    packages['.'].dependencies[row.name] = id
    packages[id] = { url: relative, dependencies: {} }
    const packageRoot = join(modulesRoot, relative)
    mkdirSync(packageRoot, { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: row.name, version: row.version }))
  }
  const lockYaml = (rows: typeof EXPECTED_HOST_PACKAGES) => [
    "lockfileVersion: '9.0'", '', 'packages:',
    ...rows.flatMap((row) => [
      `  '${row.name}@${row.version}':`,
      `    resolution: {integrity: ${row.integrity}}`,
      '',
    ]),
    'snapshots:', '',
  ].join('\n')
  writeFileSync(join(runtimeRoot, 'pnpm-lock.yaml'), lockYaml(runtimeRows))
  writeFileSync(join(modulesRoot, '.package-map.json'), JSON.stringify({ packages }))
  const profileModules = join(profileRoot, 'node_modules')
  mkdirSync(join(profileModules, 'dshmarket'), { recursive: true })
  writeFileSync(join(profileModules, 'dshmarket', 'package.json'), JSON.stringify({ name: 'dshmarket', version: '1.36.0' }))
  writeFileSync(join(profileRoot, 'pnpm-lock.yaml'), lockYaml(auditedRows('dshmarket')))
  writeFileSync(join(profileModules, '.package-map.json'), JSON.stringify({
    packages: {
      '.': { url: '..', dependencies: { dshmarket: 'dshmarket' } },
      dshmarket: { url: './dshmarket', dependencies: {} },
    },
  }))
  writeFileSync(join(profileRoot, 'package.json'), JSON.stringify({
    dependencies: { 'dsh-completion-guard': 'file:/synthetic/candidate.tgz', dshmarket: '1.36.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app', 'dshmarket', 'dsh-completion-guard'] } },
  }))
  writeFileSync(join(profileRoot, 'node_modules', 'dsh-completion-guard', 'package.json'), JSON.stringify({
    name: 'dsh-completion-guard', version: '0.3.0',
  }))
  writeFileSync(join(profileRoot, 'cordis.patch.yml'), [
    '# existing user patch is preserved',
    '- id: context-guard',
    '  name: dsh-completion-guard',
    '  config:',
    '    activation: always',
    '',
  ].join('\n'))
  return { runtimeRoot, profileRoot, packages }
}

describe('active profile graph injection and composed readback', () => {
  it('derives reachable rows, injects idempotently, and verifies composed config', () => {
    const fixture = makeActiveRoots()
    const active = resolveActiveProfileHostLock(fixture.runtimeRoot, fixture.profileRoot, '0.3.0')
    expect(active.evaluation).toMatchObject({ status: 'supported', goalAvailable: true })
    injectActiveProfileHostLock(active)
    const once = readFileSync(join(fixture.profileRoot, 'cordis.patch.yml'), 'utf8')
    expect(once).toContain('# existing user patch is preserved')
    expect(once).toContain('activation: "always"')
    const expectedPlatform = process.platform === 'win32' ? 'windows' : 'posix'
    expect(once).toContain(`hostLockPlatform: "${expectedPlatform}"`)
    expect(once).toContain('hostLockProfile: "web"')
    expect(once).toContain('@deepseek-ai/dsh-tool-goal')
    expect(once).toContain('dshmarket')
    injectActiveProfileHostLock(active)
    expect(readFileSync(join(fixture.profileRoot, 'cordis.patch.yml'), 'utf8')).toBe(once)

    const managed = once.slice(once.indexOf('# >>> BEGIN')).split(/\r?\n/)
      .filter((line) => !line.startsWith('# >>>') && !line.startsWith('# <<<')).join('\n')
    expect(hostLockRowsFromComposedDump(managed)).toEqual(active.evaluation.packages)
    expect(hostLockContextFromComposedDump(managed)).toEqual({ platform: expectedPlatform, profileKind: 'web' })
    expect(verifyComposedHostLockDump(managed, active.evaluation).digest).toBe(active.evaluation.digest)
    expect(() => verifyComposedHostLockDump(managed.replace('0.1.1-rc.2', '0.1.1-rc.3'), active.evaluation))
      .toThrowError(new HostProfileError('host_lock_readback_mismatch', 'composed config host lock does not match the active graph'))
    expect(() => verifyComposedHostLockDump(managed.replace('hostLockProfile: "web"', 'hostLockProfile: "headless"'), active.evaluation))
      .toThrowError(/does not match the active graph/)

    const dshDump = managed.replace(
      /        integrity: "([^"]+)"/g,
      '        integrity: >-\n          $1',
    )
    expect(hostLockRowsFromComposedDump(dshDump)).toEqual(active.evaluation.packages)
    expect(verifyComposedHostLockDump(dshDump, active.evaluation).digest).toBe(active.evaluation.digest)
  })

  it('rejects a duplicate reachable critical package and package drift before injection', () => {
    const fixture = makeActiveRoots()
    const agent = EXPECTED_HOST_PACKAGES.find((row) => row.name === '@deepseek-ai/dsh-agent')!
    const duplicateId = `${agent.name}@${agent.version}(other-peer)`
    fixture.packages.bridge = { url: './active/bridge', dependencies: { alias: duplicateId } }
    fixture.packages['.'].dependencies.bridge = 'bridge'
    fixture.packages[duplicateId] = { url: './active/package-1', dependencies: {} }
    writeFileSync(join(fixture.runtimeRoot, 'node_modules', '.package-map.json'), JSON.stringify({ packages: fixture.packages }))
    expect(packageRowsFromActiveGraph(
      JSON.stringify({ packages: fixture.packages }),
      readFileSync(join(fixture.runtimeRoot, 'pnpm-lock.yaml'), 'utf8'),
    ).filter((row) => row.name === agent.name)).toHaveLength(2)
    expect(() => resolveActiveProfileHostLock(fixture.runtimeRoot, fixture.profileRoot, '0.3.0'))
      .toThrowError(/active runtime graph does not match/)

    delete fixture.packages.bridge
    delete fixture.packages[duplicateId]
    delete fixture.packages['.'].dependencies.bridge
    writeFileSync(join(fixture.runtimeRoot, 'node_modules', '.package-map.json'), JSON.stringify({ packages: fixture.packages }))
    const lockPath = join(fixture.runtimeRoot, 'pnpm-lock.yaml')
    writeFileSync(lockPath, readFileSync(lockPath, 'utf8').replace(agent.integrity!, 'sha512-drift'))
    expect(() => resolveActiveProfileHostLock(fixture.runtimeRoot, fixture.profileRoot, '0.3.0'))
      .toThrowError(/active runtime graph does not match/)
  })

  it('re-injects idempotently when the profile had no unmanaged context-guard override', () => {
    const fixture = makeActiveRoots()
    writeFileSync(join(fixture.profileRoot, 'cordis.patch.yml'), '')
    const active = resolveActiveProfileHostLock(fixture.runtimeRoot, fixture.profileRoot, '0.3.0')
    injectActiveProfileHostLock(active)
    const once = readFileSync(join(fixture.profileRoot, 'cordis.patch.yml'), 'utf8')
    injectActiveProfileHostLock(active)
    expect(readFileSync(join(fixture.profileRoot, 'cordis.patch.yml'), 'utf8')).toBe(once)
  })

  it('replaces the fresh-profile empty sequence sentinel without corrupting YAML', () => {
    const fixture = makeActiveRoots()
    writeFileSync(join(fixture.profileRoot, 'cordis.patch.yml'), [
      '# fresh DSH profile patch',
      '# entries follow',
      '[]',
      '',
    ].join('\n'))
    const active = resolveActiveProfileHostLock(fixture.runtimeRoot, fixture.profileRoot, '0.3.0')
    injectActiveProfileHostLock(active)
    const once = readFileSync(join(fixture.profileRoot, 'cordis.patch.yml'), 'utf8')
    expect(once).toContain('# fresh DSH profile patch')
    expect(once.split(/\r?\n/).some((line) => line.trim() === '[]')).toBe(false)
    expect(once).toContain('\n- id: context-guard\n')
    injectActiveProfileHostLock(active)
    expect(readFileSync(join(fixture.profileRoot, 'cordis.patch.yml'), 'utf8')).toBe(once)
  })
})
