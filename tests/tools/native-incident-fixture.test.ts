import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { deriveProjection, PROTOCOL_V6_NOTICE } from '../../src/domain/derive.js'
import type { DerivedEnvelope } from '../../src/domain/types.js'

const fixture = await import(new URL('../../scripts/native_incident_fixture_v070.mjs', import.meta.url).href)
const terminal = { kind: 'foreground', exit_code: 0, timed_out: false, aborted: false }
const configFor = (root: string) => {
  const workRoot = join(root, 'work')
  mkdirSync(workRoot, { recursive: true })
  return { workRoot, nonce: 'unit', incidentOutput: join(root, 'evidence') }
}

// Deliberately a unit host double. Actual AgentRegistry, pwsh and persistence
// coverage is supplied only by the later exact-artifact native invocation.
function unitHost() {
  let current = ''
  let call = 0
  const states = new Map<string, { head: string; index: string; remote: string | null }>()
  const views = new Map<string, { items: Map<string, unknown>; rebindProposals: Map<string, unknown>; evidence: Map<string, unknown> }>()
  const effects = new Map<string, string>()
  const commands: string[] = []
  const api = {
    corruptRestore: false, shellError: false, observedReason: '', commands,
    async open(label: string) {
      current = label
      views.set(current, { items: new Map(), rebindProposals: new Map(), evidence: new Map() })
    },
    async reopen(label: string) {
      current = label
      if (api.corruptRestore) views.get(current)!.items.clear()
    },
    async root(_text: string) {},
    async legacyRoots(texts: string[]) {
      texts.forEach((text, i) => views.get(current)!.items.set('old-' + i, {
        id: 'old-' + i, revision: 1, semanticAction: 'modify', status: 'pending',
        authority: 'root_instruction', sourceMessageId: 'm' + i, requestedTarget: { path: text },
      }))
    },
    projection: () => views.get(current),
    boundary: () => ({ reason: current.includes('old_') ? 'pending_without_action_basis' : 'no_pending_work' }),
    createGitFixture(_parent: string, label: string) {
      const state = { head: 'a'.repeat(40), index: 'c'.repeat(40), remote: null as string | null }
      states.set('archive043-' + label, state)
      return { work: '/owned/' + label, snapshot: () => ({ ...state }) }
    },
    shellFacts: () => terminal,
    async shell(command: string, _work: string) {
      commands.push(command)
      const state = states.get(current)!
      if (command.includes('commit')) state.head = 'b'.repeat(40)
      if (command.includes('push')) state.remote = state.head
      const callId = 'call-' + ++call
      effects.set(callId, command)
      return { callId, value: terminal, result: { isError: api.shellError, content: [] } }
    },
    async tool(name: string, args: { effect_call_id?: string }) {
      if (name === 'context_guard_checkpoint') return { value: { status: 'incomplete', open_items: [] } }
      if (name === 'context_guard_action') return { value: { status: 'unavailable', reason_code: 'ordinary_action_migrated_to_host_tools' } }
      const command = effects.get(args.effect_call_id ?? '')
      if (!command) return { value: { status: 'unavailable', reason_code: 'native_effect_missing' } }
      if (command.includes(';')) return { value: { status: 'unavailable', reason_code: 'native_git_command_unsupported' } }
      const action = command.includes('commit') ? 'commit' : 'push'
      const state = states.get(current)!
      views.get(current)!.evidence.set(args.effect_call_id!, { id: args.effect_call_id,
        callId: args.effect_call_id, semanticAction: action, outcome: 'success', parseStatus: 'supported' })
      return { value: { status: 'observed', reason_code: api.observedReason || 'git_' + action + '_observed',
        post_oid: action === 'commit' ? state.head : state.remote } }
    },
  }
  return api
}

async function isolated(run: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'dcg-incident-unit-'))
  try { await run(root) } finally { rmSync(root, { recursive: true, force: true }) }
}

describe('native incident producer controls (unit doubles, not native acceptance)', () => {
  it('refuses absent, relative and disposable-tree evidence outputs before any Git fixture', async () => isolated(async root => {
    const config = configFor(root)
    for (const output of [undefined, 'relative', join(config.workRoot, 'discarded')]) {
      await expect(fixture.runGitIncident(unitHost(), { ...config, incidentOutput: output })).rejects.toThrow()
    }
  }))
  it('preserves the compound refusal, independent real-effect facts and a hashed durable journal', async () => isolated(async root => {
    const api = unitHost(), result = await fixture.runGitIncident(api, configFor(root))
    fixture.assertIncidentSummary(result, 'archive043')
    expect(api.commands).toHaveLength(3)
    expect(result).toMatchObject({ compound_reason: 'native_git_command_unsupported', commit_reason: 'git_commit_observed',
      push_reason: 'git_push_observed', refs_verified: true, persisted_reopen: true })
    const bytes = readFileSync(join(root, 'evidence.archive043.jsonl'))
    expect(result.evidence_sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    const journal = bytes.toString().trim().split('\n').map(line => JSON.parse(line))
    expect(journal.filter(row => row.stage.endsWith('_restored'))).toHaveLength(2)
    expect(journal.at(-1)).toMatchObject({ stage: 'complete', status: 'passed' })
  }))

  it.each(['shell_error', 'wrong_observer'])('retains partial failure evidence for %s and never rewrites it to success', async mode => isolated(async root => {
    const api = unitHost()
    api.shellError = mode === 'shell_error'; api.observedReason = mode === 'wrong_observer' ? 'native_effect_failed' : ''
    await expect(fixture.runGitIncident(api, configFor(root))).rejects.toThrow()
    const journal = readFileSync(join(root, 'evidence.archive043.jsonl'), 'utf8')
    expect(journal).toContain('compound_shell')
    expect(JSON.parse(journal.trim().split('\n').at(-1)!)).toMatchObject({ stage: 'failure', status: 'failed' })
    expect(journal).not.toContain('"stage":"complete"')
    await expect(fixture.runGitIncident(unitHost(), configFor(root))).rejects.toThrow()
    expect(readFileSync(join(root, 'evidence.archive043.jsonl'), 'utf8')).toBe(journal)
  }))

  it('covers both old-state and fresh control pairs with a fixed follow-up and official reopen assertions', async () => isolated(async root => {
    const result = await fixture.runFollowupIncident(unitHost(), configFor(root))
    fixture.assertIncidentSummary(result, 'archive044')
    expect(result.scenes.map((row: { pending_before: number }) => row.pending_before)).toEqual([2, 2, 0, 0])
    const journal = readFileSync(join(root, 'evidence.archive044.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    const restored = journal.filter(row => row.stage.endsWith('_restored'))
    expect(restored.map(row => row.followup)).toEqual(Array(4).fill(fixture.FOLLOWUP))
    expect(restored.map(row => row.clarification)).toEqual([null, fixture.CLARIFICATION, null, fixture.CLARIFICATION])
  }))

  it('fails closed on lost old-state roots after reopen and retains the mismatch', async () => isolated(async root => {
    const api = unitHost(); api.corruptRestore = true
    await expect(fixture.runFollowupIncident(api, configFor(root))).rejects.toThrow(/reopen/)
    const rows = readFileSync(join(root, 'evidence.archive044.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(rows.at(-2).after.items).toHaveLength(2)
    expect(rows.at(-2).restored.items).toHaveLength(0)
    expect(rows.at(-1).status).toBe('failed')
  }))

  it('keeps both reconstructed roots with the production projection across the fixed follow-up pair', () => {
    for (const clarified of [false, true]) {
      let seq = 0
      const events: DerivedEnvelope[] = []
      const user = (text: string, source: object = { kind: 'user' }) => events.push({ seq: seq++, type: 'user/message',
        data: { source, content: [{ type: 'text', text }] } })
      user('Modify /fixture/archive044-alpha.txt.')
      user('Modify /fixture/archive044-beta.txt.')
      const scope = { cwd: '/fixture', sessionHeader: { version: 4, id: 'incident-unit', createdAt: 1 } }
      const project = () => deriveProjection(events, { activation: 'always' }, scope, true).projection
      const before = fixture.projectionFacts(project())
      expect(before.items.filter((row: { action: string; status: string }) => row.action === 'modify' && row.status === 'pending')).toHaveLength(2)
      user(PROTOCOL_V6_NOTICE, { kind: 'context-guard', plugin: 'context-guard', form: 'notice' })
      if (clarified) user(fixture.CLARIFICATION)
      user(fixture.FOLLOWUP)
      const after = fixture.projectionFacts(project())
      expect(after.items.filter((row: { action: string; status: string }) => row.action === 'modify' && row.status === 'pending')).toHaveLength(2)
      expect(after.pending_rebinds).toEqual(before.pending_rebinds)
    }
  })

  it('flushes timeout failures, closes the journal handle and refuses overwrite', async () => isolated(async root => {
    const path = join(root, 'journal')
    await expect(fixture.incidentJournal(path, async (record: (label: string, facts: object) => void) => {
      record('effect_started', { status: 'started' })
      throw Object.assign(new Error('private path must not enter error field'), { code: 'PROBE_OPERATION_TIMEOUT' })
    })).rejects.toThrow()
    const text = readFileSync(path, 'utf8')
    expect(text).toContain('PROBE_OPERATION_TIMEOUT')
    expect(text).not.toContain('private path')
    await expect(fixture.incidentJournal(path, async () => ({}))).rejects.toThrow()
    expect(readFileSync(path, 'utf8')).toBe(text)
    // Windows removal in isolated() also proves the owned descriptor closed.
  }))

  it('creates only local Git fixtures and refuses a changed origin before further observation', async () => isolated(async root => {
    const git = fixture.createGitFixture(root, 'independent')
    expect(git.snapshot()).toMatchObject({ head: expect.stringMatching(/^[a-f0-9]{40,64}$/), remote: null })
    execFileSync('git', ['remote', 'set-url', 'origin', 'https://example.invalid/not-owned'], { cwd: git.work })
    expect(() => git.snapshot()).toThrow(/local remote drift/)
  }))

  it('selects scoped ext on Windows, local path elsewhere, and refuses drift', async () => isolated(async root => {
    const parent = join(root, 'space % fixture')
    mkdirSync(parent)
    const git = fixture.createIncidentGitFixture(parent, 'independent', 'win32')
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: git.work, encoding: 'utf8' }).trim()
    expect(url).toContain('space% %%% fixture')
    expect(git.snapshot().remote).toBeNull()
    execFileSync('git', ['remote', 'set-url', 'origin', 'https://example.invalid/not-owned'], { cwd: git.work })
    expect(() => git.snapshot()).toThrow(/ext remote drift/)
    execFileSync('git', ['remote', 'set-url', 'origin', url], { cwd: git.work })
    execFileSync('git', ['config', '--local', '--add', 'protocol.ext.allow', 'never'], { cwd: git.work })
    expect(() => git.snapshot()).toThrow(/ext policy drift/)
    const local = fixture.createIncidentGitFixture(parent, 'compound', 'darwin')
    expect(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: local.work, encoding: 'utf8' }).trim()).toBe(local.remote)
    expect(local.snapshot().remote).toBeNull()
  }), 15000)
})
