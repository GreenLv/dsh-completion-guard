import { describe, expect, it } from 'vitest'
import { deriveProjection } from '../../src/domain/derive.js'
import type { DerivedEnvelope } from '../../src/domain/types.js'
import { captureClause } from '../../src/domain/capture.js'
import { requestedTargetAuthorizesMutation, requestedTargetMatchesResolved } from '../../src/domain/protocol-manifest.js'

const config = { activation: 'always' as const }
const scope = { cwd: '/repo', sessionHeader: { version: 3, id: 'v060-bounded', createdAt: 1 } }
const user = (seq: number, text: string): DerivedEnvelope => ({ seq, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })

describe('0.6.0 P2.2: the object decides the modify lane (D06-02/S03/C07)', () => {
  it('a document-noun update becomes a bounded modify the assistant may resolve', () => {
    const p = deriveProjection([user(1, '更新文档')], config, scope, true).projection
    const item = [...p.items.values()][0]!
    expect(item.semanticAction).toBe('modify')
    // Bounded choice: the scope and the type are frozen from the instruction;
    // the exact file is the assistant's bounded decision, resolved later.
    expect(item.targetCaptureStatus).toBe('resolved')
    expect(item.requestedTarget).toEqual({ scope: '/repo', artifact_type: 'document' })
    const resolved = { artifact_id: '/repo/notes.md', scope: '/repo/notes.md'.replace('/notes.md', ''), pre_digest: 'absent', change_set_digest: 'x' }
    // Inside scope and type: the bounded choice authorizes the mutation.
    expect(requestedTargetAuthorizesMutation('modify', item.requestedTarget, resolved)).toBe(true)
    // Outside the scope, wrong type, or a root-unrelated target: never.
    expect(requestedTargetAuthorizesMutation('modify', item.requestedTarget, { ...resolved, artifact_id: '/etc/escape.md', scope: '/etc' })).toBe(false)
    expect(requestedTargetAuthorizesMutation('modify', item.requestedTarget, { ...resolved, artifact_id: '/repo/notes.exe' })).toBe(false)
    expect(requestedTargetMatchesResolved('modify', { scope: '/repo' }, { artifact_id: '/repo/notes.md', scope: '/repo' })).toBe(false)
  })

  it('a non-file object keeps its honest generic reading', () => {
    const p = deriveProjection([user(1, '更新皮肤中心')], config, scope, true).projection
    const item = [...p.items.values()][0]!
    expect(item.semanticAction).toBe('generic_run')
    expect(item.targetCaptureStatus).toBe('resolved')
  })

  it('a referenced task name never becomes a second action in the plan', () => {
    const p = deriveProjection([user(1, '把更新插件明确为 apply package demo@2.0.0 profile web')], config, scope, true).projection
    const item = [...p.items.values()][0]!
    expect(item.semanticAction).toBe('apply')
    expect(item.actionPlan).toBeUndefined()
  })
})

describe('0.6.0 P2.2: source spans and coverage (C01/C02)', () => {
  it('items bind UTF-8 byte spans of the original message and the coverage record exists', () => {
    const text = '创建 报告.md，不要发布'
    const p = deriveProjection([user(1, text)], config, scope, true).projection
    const create = [...p.items.values()].find((item) => item.semanticAction === 'create')!
    const ban = [...p.items.values()].find((item) => item.kind === 'prohibition')!
    // The create scope keeps its trailing separator verbatim ('创建 报告.md，'
    // = 19 bytes); the ban starts at byte 19 and is 12 bytes long.
    expect(create.spans).toEqual([{ partIndex: 0, start: 0, end: 19, class: 'instruction' }])
    expect(ban.spans).toEqual([{ partIndex: 0, start: 19, end: 31, class: 'constraint' }])
    expect(create.rawTextSha256).toBe(ban.rawTextSha256)
    expect(p.coverage).toHaveLength(1)
    expect(p.coverage[0]).toMatchObject({ seq: 1, coveredSpans: 2, byteLength: Buffer.byteLength(text, 'utf8') })
    // The raw digest identifies the exact original bytes.
    const { createHash } = require('node:crypto') as typeof import('node:crypto')
    expect(p.coverage[0]!.rawTextSha256).toBe(createHash('sha256').update(text, 'utf8').digest('hex'))
  })

  it('a standalone capture still names a single span', () => {
    const item = captureClause('修改 README 说明', 'm1', 'R1', 1, { cwd: '/repo' })
    expect(item.semanticAction).toBe('modify')
    expect(item.spans).toEqual([{ partIndex: 0, start: 0, end: Buffer.byteLength('修改 README 说明', 'utf8'), class: 'instruction' }])
  })
})
