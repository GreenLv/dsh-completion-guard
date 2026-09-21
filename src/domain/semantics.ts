import { normalizeClause } from './canonicalize.js'
import { COMMAND_SURFACE_MANIFEST } from './manifest.js'
import { isStatefulAction, semanticActionFromText, type StatefulAction } from './protocol-manifest.js'
import type { GuardItem, GuardItemKind } from './types.js'

/**
 * The single interpretation of a root-user instruction.
 *
 * Before 0.5.1, capture, mutation authorization and boundary qualification each
 * re-guessed what one sentence meant, and the guesses disagreed: the incident
 * instruction "按 P0—P4 完成本地实现、测试和文档，在跨平台验证前停止，不推送、
 * 不正式发布。" was captured as a *push* obligation, so the only certifiable item
 * demanded the very action its own text forbade.
 *
 * This module answers the question once. It partitions the message into
 * semantic scopes first, then reads the action inside each scope, so:
 *
 * 1. a prohibition's scope covers every coordinated action it governs, and a
 *    prohibition constrains execution instead of creating an obligation to
 *    perform the forbidden action;
 * 2. only an explicit, agent-owned, unconditional directive becomes an
 *    immediately executable duty — naming an action is not authorizing it;
 * 3. a conditional directive stays unexecuted until its condition holds, and a
 *    human-owned action never becomes agent work;
 * 4. quotation and code keep an action visible but never grant authority;
 * 5. an interpretation that cannot be resolved reads conservatively and is not
 *    executed.
 *
 * No rule here keys on a session id, an event sequence, a file name, or a fixed
 * phrase list for one incident sentence: the rules are polarity, scope,
 * executee and condition, so paraphrases, mixed languages, word-order changes
 * and punctuation changes agree with the original.
 */

/**
 * How one message is read.
 *
 * `coordinationSplit` is the one historical granularity switch: a message
 * captured before the 0.4.2 capture boundary keeps a coordinated action in one
 * clause, exactly as that release recorded it. Every semantic rule (polarity,
 * executee, condition, quotation) applies identically in both modes, so replay
 * stability never depends on re-reading an older message with newer semantics.
 */
export interface InterpretOptions {
  coordinationSplit?: boolean
}



/** What one scope does with the action it names. */
export type DirectiveClass =
  /** An order to perform the action, subject to its executee and condition. */
  | 'directive'
  /** A ban on the action; a constraint, never an obligation. */
  | 'prohibition'
  /** The condition that guards a later action; it orders nothing by itself. */
  | 'conditional'
  /** The action is the object of an explanation or an analysis. */
  | 'informational'
  /** A factual statement, not an instruction. */
  | 'narrative'
  /**
   * 0.6.1 (W060-02): the conservative default. A clause the rules cannot
   * positively read as an order, a statement, or a question — including an
   * order whose action word is outside the resolvable vocabulary — stays
   * recorded as unresolved: non-executable, never closed by delivery, never
   * reinterpreted, replaceable only through an explicit clarification, a
   * confirmed rebind, or the root's clear command.
   */
  | 'unresolved'

/** Who is expected to perform the action. */
export type Executee = 'agent' | 'user' | 'unresolved'

/** How the scope's authority reads. */
export type AuthorityDisposition =
  | 'executable_now'
  | 'conditional_wait'
  | 'human_actor'
  | 'informational'
  | 'prohibition'
  | 'unresolved'

export interface ScopeInterpretation {
  /** Verbatim scope text, trimmed: the audit record of what was read. */
  text: string
  /** The action-bearing text with leading connectors and negators removed. */
  body: string
  directive: DirectiveClass
  executee: Executee
  /** The unresolved condition that must hold before the action may run. */
  condition?: string
  /** The event that ends a human wait, when the source names one. */
  resumeEvent?: string
  /** True only for an explicit, agent-owned, unconditional instruction. */
  immediatelyExecutable: boolean
  authorityDisposition: AuthorityDisposition
  /** The 0.6.3 execution qualification this reading establishes. */
  qualification: ExecutionQualification
  /** Explicitly named tool/method, when the scope names one. */
  method?: string
  /** Stable identity of this interpretation, reproducible from the same bytes. */
  fingerprint: string
}

/**
 * 0.6.3 K1 regression probe: the 0.6.2 question rule, kept SOLELY so the fixed
 * defect has a test that fails against the old reading.
 *
 * 0.6.2 declared a clause information as soon as a question marker appeared
 * anywhere inside it (`QUESTION_SCOPE.test(masked)`). This function is that
 * rule, verbatim. It is not used by any production path — the current reading
 * is {@link hasQuestionScope} — and its only caller is the regression test that
 * pins the difference between the two readings on the recorded defect input.
 */
export function legacyQuestionReadingIsInformational(masked: string): boolean {
  return QUESTION_SCOPE.test(masked)
}

/** A clause whose head verb demands a verification rather than a change. */
const ACCEPTANCE_LEAD = /^(?:验收|验证|确认|确保|核对|检查|verify|confirm|ensure|check)/i

/**
 * The contract kind a scope maps to. A prohibition and an acceptance keep their
 * own lanes; everything else is a requirement. Acceptance is decided from the
 * clause's own head verb, so "确保构建通过" stays an acceptance while a
 * conditional or prohibition clause is never mislabelled.
 */
export function kindOfScope(directive: DirectiveClass, body = ''): GuardItemKind {
  if (directive === 'prohibition') return 'prohibition'
  if (directive === 'directive' && ACCEPTANCE_LEAD.test(body.trim())) return 'acceptance'
  // An unresolved reading keeps its recorded obligation lane: the clause stays
  // visible as a requirement that no rule may execute or auto-close.
  return 'requirement'
}

// ---------------------------------------------------------------------------
// Code spans
// ---------------------------------------------------------------------------

/**
 * Blank out inline-code spans while preserving every byte offset, so a caller
 * can classify authority against masked text and still slice the original.
 * Backticks are Markdown emphasis, but they are also how a log line or a
 * command is quoted — and a quoted command is data, never an order.
 */
const MASK_CACHE = new Map<string, string>()
const MASK_CACHE_LIMIT = 64

export function maskCodeSpans(text: string): string {
  const cached = MASK_CACHE.get(text)
  if (cached !== undefined) return cached
  const masked = computeMaskedSpans(text)
  if (MASK_CACHE.size >= MASK_CACHE_LIMIT) MASK_CACHE.clear()
  MASK_CACHE.set(text, masked)
  return masked
}

function computeMaskedSpans(text: string): string {
  const characters = text.split('')
  let cursor = 0
  while (cursor < text.length) {
    if (text[cursor] !== '`') { cursor += 1; continue }
    const end = text.indexOf('`', cursor + 1)
    if (end < 0) break
    for (let index = cursor; index <= end; index += 1) characters[index] = ' '
    cursor = end + 1
  }
  return characters.join('')
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Actions Guard can name, shared with the command-surface manifest. */
/**
 * The manifest's operation verbs. Each alternative is wrapped with word
 * boundaries, so an English verb never matches inside another word ("check"
 * inside "change"); a Chinese alternative is left alone because a Han character
 * has no word boundary to assert.
 */
const CJK_VERBS = ['创建', '生成', '新建', '写入', '修改', '编辑', '更改', '读取', '阅读', '打开',
  '验证', '校验', '确认', '确保', '检查', '核对', '运行', '执行', '拉取', '同步',
  '更新', '下载', '安装', '部署', '上传', '提交', '推送', '发布', '升级', '重启', '重新启动', '重载',
  '合并', '继续', '撤销', '删除']
/** Every CJK action word, longest first so 重新启动 wins over 新. */
const CJK_VERB_PATTERN = `(?:${[...CJK_VERBS].sort((a, b) => b.length - a.length).join('|')})`
/** The same words as literal strings, for exact scanning without regex escapes. */
const CJK_VERB_WORDS: readonly string[] = [...CJK_VERBS].sort((a, b) => b.length - a.length)
const ACTION_VERB_PATTERN = `(?:${COMMAND_SURFACE_MANIFEST.operationVerbs
  .map((entry) => entry.pattern.split('|')
    .map((alternative) => /^[A-Za-z]/.test(alternative.trim()) ? `\\b${alternative.trim()}\\b` : alternative.trim())
    .join('|'))
  .join('|')}|${CJK_VERB_PATTERN})`
const ACTION_VERB = new RegExp(ACTION_VERB_PATTERN, 'i')

/** Operation verbs beyond the guard action surface (local work and diagnosis). */
const WORK_VERB = /创建|生成|新建|写入|修改|编辑|运行|执行|编写|撰写|起草|拟定|部署|安装|升级|提交|下载|上传|拉取|同步|重启|测试|检查|验证|确认|修复|更新|清理|整理|记录|构建|编译|重构|迁移|轮换|刷新|清空|扩容|缩容|删除|回滚|发布|推送|合并|继续|恢复|还原|回滚|实现|\b(?:build|create|write|modify|change|edit|run|fix|update|install|push|publish|test|verify|check|commit|deploy|migrate|remove|delete|restart|revert|refactor|inspect|fetch|pull|implement|draft|emit|produce|log)\b/i

/** Explanatory framings: an action named afterwards is an object, not an order. */
const EXPLAIN_VERB = /解释|说明|讲解|介绍|阐述|分析|讨论|描述|科普|什么意思|是什么意思|有什么(?:作用|影响|区别)|\bexplain\b|\bdescribe\b|\bclarify\b|\btell\b|\bhow\s+to\b|\bwhat\s+does\b|\bwhat\s+is\b|\bhow\s+does\b|\bmeaning\s+of\b/i

/**
 * A present explanation speech act can have a time/scope frame before its
 * matrix verb. This only identifies the head; the v6 capture path still checks
 * the complete complement and keeps an independent action or unknown residue.
 * In particular, a quoted or reported head and a future-time frame do not
 * match, so this predicate never grants execution authority.
 */
export function presentExplanationHead(text: string): { end: number } | undefined {
  const visible = maskQuotedSpans(text)
  // Find the first live matrix predicate, then classify its source prefix. A
  // time frame alone never determines speech act: a reported/conditional or
  // future explanation has a different owner or readiness. The complete
  // complement is checked by the caller before an information item is made.
  const head = /解释|说明|讲解|讲清楚|介绍|阐述|描述|\b(?:explain|describe|clarify)\b/iu.exec(visible)
  if (!head) return undefined
  let prefix = visible.slice(0, head.index).trim()
  if (/[“”"'`]/u.test(prefix) || WORK_VERB.test(prefix)
    || /\b(?:if|when|unless|after|before|because|says?|said|reports?|reported|asks?|asked|will|would|should|tomorrow|later|future|yesterday)\b|\bnext\s+(?:week|month|year|time)\b|如果|若|假如|当|待|之后|以后|将来|未来|明天|后天|下周|随后会|说|称|表示|提到|要求/u.test(prefix)) return undefined
  // A comma-bounded preface may be a present scope adjunct, but never a
  // subject or another finite clause. Consume its grammatical constituents:
  // sequencing adjunct, polite/focus modifier, or a preposition with a
  // present-time deictic frame. Their order is flexible; the first unconsumed
  // token makes the matrix source unknown rather than answerable. This also
  // handles "for now" and "for this turn" by the same frame construction.
  const sequence = /^(?:先|首先|然后|接着|再|first\b|then\b|next\b)\s*[,，]?\s*/iu
  const modifier = /^(?:请|只|仅|就|please\b|only\b|just\b)\s*[,，]?\s*/iu
  const presentFrame = /^(?:(?:(?:for|in|during|at)\s+)?(?:(?:this|the\s+current)\s+(?:turn|session|time|moment)|(?:the\s+)?(?:present|moment)|now|today|currently)\b|(?:在)?(?:本轮|本次|这轮|这次|当前|现在|如今|此时|目前|今天))\s*[,，]?\s*/iu
  for (let step = 0; step < 8 && prefix; step += 1) {
    const next = prefix.replace(/^[,，]\s*/u, '')
      .replace(sequence, '').replace(modifier, '').replace(presentFrame, '')
    if (next === prefix) return undefined
    prefix = next.trim()
  }
  if (prefix) return undefined
  return { end: head.index + head[0].length + (/^\s*/u.exec(visible.slice(head.index + head[0].length))?.[0].length ?? 0) }
}

/** A sourced clause-level condition can govern the next comma-linked matrix. */
export function opensConditionLead(text: string): boolean {
  const visible = maskCodeSpans(maskQuotedSpans(text)).trim()
  const marker = prefixConditionIndex(visible.toLowerCase())
  return marker === 0 && conditionMarkerIsClauseLevel(visible, marker)
}

/** Work named inside a governed explanation complement needs its own reading. */
export function hasWorkPredicate(text: string): boolean {
  return WORK_VERB.test(maskCodeSpans(maskQuotedSpans(text)))
}

/** Interrogative framings that make a scope a question rather than an order. */
/**
 * Interrogative framings that make a scope a question rather than an order.
 * The bare English wh-words are matched only at the START of a scope ("What
 * changed in the build"), where they are genuine interrogatives; a mid-clause
 * match would misread the relative clause of a real order ("Create a file
 * where logs are stored") as a question — the 0.6.1 review regression.
 */
const QUESTION_SCOPE = /[？?]|是否|是不是|为什么|为何|怎么|如何|什么|哪些|哪一种|能否|可否|要不要|该不该|由谁|是谁|^\s*(?:what|how|when|where|who|which|whether|why)\b|\b(?:whether|which|why|should|could|would)\b/i

/**
 * The interrogative ending. A clause whose head is an action verb is decided by
 * how it ENDS: "检查是否有更新吗？" asks about the world, while "检查是否存在
 * 更新。" orders a check.
 *
 * 吗 and the question mark ask on their own. 呢 and 吧 do NOT: both soften a
 * suggestion ("安装这个主题呢。", "安装新主题吧。"), so treating either as an
 * interrogative turned a pure order into a closable information request — the
 * reviewer's zero-tool counterexample. 呢 still ends a question when the clause
 * carries its own interrogative content ("主题是不是需要更新呢？"); 吧 never
 * does. A clause whose own opening word is a question (怎么/如何) is handled by
 * {@link INFO_OPENING} and {@link QUESTION_LEAD}.
 */
const QUESTION_ENDING = /(?:吗|[？?])[。，、；;.!]*$/u
/** The softening particles that ask only when the rest of the clause asks too. */
const SOFT_ENDING = /(?:呢|吧)[。，、；;.!]*$/u
const QUESTION_MARKER = /[？?]|是否|是不是|为什么|为何|怎么|如何|什么|哪些|哪一种|能否|可否|要不要|该不该|由谁|是谁/u

/** Whether the clause closes on a genuine interrogative. */
function endsOnInterrogative(masked: string): boolean {
  if (QUESTION_ENDING.test(masked)) return true
  return SOFT_ENDING.test(masked) && QUESTION_MARKER.test(masked.replace(/[呢吧][。，、；;.!]*$/u, ''))
}
/**
/**
 * An English clause whose INTERROGATIVE is the object of its own action rather
 * than the clause's question: "Create a file recording whether the tests
 * passed", "Write a report indicating whether deployment succeeded". The
 * embedded whether/if/wh-word follows the action, so the clause orders work and
 * the interrogative only says WHAT the artifact must record.
 */
const ENGLISH_INTERROGATIVE_TRIGGER = /\b(?:whether|if|what|which|why|how|when|where|who)\b/i

/**
 * Whether an English clause opens with a verb that takes the interrogative as
 * its OWN object and continues with `if`: "Check if the remote has new
 * commits", "Verify if the build passed". The head is the verb plus the "if";
 * anything else after that verb is its object clause, not a condition.
 */
function interrogativeTakesIfObject(masked: string): boolean {
  if (!investigationHeadTakesIf(masked)) return false
  // The clause's own action has to BE the matched head's verb, not a later action
  // word: "Check if the lock file is current AND INSTALL the package." coordinates
  // a second instruction, so the investigation reading covers only the asking part
  // and the clause is partitioned (review 11).
  const head = /^\s*(?:please\s+)?(check|verify|confirm|see|determine|inspect|review|test)\s+(?:if|whether|when|where|why|how|what|which)\b/i.exec(masked)!
  const verb = firstActionVerb(masked)
  const verbOffset = head[0].search(/check|verify|confirm|see|determine|inspect|review|test/i)
  if (verbOffset < 0) return false
  return verb < 0 || verb === verbOffset
}

/**
 * Whether the clause OPENS with an investigation verb whose object is the
 * interrogative `if`/`whether`/…, whatever else the clause contains. This is the
 * head-level form of {@link interrogativeTakesIfObject}, used by the condition
 * splitter: a clause that starts this way is an investigation, so its `if` is not
 * a condition on a separate instruction.
 */
function investigationHeadTakesIf(masked: string): boolean {
  const head = /^\s*(?:please\s+)?(check|verify|confirm|see|determine|inspect|review|test)\s+(?:if|whether|when|where|why|how|what|which)\b/i.exec(masked)
  if (head === null) return false
  // A negated or reserved investigation is a ban or a condition, not a
  // question, so the verb itself has to be a positive, unreserved head.
  const verb = firstActionVerb(masked)
  if (verb >= 0 && verbIsNegated(masked, verb)) return false
  // No subordinate boundary may stand between head and object: in
  // "Create /tmp/check.sh to determine if the service is running" the `if`
  // belongs to the purpose clause, so the clause orders a creation and is NOT
  // conditional (review 4).
  const boundary = ENGLISH_SUBORDINATE_BOUNDARY.exec(masked)
  return boundary === null || 0 < boundary.index
}

/**
/**
 * A boundary that opens an ENGLISH subordinate span: every `to <verb>` purpose
 * clause, a relative pronoun, a progressive participle, and the prepositional
 * or temporal openers that introduce one. A question word behind such a
 * boundary belongs to the subordinate clause, so it never makes the whole
 * clause a question. This is structural, not a verb list: an unknown main verb
 * ("Archive /tmp/logs to show what changed", "Compress /tmp/logs to check the
 * status") is still read correctly, which is what the earlier vocabulary-based
 * gate could not do.
 *
 * The comparative is `than`, NOT `tha[nt]`: `then` is a sequencing connective,
 * and reading it as a boundary made "Then check whether the disk is full." look
 * like a subordinate span whose question word belonged to a purpose clause — so
 * the English clause lost the investigation lane while the Chinese spelling kept
 * it (hold-out 7).
 */
const ENGLISH_SUBORDINATE_BOUNDARY = /\bto\s+[a-z]+|\b(?:which|who|whom|whose|that|than)\b|\b[a-z]+ing\b|\b(?:after|before|until|unless|while|once|during|about|for|regarding|concerning)\b/i

/**
 * Whether an English interrogative word ASKS the clause, rather than sitting in
 * its subordinate span. A wh-word that is followed by a subordinate boundary
 * ("... recording whether the tests passed", "... to show what changed") is the
 * object of that span, so the clause stays work.
 */
/**
 * Whether an investigation head opens the clause rather than sitting inside a
 * subordinate span. A head behind a purpose or relative boundary is that span's
 * verb ("Compress /tmp/logs TO CHECK the status"), so it asks nothing (review 4).
 */
function headOpensClause(pattern: RegExp, masked: string): boolean {
  const match = pattern.exec(masked)
  if (match === null) return false
  const boundary = ENGLISH_SUBORDINATE_BOUNDARY.exec(masked)
  if (boundary !== null && boundary.index < match.index) return false
  const verb = firstActionVerb(masked)
  return verb < 0 || match.index <= verb
}

/**
 * Whether a condition marker guards the CLAUSE rather than sitting inside a
 * purpose or relative span. "Create /tmp/check.sh to determine if the service is
 * running" orders a creation; the `if` belongs to the purpose clause, so the
 * creation is not conditional (review 4).
 */
const CJK_SUBORDINATE_BOUNDARY = /为了|用来|以便|从而|进而|用于/u
function conditionMarkerIsClauseLevel(masked: string, markerIndex: number): boolean {
  const english = ENGLISH_SUBORDINATE_BOUNDARY.exec(masked)
  const cjk = CJK_SUBORDINATE_BOUNDARY.exec(masked)
  const starts = [english?.index, cjk?.index].filter((index): index is number => index !== undefined)
  if (starts.length === 0) return true
  return Math.min(...starts) >= markerIndex
}

function englishInterrogativeIsMatrix(masked: string): boolean {
  const trigger = ENGLISH_INTERROGATIVE_TRIGGER.exec(masked)
  if (!trigger) return true
  const boundary = ENGLISH_SUBORDINATE_BOUNDARY.exec(masked)
  // A boundary at the interrogative's OWN position is the interrogative itself
  // ("Who owns …?", where `who` is both the trigger and a relative pronoun), not a
  // subordinate span that swallows it.
  return boundary === null || trigger.index <= boundary.index
}
/**
 * Request and sequencing words that may precede an instruction head without
 * becoming one: "先检查是否有新版本" is still the investigation "检查是否有新
 * 版本". A preface is consumed only in front of an investigation opener, so
 * "先提交" stays an order. The English sequencing words are here for the same
 * reason as the Chinese ones: "Then check whether the disk is full." is the
 * investigation "check whether …", and leaving the preface out made the English
 * clause an acceptance obligation while the Chinese spelling stayed an
 * information request (review 5 follow-up / hold-out 7).
 */
const REQUEST_PREFACE = '(?:那么|然后|接着|随后|首先|先|再|也|请|麻烦|帮我|并且|并|以及|then\\b|also\\b|next\\b|first\\b|finally\\b|now\\b|please\\b|kindly\\b)?'
/** Investigation openers: how an information request about state is phrased. */
const INVESTIGATION_HEAD = '(?:看看|看一下|瞅瞅|查一下|检查|查看|确认|核对|了解|验证|check\\b|verify\\b|confirm\\b|see\\b|find\\s+out|determine\\b)'
/** The interrogative a clause can open or close on: "怎么装？", "whether …". */
const QUESTION_WORD = '(?:怎么|怎样|如何|为什么|为何|什么|哪些|哪一种|哪个|是否|是不是|能否|可否|要不要|该不该|由谁|是谁|谁|何时|什么时候|几时|多久|多少|what|how|when|where|who|whom|whose|which|whether|why)'
/** The states a question about a change asks about ("是否有更新"). */
const CHANGE_STATE = '(?:更新|升级|提交|推送|发布|安装|修改|删除|修复|完成|同步|拉取|下载|重启|生成|写入|创建|部署|添加|变更|改动|new\\s+commits?|update[sd]?|upgrade[sd]?|commit(?:s|ted)?|push(?:ed)?|publish(?:ed)?|install(?:ed)?|change[sd]?|fix(?:ed)?)'

/** Chinese question words need no word boundary; an English one does. */
const QUESTION_WORD_TAIL = '(?![A-Za-z0-9_])'
/** The same alternation as a pattern, for a caller that only needs to test. */
const QUESTION_WORD_PATTERN = new RegExp(QUESTION_WORD, 'iu')
const QUESTION_LEAD = new RegExp(`^\\s*${QUESTION_WORD}${QUESTION_WORD_TAIL}`, 'iu')
/**
 * An investigation word, the object it investigates (if any), and a
 * question about that object's state: 检查是否…, 检查一下插件是否有更新,
 * check whether…. The verb states HOW the question is answered, so the clause
 * asks about the world rather than ordering a change.
 */
const INVESTIGATION_THEN_QUESTION = new RegExp(`^\\s*${REQUEST_PREFACE}\\s*${INVESTIGATION_HEAD}[^。！？；，,]{0,24}?(?:是否|是不是|有没有|有没|能否|可否|要不要|该不该|为什么|为何|怎么|如何)${QUESTION_WORD_TAIL}`, 'iu')
/**
 * A question about a change's state: "…是否有更新", "…有没有安装成功",
 * "whether the remote has new commits". The change verb is the object of the
 * question, so the clause asks rather than orders.
 */
const QUESTION_ABOUT_CHANGE = new RegExp(`(?:是否|是不是|有没有|有没|能否|can\\s+you\\s+see|whether)\\s*(?:已经|已|还|仍然)?\\s*(?:有|存在|出来|成功)?\\s*${CHANGE_STATE}${QUESTION_WORD_TAIL}`, 'iu')
/**
 * An investigation word applied to a state object: "Check for a new version",
 * "看看有没有新版本", "verify the current version". The verb asks ABOUT the
 * object rather than ordering a change to it, which is the same reading
 * {@link QUESTION_ABOUT_CHANGE} gives the 是否 form.
 */
const STATE_OBJECT = '(?:状态|版本|更新|变更|改动|发布|提交|结果|日志|配置|权限|依赖|端口|缓存|status|state|version|update|upgrade|release|commit|change|result|logs?|config(?:uration)?|permissions?|dependencies|port|cache)'
const INVESTIGATION_OF_STATE = new RegExp(`${INVESTIGATION_HEAD}\\s*(?:一下|下)?\\s*(?:for|about|on|the|a|an|new|current|latest|有没(?:有)?|关于)?\\s*(?:for|about|on|the|a|an|new|current|latest|有没(?:有)?)?\\s*(?:for|about|on|the|a|an|new|current|latest)?\\s*${STATE_OBJECT}${QUESTION_WORD_TAIL}`, 'iu')
/**
 * An investigation whose head word IS an investigation, followed immediately by
 * the interrogative: "How do I install this?" / "看看怎么弄". An investigation
 * word that merely sits inside an object ("仔细检查生成的几个文件") is not the
 * clause's head, and one whose object happens to be a question word is not a
 * question about method.
 */
const INFO_OPENING = new RegExp(`^\\s*${REQUEST_PREFACE}\\s*${INVESTIGATION_HEAD}\\s*${QUESTION_WORD}${QUESTION_WORD_TAIL}`, 'iu')
/**
 * A reported question: a reporting verb hands the question to the assistant
 * ("Tell me what changed in the build and why"). The clause asks, so the
 * answering turn closes it — no execution obligation is created.
 */
const REPORTED_QUESTION = new RegExp(`(?:^|[^A-Za-z0-9_])(?:(?:tell|explain|describe|show)\\b|(?:解释|说明|描述|讲解|讲讲|说一下|告诉我))[^。！？；]{0,24}?${QUESTION_WORD}${QUESTION_WORD_TAIL}`, 'iu')

/**
 * Whether a clause asks for information rather than ordering work (0.6.3 K1).
 *
 * 0.6.2 treated the mere presence of a question marker anywhere in a clause as
 * "the whole clause is a question", so one 是否 inside a comma-run of
 * instructions ("更新插件，检查是否存在更新，安装新主题，记录变更。") turned
 * every execution obligation beside it into closable information. The reading
 * is now grammatical — head verb, interrogative position, negation — so a
 * relative or purpose clause inside an order ("Create a file where logs are
 * stored", "更新皮肤中心，看看为什么失败") is never a question, while a real
 * request for an answer ("How do I install this?", "检查是否有更新吗？",
 * "check whether the remote has new commits") still is.
 */
export function hasQuestionScope(masked: string): boolean {
  return isInformationalFragment(masked)
}

/**
 * True when the fragment is a pure request for information.
 *
 * A fragment that names an action counts as a question only when it ENDS on
 * the interrogative ("检查一下插件是否有更新吗？") or asks through the verb
 * itself ("检查是否存在更新", "check whether the remote has new commits"). An
 * order whose object merely contains question content ("更新皮肤中心，看看为
 * 什么失败") stays an order. A fragment that names no action is information
 * whenever it asks at all, which keeps "what changed in the build and why" and
 * "How do I install this?" in the answerable lane.
 */
/**
 * A REPORTING or EXPLANATION head: the verbs whose complement is the rest of the
 * sentence ("Explain how I can install foo and restart service api.",
 * "说明一下如何回滚并重新部署服务"). English reporting verbs and their Chinese
 * counterparts are both closed grammatical classes.
 */
const REPORTING_HEAD = new RegExp(`^\\s*(?:${REQUEST_PREFACE}\\s*)?(?:tell|explain|describe|show|wonder|ask|know|recall|decide|determine|establish|find\\s+out|figure\\s+out)\\b|^\\s*(?:${REQUEST_PREFACE}\\s*)?(?:解释|说明|描述|讲解|讲讲|说一下|告诉我|想问|问一下|想知道|了解一下|不确定|不清楚|不清楚|不知道)`, 'iu')

/**
 * Whether an explanation head GOVERNS its sentence.
 *
 * Everything coordinated inside the sentence the explanation heads is the OBJECT
 * of the explanation, however it is phrased and however long it is: a finite
 * complement ("how I can install …"), a `whether` complement, an infinitive, a
 * list with a long object — all of it is what the root asked to have explained.
 * The scope is therefore structural: it is the SENTENCE, bounded by the sentence
 * splitter, not a pattern with a window. A sentence break ends the governance, so
 * a following sentence can be a real instruction ("Explain the deploy. Then
 * restart service api." stays authorizable), and a question that merely stands
 * beside an order ("What changed and archive the logs?") has no explanation head
 * and keeps its order.
 */
export function reportingHeadGoverns(masked: string): boolean {
  return headOpensClause(REPORTING_HEAD, masked)
}

/**
 * Whether a clause is the scope of a QUESTION — any question, not only a reported
 * one: a question word ("How do I install …"), an interrogative auxiliary
 * ("Can you …"), an investigation ("Check whether …") or an explanation
 * ("Explain how …").
 *
 * A question head GOVERNS its clause: everything coordinated inside it is part of
 * what the root asked, so the clause must not be split into an executable child.
 * When such a clause ALSO carries an action of its own it is undecided — the
 * action may be exactly what the question is about — so nothing in it is
 * authority. Exported so the mutation gate and preparation consume the SAME
 * qualification the reading produced instead of re-guessing scope from the split
 * text, and so the rule is testable on its own.
 */
export function isQuestionScopeNeedingReview(text: string): boolean {
  const masked = maskCodeSpans(text)
  return governedReadingOf(masked) !== undefined && governedClauseRestrictsExecution(masked)
}

/**
 * A temporal interrogative: the clause asks WHEN, so its `when` is the question
 * word, not a condition marker. A finite conditional clause states its own
 * subject and verb instead ("when the tests pass").
 */
function isTemporalQuestion(masked: string): boolean {
  if (!/[？?]\s*$/u.test(masked.trim())) return false
  return /^\s*(?:when|何时|什么时候|什么时候)\s*(?:should|do|does|did|can|could|would|will|is|are|was|were|have|has|had|i|we|you|they|he|she|it|to)\b/iu.test(masked)
    || /^\s*(?:何时|什么时候|何时)/u.test(masked)
}

// ---------------------------------------------------------------------------
// Execution qualification: the single place where an execution reading is born
// ---------------------------------------------------------------------------

/**
 * 0.6.3 (narrowed contract): the execution qualification of one reading.
 *
 * Recognising an ACTION and holding AUTHORITY to run it are separate facts. The
 * reader decides, ONCE per clause and BEFORE any partition, whether the clause is
 * a `granted` plain instruction or a `restricted` governed scope (a question, an
 * explanation, an investigation, a reported question, or a quote). Every child the
 * partition later produces INHERITS that decision; nothing downstream — not the
 * projection, not recovery, not preparation — may upgrade a child to executable by
 * re-reading its own words (the earlier rounds' fail-open direction).
 *
 * `restricted` is not "no work": a restricted clause that names an action keeps it
 * as an undecided obligation ({@link AuthorityDisposition} `unresolved`) which no
 * answer closes and no certificate covers.
 */
export type QualificationStatus = 'granted' | 'restricted'
export type QualificationReason =
  | 'plain_instruction'
  | 'governed_scope'
  /** A clause whose own question content was not classified, or that names no
   *  recognised action: no positive evidence for an execution reading. */
  | 'unproven_scope'
  | 'inherited_restriction'
  | 'legacy_missing_qualification'
export interface ExecutionQualification {
  status: QualificationStatus
  reason: QualificationReason
  /** The governing head that restricted the clause, when one exists. */
  governedBy?: string
}

/**
 * The quoted spans of a text, in every style the products accept: straight and
 * curly double quotes, single quotes (opened only at a word boundary, so an
 * English apostrophe never swallows a clause), and the CJK brackets 「」 and 『』.
 *
 * A quote OWNS its content and its punctuation: what it contains is never the
 * clause's own reading or its own work, and a sentence mark inside it never ends
 * the enclosing clause. `inside` is a per-code-unit map aligned with the input, so
 * a scanner can ask whether an offset sits inside a quote.
 */
/** The characters after which a single quote OPENS a quotation rather than being
 *  an apostrophe ("'Install foo…'", "the user's file"). */
const QUOTE_OPENING_BOUNDARY = new Set(' \t\n:：,，、(（[【—')

/** Whether a single quote at the offset opens a quotation instead of an apostrophe. */
function isQuoteOpeningBoundary(text: string, cursor: number): boolean {
  if (cursor === 0) return true
  return QUOTE_OPENING_BOUNDARY.has(text[cursor - 1]!)
}

function quotedSpans(text: string): { masked: string; inside: boolean[] } {
  const inside: boolean[] = Array.from({ length: text.length }, () => false)
  let masked = ''
  let closer: string | undefined
  for (let cursor = 0; cursor < text.length; cursor += 1) {
    const character = text[cursor]!
    if (closer !== undefined) {
      inside[cursor] = true
      masked += ' '
      if (character === closer) closer = undefined
      continue
    }
    const opens = character === '"' ? '"'
      : character === '“' ? '”'
        : character === '「' ? '」'
          : character === '『' ? '』'
            : character === '‘' ? '’'
              : character === "'" && isQuoteOpeningBoundary(text, cursor) ? "'"
                : undefined
    if (opens !== undefined) {
      closer = opens
      inside[cursor] = true
      masked += ' '
      continue
    }
    masked += character
  }
  return { masked, inside }
}

/** Blank out every quoted span of the text. */
export function maskQuotedSpans(text: string): string {
  return quotedSpans(text).masked
}

/** Whether the offset lies inside a quoted span. */
function insideQuote(masked: string, index: number): boolean {
  return quotedSpans(masked).inside[index] === true
}

/**
 * Whether the clause's OWN span asks something, even when no governed head was
 * recognised. This is the fail-closed half of the qualification: a clause whose
 * question content the reader could not classify (`I wonder whether …`, a
 * postposed 是否可行, a stray question mark) is still a scope that cannot host
 * execution authority. Code spans, quotes and subordinate spans do not count:
 * their content belongs to them, not to the clause.
 */
export function clauseAsksOwnQuestion(text: string): boolean {
  const own = withoutSubordinateQuestions(maskCodeSpans(maskQuotedSpans(text)))
  // An explicit restatement names its object as DATA ("把 X 明确为 Y"): what X says
  // is not this clause's own question.
  if (REBIND_DIRECTIVE.test(own.trim())) return false
  if (/[？?]/u.test(own)) return true
  const marker = GOVERNED_QUESTION_MARKER.exec(own)
  if (marker === null) return false
  if (!/^[A-Za-z]/.test(marker[0])) return true
  // A LATIN interrogative mid-clause is a relative or purpose use ("Create a file
  // where logs are stored") unless the clause opens with it, is carried by an
  // interrogative auxiliary, or REPORTS it ("I wonder whether …").
  const head = own.replace(/^[\s,，、；;]*(?:(?:并且|以及|而后|然后|接着|并|且|和|与|及)|(?:and|then|but|also|next|so)\b)?[\s,]*/iu, '')
  const reported = /\b(?:wonder|wonders|wondering|ask|asks|asking|unsure|know|knows|recall|decide|decides|determine|determines|figure\s+out|find\s+out|establish|confirm|verify|check|see|not\s+sure|no\s+idea)\b/iu
    .test(own.slice(0, marker.index))
  return GOVERNED_QUESTION_MARKER.exec(head)?.index === 0
    || INTERROGATIVE_AUXILIARY_LEAD.test(own.trim())
    || reportingHeadGoverns(own)
    || reported
}

/**
 * Whether the clause is a DIRECTIVE: an imperative in the root's voice. The action
 * must OPEN the clause once the request preface is consumed ("重启 api 服务。",
 * "Then restart service api.", "请更新插件"), and the clause must not be a report
 * or a third-party statement ("The technicians restart service api every night.",
 * "日志显示运维人员重启 api 服务。").
 */
export function opensWithDirective(masked: string): boolean {
  const own = maskCodeSpans(maskQuotedSpans(masked))
  // An EXPLICIT root statement of what an obligation means is a new authorization
  // in its own right: "把更新插件明确为 apply package demo@2.0.0 profile web" is the
  // sanctioned clarification route, and the contract says an explicit root
  // authorization establishes a new execution reading.
  if (REBIND_DIRECTIVE.test(own.trim())) return true
  const stripped = stripDirectivePreface(own)
  const verb = firstActionVerb(stripped)
  // An imperative may carry a fronted actor, locative or object phrase: "由你升级 …",
  // "由我手动重启 …", "在仓库提交变更". Those prefixes are closed-class, so a
  // third-party SUBJECT ("The technicians restart …", "日志显示运维人员重启 …") is
  // still not a directive.
  const fronted = verb > 0 && /^(?:(?:由|让|请|给|对|把|将|在|从|按|按照|根据|依|替|帮)[^，,。；;！!？?]*|(?:明天|今天|后天|今晚|明早|现在|马上|立即|稍后|待会儿?|之后|以后|下周|本周|最近|尽快)[^，,。；;！!？?]*)$/u.test(stripped.slice(0, verb))
  if (verb !== 0 && !fronted) return false
  if (mainClauseTailReport(stripped) || NARRATIVE_DIRECTIVE.test(stripped)) return false
  // An action at the head is necessary but not sufficient: with a DESCRIPTIVE
  // predicate the clause describes the action instead of ordering it
  // ("重启 api 服务是一个危险操作。" / "Restart service api is dangerous.").
  if (descriptivePredicate(stripped)) return false
  return true
}

/**
 * Whether the clause's MATRIX predicate is descriptive. The test reads the clause up
 * to its first English relative/interrogative marker, so a relative clause
 * ("Create a file where logs are stored") is not mistaken for a copula.
 */
function descriptivePredicate(stripped: string): boolean {
  // Only the clause the action head belongs to can describe it: a copula in a
  // FOLLOWING clause ("重启 api 服务，这是一个危险操作。") describes the action, it does
  // not turn the action itself into a statement.
  const matrix = stripped.split(/[，,；;。！!？?]|\b(?:which|who|whom|whose|that|where|when|why)\b/iu)[0] ?? stripped
  return DESCRIPTIVE_PREDICATE.test(matrix)
}

/**
 * The copulas and descriptive links that turn an action-headed clause into a
 * statement. Narrow on purpose: a modal or a bare verb is not one of them.
 */
const DESCRIPTIVE_PREDICATE = /(?:\p{Script=Han}|[^\p{L}])是(?:一种|一个|属于)?|(?:\p{Script=Han}|[^\p{L}])(?:属于|意味着|表示|表明|导致|会造成)|\b(?:is|are|was|were|means|causes|requires|leads\s+to)\b/iu

/**
 * The content a restatement introduces: the Y of "把 X 明确为 Y" / "record X as Y".
 * Everything the restatement AUTHORIZES comes from this span, and nothing else.
 */
export function restatedContentOf(text: string): string | undefined {
  const own = maskCodeSpans(maskQuotedSpans(text))
  const marker = /(?:明确为|明确成|指定为|标记为|记为|设为|认作|重绑定为)/u.exec(own)
  if (marker !== null) {
    const restated = own.slice(marker.index + marker[0].length).trim()
    return restated === '' ? undefined : restated
  }
  const english = /\bas\b([\s\S]*)$/iu.exec(own)
  if (english === null) return undefined
  const restated = (english[1] ?? '').trim()
  return restated === '' ? undefined : restated
}

/**
 * Whether the restated content is a canonical operation SPEC: it OPENS with an
 * operation the capture layer can act on (an imperative head, or a head token that
 * resolves to a semantic action), without asking a question and without a
 * descriptive predicate. Naming an action somewhere inside prose is not enough.
 */
function restatedContentIsOperation(content: string): boolean {
  const body = content.replace(/^[\s,，、；;：:。.!！?？"'“”‘’「」『』]+/u, '').trim()
  if (body === '') return false
  if (clauseAsksOwnQuestion(body)) return false
  if (descriptivePredicate(body)) return false
  if (firstActionVerb(body) === 0) return true
  const token = /^[A-Za-z][A-Za-z0-9_@.-]*/u.exec(body)?.[0] ?? body.slice(0, 2)
  const head = semanticActionFromText(token)
  return head !== 'generic_run' && head !== undefined
}

/** The span a restatement CLARIFIES: everything before its marker. */
export function clarifiedSpanOf(text: string): string | undefined {
  const own = maskCodeSpans(maskQuotedSpans(text))
  const marker = /(?:明确为|明确成|指定为|标记为|记为|设为|认作|重绑定为)/u.exec(own)
  if (marker !== null) {
    const clarified = own.slice(0, marker.index).trim()
    return clarified === '' ? undefined : clarified
  }
  const english = /\bas\b/iu.exec(own)
  if (english === null) return undefined
  const clarified = own.slice(0, english.index).trim()
  return clarified === '' ? undefined : clarified
}

/** Whether the clause is an explicit re-statement of what an obligation means. */
export function isRestatement(text: string): boolean {
  return REBIND_DIRECTIVE.test(maskCodeSpans(maskQuotedSpans(text)).trim())
}

/**
 * The closed phrasing of an explicit re-statement: the root says what an earlier
 * obligation is to mean. This is a directive even though its own verb is not an
 * operation ("把 X 明确为 …", "clarify X as …").
 */
const REBIND_DIRECTIVE = /^\s*(?:请|麻烦|帮我)?\s*(?:把|将)[^。！？；，,]{1,40}?(?:明确为|明确成|指定为|标记为|记为|设为|认作|重绑定为)|^\s*(?:please\s+)?(?:clarify|treat|interpret|record|rebind)\b[^.!?]{0,48}?\bas\b/iu

/** Consume the request prefaces a directive may carry in either language. */
function stripDirectivePreface(text: string): string {
  let body = text.replace(/^[\s,，、；;：:。.!！?？]+/u, '')
  for (let step = 0; step < 4; step += 1) {
    const next = body
      .replace(/^(?:那么|然后|接着|随后|首先|先|再|也|请|麻烦|帮我|帮忙|并且|并|以及|同时|顺便|而后|且|和|与|及)\s*/u, '')
      .replace(/^(?:and|then|also|next|first|finally|now|please|kindly|but|so)\b[\s,]*/iu, '')
      .trim()
    if (next === body) break
    body = next
  }
  return body
}

/**
 * Whether the clause is a PROTECTED scope: a question, an explanation, an
 * investigation, a reported question, a quote, or any span whose own question
 * content the head reader could not classify. A protected scope is indivisible —
 * no separator opens a child of it — and nothing inside it is execution authority.
 */
export function clauseIsProtected(text: string): boolean {
  return governedReadingOf(maskCodeSpans(maskQuotedSpans(text))) !== undefined
    || clauseAsksOwnQuestion(text)
}

/** A clause nobody has questioned: its own reading is the authorization. */
export const GRANTED_QUALIFICATION: ExecutionQualification = { status: 'granted', reason: 'plain_instruction' }
/** A record captured before the qualification existed: never granted by default. */
export const LEGACY_QUALIFICATION: ExecutionQualification = { status: 'restricted', reason: 'legacy_missing_qualification' }

/** The question content of a clause that is not inside a quoted code span. */
const GOVERNED_QUESTION_MARKER = /是否|有没有|有没|能否|可否|要不要|该不该|为什么|为何|怎么|怎样|如何|什么|哪些|哪一种|哪个|谁|何时|什么时候|几时|多久|多少|吗|([\p{Script=Han}])不\1|\b(?:whether|what|which|who|whom|whose|when|where|why|how)\b/iu
/** Purpose and relative spans, which carry their own content rather than the clause's. */
const SUBORDINATE_PURPOSE_ZH = /(?:为了|用来|以便|从而|进而|用于|好让)[\s\S]*$/u
const SUBORDINATE_PURPOSE_EN = /\b(?:showing|recording|noting|checking|to|in order to)\s+[\s\S]*$/iu

/**
 * The clause text whose question content is the CLAUSE's own rather than a
 * subordinate span's object. A purpose or participial span is set aside only when
 * it carries the question content itself ("打包日志以便确认哪些请求失败",
 * "Create a report showing whether the tests passed") — never when the question is
 * the clause's own and an infinitive follows it ("Confirm whether it is safe to
 * install foo and restart service api."), where setting the span aside would drop
 * the actions into the answer lane.
 */
function withoutSubordinateQuestions(masked: string): string {
  const strip = (pattern: RegExp): void => {
    masked = masked.replace(pattern, (span) => GOVERNED_QUESTION_MARKER.test(span) ? '' : span)
  }
  strip(SUBORDINATE_PURPOSE_ZH)
  strip(SUBORDINATE_PURPOSE_EN)
  return masked
}

interface GovernedReading {
  head: 'reporting' | 'investigation' | 'question'
  /** Offset of the clause's own question word, when it has one. */
  marker?: number
  markerLength: number
}

/**
 * The governed reading of a clause, or `undefined` when the clause is a plain
 * statement or instruction. The head tests are the closed grammatical classes the
 * earlier rounds established; nothing here looks for a state word, an actor or a
 * vocabulary verb, because absence of a pattern is never evidence of anything.
 */
function governedReadingOf(masked: string): GovernedReading | undefined {
  const own = withoutSubordinateQuestions(masked)
  // An explanation/reporting head governs its clause whatever follows: what it
  // names is what the root asked to have explained, never an order of its own.
  if (reportingHeadGoverns(own)) return { head: 'reporting', ...markerOf(own) }
  // An investigation imperative governs when it ASKS (its own interrogative) or
  // when it coordinates something further. A bare verification order with neither
  // is an acceptance task, not a governed scope: "Verify the generated file" asks
  // nobody a question and must stay work.
  if (INVESTIGATION_HEAD_PATTERN.test(own)) {
    const head = INVESTIGATION_HEAD_PATTERN.exec(own)!
    if (markerOf(own).marker !== undefined || FIRST_COORDINATOR.test(own.slice(head[0].length))) {
      return { head: 'investigation', ...markerOf(own) }
    }
    return undefined
  }
  // A clause-level CONDITION marker is not a question word: "Install the package
  // when the tests pass." orders a conditional action, while "When should I
  // install …?" asks one.
  const condition = prefixConditionIndex(own.toLowerCase())
  const conditioned = condition !== undefined && conditionMarkerIsClauseLevel(masked, condition)
    && !isTemporalQuestion(masked)
    ? own.slice(0, condition)
    : own
  if (QUESTION_LEAD.test(conditioned) || INTERROGATIVE_AUXILIARY_LEAD.test(conditioned.trim())
    || A_NOT_A_LEAD.test(conditioned) || QUESTION_WITH_SUBJECT.test(conditioned)) {
    // An auxiliary-led clause asks only when it closes on a question mark: "Does
    // the release exist?" asks, while "Have these inputs sanitized" is a causative
    // imperative.
    if (INTERROGATIVE_AUXILIARY_LEAD.test(conditioned.trim()) && !QUESTION_LEAD.test(conditioned)
      && !/[？?]\s*$/u.test(conditioned.trim()) && !A_NOT_A_LEAD.test(conditioned)
      && !QUESTION_WITH_SUBJECT.test(conditioned)) return undefined
    const own = markerOf(conditioned)
    // An interrogative auxiliary or an A-不-A head IS the question content: the
    // clause asks even though it carries no question word of its own ("Does the
    // release exist?", "这份文档可不可以更新？").
    return { head: 'question', marker: own.marker ?? 0, markerLength: own.marker === undefined ? 1 : own.markerLength }
  }
  // A sentence-final yes/no particle asks about the WHOLE clause, whatever stands
  // before it ("这个 bug 需要修复吗？").
  if (/吗[\s。！？?]*$/u.test(own.trim()) || /呢[\s。！？?]*[？?][\s。！？?]*$/u.test(own.trim())) {
    const marker = GOVERNED_QUESTION_MARKER.exec(own)
    return { head: 'question', marker: marker?.index ?? 0, markerLength: marker?.[0].length ?? 1 }
  }
  // An English interrogative behind a subordinate boundary belongs to the
  // subordinate span, not to the clause ("Archive the logs that record which
  // shard failed.").
  if (!englishInterrogativeIsMatrix(conditioned)) return undefined
  const marker = GOVERNED_QUESTION_MARKER.exec(conditioned)
  if (marker) {
    const prefix = conditioned.slice(0, marker.index)
    if (/^[A-Za-z]/.test(marker[0])) {
      // A LATIN interrogative behind a subject is a relative or purpose use
      // ("Create a file where logs are stored"), unless the clause is carried by
      // an interrogative auxiliary ("Is it safe to …?").
      const head = prefix.replace(/^[\s,，、；;]*(?:and|then|but|so)\b[\s,]*/iu, '').trim()
      if (head !== '') return undefined
    } else if (/^[\s,，、；;]*(?:并且|以及|并|且|和|与|及)/u.test(prefix)
      && !opensWithGovernedHead(prefix.replace(/^[\s,，、；;]*(?:并且|以及|并|且|和|与|及)/u, ''))) {
      // The clause continues a previous ORDER ("创建文件 /tmp/x 并记录测试是否通过。"):
      // the interrogative is that order's object, so the clause is work of its
      // own. A continued clause that opens with a governed head is that head's
      // question ("并且检查是否存在冲突。").
      return undefined
    } else {
      const joined = coordinationInside(prefix)
      // A Chinese interrogative that follows a coordination of PREDICATES belongs
      // to the coordinated part, not to the clause's own question: "创建文件
      // /tmp/x 并记录测试是否通过。" orders two things, while
      // "确认本地插件和皮肤是否需要更新。" asks about a list of objects. It is the
      // clause's question again when the clause closes on a question mark:
      // "安装 foo 并重启 api 服务是否可行？".
      if (joined !== null && opensWithWork(prefix.slice(joined.index + joined[0].length))
        && !/[？?]\s*$/u.test(conditioned.trim())) return undefined
    }
    return { head: 'question', marker: marker.index, markerLength: marker[0].length }
  }
  return undefined
}

/** The clause's own question word, when it has one. */
function markerOf(own: string): { marker?: number; markerLength: number } {
  const marker = GOVERNED_QUESTION_MARKER.exec(own)
  return marker ? { marker: marker.index, markerLength: marker[0].length } : { markerLength: 0 }
}

/**
 * Whether a QUESTION/EXPLANATION/INVESTIGATION head governs the clause: the one
 * governance predicate every layer consumes (the partitioner, the classifier, the
 * reading, and — through the stored qualification — the gate and preparation).
 */
export function questionHeadsClause(masked: string): boolean {
  return governedReadingOf(masked) !== undefined
}

/** Whether the clause's own reading is a governed scope. */
export function clauseIsGoverned(masked: string): boolean {
  return governedReadingOf(maskCodeSpans(masked)) !== undefined
}

/** The qualification the reader records for one clause. */
export function qualificationOfClause(text: string): ExecutionQualification {
  const masked = maskCodeSpans(text)
  const own = maskQuotedSpans(masked).trim()
  // A restatement ("把 X 明确为 Y", "record X as Y") authorizes nothing by itself:
  // it may RECORD, CLASSIFY or FORBID its object ("把重启 api 服务记为待讨论事项。",
  // "Record restart service api as a hypothetical example.",
  // "把重启 api 服务明确为禁止操作。"). It is a directive only when the RESTATED
  // CONTENT is itself an instruction — the root saying "treat this as <action to
  // perform>" — which is the sanctioned clarification route.
  if (REBIND_DIRECTIVE.test(own)) {
    const restated = restatedContentOf(own)
    if (restated === undefined || isRestatement(restated)) return { status: 'restricted', reason: 'unproven_scope' }
    // The content must pass the SAME judgement a clause passes, and the item takes
    // its action and target from that content, so the action named BEFORE the
    // restatement ("把重启 api 服务明确为检查日志。") is never authorized.
    const inner = qualificationOfClause(restated)
    if (inner.status === 'granted') return GRANTED_QUALIFICATION
    // A canonical OPERATION spec is also a directive — "apply package demo@2.0.0
    // profile web", "inspect_remote_updates" — but only when its HEAD is the
    // operation. Prose that merely mentions one ("需要讨论的重启操作", "解释重启流程",
    // "a description of how technicians restart service api") stays restricted.
    return restatedContentIsOperation(restated) ? GRANTED_QUALIFICATION : { status: 'restricted', reason: 'unproven_scope' }
  }
  const reading = governedReadingOf(maskQuotedSpans(masked))
  if (reading !== undefined) return { status: 'restricted', reason: 'governed_scope', governedBy: reading.head }
  // GRANTED is a POSITIVE finding, never a default: a clause that asks something
  // the head reader could not classify, or that names no action the reader can
  // recognise, is restricted. Storing a granted qualification is the only way an
  // action becomes authorizable, so the absence of a match may never produce one.
  if (clauseAsksOwnQuestion(text)) return { status: 'restricted', reason: 'unproven_scope' }
  const directiveBody = withoutSubordinateQuestions(maskQuotedSpans(masked))
  // Naming an action is NOT an instruction: "The technicians restart service api
  // every night." and "日志显示运维人员重启 api 服务。" mention one. The positive
  // evidence for an execution reading is a DIRECTIVE — the clause is an imperative
  // in the root's voice, opening with the action after any request preface — and a
  // report or a third-party statement is therefore restricted.
  if (!opensWithDirective(directiveBody)) return { status: 'restricted', reason: 'unproven_scope' }
  return GRANTED_QUALIFICATION
}

/**
 * Whether the text OPENS with an action: the piece a coordination introduces
 * ("并安装依赖", "and update the README") is a predicate, while "和皮肤" joins two
 * objects. The head detection is the project's own action reader, so an object
 * whose name is also a work verb ("是否需要更新") is not mistaken for one.
 */
function opensWithWork(text: string): boolean {
  const head = text.replace(/^[\s,，、；;：:]*(?:(?:并且|以及|而后|然后|接着|并|且|和|与|及)|(?:and|then|but|also|next|so)\b)?[\s,]*(?:一下|下|一遍|一次|个)?[\s,]*/iu, '')
  return firstActionVerb(head) === 0 || introducesActionClause(head)
}

/** An action named by the text, whatever vocabulary it comes from. */
function namesWork(text: string): boolean {
  return firstActionVerb(text) >= 0 || introducesActionClause(text) || namesActionSpan(text)
}

/**
 * Whether a GOVERNED clause carries work that its own question does not bound, so
 * that the clause must stay undecided rather than enter the answer lane.
 *
 * The test is structural and vocabulary-free in the direction that matters:
 *
 * - a coordination AFTER the clause's own question word puts the coordinated part
 *   inside the question's scope ("…是否安装 foo 并重启 api 服务"), so the whole
 *   clause is undecided whatever the verbs are;
 * - material BEFORE the question word that carries an action is the questioned
 *   span itself ("检查一下[安装 foo 并重启 api 服务]是否安全"), so it is undecided;
 * - a governed head with no question word of its own is undecided as soon as it
 *   names an action ("Check the safety of installing foo and restart service
 *   api.", "Explain the incident, rotate every credential").
 *
 * A pure question — the object list of "检查一下本地插件和皮肤是否有更新", a state
 * question like "检查是否有新版本。" — carries none of these and stays answerable.
 */
export function governedClauseRestrictsExecution(text: string): boolean {
  const masked = maskCodeSpans(text)
  const reading = governedReadingOf(maskQuotedSpans(masked))
  // A protected scope whose head the reader could not classify is undecided: it
  // keeps its obligation and authorizes nothing, exactly like a recognised one.
  if (reading === undefined) return clauseAsksOwnQuestion(text)
  const own = withoutSubordinateQuestions(masked)
  if (reading.marker === undefined) {
    // A governed head with no question word of its own is undecided as soon as the
    // text it governs names work or coordinates predicates ("Explain the incident,
    // rotate every credential", "Verify that the operator rotates the credentials
    // and redeploys the service."), and a REPORTING head with no question word is
    // never answerable at all. A bare verification order stays an acceptance task.
    if (reading.head === 'reporting') return true
    const body = headBodyOf(own)
    return namesWork(body) || coordinationInside(body) !== null
  }
  // A reporting/explanation head whose complement OPENS work as its predicate is
  // never answerable: what it names may be exactly what the root asked to have
  // explained. A work word standing as the question's own object ("what changed in
  // the build and why") does not make the question an order.
  if (reading.head === 'reporting') {
    const after = own.slice(reading.marker + reading.markerLength)
    if (opensWithWork(after) || opensWithWork(headBodyOf(own.slice(0, reading.marker)))) return true
  }
  const markerEnd = reading.marker + reading.markerLength
  // A coordination AFTER the clause's own question word puts the coordinated part
  // inside the question's scope ("…是否安装 foo 并重启 api 服务"): undecided.
  const tail = own.slice(markerEnd)
  const after = coordinationInside(tail)
  if (after !== null) {
    const rest = tail.slice(after.index + after[0].length).trim()
    if (!BARE_QUESTION_CONTINUATION.test(tail.trim()) && !BARE_QUESTION_CONTINUATION.test(rest)) return true
  }
  // A POSTPOSED question is undecided when the span it questions COORDINATES
  // PREDICATES ("检查一下[安装 foo 并重启 api 服务]是否安全"). A span that merely names
  // one operation inside its object — "检查部署脚本是否已经完成迁移。" — asks about
  // that operation, and a coordination of OBJECTS ("本地插件和皮肤") asks about a
  // list; both stay answerable.
  const questioned = own.slice(0, reading.marker)
  const inside = coordinationInside(questioned)
  if (inside === null) return false
  const left = headBodyOf(questioned.slice(0, inside.index))
  const right = questioned.slice(inside.index + inside[0].length)
  return opensWithWork(left) || opensWithWork(right)
}


/** An investigation whose complement is the declarative clause after `that`. */
const INVESTIGATION_THAT = new RegExp(`^\\s*(?:${REQUEST_PREFACE}\\s*)?(?:${INVESTIGATION_HEAD})\\s+that\\b`, 'iu')

/**
 * The first coordinator that really joins two parts: a leading conjunction is a
 * preface ("并且检查是否存在冲突。"), and a mark with nothing after it belongs to the
 * sentence rather than to a coordinated part ("检查是否存在更新；").
 */
function coordinationInside(own: string): RegExpExecArray | null {
  const pattern = new RegExp(FIRST_COORDINATOR.source, 'giu')
  let match: RegExpExecArray | null
  while ((match = pattern.exec(own)) !== null) {
    const before = own.slice(0, match.index).trim()
    const rest = own.slice(match.index + match[0].length).trim()
    if (before !== '' && rest !== '') return match
    if (match[0].length === 0) break
  }
  return null
}

/** The clause text with its own governed head removed, so the head is not read as work. */
function headBodyOf(text: string): string {
  const head = INVESTIGATION_HEAD_PATTERN.exec(text) ?? REPORTING_HEAD.exec(text)
  return head === null ? text : text.slice(head[0].length)
}

/**
 * The comma/delimiter-bounded clause the cursor sits in: the piece a governed
 * reading is decided on, so a question in one clause never swallows the order in
 * the clause before it.
 */
function clauseAround(masked: string, cursor: number): string {
  const marks = /[，,、；;。！!？?\n\r]/gu
  let start = 0
  for (const match of masked.matchAll(marks)) {
    if (match.index >= cursor) break
    start = match.index + match[0].length
  }
  let end = masked.length
  for (const match of masked.matchAll(marks)) {
    if (match.index >= cursor) { end = match.index; break }
  }
  // A sentence mark that CLOSES the run belongs to the clause, not to a boundary
  // before it: "安装 foo 并重启 api 服务是否可行？" is one governed clause.
  if (/^[？?！!。.]+[\s]*$/u.test(masked.slice(end))) end = masked.length
  return masked.slice(start, end)
}

/**
 * Whether the text is ONE clause: no delimiter inside it other than the sentence
 * mark that closes it. A governed clause is indivisible; a run of clauses is not,
 * because each piece qualifies itself.
 */
function isSingleClause(text: string): boolean {
  // A quote owns its punctuation: a `.` inside "…" never closes the outer clause.
  const inner = maskQuotedSpans(text).trim().replace(/[。．.！!？?；;]+$/u, '')
  return !/[，,、；;。！!？?\n\r]/u.test(inner)
}

/**
 * Whether the text OPENS with a governed head (a question, an explanation or an
 * investigation that asks). Such a head governs its own sentence, so nothing
 * coordinated inside that sentence opens an execution child of its own.
 */
function opensWithGovernedHead(masked: string): boolean {
  const own = withoutSubordinateQuestions(masked.replace(/^[\s,，、；;]*(?:and|then|but|so)\b[\s,]*/iu, ''))
  return reportingHeadGoverns(own)
    || INVESTIGATION_HEAD_PATTERN.test(own)
    || QUESTION_LEAD.test(own)
    || INTERROGATIVE_AUXILIARY_LEAD.test(own.trim())
    || A_NOT_A_LEAD.test(own)
    || QUESTION_WITH_SUBJECT.test(own)
}

/** The UTF-16 code units that may join two predicates of ONE clause. */
function isCoordinatorMark(character: string): boolean {
  return character === '并' || character === '且'
}


/**
 * The first coordinator inside one clause, in either language.
 */
const FIRST_COORDINATOR = /(?:^|[^A-Za-z0-9_])(?:and|then|but)\b|,|，|、|；|;|并且|以及|并|且|和|与|及/iu

/** Whether the text OPENS with an investigation imperative. */
const INVESTIGATION_HEAD_LEAD = new RegExp(`^\\s*(?:${INVESTIGATION_HEAD})`, 'iu')
/** The investigation imperatives that can head a clause. */
const INVESTIGATION_HEAD_PATTERN = new RegExp(`^\\s*(?:${REQUEST_PREFACE}\\s*)?(?:${INVESTIGATION_HEAD})`, 'iu')

/**
 * Whether a coordinated part after the first is an ORDERED part rather than the
 * question's own continuation. A bare interrogative adverb ("and why", "为什么")
 * continues the question; anything else is a second instruction, so the clause is
 * not a pure information request.
 */
const BARE_QUESTION_CONTINUATION = /^[\s，,、；;：:]*(?:and\s+)?(?:why|how|what|which|who|whom|whose|when|where|whether|为什么|为何|怎么|如何|哪里|哪儿|哪些|什么|何时|谁)[.。！？!?]?$/iu
export function hasOrderedCoordination(masked: string): boolean {
  return splitTextFragments(masked)
    .slice(1)
    .some((part) => part.text.trim() !== '' && !BARE_QUESTION_CONTINUATION.test(part.text.trim()))
}

/**
 * The Chinese A-不-A question form, whose 不 is the interrogative's reduplication
 * and not a negator: 需不需要, 可不可以, 对不对, 是不是, 要不要, 该不该. It heads the
 * clause when nothing precedes it, and it asks about the clause it closes when it
 * follows a topic ("这份文档可不可以更新？").
 */
const A_NOT_A_LEAD = /^\s*(?:那么|然后|接着|随后|首先|先|再|也|请|麻烦|帮我|帮忙|并且|并|以及)?\s*([\p{Script=Han}])不\1/u

/** A question whose subject pronoun stands before the interrogative ("你们如何…"). */
const QUESTION_WITH_SUBJECT = /^\s*(?:那么|然后|接着|随后|首先|先|再|也|请|麻烦|帮我|并且|并|以及)?\s*(?:你们|我们|你|我|他们|她们|它们|大家|团队|咱们)\s*(?:怎么|如何|怎样|为什么|为何|什么|哪些|哪|谁)/u
/** @deprecated Use {@link isQuestionScopeNeedingReview}: the rule is not limited to explanations. */
export const isExplanationScope: (text: string) => boolean = isQuestionScopeNeedingReview

/**
 * Whether a coordinated part of the explanation's sentence opens with an action
 * of its own. Those are exactly the parts whose membership in the explanation
 * cannot be decided from the surface, so they make the sentence undecided instead
 * of answerable or executable. `masked` has code spans blanked, so an action that
 * only appears inside backticks contributes nothing.
 */
export function explanationHasActionResidue(masked: string): boolean {
  const parts = splitTextFragments(masked)
  return parts.slice(1).some((part) => part.text.trim() !== '' && fragmentOrdersWorkOnItsOwn(part.text))
}

export function isInformationalFragment(masked: string): boolean {
  // An information request whose own opening word is the question ("How do I
  // install this?", "What changed in the build"), a reported question ("Tell me
  // what changed …"), or an investigation of a state question (检查是否有更新,
  // check whether the remote has new commits).
  // An English question word sitting behind a subordinate span is the OBJECT of
  // that span, not the clause's question, so the clause is never an answerable
  // information request. This has to be decided structurally and FIRST: the
  // span's own main verb may be outside every vocabulary ("Archive /tmp/logs to
  // show what changed", "Compress /tmp/logs to check the status"), and a gate
  // that needs a known verb would call that span the head (review 4).
  if (!englishInterrogativeIsMatrix(masked)) return false
  // An explanation whose sentence also carries an ACTION residue is UNDECIDED:
  // neither closable by an answer nor authorizable. Its complement may be finite
  // ("how you install …", "why we install …") and no surface pattern can bound
  // it, so the decisive question is structural — does a coordinated part open
  // with an action of its own? If it does, nothing in this sentence is authority,
  // because the action may well be what the root asked to have explained, and the
  // absence of a protection pattern is never proof that it left that scope
  // (review 9). A reported question with no action residue ("Tell me what changed
  // in the build and why") keeps its closable lane.
  if (questionHeadsClause(masked)) {
    // A question that also coordinates an action of its own is UNDECIDED (the
    // action may be what the question asks about, so nothing in it is authority).
    if (explanationHasActionResidue(masked)) return false
    // A clause that OPENS with an order is not made information by a question it
    // later asks ("Deploy the build etc. please tell me why it failed?"), and
    // neither is one whose coordination is an ordered part rather than the
    // question's own continuation ("说明一下哪里失败了并归档日志。").
    // A clause that OPENS with an order is not made information by a question it
    // later asks ("Deploy the build etc. please tell me why it failed?"). The
    // clause's own governed HEAD is not such an order, so the action test reads
    // the text with the head removed before it is applied.
    if (firstActionVerb(headBodyOf(masked)) === 0) return false
    if (hasOrderedCoordination(masked)) return false
    // An explanation of a QUOTED command names no readable action and asks
    // nothing: it stays undecidable (0.6.1 W060-02) instead of entering the
    // answer lane.
    if (firstActionVerb(masked) < 0 && !QUESTION_WORD_PATTERN.test(masked)) return false
    // Otherwise the question is what the clause is: answerable, and authority for
    // nothing ("这份文档可不可以更新？", "Tell me what changed in the build and why.").
    return true
  }
  // "Check if …" is an investigation whose interrogative object happens to be
  // spelled `if`. At the FRAGMENT level that is an asking range; at the clause
  // level {@link interrogativeTakesIfObject} refuses it once a second instruction
  // is coordinated, so the partition can separate the two (review 11).
  if (interrogativeTakesIfObject(masked)) return true
  // An investigation of a DECLARATIVE clause ("Check that the migration completed")
  // asks for a verification, so it stays answerable; with a coordination the clause
  // is undecided instead (review 12).
  if (INVESTIGATION_THAT.test(masked)) return true
  if (headOpensClause(INFO_OPENING, masked)) return true
  if (QUESTION_LEAD.test(masked)) return true
  // A clause carrying its OWN instruction is an instruction, whatever mark ends
  // the sentence: "What changed, and update the README?" asks AND orders, and the
  // trailing question mark belongs to the sentence rather than to the ordering
  // fragment, so the order has to survive. The same test decides the
  // comma-less "What changed and archive the logs?" and a Chinese order behind a
  // question ("什么变了并归档日志？").
  if (fragmentOrdersWorkOnItsOwn(masked)) return false
  if (endsOnInterrogative(masked)) {
    // The question has to COVER the clause. A yes/no question (a final 吗/呢, or
    // an English auxiliary) asks about the whole clause. A trailing wh-question
    // asks about itself, so an action head BEFORE it is an execution residue the
    // answer may not close: "Install the package etc. please tell me what
    // changed?" keeps the install (review 7 F2). No preface word list decides
    // this; the residue is read structurally.
    if (questionCoversWholeClause(masked)) return true
    return !executionResidueBeforeQuestion(masked)
  }
  // The remaining English shapes have to be HEADED by the question, not merely
  // contain one. A purpose or relative clause behind the action ("Create a file
  // /tmp/status.txt to show what changed", "Create a script … to check the
  // status") is the action's object, so the clause stays work (review 3 F1).
  if (headOpensClause(REPORTED_QUESTION, masked)) return true
  if (headOpensClause(INVESTIGATION_THEN_QUESTION, masked)) return true
  if (headOpensClause(INVESTIGATION_OF_STATE, masked)) return true
  return !firstActionVerb(masked) && QUESTION_ABOUT_CHANGE.test(masked)
}

/** The coordinating conjunctions that open a continued fragment. */
const COORDINATED_OPENING = /^(?:(?:并且|而且|以及|而后|随后|然后|接着|并|且)|(?:and|then|also|but|however|yet)\b)/iu
/**
 * Question CONTENT: the words that make a clause ask about something, without the
 * bare question mark. Punctuation says where a sentence ends; content says
 * whether the clause is a question at all.
 */
const QUESTION_CONTENT = /是否|是不是|为什么|为何|怎么|如何|什么|哪些|哪一种|哪个|多少|多久|能否|可否|要不要|该不该|由谁|是谁|吗|呢|\b(?:what|which|who|whom|whose|when|where|why|how|whether)\b/iu
/** An interrogative auxiliary that opens the fragment ("Is there any update?"). */
const INTERROGATIVE_AUXILIARY_LEAD = /^(?:is|are|was|were|do|does|did|can|could|should|would|will|has|have|had)\b/iu
/** Chinese text, for the stray-question-mark rule. */
const HAS_HAN = /[\u3400-\u9fff]/u

/**
 * Whether a fragment orders work ON ITS OWN, regardless of the mark that ends it
 * and regardless of whether the splitter left a coordinating conjunction on its
 * head.
 *
 * Two things have to hold: the fragment asks nothing (no question word and no
 * interrogative auxiliary), and it carries an action head — a Chinese action
 * head, a verb the vocabulary knows, or a Latin word the vocabulary does NOT
 * know ("archive the logs?"). The unknown case is the one that kept escaping: a
 * question word earlier in the message, or the sentence's own question mark,
 * must never hand a clause with its own verb to the answer lane (review 5 F2,
 * review 6 F1). A coordinated clause that is still an INVESTIGATION asks even
 * behind the conjunction ("然后检查是否有新版本"), so the question forms are
 * excluded first.
 */
function fragmentOrdersWorkOnItsOwn(masked: string): boolean {
  const trimmed = masked.trim()
  if (!trimmed) return false
  const opening = COORDINATED_OPENING.exec(trimmed)
  const rest = opening
    ? trimmed.slice(opening[0].length).replace(/^[\s，,、；;：:]+/u, '')
    : trimmed
  if (!rest) return false
  // A fragment that ASKS about something is not an instruction, however many
  // verbs it mentions ("主题是不是需要更新呢？", "Is there any update for the
  // plugin?"). Question content, not punctuation, decides this: a bare "?" is
  // exactly what must not protect an order.
  // Question content makes the fragment ask when nothing ORDERS work before it.
  // A fragment whose head is an action and whose interrogative follows is an
  // instruction with a trailing question ("重启 api 服务是否安全" — the asking is
  // the investigation's, this fragment orders the restart), while "这个 bug 需要
  // 修复吗？" keeps asking because its head is not an action (review 11, and the
  // yes/no controls of rounds 2/7).
  const question = QUESTION_CONTENT.exec(rest)
  if (question) {
    const before = rest.slice(0, question.index)
    if (!before.trim()) return false
    // The clause's own INVESTIGATION head is not an order: "检查一下插件是否有更新
    // 吗？" asks, while "重启 api 服务是否安全" orders the restart the question is
    // about (review 11).
    const ordersBefore = (introducesActionClause(before) || firstActionVerb(before) === 0)
      && !INVESTIGATION_HEAD_LEAD.test(before)
    if (!ordersBefore) return false
  }
  if (INTERROGATIVE_AUXILIARY_LEAD.test(rest)) return false
  if (headOpensClause(INVESTIGATION_OF_STATE, rest)) return false
  if (headOpensClause(INVESTIGATION_THEN_QUESTION, rest)) return false
  if (headOpensClause(REPORTED_QUESTION, rest)) return false
  if (headOpensClause(INFO_OPENING, rest)) return false
  if (QUESTION_LEAD.test(rest)) return false
  // The action has to be the fragment's HEAD, not a verb mentioned inside it.
  if (introducesActionClause(rest)) return true
  if (firstActionVerb(rest) === 0) return true
  // A Chinese clause that ends on a question mark but carries no question
  // content is an order with a stray mark ("归档日志？"), so it stays work.
  if (HAS_HAN.test(rest) && /[？?]$/u.test(rest)) return true
  // A Latin head the vocabulary does not know ("archive the logs?") is work too.
  return /^[A-Za-z][A-Za-z0-9_.-]*/.test(rest)
}


/** A yes/no question asks about the whole clause it closes. */
function questionCoversWholeClause(masked: string): boolean {
  if (/(?:吗|呢)\s*[？?]?\s*$/u.test(masked)) return true
  return INTERROGATIVE_AUXILIARY_LEAD.test(masked.trim())
}

/**
 * Whether the interrogative's own fragment carries an action BEFORE it. The action
 * may sit behind a modal or a state word ("需要安装多少依赖", "How many steps
 * install foo"), so any action verb before the interrogative counts — this is the
 * residue the question is ABOUT, which is what makes the clause a question scope
 * rather than an order beside a question.
 */
function actionBeforeInterrogative(fragment: string): boolean {
  const question = QUESTION_WORD_PATTERN.exec(fragment)
  if (question === null) return false
  const before = fragment.slice(0, question.index)
  if (!before.trim()) return false
  // The clause's own INVESTIGATION head is the verb the interrogative is the
  // OBJECT of ("检查是否有更新吗？"), not an action the question is about, so it
  // does not make the clause a question-before-action scope.
  if (INVESTIGATION_HEAD_LEAD.test(before)) return false
  return firstActionVerb(before) >= 0 || introducesActionClause(before)
}

/**
 * The text before the clause's LAST question word, tested with the same
 * structural rule that decides whether a fragment orders work of its own. This
 * is the execution residue a trailing question does not govern.
 */
function executionResidueBeforeQuestion(masked: string): boolean {
  const words = /什么|为什么|怎么|如何|哪些|哪一种|哪个|多少|多久|是否|是不是|能否|可否|要不要|该不该|由谁|是谁|\b(?:what|which|who|whom|whose|when|where|why|how|whether)\b/giu
  let last: number | undefined
  for (const match of masked.matchAll(words)) last = match.index
  if (last === undefined || last === 0) return false
  return fragmentOrdersWorkOnItsOwn(masked.slice(0, last))
}

/** Boundaries that open a new coordinated fragment inside one clause run. */
const FRAGMENT_SEPARATORS = new Set(['，', ',', '、', '；', ';'])
/**
 * An English coordinating conjunction used with NO punctuation. It opens the
 * next fragment, so a mixed clause survives its own lack of commas.
 */
const CONJUNCT_BOUNDARY = /(?:^|[^A-Za-z0-9_])(?:and|then|but|however|yet|also)\b|(?:并且|以及|而后|随后)/iu
/** Openings that continue a coordinated instruction list across a boundary. */
const FRAGMENT_SUBORDINATORS = [
  '但是', '不过', '然而', '同时', '并且', '而且', '以及', '然后', '接着', '而是', '但', '而', '也', '并', '且', '又', '再',
  'but', 'and', 'then', 'also', 'however', 'yet',
]

export function splitTextFragments(text: string, from: number = 0): Array<{ text: string; offset: number }> {
  const fragments: Array<{ text: string; offset: number }> = []
  let cursor = from
  let start = from
  const boundaryAt = (index: number): number | undefined => {
    const character = text[index]!
    if (FRAGMENT_SEPARATORS.has(character)) return index + 1
    // 0.6.3 K1 repair (review counterexample): a coordinating conjunction is a
    // clause boundary even with NO punctuation around it — "Check whether an
    // update exists and install the package." and "检查是否有更新并安装新主
    // 题。" are each a question plus an order. An English conjunction has to
    // stand as its own word, so "handle" and "brand" are never boundaries; a
    // bare 并/且 has to start a word, so the 并 of 合并 is not one either.
    // The multi-character conjunctions are tried FIRST, so 并且 splits at 并
    // rather than leaving a stray 且 behind.
    const match = CONJUNCT_BOUNDARY.exec(text.slice(index))
    if (match && match.index === 0) return index + match[0].length
    // A bare 并/且 opens its own clause only when a DISTINCT instruction follows
    // ("检查是否有更新并安装新主题"): as an adverb inside one action ("合并两个
    // 分支") it merely continues it, and 合并 must never split.
    if ((character === '并' || character === '且') && introducesActionClause(text.slice(index + 1))) {
      return index + 1
    }
    // A coordinator that separates an ASKING clause from a clause that does not
    // ask is a clause boundary whatever verb the second clause uses. Without
    // this, the Chinese spelling of the invariant failed where the English one
    // held: "什么变了并归档日志？" stayed one information range, because 归档 is
    // outside the action vocabulary and the bare-conjunction rule above needs a
    // known head. The question content must sit BEFORE the coordinator, so
    // "合并两个分支" (no question at all) is untouched.
    if ((character === '并' || character === '且')
      && QUESTION_CONTENT.test(text.slice(0, index))
      && !QUESTION_CONTENT.test(text.slice(index + 1))) {
      return index + 1
    }
    return undefined
  }
  while (cursor < text.length) {
    const after = boundaryAt(cursor)
    if (after === undefined) { cursor += 1; continue }
    let next = after
    while (next < text.length && /\s/u.test(text[next]!)) next += 1
    let head = next
    for (const token of [...FRAGMENT_SUBORDINATORS].sort((left, right) => right.length - left.length)) {
      if (text.startsWith(token, next)) { head = next + token.length; break }
    }
    pushFragment(fragments, text, start, head)
    start = head
    cursor = head
  }
  pushFragment(fragments, text, start, text.length)
  return fragments
}

/**
 * Record one fragment, trimmed of the separators that joined it to its
 * neighbours. Trimming only moves the offset, so every character still belongs
 * to exactly one fragment and a span audit keeps its exact positions.
 */
function pushFragment(fragments: Array<{ text: string; offset: number }>, text: string, from: number, to: number): void {
  const raw = text.slice(from, to)
  const body = raw.trim()
    .replace(/^[\s，,、；;]+/u, '')
    // A fragment ends where the NEXT fragment's conjunction begins: an
    // unpunctuated "… exists and install …" leaves the "and" behind.
    .replace(/[\s，,、；;]*(?:and|then|but|however|yet|also)$/iu, '')
    .replace(/[\s，,、；;]*(?:并且|且|并|以及|而后|随后)$/u, '')
    .replace(/[\s，,、；;]+$/u, '')
  if (!body) return
  fragments.push({ text: body, offset: from + raw.indexOf(body) })
}

/**
 * Whether the text after a coordinating conjunction opens a DISTINCT
 * instruction: its own action head, optionally behind a connector and an
 * actor. This is the rule the sentence splitter already used to decide that a
 * conjunction joins two instructions rather than two objects, exposed so the
 * fragment splitter cannot contradict it.
 */
export function introducesActionClause(text: string): boolean {
  const trimmed = text.replace(/^[\s，,、；;：:]+/u, '')
  return CROSS_CLAUSE_HEAD.test(trimmed) || DISTINCT_CLAUSE_HEAD.test(trimmed)
}

/**
 * The masked text of one fragment. Fragments are trimmed, so their own reading
 * is taken from their own bytes: a question ending that belongs to a LATER
 * fragment ("更新插件，安装新主题，检查是否有更新吗？") never decides an
 * earlier one, and the comma that joined them is not part of either.
 */
function fragmentMasked(scope: SplitScope, fragment: { text: string; offset: number }): string {
  return maskCodeSpans(scope.text.slice(fragment.offset, fragment.offset + fragment.text.length))
}

/** The scope a directive run is recorded from, with its own source offsets. */
function directiveScopeOf(text: string, masked: string, offset: number): SplitScope {
  return { text, body: stripConnectors(text), directive: classifyPositive(text, masked), start: offset }
}

/**
 * Whether a fragment states work of its own: it names a non-negated action verb
 * anywhere inside it. A fragment that only names the OBJECT of the verb before
 * it ("安装新主题和更新检查") is part of that instruction, not a second one,
 * so the directive run stays one obligation.
 */
function bearsAction(masked: string): boolean {
  for (const candidate of actionVerbMatches(masked)) {
    if (!verbIsNegated(masked, candidate.index)) return true
  }
  return false
}

/**
 * Whether a fragment states work of its own OUTSIDE quoted data. The action
 * vocabulary has no entry for "explain" and the pure-information route needs a
 * real question, so an explanation whose only action sits inside a code span
 * falls through to `unresolved` — never to `informational`, which delivery would
 * auto-close. Reading the quote as a live order here would misclassify the
 * clause in the other direction.
 */
function bearsLiveAction(masked: string): boolean {
  return bearsAction(masked) || bearsAction(unmaskCode(masked))
}

/** The fragment with its quoted spans removed entirely, so only live words remain. */
function unmaskCode(masked: string): string {
  return masked.replace(/`[^`]*`/g, ' ')
}

interface ClausePart { text: string; offset: number; informational: boolean }

/**
 * Partition a directive run at its fragment boundaries (0.6.3 K1).
 *
 * A clause that orders work AND asks for information is two obligations, not
 * one: "install the package, check whether an update exists, and write a
 * report" must keep the install and the write beside a closable answer.
 * Fragments that only continue the same instruction (a conjunct object list,
 * an explanatory tail) are merged back, so the split is driven by the grammar
 * of each fragment rather than by the punctuation between them.
 *
 * Returns `undefined` when the run is a single obligation, which keeps every
 * ordinary instruction byte-identical to 0.6.2.
 */
function partitionClauseParts(scope: SplitScope, parts: ReadonlyArray<{ text: string; offset: number }>): ClausePart[] | undefined {
  // A sentence boundary inside the run is not this partition's business: it is
  // the caller's own split, and re-cutting it here would invent clauses the
  // sentence splitter already decided against.
  if (/[。！？!?；;\n\r]/u.test(parts[0]!.text)) return undefined
  const informational: boolean[] = parts.map((part) => isInformationalFragment(fragmentMasked(scope, part)))
  // A prohibition is decided by the negation branch, never by this partition:
  // "按 P0—P4 完成本地实现、测试和文档，…，不推送、不正式发布。" must keep its
  // constraint attached to the task it governs.
  if (informational.some((flag, index) => !flag && firstNegation(fragmentMasked(scope, parts[index]!)) !== undefined)) {
    return undefined
  }
  const work = informational.map((flag, index) => !flag && bearsLiveAction(fragmentMasked(scope, parts[index]!)))
  // Only a clause that really mixes the two readings is split. A pure
  // instruction stays exactly one obligation, exactly as 0.6.2 recorded it,
  // however many coordinated actions it names.
  if (!work.some(Boolean) || !informational.some(Boolean)) return undefined
  // Every fragment asks, while the clause's own reading is not information:
  // the question reaches the clause only through a bracketed marker it cannot
  // see. The informational refinement makes that split.
  if (informational.every(Boolean)) return undefined
  const segments: ClausePart[] = []
  let cursor = 0
  while (cursor < parts.length) {
    if (informational[cursor]) {
      let end = cursor
      while (end + 1 < parts.length && informational[end + 1]) end += 1
      const first = parts[cursor]!
      const last = parts[end]!
      segments.push({
        text: scope.text.slice(first.offset, last.offset + last.text.length),
        offset: first.offset,
        informational: true,
      })
      cursor = end + 1
      continue
    }
    // A directive run: it may already have started on an earlier fragment, so
    // its text reaches back to the character after the previous information
    // span (or the start of the clause).
    let start = cursor
    while (start > 0 && !informational[start - 1] && !work[start - 1]) start -= 1
    let end = cursor
    while (end + 1 < parts.length && !informational[end + 1] && (work[end + 1] || !work[start])) end += 1
    const last = parts[end]!
    segments.push({
      text: scope.text.slice(parts[start]!.offset, last.offset + last.text.length),
      offset: parts[start]!.offset,
      informational: false,
    })
    cursor = end + 1
  }
  return segments.length > 1 ? segments : undefined
}

/**
 * Re-partition an informational scope (0.6.3 K1).
 *
 * An information span must cover a COMPLETE, execution-free information range.
 * When a clause was read as information only because a question marker appeared
 * somewhere inside it, the parts that order work are restored as their own
 * clauses and the information scope is reduced to the fragments that really
 * ask. Nothing is dropped: whatever the reading cannot positively classify
 * stays `unresolved` through {@link classifyPositive}, which keeps the
 * remaining obligation visible instead of swallowing it into the answer lane.
 *
 * Returns `undefined` when the whole scope really is a pure information
 * request, which is the common case and stays byte-identical to 0.6.2.
 */
function refineInformationalScope(scope: SplitScope, masked: string): SplitScope[] | undefined {
  const fragments = splitTextFragments(scope.text)
  if (fragments.length < 2) return undefined
  const fragmentAsks = fragments.map((fragment) => isInformationalFragment(fragmentMasked(scope, fragment)))
  // The clause's own reading decides which run is the information range. An
  // informational clause keeps the fragments BEFORE the first ordering one
  // ("更新插件，检查是否有更新，安装…" answers only the question); a clause
  // whose whole-clause reading is a directive keeps the fragments BEFORE the
  // first asking one ("安装主题 A，检查是否有更新。" — the question reaches the
  // clause only through a bracketed 是否, so the leading order is what it
  // reads). Extending the information range over the other run instead would
  // hand the answer lane a clause's worth of work.
  const informationalClause = isInformationalFragment(masked)
  const boundary = fragmentAsks.findIndex((asks) => asks !== informationalClause)
  if (boundary < 0) return undefined
  const scopes: SplitScope[] = []
  const headText = scope.text.slice(0, fragments[boundary]!.offset).replace(/[\s，,、；;]+$/u, '')
  if (headText.trim()) {
    scopes.push({
      text: headText,
      body: stripConnectors(headText),
      directive: informationalClause ? 'informational' : scope.directive,
      ...(scope.condition ? { condition: scope.condition } : {}),
      start: 0,
    })
  }
  const tail = fragments[boundary]!
  scopes.push(directiveScopeOf(scope.text.slice(tail.offset), masked.slice(tail.offset), tail.offset))
  return scopes
}

const NEGATORS: ReadonlyArray<readonly [string, 'zh' | 'en']> = [
  ['不要', 'zh'], ['不用', 'zh'], ['不得', 'zh'], ['不许', 'zh'], ['不准', 'zh'], ['不能', 'zh'],
  ['不必', 'zh'], ['无需', 'zh'], ['毋须', 'zh'], ['勿', 'zh'], ['别', 'zh'], ['甭', 'zh'],
  // Chinese "不" needs a contiguous run, so "在不" and "不足" are not read as bans.
  ['不', 'zh'],
  ['do not', 'en'], ['does not', 'en'], ['did not', 'en'], ["don't", 'en'], ["doesn't", 'en'],
  ["won't", 'en'], ["can't", 'en'], ['cannot', 'en'], ['never', 'en'], ['avoid', 'en'], ['without', 'en'], ['no longer', 'en'],
]

/** Characters that end one coordinated scope and may begin the next. */
const SEPARATORS = new Set(['，', ',', '、', '；', ';', '。', '.', '！', '!', '？', '?', '：', ':', '\n', '\r'])

const CONNECTORS = ['但是', '不过', '然而', '同时', '并且', '而且', '以及', '然后', '接着', '而是', '但', '而', '也', '并', '且', '又', '再', '就', '则']
const ENGLISH_CONNECTORS = ['but', 'and', 'then', 'also', 'however', 'yet']
const CONNECTOR_PATTERN = `(?:${[...CONNECTORS].sort((a, b) => b.length - a.length).join('|')}|${ENGLISH_CONNECTORS.join('|')})`
const CONTINUATION_AFTER_SEPARATOR = new RegExp(`^\\s*${CONNECTOR_PATTERN}`, 'i')
/**
 * Instruction openings that make the text after a bare conjunction its own
 * clause. "并检查 GUI 效果" is a second instruction; "并在本地仓库记录" is
 * handled separately as a locative, and anything else stays one object list.
 */
const CROSS_CLAUSE_HEAD = /^\s*(?:检查|查看|确认|验证|测试|运行|执行|安装|应用|更新|升级|记录|提交|推送|发布|部署|重启|重新启动|创建|新建|生成|修改|编辑|拉取|抓取|删除|回滚|清理|整理|实现|完成)/u
/**
 * Openings that make the text after a conjunction a DISTINCT instruction rather
 * than the second half of one action. "并确认全部通过" completes the action
 * before it, so 确认 is deliberately absent here.
 */
const DISTINCT_CLAUSE_HEAD = /^\s*(?:检查|查看|测试|验证|运行|执行|安装|应用|更新|升级|提交|推送|发布|部署|重启|重新启动|创建|新建|生成|修改|编辑|拉取|抓取|删除|回滚|清理|整理|记录|编写|撰写|实现)/u
/**
 * A place clause that follows a coordinating conjunction: the shape of "并在
 * 本地仓库记录", where the conjunction joins an action to where it happens
 * rather than to a second action.
 */
const LOCATIVE_CLAUSE = /^\s*在.{1,40}?(?:记录|保存|写入)$/u

const USER_ACTOR_PATTERNS = [
  /(?:由|让|给|请)\s*(?:我|本人|我们)/,
  /(?:我|我们)(?:自己|本人)?\s*(?:来|去|会|将|要)?\s*(?:手动|亲自|自行)?\s*(?:重启|重新启动|升级|安装|更新|执行|运行|操作|完成|处理|部署|发布|推送|合并|确认|登录|审批|提供|准备|搭建|检查|验证|测试)/,
  /\bI(?:'ll| will| am going to| myself)\b/i,
  /\b(?:on my own|by myself)\b/i,
]

const AGENT_ACTOR_PATTERNS = [
  /(?:由|让|请)\s*(?:你|您|助手|代理)/,
  /(?:你|您)(?:来|去|会|将|要|负责|自己)/,
  /\byou (?:should|must|need to|will|are to)\b/i,
]

const OUTPUT_NOUN = /命令|脚本|指令|步骤|清单|说明|文档|模板|command|script|instructions?|checklist|snippet/i
const OUTPUT_REQUEST = /(?:给|帮|替|为)(?:我|我们)?\s*(?:写|生成|整理|列|准备|提供|输出|来)|生成(?:一|两|几)?(?:条|个|份)|输出(?:一|个|份)?|列出|列一(?:下|个)|\b(?:provide|write|generate|outline|list|draft)\b|give\s+me/i

const CONDITION_MARKERS: ReadonlyArray<readonly [string, 'prefix' | 'suffix']> = [
  ['如果', 'prefix'], ['假如', 'prefix'], ['倘若', 'prefix'], ['若是', 'prefix'],
  ['一旦', 'prefix'], ['除非', 'prefix'], ['只有', 'prefix'], ['只要', 'prefix'], ['等到', 'prefix'],
  ['若', 'prefix'], ['在', 'prefix'],
  ['if', 'prefix'], ['unless', 'prefix'], ['once', 'prefix'], ['when', 'prefix'], ['provided that', 'prefix'], ['after', 'prefix'],
  ['之后', 'suffix'], ['以后', 'suffix'], ['才', 'suffix'], ['再', 'suffix'],
]

const RESUME_MARKER = /(?:收到|得到|等到|等待|经)\s*.{0,12}?(?:明确|显式|最终)?\s*(?:回报|回复|答复|确认|批准|同意|授权|指示|通知)|(?:我|用户)(?:明确|最终)?\s*(?:确认|回复|回报|批准|同意|授权)(?:后再|之后|后|以后)?|after\s+(?:I|the user)\s+(?:confirm|reply|approve|authorize)|once\s+(?:I|the user)\s+(?:confirm|reply|approve)|waiting\s+for\s+(?:the\s+)?(?:user|you)/i
/**
 * The resumption event itself, without the request prefix a scope may open
 * with. Used to locate the event inside a scope rather than at its start.
 */
const RESUMPTION_EVENT = /(?:收到|得到|等到|等待)\s*.{0,12}?(?:确认|回复|回报|批准|同意|授权|指示|通知)\s*(?:后再|之后|后|以后|再)|(?:我|用户)(?:明确|最终)?\s*(?:确认|回复|回报|批准|同意|授权)\s*(?:后再|之后|后|以后|再)|(?:after|once)\s+(?:I|the user)\s+(?:confirm|reply|approve|authorize)|waiting\s+for\s+(?:the\s+)?(?:user|you)/i

/**
 * A scope that OPENS with the resumption event it waits on. Anchored at the
 * start and greedy, so the match runs to the end of the event itself
 * ("收到我的确认后"): the condition is what the scope says after it.
 */
const RESUME_SCOPE_MARKER = /^(?:请在|请|麻烦|帮我|需要你|务必)?\s*(?:(?:收到|得到|等到|等待)\s*.{0,12}?(?:确认|回复|回报|批准|同意|授权|指示|通知)\s*(?:后再|之后|后|以后|再)|(?:我|用户)(?:明确|最终)?\s*(?:确认|回复|回报|批准|同意|授权)\s*(?:后再|之后|后|以后|再)|(?:after|once)\s+(?:I|the user)\s+(?:confirm|reply|approve|authorize)|waiting\s+for\s+(?:the\s+)?(?:user|you))/i

const NARRATIVE_PAST = /(?:已经|已|刚刚|刚才|此前|之前)(?:经)?(?:推送|发布|提交|安装|升级|重启|合并|完成|修改|更新|删除|创建|写入)|\b(?:already|have|has|had)\s+(?:been\s+)?(?:pushed|published|committed|installed|upgraded|restarted|merged|completed|finished|modified|updated)\b/i
/**
 * Completion aspects that turn a clause into a report: a verb finished with
 * 了/过/完了/好了 states what happened, so it orders nothing. A directive never
 * carries them ("修改 README" is an order, "修改了 README" is a report).
 */
const NARRATIVE_ASPECT = /(?:完了|好了|过了)|(?:已经|已|刚刚|刚才|此前|之前)[\p{Script=Han}]{0,4}(?:了|过)|\b(?:was|were|has been|have been)\b/iu
const NARRATIVE_DIRECTIVE = /请|需要你|帮我|麻烦|务必|\b(?:please|must)\b/i

const UNRESOLVED_SCOPE = /^(?:看看|看一下|瞅瞅|研究一下|了解|随便|maybe|perhaps|somehow|figure\s+out)/i

/**
 * POSITIVE statement evidence (0.6.1 review): a clause with no resolvable
 * action reads as a statement only when one of these structural markers is
 * present — a passive (被/受到/遭到), a negator or progress marker
 * ("不要"/"没有"/"尚未"/"还没"/"从未"), or an English declarative shape
 * (finite aux/copula, or an article/possessive-led subject, which an
 * imperative can never start with). Everything else defaults to `unresolved`:
 * an unknown request ("Please sanitize these inputs", "处理这个问题") must
 * never degrade to information, where the turn's answer would auto-close it —
 * and no vocabulary can be complete, so the default never consults one.
 */



/**
 * A completed confirmation receipt: the root reports that the event it was
 * waiting for already happened. It reserves nothing, so it must not mint a
 * wait, and it is not work either.
 */
const CONFIRMATION_RECEIPT = /^(?:我)?\s*(?:已|已经)?\s*(?:收到|得到|等到|等待)(?:了|过)?\s*(?:我|你|您|用户)?\s*的?\s*.{0,12}?(?:确认|回复|回报|批准|同意|授权|指示|通知)\s*(?:了|啦|过|收到)\s*[。．.!！]?$/u

const SENTENCE_END = new Set(['。', '！', '？', '!', '?', '\n', '\r'])

/**
 * An abbreviation whose own final period MAY continue the sentence: "e.g.",
 * "i.e.", "cf.", "etc.", "vs.", "no.", "fig.", "approx.", the honorifics, and
 * any dotted initialism ("a.m."). English abbreviations are a CLOSED class, so
 * this is a protection list rather than a list of the words that may start a
 * sentence — which is what the earlier repair got wrong: it decided the boundary
 * from the NEXT word, so a lower-case request preface ("Install the package.
 * please report what changed?") kept the run whole and the trailing question mark
 * swallowed the install (review 5 F1).
 */
const ABBREVIATION_BEFORE_PERIOD = /(?:^|[^A-Za-z])(?:e\.g|i\.e|c\.f|cf|etc|vs|no|fig|eq|approx|Mr|Mrs|Ms|Dr|St|Jr|Sr|[A-Za-z]\.[A-Za-z])\.$/i
/**
 * Text that CONTINUES a sentence rather than starting one: a lower-case word, a
 * digit, or a closing mark. This is the second half of the abbreviation rule —
 * an abbreviation's period also ends a sentence when what follows opens a new
 * one, and `etc.` at the end of a list is the ordinary case (review 6 F2).
 */
const CONTINUES_SENTENCE = /^[\p{Ll}\p{Nd}]/u
/**
 * A question opening. It is the tie-breaker for an abbreviation followed by a
 * lower-case word: "e.g. the log" continues the sentence, while "etc. what
 * changed?" starts a new one, because a question that follows an abbreviation
 * must not be delivered with the execution range before it (review 6 F2).
 */
const QUESTION_OPENER = /^(?:what|which|who|whom|whose|when|where|why|how|whether|is|are|was|were|do|does|did|can|could|should|would|will|has|have|had|什么|为什么|怎么|如何|是否|是不是|哪|谁|哪个|哪些)/iu

/**
 * Whether an ASCII full stop at `index` ends a sentence.
 *
 * The 0.6.3 K1 repair found that `。`, `！` and `？` split a run while `.` did
 * not, so "Install the package. What changed?" stayed ONE run, ended
 * interrogatively and was read as pure information — the order was dropped and
 * the record closed as answered. A period ends a sentence whenever whitespace
 * and further text follow it, WHATEVER that text looks like, so no word list can
 * widen the question's delivery range. Two things can keep the run whole: a
 * period with no space after it (a decimal, a version number, a file name), and a
 * period that belongs to an abbreviation AND is followed by a lower-case word,
 * a digit or a closing mark. An abbreviation followed by a capital, a CJK
 * character or an opening quote is a sentence end, because a boundary the
 * reading cannot resolve must never let the sentence's own question mark decide
 * an execution range it does not cover.
 */
function sentencePeriodEnd(text: string, index: number): boolean {
  if (text[index] !== '.') return false
  if (!/\s/u.test(text[index + 1] ?? '')) return false
  const rest = text.slice(index + 1).replace(/^\s+/u, '')
  if (!rest) return false
  if (!ABBREVIATION_BEFORE_PERIOD.test(text.slice(0, index + 1))) return true
  if (QUESTION_OPENER.test(rest)) return true
  return !CONTINUES_SENTENCE.test(rest)
}

// ---------------------------------------------------------------------------
// Scope splitting
// ---------------------------------------------------------------------------

interface SplitScope {
  text: string
  body: string
  directive: DirectiveClass
  condition?: string
  /** Offset of this scope inside the run it came from, when the run knows it. */
  start?: number
}

function isWordBoundary(text: string, index: number): boolean {
  if (index <= 0) return true
  return !/[\p{L}\p{N}_]/u.test(text[index - 1])
}

/**
 * The first negator in `text` at or after `from`.
 *
 * A multi-word English negator is matched at BOTH of its words ("do not"), so a
 * caller scanning for a negated verb does not have to know where the phrase
 * began. `index` 0 is always a boundary; later positions are boundaries only
 * when the preceding character is not a word character.
 */
function firstNegation(text: string, from = 0): { index: number; token: string } | undefined {
  for (let cursor = from; cursor < text.length; cursor += 1) {
    const token = negatorAt(text, cursor)
    if (token) return { index: cursor, token }
  }
  return undefined
}

/** Match a negator at exactly `index`, the longest alternative winning. */

function negatorAt(text: string, index: number): string | undefined {
  const lower = text.toLowerCase()
  const candidates = NEGATORS
    .filter(([token]) => lower.startsWith(token, index))
    .sort((a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0]))
  for (const [token] of candidates) {
    // A bare Chinese negator needs a contiguous run, so "在不" / "不足" are not bans.
    // A lone 不 inside a longer word is not a ban. 是不是/不是 after a topic and
    // before a verb ("主题是不是需要更新呢？") is a question marker, while a ban
    // is either opening its clause ("不要提交并推送") or joined to its verb
    // ("但不推送").
    // A-不-A is an interrogative, not a ban: 要不要/该不该/是不是/能不能/
    // 可不可以 ask a yes/no question, so the 不 is the question's own reduplication
    // (review 11). A real ban keeps 不 next to a DIFFERENT character ("不要安装",
    // "不应该安装"). The test is on the 不 inside whichever negator matched, because
    // 不要 is itself a negator token.
    const bu = token.indexOf('不')
    if (bu >= 0) {
      const at = index + bu
      if (text[at - 1] !== undefined && text[at - 1] === text[at + 1]) continue
    }
    if (token === '不' && /[\u3400-\u9fff]/.test(text[index + 1] ?? '')) {
      const isQuestionForm = text[index + 1] === '是' || text[index + 1] === '错'
      const opensClause = !/[\u3400-\u9fffA-Za-z0-9_]/.test(text[index - 1] ?? '')
      const joinedToAction = firstActionVerb(text, index + 1, index + 5) >= 0
      if (isQuestionForm && !opensClause && !joinedToAction) continue
    }
    if (token.length === 1 && /[\u3400-\u9fff]/.test(token)) {
      if (!/[\p{Script=Han}\p{L}\p{N}]/u.test(text[index + 1] ?? '')) continue
    }
    if (/^[a-z]/.test(token)) {
      // Both sides must be word boundaries, so nevermore.ts and never-more.ts
      // are file names, not bans on "never". A path separator inside a token
      // ("never/a.ts", "never@b.ts") is part of the name for the same reason:
      // a ban is followed by whitespace or punctuation, never by the rest of a
      // word with no separation.
      if (!isWordBoundary(text, index)) continue
      if (/[\p{L}\p{N}_-]/u.test(text[index + token.length] ?? '')) continue
      const after = text[index + token.length] ?? ''
      if (/[./@\\]/u.test(after) && !/\s/u.test(text[index + token.length + 1] ?? '')) continue
    }
    return token
  }
  return undefined
}

/**
 * Index of the first action verb at or after `offset`.
 *
 * A vocabulary entry that a multi-character action immediately continues is the
 * first character of that word rather than a verb of its own — the 升 of 升级,
 * the 然 of 然后 — so the longer action is chosen instead. Without that rule
 * "然后完成…" reads as two verbs and every condition analysis downstream anchors
 * on the wrong one.
 */
function firstActionVerb(text: string, offset = 0, before = text.length): number {
  const matches = actionVerbMatches(text, offset, before)
  return matches.length > 0 ? matches[0].index : -1
}

/**
 * Every action word in `[offset, before)`, ordered by position, with the words
 * that are only a prefix of a longer action removed (the 升 of 升级, the 然 of
 * 然后). The remaining candidates are the verbs an instruction can be about.
 */
export function actionVerbMatches(text: string, offset: number = 0, before: number = text.length): Array<{ index: number; length: number }> {
  // Callers need the EARLIEST action, so both vocabularies are searched with
  // exec() — O(pattern) — rather than materialising every match in the text.
  // The whole span is searched: a long message is still the root's instruction.
  const span = text.slice(offset, before)
  const earliest: Array<{ index: number; length: number }> = []
  for (const pattern of [ACTION_VERB, WORK_VERB]) {
    const match = pattern.exec(span)
    if (match && !(match[0].length === 1 && /[A-Za-z]/.test(match[0]))) {
      earliest.push({ index: offset + match.index, length: match[0].length })
    }
  }
  return earliest.sort((a, b) => a.index - b.index)
}

/**
 * True when a negator's scope covers the verb starting at `index`.
 *
 * The negator has to be phrase-initial, so the 不 of 手动 and the 无 of 无论 are
 * not read as bans; a contrast or list separator between the negator and the
 * verb ends its scope ("不仅…而且运行" keeps the run positive).
 */
export function verbIsNegated(text: string, index: number): boolean {
  const ceiling = Math.min(index, 12)
  for (let back = 1; back <= ceiling; back += 1) {
    const at = index - back
    const token = negatorAt(text, at)
    if (!token || at + token.length > index) continue
    if (at > 0 && /[\u3400-\u9fff]/.test(text[at - 1])) continue
    if (/[，,、；;。！!？?\n\r]/.test(text.slice(at + token.length, index))) continue
    return true
  }
  return false
}

/** True when an unnegated operation verb occurs inside `[from, to)`. */

function hasPositiveVerb(text: string, from: number, to: number): boolean {
  const index = firstActionVerb(text, from, to)
  if (index < 0) return false
  return !verbIsNegated(text, index)
}

/**
 * The verb a negator bans. A Chinese negator may put an adverb between itself
 * and its verb ("不正式发布"), so candidate verbs are walked in order and the
 * first one that is a real word rather than part of the preceding word wins.
 */
function bannedVerbIndex(text: string, afterNegator: number, before: number): number {
  const span = text.slice(afterNegator, before)
  for (const word of CJK_VERB_WORDS) {
    // Exact literal scanning: a CJK word needs no boundary assertion, and the
    // longest headword is tried first so 重新启动 is never read as 新.
    const at = span.indexOf(word)
    if (at < 0) continue
    return afterNegator + at
  }
  const candidates = actionVerbMatches(text, afterNegator, before)
  // An English negator may be a verb modifier rather than a prefix ("Don't
  // change the API", "do not push"), so the action it bans is read from either
  // side of the negator and the nearest one wins.
  for (const candidate of actionVerbMatches(text, 0, afterNegator)) candidates.push(candidate)
  if (candidates.length === 0) return -1
  return candidates
    .map((candidate) => candidate.index)
    .reduce((best, index) => Math.abs(index - afterNegator) < Math.abs(best - afterNegator) ? index : best)
}

/**
 * Whether a scope opens with a cross-clause marker. The action before such a
 * marker stays inside the same scope, so this only suppresses the sentence split.
 */
function opensWithPrefixMarker(text: string): boolean {
  return prefixConditionIndex(text.toLowerCase()) === 0
}

/**
 * A resumption condition: everything a scope says before the event that ends
 * the wait ("收到我的确认后再推送" waits for the confirmation, so the push is
 * not executable yet). Leading request words are not part of the condition, and
 * a marker separated from the scope start by more than a clause belongs to a
 * different statement.
 */
function resumptionConditionOf(scope: SplitScope): string | undefined {
  const text = scope.text
  // A condition the earlier suffix split already isolated stays authoritative:
  // "…；收到我的确认后再推送" keeps the wait the split found.
  if (scope.directive === 'conditional') return text.replace(/^(?:请在|请|麻烦|帮我|需要你|务必)\s*/u, '').trim() || undefined
  return leadingResumptionCondition(text, firstActionVerb(maskCodeSpans(text)) >= 0)
}

function leadingResumptionCondition(text: string, hasAction: boolean): string | undefined {
  const masked = maskCodeSpans(text)
  const marker = RESUME_SCOPE_MARKER.exec(masked)
  if (!marker) return undefined
  const rest = masked.slice(marker[0].length).replace(/^[\s，,、：:]+/u, '').replace(/^(?:再|才|就|则|即)\s*/u, '').trim()
  // The marker has to guard an action stated after it: a message that only
  // reports the event ("收到我的确认了") reserves nothing, and an action in a
  // later sentence is not governed by this wait.
  const guarded = rest.replace(/[。．.!！?？]+$/u, '')
  if (guarded && /[；;。]/u.test(guarded)) return undefined
  // A scope that names no action reserves nothing ("收到我的确认了" is a report).
  if (!hasAction) return undefined
  const condition = marker[0].replace(/^(?:请在|请|麻烦|帮我|需要你|务必)\s*/u, '').trim()
  return condition || undefined
}

/** End index of the negated span beginning at `start`. */
function negatedSpanEnd(text: string, start: number): number {
  for (let cursor = start + 1; cursor < text.length; cursor += 1) {
    const character = text[cursor]
    if (character === '\n' || character === '\r') return cursor
    if (character === '。' || character === '！' || character === '？' || character === '!' || character === '?') return cursor
    // An ASCII period ends a sentence only when whitespace or the end follows,
    // so a dotted file name inside a ban is not a boundary.
    if (character === '.' && (cursor + 1 >= text.length || /\s/.test(text[cursor + 1]))) return cursor
    if (character === '但' && text[cursor + 1] !== '是') return cursor
    if (character === '而' && text[cursor + 1] === '是') return cursor
    if (character === '；' || character === ';') return cursor
    // A second negator opens its own ban: "不推送、不发布" is two constraints,
    // and each keeps its own action.
    if (negatorAt(text, cursor)) return cursor
    if (!SEPARATORS.has(character)) continue
    const rest = text.slice(cursor + 1)
    // A coordinating conjunction continues the ban ("，也不要发布"); anything
    // else after the separator — a positive verb, or the reason the ban exists —
    // ends this ban and is captured in its own right.
    if (CONTINUATION_AFTER_SEPARATOR.test(rest)) continue
    if (character === '，' || character === ',' || character === '、') return cursor + 1
    if (hasPositiveVerb(text, cursor + 1, text.length)) return cursor
  }
  return text.length
}

/**
 * Whether a run that follows a negator names an action directly ("推送、不
 * 发布" → true, "任何改动" → false). Only the guard's own action surface counts:
 * consultative verbs such as 完成 are deliberately absent, so "尚未完成" stays a
 * statement instead of becoming a ban.
 */
function namesActionSpan(text: string): boolean {
  // Chinese text rarely separates clauses with a space, so the leading
  // punctuation is stripped before the action word is read.
  const match = /^[^\p{Script=Han}A-Za-z]*([\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9_-]*)/u.exec(text)
  if (!match) return false
  const head = match[1]
  for (const entry of COMMAND_SURFACE_MANIFEST.operationVerbs) {
    const pattern = new RegExp(`^(?:${entry.pattern})$`, 'i')
    if (pattern.test(head)) return true
  }
  return false
}

/**
 * Split one message into scopes, in source order.
 *
 * The working list holds `[text, offset]` runs of the original message. A run is
 * resolved into one scope as soon as a rule matches; otherwise the runner splits
 * it into a head and a tail and pushes the tail back, so the split is iterative
 * and no run is ever re-read out of order.
 *
 * A negation opens a scope covering every action it governs — the scope ends at
 * a new positive verb, at a contrast, or (for a coordinated ban such as
 * "不推送、不发布") at the end of the run. A separator that is *followed by a
 * coordinating conjunction* also ends the current scope: "修复代码，但不推送"
 * is a task plus a ban, while "更新皮肤中心并在本地仓库记录" stays one
 * coordinated scope until the conjunction itself.
 */
function scopeOf(raw: string, options: InterpretOptions = {}): SplitScope[] {
  const source = raw.trim()
  if (!source) return []

  interface Run { text: string; offset: number; inherited?: string }
  const pending: Run[] = [{ text: source, offset: 0 }]
  const resolved: Array<{ scope: SplitScope; offset: number }> = []
  const emitted = new Set<string>()
  // One working item can be reached twice when a ban's span and the pending
  // tail overlap, so the same statement is recorded once.
  const push = (entry: { scope: SplitScope; offset: number }): void => {
    const key = `${entry.offset}\u0000${entry.scope.directive}\u0000${entry.scope.text}`
    if (emitted.has(key)) return
    emitted.add(key)
    resolved.push(entry)
  }

  while (pending.length > 0) {
    const run = pending.pop()!
    const text = run.text.trim()
    if (!text) continue
    const inheritedCondition = run.inherited
    const offset = run.offset + run.text.indexOf(text)
    const masked = maskCodeSpans(text)
    const conditionPrefix = prefixConditionIndex(masked.toLowerCase())
    const negation = firstNegation(masked)
    // The action a condition guards. When the operation vocabulary does not
    // carry the verb ("…才推送"), a closed action vocabulary supplies it.
    // The action a condition guards may sit before the marker inside its own
    // clause ("Run the tests; push only after I confirm"): the search starts at
    // the clause boundary, not at the marker.
    const conditionClauseStart = conditionPrefix !== undefined ? lastBoundaryIndex(text, conditionPrefix) : 0
    let earliestVerb = firstActionVerb(masked, conditionClauseStart)
    if (earliestVerb < 0 && conditionPrefix !== undefined) {
      const tail = expressionTailVerb(masked, conditionPrefix)
      if (tail > conditionPrefix) earliestVerb = tail
    }
    // A negation bans an action when the action FOLLOWS it inside the same run,
    // or when it introduces a named action span ("不推送、不发布"). Prose such as
    // "no changes were made" names no action and stays a statement, and a file
    // name that merely starts with a negator ("nevermore.ts") is never a ban.
    const negationIndex = negation ? negation.index : -1
    // The verb a ban governs is read from the whole ban, so a marker separated
    // from its verb by a long object list is still found.
    const banScanEnd = masked.length
    const bannedVerb = negation
      ? bannedVerbIndex(masked, negationIndex + negation.token.length, banScanEnd)
      : -1
    const negationBansAction = negation !== undefined
      && (bannedVerb >= 0 || namesActionSpan(masked.slice(negationIndex + negation.token.length, banScanEnd)))
    // "Never: push changes." — the negator only opens a section label, so the
    // text between it and the action carries no ban content of its own.
    const negationIsBareLabel = negation !== undefined && bannedVerb >= 0
      && /^[\s:：,，、]*$/u.test(masked.slice(negationIndex + negation.token.length, bannedVerb))
    const earliestNegation = negationBansAction ? negationIndex : -1
    const earliestNegationToken = negationBansAction ? negation!.token : ''

    // A conditional action is not immediately executable. A ban is a constraint
    // either way, so a conditional ban is resolved by the negation branch below,
    // which keeps the condition the marker supplies.
    // A locative "在…记录" is where the work happens, not a condition, so it
    // never opens a conditional scope.
    const locativePrefix = conditionPrefix !== undefined && text[conditionPrefix] === '在'
      && /^在.{1,24}?(?:记录|保存|写入|提交|运行|执行|测试|检查|验证|完成)/u.test(text.slice(conditionPrefix, earliestVerb))
    // "Check if …" is an investigation whose interrogative object happens to be
  // spelled `if`; the condition splitter would otherwise cut it into a bare
  // order plus a condition. The counterpart control is "Install the package if
  // available", whose head is NOT an interrogation verb, so it keeps its
  // conditional reading.
  // "When should I install …?" is a QUESTION whose interrogative happens to be
  // spelled `when`, and the condition splitter would otherwise cut it into a bare
  // order plus a condition. Only a clause that asks this way is exempt: "When the
  // tests pass, install the package." keeps its conditional reading (review 10).
  const temporalQuestion = conditionPrefix !== undefined && isTemporalQuestion(masked)
  // An investigation whose complement is OPEN ("Determine if we can install foo and
  // restart service api safely.") asks about its actions: the `if` belongs to the
  // complement, so it is not a condition on a separate instruction (review 11).
  const openInvestigationComplement = conditionPrefix !== undefined && clauseIsGoverned(masked)
  if (conditionPrefix !== undefined && earliestNegation < 0 && !locativePrefix && !temporalQuestion && !openInvestigationComplement && !investigationHeadTakesIf(masked) && conditionMarkerIsClauseLevel(masked, conditionPrefix)) {
    const conditional = conditionSplit(text, conditionPrefix, earliestVerb, options)
      if (conditional) {
        for (const scope of conditional) push({ scope, offset: offset + (scope.start ?? 0) })
        continue
      }
    }

    if (earliestNegation >= 0) {
      const head = text.slice(0, earliestNegation).trim()
      const end = negatedSpanEnd(masked, earliestNegation)
      // A ban always states its own negator, so the verb it governs is read
      // from the ban's own words rather than from the surrounding sentence.
      const banText = text.slice(earliestNegation, end).trim()
      const tail = text.slice(end).replace(/^[\s。．.!！?？,，;；、]+/, '').trim()
      if (tail) pending.push({ text: tail, offset: offset + end, ...(inheritedCondition ? { inherited: inheritedCondition } : {}) })
      if (banText) {
        // A condition that precedes the ban governs it ("除非…否则不要合并"),
        // and once resolved it governs every action the ban coordinates.
        const clauseStart = conditionPrefix !== undefined && conditionPrefix < earliestNegation
          ? lastBoundaryIndex(text, conditionPrefix)
          : -1
        const conditionText = inheritedCondition
          ?? (clauseStart >= 0 ? stripConditionConnector(text.slice(clauseStart, earliestNegation)) : '')
        push({ offset, scope: {
          text: banText,
          body: stripNegators(banText, earliestNegationToken) || banText,
          directive: 'prohibition',
          ...(conditionText ? { condition: conditionText } : {}),
        } })
        // The condition arm the ban already absorbed ("除非我明确说可以，否则")
        // is not an instruction of its own: when the head before the negator
        // carries no action verb beyond the consumed condition, it is not
        // re-pushed. Re-reading it as a duty (0.5.1) manufactured a phantom
        // obligation out of pure condition text.
        if (head && (clauseStart < 0 || firstActionVerb(maskCodeSpans(head)) >= 0)) {
          pending.push({ text: head, offset })
        }
      } else if (head) {
        pending.push({ text: head, offset })
      }
      continue
    }

    const end = positiveScopeEnd(masked, options)
    const head = text.slice(0, end).trim()
    const tail = text.slice(end).trim()
    if (tail) pending.push({ text: tail, offset: offset + end })
    if (head) {
      // A condition marker that guards the clause is inherited by the scope; a
      // marker sitting inside a purpose or relative span is not a condition at
      // all ("Create /tmp/check.sh to determine if the service is running" — the
      // creation is unconditional, review 4).
      const inherited = conditionPrefix !== undefined && conditionPrefix < head.length
        && conditionMarkerIsClauseLevel(masked, conditionPrefix)
        ? text.slice(conditionPrefix, head.length).replace(/^[\s，,、；;：:]+/, '').trim()
        : ''
      push({
        offset,
        scope: {
          text: head,
          body: stripConnectors(head),
          directive: classifyPositive(head),
          ...(inherited ? { condition: inherited } : {}),
        },
      })
    }
  }

  // One working item can be reached twice when a ban's span and the pending
  // tail overlap, so identical scopes at the same offset are stated once.
  const seen = new Set<string>()
  const ordered = resolved
    .sort((a, b) => a.offset - b.offset)
    .filter((entry) => {
      const key = `${entry.offset}\u0000${entry.scope.directive}\u0000${entry.scope.text}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  // A scope with no action-bearing text states nothing: neither pure
  // punctuation nor a conflict marker that only closed a previous ban.
  const surviving = ordered
    .map((entry) => entry.scope)
    .filter((scope) => /[\p{L}\p{N}]/u.test(scope.body) && /[\p{L}\p{N}]/u.test(scope.text))
  // 0.6.3 K1: an informational reading must cover a COMPLETE, execution-free
  // information range. A clause that also orders work is partitioned again so
  // the execution obligations survive beside the question.
  return surviving.flatMap((scope) => {
    // A question whose own object IS a coordinated list of actions governs that
    // whole list: "Explain how to install foo and restart service api." asks
    // about installing and restarting, so neither verb is authority (review 7
    // F1). The same holds for the Chinese spelling (如何安装并重启服务). This has
    // to be decided BEFORE partitioning, because partitioning is exactly what
    // promoted the second verb of the question's object into an instruction.
    // An explanation's sentence is decided as ONE scope, before any partition:
    // its coordinated parts are either the question's own complement (a pure
    // question keeps the closable lane) or an action residue that may equally be
    // what the root asked to have explained (so the clause stays undecided and
    // nothing in it is authority). Partitioning here is exactly what promoted the
    // second verb of "Explain how to install foo and restart service api." into an
    // instruction (review 9).
    // A governed clause is decided as ONE obligation, BEFORE any partition: its
    // coordinated parts are inside the governed scope, so partitioning here is
    // exactly what invented an executable child out of a question's own content
    // (the fail-open this contract removes). A separate clause in the same run is
    // unaffected: it is its own delimiter-bounded piece, qualifies itself, and
    // keeps its own reading.
    if ((isSingleClause(scope.text) && clauseIsProtected(scope.text))
      || opensWithGovernedHead(scope.text)) return [scope]
    // 0.6.3 K1: an informational reading must cover a COMPLETE,
    // execution-free information range. A clause that also orders work is
    // partitioned again ("更新插件，检查是否存在更新，安装新主题，记录变
    // 更。"), so the execution obligations survive beside the question while
    // the answering turn closes only its own information range. A directive
    // reading is never partitioned: a coordinated instruction keeps the single
    // obligation 0.6.2 recorded for it, with its per-action plan.
    // A clause that MIXES an answerable information range with work is two
    // obligations whatever the clause's own majority reading was: 0.6.2 read
    // the whole run as information when the question came first and as a
    // directive when it came last, and both readings swallowed the other side.
    const parts = splitTextFragments(scope.text)
    if (parts.length > 1) {
      const partitioned = partitionClauseParts(scope, parts)

      if (partitioned) {
        return partitioned.flatMap((part) => {
          if (!part.informational) return [directiveScopeOf(part.text, maskCodeSpans(part.text), part.offset)]
          const information = informationScopeOf(scope, part)
          // An information span that still carries a boundary of its own (a
          // connector, a comma) is reduced once more, so the recorded
          // information text is only the asking part.
          return refineInformationalScope(information, maskCodeSpans(information.text)) ?? [information]
        })
      }
    }
    if (scope.directive !== 'informational') return [scope]
    return refineInformationalScope(scope, maskCodeSpans(scope.text)) ?? [scope]
  })
}

/** The scope a partition records its information span with. */
function informationScopeOf(scope: SplitScope, part: ClausePart): SplitScope {
  return {
    text: part.text,
    body: stripConnectors(part.text),
    directive: 'informational',
    ...(scope.condition ? { condition: scope.condition } : {}),
    start: part.offset,
  }
}

/**
 * Whether a text run already states a complete instruction: it carries an
 * action verb together with something to act on. "更新皮肤中心" is complete;
 * "更新" alone, or a bare object list, is not.
 */
function hasCompleteClause(text: string): boolean {
  const index = firstActionVerb(text)
  if (index < 0) return false
  const verb = actionVerbMatches(text)[0]
  const before = text.slice(0, index).trim()
  const after = text.slice(index + (verb?.length ?? 1)).replace(/^[\s，,、]+/, '').trim()
  return after.length > 0 || before.length > 0
}

function positiveScopeEnd(masked: string, options: InterpretOptions = {}): number {
  // The separator scan reads the whole message: a prohibition or condition
  // written after a long object list is still the root's instruction.
  const limit = masked.length
  let cursor = 0
  // A scanned remainder begins with the mark that opened it, because a mark
  // that splits the run belongs to the clause it introduces. Consuming it here
  // is what keeps that ownership from turning into a zero-length clause: the
  // mark is part of this clause's text, never a boundary at this offset.
  while (cursor < limit && (masked[cursor] === '，' || masked[cursor] === ',' || masked[cursor] === '、'
    || masked[cursor] === '并' || masked[cursor] === '且' || /\s/u.test(masked[cursor]!))) cursor += 1
  while (cursor < limit) {
    const character = masked.slice(cursor, cursor + 1)
    if (SENTENCE_END.has(character) || character === '；' || character === ';'
      || (character === '.' && sentencePeriodEnd(masked, cursor))) {
      // A quote (or a code span) owns its own punctuation: a sentence mark inside
      // it never opens a clause of the parent scope, so the parent's qualification
      // reaches the whole span.
      if (insideQuote(masked, cursor)) {
        cursor += 1
        continue
      }
      return cursor + 1
    }
    // A clause that OPENS with a governed head governs its whole sentence: the
    // question/explanation the root wrote covers everything coordinated inside it,
    // commas included ("Explain how to install foo, then restart service api."
    // stays one explanation). A governed head that opens a LATER clause governs
    // only that clause, so the work before it keeps its own reading (0.6.3 K1).
    if (opensWithGovernedHead(masked)) {
      cursor += 1
      continue
    }
    // A question head GOVERNS its clause: no separator opens a clause inside it,
    // in any question form and in either language ("Explain how you install foo
    // and restart service api.", "如何安装 foo 并重启 api 服务？",
    // "How do I install foo and restart service api safely?"). Splitting here is
    // exactly what produced an executable child that lost its parent's question
    // scope (review 10). An explanation whose complement is complete before the
    // coordinator ("说明 `git push origin main` 的作用，然后更新 README") keeps
    // its next clause, and a sentence end always does.
    // A governed clause is INDIVISIBLE at coordinators inside its own clause: the
    // question/explanation/investigation head governs its clause, so a coordinated
    // part is inside the governed scope and no separator may open an executable
    // child of it. The clause here is the comma/delimiter-bounded piece the cursor
    // sits in, so a question in a LATER clause never swallows an earlier order.
    if (isCoordinatorMark(character) && clauseIsProtected(clauseAround(masked, cursor))) {
      cursor += 1
      continue
    }
    // A comma, an enumeration mark, or a coordinating conjunction begins a
    // coordinated instruction: its own action is its own clause.
    const listSeparator = character === '，' || character === ',' || character === '、'
      || character === '并' || character === '且'
    if (!listSeparator) {
      cursor += 1
      continue
    }
    const rest = masked.slice(cursor + 1)
    // A coordinating conjunction begins a coordinated instruction: its own
    // action is its own clause, which keeps item granularity stable.
    if (options.coordinationSplit === false) {
      cursor += 1
      continue
    }
    // A subordinate clause introduced after the separator belongs to the same
    // instruction ("持续推进，直到…为止" is one demand, not two).
    if (/^\s*(?:直到|直至|一直到)\s*/u.test(rest)) { cursor += 1; continue }
    // ONE rule decides whether the text after the separator is its own clause:
    // it needs an action of its own, or a contrast. A separator that only
    // continues an object list keeps the clause whole, and the executor marker
    // is checked separately below because it carries its own obligation.
    if (CONTINUATION_AFTER_SEPARATOR.test(rest)) return cursor + 1
    // A prepositional actor after the separator is its own clause: "由你升级 A，
    // 由我重启 B" names two executees, and each keeps its own obligation. The
    // executor is part of the clause head, so it is checked before the
    // object-list test rather than after it.
    if (/^\s*(?:由|让|请|给)\s*(?:你|您|我|本人)/u.test(rest)) return cursor + 1
    const clauseHead = CROSS_CLAUSE_HEAD.test(rest)
    const locative = LOCATIVE_CLAUSE.test(rest)
    const conjunctionSeparator = character === '并' || character === '且'
    // A bare comma joins the parts of one instruction ("安装插件，重启 DSH" is
    // one request), so it separates only when a coordinating conjunction follows
    // it. An enumeration mark or a conjunction opens its own clause whenever an
    // action or a contrast follows.
    const comma = character === '，' || character === ','
    const enumeration = character === '、'
    // A separator that opens a new clause OPENS it: the mark is the join
    // between two instructions, so it travels with the clause it introduces
    // instead of trailing the one before it. Leaving it behind produced
    // obligations whose text ended in a bare mark ("更新皮肤中心、",
    // "更新插件并") — a truncated instruction that no longer names what it
    // asks for, and that a later rebind re-partitions into an empty clause.
    // Every character still belongs to exactly one clause, so the message text
    // is preserved in full.
    if (comma) {
      // A bare comma joins the parts of one instruction ("安装插件，重启 DSH"
      // is one request), so it separates only before a coordinating conjunction.
      if (!(conjunctionSeparator || CONTINUATION_AFTER_SEPARATOR.test(rest))) {
        cursor += 1
        continue
      }
      return cursor
    }
    if (enumeration) {
      // An enumeration mark names a second object of the same action, so it
      // separates only before a place clause ("、在本地仓库记录").
      if (!locative) {
        cursor += 1
        continue
      }
      return cursor
    }
    // A conjunction joins two parts of one action ("运行回归脚本并确认全部
    // 通过") unless the text after it names its own distinct instruction
    // ("并检查 GUI 效果").
    if (!(DISTINCT_CLAUSE_HEAD.test(rest) || locative)) {
      cursor += 1
      continue
    }
    return cursor
  }
  return masked.length
}

function conditionSplit(text: string, conditionPrefix: number | undefined, verb: number, options: InterpretOptions = {}): SplitScope[] | undefined {
  const masked = maskCodeSpans(text)
  const lower = masked.toLowerCase()
  // A condition marker fixes the polarity of the scope it guards: everything
  // under "除非…" stays conditional even when its action carries a negation.
  if (conditionPrefix === undefined) return suffixConditionSplit(text, lower, masked, options)
  if (verb < 0) return undefined

  const candidates = conditionCandidates(text, lower, masked, conditionPrefix)
  if (candidates.length === 0) return undefined
  const guardedScope = candidates[0]
  const markerIndex = guardedScope.start ?? 0
  const guardedStart = guardedScope.start ?? 0
  const condition = guardedScope.condition ?? ''
  if (!condition.trim() || !guardedScope.text.trim()) return undefined

  // The condition is part of the guarded scope's record, never work of its own.
  // A preceding instruction in the same run and a leading condition clause stay
  // visible as their own recorded text.
  const scopes: SplitScope[] = []
  const clauseStart = lastBoundaryIndex(text, markerIndex)
  const lead = text.slice(0, clauseStart).trim()
  if (lead) scopes.push(...scopeOf(lead, options))
  const conditionClause = text.slice(clauseStart, guardedStart).trim()
  if (conditionClause) {
    scopes.push({
      text: conditionClause,
      body: conditionClause,
      directive: 'conditional',
      condition: condition.trim(),
      start: clauseStart,
    })
  }
  scopes.push({
    text: guardedScope.text.trim(),
    body: guardedScope.text.replace(/^[\s，,、；;：:]+/, '').replace(/^(?:才|再|就|则|即)\s*/, '').trim(),
    directive: 'directive',
    condition: condition.trim(),
    start: guardedStart,
  })
  return scopes
}

/** Index just past the last clause separator at or before `index`. */
function lastBoundaryIndex(text: string, index: number): number {
  let cursor = index
  while (cursor > 0) {
    const character = text[cursor - 1]
    if (character === '在') break
    if (character === '；' || character === ';' || character === '。' || character === '！' || character === '？'
      || character === '!' || character === '?' || character === '\n' || character === '\r') return cursor
    cursor -= 1
  }
  return 0
}

/**
 * A trailing condition marker ("…才…") needs no prefix marker when it sits
 * directly before the action it guards: "收到我的明确回报后再继续".
 */
function suffixConditionSplit(text: string, lower: string, masked: string, options: InterpretOptions = {}): SplitScope[] | undefined {
  const verb = firstActionVerb(masked)
  if (verb < 0) return undefined
  // Only an explicit resumption marker opens a condition ("…后再继续",
  // "确认才推送"). A bare adverb inside a locative ("在本地仓库记录") says when
  // the work happens, so it never invents a condition.
  const marker = /(?:之后|以后|后再|后才|再继续|才继续|再|才)/u.exec(text.slice(verb))
  if (!marker) return undefined
  const condition = trimConditionTail(text.slice(0, verb + marker.index))
  const guarded = text.slice(verb + marker[0].length)
  if (!condition || !guarded.trim()) return undefined
  void options
  return [
    { text: condition, body: condition, directive: 'conditional', condition },
    {
      text: guarded.trim(),
      body: guarded.replace(/^[\s，,、；;：:]+/, '').replace(/^(?:才|再|就|则|即)\s*/, '').trim(),
      directive: 'directive',
      condition,
      start: verb + marker[0].length,
    },
  ]
}

/**
 * The condition clauses inside one clause run, each paired with the action it
 * guards. A marker that appears after the action's own verb but allows nothing
 * before that verb is not a condition at all — "confirm" contains "if", and
 * "We ship after the test passes" carries a subject the marker does not guard.
 */
function conditionCandidates(text: string, lower: string, masked: string, conditionPrefix: number): SplitScope[] {
  const clauseStart = lastBoundaryIndex(text, conditionPrefix)
  const clause = lower.slice(clauseStart)
  interface Candidate { markerAt: number; condition: string; guarded: string; guardedAt: number }
  const candidates: Candidate[] = []
  for (const [token, kind] of CONDITION_MARKERS) {
    if (kind !== 'prefix' || token === '在') continue
    const index = prefixIndexOf(clause, token)
    if (index < 0) continue
    const absolute = clauseStart + index
    // A negated action is a ban, not a conditional duty: "并且不要 publish" is
    // resolved by the negation branch, the only place a prohibition is recorded.
    if (firstNegation(masked.slice(absolute))) continue
    // Look for an action after the marker, falling back to the locally guarded
    // word when the action only exists as a bare verb ("…才推送").
    let after = firstActionVerb(masked, absolute + token.length)
    if (after < 0) {
      const tail = expressionTailVerb(masked, absolute + token.length)
      if (tail >= absolute + token.length) after = tail
    }
    const before = firstActionVerb(masked, clauseStart, absolute)
    // A marker that stands immediately before an action guards that action
    // ("…才推送"): the condition is everything the marker follows.
    if (after >= 0 && masked.slice(absolute + token.length, after).trim().length === 0) {
      candidates.push({
        markerAt: absolute,
        condition: trimConditionTail(text.slice(clauseStart, absolute)),
        guarded: text.slice(after),
        guardedAt: after,
      })
      continue
    }
    if (after < 0) {
      // No action follows the marker: the clause's own verb is guarded when
      // everything before the marker is that verb plus modifiers.
      if (before < 0 || !/^(?:[\p{L}\p{N}]+[\s]*){0,3}[\p{L}\p{N}]+$/u.test(text.slice(clauseStart, absolute).trim())) continue
      candidates.push({
        markerAt: absolute,
        condition: trimConditionTail(text.slice(absolute + token.length)),
        guarded: text.slice(clauseStart, absolute).trim(),
        guardedAt: clauseStart,
      })
      continue
    }
    // A marker that follows the guarded verb is a condition only when it
    // carries additional content the verb does not ("push only after I
    // confirm"); a marker inside a word or after a full subject is not.
    if (absolute >= before && before >= 0) continue
    candidates.push({
      markerAt: absolute,
      condition: trimConditionTail(text.slice(absolute + token.length, after)),
      guarded: text.slice(after),
      guardedAt: after,
    })
  }
  if (candidates.length === 0) return []
  const best = candidates.reduce((left, right) => right.markerAt < left.markerAt ? right : left)
  const guarded: SplitScope = {
    text: best.guarded.trim(),
    body: best.guarded.replace(/^[\s，,、；;：:]+/, '').replace(/^(?:才|再|就|则|即)\s*/, '').trim(),
    directive: 'directive',
    condition: best.condition,
    start: best.guardedAt,
  }
  // A leading condition that already reads as its own clause ("若我之后确认")
  // becomes a visible condition scope; a trailing one ("push only after I
  // confirm") stays the guarded scope's condition only, so the two never drift.
  return best.markerAt > 0 ? [guarded] : [guarded]
}

/**
 * The condition a marker supplies: everything between the clause start and the
 * guarded action, without the connector that introduces the ban ("除非…否则不要
 * 合并" → "除非我明确说可以").
 */
function stripConditionConnector(value: string): string {
  return value
    .replace(/^[\s，,、；;：:]+/, '')
    .replace(/[\s，,、；;：:]*(?:否则|不然|then|otherwise)[\s，,、；;：]*$/i, '')
    .trim()
}

/** Drop the temporal tail a condition marker may leave behind ("之后", "以后"). */
function trimConditionTail(value: string): string {
  return value.replace(/[\s，,、；;：:]+$/, '').replace(/(?:之后|以后|后)$/, '').trim()
}

/**
 * Whether a genuine prefix condition appears before the guarded action. The
 * locative "在" is excluded: "在本地仓库记录" is a place, not a condition.
 */
function hasPrefixCondition(text: string, verb: number): boolean {
  return CONDITION_MARKERS.some(([token, kind]) => kind === 'prefix' && token !== '在'
    && prefixIndexOf(text, token) >= 0 && prefixIndexOf(text, token) < verb)
}

/**
 * True when only the guarded verb and its modifiers stand between the start of
 * the scope and a prefix marker — the shape of "push only after I confirm",
 * where the marker follows the verb but still governs it. "We ship after the
 * test passes" has a subject before the marker and keeps its narrative reading.
 */
function isVerbModifierHead(text: string, markerIndex: number, verb: number): boolean {
  if (verb < 0 || markerIndex <= verb) return false
  const lead = text.slice(0, markerIndex)
  // `verb` indexes the original text; leading whitespace makes the two offsets
  // differ, so the verb's own position is measured after the trim.
  const offset = lead.length - lead.trimStart().length
  return /^(?:又|再|就|则|才|然后|接着|同时|and|then|also|only|just)?\s*$/i.test(lead.slice(offset + verb).trim())
}

/**
 * A known action word at the end of the clause, used when the guarded action is
 * expressed as a plain Chinese verb: "若…才推送" ends in 推送, which the action
 * surface does not treat as a verb because it is the object of 才. Only a closed
 * vocabulary is accepted, so ordinary prose is never mistaken for an action.
 */
const BOUND_ACTION_TAIL = /(创建|生成|写入|修改|编辑|运行|执行|编写|撰写|部署|安装|升级|提交|下载|上传|拉取|同步|重启|测试|检查|验证|确认|修复|更新|清理|整理|记录|构建|编译|重构|迁移|删除|回滚|发布|推送|实现|合并|提交|回退|检查)[。．.!！?？,，;；、\s]*$/u

function expressionTailVerb(masked: string, from: number): number {
  const slice = masked.slice(from)
  const match = BOUND_ACTION_TAIL.exec(slice)
  return match ? from + match.index : -1
}

/** Index of the first prefix condition marker, skipping a locative 在. */
function prefixConditionIndex(lower: string): number | undefined {
  const head = lower
  let best: number | undefined
  for (const [token, kind] of CONDITION_MARKERS) {
    if (kind !== 'prefix' || token === '在') continue
    const index = prefixIndexOf(head, token)
    if (index < 0) continue
    if (best === undefined || index < best) best = index
  }
  return best
}

/**
 * Word-bounded matcher per English marker, compiled once. Building the pattern
 * inside the scan recompiled it for every marker of every scope, which
 * dominated capture cost on long messages.
 */
const ENGLISH_MARKER_MATCHERS = new Map<string, RegExp>()
function englishMarkerMatcher(token: string): RegExp {
  let matcher = ENGLISH_MARKER_MATCHERS.get(token)
  if (!matcher) {
    matcher = new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escapeRegExp(token)}(?![\\p{L}\\p{N}_])`, 'iu')
    ENGLISH_MARKER_MATCHERS.set(token, matcher)
  }
  return matcher
}

function prefixIndexOf(text: string, token: string): number {
  if (/^[a-z]/.test(token)) {
    const match = englishMarkerMatcher(token).exec(text)
    return match ? match.index + (match[0].length - token.length) : -1
  }
  if (token === '在') {
    // "在做 X 之前/以前" only: a bare "在" is a locative, never a condition.
    const match = /在[^。！？；]{0,24}?(?:之前|以前)/.exec(text)
    return match ? match.index : -1
  }
  return text.indexOf(token)
}

/** A suffix marker ("才", "再") must follow the action it guards. */
function suffixIndexOf(text: string, token: string, verb: number): number {
  return text.indexOf(token, verb + 1)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stripNegators(text: string, matched: string): string {
  let value = text.trim()
  value = value.replace(new RegExp(`^${CONNECTOR_PATTERN}\\s*`, 'i'), '').trim()
  if (matched && value.toLowerCase().startsWith(matched.toLowerCase())) value = value.slice(matched.length)
  return stripNegatorsPrefix(value).trim()
}

function stripNegatorsPrefix(value: string): string {
  let text = value
  for (let guard = 0; guard < 8; guard += 1) {
    const trimmed = text.replace(/^[\s，,、；;：:]+/, '')
    let changed = trimmed !== text
    text = trimmed
    for (const [token] of NEGATORS) {
      if (!text.toLowerCase().startsWith(token.toLowerCase())) continue
      if (/^[a-z]/.test(token) && /[\p{L}\p{N}_]/u.test(text[token.length] ?? '')) continue
      text = text.slice(token.length)
      changed = true
      break
    }
    if (!changed) break
  }
  return text
}

function stripConnectors(text: string): string {
  return text.replace(new RegExp(`^${CONNECTOR_PATTERN}\\s*`, 'i'), '').trim()
}

/**
 * Whether a past/aspect marker is the clause's ENTIRE predicate: the span
 * extends to the end of the clause (only particles and punctuation may
 * follow), so no modifier ("…的"), attributive chain, or coordinated demand
 * can hide behind the report (0.6.1 review round 8: distance thresholds and
 * coordinator lists cannot enumerate modifiers).
 */
function mainClauseTailReport(masked: string): boolean {
  for (const pattern of [NARRATIVE_PAST, NARRATIVE_ASPECT]) {
    const match = pattern.exec(masked)
    if (!match) continue
    if (/^[^，。；！？\s]*的/u.test(masked.slice(match.index + match[0].length))) continue
    // Only completion particles and sentence punctuation may follow the
    // aspect span — anything else is unidentified content after the report.
    if (/^(?:了|过)?[。，；！？、\s.!?]*$/u.test(masked.slice(match.index + match[0].length))) return true
  }
  return false
}

function classifyPositive(text: string, preMasked?: string): DirectiveClass {
  const masked = preMasked ?? maskCodeSpans(text)
  // A question head GOVERNS its clause, so the clause is decided HERE, once, from
  // the head that produced it — not re-guessed per fragment after a split. When
  // the clause also carries an action of its own, the reading is UNDECIDED: the
  // action may be exactly what the question asks about, so it is neither
  // information nor an instruction (review 10). This is what carries the
  // question's non-execution qualification into every child the clause would
  // otherwise produce.
  if (governedClauseRestrictsExecution(masked)) return 'unresolved'
  // A governed clause that carries no work its question does not bound IS the
  // answerable lane: the reader decided the governance, so the clause is answered
  // rather than executed, whatever its head verb looks like in a work vocabulary.
  if (clauseIsGoverned(masked) && governedReadingOf(masked)?.marker !== undefined) return 'informational'
  // A protected scope whose question content the head reader could not classify is
  // undecided, not answerable: the action may be exactly what it asks about.
  if (clauseAsksOwnQuestion(masked)) return 'unresolved'
  const visibleVerb = firstActionVerb(masked)
  // A grammatically positive question is by construction a request for
  // information — the one surface shape that can never be an executed duty
  // (C03/S01). 0.6.3 K1 tightens what counts as one: the interrogative must
  // OPEN or END the clause, so an embedded 是否/relative clause inside an order
  // ("Create a file where logs are stored", "更新皮肤中心，看看为什么失败")
  // no longer turns the whole clause into an answerable question. Everything
  // else needs the positive grounds below or the structured interpretation
  // route.
  if (hasQuestionScope(masked)) return 'informational'
  // An action that exists only inside a code span is quoted data. A clause whose
  // only resolvable word is a QUOTED action has no live reading of its own — an
  // explanation of a quoted command is undecidable by surface rules — so it
  // stays `unresolved` instead of entering the answer lane, which 0.6.2 did for
  // "解释 `git push` 的作用" and then closed after any final answer.
  if (visibleVerb < 0) return 'unresolved'

  // 0.6.1 review round 8: the ONLY surface rule that can still grant the
  // closable information lane is a grammatically positive question — a
  // question is by construction a request for information. Explanation and
  // investigation openers ("Explain the issue", "Figure out the issue",
  // "看看…") cannot own the whole clause ("Explain the issue, sanitize all
  // inputs", "Figure out the issue & sanitize all inputs"), and past/aspect
  // markers count only when the report is the ENTIRE predicate — the aspect
  // span extends to the clause end, so nothing (a modifier "…的", an
  // attributive chain, a coordinated demand) can hide behind it
  // ("清理已经生成了的缓存" stays undecidable; "我刚才已经推送过了" is a
  // report). Everything else is UNDECIDABLE and stays `unresolved`; the
  // structured interpretation entry (`context_guard_interpret`) is the
  // verifiable route that records the request type against the full input
  // spans, after which the interpreting turn's answer closes it.
  // A past/aspect report as the clause's ENTIRE predicate positively
  // identifies a statement about what already happened — for verb-bearing
  // and verbless clauses alike. A completion receipt ("收到我的确认了") is
  // likewise a positive report of a past fact and outranks the completion
  // ambiguity below.
  // "Check if …" is an investigation whose interrogative object happens to be
  // spelled `if`; the condition splitter would otherwise cut it into a bare
  // order plus a condition. The counterpart control is "Install the package if
  // available", whose head is NOT an interrogative-taking verb, so it keeps its
  // conditional reading.
  // …but a clause that COORDINATES a second instruction keeps it: the
  // investigation reading covers only the asking part, so the clause is
  // partitioned and `Check if the lock file is current and install the package.`
  // keeps its install (review 11; the round-5 contract).
  if (interrogativeTakesIfObject(masked) && !explanationHasActionResidue(masked)) return 'informational'
  if (mainClauseTailReport(masked) && !NARRATIVE_DIRECTIVE.test(masked)) return 'narrative'
  if (CONFIRMATION_RECEIPT.test(masked.trim())) return 'narrative'
  if (visibleVerb < 0) {
    return 'unresolved'
  }
  // An explanation opener is an explanation ABOUT the action ("解释 git
  // push 的作用") — never the executable action itself, and never
  // auto-closable: an explanation clause may or may not chain a demand
  // ("Explain the issue, sanitize all inputs"), which no surface rule can
  // decide, so it stays unresolved and is closable only through the
  // structured interpretation route above.
  const explain = EXPLAIN_VERB.exec(masked)
  if (explain && (visibleVerb < 0 || visibleVerb >= explain.index)) return 'unresolved'
  // A CLAUSE-FINAL completion particle ("把配置更新了") is ambiguous
  // between a completed report and a completed imperative: undecidable, so
  // the clause can neither auto-close by delivery nor release a held
  // reservation. 通过/经过-style words ending in 过 do not count.
  if (/了[。，；！？、\s.!?]*$/u.test(masked)) return 'unresolved'
  return 'directive'
}

// ---------------------------------------------------------------------------
// // Executee and disposition
// ---------------------------------------------------------------------------

function executeeOf(text: string, directive: DirectiveClass): Executee {
  if (directive !== 'directive') return 'unresolved'
  const masked = maskCodeSpans(text)
  if (USER_ACTOR_PATTERNS.some((pattern) => pattern.test(masked))) return 'user'
  if (AGENT_ACTOR_PATTERNS.some((pattern) => pattern.test(masked))) return 'agent'
  return 'agent'
}

/** True when the scope asks for command/instruction TEXT rather than execution. */
function isOutputRequest(text: string): boolean {
  const masked = maskCodeSpans(text)
  return OUTPUT_NOUN.test(masked) && OUTPUT_REQUEST.test(masked)
}

function dispositionOf(scope: SplitScope, executee: Executee): AuthorityDisposition {
  if (scope.directive === 'prohibition') return 'prohibition'
  if (scope.directive === 'unresolved') return 'unresolved'
  if (scope.directive === 'informational' || scope.directive === 'narrative') return 'informational'
  // The condition clause itself orders nothing; it becomes visible as the
  // guarded action's `condition`, never as work of its own.
  if (scope.directive === 'conditional') return 'conditional_wait'
  if (scope.condition) return 'conditional_wait'
  if (executee === 'user') return 'human_actor'
  if (isOutputRequest(scope.text)) return 'informational'
  return 'executable_now'
}

function resumeEventOf(scope: SplitScope): string | undefined {
  // A quoted echo of a confirmation is DATA, not a reservation: the marker is read
  // from the clause with its quoted spans blanked.
  const match = RESUME_MARKER.exec(maskQuotedSpans(scope.condition ?? scope.text))
  return match ? match[0].trim() : undefined
}

function interpret(scope: SplitScope): ScopeInterpretation {
  const executee = executeeOf(scope.text, scope.directive)
  // A scope that waits on a root event is not executable yet, even when it is
  // phrased as an order: "请在收到我的确认后再推送代码" reserves the push.
  const resumption = scope.condition === undefined
    && (scope.directive === 'directive' || scope.directive === 'conditional')
    ? resumptionConditionOf(scope)
    : undefined
  const conditioned: SplitScope = resumption ? { ...scope, condition: resumption } : scope
  const qualification = qualificationOfClause(scope.text)
  const rawDisposition = dispositionOf(conditioned, executee)
  // The STORED qualification and the disposition may never disagree: a scope with
  // no positive evidence for an execution reading is undecided, not executable.
  // (A restricted scope that answers a question stays information, and a
  // prohibition, a wait or a human action keeps its own disposition.)
  const authorityDisposition: AuthorityDisposition = qualification.status === 'restricted' && rawDisposition === 'executable_now'
    ? 'unresolved'
    : rawDisposition
  const resumeEvent = scope.directive === 'directive' ? resumeEventOf(conditioned) : undefined
  const method = scope.directive === 'prohibition' ? undefined : semanticMethod(scope.body)
  return {
    text: scope.text,
    body: scope.body,
    directive: scope.directive,
    executee,
    ...(conditioned.condition ? { condition: conditioned.condition } : {}),
    ...(resumeEvent ? { resumeEvent } : {}),
    immediatelyExecutable: authorityDisposition === 'executable_now' && qualification.status === 'granted',
    authorityDisposition,
    qualification,
    ...(method ? { method } : {}),
    fingerprint: fingerprintOf([
      scope.text, scope.body, scope.directive, executee, authorityDisposition,
      qualification.status, qualification.reason,
      conditioned.condition ?? '', resumeEvent ?? '', method ?? '',
    ].join('\u0000')),
  }
}

function semanticMethod(text: string): string | undefined {
  const match = /(?:用|使用|通过|借助|利用|以)\s*([A-Za-z][A-Za-z0-9_-]*)/.exec(text)
    ?? /\b(?:via|using|use|with)\s+(?:the\s+)?([A-Za-z][A-Za-z0-9_-]*)/i.exec(text)
  return match ? match[1].toLowerCase() : undefined
}

/**
 * A short, stable identity for one interpretation: a content hash of the
 * interpretation itself, so a replay of identical bytes reproduces it exactly
 * and two different readings never collide.
 */
function fingerprintOf(source: string): string {
  // FNV-1a keeps this module dependency-free while staying a pure function.
  let hash = 0x811c9dc5
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `i${hash.toString(16).padStart(8, '0')}`
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Interpret one already-segmented clause. */
export function interpretClause(text: string, options: InterpretOptions = {}): ScopeInterpretation {
  const normalized = normalizeClause(text)
  const scopes = scopeOf(normalized, options)
  if (scopes.length === 0) {
    return interpret({ text: normalized, body: normalized, directive: 'informational' })
  }
  if (scopes.length === 1) return interpret(scopes[0])
  const directive: DirectiveClass = scopes.some((scope) => scope.directive === 'directive') ? 'directive'
    : scopes.some((scope) => scope.directive === 'prohibition') ? 'prohibition'
    : scopes.some((scope) => scope.directive === 'unresolved') ? 'unresolved' : 'informational'
  return interpret({ text: normalized, body: scopes.map((scope) => scope.body).join('；'), directive })
}

/** Interpret a whole message into independent scopes, in source order. */
export function interpretMessage(text: string, options: InterpretOptions = {}): ScopeInterpretation[] {
  return scopeOf(normalizeClause(text), options)
    .flatMap((scope) => splitTrailingResumption(scope))
    .map((scope) => interpret(scope))
}

/**
 * Whether the item is an executable obligation right now. A prohibition is a
 * standing constraint, a human-owned action belongs to the user, a conditional
 * action waits for its condition, and an explanation is not work. None of them
 * may block completion or be certified as agent work.
 *
 * An item without an interpretation is a legacy or fixture item created before
 * this module existed; it keeps its historical executable reading.
 */
export function isExecutableItem(item: {
  kind?: string
  executee?: Executee
  authorityDisposition?: AuthorityDisposition
  waitAuthorization?: unknown
}): boolean {
  if (item.kind === 'prohibition') return false
  // An explicit root wait qualification is a control boundary: the item records
  // what must happen and who must resume it, not work the agent may finish now.
  if (item.waitAuthorization !== undefined) return false
  if (item.authorityDisposition === undefined) return true
  if (item.authorityDisposition !== 'executable_now') return false
  return item.executee === undefined || item.executee === 'agent'
}

/**
 * The ONE authority predicate the mutation gate and preparation both consume.
 *
 * A record holds execution authority only when the reader GRANTED it a
 * qualification: a record with no qualification at all (captured before the
 * qualification existed) is refused rather than read from its stored
 * disposition, and a restricted record — anything a question, explanation,
 * investigation, reported question or quote governs — keeps its work as an
 * undecided obligation that authorizes nothing. Within a granted reading, the
 * disposition still decides: a prohibition, a wait, a human actor, a condition or
 * an information range is never a mutation. An `unresolved` GRANTED reading keeps
 * the historical path documented for unrecognised instruction forms.
 */
export function itemHoldsExecutionAuthority(item: {
  executionQualification?: ExecutionQualification
  authorityDisposition?: AuthorityDisposition
}): boolean {
  if (item.executionQualification === undefined) return false
  if (item.executionQualification.status !== 'granted') return false
  if (item.authorityDisposition === undefined) return true
  return item.authorityDisposition === 'executable_now' || item.authorityDisposition === 'unresolved'
}

/** Whether an item is an open obligation for certification purposes. */
export function isOpenObligation(item: GuardItem): boolean {
  return item.status === 'pending' && isExecutableItem(item)
}

/**
 * The action a scope names. `semanticActionFromText` maps the command surface,
 * but a prohibition keeps a bare verb as its body ("不要提交并推送" → 提交并推送),
 * and the closed CJK vocabulary is consulted first so such a ban is still
 * recorded against the action it forbids.
 */
export function semanticActionOfScope(body: string, source: string = body, isProhibition = false): ReturnType<typeof semanticActionFromText> {
  const masked = maskCodeSpans(source)
  // A prohibition's polarity is already settled by the interpretation, so its
  // verb is read directly even when the ban statement carries no negator (a
  // coordinated split such as "、不发布").
  const negation = isProhibition ? { index: 0, token: '' } : firstNegation(masked)
  if (negation) {
    // A ban is recorded against the action it forbids, which is the verb the
    // negator governs — never a verb the same clause happens to mention later.
    // The whole ban is read, so a verb separated from its negator by a long
    // object list still records the action the ban forbids.
    const banned = bannedVerbIndex(masked, negation.index + negation.token.length, masked.length)
    if (banned >= 0) {
      const word = CJK_VERB_WORDS.find((entry) => masked.startsWith(entry, banned)) ?? masked.slice(banned, banned + 2)
      const action = semanticActionFromText(word)
      if (action !== 'generic_run') return action
    }
  }
  // The command surface is the single authority for what action a clause names,
  // exactly as it was before 0.5.1. The CJK word scan only covers a verb the
  // command surface does not name (a bare verb left by stripping a negator, or
  // "…才推送" where the verb is the object of the adverb).
  return semanticActionFromText(body)
}

/**
 * Split a scope whose action is stated after a resumption clause: "请先测试，
 * 收到我的确认后再推送" runs the test now and reserves the push for the
 * confirmation. Only a comma-separated split is used, so the earlier action
 * keeps its own executable meaning and the later one waits.
 */
function splitTrailingResumption(scope: SplitScope): SplitScope[] {
  if (scope.condition !== undefined || scope.directive === 'prohibition') return [scope]
  const masked = maskCodeSpans(scope.text)
  // The resumption EVENT is located without the optional request prefix, so a
  // leading "请" cannot make the marker look like it opens the scope.
  const marker = RESUMPTION_EVENT.exec(masked)
  if (!marker || marker.index === 0) return [scope]
  if (firstActionVerb(masked.slice(0, marker.index)) < 0) return [scope]
  const boundary = masked.slice(0, marker.index).search(/[，,][^，,]*$/)
  if (boundary < 0) return [scope]
  const head = scope.text.slice(0, boundary + 1).trim()
  const rest = scope.text.slice(boundary + 1).trim()
  if (!head || !rest) return [scope]
  if (firstActionVerb(maskCodeSpans(head)) < 0) return [scope]
  if (firstActionVerb(maskCodeSpans(rest)) < 0) return [scope]
  return [{ text: head, body: head, directive: classifyPositive(head) }, { text: rest, body: rest, directive: 'directive' }]
}

/**
 * Every stateful action the clause names, in source order. A clause may order
 * more than one ("安装插件，重启 DSH"); each is a separate evidence obligation
 * even though the clause stays one top-level item.
 */
export function statefulActionsOfScope(body: string): StatefulAction[] {
  const masked = maskCodeSpans(body)
  const found: Array<{ at: number; action: StatefulAction }> = []
  const consider = (at: number, word: string) => {
    const action = semanticActionFromText(word)
    if (isStatefulAction(action)) found.push({ at, action })
  }
  for (const word of CJK_VERB_WORDS) {
    let at = masked.indexOf(word)
    while (at >= 0) {
      consider(at, word)
      at = masked.indexOf(word, at + word.length)
    }
  }
  for (const match of masked.matchAll(/\b(?:install|apply|restart|reload|commit|push|publish|pull|fetch|create|modify|edit)\b/gi)) {
    consider(match.index!, match[0])
  }
  found.sort((a, b) => a.at - b.at)
  const ordered: StatefulAction[] = []
  for (const entry of found) if (ordered.at(-1) !== entry.action) ordered.push(entry.action)
  return ordered
}

/** Actions this interpretation names, in source order (diagnostics only). */
export function namedActions(text: string): string[] {
  return interpretMessage(text)
    .map((scope) => semanticActionOfScope(scope.body))
    .filter((action) => action !== 'generic_run')
}
