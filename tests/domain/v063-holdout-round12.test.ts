import { describe, expect, it } from 'vitest'
import { deriveProjection, legacyRecordsNeedingReview, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { interpretMessage, isExplanationScope } from '../../src/domain/semantics.js'
import { captureClause } from '../../src/domain/capture.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope, type GuardItem } from '../../src/domain/types.js'

/**
 * 0.6.3 hold-out round 12 — regression coverage (was the independent set).
 *
 * Round 11 found nothing of its own, but the NINTH review then required that an
 * explanation's scope never authorize an action it mentions; that repair changed
 * round 11's own reading, so round 11 is regression coverage. Round 12 was
 * written after the tenth repair round, in shape families absent from rounds 1-11
 * and the nine review batches:
 *
 * - finite explanation complements with plural and third-person subjects, a
 *   participle list, and the Chinese manner form with a long object;
 * - the same heads followed by an explicitly separate sentence, which must
 *   authorize;
 * - an explanation whose action plan names SEVERAL actions, all of which must be
 *   refused;
 * - the rule's scope: an unrecognised instruction form keeps its target path, and
 *   a pure reported question keeps its closable lane;
 * - eligibility on a recorded explanation and on a recorded bare-wh order;
 * - per-field inheritance with a conflicting refspec on one repository.
 *
 * It found nothing of its own, but the TENTH review then showed that a bare
 * question head (not only an explanation) must carry its non-execution
 * qualification into every child; that repair changed the source, so this set is
 * REGRESSION COVERAGE and round 13 is the current independent set.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-holdout12', createdAt: 1 } }

let seq = 0
function derive(texts: string | string[]) {
  if (typeof texts === 'string') texts = [texts]
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

describe('hold-out 12 / K1: an explanation never authorizes what it mentions', () => {
  it.each([
    'Explain how the team installs the package and restarts the service.',
    'Explain why the build installs dependencies and restarts the worker.',
    'Describe rolling back a release and restarting the gateway.',
    '说明一下团队如何安装依赖并重启工作进程，以及需要注意的事项。',
  ])('%s is one undecided obligation that authorizes nothing', (text) => {
    const projection = derive(text)
    const items = [...projection.items.values()]
    expect(items.length, text).toBe(1)
    expect(items[0]!.authorityDisposition, text).toBe('unresolved')
    expect(isExplanationScope(items[0]!.normalizedText), text).toBe(true)
    for (const item of items) {
      for (const action of [item.semanticAction, ...(item.actionPlan ?? []).map((entry) => entry.action)]) {
        if (!action || action === 'generic_run') continue
        const resolvedTarget = action === 'restart' ? { service_id: 'api' } : { package_id: 'foo', version: '0.6.3', profile: 'default' }
        expect(authorizeMutationFromProjection(projection, {
          action, contractItemId: item.id, contractItemRevision: item.revision, resolvedTarget,
        } as never).status, `${text} / ${action}`).not.toBe('authorized')
      }
    }
  })

  it('every action of the explanation plan is refused, not just the first', () => {
    const projection = derive('Explain how to install foo and restart service api.')
    const item = [...projection.items.values()][0]!
    const actions = [item.semanticAction, ...(item.actionPlan ?? []).map((entry) => entry.action)].filter(Boolean) as string[]
    expect(actions.length).toBeGreaterThanOrEqual(1)
    for (const action of actions) {
      if (action === 'generic_run') continue
      const resolvedTarget = action === 'restart' ? { service_id: 'api' } : { package_id: 'foo', version: '0.6.3', profile: 'default' }
      expect(authorizeMutationFromProjection(projection, {
        action, contractItemId: item.id, contractItemRevision: item.revision, resolvedTarget,
      } as never).status, action).toBe('denied')
    }
  })

  it.each([
    'Explain how the team deploys the release. Then restart service api.',
    '说明一下团队的部署流程。然后重启 api 服务。',
  ])('%s authorizes the separate instruction', async (text) => {
    const projection = derive(text)
    const restart = [...projection.items.values()].find((item) => item.semanticAction === 'restart')
    expect(restart, JSON.stringify([...projection.items.values()].map((i) => [i.normalizedText, i.authorityDisposition]))).toBeDefined()
    expect(restart!.authorityDisposition).toBe('executable_now')
    const prepared = await createPrepareTool({ getProjection: () => projection }).execute({
      item_id: restart!.id, semantic_action: 'restart', requested_target: { service_id: 'api' },
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(prepared.compatibility.status).toBe('compatible')
  })

  it('the rule is scoped: an explicit restatement is judged on its action and target', () => {
    // 合同调整: the bare `应用包 …` form lost its grant when the qualification became
    // a positive DIRECTIVE finding; the root's explicit restatement is the sanctioned
    // route, and the gate still judges its action and target instead of refusing on
    // the disposition.
    const projection = derive('把应用包 foo 版本 0.6.3 配置档 default 明确为 apply')
    const item = [...projection.items.values()][0]!
    expect(isExplanationScope(item.normalizedText)).toBe(false)
    expect(authorizeMutationFromProjection(projection, {
      action: 'apply', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { package_id: 'foo', version: '0.6.3', profile: 'default' },
    }).status).not.toBe('denied')
  })

  it('a pure reported question keeps its closable lane', () => {
    const projection = derive('Tell me why the worker restarted.')
    const item = [...projection.items.values()][0]!
    expect(isExplanationScope(item.normalizedText)).toBe(false)
    expect(item.authorityDisposition).toBe('informational')
  })
})

describe('hold-out 12 / K1: the residue rule in another shape', () => {
  it('the deployment before a prefaced question stays owed', () => {
    const projection = derive('Deploy the release etc. please tell me why the shard failed?')
    const items = [...projection.items.values()]
    expect(items.some((item) => item.status === 'pending' && item.normalizedText.includes('Deploy the release')), JSON.stringify(items.map((i) => [i.normalizedText, i.status, i.authorityDisposition]))).toBe(true)
  })

  it('a question beside an order keeps the order', () => {
    const scopes = interpretMessage('Which credential rotated, and compress the archives?')
    expect(scopes.some((entry) => entry.authorityDisposition !== 'informational' && entry.text.includes('compress'))).toBe(true)
  })
})

describe('hold-out 12 / K2: a conflicting refspec beside an agreeing remote', () => {
  it('the conflicting field is open and the agreeing one is inherited', () => {
    const projection = derive([
      '推送仓库 /repo-d remote origin refspec refs/heads/main。',
      '推送仓库 /repo-d remote origin refspec refs/heads/release。',
      '推送。',
    ])
    const last = [...projection.items.values()].at(-1)!
    expect(last.requestedTarget?.repository).toBe('/repo-d')
    expect(last.requestedTarget?.remote).toBe('origin')
    expect(last.requestedTarget?.refspec).toBeUndefined()
    expect(last.targetCaptureStatus).toBe('clarification_required')
    expect(last.targetCaptureReasonCode).toBe('requested_target_field_ambiguous')
  })

  it('an agreeing pair is still inherited whole', () => {
    const projection = derive([
      '推送仓库 /repo-d remote origin refspec refs/heads/main。',
      '推送仓库 /repo-d remote origin refspec refs/heads/main。',
      '推送。',
    ])
    const last = [...projection.items.values()].at(-1)!
    expect(last.targetCaptureStatus).toBe('resolved')
    expect(last.requestedTarget).toEqual({ repository: '/repo-d', remote: 'origin', refspec: 'refs/heads/main' })
  })

  it('a single push target is unaffected', () => {
    const item = captureClause('推送仓库 /repo-d remote origin refspec refs/heads/main。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus).toBe('resolved')
  })
})

describe('hold-out 12 / K4: eligibility on the two reading shapes', () => {
  const legacy = (text: string): GuardItem => ({
    ...captureClause('占位', 'm1', 'R001', 1, { cwd: '/srv/app' }),
    normalizedText: text,
    directive: 'informational', authorityDisposition: 'informational', taskKind: 'inquiry',
    status: 'answered',
  })

  it('a recorded explanation is still inheritable', () => {
    const projection = createProjection()
    projection.enabled = true
    const record = legacy('Explain how you install foo and restart service api.')
    projection.items.set(record.id, record)
    expect(legacyRecordsNeedingReview(projection)).toEqual([])
  })

  it('a recorded order beside a question is checked', () => {
    const projection = createProjection()
    projection.enabled = true
    const record = legacy('Compress the archives and confirm whether the disk is full.')
    projection.items.set(record.id, record)
    expect(legacyRecordsNeedingReview(projection).map((finding) => finding.reason)).toEqual(['legacy_mixed_information_scope'])
  })
})
