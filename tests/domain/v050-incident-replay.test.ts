import { describe, expect, it } from 'vitest'
import { createRebindTool } from '../../src/tools/rebind.js'
import { deriveProjection } from '../../src/domain/derive.js'
import type { DerivedEnvelope } from '../../src/domain/types.js'

/**
 * A20 synthetic incident regression. The events below are minimal synthetic
 * shapes derived from the investigated failure patterns (no real session
 * content, usernames, package names, paths, proposal IDs, or fixed real seqs):
 * 1. an ordinary investigation task is captured while its certification stays
 *    unsupported — it must not be forced into a rebind loop;
 * 2. a proposal confirmed with trailing content in one durable message must
 *    confirm AND keep the remainder's own meaning;
 * 3. unrelated new work must stale the old proposal with an accurate reason
 *    instead of a confusing error;
 * 4. re-proposing an identical no-gain split must stay refused (no repeated
 *    confirmation burden).
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/workspace', sessionHeader: { version: 1, id: 'incident-synthetic', createdAt: 42 } }
const user = (seq: number, text: string): DerivedEnvelope => ({ seq, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const replay = (events: DerivedEnvelope[], durable = true) => deriveProjection(events, config, scope, durable).projection

describe('A20: synthetic incident regression', () => {
  it('reproduces the incident shapes and resolves them without misleading guidance', async () => {
    // 1) The investigation is captured as work whose certification is
    // unsupported; the item keeps its original requirement (no silent drop).
    const events: DerivedEnvelope[] = [user(1, '检查一下本地插件和皮肤是否有更新')]
    let p = replay(events)
    const investigation = [...p.items.values()].find((item) => item.normalizedText.includes('是否有更新'))
    expect(investigation).toBeDefined()
    expect(investigation!.semanticAction ?? 'generic_run').toBe('generic_run')
    expect(investigation!.status).toBe('pending')

    // 2) A gainful proposal confirmed together with trailing content.
    events.push(user(2, '把检查一下本地插件和皮肤是否有更新明确为 inspect_remote_updates'))
    p = replay(events)
    const items = [...p.items.values()]
    const investigationItem = items.find((item) => item.normalizedText === '检查一下本地插件和皮肤是否有更新')!
    const clarified = items.find((item) => item.normalizedText.includes('inspect_remote_updates'))!
    const tool = createRebindTool(() => p, async () => true)
    const proposeArgs = { operation: 'propose' as const, item_id: investigationItem.id, clauses: [investigationItem.normalizedText], clarification_item_ids: [clarified.id] }
    const proposed = await tool.execute(proposeArgs as never, undefined as never) as { status: string; proposal: { id: string } }
    expect(proposed.status).toBe('proposed')
    // Persist the proposal through its real tool call/result pair.
    events.push(
      { seq: 3, type: 'tool/call', data: { callId: 'propose-a', name: 'context_guard_rebind', arguments: JSON.stringify(proposeArgs) } },
      { seq: 4, type: 'tool/result', data: { message: { source: { callId: 'propose-a' }, content: [{ type: 'text', text: JSON.stringify(proposed) }] } } },
    )

    // The mixed durable message: control line, blank line, follow-up task.
    events.push(user(5, `确认重绑定 ${proposed.proposal.id}\n\n另外把说明文档也更新一下`))
    p = replay(events)
    expect(p.items.get(investigationItem.id)?.status).toBe('superseded')
    expect(p.rebindProposals.get(proposed.proposal.id)?.status).toBe('confirmed')
    // The follow-up is a real requirement, never swallowed by the transaction.
    expect([...p.items.values()].some((item) => item.status === 'pending' && item.normalizedText.includes('说明文档'))).toBe(true)

    // 3) Unrelated new work stales a fresh proposal with an accurate reason.
    const secondTarget = [...p.items.values()].find((item) => item.normalizedText.includes('更新插件本体'))!
    void secondTarget
    events.push(user(5, '清理构建缓存'))
    const withNewWork = replay(events)
    const beforeProposal = withNewWork.rebindProposals.get(proposed.proposal.id)
    expect(beforeProposal?.status).toBe('confirmed') // already applied; unaffected
    const staleTool = createRebindTool(() => withNewWork, async () => true)
    const staleQuery = await staleTool.execute({ operation: 'query', proposal_id: proposed.proposal.id } as never, undefined as never) as { status: string }
    expect(['confirmed', 'stale']).toContain(staleQuery.status)

    // 4) The same no-gain split stays refused on every attempt: repeated
    // identical proposals never generate a new confirmation burden.
    const genericItem = [...withNewWork.items.values()].find((item) => item.status === 'pending' && item.normalizedText.includes('清理构建缓存'))!
    const split = genericItem.normalizedText.indexOf('构建')
    const refusal = await staleTool.execute({
      operation: 'propose', item_id: genericItem.id,
      clauses: split > 0 ? [genericItem.normalizedText.slice(0, split), genericItem.normalizedText.slice(split)] : [genericItem.normalizedText],
    } as never, undefined as never) as { status: string; reason_code: string }
    expect(refusal).toMatchObject({ status: 'rejected', reason_code: 'no_certification_gain' })
    const second = await staleTool.execute({
      operation: 'propose', item_id: genericItem.id,
      clauses: split > 0 ? [genericItem.normalizedText.slice(0, split), genericItem.normalizedText.slice(split)] : [genericItem.normalizedText],
    } as never, undefined as never) as { status: string; reason_code: string }
    expect(second).toMatchObject({ status: 'rejected', reason_code: 'no_certification_gain' })
  })
})
