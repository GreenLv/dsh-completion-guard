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
  if (BARE_COMPLETION.test(normalizeTitleLine(firstLine))) return leadingBareCompletionClaim(text)
  return BARE_COMPLETION.test(normalized) || WHOLE_COMPLETION_EN.test(normalized) || WHOLE_COMPLETION_ZH.test(normalized)
}

// A leading run of presentation decoration (emoji, checkmarks, bullets, dash
// glyphs) that may precede a bare completion title. Variation selectors and the
// zero-width joiner are kept as separate alternation branches (not inside the
// character class) so they are not treated as misleading combining sequences.
const DECORATION_LEAD = /^\s*(?:[\p{Extended_Pictographic}\u2764\u2705\u2714\u2716\u2728\u274C\u26A0\u2611\u2612\u2713\u2717\u274E\u2B50\u2B55\u2022\u00B7\u25E6\u25AA\u25AB\u25CF\u25CB\u25A0\u25A1\u2013\u2014-]|\uFE0F|\uFE0E|\u200D)+/u

/** Strip a leading run of decorative glyphs from a title line. */
function stripDecorationPrefix(text: string): string {
  let value = text
  let previous = ''
  while (value !== previous) {
    previous = value
    value = value.replace(DECORATION_LEAD, '')
  }
  return value.replace(/^\s+/, '')
}

/**
 * Normalize a title line for the bare-completion test. Markdown heading markers,
 * fully-wrapping emphasis (`**…**`, `__…__`, `*…*`, `_…_`), and a leading run of
 * decorative glyphs are removed ITERATIVELY until stable, because stripping one
 * layer may expose another (`## ✅ **完成。**`). Blockquotes (`>`), quoted
 * titles, and examples are left untouched so they still fail closed.
 */
function normalizeTitleLine(line: string): string {
  let value = line.trim()
  if (value.startsWith('>')) return value
  let previous = ''
  while (value !== previous) {
    previous = value
    value = value
      .replace(/^#{1,6}\s+/, '')
      .replace(/^\*\*(.+?)\*\*$/, '$1')
      .replace(/^__(.+?)__$/, '$1')
      .replace(/^\*(.+?)\*$/, '$1')
      .replace(/^_(.+?)_$/, '$1')
    value = stripDecorationPrefix(value)
  }
  return value
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
  if (!first || !BARE_COMPLETION.test(normalizeTitleLine(first))) return false
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

export interface AssistantOutcomeObservation {
  kind: 'completion_claim' | 'user_wait_claim' | 'external_wait_claim' | 'report'
  reasonCode: string
}

/** Assistant prose is retained only as a bounded diagnostic observation. */
export function observeAssistantOutcome(text: string): AssistantOutcomeObservation {
  const disposition = classifyCompletionClaim(text)
  if (disposition === 'complete') return { kind: 'completion_claim', reasonCode: 'assistant_completion_claim_observed' }
  if (disposition === 'user_wait') return { kind: 'user_wait_claim', reasonCode: 'assistant_user_wait_claim_observed' }
  if (disposition === 'external_wait') return { kind: 'external_wait_claim', reasonCode: 'assistant_external_wait_claim_observed' }
  return { kind: 'report', reasonCode: 'assistant_report_observed' }
}

/**
 * Stop Protocol 2.0 decision. This function deliberately has no assistant-text
 * parameter: completion wording, quotation, negation and translation cannot
 * steer the protocol. A structured root persistence authorization may request
 * one fallback correction; subsequent attempts safe-yield. An active, armed
 * Goal remains exclusively owned by the host Goal Round Driver.
 */
export function decideTurnBoundary(projection: GuardProjection): TurnStoppingDecision {
  if (!projection.enabled) return { action: 'stop', reason: 'guard_disabled' }
  if (projection.integrity !== 'valid') return { action: 'stop', reason: 'integrity_invalid_safe_yield' }
  if (hasCurrentCertificate(projection)) return { action: 'stop', reason: 'current_certificate' }
  const boundary = projection.boundaries.at(-1)
  if (boundary?.persistedResult === 'accepted'
    && boundary.epoch === projection.epoch
    && boundary.contractRevision === projection.contractRevision) {
    return { action: 'stop', reason: 'accepted_boundary_pending_effectuation' }
  }
  if (projection.currentGoalPhase === 'active' && projection.currentGoalActivation === 'armed') {
    return { action: 'stop', reason: 'goal_round_driver_owns_continuation' }
  }
  if ([...projection.items.values()].some((item) => item.status === 'pending' && item.persistenceAuthorization)) {
    const key = `${projection.epoch}:${projection.contractRevision}`
    const attempts = projection.persistenceCorrectionAttempts.get(key) ?? 0
    if (attempts < 1) {
      projection.persistenceCorrectionAttempts.set(key, attempts + 1)
      return { action: 'continue', reason: 'protocol_correction_steer' }
    }
  }
  return { action: 'stop', reason: 'safe_yield_pending_preserved' }
}

export function decideTurnStopping(
  projection: GuardProjection,
  _assistantText: string,
  _turn: number,
  _maxAttempts: number,
): TurnStoppingDecision {
  return decideTurnBoundary(projection)
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
