import { describe, expect, it } from 'vitest'
import { captureClause } from '../../src/domain/capture.js'
import { certifyCheckpoint } from '../../src/domain/checkpoint.js'
import { hasCurrentCertificate } from '../../src/domain/goal-gate.js'
import { ACTION_MANIFEST, STATEFUL_ACTIONS, type SemanticAction } from '../../src/domain/protocol-manifest.js'
import { createProjection, type GuardEvidence, type GuardProjection, type TargetTuple } from '../../src/domain/types.js'
import { sha256 } from '../../src/domain/canonicalize.js'

interface StatefulFixture {
  requested: TargetTuple
  resolved: TargetTuple
  observed: TargetTuple
  params: TargetTuple
}

const X1 = '11'.repeat(32)
const X2 = '22'.repeat(32)
const X3 = '33'.repeat(32)

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(',')}}`
  return JSON.stringify(value)
}

function frozenTransition(action: SemanticAction, params: TargetTuple) {
  const expectedTransition = { predicateId: `pred.${action}.v1`, version: 1, predParamsKind: 'inline' as const, parameters: params }
  return { expectedTransition, expectedTransitionDigest: sha256(stable(expectedTransition)) }
}

function statefulFixture(action: SemanticAction): StatefulFixture {
  switch (action) {
    case 'install':
    case 'apply':
      return {
        requested: { package_id: 'synthetic-plugin', version: '1.2.3', profile: 'synthetic-profile' },
        resolved: { package_id: 'synthetic-plugin', version: '1.2.3', integrity_digest: X1, profile: 'synthetic-profile' },
        observed: { package_id: 'synthetic-plugin', version: '1.2.3', integrity_digest: X1, profile: 'synthetic-profile' },
        params: { package_id: 'synthetic-plugin', version: '1.2.3', integrity_digest: X1, profile: 'synthetic-profile' },
      }
    case 'create':
      return {
        requested: { artifact_id: 'synthetic-scope/synthetic-artifact.txt', scope: 'synthetic-scope' },
        resolved: { artifact_id: 'synthetic-scope/synthetic-artifact.txt', scope: 'synthetic-scope', pre_digest: 'absent', change_set_digest: X1 },
        observed: { post_digest: X2 }, params: { post_digest: X2 },
      }
    case 'modify':
      return {
        requested: { artifact_id: 'synthetic-scope/synthetic-artifact.txt', scope: 'synthetic-scope' },
        resolved: { artifact_id: 'synthetic-scope/synthetic-artifact.txt', scope: 'synthetic-scope', pre_digest: X1, change_set_digest: X2 },
        observed: { post_digest: X3 }, params: { post_digest: X3 },
      }
    case 'restart':
      return {
        requested: { service_id: 'synthetic-service' },
        resolved: { service_id: 'synthetic-service', pre_generation: 'generation-1' },
        observed: { new_generation: 'generation-2', health: 'healthy' },
        params: { pre_generation: 'generation-1', health: 'healthy' },
      }
    case 'commit':
      return {
        requested: { repository: 'synthetic-repo', branch: 'main' },
        resolved: { repository: 'synthetic-repo', branch: 'main', change_set_digest: X1, pre_head_oid: X2 },
        observed: { post_head_oid: X3, pre_head_oid: X2 }, params: { pre_head_oid: X2, change_set_digest: X1 },
      }
    case 'push':
      return {
        requested: { repository: 'synthetic-repo', remote: 'origin', refspec: 'refs/heads/main:refs/heads/main' },
        resolved: { repository: 'synthetic-repo', remote: 'origin', refspec: 'refs/heads/main:refs/heads/main', local_oid: X1 },
        observed: { remote_oid: X1 }, params: { local_oid: X1 },
      }
    case 'publish':
      return {
        requested: { artifact_id: 'synthetic-package', version: '1.2.3', registry: 'https://registry.example.test/' },
        resolved: { artifact_id: 'synthetic-package', version: '1.2.3', registry: 'https://registry.example.test/', integrity_digest: X1 },
        observed: { artifact_id: 'synthetic-package', version: '1.2.3', registry: 'https://registry.example.test/', integrity_digest: X1 },
        params: { artifact_id: 'synthetic-package', version: '1.2.3', integrity_digest: X1, registry: 'https://registry.example.test/' },
      }
    case 'pull':
      return {
        requested: { repository: 'synthetic-repo', remote: 'origin', refspec: 'refs/heads/main' },
        resolved: { repository: 'synthetic-repo', remote: 'origin', refspec: 'refs/heads/main', upstream_oid: X2, pre_head_oid: X1, pull_mode: 'ff-only' },
        observed: { post_head_oid: X2, tracking_ref_oid: X2 },
        params: { upstream_oid: X2, pre_head_oid: X1, pull_mode: 'ff-only' },
      }
    case 'fetch':
      return {
        requested: { repository: 'synthetic-repo', remote: 'origin', refspec: 'refs/heads/main:refs/remotes/origin/main' },
        resolved: { repository: 'synthetic-repo', remote: 'origin', refspec: 'refs/heads/main:refs/remotes/origin/main', upstream_oid: X2, pre_head_oid: X1 },
        observed: { tracking_ref_oid: X2, post_head_oid: X1 }, params: { upstream_oid: X2, pre_head_oid: X1 },
      }
    default:
      throw new Error(`not stateful: ${action}`)
  }
}

function evidence(
  id: string,
  action: SemanticAction,
  role: 'resolution' | 'effect' | 'state',
  resolvedTarget: TargetTuple,
  observedState?: TargetTuple,
): GuardEvidence {
  return {
    id, epoch: 0, callId: id, rootCallId: id, toolName: 'synthetic-adapter', toolResultSeq: Number(id.slice(1)),
    outcome: 'success', capabilities: role === 'effect' ? ['shell'] : ['filesystem-read'],
    subjects: ['synthetic-scope'], surfaces: ['artifact'], boundedSummarySha256: X1,
    executables: ['synthetic'], operations: [{ op: role === 'effect' ? 'run' : 'read', path: 'synthetic-scope' }],
    semanticAction: action, evidenceRole: role, resolvedTarget,
    ...(observedState ? { observedState } : {}),
    parseStatus: 'supported', adapterId: 'synthetic-adapter', adapterVersion: '1.0.0',
  }
}

function projectionFor(action: SemanticAction): { projection: GuardProjection; fixture: StatefulFixture } {
  const projection = createProjection()
  projection.enabled = true
  const fixture = statefulFixture(action)
  const instruction: Record<string, string> = {
    install: 'install package synthetic-plugin version 1.2.3 profile synthetic-profile',
    apply: 'apply package synthetic-plugin version 1.2.3 profile synthetic-profile',
    create: 'create synthetic-scope/synthetic-artifact.txt',
    modify: 'modify synthetic-scope/synthetic-artifact.txt',
    restart: 'restart service synthetic-service',
    commit: 'commit repository synthetic-repo branch main',
    push: 'push repository synthetic-repo remote origin refspec refs/heads/main:refs/heads/main',
    publish: 'publish package synthetic-package version 1.2.3 registry https://registry.example.test',
    pull: 'pull repository synthetic-repo remote origin refspec refs/heads/main',
    fetch: 'fetch repository synthetic-repo remote origin refspec refs/heads/main:refs/remotes/origin/main',
  }
  const item = captureClause(instruction[action], 'm1', 'R001', 1, { cwd: 'synthetic-scope' })
  expect(item.semanticAction).toBe(action)
  expect(item.requestedTarget).toEqual(fixture.requested)
  expect(item.targetCaptureStatus).toBe('resolved')
  projection.items.set(item.id, item)
  projection.contractRevision = 1
  projection.evidence.set('E001', {
    ...evidence('E001', action, 'resolution', fixture.resolved),
    ...frozenTransition(action, fixture.params),
  })
  projection.evidence.set('E002', evidence('E002', action, 'effect', fixture.resolved))
  projection.evidence.set('E003', evidence('E003', action, 'state', fixture.resolved, fixture.observed))
  return { projection, fixture }
}

function completeBinding(action: SemanticAction, fixture: StatefulFixture) {
  return {
    itemId: 'R001', evidenceIds: ['E001', 'E002', 'E003'], semanticAction: action,
    requestedTarget: fixture.requested, resolvedTarget: fixture.resolved, observedState: fixture.observed,
    expectedTransition: frozenTransition(action, fixture.params).expectedTransition,
    resolutionEvidenceId: 'E001', effectEvidenceId: 'E002', stateEvidenceIds: ['E003'],
  }
}

describe('v0.3 checkpoint certificate', () => {
  it.each(STATEFUL_ACTIONS)('%s rejects effect-only and certifies exact resolution/effect/readback closure', (action) => {
    const { projection, fixture } = projectionFor(action)
    const effectOnly = certifyCheckpoint(projection, [{
      itemId: 'R001', evidenceIds: ['E001', 'E002'], semanticAction: action,
      requestedTarget: fixture.requested, resolvedTarget: fixture.resolved,
      expectedTransition: { predicateId: `pred.${action}.v1`, version: 1, predParamsKind: 'inline', parameters: fixture.params },
      resolutionEvidenceId: 'E001', effectEvidenceId: 'E002', stateEvidenceIds: [],
    }], 'C001')
    if (ACTION_MANIFEST.actions[action].evidenceProducer === 'unavailable') {
      expect(effectOnly.status).toBe('incomplete')
      expect(effectOnly.rejectedBindings[0].reasonCode).toBe('stateful_adapter_unavailable')
      const unavailable = certifyCheckpoint(projection, [completeBinding(action, fixture)], 'C002')
      expect(unavailable.status).toBe('incomplete')
      expect(unavailable.rejectedBindings[0].reasonCode).toBe('stateful_adapter_unavailable')
      return
    }
    expect(effectOnly.status).toBe('incomplete')
    expect(effectOnly.rejectedBindings[0].reasonCode).toBe('effect_only_insufficient_state_readback')

    const certified = certifyCheckpoint(projection, [completeBinding(action, fixture)], 'C002')
    expect(certified.status).toBe('certified')
    expect(certified.checkpoint?.sessionRefDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(certified.checkpoint?.hostLockDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(certified.checkpoint?.evidenceSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(certified.checkpoint?.certificationDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(hasCurrentCertificate(projection)).toBe(true)
  })

  it('rejects action mismatch, cross-pairing, and predicate payload mismatch', () => {
    const { projection, fixture } = projectionFor('pull')
    const wrongAction = completeBinding('pull', fixture)
    wrongAction.semanticAction = 'push'
    expect(certifyCheckpoint(projection, [wrongAction], 'C001').rejectedBindings[0].reasonCode).toBe('semantic_action_mismatch')

    const crossPaired = completeBinding('pull', fixture)
    crossPaired.resolutionEvidenceId = 'E002'
    expect(certifyCheckpoint(projection, [crossPaired], 'C002').rejectedBindings[0].reasonCode).toBe('binding_resolution_cross_pairing')

    const paramsMismatch = completeBinding('pull', fixture)
    paramsMismatch.expectedTransition.parameters = { ...fixture.params, upstream_oid: X3 }
    expect(certifyCheckpoint(projection, [paramsMismatch], 'C003').rejectedBindings[0].reasonCode).toBe('binding_expected_transition_mismatch')
  })

  it('rejects forged commit parents and fetch HEAD drift', () => {
    const commit = projectionFor('commit')
    commit.projection.evidence.get('E003')!.observedState = { ...commit.fixture.observed, pre_head_oid: X1 }
    const wrongParent = completeBinding('commit', commit.fixture)
    wrongParent.observedState = { ...commit.fixture.observed, pre_head_oid: X1 }
    expect(certifyCheckpoint(commit.projection, [wrongParent], 'C-wrong-parent').rejectedBindings[0].reasonCode)
      .toBe('expected_transition_mismatch')

    const fetch = projectionFor('fetch')
    fetch.projection.evidence.get('E003')!.observedState = { ...fetch.fixture.observed, post_head_oid: X3 }
    const headDrift = completeBinding('fetch', fetch.fixture)
    headDrift.observedState = { ...fetch.fixture.observed, post_head_oid: X3 }
    expect(certifyCheckpoint(fetch.projection, [headDrift], 'C-head-drift').rejectedBindings[0].reasonCode)
      .toBe('expected_transition_mismatch')
  })

  it('rejects swapped, backfilled, missing, or digest-drifted resolution predicates', () => {
    const { projection, fixture } = projectionFor('pull')
    const swappedTransition = frozenTransition('pull', { ...fixture.params, upstream_oid: X3 })
    projection.evidence.set('E004', {
      ...evidence('E004', 'pull', 'resolution', fixture.resolved),
      ...swappedTransition,
    })
    const swapped = completeBinding('pull', fixture)
    swapped.expectedTransition = swappedTransition.expectedTransition
    expect(certifyCheckpoint(projection, [swapped], 'C-swap').rejectedBindings[0].reasonCode)
      .toBe('binding_expected_transition_mismatch')

    const resolution = projection.evidence.get('E001')!
    const originalTransition = resolution.expectedTransition
    resolution.expectedTransition = { ...originalTransition!, parameters: undefined }
    expect(certifyCheckpoint(projection, [completeBinding('pull', fixture)], 'C-missing').rejectedBindings[0].reasonCode)
      .toBe('resolution_expected_transition_missing')
    resolution.expectedTransition = originalTransition

    resolution.expectedTransitionDigest = undefined
    expect(certifyCheckpoint(projection, [completeBinding('pull', fixture)], 'C-missing-digest').rejectedBindings[0].reasonCode)
      .toBe('resolution_expected_transition_digest_missing')

    resolution.expectedTransitionDigest = X3
    expect(certifyCheckpoint(projection, [completeBinding('pull', fixture)], 'C-digest').rejectedBindings[0].reasonCode)
      .toBe('resolution_expected_transition_digest_mismatch')
    resolution.expectedTransitionDigest = frozenTransition('pull', fixture.params).expectedTransitionDigest

    resolution.expectedTransition = { ...originalTransition!, parametersDigest: X3 }
    resolution.expectedTransitionDigest = sha256(stable(resolution.expectedTransition))
    const invalidParametersDigest = completeBinding('pull', fixture)
    invalidParametersDigest.expectedTransition = {
      ...resolution.expectedTransition,
      parameters: resolution.expectedTransition.parameters!,
    }
    expect(certifyCheckpoint(projection, [invalidParametersDigest], 'C-parameters-digest').rejectedBindings[0].reasonCode)
      .toBe('resolution_expected_transition_invalid')
    resolution.expectedTransition = originalTransition
    resolution.expectedTransitionDigest = frozenTransition('pull', fixture.params).expectedTransitionDigest

    // A role-labelled "resolution" appended after effect/state is observed
    // backfill, not effect-before intent.
    resolution.toolResultSeq = 9
    expect(certifyCheckpoint(projection, [completeBinding('pull', fixture)], 'C-backfill').rejectedBindings[0].reasonCode)
      .toBe('binding_role_order_invalid')
  })

  it('names offending evidence without weakening all-or-nothing binding', () => {
    const projection = createProjection()
    const item = captureClause('run python unittest', 'm1', 'R001', 1, { cwd: '/work' })
    item.semanticAction = 'test'
    item.requestedTarget = { scope: '/work' }
    projection.items.set(item.id, item)
    projection.contractRevision = 1
    projection.evidence.set('Etest', {
      ...evidence('E001', 'test', 'effect', { scope: '/work', executable: 'python' }), id: 'Etest', toolName: 'bash',
      operations: [{ op: 'run', path: '/work' }], executables: ['python'], surfaces: ['scope'], capabilities: ['shell', 'deterministic-check'],
    })
    projection.evidence.set('Enoise', {
      ...evidence('E002', 'generic_run', 'effect', { scope: '/work', executable: 'bash' }), id: 'Enoise',
      operations: [], executables: [], parseStatus: 'unsupported_statement_operator', reasonCode: 'unsupported_statement_operator',
    })
    const result = certifyCheckpoint(projection, [{ itemId: 'R001', evidenceIds: ['Etest', 'Enoise'] }], 'C001')
    expect(result.status).toBe('incomplete')
    expect(result.rejectedBindings[0].reasonCode).toBe('evidence_matches_no_facet')
    expect(result.rejectedBindings[0].offendingEvidenceIds).toEqual(['Enoise'])
  })

  it('invalidates a certificate when the host lock changes', () => {
    const { projection, fixture } = projectionFor('pull')
    expect(certifyCheckpoint(projection, [completeBinding('pull', fixture)], 'C001').status).toBe('certified')
    projection.hostLockDigest = X3
    expect(hasCurrentCertificate(projection)).toBe(false)
    expect(projection.certificateStatusReason).toBe('stale_host_lock')
  })

  it('keeps legacy generic-run and unclassified authority items non-certifiable', () => {
    const projection = createProjection()
    const legacy = captureClause('install the plugin', 'm1', 'R001', 1, { cwd: '/work' })
    legacy.legacyFlags = ['legacy_generic_run', 'legacy_authority_unclassified']
    projection.items.set(legacy.id, legacy)
    projection.contractRevision = 1
    const result = certifyCheckpoint(projection, [{ itemId: 'R001', evidenceIds: ['E001'] }], 'C001')
    expect(result.rejectedBindings[0].reasonCode).toBe('legacy_authority_unclassified')
  })

  it('keeps newly captured generic-run items non-certifiable without a typed semantic action', () => {
    const projection = createProjection()
    const item = captureClause('run the requested command', 'm1', 'R001', 1, { cwd: '/work' })
    item.semanticAction = 'generic_run'
    item.requestedTarget = { scope: '/work' }
    projection.items.set(item.id, item)
    projection.contractRevision = 1
    projection.evidence.set('E001', evidence('E001', 'generic_run', 'effect', { scope: '/work', executable: 'bash' }))

    const result = certifyCheckpoint(projection, [{ itemId: 'R001', evidenceIds: ['E001'] }], 'C001')
    expect(result.status).toBe('incomplete')
    expect(result.rejectedBindings[0].reasonCode).toBe('generic_run_non_certifiable')
  })
})
