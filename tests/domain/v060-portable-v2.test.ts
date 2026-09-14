import { describe, expect, it } from 'vitest'
import { evaluateV2Case, loadV2Fixture } from '../helpers/portable-conformance-v2.js'

const fixture = loadV2Fixture()

describe('0.6.0 v2 candidate fixture (host-neutral, production chains)', () => {
  it('runs every case through production derive/delivery/closure/goal without skips', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(12)
    for (const fixtureCase of fixture.cases) {
      const failures = evaluateV2Case(fixtureCase)
      expect(failures, fixtureCase.id).toEqual([])
    }
  })

  it('covers every P2 semantic family S01–S08 and records the P3 families', () => {
    const covered = new Set(fixture.cases.map((fixtureCase) => fixtureCase.family))
    for (const family of ['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08']) {
      expect(covered.has(family), `family ${family} has no candidate case`).toBe(true)
    }
    // Proof/release/migration families are P3 scope; the fixture records them
    // as planned rather than pretending they are covered.
    for (const family of ['S09', 'S10', 'S11', 'S12']) {
      expect(fixture.families?.[family], `family ${family} must be recorded`).toContain('P3')
    }
  })
})
