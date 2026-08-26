import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GuardProjection } from '../domain/types.js'

export function createContextGuardCommand(
  projectionFor: (agent: Agent) => GuardProjection,
  setEnabled: (agent: Agent, enabled: boolean) => void,
): CommandDefinition {
  return {
    name: 'context-guard',
    description: 'Enable, disable, inspect, or diagnose Context Guard for this session.',
    recordInput: true,
    input: { hint: 'on|off|status|diagnose' },
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
      if (resolved !== 'status' && resolved !== 'diagnose') {
        return { kind: 'error', text: 'Usage: /context-guard on|off|status|diagnose' }
      }
      const pending = [...projection.items.values()].filter((item) => item.status === 'pending').length
      const passed = [...projection.items.values()].filter((item) => item.status === 'passed').length
      const response = {
        enabled: projection.enabled,
        epoch: projection.epoch,
        contract_revision: projection.contractRevision,
        pending,
        passed,
        evidence: projection.evidence.size,
        integrity: projection.integrity,
        last_source_seq: projection.lastObservedSourceSeq,
      }
      return { kind: 'success', text: JSON.stringify(response) }
    },
  }
}
