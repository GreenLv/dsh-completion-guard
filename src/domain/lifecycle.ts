import { PROTOCOL_V4_NOTICE, PROTOCOL_V5_NOTICE } from './derive.js'
/**
 * Runtime-owned startup lifecycle. It expresses the activation strategy of a
 * session, never contract or certification state: `armed` means protection is
 * enabled and waiting for the first real root user input, `active` means that
 * input has entered a step, and `disabled` means an explicit `off` (or an
 * opt-in session without `on`). Certification still depends only on durable
 * root events, the current contract, and the evidence chain.
 */
export type LifecyclePhase = 'armed' | 'active' | 'disabled'
export interface FirstStepInjection {
  /** Versioned protocol boundary appended before this step's messages. */
  boundary: string
  /** Compact first-step guidance describing the activated protection. */
  guidance: string
}
/** One claimed pre-step message: a validated host `UserMessage`. */
export interface ClaimedMessage {
  source?: { kind?: unknown; plugin?: unknown }
  content?: unknown
}
function claimedTextParts(content: unknown): { hasText: boolean; hasOtherParts: boolean } {
  if (!Array.isArray(content)) return { hasText: false, hasOtherParts: false }
  let hasText = false
  let hasOtherParts = false
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const record = part as Record<string, unknown>
    if (record.type === 'text') {
      if (typeof record.text === 'string' && record.text.trim()) hasText = true
      continue
    }
    // Image, attachment, and any future part type: a real non-text input.
    hasOtherParts = true
  }
  return { hasText, hasOtherParts }
}
/**
 * Pure preview of one claimed pre-step batch. Messages claimed by the loop are
 * NOT yet persisted as `user/message` events at pre-step time, so this reads
 * only the validated claim: it never writes contract items, evidence, or
 * authority. A message activates protection when it carries a root user source
 * and real content — non-empty text, or any non-text part (image/attachment).
 * Whitespace-only messages with no other parts are real input but state no
 * task, so they neither activate nor produce contract items.
 */
export function claimedBatchHasRealRootInput(messages: readonly unknown[]): boolean {
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const record = message as ClaimedMessage
    if (record.source?.kind !== 'user') continue
    const { hasText, hasOtherParts } = claimedTextParts(record.content)
    if (hasText || hasOtherParts) return true
  }
  return false
}
export interface FirstStepPreviewInput {
  activation: 'opt-in' | 'always'
  /** Log-derived enablement: an explicit `off` suppresses `always` until `on`. */
  enabled: boolean
  /** The durable log already contains a v5 (0.6) Guard boundary. */
  boundaryV5Present?: boolean
  /** The durable log already contains a v4 (or newer) Guard boundary. */
  boundaryPresent: boolean
  /** The session is a delegated/subagent session, never a root conversation. */
  delegated: boolean
  /** 0.6.1 (W060-05): the effective responsibility tier shapes the guidance. */
  policy?: 'standard' | 'strict' | 'release'
}
/**
 * Pure decision for the first-step activation injection when protection is enabled. The
 * boundary must precede the first constrained root message inside the SAME
 * persisted step batch; guidance is compact and never claims a recovery that
 * did not happen. `opt-in` reaches this path only after its explicit `on` command. Delegated sessions receive neither: their
 * scope arrives through the parent's delegation prompt (A04).
 *
 * A session without a v5 boundary receives the 0.6 boundary: it cuts the
 * work-unit/delivery/certificate-v2 semantics at exactly this message. A
 * session that already has v5 injects nothing.
 */
export function previewFirstStepInjection(
  input: FirstStepPreviewInput,
  claimedRealInput: boolean,
): FirstStepInjection | undefined {
  if (!input.enabled || input.delegated) return undefined
  if (!claimedRealInput) return undefined
  if (input.boundaryV5Present) return undefined
  return {
    boundary: PROTOCOL_V5_NOTICE,
    guidance: firstStepGuidance(input.policy ?? 'standard'),
  }
}
/**
 * Compact first-step guidance: protection has started, what it protects, and
 * when the guarded producer path is needed. 0.6.1 (W060-05): the stateful
 * workflow is stated CONDITIONALLY — only an obligation whose own clause
 * demands a certified stateful action runs through prepare/producer/checkpoint.
 * The 0.6.0 text demanded that order for every stateful action unconditionally,
 * which ordinary business work correctly read as a Guard approval gate.
 * Ordinary answers, investigations, and ordinary tool work are never gated, and
 * missing Guard evidence is never a reason to repeat a completed action.
 */
export function firstStepGuidance(policy: 'standard' | 'strict' | 'release' = 'standard'): string {
  const strict = policy === 'strict'
    ? ' Under strict policy, a verification the user explicitly requested (a visual readback or a complete-scope check) must be discharged by a real readback fact.'
    : ''
  return 'Context Guard is now protecting this session: requirements from your messages stay open until they are certified with matching durable evidence. Ordinary answers, investigations, and ordinary tool work need no Guard approval. When a requirement itself calls for a certified stateful action (install, apply, create, modify, restart, commit, push, publish, pull, fetch), call context_guard_prepare before it to see the supported command shape and the required resolution/effect/state order, run the action through the guarded path, and close items with context_guard_checkpoint; never repeat an already-completed action to mint missing evidence.'
    + strict
    + ' Ordinary answers and investigations need no certification.'
}
export const FIRST_STEP_GUIDANCE: string = firstStepGuidance('standard')
/**
 * Lifecycle phase derived from durable facts. `enabled` is the log-derived
 * enablement (`always`, or the explicit `on`/`off` command sequence), and
 * `realInputSeen` records that a real root user input already entered a step.
 * Pure over its inputs so status display and tests cannot drift from the
 * injection decision.
 */
export function lifecyclePhase(input: {
  enabled: boolean
  realInputSeen: boolean
}): LifecyclePhase {
  if (!input.enabled) return 'disabled'
  return input.realInputSeen ? 'active' : 'armed'
}