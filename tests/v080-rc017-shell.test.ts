import { describe, expect, it } from 'vitest'
import { apply as bash } from '@deepseek-ai/dsh-tool-bash'
import { apply as pwsh } from '@deepseek-ai/dsh-tool-pwsh'
import { createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { deriveProjection, PROTOCOL_V6_NOTICE } from '../src/domain/derive.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'

function renderer(apply: typeof bash | typeof pwsh) {
  let tool: { output: { render(args: unknown, value: unknown): Array<{ text: string }> } } | undefined
  apply({ shell: {}, get: () => undefined, systemPrompt: { section: () => {}, getSectionOrder: () => 0 },
    tools: { register: (value: typeof tool) => { tool = value; return () => {} } },
  } as never, { enableRunInBackground: false })
  return (value: unknown) => tool!.output.render({}, value).map(p => p.text).join('\n')
}
function evidence(name: 'bash' | 'pwsh', text: string) {
  const host = { ...evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: name === 'bash' ? 'posix' : 'windows', profileKind: 'headless' }), auditedForegroundRenderers: [name] }
  const events = [
    { seq: 0, type: 'user/message', data: { source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }] } },
    { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Run npm test.' }] } },
    { seq: 2, type: 'tool/call', data: { callId: 'run', name, arguments: JSON.stringify({ command: 'npm test', workdir: '/work' }) } },
    { seq: 3, type: 'tool/result', data: { message: createToolResultMessage({ callId: 'run' as never, content: [{ type: 'text', text }], isError: false }) } },
  ]
  return [...deriveProjection(events, { activation: 'always' }, { cwd: '/work' }, true, host).projection.evidence.values()][0]
}

for (const [name, apply] of [['bash', bash], ['pwsh', pwsh]] as const) describe(`rc.2 ${name} published renderer`, () => {
  const render = renderer(apply)
  const result = (extra = {}) => ({ kind: 'foreground', stdout: { text: 'PASS', truncated: false }, stderr: { text: '', truncated: false }, exitCode: 0, signal: null, timedOut: false, ...extra })
  it('accepts terminal success, rejects nonzero, cancellation and runner failure', () => {
    expect(evidence(name, render(result())).outcome).toBe('success')
    for (const extra of [{exitCode: 1}, {stopped: 'cancelled'}, {sandbox: {mode: 'workspace-write', runnerFailed: true, denied: true}}]) expect(evidence(name, render(result(extra))).outcome).not.toBe('success')
  })
  it('never treats promoted partial stdout as terminal, including trailing explanation', () => {
    for (const output of ['PASS', 'PASS\n[exit code: 0]', '[exit code: 0]\n']) {
      const text = render({kind: 'promoted', jobId: `${name}-1`, timeoutMs: 10, output})
      expect(text).toContain('The command keeps running')
      expect(evidence(name, text)).toMatchObject({ outcome: 'unknown', processFacts: {outcome: 'unknown', outcomeReason: 'backgrounded'} })
    }
    expect(evidence(name, render({kind:'background',jobId:`${name}-1`})).outcome).toBe('unknown')
  })
  it('does not certify lossy output merely because a success marker remains', () => {
    const text = render(result({ stdout: {text:'PASS\n[exit code: 0]',truncated:true,spillPath:'/tmp/full-output'} }))
    expect(evidence(name,text).outcome).toBe('unknown')
  })
})
