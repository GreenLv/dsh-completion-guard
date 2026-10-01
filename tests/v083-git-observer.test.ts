import { expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { createNativeGitObserver } from '../src/tools/observe.js'
import { NATIVE_GIT_ROOT_PARENT_OID } from '../src/domain/evidence.js'

// CG-083-BUG02/BUG03 regressions, driven through REAL git repositories:
//  - a repository's first (parentless) commit is an explicit verified `root`
//    parent state, not a missing readback;
//  - a failed pre-commit hook that echoes the OLD head with an exit marker is
//    never `observed` (producer false-observation closed);
//  - a backgrounded shell result is never a completed effect;
//  - the observer's git subprocesses receive the caller's cancellation.

const gitExec = promisify(execFileCb)

function appendCall(session: Session, callId: string, name: string, args: Record<string, unknown>): void {
  session.append('tool/call', { turn: 1, step: 1, callId: callId as never, name, arguments: JSON.stringify(args) })
}
function appendResult(session: Session, callId: string, text: string, options?: { background?: boolean }): void {
  session.append('tool/result', {
    turn: 1, step: 1,
    message: createToolResultMessage({ callId: callId as never, content: [{ type: 'text', text }], isError: false }),
    ...(options?.background ? { meta: {} } : {}),
  }, { surfaceOp: 'append' })
}

function sessionFor(id: string, cwd: string, rootText?: string): Session {
  const session = Session.create(SessionId(id), undefined, {
    version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId(id), createdAt: 1, cwd,
  })
  session.append('command/run', { commandId: 'on' as never, name: 'context-guard', args: 'on', source: { kind: 'user' } })
  if (rootText) {
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: rootText }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  }
  return session
}

const observer = createNativeGitObserver({ flush: async () => true })
const exec = (session: Session, signal?: AbortSignal) => ({ agent: { session }, signal: signal ?? new AbortController().signal } as never)

it('returns an explicit verified root parent for a repository first commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cg-git-root-'))
  try {
    const work = join(root, 'work')
    await gitExec('git', ['init', '-b', 'main', work])
    await gitExec('git', ['-C', work, 'config', 'user.name', 'Fixture'])
    await gitExec('git', ['-C', work, 'config', 'user.email', 'fixture@example.invalid'])
    const session = sessionFor('git-root-commit', work)
    appendCall(session, 'root-commit', 'bash', { command: 'git commit -m initial', workdir: work })
    await writeFile(join(work, 'a.txt'), 'first\n')
    await gitExec('git', ['-C', work, 'add', 'a.txt'])
    const committed = await gitExec('git', ['-C', work, 'commit', '-m', 'initial'])
    appendResult(session, 'root-commit', committed.stdout)
    const result = await observer.execute({ effect_call_id: 'root-commit' }, exec(session)) as { status: string; reason_code: string; parent_oid: string; post_oid: string; tree_oid: string }
    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'observed', reason_code: 'git_commit_observed',
      parent_oid: NATIVE_GIT_ROOT_PARENT_OID,
      post_oid: expect.stringMatching(/^[0-9a-f]{40,64}$/),
      tree_oid: expect.stringMatching(/^[0-9a-f]{40,64}$/),
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

it('does not observe a failed pre-commit hook that echoes the old head', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cg-git-hook-'))
  try {
    const work = join(root, 'work')
    await gitExec('git', ['init', '-b', 'main', work])
    await gitExec('git', ['-C', work, 'config', 'user.name', 'Fixture'])
    await gitExec('git', ['-C', work, 'config', 'user.email', 'fixture@example.invalid'])
    await writeFile(join(work, 'a.txt'), 'first\n')
    await gitExec('git', ['-C', work, 'add', 'a.txt'])
    await gitExec('git', ['-C', work, 'commit', '-m', 'first'])
    const oldHead = (await gitExec('git', ['-C', work, 'rev-parse', 'HEAD'])).stdout.trim().slice(0, 7)
    // The hook echoes the CURRENT (old) head, like a CI helper that reports
    // the base revision before failing lint.
    await writeFile(join(work, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\ngit rev-parse HEAD\necho failed lint\nexit 1\n', { mode: 0o755 })
    await writeFile(join(work, 'a.txt'), 'second\n')
    await gitExec('git', ['-C', work, 'add', 'a.txt'])
    const session = sessionFor('git-failed-hook', work, `Commit changes in repository ${work}.`)
    appendCall(session, 'hooked-commit', 'bash', { command: 'git commit -m second', workdir: work })
    // A real failing run leaves HEAD unchanged and prints the old SHA plus a
    // nonzero exit marker; the envelope itself is a normal tool result.
    const failed = await gitExec('git', ['-C', work, 'commit', '-m', 'second'])
      .then(() => { throw new Error('fixture commit should have failed') })
      .catch((error: { stdout?: string; stderr?: string }) => `${error.stdout ?? ''}${error.stderr ?? ''}[exit code: 1]`)
    expect(failed).toContain(oldHead)
    appendResult(session, 'hooked-commit', failed)
    const result = await observer.execute({ effect_call_id: 'hooked-commit' }, exec(session)) as { status: string; reason_code: string }
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'unavailable', reason_code: 'native_effect_failed' })
    // HEAD is provably unchanged: the observer must not have claimed it.
    const head = (await gitExec('git', ['-C', work, 'rev-parse', 'HEAD'])).stdout.trim()
    expect(head.startsWith(oldHead)).toBe(true)
    // Chain assertion: the persisted effect fact itself reads as a failure,
    // and a checkpoint binding over it cannot certify (not just "the observer
    // said unavailable") — the whole certification path stays closed.
    const { deriveProjection } = await import('../src/domain/derive.js')
    const { certifyCheckpoint } = await import('../src/domain/checkpoint.js')
    const { evaluateHostLock, EXPECTED_HOST_PACKAGES } = await import('../src/domain/host-lock.js')
    const HOST = { ...evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' }),
      auditedForegroundRenderers: ['bash' as const] }
    const projection = deriveProjection(session.snapshotEvents() as never, { activation: 'opt-in' }, { cwd: work }, true, HOST).projection
    const effect = [...projection.evidence.values()].find((row) => row.callId === 'hooked-commit')
    expect(effect, 'the failed call must still be recorded as evidence').toBeDefined()
    expect(effect!.outcome).toBe('failure')
    const item = [...projection.items.values()].find((row) => row.semanticAction === 'commit')
    expect(item).toBeDefined()
    const certified = certifyCheckpoint(projection, [{
      itemId: item!.id, evidenceIds: [effect!.id], semanticAction: 'commit' as const,
      requestedTarget: item!.requestedTarget, resolvedTarget: item!.requestedTarget,
      observedState: { post_head_oid: oldHead }, effectEvidenceId: effect!.id, stateEvidenceIds: [],
    }], 'C-failed-hook', false)
    expect(certified.status).not.toBe('certified')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

it('does not observe a backgrounded commit result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cg-git-bg-'))
  try {
    const work = join(root, 'work')
    await gitExec('git', ['init', '-b', 'main', work])
    await gitExec('git', ['-C', work, 'config', 'user.name', 'Fixture'])
    await gitExec('git', ['-C', work, 'config', 'user.email', 'fixture@example.invalid'])
    await writeFile(join(work, 'a.txt'), 'first\n')
    await gitExec('git', ['-C', work, 'add', 'a.txt'])
    const session = sessionFor('git-background', work)
    appendCall(session, 'bg-commit', 'bash', { command: 'git commit -m first', workdir: work, run_in_background: true })
    const committed = await gitExec('git', ['-C', work, 'commit', '-m', 'first'])
    appendResult(session, 'bg-commit', committed.stdout, { background: true })
    const result = await observer.execute({ effect_call_id: 'bg-commit' }, exec(session)) as { status: string; reason_code: string }
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'unavailable', reason_code: 'native_effect_untrusted' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

it('propagates cancellation into the git subprocesses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cg-git-cancel-'))
  try {
    const work = join(root, 'work')
    await gitExec('git', ['init', '-b', 'main', work])
    await gitExec('git', ['-C', work, 'config', 'user.name', 'Fixture'])
    await gitExec('git', ['-C', work, 'config', 'user.email', 'fixture@example.invalid'])
    await writeFile(join(work, 'a.txt'), 'first\n')
    await gitExec('git', ['-C', work, 'add', 'a.txt'])
    const committed = await gitExec('git', ['-C', work, 'commit', '-m', 'first'])
    const session = sessionFor('git-cancel', work)
    appendCall(session, 'cancelled-commit', 'bash', { command: 'git commit -m first', workdir: work })
    appendResult(session, 'cancelled-commit', committed.stdout)
    const controller = new AbortController()
    controller.abort()
    const result = await observer.execute({ effect_call_id: 'cancelled-commit' }, exec(session, controller.signal)) as { status: string; reason_code: string }
    expect(result.status).toBe('unavailable')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
