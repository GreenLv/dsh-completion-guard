import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply } from '../src/runtime.js'
import { deriveProjection, PROTOCOL_V6_NOTICE } from '../src/domain/derive.js'
import { projectSessionCoreV2 } from '../src/core-v2/session.js'
import { recoveryDigest, renderRecoveryPacket } from '../src/domain/recovery.js'
import { currentV6Feedback } from '../src/domain/v6-feedback.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'
import { createCheckpointTool } from '../src/tools/checkpoint.js'
import { createPrepareTool } from '../src/tools/prepare.js'

// DSH-RF-01/02/03 (CGI-20260922-dsh-v6-recovery-feedback-divergence): the v6
// recovery packet must consume the same confirmed core-v2 facts prepare and
// checkpoint consume. The expectations below come from the adopted contract
// (CORE_ALIGNMENT_CONTRACT_V2 AC01/AC02/AC05) and from the independent core
// projection, never from recovery's own output.

const HOST = { ...evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' }),
  auditedForegroundRenderers: ['bash' as const] }

function fixture(root: string, idLabel = 'v6-recovery-feedback') {
  const id = SessionId(idLabel)
  const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, isSeeded: false, id, createdAt: 1, cwd: '/work' })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }],
    source: { kind: 'plugin', plugin: 'context-guard', form: 'notice', summary: 'v6' } }), { surfaceOp: 'append' })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: root }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const scope = { cwd: '/work', sessionHeader: { version: SESSION_FORMAT_VERSION, id: String(id), createdAt: 1, seedLength: 0, delegationDepth: 0 } }
  const derive = () => {
    const events = session.snapshotEvents() as never
    const projection = deriveProjection(events, { activation: 'always' }, scope, true, HOST).projection
    projection.durabilityWatermark = 'confirmed'
    const origins: NonNullable<typeof projection.coreV2RequirementOrigins> = new Map()
    projection.coreV2 = projectSessionCoreV2(events, projection, origins)
    projection.coreV2RequirementOrigins = origins
    return projection
  }
  return { session, derive, scope }
}

function appendTest(session: Session, callId: string, failed = false, command = 'npm test') {
  session.append('tool/call', { turn: 1, step: 1, callId: callId as never, name: 'bash', arguments: JSON.stringify({ command, workdir: '/work' }) })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: callId as never,
    content: [{ type: 'text', text: failed ? '1 test failed' : '10 tests passed' }], isError: failed }),
    ...(failed ? { error: { name: 'ProcessError', message: 'failed' } } : {}) } as never, { surfaceOp: 'append' })
}

/** The old qualification lane's demand phrases; none of them may reappear for
 * ordinary v6 work (AC02: recovery must not route ordinary work back into the
 * legacy clarification/rebind chain). */
function expectNoOldQualificationDemand(packet: string) {
  expect(packet, packet).not.toContain('target_clarification_required')
  expect(packet, packet).not.toContain('exact target')
  expect(packet, packet).not.toContain('context_guard_interpret')
  expect(packet, packet).not.toContain('context_guard_rebind')
  expect(packet, packet).not.toContain('re-enables certification')
  expect(packet, packet).not.toContain('Checkpoint required before completion')
}

describe('RF01/RF02: ordinary create tasks keep host-owned framing in recovery', () => {
  const cases = [
    ['zh-create', '创建一个 HTML 动画页面,展示一个小球弹跳。'],
    ['en-create', 'Create an HTML animation page showing a bouncing ball.'],
  ] as const
  for (const [name, root] of cases) {
    it(`${name}: records the requirement without demanding target re-authorization`, () => {
      const { derive } = fixture(root, `rf0102-${name}`)
      const projection = derive()
      // Independent upstream fact: the confirmed core keeps this ordinary work
      // uncertified (legacy_review), never as a missing root target choice.
      expect(currentV6Feedback(projection)?.predicates.R001).toBe('legacy_review')
      expect(currentV6Feedback(projection)?.status).toBe('incomplete')
      const packet = renderRecoveryPacket(projection)
      expectNoOldQualificationDemand(packet)
      // The requirement itself stays visible with its current core reason code.
      expect(packet).toContain('[R001]')
      expect(packet).toContain('legacy_review')
      // Ordinary execution is explicitly NOT gated on Guard steps.
      expect(packet).toContain('uncertified')
      expect(packet.length).toBeLessThanOrEqual(4000)
    })
  }

  it('holdout: differently phrased creation request keeps the same boundary', () => {
    for (const root of ['生成一个网页动画,展示加载转圈效果。', 'Draft an SVG page with a loading spinner.']) {
      const { derive } = fixture(root, `rf0102-holdout-${root.length}`)
      const projection = derive()
      const packet = renderRecoveryPacket(projection)
      expectNoOldQualificationDemand(packet)
      expect(packet).toContain('R001')
    }
  })

  it('compact 512 budget keeps the ordinary framing and never the checkpoint prerequisite', () => {
    const { derive } = fixture('创建一个 HTML 动画页面,展示一个小球弹跳。', 'rf0102-compact')
    const packet = renderRecoveryPacket(derive(), { charBudget: 512 })
    expect(packet.length).toBeLessThanOrEqual(512)
    expectNoOldQualificationDemand(packet)
    expect(packet).toContain('[R001]')
  })
})

describe('RF03/RF04: observed facts are not re-reported as missing', () => {
  it('an exact modify with persisted effect and readback is consistent across checkpoint and recovery', async () => {
    const path = '/work/alpha.txt'
    const { session, derive } = fixture(`Modify ${path} to native-v070.`, 'rf03-modify-readback')
    session.append('tool/call', { turn: 1, step: 1, callId: 'file-edit' as never, name: 'edit',
      arguments: JSON.stringify({ file_path: path, old_string: 'before', new_string: 'native-v070' }) })
    session.append('tool/result', { turn: 1, step: 1,
      message: createToolResultMessage({ callId: 'file-edit' as never, content: [{ type: 'text', text: 'edited' }], isError: false }) },
    { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 2, callId: 'file-observe' as never, name: 'context_guard_observe_file',
      arguments: JSON.stringify({ effect_call_id: 'file-edit' }) })
    const digest = 'a'.repeat(64)
    session.append('tool/result', { turn: 1, step: 2,
      message: createToolResultMessage({ callId: 'file-observe' as never,
        content: [{ type: 'text', text: JSON.stringify({ status: 'observed', path, sha256: digest, action: 'modify', effect_call_id: 'file-edit' }) }], isError: false }),
      meta: { contextGuardNativeFile: { effectCallId: 'file-edit', path, sha256: digest, action: 'modify' } } } as never,
    { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 3, callId: 'file-read' as never, name: 'read',
      arguments: JSON.stringify({ file_path: path }) })
    session.append('tool/result', { turn: 1, step: 3,
      message: createToolResultMessage({ callId: 'file-read' as never,
        content: [{ type: 'text', text: 'native-v070\n' }], isError: false }), meta: { path } } as never,
    { surfaceOp: 'append' })
    const projection = derive()
    const checkpoint = await createCheckpointTool(() => projection, () => {}).execute({ bindings: [] } as never, undefined as never) as Record<string, unknown>
    // Independent expectation: both surfaces agree the matched object's facts
    // were observed; recovery reports no missing evidence for it.
    expect(checkpoint).toMatchObject({ status: 'observed', feedback_source: 'confirmed_core_v2' })
    const packet = renderRecoveryPacket(projection)
    expect(packet).not.toContain('[R001]')
    expect(packet).not.toContain('missing_evidence')
    expect(packet).not.toContain('insufficient')
  })

  it('a satisfied npm test is not re-reported as pending evidence by recovery', async () => {
    const { session, derive } = fixture('Run npm test in /work.', 'rf04-npm-satisfied')
    appendTest(session, 'ok')
    const projection = derive()
    expect(currentV6Feedback(projection)?.status).toBe('observed')
    const checkpoint = await createCheckpointTool(() => projection, () => {}).execute({ bindings: [] } as never, undefined as never) as Record<string, unknown>
    expect(checkpoint).toMatchObject({ status: 'observed', open_items: [] })
    const packet = renderRecoveryPacket(projection)
    expect(packet).not.toContain('[R001]')
    expect(packet).not.toContain('missing_evidence')
    expectNoOldQualificationDemand(packet)
  })
})

describe('RF05/RF06: genuinely unmet work stays visible', () => {
  it('an unrun test and a latest failed test both keep an unmet current requirement row', () => {
    const unrun = fixture('Run npm test in /work.', 'rf05-unrun').derive()
    const unrunPacket = renderRecoveryPacket(unrun)
    expect(currentV6Feedback(unrun)?.openIds).toContain('R001')
    expect(unrunPacket).toContain('[R001]')
    expect(unrunPacket).toContain('insufficient')

    const failed = fixture('Run npm test in /work.', 'rf05-failed')
    appendTest(failed.session, 'ok')
    appendTest(failed.session, 'bad', true)
    const failedPacket = renderRecoveryPacket(failed.derive())
    expect(failedPacket).toContain('[R001]')
    expect(failedPacket).toContain('insufficient')
    expect(failedPacket).not.toContain('legacy_review')
  })

  it('a successful host call on the wrong workdir does not satisfy the current requirement', () => {
    const { session, derive } = fixture('Run npm test in /work.', 'rf06-wrong-target')
    session.append('tool/call', { turn: 1, step: 1, callId: 'other-dir' as never, name: 'bash',
      arguments: JSON.stringify({ command: 'npm test', workdir: '/other' }) })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'other-dir' as never,
      content: [{ type: 'text', text: '10 tests passed' }], isError: false }) } as never, { surfaceOp: 'append' })
    const projection = derive()
    expect(currentV6Feedback(projection)?.predicates.R001).not.toBe('satisfied')
    const packet = renderRecoveryPacket(projection)
    expect(packet).toContain('[R001]')
    expect(packet).toContain('insufficient')
  })
})

describe('RF07: prohibitions and precise waits survive recovery', () => {
  it('a sourced prohibition stays a standing DO NOT rule in the v6 packet', () => {
    const { derive } = fixture('请只修改 packages/api/src/request.ts。错误日志还提到了 packages/web/src/request.ts，但本轮不要动后者。', 'rf07-prohibition')
    const projection = derive()
    expect(currentV6Feedback(projection)?.predicates.P001).toBe('constraint_active')
    for (const budget of [512, 4000]) {
      const packet = renderRecoveryPacket(projection, { charBudget: budget })
      expect(packet.length).toBeLessThanOrEqual(budget)
      expect(packet).toContain('DO NOT')
      expectNoOldQualificationDemand(packet)
    }
  })

  it('a root confirmation wait keeps its exact resume event and is not released by a bare continue', () => {
    const { session, derive } = fixture('请在收到我的确认后再推送代码。', 'rf07-wait')
    const before = derive()
    const waiting = [...before.items.values()].find((item) => item.waitAuthorization)!
    expect(waiting.resumeEvent).toBeTruthy()
    const packet = renderRecoveryPacket(before)
    expect(packet).toContain('root_condition_pending')
    expect(packet).toContain(waiting.resumeEvent!)
    expect(packet).toContain('do not execute before release')

    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } } as never)
    session.append('turn/start', { turn: 2 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const after = derive()
    const core = after.coreV2 as { predicates: Record<string, string>; conditions: Record<string, string> }
    expect(core.predicates[waiting.id]).not.toBe('satisfied')
    const afterPacket = renderRecoveryPacket(after)
    expect(afterPacket).toContain('root_condition_pending')
    expect(afterPacket).toContain(waiting.resumeEvent!)
    // Review F1 combo: the unreleased wait must also survive the compact
    // budget after the bare continue, not only the full packet.
    const compact = renderRecoveryPacket(after, { charBudget: 512 })
    expect(compact).toContain('root_condition_pending')
    expect(compact).toContain('do not execute before release')
  })
})

describe('review F1: real waits outrank ordinary work at every budget', () => {
  it('keeps the confirmation wait beside multiple ordinary tasks under 512/1000/4000', () => {
    const { derive } = fixture('请先运行 npm test,再修改 /work/beta.txt。请在收到我的确认后再推送代码。', 'review-f1')
    const projection = derive()
    const waiting = [...projection.items.values()].find((item) => item.waitAuthorization)!
    expect(waiting).toBeDefined()
    expect(projection.coreV2?.unmet_requirements).toContain(waiting.id)
    for (const budget of [512, 1000, 4000]) {
      const packet = renderRecoveryPacket(projection, { charBudget: budget })
      expect(packet.length, `budget ${budget}`).toBeLessThanOrEqual(budget)
      expect(packet, `budget ${budget}`).toContain('root_condition_pending')
      expect(packet, `budget ${budget}`).toContain(waiting.resumeEvent!)
      expect(packet, `budget ${budget}`).toContain('do not execute before release')
    }
  })

  it('keeps prohibition and wait together beside several work rows at the emergency budget', () => {
    const { derive } = fixture('请只修改 packages/api/src/request.ts。错误日志还提到了 packages/web/src/request.ts,但本轮不要动后者。请先运行 npm test。请在收到我的确认后再推送代码。', 'review-f1-combined')
    const projection = derive()
    const waiting = [...projection.items.values()].find((item) => item.waitAuthorization)!
    expect(waiting).toBeDefined()
    expect(currentV6Feedback(projection)?.predicates.P001).toBe('constraint_active')
    const packet = renderRecoveryPacket(projection, { charBudget: 512 })
    expect(packet.length).toBeLessThanOrEqual(512)
    expect(packet).toContain('DO NOT')
    expect(packet).toContain('root_condition_pending')
    expect(packet).toContain(waiting.resumeEvent!)
    expect(packet).toContain('do not execute before release')
    expect(packet).toMatch(/folded/)
    expectNoOldQualificationDemand(packet)
  })
})

describe('RF08: current unit scope excludes historical sibling noise', () => {
  it('a stale pending sibling-unit record does not join the current recovery rows', () => {
    const { derive } = fixture('Run npm test in /work.', 'rf08-sibling')
    const projection = derive()
    const stale = structuredClone([...projection.items.values()].find((item) => item.id === 'R001')!)
    stale.id = 'R900'
    stale.sourceMessageId = 'm900:0'
    stale.unitId = 'U900'
    projection.items.set('R900', stale)
    projection.units.set('U900', { unitId: 'U900', openedAtSeq: 0, rootInputRefs: [{ seq: 0 }], headline: 'old sibling' })
    const packet = renderRecoveryPacket(projection)
    expect(packet).toContain('[R001]')
    expect(packet).not.toContain('R900')
  })
})

describe('RF10: digest binds to the displayed current feedback', () => {
  it('unrelated history does not re-arm the reminder; real requirement changes do', () => {
    const { session, derive } = fixture('Run npm test in /work.', 'rf10-digest')
    const before = derive()
    const base = recoveryDigest(renderRecoveryPacket(before), before)
    expect(recoveryDigest(renderRecoveryPacket(before), before)).toBe(base)

    // An unrelated host exchange changes the waterline but no current predicate.
    session.append('tool/call', { turn: 1, step: 2, callId: 'unrelated' as never, name: 'bash',
      arguments: JSON.stringify({ command: 'echo unrelated', workdir: '/work' }) })
    session.append('tool/result', { turn: 1, step: 2, message: createToolResultMessage({ callId: 'unrelated' as never,
      content: [{ type: 'text', text: 'unrelated' }], isError: false }) } as never, { surfaceOp: 'append' })
    const afterNoise = derive()
    expect(recoveryDigest(renderRecoveryPacket(afterNoise), afterNoise)).toBe(base)

    // A matching result changes the predicate and must change the digest.
    appendTest(session, 'ok')
    const satisfied = derive()
    expect(recoveryDigest(renderRecoveryPacket(satisfied), satisfied)).not.toBe(base)
  })

  it('releasing a root wait changes the digest and reopens ordinary work framing', () => {
    const { derive } = fixture('请在收到我的确认后再推送代码。', 'rf10-wait-release')
    const before = derive()
    const waiting = [...before.items.values()].find((item) => item.waitAuthorization)!
    const base = recoveryDigest(renderRecoveryPacket(before), before)
    expect(renderRecoveryPacket(before)).toContain('root_condition_pending')
    // The confirmed core releasing the condition is a real state change: the
    // reminder must follow it instead of repeating the wait forever.
    const core = before.coreV2 as { conditions: Record<string, string> }
    core.conditions[`condition:${waiting.id}`] = 'released'
    const released = renderRecoveryPacket(before)
    expect(released).not.toContain('root_condition_pending')
    expect(recoveryDigest(released, before)).not.toBe(base)
  })
})

describe('RF11: budgets keep constraints, counts, and the ordinary rule', () => {
  it('folds large obligation sets without losing standing constraints or the no-prerequisite rule', () => {
    const { derive } = fixture('Run npm test in /work.', 'rf11-budget')
    const projection = derive()
    const original = projection.items.get('R001')!
    const ids = Array.from({ length: 14 }, (_, index) => `R${String(index + 10).padStart(3, '0')}`)
    for (const id of ids) projection.items.set(id, { ...structuredClone(original), id, normalizedText: `长文本义务描述条目 ${id} `.repeat(12) })
    projection.coreV2 = {
      ...(projection.coreV2 as Record<string, unknown>),
      certifiable: false,
      unmet_requirements: ids,
      predicates: Object.fromEntries([
        ...ids.map((id) => [id, 'insufficient'] as const),
        ['R001', 'satisfied'] as const,
        ['P001', 'constraint_active'] as const,
        ['P002', 'constraint_active'] as const,
      ]),
      current_actions: [],
    }
    projection.items.set('P001', { ...structuredClone(original), id: 'P001', kind: 'prohibition', normalizedText: 'never force delete holders' })
    projection.items.set('P002', { ...structuredClone(original), id: 'P002', kind: 'prohibition', normalizedText: 'never restart to force it' })
    for (const budget of [512, 1000, 4000]) {
      const packet = renderRecoveryPacket(projection, { charBudget: budget })
      expect(packet.length, `budget ${budget}`).toBeLessThanOrEqual(budget)
      expect(packet, `budget ${budget}`).toContain('DO NOT')
      expect(packet, `budget ${budget}`).not.toContain('Checkpoint required before completion')
      expect(packet, `budget ${budget}`).toMatch(/folded/)
      expect(packet, `budget ${budget}`).toContain('14')
    }
    const compact = renderRecoveryPacket(projection, { charBudget: 512 })
    expect(compact).toContain('unmet')
    expectNoOldQualificationDemand(compact)
  })
})

describe('RF12: unavailable facts stay unknown instead of regressing to old debt', () => {
  const cases = [
    ['host lock unavailable', (projection: ReturnType<ReturnType<typeof fixture>['derive']>) => { projection.hostStatus = 'unavailable' }, 'host_lock_unsupported'],
    ['core projection missing', (projection: ReturnType<ReturnType<typeof fixture>['derive']>) => { projection.coreV2 = undefined }, 'core_projection_unavailable'],
    ['durability unconfirmed', (projection: ReturnType<ReturnType<typeof fixture>['derive']>) => { projection.durabilityWatermark = 'failed' }, 'core_projection_unavailable'],
  ] as const
  for (const [name, mutate, expectedReason] of cases) {
    it(`${name}: packet reports the bounded unknown reason`, () => {
      const { derive } = fixture('创建一个 HTML 动画页面,展示一个小球弹跳。', `rf12-${name}`)
      const projection = derive()
      mutate(projection)
      const packet = renderRecoveryPacket(projection)
      expect(packet).toContain(expectedReason)
      expectNoOldQualificationDemand(packet)
      // Fail-closed: an unavailable view never claims completion either.
      expect(packet.toLowerCase()).not.toContain('closure observed')
      expect(packet).not.toContain('certificate')
    })
  }

  it('a derived requirement whose display source mapping is lost reports unknown', () => {
    const { derive } = fixture('Run pnpm test in /work. Use the read-only context_guard_observe_test_readiness tool for this current test.', 'rf12-source-mapping')
    const projection = derive()
    const derived = Object.keys(currentV6Feedback(projection)?.predicates ?? {}).find((id) => id.includes(':observer:'))
    expect(derived).toBeTruthy()
    projection.coreV2RequirementOrigins = undefined
    const packet = renderRecoveryPacket(projection)
    expect(packet).toContain('core_requirement_source_unavailable')
    expectNoOldQualificationDemand(packet)
  })

  it('review F2: unavailable facts keep the sourced root prohibition and wait visible', () => {
    const prohibition = fixture('Run npm test. Do not modify /work/secrets.txt.', 'review-f2-prohibition')
    const faults = [
      (projection: ReturnType<ReturnType<typeof fixture>['derive']>) => { projection.coreV2 = undefined },
      (projection: ReturnType<ReturnType<typeof fixture>['derive']>) => { projection.durabilityWatermark = 'failed' },
      (projection: ReturnType<ReturnType<typeof fixture>['derive']>) => { projection.hostStatus = 'unavailable' },
    ] as const
    for (const [index, fault] of faults.entries()) {
      const projection = prohibition.derive()
      expect(currentV6Feedback(projection)?.predicates.P001).toBe('constraint_active')
      fault(projection)
      expect(currentV6Feedback(projection)?.status, `fault ${index}`).toBe('unknown')
      for (const budget of [512, 4000]) {
        const packet = renderRecoveryPacket(projection, { charBudget: budget })
        expect(packet.length, `fault ${index} budget ${budget}`).toBeLessThanOrEqual(budget)
        expect(packet, `fault ${index} budget ${budget}`).toMatch(/unknown \(/)
        expect(packet, `fault ${index} budget ${budget}`).toContain('DO NOT')
        expectNoOldQualificationDemand(packet)
      }
      const full = renderRecoveryPacket(projection)
      expect(full).toContain('/work/secrets.txt')
    }
    // The same holds for a precise root wait beside the unavailable view.
    const wait = fixture('请在收到我的确认后再推送代码。', 'review-f2-wait')
    const waitProjection = wait.derive()
    const waiting = [...waitProjection.items.values()].find((item) => item.waitAuthorization)!
    waitProjection.coreV2 = undefined
    for (const budget of [512, 4000]) {
      const packet = renderRecoveryPacket(waitProjection, { charBudget: budget })
      expect(packet, `wait budget ${budget}`).toContain('root_condition_pending')
      expect(packet, `wait budget ${budget}`).toContain(waiting.resumeEvent!)
      expect(packet, `wait budget ${budget}`).toContain('do not execute before release')
    }
  })

  it('review F2: unverifiable root integrity states it cannot safely recover boundaries', () => {
    const { derive } = fixture('Run npm test. Do not modify /work/secrets.txt.', 'review-f2-integrity')
    const projection = derive()
    projection.coreV2 = undefined
    projection.integrity = 'unknown'
    const packet = renderRecoveryPacket(projection)
    expect(packet).toMatch(/unknown \(/)
    // Without verifiable root sources the packet must not list boundary rows it
    // cannot trust, and must not claim they are preserved.
    expect(packet).not.toContain('DO NOT')
    expect(packet.toLowerCase()).not.toContain('remain enforced')
    expect(packet).toMatch(/cannot be safely recovered|unverifiable/i)
  })
})

describe('review F3: surfaced constraint states need verifiable display sources', () => {  it('an active prohibition that loses its display source turns every consumer unknown', async () => {
    const { derive } = fixture('Do not modify /work/secrets.txt.', 'review-f3-prohibition')
    const projection = derive()
    expect(currentV6Feedback(projection)?.predicates.P001).toBe('constraint_active')
    projection.items.delete('P001')
    const feedback = currentV6Feedback(projection)
    expect(feedback).toMatchObject({ status: 'unknown', reasonCode: 'core_requirement_source_unavailable' })
    const checkpoint = await createCheckpointTool(() => projection, () => {}).execute({ bindings: [] } as never, undefined as never) as Record<string, unknown>
    expect(checkpoint).toMatchObject({ status: 'unknown', reason_code: 'core_requirement_source_unavailable' })
    const prepared = await createPrepareTool({ getProjection: () => projection }).execute({} as never, undefined as never) as Record<string, unknown>
    expect(prepared).toMatchObject({ status: 'unknown', reason_code: 'core_requirement_source_unavailable' })
    const packet = renderRecoveryPacket(projection)
    expect(packet).toContain('core_requirement_source_unavailable')
    // No sourceless row is ever rendered: the blank `DO NOT [P001]` is gone.
    expect(packet).not.toContain('DO NOT [P001]')
    expect(packet).not.toContain('DO NOT')
  })

  it('a satisfied requirement without a display source does not collapse the observed view', async () => {
    const { session, derive } = fixture('Run npm test in /work.', 'review-f3-satisfied')
    session.append('tool/call', { turn: 1, step: 1, callId: 'ok' as never, name: 'bash', arguments: JSON.stringify({ command: 'npm test', workdir: '/work' }) })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'ok' as never,
      content: [{ type: 'text', text: '10 tests passed' }], isError: false }) } as never, { surfaceOp: 'append' })
    const projection = derive()
    expect(currentV6Feedback(projection)?.status).toBe('observed')
    projection.items.delete('R001')
    // The view never surfaces a satisfied id, so losing its display source is
    // not an availability regression — the bare-continue intent case depends
    // on exactly this distinction.
    expect(currentV6Feedback(projection)).toMatchObject({ status: 'observed' })
    const checkpoint = await createCheckpointTool(() => projection, () => {}).execute({ bindings: [] } as never, undefined as never) as Record<string, unknown>
    expect(checkpoint).toMatchObject({ status: 'observed' })
  })
})

describe('RF13/RF14: historical lanes keep their original strictness', () => {
  it('a pre-v6 session keeps the strict clarification and wait lanes byte-compatible', () => {
    const wait = Session.create(SessionId('rf13-legacy-wait'))
    wait.append('user/message', createUserMessage({ content: [{ type: 'text', text: '请在收到我的确认后再推送代码。' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const legacyWait = deriveProjection(wait.snapshotEvents() as never, { activation: 'always' }, {}, true, HOST).projection
    const waitPacket = renderRecoveryPacket(legacyWait)
    expect(waitPacket).toContain('root_condition_pending')
    const waitItem = [...legacyWait.items.values()].find((item) => item.waitAuthorization)!
    expect(waitPacket).toContain(waitItem.resumeEvent!)

    const create = Session.create(SessionId('rf13-legacy-create'))
    create.append('user/message', createUserMessage({ content: [{ type: 'text', text: '创建一个 HTML 动画页面,展示一个小球弹跳。' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const legacyCreate = deriveProjection(create.snapshotEvents() as never, { activation: 'always' }, {}, true, HOST).projection
    // No v6 boundary: the historical target-validation lane keeps its exact
    // strict demand for an exact root target choice.
    expect(renderRecoveryPacket(legacyCreate)).toContain('target_clarification_required')
  })

  it('an adopted Goal or release policy keeps the strict recovery lane', () => {
    const { derive } = fixture('创建一个 HTML 动画页面,展示一个小球弹跳。', 'rf14-strict')
    const goal = derive()
    goal.goalCompletionAdopted = true
    expect(currentV6Feedback(goal)).toBeUndefined()
    const goalPacket = renderRecoveryPacket(goal)
    expect(goalPacket).not.toContain('legacy_review')
    expect(goalPacket).toContain('pending')

    const release = derive()
    release.policy = 'release'
    expect(currentV6Feedback(release)).toBeUndefined()
    expect(renderRecoveryPacket(release)).toContain('pending')
  })

  it('an explicitly presented proof keeps the certificate path', async () => {
    const { derive } = fixture('Run npm test in /work.', 'rf14-proof')
    const projection = derive()
    const result = await createCheckpointTool(() => projection, () => {}).execute({ bindings: [], proof: {} } as never, undefined as never) as Record<string, unknown>
    expect(result.feedback_source).toBeUndefined()
    expect(result.proof_state).toMatchObject({ status: 'invalid' })
  })
})

describe('RF15/RF16: ordinary packets never route into the ledger chain', () => {
  it('ordinary v6 packets never recommend interpret or rebind', () => {
    const { derive } = fixture('创建一个 HTML 动画页面,展示一个小球弹跳。', 'rf15-chain')
    const packet = renderRecoveryPacket(derive())
    expect(packet).not.toContain('context_guard_interpret')
    expect(packet).not.toContain('context_guard_rebind')
    expect(packet).not.toContain('partition')
  })

  it('an honestly delivered report closes without manufacturing a certificate', () => {
    const { session, derive } = fixture('Run npm test and report its actual result.', 'rf16-delivery')
    appendTest(session, 'ok')
    session.append('assistant/message', { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: '完成:npm test 已通过,Exit code: 0。' }] } } as never, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } } as never)
    const projection = derive()
    expect(currentV6Feedback(projection)?.status).toBe('observed')
    const packet = renderRecoveryPacket(projection)
    expect(packet).not.toContain('insufficient')
    // Ordinary delivery closes the current view without ever claiming a
    // certificate was requested or issued.
    expect(packet).not.toContain('certificate')
    expect(packet).toContain('closure observed')
  })
})

// Runtime pre-step layer: the registered injection must consume the same view.

interface CheckpointTool { name: string; execute: (args: unknown, exec?: unknown) => Promise<unknown> }
type PreStepHandler = (payload: unknown, next: () => Promise<unknown>) => Promise<{ kind: string; messages?: unknown[] }>

function fakeCtx() {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>()
  return {
    handlers,
    commands: { register: () => {} },
    sessions: { flush: async () => true },
    on: (event: string, handler: (...args: never[]) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler] as never)
    },
  }
}

const PINNED_UPDATE_GOAL_TOOL = {
  name: 'update_goal',
  execute: () => undefined,
  parameters: {
    type: 'object',
    required: ['goal_id', 'revision', 'action'],
    properties: {
      goal_id: { type: 'string' },
      revision: { type: 'number' },
      action: { type: 'string', enum: ['edit', 'pause', 'resume', 'complete', 'blocked'] },
      objective: { type: 'string' },
      max_goal_rounds: { type: 'number' },
      blocked_reason: { type: 'string' },
    },
  },
}

function guardedAgent(session: Session) {
  const registered: CheckpointTool[] = []
  const agent = {
    session,
    steer: () => {},
    ctx: {
      tools: {
        register: (tool: CheckpointTool) => registered.push(tool),
        guard: () => {},
        get: (name: string) => (name === 'update_goal' ? PINNED_UPDATE_GOAL_TOOL : undefined),
      },
      get: (name: string) => (name === 'goals' ? { get: () => undefined, disarm: async () => undefined } : undefined),
    },
  }
  return { agent: agent as unknown as Agent, registered }
}

function startGuard(ctx: ReturnType<typeof fakeCtx>, agent: Agent, source: string) {
  for (const handler of ctx.handlers.get('agent/session-start') ?? []) {
    ;(handler as (payload: { agent: Agent; source: string }) => void)({ agent, source })
  }
}

async function runPreStep(ctx: ReturnType<typeof fakeCtx>, agent: Agent, claimed: unknown[] = []): Promise<{ texts: string[]; messages: unknown[] }> {
  const handler = ctx.handlers.get('agent/pre-step')?.[0] as PreStepHandler | undefined
  const decision = await handler!({ agent, messages: claimed }, async () => ({ kind: 'enter', messages: claimed })) as { kind: string; messages: unknown[] }
  const messages = decision.messages ?? []
  return { texts: messages.map((message) => String(((message as { content?: Array<{ text?: string }> }).content ?? [])[0]?.text ?? '')), messages }
}

function guardApply(ctx: ReturnType<typeof fakeCtx>) {
  apply(ctx as never, {
    activation: 'always', hostLockPackages: EXPECTED_HOST_PACKAGES, hostLockPlatform: 'posix', hostLockProfile: 'web',
  }, { hostLock: HOST })
}

function rawAppend(session: Session): (type: string, data: unknown, opts?: unknown) => unknown {
  return (session as unknown as { append: (type: string, data: unknown, opts?: unknown) => unknown }).append.bind(session)
}

function persistStep(session: Session, messages: unknown[]) {
  const turn = 1 + [...session.snapshotEvents()].filter((event) => (event as { type?: unknown }).type === 'turn/start').length
  rawAppend(session)('turn/start', { turn })
  for (const message of messages) rawAppend(session)('user/message', message, { surfaceOp: 'append' })
  rawAppend(session)('step/start', { turn, step: 1 })
  rawAppend(session)('step/end', { turn, step: 1 })
  rawAppend(session)('turn/end', { turn, reason: { kind: 'completed' } })
}

function claimed(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function freshRuntimeSession(label: string) {
  const id = SessionId(label)
  const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, isSeeded: false, id, createdAt: 1, cwd: '/work' })
  const ctx = fakeCtx()
  guardApply(ctx)
  const guard = guardedAgent(session)
  startGuard(ctx, guard.agent, 'new')
  return { session, ctx, ...guard }
}

describe('RF09: registered pre-step recovery uses accurate trigger titles', () => {
  it('T0 stays silent; the first root carries the boundary once; the next-step reminder names the contract, not compaction', async () => {
    const { session, ctx, agent } = freshRuntimeSession('rf09-title')
    const empty = await runPreStep(ctx, agent, [])
    expect(empty.texts).toHaveLength(0)
    const first = await runPreStep(ctx, agent, [claimed('创建一个 HTML 动画页面,展示一个小球弹跳。')])
    expect(first.texts).toHaveLength(3)
    persistStep(session, first.messages)
    const second = await runPreStep(ctx, agent, [claimed('继续')])
    expect(second.texts).toHaveLength(2)
    const reminder = second.texts.find((text) => text.includes('Open task requirements'))!
    expect(reminder).toBeTruthy()
    expect(reminder).toContain('contract updated')
    expect(reminder).not.toContain('compaction')
    expect(reminder).not.toContain('resume')
    expectNoOldQualificationDemand(reminder)
    // Exactly one boundary across the session's injections.
    const boundaryAgain = await runPreStep(ctx, agent, [claimed('继续')])
    expect(boundaryAgain.texts.filter((text) => text.includes('Context Guard recorded a replay version boundary'))).toHaveLength(0)
  })
})

describe('RF04/RF10: registered pre-step injection follows the current view', () => {
  it('injects nothing for an observed ordinary closure after resume', async () => {
    const { session, ctx, agent, registered } = freshRuntimeSession('rf04-runtime')
    const first = await runPreStep(ctx, agent, [claimed('Run npm test in /work.')])
    persistStep(session, first.messages)
    session.append('tool/call', { turn: 1, step: 2, callId: 'ok' as never, name: 'bash', arguments: JSON.stringify({ command: 'npm test', workdir: '/work' }) })
    session.append('tool/result', { turn: 1, step: 2, message: createToolResultMessage({ callId: 'ok' as never,
      content: [{ type: 'text', text: '10 tests passed' }], isError: false }) } as never, { surfaceOp: 'append' })
    const checkpoint = await registered.find((tool) => tool.name === 'context_guard_checkpoint')!.execute({ bindings: [] }) as Record<string, unknown>
    expect(checkpoint).toMatchObject({ status: 'observed', feedback_source: 'confirmed_core_v2' })
    startGuard(ctx, agent, 'resume')
    const resumed = await runPreStep(ctx, agent, [claimed('继续')])
    expect(resumed.texts).toHaveLength(1)
    expect(resumed.texts[0]).not.toContain('Open task requirements')
  })

  it('injects the unmet view after resume, dedups repeats, and follows real changes', async () => {
    const { session, ctx, agent } = freshRuntimeSession('rf10-runtime')
    const first = await runPreStep(ctx, agent, [claimed('Run npm test in /work.')])
    persistStep(session, first.messages)
    startGuard(ctx, agent, 'resume')
    const resumed = await runPreStep(ctx, agent, [claimed('继续')])
    expect(resumed.texts).toHaveLength(2)
    expect(resumed.texts[0]).toContain('recovered after resume')
    expect(resumed.texts[0]).toContain('insufficient')
    // No new arm: the same content is deduped.
    expect((await runPreStep(ctx, agent, [claimed('继续')])).texts).toHaveLength(1)
    // A new root requirement re-arms with a changed packet.
    session.append('turn/start', { turn: 3 })
    session.append('user/message', claimed('Modify /work/beta.txt to v2.'), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 3, reason: { kind: 'completed' } } as never)
    const changed = await runPreStep(ctx, agent, [claimed('继续')])
    expect(changed.texts).toHaveLength(2)
    expect(changed.texts[0]).toContain('contract updated')
    expect(changed.texts[0]).toContain('insufficient')
  })
})

// Round-2 review regressions: boundary completeness, scope, and release trust.

function siblingFixture(firstRoot: string, idLabel: string) {
  const id = SessionId(idLabel)
  const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, isSeeded: false, id, createdAt: 1, cwd: '/work' })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }],
    source: { kind: 'plugin', plugin: 'context-guard', form: 'notice', summary: 'v6' } }), { surfaceOp: 'append' })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: firstRoot }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Understood; waiting.' }] } } as never, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } } as never)
  session.append('turn/start', { turn: 2 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '另外，更新皮肤中心' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const scope = { cwd: '/work', sessionHeader: { version: SESSION_FORMAT_VERSION, id: String(id), createdAt: 1, seedLength: 0, delegationDepth: 0 } }
  const derive = () => {
    const events = session.snapshotEvents() as never
    const projection = deriveProjection(events, { activation: 'always' }, scope, true, HOST).projection
    projection.durabilityWatermark = 'confirmed'
    const origins: NonNullable<typeof projection.coreV2RequirementOrigins> = new Map()
    projection.coreV2 = projectSessionCoreV2(events, projection, origins)
    projection.coreV2RequirementOrigins = origins
    return projection
  }
  return { session, derive }
}

describe('review R2F1: protected boundary fields are never truncated', () => {
  const token = 'RELEASE-APPROVED-20260922-A7X9'
  it('keeps an exact long confirmation token complete at every budget', () => {
    const { derive } = fixture(`Wait for the user to confirm ${token} before pushing code.`, 'review-r2f1-token')
    const projection = derive()
    const waiting = [...projection.items.values()].find((item) => item.waitAuthorization)!
    expect(waiting).toBeDefined()
    for (const budget of [512, 1000, 4000]) {
      const packet = renderRecoveryPacket(projection, { charBudget: budget })
      expect(packet.length, `budget ${budget}`).toBeLessThanOrEqual(budget)
      expect(packet, `budget ${budget}`).toContain(token)
      expect(packet, `budget ${budget}`).toContain('do not execute before release')
      expect(packet, `budget ${budget}`).toContain('root_condition_pending')
    }
  })

  it('keeps the complete prohibition text and wait tail beside each other at 512', () => {
    const { derive } = fixture('Do not modify /work/secrets.txt. 请在收到我的最终明确确认后再推送代码。', 'review-r2f1-combined')
    const projection = derive()
    const packet = renderRecoveryPacket(projection, { charBudget: 512 })
    expect(packet.length).toBeLessThanOrEqual(512)
    expect(packet).toContain('DO NOT [P001] modify /work/secrets')
    expect(packet).toContain('收到我的最终明确确认')
    expect(packet).toContain('do not execute before release')
    // A displayed boundary is semantically complete: no clipped tail inside it.
    expect(packet).not.toMatch(/do not execut…/)
    expect(packet).not.toMatch(/DO NOT \[P001\] modify \/work\/secr…/)
  })
})

describe('review R2F2/R2F3: boundary scope and release trust', () => {
  it('an unknown view does not resurrect a switched-away sibling wait or prohibition', () => {
    for (const [name, firstRoot, marker] of [
      ['wait', '请在收到我的确认后再推送代码。', 'root_condition_pending'],
      ['prohibition', 'Do not modify /work/secrets.txt.', 'DO NOT'],
    ] as const) {
      const { derive } = siblingFixture(firstRoot, `review-r2f2-${name}`)
      const projection = derive()
      expect(projection.currentUnitId).toBe('U002')
      expect(projection.units.get('U002')!.parentUnitId).toBeUndefined()
      // With the core available the old unit's boundary is already excluded.
      expect(renderRecoveryPacket(projection)).not.toContain(marker)
      projection.coreV2 = undefined
      expect(currentV6Feedback(projection)?.status).toBe('unknown')
      const unknown = renderRecoveryPacket(projection)
      expect(unknown, name).not.toContain(marker)
      expect(unknown, name).not.toContain('收到我的确认')
      expect(unknown, name).not.toContain('/work/secrets')
      // The digest's boundary identity is the same selector: flipping the old
      // unit's stale item status must not re-arm the unknown-lane reminder.
      const base = recoveryDigest(unknown, projection)
      const stale = [...projection.items.values()].find((item) => item.unitId === 'U001')!
      stale.status = 'superseded'
      expect(recoveryDigest(renderRecoveryPacket(projection), projection)).toBe(base)
    }
  })

  it('an applicable ancestor prohibition still reaches the current unit through the selector', () => {
    const { derive } = siblingFixture('Do not modify /work/secrets.txt.', 'review-r2f2-ancestor')
    const projection = derive()
    // Hand-built lineage (a delegated parent chain derive cannot produce for a
    // current unit): the selector must still honor an applicable ancestor.
    projection.units.get('U002')!.parentUnitId = 'U001'
    projection.coreV2 = undefined
    const packet = renderRecoveryPacket(projection)
    expect(packet).toContain('DO NOT')
    expect(packet).toContain('/work/secrets')
  })

  it('a corrupt core with a residual released condition cannot discharge the wait', () => {
    const { derive } = fixture('请在收到我的确认后再推送代码。', 'review-r2f3-corrupt')
    const projection = derive()
    const waiting = [...projection.items.values()].find((item) => item.waitAuthorization)!
    const core = projection.coreV2 as { schema: string; conditions: Record<string, string> }
    core.conditions[`condition:${waiting.id}`] = 'released'
    core.schema = 'core-state/broken'
    expect(currentV6Feedback(projection)?.status).toBe('unknown')
    for (const budget of [512, 4000]) {
      const packet = renderRecoveryPacket(projection, { charBudget: budget })
      expect(packet, `budget ${budget}`).toContain('root_condition_pending')
      expect(packet, `budget ${budget}`).toContain('收到我的确认')
      expect(packet, `budget ${budget}`).toContain('do not execute before release')
    }
    // The same distrust applies when only durability failed.
    const restored = fixture('请在收到我的确认后再推送代码。', 'review-r2f3-durability').derive()
    const restoredCore = restored.coreV2 as { conditions: Record<string, string> }
    const restoredWait = [...restored.items.values()].find((item) => item.waitAuthorization)!
    restoredCore.conditions[`condition:${restoredWait.id}`] = 'released'
    restored.durabilityWatermark = 'failed'
    expect(currentV6Feedback(restored)?.status).toBe('unknown')
    expect(renderRecoveryPacket(restored)).toContain('root_condition_pending')
  })

  it('a verified release still legitimately drops the wait', () => {
    const { derive } = fixture('请在收到我的确认后再推送代码。', 'review-r2f3-verified')
    const projection = derive()
    const waiting = [...projection.items.values()].find((item) => item.waitAuthorization)!
    const core = projection.coreV2 as { conditions: Record<string, string> }
    core.conditions[`condition:${waiting.id}`] = 'released'
    // The core object itself stays verified, so the release is trusted and the
    // wait no longer applies — unknown facts never mean permanent re-waiting.
    const full = renderRecoveryPacket(projection)
    expect(full).not.toContain('root_condition_pending')
    // With the core gone entirely the release is no longer observable, so the
    // durable wait returns: fail-closed keeps the boundary until a trusted
    // release fact is readable again.
    projection.coreV2 = undefined
    expect(renderRecoveryPacket(projection)).toContain('root_condition_pending')
  })
})

// Round-3 review regression: a boundary reference row must resolve to a real
// read-only detail entry whose actual output carries the complete original
// text — verified by calling the tools, not by checking packet strings.

describe('review R3F1: boundary references resolve through real entries', () => {
  const longPath = '/work/projects/' + 'protected-component/'.repeat(15) + 'secrets.env'
  const longToken = 'RELEASE_' + 'EXACT_'.repeat(45) + 'APPROVED'

  it('a long prohibition reference resolves to the full recorded text with the core available', async () => {
    const { derive } = fixture(`Do not modify ${longPath}.`, 'review-r3f1-prohibition')
    const projection = derive()
    expect(currentV6Feedback(projection)?.predicates.P001).toBe('constraint_active')
    const compact = renderRecoveryPacket(projection, { charBudget: 512 })
    expect(compact.length).toBeLessThanOrEqual(512)
    expect(compact).toContain('DO NOT [P001]')
    expect(compact).toContain('exact text: context_guard_prepare')
    expect(compact).not.toContain(longPath)
    // The reference is resolvable: the actual by-ID prepare output carries the
    // complete prohibition object, byte for byte.
    const detail = await createPrepareTool({ getProjection: () => projection }).execute({ item_id: 'P001' } as never, undefined as never) as Record<string, unknown>
    expect(detail).toMatchObject({ status: 'active', reason_code: 'constraint_active' })
    expect(JSON.stringify(detail)).toContain(longPath)
    // Discovery lists the standing constraint the packet's footer names, and
    // checkpoint carries the text on the constraint row and through detail.
    const discovery = await createPrepareTool({ getProjection: () => projection }).execute({} as never, undefined as never) as Record<string, unknown>
    expect(JSON.stringify(discovery)).toContain('P001')
    const checkpoint = await createCheckpointTool(() => projection, () => {}).execute({ bindings: [] } as never, undefined as never) as Record<string, unknown>
    expect(JSON.stringify(checkpoint.active_constraints)).toContain(longPath)
    const detailPage = await createCheckpointTool(() => projection, () => {}).execute({ bindings: [], detail_id: 'P001' } as never, undefined as never) as Record<string, unknown>
    expect(String(detailPage.detail_chunk)).toContain(longPath)
    // At larger budgets the full text rides in the packet itself.
    for (const budget of [1000, 4000]) {
      expect(renderRecoveryPacket(projection, { charBudget: budget }), `budget ${budget}`).toContain(longPath)
    }
  })

  it('a long wait reference resolves under an unknown core through prepare by id', async () => {
    const { derive } = fixture(`Wait for the user to confirm ${longToken} before pushing code.`, 'review-r3f1-wait-unknown')
    const projection = derive()
    const waiting = [...projection.items.values()].find((item) => item.waitAuthorization)!
    expect(waiting).toBeDefined()
    projection.coreV2 = undefined
    expect(currentV6Feedback(projection)?.status).toBe('unknown')
    const compact = renderRecoveryPacket(projection, { charBudget: 512 })
    expect(compact.length).toBeLessThanOrEqual(512)
    expect(compact).toContain('root_condition_pending')
    expect(compact).toContain('exact condition: context_guard_prepare')
    expect(compact).toContain('do not execute before release')
    expect(compact).not.toContain(longToken)
    // Raw readability is separated from state confirmation: the unknown status
    // stays, and the recorded text — the exact confirmation token, byte for
    // byte — still comes back. (This phrasing carries the token in the
    // recorded clause text rather than an extracted resume event.)
    const detail = await createPrepareTool({ getProjection: () => projection }).execute({ item_id: waiting.id } as never, undefined as never) as Record<string, unknown>
    expect(detail).toMatchObject({ status: 'unknown', reason_code: 'core_projection_unavailable' })
    expect(String((detail.item as Record<string, unknown>).text)).toContain(longToken)
    expect(String(JSON.stringify(detail))).toContain('root_condition_pending')
    expect(String(detail.next_step)).toContain('unknown')
    for (const budget of [1000, 4000]) {
      expect(renderRecoveryPacket(projection, { charBudget: budget }), `budget ${budget}`).toContain(longToken)
    }
  })

  it('a normal-length wait stays fully retrievable with the core available', async () => {
    const token = 'RELEASE-APPROVED-20260922-A7X9'
    const { derive } = fixture(`Wait for the user to confirm ${token} before pushing code.`, 'review-r3f1-wait-valid')
    const projection = derive()
    const waiting = [...projection.items.values()].find((item) => item.waitAuthorization)!
    expect(renderRecoveryPacket(projection, { charBudget: 512 })).toContain(token)
    // A publish-semantics wait answers through the detailed diagnosis lane;
    // the exact token is byte-complete in the response either way.
    const detail = await createPrepareTool({ getProjection: () => projection }).execute({ item_id: waiting.id } as never, undefined as never) as Record<string, unknown>
    expect(JSON.stringify(detail)).toContain(token)
    expect(JSON.stringify(detail)).toContain('root_condition_pending')
  })
})

// Round-4 review regressions: a wait RECORD is history until the shared
// pending predicate says otherwise, and the unknown detail honors the same
// revision identity the normal lane enforces.

describe('review R4F1/R4F2: wait state derivation and revision identity in details', () => {
  it('a verifiably released wait is not re-asserted as a current pending wait', async () => {
    const { derive } = fixture('请在收到我的确认后再推送代码。', 'review-r4f1-released')
    const projection = derive()
    const waiting = [...projection.items.values()].find((item) => item.waitAuthorization)!
    const core = projection.coreV2 as { conditions: Record<string, string> }
    core.conditions[`condition:${waiting.id}`] = 'released'
    // The recovery packet already drops the wait (round-2 positive).
    expect(renderRecoveryPacket(projection)).not.toContain('root_condition_pending')
    // The prepare detail agrees: the record stays readable as history, but no
    // current confirmation debt is asserted.
    const detail = await createPrepareTool({ getProjection: () => projection }).execute({ item_id: waiting.id } as never, undefined as never) as Record<string, unknown>
    expect(JSON.stringify(detail)).not.toContain('root_condition_pending')
    expect((detail.item as Record<string, unknown>).recorded_wait).toMatchObject({ resume_event: '收到我的确认' })
  })

  it('a naturally superseded wait answers as history without a pending assertion', async () => {
    const id = SessionId('review-r4f1-superseded')
    const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, isSeeded: false, id, createdAt: 1, cwd: '/work' })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }],
      source: { kind: 'plugin', plugin: 'context-guard', form: 'notice', summary: 'v6' } }), { surfaceOp: 'append' })
    const roots = [
      'Push repository /work/repo to remote origin refspec refs/heads/main:refs/heads/main.',
      '请在收到我的确认后再执行推送。',
      'Push repository /work/repo to remote origin refspec refs/heads/main:refs/heads/main.',
    ]
    roots.forEach((root, index) => {
      session.append('turn/start', { turn: index + 1 })
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: root }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      session.append('turn/end', { turn: index + 1, reason: { kind: 'completed' } } as never)
    })
    const events = session.snapshotEvents() as never
    const projection = deriveProjection(events, { activation: 'always' }, { cwd: '/work', sessionHeader: { version: SESSION_FORMAT_VERSION, id: String(id), createdAt: 1, seedLength: 0, delegationDepth: 0 } }, true, HOST).projection
    projection.durabilityWatermark = 'confirmed'
    const origins: NonNullable<typeof projection.coreV2RequirementOrigins> = new Map()
    projection.coreV2 = projectSessionCoreV2(events, projection, origins)
    projection.coreV2RequirementOrigins = origins
    const oldWait = [...projection.items.values()].find((item) => item.waitAuthorization && item.status === 'superseded')!
    expect(oldWait).toBeDefined()
    const detail = await createPrepareTool({ getProjection: () => projection }).execute({ item_id: oldWait.id } as never, undefined as never) as Record<string, unknown>
    expect(detail).toMatchObject({ status: 'observed', reason_code: 'historical_item_not_current' })
    expect((detail.item as Record<string, unknown>).status).toBe('historical')
    expect(JSON.stringify(detail)).not.toContain('"wait":"root_condition_pending"')
    expect((detail.item as Record<string, unknown>).recorded_wait).toBeTruthy()
    // A still-pending wait in the same session keeps its current assertion.
    // (Here R003 is ordinary work, so the recovery packet needs no wait row.)
    expect(renderRecoveryPacket(projection)).not.toContain('root_condition_pending')
  })

  it('the unknown detail honors the caller item_revision binding like the normal lane', async () => {
    const { derive } = fixture('Do not modify /work/secrets.txt.', 'review-r4f2-revision')
    const projection = derive()
    projection.coreV2 = undefined
    expect(currentV6Feedback(projection)?.status).toBe('unknown')
    const mismatch = await createPrepareTool({ getProjection: () => projection }).execute({ item_id: 'P001', item_revision: 999 } as never, undefined as never) as Record<string, unknown>
    expect(mismatch).toMatchObject({ status: 'rejected', reason_code: 'item_revision_mismatch' })
    expect(JSON.stringify(mismatch)).not.toContain('/work/secrets.txt')
    const exact = await createPrepareTool({ getProjection: () => projection }).execute({ item_id: 'P001', item_revision: 1 } as never, undefined as never) as Record<string, unknown>
    expect(exact).toMatchObject({ status: 'unknown', reason_code: 'core_projection_unavailable' })
    expect(String((exact.item as Record<string, unknown>).text)).toContain('/work/secrets.txt')
  })
})

// Round-5 review regression: the shared wait predicate carries the current
// scope, so a switched-away sibling's pending audit record reads as history
// everywhere, while current and applicable-ancestor waits keep their marker.

describe('review R5: wait pending assertion carries the current scope', () => {
  it('a switched-away sibling wait keeps text and recorded_wait but no current marker', async () => {
    for (const [view, breakCore] of [['core-valid', false], ['core-unknown', true]] as const) {
      const { derive } = siblingFixture('请在收到我的确认后再推送代码。', `review-r5-sibling-${view}`)
      const projection = derive()
      expect(projection.currentUnitId).toBe('U002')
      const oldWait = [...projection.items.values()].find((item) => item.waitAuthorization)!
      expect(oldWait.unitId).toBe('U001')
      expect(oldWait.status).toBe('pending')
      if (breakCore) projection.coreV2 = undefined
      const detail = await createPrepareTool({ getProjection: () => projection }).execute({ item_id: oldWait.id } as never, undefined as never) as Record<string, unknown>
      expect(view).toBeTruthy()
      // The full recorded history stays readable; only the CURRENT-wait
      // assertion is gone.
      expect(String((detail.item as Record<string, unknown>).text)).toContain('推送代码')
      expect((detail.item as Record<string, unknown>).recorded_wait).toMatchObject({ resume_event: '收到我的确认' })
      expect(JSON.stringify(detail)).not.toContain('"wait":"root_condition_pending"')
      // Recovery already excluded the sibling; nothing regressed there.
      expect(renderRecoveryPacket(projection)).not.toContain('root_condition_pending')
    }
  })

  it('an applicable ancestor wait keeps its current marker under an unknown core', async () => {
    const { derive } = siblingFixture('请在收到我的确认后再推送代码。', 'review-r5-ancestor-wait')
    const projection = derive()
    const oldWait = [...projection.items.values()].find((item) => item.waitAuthorization)!
    // Hand-built lineage (derive cannot make a current unit a child): the
    // ancestor's wait still applies to the current work.
    projection.units.get('U002')!.parentUnitId = 'U001'
    projection.coreV2 = undefined
    const detail = await createPrepareTool({ getProjection: () => projection }).execute({ item_id: oldWait.id } as never, undefined as never) as Record<string, unknown>
    expect(JSON.stringify(detail)).toContain('"wait":"root_condition_pending"')
    expect(String((detail.item as Record<string, unknown>).text)).toContain('推送代码')
  })
})

// Historical coverage audit regressions: durable prohibitions keep their
// polarity without depending on the core predicate, and the 0.6.2 cleanup
// dependency condition rides the v6 lane at every budget.

describe('audit H1: a recorded prohibition never renders as ordinary work', () => {
  it('a legacy_review prohibition keeps DO NOT beside ordinary fix work at every budget', async () => {
    const { derive } = fixture('修复代码，但不推送。', 'audit-h1-push-prohibition')
    const projection = derive()
    const prohibition = [...projection.items.values()].find((item) => item.kind === 'prohibition')!
    expect(prohibition).toMatchObject({ status: 'pending', authorityDisposition: 'prohibition' })
    expect(currentV6Feedback(projection)?.predicates[prohibition.id]).toBe('legacy_review')
    expect(currentV6Feedback(projection)?.openIds).toContain(prohibition.id)
    for (const budget of [512, 1000, 4000]) {
      const packet = renderRecoveryPacket(projection, { charBudget: budget })
      expect(packet.length, `budget ${budget}`).toBeLessThanOrEqual(budget)
      expect(packet, `budget ${budget}`).toContain('DO NOT')
      // The PROHIBITION row is never phrased as continue-work guidance; the
      // ordinary fix requirement beside it may be.
      expect(packet, `budget ${budget}`).not.toMatch(/\[P001\][^\n]*(do it with host tools|ordinary host work continues)/)
      expect(packet, `budget ${budget}`).toMatch(/DO NOT \[P001\] 推送/)
    }
    // The same polarity holds when the core view is unavailable.
    projection.coreV2 = undefined
    expect(renderRecoveryPacket(projection, { charBudget: 512 })).toContain('DO NOT')
    // The prepare detail answers in the prohibition shape, not as history or work.
    const detail = await createPrepareTool({ getProjection: () => derive() }).execute({ item_id: 'P001' } as never, undefined as never) as Record<string, unknown>
    expect(detail).toMatchObject({ reason_code: 'legacy_review', item: expect.objectContaining({ id: 'P001', kind: 'prohibition' }) })
    expect(String(detail.next_step)).toContain('Do not perform the action')
    // And the checkpoint open row keeps the prohibition phrasing.
    const checkpoint = await createCheckpointTool(() => derive(), () => {}).execute({ bindings: [] } as never, undefined as never) as Record<string, unknown>
    const row = (checkpoint.open_items as Array<Record<string, unknown>>).find((entry) => entry.id === 'P001')!
    expect(String(row.next_step)).toContain('prohibition stays in force')
  })

  it('a violated file prohibition carries its violation on the DO NOT row', () => {
    const { session, derive } = fixture('请只修改 packages/api/src/request.ts。错误日志还提到了 packages/web/src/request.ts，但本轮不要动后者。', 'audit-h1-violated')
    session.append('tool/call', { turn: 1, step: 1, callId: 'forbidden-edit' as never, name: 'edit',
      arguments: JSON.stringify({ file_path: '/work/packages/web/src/request.ts', old_string: 'old', new_string: 'new' }) })
    session.append('tool/result', { turn: 1, step: 1,
      message: createToolResultMessage({ callId: 'forbidden-edit' as never,
        content: [{ type: 'text', text: 'done' }], isError: false }) }, { surfaceOp: 'append' })
    const projection = derive()
    expect(Object.values(currentV6Feedback(projection)?.predicates ?? {})).toContain('constraint_violated')
    const packet = renderRecoveryPacket(projection)
    expect(packet).toContain('DO NOT')
    expect(packet).toContain('VIOLATED')
  })
})

describe('audit H2: the cleanup dependency condition rides the v6 lane', () => {
  it('a cleanup request keeps the dependency-free condition at every budget and view state', () => {
    for (const [name, root] of [['zh', '清理构建缓存目录'], ['en', 'Clean the build cache directory.']] as const) {
      const { derive } = fixture(root, `audit-h2-${name}`)
      const projection = derive()
      expect(currentV6Feedback(projection)?.status).toBe('incomplete')
      for (const budget of [512, 1000, 4000]) {
        const packet = renderRecoveryPacket(projection, { charBudget: budget })
        expect(packet.length, `${name} budget ${budget}`).toBeLessThanOrEqual(budget)
        expect(packet, `${name} budget ${budget}`).toMatch(/no-dependants|dependency-free/)
      }
      projection.coreV2 = undefined
      expect(renderRecoveryPacket(projection, { charBudget: 512 }), name).toMatch(/no-dependants|dependency-free/)
    }
  })

  it('unrelated ordinary work does not carry the cleanup condition', () => {
    const test = fixture('Run npm test in /work.', 'audit-h2-negative-test').derive()
    expect(renderRecoveryPacket(test)).not.toMatch(/no-dependants|dependency-free/)
    const create = fixture('创建一个 HTML 动画页面,展示一个小球弹跳。', 'audit-h2-negative-create').derive()
    expect(renderRecoveryPacket(create)).not.toMatch(/no-dependants|dependency-free/)
  })

  it('the condition does not squeeze out a prohibition or a wait at the emergency budget', () => {
    const { derive } = fixture('清理构建缓存目录。不要删除 /work/secrets 目录。请在收到我的确认后再推送代码。', 'audit-h2-combined')
    const projection = derive()
    const waiting = [...projection.items.values()].find((item) => item.waitAuthorization)
    expect(waiting).toBeDefined()
    const packet = renderRecoveryPacket(projection, { charBudget: 512 })
    expect(packet.length).toBeLessThanOrEqual(512)
    expect(packet).toMatch(/no-dependants|dependency-free/)
    expect(packet).toContain('DO NOT')
    expect(packet).toContain('root_condition_pending')
    expect(packet).toContain('do not execute before release')
  })
})
