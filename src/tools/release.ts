import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { GuardProjection } from '../domain/types.js'
import {
  contractById, inFlightReservation, readbackSettlesContract, reservationFor, releaseCoverage,
  RELEASE_OPERATION_SURFACES, type ReleaseOperation, type ReleaseSettlement,
} from '../domain/release.js'
import { registryIntegrity, type EvidenceToolRoots } from './evidence.js'

/**
 * The release recovery entry (0.6.0 C10/F05).
 *
 * A release attempt whose effect could not be established stays `in flight` and
 * is never re-sent. Until this tool existed the state machine could accept a
 * reconciliation record but no production caller could produce one, so an
 * operation whose effect was unknown stayed locked forever — including after a
 * restart and including after its contract was revoked.
 *
 * `reconcile` reads the external identity through the SAME audited registry
 * adapter the publish path uses, never through a caller-supplied value, and
 * settles the reservation only when the readback names the bytes the contract
 * (or the reservation) froze. It never re-publishes anything: the whole point of
 * the in-flight lock is that a resend is the dangerous action.
 */

export interface ReleaseToolOptions extends EvidenceToolRoots {
  getProjection: () => GuardProjection | undefined
  /** Persist one settlement through the runtime's durable record channel. */
  persistSettlement: (request: {
    agent: { session: unknown }
    contractId: string
    operation: ReleaseOperation
    callId: string
    readback: ReleaseSettlement['readback']
    outcome: ReleaseSettlement['outcome']
  }) => Promise<boolean>
}

export const RELEASE_TOOL = 'context_guard_release'

export function createReleaseTool(options: ReleaseToolOptions): ToolDefinition {
  return defineTool({
    name: RELEASE_TOOL,
    description: 'Read the explicit release state, or reconcile a release attempt whose effect was unknown by reading back the external identity. This tool never re-sends a release.',
    parameters: {
      operation: { type: 'string', required: true, enum: ['status', 'reconcile'] },
      contract_id: { type: 'string' },
      // The RESOLUTION call the attempt was reserved under: the action tool
      // receives it as `resolution_call_id`, and it is the reservation's key.
      // Required only for `reconcile`; a status query is read-only.
      resolution_call_id: { type: 'string' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(rawArgs, exec) {
      const args = rawArgs as { operation?: string; contract_id?: string; resolution_call_id?: string }
      const projection = options.getProjection()
      if (!projection) return { status: 'unknown', reason_code: 'guard_unavailable' } as unknown as Record<string, JsonValue>

      if (args.operation === 'status') {
        return {
          status: 'available',
          policy: projection.policy,
          state_damaged: projection.releaseStateDamaged,
          coverage_surface: (Object.keys(RELEASE_OPERATION_SURFACES) as ReleaseOperation[])
            .map((operation) => ({ operation, ...RELEASE_OPERATION_SURFACES[operation] })),
          contracts: projection.releaseContracts.map((contract) => ({
            contract_id: contract.contractId,
            revoked_at_seq: contract.revokedAtSeq ?? null,
            adopted_at_revision: contract.adoptedAtRevision,
            operations: releaseCoverage(contract),
            candidate: contract.candidate,
          })),
          reservations: projection.releaseReservations.map(({ contractId, operation, callId, startedAtSeq, ledgerPosition, observedArtifactSri }) => ({
            contract_id: contractId, operation, resolution_call_id: callId,
            ...(ledgerPosition === undefined ? { started_at_seq: startedAtSeq }
              : { record_position: { channel: 'private_ledger', position: ledgerPosition } }),
            observed_artifact_sri: observedArtifactSri ?? null,
            in_flight: inFlightReservation(projection, contractId, operation)?.callId === callId,
          })),
          settlements: projection.releaseSettlements.map(({ contractId, operation, callId, outcome, readback, settledAtSeq, ledgerPosition }) => ({
            contract_id: contractId, operation, resolution_call_id: callId, outcome, readback,
            ...(ledgerPosition === undefined ? { settled_at_seq: settledAtSeq }
              : { record_position: { channel: 'private_ledger', position: ledgerPosition } }),
          })),
          diagnostics: projection.releaseDiagnostics,
        } as unknown as Record<string, JsonValue>
      }

      if (args.operation !== 'reconcile') return { status: 'rejected', reason_code: 'release_subcommand_unknown' } as unknown as Record<string, JsonValue>
      const contractId = args.contract_id ?? ''
      const callId = args.resolution_call_id ?? ''
      const contract = contractById(projection, contractId)
      if (!contract) return { status: 'rejected', reason_code: 'release_contract_unknown' } as unknown as Record<string, JsonValue>
      const reservation = reservationFor(projection, contractId, callId)
      if (!reservation) return { status: 'rejected', reason_code: 'release_reservation_unknown' } as unknown as Record<string, JsonValue>
      // A revoked-but-in-flight operation is exactly the recovery case: the
      // revocation withdrew future authority, not the duty to reconcile.
      const operation = reservation.operation
      const settled = projection.releaseSettlements.find((entry) => (
        entry.contractId === contractId && entry.operation === operation && entry.callId === callId
        && (entry.outcome === 'settled' || entry.outcome === 'not_effected')))
      if (settled) {
        return { status: 'already_resolved', outcome: settled.outcome, reason_code: 'release_already_resolved' } as unknown as Record<string, JsonValue>
      }

      const registry = contract.candidate.registry
      const packageId = contract.candidate.packageId
      const version = contract.candidate.version
      if (!registry || !packageId || !version) {
        return { status: 'unavailable', reason_code: 'release_readback_identity_incomplete' } as unknown as Record<string, JsonValue>
      }
      const identity = await registryIntegrity(registry, packageId, version, options, exec.signal)
      if (!identity) {
        // No trusted producer answered. The attempt stays locked: an absent
        // readback is not evidence that nothing was published.
        return { status: 'unavailable', reason_code: 'release_readback_unavailable' } as unknown as Record<string, JsonValue>
      }
      const readback = { kind: 'npm_integrity' as const, identity }
      const verdict = readbackSettlesContract(contract, readback, reservation.observedArtifactSri)
      const outcome: ReleaseSettlement['outcome'] = verdict === 'settled' ? 'settled' : 'unknown'
      const persisted = await options.persistSettlement({ agent: exec.agent as { session: unknown }, contractId, operation, callId, readback, outcome })
      if (!persisted) return { status: 'unknown', reason_code: 'release_settlement_not_durable' } as unknown as Record<string, JsonValue>
      return {
        status: verdict === 'settled' ? 'settled' : verdict === 'mismatch' ? 'mismatch' : 'unconfirmed',
        outcome,
        readback,
        reason_code: verdict === 'settled' ? 'release_reconciled'
          : verdict === 'mismatch' ? 'release_readback_identity_mismatch' : 'release_readback_identity_unavailable',
        note: 'Reconciliation never re-sends the release operation.',
      } as unknown as Record<string, JsonValue>
    },
  })
}
