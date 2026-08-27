import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  canonicalizePath, captureClause, certifyCheckpoint, classifyCompletionClaim, createProjection, decideTurnStopping, segmentClauses,
  deriveProjection, evidenceFromPersistedToolResult, extractOperation, goalCompletionDenial, isDeterministicCheck,
  isWholeTaskCompletionClaim, latestAssistantText, normalizeClause, parsePwshCommand, parseShellCommand, renderRecoveryPacket, sha256,
  sanitizeClauseText, sanitizeUrl, withDurability,
} from '../../src/domain/index.js'

const OPT_IN = { activation: 'opt-in' as const }
const ALWAYS = { activation: 'always' as const }

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

  it('uses the verified clean-success contract only for foreground bash', () => {
    const backgrounded = evidenceFromPersistedToolResult(
      { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'pnpm test', run_in_background: true }) },
      { seq: 4, textContent: '' },
      1,
      'E0001',
    )
    expect(backgrounded.capabilities).not.toContain('deterministic-check')
    expect(backgrounded.outcome).toBe('unknown')
    for (const [index, textContent] of ['', '(no output)', 'tests passed', '[stderr]\nwarning only'].entries()) {
      const clean = evidenceFromPersistedToolResult(
        { callId: `c-clean-${index}`, name: 'bash', arguments: JSON.stringify({ command: 'pnpm test' }) },
        { seq: 5 + index, textContent },
        1,
        `E-clean-${index}`,
      )
      expect(clean.capabilities).toContain('deterministic-check')
      expect(clean.outcome, textContent).toBe('success')
    }
    const unverifiedAlias = evidenceFromPersistedToolResult(
      { callId: 'c-shell', name: 'shell', arguments: JSON.stringify({ command: 'pnpm test' }) },
      { seq: 9, textContent: 'tests passed' },
      1,
      'E-shell',
    )
    expect(unverifiedAlias.capabilities).toContain('deterministic-check')
    expect(unverifiedAlias.outcome).toBe('unknown')

    const negativeMarkers = [
      '[timed out after 1000ms]',
      '[sandbox: file access denied under workspace-write mode]',
      '[killed by signal: SIGTERM]',
      '[interrupted by user]',
    ]
    for (const [index, textContent] of negativeMarkers.entries()) {
      const failed = evidenceFromPersistedToolResult(
        { callId: `c-failed-${index}`, name: 'bash', arguments: JSON.stringify({ command: 'pnpm test' }) },
        { seq: 10 + index, textContent },
        1,
        `E-failed-${index}`,
      )
      expect(failed.outcome, textContent).toBe('failure')
    }
  })

  it('recognizes persistent shell exit reports as terminal facts', () => {
    const bashReset = 'The persistent bash shell was reset; the next bash call starts from the workspace with a fresh current directory and environment.'
    const pwshReset = 'The persistent pwsh shell was reset; the next pwsh call starts from the workspace with a fresh current directory and environment.'
    const cases: Array<[string, string, 'success' | 'failure']> = [
      [`[shell exited: code 1]\n${bashReset}`, 'bash', 'failure'],
      [`[shell killed by signal: SIGTERM]\n${bashReset}`, 'bash', 'failure'],
      [`[shell exited]\n${bashReset}`, 'bash', 'failure'],
      [`Your command timed out after 30 seconds or experienced an OOM error. Below is partial output:\npartial output here\n${bashReset}`, 'bash', 'failure'],
      [`[shell exited: code 1]\n${pwshReset}`, 'pwsh', 'failure'],
      [`[shell exited: code 0]\n${bashReset}`, 'bash', 'success'],
      // Marker shapes without the prose wrapper are still terminal facts.
      ['[shell exited: code 1]', 'bash', 'failure'],
      // A clean result that merely echoes the reset prose is not a terminal
      // fact: without any marker it stays a clean success.
      [`output ends with reset prose\n${bashReset}`, 'bash', 'success'],
    ]
    for (const [index, [textContent, name, expected]] of cases.entries()) {
      const evidence = evidenceFromPersistedToolResult(
        { callId: `c-persistent-${index}`, name, arguments: JSON.stringify({ command: 'pnpm test' }) },
        { seq: 20 + index, textContent },
        1,
        `E-persistent-${index}`,
      )
      expect(evidence.outcome, `${name}: ${textContent}`).toBe(expected)
    }
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

    const cleanBash = evidenceFromPersistedToolResult(
      { callId: 'call-bash', name: 'bash', arguments: JSON.stringify({ command: 'pnpm typecheck' }) },
      { seq: 5, textContent: '$ tsc --noEmit' },
      1,
      'E-bash',
    )
    expect(cleanBash.outcome).toBe('success')
    expect(withDurability(cleanBash, false).outcome).toBe('unknown')
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

  it('replays always-active durable clean bash evidence into a scope certificate', () => {
    const events = [
      { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '验收：确认项目测试通过' }], source: { kind: 'user' } } },
      { seq: 2, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'pnpm typecheck', workdir: '/work' }) } },
      { seq: 3, type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'Done in 1.2s' }] }], source: { kind: 'tool', callId: 'c1' } } } },
    ]
    const derived = deriveProjection(events, ALWAYS, { cwd: '/work' }, true)
    expect(derived.projection.enabled).toBe(true)
    expect(derived.projection.epoch).toBe(0)
    expect(derived.projection.evidence.get('E0001')).toMatchObject({
      outcome: 'success', capabilities: ['shell', 'deterministic-check'], subjects: ['/work'], surfaces: ['scope'],
    })
    const item = [...derived.projection.items.values()].find((candidate) => candidate.kind === 'acceptance')
    expect(item?.verification).toMatchObject({ subject: '/work', surface: 'scope' })
    expect(certifyCheckpoint(derived.projection, [{ itemId: item!.id, evidenceIds: ['E0001'] }], 'C001').status).toBe('certified')
  })

  it('uses only the final exit marker as authoritative', () => {
    const cases: Array<[string, 'success' | 'failure']> = [
      ['[exit code: 0]\n[exit code: 1]', 'failure'],
      ['[exit code: 1]\n[exit code: 0]', 'success'],
      ['ordinary output [exit code: 1]\n[exit code: 0]', 'success'],
      ['[exit code: 0]\n[timed out after 1000ms]\n[exit code: 0]', 'failure'],
    ]
    for (const [text, outcome] of cases) {
      const evidence = evidenceFromPersistedToolResult(
        { callId: `marker-${text.length}`, name: 'bash', arguments: JSON.stringify({ command: 'echo ok' }) },
        { seq: 20, textContent: text }, 1, `E-${text.length}`,
      )
      expect(evidence.outcome, text).toBe(outcome)
    }
    expect(evidenceFromPersistedToolResult(
      { callId: 'marker-clean', name: 'bash', arguments: JSON.stringify({ command: 'echo ok' }) },
      { seq: 21, textContent: 'ok' }, 1, 'E-clean',
    ).outcome).toBe('success')
  })

  it('does not let unsupported shell syntax certify deterministic acceptance', () => {
    const projection = createProjection()
    projection.epoch = 1
    projection.contractRevision = 1
    const item = captureClause('验收：确认项目测试通过', 'm1', 'A001', 1, { cwd: '/work' })
    projection.items.set(item.id, item)
    const evidence = evidenceFromPersistedToolResult(
      { callId: 'compound', name: 'bash', arguments: JSON.stringify({ command: 'pnpm test && true', workdir: '/work' }) },
      { seq: 2, textContent: 'tests passed' }, 1, 'E-compound',
    )
    expect(evidence.outcome).toBe('success')
    expect(evidence.capabilities).not.toContain('deterministic-check')
    expect(certifyCheckpoint(projection, [{ itemId: item.id, evidenceIds: [evidence.id] }], 'C-compound').status).toBe('incomplete')

    const malformed = evidenceFromPersistedToolResult(
      { callId: 'malformed', name: 'bash', arguments: JSON.stringify({ command: 'printf "abc', workdir: '/work' }) },
      { seq: 3, textContent: 'host returned cleanly' }, 1, 'E-malformed',
    )
    expect(malformed.outcome).toBe('success')
    expect(malformed.executables).toBeUndefined()
    expect(malformed.operations).toBeUndefined()
    // The cwd remains descriptive scope metadata, but without a parsed
    // operation or deterministic-check capability it is not certifying.
    expect(malformed.subjects).toEqual(['/work'])
    expect(malformed.capabilities).not.toContain('deterministic-check')
    expect(certifyCheckpoint(projection, [{ itemId: item.id, evidenceIds: [malformed.id] }], 'C-malformed').status).toBe('incomplete')
  })

  it('rejects newline boundaries and file-descriptor redirects as whole commands', () => {
    for (const command of ['printf x > target.txt\nrm other.txt', 'printf x > target.txt\r\nrm other.txt', 'echo err 2>guard-demo.txt', 'echo err 1>guard-demo.txt', 'echo err 0>>guard-demo.txt']) {
      const parsed = parseShellCommand(command)
      expect(parsed.status, command).toBe('unsupported')
      expect(parsed.executables, command).toEqual([])
      expect(parsed.operations, command).toEqual([])
    }
    expect(parseShellCommand('printf x > target.txt').status).toBe('supported')
    expect(parseShellCommand('printf "line\\ntext" > target.txt').status).toBe('supported')
  })

  it('rejects PowerShell no-op and interaction switches as effects', () => {
    for (const command of [
      'Set-Content -Path target.txt -Value x -WhatIf',
      'Set-Content -Path target.txt -Value x -Confirm',
      'New-Item -Path target.txt -WhatIf',
      'Out-File -FilePath target.txt -WhatIf',
      'Add-Content -Path target.txt -Value x -WhatIf',
    ]) {
      const parsed = parsePwshCommand(command)
      expect(parsed.status, command).toBe('unsupported')
      expect(parsed.executables, command).toEqual([])
      expect(parsed.operations, command).toEqual([])
    }
  })

  it('requires independent same-subject state verification for create/write/modify', () => {
    const makeProjection = () => {
      const projection = createProjection()
      projection.epoch = 1
      projection.contractRevision = 1
      const item = captureClause('使用 edit 修改 /work/demo.txt', 'm1', 'A001', 1)
      projection.items.set(item.id, item)
      return { projection, item }
    }
    const edit = evidenceFromPersistedToolResult(
      { callId: 'edit', name: 'edit', arguments: JSON.stringify({ file_path: '/work/demo.txt' }) },
      { seq: 1, meta: { path: '/work/demo.txt' }, textContent: 'updated' }, 1, 'E-edit',
    )
    const sameRead = evidenceFromPersistedToolResult(
      { callId: 'read-same', name: 'read', arguments: JSON.stringify({ file_path: '/work/demo.txt' }) },
      { seq: 2, meta: { path: '/work/demo.txt' }, textContent: 'updated' }, 1, 'E-read-same',
    )
    const otherRead = evidenceFromPersistedToolResult(
      { callId: 'read-other', name: 'read', arguments: JSON.stringify({ file_path: '/work/other.txt' }) },
      { seq: 3, meta: { path: '/work/other.txt' }, textContent: 'other' }, 1, 'E-read-other',
    )
    const editAgain = evidenceFromPersistedToolResult(
      { callId: 'edit-again', name: 'edit', arguments: JSON.stringify({ file_path: '/work/demo.txt' }) },
      { seq: 4, meta: { path: '/work/demo.txt' }, textContent: 'updated again' }, 1, 'E-edit-again',
    )
    const certify = (ids: string[], evidence: ReturnType<typeof evidenceFromPersistedToolResult>[]) => {
      const { projection, item } = makeProjection()
      for (const value of evidence) projection.evidence.set(value.id, value)
      return certifyCheckpoint(projection, [{ itemId: item.id, evidenceIds: ids }], `C-${ids.join('-')}`).status
    }
    expect(certify([edit.id], [edit])).toBe('incomplete')
    expect(certify([edit.id, sameRead.id], [edit, sameRead])).toBe('certified')
    expect(certify([edit.id, otherRead.id], [edit, otherRead])).toBe('incomplete')
    expect(certify([edit.id, editAgain.id], [edit, editAgain])).toBe('incomplete')
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

  it('recognizes a decorated bare completion title followed by a results summary (P0-1)', () => {
    expect(isWholeTaskCompletionClaim('✅ 完成。\n\n- 使用 read 验证\n- 未修改其他文件。')).toBe(true)
    expect(isWholeTaskCompletionClaim('✔ Done.\n\n- built the artifact')).toBe(true)
    expect(isWholeTaskCompletionClaim('⚠️ 完成。\n- ran the tests.')).toBe(true)
    // Exclusions still hold with a decorated title.
    expect(isWholeTaskCompletionClaim('✅ 完成。\n接下来做第二步')).toBe(false)
    expect(isWholeTaskCompletionClaim('✔ Done.\n如果用户同意再继续')).toBe(false)
  })

  it('recognizes the full real Windows reply (P0-1 regression)', () => {
    const realReply = `✅ 完成。

**验收结果**：使用 read 工具读取 \`guard-demo.txt\`，内容为 \`guard-test\`（第 1 行，无多余字符），符合要求。未修改其他任何文件。

**方法说明（重要偏差）**：您要求使用 bash，但本环境中 bash 不可用，原因如下：
1. \`bash\` 不在 PATH 中（命令未找到）；
2. 找到的 Git Bash（\`C:\\Program Files\\Git\\bin\\bash.exe\`）在当前沙箱（workspace-write 受限模式）下无法创建其启动所需的信号管道（\`couldn't create signal pipe, Win32 error 5\`，访问被拒绝）；
3. 已尝试将同一命令升级为 \`danger-full-access\` 重试，但升级需要审批且当前无可用审批通道，升级被拒绝（该命令的沙箱拒绝为最终结果）；
4. WSL 未安装（\`wsl.exe --status\` 提示需先安装）。

因此改用环境内可用的 PowerShell 创建了该文件（\`.NET WriteAllText\` 写入，UTF-8 无 BOM、无末尾换行），确保文件内容严格为 \`guard-test\` 以满足验收标准。`
    expect(isWholeTaskCompletionClaim(realReply)).toBe(true)
  })

  it('canonicalizes Windows and POSIX subject paths for matching (P0-2)', () => {
    expect(canonicalizePath('C:\\work/guard-demo.txt')).toBe('c:\\work\\guard-demo.txt')
    expect(canonicalizePath('c:/Work/../work/guard-demo.TXT')).toBe('c:\\work\\guard-demo.txt')
    expect(canonicalizePath('\\\\server\\share\\a\\..\\b')).toBe('\\\\server\\share\\b')
    expect(canonicalizePath('\\\\server\\share\\a\\..\\b')).toBe(canonicalizePath('\\\\SERVER\\Share\\b'))
    // Forward-slash UNC spellings are Windows-style too (P1-2).
    expect(canonicalizePath('//SERVER/Share/a/../b')).toBe('\\\\server\\share\\b')
    expect(canonicalizePath('//SERVER/Share/a/../b')).toBe(canonicalizePath('\\\\server\\share\\b'))
    // Relative paths are resolved per their own separator style.
    expect(canonicalizePath('a/./b/../c.txt')).toBe('a/c.txt')
    expect(canonicalizePath('a\\b\\..\\c.txt')).toBe('a\\c.txt')
    expect(canonicalizePath('/work/guard-demo.txt')).toBe('/work/guard-demo.txt')
    expect(canonicalizePath('/work/Guard.txt')).toBe('/work/Guard.txt')
  })

  it('matches a Windows contract subject to a differently-cased evidence subject (P0-2)', () => {
    const projection = createProjection()
    projection.enabled = true
    projection.epoch = 1
    projection.contractRevision = 1
    const item = captureClause('verify guard-demo.txt', 'm1', 'A001', 1)
    item.verification = { enforced: true, subject: 'C:\\work/guard-demo.txt', surface: 'artifact' }
    projection.items.set(item.id, item)
    projection.evidence.set('E0001', {
      id: 'E0001', epoch: 1, callId: 'c1', rootCallId: 'c1', toolName: 'read', toolResultSeq: 4,
      outcome: 'success', capabilities: ['filesystem-read'], subjects: ['c:\\WORK\\guard-demo.txt'], surfaces: ['artifact'], boundedSummarySha256: sha256('x'),
    })
    expect(certifyCheckpoint(projection, [{ itemId: 'A001', evidenceIds: ['E0001'] }], 'C001').status).toBe('certified')
  })

  it('keeps POSIX subject matching case-sensitive (P0-2)', () => {
    const projection = createProjection()
    projection.enabled = true
    projection.epoch = 1
    projection.contractRevision = 1
    const item = captureClause('verify Guard.txt', 'm1', 'A001', 1)
    item.verification = { enforced: true, subject: '/work/Guard.txt', surface: 'artifact' }
    projection.items.set(item.id, item)
    projection.evidence.set('E0001', {
      id: 'E0001', epoch: 1, callId: 'c1', rootCallId: 'c1', toolName: 'read', toolResultSeq: 4,
      outcome: 'success', capabilities: ['filesystem-read'], subjects: ['/work/guard.txt'], surfaces: ['artifact'], boundedSummarySha256: sha256('x'),
    })
    expect(certifyCheckpoint(projection, [{ itemId: 'A001', evidenceIds: ['E0001'] }], 'C001').status).toBe('incomplete')
  })

  it('captures an explicit tool method into the verification contract (P0-3)', () => {
    const item = captureClause('使用 bash 创建 guard-demo.txt', 'm1', 'R001', 1, { cwd: 'C:\\work' })
    expect(item.verification.method).toBe('bash')
    expect(item.verification.subject).toBe('guard-demo.txt')
    expect(item.verification.surface).toBe('artifact')
    expect(captureClause('使用 read 工具读取 guard-demo.txt', 'm2', 'A001', 1, { cwd: '/work' }).verification.method).toBe('read')
    expect(captureClause('确认文件内容', 'm3', 'A002', 1).verification.method).toBeUndefined()
  })

  it('does not let pwsh create + read close a bash-required artifact (P0-3 negative)', () => {
    const events = [
      { seq: 0, type: 'command/run', data: { commandId: 'c0', name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '使用 bash 创建 guard-demo.txt' }], source: { kind: 'user' } } },
      { seq: 2, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{}' } },
      { seq: 3, type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'created' }] }], source: { kind: 'tool', callId: 'c1' } } } },
      { seq: 4, type: 'tool/call', data: { turn: 1, step: 2, callId: 'c2', name: 'read', arguments: '{"file_path":"C:\\work\\guard-demo.txt"}' } },
      { seq: 5, type: 'tool/result', data: { turn: 1, step: 2, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'guard-test' }] }], source: { kind: 'tool', callId: 'c2' } }, meta: { path: 'C:\\work\\guard-demo.txt' } } },
    ]
    const derived = deriveProjection(events, OPT_IN, { cwd: 'C:\\work' }, true)
    const item = [...derived.projection.items.values()].find((i) => i.kind === 'requirement')
    expect(item?.verification.method).toBe('bash')
    expect(item?.verification.subject).toBe('C:\\work/guard-demo.txt')
    const result = certifyCheckpoint(derived.projection, [{ itemId: item!.id, evidenceIds: ['E0001', 'E0002'] }], 'C001')
    expect(result.status).toBe('incomplete')
  })

  it('certifies a bash-required artifact with bash + read evidence (P0-3 positive)', () => {
    const events = [
      { seq: 0, type: 'command/run', data: { commandId: 'c0', name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '使用 bash 创建 guard-demo.txt' }], source: { kind: 'user' } } },
      { seq: 2, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"printf \\"%s\\" \\"guard-test\\" > guard-demo.txt","workdir":"C:\\\\work"}' } },
      { seq: 3, type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '[exit code: 0]' }] }], source: { kind: 'tool', callId: 'c1' } } } },
      { seq: 4, type: 'tool/call', data: { turn: 1, step: 2, callId: 'c2', name: 'read', arguments: '{"file_path":"C:\\work\\guard-demo.txt"}' } },
      { seq: 5, type: 'tool/result', data: { turn: 1, step: 2, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'guard-test' }] }], source: { kind: 'tool', callId: 'c2' } }, meta: { path: 'C:\\work\\guard-demo.txt' } } },
    ]
    const derived = deriveProjection(events, OPT_IN, { cwd: 'C:\\work' }, true)
    const item = [...derived.projection.items.values()].find((i) => i.kind === 'requirement')
    expect(item?.verification.method).toBe('bash')
    const result = certifyCheckpoint(derived.projection, [{ itemId: item!.id, evidenceIds: ['E0001', 'E0002'] }], 'C001')
    expect(result.status).toBe('certified')
    expect(derived.projection.items.get(item!.id)?.status).toBe('passed')
  })

  it('rejects an unrelated bash call as method evidence for an artifact (P0-1 negative)', () => {
    const events = [
      { seq: 0, type: 'command/run', data: { commandId: 'c0', name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '使用 bash 创建 guard-demo.txt' }], source: { kind: 'user' } } },
      { seq: 2, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"pwd","workdir":"C:\\\\work"}' } },
      { seq: 3, type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '[exit code: 0]' }] }], source: { kind: 'tool', callId: 'c1' } } } },
      { seq: 4, type: 'tool/call', data: { turn: 1, step: 2, callId: 'c2', name: 'pwsh', arguments: JSON.stringify({ command: '[System.IO.File]::WriteAllText((Join-Path (Get-Location) "guard-demo.txt"), "guard-test")', workdir: 'C:\\work' }) } },
      { seq: 5, type: 'tool/result', data: { turn: 1, step: 2, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'created' }] }], source: { kind: 'tool', callId: 'c2' } } } },
      { seq: 6, type: 'tool/call', data: { turn: 1, step: 3, callId: 'c3', name: 'read', arguments: '{"file_path":"C:\\work\\guard-demo.txt"}' } },
      { seq: 7, type: 'tool/result', data: { turn: 1, step: 3, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c3', content: [{ type: 'text', text: 'guard-test' }] }], source: { kind: 'tool', callId: 'c3' } }, meta: { path: 'C:\\work\\guard-demo.txt' } } },
    ]
    const derived = deriveProjection(events, OPT_IN, { cwd: 'C:\\work' }, true)
    const item = [...derived.projection.items.values()].find((i) => i.kind === 'requirement')
    expect(item?.verification.method).toBe('bash')
    expect(item?.verification.subject).toBe('C:\\work/guard-demo.txt')
    const result = certifyCheckpoint(derived.projection, [{ itemId: item!.id, evidenceIds: ['E0001', 'E0003'] }], 'C001')
    expect(result.status).toBe('incomplete')
  })

  it('satisfies an executable method from a shell command (P1-1)', () => {
    const events = [
      { seq: 0, type: 'command/run', data: { commandId: 'c0', name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '使用 pnpm 运行测试' }], source: { kind: 'user' } } },
      { seq: 2, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{ "command": "pnpm test", "workdir": "/work" }' } },
      { seq: 3, type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '[exit code: 0]' }] }], source: { kind: 'tool', callId: 'c1' } } } },
    ]
    const derived = deriveProjection(events, OPT_IN, { cwd: '/work' }, true)
    const item = [...derived.projection.items.values()].find((i) => i.kind === 'requirement')
    expect(item?.verification.method).toBe('pnpm')
    const result = certifyCheckpoint(derived.projection, [{ itemId: item!.id, evidenceIds: ['E0001'] }], 'C001')
    expect(result.status).toBe('certified')
  })

  it('recognizes Markdown heading and emphasis completion titles (P0-2)', () => {
    expect(isWholeTaskCompletionClaim('## ✅ 完成。\n- 已验证')).toBe(true)
    expect(isWholeTaskCompletionClaim('**完成。**\n- 已验证')).toBe(true)
    expect(isWholeTaskCompletionClaim('### Done.\n- built the artifact')).toBe(true)
    expect(isWholeTaskCompletionClaim('*完成。*\n- 已完成说明')).toBe(true)
    // Blockquotes, quoted titles and examples still fail closed.
    expect(isWholeTaskCompletionClaim('> 完成。\n- 已验证')).toBe(false)
    expect(isWholeTaskCompletionClaim('“完成。”\n- 已验证')).toBe(false)
    expect(isWholeTaskCompletionClaim('**完成。**\n接下来做第二步')).toBe(false)
  })

  it('iterates heading/emphasis/decoration until stable (P0-3)', () => {
    expect(isWholeTaskCompletionClaim('## ✅ **完成。**\n- 已验证')).toBe(true)
    expect(isWholeTaskCompletionClaim('✅ **完成。**\n- 已验证')).toBe(true)
    expect(isWholeTaskCompletionClaim('## **✅ 完成。**\n- 已验证')).toBe(true)
    // Blockquotes still fail closed even when decorated.
    expect(isWholeTaskCompletionClaim('> **完成。**\n- 已验证')).toBe(false)
    expect(isWholeTaskCompletionClaim('✅ **完成。**\n接下来做第二步')).toBe(false)
  })

  it('parses shell commands quote-aware (P0-2 / P1-2)', () => {
    // Quoted text must not invent executables.
    expect(parseShellCommand('echo "ignored; pnpm test"').executables).toEqual(['echo'])
    expect(parseShellCommand('echo "ignored; pnpm test && npm run build"').executables).toEqual(['echo'])
    // Assignments resolve the real executable; wrappers are not in the v0.1
    // subset and fail closed.
    expect(parseShellCommand('CI=1 pnpm test').executables).toContain('pnpm')
    const wrapped = parseShellCommand('env CI=1 pnpm test')
    expect(wrapped.status).toBe('unsupported')
    expect(wrapped.executables).toEqual([])
    // Quoted redirect targets are recovered; bare mention yields no
    // create/read operation (a run is still attributed).
    expect(parseShellCommand('printf x > "guard-demo.txt"').operations).toContainEqual({ op: 'create', path: 'guard-demo.txt' })
    expect(parseShellCommand('echo guard-demo.txt').operations.some((operation) => operation.op === 'create' || operation.op === 'read')).toBe(false)
    // Unclosed quotes fail closed.
    expect(parseShellCommand('printf "abc').malformed).toBe(true)
    expect(parseShellCommand('printf "abc').executables).toEqual([])
  })

  it('does not let echo-only bash close a create requirement (P0-1 negative)', () => {
    const events = [
      { seq: 0, type: 'command/run', data: { commandId: 'c0', name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '使用 bash 创建 guard-demo.txt' }], source: { kind: 'user' } } },
      { seq: 2, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"echo guard-demo.txt","workdir":"C:\\\\work"}' } },
      { seq: 3, type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '[exit code: 0]' }] }], source: { kind: 'tool', callId: 'c1' } } } },
      { seq: 4, type: 'tool/call', data: { turn: 1, step: 2, callId: 'c2', name: 'pwsh', arguments: JSON.stringify({ command: '[System.IO.File]::WriteAllText((Join-Path (Get-Location) "guard-demo.txt"), "guard-test")', workdir: 'C:\\work' }) } },
      { seq: 5, type: 'tool/result', data: { turn: 1, step: 2, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'created' }] }], source: { kind: 'tool', callId: 'c2' } } } },
      { seq: 6, type: 'tool/call', data: { turn: 1, step: 3, callId: 'c3', name: 'read', arguments: '{"file_path":"C:\\work\\guard-demo.txt"}' } },
      { seq: 7, type: 'tool/result', data: { turn: 1, step: 3, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c3', content: [{ type: 'text', text: 'guard-test' }] }], source: { kind: 'tool', callId: 'c3' } }, meta: { path: 'C:\\work\\guard-demo.txt' } } },
    ]
    const derived = deriveProjection(events, OPT_IN, { cwd: 'C:\\work' }, true)
    const item = [...derived.projection.items.values()].find((i) => i.kind === 'requirement')
    expect(item?.verification.method).toBe('bash')
    expect(item?.verification.operation).toBe('create')
    const result = certifyCheckpoint(derived.projection, [{ itemId: item!.id, evidenceIds: ['E0001', 'E0003'] }], 'C001')
    expect(result.status).toBe('incomplete')
  })

  it('does not let quoted text invent an executable method (P0-2 negative)', () => {
    const events = [
      { seq: 0, type: 'command/run', data: { commandId: 'c0', name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '使用 pnpm 运行测试' }], source: { kind: 'user' } } },
      { seq: 2, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"echo \\"ignored; pnpm test\\"","workdir":"/work"}' } },
      { seq: 3, type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '[exit code: 0]' }] }], source: { kind: 'tool', callId: 'c1' } } } },
    ]
    const derived = deriveProjection(events, OPT_IN, { cwd: '/work' }, true)
    const item = [...derived.projection.items.values()].find((i) => i.kind === 'requirement')
    expect(item?.verification.operation).toBe('run')
    const result = certifyCheckpoint(derived.projection, [{ itemId: item!.id, evidenceIds: ['E0001'] }], 'C001')
    expect(result.status).toBe('incomplete')
  })

  it('records clean pwsh success without an exit marker (P1-1)', () => {
    const evidence = evidenceFromPersistedToolResult(
      { callId: 'call-1', name: 'pwsh', arguments: JSON.stringify({ command: 'Write-Output ok' }) },
      { seq: 9, textContent: 'ok' },
      1,
      'E0001',
    )
    expect(evidence.outcome).toBe('success')
    const failure = evidenceFromPersistedToolResult(
      { callId: 'call-2', name: 'pwsh', arguments: JSON.stringify({ command: 'throw' }) },
      { seq: 10, error: { code: 'EXIT_NONZERO' }, textContent: 'boom' },
      1,
      'E0002',
    )
    expect(failure.outcome).toBe('failure')
  })

  it('certifies an explicit pwsh create with pwsh + read evidence (P1-1)', () => {
    const events = [
      { seq: 0, type: 'command/run', data: { commandId: 'c0', name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '使用 PowerShell 创建 guard-demo.txt' }], source: { kind: 'user' } } },
      { seq: 2, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{"command":"Set-Content -LiteralPath guard-demo.txt -Value \'guard-test\'","workdir":"C:\\\\work"}' } },
      { seq: 3, type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'created' }] }], source: { kind: 'tool', callId: 'c1' } } } },
      { seq: 4, type: 'tool/call', data: { turn: 1, step: 2, callId: 'c2', name: 'read', arguments: '{"file_path":"C:\\work\\guard-demo.txt"}' } },
      { seq: 5, type: 'tool/result', data: { turn: 1, step: 2, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'guard-test' }] }], source: { kind: 'tool', callId: 'c2' } }, meta: { path: 'C:\\work\\guard-demo.txt' } } },
    ]
    const derived = deriveProjection(events, OPT_IN, { cwd: 'C:\\work' }, true)
    const item = [...derived.projection.items.values()].find((i) => i.kind === 'requirement')
    expect(item?.verification.method).toBe('pwsh')
    const result = certifyCheckpoint(derived.projection, [{ itemId: item!.id, evidenceIds: ['E0001', 'E0002'] }], 'C001')
    expect(result.status).toBe('certified')
  })

  it('derives a create operation for a bash create requirement (P0-1 contract)', () => {
    const item = captureClause('使用 bash 创建 guard-demo.txt', 'm1', 'R001', 1, { cwd: 'C:\\work' })
    expect(item.verification.method).toBe('bash')
    expect(item.verification.operation).toBe('create')
    expect(item.verification.subject).toBe('guard-demo.txt')
    expect(extractOperation('使用 read 工具读取 guard-demo.txt')).toBe('read')
    expect(extractOperation('使用 pnpm 运行测试')).toBe('run')
    expect(extractOperation('修改 src/a.ts')).toBe('modify')
  })

  it('parses English operations case-insensitively with word boundaries (P0-2)', () => {
    expect(extractOperation('Use bash to Create guard-demo.txt')).toBe('create')
    expect(extractOperation('Use bash to RUN the tests')).toBe('run')
    expect(extractOperation('Use read to Read the file')).toBe('read')
    // Whole-token matching: internal words must not match.
    expect(extractOperation('already done')).toBeUndefined()
    expect(extractOperation('runtime check')).toBeUndefined()
    expect(extractOperation('predicted output')).toBeUndefined()
    // An explicit method with no parsable operation fails closed in matching.
    const item = captureClause('使用 bash 处理 guard-demo.txt', 'm1', 'R001', 1, { cwd: '/work' })
    expect(item.verification.method).toBe('bash')
    expect(item.verification.operation).toBeUndefined()
  })

  it('fails closed when an explicit method has no parsable operation (P0-2)', () => {
    const projection = createProjection()
    projection.enabled = true
    projection.epoch = 1
    projection.contractRevision = 1
    const item = captureClause('使用 bash 处理 guard-demo.txt', 'm1', 'R001', 1, { cwd: '/work' })
    item.verification = { enforced: true, subject: '/work/guard-demo.txt', surface: 'artifact', method: 'bash', operation: undefined }
    projection.items.set(item.id, item)
    projection.evidence.set('E0001', {
      id: 'E0001', epoch: 1, callId: 'c1', rootCallId: 'c1', toolName: 'bash', toolResultSeq: 1,
      outcome: 'success', capabilities: ['shell'], subjects: ['/work/guard-demo.txt'], surfaces: ['scope'], boundedSummarySha256: sha256('x'),
    })
    projection.evidence.set('E0002', {
      id: 'E0002', epoch: 1, callId: 'c2', rootCallId: 'c2', toolName: 'read', toolResultSeq: 2,
      outcome: 'success', capabilities: ['filesystem-read'], subjects: ['/work/guard-demo.txt'], surfaces: ['artifact'], boundedSummarySha256: sha256('y'),
    })
    expect(certifyCheckpoint(projection, [{ itemId: 'R001', evidenceIds: ['E0001', 'E0002'] }], 'C001').status).toBe('incomplete')
  })

  it('does not treat quoted pwsh strings as commands (P0-1)', () => {
    const parsed = parsePwshCommand('Write-Output "Set-Content C:\\work\\guard-demo.txt now"')
    expect(parsed.operations).toEqual([])
    const events = [
      { seq: 0, type: 'command/run', data: { commandId: 'c0', name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '使用 PowerShell 创建 guard-demo.txt' }], source: { kind: 'user' } } },
      { seq: 2, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{"command":"Write-Output \\"Set-Content C:\\\\work\\\\guard-demo.txt now\\""}' } },
      { seq: 3, type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'Set-Content C:\\work\\guard-demo.txt now' }] }], source: { kind: 'tool', callId: 'c1' } } } },
      { seq: 4, type: 'tool/call', data: { turn: 1, step: 2, callId: 'c2', name: 'read', arguments: '{"file_path":"C:\\work\\guard-demo.txt"}' } },
      { seq: 5, type: 'tool/result', data: { turn: 1, step: 2, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'guard-test' }] }], source: { kind: 'tool', callId: 'c2' } }, meta: { path: 'C:\\work\\guard-demo.txt' } } },
    ]
    const derived = deriveProjection(events, OPT_IN, { cwd: 'C:\\work' }, true)
    const item = [...derived.projection.items.values()].find((i) => i.kind === 'requirement')
    expect(item?.verification.method).toBe('pwsh')
    const result = certifyCheckpoint(derived.projection, [{ itemId: item!.id, evidenceIds: ['E0001', 'E0002'] }], 'C001')
    expect(result.status).toBe('incomplete')
  })

  it('rejects negative pwsh terminal markers before the clean-success fallback (P0-3)', () => {
    const timeout = evidenceFromPersistedToolResult(
      { callId: 'call-1', name: 'pwsh', arguments: JSON.stringify({ command: 'Get-ChildItem' }) },
      { seq: 9, textContent: '[timed out after 1000ms]' },
      1,
      'E0001',
    )
    expect(timeout.outcome).toBe('failure')
    const denied = evidenceFromPersistedToolResult(
      { callId: 'call-2', name: 'pwsh', arguments: JSON.stringify({ command: 'Copy-Item' }) },
      { seq: 10, textContent: '[sandbox: file access denied under workspace-write mode]' },
      1,
      'E0002',
    )
    expect(denied.outcome).toBe('failure')
    const killed = evidenceFromPersistedToolResult(
      { callId: 'call-3', name: 'bash', arguments: JSON.stringify({ command: 'sleep 10' }) },
      { seq: 11, textContent: '[killed by signal: SIGTERM]' },
      1,
      'E0003',
    )
    expect(killed.outcome).toBe('failure')
  })

  it('attaches run operations to any effective executable (P1-1)', () => {
    expect(parseShellCommand('node script.js').operations).toContainEqual({ op: 'run', path: 'script.js' })
    expect(parseShellCommand('python tool.py').operations).toContainEqual({ op: 'run', path: 'tool.py' })
    expect(parseShellCommand('echo hello').operations).toContainEqual({ op: 'run' })
    expect(parseShellCommand('pnpm test').operations).toContainEqual({ op: 'run' })
    // The running of an arbitrary executable is NOT part of the v0.1 subset and
    // fails closed.
    const arbitrary = parseShellCommand('bash echo hello')
    expect(arbitrary.status).toBe('unsupported')
    expect(arbitrary.executables).toEqual([])
  })

  it('certifies a node-run artifact with run + read evidence (P1-1)', () => {
    const events = [
      { seq: 0, type: 'command/run', data: { commandId: 'c0', name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '使用 node 运行 script.js' }], source: { kind: 'user' } } },
      { seq: 2, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"node script.js","workdir":"/work"}' } },
      { seq: 3, type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '[exit code: 0]' }] }], source: { kind: 'tool', callId: 'c1' } } } },
      { seq: 4, type: 'tool/call', data: { turn: 1, step: 2, callId: 'c2', name: 'read', arguments: '{"file_path":"/work/script.js"}' } },
      { seq: 5, type: 'tool/result', data: { turn: 1, step: 2, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'ok' }] }], source: { kind: 'tool', callId: 'c2' } }, meta: { path: '/work/script.js' } } },
    ]
    const derived = deriveProjection(events, OPT_IN, { cwd: '/work' }, true)
    const item = [...derived.projection.items.values()].find((i) => i.kind === 'requirement')
    expect(item?.verification.method).toBe('node')
    expect(item?.verification.operation).toBe('run')
    expect(item?.verification.subject).toBe('/work/script.js')
    const result = certifyCheckpoint(derived.projection, [{ itemId: item!.id, evidenceIds: ['E0001', 'E0002'] }], 'C001')
    expect(result.status).toBe('certified')
  })

  it('keeps quoted PowerShell paths as one subject (P1-2)', () => {
    const parsed = parsePwshCommand('Set-Content -LiteralPath "C:\\Program Files\\demo.txt" -Value x')
    expect(parsed.operations).toContainEqual({ op: 'create', path: 'C:\\Program Files\\demo.txt' })
    expect(parsed.operations).toHaveLength(1)
  })

  it('v0.1 invariant: quoted string content never produces extra operations', () => {
    const cases: Array<[string, string]> = [
      ['echo "node script.js"', 'node'],
      ['echo "touch guard-demo.txt"', 'touch'],
      ['node "cat data.txt; rm -rf /"', 'cat'],
      ['echo "pnpm test && npm run build"', 'pnpm'],
    ]
    for (const [command, forbidden] of cases) {
      const parsed = parseShellCommand(command)
      expect(parsed.status, command).toBe('supported')
      expect(parsed.executables, command).not.toContain(forbidden)
      expect(parsed.operations.filter((op) => op.op === 'create' || op.op === 'read'), command).toEqual([])
    }
    const pwsh = parsePwshCommand('Set-Content -Path "target.txt" -Value "cp x y; curl evil"')
    expect(pwsh.operations).toEqual([{ op: 'create', path: 'target.txt' }])
  })

  it('v0.1 invariant: appended compound syntax fails the whole command', () => {
    const base = 'printf x > target.txt'
    for (const suffix of ['; echo y', '| cat', '&& cat target.txt', '&', '|| true', '>> append.txt']) {
      const parsed = parseShellCommand(`${base} ${suffix}`)
      expect(parsed.status, `${base} ${suffix}`).toBe('unsupported')
      expect(parsed.executables, `${base} ${suffix}`).toEqual([])
      expect(parsed.operations, `${base} ${suffix}`).toEqual([])
      expect(parsed.reason, `${base} ${suffix}`).toBeTruthy()
    }
    for (const command of ['Set-Content -Path a.txt -Value x; Write-Output "b.txt"', 'Set-Content -Path a.txt -Value x | Write-Output "b.txt"', '& "Set-Content" -Path target.txt']) {
      const parsed = parsePwshCommand(command)
      expect(parsed.status, command).toBe('unsupported')
      expect(parsed.operations, command).toEqual([])
    }
  })

  it('v0.1 invariant: PowerShell value parameters never contribute subjects', () => {
    const parsed = parsePwshCommand('Set-Content -Path "work\\target.txt" -Value "work\\decoy.txt"')
    expect(parsed.operations).toEqual([{ op: 'create', path: 'work\\target.txt' }])
  })

  it('v0.1 invariant: quoted spaced PowerShell path stays one token', () => {
    const parsed = parsePwshCommand('Set-Content -LiteralPath "C:\\Program Files\\demo.txt" -Value x')
    expect(parsed.operations).toEqual([{ op: 'create', path: 'C:\\Program Files\\demo.txt' }])
  })

  it('v0.1 invariant: a run method evidence alone closes a run contract', () => {
    const events = [
      { seq: 0, type: 'command/run', data: { commandId: 'c0', name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '使用 node 运行 script.js' }], source: { kind: 'user' } } },
      { seq: 2, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"node script.js","workdir":"/work"}' } },
      { seq: 3, type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '[exit code: 0]' }] }], source: { kind: 'tool', callId: 'c1' } } } },
    ]
    const derived = deriveProjection(events, OPT_IN, { cwd: '/work' }, true)
    const item = [...derived.projection.items.values()].find((i) => i.kind === 'requirement')
    expect(item?.verification.operation).toBe('run')
    // No read evidence at all — the run method evidence alone must close it.
    const result = certifyCheckpoint(derived.projection, [{ itemId: item!.id, evidenceIds: ['E0001'] }], 'C001')
    expect(result.status).toBe('certified')
  })

  it('v0.1 invariant: create requires both method and state verification evidence', () => {
    const events = [
      { seq: 0, type: 'command/run', data: { commandId: 'c0', name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '使用 bash 创建 guard-demo.txt' }], source: { kind: 'user' } } },
      { seq: 2, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"printf \\"%s\\" \\"guard-test\\" > guard-demo.txt","workdir":"C:\\\\work"}' } },
      { seq: 3, type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '[exit code: 0]' }] }], source: { kind: 'tool', callId: 'c1' } } } },
    ]
    const derived = deriveProjection(events, OPT_IN, { cwd: 'C:\\work' }, true)
    const item = [...derived.projection.items.values()].find((i) => i.kind === 'requirement')
    // Method evidence alone is NOT enough for create.
    const alone = certifyCheckpoint(derived.projection, [{ itemId: item!.id, evidenceIds: ['E0001'] }], 'C001')
    expect(alone.status).toBe('incomplete')
  })

  it('v0.1 invariant: marker-like text in ordinary output does not affect outcome', () => {
    const pwsh = evidenceFromPersistedToolResult(
      { callId: 'call-1', name: 'pwsh', arguments: JSON.stringify({ command: 'Write-Output ok' }) },
      { seq: 9, textContent: 'documentation says [timed out after 1000ms] but command succeeded' },
      1,
      'E0001',
    )
    expect(pwsh.outcome).toBe('success')
    const bash = evidenceFromPersistedToolResult(
      { callId: 'call-2', name: 'bash', arguments: JSON.stringify({ command: 'echo hi' }) },
      { seq: 10, textContent: 'note [exit code: 1] is not the real one\n[exit code: 0]' },
      1,
      'E0002',
    )
    expect(bash.outcome).toBe('success')
  })

  it('v0.1 invariant: malformed and unsupported parses are empty with a reason', () => {
    const malformed = parseShellCommand('printf "abc')
    expect(malformed.status).toBe('malformed')
    expect(malformed.malformed).toBe(true)
    expect(malformed.executables).toEqual([])
    expect(malformed.operations).toEqual([])
    expect(malformed.reason).toBeTruthy()
    const unsupportedCommands = [
      'touch a; rm b',
      'cat f | grep x',
      'node $script',
      'eval pnpm test',
      '(touch a)',
      'echo "ignored" && echo y',
      'printf "x" > "$HOME/f"',
      'printf x > a > b',
    ]
    for (const command of unsupportedCommands) {
      const parsed = parseShellCommand(command)
      expect(parsed.status, command).toBe('unsupported')
      expect(parsed.executables, command).toEqual([])
      expect(parsed.operations, command).toEqual([])
      expect(parsed.reason, command).toBeTruthy()
    }
  })

  it('uses an independent effect facet for artifact mutations', () => {
    const makeProjection = (text: string) => {
      const projection = createProjection()
      projection.epoch = 1
      projection.contractRevision = 1
      const item = captureClause(text, 'm1', 'A001', 1)
      projection.items.set(item.id, item)
      return { projection, item }
    }
    const write = evidenceFromPersistedToolResult(
      { callId: 'write', name: 'write', arguments: JSON.stringify({ file_path: '/work/demo.txt' }) },
      { seq: 1, meta: { path: '/work/demo.txt' }, textContent: 'ok' }, 1, 'E-write',
    )
    const readSame = evidenceFromPersistedToolResult(
      { callId: 'read-same', name: 'read', arguments: JSON.stringify({ file_path: '/work/demo.txt' }) },
      { seq: 2, meta: { path: '/work/demo.txt' }, textContent: 'ok' }, 1, 'E-read-same',
    )
    const readOther = evidenceFromPersistedToolResult(
      { callId: 'read-other', name: 'read', arguments: JSON.stringify({ file_path: '/work/other.txt' }) },
      { seq: 3, meta: { path: '/work/other.txt' }, textContent: 'ok' }, 1, 'E-read-other',
    )
    const certify = (text: string, ids: string[], evidence: ReturnType<typeof evidenceFromPersistedToolResult>[]) => {
      const { projection, item } = makeProjection(text)
      for (const value of evidence) projection.evidence.set(value.id, value)
      return certifyCheckpoint(projection, [{ itemId: item.id, evidenceIds: ids }], `C-${ids.join('-')}`).status
    }
    expect(certify('创建 /work/demo.txt', [write.id, readSame.id], [write, readSame])).toBe('certified')
    expect(certify('创建 /work/demo.txt', [write.id], [write])).toBe('incomplete')
    expect(certify('创建 /work/demo.txt', [write.id, readOther.id], [write, readOther])).toBe('incomplete')
    const edit = evidenceFromPersistedToolResult(
      { callId: 'edit', name: 'edit', arguments: JSON.stringify({ file_path: '/work/demo.txt' }) },
      { seq: 4, meta: { path: '/work/demo.txt' }, textContent: 'ok' }, 1, 'E-edit',
    )
    expect(certify('使用 edit 修改 /work/demo.txt', [edit.id, readSame.id], [edit, readSame])).toBe('certified')
  })

  it('requires the explicit method on the effect evidence itself', () => {
    const projection = createProjection()
    projection.epoch = 1
    projection.contractRevision = 1
    const item = captureClause('使用 bash 创建 /work/demo.txt', 'm1', 'A001', 1)
    projection.items.set(item.id, item)
    const pwsh = evidenceFromPersistedToolResult(
      { callId: 'pwsh', name: 'pwsh', arguments: JSON.stringify({ command: 'Set-Content -Path /work/demo.txt -Value x' }) },
      { seq: 1, textContent: 'created' }, 1, 'E-pwsh',
    )
    const read = evidenceFromPersistedToolResult(
      { callId: 'read', name: 'read', arguments: JSON.stringify({ file_path: '/work/demo.txt' }) },
      { seq: 2, meta: { path: '/work/demo.txt' }, textContent: 'x' }, 1, 'E-read',
    )
    projection.evidence.set(pwsh.id, pwsh)
    projection.evidence.set(read.id, read)
    expect(certifyCheckpoint(projection, [{ itemId: item.id, evidenceIds: [pwsh.id, read.id] }], 'C-method').status).toBe('incomplete')
  })

  it('rejects PowerShell outer newlines but preserves quoted literal newlines', () => {
    for (const command of [
      'Set-Content -Path a.txt\n-Value x',
      'Get-Content -Path a.txt\r\n-Raw',
      'Set-Content -Path a.txt -Value x\nGet-Content -Path a.txt',
    ]) {
      const parsed = parsePwshCommand(command)
      expect(parsed.status, command).toBe('unsupported')
      expect(parsed.executables, command).toEqual([])
      expect(parsed.operations, command).toEqual([])
    }
    const quoted = parsePwshCommand('Set-Content -Path a.txt -Value "line\ntext"')
    expect(quoted.status).toBe('supported')
    expect(quoted.operations).toEqual([{ op: 'create', path: 'a.txt' }])
  })

  it('binds verify method, capability, and subject to one evidence', () => {
    const makeEvidence = (callId: string, name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) =>
      evidenceFromPersistedToolResult(
        { callId, name, arguments: JSON.stringify(args) },
        { seq: Number(callId.replace(/\\D/g, '')) || 1, meta, textContent: name === 'bash' ? '[exit code: 0]' : 'ok' },
        1,
        `E-${callId}`,
      )
    const certify = (text: string, evidence: ReturnType<typeof makeEvidence>[]) => {
      const projection = createProjection()
      projection.epoch = 1
      projection.contractRevision = 1
      const item = captureClause(text, 'm1', 'A001', 1)
      projection.items.set(item.id, item)
      for (const value of evidence) projection.evidence.set(value.id, value)
      return certifyCheckpoint(projection, [{ itemId: item.id, evidenceIds: evidence.map((value) => value.id) }], 'C-verify').status
    }
    const bashUnrelated = makeEvidence('bash-1', 'bash', { command: 'echo hi', workdir: '/work' })
    const readSame = makeEvidence('read-2', 'read', { file_path: '/work/demo.txt' }, { path: '/work/demo.txt' })
    const readOther = makeEvidence('read-3', 'read', { file_path: '/work/other.txt' }, { path: '/work/other.txt' })
    const bashVerify = makeEvidence('bash-4', 'bash', { command: 'cat /work/demo.txt', workdir: '/work' })
    expect(certify('使用 bash 验证 /work/demo.txt', [bashUnrelated, readSame])).toBe('incomplete')
    expect(certify('使用 read 验证 /work/demo.txt', [readSame])).toBe('certified')
    expect(certify('验证 /work/demo.txt', [readSame])).toBe('certified')
    expect(certify('使用 bash 验证 /work/demo.txt', [bashVerify, readOther])).toBe('incomplete')
    expect(certify('使用 bash 处理 /work/demo.txt', [bashVerify, readSame])).toBe('incomplete')
  })

  it('keeps the PowerShell v0.1 schema exact for every cmdlet', () => {
    const supportedPwshCases = [
      'Set-Content -Path target.txt -Value x',
      'Set-Content -LiteralPath target.txt -Value x -Encoding utf8 -NoNewline',
      'Add-Content -Path target.txt -Value x -Encoding utf8 -NoNewline',
      'New-Item -Path target.txt -Value x -ItemType File',
      'Out-File -FilePath target.txt -Encoding utf8 -NoNewline',
      'Out-File -LiteralPath target.txt -Encoding utf8',
      'Get-Content -Path target.txt -Encoding utf8 -Raw',
      'Get-Content -LiteralPath target.txt -Raw',
    ]
    for (const command of supportedPwshCases) {
      const parsed = parsePwshCommand(command)
      expect(parsed.status, command).toBe('supported')
      expect(parsed.executables, command).toHaveLength(1)
      expect(parsed.operations, command).not.toEqual([])
    }

    const rejectedPwshParameters: Record<string, string[]> = {
      'set-content': ['-erroraction SilentlyContinue', '-noclobber', '-stream hidden', '-filter *.txt', '-content x', '-passthru', '-force', '-whatif', '-confirm'],
      'add-content': ['-erroraction SilentlyContinue', '-noclobber', '-stream hidden', '-filter *.txt', '-content x', '-passthru', '-force', '-whatif', '-confirm'],
      'new-item': ['-literalpath other.txt', '-name target.txt', '-force', '-erroraction SilentlyContinue', '-whatif', '-confirm'],
      'out-file': ['-noclobber', '-erroraction SilentlyContinue', '-whatif', '-confirm', '-force', '-append'],
      'get-content': ['-notypeinformation', '-erroraction SilentlyContinue', '-filter *.txt', '-stream hidden', '-whatif', '-confirm', '-force'],
    }
    const baseByCmdlet: Record<string, string> = {
      'set-content': 'Set-Content -Path target.txt -Value x',
      'add-content': 'Add-Content -Path target.txt -Value x',
      'new-item': 'New-Item -Path target.txt',
      'out-file': 'Out-File -FilePath target.txt',
      'get-content': 'Get-Content -Path target.txt',
    }
    for (const [cmdlet, parameters] of Object.entries(rejectedPwshParameters)) {
      for (const parameter of parameters) {
        const parsed = parsePwshCommand(`${baseByCmdlet[cmdlet]} ${parameter}`)
        expect(parsed.status, `${cmdlet} ${parameter}`).toBe('unsupported')
        expect(parsed.executables, `${cmdlet} ${parameter}`).toEqual([])
        expect(parsed.operations, `${cmdlet} ${parameter}`).toEqual([])
        expect(parsed.reason, `${cmdlet} ${parameter}`).toBeTruthy()
      }
    }
  })

  it('rejects PowerShell newlines outside quoted strings', () => {
    const rejected = [
      'Set-Content -Path a.txt\n-Value x',
      'Get-Content -Path a.txt\r\n-Raw',
      'Set-Content -Path a.txt -Value x\nGet-Content -Path a.txt',
    ]
    for (const command of rejected) {
      const parsed = parsePwshCommand(command)
      expect(parsed.status, command).toBe('unsupported')
      expect(parsed.executables, command).toEqual([])
      expect(parsed.operations, command).toEqual([])
    }
    const quoted = parsePwshCommand('Set-Content -Path a.txt -Value "line\ntext"')
    expect(quoted.status).toBe('supported')
    expect(quoted.operations).toEqual([{ op: 'create', path: 'a.txt' }])
  })

  it('rejects unsafe PowerShell parameters across the supported cmdlets', () => {
    const cases = [
      'Get-Content -Path C:\\missing.txt -ErrorAction SilentlyContinue',
      'Set-Content -Path C:\\target.txt -Value x -ErrorAction SilentlyContinue',
      'Out-File -FilePath C:\\target.txt -NoClobber',
      'Set-Content -Path C:\\target.txt -Stream hidden -Value x',
      'New-Item -Path C:\\work -Name target.txt',
    ]
    for (const command of cases) {
      const parsed = parsePwshCommand(command)
      expect(parsed.status, command).toBe('unsupported')
      expect(parsed.executables, command).toEqual([])
      expect(parsed.operations, command).toEqual([])
    }
  })

  it('v0.2: diagnostic stream duplication is allowed in bash commands', () => {
    const pull = parseShellCommand('git pull --ff-only 2>&1')
    expect(pull.status).toBe('supported')
    expect(pull.executables).toEqual(['git'])
    expect(pull.operations).toContainEqual({ op: 'run' })
    const apply = parseShellCommand('python scripts/apply-dsh-plugins.py --apply 2>&1')
    expect(apply.status).toBe('supported')
    expect(apply.operations).toContainEqual({ op: 'run', path: 'scripts/apply-dsh-plugins.py' })
    const withRedirect = parseShellCommand('printf x > target.txt 2>&1')
    expect(withRedirect.status).toBe('supported')
    expect(withRedirect.operations).toContainEqual({ op: 'create', path: 'target.txt' })
    // File-target fd redirects, compound syntax and non-whitelisted executables stay fail-closed.
    for (const command of [
      'git status 2>&1 && echo ok',
      'git status 2> err.log',
      'git status 2>/dev/null',
      'git status 1>&2 && echo ok',
      'noexec x 2>&1',
    ]) {
      const parsed = parseShellCommand(command)
      expect(parsed.status, command).toBe('unsupported')
      expect(parsed.executables, command).toEqual([])
      expect(parsed.operations, command).toEqual([])
    }
  })

  it('v0.2: read-only inspection tools produce read operations in bash', () => {
    const grep = parseShellCommand('grep -n pattern src/feature.ts')
    expect(grep.status).toBe('supported')
    expect(grep.executables).toEqual(['grep'])
    expect(grep.operations).toContainEqual({ op: 'read', path: 'src/feature.ts' })
    expect(parseShellCommand('head -5 logs/out.log').operations).toContainEqual({ op: 'read', path: 'logs/out.log' })
    expect(parseShellCommand('sed s/x/y/g file.txt').operations).toContainEqual({ op: 'read', path: 'file.txt' })
    const inPlace = parseShellCommand('sed -i s/x/y/g file.txt')
    expect(inPlace.status).toBe('unsupported')
    expect(inPlace.operations).toEqual([])
    const chained = parseShellCommand('grep -n pattern src/feature.ts | head -3')
    expect(chained.status).toBe('unsupported')
    expect(chained.operations).toEqual([])
  })

  it('v0.2: pwsh external executables and stream duplication are supported', () => {
    const commit = parsePwshCommand('git commit -m "msg" 2>&1')
    expect(commit.status).toBe('supported')
    expect(commit.executables).toEqual(['git'])
    expect(commit.operations).toEqual([{ op: 'run' }])
    const add = parsePwshCommand('pnpm add dsh-context-guard@0.1.2')
    expect(add.status).toBe('supported')
    expect(add.executables).toEqual(['pnpm'])
    expect(add.operations).toEqual([{ op: 'run', path: 'dsh-context-guard@0.1.2' }])
    const script = parsePwshCommand('python scripts/apply-dsh-plugins.py --apply 2>&1')
    expect(script.status).toBe('supported')
    expect(script.operations).toEqual([{ op: 'run', path: 'scripts/apply-dsh-plugins.py' }])
    const cmdlet = parsePwshCommand('Get-Content -Path docs/README.md -Raw 2>&1')
    expect(cmdlet.status).toBe('supported')
    expect(cmdlet.operations).toEqual([{ op: 'read', path: 'docs/README.md' }])
    // A quoted "2>&1" value stays a value, not a redirect.
    const quotedValue = parsePwshCommand('Set-Content -Path target.txt -Value "2>&1"')
    expect(quotedValue.status).toBe('supported')
    expect(quotedValue.operations).toEqual([{ op: 'create', path: 'target.txt' }])
    for (const command of [
      'git commit -m "msg"; Write-Output done',
      'git push origin main 2>&1; echo "exit=$?"',
      'npm install $PKG',
      'node script.js | Out-File out.txt',
    ]) {
      const parsed = parsePwshCommand(command)
      expect(parsed.status, command).toBe('unsupported')
      expect(parsed.operations, command).toEqual([])
    }
  })

  it('v0.2: subject resolution falls back to the session cwd for shell evidence', () => {
    const pull = evidenceFromPersistedToolResult(
      { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'git pull --ff-only 2>&1' }) },
      { seq: 5, textContent: 'Updating..' },
      1,
      'E0001',
      '/Users/lgr59/Documents/Github/codex-sync',
    )
    expect(pull.outcome).toBe('success')
    expect(pull.subjects).toContain('/Users/lgr59/Documents/Github/codex-sync')
    expect(pull.operations).toContainEqual({ op: 'run', path: '/Users/lgr59/Documents/Github/codex-sync' })
    expect(pull.executables).toEqual(['git'])
    const readFile = evidenceFromPersistedToolResult(
      { callId: 'c2', name: 'read', arguments: JSON.stringify({ file_path: 'src/feature.ts' }) },
      { seq: 6, textContent: 'ok' },
      1,
      'E0002',
      '/work',
    )
    expect(readFile.subjects).toEqual(['/work/src/feature.ts'])
    // A shell builtin is a run without a subject-carrying path.
    const echo = evidenceFromPersistedToolResult(
      { callId: 'c3', name: 'bash', arguments: JSON.stringify({ command: 'echo ok', workdir: '/work' }) },
      { seq: 7, textContent: 'ok' },
      1,
      'E0003',
    )
    expect(echo.operations).toEqual([{ op: 'run' }])
    expect(echo.subjects).toEqual(['/work'])
  })

  it('v0.2: process verbs map scope tasks to run contracts', () => {
    expect(extractOperation('拉取远端最近的两个更新，同步更新插件')).toBe('run')
    expect(extractOperation('我已手动重启，请你收尾，完善文档记录，之后提交并推送。')).toBe('run')
    expect(extractOperation('确认项目测试通过')).toBe('verify')
    expect(extractOperation('runtime check')).toBeUndefined()
  })

  it('v0.2: a macOS-style pull/apply task certifies with run evidence alone', () => {
    const cwd = '/Users/lgr59/Documents/Github/codex-sync'
    const events = [
      { seq: 0, type: 'command/run', data: { commandId: 'c0', name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '拉取远端最近的两个更新，同步更新插件' }], source: { kind: 'user' } } },
      { seq: 2, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'git pull --ff-only 2>&1' }) } },
      { seq: 3, type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'Updating..' }] }], source: { kind: 'tool', callId: 'c1' } } } },
      { seq: 4, type: 'tool/call', data: { turn: 1, step: 2, callId: 'c2', name: 'bash', arguments: JSON.stringify({ command: 'python scripts/apply-dsh-plugins.py --apply 2>&1' }) } },
      { seq: 5, type: 'tool/result', data: { turn: 1, step: 2, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'done' }] }], source: { kind: 'tool', callId: 'c2' } } } },
    ]
    const derived = deriveProjection(events, OPT_IN, { cwd }, true)
    const item = [...derived.projection.items.values()].find((i) => i.kind === 'requirement')
    expect(item?.verification).toMatchObject({ operation: 'run', subject: cwd, surface: 'scope' })
    const result = certifyCheckpoint(derived.projection, [{ itemId: item!.id, evidenceIds: ['E0001', 'E0002'] }], 'C001')
    expect(result.status).toBe('certified')
  })

  it('v0.2: a Windows-style pwsh push task certifies with method identity', () => {
    const events = [
      { seq: 0, type: 'command/run', data: { commandId: 'c0', name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '使用 pwsh 提交并推送本地变更' }], source: { kind: 'user' } } },
      { seq: 2, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: JSON.stringify({ command: 'git commit -am "wrap" 2>&1', workdir: 'C:\\work' }) } },
      { seq: 3, type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'committed' }] }], source: { kind: 'tool', callId: 'c1' } } } },
      { seq: 4, type: 'tool/call', data: { turn: 1, step: 2, callId: 'c2', name: 'pwsh', arguments: JSON.stringify({ command: 'git push origin main 2>&1', workdir: 'C:\\work' }) } },
      { seq: 5, type: 'tool/result', data: { turn: 1, step: 2, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'pushed' }] }], source: { kind: 'tool', callId: 'c2' } } } },
    ]
    const derived = deriveProjection(events, OPT_IN, { cwd: 'C:\\work' }, true)
    const item = [...derived.projection.items.values()].find((i) => i.kind === 'requirement')
    expect(item?.verification).toMatchObject({ operation: 'run', method: 'pwsh', surface: 'scope' })
    const result = certifyCheckpoint(derived.projection, [{ itemId: item!.id, evidenceIds: ['E0001', 'E0002'] }], 'C001')
    expect(result.status).toBe('certified')
  })

  it('v0.2: the dsh CLI is a certifiable run executable in both shells', () => {
    const bash = parseShellCommand('dsh plugin --profile web add dsh-dream-skin@0.3.1 2>&1')
    expect(bash.status).toBe('supported')
    expect(bash.executables).toEqual(['dsh'])
    expect(bash.operations).toContainEqual({ op: 'run', path: 'dsh-dream-skin@0.3.1' })
    const pwsh = parsePwshCommand('dsh plugin --profile web add dsh-dream-skin@0.3.1 2>&1')
    expect(pwsh.status).toBe('supported')
    expect(pwsh.executables).toEqual(['dsh'])
    expect(pwsh.operations).toEqual([{ op: 'run', path: 'dsh-dream-skin@0.3.1' }])
    const background = parseShellCommand('dsh plugin list 2>&1 &')
    expect(background.status).toBe('unsupported')
  })

  it('v0.2: an install task closes with a dsh CLI run or a clean state check', () => {
    const cwd = '/Users/lgr59/Documents/Github/codex-sync'
    const make = (command: string, callId: string) => ([
      { seq: 0, type: 'command/run', data: { commandId: 'c0', name: 'context-guard', args: 'on', source: { kind: 'user' } } },
      { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '请帮我安装 dsh-dream-skin 换肤插件' }], source: { kind: 'user' } } },
      { seq: 2, type: 'tool/call', data: { turn: 1, step: 1, callId, name: 'bash', arguments: JSON.stringify({ command }) } },
      { seq: 3, type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'done' }] }], source: { kind: 'tool', callId } } } },
    ])
    for (const command of ['dsh plugin --profile web add dsh-dream-skin@0.3.1 2>&1', 'grep -n dsh-dream-skin config/dsh/plugins.toml']) {
      const derived = deriveProjection(make(command, 'c1'), OPT_IN, { cwd }, true)
      const item = [...derived.projection.items.values()].find((i) => i.kind === 'requirement')
      expect(item?.verification).toMatchObject({ operation: 'run', surface: 'scope' })
      const result = certifyCheckpoint(derived.projection, [{ itemId: item!.id, evidenceIds: ['E0001'] }], 'C001')
      expect(result.status, command).toBe('certified')
    }
    // The piped config-dump form the original session used stays fail-closed.
    const piped = parseShellCommand('./dsh dump-config 2>&1 | grep dsh-dream-skin')
    expect(piped.status).toBe('unsupported')
    expect(piped.operations).toEqual([])
  })
