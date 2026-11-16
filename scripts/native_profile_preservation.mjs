/** Read-only helpers for scoped native profile preservation observations.
 * These do not install, enable, rewrite, or qualify a host. */
import { createHash, createHmac } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const GUARD = 'dsh-completion-guard'
const MARKER_BEGIN = '# >>> BEGIN DSH COMPLETION GUARD HOST LOCK (managed) >>>'
const MARKER_END = '# <<< END DSH COMPLETION GUARD HOST LOCK (managed) <<<'

function fail(reason) { throw new Error(reason) }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
  return value
}
function mac(key, value) {
  if (!Buffer.isBuffer(key) || key.length !== 32) fail('invalid_private_key')
  return createHmac('sha256', key).update(JSON.stringify(stable(value))).digest('hex')
}

/** Only entry identifiers are identifiers; config fields never become keys or values. */
export function configurationShape(entries) {
  if (!Array.isArray(entries)) fail('entry_list_invalid')
  const valueShape = value => {
    if (value === null) return 'null'
    if (Array.isArray(value)) return value.map(valueShape)
    if (object(value)) {
      if (Object.keys(value).length === 1 && Object.hasOwn(value, '__jsExpr')) return 'unevaluated_expression'
      return Object.values(value).map(valueShape).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    }
    if (!['string', 'number', 'boolean'].includes(typeof value)) fail('config_value_unsupported')
    return typeof value
  }
  const identifier = value => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9@._/:-]{1,200}$/.test(value)) fail('entry_identifier_invalid')
    return value
  }
  const walk = rows => rows.map(row => {
    if (!object(row) || !Object.hasOwn(row, 'id')) fail('entry_invalid')
    const shape = { id: identifier(row.id) }
    if (Object.hasOwn(row, 'name')) shape.name = identifier(row.name)
    if (Object.hasOwn(row, 'disabled')) {
      if (typeof row.disabled !== 'boolean') fail('entry_disabled_invalid')
      shape.disabled = row.disabled
    }
    if (Object.hasOwn(row, 'group')) {
      if (typeof row.group !== 'boolean') fail('entry_group_invalid')
      shape.group = row.group
    }
    if (row.group === true) {
      if (!Array.isArray(row.config)) fail('entry_group_config_invalid')
      shape.config = walk(row.config)
    } else if (Object.hasOwn(row, 'config')) shape.config = valueShape(row.config)
    const unknown = Object.keys(row).filter(key => !['id', 'name', 'disabled', 'group', 'config'].includes(key))
    if (unknown.length) fail('entry_fields_unsupported')
    return shape
  })
  return walk(entries)
}

/** Bind the actual declaring profile and carrier; a relocated backup is not a baseline. */
export function resolutionObservation({ profile, carrier, entries, linkedRoots, localPackageNames, bundles = [], declarations = {}, directPackages = [] }, key) {
  if (typeof profile !== 'string' || !profile || typeof carrier !== 'string' || !carrier
      || !Array.isArray(entries) || !Array.isArray(linkedRoots) || !Array.isArray(localPackageNames)
      || !Array.isArray(bundles) || !object(declarations) || !Array.isArray(directPackages)) fail('resolution_input_invalid')
  if (linkedRoots.some(root => !object(root) || typeof root.name !== 'string' || !root.name
      || typeof root.realPath !== 'string' || !root.realPath)
      || localPackageNames.some(name => typeof name !== 'string' || !name)
      || new Set(linkedRoots.map(root => root.name)).size !== linkedRoots.length) fail('linked_roots_invalid')
  const rows = entries.filter(row => row?.name !== GUARD).map(row => {
    if (!object(row) || typeof row.name !== 'string' || typeof row.version !== 'string'
        || typeof row.declarer !== 'string' || typeof row.packageDir !== 'string'
        || !['installation', 'profile'].includes(row.scope)) fail('resolution_row_invalid')
    return row
  }) // Preserve official precedence order; sorting could conceal a changed selection.
  return { profile: mac(key, profile), carrier: mac(key, carrier),
    resolution: mac(key, { rows, linkedRoots: linkedRoots.filter(root => root.name !== GUARD),
      bundles, declarations, directPackages, localPackageNames: localPackageNames.filter(name => name !== GUARD) }),
    entries: rows.length }
}

/** Use the official boot API on the original profile, before and after mutation. */
export async function captureOfficialResolution({ boot, anchor, profile, home, carrier }, key) {
  const physicalProfile = realpathSync(profile)
  const physicalAnchor = realpathSync(anchor)
  const physicalHome = realpathSync(home)
  const manifest = boot.readProfileManifest('dsh', physicalProfile)
  const bundles = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || bundles.some(name => typeof name !== 'string')) fail('bundles_invalid')
  const layers = [], skippedBundles = [], observedBundles = []
  for (const name of bundles) {
    const directory = boot.resolveBundleDir('dsh', name, physicalAnchor, physicalProfile)
    const bundleManifest = boot.readProfileManifest('dsh', directory)
    const bundle = bundleManifest?.dsh?.bundle
    if (!object(bundle)) fail('bundle_unavailable')
    if (bundleManifest.name !== name || typeof bundleManifest.version !== 'string') fail('bundle_identity_invalid')
    if (name !== GUARD) observedBundles.push({ name, version: bundleManifest.version, directory: realpathSync(directory) })
    boot.assertBundlePlatform(bundle.platforms, process.platform)
    const exemptions = boot.readProfileVersionExemptions(physicalProfile)
    const issue = boot.evaluatePluginCompatibility(bundleManifest, exemptions)
    if (issue && !issue.exempted) fail('bundle_incompatible')
    const patchPaths = boot.bundlePatchPaths(directory, bundle)
    layers.push({ packageName: name, packageDir: directory, patchPaths,
      patches: patchPaths.flatMap(path => boot.loadOverlayPatches('dsh', path)) })
  }
  const result = await boot.createRuntimeResolution({ installAnchor: physicalAnchor,
    profile: { name: physicalProfile.split(/[\\/]/).at(-1), dir: physicalProfile, layers, skippedBundles }, home: physicalHome })
  if (!result || !Array.isArray(result.entries)) fail('resolution_unavailable')
  const entries = result.entries.map(entry => {
    if (!object(entry) || typeof entry.name !== 'string' || typeof entry.packageDir !== 'string'
        || typeof entry.declarer !== 'string') fail('resolution_row_invalid')
    const directory = realpathSync(entry.packageDir)
    const packageManifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(join(directory, 'package.json'))))
    if (typeof packageManifest.name !== 'string' || typeof packageManifest.version !== 'string') fail('resolved_manifest_invalid')
    if (entry.version !== undefined && entry.version !== packageManifest.version) fail('resolved_version_mismatch')
    return { ...entry, declarer: realpathSync(entry.declarer), packageDir: directory,
      version: packageManifest.version, actualName: packageManifest.name }
  })
  if (!Array.isArray(result.localPackageNames)) fail('resolution_unavailable')
  const directPackages = result.localPackageNames.filter(name => name !== GUARD).map(name => {
    if (typeof name !== 'string' || !/^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/.test(name)
        || name.split('/').some(part => part === '.' || part === '..')) fail('direct_package_name_invalid')
    const manifestPath = realpathSync(join(physicalProfile, 'node_modules', name, 'package.json'))
    const packageManifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(manifestPath)))
    if (typeof packageManifest.name !== 'string' || typeof packageManifest.version !== 'string') fail('resolved_manifest_invalid')
    return { requested: name, actualName: packageManifest.name, version: packageManifest.version,
      scope: 'profile', directory: realpathSync(join(physicalProfile, 'node_modules', name)),
      declarer: realpathSync(join(physicalProfile, 'package.json')) }
  })
  const declarations = {}
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const source = manifest[section] ?? {}
    if (!object(source)) fail('dependencies_invalid')
    declarations[section] = Object.fromEntries(Object.entries(source).filter(([name]) => name !== GUARD).map(([name, value]) => {
      if (typeof value !== 'string') fail('dependency_spec_invalid')
      return [name, value]
    }))
  }
  const observedNames = new Set([...result.localPackageNames, ...result.entries.map(entry => entry.name)])
  for (const names of Object.values(declarations)) {
    if (Object.keys(names).some(name => !observedNames.has(name))) fail('declared_dependency_unresolved')
  }
  if (!object(carrier) || typeof carrier.executable !== 'string' || typeof carrier.bootModule !== 'string' || typeof carrier.driver !== 'string'
      || !Array.isArray(carrier.modules) || carrier.modules.some(path => typeof path !== 'string')) fail('carrier_invalid')
  if (Object.hasOwn(process.env, 'NODE_OPTIONS') || Object.hasOwn(process.env, 'NODE_PATH')) fail('uncontrolled_resolver_conditions')
  const digestFile = path => createHash('sha256').update(readFileSync(path)).digest('hex')
  const carrierIdentity = JSON.stringify({ executable: digestFile(carrier.executable), boot: digestFile(carrier.bootModule),
    driver: digestFile(carrier.driver), helper: digestFile(fileURLToPath(import.meta.url)),
    modules: carrier.modules.map(digestFile), node: process.versions.node, electron: process.versions.electron ?? null,
    platform: process.platform, arch: process.arch, execArgv: process.execArgv })
  return resolutionObservation({ profile: JSON.stringify({ profile: physicalProfile, home: physicalHome }), carrier: carrierIdentity, entries,
    linkedRoots: result.linkedRoots, localPackageNames: result.localPackageNames,
    bundles: observedBundles, declarations, directPackages }, key)
}

export function compareResolution(before, after) {
  if (!object(before) || !object(after) || !isDeepStrictEqual(Object.keys(before).sort(), ['carrier', 'entries', 'profile', 'resolution'])
      || !isDeepStrictEqual(Object.keys(after).sort(), ['carrier', 'entries', 'profile', 'resolution'])
      || [before, after].some(row => ['carrier', 'profile', 'resolution'].some(key => !/^[0-9a-f]{64}$/.test(row[key]))
        || !Number.isSafeInteger(row.entries) || row.entries < 0)) fail('resolution_receipt_invalid')
  return { status: isDeepStrictEqual(before, after) ? 'matched' : 'changed_or_unbound',
    scope: 'official_resolution_at_original_profile_only' }
}

export function sealResolution(observation, key, phase) {
  compareResolution(observation, observation)
  if (!['before', 'after'].includes(phase)) fail('resolution_phase_invalid')
  const body = { schema: 'dsh-profile-resolution-observation/v1', ...observation, phase, loaded: 'not_checked' }
  return { ...body, authentication: mac(key, body) }
}

export function verifyResolution(receipt, key) {
  if (!object(receipt) || receipt.schema !== 'dsh-profile-resolution-observation/v1'
      || !['before', 'after'].includes(receipt.phase) || receipt.loaded !== 'not_checked'
      || !/^[0-9a-f]{64}$/.test(receipt.authentication)) fail('resolution_receipt_invalid')
  const { authentication, ...body } = receipt
  if (mac(key, body) !== authentication) fail('resolution_receipt_authentication_failed')
  const { profile, carrier, resolution, entries } = receipt
  const observation = { profile, carrier, resolution, entries }
  compareResolution(observation, observation)
  return { ...observation, phase: receipt.phase }
}

/** Narrowly explain the previously observed workspace-cache transition. */
export function classifyWorkspaceCache(before, after, declaration, beforeWorkspace, afterWorkspace) {
  if (!object(before) || !object(after) || !object(declaration)
      || !isDeepStrictEqual(Object.keys(declaration).sort(), ['afterOrder', 'beforeOrder', 'pnpmVersion'])
      || !['11.22.0', '11.28.5'].includes(declaration.pnpmVersion)
      || !Array.isArray(declaration.beforeOrder) || !Array.isArray(declaration.afterOrder)
      || !Buffer.isBuffer(beforeWorkspace) || !Buffer.isBuffer(afterWorkspace)
      || !beforeWorkspace.equals(afterWorkspace)) fail('cache_declaration_invalid')
  if (!object(before.settings) || !object(after.settings)
      || !Number.isSafeInteger(before.lastValidatedTimestamp) || !Number.isSafeInteger(after.lastValidatedTimestamp)
      || before.lastValidatedTimestamp < 0 || after.lastValidatedTimestamp < before.lastValidatedTimestamp) fail('cache_shape_invalid')
  const oldOrder = before.settings.minimumReleaseAgeExclude
  const newOrder = after.settings.minimumReleaseAgeExclude
  if (!Array.isArray(oldOrder) || !Array.isArray(newOrder) || [...oldOrder, ...newOrder].some(x => typeof x !== 'string')
      || new Set(oldOrder).size !== oldOrder.length || new Set(newOrder).size !== newOrder.length
      || !isDeepStrictEqual(oldOrder, declaration.beforeOrder) || !isDeepStrictEqual(newOrder, declaration.afterOrder)
      || !isDeepStrictEqual([...oldOrder].sort(), [...newOrder].sort())) fail('cache_exclusion_transition_unsupported')
  const omit = (value, key) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key))
  if (!isDeepStrictEqual(omit(before, 'settings'), { ...omit(after, 'settings'), lastValidatedTimestamp: before.lastValidatedTimestamp })
      || !isDeepStrictEqual(omit(before.settings, 'minimumReleaseAgeExclude'), omit(after.settings, 'minimumReleaseAgeExclude'))) fail('cache_other_fields_changed')
  return { status: 'declared_cache_delta_only', strict_bytes: 'not_assessed',
    scope: 'caller_supplied_workspace_cache_only', pnpm_identity: 'caller_declared' }
}

/** Check the already-produced official enable/inject output; never rewrite it. */
export function checkControlPlacement(patchText, composed, parseRows) {
  if (typeof patchText !== 'string' || !Array.isArray(composed) || typeof parseRows !== 'function') fail('control_input_invalid')
  const lines = patchText.split(/\r?\n/)
  const begins = lines.flatMap((line, index) => line === MARKER_BEGIN ? [index] : [])
  const ends = lines.flatMap((line, index) => line === MARKER_END ? [index] : [])
  if (begins.length !== 1 || ends.length !== 1 || begins[0] >= ends[0]
      || patchText.split(MARKER_BEGIN).length !== 2 || patchText.split(MARKER_END).length !== 2) fail('control_marker_invalid')
  if (lines.slice(ends[0] + 1).some(line => line.trim() && !line.trimStart().startsWith('#'))) fail('control_order_unsupported')
  const parse = text => {
    const rows = parseRows(text)
    if (!Array.isArray(rows)) fail('control_entries_invalid')
    return rows
  }
  const managed = parse(lines.slice(begins[0] + 1, ends[0]).join('\n'))
  const outside = parse([...lines.slice(0, begins[0]), ...lines.slice(ends[0] + 1)].join('\n'))
  if (managed.length !== 1 || managed[0]?.id !== 'context-guard' || managed[0]?.name !== GUARD
      || !object(managed[0]?.config) || managed[0].config.hostLockPolicy !== 'dsh-core/v1'
      || !Array.isArray(managed[0].config.hostLockPackages)) fail('control_managed_invalid')
  const controls = outside.filter(row => row?.id === 'context-guard' && Object.hasOwn(row, 'disabled'))
  if (controls.length !== 1 || controls[0].disabled !== false) fail('control_outside_not_enabled')
  const guard = composed.filter(row => row?.id === 'context-guard')
  if (guard.length !== 1 || guard[0].disabled === true) fail('control_composed_not_enabled')
  return { status: 'enabled_control_outside_managed_block', scope: 'parsed_config_only', loaded: 'not_checked' }
}

export function compareNonGuardConfiguration(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after)) fail('entry_list_invalid')
  const remove = entries => entries.flatMap(entry => {
    if (!object(entry) || typeof entry.id !== 'string') fail('entry_invalid')
    if (entry.id === 'context-guard') {
      if (entry.name !== undefined && entry.name !== GUARD) fail('guard_identity_ambiguous')
      return []
    }
    if (entry.name === GUARD) fail('guard_identity_ambiguous')
    if (entry.group === true) {
      if (!Array.isArray(entry.config)) fail('entry_group_config_invalid')
      return [{ ...entry, config: remove(entry.config) }]
    }
    return [entry]
  })
  return { status: isDeepStrictEqual(remove(before), remove(after)) ? 'matched' : 'changed',
    scope: 'caller_supplied_composed_non_guard_values', strict_patch_bytes: 'not_assessed' }
}

/** Guard's own user settings must survive; only lock fields and disabled may change. */
export function compareGuardConfiguration(before, after) {
  const lockFields = new Set(['hostLockPackages', 'hostLockPlatform', 'hostLockProfile', 'hostLockPolicy',
    'hostLockRuntimeRoot', 'hostLockProfileRoot', 'hostLockTrust', 'hostLockDesktopDigest'])
  const projection = rows => {
    if (!Array.isArray(rows)) fail('entry_list_invalid')
    const guards = rows.filter(row => row?.id === 'context-guard')
    if (guards.length !== 1 || (guards[0].name !== undefined && guards[0].name !== GUARD)) fail('guard_identity_ambiguous')
    const row = { ...guards[0] }
    delete row.disabled
    if (Object.hasOwn(row, 'config')) {
      if (!object(row.config)) fail('guard_config_invalid')
      row.config = Object.fromEntries(Object.entries(row.config).filter(([name]) => !lockFields.has(name)))
      if (!Object.keys(row.config).length) delete row.config
    }
    return row
  }
  return { status: isDeepStrictEqual(projection(before), projection(after)) ? 'matched' : 'changed',
    scope: 'in_memory_guard_settings_except_enable_and_lock', loaded: 'not_checked' }
}
