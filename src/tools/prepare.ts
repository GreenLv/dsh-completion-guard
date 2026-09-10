import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { GuardProjection } from '../domain/types.js'
import { deriveItemDiagnosis, evidenceAvailabilityReason, relevantEvidence } from '../domain/diagnostics.js'
import { ACTION_MANIFEST, type StatefulAction } from '../domain/protocol-manifest.js'

export interface PrepareToolOptions {
  getProjection: () => GuardProjection | undefined
  /** Action-scoped host capability decision from the runtime lock. */
  hostCapability?: (action: StatefulAction) => { status: 'supported' | 'unsupported' | 'unavailable'; reasonCode?: string }
  /** Canonical command template for one stateful action, from the manifest. */
  commandTemplate?: (action: StatefulAction) => Record<string, unknown> | undefined
}

interface PrepareArgs {
  item_id?: string
  item_revision?: number
  semantic_action?: string
  requested_target?: Record<string, unknown>
  planned_operation?: string
}

/**
 * Thin READ-ONLY preparation surface (v0.5): before any stateful action it
 * reports the supported command shape, the required resolution/effect/state
 * evidence order, existing reusable references, and the exact missing fields.
 * It never executes, installs, commits, pushes, restarts, or probes authority
 * through side effects, and it never upgrades a default into user authority.
 */
export function createPrepareTool(options: PrepareToolOptions): ToolDefinition {
  return defineTool({
    name: 'context_guard_prepare',
    description: 'Read-only pre-action preparation: report the supported command shape, required resolution/effect/state evidence order, existing references, and exact missing target fields for one contract item. Performs no action and grants no authority.',
    parameters: {
      item_id: { type: 'string', required: true },
      item_revision: { type: 'number' },
      semantic_action: { type: 'string' },
      requested_target: { type: 'object', additionalProperties: true },
      planned_operation: { type: 'string' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(rawArgs) {
      const args = rawArgs as unknown as PrepareArgs
      const p = options.getProjection()
      if (!p || !p.enabled || p.integrity !== 'valid') return { status: 'unknown', reason_code: 'guard_unavailable' }
      const item = p.items.get(args.item_id ?? '')
      if (!item) return { status: 'rejected', reason_code: 'item_not_found' }
      if (args.item_revision !== undefined && item.revision !== args.item_revision) {
        return { status: 'rejected', reason_code: 'item_revision_mismatch', item_revision: item.revision }
      }
      const diagnosis = deriveItemDiagnosis(p, item)
      const plannedAction = (args.semantic_action ?? item.semanticAction) as StatefulAction | undefined
      const manifestEntry = plannedAction ? ACTION_MANIFEST.actions[plannedAction] : undefined
      if (plannedAction && !manifestEntry) return { status: 'rejected', reason_code: 'unsupported_action' }

      const reusable = [...p.evidence.values()]
        .filter((evidence) => relevantEvidence(p, item, evidence) && evidenceAvailabilityReason(evidence) === undefined)
        .sort((a, b) => b.toolResultSeq - a.toolResultSeq)
        .slice(0, 8)
        .map((evidence) => ({
          evidence_id: evidence.id, role: evidence.evidenceRole, semantic_action: evidence.semanticAction,
          resolved_target: evidence.resolvedTarget, tool_result_seq: evidence.toolResultSeq,
        }))

      const requiredOrder = manifestEntry?.stateful
        ? ['resolution (prestate facts from a trusted read)', 'effect (the exact planned change)', 'state (independent post-state readback)']
        : ['state (matching durable evidence for the requested verification)']

      const missingTargetFields = manifestEntry?.stateful && plannedAction
        ? manifestEntry.resolvedTargetKeys.filter((key) => !(item.requestedTarget?.[key] !== undefined || args.requested_target?.[key] !== undefined))
        : []

      const capability = plannedAction && options.hostCapability
        ? options.hostCapability(plannedAction)
        : undefined
      const commandShape = options.commandTemplate && plannedAction
        ? options.commandTemplate(plannedAction)
        : undefined

      // Optional fields are SPREAD IN ONLY WHEN DEFINED. The host validates a
      // tool's canonical value as lossless JSON before rendering or persisting
      // it, and `undefined` is not a lossless JSON value: an object literal
      // carrying `supported_command_shape: undefined` fails the WHOLE call with
      // `INVALID_TOOL_OUTPUT`, so the model gets an error instead of the
      // preparation it asked for. That triggered whenever an item had no
      // semantic action — a `generic_run` requirement, for example — or no
      // command template. The `as unknown as Record<string, JsonValue>` cast
      // below is what kept the type checker from flagging the `undefined`s.
      return {
        status: 'prepared',
        item: { id: item.id, revision: item.revision },
        diagnosis,
        ...(plannedAction !== undefined ? { planned_action: plannedAction } : {}),
        ...(commandShape !== undefined ? { supported_command_shape: commandShape } : {}),
        required_evidence_order: requiredOrder,
        reusable_references: reusable,
        missing_target_fields: missingTargetFields,
        ...(capability ? { host_capability: { status: capability.status, reason_code: capability.reasonCode } } : {}),
        note: 'Preparation performs no action. A default or guessed target is not user authority; explicit root instruction is required for missing target fields.',
      } as unknown as Record<string, JsonValue>
    },
  })
}
