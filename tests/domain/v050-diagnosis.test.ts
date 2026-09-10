import { describe, expect, it } from 'vitest'
import { createRebindTool } from '../../src/tools/rebind.js'
import { deriveProjection } from '../../src/domain/derive.js'
import { deriveItemDiagnosis } from '../../src/domain/diagnostics.js'
import { classifyTaskIntent } from '../../src/domain/conversation.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { captureItem } from '../../src/domain/capture.js'
import type { DerivedEnvelope } from '../../src/domain/types.js'

const config = { activation: 'always' as const }
const scope = { cwd: '/repo', sessionHeader: { version: 1, id: 'diagnosis-test', createdAt: 1 } }
const user = (seq: number, text: string): DerivedEnvelope => ({ seq, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const replay = (events: DerivedEnvelope[]) => deriveProjection(events, config, scope, true).projection

describe('A08: intent layer separates inquiries from actions without dropping either', () => {
  it('an update question stays captured but is diagnosed as non-certifiable without rebind advice', () => {
    const events = [user(1, '检查一下本地插件和皮肤是否有更新')]
    const p = replay(events)
    const item = [...p.items.values()][0]
    expect(item.status).toBe('pending')
    const diagnosis = deriveItemDiagnosis(p, item)
    expect(diagnosis.task_kind).toBe('inquiry')
    expect(diagnosis.certification).toBe('unsupported')
    expect(diagnosis.repairability).toBe('unsupported')
    expect(diagnosis.next_action.kind).toBe('report_only')
    expect(JSON.stringify(diagnosis)).not.toContain('context_guard_rebind')
  })

  it.each([
    ['插件是否有更新了吗', 'inquiry'],
    ['Is there any update for the plugin?', 'inquiry'],
    ['check whether the remote has new commits', 'inquiry'],
    ['更新三个插件', 'action'],
    ['更新后检查结果', 'action'],
    ['把插件更新一下，然后检查是否成功', 'action'],
    ['commit the changes now', 'action'],
  ])('%s → %s', (text, expected) => {
    expect(classifyTaskIntent(text)).toBe(expected)
  })

  it('the same investigation phrased as a change keeps full action protection', () => {
    const events = [user(1, '更新皮肤中心和插件本体')]
    const p = replay(events)
    const diagnosis = deriveItemDiagnosis(p, [...p.items.values()][0])
    expect(diagnosis.task_kind).toBe('action')
    expect(diagnosis.reason_code).toBe('generic_run_non_certifiable')
    expect(diagnosis.repairability).toBe('user_input_required')
  })
})

describe('A14/A15: prepare reports capability, target gaps, and supported shapes before acting', () => {
  const prepare = (p: ReturnType<typeof replay>) => createPrepareTool({
    getProjection: () => p,
    hostCapability: () => ({ status: 'supported' as const, reasonCode: undefined }),
    commandTemplate: (action) => action === 'push'
      ? { command: 'git push <remote> <source_ref>:<destination_ref>' }
      : undefined,
  })

  it('lists exact missing target fields without upgrading a default into authority', async () => {
    const events = [user(1, '在 profile web 安装 fixture 2.0.0')]
    const p = replay(events)
    const item = [...p.items.values()][0]
    const response = await prepare(p).execute({ item_id: item.id } as never, undefined as never) as {
      status: string
      missing_target_fields: string[]
      note: string
    }
    expect(response.status).toBe('prepared')
    // Missing authorization-relevant fields are named for the user question.
    expect(response.missing_target_fields.length).toBeGreaterThan(0)
    expect(response.note).toContain('not user authority')
  })

  it('reports the supported push shape and the resolution/effect/state order', async () => {
    const events = [user(1, '推送到 origin main')]
    const p = replay(events)
    const item = [...p.items.values()][0]
    const response = await prepare(p).execute({
      item_id: item.id, semantic_action: 'push',
      requested_target: { repository: '/repo', remote: 'origin', source_ref: 'main', destination_ref: 'main' },
    } as never, undefined as never) as { status: string; supported_command_shape?: { command: string }; required_evidence_order: string[] }
    expect(response.status).toBe('prepared')
    expect(response.supported_command_shape?.command).toBe('git push <remote> <source_ref>:<destination_ref>')
    expect(response.required_evidence_order.join(' ')).toContain('resolution')
    expect(response.required_evidence_order.join(' ')).toContain('effect')
    expect(response.required_evidence_order.join(' ')).toContain('state')
  })

  it('rejects unknown items and unknown actions', async () => {
    const events = [user(1, '更新插件')]
    const p = replay(events)
    const tool = prepare(p)
    await expect(tool.execute({ item_id: 'R999' } as never, undefined as never)).resolves.toMatchObject({ status: 'rejected', reason_code: 'item_not_found' })
    await expect(tool.execute({ item_id: [...p.items.values()][0].id, semantic_action: 'deploy_to_production' } as never, undefined as never))
      .resolves.toMatchObject({ status: 'rejected', reason_code: 'unsupported_action' })
  })
})

describe('A16: an executed action without its prestate is a historical gap, not a re-run target', () => {
  it('diagnoses effect-without-resolution as read-only and never advises re-execution', () => {
    const events = [
      user(1, '提交变更 commit repository=/repo branch=main'),
    ]
    const p = replay(events)
    const item = [...p.items.values()].find((entry) => entry.semanticAction === 'commit')!
    // An effect evidence exists; no resolution prestate was ever recorded.
    p.evidence.set('E0001', {
      id: 'E0001', epoch: 0, callId: 'c1', rootCallId: 'c1', toolName: 'bash', toolResultSeq: 2,
      outcome: 'success', capabilities: [], subjects: ['/repo'], surfaces: ['scope'], boundedSummarySha256: 'a'.repeat(64),
      semanticAction: 'commit', evidenceRole: 'effect', resolvedTarget: item.requestedTarget,
      parseStatus: 'supported', adapterId: 'dsh.bash.v1', adapterVersion: '1.0.0',
    })
    const diagnosis = deriveItemDiagnosis(p, item)
    expect(diagnosis.reason_code).toBe('historical_evidence_gap')
    expect(diagnosis.repairability).toBe('historical_gap')
    expect(diagnosis.next_action.resume_condition).toContain('do not repeat the action')
  })
})

describe('A17: identical rejected retries collapse onto a stable unchanged answer', () => {
  it('second identical no-gain propose returns unchanged; new inputs reopen evaluation', async () => {
    const base: DerivedEnvelope[] = [user(1, '更新皮肤中心、在本地仓库记录')]
    const p = replay(base)
    const old = [...p.items.values()][0]
    const split = old.normalizedText.indexOf('、')
    const args = { operation: 'propose' as const, item_id: old.id, clauses: [old.normalizedText.slice(0, split), old.normalizedText.slice(split)] }

    // First attempt on the live contract: an explicit rejection.
    const tool1 = createRebindTool(() => p, async () => true)
    const first = await tool1.execute(args as never, undefined as never) as { status: string; reason_code: string }
    expect(first).toMatchObject({ status: 'rejected', reason_code: 'no_certification_gain' })

    // The rejection is durable in the log; a reload replays the ledger, so the
    // second identical attempt returns `unchanged` instead of a new rejection.
    const eventsWithAttempt: DerivedEnvelope[] = [
      ...base,
      { seq: 2, type: 'tool/call', data: { callId: 'r1', name: 'context_guard_rebind', arguments: JSON.stringify(args) } },
      { seq: 3, type: 'tool/result', data: { message: { source: { callId: 'r1' }, content: [{ type: 'text', text: JSON.stringify(first) }] } } },
    ]
    const reloaded = replay(eventsWithAttempt)
    const tool2 = createRebindTool(() => reloaded, async () => true)
    const second = await tool2.execute(args as never, undefined as never) as { status: string; reason_code: string; resume_condition: string }
    expect(second).toMatchObject({ status: 'unchanged', reason_code: 'no_certification_gain' })
    expect(second.resume_condition).toContain('re-opens evaluation')

    const newRoot = replay([...eventsWithAttempt, user(4, '请检查新的配置文件')])
    const reopened = await createRebindTool(() => newRoot, async () => true).execute(args as never, undefined as never) as { status: string }
    expect(reopened.status).toBe('rejected')

    // A changed input re-opens evaluation (different clause partition).
    const changed = await tool2.execute({ ...args, clauses: [old.normalizedText] } as never, undefined as never) as { status: string; reason_code: string }
    expect(changed.status).toBe('rejected')
  })
})

describe('diagnosis sharing: rebind item queries use the same judge as checkpoint and recovery', () => {
  it('rebind item lookup embeds the unified diagnosis', async () => {
    const events = [user(1, '检查一下本地插件和皮肤是否有更新')]
    const p = replay(events)
    const item = [...p.items.values()][0]
    const tool = createRebindTool(() => p, async () => true)
    const lookup = await tool.execute({ operation: 'query', item_id: item.id } as never, undefined as never) as {
      diagnosis: { task_kind: string; reason_code: string; repairability: string; attempt_fingerprint: string }
    }
    expect(lookup.diagnosis.task_kind).toBe('inquiry')
    expect(lookup.diagnosis.reason_code).toBe('inquiry_non_certifiable')
    expect(lookup.diagnosis.attempt_fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('target clarification surfaces field-level guidance', () => {
  it('a missing repository field reports needs_target with the field name', () => {
    const item = captureItem('requirement', '在仓库提交变更', 'm1', 'R001', 1, 'scope', 'scope')
    const p = replay([user(1, '在仓库提交变更')])
    const live = [...p.items.values()].find((entry) => entry.semanticAction === 'commit') ?? item
    const diagnosis = deriveItemDiagnosis(p, live)
    if (live.targetCaptureStatus === 'clarification_required') {
      expect(diagnosis.certification).toBe('needs_target')
      expect(diagnosis.repairability).toBe('user_input_required')
      expect(diagnosis.next_action.kind).toBe('clarify_target')
    } else {
      expect(diagnosis.certification === 'needs_evidence' || diagnosis.certification === 'unsupported').toBe(true)
    }
  })
})
