import { createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { expect, it } from 'vitest'
import { createCheckpointTool } from '../src/tools/checkpoint.js'
import { deriveProjection, PROTOCOL_V6_NOTICE } from '../src/domain/derive.js'
import { projectSessionCoreV2 } from '../src/core-v2/session.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'
import type { DerivedEnvelope } from '../src/domain/types.js'

function fixture(adopted = true, failed = false) {
  const events: DerivedEnvelope[] = [
    { seq: 1, type: 'user/message', data: { source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }] } },
    ...(adopted ? [{ seq: 2, type: 'command/run', data: { name: 'context-guard', source: { kind: 'user' }, args: 'on' } }] : []),
    { seq: 3, type: 'turn/start', data: { turn: 1 } },
    { seq: 4, type: 'user/message', data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: 'Run pnpm test in /fixture/one before finishing. Run pnpm test in /fixture/two before finishing.' }] } },
    { seq: 5, type: 'tool/call', data: { turn: 1, step: 1, callId: 'test-one', name: 'bash', arguments: JSON.stringify({ command: 'pnpm test', workdir: '/fixture/one' }) } },
    { seq: 6, type: 'tool/result', data: { turn: 1, step: 1, message: createToolResultMessage({ callId: 'test-one' as never, content: [{ type: 'text', text: failed ? 'failed\n[exit code: 1]' : 'passed\n[exit code: 0]' }], isError: failed }) } },
  ]
  const host = { ...evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' }), auditedForegroundRenderers: ['bash' as const] }
  const p = deriveProjection(events, { activation: 'always' }, { cwd: '/fixture' }, true, host).projection
  p.durabilityWatermark = 'confirmed'
  p.coreV2RequirementOrigins = new Map()
  p.coreV2 = projectSessionCoreV2(events, p, p.coreV2RequirementOrigins)
  return { p, events, host }
}

async function submitted(adopted = true, failed = false) {
  const f = fixture(adopted, failed), tool = createCheckpointTool(() => f.p, () => {}, async () => true)
  const discovery = await tool.execute({ bindings: [], item_ids: ['R001'] } as never, undefined as never) as any
  const template = discovery.open_items[0]?.binding_template
  return { ...f, tool, discovery, template }
}

it('reports a matched binding without a certificate and exposes filtered-out closure debt', async () => {
  const { p, tool, template } = await submitted()
  expect(template).toBeDefined()
  expect(p.goalCompletionAdopted).toBe(true)
  expect(p.coreV2?.predicates).toMatchObject({ R001: 'satisfied', R002: 'insufficient' })
  const response = await tool.execute({ bindings: [template], item_ids: ['R001'] } as never, undefined as never) as any
  expect(response.status).toBe('incomplete')
  expect(response.certificate).toBeUndefined()
  expect(response.certificate_status).toBe('not_issued')
  expect(response.open_items[0]).toMatchObject({ id: 'R001', status: 'pending', binding_status: 'matched_not_certified', reason_code: 'binding_matched_not_certified' })
  expect(response.open_items[0].binding_template).toBeUndefined()
  expect(response.open_items[0].next_step).not.toContain('Collect')
  expect(response.blockers).toMatchObject({ scope: 'whole_contract', scope_total: 2, matched_binding_total: 1, remaining_total: 1, filtered_out_total: 1,
    remaining_sample: [{ id: 'R002', reason_code: 'insufficient' }] })
  expect(response.rejected_bindings).toEqual(expect.arrayContaining([expect.objectContaining({ item_id: '*', reason_code: 'current_closure_unmet' })]))
  expect(p.items.get('R001')?.status).toBe('pending')
  expect(p.checkpoints).toHaveLength(0)
  expect(JSON.stringify(response).length).toBeLessThan(6500)
})

it('ordinary feedback remains core-owned and ignores legacy signing bindings', async () => {
  const { tool } = await submitted(false)
  const response = await tool.execute({ bindings: [{ item_id: 'R001', evidence_ids: ['bogus'] }], item_ids: ['R001'] } as never, undefined as never) as any
  expect(response.feedback_source).toBe('confirmed_core_v2')
  expect(response.certificate_status).toBe('not_requested')
  expect(response.blockers.matched_binding_total).toBeUndefined()
})

it('failure, mismatched target and duplicate binding never get a matched marker', async () => {
  const failed = await submitted(true, true)
  expect(failed.template).toBeUndefined()
  const failedResponse = await failed.tool.execute({ bindings: [{ item_id: 'R001', evidence_ids: ['E0001'] }], item_ids: ['R001'] } as never, undefined as never) as any
  expect(failedResponse.open_items[0].binding_status).toBeUndefined()
  const { tool, template } = await submitted()
  for (const bindings of [[{ ...template, resolved_target: { scope: '/elsewhere', executable: 'pnpm' } }], [template, template]]) {
    const response = await tool.execute({ bindings, item_ids: ['R001'] } as never, undefined as never) as any
    expect(response.status).toBe('incomplete')
    expect(response.open_items[0].binding_status).toBeUndefined()
    expect(response.blockers.matched_binding_total).toBe(0)
    expect(response.certificate).toBeUndefined()
  }
})

it('preserves cursor binding identity, whole-scope detail and response budget', async () => {
  const { tool, template, p } = await submitted()
  const bindings = [template]
  // Duplicate display evidence only to force a genuine independent page lane.
  const original = [...p.evidence.values()][0]!
  for (let i = 2; i < 12; i++) p.evidence.set(`E${String(i).padStart(4, '0')}`, { ...original, id: `E${String(i).padStart(4, '0')}` })
  const first = await tool.execute({ bindings, item_ids: ['R001'], limit: 1 } as never, undefined as never) as any
  const cursor = first.pagination.available_evidence.next_cursor
  expect(cursor).toBeTruthy()
  const same = await tool.execute({ bindings, item_ids: ['R001'], limit: 1, cursor } as never, undefined as never) as any
  expect(same.reason_code).not.toBe('stale_cursor')
  const changed = await tool.execute({ bindings: [], item_ids: ['R001'], limit: 1, cursor } as never, undefined as never) as any
  expect(changed.reason_code).toBe('stale_cursor')
  const detail = await tool.execute({ bindings, item_ids: ['R001'], detail_id: 'R001' } as never, undefined as never) as any
  expect(detail.blockers.remaining_total).toBe(1)
  expect(detail.certificate_status).toBe('not_issued')
  for (const page of [first, same, detail]) expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(12288)
})

it('current unmet core debt cannot be hidden by historically matching evidence', async () => {
  const { p, template } = await submitted()
  const failedEvents = fixture(true, true).events.slice(-2).map((e, i) => ({ ...e, seq: 7 + i, data: { ...(e.data as Record<string, unknown>), callId: i === 0 ? 'test-later' : undefined,
    ...(i === 1 ? { message: createToolResultMessage({ callId: 'test-later' as never, content: [{ type: 'text', text: 'failed\n[exit code: 1]' }], isError: true }) } : {}) } }))
  const f = fixture()
  const events = [...f.events, ...failedEvents]
  const later = deriveProjection(events, { activation: 'always' }, { cwd: '/fixture' }, true, f.host).projection
  later.durabilityWatermark = 'confirmed'; later.coreV2RequirementOrigins = new Map(); later.coreV2 = projectSessionCoreV2(events, later, later.coreV2RequirementOrigins)
  const tool = createCheckpointTool(() => later, () => {}, async () => true)
  const out = await tool.execute({ bindings: [template], item_ids: ['R001'] } as never, undefined as never) as any
  expect(out.status).toBe('incomplete')
  expect(out.open_items[0].binding_status).toBeUndefined()
  expect(out.blockers.remaining_total).toBeGreaterThanOrEqual(2)
  expect(p.checkpoints).toHaveLength(0)
})

it('complete successful closure still certifies without mutating the projection', async () => {
  const f = fixture()
  const events = [...f.events,
    { seq: 7, type: 'tool/call', data: { turn: 1, step: 2, callId: 'test-two', name: 'bash', arguments: JSON.stringify({ command: 'pnpm test', workdir: '/fixture/two' }) } },
    { seq: 8, type: 'tool/result', data: { turn: 1, step: 2, message: createToolResultMessage({ callId: 'test-two' as never, content: [{ type: 'text', text: 'passed\n[exit code: 0]' }], isError: false }) } },
  ]
  const p = deriveProjection(events, { activation: 'always' }, { cwd: '/fixture' }, true, f.host).projection
  p.durabilityWatermark = 'confirmed'; p.coreV2RequirementOrigins = new Map(); p.coreV2 = projectSessionCoreV2(events, p, p.coreV2RequirementOrigins)
  const tool = createCheckpointTool(() => p, () => {}, async () => true)
  const first = await tool.execute({ bindings: [] }, undefined as never) as any
  const bindings = first.open_items.map((item: any) => item.binding_template)
  expect(bindings.every(Boolean)).toBe(true)
  const out = await tool.execute({ bindings } as never, undefined as never) as any
  expect(out.status).toBe('certified'); expect(out.certificate).toBeDefined()
  expect(out.blockers.matched_binding_total).toBeUndefined()
  expect(p.checkpoints).toHaveLength(0)
  expect([...p.items.values()].every(i => i.status === 'pending')).toBe(true)
})

it('keeps a rejected global proof visible even with a matched filtered item', async () => {
  const { tool, template } = await submitted()
  const out = await tool.execute({ bindings: [template], item_ids: ['R001'], proof: {} } as never, undefined as never) as any
  expect(out.status).toBe('incomplete')
  expect(out.proof_state.status).toBe('invalid')
  expect(out.blockers.unresolved_global).toBe(true)
  expect(out.rejected_bindings.some((row: any) => row.item_id === '*')).toBe(true)
  expect(out.certificate).toBeUndefined()
})
