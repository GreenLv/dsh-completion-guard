import { describe, expect, it } from 'vitest'
import { captureClause } from '../../src/domain/capture.js'
import { deriveProjection, PROTOCOL_V4_NOTICE } from '../../src/domain/derive.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import type { DerivedEnvelope } from '../../src/domain/types.js'

/**
 * Target identity for paths, and the target-only-changed counterexample.
 *
 * A path is not a word: "/work/repo" and "./repo" open with a separator, so a
 * token reader that only starts on a letter never sees them and the field falls
 * back to the session working directory. That substitution is silent and
 * direction-changing — the obligation ends up bound to a different repository
 * than the one the root named — so the capture and the authorization boundary
 * are both pinned here, including the case where *only* the target differs.
 */

const replay = (texts: string[]) => deriveProjection([
  { seq: 0, type: 'user/message', data: { source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text: PROTOCOL_V4_NOTICE }] } },
  ...texts.map((text, index): DerivedEnvelope => ({ seq: index + 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })),
], { activation: 'always' }, { cwd: '/work' }, true).projection

const targetOf = (instruction: string) =>
  captureClause(instruction, 'm1', 'R001', 1, { cwd: '/work' }).requestedTarget as { repository?: string }

describe('a path written in the instruction is captured whole', () => {
  it.each([
    // Labelled: the word "repository" names the field.
    ['Push repository /work/repo remote origin refspec refs/heads/main.', '/work/repo'],
    ['Push repository /work/repo', '/work/repo'],
    ['推送仓库 /work/repo', '/work/repo'],
    // Unlabelled: the path after the verb is itself the object. Reading the
    // session working directory here would bind the push to another repository.
    ['push /work/repo', '/work/repo'],
    // Relative paths stay exactly as written; resolving them against the cwd
    // would invent a path the human never wrote.
    ['Push repository ./repo remote origin refspec refs/heads/main.', './repo'],
    ['Push repository ../repo', '../repo'],
    // Control: a relative path with no leading separator was already correct.
    ['Push repository repo/sub remote origin refspec refs/heads/main.', 'repo/sub'],
  ])('reads %s as %s', (instruction, expected) => {
    expect(targetOf(instruction)).toMatchObject({ repository: expected })
  })

  it('does not read a lone separator as a path', () => {
    // "/" followed by whitespace is punctuation, not a repository.
    expect(targetOf('Push repository / remote origin').repository).not.toBe('/')
  })

  it('keeps the working directory as the fallback only when no path is named', () => {
    expect(targetOf('Push the current branch to remote origin')).toMatchObject({ repository: '/work' })
  })
})

describe('an obligation is bound to the path it names', () => {
  const INSTRUCTION = 'Push repository /work/repo remote origin refspec refs/heads/main:refs/heads/main.'
  const RESOLVED = { remote: 'origin', refspec: 'refs/heads/main:refs/heads/main', local_oid: 'a'.repeat(64) }

  const authorize = (repository: string) => {
    const projection = replay([INSTRUCTION])
    const item = [...projection.items.values()][0]!
    return authorizeMutationFromProjection(projection, {
      action: 'push',
      contractItemId: item.id,
      contractItemRevision: item.revision,
      resolvedTarget: { repository, ...RESOLVED },
    })
  }

  it('authorizes the push of the repository the root named', () => {
    expect(authorize('/work/repo').status).not.toBe('denied')
  })

  it('denies the same action when only the repository differs', () => {
    // The truncated reading of "/work/repo" — the defect this pins — would
    // authorize the parent directory instead, so the counterexample changes
    // nothing but the target.
    expect(authorize('/work').status).toBe('denied')
    expect(authorize('/work')).toMatchObject({ reasonCode: 'mutation_requested_target_mismatch' })
    expect(authorize('/work/repo/other')).toMatchObject({
      status: 'denied', reasonCode: 'mutation_requested_target_mismatch',
    })
  })
})

/**
 * The same identity question at the wait: a reservation is released by a
 * trusted root statement that names the SAME work, and by nothing else. The
 * reserved target here is the working directory (the reservation names no
 * path), so a release only matches once "/work/repo" is captured whole —
 * which is why this block fails on the truncated reading rather than passing
 * for an unrelated reason.
 */
describe('only a matching trusted restatement supersedes the wait', () => {
  const RESERVED = '请在收到我的确认后再推送代码。'
  const MATCHING = 'Push repository /work/repo to remote origin refspec refs/heads/main:refs/heads/main.'
  const RESOLVED_PUSH = {
    repository: '/work/repo', remote: 'origin', refspec: 'refs/heads/main:refs/heads/main', local_oid: 'a'.repeat(64),
  }
  const project = (texts: string[]) => deriveProjection([
    { seq: 0, type: 'command/run', data: { name: 'context-guard', args: 'on', source: { kind: 'user' } } },
    { seq: 1, type: 'user/message', data: { source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text: PROTOCOL_V4_NOTICE }] } },
    ...texts.map((text, index): DerivedEnvelope => ({ seq: index + 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })),
  ], { activation: 'opt-in' }, { cwd: '/work/repo' }, true).projection
  const waitItems = (projection: ReturnType<typeof project>) =>
    [...projection.items.values()].filter((item) => item.waitAuthorization !== undefined)
  const authorize = (projection: ReturnType<typeof project>, item: { id: string; revision: number }) =>
    authorizeMutationFromProjection(projection, {
      action: 'push', contractItemId: item.id, contractItemRevision: item.revision, resolvedTarget: RESOLVED_PUSH,
    })

  it('supersedes the wait and authorizes the restated work', () => {
    const released = project([RESERVED, MATCHING])
    expect(waitItems(released).every((item) => item.status === 'superseded')).toBe(true)
    const open = [...released.items.values()].find((item) => item.status === 'pending')!
    expect(open.authorityDisposition).toBe('executable_now')
    // The release does not bypass the ordinary checks: a complete target is
    // what turns the restatement into an authorization.
    expect(authorize(released, open)).toEqual({ status: 'authorized', reasonCode: 'mutation_root_contract_authorized' })
  })

  it.each([
    ['an unrelated root instruction', 'Run the test suite.'],
    ['a narrative report of the confirmation', '我已经确认了。'],
    ['a quoted echo of the confirmation', 'The user said "收到我的确认" earlier.'],
    ['the restatement written before the reservation', undefined],
  ])('does not release the wait on %s', (_label, followUp) => {
    const projection = followUp === undefined
      ? project([MATCHING, RESERVED])
      : project([RESERVED, followUp])
    const wait = waitItems(projection)
    expect(wait).toHaveLength(1)
    expect(wait[0]!.status).toBe('pending')
    expect(wait[0]!.authorityDisposition).toBe('conditional_wait')
    // The reserved action is still refused, and the reason is the reservation
    // itself — not a target the restatement invalidated.
    expect(authorize(projection, wait[0]!)).toMatchObject({
      status: 'denied', reasonCode: 'mutation_awaiting_root_condition',
    })
  })

  it('does not release the wait when only the target differs', () => {
    const projection = project([RESERVED, 'Push repository /work/repo/other to remote origin refspec refs/heads/main:refs/heads/main.'])
    const wait = waitItems(projection)
    expect(wait).toHaveLength(1)
    expect(wait[0]!.status).toBe('pending')
    expect(authorize(projection, wait[0]!)).toMatchObject({
      status: 'denied', reasonCode: 'mutation_awaiting_root_condition',
    })
  })
})
