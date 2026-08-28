import { normalizeClause } from './canonicalize.js'
import { extractArtifactPaths, extractMethod } from './capture.js'

export type UserInteractionKind = 'instruction' | 'conversational'

/**
 * Punctuation and whitespace that may surround a bare progression phrase
 * without turning it into sentence content.
 */
const PUNCT = String.raw`[\s。，、；：！？．,;:!?\-*"'“”‘’()（）.…～~]`

/**
 * Session-layer phrases that acknowledge or advance the conversation without
 * stating a task. Longer forms come first so the alternation consumes them
 * before their prefixes.
 */
const PROGRESSION_SOURCE = String.raw`(?:继续执行|继续吧|请继续|继续|接着做|接着|下一步|没问题|知道了|明白了|了解|好的?|是的?|对的?|收到|可以|行|嗯+|continue|go on|go ahead|keep going|proceed|okay|ok|yes|sure|right|next)`

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
export function classifyUserInteraction(text: string): UserInteractionKind {
  const normalized = normalizeClause(text)
  if (!normalized) return 'instruction'
  if (PROGRESSION_WHOLE.test(normalized)) return 'conversational'
  if (PROHIBITION_LEAD.test(normalized)) return 'instruction'
  if (hasStrongTaskFeature(normalized)) return 'instruction'
  if (QUESTION_TERMS.test(normalized)) return 'conversational'
  if (META_COMMENT_LEAD.test(normalized)) return 'conversational'
  if (PROGRESSION_LEAD.test(normalized)) return 'conversational'
  return 'instruction'
}
