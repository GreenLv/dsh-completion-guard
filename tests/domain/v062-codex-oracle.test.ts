import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { deriveItemDiagnosis, evidenceAvailabilityReason } from '../../src/domain/diagnostics.js'
import { decideTurnBoundary } from '../../src/domain/stop-policy.js'
import { createCheckpointTool } from '../../src/tools/checkpoint.js'
import { partialFailureOf } from '../../src/domain/capability-semantics.js'
import { createProjection } from '../../src/domain/types.js'
import { captureClause } from '../../src/domain/capture.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from '../../src/domain/host-lock.js'
import type { DerivedEnvelope, GuardEvidence } from '../../src/domain/types.js'

/**
 * 0.6.2 D062-04 (plan T01/T04/T05): the result-contract comparison against the
 * audited Codex Context Guard, described in
 * `docs/CROSS_END_RESULT_CONTRACT.md`.
 *
 * WHAT IS REAL HERE
 *
 * - The Codex side is NOT a hand-written constant. It is read from
 *   `tests/fixtures/cross-end/codex-0.13.9.facts.json`, which
 *   `scripts/record_cross_end_oracle.py` produced by EXECUTING the installed
 *   module's real `clause_metadata` / `verification_contract` entry points on
 *   the same synthetic inputs used below. Re-running that script against the
 *   same module reproduces the file byte for byte, and the recorded
 *   `moduleSha256` binds the recording to exactly one module.
 * - The DSH side is executed here through the real derivation, the real
 *   registered tools, and the real stop decision.
 *
 * WHAT IS NOT CLAIMED
 *
 * - This is a function-level comparison, never a native Codex task acceptance.
 * - Identifier parity is not required and not asserted; the compared contract is
 *   fact strength, and the two ends' reason vocabularies are deliberately
 *   different.
 * - The DSH side uses the plan's version-pinned local regression because no
 *   upstream fixture for this family exists yet; no mirror and no pin moved.
 */

interface RecordedCase {
  id: string
  text: string
  contract_mode: string
  contract_reason: string
  obligations: number
  clause_operations: Array<string | null>
}

interface RecordedFacts {
  recordingVersion: string
  product: string
  productVersion: string
  moduleSha256: string
  executedHere: string[]
  readOnly: string[]
  cases: RecordedCase[]
}

const recorded = JSON.parse(
  readFileSync(new URL('../fixtures/cross-end/codex-0.13.9.facts.json', import.meta.url), 'utf8'),
) as RecordedFacts

interface RecordedBehaviourCase {
  id: string
  entry: string
  status: 'executed' | 'not_executed' | 'absent'
  result?: unknown
  error?: string
  note: string
}

interface RecordedBehaviour {
  recordingVersion: string
  productVersion: string
  moduleSha256: string
  stateConstruction: string
  cases: RecordedBehaviourCase[]
}

const behaviour = JSON.parse(
  readFileSync(new URL('../fixtures/cross-end/codex-0.13.9.behaviour.json', import.meta.url), 'utf8'),
) as RecordedBehaviour

const behaviourCase = (id: string): RecordedBehaviourCase => {
  const found = behaviour.cases.find((entry) => entry.id === id)
  expect(found, `recorded Codex behaviour case ${id}`).toBeDefined()
  return found!
}

const codexCase = (id: string): RecordedCase => {
  const found = recorded.cases.find((entry) => entry.id === id)
  expect(found, `recorded Codex case ${id}`).toBeDefined()
  return found!
}

const scope = { cwd: '/repo', sessionHeader: { version: 3, id: 'v062-oracle', createdAt: 1 } }
const auditedLock = (platform: 'posix' | 'windows') => evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform })

let seq = 0
const reset = () => { seq = 0 }
const env = (type: string, data: unknown): DerivedEnvelope => ({ seq: seq++, type, data })
const notice = () => env('user/message', {
  source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' },
  content: [{ type: 'text', text: PROTOCOL_V5_NOTICE }],
})

interface ShellRun { command: string; text?: string }

function session(texts: string[], runs: ShellRun[] = [], platform: 'posix' | 'windows' = 'posix'): DerivedEnvelope[] {
  reset()
  const tool = platform === 'windows' ? 'pwsh' : 'bash'
  const events: DerivedEnvelope[] = [notice(), env('turn/start', { turn: 1 })]
  for (const text of texts) {
    events.push(env('user/message', { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  }
  for (const [index, run] of runs.entries()) {
    events.push(env('tool/call', { turn: 1, callId: `sh-${index}`, name: tool, arguments: JSON.stringify({ command: run.command, workdir: '/repo' }) }))
    events.push(env('tool/result', { turn: 1, message: { source: { callId: `sh-${index}` }, content: [{ type: 'tool-result', toolCallId: `sh-${index}`, isError: false, content: [{ type: 'text', text: run.text ?? 'ok' }] }] } }))
  }
  events.push(env('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  return events
}

const replay = (texts: string[], runs: ShellRun[] = [], platform: 'posix' | 'windows' = 'posix') =>
  deriveProjection(session(texts, runs, platform), { activation: 'always' as const }, scope, true, auditedLock(platform)).projection

describe('0.6.2 D062-04: cross-end comparison uses recorded real Codex entry-point results', () => {
  it('the Codex side is a measured recording bound to one module, not a hand-written constant', () => {
    expect(recorded.product).toBe('codex-context-guard')
    expect(recorded.recordingVersion).toBe('1')
    // The recording states which entry points were ACTUALLY executed and which
    // were only read, so the claim cannot silently widen.
    expect(recorded.executedHere).toEqual(['clause_metadata', 'verification_contract'])
    expect(recorded.readOnly).toEqual(expect.arrayContaining(['derive_ordinary_proofs', '_auto_complete_checkpoint', 'handle_stop']))
    expect(recorded.moduleSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(recorded.cases.length).toBeGreaterThanOrEqual(6)
    // Every recorded case carries what the entry point actually returned.
    for (const entry of recorded.cases) {
      expect(entry.contract_mode, entry.id).toBe('legacy_fallback')
      expect(entry.contract_reason, entry.id).toBe('no_deterministic_contract')
      expect(entry.obligations, entry.id).toBe(0)
    }
  })

  it('the result-behaviour recording is measured from the real proof/checkpoint/stop entry points', () => {
    expect(behaviour.productVersion).toBe(recorded.productVersion)
    expect(behaviour.moduleSha256).toBe(recorded.moduleSha256)
    expect(behaviour.stateConstruction).toContain('in-memory synthetic state')
    // Measured, not assumed: an enforced contract with no bound evidence derives
    // no proof, and the private-state checkpoint REFUSES completion.
    expect(behaviourCase('proofs-without-bound-evidence')).toMatchObject({ entry: 'derive_ordinary_proofs', status: 'executed', result: [] })
    expect(behaviourCase('checkpoint-without-unique-evidence')).toMatchObject({ entry: '_auto_complete_checkpoint', status: 'executed', result: null })
    // Measured hard-stop branch: an unusable private state refuses to certify.
    const hardStop = behaviourCase('stop-on-unusable-state')
    expect(hardStop.status).toBe('executed')
    expect(hardStop.result).toMatchObject({ continue: false })
    // And the honest gap: the correction/pending/wait path needs a durable
    // session ledger this probe never creates, so it is recorded as NOT
    // executed rather than claimed as compared.
    expect(behaviourCase('handle_stop')).toMatchObject({ status: 'not_executed' })
    expect(behaviourCase('handle_stop').note).toContain('durable authoritative prompt ledger')
  })

  it('case 1 — a cleanup instruction: neither end manufactures an obligation, a completion, or a user request', async () => {
    const codex = codexCase('cleanup-zh')
    expect(codex.obligations).toBe(0)
    const projection = replay([codex.text], [], 'windows')
    const item = [...projection.items.values()][0]!
    const diagnosis = deriveItemDiagnosis(projection, item)
    // DSH: a capability gap with a capability report — never a user-input gap
    // and never a request for a new instruction.
    expect(diagnosis.capability.gap).toBe('missing_adapter')
    expect(diagnosis.capability.remedy).toBe('report_uncertified_capability_gap')
    expect(diagnosis.capability.certifiable).toBe(false)
    expect(diagnosis.next_action.required_input).toBeUndefined()
    const checkpoint = createCheckpointTool(() => projection, () => {})
    const page = await checkpoint.execute({ bindings: [] }, undefined as never) as { status: string; certificate?: unknown; open_items: unknown[] }
    expect(page.status).toBe('incomplete')
    expect(page.certificate).toBeUndefined()
    expect(page.open_items).toHaveLength(1)
  })

  it('case 2 — an opaque compound runner: no per-operation verdict on either end', () => {
    const codex = codexCase('cleanup-en')
    expect(codex.obligations).toBe(0)
    const projection = replay(['清理工作树'], [
      { command: 'git worktree remove a; git worktree remove b; git worktree list', text: 'removed a\nremove of b failed\n' },
    ], 'windows')
    const evidence = [...projection.evidence.values()].find((row) => row.processFacts !== undefined)!
    expect(evidence.processFacts!.operationAttribution).toBe('unknown')
    expect(evidence.processFacts!.declaredExitCode).toBe('unknown')
    expect(evidence.processFacts!.declaredOperationResults).toBeUndefined()
    // The old tool-level success classification is preserved as exactly that,
    // and it is still not citable evidence for a concrete action.
    expect(evidence.outcome).toBe('success')
    expect(evidenceAvailabilityReason(evidence)).not.toBeUndefined()
  })

  it('case 3 — a read-only check: both ends derive no enforced change obligation', () => {
    // The RECORDED result for this family is also `legacy_fallback` with zero
    // obligations: Codex does not manufacture a change obligation from a plain
    // check clause either. The DSH end must not manufacture a change either —
    // it keeps a read-only verification whose only missing fact is evidence.
    const codex = codexCase('readonly-check')
    expect(codex.contract_mode).toBe('legacy_fallback')
    expect(codex.obligations).toBe(0)
    expect(codex.clause_operations).toEqual(['test_verify'])
    const projection = replay(['运行 pnpm test'], [{ command: 'pnpm test', text: 'ok' }], 'posix')
    const item = [...projection.items.values()][0]!
    const diagnosis = deriveItemDiagnosis(projection, item)
    expect(diagnosis.capability.gap).toBe('none')
    expect(diagnosis.capability.remedy).toBe('collect_evidence')
    expect(diagnosis.capability.certifiable).toBe(true)
    // No change-chain role is demanded of a read-only check.
    expect(diagnosis.missing_facets).toEqual([])
    expect(diagnosis.next_action.resume_condition).toContain('single matching durable verification fact')
  })

  it('case 4 — a prohibition: the constraint is recorded by both ends and certified by neither', () => {
    const codex = codexCase('prohibition-zh')
    expect(codex.obligations).toBe(0)
    const projection = replay([codex.text], [], 'posix')
    const item = [...projection.items.values()][0]!
    expect(item.kind).toBe('prohibition')
    const diagnosis = deriveItemDiagnosis(projection, item)
    expect(diagnosis.capability.gap).toBe('constraint')
    expect(diagnosis.capability.certifiable).toBe(false)
    expect(diagnosis.capability.remedy).toBe('none')
  })

  it('case 5 — a silent, uncertified end preserves pending work on the DSH side too', () => {
    const projection = replay([codexCase('cleanup-zh').text], [], 'windows')
    const decision = decideTurnBoundary(projection)
    expect(decision.action).toBe('stop')
    expect(decision.reason).toBe('safe_yield_pending_preserved')
    expect(projection.checkpoints).toHaveLength(0)
    expect([...projection.items.values()].filter((item) => item.status === 'pending')).toHaveLength(1)
  })

  it('a real caller-ownable choice is the only fact either end reports as missing input', () => {
    // DSH: a genuinely absent identity is a target gap with a supply_target
    // remedy. This is the only lane in the taxonomy that maps to user input.
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause('在仓库提交变更', 'm1', 'R001', 1, { cwd: '/repo' })
    expect(item.targetCaptureStatus).toBe('clarification_required')
    projection.items.set(item.id, item)
    const diagnosis = deriveItemDiagnosis(projection, item)
    expect(diagnosis.capability.gap).toBe('target_missing')
    expect(diagnosis.capability.remedy).toBe('supply_target')
    expect(diagnosis.next_action.kind).toBe('clarify_target')
    // Codex: a shape with no deterministic contract reports no user gap at all.
    for (const entry of recorded.cases) expect(entry.obligations).toBe(0)
  })

  it('mixed execution results: a declared partial failure blocks certification on the DSH side', async () => {
    // The Codex side of this family is measured above: no bound evidence means
    // no derived proof and no checkpoint. The DSH side must equally refuse when
    // the host declares that only part of the work succeeded.
    reset()
    const events: DerivedEnvelope[] = [
      notice(), env('turn/start', { turn: 1 }),
      env('user/message', { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: '运行 pnpm test' }] }),
      env('tool/call', { turn: 1, callId: 'sh-0', name: 'bash', arguments: JSON.stringify({ command: 'pnpm test', workdir: '/repo' }) }),
      env('tool/result', {
        turn: 1,
        meta: { contextGuardProcess: { operationResults: [{ action: 'test', outcome: 'success' }, { action: 'verify', outcome: 'failure' }] } },
        message: { source: { callId: 'sh-0' }, content: [{ type: 'tool-result', toolCallId: 'sh-0', isError: false, content: [{ type: 'text', text: 'ok' }] }] },
      }),
      env('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    const projection = deriveProjection(events, { activation: 'always' as const }, scope, true, auditedLock('posix')).projection
    const evidence = [...projection.evidence.values()][0]!
    expect(evidence.processFacts?.declaredOperationResults).toEqual([
      { action: 'test', outcome: 'success' }, { action: 'verify', outcome: 'failure' },
    ])
    expect(evidence.processFacts?.operationAttribution).toBe('declared_per_operation')
    expect(partialFailureOf(evidence.processFacts!)).toEqual({ failed: [{ action: 'verify', outcome: 'failure' }] })
    // The declared subset is a REPORTED fact. It is deliberately NOT promoted
    // into a citable evidence producer by this batch: doing so would let an
    // explicit per-operation declaration replace the audited producer chain,
    // which the plan forbids. Certification therefore still refuses, and the
    // partial failure stays visible with the work uncertified.
    const checkpoint = createCheckpointTool(() => projection, () => {})
    const page = await checkpoint.execute({ bindings: [] }, undefined as never) as { status: string; certificate?: unknown }
    expect(page.status).toBe('incomplete')
    expect(page.certificate).toBeUndefined()
  })

  it('an arbitrary successful tool call never becomes a completion on the DSH side', () => {
    const projection = replay(['运行 pnpm test'], [{ command: 'pnpm test', text: 'ok' }], 'posix')
    const evidence: GuardEvidence = [...projection.evidence.values()][0]!
    const item = [...projection.items.values()].find((candidate) => candidate.semanticAction === 'test')!
    const diagnosis = deriveItemDiagnosis(projection, item)
    expect(diagnosis.capability.certifiable).toBe(true)
    expect(diagnosis.next_action.kind).toBe('collect_evidence')
    expect(evidence.processFacts?.declaredExitCode).toBe('unknown')
  })

  it('the DSH end never emits Codex reason codes, and the comparison does not require them to match', () => {
    const projection = replay([codexCase('cleanup-zh').text], [], 'windows')
    const diagnosis = deriveItemDiagnosis(projection, [...projection.items.values()][0]!)
    // Codex's contract-level vocabulary is deliberately absent here: the
    // compared contract is fact strength, not identifier parity.
    expect(JSON.stringify(diagnosis)).not.toContain('legacy_fallback')
    expect(JSON.stringify(diagnosis)).not.toContain('no_deterministic_contract')
    expect(diagnosis.capability.gap).toBe('missing_adapter')
  })
})

interface LifecycleCase {
  id: string
  prompt: string
  reply: string
  run: { command: string; output: string; exit_code: number } | null
  promptVerified: boolean
  toolEvidenceCount: number
  proofCount: number
  checkpoint: null
  silent: boolean
  correction: boolean
  pending: number
  outcome: string
  reasonCodes: string[]
}
const lifecycle = JSON.parse(readFileSync(new URL('../fixtures/cross-end/codex-0.13.9.lifecycle.json', import.meta.url), 'utf8')) as {
  moduleSha256: string; cases: LifecycleCase[]
}
describe('D062-04 equivalent facts through isolated Codex lifecycle and DSH entrypoints', () => {
  it.each(lifecycle.cases)('$id keeps the same task and bounded completion evidence on both ends', async (row) => {
    expect(lifecycle.moduleSha256).toBe(recorded.moduleSha256)
    expect(row.promptVerified).toBe(true)
    expect(row.proofCount).toBe(0)
    expect(row.checkpoint).toBeNull()
    expect(row.pending).toBeGreaterThan(0)
    const p = replay([row.prompt], row.run ? [{ command: row.run.command, text: row.run.output }] : [], 'windows')
    expect([...p.items.values()].some(item => item.status === 'pending')).toBe(true)
    const page = await createCheckpointTool(() => p, () => {}).execute({ bindings: [], evidence_scope: 'history' }, undefined as never) as { status: string; certificate?: unknown }
    expect(page.status).toBe('incomplete')
    expect(page.certificate).toBeUndefined()
    if (row.id === 'correction') {
      // Codex corrects a false completion reply at Stop. DSH's explicit
      // checkpoint refuses it; the host entrypoints intentionally differ.
      expect(row.correction).toBe(true)
      expect(row.silent).toBe(false)
    } else {
      expect(row.silent).toBe(true)
      expect(row.correction).toBe(false)
      expect(decideTurnBoundary(p).action).toBe('stop')
    }
    if (row.id === 'user-wait') {
      expect(row.reasonCodes).toContain('protocol_waiting_boundary')
      expect([...p.items.values()].some(item => item.waitAuthorization?.kind === 'root_explicit_wait')).toBe(true)
    }
    if (row.run) {
      expect(row.toolEvidenceCount).toBe(1)
      expect([...p.evidence.values()].find(e => e.processFacts)?.processFacts).toMatchObject({ operationAttribution: 'unknown' })
    }
  })
})
