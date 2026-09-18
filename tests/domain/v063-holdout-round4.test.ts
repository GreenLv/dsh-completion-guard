import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE, legacyRecordsNeedingReview } from '../../src/domain/derive.js'
import { captureClause } from '../../src/domain/capture.js'
import { interpretMessage } from '../../src/domain/semantics.js'
import { needsReviewObligations } from '../../src/domain/closure.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope, type GuardItem } from '../../src/domain/types.js'

/**
 * 0.6.3 hold-out round 4 — regression coverage (was the independent set).
 *
 * Round 4 produced findings and its repairs changed the source, so round 4 is
 * regression coverage now; round 5 is the current independent set. Round 4 was
 * written against the task contract, in shape families absent from rounds 1-3
 * and from all three review batches that preceded it:
 *
 * - purpose clauses introduced by a gerund ("... for showing whether ...") and
 *   by a bare infinitive after a non-create verb;
 * - a purpose clause that CONTAINS a question word but whose main clause is an
 *   order, versus the same words with the question first;
 * - a request preface in front of Chinese investigation forms, and a preface in
 *   front of an order that also carries a condition;
 * - inheritance that fills a branch while the repository comes from an earlier
 *   clause of the SAME message rather than an earlier message;
 * - prepare/action agreement where only the refspec differs, where the action is
 *   non-stateful, and where the item is a prohibition;
 * - eligibility when the same unit holds a flagged record AND fresh work.
 *
 * Expectations come from the contract. A failure here is a source finding.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/opt/app', sessionHeader: { version: 3, id: 'v063-holdout4', createdAt: 1 } }

let seq = 0
function derive(input: Array<string | { text: string; answer?: string }>) {
  const turns = input.map((entry) => (typeof entry === 'string' ? { text: entry } : entry))
  seq = 0
  const events: DerivedEnvelope[] = [{
    seq: seq++, type: 'user/message', data: {
      source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' },
      content: [{ type: 'text', text: PROTOCOL_V5_NOTICE }],
    },
  }]
  turns.forEach((turn, index) => {
    const number = index + 1
    events.push(
      { seq: seq++, type: 'turn/start', data: { turn: number } },
      { seq: seq++, type: 'user/message', data: { turn: number, source: { kind: 'user' }, content: [{ type: 'text', text: turn.text }] } },
      { seq: seq++, type: 'assistant/message', data: { turn: number, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: turn.answer ?? '收到。' }] } } },
      { seq: seq++, type: 'turn/end', data: { turn: number, reason: { kind: 'completed' } } },
    )
  })
  return deriveProjection(events, config, scope, true).projection
}

const itemsOf = (texts: string[]) => [...derive(texts).items.values()]

describe('hold-out 4 / K1: purpose clauses in further shapes', () => {
  it.each([
    'Write a helper /opt/app/check.sh for showing whether the port is open.',
    'Create a log /opt/app/run.log to list which migrations ran.',
    'Draft a README section to explain how the cache is warmed.',
    'Update the README to describe what changed in the release.',
  ])('%s stays an order', (text) => {
    const items = itemsOf([text])
    expect(items.length, text).toBeGreaterThan(0)
    for (const item of items) expect(item.authorityDisposition, text).not.toBe('informational')
  })

  it('a question first and the same words as a purpose clause read differently', () => {
    const asked = interpretMessage('Check whether the port is open.')
    expect(asked).toHaveLength(1)
    expect(asked[0]!.authorityDisposition).toBe('informational')

    const ordered = interpretMessage('Write a helper for showing whether the port is open.')
    expect(ordered).toHaveLength(1)
    expect(ordered[0]!.directive).toBe('directive')
  })

  it('a preface in front of a Chinese investigation keeps it a question', () => {
    for (const text of ['请检查是否有更新。', '麻烦确认一下是否安装成功。', '然后检查是否有新版本。']) {
      const scopes = interpretMessage(text)
      expect(scopes.length, text).toBeGreaterThanOrEqual(1)
      expect(scopes.some((entry) => entry.authorityDisposition === 'informational'), text).toBe(true)
    }
  })

  it('a preface in front of an order carrying a condition stays held and reserved', () => {
    const items = itemsOf(['请安装这个包，如果可用的话。'])
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) {
      expect(item.authorityDisposition, item.normalizedText).not.toBe('informational')
      expect(item.status, item.normalizedText).toBe('pending')
    }
  })

  it('a mixed clause with an object question still splits into answer and work', () => {
    const scopes = interpretMessage('Create a report showing whether the tests passed and install the package.')
    // The creation is work and the install is work; no range here is answerable.
    expect(scopes.filter((entry) => entry.authorityDisposition === 'informational')).toHaveLength(0)
    expect(scopes.some((entry) => entry.authorityDisposition === 'executable_now')).toBe(true)
  })
})

describe('hold-out 4 / K2: same-message repository and cross-field inheritance', () => {
  it('a repository named in one clause of a message fills a branch named in another', () => {
    const items = itemsOf(['提交仓库 /opt/app 分支 main 的改动，然后提交分支 hotfix。'])
    const followUp = items.at(-1)!
    expect(followUp.requestedTarget).toMatchObject({ repository: '/opt/app', branch: 'hotfix' })
    expect(followUp.targetCaptureStatus).toBe('resolved')
  })

  it('two different branches in one message keep their own selections', () => {
    const items = itemsOf(['提交仓库 /opt/app 分支 main 的改动，然后提交仓库 /opt/app 分支 hotfix 的改动。'])
    const branches = items
      .filter((item) => item.semanticAction === 'commit')
      .map((item) => item.requestedTarget?.branch)
    expect(branches).toContain('main')
    expect(branches).toContain('hotfix')
  })

  it('a follow-up with no repository and no branch inherits both', () => {
    const items = itemsOf(['提交仓库 /opt/app 分支 release。', '提交。'])
    expect(items.at(-1)!.requestedTarget).toMatchObject({ repository: '/opt/app', branch: 'release' })
  })

  it('an unset branch is filled while the repository stays the follow-up choice', () => {
    const items = itemsOf(['提交仓库 /opt/app 分支 release。', '提交仓库 /opt/other。'])
    const followUp = items.at(-1)!
    expect(followUp.requestedTarget).toMatchObject({ repository: '/opt/other' })
    expect(followUp.targetSource?.kind).toBe('explicit_label')
  })
})

describe('hold-out 4 / K3: one verdict from two lanes', () => {
  const withItem = (text: string) => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause(text, 'm1', 'R001', 1, { cwd: '/opt/app' })
    projection.items.set(item.id, item)
    return { projection, item }
  }
  const prep = async (projection: ReturnType<typeof createProjection>, item: GuardItem, action: string, target?: Record<string, unknown>) =>
    createPrepareTool({ getProjection: () => projection }).execute(
      { item_id: item.id, semantic_action: action, ...(target === undefined ? {} : { requested_target: target }) } as never,
      undefined as never,
    ) as Promise<Record<string, unknown>>

  it('only the refspec differing is incompatible and denied', async () => {
    const { projection, item } = withItem('推送仓库 /opt/app remote upstream refspec refs/heads/main。')
    const target = { repository: '/opt/app', remote: 'upstream', refspec: 'refs/heads/other' }
    const prepared = await prep(projection, item, 'push', target)
    expect((prepared.compatibility as { status: string }).status).toBe('incompatible')
    expect(authorizeMutationFromProjection(projection, {
      action: 'push', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: target as Parameters<typeof authorizeMutationFromProjection>[1]['resolvedTarget'],
    })).toMatchObject({ status: 'denied' })
  })

  it('a non-stateful item prepares for its own action and the gate has no stateful duty', async () => {
    const { projection, item } = withItem('运行 pnpm test。')
    const prepared = await prep(projection, item, 'test')
    // Either the compatibility judgement is absent for a non-stateful action or
    // it is not `incompatible`: a read-only check has no target to authorize.
    const status = (prepared.compatibility as { status?: string } | undefined)?.status
    expect(status === undefined || status !== 'incompatible').toBe(true)
  })

  it('a prohibition item is never reported compatible', async () => {
    const { projection, item } = withItem('不要推送仓库 /opt/app。')
    const prepared = await prep(projection, item, 'push')
    const status = (prepared.compatibility as { status?: string } | undefined)?.status
    expect(status).toBe('blocked')
    expect((prepared.compatibility as { reason_codes: string[] }).reason_codes).toContain('prohibition_active')
  })

  it('a complete selector prepares and is authorized', async () => {
    const { projection, item } = withItem('推送仓库 /opt/app remote upstream refspec refs/heads/main。')
    const target = { repository: '/opt/app', remote: 'upstream', refspec: 'refs/heads/main' }
    const prepared = await prep(projection, item, 'push', target)
    expect((prepared.compatibility as { status: string }).status).toBe('compatible')
    expect(authorizeMutationFromProjection(projection, {
      action: 'push', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: target as Parameters<typeof authorizeMutationFromProjection>[1]['resolvedTarget'],
    }).status).not.toBe('denied')
  })
})

describe('hold-out 4 / K4: eligibility beside fresh work', () => {
  it('a flagged record blocks even when the same unit also has fresh pending work', () => {
    const projection = derive([
      { text: '安装主题 A，检查是否有更新。' },
      { text: '记录变更。' },
    ])
    const flagged = [...projection.items.values()][0]!
    Object.assign(flagged, {
      normalizedText: '安装主题 A，检查是否有更新。',
      directive: 'informational', authorityDisposition: 'informational', taskKind: 'inquiry',
      status: 'answered',
    })
    // The upgrade reading is applied to the record; the fresh work is untouched.
    const flaggedProjection = createProjection()
    flaggedProjection.enabled = true
    flaggedProjection.boundaryProtocol = 5
    flaggedProjection.currentUnitId = 'U001'
    const record: GuardItem = {
      ...captureClause('占位', 'm1', 'R001', 1, { cwd: '/opt/app' }),
      unitId: 'U001', status: 'answered',
      normalizedText: '安装主题 A，检查是否有更新。',
      directive: 'informational', authorityDisposition: 'informational', taskKind: 'inquiry',
      needsReview: { reason: 'legacy_mixed_information_scope', checkId: 'eligibility:0.6.3', recordedAtRevision: 1 },
    }
    flaggedProjection.items.set(record.id, record)
    flaggedProjection.items.set('R900', {
      ...captureClause('记录变更。', 'm2', 'R900', 2, { cwd: '/opt/app' }),
      unitId: 'U001', status: 'pending',
    })
    expect(needsReviewObligations(flaggedProjection).map((item) => item.id)).toEqual([record.id])
  })

  it('a current-rule capture is never flagged, and a historical mixed one always is', () => {
    const fresh = derive(['安装主题 A，检查是否有更新。'])
    expect(legacyRecordsNeedingReview(fresh)).toEqual([])
    expect([...fresh.items.values()].every((item) => item.needsReview === undefined)).toBe(true)

    const historical = createProjection()
    historical.enabled = true
    const record: GuardItem = {
      ...captureClause('占位', 'm1', 'R001', 1, { cwd: '/opt/app' }),
      normalizedText: '安装主题 A，检查是否有更新。',
      directive: 'informational', authorityDisposition: 'informational', taskKind: 'inquiry',
      status: 'answered',
    }
    historical.items.set(record.id, record)
    expect(legacyRecordsNeedingReview(historical)).toHaveLength(1)
  })

  it('a purpose-clause capture is never flagged as a historical information record', () => {
    const projection = derive(['Create a file /opt/app/status.txt to show what changed.'])
    expect(legacyRecordsNeedingReview(projection)).toEqual([])
    expect([...projection.items.values()].every((item) => item.status !== 'answered')).toBe(true)
  })
})
