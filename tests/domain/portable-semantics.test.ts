import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import * as boundary from '../../src/domain/boundary.js'
import * as checkpoint from '../../src/domain/checkpoint.js'
import * as derive from '../../src/domain/derive.js'
import * as goalGate from '../../src/domain/goal-gate.js'
import { STATEFUL_ACTIONS } from '../../src/domain/protocol-manifest.js'
import * as stopPolicy from '../../src/domain/stop-policy.js'
import {
  PORTABLE_PRODUCTION, runPortableCase, runStatefulProductionClosure, type PortableCase, type PortableProduction,
} from '../helpers/portable-conformance.js'

const fixture = JSON.parse(readFileSync(new URL('../fixtures/conformance/context_guard_semantics_v1.json', import.meta.url), 'utf8')) as { cases: PortableCase[] }

describe('portable Context Guard semantic fixture', () => {
  it('runs all 37 mirrored cases through production functions without skips', () => {
    expect(fixture.cases).toHaveLength(37)
    for (const testCase of fixture.cases) {
      const actual = runPortableCase(testCase)
      expect.soft(actual, testCase.id).toMatchObject({
        ...testCase.expect,
        reason_codes: expect.arrayContaining(testCase.expect.reason_codes),
        ...(testCase.expect.offendingEvidenceIds ? { offendingEvidenceIds: expect.arrayContaining(testCase.expect.offendingEvidenceIds) } : {}),
      })
    }
  })

  it('routes critical fixture categories through the real production API', () => {
    const production: PortableProduction = {
      deriveProjection: vi.fn(derive.deriveProjection),
      certifyCheckpoint: vi.fn(checkpoint.certifyCheckpoint),
      qualifyBoundary: vi.fn(boundary.qualifyBoundary),
      goalCompletionDenial: vi.fn(goalGate.goalCompletionDenial),
      decideTurnBoundary: vi.fn(stopPolicy.decideTurnBoundary),
      hasCurrentCertificate: vi.fn(goalGate.hasCurrentCertificate),
    }
    for (const id of [
      'state-pull-effect-with-readback-certifies',
      'boundary-user-wait-qualified',
      'goal-complete-without-certificate-denied',
      'stop-completion-prose-without-certificate',
    ]) runPortableCase(fixture.cases.find((entry) => entry.id === id)!, production)
    expect(production.deriveProjection).toHaveBeenCalled()
    expect(production.certifyCheckpoint).toHaveBeenCalled()
    expect(production.qualifyBoundary).toHaveBeenCalled()
    expect(production.goalCompletionDenial).toHaveBeenCalled()
    expect(production.decideTurnBoundary).toHaveBeenCalled()
    expect(production.hasCurrentCertificate).toHaveBeenCalled()
  })

  it.each(STATEFUL_ACTIONS)('%s uses distinct producer resolution/effect/state facts', (action) => {
    const result = runStatefulProductionClosure(action)
    expect(result.completed).toBe(true)
    expect(result.completion_allowed).toBe(true)
    expect(result.reason_codes).toContain('completion_with_valid_certificate')
  })

  it('uses root persistence authority once and ignores assistant wording', () => {
    const events = [
      { seq: 1, type: 'command/run', data: { name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 2, type: 'user/message', data: {
        source: { kind: 'user' }, content: [{ type: 'text', text: '持续推进，直到迁移脚本全部跑完为止。' }],
      } },
    ]
    const deriveOne = () => derive.deriveProjection(events, { activation: 'opt-in' }, { cwd: '/synthetic/workspace' }, true).projection
    const completionClaim = deriveOne()
    const negatedClaim = deriveOne()
    expect([...completionClaim.items.values()][0].persistenceAuthorization?.kind).toBe('root_explicit_persistence')
    expect(stopPolicy.decideTurnStopping(completionClaim, '任务已完成', 1, 3)).toEqual({ action: 'continue', reason: 'protocol_correction_steer' })
    expect(stopPolicy.decideTurnStopping(negatedClaim, '任务尚未完成', 1, 3)).toEqual({ action: 'continue', reason: 'protocol_correction_steer' })
    expect(stopPolicy.decideTurnStopping(completionClaim, '任意第二次文案', 2, 3)).toEqual({ action: 'stop', reason: 'safe_yield_pending_preserved' })
  })

  it('changes the stateful result when the production certifier is mutated', () => {
    const testCase = fixture.cases.find((entry) => entry.id === 'state-pull-effect-with-readback-certifies')!
    expect(runPortableCase(testCase).completed).toBe(true)
    const production: PortableProduction = {
      ...PORTABLE_PRODUCTION,
      certifyCheckpoint: vi.fn((projection) => ({
        status: 'incomplete' as const,
        contractRevision: projection.contractRevision,
        openItems: [...projection.items.keys()],
        rejectedBindings: [{ itemId: 'R001', reason: 'mutated production certifier', reasonCode: 'effect_only_insufficient_state_readback' }],
      })),
    }
    expect(runPortableCase(testCase, production).completed).toBe(false)
    expect(production.certifyCheckpoint).toHaveBeenCalled()
  })
})
