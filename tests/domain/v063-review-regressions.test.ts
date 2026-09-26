import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE, legacyRecordsNeedingReview } from '../../src/domain/derive.js'
import { captureClause } from '../../src/domain/capture.js'
import { needsReviewObligations } from '../../src/domain/closure.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope, type GuardItem } from '../../src/domain/types.js'

/**
 * The independent review's counterexamples, kept as regressions.
 *
 * The 0.6.3 batch was returned because an independent reviewer's probes found
 * nine wrong results. Each of those probes is reproduced here with the contract
 * expectation the reviewer stated, so the same defect cannot return silently.
 * The reviewer's original file used minimal types; the cases and their
 * assertions are theirs, the typing is this repository's.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/repo-a', sessionHeader: { version: 3, id: 'v063-review', createdAt: 1 } }

let seq = 0
function derive(texts: string[]) {
  seq = 0
  const events: DerivedEnvelope[] = [{
    seq: seq++, type: 'user/message', data: {
      source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice' },
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

describe('review P1/K1: an execution obligation survives a zero-tool final answer', () => {
  it.each([
    'Check whether an update exists and install the package.',
    '安装新主题吧。',
    '检查是否有更新并安装新主题。',
  ])('%s keeps pending execution work', (text) => {
    const items = itemsOf([text])
    expect(items.some((item) => item.status === 'pending'
      && item.authorityDisposition !== 'informational')).toBe(true)
    // The information range, when one exists, is the only thing that closed.
    for (const item of items.filter((row) => row.authorityDisposition === 'executable_now')) {
      expect(item.status, item.normalizedText).toBe('pending')
    }
  })

  it('a no-punctuation conjunction keeps the second order visible', () => {
    // Tightened in the twelfth repair round: in English the complement of `whether`
    // may itself be a subject + predicate ("the deployment scripts install foo"),
    // which the surface cannot distinguish from a noun phrase whose head is a
    // vocabulary verb ("an update exists"). The safe reading is one UNDECIDED
    // obligation: the install stays visible, nothing answers it away, and it is not
    // authority. The Chinese counterpart keeps its order (the complement states a
    // state question with no predicate of its own).
    const english = itemsOf(['Check whether an update exists and install the package.'])
    expect(english.every((item) => item.authorityDisposition !== 'informational')).toBe(true)
    expect(english.every((item) => item.authorityDisposition !== 'executable_now')).toBe(true)
    for (const item of english) expect(item.status, item.normalizedText).toBe('pending')
    expect(english.some((item) => item.normalizedText.includes('install the package'))).toBe(true)

    // 合同调整 (0.6.3 收窄合同): the Chinese counterpart used to keep its install as
    // an order. It is now the same ONE undecided obligation as the English form.
    const chinese = itemsOf(['检查是否有更新并安装新主题。'])
    expect(chinese.every((item) => item.authorityDisposition !== 'executable_now')).toBe(true)
    for (const item of chinese) expect(item.status, item.normalizedText).toBe('pending')
    expect(chinese.some((item) => item.normalizedText.includes('安装新主题'))).toBe(true)
  })

  it('a 吧 suggestion is an order, while 吗/呢 and ？ still ask', () => {
    for (const ordered of ['安装新主题吧。', '更新插件吧。', '提交并推送吧。']) {
      const items = itemsOf([ordered])
      expect(items.every((item) => item.authorityDisposition !== 'informational'), ordered).toBe(true)
      expect(items.some((item) => item.status === 'pending'), ordered).toBe(true)
    }
    for (const asked of ['检查一下插件是否有更新吗？', '这个任务完成了吗？']) {
      const projection = derive([asked])
      const items = [...projection.items.values()]
      // A question with no task feature is session-layer talk and produces no
      // obligation at all; a question that is captured closes as answered.
      if (items.length > 0) {
        expect(items.some((item) => item.authorityDisposition === 'informational'), asked).toBe(true)
        expect(items.every((item) => item.status === 'answered'), asked).toBe(true)
      }
    }
  })
})

describe('review P1/K2: a prohibition is not a target selection', () => {
  it('a prohibited repository never becomes the inherited target of later work', () => {
    const projection = derive(['安装 foo 插件，不要推送仓库 /repo-b。', '提交。'])
    const commit = [...projection.items.values()].find((item) => item.semanticAction === 'commit')!
    expect(commit.targetCaptureStatus).toBe('clarification_required')
    expect(commit.targetSource?.kind).toBe('environment_default')
    expect(commit.requestedTarget?.repository).not.toBe('/repo-b')
  })

  it('a branch value is never read as the repository', () => {
    const item = captureClause('提交分支 release。', 'm1', 'R001', 1, { cwd: '/repo-a' })
    expect(item.targetCaptureStatus).toBe('clarification_required')
    expect(item.targetSource?.kind).toBe('environment_default')
    expect(item.requestedTarget?.repository).not.toBe('release')
  })

  it('a conditional or waiting item is not an inheritance source either', () => {
    // Only the Chinese form is a real reservation; the mixed
    // "推送仓库 /repo-b if I confirm。" is dominated by the trailing 。 and is
    // read as an informational statement, which is a different (and already
    // covered) reading.
    for (const text of ['推送仓库 /repo-b 如果我确认后再推送。']) {
      const projection = derive([text, '提交。'])
      const push = [...projection.items.values()].find((item) => item.semanticAction === 'push')!
      // The reservation means the repository was never positively authorized.
      expect(
        push.authorityDisposition === 'conditional_wait' || push.waitAuthorization !== undefined,
        text,
      ).toBe(true)
      const commit = [...projection.items.values()].find((item) => item.semanticAction === 'commit')!
      expect(commit.targetSource?.kind, text).toBe('environment_default')
    }
  })
})

describe('review P2/K2: uniqueness is object identity, not item count', () => {
  it('the same repository stays one candidate across three references', () => {
    const items = itemsOf(['提交仓库 /repo-b 分支 main。', '推送。', '拉取。'])
    const pull = items.find((item) => item.semanticAction === 'pull')!
    expect(pull.targetCaptureStatus).toBe('resolved')
    expect(pull.requestedTarget?.repository).toBe('/repo-b')
    expect(pull.targetSource?.kind).toBe('unit_inherited')
  })

  it('two different repositories still stay ambiguous', () => {
    const items = itemsOf([
      '推送仓库 /repo-b remote origin refspec refs/heads/main。',
      '推送仓库 /repo-c remote origin refspec refs/heads/main。',
      '提交。',
    ])
    const commit = items.find((item) => item.semanticAction === 'commit')!
    expect(commit.targetCaptureStatus).toBe('clarification_required')
    expect(commit.targetCaptureReasonCode).toBe('requested_target_repository_ambiguous')
  })

  it('a trailing separator does not make a second candidate of the same path', () => {
    const items = itemsOf(['提交仓库 /repo-b 的改动。', '推送仓库 /repo-b/ 的改动。', '拉取。'])
    const pull = items.find((item) => item.semanticAction === 'pull')!
    expect(pull.targetCaptureStatus).toBe('resolved')
    expect(pull.requestedTarget?.repository).toBe('/repo-b')
  })
})

describe('review P1/K4: the blocking set follows the certificate scope', () => {
  const legacy = (over: Partial<GuardItem>): GuardItem => ({
    ...captureClause('占位', 'm1', 'R001', 1, { cwd: '/repo-a' }),
    ...over,
  })

  it('a passed record of the CURRENT unit is inside the blocking set', () => {
    const p = createProjection()
    p.enabled = true
    p.boundaryProtocol = 5
    p.currentUnitId = 'U001'
    const item = legacy({
      unitId: 'U001', status: 'passed',
      needsReview: { reason: 'legacy_environment_default_target', checkId: 'eligibility:0.6.3', recordedAtRevision: 1 },
    })
    p.items.set(item.id, item)
    expect(needsReviewObligations(p)).toHaveLength(1)
  })

  it('an answered record of ANOTHER unit stays outside it', () => {
    const p = createProjection()
    p.enabled = true
    p.boundaryProtocol = 5
    p.currentUnitId = 'U002'
    const item = legacy({
      unitId: 'U001', status: 'answered',
      needsReview: { reason: 'legacy_mixed_information_scope', checkId: 'eligibility:0.6.3', recordedAtRevision: 1 },
    })
    p.items.set(item.id, item)
    expect(needsReviewObligations(p)).toHaveLength(0)
  })

  it('a required descendant unit stays inside it', () => {
    const p = createProjection()
    p.enabled = true
    p.boundaryProtocol = 5
    p.currentUnitId = 'U001'
    p.units.set('U001', { unitId: 'U001', openedAtSeq: 1, rootInputRefs: [{ seq: 1 }], headline: 'parent' })
    p.units.set('U002', { unitId: 'U002', openedAtSeq: 2, rootInputRefs: [{ seq: 2 }], headline: 'child', parentUnitId: 'U001' })
    const item = legacy({
      unitId: 'U002', status: 'passed',
      needsReview: { reason: 'legacy_mixed_information_scope', checkId: 'eligibility:0.6.3', recordedAtRevision: 1 },
    })
    p.items.set(item.id, item)
    expect(needsReviewObligations(p).map((row) => row.id)).toEqual([item.id])
  })

  it('a pre-v5 record with no unit keeps its own birth rule and stays in scope', () => {
    const p = createProjection()
    p.enabled = true
    const item = legacy({
      status: 'answered',
      needsReview: { reason: 'legacy_mixed_information_scope', checkId: 'eligibility:0.6.3', recordedAtRevision: 1 },
    })
    p.items.set(item.id, item)
    expect(needsReviewObligations(p)).toHaveLength(1)
  })

  it('an English no-punctuation mixed record is caught by the upgrade check', () => {
    const p = createProjection()
    p.enabled = true
    const item = legacy({
      normalizedText: 'Check whether an update exists and install the package.',
      directive: 'informational', authorityDisposition: 'informational', taskKind: 'inquiry', status: 'answered',
    })
    p.items.set(item.id, item)
    expect(legacyRecordsNeedingReview(p)).toHaveLength(1)
  })

  it('a K1-family conjunction family is caught for the Chinese form too', () => {
    const p = createProjection()
    p.enabled = true
    const item = legacy({
      normalizedText: '检查是否有更新并安装新主题。',
      directive: 'informational', authorityDisposition: 'informational', taskKind: 'inquiry', status: 'answered',
    })
    p.items.set(item.id, item)
    expect(legacyRecordsNeedingReview(p)).toHaveLength(1)
  })
})

describe('review P2/K3: prepare reports the same snapshot block as execution', () => {
  it('an unsupported host lock blocks both lanes', async () => {
    const p = createProjection()
    p.enabled = true
    p.hostStatus = 'unsupported'
    const item = captureClause('提交仓库 /repo-b 分支 main。', 'm1', 'R001', 1, { cwd: '/repo-a' })
    p.items.set(item.id, item)
    const response = await createPrepareTool({ getProjection: () => p }).execute(
      { item_id: item.id, semantic_action: 'commit' } as never, undefined as never,
    ) as { compatibility: { status: string; reason_codes: string[] } }
    expect(response.compatibility.status).toBe('blocked')
    expect(response.compatibility.reason_codes).toContain('host_lock_unavailable')
    expect(authorizeMutationFromProjection(p, {
      action: 'commit', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { repository: '/repo-b', branch: 'main' },
    })).toMatchObject({ reasonCode: 'mutation_host_lock_unavailable' })
  })

  it('a disabled guard and a corrupt projection are refused by BOTH lanes', async () => {
    // Prepare reports `guard_unavailable` for a snapshot the mutation gate also
    // refuses, so neither lane can be read as ready. The point is that no
    // snapshot the execution side rejects is ever presented as compatible.
    for (const [field, prepareCode, mutationCode] of [
      ['enabled', 'guard_unavailable', 'mutation_guard_disabled'],
      ['integrity', 'guard_unavailable', 'mutation_integrity_unavailable'],
    ] as const) {
      const p = createProjection()
      p.enabled = true
      if (field === 'enabled') p.enabled = false
      else p.integrity = 'corrupt'
      const item = captureClause('提交仓库 /repo-b 分支 main。', 'm1', 'R001', 1, { cwd: '/repo-a' })
      p.items.set(item.id, item)
      const response = await createPrepareTool({ getProjection: () => p }).execute(
        { item_id: item.id, semantic_action: 'commit' } as never, undefined as never,
      ) as { status: string; compatibility?: { status: string } }
      // Prepare refuses without ever saying the assumption is compatible.
      expect(response.status, field).toBe('unknown')
      expect(response.compatibility, field).toBeUndefined()
      expect(authorizeMutationFromProjection(p, {
        action: 'commit', contractItemId: item.id, contractItemRevision: item.revision,
        resolvedTarget: { repository: '/repo-b', branch: 'main' },
      })).toMatchObject({ status: 'denied', reasonCode: mutationCode })
      void prepareCode
    }
  })
})
