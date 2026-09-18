import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createRuntime, handleGuardTurnStopping } from './runtime.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from './domain/host-lock.js'
import { PROTOCOL_V6_NOTICE } from './domain/derive.js'
import { goalCompletionDenial } from './domain/goal-gate.js'
import { observeAssistantOutcome } from './domain/stop-policy.js'
import { sessionCoreSnapshot } from './core-v2/session.js'
import type { DerivedEnvelope } from './domain/types.js'

export interface RawReplayInput {
  root: string
  final: string
  cwd?: string
  /** Synthetic host events, in persisted order; only for local replay. */
  events?: Array<{ type: string; data: unknown }>
}
/** Local synthetic replay using the actual Session, derivation and registered
 * Stop handler. It neither executes tools nor asserts a real model outcome. */
export async function replayRawV2(input: RawReplayInput): Promise<Record<string, unknown>> {
  const cwd = input.cwd ?? '/work'
  const id = SessionId('raw-v2-replay')
  const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, isSeeded: false, id, createdAt: 1, cwd })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }],
    source: { kind: 'plugin', plugin: 'context-guard', form: 'notice', summary: 'v6 replay boundary' } }), { surfaceOp: 'append' })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: input.root }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const appendEvent = (session as unknown as { append: (type: string, data: unknown, options: unknown) => unknown }).append.bind(session)
  for (const event of input.events ?? []) {
    if (event.type === 'turn/end') throw new Error('turn/end is emitted only after the Stop callback in this replay')
    appendEvent(event.type, event.data, event.type === 'tool/call' ? undefined : { surfaceOp: 'append' })
  }
  session.append('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: input.final }] } } as never, { surfaceOp: 'append' })
  const lock = evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' })
  const steers: unknown[] = []
  const agent = { session, steer: (message: unknown) => { steers.push(message) } } as never
  const runtime = createRuntime(agent, { activation: 'always' }, lock, () => undefined)
  runtime.setDurability(true)
  runtime.sync()
  const snapshot = sessionCoreSnapshot(session.snapshotEvents() as unknown as DerivedEnvelope[], runtime.projection)
  const stopCore = runtime.projection.coreV2 ?? null
  const stop = await handleGuardTurnStopping(agent, runtime, { flush: async () => true, hostSupported: true, readExternalOperation: () => undefined })
  // The host's turn-stopping callback precedes the durable turn/end delivery.
  // A final answer can close an information slot only in this later projection.
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } } as never)
  runtime.sync()
  const projection = runtime.projection
  const postSnapshot = sessionCoreSnapshot(session.snapshotEvents() as unknown as DerivedEnvelope[], projection)
  return { stop_core_snapshot: snapshot ?? null, stop_core_projection: stopCore, stop,
    post_turn_core_snapshot: postSnapshot ?? null, post_turn_core_projection: projection.coreV2 ?? null,
    goal_complete_denial: goalCompletionDenial(projection, 'update_goal', { action: 'complete', goal_id: projection.currentGoalRef?.id, revision: projection.currentGoalRef?.revision }) ?? null,
    assistant_observation: observeAssistantOutcome(input.final), steers: steers.length,
    items: [...projection.items.values()].map((item) => ({ id: item.id, status: item.status, action: item.semanticAction,
      authority: item.authority, disposition: item.authorityDisposition, review: item.needsReview?.reason ?? null })),
    durable_seq: session.seq, event_types: session.snapshotEvents().map((event) => ({ seq: event.seq, type: event.type })),
    boundary_protocol: projection.boundaryProtocol,
  }
}
