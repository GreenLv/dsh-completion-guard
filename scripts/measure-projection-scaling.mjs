#!/usr/bin/env node
// CG-RC2-003 projection-scaling driver. Runs the gated measurement test in
// five fresh Vitest worker processes per event-count size and aggregates
// median and nearest-rank p95 per entry. Synthetic classification: no real
// host, no installed graph, no model. Usage:
//   node scripts/measure-projection-scaling.mjs [--output <file>]
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url))
const outputIndex = process.argv.indexOf('--output')
const outputPath = outputIndex > 0 ? process.argv[outputIndex + 1] : undefined
const sizes = (process.env.DSH_PROJECTION_SIZES ?? '0,100,1000,10000').split(',')

const results = []
const peakSamples = []
// CG-083: run the local vitest binary directly. Spawning `pnpm exec` made the
// measurement depend on pnpm's interactive deps-status maintenance, which
// aborts without a TTY in a second worktree and is measurement noise.
const vitest = join(repo, 'node_modules', 'vitest', 'vitest.mjs')
// CG-083-V3: sample each worker's RSS from OUTSIDE the measured process. The
// in-process setInterval cannot run while the synchronous fold blocks the
// thread, so it missed exactly the peaks this report cares about. The
// sampler polls `ps` at 25ms and records the high-water mark plus the
// settled value after the worker exits.
for (const size of sizes) {
  for (let index = 0; index < 5; index += 1) {
    const child = spawn(process.execPath, [vitest, 'run', 'tests/v082-projection-scaling.test.ts', '--maxWorkers', '1'], {
      cwd: repo, env: { ...process.env, DSH_PROJECTION_MEASUREMENT: '1', DSH_PROJECTION_SIZES: size },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    let err = ''
    child.stderr.on('data', (chunk) => { err += chunk })
    // CG-083-V3: sample the WHOLE measured process tree. The vitest main
    // process delegates the test to a fork pool child, so main-pid-only
    // sampling missed the actual workload RSS (review round 2). Every 25ms:
    // enumerate main pid + descendants via pgrep -P, read each rss, and
    // record per-process peaks plus the TREE-SUM peak. `settled` is not
    // claimed: the last surviving sample is not a post-workload steady state.
    let peak = 0
    let treePeak = 0
    let maxSingle = 0
    const samples = []
    const pid = child.pid
    const treeOf = (rootPid) => {
      const acc = [rootPid]
      const expand = (parent) => {
        let childPids = []
        try {
          childPids = execFileSync('pgrep', ['-P', String(parent)], { encoding: 'utf8' })
            .split('\n').map((x) => Number.parseInt(x.trim(), 10)).filter(Number.isSafeInteger)
        } catch { /* no children */ }
        for (const cp of childPids) {
          acc.push(cp)
          expand(cp)
        }
      }
      expand(rootPid)
      return acc
    }
    const readRss = (target) => {
      try {
        const rssLine = execFileSync('ps', ['-o', 'rss=', '-p', String(target)], { encoding: 'utf8' }).trim()
        const rss = Number.parseInt(rssLine, 10)
        return Number.isSafeInteger(rss) && rss > 0 ? rss * 1024 : 0
      } catch { return 0 }
    }
    const poll = setInterval(() => {
      const tree = treeOf(pid)
      let treeSum = 0
      for (const target of tree) {
        const rss = readRss(target)
        if (rss <= 0) continue
        treeSum += rss
        if (rss > maxSingle) maxSingle = rss
        if (target === pid && rss > peak) peak = rss
      }
      if (treeSum > treePeak) treePeak = treeSum
      samples.push({ at: samples.length, tree: treeSum })
    }, 25)
    await new Promise((resolve, reject) => {
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${err.slice(-2000)}`)))
    })
    clearInterval(poll)
    const match = out.match(/^DSH_PROJECTION_MEASUREMENT=(\{.*)$/m)
    if (!match) throw new Error('projection measurement did not emit its observed result')
    const parsed = JSON.parse(match[1])
    results.push(...parsed.measurements)
    peakSamples.push({ size, rep: index + 1,
      outer_main_peak_rss_bytes: peak,
      outer_tree_peak_rss_bytes: treePeak,
      outer_max_single_process_rss_bytes: maxSingle,
      outer_samples: samples.length,
      worker_pid: parsed.worker_pid ?? null })
    console.error(`size=${size} rep=${index + 1}/5 done main_peak=${(peak / 1048576).toFixed(0)}MB tree_peak=${(treePeak / 1048576).toFixed(0)}MB max_single=${(maxSingle / 1048576).toFixed(0)}MB samples=${samples.length}`)
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
  outer_peak_rss: peakSamples,
}
const rendered = JSON.stringify(report, null, 2)
if (outputPath) writeFileSync(outputPath, rendered)
console.log(rendered)
