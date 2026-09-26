import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { deriveItemDiagnosis } from '../../src/domain/diagnostics.js'
import { isOpenObligation } from '../../src/domain/semantics.js'
import { certifiableOpenItems } from '../../src/domain/closure.js'
import type { DerivedEnvelope } from '../../src/domain/types.js'

/**
 * 0.6.1 W060-02 (plan V01): conservative interpretation.
 *
 * A clause the finite rules cannot positively read as an order, a statement,
 * or a question defaults to `unresolved` — whether or not it carries a
 * request marker. Unknown actions never degrade to information, where the
 * turn's answer would auto-close them; positively recognized questions,
 * explanations, and reports keep that lane; ordinary imperatives keep their
 * exact 0.6.0 reading.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/repo', sessionHeader: { version: 3, id: 'v061-conservative', createdAt: 1 } }

let seq = 0
const reset = () => { seq = 0 }
const notice = (): DerivedEnvelope => ({ seq: seq++, type: 'user/message', data: {
  source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice' },
  content: [{ type: 'text', text: PROTOCOL_V5_NOTICE }],
} })
const turnStart = (turn: number): DerivedEnvelope => ({ seq: seq++, type: 'turn/start', data: { turn } })
const turnEnd = (turn: number, kind = 'completed'): DerivedEnvelope => ({ seq: seq++, type: 'turn/end', data: { turn, reason: { kind } } })
const user = (text: string, turn: number): DerivedEnvelope => ({ seq: seq++, type: 'user/message', data: {
  turn, source: { kind: 'user' }, content: [{ type: 'text', text }],
} })
const assistant = (turn: number, step: number, text: string): DerivedEnvelope => ({ seq: seq++, type: 'assistant/message', data: {
  turn, step, message: { role: 'assistant', content: [{ type: 'text', text }] },
} })

const session = (messages: Array<[string, string]>): DerivedEnvelope[] => {
  reset()
  const events: DerivedEnvelope[] = [notice()]
  for (const [index, [input, reply]] of messages.entries()) {
    const turn = index + 1
    events.push(turnStart(turn), user(input, turn), assistant(turn, 1, reply), turnEnd(turn))
  }
  return events
}

describe('0.6.1 W060-02: unknown actions stay unresolved; background statements stay closable', () => {
  it('a bare whole-message acknowledgment is session talk, never an obligation', () => {
    const { projection } = deriveProjection(session([['当然。', '好的。']]), config, scope, true)
    // Acknowledgments belong to the session layer: nothing is captured, so
    // nothing can block or be mis-closed.
    expect(projection.items.size).toBe(0)
  })

  it('declarative-shaped clauses are undecidable and never auto-closed (review round 6)', () => {
    // A grammatical declarative can express a task requirement, so NO
    // surface shape — passive, negation, progress marker, declarative
    // subject — proves that a clause is closable information.
    const cases: Array<[string, string]> = [
      ['设置面板被遮挡。', '尚未处理。'],
      ['The settings panel is blocked.', 'Not yet.'],
      ['尚未完成。', '了解。'],
      ['这个问题还没处理。', '了解。'],
      ['I need you to sanitize these inputs', 'I have not sanitized anything yet.'],
      ['Our requirement is to sanitize all inputs', '尚未执行该请求。'],
      ['避免面板被遮挡', '尚未执行该请求。'],
      ['没有标签的输入也要处理', '尚未执行该请求。'],
    ]
    for (const [text, reply] of cases) {
      const { projection } = deriveProjection(session([[text, reply]]), config, scope, true)
      const item = [...projection.items.values()][0]!
      expect(item.authorityDisposition, text).toBe('unresolved')
      expect(item.status, text).toBe('pending')
      const diagnosis = deriveItemDiagnosis(projection, item)
      expect(diagnosis.reason_code, text).toBe('interpretation_unresolved')
    }
  })

  it('positive information grounds keep the closable lane: a single-clause past report closes with its turn', () => {
    // Aspect markers as the clause's ENTIRE predicate positively identify a
    // report about the past; a compound report with a coordinated second
    // clause stays undecidable by design.
    const { projection } = deriveProjection(session([['我刚才已经推送过了。', '收到。']]), config, scope, true)
    const item = [...projection.items.values()][0]!
    expect(item.authorityDisposition).toBe('informational')
    expect(item.status).toBe('answered')
    expect(isOpenObligation(item)).toBe(false)
  })

  it('an English imperative outside the action vocabulary stays unresolved (review repro)', () => {
    const { projection } = deriveProjection(session([
      ['Please sanitize these inputs', 'I have not sanitized anything yet.'],
    ]), config, scope, true)
    const item = [...projection.items.values()][0]!
    // The request never degrades to information: the turn's answer must not
    // auto-close work the vocabulary cannot resolve.
    expect(item.authorityDisposition).toBe('unresolved')
    expect(item.status).toBe('pending')
    expect(isOpenObligation(item)).toBe(false)
    const diagnosis = deriveItemDiagnosis(projection, item)
    expect(diagnosis.reason_code).toBe('interpretation_unresolved')
  })

  it('a bare English imperative without any statement evidence stays unresolved too', () => {
    const { projection } = deriveProjection(session([
      ['Sanitize all inputs before merging', '好的。'],
    ]), config, scope, true)
    const item = [...projection.items.values()][0]!
    expect(item.authorityDisposition).toBe('unresolved')
    expect(item.status).toBe('pending')
  })

  it('statement markers inside MODIFIERS never downgrade a request (review rounds 4-6)', () => {
    const cases: Array<[string, string]> = [
      // 'are' inside the relative clause "that are untrusted".
      ['Please sanitize inputs that are untrusted', '尚未执行该请求。'],
      // '被' inside the object modifier "被遮挡的面板".
      ['请处理被遮挡的面板', '尚未执行该请求。'],
      // 'Have' as the clause-head causative imperative.
      ['Have these inputs sanitized', '尚未执行该请求。'],
      // The bare imperative behind case 2 has no leading marker at all.
      ['处理被遮挡的面板', '尚未执行该请求。'],
      // The other round-6 declarative requirements.
      ['I need you to sanitize these inputs', '尚未执行该请求。'],
      ['Our requirement is to sanitize all inputs', '尚未执行该请求。'],
      ['避免面板被遮挡', '尚未执行该请求。'],
      ['没有标签的输入也要处理', '尚未执行该请求。'],
    ]
    for (const [text, reply] of cases) {
      const { projection } = deriveProjection(session([[text, reply]]), config, scope, true)
      const item = [...projection.items.values()][0]!
      expect(item.authorityDisposition, text).toBe('unresolved')
      expect(item.status, text).toBe('pending')
      const diagnosis = deriveItemDiagnosis(projection, item)
      expect(diagnosis.reason_code, text).toBe('interpretation_unresolved')
    }
  })

  it('round-7 repros: an informational fragment never closes a whole request', () => {
    const cases: Array<[string, string]> = [
      // 'were' is a subordinate past report, not the main clause.
      ['Sanitize inputs that were supplied by users', '尚未执行该请求。'],
      // the completion aspect sits inside the object modifier.
      ['清理已经生成了的缓存', '尚未执行该请求。'],
      // the investigation opener chains an execution request after 'and'.
      ['Figure out the issue and sanitize all inputs', '尚未执行该请求。'],
    ]
    for (const [text, reply] of cases) {
      const { projection } = deriveProjection(session([[text, reply]]), config, scope, true)
      const item = [...projection.items.values()][0]!
      // The oracle: the request must never become `answered` — whatever lane
      // the clause lands in, no turn answer closes it wholesale.
      expect(item.status, text).not.toBe('answered')
      expect(item.status, text).toBe('pending')
    }
  })

  it('the round-5 holdouts stay unresolved and are never answered', () => {
    const cases: Array<[string, string]> = [
      ['处理没有标签的输入', '尚未执行该请求。'],
      ['Sanitize inputs I have received', '尚未执行该请求。'],
      ['处理被异常宽大半透明浮动弹窗持续完全严重遮挡的面板', '尚未执行该请求。'],
    ]
    for (const [text, reply] of cases) {
      const { projection } = deriveProjection(session([[text, reply]]), config, scope, true)
      const item = [...projection.items.values()][0]!
      expect(item.authorityDisposition, text).toBe('unresolved')
      expect(item.status, text).toBe('pending')
      const diagnosis = deriveItemDiagnosis(projection, item)
      expect(diagnosis.reason_code, text).toBe('interpretation_unresolved')
    }
  })

  it('round-7 repros: an informational fragment never closes a whole request', () => {
    const cases: Array<[string, string]> = [
      // 'were' is a subordinate past report, not the main clause.
      ['Sanitize inputs that were supplied by users', '尚未执行该请求。'],
      // the completion aspect sits inside the object modifier.
      ['清理已经生成了的缓存', '尚未执行该请求。'],
      // the investigation opener chains an execution request after 'and'.
      ['Figure out the issue and sanitize all inputs', '尚未执行该请求。'],
    ]
    for (const [text, reply] of cases) {
      const { projection } = deriveProjection(session([[text, reply]]), config, scope, true)
      const item = [...projection.items.values()][0]!
      // The oracle: the request must never become `answered` — whatever lane
      // the clause lands in, no turn answer closes it wholesale.
      expect(item.status, text).not.toBe('answered')
      expect(item.status, text).toBe('pending')
    }
  })

  it('the round-5 holdouts stay unresolved and are never answered', () => {
    const cases: Array<[string, string]> = [
      ['处理没有标签的输入', '尚未执行该请求。'],
      ['Sanitize inputs I have received', '尚未执行该请求。'],
      ['处理被异常宽大半透明浮动弹窗持续完全严重遮挡的面板', '尚未执行该请求。'],
    ]
    for (const [text, reply] of cases) {
      const { projection } = deriveProjection(session([[text, reply]]), config, scope, true)
      const item = [...projection.items.values()][0]!
      expect(item.authorityDisposition, text).toBe('unresolved')
      expect(item.status, text).toBe('pending')
      const diagnosis = deriveItemDiagnosis(projection, item)
      expect(diagnosis.reason_code, text).toBe('interpretation_unresolved')
    }
  })

  it('an unknown action reads unresolved with or without a request marker (review repro)', () => {
    for (const text of ['处理这个问题。', '请处理这个问题。']) {
      const { projection } = deriveProjection(session([[text, '好的。']]), config, scope, true)
      const item = [...projection.items.values()][0]!
      expect(item.authorityDisposition, text).toBe('unresolved')
      expect(item.status, text).toBe('pending')
      // The turn's answer must not auto-close an unknown action.
      const diagnosis = deriveItemDiagnosis(projection, item)
      expect(diagnosis.reason_code, text).toBe('interpretation_unresolved')
      expect(diagnosis.next_action.resume_condition!, text).toContain('never closes by delivery')
    }
  })

  it('a verbatim concrete instruction supersedes an unresolved clause (review repro: clarification lane)', () => {
    const { projection } = deriveProjection(session([
      ['处理这个问题', '好的。'],
      ['把处理这个问题明确为修改登录页', '好的。'],
    ]), config, scope, true)
    const items = [...projection.items.values()]
    const old = items.find((item) => item.normalizedText === '处理这个问题')
    const concrete = items.find((item) => item.clarifiesItemId === old!.id)
    expect(old, 'the unresolved clause is present').toBeDefined()
    expect(old!.status).toBe('superseded')
    expect(concrete, 'the verbatim concrete instruction supersedes it').toBeDefined()
    expect(concrete!.semanticAction).toBe('modify')
    expect(isOpenObligation(concrete!)).toBe(true)
    expect(items.filter((item) => item.status === 'pending')).toHaveLength(1)
  })

  it('a real execution request with a relative clause stays executable (review repro)', () => {
    const { projection } = deriveProjection(session([
      ['Create a file where logs are stored', 'I will create it later.'],
    ]), config, scope, true)
    const item = [...projection.items.values()][0]!
    // 'where' is a relative clause inside an order, not a question marker.
    expect(item.authorityDisposition).toBe('executable_now')
    expect(item.semanticAction).toBe('create')
    expect(isOpenObligation(item)).toBe(true)
    // The delivered answer must not close an execution obligation.
    expect(item.status).toBe('pending')
  })

  it('a pure question with a coordinated complement keeps the closable lane', () => {
    // "Tell me what changed in the build and why" is a question throughout —
    // no execution sub-request follows, so the question lane closes it.
    const { projection } = deriveProjection(session([
      ['Tell me what changed in the build and why', 'The dependency bump changed the lockfile.'],
    ]), config, scope, true)
    const item = [...projection.items.values()][0]!
    expect(item.authorityDisposition).toBe('informational')
    expect(item.status).toBe('answered')
  })

  it('a pure question keeps the closable lane', () => {
    const { projection } = deriveProjection(session([
      ['检查一下插件是否有更新吗？', '已是最新版本。'],
    ]), config, scope, true)
    const item = [...projection.items.values()][0]!
    expect(item.authorityDisposition).toBe('informational')
    expect(item.status).toBe('answered')
  })

  it('a canonical completed report (already + V + le) closes with its turn (round-8)', () => {
    // "我已经推送了" carries the canonical completed-report aspect: a
    // statement about the past, not a request — closable by the answer.
    const { projection } = deriveProjection(session([['我已经推送了。', '了解。']]), config, scope, true)
    const item = [...projection.items.values()][0]!
    expect(item.authorityDisposition).toBe('informational')
    expect(item.status).toBe('answered')
    expect(isOpenObligation(item)).toBe(false)
  })

  it('background context plus a real instruction keeps exactly one closable obligation', () => {
    const { projection } = deriveProjection(session([
      ['设置面板被遮挡。请修复登录页。', '好的。'],
    ]), config, scope, true)
    const items = [...projection.items.values()]
    const context = items.find((item) => item.normalizedText.includes('被遮挡'))
    const instruction = items.find((item) => item.authorityDisposition === 'executable_now')
    expect(context).toBeDefined()
    expect(instruction).toBeDefined()
    expect(isOpenObligation(instruction!)).toBe(true)
    expect(isOpenObligation(context!)).toBe(false)
    // The turn's answer cannot close the undecidable context clause; it and
    // the instruction both stay recorded, and the instruction is the only
    // closable work.
    expect(context!.status).toBe('pending')
    expect(instruction!.status).toBe('pending')
    expect(certifiableOpenItems(projection).map((item) => item.id).sort())
      .toEqual([instruction!.id, context!.id].sort())
  })

  it('ordinary imperatives keep their 0.6.0 reading', () => {
    const { projection } = deriveProjection(session([['更新文档', '好的。']]), config, scope, true)
    const item = [...projection.items.values()][0]!
    expect(item.authorityDisposition).toBe('executable_now')
    expect(item.semanticAction).toBe('modify')
    expect(isOpenObligation(item)).toBe(true)
  })

  it('a narrative scope that merely names an action never releases a held wait', () => {
    const events = [
      notice(),
      turnStart(1),
      user('收到我的确认后再推送代码', 1),
      assistant(1, 1, '好的，我等你确认。'),
      turnEnd(1),
      turnStart(2),
      user('我已经推送了。', 2),
      assistant(2, 1, '了解。'),
      turnEnd(2),
    ]
    const { projection } = deriveProjection(events, config, scope, true)
    const waits = [...projection.items.values()].filter((item) => item.waitAuthorization)
    expect(waits).toHaveLength(1)
    // The narrative "我已经推送了" names the same action but is not an
    // executable instruction, so the root's reservation still stands.
    expect(waits[0]!.status).toBe('pending')
  })
})
