import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V6_NOTICE } from '../src/domain/derive.js'
import { certifyCheckpoint } from '../src/domain/checkpoint.js'
import { deriveItemDiagnosis } from '../src/domain/diagnostics.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'
import { projectSessionCoreV2 } from '../src/core-v2/session.js'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'

const HOST = { ...evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' }),
  auditedForegroundRenderers: ['bash' as const] }

function sessionWithCommit(label: string) {
  const id = SessionId(label)
  const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, isSeeded: false, id, createdAt: 1, cwd: '/work' })
  session.append('command/run', { commandId: 'on' as never, name: 'context-guard', args: 'on', source: { kind: 'user' } })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }],
    source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice', summary: 'v6' } }), { surfaceOp: 'append' })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '提交仓库 /work/repo 的变更。' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId: 'commit-1' as never, name: 'bash', arguments: JSON.stringify({ command: 'git commit -m work', workdir: '/work/repo' }) })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'commit-1' as never,
    content: [{ type: 'text', text: '[main 1234567] work' }], isError: false }) } as never, { surfaceOp: 'append' })
  return session
}

describe('UX11 regression: the evidence remediation chain always reaches a decidable state', () => {
  // Original incident shape: mixed evidence E1+E2 was refused with advice to
  // remove E1; after following it, E2-only was STILL refused with
  // semantic_action_mismatch — the chain could not reach an acceptable state.
  // The current contract instead names ONE exact missing fact per step, and
  // following the advice in ANY order reaches certification deterministically.
  it('effect-only names exactly the state fact; adding it certifies', () => {
    const session = sessionWithCommit('ux11-effect-only')
    const events = session.snapshotEvents() as never
    const projection = deriveProjection(events, { activation: 'opt-in' }, { cwd: '/work' }, true, HOST).projection
    projection.durabilityWatermark = 'confirmed'
    projection.coreV2 = projectSessionCoreV2(events, projection)
    const commit = [...projection.items.values()].find((row) => row.semanticAction === 'commit')!
    const effect = [...projection.evidence.values()].find((row) => row.callId === 'commit-1')!
    // Step 1: the effect alone keeps the commit predicate insufficient — the
    // core view names the state readback as the missing half, never a
    // mismatched action or an unreachable advice loop.
    const predicates = (projection.coreV2?.predicates ?? {}) as Record<string, string>
    expect(predicates[commit.id]).toBe('insufficient')
    expect((projection.coreV2?.unmet_requirements ?? []) as string[]).toContain(commit.id)
    const alone = certifyCheckpoint(projection, [{ itemId: commit.id, evidenceIds: [effect.id], semanticAction: 'commit' as const,
      requestedTarget: commit.requestedTarget, resolvedTarget: { repository: '/work/repo', branch: 'main' },
      observedState: { post_head_oid: '1'.repeat(40) }, effectEvidenceId: effect.id }], 'C-ux11-step1', false)
    expect(alone.status).toBe('incomplete')
    // Step 2: follow the advice — supply the state readback. The chain
    // REACHES certification; no second refusal appears.
    session.append('tool/call', { turn: 1, step: 1, callId: 'commit-readback' as never, name: 'context_guard_observe_git', arguments: JSON.stringify({ effect_call_id: 'commit-1' }) })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'commit-readback' as never,
      content: [{ type: 'text', text: JSON.stringify({ status: 'observed', effect_call_id: 'commit-1', action: 'commit', repository: '/work/repo', branch: 'main', remote: '', refspec: '', post_oid: '1'.repeat(40), parent_oid: '2'.repeat(40), tree_oid: '3'.repeat(40) }) }], isError: false }),
      meta: { contextGuardNativeGit: { effectCallId: 'commit-1', action: 'commit', repository: '/work/repo', branch: 'main', remote: '', refspec: '', postOid: '1'.repeat(40), parentOid: '2'.repeat(40), treeOid: '3'.repeat(40) } } } as never, { surfaceOp: 'append' })
    const afterEvents = session.snapshotEvents() as never
    const after = deriveProjection(afterEvents, { activation: 'opt-in' }, { cwd: '/work' }, true, HOST).projection
    after.durabilityWatermark = 'confirmed'
    after.coreV2 = projectSessionCoreV2(afterEvents, after)
    const afterPredicates = (after.coreV2?.predicates ?? {}) as Record<string, string>
    expect(afterPredicates[commit.id]).toBe('satisfied')
    const state = [...after.evidence.values()].find((row) => row.callId === 'commit-readback')!
    const certified = certifyCheckpoint(after, [{ itemId: commit.id, evidenceIds: [effect.id, state.id], semanticAction: 'commit' as const,
      requestedTarget: commit.requestedTarget, resolvedTarget: { repository: '/work/repo', branch: 'main' },
      observedState: { post_head_oid: '1'.repeat(40) }, effectEvidenceId: effect.id, stateEvidenceIds: [state.id] }], 'C-ux11-step2', false)
    expect(certified.status, JSON.stringify(certified.rejectedBindings)).toBe('certified')
  })
  it('the same canonical input yields the identical diagnosis on repeat evaluation', () => {
    // The original report mistook changed bindings for a contradiction; the
    // contract requires identical canonical inputs to diagnose identically.
    const session = sessionWithCommit('ux11-deterministic')
    for (let round = 0; round < 3; round++) {
      const projection = deriveProjection(session.snapshotEvents() as never, { activation: 'opt-in' }, { cwd: '/work' }, true, HOST).projection
      const commit = [...projection.items.values()].find((row) => row.semanticAction === 'commit')!
      const diagnosis = deriveItemDiagnosis(projection, commit)
      expect(JSON.stringify(diagnosis)).toBe(JSON.stringify(deriveItemDiagnosis(projection, commit)))
    }
  })
})
