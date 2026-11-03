#!/usr/bin/env node
import { readFileSync, writeFileSync, realpathSync, readdirSync, lstatSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { activationJson, activationCanonical, inspectActivationInventory, prepareActivationMigration,
  readActivationMigrationReceipt, verifyMigrationInventory, adoptActivationReceipt, resolveActivationBindingsRoot,
  scanActivationInventory, createActivationSelection, validateActivationSelection, activationSelectionPending,
  prepareSelectedActivationMigration, verifySelectedMigrationInventory, isSelectedActivationReceipt,
  validateActivationInventorySnapshot, bindActivationInventoryPhysical, createActivationMigrationReceipt, activationDigest,
  captureActivationPhysicalInventory, verifyActivationPhysicalInventory, verifyActivationGenerations,
  guardActivationInventory, resolveActivationPersistencePlugin, assertActivationBackendIdentity,
  assertActivationCatalogQualification } from '../dist/domain/index.js'

const operation = process.argv[2]
const common = ['--runtime-anchor', '--persistence-root', '--compression']
const allowed = {
  inventory: [...common, '--output'],
  select: ['--inventory', '--include-file', '--output'],
  inspect: [...common, '--prior-modes', '--output', '--selection'],
  adopt: [...common, '--receipt', '--dsh-home', '--selection'],
  verify: [...common, '--receipt', '--dsh-home', '--selection'],
}
const options = new Map()
function option(name, optional = false) {
  if (!options.has(name) && !optional) throw new Error(`missing ${name}`)
  return options.get(name)
}
const readJson = path => activationJson(readFileSync(resolve(path), 'utf8'))
function save(path, value) {
  try { writeFileSync(resolve(path), activationCanonical(value) + '\n', { flag: 'wx', mode: 0o600 }) }
  catch (error) { if (error?.code === 'EEXIST') throw new Error('activation_output_exists'); throw error }
}
const print = value => process.stdout.write(JSON.stringify(value) + '\n')
function assertOutsideInventory(root, path) {
  let candidate = resolve(path)
  const tail = []
  for (;;) {
    try { lstatSync(candidate); break }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const parent = dirname(candidate)
      if (parent === candidate) throw error
      tail.unshift(relative(parent, candidate))
      candidate = parent
    }
  }
  const offset = relative(root, join(realpathSync(candidate), ...tail))
  if (offset === '' || (!isAbsolute(offset) && offset !== '..' && !offset.startsWith('..' + sep))) {
    throw new Error('activation_inventory_output_overlap')
  }
}
async function main() {
  if (!Object.hasOwn(allowed, operation)) throw new Error('activation_cli_usage')
  for (let i = 3; i < process.argv.length; i += 2) {
    const key = process.argv[i], value = process.argv[i + 1]
    if (!allowed[operation].includes(key) || options.has(key) || !value || value.startsWith('--')) throw new Error('activation_cli_options_invalid')
    options.set(key, value)
  }
  if (operation === 'select') {
    const source = validateActivationInventorySnapshot(readJson(option('--inventory')))
    if (!source.physicalSha256) throw new Error('activation_inventory_proof_required')
    const selection = createActivationSelection(source, readJson(option('--include-file')))
    save(option('--output'), selection)
    print({ status: 'selection_ready', includedCount: selection.include.length, selectionSha256: selection.sha256 })
    return
  }
  const selection = option('--selection', true) ? validateActivationSelection(readJson(option('--selection'))) : undefined
  const receipt = ['adopt', 'verify'].includes(operation) ? readActivationMigrationReceipt(resolve(option('--receipt'))) : undefined
  if (receipt && !receipt.inputs.physical_inventory) throw new Error('activation_inventory_proof_required')
  if (receipt && !selection && isSelectedActivationReceipt(receipt)) throw new Error('activation_selection_required')
  const anchor = realpathSync(option('--runtime-anchor'))
  const require = createRequire(anchor)
  const backendPath = require.resolve('@deepseek-ai/dsh-session-persistence-jsonl')
  // The physical layout is qualified by reviewed module bytes and loader
  // shape; a version relabel alone does not change that capability.
  const backendFile = realpathSync(backendPath)
  const backendRoot = dirname(dirname(backendFile))
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const digest = bytes => createHash('sha256').update(bytes).digest('hex')
  const checkedBackend = () => {
    const packageBytes = readFileSync(join(backendRoot, 'package.json'))
    const manifest = JSON.parse(packageBytes.toString('utf8'))
    const audit = JSON.parse(readFileSync(join(packageRoot, 'manifests', 'rc021-rc5-byte-audit.json'), 'utf8'))
    const row = audit.packages.find(row => row.name === '@deepseek-ai/dsh-session-persistence-jsonl')
    if (!row || backendFile !== realpathSync(join(backendRoot, 'lib/index.js'))) throw new Error('activation_backend_unreviewed')
    const moduleTree = root => {
      const files = {}
      const walk = (directory, prefix = '') => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (entry.name === 'node_modules') continue
          const name = prefix + entry.name, path = join(directory, entry.name)
          if (entry.isSymbolicLink()) throw new Error('activation_backend_unreviewed')
          if (entry.isDirectory()) walk(path, `${name}/`)
          else if (entry.isFile() && /\.(?:[cm]?js|json|node)$/u.test(name) && name !== 'package.json') files[name] = digest(readFileSync(path))
          else if (!entry.isFile()) throw new Error('activation_backend_unreviewed')
        }
      }
      walk(root)
      return files
    }
    const modules = moduleTree(backendRoot)
    assertActivationBackendIdentity(manifest, modules, row.modules)
    const backendRequire = createRequire(backendFile)
    const dependencies = ['@deepseek-ai/dsh-session-format', '@deepseek-ai/dsh-session-format-catalog',
      '@deepseek-ai/dsh-session-format-catalog/message-projections', '@deepseek-ai/dsh-session-format-v3-to-v4',
      '@deepseek-ai/dsh-session-persistence', '@deepseek-ai/dsh-session', '@deepseek-ai/cordis',
      '@deepseek-ai/node-addon-system/flock'].map(specifier => {
      const file = realpathSync(backendRequire.resolve(specifier))
      const name = specifier.split('/').slice(0, 2).join('/')
      const metadata = realpathSync(backendRequire.resolve(`${name}/package.json`))
      return { specifier, file, sha256: digest(readFileSync(file)), metadata, metadataSha256: digest(readFileSync(metadata)), modules: moduleTree(dirname(metadata)) }
    })
    return activationDigest({ name: manifest.name, version: manifest.version, backendFile, packageSha256: digest(packageBytes), modules,
      dependencies, node: process.versions.node, zstd: process.versions.zstd ?? null })
  }
  const compression = option('--compression', true) ?? 'zstd'
  if (!['none', 'zstd'].includes(compression)) throw new Error('invalid compression')
  const persistenceRoot = resolve(option('--persistence-root'))
  const output = option('--output', true)
  const bindingsRoot = receipt ? resolveActivationBindingsRoot(option('--dsh-home', true) ?? process.env.DSH_HOME, homedir()) : undefined
  if (output) assertOutsideInventory(persistenceRoot, output)
  if (bindingsRoot) assertOutsideInventory(persistenceRoot, bindingsRoot)
  const backendSha256 = checkedBackend()
  const backendRequire = createRequire(backendFile)
  const cordisFile = realpathSync(backendRequire.resolve('@deepseek-ai/cordis'))
  if (realpathSync(require.resolve('@deepseek-ai/cordis')) !== cordisFile) throw new Error('activation_backend_unreviewed')
  const rawCensus = captureActivationPhysicalInventory(persistenceRoot, compression, backendSha256)
  const catalogReview = rawCensus.multiGenerationSessionCount
    ? readJson(join(packageRoot, 'manifests', 'activation-catalog-cohort.v1.json')) : undefined
  const qualifyCatalog = () => assertActivationCatalogQualification(backendFile, catalogReview)
  const catalog = catalogReview ? qualifyCatalog() : undefined
  if (catalog && realpathSync(backendRequire.resolve('@deepseek-ai/dsh-session-format-catalog')) !== catalog.catalogFile) {
    throw new Error('activation_catalog_unreviewed')
  }
  const inventoryBackendSha256 = catalog ? activationDigest({ backendSha256, catalogSha256: catalog.qualificationSha256 }) : backendSha256
  const physical = () => {
    if (checkedBackend() !== backendSha256 || (catalog && qualifyCatalog().qualificationSha256 !== catalog.qualificationSha256)) {
      throw new Error('activation_inventory_changed')
    }
    return captureActivationPhysicalInventory(persistenceRoot, compression, inventoryBackendSha256)
  }
  const census = catalog ? physical() : rawCensus
  const jsonlModule = await import(pathToFileURL(backendFile).href)
  const Jsonl = resolveActivationPersistencePlugin(jsonlModule)
  const { Context } = await import(pathToFileURL(cordisFile).href)
  const { SessionFormatUnsupportedError } = await import(pathToFileURL(backendRequire.resolve('@deepseek-ai/dsh-session-persistence')).href)
  async function openPersistence(root, compression) {
    const ctx = new Context()
    try {
      await ctx.plugin(Jsonl, { root, compression }).await()
      const persistence = ctx.sessionPersistence
      if (!persistence || ['list', 'open', 'stat'].some(name => typeof persistence[name] !== 'function')) throw new Error('activation_backend_unreviewed')
      return { persistence, close: async () => { await ctx.fiber.dispose() } }
    } catch (error) {
      await ctx.fiber.dispose()
      throw error
    }
  }
  const proof = await verifyActivationPhysicalInventory(census, async candidate => {
    if (!catalog) throw new Error('activation_catalog_unreviewed')
    const { historicalSessionFormatCatalog, sessionFormatCatalog } = await import(
      pathToFileURL(catalog.catalogFile).href)
    return verifyActivationGenerations({
      root: candidate.root, compression: candidate.compression, censusSha256: candidate.censusSha256, generations: candidate.generations,
      capture: () => physical().censusSha256, openSnapshot: openPersistence,
      catalogs: { historical: historicalSessionFormatCatalog, current: sessionFormatCatalog },
    })
  }, physical)
  const mounted = await openPersistence(persistenceRoot, compression)
  try {
    const { persistence } = mounted
    const fence = guardActivationInventory(persistence, proof, physical)
    const initial = fence.initial, checkPhysical = fence.check
    const guarded = { list: fence.list,
      open: (...args) => persistence.open(...args), stat: (...args) => persistence.stat(...args) }
    const snapshot = operation === 'inventory' || selection
      ? bindActivationInventoryPhysical(await scanActivationInventory(guarded, error => error instanceof SessionFormatUnsupportedError), checkPhysical().sha256) : undefined
    if (operation === 'inventory') {
      assertOutsideInventory(persistenceRoot, option('--output'))
      save(option('--output'), snapshot)
      print({ status: 'inventory_scanned', totalCount: snapshot.rows.length,
        generationCount: census.generations.length, multiGenerationSessionCount: census.multiGenerationSessionCount,
        readableCount: snapshot.rows.filter(row => row.status === 'readable').length,
        unsupportedCount: snapshot.rows.filter(row => row.status === 'unsupported').length, inventorySha256: snapshot.sha256 })
      return
    }
    const inventory = selection ? undefined : await inspectActivationInventory(guarded)
    checkPhysical()
    if (receipt && receipt.inputs.physical_inventory !== initial.sha256) throw new Error('activation_inventory_changed')
    const scope = selection ? { scope: 'receipt_selected', wholeInventoryStatus: 'not_claimed',
      includedCount: selection.include.length, inventoryCount: snapshot.rows.length,
      pending: activationSelectionPending(snapshot, selection) } : {}
    if (operation === 'inspect') {
      const prior = readJson(option('--prior-modes'))
      const result = selection ? prepareSelectedActivationMigration(snapshot, selection, prior) : prepareActivationMigration(inventory, prior)
      if (result.receipt) {
        result.receipt = createActivationMigrationReceipt(result.receipt.entries, { ...result.receipt.inputs, physical_inventory: checkPhysical().sha256 })
        assertOutsideInventory(persistenceRoot, option('--output'))
        save(option('--output'), result.receipt)
      }
      print({ ...result, receipt: undefined, ...scope, count: selection ? selection.include.length : inventory.length,
        ...(result.receipt ? { receiptSha256: result.receipt.sha256 } : {}) })
      if (result.status !== 'ready') process.exitCode = 2
    } else {
      if (selection) verifySelectedMigrationInventory(receipt, snapshot, selection)
      else verifyMigrationInventory(receipt, inventory)
      assertOutsideInventory(persistenceRoot, bindingsRoot)
      checkPhysical()
      const result = adoptActivationReceipt(bindingsRoot, receipt, operation === 'verify')
      checkPhysical()
      print({ ...result, ...scope, status: selection ? (result.status === 'complete' ? 'selected_complete' : 'selected_partial') : result.status })
      if (result.status !== 'complete') process.exitCode = 2
    }
  } finally { await mounted.close() }
}
main().catch(error => {
  const message = error instanceof Error && /^(?:activation_[a-z_]+|missing --[a-z-]+|invalid compression)$/u.test(error.message)
    ? error.message : 'activation_cli_failed'
  process.stderr.write(JSON.stringify({ status: 'unavailable', reason_code: message }) + '\n'); process.exitCode = 1
})
