import { describe, expect, it } from 'vitest'
import { interpretMessage } from '../../src/domain/semantics.js'
import { deriveProjection, PROTOCOL_V4_NOTICE } from '../../src/domain/derive.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { decideTurnBoundary } from '../../src/domain/stop-policy.js'
import { availableBoundaryQualifications } from '../../src/domain/boundary.js'
import { createCheckpointTool } from '../../src/tools/checkpoint.js'
import type { DerivedEnvelope } from '../../src/domain/types.js'

/**
 * Trusted root confirmation and the analysis bounds.
 *
 * A root instruction that reserves an action for its own later confirmation
 * must not be executable now — the reservation is authority the root withheld,
 * and losing it would silently grant the action. The analysis bounds
 * (MAX_VERB_SCAN / MAX_CONDITION_SCAN) shorten how far the interpretation looks
 * for a marker; they must never turn a reservation into a default grant or
 * drop an obligation, so both sides of every threshold are pinned here.
 */

const replay = (texts: string[]) => deriveProjection([
  { seq: 0, type: 'user/message', data: { source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text: PROTOCOL_V4_NOTICE }] } },
  ...texts.map((text, index): DerivedEnvelope => ({ seq: index + 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })),
], { activation: 'always' }, { cwd: '/workspace' }, true).projection

const onlyItem = (text: string) => [...replay([text]).items.values()][0]!

/** A push clause whose captured target is complete enough to authorize. */
const TARGETED_PUSH = 'Push repository repo-alpha to remote origin refspec refs/heads/main:refs/heads/main.'
const RESOLVED_PUSH = { repository: 'repo-alpha', remote: 'origin', refspec: 'refs/heads/main:refs/heads/main', local_oid: 'a'.repeat(64) }
const replayRepo = (texts: string[]) => deriveProjection([
  { seq: 0, type: 'user/message', data: { source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text: PROTOCOL_V4_NOTICE }] } },
  ...texts.map((text, index): DerivedEnvelope => ({ seq: index + 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })),
], { activation: 'always' }, { cwd: '/work/repo' }, true).projection

describe('a reserved action waits for the root confirmation', () => {
  it.each([
    '请在收到我的确认后再推送代码。',
    '收到我的确认后再推送代码。',
    '收到我的明确回报后再推送。',
  ])('reads %s as a conditional wait, not immediate work', (text) => {
    const [scope] = interpretMessage(text)
    expect(scope.authorityDisposition).toBe('conditional_wait')
    expect(scope.immediatelyExecutable).toBe(false)
    expect(scope.condition).toBeTruthy()
    expect(scope.resumeEvent).toBeTruthy()
    const item = onlyItem(text)
    expect(item.authorityDisposition).toBe('conditional_wait')
    expect(item.waitAuthorization?.kind).toBe('root_explicit_wait')
  })

  it('refuses a reserved mutation for the CONDITION, with a target that would otherwise be accepted', () => {
    const projection = replayRepo([TARGETED_PUSH, '请在收到我的确认后再执行推送。'])
    const item = [...projection.items.values()].find((row) => row.authorityDisposition === 'conditional_wait')!
    expect(item).toBeDefined()
    // The target is complete and would be accepted for an ordinary instruction:
    // the refusal must come from the reservation, not from target validation.
    const decision = authorizeMutationFromProjection(projection, {
      action: 'push', contractItemId: item.id, contractItemRevision: item.revision, resolvedTarget: RESOLVED_PUSH,
    })
    expect(decision.status).toBe('denied')
    expect(decision.reasonCode).toBe('mutation_awaiting_root_condition')
  })

  it('authorizes the same action and target once the root has released the wait', () => {
    const projection = replayRepo([TARGETED_PUSH, '请在收到我的确认后再执行推送。'])
    const reserved = [...projection.items.values()].find((row) => row.authorityDisposition === 'conditional_wait')!
    expect(authorizeMutationFromProjection(projection, {
      action: 'push', contractItemId: reserved.id, contractItemRevision: reserved.revision, resolvedTarget: RESOLVED_PUSH,
    }).reasonCode).toBe('mutation_awaiting_root_condition')

    // The trusted root confirmation re-states the work without a reservation.
    const released = replayRepo([TARGETED_PUSH, '请在收到我的确认后再执行推送。', TARGETED_PUSH])
    const open = [...released.items.values()].find((row) => row.status === 'pending' && row.authorityDisposition === 'executable_now')!
    expect(open).toBeDefined()
    const decision = authorizeMutationFromProjection(released, {
      action: 'push', contractItemId: open.id, contractItemRevision: open.revision, resolvedTarget: RESOLVED_PUSH,
    })
    // Releasing the wait does NOT skip the other authorization checks; a fully
    // valid target is what turns it into an authorization.
    expect(decision).toEqual({ status: 'authorized', reasonCode: 'mutation_root_contract_authorized' })
  })

  it('still refuses a released action whose target is incomplete', () => {
    const released = replayRepo([TARGETED_PUSH, '请在收到我的确认后再执行推送。', TARGETED_PUSH])
    const open = [...released.items.values()].find((row) => row.status === 'pending' && row.authorityDisposition === 'executable_now')!
    const decision = authorizeMutationFromProjection(released, {
      action: 'push', contractItemId: open.id, contractItemRevision: open.revision, resolvedTarget: { repository: 'repo-alpha' },
    })
    expect(decision.status).toBe('denied')
    expect(decision.reasonCode).not.toBe('mutation_awaiting_root_condition')
  })

  it('denies the reserved mutation at the production authorization entry', () => {
    const projection = replay(['请在收到我的确认后再推送代码。'])
    const item = [...projection.items.values()][0]!
    // The obligation is preserved: the push stays recorded, it is not dropped.
    expect(item.status).toBe('pending')
    expect(availableBoundaryQualifications(projection).some((row) => row.kind === 'root_explicit_wait')).toBe(true)
    // Without a confirmation the mutation is refused before any target check.
    const decision = authorizeMutationFromProjection(projection, {
      action: 'push', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { repository: '/workspace', remote: 'origin', refspec: 'refs/heads/main:refs/heads/main', local_oid: 'a'.repeat(64) },
    })
    expect(decision.status).toBe('denied')
    expect(decision.reasonCode).not.toBe('mutation_root_contract_authorized')
  })

  it('does not treat a report of the confirmation as a reserved action', () => {
    const [scope] = interpretMessage('收到我的确认了。')
    expect(scope.directive).toBe('narrative')
    expect(scope.immediatelyExecutable).toBe(false)
    expect(scope.condition).toBeUndefined()
    expect(scope.resumeEvent).toBeUndefined()
    // A receipt mints no wait qualification either.
    expect([...replay(['收到我的确认了。']).items.values()].every((item) => item.waitAuthorization === undefined)).toBe(true)
  })

  it('splits a semicolon-joined trailing wait so the first action runs and the second waits', () => {
    const scopes = interpretMessage('先测试；收到我的确认后再推送。')
    const test = scopes.find((scope) => scope.text.includes('先测试'))!
    const push = scopes.find((scope) => scope.text.includes('推送'))!
    expect(test.immediatelyExecutable).toBe(true)
    expect(push.authorityDisposition).toBe('conditional_wait')
    expect(push.immediatelyExecutable).toBe(false)
    expect(push.condition).toBeTruthy()
    expect(push.resumeEvent).toBeTruthy()
  })

  it('splits a comma-joined trailing wait so the first action runs and the second waits', () => {
    const scopes = interpretMessage('请先测试，收到我的确认后再推送。')
    const test = scopes.find((scope) => scope.text.includes('测试'))!
    const push = scopes.find((scope) => scope.text.includes('推送'))!
    expect(test.executee).toBe('agent')
    expect(test.immediatelyExecutable).toBe(true)
    expect(test.authorityDisposition).toBe('executable_now')
    expect(push.authorityDisposition).toBe('conditional_wait')
    expect(push.immediatelyExecutable).toBe(false)
    expect(push.condition).toBeTruthy()
    expect(push.resumeEvent).toBeTruthy()

    const projection = replay(['请先测试，收到我的确认后再推送。'])
    const items = [...projection.items.values()]
    const awaited = items.find((item) => item.authorityDisposition === 'conditional_wait')!
    const runnable = items.find((item) => item.authorityDisposition === 'executable_now')!
    expect(awaited).toBeDefined()
    expect(runnable).toBeDefined()
    // The reservation holds at the production authorization entry.
    const refused = authorizeMutationFromProjection(projection, {
      action: 'push', contractItemId: awaited.id, contractItemRevision: awaited.revision,
      resolvedTarget: { repository: '/workspace', remote: 'origin', refspec: 'refs/heads/main:refs/heads/main', local_oid: 'a'.repeat(64) },
    })
    expect(refused.status).toBe('denied')
  })
})

describe('a clause that orders several actions keeps every obligation', () => {
  it('records each stateful action of one clause', () => {
    const item = onlyItem('请帮我安装 dsh-dream-skin 换肤插件，重启 DSH')
    expect(item.actionPlan?.map((entry) => entry.action)).toEqual(['install', 'restart'])
    // The item stays one top-level obligation.
    expect([...replay(['请帮我安装 dsh-dream-skin 换肤插件，重启 DSH']).items.values()]).toHaveLength(1)
  })

  it('refuses a closure that maps an action to the wrong target, or to failed evidence', async () => {
    const projection = replay(['请帮我安装 pkg@1.0.0 到 web 配置档，重启服务 api'])
    const item = [...projection.items.values()][0]!
    expect(item.actionPlan?.map((entry) => entry.action)).toEqual(['install', 'restart'])
    const tool = createCheckpointTool(() => projection, () => {})
    const plan = item.actionPlan!
    // A closure must cite its own evidence, and a citation must name evidence
    // the ledger actually holds: the citation-existence check runs before the
    // target comparison, so a fixture that cites invented ids measures THAT
    // refusal and never reaches the closure checks it means to exercise. The
    // ledger entries below are recorded for the two actions, which leaves the
    // target comparison as the only difference between the cases.
    for (const entry of plan) {
      projection.evidence.set(`E-${entry.action}`, {
        id: `E-${entry.action}`, epoch: projection.epoch, callId: `c-${entry.action}`, rootCallId: `c-${entry.action}`,
        toolName: 'bash', toolResultSeq: 1, outcome: 'success', subjects: ['/workspace'], surfaces: ['scope'],
        capabilities: ['deterministic-check'], boundedSummarySha256: '11'.repeat(32),
        semanticAction: entry.action, parseStatus: 'supported', resolvedTarget: entry.requestedTarget,
      } as never)
    }
    // The tool spells the closure in its declared wire shape.
    const good = (index: number) => ({
      action: plan[index]!.action,
      order: index,
      resolved_target: plan[index]!.requestedTarget,
      evidence_ids: [`E-${plan[index]!.action}`],
    })
    // Wrong target for the restart action, with its evidence in place.
    const wrongTarget = await tool.execute({ bindings: [{ item_id: item.id, evidence_ids: [good(0).evidence_ids[0], good(1).evidence_ids[0]], action_bindings: [
      good(0), { ...good(1), resolved_target: { service_id: 'other-service' } },
    ] }] } as never, undefined as never) as { rejected_bindings: Array<{ reason_code: string }> }
    expect(wrongTarget.rejected_bindings.map((row) => row.reason_code)).toContain('action_plan_target_mismatch')
    // Actions supplied out of the clause's order. Each closure states its own
    // order, so the defect is a closure whose declared action does not match
    // the plan at its position — not merely an array written backwards, which
    // the declared order makes equivalent.
    const swapped = [
      { ...good(0), action: plan[1]!.action, resolved_target: plan[1]!.requestedTarget, evidence_ids: [`E-${plan[1]!.action}`] },
      { ...good(1), action: plan[0]!.action, resolved_target: plan[0]!.requestedTarget, evidence_ids: [`E-${plan[0]!.action}`] },
    ]
    const outOfOrder = await tool.execute({ bindings: [{ item_id: item.id, evidence_ids: [good(0).evidence_ids[0], good(1).evidence_ids[0]], action_bindings: swapped }] } as never, undefined as never) as { rejected_bindings: Array<{ reason_code: string }> }
    expect(outOfOrder.rejected_bindings.map((row) => row.reason_code)).toContain('action_plan_order_mismatch')
    // Evidence that succeeded for a different action.
    const reusedAbstract = await tool.execute({ bindings: [{ item_id: item.id, evidence_ids: [good(0).evidence_ids[0]], action_bindings: [good(0), { ...good(1), evidence_ids: [good(0).evidence_ids[0]] }] }] } as never, undefined as never) as { rejected_bindings: Array<{ reason_code: string }> }
    expect(reusedAbstract.rejected_bindings.map((row) => row.reason_code)).toContain('action_plan_evidence_reused')
  })

  it('refuses to close the item on evidence for only one of its actions', async () => {
    const projection = replay(['请帮我安装 dsh-dream-skin 换肤插件，重启 DSH'])
    const item = [...projection.items.values()][0]!
    expect(item.actionPlan).toHaveLength(2)
    const installOnly = createCheckpointTool(() => projection, () => {})
    const page = await installOnly.execute({ bindings: [] }, undefined as never) as { status: string; open_items: unknown[] }
    expect(page.status).toBe('incomplete')
    // A binding that cites only the install effect is refused for the missing
    // restart, rather than certifying half of what the root ordered.
    const closed = await installOnly.execute({
      bindings: [{ item_id: item.id, evidence_ids: [], semantic_action: 'install' }],
    } as never, undefined as never) as { status: string; rejected_bindings: Array<{ reason_code: string }> }
    expect(closed.status).toBe('incomplete')
    expect(closed.rejected_bindings.length).toBeGreaterThan(0)
  })

  it('does not invent an action plan for a single-action or non-stateful clause', () => {
    expect(onlyItem('更新插件').actionPlan).toBeUndefined()
    expect(onlyItem(TARGETED_PUSH).actionPlan).toBeUndefined()
  })
})

describe('a long background does not hide the marker it precedes', () => {
  /**
   * The marker is placed AFTER the background, so the analysis genuinely has to
   * cross the threshold to find it. A bound that shortened the search would drop
   * the marker and silently convert a ban, a reservation or a human action into
   * agent work.
   */
  const THRESHOLDS = [0, 40, 88, 95, 96, 97, 120, 511, 512, 513, 1024, 4096]
  const filler = (n: number) => '背'.repeat(n)

  it.each(THRESHOLDS)('still finds a prohibition written after %i filler characters', (n) => {
    const [scope] = interpretMessage(`不要${filler(n)}发布`)
    expect(scope.directive).toBe('prohibition')
    expect(scope.immediatelyExecutable).toBe(false)
  })

  it.each(THRESHOLDS)('still finds a reservation written after %i filler characters', (n) => {
    const [scope] = interpretMessage(`请在收到我的确认后${filler(n)}再推送`)
    expect(scope.immediatelyExecutable).toBe(false)
    expect(scope.authorityDisposition).toBe('conditional_wait')
  })

  it.each(THRESHOLDS)('still finds a human executor named after %i filler characters', (n) => {
    const [scope] = interpretMessage(`由我${filler(n)}手动重启`)
    expect(scope.executee).toBe('user')
    expect(scope.immediatelyExecutable).toBe(false)
  })

  it.each([95, 96, 97, 511, 512, 513])('records the action of a ban whose verb is %i characters after the negator', (n) => {
    const projection = replay([`不要${filler(n)}发布`])
    const item = [...projection.items.values()][0]!
    expect(item.kind).toBe('prohibition')
    // The ban still names the action it forbids rather than a generic one.
    expect(item.semanticAction).toBe('publish')
  })
})

describe('appended background keeps the obligation visible', () => {
  const filler = (n: number) => '背'.repeat(n)

  it.each([0, 96, 97, 512, 513, 4096])('keeps a trailing background of %i characters from hiding the ban', (n) => {
    const [scope] = interpretMessage(`不要发布${filler(n)}包`)
    expect(scope.directive).toBe('prohibition')
    expect(scope.immediatelyExecutable).toBe(false)
  })

  it.each([0, 96, 97, 512, 513, 4096])('keeps a trailing background of %i characters from hiding the executor', (n) => {
    const [scope] = interpretMessage(`由我手动重启${filler(n)}`)
    expect(scope.executee).toBe('user')
    expect(scope.immediatelyExecutable).toBe(false)
  })

  it.each([0, 96, 97, 512, 513, 4096])('keeps a trailing background of %i characters from hiding the reservation', (n) => {
    const [scope] = interpretMessage(`请在收到我的确认后再推送${filler(n)}`)
    expect(scope.immediatelyExecutable).toBe(false)
  })

  it('keeps a long message as a recorded obligation rather than an empty task', () => {
    const projection = replay([`完成本地实现、测试和文档${filler(4096)}`])
    const items = [...projection.items.values()]
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((item) => item.status === 'pending')).toBe(true)
    // A long obligation still blocks a whole-task completion claim.
    expect(decideTurnBoundary({ ...projection, enabled: true }).action).toBe('stop')
  })

  it('produces identical interpretations for a cached and a fresh mask', () => {
    const text = '请在收到我的确认后再推送代码。'
    const first = interpretMessage(text)
    // Re-run after other inputs have filled and evicted the mask cache.
    for (let index = 0; index < 100; index += 1) interpretMessage(`填充${index}` + '背'.repeat(index))
    const second = interpretMessage(text)
    expect(second).toEqual(first)
  })
})
