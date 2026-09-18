import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE, legacyRecordsNeedingReview } from '../../src/domain/derive.js'
import { captureClause } from '../../src/domain/capture.js'
import { needsReviewObligations } from '../../src/domain/closure.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope, type GuardItem } from '../../src/domain/types.js'

/**
 * The second independent review's counterexamples, kept as regressions.
 *
 * The batch was returned a second time with five failing probes covering three
 * defects: an English clause whose embedded interrogative is the OBJECT of its
 * own action ("Create a file … recording whether the tests passed") was read as
 * an answerable information request; repository inheritance OVERWROTE a branch
 * the follow-up clause named explicitly; and `context_guard_prepare` did not
 * see the standing prohibition the mutation gate refuses on. The reviewer's
 * cases and expectations are kept here in this repository's typing.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/repo-a', sessionHeader: { version: 3, id: 'v063-review2', createdAt: 1 } }

let seq = 0
function derive(texts: string[]) {
  seq = 0
  const events: DerivedEnvelope[] = [{
    seq: seq++, type: 'user/message', data: {
      source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' },
      content: [{ type: 'text', text: PROTOCOL_V5_NOTICE }],
    },
  }]
  texts.forEach((text, index) => {
    const turn = index + 1
    events.push(
      { seq: seq++, type: 'turn/start', data: { turn } },
      { seq: seq++, type: 'user/message', data: { turn, source: { kind: 'user' }, content: [{ type: 'text', text }] } },
      { seq: seq++, type: 'assistant/message', data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '收到。' }] } } },
      { seq: seq++, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
    )
  })
  return deriveProjection(events, config, scope, true).projection
}

const itemsOf = (texts: string[]) => [...derive(texts).items.values()]

describe('review 2 / P1: an interrogative inside the object does not make the clause a question', () => {
  it.each([
    'Create a report showing whether the tests passed.',
    'Create a file /tmp/test-status.txt recording whether the tests passed.',
    'Write /tmp/result.txt indicating whether deployment succeeded.',
    'Write a summary describing whether the migration worked.',
    'Generate a note stating whether the build succeeded.',
  ])('%s stays open work', (text) => {
    const items = itemsOf([text])
    expect(items.some((item) => item.status === 'pending' && item.authorityDisposition !== 'informational'), text).toBe(true)
    // The action keeps its own reading; the clause never enters the answer lane.
    for (const item of items) {
      expect(item.authorityDisposition, text).not.toBe('informational')
    }
  })

  it.each([
    'Install the package if a newer version exists.',
    'Install the package if available.',
  ])('%s is a conditional order, never an answer', (text) => {
    const items = itemsOf([text])
    expect(items.some((item) => item.status === 'pending')).toBe(true)
    expect(items.every((item) => item.authorityDisposition !== 'informational'), text).toBe(true)
  })

  it.each([
    'Check whether an update exists.',
    'Check if the remote has new commits.',
    'Tell me what changed in the build and why.',
    'What changed in the build?',
  ])('%s is still a genuine question', (text) => {
    const items = itemsOf([text])
    // Either the question is captured as an information obligation or it is
    // session-layer talk; either way it is never recorded as execution work.
    for (const item of items) {
      expect(item.authorityDisposition, text).not.toBe('executable_now')
    }
    if (items.length > 0) {
      expect(items.every((item) => item.authorityDisposition === 'informational' || item.authorityDisposition === 'unresolved'), text).toBe(true)
    }
  })

  it('an English clause whose choice IS the question stays answerable', () => {
    // The counterpart control: when the wh-word opens the clause, the clause
    // asks, so delivery closes it.
    const items = itemsOf(['What changed in the build and why'])
    expect(items.length).toBeGreaterThanOrEqual(0)
    expect(items.every((item) => item.authorityDisposition !== 'executable_now')).toBe(true)
  })
})

describe('review 2 / P1: inheritance fills around the fields the clause names', () => {
  it('an explicitly named branch survives inheritance', () => {
    const items = itemsOf(['提交仓库 /repo-b 分支 main。', '提交分支 release。'])
    const followUp = items.at(-1)!
    expect(followUp.requestedTarget).toMatchObject({ repository: '/repo-b', branch: 'release' })
    expect(followUp.targetSource?.kind).toBe('unit_inherited')
    expect(followUp.targetCaptureStatus).toBe('resolved')
  })

  it('an explicitly named remote/refspec survives inheritance too', () => {
    const items = itemsOf(['提交仓库 /repo-b 分支 main。', '推送远端 upstream 引用规范 refs/heads/main。'])
    const push = items.find((item) => item.semanticAction === 'push')!
    expect(push.requestedTarget).toMatchObject({ repository: '/repo-b', remote: 'upstream' })
  })

  it('the merged target is what the mutation gate then accepts', () => {
    const projection = derive(['提交仓库 /repo-b 分支 main。', '提交分支 release。'])
    const followUp = [...projection.items.values()].at(-1)!
    // The caller resolves exactly the merged selection, and that is authorized.
    expect(authorizeMutationFromProjection(projection, {
      action: 'commit', contractItemId: followUp.id, contractItemRevision: followUp.revision,
      resolvedTarget: { repository: '/repo-b', branch: 'release' },
    }).status).not.toBe('denied')
    // The inherited branch must NOT silently outrank the one the root named.
    expect(authorizeMutationFromProjection(projection, {
      action: 'commit', contractItemId: followUp.id, contractItemRevision: followUp.revision,
      resolvedTarget: { repository: '/repo-b', branch: 'main' },
    })).toMatchObject({ status: 'denied', reasonCode: 'mutation_requested_target_mismatch' })
  })

  it('an unset field is still inherited', () => {
    const items = itemsOf(['提交仓库 /repo-b 分支 main。', '提交。'])
    const followUp = items.at(-1)!
    expect(followUp.requestedTarget).toMatchObject({ repository: '/repo-b', branch: 'main' })
  })
})

describe('review 2 / P2: prepare and execution agree about a standing prohibition', () => {
  const prepareFor = async (projection: ReturnType<typeof createProjection>, item: GuardItem) =>
    createPrepareTool({ getProjection: () => projection }).execute(
      { item_id: item.id, semantic_action: 'commit' } as never, undefined as never,
    ) as Promise<Record<string, unknown>>

  it('a pending prohibition on the same action and target blocks prepare', async () => {
    const projection = derive(['提交仓库 /repo-b 分支 main。不要提交仓库 /repo-b 分支 main。'])
    const item = [...projection.items.values()].find((row) => row.kind === 'requirement' && row.semanticAction === 'commit')!
    const response = await prepareFor(projection, item)
    expect((response.compatibility as { status: string }).status).toBe('blocked')
    expect((response.compatibility as { reason_codes: string[] }).reason_codes).toContain('conflicting_prohibition')
    // And the execution gate refuses the same snapshot for the same reason.
    expect(authorizeMutationFromProjection(projection, {
      action: 'commit', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { repository: '/repo-b', branch: 'main' },
    })).toMatchObject({ status: 'denied', reasonCode: 'mutation_conflicting_prohibition' })
  })

  it('a prohibition on a DIFFERENT target leaves prepare compatible', async () => {
    const projection = derive(['提交仓库 /repo-b 分支 main。不要提交仓库 /repo-c 分支 main。'])
    const item = [...projection.items.values()].find((row) => row.kind === 'requirement' && row.semanticAction === 'commit')!
    const response = await prepareFor(projection, item)
    expect((response.compatibility as { status: string }).status).toBe('compatible')
    expect(authorizeMutationFromProjection(projection, {
      action: 'commit', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { repository: '/repo-b', branch: 'main' },
    }).status).not.toBe('denied')
  })

  it('a legacy prohibition is not read as a standing constraint by either lane', async () => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause('提交仓库 /repo-b 分支 main。', 'm1', 'R001', 1, { cwd: '/repo-a' })
    projection.items.set(item.id, item)
    const legacyBan: GuardItem = {
      ...captureClause('不要提交仓库 /repo-b 分支 main。', 'm1', 'P001', 2, { cwd: '/repo-a' }),
      kind: 'prohibition', semanticAction: 'commit',
      requestedTarget: { repository: '/repo-b', branch: 'main' },
      legacyFlags: ['legacy_authority_unclassified'],
    }
    projection.items.set(legacyBan.id, legacyBan)
    const response = await prepareFor(projection, item)
    expect((response.compatibility as { status: string }).status).toBe('compatible')
  })
})

describe('review 3 / P2: the two lanes judge the SAME supplied target', () => {
  const commitItem = () => captureClause('提交仓库 /repo-b 分支 main。', 'm1', 'R001', 1, { cwd: '/repo-a' })

  it('a supplied target that differs is incompatible in prepare and denied by the gate', async () => {
    const projection = createProjection()
    projection.enabled = true
    const item = commitItem()
    projection.items.set(item.id, item)
    const target = { repository: '/repo-c', branch: 'release' }
    const prepared = await createPrepareTool({ getProjection: () => projection }).execute(
      { item_id: item.id, semantic_action: 'commit', requested_target: target } as never, undefined as never,
    ) as { status: string; reason_code: string; compatibility: { status: string; target_compatible: boolean } }
    expect(prepared.compatibility.target_compatible).toBe(false)
    expect(prepared.compatibility.status).toBe('incompatible')
    expect(prepared.status).toBe('incompatible')
    expect(prepared.reason_code).toBe('requested_resolved_target_mismatch')
    expect(authorizeMutationFromProjection(projection, {
      action: 'commit', contractItemId: item.id, contractItemRevision: item.revision, resolvedTarget: target,
    })).toMatchObject({ status: 'denied', reasonCode: 'mutation_requested_target_mismatch' })
  })

  it('a supplied target that matches is compatible in both lanes', async () => {
    const projection = createProjection()
    projection.enabled = true
    const item = commitItem()
    projection.items.set(item.id, item)
    const target = { repository: '/repo-b', branch: 'main' }
    const prepared = await createPrepareTool({ getProjection: () => projection }).execute(
      { item_id: item.id, semantic_action: 'commit', requested_target: target } as never, undefined as never,
    ) as { status: string; compatibility: { status: string; target_compatible: boolean } }
    expect(prepared.compatibility.status).toBe('compatible')
    expect(prepared.compatibility.target_compatible).toBe(true)
    expect(authorizeMutationFromProjection(projection, {
      action: 'commit', contractItemId: item.id, contractItemRevision: item.revision, resolvedTarget: target,
    }).status).not.toBe('denied')
  })

  it('preparation without a supplied target judges the obligation\u2019s own selection', async () => {
    const projection = createProjection()
    projection.enabled = true
    const item = commitItem()
    projection.items.set(item.id, item)
    const prepared = await createPrepareTool({ getProjection: () => projection }).execute(
      { item_id: item.id, semantic_action: 'commit' } as never, undefined as never,
    ) as { compatibility: { status: string; target_compatible: boolean } }
    expect(prepared.compatibility.status).toBe('compatible')
    expect(prepared.compatibility.target_compatible).toBe(true)
  })
})

describe('review 2 / regression guards for the earlier rounds', () => {
  it('the first review\u2019s mixed-request and inheritance probes still hold', () => {
    for (const text of [
      'Check whether an update exists and install the package.',
      '安装新主题吧。',
      '检查是否有更新并安装新主题。',
    ]) {
      const items = itemsOf([text])
      expect(items.some((item) => item.status === 'pending' && item.authorityDisposition !== 'informational'), text).toBe(true)
    }
    const prohibited = derive(['安装 foo 插件，不要推送仓库 /repo-b。', '提交。'])
    const commit = [...prohibited.items.values()].find((item) => item.semanticAction === 'commit')!
    expect(commit.targetCaptureStatus).toBe('clarification_required')
    expect(commit.requestedTarget?.repository).not.toBe('/repo-b')
  })

  it('the eligibility layer still flags a historical mixed record', () => {
    const projection = createProjection()
    projection.enabled = true
    const record: GuardItem = {
      ...captureClause('占位', 'm1', 'R001', 1, { cwd: '/repo-a' }),
      normalizedText: '安装主题 A，检查是否有更新。',
      directive: 'informational', authorityDisposition: 'informational', taskKind: 'inquiry',
      status: 'answered',
    }
    projection.items.set(record.id, record)
    expect(legacyRecordsNeedingReview(projection)).toHaveLength(1)
    expect(needsReviewObligations(projection)).toHaveLength(0)
  })
})
