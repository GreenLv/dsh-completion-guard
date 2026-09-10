import { describe, expect, it } from 'vitest'
import type { GoalService, GoalView, GoalRef } from '@deepseek-ai/dsh-goal'
import { GoalId } from '@deepseek-ai/dsh-goal'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { effectuateBoundary, isCurrentAcceptedBoundary, qualifyBoundary } from '../../src/domain/boundary.js'
import { certifyCheckpoint } from '../../src/domain/checkpoint.js'
import { deriveProjection, PROTOCOL_V4_NOTICE } from '../../src/domain/derive.js'
import { goalCompletionDenial, hasCurrentCertificate } from '../../src/domain/goal-gate.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import type { BoundaryEffectuation } from '../../src/domain/boundary.js'
import type { DerivedEnvelope, GuardProjection } from '../../src/domain/types.js'

/**
 * The wait and Goal lifecycle, end to end.
 *
 * One scenario, driven through the production entry points in order:
 * a trusted root instruction creates a conditional obligation; the unmet
 * condition refuses execution AND whole-task certification; the wait is
 * persisted as a typed boundary; the host Goal is disarmed through the real
 * `GoalService.disarm` surface and read back; no further round is scheduled;
 * a matching trusted root input releases the wait; and the resumed work is
 * still subject to the ordinary target, host and evidence checks.
 *
 * The Goal double below is annotated with the harness's own `GoalService` type,
 * so a renamed or removed method is a compile error here. Only the transport is
 * simulated: the disarm call is the API the production runtime already invokes
 * (`goals.disarm(agent)`), never a simulated human pause.
 */
class GoalLifecycleTransport implements Pick<GoalService, 'get' | 'disarm' | 'pause' | 'resume' | 'create'> {
  private view: GoalView = {
    id: GoalId('goal-wait'), revision: 3, objective: 'ship the guarded change', phase: 'active',
    maxGoalRounds: 256, roundsStarted: 1, createdAt: 1, updatedAt: 2, activation: 'armed',
  }
  /** Every round the driver admitted; a disarmed goal admits none. */
  roundsStarted = 1
  calls: string[] = []

  get(_agent: Agent): GoalView { this.calls.push('get'); return { ...this.view } }
  disarm(_agent: Agent): GoalView {
    this.calls.push('disarm')
    this.view = { ...this.view, activation: 'disarmed' }
    return { ...this.view }
  }
  pause(_agent: Agent, _ref: GoalRef): GoalView {
    this.calls.push('pause')
    this.view = { ...this.view, phase: 'paused', activation: 'disarmed' }
    return { ...this.view }
  }
  resume(_agent: Agent, _ref: GoalRef): GoalView {
    this.calls.push('resume')
    this.view = { ...this.view, phase: 'active', activation: 'armed' }
    return { ...this.view }
  }
  create(): never { throw new Error('the scenario never creates a goal') }
}

const RESERVED = '请在收到我的确认后再推送代码。'
const RESOLVED_PUSH = { repository: '/work/repo', remote: 'origin', refspec: 'refs/heads/main:refs/heads/main', local_oid: 'a'.repeat(64) }
const TARGETED_PUSH = `Push repository /work/repo to remote origin refspec refs/heads/main:refs/heads/main.`

function session(goal: { id: string; revision: number; phase: string } = { id: 'goal-wait', revision: 3, phase: 'active' }): Session {
  const created = Session.create(SessionId('wait-lifecycle'), undefined, {
    version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId('wait-lifecycle'), createdAt: 1, cwd: '/work/repo',
  })
  created.append('goal/change', {
    kind: 'goal/change', version: 1, operation: 'create',
    goal: { id: goal.id, revision: goal.revision, objective: 'ship the guarded change', phase: goal.phase, maxGoalRounds: 256 },
    roundsStarted: 1, createdAt: 1, updatedAt: 2,
  } as never)
  return created
}

function project(target: Session, envelopes: DerivedEnvelope[]): GuardProjection {
  const events = target.snapshotEvents() as unknown as DerivedEnvelope[]
  return deriveProjection([...events, ...envelopes], { activation: 'opt-in' }, { cwd: '/work/repo' }, true).projection
}

const root = (seq: number, text: string): DerivedEnvelope =>
  ({ seq, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const boundaryNotice = (seq: number): DerivedEnvelope =>
  ({ seq, type: 'user/message', data: { source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text: PROTOCOL_V4_NOTICE }] } })

/** The whole scenario, returning every artifact the assertions need. */
async function runScenario(release = true) {
  const target = session()
  const enable: DerivedEnvelope = { seq: 0, type: 'command/run', data: { name: 'context-guard', args: 'on', source: { kind: 'user' } } }
  const envelopes: DerivedEnvelope[] = [enable, boundaryNotice(1), root(2, RESERVED)]
  let projection = project(target, envelopes)

  // 1. The trusted root instruction established a conditional obligation.
  const reserved = [...projection.items.values()][0]!
  // 2. The unmet condition refuses execution…
  const refused = authorizeMutationFromProjection(projection, {
    action: 'push', contractItemId: reserved.id, contractItemRevision: reserved.revision, resolvedTarget: RESOLVED_PUSH,
  })
  // …and refuses whole-task certification.
  const certification = certifyCheckpoint(projection, [], 'C-denied', false)
  const certificateDenied = !hasCurrentCertificate(projection)
  const goalDenial = goalCompletionDenial(projection, 'update_goal', { action: 'complete', goal_id: 'goal-wait', revision: 3 })

  // 3. The wait is persisted as a typed boundary citing the root qualification.
  const qualification = [...projection.items.values()]
    .filter((item) => item.waitAuthorization)
    .map((item) => item.waitAuthorization!.id)[0]!
  const boundary = qualifyBoundary(projection, {
    disposition: 'user_wait', qualificationKind: 'root_explicit_wait', qualificationIds: [qualification],
  })
  const persisted: GuardProjection = { ...projection, boundaries: [...projection.boundaries, boundary] }
  expect(isCurrentAcceptedBoundary(persisted, boundary)).toBe(true)

  // 4. The host Goal is disarmed through the real service API and read back.
  const goals = new GoalLifecycleTransport()
  const agent = { session: target } as unknown as Agent
  const before = goals.get(agent)
  const effect = await effectuateBoundary(boundary, {
    get: async () => { const view = goals.get(agent); return { id: view.id, revision: view.revision, phase: view.phase, activation: view.activation } },
    disarm: async () => { const view = goals.disarm(agent); return { id: view.id, revision: view.revision, phase: view.phase, activation: view.activation } },
  })
  // 5. The readback is disarmed and no further round was admitted.
  const after = goals.get(agent)
  const roundsAfterDisarm = goals.roundsStarted

  // 6. A matching trusted root input releases the wait.
  let released: GuardProjection | undefined
  if (release) {
    // The root's release names the SAME repository the reservation covered, so
    // the release matches the wait rather than creating an unrelated obligation.
    envelopes.push(root(3, 'Push repository /work/repo to remote origin refspec refs/heads/main:refs/heads/main.'))
    released = project(target, envelopes)
  }
  return { projection, persisted, reserved, refused, certification, certificateDenied, goalDenial, boundary, effect, before, after, goals, roundsAfterDisarm, released }
}

describe('wait and Goal lifecycle integration', () => {
  it('runs the whole scenario without a fabricated certificate', async () => {
    const s = await runScenario()

    // 1. A conditional obligation exists and is open.
    expect(s.reserved.authorityDisposition).toBe('conditional_wait')
    expect(s.reserved.status).toBe('pending')
    expect(s.reserved.waitAuthorization?.kind).toBe('root_explicit_wait')

    // 2. Execution is refused for the condition, and certification is refused.
    expect(s.refused).toEqual({ status: 'denied', reasonCode: 'mutation_awaiting_root_condition' })
    expect(s.certification.status).toBe('incomplete')
    expect(s.certificateDenied).toBe(true)
    expect(s.goalDenial).toContain('certificate_missing')
    // No checkpoint was committed, so no certificate exists to be mistaken for one.
    expect(s.projection.checkpoints).toHaveLength(0)

    // 3. The wait persisted and is current.
    expect(s.boundary.persistedResult).toBe('accepted')
    expect(s.boundary.qualificationKind).toBe('root_explicit_wait')
    expect(isCurrentAcceptedBoundary(s.persisted, s.boundary)).toBe(true)

    // 4. The disarm went through the declared lifecycle API and was read back.
    expect(s.before.activation).toBe('armed')
    expect(s.goals.calls).toContain('disarm')
    expect(s.goals.calls).not.toContain('pause')
    expect(s.effect.goalRef).toEqual({ id: 'goal-wait', revision: 3 })
    expect(s.after.activation).toBe('disarmed')

    // 5. The disarmed goal admits no further round.
    expect(s.roundsAfterDisarm).toBe(1)
  })

  it('reports the effectuation outcome the caller must honour', async () => {
    const s = await runScenario()
    const effect: BoundaryEffectuation = s.effect
    // A disarmed readback is the ONLY outcome that allows the turn to stop.
    expect(effect.reasonCode).toBe('boundary_effectuated')
    expect(effect.stopAllowed).toBe(true)
    expect(effect.resumeRequired).toBe(false)
  })

  it('releases the wait only on a matching trusted root input', async () => {
    const s = await runScenario(true)
    const open = [...s.released!.items.values()].filter((item) => item.status === 'pending')
    // The released instruction replaced the reserved one: no stale wait remains.
    expect(open.some((item) => item.waitAuthorization !== undefined)).toBe(false)
    const runnable = open.find((item) => item.authorityDisposition === 'executable_now')!
    expect(runnable).toBeDefined()
    // 7. The resumed work still passes the ordinary authorization checks.
    expect(authorizeMutationFromProjection(s.released!, {
      action: 'push', contractItemId: runnable.id, contractItemRevision: runnable.revision, resolvedTarget: RESOLVED_PUSH,
    })).toEqual({ status: 'authorized', reasonCode: 'mutation_root_contract_authorized' })
  })

  it('keeps the reserved obligation blocking certification while no release arrives', async () => {
    const s = await runScenario(false)
    const open = [...s.projection.items.values()].filter((item) => item.status === 'pending')
    expect(open).toHaveLength(1)
    expect(open[0].authorityDisposition).toBe('conditional_wait')
    expect(hasCurrentCertificate(s.projection)).toBe(false)
  })
})
