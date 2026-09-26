import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { certifyCheckpoint } from '../../src/domain/checkpoint.js'
import { hasCurrentCertificate } from '../../src/domain/goal-gate.js'
import { certificateClosure, certifiableOpenItems } from '../../src/domain/closure.js'
import { createProjection, type DerivedEnvelope } from '../../src/domain/types.js'

const config = { activation: 'always' as const }
const scope = { cwd: '/repo', sessionHeader: { version: 3, id: 'v060-units', createdAt: 1 } }

let seq = 0
const notice = (): DerivedEnvelope => ({ seq: seq++, type: 'user/message', data: {
  source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice' },
  content: [{ type: 'text', text: PROTOCOL_V5_NOTICE }],
} })
const turnStart = (turn: number): DerivedEnvelope => ({ seq: seq++, type: 'turn/start', data: { turn } })
const turnEnd = (turn: number, kind = 'completed'): DerivedEnvelope => ({ seq: seq++, type: 'turn/end', data: { turn, reason: { kind } } })
const user = (text: string, turn: number): DerivedEnvelope => ({ seq: seq++, type: 'user/message', data: {
  turn, source: { kind: 'user' }, content: [{ type: 'text', text }],
} })
const assistant = (turn: number, step: number, text: string, interrupted?: true): DerivedEnvelope => ({ seq: seq++, type: 'assistant/message', data: {
  turn, step, interrupted, message: { role: 'assistant', content: [{ type: 'text', text }] },
} })
const reset = () => { seq = 0 }

describe('0.6.0 P2.1: work units, trusted delivery, and certificate v2', () => {
  it('a delivered inquiry closes as answered; the unit records the task', () => {
    reset()
    const events = [
      notice(),
      turnStart(1),
      user('检查一下插件是否有更新吗？', 1),
      assistant(1, 1, '已检查远端，本地插件 2.0.0 已是最新版本。'),
      turnEnd(1),
    ]
    const { projection, boundaryV5 } = deriveProjection(events, config, scope, true)
    expect(boundaryV5).toBe(true)
    expect(projection.boundaryProtocol).toBe(5)
    expect(projection.currentUnitId).toBe('U001')
    const items = [...projection.items.values()]
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ status: 'answered', unitId: 'U001', taskKind: 'inquiry' })
    expect(items[0]!.answeredBy).toMatchObject({ turn: 1 })
    // The delivered inquiry no longer blocks certification.
    expect(certifiableOpenItems(projection)).toHaveLength(0)
  })

  it('an aborted, errored, or interrupted turn never binds a delivery', () => {
    reset()
    const events = [
      notice(),
      turnStart(1),
      user('检查一下插件是否有更新吗？', 1),
      assistant(1, 1, '已检查远端，本地插件 2.0.0 已是最新版本。'),
      turnEnd(1, 'aborted'),
    ]
    const { projection } = deriveProjection(events, config, scope, true)
    expect([...projection.items.values()][0]!.status).toBe('pending')

    reset()
    const interruptedPrefix = [
      notice(),
      turnStart(1),
      user('检查一下插件是否有更新吗？', 1),
      assistant(1, 1, '正在检查远端…', true),
      assistant(1, 2, '检查完成：已是最新。'),
      turnEnd(1, 'aborted'),
    ]
    const aborted2 = deriveProjection(interruptedPrefix, config, scope, true)
    expect([...aborted2.projection.items.values()][0]!.status).toBe('pending')
  })

  it('a completed turn closes only the questions that turn asked, never execution items', () => {
    reset()
    const events = [
      notice(),
      turnStart(1),
      user('检查一下是否有更新吗？顺便创建 report.txt', 1),
      assistant(1, 1, '远端没有更新；report.txt 我来创建。'),
      turnEnd(1),
    ]
    const { projection } = deriveProjection(events, config, scope, true)
    const items = [...projection.items.values()]
    const inquiry = items.find((item) => item.taskKind === 'inquiry')
    const create = items.find((item) => item.semanticAction === 'create')
    expect(inquiry).toBeDefined()
    expect(create).toBeDefined()
    // Delivery closes the information span only; the execution span stays open.
    expect(inquiry!.status).toBe('answered')
    expect(create!.status).toBe('pending')
  })

  it('a finished unit hands over to the next one, and only an explicit marker switches early', () => {
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
    // The create work is still open in U001, but the explicit marker opened U002.
    expect(projection.units.size).toBe(2)
    expect(projection.currentUnitId).toBe('U002')
    expect(projection.units.get('U001')?.switchedAwayAtSeq).toBeDefined()
    const byUnit = (unitId: string) => [...projection.items.values()].filter((item) => item.unitId === unitId)
    expect(byUnit('U001').map((item) => item.semanticAction)).toEqual(['create'])
    expect(byUnit('U002').map((item) => item.semanticAction)).toEqual(['generic_run'])

    // Without the marker, a directive message while U001 is open stays in U001.
    reset()
    const affinity = [
      notice(),
      turnStart(1),
      user('创建 report.txt', 1),
      assistant(1, 1, '好的。'),
      turnEnd(1),
      turnStart(2),
      user('再创建 notes.txt', 2),
      assistant(2, 1, '好的。'),
      turnEnd(2),
    ]
    const joined = deriveProjection(affinity, config, scope, true)
    expect(joined.projection.units.size).toBe(1)
    expect([...joined.projection.items.values()].every((item) => item.unitId === 'U001')).toBe(true)
  })

  it('a v5 session certifies through a v2 unit-closure certificate and the Goal gate binds the unit', () => {
    const p = createProjection()
    p.enabled = true
    p.boundaryProtocol = 5
    p.currentUnitId = 'U001'
    p.items.set('R001', {
      id: 'R001', revision: 1, kind: 'requirement', sourceMessageId: 'm2', normalizedText: 'verify the scope',
      textSha256: 'a'.repeat(64), status: 'pending', unitId: 'U001',
      verification: { enforced: true, surface: 'scope', subject: '/repo', operation: 'verify' },
      semanticAction: 'verify', requestedTarget: { scope: '/repo' }, targetCaptureStatus: 'resolved',
      taskKind: 'action',
    })
    p.evidence.set('E0001', {
      id: 'E0001', epoch: 0, callId: 'call-1', rootCallId: 'call-1', toolName: 'bash', toolResultSeq: 3,
      outcome: 'success', capabilities: ['verify'], subjects: ['/repo'], surfaces: ['scope'],
      boundedSummarySha256: 'b'.repeat(64), operations: [{ op: 'verify' }], semanticAction: 'verify',
      evidenceRole: 'effect', resolvedTarget: { scope: '/repo' }, observedState: {}, parseStatus: 'supported',
    })
    const binding = {
      itemId: 'R001', evidenceIds: ['E0001'], semanticAction: 'verify' as const,
      requestedTarget: { scope: '/repo' }, resolvedTarget: { scope: '/repo' }, observedState: {},
      effectEvidenceId: 'E0001',
      expectedTransition: {
        predicateId: 'pred.verify.outcome', version: 1, predParamsKind: 'inline' as const,
        parameters: { expected_outcome: { k: 'e' as const, v: 'success' }, min_matches: 1 },
      },
    }
    const result = certifyCheckpoint(p, [binding], 'C1', true)
    expect(result.status, JSON.stringify(result.rejectedBindings)).toBe('certified')
    expect(result.checkpoint).toMatchObject({
      certificateVersion: '2', stopProtocolVersion: '3.0.0', unitId: 'U001',
    })
    expect(result.checkpoint!.unitClosureDigest).toBe(result.checkpoint!.openDigest)
    // A Goal completion against this unit passes the gate.
    p.currentGoalRef = { id: 'goal-1', revision: 1 }
    p.checkpoints[0]!.goalRef = { id: 'goal-1', revision: 1 }
    expect(hasCurrentCertificate(p)).toBe(true)
    // Switching the current unit invalidates the certificate for the new unit.
    p.currentUnitId = 'U002'
    expect(hasCurrentCertificate(p)).toBe(false)
    expect(p.certificateStatusReason).toBe('stale_unit_ref')
  })

  it('pre-v5 obligations stay inside the certified scope of an upgraded session', () => {
    // A pending item without a unit (captured before the v5 boundary) must
    // never be silently dropped from the certified closure.
    const p = createProjection()
    p.enabled = true
    p.boundaryProtocol = 5
    p.currentUnitId = 'U001'
    p.items.set('R001', {
      id: 'R001', revision: 1, kind: 'requirement', sourceMessageId: 'm2', normalizedText: 'legacy duty',
      textSha256: 'a'.repeat(64), status: 'pending',
      verification: { enforced: true, surface: 'scope', subject: '/repo' },
      semanticAction: 'generic_run', requestedTarget: { scope: '/repo' }, targetCaptureStatus: 'resolved',
      taskKind: 'action',
    })
    const closure = certificateClosure(p)
    expect(closure.itemIds).toEqual(['R001'])
  })

  it('a legacy session without a v5 boundary keeps version-1 certification', () => {
    reset()
    const events = [
      turnStart(1),
      user('创建 report.txt', 1),
      assistant(1, 1, '收到。'),
      turnEnd(1),
    ]
    const { projection, boundaryV5 } = deriveProjection(events, config, scope, true)
    expect(boundaryV5).toBe(false)
    expect(projection.boundaryProtocol).toBeUndefined()
    expect(projection.units.size).toBe(0)
    expect([...projection.items.values()][0]!.unitId).toBeUndefined()
    const closure = certificateClosure(projection)
    expect(closure.unitId).toBeUndefined()
    expect(closure.itemIds).toHaveLength(1)
  })
})
