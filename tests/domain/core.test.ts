import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  captureClause, certifyCheckpoint, classifyCompletionClaim, createProjection, decideTurnStopping, segmentClauses,
  deriveProjection, evidenceFromPersistedToolResult, goalCompletionDenial, isDeterministicCheck,
  isWholeTaskCompletionClaim, latestAssistantText, normalizeClause, renderRecoveryPacket, sha256,
  sanitizeClauseText, sanitizeUrl, withDurability,
} from '../../src/domain/index.js'

const OPT_IN = { activation: 'opt-in' as const }

describe('domain core', () => {
  it('canonicalizes whitespace and hashes clauses', () => {
    expect(normalizeClause('  ship   the   artifact  ')).toBe('ship the artifact')
    expect(sha256('ship the artifact')).toHaveLength(64)
  })

  it('captures prohibition and acceptance classes conservatively', () => {
    expect(captureClause("Don't change the API", 'm1', 'P001', 1).kind).toBe('prohibition')
    expect(captureClause('Verify the generated file', 'm2', 'A001', 2).kind).toBe('acceptance')
  })

  it('captured items always carry a concrete verification contract', () => {
    const artifact = captureClause('Verify the generated file src/app.ts', 'm1', 'A001', 1, { cwd: '/work' })
    expect(artifact.verification.subject).toBe('src/app.ts')
    expect(artifact.verification.surface).toBe('artifact')
    const scope = captureClause('ship the artifact', 'm2', 'R001', 1, { cwd: '/work' })
    expect(scope.verification.subject).toBe('/work')
    expect(scope.verification.surface).toBe('scope')
    const noScope = captureClause('ship the artifact', 'm3', 'R002', 1)
    expect(noScope.verification.subject).toBe('scope')
    expect(noScope.verification.surface).toBe('scope')
  })

  it('does not certify without matching durable evidence', () => {
    const projection = createProjection()
    projection.enabled = true
    projection.epoch = 1
    projection.contractRevision = 1
    projection.items.set('R001', captureClause('ship the artifact', 'm1', 'R001', 1, { cwd: '/work' }))
    const result = certifyCheckpoint(projection, [{ itemId: 'R001', evidenceIds: ['E0001'] }], 'C001')
    expect(result.status).toBe('incomplete')
    expect(result.rejectedBindings[0]?.reason).toContain('does not match')
  })

  it('rejects bindings that cite no evidence (fail-open regression)', () => {
    const projection = createProjection()
    projection.enabled = true
    projection.epoch = 1
    projection.contractRevision = 1
    projection.items.set('R001', captureClause('ship the artifact', 'm1', 'R001', 1, { cwd: '/work' }))
    const result = certifyCheckpoint(projection, [{ itemId: 'R001', evidenceIds: [] }], 'C001')
    expect(result.status).toBe('incomplete')
    expect(result.rejectedBindings[0]?.reason).toContain('no evidence cited')
  })

  it('does not let unrelated evidence close an artifact contract', () => {
    const projection = createProjection()
    projection.enabled = true
    projection.epoch = 1
    projection.contractRevision = 1
    projection.items.set('A001', captureClause('Verify the generated file src/app.ts', 'm1', 'A001', 1))
    projection.evidence.set('E0001', {
      id: 'E0001', epoch: 1, callId: 'c1', rootCallId: 'c1', toolName: 'read_file', toolResultSeq: 4,
      outcome: 'success', capabilities: ['filesystem-read'], subjects: ['src/other.ts'], surfaces: ['artifact'], boundedSummarySha256: sha256('x'),
    })
    expect(certifyCheckpoint(projection, [{ itemId: 'A001', evidenceIds: ['E0001'] }], 'C001').status).toBe('incomplete')
    projection.evidence.get('E0001')!.subjects = ['src/app.ts']
    expect(certifyCheckpoint(projection, [{ itemId: 'A001', evidenceIds: ['E0001'] }], 'C002').status).toBe('certified')
  })

  it('extracts structured subject from read tool meta', () => {
    const evidence = evidenceFromPersistedToolResult(
      { callId: 'call-1', name: 'read', arguments: JSON.stringify({ file_path: 'src/app.ts' }) },
      { seq: 4, meta: { path: 'src/app.ts' }, textContent: 'content' },
      1,
      'E0001',
    )
    expect(evidence.outcome).toBe('success')
    expect(evidence.toolResultSeq).toBe(4)
    expect(evidence.capabilities).toEqual(['filesystem-read'])
    expect(evidence.subjects).toEqual(['src/app.ts'])
    expect(evidence.surfaces).toEqual(['artifact'])
    expect(evidence.boundedSummarySha256).toHaveLength(64)
  })

  it('extracts web fetch URL and sanitizes query strings', () => {
    const webEvidence = evidenceFromPersistedToolResult(
      { callId: 'call-1', name: 'web_fetch', arguments: JSON.stringify({ url: 'https://example.com/page?token=secret123' }) },
      { seq: 4, meta: { url: 'https://example.com/page?token=secret123' }, textContent: 'ok' },
      1,
      'E0001',
    )
    expect(webEvidence.capabilities).toEqual(['web-fetch'])
    expect(webEvidence.subjects).toEqual(['https://example.com/page'])
    expect(webEvidence.surfaces).toEqual(['ui'])
    expect(sanitizeUrl('https://x.dev/a?key=abc123')).toBe('https://x.dev/a')
  })

  it('does not treat echoed or backgrounded checks as deterministic verification', () => {
    expect(isDeterministicCheck('pnpm test')).toBe(true)
    expect(isDeterministicCheck('cd /work && pnpm test')).toBe(true)
    expect(isDeterministicCheck('echo done')).toBe(false)
    expect(isDeterministicCheck('echo "pnpm test"')).toBe(false)
    expect(isDeterministicCheck('printf "%s" "pnpm test"')).toBe(false)
    expect(isDeterministicCheck('# pnpm test')).toBe(false)
    expect(isDeterministicCheck('pnpm test &')).toBe(false)
    expect(isDeterministicCheck('nohup pnpm test &')).toBe(false)
    expect(isDeterministicCheck('pnpm test || true')).toBe(false)
    expect(isDeterministicCheck('pnpm test; true')).toBe(false)
    expect(isDeterministicCheck('which pytest')).toBe(false)
    expect(isDeterministicCheck('pytest --version')).toBe(false)
    expect(isDeterministicCheck('grep pytest package.json')).toBe(false)
    expect(isDeterministicCheck('pnpm test && echo done')).toBe(true)
    expect(isDeterministicCheck('pnpm test | tee out')).toBe(false)
    expect(isDeterministicCheck('pnpm test | sed "s/x/y/"')).toBe(false)
    expect(isDeterministicCheck('! pnpm test')).toBe(false)
    expect(isDeterministicCheck('cd /work && ! pnpm test')).toBe(false)
    expect(isDeterministicCheck('( ! pnpm test )')).toBe(false)
    expect(isDeterministicCheck('cd /work && pnpm test')).toBe(true)
  })

  it('does not grant deterministic success to backgrounded or unmarked bash calls', () => {
    const backgrounded = evidenceFromPersistedToolResult(
      { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'pnpm test', run_in_background: true }) },
      { seq: 4, textContent: '' },
      1,
      'E0001',
    )
    expect(backgrounded.capabilities).not.toContain('deterministic-check')
    expect(backgrounded.outcome).toBe('unknown')
    const unmarked = evidenceFromPersistedToolResult(
      { callId: 'c2', name: 'bash', arguments: JSON.stringify({ command: 'pnpm test' }) },
      { seq: 5, textContent: '' },
      1,
      'E0002',
    )
    expect(unmarked.capabilities).toContain('deterministic-check')
    expect(unmarked.outcome).toBe('unknown')
  })

  it('uses the last recorded exit code so a fake leading marker cannot mask a trailing failure', () => {
    const fake = evidenceFromPersistedToolResult(
      { callId: 'call-1', name: 'bash', arguments: JSON.stringify({ command: 'echo "[exit code: 0]" && false' }) },
      { seq: 5, textContent: 'fake success\n[exit code: 0]\nreal failure\n[exit code: 1]' },
      1,
      'E0001',
    )
    expect(fake.outcome).toBe('failure')
    const real = evidenceFromPersistedToolResult(
      { callId: 'call-2', name: 'bash', arguments: JSON.stringify({ command: 'pnpm test' }) },
      { seq: 6, textContent: '[exit code: 0]' },
      1,
      'E0002',
    )
    expect(real.outcome).toBe('success')
    expect(real.capabilities).toContain('deterministic-check')
  })

  it('demotes evidence to unknown without a durability checkpoint', () => {
    const evidence = evidenceFromPersistedToolResult(
      { callId: 'call-1', name: 'read', arguments: JSON.stringify({ file_path: 'a.ts' }) },
      { seq: 4, meta: { path: 'a.ts' }, textContent: 'ok' },
      1,
      'E0001',
    )
    expect(evidence.outcome).toBe('success')
    expect(withDurability(evidence, false).outcome).toBe('unknown')
    expect(withDurability(evidence, true).outcome).toBe('success')
  })

  it('failed durable tool results cannot become successful evidence', () => {
    const evidence = evidenceFromPersistedToolResult(
      { callId: 'call-1', name: 'bash', arguments: JSON.stringify({ command: 'ls' }) },
      { seq: 4, error: { code: 'EXIT_NONZERO' }, textContent: '' },
      1,
      'E0001',
    )
    expect(evidence.outcome).toBe('failure')
  })

  it('extracts bash subjects and exit code from rendered text', () => {
    const evidence = evidenceFromPersistedToolResult(
      { callId: 'call-1', name: 'bash', arguments: JSON.stringify({ command: 'pnpm test src/app.ts', workdir: '/work' }) },
      { seq: 4, textContent: '[exit code: 1]' },
      1,
      'E0001',
    )
    expect(evidence.outcome).toBe('failure')
    expect(evidence.capabilities).toContain('shell')
    expect(evidence.capabilities).toContain('deterministic-check')
    expect(evidence.surfaces).toEqual(['scope'])
    expect(evidence.subjects).toContain('/work')
  })

  it('requires the evidence subject and surface to match', () => {
    const projection = createProjection()
    projection.epoch = 1
    projection.contractRevision = 1
    const item = captureClause('Verify artifact', 'm1', 'A001', 1)
    item.verification = { enforced: true, subject: 'src/app.ts', surface: 'artifact' }
    projection.items.set(item.id, item)
    projection.evidence.set('E0001', {
      id: 'E0001', epoch: 1, callId: 'c1', rootCallId: 'c1', toolName: 'read_file', toolResultSeq: 4,
      outcome: 'success', capabilities: ['filesystem-read'], subjects: ['src/other.ts'], surfaces: ['artifact'], boundedSummarySha256: sha256('x'),
    })
    expect(certifyCheckpoint(projection, [{ itemId: 'A001', evidenceIds: ['E0001'] }], 'C001').status).toBe('incomplete')
    projection.evidence.get('E0001')!.subjects = ['src/app.ts']
    expect(certifyCheckpoint(projection, [{ itemId: 'A001', evidenceIds: ['E0001'] }], 'C002').status).toBe('certified')
  })

  it('denies Goal completion only while enabled and uncertified', () => {
    const projection = createProjection()
    projection.enabled = false
    projection.epoch = 1
    projection.integrity = 'valid'
    expect(goalCompletionDenial(projection, 'update_goal', { action: 'complete' })).toBeUndefined()
    projection.enabled = true
    expect(goalCompletionDenial(projection, 'update_goal', { action: 'complete' })).toContain('requires a current')
    expect(goalCompletionDenial(projection, 'update_goal', { action: 'continue' })).toBeUndefined()
  })

  it('allows Goal completion only with a current certified checkpoint', () => {
    const projection = createProjection()
    projection.enabled = true
    projection.epoch = 1
    projection.contractRevision = 1
    projection.checkpoints.push({ id: 'C001', epoch: 1, contractRevision: 1, openDigest: sha256(''), bindingDigest: sha256('binding'), bindings: [], result: 'certified' })
    expect(goalCompletionDenial(projection, 'update_goal', { action: 'complete' })).toBeUndefined()
    projection.contractRevision = 2
    expect(goalCompletionDenial(projection, 'update_goal', { action: 'complete' })).toContain('requires a current')
  })

  it('classifies whole-task completion conservatively', () => {
    expect(isWholeTaskCompletionClaim('The task is complete.')).toBe(true)
    expect(isWholeTaskCompletionClaim('所有任务已经完成。')).toBe(true)
    expect(isWholeTaskCompletionClaim('Done.')).toBe(true)
    expect(isWholeTaskCompletionClaim('搞定了。')).toBe(true)
    expect(isWholeTaskCompletionClaim('完成了。')).toBe(true)
    expect(isWholeTaskCompletionClaim('第一步已经完成了，接下来做第二步')).toBe(false)
    expect(isWholeTaskCompletionClaim('Step 1 is done, moving to phase 2.')).toBe(false)
    expect(isWholeTaskCompletionClaim('As an example, "the task is complete" is misleading.')).toBe(false)
    expect(isWholeTaskCompletionClaim('Is the task complete?')).toBe(false)
    expect(isWholeTaskCompletionClaim('The task is not complete.')).toBe(false)
    expect(isWholeTaskCompletionClaim('If you agree, the task is complete.')).toBe(false)
    expect(isWholeTaskCompletionClaim('Step 1 is complete.')).toBe(false)
    expect(classifyCompletionClaim('Waiting for your confirmation.')).toBe('user_wait')
    expect(classifyCompletionClaim('Waiting for the test result.')).toBe('external_wait')
  })

  it('decides turn stopping with a continuation attempt cap', () => {
    const projection = createProjection()
    expect(decideTurnStopping(projection, 'The task is complete.', 1, 2).action).toBe('stop') // not enabled
    projection.enabled = true
    projection.epoch = 1
    expect(decideTurnStopping(projection, 'The task is complete.', 1, 2).action).toBe('continue')
    expect(decideTurnStopping(projection, 'The task is complete.', 1, 2).action).toBe('continue')
    expect(decideTurnStopping(projection, 'The task is complete.', 1, 2).action).toBe('stop') // limit reached
    expect(decideTurnStopping(projection, 'Step 1 is done.', 2, 2).action).toBe('stop') // partial report
  })

  it('extracts the latest assistant text from session events', () => {
    const events = [
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'older' }] } } },
      { type: 'tool/result', data: {} },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'The task is complete.' }] } } },
    ]
    expect(latestAssistantText(events)).toBe('The task is complete.')
  })

  it('renders a bounded recovery packet in priority order', () => {
    const projection = createProjection()
    projection.items.set('R001', captureClause('ship the artifact', 'm1', 'R001', 1))
    projection.items.set('P001', captureClause("Don't touch the API", 'm2', 'P001', 1))
    projection.items.set('A001', captureClause('Verify the file', 'm3', 'A001', 1))
    const packet = renderRecoveryPacket(projection, { charBudget: 200 })
    expect(packet).toContain('[R001] ship the artifact')
    expect(packet.indexOf('[R001]')).toBeLessThan(packet.indexOf('[P001]'))
    expect(packet.indexOf('[P001]')).toBeLessThan(packet.indexOf('[A001]'))
    expect(packet.length).toBeLessThanOrEqual(200)
  })

  it('derives distinct IDs and supersedes identical re-statements', () => {
    const first = deriveProjection([
      { seq: 0, type: 'command/run', data: { commandId: 'cmd-0', name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'ship the artifact' }], source: { kind: 'user' } } },
      { seq: 2, type: 'user/message', data: { content: [{ type: 'text', text: 'ship the artifact' }], source: { kind: 'user' } } },
      { seq: 3, type: 'user/message', data: { content: [{ type: 'text', text: 'verify the file src/app.ts' }], source: { kind: 'user' } } },
    ], OPT_IN, { cwd: '/work' }, true)
    const items = [...first.projection.items.values()]
    expect(items.map((item) => item.id)).toEqual(['R001', 'R002', 'A001'])
    const superseded = items.find((item) => item.id === 'R001')
    expect(superseded?.status).toBe('superseded')
    expect(superseded?.supersededBy).toBe('R002')
    expect(items.find((item) => item.id === 'R002')?.revision).toBeGreaterThan(items.find((item) => item.id === 'R001')!.revision)
  })

  it('sanitizes credentials and URL queries from captured text', () => {
    expect(sanitizeClauseText('Authorization: Bearer abc123def456 token')).toContain('<redacted>')
    expect(sanitizeClauseText('login with api_key=sk-test-1234567890abcdef')).toContain('<redacted>')
    expect(sanitizeClauseText('fetch https://x.dev/a?token=sekrit')).not.toContain('sekrit')
  })

  it('carries the code-mode root call id through evidence', () => {
    const evidence = evidenceFromPersistedToolResult(
      { callId: 'inner-1', name: 'read', arguments: '{}', rootCallId: 'dispatch-9' },
      { seq: 4, meta: { path: 'a.ts' }, textContent: 'ok' },
      1,
      'E0001',
    )
    expect(evidence.rootCallId).toBe('dispatch-9')
    expect(evidence.callId).toBe('inner-1')
  })

  it('certifies all current items with current successful evidence', () => {
    const projection = createProjection()
    projection.enabled = true
    projection.epoch = 1
    projection.contractRevision = 1
    projection.items.set('R001', captureClause('ship the artifact', 'm1', 'R001', 1, { cwd: '/work' }))
    projection.evidence.set('E0001', {
      id: 'E0001', epoch: 1, callId: 'call-1', rootCallId: 'call-1', toolName: 'bash',
      toolResultSeq: 4, outcome: 'success', capabilities: ['shell', 'deterministic-check'], subjects: ['/work'],
      surfaces: ['scope'], boundedSummarySha256: sha256('build ok'),
    })
    const result = certifyCheckpoint(projection, [{ itemId: 'R001', evidenceIds: ['E0001'] }], 'C001')
    expect(result.status).toBe('certified')
    expect(projection.items.get('R001')?.status).toBe('passed')
  })

  it('round-trips a real Session log through derivation', () => {
    const session = Session.create(SessionId('integration-session'))
    ;(session as unknown as { append: (type: string, data: unknown) => unknown }).append('command/run', { commandId: 'cmd-1', name: 'context-guard', args: 'on', source: { kind: 'user' } })
    const derived = deriveProjection(session.events as never, OPT_IN, {}, true)
    expect(derived.projection.enabled).toBe(true)
    expect(derived.projection.epoch).toBe(1)
  })
})

  it('never promotes a persisted incomplete checkpoint to a certificate', () => {
    const events = [
      { seq: 0, type: 'command/run', data: { commandId: 'cmd-0', name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'verify the generated file src/app.ts' }], source: { kind: 'user' } } },
      { seq: 2, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"file_path":"src/app.ts"}' } },
      { seq: 3, type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }], source: { kind: 'tool', callId: 'c1' } }, meta: { path: 'src/app.ts' } } },
      { seq: 4, type: 'tool/call', data: { turn: 1, step: 2, callId: 'c2', name: 'context_guard_checkpoint', arguments: JSON.stringify({ bindings: [{ item_id: 'A001', evidence_ids: ['E0001'] }] }) } },
      { seq: 5, type: 'tool/result', data: { turn: 1, step: 2, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: JSON.stringify({ status: 'incomplete', contract_revision: 1, open_items: ['A001'], rejected_bindings: [] }) }] }], source: { kind: 'tool', callId: 'c2' } } } },
    ]
    const derived = deriveProjection(events, OPT_IN, { cwd: '' }, true)
    expect(derived.projection.checkpoints).toHaveLength(0)
    expect(derived.projection.items.get('A001')?.status).toBe('pending')
    expect(derived.projection.integrity).toBe('valid')
  })

  it('segments compound messages into independent tracked clauses', () => {
    const events = [
      { seq: 0, type: 'command/run', data: { commandId: 'cmd-0', name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'Modify src/a.ts and src/b.ts. Do not push. Verify both files.' }], source: { kind: 'user' } } },
    ]
    const derived = deriveProjection(events, OPT_IN, { cwd: '/work' }, true)
    const items = [...derived.projection.items.values()]
    const artifactSubjects = items.filter((item) => item.verification.surface === 'artifact').map((item) => item.verification.subject)
    expect(artifactSubjects.sort()).toEqual(['/work/src/a.ts', '/work/src/b.ts'])
    expect(items.some((item) => item.kind === 'prohibition' && item.normalizedText.toLowerCase().includes('push'))).toBe(true)
    expect(items.some((item) => item.kind === 'acceptance')).toBe(true)
  })

  it('folds Code Mode dispatch events into evidence', () => {
    const events = [
      { seq: 0, type: 'command/run', data: { commandId: 'cmd-0', name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 1, type: 'tool/code-dispatch-start', data: { rootCallId: 'r9', parentCallId: 'p1', subCallId: 's1', name: 'read', arguments: '{"file_path":"src/app.ts"}' } },
      { seq: 2, type: 'tool/code-dispatch', data: { rootCallId: 'r9', parentCallId: 'p1', subCallId: 's1', name: 'read', arguments: '{}', isError: false, content: [{ type: 'text', text: 'ok' }] } },
    ]
    const derived = deriveProjection(events, OPT_IN, {}, true)
    const evidence = [...derived.projection.evidence.values()]
    expect(evidence).toHaveLength(1)
    expect(evidence[0].toolName).toBe('read')
    expect(evidence[0].rootCallId).toBe('r9')
    expect(evidence[0].callId).toBe('s1')
  })

  it('redacts credential material without leaking value bytes', () => {
    expect(sanitizeClauseText('Authorization: Bearer abc123def456')).not.toMatch(/abc123def456/)
    expect(sanitizeClauseText('token=abc123def456')).not.toMatch(/abc123/)
    expect(sanitizeClauseText('fetch https://x.dev/a?token=sekrit#frag')).not.toContain('sekrit')
    expect(sanitizeUrl('https://x.dev/a#access_token=secret')).toBe('https://x.dev/a')
    expect(sanitizeClauseText('token: "abc123def456"')).not.toMatch(/abc123def456/)
    expect(sanitizeClauseText("api_key='abc123def456'")).not.toMatch(/abc123def456/)
    expect(sanitizeClauseText('password: "correct horse,battery;staple"')).not.toMatch(/correct horse|battery|staple/)
    expect(sanitizeClauseText("token='abc,def;ghi'")).not.toMatch(/abc,def|ghi/)
    expect(sanitizeClauseText('password: "correct horse\\" battery,staple"')).not.toMatch(/battery|staple/)
    expect(sanitizeClauseText("password: \"correct horse's battery")).not.toMatch(/correct horse|battery/)
    expect(sanitizeClauseText('token=\'alpha "beta gamma')).not.toMatch(/alpha|beta|gamma/)
    expect(sanitizeClauseText('secret="alpha beta\\')).not.toMatch(/alpha|beta/)
    expect(sanitizeClauseText("token='gamma delta\\")).not.toMatch(/gamma|delta/)
    expect(sanitizeClauseText('{"password":"correct horse"}')).not.toMatch(/correct horse/)
    expect(sanitizeClauseText("{'token':'alpha beta'}")).not.toMatch(/alpha|beta/)
    expect(sanitizeClauseText('Authorization: Basic dXNlcjpwYXNz')).not.toMatch(/dXNlcjpwYXNz/)
    expect(sanitizeClauseText('Cookie: session=abc123; preference=private456')).not.toMatch(/abc123|private456/)
  })

  it('segments no-space Chinese compound messages', () => {
    const events = [
      { seq: 0, type: 'command/run', data: { commandId: 'cmd-0', name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '修改 src/a.ts 和 src/b.ts。不要 push。确认两个文件。' }], source: { kind: 'user' } } },
    ]
    const derived = deriveProjection(events, OPT_IN, { cwd: '/work' }, true)
    const items = [...derived.projection.items.values()]
    const artifactSubjects = items.filter((item) => item.verification.surface === 'artifact').map((item) => item.verification.subject)
    expect(artifactSubjects.sort()).toEqual(['/work/src/a.ts', '/work/src/b.ts'])
    expect(items.some((item) => item.kind === 'prohibition')).toBe(true)
    expect(items.some((item) => item.kind === 'acceptance')).toBe(true)
  })

  it('extracts subjects from object-form Code Mode arguments', () => {
    const events = [
      { seq: 0, type: 'command/run', data: { commandId: 'cmd-0', name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 1, type: 'tool/code-dispatch-start', data: { rootCallId: 'r9', parentCallId: 'p1', subCallId: 's1', name: 'read', arguments: { file_path: 'src/app.ts' } } },
      { seq: 2, type: 'tool/code-dispatch', data: { rootCallId: 'r9', parentCallId: 'p1', subCallId: 's1', name: 'read', arguments: {}, isError: false, content: [{ type: 'text', text: 'ok' }] } },
    ]
    const derived = deriveProjection(events, OPT_IN, {}, true)
    const evidence = [...derived.projection.evidence.values()]
    expect(evidence).toHaveLength(1)
    expect(evidence[0].subjects).toContain('src/app.ts')
  })

  it('does not split artifact names that contain prohibition keywords', () => {
    const events = [
      { seq: 0, type: 'command/run', data: { commandId: 'cmd-0', name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '修改 src/nevermore.ts。确认该文件。' }], source: { kind: 'user' } } },
    ]
    const derived = deriveProjection(events, OPT_IN, { cwd: '/work' }, true)
    const items = [...derived.projection.items.values()]
    const artifact = items.find((item) => item.verification.surface === 'artifact')
    expect(artifact?.verification.subject).toBe('/work/src/nevermore.ts')
    expect(items.some((item) => item.kind === 'prohibition')).toBe(false)
    expect(items.some((item) => item.kind === 'acceptance')).toBe(true)
    // Bare filenames beginning with a prohibition keyword must also survive.
    const bareEvents = [
      { seq: 0, type: 'command/run', data: { commandId: 'cmd-0', name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '修改 nevermore.ts。确认该文件。' }], source: { kind: 'user' } } },
    ]
    const bare = deriveProjection(bareEvents, OPT_IN, { cwd: '/work' }, true)
    const bareItems = [...bare.projection.items.values()]
    expect(bareItems.find((item) => item.verification.surface === 'artifact')?.verification.subject).toBe('/work/nevermore.ts')
    expect(bareItems.some((item) => item.kind === 'prohibition')).toBe(false)
    expect(bareItems.some((item) => item.kind === 'acceptance')).toBe(true)
  })

  it('recognizes punctuation-delimited English prohibitions without splitting never-prefixed names', () => {
    const segs = segmentClauses('Modify x.ts. Never: push changes. Never, ever push.')
    expect(segs.some((seg) => seg.kind === 'prohibition')).toBe(true)
    const names = segmentClauses('修改 nevermore.ts。确认该文件。')
    expect(names.some((seg) => seg.kind === 'prohibition')).toBe(false)
    expect(names.some((seg) => seg.paths.includes('nevermore.ts'))).toBe(true)
    for (const name of ['never-more.ts', 'never.more.ts', 'never/a.ts', 'never@b.ts']) {
      const segs2 = segmentClauses(`修改 ${name}。确认该文件。`)
      expect(segs2.some((seg) => seg.kind === 'prohibition'), name).toBe(false)
      expect(segs2.some((seg) => seg.paths.includes(name)), name).toBe(true)
    }
  })

  it('establishes artifact contracts for Windows paths', () => {
    const segs = segmentClauses('Verify C:\\work\\src\\app.ts')
    expect(segs).toHaveLength(1)
    expect(segs[0].kind).toBe('acceptance')
    expect(segs[0].paths).toContain('C:\\work\\src\\app.ts')
    const events = [
      { seq: 0, type: 'command/run', data: { commandId: 'cmd-0', name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'Verify C:\\work\\src\\app.ts' }], source: { kind: 'user' } } },
    ]
    const derived = deriveProjection(events, OPT_IN, { cwd: 'C:\\work' }, true)
    const artifact = [...derived.projection.items.values()].find((item) => item.verification.surface === 'artifact')
    expect(artifact?.verification.subject).toBe('C:\\work\\src\\app.ts')
  })

  it('captures wrapped, unicode, and spaced artifact paths precisely', () => {
    const cases: Array<[string, string]> = [
      ['Verify `src/app.ts`', 'src/app.ts'],
      ['Verify "src/app.ts"', 'src/app.ts'],
      ['Verify (src/app.ts)', 'src/app.ts'],
      ['Verify 文档/说明.md', '文档/说明.md'],
      ['Verify "C:\\Program Files\\app.ts"', 'C:\\Program Files\\app.ts'],
    ]
    for (const [text, expected] of cases) {
      const segs = segmentClauses(text)
      expect(segs.some((seg) => seg.paths.includes(expected)), text).toBe(true)
    }
    const events = [
      { seq: 0, type: 'command/run', data: { commandId: 'cmd-0', name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'Verify "C:\\Program Files\\app.ts"' }], source: { kind: 'user' } } },
    ]
    const derived = deriveProjection(events, OPT_IN, { cwd: '/work' }, true)
    const artifact = [...derived.projection.items.values()].find((item) => item.verification.surface === 'artifact')
    expect(artifact?.verification.subject).toBe('C:\\Program Files\\app.ts')
  })

  it('resolves bare relative contract paths against the working directory', () => {
    const events = [
      { seq: 0, type: 'command/run', data: { commandId: 'cmd-0', name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '修改 guard-demo.txt' }], source: { kind: 'user' } } },
    ]
    const derived = deriveProjection(events, OPT_IN, { cwd: '/work' }, true)
    const artifact = [...derived.projection.items.values()].find((item) => item.verification.surface === 'artifact')
    expect(artifact?.verification.subject).toBe('/work/guard-demo.txt')
  })

  it('drops pure instruction-framing clauses', () => {
    const events = [
      { seq: 0, type: 'command/run', data: { commandId: 'cmd-0', name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '请完成以下完整任务：修改 src/a.ts。验证 src/b.ts。' }], source: { kind: 'user' } } },
    ]
    const derived = deriveProjection(events, OPT_IN, { cwd: '/work' }, true)
    const items = [...derived.projection.items.values()]
    expect(items.some((item) => item.kind === 'requirement' && item.verification.surface === 'scope' && /以下|following/i.test(item.normalizedText))).toBe(false)
    expect(items.filter((item) => item.verification.surface === 'artifact')).toHaveLength(2)
  })

  it('lists citable evidence ids in the recovery packet', () => {
    const projection = createProjection()
    projection.epoch = 1
    projection.items.set('R001', captureClause('ship the artifact', 'm1', 'R001', 1, { cwd: '/work' }))
    projection.evidence.set('E0001', {
      id: 'E0001', epoch: 1, callId: 'c1', rootCallId: 'c1', toolName: 'read', toolResultSeq: 4,
      outcome: 'success', capabilities: ['filesystem-read'], subjects: ['/work/artifact'], surfaces: ['artifact'], boundedSummarySha256: sha256('x'),
    })
    const packet = renderRecoveryPacket(projection, { charBudget: 4000 })
    expect(packet).toContain('evidence E0001 read /work/artifact artifact')
  })

  it('recognizes a bare completion title followed by a results summary', () => {
    const reply = `完成。

- 使用 bash 读取并修改目标文件
- 使用 read 验证结果
- 未修改其他文件。`
    expect(isWholeTaskCompletionClaim(reply)).toBe(true)
    expect(isWholeTaskCompletionClaim('Done.\n\n- built the artifact\n- ran the tests.')).toBe(true)
    // Exclusions still hold when the summary continues the task.
    expect(isWholeTaskCompletionClaim('完成。\n接下来做第二步')).toBe(false)
    expect(isWholeTaskCompletionClaim('完成。\n如果用户同意再继续')).toBe(false)
    expect(isWholeTaskCompletionClaim('完成。\n第一步已经完成')).toBe(false)
  })
