import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { deriveItemDiagnosis, itemDiagnosis } from '../../src/domain/diagnostics.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { createCheckpointTool } from '../../src/tools/checkpoint.js'
import { certifyCheckpoint } from '../../src/domain/checkpoint.js'
import { evidenceSha256Digest, type EvidenceFact } from '../../src/domain/digest.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES, type HostLockEvaluation } from '../../src/domain/host-lock.js'
import { captureClause } from '../../src/domain/capture.js'
import { createProjection } from '../../src/domain/types.js'
import type { DerivedEnvelope, GuardEvidence, GuardItem, GuardProjection } from '../../src/domain/types.js'
import {
  admissibleForRemoval,
  partialFailureOf,
  removalIsComplete,
  removalIsPartiallyKnown,
} from '../../src/domain/capability-semantics.js'
import {
  CLEANUP_CONDITION_RULE,
  CLEANUP_CONDITION_RULE_COMPACT,
  carriesCleanupCondition,
  cleanupConditionFor,
  renderRecoveryPacket,
} from '../../src/domain/recovery.js'

/**
 * 0.6.2 D062-01–D062-04 (plan T01–T05). Synthetic scenarios only: no real
 * session content, paths, usernames, or private replay. Every deterministic
 * check runs through the REAL derivation, the REAL registered tools, and the
 * REAL replay entry, so a passing case is evidence about the production chain
 * rather than about a helper.
 */

const scope = { cwd: '/repo', sessionHeader: { version: 3, id: 'v062', createdAt: 1 } }
const auditedLock = (platform: 'posix' | 'windows'): HostLockEvaluation =>
  evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform })

let seq = 0
const reset = () => { seq = 0 }
const env = (type: string, data: unknown): DerivedEnvelope => ({ seq: seq++, type, data })
const notice = () => env('user/message', {
  source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' },
  content: [{ type: 'text', text: PROTOCOL_V5_NOTICE }],
})

interface ShellRun {
  command: string
  /** Raw trailing text of the tool result (renderer markers included). */
  text?: string
  error?: unknown
  meta?: unknown
}

/** One synthetic session: the root inputs, then the shell runs, then turn end. */
function session(rootInputs: string[], runs: ShellRun[], platform: 'posix' | 'windows' = 'posix'): DerivedEnvelope[] {
  reset()
  const tool = platform === 'windows' ? 'pwsh' : 'bash'
  const events: DerivedEnvelope[] = [notice(), env('turn/start', { turn: 1 })]
  for (const text of rootInputs) {
    events.push(env('user/message', { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  }
  for (const [index, run] of runs.entries()) {
    events.push(env('tool/call', { turn: 1, callId: `sh-${index}`, name: tool, arguments: JSON.stringify({ command: run.command, workdir: '/repo' }) }))
    events.push(env('tool/result', {
      turn: 1,
      ...(run.error !== undefined ? { error: run.error } : {}),
      ...(run.meta !== undefined ? { meta: run.meta } : {}),
      message: { source: { callId: `sh-${index}` }, content: [{ type: 'text', text: run.text ?? 'ok' }] },
    }))
  }
  events.push(env('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  return events
}

function replay(rootInputs: string[], runs: ShellRun[], platform: 'posix' | 'windows' = 'posix') {
  return deriveProjection(session(rootInputs, runs, platform), { activation: 'always' as const }, scope, true, auditedLock(platform))
}

const itemFor = (p: GuardProjection, action: string): GuardItem => {
  const item = [...p.items.values()].find((candidate) => (candidate.semanticAction ?? 'generic_run') === action)
  expect(item, `item for ${action}`).toBeDefined()
  return item!
}

const shellEvidence = (p: GuardProjection): GuardEvidence => {
  const evidence = [...p.evidence.values()].find((row) => row.processFacts !== undefined)
  expect(evidence, 'shell evidence').toBeDefined()
  return evidence!
}


describe('0.6.2 T01: capability diagnosis distinguishes unknown, unsupported and genuinely missing input', () => {
  it('a concrete action with no adapter is a capability gap, never a user-input gap or a rebind', () => {
    // A real replay of the incident shape: an explicit cleanup instruction.
    const { projection } = replay(['清理构建缓存目录'], [], 'windows')
    const item = itemFor(projection, 'generic_run')
    const diagnosis = deriveItemDiagnosis(projection, item)
    expect(item.legacyFlags ?? []).toEqual([])
    expect(diagnosis.reason_code).toBe('generic_run_non_certifiable')
    expect(diagnosis.capability.gap).toBe('missing_adapter')
    expect(diagnosis.capability.remedy).toBe('report_uncertified_capability_gap')
    expect(diagnosis.capability.actionSupported).toBe(false)
    expect(diagnosis.capability.certifiable).toBe(false)
    // The inapplicable advice is gone: no required input, and no claim that a
    // rebind is what unblocks certification.
    expect(diagnosis.next_action.required_input).toBeUndefined()
    expect(diagnosis.next_action.kind).toBe('report_only')
    expect(diagnosis.repairability).toBe('unsupported')
    expect(JSON.stringify(diagnosis)).not.toContain('rebind')
    expect(JSON.stringify(diagnosis)).not.toContain('user_input_required')
    // The consequence still forbids claiming a certificate and still forbids
    // converting the capability gap into a demand that the user re-word it.
    expect(diagnosis.next_action.resume_condition).toContain('do not claim a certificate')
    expect(diagnosis.next_action.resume_condition).toContain('do not demand that the user restate the request')
  })

  it.each([
    // Every clause below is read as a concrete executable instruction whose
    // verb is simply not in the certification action set. The guard says
    // exactly that instead of inventing a target gap or a rebind.
    '删除构建产物目录', '清理并移除缓存',
    'delete the build output directory', 'remove the stale worktree',
  ])('a concrete action with no adapter stays a capability fact: %s', (text) => {
    const { projection } = replay([text], [], 'posix')
    const item = itemFor(projection, 'generic_run')
    expect(item.authorityDisposition).toBe('executable_now')
    const diagnosis = deriveItemDiagnosis(projection, item)
    expect(diagnosis.capability.gap).toBe('missing_adapter')
    // The machine-readable remedy is a capability report, not a request for a
    // new root instruction; the explanation text says the same thing.
    expect(diagnosis.capability.remedy).toBe('report_uncertified_capability_gap')
    expect(diagnosis.capability.remedy).not.toBe('fresh_root_instruction')
    expect(diagnosis.repairability).toBe('unsupported')
    expect(JSON.stringify(diagnosis)).not.toContain('context_guard_rebind')
    expect(JSON.stringify(diagnosis)).not.toContain('user_input_required')
  })

  it('a clause the guard could not read is a different gap with the same refusal to over-ask', () => {
    // '移除 old-worktree' is captured but conservatively left unresolved: the
    // guard does not know it is a removal instruction at all. It must not
    // report that as a missing parameter either.
    const { projection } = replay(['移除 old-worktree'], [], 'posix')
    const item = itemFor(projection, 'generic_run')
    expect(item.authorityDisposition).toBe('unresolved')
    const diagnosis = deriveItemDiagnosis(projection, item)
    expect(diagnosis.capability.gap).toBe('interpretation_unknown')
    expect(diagnosis.capability.remedy).toBe('fresh_root_instruction')
    expect(diagnosis.capability.actionSupported).toBe(false)
    expect(diagnosis.repairability).toBe('none')
    expect(diagnosis.next_action.required_input).toBeUndefined()
  })

  it('a genuinely absent target identity is the one case that asks the root for input', () => {
    const item = captureClause('在仓库提交变更', 'm1', 'R001', 1)
    expect(item.targetCaptureStatus).toBe('clarification_required')
    const p = createProjection()
    p.enabled = true
    p.items.set(item.id, item)
    const diagnosis = deriveItemDiagnosis(p, item)
    expect(diagnosis.capability.gap).toBe('target_missing')
    expect(diagnosis.capability.remedy).toBe('supply_target')
    expect(diagnosis.capability.actionSupported).toBe(true)
    expect(diagnosis.capability.certifiable).toBe(true)
    expect(diagnosis.repairability).toBe('user_input_required')
    expect(diagnosis.next_action.kind).toBe('clarify_target')
    expect(diagnosis.missing_fields).toEqual(['repository'])
  })

  it('an unreadable clause is neither a missing parameter nor a user-authority gap', () => {
    // The derivation marks a clause it could not read as `unresolved`; this
    // fixture carries that capture disposition without needing a real clause.
    const item = { ...captureClause('嗯……', 'm1', 'R001', 1), authorityDisposition: 'unresolved' as const }
    const p = createProjection()
    p.enabled = true
    p.items.set(item.id, item)
    const diagnosis = deriveItemDiagnosis(p, item)
    expect(diagnosis.capability.gap).toBe('interpretation_unknown')
    expect(diagnosis.capability.remedy).toBe('fresh_root_instruction')
    expect(diagnosis.capability.actionSupported).toBe(false)
    expect(diagnosis.repairability).toBe('none')
    expect(diagnosis.next_action.required_input).toBeUndefined()
  })

  it('a certified item and a standing constraint report no gap and no repair', () => {
    const p = createProjection()
    p.enabled = true
    p.items.set('P001', {
      id: 'P001', revision: 1, kind: 'prohibition', sourceMessageId: 'm1', normalizedText: '不要推送',
      textSha256: 'a'.repeat(64), status: 'pending', verification: { enforced: true, surface: 'scope', subject: '/repo' },
    })
    const diagnosis = deriveItemDiagnosis(p, p.items.get('P001')!)
    expect(diagnosis.capability.gap).toBe('constraint')
    expect(diagnosis.capability.remedy).toBe('none')
    expect(diagnosis.capability.actionSupported).toBe(false)
    expect(diagnosis.capability.certifiable).toBe(false)
  })

  it('prepare reports the same capability fact the diagnosis carries', async () => {
    const { projection } = replay(['清理构建缓存目录'], [], 'windows')
    const item = itemFor(projection, 'generic_run')
    const prepare = createPrepareTool({ getProjection: () => projection })
    const response = await prepare.execute({ item_id: item.id } as never, undefined as never) as {
      status: string
      diagnosis: { capability: { gap: string; remedy: string } }
    }
    expect(response.status).toBe('prepared')
    expect(response.diagnosis.capability).toEqual({ actionSupported: false, certifiable: false, gap: 'missing_adapter', remedy: 'report_uncertified_capability_gap', blockingReasonCodes: ['generic_run_non_certifiable'] })
  })

  it('the same fact reaches the real checkpoint page and the recovery packet', async () => {
    const { projection } = replay(['清理构建缓存目录'], [], 'windows')
    const checkpoint = createCheckpointTool(() => projection, () => {})
    const page = await checkpoint.execute({ bindings: [] }, undefined as never) as {
      open_items: Array<{ capability?: { gap: string; remedy: string } }>
    }
    expect(page.open_items[0]?.capability).toEqual({ action_supported: false, certifiable: false, gap: 'missing_adapter', remedy: 'report_uncertified_capability_gap' })
    const packet = renderRecoveryPacket(projection)
    expect(packet).toContain('generic_run_non_certifiable')
    expect(packet).not.toContain('context_guard_rebind')
  })
})

describe('0.6.2 T02: host return, declared exit status, attribution and business outcome are separate facts', () => {
  it('an unmarked bash success is a business success with NO declared exit code', () => {
    const { projection } = replay(['运行 pnpm test'], [{ command: 'pnpm test', text: 'all good' }], 'posix')
    const evidence = shellEvidence(projection)
    expect(evidence.outcome).toBe('success')
    expect(evidence.processFacts).toMatchObject({
      hostToolReturned: 'result',
      declaredExitCode: 'unknown',
      terminalMarkerRead: false,
      outcome: 'success',
      outcomeReason: 'unmarked_renderer_success',
      operationAttribution: 'single_operation',
    })
  })

  it('an explicit zero exit marker is read as exit 0, and a non-zero one as failure', () => {
    const zero = replay(['运行 pnpm test'], [{ command: 'pnpm test', text: 'ok\n[exit code: 0]' }], 'posix')
    expect(shellEvidence(zero.projection).processFacts).toMatchObject({ declaredExitCode: 0, outcome: 'success', outcomeReason: 'declared_exit_code' })
    const one = replay(['运行 pnpm test'], [{ command: 'pnpm test', text: 'boom\n[exit code: 1]' }], 'posix')
    expect(shellEvidence(one.projection).processFacts).toMatchObject({ declaredExitCode: 1, outcome: 'failure', outcomeReason: 'declared_exit_code' })
  })

  it('the OLD success classification is never re-read as a read exit code of 0', () => {
    // The W061-02 shape: a compound pwsh script whose middle step exited 255,
    // the host tool reported no error, and no terminal marker exists.
    const { projection } = replay(
      ['清理工作树'],
      [{ command: 'git worktree remove a; git worktree remove b; git worktree list', text: 'removed a\nremove of b failed\n' }],
      'windows',
    )
    const evidence = shellEvidence(projection)
    expect(evidence.outcome).toBe('success')
    expect(evidence.parseStatus).toBe('unsupported_statement_operator')
    expect(evidence.processFacts).toMatchObject({
      hostToolReturned: 'result',
      declaredExitCode: 'unknown',
      terminalMarkerRead: false,
      operationAttribution: 'unknown',
    })
    // The opaque operation layer never inherits the last command's status.
    expect(evidence.processFacts?.declaredOperationResults).toBeUndefined()
  })

  it('an example error inside ordinary output is not a terminal fact', () => {
    const { projection } = replay(
      ['运行 pnpm test'],
      [{ command: 'pnpm test', text: 'documentation says [timed out after 1000ms] but the command succeeded' }],
      'posix',
    )
    expect(shellEvidence(projection).processFacts).toMatchObject({ declaredExitCode: 'unknown', outcome: 'success', terminalMarkerRead: false })
  })

  it('a rendered timeout marker is a negative fact even without an exit code', () => {
    const { projection } = replay(['运行 pnpm test'], [{ command: 'pnpm test', text: 'partial\n[timed out after 30000ms]' }], 'posix')
    expect(shellEvidence(projection).processFacts).toMatchObject({ outcome: 'failure', outcomeReason: 'declared_negative_marker', declaredExitCode: 'unknown' })
  })

  it('a host error flag is the host return, not a declared process status', () => {
    const { projection } = replay(['运行 pnpm test'], [{ command: 'pnpm test', text: 'ok', error: { code: 'SPAWN' } }], 'posix')
    const evidence = shellEvidence(projection)
    expect(evidence.outcome).toBe('failure')
    expect(evidence.processFacts).toMatchObject({ hostToolReturned: 'error', declaredExitCode: 'unknown', outcome: 'failure', outcomeReason: 'host_error_flag' })
  })

  it('a backgrounded call is never a completion fact', () => {
    reset()
    const events: DerivedEnvelope[] = [
      notice(), env('turn/start', { turn: 1 }),
      env('user/message', { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: '运行 pnpm test' }] }),
      env('tool/call', { turn: 1, callId: 'sh-0', name: 'bash', arguments: JSON.stringify({ command: 'pnpm test', workdir: '/repo', run_in_background: true }) }),
      env('tool/result', { turn: 1, message: { source: { callId: 'sh-0' }, content: [{ type: 'text', text: 'started\n[exit code: 0]' }] } }),
      env('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    const { projection } = deriveProjection(events, { activation: 'always' as const }, scope, true, auditedLock('posix'))
    expect(shellEvidence(projection).processFacts).toMatchObject({ outcome: 'unknown', outcomeReason: 'backgrounded', declaredExitCode: 0 })
    expect(shellEvidence(projection).outcome).toBe('unknown')
  })

  it('declared per-operation results inside one command are the facts that carry the winner, both ways', () => {
    const failing = replay(
      ['运行 pnpm test'],
      [{
        command: 'pnpm test',
        text: 'ok',
        meta: { contextGuardProcess: { operationResults: [{ action: 'test', outcome: 'failure' }] } },
      }],
      'posix',
    )
    const evidence = shellEvidence(failing.projection)
    expect(evidence.processFacts).toMatchObject({ operationAttribution: 'declared_per_operation' })
    expect(partialFailureOf(evidence.processFacts!)).toEqual({ failed: [{ action: 'test', outcome: 'failure' }] })
    // An identical command whose run succeeded is not a partial failure.
    expect(partialFailureOf(shellEvidence(replay(['运行 pnpm test'], [{ command: 'pnpm test', text: 'ok' }], 'posix').projection).processFacts!)).toBeUndefined()
  })

  it('a declared partial failure is visible, and an undeclared remainder stays unknown', () => {
    const { projection } = replay(
      ['运行 pnpm test'],
      [{
        command: 'pnpm test',
        text: 'ok',
        meta: { contextGuardProcess: { operationResults: [{ action: 'test', outcome: 'success' }, { action: 'verify', outcome: 'failure' }] } },
      }],
      'posix',
    )
    const evidence = shellEvidence(projection)
    expect(partialFailureOf(evidence.processFacts!)).toEqual({ failed: [{ action: 'verify', outcome: 'failure' }] })
    // One unknown entry makes the whole attribution inconclusive: the guard
    // never widens a declared subset into a claim about the rest.
    const withUnknown = replay(
      ['运行 pnpm test'],
      [{
        command: 'pnpm test',
        text: 'ok',
        meta: { contextGuardProcess: { operationResults: [{ action: 'test', outcome: 'failure' }, { action: 'verify', outcome: 'unknown' }] } },
      }],
      'posix',
    )
    expect(partialFailureOf(shellEvidence(withUnknown.projection).processFacts!)).toBeUndefined()
  })

  it('the derived layer reads the trusted run declaration first and states its source', () => {
    // Only the namespace declares the fact: the LAYER must read it.
    const namespaceOnly = replay(['运行 pnpm test'], [{
      command: 'pnpm test', text: 'ok', meta: { contextGuardProcess: { exitCode: 7 } },
    }], 'posix')
    expect(shellEvidence(namespaceOnly.projection).processFacts).toMatchObject({
      declaredExitCode: 7, outcome: 'failure', outcomeReason: 'declared_exit_code',
      terminalMarkerRead: true, source: 'run_declaration',
    })
    // The generic structured meta is the layer's second source, and the rendered
    // markers its third: each state names where its facts came from.
    expect(shellEvidence(replay(['运行 pnpm test'], [{
      command: 'pnpm test', text: 'ok', meta: { exitCode: 3 },
    }], 'posix').projection).processFacts).toMatchObject({ declaredExitCode: 3, outcome: 'failure', source: 'structured_meta' })
    expect(shellEvidence(replay(['运行 pnpm test'], [{ command: 'pnpm test', text: 'ok' }], 'posix').projection).processFacts)
      .toMatchObject({ declaredExitCode: 'unknown', outcome: 'success', source: 'rendered_markers', frozenOutcomeConflict: false })
  })

  it('a declared namespace signal is a negative fact in the layer even without an exit code', () => {
    const { projection } = replay(['运行 pnpm test'], [{
      command: 'pnpm test', text: 'ok', meta: { contextGuardProcess: { signal: 'SIGKILL' } },
    }], 'posix')
    expect(shellEvidence(projection).processFacts).toMatchObject({
      declaredExitCode: 'unknown', outcome: 'failure', outcomeReason: 'declared_negative_marker', source: 'run_declaration',
    })
  })

  it('the layer never rewrites the historical outcome: it reports the divergence instead', () => {
    // 0.6.2 review regression table. The frozen field keeps the 0.6.1 rule
    // (generic `meta.exitCode`, then rendered markers — never the run
    // declaration), so already-recorded evidence digests cannot move. The layer
    // states its own verdict AND that the two disagree.
    //
    // A: only the run declaration declares exit 7. 0.6.1 reads no marker, so the
    //    audited renderer rule makes the frozen outcome a clean success; the
    //    layer reads exit 7 and reports failure with a visible conflict.
    const a = shellEvidence(replay(['运行 pnpm test'], [{
      command: 'pnpm test', text: 'ok', meta: { contextGuardProcess: { exitCode: 7 } },
    }], 'posix').projection)
    expect(a.outcome).toBe('success')
    expect(a.processFacts).toMatchObject({ outcome: 'failure', frozenOutcomeConflict: true })
    // B: generic exit 7 with a run declaration of 0. 0.6.1 reads the generic
    //    fact and calls it a failure; the layer reads the declaration and calls
    //    it a success. The frozen field stays the historical failure, so the
    //    layer can never promote an old failure to success.
    const b = shellEvidence(replay(['运行 pnpm test'], [{
      command: 'pnpm test', text: 'ok', meta: { exitCode: 7, contextGuardProcess: { exitCode: 0 } },
    }], 'posix').projection)
    expect(b.outcome).toBe('failure')
    expect(b.processFacts).toMatchObject({ outcome: 'success', frozenOutcomeConflict: true })
    // Agreement is explicit too, so a consumer never has to infer it.
    const agreed = shellEvidence(replay(['运行 pnpm test'], [{
      command: 'pnpm test', text: 'ok', meta: { exitCode: 0, contextGuardProcess: { exitCode: 0 } },
    }], 'posix').projection)
    expect(agreed.outcome).toBe('success')
    expect(agreed.processFacts).toMatchObject({ outcome: 'success', frozenOutcomeConflict: false })
  })

  it('the derived layers are excluded from every frozen digest and certificate field', () => {
    const { projection } = replay(['运行 pnpm test'], [{ command: 'pnpm test', text: 'ok' }], 'posix')
    const evidence = shellEvidence(projection)
    // The frozen two fields keep their exact historical meaning.
    expect(evidence.outcome).toBe('success')
    expect(evidence.parseStatus).toBe('supported')
    // The new fields are additive and therefore absent from the certificate
    // domain, which is rebuilt from the frozen field list.
    const rebuilt: GuardEvidence = { ...evidence }
    delete rebuilt.processFacts
    expect(rebuilt.outcome).toBe(evidence.outcome)
    expect(rebuilt.parseStatus).toBe(evidence.parseStatus)
  })
})

describe('0.6.2 T03: a removal counts only for objects proven dependency-free', () => {
  it('only dependency_free enters the removal set', () => {
    expect(admissibleForRemoval('dependency_free')).toBe(true)
    expect(admissibleForRemoval('in_use')).toBe(false)
    expect(admissibleForRemoval('unknown')).toBe(false)
  })

  it('a clean tree or an empty worktree list never proves "no dependants"', () => {
    const complete = { metadataRemoved: 'yes' as const, contentRemoved: 'yes' as const, directoryRemoved: 'yes' as const }
    expect(removalIsComplete(complete, 'dependency_free')).toBe(true)
    for (const status of ['in_use', 'unknown'] as const) {
      expect(removalIsComplete(complete, status)).toBe(false)
      expect(removalIsPartiallyKnown(complete, status)).toBe(true)
    }
    // A partially deleted object is not complete even when it is dependency-free.
    expect(removalIsComplete({ metadataRemoved: 'yes', contentRemoved: 'partial', directoryRemoved: 'no' }, 'dependency_free')).toBe(false)
    expect(removalIsPartiallyKnown({ metadataRemoved: 'yes', contentRemoved: 'partial', directoryRemoved: 'no' }, 'dependency_free')).toBe(true)
  })

  it('the recovery packet states the applicable condition for every capability-limited lane', () => {
    const { projection } = replay(['清理构建缓存目录'], [], 'windows')
    const packet = renderRecoveryPacket(projection)
    expect(packet).toContain(CLEANUP_CONDITION_RULE)
    for (const gap of ['missing_adapter', 'legacy_migration_required', 'historical_preevidence_missing', 'operation_unattributable', 'interpretation_unknown'] as const) {
      expect(carriesCleanupCondition(gap), gap).toBe(true)
    }
    // A lane that only needs more evidence, or that is already closed, does not
    // carry a cleanup condition it has nothing to do with.
    for (const gap of ['none', 'closed', 'constraint', 'delivery_pending', 'target_missing'] as const) {
      expect(carriesCleanupCondition(gap), gap).toBe(false)
    }
  })

  it('a compact packet still carries the condition, never dropping it for budget (0.6.2 review)', () => {
    const { projection } = replay(['清理构建缓存目录'], [], 'windows')
    for (const charBudget of [512, 700, 999, 1000, 4000]) {
      const packet = renderRecoveryPacket(projection, { charBudget })
      expect(packet.length, `budget ${charBudget}`).toBeLessThanOrEqual(charBudget)
      const carried = packet.includes(cleanupConditionFor(charBudget))
      expect(carried, `condition missing at budget ${charBudget}: ${packet}`).toBe(true)
      // Every form states the core condition, so the invariant is checkable
      // across the three wording tiers.
      expect(packet, `condition unstated at ${charBudget}`).toMatch(/dependency-free|no-dependants/)
    }
  })

  it('a compact packet without a capability-limited item does not carry an unrelated condition', () => {
    const { projection } = replay(['运行 pnpm test'], [{ command: 'pnpm test', text: 'ok' }], 'posix')
    const packet = renderRecoveryPacket(projection, { charBudget: 512 })
    expect(packet).not.toContain(CLEANUP_CONDITION_RULE_COMPACT)
  })

  it('a cleanup with no evidence is still uncertifiable, and no certificate is invented', async () => {
    const { projection } = replay(['清理构建缓存目录'], [], 'windows')
    const checkpoint = createCheckpointTool(() => projection, () => {})
    const page = await checkpoint.execute({ bindings: [] }, undefined as never) as {
      status: string
      open_items: Array<{ certifiable: boolean; capability?: { gap: string } }>
      certificate?: unknown
    }
    expect(page.status).toBe('incomplete')
    expect(page.certificate).toBeUndefined()
    expect(page.open_items).toHaveLength(1)
    expect(page.open_items[0]?.certifiable).toBe(false)
    expect(page.open_items[0]?.capability?.gap).toBe('missing_adapter')
  })
})

describe('0.6.2 T04: ordinary endings stay ordinary, silent ends stay uncertified', () => {
  it('an ordinary business tool call gains no Guard approval requirement', () => {
    const { projection } = replay(['运行 pnpm test'], [{ command: 'pnpm test', text: 'ok' }], 'posix')
    // The obligation is repairable by collecting the ordinary fact it needs; no
    // approval, credential, or Guard gate appears anywhere in the diagnosis.
    const diagnosis = deriveItemDiagnosis(projection, itemFor(projection, 'test'))
    expect(diagnosis.capability.remedy).toBe('collect_evidence')
    expect(JSON.stringify(diagnosis)).not.toContain('approval')
    expect(JSON.stringify(diagnosis)).not.toContain('authorization')
  })

  it('a pending obligation can end silently without being reported as complete', () => {
    const { projection } = replay(['清理构建缓存目录'], [], 'windows')
    const checkpoint = createCheckpointTool(() => projection, () => {})
    return checkpoint.execute({ bindings: [] }, undefined as never).then((result) => {
      expect(result).toMatchObject({ status: 'incomplete' })
      expect(JSON.stringify(result)).not.toContain('"status":"certified"')
    })
  })

  it('a forced checkpoint still refuses a binding with no matching evidence', () => {
    const { projection } = replay(['运行 pnpm test'], [{ command: 'pnpm test', text: 'ok' }], 'posix')
    const item = itemFor(projection, 'test')
    const result = certifyCheckpoint(projection, [{
      itemId: item.id, evidenceIds: [], semanticAction: 'test',
    }], 'C1', true)
    expect(result.status).toBe('incomplete')
    expect(result.checkpoint).toBeUndefined()
  })

  it('the same capability answer is stable across repeated derivations of unchanged input', () => {
    const first = deriveItemDiagnosis(replay(['清理构建缓存目录'], [], 'windows').projection,
      itemFor(replay(['清理构建缓存目录'], [], 'windows').projection, 'generic_run'))
    const second = deriveItemDiagnosis(replay(['清理构建缓存目录'], [], 'windows').projection,
      itemFor(replay(['清理构建缓存目录'], [], 'windows').projection, 'generic_run'))
    expect(second.capability).toEqual(first.capability)
    expect(second.attempt_fingerprint).toBe(first.attempt_fingerprint)
    expect(second.reason_code).toBe(first.reason_code)
  })
})

describe('0.6.2 T05: migration and replay keep history intact', () => {
  it('a pre-v5 item with a legacy closure flag keeps its own migration lane and remedy', () => {
    // A pre-0.5 item carries the birth flags the derivation stamps when an old
    // closure is replayed (derive.ts). Its remedy is the one genuinely reachable
    // replacement path — a fresh explicit instruction through the migration
    // lane — and it is deliberately DIFFERENT from a current item's remedy.
    const projection = createProjection()
    projection.enabled = true
    const base = captureClause('清理构建缓存目录', 'm1', 'R001', 1)
    const legacy: GuardItem = { ...base, legacyFlags: ['legacy_generic_run', 'legacy_authority_unclassified'] }
    projection.items.set(legacy.id, legacy)
    const diagnosis = deriveItemDiagnosis(projection, legacy)
    expect(diagnosis.reason_code).toBe('generic_run_non_certifiable')
    expect(diagnosis.capability.gap).toBe('legacy_migration_required')
    expect(diagnosis.capability.remedy).toBe('fresh_root_instruction')
    expect(diagnosis.repairability).toBe('historical_gap')
    // Nothing is silently promoted, dropped, or certified by the new reading:
    // the item stays recorded under its own birth rules.
    expect(projection.items.get(legacy.id)?.status).toBe('pending')
    expect(projection.checkpoints).toHaveLength(0)
  })

  it('a current item with a comparable absence of capability never claims a migration lane', () => {
    // The two remedies must not be interchangeable: a current instruction is
    // complete, so nothing about it needs replacing.
    const projection = createProjection()
    projection.enabled = true
    const current = captureClause('清理构建缓存目录', 'm1', 'R001', 1)
    projection.items.set(current.id, current)
    const diagnosis = deriveItemDiagnosis(projection, current)
    expect(diagnosis.capability.gap).toBe('missing_adapter')
    expect(diagnosis.capability.remedy).toBe('report_uncertified_capability_gap')
    expect(diagnosis.repairability).toBe('unsupported')
  })

  it('the same input replays to the same projection evidence facts', () => {
    const a = replay(['运行 pnpm test'], [{ command: 'pnpm test', text: 'ok' }], 'posix')
    const b = replay(['运行 pnpm test'], [{ command: 'pnpm test', text: 'ok' }], 'posix')
    expect(JSON.stringify([...b.projection.evidence.values()])).toBe(JSON.stringify([...a.projection.evidence.values()]))
    expect(JSON.stringify([...b.projection.items.values()])).toBe(JSON.stringify([...a.projection.items.values()]))
  })

  it('the real checkpoint page publishes the source and the conflict flag for the divergence rows', async () => {
    // The reviewer's two rows, read through the REAL checkpoint entry point: a
    // caller that sees `process_outcome` differ from `outcome` must be told
    // which source declared it and that the two readings disagree.
    const rows = [
      {
        label: 'A: namespace-only exit 7',
        meta: { contextGuardProcess: { exitCode: 7 } },
        frozen: 'success', layer: 'failure', conflict: true,
      },
      {
        label: 'B: generic 7 with namespace 0',
        meta: { exitCode: 7, contextGuardProcess: { exitCode: 0 } },
        frozen: 'failure', layer: 'success', conflict: true,
      },
      {
        label: 'C: both agree on 0',
        meta: { exitCode: 0, contextGuardProcess: { exitCode: 0 } },
        frozen: 'success', layer: 'success', conflict: false,
      },
    ] as const
    for (const row of rows) {
      const { projection } = replay(['运行 pnpm test'], [{ command: 'pnpm test', text: 'ok', meta: row.meta }], 'posix')
      const evidence = shellEvidence(projection)
      expect(evidence.outcome, row.label).toBe(row.frozen)
      const page = await createCheckpointTool(() => projection, () => {}).execute(
        { bindings: [], evidence_scope: 'history' }, undefined as never,
      ) as { available_evidence: Array<{ id: string; outcome: string; process_facts?: Record<string, unknown> }> }
      const published = page.available_evidence.find((entry) => entry.id === evidence.id)
      expect(published, row.label).toBeDefined()
      expect(published!.outcome, row.label).toBe(row.frozen)
      expect(published!.process_facts, row.label).toMatchObject({
        process_outcome: row.layer,
        source: 'run_declaration',
        frozen_outcome_conflict: row.conflict,
      })
      // The two fields are published together with the outcome they explain, so
      // a caller never has to guess why they differ.
      expect(Object.keys(published!.process_facts ?? {})).toEqual(expect.arrayContaining(['process_outcome', 'source', 'frozen_outcome_conflict']))
    }
  })

  it('the evidence digest domain is byte-identical with and without the derived layer', () => {
    const { projection } = replay(['运行 pnpm test'], [{ command: 'pnpm test', text: 'ok' }], 'posix')
    const evidence = shellEvidence(projection)
    // Reproduce the certificate's own evidence mapping (`evidenceFact` in
    // src/domain/checkpoint.ts) for the row as derived, and for the same row
    // with the derived layer stripped. The mapper ignores `processFacts`, so
    // the two digests must be byte-identical: the new layer can never move a
    // historical hash.
    const factOf = (row: GuardEvidence): EvidenceFact => ({
      id: row.id, outcome: row.outcome, method: row.toolName,
      operations: (row.operations ?? []).map((entry) => entry.op),
      executables: row.executables ?? [], subjects: row.subjects,
      surfaces: row.surfaces, semanticAction: row.semanticAction ?? 'generic_run',
      evidenceRole: row.evidenceRole ?? 'effect', resolvedTarget: row.resolvedTarget ?? {},
      observedState: row.observedState, parseStatus: row.parseStatus ?? 'adapter_unavailable',
      reasonCode: row.reasonCode ?? (row.parseStatus ? undefined : 'adapter_unavailable'),
      adapterId: row.adapterId, adapterVersion: row.adapterVersion,
    })
    const stripped: GuardEvidence = { ...evidence }
    delete stripped.processFacts
    expect(evidenceSha256Digest([factOf(stripped)])).toBe(evidenceSha256Digest([factOf(evidence)]))
  })

  it('the certificate domain is unchanged by the derived layers', () => {
    const { projection } = replay(['运行 pnpm test'], [{ command: 'pnpm test', text: 'ok' }], 'posix')
    const item = itemFor(projection, 'test')
    const evidence = shellEvidence(projection)
    const clean: GuardProjection = createProjection()
    clean.enabled = true
    clean.epoch = projection.epoch
    clean.contractRevision = projection.contractRevision
    clean.items.set(item.id, item)
    const withoutDerived: GuardEvidence = { ...evidence }
    delete withoutDerived.processFacts
    clean.evidence.set(evidence.id, withoutDerived)
    const withDerived = createProjection()
    withDerived.enabled = true
    withDerived.epoch = projection.epoch
    withDerived.contractRevision = projection.contractRevision
    withDerived.items.set(item.id, item)
    withDerived.evidence.set(evidence.id, evidence)
    // `itemDiagnosis` is the compact legacy view; `deriveItemDiagnosis` is the
    // unified one. Both must agree before and after the derived layer.
    expect(itemDiagnosis(withDerived, item)).toEqual(itemDiagnosis(clean, item))
  })
})
