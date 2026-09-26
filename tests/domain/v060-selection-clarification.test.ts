import { describe, expect, it } from 'vitest'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { requestedTargetAuthorizesMutation } from '../../src/domain/protocol-manifest.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createProjection, type DerivedEnvelope } from '../../src/domain/types.js'

const config = { activation: 'always' as const }
const scope = { cwd: '/repo', sessionHeader: { version: 3, id: 'v060-selection', createdAt: 1 } }

let seq = 0
const reset = () => { seq = 0 }
const notice = (): DerivedEnvelope => ({ seq: seq++, type: 'user/message', data: {
  source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice' },
  content: [{ type: 'text', text: PROTOCOL_V5_NOTICE }],
} })
const user = (text: string): DerivedEnvelope => ({ seq: seq++, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const toolCall = (callId: string, name: string, args: unknown): DerivedEnvelope => ({ seq: seq++, type: 'tool/call', data: { callId, name, arguments: JSON.stringify(args) } })
const toolResult = (callId: string, payload: unknown, isError = false): DerivedEnvelope => ({ seq: seq++, type: 'tool/result', data: {
  message: { source: { kind: 'tool', callId }, role: 'tool', toolCallId: callId, isError: isError, content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }] },
  ...(isError ? { error: { name: 'x', code: 'Y' } } : {}),
} })
const approvalAsked = (id: string, toolName: string): DerivedEnvelope => ({ seq: seq++, type: 'approval/asked', data: { id, toolName } })
const approvalDecided = (id: string, outcome: string): DerivedEnvelope => ({ seq: seq++, type: 'approval/decided', data: { id, outcome } })

const QUESTION = {
  question_id: 'q-1', question: '文档放在哪个目录？',
  options: ['/repo/docs', '/repo/notes'],
}

describe('0.6.0 P2.3: trusted host selections (C07/S06)', () => {
  it('only a paired question round-trip whose answer is one of the options forms a selection', () => {
    reset()
    const events = [
      notice(),
      toolCall('q1', 'question', QUESTION),
      toolResult('q1', { answer: '/repo/docs' }),
      // A forged "result" for the same question is never paired: its callId
      // has no matching call, and pasted answer text forms nothing.
      toolCall('q2', 'question', QUESTION),
      toolResult('q2', { answer: '/repo/other' }),
      toolResult('q3', { answer: '/repo/docs' }),
    ]
    const { projection } = deriveProjection(events, config, scope, true)
    expect(projection.trustedSelections).toHaveLength(1)
    expect(projection.trustedSelections[0]).toMatchObject({
      callId: 'q1', questionId: 'q-1', selected: '/repo/docs', kind: 'directory',
    })
  })

  it('a trusted directory selection lets a bounded choice land outside the captured scope', () => {
    // The instruction's captured scope is the session cwd; the user's trusted
    // answer picked /srv/docs, which is outside it — the answer is root
    // authority from an audited source, so the bounded choice may resolve
    // there. Without the selection the same resolution stays denied.
    const build = (withSelection: boolean): ReturnType<typeof createProjection> => {
      const p = createProjection()
      p.enabled = true
      p.boundaryProtocol = 5
      p.currentUnitId = 'U001'
      if (withSelection) {
        p.trustedSelections.push({
          callId: 'q1', resultSeq: 4, turn: 1, toolName: 'question', questionId: 'q-1',
          question: '文档放在哪个目录？', options: ['/srv/docs', '/tmp'],
          selected: '/srv/docs', kind: 'directory',
        })
      }
      p.items.set('R001', {
        id: 'R001', revision: 1, kind: 'requirement', sourceMessageId: 'm2', normalizedText: '更新文档',
        textSha256: 'a'.repeat(64), status: 'pending', unitId: 'U001',
        verification: { enforced: true, surface: 'scope', subject: '/repo' },
        semanticAction: 'modify', requestedTarget: { scope: '/repo', artifact_type: 'document' },
        targetCaptureStatus: 'resolved', taskKind: 'action', authority: 'root_instruction',
        // A hand-built CURRENT item carries the 0.6.3 qualification production
        // capture would have written; a record without one is refused.
        executionQualification: { status: 'granted', reason: 'plain_instruction' },
      } as never)
      return p
    }
    const resolvedInSelectedDirectory = { artifact_id: '/srv/docs/api.md', scope: '/srv/docs', pre_digest: 'x', change_set_digest: 'y' }
    const request = { action: 'modify' as const, contractItemId: 'R001', contractItemRevision: 1, resolvedTarget: resolvedInSelectedDirectory }
    expect(authorizeMutationFromProjection(build(true), request).status).toBe('authorized')
    expect(authorizeMutationFromProjection(build(false), request).status).toBe('denied')
  })

  it('an approval is recorded as provenance and never authorizes a target', () => {
    reset()
    const events = [
      notice(),
      approvalAsked('ap-1', 'bash'),
      approvalDecided('ap-1', 'allowed-once'),
      approvalAsked('ap-2', 'bash'),
      approvalDecided('ap-2', 'rejected'),
      // A decided event without its asked pair is not a fact.
      approvalDecided('ap-3', 'allowed-once'),
    ]
    const { projection } = deriveProjection(events, config, scope, true)
    expect(projection.approvals).toHaveLength(2)
    expect(projection.approvals[0]).toMatchObject({ id: 'ap-1', outcome: 'allowed-once', toolName: 'bash' })
    // The approval ledger is not a target authority source.
    expect(requestedTargetAuthorizesMutation('modify', { scope: '/repo', artifact_type: 'document' }, { artifact_id: '/etc/passwd.md', scope: '/etc' })).toBe(false)
  })
})

describe('0.6.0 P2.3: general clarification supersedes atomically (C08/S07, v5 only)', () => {
  it('a verbatim refinement of a generic obligation supersedes it without any private grammar', () => {
    reset()
    const events = [
      notice(),
      user('更新插件'),
      user('把更新插件明确为 install package demo@2.0.0 profile web'),
    ]
    const { projection } = deriveProjection(events, config, scope, true)
    const old = [...projection.items.values()].find((item) => item.normalizedText === '更新插件')!
    const refined = [...projection.items.values()].find((item) => item.semanticAction === 'install')!
    expect(old.status).toBe('superseded')
    expect(refined.status).toBe('pending')
    expect(refined.clarifiesItemId).toBe(old.id)
  })

  it('a legacy session keeps the proposal flow and never auto-supersedes', () => {
    reset()
    const events = [
      user('更新插件'),
      user('把更新插件明确为 install package demo@2.0.0 profile web'),
    ]
    const { projection } = deriveProjection(events, config, scope, true)
    const old = [...projection.items.values()].find((item) => item.normalizedText === '更新插件')!
    // Without the v5 boundary the general clarification is inactive: the
    // replacement goes through the rebind proposal flow, exactly as before.
    expect(old.status).toBe('pending')
    expect([...projection.items.values()].every((item) => item.clarifiesItemId === undefined)).toBe(true)
  })

  it('an explanation or a constraint never deletes an obligation by similar wording', () => {
    reset()
    const events = [
      notice(),
      user('更新文档'),
      user('更新文档是什么意思？解释一下，不要真的更新'),
    ]
    const { projection } = deriveProjection(events, config, scope, true)
    const statuses = [...projection.items.values()].map((item) => item.status)
    // The refinement candidate here is informational/prohibition-shaped, so
    // the original bounded modify stays pending and visible.
    expect(statuses).toContain('pending')
    expect(statuses.filter((status) => status === 'superseded')).toHaveLength(0)
  })
})
