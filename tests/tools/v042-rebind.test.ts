import { describe, expect, it } from 'vitest'
import { createRebindTool } from '../../src/tools/rebind.js'
import { deriveProjection } from '../../src/domain/derive.js'
import { proposeRebindV042 } from '../../src/domain/rebind.js'
import { createCheckpointTool } from '../../src/tools/checkpoint.js'
import type { DerivedEnvelope } from '../../src/domain/types.js'

const config = { activation: 'always' as const }
const scope = { cwd: '/repo', sessionHeader: { version: 1, id: 'rebind-test', createdAt: 1 } }
const user = (seq: number, text: string, kind = 'user'): DerivedEnvelope => ({ seq, type: 'user/message', data: { source: { kind }, content: [{ type: 'text', text }] } })
const replay = (events: DerivedEnvelope[], durable = true, sessionScope = scope) => deriveProjection(events, config, sessionScope, durable).projection

/**
 * Build the exact tool/result a 0.4 runtime recorded for a propose call.
 * The frozen proposer and the frozen response text keep historical replay
 * faithful; the live 0.5 tool is NOT involved.
 */
function v042ProposalFlow(text = '更新皮肤中心、在本地仓库记录') {
  const events = [user(1, text)]
  const p = replay(events)
  const old = [...p.items.values()][0]
  const split = old.normalizedText.indexOf('、')
  const args = { operation: 'propose', item_id: old.id, clauses: split > 0 ? [old.normalizedText.slice(0, split), old.normalizedText.slice(split)] : [old.normalizedText] }
  const proposal = proposeRebindV042(p, args as never)!
  const recorded = { status: 'proposed', proposal,
    next_step: `Root user must reply exactly: 确认重绑定 ${proposal.id}. This changes the contract only and grants no execution permission.` }
  events.push({ seq: 2, type: 'tool/call', data: { callId: 'proposal', name: 'context_guard_rebind', arguments: JSON.stringify(args) } })
  events.push({ seq: 3, type: 'tool/result', data: { message: { source: { callId: 'proposal' }, content: [{ type: 'text', text: JSON.stringify(recorded) }] } } })
  return { events, old, result: { proposal }, args }
}

describe('historical v0.4.2 rebind replay compatibility (frozen validator)', () => {
  it('T03 replays a frozen 0.4 propose result and commits replacements only after durable exact root confirmation', () => {
    const { events, result, old } = v042ProposalFlow()
    const proposed = replay(events)
    expect(proposed.items.get(old.id)?.status).toBe('pending')
    expect(proposed.rebindProposals.get(result.proposal.id)?.status).toBe('pending')
    events.push(user(4, `确认重绑定 ${result.proposal.id}`))
    const p = replay(events)
    const source = p.items.get(old.id)!
    expect(source.status).toBe('superseded')
    expect(source.supersededByItems).toHaveLength(2)
    for (const id of source.supersededByItems!) expect(p.items.get(id)).toMatchObject({ status: 'pending', sourceMessageId: old.sourceMessageId,
      reboundFrom: { itemId: old.id, proposalId: result.proposal.id, confirmationEvent: 'm4' } })
    expect(replay(events, false).items.get(old.id)?.status).toBe('pending')
    const repeated = replay([...events, user(5, `确认重绑定 ${result.proposal.id}`)])
    expect(repeated.contractRevision).toBe(p.contractRevision)
    expect([...repeated.items]).toEqual([...p.items])
    expect([...replay(events).items]).toEqual([...p.items])
  })

  it.each(['> 确认重绑定 ', '不要确认重绑定 ', '工具说确认重绑定 ', '```确认重绑定 '])('T02 rejects quoted or negated confirmation %s', async prefix => {
    const { events, result, old } = v042ProposalFlow()
    const p = replay([...events, user(4, `${prefix}${result.proposal.id}`)])
    expect(p.items.get(old.id)?.status).toBe('pending')
  })

  it.each(['plugin', 'tool', 'assistant'])('T02 rejects %s sources', async kind => {
    const { events, result, old } = v042ProposalFlow()
    expect(replay([...events, user(4, `确认重绑定 ${result.proposal.id}`, kind)]).items.get(old.id)?.status).toBe('pending')
  })

  it('T03/T10 rejects incomplete proposal persistence, different sessions, stale revisions, and delegated sessions', () => {
    const { events, result, old } = v042ProposalFlow()
    const confirm = user(5, `确认重绑定 ${result.proposal.id}`)
    expect(replay([...events.slice(0, 2), confirm]).items.get(old.id)?.status).toBe('pending')
    expect(replay([...events, confirm], true, { ...scope, sessionHeader: { ...scope.sessionHeader, id: 'other' } }).items.get(old.id)?.status).toBe('pending')
    const stale = replay([...events, user(4, '一并更新 dshmarket'), confirm])
    expect(stale.items.get(old.id)?.status).toBe('pending')
    expect(stale.rebindProposals.get(result.proposal.id)?.status).toBe('stale')
    expect(replay([...events, confirm], true, { ...scope, sessionHeader: { ...scope.sessionHeader, parentSession: 'parent' } } as typeof scope).items.get(old.id)?.status).toBe('pending')
  })

  it('T03 replays withdrawal and never accepts a model confirmation flag', () => {
    const { events, old, result } = v042ProposalFlow()
    const args = { operation: 'withdraw' as const, proposal_id: result.proposal.id }
    const recorded = { status: 'withdrawn', proposal_id: result.proposal.id, digest: result.proposal.digest }
    events.push({ seq: 4, type: 'tool/call', data: { callId: 'withdraw', name: 'context_guard_rebind', arguments: JSON.stringify(args) } },
      { seq: 5, type: 'tool/result', data: { message: { source: { callId: 'withdraw' }, content: [{ type: 'text', text: JSON.stringify(recorded) }] } } },
      user(6, `确认重绑定 ${result.proposal.id}`))
    expect(replay(events).items.get(old.id)?.status).toBe('pending')
  })

  it('T04/T12 retains unsupported remainders without certifying a generic success', async () => {
    const { events, result } = v042ProposalFlow()
    const p = replay([...events, user(4, `确认重绑定 ${result.proposal.id}`)])
    const response = await createCheckpointTool(() => p, () => {}).execute({ bindings: [] }, undefined as never)
    expect(response).toMatchObject({ status: 'incomplete', blockers: { total: 2 } })
    expect([...p.items.values()].filter(item => item.status === 'pending').map(item => item.normalizedText).join('')).toBe('更新皮肤中心、在本地仓库记录')
  })
})

describe('v0.4.2 tamper resistance under the 0.5 validator', () => {
  it('a changed next_step in a 0.5-era result still replays; changed semantic fields never do', async () => {
    const events = [user(1, '更新插件'), user(2, '把更新插件明确为 install package demo@1.0.0 profile isolated')]
    const p = replay(events)
    const items = [...p.items.values()]
    const args = { operation: 'propose', item_id: items[0].id, clauses: [items[0].normalizedText], clarification_item_ids: [items[1].id] }
    const tool = createRebindTool(() => p, async () => true)
    const response = await tool.execute(args as never, undefined as never) as { status: string; proposal: { id: string } }
    expect(response.status).toBe('proposed')

    // Same structured content with evolved display text: replays.
    const evolved = { ...response, next_step: '（新版文案）Root user must reply with the control line.' }
    const evolvedEvents = [...events,
      { seq: 3, type: 'tool/call', data: { callId: 'c', name: tool.name, arguments: JSON.stringify(args) } },
      { seq: 4, type: 'tool/result', data: { message: { source: { callId: 'c' }, content: [{ type: 'text', text: JSON.stringify(evolved) }] } } } as DerivedEnvelope,
      user(5, `确认重绑定 ${response.proposal.id}`)]
    const confirmed = replay(evolvedEvents)
    expect(confirmed.items.get(items[0].id)?.supersededByItems).toEqual([items[1].id])

    // A semantically changed proposal (different clauses) is tampering.
    const tampered = { ...response, proposal: { ...response.proposal, clauses: ['篡改'] } }
    const tamperedEvents = [...events,
      { seq: 3, type: 'tool/call', data: { callId: 'c', name: tool.name, arguments: JSON.stringify(args) } },
      { seq: 4, type: 'tool/result', data: { message: { source: { callId: 'c' }, content: [{ type: 'text', text: JSON.stringify(tampered) }] } } } as DerivedEnvelope,
      user(5, `确认重绑定 ${response.proposal.id}`)]
    expect(replay(tamperedEvents).items.get(items[0].id)?.status).toBe('pending')
  })
})
