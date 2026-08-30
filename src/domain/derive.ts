import { captureItem, extractMethod, extractOperation, isInformationalMessage, segmentClauses } from './capture.js'
import { certifyCheckpoint } from './checkpoint.js'
import { qualifyBoundary, type BoundaryRequest } from './boundary.js'
import { classifyUserInteraction } from './conversation.js'
import { segmentAuthorityBlocks } from './contract-segment.js'
import { sessionRefDigest } from './digest.js'
import { DEFAULT_HOST_LOCK, type HostLockEvaluation } from './host-lock.js'
import { hasCurrentCertificate } from './goal-gate.js'
import { evidenceFromPersistedToolResult, extractTextContent, withDurability } from './evidence.js'
import { supersedeItem } from './supersession.js'
import { createProjection, type GuardCheckpoint, type GuardProjection, type EvidenceBinding, type GuardItemKind } from './types.js'
import type { DeriveConfig, DeriveResult, DeriveScope, DerivedEnvelope } from './types.js'

interface PendingCall {
  name: string
  arguments: string
  rootCallId?: string
  bindings?: EvidenceBinding[]
  boundaryRequest?: BoundaryRequest
}

export const PROTOCOL_V3_NOTICE = 'Context Guard protocol boundary: v3.0.0'

function isProtocolBoundaryNotice(event: DerivedEnvelope): boolean {
  if (event.type !== 'user/message') return false
  const data = asRecord(event.data)
  const source = asRecord(data?.source)
  if (source?.kind !== 'plugin' || source.plugin !== 'context-guard' || source.form !== 'notice') return false
  return extractTextContent((data?.content as unknown[] | undefined) ?? []) === PROTOCOL_V3_NOTICE
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
): void {
  const before = new Set(projection.items.keys())
  for (const segment of segmentClauses(text)) {
    // Session-layer clauses (progression phrases, meta questions) inside an
    // otherwise actionable message never become contract items.
    if (classifyUserInteraction(segment.body) === 'conversational') continue
    if (segment.kind === 'requirement' && segment.paths.length === 0 && isInstructionFraming(segment.body)) continue
    if (segment.kind === 'prohibition' || segment.paths.length === 0) {
      insert(projection, segment.kind, segment.body, sourceMessageId, scope.cwd || 'scope', 'scope')
      continue
    }
    for (const path of segment.paths) {
      insert(projection, segment.kind, segment.body, sourceMessageId, resolveArtifact(path, scope), 'artifact')
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
  kind: GuardItemKind,
  body: string,
  sourceMessageId: string,
  subject: string,
  surface: 'artifact' | 'scope',
): void {
  const revision = projection.contractRevision + 1
  const id = nextId(projection.items, kind)
  const method = extractMethod(body)
  const operation = extractOperation(body)
  const item = captureItem(kind, body, sourceMessageId, id, revision, subject, surface, method, operation)
  const duplicate = [...projection.items.values()].find(
    (existing) => existing.kind === kind
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
 * `tool/result`, `tool/code-dispatch-start`, `tool/code-dispatch`, and
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
  let enabled = config.activation === 'always'
  let epoch = 0
  let evidenceCounter = 0
  let compacted = false
  let enablementTransitioned = false
  let lastCompactionSeq = -1
  const pendingCalls = new Map<string, PendingCall>()
  const protocolBoundarySeq = sourceEvents.find(isProtocolBoundaryNotice)?.seq
  const priorRootMessages: string[] = []

  for (const event of sourceEvents) {
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
      case 'user/message': {
        if (isProtocolBoundaryNotice(event)) break
        if (!enabled) break
        const data = asRecord(event.data)
        const source = asRecord(data?.source)
        if (source?.kind !== 'user') break
        const content = (data?.content as unknown[] | undefined) ?? []
        const text = extractTextContent(content)
        if (!text.trim()) break
        // Informational reports (acceptance receipts, pasted summaries/logs)
        // are not task instructions and never become contract items.
        if (isInformationalMessage(text)) break
        // Session-layer talk (progression phrases, meta questions, meta
        // comments) is not a task requirement either (v0.2.1).
        if (classifyUserInteraction(text) === 'conversational') break
        const blocks = segmentAuthorityBlocks(text, priorRootMessages)
        for (const block of blocks) {
          if (!block.capture) continue
          insertItems(
            projection,
            block.text,
            `m${event.seq}:${block.blockId}`,
            scope,
            block.authority === 'root_adoption' ? 'root_adoption' : 'root_instruction',
            protocolBoundarySeq !== undefined && event.seq < protocolBoundarySeq,
            block.kind === 'instruction' || block.authority === 'root_adoption',
          )
        }
        priorRootMessages.push(text)
        if (priorRootMessages.length > 16) priorRootMessages.shift()
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
      case 'tool/code-dispatch-start': {
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
      case 'tool/code-dispatch': {
        if (!enabled) break
        const data = asRecord(event.data)
        const isDispatch = event.type === 'tool/code-dispatch'
        const message = asRecord(data?.message)
        const source = asRecord(message?.source)
        const callId = String(source?.callId ?? (isDispatch ? data?.subCallId : '') ?? '')
        const call = pendingCalls.get(callId)
        if (!call) break
        pendingCalls.delete(callId)
        const dispatchContent = isDispatch ? (data?.content as unknown[] | undefined) : undefined
        const textContent = extractTextContent(dispatchContent ?? (message?.content as unknown[] | undefined) ?? [])
        if (call.name === 'context_guard_checkpoint') {
          // A checkpoint is restored only when the history already recorded it
          // as certified AND the re-derived evidence still certifies it. Any
          // other combination fails closed; a persisted "incomplete" is never
          // promoted to a certificate.
          const recorded = parseArguments(textContent)
          if (recorded.status !== 'certified') break
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
  return { projection, compacted, enablementTransitioned, lastCompactionSeq }
}
