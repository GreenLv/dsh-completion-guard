import { sha256 } from './canonicalize.js'
import { captureItem, extractMethod, extractOperation } from './capture.js'
import type { GuardItem, GuardProjection } from './types.js'

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

/** Exact source partition is deliberately conservative: a proposal cannot
 * invent authority or silently discard a difficult acceptance clause. */
export function proposeRebind(p: GuardProjection, args: RebindArgs): RebindProposal | undefined {
  const item = p.items.get(args.item_id ?? '')
  const clauses = args.clauses
  const clarificationItemIds = args.clarification_item_ids ?? []
  if (!item || item.status !== 'pending' || item.kind === 'prohibition' || !item.authority
    || item.authority === 'legacy_authority_unclassified' || !Array.isArray(clauses)
    || clauses.length < 1 || clauses.length > 8 || clauses.some(s => typeof s !== 'string' || !s.trim() || s.length > 2048)
    || clauses.join('') !== item.normalizedText
    || (clarificationItemIds.length !== 0 && clarificationItemIds.length !== clauses.length)
    || new Set(clarificationItemIds.filter(Boolean)).size !== clarificationItemIds.filter(Boolean).length) return undefined
  for (const [index, id] of clarificationItemIds.entries()) {
    if (!id) continue
    const clarified = p.items.get(id)
    if (!clarified || clarified.id === item.id || clarified.status !== 'pending' || clarified.reboundFrom
      || clarified.revision <= item.revision || clarified.sourceMessageId === item.sourceMessageId
      || clarified.authority !== 'root_instruction' || clarified.legacyFlags?.length
      || clarified.kind !== item.kind || !clarified.normalizedText.includes(clauses[index].trim())
      || !preservesIdentity(item, clarified)
      || (/GUI|界面|视觉|截图|颜色|效果|布局/i.test(clauses[index]) && clarified.semanticAction !== 'generic_run')) return undefined
  }
  const candidates = clauses.map((clause, index) => {
    const root = p.items.get(clarificationItemIds[index] ?? '')
    const captured = root ?? captureItem(item.kind, clause, item.sourceMessageId, 'candidate', item.revision,
      item.verification.subject ?? 'scope', item.verification.surface === 'artifact' ? 'artifact' : 'scope',
      item.verification.method, item.verification.operation)
    return { sourceText: clause, action: root || captured.semanticAction === item.semanticAction ? captured.semanticAction : 'generic_run' as const,
      requestedTarget: captured.requestedTarget, acceptance: root ? root.verification : item.verification,
      sourceMessageId: captured.sourceMessageId, rootItemId: root?.id ?? null, rootRevision: root?.revision ?? null }
  })
  const body = { session: p.sessionRefDigest, epoch: p.epoch, contractRevision: p.contractRevision,
    itemId: item.id, itemRevision: item.revision, sourceMessageId: item.sourceMessageId, originalText: item.normalizedText, clauses, clarificationItemIds, candidates }
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 8192) return undefined
  const digest = sha256(JSON.stringify(body))
  const normalized = JSON.parse(JSON.stringify(body)) as typeof body
  return { id: `RB-${digest.slice(0, 24)}`, digest, ...normalized, status: 'pending' }
}

export function rebindResponse(p: GuardProjection, args: RebindArgs): Record<string, unknown> {
  if (!p.enabled || p.integrity !== 'valid') return { status: 'unknown', reason_code: 'guard_unavailable' }
  if (Object.keys(args).some(key => !['operation', 'item_id', 'proposal_id', 'clauses', 'clarification_item_ids'].includes(key))) return { status: 'rejected', reason_code: 'invalid_rebind_parameters' }
  if (args.operation === 'propose') {
    const candidate = proposeRebind(p, args)
    if (!candidate) return { status: 'rejected', reason_code: 'source_partition_required', next_step: 'Supply 1-8 exact consecutive clauses covering the original text, including unsupported work; the proposal must fit 8 KiB. Clarification that changes meaning requires a new root-user instruction.' }
    const existing = p.rebindProposals.get(candidate.id)
    return { status: 'proposed', proposal: existing ?? candidate,
      next_step: `Root user must reply exactly: 确认重绑定 ${candidate.id}. This changes the contract only and grants no execution permission.` }
  }
  const proposal = p.rebindProposals.get(args.proposal_id ?? '')
  if (!proposal) return { status: 'rejected', reason_code: 'proposal_not_found' }
  if (args.operation === 'withdraw') return proposal.status === 'confirmed'
    ? { status: 'rejected', reason_code: 'proposal_already_applied' }
    : { status: 'withdrawn', proposal_id: proposal.id, digest: proposal.digest }
  if (args.operation !== 'query') return { status: 'rejected', reason_code: 'invalid_rebind_operation' }
  const stale = proposal.status === 'pending' && (proposal.contractRevision !== p.contractRevision || proposal.epoch !== p.epoch || proposal.session !== p.sessionRefDigest)
  return stale ? { status: 'stale', reason_code: 'proposal_contract_changed', proposal: { ...proposal, status: 'stale' }, next_step: 'Propose again against the current contract.' }
    : { status: proposal.status, proposal }
}

export function replayRebindResult(p: GuardProjection, args: RebindArgs, recorded: Record<string, unknown>): void {
  const expected = rebindResponse(p, args)
  if (JSON.stringify(expected) !== JSON.stringify(recorded)) return
  if (args.operation === 'propose') {
    const candidate = proposeRebind(p, args)
    if (candidate && !p.rebindProposals.has(candidate.id)) p.rebindProposals.set(candidate.id, candidate)
  } else if (args.operation === 'withdraw') {
    const proposal = p.rebindProposals.get(args.proposal_id ?? '')
    if (proposal?.status === 'pending') proposal.status = 'withdrawn'
  }
}

/** Invoked only for a canonical root user message, never tool or plugin text.
 * The single durable confirmation event is the atomic transaction commit. */
export function confirmRebind(p: GuardProjection, text: string, eventId: string, durable: boolean): boolean {
  const match = /^确认重绑定 (RB-[a-f0-9]{24})$/.exec(text.trim())
  if (!match) return false
  const proposal = p.rebindProposals.get(match[1])
  if (!proposal || !durable) return true
  if (proposal.status !== 'pending') return true
  const old = p.items.get(proposal.itemId)
  if (!old || proposal.session !== p.sessionRefDigest || proposal.epoch !== p.epoch
    || old.status !== 'pending' || old.revision !== proposal.itemRevision || p.contractRevision !== proposal.contractRevision
    || proposeRebind(p, { operation: 'propose', item_id: old.id, clauses: proposal.clauses, clarification_item_ids: proposal.clarificationItemIds })?.digest !== proposal.digest) {
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
