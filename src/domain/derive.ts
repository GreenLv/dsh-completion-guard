import { captureItem, extractMethod, extractOperation, segmentClauses } from './capture.js'
import { certifyCheckpoint } from './checkpoint.js'
import { evidenceFromPersistedToolResult, extractTextContent, withDurability } from './evidence.js'
import { supersedeItem } from './supersession.js'
import { createProjection, type GuardProjection, type EvidenceBinding, type GuardItemKind } from './types.js'
import type { DeriveConfig, DeriveResult, DeriveScope, DerivedEnvelope } from './types.js'

interface PendingCall {
  name: string
  arguments: string
  rootCallId?: string
  bindings?: EvidenceBinding[]
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
function insertItems(projection: GuardProjection, text: string, sourceMessageId: string, scope: DeriveScope): void {
  for (const segment of segmentClauses(text)) {
    if (segment.kind === 'requirement' && segment.paths.length === 0 && isInstructionFraming(segment.body)) continue
    if (segment.kind === 'prohibition' || segment.paths.length === 0) {
      insert(projection, segment.kind, segment.body, sourceMessageId, scope.cwd || 'scope', 'scope')
      continue
    }
    for (const path of segment.paths) {
      insert(projection, segment.kind, segment.body, sourceMessageId, resolveArtifact(path, scope), 'artifact')
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
): DeriveResult {
  const projection = createProjection()
  let enabled = config.activation === 'always'
  let epoch = 0
  let evidenceCounter = 0
  let compacted = false
  let enablementTransitioned = false
  let lastCompactionSeq = -1
  const pendingCalls = new Map<string, PendingCall>()

  for (const event of sourceEvents) {
    projection.lastObservedSourceSeq = Math.max(projection.lastObservedSourceSeq, event.seq)
    switch (event.type) {
      case 'command/run': {
        const data = asRecord(event.data)
        if (data?.name !== 'context-guard') break
        const subcommand = typeof data.args === 'string' ? data.args.trim().split(/\s+/, 1)[0] : ''
        if (subcommand === 'on' && !enabled) {
          enabled = true
          epoch += 1
          enablementTransitioned = true
          projection.epoch = epoch
        } else if (subcommand === 'off') {
          enabled = false
        }
        break
      }
      case 'compaction/summary':
        compacted = true
        lastCompactionSeq = event.seq
        break
      case 'user/message': {
        if (!enabled) break
        const data = asRecord(event.data)
        const source = asRecord(data?.source)
        if (source?.kind !== 'user') break
        const content = (data?.content as unknown[] | undefined) ?? []
        const text = extractTextContent(content)
        if (!text.trim()) break
        insertItems(projection, text, `m${event.seq}`, scope)
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
                return {
                  itemId: String(record?.item_id ?? ''),
                  evidenceIds: Array.isArray(record?.evidence_ids) ? record.evidence_ids.map(String) : [],
                }
              })
            : []
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
          const result = certifyCheckpoint(projection, call.bindings ?? [], `C${projection.checkpoints.length + 1}`)
          if (result.status !== 'certified') projection.integrity = 'corrupt'
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
        ), durableConfirmed)
        projection.evidence.set(evidence.id, evidence)
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
