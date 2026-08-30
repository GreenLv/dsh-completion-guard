import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { availableBoundaryQualifications, qualifyBoundary } from '../domain/boundary.js'
import type { BoundaryDisposition, BoundaryQualificationKind, GuardProjection } from '../domain/types.js'

export interface BoundaryArgs {
  disposition: BoundaryDisposition
  qualification_kind: BoundaryQualificationKind
  qualification_ids: string[]
  note?: string
}

export function createBoundaryTool(
  getProjection: () => GuardProjection | undefined,
  prepare: () => Promise<boolean>,
  onRejected: () => void,
): ToolDefinition {
  return defineTool({
    name: 'context_guard_boundary',
    description: 'Persist a qualified user_wait, external_wait, or deferred boundary. Free-form notes never qualify a boundary.',
    parameters: {
      disposition: { type: 'string', required: true, enum: ['user_wait', 'external_wait', 'deferred'] },
      qualification_kind: { type: 'string', required: true, enum: ['user_decision_item', 'root_explicit_wait', 'external_operation_pending', 'root_explicit_defer'] },
      qualification_ids: { type: 'array', required: true, items: { type: 'string' } },
      note: { type: 'string' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['accepted', 'rejected', 'unknown'] },
          reason_code: { type: 'string' },
          available_qualifications: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
            id: { type: 'string' }, kind: { type: 'string' }, disposition: { type: 'string' }, source: { type: 'string' }, status: { type: 'string' },
          } } },
          boundary: {
            type: 'object', additionalProperties: false,
            properties: {
              id: { type: 'string' }, disposition: { type: 'string' }, qualification_kind: { type: 'string' },
              qualification_ids: { type: 'array', items: { type: 'string' } }, epoch: { type: 'integer' },
              contract_revision: { type: 'integer' }, contract_sha256: { type: 'string' }, candidate_sha256: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: BoundaryArgs) {
      const durable = await prepare()
      const projection = getProjection()
      if (!durable || !projection) {
        onRejected()
        return { status: 'unknown' as const, reason_code: 'boundary_persistence_unknown', available_qualifications: [], boundary: undefined }
      }
      const candidate = qualifyBoundary(projection, {
        disposition: args.disposition,
        qualificationKind: args.qualification_kind,
        qualificationIds: args.qualification_ids,
      })
      if (candidate.persistedResult !== 'accepted') onRejected()
      return {
        status: candidate.persistedResult,
        reason_code: candidate.reasonCode,
        available_qualifications: availableBoundaryQualifications(projection).map((row) => ({
          id: row.id, kind: row.kind, disposition: row.disposition, source: row.source, status: row.status,
        })),
        boundary: {
          id: candidate.id, disposition: candidate.disposition, qualification_kind: candidate.qualificationKind,
          qualification_ids: candidate.qualificationIds, epoch: candidate.epoch,
          contract_revision: candidate.contractRevision, contract_sha256: candidate.contractSha256,
          candidate_sha256: candidate.candidateSha256,
        },
      }
    },
  })
}
