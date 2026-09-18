import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE, DEFAULT_DELEGATION_TOOL_NAMES } from '../../src/domain/derive.js'
import { certifyCheckpoint } from '../../src/domain/checkpoint.js'
import { ancestorConstraints, ancestorConstraintForBinding, certificateClosure, unitClosureItemIds } from '../../src/domain/closure.js'
import { evidenceAvailabilityReason } from '../../src/domain/diagnostics.js'
import { unitAncestorIds, unitDescendantIds, hasDelegationMarker } from '../../src/domain/work-unit.js'
import { sha256 } from '../../src/domain/canonicalize.js'
import { createProjection, type DerivedEnvelope, type EvidenceBinding, type GuardEvidence, type GuardItem, type GuardProjection, type TargetTuple } from '../../src/domain/types.js'
import { expectedParams, statefulTarget } from '../helpers/portable-conformance.js'

const config = { activation: 'always' as const }
const scope = { cwd: '/repo', sessionHeader: { version: 3, id: 'v060-unit-closure', createdAt: 1 } }

let seq = 0
const reset = () => { seq = 0 }
const notice = (): DerivedEnvelope => ({ seq: seq++, type: 'user/message', data: {
  source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' },
  content: [{ type: 'text', text: PROTOCOL_V5_NOTICE }],
} })
const turnStart = (turn: number): DerivedEnvelope => ({ seq: seq++, type: 'turn/start', data: { turn } })
const turnEnd = (turn: number, kind = 'completed'): DerivedEnvelope => ({ seq: seq++, type: 'turn/end', data: { turn, reason: { kind } } })
const user = (text: string, turn: number): DerivedEnvelope => ({ seq: seq++, type: 'user/message', data: {
  turn, source: { kind: 'user' }, content: [{ type: 'text', text }],
} })
const assistant = (turn: number, step: number, text: string): DerivedEnvelope => ({ seq: seq++, type: 'assistant/message', data: {
  turn, step, message: { role: 'assistant', content: [{ type: 'text', text }] },
} })
const toolCall = (callId: string, name: string, args: unknown): DerivedEnvelope => ({ seq: seq++, type: 'tool/call', data: { callId, name, arguments: JSON.stringify(args) } })
const toolResult = (callId: string, payload: unknown, isError = false): DerivedEnvelope => ({ seq: seq++, type: 'tool/result', data: {
  message: { source: { callId }, content: [{ type: 'tool-result', toolCallId: callId, isError: false, content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }] }] },
  ...(isError ? { error: { name: 'x', code: 'Y' } } : {}),
} })

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * A three-role `push` closure produced through the PRODUCTION evidence parser:
 * the events are ordinary `context_guard_evidence` round-trips carrying the
 * adapter meta, so the checkpoint path under test sees exactly the facts a live
 * session would produce — no hand-built `GuardEvidence` literals.
 */
const PUSH_MESSAGE = 'Push repository /repo to remote origin refspec refs/heads/main:refs/heads/main.'
type PushRole = 'resolution' | 'effect' | 'state'

/**
 * Two independent three-role `push` closures, produced through the PRODUCTION
 * evidence parser in ONE derivation so the evidence ids are unique: the events
 * are ordinary `context_guard_evidence` round-trips carrying the adapter meta,
 * so the checkpoint path under test sees exactly the facts a live session would
 * produce — no hand-built `GuardEvidence` literals.
 */
let cachedPush: { resolved: TargetTuple; observed: TargetTuple; facts: GuardEvidence[]; ids: Record<'a' | 'b', Record<PushRole, string>> } | undefined
function pushEvidence() {
  if (cachedPush) return cachedPush
  const requested = { repository: '/repo', remote: 'origin', refspec: 'refs/heads/main:refs/heads/main' }
  const shape = statefulTarget('push', requested)
  const transition = {
    predicateId: 'pred.push.v1', version: 1, predParamsKind: 'inline' as const,
    parameters: expectedParams('push', shape.resolved, shape.observed),
  }
  const events: DerivedEnvelope[] = []
  let localSeq = 0
  const callIds: Array<{ key: 'a' | 'b'; role: PushRole; callId: string }> = []
  const structured = (key: 'a' | 'b', role: PushRole, observed?: TargetTuple, extra?: Record<string, unknown>) => {
    const callId = `push-${key}-${role}`
    callIds.push({ key, role, callId })
    events.push({ seq: localSeq++, type: 'tool/call', data: {
      callId, name: 'context_guard_evidence', arguments: JSON.stringify({ semantic_action: 'push', evidence_role: role }),
    } })
    events.push({ seq: localSeq++, type: 'tool/result', data: {
      message: { source: { callId }, content: [{ type: 'tool-result', toolCallId: callId, isError: false, content: [{ type: 'text', text: '{}' }] }] },
      meta: { contextGuard: {
        adapterId: 'context-guard.git.v1', adapterVersion: '1.0.0', semanticAction: 'push', evidenceRole: role,
        resolvedTarget: shape.resolved, ...(observed ? { observedState: observed } : {}), ...extra,
      } },
    } })
  }
  for (const key of ['a', 'b'] as const) {
    structured(key, 'resolution', undefined, { expectedTransition: transition, expectedTransitionDigest: sha256(stable(transition)) })
    structured(key, 'effect')
    structured(key, 'state', shape.observed)
  }
  const facts = [...deriveProjection(events, config, scope, true).projection.evidence.values()]
  const byCallId = new Map(facts.map((fact) => [fact.callId, fact.id]))
  const ids = { a: {} as Record<PushRole, string>, b: {} as Record<PushRole, string> }
  for (const entry of callIds) ids[entry.key][entry.role] = byCallId.get(entry.callId)!
  cachedPush = { resolved: shape.resolved, observed: shape.observed, facts, ids }
  return cachedPush
}

function pushItem(id: string, unitId: string | undefined, overrides: Partial<GuardItem> = {}): GuardItem {
  return {
    id, revision: 1, kind: 'requirement', sourceMessageId: 'm2', normalizedText: PUSH_MESSAGE,
    textSha256: 'a'.repeat(64), status: 'pending',
    ...(unitId !== undefined ? { unitId } : {}),
    verification: { enforced: true, surface: 'scope', subject: '/repo' },
    semanticAction: 'push', requestedTarget: { repository: '/repo', remote: 'origin', refspec: 'refs/heads/main:refs/heads/main' },
    targetCaptureStatus: 'resolved', taskKind: 'action', authority: 'root_instruction',
    ...overrides,
  } as GuardItem
}

/** A v5 projection with the given unit lineage, items, and production push facts. */
function projectionWithUnits(
  units: Array<{ unitId: string; parentUnitId?: string }>,
  items: GuardItem[],
  currentUnitId = units[units.length - 1]!.unitId,
): GuardProjection {
  const p = createProjection()
  p.enabled = true
  p.boundaryProtocol = 5
  for (const unit of units) {
    p.units.set(unit.unitId, {
      unitId: unit.unitId, openedAtSeq: 2, rootInputRefs: [{ seq: 2 }], headline: unit.unitId,
      ...(unit.parentUnitId !== undefined ? { parentUnitId: unit.parentUnitId } : {}),
    })
  }
  p.currentUnitId = currentUnitId
  for (const item of items) p.items.set(item.id, item)
  for (const fact of pushEvidence().facts) p.evidence.set(fact.id, fact)
  return p
}


function pushBinding(itemId: string, key: 'a' | 'b' = 'a'): EvidenceBinding {
  const built = pushEvidence()
  const ids = built.ids[key]
  return {
    itemId,
    evidenceIds: [ids.resolution, ids.effect, ids.state],
    semanticAction: 'push',
    requestedTarget: { repository: '/repo', remote: 'origin', refspec: 'refs/heads/main:refs/heads/main' },
    resolvedTarget: built.resolved,
    observedState: built.observed,
    expectedTransition: { predicateId: 'pred.push.v1', version: 1, predParamsKind: 'inline', parameters: expectedParams('push', built.resolved, built.observed) },
    resolutionEvidenceId: ids.resolution,
    effectEvidenceId: ids.effect,
    stateEvidenceIds: [ids.state],
  }
}

describe('0.6.0 C04: delegation linkage opens a required descendant unit', () => {
  it('a delegation-marked root message opens a child unit and the parent keeps the certified scope', () => {
    reset()
    const events = [
      notice(),
      turnStart(1),
      user('创建 report.txt', 1),
      assistant(1, 1, '好的。'),
      turnEnd(1),
      turnStart(2),
      user('让子代理去创建 notes.txt', 2),
      assistant(2, 1, '已委派。'),
      turnEnd(2),
    ]
    const { projection } = deriveProjection(events, config, scope, true)
    expect(projection.units.size).toBe(2)
    // The child is a descendant, and the PARENT stays the current unit: the
    // parent's own work is never dropped because it delegated a sub-task.
    expect(projection.currentUnitId).toBe('U001')
    expect(projection.units.get('U002')?.parentUnitId).toBe('U001')
    expect(projection.units.get('U001')?.switchedAwayAtSeq).toBeUndefined()
    expect(unitAncestorIds(projection, 'U002')).toEqual(['U001'])
    expect(unitDescendantIds(projection, 'U001')).toEqual(['U002'])
    // The child's obligation is required work of the parent's closure...
    const childItems = [...projection.items.values()].filter((item) => item.unitId === 'U002')
    expect(childItems).toHaveLength(1)
    expect(unitClosureItemIds(projection, 'U001')).toEqual(expect.arrayContaining([childItems[0]!.id]))
    // ...and the closure certified right now is that same parent closure.
    const closure = certificateClosure(projection)
    expect(closure.unitId).toBe('U001')
    expect(closure.itemIds).toEqual(expect.arrayContaining([childItems[0]!.id]))
  })

  it('an ordinary task switch opens a sibling that never blocks the newer unit', () => {
    reset()
    const events = [
      notice(),
      turnStart(1),
      user('创建 report.txt', 1),
      assistant(1, 1, '好的。'),
      turnEnd(1),
      turnStart(2),
      user('另外，更新皮肤中心', 2),
      assistant(2, 1, '明白。'),
      turnEnd(2),
    ]
    const { projection } = deriveProjection(events, config, scope, true)
    expect(projection.currentUnitId).toBe('U002')
    expect(projection.units.get('U002')?.parentUnitId).toBeUndefined()
    expect(unitDescendantIds(projection, 'U001')).toEqual([])
    // A switched-away sibling's residual work never blocks the newer unit.
    expect(unitClosureItemIds(projection, 'U002')).not.toEqual(unitClosureItemIds(projection, 'U001'))
  })

  it('the delegation vocabulary is closed: a subagent mention without an act never opens a unit', () => {
    for (const text of ['子代理是什么？', 'the subagent is unavailable', 'update the subagent docs']) {
      expect(hasDelegationMarker(text), text).toBe(false)
    }
    for (const text of ['让子代理去排查', 'delegate this to a subagent', 'spawn a subagent to check']) {
      expect(hasDelegationMarker(text), text).toBe(true)
    }
  })
})

describe('0.6.0 C04: a parent is not certified while a required descendant is open', () => {
  it('certifying the parent requires the child unit obligations too', () => {
    const p = projectionWithUnits([{ unitId: 'U001' }, { unitId: 'U002', parentUnitId: 'U001' }], [pushItem('R001', 'U001'), pushItem('R002', 'U002')], 'U001')
    expect(unitClosureItemIds(p, 'U001')).toEqual(['R001', 'R002'])
    // Binding only the parent's own obligation leaves the required descendant
    // open: the parent cannot close early.
    const partial = certifyCheckpoint(p, [pushBinding('R001')], 'C1', false)
    expect(partial.status).toBe('incomplete')
    expect(partial.openItems).toEqual(['R001', 'R002'])
    // Waiting for the descendant alone is not enough either: the whole closure
    // is reported, and the parent obligation is still unbound.
    const childOnly = certifyCheckpoint(p, [pushBinding('R002')], 'C1', false)
    expect(childOnly.status).toBe('incomplete')
    expect(childOnly.openItems).toEqual(['R001', 'R002'])
    // Both obligations together certify; each cites its own distinct facts, so
    // no evidence is reused across obligations.
    const complete = certifyCheckpoint(p, [pushBinding('R001', 'a'), pushBinding('R002', 'b')], 'C1', false)
    expect(complete.status, JSON.stringify(complete.rejectedBindings)).toBe('certified')
  })

  it('a delegated subagent result is bounded evidence and never closes the parent item', () => {
    reset()
    const events = [
      notice(),
      turnStart(1),
      user('创建 report.txt', 1),
      toolCall('d1', 'subagent', { prompt: 'create report.txt' }),
      toolResult('d1', { status: 'completed', artifact_id: '/repo/report.txt' }),
      turnEnd(1),
    ]
    const { projection } = deriveProjection(events, config, scope, true)
    expect(DEFAULT_DELEGATION_TOOL_NAMES).toContain('subagent')
    const delegated = [...projection.evidence.values()].filter((fact) => fact.delegatedSubtask)
    expect(delegated).toHaveLength(1)
    // A delegated fact is recorded, visible, and never an availability source.
    expect(evidenceAvailabilityReason(delegated[0]!)).toBe('delegated_result_bounded')
    // The owning unit records the linkage for audit.
    expect(projection.units.get('U001')?.delegationRefs).toEqual([
      { callId: 'd1', resultSeq: expect.any(Number), toolName: 'subagent', status: 'completed' },
    ])
    // The create obligation the subagent "handled" is still open.
    expect([...projection.items.values()].every((item) => item.status === 'pending')).toBe(true)
  })

  it('a failed delegated round-trip is recorded as failed and stays bounded', () => {
    reset()
    const events = [
      notice(),
      turnStart(1),
      user('创建 report.txt', 1),
      toolCall('d1', 'delegate_task', { prompt: 'create report.txt' }),
      toolResult('d1', 'boom', true),
      turnEnd(1),
    ]
    const { projection } = deriveProjection(events, config, scope, true)
    expect(projection.units.get('U001')?.delegationRefs?.[0]).toMatchObject({ toolName: 'delegate_task', status: 'failed' })
  })

  it('an ordinary (non-delegation) tool result is never marked bounded', () => {
    reset()
    const events = [
      notice(),
      turnStart(1),
      user('创建 report.txt', 1),
      toolCall('b1', 'bash', { command: 'touch report.txt' }),
      toolResult('b1', 'created'),
      turnEnd(1),
    ]
    const { projection } = deriveProjection(events, config, scope, true)
    expect([...projection.evidence.values()].some((fact) => fact.delegatedSubtask)).toBe(false)
  })
})

describe('0.6.0 C04: ancestor constraints stay in force for descendants', () => {
  it('an ancestor prohibition blocks certifying a descendant obligation on the same action and target', () => {
    const ban = pushItem('P001', 'U001', { kind: 'prohibition' })
    const item = pushItem('R002', 'U002')
    const withBan = projectionWithUnits([{ unitId: 'U001' }, { unitId: 'U002', parentUnitId: 'U001' }], [ban, item], 'U002')
    expect(ancestorConstraints(withBan, 'U002')).toEqual([
      { constraintId: 'P001', constraintUnitId: 'U001', itemId: 'R002', kind: 'prohibition', reasonCode: 'ancestor_prohibition_active' },
    ])
    expect(ancestorConstraintForBinding(withBan, item, item.requestedTarget)?.reasonCode).toBe('ancestor_prohibition_active')
    const rejected = certifyCheckpoint(withBan, [pushBinding('R002')], 'C1', false)
    expect(rejected.status).toBe('incomplete')
    expect(rejected.rejectedBindings[0]).toMatchObject({ itemId: 'R002', reasonCode: 'ancestor_prohibition_active' })

    // The ban applies only on its own action/target identity.
    const other = pushItem('R003', 'U003', { requestedTarget: { repository: '/other', remote: 'origin', refspec: 'refs/heads/main:refs/heads/main' } })
    const scoped = projectionWithUnits(
      [{ unitId: 'U001' }, { unitId: 'U003', parentUnitId: 'U001' }],
      [ban, other], 'U003',
    )
    expect(ancestorConstraintForBinding(scoped, other, { repository: '/other' })).toBeUndefined()
  })

  it('a blanket ancestor prohibition without a named identity blocks any descendant binding of that action', () => {
    const ban = pushItem('P001', 'U001', { kind: 'prohibition', requestedTarget: {} })
    const item = pushItem('R002', 'U002')
    const p = projectionWithUnits([{ unitId: 'U001' }, { unitId: 'U002', parentUnitId: 'U001' }], [ban, item], 'U002')
    expect(ancestorConstraintForBinding(p, item, item.requestedTarget)?.reasonCode).toBe('ancestor_prohibition_active')
  })

  it('an ancestor unsatisfied condition reserves the action for its descendants', () => {
    const reserved = pushItem('R001', 'U001', {
      authorityDisposition: 'conditional_wait', condition: '收到我的确认',
      waitAuthorization: { kind: 'root_explicit_wait', id: 'wait-push' },
    })
    const item = pushItem('R002', 'U002')
    const p = projectionWithUnits([{ unitId: 'U001' }, { unitId: 'U002', parentUnitId: 'U001' }], [reserved, item], 'U002')
    expect(ancestorConstraints(p, 'U002')[0]).toMatchObject({ kind: 'condition', reasonCode: 'ancestor_condition_unsatisfied' })
    const rejected = certifyCheckpoint(p, [pushBinding('R002')], 'C1', false)
    expect(rejected.rejectedBindings[0]).toMatchObject({ itemId: 'R002', reasonCode: 'ancestor_condition_unsatisfied' })

    // Once the reservation is released the descendant certifies normally.
    reserved.status = 'superseded'
    const released = certifyCheckpoint(p, [pushBinding('R002')], 'C1', false)
    expect(released.status, JSON.stringify(released.rejectedBindings)).toBe('certified')
  })

  it('a ban in a sibling unit is not an ancestor constraint', () => {
    const ban = pushItem('P001', 'U001', { kind: 'prohibition' })
    const item = pushItem('R002', 'U002')
    const p = projectionWithUnits([{ unitId: 'U001' }, { unitId: 'U002' }], [ban, item], 'U002')
    expect(ancestorConstraints(p, 'U002')).toEqual([])
    const result = certifyCheckpoint(p, [pushBinding('R002')], 'C1', false)
    expect(result.status, JSON.stringify(result.rejectedBindings)).toBe('certified')
  })

  it('ancestor constraints never apply to a legacy session without units', () => {
    const ban = pushItem('P001', 'U001', { kind: 'prohibition' })
    const item = pushItem('R002', 'U002')
    const p = projectionWithUnits([{ unitId: 'U001' }, { unitId: 'U002', parentUnitId: 'U001' }], [ban, item], 'U002')
    // Dropping the v5 boundary makes the whole closure session-level again, so
    // units (and therefore ancestor lineage) are not consulted.
    p.boundaryProtocol = undefined
    expect(ancestorConstraints(p, 'U002')).toEqual([])
    expect(ancestorConstraintForBinding(p, item, item.requestedTarget)).toBeUndefined()
  })
})

describe('0.6.0 C04: pre-v5 migration protection is retained', () => {
  it('an item captured before the v5 boundary keeps the whole-session closure and no unit', () => {
    const p = projectionWithUnits([{ unitId: 'U001' }], [pushItem('R001', undefined), pushItem('R002', 'U001')], 'U001')
    const closure = certificateClosure(p)
    // The pre-v5 obligation is never dropped from the certified scope, and the
    // current unit's closure is included alongside it.
    expect(closure.itemIds).toEqual(expect.arrayContaining(['R001', 'R002']))
    expect(unitClosureItemIds(p, 'U001')).toEqual(['R002'])
  })

  it('a legacy session certifies the whole session and never consults units', () => {
    const p = projectionWithUnits([{ unitId: 'U001' }], [pushItem('R001', undefined)], 'U001')
    p.boundaryProtocol = undefined
    expect(certificateClosure(p)).toEqual({ itemIds: ['R001'] })
  })
})
