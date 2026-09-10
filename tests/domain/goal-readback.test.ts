import { describe, expect, it } from 'vitest'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import { GoalId } from '@deepseek-ai/dsh-goal'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createRuntime } from '../../src/runtime.js'
import { decideTurnBoundary } from '../../src/domain/stop-policy.js'
import { createProjection } from '../../src/domain/types.js'
import { captureClause } from '../../src/domain/capture.js'
import { EXPECTED_HOST_PACKAGES, evaluateHostLock } from '../../src/domain/host-lock.js'

/**
 * Guard's Goal readback against the host's DECLARED GoalView type.
 *
 * Guard reads the Goal service structurally — it looks the service up as
 * `ctx.get('goals')`, which matches the host (`super(ctx, "goals")` in
 * `@deepseek-ai/dsh-goal`), and normalizes `GoalService.get(agent)` into the
 * phase and activation it gates on. Until now `normalizeGoalState` had only
 * ever been fed hand-written objects, so nothing tied it to the shape the host
 * actually returns.
 *
 * These fixtures are annotated with the INSTALLED `GoalView` type, so
 * TypeScript rejects them if the host renames, moves or drops a field. That is
 * the point: a structural reader is only correct while the type it mirrors is
 * checked by the compiler somewhere.
 *
 * A live `GoalService` is deliberately NOT constructed here. It injects
 * `agents` and `sessionProjections` and reads a registered `goal` projection, so
 * instantiating it in-process would mean composing a miniature host — which this
 * batch is explicitly forbidden from starting. The gap is recorded in the
 * handback rather than papered over.
 */

const HOST_LOCK = evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' })

function view(overrides: Partial<GoalView> = {}): GoalView {
  // Annotated, NOT cast. An earlier draft wrote `... } as GoalView`, and a
  // negative control showed that the cast suppresses excess-property checking
  // entirely — a renamed or removed host field compiled clean, so the fixture
  // was not bound to the host type at all and the claim below was false. The
  // annotation is what makes this fixture a compile-time contract.
  const base: GoalView = {
    id: GoalId('goal-1'),
    revision: 3,
    objective: 'Ship the host adaptation',
    phase: 'active',
    maxGoalRounds: 256,
    roundsStarted: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    activation: 'armed',
  }
  return { ...base, ...overrides }
}

/**
 * A session whose durable log records the goal the host also reports live.
 *
 * This is not test scaffolding to work around the assertion — it is the actual
 * contract. `createRuntime` treats the LOG as the authority for the goal
 * REFERENCE and uses the live service only for phase and activation, applying
 * them solely when the live id and revision match a reference the log already
 * carries. A live readback therefore cannot introduce a goal the durable log
 * never recorded, which is why the host writes `goal/change` on every goal
 * mutation.
 */
function agent(goal: { id: string; revision: number; phase: string } = { id: 'goal-1', revision: 3, phase: 'active' }): Agent {
  const session = Session.create(SessionId('goal-readback'), undefined, {
    version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId('goal-readback'), createdAt: 1, cwd: '/work',
  })
  session.append('goal/change', {
    kind: 'goal/change', version: 1, operation: 'create',
    goal: { id: goal.id, revision: goal.revision, objective: 'Ship the host adaptation', phase: goal.phase, maxGoalRounds: 256 },
    roundsStarted: 1, createdAt: 1, updatedAt: 1,
  } as never)
  return { session } as unknown as Agent
}

function runtimeWithGoal(readGoalState: () => unknown, goal?: { id: string; revision: number; phase: string }) {
  const runtime = createRuntime(agent(goal), { activation: 'always' }, HOST_LOCK, readGoalState)
  runtime.setDurability(true)
  runtime.sync()
  return runtime
}

describe('Goal readback against the host GoalView type', () => {
  it.each([
    ['active', 'armed'],
    ['active', 'disarmed'],
    ['paused', 'disarmed'],
    ['blocked', 'disarmed'],
    ['complete', 'disarmed'],
  ] as const)('normalizes phase %s with activation %s', (phase, activation) => {
    const runtime = runtimeWithGoal(() => view({ phase, activation }))
    expect(runtime.projection.currentGoalRef).toEqual({ id: 'goal-1', revision: 3 })
    expect(runtime.projection.currentGoalPhase).toBe(phase)
    expect(runtime.projection.currentGoalActivation).toBe(activation)
    expect(runtime.projection.integrity).toBe('valid')
  })

  it('accepts the host view whether it is returned bare or under a goal envelope', () => {
    const bare = runtimeWithGoal(() => view({ phase: 'paused', activation: 'disarmed' }))
    const wrapped = runtimeWithGoal(() => ({ goal: view({ phase: 'paused', activation: 'disarmed' }), activation: 'disarmed' }))
    for (const runtime of [bare, wrapped]) {
      expect(runtime.projection.currentGoalPhase).toBe('paused')
      expect(runtime.projection.currentGoalActivation).toBe('disarmed')
    }
  })

  it('yields instead of continuing while the host reports a paused goal (T07)', () => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause('持续推进，直到迁移脚本全部跑完为止。', 'm1', 'R001', 1, { cwd: '/work' })
    projection.items.set(item.id, item)
    projection.contractRevision = 1
    // Without the goal this input earns Guard's one correction steer.
    expect(decideTurnBoundary(projection)).toMatchObject({ action: 'continue', reason: 'protocol_correction_steer' })

    const runtime = runtimeWithGoal(() => view({ phase: 'paused', activation: 'disarmed' }), { id: 'goal-1', revision: 3, phase: 'active' })
    Object.assign(runtime.projection, {
      enabled: true, items: projection.items, contractRevision: projection.contractRevision,
    })
    expect(decideTurnBoundary(runtime.projection)).toEqual({ action: 'stop', reason: 'goal_paused_by_user_safe_yield' })
  })

  it('treats an unreadable Goal readback as unknown integrity rather than as no goal', () => {
    // A readback that throws must not look like "no goal is running": failing
    // open there would let Guard continue work whose ownership it cannot see.
    const runtime = runtimeWithGoal(() => { throw new Error('goal projection is not registered') })
    expect(runtime.projection.integrity).toBe('unknown')
    expect(runtime.projection.integrityViolations).toContain('goal_readback_unavailable')
  })

  it('reports no goal reference when the log records no goal', () => {
    const session = Session.create(SessionId('no-goal'), undefined, {
      version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId('no-goal'), createdAt: 1, cwd: '/work',
    })
    const runtime = createRuntime({ session } as unknown as Agent, { activation: 'always' }, HOST_LOCK, () => view())
    runtime.setDurability(true)
    runtime.sync()
    // A live goal the durable log never recorded is NOT adopted.
    expect(runtime.projection.currentGoalRef).toBeUndefined()
    expect(runtime.projection.currentGoalPhase).toBeUndefined()
  })

  it('does not adopt live phase for a goal the log records at another revision', () => {
    const runtime = runtimeWithGoal(() => view({ revision: 9 }), { id: 'goal-1', revision: 3, phase: 'active' })
    expect(runtime.projection.currentGoalRef).toEqual({ id: 'goal-1', revision: 3 })
    // The live view is at revision 9; the log's reference wins and the stale
    // live phase is not applied.
    expect(runtime.projection.currentGoalPhase).toBe('active')
  })

  it('never lets a malformed readback override the phase the log records', () => {
    // The durable log supplies BOTH the reference and the phase; the live
    // service only overrides them when the live id and revision match. So the
    // observable property is not "no phase" but "the LOG's phase, unchanged":
    // a garbled live value must not be able to move an active goal to paused
    // (which would let Guard dodge the Round Driver) or to block it.
    for (const value of [null, 'nope', 7, {},
      { id: 'goal-1', revision: '3', phase: 'paused', activation: 'disarmed' },
      { id: 'goal-1', revision: 3, phase: 'unknown', activation: 'armed' },
      { id: 'goal-1', revision: 3, phase: 'blocked', activation: 'weird' },
      { id: 42, revision: 3, phase: 'complete', activation: 'armed' },
      { id: 'goal-1', revision: 3, phase: 'complete' }]) {
      const runtime = runtimeWithGoal(() => value, { id: 'goal-1', revision: 3, phase: 'active' })
      expect(runtime.projection.currentGoalRef, JSON.stringify(value)).toEqual({ id: 'goal-1', revision: 3 })
      expect(runtime.projection.currentGoalPhase, JSON.stringify(value)).toBe('active')
      expect(runtime.projection.currentGoalActivation, JSON.stringify(value)).toBe('disarmed')
    }
    // A well-formed matching readback DOES override, which is the contrast.
    const live = runtimeWithGoal(() => view({ phase: 'paused', activation: 'disarmed' }), { id: 'goal-1', revision: 3, phase: 'active' })
    expect(live.projection.currentGoalPhase).toBe('paused')
  })
})
