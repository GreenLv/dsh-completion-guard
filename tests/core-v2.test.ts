import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { projectCoreV2 } from '../src/core-v2/project.js'

type Case = { id: string; input: Record<string, unknown>; expected?: Record<string, unknown>; expected_error?: string }
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/conformance/core_v2/events.json', import.meta.url), 'utf8')) as { cases: Case[] }

describe('provisional upstream core v2 independent expectations', () => {
  for (const row of fixtures.cases) {
    it(row.id, () => {
      if (row.expected_error) { expect(() => projectCoreV2(row.input)).toThrow(row.expected_error); return }
      const result = projectCoreV2(row.input)
      const expected = row.expected!
      if ('actions' in expected) expect((result.current_actions as Array<{ action: string }>).map((a) => a.action)).toEqual(expected.actions)
      for (const key of ['certifiable','stop','explicit_user_persistence','resume_with_actionable_work','goal_complete_allowed','registered_external_operations','reason_codes','correction_count']) {
        if (key in expected) expect(result[key]).toEqual(expected[key])
      }
    })
  }
  it('orders non-BMP and private-use requirement IDs by UTF-8 bytes', () => {
    const base = structuredClone(fixtures.cases[0]!.input) as Record<string, unknown>
    const requirements = base.requirements as Array<Record<string, unknown>>
    requirements.splice(0, requirements.length,
      { ...requirements[0], id: '\uE000' },
      { ...requirements[0], id: '\u{10000}' })
    const result = projectCoreV2(base)
    expect(result.unmet_requirements).toEqual(['\uE000', '\u{10000}'])
  })
  it('rejects a selection target on a result and an unpaired call target kind', () => {
    const original = fixtures.cases.find((entry) => entry.id === 'required_test_ready')!.input
    const resultTarget = structuredClone(original) as Record<string, unknown>
    const result = (resultTarget.sources as Array<Record<string, unknown>>).find((source) => source.kind === 'host_result')!
    result.target = '/work'
    result.target_kind = 'opaque'
    expect(() => projectCoreV2(resultTarget)).toThrow('selection_target_requires_host_call')
    const unpaired = structuredClone(original) as Record<string, unknown>
    const call = (unpaired.sources as Array<Record<string, unknown>>).find((source) => source.kind === 'host_call')!
    delete call.target_kind
    expect(() => projectCoreV2(unpaired)).toThrow('selection_target_kind_pair_required')
    expect(() => projectCoreV2(original)).not.toThrow()
  })

  it.each(['继续。', 'Continue.'])('recognizes a bare current resume only while a real action is ready: %s', (text) => {
    const base = structuredClone(fixtures.cases.find((entry) => entry.id === 'required_test_ready')!.input) as Record<string, unknown>
    const digest = createHash('sha256').update(text).digest('hex')
    const length = Buffer.byteLength(text, 'utf8')
    const span = { source_id: 'resume-root', start: 0, end: length, sha256: digest }
    ;(base.sources as Array<Record<string, unknown>>).push({ id: 'resume-root', seq: 4, kind: 'root', unit: 'u', revision: 1,
      sha256: digest, byte_length: length, text, call_id: null, turn: 't' })
    ;(base.coverage as Array<Record<string, unknown>>).push({ source: span, kind: 'interpreted' })
    ;(base.requirements as Array<Record<string, unknown>>).push({ id: 'resume-control', unit: 'u', revision: 1, seq: 4,
      source: span, kind: 'unknown', action: 'resume_control', target: text, predicate: 'intent_observed',
      scope_sha256: digest, required: false, status: 'pending', parent_id: null, evidence_kind: 'none', condition_ids: [],
      target_origin: { root_constraint: text, root_constraint_source: span, implementation_choice: text,
        host_selection: text, resolved: text, observed: text, constraint_kind: 'exact', subject_kind: 'opaque', selection_source_id: null } })
    base.intent = { source: span, kind: 'resume' }
    base.as_of = 4
    const ready = projectCoreV2(base)
    expect(ready.resume_with_actionable_work).toBe(true)
    expect(ready.explicit_user_persistence).toBe(false)
    expect(ready.reason_codes).toContain('resume_with_actionable_work')
    const completed = structuredClone(base)
    completed.actions = []
    const noAction = projectCoreV2(completed)
    expect(noAction.resume_with_actionable_work).toBe(false)
    expect(noAction.explicit_user_persistence).toBe(false)
  })
})
