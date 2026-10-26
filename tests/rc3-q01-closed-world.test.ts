import { describe, expect, it } from 'vitest'

// RC3-Q01: the closed-world inventory must run whenever operator-acquired
// trust drives the audit, at EVERY entry — not only evaluateActiveHostLock.
// The reviewer's probe: with a genuine qualification receipt, adding an
// unregistered file to an audited package root must fail the audit when the
// qualified flag is passed (the missing-parameter shape returned true).
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { acquireHostTrust, type HostRebindTrust } from '../src/domain/host-trust.js'
import { auditedHostImplementation } from '../src/domain/host-resolver.js'
import { createHostAuditSession, type HostAuditSession } from '../src/domain/host-audit-session.js'

interface ProbeArchive { name: string; files: Record<string, Buffer> }

function fixtureTar(files: Record<string, Buffer>): Buffer {
  const blocks: Buffer[] = []
  for (const [file, content] of Object.entries(files)) {
    const name = 'package/' + file
    const header = Buffer.alloc(512)
    header.write(name.slice(0, 99), 0, 100, 'utf8')
    header.write('0000644\0', 100, 8, 'ascii')
    header.write('0000000\0', 108, 8, 'ascii')
    header.write('0000000\0', 116, 8, 'ascii')
    header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
    header.write('        ', 148, 8, 'ascii')
    header.write('0', 156, 1, 'ascii')
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
    const padding = Buffer.alloc((512 - (content.length % 512)) % 512)
    blocks.push(header, content, padding)
  }
  blocks.push(Buffer.alloc(1024))
  const { gzipSync } = require('node:zlib') as typeof import('node:zlib')
  return gzipSync(Buffer.concat(blocks))
}

function sdkArchives(targets: string[]): ProbeArchive[] {
  const archives: ProbeArchive[] = [], seen = new Set<string>()
  const collect = (name: string, anchor: string) => {
    if (seen.has(name)) return
    const resolver = createRequire(anchor)
    let entry: string
    try { entry = resolver.resolve(name) } catch {
      try { entry = createRequire(join(process.cwd(), 'tests/fixtures/host-composition/package.json')).resolve(name) } catch { return }
    }
    let root = dirname(entry)
    while (!existsSync(join(root, 'package.json'))) root = dirname(root)
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    if (manifest.name !== name) throw new Error('fixture package scope mismatch')
    seen.add(name)
    const files: Record<string, Buffer> = {}
    const walk = (dir: string, prefix: string) => {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        if (item.name === 'node_modules') continue
        const file = prefix + item.name
        if (item.isDirectory()) walk(join(dir, item.name), file + '/')
        else if (/\.(?:[cm]?js|json)$/.test(file)) files[file] = readFileSync(join(dir, item.name))
      }
    }
    walk(root, '')
    archives.push({ name, files })
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) collect(dependency, join(root, 'package.json'))
  }
  for (const target of targets) collect(target, join(process.cwd(), 'package.json'))
  return archives
}

async function acquireToolsFixture(archives: ProbeArchive[], root: string) {
  const entries = archives.map(a => { const m = JSON.parse(a.files['package.json'].toString()), bytes = fixtureTar(a.files); return { name: a.name, version: m.version as string, bytes, integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') } })
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input), m = entries.find(r => url === 'https://registry.npmjs.org/' + encodeURIComponent(r.name) + '/' + encodeURIComponent(r.version))
    if (m) return new Response(JSON.stringify({ name: m.name, version: m.version, dist: { integrity: m.integrity, tarball: 'https://registry.npmjs.org/fixture/' + encodeURIComponent(m.name) + '.tgz' } }))
    const a = entries.find(r => url === 'https://registry.npmjs.org/fixture/' + encodeURIComponent(r.name) + '.tgz')
    return a ? new Response(new Uint8Array(a.bytes)) : new Response('', { status: 404 })
  }) as typeof fetch
  return acquireHostTrust([entries.find(r => r.name === '@deepseek-ai/dsh-tools')!], fetcher, { profileRoot: root, dependencyIdentity: name => entries.find(r => r.name === name)! })
}

import { existsSync } from 'node:fs'

describe('RC3-Q01: qualified closed-world inventory at every entry', () => {
  it('refuses an unregistered installed file when qualified trust drives the audit', async () => {
    const archives = sdkArchives(['@deepseek-ai/dsh-tools'])
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'rc3q01-')))
    try {
      const trust: HostRebindTrust = await acquireToolsFixture(archives, root)
      // Install the qualified files exactly, then probe with one extra file.
      for (const a of archives) for (const [file, bytes] of Object.entries(a.files)) {
        const path = join(root, 'node_modules', a.name, file)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, bytes)
      }
      // Install the route-audit map the same way toolsEntryOracle does: the
      // runtime half's importer declares every audited name.
      const names = new Set(archives.map(a => a.name))
      const records: Record<string, unknown> = { '.': { url: '..', dependencies: Object.fromEntries([...names].map(name => [name, name])) } }
      for (const a of archives) {
        const m = JSON.parse(a.files['package.json'].toString())
        records[a.name] = { url: `./${a.name}`, dependencies: Object.fromEntries(Object.keys({ ...m.dependencies, ...m.peerDependencies, ...m.optionalDependencies }).filter(n => names.has(n)).map(n => [n, n])) }
      }
      writeFileSync(join(root, 'package.json'), '{}')
      writeFileSync(join(root, 'node_modules', '.package-map.json'), JSON.stringify({ packages: records }))
      const expectations = [...trust.packages, ...(trust.probeDependencies ?? [])]
      const toolsRoot = join(root, 'node_modules', '@deepseek-ai/dsh-tools')
      const audit = (qualified: boolean, overrides: Partial<HostAuditSession> = {}) => {
        const session = createHostAuditSession()
        return auditedHostImplementation(root, root, { ...session, ...overrides }, expectations, undefined, undefined, qualified)
      }
      // PERF-DEFAULT-INVENTORY-01: explicit version-selected expectations do
      // not make the registry/default lane a qualified closed-world scan.
      let directoryReads = 0
      const noEnumeration = () => { directoryReads++; throw new Error('default lane must not enumerate') }
      expect(audit(false, { listDir: noEnumeration })).toBe(true)
      expect(directoryReads).toBe(0)
      const session = createHostAuditSession()
      expect(audit(true, { listDir: path => { directoryReads++; return session.listDir!(path) } })).toBe(true)
      expect(directoryReads).toBeGreaterThan(0)
      writeFileSync(join(toolsRoot, 'unregistered.js'), 'export const smuggled = true\n')
      directoryReads = 0
      expect(audit(false, { listDir: noEnumeration })).toBe(true)
      expect(directoryReads).toBe(0)
      expect(audit(true)).toBe(false)
      rmSync(join(toolsRoot, 'unregistered.js'))
      expect(audit(true)).toBe(true)

      const declared = Object.keys(expectations.find(row => row.name === '@deepseek-ai/dsh-tools')!.modules!).find(file => file.endsWith('.js'))!
      expect(declared).toBeTruthy()
      const declaredPath = join(toolsRoot, declared), originalBytes = readFileSync(declaredPath)
      for (const qualified of [false, true]) {
        writeFileSync(declaredPath, Buffer.concat([originalBytes, Buffer.from('\n// drift\n')]))
        expect(audit(qualified)).toBe(false)
        writeFileSync(declaredPath, originalBytes)
        expect(audit(qualified)).toBe(true)
        const physical = createHostAuditSession()
        let escapes = 0, nonfiles = 0
        expect(audit(qualified, { realpath: path => {
          if (path === declaredPath) { escapes++; return join(root, 'outside.js') }
          return physical.realpath(path)
        } })).toBe(false)
        expect(escapes).toBeGreaterThan(0)
        expect(audit(qualified, { stat: path => {
          const stat = physical.stat(path)
          if (path === declaredPath) { nonfiles++; return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { isFile: () => false }) }
          return stat
        } })).toBe(false)
        expect(nonfiles).toBeGreaterThan(0)
        // Real Node self-reference scope redirects the importer's bare route,
        // without changing any authenticated package bytes or graph records.
        writeFileSync(join(root, 'shadow.js'), originalBytes)
        writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', exports: { '.': './shadow.js' } }))
        expect(audit(qualified)).toBe(false)
        writeFileSync(join(root, 'package.json'), '{}')
        expect(audit(qualified)).toBe(true)
      }
      for (const invalid of ['special', 'depth', 'budget'] as const) {
        let visited = 0
        const inner = createHostAuditSession()
        expect(audit(true, { listDir: path => {
          if (path === toolsRoot || path.startsWith(toolsRoot + sep)) {
            visited++
            if (invalid === 'special') return [{ name: 'unsupported', isFile: false, isDirectory: false }]
            if (invalid === 'depth') return [{ name: 'deep', isFile: false, isDirectory: true }]
            return Array.from({ length: 10001 }, (_, i) => ({ name: `${i}.js`, isFile: true, isDirectory: false }))
          }
          return inner.listDir!(path)
        } })).toBe(false)
        expect(visited).toBe(invalid === 'depth' ? 33 : 1)
        expect(audit(true)).toBe(true)
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
