import type { DerivedEnvelope } from './types.js'

/**
 * Trusted host-native selection adapter (0.6.0 DS06-D, C07/S06).
 *
 * Only a PAIRED durable tool round-trip can form a trusted user selection:
 * a `tool/call` whose arguments pose a question with explicit options, and
 * its successful `tool/result` carrying the answer, bound by the same
 * callId in the same session. Pasted answer text, a model restatement, or
 * the answer of another call can never form a selection. Path selections
 * and sandbox approvals are separate facts and are recorded separately.
 *
 * The question tool's name is a host tool-bundle surface: the adapter
 * matches a bounded allowlist supplied by the caller (production wires the
 * names audited for the running cohort; native acceptance pins them).
 */

export interface TrustedSelection {
  callId: string
  /** Sequence of the tool/result event that settled the selection. */
  resultSeq: number
  turn: number | undefined
  toolName: string
  questionId: string | undefined
  question: string | undefined
  options: string[]
  /** The answer the user actually chose, verbatim from the paired result. */
  selected: string
  /** A directory selection narrows where bounded file choices may land. */
  kind: 'directory' | 'value'
}

/**
 * The default question-tool allowlist. The real names are a host tool-bundle
 * surface: native acceptance pins the audited names for the running cohort,
 * and the runtime may override this list per cohort.
 */
export const DEFAULT_QUESTION_TOOL_NAMES: readonly string[] = ['question', 'ask_user']

export interface SelectionAdapterOptions {
  /** Audited question-tool names for the running host cohort. */
  questionToolNames: readonly string[]
}

interface QuestionCallShape {
  questionId?: string
  question?: string
  options: string[]
}

function parseQuestionCall(rawArguments: unknown): QuestionCallShape | undefined {
  if (typeof rawArguments !== 'string') return undefined
  let args: unknown
  try { args = JSON.parse(rawArguments) } catch { return undefined }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
  const record = args as Record<string, unknown>
  const rawOptions = record.options ?? record.choices
  if (!Array.isArray(rawOptions) || rawOptions.length === 0) return undefined
  const options: string[] = []
  for (const entry of rawOptions) {
    if (typeof entry !== 'string' || !entry.trim()) return undefined
    options.push(entry.trim())
  }
  const questionId = typeof record.question_id === 'string' ? record.question_id
    : typeof record.questionId === 'string' ? record.questionId : undefined
  const question = typeof record.question === 'string' ? record.question : undefined
  return { questionId, question, options }
}

function parseSelectionAnswer(content: unknown, options: string[]): string | undefined {
  if (!Array.isArray(content)) return undefined
  const text = content
    .filter((part): part is { type?: string; text?: string } => !!part && typeof part === 'object')
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n')
  if (!text.trim()) return undefined
  // The answer must be one of the offered options, verbatim: a tool result
  // that says something else is not this question's answer.
  const trimmed = text.trim()
  if (options.includes(trimmed)) return trimmed
  // The result may wrap the answer in a small JSON payload.
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    const answer = parsed.answer ?? parsed.selected ?? parsed.value
    if (typeof answer === 'string' && options.includes(answer.trim())) return answer.trim()
  } catch { /* plain text only */ }
  return undefined
}

function looksLikeDirectory(value: string): boolean {
  return /^[~.]?(?:[\\/][^\n]*)+$/.test(value)
}

/**
 * Derive the trusted selections from the durable log. Deterministic: a replay
 * of identical events yields identical selections.
 */
export function deriveTrustedSelections(events: readonly DerivedEnvelope[], options: SelectionAdapterOptions): TrustedSelection[] {
  const names = new Set(options.questionToolNames)
  interface Pending { callId: string; seq: number; turn: number | undefined; toolName: string; shape: QuestionCallShape }
  const pending = new Map<string, Pending>()
  const selections: TrustedSelection[] = []
  for (const event of events) {
    if (event.type === 'tool/call') {
      const data = (event.data ?? {}) as Record<string, unknown>
      const name = String(data.name ?? '')
      if (!names.has(name)) continue
      const shape = parseQuestionCall(data.arguments)
      if (!shape) continue
      pending.set(String(data.callId ?? ''), {
        callId: String(data.callId ?? ''), seq: event.seq, turn: typeof data.turn === 'number' ? data.turn : undefined,
        toolName: name, shape,
      })
      continue
    }
    if (event.type !== 'tool/result') continue
    const data = (event.data ?? {}) as { message?: { source?: { callId?: unknown }; content?: unknown }; error?: unknown }
    const callId = String(data.message?.source?.callId ?? '')
    const call = pending.get(callId)
    if (!call) continue
    pending.delete(callId)
    if (data.error !== undefined) continue
    const selected = parseSelectionAnswer(data.message?.content, call.shape.options)
    if (!selected) continue
    selections.push({
      callId,
      resultSeq: event.seq,
      turn: call.turn,
      toolName: call.toolName,
      questionId: call.shape.questionId,
      question: call.shape.question,
      options: call.shape.options,
      selected,
      kind: looksLikeDirectory(selected) ? 'directory' : 'value',
    })
  }
  return selections
}
