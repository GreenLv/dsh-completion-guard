import { describe, expect, it } from 'vitest'
import { captureClause } from '../../src/domain/capture.js'
import { deriveProjection, PROTOCOL_V5_NOTICE } from '../../src/domain/derive.js'
import { type DerivedEnvelope } from '../../src/domain/types.js'
import { authorizeMutationFromProjection } from '../../src/runtime.js'
import { createPrepareTool } from '../../src/tools/prepare.js'

// Contract-selected rows, independent of extractor output. Both production
// consumers must refuse every offered resolution of an ambiguous identity.
const ambiguous = [
  { entry: 'ordinary', field: 'branch/case', text: '提交仓库 /repo-a 分支 main 或 Main。', action: 'commit', targets: [{ repository: '/repo-a', branch: 'main' }, { repository: '/repo-a', branch: 'Main' }] },
  { entry: 'ordinary', field: 'refspec/case', text: 'Push repository /repo-a remote origin refspec main:main or main:Main.', action: 'push', targets: [{ repository: '/repo-a', remote: 'origin', refspec: 'main:main' }, { repository: '/repo-a', remote: 'origin', refspec: 'main:Main' }] },
  { entry: 'ordinary', field: 'refspec/Chinese', text: '推送仓库 /repo-a 远端 origin 引用规范 main:main 或 main:release。', action: 'push', targets: [{ repository: '/repo-a', remote: 'origin', refspec: 'main:main' }, { repository: '/repo-a', remote: 'origin', refspec: 'main:release' }] },
  { entry: 'ordinary', field: 'package/version', text: 'install package foo@1.0.0 or foo@2.0.0.', action: 'install', targets: [{ package_id: 'foo', version: '1.0.0' }, { package_id: 'foo', version: '2.0.0' }] },
  { entry: 'ordinary', field: 'inline/label conflict', text: 'install package foo@1.0.0 version 2.0.0.', action: 'install', targets: [{ package_id: 'foo', version: '1.0.0' }, { package_id: 'foo', version: '2.0.0' }] },
  { entry: 'restatement', field: 'version', text: '把应用包 foo 版本 0.6.3 配置档 default 明确为 apply package foo version 0.6.4 or 0.6.5 profile default。', action: 'apply', targets: [{ package_id: 'foo', version: '0.6.4', profile: 'default' }, { package_id: 'foo', version: '0.6.5', profile: 'default' }] },
  { entry: 'restatement', field: 'profile', text: '把应用包 foo 版本 0.6.3 配置档 default 明确为 apply package foo version 0.6.4 profile web or prod。', action: 'apply', targets: [{ package_id: 'foo', version: '0.6.4', profile: 'web' }, { package_id: 'foo', version: '0.6.4', profile: 'prod' }] },
  { entry: 'restatement', field: 'service', text: 'Rebind restart service api as restart service worker or cache.', action: 'restart', targets: [{ service_id: 'worker' }, { service_id: 'cache' }] },
]

function derive(text: string) {
  const events: DerivedEnvelope[] = [
    { seq: 0, type: 'user/message', data: { source: { kind: 'plugin', plugin: 'context-guard', form: 'notice' }, content: [{ type: 'text', text: PROTOCOL_V5_NOTICE }] } },
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'user/message', data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text }] } },
  ]
  return deriveProjection(events, { activation: 'always' }, { cwd: '/srv/app', sessionHeader: { version: 3, id: 'target-family', createdAt: 1 } }, true).projection
}

describe('target family / entry × identity field × consumer', () => {
  it.each(ambiguous)('$entry / $field rejects both supplied candidates', async ({ text, action, targets }) => {
    expect(captureClause(text, 'm1', 'R001', 1, { cwd: '/srv/app' }).targetCaptureStatus).toBe('clarification_required')
    const projection = derive(text)
    const items = [...projection.items.values()]
    expect(items).toHaveLength(1)
    const item = items[0]!
    expect(item.targetCaptureStatus).toBe('clarification_required')
    for (const target of targets) {
      const decision = authorizeMutationFromProjection(projection, {
        action, contractItemId: item.id, contractItemRevision: item.revision, resolvedTarget: target,
      } as never)
      expect(decision.status).toBe('denied')
      expect(decision.reasonCode).toBe('mutation_target_clarification_required')
      const prepared = await createPrepareTool({ getProjection: () => projection }).execute({
        item_id: item.id, semantic_action: action, requested_target: target,
      } as never, undefined as never) as { compatibility: { status: string; reason_codes: string[] } }
      expect(prepared.compatibility.status).toBe('blocked')
      expect(prepared.compatibility.reason_codes).toContain('target_clarification_required')
    }
  })

  it.each([
    'Restart service api.',
    'Rebind restart service worker as restart service api.',
  ])('positive control: %s keeps preparation and execution usable', async (text) => {
    const projection = derive(text)
    const items = [...projection.items.values()]
    expect(items).toHaveLength(1)
    const item = items[0]!
    const target = { service_id: 'api' }
    expect(authorizeMutationFromProjection(projection, {
      action: 'restart', contractItemId: item.id, contractItemRevision: item.revision, resolvedTarget: target,
    } as never).status).toBe('authorized')
    const prepared = await createPrepareTool({ getProjection: () => projection }).execute({
      item_id: item.id, semantic_action: 'restart', requested_target: target,
    } as never, undefined as never) as { compatibility: { status: string } }
    expect(prepared.compatibility.status).toBe('compatible')
  })
})
