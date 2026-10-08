#!/usr/bin/env node
/** Read-only corpus replay, NOT a UI benchmark or native acceptance.
 * Usage: node scripts/measure-local-history.mjs --root <sessions> --output <new.json> [--repeats 3]
 * Requires zstd on PATH. Output contains anonymous counts/digests, never history text.
 * Historical generations are inventoried, not migrated or certified as V4.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveProjection } from '../dist/domain/index.js'

const args = process.argv.slice(2)
const option = key => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1] }
const rootArg = option('--root'), outputArg = option('--output')
const repeats = Number(option('--repeats') ?? 3)
if (!rootArg || !outputArg || !Number.isSafeInteger(repeats) || repeats < 1 || repeats > 20) {
  throw new Error('require --root, unused --output, and --repeats between 1 and 20')
}
const root = resolve(rootArg), output = resolve(outputArg)
if (existsSync(output)) throw new Error('output exists; preserve it and choose a new path')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const names = ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.jsonl.zstd']
const subjects = []
function discover(dir) {
  const entries = readdirSync(dir, { withFileTypes: true })
  const available = names.filter(name => entries.some(e => e.isFile() && e.name === name))
  if (available.length) subjects.push({ dir, available })
  for (const entry of entries) if (entry.isDirectory()) discover(join(dir, entry.name))
}
discover(root)
subjects.sort((a, b) => a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0)
const repo = fileURLToPath(new URL('../', import.meta.url))
const runtime = []
function collectBuild(dir, prefix = '') {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = prefix + entry.name
    if (entry.isDirectory()) collectBuild(join(dir, entry.name), name + '/')
    else if (entry.isFile() && entry.name.endsWith('.js')) runtime.push(name)
  }
}
collectBuild(join(repo, 'dist'))
runtime.sort()
const build_sha256 = Object.fromEntries(runtime.map(f => [f, sha(readFileSync(join(repo, 'dist', f)))]))
const script_sha256 = sha(readFileSync(fileURLToPath(import.meta.url)))
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
const rows = []
const textParts = value => Array.isArray(value)
  ? value.filter(p => p && p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n') : ''
for (const [index, subject] of subjects.entries()) {
  const path = join(subject.dir, subject.available[0])
  const row = { sample: `S${String(index + 1).padStart(3, '0')}`, selected_file: subject.available[0],
    physical_generations: subject.available.length, samples: [] }
  try {
    let identity
    for (let rep = 0; rep < repeats; rep++) {
      let start = performance.now()
      const compressed = readFileSync(path)
      const read_ms = performance.now() - start
      const digest = sha(compressed)
      if (identity !== undefined && identity !== digest) throw new Error('subject_changed')
      identity = digest
      start = performance.now()
      const plain = execFileSync('zstd', ['-dc', path], { timeout: 30_000, maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
      const text = plain.toString('utf8')
      const decompress_utf8_ms = performance.now() - start
      // zstd reads the path itself; verify it still names the measured bytes.
      if (sha(readFileSync(path)) !== identity) throw new Error('subject_changed')
      start = performance.now()
      const [header, ...events] = text.trimEnd().split('\n').map(line => JSON.parse(line))
      const json_parse_ms = performance.now() - start
      if (!header || header.type !== 'session') throw new Error('invalid_header')
      start = performance.now()
      // Scope deliberately omits the physical persistence header: it is not
      // the runtime's closed-manifest Session identity and old logs are not V4.
      const derived = deriveProjection(events, { activation: 'always', policy: 'standard' }, { cwd: header.cwd ?? '' }, false)
      const guard_fold_ms = performance.now() - start
      row.samples.push({ read_ms, decompress_utf8_ms, json_parse_ms, guard_fold_ms,
        total_ms: read_ms + decompress_utf8_ms + json_parse_ms + guard_fold_ms })
      const packets = new Map()
      let notice_chars = 0, notice_utf8_bytes = 0, notices = 0, repeated_notice_chars = 0
      for (const event of events) if (event.type === 'user/message' && event.data?.source?.plugin === 'context-guard') {
        const text = textParts(event.data.content)
        notices++; notice_chars += text.length; notice_utf8_bytes += Buffer.byteLength(text)
        const key = sha(text)
        if (packets.has(key)) repeated_notice_chars += text.length
        packets.set(key, true)
      }
      Object.assign(row, { sha256: identity, version: header.version, events: events.length,
        compressed_bytes: compressed.length, decoded_bytes: plain.length, guard_items: derived.projection.items.size,
        notices, notice_chars, notice_utf8_bytes, repeated_notice_chars,
        contiguous_envelopes: events.every((event, i) => event.seq === i && typeof event.type === 'string') })
    }
  } catch (error) {
    // Do not print parser messages, file paths, prompts, or command stderr.
    row.error = error.message === 'subject_changed' ? 'subject_changed' : error.name
  }
  rows.push(row)
  process.stderr.write(`${row.sample}: ${row.error ?? 'measured'}\n`)
}
const median = values => { const xs = [...values].sort((a, b) => a - b), n = xs.length; return n % 2 ? xs[n >> 1] : (xs[n / 2 - 1] + xs[n / 2]) / 2 }
const summary = {}
for (const key of ['read_ms', 'decompress_utf8_ms', 'json_parse_ms', 'guard_fold_ms', 'total_ms']) {
  const xs = rows.filter(r => !r.error).map(r => median(r.samples.map(s => s[key]))).sort((a, b) => a - b)
  summary[key] = xs.length ? { sessions: xs.length, mean: xs.reduce((a, b) => a + b) / xs.length,
    median: median(xs), p95: xs[Math.ceil(xs.length * .95) - 1], p99: xs[Math.ceil(xs.length * .99) - 1], max: xs.at(-1) } : null
}
const report = { schema: 'dsh-local-history-components/v1', classification: 'offline_component_replay',
  note: 'One latest-named generation per local directory, all directories equally weighted. OS cache not dropped. zstd CLI cost includes spawn, reread and UTF-8 conversion. Pure Guard fold excludes migration, host audit, private ledger, core/v2, IPC, frontend and paint. No provider/tokenizer measurement. Repeat medians precede corpus quantiles.',
  node: process.version, commit, build_sha256, script_sha256, repeats,
  directories: subjects.length, physical_logs: subjects.reduce((n, s) => n + s.available.length, 0),
  measured: rows.filter(r => !r.error).length, summary, rows }
if (runtime.some(f => sha(readFileSync(join(repo, 'dist', f))) !== build_sha256[f])
  || sha(readFileSync(fileURLToPath(import.meta.url))) !== script_sha256
  || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim() !== commit) {
  throw new Error('measurement_subject_changed')
}
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
if (report.measured !== report.directories) process.exitCode = 1
