import { normalizeClause } from './canonicalize.js'
import { availableBoundaryQualifications } from './boundary.js'
import { hasCurrentCertificate } from './goal-gate.js'
import type { GuardProjection } from './types.js'

/**
 * What "relevant progress" means, as one value.
 *
 * The inputs are the recorded state a caller could not have faked without
 * changing the work itself: the epoch and contract revision, the open items and
 * their blockers, the qualified evidence set, the boundary qualifications
 * available right now, and the Goal's identity and activation. Deliberately
 * absent: timestamps, event counts, wording, checkpoint bodies, and the Goal
 * *revision* — editing a Goal's text is not progress, and treating it as such
 * would let a re-statement reset the stop budget.
 */
/**
 * How many times the same progress fingerprint must be observed at a turn
 * boundary before Guard stops the automatic continuation.
 *
 * The first sighting is a baseline, not a stalled turn: it is the state a turn
 * either advanced to or started from, and the host's driver owns continuation
 * there. The second sighting is the first turn that produced nothing new, which
 * earns the one diagnosis and correction opportunity. The third is the bounded
 * stop. The count is a resource bound on repetition, never a way to declare the
 * task finished.
 */
export const NO_PROGRESS_TURNS_BEFORE_STOP = 3

/** Marks the durable no-progress record; replay reads the budget from these. */
export const NO_PROGRESS_RECORD_PREFIX = 'Context Guard no-progress record: '

/**
 * The identity of the turn boundary a decision is taken at.
 *
 * Guard does not own the host's turn counter, and a retry must be recognisable
 * as the same boundary rather than as a new one. The last durable event is that
 * identity: it is derivable from the log alone, it is stable across a reload,
 * and it only advances when the session actually records something new.
 */
export function decisionBoundaryKey(projection: GuardProjection): number | undefined {
  return projection.hostTurn
}

export function progressFingerprint(projection: GuardProjection): string {
  const open = [...projection.items.values()]
    .filter((item) => item.status === 'pending')
    .map((item) => `${item.id}:${item.revision}:${item.normalizedText}`)
    .sort()
  const evidence = [...projection.evidence.values()]
    .filter((row) => row.epoch === projection.epoch && row.outcome === 'success')
    .map((row) => row.id)
    .sort()
  const qualifications = availableBoundaryQualifications(projection)
    .map((row) => `${row.id}:${row.status}`)
    .sort()
  return JSON.stringify({
    epoch: projection.epoch,
    contractRevision: projection.contractRevision,
    open,
    evidence,
    qualifications,
    goal: projection.currentGoalRef?.id ?? null,
    // Phase and activation are deliberately absent: they are what a stop
    // CHANGES, not evidence of progress. Including them would make the digest of
    // a stopped task differ from the digest the stop recorded, so a persisted
    // bounded stop could never re-qualify after its own effect.
  })
}

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
  /**
   * The no-progress attempt this decision asks the caller to record durably.
   * Recording is the caller's job because it is a durable side effect; deciding
   * is this function's job and must stay free of them.
   */
  noProgressClaim?: { fingerprint: string; boundaryKey: string; attempt: number }
}

export interface AssistantOutcomeObservation {
  kind: 'completion_claim' | 'user_wait_claim' | 'external_wait_claim' | 'report'
  reasonCode: string
}

export interface CurrentActionBasis {
  itemId: string
  action: string
  sourceMessageId: string
  unmetPredicate: string
  owner: 'assistant'
  readiness: 'ready'
  asOf: number
}

/** A concrete, current root-owned action, with host capability and no pending
 * condition. Historical generic text and old qualifications are not upgraded. */
export function testOutcomePredicate(text: string): string {
  return /(?:回归测试|regression\s+tests?)/iu.test(text) ? 'regression_test_result'
    : /(?:focused\s+tests?|针对[^，,。.!?？]{0,32}?的?\s*测试)/iu.test(text) ? 'focused_test_result' : 'test_passed'
}

export function assessmentOutcomePredicate(text: string): string {
  return /(?:内存|memory)/iu.test(text) ? 'current_memory_measurement_result'
    : /(?:延迟|时延|latency)/iu.test(text) ? 'latency_measurement_result' : 'verification_passed'
}

export function assessmentAction(text: string): string {
  return /(?:内存|memory)/iu.test(text) ? 'measure_current_memory_cost' : 'evaluate_current_effect'
}

export function currentActionBases(projection: GuardProjection, enforceCore = true): CurrentActionBasis[] {
  if (projection.hostStatus !== 'supported') return []
  const basis: CurrentActionBasis[] = []
  for (const item of projection.items.values()) {
    if (item.status !== 'pending' || item.kind === 'prohibition' || item.authority !== 'root_instruction'
      || item.authorityDisposition !== 'executable_now' || item.legacyFlags?.length
      || item.waitAuthorization || item.condition || item.targetCaptureStatus === 'clarification_required') continue
    const action = item.semanticAction
    if (!action || action === 'generic_run') continue
    if (action !== 'test' && action !== 'verify') continue // other actions need their own concrete readiness adapter
    if (!/^m\d+(?::|$)/.test(item.sourceMessageId)) continue
    const sourceSeq = Number(/^m(\d+)/.exec(item.sourceMessageId)?.[1] ?? -1)
    const scope = item.requestedTarget?.scope
    if (typeof scope !== 'string') continue
    const readiness = [...projection.evidence.values()].some((fact) => fact.epoch === projection.epoch
      && fact.toolResultSeq >= sourceSeq && fact.outcome === 'success' && fact.parseStatus === 'supported'
      && fact.toolName === 'context_guard_observe_test_readiness' && fact.readinessForItemId === item.id
      && fact.readinessPredicate === (action === 'test' ? 'test_passed' : 'verification_passed') && fact.subjects.includes(scope)
      && typeof fact.readinessManifestSha256 === 'string'
      && (action !== 'verify' || (!fact.readinessEffectCallId && fact.readinessInputSha256 === fact.readinessManifestSha256)
        || [...projection.evidence.values()].some((effect) => effect.callId === fact.readinessEffectCallId
        && effect.epoch === fact.epoch && effect.toolResultSeq < fact.toolResultSeq && effect.outcome === 'success'
        && effect.parseStatus === 'supported' && effect.semanticAction === 'modify' && effect.evidenceRole === 'effect'
        && effect.operations?.some((operation) => operation.op === 'modify' && operation.path === fact.readinessSelectedPath))))
    if (!readiness) continue
    const latestRun = [...projection.evidence.values()].filter((fact) => fact.epoch === projection.epoch
      && fact.toolResultSeq >= sourceSeq && fact.semanticAction === action && fact.evidenceRole === 'effect'
      && fact.subjects.includes(scope)).sort((a, b) => b.toolResultSeq - a.toolResultSeq)[0]
    const alreadyRan = latestRun?.outcome === 'success' && latestRun.parseStatus === 'supported'
      && latestRun.processFacts?.outcome === 'success' && latestRun.processFacts.operationAttribution === 'single_operation'
    if (alreadyRan) continue
    basis.push({ itemId: item.id, action, sourceMessageId: item.sourceMessageId,
      unmetPredicate: action === 'test' ? testOutcomePredicate(item.normalizedText) : assessmentOutcomePredicate(item.normalizedText),
      owner: 'assistant', readiness: 'ready', asOf: projection.lastObservedSourceSeq })
  }
  if (projection.boundaryProtocol === 6 && enforceCore) {
    if (!projection.coreV2) return []
    const current = Array.isArray(projection.coreV2.current_actions) ? projection.coreV2.current_actions : []
    return basis.filter((entry) => current.some((value) => value && typeof value === 'object'
      && (value as Record<string, unknown>).requirement_id === entry.itemId))
  }
  return basis
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
export function decideTurnBoundary(projection: GuardProjection, latestRootText = ''): TurnStoppingDecision {
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
    // An active armed Goal is the continuation owner, but "armed" is not
    // unbounded: a turn boundary that repeats the SAME progress fingerprint is
    // evidence that nothing relevant changed, and Guard stops the automatic
    // continuation instead of spending the host's rounds forever.
    // The budget is read from the log, never incremented here: this function is
    // a decision, and a decision that spent budget by being asked would count a
    // replay as progress made. The caller records the claim it is told to make.
    const fingerprint = progressFingerprint(projection)
    const claims = projection.noProgressClaims.get(fingerprint) ?? new Map<string, number>()
    // The boundary is identified by the last durable event this decision was
    // taken from. A retry re-reads the same log, so it recomputes the same
    // boundary key, sees its own claim excluded from the prior count, and lands
    // on the same attempt — whether or not the projection was re-derived in
    // between. A new turn has a new last event, so it is a new boundary.
    const hostTurn = decisionBoundaryKey(projection)
    // No host turn identity means no reliable boundary. The guard then declines
    // to spend the budget at all — it does not fall back to an inferred key,
    // because a wrong key either freezes the budget or spends it twice, and
    // neither is a stop the host can be asked to honour.
    if (hostTurn === undefined) return { action: 'stop', reason: 'no_progress_identity_unavailable' }
    const boundaryKey = String(hostTurn)
    const prior = [...claims].filter(([key]) => key !== boundaryKey).length
    const claim = { fingerprint, boundaryKey, attempt: prior + 1 }
    if (prior === 0) return { action: 'stop', reason: 'goal_round_driver_owns_continuation', noProgressClaim: claim }
    if (prior < NO_PROGRESS_TURNS_BEFORE_STOP - 1) return { action: 'continue', reason: 'no_progress_diagnosis_steer', noProgressClaim: claim }
    return { action: 'stop', reason: 'no_progress_bounded_disarm' }
  }
  // A current Goal that is not the active, armed continuation owner belongs to
  // the host or the user, never to Guard. DSH 0.1.5-rc.1 pauses a goal
  // immediately and only a human `resume` re-arms it, so Guard must not spend
  // its one correction steer to restart work the user stopped: a paused,
  // blocked, completed, or not-yet-read-back goal yields instead of continuing.
  if (projection.currentGoalRef) {
    return {
      action: 'stop',
      reason: projection.currentGoalPhase === 'paused'
        ? 'goal_paused_by_user_safe_yield'
        : 'goal_not_continuable_safe_yield',
    }
  }
  const actions = currentActionBases(projection)
  // V6 control authority comes from core's source-scoped, as-of root-control
  // fold. An old item that still contains a persistence phrase is historical:
  // it cannot override a later pause/cancel or grant a newly introduced item.
  const reasons = projection.boundaryProtocol === 6 && Array.isArray(projection.coreV2?.reason_codes)
    ? projection.coreV2.reason_codes as string[] : undefined
  const explicitPersistence = reasons ? reasons.includes('explicit_user_persistence')
    : [...projection.items.values()].some((item) => item.authority === 'root_instruction'
      && !item.legacyFlags?.length && item.persistenceAuthorization?.kind === 'root_explicit_persistence')
  const shortResume = reasons ? reasons.includes('resume_with_actionable_work')
    : /^(?:请)?(?:继续|接着做|继续执行|go on|continue|proceed)[。.!！\s]*$/i.test(latestRootText.trim())
  if (actions.length && (explicitPersistence || shortResume)) {
    const hostTurn = decisionBoundaryKey(projection)
    if (hostTurn === undefined) return { action: 'stop', reason: 'correction_identity_unavailable' }
    const fingerprint = `correction:${progressFingerprint(projection)}`
    const claims = projection.noProgressClaims.get(fingerprint) ?? new Map<string, number>()
    const boundaryKey = String(hostTurn)
    if (claims.has(boundaryKey) || claims.size > 0) return { action: 'stop', reason: 'protocol_correction_already_issued' }
    return { action: 'continue', reason: shortResume ? 'resume_with_actionable_work' : 'explicit_user_persistence',
      noProgressClaim: { fingerprint, boundaryKey, attempt: 1 } }
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

/**
 * Whether the last trusted ROOT instruction asked to pause.
 *
 * The source filter is the contract, not a heuristic: a quoted log, a tool
 * result, a plugin notice or a model message is not a `user/message` with
 * `source.kind === 'user'`, so none of them can reach this function at all, and
 * neither can the model's own summary of one. A negated pause ("不要暂停") is not
 * a pause request, and the check is anchored to a clause head so a pause word
 * mentioned inside a longer instruction is not a control request.
 */
export function latestRootInstruction(
  events: readonly { type: string; seq?: number; data: unknown }[],
): { text: string; seq: number } | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'user/message') continue
    const data = event.data as { source?: { kind?: string }; content?: Array<{ type?: string; text?: string }> }
    if (data.source?.kind !== 'user') continue
    const text = (data.content ?? []).filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('\n')
    if (text.trim()) return { text, seq: event.seq ?? 0 }
  }
  return undefined
}

/** Marks a root control request Guard has already carried to the host. */
export const CONTROL_RECORD_PREFIX = 'Context Guard control record: '

const PAUSE_REQUEST = /(?:^|[。！？；;，,、\s])(?:请|麻烦)?\s*(?:先)?\s*(?:暂停|停一下|停一停|先停|暂时停止)(?:一下|下|吧)?\s*(?:[。！？；;，,、]|$)|\b(?:please\s+)?(?:pause|hold\s+on|stop\s+for\s+now)\b/i
const NEGATED_PAUSE = /(?:不要|不用|别|无需|不必)\s*(?:先)?\s*(?:暂停|停)|\b(?:do\s+not|don't|never)\s+(?:pause|stop)\b/i

export function isRootPauseRequest(text: string): boolean {
  if (NEGATED_PAUSE.test(text)) return false
  return PAUSE_REQUEST.test(text)
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
