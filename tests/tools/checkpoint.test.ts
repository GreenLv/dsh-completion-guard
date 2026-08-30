import { describe, expect, it } from 'vitest'
import { createCheckpointTool } from '../../src/tools/checkpoint.js'
import { createProjection } from '../../src/domain/types.js'
import { createBoundaryTool } from '../../src/tools/boundary.js'
import { captureClause } from '../../src/domain/capture.js'
import { sha256 } from '../../src/domain/canonicalize.js'

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(',')}}`
  return JSON.stringify(value)
}

describe('checkpoint tool registration', () => {
  it('instantiates against the DSH value-schema DSL without throwing', () => {
    const projection = createProjection()
    expect(() => createCheckpointTool(() => projection, () => {})).not.toThrow()
  })

  it('flushes before checkpointing and does not mutate authority before the tool result persists', async () => {
    const projection = createProjection()
    projection.enabled = true
    let prepared = 0
    const tool = createCheckpointTool(() => projection, () => {}, async () => { prepared += 1; return true })
    const result = await tool.execute({ bindings: [] }, undefined as never) as { status: string; certificate?: object }
    expect(prepared).toBe(1)
    expect(result.status).toBe('certified')
    expect(result.certificate).toBeDefined()
    expect(projection.checkpoints).toHaveLength(0)
  })

  it('keeps a boundary candidate non-authoritative until host persistence and replay', async () => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause('等待用户选择后继续', 'm1', 'R001', 1)
    item.waitAuthorization = { kind: 'root_explicit_wait', id: 'wait:R001' }
    projection.items.set(item.id, item)
    const tool = createBoundaryTool(() => projection, async () => true, () => {})
    const result = await tool.execute({
      disposition: 'user_wait', qualification_kind: 'root_explicit_wait', qualification_ids: ['wait:R001'],
    }, undefined as never) as { status: string }
    expect(result.status).toBe('accepted')
    expect(projection.boundaries).toHaveLength(0)
  })

  it('returns a bounded binding template that alone closes the next checkpoint call', async () => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause('Run pnpm test in /repo', 'm1', 'R001', 1, { cwd: '/repo' })
    item.semanticAction = 'test'
    item.requestedTarget = { scope: '/repo' }
    projection.items.set(item.id, item)
    projection.contractRevision = 1
    projection.evidence.set('E0001', {
      id: 'E0001', epoch: 0, callId: 'call-test', rootCallId: 'call-test', toolName: 'bash', toolResultSeq: 3,
      outcome: 'success', capabilities: ['shell', 'deterministic-check'], subjects: ['/repo'], surfaces: ['scope'],
      boundedSummarySha256: '11'.repeat(32), executables: ['pnpm'], operations: [{ op: 'run', path: '/repo' }],
      semanticAction: 'test', evidenceRole: 'effect', resolvedTarget: { scope: '/repo', executable: 'pnpm' }, observedState: {},
      parseStatus: 'supported', adapterId: 'dsh.bash.v1', adapterVersion: '1.0.0',
    })
    const tool = createCheckpointTool(() => projection, () => {}, async () => true)
    const first = await tool.execute({ bindings: [] }, undefined as never) as {
      status: string
      open_items: Array<{ binding_template?: Record<string, unknown> }>
      available_evidence: Array<Record<string, unknown>>
    }
    expect(first.status).toBe('incomplete')
    expect(first.available_evidence[0]).toMatchObject({
      id: 'E0001', call_id: 'call-test', evidence_role: 'effect',
      resolved_target: { scope: '/repo', executable: 'pnpm' }, observed_state: {}, adapter_disposition: 'citable',
    })
    const template = first.open_items[0].binding_template
    expect(template).toBeDefined()
    const second = await tool.execute({ bindings: [template!] } as never, undefined as never) as { status: string; certificate?: object }
    expect(second.status).toBe('certified')
    expect(second.certificate).toBeDefined()
  })

  it('copies a stateful predicate only from resolution evidence and never backfills it from observed state', async () => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause('create /repo/output.txt', 'm1', 'R001', 1, { cwd: '/repo' })
    const resolved = { artifact_id: '/repo/output.txt', scope: '/repo', pre_digest: 'absent', change_set_digest: '11'.repeat(32) }
    const expectedTransition = {
      predicateId: 'pred.create.v1', version: 1, predParamsKind: 'inline' as const,
      parameters: { post_digest: '22'.repeat(32) },
    }
    projection.items.set(item.id, item)
    projection.contractRevision = 1
    projection.evidence.set('E-res', {
      id: 'E-res', epoch: 0, callId: 'resolution', rootCallId: 'resolution', toolName: 'context_guard_evidence', toolResultSeq: 1,
      outcome: 'success', capabilities: ['guard-stateful-observation'], subjects: ['/repo/output.txt'], surfaces: ['artifact'],
      boundedSummarySha256: '11'.repeat(32), semanticAction: 'create', evidenceRole: 'resolution', resolvedTarget: resolved,
      expectedTransition, expectedTransitionDigest: sha256(stable(expectedTransition)),
      parseStatus: 'supported', adapterId: 'context-guard.artifact.v1', adapterVersion: '1.0.0',
    })
    projection.evidence.set('E-eff', {
      id: 'E-eff', epoch: 0, callId: 'effect', rootCallId: 'effect', toolName: 'context_guard_evidence', toolResultSeq: 2,
      outcome: 'success', capabilities: ['guard-stateful-observation'], subjects: ['/repo/output.txt'], surfaces: ['artifact'],
      boundedSummarySha256: '22'.repeat(32), semanticAction: 'create', evidenceRole: 'effect', resolvedTarget: resolved,
      parseStatus: 'supported', adapterId: 'context-guard.artifact.v1', adapterVersion: '1.0.0',
    })
    projection.evidence.set('E-state', {
      id: 'E-state', epoch: 0, callId: 'state', rootCallId: 'state', toolName: 'context_guard_evidence', toolResultSeq: 3,
      outcome: 'success', capabilities: ['independent-state-readback'], subjects: ['/repo/output.txt'], surfaces: ['artifact'],
      boundedSummarySha256: '33'.repeat(32), semanticAction: 'create', evidenceRole: 'state', resolvedTarget: resolved,
      observedState: { post_digest: '22'.repeat(32) },
      parseStatus: 'supported', adapterId: 'context-guard.artifact.v1', adapterVersion: '1.0.0',
    })
    const tool = createCheckpointTool(() => projection, () => {}, async () => true)
    const first = await tool.execute({ bindings: [] }, undefined as never) as {
      open_items: Array<{ binding_template?: Record<string, unknown> }>
      available_evidence: Array<Record<string, unknown>>
    }
    const template = first.open_items[0].binding_template!
    expect(template.expected_transition).toEqual({
      predicate_id: 'pred.create.v1', version: 1, pred_params_kind: 'inline',
      parameters: { post_digest: '22'.repeat(32) },
    })
    expect(first.available_evidence.find((row) => row.id === 'E-res')).toMatchObject({
      expected_transition_digest: sha256(stable(expectedTransition)),
    })

    projection.evidence.get('E-state')!.observedState = { post_digest: '44'.repeat(32) }
    const changed = await tool.execute({ bindings: [] }, undefined as never) as { open_items: Array<{ binding_template?: Record<string, unknown> }> }
    expect(changed.open_items[0].binding_template?.expected_transition).toEqual(template.expected_transition)
    projection.evidence.get('E-state')!.observedState = { post_digest: '22'.repeat(32) }

    const certified = await tool.execute({ bindings: [template] } as never, undefined as never) as { status: string }
    expect(certified.status).toBe('certified')
  })
})
