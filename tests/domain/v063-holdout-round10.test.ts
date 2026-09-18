import { describe, expect, it } from 'vitest'
import { deriveProjection, legacyRecordsNeedingReview, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { interpretMessage } from '../../src/domain/semantics.js'
import { captureClause } from '../../src/domain/capture.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope, type GuardItem } from '../../src/domain/types.js'

/**
 * 0.6.3 hold-out round 10 — regression coverage (was the independent set).
 *
 * Round 9 found nothing, but the SEVENTH review then returned three
 * counterexamples whose repairs changed the source, so round 9 is regression
 * coverage. Round 10 was written after those repairs, against the contract's
 * TWO-SIDED requirement (an execution obligation must not be closed by an answer,
 * and an explanation must not become execution authority), in shape families
 * absent from rounds 1-9 and the seven review batches:
 *
 * - explanation heads that hand a coordinated list of actions to the question
 *   (`Show me how to … and …`, `Tell me how to … and …`) beside the same heads
 *   followed by a real order;
 * - a prefaced question after an abbreviation, and a named-branch clause beside a
 *   conflicting one;
 * - conflicting `remote` values on one repository;
 * - one repository named with two different branch values and a later clause that
 *   names the branch itself (the explicit branch must win);
 * - eligibility on an explanation whose object is a coordinated action list,
 *   which must stay inheritable.
 *
 * It found nothing of its own, but the EIGHTH review then found that the
 * explanation scope was still pattern-based (a `to`+verb and a fixed window) and
 * that "and then" must not authorize; those repairs changed the source AND
 * tightened one of this set's shapes (a comma-separated second action is now part
 * of the explanation), so it is REGRESSION COVERAGE and round 11 is the current
 * independent set.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-holdout10', createdAt: 1 } }

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

describe('hold-out 10 / K1: an explanation hands its action list to the question', () => {
  it.each([
    'Show me how to deploy the service and restart service api.',
    'Tell me how to install foo and publish package bar.',
    '说明一下如何回滚并重新部署服务。',
  ])('%s creates no execution obligation', (text) => {
    const items = itemsOf([text])
    expect(items.length, text).toBeGreaterThan(0)
    expect(items.every((item) => item.authorityDisposition !== 'executable_now'), JSON.stringify(items.map((i) => [i.normalizedText, i.authorityDisposition]))).toBe(true)
  })

  it('no explanation item authorizes the action it asks about', () => {
    for (const text of [
      'Show me how to deploy the service and restart service api.',
      'Tell me how to install foo and publish package bar.',
    ]) {
      const projection = derive([text])
      for (const item of projection.items.values()) {
        for (const [action, target] of [['restart', { service_id: 'api' }], ['install', { package_id: 'foo', version: '0.6.3', profile: 'default' }]] as const) {
          expect(authorizeMutationFromProjection(projection, {
            action, contractItemId: item.id, contractItemRevision: item.revision, resolvedTarget: target,
          }).status, `${text} / ${action}`).not.toBe('authorized')
        }
      }
    }
  })

  it.each([
    // The positive control is an explicitly SEPARATE instruction (its own
    // sentence), which the eighth review required; a comma is not enough.
    'Show me how to deploy the service. Then restart service api.',
    'Tell me how to install the foo package. Then publish the bar package.',
  ])('%s still orders the second action', async (text) => {
    const projection = derive([text])
    const restart = [...projection.items.values()].find((item) => item.semanticAction === 'restart' || item.semanticAction === 'publish')
    expect(restart, JSON.stringify([...projection.items.values()].map((i) => [i.normalizedText, i.authorityDisposition, i.semanticAction, i.requestedTarget]))).toBeDefined()
    expect(restart!.authorityDisposition).toBe('executable_now')
    const prepared = await createPrepareTool({ getProjection: () => projection }).execute({
      item_id: restart!.id, semantic_action: restart!.semanticAction,
      requested_target: restart!.requestedTarget,
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(prepared.compatibility.status).not.toBe('incompatible')
  })

  it('a question that merely stands beside an order keeps the order', () => {
    for (const text of ['Why did it fail and archive the logs?', '哪里出错了并记录变更？']) {
      const scopes = interpretMessage(text)
      expect(scopes.some((entry) => entry.authorityDisposition !== 'informational'), JSON.stringify(scopes.map((entry) => [entry.authorityDisposition, entry.text]))).toBe(true)
    }
  })
})

describe('hold-out 10 / K1: a prefaced question still leaves the execution owed', () => {
  it.each([
    'Deploy the build etc. please tell me why it failed?',
    'Push the branch etc. please report what changed?',
  ])('%s keeps a pending obligation', (text) => {
    const items = itemsOf([text])
    expect(items.some((item) => item.status === 'pending' && item.authorityDisposition !== 'informational'), JSON.stringify(items.map((i) => [i.normalizedText, i.status, i.authorityDisposition]))).toBe(true)
  })

  it.each([
    'Is the lock file current?',
    '这个分支干净吗？',
    'Does the release exist?',
  ])('%s stays one question: a yes/no question covers its clause', (text) => {
    const items = itemsOf([text])
    for (const item of items) expect(item.authorityDisposition, text).toBe('informational')
  })
})

describe('hold-out 10 / K2: inheritance compares each accepted field', () => {
  it('conflicting remotes leave the remote open', () => {
    const projection = derive([
      '推送仓库 /repo-a remote origin refspec refs/heads/main。',
      '推送仓库 /repo-a remote upstream refspec refs/heads/main。',
      '推送。',
    ])
    const last = [...projection.items.values()].at(-1)!
    expect(last.requestedTarget?.repository).toBe('/repo-a')
    expect(last.requestedTarget?.remote).toBeUndefined()
    expect(last.targetCaptureStatus).toBe('clarification_required')
    expect(last.targetCaptureReasonCode).toBe('requested_target_field_ambiguous')
  })

  it('agreement on the other fields is still inherited', () => {
    const projection = derive([
      '推送仓库 /repo-a remote origin refspec refs/heads/main。',
      '推送仓库 /repo-a remote upstream refspec refs/heads/main。',
      '推送。',
    ])
    const last = [...projection.items.values()].at(-1)!
    expect(last.requestedTarget?.refspec).toBe('refs/heads/main')
  })

  it('a clause that names the conflicting field itself is unaffected', () => {
    const projection = derive(['提交仓库 /repo-a 分支 main。', '提交仓库 /repo-a 分支 release。', '提交分支 release。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.requestedTarget).toMatchObject({ repository: '/repo-a', branch: 'release' })
    expect(last.targetCaptureStatus).toBe('resolved')
  })

  it('a single named repository with one branch is resolved', () => {
    const item = captureClause('提交仓库 /repo-a 分支 main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus).toBe('resolved')
    expect(item.requestedTarget).toEqual({ repository: '/repo-a', branch: 'main' })
  })
})

describe('hold-out 10 / K4: an explanation is not a legacy mixed record', () => {
  it('a recorded explanation of an action list stays inheritable', () => {
    const projection = createProjection()
    projection.enabled = true
    const record: GuardItem = {
      ...captureClause('占位', 'm1', 'R001', 1, { cwd: '/srv/app' }),
      normalizedText: 'Show me how to deploy the service and restart service api.',
      directive: 'informational', authorityDisposition: 'informational', taskKind: 'inquiry', status: 'answered',
    }
    projection.items.set(record.id, record)
    expect(legacyRecordsNeedingReview(projection)).toEqual([])
  })
})
