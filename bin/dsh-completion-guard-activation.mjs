#!/usr/bin/env node
import { readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { activationJson, activationCanonical, inspectActivationInventory, prepareActivationMigration,
  readActivationMigrationReceipt, verifyMigrationInventory, adoptActivationReceipt, resolveActivationBindingsRoot } from '../dist/domain/index.js'

function option(name, optional = false) {
  const index = process.argv.indexOf(name)
  if (index < 0 && optional) return undefined
  if (index < 0 || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error(`missing ${name}`)
  return process.argv[index + 1]
}
async function main() {
  const operation = process.argv[2]
  if (!['inspect', 'adopt', 'verify'].includes(operation)) throw new Error('usage: dsh-completion-guard-activation inspect|adopt|verify --runtime-anchor <physical runtime file> --persistence-root <active session root> [--compression none|zstd] --prior-modes <sanitized old-mode mapping> --output <unused receipt> | --receipt <frozen receipt> [--dsh-home <home>]')
  const anchor = realpathSync(option('--runtime-anchor'))
  const require = createRequire(anchor)
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
  const { default: Jsonl } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href)
  const ctx = new Context()
  const compression = option('--compression', true)
  if (compression && !['none', 'zstd'].includes(compression)) throw new Error('invalid compression')
  const backend = ctx.plugin(Jsonl, { root: resolve(option('--persistence-root')), ...(compression ? { compression } : {}) })
  await backend.await()
  try {
    const inventory = await inspectActivationInventory(ctx.sessionPersistence)
    if (operation === 'inspect') {
      const prior = activationJson(readFileSync(option('--prior-modes'), 'utf8'))
      const result = prepareActivationMigration(inventory, prior)
      if (result.receipt) writeFileSync(resolve(option('--output')), activationCanonical(result.receipt) + '\n', { flag: 'wx', mode: 0o600 })
      process.stdout.write(JSON.stringify({ status: result.status, count: inventory.length, missing: result.missing, ...(result.receipt ? { receiptSha256: result.receipt.sha256 } : {}) }) + '\n')
      if (result.status !== 'ready') process.exitCode = 2
    } else {
      const receipt = readActivationMigrationReceipt(resolve(option('--receipt')))
      verifyMigrationInventory(receipt, inventory)
      const root = resolveActivationBindingsRoot(option('--dsh-home', true) ?? process.env.DSH_HOME, homedir())
      const result = adoptActivationReceipt(root, receipt, operation === 'verify')
      process.stdout.write(JSON.stringify(result) + '\n')
      if (result.status !== 'complete') process.exitCode = 2
    }
  } finally { await ctx.fiber.dispose() }
}
main().catch(error => {
  const message = error instanceof Error && /^(?:activation_[a-z_]+|missing --[a-z-]+|invalid compression|usage:)/u.test(error.message)
    ? error.message : 'activation_cli_failed'
  process.stderr.write(JSON.stringify({ status: 'unavailable', reason_code: message }) + '\n'); process.exitCode = 1
})
