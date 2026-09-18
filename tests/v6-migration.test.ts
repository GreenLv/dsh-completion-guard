import { describe, expect, it } from 'vitest'
import { applyUpgradeEligibility, deriveProjection, PROTOCOL_V5_NOTICE, PROTOCOL_V6_NOTICE } from '../src/domain/derive.js'
import { captureClause } from '../src/domain/capture.js'
import { createProjection } from '../src/domain/types.js'
import { hasCurrentCertificate } from '../src/domain/goal-gate.js'

describe('v6 historical eligibility cut', () => {
  it('reviews qualified old generic, passed ordinary work and text wait before terminal filtering', () => {
    const p = createProjection()
    p.boundaryProtocol = 6
    p.v6BoundarySeq = 10
    p.contractRevision = 7
    const generic = captureClause('继续处理任务', 'm3:block:old', 'R001', 1, { cwd: '/work' })
    generic.semanticAction = 'generic_run'; generic.status = 'answered'
    generic.executionQualification = { status: 'granted', reason: 'plain_instruction' }
    const ordinary = captureClause('Modify /work/a.txt.', 'm4:block:old', 'R002', 1, { cwd: '/work' })
    ordinary.status = 'passed'; ordinary.executionQualification = { status: 'granted', reason: 'plain_instruction' }
    const wait = captureClause('完成后等我确认', 'm5:block:old', 'R003', 1, { cwd: '/work' })
    wait.status = 'answered'; wait.waitAuthorization = { kind: 'root_explicit_wait', id: 'wait:R003' }
    wait.executionQualification = { status: 'granted', reason: 'plain_instruction' }
    const current = captureClause('Modify /work/b.txt.', 'm12:block:new', 'R004', 1, { cwd: '/work' })
    current.executionQualification = { status: 'granted', reason: 'plain_instruction' }
    const pureInformation = captureClause('检查一下插件是否有更新吗？', 'm6:block:old', 'R005', 1, { cwd: '/work' })
    pureInformation.status = 'answered'
    for (const item of [generic, ordinary, wait, current, pureInformation]) p.items.set(item.id, item)
    applyUpgradeEligibility(p)
    expect(generic.needsReview?.reason).toBe('legacy_v6_generic_action')
    expect(ordinary.needsReview?.reason).toBe('legacy_v6_ordinary_certification')
    expect(wait.needsReview?.reason).toBe('legacy_v6_text_wait')
    expect(current.needsReview).toBeUndefined()
    expect(pureInformation.needsReview).toBeUndefined()
    expect(generic.status).toBe('answered')
    expect(ordinary.status).toBe('passed')
  })
  it('derives a v5-to-v6 cut from persisted notices and does not promote old generic work', () => {
    const notices = [PROTOCOL_V5_NOTICE, PROTOCOL_V6_NOTICE]
    const events = [
      { seq: 1, type: 'user/message', data: { source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text: notices[0] }] } },
      { seq: 2, type: 'turn/start', data: { turn: 1 } },
      { seq: 3, type: 'user/message', data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: '继续处理任务' }] } },
      { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      { seq: 5, type: 'user/message', data: { source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text: notices[1] }] } },
    ]
    const p = deriveProjection(events as never, { activation: 'always' }, { cwd: '/work' }, true).projection
    expect(p.boundaryProtocol).toBe(6)
    expect(p.v6BoundarySeq).toBe(5)
    expect([...p.items.values()].some((item) => item.semanticAction === 'generic_run' && item.needsReview?.reason === 'legacy_v6_generic_action')).toBe(true)
  })
  it('does not reuse a pre-v6 certificate as current Stop or Goal authority', () => {
    const p = createProjection()
    p.boundaryProtocol = 6; p.v6BoundarySeq = 10; p.currentUnitId = 'U001'; p.hostStatus = 'supported'
    p.checkpoints.push({ id: 'C-old', result: 'certified', certificateVersion: '2', unitId: 'U001',
      recordedAtSeq: 9, epoch: p.epoch, contractRevision: p.contractRevision,
      sessionRefDigest: p.sessionRefDigest, hostLockDigest: p.hostLockDigest } as never)
    expect(hasCurrentCertificate(p)).toBe(false)
    expect(p.certificateStatusReason).toBe('legacy_certificate_in_v6_session')
  })
  it('requires the v6 certificate to name the exact current Goal reference', () => {
    const p = createProjection()
    p.boundaryProtocol = 6; p.v6BoundarySeq = 10; p.currentUnitId = 'U001'
    p.hostStatus = 'supported'; p.integrity = 'valid'; p.rootLocatorIdentity = 'a'.repeat(64)
    p.coreV2 = { certifiable: true }
    p.currentGoalRef = { id: 'goal-current', revision: 2 }
    const checkpoint = { id: 'C-current', result: 'certified', certificateVersion: '4', unitId: 'U001',
      recordedAtSeq: 11, epoch: p.epoch, contractRevision: p.contractRevision,
      sessionRefDigest: p.sessionRefDigest, hostLockDigest: p.hostLockDigest,
      rootLocatorIdentity: p.rootLocatorIdentity, goalRef: { ...p.currentGoalRef } }
    p.checkpoints.push(checkpoint as never)
    expect(hasCurrentCertificate(p)).toBe(true)
    p.currentGoalRef = { id: 'goal-current', revision: 3 }
    expect(hasCurrentCertificate(p)).toBe(false)
    expect(p.certificateStatusReason).toBe('stale_goal_ref')
    p.currentGoalRef = { id: 'goal-other', revision: 2 }
    expect(hasCurrentCertificate(p)).toBe(false)
    expect(p.certificateStatusReason).toBe('stale_goal_ref')
    p.currentGoalRef = { ...checkpoint.goalRef }
    expect(hasCurrentCertificate(p)).toBe(true)
    p.rootLocatorIdentity = 'b'.repeat(64)
    expect(hasCurrentCertificate(p)).toBe(false)
    expect(p.certificateStatusReason).toBe('stale_root_locator_identity')
    p.rootLocatorIdentity = checkpoint.rootLocatorIdentity
    p.coreV2 = { certifiable: false }
    expect(hasCurrentCertificate(p)).toBe(false)
    expect(p.certificateStatusReason).toBe('current_closure_unmet')
  })
})
