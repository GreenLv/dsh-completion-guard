import { sha256 } from './canonicalize.js'
import { captureItem, extractMethod, extractOperation } from './capture.js'
import { deriveItemDiagnosis } from './diagnostics.js'
import type { GuardItem, GuardProjection } from './types.js'
import { isFrozenV042RebindResponse } from './confirm-parse.js'

export interface RebindArgs {
  operation: 'propose' | 'query' | 'withdraw'
  item_id?: string
  proposal_id?: string
  clauses?: string[]
  clarification_item_ids?: string[]
}
export interface RebindProposal {
  id: string
  digest: string
  session: string
  epoch: number
  contractRevision: number
  itemId: string
  itemRevision: number
  sourceMessageId: string
  originalText: string
  clauses: string[]
  clarificationItemIds: string[]
  candidates: Array<{ sourceText: string; action: GuardItem['semanticAction']; requestedTarget: GuardItem['requestedTarget'];
    acceptance: GuardItem['verification']; sourceMessageId: string; rootItemId: string | null; rootRevision: number | null }>
  status: 'pending' | 'confirmed' | 'withdrawn' | 'stale'
  confirmationEvent?: string
  replacementIds?: string[]
  /** Proposals created under the 0.5 protocol carry their replay schema. */
  protocol?: 'v050'
  /** Matching control line observed during a non-durable replay (not applied). */
  observedUnconfirmedEvent?: string
}

/** Bounded alignment facts for a mismatched partition, budget-aware. */
export interface BoundedSource {
  length: number
  sha256: string
  text?: string
  head?: string
  tail?: string
}

/** Typed propose outcomes; `undefined` never hides WHY a proposal failed. */
export type ProposeOutcome =
  | { ok: true; proposal: RebindProposal }
  | {
    ok: false
    reasonCode: 'item_not_found' | 'item_not_pending' | 'unsupported_clarification' | 'partition_mismatch'
      | 'payload_too_large' | 'no_certification_gain'
    /** Bounded alignment facts for partition mismatches, within the 12 KiB budget. */
    source?: BoundedSource
  }

/** Whether the partition changes certification at all: a same-generic split
 * is organizational at best and must not cost a user confirmation. */
function certificationGain(item: GuardItem, candidates: RebindProposal['candidates']): boolean {
  const current = item.semanticAction ?? 'generic_run'
  if (current !== 'generic_run') return true
  return candidates.some((candidate) => candidate.action !== undefined && candidate.action !== 'generic_run')
}

function preservesIdentity(old: GuardItem, clarified: GuardItem): boolean {
  // Explicit identities in the original contract cannot be changed by a
  // mapping confirmation. A fresh root instruction supplies previously absent
  // action/target detail; the proposal alone never supplies it.
  const keys = Object.entries(old.requestedTarget ?? {}).filter(([key]) => key !== 'scope')
  const unwrap = (value: unknown) => JSON.stringify(value && typeof value === 'object' && 'v' in value ? value.v : value)
  return keys.every(([key, value]) => unwrap(value) === unwrap(clarified.requestedTarget?.[key]))
    && (!old.verification.method || old.verification.method === clarified.verification.method)
    && (old.verification.surface !== 'artifact' || old.verification.subject === clarified.verification.subject)
}

function validateProposalShape(item: GuardItem | undefined, args: RebindArgs): ProposeOutcome | undefined {
  const clauses = args.clauses
  const clarificationItemIds = args.clarification_item_ids ?? []
  if (!item) return { ok: false, reasonCode: 'item_not_found' }
  if (item.status !== 'pending') return { ok: false, reasonCode: 'item_not_pending' }
  if (item.kind === 'prohibition' || !item.authority || item.authority === 'legacy_authority_unclassified') {
    return { ok: false, reasonCode: 'unsupported_clarification' }
  }
  if (!Array.isArray(clauses) || clauses.length < 1 || clauses.length > 8
    || clauses.some(s => typeof s !== 'string' || !s.trim() || s.length > 2048)) {
    return { ok: false, reasonCode: 'partition_mismatch' }
  }
  if (clauses.join('') !== item.normalizedText) {
    const source = boundedSource(item.normalizedText)
    return { ok: false, reasonCode: 'partition_mismatch', ...(source ? { source } : {}) }
  }
  if ((clarificationItemIds.length !== 0 && clarificationItemIds.length !== clauses.length)
    || new Set(clarificationItemIds.filter(Boolean)).size !== clarificationItemIds.filter(Boolean).length) {
    return { ok: false, reasonCode: 'partition_mismatch' }
  }
  return undefined
}

/** Exact source partition is deliberately conservative: a proposal cannot
 * invent authority or silently discard a difficult acceptance clause. */
export function proposeRebind(p: GuardProjection, args: RebindArgs): RebindProposal | undefined {
  const outcome = proposeRebindOutcome(p, args)
  return outcome.ok ? outcome.proposal : undefined
}

/** 0.5 proposer with typed failures and the no-certification-gain gate. */
export function proposeRebindOutcome(p: GuardProjection, args: RebindArgs): ProposeOutcome {
  const item = p.items.get(args.item_id ?? '')
  const clarificationItemIds = args.clarification_item_ids ?? []
  const shape = validateProposalShape(item, args)
  if (shape) return shape
  for (const [index, id] of clarificationItemIds.entries()) {
    if (!id) continue
    const clarified = p.items.get(id)
    const clause = args.clauses![index]
    if (!clarified || clarified.id === item!.id || clarified.status !== 'pending' || clarified.reboundFrom
      || clarified.revision <= item!.revision || clarified.sourceMessageId === item!.sourceMessageId
      || clarified.authority !== 'root_instruction' || clarified.legacyFlags?.length
      || clarified.kind !== item!.kind || !clarified.normalizedText.includes(clause.trim())
      || !preservesIdentity(item!, clarified)
      || (/GUI|界面|视觉|截图|颜色|效果|布局/i.test(clause) && clarified.semanticAction !== 'generic_run')) {
      return { ok: false, reasonCode: 'unsupported_clarification' }
    }
  }
  const candidates = buildCandidates(p, item!, args.clauses!, clarificationItemIds)
  if (!certificationGain(item!, candidates)) {
    // Splitting one generic_run into identical generic_run parts costs a
    // confirmation and buys no certification; refuse instead of proposing.
    return { ok: false, reasonCode: 'no_certification_gain' }
  }
  const body = proposalBody(p, item!, args.clauses!, clarificationItemIds, candidates)
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 8192) return { ok: false, reasonCode: 'payload_too_large' }
  const digest = sha256(JSON.stringify(body))
  const normalized = JSON.parse(JSON.stringify(body)) as typeof body
  return { ok: true, proposal: { id: `RB-${digest.slice(0, 24)}`, digest, ...normalized, status: 'pending', protocol: 'v050' } }
}

function buildCandidates(p: GuardProjection, item: GuardItem, clauses: string[], clarificationItemIds: string[]): RebindProposal['candidates'] {
  return clauses.map((clause, index) => {
    const root = p.items.get(clarificationItemIds[index] ?? '')
    const captured = root ?? captureItem(item.kind, clause, item.sourceMessageId, 'candidate', item.revision,
      item.verification.subject ?? 'scope', item.verification.surface === 'artifact' ? 'artifact' : 'scope',
      item.verification.method, item.verification.operation)
    return { sourceText: clause, action: root || captured.semanticAction === item.semanticAction ? captured.semanticAction : 'generic_run' as const,
      requestedTarget: captured.requestedTarget, acceptance: root ? root.verification : item.verification,
      sourceMessageId: captured.sourceMessageId, rootItemId: root?.id ?? null, rootRevision: root?.revision ?? null }
  })
}

function proposalBody(p: GuardProjection, item: GuardItem, clauses: string[], clarificationItemIds: string[], candidates: RebindProposal['candidates']) {
  return { session: p.sessionRefDigest, epoch: p.epoch, contractRevision: p.contractRevision,
    itemId: item.id, itemRevision: item.revision, sourceMessageId: item.sourceMessageId, originalText: item.normalizedText, clauses, clarificationItemIds, candidates }
}

/** Bounded alignment facts for a mismatched partition, budget-aware. */
function boundedSource(text: string): BoundedSource {
  const sha = sha256(text)
  if (Buffer.byteLength(text, 'utf8') <= 4096) return { length: text.length, sha256: sha, text }
  return { length: text.length, sha256: sha, head: text.slice(0, 200), tail: text.slice(-200) }
}

/**
 * Frozen v0.4.2/v0.4.3 proposer: identical semantics to the 0.4 releases,
 * without the 0.5 no-gain gate or typed failures. Used ONLY to replay
 * historical tool results and historical confirmations faithfully.
 */
export function proposeRebindV042(p: GuardProjection, args: RebindArgs): RebindProposal | undefined {
  const item = p.items.get(args.item_id ?? '')
  const clarificationItemIds = args.clarification_item_ids ?? []
  const shape = validateProposalShape(item, args)
  if (shape) return undefined
  for (const [index, id] of clarificationItemIds.entries()) {
    if (!id) continue
    const clarified = p.items.get(id)
    const clause = args.clauses![index]
    if (!clarified || clarified.id === item!.id || clarified.status !== 'pending' || clarified.reboundFrom
      || clarified.revision <= item!.revision || clarified.sourceMessageId === item!.sourceMessageId
      || clarified.authority !== 'root_instruction' || clarified.legacyFlags?.length
      || clarified.kind !== item!.kind || !clarified.normalizedText.includes(clause.trim())
      || !preservesIdentity(item!, clarified)
      || (/GUI|界面|视觉|截图|颜色|效果|布局/i.test(clause) && clarified.semanticAction !== 'generic_run')) return undefined
  }
  const candidates = buildCandidates(p, item!, args.clauses!, clarificationItemIds)
  const body = proposalBody(p, item!, args.clauses!, clarificationItemIds, candidates)
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 8192) return undefined
  const digest = sha256(JSON.stringify(body))
  const normalized = JSON.parse(JSON.stringify(body)) as typeof body
  return { id: `RB-${digest.slice(0, 24)}`, digest, ...normalized, status: 'pending' }
}

/** The exact 0.4-era propose response, frozen for legacy replay validation. */
function frozenV042ProposeResponse(p: GuardProjection, args: RebindArgs): Record<string, unknown> | undefined {
  const candidate = proposeRebindV042(p, args)
  if (!candidate) {
    return { status: 'rejected', reason_code: 'source_partition_required', next_step: 'Supply 1-8 exact consecutive clauses covering the original text, including unsupported work; the proposal must fit 8 KiB. Clarification that changes meaning requires a new root-user instruction.' }
  }
  const existing = p.rebindProposals.get(candidate.id)
  return { status: 'proposed', proposal: existing ?? candidate,
    next_step: `Root user must reply exactly: 确认重绑定 ${candidate.id}. This changes the contract only and grants no execution permission.` }
}

/** Structured v0.5 replay match: semantic fields exact, display text exempt. */
function rebindResponseMatchesV050(expected: Record<string, unknown>, recorded: unknown): boolean {
  if (!recorded || typeof recorded !== 'object' || Array.isArray(recorded)) return false
  const strip = (value: unknown) => {
    const { next_step: _display, ...rest } = value as Record<string, unknown>
    return rest
  }
  return JSON.stringify(strip(expected)) === JSON.stringify(strip(recorded))
}

/** The 0.4-era query/withdraw responses, frozen for legacy replay validation. */
function frozenV042Response(p: GuardProjection, args: RebindArgs): Record<string, unknown> | undefined {
  if (args.operation === 'propose') return frozenV042ProposeResponse(p, args)
  const proposal = p.rebindProposals.get(args.proposal_id ?? '')
  if (!proposal) return { status: 'rejected', reason_code: 'proposal_not_found' }
  if (args.operation === 'withdraw') return proposal.status === 'confirmed'
    ? { status: 'rejected', reason_code: 'proposal_already_applied' }
    : { status: 'withdrawn', proposal_id: proposal.id, digest: proposal.digest }
  if (args.operation !== 'query') return { status: 'rejected', reason_code: 'invalid_rebind_operation' }
  const stale = proposal.status === 'pending' && (proposal.contractRevision !== p.contractRevision || proposal.epoch !== p.epoch || proposal.session !== p.sessionRefDigest)
  return stale
    ? { status: 'stale', reason_code: 'proposal_contract_changed', proposal: { ...proposal, status: 'stale' }, next_step: 'Propose again against the current contract.' }
    : { status: proposal.status, proposal }
}

function proposalConfirmation(p: GuardProjection, proposal: RebindProposal): Record<string, unknown> {
  if (proposal.status === 'confirmed') {
    return { state: 'confirmed', event: proposal.confirmationEvent, replacement_ids: proposal.replacementIds }
  }
  if (proposal.status === 'pending' && proposal.observedUnconfirmedEvent) {
    // A matching control line was seen at replay but the log was not durable
    // then: "delayed persistence" stays distinguishable from "never sent".
    return { state: 'not_durable', event: proposal.observedUnconfirmedEvent }
  }
  return { state: 'not_received' }
}

/** Stable attempt key: item identity, exact inputs, and outcome class. Identical
 * retries collapse onto it no matter how many unrelated log rows intervene. */
export function rebindAttemptKey(args: RebindArgs, reasonCode: string): string {
  return sha256(JSON.stringify([args.item_id ?? null, args.clauses ?? null, args.clarification_item_ids ?? null, reasonCode]))
}

export function rebindResponse(p: GuardProjection, args: RebindArgs): Record<string, unknown> {
  if (!p.enabled || p.integrity !== 'valid') return { status: 'unknown', reason_code: 'guard_unavailable' }
  if (Object.keys(args).some(key => !['operation', 'item_id', 'proposal_id', 'clauses', 'clarification_item_ids'].includes(key))) return { status: 'rejected', reason_code: 'invalid_rebind_parameters' }
  if (args.operation === 'propose') {
    const outcome = proposeRebindOutcome(p, args)
    if (!outcome.ok) {
      // Retry budget: an identical rejected attempt already in the log returns
      // a stable `unchanged` diagnosis instead of a fresh rejection round.
      const key = rebindAttemptKey(args, outcome.reasonCode)
      if ((p.rebindRejections.get(key) ?? 0) > 0) {
        return {
          status: 'unchanged',
          reason_code: outcome.reasonCode,
          resume_condition: 'No input changed since the previous identical attempt. New related evidence, a new root instruction, or a changed target re-opens evaluation.',
        }
      }
      const response: Record<string, unknown> = { status: 'rejected', reason_code: outcome.reasonCode }
      if (outcome.source) response.expected_source = outcome.source
      response.next_step = proposeNextStep(outcome.reasonCode)
      return response
    }
    const candidate = outcome.proposal
    const existing = p.rebindProposals.get(candidate.id)
    return { status: 'proposed', proposal: existing ?? candidate,
      next_step: `Root user must reply with the control line 确认重绑定 ${candidate.id} alone on its first line. Follow-up requests or new tasks may follow after a blank line and keep their own meaning; confirmation adds no execution permission.` }
  }
  if (args.operation === 'query' && !args.proposal_id && args.item_id) {
    // Item lookup: repair facts for an item without knowing a proposal ID.
    const item = p.items.get(args.item_id)
    if (!item) return { status: 'rejected', reason_code: 'item_not_found' }
    if (item.status !== 'pending') return { status: 'rejected', reason_code: 'item_not_pending', item_id: item.id, item_status: item.status }
    const pendingProposal = [...p.rebindProposals.values()].find((candidate) =>
      candidate.status === 'pending' && candidate.itemId === item.id
      && candidate.contractRevision === p.contractRevision && candidate.epoch === p.epoch)
    return {
      status: 'item_status',
      item: { id: item.id, revision: item.revision, kind: item.kind, status: item.status,
        semantic_action: item.semanticAction, target_capture_status: item.targetCaptureStatus },
      diagnosis: deriveItemDiagnosis(p, item),
      pending_proposal_id: pendingProposal?.id,
    }
  }
  const proposal = p.rebindProposals.get(args.proposal_id ?? '')
  if (!proposal) return { status: 'rejected', reason_code: 'proposal_not_found' }
  if (args.operation === 'withdraw') return proposal.status === 'confirmed'
    ? { status: 'rejected', reason_code: 'proposal_already_applied' }
    : { status: 'withdrawn', proposal_id: proposal.id, digest: proposal.digest }
  if (args.operation !== 'query') return { status: 'rejected', reason_code: 'invalid_rebind_operation' }
  const stale = proposal.status === 'pending' && (proposal.contractRevision !== p.contractRevision || proposal.epoch !== p.epoch || proposal.session !== p.sessionRefDigest)
  if (stale) {
    return { status: 'stale', reason_code: 'proposal_contract_changed', proposal: { ...proposal, status: 'stale' }, confirmation: { state: 'not_received' }, next_step: 'Propose again against the current contract; unrelated new work makes the old proposal stale.' }
  }
  return { status: proposal.status, proposal, confirmation: proposalConfirmation(p, proposal) }
}

function proposeNextStep(reasonCode: string): string {
  switch (reasonCode) {
    case 'no_certification_gain':
      return 'No certification gain: this split keeps every part generic_run. Report the work honestly instead of asking the user to confirm a relabeled proposal; a real scope change needs a new root-user instruction.'
    case 'partition_mismatch':
      return 'The clauses do not exactly cover the original text. Copy the expected source verbatim (see expected_source) and re-partition without changing any character.'
    case 'payload_too_large':
      return 'The proposal exceeds 8 KiB. Split into smaller independent proposals.'
    case 'unsupported_clarification':
      return 'This item cannot be re-bound by proposal: it needs a fresh root-user instruction or is not a re-bindable requirement.'
    case 'item_not_pending':
      return 'The item is not pending; query the checkpoint page for its current state.'
    default:
      return 'Unknown item: query context_guard_checkpoint for the current contract items.'
  }
}

/**
 * Replay validation with version dispatch (A12): structured v0.5 results
 * match semantically (display text may evolve); results carrying the frozen
 * 0.4 response shapes validate against the frozen 0.4 rules exactly. Anything
 * else is tampered or unknown and never replays.
 */
export function replayRebindResult(p: GuardProjection, args: RebindArgs, recorded: Record<string, unknown>): void {
  const expected = rebindResponse(p, args)
  const legacy = isFrozenV042RebindResponse(recorded)
    && (() => {
      const frozen = frozenV042Response(p, args)
      return frozen !== undefined && JSON.stringify(frozen) === JSON.stringify(recorded)
    })()
  if (!legacy && !rebindResponseMatchesV050(expected, recorded)) return
  if (args.operation === 'propose') {
    const proposal = p.rebindProposals.get(String((recorded as { proposal?: { id?: unknown } }).proposal?.id ?? ''))
    if (proposal) return
    // Legacy results re-propose under the frozen 0.4 rules so the replayed
    // proposal keeps its exact historical shape (no 0.5-only fields).
    const rebuilt = legacy ? proposeRebindV042(p, args) : (() => {
      const outcome = proposeRebindOutcome(p, args)
      return outcome.ok ? outcome.proposal : undefined
    })()
    if (rebuilt) p.rebindProposals.set(rebuilt.id, rebuilt)
    return
  }
  if (args.operation === 'withdraw') {
    const proposal = p.rebindProposals.get(args.proposal_id ?? '')
    if (proposal?.status === 'pending') proposal.status = 'withdrawn'
  }
}

/** Register an observed but not-yet-applied confirmation attempt (non-durable replay). */
function observeUnconfirmed(p: GuardProjection, proposalId: string, eventId: string): void {
  const proposal = p.rebindProposals.get(proposalId)
  if (proposal && proposal.status === 'pending') proposal.observedUnconfirmedEvent = eventId
}

/** Invoked only for a canonical root user message, never tool or plugin text.
 * The single durable confirmation event is the atomic transaction commit:
 * the confirmation validates against the state BEFORE this message, and the
 * caller processes the remaining text afterwards with its own semantics. */
export function confirmRebind(p: GuardProjection, proposalId: string, eventId: string, durable: boolean): boolean {
  if (!/^RB-[a-f0-9]{24}$/.test(proposalId)) return false
  const proposal = p.rebindProposals.get(proposalId)
  if (!proposal) return true
  if (!durable) {
    observeUnconfirmed(p, proposalId, eventId)
    return true
  }
  if (proposal.status !== 'pending') return true
  const old = p.items.get(proposal.itemId)
  // Legacy proposals re-verify under the frozen 0.4 rules so a pre-0.5
  // proposal neither silently stales nor gains 0.5-only semantics.
  const repropose = proposal.protocol === 'v050'
    ? proposeRebindOutcome(p, { operation: 'propose', item_id: old?.id, clauses: proposal.clauses, clarification_item_ids: proposal.clarificationItemIds })
    : (() => {
      const rebuilt = proposeRebindV042(p, { operation: 'propose', item_id: old?.id, clauses: proposal.clauses, clarification_item_ids: proposal.clarificationItemIds })
      return rebuilt ? { ok: true as const, proposal: rebuilt } : { ok: false as const }
    })()
  if (!old || proposal.session !== p.sessionRefDigest || proposal.epoch !== p.epoch
    || old.status !== 'pending' || old.revision !== proposal.itemRevision || p.contractRevision !== proposal.contractRevision
    || !(repropose.ok && repropose.proposal.digest === proposal.digest)) {
    proposal.status = 'stale'
    return true
  }
  // Construct every replacement before touching the ledger. A thrown capture
  // cannot leave half of the old item superseded.
  const revision = p.contractRevision + 1
  const replacements: GuardItem[] = proposal.clauses.map((clause, index) => {
    const clarified = p.items.get(proposal.clarificationItemIds[index] ?? '')
    if (clarified) return { ...clarified, reboundFrom: { itemId: old.id, proposalId: proposal.id, confirmationEvent: eventId } }
    const captured = captureItem(old.kind, clause, old.sourceMessageId, `${old.kind[0].toUpperCase()}:${proposal.id}:${index + 1}`, revision,
      old.verification.subject ?? 'scope', old.verification.surface === 'artifact' ? 'artifact' : 'scope',
      old.verification.method ?? extractMethod(clause), old.verification.operation ?? extractOperation(clause))
    // Partitioning is not a semantic promotion: a newly recognized action
    // needs an independent root clarification, not an arbitrary word split.
    if (captured.semanticAction !== old.semanticAction) captured.semanticAction = 'generic_run'
    return { ...captured, authority: old.authority,
      reboundFrom: { itemId: old.id, proposalId: proposal.id, confirmationEvent: eventId },
      verification: { ...captured.verification, ...old.verification } }
  })
  if (replacements.some(item => p.items.has(item.id) && !proposal.clarificationItemIds.includes(item.id))) { proposal.status = 'stale'; return true }
  for (const item of replacements) p.items.set(item.id, item)
  old.status = 'superseded'
  old.supersededByItems = replacements.map(item => item.id)
  old.supersededBy = replacements[0].id
  p.contractRevision = revision
  proposal.status = 'confirmed'
  proposal.confirmationEvent = eventId
  proposal.replacementIds = old.supersededByItems
  return true
}
