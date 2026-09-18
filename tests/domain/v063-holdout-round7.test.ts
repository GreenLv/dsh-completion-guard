import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { interpretMessage } from '../../src/domain/semantics.js'
import { legacyRecordsNeedingReview } from '../../src/domain/derive.js'
import { captureClause } from '../../src/domain/capture.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope, type GuardItem } from '../../src/domain/types.js'

/**
 * 0.6.3 hold-out round 7 — regression coverage (was the independent set).
 *
 * Round 6 was written after the fourth and fifth repair rounds, but the fifth
 * review then returned three source defects (F1-F3) and round 6's own oracle was
 * revised three times, so round 6 is regression coverage. Round 7 was written
 * after the F1-F3 repairs, against the task contract, in shape families absent
 * from rounds 1-6, the five review batches, the fifth repair set and the
 * recorded-fixture upgrade evidence:
 *
 * - two lower-case request sentences in a row, both of which must survive, and a
 *   mixed-script pair;
 * - an abbreviation and a version number as NON-boundaries inside a longer
 *   message (the protection the structural rule has to keep);
 * - a semicolon plus conjunction chain and a relative-path-free repository pair;
 * - a push whose caller differs only in the REMOTE, and an `apply` target whose
 *   caller differs only in the version;
 * - two actions in one clause naming two different repositories, which must stay
 *   two obligations rather than one ambiguity;
 * - the current-repository deixis offered as one alternative of a coordinator
 *   list;
 * - eligibility on a `superseded` record, which is out of the running, and on a
 *   record that declares an unknown state version.
 *
 * It found ONE source defect: the English sequencing word `then` was read both
 * as a request preface and as a comparative subordinate boundary, so
 * `Then check whether the build passed.` stayed an acceptance order while the
 * Chinese `然后检查是否有新版本。` was an information request. That repair changed
 * the source, so this set is REGRESSION COVERAGE and round 8 is the current
 * independent set. Two of its own expectations were also wrong (an abbreviation
 * starting the second sentence does not split it again, and an `apply`
 * obligation must name every authority field); they are recorded here rather
 * than hidden.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-holdout7', createdAt: 1 } }

let seq = 0
function derive(input: Array<string | { text: string; answer?: string }>) {
  seq = 0
  const events: DerivedEnvelope[] = [{
    seq: seq++, type: 'user/message', data: {
      source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' },
      content: [{ type: 'text', text: PROTOCOL_V5_NOTICE }],
    },
  }]
  input.forEach((entry, index) => {
    const turn = index + 1
    const text = typeof entry === 'string' ? entry : entry.text
    const answer = typeof entry === 'string' ? '收到。' : entry.answer ?? '收到。'
    events.push(
      { seq: seq++, type: 'turn/start', data: { turn } },
      { seq: seq++, type: 'user/message', data: { turn, source: { kind: 'user' }, content: [{ type: 'text', text }] } },
      { seq: seq++, type: 'assistant/message', data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: answer }] } } },
      { seq: seq++, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
    )
  })
  return deriveProjection(events, config, scope, true).projection
}

const itemsOf = (input: Array<string | { text: string; answer?: string }>) => [...derive(input).items.values()]

describe('hold-out 7 / K1: sentence boundaries in further shapes', () => {
  it.each([
    ['Report the status. please archive the logs.', 'Report the status', 'archive the logs'],
    ['Fix the parser. kindly update the README.md.', 'Fix the parser', 'update the README.md'],
    ['安装依赖。Please archive the logs.', '安装依赖', 'archive the logs'],
  ] as const)('%s keeps both instructions', (text, first, second) => {
    const scopes = interpretMessage(text)
    const work = scopes.filter((entry) => entry.authorityDisposition !== 'informational').map((entry) => entry.text).join('｜')
    expect(work, text).toContain(first)
    expect(work, text).toContain(second)
    const items = itemsOf([text])
    expect(items.filter((item) => item.status === 'pending').length, text).toBeGreaterThanOrEqual(1)
  })

  it('an ordered pair survives the answering turn', () => {
    const items = itemsOf([{ text: 'Report the status. please archive the logs.', answer: '收到。' }])
    expect(items.some((item) => item.status === 'pending' && item.normalizedText.includes('archive'))).toBe(true)
  })

  it('an abbreviation does not open a sentence of its own', () => {
    const scopes = interpretMessage('Fix the bug. i.e. correct the parser.')
    // Two sentences — the second one STARTS with the abbreviation, which must
    // not split it again into "i.e." plus a clause of its own.
    expect(scopes).toHaveLength(2)
    expect(scopes[1]!.text).toContain('i.e.')
    expect(scopes[1]!.text).toContain('correct the parser')
  })

  it('a version number is not a sentence end either', () => {
    const scopes = interpretMessage('Release dsh-completion-guard 0.6.3. Then report back.')
    expect(scopes).toHaveLength(2)
    expect(scopes[0]!.text).toContain('0.6.3')
  })

  it('a semicolon chain keeps the question and the order apart', () => {
    const scopes = interpretMessage('Update README.md; then check whether the build passed.')
    expect(scopes.some((entry) => entry.authorityDisposition === 'informational')).toBe(true)
    expect(scopes.some((entry) => entry.authorityDisposition === 'executable_now')).toBe(true)
  })
})

describe('hold-out 7 / K2: two repositories in one clause, two obligations across clauses', () => {
  it('two actions naming two repositories stay two resolved obligations', () => {
    const items = itemsOf(['拉取仓库 /repo-a 并推送仓库 /repo-b。'])
    const targets = items.map((item) => item.requestedTarget?.repository)
    expect(items.length).toBeGreaterThanOrEqual(2)
    expect(new Set(targets).size).toBeGreaterThanOrEqual(2)
    for (const item of items) {
      expect(item.targetCaptureStatus, item.normalizedText).toBe('resolved')
      expect(item.targetCaptureReasonCode).toBeUndefined()
    }
  })

  it('the current-repository deixis offered as an alternative is still a choice', () => {
    const item = captureClause('提交当前仓库 与 /repo-c。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus).toBe('clarification_required')
    expect(item.targetCaptureReasonCode).toBe('requested_target_repository_ambiguous')
    expect(item.requestedTarget?.repository).toBeUndefined()
  })

  it('a single named repository stays resolved and keeps its fields', () => {
    const item = captureClause('推送仓库 /repo-a remote upstream refspec refs/heads/release。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus).toBe('resolved')
    expect(item.requestedTarget).toMatchObject({ repository: '/repo-a', remote: 'upstream', refspec: 'refs/heads/release' })
  })
})

describe('hold-out 7 / K3: prepare and execution answer the same question', () => {
  it('a caller that differs only in the remote is refused in both lanes', async () => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause('推送仓库 /repo-a remote upstream refspec refs/heads/release。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    projection.items.set(item.id, item)
    const tool = createPrepareTool({ getProjection: () => projection })
    const same = await tool.execute({
      item_id: item.id, semantic_action: 'push',
      requested_target: { repository: '/repo-a', remote: 'upstream', refspec: 'refs/heads/release' },
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(same.compatibility.status).toBe('compatible')
    expect(authorizeMutationFromProjection(projection, {
      action: 'push', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { repository: '/repo-a', remote: 'upstream', refspec: 'refs/heads/release' },
    }).status).not.toBe('denied')

    const otherRemote = await tool.execute({
      item_id: item.id, semantic_action: 'push',
      requested_target: { repository: '/repo-a', remote: 'origin', refspec: 'refs/heads/release' },
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(otherRemote.compatibility.status).not.toBe('compatible')
    expect(authorizeMutationFromProjection(projection, {
      action: 'push', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { repository: '/repo-a', remote: 'origin', refspec: 'refs/heads/release' },
    }).status).toBe('denied')
  })

  it('an apply target is judged on the version the obligation named', async () => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause('把应用包 foo 版本 0.6.3 配置档 default 明确为 apply', 'm1', 'R001', 1, { cwd: '/srv/app' })
    projection.items.set(item.id, item)
    expect(item.requestedTarget).toMatchObject({ package_id: 'foo', version: '0.6.3', profile: 'default' })
    const tool = createPrepareTool({ getProjection: () => projection })
    const same = await tool.execute({
      item_id: item.id, semantic_action: 'apply',
      requested_target: { package_id: 'foo', version: '0.6.3', profile: 'default' },
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(same.compatibility.status).toBe('compatible')
    const otherVersion = await tool.execute({
      item_id: item.id, semantic_action: 'apply',
      requested_target: { package_id: 'foo', version: '0.6.4', profile: 'default' },
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(otherVersion.compatibility.status).not.toBe('compatible')
    expect(authorizeMutationFromProjection(projection, {
      action: 'apply', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { package_id: 'foo', version: '0.6.4', profile: 'default' },
    }).status).toBe('denied')
  })

  it('an obligation that names only part of the identity cannot be completed by the caller', async () => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause('应用包 foo 版本 0.6.3。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    projection.items.set(item.id, item)
    const prepared = await createPrepareTool({ getProjection: () => projection }).execute({
      item_id: item.id, semantic_action: 'apply',
      requested_target: { package_id: 'foo', version: '0.6.3', profile: 'default' },
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(prepared.compatibility.status).not.toBe('compatible')
    expect(authorizeMutationFromProjection(projection, {
      action: 'apply', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { package_id: 'foo', version: '0.6.3', profile: 'default' },
    }).status).toBe('denied')
  })
})

describe('hold-out 7 / K4: eligibility leaves the records it must leave alone', () => {
  it('a superseded record is out of the running', () => {
    const projection = createProjection()
    projection.enabled = true
    const record: GuardItem = {
      ...captureClause('占位', 'm1', 'R001', 1, { cwd: '/srv/app' }),
      status: 'superseded',
      normalizedText: 'Compress /var/logs to check which shard failed and install the CLI.',
      directive: 'informational', authorityDisposition: 'informational', taskKind: 'inquiry',
    }
    projection.items.set(record.id, record)
    expect(legacyRecordsNeedingReview(projection)).toEqual([])
  })

  it('a record that declares an unknown state version is reported, not assumed compatible', () => {
    const projection = createProjection()
    projection.enabled = true
    const record = {
      ...captureClause('占位', 'm1', 'R001', 1, { cwd: '/srv/app' }),
      status: 'answered' as const,
      normalizedText: '确认是否有新版本。',
      directive: 'informational' as const, authorityDisposition: 'informational' as const, taskKind: 'inquiry' as const,
      stateVersion: 2,
    }
    projection.items.set(record.id, record as GuardItem)
    const findings = legacyRecordsNeedingReview(projection)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ itemId: record.id, reason: 'unknown_state_version' })
  })

  it('a safe record of the same shape is not reported', () => {
    const projection = createProjection()
    projection.enabled = true
    const record = {
      ...captureClause('占位', 'm1', 'R001', 1, { cwd: '/srv/app' }),
      status: 'answered' as const,
      normalizedText: '确认是否有新版本。',
      directive: 'informational' as const, authorityDisposition: 'informational' as const, taskKind: 'inquiry' as const,
      stateVersion: 1,
    }
    projection.items.set(record.id, record as GuardItem)
    expect(legacyRecordsNeedingReview(projection)).toEqual([])
  })
})
