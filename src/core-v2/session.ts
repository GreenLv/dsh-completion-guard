import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type { GuardProjection, DerivedEnvelope, GuardItem } from '../domain/types.js'
import { assessmentAction, assessmentOutcomePredicate, currentActionBases, v6TestPredicate } from '../domain/stop-policy.js'
import { actionClassScopeSpeech, controlSpeech, currentUnitScopeSpeech, projectCoreV2, rootControlCandidateSpans } from './project.js'
import { persistedToolResultStatus } from '../domain/evidence.js'
import { observerMethodEvidence } from '../domain/observer-method.js'

const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')
// A persisted root and host call keep their own path syntax. Using the running
// Node platform here would silently turn a POSIX fixture/remote path into a
// Windows drive path (or the reverse) before any host identity proof exists.
const windowsAbsolute = (value: string): boolean => /^[A-Za-z]:\\/.test(value) && !value.includes('/')
  && !value.slice(3).includes('\\\\') && !value.slice(3).includes(':')
  && !value.split('\\').some((part) => part === '.' || part === '..')
const posixAbsolute = (value: string): boolean => value.startsWith('/') && !value.startsWith('//')
  && !value.includes('\\') && posix.normalize(value) === value
const portableResolve = (base: string | undefined, value: string): string | undefined => {
  // An explicit absolute target still belongs to the root-time locator
  // flavor. A Windows host must not interpret a synthetic POSIX /work path as
  // its current drive, or vice versa.
  if (windowsAbsolute(value)) return !base || windowsAbsolute(base) ? value : undefined
  if (posixAbsolute(value)) return !base || posixAbsolute(base) ? value : undefined
  if (!base || value.includes('\\') || value.includes(':') || value.split('/').some((part) => !part || part === '.' || part === '..')) return undefined
  if (posixAbsolute(base)) return posix.resolve(base, value)
  // Windows relative locators remain unavailable in shared core/v2. Do not
  // manufacture a POSIX selection from a drive-rooted Session header.
  return undefined
}
const portableRelativeWithin = (base: string, target: string): string | undefined => {
  if (posixAbsolute(base) && posixAbsolute(target)) {
    const suffix = posix.relative(base, target)
    return suffix && suffix !== '..' && !suffix.startsWith('../') ? suffix : undefined
  }
  // The shared core currently has no Windows relative/directory locator
  // authority. In particular win32.relative would silently grant case and
  // separator aliases without the host's physical path proof.
  return undefined
}
const portableContains = (base: string, target: string): boolean => portableRelativeWithin(base, target) !== undefined
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

/** Root controls are immutable, scoped facts. A later root can change the
 * continuation of requirements already present, never authorize a later item. */
function rootControls(roots: DerivedEnvelope[], requirements: Array<Record<string, unknown>>,
  sources: Array<Record<string, unknown>>, facts: Array<Record<string, unknown>>, unit: string,
  selectedUnitAtRoot: (seq: number) => string | undefined): Array<Record<string, unknown>> {
  const controls: Array<Record<string, unknown>> = []
  const cancelled = new Set<string>()
  const sourceById = new Map(sources.map((source) => [String(source.id), source]))
  const targetAtReceipt = (req: Record<string, unknown>, seq: number): string | null | undefined => {
    const origin = req.target_origin as Record<string, unknown>
    if (origin.constraint_kind !== 'work_unit') return String(req.target)
    const selections = new Set(facts.filter((fact) => fact.kind === 'readiness'
      && fact.requirement_id === req.id && fact.outcome === 'success' && Number(fact.seq) <= seq)
      .flatMap((fact) => {
        const call = sourceById.get(String(fact.call_source_id))
        const result = sourceById.get(String(fact.source_id))
        return call?.kind === 'host_call' && result?.kind === 'host_result'
          && Number(call.seq) < Number(result.seq) && Number(result.seq) <= seq
          && call.target === fact.target && call.target_kind === origin.subject_kind
          ? [String(fact.target)] : []
      }))
    return selections.size > 1 ? undefined : selections.values().next().value ?? null
  }
  for (const root of roots) {
    const raw = Buffer.from(rootText(root), 'utf8')
    const digest = hash(rootText(root))
    for (const { start: controlStart, end: sentenceEnd } of rootControlCandidateSpans(rootText(root))) {
      const text = raw.subarray(controlStart, sentenceEnd).toString('utf8')
      if (!text.trim()) continue
      const kind = (['persistence', 'pause', 'resume', 'cancel'] as const).find((candidate) => controlSpeech(text, candidate))
      if (!kind) continue
      const eligible = requirements.filter((req) => req.unit === unit && Number(req.seq) <= root.seq
        && req.kind === 'execution' && !cancelled.has(String(req.id))
        && (req.status !== 'superseded' || typeof req.superseded_at_seq === 'number')
        && (typeof req.superseded_at_seq !== 'number' || root.seq < req.superseded_at_seq))
      // A control and supersession recorded in the same root event have no
      // trusted internal sequence. Do not choose the predecessor or successor.
      if (requirements.some((req) => req.unit === unit && req.kind === 'execution'
        && req.superseded_at_seq === root.seq)) continue
      // A bare or whole-task control needs the unit selected by the persisted
      // root ledger. The eventual projection unit alone is not receipt proof.
      const currentUnit = selectedUnitAtRoot(root.seq) === unit && currentUnitScopeSpeech(text, kind)
      let selected = currentUnit ? eligible : []
      let scopeBasis: Record<string, unknown> = { kind: 'current_unit', target: null, target_source: null }
      if (!currentUnit) {
        const parentNoun = /^(?:\s*)(?:(?:请|请先|先)\s*)?(?:暂停|搁置|取消|撤销|继续)\s*(这项修复|该项修复)\s*[。.!！]?\s*$/u.exec(text)?.[1]
        if (parentNoun) {
          const parents = eligible.filter((req) => req.action === 'local_edit'
            && eligible.some((child) => child.required && child.parent_id === req.id))
          if (parents.length !== 1) continue
          const parent = parents[0]!
          selected = [parent]
          let expanded = true
          while (expanded) {
            const previous = selected.length
            for (const child of eligible) if (child.required && selected.some((row) => row.id === child.parent_id)
              && !selected.some((row) => row.id === child.id)) selected.push(child)
            expanded = selected.length !== previous
          }
          const at = controlStart + Buffer.byteLength(text.slice(0, text.indexOf(parentNoun)), 'utf8')
          scopeBasis = { kind: 'parent_task', target: parent.id, target_source: {
            source_id: `root:${root.seq}`, start: at, end: at + Buffer.byteLength(parentNoun, 'utf8'), sha256: digest,
          } }
        } else {
        // A sourced test-role phrase selects the action class, not every item
        // in the unit. Its source span must sit inside this control predicate.
        const testRole = actionClassScopeSpeech(text, kind)
        if (testRole) {
          const actionItems = eligible.filter((req) => req.action === 'test_verify')
          if (!actionItems.length || /^(?:这项|该项)/u.test(testRole.noun) && actionItems.length !== 1) continue
          selected = actionItems
          const at = controlStart + Buffer.byteLength(text.slice(0, testRole.start), 'utf8')
          scopeBasis = { kind: 'action_class', target: 'test_verify', target_source: {
            source_id: `root:${root.seq}`, start: at, end: at + Buffer.byteLength(testRole.noun, 'utf8'), sha256: digest,
          } }
        } else {
        const matches = eligible.flatMap((req) => {
          const target = String(req.target)
          if (!target.startsWith('/') && !windowsAbsolute(target)) return []
          const literal = Buffer.from(target, 'utf8')
          const at = raw.subarray(controlStart, sentenceEnd).indexOf(literal)
          if (at < 0 || raw.subarray(controlStart, sentenceEnd).indexOf(literal, at + 1) >= 0) return []
          return [{ req, target, at: controlStart + at }]
        })
        const targets = new Set(matches.map((match) => match.target))
        if (targets.size !== 1) continue
        const match = matches[0]!
        selected = eligible.filter((req) => req.target === match.target)
        scopeBasis = { kind: 'exact', target: match.target,
          target_source: { source_id: `root:${root.seq}`, start: match.at,
            end: match.at + Buffer.byteLength(match.target, 'utf8'), sha256: digest } }
        }
        }
      }
      if (!selected.length) continue
      const source = { source_id: `root:${root.seq}`, start: controlStart, end: sentenceEnd, sha256: digest }
      const refs = selected.map((req) => ({ req, target: targetAtReceipt(req, root.seq) }))
      if (refs.some((ref) => ref.target === undefined)) continue
      controls.push({ id: `control:${root.seq}:${controlStart}`, kind, source, seq: root.seq,
        scope_basis: scopeBasis, controlled_requirements: refs.map(({ req, target }) => ({
          requirement_id: req.id, unit: req.unit, revision: req.revision,
          source_id: (req.source as { source_id: string }).source_id, seq: req.seq,
          target, scope_sha256: req.scope_sha256,
        })) })
      if (kind === 'cancel') for (const req of selected) cancelled.add(String(req.id))
    }
  }
  return controls
}

/** Convert only real session sources and derived facts. Missing spans, calls, or
 * readback remain unknown/insufficient; this adapter never fabricates them. */
export function sessionCoreSnapshot(events: DerivedEnvelope[], projection: GuardProjection): Record<string, unknown> | undefined {
  const unit = projection.currentUnitId
  if (projection.boundaryProtocol !== 6 || !unit || projection.durabilityWatermark !== 'confirmed') return undefined
  const roots = events.filter((event) => event.type === 'user/message' && row(row(event.data).source).kind === 'user')
  // Keep superseded rows as historical receipt facts. Filtering by final
  // status would erase an earlier control's complete at-sequence inventory.
  const currentItems = [...projection.items.values()].filter((item) => item.unitId === unit)
  const currentUnit = projection.units.get(unit)
  if (!currentUnit) return undefined
  const refs = new Set(currentUnit.rootInputRefs.map((ref) => ref.seq))
  // The unit ledger is a derived index, not authority to hide an immutable
  // Host root. Every later user root must remain assigned to some unit; if an
  // item and its root reference are both removed, coverage must not shrink.
  const allRefs = new Set([...projection.units.values()].flatMap((entry) => entry.rootInputRefs.map((ref) => ref.seq)))
  if (roots.some((root) => root.seq >= currentUnit.openedAtSeq && !allRefs.has(root.seq))) return undefined
  const usedRoots = roots.filter((event) => refs.has(event.seq))
  if (!usedRoots.length) return undefined
  const latestRoot = usedRoots.at(-1)!
  const turn = String(row(latestRoot.data).turn ?? projection.hostTurn ?? 1)
  const rootBySeq = new Map(usedRoots.map((root) => [root.seq, root]))
  // Revision is the immutable root arrival order within this work unit. It
  // does not borrow the mutable final item status or the projection's latest
  // revision for a fact that belongs to an earlier root.
  const revisionByRootSeq = new Map(usedRoots.map((root, index) => [root.seq, index + 1]))
  const revisionFor = (seq: number): number => revisionByRootSeq.get(seq)!
  const supersessionOf = (item: GuardItem): { seq: number; sourceId: string; requirementId: string } | undefined => {
    if (item.status !== 'superseded' || !item.supersededBy) return undefined
    const successor = projection.items.get(item.supersededBy)
    const seq = successor ? sourceSeq(successor) : undefined
    const successorRoot = seq === undefined ? undefined : rootBySeq.get(seq)
    const successorSpan = successor?.spans?.[0]
    const successorClause = successorRoot && successorSpan?.partIndex === 0
      ? Buffer.from(rootText(successorRoot), 'utf8').subarray(successorSpan.start, successorSpan.end).toString('utf8') : undefined
    const predecessorSeq = sourceSeq(item)
    const predecessorRoot = predecessorSeq === undefined ? undefined : rootBySeq.get(predecessorSeq)
    const predecessorSpan = item.spans?.[0]
    const predecessorClause = predecessorRoot && predecessorSpan?.partIndex === 0
      ? Buffer.from(rootText(predecessorRoot), 'utf8').subarray(predecessorSpan.start, predecessorSpan.end).toString('utf8') : undefined
    // The current v6 duplicate capture only replaces the same root duty.
    // A stored status/link and a later root with the same object are not a
    // substitute for source bytes that restate that duty.
    const sourcedReplacement = Boolean(successorClause && predecessorClause
      && successorClause === predecessorClause && successor?.textSha256 === item.textSha256)
    return successor?.unitId === unit && successor.kind === item.kind
      && successor.semanticAction === item.semanticAction
      && targetOf(successor) === targetOf(item)
      && successor.authorityDisposition === 'executable_now'
      && sourcedReplacement
      && seq !== undefined && seq > (sourceSeq(item) ?? -1)
      && rootBySeq.has(seq) && revisionFor(seq) > revisionFor(sourceSeq(item)!)
      ? { seq, sourceId: `root:${seq}`, requirementId: successor.id } : undefined
  }
  if (!currentItems.every((item) => {
    const root = rootBySeq.get(sourceSeq(item) ?? -1)
    return root && item.rawTextSha256 === hash(rootText(root))
  })) return undefined
  const sources: Array<Record<string, unknown>> = usedRoots.map((root) => {
    const text = rootText(root)
    return { id: `root:${root.seq}`, seq: root.seq, kind: 'root', unit, revision: revisionFor(root.seq), sha256: hash(text),
      byte_length: Buffer.byteLength(text, 'utf8'), text, call_id: null, turn: String(row(root.data).turn ?? turn),
      ...(projection.rootLocatorContexts.get(root.seq) ? { locator_base: projection.rootLocatorContexts.get(root.seq)!.base,
        locator_flavor: projection.rootLocatorContexts.get(root.seq)!.flavor } : {}) }
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
        requirements.push({ id: `intent:${root.seq}`, unit, revision: revisionFor(root.seq), seq: root.seq, source: span(0, byteLength),
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
    const itemRevision = revisionFor(root.seq)
    const text = rootText(root), digest = hash(text)
    const span = (start: number, end: number) => ({ source_id: `root:${root.seq}`, start, end, sha256: digest })
    const itemSpan = sourceSpan(item, text, currentItems.filter((peer) => sourceSeq(peer) === root.seq))
    if (!itemSpan) continue
    if (item.observerMethod && item.rawTextSha256 === hash(text) && item.authority === 'root_instruction') {
      // Each requested observer has its own sourced predicate. One readiness
      // result cannot silently stand in for the file readback method (or vice
      // versa), and a later tool call never fills an earlier Stop watermark.
      const methodSource = { source_id: `root:${root.seq}`, start: itemSpan.start, end: itemSpan.end, sha256: hash(text) }
      const methodConstraint = Buffer.from(text, 'utf8').subarray(itemSpan.start, itemSpan.end).toString('utf8')
      for (const [index, tool] of item.observerMethod.tools.entries()) {
        const related = projection.items.get(item.observerMethod.targetItemIds[index]!)
        if (!related || related.rawTextSha256 !== item.rawTextSha256 || related.unitId !== item.unitId
          || sourceSeq(related) !== root.seq) continue
        const target = targetOf(related)
        if (!target) continue
        const requirementId = `${item.id}:observer:${index + 1}`
        const fact = observerMethodEvidence(projection, events, item, index)
        const pair = fact ? sourceByCall.get(fact.callId) : undefined
        const subjectKind = tool === 'context_guard_observe_file' ? 'filesystem' : 'opaque'
        const relatedSpan = related.spans?.[0]
        const targetBytes = Buffer.from(target, 'utf8')
        const targetAt = relatedSpan ? Buffer.from(text, 'utf8').subarray(relatedSpan.start, relatedSpan.end).indexOf(targetBytes) : -1
        // A literal target in the earlier root duty is already an exact root
        // constraint. A method has no power to choose another target; without
        // a literal, the actual Host selection must supply the work-unit choice.
        const literalTarget = targetAt >= 0 && relatedSpan !== undefined
        const targetSource = literalTarget ? { source_id: `root:${root.seq}`,
          start: relatedSpan.start + targetAt, end: relatedSpan.start + targetAt + targetBytes.length, sha256: hash(text) } : methodSource
        requirements.push({ id: requirementId, unit, revision: itemRevision, seq: root.seq, source: methodSource,
          kind: 'execution', action: tool, target, predicate: 'observer_method_completed', scope_sha256: hash(text),
          required: true, status: 'pending', parent_id: null, evidence_kind: 'action_event', condition_ids: [],
          target_origin: { root_constraint: literalTarget ? target : methodConstraint, root_constraint_source: targetSource,
            implementation_choice: literalTarget || fact ? target : null, host_selection: literalTarget || fact ? target : null,
            resolved: target, observed: literalTarget || fact ? target : null, constraint_kind: literalTarget ? 'exact' : 'work_unit', subject_kind: subjectKind,
            selection_source_id: fact ? `call:${fact.callId}` : null } })
        if (!fact || !pair) continue
        const callId = `call:${fact.callId}`, resultId = `result:${fact.callId}`
        if (!sources.some((source) => source.id === callId)) {
          const callBytes = String(row(pair.call.data).arguments ?? '')
          const resultBytes = Array.isArray(row(row(pair.result.data).message).content)
            ? (row(row(pair.result.data).message).content as unknown[]).filter((part) => row(part).type === 'text')
              .map((part) => String(row(part).text ?? '')).join('\n') : ''
          const callTurn = String(row(pair.call.data).turn ?? turn)
          sources.push({ id: callId, seq: pair.call.seq, kind: 'host_call', unit, revision: itemRevision,
            sha256: hash(callBytes), byte_length: Buffer.byteLength(callBytes, 'utf8'), text: null,
            call_id: fact.callId, turn: callTurn, target, target_kind: subjectKind,
            origin_root_source_id: `root:${root.seq}` })
          sources.push({ id: resultId, seq: pair.result.seq, kind: 'host_result', unit, revision: itemRevision,
            sha256: hash(resultBytes), byte_length: Buffer.byteLength(resultBytes, 'utf8'), text: null,
            call_id: fact.callId, turn: String(row(pair.result.data).turn ?? callTurn) })
        }
        facts.push({ id: `${fact.id}:observer:${item.id}:${index + 1}`, seq: pair.result.seq, unit,
          revision: itemRevision, source_id: resultId, call_source_id: callId, kind: 'action_event', target,
          predicate: 'observer_method_completed', outcome: 'success', operation_id: null,
          requirement_id: requirementId, condition_id: null, invalidates: [] })
      }
      continue
    }
    // The legacy clause capture can split a single v6 root control into
    // generic fragments (for example, either side of its internal comma).
    // Preserve their original coverage, but never project those fragments as
    // separate business requirements once the complete immutable root span
    // is independently recognized as one control speech act.
    if (item.semanticAction === 'generic_run' && rootControlCandidateSpans(text).some((candidate) =>
      itemSpan.start >= candidate.start && itemSpan.end <= candidate.end
      && (['persistence', 'pause', 'resume', 'cancel'] as const).some((kind) => {
        const speech = Buffer.from(text, 'utf8').subarray(candidate.start, candidate.end).toString('utf8')
        return controlSpeech(speech, kind) && (currentUnitScopeSpeech(speech, kind) || actionClassScopeSpeech(speech, kind))
      }))) continue
    const kind = kindOf(item)
    const named = targetOf(item)
    const raw = Buffer.from(text, 'utf8')
    const namedBytes = named ? Buffer.from(named, 'utf8') : undefined
    const atWithin = namedBytes ? raw.subarray(itemSpan.start, itemSpan.end).indexOf(namedBytes) : -1
    const at = atWithin >= 0 ? itemSpan.start + atWithin : -1
    const ownText = raw.subarray(itemSpan.start, itemSpan.end).toString('utf8')
    const fileReadback = item.interpretationFingerprint?.startsWith('v6-file-readback:') === true
    const anaphoricReadback = fileReadback && /\bread\s+(?:it|the\s+file)\s+back\b/iu.test(ownText)
    const readbackAntecedents = anaphoricReadback ? currentItems.filter((candidate) =>
      candidate.semanticAction === 'modify' && candidate.authorityDisposition === 'executable_now'
      && sourceSeq(candidate) === root.seq && typeof candidate.requestedTarget?.artifact_id === 'string'
      && (candidate.spans?.[0]?.end ?? Infinity) <= itemSpan.start) : []
    const readbackReferent = readbackAntecedents.length === 1
      ? readbackAntecedents[0]!.requestedTarget!.artifact_id : undefined
    // A prohibition's own source stays on the forbidden speech act. A single
    // earlier context mention can supply its file referent through a separate
    // root path span; competing mentions never become an invented identity.
    const referents = kind === 'constraint' ? currentItems.flatMap((candidate) => {
      if (candidate.taskKind !== 'context' || sourceSeq(candidate) !== root.seq) return []
      const own = sourceSpan(candidate, text, currentItems.filter((peer) => sourceSeq(peer) === root.seq))
      const path = candidate.requestedTarget?.artifact_id
      const base = projection.rootLocatorContexts.get(root.seq)?.base
      if (!own || own.end > itemSpan.start || typeof path !== 'string' || !base || !portableContains(base, path)) return []
      const literal = portableRelativeWithin(base, path)!
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
    const relativeName = rootBase && named ? portableRelativeWithin(rootBase, named) : undefined
    const relativePaths = relativeName && !relativeName.startsWith('../') && ownText.includes(relativeName) ? [relativeName] : []
    const relativeLiteral = at < 0 && named && item.semanticAction === 'modify'
      ? relativePaths.find((literal) => named.endsWith(`/${literal}`)) : undefined
    const relativeAt = relativeLiteral ? itemSpan.start + raw.subarray(itemSpan.start, itemSpan.end).indexOf(Buffer.from(relativeLiteral, 'utf8')) : -1
    const scopeValue = typeof item.requestedTarget?.scope === 'string' ? item.requestedTarget.scope
      : typeof item.requestedTarget?.artifact_id === 'string' ? item.requestedTarget.artifact_id : undefined
    const editScope = directoryLiteral && scopeValue ? portableResolve(scopeValue, directoryLiteral) : scopeValue
    const editChoices = item.semanticAction === 'modify' && (!item.requestedTarget?.artifact_id || directoryLiteral) && typeof editScope === 'string'
      ? [...projection.evidence.values()].filter((fact) => fact.semanticAction === 'modify' && fact.evidenceRole === 'effect'
        && fact.outcome === 'success' && fact.toolResultSeq > root.seq && (sourceByCall.get(fact.callId)?.call.seq ?? -1) > root.seq
        && fact.subjects.length === 1 && typeof fact.subjects[0] === 'string'
        && portableContains(editScope, fact.subjects[0])) : []
    const selectedEdit = editChoices.length === 1 ? editChoices[0] : undefined
    const readbackChoices = fileReadback ? [...projection.evidence.values()].filter((fact) =>
      fact.evidenceRole === 'state' && fact.toolName === 'context_guard_observe_file' && fact.outcome === 'success'
      && fact.toolResultSeq > root.seq && fact.subjects.length === 1 && (sourceByCall.get(fact.callId)?.call.seq ?? -1) > root.seq
      && (!anaphoricReadback || (typeof readbackReferent === 'string' && fact.subjects[0] === readbackReferent))
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
    // A plain named npm/pnpm test does not require the assistant to call a
    // Guard readiness tool. The exact foreground Host invocation may select
    // this root's work-unit target, but only under the independently checked
    // renderer byte identity and a matched terminal result.
    const namedTest = item.semanticAction === 'test' ? /\b((?:npm|pnpm))\s+test\b/iu.exec(item.normalizedText) : null
    const isDirectTestFact = (fact: typeof projection.evidence extends Map<string, infer T> ? T : never): boolean => {
      if (!namedTest || guarded) return false
      if (fact.semanticAction !== 'test' || fact.evidenceRole !== 'effect' || fact.parseStatus !== 'supported'
        || fact.epoch !== projection.epoch || !['bash','pwsh'].includes(fact.toolName)
        || !projection.auditedForegroundRenderers?.includes(fact.toolName as 'bash' | 'pwsh')
        || fact.processFacts?.operationAttribution !== 'single_operation') return false
      const pair = sourceByCall.get(fact.callId)
      if (!pair || pair.call.seq <= root.seq || pair.result.seq !== fact.toolResultSeq
        || persistedToolResultStatus(pair.result.data, fact.callId) !== 'clean') return false
      let args: Record<string, unknown> = {}
      try { args = row(JSON.parse(String(row(pair.call.data).arguments ?? ''))) } catch { return false }
      const expected = `${namedTest[1]!.toLowerCase()} test`
      return String(args.command ?? '').trim() === expected && args.run_in_background !== true
        && typeof args.workdir === 'string' && fact.subjects.length === 1
        && fact.subjects[0] === args.workdir && fact.subjects[0] === item.requestedTarget?.scope
    }
    const selectedDirectTest = namedTest && !guarded ? [...projection.evidence.values()]
      .filter(isDirectTestFact).sort((a, b) => b.toolResultSeq - a.toolResultSeq)[0] : undefined
    const selectedScope = (selectedReadiness || selectedDirectTest) && typeof item.requestedTarget?.scope === 'string' ? item.requestedTarget.scope : undefined
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
      : item.semanticAction === 'test' ? v6TestPredicate(item.normalizedText)
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
    const supersession = supersessionOf(item)
    const relation = item.rootDependency
    const parent = relation ? projection.items.get(relation.parentItemId) : undefined
    const parentSpan = parent?.spans?.[0]
    const childSpan = item.spans?.[0]
    const relationText = relation ? raw.subarray(relation.sourceSpan.start, relation.sourceSpan.end).toString('utf8') : ''
    const parentId = relation && parent && parentSpan && childSpan
      && item.semanticAction === 'test' && parent.semanticAction === 'modify'
      && parent.authorityDisposition === 'executable_now' && parent.requestedTarget?.artifact_id
      && parent.unitId === item.unitId && sourceSeq(parent) === root.seq
      && parent.rawTextSha256 === digest && relation.rawTextSha256 === digest
      && relation.sourceSpan.start === childSpan.start && relation.sourceSpan.end <= childSpan.end
      && parentSpan.end <= childSpan.start && /^(?:并且|并|和|and\b)\s*$/iu.test(relationText)
      ? parent.id : null
    requirements.push({ id: item.id, unit, revision: itemRevision, seq: root.seq, source: requirementSource,
      kind, action: item.taskKind === 'context' ? 'reported_context' : kind === 'information' ? 'answer' : item.semanticAction === 'test' ? 'test_verify' : item.semanticAction === 'modify' && kind === 'execution' ? 'local_edit' : fileReadback ? 'readback' : item.semanticAction === 'verify' ? assessmentAction(item.normalizedText) : item.semanticAction ?? 'unknown', target, predicate, scope_sha256: digest, required: item.taskKind !== 'context',
      status: item.status === 'superseded' ? 'superseded'
        : item.needsReview || ambiguousForbiddenFile || uncertainForbiddenEffect || unattributedHostCall || unresolvedPhysicalAlias ? 'legacy_review'
          : item.status === 'pending' ? 'pending' : 'satisfied', parent_id: parentId,
      ...(supersession ? { superseded_at_seq: supersession.seq, supersession_source_id: supersession.sourceId,
        superseded_by_requirement_id: supersession.requirementId } : {}),
      evidence_kind: evidenceKind, condition_ids: conditionId ? [conditionId] : [], target_origin: { root_constraint: forbiddenFile?.literal ?? directoryLiteral ?? (relativeLiteral ?? (selectedScope || selectedEdit || selectedReadback ? trimmed : target)),
        root_constraint_source: span(forbiddenFile ? forbiddenFile.start : directoryLiteral ? directoryAt : relativeLiteral ? relativeAt : selectedScope || selectedEdit || selectedReadback ? ownConstraintSpan.start : constraintSpan.start,
          forbiddenFile ? forbiddenFile.end : directoryLiteral ? directoryAt + Buffer.byteLength(directoryLiteral, 'utf8') : relativeLiteral ? relativeAt + Buffer.byteLength(relativeLiteral, 'utf8') : selectedScope || selectedEdit || selectedReadback ? ownConstraintSpan.end : constraintSpan.end),
        implementation_choice: kind === 'constraint' ? null : target,
        host_selection: kind === 'constraint' ? null : target, resolved: target, observed: kind === 'constraint' ? null : target, subject_kind: subjectKind,
        constraint_kind: forbiddenFile ? 'exact' : directoryLiteral ? 'directory' : relativeLiteral ? 'exact' : selectedScope || selectedEdit || selectedReadback ? 'work_unit' : 'exact',
        ...((forbiddenFile || directoryLiteral || relativeLiteral) && rootBase ? {
          resolved_constraint: portableResolve(rootBase, forbiddenFile?.literal ?? directoryLiteral ?? relativeLiteral!),
        } : {}),
        selection_source_id: kind === 'constraint' ? null : selectedReadiness ? `call:${selectedReadiness.callId}` : selectedDirectTest ? `call:${selectedDirectTest.callId}` : selectedEdit ? `call:${selectedEdit.callId}` : selectedReadback ? `call:${selectedReadback.callId}`
          : relativeLiteral ? (() => { const fact = [...projection.evidence.values()].find((entry) => entry.semanticAction === 'modify'
            && entry.evidenceRole === 'effect' && entry.outcome === 'success' && entry.subjects.includes(target) && sourceByCall.has(entry.callId))
            return fact ? `call:${fact.callId}` : null })() : null } })
    if (kind === 'information' && item.answeredBy) {
      const delivery = events.find((event) => event.seq === item.answeredBy?.responseSeq && event.type === 'assistant/message')
      if (delivery && item.answeredBy.turn === Number(turn)) {
        const deliveryId = `delivery:${delivery.seq}:revision:${itemRevision}`
        const deliveredText = Array.isArray(row(row(delivery.data).message).content)
          ? (row(row(delivery.data).message).content as unknown[]).filter((part) => row(part).type === 'text')
            .map((part) => String(row(part).text ?? '')).join('\n') : ''
        // A request to report the test's *actual result* is not discharged by
        // any final prose. Bind the report to this root's one named test and
        // to that test's latest attributed Host terminal result. An optional
        // suggestion to repair after failure cannot extend the root scope.
        const isTestReport = /\b(?:report|summari[sz]e)\b[^。.!?？]{0,80}\b(?:result|outcome)\b|(?:报告|汇报|说明)[^。.!?？]{0,80}(?:结果|运行情况)/iu.test(item.normalizedText)
        const rootTests = currentItems.filter((candidate) => sourceSeq(candidate) === root.seq && candidate.semanticAction === 'test')
        const reportTest = isTestReport && rootTests.length === 1 ? rootTests[0] : undefined
        const expectedCommand = reportTest ? /\b(npm|pnpm)\s+test\b/iu.exec(reportTest.normalizedText)?.[0]?.toLowerCase() : undefined
        const run = expectedCommand ? [...projection.evidence.values()].filter((entry) => {
          const pair = sourceByCall.get(entry.callId)
          if (!pair || pair.call.seq <= root.seq || pair.result.seq >= delivery.seq
            || entry.semanticAction !== 'test' || entry.evidenceRole !== 'effect' || entry.parseStatus !== 'supported'
            || entry.processFacts?.operationAttribution !== 'single_operation'
            || !projection.auditedForegroundRenderers?.includes(entry.toolName as 'bash' | 'pwsh')
            || persistedToolResultStatus(pair.result.data, entry.callId) !== 'clean'
            || !entry.subjects.includes(String(reportTest?.requestedTarget?.scope ?? ''))) return false
          let args: Record<string, unknown> = {}
          try { args = row(JSON.parse(String(row(pair.call.data).arguments ?? ''))) } catch { return false }
          return String(args.command ?? '').trim() === expectedCommand && args.run_in_background !== true
        }).sort((a, b) => b.toolResultSeq - a.toolResultSeq)[0] : undefined
        // The audited renderer proves a complete markerless foreground result
        // is exit zero. A nonzero tail marker is text in the persisted Host
        // message and can be imitated by command stdout, so it cannot certify
        // the exact failing exit or an accurate failure report by itself.
        const terminalZero = run?.processFacts?.outcome === 'success'
          && run.processFacts.outcomeReason === 'unmarked_renderer_success'
        const conflictingStatus = /(?:test(?:s)?\s+(?:failed|did\s+not\s+pass)|测试(?:未通过|失败)|(?:exit\s*(?:code|status)?|退出码)\s*[:=]?\s*[1-9]\d*)/iu.test(deliveredText)
        const numericReport = terminalZero
          && /(?:exit\s*(?:code|status)?|退出码)\s*[:=]?\s*0(?!\d)/iu.test(deliveredText)
        const statusReport = terminalZero
          ? /(?:test(?:s)?\s+(?:passed|succeeded)|测试(?:已)?通过|测试成功)/iu.test(deliveredText)
          : false
        if (reportTest && (conflictingStatus || !numericReport && !statusReport)) continue
        if (!sources.some((source) => source.id === deliveryId)) sources.push({ id: deliveryId, seq: delivery.seq, kind: 'final_delivery', unit, revision: itemRevision,
          sha256: hash(deliveredText), byte_length: Buffer.byteLength(deliveredText, 'utf8'), text: null, call_id: null, turn })
        // One final message may satisfy several separate information items.
        // Reuse its source, but bind each fact identity to its requirement.
        facts.push({ id: `fact:${deliveryId}:${item.id}`, seq: delivery.seq, unit, revision: itemRevision, source_id: deliveryId,
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
      const hostResultStatus = persistedToolResultStatus(pair.result.data, evidence.callId)
      const untrustedDirectTest = item.semanticAction === 'test' && selectedDirectTest && !selectedReadiness
        && evidence.evidenceRole === 'effect' && !isDirectTestFact(evidence)
      const outcome = untrustedDirectTest ? 'unknown'
        : hostResultStatus === 'failure' || evidence.outcome === 'failure' || evidence.processFacts?.outcome === 'failure' ? 'failure'
        : evidence.outcome !== 'success' || evidence.processFacts?.outcome === 'unknown'
          || hostResultStatus === 'unknown'
          || (evidence.evidenceRole === 'effect' && evidence.processFacts && evidence.processFacts.operationAttribution !== 'single_operation')
          || evidence.parseStatus !== 'supported' ? 'unknown' : 'success'
      const callId = `call:${evidence.callId}`, resultId = `result:${evidence.callId}`
      // One persisted Host exchange has one source identity. Do not copy it
      // into another root revision just to satisfy a later requirement.
      const existingCall = sources.find((source) => source.id === callId)
      if (existingCall && existingCall.revision !== itemRevision) continue
      const callName = String(row(pair.call.data).name ?? '')
      let callArgs: Record<string, unknown> = {}
      try { callArgs = row(JSON.parse(String(row(pair.call.data).arguments ?? ''))) } catch { /* unsupported call */ }
      const fileCall = ['read','read_file','write','write_file','edit','edit_file'].includes(callName)
      const filePath = callArgs.file_path
      const fileCallTarget = fileCall && typeof filePath === 'string' && filePath
        ? portableResolve(rootBase, filePath) : undefined
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
        sources.push({ id: callId, seq: pair.call.seq, kind: 'host_call', unit, revision: itemRevision, sha256: hash(callBytes),
          byte_length: Buffer.byteLength(callBytes, 'utf8'), text: null, call_id: evidence.callId, turn: callTurn,
          target: hostTarget, target_kind: subjectKind,
          ...(originRoot ? { origin_root_source_id: `root:${originRoot.seq}` } : {}) })
        sources.push({ id: resultId, seq: pair.result.seq, kind: 'host_result', unit, revision: itemRevision, sha256: hash(resultBytes),
          byte_length: Buffer.byteLength(resultBytes, 'utf8'), text: null, call_id: evidence.callId, turn: resultTurn })
      }
      const factKind = evidence.toolName === 'context_guard_observe_test_readiness' ? 'readiness'
        : evidence.evidenceRole === 'state' ? 'state_outcome' : 'action_event'
      facts.push({ id: fileReadback ? `${evidence.id}:${item.id}` : evidence.id, seq: pair.result.seq, unit, revision: itemRevision, source_id: resultId,
        call_source_id: callId, kind: factKind, target: hostTarget, predicate: forbiddenFile ? 'mutation_applied' : factKind === 'readiness' ? 'inputs_ready' : predicate,
        outcome, operation_id: null, requirement_id: item.id, condition_id: null, invalidates: [] })
      if (!fileReadback) attached.add(evidence.id)
    }
    for (const base of currentActionBases(projection, false).filter((base) => base.itemId === item.id)) {
      const ready = facts.filter((fact) => fact.requirement_id === item.id && fact.kind === 'readiness' && fact.outcome === 'success').map((fact) => fact.id)
      if (!ready.length) continue
      actions.push({ schema: 'current-action-basis/v1', requirement_id: item.id, unit, revision: itemRevision,
        seq: Number(base.asOf), source: requirementSource, scope_sha256: digest,
        action: item.semanticAction === 'test' ? 'test_verify' : item.semanticAction === 'verify' ? assessmentAction(item.normalizedText) : item.semanticAction, target, predicate,
        owner: 'assistant', relation: 'direct', readiness_fact_ids: ready, state: 'current' })
    }
  }
  const latestText = rootText(latestRoot), latestDigest = hash(latestText)
  const resume = isResume(latestText)
  const selectedUnitAtRoot = (seq: number): string | undefined => {
    const selected = [...projection.units.values()].filter((entry) => entry.rootInputRefs.some((ref) => ref.seq === seq))
    return selected.length === 1 ? selected[0]?.unitId : undefined
  }
  const controls = rootControls(usedRoots, requirements, sources, facts, unit, selectedUnitAtRoot)
  const snapshot = { schema: 'core-observation/v2', unit, revision: revisionFor(latestRoot.seq), as_of: events.at(-1)?.seq ?? latestRoot.seq, turn,
    units: [{ id: unit, parent_id: null, required: true, source_id: `root:${usedRoots[0]!.seq}` }], sources, requirements, facts, actions, root_controls: controls,
    conditions, coverage, intent: resume ? { source: { source_id: `root:${latestRoot.seq}`, start: 0, end: Buffer.byteLength(latestText, 'utf8'), sha256: latestDigest }, kind: 'resume' } : { source: null, kind: 'none' },
    completion_claim: false, proof_violation: false, corrections_used: 0, progress_changed: true,
    goal_contract_adopted: projection.goalCompletionAdopted, release_state: projection.releaseContracts.some((entry) => entry.revokedAtSeq === undefined) ? 'adopted' : 'not_adopted' }
  return snapshot
}
export function projectSessionCoreV2(events: DerivedEnvelope[], projection: GuardProjection): Record<string, unknown> | undefined {
  const snapshot = sessionCoreSnapshot(events, projection)
  return snapshot ? projectCoreV2(snapshot) : undefined
}
