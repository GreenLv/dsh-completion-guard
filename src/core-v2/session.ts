import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import type { GuardProjection, DerivedEnvelope, GuardItem } from '../domain/types.js'
import { assessmentAction, assessmentOutcomePredicate, currentActionBases, testOutcomePredicate } from '../domain/stop-policy.js'
import { projectCoreV2 } from './project.js'

const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')
const isResume = (text: string): boolean => /^(?:请)?(?:继续|接着做|继续执行|go on|continue|proceed)[。.!！\s]*$/i.test(text.trim())
const row = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}
const rootText = (event: DerivedEnvelope): string => {
  const data = row(event.data)
  return Array.isArray(data.content) ? data.content.filter((part) => row(part).type === 'text').map((part) => String(row(part).text ?? '')).join('') : ''
}
const sourceSeq = (item: GuardItem): number | undefined => {
  const match = /^m(\d+)(?::|$)/.exec(item.sourceMessageId)
  return match ? Number(match[1]) : undefined
}
const targetOf = (item: GuardItem): string | undefined => {
  if (item.taskKind === 'inquiry' || item.authorityDisposition === 'informational') return item.normalizedText
  const tuple = item.requestedTarget ?? {}
  return typeof tuple.artifact_id === 'string' ? tuple.artifact_id
    : typeof tuple.repository === 'string' ? tuple.repository
    : typeof item.verification.subject === 'string' ? item.verification.subject
    : typeof tuple.scope === 'string' ? tuple.scope : undefined
}
const kindOf = (item: GuardItem): 'information' | 'execution' | 'constraint' | 'unknown' | 'proof' => {
  if (item.kind === 'prohibition') return 'constraint'
  if (item.taskKind === 'context') return 'unknown'
  if (item.taskKind === 'inquiry' || item.authorityDisposition === 'informational') return 'information'
  if (item.needsReview || item.semanticAction === 'generic_run') return 'unknown'
  if (item.verification.surface === 'visual') return 'proof'
  if (item.semanticAction && ['executable_now', 'conditional_wait'].includes(item.authorityDisposition ?? '')) return 'execution'
  if (item.verification.surface === 'scope') return 'proof'
  return 'execution'
}
const sourceSpan = (item: GuardItem, text: string, peers: GuardItem[]): { start: number; end: number } | undefined => {
  const own = item.spans?.find((part) => part.partIndex === 0)
  if (!own) return undefined
  const bytes = Buffer.from(text, 'utf8')
  let end = own.end
  const next = peers.flatMap((peer) => peer.spans ?? []).filter((part) => part.partIndex === 0 && part.start >= end)
    .sort((a,b) => a.start-b.start)[0]
  if (next && /^[\s，,。.!！?？;；:：]*$/u.test(bytes.subarray(end, next.start).toString('utf8'))) end = next.start
  // A terminal delimiter belongs to the preceding speech act. It carries no
  // separate requirement and cannot turn a fully parsed sentence into unknown.
  if (/^[\s，,。.!！?？;；:：]*$/u.test(bytes.subarray(end).toString('utf8'))) end = bytes.length
  return { start: own.start, end }
}

/** Convert only real session sources and derived facts. Missing spans, calls, or
 * readback remain unknown/insufficient; this adapter never fabricates them. */
export function sessionCoreSnapshot(events: DerivedEnvelope[], projection: GuardProjection): Record<string, unknown> | undefined {
  const unit = projection.currentUnitId
  if (projection.boundaryProtocol !== 6 || !unit || projection.durabilityWatermark !== 'confirmed') return undefined
  const roots = events.filter((event) => event.type === 'user/message' && row(row(event.data).source).kind === 'user')
  const currentItems = [...projection.items.values()].filter((item) => item.unitId === unit && item.status !== 'superseded')
  const refs = new Set(projection.units.get(unit)?.rootInputRefs.map((ref) => ref.seq) ?? [])
  const usedRoots = roots.filter((event) => refs.has(event.seq))
  if (!usedRoots.length) return undefined
  const latestRoot = usedRoots.at(-1)!
  const turn = String(row(latestRoot.data).turn ?? projection.hostTurn ?? 1)
  const rootBySeq = new Map(usedRoots.map((root) => [root.seq, root]))
  if (!currentItems.every((item) => {
    const root = rootBySeq.get(sourceSeq(item) ?? -1)
    return root && item.rawTextSha256 === hash(rootText(root))
  })) return undefined
  const sources: Array<Record<string, unknown>> = usedRoots.map((root) => {
    const text = rootText(root)
    return { id: `root:${root.seq}`, seq: root.seq, kind: 'root', unit, revision: 1, sha256: hash(text),
      byte_length: Buffer.byteLength(text, 'utf8'), text, call_id: null, turn: String(row(root.data).turn ?? turn),
      ...(projection.rootLocatorContexts.get(root.seq) ? { locator_base: projection.rootLocatorContexts.get(root.seq)!.base,
        locator_flavor: 'posix' } : {}) }
  })
  const requirements: Array<Record<string, unknown>> = []
  const facts: Array<Record<string, unknown>> = []
  const actions: Array<Record<string, unknown>> = []
  const conditions: Array<Record<string, unknown>> = []
  const coverage: Array<Record<string, unknown>> = []
  for (const root of usedRoots) {
    const text = rootText(root), digest = hash(text), byteLength = Buffer.byteLength(text, 'utf8')
    const span = (start: number, end: number) => ({ source_id: `root:${root.seq}`, start, end, sha256: digest })
    const sortedSpans = currentItems.filter((item) => sourceSeq(item) === root.seq)
      .flatMap((item) => { const own = sourceSpan(item, text, currentItems.filter((peer) => sourceSeq(peer) === root.seq)); return own ? [own] : [] }).sort((a,b) => a.start-b.start || a.end-b.end)
    let cursor = 0
    for (const s of sortedSpans) {
      if (s.start > cursor) coverage.push({ source: span(cursor, s.start), kind: 'unknown' })
      if (s.end > Math.max(cursor, s.start)) coverage.push({ source: span(Math.max(cursor,s.start), s.end), kind: 'interpreted' })
      cursor = Math.max(cursor, s.end)
    }
    if (sortedSpans.length && cursor < byteLength) coverage.push({ source: span(cursor, byteLength), kind: 'unknown' })
    if (!sortedSpans.length && byteLength) {
      if (isResume(text)) {
        coverage.push({ source: span(0, byteLength), kind: 'interpreted' })
        requirements.push({ id: `intent:${root.seq}`, unit, revision: 1, seq: root.seq, source: span(0, byteLength),
          kind: 'unknown', action: 'resume_control', target: text, predicate: 'intent_observed', scope_sha256: digest,
          required: false, status: 'pending', parent_id: null, evidence_kind: 'none', condition_ids: [],
          target_origin: { root_constraint: text, root_constraint_source: span(0, byteLength), implementation_choice: text,
            host_selection: text, resolved: text, observed: text, constraint_kind: 'exact', subject_kind: 'opaque', selection_source_id: null } })
      } else coverage.push({ source: span(0, byteLength), kind: 'unknown' })
    }
  }
  const sourceByCall = new Map<string, { call: DerivedEnvelope; result: DerivedEnvelope }>()
  const calls = new Map<string, DerivedEnvelope[]>()
  const results = new Map<string, DerivedEnvelope[]>()
  for (const event of events) {
    if (event.type === 'tool/call') {
      const id = row(event.data).callId
      if (typeof id === 'string') calls.set(id, [...(calls.get(id) ?? []), event])
    }
    if (event.type === 'tool/result') {
      const source = row(row(row(event.data).message).source)
      if (source.kind !== 'tool' || typeof source.callId !== 'string') continue
      results.set(source.callId, [...(results.get(source.callId) ?? []), event])
    }
  }
  for (const [id, callRows] of calls) {
    const resultRows = results.get(id)
    if (callRows.length !== 1 || resultRows?.length !== 1) continue
    const call = callRows[0]!, result = resultRows[0]!
    if (call.seq >= result.seq || row(call.data).turn !== row(result.data).turn
      || row(call.data).step !== row(result.data).step) continue
    sourceByCall.set(id, { call, result })
  }
  const attached = new Set<string>()
  for (const item of currentItems) {
    const root = rootBySeq.get(sourceSeq(item) ?? -1)
    if (!root) continue
    const text = rootText(root), digest = hash(text)
    const span = (start: number, end: number) => ({ source_id: `root:${root.seq}`, start, end, sha256: digest })
    const itemSpan = sourceSpan(item, text, currentItems.filter((peer) => sourceSeq(peer) === root.seq))
    if (!itemSpan) continue
    const kind = kindOf(item)
    const named = targetOf(item)
    const raw = Buffer.from(text, 'utf8')
    const namedBytes = named ? Buffer.from(named, 'utf8') : undefined
    const atWithin = namedBytes ? raw.subarray(itemSpan.start, itemSpan.end).indexOf(namedBytes) : -1
    const at = atWithin >= 0 ? itemSpan.start + atWithin : -1
    const ownText = raw.subarray(itemSpan.start, itemSpan.end).toString('utf8')
    const fileReadback = item.interpretationFingerprint?.startsWith('v6-file-readback:') === true
    // A prohibition's own source stays on the forbidden speech act. A single
    // earlier context mention can supply its file referent through a separate
    // root path span; competing mentions never become an invented identity.
    const referents = kind === 'constraint' ? currentItems.flatMap((candidate) => {
      if (candidate.taskKind !== 'context' || sourceSeq(candidate) !== root.seq) return []
      const own = sourceSpan(candidate, text, currentItems.filter((peer) => sourceSeq(peer) === root.seq))
      const path = candidate.requestedTarget?.artifact_id
      const base = projection.rootLocatorContexts.get(root.seq)?.base
      if (!own || own.end > itemSpan.start || typeof path !== 'string' || !base || !path.startsWith(`${base}/`)) return []
      const literal = relative(base, path)
      if (!literal || literal.startsWith('../') || literal.includes('\\')) return []
      const offset = raw.subarray(own.start, own.end).indexOf(Buffer.from(literal, 'utf8'))
      return offset < 0 ? [] : [{ path, literal, start: own.start + offset, end: own.start + offset + Buffer.byteLength(literal, 'utf8') }]
    }) : []
    const forbiddenFile = item.semanticAction === 'generic_run' && referents.length === 1 ? referents[0] : undefined
    const ambiguousForbiddenFile = item.semanticAction === 'generic_run' && referents.length > 1
    const directoryMatch = /(?:在\s+)?([^\s，,。.!?？]+)\s+范围内/u.exec(ownText)
    const directoryLiteral = directoryMatch?.[1]
    const directoryAt = directoryLiteral ? itemSpan.start + raw.subarray(itemSpan.start, itemSpan.end).indexOf(Buffer.from(directoryLiteral, 'utf8')) : -1
    // A relative path remains a literal root constraint. A matched native
    // effect selects the absolute implementation target; the host call and
    // resulting fact, rather than cwd inference, establish that choice.
    const rootBase = projection.rootLocatorContexts.get(root.seq)?.base
    const relativeName = rootBase && named?.startsWith(`${rootBase}/`) ? relative(rootBase, named) : undefined
    const relativePaths = relativeName && !relativeName.startsWith('../') && ownText.includes(relativeName) ? [relativeName] : []
    const relativeLiteral = at < 0 && named && item.semanticAction === 'modify'
      ? relativePaths.find((literal) => named.endsWith(`/${literal}`)) : undefined
    const relativeAt = relativeLiteral ? itemSpan.start + raw.subarray(itemSpan.start, itemSpan.end).indexOf(Buffer.from(relativeLiteral, 'utf8')) : -1
    const scopeValue = typeof item.requestedTarget?.scope === 'string' ? item.requestedTarget.scope
      : typeof item.requestedTarget?.artifact_id === 'string' ? item.requestedTarget.artifact_id : undefined
    const editScope = directoryLiteral && scopeValue ? resolve(scopeValue, directoryLiteral) : scopeValue
    const editChoices = item.semanticAction === 'modify' && (!item.requestedTarget?.artifact_id || directoryLiteral) && typeof editScope === 'string'
      ? [...projection.evidence.values()].filter((fact) => fact.semanticAction === 'modify' && fact.evidenceRole === 'effect'
        && fact.outcome === 'success' && fact.toolResultSeq > root.seq && (sourceByCall.get(fact.callId)?.call.seq ?? -1) > root.seq
        && fact.subjects.length === 1 && typeof fact.subjects[0] === 'string'
        && fact.subjects[0].startsWith(`${editScope.replace(/\/$/u, '')}/`)) : []
    const selectedEdit = editChoices.length === 1 ? editChoices[0] : undefined
    const readbackChoices = fileReadback ? [...projection.evidence.values()].filter((fact) =>
      fact.evidenceRole === 'state' && fact.toolName === 'context_guard_observe_file' && fact.outcome === 'success'
      && fact.toolResultSeq > root.seq && fact.subjects.length === 1 && (sourceByCall.get(fact.callId)?.call.seq ?? -1) > root.seq
      && [...projection.evidence.values()].some((effect) => effect.callId === fact.causedByCallId
        && effect.semanticAction === 'modify' && effect.evidenceRole === 'effect' && effect.outcome === 'success'
        && effect.subjects.includes(fact.subjects[0]!) && effect.toolResultSeq < fact.toolResultSeq)) : []
    const selectedReadback = readbackChoices.length === 1 ? readbackChoices[0] : undefined
    const subjectKind = forbiddenFile || fileReadback || ['modify','create','commit','push'].includes(item.semanticAction ?? '') ? 'filesystem' : 'opaque'
    const trimmed = ownText.trim()
    const guarded = Boolean(item.condition || item.waitAuthorization || item.authorityDisposition === 'conditional_wait')
    const leading = Buffer.byteLength(ownText.slice(0, ownText.indexOf(trimmed)), 'utf8')
    const ownConstraintSpan = { start: itemSpan.start + leading, end: itemSpan.start + leading + Buffer.byteLength(trimmed, 'utf8') }
    const constraintSpan = at >= 0 && namedBytes ? { start: at, end: at + namedBytes.length }
      : ownConstraintSpan
    const needsReadiness = item.semanticAction === 'test' || (item.semanticAction === 'verify' && !fileReadback)
    const readinessPredicate = item.semanticAction === 'test' ? 'test_passed' : 'verification_passed'
    const selectedReadiness = needsReadiness && !guarded ? [...projection.evidence.values()].find((fact) => {
      const pair = sourceByCall.get(fact.callId)
      const assessmentEffect = item.semanticAction !== 'verify'
        || (!fact.readinessEffectCallId && fact.readinessInputSha256 === fact.readinessManifestSha256)
        || [...projection.evidence.values()].some((effect) =>
        effect.callId === fact.readinessEffectCallId && effect.toolResultSeq < fact.toolResultSeq
        && effect.epoch === fact.epoch && effect.outcome === 'success' && effect.parseStatus === 'supported'
        && effect.semanticAction === 'modify' && effect.evidenceRole === 'effect'
        && effect.operations?.some((operation) => operation.op === 'modify' && operation.path === fact.readinessSelectedPath))
      return fact.readinessForItemId === item.id && fact.readinessPredicate === readinessPredicate && assessmentEffect
        && fact.toolName === 'context_guard_observe_test_readiness' && fact.outcome === 'success'
        && fact.epoch === projection.epoch && pair?.result.seq === fact.toolResultSeq
        && pair.call.seq > root.seq && typeof item.requestedTarget?.scope === 'string'
        && fact.subjects.includes(item.requestedTarget.scope)
    }) : undefined
    const selectedScope = selectedReadiness && typeof item.requestedTarget?.scope === 'string' ? item.requestedTarget.scope : undefined
    const target = forbiddenFile?.path ?? selectedScope ?? selectedEdit?.subjects[0] ?? selectedReadback?.subjects[0] ?? (relativeLiteral && named ? named : at >= 0 && named ? named : trimmed)
    if (!target) continue
    const knownForbiddenEffect = forbiddenFile && [...projection.evidence.values()].some((fact) =>
      fact.epoch === projection.epoch && fact.toolResultSeq > root.seq && (sourceByCall.get(fact.callId)?.call.seq ?? -1) > root.seq
      && fact.evidenceRole === 'effect' && fact.outcome === 'success' && fact.subjects.includes(target)
      && ['write','write_file','edit','edit_file'].includes(fact.toolName)
      && fact.operations?.some((operation) => ['create','modify'].includes(operation.op) && operation.path === target))
    const uncertainForbiddenEffect = forbiddenFile && !knownForbiddenEffect && [...projection.evidence.values()].some((fact) =>
      fact.epoch === projection.epoch && fact.toolResultSeq > root.seq && (sourceByCall.get(fact.callId)?.call.seq ?? -1) > root.seq
      && fact.evidenceRole === 'effect' && fact.subjects.includes(target)
      && (['write','write_file','edit','edit_file'].includes(fact.toolName)
        || (['bash','pwsh','shell'].includes(fact.toolName)
          && !fact.operations?.some((operation) => operation.op === 'read' && operation.path === target))))
    const unattributedHostCall = forbiddenFile && !knownForbiddenEffect && [...sourceByCall.values()].some(({ call }) => {
      if (call.seq <= root.seq || !['bash','pwsh','shell'].includes(String(row(call.data).name))) return false
      const args = row(call.data).arguments
      // The command bytes show a possible same-target effect, but this shell
      // shape has no deterministic mutation attribution. It cannot certify
      // either a violation or compliance with the prohibition.
      return typeof args === 'string' && args.includes(target)
    })
    const permittedFileTargets = new Set(currentItems.filter((candidate) => candidate.kind !== 'prohibition'
      && ['modify','create'].includes(candidate.semanticAction ?? '')
      && typeof candidate.requestedTarget?.artifact_id === 'string')
      .map((candidate) => candidate.requestedTarget!.artifact_id as string))
    const unresolvedPhysicalAlias = forbiddenFile && !knownForbiddenEffect && [...projection.evidence.values()].some((fact) =>
      fact.epoch === projection.epoch && (sourceByCall.get(fact.callId)?.call.seq ?? -1) > root.seq
      && fact.evidenceRole === 'effect' && ['write','write_file','edit','edit_file'].includes(fact.toolName)
      && fact.subjects.some((path) => path !== target && !permittedFileTargets.has(path)))
    const requirementSource = span(itemSpan.start, itemSpan.end)
    const predicate = forbiddenFile ? 'no_mutation' : item.taskKind === 'context' ? 'context_recorded'
      : kind === 'information' ? 'answer_delivered'
      : item.semanticAction === 'test' ? testOutcomePredicate(item.normalizedText)
      : fileReadback ? 'file_content_checked'
      : item.semanticAction === 'verify' ? assessmentOutcomePredicate(item.normalizedText)
      : item.semanticAction === 'modify' ? 'file_modified'
      : item.semanticAction === 'create' ? 'file_created'
      : item.semanticAction === 'commit' ? 'commit_observed'
      : item.semanticAction === 'push' ? 'push_observed' : `${item.semanticAction ?? 'unknown'}_observed`
    const evidenceKind = kind === 'information' ? 'delivery' : kind === 'constraint' || kind === 'unknown' ? 'none'
      : fileReadback ? 'state_outcome'
      : item.semanticAction === 'test' || item.semanticAction === 'verify' ? 'action_event' : 'state_outcome'
    const conditionId = guarded ? `condition:${item.id}` : undefined
    if (conditionId) conditions.push({ id: conditionId, requirement_id: item.id, source: requirementSource,
      kind: item.waitAuthorization || /(?:确认|审批|批准|许可|approval|confirmation|permission)/iu.test(item.condition ?? '') ? 'user_input' : 'predicate',
      status: 'pending', operation_id: null, fact_ids: [] })
    requirements.push({ id: item.id, unit, revision: 1, seq: root.seq, source: requirementSource,
      kind, action: item.taskKind === 'context' ? 'reported_context' : kind === 'information' ? 'answer' : item.semanticAction === 'test' ? 'test_verify' : fileReadback ? 'readback' : item.semanticAction === 'verify' ? assessmentAction(item.normalizedText) : item.semanticAction ?? 'unknown', target, predicate, scope_sha256: digest, required: item.taskKind !== 'context',
      status: item.needsReview || ambiguousForbiddenFile || uncertainForbiddenEffect || unattributedHostCall || unresolvedPhysicalAlias ? 'legacy_review' : item.status === 'pending' ? 'pending' : 'satisfied', parent_id: null,
      evidence_kind: evidenceKind, condition_ids: conditionId ? [conditionId] : [], target_origin: { root_constraint: forbiddenFile?.literal ?? directoryLiteral ?? (relativeLiteral ?? (selectedScope || selectedEdit || selectedReadback ? trimmed : target)),
        root_constraint_source: span(forbiddenFile ? forbiddenFile.start : directoryLiteral ? directoryAt : relativeLiteral ? relativeAt : selectedScope || selectedEdit || selectedReadback ? ownConstraintSpan.start : constraintSpan.start,
          forbiddenFile ? forbiddenFile.end : directoryLiteral ? directoryAt + Buffer.byteLength(directoryLiteral, 'utf8') : relativeLiteral ? relativeAt + Buffer.byteLength(relativeLiteral, 'utf8') : selectedScope || selectedEdit || selectedReadback ? ownConstraintSpan.end : constraintSpan.end),
        implementation_choice: kind === 'constraint' ? null : target,
        host_selection: kind === 'constraint' ? null : target, resolved: target, observed: kind === 'constraint' ? null : target, subject_kind: subjectKind,
        constraint_kind: forbiddenFile ? 'exact' : directoryLiteral ? 'directory' : relativeLiteral ? 'exact' : selectedScope || selectedEdit || selectedReadback ? 'work_unit' : 'exact',
        ...((forbiddenFile || directoryLiteral || relativeLiteral) && rootBase ? { resolved_constraint: resolve(rootBase, forbiddenFile?.literal ?? directoryLiteral ?? relativeLiteral!) } : {}),
        selection_source_id: kind === 'constraint' ? null : selectedReadiness ? `call:${selectedReadiness.callId}` : selectedEdit ? `call:${selectedEdit.callId}` : selectedReadback ? `call:${selectedReadback.callId}`
          : relativeLiteral ? (() => { const fact = [...projection.evidence.values()].find((entry) => entry.semanticAction === 'modify'
            && entry.evidenceRole === 'effect' && entry.outcome === 'success' && entry.subjects.includes(target) && sourceByCall.has(entry.callId))
            return fact ? `call:${fact.callId}` : null })() : null } })
    if (kind === 'information' && item.answeredBy) {
      const delivery = events.find((event) => event.seq === item.answeredBy?.responseSeq && event.type === 'assistant/message')
      if (delivery && item.answeredBy.turn === Number(turn)) {
        const deliveryId = `delivery:${delivery.seq}`
        const deliveredText = Array.isArray(row(row(delivery.data).message).content)
          ? (row(row(delivery.data).message).content as unknown[]).filter((part) => row(part).type === 'text')
            .map((part) => String(row(part).text ?? '')).join('\n') : ''
        if (!sources.some((source) => source.id === deliveryId)) sources.push({ id: deliveryId, seq: delivery.seq, kind: 'final_delivery', unit, revision: 1,
          sha256: hash(deliveredText), byte_length: Buffer.byteLength(deliveredText, 'utf8'), text: null, call_id: null, turn })
        facts.push({ id: `fact:${deliveryId}`, seq: delivery.seq, unit, revision: 1, source_id: deliveryId,
          call_source_id: null, kind: 'delivery', target, predicate, outcome: 'success', operation_id: null,
          requirement_id: item.id, condition_id: null, invalidates: [] })
      }
    }
    for (const evidence of guarded ? [] : projection.evidence.values()) {
      const inTestScope = needsReadiness && typeof item.requestedTarget?.scope === 'string'
        && evidence.subjects.includes(item.requestedTarget.scope)
      if (evidence.epoch !== projection.epoch || (!evidence.subjects.includes(target) && !inTestScope)
        || evidence.toolResultSeq <= root.seq || (attached.has(evidence.id) && !fileReadback)) continue
      if (kind === 'constraint' && (!forbiddenFile || evidence.evidenceRole !== 'effect'
        || !['write', 'write_file', 'edit', 'edit_file'].includes(evidence.toolName)
        || !evidence.operations?.some((operation) => ['create','modify'].includes(operation.op) && operation.path === target))) continue
      // A relative root locator is stronger than a later tool's display path.
      // The provider's processPath/contains readback must bind the physical
      // target and root-time base before a state fact can satisfy it.
      if (subjectKind === 'filesystem' && (directoryLiteral || relativeLiteral || selectedReadback)
        && evidence.toolName === 'context_guard_observe_file'
        && (!rootBase || evidence.nativeCanonicalBase !== rootBase || evidence.nativeCanonicalPath !== target)) continue
      if (needsReadiness && evidence.toolName !== 'context_guard_observe_test_readiness'
        && evidence.semanticAction !== item.semanticAction) continue
      if (fileReadback && (evidence.evidenceRole !== 'state' || evidence.toolName !== 'context_guard_observe_file')) continue
      if (evidence.toolName === 'context_guard_observe_test_readiness' && evidence.readinessForItemId !== item.id) continue
      if (evidence.evidenceRole === 'state' && evidence.toolName !== 'context_guard_observe_test_readiness') {
        const cause = [...projection.evidence.values()].find((fact) => fact.callId === evidence.causedByCallId
          && fact.epoch === evidence.epoch && fact.outcome === 'success' && fact.toolResultSeq < evidence.toolResultSeq
          && fact.subjects.includes(target) && fact.semanticAction === evidence.semanticAction)
        if (!cause || !['context_guard_observe_file', 'context_guard_observe_git'].includes(evidence.toolName)) continue
      }
      const pair = sourceByCall.get(evidence.callId)
      const crossesNewConstraint = kind === 'constraint' && forbiddenFile && pair
        && pair.call.seq <= root.seq && pair.result.seq >= root.seq
      if (!pair || pair.result.seq !== evidence.toolResultSeq || (pair.call.seq <= root.seq && !crossesNewConstraint)) continue
      const resultMessage = row(pair.result.data).message
      const resultBlocks = row(resultMessage).content
      const hostError = row(pair.result.data).error !== undefined || row(resultMessage).isError === true
        || (Array.isArray(resultBlocks) && resultBlocks.some((block) => row(block).isError === true))
      const outcome = hostError || evidence.outcome === 'failure' || evidence.processFacts?.outcome === 'failure' ? 'failure'
        : evidence.outcome !== 'success' || evidence.processFacts?.outcome === 'unknown'
          || (evidence.evidenceRole === 'effect' && evidence.processFacts && evidence.processFacts.operationAttribution !== 'single_operation')
          || evidence.parseStatus !== 'supported' ? 'unknown' : 'success'
      const callId = `call:${evidence.callId}`, resultId = `result:${evidence.callId}`
      const callName = String(row(pair.call.data).name ?? '')
      let callArgs: Record<string, unknown> = {}
      try { callArgs = row(JSON.parse(String(row(pair.call.data).arguments ?? ''))) } catch { /* unsupported call */ }
      const fileCall = ['read','read_file','write','write_file','edit','edit_file'].includes(callName)
      const filePath = callArgs.file_path
      const fileCallTarget = fileCall && typeof filePath === 'string' && filePath
        ? isAbsolute(filePath) ? resolve(filePath) : rootBase ? resolve(rootBase, filePath) : undefined : undefined
      // Ordinary file calls select their target in persisted arguments. Guard
      // readback calls instead select the target through their verified observer
      // result; shell/Git evidence uses the parsed host command/workdir. Never
      // fill the call target from the requirement being evaluated.
      const hostTarget = fileCall ? fileCallTarget : evidence.subjects[0]
      if (!hostTarget || (fileCall && evidence.parseStatus !== 'supported')) continue
      if (!sources.some((source) => source.id === callId)) {
        const callTurn = String(row(pair.call.data).turn ?? turn)
        const resultTurn = String(row(pair.result.data).turn ?? callTurn)
        const originRoot = usedRoots.filter((candidate) => candidate.seq <= pair.call.seq
          && String(row(candidate.data).turn ?? turn) === callTurn).at(-1)
        const callBytes = String(row(pair.call.data).arguments ?? '')
        const resultBytes = Array.isArray(row(row(pair.result.data).message).content)
          ? (row(row(pair.result.data).message).content as unknown[]).filter((part) => row(part).type === 'text')
            .map((part) => String(row(part).text ?? '')).join('\n') : ''
        sources.push({ id: callId, seq: pair.call.seq, kind: 'host_call', unit, revision: 1, sha256: hash(callBytes),
          byte_length: Buffer.byteLength(callBytes, 'utf8'), text: null, call_id: evidence.callId, turn: callTurn,
          target: hostTarget, target_kind: subjectKind,
          ...(originRoot ? { origin_root_source_id: `root:${originRoot.seq}` } : {}) })
        sources.push({ id: resultId, seq: pair.result.seq, kind: 'host_result', unit, revision: 1, sha256: hash(resultBytes),
          byte_length: Buffer.byteLength(resultBytes, 'utf8'), text: null, call_id: evidence.callId, turn: resultTurn })
      }
      const factKind = evidence.toolName === 'context_guard_observe_test_readiness' ? 'readiness'
        : evidence.evidenceRole === 'state' ? 'state_outcome' : 'action_event'
      facts.push({ id: fileReadback ? `${evidence.id}:${item.id}` : evidence.id, seq: pair.result.seq, unit, revision: 1, source_id: resultId,
        call_source_id: callId, kind: factKind, target: hostTarget, predicate: forbiddenFile ? 'mutation_applied' : factKind === 'readiness' ? 'inputs_ready' : predicate,
        outcome, operation_id: null, requirement_id: item.id, condition_id: null, invalidates: [] })
      if (!fileReadback) attached.add(evidence.id)
    }
    for (const base of currentActionBases(projection, false).filter((base) => base.itemId === item.id)) {
      const ready = facts.filter((fact) => fact.requirement_id === item.id && fact.kind === 'readiness' && fact.outcome === 'success').map((fact) => fact.id)
      if (!ready.length) continue
      actions.push({ schema: 'current-action-basis/v1', requirement_id: item.id, unit, revision: 1,
        seq: Number(base.asOf), source: requirementSource, scope_sha256: digest,
        action: item.semanticAction === 'test' ? 'test_verify' : item.semanticAction === 'verify' ? assessmentAction(item.normalizedText) : item.semanticAction, target, predicate,
        owner: 'assistant', relation: 'direct', readiness_fact_ids: ready, state: 'current' })
    }
  }
  const latestText = rootText(latestRoot), latestDigest = hash(latestText)
  const resume = isResume(latestText)
  const snapshot = { schema: 'core-observation/v2', unit, revision: 1, as_of: events.at(-1)?.seq ?? latestRoot.seq, turn,
    units: [{ id: unit, parent_id: null, required: true, source_id: `root:${usedRoots[0]!.seq}` }], sources, requirements, facts, actions,
    conditions, coverage, intent: resume ? { source: { source_id: `root:${latestRoot.seq}`, start: 0, end: Buffer.byteLength(latestText, 'utf8'), sha256: latestDigest }, kind: 'resume' } : { source: null, kind: 'none' },
    completion_claim: false, proof_violation: false, corrections_used: 0, progress_changed: true,
    goal_contract_adopted: projection.goalCompletionAdopted, release_state: projection.releaseContracts.some((entry) => entry.revokedAtSeq === undefined) ? 'adopted' : 'not_adopted' }
  return snapshot
}
export function projectSessionCoreV2(events: DerivedEnvelope[], projection: GuardProjection): Record<string, unknown> | undefined {
  const snapshot = sessionCoreSnapshot(events, projection)
  return snapshot ? projectCoreV2(snapshot) : undefined
}
