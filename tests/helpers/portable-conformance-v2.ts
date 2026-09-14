import { readFileSync } from 'node:fs'
import { deriveProjection, PROTOCOL_V4_NOTICE, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { goalCompletionDenial } from '../../src/domain/goal-gate.js'
import { deriveItemDiagnosis } from '../../src/domain/diagnostics.js'
import { certificateClosure } from '../../src/domain/closure.js'
import { decideTurnBoundary } from '../../src/domain/stop-policy.js'
import { deriveTrustedDeliveries } from '../../src/domain/delivery.js'
import { unitDescendantIds } from '../../src/domain/work-unit.js'
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
  }
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

const CONFIG = { activation: 'always' as const, policy: 'standard' as const }
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
}

/**
 * Run one case through the production chains and report what ACTUALLY
 * happened. Nothing here consults `fixtureCase.expect`, so the same events
 * always produce the same actual result no matter what the fixture claims.
 */
export function runV2Case(fixtureCase: V2Case): V2Result {
  const events = translateEvents(fixtureCase)
  const { projection } = deriveProjection(events, CONFIG, SCOPE, true)
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
  // action could not be determined AND it is neither a constraint (a
  // prohibition is always understood as a ban) nor an inquiry (an information
  // slot is understood even when its verb is not). Anything else is
  // interpreted.
  const closureItemIds = new Set(closure.itemIds)
  const unresolvedPending = pending.some((item) => closureItemIds.has(item.id)
    && item.kind !== 'prohibition'
    && item.taskKind !== 'inquiry'
    && ((item.semanticAction ?? 'generic_run') === 'generic_run'
      || (item.legacyFlags?.includes('legacy_authority_unclassified') ?? false)))
  const denial = goalCompletionDenial(projection, 'update_goal', { goal_id: 'v2-goal', revision: 1, action: 'complete' })

  return {
    caseId: fixtureCase.id,
    family: fixtureCase.family,
    interpreted: unresolvedPending ? 'unknown' : 'interpreted',
    // `open_items` is the still-pending work; answered/superseded states are
    // verified through the delivery and superseded counters instead.
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
  return failures
}
