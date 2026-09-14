import type { StatefulAction } from '../domain/protocol-manifest.js'

/**
 * One unified preparation descriptor per stateful action (0.6.0 DS06-E basis).
 *
 * Every supported action is described by the same field families, so prepare
 * output, the evidence producer's missing-input diagnosis, and the required
 * evidence order are generated from one source instead of Git-only special
 * cases. The descriptor separates three kinds of identity:
 *
 * - `selector_fields` — caller-supplied identity the root instruction or a
 *   trusted user choice must name;
 * - `producer_fields` — prestate/plan identities the trusted producer reads or
 *   computes from live resources; a caller can never furnish them, and they are
 *   never listed as missing caller input;
 * - `readback_fields` — the independent post-effect state the producer reads
 *   back (mirrors the action manifest's observed state keys).
 *
 * The shapes mirror `resolveTarget` in `tools/evidence.ts` exactly; the
 * descriptor is guidance only and the live resolution stays authoritative.
 */
export interface ActionPreparationDescriptor {
  action: StatefulAction
  /** Caller-supplied selector fields required before resolution. */
  selector_fields: string[]
  /** Caller-supplied selector fields that may be omitted. */
  optional_selector_fields: string[]
  /** Command-manifest field names the exact manifest id requires. */
  command_manifest_fields: string[]
  /** The pinned manifest id(s) this action accepts. */
  command_manifest_ids: string[]
  /** Tools that may execute the planned effect. */
  planned_tools: string[]
  /** Exact argument fields of the planned effect call. */
  planned_argument_fields: string[]
  /** Fields the trusted producer reads or computes; never caller input. */
  producer_fields: string[]
  /** Independent post-effect state fields the producer reads back. */
  readback_fields: string[]
  /** Where the mutating effect actually executes. */
  execution_surface: 'context_guard_action' | 'native_write_edit'
  /** Ordered caller steps from resolution to checkpoint. */
  steps: string[]
}

const GUARD_TOOL_STEPS = [
  'Before execution: context_guard_evidence with evidence_role=resolution, selector and command_manifest. Keep the successful tool call ID and target_digest.',
  'Execute once with context_guard_action, semantic_action, resolution_call_id, target_digest, contract_item_id and contract_item_revision.',
  'Collect effect and state separately with context_guard_evidence, using the same resolution_call_id and the successful action call ID as effect_call_id.',
  'Checkpoint the matching resolution/effect/state evidence IDs. Call IDs identify tool events; evidence IDs identify checkpoint facts.',
  'If the action already ran without resolution, report the historical evidence gap and read back state. Do not repeat a mutation to create missing prestate evidence.',
]

const NATIVE_WRITE_STEPS = [
  'Before execution: context_guard_evidence with evidence_role=resolution, selector and command_manifest. Keep the successful tool call ID and target_digest.',
  'Execute the planned effect once with the native write/edit tool named by command_manifest.planned_tool and exactly the planned_arguments.',
  'Collect effect and state separately with context_guard_evidence, using the same resolution_call_id and the successful write/edit call ID as effect_call_id.',
  'Checkpoint the matching resolution/effect/state evidence IDs. Call IDs identify tool events; evidence IDs identify checkpoint facts.',
  'If the action already ran without resolution, report the historical evidence gap and read back state. Do not repeat a mutation to create missing prestate evidence.',
]

/**
 * The unified descriptor for one stateful action. Git actions keep their
 * historical selector/manifest/step shapes; the other six gain the same
 * complete recipe instead of Git-only coverage.
 */
export function actionPreparation(action: StatefulAction): ActionPreparationDescriptor {
  switch (action) {
    case 'install':
    case 'apply': {
      const manifestId = action === 'install' ? 'dsh.plugin_add_tgz.install.v1' : 'dsh.plugin_add_tgz.apply.v1'
      return {
        action,
        selector_fields: ['package_id', 'profile'],
        optional_selector_fields: ['version'],
        command_manifest_fields: ['manifest_id', 'tgz_path'],
        command_manifest_ids: [manifestId],
        planned_tools: ['context_guard_action'],
        planned_argument_fields: [],
        producer_fields: ['version', 'integrity_digest'],
        readback_fields: ['package_id', 'version', 'integrity_digest', 'profile'],
        execution_surface: 'context_guard_action',
        steps: GUARD_TOOL_STEPS,
      }
    }
    case 'create':
      return {
        action,
        selector_fields: ['artifact_id'],
        optional_selector_fields: [],
        command_manifest_fields: ['planned_tool', 'planned_arguments'],
        command_manifest_ids: ['artifact.create.v1'],
        planned_tools: ['write', 'write_file'],
        planned_argument_fields: ['file_path', 'content'],
        producer_fields: ['scope', 'pre_digest', 'change_set_digest'],
        readback_fields: ['post_digest'],
        execution_surface: 'native_write_edit',
        steps: NATIVE_WRITE_STEPS,
      }
    case 'modify':
      return {
        action,
        selector_fields: ['artifact_id'],
        optional_selector_fields: [],
        command_manifest_fields: ['planned_tool', 'planned_arguments'],
        command_manifest_ids: ['artifact.modify.v1'],
        planned_tools: ['edit', 'edit_file'],
        planned_argument_fields: ['file_path', 'old_string', 'new_string'],
        producer_fields: ['scope', 'pre_digest', 'change_set_digest'],
        readback_fields: ['post_digest'],
        execution_surface: 'native_write_edit',
        steps: NATIVE_WRITE_STEPS,
      }
    case 'restart':
      return {
        action,
        selector_fields: ['service_id'],
        optional_selector_fields: [],
        command_manifest_fields: ['manifest_id'],
        command_manifest_ids: ['dshmarket.restart.v1'],
        planned_tools: ['context_guard_action'],
        planned_argument_fields: [],
        producer_fields: ['pre_generation'],
        readback_fields: ['new_generation', 'health'],
        execution_surface: 'context_guard_action',
        steps: GUARD_TOOL_STEPS,
      }
    case 'publish':
      return {
        action,
        selector_fields: ['artifact_id', 'version', 'registry'],
        optional_selector_fields: [],
        command_manifest_fields: ['manifest_id', 'tgz_path'],
        command_manifest_ids: ['npm.publish_tgz.v1'],
        planned_tools: ['context_guard_action'],
        planned_argument_fields: [],
        producer_fields: ['integrity_digest'],
        readback_fields: ['artifact_id', 'version', 'registry', 'integrity_digest'],
        execution_surface: 'context_guard_action',
        steps: GUARD_TOOL_STEPS,
      }
    case 'commit':
      return {
        action,
        selector_fields: ['repository', 'branch'],
        optional_selector_fields: [],
        command_manifest_fields: ['planned_tool', 'planned_arguments'],
        command_manifest_ids: ['git.commit_index_tree.v2'],
        planned_tools: ['bash', 'pwsh'],
        planned_argument_fields: ['command', 'workdir'],
        producer_fields: ['pre_head_oid', 'change_set_digest'],
        readback_fields: ['post_head_oid', 'pre_head_oid'],
        execution_surface: 'context_guard_action',
        steps: GUARD_TOOL_STEPS,
      }
    case 'push':
      return {
        action,
        selector_fields: ['repository', 'remote', 'refspec'],
        optional_selector_fields: [],
        command_manifest_fields: ['planned_tool', 'planned_arguments'],
        command_manifest_ids: ['git.push_explicit_refs.v2'],
        planned_tools: ['bash', 'pwsh'],
        planned_argument_fields: ['command', 'workdir'],
        producer_fields: ['local_oid'],
        readback_fields: ['remote_oid'],
        execution_surface: 'context_guard_action',
        steps: GUARD_TOOL_STEPS,
      }
    case 'pull':
      return {
        action,
        selector_fields: ['repository', 'remote', 'refspec'],
        optional_selector_fields: [],
        command_manifest_fields: ['planned_tool', 'planned_arguments'],
        command_manifest_ids: ['git.pull_ff_only_explicit.v2'],
        planned_tools: ['bash', 'pwsh'],
        planned_argument_fields: ['command', 'workdir'],
        producer_fields: ['upstream_oid', 'pre_head_oid', 'pull_mode'],
        readback_fields: ['post_head_oid', 'tracking_ref_oid'],
        execution_surface: 'context_guard_action',
        steps: GUARD_TOOL_STEPS,
      }
    case 'fetch':
      return {
        action,
        selector_fields: ['repository', 'remote', 'refspec'],
        optional_selector_fields: [],
        command_manifest_fields: ['planned_tool', 'planned_arguments'],
        command_manifest_ids: ['git.fetch_tracking_explicit.v2'],
        planned_tools: ['bash', 'pwsh'],
        planned_argument_fields: ['command', 'workdir'],
        producer_fields: ['upstream_oid', 'pre_head_oid'],
        readback_fields: ['tracking_ref_oid', 'post_head_oid'],
        execution_surface: 'context_guard_action',
        steps: GUARD_TOOL_STEPS,
      }
  }
}
