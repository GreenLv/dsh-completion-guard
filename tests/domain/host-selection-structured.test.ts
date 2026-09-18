import { expect, it } from 'vitest'
import { deriveTrustedSelections } from '../../src/domain/host-selection.js'
import type { DerivedEnvelope } from '../../src/domain/types.js'

const call: DerivedEnvelope = { seq: 1, type: 'tool/call', data: {
  callId: 'question-1', name: 'question', arguments: JSON.stringify({
    question_id: 'scope', question: 'Which directory?', options: ['/work/a', '/work/b'],
  }),
} }
const result = (content: unknown[]): DerivedEnvelope => ({ seq: 2, type: 'tool/result', data: {
  message: { source: { kind: 'tool', callId: 'question-1' }, content },
} })
const nested = (toolCallId: string, isError: boolean) => [{ type: 'tool-result', toolCallId, isError,
  content: [{ type: 'text', text: JSON.stringify({ answer: '/work/a' }) }] }]
const selected = (value: DerivedEnvelope) => deriveTrustedSelections([call, value], { questionToolNames: ['question'] })

it('records a paired SDK question return as the selected directory', () => {
  expect(selected(result(nested('question-1', false)))).toMatchObject([{
    callId: 'question-1', selected: '/work/a', kind: 'directory',
  }])
})

it('does not upgrade renderer-only, failed, or mismatched returns into a trusted choice', () => {
  expect(selected(result([{ type: 'text', text: JSON.stringify({ answer: '/work/a' }) }]))).toEqual([])
  expect(selected(result(nested('question-1', true)))).toEqual([])
  expect(selected(result(nested('other', false)))).toEqual([])
})
