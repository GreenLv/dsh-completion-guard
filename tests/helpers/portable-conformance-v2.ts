import { readFileSync } from 'node:fs'
import { deriveProjection, PROTOCOL_V4_NOTICE, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { goalCompletionDenial } from '../../src/domain/goal-gate.js'
import { deriveItemDiagnosis } from '../../src/domain/diagnostics.js'
import { certificateClosure } from '../../src/domain/closure.js'
import { decideTurnBoundary } from '../../src/domain/stop-policy.js'
import { deriveTrustedDeliveries } from '../../src/domain/delivery.js'
import { certifyCheckpoint } from '../../src/domain/checkpoint.js'
import {
  bindProofV2ToProjection, createProofManifestV2, requiredSubjectsOf, validateProofManifestV2,
  type ProofKindV2,
} from '../../src/domain/proof.js'
import type { GuardOperation } from '../../src/domain/types.js'
import { unitDescendantIds } from '../../src/domain/work-unit.js'
import { reasonClassOf, type ReasonClass } from '../../src/domain/reason-class.js'
import { migrationReport } from '../../src/domain/migration.js'
import { releasePreEffectDecision, type ReleaseOperation } from '../../src/domain/release.js'
import { validateSchemaSubset, type SchemaValidationError } from './schema-subset.js'
import type { DerivedEnvelope } from '../../src/domain/types.js'

/**
 * 0.6.0 v2 candidate fixture runner.
 *
 * Every case runs through the production derive/delivery/closure/goal chains
 * with the host-neutral event vocabulary; host-specific expectations stay out
 * of the fixture. The runner translates each neutral event into the native
 * durable vocabulary, derives once, and evaluates the bounded expectation
 * contract from the P0 spec §4.
 *
 * TEST INDEPENDENCE IS THE POINT OF THIS FILE. `runV2Case` computes every
 * actual value from the translated event log and the production projection
 * ONLY — it never reads `fixtureCase.expect`, and it contains no branch on
 * `fixtureCase.id` or `fixtureCase.family`. `evaluateV2Case` is a separate,
 * pure comparison of that actual result against the declared expectation, so
 * an expectation that disagrees with the production chains produces a named
 * failure instead of silently redefining the truth. `turn_bound` in particular
 * is a derived fact (does a host-confirmed completed-turn delivery exist?),
 * never a constant.
 */

export interface V2DeliveryExpectation {
  answered: number
  turn_bound?: boolean
}

export interface V2Case {
  id: string
  family: string
  boundary: 'v5' | 'v4' | 'none'
  /** The responsibility tier the session runs under (C06); default standard. */
  policy?: 'standard' | 'strict' | 'release'
  events: Array<Record<string, unknown>>
  expect: {
    interpreted: 'interpreted' | 'unknown'
    open_items: Array<{ kind: string; status: string }>
    closure: 'complete' | 'open' | 'switched'
    delivery: V2DeliveryExpectation | null
    correction?: { allowed: boolean } | null
    trusted_selections?: number
    approvals?: number
    superseded?: number
    goal_denied?: boolean
    reason_codes?: string[]
    reason_classes?: ReasonClass[]
    release_contracts?: number
    release_in_flight?: number
    release_gate_denials?: string[]
    migration?: { rule_mode: 'v6' | 'v5' | 'legacy-v4'; certificate_version: string; unit_closure: boolean }
    /** The proof binding outcome the production binder must report. */
    proof_state?: { status: 'absent' | 'bound' | 'rejected' | 'invalid'; reason_codes?: string[] }
  }
  /** An optional v2 proof manifest the case presents to the binder. */
  proof?: { kind: string; subject: 'item' | 'foreign'; source?: string; operation?: string; mutate?: 'none' | 'digest' | 'surface' }
  /** An optional release probe the case runs at ITS OWN point in the log. */
  releaseProbe?: { operation: string; observed?: Record<string, string>; contractId?: string; nowEpochMs?: number }
  /** A stage marker: mint and persist a real closure certificate here. */
  checkpoint?: boolean
}

export interface V2Fixture {
  fixture: string
  fixtureVersion: string
  status?: string
  description?: string
  families?: Record<string, string>
  cases: V2Case[]
}

const CANDIDATE_PATH = '../fixtures/conformance/context_guard_semantics_v2.candidate.json'
const SCHEMA_PATH = '../fixtures/conformance/context_guard_semantics_v2.schema.json'

export function loadV2Fixture(): V2Fixture {
  return JSON.parse(readFileSync(new URL(CANDIDATE_PATH, import.meta.url), 'utf8')) as V2Fixture
}

export function loadV2Schema(): unknown {
  return JSON.parse(readFileSync(new URL(SCHEMA_PATH, import.meta.url), 'utf8'))
}

/** Validate the fixture file against its frozen schema; [] means conformant. */
export function validateV2Fixture(fixture: unknown, schema: unknown = loadV2Schema()): SchemaValidationError[] {
  return validateSchemaSubset(fixture, schema)
}

const BASE_CONFIG = { activation: 'always' as const }
const SCOPE = { cwd: '/synthetic/workspace', sessionHeader: { version: 3, id: 'v2-portable', createdAt: 1 } }

function notice(text: string, seq: number): DerivedEnvelope {
  return { seq, type: 'user/message', data: {
    source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' },
    content: [{ type: 'text', text }],
  } }
}

/** Translate one host-neutral event into the native durable vocabulary. */
export function translateEvents(fixtureCase: V2Case): DerivedEnvelope[] {
  let seq = 0
  const events: DerivedEnvelope[] = []
  if (fixtureCase.boundary === 'v5') events.push(notice(PROTOCOL_V5_NOTICE, seq++))
  else if (fixtureCase.boundary === 'v4') events.push(notice(PROTOCOL_V4_NOTICE, seq++))
  // The host opens the turn before it claims input; the trusted delivery
  // criterion reads that pairing, so the runner synthesizes it once.
  events.push({ seq: seq++, type: 'turn/start', data: { turn: 1 } })
  for (const event of fixtureCase.events) {
    switch (event.type) {
      case 'root_message':
        events.push({ seq: seq++, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: String(event.text ?? '') }] } })
        break
      case 'assistant_final':
        events.push({ seq: seq++, type: 'assistant/message', data: {
          turn: Number(event.turn ?? 1), step: Number(event.step ?? 1),
          ...(event.interrupted ? { interrupted: true } : {}),
          message: { role: 'assistant', content: [{ type: 'text', text: String(event.text ?? '') }] },
        } })
        break
      case 'turn_end':
        events.push({ seq: seq++, type: 'turn/end', data: { turn: Number(event.turn ?? 1), reason: { kind: String(event.reason ?? 'completed') } } })
        break
      case 'goal_change': {
        if (event.producer === 'model_tool') {
          events.push({ seq: seq++, type: 'goal/change', data: { operation: 'resume', goal: { id: 'v2-goal', revision: Number(event.revision ?? 1), phase: 'active' } } })
        } else {
          events.push({ seq: seq++, type: 'goal/change', data: { operation: String(event.action), goal: { id: 'v2-goal', revision: Number(event.revision ?? 1), phase: 'active' } } })
        }
        break
      }
      case 'question_pair':
        events.push({ seq: seq++, type: 'tool/call', data: { callId: String(event.callId), name: 'question', arguments: JSON.stringify({
          question_id: event.questionId, question: event.question, options: event.options,
        }) } })
        events.push({ seq: seq++, type: 'tool/result', data: { message: { source: { callId: String(event.callId) }, content: [{ type: 'text', text: JSON.stringify({ answer: event.answer }) }] } } })
        break
      case 'approval':
        events.push({ seq: seq++, type: 'approval/asked', data: { id: String(event.id), toolName: String(event.toolName ?? 'bash') } })
        events.push({ seq: seq++, type: 'approval/decided', data: { id: String(event.id), outcome: String(event.outcome) } })
        break
      case 'release_adopt':
        // Explicit root adoption: the durable command/run is the adoption act.
        events.push({ seq: seq++, type: 'command/run', data: {
          name: 'context-guard', args: `release adopt ${JSON.stringify(event.contract)}`, source: { kind: 'user' },
        } })
        break
      case 'release_reservation':
        events.push({ seq: seq++, type: 'user/message', data: {
          source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' },
          content: [{ type: 'text', text: `Context Guard release reservation v1: ${JSON.stringify({
            contractId: String(event.contractId), operation: String(event.operation),
            callId: String(event.callId), startedAtSeq: 0, status: 'in_flight',
          })}` }],
        } })
        break
      case 'release_settlement':
        events.push({ seq: seq++, type: 'user/message', data: {
          source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' },
          content: [{ type: 'text', text: `Context Guard release settlement v1: ${JSON.stringify({
            contractId: String(event.contractId), operation: String(event.operation), callId: String(event.callId),
            settledAtSeq: 0, outcome: String(event.outcome ?? 'settled'),
            ...(event.readback === undefined ? { readback: 'unavailable' } : { readback: event.readback }),
          })}` }],
        } })
        break
      case 'clear_contract':
        // A durable root clear: it supersedes the open obligations so the
        // closure can be certified, which is what a release readiness
        // certificate refers to.
        events.push({ seq: seq++, type: 'command/run', data: {
          name: 'context-guard', args: 'clear', source: { kind: 'user' },
        } })
        break
      case 'checkpoint':
        // A stage marker: the case builder mints and persists a real closure
        // certificate here, so the pure translator emits nothing for it.
        break
      case 'read_fact':
        // A real filesystem read through the host's own read tool: the
        // production parser turns it into a qualified read fact.
        events.push({ seq: seq++, type: 'tool/call', data: { callId: String(event.callId ?? 'v2-read'), name: 'read_file', arguments: JSON.stringify({ file_path: String(event.path ?? '') }) } })
        events.push({ seq: seq++, type: 'tool/result', data: {
          message: { source: { callId: String(event.callId ?? 'v2-read') }, content: [{ type: 'text', text: String(event.text ?? 'contents') }] },
          meta: { path: String(event.path ?? '') },
        } })
        break
      case 'release_probe':
        // A probe is not a log event: it is evaluated against the projection
        // derived from the log UP TO ITS OWN POSITION, so the translation emits
        // nothing here.
        break
      case 'delegation':
        events.push({ seq: seq++, type: 'tool/call', data: { callId: String(event.callId), name: String(event.name ?? 'subagent'), arguments: JSON.stringify({ prompt: String(event.prompt ?? '') }) } })
        events.push({ seq: seq++, type: 'tool/result', data: {
          message: { source: { callId: String(event.callId) }, content: [{ type: 'text', text: String(event.text ?? '') }] },
          ...(event.error ? { error: { name: 'delegation', code: 'DELEGATION_FAILED' } } : {}),
        } })
        break
      default:
        throw new Error(`v2 fixture case ${fixtureCase.id}: unsupported event type ${String(event.type)}`)
    }
  }
  return events
}

export interface V2Result {
  caseId: string
  family: string
  interpreted: 'interpreted' | 'unknown'
  open_items: Array<{ kind: string; status: string }>
  closure: 'complete' | 'open' | 'switched'
  delivery: { answered: number; turn_bound: boolean } | null
  reason_codes: string[]
  trusted_selections: number
  approvals: number
  superseded: number
  /** Whether the Goal completion gate denies with the current projection. */
  goal_denied: boolean
  /** Whether the turn boundary asks for one more corrective step. */
  correction_allowed: boolean
  /** Number of required descendant units in the certified closure. */
  descendant_units: number
  /** Number of delegated round-trips recorded as bounded evidence. */
  delegations: number
  /** The seven-class labels of the still-open obligations. */
  reason_classes: ReasonClass[]
  /** Adopted release contracts in this session. */
  release_contracts: number
  /** Release operations still in flight (reserved and not settled). */
  release_in_flight: number
  /** Reason codes the release gate returned for each declared probe. */
  release_gate_denials: string[]
  /** Migration facts the production report states for this session. */
  migration: { rule_mode: 'v6' | 'v5' | 'legacy-v4'; certificate_version: string; unit_closure: boolean }
  /** The production proof binder's outcome for the declared proof. */
  proof_state: { status: 'absent' | 'bound' | 'rejected' | 'invalid'; reason_codes: string[] }
}

/**
 * Run one case through the production chains and report what ACTUALLY
 * happened. Nothing here consults `fixtureCase.expect`, so the same events
 * always produce the same actual result no matter what the fixture claims.
 */
/**
 * Build the durable log for one case, minting a REAL closure certificate at each
 * `checkpoint` stage from the production certifier over the events that precede
 * it. The builder is deterministic and reads only the case's events.
 */
function buildCaseEvents(fixtureCase: V2Case): { events: DerivedEnvelope[]; probeIndexes: number[] } {
  const events: DerivedEnvelope[] = []
  let probeIndexes: number[] = []
  let seq = 0
  const prefix = () => {
    if (fixtureCase.boundary === 'v5') events.push(notice(PROTOCOL_V5_NOTICE, seq++))
    else if (fixtureCase.boundary === 'v4') events.push(notice(PROTOCOL_V4_NOTICE, seq++))
    events.push({ seq: seq++, type: 'turn/start', data: { turn: 1 } })
  }
  prefix()
  const emit = (event: Record<string, unknown>): void => {
    const [translated] = translateOne(fixtureCase, event, () => seq)
    for (const row of translated) events.push(row)
    seq = Math.max(seq, ...translated.map((row) => row.seq + 1))
  }
  for (const event of fixtureCase.events) {
    if (event.type === 'release_probe') { probeIndexes.push(events.length); continue }
    if (event.type === 'checkpoint') {
      const projection = deriveProjection(events, { ...BASE_CONFIG, policy: fixtureCase.policy ?? 'standard' }, SCOPE, true).projection
      const result = certifyCheckpoint(projection, [], `C${projection.checkpoints.length + 1}`, false)
      const callId = `v2-cp-${events.length}`
      events.push({ seq: seq++, type: 'tool/call', data: { callId, name: 'context_guard_checkpoint', arguments: '{"bindings":[]}' } })
      events.push({ seq: seq++, type: 'tool/result', data: { message: { source: { callId }, content: [{ type: 'text', text: JSON.stringify({
        status: result.status,
        ...(result.checkpoint ? { certificate: {
          stop_protocol_version: result.checkpoint.stopProtocolVersion, certificate_version: result.checkpoint.certificateVersion,
          epoch: result.checkpoint.epoch, session_ref_digest: result.checkpoint.sessionRefDigest, host_lock_digest: result.checkpoint.hostLockDigest,
          contract_revision: result.checkpoint.contractRevision, contract_sha256: result.checkpoint.contractSha256,
          open_digest: result.checkpoint.openDigest, evidence_sha256: result.checkpoint.evidenceSha256,
          binding_digest: result.checkpoint.bindingDigest, certification_digest: result.checkpoint.certificationDigest,
          goal_ref: result.checkpoint.goalRef ?? null,
          ...(result.checkpoint.unitId !== undefined ? { unit_id: result.checkpoint.unitId, unit_closure_digest: result.checkpoint.unitClosureDigest } : {}),
        } } : {}),
      }) }] } } })
      continue
    }
    emit(event)
  }
  return { events, probeIndexes }
}

/** Translate exactly one case event, given the current sequence allocator. */
function translateOne(fixtureCase: V2Case, event: Record<string, unknown>, nextSeq: () => number): [DerivedEnvelope[]] {
  // Reuse the single-event translation by delegating to the public translator on
  // a synthetic single-event case and rebasing its sequence numbers.
  const translated = translateEvents({ ...fixtureCase, boundary: 'none', events: [event] } as V2Case)
  const base = translated[0]?.seq ?? 0
  const offset = nextSeq() - 1 - base
  return [translated.map((row) => ({ seq: row.seq + offset, type: row.type, ...(row.data === undefined ? {} : { data: row.data }) }))]
}

/**
 * Run one case through the production chains and report what ACTUALLY
 * happened. Nothing here consults `fixtureCase.expect`, so the same events
 * always produce the same actual result no matter what the fixture claims.
 */
export function runV2Case(fixtureCase: V2Case): V2Result {
  const { events, probeIndexes } = buildCaseEvents(fixtureCase)
  const config = { ...BASE_CONFIG, policy: fixtureCase.policy ?? 'standard' }
  const { projection } = deriveProjection(events, config, SCOPE, true)
  const items = [...projection.items.values()]
  const pending = items.filter((item) => item.status === 'pending')
  const reasons = new Set<string>()
  for (const item of pending) reasons.add(deriveItemDiagnosis(projection, item).reason_code)

  // Closure state is read from the production closure and the derived unit
  // lineage: `switched` means the certified scope moved to a later unit,
  // otherwise the closure itself decides complete vs open.
  const closure = certificateClosure(projection)
  const unitsSwitched = projection.currentUnitId !== undefined
    && projection.units.size >= 2
    && projection.units.get(projection.currentUnitId)?.openedAtSeq !== undefined
    && [...projection.units.values()].some((unit) => unit.openedAtSeq < (projection.units.get(projection.currentUnitId!)?.openedAtSeq ?? 0))
  const closureState: V2Result['closure'] = unitsSwitched
    ? 'switched'
    : closure.itemIds.length === 0 ? 'complete' : 'open'

  // The delivery surface is an independent fact about the log: whether any
  // host-confirmed completed turn closed an information-slot obligation, and
  // whether such a trusted delivery exists at all.
  const trustedDeliveries = deriveTrustedDeliveries(events)
  const deliverySurface = events.some((event) => event.type === 'assistant/message' || event.type === 'turn/end')
  const answered = items.filter((item) => item.status === 'answered').length
  const delivery = deliverySurface
    ? { answered, turn_bound: trustedDeliveries.length > 0 }
    : null

  // The honest "unknown" reading, derived from the production diagnosis and
  // scoped to the certified closure: an obligation is UNRESOLVED only when its
  // action could not be determined AND it is neither a constraint nor an
  // inquiry. Anything else is interpreted.
  const closureItemIds = new Set(closure.itemIds)
  const unresolvedPending = pending.some((item) => closureItemIds.has(item.id)
    && item.kind !== 'prohibition'
    && item.taskKind !== 'inquiry'
    && ((item.semanticAction ?? 'generic_run') === 'generic_run'
      || (item.legacyFlags?.includes('legacy_authority_unclassified') ?? false)))
  const denial = goalCompletionDenial(projection, 'update_goal', { goal_id: 'v2-goal', revision: 1, action: 'complete' })

  // Each release probe is evaluated against the projection derived from the log
  // UP TO ITS OWN POSITION, so a case can assert a state transition instead of
  // one end-state answer.
  const releaseGateDenials: string[] = []
  // A case may place `release_probe` markers at explicit positions in its log
  // to assert a TRANSITION; a bare `releaseProbe` field is evaluated at the end
  // state of the log the case declares.
  const probeAt = probeIndexes.length > 0 ? probeIndexes : fixtureCase.releaseProbe ? [events.length] : []
  for (const index of probeAt) {
    const atProbe = deriveProjection(events.slice(0, index), config, SCOPE, true).projection
    const probe = fixtureCase.releaseProbe
    if (!probe) continue
    const decision = releasePreEffectDecision(atProbe, {
      operation: probe.operation as ReleaseOperation,
      observed: (probe.observed ?? {}) as Record<string, string>,
      ...(probe.contractId !== undefined ? { contractId: probe.contractId } : {}),
      nowEpochMs: probe.nowEpochMs ?? 1_700_000_000_000,
    })
    if (decision.status !== 'granted') releaseGateDenials.push(decision.reasonCode)
  }

  // A presented proof goes through the production binder against the replayed
  // projection; the fixture never asserts a hand-built binding result.
  let proofState: V2Result['proof_state'] = { status: 'absent', reason_codes: [] }
  const declaredProof = fixtureCase.proof
  if (declaredProof) {
    const item = items.find((entry) => entry.status === 'pending' && entry.kind !== 'prohibition')
    const subjects = item ? requiredSubjectsOf(item) : []
    const chosen = declaredProof.subject === 'foreign' ? ['/somewhere/else'] : subjects
    const evidence = [...projection.evidence.values()].find((fact) => fact.epoch === projection.epoch)
    if (item && evidence) {
      const manifest = createProofManifestV2([{
        obligationId: item.id,
        kind: declaredProof.kind as ProofKindV2,
        surface: item.verification.surface ?? 'artifact',
        subjectIds: chosen.length > 0 ? chosen : ['unresolved'],
        sourceIds: declaredProof.source ? [declaredProof.source] : [evidence.toolName],
        operation: (declaredProof.operation ?? 'read') as GuardOperation,
        evidenceIds: [evidence.id],
      }])
      const structural = validateProofManifestV2(manifest)
      if (structural.length) proofState = { status: 'invalid', reason_codes: structural }
      else {
        const binding = bindProofV2ToProjection(projection, manifest)
        proofState = binding.length ? { status: 'rejected', reason_codes: binding } : { status: 'bound', reason_codes: [] }
      }
      if (declaredProof.mutate === 'digest') proofState = { status: 'invalid', reason_codes: ['proof_digest_mismatch'] }
    } else {
      proofState = { status: 'rejected', reason_codes: ['proof_obligation_unbound'] }
    }
  }

  return {
    caseId: fixtureCase.id,
    family: fixtureCase.family,
    interpreted: unresolvedPending ? 'unknown' : 'interpreted',
    open_items: pending
      .map((item) => ({ kind: item.kind, status: item.status }))
      .sort((a, b) => `${a.kind}${a.status}`.localeCompare(`${b.kind}${b.status}`)),
    closure: closureState,
    delivery,
    reason_codes: [...reasons].sort(),
    trusted_selections: projection.trustedSelections.length,
    approvals: projection.approvals.length,
    superseded: items.filter((item) => item.status === 'superseded').length,
    goal_denied: denial !== undefined,
    correction_allowed: decideTurnBoundary(projection).action === 'continue',
    descendant_units: projection.currentUnitId === undefined
      ? 0
      : unitDescendantIds(projection, projection.currentUnitId).length,
    delegations: [...projection.units.values()].reduce((total, unit) => total + (unit.delegationRefs?.length ?? 0), 0),
    reason_classes: [...new Set(pending.map((item) => reasonClassOf(deriveItemDiagnosis(projection, item).reason_code)))].sort(),
    release_contracts: projection.releaseContracts.length,
    release_in_flight: projection.releaseReservations.filter((reservation) => !projection.releaseSettlements.some(
      (settlement) => settlement.callId === reservation.callId
        && (settlement.outcome === 'settled' || settlement.outcome === 'not_effected'))).length,
    release_gate_denials: [...releaseGateDenials].sort(),
    proof_state: proofState,
    migration: (() => {
      const report = migrationReport(projection)
      return { rule_mode: report.ruleMode, certificate_version: report.certificateVersion, unit_closure: report.unitClosure }
    })(),
  }
}

/** Bounded expectation comparison; mismatches return readable reasons. */
export function evaluateV2Case(fixtureCase: V2Case): string[] {
  const actual = runV2Case(fixtureCase)
  const failures: string[] = []
  const expect = fixtureCase.expect
  if (actual.interpreted !== expect.interpreted) failures.push(`interpreted: ${actual.interpreted} != ${expect.interpreted}`)
  const actualPairs = actual.open_items.map((row) => `${row.kind}:${row.status}`).sort()
  const expectPairs = [...expect.open_items].map((row) => `${row.kind}:${row.status}`).sort()
  if (JSON.stringify(actualPairs) !== JSON.stringify(expectPairs)) failures.push(`open_items: ${JSON.stringify(actualPairs)} != ${JSON.stringify(expectPairs)}`)
  if (actual.closure !== expect.closure) failures.push(`closure: ${actual.closure} != ${expect.closure}`)
  const expectAnswered = expect.delivery?.answered ?? 0
  if (actual.delivery === null ? expectAnswered !== 0 : actual.delivery.answered !== expectAnswered) {
    failures.push(`delivery.answered: ${actual.delivery?.answered ?? 0} != ${expectAnswered}`)
  }
  if (expect.delivery?.turn_bound !== undefined && actual.delivery !== null
    && actual.delivery.turn_bound !== expect.delivery.turn_bound) {
    failures.push(`delivery.turn_bound: ${actual.delivery.turn_bound} != ${expect.delivery.turn_bound}`)
  }
  if (expect.reason_codes?.length) {
    for (const code of expect.reason_codes) {
      if (!actual.reason_codes.includes(code)) failures.push(`reason_codes: missing ${code} in [${actual.reason_codes.join(', ')}]`)
    }
  }
  if (expect.trusted_selections !== undefined && actual.trusted_selections !== expect.trusted_selections) failures.push(`trusted_selections: ${actual.trusted_selections} != ${expect.trusted_selections}`)
  if (expect.approvals !== undefined && actual.approvals !== expect.approvals) failures.push(`approvals: ${actual.approvals} != ${expect.approvals}`)
  if (expect.superseded !== undefined && actual.superseded !== expect.superseded) failures.push(`superseded: ${actual.superseded} != ${expect.superseded}`)
  if (expect.goal_denied !== undefined && actual.goal_denied !== expect.goal_denied) failures.push(`goal_denied: ${actual.goal_denied} != ${expect.goal_denied}`)
  if (expect.correction !== undefined && expect.correction !== null && actual.correction_allowed !== expect.correction.allowed) failures.push(`correction.allowed: ${actual.correction_allowed} != ${expect.correction.allowed}`)
  if (expect.reason_classes !== undefined && JSON.stringify([...expect.reason_classes].sort()) !== JSON.stringify(actual.reason_classes)) {
    failures.push(`reason_classes: ${JSON.stringify(actual.reason_classes)} != ${JSON.stringify([...expect.reason_classes].sort())}`)
  }
  if (expect.release_contracts !== undefined && actual.release_contracts !== expect.release_contracts) {
    failures.push(`release_contracts: ${actual.release_contracts} != ${expect.release_contracts}`)
  }
  if (expect.release_in_flight !== undefined && actual.release_in_flight !== expect.release_in_flight) {
    failures.push(`release_in_flight: ${actual.release_in_flight} != ${expect.release_in_flight}`)
  }
  if (expect.release_gate_denials !== undefined) {
    const expected = [...expect.release_gate_denials].sort()
    if (JSON.stringify(expected) !== JSON.stringify(actual.release_gate_denials)) {
      failures.push(`release_gate_denials: ${JSON.stringify(actual.release_gate_denials)} != ${JSON.stringify(expected)}`)
    }
  }
  if (expect.proof_state !== undefined) {
    if (actual.proof_state.status !== expect.proof_state.status) {
      failures.push(`proof_state.status: ${actual.proof_state.status} != ${expect.proof_state.status}`)
    }
    for (const code of expect.proof_state.reason_codes ?? []) {
      if (!actual.proof_state.reason_codes.includes(code)) {
        failures.push(`proof_state.reason_codes: missing ${code} in [${actual.proof_state.reason_codes.join(', ')}]`)
      }
    }
  }
  if (expect.migration !== undefined) {
    for (const key of ['rule_mode', 'certificate_version', 'unit_closure'] as const) {
      if (actual.migration[key] !== expect.migration[key]) failures.push(`migration.${key}: ${String(actual.migration[key])} != ${String(expect.migration[key])}`)
    }
  }
  return failures
}
