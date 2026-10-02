import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V6_NOTICE } from '../src/domain/derive.js'
import type { DerivedEnvelope } from '../src/domain/types.js'

function capture(text: string, cwd = '/work/parent') {
  const events: DerivedEnvelope[] = [
    { seq: 1, type: 'user/message', data: { source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }] } },
    { seq: 2, type: 'turn/start', data: { turn: 1 } },
    { seq: 3, type: 'user/message', data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text }] } },
  ]
  return [...deriveProjection(events, { activation: 'always' }, { cwd }, true).projection.items.values()]
    .find(item => item.semanticAction === 'test')!
}

describe('explicit foreground test scope', () => {
  it.each([
    ['Run pnpm test in /work/parent/child.', '/work/parent/child'],
    ['Run npm test in /work/child before finishing.', '/work/child'],
    ['Run npm test in "/work/child" before finishing.', '/work/child'],
    ['In /work/child, run pnpm test.', '/work/child'],
    ['运行测试，在 /work/child。', '/work/child'],
    ['Run pnpm test within "/work/a directory".', '/work/a directory'],
    ["Run npm test in '/work/child'.", '/work/child'],
    ['Run yarn test in `C:\\work\\child`.', 'C:\\work\\child'],
    ['Run bun test in C:\\work\\child.', 'C:\\work\\child'],
  ])('retains explicit directory authority: %s', (root, target) => {
    expect(capture(root)).toMatchObject({ requestedTarget: { scope: target }, targetCaptureStatus: 'resolved', targetSource: { kind: 'explicit_path' } })
  })

  it.each([
    'Run pnpm test in ./child.',
    'Run pnpm test in /work/a or /work/b.',
    'Run pnpm test in "/work/child.',
    'Run pnpm test in /work/child/package.json.',
    'Run pnpm test in the other directory.',
  ])('never substitutes parent cwd for an unresolved explicit location: %s', root => {
    const item = capture(root)
    expect(item.targetCaptureStatus).toBe('clarification_required')
    expect(item.requestedTarget?.scope).toBeUndefined()
  })

  it.each(['Run pnpm test.', 'Run pnpm test in the workspace.', 'Run pnpm test in this workspace.', 'Run npm test in this workspace before finishing.', 'In this workspace, run npm test.', '现在运行测试。'])('preserves implicit workspace scope: %s', root => {
    expect(capture(root).requestedTarget?.scope).toBe('/work/parent')
  })
})
