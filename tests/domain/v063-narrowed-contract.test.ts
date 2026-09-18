import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE, applyUpgradeEligibility, legacyRecordsNeedingReview } from '../../src/domain/derive.js'
import { interpretMessage, isQuestionScopeNeedingReview, opensWithDirective, qualificationOfClause } from '../../src/domain/semantics.js'
import { captureClause } from '../../src/domain/capture.js'
import { certifyCheckpoint } from '../../src/domain/checkpoint.js'
import { hasCurrentCertificate } from '../../src/domain/goal-gate.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope, type GuardItem } from '../../src/domain/types.js'

/**
 * 0.6.3 NARROWED CONTRACT (user-approved scope change) — the invariant suite.
 *
 * The earlier rounds required the coordinated second action of a mixed
 * question/action clause to survive as its own ORDER. That requirement is
 * withdrawn: when a question, an explanation, an investigation or an action share
 * ONE governed clause and the action cannot be proven independent, the whole clause
 * is one UNDECIDED obligation. It is captured, it cannot be closed by an answer, it
 * cannot take a completion certificate, and it authorizes nothing.
 *
 * What the narrowed contract keeps, and this file pins:
 *
 * - pure questions are answerable;
 * - plain explicit instructions with a legal target are executable;
 * - an instruction that clearly LEFT the governed scope (its own sentence, or a
 *   separate clause) is executable;
 * - target ambiguity is still refused;
 * - the qualification is established once, by the reader, before any partition, and
 *   is then INHERITED and CONSUMED — the gate and preparation read the stored field,
 *   never a re-analysis of the split text.
 *
 * The four counterexamples that opened this round are pinned here, together with the
 * group transformations the review asked for.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/srv/app', sessionHeader: { version: 3, id: 'v063-narrowed', createdAt: 1 } }

let seq = 0
function derive(texts: string | string[]) {
  if (typeof texts === 'string') texts = [texts]
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

function deriveWithAnswer(text: string, answer: string) {
  seq = 0
  const events: DerivedEnvelope[] = [
    {
      seq: seq++, type: 'user/message', data: {
        source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' },
        content: [{ type: 'text', text: PROTOCOL_V5_NOTICE }],
      },
    },
    { seq: seq++, type: 'turn/start', data: { turn: 1 } },
    { seq: seq++, type: 'user/message', data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text }] } },
    { seq: seq++, type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: answer }] } } },
    { seq: seq++, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  return deriveProjection(events, config, scope, true).projection
}

function itemsOf(projection: ReturnType<typeof derive>): GuardItem[] {
  return [...projection.items.values()]
}

/** Every action the obligation names — its main action and its whole action plan. */
function actionsOf(item: GuardItem): string[] {
  return [...new Set([
    ...(item.semanticAction && item.semanticAction !== 'generic_run' ? [item.semanticAction] : []),
    ...(item.actionPlan ?? []).map((entry) => entry.action),
  ])]
}

function decisions(projection: ReturnType<typeof derive>): string[] {
  const out: string[] = []
  for (const item of itemsOf(projection)) {
    for (const action of actionsOf(item)) {
      const planTarget = (item.actionPlan ?? []).find((entry) => entry.action === action)?.requestedTarget
      out.push(`${item.normalizedText}#${action}:${authorizeMutationFromProjection(projection, {
        action, contractItemId: item.id, contractItemRevision: item.revision,
        resolvedTarget: planTarget ?? item.requestedTarget ?? {},
      } as never).status}`)
    }
  }
  return out
}

/** The four counterexamples the fourteenth review returned the batch with. */
const REVIEW_COUNTEREXAMPLES = [
  'Check whether the technicians archive records that are complete and restart service api.',
  'Check whether the technicians ensure the cache is valid and restart service api.',
  '负责生产环境维护的运维人员是否安装 foo 并重启 api 服务。',
  '负责生产环境维护的运维人员是不是安装 foo 并重启 api 服务。',
]

/**
 * Group transformations of the same invariant: changing the subject, the verb
 * vocabulary, the object's modifiers, the language, the punctuation or the
 * conjunction must never turn a governed clause into authority. None of these may
 * be authorized, and every one of them must stay CAPTURED.
 */
const TRANSFORMATIONS = [
  // subject: short, long, pronominal, 由-phrase, English subject
  '维护人员是否安装 foo 并重启 api 服务。',
  '负责生产环境维护与夜间值守的运维人员是否安装 foo 并重启 api 服务。',
  '他们是否安装 foo 并重启 api 服务。',
  '是否由运维人员安装 foo 并重启 api 服务。',
  'Check whether the team installs foo and restarts service api.',
  // verbs: known and unknown, in either conjunct
  '检查程序是否安装更新并重启 api 服务。',
  '检查程序是否重排索引并重启 api 服务。',
  '确认小王是否更新依赖并重启 api 服务。',
  'Check whether the operators archive the logs and restart service api.',
  'Check whether the operators bootstrap the environment and restart service api.',
  // object modifiers, relative clauses and nested complements
  '检查承包商是否运送完好的封装并重启 api 服务。',
  'Check whether the technicians install updates that are available and restart service api.',
  '检查是否有人安装有效的配置并重启 api 服务。',
  '确认审计人是否加盖有效的印章并重启 api 服务。',
  // punctuation and conjunction variants inside ONE clause
  '检查是否有新版本并且安装这个主题。',
  '检查是否有新版本以及安装这个主题。',
  'Check whether an update exists and install the package.',
  '检查服务是否正常并记录变更。',
  '确认缓存是否有效并安装依赖。',
  'Verify whether the lock file is current and install the package.',
  // postposed interrogative over coordinated actions
  '核对一下重启 api 服务并归档日志是否安全。',
  '检查一下安装 foo 并重启 api 服务是否安全。',
]

describe('narrowed contract / K1: a governed clause is one undecided obligation', () => {
  it.each([...REVIEW_COUNTEREXAMPLES, ...TRANSFORMATIONS])(
    '%s is captured, undecided, and authorizes nothing', (text) => {
      const projection = derive(text)
      const items = itemsOf(projection)
      // 4. "undecided" must keep the obligation: never items = [].
      expect(items.length, text).toBeGreaterThan(0)
      expect(items.every((item) => item.authorityDisposition !== 'executable_now'), text).toBe(true)
      expect(items.every((item) => item.authorityDisposition !== 'informational'), text).toBe(true)
      expect(items.some((item) => item.authorityDisposition === 'unresolved'), text).toBe(true)
      expect(items.some((item) => item.status === 'pending'), text).toBe(true)
      // The qualification travels with the item and is restricted.
      expect(items.every((item) => item.executionQualification?.status === 'restricted'), text).toBe(true)
      expect(isQuestionScopeNeedingReview(items[0]!.normalizedText), text).toBe(true)
      for (const decision of decisions(projection)) {
        expect(decision.endsWith(':authorized'), `${text} / ${decision}`).toBe(false)
      }
    })

  it.each(REVIEW_COUNTEREXAMPLES)('%s is refused where it is prepared too', async (text) => {
    const projection = derive(text)
    const item = itemsOf(projection)[0]!
    const action = actionsOf(item)[0] ?? 'restart'
    const planTarget = (item.actionPlan ?? []).find((entry) => entry.action === action)?.requestedTarget
    const prepared = await createPrepareTool({ getProjection: () => projection }).execute({
      item_id: item.id, semantic_action: action, requested_target: planTarget ?? item.requestedTarget ?? {},
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(prepared.compatibility.status, text).not.toBe('compatible')
  })

  it.each(REVIEW_COUNTEREXAMPLES)('%s cannot be closed by an ordinary answer', (text) => {
    const projection = deriveWithAnswer(text, '好的，已经处理。')
    for (const item of itemsOf(projection)) {
      expect(item.status, `${text}: ${item.normalizedText}`).toBe('pending')
      expect(item.answeredBy, `${text}: ${item.normalizedText}`).toBeUndefined()
    }
  })

  it('an undecided obligation cannot take a completion certificate', () => {
    const projection = derive('负责生产环境维护的运维人员是否安装 foo 并重启 api 服务。')
    const result = certifyCheckpoint(projection, [], 'C1')
    expect(result.status).toBe('incomplete')
    expect(hasCurrentCertificate(projection)).toBe(false)
  })

  it('the reading is decided BEFORE the partition: every child inherits it', () => {
    // The same clause read as scopes, re-derived through the projection, and read
    // again after a recovery-style replay must agree, and a partition child may not
    // be promoted by its own action head.
    const text = '负责生产环境维护的运维人员是否安装 foo 并重启 api 服务。'
    const scopes = interpretMessage(text)
    expect(scopes).toHaveLength(1)
    expect(scopes[0]!.qualification.status).toBe('restricted')
    const once = derive(text)
    const twice = derive(text)
    const snapshot = (projection: ReturnType<typeof derive>) =>
      itemsOf(projection).map((item) => [item.normalizedText, item.authorityDisposition, item.executionQualification?.status ?? null])
    expect(snapshot(once)).toEqual(snapshot(twice))
    for (const item of itemsOf(once)) {
      expect(item.interpretationFingerprint, item.normalizedText).toBeDefined()
      expect(item.executionQualification?.status, item.normalizedText).toBe('restricted')
    }
  })
})

/**
 * The concentrated review of this batch returned three P1s about how the
 * qualification is ESTABLISHED. All three share one root cause: `granted` was the
 * default when no governed pattern matched, and the parent scope was computed after
 * the sentence split. The repair makes `granted` a POSITIVE finding and protects the
 * span first:
 *
 * - a clause whose own question content the head reader could not classify is
 *   restricted and indivisible (`I wonder whether the technicians restart service api.`);
 * - a quoted span keeps its parent scope across sentence marks, so nothing inside a
 *   quote is re-qualified after the split
 *   (`Explain this instruction: "Install foo. Restart service api."`);
 * - a postposed interrogative protects the clause with or without a question mark
 *   (`安装 foo 并重启 api 服务是否可行。`).
 */
describe('narrowed contract / K1: qualification is a positive finding', () => {
  const UNCLASSIFIED_OR_QUOTED = [
    // An unclassified question head, in several spellings.
    'I wonder whether the technicians restart service api.',
    'I am not sure whether the technicians restart service api.',
    '想问一下运维人员是否重启 api 服务。',
    // A quoted parent scope with more than one sentence inside it.
    'Explain this instruction: "Install foo. Restart service api."',
    'Explain this: “Install foo。Restart service api。”',
    // A postposed interrogative, with and without the question mark.
    '安装 foo 并重启 api 服务是否可行。',
    '安装 foo 并重启 api 服务是否可行？',
    'Check whether the technicians archive the records and restart service api.',
    // The quote style must not matter, nor a longer quote.
    'Explain this instruction: "Install foo and restart service api. Then report back."',
  ]

  it.each(UNCLASSIFIED_OR_QUOTED)('%s is one undecided obligation that authorizes nothing', (text) => {
    const projection = derive(text)
    const items = itemsOf(projection)
    expect(items.length, text).toBeGreaterThan(0)
    expect(items.every((item) => item.authorityDisposition !== 'executable_now'), text).toBe(true)
    expect(items.every((item) => item.executionQualification?.status === 'restricted'), text).toBe(true)
    for (const decision of decisions(projection)) {
      expect(decision.endsWith(':authorized'), `${text} / ${decision}`).toBe(false)
    }
  })

  it.each(UNCLASSIFIED_OR_QUOTED)('%s keeps every action it names visible', (text) => {
    const items = itemsOf(derive(text))
    expect(items.some((item) => item.status === 'pending'), text).toBe(true)
  })

  it('a quoted command alone never becomes an instruction', () => {
    const scopes = interpretMessage('Explain this instruction: "重启 api 服务。"')
    expect(scopes.every((entry) => entry.authorityDisposition !== 'executable_now')).toBe(true)
  })
})

/**
 * The second concentrated review returned two more P1s about ESTABLISHMENT, both
 * closed by the same principle ("a directive, not a mention; the parent scope
 * first"):
 *
 * - NAMING an action is not ordering it. `The technicians restart service api every
 *   night.` and `日志显示运维人员重启 api 服务。` are statements; granting them
 *   authorized a restart the root never asked for. `granted` now requires a
 *   DIRECTIVE: an imperative in the root's voice (`opensWithDirective`), and a
 *   report or a third-party statement is restricted.
 * - Every quote style owns its punctuation: straight and curly doubles, single
 *   quotes at a word boundary, and 「」/『』. A sentence mark inside any of them no
 *   longer opens a clause of the parent scope.
 */
describe('narrowed contract / K1: a directive, not a mention; the parent scope first', () => {
  const STATEMENTS_MENTIONING_WORK = [
    'The technicians restart service api every night.',
    '日志显示运维人员重启 api 服务。',
    '运维人员每天晚上重启 api 服务。',
    'The build failed because the operator restarted service api.',
  ]

  const QUOTED_PARENT_SCOPES = [
    "Explain this instruction: 'Install foo. Restart service api.'",
    '解释这条指令：「安装 foo。重启 api 服务。」',
    'Explain this instruction: "Install foo. Restart service api."',
    '解释这条指令：『安装 foo。重启 api 服务。』',
  ]

  it.each([...STATEMENTS_MENTIONING_WORK, ...QUOTED_PARENT_SCOPES])(
    '%s is one restricted obligation that authorizes nothing', (text) => {
      const projection = derive(text)
      const items = itemsOf(projection)
      expect(items.length, text).toBeGreaterThan(0)
      expect(items.every((item) => item.authorityDisposition !== 'executable_now'), text).toBe(true)
      expect(items.every((item) => item.executionQualification?.status === 'restricted'), text).toBe(true)
      for (const decision of decisions(projection)) {
        expect(decision.endsWith(':authorized'), `${text} / ${decision}`).toBe(false)
      }
    })

  it.each(QUOTED_PARENT_SCOPES)('%s keeps the quoted span in ONE clause', (text) => {
    const scopes = interpretMessage(text)
    expect(scopes, text).toHaveLength(1)
  })

  it.each(STATEMENTS_MENTIONING_WORK)('%s is not a directive', (text) => {
    expect(opensWithDirective(text), text).toBe(false)
    expect(qualificationOfClause(text).status, text).toBe('restricted')
  })

  it.each([
    '重启 api 服务。',
    'Then restart service api.',
    '请更新插件。',
    'Restart service api.',
  ])('%s is a directive and keeps its authority', (text) => {
    expect(opensWithDirective(text), text).toBe(true)
    expect(qualificationOfClause(text).status, text).toBe('granted')
  })

  it('an explicit root restatement establishes a fresh execution reading', () => {
    // The contract's "explicit user authorization" route: the root says what an
    // obligation means, and that is a directive even when its own verb is unknown.
    const text = '把应用包 foo 版本 0.6.3 配置档 default 明确为 apply'
    expect(qualificationOfClause(text).status).toBe('granted')
    const item = captureClause(text, 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.executionQualification?.status).toBe('granted')
    expect(item.semanticAction).toBe('apply')
  })
})

/**
 * The third concentrated review showed that the two newest positive findings were
 * still too generous:
 *
 * - a RESTATEMENT was granted on its own wording, so recording, classifying or
 *   forbidding an action authorized it
 *   (`把重启 api 服务记为待讨论事项。`, `Record restart service api as a hypothetical
 *   example.`, `把重启 api 服务明确为禁止操作。`). The restated CONTENT must itself
 *   be an instruction — that is what the sanctioned clarification route says.
 * - an action at the clause HEAD was taken for an imperative, so a descriptive
 *   predicate ("重启 api 服务是一个危险操作。", "Restart service api is dangerous.")
 *   authorized the action it describes.
 */
describe('narrowed contract / K1: authorization intent, not wording', () => {
  const NON_AUTHORIZING_RESTATEMENTS = [
    '把重启 api 服务记为待讨论事项。',
    'Record restart service api as a hypothetical example.',
    '把重启 api 服务明确为禁止操作。',
  ]
  const DESCRIPTIONS_OF_WORK = [
    '重启 api 服务是一个危险操作。',
    'Restart service api is dangerous.',
    '重启 api 服务会导致停机。',
  ]
  const AUTHORIZING_RESTATEMENTS = [
    '把更新插件明确为 apply package demo@2.0.0 profile web',
    '把应用包 foo 版本 0.6.3 配置档 default 明确为 apply',
  ]

  /**
   * The restated CONTENT must pass the same authorization judgement a clause passes
   * and the item must take its action from that content. Prose that merely mentions
   * an operation is not an instruction, and the action named BEFORE the restatement
   * is never authorized.
   */
  const RESTATEMENTS_MENTIONING_WORK = [
    '把重启 api 服务记为需要讨论的重启操作。',
    '把重启 api 服务明确为解释重启流程。',
    'Record restart service api as a description of how technicians restart service api.',
    '把重启 api 服务明确为检查日志。',
  ]

  it.each(RESTATEMENTS_MENTIONING_WORK)('%s never authorizes the pre-restatement action', (text) => {
    const projection = derive(text)
    for (const decision of decisions(projection)) {
      expect(decision.endsWith(':authorized'), `${text} / ${decision}`).toBe(false)
    }
    // The restart the clause names BEFORE the restatement is not in the item's
    // identity, so the gate cannot authorize it even when the restated content is a
    // valid directive of its own.
    const item = itemsOf(projection)[0]
    expect(authorizeMutationFromProjection(projection, {
      action: 'restart', contractItemId: item!.id, contractItemRevision: item!.revision,
      resolvedTarget: { service_id: 'api' },
    } as never).status, text).toBe('denied')
  })

  it.each(RESTATEMENTS_MENTIONING_WORK.slice(0, 3))('%s stays restricted', (text) => {
    // Prose that mentions an operation is not an instruction: the clause is
    // restricted, and the action it mentions stays visible in the plan without
    // becoming authority. (The fourth case restates a REAL directive — "检查日志" —
    // and is handled by the identity binding below.)
    expect(qualificationOfClause(text).status, text).toBe('restricted')
  })

  it.each([
    '把重启 api 服务明确为重启 worker 服务。',
    'Rebind restart service api as restart service worker.',
  ])('%s binds the NEW target and refuses the old one', (text) => {
    const item = captureClause(text, 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.requestedTarget?.service_id, text).toBe('worker')
    const projection = derive(text)
    // The restatement IS a directive for the NEW target, so its own plan may be
    // authorized; what must never be authorized again is the target it replaced.
    const live = itemsOf(projection)[0]!
    expect(authorizeMutationFromProjection(projection, {
      action: 'restart', contractItemId: live.id, contractItemRevision: live.revision,
      resolvedTarget: { service_id: 'api' },
    } as never).status, text).toBe('denied')
  })

  it.each([
    // K2 applies to a PLAIN capture too: the uniqueness result is consumed by the
    // ordinary path and by every action-plan entry, not only by a restatement.
    'Restart service api or worker.',
    '提交仓库 /repo-a 分支 main 或 release。',
    // Git identities are case-SENSITIVE: `main` and `Main` are two branches, and a
    // refspec is an identity value too.
    '提交仓库 /repo-a 分支 main 或 Main。',
    'Push repository /repo-a remote origin refspec main:main or main:Main.',
    // A package spec is a TUPLE: the same name with two versions is two targets, and a
    // spec version that conflicts with a labelled version is a conflict.
    'install package foo@1.0.0 or foo@2.0.0.',
    'install package foo@1.0.0 version 2.0.0.',
    'publish package foo@1.0.0 or foo@2.0.0 registry https://registry.example.invalid/.',
    // The Chinese refspec label is a field label like any other.
    '推送仓库 /repo-a 远端 origin 引用规范 main:main 或 main:release。',
    '把重启 api 服务或 worker 服务明确为 restart。',
    '把重启 api 服务明确为重启 worker 服务或 cache 服务。',
    // The label-first list the extractor reads: the candidate enumeration must use
    // the extractor's own grammar, or `api or worker` after a shared label is missed.
    'Rebind restart service api or worker as restart.',
    'Rebind restart service api as restart service worker or cache.',
    // A unique package does not prove a unique TARGET: the version and the profile
    // are identity fields too.
    '把应用包 foo 版本 0.6.3 配置档 default 明确为 apply package foo version 0.6.4 or 0.6.5 profile default。',
    '把应用包 foo 版本 0.6.3 配置档 default 明确为 apply package foo version 0.6.4 profile web or prod。',
  ])('%s proves no unique selection and is refused', (text) => {
    // Neither span may take its first candidate for a decision: the OLD span is
    // ambiguous in the first input and the RESTATED span in the second, and both are
    // reported with the ambiguity code instead of `resolved`.
    const item = captureClause(text, 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.targetCaptureStatus, text).toBe('clarification_required')
    expect(item.targetCaptureReasonCode, text).toBe('requested_target_field_ambiguous')
    const projection = derive(text)
    const live = itemsOf(projection)[0]!
    const action = actionsOf(live)[0] ?? 'restart'
    const planTarget = (live.actionPlan ?? []).find((entry) => entry.action === action)?.requestedTarget
    for (const target of [item.requestedTarget ?? {}, planTarget ?? {}, { service_id: 'api' }, { service_id: 'worker' }]) {
      expect(authorizeMutationFromProjection(projection, {
        action, contractItemId: live.id, contractItemRevision: live.revision,
        resolvedTarget: target,
      } as never).status, `${text} / ${JSON.stringify(target)}`).toBe('denied')
    }
  })

  it('the same value repeated is still one candidate', () => {
    // Only DISTINCT values are ambiguous: `main 或 main` selects one branch.
    for (const text of [
      '提交仓库 /repo-a 分支 main 或 main。',
      'Push repository /repo-a remote origin refspec main:main or main:main.',
      'install package foo@1.0.0 version 1.0.0.',
      'install package foo@1.0.0.',
    ]) {
      const item = captureClause(text, 'm1', 'R001', 1, { cwd: '/srv/app' })
      expect(item.targetCaptureStatus, text).toBe('resolved')
    }
  })

  it('a partial restatement inherits PER FIELD', () => {
    // The restated span names package and version but not the profile: the profile
    // comes from the obligation being clarified, while the version it DID name wins.
    const item = captureClause(
      '把应用包 foo 版本 0.6.3 配置档 default 明确为 apply package foo version 0.6.4。',
      'm1', 'R001', 1, { cwd: '/srv/app' },
    )
    expect(item.requestedTarget).toMatchObject({ package_id: 'foo', version: '0.6.4', profile: 'default' })
    expect(item.targetCaptureStatus).toBe('resolved')
  })

  it('a restatement that OMITS the target inherits the clarified one', () => {
    // The restated content is just `apply`: the package identity comes from the
    // obligation the restatement clarifies, and only because it is unambiguous.
    const item = captureClause('把应用包 foo 版本 0.6.3 配置档 default 明确为 apply', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.semanticAction).toBe('apply')
    expect(item.requestedTarget).toMatchObject({ package_id: 'foo', version: '0.6.3', profile: 'default' })
    expect(item.targetCaptureStatus).toBe('resolved')
  })

  it('a restatement binds the action to its own content', () => {
    // "检查日志" is a real directive, so the restatement is granted — but its action
    // is the inspection, never the restart named before it.
    const text = '把重启 api 服务明确为检查日志。'
    expect(qualificationOfClause(text).status).toBe('granted')
    const item = captureClause(text, 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(item.semanticAction).not.toBe('restart')
    expect(actionsOf(item)).not.toContain('restart')
  })

  it.each([...NON_AUTHORIZING_RESTATEMENTS, ...DESCRIPTIONS_OF_WORK])(
    '%s is restricted and authorizes nothing', (text) => {
      expect(qualificationOfClause(text).status, text).toBe('restricted')
      const projection = derive(text)
      const items = itemsOf(projection)
      expect(items.length, text).toBeGreaterThan(0)
      expect(items.every((item) => item.authorityDisposition !== 'executable_now'), text).toBe(true)
      for (const decision of decisions(projection)) {
        expect(decision.endsWith(':authorized'), `${text} / ${decision}`).toBe(false)
      }
    })

  it.each(AUTHORIZING_RESTATEMENTS)('%s restates an INSTRUCTION and is granted', (text) => {
    expect(qualificationOfClause(text).status, text).toBe('granted')
    expect(captureClause(text, 'm1', 'R001', 1, { cwd: '/srv/app' }).executionQualification?.status, text).toBe('granted')
  })

  it('a directive beside a description keeps its own authority, and the description adds none', () => {
    const text = '重启 api 服务，这是一个危险操作。'
    const scopes = interpretMessage(text)
    expect(scopes.some((entry) => entry.authorityDisposition === 'executable_now' && entry.text.includes('重启 api 服务'))).toBe(true)
    // The description names no operation, so it adds no action to the plan.
    const actions = itemsOf(derive(text)).flatMap((item) => actionsOf(item))
    expect(new Set(actions)).toEqual(new Set(['restart']))
  })
})

describe('narrowed contract / positive controls: the scope that did NOT narrow', () => {
  it.each([
    '检查是否有新版本。',
    '检查一下本地插件和皮肤是否有更新',
    'Is there any update for the plugin?',
    '这份文档可不可以更新？',
  ])('%s is a pure question and stays answerable', (text) => {
    const scopes = interpretMessage(text)
    expect(scopes.some((entry) => entry.authorityDisposition === 'informational'), text).toBe(true)
    for (const scope of scopes) expect(scope.authorityDisposition, text).not.toBe('executable_now')
  })

  it('a plain explicit instruction with a legal unique target is executable', () => {
    const projection = derive('重启 api 服务。')
    const item = itemsOf(projection)[0]!
    expect(item.authorityDisposition).toBe('executable_now')
    expect(item.executionQualification).toEqual({ status: 'granted', reason: 'plain_instruction' })
    const decision = authorizeMutationFromProjection(projection, {
      action: 'restart', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: item.requestedTarget ?? {},
    } as never)
    expect(decision.status).toBe('authorized')
  })

  it('an instruction that clearly left the governed scope is executable', () => {
    // The user's own positive control: a separate sentence.
    const scopes = interpretMessage('Explain how the team deploys. Then restart service api.')
    const order = scopes.find((entry) => entry.text.includes('restart service api'))
    expect(order?.authorityDisposition, JSON.stringify(scopes.map((entry) => [entry.authorityDisposition, entry.text]))).toBe('executable_now')
    expect(order?.qualification).toEqual({ status: 'granted', reason: 'plain_instruction' })
    // …and a separate clause of the same sentence keeps its authority too.
    const separate = interpretMessage('检查是否存在更新；安装新主题；')
    expect(separate.some((entry) => entry.authorityDisposition === 'executable_now' && entry.text.includes('安装新主题'))).toBe(true)
  })

  it('a purpose clause inside an order does not govern the order', () => {
    // The question is the purpose span's object, not the clause's own question.
    // The verb is one the reader recognises: an unrecognised verb is still refused
    // (see the vocabulary boundary in the contract revision note), and this control
    // isolates the SPAN rule from that boundary.
    const scopes = interpretMessage('清理日志以便确认哪些请求失败。')
    expect(scopes.every((entry) => entry.authorityDisposition === 'executable_now')).toBe(true)
    expect(scopes[0]!.qualification.status).toBe('granted')
  })

  it('target ambiguity is still refused', () => {
    const projection = derive('提交仓库 /repo-b 与 /repo-c。')
    const item = itemsOf(projection)[0]!
    expect(item.targetCaptureStatus).toBe('clarification_required')
    expect(item.targetCaptureReasonCode).toBe('requested_target_repository_ambiguous')
    expect(authorizeMutationFromProjection(projection, {
      action: 'commit', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: { repository: '/repo-b' },
    } as never).status).toBe('denied')
  })
})

describe('narrowed contract / qualification provenance and consumption', () => {
  it('capture writes the qualification the reader established', () => {
    const granted = captureClause('重启 api 服务。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    expect(granted.executionQualification).toEqual({ status: 'granted', reason: 'plain_instruction' })
    const restricted = captureClause('负责生产环境维护的运维人员是否安装 foo 并重启 api 服务。', 'm2', 'R002', 2, { cwd: '/srv/app' })
    expect(restricted.executionQualification?.status).toBe('restricted')
    expect(restricted.actionPlan?.length ?? 0).toBeGreaterThan(0)
  })

  it('the GATE reads the stored qualification, not the item text', () => {
    // The SAME plain order and the SAME target: only the stored qualification
    // differs. The reader would grant this text, so the restricted call proves the
    // gate consumes the stored field and never re-analyses the split text.
    const text = '重启 api 服务。'
    const build = (status: 'granted' | 'restricted') => {
      const projection = derive(text)
      const item = itemsOf(projection)[0]!
      item.executionQualification = { status, reason: status === 'granted' ? 'plain_instruction' : 'governed_scope' }
      const action = actionsOf(item)[0]!
      const planTarget = (item.actionPlan ?? []).find((entry) => entry.action === action)?.requestedTarget
      return {
        item,
        projection,
        request: { action, contractItemId: item.id, contractItemRevision: item.revision, resolvedTarget: planTarget ?? item.requestedTarget ?? {} },
      }
    }
    const granted = build('granted')
    expect(authorizeMutationFromProjection(granted.projection, granted.request as never).status).toBe('authorized')
    const restricted = build('restricted')
    expect(authorizeMutationFromProjection(restricted.projection, restricted.request as never)).toMatchObject({
      status: 'denied', reasonCode: 'mutation_item_not_executable',
    })
  })

  it('a record with NO qualification is refused at both ends', async () => {
    const projection = createProjection()
    projection.enabled = true
    const item = captureClause('重启 api 服务。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    delete item.executionQualification
    projection.items.set(item.id, item)
    expect(authorizeMutationFromProjection(projection, {
      action: 'restart', contractItemId: item.id, contractItemRevision: item.revision,
      resolvedTarget: item.requestedTarget ?? {},
    } as never).status).toBe('denied')
    const prepared = await createPrepareTool({ getProjection: () => projection }).execute({
      item_id: item.id, semantic_action: 'restart', requested_target: item.requestedTarget ?? {},
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(prepared.compatibility.status).not.toBe('compatible')
  })

  it('a legacy record without a qualification is flagged, and its history is preserved', () => {
    const projection = createProjection()
    projection.enabled = true
    const legacy = captureClause('重启 api 服务。', 'm1', 'R001', 1, { cwd: '/srv/app' })
    delete legacy.executionQualification
    legacy.directive = undefined
    legacy.authorityDisposition = undefined
    legacy.taskKind = 'action'
    projection.items.set(legacy.id, legacy)
    const before = {
      status: legacy.status, text: legacy.normalizedText, sha: legacy.textSha256,
      action: legacy.semanticAction, target: legacy.requestedTarget,
    }
    // The eligibility findings are read BEFORE the pass marks them: the list is
    // "records that may not be inherited", and a marked record drops out of it.
    expect(legacyRecordsNeedingReview(projection)).toEqual([
      { itemId: legacy.id, reason: 'legacy_missing_execution_qualification' },
    ])
    applyUpgradeEligibility(projection)
    expect(legacy.needsReview?.reason).toBe('legacy_missing_execution_qualification')
    expect({
      status: legacy.status, text: legacy.normalizedText, sha: legacy.textSha256,
      action: legacy.semanticAction, target: legacy.requestedTarget,
    }).toEqual(before)
    expect(authorizeMutationFromProjection(projection, {
      action: 'restart', contractItemId: legacy.id, contractItemRevision: legacy.revision,
      resolvedTarget: legacy.requestedTarget ?? {},
    } as never).status).toBe('denied')
  })
})
