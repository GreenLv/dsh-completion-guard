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
  /** Explicitly named tool/method, when the scope names one. */
  method?: string
  /** Stable identity of this interpretation, reproducible from the same bytes. */
  fingerprint: string
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
const WORK_VERB = /创建|生成|新建|写入|修改|编辑|运行|执行|编写|撰写|部署|安装|升级|提交|下载|上传|拉取|同步|重启|测试|检查|验证|确认|修复|更新|清理|整理|记录|构建|编译|重构|迁移|删除|回滚|发布|推送|合并|继续|恢复|还原|回滚|实现|\b(?:build|create|write|modify|change|edit|run|fix|update|install|push|publish|test|verify|check|commit|deploy|migrate|remove|delete|restart|revert|refactor|inspect|fetch|pull|implement)\b/i

/** Explanatory framings: an action named afterwards is an object, not an order. */
const EXPLAIN_VERB = /解释|说明|讲解|介绍|阐述|分析|讨论|描述|科普|什么意思|是什么意思|有什么(?:作用|影响|区别)|\bexplain\b|\bdescribe\b|\bclarify\b|\bwhat\s+does\b|\bwhat\s+is\b|\bhow\s+does\b|\bmeaning\s+of\b/i

/** Interrogative framings that make a scope a question rather than an order. */
const QUESTION_SCOPE = /[？?]|是否|是不是|为什么|为何|怎么|如何|什么|哪些|哪一种|能否|可否|要不要|该不该|由谁|是谁|\b(?:whether|which|why|should|could|would)\b/i

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
const DISTINCT_CLAUSE_HEAD = /^\s*(?:检查|查看|测试|验证|运行|执行|安装|应用|更新|升级|提交|推送|发布|部署|重启|重新启动|创建|新建|生成|修改|编辑|拉取|抓取|删除|回滚|清理|整理)/u
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
 * A completed confirmation receipt: the root reports that the event it was
 * waiting for already happened. It reserves nothing, so it must not mint a
 * wait, and it is not work either.
 */
const CONFIRMATION_RECEIPT = /^(?:我)?\s*(?:已|已经)?\s*(?:收到|得到|等到|等待)(?:了|过)?\s*(?:我|你|您|用户)?\s*的?\s*.{0,12}?(?:确认|回复|回报|批准|同意|授权|指示|通知)\s*(?:了|啦|过|收到)\s*[。．.!！]?$/u

const SENTENCE_END = new Set(['。', '！', '？', '!', '?', '\n', '\r'])

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
function actionVerbMatches(text: string, offset = 0, before = text.length): Array<{ index: number; length: number }> {
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
function verbIsNegated(text: string, index: number): boolean {
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
    if (conditionPrefix !== undefined && earliestNegation < 0 && !locativePrefix) {
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
      }
      if (head) pending.push({ text: head, offset })
      continue
    }

    const end = positiveScopeEnd(masked, options)
    const head = text.slice(0, end).trim()
    const tail = text.slice(end).trim()
    if (tail) pending.push({ text: tail, offset: offset + end })
    if (head) {
      const inherited = conditionPrefix !== undefined && conditionPrefix < head.length
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
  return resolved
    .sort((a, b) => a.offset - b.offset)
    .filter((entry) => {
      const key = `${entry.offset}\u0000${entry.scope.directive}\u0000${entry.scope.text}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((entry) => entry.scope)
    // A scope with no action-bearing text states nothing: neither pure
    // punctuation nor a conflict marker that only closed a previous ban.
    .filter((scope) => /[\p{L}\p{N}]/u.test(scope.body) && /[\p{L}\p{N}]/u.test(scope.text))
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
    if (SENTENCE_END.has(character)) return cursor + 1
    if (character === '；' || character === ';') return cursor + 1
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

/** Classify a non-negated scope. */
function classifyPositive(text: string): DirectiveClass {
  const masked = maskCodeSpans(text)
  const visibleVerb = firstActionVerb(masked)
  // An action that exists only inside a code span is quoted data.
  if (visibleVerb < 0 && firstActionVerb(text) >= 0) return 'informational'
  const explain = EXPLAIN_VERB.exec(masked)
  if (explain) {
    const verb = firstActionVerb(masked)
    if (verb < 0 || verb >= explain.index) return 'informational'
  }
  if (QUESTION_SCOPE.test(masked)) return 'informational'
  if (UNRESOLVED_SCOPE.test(masked)) return 'informational'
  if ((NARRATIVE_PAST.test(masked) || NARRATIVE_ASPECT.test(masked)) && !NARRATIVE_DIRECTIVE.test(masked)) return 'narrative'
  if (CONFIRMATION_RECEIPT.test(masked.trim())) return 'narrative'
  return 'directive'
}

// ---------------------------------------------------------------------------
// Executee and disposition
// ---------------------------------------------------------------------------

function executeeOf(text: string, directive: DirectiveClass): Executee {
  if (directive === 'informational' || directive === 'narrative' || directive === 'conditional') return 'unresolved'
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
  if (scope.directive === 'informational' || scope.directive === 'narrative') return 'informational'
  // The condition clause itself orders nothing; it becomes visible as the
  // guarded action's `condition`, never as work on its own.
  if (scope.directive === 'conditional') return 'conditional_wait'
  if (scope.condition) return 'conditional_wait'
  if (executee === 'user') return 'human_actor'
  if (isOutputRequest(scope.text)) return 'informational'
  return 'executable_now'
}

function resumeEventOf(scope: SplitScope): string | undefined {
  const match = RESUME_MARKER.exec(scope.condition ?? scope.text)
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
  const authorityDisposition = dispositionOf(conditioned, executee)
  const resumeEvent = scope.directive === 'directive' ? resumeEventOf(conditioned) : undefined
  const method = scope.directive === 'prohibition' ? undefined : semanticMethod(scope.body)
  return {
    text: scope.text,
    body: scope.body,
    directive: scope.directive,
    executee,
    ...(conditioned.condition ? { condition: conditioned.condition } : {}),
    ...(resumeEvent ? { resumeEvent } : {}),
    immediatelyExecutable: authorityDisposition === 'executable_now',
    authorityDisposition,
    ...(method ? { method } : {}),
    fingerprint: fingerprintOf([
      scope.text, scope.body, scope.directive, executee, authorityDisposition,
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
    : scopes.some((scope) => scope.directive === 'prohibition') ? 'prohibition' : 'informational'
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
