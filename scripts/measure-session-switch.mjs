#!/usr/bin/env node
/** rc.3 DOM driver. Requires a task-owned fixture and an explicit CDP browser.
 * No host REST guesses, CLI spawning, message sends or real-model requests.
 * Official DOM provenance: dsh-client-ui-workspace SessionNodeItem data-row-key /
 * aria-selected; dsh-client-ui-chat ChatView data-chat-flow and EvIC1a_hint;
 * dsh-client-ui-conversation ComposerContentEditable data-composer-input.
 * See docs/UI_PERFORMANCE.md for fixture preparation and evidence boundaries.
 */
import { writeUtf8Atomic, readJsonFile, readUtf8File, parseJsonBytes } from './ui-fixture-io.mjs'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

export class DriverError extends Error {
  constructor(code, reason, details = {}) { super(reason); this.code = code; this.details = details }
}
export function errorExitCode(error, fallback = 3) {
  return Number.isInteger(error?.code) && error.code > 0 && error.code <= 255 ? error.code : fallback
}
const refuse = (ok, code, reason, details) => { if (!ok) throw new DriverError(code, reason, details) }
export const DOM = Object.freeze({ row: '[data-row-key][role="treeitem"]', flow: '[data-chat-flow]', input: '[data-composer-input][role="textbox"]', loading: '.EvIC1a_hint', error: '.EvIC1a_openError' })
export function validateFixture(fixture, requireProtection = false) {
  refuse(fixture?.schema === 'dsh-ui-fixture/v1' && fixture.ownership === 'task-owned', 2, 'task-owned fixture manifest required')
  refuse(['0.2.1-rc.2', '0.2.1-rc.3'].includes(fixture.hostVersion), 3, 'unreviewed frontend version')
  refuse(typeof fixture.profileRoot === 'string' && existsSync(fixture.profileRoot), 2, 'fixture profile missing')
  refuse(typeof fixture.home === 'string' && /^[a-f0-9-]{36}$/.test(fixture.nonce ?? '') && /^[a-f0-9]{40}$/.test(fixture.sourceCommit ?? ''), 2, 'fixture ownership/subject unbound')
  const owner = readJsonFile(join(fixture.home, '.guard-ui-fixture-owner.json'))
  refuse(owner.nonce === fixture.nonce && owner.sourceCommit === fixture.sourceCommit && resolve(fixture.profileRoot) === join(resolve(fixture.home), 'profiles', fixture.surface === 'desktop' ? 'desktop' : 'web'), 2, 'fixture ownership/profile mismatch')
  refuse(Number.isSafeInteger(fixture.preludeTurns) && fixture.preludeTurns >= 0 && fixture.preludeTurns <= 10000, 2, 'invalid fixture history scale')
  const url = new URL(fixture.frontendUrl)
  refuse(fixture.surface === undefined || ['web', 'desktop'].includes(fixture.surface), 2, 'unsupported fixture surface')
  if (fixture.surface === 'desktop') refuse(fixture.frontendUrl === 'dsh-app://app/', 2, 'explicit owned Desktop main renderer required')
  else refuse(['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname), 2, 'explicit loopback fixture frontend required')
  refuse(Array.isArray(fixture.sessions) && fixture.sessions.length === 2 && fixture.sessions.every(s => typeof s.id === 'string' && s.id && typeof s.marker === 'string' && s.marker.length >= 12), 2, 'two preseeded sessions with unique history markers required')
  refuse(fixture.sessions[0].id !== fixture.sessions[1].id && fixture.sessions[0].marker !== fixture.sessions[1].marker, 2, 'fixture identities and markers must differ')
  if (requireProtection) refuse(fixture.protection?.schema === 'dsh-ui-protected-fixture/v1' && fixture.protection.status === 'verified' && fixture.protection.statusPath === `/api/guard-ui-fixture/${fixture.nonce}` && fixture.protection.mode === 'always' && fixture.protection.hostLockStatus === 'supported' && fixture.protection.guardGitHead === fixture.sourceCommit && fixture.sessions.every(s => s.persistedReadbackVerified === true && s.protection?.mode === 'always' && s.protection.bindingSource === 'fresh_creation' && s.protection.registeredGuardTool === true), 3, 'loaded active Guard protection not established')
  return fixture
}
export function validateDesktopOwnership(receipt, fixture, endpoint) {
  refuse(receipt?.schema === 'dsh-ui-desktop-owner/v1' && receipt.fixtureNonce === fixture.nonce && receipt.sourceCommit === fixture.sourceCommit && receipt.hostVersion === fixture.hostVersion, 2, 'Desktop owner receipt subject mismatch')
  refuse(receipt.home === resolve(fixture.home) && receipt.userDataDir === join(resolve(fixture.home), 'desktop-user-data') && existsSync(receipt.userDataDir), 2, 'Desktop owner isolation paths mismatch')
  refuse(receipt.cdpUrl === endpoint && receipt.rendererUrl === 'dsh-app://app/' && typeof receipt.targetId === 'string' && receipt.targetId.length > 0 && Number.isSafeInteger(receipt.processId) && receipt.processId > 0 && /^[a-f0-9]{64}$/.test(receipt.carrierSha256 ?? ''), 2, 'Desktop owner target/process/carrier unbound')
  return receipt
}
export function startupWebUrl(logBytes, frontendUrl) {
  // A log is a stream, unlike atomic metadata. Only complete lines may carry
  // the official startup URL; never consume a partially written token.
  const end = logBytes.lastIndexOf(10)
  const text = end < 0 ? '' : new TextDecoder('utf-8', { fatal: true }).decode(logBytes.subarray(0, end + 1))
  const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  const urls = new Set()
  for (const match of clean.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
    let url
    try { url = new URL(match[0]) } catch { continue }
    if (!url.searchParams.has('token')) continue
    refuse(url.origin === new URL(frontendUrl).origin && url.pathname === '/' && !url.username && !url.password && !url.hash && [...url.searchParams.keys()].every(key => key === 'token') && url.searchParams.getAll('token').length === 1 && url.searchParams.get('token'), 3, 'startup auth URL identity refused')
    urls.add(url.href)
  }
  refuse(urls.size === 1, 3, urls.size ? 'ambiguous startup auth URLs' : 'startup auth URL unavailable')
  return [...urls][0]
}
export function webPreparationEntry(readyPath, fixture) {
  refuse(typeof readyPath === 'string' && readyPath.endsWith('.ready.json'), 2, 'current Web preparation ready receipt required')
  const bytes = readFileSync(readyPath), ready = parseJsonBytes(bytes)
  refuse(ready.sourceCommit === fixture.sourceCommit && ready.artifactSha256 === fixture.artifactSha256 && ready.profileRoot === fixture.profileRoot && ready.hostStarted === true && Number.isSafeInteger(ready.ownedPid) && ready.ownedPid > 0 && ready.frontendAuthReady === true && ready.protection?.statusPath === fixture.protection.statusPath && ready.protection?.guardGitHead === fixture.sourceCommit, 3, 'Web preparation identity mismatch')
  const plan = readJsonFile(ready.fixturePath)
  refuse(plan.nonce === fixture.nonce && plan.home === fixture.home && plan.sourceCommit === fixture.sourceCommit && plan.artifactSha256 === fixture.artifactSha256, 3, 'Web preparation plan mismatch')
  try { process.kill(ready.ownedPid, 0) } catch { throw new DriverError(3, 'owned Web host is not live') }
  const log = readFileSync(readyPath.slice(0, -'.ready.json'.length) + '.host.log')
  refuse(log.length <= 16 * 1024 * 1024, 3, 'startup log budget exceeded')
  const entryUrl = startupWebUrl(log, fixture.frontendUrl)
  return { entryUrl, token: new URL(entryUrl).searchParams.get('token'), readySha256: createHash('sha256').update(bytes).digest('hex'), ownedPid: ready.ownedPid }
}
const redactLaunch = (value, launch) => {
  if (!launch) return value
  const string = text => text.replaceAll(launch.entryUrl, '[private startup URL]').replaceAll(launch.token, '[private startup token]')
  if (typeof value === 'string') return string(value)
  if (Array.isArray(value)) return value.map(row => redactLaunch(row, launch))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, row]) => [string(key), redactLaunch(row, launch)]))
  return value
}
/** Reviewed rc.2/rc.3 public onboarding and ungrouped navigation only. */
export function readFrontendState(document, action) {
  const visible = e => Boolean(e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden')
  const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible)
  const title = e => e.querySelector('h2')?.textContent?.trim()
  const buttons = e => [...e.querySelectorAll('button')].filter(visible)
  const opens = [...document.querySelectorAll('button[aria-label]')].filter(e => visible(e) && ['打开侧边栏', 'Open sidebar'].includes(e.getAttribute('aria-label')))
  const groups = [...document.querySelectorAll('[data-row-key="workspace:"][role="treeitem"]')].filter(visible)
  if (action) {
    let candidates = []
    if (action === 'acknowledge-preview' && dialogs.length === 1 && ['预览版说明', 'Preview Notice'].includes(title(dialogs[0]))) candidates = buttons(dialogs[0]).filter(e => ['继续', 'Continue'].includes(e.textContent.trim()) && !e.disabled)
    if (action === 'open-sidebar' && dialogs.length === 0) candidates = opens
    if (action === 'expand-ungrouped' && dialogs.length === 0) candidates = groups.filter(e => e.getAttribute('aria-expanded') === 'false')
    if (candidates.length !== 1) return null
    const e = candidates[0], r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2
    return r.width > 0 && r.height > 0 && e.contains(document.elementFromPoint(x, y)) ? { x, y } : null
  }
  return { url: document.location.href, viewport: { width: document.defaultView.innerWidth, height: document.defaultView.innerHeight, devicePixelRatio: document.defaultView.devicePixelRatio },
    dialogs: dialogs.map(e => ({ title: title(e), continueCount: buttons(e).filter(b => ['继续', 'Continue'].includes(b.textContent.trim())).length, continueEnabled: buttons(e).some(b => ['继续', 'Continue'].includes(b.textContent.trim()) && !b.disabled), alerts: [...e.querySelectorAll('[role="alert"]')].filter(visible).length })),
    openSidebarCount: opens.length, groups: groups.map(e => ({ expanded: e.getAttribute('aria-expanded') })),
    rows: [...document.querySelectorAll('[data-row-key][role="treeitem"]')].filter(visible).map(e => e.getAttribute('data-row-key')) }
}
export async function prepareFrontend(page, fixture, { timeoutMs = 15000, pollMs = 50, signal } = {}) {
  const startedEpochMs = Date.now(), deadline = performance.now() + timeoutMs, actions = [], done = new Set()
  let last
  while (performance.now() < deadline) {
    signal?.throwIfAborted()
    const state = await page.readFrontend(); last = state
    refuse(state.dialogs.length <= 1 && state.openSidebarCount <= 1 && state.groups.length <= 1, 3, 'ambiguous frontend readiness controls')
    let action
    if (state.dialogs.length) {
      const dialog = state.dialogs[0]
      refuse(['预览版说明', 'Preview Notice'].includes(dialog.title) && dialog.continueCount === 1 && dialog.alerts === 0, 3, 'unreviewed or failed frontend dialog')
      if (!done.has('acknowledge-preview') && dialog.continueEnabled !== false) action = 'acknowledge-preview'
    } else if (state.openSidebarCount === 1 && !done.has('open-sidebar')) action = 'open-sidebar'
    else if (state.groups.length === 1 && state.groups[0].expanded === 'false' && !done.has('expand-ungrouped')) action = 'expand-ungrouped'
    else if (state.url === fixture.frontendUrl && fixture.sessions.every(row => state.rows.includes('session:' + row.id))) {
      refuse(state.groups.length === 1 && state.groups[0].expanded === 'true', 3, 'fixture ungrouped navigation contract mismatch')
      return { startedEpochMs, completedEpochMs: Date.now(), viewport: state.viewport, actions }
    }
    if (action) { const epochMs = Date.now(); await page.clickFrontend(action); done.add(action); actions.push({ action, epochMs }) }
    await pause(pollMs)
  }
  throw new DriverError(5, 'frontend readiness timed out', { actions, viewport: last?.viewport })
}
/** Runs in the real browser, reading only rendered DOM; no payload echo. */
export function readDom(document, selectors) {
  const visible = e => Boolean(e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden')
  const rows = [...document.querySelectorAll(selectors.row)].filter(e => e.getAttribute('data-row-key')?.startsWith('session:') && visible(e))
  const flows = [...document.querySelectorAll(selectors.flow)].filter(visible)
  const inputs = [...document.querySelectorAll(selectors.input)].filter(visible)
  const flow = flows.length === 1 ? flows[0] : undefined
  const input = inputs.length === 1 ? inputs[0] : undefined
  const structuralEmpty = input && input.textContent === '' && (input.childNodes.length === 0 || (input.childNodes.length === 1 && input.firstChild.nodeName === 'P' && input.firstChild.childNodes.length === 1 && input.firstChild.firstChild.nodeName === 'BR'))
  return {
    url: document.location.href,
    selected: rows.filter(e => e.getAttribute('aria-selected') === 'true').map(e => e.getAttribute('data-row-key').slice('session:'.length)),
    rows: rows.map(e => e.getAttribute('data-row-key')),
    flowCount: flows.length, inputCount: inputs.length,
    historyText: flow?.innerText,
    loading: Boolean(flow && [...flow.querySelectorAll(selectors.loading)].some(visible)),
    loadError: Boolean(flow && [...flow.querySelectorAll(selectors.error)].some(visible)),
    editable: Boolean(input?.isContentEditable && input.getAttribute('aria-disabled') !== 'true'),
    draft: structuralEmpty ? '' : input?.innerText,
  }
}
export function checkSnapshot(state, target, other, previous) {
  refuse(state && Array.isArray(state.selected) && Array.isArray(state.rows) && typeof state.loading === 'boolean' && typeof state.editable === 'boolean', 3, 'unsupported DOM observation')
  refuse(state.selected.length <= 1, 5, 'ambiguous selected session')
  const selected = state.selected[0]
  refuse(selected === target.id || selected === previous, 5, 'unexpected selected session', { expected: target.id, observed: selected })
  if (selected !== target.id) return false // a real pending transition, never a successful sample
  refuse(state.flowCount === 1 && state.inputCount === 1 && typeof state.historyText === 'string' && typeof state.draft === 'string', 3, 'required frontend surface missing')
  refuse(!state.loadError, 5, 'history load failed')
  // The other session's unique persisted marker must not be mistaken for this
  // target's history. Sidebar/title strings are outside data-chat-flow.
  refuse(!state.historyText.includes(other.marker), 4, 'wrong-session history marker')
  return !state.loading && state.editable && state.historyText.includes(target.marker)
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
export async function measureSwitches(page, fixture, { switches = 3, timeoutMs = 30000, pollMs = 16, signal } = {}) {
  refuse(Number.isInteger(switches) && switches >= 3 && Number.isFinite(timeoutMs) && timeoutMs > 0, 2, 'at least three switches and a finite positive deadline required')
  const samples = []
  let initialOpen
  const [a, b] = fixture.sessions
  const read = async () => { const state = await page.read(); if (fixture.frontendUrl) { refuse(typeof state.url === 'string' && (fixture.surface === 'desktop' ? state.url === 'dsh-app://app/' : new URL(state.url).origin === new URL(fixture.frontendUrl).origin), 3, 'frontend origin mismatch') } return state }
  const liveProof = async () => {
    refuse(typeof page.readProtection === 'function', 3, 'live Guard observer unavailable')
    const proof = await page.readProtection(fixture.protection.statusPath)
    refuse(proof?.schema === 'dsh-ui-live-protection/v1' && proof.nonce === fixture.nonce && proof.guardGitHead === fixture.sourceCommit && proof.guardVersion === fixture.protection.guardVersion, 3, 'live Guard observer identity mismatch')
    return proof
  }
  const wait = async (target, other, previous, start, record) => {
    let loadingObserved = false, loadingStartedAt, loadingEndedAt
    while (performance.now() - start < timeoutMs) {
      signal?.throwIfAborted()
      const state = await read()
      if (state.loading === true) { loadingObserved = true; loadingStartedAt ??= performance.now() }
      else if (loadingStartedAt !== undefined && loadingEndedAt === undefined) loadingEndedAt = performance.now()
      if (checkSnapshot(state, target, other, previous)) {
        if (fixture.protection) {
          const proof = await liveProof()
          const targetProof = proof.sessions?.find(row => row.id === target.id)
          if (!targetProof?.live) { await pause(pollMs); continue } // official UI promotion still pending
          refuse(targetProof.mode === 'always' && targetProof.registeredGuardTool === true, 4, 'target is not actively protected by loaded Guard')
        }
        refuse(state.draft === '', 4, 'task fixture composer must start empty')
        // Input.insertText is an actual browser input event, never a guessed
        // interactive flag. No Enter or send action occurs. Restore empty draft.
        const probe = 'guard-ui-input-probe'
        let completedAt, completedEpochMs
        try {
          await page.insertText(probe)
          const typed = await read()
          refuse(checkSnapshot(typed, target, other, target.id) && typed.selected.length === 1 && typed.selected[0] === target.id && typed.draft === probe, 4, 'composer input readback failed')
          completedAt = performance.now(); completedEpochMs = Date.now()
        } finally { await page.clearDraft() }
        const restored = await read()
        refuse(restored.draft === '' && restored.selected[0] === target.id, 4, 'fixture draft restoration failed')
        const observation = { targetId: target.id, loadingObserved, overallInteractiveMs: completedAt - start, loadingAppearedMs: loadingStartedAt === undefined ? null : loadingStartedAt - start, loadingEndedMs: loadingEndedAt === undefined ? null : loadingEndedAt - start, loadingObservedDurationMs: loadingStartedAt === undefined || loadingEndedAt === undefined ? null : loadingEndedAt - loadingStartedAt, cleanupMs: performance.now() - completedAt, markerObserved: true, inputEventReadback: true, draftRestored: true, completedEpochMs }
        if (record) samples.push(observation)
        return observation
      }
      await pause(pollMs)
    }
    throw new DriverError(5, 'session switch timed out', { targetId: target.id, samples })
  }
  try {
  // Establish B first so every measured action is a genuine switch A→B→A.
  let initial = await read()
  const initialProtection = fixture.protection ? await liveProof() : undefined
  const initialTargetWasLive = initialProtection?.sessions?.find(row => row.id === b.id)?.live ?? null
  const initialEpoch = Date.now(), initialStart = performance.now()
  await page.select(b.id)
  initialOpen = { ...await wait(b, a, initial.selected?.[0], initialStart, false), switchStartedEpochMs: initialEpoch, preClickTargetLive: initialTargetWasLive, selectedBeforeClick: initial.selected, layer: 'renderer_click_to_input_readback; thermal_state_not_assigned' }
  const absent = 'guard-ui-missing-session-control'
  refuse(!fixture.sessions.some(s => s.id === absent), 2, 'reserved negative identity collision')
  let missingRefused = false
  try { await page.select(absent) } catch (error) { if (error instanceof DriverError && error.message === 'session row missing') missingRefused = true; else throw error }
  refuse(missingRefused, 4, 'missing session selection was not refused')
  const afterNegative = await read()
  refuse(afterNegative.selected.length === 1 && afterNegative.selected[0] === b.id, 4, 'negative control changed session')
  let oppositeRejected = false
  try { checkSnapshot(afterNegative, { ...b, marker: a.marker }, { ...a, marker: b.marker }, b.id) } catch (error) { if (error instanceof DriverError && error.message === 'wrong-session history marker') oppositeRejected = true; else throw error }
  refuse(oppositeRejected, 4, 'actual history accepted the wrong marker expectation')
  for (let index = 0; index < switches; index++) {
    signal?.throwIfAborted()
    const target = index % 2 === 0 ? a : b, other = index % 2 === 0 ? b : a
    const startedEpochMs = Date.now(), start = performance.now()
    await page.select(target.id)
    await wait(target, other, other.id, start, true)
    samples.at(-1).switchStartedEpochMs = startedEpochMs
  }
  refuse(samples.length === switches, 5, 'insufficient samples')
  return { samples, initialOpen, controls: { missingSessionSelectionRefused: true, oppositeHistoryMarkerRejected: true, actualComposerInputReadback: true }, classification: 'native-ui-observation', protocol: 'official-rc2-rc3-dom/v1' }
  } catch (error) {
    if (error instanceof DriverError) error.details = { ...error.details, partialSamples: samples, initialOpen }
    throw error
  }
}

/** Minimal CDP client uses Node 22+ WebSocket; owns one tab, never the browser. */
class Cdp {
  constructor(socket) { this.socket = socket; this.pending = new Map(); this.counter = 0; socket.addEventListener('message', event => { let msg; try { msg = JSON.parse(String(event.data)) } catch { socket.close(); return } const p = this.pending.get(msg.id); if (!p) return; this.pending.delete(msg.id); clearTimeout(p.timer); msg.error ? p.reject(new DriverError(3, 'CDP protocol error', msg.error)) : p.resolve(msg.result) }); socket.addEventListener('close', () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new DriverError(3, 'CDP closed')) } this.pending.clear() }) }
  call(method, params = {}, sessionId) { return new Promise((resolve, reject) => { const id = ++this.counter; const timer = setTimeout(() => { this.pending.delete(id); reject(new DriverError(3, 'CDP command timed out', { method })) }, 5000); this.pending.set(id, { resolve, reject, timer }); try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })) } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(new DriverError(3, 'CDP send failed', { reason: error.message })) } }) }
  close() { this.socket.close() }
}
export async function connectPage(endpoint, frontendUrl, { surface = 'web', desktopTargetId } = {}) {
  refuse(['web', 'desktop'].includes(surface), 2, 'unsupported CDP surface')
  if (surface === 'desktop') refuse(frontendUrl === 'dsh-app://app/' && typeof desktopTargetId === 'string' && desktopTargetId.length > 0, 2, 'explicit task-owned main renderer target required')
  const url = new URL(endpoint)
  refuse(url.protocol === 'http:' && !url.username && !url.password && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname), 2, 'loopback CDP endpoint required')
  const res = await fetch(new URL('/json/version', url), { signal: AbortSignal.timeout(5000), redirect: 'error' })
  refuse(res.ok, 3, 'CDP discovery refused', { status: res.status })
  const info = await res.json(), socketUrl = new URL(info.webSocketDebuggerUrl)
  refuse(['127.0.0.1', '[::1]', 'localhost'].includes(socketUrl.hostname) && socketUrl.protocol === 'ws:' && socketUrl.host === url.host, 3, 'unbound CDP WebSocket')
  const socket = new WebSocket(socketUrl)
  await new Promise((resolve, reject) => { const timer = setTimeout(() => { socket.close(); reject(new DriverError(3, 'CDP connection timed out')) }, 5000); socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true }); socket.addEventListener('error', () => { clearTimeout(timer); socket.close(); reject(new DriverError(3, 'CDP connection failed')) }, { once: true }) })
  const cdp = new Cdp(socket)
  let targetId, sessionId, ownsTab = false
  try {
    if (surface === 'desktop') {
      const targets = await cdp.call('Target.getTargets')
      const target = targets.targetInfos?.find(row => row.targetId === desktopTargetId)
      refuse(target?.type === 'page' && target.url === 'dsh-app://app/', 3, 'Desktop main renderer identity mismatch')
      targetId = desktopTargetId
    } else { targetId = (await cdp.call('Target.createTarget', { url: frontendUrl })).targetId; ownsTab = true }
    ;({ sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true }))
    const evaluate = async expression => {
      const value = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
      refuse(!value.exceptionDetails, 3, 'frontend evaluation failed', value.exceptionDetails)
      return value.result?.value
    }
    if (surface === 'web') await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId)
    return {
      readFrontend: () => evaluate(`(${readFrontendState.toString()})(document)`),
      clickFrontend: async action => {
        const point = await evaluate(`(${readFrontendState.toString()})(document,${JSON.stringify(action)})`)
        refuse(point, 3, 'frontend readiness control unavailable', { action })
        await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }, sessionId)
        await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }, sessionId)
      },
      read: () => evaluate(`(${readDom.toString()})(document,${JSON.stringify(DOM)})`),
      readProtection: path => evaluate(`(async()=>{const r=await fetch(new URL(${JSON.stringify(path)},location.href),{redirect:'error'});if(!r.ok)throw Error('live Guard observer refused');return await r.json()})()`),
      select: async id => {
        const point = await evaluate(`(() => { const e=[...document.querySelectorAll(${JSON.stringify(DOM.row)})].find(e=>e.getAttribute('data-row-key')===${JSON.stringify('session:' + id)}); if(!e)return null; e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; return r.width>0 && r.height>0 && e.contains(document.elementFromPoint(x,y)) ? {x,y} : null })()`)
        refuse(point, 5, 'session row missing', { id })
        await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }, sessionId)
        await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }, sessionId)
      },
      insertText: async text => {
        const point = await evaluate(`(() => { const e=document.querySelector(${JSON.stringify(DOM.input)}); if(!e || !e.isContentEditable)return null; const r=e.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; return e.contains(document.elementFromPoint(x,y)) ? {x,y} : null })()`)
        refuse(point, 4, 'composer cannot receive pointer input')
        await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }, sessionId)
        await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }, sessionId)
        await cdp.call('Input.insertText', { text }, sessionId)
      },
      clearDraft: async () => { await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: process.platform === 'darwin' ? 4 : 2 }, sessionId); await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' }, sessionId); await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace' }, sessionId); await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' }, sessionId) },
      close: async () => { try { if (ownsTab) await cdp.call('Target.closeTarget', { targetId }); else await cdp.call('Target.detachFromTarget', { sessionId }) } finally { cdp.close() } },
    }
  } catch (error) { try { if (ownsTab && targetId) await cdp.call('Target.closeTarget', { targetId }); else if (sessionId) await cdp.call('Target.detachFromTarget', { sessionId }) } finally { cdp.close() } throw error }
}
export async function main(args = process.argv.slice(2)) {
  const option = key => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1] }
  const output = option('--output'), fixturePath = option('--fixture'), endpoint = option('--cdp-url')
  refuse(output && fixturePath && endpoint && !existsSync(output), 2, 'usage: --fixture <manifest> --cdp-url <loopback> --output <new.json> [--switches N]; existing output is preserved')
  const bytes = readFileSync(fixturePath), fixture = validateFixture(parseJsonBytes(bytes), true)
  const controller = new AbortController(), interrupt = () => controller.abort(new DriverError(130, 'interrupted'))
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt)
  let page, report, code = 0, webLaunch, frontendReadiness
  let desktopOwner, desktopOwnerSha256
  try {
    if (fixture.surface === 'desktop') {
      refuse(option('--desktop-ownership'), 2, 'Desktop owner receipt required')
      const ownerBytes = readFileSync(option('--desktop-ownership'))
      desktopOwner = validateDesktopOwnership(parseJsonBytes(ownerBytes), fixture, endpoint)
      desktopOwnerSha256 = createHash('sha256').update(ownerBytes).digest('hex')
    }
    if (fixture.surface !== 'desktop') webLaunch = webPreparationEntry(option('--web-preparation'), fixture)
    page = await connectPage(endpoint, webLaunch?.entryUrl ?? fixture.frontendUrl, { surface: fixture.surface ?? 'web', desktopTargetId: desktopOwner?.targetId })
    frontendReadiness = await prepareFrontend(page, fixture, { signal: controller.signal })
    report = { status: 'passed', frontendReadiness, ...await measureSwitches(page, fixture, { switches: Number(option('--switches') ?? 3), signal: controller.signal }) }
  } catch (error) { code = errorExitCode(error); report = { status: 'failed', ...(frontendReadiness ? { frontendReadiness } : {}), reason: error.message, details: error.details ?? {} } }
  finally {
    try { await page?.close() } catch (error) { code ||= 3; report = { ...report, status: 'failed', cleanupError: error.message } }
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt)
  }
  writeUtf8Atomic(output, JSON.stringify({ schema: 'dsh-ui-session-switch/v3', fixtureSha256: createHash('sha256').update(bytes).digest('hex'), hostVersion: fixture.hostVersion, surface: fixture.surface ?? 'web', desktopTargetId: desktopOwner?.targetId, desktopOwnerSha256, profileRoot: fixture.profileRoot, frontendUrl: fixture.frontendUrl, ...redactLaunch(report, webLaunch), ...(webLaunch ? { webPreparationSha256: webLaunch.readySha256, webAuthExchangeAttempted: true } : {}) }, null, 2) + '\n', { flag: 'wx' })
  return code
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then(code => { process.exitCode = code }, error => { console.error(JSON.stringify({ status: 'failed', reason: error.message })); process.exitCode = errorExitCode(error) })
