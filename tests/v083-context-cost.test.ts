import { expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { apply, PROTOCOL_CORRECTION_NOTICE } from '../src/runtime.js'
import { deriveProjection, PROTOCOL_V6_NOTICE } from '../src/domain/derive.js'
import { firstStepGuidanceV6 } from '../src/domain/lifecycle.js'
import { renderRecoveryPacket, recoveryDigest } from '../src/domain/recovery.js'
import { projectSessionCoreV2 } from '../src/core-v2/session.js'
import { createPrepareTool } from '../src/tools/prepare.js'
import { createEvidenceTool } from '../src/tools/evidence.js'
import { createCheckpointTool } from '../src/tools/checkpoint.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'

const size = (value: unknown): { characters: number; utf8_bytes: number } => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return { characters: text.length, utf8_bytes: Buffer.byteLength(text) }
}
const HOST = evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' })
function fixture(text: string) {
  const session = Session.create(SessionId('context-cost'), undefined, {
    version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId('context-cost'), createdAt: 1, cwd: '/fixture',
  })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }],
    source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice', summary: 'synthetic boundary' } }), { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const events = session.snapshotEvents() as never
  const p = deriveProjection(events, { activation: 'always' }, { cwd: '/fixture' }, true, HOST).projection
  p.durabilityWatermark = 'confirmed'
  p.coreV2RequirementOrigins = new Map()
  p.coreV2 = projectSessionCoreV2(events, p, p.coreV2RequirementOrigins)
  return { session, p }
}

it('inventories every registered schema and task replay cost using explicit byte proxies', async () => {
  const { session } = fixture('Run the tests. Do not push main.')
  const definitions: Array<Record<string, unknown>> = []
  const handlers: Record<string, Array<(payload: unknown) => unknown>> = {}
  apply({ commands: { register: () => () => {} }, get: () => undefined,
    on: (name: string, fn: never) => { (handlers[name] ??= []).push(fn); return () => {} },
    sessions: { flush: async () => true } } as never, { activation: 'always' } as never)
  const agent = { session, steer: () => {}, ctx: { get: () => undefined,
    tools: { register: (definition: Record<string, unknown>) => { definitions.push(definition); return () => {} },
      guard: () => () => {}, get: () => undefined } } }
  for (const handler of handlers['agent/created'] ?? []) handler({ agent, source: 'startup' })
  expect(definitions.length).toBeGreaterThanOrEqual(10)
  const schemas = definitions.map(tool => ({ name: tool.name, cost: size({ name: tool.name,
    description: tool.description, parameters: tool.parameters, input: tool.input, output: tool.output }) }))
  const legacyEvidence = await createEvidenceTool().execute({ semantic_action: 'modify', evidence_role: 'effect' } as never, undefined as never)
  expect(JSON.stringify(legacyEvidence)).toContain('ordinary_evidence_migrated_to_host_facts')
  expect(JSON.stringify(legacyEvidence)).toContain('Do not repeat')
  const representative_tool_outputs = { legacy_evidence_migration: size(legacyEvidence) }
  const rows: unknown[] = []
  for (const language of ['en', 'zh']) {
    const root = language === 'en'
      ? 'Run the tests. Do not push main. Wait for my approval before publishing.'
      : '运行测试。禁止推送 main 分支。等我批准后再发布。'
    const { p } = fixture(Array.from({ length: 18 }, (_, i) => `${root} ${i}`).join('\n'))
    const prepare = createPrepareTool({ getProjection: () => p })
    const checkpoint = createCheckpointTool(() => p, async () => true)
    const discovery = await prepare.execute({} as never, undefined as never) as Record<string, unknown>
    const detail = await prepare.execute({ item_id: 'R001' } as never, undefined as never)
    const rejected = await prepare.execute({ item_id: 'missing' } as never, undefined as never)
    const closure = await checkpoint.execute({ bindings: [] } as never, undefined as never)
    const packet = renderRecoveryPacket(p)
    const sequence = [PROTOCOL_V6_NOTICE, firstStepGuidanceV6(), packet, discovery, detail, rejected,
      PROTOCOL_CORRECTION_NOTICE, closure, packet] // final packet models compaction/resume reinjection
    const output = sequence.map(size)
    // Explicit synthetic accounting: four model inputs replay all preceding
    // messages. Tool definitions recur in each input; cached usage is unknown.
    const schemaBytes = schemas.reduce((sum, row) => sum + row.cost.utf8_bytes, 0)
    expect(schemaBytes).toBeLessThanOrEqual(16600)
    const inputBytes = [3, 5, 8, 9].reduce((sum, count) => sum + schemaBytes
      + output.slice(0, count).reduce((n, row) => n + row.utf8_bytes, 0), 0)
    expect(inputBytes).toBeLessThanOrEqual(85000)
    rows.push({ language, tool_calls: 4, recovery_injections: 2, messages: output,
      output_utf8_bytes: output.reduce((sum, row) => sum + row.utf8_bytes, 0),
      replayed_input_utf8_bytes: inputBytes, schema_utf8_bytes: schemaBytes })
    expect(packet.length).toBeLessThanOrEqual(4000)
    expect(JSON.stringify(discovery)).toContain('items')
    expect(JSON.stringify(rejected)).toContain('item_not_found')
    expect(recoveryDigest(packet, p)).toBe(recoveryDigest(packet, p))
  }
  if (process.env.DSH_CONTEXT_COST === '1') console.log(`DSH_CONTEXT_COST=${JSON.stringify({
    classification: 'synthetic_character_utf8_proxy', actual_model_usage: null,
    tokenizer: null, cached_input_usage: null, uncached_input_usage: null, schemas, representative_tool_outputs, tasks: rows,
    first_guidance: size(firstStepGuidanceV6()), strict_guidance: size(firstStepGuidanceV6('strict')),
    boundary: size(PROTOCOL_V6_NOTICE), correction: size(PROTOCOL_CORRECTION_NOTICE) })}`)
})

it('guidance preserves ordinary execution, certification, history, Goal and release boundaries', () => {
  const standard = firstStepGuidanceV6()
  for (const fact of ['host', 'persisted', 'independent readback', 'context_guard_checkpoint', 'historical',
    'authorize', 'certif', '/context-guard on', 'adopt', 'release']) expect(standard).toContain(fact)
  expect(firstStepGuidanceV6('strict')).toMatch(/visual.*complete-scope.*real readback/)
  expect(standard.length).toBeLessThanOrEqual(450)
  expect(firstStepGuidanceV6('strict').length).toBeLessThanOrEqual(520)
})
