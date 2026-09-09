import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { deriveItemDiagnosis } from '../domain/diagnostics.js'
import type { GuardProjection } from '../domain/types.js'

function pendingCount(projection: GuardProjection): number {
  return [...projection.items.values()].filter((item) => item.status === 'pending').length
}

export function createContextGuardCommand(
  projectionFor: (agent: Agent) => GuardProjection,
  setEnabled: (agent: Agent, enabled: boolean) => void,
  clearContract: (agent: Agent) => void,
  lifecycleFor?: (agent: Agent) => 'armed' | 'active' | 'disabled',
): CommandDefinition {
  return {
    name: 'context-guard',
    description: 'Enable, disable, clear, inspect, or diagnose Context Guard for this session.',
    recordInput: true,
    input: { hint: 'on|off|clear|status|diagnose' },
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
      if (resolved !== 'status' && resolved !== 'diagnose') {
        return { kind: 'error', text: 'Usage: /context-guard on|off|clear|status|diagnose' }
      }
      const passed = [...projection.items.values()].filter((item) => item.status === 'passed').length
      // Three-way diagnosis statistics: certified, repairable-missing-evidence,
      // and not-certifiable-by-current-adapters. Historical uncertified items
      // stay visible; the guard never shrinks the certification scope.
      let certifiable_missing_evidence = 0
      let unsupported = 0
      for (const item of projection.items.values()) {
        if (item.status !== 'pending') continue
        const diagnosis = deriveItemDiagnosis(projection, item)
        if (diagnosis.repairability === 'agent_repairable') certifiable_missing_evidence += 1
        else if (diagnosis.certification === 'unsupported') unsupported += 1
      }
      const response = {
        enabled: projection.enabled,
        // Startup lifecycle: armed = waiting for the first real root input;
        // never a certification fact.
        lifecycle: lifecycleFor?.(agent) ?? (projection.enabled ? 'active' : 'disabled'),
        epoch: projection.epoch,
        contract_revision: projection.contractRevision,
        pending: pendingCount(projection),
        passed,
        diagnosis: { certified: passed, certifiable_missing_evidence, unsupported },
        evidence: projection.evidence.size,
        integrity: projection.integrity,
        last_source_seq: projection.lastObservedSourceSeq,
      }
      return { kind: 'success', text: JSON.stringify(response) }
    },
  }
}
