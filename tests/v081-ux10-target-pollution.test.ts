import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V6_NOTICE } from '../src/domain/derive.js'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const HOST = undefined

function derive(text: string) {
  const id = SessionId('ux10-target-pollution')
  const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, isSeeded: false, id, createdAt: 1, cwd: '/work' })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }],
    source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice', summary: 'v6' } }), { surfaceOp: 'append' })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const scope = { cwd: '/work', sessionHeader: { version: SESSION_FORMAT_VERSION, id: String(id), createdAt: 1, seedLength: 0, delegationDepth: 0 } }
  return deriveProjection(session.snapshotEvents() as never, { activation: 'always' }, scope, true).projection
}

describe('UX10 regression: adjacent prose never pollutes a structured target identity', () => {
  // The historical reproduction used three REAL clause orders of one work
  // message; per-clause identity alignment must keep the target exactly the
  // structured literal in every order, with the adjacent prose captured as a
  // separate information clause — never spliced into verification.subject or
  // requestedTarget.
  const orders = [
    '提交仓库 /work/repo-a 的变更，另外说明文档也需要相应更新。',
    '说明文档也需要相应更新；另外提交仓库 /work/repo-a 的变更。',
    '提交仓库 /work/repo-a 的变更。说明文档也需要相应更新。',
  ] as const
  it.each(orders.map((text, index) => ({ index, text })))(
    'order #$index keeps the commit target exactly the literal repository', ({ text }) => {
      const projection = derive(text)
      const commit = [...projection.items.values()].find((row) => row.semanticAction === 'commit')
      expect(commit).toBeDefined()
      expect(commit!.requestedTarget).toMatchObject({ repository: '/work/repo-a' })
      const serialized = JSON.stringify(commit!.requestedTarget)
      expect(serialized).not.toContain('说明文档')
      expect(serialized).not.toContain('更新')
      expect(commit!.verification.subject ?? '').not.toContain('说明文档')
      // The adjacent prose keeps its own clause identity when captured.
      const prose = [...projection.items.values()].find((row) => row !== commit && row.normalizedText.includes('说明文档'))
      if (prose) expect(prose.normalizedText).not.toContain('/work/repo-a')
    })
})
