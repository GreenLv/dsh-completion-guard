import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { GuardProjection } from '../domain/types.js'
import { rebindResponse, type RebindArgs } from '../domain/rebind.js'

export function createRebindTool(getProjection: () => GuardProjection | undefined, prepare: () => Promise<boolean>): ToolDefinition {
  return defineTool({
    name: 'context_guard_rebind',
    description: 'Propose an exact source-clause partition, query, or withdraw it. Only a durable root-user confirmation can replace the contract; no execution authority is added.',
    parameters: {
      operation: { type: 'string', required: true, enum: ['propose', 'query', 'withdraw'] },
      item_id: { type: 'string' }, proposal_id: { type: 'string' },
      clauses: { type: 'array', items: { type: 'string' } },
      clarification_item_ids: { type: 'array', items: { type: 'string' } },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(rawArgs) {
      if (!await prepare()) return { status: 'unknown', reason_code: 'persistence_unavailable' }
      const p = getProjection()
      return p ? rebindResponse(p, rawArgs as unknown as RebindArgs) as Record<string, JsonValue> : { status: 'unknown', reason_code: 'guard_unavailable' }
    },
  })
}
