#!/usr/bin/env node
// CG-RC2-003 projection-scaling driver. Runs the gated measurement test in
// five fresh Vitest worker processes per event-count size and aggregates
// median and nearest-rank p95 per entry. Synthetic classification: no real
// host, no installed graph, no model. Usage:
//   node scripts/measure-projection-scaling.mjs [--output <file>]
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url))
const outputIndex = process.argv.indexOf('--output')
const outputPath = outputIndex > 0 ? process.argv[outputIndex + 1] : undefined
const sizes = (process.env.DSH_PROJECTION_SIZES ?? '0,100,1000,10000').split(',')

const results = []
// CG-083: run the local vitest binary directly. Spawning `pnpm exec` made the
// measurement depend on pnpm's interactive deps-status maintenance, which
// aborts without a TTY in a second worktree and is measurement noise.
const vitest = join(repo, 'node_modules', 'vitest', 'vitest.mjs')
for (const size of sizes) {
  for (let index = 0; index < 5; index += 1) {
    const out = execFileSync(process.execPath, [vitest, 'run', 'tests/v082-projection-scaling.test.ts', '--maxWorkers', '1'], {
      cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, DSH_PROJECTION_MEASUREMENT: '1', DSH_PROJECTION_SIZES: size },
    })
    const match = out.match(/^DSH_PROJECTION_MEASUREMENT=(\{.*)$/m)
    if (!match) throw new Error('projection measurement did not emit its observed result')
    const parsed = JSON.parse(match[1])
    results.push(...parsed.measurements)
    console.error(`size=${size} rep=${index + 1}/5 done`)
  }
}

const entries = {}
// Group by the ACTUAL durable event count each worker measured, so the
// report's keys are the subject identity rather than the requested size.
for (const row of results) {
  ;(entries[row.events] ??= {})[row.entry] ??= []
  entries[row.events][row.entry].push(row)
}
for (const size of Object.keys(entries)) {
  for (const [entry, samples] of Object.entries(entries[size])) {
    const sorted = samples.map((s) => s.wall_ms).sort((a, b) => a - b)
    const rssSorted = samples.map((s) => s.rss_bytes).sort((a, b) => a - b)
    entries[size][entry] = {
      samples: samples.length,
      median_ms: sorted[Math.floor(sorted.length / 2)],
      p95_nearest_rank_ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      median_rss_bytes: rssSorted[Math.floor(rssSorted.length / 2)],
      physical_reads: [...new Set(samples.map(s => s.physical_reads))],
      read_bytes: [...new Set(samples.map(s => s.read_bytes))],
      projection_calls: [...new Set(samples.map(s => s.projection_calls))],
    }
  }
}

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--',
  'src', 'tests/v082-projection-scaling.test.ts', 'scripts/measure-projection-scaling.mjs', 'package.json', 'pnpm-lock.yaml'],
{ cwd: repo, encoding: 'utf8' }).trim().split('\n').sort()
const source_sha256 = Object.fromEntries(files.map((file) => [file, createHash('sha256').update(readFileSync(join(repo, file))).digest('hex')]))

const report = {
  schema: 'dsh-projection-scaling/v1',
  classification: 'synthetic',
  note: 'Five fresh Vitest worker processes per size; wall clock includes the full-log snapshot, the pure projection fold, the production apply() attach (first rebuild + private-ledger read), and full private-ledger chain verification. OS cache is not dropped. Host-lock graph/byte audits are measured separately by tests/v081-host-protocol-measurement.test.ts.',
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  source_sha256,
  sizes, entries, raw_results: results,
}
const rendered = JSON.stringify(report, null, 2)
if (outputPath) writeFileSync(outputPath, rendered)
console.log(rendered)
