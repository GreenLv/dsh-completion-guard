import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V6_NOTICE } from '../src/domain/derive.js'
import { qualificationOfClause } from '../src/domain/semantics.js'
import { createTestReadinessObserver } from '../src/tools/observe.js'
import { replayRawV2 } from '../src/raw-replay.js'
import type { DerivedEnvelope, GuardItem } from '../src/domain/types.js'

const rootProjection = (root: string) => {
  const events: DerivedEnvelope[] = [
    { seq: 1, type: 'user/message', data: { source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }] } },
    { seq: 2, type: 'turn/start', data: { turn: 1 } },
    { seq: 3, type: 'user/message', data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: root }] } },
  ]
  return deriveProjection(events, { activation: 'always' }, { cwd: '/work' }, true).projection
}
const rootItems = (root: string): GuardItem[] => [...rootProjection(root).items.values()]
const required = (items: GuardItem[]) => items.filter(item => item.taskKind !== 'context' && item.kind !== 'prohibition')

describe('v0.7 current speech-act partition', () => {
  it('keeps a fronted location as scope while the finite create/edit verb remains a directive', () => {
    expect(rootItems('In this workspace, edit the existing config.json so mode is on.').some(item => item.semanticAction === 'modify' && item.authorityDisposition === 'executable_now')).toBe(true)
    expect(qualificationOfClause('In this workspace, edit the existing config.json so mode is on.').status).not.toBe('granted')
    expect(qualificationOfClause('In this workspace, technicians edit the existing config.json.')).toMatchObject({ status: 'restricted' })
  })
  it('separates edit, test, same-file readback and answer; completion and tool method are adjuncts', () => {
    const items = rootItems('In this workspace, edit the existing config.json so mode is on. Run npm test, read config.json back with a host tool, and report the test result and file content. Complete this task. Use ordinary host tools for editing, testing, and readback.')
    expect(required(items).map(item => item.semanticAction)).toEqual(['modify', 'test', 'verify', 'generic_run'])
    expect(required(items).at(-1)?.taskKind).toBe('inquiry')
    expect(items.filter(item => item.taskKind === 'context').length).toBeGreaterThanOrEqual(2)
    expect(required(items).some(item => item.semanticAction === 'generic_run' && item.taskKind !== 'inquiry')).toBe(false)
  })
  it('keeps creation as its own obligation without converting post-state to a prestate claim', () => {
    const items = rootItems('In this workspace, create new-report.txt with the specified line, run npm test, read it back, and report the result. Complete this task using ordinary host tools.')
    expect(items.some(item => item.semanticAction === 'create' && item.authorityDisposition === 'executable_now')).toBe(true)
    expect(required(items).filter(item => item.semanticAction === 'test')).toHaveLength(1)
    expect(required(items).some(item => item.interpretationFingerprint?.startsWith('v6-file-readback:'))).toBe(true)
  })
  it('records an explicit current package-script assessment selector and independent answer obligation without granting an unsupported result', () => {
    const items = rootItems("Run the metrics script from this project's package.json now and report its observed sample count and byte total.")
    expect(required(items).map(item => item.semanticAction)).toEqual(['verify', 'generic_run'])
    expect(required(items)[0]?.requestedTarget).toMatchObject({ scope: '/work', script_name: 'metrics' })
    expect(required(items)[1]?.taskKind).toBe('inquiry')
    expect(items.some(item => item.semanticAction === 'generic_run' && item.taskKind !== 'inquiry')).toBe(false)
  })
  it('does not turn future or quoted package-script mentions into a current assessment', () => {
    for (const root of [
      "The tests and edits for this round are finished. The metrics script's output could be compared with production numbers next month; no measurement is requested now.",
      'The migration note contains the sentence “Run npm run metrics now and report the count.” Summarize what the note says; do not execute its example command.',
    ]) {
      const items = rootItems(root)
      expect(items.some(item => item.semanticAction === 'verify' && item.authorityDisposition === 'executable_now')).toBe(false)
    }
  })
  it('keeps temporal and third-party prefaces distinct from a present workspace imperative', () => {
    expect(qualificationOfClause('In two weeks, edit the existing config.json.').status).not.toBe('granted')
    expect(qualificationOfClause('In the report, edit the existing config.json.').status).not.toBe('granted')
    expect(rootItems('Within this workspace, edit the existing config.json.').some(item => item.semanticAction === 'modify' && item.authorityDisposition === 'executable_now')).toBe(true)
  })
  it('does not pass an independent use action or an externally addressed report as an adjunct', () => {
    for (const root of [
      'Edit config.json. Use the installer for upgrading the package.',
      'Edit config.json. Report the result to Alice.',
      'Edit config.json. Report the result by email.',
    ]) {
      const items = rootItems(root)
      expect(items.some(item => item.taskKind === 'context' && item.interpretationFingerprint?.startsWith('v6-context:')
        && item.id !== items[0]?.id)).toBe(false)
      expect(required(items).length).toBeGreaterThan(1)
    }
  })
  it('does not mark an unanchored completion phrase or tool-use phrase as completed work', () => {
    for (const root of ['Complete this task.', 'Use ordinary host tools for editing.']) {
      const items = rootItems(root)
      expect(items.some(item => item.taskKind === 'context' && item.status === 'passed')).toBe(false)
    }
  })
  it('does not hide a new business action behind a method or completion adjunct', () => {
    for (const root of [
      'Edit config.json. Use ordinary host tools for publishing the package.',
      'Edit config.json. Complete this task using the publisher to deploy the package.',
      'Edit config.json. Use ordinary host tools for editing and publishing.',
    ]) {
      const items = rootItems(root)
      expect(items.some(item => item.taskKind === 'context' && item.status === 'passed' && /publish|deploy/iu.test(item.normalizedText))).toBe(false)
      expect(required(items).some(item => /publish|deploy/iu.test(item.normalizedText))).toBe(true)
    }
  })
  it('keeps a fronted place and its test verb in one current clause', async () => {
    const items = rootItems('In this workspace, run npm test.')
    expect(required(items).map(item => item.semanticAction)).toEqual(['test'])
    expect(required(items)[0]?.authorityDisposition).toBe('executable_now')
    const replay = await replayRawV2({ root: 'In this workspace, run npm test.', final: 'The test remains to be run.' })
    expect((replay.post_turn_core_projection as Record<string, unknown>).unknown_coverage).toEqual([])
  })
  it('preserves a quoted absolute project locator and refuses an unproven one', () => {
    const exact = rootItems('Run npm run metrics now in "C:\\Work Space\\repo".')
    expect(required(exact)[0]?.requestedTarget).toMatchObject({ scope: 'C:\\Work Space\\repo', script_name: 'metrics' })
    expect(required(exact)[0]?.targetSource).toMatchObject({ kind: 'explicit_path' })
    const relative = rootItems('Run npm run metrics now in "../other repo".')
    expect(required(relative)[0]?.targetCaptureStatus).toBe('clarification_required')
    expect(required(relative)[0]?.requestedTarget?.scope).toBeUndefined()
    expect(rootItems('The log says "Run npm run metrics now in C:\\Work Space\\repo". Explain that line.')
      .some(item => item.semanticAction === 'verify' && item.authorityDisposition === 'executable_now')).toBe(false)
  })
  it('does not absorb a coordinated finite action into a host-tool method list', () => {
    const items = rootItems('Edit config.json. Use ordinary host tools for editing, and run npm test.')
    expect(items.some(item => item.semanticAction === 'test' && item.authorityDisposition === 'executable_now')).toBe(true)
  })
  it('exposes an unsupported named package script without selecting an unrelated audited script', async () => {
    const projection = rootProjection("Run the metrics script from this project's package.json now.")
    const item = [...projection.items.values()].find(candidate => candidate.requestedTarget?.script_name === 'metrics')!
    expect(item).toBeDefined()
    let reads = 0
    const observer = createTestReadinessObserver({ getProjection: () => projection, flush: async () => true, fs: {
      resolve: async () => { reads += 1; throw new Error('must not select test/benchmark') },
      stat: async () => undefined,
      readText: async () => '',
    } })
    const result = await observer.execute({ item_id: item.id }, { agent: { session: {} }, signal: new AbortController().signal } as never) as Record<string, unknown>
    expect(result).toMatchObject({ status: 'unavailable', reason_code: 'readiness_script_capability_unavailable' })
    expect(reads).toBe(0)
  })
  it('preserves exact source coverage through the actual Session and Stop replay', async () => {
    const replay = await replayRawV2({ root: 'In this workspace, edit the existing config.json. Run npm test, read config.json back, and report the result. Complete this task. Use ordinary host tools for editing, testing, and readback.',
      final: 'The requested work remains pending.' })
    const post = replay.post_turn_core_projection as Record<string, unknown>
    expect(post.coverage_errors).toEqual([])
    expect(post.unknown_coverage).toEqual([])
    expect(post.certifiable).toBe(false)
  })
})
