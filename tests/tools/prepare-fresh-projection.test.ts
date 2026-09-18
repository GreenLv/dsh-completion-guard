import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { isJsonValue } from '@deepseek-ai/dsh-util-values'
import { createRuntime, type GuardRuntime } from '../../src/runtime.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { actionPreparation } from '../../src/tools/action-preparation.js'
import { STATEFUL_ACTIONS, ACTION_MANIFEST } from '../../src/domain/protocol-manifest.js'
function sessionWith(id: string): Session {
  return Session.create(SessionId(id), undefined, {
    version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId(id), createdAt: 1, cwd: '/fixture',
  })
}
function appendRootText(session: Session, text: string) {
  ;(session as unknown as { append: (type: string, data: unknown, options?: unknown) => unknown }).append(
    'user/message',
    { source: { kind: 'user' }, content: [{ type: 'text', text }] },
    { surfaceOp: 'append' },
  )
}
/**
 * The production wiring shape from `runtime.ts apply()`: flush, record the
 * durability watermark, re-derive, and only then answer the caller.
 */
function productionRefresh(runtime: GuardRuntime, durable: boolean) {
  return async () => {
    runtime.setDurability(durable)
    runtime.sync()
    return durable
  }
}
const ALWAYS = { activation: 'always' as const }
describe('0.6.0 P1: prepare sees the current step through the fresh-projection entry', () => {
  it('a root message persisted after the last sync is visible to prepare in the same turn', async () => {
    const session = sessionWith('prepare-same-turn')
    const runtime = createRuntime({ session } as never, ALWAYS)
    runtime.sync()
    // Nothing is open yet: the step's root message has not been appended.
    const before = await createPrepareTool({ getProjection: () => runtime.projection }).execute({} as never, undefined as never) as { total_open: number }
    expect(before.total_open).toBe(0)
    appendRootText(session, '创建 report.txt')
    // D06-01: without the refresh entry the cached projection still misses the
    // item; with it, the same turn sees the correctly capturable ID.
    const stale = await createPrepareTool({ getProjection: () => runtime.projection }).execute({} as never, undefined as never) as { total_open: number }
    expect(stale.total_open).toBe(0)
    const fresh = await createPrepareTool({
      getProjection: () => runtime.projection,
      refreshProjection: productionRefresh(runtime, true),
    }).execute({} as never, undefined as never) as { total_open: number; items: Array<{ id: string; revision: number; semantic_action: string }> }
    expect(fresh.total_open).toBe(1)
    expect(fresh.items[0]).toMatchObject({ id: 'R001', revision: 1, semantic_action: 'create' })
    // The discovered identity prepares directly, without guessing.
    const prepared = await createPrepareTool({
      getProjection: () => runtime.projection,
      refreshProjection: productionRefresh(runtime, true),
    }).execute({ item_id: fresh.items[0]!.id } as never, undefined as never) as { status: string; item: { id: string } }
    expect(prepared).toMatchObject({ status: 'prepared', item: { id: 'R001' } })
  })
  it('a failed flush is reported instead of serving a stale projection', async () => {
    const session = sessionWith('prepare-flush-failure')
    appendRootText(session, '创建 report.txt')
    const runtime = createRuntime({ session } as never, ALWAYS)
    const tool = createPrepareTool({
      getProjection: () => runtime.projection,
      refreshProjection: productionRefresh(runtime, false),
    })
    const discovery = await tool.execute({} as never, undefined as never) as { status: string; reason_code: string }
    // Fail loud, never an empty ledger and never a stale cache.
    expect(discovery).toEqual({ status: 'unknown', reason_code: 'projection_durability_unavailable' })
    const targeted = await tool.execute({ item_id: 'R001' } as never, undefined as never) as { status: string; reason_code: string }
    expect(targeted).toEqual({ status: 'unknown', reason_code: 'projection_durability_unavailable' })
    expect(isJsonValue(discovery)).toBe(true)
  })
  it('discovery stays bounded and names every current item identity', async () => {
    const session = sessionWith('prepare-discovery-bounded')
    for (let index = 1; index <= 9; index += 1) appendRootText(session, `创建 file${index}.txt`)
    const runtime = createRuntime({ session } as never, ALWAYS)
    const response = await createPrepareTool({
      getProjection: () => runtime.projection,
      refreshProjection: productionRefresh(runtime, true),
    }).execute({} as never, undefined as never) as {
      status: string; mode: string; total_open: number
      items: Array<{ id: string; revision: number; kind: string }>
    }
    expect(response.status).toBe('prepared')
    expect(response.mode).toBe('discovery')
    expect(response.total_open).toBe(9)
    expect(response.items).toHaveLength(8)
    expect(response.items.map((item) => item.id)).toEqual([
      'R001', 'R002', 'R003', 'R004', 'R005', 'R006', 'R007', 'R008',
    ])
    expect(isJsonValue(response)).toBe(true)
  })
})
describe('0.6.0 P1: the durability watermark is runtime-owned liveness state', () => {
  it('survives rebuilds and records the latest flush outcome', () => {
    const session = sessionWith('watermark-persistence')
    const runtime = createRuntime({ session } as never, ALWAYS)
    expect(runtime.projection.durabilityWatermark).toBe('unknown')
    runtime.setDurability(true)
    expect(runtime.projection.durabilityWatermark).toBe('confirmed')
    runtime.sync()
    expect(runtime.projection.durabilityWatermark).toBe('confirmed')
    runtime.setDurability(false)
    expect(runtime.projection.durabilityWatermark).toBe('failed')
    runtime.sync()
    expect(runtime.projection.durabilityWatermark).toBe('failed')
  })
})
describe('0.6.0 P1: one unified action descriptor drives every stateful preparation', () => {
  it.each(STATEFUL_ACTIONS)('%s keeps selector, producer, and readback identities consistent', (action) => {
    const descriptor = actionPreparation(action)
    const manifest = ACTION_MANIFEST.actions[action]
    // Caller selectors never include producer-computed identities…
    for (const field of descriptor.producer_fields) {
      expect(descriptor.selector_fields, `${action} lists producer field ${field} as caller input`).not.toContain(field)
    }
    // …readback mirrors the manifest's observed-state closure exactly…
    expect([...descriptor.readback_fields].sort()).toEqual([...manifest.observedStateKeys].sort())
    // …and the required selector identity is a subset of the resolved target
    // keys, so prepare output can never demand a field resolution would reject.
    for (const field of descriptor.selector_fields) {
      expect(manifest.resolvedTargetKeys, `${action} selector field ${field} is not a resolved target key`).toContain(field)
    }
    expect(manifest.commandManifestIds).toEqual(descriptor.command_manifest_ids)
    expect(descriptor.steps.length).toBeGreaterThanOrEqual(4)
  })
  it('prepare emits the full input contract for every stateful action as lossless JSON', async () => {
    // One action per fresh session: each iteration asserts one descriptor
    // contract, and an unrelated earlier obligation can never be the item the
    // discovery list happens to end on.
    for (const [index, action] of STATEFUL_ACTIONS.entries()) {
      const session = sessionWith(`prepare-descriptor-contract-${index}`)
      const runtime = createRuntime({ session } as never, ALWAYS)
      const tool = createPrepareTool({
        getProjection: () => runtime.projection,
        refreshProjection: productionRefresh(runtime, true),
      })
      appendRootText(session, `统一描述符 ${action} 标识${action} repository /synthetic/workspace`)
      const response = await tool.execute({} as never, undefined as never) as {
        status: string; total_open: number; items: Array<{ id: string; semantic_action: string }>
        missing_target_fields?: string[]
        evidence_input_contract?: Record<string, unknown>
      }
      expect(response.status, action).toBe('prepared')
      expect(response.total_open, action).toBeGreaterThan(0)
      const target = response.items.at(-1)!
      const prepared = await tool.execute({
        item_id: target.id, semantic_action: action,
      } as never, undefined as never) as {
        status: string; missing_target_fields: string[]
        evidence_input_contract?: Record<string, unknown>
      }
      expect(prepared.status, action).toBe('prepared')
      expect(prepared.evidence_input_contract, action).toMatchObject({
        selector_fields: expect.any(Array),
        producer_fields: expect.any(Array),
        readback_fields: expect.any(Array),
        execution_surface: expect.any(String),
        steps: expect.any(Array),
      })
      // Producer identities are never reported as missing caller input.
      for (const field of prepared.missing_target_fields) {
        expect((prepared.evidence_input_contract?.producer_fields as string[]) ?? [], `${action} demands producer field ${field}`).not.toContain(field)
      }
      expect(isJsonValue(prepared), action).toBe(true)
    }
  })
})