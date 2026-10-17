import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { deriveProjection } from '../src/domain/derive.js'
import { captureHostWorkdir, HOST_WORKDIR_PREFIX, hostWorkdirForCall } from '../src/domain/host-workdir.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'
import type { DerivedEnvelope } from '../src/domain/types.js'

const require = createRequire(import.meta.url)
const producerRequire = createRequire(require.resolve('@deepseek-ai/dsh-tool-bash'))
const workingDirectory = await import(pathToFileURL(producerRequire.resolve('@deepseek-ai/dsh-working-directory')).href)

describe('F-CG0100-01 official cwd producer recovery', () => {
  it('refuses a pre-execute receipt when real ensure recovers after tool/call', async () => {
    // Native realpath expands Windows 8.3 TEMP aliases before binding the
    // immutable header and assertions; production path equality stays exact.
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cg-cwd-origin-')))
    const other = realpathSync.native(mkdtempSync(join(tmpdir(), 'cg-cwd-other-')))
    const ctx = new Context()
    new SessionProjectionRegistry(ctx); new SystemPrompt(ctx, {})
    new LocalFileSystem(ctx, { cwd: root, diffBasisMaxBytes: 10485760 })
    const service = new workingDirectory.WorkingDirectoryService(ctx, { defaultDirectory: root })
    const id = SessionId('cwd-recovery')
    const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, id, isSeeded: false, createdAt: 1, cwd: root })
    const agent = { id, session, ctx, inject: () => {} }
    const host = { ...evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' }), auditedForegroundRenderers: ['bash' as const] }
    try {
      session.append('turn/start', { turn: 1 })
      await service.set(agent, other)
      session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Run npm test.' }] }), { surfaceOp: 'append' })
      const call = session.append('tool/call', { turn: 1, step: 1, callId: 'c1' as never, name: 'bash', arguments: '{"command":"npm test"}' })
      const receipt = captureHostWorkdir(session, { agent, callId: 'c1', rootCallId: 'c1', name: 'bash', arguments: { command: 'npm test' } } as never,
        host, { resolve: () => ({ sessionId: id, workspaceRoot: root }) }, true)
      expect(receipt?.effectiveCwd).toBe(other)
      rmSync(other, { recursive: true })
      const actualExecutionDirectory = await service.ensure(agent)
      expect(actualExecutionDirectory).toBe(root)
      const result = session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'c1' as never, content: [{ type: 'text', text: 'ok' }], isError: false }) }, { surfaceOp: 'append' })
      session.append('user/message', createUserMessage({ source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice', summary: 'pre-execute workdir' }, content: [{ type: 'text', text: HOST_WORKDIR_PREFIX + JSON.stringify(receipt) }] }), { surfaceOp: 'append' })
      const events = session.snapshotEvents() as unknown as DerivedEnvelope[]
      const p = deriveProjection(events, { activation: 'always' }, { cwd: root, sessionHeader: { version: 4, id, createdAt: 1, seedLength: 0, delegationDepth: 0 } }, true, host).projection
      expect([...p.evidence.values()][0]?.outcome).toBe('unknown')
      expect(hostWorkdirForCall(events, call as never, result as never, receipt!.rootSeq, receipt!.sessionRefDigest, host.digest, other, root)).toBeUndefined()
    } finally { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }) }
  })
})
