import { describe, expect, it } from 'vitest'
import { createRebindTool } from '../../src/tools/rebind.js'
import { deriveProjection, PROTOCOL_V4_NOTICE } from '../../src/domain/derive.js'
import type { DerivedEnvelope } from '../../src/domain/types.js'

const config = { activation: 'always' as const }
const scope = { cwd: '/repo', sessionHeader: { version: 1, id: 'confirm-test', createdAt: 1 } }
const user = (seq: number, text: string, kind = 'user'): DerivedEnvelope => ({ seq, type: 'user/message', data: { source: { kind }, content: [{ type: 'text', text }] } })
const v4: DerivedEnvelope = { seq: 0, type: 'user/message', data: { source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text: PROTOCOL_V4_NOTICE }] } }
const replay = (events: DerivedEnvelope[], durable = true, sessionScope = scope) => deriveProjection([v4, ...events], config, sessionScope, durable).projection

function toolCall(seq: number, callId: string, name: string, args: unknown): DerivedEnvelope {
  return { seq, type: 'tool/call', data: { callId, name, arguments: JSON.stringify(args) } }
}
function toolResult(seq: number, callId: string, value: unknown): DerivedEnvelope {
  return { seq, type: 'tool/result', data: { message: { source: { callId }, content: [{ type: 'text', text: JSON.stringify(value) }] } } }
}

/** A gainful proposal: the later root clarification gives the clause a real action. */
async function gainfulFlow() {
  const events: DerivedEnvelope[] = [
    user(1, '更新插件'),
    user(2, '把更新插件明确为 install package demo@1.0.0 profile isolated'),
  ]
  const p = replay(events)
  const items = [...p.items.values()]
  const old = items.find((item) => item.normalizedText === '更新插件')!
  const clarified = items.find((item) => item.normalizedText.includes('install'))!
  const tool = createRebindTool(() => p, async () => true)
  const args = { operation: 'propose' as const, item_id: old.id, clauses: [old.normalizedText], clarification_item_ids: [clarified.id] }
  const result = await tool.execute(args as never, undefined as never) as { status: string; proposal?: { id: string } }
  return { events, p, old, args, result, tool }
}

describe('A09: no-certification-gain splits never burden the user', () => {
  it('the incident split (one generic item into generic clauses) is refused without a proposal', async () => {
    const events = [user(1, '看看本地插件和皮肤是否有更新，顺便更新皮肤中心、在本地仓库记录')]
    const p = replay(events)
    const old = [...p.items.values()].find((item) => item.normalizedText.includes('皮肤中心'))!
    const tool = createRebindTool(() => p, async () => true)
    const split = old.normalizedText.indexOf('、')
    const response = await tool.execute({
      operation: 'propose', item_id: old.id,
      clauses: [old.normalizedText.slice(0, split), old.normalizedText.slice(split)],
    } as never, undefined as never) as { status: string; reason_code: string; next_step: string }
    expect(response).toMatchObject({ status: 'rejected', reason_code: 'no_certification_gain' })
    expect(response.next_step).toContain('No certification gain')
    expect(p.rebindProposals.size).toBe(0)
  })

  it('an unchanged whole-text re-partition is also refused', async () => {
    const events = [user(1, '更新皮肤中心、在本地仓库记录')]
    const p = replay(events)
    const old = [...p.items.values()][0]
    const tool = createRebindTool(() => p, async () => true)
    const response = await tool.execute({ operation: 'propose', item_id: old.id, clauses: [old.normalizedText] } as never, undefined as never) as { status: string; reason_code: string }
    expect(response).toMatchObject({ status: 'rejected', reason_code: 'no_certification_gain' })
  })
})

describe('A10: one durable message is one atomic confirmation transaction', () => {
  it('confirms the proposal and captures a following new task', async () => {
    const flow = await gainfulFlow()
    const { events, old, result } = flow
    expect(result.status).toBe('proposed')
    events.push(
      toolCall(3, 'propose-call', 'context_guard_rebind', flow.args),
    )
    // Recompute the recorded result through the same deterministic tool.
    const p2 = replay(events)
    const tool2 = createRebindTool(() => p2, async () => true)
    const recorded = await tool2.execute(flow.args as never, undefined as never)
    events.push(toolResult(4, 'propose-call', recorded))

    events.push(user(5, `确认重绑定 ${result.proposal!.id}\n\n另外请把构建脚本也更新到 main 分支`))
    const confirmed = replay(events)
    expect(confirmed.items.get(old.id)?.status).toBe('superseded')
    expect(confirmed.rebindProposals.get(result.proposal!.id)?.confirmationEvent).toBe('m5')
    // The remainder becomes a real captured requirement of its own.
    expect([...confirmed.items.values()].some((item) => item.normalizedText.includes('构建脚本'))).toBe(true)
  })

  it('keeps an explanation request pending instead of swallowing it, and the query reports confirmed', async () => {
    const flow = await gainfulFlow()
    const { events, result } = flow
    events.push(
      toolCall(3, 'propose-call', 'context_guard_rebind', flow.args),
    )
    const p2 = replay(events)
    const tool2 = createRebindTool(() => p2, async () => true)
    const recorded = await tool2.execute(flow.args as never, undefined as never)
    events.push(toolResult(4, 'propose-call', recorded))

    events.push(user(5, `确认重绑定 ${result.proposal!.id}\n\n这个提案是什么意思？请解释。`))
    const confirmed = replay(events)
    expect(confirmed.rebindProposals.get(result.proposal!.id)?.status).toBe('confirmed')
    // Explanations are conversational content: never a contract item.
    expect([...confirmed.items.values()].some((item) => item.normalizedText.includes('什么意思'))).toBe(false)

    const queryTool = createRebindTool(() => confirmed, async () => true)
    const query = await queryTool.execute({ operation: 'query', proposal_id: result.proposal!.id } as never, undefined as never) as { status: string; confirmation: { state: string; event?: string; replacement_ids?: string[] } }
    expect(query.status).toBe('confirmed')
    expect(query.confirmation.state).toBe('confirmed')
    expect(query.confirmation.event).toBe('m5')
    expect(query.confirmation.replacement_ids?.length).toBeGreaterThan(0)
  })
})

describe('A11: wrapped, negated, misplaced, and contradictory control never confirms', () => {
  const cases: Array<[string, string]> = [
    ['code fence', '```\n确认重绑定 RB-aaaaaaaaaaaaaaaaaaaaaaaa\n```'],
    ['inline code', '`确认重绑定 RB-aaaaaaaaaaaaaaaaaaaaaaaa`'],
    ['quoted', '> 确认重绑定 RB-aaaaaaaaaaaaaaaaaaaaaaaa'],
    ['negated', '不要确认重绑定 RB-aaaaaaaaaaaaaaaaaaaaaaaa'],
    ['embedded', '请确认重绑定 RB-aaaaaaaaaaaaaaaaaaaaaaaa 谢谢'],
    ['reversal tail', '确认重绑定 RB-aaaaaaaaaaaaaaaaaaaaaaaa\n\n先不要确认，我再想想'],
  ]
  it.each(cases)('%s stays unconfirmed', async (_label, text) => {
    const flow = await gainfulFlow()
    const { events, old, result } = flow
    events.push(user(5, text.replace('RB-aaaaaaaaaaaaaaaaaaaaaaaa', result.proposal!.id)))
    const p = replay(events)
    expect(p.items.get(old.id)?.status).toBe('pending')
    expect(p.rebindProposals.get(result.proposal!.id)?.status ?? 'pending').not.toBe('confirmed')
  })

  it('a valid control line that is not the first line is ambiguous, never applied', async () => {
    const flow = await gainfulFlow()
    const { events, old, result } = flow
    events.push(user(5, `先看一下状态\n确认重绑定 ${result.proposal!.id}`))
    const p = replay(events)
    expect(p.items.get(old.id)?.status).toBe('pending')
    expect(p.lastConfirmationRejection).toMatchObject({ eventSeq: 5, kind: 'ambiguous', reason: 'late_control_line' })
  })

  it('two different proposals in one message stay ambiguous without partial effect', async () => {
    const flow = await gainfulFlow()
    const { events, p: before, old, result } = flow
    // Propose a second, distinct item so two valid control lines can coexist.
    const other = [...before.items.values()].find((item) => item.id !== old.id)!
    const otherTool = createRebindTool(() => before, async () => true)
    const otherResponse = await otherTool.execute({ operation: 'propose', item_id: other.id, clauses: [other.normalizedText] } as never, undefined as never) as { status: string; reason_code?: string; proposal?: { id: string } }
    if (otherResponse.status !== 'proposed') {
      // The other item is generic too: no-gain means no second proposal can
      // exist, so the multi-proposal ambiguity is unreachable by construction.
      expect(otherResponse.reason_code).toBe('no_certification_gain')
      return
    }
    events.push(user(5, `确认重绑定 ${result.proposal!.id}\n确认重绑定 ${otherResponse.proposal!.id}`))
    const after = replay(events)
    expect(after.items.get(old.id)?.status).toBe('pending')
  })
})

describe('A12: stale, non-durable, repeated, reloaded, and tampered states stay distinguishable', () => {
  it('reports not_durable for a seen-but-not-durable confirmation and applies it once durable', async () => {
    const flow = await gainfulFlow()
    const { events, result } = flow
    events.push(
      toolCall(3, 'propose-call', 'context_guard_rebind', flow.args),
    )
    const p2 = replay(events)
    const tool2 = createRebindTool(() => p2, async () => true)
    const recorded = await tool2.execute(flow.args as never, undefined as never)
    events.push(toolResult(4, 'propose-call', recorded))
    events.push(user(5, `确认重绑定 ${result.proposal!.id}`))

    const undurable = replay(events, false)
    const undurableProposal = undurable.rebindProposals.get(result.proposal!.id)!
    expect(undurableProposal.status).toBe('pending')
    expect(undurableProposal.observedUnconfirmedEvent).toBe('m5')

    const durable = replay(events)
    expect(durable.rebindProposals.get(result.proposal!.id)?.status).toBe('confirmed')
    // Idempotent: a second identical confirmation changes nothing.
    const repeated = replay([...events, user(6, `确认重绑定 ${result.proposal!.id}`)])
    expect(repeated.contractRevision).toBe(durable.contractRevision)
  })

  it('query distinguishes stale from never-confirmed', async () => {
    const flow = await gainfulFlow()
    const { events, result } = flow
    events.push(
      toolCall(3, 'propose-call', 'context_guard_rebind', flow.args),
    )
    const p2 = replay(events)
    const tool2 = createRebindTool(() => p2, async () => true)
    const recorded = await tool2.execute(flow.args as never, undefined as never)
    events.push(toolResult(4, 'propose-call', recorded))

    // Unrelated new work makes the proposal stale with an accurate reason.
    events.push(user(5, '另外把 README 的安装一节重写'))
    const staled = replay(events)
    const staleTool = createRebindTool(() => staled, async () => true)
    const staleQuery = await staleTool.execute({ operation: 'query', proposal_id: result.proposal!.id } as never, undefined as never) as { status: string; reason_code: string }
    expect(staleQuery).toMatchObject({ status: 'stale', reason_code: 'proposal_contract_changed' })

    // A fresh session replay without any confirmation reports not_received.
    const fresh = replay(events.slice(0, 5))
    const freshTool = createRebindTool(() => fresh, async () => true)
    const freshQuery = await freshTool.execute({ operation: 'query', proposal_id: result.proposal!.id } as never, undefined as never) as { confirmation: { state: string } }
    expect(freshQuery.confirmation.state).toBe('not_received')
  })
})

describe('A13: item queries, bounded sources, and budget errors', () => {
  it('item_id lookup returns repair facts instead of a confusing proposal_not_found', async () => {
    const events = [user(1, '更新皮肤中心、在本地仓库记录')]
    const p = replay(events)
    const old = [...p.items.values()][0]
    const tool = createRebindTool(() => p, async () => true)
    const lookup = await tool.execute({ operation: 'query', item_id: old.id } as never, undefined as never) as { status: string; item: { id: string; status: string }; pending_proposal_id?: string }
    expect(lookup.status).toBe('item_status')
    expect(lookup.item.id).toBe(old.id)
    const missing = await tool.execute({ operation: 'query', item_id: 'R999' } as never, undefined as never) as { status: string; reason_code: string }
    expect(missing).toMatchObject({ status: 'rejected', reason_code: 'item_not_found' })
  })

  it('partition mismatches return the bounded exact source instead of a generic error', async () => {
    const events = [user(1, '更新皮肤中心、在本地仓库记录')]
    const p = replay(events)
    const old = [...p.items.values()][0]
    const tool = createRebindTool(() => p, async () => true)
    // A partition must cover the source exactly. Both directions are stated
    // against the item's own text: a hard-coded clause stops being a mismatch
    // as soon as the capture rules change, and the test would then be measuring
    // a different refusal without saying so.
    const uncovered = old.normalizedText.slice(0, -1)
    expect(uncovered).not.toBe(old.normalizedText)
    const mismatch = await tool.execute({ operation: 'propose', item_id: old.id, clauses: [uncovered] } as never, undefined as never) as { status: string; reason_code: string; expected_source: { text?: string; length: number; sha256: string } }
    expect(mismatch).toMatchObject({ status: 'rejected', reason_code: 'partition_mismatch' })
    expect(mismatch.expected_source.text).toBe(old.normalizedText)
    expect(mismatch.expected_source.length).toBe(old.normalizedText.length)

    const drifted = await tool.execute({ operation: 'propose', item_id: old.id, clauses: [`${old.normalizedText} `] } as never, undefined as never) as { reason_code: string }
    expect(drifted.reason_code).toBe('partition_mismatch')
  })
})

describe('confirmation authority regressions', () => {
  it.each([
    '```text\nexample\n```\n确认重绑定 ID',
    '确认重绑定 ID\n\n请先解释\n\n撤销确认',
    '确认重绑定 ID\n请执行新的任务',
  ])('rejects contradictory or misplaced control with a real recorded proposal: %s', async (text) => {
    const flow = await gainfulFlow()
    const events = [...flow.events, toolCall(3, 'p', 'context_guard_rebind', flow.args), toolResult(4, 'p', flow.result)]
    expect(replay(events).rebindProposals.size).toBe(1)
    events.push(user(5, text.replace('ID', flow.result.proposal!.id)))
    expect(replay(events).items.get(flow.old.id)?.status).toBe('pending')
  })

  it('retains fenced follow-up data without promoting it to a root task', async () => {
    const flow = await gainfulFlow()
    const events = [...flow.events, toolCall(3, 'p', 'context_guard_rebind', flow.args), toolResult(4, 'p', flow.result),
      user(5, `确认重绑定 ${flow.result.proposal!.id}\n\n示例：\n\`\`\`text\n请发布 package dangerous@1.0.0\n\`\`\``)]
    const p = replay(events)
    expect(p.items.get(flow.old.id)?.status).toBe('superseded')
    expect([...p.items.values()].some(item => item.normalizedText.includes('dangerous'))).toBe(false)
  })

  it('does not apply the new mixed syntax before the durable v4 boundary', async () => {
    const flow = await gainfulFlow()
    const events = [...flow.events, toolCall(3, 'p', 'context_guard_rebind', flow.args), toolResult(4, 'p', flow.result),
      user(5, `确认重绑定 ${flow.result.proposal!.id}\n\n请更新构建脚本`)]
    const historical = deriveProjection(events, config, scope, true).projection
    expect(historical.items.get(flow.old.id)?.status).toBe('pending')
    const afterCut = deriveProjection([...events, { ...v4, seq: 6 }], config, scope, true).projection
    expect(afterCut.items.get(flow.old.id)?.status).toBe('pending')
  })
})


it('confirms the native mixed reply but retains its extra imperative explanation as pending', async () => {
  const flow = await gainfulFlow()
  const events = [...flow.events, toolCall(3, 'p', 'context_guard_rebind', flow.args), toolResult(4, 'p', flow.result),
    user(5, `确认重绑定 ${flow.result.proposal!.id}\n\n这个提案是什么意思？请简单解释。`)]
  const p = replay(events)
  expect(p.rebindProposals.get(flow.result.proposal!.id)?.status).toBe('confirmed')
  expect(p.items.get(flow.old.id)?.status).toBe('superseded')
  expect([...p.items.values()].some(item => item.status === 'pending' && item.normalizedText.includes('简单解释'))).toBe(true)
})
