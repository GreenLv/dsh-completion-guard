import { createHash } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { sessionRefDigest } from './digest.js'
import { snapshotSessionEvents } from './session-events.js'
import type { HostLockEvaluation } from './host-lock.js'
import type { DerivedEnvelope, GuardProjection } from './types.js'

/** A read-only observation of the Host's default cwd at one tool call. */
export const HOST_WORKDIR_PREFIX = 'context_guard_host_workdir_v1:'

export interface HostWorkdirReceipt {
  version: 1
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
  const refs = new Set(unit.rootInputRefs.map((ref) => ref.seq))
  const candidates = [...projection.items.values()].flatMap((item) => {
    const source = /^m(\d+)(?::|$)/u.exec(item.sourceMessageId)
    const named = /\b(?:npm|pnpm)\s+test\b/iu.exec(item.normalizedText)
    if (item.unitId !== projection.currentUnitId || item.status !== 'pending'
      || item.semanticAction !== 'test' || item.authorityDisposition !== 'executable_now'
      || item.needsReview || item.condition || item.waitAuthorization
      || item.requestedTarget?.scope !== session.header.cwd
      || !source || !refs.has(Number(source[1])) || named?.[0].toLowerCase().replace(/\s+/gu, ' ') !== command) return []
    return [Number(source[1])]
  })
  return candidates.length === 1 ? candidates[0] : undefined
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
  attestedDefaultRoute: boolean, sourcedRootSeq?: number | null): HostWorkdirReceipt | undefined {
  if (!attestedDefaultRoute || exec.agent?.session !== session || exec.parent !== undefined || exec.rootCallId !== exec.callId
    || sourcedRootSeq === null
    || (exec.name !== 'bash' && exec.name !== 'pwsh') || hostLock.status !== 'supported'
    || !hostLock.auditedForegroundRenderers?.includes(exec.name)) return undefined
  const args = row(exec.arguments)
  if (Object.hasOwn(args, 'workdir') || args.run_in_background === true) return undefined
  const header = row(session.header)
  const cwd = physicalDirectory(header.cwd)
  if (!cwd || typeof header.id !== 'string') return undefined
  let policyRoot: string | null = null
  let policySource: HostWorkdirReceipt['policySource'] = exec.name === 'pwsh' ? 'pwsh-header' : 'bash-policy'
  if (exec.name === 'bash') {
    if (!sandboxPolicy) return undefined
    let resolved: Record<string, unknown>
    try { resolved = row(sandboxPolicy.resolve({ session })) } catch { return undefined }
    if (resolved.sessionId !== header.id) return undefined
    const physical = physicalDirectory(resolved.workspaceRoot)
    if (!physical || physical !== cwd) return undefined
    policyRoot = physical
    policySource = 'bash-policy'
  }
  const events = snapshotSessionEvents(session) as DerivedEnvelope[]
  const callId = String(exec.callId)
  const calls = events.filter((event) => event.type === 'tool/call' && row(event.data).callId === callId)
  if (calls.length !== 1) return undefined
  const call = calls[0]!
  if (row(call.data).name !== exec.name || typeof row(call.data).arguments !== 'string') return undefined
  let loggedArgs: unknown
  try { loggedArgs = JSON.parse(String(row(call.data).arguments)) } catch { return undefined }
  if (!isDeepStrictEqual(loggedArgs, exec.arguments)) return undefined
  const roots = events.filter((event) => event.type === 'user/message' && row(row(event.data).source).kind === 'user'
    && event.seq < call.seq)
  const root = sourcedRootSeq === undefined ? roots.at(-1) : roots.find((event) => event.seq === sourcedRootSeq)
  const turnStart = events.filter((event) => event.type === 'turn/start' && event.seq < call.seq).at(-1)
  if (!root || !turnStart || (sourcedRootSeq === undefined && root.seq <= turnStart.seq)
    || row(turnStart.data).turn !== row(call.data).turn) return undefined
  const inherited = (session as unknown as { inheritedEventCount?: unknown }).inheritedEventCount
  if (header.version !== 3 || typeof header.createdAt !== 'number' || typeof header.isSeeded !== 'boolean'
    || typeof inherited !== 'number' || !Number.isSafeInteger(inherited)) return undefined
  const sessionDigest = sessionRefDigest({
    version: 3, id: header.id, createdAt: header.createdAt,
    seedLength: inherited,
    ...(typeof header.parentSession === 'string' ? { parentSession: header.parentSession } : {}),
    ...(typeof header.agentPreset === 'string' ? { agentPreset: header.agentPreset } : {}),
    ...(typeof header.origin === 'string' ? { origin: header.origin } : {}),
    delegationDepth: typeof header.delegationDepth === 'number' ? header.delegationDepth : 0,
  })
  return {
    version: 1, callId, callSeq: call.seq, rootSeq: root.seq, turn: Number(row(call.data).turn),
    toolName: exec.name, sessionRefDigest: sessionDigest, headerCwd: cwd, effectiveCwd: cwd,
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
  const notices = events.filter((event) => event.seq > call.seq && event.seq < result.seq
    && event.type === 'user/message' && row(row(event.data).source).kind === 'plugin'
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
  if (receipt.version !== 1 || receipt.callId !== callId || receipt.callSeq !== call.seq
    || receipt.rootSeq !== rootSeq || receipt.turn !== callData.turn
    || receipt.toolName !== callData.name || receipt.sessionRefDigest !== sessionDigest
    || receipt.hostLockDigest !== hostDigest || receipt.headerCwd !== headerCwd
    || receipt.effectiveCwd !== headerCwd || receipt.argumentsSha256 !== hash(callData.arguments)) return undefined
  if (receipt.toolName === 'bash') {
    if (receipt.policySource !== 'bash-policy' || receipt.policyRoot !== headerCwd) return undefined
  } else if (receipt.toolName !== 'pwsh' || receipt.policySource !== 'pwsh-header' || receipt.policyRoot !== null) return undefined
  return headerCwd
}
