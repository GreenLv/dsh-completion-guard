import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { deriveProjection } from '../../src/domain/derive.js'
import { certifyCheckpoint } from '../../src/domain/checkpoint.js'
import { createEvidenceTool } from '../../src/tools/evidence.js'
import { createCheckpointTool } from '../../src/tools/checkpoint.js'
import {
  bindProofV2ToProjection, createProofManifestV2, proofCapabilityReport, requiredSubjectsOf,
  scopeCoverageDigest, sessionQueryV2, validateProofManifestV2,
  type ProofManifestV2, type ProofObligationV2,
} from '../../src/domain/proof.js'
import { evidenceAvailabilityReason } from '../../src/domain/diagnostics.js'
import { createProjection, type GuardProjection } from '../../src/domain/types.js'

/**
 * 0.6.0 C09/S09 production chain (F08).
 *
 * This suite exists because a proof rule that is only reachable from its own
 * module is not a supported capability. Every case below goes through the real
 * registration entry points: a real DSH `Session`, the real evidence producer,
 * the real derive replay and the real `context_guard_checkpoint` tool, whose
 * optional `proof` manifest is bound before any certificate is issued. The
 * round trip is then replayed from the durable log.
 */

function append(session: Session, type: string, data: unknown, options?: unknown): void {
  ;(session as unknown as { append(type: string, data: unknown, options?: unknown): void }).append(type, data, options)
}

function enable(session: Session): void {
  append(session, 'command/run', { commandId: `cmd-${session.seq}`, name: 'context-guard', args: 'on', source: { kind: 'user' } })
}

function user(session: Session, text: string): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

function call(session: Session, callId: string, name: string, args: Record<string, unknown>): void {
  append(session, 'tool/call', { turn: 1, step: session.seq, callId, name, arguments: JSON.stringify(args) })
}

function result(session: Session, callId: string, value: unknown, meta?: unknown): void {
  append(session, 'tool/result', {
    turn: 1, step: session.seq,
    message: createToolResultMessage({ callId: callId as never, content: [{ type: 'text', text: JSON.stringify(value) }], isError: false }),
    ...(meta ? { meta } : {}),
  }, { surfaceOp: 'append' })
}

function execution(session: Session, callId: string, name = 'context_guard_evidence') {
  return {
    callId, rootCallId: callId, name, arguments: {},
    agent: { session }, signal: new AbortController().signal,
    deferContext: () => {}, concludeTurn: () => {}, token: Symbol('test'),
  } as never
}

/** Produce one read fact through the real evidence producer and persist it. */
async function readFact(session: Session, callId: string, path: string): Promise<void> {
  call(session, callId, 'read_file', { file_path: path })
  append(session, 'tool/result', {
    turn: 1, step: session.seq,
    message: createToolResultMessage({ callId: callId as never, content: [{ type: 'text', text: 'file contents' }], isError: false }),
    meta: { path },
  }, { surfaceOp: 'append' })
}

function projectionOf(session: Session): GuardProjection {
  return deriveProjection(session.snapshotEvents() as never, { activation: 'opt-in' }, { cwd: process.cwd() }, true).projection
}

/** The projection once the guard has engaged for a real root instruction. */
async function sessionWithReadback(label: string) {
  const root = await mkdtemp(join(tmpdir(), `dsh-cg-proof-${label}-`))
  const artifact = join(root, 'report.md')
  const other = join(root, 'other.md')
  await writeFile(artifact, 'the report\n')
  await writeFile(other, 'something else\n')
  const session = Session.create(SessionId(`proof-${label}`), undefined, {
    version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId(`proof-${label}`), createdAt: 1, cwd: root,
  })
  enable(session)
  user(session, `验证 ${artifact} 的内容正确`)
  await readFact(session, `${label}-read`, artifact)
  return { root, artifact, other, session }
}

function obligationFor(projection: GuardProjection, kind: ProofObligationV2['kind'], subjects: string[], evidenceIds: string[]): ProofManifestV2 {
  const item = [...projection.items.values()].find((entry) => entry.status === 'pending')!
  // The source is declared from the fact that will discharge it: a v2
  // obligation must name the producer it requires.
  const sourceIds = evidenceIds
    .map((id) => projection.evidence.get(id)?.toolName)
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
  return createProofManifestV2([{
    obligationId: item.id, kind, surface: item.verification.surface ?? 'artifact',
    subjectIds: subjects, sourceIds: [...new Set(sourceIds)], operation: 'verify', evidenceIds,
  }])
}

describe('0.6.0 C09/S09: the proof entry is a production chain, not a rule library', () => {
  it('a real read fact binds an obligation over the item and survives a log replay', async () => {
    const f = await sessionWithReadback('bound')
    try {
      const projection = projectionOf(f.session)
      const item = [...projection.items.values()].find((entry) => entry.status === 'pending')
      expect(item, 'the root instruction produced a verifiable obligation').toBeDefined()
      expect(requiredSubjectsOf(item!)).toEqual([f.artifact])
      const fact = [...projection.evidence.values()].find((entry) => entry.toolName === 'read_file')
      expect(fact, 'the real producer persisted a read fact').toBeDefined()
      expect(evidenceAvailabilityReason(fact!)).toBeUndefined()

      const inMemory = deriveProjection(f.session.snapshotEvents() as never, { activation: 'opt-in' }, { cwd: process.cwd() }, true).projection
      const proof = obligationFor(inMemory, 'subject_readback', [f.artifact], [fact!.id])
      expect(validateProofManifestV2(proof)).toEqual([])
      expect(bindProofV2ToProjection(inMemory, proof)).toEqual([])
      expect(sessionQueryV2(inMemory, proof)).toMatchObject({ state: 'valid' })

      // The same proof through the real tool: bound before any certificate.
      const checkpoint = createCheckpointTool(() => inMemory, () => {})
      const page = await checkpoint.execute({ bindings: [], proof } as never, execution(f.session, 'cp', 'context_guard_checkpoint')) as {
        status: string; proof_state: { status: string; reason_codes: string[] }
      }
      expect(page.proof_state).toEqual({ status: 'bound', reason_codes: [] })

      // The obligation itself closes on the same real fact, and the resulting
      // certificate is persisted and replayed from the durable log.
      const binding = {
        itemId: item!.id, evidenceIds: [fact!.id], semanticAction: 'verify' as const,
        requestedTarget: item!.requestedTarget, resolvedTarget: fact!.resolvedTarget, observedState: {},
        effectEvidenceId: fact!.id,
        expectedTransition: {
          predicateId: 'pred.verify.outcome', version: 1, predParamsKind: 'inline' as const,
          parameters: { expected_outcome: { k: 'e' as const, v: 'success' }, min_matches: 1 },
        },
      }
      const certified = certifyCheckpoint(inMemory, [binding], 'C1', false)
      const certificate = certified.checkpoint
      expect(certificate, JSON.stringify(certified.rejectedBindings)).toBeDefined()
      if (!certificate) throw new Error('the real fact did not certify the obligation')
      // Persist exactly what the tool would: the same bindings and the
      // certificate they produced. A record whose bindings do not reproduce the
      // certificate replays as corrupt, which is why the wire shape matters.
      call(f.session, 'cp', 'context_guard_checkpoint', {
        bindings: [{
          item_id: binding.itemId, evidence_ids: binding.evidenceIds, semantic_action: binding.semanticAction,
          requested_target: binding.requestedTarget, resolved_target: binding.resolvedTarget,
          observed_state: binding.observedState, effect_evidence_id: binding.effectEvidenceId,
          expected_transition: {
            predicate_id: binding.expectedTransition.predicateId, version: binding.expectedTransition.version,
            pred_params_kind: binding.expectedTransition.predParamsKind, parameters: binding.expectedTransition.parameters,
          },
        }],
      })
      result(f.session, 'cp', {
        status: 'certified',
        proof_state: { status: 'bound', reason_codes: [] },
        certificate: {
          stop_protocol_version: certificate.stopProtocolVersion, certificate_version: certificate.certificateVersion,
          epoch: certificate.epoch, session_ref_digest: certificate.sessionRefDigest, host_lock_digest: certificate.hostLockDigest,
          contract_revision: certificate.contractRevision, contract_sha256: certificate.contractSha256,
          open_digest: certificate.openDigest, evidence_sha256: certificate.evidenceSha256,
          binding_digest: certificate.bindingDigest, certification_digest: certificate.certificationDigest,
          goal_ref: certificate.goalRef ?? null,
        },
      })
      const replayed = projectionOf(f.session)
      expect(replayed.integrity).toBe('valid')
      expect(replayed.checkpoints).toHaveLength(1)
      expect(replayed.checkpoints[0]).toMatchObject({ result: 'certified' })
      // The obligation is closed in the replay, so the proof no longer applies
      // to it: a proof binds OPEN work and says so instead of silently passing.
      expect(replayed.items.get(item!.id)?.status).toBe('passed')
      expect(bindProofV2ToProjection(replayed, proof)).toEqual(['proof_obligation_not_pending'])
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  it('a manifest and a fact about another file cannot discharge the obligation', async () => {
    const f = await sessionWithReadback('foreign')
    try {
      const projection = projectionOf(f.session)
      const fact = [...projection.evidence.values()].find((entry) => entry.toolName === 'read_file')!
      const foreign = obligationFor(projection, 'subject_readback', [f.other], [fact!.id])
      expect(bindProofV2ToProjection(projection, foreign)).toContain('proof_subject_unbound')
      const checkpoint = createCheckpointTool(() => projection, () => {})
      const page = await checkpoint.execute({ bindings: [], proof: foreign } as never, execution(f.session, 'cp2', 'context_guard_checkpoint')) as {
        status: string; proof_state: { status: string; reason_codes: string[] }
      }
      expect(page.status).toBe('incomplete')
      expect(page.proof_state.status).toBe('rejected')
      expect(page.proof_state.reason_codes).toContain('proof_subject_unbound')
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  it('a partly covered or wrongly typed obligation is refused, not approximated', async () => {
    const f = await sessionWithReadback('partial')
    try {
      const projection = projectionOf(f.session)
      const fact = [...projection.evidence.values()].find((entry) => entry.toolName === 'read_file')!
      // An execution fact requires the declared operation, which this read did
      // not perform.
      const executionFact = obligationFor(projection, 'execution_fact', [f.artifact], [fact!.id])
      executionFact.obligations[0]!.operation = 'run'
      expect(bindProofV2ToProjection(projection, executionFact)).toContain('proof_operation_unbound')
      // A visual readback has no producer in this cohort, so it is refused
      // rather than credited to a successful tool call.
      const visual = obligationFor(projection, 'output_visual_readback', [f.artifact], [fact!.id])
      visual.obligations[0]!.surface = 'visual'
      expect(bindProofV2ToProjection(projection, visual)).toContain('proof_producer_capability_unavailable')
      // A scope obligation needs a fact that actually covered the scope: a
      // single read is not a scope run, so it is refused on the operation.
      const scope = obligationFor(projection, 'scope_coverage', [f.artifact], [fact!.id])
      expect(bindProofV2ToProjection(projection, scope)).toContain('proof_operation_unbound')
      // A self-declared coverage digest is bound to the REAL set, not to the
      // manifest's other self-reported value; the rule-level case lives in
      // tests/domain/v060-proof-v2.test.ts.
      expect(requiredSubjectsOf([...projection.items.values()].find((entry) => entry.status === 'pending')!)).toEqual([f.artifact])
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  it('a tampered manifest never reaches the certificate', async () => {
    const f = await sessionWithReadback('tampered')
    try {
      const projection = projectionOf(f.session)
      const fact = [...projection.evidence.values()].find((entry) => entry.toolName === 'read_file')!
      const proof = obligationFor(projection, 'subject_readback', [f.artifact], [fact!.id])
      const tampered = { ...proof, proofSha256: '0'.repeat(64) } as ProofManifestV2
      const checkpoint = createCheckpointTool(() => projection, () => {})
      const page = await checkpoint.execute({ bindings: [], proof: tampered } as never, execution(f.session, 'cp3', 'context_guard_checkpoint')) as {
        status: string; proof_state: { status: string; reason_codes: string[] }
      }
      expect(page.status).toBe('incomplete')
      expect(page.proof_state.status).toBe('invalid')
      expect(page.proof_state.reason_codes).toContain('proof_digest_mismatch')
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  it('the capability matrix states honestly which producers this cohort has', async () => {
    const f = await sessionWithReadback('capability')
    try {
      const facts = [...projectionOf(f.session).evidence.values()]
      // Produced by a real reader in this cohort.
      expect(proofCapabilityReport('subject_readback', facts)).toEqual({ status: 'supported' })
      expect(proofCapabilityReport('input_asset_check', facts.map((fact) => ({ ...fact, evidenceRole: 'resolution' as const })))).toEqual({ status: 'supported' })
      // NOT produced by any audited adapter: the honest answer is unavailable.
      expect(proofCapabilityReport('output_visual_readback', facts)).toEqual({ status: 'unavailable', reasonCode: 'proof_producer_capability_unavailable' })
      expect(proofCapabilityReport('external_fact', facts)).toEqual({ status: 'unavailable', reasonCode: 'proof_producer_capability_unavailable' })
      // The audit basis: no fact in the cohort carries the visual capability.
      expect(facts.some((fact) => fact.capabilities.includes('visual-readback'))).toBe(false)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  it('the runtime never synthesizes a required subject out of thin air', () => {
    const empty = createProjection()
    empty.items.set('R001', {
      id: 'R001', revision: 1, kind: 'requirement', sourceMessageId: 'm1', normalizedText: 'x', textSha256: 'a'.repeat(64),
      status: 'pending', verification: { enforced: true }, taskKind: 'action',
    } as never)
    expect(requiredSubjectsOf(empty.items.get('R001')!)).toEqual([])
  })
})
