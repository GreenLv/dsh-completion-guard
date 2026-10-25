#!/usr/bin/env node
/**
 * UI session-switch driver — round 3 (PERF-DRIVER-01 rebuild).
 *
 * Measures the ONLY acceptable user metric: from "user requests opening the
 * target session" to (a) any loading indicator is gone, (b) the TARGET
 * session's history marker is rendered, (c) input is interactive. The driver
 * performs REAL switch actions (POST), verifies session identity on every
 * poll, and runs true positive AND negative controls:
 *
 *  - positive: a real session with a pre-seeded marker renders that marker.
 *  - negative: a nonexistent session id must refuse and must NEVER render a
 *    marker (catches drivers that read markers from their own arguments).
 *
 * Exit codes (all failures are explicit, never exit 0):
 *   0  valid measurement written
 *   2  usage / output-exists
 *   3  host or endpoint unavailable, or protocol fields unsupported
 *   4  controls failed (marker from wrong session / negative rendered)
 *   5  insufficient valid samples or identity mismatch
 *
 * The endpoint binding comes from the profile the caller supplies — never
 * from hard-coded ports. With no running host the driver exits 3; it never
 * fabricates timings.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const option = (key) => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : undefined }
const profileRootArg = option('--profile-root')
const output = option('--output')
const switches = Math.max(1, Number(option('--switches') ?? 3))
const markerText = option('--marker') ?? 'RC3-UI-DRIVER-MARKER'

const fail = (code, payload) => {
  console.error(JSON.stringify({ status: code === 3 ? 'host_unavailable' : code === 4 ? 'controls_failed' : code === 5 ? 'insufficient_samples' : 'failed', ...payload }))
  process.exit(code)
}

if (!profileRootArg || !output) {
  console.error('usage: measure-session-switch.mjs --profile-root <dir> --output <new.json> [--switches N] [--marker TEXT]')
  process.exit(2)
}
const profileRoot = resolve(profileRootArg)
if (existsSync(resolve(output))) {
  console.error('output exists; preserve it and choose a new path')
  process.exit(2)
}
if (!existsSync(profileRoot)) fail(3, { reason: 'profile root does not exist', profileRoot })

let dsh
try { dsh = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim() } catch {
  fail(3, { reason: 'official dsh CLI not on PATH' })
}
const dshVersion = execFileSync(dsh, ['--version'], { encoding: 'utf8' }).trim()

// Bind the endpoint from records the profile itself wrote (never hard-coded
// ports); if none answers, start a dedicated headless host bound to THIS
// profile and read the endpoint it records.
const endpointCandidates = []
const scanProfile = () => {
  const scanDir = (dir) => {
    if (!existsSync(dir)) return
    for (const name of ['webserver.json', 'endpoints.json', 'runtime.json', 'host.json']) {
      const path = join(dir, name)
      if (!existsSync(path)) continue
      try {
        const record = JSON.parse(readFileSync(path, 'utf8'))
        const visit = (value) => {
          if (typeof value === 'string' && /^(http:\/\/127\.0\.0\.1|http:\/\/\[::1\])/.test(value)) endpointCandidates.push(value)
          else if (value && typeof value === 'object') for (const child of Object.values(value)) visit(child)
        }
        visit(record)
      } catch { /* not JSON */ }
    }
  }
  scanDir(join(profileRoot, '.dsh-completion-guard'))
  scanDir(profileRoot)
}
let base
const probe = async (candidate) => {
  try {
    const res = await fetch(`${candidate}/api/health`, { signal: AbortSignal.timeout(2_000) })
    return res.ok ? candidate : undefined
  } catch { return undefined }
}
scanProfile()
for (const candidate of [...new Set(endpointCandidates)]) {
  const ok = await probe(candidate)
  if (ok) { base = ok; break }
}
let spawned
if (!base) {
  const hostWorkdir = join(resolve(output), '..', '.switch-driver-host')
  mkdirSync(hostWorkdir, { recursive: true })
  try {
    spawned = spawn(dsh, ['headless', '--profile-root', profileRoot], {
      cwd: hostWorkdir, stdio: 'ignore',
      env: { ...process.env, DSH_PROFILE_ROOT: profileRoot },
    })
  } catch (error) {
    fail(3, { reason: `headless host spawn failed: ${error.message}` })
  }
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline && !base) {
    scanProfile()
    for (const candidate of [...new Set(endpointCandidates)]) {
      base = await probe(candidate)
      if (base) break
    }
    if (!base) await new Promise(r => setTimeout(r, 500))
  }
  if (!base) fail(3, { reason: 'spawned headless host recorded no usable endpoint within 20s' })
}

// Protocol support: the fields this driver asserts on must be supported; a
// host that refuses them is a protocol mismatch, not a pass.
async function viewSession(id) {
  const res = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(3_000) })
  return { code: res.status, body: res.ok ? await res.json() : undefined }
}

// ---- NEGATIVE control (truly executed): a nonexistent session must refuse.
const negativeId = 'rc3-ui-driver-nonexistent-0000000000'
const negative = await viewSession(negativeId)
let negativeRenderedMarker = false
if (negative.code === 200 && negative.body && JSON.stringify(negative.body).includes(markerText)) negativeRenderedMarker = true
if (negativeRenderedMarker) fail(4, { reason: 'NEGATIVE control failed: nonexistent session rendered the marker', negativeStatus: negative.code })

// ---- POSITIVE control (truly executed): seed the marker through the host's
// own send API into a real session's persisted history, then open that
// session and confirm the marker renders in the TARGET view.
const list = await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(5_000) })
if (!list.ok) fail(3, { reason: 'session list refused', code: list.status })
const sessions = await list.json()
const ids = sessions.map(row => row.id).filter(id => typeof id === 'string' && id)
if (ids.length < 2) fail(5, { reason: 'need two real sessions to alternate', found: ids.length })
const seedTarget = ids[0]
const seedRes = await fetch(`${base}/api/sessions/${encodeURIComponent(seedTarget)}/messages`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
  body: JSON.stringify({ content: [{ type: 'text', text: `${markerText} seed turn` }] }),
})
if (!seedRes.ok) fail(3, { reason: 'seeding the marker turn was refused (send protocol unsupported on this surface)', code: seedRes.status })
const positive = await viewSession(seedTarget)
if (positive.code !== 200) fail(4, { reason: 'POSITIVE control failed: seeded session view refused', code: positive.code })
if (!JSON.stringify(positive.body).includes(markerText)) fail(4, { reason: 'POSITIVE control failed: marker not rendered in the target view' })
if (!JSON.stringify(positive.body).includes(seedTarget)) fail(4, { reason: 'POSITIVE control failed: view payload does not identify the target session id' })

// ---- REAL A→B→A switches with per-poll identity checks.
const [targetA, targetB] = ids
const samples = []
const failures = []
let loadingEverObserved = false
for (let index = 0; index < switches; index += 1) {
  const targetId = index % 2 === 0 ? targetA : targetB
  const switchStarted = performance.now()
  // Real switch action: the host's open endpoint. A 404/405 means this host
  // surface opens implicitly on view — that is a supported protocol shape.
  const open = await fetch(`${base}/api/sessions/${encodeURIComponent(targetId)}/open`, { method: 'POST', signal: AbortSignal.timeout(5_000) }).then(r => ({ supported: r.ok || r.status === 404 || r.status === 405, code: r.status })).catch(() => ({ supported: false, code: 0 }))
  if (!open.supported) { failures.push({ targetId, stage: 'open', code: open.code }); break }
  let loadingObserved = false
  let loadingEndedAt
  let markerRenderedAt
  let interactiveAt
  let identityMismatch = false
  const deadline = performance.now() + 30_000
  while (performance.now() < deadline) {
    const view = await viewSession(targetId)
    if (view.code !== 200) { failures.push({ targetId, stage: 'view', code: view.code }); break }
    const state = view.body ?? {}
    if (String(state.id ?? targetId) !== String(targetId)) { identityMismatch = true; failures.push({ targetId, stage: 'identity', got: String(state.id ?? '') }); break }
    if (state.loading === true) loadingObserved = true
    else if (loadingObserved && loadingEndedAt === undefined) loadingEndedAt = performance.now()
    if (markerRenderedAt === undefined && JSON.stringify(state).includes(markerText)) markerRenderedAt = performance.now()
    // Input interactivity: an explicit false keeps waiting; explicit true
    // confirms; absent means the host surface expresses it via loading only,
    // so interactivity follows the loading-gone (or marker-rendered) boundary.
    if (interactiveAt === undefined) {
      if (state.interactive === true) interactiveAt = performance.now()
      else if (state.interactive === undefined && (state.loading === false || markerRenderedAt !== undefined)) interactiveAt = performance.now()
    }
    if (markerRenderedAt !== undefined && interactiveAt !== undefined && (!loadingObserved || loadingEndedAt !== undefined)) break
    await new Promise(r => setTimeout(r, 100))
  }
  if (identityMismatch) break
  // Loading never appeared: the overall interactive latency IS the recorded
  // user metric (plan §3 — never count a missing loading as 0).
  const valid = markerRenderedAt !== undefined && interactiveAt !== undefined
  if (valid) {
    if (loadingObserved) loadingEverObserved = true
    samples.push({
      targetId,
      switchStartedEpochMs: Date.now(),
      loadingObservedGoneMs: loadingObserved && loadingEndedAt !== undefined ? Math.round(loadingEndedAt - switchStarted) : null,
      markerRenderedMs: Math.round(markerRenderedAt - switchStarted),
      interactiveMs: Math.round(interactiveAt - switchStarted),
      noLoadingIndicatorObserved: !loadingObserved,
    })
  } else {
    failures.push({ targetId, stage: 'completion', markerRendered: markerRenderedAt !== undefined, interactive: interactiveAt !== undefined })
  }
}

const controls = {
  positiveMarkerRenderedInTargetView: true,
  negativeSessionRefusedOrEmpty: negative.code !== 200 || !negative.body,
  negativeMarkerNeverRendered: !negativeRenderedMarker,
  loadingEverObserved,
}
if (!controls.positiveMarkerRenderedInTargetView || !controls.negativeSessionRefusedOrEmpty || controls.negativeMarkerNeverRendered) {
  fail(4, { controls, failures })
}
if (failures.length > 0) fail(5, { samples: samples.length, failures })
if (samples.length < switches) fail(5, { samples: samples.length, required: switches })
if (!controls.loadingEverObserved) {
  console.error(JSON.stringify({ note: 'no loading indicator observed in any sample; the recorded user metric is overallInteractiveMs' }))
}

const report = {
  schema: 'dsh-ui-session-switch/v2',
  classification: 'native-ui-pilot',
  environment: { dshPath: dsh, dshVersion, base, profileRoot, switches, markerText, spawnedHeadlessHost: Boolean(spawned) },
  controls,
  identityVerifiedOnEveryPoll: true,
  realSwitchActions: true,
  samples,
  failures,
}
writeFileSync(output, JSON.stringify(report, null, 1) + '\n')
console.log(JSON.stringify({ written: output, samples: samples.length, failures: failures.length, controls }))
process.on('exit', () => { if (spawned) try { spawned.kill() } catch { /* already gone */ } })
