import { it, expect, describe } from 'vitest'
import type { JobStatus } from '@deepseek-ai/dsh-jobs'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { readExternalOperation } from '../../src/runtime.js'
import type { ExternalOperationSnapshot } from '../../src/tools/external-operation.js'

/**
 * Guard's external-operation readback against the host's DECLARED job contract.
 *
 * `readExternalOperation` is a STRUCTURAL lookup: it finds the service as
 * `ctx.get('jobs')`, calls `get(id, agent)`, and maps `snapshot.status` into its
 * own vocabulary. The host's real contract was read from the installed
 * `@deepseek-ai/dsh-jobs` declarations and matches on all three points —
 * `super(ctx, "jobs")`, `abstract get(id: JobId, caller?: Agent): JobSnapshot`,
 * and `JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'`.
 *
 * A live registry is deliberately NOT used here. `LocalJobRegistry` itself has
 * no injected services, but `start()` refuses work while no job controller
 * serves the owner, so hosting a real job would require composing
 * `@deepseek-ai/dsh-tool-jobs` and its dependencies — a miniature host, which
 * this batch is forbidden from starting. Instead the mapping is bound to the
 * host's declared union, and the exhaustiveness below is enforced by the
 * COMPILER: adding a status upstream makes the test file fail to typecheck,
 * which forces a deliberate decision instead of a silent `unknown`.
 */

/** Compiler-enforced exhaustiveness over the host's own status union. */
const EXPECTED_MAPPING: Record<JobStatus, ExternalOperationSnapshot['status']> = {
  running: 'running',
  stopping: 'pending',
  completed: 'completed',
  killed: 'failed',
  failed: 'failed',
}

// A live Agent always carries a scoped `ctx`; Guard probes `agent.ctx` FIRST and
// only then the root context. The scoped context here deliberately has no jobs
// service, which is the ordinary case that exercises the fallback.
const AGENT = { id: 'agent-1', ctx: { get: () => undefined } } as unknown as Agent

function contextWith(service: unknown) {
  return {
    get: (name: string) => (name === 'jobs' ? service : undefined),
    jobs: service,
  }
}

/** A scoped context that DOES carry the service, to prove the first probe wins. */
const SCOPED_AGENT = {
  id: 'agent-1',
  ctx: { get: (name: string) => (name === 'jobs' ? { get: () => ({ status: 'completed' }) } : undefined) },
} as unknown as Agent

describe('external operation readback against the host job contract', () => {
  it.each(Object.entries(EXPECTED_MAPPING))('maps host status %s to %s', (hostStatus, expected) => {
    const service = { get: () => ({ id: 'bash-1', status: hostStatus }) }
    expect(readExternalOperation(contextWith(service) as never, AGENT, 'bash-1'))
      .toEqual({ id: 'bash-1', status: expected, adapterId: 'dsh.jobs.v1' })
  })

  it('covers every status the host declares', () => {
    // Redundant with the Record type on purpose: the runtime assertion documents
    // the intent, and the type is what makes it fail closed at compile time.
    expect(Object.keys(EXPECTED_MAPPING).sort()).toEqual(
      ['completed', 'failed', 'killed', 'running', 'stopping'])
  })

  it('fails closed when the service throws for an unknown or foreign job', () => {
    // The real `get` throws for unknown or foreign ids; Guard must read that as
    // "no information", never as "still running".
    const service = { get: () => { throw new Error('unknown job') } }
    expect(readExternalOperation(contextWith(service) as never, AGENT, 'nope-1')).toBeUndefined()
  })

  it('reports no information when the service returns no row', () => {
    for (const row of [undefined, null]) {
      expect(readExternalOperation(contextWith({ get: () => row }) as never, AGENT, 'bash-1'), String(row))
        .toBeUndefined()
    }
  })

  it('never guesses a terminal state for a status outside the host union', () => {
    // A status the host does not declare must read as `unknown`, not as
    // completed or failed: guessing "finished" would let a live external wait be
    // treated as settled, and guessing "failed" would discard a valid one.
    for (const row of [{}, { status: undefined }, { status: 7 },
      { status: { state: 'running' } }, { status: 'exited' }, { status: 'succeeded' },
      { status: 'success' }, { status: 'cancelled' }, { status: 'done' }]) {
      expect(readExternalOperation(contextWith({ get: () => row }) as never, AGENT, 'bash-1'), JSON.stringify(row))
        .toEqual({ id: 'bash-1', status: 'unknown', adapterId: 'dsh.jobs.v1' })
    }
  })

  it('prefers the agent-scoped service over the root context', () => {
    const root = { get: () => ({ get: () => ({ status: 'running' }) }), jobs: { get: () => ({ status: 'running' }) } }
    expect(readExternalOperation(root as never, SCOPED_AGENT, 'bash-1'))
      .toMatchObject({ status: 'completed' })
  })

  it('fails closed when no jobs service is present at all', () => {
    expect(readExternalOperation({ get: () => undefined } as never, AGENT, 'bash-1')).toBeUndefined()
  })

  it('fails closed when the service has no callable get', () => {
    expect(readExternalOperation(contextWith({ list: () => [] }) as never, AGENT, 'bash-1')).toBeUndefined()
  })

  it('fails closed without an agent or without an id', () => {
    const service = { get: () => ({ status: 'running' }) }
    expect(readExternalOperation(contextWith(service) as never, undefined, 'bash-1')).toBeUndefined()
    expect(readExternalOperation(contextWith(service) as never, AGENT, '')).toBeUndefined()
  })

  it('reports the requested id, not a row id the service invented', () => {
    // Guard binds the snapshot to the id it asked for, so a misbehaving or
    // confused provider cannot re-key the readback.
    const service = { get: () => ({ id: 'other-9', status: 'running' }) }
    expect(readExternalOperation(contextWith(service) as never, AGENT, 'bash-1'))
      .toMatchObject({ id: 'bash-1' })
  })
})
