import { sha256 } from './canonicalize.js'
import { confirmRebind, rebindAttemptKey, replayRebindResult, type RebindArgs } from './rebind.js'
import { captureItem, extractMethod, extractOperation, isInformationalMessage, segmentClauses, type ClauseSegment } from './capture.js'
import { certifyCheckpoint } from './checkpoint.js'
import { qualifyBoundary, type BoundaryRequest } from './boundary.js'
import { classifyUserInteraction } from './conversation.js'
import { CONFIRM_LINE_PATTERN, parseConfirmationMessage } from './confirm-parse.js'
import { segmentAuthorityBlocks } from './contract-segment.js'
import { sessionRefDigest } from './digest.js'
import { DEFAULT_HOST_LOCK, type HostLockEvaluation } from './host-lock.js'
import { hasCurrentCertificate } from './goal-gate.js'
import { evidenceFromPersistedToolResult, extractTextContent, withDurability } from './evidence.js'
import { isStatefulAction, requestedTargetMatchesResolved } from './protocol-manifest.js'
import { CONTROL_RECORD_PREFIX, NO_PROGRESS_RECORD_PREFIX } from './stop-policy.js'
import { supersedeItem } from './supersession.js'
import { createProjection, type BindingActionClosure, type GuardCheckpoint, type GuardProjection, type EvidenceBinding, type GuardItemKind } from './types.js'
import type { DeriveConfig, DeriveResult, DeriveScope, DerivedEnvelope } from './types.js'

interface PendingCall {
  name: string
  arguments: string
  rootCallId?: string
  bindings?: EvidenceBinding[]
  boundaryRequest?: BoundaryRequest
}

export const CAPTURE_V042_NOTICE = 'Context Guard capture boundary: v0.4.2'

export const PROTOCOL_V3_NOTICE = 'Context Guard protocol boundary: v3.0.0'

/**
 * 0.5.0 first-step boundary: written at the first real root input step (never
 * at session start), before the constrained root message in the same batch.
 * It implies the v3 protocol and v0.4.2 capture semantics and marks the cut
 * where the 0.5 confirmation syntax becomes active; earlier notices keep
 * their historical meaning for replay.
 */
export const PROTOCOL_V4_NOTICE = 'Context Guard protocol boundary: v4.0.0'

function isProtocolBoundaryNotice(event: DerivedEnvelope, notice = PROTOCOL_V3_NOTICE): boolean {
  if (event.type !== 'user/message') return false
  const data = asRecord(event.data)
  const source = asRecord(data?.source)
  if (source?.kind !== 'plugin' || source.plugin !== 'context-guard' || source.form !== 'notice') return false
  return extractTextContent((data?.content as unknown[] | undefined) ?? []) === notice
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function recordedCertificateMatches(recorded: unknown, checkpoint: GuardCheckpoint): boolean {
  const value = asRecord(recorded)
  if (!value) return false
  const goal = asRecord(value.goal_ref)
  const exact = {
    stop_protocol_version: checkpoint.stopProtocolVersion,
    certificate_version: checkpoint.certificateVersion,
    epoch: checkpoint.epoch,
    session_ref_digest: checkpoint.sessionRefDigest,
    host_lock_digest: checkpoint.hostLockDigest,
    contract_revision: checkpoint.contractRevision,
    contract_sha256: checkpoint.contractSha256,
    open_digest: checkpoint.openDigest,
    evidence_sha256: checkpoint.evidenceSha256,
    binding_digest: checkpoint.bindingDigest,
    certification_digest: checkpoint.certificationDigest,
    goal_ref: checkpoint.goalRef ?? null,
  }
  const normalized = { ...value, goal_ref: goal ? { id: goal.id, revision: goal.revision } : value.goal_ref }
  return JSON.stringify(normalized) === JSON.stringify(exact)
}

function restoreHistoricalCheckpoint(recorded: Record<string, unknown>, bindings: EvidenceBinding[], id: string): GuardCheckpoint | undefined {
  const stringField = (name: string) => typeof recorded[name] === 'string' ? recorded[name] as string : undefined
  const epoch = recorded.epoch
  const revision = recorded.contract_revision
  const goal = asRecord(recorded.goal_ref)
  if (!Number.isSafeInteger(epoch) || !Number.isSafeInteger(revision)) return undefined
  const fields = [
    'stop_protocol_version', 'certificate_version', 'session_ref_digest', 'host_lock_digest',
    'contract_sha256', 'open_digest', 'evidence_sha256', 'binding_digest', 'certification_digest',
  ] as const
  if (fields.some((name) => !stringField(name))) return undefined
  if (goal && (typeof goal.id !== 'string' || !Number.isSafeInteger(goal.revision))) return undefined
  return {
    id,
    stopProtocolVersion: stringField('stop_protocol_version')!,
    certificateVersion: stringField('certificate_version')!,
    epoch: epoch as number,
    sessionRefDigest: stringField('session_ref_digest')!,
    hostLockDigest: stringField('host_lock_digest')!,
    contractRevision: revision as number,
    contractSha256: stringField('contract_sha256')!,
    openDigest: stringField('open_digest')!,
    evidenceSha256: stringField('evidence_sha256')!,
    bindingDigest: stringField('binding_digest')!,
    bindings,
    ...(goal ? { goalRef: { id: goal.id as string, revision: goal.revision as number } } : {}),
    certificationDigest: stringField('certification_digest')!,
    result: 'certified',
  }
}

function nextId(items: GuardProjection['items'], kind: GuardItemKind): string {
  const prefix = kind === 'requirement' ? 'R' : kind === 'acceptance' ? 'A' : 'P'
  let max = 0
  for (const item of items.values()) {
    if (item.kind !== kind) continue
    const num = Number(item.id.slice(prefix.length))
    if (Number.isInteger(num) && num > max) max = num
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`
}

/** Framing-only instruction clauses carry no task substance and never close. */
const FRAMING_ZH = /^(?:请)?(?:完成|执行|按|按照|遵循|满足)?(?:以下|如下|下面|下列)?(?:完整|全部)?(?:任务|要求|事项|需求|指令|说明)$/
const FRAMING_EN = /^(?:please\s+)?(?:complete|do|perform|follow|satisfy)?\s*(?:the\s+)?(?:following|below)?\s*(?:full\s+|whole\s+)?(?:task|tasks|requirement|requirements|instruction|instructions)$/i

function isInstructionFraming(body: string): boolean {
  return FRAMING_ZH.test(body) || FRAMING_EN.test(body)
}

/** Resolve a contract artifact path against the session working directory. */
function resolveArtifact(path: string, scope: DeriveScope): string {
  if (!scope.cwd) return path
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\')) return path
  return `${scope.cwd.replace(/[\\/]+$/, '')}/${path}`
}

/**
 * Capture one canonical root text through the authority-block segmentation.
 * `prefix` keeps the historical `m<seq>` source identity; a remainder uses
 * `m<seq>:r` so confirmation follow-ups stay traceable to their message.
 *
 * `legacy` marks a message that predates the first protocol boundary in this
 * log. Capture semantics are now version-independent (see `domain/semantics.ts`),
 * but a pre-boundary message keeps the historical authority relabelling rule:
 * an item whose action/target could not be derived deterministically stays
 * `legacy_authority_unclassified` instead of being retroactively authorized.
 */
function captureRootText(
  projection: GuardProjection,
  text: string,
  seq: number,
  scope: DeriveScope,
  legacy: boolean,
  priorRootMessages: string[],
  prefix = `m${seq}`,
  coordinationSplit = true,
): void {
  const blocks = segmentAuthorityBlocks(text, priorRootMessages)
  for (const block of blocks) {
    if (!block.capture) continue
    insertItems(
      projection,
      block.text,
      `${prefix}:${block.blockId}`,
      scope,
      block.authority === 'root_adoption' ? 'root_adoption' : 'root_instruction',
      legacy,
      block.kind === 'instruction' || block.authority === 'root_adoption',
      coordinationSplit,
    )
  }
  priorRootMessages.push(text)
  if (priorRootMessages.length > 16) priorRootMessages.shift()
}

/**
 * Insert every independently tracked clause from one user message. Compound
 * instructions are segmented and each distinct artifact path becomes its own
 * item, so evidence for one file cannot close a message that also covers other
 * files or embeds prohibitions.
 */
function insertItems(
  projection: GuardProjection,
  text: string,
  sourceMessageId: string,
  scope: DeriveScope,
  authority: 'root_instruction' | 'root_adoption' = 'root_instruction',
  legacy = false,
  legacyAuthorityProven = false,
  coordinationSplit = true,
): void {
  const before = new Set(projection.items.keys())
  for (const segment of segmentClauses(text, { coordinationSplit })) {
    // Session-layer clauses (progression phrases, meta questions) inside an
    // otherwise actionable message never become contract items.
    if (classifyUserInteraction(segment.body) === 'conversational') continue
    if (segment.kind === 'requirement' && segment.paths.length === 0 && isInstructionFraming(segment.body)) continue
    if (segment.paths.length === 0) {
      insert(projection, segment, sourceMessageId, scope.cwd || 'scope', 'scope')
      continue
    }
    for (const path of segment.paths) {
      insert(projection, segment, sourceMessageId, resolveArtifact(path, scope), 'artifact')
    }
  }
  // A new unconditional root instruction on the same action and target
  // RELEASES the reservation it matches: the wait a trusted input satisfies is
  // superseded, so no stale waiting obligation is left behind. The release is
  // derived from the durable message, never from model text.
  for (const [id, item] of projection.items) {
    if (before.has(id)) continue
    if (item.kind !== 'requirement' || item.waitAuthorization || item.authorityDisposition === 'conditional_wait') continue
    for (const [otherId, other] of projection.items) {
      if (otherId === id || other.status !== 'pending') continue
      if (!other.waitAuthorization || other.kind !== 'requirement') continue
      if (other.semanticAction !== item.semanticAction) continue
      // Only a stateful action carries the target identity a release must match.
      const action = item.semanticAction
      if (!action || !isStatefulAction(action)) continue
      if (!requestedTargetMatchesResolved(action, other.requestedTarget, item.requestedTarget)) continue
      supersedeItem(projection.items, otherId, item)
      break
    }
  }
  for (const [id, item] of projection.items) {
    if (before.has(id)) continue
    if (legacy) {
      const deterministicRebind = legacyAuthorityProven
        && item.semanticAction !== undefined && item.semanticAction !== 'generic_run'
        && item.targetCaptureStatus === 'resolved'
      if (deterministicRebind) {
        // `legacy_rebind`: immutable direct-root provenance plus a complete,
        // deterministic v3 action/target derivation restores eligibility.
        item.authority = authority
        item.legacyFlags = undefined
      } else {
        item.authority = 'legacy_authority_unclassified'
        item.semanticAction = 'generic_run'
        item.legacyFlags = ['legacy_generic_run', 'legacy_authority_unclassified']
      }
    } else {
      item.authority = authority
    }
  }
}

function insert(
  projection: GuardProjection,
  segment: ClauseSegment,
  sourceMessageId: string,
  subject: string,
  surface: 'artifact' | 'scope',
): void {
  const revision = projection.contractRevision + 1
  const id = nextId(projection.items, segment.kind)
  const method = extractMethod(segment.body)
  const operation = extractOperation(segment.body)
  const item = captureItem(
    segment.kind, segment.body, sourceMessageId, id, revision, subject, surface, method, operation,
    segment.interpretation,
  )
  const duplicate = [...projection.items.values()].find(
    (existing) => existing.kind === segment.kind
      && existing.status === 'pending'
      && existing.textSha256 === item.textSha256
      && existing.verification.subject === subject,
  )
  if (duplicate) supersedeItem(projection.items, duplicate.id, item)
  else projection.items.set(id, item)
  projection.contractRevision = item.revision
}

/**
 * Pure, deterministic re-derivation of the guard projection from the DSH
 * native event log. Context Guard never writes custom session events, so every
 * piece of state is derived from `command/run`, `user/message`, `tool/call`,
 * `tool/result`, `tool/ptc-dispatch-start`, `tool/ptc-dispatch`, and
 * `compaction/summary`.
 */
export function deriveProjection(
  sourceEvents: readonly DerivedEnvelope[],
  config: DeriveConfig,
  scope: DeriveScope,
  durableConfirmed: boolean,
  hostLock: HostLockEvaluation = DEFAULT_HOST_LOCK,
): DeriveResult {
  const projection = createProjection()
  if (scope.sessionHeader) projection.sessionRefDigest = sessionRefDigest(scope.sessionHeader)
  projection.hostLockDigest = hostLock.digest
  projection.hostStatus = hostLock.status
  projection.hostReasonCode = hostLock.reasonCode
  projection.hostCohortId = hostLock.cohortId
  let enabled = config.activation === 'always'
  let epoch = 0
  let evidenceCounter = 0
  let compacted = false
  let enablementTransitioned = false
  let lastCompactionSeq = -1
  const pendingCalls = new Map<string, PendingCall>()
  const v4BoundarySeq = sourceEvents.find(event => isProtocolBoundaryNotice(event, PROTOCOL_V4_NOTICE))?.seq
  const protocolBoundarySeq = sourceEvents.find(event => isProtocolBoundaryNotice(event) || isProtocolBoundaryNotice(event, PROTOCOL_V4_NOTICE))?.seq
  const captureBoundarySeq = sourceEvents.find(event => isProtocolBoundaryNotice(event, CAPTURE_V042_NOTICE) || isProtocolBoundaryNotice(event, PROTOCOL_V4_NOTICE))?.seq
  const priorRootMessages: string[] = []
  let realRootInputSeen = false

  for (const event of sourceEvents) {
    projection.enabled = enabled
    projection.lastObservedSourceSeq = Math.max(projection.lastObservedSourceSeq, event.seq)
    switch (event.type) {
      case 'command/run': {
        const data = asRecord(event.data)
        if (data?.name !== 'context-guard') break
        const source = asRecord(data.source)
        if (source?.kind !== 'user') break
        const subcommand = typeof data.args === 'string' ? data.args.trim().split(/\s+/, 1)[0] : ''
        if (subcommand === 'on' && !enabled) {
          enabled = true
          epoch += 1
          enablementTransitioned = true
          projection.epoch = epoch
        } else if (subcommand === 'off') {
          enabled = false
        } else if (subcommand === 'clear') {
          // Explicit remediation: supersede every pending requirement and
          // acceptance under a CLEAR sentinel (prohibitions are retained) and
          // bump the revision, so a fresh empty-binding checkpoint can certify
          // while the guard stays enabled. Replayable from the logged command.
          const revision = projection.contractRevision + 1
          for (const item of projection.items.values()) {
            if (item.kind === 'prohibition' || item.status !== 'pending') continue
            item.status = 'superseded'
            item.supersededBy = `CLEAR:${revision}`
          }
          projection.contractRevision = revision
        }
        break
      }
      case 'compaction/summary':
        compacted = true
        lastCompactionSeq = event.seq
        break
      case 'turn/start': {
        // The host's own turn identity. Recorded, never inferred: Guard has no
        // reliable way to count turns from the log, and a fabricated identity
        // would move the no-progress budget for reasons the host never saw.
        const started = asRecord(event.data)
        if (typeof started?.turn === 'number' && Number.isSafeInteger(started.turn)) projection.hostTurn = started.turn
        break
      }
      case 'user/message': {
        if (isProtocolBoundaryNotice(event) || isProtocolBoundaryNotice(event, CAPTURE_V042_NOTICE) || isProtocolBoundaryNotice(event, PROTOCOL_V4_NOTICE)) break
        // The no-progress budget lives in the log, so it is read back here
        // before anything that depends on activation: the record is a fact about
        // what Guard already decided, and a reload must restore the budget
        // rather than restart it. Attempts are held in a set, so replaying the
        // same log — or processing the same record twice — cannot spend the
        // budget twice.
        {
          const record = asRecord(event.data)
          const recordSource = asRecord(record?.source)
          const recordText = extractTextContent((record?.content as unknown[] | undefined) ?? [])
          if (recordSource?.kind === 'plugin' && recordSource.plugin === 'context-guard' && recordText.startsWith(NO_PROGRESS_RECORD_PREFIX)) {
            const parsed = asRecord(parseArguments(recordText.slice(NO_PROGRESS_RECORD_PREFIX.length)))
            const fingerprint = typeof parsed?.fingerprint === 'string' ? parsed.fingerprint : undefined
            const attempt = typeof parsed?.attempt === 'number' && Number.isSafeInteger(parsed.attempt) && parsed.attempt > 0 ? parsed.attempt : undefined
            const boundaryKey = typeof parsed?.boundaryKey === 'string' ? parsed.boundaryKey : undefined
            if (fingerprint && attempt !== undefined && boundaryKey !== undefined) {
              const claims = projection.noProgressClaims.get(fingerprint) ?? new Map<string, number>()
              // Same boundary, same attempt: a repeated record is the same claim.
              if (!claims.has(boundaryKey)) claims.set(boundaryKey, attempt)
              projection.noProgressClaims.set(fingerprint, claims)
            }
            break
          }
          if (recordSource?.kind === 'plugin' && recordSource.plugin === 'context-guard' && recordText.startsWith(CONTROL_RECORD_PREFIX)) {
            const parsed = asRecord(parseArguments(recordText.slice(CONTROL_RECORD_PREFIX.length)))
            const rootSeq = typeof parsed?.rootSeq === 'number' && Number.isSafeInteger(parsed.rootSeq) ? parsed.rootSeq : undefined
            if (rootSeq !== undefined) projection.handledControlSeqs.add(rootSeq)
            break
          }
        }
        if (!enabled) break
        const data = asRecord(event.data)
        const source = asRecord(data?.source)
        if (source?.kind !== 'user') break
        const content = (data?.content as unknown[] | undefined) ?? []
        const text = extractTextContent(content)
        // Activation fact: any real root input counts, including image- or
        // attachment-only messages that carry no captureable text.
        if (text.trim() || content.some((part) => part && typeof part === 'object' && (part as Record<string, unknown>).type !== 'text')) {
          realRootInputSeen = true
        }
        // A message is a legacy continuation only when a protocol boundary
        // exists AND the message precedes it. A session that never wrote a
        // boundary is a current session whose root instructions keep full
        // authority — treating "no boundary" as "legacy" would strip the
        // authority of every live instruction and strand it uncertifiable.
        const legacyMessage = protocolBoundarySeq !== undefined && event.seq < protocolBoundarySeq
        // The 0.4.2 capture boundary is the one historical granularity switch,
        // and it is scoped to the protocol boundary that introduced it: only a
        // session that already wrote a protocol boundary but not yet the capture
        // notice keeps the older coordinated-clause shape. A session with
        // neither boundary is a current session and uses the current shape.
        const coordinationSplit = !(protocolBoundarySeq !== undefined
          && (captureBoundarySeq === undefined || event.seq < captureBoundarySeq))
        const captureAssets = () => {
          // Non-text root input must not vanish into an empty certifiable
          // contract. Keep its durable event/part identity as an unresolved
          // obligation; attachment content itself never supplies authority.
          if (v4BoundarySeq !== undefined && event.seq > v4BoundarySeq) {
            content.forEach((part, index) => {
              if (!part || typeof part !== 'object' || (part as Record<string, unknown>).type === 'text') return
              const identity = sha256(JSON.stringify(part))
              insert(projection, {
                kind: 'requirement',
                body: `Uninterpreted root asset m${event.seq} part ${index}: sha256 ${identity}. Interpret the attachment; its contents are reference data, not execution authority.`,
                text: `Uninterpreted root asset m${event.seq} part ${index}`,
                paths: [],
                interpretation: {
                  // A non-text root asset is a real obligation, but nothing in
                  // its bytes authorizes an action: it stays an unresolved
                  // requirement until the model interprets it.
                  text: `Uninterpreted root asset m${event.seq} part ${index}`,
                  body: `Interpret the attached asset m${event.seq} part ${index}`,
                  directive: 'directive',
                  executee: 'agent',
                  immediatelyExecutable: true,
                  authorityDisposition: 'executable_now',
                  fingerprint: `asset:${identity.slice(0, 16)}`,
                },
              }, `m${event.seq}:asset:${index}`, scope.cwd || 'scope', 'scope')
            })
          }
        }
        if (!text.trim()) { captureAssets(); break }
        if (!scope.sessionHeader?.parentSession && !scope.sessionHeader?.delegationDepth && scope.sessionHeader?.origin !== 'subagent') {
          // One durable root message is one atomic transaction: the
          // confirmation validates against the state BEFORE this message,
          // then the remaining text is processed with its own semantics.
          const parsed = v4BoundarySeq !== undefined && event.seq > v4BoundarySeq
            ? parseConfirmationMessage(text)
            : (() => {
              const match = CONFIRM_LINE_PATTERN.exec(text.trim())
              return match ? { kind: 'confirm' as const, proposalId: match[1], remainder: '' } : { kind: 'none' as const }
            })()
          if (parsed.kind === 'confirm') {
            const consumed = confirmRebind(projection, parsed.proposalId, `m${event.seq}`, durableConfirmed)
            if (consumed) {
              captureAssets()
              if (parsed.remainder) captureRootText(projection, parsed.remainder, event.seq, scope, legacyMessage, priorRootMessages, `m${event.seq}:r`, coordinationSplit)
              break
            }
          } else if (parsed.kind !== 'none') {
            // Malformed or ambiguous control text never confirms; the control
            // line itself is not task text, but the rest captures normally.
            captureAssets()
            projection.lastConfirmationRejection = { eventSeq: event.seq, kind: parsed.kind, reason: parsed.reason }
            const stripped = text.split(/\r?\n/).filter((line) => !CONFIRM_LINE_PATTERN.test(line.trim())).join('\n')
            if (!stripped.trim()) break
            captureRootText(projection, stripped, event.seq, scope, legacyMessage, priorRootMessages, `m${event.seq}`, coordinationSplit)
            break
          }
        }
        captureAssets()
        // Informational reports (acceptance receipts, pasted summaries/logs)
        // are not task instructions and never become contract items.
        if (isInformationalMessage(text)) break
        // Session-layer talk (progression phrases, meta questions, meta
        // comments) is not a task requirement either (v0.2.1).
        if (classifyUserInteraction(text) === 'conversational') break
        captureRootText(projection, text, event.seq, scope, legacyMessage, priorRootMessages, `m${event.seq}`, coordinationSplit)
        break
      }
      case 'goal/change': {
        const data = asRecord(event.data)
        const operation = String(data?.operation ?? '')
        if (operation === 'clear') {
          projection.currentGoalRef = undefined
          projection.currentGoalPhase = undefined
          projection.currentGoalActivation = undefined
          break
        }
        const goal = asRecord(data?.goal)
        const id = typeof goal?.id === 'string' ? goal.id : ''
        const revision = Number(goal?.revision ?? 0)
        const phase = String(goal?.phase ?? '')
        if (operation === 'complete' && enabled) {
          if (!hasCurrentCertificate(projection)) {
            projection.integrity = 'corrupt'
            projection.integrityViolations.push('goal_completion_without_certificate')
          }
        }
        if (id && Number.isSafeInteger(revision) && revision > 0) projection.currentGoalRef = { id, revision }
        if (phase === 'active' || phase === 'paused' || phase === 'blocked' || phase === 'complete') projection.currentGoalPhase = phase
        // Activation is process-local and is never replay authority. A fresh
        // Goal cache is disarmed; the runtime overwrites this field only from
        // a live GoalService readback.
        projection.currentGoalActivation = 'disarmed'
        break
      }
      case 'tool/call': {
        if (!enabled) break
        const data = asRecord(event.data)
        const callId = String(data?.callId ?? '')
        const call: PendingCall = {
          name: String(data?.name ?? ''),
          arguments: String(data?.arguments ?? ''),
          rootCallId: typeof data?.rootCallId === 'string' ? data.rootCallId : undefined,
        }
        if (call.name === 'context_guard_checkpoint') {
          const args = parseArguments(call.arguments)
          call.bindings = Array.isArray(args.bindings)
            ? args.bindings.map((binding) => {
                const record = asRecord(binding)
                const transition = asRecord(record?.expected_transition)
                return {
                  itemId: String(record?.item_id ?? ''),
                  evidenceIds: Array.isArray(record?.evidence_ids) ? record.evidence_ids.map(String) : [],
                  ...(typeof record?.semantic_action === 'string' ? { semanticAction: record.semantic_action as EvidenceBinding['semanticAction'] } : {}),
                  ...(asRecord(record?.requested_target) ? { requestedTarget: asRecord(record?.requested_target) as EvidenceBinding['requestedTarget'] } : {}),
                  ...(asRecord(record?.resolved_target) ? { resolvedTarget: asRecord(record?.resolved_target) as EvidenceBinding['resolvedTarget'] } : {}),
                  ...(asRecord(record?.observed_state) ? { observedState: asRecord(record?.observed_state) as EvidenceBinding['observedState'] } : {}),
                  ...(transition ? { expectedTransition: {
                    predicateId: String(transition.predicate_id ?? ''), version: Number(transition.version ?? 0),
                    predParamsKind: 'inline' as const,
                    ...(asRecord(transition.parameters) ? { parameters: asRecord(transition.parameters) as EvidenceBinding['requestedTarget'] } : {}),
                    ...(transition.pred_params_kind !== 'inline' ? { parameters: undefined } : {}),
                    ...(typeof transition.parameters_digest === 'string' ? { parametersDigest: transition.parameters_digest } : {}),
                  } } : {}),
                  ...(typeof record?.resolution_evidence_id === 'string' ? { resolutionEvidenceId: record.resolution_evidence_id } : {}),
                  ...(typeof record?.effect_evidence_id === 'string' ? { effectEvidenceId: record.effect_evidence_id } : {}),
                  ...(Array.isArray(record?.state_evidence_ids) ? { stateEvidenceIds: record.state_evidence_ids.map(String) } : {}),
                  ...(Array.isArray(record?.action_bindings) ? { actionBindings: record.action_bindings.map((entry) => {
                    const closure = asRecord(entry)
                    return {
                      action: String(closure?.action ?? '') as BindingActionClosure['action'],
                      evidenceIds: Array.isArray(closure?.evidence_ids) ? closure.evidence_ids.map(String) : [],
                      resolvedTarget: (asRecord(closure?.resolved_target) ?? {}) as BindingActionClosure['resolvedTarget'],
                      order: Number(closure?.order ?? 0),
                    }
                  }) } : {}),
                }
              })
            : []
        } else if (call.name === 'context_guard_boundary') {
          const args = parseArguments(call.arguments)
          call.boundaryRequest = {
            disposition: String(args.disposition) as BoundaryRequest['disposition'],
            qualificationKind: String(args.qualification_kind) as BoundaryRequest['qualificationKind'],
            qualificationIds: Array.isArray(args.qualification_ids) ? args.qualification_ids.map(String) : [],
            callId,
          }
        }
        pendingCalls.set(callId, call)
        break
      }
      case 'tool/ptc-dispatch-start': {
        if (!enabled) break
        const data = asRecord(event.data)
        const subCallId = String(data?.subCallId ?? '')
        const rawArguments = data?.arguments
        pendingCalls.set(subCallId, {
          name: String(data?.name ?? ''),
          arguments: typeof rawArguments === 'string' ? rawArguments : JSON.stringify(rawArguments ?? ''),
          rootCallId: typeof data?.rootCallId === 'string' ? data.rootCallId : undefined,
        })
        break
      }
      case 'tool/result':
      case 'tool/ptc-dispatch': {
        if (!enabled) break
        const data = asRecord(event.data)
        const isDispatch = event.type === 'tool/ptc-dispatch'
        const message = asRecord(data?.message)
        const source = asRecord(message?.source)
        const callId = String(source?.callId ?? (isDispatch ? data?.subCallId : '') ?? '')
        const call = pendingCalls.get(callId)
        if (!call) break
        pendingCalls.delete(callId)
        const dispatchContent = isDispatch ? (data?.content as unknown[] | undefined) : undefined
        const textContent = extractTextContent(dispatchContent ?? (message?.content as unknown[] | undefined) ?? [])
        if (call.name === 'context_guard_rebind') {
          // Proposal registration is replay bookkeeping and runs in every
          // rebuild; the confirmation itself stays durable-gated inside
          // confirmRebind, so a pending proposal can never authorize without
          // a durable root event.
          if (!call.rootCallId && !data?.error) {
            const rebindArgs = parseArguments(call.arguments) as unknown as RebindArgs
            const recordedResponse = parseArguments(textContent)
            replayRebindResult(projection, rebindArgs, recordedResponse)
            // Log-derived retry ledger: a recorded rejection feeds the stable
            // attempt key so identical retries collapse onto `unchanged`.
            if (recordedResponse.status === 'rejected' && typeof recordedResponse.reason_code === 'string') {
              const key = rebindAttemptKey(projection, rebindArgs, recordedResponse.reason_code)
              projection.rebindRejections.set(key, (projection.rebindRejections.get(key) ?? 0) + 1)
            }
          }
          break
        }
        if (call.name === 'context_guard_checkpoint') {
          // A checkpoint is restored only when the history already recorded it
          // as certified AND the re-derived evidence still certifies it. Any
          // other combination fails closed; a persisted "incomplete" is never
          // promoted to a certificate.
          const recorded = parseArguments(textContent)
          if (recorded.status !== 'certified') {
            if ((call.bindings?.length ?? 0) > 0) {
              const rejected = certifyCheckpoint(projection, call.bindings ?? [], 'diagnostic', false)
              projection.lastCheckpointRejections = rejected.rejectedBindings
              projection.lastCheckpointRejectionRevision = projection.contractRevision
            }
            break
          }
          if (!asRecord(recorded.certificate)) {
            for (const binding of call.bindings ?? []) {
              const item = projection.items.get(binding.itemId)
              if (item) {
                // Preserve the historical closure asserted by the old
                // checkpoint, but never restore its certificate as current
                // v3 Goal/Stop authority.
                item.status = 'passed'
                if (!item.legacyFlags?.includes('legacy_generic_run')) {
                  item.legacyFlags = [...(item.legacyFlags ?? []), 'legacy_generic_run']
                }
              }
            }
            projection.integrityViolations.push('legacy_certificate_non_authoritative')
            break
          }
          const recordedCertificate = asRecord(recorded.certificate)!
          if (recordedCertificate.host_lock_digest !== projection.hostLockDigest) {
            const stale = restoreHistoricalCheckpoint(recordedCertificate, call.bindings ?? [], `C${projection.checkpoints.length + 1}`)
            if (!stale) {
              projection.integrity = 'corrupt'
              projection.integrityViolations.push('certificate_replay_mismatch')
              break
            }
            projection.checkpoints.push(stale)
            projection.certificateStatusReason = 'stale_host_lock'
            break
          }
          const id = `C${projection.checkpoints.length + 1}`
          const result = certifyCheckpoint(projection, call.bindings ?? [], id, false)
          if (result.status !== 'certified' || !result.checkpoint || !recordedCertificateMatches(recorded.certificate, result.checkpoint)) {
            projection.integrity = 'corrupt'
            projection.integrityViolations.push('certificate_replay_mismatch')
          } else {
            certifyCheckpoint(projection, call.bindings ?? [], id, true)
          }
          break
        }
        if (call.name === 'context_guard_boundary') {
          const recorded = parseArguments(textContent)
          const candidate = call.boundaryRequest ? qualifyBoundary(projection, call.boundaryRequest) : undefined
          const boundary = asRecord(recorded.boundary)
          if (candidate && recorded.status === 'unknown') {
            projection.boundaries.push({
              ...candidate,
              persistedResult: 'unknown',
              reasonCode: typeof recorded.reason_code === 'string' ? recorded.reason_code : 'boundary_persistence_unknown',
            })
            break
          }
          if (!candidate || recorded.status !== candidate.persistedResult || boundary?.candidate_sha256 !== candidate.candidateSha256) {
            projection.integrity = 'corrupt'
            projection.integrityViolations.push('boundary_replay_mismatch')
          } else {
            projection.boundaries.push(candidate)
          }
          break
        }
        evidenceCounter += 1
        const evidence = withDurability(evidenceFromPersistedToolResult(
          {
            callId,
            name: call.name,
            arguments: call.arguments,
            rootCallId: call.rootCallId,
          },
          { seq: event.seq, error: data?.error ?? (isDispatch && data?.isError ? { name: 'code', code: 'DISPATCH_ERROR' } : undefined), meta: data?.meta, textContent },
          epoch,
          `E${String(evidenceCounter).padStart(4, '0')}`,
          scope.cwd || undefined,
          hostLock,
        ), durableConfirmed)
        projection.evidence.set(evidence.id, evidence)
        if (evidence.externalOperationRef) {
          projection.externalOperations.set(evidence.externalOperationRef.id, evidence.externalOperationRef)
        }
        break
      }
      default:
        break
    }
  }
  projection.enabled = enabled
  projection.epoch = epoch
  return { projection, compacted, enablementTransitioned, lastCompactionSeq, realRootInputSeen, protocolV4Present: v4BoundarySeq !== undefined }
}
