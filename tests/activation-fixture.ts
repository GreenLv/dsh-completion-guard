import { afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/runtime.js'
import { sessionBirthIdentity } from '../src/domain/session-activation.js'
import { readActivationBinding, writeActivationBinding } from '../src/domain/activation-bindings.js'
import { resolveConfig } from '../src/config.js'
const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
/** Existing lifecycle fixtures have an explicitly selected historical mode.
 * Adopt that identity before attach; do not weaken the production source gate. */
export const applyWithFixtureActivation: typeof apply = (ctx, config = {}, seams = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'guard-mode-fixture-')); directories.push(root)
  const resolved = resolveConfig(config)
  ctx.on('agent/created', ({ agent }) => {
    const result = writeActivationBinding(root, sessionBirthIdentity(agent.session.header, agent.session.inheritedEventCount),
      resolved.activation, 'legacy_adoption', '0'.repeat(64))
    if (result.status !== 'bound') throw new Error(result.reasonCode)
    return undefined
  })
  return apply(ctx, config, { ...seams, activationBindingsRoot: root })
}
export function fixtureActivationReader(session: { header: unknown; inheritedEventCount: unknown }, mode: 'opt-in' | 'always'): () => ReturnType<typeof readActivationBinding> {
  const root = mkdtempSync(join(tmpdir(), 'guard-bound-fixture-')); directories.push(root)
  const identity = sessionBirthIdentity(session.header, session.inheritedEventCount)
  writeActivationBinding(root, identity, mode, 'legacy_adoption', '0'.repeat(64))
  return () => readActivationBinding(root, identity)
}
