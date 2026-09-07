import { it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createCheckpointTool } from '../../src/tools/checkpoint.js'
import { createRebindTool } from '../../src/tools/rebind.js'
import { createProjection } from '../../src/domain/types.js'
import { captureClause } from '../../src/domain/capture.js'

it('T11 materializes bounded checkpoint and proposal JSON through the real DSH ToolRuntime output contract', async () => {
  const ctx = new Context()
  new SystemPrompt(ctx, {})
  const runtime = new ToolRuntime(ctx)
  const p = createProjection()
  p.enabled = true
  p.items.set('R1', captureClause('更新演示包', 'm1', 'R1', 1))
  p.evidence.set('E1', { id: 'E1', epoch: 0, callId: 'c1', rootCallId: 'c1', toolName: 'bash', toolResultSeq: 1,
    outcome: 'success', capabilities: [], subjects: ['长'.repeat(9000)], surfaces: [], boundedSummarySha256: 'a'.repeat(64) })
  runtime.register(createCheckpointTool(() => p, () => {}))
  runtime.register(createRebindTool(() => p, async () => true))
  const response = await runtime.execute({ callId: 'query' as never, name: 'context_guard_checkpoint', arguments: { bindings: [], evidence_scope: 'history' }, signal: new AbortController().signal })
  expect(response.error).toBeUndefined()
  expect(response.isError).toBe(false)
  const text = response.content.filter(row => row.type === 'text').map(row => row.type === 'text' ? row.text : '').join('')
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(12288)
  expect(JSON.parse(text)).toMatchObject({ status: 'incomplete', available_evidence: [{ omitted: true, adapter_disposition: 'unavailable' }] })
  const proposal = await runtime.execute({ callId: 'propose' as never, name: 'context_guard_rebind', arguments: { operation: 'propose', item_id: 'R1', clauses: ['更新演示包'] }, signal: new AbortController().signal })
  expect(proposal.isError).toBe(false)
  expect(proposal.value).toMatchObject({ status: 'proposed' })
})
