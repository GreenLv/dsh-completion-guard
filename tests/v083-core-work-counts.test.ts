import { expect, it, vi } from 'vitest'
import * as stopPolicy from '../src/domain/stop-policy.js'
import { deriveProjection, PROTOCOL_V6_NOTICE } from '../src/domain/derive.js'
import { sessionCoreSnapshot } from '../src/core-v2/session.js'
import { evaluateHostLock, EXPECTED_HOST_PACKAGES } from '../src/domain/host-lock.js'

it('constructs current action bases once per snapshot, independent of item count', () => {
  const events = [
    { seq: 1, type: 'user/message', data: { source: { kind: 'context-guard', plugin: 'context-guard', form: 'notice' },
      content: [{ type: 'text', text: PROTOCOL_V6_NOTICE }] } },
    { seq: 2, type: 'user/message', data: { source: { kind: 'user' },
      content: [{ type: 'text', text: Array.from({ length: 80 }, (_, i) => `修改 src/file${i}.ts。`).join('\n') }] } },
  ]
  const host = evaluateHostLock(EXPECTED_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' })
  const projection = deriveProjection(events as never, { activation: 'always' }, { cwd: '/fixture' }, true, host).projection
  projection.durabilityWatermark = 'confirmed'
  expect(projection.items.size).toBeGreaterThanOrEqual(80)
  const bases = vi.spyOn(stopPolicy, 'currentActionBases')
  try {
    expect(sessionCoreSnapshot(events as never, projection)).toBeDefined()
    expect(bases).toHaveBeenCalledTimes(1)
  } finally { bases.mockRestore() }
})
