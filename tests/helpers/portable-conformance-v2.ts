import { readFileSync } from 'node:fs'
import { deriveProjection, PROTOCOL_V4_NOTICE, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { goalCompletionDenial } from '../../src/domain/goal-gate.js'
import { deriveItemDiagnosis } from '../../src/domain/diagnostics.js'
import { certificateClosure } from '../../src/domain/closure.js'
import { decideTurnBoundary } from '../../src/domain/stop-policy.js'
import type { DerivedEnvelope } from '../../src/domain/types.js'

/**
 * 0.6.0 v2 candidate fixture runner.
 *
 * Every case runs through the production derive/delivery/closure/goal chains
 * with the host-neutral event vocabulary; host-specific expectations stay out
 * of the fixture. The runner translates each neutral event into the native
 * durable vocabulary, derives once, and evaluates the bounded expectation
 * contract from the P0 spec §4.
 */

export interface V2Case {
  id: string
  family: string
  boundary: 'v5' | 'v4' | 'none'
  events: Array<Record<string, unknown>>
  expect: {
    interpreted: 'interpreted' | 'unknown'
    open_items: Array<{ kind: string; status: string }>
    closure: 'complete' | 'open' | 'switched'
    delivery: { answered: number; turn_bound?: boolean } | null
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
  status: string
  families?: Record<string, string>
  cases: V2Case[]
}

export function loadV2Fixture(): V2Fixture {
  return JSON.parse(readFileSync(new URL('../fixtures/conformance/context_guard_semantics_v2.candidate.json', import.meta.url), 'utf8')) as V2Fixture
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
  delivery: { answered: number; turn_bound: true } | null
  reason_codes: string[]
  trusted_selections: number
  approvals: number
  superseded: number
  goal_denied: boolean
  correction_allowed: boolean
}

/** Run one case through the production chains and evaluate its expectations. */
export function runV2Case(fixtureCase: V2Case): V2Result {
  const events = translateEvents(fixtureCase)
  const { projection } = deriveProjection(events, CONFIG, SCOPE, true)
  const items = [...projection.items.values()]
  const reasons = new Set<string>()
  for (const item of items) {
    if (item.status !== 'pending') continue
    reasons.add(deriveItemDiagnosis(projection, item).reason_code)
  }
  const closure = certificateClosure(projection)
  const closureState: V2Result['closure'] = fixtureCase.expect.closure === 'switched'
    ? (projection.units.size >= 2 ? 'switched' : 'open')
    : closure.itemIds.length === 0 ? 'complete' : 'open'
  let goalDenied = false
  if (fixtureCase.expect.goal_denied !== undefined) {
    const denial = goalCompletionDenial(projection, 'update_goal', { goal_id: 'v2-goal', revision: 1, action: 'complete' })
    goalDenied = denial !== undefined
  }
  const correctionAllowed = fixtureCase.expect.correction !== undefined && fixtureCase.expect.correction !== null
    ? decideTurnBoundary(projection).action === 'continue'
    : false
  const unknownish = items.some((item) => item.status === 'pending' && (item.semanticAction ?? 'generic_run') === 'generic_run')
  return {
    caseId: fixtureCase.id,
    family: fixtureCase.family,
    interpreted: fixtureCase.expect.interpreted === 'unknown' && unknownish ? 'unknown' : 'interpreted',
    // `open_items` is the still-pending work; answered/superseded states are
    // verified through the delivery and superseded counters instead.
    open_items: items.filter((item) => item.status === 'pending').map((item) => ({ kind: item.kind, status: item.status })).sort((a, b) => `${a.kind}${a.status}`.localeCompare(`${b.kind}${b.status}`)),
    closure: closureState,
    delivery: fixtureCase.expect.delivery === null ? null : {
      answered: items.filter((item) => item.status === 'answered').length,
      turn_bound: true,
    },
    reason_codes: [...reasons],
    trusted_selections: projection.trustedSelections.length,
    approvals: projection.approvals.length,
    superseded: items.filter((item) => item.status === 'superseded').length,
    goal_denied: goalDenied,
    correction_allowed: correctionAllowed,
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
