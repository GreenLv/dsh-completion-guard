import { RC015_HOST_PACKAGES } from '../../src/domain/rc015-host.js'
import { evaluateHostLock } from '../../src/domain/host-lock.js'
import { it, expect } from 'vitest'
import { deriveProjection } from '../../src/domain/derive.js'
import { createCheckpointTool } from '../../src/tools/checkpoint.js'
const probeModule = new URL('../../scripts/native_host_probe.mjs', import.meta.url).href

it('requires a completed successful foreground command before requesting a test certificate', async () => {
 const { assertTestCommandSucceeded, shellTerminalFacts } = await import(probeModule)
 const success = { kind: 'foreground', exitCode: 0, timedOut: false, aborted: false }
 expect(() => assertTestCommandSucceeded(success)).not.toThrow()
 for (const value of [undefined, {}, { ...success, exitCode: 1 }, { ...success, exitCode: undefined },
  { ...success, kind: 'background' }, { ...success, timedOut: true }, { ...success, aborted: true }]) {
  expect(() => assertTestCommandSucceeded(value)).toThrow()
 }
 expect(shellTerminalFacts({ ...success, exitCode: 1, stdout: { text: 'private output' }, stderr: { text: 'private path' } }))
  .toEqual({ kind: 'foreground', exit_code: 1, timed_out: false, aborted: false })
})

it.each(['short', 'long'])('retrieves a %s Windows test template through the native driver and certifies it', async length => {
 const { readProbeTestBinding } = await import(probeModule)
 const cwd = 'C:\\Users\\green\\AppData\\Local\\Temp\\' + (length === 'long' ? 'isolated-home-'.repeat(18) : '') + 'dsh-guard-host-abcdefgh\\work'
 const p = deriveProjection([
  { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Run pnpm test.' }] } },
  { seq: 2, type: 'tool/call', data: { callId: 'native-12345-1', name: 'pwsh', arguments: JSON.stringify({ command: 'pnpm test' }) } },
  { seq: 3, type: 'tool/result', data: { message: { source: { callId: 'native-12345-1' }, content: [{ type: 'text', text: '> node fixture.cjs' }] } } },
 ], { activation: 'always' }, { cwd }, true, evaluateHostLock(RC015_HOST_PACKAGES, { platform: 'windows', profileKind: 'web' })).projection
 const tool = createCheckpointTool(() => p, () => {})
 const call = async (name: string, args: never) => {
  expect(name).toBe('context_guard_checkpoint')
  return tool.execute(args, undefined as never)
 }
 const page = await tool.execute({ bindings: [] }, undefined as never) as { open_items: Array<{ omitted?: boolean; binding_template?: unknown }> }
 expect(page.open_items[0].omitted === true).toBe(length === 'long')
 if (length === 'long') expect(page.open_items[0].binding_template).toBeUndefined()
 const binding = await readProbeTestBinding(call, page)
 expect(binding).toMatchObject({ semantic_action: 'test', evidence_ids: ['E0001'] })
 expect(await tool.execute({ bindings: [binding] }, undefined as never)).toMatchObject({ status: 'certified', certificate: expect.any(Object) })
})
