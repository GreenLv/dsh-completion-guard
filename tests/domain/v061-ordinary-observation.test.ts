import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { deriveItemDiagnosis } from '../../src/domain/diagnostics.js'
import { certifyCheckpoint } from '../../src/domain/checkpoint.js'
import { firstStepGuidance, previewFirstStepInjection } from '../../src/domain/lifecycle.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES, type HostLockEvaluation } from '../../src/domain/host-lock.js'
import type { DerivedEnvelope } from '../../src/domain/types.js'
/**
 * 0.6.1 W060-05 (plan V04/V05): ordinary shell observations are honest facts
 * distinct from attributed execution.
 *
 * The verdict is about the GUARD'S KNOWLEDGE, never about execution: a
 * successful shell command that failed closed parsing leaves it
 * unknowable whether the action was performed
 * (`execution_unattributable` — check state read-only, do not repeat, do not
 * deny). The only signal is the command's own head-anchored action — the
 * guard never scans compound text for actions, because quoted data and
 * short-circuit control flow would fabricate observations (review repro:
 * `printf '%s' '; git commit -F msg; git push origin main;'; true` must not
 * flag anything).
 */

const scope = { cwd: '/repo', sessionHeader: { version: 3, id: 'v061-observation', createdAt: 1 } }
const auditedLock = (platform: 'posix' | 'windows'): HostLockEvaluation =>
  evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform })

let seq = 0
const reset = () => { seq = 0 }
const env = (type: string, data: unknown): DerivedEnvelope => ({ seq: seq++, type, data })
const notice = () => env('user/message', {
  source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' },
  content: [{ type: 'text', text: PROTOCOL_V5_NOTICE }],
})

function session(rootInputs: string[], runs: Array<{ command: string; outcome: 'success' | 'failure' }>, platform: 'posix' | 'windows'): DerivedEnvelope[] {
  reset()
  const tool = platform === 'windows' ? 'pwsh' : 'bash'
  const events: DerivedEnvelope[] = [notice(), env('turn/start', { turn: 1 })]
  for (const text of rootInputs) {
    events.push(env('user/message', { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  }
  for (const [index, run] of runs.entries()) {
    events.push(
      env('tool/call', { turn: 1, callId: `sh-${index}`, name: tool, arguments: JSON.stringify({ command: run.command, workdir: '/repo' }) }),
      env('tool/result', { turn: 1, message: { source: { callId: `sh-${index}` }, content: [{ type: 'text', text: run.outcome === 'success' ? 'ok' : '[exit code: 1]' }] } }),
    )
  }
  events.push(env('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  return events
}

const diagnosisOf = (projection: ReturnType<typeof deriveProjection>['projection'], action: string) => {
  const item = [...projection.items.values()].find((candidate) => candidate.semanticAction === action)
  expect(item, action).toBeDefined()
  return deriveItemDiagnosis(projection, item!)
}

describe('0.6.1 W060-05: unattributable commands stay unknown — no fabrication, no redo', () => {
  it('a pwsh compound headed by git commit leaves the commit obligation execution_unattributable', () => {
    const { projection } = deriveProjection(
      session(['提交并推送变更'], [{ command: 'git commit -F message.txt; git push origin main', outcome: 'success' }], 'windows'),
      { activation: 'always' as const }, scope, true, auditedLock('windows'),
    )
    const diagnosis = diagnosisOf(projection, 'commit')
    expect(diagnosis.reason_code).toBe('execution_unattributable')
    expect(diagnosis.reason_class).toBe('historical_gap')
    const text = diagnosis.next_action.resume_condition!
    expect(text).toContain('cannot be established')
    expect(text).toContain('read-only command first')
    expect(text).toContain('never repeat an action')
    expect(text).toContain('do not assert it never ran')
  })

  it('quoted action text is data, never an observation (review repro)', () => {
    const { projection } = deriveProjection(
      session(['提交并推送变更'], [{ command: `printf '%s' '; git commit -F msg; git push origin main;'; true`, outcome: 'success' }], 'windows'),
      { activation: 'always' as const }, scope, true, auditedLock('windows'),
    )
    // The command head is printf: the guard has NO action signal and must not
    // manufacture one from quoted data.
    expect(diagnosisOf(projection, 'commit').reason_code).toBe('missing_evidence')
    expect(diagnosisOf(projection, 'push').reason_code).toBe('missing_evidence')
  })

  it('a read-only git inspection never fabricates an unattributed execution', () => {
    const { projection } = deriveProjection(
      session(['提交变更'], [
        { command: 'git status', outcome: 'success' },
        { command: 'git log --oneline -5', outcome: 'success' },
      ], 'posix'),
      { activation: 'always' as const }, scope, true, auditedLock('posix'),
    )
    const diagnosis = diagnosisOf(projection, 'commit')
    expect(diagnosis.reason_code).toBe('missing_evidence')
    expect(diagnosis.repairability).toBe('agent_repairable')
  })

  it('a parsed single test run is attributable evidence, not an unattributed observation', () => {
    const { projection } = deriveProjection(
      session(['运行 pnpm test'], [{ command: 'pnpm test', outcome: 'success' }], 'posix'),
      { activation: 'always' as const }, scope, true, auditedLock('posix'),
    )
    const diagnosis = diagnosisOf(projection, 'test')
    expect(diagnosis.reason_code).toBe('missing_evidence')
    expect(diagnosis.missing_facets).toEqual([])
  })

  it('a failed compound command is not an observation of execution', () => {
    const { projection } = deriveProjection(
      session(['提交变更'], [{ command: 'git commit -F message.txt; git push origin main', outcome: 'failure' }], 'windows'),
      { activation: 'always' as const }, scope, true, auditedLock('windows'),
    )
    expect(diagnosisOf(projection, 'commit').reason_code).toBe('missing_evidence')
  })

  it('once an attributable producer fact exists, the normal evidence path resumes', () => {
    reset()
    const events = [
      notice(),
      env('turn/start', { turn: 1 }),
      env('user/message', { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: '提交变更' }] }),
      env('tool/call', { turn: 1, callId: 'sh-0', name: 'pwsh', arguments: JSON.stringify({ command: 'git commit -F message.txt; git push origin main', workdir: '/repo' }) }),
      env('tool/result', { turn: 1, message: { source: { callId: 'sh-0' }, content: [{ type: 'text', text: 'ok' }] } }),
      env('tool/call', { turn: 1, callId: 'prod-0', name: 'context_guard_evidence', arguments: JSON.stringify({ semantic_action: 'commit', evidence_role: 'resolution' }) }),
      env('tool/result', { turn: 1, meta: { contextGuard: {
        adapterId: 'context-guard.git.v1', adapterVersion: '1.0.0',
        semanticAction: 'commit', evidenceRole: 'resolution',
        resolvedTarget: { repository: '/repo', branch: 'main', change_set_digest: { k: 's', v: 'digest' }, pre_head_oid: { k: 's', v: `${'aa'.repeat(20)}` } },
      } }, message: { source: { callId: 'prod-0' }, content: [{ type: 'text', text: '{}' }] } }),
      env('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    const { projection } = deriveProjection(events, { activation: 'always' as const }, scope, true, auditedLock('windows'))
    const diagnosis = diagnosisOf(projection, 'commit')
    expect(diagnosis.reason_code).not.toBe('execution_unattributable')
    expect(diagnosis.missing_facets).not.toContain('resolution')
  })

  it('the unattributed observation still never certifies: the checkpoint refuses the binding', () => {
    const { projection } = deriveProjection(
      session(['提交变更'], [{ command: 'git commit -F message.txt; git push origin main', outcome: 'success' }], 'windows'),
      { activation: 'always' as const }, scope, true, auditedLock('windows'),
    )
    const commit = [...projection.items.values()].find((candidate) => candidate.semanticAction === 'commit')!
    const evidence = [...projection.evidence.values()][0]!
    const result = certifyCheckpoint(projection, [{
      itemId: commit.id,
      evidenceIds: [evidence.id],
      semanticAction: 'commit',
      requestedTarget: { repository: '/repo' },
      resolvedTarget: { repository: '/repo' },
      observedState: {},
      effectEvidenceId: evidence.id,
      expectedTransition: {
        predicateId: 'pred.commit.v1', version: 1, predParamsKind: 'inline',
        parameters: { pre_head_oid: { k: 's', v: 'x' }, change_set_digest: { k: 's', v: 'y' } },
      },
    }], 'C1', false)
    expect(result.status).toBe('incomplete')
  })
})

describe('0.6.1 W060-05: first-step guidance is conditional, never an unconditional Guard gate', () => {
  const input = {
    activation: 'always' as const,
    enabled: true,
    boundaryPresent: false,
    delegated: false,
  }

  it('the guidance demands prepare only for obligations that themselves require certified stateful work', () => {
    const { guidance } = previewFirstStepInjection(input, true)!
    expect(guidance).toBe(firstStepGuidance('standard'))
    expect(guidance).toContain('need no Guard approval')
    expect(guidance).not.toMatch(/before a stateful action/i)
    expect(guidance).toContain('When a requirement itself calls for a certified stateful action')
    expect(guidance).toContain('never repeat an already-completed action')
  })

  it('strict policy additionally names the user-requested proof obligations', () => {
    const guidance = firstStepGuidance('strict')
    expect(guidance).toContain('strict policy')
    expect(guidance).toContain('real readback fact')
  })
})
