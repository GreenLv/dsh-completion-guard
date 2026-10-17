import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deriveProjection } from '../src/domain/derive.js'
import { evidenceSha256Digest } from '../src/domain/digest.js'
import { evidenceFromPersistedToolResult } from '../src/domain/evidence.js'
import { DEFAULT_HOST_LOCK, type HostLockEvaluation } from '../src/domain/host-lock.js'
import type { DerivedEnvelope, GuardEvidence } from '../src/domain/types.js'

const bytes = readFileSync(new URL('./fixtures/legacy090-path-evidence.json', import.meta.url))
interface Snapshot {
  length: number
  integrity: string
  projection_identity_sha256: string
  log_state_sha256: string
  evidence: GuardEvidence[]
  evidence_identity_sha256: string
  certificate_digest: { sha256: string }
}
interface Vector { id: string; host_mode: 'qualified' | 'absent'; platform: 'posix' | 'windows'; cwd: string; events: DerivedEnvelope[]; prefixes: Snapshot[] }
const oracle = JSON.parse(bytes.toString()) as {
  baseline_commit: string; baseline_digest_source_sha256: string
  host_locks: Record<'posix' | 'windows', HostLockEvaluation>; vectors: Vector[]
}
const canonical = (value: unknown): string => JSON.stringify(value, (_key, v) => v instanceof Map ? { map: [...v] } : v instanceof Set ? { set: [...v] } : v)
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const derive = (vector: Vector, events: DerivedEnvelope[]) => deriveProjection(events, { activation: 'always' },
  { cwd: vector.cwd }, true, vector.host_mode === 'absent' ? undefined : oracle.host_locks[vector.platform]).projection
// Exact checkpoint EvidenceFact projection; the expected digest is computed
// by the independently transpiled 0.9.0 Git-blob encoder, not this encoder.
function fact(e: GuardEvidence) {
  return { id: e.id, outcome: e.outcome, method: e.toolName,
    operations: (e.operations ?? []).map(x => x.op), executables: e.executables ?? [], subjects: e.subjects,
    surfaces: e.surfaces, semanticAction: e.semanticAction ?? 'generic_run', evidenceRole: e.evidenceRole ?? 'effect',
    resolvedTarget: e.resolvedTarget ?? {}, observedState: e.observedState, parseStatus: e.parseStatus ?? 'adapter_unavailable',
    reasonCode: e.reasonCode ?? (e.parseStatus ? undefined : 'adapter_unavailable'), adapterId: e.adapterId, adapterVersion: e.adapterVersion }
}

describe('F-CG0100-01 frozen 0.9.0 no-cwd-event path evidence', () => {
  it('pins independent baseline executable bytes, encoder source and all frozen oracle bytes', () => {
    expect(oracle.baseline_commit).toBe('c190a8dc79f4a89ead953ee4cd400fb9568795cf')
    expect(oracle.baseline_digest_source_sha256).toBe('c5994afa680830e63ee602932a76dd90f670fa089b0d23ab2f3a9cc24d88ac01')
    expect(hash(bytes)).toBe('2b57b9438b74851448368f3f46553e498aeab62c74928141b9c16d55624bc12c')
    expect(oracle.vectors).toHaveLength(312)
    expect(oracle.vectors.reduce((n,v) => n + v.prefixes.length, 0)).toBe(1248)
  })
  it.each(oracle.vectors)('$id preserves every completed prefix and does not reinterpret it after a future round trip', vector => {
    expect(vector.events.some(event => event.type === 'working-directory/change')).toBe(false)
    for (const expected of vector.prefixes) {
      const p = derive(vector, vector.events.slice(0, expected.length))
      const evidence = [...p.evidence.values()]
      expect(p.integrity).toBe(expected.integrity)
      if (vector.host_mode === 'qualified') {
        expect(hash(canonical(p))).toBe(expected.projection_identity_sha256)
      } else {
        // An omitted lock selects each product's default host registry. That
        // intentional 0.2.0 -> 0.2.1 identity change is not a log semantic.
        // Assert the new binding itself and compare EVERY other field.
        const { hostLockDigest, hostCohortId, ...logState } = p
        expect(hostLockDigest).toBe(DEFAULT_HOST_LOCK.digest)
        expect(hostCohortId).toBe(DEFAULT_HOST_LOCK.cohortId)
        expect(hash(canonical(logState))).toBe(expected.log_state_sha256)
      }
      expect(evidence).toEqual(expected.evidence)
      expect(hash(JSON.stringify(evidence))).toBe(expected.evidence_identity_sha256)
      expect(evidenceSha256Digest(evidence.map(fact) as never)).toBe(expected.certificate_digest.sha256)
    }
    const completed = vector.prefixes.at(-1)!
    const changed = vector.platform === 'posix' ? '/work/later' : 'D:\\Later'
    const futureChanges = [
      { seq: 3, type: 'working-directory/change', data: { cwd: changed } },
      { seq: 4, type: 'working-directory/change', data: { cwd: vector.cwd } },
    ]
    for (const length of [1, 2]) {
      const future = derive(vector, [...vector.events, ...futureChanges.slice(0, length)])
      const evidence = [...future.evidence.values()]
      expect(hash(JSON.stringify(evidence))).toBe(completed.evidence_identity_sha256)
      expect(evidenceSha256Digest(evidence.map(fact) as never)).toBe(completed.certificate_digest.sha256)
    }
  })

  it('the generated production domain independently matches all 1248 frozen prefix evidence bytes and digests', async () => {
    const domain = await import(new URL('../dist/domain/index.js', import.meta.url).href) as typeof import('../src/domain/index.js')
    for (const vector of oracle.vectors) for (const expected of vector.prefixes) {
      const p = domain.deriveProjection(vector.events.slice(0, expected.length), { activation: 'always' }, { cwd: vector.cwd },
        true, vector.host_mode === 'absent' ? undefined : oracle.host_locks[vector.platform]).projection
      const evidence = [...p.evidence.values()]
      expect(hash(JSON.stringify(evidence)), `${vector.id} prefix ${expected.length}`).toBe(expected.evidence_identity_sha256)
      expect(evidenceSha256Digest(evidence.map(fact) as never)).toBe(expected.certificate_digest.sha256)
      if (vector.host_mode === 'qualified') expect(hash(canonical(p))).toBe(expected.projection_identity_sha256)
      else {
        const { hostLockDigest, hostCohortId, ...logState } = p
        expect(hostLockDigest).toBe(DEFAULT_HOST_LOCK.digest); expect(hostCohortId).toBe(DEFAULT_HOST_LOCK.cohortId)
        expect(hash(canonical(logState))).toBe(expected.log_state_sha256)
      }
    }
  })

  for (const cwd of ['/work/alpha', 'C:\\Work\\中文 空格', '\\\\server.example.com\\share\\Case']) {
    for (const ptc of [false, true]) {
      it(`selects epoch semantics only for an actually committed prior/in-flight epoch ${cwd} ptc=${ptc}`, () => {
        const platform = cwd.startsWith('/') ? 'posix' : 'windows'
        const name = platform === 'windows' ? 'pwsh' : 'bash'
        const args = { command: 'npm test', workdir: 'sub' }
        const host = oracle.host_locks[platform]
        const call = { seq: 1, type: ptc ? 'tool/ptc-dispatch-start' : 'tool/call', data: {
          name, ...(ptc ? { subCallId: 'call', rootCallId: 'root', arguments: args } : { callId: 'call', arguments: JSON.stringify(args) }),
        } }
        const result = { seq: 3, type: ptc ? 'tool/ptc-dispatch' : 'tool/result', data: ptc
          ? { subCallId: 'call', rootCallId: 'root', content: [{ type: 'text', text: 'PASS' }], isError: false }
          : { message: { role: 'tool', source: { kind: 'tool', callId: 'call' }, content: [{ type: 'text', text: 'PASS' }], isError: false } } }
        const origin = platform === 'posix' ? '/work/origin' : 'C:\\Origin'
        const prior = deriveProjection([{ seq: 0, type: 'working-directory/change', data: { cwd } }, call, result],
          { activation: 'always' }, { cwd: origin }, true, host).projection
        const path = (platform === 'windows' ? win32 : posix).resolve(cwd, 'sub')
        expect([...prior.evidence.values()][0]?.subjects).toContain(path)
        const moved = platform === 'posix' ? '/work/later' : 'D:\\Later'
        const inflight = deriveProjection([call, { seq: 2, type: 'working-directory/change', data: { cwd: moved } }, result],
          { activation: 'always' }, { cwd }, true, host).projection
        expect([...inflight.evidence.values()][0]).toMatchObject({ subjects: expect.arrayContaining([path]), outcome: 'unknown' })
        // Never let a model-supplied argument opt an unchanged log into the new reader.
        const unchanged = deriveProjection([{ ...call, data: { ...call.data, arguments: ptc ? { ...args, cwdReadVersion: 'epoch/v1' }
          : JSON.stringify({ ...args, cwdReadVersion: 'epoch/v1' }) } }, result], { activation: 'always' }, { cwd }, true, host).projection
        expect([...unchanged.evidence.values()][0]?.subjects).toContain('sub')
      })
    }
  }
  it('the direct persisted-result adapter defaults to the frozen read, with explicit epoch opt-in only', () => {
    const call = { callId: 'call', name: 'bash', arguments: '{"command":"npm test","workdir":"sub"}' }
    const result = { seq: 1, textContent: 'PASS' }
    const legacy = evidenceFromPersistedToolResult(call, result, 1, 'E1', '/work/alpha')
    const current = evidenceFromPersistedToolResult({ ...call, cwdReadVersion: 'epoch/v1' }, result, 1, 'E1', '/work/alpha')
    expect(legacy.subjects).toContain('sub')
    expect(current.subjects).toContain('/work/alpha/sub')
  })
})
