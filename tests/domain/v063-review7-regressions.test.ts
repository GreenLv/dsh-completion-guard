import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { interpretMessage } from '../../src/domain/semantics.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import type { DerivedEnvelope } from '../../src/domain/types.js'

/**
 * The SEVENTH independent review's counterexamples, kept as regressions.
 *
 * Three defects, and the review named the two-sided requirement explicitly:
 * prevent an execution obligation from being closed by an answer AND prevent a
 * request for an EXPLANATION from becoming execution authority.
 *
 * F1. `Explain how to install foo and restart service api.` produced a restart
 *     obligation that the production authorizer returned `authorized` for. The
 *     coordinator sits INSIDE the question's object ("how to install X and
 *     restart Y"), so neither verb is an instruction; the same holds in Chinese
 *     (`解释一下如何安装并重启服务`). A question that merely stands beside an
 *     order (`What changed and archive the logs?`) still keeps its order — that
 *     clause has no interrogative object list — and an explanation FOLLOWED by a
 *     real order (`Explain the deploy. Then restart service api.`) still
 *     authorizes the restart.
 * F2. `Install the package etc. please tell me what changed?` was again one
 *     information range: the abbreviation tie-breaker only recognised a question
 *     that STARTS with a question word, so the politeness preface hid it. The
 *     rule is now structural: when a fragment is informational only because it
 *     ends interrogatively, a yes/no question covers the clause, while a trailing
 *     wh-question leaves any action head before it as a residue that stays owed.
 * F3. `提交仓库 /repo-a 分支 main。提交仓库 /repo-a 分支 release。提交。` made the
 *     last clause inherit `main`: inheritance deduplicated candidates by
 *     repository and copied the first source's whole field set. Uniqueness is now
 *     judged PER FIELD — the repository is shared, the branch conflicts, so the
 *     clause keeps the repository, leaves the branch open and denies authorization.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-review7', createdAt: 1 } }

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

describe('review 7 / F1: an explanation creates no authority, a following order does', () => {
  it.each([
    'Explain how to install foo and restart service api.',
    '解释一下如何安装并重启服务。',
  ])('%s is one undecided obligation that authorizes nothing', (text) => {
    // Tightened by the NINTH review: an explanation's sentence is not an
    // answerable information range, and nothing inside it is authority, because
    // the action may be exactly what the root asked to have explained.
    const projection = derive([text])
    const items = [...projection.items.values()]
    expect(items.length, text).toBe(1)
    for (const item of items) {
      expect(item.authorityDisposition, text).not.toBe('executable_now')
      expect(authorizeMutationFromProjection(projection, {
        action: 'restart', contractItemId: item.id, contractItemRevision: item.revision,
        resolvedTarget: { service_id: 'api' },
      }).status, text).not.toBe('authorized')
    }
  })

  it('the explanation never authorizes the action it asks about', () => {
    const projection = derive(['Explain how to install foo and restart service api.'])
    const restart = [...projection.items.values()].find((item) => item.semanticAction === 'restart')
    expect(restart).toBeUndefined()
    for (const item of projection.items.values()) {
      expect(authorizeMutationFromProjection(projection, {
        action: 'restart', contractItemId: item.id, contractItemRevision: item.revision,
        resolvedTarget: { service_id: 'api' },
      }).status).not.toBe('authorized')
    }
  })

  it.each([
    // The EIGHTH review tightened the shape: "and then" (and a comma before a
    // following verb) can belong to the operation ORDER BEING EXPLAINED, so an
    // authorization positive control has to be an explicitly SEPARATE
    // instruction — a sentence of its own.
    'Explain how the deploy works. Then restart service api.',
    '解释一下部署流程。然后重启 api 服务。',
  ])('%s still orders the restart', async (text) => {
    const projection = derive([text])
    const restart = [...projection.items.values()].find((item) => item.semanticAction === 'restart')
    expect(restart, JSON.stringify([...projection.items.values()].map((i) => [i.normalizedText, i.authorityDisposition, i.semanticAction, i.requestedTarget]))).toBeDefined()
    expect(restart!.authorityDisposition).toBe('executable_now')
    expect(authorizeMutationFromProjection(projection, {
      action: 'restart', contractItemId: restart!.id, contractItemRevision: restart!.revision,
      resolvedTarget: { service_id: 'api' },
    }).status).not.toBe('denied')
    // Preparation says the same thing about the same target.
    const prepared = await createPrepareTool({ getProjection: () => projection }).execute({
      item_id: restart!.id, semantic_action: 'restart', requested_target: { service_id: 'api' },
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(prepared.compatibility.status).toBe('compatible')
  })

  it.each([
    // Tightened by the eighth review: while the explanation's complement is open,
    // a coordinator — including "and then" — describes the operation order being
    // explained, so it creates no authority. The separate-instruction control
    // above is the form that does.
    'Explain how to deploy and then restart service api.',
    'Explain how to install foo, then restart service api.',
    'Tell me how to install foo, then publish package bar.',
  ])('%s stays one explanation', (text) => {
    const projection = derive([text])
    expect([...projection.items.values()].every((item) => item.authorityDisposition !== 'executable_now'), JSON.stringify([...projection.items.values()].map((i) => [i.normalizedText, i.authorityDisposition]))).toBe(true)
    const restart = [...projection.items.values()].find((item) => item.semanticAction === 'restart')
    if (restart) {
      expect(authorizeMutationFromProjection(projection, {
        action: 'restart', contractItemId: restart.id, contractItemRevision: restart.revision,
        resolvedTarget: { service_id: 'api' },
      }).status).not.toBe('authorized')
    }
  })

  it('a bare wh-clause followed by a coordinator keeps its order', () => {
    // The complement is NOT open here: the coordination opens a new predicate.
    for (const text of [
      'Tell me what changed and install the package.',
      'Explain the issue, sanitize all inputs.',
    ]) {
      const items = itemsOf([text])
      expect(items.some((item) => item.authorityDisposition !== 'informational'), JSON.stringify(items.map((i) => [i.normalizedText, i.authorityDisposition]))).toBe(true)
    }
  })

  it('a question beside an order still keeps the order', () => {
    for (const text of ['What changed and archive the logs?', '什么变了并归档日志？']) {
      const scopes = interpretMessage(text)
      expect(scopes.some((entry) => entry.authorityDisposition !== 'informational'), text).toBe(true)
    }
  })

  it('an explanation that names no question creates no execution obligation', () => {
    // "Explain the docs." is an explanation request: it may be answered
    // (informational) but it must never become a mutation.
    const scopes = interpretMessage('Explain the docs.')
    expect(scopes.every((entry) => entry.authorityDisposition !== 'executable_now')).toBe(true)
  })
})

describe('review 7 / F2: a prefaced question cannot close the execution before it', () => {
  it.each([
    'Install the package etc. please tell me what changed?',
    'Install the package etc. kindly report what changed?',
    'Install the package etc. 请告诉我什么变了？',
  ])('%s keeps a pending obligation', (text) => {
    const items = itemsOf([text])
    expect(items.length, text).toBeGreaterThan(0)
    expect(items.some((item) => item.status === 'pending' && item.authorityDisposition !== 'informational'), JSON.stringify(items.map((i) => [i.normalizedText, i.status, i.authorityDisposition]))).toBe(true)
  })

  it('the install survives the answering turn', () => {
    const items = itemsOf([{ text: 'Install the package etc. please tell me what changed?', answer: '收到。' }])
    expect(items.some((item) => item.normalizedText.includes('Install the package') && item.status === 'pending')).toBe(true)
  })

  it.each([
    // Found by the self-review sweep that followed the repair: the SESSION layer
    // dropped these before the reader ran, because its fragment test called the
    // whole fragment a question. It now uses the same residue rule as the
    // reader, so a question can neither close nor delete the order before it.
    'Archive the logs etc. 请说明一下哪些请求失败了？',
    '什么变了并归档日志？',
  ])('%s still produces the obligation', (text) => {
    const items = itemsOf([text])
    expect(items.length, text).toBeGreaterThan(0)
    expect(items.some((item) => item.status === 'pending' && item.authorityDisposition !== 'informational'), JSON.stringify(items.map((i) => [i.normalizedText, i.status, i.authorityDisposition]))).toBe(true)
  })

  it.each([
    // A yes/no question asks about the WHOLE clause, so no residue is claimed.
    '主题是不是需要更新呢？',
    '这个 bug 需要修复吗？',
    'Is there any update for the plugin?',
  ])('%s stays a single question', (text) => {
    const items = itemsOf([text])
    for (const item of items) expect(item.authorityDisposition, text).toBe('informational')
  })
})

describe('review 7 / F3: inheritance judges every field, not just the repository', () => {
  it('conflicting branches leave the branch open and deny authorization', () => {
    const projection = derive(['提交仓库 /repo-a 分支 main。', '提交仓库 /repo-a 分支 release。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.requestedTarget?.repository).toBe('/repo-a')
    expect(last.requestedTarget?.branch).toBeUndefined()
    expect(last.targetCaptureStatus).toBe('clarification_required')
    expect(last.targetCaptureReasonCode).toBe('requested_target_field_ambiguous')
    expect(authorizeMutationFromProjection(projection, {
      action: 'commit', contractItemId: last.id, contractItemRevision: last.revision,
      resolvedTarget: { repository: '/repo-a', branch: 'main' },
    }).status).toBe('denied')
    expect(authorizeMutationFromProjection(projection, {
      action: 'commit', contractItemId: last.id, contractItemRevision: last.revision,
      resolvedTarget: { repository: '/repo-a', branch: 'release' },
    }).status).toBe('denied')
  })

  it('two clauses naming the SAME repository and branch still inherit both', () => {
    const projection = derive(['提交仓库 /repo-a 分支 main。', '提交仓库 /repo-a 分支 main。', '提交。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.targetCaptureStatus).toBe('resolved')
    expect(last.requestedTarget).toMatchObject({ repository: '/repo-a', branch: 'main' })
    expect(authorizeMutationFromProjection(projection, {
      action: 'commit', contractItemId: last.id, contractItemRevision: last.revision,
      resolvedTarget: { repository: '/repo-a', branch: 'main' },
    }).status).not.toBe('denied')
  })

  it('a clause that names its own branch is unaffected', () => {
    const projection = derive(['提交仓库 /repo-a 分支 main。', '提交分支 release。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.requestedTarget).toMatchObject({ repository: '/repo-a', branch: 'release' })
    expect(last.targetCaptureStatus).toBe('resolved')
  })

  it('two spellings of one repository are not a field conflict', () => {
    const projection = derive(['提交仓库 /repo-b 的改动。', '推送仓库 /repo-b/ 的改动。', '拉取。'])
    const last = [...projection.items.values()].at(-1)!
    expect(last.targetCaptureStatus).toBe('resolved')
    expect(last.requestedTarget?.repository).toBe('/repo-b')
  })
})
