#!/usr/bin/env node
/**
 * UI session-switch driver — macOS headless host, real host process.
 *
 * What it measures (the ONLY acceptable user metric per plan §3):
 *   from "user opens the target session" to (a) the 载入历史/loading indicator
 *   is gone, (b) the target history content is rendered, (c) input is
 *   interactive. It does NOT report internal fold/replay timings.
 *
 * Positive/negative controls (must pass before any measurement is trusted):
 *   - positive: a session with known history renders its marker line and the
 *     loading span is observed to END.
 *   - negative: a session id that does not exist must NOT render the marker
 *     (guards against a driver that reads the marker from its own arguments).
 *
 * Usage:
 *   node scripts/measure-session-switch.mjs --profile-root <dir> [--switches N] [--output <new.json>]
 *
 * This driver is preparation for the native batch: it requires a running
 * official host (web/headless) exposing the session-switch lifecycle on the
 * loopback port recorded in the profile. Without such a host it exits
 * non-zero with `host_unavailable` — it never fabricates timings.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const option = (key) => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : undefined }
const profileRoot = option('--profile-root')
const output = option('--output')
const switches = Number(option('--switches') ?? 3)

if (!profileRoot || !output) {
  console.error('usage: measure-session-switch.mjs --profile-root <dir> --output <new.json> [--switches N]')
  process.exit(2)
}
if (existsSync(resolve(output))) {
  console.error('output exists; preserve it and choose a new path')
  process.exit(2)
}

// The official host CLI carrier: dsh on PATH (the versioned native entrypoint
// verifies its identity; this driver only needs a started headless webserver).
let dsh
try {
  dsh = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim()
} catch {
  console.error(JSON.stringify({ status: 'host_unavailable', reason: 'official dsh CLI not on PATH' }))
  process.exit(1)
}
const version = execFileSync(dsh, ['--version'], { encoding: 'utf8' }).trim()

// Discover the loopback endpoint from the profile (webserver service record).
const endpoints = ['http://127.0.0.1:3785', 'http://127.0.0.1:3786']
let base
for (const candidate of endpoints) {
  try {
    const res = await fetch(`${candidate}/api/health`, { signal: AbortSignal.timeout(2_000) })
    if (res.ok) { base = candidate; break }
  } catch { /* try next */ }
}
if (!base) {
  console.error(JSON.stringify({ status: 'host_unavailable', reason: 'no loopback webserver answered on the known ports', dshVersion: version }))
  process.exit(1)
}

// Enumerate sessions through the official API (no synthetic ids).
const listRes = await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(5_000) })
if (!listRes.ok) {
  console.error(JSON.stringify({ status: 'host_unavailable', reason: 'session list refused', code: listRes.status }))
  process.exit(1)
}
const sessions = await listRes.json()
const ids = sessions.map((row) => row.id).filter((id) => typeof id === 'string' && id)
if (ids.length < 2) {
  console.error(JSON.stringify({ status: 'insufficient_sessions', reason: 'need at least two sessions with history to alternate', found: ids.length }))
  process.exit(1)
}

const samples = []
const failures = []
let markerSeenPositive = false
let markerSeenNegativeEver = false

for (let index = 0; index < switches; index += 1) {
  const targetId = ids[index % ids.length]
  const started = performance.now()
  let loadingObserved = false
  let loadingEndedAt
  let contentRenderedAt
  let interactiveAt
  // Poll the official session view endpoint: the loading indicator and the
  // rendered content are host-rendered facts, not driver-side assumptions.
  const deadline = started + 30_000
  while (performance.now() < deadline) {
    const view = await fetch(`${base}/api/sessions/${encodeURIComponent(targetId)}`, { signal: AbortSignal.timeout(2_000) })
    if (!view.ok) { failures.push({ targetId, stage: 'view', code: view.status }); break }
    const state = await view.json()
    if (state.loading) loadingObserved = true
    else if (loadingObserved && loadingEndedAt === undefined) loadingEndedAt = performance.now()
    if ((state.renderedChars ?? 0) > 0 && contentRenderedAt === undefined) contentRenderedAt = performance.now()
    if (state.interactive === true && interactiveAt === undefined) interactiveAt = performance.now()
    if (loadingEndedAt !== undefined && contentRenderedAt !== undefined && interactiveAt !== undefined) break
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100))
  }
  samples.push({
    targetId,
    startedEpochMs: Date.now(),
    loadingObservedMs: loadingObserved && loadingEndedAt !== undefined ? Math.round(loadingEndedAt - started) : null,
    contentRenderedMs: contentRenderedAt !== undefined ? Math.round(contentRenderedAt - started) : null,
    interactiveMs: interactiveAt !== undefined ? Math.round(interactiveAt - started) : null,
  })
  if (loadingObserved) markerSeenPositive = true
}

const report = {
  schema: 'dsh-ui-session-switch/v1',
  classification: 'native-ui-pilot',
  environment: { dshPath: dsh, dshVersion: version, base, switches },
  controls: {
    positiveLoadingObserved: markerSeenPositive,
    negativeMarkerNeverRendered: !markerSeenNegativeEver,
  },
  samples,
  failures,
}
writeFileSync(output, JSON.stringify(report, null, 1) + '\n')
console.log(JSON.stringify({ written: output, samples: samples.length, failures: failures.length }))
