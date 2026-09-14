import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { GuardProjection } from '../domain/types.js'
import { deriveItemDiagnosis, evidenceAvailabilityReason, relevantEvidence } from '../domain/diagnostics.js'
import { actionPreparation } from './action-preparation.js'
import { ACTION_MANIFEST, isStatefulAction, type StatefulAction } from '../domain/protocol-manifest.js'

export interface PrepareToolOptions {
  getProjection: () => GuardProjection | undefined
  /** Action-scoped host capability decision from the runtime lock. */
  hostCapability?: (action: StatefulAction) => { status: 'supported' | 'unsupported' | 'unavailable'; reasonCode?: string }
  /** Canonical command template for one stateful action, from the manifest. */
  commandTemplate?: (action: StatefulAction) => Record<string, unknown> | undefined
  /**
   * 0.6.0 fresh-projection entry: flush, re-snapshot, and re-derive before
   * reading. Without it the tool reads the caller-supplied projection as-is,
   * which cannot see input persisted after the caller's last sync.
   */
  refreshProjection?: () => Promise<boolean>
}

interface PrepareArgs {
  item_id?: string
  item_revision?: number
  semantic_action?: string
  requested_target?: Record<string, unknown>
  planned_operation?: string
}

/** Discovery pages stay bounded like checkpoint pages. */
const DISCOVERY_ITEM_LIMIT = 8

/**
 * Thin READ-ONLY preparation surface (v0.5/0.6): before any stateful action it
 * reports the supported command shape, the required resolution/effect/state
 * evidence order, existing reusable references, and the exact missing fields.
 * It never executes, installs, commits, pushes, restarts, or probes authority
 * through side effects, and it never upgrades a default into user authority.
 * Without an `item_id` it returns the bounded current-item discovery list, so
 * the first step of a session can find the right ID instead of guessing one.
 */
export function createPrepareTool(options: PrepareToolOptions): ToolDefinition {
  return defineTool({
    name: 'context_guard_prepare',
    description: 'Read-only pre-action preparation: report the supported command shape, required resolution/effect/state evidence order, existing references, and exact missing target fields for one contract item. Omit item_id to list current open items with their IDs. Performs no action and grants no authority.',
    parameters: {
      item_id: { type: 'string' },
      item_revision: { type: 'number' },
      semantic_action: { type: 'string' },
      requested_target: { type: 'object', additionalProperties: true },
      planned_operation: { type: 'string' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(rawArgs) {
      const args = rawArgs as unknown as PrepareArgs
      if (options.refreshProjection) {
        let durable = false
        try {
          durable = await options.refreshProjection() === true
        } catch {
          durable = false
        }
        // A failed flush means this step's input may not be visible yet and
        // nothing read back here would be trustworthy: report the failure
        // instead of silently serving a stale cache (0.6.0 fresh-projection
        // contract). The caller can retry after durability recovers.
        if (!durable) return { status: 'unknown', reason_code: 'projection_durability_unavailable' }
      }
      const p = options.getProjection()
      if (!p || !p.enabled || p.integrity !== 'valid') return { status: 'unknown', reason_code: 'guard_unavailable' }

      // Discovery: a bounded current-item list so a fresh session never has to
      // guess an item ID. The listing is display-only; every field it shows is
      // re-validated when the item is actually prepared or checkpointed.
      if (args.item_id === undefined) {
        const open = [...p.items.values()]
          .filter((item) => item.status === 'pending')
          .sort((a, b) => a.revision - b.revision || a.id.localeCompare(b.id))
        return {
          status: 'prepared',
          mode: 'discovery',
          durability: p.durabilityWatermark,
          contract_revision: p.contractRevision,
          total_open: open.length,
          items: open.slice(0, DISCOVERY_ITEM_LIMIT).map((item) => {
            const diagnosis = deriveItemDiagnosis(p, item)
            return {
              id: item.id,
              revision: item.revision,
              kind: item.kind,
              ...(item.taskKind !== undefined ? { task_kind: item.taskKind } : {}),
              semantic_action: item.semanticAction ?? 'generic_run',
              reason_code: diagnosis.reason_code,
              text: item.normalizedText,
            }
          }),
          note: 'Re-run with one item_id to prepare that item. Preparation performs no action.',
        }
      }

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

      // Every stateful action shares one descriptor source, so prepare output,
      // the producer's missing-input diagnosis, and the required order cannot
      // drift apart. Producer-computed identities (prestate digests, OIDs,
      // tgz integrity) are never listed as missing caller input.
      const recipe = plannedAction && isStatefulAction(plannedAction) ? actionPreparation(plannedAction) : undefined
      const missingTargetFields = recipe
        ? recipe.selector_fields.filter((key) => !(item.requestedTarget?.[key] !== undefined || args.requested_target?.[key] !== undefined))
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
        ...(capability ? { host_capability: { status: capability.status, ...(capability.reasonCode !== undefined ? { reason_code: capability.reasonCode } : {}) } } : {}),
        ...(recipe ? { evidence_input_contract: {
          selector_fields: recipe.selector_fields,
          optional_selector_fields: recipe.optional_selector_fields,
          command_manifest_fields: recipe.command_manifest_fields,
          command_manifest_ids: recipe.command_manifest_ids,
          planned_tools: recipe.planned_tools,
          planned_argument_fields: recipe.planned_argument_fields,
          producer_fields: recipe.producer_fields,
          readback_fields: recipe.readback_fields,
          execution_surface: recipe.execution_surface,
          steps: recipe.steps,
        } } : {}),
        note: 'Preparation performs no action. A default or guessed target is not user authority; explicit root instruction is required for missing target fields.',
      } as unknown as Record<string, JsonValue>
    },
  })
}
