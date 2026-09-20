import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { GuardItem, GuardProjection } from '../domain/types.js'
import { deriveItemDiagnosis, evidenceAvailabilityReason, relevantEvidence } from '../domain/diagnostics.js'
import { actionPreparation } from './action-preparation.js'
import {
  ACTION_MANIFEST, isStatefulAction, requestedTargetAuthorizesMutation, requestedTargetMatchesResolved,
  type SemanticAction, type StatefulAction,
} from '../domain/protocol-manifest.js'
import { actionHasAdapter, evaluateCompatibility } from '../domain/compatibility.js'
import { itemHoldsExecutionAuthority } from '../domain/semantics.js'
import type { TargetTuple } from '../domain/types.js'
import { unitDescendantIds } from '../domain/work-unit.js'
import { currentV6Feedback, sourceItemForCoreRequirement } from '../domain/v6-feedback.js'
import { sha256 } from '../domain/canonicalize.js'

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
  page_cursor?: string
}

/**
 * Whether a standing prohibition the gate would refuse now covers this
 * hypothesis. It mirrors `authorizeMutationFromProjection`'s own check: a
 * pending, root-authorized, non-legacy prohibition on the same action whose
 * declared identity matches the target this preparation is about.
 */
function conflictsWithProhibition(
  projection: GuardProjection,
  action: StatefulAction,
  item: GuardItem,
): boolean {
  const resolved = item.requestedTarget
  if (resolved === undefined) return false
  return [...projection.items.values()].some((candidate) => (
    candidate.status === 'pending'
    && candidate.kind === 'prohibition'
    && (candidate.authority === 'root_instruction' || candidate.authority === 'root_adoption')
    && !candidate.legacyFlags?.length
    && candidate.semanticAction === action
    && requestedTargetMatchesResolved(action, candidate.requestedTarget, resolved)
  ))
}

/** Discovery pages stay bounded like checkpoint pages. */
const DISCOVERY_ITEM_LIMIT = 8

/** Opaque pagination cursor for discovery: bound to the projection revision. */
interface DiscoveryCursor {
  v: 1
  /** The contract revision the page was listed against. */
  r: number
  /** The declared semantic_action filter (null when none). */
  f: string | null
  /** Sort key of the last item on the previous page: [revision, id]. */
  k: [number, string]
  /** Confirmed shared-core as-of identity for default v6 discovery. */
  c?: string
}

const encodeCursor = (cursor: DiscoveryCursor): string =>
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')

/**
 * The items discovery lists for the CURRENT work: under a v5 boundary that is
 * the current unit's closure plus its required descendants (the same scope a
 * v2 certificate answers for, prohibitions included because a standing
 * constraint is never finished work) plus every pre-v5 obligation, which keeps
 * their birth rules and must never be silently dropped. A legacy session lists
 * the whole session. Switched-away sibling units keep their own history and
 * are reached by item ID, not re-listed here (0.6.1, W060-03).
 */
function discoveryItemIds(p: GuardProjection): string[] {
  const current = currentV6Feedback(p)
  if (current && current.status !== 'unknown') return current.openIds
  const pending = [...p.items.values()]
    .filter((item) => item.status === 'pending')
    .sort((a, b) => a.revision - b.revision || a.id.localeCompare(b.id))
  if (p.boundaryProtocol === undefined || p.boundaryProtocol < 5) return pending.map((item) => item.id)
  const closureUnits = new Set<string>([
    ...(p.currentUnitId !== undefined ? [p.currentUnitId, ...unitDescendantIds(p, p.currentUnitId)] : []),
  ])
  return pending
    .filter((item) => item.unitId === undefined || (item.unitId !== undefined && closureUnits.has(item.unitId)))
    .map((item) => item.id)
}

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
    description: 'Read-only diagnosis of open contract items. Ordinary changes use native host tools and observed facts; this tool never grants execution permission. Omit item_id for a paginated item list.',
    parameters: {
      item_id: { type: 'string' },
      item_revision: { type: 'number' },
      semantic_action: { type: 'string' },
      requested_target: { type: 'object', additionalProperties: true },
      planned_operation: { type: 'string' },
      page_cursor: { type: 'string' },
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
      const currentFeedback = currentV6Feedback(p)
      if (currentFeedback?.status === 'unknown') return { status: 'unknown', reason_code: currentFeedback.reasonCode }
      if (p.boundaryProtocol === 6 && args.item_id !== undefined) {
        const sourced = currentFeedback ? sourceItemForCoreRequirement(p, args.item_id) : undefined
        const current = sourced?.item ?? p.items.get(args.item_id)
        if (!current) return { status: 'rejected', reason_code: 'item_not_found' } as Record<string, JsonValue>
        if (args.item_revision !== undefined && args.item_revision !== current.revision) return { status: 'rejected', reason_code: 'item_revision_mismatch' } as Record<string, JsonValue>
        if (current.kind === 'prohibition' && currentFeedback) {
          const state = currentFeedback.predicates[args.item_id]
          if (state === 'constraint_active' || state === 'constraint_unresolved' || state === 'constraint_violated') return {
            status: state === 'constraint_active' ? 'active' : state === 'constraint_unresolved' ? 'unknown' : 'incomplete',
            reason_code: state,
            item: { id: current.id, revision: current.revision, status: state },
            next_step: state === 'constraint_active' ? 'This sourced prohibition remains active.'
              : state === 'constraint_unresolved' ? 'The current Host facts cannot establish whether this prohibition was respected.'
                : 'A sourced Host mutation violated this prohibition.',
          } as Record<string, JsonValue>
        }
        if (current.semanticAction !== 'publish' && currentFeedback) {
          const exactDerived = sourced?.origin !== undefined
          const related = Object.entries(currentFeedback.predicates)
            .filter(([id]) => exactDerived ? id === args.item_id
              : id === args.item_id || sourceItemForCoreRequirement(p, id)?.item.id === current.id)
          const state = related.length === 0 ? undefined
            : related.every(([, value]) => value === 'satisfied') ? 'satisfied' : 'insufficient'
          return {
            status: state === undefined || state === 'satisfied' ? 'observed' : 'incomplete',
            reason_code: state === undefined ? 'historical_item_not_current'
              : state === 'satisfied' ? 'ordinary_current_predicate_observed' : 'current_predicate_insufficient',
            item: { id: args.item_id, source_item_id: current.id, revision: current.revision,
              status: state ?? 'historical', related_requirement_ids: related.map(([id]) => id) },
            next_step: state === undefined ? 'This item is historical and is not current ordinary work.'
              : state === 'satisfied'
                ? 'This ordinary predicate is already observed. Continue with the remaining sourced requirements; no Guard execution qualification is needed.'
                : 'Use the current sourced action and host facts; no Guard execution qualification is needed.',
          } as Record<string, JsonValue>
        }
        if (current.semanticAction !== 'publish') return {
          status: 'observed', reason_code: 'ordinary_execution_host_owned',
          item: { id: current.id, revision: current.revision, status: current.status },
          next_step: 'Use the host tool for ordinary work. Guard can observe its persisted result and independent readback; no Guard preparation or qualification is required.',
        } as Record<string, JsonValue>
      }

      // Discovery: a bounded, FULLY TRAVERSABLE current-item list so a fresh
      // session never has to guess an item ID (0.6.1, W060-03). Stable order,
      // fixed page size, and a cursor bound to the contract revision: a
      // projection change between pages invalidates the cursor explicitly
      // instead of silently skipping or repeating items. The only filter is
      // `semantic_action` (exact match); it is part of the cursor, so page two
      // always continues the same filtered listing. The listing is
      // display-only; every field it shows is re-validated when the item is
      // actually prepared or checkpointed.
      if (args.item_id === undefined) {
        const filter = args.semantic_action ?? null
        const coreIdentity = currentFeedback ? sha256(JSON.stringify(p.coreV2 ?? null)) : undefined
        // Cursor refusals stay minimal: `undefined` is not a lossless JSON
        // value, so optional fields are spread in only when defined.
        const invalidCursor = (reason_code: string, note?: string) => ({
          status: 'rejected' as const,
          reason_code,
          mode: 'discovery' as const,
          contract_revision: p.contractRevision,
          ...(note !== undefined ? { note } : { note: 'Re-run discovery without page_cursor to list from the first page.' }),
        })
        let startAfter: DiscoveryCursor['k'] | undefined
        if (args.page_cursor !== undefined) {
          let parsed: DiscoveryCursor | undefined
          try {
            if (args.page_cursor.length <= 1024) {
              const value = JSON.parse(Buffer.from(args.page_cursor, 'base64url').toString('utf8')) as DiscoveryCursor
              if (value?.v === 1 && Number.isSafeInteger(value.r) && (value.f === null || typeof value.f === 'string')
                && Array.isArray(value.k) && Number.isSafeInteger(value.k[0]) && typeof value.k[1] === 'string'
                && (value.c === undefined || typeof value.c === 'string')) parsed = value
            }
          } catch { parsed = undefined }
          if (!parsed) return invalidCursor('discovery_cursor_malformed')
          if (parsed.r !== p.contractRevision) {
            return invalidCursor('discovery_cursor_stale', `The contract changed (cursor revision ${parsed.r}, current ${p.contractRevision}). Re-run discovery without page_cursor; items are never skipped by a stale page.`)
          }
          if (parsed.c !== coreIdentity) return invalidCursor('discovery_cursor_stale', 'The current observation changed. Re-run discovery without page_cursor.')
          if ((parsed.f ?? null) !== (filter ?? null)) return invalidCursor('discovery_cursor_filter_mismatch')
          startAfter = parsed.k
        }
        const eligible = discoveryItemIds(p)
          .map((id) => ({ id, sourced: currentFeedback ? sourceItemForCoreRequirement(p, id) : undefined,
            item: currentFeedback ? sourceItemForCoreRequirement(p, id)?.item : p.items.get(id) }))
          .filter((entry): entry is typeof entry & { item: GuardItem } => entry.item !== undefined)
          .filter(({ item, sourced }) => filter === null || (sourced?.origin?.action ?? item.semanticAction ?? 'generic_run') === filter)
        const startIndex = startAfter === undefined
          ? 0
          : eligible.findIndex(({ id, item }) => item.revision === startAfter![0] && id === startAfter![1]) + 1
        if (startAfter !== undefined && startIndex <= 0) {
          return invalidCursor('discovery_cursor_stale', 'The cursor names an item no longer in the current listing. Re-run discovery without page_cursor.')
        }
        const page = eligible.slice(startIndex, startIndex + DISCOVERY_ITEM_LIMIT)
        const hasMore = startIndex + page.length < eligible.length
        return {
          status: 'prepared',
          mode: 'discovery',
          durability: p.durabilityWatermark,
          contract_revision: p.contractRevision,
          total_open: eligible.length,
          listed: page.length,
          has_more: hasMore,
          items: page.map(({ id, item, sourced }) => {
            const diagnosis = deriveItemDiagnosis(p, item)
            return {
              id,
              ...(sourced?.origin ? { source_item_id: item.id, source_start: sourced.origin.sourceStart,
                source_end: sourced.origin.sourceEnd, target: sourced.origin.target } : {}),
              revision: item.revision,
              kind: item.kind,
              ...(item.taskKind !== undefined ? { task_kind: item.taskKind } : {}),
              semantic_action: sourced?.origin?.action ?? item.semanticAction ?? 'generic_run',
              reason_code: currentFeedback ? currentFeedback.predicates[id] ?? 'current_predicate_insufficient' : diagnosis.reason_code,
              text: item.normalizedText,
            }
          }),
          ...(hasMore ? {
            next_cursor: encodeCursor({
              v: 1, r: p.contractRevision, f: filter,
              k: [page[page.length - 1]!.item.revision, page[page.length - 1]!.id],
              ...(coreIdentity ? { c: coreIdentity } : {}),
            }),
          } : {}),
          ...(filter !== null ? { filtered_by: { semantic_action: filter } } : {}),
          note: 'Re-run with one item_id for a read-only diagnosis, or pass page_cursor for the next page.',
        }
      }

      const item = p.items.get(args.item_id ?? '')
      if (!item) return { status: 'rejected', reason_code: 'item_not_found' }
      if (args.item_revision !== undefined && item.revision !== args.item_revision) {
        return { status: 'rejected', reason_code: 'item_revision_mismatch', item_revision: item.revision }
      }
      const diagnosis = deriveItemDiagnosis(p, item)
      const itemAction = (item.semanticAction ?? 'generic_run') as SemanticAction
      const plannedAction = (args.semantic_action ?? item.semanticAction) as StatefulAction | undefined
      const manifestEntry = plannedAction ? ACTION_MANIFEST.actions[plannedAction] : undefined
      if (plannedAction && !manifestEntry) return { status: 'rejected', reason_code: 'unsupported_action' }
      // 0.6.3 K3: preparation reports the CURRENT item's compatibility through
      // the same judgement the runtime enforces before any effect. An action or
      // target the item does not read is refused here — with the item's own
      // action named as the reachable path — instead of returning a `prepared`
      // recipe the execution gate would refuse.
      const compatibility = evaluateCompatibility({
        action: (plannedAction ?? itemAction) as SemanticAction,
        itemAction,
        itemRevision: args.item_revision,
        currentRevision: item.revision,
        // 0.6.3 K3 (review counterexample): the SAME snapshot inputs the
        // mutation gate reads. Omitting the projection-level facts made prepare
        // report `compatible` while the gate denied with
        // `mutation_host_lock_unavailable` for the same snapshot.
        enabled: p.enabled,
        integrity: p.integrity,
        hostStatus: p.hostStatus,
        itemKind: item.kind,
        itemStatus: item.status,
        authority: item.authority,
        legacyFlags: item.legacyFlags,
        authorityDisposition: item.authorityDisposition,
        holdsExecutionAuthority: itemHoldsExecutionAuthority(item),
        waitAuthorization: item.waitAuthorization,
        reboundFrom: item.reboundFrom,
        originalAuthority: item.reboundFrom
          ? (() => {
              const original = p.items.get(item.reboundFrom.itemId)
              return original ? { semanticAction: original.semanticAction, requestedTarget: original.requestedTarget } : undefined
            })()
          : undefined,
        targetCaptureStatus: item.targetCaptureStatus,
        targetSourceKind: item.targetSource?.kind,
        requestedTarget: item.requestedTarget,
        // The same supplied target the gate will compare is what preparation
        // compares. A caller target that differs from the obligation's own
        // selection is therefore reported `incompatible`, exactly as the gate
        // denies it — passing the obligation's target on BOTH sides made the
        // comparison a tautology and let a wrong target read as compatible.
        ...(args.requested_target !== undefined
          ? { resolvedTarget: args.requested_target as TargetTuple }
          : item.requestedTarget ? { resolvedTarget: item.requestedTarget } : {}),
        // The gate authorizes with `requestedTargetAuthorizesMutation(OBLIGATION,
        // CALLER TARGET, RESOLVED)`: COVERAGE comes from the obligation's own
        // selection (a caller cannot supply the authority the root never gave)
        // while the MATCH is against the target actually to be executed. Both
        // sides therefore have to be distinct — passing the caller target as
        // both made the coverage check a tautology and let a caller-supplied
        // branch read as authorized (review 4).
        ...(item.requestedTarget !== undefined
          ? {
              targetAuthorizes: plannedAction !== undefined && isStatefulAction(plannedAction)
                ? requestedTargetAuthorizesMutation(
                    plannedAction,
                    item.requestedTarget,
                    (args.requested_target as TargetTuple | undefined) ?? item.requestedTarget,
                  )
                : true,
            }
          : {}),
        // 0.6.3 K3 (review P2): a standing prohibition the mutation gate refuses
        // on must block the preparation verdict too. Without it prepare reported
        // `compatible` while the SAME snapshot denied with
        // `mutation_conflicting_prohibition`.
        conflictingProhibition: plannedAction !== undefined && isStatefulAction(plannedAction)
          && conflictsWithProhibition(p, plannedAction, item),
        adapterSupported: actionHasAdapter((plannedAction ?? itemAction) as SemanticAction),
      }, (requested, resolved) => (
        plannedAction !== undefined && isStatefulAction(plannedAction)
          ? requestedTargetMatchesResolved(plannedAction, requested, resolved)
          : true
      ))
      const compatibilityView = {
        status: compatibility.status,
        assumed_action: compatibility.assumedAction,
        ...(compatibility.itemAction !== undefined ? { item_action: compatibility.itemAction } : {}),
        reason_codes: compatibility.reasonCodes,
        semantics_compatible: compatibility.semanticsCompatible,
        target_compatible: compatibility.targetCompatible,
        certifiable: compatibility.certifiable,
        ...(compatibility.requiredIdentityField !== undefined ? { required_identity_field: compatibility.requiredIdentityField } : {}),
        note: compatibility.status === 'compatible'
          ? 'This assumption matches the current obligation. Preparation itself still grants no authority.'
          : compatibility.status === 'incompatible'
            ? 'This assumption is not what this obligation records. Prepare again with the item action, or record a fresh root instruction that authorizes the action you intended.'
            : 'This assumption matches the obligation, but this snapshot cannot execute yet. Clear the named condition first.',
      }
      if (compatibility.status === 'incompatible') {
        return {
          status: 'incompatible',
          item: { id: item.id, revision: item.revision },
          diagnosis,
          compatibility: compatibilityView,
          reason_code: compatibility.reasonCodes[0],
          note: compatibilityView.note,
        } as unknown as Record<string, JsonValue>
      }
      // A caller-supplied target that the item's own reading does not select is
      // reported, never rendered as an executable recipe for the current item.
      // Every stateful action shares one descriptor source, so prepare output,
      // the producer's missing-input diagnosis, and the required order cannot
      // drift apart. Producer-computed identities (prestate digests, OIDs,
      // tgz integrity) are never listed as missing caller input.
      const recipe = plannedAction && isStatefulAction(plannedAction) ? actionPreparation(plannedAction) : undefined
      const missingTargetFields: string[] = recipe
        ? recipe.selector_fields.filter((key) => !(item.requestedTarget?.[key] !== undefined || args.requested_target?.[key] !== undefined))
        : []

      // A caller-supplied target is a FIELD for the plan, not authority. When it
      // differs from the target the item already selected, the response says so
      // at field level and keeps the recipe recipe_only — it never presents the
      // substitution as this item's authorized target.
      const callerTargetProposedKeys = item.targetCaptureStatus === 'resolved'
        ? Object.keys(args.requested_target ?? {}).filter((key) => {
            const own = item.requestedTarget?.[key]
            const selectedByItem = own !== undefined
            const plannedByRecipe = recipe?.selector_fields.includes(key) === true
            if (!selectedByItem && !plannedByRecipe) return false
            const proposed = args.requested_target?.[key]
            return proposed !== own && JSON.stringify(proposed) !== JSON.stringify(own)
          })
        : []

      const reusable = [...p.evidence.values()]
        .filter((evidence) => relevantEvidence(p, item, evidence) && evidenceAvailabilityReason(evidence) === undefined)
        .sort((a, b) => b.toolResultSeq - a.toolResultSeq)
        .slice(0, 8)
        .map((evidence) => ({
          evidence_id: evidence.id, role: evidence.evidenceRole, semantic_action: evidence.semanticAction,
          resolved_target: evidence.resolvedTarget, tool_result_seq: evidence.toolResultSeq,
        }))

      // The evidence order comes from the SAME obligation contract the
      // diagnosis uses (0.6.1, W060-04): a stateful change needs the full
      // resolution/effect/state producer chain; a read-only verification needs
      // exactly one matching fact in the `effect` role, which is the manifest
      // the certifier accepts. Wording below must not promise roles the
      // certifier would refuse.
      const requiredOrder = plannedAction && isStatefulAction(plannedAction)
        ? ['resolution (prestate facts from a trusted read)', 'effect (the exact planned change)', 'state (independent post-state readback)']
        : ['effect (one matching durable verification fact)']

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
        compatibility: compatibilityView,
        ...(plannedAction !== undefined ? { planned_action: plannedAction } : {}),
        ...(commandShape !== undefined ? { supported_command_shape: commandShape } : {}),
        required_evidence_order: requiredOrder,
        reusable_references: reusable,
        missing_target_fields: missingTargetFields,
        ...(capability ? { host_capability: { status: capability.status, ...(capability.reasonCode !== undefined ? { reason_code: capability.reasonCode } : {}) } } : {}),
        ...(recipe ? {
          // 0.6.3 K3: the descriptor is the caller's ASSUMED recipe. It is
          // explicitly recipe_only — a manual for the action the caller named,
          // never a statement that the current item is ready to execute it.
          recipe_only: true,
          evidence_input_contract: {
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
        },
        } : {}),
        ...(callerTargetProposedKeys.length > 0 ? {
          caller_target_is_proposal: {
            fields: callerTargetProposedKeys,
            note: 'The supplied requested_target differs from the target this obligation selected. It is recorded as the caller\'s proposal for the plan only; authorization still compares the obligation\'s own target.',
          },
        } : {}),
        note: callerTargetProposedKeys.length > 0
          ? 'Preparation performs no action. The supplied requested_target is NOT the target this obligation selected and is not authority; the recipe below is recipe_only. Resolve the item target through context_guard_evidence before executing.'
          : 'Preparation performs no action. A default or guessed target is not user authority; explicit root instruction is required for missing target fields.',
      } as unknown as Record<string, JsonValue>
    },
  })
}
