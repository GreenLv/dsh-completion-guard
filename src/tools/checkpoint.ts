import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { certifyCheckpoint } from '../domain/checkpoint.js'
import type { EvidenceBinding, GuardProjection } from '../domain/types.js'

export interface CheckpointArgs {
  bindings: Array<{ item_id: string; evidence_ids: string[] }>
}

export function createCheckpointTool(
  getProjection: () => GuardProjection | undefined,
  onRejected: () => void,
): ToolDefinition {
  return defineTool({
    name: 'context_guard_checkpoint',
    description: 'Request a completion certificate from existing durable evidence.',
    parameters: {
      bindings: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            item_id: { type: 'string', required: true },
            evidence_ids: { type: 'array', required: true, items: { type: 'string' } },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['certified', 'incomplete', 'unknown'] },
          contract_revision: { type: 'integer' },
          open_items: { type: 'array', items: { type: 'string' } },
          available_evidence: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                tool: { type: 'string' },
                subjects: { type: 'array', items: { type: 'string' } },
                surfaces: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          rejected_bindings: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                item_id: { type: 'string' },
                reason: { type: 'string' },
                hint: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: CheckpointArgs): Promise<{
      status: 'certified' | 'incomplete' | 'unknown'
      contract_revision: number
      open_items: string[]
      available_evidence: Array<{ id: string; tool: string; subjects: string[]; surfaces: string[] }>
      rejected_bindings: Array<{ item_id: string; reason: string; hint?: string }>
    }> {
      const projection = getProjection()
      if (!projection) {
        return { status: 'unknown', contract_revision: 0, open_items: [], available_evidence: [], rejected_bindings: [] }
      }
      const bindings: EvidenceBinding[] = args.bindings.map((binding) => ({
        itemId: binding.item_id,
        evidenceIds: binding.evidence_ids,
      }))
      const result = certifyCheckpoint(projection, bindings, `C${projection.checkpoints.length + 1}`)
      if (!result.checkpoint) onRejected()
      const available_evidence = [...projection.evidence.values()]
        .filter((evidence) => evidence.epoch === projection.epoch && evidence.outcome === 'success')
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((evidence) => ({
          id: evidence.id,
          tool: evidence.toolName,
          subjects: evidence.subjects,
          surfaces: evidence.surfaces,
        }))
      return {
        status: result.status,
        contract_revision: result.contractRevision,
        open_items: result.openItems,
        available_evidence,
        rejected_bindings: result.rejectedBindings.map((binding) => ({
          item_id: binding.itemId,
          reason: binding.reason,
          ...(binding.hint !== undefined ? { hint: binding.hint } : {}),
        })),
      }
    },
  })
}
