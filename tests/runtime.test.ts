import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply as applyPinnedGoalTool } from '@deepseek-ai/dsh-tool-goal'
import {
  apply,
  authorizeMutationFromProjection,
  createRuntime,
  handleGuardTurnStopping,
  hasPinnedUpdateGoalTool,
  PROTOCOL_CORRECTION_NOTICE,
  type GuardRuntime,
} from '../src/runtime.js'
import { deriveProjection, PROTOCOL_V3_NOTICE } from '../src/domain/derive.js'
import { certifyCheckpoint } from '../src/domain/checkpoint.js'
import { goalCompletionDenial, hasCurrentCertificate } from '../src/domain/goal-gate.js'
import { recoveryDigest } from '../src/domain/recovery.js'
import { captureClause } from '../src/domain/capture.js'
import { createProjection } from '../src/domain/types.js'
import { createContextGuardCommand } from '../src/commands/context-guard.js'
import { qualifyBoundary } from '../src/domain/boundary.js'
import { createBoundaryTool } from '../src/tools/boundary.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES, type HostLockEvaluation } from '../src/domain/host-lock.js'

function fakeAgent(session: Session): Agent {
  return { session } as unknown as Agent
}

function rawAppend(session: Session): (type: string, data: unknown, opts?: unknown) => unknown {
  return (session as unknown as { append: (type: string, data: unknown, opts?: unknown) => unknown }).append.bind(session)
}

const OPT_IN = { activation: 'opt-in' as const }
const ALWAYS = { activation: 'always' as const }
// CG-DSH-001: the audited cohort is one indivisible whole-graph contract;
// test locks carry the complete audited rc.2 graph.
const TEST_HOST_ROWS = EXPECTED_HOST_PACKAGES
const TEST_HOST_LOCK = evaluateHostLock(TEST_HOST_ROWS, { platform: 'posix', profileKind: 'web' })

function enableCommand(session: Session, subcommand = 'on') {
  rawAppend(session)('command/run', { commandId: `cmd-${session.seq}`, name: 'context-guard', args: subcommand, source: { kind: 'user' } })
}

function userText(session: Session, text: string) {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

function toolCall(session: Session, callId: string, name: string, argumentsJson: string) {
  rawAppend(session)('tool/call', { turn: 1, step: 1, callId, name, arguments: argumentsJson })
}

function toolResult(session: Session, callId: string, text: string, meta?: unknown, error?: unknown) {
  rawAppend(session)('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId: callId as never, content: [{ type: 'text', text }], isError: error !== undefined }),
    ...(meta !== undefined ? { meta } : {}),
    ...(error !== undefined ? { error } : {}),
  }, { surfaceOp: 'append' })
}

describe('runtime derivation', () => {
  it('authorizes a mutation only for the exact pending root-owned action and target', () => {
    const session = Session.create(SessionId('mutation-root-authority'), undefined, {
      version: 0, id: SessionId('mutation-root-authority'), createdAt: 1, cwd: '/work',
    })
    enableCommand(session, 'on')
    userText(session, 'Install package fixture@2.0.0 in profile web.')
    const projection = deriveProjection(session.events as never, OPT_IN, { cwd: '/work' }, true).projection
    const item = [...projection.items.values()].find((entry) => entry.semanticAction === 'install')!
    const target = { package_id: 'fixture', version: '2.0.0', integrity_digest: 'sha512-fixture', profile: 'web' }
    const request = { action: 'install' as const, contractItemId: item.id, contractItemRevision: item.revision, resolvedTarget: target }
    expect(authorizeMutationFromProjection(projection, request)).toEqual({
      status: 'authorized', reasonCode: 'mutation_root_contract_authorized',
    })
    item.authority = 'root_adoption'
    expect(authorizeMutationFromProjection(projection, request).status).toBe('authorized')

    const denied = (mutate: () => void, reasonCode: string) => {
      const enabled = projection.enabled
      const integrity = projection.integrity
      const hostStatus = projection.hostStatus
      mutate()
      expect(authorizeMutationFromProjection(projection, request)).toMatchObject({ status: 'denied', reasonCode })
      item.status = 'pending'
      item.kind = 'requirement'
      item.verification.enforced = true
      item.authority = 'root_adoption'
      item.legacyFlags = undefined
      item.semanticAction = 'install'
      item.targetCaptureStatus = 'resolved'
      projection.enabled = enabled
      projection.integrity = integrity
      projection.hostStatus = hostStatus
    }
    denied(() => { projection.enabled = false }, 'mutation_guard_disabled')
    denied(() => { projection.integrity = 'unknown' }, 'mutation_integrity_unavailable')
    denied(() => { projection.hostStatus = 'unavailable' }, 'mutation_host_lock_unavailable')
    expect(authorizeMutationFromProjection(projection, { ...request, contractItemId: 'R999' })).toMatchObject({ reasonCode: 'mutation_contract_item_missing' })
    expect(authorizeMutationFromProjection(projection, { ...request, contractItemRevision: item.revision + 1 })).toMatchObject({ reasonCode: 'mutation_contract_item_revision_mismatch' })
    denied(() => { item.status = 'passed' }, 'mutation_contract_item_not_pending')
    denied(() => { item.status = 'superseded' }, 'mutation_contract_item_not_pending')
    denied(() => { item.kind = 'prohibition'; item.verification.enforced = false }, 'mutation_contract_item_not_authorizing')
    denied(() => { item.authority = 'legacy_authority_unclassified' }, 'mutation_root_authority_unavailable')
    denied(() => { item.authority = 'root_instruction'; item.legacyFlags = ['legacy_generic_run'] }, 'mutation_legacy_rebind_required')
    denied(() => { item.semanticAction = 'apply' }, 'mutation_semantic_action_mismatch')
    denied(() => { item.targetCaptureStatus = 'clarification_required' }, 'mutation_target_clarification_required')
    expect(authorizeMutationFromProjection(projection, {
      ...request, resolvedTarget: { ...target, package_id: 'attacker' },
    })).toMatchObject({ status: 'denied', reasonCode: 'mutation_requested_target_mismatch' })
    for (const missing of ['version', 'profile'] as const) {
      const complete: Record<string, string> = { package_id: 'fixture', version: '2.0.0', profile: 'web' }
      delete complete[missing]
      item.requestedTarget = complete
      expect(authorizeMutationFromProjection(projection, request)).toMatchObject({
        status: 'denied', reasonCode: 'mutation_requested_target_mismatch',
      })
    }
  })

  it.each([
    ['install', 'Install package fixture@2.0.0 in profile web.', { package_id: 'fixture', version: '2.0.0', integrity_digest: 'sha512-x', profile: 'web' }, 'version'],
    ['apply', 'Apply package fixture@2.0.0 in profile web.', { package_id: 'fixture', version: '2.0.0', integrity_digest: 'sha512-x', profile: 'web' }, 'profile'],
    ['publish', 'Publish package fixture@2.0.0 registry https://registry.example.invalid/.', { artifact_id: 'fixture', version: '2.0.0', registry: 'https://registry.example.invalid/', integrity_digest: 'sha512-x' }, 'registry'],
    ['push', 'Push repository /work remote origin refspec refs/heads/main:refs/heads/main.', { repository: '/work', remote: 'origin', refspec: 'refs/heads/main:refs/heads/main', local_oid: 'a'.repeat(40) }, 'refspec'],
    ['fetch', 'Fetch repository /work remote origin refspec refs/heads/main:refs/remotes/origin/main.', { repository: '/work', remote: 'origin', refspec: 'refs/heads/main:refs/remotes/origin/main', upstream_oid: 'b'.repeat(40), pre_head_oid: 'a'.repeat(40) }, 'remote'],
    ['pull', 'Pull repository /work remote origin refspec refs/heads/main.', { repository: '/work', remote: 'origin', refspec: 'refs/heads/main', upstream_oid: 'b'.repeat(40), pre_head_oid: 'a'.repeat(40), pull_mode: 'ff-only' }, 'repository'],
    ['restart', 'Restart service dsh-web.', { service_id: 'dsh-web', pre_generation: 'boot-1' }, 'service_id'],
  ] as const)('rejects incomplete %s root authority before mutation', (action, instruction, resolvedTarget, missingKey) => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause(instruction, 'm1', 'R001', 1, { cwd: '/work' })
    const incomplete = { ...item.requestedTarget }
    delete incomplete[missingKey]
    item.requestedTarget = incomplete
    projection.items.set(item.id, item)
    expect(authorizeMutationFromProjection(projection, {
      action, contractItemId: item.id, contractItemRevision: item.revision, resolvedTarget,
    })).toMatchObject({ status: 'denied', reasonCode: 'mutation_requested_target_mismatch' })
  })

  it('does not treat an exact prohibition as mutation authority', () => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause(
      'Do not push repository /work remote origin refspec refs/heads/main:refs/heads/main.',
      'm1', 'P001', 1, { cwd: '/work' },
    )
    projection.items.set(item.id, item)
    expect(authorizeMutationFromProjection(projection, {
      action: 'push', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { repository: '/work', remote: 'origin', refspec: 'refs/heads/main:refs/heads/main', local_oid: 'a'.repeat(40) },
    })).toMatchObject({ status: 'denied', reasonCode: 'mutation_contract_item_not_authorizing' })
  })

  it('accepts Goal capability only when the pinned update_goal name and argument contract are live', () => {
    const properties = {
      goal_id: { type: 'string' }, revision: { type: 'number' },
      action: { type: 'string', enum: ['edit', 'pause', 'resume', 'complete', 'blocked'] },
      objective: { type: 'string' }, max_goal_rounds: { type: 'number' }, blocked_reason: { type: 'string' },
    }
    const schema = {
      name: 'update_goal', execute: async () => ({}),
      parameters: { type: 'object', properties, required: ['goal_id', 'revision', 'action'] },
    }
    const agent = { ctx: { tools: { get: () => schema } } } as unknown as Agent
    expect(hasPinnedUpdateGoalTool(agent)).toBe(true)
    expect(hasPinnedUpdateGoalTool({ ctx: { tools: { get: () => ({ ...schema, name: 'other' }) } } } as unknown as Agent)).toBe(false)
    expect(hasPinnedUpdateGoalTool({ ctx: { tools: { get: () => ({ ...schema, parameters: { ...schema.parameters, properties: { ...properties, revision: { type: 'string' } } } }) } } } as unknown as Agent)).toBe(false)
    expect(hasPinnedUpdateGoalTool({ ctx: { tools: { get: () => undefined } } } as unknown as Agent)).toBe(false)
  })

  it('guards the real pinned update_goal tool before Goal mutation and permits the exact certified ref', async () => {
    const registered: Array<{ name: string; parameters: Record<string, unknown>; execute: (args: unknown, exec: unknown) => Promise<unknown> }> = []
    let mutations = 0
    let goal = {
      id: 'goal-pinned', revision: 3, objective: 'finish the guarded task', phase: 'active',
      roundsStarted: 1, maxGoalRounds: 8, activation: 'armed',
    }
    const agent = {
      id: 'agent-pinned', status: 'running',
      session: { events: [
        { seq: 1, type: 'turn/start', data: { turn: 1 } },
        { seq: 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'finish it' }] } },
      ] },
    }
    const ctx = {
      systemPrompt: { section: () => undefined },
      tools: { register: (tool: typeof registered[number]) => { registered.push(tool) } },
      agents: { get: (id: string) => id === agent.id ? agent : undefined, currentInitiator: () => agent, roots: () => [agent] },
      goals: {
        get: () => goal,
        complete: (_agent: unknown, ref: { id: string; revision: number }) => {
          expect(ref).toEqual({ id: 'goal-pinned', revision: 3 })
          mutations += 1
          goal = { ...goal, revision: 4, phase: 'complete', activation: 'disarmed' }
          return goal
        },
      },
    }
    applyPinnedGoalTool(ctx as never, {})
    const updateGoal = registered.find((tool) => tool.name === 'update_goal')!
    expect(updateGoal).toBeDefined()
    expect(hasPinnedUpdateGoalTool({ ctx: { tools: { get: () => updateGoal } } } as unknown as Agent)).toBe(true)

    const projection = createProjection()
    projection.enabled = true
    projection.epoch = 1
    projection.contractRevision = 1
    projection.currentGoalRef = { id: 'goal-pinned', revision: 3 }
    const args = { goal_id: 'goal-pinned', revision: 3, action: 'complete' }
    expect(goalCompletionDenial(projection, updateGoal.name, args)).toContain('[certificate_missing]')
    expect(mutations).toBe(0)

    projection.checkpoints.push({
      id: 'C-pinned', stopProtocolVersion: '2.0.0', certificateVersion: '1', epoch: 1,
      sessionRefDigest: projection.sessionRefDigest, hostLockDigest: projection.hostLockDigest,
      contractRevision: 1, contractSha256: '1'.repeat(64), openDigest: '2'.repeat(64),
      evidenceSha256: '3'.repeat(64), bindingDigest: '4'.repeat(64), bindings: [],
      goalRef: { id: 'goal-pinned', revision: 3 }, certificationDigest: '5'.repeat(64), result: 'certified',
    })
    expect(goalCompletionDenial(projection, updateGoal.name, args)).toBeUndefined()
    await updateGoal.execute(args, {
      agent, signal: new AbortController().signal, deferContext: () => undefined,
      concludeTurn: () => undefined, token: Symbol('pinned-goal'), callId: 'goal-call', rootCallId: 'goal-call', name: 'update_goal', arguments: args,
    })
    expect(mutations).toBe(1)
  })

  it('records direct Goal completion bypass only inside an enabled protected epoch', () => {
    const directComplete = (id: string, enabledEvents: Array<{ seq: number; type: string; data: unknown }>) => {
      const events = [...enabledEvents, {
        seq: enabledEvents.length + 1, type: 'goal/change',
        data: { operation: 'complete', goal: { id, revision: 1, phase: 'complete' } },
      }]
      return deriveProjection(events as never, OPT_IN, {}, true).projection
    }
    expect(directComplete('before-on', []).integrityViolations).not.toContain('goal_completion_without_certificate')
    expect(directComplete('while-off', [
      { seq: 1, type: 'command/run', data: { name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 2, type: 'command/run', data: { name: 'context-guard', args: 'off', source: { kind: 'user' } } },
    ]).integrityViolations).not.toContain('goal_completion_without_certificate')
    expect(directComplete('enabled-bypass', [
      { seq: 1, type: 'command/run', data: { name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 2, type: 'goal/change', data: { operation: 'resume', goal: { id: 'enabled-bypass', revision: 1, phase: 'active' } } },
    ]).integrityViolations).toContain('goal_completion_without_certificate')

    const events: Array<{ seq: number; type: string; data: unknown }> = [
      { seq: 1, type: 'command/run', data: { name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 2, type: 'goal/change', data: { operation: 'resume', goal: { id: 'certified-goal', revision: 1, phase: 'active' } } },
    ]
    const before = deriveProjection(events as never, OPT_IN, {}, true).projection
    const certified = certifyCheckpoint(before, [], 'C-goal-direct', false).checkpoint!
    const certificate = {
      stop_protocol_version: certified.stopProtocolVersion, certificate_version: certified.certificateVersion,
      epoch: certified.epoch, session_ref_digest: certified.sessionRefDigest, host_lock_digest: certified.hostLockDigest,
      contract_revision: certified.contractRevision, contract_sha256: certified.contractSha256,
      open_digest: certified.openDigest, evidence_sha256: certified.evidenceSha256, binding_digest: certified.bindingDigest,
      certification_digest: certified.certificationDigest, goal_ref: certified.goalRef,
    }
    events.push(
      { seq: 3, type: 'tool/call', data: { callId: 'checkpoint-goal', name: 'context_guard_checkpoint', arguments: JSON.stringify({ bindings: [] }) } },
      { seq: 4, type: 'tool/result', data: { message: { source: { callId: 'checkpoint-goal' }, content: [{ type: 'text', text: JSON.stringify({ status: 'certified', certificate }) }] } } },
      { seq: 5, type: 'goal/change', data: { operation: 'complete', goal: { id: 'certified-goal', revision: 1, phase: 'complete' } } },
    )
    const replayed = deriveProjection(events as never, OPT_IN, {}, true).projection
    expect(replayed.integrityViolations).not.toContain('goal_completion_without_certificate')
  })

  it('strictly restores a v0.2 pre-marker checkpoint as legacy while a post-marker recapture remains certifiable', () => {
    const session = Session.create(SessionId('legacy-upgrade-restore'), undefined, {
      version: 0, id: SessionId('legacy-upgrade-restore'), createdAt: 1, cwd: '/work',
    })
    enableCommand(session, 'on')
    userText(session, 'Background material about old.txt')
    toolCall(session, 'old-checkpoint', 'context_guard_checkpoint', JSON.stringify({ bindings: [{ item_id: 'R001', evidence_ids: ['E9999'] }] }))
    toolResult(session, 'old-checkpoint', JSON.stringify({ status: 'certified' }))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: PROTOCOL_V3_NOTICE }],
      source: { kind: 'plugin', plugin: 'context-guard', form: 'notice', summary: 'Context Guard v3 boundary' },
    }), { surfaceOp: 'append' })
    rawAppend(session)('command/run', { commandId: 'clear-old', name: 'context-guard', args: 'clear', source: { kind: 'user' } })
    userText(session, 'Run pnpm test in the workspace')
    toolCall(session, 'new-read', 'bash', JSON.stringify({ command: 'pnpm test', workdir: '/work' }))
    toolResult(session, 'new-read', '[exit code: 0]')

    const restored = Session.fromRestore(
      SessionId('legacy-upgrade-restore'), structuredClone(session.events) as never, structuredClone(session.header) as never,
    )
    const projection = deriveProjection(restored.events as never, OPT_IN, { cwd: '/work' }, true, TEST_HOST_LOCK).projection
    const oldItem = [...projection.items.values()].find((item) => item.normalizedText.includes('old.txt'))!
    const newItem = [...projection.items.values()].find((item) => item.normalizedText.includes('workspace'))!
    expect(oldItem).toMatchObject({ status: 'passed', authority: 'legacy_authority_unclassified' })
    expect(oldItem.legacyFlags).toEqual(expect.arrayContaining(['legacy_generic_run', 'legacy_authority_unclassified']))
    expect(newItem).toMatchObject({ status: 'pending', semanticAction: 'test', authority: 'root_instruction' })
    expect(newItem.legacyFlags).toBeUndefined()
    expect(projection.integrityViolations).toContain('legacy_certificate_non_authoritative')

    const read = [...projection.evidence.values()].find((entry) => entry.callId === 'new-read')!
    const certified = certifyCheckpoint(projection, [{
      itemId: newItem.id, evidenceIds: [read.id], semanticAction: 'test', requestedTarget: newItem.requestedTarget,
      resolvedTarget: read.resolvedTarget, observedState: read.observedState ?? {}, effectEvidenceId: read.id,
      expectedTransition: { predicateId: 'pred.test.outcome', version: 1, predParamsKind: 'inline', parameters: { expected_outcome: { k: 'e', v: 'success' }, min_matches: 1 } },
    }], 'C-new')
    expect(certified.status, JSON.stringify(certified)).toBe('certified')
  })

  it('certifies a deterministic legacy_rebind only after direct-root provenance and fresh v3 evidence', () => {
    const session = Session.create(SessionId('legacy-deterministic-rebind'), undefined, {
      version: 0, id: SessionId('legacy-deterministic-rebind'), createdAt: 1, cwd: '/work',
    })
    enableCommand(session, 'on')
    userText(session, 'Run pnpm test in the workspace')
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: PROTOCOL_V3_NOTICE }],
      source: { kind: 'plugin', plugin: 'context-guard', form: 'notice', summary: 'Context Guard v3 boundary' },
    }), { surfaceOp: 'append' })
    toolCall(session, 'rebind-test', 'bash', JSON.stringify({ command: 'pnpm test', workdir: '/work' }))
    toolResult(session, 'rebind-test', '[exit code: 0]')
    const projection = deriveProjection(session.events as never, OPT_IN, { cwd: '/work' }, true, TEST_HOST_LOCK).projection
    const item = [...projection.items.values()][0]
    const fact = [...projection.evidence.values()][0]
    expect(item).toMatchObject({ authority: 'root_instruction', semanticAction: 'test', targetCaptureStatus: 'resolved' })
    expect(item.legacyFlags).toBeUndefined()
    const result = certifyCheckpoint(projection, [{
      itemId: item.id, evidenceIds: [fact.id], semanticAction: 'test', requestedTarget: item.requestedTarget,
      resolvedTarget: fact.resolvedTarget, observedState: {}, effectEvidenceId: fact.id,
      expectedTransition: { predicateId: 'pred.test.outcome', version: 1, predParamsKind: 'inline', parameters: { expected_outcome: { k: 'e', v: 'success' }, min_matches: 1 } },
    }], 'C-legacy-rebind')
    expect(result.status).toBe('certified')

    const uncertainSession = Session.create(SessionId('legacy-unclassified-negative'), undefined, {
      version: 0, id: SessionId('legacy-unclassified-negative'), createdAt: 1, cwd: '/work',
    })
    enableCommand(uncertainSession, 'on')
    userText(uncertainSession, 'Background material about workspace state')
    uncertainSession.append('user/message', createUserMessage({
      content: [{ type: 'text', text: PROTOCOL_V3_NOTICE }],
      source: { kind: 'plugin', plugin: 'context-guard', form: 'notice', summary: 'Context Guard v3 boundary' },
    }), { surfaceOp: 'append' })
    toolCall(uncertainSession, 'unclassified-test', 'bash', JSON.stringify({ command: 'pnpm test', workdir: '/work' }))
    toolResult(uncertainSession, 'unclassified-test', '[exit code: 0]')
    const uncertain = deriveProjection(uncertainSession.events as never, OPT_IN, { cwd: '/work' }, true).projection
    const uncertainItem = [...uncertain.items.values()][0]
    const uncertainFact = [...uncertain.evidence.values()][0]
    const rejected = certifyCheckpoint(uncertain, [{
      itemId: uncertainItem.id, evidenceIds: [uncertainFact.id], semanticAction: 'test',
      requestedTarget: uncertainItem.requestedTarget, resolvedTarget: uncertainFact.resolvedTarget,
      observedState: {}, effectEvidenceId: uncertainFact.id,
      expectedTransition: { predicateId: 'pred.test.outcome', version: 1, predParamsKind: 'inline', parameters: { expected_outcome: { k: 'e', v: 'success' }, min_matches: 1 } },
    }], 'C-unclassified')
    expect(rejected.status).toBe('incomplete')
    expect(rejected.rejectedBindings[0]?.reasonCode).toBe('legacy_authority_unclassified')
  })

  it('keeps a prepare=false boundary result as a non-authoritative unknown diagnostic on durable replay', async () => {
    const session = Session.create(SessionId('boundary-unknown-replay'))
    enableCommand(session, 'on')
    userText(session, '等待用户选择后继续')
    const before = deriveProjection(session.events as never, OPT_IN, {}, true).projection
    const qualification = [...before.items.values()][0].waitAuthorization!
    const args = {
      disposition: 'user_wait' as const,
      qualification_kind: qualification.kind,
      qualification_ids: [qualification.id],
    }
    const boundaryTool = createBoundaryTool(() => before, async () => false, () => {})
    toolCall(session, 'boundary-unknown', 'context_guard_boundary', JSON.stringify(args))
    const value = await boundaryTool.execute(args, undefined as never)
    expect(value).toMatchObject({ status: 'unknown', reason_code: 'boundary_persistence_unknown' })
    toolResult(session, 'boundary-unknown', JSON.stringify(value))

    const replay = deriveProjection(session.events as never, OPT_IN, {}, true).projection
    expect(replay.integrity).toBe('valid')
    expect(replay.boundaries).toHaveLength(1)
    expect(replay.boundaries[0]).toMatchObject({ persistedResult: 'unknown', reasonCode: 'boundary_persistence_unknown' })
  })

  it('replays certificates against the exact runtime host identity and reports a changed digest as stale-host', () => {
    const session = Session.create(SessionId('host-identity-replay'), undefined, {
      version: 0, id: SessionId('host-identity-replay'), createdAt: 1, cwd: '/work',
    })
    enableCommand(session, 'on')
    userText(session, 'Run pnpm test in the workspace')
    toolCall(session, 'host-test', 'bash', JSON.stringify({ command: 'pnpm test', workdir: '/work' }))
    toolResult(session, 'host-test', '[exit code: 0]')
    const hostA: HostLockEvaluation = { ...TEST_HOST_LOCK, digest: 'a'.repeat(64) }
    const runtime = createRuntime(fakeAgent(session), OPT_IN, hostA)
    runtime.setDurability(true)
    runtime.sync()
    const item = [...runtime.projection.items.values()][0]
    const fact = [...runtime.projection.evidence.values()][0]
    const binding = {
      itemId: item.id, evidenceIds: [fact.id], semanticAction: 'test' as const,
      requestedTarget: item.requestedTarget, resolvedTarget: fact.resolvedTarget,
      observedState: fact.observedState ?? {}, effectEvidenceId: fact.id,
      expectedTransition: { predicateId: 'pred.test.outcome', version: 1, predParamsKind: 'inline' as const, parameters: { expected_outcome: { k: 'e' as const, v: 'success' }, min_matches: 1 } },
    }
    const certified = certifyCheckpoint(runtime.projection, [binding], 'C-host', false)
    expect(certified.status).toBe('certified')
    const checkpoint = certified.checkpoint!
    toolCall(session, 'host-checkpoint', 'context_guard_checkpoint', JSON.stringify({ bindings: [{
      item_id: binding.itemId, evidence_ids: binding.evidenceIds, semantic_action: binding.semanticAction,
      requested_target: binding.requestedTarget, resolved_target: binding.resolvedTarget,
      observed_state: binding.observedState, effect_evidence_id: binding.effectEvidenceId,
      expected_transition: {
        predicate_id: binding.expectedTransition.predicateId, version: 1, pred_params_kind: 'inline',
        parameters: binding.expectedTransition.parameters,
      },
    }] }))
    toolResult(session, 'host-checkpoint', JSON.stringify({ status: 'certified', certificate: {
      stop_protocol_version: checkpoint.stopProtocolVersion, certificate_version: checkpoint.certificateVersion,
      epoch: checkpoint.epoch, session_ref_digest: checkpoint.sessionRefDigest, host_lock_digest: checkpoint.hostLockDigest,
      contract_revision: checkpoint.contractRevision, contract_sha256: checkpoint.contractSha256,
      open_digest: checkpoint.openDigest, evidence_sha256: checkpoint.evidenceSha256,
      binding_digest: checkpoint.bindingDigest, certification_digest: checkpoint.certificationDigest,
      goal_ref: checkpoint.goalRef ?? null,
    } }))
    runtime.sync()
    expect(runtime.projection.hostLockDigest).toBe(hostA.digest)
    expect(hasCurrentCertificate(runtime.projection)).toBe(true)

    const hostB: HostLockEvaluation = { ...hostA, digest: 'b'.repeat(64), profileKind: 'headless' }
    const changed = createRuntime(fakeAgent(session), OPT_IN, hostB)
    changed.setDurability(true)
    changed.sync()
    expect(changed.projection.checkpoints.at(-1)?.hostLockDigest).toBe(hostA.digest)
    expect(hasCurrentCertificate(changed.projection)).toBe(false)
    expect(changed.projection.certificateStatusReason).toBe('stale_host_lock')
    expect(changed.projection.integrity).toBe('valid')
  })

  it('derives enablement only from the native command/run log', () => {
    const session = Session.create(SessionId('derive-enable-session'))
    enableCommand(session, 'on')
    const runtime = createRuntime(fakeAgent(session), OPT_IN)
    expect(runtime.projection.enabled).toBe(true)
    expect(runtime.projection.epoch).toBe(1)

    enableCommand(session, 'off')
    runtime.sync()
    expect(runtime.projection.enabled).toBe(false)
    expect(runtime.projection.epoch).toBe(1)

    enableCommand(session, 'on')
    runtime.sync()
    expect(runtime.projection.enabled).toBe(true)
    expect(runtime.projection.epoch).toBe(2)
  })

  it('derives nothing before the first enable command (opt-in)', () => {
    const session = Session.create(SessionId('derive-optin-session'))
    userText(session, 'ship the artifact')
    const runtime = createRuntime(fakeAgent(session), OPT_IN)
    expect(runtime.projection.enabled).toBe(false)
    expect(runtime.projection.items.size).toBe(0)
  })

  it('starts enabled with always activation', () => {
    const session = Session.create(SessionId('derive-always-session'))
    const runtime = createRuntime(fakeAgent(session), ALWAYS)
    expect(runtime.projection.enabled).toBe(true)
  })

  it('replays existing messages under always while honoring later off and on commands', () => {
    const session = Session.create(SessionId('derive-always-replay-session'))
    userText(session, 'ship before.txt')
    enableCommand(session, 'off')
    userText(session, 'ship ignored.txt')
    enableCommand(session, 'on')
    userText(session, 'ship after.txt')

    const runtime = createRuntime(fakeAgent(session), ALWAYS)
    const clauses = [...runtime.projection.items.values()].map((item) => item.normalizedText)
    expect(runtime.projection.enabled).toBe(true)
    expect(clauses).toContain('ship before.txt')
    expect(clauses).not.toContain('ship ignored.txt')
    expect(clauses).toContain('ship after.txt')
  })

  it('marks recovery needed after a compaction summary', () => {
    const session = Session.create(SessionId('recovery-session'))
    enableCommand(session, 'on')
    const runtime = createRuntime(fakeAgent(session), OPT_IN)
    expect(runtime.consumeRecovery()).toBe(false)

    rawAppend(session)('compaction/summary', {
      compactionId: 'c1',
      summary: [],
      shadowedRange: { start: 0, end: 0 },
      shadowedSeqs: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    })
    runtime.sync()
    expect(runtime.consumeRecovery()).toBe(true)
    expect(runtime.consumeRecovery()).toBe(false)
  })

  it('round-trips markRecoveryNeeded and consumeRecovery', () => {
    const session = Session.create(SessionId('recovery-session-2'))
    const runtime = createRuntime(fakeAgent(session), OPT_IN)
    runtime.markRecoveryNeeded()
    expect(runtime.consumeRecovery()).toBe(true)
    expect(runtime.consumeRecovery()).toBe(false)
  })

  it('marks recovery needed once when enablement transitions on', () => {
    const session = Session.create(SessionId('enable-session'))
    const runtime = createRuntime(fakeAgent(session), OPT_IN)
    expect(runtime.consumeRecovery()).toBe(false)
    enableCommand(session, 'on')
    runtime.sync()
    expect(runtime.consumeRecovery()).toBe(true)
    runtime.sync()
    expect(runtime.consumeRecovery()).toBe(false)
  })

  it('never writes custom session event types (persistence boundary)', () => {
    const session = Session.create(SessionId('no-custom-events-session'))
    enableCommand(session, 'on')
    userText(session, "Don't touch the API")
    toolCall(session, 'c1', 'read', '{"file_path":"a.txt"}')
    toolResult(session, 'c1', 'ok', { path: 'a.txt' })
    const runtime = createRuntime(fakeAgent(session), OPT_IN)
    runtime.sync()
    toolCall(session, 'c2', 'context_guard_checkpoint', '{"bindings":[]}')
    toolResult(session, 'c2', JSON.stringify({ status: 'incomplete', contract_revision: 1, open_items: [], rejected_bindings: [] }))
    runtime.sync()
    const custom = session.events.filter((event) => event.type.startsWith('context-guard/'))
    expect(custom).toEqual([])
  })

  it('generates unique evidence IDs and skips the checkpoint tool', () => {
    const session = Session.create(SessionId('evidence-id-session'))
    enableCommand(session, 'on')
    const runtime = createRuntime(fakeAgent(session), OPT_IN)
    runtime.setDurability(true)

    toolCall(session, 'c1', 'bash', '{"command":"echo hi"}')
    toolResult(session, 'c1', 'ok')
    toolCall(session, 'c2', 'read', '{"file_path":"a.txt"}')
    toolResult(session, 'c2', 'ok', { path: 'a.txt' })
    toolCall(session, 'c3', 'context_guard_checkpoint', '{"bindings":[]}')
    toolResult(session, 'c3', JSON.stringify({ status: 'incomplete', contract_revision: 0, open_items: [], rejected_bindings: [] }))

    runtime.sync()
    const evidence = [...runtime.projection.evidence.values()]
    const ids = evidence.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(evidence.some((e) => e.toolName === 'context_guard_checkpoint')).toBe(false)
    expect(ids).toContain('E0001')
    expect(ids).toContain('E0002')
  })

  it('captures a prohibition contract from a direct human message', () => {
    const session = Session.create(SessionId('capture-session'))
    enableCommand(session, 'on')
    const runtime = createRuntime(fakeAgent(session), OPT_IN)
    userText(session, "Don't touch the API")
    runtime.sync()
    const prohibition = [...runtime.projection.items.values()].find((item) => item.kind === 'prohibition')
    expect(prohibition).toBeDefined()
    expect(prohibition?.id).toBe('P001')
    expect(prohibition?.normalizedText).toBe('touch the API')
  })

  it('retains a legacy certificate as non-authoritative audit history', () => {
    const session = Session.create(SessionId('resume-session'))
    enableCommand(session, 'on')
    userText(session, 'verify the generated file src/app.ts')
    toolCall(session, 'c1', 'read', '{"file_path":"src/app.ts"}')
    toolResult(session, 'c1', 'ok', { path: 'src/app.ts' })

    const runtime = createRuntime(fakeAgent(session), OPT_IN)
    runtime.setDurability(true)
    runtime.sync()
    const itemId = [...runtime.projection.items.keys()][0]
    toolCall(session, 'c2', 'context_guard_checkpoint', JSON.stringify({ bindings: [{ item_id: itemId, evidence_ids: ['E0001'] }] }))
    toolResult(session, 'c2', JSON.stringify({ status: 'certified', contract_revision: 1, open_items: [], rejected_bindings: [] }))
    runtime.sync()
    expect(runtime.consumeRecovery()).toBe(false) // consumed earlier
    expect(runtime.projection.checkpoints).toHaveLength(0)
    expect(runtime.projection.items.get(itemId)?.status).toBe('passed')
    expect(runtime.projection.integrity).toBe('valid')
    expect(runtime.projection.items.get(itemId)?.legacyFlags).toContain('legacy_generic_run')

    // Rebuild over the same event log must reproduce the same state (resume path).
    const rebuilt = deriveProjection(session.events as never, OPT_IN, { cwd: '' }, true)
    expect(rebuilt.projection.checkpoints).toHaveLength(0)
    expect(rebuilt.projection.items.get(itemId)?.status).toBe('passed')
    expect(rebuilt.projection.integrity).toBe('valid')
    expect(rebuilt.projection.items.get(itemId)?.legacyFlags).toContain('legacy_generic_run')
  })

  it('flags corruption when a recorded certificate no longer re-derives', () => {
    const session = Session.create(SessionId('forged-cert-session'))
    enableCommand(session, 'on')
    userText(session, 'verify the generated file src/app.ts')
    // No evidence at all, but the recorded tool/result claims certification.
    toolCall(session, 'c1', 'context_guard_checkpoint', JSON.stringify({ bindings: [{ item_id: 'R001', evidence_ids: ['E9999'] }] }))
    toolResult(session, 'c1', JSON.stringify({ status: 'certified', contract_revision: 1, open_items: [], rejected_bindings: [], certificate: {} }))
    const runtime = createRuntime(fakeAgent(session), OPT_IN)
    runtime.setDurability(true)
    runtime.sync()
    expect(runtime.projection.integrity).toBe('corrupt')
  })
})

  it('preserves continuation attempts across rebuilds', () => {
    const session = Session.create(SessionId('attempts-session'))
    enableCommand(session, 'on')
    const runtime = createRuntime(fakeAgent(session), OPT_IN)
    runtime.projection.continuationAttempts.set(3, 2)
    runtime.sync()
    expect(runtime.projection.continuationAttempts.get(3)).toBe(2)
  })

  it('does not re-arm recovery from a historical compaction summary', () => {
    const session = Session.create(SessionId('compaction-once-session'))
    enableCommand(session, 'on')
    const runtime = createRuntime(fakeAgent(session), OPT_IN)
    rawAppend(session)('compaction/summary', {
      compactionId: 'c1', summary: [], shadowedRange: { start: 0, end: 0 },
      shadowedSeqs: [], shadowedTokenCount: 0, provider: 'p', model: 'm',
    })
    runtime.sync()
    expect(runtime.consumeRecovery()).toBe(true)
    runtime.sync()
    expect(runtime.consumeRecovery()).toBe(false)
  })

  it('binds the recovery digest to packet content, revision, and epoch (v0.2.1)', () => {
    const projection = createProjection()
    const packet = '[R001] ship the artifact'
    const digest = recoveryDigest(packet, projection)
    expect(recoveryDigest(packet, projection)).toBe(digest)
    expect(recoveryDigest(`${packet}!`, projection)).not.toBe(digest)
    projection.contractRevision = 2
    expect(recoveryDigest(packet, projection)).not.toBe(digest)
    projection.epoch = 3
    expect(recoveryDigest(packet, projection)).not.toBe(digest)
  })

  it('preserves the recovery digest across rebuilds and forgets it on enablement (v0.2.1)', () => {
    const session = Session.create(SessionId('recovery-digest-session'))
    enableCommand(session, 'on')
    const runtime = createRuntime(fakeAgent(session), OPT_IN)
    runtime.projection.lastRecoveryDigest = 'digest-1'
    runtime.sync()
    expect(runtime.projection.lastRecoveryDigest).toBe('digest-1')
    enableCommand(session, 'off')
    enableCommand(session, 'on')
    runtime.sync()
    expect(runtime.consumeRecovery()).toBe(true)
    expect(runtime.projection.lastRecoveryDigest).toBeUndefined()
  })

type PreStepHandler = (payload: { agent: Agent }, next: () => Promise<{ kind: string; messages: unknown[] }>) => Promise<{ kind: string; messages: unknown[] }>
type CheckpointTool = { execute: (args: { bindings: Array<{ item_id: string; evidence_ids: string[] }> }) => Promise<unknown> }

function fakeCtx() {
  const handlers = new Map<string, Array<(...args: never[]) => unknown>>()
  return {
    handlers,
    commands: { register: () => {} },
    sessions: { flush: async () => true },
    on: (event: string, handler: (...args: never[]) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
    },
  }
}

// CG-DSH-001: test locks carry the complete audited graph, whose Goal rows
// make goalAvailable true — so the harness binds a matching live Goal peer
// and the pinned update_goal tool the liveness consistency check requires.
const PINNED_UPDATE_GOAL_TOOL = {
  name: 'update_goal',
  execute: () => undefined,
  parameters: {
    type: 'object',
    required: ['goal_id', 'revision', 'action'],
    properties: {
      goal_id: { type: 'string' },
      revision: { type: 'number' },
      action: { type: 'string', enum: ['edit', 'pause', 'resume', 'complete', 'blocked'] },
      objective: { type: 'string' },
      max_goal_rounds: { type: 'number' },
      blocked_reason: { type: 'string' },
    },
  },
}

function guardedAgent(session: Session) {
  const registered: CheckpointTool[] = []
  const steered: unknown[] = []
  const agent = {
    session,
    steer: (message: unknown) => steered.push(message),
    ctx: {
      tools: {
        register: (tool: CheckpointTool) => registered.push(tool),
        guard: () => {},
        get: (name: string) => (name === 'update_goal' ? PINNED_UPDATE_GOAL_TOOL : undefined),
      },
      get: (name: string) => (name === 'goals'
        ? { get: () => undefined, disarm: async () => undefined }
        : undefined),
    },
  }
  return { agent: agent as unknown as Agent, registered, steered }
}

function startGuard(ctx: ReturnType<typeof fakeCtx>, agent: Agent, source: string) {
  for (const handler of ctx.handlers.get('agent/session-start') ?? []) {
    ;(handler as (payload: { agent: Agent; source: string }) => void)({ agent, source })
  }
}

async function runPreStep(ctx: ReturnType<typeof fakeCtx>, agent: Agent): Promise<number> {
  const handler = ctx.handlers.get('agent/pre-step')?.[0] as PreStepHandler | undefined
  const decision = await handler!({ agent }, async () => ({ kind: 'enter', messages: [] }))
  return decision.messages.length
}

async function rejectCheckpoint(registered: CheckpointTool[], itemId: string) {
  await registered[0].execute({ bindings: [{ item_id: itemId, evidence_ids: ['E9999'] }] })
}

function projectionRuntime(projection: ReturnType<typeof createProjection>): GuardRuntime {
  return {
    projection,
    session: Session.create(SessionId('turn-stop-projection')),
    sync: () => {}, setEnabled: () => {}, setDurability: () => {},
    markRecoveryNeeded: () => {}, consumeRecovery: () => false,
  }
}

function steeringAgent(steered: unknown[]): Agent {
  return { steer: (message: unknown) => steered.push(message) } as unknown as Agent
}

describe('production turn-stopping integration', () => {
  it('steers exactly once for root persistence and yields to an active armed Goal', async () => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause('持续推进，直到迁移脚本全部跑完为止。', 'm1', 'R001', 1, { cwd: '/work' })
    projection.items.set(item.id, item)
    projection.contractRevision = 1
    const runtime = projectionRuntime(projection)
    const steered: unknown[] = []
    const agent = steeringAgent(steered)
    const access = {
      flush: async () => true,
      hostSupported: true,
      readExternalOperation: () => undefined,
    }
    expect(await handleGuardTurnStopping(agent, runtime, access)).toBe('protocol_correction_steer')
    expect(await handleGuardTurnStopping(agent, runtime, access)).toBe('safe_yield_pending_preserved')
    expect(steered).toHaveLength(1)
    expect(JSON.stringify(steered[0])).toContain(PROTOCOL_CORRECTION_NOTICE)

    const goalProjection = createProjection()
    goalProjection.enabled = true
    goalProjection.items.set(item.id, structuredClone(item))
    goalProjection.contractRevision = 1
    goalProjection.currentGoalRef = { id: 'goal-1', revision: 1 }
    goalProjection.currentGoalPhase = 'active'
    goalProjection.currentGoalActivation = 'armed'
    const goalSteers: unknown[] = []
    expect(await handleGuardTurnStopping(steeringAgent(goalSteers), projectionRuntime(goalProjection), access))
      .toBe('goal_round_driver_owns_continuation')
    expect(goalSteers).toEqual([])
  })

  it('requires a successful flush and an unchanged immutable candidate before disarm', async () => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause('等待用户选择后继续', 'm1', 'R001', 1, { cwd: '/work' })
    item.waitAuthorization = { kind: 'root_explicit_wait', id: 'wait:R001' }
    projection.items.set(item.id, item)
    projection.contractRevision = 1
    projection.currentGoalRef = { id: 'goal-1', revision: 4 }
    projection.currentGoalPhase = 'active'
    projection.currentGoalActivation = 'armed'
    projection.boundaries.push(qualifyBoundary(projection, {
      disposition: 'user_wait', qualificationKind: 'root_explicit_wait', qualificationIds: ['wait:R001'],
    }))
    let disarms = 0
    const goalAccess = {
      get: async () => ({ id: 'goal-1', revision: 4, phase: 'active' as const, activation: 'armed' as const }),
      disarm: async () => { disarms += 1; return { id: 'goal-1', revision: 4, phase: 'active' as const, activation: 'disarmed' as const } },
    }
    const failedFlush = await handleGuardTurnStopping(steeringAgent([]), projectionRuntime(projection), {
      flush: async () => false, hostSupported: true, goalAccess, readExternalOperation: () => undefined,
    })
    expect(failedFlush).toBe('boundary_flush_failed')
    expect(disarms).toBe(0)

    // A target byte changes the contract digest without relying on revision
    // comparison, so the immutable candidate check is independently covered.
    const staleRuntime = projectionRuntime(projection)
    staleRuntime.sync = () => { item.requestedTarget = { scope: '/work-x' } }
    const stale = await handleGuardTurnStopping(steeringAgent([]), staleRuntime, {
      flush: async () => true, hostSupported: true, goalAccess, readExternalOperation: () => undefined,
    })
    expect(stale).toBe('boundary_candidate_stale')
    expect(disarms).toBe(0)
  })

  it('live-requalifies every external_wait job immediately before effectuation', async () => {
    const projection = createProjection()
    projection.enabled = true
    projection.externalOperations.set('job-1', { id: 'job-1', epoch: 0, adapterId: 'dsh.jobs.v1', status: 'running' })
    projection.boundaries.push(qualifyBoundary(projection, {
      disposition: 'external_wait', qualificationKind: 'external_operation_pending', qualificationIds: ['job-1'],
    }))
    let reads = 0
    const result = await handleGuardTurnStopping(steeringAgent([]), projectionRuntime(projection), {
      flush: async () => true,
      hostSupported: true,
      externalWaitCapability: { status: 'supported', digest: 'jobs-capability' },
      readExternalOperation: () => { reads += 1; return { id: 'job-1', adapterId: 'dsh.jobs.v1', status: 'completed' } },
    })
    expect(result).toBe('boundary_pre_effect_failure')
    expect(reads).toBe(1)
  })
})

describe('recovery injection dedup (v0.2.1)', () => {
  it('persists protocol-v3 only as a legal plugin notice and survives strict Session restore', () => {
    const session = Session.create(SessionId('protocol-notice-session'))
    enableCommand(session, 'on')
    userText(session, 'verify package.json')
    const ctx = fakeCtx()
    apply(ctx as never, {
      activation: 'opt-in', hostLockPackages: TEST_HOST_ROWS, hostLockPlatform: 'posix', hostLockProfile: 'web',
    })
    const { agent } = guardedAgent(session)
    startGuard(ctx, agent, 'new')

    const notices = session.events.filter((event) => event.type === 'user/message'
      && (event.data as { source?: { kind?: string; plugin?: string } }).source?.kind === 'plugin'
      && (event.data as { source?: { plugin?: string } }).source?.plugin === 'context-guard')
    expect(notices).toHaveLength(1)
    expect(session.events.some((event) => event.type === 'command/run'
      && (event.data as { source?: { kind?: string } }).source?.kind === 'plugin')).toBe(false)

    const seed = structuredClone(session.events) as never
    const header = structuredClone(session.header) as never
    const restored = Session.fromRestore(SessionId('protocol-notice-session'), seed, header)
    const replay = deriveProjection(restored.events as never, OPT_IN, { cwd: '/work' }, true)
    expect([...replay.projection.items.values()].some((item) => item.normalizedText.includes('protocol boundary'))).toBe(false)
  })

  it('injects an unchanged packet once, dedups repeated rejections, and re-injects on new content', async () => {
    const session = Session.create(SessionId('recovery-dedup-session'))
    enableCommand(session, 'on')
    userText(session, 'ship the artifact')
    const ctx = fakeCtx()
    apply(ctx as never, {
      activation: 'opt-in', hostLockPackages: TEST_HOST_ROWS, hostLockPlatform: 'posix', hostLockProfile: 'web',
    })
    const { agent, registered } = guardedAgent(session)
    startGuard(ctx, agent, 'new')

    expect(await runPreStep(ctx, agent)).toBe(0) // nothing armed
    await rejectCheckpoint(registered, 'R001')
    expect(await runPreStep(ctx, agent)).toBe(1) // first injection
    await rejectCheckpoint(registered, 'R001')
    expect(await runPreStep(ctx, agent)).toBe(0) // unchanged packet is deduped

    // New evidence changes the packet content, so the reminder flows again.
    toolCall(session, 'c1', 'bash', '{"command":"pnpm test","workdir":"/work"}')
    toolResult(session, 'c1', '[exit code: 0]')
    await rejectCheckpoint(registered, 'R001')
    expect(await runPreStep(ctx, agent)).toBe(1)
  })

  it('injects the post-resume reminder even when the packet is unchanged (v0.2.1)', async () => {
    const session = Session.create(SessionId('recovery-resume-session'))
    enableCommand(session, 'on')
    userText(session, 'ship the artifact')
    const ctx = fakeCtx()
    apply(ctx as never, {
      activation: 'opt-in', hostLockPackages: TEST_HOST_ROWS, hostLockPlatform: 'posix', hostLockProfile: 'web',
    })
    const { agent, registered } = guardedAgent(session)
    startGuard(ctx, agent, 'new')
    const registrationCount = registered.length
    await rejectCheckpoint(registered, 'R001')
    expect(await runPreStep(ctx, agent)).toBe(1)
    await rejectCheckpoint(registered, 'R001')
    expect(await runPreStep(ctx, agent)).toBe(0)
    startGuard(ctx, agent, 'resume')
    expect(registered).toHaveLength(registrationCount)
    expect(await runPreStep(ctx, agent)).toBe(1)
  })
})

describe('context-guard clear command (v0.2.1)', () => {
  it('supersedes pending requirements/acceptances, keeps prohibitions, and unlocks completion', () => {
    const session = Session.create(SessionId('clear-session'))
    enableCommand(session, 'on')
    userText(session, '修改 guard-demo.txt。不要 push。')
    rawAppend(session)('command/run', { commandId: 'cmd-clear', name: 'context-guard', args: 'clear', source: { kind: 'user' } })

    const { projection } = deriveProjection(session.events as never, OPT_IN, { cwd: '/work' }, true)
    const items = [...projection.items.values()]
    const requirement = items.find((item) => item.kind === 'requirement')!
    const prohibition = items.find((item) => item.kind === 'prohibition')!
    expect(requirement.status).toBe('superseded')
    expect(requirement.supersededBy).toMatch(/^CLEAR:\d+$/)
    expect(prohibition.status).toBe('pending')

    // Replay is deterministic: a second derivation reports the same states.
    const replayed = deriveProjection(session.events as never, OPT_IN, { cwd: '/work' }, true)
    expect([...replayed.projection.items.values()].map((item) => [item.id, item.status]))
      .toEqual(items.map((item) => [item.id, item.status]))

    // An empty-binding checkpoint certifies the cleared contract…
    projection.currentGoalRef = { id: 'goal-clear', revision: 1 }
    expect(certifyCheckpoint(projection, [], 'C001').status).toBe('certified')
    // …and the goal gate releases completion while the guard stays enabled.
    expect(goalCompletionDenial(projection, 'update_goal', { action: 'complete', goal_id: 'goal-clear', revision: 1 })).toBeUndefined()
  })

  it('exposes clear through the slash command and reports the superseded count', () => {
    const projection = createProjection()
    projection.items.set('R001', captureClause('ship the artifact', 'm1', 'R001', 1, { cwd: '/work' }))
    const command = createContextGuardCommand(
      () => projection,
      () => {},
      () => {
        projection.items.get('R001')!.status = 'superseded'
      },
    )
    const handler = command.handler as unknown as (payload: { agent: Agent; rawInput: string }) => { kind: string; text: string }
    const cleared = handler({ agent: {} as Agent, rawInput: 'clear' })
    expect(cleared.kind).toBe('success')
    expect(cleared.text).toContain('1 requirement/acceptance item(s) superseded')
    const usage = handler({ agent: {} as Agent, rawInput: 'bogus' })
    expect(usage.kind).toBe('error')
    expect(usage.text).toContain('clear')
  })
})
