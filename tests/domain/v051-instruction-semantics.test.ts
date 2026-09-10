import { describe, expect, it } from 'vitest'
import {
  interpretClause,
  interpretMessage,
  isExecutableItem,
  isOpenObligation,
  maskCodeSpans,
} from '../../src/domain/semantics.js'
import { deriveProjection, PROTOCOL_V4_NOTICE } from '../../src/domain/derive.js'
import type { DerivedEnvelope, GuardItem } from '../../src/domain/types.js'

/**
 * F01–F04, F08, F12: one message, one interpretation.
 *
 * The 0.5.1 acceptance review found that capture, action authorization and
 * boundary qualification each guessed the meaning of the same sentence. These
 * cases pin the shared interpretation instead: scope before action, polarity
 * before keyword, and an explicit executee before any execution authority.
 *
 * The assertions are deliberately about the DERIVED CONTRACT, not about a regex
 * result, so a synonym, a word-order change or a punctuation change must produce
 * the same interpretation.
 */

const config = { activation: 'always' as const }
const scope = { cwd: '/workspace' }

function replay(texts: string[], cwd = '/workspace') {
  const events: DerivedEnvelope[] = [
    { seq: 0, type: 'user/message', data: { source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text: PROTOCOL_V4_NOTICE }] } },
    ...texts.map((text, index): DerivedEnvelope => ({
      seq: index + 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
    })),
  ]
  return deriveProjection(events, config, { ...scope, cwd }, true).projection
}

const items = (texts: string[], cwd?: string): GuardItem[] => [...replay(texts, cwd).items.values()]
const obligations = (texts: string[]): GuardItem[] => items(texts).filter(isOpenObligation)

describe('v0.5.1 unified instruction interpretation', () => {
  describe('F01 — negation scope', () => {
    it('keeps the positive task and turns the coordinated negation into a constraint', () => {
      const derived = items(['修复代码，但不推送。'])
      const requirement = derived.find((item) => item.kind === 'requirement')
      const prohibition = derived.find((item) => item.kind === 'prohibition')
      expect(requirement?.semanticAction).not.toBe('push')
      expect(prohibition).toBeDefined()
      // The prohibition constrains execution; it is never an obligation to push.
      expect(prohibition!.semanticAction).toBe('push')
      expect(isOpenObligation(prohibition!)).toBe(false)
      expect(obligations(['修复代码，但不推送。']).map((item) => item.semanticAction)).not.toContain('push')
    })

    it('captures a bare coordinated negation as prohibitions only', () => {
      const derived = items(['不推送、不发布。'])
      expect(derived.every((item) => item.kind === 'prohibition')).toBe(true)
      expect(derived.map((item) => item.semanticAction).sort()).toEqual(['publish', 'push'])
      expect(obligations(['不推送、不发布。'])).toHaveLength(0)
    })

    it('holds for English, mid-sentence and mixed-language negations alike', () => {
      for (const text of [
        'Fix the code but do not push.',
        'Update the README; 不要推送。',
        '修改 src/a.ts，并且不要 publish 这个包。',
        'Fix the code, never push it.',
        'Refactor the parser and do not commit or push.',
      ]) {
        const derived = items([text])
        expect(derived.some((item) => item.kind === 'prohibition'), text).toBe(true)
        expect(obligations([text]).some((item) => item.semanticAction === 'push'), text).toBe(false)
      }
    })

    it('does not read the exact incident sentence as a push obligation', () => {
      const text = '按 P0—P4 完成本地实现、测试和文档，在跨平台验证前停止，不推送、不正式发布。'
      const derived = items([text])
      expect(derived.some((item) => item.kind === 'prohibition' && item.semanticAction === 'push')).toBe(true)
      expect(derived.some((item) => item.kind === 'prohibition' && item.semanticAction === 'publish')).toBe(true)
      expect(obligations([text]).some((item) => item.semanticAction === 'push' || item.semanticAction === 'publish')).toBe(false)
      // The local work itself is still a live obligation.
      expect(obligations([text]).length).toBeGreaterThan(0)
    })

    it('keeps a genuine positive push authorized (the F12 control)', () => {
      const derived = items(['Push repository repo-alpha to remote origin refspec refs/heads/main:refs/heads/main.'])
      const obligation = obligations(['Push repository repo-alpha to remote origin refspec refs/heads/main:refs/heads/main.'])
      expect(derived.some((item) => item.kind === 'prohibition')).toBe(false)
      expect(obligation.map((item) => item.semanticAction)).toEqual(['push'])
    })
  })

  describe('F02 — executee and command generation', () => {
    it('does not turn a user-performed action into an agent obligation', () => {
      const derived = items(['由我手动重启；收到我的明确回报后再继续。'])
      const restart = derived.find((item) => item.semanticAction === 'restart')
      expect(restart?.executee).toBe('user')
      expect(restart?.authorityDisposition).toBe('human_actor')
      expect(isOpenObligation(restart!)).toBe(false)
      expect(obligations(['由我手动重启；收到我的明确回报后再继续。'])).toHaveLength(0)
    })

    it('generating a command is not running it', () => {
      const text = '给我一条手动重启 DSH 的命令，我自己执行。'
      const derived = items([text])
      const restart = derived.find((item) => item.semanticAction === 'restart')
      // The restart is named, but the request is for the command text.
      expect(restart === undefined || isOpenObligation(restart)).toBe(false)
      expect(obligations([text]).some((item) => item.semanticAction === 'restart')).toBe(false)
    })

    it('keeps both executees of a mixed sentence and their order', () => {
      const text = '由你升级 Skin Center，由我手动重启 Web。'
      const derived = items([text])
      const agent = derived.find((item) => item.executee === 'agent')
      const user = derived.find((item) => item.executee === 'user')
      expect(agent).toBeDefined()
      expect(user).toBeDefined()
      expect(user!.semanticAction).toBe('restart')
      expect(isOpenObligation(user!)).toBe(false)
      // The agent half stays executable work.
      expect(isOpenObligation(agent!)).toBe(true)
    })
  })

  describe('F03 — conditions and factual narration', () => {
    it('does not execute a conditional action before its condition holds', () => {
      for (const text of [
        '先测试；若我之后确认才推送。',
        'Run the tests; push only after I confirm.',
        '除非我明确说可以，否则不要合并。',
        '如果测试全绿，就发布 0.5.1。',
      ]) {
        const conditional = items([text]).find((item) => item.authorityDisposition === 'conditional_wait')
        expect(conditional, text).toBeDefined()
        expect(isOpenObligation(conditional!), text).toBe(false)
      }
    })

    it('never upgrades narration into authorization', () => {
      const derived = items(['我刚才已经推送过了，测试也跑完了。'])
      expect(obligations(['我刚才已经推送过了，测试也跑完了。'])).toHaveLength(0)
    })
  })

  describe('F04 — quotation, code and explanation', () => {
    it('does not authorize an action merely named inside backticks', () => {
      const text = '日志里写着 `git push origin main`，请解释这行是什么意思。'
      expect(obligations([text]).some((item) => item.semanticAction === 'push')).toBe(false)
    })

    it('explaining a command is not executing it', () => {
      for (const text of ['解释 git push 的作用，不执行。', 'Explain what `pnpm publish` does.']) {
        const derived = items([text])
        expect(derived.some((item) => item.authorityDisposition === 'informational'), text).toBe(true)
        expect(obligations([text]).some((item) => item.semanticAction === 'push' || item.semanticAction === 'publish'), text).toBe(false)
      }
    })

    it('masks code spans without moving any source offset', () => {
      const text = 'run `git push` now'
      const masked = maskCodeSpans(text)
      expect(masked).toHaveLength(text.length)
      expect(masked).not.toContain('push')
      expect(masked.indexOf('now')).toBe(text.indexOf('now'))
    })
  })

  describe('F08 — the wait authorization is derived from the source message', () => {
    it('mints a replayable wait qualification for a genuine user wait', () => {
      const projection = replay(['由我手动重启；收到我的明确回报后再继续。'])
      const waits = [...projection.items.values()].filter((item) => item.waitAuthorization)
      expect(waits.length).toBeGreaterThan(0)
      expect(waits.every((item) => item.waitAuthorization!.kind === 'root_explicit_wait')).toBe(true)
      // Stable across a replay of the same bytes.
      const again = replay(['由我手动重启；收到我的明确回报后再继续。'])
      expect([...again.items.values()].filter((item) => item.waitAuthorization).map((item) => item.waitAuthorization!.id))
        .toEqual(waits.map((item) => item.waitAuthorization!.id))
    })

    it('does not mint a wait qualification from a quoted or logged sentence', () => {
      const projection = replay(['> 由我手动重启；收到我的明确回报后再继续。'])
      expect([...projection.items.values()].some((item) => item.waitAuthorization)).toBe(false)
    })
  })

  describe('F12 — metamorphic equivalence and no-regression', () => {
    it('reaches the same interpretation for synonym, order and punctuation variants', () => {
      const variants = [
        '修复代码，但是不要推送。',
        '修复代码，不要推送。',
        '修复代码，但请勿推送。',
        'Fix the code, but don\'t push.',
      ]
      for (const text of variants) {
        const derived = items([text])
        expect(derived.some((item) => item.kind === 'prohibition' && item.semanticAction === 'push'), text).toBe(true)
        expect(obligations([text]).some((item) => item.semanticAction === 'push'), text).toBe(false)
        expect(obligations([text]).some((item) => item.kind === 'requirement'), text).toBe(true)
      }
    })

    it('keeps ordinary positive instructions executable', () => {
      for (const text of [
        '修改 guard-demo.txt',
        '更新 README 并运行 pnpm test。',
        'Publish package @acme/pkg version 2.0.0 to registry https://registry.example/.',
      ]) {
        expect(obligations([text]).length, text).toBeGreaterThan(0)
      }
    })

    it('is stable across replay of identical bytes', () => {
      const text = '修复代码，但不推送；由我手动重启。'
      const first = items([text]).map((item) => `${item.kind}|${item.semanticAction}|${item.executee}|${item.authorityDisposition}`)
      const second = items([text]).map((item) => `${item.kind}|${item.semanticAction}|${item.executee}|${item.authorityDisposition}`)
      expect(second).toEqual(first)
    })
  })

  describe('the interpreter itself', () => {
    it('never classifies a prohibition as immediately executable', () => {
      for (const text of ['不推送', 'do not push', '不要发布', 'never commit']) {
        const interpretation = interpretClause(text)
        expect(interpretation.directive, text).toBe('prohibition')
        expect(interpretation.immediatelyExecutable, text).toBe(false)
      }
    })

    it('treats an unmarked imperative as agent work and a user-marked one as human', () => {
      expect(interpretClause('更新 README').executee).toBe('agent')
      expect(interpretClause('由我更新 README').executee).toBe('user')
    })

    it('splits a message into independently interpreted scopes', () => {
      const scopes = interpretMessage('修复代码，但不推送。')
      expect(scopes.map((entry) => entry.directive)).toContain('prohibition')
      expect(scopes.map((entry) => entry.directive)).toContain('directive')
    })

    it('keeps an unresolved interpretation conservative rather than executable', () => {
      const interpretation = interpretClause('看看怎么弄')
      expect(interpretation.directive).toBe('informational')
      expect(interpretation.immediatelyExecutable).toBe(false)
    })
  })

  describe('executability gates the derived contract', () => {
    it('reports a non-executable item as not an open obligation', () => {
      const item = items(['由我手动重启。']).find((entry) => entry.semanticAction === 'restart')!
      expect(item.executee).toBe('user')
      expect(isExecutableItem(item)).toBe(false)
      expect(isOpenObligation(item)).toBe(false)
    })

    it('leaves legacy items without an interpretation executable', () => {
      const legacy: GuardItem = {
        id: 'R001', revision: 1, kind: 'requirement', sourceMessageId: 'm1',
        normalizedText: 'ship the artifact', textSha256: 'a'.repeat(64), status: 'pending',
        verification: { enforced: true, surface: 'scope', subject: 'scope' },
      }
      expect(isExecutableItem(legacy)).toBe(true)
      expect(isOpenObligation(legacy)).toBe(true)
    })
  })
})
