import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { certifyCheckpoint } from '../../src/domain/checkpoint.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope, type EvidenceBinding, type GuardEvidence, type GuardItem, type GuardProjection } from '../../src/domain/types.js'

const scope = { cwd: '/repo', sessionHeader: { version: 3, id: 'v060-policy', createdAt: 1 } }

let seq = 0
const v5Notice = (): DerivedEnvelope => ({ seq: seq++, type: 'user/message', data: {
  source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' },
  content: [{ type: 'text', text: PROTOCOL_V5_NOTICE }],
} })

/** A scope-verification requirement whose readback the user explicitly asked for. */
function scopeItem(): GuardItem {
  return {
    id: 'R001', revision: 1, kind: 'requirement', sourceMessageId: 'm2', normalizedText: '验证 scope',
    textSha256: 'a'.repeat(64), status: 'pending',
    verification: { enforced: true, surface: 'scope', subject: '/repo', operation: 'verify' },
    semanticAction: 'verify', requestedTarget: { scope: '/repo' }, targetCaptureStatus: 'resolved',
    taskKind: 'action', authority: 'root_instruction',
  } as GuardItem
}

/**
 * A fact that STANDARD accepts — it carries the verifying capability, the
 * declared scope surface, and the subject — but which never performed a read or
 * verify operation. It is the exact shape strict must reject.
 */
function capabilityOnlyEvidence(): GuardEvidence {
  return {
    id: 'E0001', epoch: 0, callId: 'call-1', rootCallId: 'call-1', toolName: 'bash', toolResultSeq: 5,
    outcome: 'success', capabilities: ['verify'], subjects: ['/repo'], surfaces: ['scope'],
    boundedSummarySha256: 'b'.repeat(64), operations: [],
    semanticAction: 'verify', evidenceRole: 'effect', resolvedTarget: { scope: '/repo' }, observedState: {},
    parseStatus: 'supported',
  }
}

/** The same fact, but it actually performed the readback the user asked for. */
function readbackEvidence(): GuardEvidence {
  return { ...capabilityOnlyEvidence(), operations: [{ op: 'verify', path: '/repo' }] }
}

function binding(itemId = 'R001', evidenceId = 'E0001'): EvidenceBinding {
  return {
    itemId, evidenceIds: [evidenceId], semanticAction: 'verify',
    requestedTarget: { scope: '/repo' }, resolvedTarget: { scope: '/repo' }, observedState: {},
    effectEvidenceId: evidenceId,
    expectedTransition: {
      predicateId: 'pred.verify.outcome', version: 1, predParamsKind: 'inline',
      parameters: { expected_outcome: { k: 'e', v: 'success' }, min_matches: 1 },
    },
  }
}

function projectionWithPolicy(policy: 'standard' | 'strict' | 'release', facts: GuardEvidence[], items: GuardItem[] = [scopeItem()]): GuardProjection {
  const p = createProjection()
  p.enabled = true
  p.policy = policy
  p.boundaryProtocol = 5
  p.currentUnitId = 'U001'
  p.units.set('U001', { unitId: 'U001', openedAtSeq: 2, rootInputRefs: [{ seq: 2 }], headline: 'U001' })
  for (const item of items) {
    p.items.set(item.id, { ...item, unitId: 'U001' })
  }
  for (const fact of facts) p.evidence.set(fact.id, fact)
  return p
}

describe('0.6.0 C06: strict is a proof tier, not an extra approval', () => {
  it('standard accepts the verifying capability; strict demands the real readback', () => {
    const standard = certifyCheckpoint(projectionWithPolicy('standard', [capabilityOnlyEvidence()]), [binding()], 'C1', false)
    expect(standard.status, JSON.stringify(standard.rejectedBindings)).toBe('certified')

    const strict = certifyCheckpoint(projectionWithPolicy('strict', [capabilityOnlyEvidence()]), [binding()], 'C1', false)
    expect(strict.status).toBe('incomplete')
    expect(strict.rejectedBindings[0]).toMatchObject({ itemId: 'R001', reasonCode: 'strict_proof_required' })

    // The same obligation certifies under strict once the fact performed the
    // readback the user asked for.
    const satisfied = certifyCheckpoint(projectionWithPolicy('strict', [readbackEvidence()]), [binding()], 'C1', false)
    expect(satisfied.status, JSON.stringify(satisfied.rejectedBindings)).toBe('certified')
  })

  it('strict does not change ordinary action authorization', () => {
    // The same mutation decision under both tiers: strict adds no approval for
    // an ordinary action, and the release tier does not implicitly apply to a
    // non-release action either.
    const request = { action: 'modify' as const, contractItemId: 'R002', contractItemRevision: 1, resolvedTarget: { artifact_id: '/repo/a.md', scope: '/repo' } }
    const modifyItem = {
      id: 'R002', revision: 1, kind: 'requirement', sourceMessageId: 'm2', normalizedText: '更新文档',
      textSha256: 'c'.repeat(64), status: 'pending', unitId: 'U001',
      verification: { enforced: true, surface: 'artifact', subject: '/repo' },
      semanticAction: 'modify', requestedTarget: { scope: '/repo', artifact_type: 'document' },
      targetCaptureStatus: 'resolved', taskKind: 'action', authority: 'root_instruction',
      // A hand-built CURRENT item carries the 0.6.3 qualification production
      // capture would have written; a record without one is refused.
      executionQualification: { status: 'granted', reason: 'plain_instruction' },
    } as GuardItem
    const decisions = (['standard', 'strict', 'release'] as const).map((policy) =>
      authorizeMutationFromProjection(projectionWithPolicy(policy, [], [modifyItem]), request))
    expect(new Set(decisions.map((decision) => `${decision.status}:${decision.reasonCode}`)).size).toBe(1)
    expect(decisions[0]).toMatchObject({ status: 'authorized', reasonCode: 'mutation_root_contract_authorized' })
  })

  it('activation and policy stay orthogonal and installing never enters release', () => {
    seq = 0
    const derived = deriveProjection([v5Notice()], { activation: 'opt-in', policy: undefined }, scope, true).projection
    expect(derived.policy).toBe('standard')
    seq = 0
    const release = deriveProjection([v5Notice()], { activation: 'always', policy: 'release' }, scope, true).projection
    // Entering the release tier grants nothing by itself: the gate still needs
    // an explicitly adopted contract for the operation.
    expect(release.policy).toBe('release')
    expect(release.releaseContracts).toEqual([])
  })

  it('strict applies only to the surfaces the user actually requested', () => {
    // An artifact surface obligation is unaffected by strict: the tier never
    // invents a new proof requirement for an ordinary action.
    const artifactItem = {
      ...scopeItem(),
      verification: { enforced: true, surface: 'artifact', subject: '/repo', operation: 'verify' },
    } as GuardItem
    const facts = [readbackEvidence()]
    const strict = certifyCheckpoint(projectionWithPolicy('strict', facts, [artifactItem]), [binding()], 'C1', false)
    const standard = certifyCheckpoint(projectionWithPolicy('standard', facts, [artifactItem]), [binding()], 'C1', false)
    expect(strict.status).toBe(standard.status)
  })
})
