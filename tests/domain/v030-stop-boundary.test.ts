import { describe, expect, it } from 'vitest'
import {
  decideTurnBoundary,
  observeAssistantOutcome,
} from '../../src/domain/stop-policy.js'
import {
  effectuateBoundary,
  isCurrentAcceptedBoundary,
  qualifyBoundary,
} from '../../src/domain/boundary.js'
import { createProjection } from '../../src/domain/types.js'
import { captureClause } from '../../src/domain/capture.js'
import { deriveProjection } from '../../src/domain/derive.js'
import { goalCompletionDenial } from '../../src/domain/goal-gate.js'

describe('v0.3 stop policy and typed boundary', () => {
  it('replays the exact Goal change shape without treating activation as durable', () => {
    const projection = deriveProjection([
      { seq: 0, type: 'command/run', data: { name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 1, type: 'goal/change', data: {
        kind: 'goal/change', version: 1, operation: 'create', roundsStarted: 0, createdAt: 1, updatedAt: 1,
        goal: { id: 'synthetic-goal', revision: 1, objective: 'synthetic objective', phase: 'active', maxGoalRounds: 3 },
      } },
    ], { activation: 'opt-in' }, {}, true).projection
    expect(projection.currentGoalRef).toEqual({ id: 'synthetic-goal', revision: 1 })
    expect(projection.currentGoalPhase).toBe('active')
    expect(projection.currentGoalActivation).toBe('disarmed')
  })

  it('denies Guard-owned completion under an unavailable host identity', () => {
    const projection = createProjection()
    projection.enabled = true
    projection.hostStatus = 'unavailable'
    projection.hostReasonCode = 'host_lock_missing'
    expect(goalCompletionDenial(projection, 'update_goal', { action: 'complete' })).toContain('host_lock_missing')
  })

  it('keeps completion prose diagnostic-only and protocol decisions metamorphic', () => {
    const projection = createProjection()
    projection.enabled = true
    projection.items.set('R001', captureClause('ship the artifact', 'm1', 'R001', 1, { cwd: '/work' }))
    const texts = ['任务完成', '引用“任务完成”', '如果任务完成', '任务尚未完成', 'translate: task complete']
    expect(new Set(texts.map(() => decideTurnBoundary(projection).action))).toEqual(new Set(['stop']))
    expect(observeAssistantOutcome(texts[0]).kind).toBe('completion_claim')
    expect(observeAssistantOutcome(texts[1]).kind).not.toBe('completion_claim')
  })

  it('accepts user_wait only from a current immutable wait authorization', () => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause('等待用户选择后继续', 'm1', 'R001', 1, { cwd: '/work' })
    item.waitAuthorization = { kind: 'root_explicit_wait', id: 'wait:R001' }
    projection.items.set(item.id, item)
    const accepted = qualifyBoundary(projection, {
      disposition: 'user_wait',
      qualificationKind: 'root_explicit_wait',
      qualificationIds: ['wait:R001'],
    })
    expect(accepted.persistedResult).toBe('accepted')
    const rejected = qualifyBoundary(projection, {
      disposition: 'user_wait',
      qualificationKind: 'root_explicit_wait',
      qualificationIds: ['assistant:self-claim'],
    })
    expect(rejected.persistedResult).toBe('rejected')
  })

  it('classifies pre-effect, armed readback, and post-effect uncertainty separately', async () => {
    const projection = createProjection()
    const item = captureClause('等待用户选择后继续', 'm1', 'R001', 1, { cwd: '/work' })
    item.waitAuthorization = { kind: 'root_explicit_wait', id: 'wait:R001' }
    projection.items.set(item.id, item)
    projection.currentGoalRef = { id: 'goal-1', revision: 4 }
    const boundary = qualifyBoundary(projection, {
      disposition: 'user_wait', qualificationKind: 'root_explicit_wait', qualificationIds: ['wait:R001'],
    })

    const pre = await effectuateBoundary(boundary, {
      get: async () => ({ id: 'goal-1', revision: 4, phase: 'active', activation: 'armed' }),
      disarm: async () => { throw new Error('disarm failed') },
    })
    expect(pre.reasonCode).toBe('boundary_post_effect_unknown')
    expect(pre.stopAllowed).toBe(false)
    expect(pre.resumeRequired).toBe(true)

    let calls = 0
    const armed = await effectuateBoundary(boundary, {
      get: async () => ({ id: 'goal-1', revision: 4, phase: 'active', activation: 'armed' }),
      disarm: async () => ({ id: 'goal-1', revision: 4, phase: 'active', activation: 'armed' }),
    })
    expect(armed.reasonCode).toBe('boundary_readback_still_armed')
    expect(armed.stopAllowed).toBe(false)

    const post = await effectuateBoundary(boundary, {
      get: async () => {
        calls += 1
        if (calls === 1) return { id: 'goal-1', revision: 4, phase: 'active', activation: 'armed' }
        throw new Error('readback unavailable')
      },
      disarm: async () => ({ id: 'goal-1', revision: 4, phase: 'active', activation: 'disarmed' }),
    })
    expect(post.reasonCode).toBe('boundary_post_effect_unknown')
    expect(post.resumeRequired).toBe(true)
    expect(post.stopAllowed).toBe(false)
  })

  it('reconstructs the accepted candidate and rejects contract, Goal, and qualification drift', () => {
    const projection = createProjection()
    const item = captureClause('等待用户选择后继续', 'm1', 'R001', 1, { cwd: '/work' })
    item.waitAuthorization = { kind: 'root_explicit_wait', id: 'wait:R001' }
    projection.items.set(item.id, item)
    projection.currentGoalRef = { id: 'goal-1', revision: 4 }
    const boundary = qualifyBoundary(projection, {
      disposition: 'user_wait', qualificationKind: 'root_explicit_wait', qualificationIds: ['wait:R001'],
    })
    expect(isCurrentAcceptedBoundary(projection, boundary)).toBe(true)
    projection.contractRevision += 1
    expect(isCurrentAcceptedBoundary(projection, boundary)).toBe(false)
    projection.contractRevision -= 1
    projection.currentGoalRef = { id: 'goal-1', revision: 5 }
    expect(isCurrentAcceptedBoundary(projection, boundary)).toBe(false)
    projection.currentGoalRef = { id: 'goal-1', revision: 4 }
    item.status = 'passed'
    expect(isCurrentAcceptedBoundary(projection, boundary)).toBe(false)
  })

  it('requalifies a live external operation before yielding or disarming', async () => {
    const projection = createProjection()
    projection.externalOperations.set('job-1', { id: 'job-1', epoch: 0, adapterId: 'dsh.jobs.v1', status: 'running' })
    const boundary = qualifyBoundary(projection, {
      disposition: 'external_wait', qualificationKind: 'external_operation_pending', qualificationIds: ['job-1'],
    })
    let disarms = 0
    const rejected = await effectuateBoundary(boundary, {
      get: async () => undefined,
      disarm: async () => { disarms += 1; return undefined },
      requalify: async () => false,
    })
    expect(rejected.reasonCode).toBe('boundary_pre_effect_failure')
    expect(rejected.stopAllowed).toBe(false)
    expect(disarms).toBe(0)
    const accepted = await effectuateBoundary(boundary, {
      get: async () => undefined,
      disarm: async () => undefined,
      requalify: async () => true,
    })
    expect(accepted.reasonCode).toBe('boundary_no_goal_safe_yield')
  })

  it('treats a wrong-ref return after disarm as post-effect unknown', async () => {
    const projection = createProjection()
    const item = captureClause('等待用户选择后继续', 'm1', 'R001', 1, { cwd: '/work' })
    item.waitAuthorization = { kind: 'root_explicit_wait', id: 'wait:R001' }
    projection.items.set(item.id, item)
    projection.currentGoalRef = { id: 'goal-1', revision: 4 }
    const boundary = qualifyBoundary(projection, {
      disposition: 'user_wait', qualificationKind: 'root_explicit_wait', qualificationIds: ['wait:R001'],
    })
    const result = await effectuateBoundary(boundary, {
      get: async () => ({ id: 'goal-1', revision: 4, phase: 'active', activation: 'armed' }),
      disarm: async () => ({ id: 'other', revision: 1, phase: 'active', activation: 'disarmed' }),
    })
    expect(result).toMatchObject({ reasonCode: 'boundary_post_effect_unknown', stopAllowed: false, resumeRequired: true })
  })

  it('allows a boundary stop only after same-ref disarm and independent readback', async () => {
    const projection = createProjection()
    const item = captureClause('等待用户选择后继续', 'm1', 'R001', 1, { cwd: '/work' })
    item.waitAuthorization = { kind: 'root_explicit_wait', id: 'wait:R001' }
    projection.items.set(item.id, item)
    projection.currentGoalRef = { id: 'goal-1', revision: 4 }
    const boundary = qualifyBoundary(projection, {
      disposition: 'user_wait', qualificationKind: 'root_explicit_wait', qualificationIds: ['wait:R001'],
    })
    let armed = true
    const result = await effectuateBoundary(boundary, {
      get: async () => ({ id: 'goal-1', revision: 4, phase: 'active', activation: armed ? 'armed' : 'disarmed' }),
      disarm: async () => {
        armed = false
        return { id: 'goal-1', revision: 4, phase: 'active', activation: 'disarmed' }
      },
    })
    expect(result.reasonCode).toBe('boundary_effectuated')
    expect(result.stopAllowed).toBe(true)
  })
})
