import { sha256 } from '../domain/canonicalize.js'
import type { GuardProjection } from '../domain/types.js'

export interface PageQuery {
  item_ids?: string[]
  evidence_ids?: string[]
  evidence_scope?: 'relevant' | 'history'
  cursor?: string
  limit?: number
  detail_id?: string
  detail_offset?: number
  detail_snapshot?: string
}
const LANES = ['open_items', 'active_constraints', 'rejected_bindings', 'available_evidence', 'available_qualifications'] as const
const MAX_BYTES = 12288
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')
const digest = (value: unknown) => sha256(JSON.stringify(value))
const lookup = (id: string) => id.length <= 128 ? id : `sha256:${sha256(id)}`

/** Changes only display. The caller already certified the complete contract. */
export function checkpointPage(p: GuardProjection, query: PageQuery, full: Record<string, unknown>): Record<string, unknown> {
  const { item_ids, evidence_ids, evidence_scope = 'relevant', limit = 10, detail_id, detail_offset = 0 } = query
  const identity = digest({ session: p.sessionRefDigest, epoch: p.epoch, revision: p.contractRevision,
    evidence: [...p.evidence.values()], items: [...p.items.values()], item_ids, evidence_ids, evidence_scope, limit, bindings: (query as PageQuery & { bindings?: unknown }).bindings, rejections: full.rejected_bindings })
  const invalid = (reason: string) => ({ status: 'unknown', contract_revision: p.contractRevision, reason_code: reason,
    next_step: 'Restart context_guard_checkpoint without cursor.', open_items: [], available_evidence: [], rejected_bindings: [] })
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !['relevant', 'history'].includes(evidence_scope)) return invalid('invalid_query')
  let lane: typeof LANES[number] | undefined
  let offset = 0
  if (query.cursor) {
    try {
      if (query.cursor.length > 1024) return invalid('malformed_cursor')
      const parsed = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'))
      if (!LANES.includes(parsed.lane) || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) return invalid('malformed_cursor')
      if (parsed.identity !== identity) return invalid('stale_cursor')
      lane = parsed.lane
      offset = parsed.offset
    } catch { return invalid('malformed_cursor') }
  }
  const rows = Object.fromEntries(LANES.map(key => [key, (full[key] ?? []) as Record<string, unknown>[]])) as Record<typeof LANES[number], Record<string, unknown>[]>
  if (item_ids?.length) {
    rows.open_items = rows.open_items.filter(row => item_ids.includes(String(row.id)))
    rows.active_constraints = rows.active_constraints.filter(row => item_ids.includes(String(row.id)))
    rows.rejected_bindings = rows.rejected_bindings.filter(row => item_ids.includes(String(row.item_id)))
  }
  if (evidence_ids?.length) rows.available_evidence = rows.available_evidence.filter(row => evidence_ids.includes(String(row.id)))
  if (lane && offset > rows[lane].length) return invalid('invalid_cursor_offset')
  if (detail_id) {
    if (!Number.isSafeInteger(detail_offset) || detail_offset < 0) return invalid('invalid_detail_offset')
    if (detail_offset > 0 && query.detail_snapshot !== identity) return invalid('stale_detail_snapshot')
    const matches = LANES.flatMap(key => rows[key].filter(row => row.id === detail_id || row.item_id === detail_id || lookup(String(row.id ?? row.item_id)) === detail_id).map(row => ({ kind: key, ...row })))
    const data = JSON.stringify(matches)
    if (detail_offset > data.length) return invalid('invalid_detail_offset')
    let chunk = data.slice(detail_offset, detail_offset + 1600)
    while (size(chunk) > 8000) chunk = chunk.slice(0, -100)
    return { status: full.status, contract_revision: p.contractRevision, detail_id: lookup(detail_id), detail_offset, detail_chunk: chunk,
      next_detail_offset: detail_offset + chunk.length < data.length ? detail_offset + chunk.length : null, snapshot: identity }
  }
  const reasons = new Map<string, number>()
  for (const row of [...rows.open_items, ...rows.rejected_bindings]) {
    const reason = String(row.reason_code ?? 'missing_evidence').slice(0, 160)
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
  }
  const output: Record<string, unknown> = { status: full.status, contract_revision: p.contractRevision,
    blockers: { total: Number(full.blocking_total ?? (full.open_items as unknown[]).length), rejected: (full.rejected_bindings as unknown[]).length, reasons: [...reasons].slice(0, 8).map(([reason_code, count]) => ({ reason_code, count })), folded_reason_count: Math.max(0, reasons.size - 8) },
    open_items: [], active_constraints: [], rejected_bindings: [], available_evidence: [], available_qualifications: [] }
  if (full.certificate) output.certificate = full.certificate
  const pagination: Record<string, unknown> = { snapshot: identity, scope: evidence_scope,
    counts: { pending: [...p.items.values()].filter(i => i.status === 'pending').length,
      passed: [...p.items.values()].filter(i => i.status === 'passed').length,
      superseded: [...p.items.values()].filter(i => i.status === 'superseded').length },
    detail_query: 'Use detail_id and detail_offset; evidence_scope=history includes non-citable evidence.' }
  const summarize = (row: Record<string, unknown>) => {
    if (size(row) <= 1800) return row
    return { id: String(row.id ?? row.item_id).slice(0, 128), reason_code: row.reason_code, certifiable: row.certifiable,
      next_step: typeof row.next_step === 'string' ? row.next_step.slice(0, 240) : undefined,
      adapter_disposition: row.adapter_disposition,
      omitted: true, detail_id: lookup(String(row.id ?? row.item_id)) }
  }
  for (const key of LANES) {
    const start = lane === key ? offset : 0
    const cap = lane && lane !== key ? 0 : key === 'open_items' ? Math.min(limit, 8)
      : key === 'active_constraints' ? Math.min(limit, 8 - (output.open_items as unknown[]).length) : limit
    const selected: Record<string, unknown>[] = []
    for (const row of rows[key].slice(start, start + cap)) {
      const candidate = summarize(row)
      // Reserve enough for all independent cursor envelopes and the certificate.
      if (size({ ...output, [key]: [...selected, candidate] }) > MAX_BYTES - 2400) break
      selected.push(candidate)
    }
    output[key] = selected
    const next = start + selected.length
    pagination[key] = { total: rows[key].length, returned: selected.length, folded: rows[key].length - selected.length,
      next_cursor: next < rows[key].length ? Buffer.from(JSON.stringify({ identity, lane: key, offset: next })).toString('base64url') : null }
  }
  output.pagination = pagination
  if (size(output) > MAX_BYTES) return invalid('response_budget_exceeded')
  return JSON.parse(JSON.stringify(output)) as Record<string, unknown>
}
