import { normalizeClause } from './canonicalize.js'
import { extractArtifactPaths, extractMethod } from './capture.js'
import { governedClauseRestrictsExecution, introducesActionClause, splitTextFragments } from './semantics.js'

export type UserInteractionKind = 'instruction' | 'conversational'

/**
 * Punctuation and whitespace that may surround a bare progression phrase
 * without turning it into sentence content.
 */
const PUNCT = String.raw`[\s。，、；：！？．,;:!?\-*"'“”‘’()（）.…～~]`

/**
 * Session-layer phrases that acknowledge or advance the conversation without
 * stating a task. Longer forms come first so the alternation consumes them
 * before their prefixes. A bare whole-message acknowledgment ("当然。",
 * "Of course.") is session talk: it is never captured as an obligation, so it
 * can never block certification either.
 */
const PROGRESSION_SOURCE = String.raw`(?:继续执行|继续吧|请继续|继续|接着做|接着|下一步|没问题|知道了|明白了|了解|好的?|是的?|对的?|收到|可以|行|嗯+|当然|那当然|continue|go on|go ahead|keep going|proceed|okay|ok|yes|sure|right|next|of course)`

const PROGRESSION_WHOLE = new RegExp(`^${PUNCT}*${PROGRESSION_SOURCE}${PUNCT}*$`, 'i')
const PROGRESSION_LEAD = new RegExp(`^${PROGRESSION_SOURCE}${PUNCT}+`, 'i')
const PROGRESSION_ANYWHERE = new RegExp(PROGRESSION_SOURCE, 'gi')

/**
 * Clause-leading prohibition keywords. A message that opens with one is a
 * captured prohibition, never a meta comment.
 */
const PROHIBITION_LEAD = /^(?:(?:do not|don't|never)(?![A-Za-z0-9_./@\\-])|禁止|不要|不得)/i

/**
 * Question markers: a question mark, an interrogative pronoun/particle, or an
 * explicit request-for-answer phrase.
 */
const QUESTION_TERMS = /[？?]|什么|为什么|怎么|如何|是否|是不是|哪|谁|啥|吗|呢|对不对|正常吗|bug吗|有问题吗|有必要|合理吗|可否|能否|能不能|请问|问一下/

/**
 * Meta-comment/objection leads (no question mark required). `不是` requires
 * trailing punctuation so negated statements ("不是都要推送") stay fail-closed.
 */
const META_COMMENT_LEAD = /^(?:不是[，,。；;：:\s]|你(?:这|光|啥|怎么|什么|到底|就)|我(?:只是|就是|想|问|建议|认为|觉得)|这(?:有|什么)意义|有什么用|有什么意义)/

/** Diagnostic/inspection verbs: mentioning them alone is never a task feature. */
const META_VERBS = /确认下|看看|看一下|想问|确认|验证|检查|查看|分析|解释|说明|排查|定位|诊断|评估|考虑|建议|讨论|复查|核对|盘点|复盘|问|看/g

/**
 * Operation verbs that indicate a real task effect. English verbs are
 * word-bounded so "latest" does not contain "test". The classifier vocabulary
 * is intentionally independent from the command-surface manifest.
 */
const OPERATION_VERBS = /创建|生成|新建|写入|修改|编辑|运行|执行|编写|撰写|起草|整理|总结|记录|更新|修复|改进|解决|处理|推送|发布|安装|升级|提交|下载|上传|拉取|同步|部署|重启|测试|写|\b(?:build|create|write|modify|run|fix|update|install|push|publish|test)\b/gi

const NEGATIONS = /没有|并无|不存在|无需|不用|不需要|尚未|还未|没|未|不是/

function excludedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  for (const pattern of [PROGRESSION_ANYWHERE, META_VERBS]) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      const start = match.index!
      ranges.push([start, start + match[0].length])
    }
  }
  return ranges
}

/** The negation filter is scoped to the clause (sentence or comma segment). */
function isNegatedInClause(text: string, verbStart: number): boolean {
  const prefix = text.slice(0, verbStart)
  const clauseBoundary = /[。！？；.!?;，,\r\n]/
  const clause = prefix.split(clauseBoundary).pop() ?? ''
  return NEGATIONS.test(clause)
}

function hasOperationVerb(text: string): boolean {
  const excluded = excludedRanges(text)
  for (const match of text.matchAll(OPERATION_VERBS)) {
    const start = match.index!
    if (excluded.some(([from, to]) => start >= from && start < to)) continue
    if (isNegatedInClause(text, start)) continue
    return true
  }
  return false
}

function hasStrongTaskFeature(text: string): boolean {
  if (extractArtifactPaths(text).length > 0) return true
  if (extractMethod(text) !== undefined) return true
  return hasOperationVerb(text)
}

/**
 * Classify a direct user message (or one clause of it) as an actionable
 * `instruction` or a session-layer `conversational` utterance. Only
 * conversational results drop capture, so the classifier fails closed:
 * everything it cannot confidently recognize as session-layer talk stays an
 * instruction and is captured exactly as before.
 *
 * Order matters: progression and prohibition leads first, then strong task
 * features (artifact path, explicit method, or a non-negated operation verb
 * outside progression/meta spans), then the meta-question and meta-comment
 * forms, and finally a progression lead over a featureless remainder.
 */
/**
 * The message with every subordinate purpose span blanked out.
 *
 * A purpose clause is introduced by 为了/用来/以便/从而/进而/用于 or by an English
 * `to <verb>`. The question words inside it belong to that span, so they must not
 * be read as the message's own question. Only the span is masked, so an ordinary
 * question elsewhere in the message is still seen.
 */
const SUBORDINATE_SPAN = /(?:为了|用来|以便|从而|进而|用于)[\s\S]*$|\bto\s+[a-z]+[\s\S]*$/iu
function withoutSubordinateSpans(text: string): string {
  return text.replace(SUBORDINATE_SPAN, '')
}

/**
 * Question words that make a FRAGMENT an information request, English included.
 * A bare question mark is deliberately NOT one: it belongs to the sentence, so a
 * clause whose own head is an instruction keeps ordering work even when the
 * sentence ends with "?".
 */
const FRAGMENT_QUESTION = /什么|为什么|怎么|如何|是否|是不是|哪|谁|啥|吗|呢|对不对|可否|能否|能不能|\b(?:what|which|who|whom|whose|when|where|why|how|whether)\b/i
/** An interrogative auxiliary that opens the fragment ("Is it done?"). */
const QUESTION_AUXILIARY_LEAD = /^(?:is|are|was|were|do|does|did|can|could|should|would|will|has|have|had)\b/i
/**
 * English sentence heads that describe rather than order: determiners, pronouns
 * and existentials. They are a closed grammatical class, so a Latin clause that
 * opens with one is a statement ("The build failed"), not an unknown action.
 */
const ENGLISH_DESCRIPTIVE_HEAD = /^(?:the|a|an|this|that|these|those|it|its|they|them|their|we|our|you|your|i|my|he|she|his|her|there|here|nothing|nobody|someone|something|everyone|everything)\b/i
/** A fragment written in Chinese, whatever Latin term it opens with. */
const HAS_HAN = /[\u3400-\u9fff]/u
/** A request preface or coordinating conjunction that opens a continued clause. */
const SPOKEN_PREFIX = /^(?:(?:please|kindly|now|then|also|and|but|however|yet)\b[\s,]*|(?:请|麻烦|帮我|帮忙|那么|然后|接着|随后|首先|先|再|也|并且|而且|以及|而后|并|且)[\s，,]*)/i

/**
 * Whether one fragment orders work of its own.
 *
 * A fragment that asks nothing and still names an action is work the capture
 * layer has to see. A Latin clause with its own head counts even when its verb is
 * outside every vocabulary — `What changed, and archive the logs?` must keep the
 * archive rather than disappear because the sentence asks a question (review 5
 * F2) — while a Chinese statement that merely opens with a Latin term, and an
 * English description that opens with a determiner or a pronoun, stay talk.
 */
function fragmentOrdersWork(fragment: string): boolean {
  let body = fragment.trim()
  for (let step = 0; step < 3 && body; step += 1) {
    const next = body.replace(SPOKEN_PREFIX, '').trim()
    if (next === body) break
    body = next
  }
  if (!body) return false
  // Question content only makes the fragment talk when nothing orders work
  // BEFORE it. Reading the whole fragment as a question let a later question —
  // even one behind an abbreviation and a polite preface — delete the order in
  // front of it ("Archive the logs etc. 请说明一下哪些请求失败了？"), which produced
  // NO item at all rather than a visible obligation. This mirrors the semantic
  // layer's residue rule on purpose: the two layers must agree about what is
  // work, or the classifier deletes what the reader would have kept.
  const question = FRAGMENT_QUESTION.exec(body)
  if (question) {
    const before = body.slice(0, question.index).trim()
    if (!before) return false
    // A Latin head in front of the question is an order the question does not
    // govern, whatever prose follows it ("Archive the logs etc. 请说明一下…").
    if (/^[A-Za-z]/.test(before) && !ENGLISH_DESCRIPTIVE_HEAD.test(before)) return true
    return actionHeadOf(before)
  }
  if (QUESTION_AUXILIARY_LEAD.test(body)) return false
  return actionHeadOf(body)
}

/**
 * The action-head test both layers share: a known operation verb, a Chinese
 * action head, a Chinese clause that ends on a stray question mark, or a Latin
 * head that is not a determiner/pronoun.
 */
function actionHeadOf(text: string): boolean {
  if (hasOperationVerb(text)) return true
  if (introducesActionClause(text)) return true
  if (HAS_HAN.test(text) && /[？?]$/u.test(text)) return true
  if (HAS_HAN.test(text)) return false
  return /^[A-Za-z][A-Za-z0-9_.-]*/.test(text) && !ENGLISH_DESCRIPTIVE_HEAD.test(text)
}

/**
 * Whether the message orders anything once its question-bearing fragments are
 * set aside. A conversational verdict drops capture entirely, so it may only be
 * reached when EVERY fragment either asks or says nothing: a question earlier in
 * the message must not delete a later instruction (review 5 F2).
 *
 * The decomposition is the SEMANTIC layer's own: a fragment is split first at
 * sentence punctuation and then by `splitTextFragments`, which is the same rule
 * the capture path uses for coordinators and list separators. Splitting only on
 * punctuation made the comma the whole difference between a kept obligation and
 * a deleted one — `What changed and archive the logs?` lost the archive that
 * `What changed, and archive the logs?` kept (review 6 F1).
 */
function ordersWorkBesideQuestion(text: string): boolean {
  // The sentence keeps its own closing mark: stripping it hid the Chinese
  // stray-question-mark rule from the fragment test, and the whole message was
  // then dropped ("什么变了并归档日志？" produced no item at all).
  const sentences: string[] = []
  const separators = /[，,；;。！!？?\n\r]+/gu
  let cursor = 0
  for (const match of text.matchAll(separators)) {
    sentences.push(text.slice(cursor, match.index + match[0].length))
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) sentences.push(text.slice(cursor))
  return sentences
    .filter((sentence) => sentence.trim() !== '')
    .some((sentence) => {
      // A clause the READER governs is work the capture layer must see: the
      // semantic layer keeps it as an undecided obligation, so dropping the
      // message here would delete it. The classifier and the reader therefore
      // consume the same predicate, exactly as the gate and preparation do
      // ("审计员是否替换凭据并轮换密钥。", where the question governs the clause so
      // the coordination is never treated as the question's own subject).
      if (governedClauseRestrictsExecution(sentence)) return true
      return splitTextFragments(sentence)
        .some((fragment) => fragment.text.trim() !== '' && fragmentOrdersWork(fragment.text))
    })
}

export function classifyUserInteraction(text: string): UserInteractionKind {
  const normalized = normalizeClause(text)
  if (!normalized) return 'instruction'
  if (PROGRESSION_WHOLE.test(normalized)) return 'conversational'
  if (PROHIBITION_LEAD.test(normalized)) return 'instruction'
  if (hasStrongTaskFeature(normalized)) return 'instruction'
  // A question term inside a PURPOSE span does not make the message
  // meta-talk: "打包日志以便确认哪些请求失败" asks the assistant to package
  // logs whose purpose mentions a question. Dropping it would destroy a real
  // obligation, so the subordinate span is masked before the question test and
  // the message stays an instruction.
  const questionScope = withoutSubordinateSpans(normalized)
  if (QUESTION_TERMS.test(questionScope)) {
    // A question term only makes the message session talk when the REST of it
    // orders nothing. A question earlier in the message must never delete a
    // later instruction, and an unrecognised main verb is still work the capture
    // layer has to see (review 5 F2).
    if (ordersWorkBesideQuestion(questionScope)) return 'instruction'
    return 'conversational'
  }
  if (META_COMMENT_LEAD.test(normalized)) return 'conversational'
  if (PROGRESSION_LEAD.test(normalized)) return 'conversational'
  return 'instruction'
}

export type TaskIntent = 'inquiry' | 'action'

/**
 * Inquiry verbs: the operation verb appears as the OBJECT of an
 * investigation rather than an imperative ("是否有更新", "check whether…").
 * The clause asks about state; it does not order a change.
 */
const INQUIRY_PATTERNS: RegExp[] = [
  /(?:是否|有没有|有没|是否存在|是不是已经?|可曾|曾否)[^。！？；，,]{0,12}(?:更新|升级|提交|推送|发布|安装|修改|删除|修复|完成|同步|拉取|下载|重启|生成|写入)/,
  /(?:更新|升级|提交|推送|发布|安装|修改|删除|修复|完成|同步|拉取|下载|重启)(?:了)?(?:吗|么|没有|没)\s*[?？]?\s*$/,
  /^(?:检查|看看|查看|确认|了解|查一下|帮忙看)[^。！？；]{0,16}(?:是否|有没有|是否已经)/,
  /\b(?:is|are)\s+there\s+(?:any|an?)?\s*(?:update|updates|upgrade|commit|push|change|fix)/i,
  /\bcheck\s+(?:whether|if)\b/i,
  /\bwhether\b[^.?!]{0,24}\b(?:update|upgrade|commit|push|install|change)/i,
]

/**
 * Imperative leads that keep an ACTION reading even when the clause also
 * contains an inquiry verb ("更新后检查" orders a change first).
 */
const ACTION_LEAD = /^(?:请\s*)?(?:更新|升级|提交|推送|发布|安装|修改|删除|修复|同步|拉取|下载|重启|生成|写入|创建|新建|运行|执行|部署)\b|^(?:please\s+)?(?:update|upgrade|commit|push|publish|install|modify|delete|fix|deploy|run|create)\b/i

/**
 * Separate intent layer (v0.5): whether the captured work is an inquiry about
 * state or an ordered change. Intent NEVER drops capture or weakens
 * protection — an inquiry keeps its original obligation; it only changes what
 * certification support the diagnosis reports (inquiries are not machine
 * certifiable by the current adapters and must not be re-bound).
 */
export function classifyTaskIntent(text: string): TaskIntent {
  const normalized = normalizeClause(text)
  if (!normalized) return 'action'
  if (ACTION_LEAD.test(normalized)) return 'action'
  for (const pattern of INQUIRY_PATTERNS) if (pattern.test(normalized)) return 'inquiry'
  return 'action'
}
