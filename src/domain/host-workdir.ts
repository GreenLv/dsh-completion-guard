import { createHash } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { sessionRefDigest } from './digest.js'
import { snapshotSessionEvents } from './session-events.js'
import { cwdEpochsFromEvents, effectiveCwdAt } from './cwd-timeline.js'
import type { HostLockEvaluation } from './host-lock.js'
import type { DerivedEnvelope, GuardProjection } from './types.js'

/** A read-only observation of the Host's default cwd at one tool call. */
export const HOST_WORKDIR_PREFIX = 'context_guard_host_workdir_v1:'

export interface HostWorkdirReceipt {
  version: 1 | 2
  callId: string
  callSeq: number
  rootSeq: number
  turn: number
  toolName: 'bash' | 'pwsh'
  sessionRefDigest: string
  headerCwd: string
  effectiveCwd: string
  policySource: 'bash-policy' | 'pwsh-header'
  policyRoot: string | null
  hostLockDigest: string
  argumentsSha256: string
  /** v2 only: the immutable Session header cwd (the original project root),
   * recorded when a `working-directory/change` moved the effective directory
   * the call actually ran in. Absent in v1 receipts, where the two coincide. */
  originCwd?: string
  /** v2 only: sequence of the governing `working-directory/change`, or -1
   * when none precedes the call (then effectiveCwd equals originCwd and a v1
   * receipt is written instead). */
  cwdEpochSeq?: number
}

const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')
const row = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}

/** Bind a call to exactly one still-current root-sourced named test. */
export function sourcedNamedTestRoot(projection: GuardProjection, session: Session, argumentsValue: unknown): number | undefined {
  const args = row(argumentsValue)
  const command = String(args.command ?? '').trim()
  if (!/^(?:npm|pnpm) test$/u.test(command) || !projection.currentUnitId) return undefined
  const unit = projection.units.get(projection.currentUnitId)
  if (!unit) return undefined
  // The obligation's scope was captured in the cwd epoch of its own root;
  // only a root captured in the SAME effective directory can source this
  // test run. The session header cwd governs pre-0.2.1 logs unchanged.
  const epochs = cwdEpochsFromEvents(snapshotSessionEvents(session) as DerivedEnvelope[], headerCwdOf(session))
  const refs = new Set(unit.rootInputRefs.map((ref) => ref.seq))
  const candidates = [...projection.items.values()].flatMap((item) => {
    const source = /^m(\d+)(?::|$)/u.exec(item.sourceMessageId)
    const named = /\b(?:npm|pnpm)\s+test\b/iu.exec(item.normalizedText)
    const rootSeq = source ? Number(source[1]) : undefined
    const scopeCwd = rootSeq !== undefined ? effectiveCwdAt(epochs, headerCwdOf(session), rootSeq) : undefined
    if (item.unitId !== projection.currentUnitId || item.status !== 'pending'
      || item.semanticAction !== 'test' || item.authorityDisposition !== 'executable_now'
      || item.needsReview || item.condition || item.waitAuthorization
      || !scopeCwd || item.requestedTarget?.scope !== scopeCwd
      || !source || !refs.has(Number(source[1])) || named?.[0].toLowerCase().replace(/\s+/gu, ' ') !== command) return []
    return [Number(source[1])]
  })
  return candidates.length === 1 ? candidates[0] : undefined
}

function headerCwdOf(session: Session): string | undefined {
  const header = row(session.header)
  return typeof header.cwd === 'string' && header.cwd.length > 0 ? header.cwd : undefined
}

function physicalDirectory(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  try {
    const physical = realpathSync(value)
    // A lexical alias has no portable path identity in core/v2. The Host may
    // execute it, but Guard must not claim an exact target from that spelling.
    return physical === value && statSync(physical).isDirectory() ? physical : undefined
  } catch { return undefined }
}

/**
 * Observe the actual audited Host call, without deciding whether it may run.
 * The sandbox-policy service is the same scoped service used by tool-bash;
 * absence or an unproved physical path simply emits no receipt.
 */
export function captureHostWorkdir(session: Session, exec: Readonly<ToolExecution>, hostLock: HostLockEvaluation,
  sandboxPolicy: { resolve(request: { session: Session }): unknown } | undefined,
  attestedDefaultRoute: boolean, sourcedRootSeq?: number | null, hostSessionFormatVersion: number = 4): HostWorkdirReceipt | undefined {
  // The standalone domain has no host imports. rc.2 is V4 only; the runtime
  // additionally passes the actual host export, so a changed host is refused.
  if (hostSessionFormatVersion !== 4 || !attestedDefaultRoute || exec.agent?.session !== session || exec.parent !== undefined || exec.rootCallId !== exec.callId
    || sourcedRootSeq === null
    || (exec.name !== 'bash' && exec.name !== 'pwsh') || hostLock.status !== 'supported'
    || !hostLock.auditedForegroundRenderers?.includes(exec.name)) return undefined
  const args = row(exec.arguments)
  if (Object.hasOwn(args, 'workdir') || args.run_in_background === true) return undefined
  const header = row(session.header)
  const originCwd = typeof header.cwd === 'string' && header.cwd.length > 0 ? header.cwd : undefined
  if (!originCwd || typeof header.id !== 'string') return undefined
  const events = snapshotSessionEvents(session) as DerivedEnvelope[]
  // The 0.2.1 effective directory travels in `working-directory/change`
  // events while the sandbox policy keeps resolving the immutable header
  // project. An unreadable timeline (or an unphysical effective directory)
  // emits no receipt — the epoch boundary is never guessed.
  const epochs = cwdEpochsFromEvents(events, originCwd)
  if (!epochs) return undefined
  let policyRoot: string | null = null
  let policySource: HostWorkdirReceipt['policySource'] = exec.name === 'pwsh' ? 'pwsh-header' : 'bash-policy'
  if (exec.name === 'bash') {
    if (!sandboxPolicy) return undefined
    let resolved: Record<string, unknown>
    try { resolved = row(sandboxPolicy.resolve({ session })) } catch { return undefined }
    if (resolved.sessionId !== header.id) return undefined
    const physical = physicalDirectory(resolved.workspaceRoot)
    if (!physical || physical !== originCwd) return undefined
    policyRoot = physical
    policySource = 'bash-policy'
  }
  const callId = String(exec.callId)
  const calls = events.filter((event) => event.type === 'tool/call' && row(event.data).callId === callId)
  if (calls.length !== 1) return undefined
  const call = calls[0]!
  if (row(call.data).name !== exec.name || typeof row(call.data).arguments !== 'string') return undefined
  let loggedArgs: unknown
  try { loggedArgs = JSON.parse(String(row(call.data).arguments)) } catch { return undefined }
  if (!isDeepStrictEqual(loggedArgs, exec.arguments)) return undefined
  // The effective cwd that governs THIS call, from the epoch timeline rather
  // than the current end-of-log directory.
  const effective = physicalDirectory(effectiveCwdAt(epochs, originCwd, call.seq))
  if (!effective) return undefined
  const roots = events.filter((event) => event.type === 'user/message' && row(row(event.data).source).kind === 'user'
    && event.seq < call.seq)
  const root = sourcedRootSeq === undefined ? roots.at(-1) : roots.find((event) => event.seq === sourcedRootSeq)
  const turnStart = events.filter((event) => event.type === 'turn/start' && event.seq < call.seq).at(-1)
  if (!root || !turnStart || (sourcedRootSeq === undefined && root.seq <= turnStart.seq)
    || row(turnStart.data).turn !== row(call.data).turn) return undefined
  const inherited = (session as unknown as { inheritedEventCount?: unknown }).inheritedEventCount
  if (header.version !== hostSessionFormatVersion || typeof header.createdAt !== 'number' || typeof header.isSeeded !== 'boolean'
    || typeof inherited !== 'number' || !Number.isSafeInteger(inherited)) return undefined
  const sessionDigest = sessionRefDigest({
    version: hostSessionFormatVersion, id: header.id, createdAt: header.createdAt,
    seedLength: inherited,
    ...(typeof header.parentSession === 'string' ? { parentSession: header.parentSession } : {}),
    ...(typeof header.agentPreset === 'string' ? { agentPreset: header.agentPreset } : {}),
    ...(typeof header.origin === 'string' ? { origin: header.origin } : {}),
    delegationDepth: typeof header.delegationDepth === 'number' ? header.delegationDepth : 0,
  })
  // A call still inside the header epoch keeps the historical v1 receipt,
  // byte-identical to pre-0.2.1 reads. Only a call under a committed
  // working-directory change writes the epoch-bound v2 shape.
  const governingEpoch = [...epochs].reverse().find((epoch) => epoch.seq <= call.seq)
  if (!governingEpoch) {
    return {
      version: 1, callId, callSeq: call.seq, rootSeq: root.seq, turn: Number(row(call.data).turn),
      toolName: exec.name, sessionRefDigest: sessionDigest, headerCwd: effective, effectiveCwd: effective,
      policySource, policyRoot, hostLockDigest: hostLock.digest,
      argumentsSha256: hash(String(row(call.data).arguments)),
    }
  }
  return {
    version: 2, callId, callSeq: call.seq, rootSeq: root.seq, turn: Number(row(call.data).turn),
    toolName: exec.name, sessionRefDigest: sessionDigest, headerCwd: effective, effectiveCwd: effective,
    originCwd, cwdEpochSeq: governingEpoch.seq,
    policySource, policyRoot, hostLockDigest: hostLock.digest,
    argumentsSha256: hash(String(row(call.data).arguments)),
  }
}

/** Validate the persisted observer record against the original call/result. */
export function hostWorkdirForCall(events: DerivedEnvelope[], call: DerivedEnvelope, result: DerivedEnvelope,
  rootSeq: number, sessionDigest: string, hostDigest: string, headerCwd: string): string | undefined {
  const callData = row(call.data)
  const callId = callData.callId
  if (typeof callId !== 'string' || typeof callData.arguments !== 'string') return undefined
  const nextAssistant = events.find((event) => event.seq > result.seq
    && (event.type === 'assistant/message' || event.type === 'turn/end'))
  const upperBound = nextAssistant?.seq ?? Number.POSITIVE_INFINITY
  const notices = events.filter((event) => event.seq > result.seq && event.seq < upperBound
    && event.type === 'user/message' && ['plugin', 'context-guard'].includes(String(row(row(event.data).source).kind))
    && row(row(event.data).source).plugin === 'context-guard'
    && row(row(event.data).source).form === 'notice'
    && Array.isArray(row(event.data).content)
    && String(row((row(event.data).content as unknown[])[0]).text ?? '').startsWith(HOST_WORKDIR_PREFIX))
  const candidates = notices.filter((event) => {
    try {
      const content = row((row(event.data).content as unknown[])[0]).text
      return row(JSON.parse(String(content).slice(HOST_WORKDIR_PREFIX.length))).callId === callId
    } catch { return false }
  })
  if (candidates.length !== 1) return undefined
  const content = row((row(candidates[0]!.data).content as unknown[])[0]).text
  let receipt: Record<string, unknown>
  try { receipt = row(JSON.parse(String(content).slice(HOST_WORKDIR_PREFIX.length))) } catch { return undefined }
  if (receipt.callId !== callId || receipt.callSeq !== call.seq
    || receipt.rootSeq !== rootSeq || receipt.turn !== callData.turn
    || receipt.toolName !== callData.name || receipt.sessionRefDigest !== sessionDigest
    || receipt.hostLockDigest !== hostDigest || receipt.headerCwd !== headerCwd
    || receipt.effectiveCwd !== headerCwd || receipt.argumentsSha256 !== hash(callData.arguments)) return undefined
  if (receipt.version === 2) {
    // Epoch-bound receipt: the governing change and the original project are
    // replayed from the SAME log, so a notice copied next to different
    // directory history cannot validate. The bound cwd still has to equal
    // the root locator base the caller holds — a test run in a DIFFERENT
    // epoch than the obligation's scope never certifies that scope.
    const originCwd = typeof receipt.originCwd === 'string' ? receipt.originCwd : ''
    const cwdEpochSeq = typeof receipt.cwdEpochSeq === 'number' && Number.isSafeInteger(receipt.cwdEpochSeq) ? receipt.cwdEpochSeq : undefined
    if (!originCwd || cwdEpochSeq === undefined) return undefined
    const epochs = cwdEpochsFromEvents(events, originCwd)
    if (!epochs) return undefined
    if (effectiveCwdAt(epochs, originCwd, call.seq) !== headerCwd) return undefined
    const governing = [...epochs].reverse().find((epoch) => epoch.seq <= call.seq)
    if (!governing || governing.seq !== cwdEpochSeq || governing.cwd !== headerCwd) return undefined
    if (receipt.toolName === 'bash') {
      if (receipt.policySource !== 'bash-policy' || receipt.policyRoot !== originCwd) return undefined
    } else if (receipt.toolName !== 'pwsh' || receipt.policySource !== 'pwsh-header' || receipt.policyRoot !== null) return undefined
    return headerCwd
  }
  if (receipt.version !== 1) return undefined
  if (receipt.toolName === 'bash') {
    if (receipt.policySource !== 'bash-policy' || receipt.policyRoot !== headerCwd) return undefined
  } else if (receipt.toolName !== 'pwsh' || receipt.policySource !== 'pwsh-header' || receipt.policyRoot !== null) return undefined
  return headerCwd
}
