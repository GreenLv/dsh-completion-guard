import { describe, expect, it } from 'vitest'
import { createCheckpointTool } from '../../src/tools/checkpoint.js'
import { captureClause } from '../../src/domain/capture.js'
import { createProjection } from '../../src/domain/types.js'
import { renderRecoveryPacket } from '../../src/domain/recovery.js'

/**
 * T06 interprets 200 clauses of 4000+ characters — the size class the
 * analysis-bounds tests pin — so it is CPU-bound rather than slow in the
 * product. The default 5 s budget holds when this file runs alone (~4.8 s) and
 * fails only when the whole suite competes for cores, so the budget is raised
 * to fit the fixture instead of shrinking the fixture the test needs.
 */
const T06_TIMEOUT_MS = 60_000

describe('0.4.2 bounded feedback regressions', () => {
  it('T01/T05 explains generic update capability without command guidance', async () => {
    const p = createProjection()
    p.enabled = true
    p.items.set('R001', captureClause('更新皮肤中心并在本地仓库记录', 'm1', 'R001', 1))
    const result = await createCheckpointTool(() => p, () => {}).execute({ bindings: [] }, undefined as never)
    expect(result).toMatchObject({ status: 'incomplete', open_items: [{ certifiable: false, reason_code: 'generic_run_non_certifiable' }] })
    // v0.5: generic obligations name the honest-delivery repair condition
    // instead of pointing at a rebind that cannot add certification.
    expect(JSON.stringify(result)).toContain('fresh root-user instruction')
    expect(JSON.stringify(result)).not.toContain('context_guard_rebind')
    expect(renderRecoveryPacket(p)).not.toContain('whitelisted executable')
  })
  it.each([50, 100, 200])('T06 bounds %i history rows to 12 KiB', async (count) => {
    const p = createProjection()
    p.enabled = true
    for (let i = 0; i < count; i++) p.evidence.set(`E${i}`, {
      id: `E${i}`, epoch: 0, callId: `c${i}`, rootCallId: `c${i}`, toolName: 'bash', toolResultSeq: i,
      outcome: 'success', subjects: ['中'.repeat(4000)], surfaces: ['scope'], capabilities: [], boundedSummarySha256: '11'.repeat(32),
    })
    const result = await createCheckpointTool(() => p, () => {}).execute({ bindings: [], evidence_scope: 'history' } as never, undefined as never)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(12288)
  })
  it('T08 reserves rules and next steps even after an oversized item', () => {
    const p = createProjection()
    p.items.set('R001', captureClause('更新' + '中'.repeat(4001), 'm1', 'R001', 1))
    p.items.set('P001', { ...captureClause('不要发布', 'm1', 'P001', 2), kind: 'prohibition' })
    for (const charBudget of [512, 4000]) {
      const packet = renderRecoveryPacket(p, { charBudget })
      expect(packet.length).toBeLessThanOrEqual(charBudget)
      expect(packet).toContain('DO NOT')
      expect(packet).toContain('checkpoint')
      expect(packet).toContain('uncertified')
    }
  })
})

it('T07 paginates a stable history without gaps and rejects changed snapshots', async () => {
  const p = createProjection()
  p.enabled = true
  for (let i = 0; i < 50; i++) p.evidence.set(`E${String(i).padStart(3, '0')}`, {
    id: `E${String(i).padStart(3, '0')}`, epoch: 0, callId: `c${i}`, rootCallId: `c${i}`, toolName: 'bash', toolResultSeq: i,
    outcome: 'success', subjects: [], surfaces: [], capabilities: [], boundedSummarySha256: '11'.repeat(32), parseStatus: 'unsupported_command',
  })
  const tool = createCheckpointTool(() => p, () => {})
  const args = { bindings: [], evidence_scope: 'history', limit: 7 }
  type Page = { status: string; reason_code?: string; available_evidence: Array<{ id: string; adapter_disposition: string }>; pagination: { available_evidence: { next_cursor: string | null } } }
  let page = await tool.execute(args as never, undefined as never) as Page
  const cursor = page.pagination.available_evidence.next_cursor!
  const seen = page.available_evidence.map(e => e.id)
  expect(page.available_evidence.every(e => e.adapter_disposition === 'unavailable')).toBe(true)
  while (page.pagination.available_evidence.next_cursor) {
    page = await tool.execute({ ...args, cursor: page.pagination.available_evidence.next_cursor } as never, undefined as never) as Page
    seen.push(...page.available_evidence.map(e => e.id))
  }
  expect(seen).toHaveLength(50)
  expect(new Set(seen).size).toBe(50)
  p.contractRevision++
  expect(await tool.execute({ ...args, cursor } as never, undefined as never)).toMatchObject({ reason_code: 'stale_cursor' })
  expect(await tool.execute({ ...args, cursor: '%bad' } as never, undefined as never)).toMatchObject({ reason_code: 'malformed_cursor' })
})

it('T06/T11 retrieves oversized evidence details by ID as valid bounded JSON fragments', async () => {
  const p = createProjection()
  p.enabled = true
  const subject = '中'.repeat(9000)
  p.evidence.set('E1', { id: 'E1', epoch: 0, callId: 'c1', rootCallId: 'c1', toolName: 'bash', toolResultSeq: 1,
    outcome: 'success', subjects: [subject], surfaces: [], capabilities: [], boundedSummarySha256: '11'.repeat(32) })
  const tool = createCheckpointTool(() => p, () => {})
  let offset: number | null = 0
  let detail = ''
  let snapshot: string | undefined
  while (offset !== null) {
    const result = await tool.execute({ bindings: [], evidence_scope: 'history', detail_id: 'E1', detail_offset: offset, ...(snapshot ? { detail_snapshot: snapshot } : {}) } as never, undefined as never) as { detail_chunk: string; next_detail_offset: number | null; snapshot: string }
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(12288)
    snapshot = result.snapshot
    detail += result.detail_chunk
    offset = result.next_detail_offset
  }
  expect(JSON.parse(detail)[0].subjects).toEqual([subject])
})

it('T05 never borrows a binding template from another target', async () => {
  const p = createProjection()
  p.enabled = true
  const item = captureClause('Run pnpm test', 'm1', 'R1', 1, { cwd: '/wanted' })
  p.items.set(item.id, item)
  p.evidence.set('E1', { id: 'E1', epoch: 0, callId: 'c1', rootCallId: 'c1', toolName: 'bash', toolResultSeq: 1,
    outcome: 'success', subjects: ['/other'], surfaces: ['scope'], capabilities: ['deterministic-check'], boundedSummarySha256: '11'.repeat(32),
    semanticAction: 'test', parseStatus: 'supported', resolvedTarget: { scope: '/other', executable: 'pnpm' } })
  const response = await createCheckpointTool(() => p, () => {}).execute({ bindings: [] }, undefined as never) as { open_items: Record<string, unknown>[]; available_evidence: unknown[] }
  expect(response.open_items[0].binding_template).toBeUndefined()
  expect(response.available_evidence).toEqual([])
})

it('T06 keeps the entire certification set despite focused display and returns folded constraints by ID', async () => {
  const p = createProjection()
  p.enabled = true
  for (let i = 0; i < 100; i++) {
    const item = captureClause('更新' + '中'.repeat(4000), `m${i}`, `R${i}`, i)
    p.items.set(item.id, item)
    const prohibition = captureClause('不要发布' + '中'.repeat(4000), `p${i}`, `P${i}`, i)
    p.items.set(prohibition.id, prohibition)
  }
  const tool = createCheckpointTool(() => p, () => {})
  const response = await tool.execute({ bindings: [], item_ids: ['R0'] }, undefined as never) as { status: string; blockers: { total: number }; open_items: unknown[] }
  expect(response.status).toBe('incomplete')
  expect(response.blockers.total).toBe(100)
  expect(response.open_items).toHaveLength(1)
  expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(12288)
  const constraint = await tool.execute({ bindings: [], item_ids: ['P99'], detail_id: 'P99' } as never, undefined as never) as { detail_chunk: string }
  expect(constraint.detail_chunk).toContain('P99')
}, T06_TIMEOUT_MS)

it('T04 rejects pre-clarification evidence without changing its historical ID', async () => {
  const p = createProjection()
  p.enabled = true
  const item = captureClause('Run pnpm test', 'm10', 'R1', 10, { cwd: '/repo' })
  item.reboundFrom = { itemId: 'R0', proposalId: 'RB-test', confirmationEvent: 'm12' }
  p.items.set(item.id, item)
  p.evidence.set('E-old', { id: 'E-old', epoch: 0, callId: 'c1', rootCallId: 'c1', toolName: 'bash', toolResultSeq: 2,
    outcome: 'success', subjects: ['/repo'], surfaces: ['scope'], capabilities: ['deterministic-check'], boundedSummarySha256: '11'.repeat(32),
    semanticAction: 'test', parseStatus: 'supported', resolvedTarget: { scope: '/repo', executable: 'pnpm' } })
  const response = await createCheckpointTool(() => p, () => {}).execute({ bindings: [{ item_id: 'R1', evidence_ids: ['E-old'] }] }, undefined as never)
  expect(response).toMatchObject({ status: 'incomplete', available_evidence: [], rejected_bindings: [{ reason_code: 'rebind_evidence_predates_source' }] })
  expect(p.evidence.has('E-old')).toBe(true)
})
