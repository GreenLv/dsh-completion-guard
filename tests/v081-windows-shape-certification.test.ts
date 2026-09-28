import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { deriveProjection, PROTOCOL_V6_NOTICE } from '../src/domain/derive.js'
import { projectSessionCoreV2 } from '../src/core-v2/session.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'

// The session header keeps a host-legal cwd; the root-time locator base
// (derive scope.cwd) carries the Windows form, as on a real Windows host.
const HOST = { ...evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' }),
  auditedForegroundRenderers: ['bash' as const] }

describe('v0.8.1: a windows-shaped compound chain certifies end to end', () => {
  it('certifies modify+commit+push with backslash root-time targets and canonical readbacks', () => {
    const work = 'C:\\work\\repo-042'
    const appPy = `${work}\\app.py`
    const id = SessionId('win-probe-042')
    const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, isSeeded: false, id, createdAt: 1, cwd: '/work-host' })
    session.append('command/run', { commandId: 'on' as never, name: 'context-guard', args: 'on', source: { kind: 'user' } })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }],
      source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice', summary: 'v6' } }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `修改 ${appPy};提交仓库 ${work} 分支 main;推送仓库 ${work} 远端 origin 引用规范 refs/heads/main:refs/heads/main。` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    // edit effect (edit tool, windows path)
    session.append('tool/call', { turn: 1, step: 1, callId: 'host-edit' as never, name: 'edit', arguments: JSON.stringify({ file_path: appPy, old_string: 'first', new_string: '2.0' }) })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'host-edit' as never, content: [{ type: 'text', text: 'edited' }], isError: false }) } as never, { surfaceOp: 'append' })
    // observed readback with canonical identity (windows shape)
    const observed = { status: 'observed', reason_code: 'file_state_observed', effect_call_id: 'host-edit', path: appPy, sha256: 'a'.repeat(64), action: 'modify', canonical_path: appPy, canonical_base: work }
    session.append('tool/call', { turn: 1, step: 1, callId: 'edit-readback' as never, name: 'context_guard_observe_file', arguments: JSON.stringify({ effect_call_id: 'host-edit' }) })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'edit-readback' as never, content: [{ type: 'text', text: JSON.stringify(observed) }], isError: false }),
      meta: { contextGuardNativeFile: { effectCallId: 'host-edit', path: appPy, sha256: observed.sha256, action: 'modify', canonicalPath: appPy, canonicalBase: work } } } as never, { surfaceOp: 'append' })
    // commit effect + git readback
    session.append('tool/call', { turn: 1, step: 1, callId: 'host-commit' as never, name: 'bash', arguments: JSON.stringify({ command: 'git commit -m second', workdir: work }) })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'host-commit' as never, content: [{ type: 'text', text: '[main 1234567] second' }], isError: false }) } as never, { surfaceOp: 'append' })
    const commit = { status: 'observed', reason_code: 'git_commit_observed', effect_call_id: 'host-commit', action: 'commit', repository: work, branch: 'main', remote: '', refspec: '', post_oid: '1'.repeat(40), parent_oid: '2'.repeat(40), tree_oid: '3'.repeat(40) }
    session.append('tool/call', { turn: 1, step: 1, callId: 'commit-readback' as never, name: 'context_guard_observe_git', arguments: JSON.stringify({ effect_call_id: 'host-commit' }) })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'commit-readback' as never, content: [{ type: 'text', text: JSON.stringify(commit) }], isError: false }),
      meta: { contextGuardNativeGit: { effectCallId: 'host-commit', action: 'commit', repository: work, branch: 'main', remote: '', refspec: '', postOid: commit.post_oid, parentOid: commit.parent_oid, treeOid: commit.tree_oid } } } as never, { surfaceOp: 'append' })
    // push effect + git readback
    session.append('tool/call', { turn: 1, step: 1, callId: 'host-push' as never, name: 'bash', arguments: JSON.stringify({ command: 'git push origin refs/heads/main:refs/heads/main', workdir: work }) })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'host-push' as never, content: [{ type: 'text', text: 'To origin' }], isError: false }) } as never, { surfaceOp: 'append' })
    const push = { status: 'observed', reason_code: 'git_push_observed', effect_call_id: 'host-push', action: 'push', repository: work, branch: 'main', remote: 'origin', refspec: 'refs/heads/main:refs/heads/main', post_oid: '1'.repeat(40), parent_oid: '', tree_oid: '' }
    session.append('tool/call', { turn: 1, step: 1, callId: 'push-readback' as never, name: 'context_guard_observe_git', arguments: JSON.stringify({ effect_call_id: 'host-push' }) })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'push-readback' as never, content: [{ type: 'text', text: JSON.stringify(push) }], isError: false }),
      meta: { contextGuardNativeGit: { effectCallId: 'host-push', action: 'push', repository: work, branch: 'main', remote: 'origin', refspec: push.refspec, postOid: push.post_oid, parentOid: '', treeOid: '' } } } as never, { surfaceOp: 'append' })
    const events = session.snapshotEvents() as never
    const projection = deriveProjection(events, { activation: 'opt-in' }, { cwd: work }, true, HOST).projection
    projection.durabilityWatermark = 'confirmed'
    projection.coreV2 = projectSessionCoreV2(events, projection)
    const modify = [...projection.items.values()].find((row) => row.semanticAction === 'modify')!
    const commitItem = [...projection.items.values()].find((row) => row.semanticAction === 'commit')!
    const pushItem = [...projection.items.values()].find((row) => row.semanticAction === 'push')!
      expect(modify).toBeDefined()
    const predicates = (projection.coreV2?.predicates ?? {}) as Record<string, string>
    expect(predicates[modify.id]).toBe('satisfied')
    expect(predicates[commitItem.id]).toBe('satisfied')
    expect(predicates[pushItem.id]).toBe('satisfied')
    expect(projection.coreV2?.certifiable).toBe(true)
  })
})
