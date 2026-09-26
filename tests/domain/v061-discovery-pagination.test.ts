import { describe, expect, it } from 'vitest'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { createProjection, type GuardItem, type GuardProjection, type DerivedEnvelope } from '../../src/domain/types.js'

/**
 * 0.6.1 W060-03 (plan V03): discovery traverses the FULL applicable set.
 *
 * Fixed page size, stable order, and a cursor bound to the projection
 * revision: a projection change between pages invalidates the cursor
 * explicitly instead of silently skipping or repeating items. `semantic_action`
 * is the only filter, and it is part of the cursor so page two continues the
 * same filtered listing. Under a v5 boundary the listing is the current unit's
 * closure plus required descendants plus pre-v5 obligations — a switched-away
 * sibling's history is reached by item ID, not re-listed here.
 */

function item(row: {
  id: string
  revision: number
  semanticAction?: GuardItem['semanticAction']
  unitId?: string
  normalizedText?: string
  taskKind?: 'inquiry' | 'action'
  status?: 'pending' | 'passed' | 'answered' | 'superseded'
}): GuardProjection['items'] extends Map<string, infer T> ? T : never {
  return {
    id: row.id,
    revision: row.revision,
    kind: 'requirement',
    sourceMessageId: 'm2',
    normalizedText: row.normalizedText ?? `obligation ${row.id}`,
    textSha256: 'a'.repeat(64),
    status: row.status ?? 'pending',
    verification: { enforced: true, surface: 'scope', subject: '/repo' },
    semanticAction: row.semanticAction ?? 'generic_run',
    requestedTarget: { scope: '/repo' },
    targetCaptureStatus: 'resolved',
    ...(row.taskKind !== undefined ? { taskKind: row.taskKind } : {}),
    ...(row.unitId !== undefined ? { unitId: row.unitId } : {}),
  }
}

function projectionWith(rows: Array<Parameters<typeof item>[0]>): GuardProjection {
  const p = createProjection()
  p.enabled = true
  for (const row of rows) p.items.set(row.id, item(row))
  return p
}

async function discover(p: GuardProjection, args: Record<string, unknown> = {}) {
  return await createPrepareTool({ getProjection: () => p }).execute(args as never, undefined as never) as {
    status: string
    reason_code?: string
    contract_revision?: number
    total_open?: number
    listed?: number
    has_more?: boolean
    items?: Array<{ id: string }>
    next_cursor?: string
    filtered_by?: { semantic_action: string }
  }
}

describe('0.6.1 W060-03: discovery pagination traverses the full applicable set', () => {
  it('an empty projection lists nothing with total 0', async () => {
    const page = await discover(projectionWith([]))
    expect(page).toMatchObject({ status: 'prepared', total_open: 0, listed: 0, has_more: false })
    expect(page.items).toEqual([])
    expect(page.next_cursor).toBeUndefined()
  })

  it('one page holds up to 8 items and reports the totals', async () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({ id: `R${String(index + 1).padStart(3, '0')}`, revision: index + 1 }))
    const page = await discover(projectionWith(rows))
    expect(page.total_open).toBe(8)
    expect(page.listed).toBe(8)
    expect(page.items).toHaveLength(8)
    expect(page.has_more).toBe(false)
    expect(page.next_cursor).toBeUndefined()
  })

  it('nine items need two pages and traversal equals the full set with no gaps or repeats', async () => {
    const rows = Array.from({ length: 9 }, (_, index) => ({ id: `R${String(index + 1).padStart(3, '0')}`, revision: index + 1 }))
    const p = projectionWith(rows)
    const page1 = await discover(p)
    expect(page1).toMatchObject({ total_open: 9, listed: 8, has_more: true })
    expect(page1.next_cursor).toBeDefined()
    const page2 = await discover(p, { page_cursor: page1.next_cursor })
    expect(page2).toMatchObject({ total_open: 9, listed: 1, has_more: false })
    expect(page2.next_cursor).toBeUndefined()
    const traversed = [...page1.items!, ...page2.items!].map((row) => row.id)
    expect(traversed).toHaveLength(9)
    expect(new Set(traversed)).toHaveLength(9)
    expect(traversed).toEqual(rows.map((row) => row.id))
  })

  it('a few dozen items traverse completely across pages', async () => {
    const rows = Array.from({ length: 37 }, (_, index) => ({ id: `R${String(index + 1).padStart(3, '0')}`, revision: index + 1 }))
    const p = projectionWith(rows)
    const seen: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await discover(p, cursor !== undefined ? { page_cursor: cursor } : {})
      seen.push(...page.items!.map((row) => row.id))
      if (!page.has_more) break
      cursor = page.next_cursor
      expect(cursor).toBeDefined()
    }
    expect(seen).toHaveLength(37)
    expect(new Set(seen)).toHaveLength(37)
    expect(seen).toEqual(rows.map((row) => row.id))
  })

  it('a cursor bound to an older revision is explicitly stale, never silently served', async () => {
    const rows = Array.from({ length: 9 }, (_, index) => ({ id: `R${String(index + 1).padStart(3, '0')}`, revision: index + 1 }))
    const p = projectionWith(rows)
    const page1 = await discover(p)
    // The contract moves between pages (a new obligation is captured).
    p.items.set('R010', item({ id: 'R010', revision: 10 }))
    p.contractRevision = 10
    const refused = await discover(p, { page_cursor: page1.next_cursor })
    expect(refused.status).toBe('rejected')
    expect(refused.reason_code).toBe('discovery_cursor_stale')
    expect(refused.contract_revision).toBe(10)
    // Re-listing from the start serves the NEW listing: 10 open items, and a
    // full traversal reaches the new tail item. Nothing is skipped by a stale
    // page.
    const fresh = await discover(p)
    expect(fresh.total_open).toBe(10)
    const seen: string[] = []
    let cursor: string | undefined = fresh.next_cursor
    seen.push(...fresh.items!.map((row) => row.id))
    while (cursor !== undefined) {
      const page = await discover(p, { page_cursor: cursor })
      seen.push(...page.items!.map((row) => row.id))
      cursor = page.has_more ? page.next_cursor : undefined
    }
    expect(seen).toHaveLength(10)
    expect(new Set(seen)).toHaveLength(10)
    expect(seen).toContain('R010')
  })

  it('a malformed cursor and a filter change are refused with exact reason codes', async () => {
    const p = projectionWith(Array.from({ length: 9 }, (_, index) => ({ id: `R${String(index + 1).padStart(3, '0')}`, revision: index + 1 })))
    const malformed = await discover(p, { page_cursor: '!!!not-a-cursor' })
    expect(malformed).toMatchObject({ status: 'rejected', reason_code: 'discovery_cursor_malformed' })
    const page1 = await discover(p)
    const mismatched = await discover(p, { page_cursor: page1.next_cursor, semantic_action: 'commit' })
    expect(mismatched).toMatchObject({ status: 'rejected', reason_code: 'discovery_cursor_filter_mismatch' })
  })

  it('the semantic_action filter is declared, applied, and paginated over the filtered set', async () => {
    const rows = [
      { id: 'R001', revision: 1, semanticAction: 'commit' as const },
      { id: 'R002', revision: 2, semanticAction: 'generic_run' as const },
      { id: 'R003', revision: 3, semanticAction: 'commit' as const },
      ...Array.from({ length: 7 }, (_, index) => ({ id: `R${String(index + 4).padStart(3, '0')}`, revision: index + 4, semanticAction: 'commit' as const })),
    ]
    const p = projectionWith(rows)
    const filtered = await discover(p, { semantic_action: 'commit' })
    expect(filtered.total_open).toBe(9)
    expect(filtered.items!.every((row) => rows.find((source) => source.id === row.id)!.semanticAction === 'commit')).toBe(true)
    expect(filtered.filtered_by).toEqual({ semantic_action: 'commit' })
    // 9 commits: page one shows the first 8, the cursor continues the SAME
    // filtered listing for the ninth.
    expect(filtered.has_more).toBe(true)
    const filteredPage2 = await discover(p, { semantic_action: 'commit', page_cursor: filtered.next_cursor })
    expect(filteredPage2.total_open).toBe(9)
    expect(filteredPage2.items!.map((row) => row.id)).toEqual(['R010'])
    const unfiltered = await discover(p)
    expect(unfiltered.total_open).toBe(10)
  })

  it('the incident shape is reachable: an old unknown prefix cannot shadow a new git tail', async () => {
    // 8 older items (generic/inquiry noise) captured before a late commit and
    // push pair: 0.6.0 truncated at the first page and the git tail was
    // invisible to discovery.
    const rows = [
      ...Array.from({ length: 8 }, (_, index) => ({ id: `R${String(index + 1).padStart(3, '0')}`, revision: index + 1, normalizedText: `历史遗留条目 ${index + 1}` })),
      { id: 'R009', revision: 9, semanticAction: 'commit' as const, normalizedText: '提交变更' },
      { id: 'R010', revision: 10, semanticAction: 'push' as const, normalizedText: '推送到远端' },
    ]
    const p = projectionWith(rows)
    const seen: string[] = []
    let cursor: string | undefined
    for (;;) {
      const page = await discover(p, cursor !== undefined ? { page_cursor: cursor } : {})
      seen.push(...page.items!.map((row) => row.id))
      if (!page.has_more) break
      cursor = page.next_cursor
    }
    expect(seen).toHaveLength(10)
    expect(seen).toContain('R009')
    expect(seen).toContain('R010')
    // Targeted discovery finds the push directly as well.
    const pushes = await discover(p, { semantic_action: 'push' })
    expect(pushes.items!.map((row) => row.id)).toEqual(['R010'])
  })

  it('a v5 session lists the current unit closure plus pre-v5 obligations, not switched-away history', async () => {
    const events: DerivedEnvelope[] = []
    let seq = 0
    const env = (type: string, data: unknown): DerivedEnvelope => ({ seq: seq++, type, data })
    events.push(
      env('user/message', { source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text: PROTOCOL_V5_NOTICE }] }),
      env('turn/start', { turn: 1 }),
      env('user/message', { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: '创建 report.txt' }] }),
      env('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '好的。' }] } }),
      env('turn/end', { turn: 1, reason: { kind: 'completed' } }),
      env('turn/start', { turn: 2 }),
      env('user/message', { turn: 2, source: { kind: 'user' }, content: [{ type: 'text', text: '另外，更新皮肤中心' }] }),
      env('assistant/message', { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '明白。' }] } }),
      env('turn/end', { turn: 2, reason: { kind: 'completed' } }),
    )
    const { projection } = deriveProjection(events, { activation: 'always' as const }, { cwd: '/repo', sessionHeader: { version: 3, id: 'v061-discovery-units', createdAt: 1 } }, true)
    expect(projection.units.size).toBe(2)
    expect(projection.currentUnitId).toBe('U002')
    expect(projection.items.get('R001')?.unitId).toBe('U001')
    expect(projection.items.get('R002')?.unitId).toBe('U002')
    const page = await discover(projection)
    const listed = page.items!.map((row) => row.id)
    // U001 was switched away: its residual create work is NOT re-listed as
    // current work, but U002's own obligation is.
    expect(listed).toEqual(['R002'])
    // The switched-away history stays reachable by its known identity.
    const direct = await createPrepareTool({ getProjection: () => projection })
      .execute({ item_id: 'R001' } as never, undefined as never) as { status: string; item?: { id: string } }
    expect(direct.status).toBe('prepared')
    expect(direct.item).toMatchObject({ id: 'R001' })
  })
})
