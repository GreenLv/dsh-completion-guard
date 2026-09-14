import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply } from '../../src/runtime.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from '../../src/domain/host-lock.js'
import { certifyCheckpoint } from '../../src/domain/checkpoint.js'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { inFlightReservation, settledOperations } from '../../src/domain/release.js'
import { createUserMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'

/**
 * 0.6.0 C10 production release chain (F04/F05).
 *
 * This is the acceptance the review asked for: ONE test drives a real root
 * publish instruction, a real certified candidate closure, a real contract
 * adoption, a real tgz and resolution through the registered evidence tool, and
 * then calls the registered action tool — which consults the RUNTIME's own
 * release gate, writes the real reservation, settles from the real settlement
 * path, and finally reconciles through the registered recovery tool.
 *
 * Only two things are replaced, and exactly the two the review allows: the npm
 * command runner (no package is published) and the registry HTTP client (no
 * network). The authorization gate, the reservation and settlement records, the
 * evidence producers and the replay are the production ones.
 */

interface RegisteredTool {
  name: string
  execute?: (args: never, exec: never) => Promise<Record<string, unknown>>
  output?: { presentationMeta?: (args: unknown, value: unknown) => unknown }
}

const SHA = 'f'.repeat(40)
const PACKAGE = 'fixture-chain'
const VERSION = '1.0.0'
const REGISTRY = 'https://registry.example.invalid/'
const OTHER_SRI = `sha512-${Buffer.alloc(64, 2).toString('base64')}`

function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('000644 \0', 100, 8, 'ascii')
  header.write('000000 \0', 108, 8, 'ascii')
  header.write('000000 \0', 116, 8, 'ascii')
  header.write(`${size.toString(8).padStart(11, '0')} `, 124, 12, 'ascii')
  header.write('00000000000 ', 136, 12, 'ascii')
  header.write('        ', 148, 8, 'ascii')
  header.write('0', 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return header
}

async function packFixture(root: string, name: string, version: string): Promise<string> {
  const output = join(root, 'packs')
  await mkdir(output, { recursive: true })
  const manifest = Buffer.from(JSON.stringify({
    name, version, files: ['index.js'], gitHead: SHA,
    repository: { type: 'git', url: 'https://github.com/GreenLv/dsh-completion-guard.git' },
  }), 'utf8')
  const padding = Buffer.alloc((512 - (manifest.length % 512)) % 512)
  const tar = Buffer.concat([
    tarHeader('package/package.json', manifest.length), manifest, padding,
    tarHeader('package/index.js', 3), Buffer.from('x\n\n', 'utf8'),
    Buffer.alloc(1024),
  ])
  const path = join(output, `${name}-${version}.tgz`)
  await writeFile(path, gzipSync(tar, { level: 9 }))
  return path
}

function execution(session: Session, callId: string, name: string) {
  return {
    callId, rootCallId: callId, name, arguments: {},
    agent: { session }, signal: new AbortController().signal,
    deferContext: () => {}, concludeTurn: () => {}, token: Symbol('test'),
  } as never
}

/** Boot the real plugin against a real Session and capture its tool surface. */
function startRuntime(session: Session, seams: { commandRunner?: () => Promise<void>; fetcher?: typeof fetch }) {
  const tools: RegisteredTool[] = []
  const handlers = new Map<string, unknown[]>()
  const ctx = {
    commands: { register: () => () => {} },
    on: (name: string, handler: unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); return () => {} },
    get: () => undefined,
    sessions: { flush: async () => true },
  }
  apply(ctx as never, { activation: 'always', policy: 'release' } as never, {
    ...(seams.commandRunner ? { commandRunner: seams.commandRunner } : {}),
    ...(seams.fetcher ? { fetcher: seams.fetcher } : {}),
    allowLoopbackHttpRegistry: true,
    // The audited cohort is pinned so the action-scoped capability row is
    // supported without reading a live profile graph. This replaces the
    // host-lock EVALUATION only; the release gate under acceptance is the real
    // runtime gate below.
    // `goalAvailable: false` because this acceptance run boots no Goal service;
    // the lock's own suites cover the Goal binding.
    hostLock: {
      ...evaluateHostLock(EXPECTED_HOST_PACKAGES, {
        platform: process.platform === 'win32' ? 'windows' : 'posix',
        profileKind: 'web',
      }),
      goalAvailable: false,
    },
  })
  const agent = {
    session,
    steer: () => {},
    ctx: {
      tools: {
        register: (tool: RegisteredTool) => { tools.push(tool); return () => {} },
        guard: () => () => {},
        get: () => undefined,
      },
      get: () => undefined,
    },
  }
  for (const handler of handlers.get('agent/session-start') ?? []) {
    (handler as (payload: unknown) => void)({ agent, source: 'startup' })
  }
  return { tools, agent: agent as unknown as Agent }
}


/** Persist a tool round trip exactly as the host loop does. */
async function runTool(
  session: Session,
  tools: RegisteredTool[],
  name: string,
  callId: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const tool = tools.find((entry) => entry.name === name)!
  append(session, 'tool/call', { turn: 1, step: session.seq, callId, name, arguments: JSON.stringify(args) })
  const value = await tool.execute!(args as never, execution(session, callId, name)) as Record<string, unknown>
  const meta = tool.output?.presentationMeta?.(args, value)
  append(session, 'tool/result', {
    turn: 1, step: session.seq,
    message: createToolResultMessage({ callId: callId as never, content: [{ type: 'text', text: JSON.stringify(value) }], isError: false }),
    ...(meta ? { meta } : {}),
  }, { surfaceOp: 'append' })
  return value
}

function append(session: Session, type: string, data: unknown, options?: unknown): void {
  ;(session as unknown as { append(type: string, data: unknown, options?: unknown): void }).append(type, data, options)
}

function notice(session: Session, text: string): void {
  append(session, 'user/message', {
    source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' },
    content: [{ type: 'text', text }],
  }, { surfaceOp: 'append' })
}

function command(session: Session, args: string): void {
  append(session, 'command/run', { commandId: `cmd-${session.seq}`, name: 'context-guard', args, source: { kind: 'user' } })
}

function projectionOf(session: Session) {
  return deriveProjection(session.snapshotEvents() as never, { activation: 'always', policy: 'release' }, { cwd: process.cwd() }, true).projection
}

describe('0.6.0 C10: the release chain runs on the production wiring', () => {
  it('publishes under a real adopted contract, reserves, settles, and reconciles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cg-chain-'))
    try {
      const tgz = await packFixture(root, PACKAGE, VERSION)
      const published: string[][] = []
      const registryState = { integrity: `sha512-${Buffer.alloc(64, 5).toString('base64')}` }
      const fetcher = (async (input: string | URL) => {
        const url = String(input)
        if (!url.startsWith(REGISTRY)) return new Response('{}', { status: 404 })
        const name = decodeURIComponent(url.slice(REGISTRY.length).replace(/\/+$/, ''))
        return new Response(JSON.stringify({
          name,
          versions: { [VERSION]: { name, version: VERSION, dist: { integrity: registryState.integrity } } },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as unknown as typeof fetch
      const session = Session.create(SessionId('release-chain'), undefined, {
        version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId('release-chain'), createdAt: 1, cwd: root,
      })
      const { tools } = startRuntime(session, {
        commandRunner: async () => { published.push([...published].length ? [] : []) },
        fetcher,
      })
      const byName = (name: string) => tools.find((tool) => tool.name === name)!
      expect(byName('context_guard_release'), 'the recovery entry is registered').toBeDefined()

      // The candidate PREPARATION closure is certified first (an empty closure
      // here), then the contract is adopted, and only then does the real root
      // publish instruction arrive — the order the review's counterexample
      // uses, and the only order in which publishing does not depend on having
      // already published.
      notice(session, PROTOCOL_V5_NOTICE)
      // A real preparation obligation, then a durable clear: this is the
      // candidate work the closure certificate answers for.
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: '创建 report.txt' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      command(session, 'clear')
      const beforeCert = projectionOf(session)
      const certified = certifyCheckpoint(beforeCert, [], 'C1', false)
      expect(certified.status, JSON.stringify(certified.rejectedBindings)).toBe('certified')
      const checkpoint = certified.checkpoint!
      append(session, 'tool/call', { turn: 1, step: session.seq, callId: 'closure', name: 'context_guard_checkpoint', arguments: '{"bindings":[]}' })
      append(session, 'tool/result', {
        turn: 1, step: session.seq,
        message: createToolResultMessage({ callId: 'closure' as never, content: [{ type: 'text', text: JSON.stringify({
          status: 'certified',
          certificate: {
            stop_protocol_version: checkpoint.stopProtocolVersion, certificate_version: checkpoint.certificateVersion,
            epoch: checkpoint.epoch, session_ref_digest: checkpoint.sessionRefDigest, host_lock_digest: checkpoint.hostLockDigest,
            contract_revision: checkpoint.contractRevision, contract_sha256: checkpoint.contractSha256,
            open_digest: checkpoint.openDigest, evidence_sha256: checkpoint.evidenceSha256,
            binding_digest: checkpoint.bindingDigest, certification_digest: checkpoint.certificationDigest,
            goal_ref: checkpoint.goalRef ?? null,
            ...(checkpoint.unitId !== undefined ? { unit_id: checkpoint.unitId, unit_closure_digest: checkpoint.unitClosureDigest } : {}),
          },
        }) }], isError: false }),
      }, { surfaceOp: 'append' })

      // The contract is adopted by a real root command, freezing the CLOSURE
      // revision; this needs the real SHA-256 and SRI of the artifact, so the
      // resolution is produced first and the contract is built from it.
      const resolution = await runTool(session, tools, 'context_guard_evidence', 'chain-resolution', {
        semantic_action: 'publish', evidence_role: 'resolution',
        selector: { artifact_id: PACKAGE, version: VERSION, registry: REGISTRY },
        command_manifest: { manifest_id: 'npm.publish_tgz.v1', tgz_path: tgz },
      }) as unknown as { status: string; resolved_target: Record<string, string>; target_digest: string }
      expect(resolution.status, JSON.stringify(resolution)).toBe('supported')
      const sri = resolution.resolved_target.integrity_digest
      expect(sri).toMatch(/^sha512-/)
      const { createHash } = await import('node:crypto')
      const { readFile } = await import('node:fs/promises')
      const artifactSha256 = createHash('sha256').update(await readFile(tgz)).digest('hex')
      const contract = {
        contractId: 'rel-chain',
        operations: ['npm_publish'],
        candidate: {
          fullSha40: SHA, repository: 'https://github.com/GreenLv/dsh-completion-guard.git',
          packageId: PACKAGE, version: VERSION, artifactSha256, artifactSri: sri, registry: REGISTRY,
        },
        readinessRefs: ['C1'],
        closureCertRef: 'C1',
      }
      command(session, `release adopt ${JSON.stringify(contract)}`)
      const adopted = projectionOf(session)
      expect(adopted.releaseContracts).toHaveLength(1)

      // The authorized release obligation arrives AFTER adoption, as a real
      // root instruction. It bumps the contract revision and must NOT
      // invalidate the closure the contract froze.
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `Publish package ${PACKAGE} version ${VERSION} registry ${REGISTRY}` }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      const releaseItem = [...projectionOf(session).items.values()]
        .find((entry) => entry.status === 'pending' && entry.semanticAction === 'publish')
      expect(releaseItem, 'the release instruction captured a publish obligation').toBeDefined()

      // The real action tool, with the REAL runtime gate and no npm execution.
      const value = await runTool(session, tools, 'context_guard_action', 'chain-action', {
        semantic_action: 'publish', resolution_call_id: 'chain-resolution',
        target_digest: resolution.target_digest, contract_item_id: releaseItem!.id, contract_item_revision: releaseItem!.revision,
      })
      expect(value.status, JSON.stringify(value)).toBe('completed')
      expect(published).toHaveLength(1)

      // The reservation was written before the effect and the registry readback
      // settles it, because the registry answers with the released bytes.
      registryState.integrity = sri
      const afterEffect = projectionOf(session)
      expect(afterEffect.releaseReservations).toHaveLength(1)
      expect(settledOperations(afterEffect, 'rel-chain')).toEqual([])
      expect(inFlightReservation(afterEffect, 'rel-chain', 'npm_publish')?.callId).toBe('chain-resolution')

      // The registered recovery entry reconciles it from a trusted readback and
      // never re-sends the publish.
      const reconciled = await runTool(session, tools, 'context_guard_release', 'chain-reconcile', {
        operation: 'reconcile', contract_id: 'rel-chain', resolution_call_id: 'chain-resolution',
      })
      expect(reconciled.status, JSON.stringify(reconciled)).toBe('settled')
      expect(published).toHaveLength(1)
      const settledProjection = projectionOf(session)
      expect(settledOperations(settledProjection, 'rel-chain')).toEqual(['npm_publish'])
      expect(inFlightReservation(settledProjection, 'rel-chain', 'npm_publish')).toBeUndefined()

      // A second publish attempt is refused as a consumed ticket, not re-run.
      const replay = await runTool(session, tools, 'context_guard_action', 'chain-action-2', {
        semantic_action: 'publish', resolution_call_id: 'chain-resolution',
        target_digest: resolution.target_digest, contract_item_id: releaseItem!.id, contract_item_revision: releaseItem!.revision,
      })
      expect(replay.status).toBe('unavailable')
      expect(replay.reason_code).toBe('release_operation_consumed')
      expect(published).toHaveLength(1)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('a revoked-but-in-flight attempt is still reconcilable after a restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cg-chain-'))
    try {
      const tgz = await packFixture(root, PACKAGE, VERSION)
      let integrity: string | undefined
      const fetcher = (async () => (integrity === undefined
        ? new Response('{}', { status: 404 })
        : new Response(JSON.stringify({
            name: PACKAGE, versions: { [VERSION]: { name: PACKAGE, version: VERSION, dist: { integrity } } },
          }), { status: 200, headers: { 'content-type': 'application/json' } }))) as unknown as typeof fetch
      const session = Session.create(SessionId('release-chain-revoked'), undefined, {
        version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId('release-chain-revoked'), createdAt: 1, cwd: root,
      })
      const { tools } = startRuntime(session, { commandRunner: async () => {}, fetcher })
      notice(session, PROTOCOL_V5_NOTICE)
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: '创建 report.txt' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      command(session, 'clear')
      const certified = certifyCheckpoint(projectionOf(session), [], 'C1', false).checkpoint!
      append(session, 'tool/call', { turn: 1, step: session.seq, callId: 'closure', name: 'context_guard_checkpoint', arguments: '{"bindings":[]}' })
      append(session, 'tool/result', {
        turn: 1, step: session.seq,
        message: createToolResultMessage({ callId: 'closure' as never, content: [{ type: 'text', text: JSON.stringify({
          status: 'certified',
          certificate: {
            stop_protocol_version: certified.stopProtocolVersion, certificate_version: certified.certificateVersion,
            epoch: certified.epoch, session_ref_digest: certified.sessionRefDigest, host_lock_digest: certified.hostLockDigest,
            contract_revision: certified.contractRevision, contract_sha256: certified.contractSha256,
            open_digest: certified.openDigest, evidence_sha256: certified.evidenceSha256,
            binding_digest: certified.bindingDigest, certification_digest: certified.certificationDigest,
            goal_ref: certified.goalRef ?? null,
            ...(certified.unitId !== undefined ? { unit_id: certified.unitId, unit_closure_digest: certified.unitClosureDigest } : {}),
          },
        }) }], isError: false }),
      }, { surfaceOp: 'append' })
      const resolution = await runTool(session, tools, 'context_guard_evidence', 'revoked-resolution', {
        semantic_action: 'publish', evidence_role: 'resolution',
        selector: { artifact_id: PACKAGE, version: VERSION, registry: REGISTRY },
        command_manifest: { manifest_id: 'npm.publish_tgz.v1', tgz_path: tgz },
      }) as unknown as { resolved_target: Record<string, string>; target_digest: string }
      const sri = resolution.resolved_target.integrity_digest
      const { createHash } = await import('node:crypto')
      const { readFile } = await import('node:fs/promises')
      command(session, `release adopt ${JSON.stringify({
        contractId: 'rel-revoked', operations: ['npm_publish'],
        candidate: {
          fullSha40: SHA, packageId: PACKAGE, version: VERSION, registry: REGISTRY,
          artifactSha256: createHash('sha256').update(await readFile(tgz)).digest('hex'),
        },
        readinessRefs: ['C1'], closureCertRef: 'C1',
      })}`)
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `Publish package ${PACKAGE} version ${VERSION} registry ${REGISTRY}` }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      const releaseItem = [...projectionOf(session).items.values()]
        .find((entry) => entry.status === 'pending' && entry.semanticAction === 'publish')!
      const value = await runTool(session, tools, 'context_guard_action', 'revoked-action', {
        semantic_action: 'publish', resolution_call_id: 'revoked-resolution',
        target_digest: resolution.target_digest, contract_item_id: releaseItem.id, contract_item_revision: releaseItem.revision,
      })
      expect(value.status).toBe('completed')

      // The user revokes the contract while the attempt is still in flight.
      command(session, 'release revoke rel-revoked')
      const revoked = projectionOf(session)
      expect(revoked.releaseContracts[0]!.revokedAtSeq).toBeDefined()
      expect(inFlightReservation(revoked, 'rel-revoked', 'npm_publish')).toBeDefined()

      // Recovery still works: revocation withdrew FUTURE authority, not the duty
      // to reconcile an effect that may already have happened.
      integrity = sri
      const reconciled = await runTool(session, tools, 'context_guard_release', 'revoked-reconcile', {
        operation: 'reconcile', contract_id: 'rel-revoked', resolution_call_id: 'revoked-resolution',
      })
      expect(reconciled.status, JSON.stringify(reconciled)).toBe('settled')
      expect(settledOperations(projectionOf(session), 'rel-revoked')).toEqual(['npm_publish'])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('the recovery entry refuses to settle an unreadable or different readback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cg-chain-'))
    try {
      const tgz = await packFixture(root, PACKAGE, VERSION)
      // The registry is unreachable during the effect (so the attempt stays
      // `unconfirmed`, not damaged), and answers with DIFFERENT bytes at
      // reconciliation time.
      let answer: string | undefined
      const fetcher = (async () => {
        if (answer === undefined) return new Response('{}', { status: 404 })
        return new Response(JSON.stringify({
          name: PACKAGE, versions: { [VERSION]: { name: PACKAGE, version: VERSION, dist: { integrity: answer } } },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as unknown as typeof fetch
      const session = Session.create(SessionId('release-chain-recovery'), undefined, {
        version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId('release-chain-recovery'), createdAt: 1, cwd: root,
      })
      const { tools } = startRuntime(session, { commandRunner: async () => {}, fetcher })
      notice(session, PROTOCOL_V5_NOTICE)
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: '创建 report.txt' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      command(session, 'clear')
      const certified = certifyCheckpoint(projectionOf(session), [], 'C1', false).checkpoint!
      append(session, 'tool/call', { turn: 1, step: session.seq, callId: 'closure', name: 'context_guard_checkpoint', arguments: '{"bindings":[]}' })
      append(session, 'tool/result', {
        turn: 1, step: session.seq,
        message: createToolResultMessage({ callId: 'closure' as never, content: [{ type: 'text', text: JSON.stringify({
          status: 'certified',
          certificate: {
            stop_protocol_version: certified.stopProtocolVersion, certificate_version: certified.certificateVersion,
            epoch: certified.epoch, session_ref_digest: certified.sessionRefDigest, host_lock_digest: certified.hostLockDigest,
            contract_revision: certified.contractRevision, contract_sha256: certified.contractSha256,
            open_digest: certified.openDigest, evidence_sha256: certified.evidenceSha256,
            binding_digest: certified.bindingDigest, certification_digest: certified.certificationDigest,
            goal_ref: certified.goalRef ?? null,
            ...(certified.unitId !== undefined ? { unit_id: certified.unitId, unit_closure_digest: certified.unitClosureDigest } : {}),
          },
        }) }], isError: false }),
      }, { surfaceOp: 'append' })
      const resolution = await runTool(session, tools, 'context_guard_evidence', 'recovery-resolution', {
        semantic_action: 'publish', evidence_role: 'resolution',
        selector: { artifact_id: PACKAGE, version: VERSION, registry: REGISTRY },
        command_manifest: { manifest_id: 'npm.publish_tgz.v1', tgz_path: tgz },
      }) as unknown as { resolved_target: Record<string, string>; target_digest: string }
      const { createHash } = await import('node:crypto')
      const { readFile } = await import('node:fs/promises')
      command(session, `release adopt ${JSON.stringify({
        contractId: 'rel-recovery', operations: ['npm_publish'],
        candidate: {
          fullSha40: SHA, packageId: PACKAGE, version: VERSION, registry: REGISTRY,
          artifactSha256: createHash('sha256').update(await readFile(tgz)).digest('hex'),
        },
        readinessRefs: ['C1'], closureCertRef: 'C1',
      })}`)
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `Publish package ${PACKAGE} version ${VERSION} registry ${REGISTRY}` }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      const releaseItem = [...projectionOf(session).items.values()]
        .find((entry) => entry.status === 'pending' && entry.semanticAction === 'publish')!
      const value = await runTool(session, tools, 'context_guard_action', 'recovery-action', {
        semantic_action: 'publish', resolution_call_id: 'recovery-resolution',
        target_digest: resolution.target_digest, contract_item_id: releaseItem.id, contract_item_revision: releaseItem.revision,
      })
      expect(value.status).toBe('completed')
      expect(projectionOf(session).releaseStateDamaged).toBe(false)

      // Now the registry answers with different bytes than the released
      // artifact: the readback is reported, but it does NOT settle the attempt.
      answer = OTHER_SRI
      const mismatched = await runTool(session, tools, 'context_guard_release', 'recovery-reconcile', {
        operation: 'reconcile', contract_id: 'rel-recovery', resolution_call_id: 'recovery-resolution',
      })
      expect(mismatched.status).toBe('mismatch')
      expect(mismatched.reason_code).toBe('release_readback_identity_mismatch')
      const damaged = projectionOf(session)
      expect(damaged.releaseStateDamaged).toBe(true)
      expect(damaged.integrity).toBe('valid')
      expect(settledOperations(damaged, 'rel-recovery')).toEqual([])

      // A status query is read-only: it never changes the release state.
      const status = await runTool(session, tools, 'context_guard_release', 'recovery-status', {
        operation: 'status',
      })
      expect(status.status).toBe('available')
      expect(projectionOf(session).releaseStateDamaged).toBe(true)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
}, 30_000)
