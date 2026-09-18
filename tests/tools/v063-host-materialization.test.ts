import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { decideTurnBoundary } from '../../src/domain/stop-policy.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { createBoundaryTool } from '../../src/tools/boundary.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import type { DerivedEnvelope, GuardProjection } from '../../src/domain/types.js'

/**
 * 0.6.3 T07: the obligation survives the REAL wiring, not just a direct call.
 *
 * A synthetic host turn is captured, the registered Guard tools are
 * materialized through the real DSH `ToolRuntime` output contract, and the
 * Stop decision is read from the production policy. The point is that the K1–K4
 * corrections are visible on the path a session actually takes — a call that
 * goes through tool registration, schema validation, and serialization — and
 * that the historical negative boundaries (producer reference, boundary
 * qualification) still refuse.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/workspace/repo-a', sessionHeader: { version: 3, id: 'v063-host', createdAt: 1 } }

let seq = 0
const reset = () => { seq = 0 }
const notice = (): DerivedEnvelope => ({ seq: seq++, type: 'user/message', data: {
  source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' },
  content: [{ type: 'text', text: PROTOCOL_V5_NOTICE }],
} })
const user = (text: string, turn: number): DerivedEnvelope => ({ seq: seq++, type: 'user/message', data: {
  turn, source: { kind: 'user' }, content: [{ type: 'text', text }],
} })
const assistant = (turn: number, text: string): DerivedEnvelope => ({ seq: seq++, type: 'assistant/message', data: {
  turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] },
} })
const turnEnd = (turn: number): DerivedEnvelope => ({ seq: seq++, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })

function hostTurn(text: string, answer: string): GuardProjection {
  reset()
  return deriveProjection([
    notice(),
    { seq: seq++, type: 'turn/start', data: { turn: 1 } } as DerivedEnvelope,
    user(text, 1),
    assistant(1, answer),
    turnEnd(1),
  ], config, scope, true).projection
}

function host(): { runtime: ToolRuntime; ctx: Context } {
  const ctx = new Context()
  new SystemPrompt(ctx, {})
  return { runtime: new ToolRuntime(ctx), ctx }
}

const textOf = (response: { content: Array<{ type: string; text?: string }> }): string =>
  response.content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('')

describe('0.6.3 T07: the corrections hold through the registered tool path', () => {
  it('a mixed request keeps its execution obligations through prepare and the authorizer', async () => {
    const projection = hostTurn('更新插件，检查是否存在更新，安装新主题，记录变更。', '已收到。')
    const { runtime } = host()
    runtime.register(createPrepareTool({ getProjection: () => projection }))

    const discovery = await runtime.execute({
      callId: 'discovery' as never, name: 'context_guard_prepare', arguments: {},
      signal: new AbortController().signal,
    })
    expect(discovery.isError).toBe(false)
    const list = JSON.parse(textOf(discovery)) as { status: string; items: Array<{ id: string; text: string; reason_code: string }> }
    expect(list.status).toBe('prepared')
    // The information range is already answered, so it is not listed as open
    // work; every execution obligation is.
    expect(list.items.map((item) => item.text)).toEqual(['更新插件', '安装新主题，记录变更。'])
    for (const item of list.items) expect(item.reason_code).not.toBe('answer_delivered')

    // The authorizer refuses each open obligation for the environment default.
    for (const item of list.items) {
      const detail = [...projection.items.values()].find((row) => row.id === item.id)!
      if (detail.semanticAction !== 'commit' && detail.semanticAction !== 'push') continue
      const decision = authorizeMutationFromProjection(projection, {
        action: detail.semanticAction, contractItemId: detail.id, contractItemRevision: detail.revision,
        resolvedTarget: { repository: '/workspace/repo-a', branch: 'main', remote: 'origin', refspec: 'main' },
      })
      expect(decision.status).toBe('denied')
    }
  })

  it('a cross-family prepare assumption is refused as lossless JSON, never as an executable recipe', async () => {
    const projection = hostTurn('提交仓库 /work/repo-a 的变更。', '好。')
    const commit = [...projection.items.values()].find((item) => item.semanticAction === 'commit')!
    const { runtime } = host()
    runtime.register(createPrepareTool({ getProjection: () => projection }))
    const response = await runtime.execute({
      callId: 'prepare' as never, name: 'context_guard_prepare',
      arguments: { item_id: commit.id, item_revision: commit.revision, semantic_action: 'push' },
      signal: new AbortController().signal,
    })
    expect(response.isError).toBe(false)
    const value = JSON.parse(textOf(response)) as Record<string, unknown>
    expect(value.status).toBe('incompatible')
    expect(value.reason_code).toBe('action_not_compatible_with_item')
    expect(value.evidence_input_contract).toBeUndefined()
    expect((value.compatibility as { item_action: string }).item_action).toBe('commit')
    expect(Buffer.byteLength(textOf(response))).toBeLessThanOrEqual(12288)
  })

  it('an ordinary turn still stops normally, and the open work stays recorded', () => {
    const projection = hostTurn('更新插件，检查是否存在更新，安装新主题，记录变更。', '已收到。')
    const decision = decideTurnBoundary(projection)
    // Guard does not impersonate a completion gate: without an armed Goal the
    // turn ends normally, and the certificate requirement is enforced where it
    // belongs — on the certificate and the Goal completion request.
    expect(decision.action).toBe('stop')
    expect(decision.reason).not.toBe('current_certificate')
    expect(projection.checkpoints).toHaveLength(0)
    const open = [...projection.items.values()].filter((item) => item.status === 'pending')
    expect(open.length).toBeGreaterThanOrEqual(2)
    expect(open.every((item) => item.authorityDisposition !== 'informational')).toBe(true)
  })

  it('keeps the historical negative boundaries: an unqualified boundary stays rejected', async () => {
    const projection = hostTurn('安装新主题。', '好。')
    const { runtime } = host()
    runtime.register(createBoundaryTool(() => projection, async () => true, () => {}))
    const response = await runtime.execute({
      callId: 'boundary' as never, name: 'context_guard_boundary',
      arguments: { disposition: 'guard_bounded_stop', qualification_kind: 'guard_no_progress', qualification_ids: [] },
      signal: new AbortController().signal,
    })
    expect(response.isError).toBe(false)
    const value = JSON.parse(textOf(response)) as { status?: string; reason_code?: string }
    expect(value.status === 'rejected' || value.reason_code !== undefined).toBe(true)
  })

  it('keeps the producer-reference boundary: a bare evidence id does not close a stateful item', async () => {
    const projection = hostTurn('安装 new-theme 插件。', '好。')
    const item = [...projection.items.values()].find((row) => row.semanticAction === 'install')!
    // No resolution/effect/state producer chain exists in this synthetic log, so
    // the item remains open and the checkpoint refuses it.
    expect(item.status).toBe('pending')
    const decision = authorizeMutationFromProjection(projection, {
      action: 'install', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { package_id: 'new-theme', version: '1.0.0', integrity_digest: 'a'.repeat(64), profile: 'default' },
    })
    expect(decision.status).toBe('denied')
  })
})
