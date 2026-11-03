import { createHash } from 'node:crypto'
import Module, { createRequire } from 'node:module'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertActivationCatalogQualification, type ActivationCatalogReview } from '../src/domain/activation-catalog-qualification.js'

const owned: string[] = []
afterEach(() => { vi.unstubAllEnvs(); for (const root of owned.splice(0)) rmSync(root, { recursive: true, force: true }) })
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'activation-catalog-'))); owned.push(root)
  const backend = join(root, 'backend.js'); writeFileSync(backend, '')
  const names = ['@deepseek-ai/dsh-session-format-catalog', ...Array.from({ length: 18 }, (_, i) => `@test/package-${i}`)]
  const shape = (name: string) => ({ name, type: 'module', main: 'lib/index.js', exports: { '.': { types: './lib/index.d.ts', default: './lib/index.js' }, './package.json': './package.json' } })
  const paths: string[] = []
  for (let i = 0; i < names.length; i++) {
    const dir = join(root, 'node_modules', names[i]!); mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ ...shape(names[i]!), version: '0.2.1-rc.5' }))
    const file = join(dir, 'lib/index.js'); writeFileSync(file, `export const fixture${i} = ${i}\n`); paths.push(file)
  }
  const review: ActivationCatalogReview = { schema: 'dsh-activation-catalog-qualification/v1', entry: `${names[0]}::lib/index.js`,
    packages: names.map(name => ({ name, loaderShapeSha256: hash(JSON.stringify(shape(name))) })),
    modules: names.map((name, i) => ({ key: `${name}::lib/index.js`, package: name, path: 'lib/index.js', sha256: hash(`export const fixture${i} = ${i}\n`),
      edges: i + 1 < names.length ? [{ specifier: names[i + 1]!, target: `${names[i + 1]}::lib/index.js` }] : [] })) }
  return { root, backend, names, paths, review }
}

describe('activation catalog executable qualification', () => {
  it('accepts an inert NODE_PATH while resolving the reviewed local graph', () => {
    const f = fixture()
    vi.stubEnv('NODE_PATH', '/nonexistent/inert/module/search/path')
    expect(assertActivationCatalogQualification(f.backend, f.review).moduleCount).toBe(19)
  })
  it('rejects a CommonJS NODE_PATH fallback that ESM would not load', () => {
    const f = fixture(), globalRoot = join(f.root, 'global-modules')
    const missing = f.names.at(-1)!, local = join(f.root, 'node_modules', missing)
    const alternate = join(globalRoot, missing); mkdirSync(join(globalRoot, '@test'), { recursive: true }); renameSync(local, alternate)
    const saved = process.env.NODE_PATH
    const initPaths = () => (Module as unknown as { _initPaths(): void })._initPaths()
    try {
      process.env.NODE_PATH = globalRoot; initPaths()
      expect(createRequire(f.paths.at(-2)!).resolve(`${missing}/package.json`)).toBe(join(alternate, 'package.json'))
      expect(() => assertActivationCatalogQualification(f.backend, f.review)).toThrow('activation_catalog_unreviewed')
    } finally {
      if (saved === undefined) delete process.env.NODE_PATH; else process.env.NODE_PATH = saved
      initPaths()
    }
  })
  it('accepts every exact reviewed module and records harmless version relabels', () => {
    const f = fixture(), before = assertActivationCatalogQualification(f.backend, f.review)
    expect(before.moduleCount).toBe(19); expect(before.packageCount).toBe(19)
    const manifest = join(f.root, 'node_modules', f.names[0]!, 'package.json')
    const value = JSON.parse(readFileSync(manifest, 'utf8')); value.version = '0.2.1-rc.99'; writeFileSync(manifest, JSON.stringify(value))
    const after = assertActivationCatalogQualification(f.backend, f.review)
    expect(after.moduleCount).toBe(19); expect(after.qualificationSha256).not.toBe(before.qualificationSha256)
  })
  it('refuses modification of every executable node, not just the catalog entry', () => {
    const f = fixture()
    for (const file of f.paths) {
      const original = readFileSync(file); writeFileSync(file, Buffer.concat([original, Buffer.from('// altered\n')]))
      expect(() => assertActivationCatalogQualification(f.backend, f.review)).toThrow('activation_catalog_unreviewed')
      writeFileSync(file, original)
    }
    expect(assertActivationCatalogQualification(f.backend, f.review).moduleCount).toBe(19)
  })
  it('rejects a symlink or hardlink at any executable leaf', () => {
    const f = fixture(), file = f.paths[0]!, contents = readFileSync(file), alias = join(f.root, 'alias.js')
    unlinkSync(file); writeFileSync(alias, contents); symlinkSync(alias, file)
    expect(() => assertActivationCatalogQualification(f.backend, f.review)).toThrow('activation_catalog_unreviewed')
    unlinkSync(file); linkSync(alias, file)
    expect(() => assertActivationCatalogQualification(f.backend, f.review)).toThrow('activation_catalog_unreviewed')
  })
  it('refuses loader-shape drift, shadowed dependency code and unreviewed startup hooks', () => {
    const f = fixture(), manifest = join(f.root, 'node_modules', f.names[0]!, 'package.json')
    const original = readFileSync(manifest, 'utf8'), changed = JSON.parse(original)
    changed.exports['.'].import = './evil.js'; writeFileSync(manifest, JSON.stringify(changed))
    expect(() => assertActivationCatalogQualification(f.backend, f.review)).toThrow('activation_catalog_unreviewed')
    writeFileSync(manifest, original)
    const reordered = JSON.parse(original); reordered.exports['.'] = { default: './lib/index.js', types: './lib/index.d.ts' }
    writeFileSync(manifest, JSON.stringify(reordered))
    expect(() => assertActivationCatalogQualification(f.backend, f.review)).toThrow('activation_catalog_unreviewed')
    writeFileSync(manifest, original)
    const shadow = join(f.root, 'node_modules', f.names[0]!, 'node_modules', f.names[1]!); mkdirSync(join(shadow, 'lib'), { recursive: true })
    const source = join(f.root, 'node_modules', f.names[1]!); writeFileSync(join(shadow, 'package.json'), readFileSync(join(source, 'package.json')))
    writeFileSync(join(shadow, 'lib/index.js'), 'export const tampered = true\n')
    expect(() => assertActivationCatalogQualification(f.backend, f.review)).toThrow('activation_catalog_unreviewed')
    rmSync(join(f.root, 'node_modules', f.names[0]!, 'node_modules'), { recursive: true })
    vi.stubEnv('NODE_OPTIONS', '--conditions=types')
    expect(() => assertActivationCatalogQualification(f.backend, f.review)).toThrow('activation_catalog_unreviewed')
  })
})
