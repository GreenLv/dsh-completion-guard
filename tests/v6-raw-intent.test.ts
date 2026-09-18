import { describe, expect, it } from 'vitest'
import { replayRawV2 } from '../src/raw-replay.js'
import { createToolResultMessage } from '@deepseek-ai/dsh-llm'

type Row = Record<string, unknown>
const rows = (value: unknown): Row[] => Array.isArray(value) ? value as Row[] : []
const row = (value: unknown): Row => value && typeof value === 'object' ? value as Row : {}

describe('v6 current speech acts through the production Session and Stop path', () => {
  it.each([
    '解释安装流程，不执行安装。',
    '说明安装步骤，禁止安装。',
    '请解释怎样配置这项服务；本轮禁止运行配置命令。',
    'Explain the installation process, do not install the package.',
  ])('delivers a nominal explanation while retaining a prohibition: %s', async (root) => {
    const result = await replayRawV2({ root, final: 'The requested explanation is delivered here.' })
    const post = row(result.post_turn_core_projection)
    const reqs = rows(row(result.post_turn_core_snapshot).requirements)
    expect(reqs.some((req) => req.kind === 'information' && req.status === 'satisfied')).toBe(true)
    expect(reqs.some((req) => req.kind === 'constraint')).toBe(true)
    expect(Object.values(row(post.predicates))).toContain('constraint_active')
    expect(post.unknown_coverage).toEqual([])
    expect(post.coverage_errors).toEqual([])
    expect(post.certifiable).toBe(true)
    expect(result.stop).toBe('safe_yield_pending_preserved')
  })

  it('splits an ordered explanation from a relative-path correction without certifying an unobserved edit', async () => {
    const result = await replayRawV2({ root: '先说明原因，再修正 src/queue.ts 并核对文件内容。', final: '原因已经说明。' })
    const reqs = rows(row(result.post_turn_core_snapshot).requirements)
    const post = row(result.post_turn_core_projection)
    expect(reqs).toMatchObject([{ kind: 'information', status: 'satisfied' }, { kind: 'execution', action: 'modify', status: 'pending' }])
    expect(post.certifiable).toBe(false)
    expect(post.coverage_errors).toEqual([])
    expect(post.unknown_coverage).toEqual([])
  })

  it('keeps an error-log mention as context while the exact requested file and prohibition remain authoritative', async () => {
    const result = await replayRawV2({ root: '请只修改 packages/api/src/request.ts。错误日志还提到了 packages/web/src/request.ts，但本轮不要动后者。',
      final: '尚未修改指定文件。' })
    const reqs = rows(row(result.post_turn_core_snapshot).requirements)
    const post = row(result.post_turn_core_projection)
    expect(reqs.some((req) => req.kind === 'execution' && req.action === 'modify'
      && String(req.target).endsWith('/packages/api/src/request.ts'))).toBe(true)
    expect(reqs.filter((req) => req.action === 'reported_context').every((req) => req.required === false)).toBe(true)
    expect(reqs.some((req) => req.kind === 'constraint')).toBe(true)
    expect(post.certifiable).toBe(false)
    expect(post.current_actions).toEqual([])
  })

  it.each([
    ['修正解析器并执行针对这次改动的回归测试。', 'regression_test_result'],
    ['完成修复，并在本轮跑完对应的测试。', 'test_passed'],
  ])('keeps a correction and its specifically requested test distinct: %s', async (root, predicate) => {
    const result = await replayRawV2({ root, final: '修复已完成，测试尚未运行。' })
    const reqs = rows(row(result.post_turn_core_snapshot).requirements)
    expect(reqs).toMatchObject([{ kind: 'execution', action: 'modify' }, { kind: 'execution', action: 'test_verify', predicate }])
    expect(row(result.post_turn_core_projection).certifiable).toBe(false)
  })

  it.each([
    '解释方案并修改文件 A。',
    '说明设计并更新文件 A。',
    'Explain the plan and modify file A.',
    '解释方案。修改文件 A。',
  ])('keeps an independent edit open after delivering an explanation: %s', async (root) => {
    const result = await replayRawV2({ root, final: 'The plan has been explained.' })
    const reqs = rows(row(result.post_turn_core_snapshot).requirements)
    const post = row(result.post_turn_core_projection)
    expect(reqs.some((req) => req.kind === 'information' && req.status === 'satisfied')).toBe(true)
    expect(reqs.some((req) => req.kind === 'execution' && req.status === 'pending')).toBe(true)
    expect(post.certifiable).toBe(false)
    expect(rows(post.unmet_requirements).length).toBeGreaterThan(0)
  })

  it.each([
    '现在评估这次修改的效果并给出结果。',
    '立刻测量本次改动的吞吐收益。',
    'Please assess the effect of this change and report the result.',
  ])('keeps a present assessment as unfinished work without an invented fact: %s', async (root) => {
    const result = await replayRawV2({ root, final: 'There is no measured result yet.' })
    const reqs = rows(row(result.post_turn_core_snapshot).requirements)
    const post = row(result.post_turn_core_projection)
    expect(reqs).toContainEqual(expect.objectContaining({ kind: 'execution', action: 'evaluate_current_effect', status: 'pending' }))
    expect(post.predicates).toMatchObject({ R001: 'insufficient' })
    expect(post.current_actions).toEqual([])
    expect(post.certifiable).toBe(false)
  })

  it.each([
    '说明如何安装并重启服务。',
    'Explain how to install foo and restart service api.',
    '说明“修改文件 A”是什么意思。',
    '修复解析器是否会影响性能？',
    '修改 src/a.ts 会导致什么后果？',
  ])('does not promote a governed or quoted verb into an edit: %s', async (root) => {
    const result = await replayRawV2({ root, final: 'I can explain that.' })
    expect(rows(result.items).some((item) => item.disposition === 'executable_now')).toBe(false)
    expect(rows(row(result.post_turn_core_snapshot).requirements).some((req) => req.kind === 'execution')).toBe(false)
  })

  it.each([
    '收到批准后修复 src/a.ts。',
    '请等我确认后修改 src/a.ts。',
  ])('keeps an approval-governed edit conditional: %s', async (root) => {
    const result = await replayRawV2({ root, final: '当前仍待批准。' })
    expect(rows(result.items).some((item) => item.disposition === 'executable_now')).toBe(false)
    expect(row(result.post_turn_core_projection).current_actions).toEqual([])
  })

  it.each([
    '按既定计划执行本轮修复并运行测试。',
    'Please fix this issue and run the focused tests.',
    '完成修改和测试。',
  ])('retains an explicit test conjunct with its original root wording: %s', async (root) => {
    const result = await replayRawV2({ root, final: 'The requested test has not run.' })
    const reqs = rows(row(result.post_turn_core_snapshot).requirements)
    const post = row(result.post_turn_core_projection)
    expect(reqs.some((req) => req.kind === 'execution' && req.action === 'test_verify' && req.status === 'pending')).toBe(true)
    expect(post.current_actions).toEqual([])
    expect(post.certifiable).toBe(false)
    expect(post.coverage_errors).toEqual([])
    expect(post.unknown_coverage).toEqual([])
  })

  it.each([
    ['明天再评估这次修改的效果。', 'predicate'],
    ['收到我的确认后再评估这次修改的效果。', 'user_input'],
    ['After approval, assess the effect of this change.', 'user_input'],
  ])('does not let a ready manifest release a root condition: %s', async (root, conditionKind) => {
    const sha = 'a'.repeat(64)
    const callId = 'ready-conditional'
    const result = await replayRawV2({ root, final: 'Assessment has not run.', events: [
      { type: 'tool/call', data: { turn: 1, step: 1, callId, name: 'context_guard_observe_test_readiness', arguments: '{"item_id":"R001"}' } },
      { type: 'tool/result', data: { turn: 1, step: 1,
        message: createToolResultMessage({ callId: callId as never, content: [{ type: 'text', text: 'ready' }], isError: false }),
        meta: { contextGuardTestReadiness: { itemId: 'R001', scope: '/work', manifestSha256: sha,
          predicate: 'verification_passed', scriptName: 'test', selectedPath: '/work/package.json', effectCallId: '', inputSha256: sha } },
      } },
    ] })
    const snapshot = row(result.post_turn_core_snapshot)
    const post = row(result.post_turn_core_projection)
    expect(rows(snapshot.conditions).some((condition) => condition.kind === conditionKind && condition.status === 'pending')).toBe(true)
    expect(post.current_actions).toEqual([])
    expect(post.certifiable).toBe(false)
    expect(post.registered_external_operations).toEqual([])
  })
})
