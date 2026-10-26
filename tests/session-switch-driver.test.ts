import { describe, expect, it, vi } from 'vitest'
// The Node driver has no build step and is imported without invoking its CLI.
// @ts-expect-error Native Node .mjs entrypoint has no TypeScript build declaration.
const { measureSwitches, checkSnapshot, DriverError, DOM, connectPage, readDom } = await import('../scripts/measure-session-switch.mjs')
const a = { id: 'fixture-a', marker: 'unique-history-marker-A' }
const b = { id: 'fixture-b', marker: 'unique-history-marker-B' }
const fixture = { sessions: [a, b] }
function pageFixture(options: Record<string, unknown> = {}) {
  let selected = a.id, draft = ''
  let reads = 0, clears = 0
  const actions: string[] = []
  return {
    actions,
    get clears() { return clears },
    read: async () => {
      reads++
      const target = selected === a.id ? a : b
      return { selected: [selected], rows: ['session:' + a.id, 'session:' + b.id], flowCount: 1, inputCount: 1, historyText: target.marker, loading: false, loadError: false, editable: true, draft, ...options }
    },
    select: async (id: string) => { if (![a.id, b.id].includes(id)) throw new DriverError(5, 'session row missing'); selected = id; actions.push(id) },
    insertText: async (text: string) => { draft = text },
    clearDraft: async () => { draft = ''; clears++ },
  }
}
describe('PERF-DRIVER-01 official DOM observation driver controls', () => {
  it('completes B initialization followed by real A/B/A actions and input/readback/restoration', async () => {
    const page = pageFixture()
    const result = await measureSwitches(page, fixture, { switches: 3, pollMs: 0 })
    expect(page.actions).toEqual([b.id, a.id, b.id, a.id])
    expect(result.samples).toHaveLength(3)
    expect(result.initialOpen).toMatchObject({ targetId: b.id, inputEventReadback: true, draftRestored: true })
    expect(result.initialOpen.completedEpochMs).toBeGreaterThanOrEqual(result.initialOpen.switchStartedEpochMs)
    expect(result.samples.every((s: { inputEventReadback: boolean; draftRestored: boolean; overallInteractiveMs: number }) => s.inputEventReadback && s.draftRestored && s.overallInteractiveMs > 0)).toBe(true)
    expect(page.clears).toBe(4)
  })
  it('accepts observed loading then disappearance without requiring every switch to show an indicator', async () => {
    const page = pageFixture(), read = page.read, select = page.select
    let firstReadAfterSelect = false
    page.select = async id => { await select(id); firstReadAfterSelect = true }
    page.read = async () => { const loading = firstReadAfterSelect; firstReadAfterSelect = false; return { ...await read(), loading } }
    expect((await measureSwitches(page, fixture, { switches: 3, pollMs: 0 })).samples).toHaveLength(3)
  })
  it.each([
    ['missing selected identity', { selected: [] }, 5],
    ['wrong selected identity', { selected: ['foreign'] }, 5],
    ['ambiguous identity', { selected: [a.id, b.id] }, 5],
    ['unknown frontend flow', { flowCount: 0 }, 3],
    ['unknown composer', { inputCount: 0 }, 3],
    ['history load error', { loadError: true }, 5],
    ['permanent loading', { loading: true }, 5],
    ['missing marker', { historyText: 'not the marker' }, 5],
    ['noninteractive input', { editable: false }, 5],
    ['unknown interactivity', { editable: undefined }, 3],
    ['nonempty fixture draft', { draft: 'preserve me' }, 4],
  ])('%s never becomes a valid measurement', async (_name, patch, code) => {
    await expect(measureSwitches(pageFixture(patch as Record<string, unknown>), fixture, { switches: 3, timeoutMs: 8, pollMs: 0 })).rejects.toMatchObject({ code })
  })
  it('rejects opposite-session history through the same production snapshot checker', () => {
    expect(() => checkSnapshot({ selected: [a.id], rows: [], flowCount: 1, inputCount: 1, historyText: b.marker, loading: false, loadError: false, editable: true, draft: '' }, a, b, b.id)).toThrow('wrong-session history marker')
  })
  it('rejects insufficient sample declarations and cancellation', async () => {
    await expect(measureSwitches(pageFixture(), fixture, { switches: 2 })).rejects.toMatchObject({ code: 2 })
    const signal = AbortSignal.abort(new DriverError(130, 'interrupted'))
    await expect(measureSwitches(pageFixture(), fixture, { switches: 3, signal })).rejects.toMatchObject({ code: 130 })
  })
  it('always restores a touched draft even when its input readback fails', async () => {
    const page = pageFixture()
    page.insertText = async () => {}
    await expect(measureSwitches(page, fixture, { switches: 3 })).rejects.toThrow('composer input readback failed')
    expect(page.clears).toBe(1)
  })
  it.each(['valid', 'inactive', 'foreign', 'pending'])('requires real live Guard observation: %s', async kind => {
    const page = { ...pageFixture(), readProtection: async () => ({ schema: 'dsh-ui-live-protection/v1', nonce: 'fixture', guardGitHead: kind === 'foreign' ? 'foreign' : 'head', guardVersion: '0.11.0', sessions: [a, b].map(s => ({ id: s.id, live: kind !== 'pending', mode: kind === 'inactive' ? 'mode_unknown' : 'always', registeredGuardTool: true })) }) }
    const protectedFixture = { ...fixture, nonce: 'fixture', sourceCommit: 'head', protection: { statusPath: '/owned-observer', guardVersion: '0.11.0' } }
    if (kind === 'valid') expect((await measureSwitches(page, protectedFixture, { switches: 3, timeoutMs: 50, pollMs: 0 })).samples).toHaveLength(3)
    else await expect(measureSwitches(page, protectedFixture, { switches: 3, timeoutMs: 8, pollMs: 0 })).rejects.toMatchObject({ code: kind === 'foreign' ? 3 : kind === 'pending' ? 5 : 4 })
  })
  it('pins the actual rc.3 public DOM attributes, without invented REST fields', () => {
    expect(DOM.row).toBe('[data-row-key][role="treeitem"]')
    expect(DOM.flow).toBe('[data-chat-flow]')
    expect(DOM.input).toBe('[data-composer-input][role="textbox"]')
  })
})


describe('CDP ownership and cleanup controls (transport fixtures, not native UI)', () => {
  it.each([404, 405, 500])('refuses discovery HTTP %s rather than inferring a supported protocol', async status => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status }))
    try { await expect(connectPage('http://127.0.0.1:43123', 'http://127.0.0.1:43124')).rejects.toMatchObject({ code: 3 }) }
    finally { vi.unstubAllGlobals() }
  })
  it.each(['success', 'Target.createTarget', 'Target.attachToTarget'])('closes owned tab/socket for %s path', async failure => {
    const calls: string[] = []; let closed = 0
    class Socket extends EventTarget {
      constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))) }
      send(raw: string) {
        const request = JSON.parse(raw); calls.push(request.method)
        const result = request.method === 'Target.createTarget' ? { targetId: 'owned-tab' } : request.method === 'Target.attachToTarget' ? { sessionId: 'owned-session' } : {}
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: request.id, ...(request.method === failure ? { error: { message: 'fixture failure' } } : { result }) }) })))
      }
      close() { closed++; this.dispatchEvent(new Event('close')) }
    }
    vi.stubGlobal('fetch', async () => Response.json({ webSocketDebuggerUrl: 'ws://127.0.0.1:43123/devtools/browser/fixture' }))
    vi.stubGlobal('WebSocket', Socket)
    try {
      if (failure === 'success') await (await connectPage('http://127.0.0.1:43123', 'http://127.0.0.1:43124')).close()
      else await expect(connectPage('http://127.0.0.1:43123', 'http://127.0.0.1:43124')).rejects.toMatchObject({ code: 3 })
      expect(closed).toBe(1)
      expect(calls.includes('Target.closeTarget')).toBe(failure !== 'Target.createTarget')
      expect(calls.filter(method => method === 'Browser.close')).toHaveLength(0)
    } finally { vi.unstubAllGlobals() }
  })
  it.each(['dsh-app://app/', 'dsh-app://foreign/', 'file:///owned/index.html'])('attaches only the actual Desktop main renderer: %s', async rendererUrl => {
    const calls: string[] = []
    class Socket extends EventTarget {
      constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))) }
      send(raw: string) {
        const request = JSON.parse(raw); calls.push(request.method)
        const result = request.method === 'Target.getTargets' ? { targetInfos: [{ targetId: 'owned-main', type: 'page', url: rendererUrl }] } : request.method === 'Target.attachToTarget' ? { sessionId: 'attached-main' } : {}
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: request.id, result }) })))
      }
      close() { this.dispatchEvent(new Event('close')) }
    }
    vi.stubGlobal('fetch', async () => Response.json({ webSocketDebuggerUrl: 'ws://127.0.0.1:43123/devtools/browser/fixture' }))
    vi.stubGlobal('WebSocket', Socket)
    try {
      const action = connectPage('http://127.0.0.1:43123', 'dsh-app://app/', { surface: 'desktop', desktopTargetId: 'owned-main' })
      if (rendererUrl === 'dsh-app://app/') { await (await action).close(); expect(calls).toContain('Target.detachFromTarget') }
      else await expect(action).rejects.toThrow('renderer identity mismatch')
      expect(calls).not.toContain('Target.createTarget')
      expect(calls).not.toContain('Target.closeTarget')
      expect(calls).not.toContain('Browser.close')
    } finally { vi.unstubAllGlobals() }
  })
  it('never considers two custom-protocol null origins equal', async () => {
    const page = pageFixture({ url: 'dsh-app://foreign/' })
    await expect(measureSwitches(page, { ...fixture, surface: 'desktop', frontendUrl: 'dsh-app://app/' }, { switches: 3 })).rejects.toThrow('frontend origin mismatch')
  })
})


describe('structural empty editor DOM controls', () => {
  it.each([
    ['empty div', '', '', 0, undefined, ''],
    ['official empty paragraph shape', '', '\n', 1, { nodeName: 'P', childNodes: [{}], firstChild: { nodeName: 'BR' } }, ''],
    ['real whitespace draft', ' ', ' ', 1, { nodeName: 'P', childNodes: [{}], firstChild: { nodeName: '#text' } }, ' '],
    ['real text draft', 'keep', 'keep', 1, { nodeName: 'P', childNodes: [{}], firstChild: { nodeName: '#text' } }, 'keep'],
  ])('%s preserves content and normalizes only the structural empty shape', (_name, textContent, innerText, count, firstChild, expected) => {
    const input = { textContent, innerText, childNodes: Array(Number(count)), firstChild, isContentEditable: true, getClientRects: () => [{}], getAttribute: () => undefined }
    vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible' }))
    const document = { location: { href: 'http://127.0.0.1:43123/' }, querySelectorAll: (selector: string) => selector === DOM.input ? [input] : [] }
    try { expect(readDom(document, DOM).draft).toBe(expected) } finally { vi.unstubAllGlobals() }
  })
})
