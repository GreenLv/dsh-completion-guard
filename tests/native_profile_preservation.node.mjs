import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { captureOfficialResolution, checkControlPlacement, classifyWorkspaceCache, compareGuardConfiguration,
  compareNonGuardConfiguration, compareResolution, configurationShape, resolutionObservation,
  sealResolution, verifyResolution } from '../scripts/native_profile_preservation.mjs'

const key = Buffer.alloc(32, 7)
const begin = '# >>> BEGIN DSH COMPLETION GUARD HOST LOCK (managed) >>>'
const end = '# <<< END DSH COMPLETION GUARD HOST LOCK (managed) <<<'

test('entry positions keep structural identities but redact configuration keys and scalars', () => {
  const rows = [{ id: 'group', group: true, config: [{ id: 'plugin', name: '@x/plugin', config: {
    id: '中文 私密值', name: 'secret value', password: 'very-secret', expression: { __jsExpr: 'private expression' }, nested: { privateKey: 42 },
  } }] }]
  const shape = JSON.stringify(configurationShape(rows))
  for (const privateValue of ['中文', 'secret', 'password', '"expression":', 'privateKey', '42']) assert.equal(shape.includes(privateValue), false)
  assert.match(shape, /unevaluated_expression/)
  assert.match(shape, /@x\/plugin/)
  assert.throws(() => configurationShape([{ id: 'bad id' }]), /entry_identifier_invalid/)
  assert.throws(() => configurationShape([{ id: 'group', group: true, config: {} }]), /entry_group_config_invalid/)
  assert.notDeepEqual(configurationShape([{ id: 'a' }, { id: 'b' }]), configurationShape([{ id: 'b' }, { id: 'a' }]))
})

test('non-Guard values are compared separately and never returned', () => {
  const before = [{ id: 'other', config: { password: 'private', name: '中文 名' } }, { id: 'context-guard', disabled: true }]
  const after = structuredClone(before); after[1].disabled = false
  assert.equal(compareNonGuardConfiguration(before, after).status, 'matched')
  after[0].config.password = 'changed'
  assert.equal(compareNonGuardConfiguration(before, after).status, 'changed')
  assert.equal(JSON.stringify(compareNonGuardConfiguration(before, after)).includes('private'), false)
  assert.throws(() => compareNonGuardConfiguration([{ id: 'other', name: 'dsh-completion-guard' }], []), /ambiguous/)
})

test('resolution observations bind profile and carrier and reject altered receipts', () => {
  const input = { profile: '/actual/profile', carrier: 'exact carrier', entries: [
    { name: 'dep', version: '1', scope: 'profile', declarer: '/actual/profile', packageDir: '/shared/dep' },
    { name: 'dsh-completion-guard', version: '1', scope: 'profile', declarer: '/actual/profile', packageDir: '/guard' },
  ], linkedRoots: [], localPackageNames: ['dep', 'dsh-completion-guard'] }
  const before = resolutionObservation(input, key)
  const signed = sealResolution(before, key, 'before')
  assert.deepEqual(verifyResolution(signed, key), { ...before, phase: 'before' })
  assert.throws(() => verifyResolution({ ...signed, entries: 999 }, key), /authentication_failed/)
  assert.throws(() => verifyResolution(signed, Buffer.alloc(32, 8)), /authentication_failed/)
  assert.equal(compareResolution(before, resolutionObservation({ ...input, profile: '/backup/profile' }, key)).status, 'changed_or_unbound')
  const changed = structuredClone(input); changed.entries[0].packageDir = '/other/dep'
  assert.equal(compareResolution(before, resolutionObservation(changed, key)).status, 'changed_or_unbound')
  const badScope = structuredClone(input); badScope.entries[0].scope = 'unknown'
  assert.throws(() => resolutionObservation(badScope, key), /resolution_row_invalid/)
  const ordered = { ...input, entries: [input.entries[0], { ...input.entries[0], name: 'next', packageDir: '/shared/next' }] }
  assert.equal(compareResolution(resolutionObservation(ordered, key), resolutionObservation({ ...ordered, entries: [...ordered.entries].reverse() }, key)).status, 'changed_or_unbound')
  assert.throws(() => resolutionObservation({ ...input, linkedRoots: [{ name: 'missing-path' }] }, key), /linked_roots_invalid/)
  assert.throws(() => resolutionObservation({ ...input, linkedRoots: [{ name: 'duplicate', realPath: '/one' }, { name: 'duplicate', realPath: '/two' }] }, key), /linked_roots_invalid/)
  assert.equal(JSON.stringify(signed).includes('/actual/profile'), false)
})

test('real SDK ignores only Guard direct-link upgrade and detects other link drift', async t => {
  const pnpm = new URL('../node_modules/.pnpm/', import.meta.url)
  let candidates
  try { candidates = readdirSync(pnpm).filter(name => name.startsWith('@deepseek-ai+dsh-app-boot@0.2.2-rc.3_')) } catch { candidates = [] }
  if (candidates.length !== 1) return t.skip('matching installed SDK unavailable')
  const bootPath = fileURLToPath(new URL(`${candidates[0]}/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`, pnpm))
  const boot = await import(pathToFileURL(bootPath).href)
  const root = mkdtempSync(join(tmpdir(), 'dsh-real-link-'))
  try {
    const home = join(root, 'home'), profile = join(home, 'profiles', 'headless'), app = join(root, 'app'), modules = join(profile, 'node_modules')
    const oldGuard = join(root, 'old-guard'), newGuard = join(root, 'new-guard'), oldOther = join(root, 'old-other'), newOther = join(root, 'new-other')
    for (const path of [modules, app, oldGuard, newGuard, oldOther, newOther]) mkdirSync(path, { recursive: true })
    for (const [path, name, version] of [[oldGuard, 'dsh-completion-guard', '0.13.1'], [newGuard, 'dsh-completion-guard', '0.13.2'], [oldOther, 'other', '1'], [newOther, 'other', '1']]) {
      writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version }))
    }
    const anchor = join(app, 'package.json')
    writeFileSync(anchor, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.3' }))
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { 'dsh-completion-guard': '0.13.1', other: '1' }, dsh: { profile: { bundles: [] } } }))
    const guardLink = join(modules, 'dsh-completion-guard'), otherLink = join(modules, 'other')
    const link = (source, target) => symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir')
    try { link(oldGuard, guardLink); link(oldOther, otherLink) } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('directory link capability unavailable')
      throw error
    }
    const args = { boot, anchor, profile, home, carrier: { executable: process.execPath, bootModule: bootPath, driver: bootPath, modules: [] } }
    const before = await captureOfficialResolution(args, key)
    unlinkSync(guardLink); link(newGuard, guardLink)
    assert.equal(compareResolution(before, await captureOfficialResolution(args, key)).status, 'matched')
    unlinkSync(otherLink); link(newOther, otherLink)
    assert.equal(compareResolution(before, await captureOfficialResolution(args, key)).status, 'changed_or_unbound')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('existing official SDK resolves a synthetic original profile before and after change', async t => {
  const pnpm = new URL('../node_modules/.pnpm/', import.meta.url)
  let candidates
  try { candidates = readdirSync(pnpm).filter(name => name.startsWith('@deepseek-ai+dsh-app-boot@0.2.2-rc.3_')) } catch { candidates = [] }
  if (candidates.length !== 1) return t.skip('matching installed SDK unavailable')
  const bootPath = fileURLToPath(new URL(`${candidates[0]}/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`, pnpm))
  const boot = await import(pathToFileURL(bootPath).href)
  const root = mkdtempSync(join(tmpdir(), 'dsh-real-resolver-'))
  try {
    const home = join(root, 'home'), profile = join(home, 'profiles', 'headless'), app = join(root, 'app'), dep = join(profile, 'node_modules', 'fixture-dep'), bundle = join(profile, 'node_modules', 'fixture-bundle'), direct = join(profile, 'node_modules', 'direct-non-guard')
    for (const path of [profile, app, dep, bundle, direct]) mkdirSync(path, { recursive: true })
    const anchor = join(app, 'package.json')
    writeFileSync(anchor, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.3' }))
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { 'fixture-bundle': '1.0.0', 'direct-non-guard': '^1' }, dsh: { profile: { bundles: ['fixture-bundle'] } } }))
    writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'fixture-bundle', version: '1.0.0', dependencies: { 'fixture-dep': '1.0.0' }, dsh: { bundle: { patch: [] } } }))
    writeFileSync(join(direct, 'package.json'), JSON.stringify({ name: 'direct-non-guard', version: '1.0.0' }))
    writeFileSync(join(dep, 'package.json'), JSON.stringify({ name: 'fixture-dep', version: '1.0.0' }))
    const args = { boot, anchor, profile, home, carrier: { executable: process.execPath, bootModule: bootPath, driver: bootPath, modules: [] } }
    const before = await captureOfficialResolution(args, key)
    assert.ok(before.entries >= 2)
    assert.equal(compareResolution(before, await captureOfficialResolution(args, key)).status, 'matched')
    writeFileSync(join(dep, 'package.json'), JSON.stringify({ name: 'fixture-dep', version: '2.0.0' }))
    assert.equal(compareResolution(before, await captureOfficialResolution(args, key)).status, 'changed_or_unbound')
    writeFileSync(join(dep, 'package.json'), JSON.stringify({ name: 'fixture-dep', version: '1.0.0' }))
    writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'fixture-bundle', version: '2.0.0', dependencies: { 'fixture-dep': '1.0.0' }, dsh: { bundle: { patch: [] } } }))
    assert.equal(compareResolution(before, await captureOfficialResolution(args, key)).status, 'changed_or_unbound')
    writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'fixture-bundle', version: '1.0.0', dependencies: { 'fixture-dep': '1.0.0' }, dsh: { bundle: { patch: [] } } }))
    writeFileSync(join(direct, 'package.json'), JSON.stringify({ name: 'direct-non-guard', version: '1.1.0' }))
    assert.equal(compareResolution(before, await captureOfficialResolution(args, key)).status, 'changed_or_unbound')
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { missing: '^1' }, dsh: { profile: { bundles: [] } } }))
    await assert.rejects(captureOfficialResolution(args, key), /declared_dependency_unresolved/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('actual capture calls official boot resolver with the original physical profile', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-preservation-'))
  try {
    const profile = join(root, 'profile'), backup = join(root, 'backup'), home = join(root, 'home')
    const dependency = join(root, 'dep'), anchor = join(root, 'anchor'), exe = join(root, 'node'), mod = join(root, 'boot')
    for (const path of [profile, backup, home, dependency]) mkdirSync(path)
    writeFileSync(anchor, 'anchor'); writeFileSync(exe, 'exe'); writeFileSync(mod, 'module')
    writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: 'dep', version: '1' }))
    let seen
    const boot = {
      readProfileManifest: () => ({ dsh: { profile: { bundles: [] } } }),
      createRuntimeResolution: async input => { seen = input.profile.dir; return { entries: [
        { name: 'dep', scope: 'profile', declarer: input.profile.dir, packageDir: dependency },
      ], linkedRoots: [], localPackageNames: [] } },
    }
    const args = { boot, anchor, profile, home, carrier: { executable: exe, bootModule: mod, driver: mod, modules: [] } }
    const before = await captureOfficialResolution(args, key)
    assert.equal(seen, realpathSync(profile))
    assert.equal(compareResolution(before, await captureOfficialResolution(args, key)).status, 'matched')
    assert.equal(compareResolution(before, await captureOfficialResolution({ ...args, profile: backup }, key)).status, 'changed_or_unbound')
    writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: 'dep', version: '2' }))
    assert.equal(compareResolution(before, await captureOfficialResolution(args, key)).status, 'changed_or_unbound')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('workspace cache accepts only the declared exact ordering delta and same workspace bytes', () => {
  const before = { lastValidatedTimestamp: 1, settings: { minimumReleaseAgeExclude: ['a', 'b'], offline: true }, version: 1 }
  const after = structuredClone(before); after.lastValidatedTimestamp = 2; after.settings.minimumReleaseAgeExclude.reverse()
  const declaration = { pnpmVersion: '11.22.0', beforeOrder: ['a', 'b'], afterOrder: ['b', 'a'] }
  const workspace = Buffer.from('original')
  assert.equal(classifyWorkspaceCache(before, after, declaration, workspace, workspace).status, 'declared_cache_delta_only')
  assert.throws(() => classifyWorkspaceCache(before, after, declaration, workspace, Buffer.from('changed')), /declaration_invalid/)
  assert.throws(() => classifyWorkspaceCache(before, { ...after, newField: true }, declaration, workspace, workspace), /other_fields_changed/)
  assert.throws(() => classifyWorkspaceCache(before, after, { ...declaration, pnpmVersion: '99.0.0' }, workspace, workspace), /declaration_invalid/)
  const drift = structuredClone(after); drift.settings.minimumReleaseAgeExclude = ['b', 'c']
  assert.throws(() => classifyWorkspaceCache(before, drift, { ...declaration, afterOrder: ['b', 'c'] }, workspace, workspace), /transition_unsupported/)
})

test('enabled control stays outside managed block and matches composed state', () => {
  const managed = JSON.stringify([{ id: 'context-guard', name: 'dsh-completion-guard', config: { hostLockPolicy: 'dsh-core/v1', hostLockPackages: [] } }])
  const outside = JSON.stringify([{ id: 'context-guard', disabled: false }])
  const parse = text => JSON.parse(text.trim() || '[]')
  const patch = `${outside}\n${begin}\n${managed}\n${end}`
  const composed = [{ id: 'context-guard', name: 'dsh-completion-guard', disabled: false }]
  assert.equal(checkControlPlacement(patch, composed, parse).status, 'enabled_control_outside_managed_block')
  assert.throws(() => checkControlPlacement(`${outside.replace('false', 'true')}\n${begin}\n${managed}\n${end}`, composed, parse), /outside_not_enabled/)
  assert.throws(() => checkControlPlacement(patch, [{ id: 'context-guard', disabled: true }], parse), /composed_not_enabled/)
  assert.throws(() => checkControlPlacement(patch.replace(end, `${end}\n${end}`), composed, parse), /marker_invalid/)
  assert.throws(() => checkControlPlacement(`${begin}\n${managed}\n${end}\n${outside}`, composed, parse), /order_unsupported/)
  assert.throws(() => checkControlPlacement(patch.replace('hostLockPackages', 'badField'), composed, parse), /managed_invalid/)
  const prior = [{ id: 'context-guard', disabled: true, config: { activation: 'always', hostLockPolicy: 'old' } }]
  const current = [{ id: 'context-guard', disabled: false, config: { activation: 'always', hostLockPolicy: 'new' } }]
  assert.equal(compareGuardConfiguration(prior, current).status, 'matched')
  current[0].config.activation = 'opt-in'
  assert.equal(compareGuardConfiguration(prior, current).status, 'changed')
})

test('existing native driver exposes read-only audit commands and rejects changed inputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-preservation-driver-'))
  try {
    const archive = join(root, 'carrier'), runtime = join(archive, 'dsh'), modules = join(runtime, 'node_modules')
    const pkg = (name, contents) => {
      const path = join(modules, ...name.split('/')); mkdirSync(path, { recursive: true })
      writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version: '1', type: 'module', main: 'index.mjs' }))
      writeFileSync(join(path, 'index.mjs'), contents)
      return path
    }
    pkg('@deepseek-ai/dsh', 'export {}')
    const boot = pkg('@deepseek-ai/dsh-app-boot', `
      export const readProfileManifest = () => ({ dsh: { profile: { bundles: [] } } });
      export const createRuntimeResolution = async ({profile}) => ({entries:[{name:'dep',scope:'profile',declarer:profile.dir,packageDir:process.env.FIXTURE_DEP}],linkedRoots:[],localPackageNames:[]});`)
    mkdirSync(join(boot, 'worker')); writeFileSync(join(boot, 'worker', 'profile-resolution-bootstrap.js'), 'fixture')
    pkg('@deepseek-ai/cordis-plugin-include', 'export const entryListSchema = {}')
    pkg('@deepseek-ai/cordis-plugin-loader', 'export {}')
    pkg('@deepseek-ai/dsh-official-bundles', 'export {}')
    const yaml = join(modules, 'js-yaml'); mkdirSync(yaml)
    writeFileSync(join(yaml, 'package.json'), JSON.stringify({ name: 'js-yaml', main: 'index.cjs' }))
    writeFileSync(join(yaml, 'index.cjs'), 'exports.load = JSON.parse; exports.JSON_SCHEMA = {};')
    const profile = join(root, 'profile'), home = join(root, 'home'), dep = join(root, 'dependency')
    for (const path of [profile, home, dep]) mkdirSync(path)
    writeFileSync(join(dep, 'package.json'), JSON.stringify({ name: 'dep', version: '1' }))
    const privateKey = join(root, 'key'); writeFileSync(privateKey, key)
    const driver = fileURLToPath(new URL('../scripts/native_desktop_tools.mjs', import.meta.url))
    const run = (mode, out, ...args) => spawnSync(process.execPath, [driver, mode, archive, profile, out, ...args],
      { env: { ...process.env, FIXTURE_DEP: dep }, encoding: 'utf8', timeout: 10000 })
    const before = join(root, 'before.json'), after = join(root, 'after.json'), compare = join(root, 'compare.json')
    assert.equal(run('audit-resolution', before, home, privateKey, 'before').status, 0)
    assert.equal(run('audit-resolution', after, home, privateKey, 'after').status, 0)
    assert.equal(run('audit-resolution-compare', compare, before, after, privateKey).status, 0)
    assert.equal(JSON.parse(readFileSync(compare)).status, 'matched')
    assert.equal(readFileSync(before, 'utf8').includes(profile), false)
    writeFileSync(join(dep, 'package.json'), JSON.stringify({ name: 'dep', version: '2' }))
    const drift = join(root, 'drift.json'), changed = join(root, 'changed.json')
    assert.equal(run('audit-resolution', drift, home, privateKey, 'after').status, 0)
    assert.equal(run('audit-resolution-compare', changed, before, drift, privateKey).status, 1)
    assert.equal(JSON.parse(readFileSync(changed)).status, 'changed_or_unbound')
    const rowsBefore = join(root, 'rows-before.json'), rowsAfter = join(root, 'rows-after.json'), controlOut = join(root, 'control.json')
    writeFileSync(rowsBefore, JSON.stringify([{ id: 'other', config: { name: '私密 内容' } }, { id: 'context-guard', disabled: true }]))
    writeFileSync(rowsAfter, JSON.stringify([{ id: 'other', config: { name: '私密 内容' } }, { id: 'context-guard', disabled: false }]))
    writeFileSync(join(profile, 'cordis.patch.yml'), `${JSON.stringify([{ id: 'context-guard', disabled: false }])}\n${begin}\n${JSON.stringify([{ id: 'context-guard', name: 'dsh-completion-guard', config: { hostLockPolicy: 'dsh-core/v1', hostLockPackages: [] } }])}\n${end}`)
    assert.equal(run('audit-control', controlOut, rowsBefore, rowsAfter).status, 0)
    assert.equal(JSON.parse(readFileSync(controlOut)).control.loaded, 'not_checked')
    assert.equal(readFileSync(controlOut, 'utf8').includes('私密'), false)
    const oldCache = join(root, 'old-cache.json'), newCache = join(root, 'new-cache.json')
    const oldWorkspace = join(root, 'old-workspace'), newWorkspace = join(root, 'new-workspace'), declaration = join(root, 'declaration.json')
    writeFileSync(oldCache, JSON.stringify({ lastValidatedTimestamp: 1, settings: { minimumReleaseAgeExclude: ['a', 'b'] } }))
    writeFileSync(newCache, JSON.stringify({ lastValidatedTimestamp: 2, settings: { minimumReleaseAgeExclude: ['b', 'a'] } }))
    writeFileSync(declaration, JSON.stringify({ pnpmVersion: '11.22.0', beforeOrder: ['a', 'b'], afterOrder: ['b', 'a'] }))
    writeFileSync(oldWorkspace, 'unchanged'); writeFileSync(newWorkspace, 'unchanged')
    const cacheOut = join(root, 'cache.json')
    assert.equal(run('audit-cache', cacheOut, oldCache, newCache, declaration, oldWorkspace, newWorkspace).status, 0)
    assert.equal(JSON.parse(readFileSync(cacheOut)).strict_bytes, 'different')
    writeFileSync(newWorkspace, 'changed')
    assert.equal(run('audit-cache', join(root, 'bad-cache.json'), oldCache, newCache, declaration, oldWorkspace, newWorkspace).status, 1)
    const sensitive = join(root, 'invalid-config.json'), rejected = join(root, 'rejected.json')
    writeFileSync(sensitive, '{"password": "private-secret" invalid')
    const error = run('audit-config', rejected, rowsBefore, sensitive)
    assert.equal(error.status, 1)
    assert.equal(error.stderr.includes('private-secret'), false)
    const invalidUtf = join(root, 'invalid-utf8.json'); writeFileSync(invalidUtf, Buffer.from([0xff]))
    assert.equal(run('audit-config', join(root, 'bad-utf.json'), rowsBefore, invalidUtf).status, 1)
    const hidden = join(profile, '..hidden'); mkdirSync(hidden)
    assert.equal(run('audit-resolution', join(hidden, 'forbidden.json'), home, privateKey, 'before').status, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
