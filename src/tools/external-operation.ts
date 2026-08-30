import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'

export interface ExternalOperationSnapshot {
  id: string
  status: 'running' | 'pending' | 'completed' | 'failed' | 'unknown'
  adapterId: string
}

export type ExternalOperationReader = (jobId: string, agent: unknown) => ExternalOperationSnapshot | undefined

export interface ExternalOperationCapability {
  status: 'supported' | 'unsupported' | 'unavailable'
  digest: string
}

export type ExternalOperationCapabilityReader = () => ExternalOperationCapability

export function createExternalOperationTool(
  read: ExternalOperationReader,
  capability: ExternalOperationCapabilityReader,
): ToolDefinition {
  return defineTool({
    name: 'context_guard_external_operation',
    description: 'Read a live background operation from the pinned jobs capability and mint a bounded external-wait qualification. Text output never controls status.',
    parameters: { operation_id: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        status: { type: 'string', required: true, enum: ['running', 'pending', 'completed', 'failed', 'unknown'] },
        operation_id: { type: 'string', required: true },
        reason_code: { type: 'string', required: true },
        adapter_id: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => {
        const meta: JsonValue = { contextGuardExternalOperation: {
          id: value.operation_id, status: value.status, adapterId: value.adapter_id,
        } }
        return meta
      },
    },
    execute(args, exec) {
      const hostCapability = capability()
      if (hostCapability.status !== 'supported') {
        return Promise.resolve({
          status: 'unknown' as const,
          operation_id: args.operation_id,
          reason_code: 'host_jobs_capability_unavailable',
          adapter_id: 'dsh.jobs.v1',
        })
      }
      const snapshot = read(args.operation_id, exec.agent)
      return Promise.resolve(snapshot ? {
        status: snapshot.status, operation_id: snapshot.id, reason_code: 'external_operation_readback', adapter_id: snapshot.adapterId,
      } : {
        status: 'unknown' as const, operation_id: args.operation_id, reason_code: 'external_operation_unavailable', adapter_id: 'dsh.jobs.v1',
      })
    },
  })
}
