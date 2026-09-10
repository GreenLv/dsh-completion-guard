import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Artifact-entry contract.
 *
 * Every other test in this repository imports `src/`. The published package
 * instead exposes `dist/index.js` and `dist/domain/index.js`, and nothing
 * loaded those bytes before this file: a broken bundle (a mis-declared
 * external, a dropped export, a bundler that tree-shook the plugin face) would
 * only have surfaced at the native acceptance gate, on a frozen artifact, after
 * the source had already been declared good.
 *
 * These cases run against the build output, so they must run after
 * `pnpm run build`. The candidate matrix builds before testing; when `dist/` is
 * absent the import fails loudly rather than passing on a cached module.
 */

const distIndex = new URL('../dist/index.js', import.meta.url)
const distDomain = new URL('../dist/domain/index.js', import.meta.url)
const packageJson = new URL('../package.json', import.meta.url)
const root = fileURLToPath(new URL('..', import.meta.url))

interface PackageManifest {
  version: string
  main: string
  types: string
  files: string[]
  exports: Record<string, { types: string; default: string }>
}

const manifest = JSON.parse(readFileSync(packageJson, 'utf8')) as PackageManifest

describe('shipped artifact entries', () => {
  it('loads the plugin entry with the loader contract intact', async () => {
    const plugin = await import(distIndex.href) as Record<string, unknown>
    expect(typeof plugin.apply).toBe('function')
    expect(plugin.name).toBe('context-guard')
    expect(plugin.inject).toContain('sessions')
    expect(plugin.inject).toContain('commands')
    // The loader rejects a default export; the bundle must not add one.
    expect('default' in plugin).toBe(false)
  })

  it('loads the domain entry and exposes the active host policy and cohort', async () => {
    const domain = await import(distDomain.href) as Record<string, unknown>
    expect('default' in domain).toBe(false)
    const rows = domain.RC015_HOST_PACKAGES as Array<{ name: string; version?: string; integrity?: string }>
    expect(rows).toHaveLength(33)
    expect(rows.every((row) => row.version && row.integrity?.startsWith('sha512-'))).toBe(true)
    expect(domain.ACTIVE_HOST_COHORT_ID).toBe('dsh-0.1.5-rc.1')
    expect(domain.MIN_SUPPORTED_HOST_VERSION).toBe('0.1.5-rc.1')
    expect(domain.SUPPORTED_HOST_RANGE).toBe('>=0.1.5-rc.1')
  })

  it('evaluates the active cohort from the shipped bytes, provenance included', async () => {
    const domain = await import(distDomain.href) as {
      RC015_HOST_PACKAGES: Array<{ name: string; version?: string; integrity?: string }>
      evaluateHostLock: (rows: unknown[], context: unknown) => { status: string; cohortId?: string; auditProvenance?: string }
      selectHostCohort: (rows: unknown[], platform?: string) => { consistent: boolean }
    }
    const evaluation = domain.evaluateHostLock(domain.RC015_HOST_PACKAGES, { platform: 'posix', profileKind: 'web' })
    expect(evaluation).toMatchObject({
      status: 'supported',
      cohortId: 'dsh-0.1.5-rc.1-core-v1',
      auditProvenance: 'registry-derived-pending-native-audit',
    })
    // Drift fails closed in the shipped path too, not only in source.
    const drifted = domain.RC015_HOST_PACKAGES.map((row) =>
      row.name === '@deepseek-ai/dsh-session' ? { ...row, integrity: 'sha512-drift' } : row)
    expect(domain.evaluateHostLock(drifted, { platform: 'posix', profileKind: 'web' }).status).toBe('unsupported')
    expect(domain.selectHostCohort(domain.RC015_HOST_PACKAGES, 'posix')).toMatchObject({ consistent: true })
  })

  it('runs the shipped apply() against a minimal host context without throwing', async () => {
    const plugin = await import(distIndex.href) as { apply: (ctx: unknown, config?: unknown) => void }
    const registered: string[] = []
    const listeners: string[] = []
    const ctx = {
      commands: { register: (definition: { name: string }) => { registered.push(definition.name); return () => {} } },
      on: (name: string) => { listeners.push(name); return () => {} },
      get: () => undefined,
      sessions: { flush: async () => true },
    }
    // A bare context is enough: registration must not reach for a live agent, a
    // live session, or an installed Goal service.
    expect(() => plugin.apply(ctx)).not.toThrow()
    expect(registered).toContain('context-guard')
    expect(listeners).toContain('agent/session-start')
    expect(listeners).toContain('agent/pre-step')
    expect(listeners).toContain('agent/turn-stopping')
  })

  it('advertises only entry points that exist in the built tree', () => {
    expect(manifest.version).toBe('0.5.1')
    expect(manifest.main).toBe('dist/index.js')
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      for (const field of ['types', 'default'] as const) {
        const relative = target[field].replace(/^\.\//, '')
        expect(existsSync(new URL(`../${relative}`, import.meta.url)), `${subpath}.${field} -> ${relative}`).toBe(true)
      }
    }
  })

  it('keeps the emitted declarations self-contained inside dist', () => {
    // The declared types are a thin re-export map over a content-hashed sibling
    // chunk (`./index-<hash>.js`). If that chunk were ever omitted from the
    // published `dist`, the entry files would still exist and every consumer's
    // typecheck would break. Resolve each relative reference from the
    // DECLARING file's directory — a `.js` specifier legitimately resolves to
    // the sibling `.d.ts`.
    const checked = new Set<string>()
    const queue = Object.values(manifest.exports).map((target) => target.types)
    while (queue.length > 0) {
      const entryPath = queue.pop()!.replace(/^\.\//, '')
      if (checked.has(entryPath)) continue
      checked.add(entryPath)
      const absolute = fileURLToPath(new URL(`../${entryPath}`, import.meta.url))
      expect(existsSync(absolute), `${entryPath} must exist`).toBe(true)
      const source = readFileSync(absolute, 'utf8')
      for (const reference of new Set([...source.matchAll(/from ["'](\.[^"']+)["']/g)].map((match) => match[1]))) {
        const target = resolve(dirname(absolute), reference)
        const resolved = [target, target.replace(/\.js$/, '.d.ts'), target.replace(/\.js$/, '.ts')]
          .find((candidate) => existsSync(candidate))
        expect(resolved, `${entryPath} references ${reference}, which does not resolve`).toBeDefined()
        expect(resolved!.startsWith(fileURLToPath(new URL('../dist/', import.meta.url)))).toBe(true)
        if (resolved!.endsWith('.d.ts')) queue.push(relative(root, resolved!))
      }
    }
    // Both advertised entries were reached, and the walk descended into the
    // content-hashed sibling chunk rather than stopping at the entry files.
    expect([...checked]).toEqual(expect.arrayContaining(['dist/domain/index.d.ts', 'dist/index.d.ts']))
    const chunks = [...checked].filter((file) => /\/index-[A-Za-z0-9_-]+\.d\.ts$/.test(file))
    expect(chunks.length, `expected a hashed declaration chunk, saw ${[...checked].join(', ')}`).toBeGreaterThan(0)
    for (const chunk of chunks) {
      // A chunk left out of the published `dist` would break every consumer,
      // so it must be a real file inside the packaged directory.
      expect(existsSync(fileURLToPath(new URL(`../${chunk}`, import.meta.url)))).toBe(true)
    }
  })

  it('keeps maintainer artefacts out of the packaged inventory', () => {
    // The audit and the handback are repository documents. They exist on disk
    // and are referenced from packaged docs as maintainer documents, so the
    // packaged file list must not silently grow to include them.
    for (const name of ['UPSTREAM_API_AUDIT.md', 'IMPLEMENTATION_RESULT.md']) {
      expect(existsSync(new URL(`../${name}`, import.meta.url)), `${name} should exist on disk`).toBe(true)
      expect(manifest.files, `${name} must not be packaged`).not.toContain(name)
    }
  })
})
