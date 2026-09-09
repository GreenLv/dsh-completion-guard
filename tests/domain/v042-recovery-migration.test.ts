import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { describe, expect, it } from 'vitest'
import { captureClause } from '../../src/domain/capture.js'
import { createProjection } from '../../src/domain/types.js'
import { renderRecoveryPacket, recoveryDigest } from '../../src/domain/recovery.js'
import { deriveProjection, CAPTURE_V042_NOTICE, PROTOCOL_V3_NOTICE } from '../../src/domain/derive.js'
import { currentContractDigest } from '../../src/domain/contract-digest.js'

const user = (seq: number, text: string) => ({ seq, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const notice = (seq: number, text: string) => ({ seq, type: 'user/message', data: { source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text }] } })

describe('0.4.2 recovery and old-log compatibility', () => {
  it.each([3999, 4000, 4001])('T08 preserves rules and constraints around %i characters', count => {
    const p = createProjection()
    p.items.set('R1', captureClause('更新 /repo/' + '中'.repeat(count), 'm1', 'R1', 1))
    p.items.set('P1', captureClause('不要发布', 'm2', 'P1', 2))
    for (const budget of [512, 4000]) {
      const packet = renderRecoveryPacket(p, { charBudget: budget })
      expect(packet.length).toBeLessThanOrEqual(budget)
      expect(packet).toContain('DO NOT')
      expect(packet).toContain('uncertified')
      expect(packet).toContain('checkpoint')
      expect(packet).toContain('folded')
    }
    for (const budget of [0, 511, NaN, Infinity, 512.5]) expect(() => renderRecoveryPacket(p, { charBudget: budget })).toThrow(RangeError)
  })
  it('T09 ignores unrelated evidence but changes the digest for relevant facts and new requirements', () => {
    const p = createProjection()
    p.items.set('R1', captureClause('Run pnpm test', 'm1', 'R1', 1, { cwd: '/repo' }))
    const identity = () => recoveryDigest(renderRecoveryPacket(p), p)
    const before = identity()
    const evidence = { id: 'E1', epoch: 0, callId: 'c1', rootCallId: 'c1', toolName: 'bash', toolResultSeq: 1,
      outcome: 'success' as const, subjects: ['/other'], surfaces: ['scope' as const], capabilities: [], boundedSummarySha256: 'a'.repeat(64),
      parseStatus: 'supported' as const, adapterId: 'dsh.bash.v1', adapterVersion: '1.0.0', semanticAction: 'test' as const, resolvedTarget: { scope: '/other', executable: 'pnpm' } }
    p.evidence.set(evidence.id, evidence)
    expect(identity()).toBe(before)
    evidence.resolvedTarget.scope = '/repo'
    const relevant = identity()
    expect(relevant).not.toBe(before)
    expect(identity()).toBe(relevant)
    p.items.set('R2', captureClause('更新演示包', 'm2', 'R2', 2))
    p.contractRevision++
    expect(identity()).not.toBe(relevant)
  })
  it('T10 preserves old pending identities until a durable version notice and uses new capture only afterwards', () => {
    const old = [notice(0, PROTOCOL_V3_NOTICE), user(1, '更新皮肤中心并在本地仓库记录')]
    const replay = (events: typeof old) => deriveProjection(events, { activation: 'always' }, { cwd: '/repo' }, true).projection
    const original = replay(old)
    expect([...original.items.values()]).toHaveLength(1)
    const migrated = replay([...old, notice(2, CAPTURE_V042_NOTICE)])
    expect([...migrated.items]).toEqual([...original.items])
    expect(currentContractDigest(migrated)).toBe(currentContractDigest(original))
    const current = replay([...old, notice(2, CAPTURE_V042_NOTICE), user(3, '更新其他插件并在本地仓库记录')])
    expect([...current.items.values()]).toHaveLength(3)
    expect(current.items.get('R001')).toEqual(original.items.get('R001'))
  })
})

it.each(['不要提交并推送', '不要安装并发布', 'Do not install and publish'])('preserves coordinated negative authority: %s', text => {
  const p = deriveProjection([user(1, text + '. Run pnpm test.')], { activation: 'always' }, { cwd: '/repo' }, true).projection
  const items = [...p.items.values()]
  expect(items.filter(i => i.kind === 'requirement').map(i => i.semanticAction)).toEqual(['test'])
  const prohibition = items.find(i => i.kind === 'prohibition')!
  expect(prohibition).toBeDefined()
  for (const action of ['install', 'publish', 'commit', 'push'] as const) {
    expect(authorizeMutationFromProjection(p, { action, contractItemId: prohibition.id,
      contractItemRevision: prohibition.revision, resolvedTarget: {} }).status).toBe('denied')
  }
})

it('reserves current work and folding summaries under constraint and rejection pressure', () => {
  const p = createProjection()
  for (let i = 0; i < 30; i++) p.items.set('P' + i, captureClause('不要发布 package' + i, 'm' + i, 'P' + i + 'x'.repeat(500), i))
  p.items.set('Rnew', captureClause('更新皮肤中心', 'm40', 'Rnew', 40))
  const rejectedBindings = Array.from({ length: 30 }, (_, i) => ({ itemId: 'R' + i + 'x'.repeat(2000), reason: 'failure'.repeat(1000) }))
  for (const charBudget of [512, 1000, 4000]) {
    const packet = renderRecoveryPacket(p, { charBudget, rejectedBindings })
    expect(packet.length).toBeLessThanOrEqual(charBudget)
    expect(packet).toContain('Rnew')
    expect(packet).toContain('generic_run_non_certifiable')
    expect(packet).toContain('uncertified')
    expect(packet).toContain('items folded')
    expect(packet).toContain('rejections folded')
    expect(packet).toContain('DO NOT')
  }
})

it('uses a capability remedy for a small-budget unavailable host', () => {
  const p = createProjection()
  p.hostStatus = 'unavailable'
  p.items.set('R1', captureClause('Run pnpm test', 'm1', 'R1', 1, { cwd: '/repo' }))
  const packet = renderRecoveryPacket(p, { charBudget: 512 })
  expect(packet).toContain('host_unavailable')
  expect(packet).toContain('Restore')
  expect(packet).not.toContain('context_guard_rebind')
})

it.each(['不要提交并推送。Run pnpm test.', 'Run pnpm test. Do not install and publish.', 'Run pnpm test；不要安装并发布'])('keeps positive authority across explicit sentence boundaries: %s', text => {
  const p = deriveProjection([user(1, text)], { activation: 'always' }, { cwd: '/repo' }, true).projection
  expect([...p.items.values()].filter(i => i.kind === 'requirement').map(i => i.semanticAction)).toEqual(['test'])
  expect([...p.items.values()].filter(i => i.kind === 'prohibition')).toHaveLength(1)
})
