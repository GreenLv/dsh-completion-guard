import { describe, expect, it } from 'vitest'
import { deriveItemDiagnosis } from '../../src/domain/diagnostics.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { certifyCheckpoint } from '../../src/domain/checkpoint.js'
import { createProjection, type GuardEvidence, type GuardItem, type GuardProjection } from '../../src/domain/types.js'

/**
 * 0.6.1 W060-04 (plan V04): the required evidence roles come from the item's
 * OWN obligation contract, shared by prepare, diagnosis, producer, and
 * checkpoint. A stateful change needs resolution/effect/state; a read-only
 * verification needs ONE matching fact in the `effect` role — exactly what the
 * certifier's `simpleRecord` accepts. 0.6.0 demanded all three roles from
 * every obligation, which diagnosed a real read-only verification as missing
 * historical prestate evidence and told the caller to collect a change chain
 * that could never exist.
 */

function item(row: Partial<GuardItem> & { id: string; semanticAction: GuardItem['semanticAction'] }): GuardItem {
  return {
    revision: 1,
    kind: 'requirement',
    sourceMessageId: 'm2',
    normalizedText: `obligation ${row.id}`,
    textSha256: 'a'.repeat(64),
    status: 'pending',
    verification: { enforced: true, surface: 'scope', subject: '/repo' },
    requestedTarget: { scope: '/repo' },
    targetCaptureStatus: 'resolved',
    taskKind: 'action',
    // A captured verify clause always carries the explicit verify operation.
    ...(row.semanticAction === 'verify' ? { verification: { enforced: true, surface: 'scope' as const, subject: '/repo', operation: 'verify' as const } } : {}),
    ...row,
  }
}

function fact(row: Partial<GuardEvidence> & { id: string }): GuardEvidence {
  return {
    epoch: 0,
    callId: `call-${row.id}`,
    rootCallId: `call-${row.id}`,
    toolName: 'bash',
    toolResultSeq: 3,
    outcome: 'success',
    capabilities: ['shell'],
    subjects: ['/repo'],
    surfaces: ['scope'],
    boundedSummarySha256: 'b'.repeat(64),
    parseStatus: 'supported',
    adapterId: 'dsh.bash.v1',
    adapterVersion: '1.0.0',
    resolvedTarget: { scope: '/repo' },
    ...row,
  }
}

function projection(): GuardProjection {
  const p = createProjection()
  p.enabled = true
  return p
}

describe('0.6.1 W060-04: read-only verifications follow the single-fact contract', () => {
  it('a verify item with a matching effect-role fact is certifiable, never a historical gap', () => {
    const p = projection()
    p.items.set('R001', item({ id: 'R001', semanticAction: 'verify' }))
    p.evidence.set('E0001', fact({ id: 'E0001', semanticAction: 'verify', evidenceRole: 'effect', capabilities: ['verify'], operations: [{ op: 'verify' }] }))
    const diagnosis = deriveItemDiagnosis(p, p.items.get('R001')!)
    expect(diagnosis.reason_code).toBe('missing_evidence')
    expect(diagnosis.certification).toBe('needs_evidence')
    expect(diagnosis.repairability).toBe('agent_repairable')
    expect(diagnosis.missing_facets).toEqual([])
    expect(diagnosis.next_action.resume_condition).not.toContain('resolution/effect/state')
  })

  it('a verify item with no evidence asks for ONE fact, in the effect role', () => {
    const p = projection()
    p.items.set('R001', item({ id: 'R001', semanticAction: 'verify' }))
    const diagnosis = deriveItemDiagnosis(p, p.items.get('R001')!)
    expect(diagnosis.reason_code).toBe('missing_evidence')
    expect(diagnosis.missing_facets).toEqual(['effect'])
    expect(diagnosis.next_action.resume_condition).toBe('Collect the single matching durable verification fact, then checkpoint.')
  })

  it('a stateful commit item with only its effect is a historical gap, and the text refuses re-execution', () => {
    const p = projection()
    p.items.set('R001', item({ id: 'R001', semanticAction: 'commit', requestedTarget: { repository: '/repo' } }))
    p.evidence.set('E0001', fact({ id: 'E0001', semanticAction: 'commit', evidenceRole: 'effect', resolvedTarget: { repository: '/repo' } }))
    const diagnosis = deriveItemDiagnosis(p, p.items.get('R001')!)
    expect(diagnosis.reason_code).toBe('historical_evidence_gap')
    expect(diagnosis.repairability).toBe('historical_gap')
    expect(diagnosis.next_action.resume_condition).toContain('do not repeat the action')
  })

  it('a stateful commit item with no evidence asks for the full resolution/effect/state order', () => {
    const p = projection()
    p.items.set('R001', item({ id: 'R001', semanticAction: 'commit', requestedTarget: { repository: '/repo' } }))
    const diagnosis = deriveItemDiagnosis(p, p.items.get('R001')!)
    expect(diagnosis.missing_facets).toEqual(['resolution', 'effect', 'state'])
    expect(diagnosis.next_action.resume_condition).toContain('resolution/effect/state order')
  })

  it('prepare reports the same contract: one effect fact for read-only, three roles for stateful', async () => {
    const p = projection()
    p.items.set('R001', item({ id: 'R001', semanticAction: 'verify' }))
    p.items.set('R002', item({ id: 'R002', semanticAction: 'commit', requestedTarget: { repository: '/repo' } }))
    const tool = createPrepareTool({ getProjection: () => p })
    const readOnly = await tool.execute({ item_id: 'R001' } as never, undefined as never) as { required_evidence_order: string[] }
    expect(readOnly.required_evidence_order).toEqual(['effect (one matching durable verification fact)'])
    const stateful = await tool.execute({ item_id: 'R002' } as never, undefined as never) as { required_evidence_order: string[]; diagnosis: { missing_facets: string[] } }
    expect(stateful.required_evidence_order).toHaveLength(3)
    expect(stateful.diagnosis.missing_facets).toEqual(['resolution', 'effect', 'state'])
  })

  it('the certifier keeps accepting exactly one effect-role fact for a read-only verification', () => {
    const p = projection()
    p.items.set('R001', item({ id: 'R001', semanticAction: 'verify' }))
    p.evidence.set('E0001', fact({ id: 'E0001', semanticAction: 'verify', evidenceRole: 'effect', capabilities: ['verify'], operations: [{ op: 'verify' }] }))
    const result = certifyCheckpoint(p, [{
      itemId: 'R001',
      evidenceIds: ['E0001'],
      semanticAction: 'verify',
      requestedTarget: { scope: '/repo' },
      resolvedTarget: { scope: '/repo' },
      observedState: {},
      effectEvidenceId: 'E0001',
      expectedTransition: {
        predicateId: 'pred.verify.outcome', version: 1, predParamsKind: 'inline',
        parameters: { expected_outcome: { k: 'e' as const, v: 'success' }, min_matches: 1 },
      },
    }], 'C1', true)
    expect(result.status, JSON.stringify(result.rejectedBindings)).toBe('certified')
  })
})
