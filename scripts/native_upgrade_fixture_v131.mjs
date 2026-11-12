/** Exact predecessor binding bytes in a nonempty official persistence lifecycle. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, sep } from 'node:path'

export function predecessorActivationFixture() {
  const fixture = JSON.parse(readFileSync(new URL('../tests/fixtures/upgrade/legacy-0.13.0-activation.json', import.meta.url), 'utf8'))
  assert.equal(fixture.schema, 'dsh-predecessor-activation-fixture/v1')
  assert.equal(fixture.predecessorVersion, '0.13.0')
  assert.equal(fixture.sourceCommit, '650a952a7d44d4be2b9019dadc2f11e5104ff06e')
  assert.equal(fixture.rows.length, 6)
  for (const row of fixture.rows) {
    assert.equal(createHash('sha256').update(row.binding).digest('hex'), row.bindingSha256)
    assert.equal(JSON.parse(row.binding).identity.id, row.header.id)
    assert.equal(JSON.parse(row.binding).initialMode, row.mode)
    for (const compression of ['none', 'zstd']) {
      const log = row.logs[compression]
      const bytes = Buffer.from(log.bytes, 'base64')
      assert.equal(bytes.toString('base64'), log.bytes)
      assert.equal(createHash('sha256').update(bytes).digest('hex'), log.sha256)
    }
  }
  return fixture
}

export async function runPredecessorActivationFixture({ ctx, config, domain, SessionId, createUserMessage, createProbeAgent,
  timed = (_label, fn) => fn() }) {
  const rows = predecessorActivationFixture().rows.filter(row => row.profile === config.profile)
  assert.equal(rows.length, 2, 'explicit native profile required')
  const modeRoot = domain.resolveActivationBindingsRoot(process.env.DSH_HOME)
  mkdirSync(modeRoot, { recursive: true, mode: 0o700 })
  for (const row of rows) {
    const id = SessionId(row.header.id)
    assert.equal(await ctx.sessionPersistence.stat(id), undefined, 'predecessor fixture must be unused')
    const stored = await timed('upgrade_create', () => ctx.sessionPersistence.create({ ...row.header, id }))
    let prefix
    try {
      await stored.flush()
    } finally { await stored.close() }
    // Seed only this newly created, closed, task-owned fixture with the exact
    // physical bytes emitted by the predecessor backend. No user log changes.
    const location = (await ctx.sessionPersistence.stat(id)).location
    assert.equal(location.kind, 'jsonl')
    const inside = relative(realpathSync(process.env.DSH_HOME), realpathSync(dirname(location.path)))
    assert.ok(inside && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
    assert.ok(lstatSync(location.path).isFile() && !lstatSync(location.path).isSymbolicLink())
    assert.match(location.path, /\.jsonl(?:\.zstd)?$/)
    const physical = Buffer.from(row.logs[location.path.endsWith('.zstd') ? 'zstd' : 'none'].bytes, 'base64')
    writeFileSync(location.path, physical)
    assert.deepEqual(readFileSync(location.path), physical)
    const original = await ctx.sessionPersistence.open(id, 'read')
    try {
      prefix = (await original.read()).events
      assert.equal(prefix.filter(event => event.type === 'user/message').length, 2)
    } finally { await original.close() }
    const identity = domain.sessionBirthIdentity(row.header, 0)
    const path = domain.activationBindingPath(modeRoot, identity.id)
    writeFileSync(path, row.binding, { flag: 'wx', mode: 0o600 })
    for (let i = 0; i < 2; i++) {
      const handle = await timed('open_predecessor_upgrade', () => createProbeAgent(ctx, id, config.workRoot, true))
      try {
        const session = handle.agent.session
        assert.deepEqual(session.snapshotEvents().slice(0, prefix.length), prefix)
        assert.deepEqual(domain.sessionBirthIdentity(session.header, session.inheritedEventCount), identity)
        assert.equal(domain.readActivationBinding(modeRoot, identity).mode, row.mode)
        assert.equal(domain.resolveSessionActivation(modeRoot, identity,
          { activation: row.mode === 'always' ? 'opt-in' : 'always', activationSource: 'default' }, 'resume', true).mode, row.mode)
        assert.equal(domain.resolveSessionActivation(modeRoot, identity,
          { activation: row.mode === 'always' ? 'opt-in' : 'always', activationSource: 'explicit' }, 'resume', true).reasonCode, 'activation_mode_conflict')
        assert.equal(readFileSync(path, 'utf8'), row.binding, 'no re-adopt or byte rewrite')
        assert.equal(await ctx.sessions.flush(session), true)
        assert.deepEqual(readFileSync(location.path).subarray(0, physical.length), physical, 'old physical log prefix is immutable')
      } finally { await timed('dispose_predecessor_upgrade', () => handle.dispose()) }
    }
    // This pending file is an injected negative-control input, never a real
    // incomplete publication. Removing only our injected input after observing
    // refusal is fixture cleanup; it does not claim publication recovery.
    writeFileSync(`${path}.pending`, row.binding, { flag: 'wx', mode: 0o600 })
    assert.equal(domain.readActivationBinding(modeRoot, identity).reasonCode, 'activation_publication_incomplete')
    unlinkSync(`${path}.pending`)
    const missing = { ...identity, id: identity.id + '-never-bound' }
    assert.equal(domain.resolveSessionActivation(modeRoot, missing, { activation: 'always' }, 'resume', true).reasonCode, 'activation_mode_unknown')
    const damaged = { ...identity, id: identity.id + '-damaged' }
    const damagedPath = domain.activationBindingPath(modeRoot, damaged.id)
    const damagedBytes = JSON.stringify({ ...JSON.parse(row.binding), identity: damaged })
    writeFileSync(damagedPath, damagedBytes, { flag: 'wx', mode: 0o600 })
    assert.equal(domain.readActivationBinding(modeRoot, damaged).reasonCode, 'activation_binding_digest_invalid')
    assert.equal(domain.writeActivationBinding(modeRoot, damaged, row.mode, 'fresh_creation', '1'.repeat(64)).reasonCode, 'activation_binding_digest_invalid')
    assert.equal(readFileSync(damagedPath, 'utf8'), damagedBytes)
    const reader = await ctx.sessionPersistence.open(id, 'read')
    try { assert.deepEqual((await reader.read()).events.slice(0, prefix.length), prefix) }
    finally { await reader.close() }
    assert.equal(readFileSync(path, 'utf8'), row.binding)
  }
  return { positive: true, negative: true }
}
