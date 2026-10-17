import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { hostWorkdirForCall, HOST_WORKDIR_PREFIX } from '../src/domain/host-workdir.js'
import type { DerivedEnvelope } from '../src/domain/types.js'

const env = (seq: number, type: string, data: unknown): DerivedEnvelope => ({ seq, type, data })
const change = (seq: number, cwd: string): DerivedEnvelope => env(seq, 'working-directory/change', { cwd })
const args = '{"command":"npm test"}'
const call = env(10, 'tool/call', { callId: 'c1', turn: 1, name: 'bash', arguments: args })
const result = env(20, 'tool/result', {})
const root = env(5, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Run npm test.' }] })
const histories: Record<string, DerivedEnvelope[]> = {
  unchanged: [env(1, 'plugin:ignored/note', {})],
  noop: [change(1, '/work/alpha')],
  beta: [change(1, '/work/beta')],
  roundtrip_alpha: [change(1, '/work/beta'), change(2, '/work/alpha')],
  roundtrip_beta: [change(1, '/work/beta'), change(2, '/work/alpha'), change(3, '/work/beta')],
}
function read(version: 1 | 2, before: DerivedEnvelope[], during: DerivedEnvelope[], after: DerivedEnvelope[],
  origin = '/work/alpha', trustedOrigin: string | undefined = '/work/alpha'): string | undefined {
  const effective = version === 1 ? '/work/alpha' : '/work/beta'
  const receipt = { version, callId: 'c1', callSeq: 10, rootSeq: 5, turn: 1, toolName: 'bash',
    sessionRefDigest: 'same-session-digest', hostLockDigest: 'same-host-digest', headerCwd: effective, effectiveCwd: effective,
    policySource: 'bash-policy', policyRoot: version === 2 ? origin : '/work/alpha', argumentsSha256: createHash('sha256').update(args).digest('hex'),
    ...(version === 2 ? { originCwd: origin, cwdEpochSeq: 1 } : {}) }
  const notice = env(30, 'user/message', { source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text: HOST_WORKDIR_PREFIX + JSON.stringify(receipt) }] })
  return hostWorkdirForCall([...before, root, call, ...during, result, ...after, notice], call, result, 5,
    'same-session-digest', 'same-host-digest', effective, trustedOrigin)
}

describe('F-CG0100-01: receipt version × timeline × replay identity matrix', () => {
  for (const version of [1, 2] as const) {
    for (const [name, before] of Object.entries(histories)) {
      for (const during of ['none', 'change', 'roundtrip'] as const) {
        for (const after of ['none', 'change'] as const) {
          it(`v${version}, before=${name}, during=${during}, after=${after} uses the same root/call/result/digests`, () => {
            const middle = during === 'none' ? [] : during === 'change' ? [change(11, '/work/gamma')]
              : [change(11, '/work/gamma'), change(12, version === 1 ? '/work/alpha' : '/work/beta')]
            const tail = after === 'none' ? [] : [change(21, '/work/after')]
            const validBefore = version === 1 ? name === 'unchanged' : name === 'beta'
            expect(read(version, before, middle, tail)).toBe(validBefore && during === 'none'
              ? version === 1 ? '/work/alpha' : '/work/beta' : undefined)
          })
        }
      }
    }
  }
  it('keeps v1 unchanged-history compatibility without a new origin parameter', () => {
    // Omit the actual optional parameter (default argument above supplies it).
    const receipt = { version: 1, callId: 'c1', callSeq: 10, rootSeq: 5, turn: 1, toolName: 'bash',
      sessionRefDigest: 'same-session-digest', hostLockDigest: 'same-host-digest', headerCwd: '/work/alpha', effectiveCwd: '/work/alpha',
      policySource: 'bash-policy', policyRoot: '/work/alpha', argumentsSha256: createHash('sha256').update(args).digest('hex') }
    const notice = env(30, 'user/message', { source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text: HOST_WORKDIR_PREFIX + JSON.stringify(receipt) }] })
    expect(hostWorkdirForCall([root, call, result, notice], call, result, 5, 'same-session-digest', 'same-host-digest', '/work/alpha')).toBe('/work/alpha')
    const v2 = { ...receipt, version: 2, headerCwd: '/work/beta', effectiveCwd: '/work/beta', originCwd: '/work/alpha', cwdEpochSeq: 1 }
    const v2Notice = env(30, 'user/message', { source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text: HOST_WORKDIR_PREFIX + JSON.stringify(v2) }] })
    expect(hostWorkdirForCall([...histories.beta!, root, call, result, v2Notice], call, result, 5, 'same-session-digest', 'same-host-digest', '/work/beta')).toBeUndefined()
  })
  it('v2 refuses receipt-supplied origin changes while every other identity stays correct', () => {
    expect(read(2, histories.beta!, [], [])).toBe('/work/beta')
    expect(read(2, histories.beta!, [], [], '/forged/origin')).toBeUndefined()
    expect(read(2, histories.beta!, [], [], '/work/alpha', '/different/header')).toBeUndefined()
  })
})
