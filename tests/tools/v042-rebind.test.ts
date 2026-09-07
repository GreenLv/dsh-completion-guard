import { describe, expect, it } from 'vitest'
import { createRebindTool } from '../../src/tools/rebind.js'
import { deriveProjection } from '../../src/domain/derive.js'
import { createCheckpointTool } from '../../src/tools/checkpoint.js'
import type { DerivedEnvelope } from '../../src/domain/types.js'

const config = { activation: 'always' as const }
const scope = { cwd: '/repo', sessionHeader: { version: 1, id: 'rebind-test', createdAt: 1 } }
const user = (seq: number, text: string, kind = 'user'): DerivedEnvelope => ({ seq, type: 'user/message', data: { source: { kind }, content: [{ type: 'text', text }] } })
const replay = (events: DerivedEnvelope[], durable = true, sessionScope = scope) => deriveProjection(events, config, sessionScope, durable).projection

async function proposalFlow(text = '更新皮肤中心、在本地仓库记录') {
  const events = [user(1, text)]
  const p = replay(events)
  const old = [...p.items.values()][0]
  const split = old.normalizedText.indexOf('、')
  const args = { operation: 'propose', item_id: old.id, clauses: split > 0 ? [old.normalizedText.slice(0, split), old.normalizedText.slice(split)] : [old.normalizedText] }
  const tool = createRebindTool(() => p, async () => true)
  const result = await tool.execute(args as never, undefined as never) as { proposal: { id: string; digest: string } }
  events.push({ seq: 2, type: 'tool/call', data: { callId: 'proposal', name: tool.name, arguments: JSON.stringify(args) } })
  events.push({ seq: 3, type: 'tool/result', data: { message: { source: { callId: 'proposal' }, content: [{ type: 'text', text: JSON.stringify(result) }] } } })
  return { events, old, result, args }
}

describe('0.4.2 public rebind and canonical event replay', () => {
  it('T03 commits all replacements only after durable exact root confirmation, preserving one-to-many provenance', async () => {
    const { events, result, old } = await proposalFlow()
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
    const { events, result, old } = await proposalFlow()
    const p = replay([...events, user(4, `${prefix}${result.proposal.id}`)])
    expect(p.items.get(old.id)?.status).toBe('pending')
  })
  it.each(['plugin', 'tool', 'assistant'])('T02 rejects %s sources', async kind => {
    const { events, result, old } = await proposalFlow()
    expect(replay([...events, user(4, `确认重绑定 ${result.proposal.id}`, kind)]).items.get(old.id)?.status).toBe('pending')
  })
  it('T03/T10 rejects incomplete proposal persistence, different sessions, stale revisions, and delegated sessions', async () => {
    const { events, result, old } = await proposalFlow()
    const confirm = user(5, `确认重绑定 ${result.proposal.id}`)
    expect(replay([...events.slice(0, 2), confirm]).items.get(old.id)?.status).toBe('pending')
    expect(replay([...events, confirm], true, { ...scope, sessionHeader: { ...scope.sessionHeader, id: 'other' } }).items.get(old.id)?.status).toBe('pending')
    const stale = replay([...events, user(4, '一并更新 dshmarket'), confirm])
    expect(stale.items.get(old.id)?.status).toBe('pending')
    expect(stale.rebindProposals.get(result.proposal.id)?.status).toBe('stale')
    expect(replay([...events, confirm], true, { ...scope, sessionHeader: { ...scope.sessionHeader, parentSession: 'parent' } } as typeof scope).items.get(old.id)?.status).toBe('pending')
  })
  it('T04 rejects dropped source text and invented commit/install scope', async () => {
    const { events, old } = await proposalFlow()
    const p = replay(events)
    const tool = createRebindTool(() => p, async () => true)
    for (const clauses of [['更新皮肤中心'], ['commit repository=/repo'], ['install package=other profile=live']]) {
      expect(await tool.execute({ operation: 'propose', item_id: old.id, clauses }, undefined as never)).toMatchObject({ status: 'rejected' })
    }
    expect(p.items.get(old.id)?.status).toBe('pending')
  })
  it('T03 supports withdrawal and never accepts a model confirmation flag', async () => {
    const { events, old, result } = await proposalFlow()
    const p = replay(events)
    const tool = createRebindTool(() => p, async () => true)
    const args = { operation: 'withdraw' as const, proposal_id: result.proposal.id }
    const withdrawn = await tool.execute(args, undefined as never)
    events.push({ seq: 4, type: 'tool/call', data: { callId: 'withdraw', name: tool.name, arguments: JSON.stringify(args) } },
      { seq: 5, type: 'tool/result', data: { message: { source: { callId: 'withdraw' }, content: [{ type: 'text', text: JSON.stringify(withdrawn) }] } } },
      user(6, `确认重绑定 ${result.proposal.id}`))
    expect(replay(events).items.get(old.id)?.status).toBe('pending')
    expect(Object.keys(tool.parameters.properties ?? {})).not.toContain('confirmed')
  })
  it('T04/T12 retains unsupported remainders without certifying a generic success', async () => {
    const { events, result } = await proposalFlow()
    const p = replay([...events, user(4, `确认重绑定 ${result.proposal.id}`)])
    const response = await createCheckpointTool(() => p, () => {}).execute({ bindings: [] }, undefined as never)
    expect(response).toMatchObject({ status: 'incomplete', blockers: { total: 2 } })
    expect([...p.items.values()].filter(item => item.status === 'pending').map(item => item.normalizedText).join('')).toBe('更新皮肤中心、在本地仓库记录')
  })
})

it('T02/T03 maps an explicit later root clarification, never a model-supplied target', async () => {
  const events = [user(1, '更新插件'), user(2, '把更新插件明确为 install package demo@1.0.0 profile isolated')]
  const p = replay(events)
  const items = [...p.items.values()]
  expect(items).toHaveLength(2)
  const args = { operation: 'propose', item_id: items[0].id, clauses: [items[0].normalizedText], clarification_item_ids: [items[1].id] }
  const tool = createRebindTool(() => p, async () => true)
  const response = await tool.execute(args as never, undefined as never) as { status: string; proposal: { id: string } }
  expect(response.status).toBe('proposed')
  events.push({ seq: 3, type: 'tool/call', data: { callId: 'c', name: tool.name, arguments: JSON.stringify(args) } },
    { seq: 4, type: 'tool/result', data: { message: { source: { callId: 'c' }, content: [{ type: 'text', text: JSON.stringify(response) }] } } },
    user(5, `确认重绑定 ${response.proposal.id}`))
  const confirmed = replay(events)
  expect(confirmed.items.get(items[0].id)?.supersededByItems).toEqual([items[1].id])
  expect(confirmed.items.get(items[1].id)?.sourceMessageId).toBe(items[1].sourceMessageId)
  expect(confirmed.items.get(items[1].id)?.semanticAction).toBe('install')
})

it('T01 splits update/record and preserves GUI acceptance without inferring commit/install', () => {
  const p = replay([user(1, '更新皮肤中心并在本地仓库记录'), user(2, '一并更新 dshmarket')])
  expect([...p.items.values()].map(item => item.normalizedText)).toEqual(['更新皮肤中心', '在本地仓库记录', '一并更新 dshmarket'])
  expect([...p.items.values()].every(item => item.semanticAction === 'generic_run')).toBe(true)
  const visual = replay([user(1, 'Install package demo@1.0.0 profile isolated and verify GUI layout')])
  expect([...visual.items.values()].map(item => item.semanticAction)).toEqual(['install', 'generic_run'])
})
