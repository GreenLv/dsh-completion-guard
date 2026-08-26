import { normalizeClause } from './canonicalize.js'
import { hasCurrentCertificate } from './goal-gate.js'
import type { GuardProjection } from './types.js'

export type CompletionDisposition =
  | 'complete'
  | 'user_wait'
  | 'external_wait'
  | 'report'

const QUOTED = /["'“”‘’`].*?(?:complete|done|finished|完成|做完|搞定).*?["'“”‘’`]/i
const EXAMPLE = /\b(?:for example|e\.g\.|such as|like saying|例如|比如|举例|作为一个例子)\b/i
const QUESTION = /\?[ \t]*$|\b(?:should|could|would|can|will|what|how|whether)\b.*\?/i
const TRAILING_NEGATION = /\b(?:not (?:yet |quite |fully )?(?:complete|done|finished)|isn'?t (?:complete|done|finished)|hasn'?t (?:been )?(?:completed|finished)|尚未完成|还没完成|未完成|没有完成|还未完成)\b/i
const CONDITIONAL = /\b(?:if|unless|once|when|whenever|provided that|只要|如果|假如|一旦|除非)\b/i
const PARTIAL_ONLY = /\b(?:step|phase|stage|milestone)\s+\d+\b|第[一二三四五六七八九十\d]+\s*(?:步|阶段|环节)|(?:第一步|第二步|第三步)/i

const WHOLE_COMPLETION_EN = /\b(?:the )?(?:task|work|job|everything|all tasks?|all work) (?:is|are) (?:now )?(?:complete|done|finished|completed)\b|\b(?:task|work) (?:has been )?(?:completed|finished)\b|\ball (?:tasks|work|requirements) (?:have been )?(?:completed|done|met)\b/i
const WHOLE_COMPLETION_ZH = /(?:任务|工作|所有任务|全部工作|整体)(?:已经|已)?(?:全部)?(?:完成|搞定|做完)|(?:已|已经)(?:全部|所有)?(?:完成|搞定)(?:了)?(?:全部|所有)?(?:任务|工作)?/i
/** Bare completion confirmations, e.g. "Done." or "搞定了。" */
const BARE_COMPLETION = /^(?:done|finished|completed|all\s+done)[.!]?$|^(?:已完成|完成了|搞定了|搞定|完成|done)[。．.!！]?$/i
/** Continuation intent following a claim makes it partial, not whole-task. */
const CONTINUATION = /接下来|下一步|然后|接着|继续|再去|最后再|还差|剩下|剩余|第二步|第三步|,\s*(?:next|then|after that|moving on)\b/i

function looksQuotedOrExemplary(text: string): boolean {
  return QUOTED.test(text) || EXAMPLE.test(text)
}

export function isWholeTaskCompletionClaim(text: string): boolean {
  const normalized = normalizeClause(text)
  if (!normalized) return false
  if (QUESTION.test(normalized)) return false
  if (TRAILING_NEGATION.test(normalized)) return false
  if (CONDITIONAL.test(normalized)) return false
  if (CONTINUATION.test(normalized)) return false
  if (looksQuotedOrExemplary(normalized)) return false
  if (PARTIAL_ONLY.test(normalized) && !WHOLE_COMPLETION_EN.test(normalized) && !WHOLE_COMPLETION_ZH.test(normalized)) return false
  // A leading bare completion title makes the title authoritative: a clean
  // summary is a whole-task claim, a dirty summary (continuation, negation,
  // conditional, partial step) is not — and must not fall through to the
  // full-text patterns that could re-match a summary's own "已经完成".
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? ''
  if (BARE_COMPLETION.test(firstLine)) return leadingBareCompletionClaim(text)
  return BARE_COMPLETION.test(normalized) || WHOLE_COMPLETION_EN.test(normalized) || WHOLE_COMPLETION_ZH.test(normalized)
}

/**
 * A reply whose first non-empty line is a standalone bare completion ("完成。"
 * or "Done.") followed by a results summary. The whole text no longer matches
 * the single-line BARE_COMPLETION anchor, but the summary must still be treated
 * as a whole-task completion claim.
 */
function leadingBareCompletionClaim(text: string): boolean {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const first = lines[0]
  if (!first || !BARE_COMPLETION.test(first)) return false
  const rest = normalizeClause(lines.slice(1).join('\n'))
  if (!rest) return true
  if (CONTINUATION.test(rest)) return false
  if (TRAILING_NEGATION.test(rest)) return false
  if (CONDITIONAL.test(rest)) return false
  if (looksQuotedOrExemplary(rest)) return false
  if (PARTIAL_ONLY.test(rest)) return false
  return true
}

export function classifyCompletionClaim(text: string): CompletionDisposition {
  const normalized = normalizeClause(text)
  if (/waiting for (?:you|the user|input|your)|please (?:review|confirm|approve)|等待(?:您|你|用户)|请(?:确认|审阅|批准)/i.test(normalized)) return 'user_wait'
  if (/waiting for (?:the )?(?:result|output|response|build|test|deployment)|等待(?:结果|输出|构建|测试|部署|响应)/i.test(normalized)) return 'external_wait'
  if (isWholeTaskCompletionClaim(normalized)) return 'complete'
  return 'report'
}

export interface TurnStoppingDecision {
  action: 'continue' | 'stop'
  reason?: string
}

export function decideTurnStopping(
  projection: GuardProjection,
  assistantText: string,
  turn: number,
  maxAttempts: number,
): TurnStoppingDecision {
  if (!projection.enabled) return { action: 'stop' }
  if (!isWholeTaskCompletionClaim(assistantText)) return { action: 'stop' }
  if (hasCurrentCertificate(projection)) return { action: 'stop' }
  const attempts = projection.continuationAttempts.get(turn) ?? 0
  if (attempts >= maxAttempts) return { action: 'stop', reason: 'continuation attempt limit reached' }
  projection.continuationAttempts.set(turn, attempts + 1)
  return { action: 'continue', reason: 'whole-task completion claimed without a current certificate' }
}

export function latestAssistantText(events: readonly { type: string; data: unknown }[]): string {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event.type !== 'assistant/message') continue
    const data = event.data as { message?: { content?: Array<{ type: string; text?: string }> } }
    const text = data.message?.content?.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n') ?? ''
    if (text.trim()) return text
  }
  return ''
}
