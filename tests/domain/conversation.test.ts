import { describe, expect, it } from 'vitest'
import { classifyUserInteraction, deriveProjection } from '../../src/domain/index.js'

const OPT_IN = { activation: 'opt-in' as const }

function deriveMessages(messages: string[]) {
  const events = [
    { seq: 0, type: 'command/run', data: { commandId: 'c0', name: 'context-guard', args: 'on', source: { kind: 'user' } } },
    ...messages.map((text, index) => ({ seq: index + 1, type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind: 'user' } } })),
  ]
  return deriveProjection(events, OPT_IN, { cwd: '/work' }, true)
}

describe('conversation capture filter (v0.2.1)', () => {
  it('classifies real-session progression, meta questions, and meta comments as conversational', () => {
    const conversational = [
      '继续',
      '继续执行',
      '好的',
      '收到',
      '这个收尾具体要做什么',
      '好像没成功，你确认下是不是bug： @认证',
      '不是，要么你给我做了，要么你告诉我怎么做。你啥都不干，你光给我说这，这有什么意义呢？',
      'DSA 本身没有这种跨会话记忆能力，所以我建议你重新考虑一下：这个功能是必要且合理的吗？',
      '继续执行。0.2.0确实没有release，只是tag了：https://github.com/GreenLv/dsh-context-guard/releases/tag/v0.2.0',
    ]
    for (const text of conversational) {
      expect(classifyUserInteraction(text), text).toBe('conversational')
    }
  })

  it('keeps real instructions, prohibitions, and task titles as instruction', () => {
    const instructions = [
      '按你的建议执行修改，并完善其他收尾性操作。权限我给你开了',
      '请修改 src/a.ts',
      '运行 pnpm test',
      '不要推送',
      '完成发布收尾与 Windows 验收',
      // Existing capture behavior must be unaffected.
      '验收：确认项目测试通过',
      '使用 bash 创建 guard-demo.txt',
      'verify the generated file src/app.ts',
      'Don\'t touch the API',
    ]
    for (const text of instructions) {
      expect(classifyUserInteraction(text), text).toBe('instruction')
    }
  })

  it('fails closed for featureless factual statements without a progression lead', () => {
    // The negated-fact remainder alone has no conversational trigger; only the
    // progression-led form (matrix row above) is dropped.
    expect(classifyUserInteraction('0.2.0确实没有release，只是tag了')).toBe('instruction')
  })

  it('scopes the operation-verb negation filter to the clause', () => {
    // 发布 is negated in its clause, so the question form stays conversational.
    expect(classifyUserInteraction('0.2.0确实没有发布，这个正常吗')).toBe('conversational')
    // The same verb outside the negated clause is a real task feature.
    expect(classifyUserInteraction('0.2.0确实没有发布，现在发布一下')).toBe('instruction')
  })

  it('does not count verbs inside progression phrases as task features', () => {
    expect(classifyUserInteraction('继续执行。请修改 src/a.ts')).toBe('instruction')
    expect(classifyUserInteraction('继续。0.2.0确实没有release，只是tag了')).toBe('conversational')
  })

  it('captures nothing from conversational messages but still captures later instructions', () => {
    const derived = deriveMessages([
      '继续',
      '这个收尾具体要做什么',
      '好像没成功，你确认下是不是bug： @认证',
    ])
    expect(derived.projection.items.size).toBe(0)

    const resumed = deriveMessages([
      '继续',
      '请修改 src/a.ts',
    ])
    const items = [...resumed.projection.items.values()]
    expect(items).toHaveLength(1)
    expect(items[0]?.verification.subject).toBe('/work/src/a.ts')
  })

  it('drops conversational clauses inside mixed messages and keeps the actionable ones', () => {
    const derived = deriveMessages(['好的。请修改 src/a.ts。'])
    const items = [...derived.projection.items.values()]
    expect(items).toHaveLength(1)
    expect(items[0]?.kind).toBe('requirement')
    expect(items[0]?.verification).toMatchObject({ subject: '/work/src/a.ts', surface: 'artifact' })
  })
})
