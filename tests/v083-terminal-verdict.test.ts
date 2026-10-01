import { describe, expect, it } from 'vitest'
import { shellReadbackOutcome } from '../src/domain/evidence.js'

// CG-083-R4: the observer's terminal verdict reuses the authoritative
// resolution and refuses contradictions between the run's own declaration
// and the rendered markers.

const clean = (text: string) => ({ meta: undefined, textContent: text })

describe('CG-083-R4 shell readback verdict', () => {
  it('keeps clean unmarked bash results successful', () => {
    expect(shellReadbackOutcome('bash', {}, clean('commit summary'))).toBe('success')
    expect(shellReadbackOutcome('pwsh', {}, clean('commit summary'))).toBe('success')
  })

  it('refuses a structured failure even when stdout looks clean', () => {
    // The original review contradiction: contextGuardProcess declares exit 1
    // while the renderer printed no marker.
    const declaredFailure = { meta: { contextGuardProcess: { exitCode: 1 } }, textContent: 'commit summary' }
    // The run's own declaration of failure outranks the unmarked-tail success
    // shortcut, so the verdict is the stronger refusal, never "success".
    expect(shellReadbackOutcome('bash', {}, declaredFailure)).toBe('failure')
    expect(shellReadbackOutcome('bash', {}, declaredFailure)).not.toBe('success')
  })

  it('reports a structured failure that the markers agree with', () => {
    const agreed = { meta: { contextGuardProcess: { exitCode: 1 } }, textContent: 'output\n[exit code: 1]' }
    expect(shellReadbackOutcome('bash', {}, agreed)).toBe('failure')
  })

  it('keeps a declared success that contradicts a rendered failure marker unknown', () => {
    const contradiction = { meta: { contextGuardProcess: { exitCode: 0 } }, textContent: 'output\n[exit code: 1]' }
    expect(shellReadbackOutcome('bash', {}, contradiction)).toBe('unknown')
  })

  it('treats a declared signal as failure', () => {
    const signal = { meta: { contextGuardProcess: { signal: 'SIGKILL' } }, textContent: 'partial output' }
    expect(shellReadbackOutcome('bash', {}, signal)).toBe('failure')
  })

  it('keeps backgrounded and truncated results out of success', () => {
    expect(shellReadbackOutcome('bash', { run_in_background: true }, clean('ok'))).toBe('unknown')
    expect(shellReadbackOutcome('bash', {}, clean('ok [output truncated; 10 lines dropped]'))).toBe('unknown')
  })

  it('fails on a rendered nonzero exit marker alone', () => {
    expect(shellReadbackOutcome('bash', {}, clean('hook output\n[exit code: 1]'))).toBe('failure')
  })
})
