import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { LocalJobRegistry } from '@deepseek-ai/dsh-jobs-local'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { deriveProjection } from '../src/domain/derive.js'
import { cwdEpochsFromEvents, isAbsoluteWorkingDirectory } from '../src/domain/cwd-timeline.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'
import { readExternalOperation } from '../src/runtime.js'
import type { DerivedEnvelope } from '../src/domain/types.js'

const HOST = { ...evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' }), auditedForegroundRenderers: ['bash', 'pwsh'] as Array<'bash' | 'pwsh'> }
const HEADER = { version: SESSION_FORMAT_VERSION, id: 'review', createdAt: 1, seedLength: 0, delegationDepth: 0 }
const derive = (events: DerivedEnvelope[], cwd = '/work/alpha', platform: 'posix' | 'windows' = 'posix') => deriveProjection(events, { activation: 'always' }, { cwd, sessionHeader: HEADER }, true, { ...HOST, platform }).projection
const env = (seq: number, type: string, data: unknown): DerivedEnvelope => ({ seq, type, data })
const base = { jobId: 'j1', owner: 'review', kind: 'bash', label: 'bounded job', startedAt: 1 }
const settled = { ...base, finishedAt: 2, status: 'completed', cause: 'producer', producerReported: true }
const operation = (seq: number): DerivedEnvelope[] => [
  env(seq, 'tool/call', { turn: 1, step: 1, callId: 'poll', name: 'context_guard_external_operation', arguments: '{"operation_id":"j1"}' }),
  env(seq + 1, 'tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'poll' as never, content: [{ type: 'text', text: 'running' }], isError: false }), meta: { contextGuardExternalOperation: { id: 'j1', adapterId: 'dsh.jobs.v1', status: 'running' } } }),
]

describe('F-CG0100-01: call identity across late ordinary and PTC returns', () => {
  for (const ptc of [false, true]) {
    for (const name of ['read', 'write', 'edit', 'bash', 'pwsh']) {
      for (const workdir of (['bash', 'pwsh'].includes(name) ? [undefined, 'sub', '/explicit/absolute'] : [undefined])) {
        it(`${ptc ? 'PTC' : 'ordinary'} ${name} workdir=${workdir} keeps call epoch through multiple round trips`, () => {
          const shell = ['bash', 'pwsh'].includes(name)
          const args = shell ? { command: 'cat src/a.ts', ...(workdir ? { workdir } : {}) }
            : { file_path: 'src/a.ts', content: 'x', old_string: 'x', new_string: 'y' }
          const call = ptc ? env(1, 'tool/ptc-dispatch-start', { subCallId: 'c1', rootCallId: 'r1', name, arguments: args })
            : env(1, 'tool/call', { callId: 'c1', turn: 1, step: 1, name, arguments: JSON.stringify(args) })
          const result = ptc ? env(6, 'tool/ptc-dispatch', { subCallId: 'c1', rootCallId: 'r1', name, content: [{ type: 'text', text: 'ok' }], isError: false })
            : env(6, 'tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'c1' as never, content: [{ type: 'text', text: 'ok' }], isError: false }) })
          const control = [...derive([call, result], '/work/alpha', name === 'pwsh' ? 'windows' : 'posix').evidence.values()][0]!
          const late = [...derive([call, env(2, 'working-directory/change', { cwd: '/work/beta' }), env(3, 'working-directory/change', { cwd: '/work/alpha' }), env(4, 'working-directory/change', { cwd: '/work/gamma' }), result], '/work/alpha', name === 'pwsh' ? 'windows' : 'posix').evidence.values()][0]!
          expect(late).toBeDefined()
          expect(late.subjects).toEqual(control.subjects)
          expect(late.operations).toEqual(control.operations)
          expect(late.resolvedTarget).toEqual(control.resolvedTarget)
          expect(late.outcome).toBe(shell && workdir === '/explicit/absolute' ? control.outcome : 'unknown')
          if (shell && workdir === 'sub') expect(late.subjects).toContain('/work/alpha/sub')
          expect(JSON.stringify(late)).not.toContain('/work/gamma')
        })
      }
    }
  }
  for (const name of ['bash', 'pwsh']) {
    for (const cwd of ['C:\\Work\\中文 空格', '\\\\server.example.com\\share\\Case']) {
      it(`${name} resolves relative workdir with the call's Windows path semantics ${cwd}`, () => {
        const events = [env(1, 'tool/call', { callId: 'win', name, arguments: '{"command":"npm test","workdir":"sub"}' }),
          env(3, 'tool/result', { message: createToolResultMessage({ callId: 'win' as never, content: [{ type: 'text', text: 'ok' }], isError: false }) })]
        const fact = [...derive(events, cwd, name === 'pwsh' ? 'windows' : 'posix').evidence.values()][0]!
        expect(fact.subjects).toContain(cwd + '\\sub')
        expect(fact.outcome).toBe('success')
      })
    }
    for (const workdir of ['C:relative', '\\root-relative', '/root-relative', null]) {
      it(`${name} refuses ambiguous Windows explicit workdir ${workdir}`, () => {
        const fact = [...derive([env(1, 'tool/call', { callId: 'win', name, arguments: JSON.stringify({ command: 'npm test', workdir }) }),
          env(2, 'tool/result', { message: createToolResultMessage({ callId: 'win' as never, content: [{ type: 'text', text: 'ok' }], isError: false }) })], 'C:\\Work').evidence.values()][0]!
        expect(fact.outcome).toBe('unknown')
      })
    }
  }
  it('a native absolute file target is independent of a directory recovery', () => {
    const call = env(1, 'tool/call', { callId: 'abs', name: 'read', arguments: '{"file_path":"/outside/a.ts"}' })
    const result = env(3, 'tool/result', { message: createToolResultMessage({ callId: 'abs' as never, content: [{ type: 'text', text: 'ok' }], isError: false }) })
    expect([...derive([call, env(2, 'working-directory/change', { cwd: '/work/beta' }), result]).evidence.values()][0]).toMatchObject({ outcome: 'success', subjects: ['/outside/a.ts'] })
  })
})

describe('F-CG0100-02/04: lifecycle field and transition matrix', () => {
  for (const type of ['job/registered', 'job/settled']) {
    for (const field of ['jobId', 'owner', 'kind', 'label', 'startedAt', 'toolCall']) {
      for (const value of [null, 7, '', {}, []]) {
        if (field === 'startedAt' && value === 7) continue
        it(`${type} rejects ${field}=${JSON.stringify(value)} before coercion`, () => {
          const data = { ...(type === 'job/settled' ? settled : base), [field]: value }
          expect(derive([env(1, type, data)]).integrity).toBe('corrupt')
        })
      }
    }
    for (const field of ['jobId', 'owner', 'kind', 'label', 'startedAt']) {
      it(`${type} rejects missing ${field}`, () => {
        const data: Record<string, unknown> = { ...(type === 'job/settled' ? settled : base) }; delete data[field]
        expect(derive([env(1, type, data)]).integrity).toBe('corrupt')
      })
    }
  }
  for (const patch of [
    { startedAt: 99 }, { owner: 'foreign' }, { kind: 'pwsh' }, { label: 'different' },
    { toolCall: { callId: 'other', rootCallId: 'root' } },
  ]) {
    it(`compares all registration identity fields at settlement ${JSON.stringify(patch)}`, () => {
      expect(derive([env(1, 'job/registered', base), env(2, 'job/settled', { ...settled, ...patch })]).integrity).toBe('corrupt')
    })
  }
  for (const patch of [{ finishedAt: 0 }, { finishedAt: -1 }, { finishedAt: 1.1 }, { finishedAt: NaN }, { detail: {} }, { producerReported: 'yes' }, { cause: 'unknown' }, { status: 'running' }, { toolCall: { callId: '', rootCallId: 'x' } }]) {
    it(`validates complete orphan settlement ${JSON.stringify(patch)}`, () => {
      expect(derive([env(1, 'job/settled', { ...settled, ...patch })]).integrity).toBe('corrupt')
    })
  }
  for (const patch of [{ finishedAt: 3 }, { detail: 'changed' }, { status: 'failed' }, { cause: 'kill' }, { producerReported: false }]) {
    it(`refuses conflicting duplicate settlement ${JSON.stringify(patch)}`, () => {
      expect(derive([env(1, 'job/registered', base), env(2, 'job/settled', settled), env(3, 'job/settled', { ...settled, ...patch })]).integrityViolations).toContain('job_settled_conflict')
    })
  }
  it('keeps identical duplicates idempotent and rejects registration after settlement', () => {
    const p = derive([env(1, 'job/registered', base), env(2, 'job/registered', base), env(3, 'job/settled', settled), env(4, 'job/settled', settled)])
    expect(p.integrity).toBe('valid'); expect(p.jobLifecycle?.get('j1')?.settled?.settledAtSeq).toBe(3)
    expect(derive([env(1, 'job/settled', settled), env(2, 'job/registered', base)]).integrity).toBe('corrupt')
  })
  for (const owner of ['review', 'foreign']) {
    for (const paired of [true, false]) {
      it(`only a paired current owner can refine external waits owner=${owner}, paired=${paired}`, () => {
        const events = [...(paired ? [env(1, 'job/registered', { ...base, owner })] : []), ...operation(2), env(4, 'job/settled', { ...settled, owner })]
        const p = derive(events)
        expect(p.integrity).toBe('valid')
        expect(p.externalOperations.get('j1')?.status).toBe(paired && owner === 'review' ? 'completed' : 'running')
        const session = Session.create(SessionId('review'))
        const agent = { id: session.id, session, ctx: { get: () => undefined } } as unknown as Agent
        expect(readExternalOperation({ get: () => undefined } as never, agent, 'j1', p)?.status).toBe(paired && owner === 'review' ? 'completed' : undefined)
      })
    }
  }
  for (const ptc of [false, true]) {
    for (const root of ['root', 'wrong-root']) {
      it(`binds original ${ptc ? 'PTC' : 'ordinary'} root identity ${root}`, () => {
        const toolCall = { callId: 'exec', rootCallId: root }
        const call = env(1, ptc ? 'tool/ptc-dispatch-start' : 'tool/call', { callId: 'exec', subCallId: 'exec', rootCallId: 'root', name: 'bash', arguments: '{}' })
        const p = derive([call, env(2, 'job/registered', { ...base, toolCall }), ...operation(3), env(5, 'job/settled', { ...settled, toolCall })])
        expect(p.integrity).toBe('valid')
        expect(p.externalOperations.get('j1')?.status).toBe(root === 'root' ? 'completed' : 'running')
      })
    }
  }
  for (const owner of [undefined, 'review', 'foreign', null, 7]) {
    it(`the live registry honors exact owned and official unowned access owner=${owner}`, () => {
      const session = Session.create(SessionId('review'))
      const agent = { id: session.id, session, ctx: { get: () => ({ get: () => ({ id: 'j1', owner, status: 'completed' }) }) } } as unknown as Agent
      expect(readExternalOperation({} as never, agent, 'j1')?.status).toBe(owner === undefined || owner === 'review' ? 'completed' : undefined)
    })
  }
  it('never trusts a foreign row returned by a misbehaving live registry', () => {
    const session = Session.create(SessionId('review'))
    const agent = { id: session.id, session, ctx: { get: () => ({ get: () => ({ id: 'j1', owner: 'foreign', status: 'completed' }) }) } } as unknown as Agent
    expect(readExternalOperation({} as never, agent, 'j1')).toBeUndefined()
  })
  it('the official JobsLocal producer can write a healthy orphan after one registration append failure', async () => {
    const ctx = new Context(); const agents = new AgentRegistry(ctx)
    const session = Session.create(SessionId('review'))
    const raw = { id: session.id, session, ctx, status: 'idle', steer: () => {} }
    raw.ctx = createScope(ctx, raw).ctx
    const agent = raw as unknown as Agent
    const detach = await agents.register(agent)
    const jobs = new LocalJobRegistry(ctx, {}); const controller = jobs.attachController('orphan-test')
    const append = session.append.bind(session)
    let failures = 0
    session.append = ((type: string, ...args: unknown[]) => {
      if (type === 'job/registered') { failures++; throw new Error('controlled registration persistence failure') }
      return (append as (...args: unknown[]) => unknown)(type, ...args)
    }) as typeof session.append
    try {
      let finish!: (result: { status: 'completed'; detail: string }) => void
      const done = new Promise<{ status: 'completed'; detail: string }>((resolve) => { finish = resolve })
      const id = jobs.start({ owner: agent.id, kind: 'bash', label: 'healthy orphan', run: () => ({ cancel: () => {}, done }) })
      finish({ status: 'completed', detail: 'producer finished' }); await done; await Promise.resolve()
      const events = session.snapshotEvents() as unknown as DerivedEnvelope[]
      expect(failures).toBe(1)
      expect(events.map((event) => event.type)).toEqual(['job/settled'])
      const p = derive(events)
      expect(p.integrity).toBe('valid')
      expect(p.jobLifecycle?.get(id)).toMatchObject({ owner: 'review', settled: { status: 'completed', detail: 'producer finished' } })
      expect(p.jobLifecycle?.get(id)?.registeredAtSeq).toBeUndefined()
      // Official producer accepts nonempty text verbatim, including whitespace.
      session.append = append
      const whitespaceId = jobs.start({ owner: agent.id, kind: ' ' as never, label: '   ', run: () => ({ cancel: () => {}, done: Promise.resolve({ status: 'completed' as const }) }) })
      await Promise.resolve(); await Promise.resolve()
      const whitespaceProjection = derive(session.snapshotEvents() as unknown as DerivedEnvelope[])
      expect(whitespaceProjection.integrity).toBe('valid')
      expect(whitespaceProjection.jobLifecycle?.get(whitespaceId)).toMatchObject({ kind: ' ', label: '   ', settled: { status: 'completed' } })
      jobs.remove(whitespaceId, agent.id)
      jobs.remove(id, agent.id)
      expect(readExternalOperation(ctx, agent, id, p)).toBeUndefined()
    } finally { session.append = append; controller(); await detach(); await ctx.fiber.dispose() }
  })
})

describe('F-CG0100-03: exact absolute cwd spelling, Windows UNC and native boundaries', () => {
  it('retains POSIX double-slash absolute paths under a POSIX header', () => {
    const events = [env(1, 'working-directory/change', { cwd: '//work' }), env(2, 'working-directory/change', { cwd: '/next' })]
    expect(cwdEpochsFromEvents(events, '/origin')).toEqual([{ seq: 1, cwd: '//work' }, { seq: 2, cwd: '/next' }])
    expect(derive(events, '/origin').integrity).toBe('valid')
  })
  for (const cwd of ['\\\\server.example.com\\share', '\\\\server\\share', '\\\\server\\share\\中文 空格\\Case', 'C:\\Work\\中文 空格', 'd:/Mixed/CASE']) {
    it(`accepts ${cwd} without normalization in both consumers`, () => {
      const event = env(1, 'working-directory/change', { cwd })
      expect(cwdEpochsFromEvents([event], 'C:\\original')).toEqual([{ seq: 1, cwd }])
      const p = derive([event], 'C:\\original'); expect(p.integrity).toBe('valid'); expect(p.cwdEpochs).toEqual([{ seq: 1, cwd }])
    })
  }
  for (const cwd of ['C:relative', '\\root-relative', '/root-relative', '\\\\server', '\\\\server\\', '\\\\?\\C:\\device', '\\\\.\\pipe\\x', 'relative', 'C:\\nul\0path']) {
    it(`rejects incomplete or ambiguous Windows cwd ${JSON.stringify(cwd)}`, () => {
      expect(isAbsoluteWorkingDirectory(cwd, 'C:\\original')).toBe(false)
      const event = env(1, 'working-directory/change', { cwd })
      expect(cwdEpochsFromEvents([event], 'C:\\original')).toBeUndefined()
      expect(derive([event], 'C:\\original').integrity).toBe('corrupt')
    })
  }
})
