import { describe, expect, it } from 'vitest'
import { certifyCheckpoint } from '../../src/domain/checkpoint.js'
import { deriveProjection } from '../../src/domain/derive.js'
import type { SemanticAction } from '../../src/domain/protocol-manifest.js'
import type { EvidenceBinding, GuardEvidence, GuardItem, TargetTuple } from '../../src/domain/types.js'

const D1 = '11'.repeat(32)
const D2 = '22'.repeat(32)
const D3 = '33'.repeat(32)

interface CaptureFixture {
  action: SemanticAction
  message: string
  cwd?: string
  requested: TargetTuple
  mismatchedResolved: TargetTuple
  observed: TargetTuple
  parameters: TargetTuple
}

const FIXTURES: CaptureFixture[] = [
  {
    action: 'install', message: 'Install package @acme/guard@1.2.3 in profile web.', cwd: '/work/repo',
    requested: { package_id: '@acme/guard', version: '1.2.3', profile: 'web' },
    mismatchedResolved: { package_id: '@evil/guard', version: '1.2.3', integrity_digest: D1, profile: 'web' },
    observed: { package_id: '@evil/guard', version: '1.2.3', integrity_digest: D1, profile: 'web' },
    parameters: { package_id: '@evil/guard', version: '1.2.3', integrity_digest: D1, profile: 'web' },
  },
  {
    action: 'apply', message: 'Apply package @acme/guard@1.2.3 to profile web.', cwd: '/work/repo',
    requested: { package_id: '@acme/guard', version: '1.2.3', profile: 'web' },
    mismatchedResolved: { package_id: '@evil/guard', version: '1.2.3', integrity_digest: D1, profile: 'web' },
    observed: { package_id: '@evil/guard', version: '1.2.3', integrity_digest: D1, profile: 'web' },
    parameters: { package_id: '@evil/guard', version: '1.2.3', integrity_digest: D1, profile: 'web' },
  },
  {
    action: 'create', message: 'Create /work/alpha.txt.', cwd: '/work',
    requested: { artifact_id: '/work/alpha.txt', scope: '/work' },
    mismatchedResolved: { artifact_id: '/work/beta.txt', scope: '/work', pre_digest: 'absent', change_set_digest: D1 },
    observed: { post_digest: D2 }, parameters: { post_digest: D2 },
  },
  {
    action: 'modify', message: 'Modify /work/alpha.txt.', cwd: '/work',
    requested: { artifact_id: '/work/alpha.txt', scope: '/work' },
    mismatchedResolved: { artifact_id: '/work/beta.txt', scope: '/work', pre_digest: D1, change_set_digest: D2 },
    observed: { post_digest: D3 }, parameters: { post_digest: D3 },
  },
  {
    action: 'restart', message: 'Restart service api.', cwd: '/work/repo',
    requested: { service_id: 'api' },
    mismatchedResolved: { service_id: 'worker', pre_generation: 'generation-1' },
    observed: { new_generation: 'generation-2', health: 'healthy' },
    parameters: { pre_generation: 'generation-1', health: 'healthy' },
  },
  {
    action: 'commit', message: 'Commit repository repo-alpha on branch main.', cwd: '/work/repo',
    requested: { repository: 'repo-alpha', branch: 'main' },
    mismatchedResolved: { repository: 'repo-beta', branch: 'main', change_set_digest: D1, pre_head_oid: D2 },
    observed: { post_head_oid: D3 }, parameters: { pre_head_oid: D2, change_set_digest: D1 },
  },
  {
    action: 'push', message: 'Push repository repo-alpha to remote origin refspec refs/heads/main:refs/heads/main.', cwd: '/work/repo',
    requested: { repository: 'repo-alpha', remote: 'origin', refspec: 'refs/heads/main:refs/heads/main' },
    mismatchedResolved: { repository: 'repo-beta', remote: 'origin', refspec: 'refs/heads/main:refs/heads/main', local_oid: D1 },
    observed: { remote_oid: D1 }, parameters: { local_oid: D1 },
  },
  {
    action: 'publish', message: 'Publish package @acme/pkg version 2.0.0 to registry https://registry.example/.', cwd: '/work/repo',
    requested: { artifact_id: '@acme/pkg', version: '2.0.0', registry: 'https://registry.example/' },
    mismatchedResolved: { artifact_id: '@evil/pkg', version: '2.0.0', registry: 'https://registry.example/', integrity_digest: D1 },
    observed: { artifact_id: '@evil/pkg', version: '2.0.0', registry: 'https://registry.example/', integrity_digest: D1 },
    parameters: { artifact_id: '@evil/pkg', version: '2.0.0', registry: 'https://registry.example/', integrity_digest: D1 },
  },
  {
    action: 'pull', message: 'Pull repository repo-alpha from remote origin refspec refs/heads/main.', cwd: '/work/repo',
    requested: { repository: 'repo-alpha', remote: 'origin', refspec: 'refs/heads/main' },
    mismatchedResolved: { repository: 'repo-beta', remote: 'origin', refspec: 'refs/heads/main', upstream_oid: D2, pre_head_oid: D1, pull_mode: 'ff-only' },
    observed: { post_head_oid: D2, tracking_ref_oid: D2 },
    parameters: { upstream_oid: D2, pre_head_oid: D1, pull_mode: 'ff-only' },
  },
  {
    action: 'fetch', message: 'Fetch repository repo-alpha from remote origin refspec refs/heads/main:refs/remotes/origin/main.', cwd: '/work/repo',
    requested: { repository: 'repo-alpha', remote: 'origin', refspec: 'refs/heads/main:refs/remotes/origin/main' },
    mismatchedResolved: { repository: 'repo-beta', remote: 'origin', refspec: 'refs/heads/main:refs/remotes/origin/main', upstream_oid: D2, pre_head_oid: D1 },
    observed: { tracking_ref_oid: D2, post_head_oid: D1 }, parameters: { upstream_oid: D2, pre_head_oid: D1 },
  },
]

function deriveItem(message: string, cwd?: string): { item: GuardItem; projection: ReturnType<typeof deriveProjection>['projection'] } {
  const result = deriveProjection([{
    seq: 1,
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: message }] },
  }], { activation: 'always' }, cwd ? { cwd } : {}, true)
  const items = [...result.projection.items.values()]
  expect(items).toHaveLength(1)
  return { item: items[0], projection: result.projection }
}

function evidence(id: string, fixture: CaptureFixture, role: 'resolution' | 'effect' | 'state'): GuardEvidence {
  return {
    id,
    epoch: 0,
    callId: id,
    rootCallId: id,
    toolName: 'context_guard_evidence',
    toolResultSeq: Number(id.slice(1)),
    outcome: 'success',
    capabilities: role === 'effect' ? ['shell'] : ['state-readback'],
    subjects: [String(fixture.requested.artifact_id ?? fixture.cwd ?? 'scope')],
    surfaces: ['scope'],
    boundedSummarySha256: D1,
    semanticAction: fixture.action,
    evidenceRole: role,
    resolvedTarget: fixture.mismatchedResolved,
    ...(role === 'state' ? { observedState: fixture.observed } : {}),
    parseStatus: 'supported',
    adapterId: 'context-guard.test.v1',
    adapterVersion: '1.0.0',
  }
}

function mismatchedBinding(item: GuardItem, fixture: CaptureFixture): EvidenceBinding {
  return {
    itemId: item.id,
    evidenceIds: ['E001', 'E002', 'E003'],
    semanticAction: fixture.action,
    requestedTarget: item.requestedTarget,
    resolvedTarget: fixture.mismatchedResolved,
    observedState: fixture.observed,
    expectedTransition: {
      predicateId: `pred.${fixture.action}.v1`,
      version: 1,
      predParamsKind: 'inline',
      parameters: fixture.parameters,
    },
    resolutionEvidenceId: 'E001',
    effectEvidenceId: 'E002',
    stateEvidenceIds: ['E003'],
  }
}

describe('v0.3 production action target capture', () => {
  it.each(FIXTURES)('$action captures root identity and rejects adapter target substitution', (fixture) => {
    const { item, projection } = deriveItem(fixture.message, fixture.cwd)
    expect(item.semanticAction).toBe(fixture.action)
    expect(item.targetCaptureStatus).toBe('resolved')
    expect(item.targetCaptureReasonCode).toBeUndefined()
    expect(item.requestedTarget).toEqual(fixture.requested)

    projection.evidence.set('E001', evidence('E001', fixture, 'resolution'))
    projection.evidence.set('E002', evidence('E002', fixture, 'effect'))
    projection.evidence.set('E003', evidence('E003', fixture, 'state'))
    const result = certifyCheckpoint(projection, [mismatchedBinding(item, fixture)], 'C001')
    expect(result.status).toBe('incomplete')
    expect(result.rejectedBindings).toEqual([expect.objectContaining({
      itemId: item.id,
      reasonCode: 'requested_resolved_target_mismatch',
    })])
  })

  it.each([
    ['Install the plugin.', undefined, 'requested_target_package_id_missing'],
    ['Create the requested artifact.', '/work', 'requested_target_artifact_id_missing'],
    ['Restart the service.', '/work', 'requested_target_service_id_missing'],
    ['Publish the package.', '/work', 'requested_target_artifact_id_missing'],
    ['Publish package fixture@1.0.0 registry http://registry.example/.', '/work', 'requested_target_registry_missing_or_invalid'],
    ['Push to remote origin.', undefined, 'requested_target_repository_missing'],
  ] as const)('fails closed when identity extraction needs clarification: %s', (message, cwd, reasonCode) => {
    const { item, projection } = deriveItem(message, cwd)
    expect(item.requestedTarget).toEqual({})
    expect(item.targetCaptureStatus).toBe('clarification_required')
    expect(item.targetCaptureReasonCode).toBe(reasonCode)

    const result = certifyCheckpoint(projection, [{ itemId: item.id, evidenceIds: [] }], 'C001')
    expect(result.status).toBe('incomplete')
    expect(result.rejectedBindings[0]).toEqual(expect.objectContaining({ itemId: item.id, reasonCode }))
  })

  it.each([
    '等我确认后再继续',
    '收到我的确认再继续',
    'Wait for your confirmation before continuing',
  ])('derives a root wait qualification only from an explicit decision boundary: %s', (message) => {
    const { item } = deriveItem(message, '/work')
    expect(item.waitAuthorization).toEqual(expect.objectContaining({ kind: 'root_explicit_wait' }))
  })

  it.each([
    '先延期到下个迭代',
    '本迭代不做',
    'Defer this to the next iteration',
  ])('derives a root defer qualification only from an explicit scope decision: %s', (message) => {
    const { item } = deriveItem(message, '/work')
    expect(item.deferAuthorization).toEqual(expect.objectContaining({ kind: 'root_explicit_defer' }))
  })

  it.each([
    '先停一下，稍后继续',
    '不要继续输出',
    'Stop here for now',
    'Maybe continue later',
  ])('does not convert ordinary stop prose into typed authorization: %s', (message) => {
    const { item } = deriveItem(message, '/work')
    expect(item.waitAuthorization).toBeUndefined()
    expect(item.deferAuthorization).toBeUndefined()
  })
})
