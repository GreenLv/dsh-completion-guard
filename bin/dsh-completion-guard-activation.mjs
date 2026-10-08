#!/usr/bin/env node
import { readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { activationJson, activationCanonical, inspectActivationInventory, prepareActivationMigration,
  readActivationMigrationReceipt, verifyMigrationInventory, adoptActivationReceipt, resolveActivationBindingsRoot,
  scanActivationInventory, createActivationSelection, validateActivationSelection, activationSelectionPending,
  prepareSelectedActivationMigration, verifySelectedMigrationInventory, isSelectedActivationReceipt } from '../dist/domain/index.js'

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
async function main() {
  if (!Object.hasOwn(allowed, operation)) throw new Error('activation_cli_usage')
  for (let i = 3; i < process.argv.length; i += 2) {
    const key = process.argv[i], value = process.argv[i + 1]
    if (!allowed[operation].includes(key) || options.has(key) || !value || value.startsWith('--')) throw new Error('activation_cli_options_invalid')
    options.set(key, value)
  }
  if (operation === 'select') {
    const selection = createActivationSelection(readJson(option('--inventory')), readJson(option('--include-file')))
    save(option('--output'), selection)
    print({ status: 'selection_ready', includedCount: selection.include.length, selectionSha256: selection.sha256 })
    return
  }
  const selection = option('--selection', true) ? validateActivationSelection(readJson(option('--selection'))) : undefined
  const receipt = ['adopt', 'verify'].includes(operation) ? readActivationMigrationReceipt(resolve(option('--receipt'))) : undefined
  if (receipt && !selection && isSelectedActivationReceipt(receipt)) throw new Error('activation_selection_required')
  const anchor = realpathSync(option('--runtime-anchor'))
  const require = createRequire(anchor)
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
  const backendPath = require.resolve('@deepseek-ai/dsh-session-persistence-jsonl')
  const { default: Jsonl } = await import(pathToFileURL(backendPath).href)
  // Resolve the same dependency instance used by this physical JSONL backend.
  const { SessionFormatUnsupportedError } = await import(pathToFileURL(createRequire(backendPath).resolve('@deepseek-ai/dsh-session-persistence')).href)
  const ctx = new Context()
  const compression = option('--compression', true)
  if (compression && !['none', 'zstd'].includes(compression)) throw new Error('invalid compression')
  const backend = ctx.plugin(Jsonl, { root: resolve(option('--persistence-root')), ...(compression ? { compression } : {}) })
  try {
    await backend.await()
    const snapshot = operation === 'inventory' || selection
      ? await scanActivationInventory(ctx.sessionPersistence, error => error instanceof SessionFormatUnsupportedError) : undefined
    if (operation === 'inventory') {
      save(option('--output'), snapshot)
      print({ status: 'inventory_scanned', totalCount: snapshot.rows.length,
        readableCount: snapshot.rows.filter(row => row.status === 'readable').length,
        unsupportedCount: snapshot.rows.filter(row => row.status === 'unsupported').length, inventorySha256: snapshot.sha256 })
      return
    }
    const inventory = selection ? undefined : await inspectActivationInventory(ctx.sessionPersistence)
    const scope = selection ? { scope: 'receipt_selected', wholeInventoryStatus: 'not_claimed',
      includedCount: selection.include.length, inventoryCount: snapshot.rows.length,
      pending: activationSelectionPending(snapshot, selection) } : {}
    if (operation === 'inspect') {
      const prior = readJson(option('--prior-modes'))
      const result = selection ? prepareSelectedActivationMigration(snapshot, selection, prior) : prepareActivationMigration(inventory, prior)
      if (result.receipt) save(option('--output'), result.receipt)
      print({ ...result, receipt: undefined, ...scope, count: selection ? selection.include.length : inventory.length,
        ...(result.receipt ? { receiptSha256: result.receipt.sha256 } : {}) })
      if (result.status !== 'ready') process.exitCode = 2
    } else {
      if (selection) verifySelectedMigrationInventory(receipt, snapshot, selection)
      else verifyMigrationInventory(receipt, inventory)
      const root = resolveActivationBindingsRoot(option('--dsh-home', true) ?? process.env.DSH_HOME, homedir())
      const result = adoptActivationReceipt(root, receipt, operation === 'verify')
      print({ ...result, ...scope, status: selection ? (result.status === 'complete' ? 'selected_complete' : 'selected_partial') : result.status })
      if (result.status !== 'complete') process.exitCode = 2
    }
  } finally { await ctx.fiber.dispose() }
}
main().catch(error => {
  const message = error instanceof Error && /^(?:activation_[a-z_]+|missing --[a-z-]+|invalid compression)$/u.test(error.message)
    ? error.message : 'activation_cli_failed'
  process.stderr.write(JSON.stringify({ status: 'unavailable', reason_code: message }) + '\n'); process.exitCode = 1
})
