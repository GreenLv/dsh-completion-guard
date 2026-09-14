import { describe, expect, it } from 'vitest'
import {
  evaluateV2Case, loadV2Fixture, loadV2Schema, runV2Case, translateEvents, validateV2Fixture,
  type V2Case,
} from '../helpers/portable-conformance-v2.js'

const fixture = loadV2Fixture()

/** A deep copy so a negative case can corrupt only its own expectation. */
function copyOf(id: string): V2Case {
  const found = fixture.cases.find((entry) => entry.id === id)
  if (!found) throw new Error(`fixture case ${id} is missing`)
  return JSON.parse(JSON.stringify(found)) as V2Case
}

describe('0.6.0 v2 fixture: the frozen schema is validated, not assumed', () => {
  it('the candidate fixture conforms to context_guard_semantics_v2.schema.json', () => {
    expect(validateV2Fixture(fixture as unknown, loadV2Schema())).toEqual([])
  })

  it('the validator rejects each structural violation the schema actually constrains', () => {
    const schema = loadV2Schema()
    const mutations: Array<[string, (value: any) => void]> = [
      ['wrong fixture identity', (value) => { value.fixture = 'other_fixture' }],
      ['non-candidate fixtureVersion', (value) => { value.fixtureVersion = '1.0.0' }],
      ['unknown case id shape', (value) => { value.cases[0].id = 'case-one' }],
      ['unknown family', (value) => { value.cases[0].family = 'X99' }],
      ['unsupported boundary', (value) => { value.cases[0].boundary = 'v6' }],
      ['unsupported event type', (value) => { value.cases[0].events = [{ type: 'made_up' }] }],
      ['unexpected case property', (value) => { value.cases[0].extra = true }],
      ['unexpected expect property', (value) => { value.cases[0].expect.extra = true }],
      ['unknown interpreted value', (value) => { value.cases[0].expect.interpreted = 'maybe' }],
      ['unknown closure value', (value) => { value.cases[0].expect.closure = 'partial' }],
      ['negative delivery count', (value) => { value.cases[0].expect.delivery = { answered: -1 } }],
      ['missing delivery', (value) => { delete value.cases[0].expect.delivery }],
      ['empty case list', (value) => { value.cases = [] }],
    ]
    for (const [label, mutate] of mutations) {
      const value = JSON.parse(JSON.stringify(fixture)) as Record<string, unknown>
      mutate(value)
      expect(validateV2Fixture(value, schema).length, label).toBeGreaterThan(0)
    }
  })

  it('the validator refuses to silently ignore a keyword it does not implement', () => {
    const schema = { type: 'object', maxProperties: 3 }
    expect(() => validateV2Fixture({}, schema)).toThrow(/unsupported keyword/)
  })
})

describe('0.6.0 v2 fixture: the runner computes actuals, expectations only compare', () => {
  it('mutating only the expectation changes the failures, never the actual result', () => {
    for (const fixtureCase of fixture.cases) {
      const actual = runV2Case(fixtureCase)
      const corrupted = copyOf(fixtureCase.id)
      // Corrupt every declared field at once. The ACTUAL result must be
      // byte-identical to the real case's, because nothing in the runner may
      // read the expectation to decide a value.
      corrupted.expect.interpreted = actual.interpreted === 'unknown' ? 'interpreted' : 'unknown'
      corrupted.expect.closure = actual.closure === 'complete' ? 'open' : 'complete'
      corrupted.expect.open_items = [{ kind: 'acceptance', status: 'passed' }]
      corrupted.expect.delivery = actual.delivery === null ? { answered: 3, turn_bound: false } : null
      corrupted.expect.goal_denied = !actual.goal_denied
      corrupted.expect.correction = { allowed: !actual.correction_allowed }
      corrupted.expect.superseded = (actual.superseded + 1)
      corrupted.expect.trusted_selections = actual.trusted_selections + 1
      corrupted.expect.approvals = actual.approvals + 1
      corrupted.expect.reason_codes = ['definitely_not_a_reason_code']
      corrupted.expect.reason_classes = actual.reason_classes.length > 0 ? [] : ['policy_boundary']
      corrupted.expect.release_contracts = actual.release_contracts + 1
      corrupted.expect.release_in_flight = actual.release_in_flight + 1
      corrupted.expect.release_gate_denials = ['not_a_release_reason']
      corrupted.expect.migration = { rule_mode: 'legacy-v4', certificate_version: '9', unit_closure: !actual.migration.unit_closure }
      expect(runV2Case(corrupted), fixtureCase.id).toEqual(actual)
      expect(evaluateV2Case(corrupted).length, fixtureCase.id).toBeGreaterThan(0)
    }
  })

  it('the event translation is expectation-independent', () => {
    for (const fixtureCase of fixture.cases) {
      const corrupted = copyOf(fixtureCase.id)
      corrupted.expect.interpreted = 'unknown'
      corrupted.expect.closure = 'complete'
      corrupted.expect.delivery = null
      corrupted.expect.open_items = []
      expect(translateEvents(corrupted), fixtureCase.id).toEqual(translateEvents(fixtureCase))
    }
  })

  it('detects a wrong interpretation expectation', () => {
    const real = copyOf('S03-non-file-object-stays-generic')
    expect(runV2Case(real).interpreted).toBe('unknown')
    real.expect.interpreted = 'interpreted'
    expect(evaluateV2Case(real)).toContain('interpreted: unknown != interpreted')

    const inverse = copyOf('S03-document-update-bounded-modify')
    inverse.expect.interpreted = 'unknown'
    expect(evaluateV2Case(inverse)).toContain('interpreted: interpreted != unknown')
  })

  it('detects a wrong closure expectation', () => {
    const open = copyOf('S03-document-update-bounded-modify')
    expect(runV2Case(open).closure).toBe('open')
    open.expect.closure = 'complete'
    expect(evaluateV2Case(open)).toContain('closure: open != complete')

    const complete = copyOf('S01-delivered-question-closes')
    expect(runV2Case(complete).closure).toBe('complete')
    complete.expect.closure = 'open'
    expect(evaluateV2Case(complete)).toContain('closure: complete != open')

    const switched = copyOf('S07-independent-task-switches-unit')
    expect(runV2Case(switched).closure).toBe('switched')
    switched.expect.closure = 'open'
    expect(evaluateV2Case(switched)).toContain('closure: switched != open')
  })

  it('detects wrong delivery counts, a wrong delivery surface, and a wrong turn binding', () => {
    const closed = copyOf('S01-delivered-question-closes')
    expect(runV2Case(closed).delivery).toEqual({ answered: 1, turn_bound: true })
    closed.expect.delivery = { answered: 0 }
    expect(evaluateV2Case(closed)).toContain('delivery.answered: 1 != 0')
    const overstated = copyOf('S01-delivered-question-closes')
    overstated.expect.delivery = { answered: 5, turn_bound: true }
    expect(evaluateV2Case(overstated)).toContain('delivery.answered: 1 != 5')
    // A trusted delivery exists, so a declared turn_bound of false is a lie.
    const unbound = copyOf('S01-delivered-question-closes')
    unbound.expect.delivery = { answered: 1, turn_bound: false }
    expect(evaluateV2Case(unbound)).toContain('delivery.turn_bound: true != false')

    // An aborted turn produces a delivery SURFACE with no trusted delivery.
    const aborted = copyOf('S08-aborted-turn-never-delivers')
    expect(runV2Case(aborted).delivery).toEqual({ answered: 0, turn_bound: false })
    aborted.expect.delivery = { answered: 0, turn_bound: true }
    expect(evaluateV2Case(aborted)).toContain('delivery.turn_bound: false != true')

    // No turn surface at all is a null delivery; claiming answers is detected.
    const silent = copyOf('S03-document-update-bounded-modify')
    expect(runV2Case(silent).delivery).toBeNull()
    silent.expect.delivery = { answered: 1 }
    expect(evaluateV2Case(silent)).toContain('delivery.answered: 0 != 1')
  })

  it('detects wrong open items, reason codes, goal gate, and correction expectations', () => {
    const wrongItems = copyOf('S03-document-update-bounded-modify')
    wrongItems.expect.open_items = []
    expect(evaluateV2Case(wrongItems).some((failure) => failure.startsWith('open_items:'))).toBe(true)

    const wrongReason = copyOf('S04-future-push-stays-evidence-gated')
    wrongReason.expect.reason_codes = ['not_a_real_reason']
    expect(evaluateV2Case(wrongReason).some((failure) => failure.startsWith('reason_codes:'))).toBe(true)

    const wrongGoal = copyOf('S08-goal-complete-denied-without-certificate')
    expect(runV2Case(wrongGoal).goal_denied).toBe(true)
    wrongGoal.expect.goal_denied = false
    expect(evaluateV2Case(wrongGoal)).toContain('goal_denied: true != false')

    const wrongCorrection = copyOf('S04-conditional-wait-stays-pending')
    expect(runV2Case(wrongCorrection).correction_allowed).toBe(false)
    wrongCorrection.expect.correction = { allowed: true }
    expect(evaluateV2Case(wrongCorrection)).toContain('correction.allowed: false != true')

    const wrongSelection = copyOf('S06-trusted-directory-selection')
    wrongSelection.expect.trusted_selections = 3
    wrongSelection.expect.approvals = 4
    const failures = evaluateV2Case(wrongSelection)
    expect(failures).toContain('trusted_selections: 1 != 3')
    expect(failures).toContain('approvals: 1 != 4')

    const wrongSuperseded = copyOf('S07-verbatim-clarification-supersedes')
    wrongSuperseded.expect.superseded = 0
    expect(evaluateV2Case(wrongSuperseded)).toContain('superseded: 1 != 0')
  })

  it('detects wrong release, migration, and reason-class expectations', () => {
    const release = copyOf('S11-consumed-ticket-refuses-the-replay')
    expect(runV2Case(release)).toMatchObject({ release_contracts: 1, release_in_flight: 0, release_gate_denials: ['release_operation_consumed'] })
    release.expect.release_contracts = 0
    release.expect.release_in_flight = 2
    release.expect.release_gate_denials = ['release_contract_granted']
    const releaseFailures = evaluateV2Case(release)
    expect(releaseFailures).toContain('release_contracts: 1 != 0')
    expect(releaseFailures).toContain('release_in_flight: 0 != 2')
    expect(releaseFailures.some((failure) => failure.startsWith('release_gate_denials:'))).toBe(true)

    const inFlight = copyOf('S11-reserved-operation-is-never-resent')
    expect(runV2Case(inFlight).release_in_flight).toBe(1)
    inFlight.expect.release_in_flight = 0
    expect(evaluateV2Case(inFlight)).toContain('release_in_flight: 1 != 0')

    const migration = copyOf('S12-legacy-session-reports-its-own-rule-set')
    expect(runV2Case(migration).migration).toEqual({ rule_mode: 'legacy-v4', certificate_version: '1', unit_closure: false })
    migration.expect.migration = { rule_mode: 'v5', certificate_version: '2', unit_closure: true }
    const migrationFailures = evaluateV2Case(migration)
    expect(migrationFailures).toContain('migration.rule_mode: legacy-v4 != v5')
    expect(migrationFailures).toContain('migration.certificate_version: 1 != 2')
    expect(migrationFailures).toContain('migration.unit_closure: false != true')

    const classes = copyOf('S09-requested-visual-proof-cannot-be-faked')
    expect(runV2Case(classes).reason_classes).toEqual(['parameter_missing', 'source_insufficient'])
    classes.expect.reason_classes = ['integrity_failure']
    expect(evaluateV2Case(classes).some((failure) => failure.startsWith('reason_classes:'))).toBe(true)
  })
})

describe('0.6.0 v2 fixture: delegation is bounded, not a parent completion', () => {
  it('a delegated round-trip leaves the parent and child obligations open', () => {
    const delegated = copyOf('S08-delegation-opens-a-required-descendant-unit')
    const actual = runV2Case(delegated)
    expect(actual.delegations).toBe(1)
    expect(actual.descendant_units).toBe(1)
    expect(actual.open_items).toEqual([
      { kind: 'requirement', status: 'pending' },
      { kind: 'requirement', status: 'pending' },
    ])
    expect(actual.closure).toBe('open')
    expect(evaluateV2Case(delegated)).toEqual([])
    // Claiming the delegated work closed the parent is detected.
    const claimedClosed = copyOf('S08-delegation-opens-a-required-descendant-unit')
    claimedClosed.expect.open_items = [{ kind: 'requirement', status: 'pending' }]
    expect(evaluateV2Case(claimedClosed).some((failure) => failure.startsWith('open_items:'))).toBe(true)
  })
})
