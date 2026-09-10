import { it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { createCheckpointTool } from '../../src/tools/checkpoint.js'
import { createRebindTool } from '../../src/tools/rebind.js'
import { createBoundaryTool } from '../../src/tools/boundary.js'
import { createPrepareTool } from '../../src/tools/prepare.js'
import { createExternalOperationTool } from '../../src/tools/external-operation.js'
import { createActionTool, createEvidenceTool } from '../../src/tools/evidence.js'
import { createProjection } from '../../src/domain/types.js'
import { captureClause } from '../../src/domain/capture.js'
import { GIT_COMMAND_TEMPLATES } from '../../src/domain/git-adapter.js'

/**
 * Every Guard tool through the REAL host registry.
 *
 * Guard's tools declare a canonical `output` schema, and the pinned host
 * validates the returned value against it — a value carrying a field the schema
 * forbids raises `ToolOutputError` at the registry boundary. Every other test in
 * this repository calls `tool.execute(...)` directly, which bypasses argument
 * validation, the guard layer, output validation, and materialization entirely.
 * Only `context_guard_checkpoint` and `context_guard_rebind` were ever driven
 * through `ToolRuntime`, so five of the seven tools could have returned a shape
 * their own schema rejects and every local test would still have passed — the
 * failure would have appeared in a user's session instead.
 *
 * These cases register all seven, invoke each with valid arguments, and require
 * a normalized result that is NOT an output-contract violation. A structured
 * `status: 'unavailable'` response is a legitimate canonical value, so it also
 * exercises the schema; that is deliberate, not a shortcut.
 *
 * Writing this test found two REAL pre-existing defects. `context_guard_prepare`
 * returned `planned_action`, `supported_command_shape` and `host_capability`
 * as object properties even when they were `undefined`, and
 * `context_guard_rebind`'s item query returned `pending_proposal_id:
 * undefined` and an optional `item.semantic_action`. The host validates a
 * tool's canonical value as lossless JSON, so `undefined` fails the WHOLE call
 * with `INVALID_TOOL_OUTPUT` — the model would receive an error instead of the
 * answer. Both were masked from the type checker by
 * `as unknown as Record<string, JsonValue>` casts, and no test had ever driven
 * those paths through the registry. Both are fixed by spreading the optional
 * fields in only when defined.
 */

function guardProjection(options: { withAction?: boolean } = {}) {
  const projection = createProjection()
  projection.enabled = true
  const item = captureClause('运行 pnpm test 验证工作区', 'm1', 'R001', 1, { cwd: '/work' })
  if (options.withAction === false) {
    // A requirement with no derived semantic action is an ordinary case — a
    // \`generic_run\` item such as "investigate X" — and it is exactly the input
    // that made \`context_guard_prepare\` return \`planned_action: undefined\`.
    delete item.semanticAction
  }
  projection.items.set(item.id, item)
  projection.contractRevision = 1
  return projection
}

function registry(options: { withAction?: boolean } = {}) {
  const ctx = new Context()
  new SystemPrompt(ctx, {})
  const runtime = new ToolRuntime(ctx)
  const projection = guardProjection(options)
  runtime.register(createCheckpointTool(() => projection, () => {}))
  runtime.register(createRebindTool(() => projection, async () => true))
  runtime.register(createBoundaryTool(() => projection, async () => true, () => {}))
  runtime.register(createPrepareTool({
    getProjection: () => projection,
    hostCapability: (action) => ({ status: 'supported', reasonCode: `${action}_supported` }),
    commandTemplate: (action) => GIT_COMMAND_TEMPLATES[action as keyof typeof GIT_COMMAND_TEMPLATES],
  }))
  runtime.register(createExternalOperationTool(() => undefined, () => ({ status: 'supported', digest: 'a'.repeat(64) })))
  runtime.register(createEvidenceTool({}))
  runtime.register(createActionTool({}))
  return { runtime, projection }
}

it('detects an output-contract violation, so the assertions above can bite', async () => {
  // Negative control. Without this, a wrong error-code guess would make every
  // case above pass vacuously — which is exactly what the first draft did.
  const ctx = new Context()
  new SystemPrompt(ctx, {})
  const runtime = new ToolRuntime(ctx)
  runtime.register(defineTool({
    name: 'guard_negative_control',
    description: 'returns a field its declared output schema forbids',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async () => ({ status: 'ok', unexpected: 'this field is not in the schema' }) as never,
  }))
  const response = await runtime.execute({
    callId: 'negative-control' as never,
    name: 'guard_negative_control',
    arguments: {},
    signal: new AbortController().signal,
  })
  expect((response as { error?: { info?: { code?: string } } }).error?.info?.code).toBe('INVALID_TOOL_OUTPUT')
})

const CASES: Array<{ tool: string; arguments: Record<string, unknown>; withAction?: boolean }> = [
  { tool: 'context_guard_checkpoint', arguments: { bindings: [] } },
  { tool: 'context_guard_rebind', arguments: { operation: 'query', item_id: 'R001' }, withAction: false },
  { tool: 'context_guard_rebind', arguments: { operation: 'propose', item_id: 'R001', clauses: ['运行 pnpm test 验证工作区'] } },
  { tool: 'context_guard_boundary', arguments: { disposition: 'deferred', qualification_kind: 'root_explicit_defer', qualification_ids: ['R001'] } },
  { tool: 'context_guard_prepare', arguments: { item_id: 'R001' }, withAction: false },
  { tool: 'context_guard_prepare', arguments: { item_id: 'R001', semantic_action: 'test' } },
  { tool: 'context_guard_external_operation', arguments: { operation_id: 'job-1' } },
  { tool: 'context_guard_evidence', arguments: { semantic_action: 'commit', evidence_role: 'resolution', selector: {} } },
  { tool: 'context_guard_action', arguments: {
    semantic_action: 'commit', resolution_call_id: 'call-1', target_digest: '0'.repeat(64),
    contract_item_id: 'R001', contract_item_revision: 1,
  } },
]

it.each(CASES)('$tool materializes through the real DSH ToolRuntime output contract', async ({ tool, arguments: args, withAction }) => {
  const { runtime } = registry({ withAction })
  const response = await runtime.execute({
    callId: `call-${tool}` as never,
    name: tool,
    arguments: args,
    signal: new AbortController().signal,
  })
  // The host's exact codes and their exact LOCATION, both read from the
  // installed registry rather than guessed: the failure envelope is
  // `{ isError: true, error: { message, info: { name, code } } }`, so the code
  // lives at `error.info.code`. The first draft of this test asserted invented
  // code names at the wrong path and could never have failed; the negative
  // control below is what exposed that.
  const code = (response as { error?: { info?: { code?: string } } }).error?.info?.code
  expect(code, `${tool} rejected the arguments this case supplies`).not.toBe('INVALID_ARGS')
  expect(code, `${tool} returned a value its own output schema rejects`).not.toBe('INVALID_TOOL_OUTPUT')
  expect(code, `${tool} is not registered in the runtime`).not.toBe('UNKNOWN_TOOL')
})
