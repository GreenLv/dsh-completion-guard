import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  commitIndexSnapshotDigest,
  commitTreeSnapshotDigest,
  createGitPrestateEnvelope,
  executeRevalidatedGitEffect,
  gitCommandMatchesTarget,
  parseGitCommandManifest,
  revalidateGitPrestate,
  verifiedLinearCommitReadback,
  type GitCommandManifest,
  type GitTargetIdentity,
} from '../../src/domain/git-adapter.js'

function accepted(command: string, surface: 'bash' | 'pwsh' = 'bash'): GitCommandManifest {
  const parsed = parseGitCommandManifest(command, surface)
  expect(parsed.status).toBe('accepted')
  if (parsed.status !== 'accepted') throw new Error(parsed.reasonCode)
  return parsed.manifest
}

describe('audited git command manifests', () => {
  it('keeps the shipped command manifest aligned with production IDs', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../manifests/git-command-manifest.v2.json', import.meta.url), 'utf8')) as {
      parser: string
      commands: Record<string, unknown>
      effectGate: { envelopeVersion: string }
    }
    expect(manifest.parser).toBe('production-shell-parser-canonical-argv')
    expect(Object.keys(manifest.commands).sort()).toEqual([
      'git.commit_index_tree.v2',
      'git.fetch_tracking_explicit.v2',
      'git.ls_remote_exact.v2',
      'git.pull_ff_only_explicit.v2',
      'git.push_explicit_refs.v2',
    ])
    expect(manifest.effectGate.envelopeVersion).toBe('git.prestate.v1')
  })

  it('derives canonical argv through the production shell parser', () => {
    expect(accepted('git commit -m "release candidate"').argv).toEqual(['git', 'commit', '-m', 'release candidate'])
    expect(accepted('git commit -m "release candidate" 2>&1', 'pwsh').argv).toEqual(['git', 'commit', '-m', 'release candidate'])
  })

  it('accepts only exact remote inspection, tracking fetch, ff-only pull, and explicit push shapes', () => {
    expect(accepted('git ls-remote --exit-code --refs origin refs/heads/main')).toMatchObject({
      manifestId: 'git.ls_remote_exact.v2', remote: 'origin', sourceRef: 'refs/heads/main',
    })
    expect(accepted('git fetch --no-tags origin refs/heads/main:refs/remotes/origin/main')).toMatchObject({
      manifestId: 'git.fetch_tracking_explicit.v2', sourceRef: 'refs/heads/main', trackingRef: 'refs/remotes/origin/main',
    })
    expect(accepted('git pull --ff-only --no-tags origin refs/heads/main')).toMatchObject({
      manifestId: 'git.pull_ff_only_explicit.v2', sourceRef: 'refs/heads/main',
    })
    expect(accepted('git push origin refs/heads/release:refs/heads/main')).toMatchObject({
      manifestId: 'git.push_explicit_refs.v2', sourceRef: 'refs/heads/release', destinationRef: 'refs/heads/main',
    })
  })

  it.each([
    'git -C /tmp/repository push origin refs/heads/main:refs/heads/main',
    'git -c alias.ship=push ship origin refs/heads/main:refs/heads/main',
    'git ship origin refs/heads/main:refs/heads/main',
    'git push --force origin refs/heads/main:refs/heads/main',
    'git push origin refs/heads/*:refs/heads/*',
    'git push origin :refs/heads/main',
    'git push origin refs/heads/main',
    'git push origin HEAD:refs/heads/main',
    'git fetch origin refs/heads/main',
    'git fetch --no-tags origin refs/heads/main:refs/remotes/upstream/main',
    'git ls-remote origin refs/heads/main',
  ])('rejects unsafe or implicit argv: %s', (command) => {
    expect(parseGitCommandManifest(command, 'bash').status).toBe('rejected')
  })

  it('keeps push source and destination identities distinct and rejects target swap', () => {
    const manifest = accepted('git push origin refs/heads/release:refs/heads/main')
    const intended: GitTargetIdentity = {
      repository: '/repo', remote: 'origin', refspec: 'refs/heads/release:refs/heads/main',
    }
    expect(gitCommandMatchesTarget(manifest, intended)).toBe(true)
    expect(gitCommandMatchesTarget(manifest, { ...intended, refspec: 'refs/heads/release:refs/heads/other' })).toBe(false)
    expect(gitCommandMatchesTarget(manifest, { ...intended, refspec: 'refs/heads/main:refs/heads/main' })).toBe(false)
  })
})

describe('git resolution-to-effect prestate', () => {
  it('rejects ref and remote-state drift immediately before effect', () => {
    const manifest = accepted('git push origin refs/heads/release:refs/heads/main')
    const target: GitTargetIdentity = {
      repository: '/repo', remote: 'origin', refspec: 'refs/heads/release:refs/heads/main',
    }
    const state = { source_oid: 'a'.repeat(40), destination_oid: 'b'.repeat(40) }
    const resolved = createGitPrestateEnvelope(manifest, target, state)
    expect(revalidateGitPrestate(resolved, manifest, target, state)).toEqual({ valid: true })
    expect(revalidateGitPrestate(resolved, manifest, target, { ...state, source_oid: 'c'.repeat(40) })).toEqual({
      valid: false, reasonCode: 'prestate_drift',
    })
    expect(revalidateGitPrestate(resolved, manifest, { ...target, remote: 'upstream' }, state)).toEqual({
      valid: false, reasonCode: 'target_identity_drift',
    })
  })

  it('normalizes read-only raw index/tree tuples without write-tree', () => {
    const exact = Buffer.from(`100644 ${'c'.repeat(40)} 0\ta.txt\0`, 'utf8')
    const whitespaceDrift = Buffer.concat([exact, Buffer.from('\n')])
    const indexDrift = Buffer.from(`100644 ${'d'.repeat(40)} 0\ta.txt\0`, 'utf8')
    const tree = Buffer.from(`100644 blob ${'c'.repeat(40)}\ta.txt\0`, 'utf8')
    const digest = commitIndexSnapshotDigest(exact)
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(commitTreeSnapshotDigest(tree)).toBe(digest)
    expect(commitIndexSnapshotDigest(whitespaceDrift)).toBeUndefined()
    expect(commitIndexSnapshotDigest(indexDrift)).not.toBe(digest)
    expect(commitIndexSnapshotDigest(new Uint8Array())).toBeUndefined()
  })

  it('accepts only a post-commit raw readback with exactly the resolved parent', () => {
    const pre = 'a'.repeat(40)
    const post = 'b'.repeat(40)
    const other = 'c'.repeat(40)
    expect(verifiedLinearCommitReadback(Buffer.from(`${post} ${pre}\n`), pre)).toEqual({
      postHeadOid: post,
      preHeadOid: pre,
    })
    expect(verifiedLinearCommitReadback(Buffer.from(`${post}\n`), pre)).toBeUndefined()
    expect(verifiedLinearCommitReadback(Buffer.from(`${post} ${pre} ${other}\n`), pre)).toBeUndefined()
    expect(verifiedLinearCommitReadback(Buffer.from(`${post} ${other}\n`), pre)).toBeUndefined()
    expect(verifiedLinearCommitReadback(Buffer.from(`${'d'.repeat(64)} ${pre}\n`), pre)).toBeUndefined()
    expect(verifiedLinearCommitReadback(Buffer.from(`${post} ${pre}`), pre)).toBeUndefined()
  })

  it('rejects raw index drift at the mandatory pre-effect gate', () => {
    const manifest = accepted('git commit -m release')
    const target: GitTargetIdentity = { repository: '/repo' }
    const before = { pre_head_oid: 'a'.repeat(40), tree_oid: 'b'.repeat(40), index_entries: Buffer.from('entry\0') }
    const resolved = createGitPrestateEnvelope(manifest, target, before)
    expect(revalidateGitPrestate(resolved, manifest, target, {
      ...before, index_entries: Buffer.from('changed\0'),
    })).toEqual({ valid: false, reasonCode: 'prestate_drift' })
  })

  it('never invokes the effect runner after target/ref drift', async () => {
    const manifest = accepted('git push origin refs/heads/release:refs/heads/main')
    const target: GitTargetIdentity = {
      repository: '/repo', remote: 'origin', refspec: 'refs/heads/release:refs/heads/main',
    }
    const state = { source_oid: 'a'.repeat(40), destination_oid: 'b'.repeat(40) }
    const resolved = createGitPrestateEnvelope(manifest, target, state)
    const calls: unknown[][] = []
    const runner = async (...args: ['git', string[], string]): Promise<void> => { calls.push(args) }

    await expect(executeRevalidatedGitEffect(resolved, manifest, target, {
      ...state, source_oid: 'c'.repeat(40),
    }, runner)).resolves.toEqual({ status: 'rejected', reasonCode: 'prestate_drift' })
    expect(calls).toEqual([])

    await expect(executeRevalidatedGitEffect(resolved, manifest, target, state, runner)).resolves.toEqual({ status: 'executed' })
    expect(calls).toEqual([['git', ['push', 'origin', 'refs/heads/release:refs/heads/main'], '/repo']])
  })
})
