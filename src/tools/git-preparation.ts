import type { StatefulAction } from '../domain/protocol-manifest.js'

/** Input recipes are guidance only; live resolution remains authoritative. */
export function gitPreparation(action: StatefulAction): {
  selector_fields: string[]
  command_manifest_fields: string[]
  planned_tools: string[]
  planned_argument_fields: string[]
  steps: string[]
} | undefined {
  if (!['commit', 'push', 'fetch', 'pull'].includes(action)) return undefined
  return {
    selector_fields: action === 'commit' ? ['repository', 'branch'] : ['repository', 'remote', 'refspec'],
    command_manifest_fields: ['planned_tool', 'planned_arguments'],
    planned_tools: ['bash', 'pwsh'],
    planned_argument_fields: ['command', 'workdir'],
    steps: [
      'Before execution: context_guard_evidence with evidence_role=resolution, selector and command_manifest. Keep the successful tool call ID and target_digest.',
      'Execute once with context_guard_action, semantic_action, resolution_call_id, target_digest, contract_item_id and contract_item_revision.',
      'Collect effect and state separately with context_guard_evidence, using the same resolution_call_id and the successful action call ID as effect_call_id.',
      'Checkpoint the matching resolution/effect/state evidence IDs. Call IDs identify tool events; evidence IDs identify checkpoint facts.',
      'If the action already ran without resolution, report the historical evidence gap and read back state. Do not repeat a mutation to create missing prestate evidence.',
    ],
  }
}
