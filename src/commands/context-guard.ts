import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { deriveItemDiagnosis } from '../domain/diagnostics.js'
import { migrationReport } from '../domain/migration.js'
import { normalizeReleaseContract, releaseCoverage, RELEASE_OPERATION_SURFACES, RELEASE_OPERATIONS } from '../domain/release.js'
import type { GuardProjection } from '../domain/types.js'

function pendingCount(projection: GuardProjection): number {
  return [...projection.items.values()].filter((item) => item.status === 'pending').length
}

/**
 * The release surface. Adoption is deliberately NOT performed here: the
 * derivation adopts a contract only from the durable root `command/run` for
 * `/context-guard release adopt <json>`, so the command handler's job is to
 * report the resulting state (and to explain what is not protectable), never
 * to grant authority itself.
 */
function releaseResponse(projection: GuardProjection, rawInput: string): { kind: 'success' | 'error'; text: string } {
  const rest = rawInput.trim().slice('release'.length).trim()
  const [verb] = rest.split(/\s+/, 1)
  if (verb === 'adopt') {
    // Adoption AUTHORITY comes only from the durable root `command/run` that
    // the derivation reads; this handler validates the same payload and reports
    // exactly what was adopted, so the visible result can never disagree with
    // the permission state that will actually apply.
    const payload = rest.slice('adopt'.length).trim()
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      return { kind: 'error', text: 'Context Guard release adopt: the contract must be one JSON object.' }
    }
    const normalized = normalizeReleaseContract(parsed, { seq: -1, digest: '' })
    if (!normalized.contract) {
      return { kind: 'error', text: `Context Guard release adopt rejected: ${normalized.errors.join(', ')}` }
    }
    const contract = normalized.contract
    const adopted = projection.releaseContracts.some((entry) => entry.contractId === contract.contractId)
      ? projection.releaseContracts.find((entry) => entry.contractId === contract.contractId)!
      : contract
    return { kind: 'success', text: JSON.stringify({
      status: 'adopted',
      contract_id: adopted.contractId,
      candidate: adopted.candidate,
      operations: releaseCoverage(adopted),
      readiness_refs: adopted.readinessRefs,
      closure_cert_ref: adopted.closureCertRef ?? null,
      expires_at_epoch_ms: adopted.expiresAtEpochMs ?? null,
      note: 'The contract becomes authoritative from the durable root command that carried it. It grants no authority in this process.',
    }) }
  }
  if (verb === 'revoke') {
    const contractId = rest.slice('revoke'.length).trim()
    if (!contractId) return { kind: 'error', text: 'Usage: /context-guard release revoke <contract_id>' }
    const contract = projection.releaseContracts.find((entry) => entry.contractId === contractId)
    if (!contract) return { kind: 'error', text: `Context Guard release revoke: unknown contract ${contractId}` }
    return { kind: 'success', text: JSON.stringify({
      status: contract.revokedAtSeq === undefined ? 'revoking' : 'revoked',
      contract_id: contractId,
      revoked_at_seq: contract.revokedAtSeq ?? null,
      in_flight: projection.releaseReservations
        .filter((reservation) => reservation.contractId === contractId
          && !projection.releaseSettlements.some((settlement) => settlement.callId === reservation.callId
            && (settlement.outcome === 'settled' || settlement.outcome === 'not_effected')))
        .map(({ operation, callId }) => ({ operation, call_id: callId })),
      note: 'Revocation is recorded durably and keeps the audit trail. It denies the next effect; an operation already in flight still needs its trusted readback to be reconciled.',
    }) }
  }
  if (verb !== '' && verb !== 'status') {
    return {
      kind: 'error',
      text: 'Usage: /context-guard release status | release adopt <json contract> | release revoke <contract_id>. '
        + 'Adoption and revocation are recorded from this command itself; they never grant authority in-process.',
    }
  }
  const contracts = projection.releaseContracts.map((contract) => ({
    contract_id: contract.contractId,
    adopted_at_seq: contract.adoptedBy.seq,
    revoked_at_seq: contract.revokedAtSeq ?? null,
    candidate: contract.candidate,
    readiness_refs: contract.readinessRefs,
    closure_cert_ref: contract.closureCertRef ?? null,
    operations: releaseCoverage(contract),
    expires_at_epoch_ms: contract.expiresAtEpochMs ?? null,
    consumed_operations: projection.releaseSettlements
      .filter((settlement) => settlement.contractId === contract.contractId && settlement.outcome === 'settled')
      .map((settlement) => settlement.operation),
    in_flight: projection.releaseReservations
      .filter((reservation) => reservation.contractId === contract.contractId
        && !projection.releaseSettlements.some((settlement) => settlement.callId === reservation.callId
          && (settlement.outcome === 'settled' || settlement.outcome === 'not_effected')))
      .map(({ operation, callId, startedAtSeq }) => ({ operation, call_id: callId, started_at_seq: startedAtSeq })),
    settlements: projection.releaseSettlements
      .filter((settlement) => settlement.contractId === contract.contractId)
      .map(({ operation, callId, outcome, readback, settledAtSeq }) => ({ operation, call_id: callId, outcome, readback, settled_at_seq: settledAtSeq })),
  }))
  return {
    kind: 'success',
    text: JSON.stringify({
      profile_applicable: projection.policy === 'release' || contracts.length > 0,
      policy: projection.policy,
      state_damaged: projection.releaseStateDamaged,
      adopted_contracts: contracts,
      // The coverage table is machine-readable: an operation with no
      // Guard-owned execution surface is refused before any effect, and the
      // operator is never told to fall back to a plain shell command.
      coverage_surface: RELEASE_OPERATIONS.map((operation) => ({ operation, ...RELEASE_OPERATION_SURFACES[operation] })),
      diagnostics: projection.releaseDiagnostics,
      note: 'A release is never implicit: only an explicit root adoption creates a contract, and only operations with a Guard execution surface can be protected.',
    }),
  }
}

export function createContextGuardCommand(
  projectionFor: (agent: Agent) => GuardProjection,
  setEnabled: (agent: Agent, enabled: boolean) => void,
  clearContract: (agent: Agent) => void,
  lifecycleFor?: (agent: Agent) => 'armed' | 'active' | 'disabled',
): CommandDefinition {
  return {
    name: 'context-guard',
    description: 'Enable, disable, clear, inspect, diagnose, or manage the explicit release contract for this session.',
    recordInput: true,
    input: { hint: 'on|off|clear|status|diagnose|migration|release status|release adopt <json>|release revoke <id>' },
    handler: ({ agent, rawInput }) => {
      const projection = projectionFor(agent)
      const [subcommand] = rawInput.trim().split(/\s+/, 1)
      const resolved = subcommand || 'status'
      if (resolved === 'on') {
        setEnabled(agent, true)
        return { kind: 'success', text: 'Context Guard enabled.' }
      }
      if (resolved === 'off') {
        setEnabled(agent, false)
        return { kind: 'success', text: 'Context Guard disabled; history retained.' }
      }
      if (resolved === 'clear') {
        const before = pendingCount(projection)
        // The logged `command/run clear` drives the actual supersession during
        // re-derivation; this only re-syncs the projection from the log.
        clearContract(agent)
        const after = pendingCount(projectionFor(agent))
        const cleared = before - after
        return {
          kind: 'success',
          text: `Context Guard contract cleared: ${cleared} requirement/acceptance item(s) superseded; ${after} pending remain (prohibitions retained).`,
        }
      }
      if (resolved === 'release') return releaseResponse(projection, rawInput)
      if (resolved === 'migration') return { kind: 'success', text: JSON.stringify(migrationReport(projection)) }
      if (resolved !== 'status' && resolved !== 'diagnose') {
        return { kind: 'error', text: 'Usage: /context-guard on|off|clear|status|diagnose|migration|release status|release adopt <json>|release revoke <id>' }
      }
      const passed = [...projection.items.values()].filter((item) => item.status === 'passed').length
      // Three-way diagnosis statistics: certified, repairable-missing-evidence,
      // and not-certifiable-by-current-adapters. Historical uncertified items
      // stay visible; the guard never shrinks the certification scope.
      let certifiable_missing_evidence = 0
      let unsupported = 0
      const reason_classes: Record<string, number> = {}
      for (const item of projection.items.values()) {
        if (item.status !== 'pending') continue
        const diagnosis = deriveItemDiagnosis(projection, item)
        reason_classes[diagnosis.reason_class] = (reason_classes[diagnosis.reason_class] ?? 0) + 1
        if (diagnosis.repairability === 'agent_repairable') certifiable_missing_evidence += 1
        else if (diagnosis.certification === 'unsupported') unsupported += 1
      }
      const migration = migrationReport(projection)
      const response = {
        enabled: projection.enabled,
        // Startup lifecycle: armed = waiting for the first real root input;
        // never a certification fact.
        lifecycle: lifecycleFor?.(agent) ?? (projection.enabled ? 'active' : 'disabled'),
        policy: projection.policy,
        epoch: projection.epoch,
        contract_revision: projection.contractRevision,
        pending: pendingCount(projection),
        passed,
        diagnosis: { certified: passed, certifiable_missing_evidence, unsupported, reason_classes },
        evidence: projection.evidence.size,
        integrity: projection.integrity,
        last_source_seq: projection.lastObservedSourceSeq,
        migration: {
          rule_mode: migration.ruleMode,
          certificate_version: migration.certificateVersion,
          unit_closure: migration.unitClosure,
          legacy_open_items: migration.legacyItemIds.length,
        },
        release: {
          policy: projection.policy,
          state_damaged: projection.releaseStateDamaged,
          adopted_contracts: projection.releaseContracts.length,
          in_flight: projection.releaseReservations.filter((reservation) => !projection.releaseSettlements.some((settlement) => settlement.callId === reservation.callId && settlement.outcome === 'settled')).length,
          applicable: projection.policy === 'release' || projection.releaseContracts.length > 0,
        },
      }
      return { kind: 'success', text: JSON.stringify(response) }
    },
  }
}
