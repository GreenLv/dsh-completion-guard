import { createHash } from 'node:crypto'
import Module, { createRequire } from 'node:module'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
  it('rejects a symlink and accepts only stable reviewed hardlinked bytes', () => {
    const f = fixture(), file = f.paths[0]!, contents = readFileSync(file), alias = join(f.root, 'alias.js')
    unlinkSync(file); writeFileSync(alias, contents); symlinkSync(alias, file)
    expect(() => assertActivationCatalogQualification(f.backend, f.review)).toThrow('activation_catalog_unreviewed')
    unlinkSync(file); linkSync(alias, file)
    const before = assertActivationCatalogQualification(f.backend, f.review)
    expect(before.moduleCount).toBe(19)
    writeFileSync(alias, Buffer.from('mutated through alias'))
    expect(() => assertActivationCatalogQualification(f.backend, f.review)).toThrow('activation_catalog_unreviewed')
    writeFileSync(alias, contents); utimesSync(alias, 1, 1)
    const after = assertActivationCatalogQualification(f.backend, f.review)
    expect(after.qualificationSha256).not.toBe(before.qualificationSha256)
  })
  it('binds link identity of reviewed manifest and module across qualification checks', () => {
    const f = fixture(), baseline = assertActivationCatalogQualification(f.backend, f.review)
    const moduleAlias = join(f.root, 'module-alias.js'), manifestAlias = join(f.root, 'manifest-alias.json')
    const manifest = join(f.root, 'node_modules', f.names[0]!, 'package.json')
    linkSync(f.paths[0]!, moduleAlias); linkSync(manifest, manifestAlias)
    const linked = assertActivationCatalogQualification(f.backend, f.review)
    expect(linked.qualificationSha256).not.toBe(baseline.qualificationSha256)
    expect(assertActivationCatalogQualification(f.backend, f.review).qualificationSha256).toBe(linked.qualificationSha256)
    const original = readFileSync(manifestAlias); writeFileSync(manifestAlias, Buffer.from('{"name":"tampered"}'))
    expect(() => assertActivationCatalogQualification(f.backend, f.review)).toThrow('activation_catalog_unreviewed')
    writeFileSync(manifestAlias, original); utimesSync(manifestAlias, 1, 1)
    expect(assertActivationCatalogQualification(f.backend, f.review).qualificationSha256).not.toBe(linked.qualificationSha256)
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

it('accepts unscoped packages whose package.json is not exported and rejects incomplete nearer shadows', () => {
  const f = fixture(), old = f.names[1]!, replacement = 'rrule'
  const oldRoot = join(f.root, 'node_modules', old), newRoot = join(f.root, 'node_modules', replacement)
  renameSync(oldRoot, newRoot)
  const manifestPath = join(newRoot, 'package.json'), manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.name = replacement; delete manifest.exports['./package.json']; writeFileSync(manifestPath, JSON.stringify(manifest))
  const shape = { name: replacement, type: manifest.type, main: manifest.main, exports: manifest.exports }
  const pkg = f.review.packages.find(p => p.name === old)!; pkg.name = replacement; pkg.loaderShapeSha256 = hash(JSON.stringify(shape))
  const mod = f.review.modules.find(m => m.package === old)!; mod.package = replacement; mod.key = `${replacement}::${mod.path}`
  const edge = f.review.modules[0]!.edges[0]!; edge.specifier = replacement; edge.target = mod.key
  expect(assertActivationCatalogQualification(f.backend, f.review).moduleCount).toBe(19)
  const moduleFile = join(newRoot, 'lib/index.js'), original = readFileSync(moduleFile)
  writeFileSync(moduleFile, Buffer.concat([original, Buffer.from('// altered')]))
  expect(() => assertActivationCatalogQualification(f.backend, f.review)).toThrow('activation_catalog_unreviewed')
  writeFileSync(moduleFile, original)
  const shadow = join(f.root, 'node_modules', f.names[0]!, 'node_modules', replacement)
  mkdirSync(shadow, { recursive: true })
  expect(() => assertActivationCatalogQualification(f.backend, f.review)).toThrow('activation_catalog_unreviewed')
})

it('qualifies the exact real expanded catalog closure', () => {
  const req = createRequire(import.meta.url)
  const backend = realpathSync(req.resolve('@deepseek-ai/dsh-session-persistence-jsonl'))
  const shipped = JSON.parse(readFileSync(new URL('../manifests/activation-catalog-cohort.v1.json', import.meta.url), 'utf8')) as { cohorts?: Array<ActivationCatalogReview & { backendVersion: string }> }
  // The shipped manifest carries per-backend-version rows; the qualification
  // runs against the row of the actually installed backend version.
  const backendVersion = JSON.parse(readFileSync(join(dirname(dirname(backend)), 'package.json'), 'utf8')).version as string
  const review = (shipped.cohorts?.find(row => row.backendVersion === backendVersion) ?? shipped) as ActivationCatalogReview
  const result = assertActivationCatalogQualification(backend, review)
  expect(result.packageCount).toBe(23); expect(result.moduleCount).toBe(24)
})


it.each(['..', '@a/..', '.hidden', '/absolute', '@a/.'])('refuses invalid package path %s', name => {
  const f = fixture()
  f.review.packages[1]!.name = name
  expect(() => assertActivationCatalogQualification(f.backend, f.review)).toThrow('activation_catalog_unreviewed')
})
