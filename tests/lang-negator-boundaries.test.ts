import { expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V6_NOTICE } from '../src/domain/derive.js'
import { segmentClauses } from '../src/domain/capture.js'
import { interpretMessage, itemHoldsExecutionAuthority } from '../src/domain/semantics.js'

function items(text: string) {
  const events = [
    { seq: 1, type: 'user/message', data: { source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }] } },
    { seq: 2, type: 'turn/start', data: { turn: 1 } },
    { seq: 3, type: 'user/message', data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text }] } },
  ]
  return [...deriveProjection(events, { activation: 'always' }, { cwd: '/fixture' }, true).projection.items.values()]
}

// Finite lexical boundary: unresolved vocabulary remains unresolved; these
// controls prohibit inventing a negative scope inside a lexical word.
it.each(['分别', '特别', '识别', '区别', '鉴别', '辨别', '甄别', '类别', '级别', '个别', '差别', '性别'])('never interprets the lexical suffix of %s as a ban', word => {
  const text = `请${word}执行命令。`
  expect(interpretMessage(text).some(row => row.directive === 'prohibition')).toBe(false)
  expect(segmentClauses(text).some(row => row.kind === 'prohibition')).toBe(false)
  const actual = items(text)
  expect(actual.some(row => row.kind === 'prohibition')).toBe(false)
  expect(actual.some(row => row.normalizedText.includes(word))).toBe(true)
})

it.each(['别运行测试。', '请别运行测试。', '千万别运行测试。', '完成前别运行测试。', '分开但别运行测试。', '分别别运行测试。'])('preserves the actual negative scope in %s', text => {
  expect(segmentClauses(text).some(row => row.kind === 'prohibition' && row.text.includes('运行测试'))).toBe(true)
  expect(items(text).some(row => row.kind === 'prohibition' && row.normalizedText.includes('运行测试'))).toBe(true)
})

it.each(['依次分别调用 bash 执行以下两条命令。', '请分别运行测试。', '分别执行命令。'])('keeps the original obligation whole: %s', text => {
  const actual = items(text)
  expect(actual.some(row => row.kind === 'prohibition')).toBe(false)
  expect(actual.some(row => /(?:依次分|请分|分)$/.test(row.normalizedText))).toBe(false)
  expect(actual.some(row => row.normalizedText.includes('分别'))).toBe(true)
})

it.each(['分别运行测试，但别推送。', '分别执行命令；不要推送。', '请识别错误，完成前别推送。', '请特别注意，别推送。'])('retains the later real ban without corrupting the lexical scope: %s', text => {
  const actual = items(text)
  expect(actual.some(row => row.kind === 'prohibition' && row.normalizedText.includes('推送'))).toBe(true)
  expect(actual.some(row => row.kind === 'prohibition' && /(?:运行测试|执行命令|识别错误)/.test(row.normalizedText))).toBe(false)
})

it('keeps a real prohibition around its lexical word instead of splitting another ban', () => {
  const clauses = segmentClauses('测试前别分别执行命令。')
  expect(clauses.filter(row => row.kind === 'prohibition')).toHaveLength(1)
  expect(clauses.find(row => row.kind === 'prohibition')?.text).toContain('分别执行命令')
})

it('does not turn a conditional or quoted lexical word into a prohibition', () => {
  for (const text of ['如果测试通过，分别执行命令。', '解释“分别执行命令”的含义。']) {
    expect(segmentClauses(text).some(row => row.kind === 'prohibition')).toBe(false)
    expect(items(text).some(row => row.kind === 'prohibition')).toBe(false)
  }
  const clauses = segmentClauses('说明 `分别执行命令`，不要实际运行。')
  expect(clauses.some(row => row.kind === 'prohibition' && row.text.includes('不要'))).toBe(true)
})

it.each(['Do not run tests.', 'Never push. Run tests.', 'Run tests separately; do not push.'])('keeps English negative scope: %s', text => {
  expect(segmentClauses(text).some(row => row.kind === 'prohibition')).toBe(true)
  expect(items(text).some(row => row.kind === 'prohibition')).toBe(true)
})

it('does not invent a ban from the original two-command root', () => {
  const actual = items("在当前任务目录创建 acceptance.txt，内容为指定标记和一个换行，然后读回核对。依次分别调用 bash 执行以下两条命令，保持命令原文：\nprintf '%s\\n' 'fixture-marker' > acceptance.txt\ncat acceptance.txt\n完成后按当前 Guard 合同核对完成状态，并用中文简短报告结果。只修改这个文件。")
  expect(actual.some(row => row.kind === 'prohibition')).toBe(false)
  expect(actual.some(row => row.normalizedText.includes('依次分别调用 bash'))).toBe(true)
  expect(actual.some(row => row.normalizedText === '依次分')).toBe(false)
})

it.each([
  '这部分别运行测试。', '这个模特别推送。', '这些常识别修改。', '这个分区别运行测试。',
  '变量鉴别修改。', '变量辨别修改。', '老甄别运行测试。', '这类别运行。',
  '这级别运行测试。', '这个别推送。', '出差别推送。', '这个属性别修改。',
  '这几个别推送。', '后一个别推送。', '请这个别推送。', '请这部分别运行测试。',
])('keeps a noun/classifier boundary negative instead of granting positive authority: %s', text => {
  expect(interpretMessage(text).some(row => row.directive === 'prohibition')).toBe(true)
  expect(segmentClauses(text).some(row => row.kind === 'prohibition')).toBe(true)
  const actual = items(text)
  expect(actual.some(row => row.kind === 'prohibition')).toBe(true)
  expect(actual.some(row => row.semanticAction === 'push' && itemHoldsExecutionAuthority(row))).toBe(false)
})

it.each(['分别开始运行测试。', '先分别运行测试。', '请依次分别执行命令。'])('recognizes the complete positive instruction lead: %s', text => {
  expect(interpretMessage(text).some(row => row.directive === 'prohibition')).toBe(false)
  const actual = items(text)
  expect(actual.some(row => row.kind === 'prohibition')).toBe(false)
  expect(actual.some(row => row.normalizedText.includes('分别'))).toBe(true)
})

const reviewedLeads = ['需要你', '请你', '帮我', '麻烦', '务必', '千万', '依次', '优先', '同时', '然后', '请', '先', '再', '并', '也']
it.each(reviewedLeads)('uses the whole reviewed lead rather than any matching prefix: %s', lead => {
  expect(items(`${lead}分别执行命令。`).some(row => row.kind === 'prohibition')).toBe(false)
  const actual = items(`${lead}这个别推送。`)
  expect(actual.some(row => row.kind === 'prohibition' && row.normalizedText.includes('推送'))).toBe(true)
  expect(actual.some(row => row.semanticAction === 'push' && itemHoldsExecutionAuthority(row))).toBe(false)
})
it.each(['xnever个别推送。', 'whenever个别推送。'])('does not invent an outer English negator inside a longer word: %s', text => {
  expect(items(text).some(row => row.kind === 'prohibition')).toBe(true)
})
