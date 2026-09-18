import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { applyUpgradeEligibility, deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { certifyCheckpoint } from '../../src/domain/checkpoint.js'
import { hasCurrentCertificate } from '../../src/domain/goal-gate.js'
import { decideTurnBoundary } from '../../src/domain/stop-policy.js'
import { renderRecoveryPacket, recoveryDigest } from '../../src/domain/recovery.js'
import { certificateClosure, needsReviewObligations } from '../../src/domain/closure.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { createBoundaryTool } from '../../src/tools/boundary.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import type { DerivedEnvelope, GuardProjection } from '../../src/domain/types.js'

/**
 * 0.6.3 T07: the whole local lifecycle over ONE durable log.
 *
 * The reviewer's objection was that the earlier evidence derived a projection
 * first and then registered tools against it, so nothing proved the obligation
 * survives persistence, a restart-style replay, or compaction. This file runs
 * the full path:
 *
 * 1. a synthetic host turn opens the session and captures the root request;
 * 2. the REGISTERED Guard tools are materialized through the real ToolRuntime,
 *    and the calls/results they answer are APPENDED to the durable log (the
 *    same wire shape the plugin persists);
 * 3. the projection is RE-DERIVED from that log — a restart-style replay —
 *    and the obligations, the boundary rejection and the review set are
 *    compared with the live projection;
 * 4. a compaction summary enters the log and the contract is re-derived again,
 *    so the recovery packet and the closure are checked on the post-compaction
 *    projection;
 * 5. the final closure is read from the production closure implementation.
 *
 * It is still a local isolated test: no real user host, no model call, no
 * business side effect, no installed plugin.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/workspace/repo-a', sessionHeader: { version: 3, id: 'v063-host-lifecycle', createdAt: 1 } }

/** One durable log, in the native event vocabulary. */
class DurableLog {
  readonly events: DerivedEnvelope[] = []
  private next = 0

  append(type: string, data?: unknown): DerivedEnvelope {
    const event: DerivedEnvelope = { seq: this.next++, type, ...(data === undefined ? {} : { data }) }
    this.events.push(event)
    return event
  }

  notice(): void {
    this.append('user/message', {
      source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' },
      content: [{ type: 'text', text: PROTOCOL_V5_NOTICE }],
    })
  }

  turn(turn: number, text: string, answer: string): void {
    this.append('turn/start', { turn })
    this.append('user/message', { turn, source: { kind: 'user' }, content: [{ type: 'text', text }] })
    this.append('assistant/message', { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: answer }] } })
    this.append('turn/end', { turn, reason: { kind: 'completed' } })
  }

  /** The persisted wire shape of one registered tool round-trip. */
  toolRoundTrip(name: string, callId: string, args: unknown, result: unknown): void {
    this.append('tool/call', { turn: 1, callId, name, arguments: JSON.stringify(args) })
    this.append('tool/result', {
      turn: 1,
      message: { source: { callId }, content: [{ type: 'text', text: JSON.stringify(result) }] },
    })
  }

  compact(summary: string): void {
    this.append('compaction/summary', { summary })
  }

  derive(isDurable = true): GuardProjection {
    return deriveProjection(this.events, config, scope, isDurable).projection
  }
}

function host() {
  const ctx = new Context()
  new SystemPrompt(ctx, {})
  return new ToolRuntime(ctx)
}

const textOf = (response: { content: Array<{ type: string; text?: string }> }): string =>
  response.content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('')

const call = (runtime: ToolRuntime, name: string, argumentsValue: unknown, callId: string) =>
  runtime.execute({ callId: callId as never, name, arguments: argumentsValue, signal: new AbortController().signal })

const snapshot = (projection: GuardProjection) => [...projection.items.values()]
  .map((item) => `${item.id}:${item.status}:${item.authorityDisposition ?? '-'}:${item.semanticAction ?? '-'}:${item.needsReview?.reason ?? '-'}`)
  .sort()

describe('0.6.3 T07: the corrections survive materialization, replay and compaction', () => {
  it('a mixed request keeps its obligations across the whole local lifecycle', async () => {
    const log = new DurableLog()
    log.notice()
    log.turn(1, '更新插件，检查是否存在更新，安装新主题，记录变更。', '已收到。')
    const live = log.derive()

    // (2) Materialize the registered tools through the real output contract.
    const runtime = host()
    runtime.register(createPrepareTool({ getProjection: () => live }))
    runtime.register(createBoundaryTool(() => live, async () => true, () => {}))

    const discovery = await call(runtime, 'context_guard_prepare', {}, 'discovery')
    expect(discovery.isError).toBe(false)
    const list = JSON.parse(textOf(discovery)) as { status: string; items: Array<{ id: string; text: string }> }
    expect(list.status).toBe('prepared')
    expect(list.items.map((item) => item.text)).toEqual(['更新插件', '安装新主题，记录变更。'])
    log.toolRoundTrip('context_guard_prepare', 'discovery', {}, JSON.parse(textOf(discovery)))

    // The boundary tool refuses an unqualified stop in the same lifecycle.
    const boundary = await call(runtime, 'context_guard_boundary', {
      disposition: 'guard_bounded_stop', qualification_kind: 'guard_no_progress', qualification_ids: [],
    }, 'boundary')
    expect(boundary.isError).toBe(false)
    const boundaryValue = JSON.parse(textOf(boundary)) as { status?: string; reason_code?: string }
    expect(boundaryValue.status === 'rejected' || boundaryValue.reason_code !== undefined).toBe(true)
    log.toolRoundTrip('context_guard_boundary', 'boundary', {
      disposition: 'guard_bounded_stop', qualification_kind: 'guard_no_progress', qualification_ids: [],
    }, boundaryValue)

    // (3) Restart-style replay over the durable log.
    const replayed = log.derive()
    expect(snapshot(replayed)).toEqual(snapshot(live))
    expect(certificateClosure(replayed).itemIds.sort()).toEqual(certificateClosure(live).itemIds.sort())
    // The persisted transport call changed no obligation, and the boundary was
    // not accepted, so the closure is identical.
    expect(replayed.boundaries.filter((entry) => entry.persistedResult === 'accepted')).toHaveLength(0)

    // The execution obligations are the ones the zero-tool answer could not close.
    for (const item of [...replayed.items.values()].filter((row) => row.authorityDisposition === 'executable_now')) {
      expect(item.status, item.normalizedText).toBe('pending')
    }
    expect([...replayed.items.values()].some((item) => item.status === 'answered')).toBe(true)

    // The authorizer still refuses the environment-default git obligation.
    for (const item of replayed.items.values()) {
      if (item.semanticAction !== 'commit' && item.semanticAction !== 'push') continue
      expect(authorizeMutationFromProjection(replayed, {
        action: item.semanticAction, contractItemId: item.id, contractItemRevision: item.revision,
        resolvedTarget: { repository: '/workspace/repo-a', branch: 'main', remote: 'origin', refspec: 'main' },
      }).status).toBe('denied')
    }

    // (4) Compaction enters the durable log and the contract is re-derived.
    log.compact('bounded local lifecycle summary')
    const compacted = log.derive()
    expect(snapshot(compacted)).toEqual(snapshot(live))
    expect(certificateClosure(compacted).itemIds.sort()).toEqual(certificateClosure(live).itemIds.sort())
    // The recovery packet is rendered from the post-compaction projection and
    // still names the open work, not a completion.
    const packet = renderRecoveryPacket(compacted)
    expect(packet).toMatch(/\d+ pending/)
    expect(recoveryDigest(packet, compacted)).toMatch(/^[0-9a-f]{64}$/)
    expect(compacted.checkpoints).toHaveLength(0)

    // (5) The production Stop decision: an ordinary turn yields with the work
    // preserved rather than claiming a certificate.
    const decision = decideTurnBoundary(compacted)
    expect(decision.action).toBe('stop')
    expect(decision.reason).not.toBe('current_certificate')
    expect([...compacted.items.values()].filter((item) => item.status === 'pending').length).toBeGreaterThanOrEqual(2)
  })

  it('a mixed prepare assumption is refused after replay and compaction too', async () => {
    const log = new DurableLog()
    log.notice()
    log.turn(1, '提交仓库 /work/repo-a 的变更。', '好。')
    const live = log.derive()
    const commit = [...live.items.values()].find((item) => item.semanticAction === 'commit')!

    const runtime = host()
    runtime.register(createPrepareTool({ getProjection: () => live }))
    const response = await call(runtime, 'context_guard_prepare', {
      item_id: commit.id, item_revision: commit.revision, semantic_action: 'push',
    }, 'prepare-push')
    log.toolRoundTrip('context_guard_prepare', 'prepare-push', {
      item_id: commit.id, item_revision: commit.revision, semantic_action: 'push',
    }, JSON.parse(textOf(response)))
    expect(response.isError).toBe(false)
    const value = JSON.parse(textOf(response)) as { status: string; reason_code: string; evidence_input_contract?: unknown }
    expect(value.status).toBe('incompatible')
    expect(value.reason_code).toBe('action_not_compatible_with_item')
    expect(value.evidence_input_contract).toBeUndefined()

    log.compact('bounded local lifecycle summary')
    const replayed = log.derive()
    // The durable log recorded the tool round-trip as a plain (non-Guard)
    // evidence-bearing call, so the commit obligation is unchanged and the same
    // refusal is reachable after the replay.
    const replayedCommit = [...replayed.items.values()].find((item) => item.semanticAction === 'commit')!
    expect(replayedCommit.id).toBe(commit.id)
    expect(replayedCommit.status).toBe('pending')
    const replayRuntime = host()
    replayRuntime.register(createPrepareTool({ getProjection: () => replayed }))
    const replayedPrepare = await call(
      replayRuntime, 'context_guard_prepare',
      { item_id: replayedCommit.id, semantic_action: 'push' }, 'replay-prepare',
    )
    const replayedValue = JSON.parse(textOf(replayedPrepare)) as { status: string; reason_code: string }
    expect(replayedValue.status).toBe('incompatible')
    expect(replayedValue.reason_code).toBe('action_not_compatible_with_item')
  })

  it('a needs-review record still blocks after the log is replayed and compacted', () => {
    const log = new DurableLog()
    log.notice()
    log.turn(1, '安装主题 A，检查是否有更新。', '收到。')
    // The corrected reading captures the order and the question separately.
    const upgradeProjection = log.derive()
    expect(upgradeProjection.items.size).toBe(2)
    const mixed = [...upgradeProjection.items.values()][0]!
    // The upgrade reading of what an earlier release stored: ONE answered
    // information obligation covering the whole clause, not the partition.
    Object.assign(mixed, {
      normalizedText: '安装主题 A，检查是否有更新。',
      directive: 'informational', authorityDisposition: 'informational', taskKind: 'inquiry',
      status: 'answered',
    })
    for (const id of Array.from(upgradeProjection.items.keys())) if (id !== mixed.id) upgradeProjection.items.delete(id)
    // Applying the upgrade entry is the operator's replay step: it re-checks
    // the records the session holds and marks the ones that cannot be inherited.
    applyUpgradeEligibility(upgradeProjection)
    expect(mixed.needsReview?.reason).toBe('legacy_mixed_information_scope')
    expect(needsReviewObligations(upgradeProjection)).toHaveLength(1)

    // The OLD projection's obstruction is the review fact itself.
    const upgraded = certifyCheckpoint(upgradeProjection, [], 'C-upgrade')
    expect(upgraded.status).toBe('incomplete')
    expect(upgraded.rejectedBindings[0]).toMatchObject({ reasonCode: 'legacy_record_needs_review' })
    expect(hasCurrentCertificate(upgradeProjection)).toBe(false)

    // The same log compacts and re-derives into the CORRECTED contract. Running
    // the same upgrade entry is idempotent there: the partition already keeps
    // the execution work pending, so the record needs no review fact and the
    // obstruction is the open work itself — a different, equally hard block.
    log.compact('bounded local lifecycle summary')
    const replayed = log.derive()
    expect(replayed.items.size).toBeGreaterThan(1)
    applyUpgradeEligibility(replayed)
    expect(needsReviewObligations(replayed)).toHaveLength(0)
    const pending = [...replayed.items.values()].filter((item) => item.status === 'pending')
    expect(pending.length).toBeGreaterThanOrEqual(1)
    const result = certifyCheckpoint(replayed, [], 'C-replay')
    expect(result.status).toBe('incomplete')
    expect(result.openItems.length).toBeGreaterThanOrEqual(1)
    expect(hasCurrentCertificate(replayed)).toBe(false)
    expect(replayed.checkpoints).toHaveLength(0)
  })
})
