import { describe, expect, it } from 'vitest'
import {
  createGitPrestateEnvelope,
  executeRevalidatedGitEffect,
  parseGitCommandManifest,
  type GitCommandManifest,
  type GitTargetIdentity,
} from '../../src/domain/git-adapter.js'

/**
 * 0.6.1 W060-05 (review round 2): an effect that ALREADY holds must not be
 * re-run or certified through the guarded chain. After an out-of-chain
 * action the live state can look internally consistent (the review's probe:
 * source and remote already at the same OID), and a no-op re-run would
 * launder the unattributed execution into producer evidence. The executor
 * refuses with `effect_already_applied` before any command runs.
 */

function accepted(command: string): GitCommandManifest {
  const parsed = parseGitCommandManifest(command, 'bash')
  if (parsed.status !== 'accepted') throw new Error(parsed.reasonCode)
  return parsed.manifest
}

const target = (repository: string, remote?: string, refspec?: string): GitTargetIdentity => ({
  repository,
  ...(remote ? { remote } : {}),
  ...(refspec ? { refspec } : {}),
})

describe('0.6.1 W060-05: an already-applied git effect is refused, never re-run', () => {
  it('push: remote already at the local head refuses before the runner (review probe)', async () => {
    const manifest = accepted('git push origin refs/heads/release:refs/heads/main')
    const targetIdentity = target('/repo', 'origin', 'refs/heads/main')
    // Resolution froze the out-of-chain state: the remote is ALREADY at the
    // local head, so the push has nothing left to move.
    const state = { source_oid: 'a'.repeat(40), destination_oid: 'a'.repeat(40) }
    const resolved = createGitPrestateEnvelope(manifest, targetIdentity, state)
    let ran = 0
    const executed = await executeRevalidatedGitEffect(resolved, manifest, targetIdentity, state, async () => { ran += 1 })
    expect(executed).toMatchObject({ status: 'rejected', reasonCode: 'effect_already_applied' })
    expect(ran, 'no command may run').toBe(0)
  })

  it('pull: HEAD already at the upstream commit refuses before the runner', async () => {
    const manifest = accepted('git pull --ff-only --no-tags origin refs/heads/main')
    const targetIdentity = target('/repo', 'origin', 'refs/heads/main')
    const state = { upstream_oid: 'b'.repeat(40), pre_head_oid: 'b'.repeat(40), tracking_oid: 'b'.repeat(40) }
    const resolved = createGitPrestateEnvelope(manifest, targetIdentity, state)
    let ran = 0
    const executed = await executeRevalidatedGitEffect(resolved, manifest, targetIdentity, state, async () => { ran += 1 })
    expect(executed).toMatchObject({ status: 'rejected', reasonCode: 'effect_already_applied' })
    expect(ran).toBe(0)
  })

  it('fetch: tracking ref already at the upstream commit refuses before the runner', async () => {
    const manifest = accepted('git fetch --no-tags origin refs/heads/main:refs/remotes/origin/main')
    const targetIdentity = target('/repo', 'origin', 'refs/heads/main')
    const state = { upstream_oid: 'c'.repeat(40), pre_head_oid: 'd'.repeat(40), tracking_oid: 'c'.repeat(40) }
    const resolved = createGitPrestateEnvelope(manifest, targetIdentity, state)
    let ran = 0
    const executed = await executeRevalidatedGitEffect(resolved, manifest, targetIdentity, state, async () => { ran += 1 })
    expect(executed).toMatchObject({ status: 'rejected', reasonCode: 'effect_already_applied' })
    expect(ran).toBe(0)
  })

  it('a genuinely unapplied push still executes exactly once', async () => {
    const manifest = accepted('git push origin refs/heads/release:refs/heads/main')
    const targetIdentity = target('/repo', 'origin', 'refs/heads/main')
    const state = { source_oid: 'a'.repeat(40), destination_oid: 'e'.repeat(40) }
    const resolved = createGitPrestateEnvelope(manifest, targetIdentity, state)
    let ran = 0
    const executed = await executeRevalidatedGitEffect(resolved, manifest, targetIdentity, state, async () => { ran += 1 })
    expect(executed).toMatchObject({ status: 'executed' })
    expect(ran).toBe(1)
  })

  it('prestate drift still outranks the already-applied check', async () => {
    const manifest = accepted('git push origin refs/heads/release:refs/heads/main')
    const targetIdentity = target('/repo', 'origin', 'refs/heads/main')
    const frozen = { source_oid: 'a'.repeat(40), destination_oid: 'e'.repeat(40) }
    const resolved = createGitPrestateEnvelope(manifest, targetIdentity, frozen)
    // The remote moved after resolution: drift is the failure that reports.
    const drifted = { source_oid: 'a'.repeat(40), destination_oid: 'f'.repeat(40) }
    let ran = 0
    const executed = await executeRevalidatedGitEffect(resolved, manifest, targetIdentity, drifted, async () => { ran += 1 })
    expect(executed).toMatchObject({ status: 'rejected', reasonCode: 'prestate_drift' })
    expect(ran).toBe(0)
  })
})
