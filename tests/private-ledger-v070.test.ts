import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendPrivateLedger, applyPrivateLedger, hasPrivateRestartIntent, privateLedgerContractDigest, readPrivateLedger, resolvePrivateLedgerRoot } from '../src/domain/private-ledger.js'
import { createProjection } from '../src/domain/types.js'

const contract = { contractId: 'release-1', adoptedBy: { seq: 1, digest: 'a'.repeat(64) }, adoptedAtRevision: 1,
  operations: ['npm_publish' as const], candidate: { fullSha40: 'b'.repeat(40), artifactSri: 'sha512-YWJj' }, readinessRefs: [] }
const reservation = { contractId: 'release-1', operation: 'npm_publish', callId: 'call-1', startedAtSeq: 0,
  status: 'in_flight', contract_sha256: privateLedgerContractDigest(contract), target_sha256: 'c'.repeat(64) }

describe('v0.7 provider-invisible private ledger', () => {
  it('durably replays a pre-effect reservation and later settlement', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-private-ledger-'))
    try {
      expect(appendPrivateLedger(root, 'session-a', 'release_reservation', reservation)).toBe(true)
      let snapshot = readPrivateLedger(root, 'session-a')
      expect(snapshot).toMatchObject({ damaged: false, records: [{ position: 1, kind: 'release_reservation' }] })
      let projection = createProjection(); projection.releaseContracts.push(contract); applyPrivateLedger(projection, snapshot)
      expect(projection.releaseReservations).toMatchObject([{ contractId: 'release-1', callId: 'call-1', startedAtSeq: 0, ledgerPosition: 1 }])
      expect(appendPrivateLedger(root, 'session-a', 'release_settlement', { contractId: 'release-1',
        operation: 'npm_publish', callId: 'call-1', settledAtSeq: 0, readback: 'unavailable', outcome: 'unknown', settlement_source: 'effect' })).toBe(true)
      snapshot = readPrivateLedger(root, 'session-a')
      projection = createProjection(); projection.releaseContracts.push(contract); applyPrivateLedger(projection, snapshot)
      expect(projection.releaseSettlements).toMatchObject([{ contractId: 'release-1', callId: 'call-1',
        settledAtSeq: 0, ledgerPosition: 2, outcome: 'unknown' }])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('keeps restart intent out of messages and restores its exact binding', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-private-ledger-'))
    try {
      expect(appendPrivateLedger(root, 'session-restart', 'restart_intent', {
        resolution_call_id: 'resolve-1', service_id: 'market', pre_generation: 'boot-a',
      })).toBe(true)
      const restored = readPrivateLedger(root, 'session-restart')
      expect(hasPrivateRestartIntent(restored, 'resolve-1', 'market', 'boot-a')).toBe(true)
      expect(hasPrivateRestartIntent(restored, 'resolve-1', 'market', 'boot-b')).toBe(false)
      expect(JSON.stringify(restored)).not.toContain('user/message')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('fails closed on corruption, a cross-session copy, and a concurrent writer lock', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-private-ledger-'))
    try {
      expect(appendPrivateLedger(root, 'session-a', 'release_reservation', reservation)).toBe(true)
      const path = join(root, readdirSync(root).find((name) => name.endsWith('.jsonl') && !name.startsWith('session-anchors'))!)
      writeFileSync(join(root, '.writer.lock'), 'held')
      expect(appendPrivateLedger(root, 'session-a', 'release_settlement', {
        contractId: 'release-1', operation: 'npm_publish', callId: 'call-1', settledAtSeq: 0,
        readback: 'unavailable', outcome: 'unknown', settlement_source: 'effect',
      })).toBe(false)
      rmSync(join(root, '.writer.lock'))
      expect(appendPrivateLedger(root, 'session-b', 'restart_intent', {
        resolution_call_id: 'resolve', service_id: 'market', pre_generation: 'boot',
      })).toBe(true)
      const otherPath = join(root, readdirSync(root).filter((name) => name.endsWith('.jsonl') && !name.startsWith('session-anchors'))
        .find((name) => join(root, name) !== path)!)
      writeFileSync(otherPath, readFileSync(path))
      expect(readPrivateLedger(root, 'session-b').damaged).toBe(true)
      const original = readFileSync(path, 'utf8')
      writeFileSync(path, `${original.slice(0, -2)}x\n`)
      const damaged = readPrivateLedger(root, 'session-a')
      expect(damaged.damaged).toBe(true)
      const projection = createProjection(); applyPrivateLedger(projection, damaged)
      expect(projection.releaseStateDamaged).toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('detects a missing anchored ledger, context drift, and an orphan settlement', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-private-ledger-'))
    const context = { sessionId: 'bound', sessionHeader: { id: 'bound', createdAt: 1 }, cwd: '/work', hostLockDigest: 'h1' }
    try {
      expect(appendPrivateLedger(root, context, 'restart_intent', {
        resolution_call_id: 'resolve', service_id: 'market', pre_generation: 'boot',
      })).toBe(true)
      const path = join(root, readdirSync(root).find((name) => name.endsWith('.jsonl') && !name.startsWith('session-anchors'))!)
      rmSync(path)
      expect(readPrivateLedger(root, context).damaged).toBe(true)
      expect(readPrivateLedger(root, { ...context, cwd: '/other' }).damaged).toBe(true)
      const clean = mkdtempSync(join(tmpdir(), 'dsh-private-ledger-orphan-'))
      try {
        expect(appendPrivateLedger(clean, context, 'release_settlement', {
          contractId: 'release-1', operation: 'npm_publish', callId: 'orphan', settledAtSeq: 0,
          readback: 'unavailable', outcome: 'unknown',
        })).toBe(false)
      } finally { rmSync(clean, { recursive: true, force: true }) }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('uses official DSH home precedence and normalizes relative and tilde homes', () => {
    expect(resolvePrivateLedgerRoot('/configured', '/env', '/home/u')).toBe('/configured/completion-guard/private-ledger-v1')
    expect(resolvePrivateLedgerRoot(undefined, '/env', '/home/u')).toBe('/env/completion-guard/private-ledger-v1')
    expect(resolvePrivateLedgerRoot(undefined, '', '/home/u')).toBe('/home/u/.dsh/completion-guard/private-ledger-v1')
    expect(resolvePrivateLedgerRoot('~/state', undefined, '/home/u')).toBe('/home/u/state/completion-guard/private-ledger-v1')
    expect(resolvePrivateLedgerRoot('relative', undefined, '/home/u')).toBe(join(process.cwd(), 'relative/completion-guard/private-ledger-v1'))
  })

  it('rejects settlement sources and transitions that cannot release a reservation', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-private-ledger-transition-'))
    try {
      expect(appendPrivateLedger(root, 'transition', 'release_reservation', reservation)).toBe(true)
      expect(appendPrivateLedger(root, 'transition', 'release_settlement', {
        contractId: 'release-1', operation: 'npm_publish', callId: 'call-1', settledAtSeq: 0,
        readback: 'unavailable', outcome: 'not_effected', settlement_source: 'reconcile',
      })).toBe(true)
      const projection = createProjection(); projection.releaseContracts.push(contract)
      applyPrivateLedger(projection, readPrivateLedger(root, 'transition'))
      expect(projection.releaseStateDamaged).toBe(true)
      expect(projection.releaseSettlements).toEqual([])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
