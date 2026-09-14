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

  it('covers every semantic family S01–S12 with production cases', () => {
    const covered = new Set(fixture.cases.map((fixtureCase) => fixtureCase.family))
    for (const family of ['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09', 'S10', 'S11', 'S12']) {
      expect(covered.has(family), `family ${family} has no candidate case`).toBe(true)
      expect(fixture.families?.[family], `family ${family} must be recorded`).toBeTruthy()
    }
  })

  it('declares its candidate identity rather than claiming a canonical mirror', () => {
    // The upstream has not landed a canonical v2 fixture, so this file is
    // explicitly a DSH-authored candidate. Cross-language parity and byte
    // mirroring stay open until the pin can name a real upstream commit.
    expect(fixture.fixture).toBe('context_guard_semantics_v2')
    expect(fixture.fixtureVersion).toMatch(/^2\.0\.0-candidate/)
    expect(fixture.status).toBe('dsh-candidate')
  })
})
