/** Current-contract analogues of archive043/044, not verbatim historical replays.
 * Loaded by the real no-model host probe. Never contacts a public Git remote. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { openSync, closeSync, writeSync, fsyncSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

export const INCIDENT_CASES = {
  v070_archive043_git_chain: 'archive043',
  v070_archive044_pending_followup: 'archive044',
}
export const FOLLOWUP = 'Explain the current isolated fixture status without changing files.'
export const CLARIFICATION = 'For this follow-up, only explain the status. Keep the earlier tasks pending.'
const SCENES = ['old_unclarified', 'old_clarified', 'fresh_unclarified', 'fresh_clarified']

export function incidentPath(config, kind) {
  assert.ok(typeof config.incidentOutput === 'string' && isAbsolute(config.incidentOutput), 'external incident output is required')
  assert.ok(['archive043', 'archive044'].includes(kind))
  const path = config.incidentOutput + '.' + kind + '.jsonl'
  const contained = relative(resolve(config.workRoot), resolve(path))
  assert.ok(isAbsolute(contained) || contained === '..' || contained.startsWith('..\\') || contained.startsWith('../'),
    'incident evidence must be outside the disposable work tree')
  return path
}

/** The caller owns session/process disposal and the outer fixture. Journals live
 * outside that disposable tree, including on failure; never retry over a file. */
export async function incidentJournal(path, run) {
  const fd = openSync(path, 'wx', 0o600)
  let stage = 'start'
  const record = (label, value) => {
    assert.match(label, /^[a-z0-9_]+$/)
    stage = label
    writeSync(fd, JSON.stringify({ stage, ...value }) + '\n')
    fsyncSync(fd)
  }
  try {
    record('start', { input_boundary: 'current_contract_analogue', historical_input_complete: false })
    const facts = await run(record)
    record('complete', { status: 'passed' })
    return { ...facts, schema: 'dsh-native-incident-summary/v1', input_boundary: 'current_contract_analogue',
      evidence_sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }
  } catch (error) {
    record('failure', { status: 'failed', failed_stage: stage,
      error_code: /^[A-Z_]{1,60}$/.test(error?.code ?? '') ? error.code : 'INCIDENT_ASSERTION_FAILED' })
    throw error
  } finally { closeSync(fd) }
}

export function projectionFacts(view) {
  const items = [...view.items.values()].map(item => ({ id: item.id, revision: item.revision,
    action: item.semanticAction ?? null, status: item.status, authority: item.authority,
    source: item.sourceMessageId, target: item.requestedTarget ?? null,
    capture: item.targetCaptureStatus ?? null })).sort((a, b) => a.id.localeCompare(b.id))
  return { items, pending_rebinds: [...view.rebindProposals.values()].filter(row => row.status === 'pending').map(row => row.id).sort(),
    evidence: [...(view.evidence?.values() ?? [])].map(row => ({ id: row.id, call_id: row.callId,
      action: row.semanticAction ?? null, outcome: row.outcome, parse_status: row.parseStatus })).sort((a, b) => a.id.localeCompare(b.id)) }
}

export function assertRestored(before, after) { assert.deepEqual(after, before, 'official reopen changed the durable projection') }
export function assertReason(value, status, reason) {
  assert.equal(value?.status, status)
  assert.equal(value?.reason_code, reason)
}
export function assertForeground(result, facts) {
  assert.equal(result.result.isError, false, 'host shell failed; this is not a Guard refusal')
  assert.deepEqual(facts(result.value), { kind: 'foreground', exit_code: 0, timed_out: false, aborted: false })
}

/** Only normal repositories under the caller-owned fixture can be mutated. */
export function createGitFixture(parent, label) {
  assert.match(label, /^(?:compound|independent)$/)
  const scene = join(parent, label)
  mkdirSync(scene)
  const work = join(scene, 'work'), remote = join(scene, 'remote.git')
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8',
    timeout: 15000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git(scene, 'init', '--bare', '--initial-branch=main', remote)
  git(scene, 'init', '--initial-branch=main', work)
  const hooks = join(scene, 'empty-hooks')
  mkdirSync(hooks)
  git(scene, '--git-dir', remote, 'config', '--local', 'core.hooksPath', hooks)
  for (const [key, value] of [['user.name', 'Native Fixture'], ['user.email', 'fixture@example.invalid'],
    ['commit.gpgsign', 'false'], ['core.autocrlf', 'false'], ['core.hooksPath', hooks]]) git(work, 'config', '--local', key, value)
  git(work, 'remote', 'add', 'origin', remote)
  writeFileSync(join(work, 'fixture.txt'), 'initial\n')
  git(work, 'add', 'fixture.txt'); git(work, 'commit', '-m', 'initial')
  writeFileSync(join(work, 'fixture.txt'), 'updated\n'); git(work, 'add', 'fixture.txt')
  const snapshot = () => {
    assert.equal(resolve(git(work, 'remote', 'get-url', 'origin')), resolve(remote), 'local remote drift')
    return { head: git(work, 'rev-parse', 'HEAD'), index: git(work, 'write-tree'),
      branch: git(work, 'symbolic-ref', '--short', 'HEAD'),
      remote: git(scene, '--git-dir', remote, 'for-each-ref', '--format=%(objectname)', 'refs/heads/main') || null }
  }
  return { work, remote, snapshot }
}

/** Local-only native Git service; permission is scoped to this fixture repo. */
export function createGitExtFixture(parent, label) {
  const fixture = createGitFixture(parent, label)
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8',
    timeout: 15000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const remotePath = fixture.remote.replaceAll('\\', '/')
  assert.ok(isAbsolute(fixture.remote) && !/[\r\n\t]/.test(remotePath))
  const url = `ext::git %s ${remotePath.replaceAll('%', '%%').replaceAll(' ', '% ')}`
  git(fixture.work, 'config', '--local', 'protocol.ext.allow', 'always')
  git(fixture.work, 'remote', 'set-url', 'origin', url)
  const snapshot = () => {
    assert.equal(git(fixture.work, 'remote', 'get-url', 'origin'), url, 'ext remote drift')
    assert.equal(git(fixture.work, 'config', '--local', '--get-all', 'protocol.ext.allow'), 'always', 'ext policy drift')
    return { head: git(fixture.work, 'rev-parse', 'HEAD'), index: git(fixture.work, 'write-tree'),
      branch: git(fixture.work, 'symbolic-ref', '--short', 'HEAD'),
      remote: git(parent, '--git-dir', fixture.remote, 'for-each-ref', '--format=%(objectname)', 'refs/heads/main') || null }
  }
  return { ...fixture, snapshot }
}

export function createIncidentGitFixture(parent, label, platform = process.platform) {
  return platform === 'win32' ? createGitExtFixture(parent, label) : createGitFixture(parent, label)
}

export async function runGitIncident(api, config) {
  const output = incidentPath(config, 'archive043')
  const parent = join(config.workRoot, 'archive043-' + config.nonce)
  mkdirSync(parent)
  return incidentJournal(output, async record => {
    const facts = { case: 'archive043', compound_reason: '', commit_reason: '', push_reason: '',
      ordinary_action_reason: '', missing_effect_reason: '', refs_verified: false, persisted_reopen: false }
    for (const label of ['compound', 'independent']) {
      const fixture = (api.createGitFixture ?? createIncidentGitFixture)(parent, label)
      const session = 'archive043-' + label
      await api.open(session)
      const authorization = `Commit changes in repository ${fixture.work}. Push repository ${fixture.work} remote origin refspec refs/heads/main:refs/heads/main.`
      await api.root(authorization)
      const initial = fixture.snapshot()
      record(label + '_root', { authorization, remote: fixture.remote, initial, projection: projectionFacts(api.projection()) })
      const migrated = (await api.tool('context_guard_action', { semantic_action: 'commit',
        resolution_call_id: 'absent-ordinary', target_digest: '0'.repeat(64),
        contract_item_id: 'ordinary-host-action', contract_item_revision: 1 })).value
      record(label + '_migration', { result: migrated })
      assertReason(migrated, 'unavailable', 'ordinary_action_migrated_to_host_tools')
      facts.ordinary_action_reason = migrated.reason_code
      const missing = (await api.tool('context_guard_observe_git', { effect_call_id: 'never-existed' })).value
      record(label + '_missing', { result: missing })
      assertReason(missing, 'unavailable', 'native_effect_missing')
      facts.missing_effect_reason = missing.reason_code
      if (label === 'compound') {
        const effect = await api.shell('git commit -m native-compound; git push origin refs/heads/main:refs/heads/main', fixture.work)
        record('compound_shell', { call_id: effect.callId, result: effect.result, state: fixture.snapshot() })
        assertForeground(effect, api.shellFacts)
        const observed = (await api.tool('context_guard_observe_git', { effect_call_id: effect.callId })).value
        record('compound_observer', { result: observed })
        assertReason(observed, 'unavailable', 'native_git_command_unsupported')
        facts.compound_reason = observed.reason_code
      } else {
        const committed = await api.shell('git commit -m native-independent', fixture.work)
        record('independent_commit_shell', { call_id: committed.callId, result: committed.result, state: fixture.snapshot() })
        assertForeground(committed, api.shellFacts)
        const commit = (await api.tool('context_guard_observe_git', { effect_call_id: committed.callId })).value
        record('independent_commit_observer', { result: commit })
        assertReason(commit, 'observed', 'git_commit_observed')
        assert.equal(commit.post_oid, fixture.snapshot().head)
        facts.commit_reason = commit.reason_code
        const pushed = await api.shell('git push origin refs/heads/main:refs/heads/main', fixture.work)
        record('independent_push_shell', { call_id: pushed.callId, result: pushed.result, state: fixture.snapshot() })
        assertForeground(pushed, api.shellFacts)
        const push = (await api.tool('context_guard_observe_git', { effect_call_id: pushed.callId })).value
        record('independent_push_observer', { result: push })
        assertReason(push, 'observed', 'git_push_observed')
        assert.equal(push.post_oid, fixture.snapshot().remote)
        facts.push_reason = push.reason_code
      }
      const final = fixture.snapshot()
      assert.notEqual(final.head, initial.head)
      assert.equal(final.remote, final.head)
      assert.equal(final.index, initial.index)
      const before = projectionFacts(api.projection())
      await api.reopen(session)
      const after = projectionFacts(api.projection())
      record(label + '_restored', { final, before, after })
      assertRestored(before, after)
    }
    facts.refs_verified = true; facts.persisted_reopen = true
    return facts
  })
}

export async function runFollowupIncident(api, config) {
  return incidentJournal(incidentPath(config, 'archive044'), async record => {
    const scenes = []
    const roots = ['archive044-alpha.txt', 'archive044-beta.txt'].map(name => `Modify ${join(config.workRoot, name)}.`)
    for (const name of SCENES) {
      const old = name.startsWith('old_'), clarified = name.endsWith('_clarified')
      await api.open('archive044-' + name)
      if (old) await api.legacyRoots(roots)
      const before = projectionFacts(api.projection())
      const pending = before.items.filter(row => row.status === 'pending' && row.action === 'modify')
      assert.ok(old ? pending.length >= 2 && new Set(pending.map(row => row.source)).size >= 2 : pending.length === 0)
      record(name + '_before', { roots: old ? roots : [], projection: before })
      if (clarified) await api.root(CLARIFICATION)
      await api.root(FOLLOWUP)
      const checkpoint = (await api.tool('context_guard_checkpoint', { bindings: [] })).value
      const view = api.projection(), after = projectionFacts(view)
      const preserved = pending.every(row => after.items.some(next => next.id === row.id && next.status === 'pending'))
      assert.equal(preserved, true, 'follow-up consumed an earlier root')
      assert.deepEqual(after.pending_rebinds, before.pending_rebinds, 'follow-up requested an internal selection')
      const decision = api.boundary(view, FOLLOWUP)
      assert.equal(typeof decision.reason, 'string')
      await api.reopen('archive044-' + name)
      const restored = projectionFacts(api.projection())
      record(name + '_restored', { followup: FOLLOWUP, clarification: clarified ? CLARIFICATION : null,
        checkpoint, decision, after, restored })
      assertRestored(after, restored)
      scenes.push({ name, pending_before: pending.length, preserved_pending: preserved,
        no_new_selection: true, persisted_reopen: true, reason: decision.reason })
    }
    return { case: 'archive044', scenes }
  })
}

/** Public fixed-field summary only; private journal contains the actual facts. */
export function assertIncidentSummary(value, kind) {
  assert.equal(value?.schema, 'dsh-native-incident-summary/v1')
  assert.equal(value.input_boundary, 'current_contract_analogue')
  assert.equal(value.case, kind)
  assert.match(value.evidence_sha256, /^[a-f0-9]{64}$/)
  if (kind === 'archive043') {
    for (const [key, expected] of Object.entries({ compound_reason: 'native_git_command_unsupported',
      commit_reason: 'git_commit_observed', push_reason: 'git_push_observed',
      ordinary_action_reason: 'ordinary_action_migrated_to_host_tools', missing_effect_reason: 'native_effect_missing',
      refs_verified: true, persisted_reopen: true })) assert.equal(value[key], expected)
  } else {
    assert.equal(kind, 'archive044')
    assert.deepEqual(value.scenes.map(row => row.name), SCENES)
    for (const row of value.scenes) {
      assert.equal(Number.isSafeInteger(row.pending_before), true)
      assert.ok(row.name.startsWith('old_') ? row.pending_before >= 2 : row.pending_before === 0)
      for (const key of ['preserved_pending', 'no_new_selection', 'persisted_reopen']) assert.equal(row[key], true)
      assert.match(row.reason, /^[a-z0-9_]+$/)
    }
  }
}
