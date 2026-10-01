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

it('reads the raw parent when HEAD ITSELF is the shallow boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cg-git-shallowhead-'))
  try {
    const work = join(root, 'work')
    await gitExec('git', ['init', '-b', 'main', work])
    await gitExec('git', ['-C', work, 'config', 'user.name', 'Fixture'])
    await gitExec('git', ['-C', work, 'config', 'user.email', 'fixture@example.invalid'])
    await writeFile(join(work, 'a.txt'), 'first\n')
    await gitExec('git', ['-C', work, 'add', 'a.txt'])
    await gitExec('git', ['-C', work, 'commit', '-m', 'first'])
    const realParent = (await gitExec('git', ['-C', work, 'rev-parse', 'HEAD'])).stdout.trim()
    await writeFile(join(work, 'a.txt'), 'second\n')
    await gitExec('git', ['-C', work, 'add', 'a.txt'])
    const committed = await gitExec('git', ['-C', work, 'commit', '-m', 'second'])
    const head = (await gitExec('git', ['-C', work, 'rev-parse', 'HEAD'])).stdout.trim()
    // Mark HEAD ITSELF as the shallow boundary: a traversal view would hide
    // its parent exactly like a depth-1 fetch boundary would.
    await writeFile(join(work, '.git', 'shallow'), `${head}\n`)
    const session = sessionFor('git-shallow-head', work, `Commit changes in repository ${work}.`)
    appendCall(session, 'boundary-commit', 'bash', { command: 'git commit -m second', workdir: work })
    appendResult(session, 'boundary-commit', committed.stdout)
    const result = await observer.execute({ effect_call_id: 'boundary-commit' }, exec(session)) as { status: string; parent_oid: string }
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'observed', reason_code: 'git_commit_observed' })
    expect(result.parent_oid).toBe(realParent)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

it('reads the raw parent when HEAD is replaced by a DIFFERENT-tree parentless object', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cg-git-replace2-'))
  try {
    const work = join(root, 'work')
    await gitExec('git', ['init', '-b', 'main', work])
    await gitExec('git', ['-C', work, 'config', 'user.name', 'Fixture'])
    await gitExec('git', ['-C', work, 'config', 'user.email', 'fixture@example.invalid'])
    await writeFile(join(work, 'a.txt'), 'first\n')
    await gitExec('git', ['-C', work, 'add', 'a.txt'])
    await gitExec('git', ['-C', work, 'commit', '-m', 'first'])
    const realParent = (await gitExec('git', ['-C', work, 'rev-parse', 'HEAD'])).stdout.trim()
    await writeFile(join(work, 'a.txt'), 'second\n')
    await gitExec('git', ['-C', work, 'add', 'a.txt'])
    const committed = await gitExec('git', ['-C', work, 'commit', '-m', 'second'])
    // Forge a PARENTLESS commit over a DIFFERENT tree (the empty tree) and
    // point a replace ref at HEAD: a traversal view would then report `root`.
    const emptyTree = (await gitExec('git', ['-C', work, 'hash-object', '-t', 'tree', '/dev/null'])).stdout.trim()
    const forged = (await gitExec('git', ['-C', work, 'commit-tree', emptyTree, '-m', 'forged root'])).stdout.trim()
    await gitExec('git', ['-C', work, 'replace', (await gitExec('git', ['-C', work, 'rev-parse', 'HEAD'])).stdout.trim(), forged])
    const session = sessionFor('git-replace-difftree', work, `Commit changes in repository ${work}.`)
    appendCall(session, 'replaced-commit', 'bash', { command: 'git commit -m second', workdir: work })
    appendResult(session, 'replaced-commit', committed.stdout)
    const result = await observer.execute({ effect_call_id: 'replaced-commit' }, exec(session)) as { status: string; parent_oid: string }
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'observed', reason_code: 'git_commit_observed' })
    expect(result.parent_oid).toBe(realParent)
    expect(result.parent_oid).not.toBe(NATIVE_GIT_ROOT_PARENT_OID)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

it('reads the parent from the raw object under shallow boundaries and replace refs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cg-git-raw-'))
  try {
    const origin = join(root, 'origin')
    await gitExec('git', ['init', '-b', 'main', origin])
    await gitExec('git', ['-C', origin, 'config', 'user.name', 'Fixture'])
    await gitExec('git', ['-C', origin, 'config', 'user.email', 'fixture@example.invalid'])
    await writeFile(join(origin, 'a.txt'), 'first\n')
    await gitExec('git', ['-C', origin, 'add', 'a.txt'])
    await gitExec('git', ['-C', origin, 'commit', '-m', 'first'])
    await writeFile(join(origin, 'a.txt'), 'second\n')
    await gitExec('git', ['-C', origin, 'add', 'a.txt'])
    await gitExec('git', ['-C', origin, 'commit', '-m', 'second'])
    const secondOid = (await gitExec('git', ['-C', origin, 'rev-parse', 'HEAD'])).stdout.trim()

    // 1. A replace ref that swaps HEAD for a PARENTLESS object would make a
    // traversal view (rev-list) report `root`; the raw object still has the
    // real parent.
    const fakeRootTree = (await gitExec('git', ['-C', origin, 'rev-parse', 'HEAD^{tree}'])).stdout.trim()
    const fakeRoot = (await gitExec('git', ['-C', origin, 'commit-tree', fakeRootTree, '-m', 'forged root'])).stdout.trim()
    await gitExec('git', ['-C', origin, 'replace', secondOid, fakeRoot])
    const shallowClone = join(root, 'shallow')
    // 2. A shallow clone hides the boundary commit's parents from rev-list.
    await gitExec('git', ['clone', '--depth', '1', '--no-local', origin, shallowClone])
    await gitExec('git', ['-C', shallowClone, 'config', 'user.name', 'Fixture'])
    await gitExec('git', ['-C', shallowClone, 'config', 'user.email', 'fixture@example.invalid'])
    await writeFile(join(shallowClone, 'b.txt'), 'third\n')
    await gitExec('git', ['-C', shallowClone, 'add', 'b.txt'])
    const shallowCommit = (await gitExec('git', ['-C', shallowClone, 'commit', '-m', 'third'])).stdout
    const shallowHead = (await gitExec('git', ['-C', shallowClone, 'rev-parse', 'HEAD'])).stdout.trim()
    const session = sessionFor('git-raw-object', shallowClone, `Commit changes in repository ${shallowClone}.`)
    appendCall(session, 'raw-commit', 'bash', { command: 'git commit -m third', workdir: shallowClone })
    appendResult(session, 'raw-commit', shallowCommit)
    const result = await observer.execute({ effect_call_id: 'raw-commit' }, exec(session)) as { status: string; reason_code: string; parent_oid: string; post_oid: string }
    expect(result, JSON.stringify({ result, shallowHead, secondOid })).toMatchObject({ status: 'observed', reason_code: 'git_commit_observed' })
    // Under BOTH the replace ref and the shallow boundary, the parent comes
    // from the raw object: the shallow clone's boundary parent (the origin's
    // second commit) must be reported, never the forged `root`.
    expect(result.parent_oid).toBe(secondOid)
    expect(result.parent_oid).not.toBe(NATIVE_GIT_ROOT_PARENT_OID)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)

it('reports the first parent of a merge commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cg-git-merge-'))
  try {
    const work = join(root, 'work')
    await gitExec('git', ['init', '-b', 'main', work])
    await gitExec('git', ['-C', work, 'config', 'user.name', 'Fixture'])
    await gitExec('git', ['-C', work, 'config', 'user.email', 'fixture@example.invalid'])
    await writeFile(join(work, 'a.txt'), 'base\n')
    await gitExec('git', ['-C', work, 'add', 'a.txt'])
    await gitExec('git', ['-C', work, 'commit', '-m', 'base'])
    const firstParent = (await gitExec('git', ['-C', work, 'rev-parse', 'HEAD'])).stdout.trim()
    await gitExec('git', ['-C', work, 'checkout', '-b', 'side'])
    await writeFile(join(work, 'b.txt'), 'side\n')
    await gitExec('git', ['-C', work, 'add', 'b.txt'])
    await gitExec('git', ['-C', work, 'commit', '-m', 'side'])
    const secondParent = (await gitExec('git', ['-C', work, 'rev-parse', 'HEAD'])).stdout.trim()
    await gitExec('git', ['-C', work, 'checkout', 'main'])
    await gitExec('git', ['-C', work, 'merge', '--no-ff', '--no-edit', 'side'])
    const mergeOid = (await gitExec('git', ['-C', work, 'rev-parse', 'HEAD'])).stdout.trim()
    const session = sessionFor('git-merge', work, `Commit changes in repository ${work}.`)
    appendCall(session, 'merge-commit', 'bash', { command: 'git commit -m merged', workdir: work })
    // The merge was created out-of-band; the observer only verifies what the
    // persisted call/result bind, so echo the merge's own summary like a real
    // foreground commit would print.
    appendResult(session, 'merge-commit', `[main ${mergeOid.slice(0, 7)}] merged`)
    const result = await observer.execute({ effect_call_id: 'merge-commit' }, exec(session)) as { status: string; parent_oid: string }
    expect(result, JSON.stringify({ result, firstParent, secondParent, mergeOid })).toMatchObject({ status: 'observed', reason_code: 'git_commit_observed' })
    expect(result.parent_oid).toBe(firstParent)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)

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
