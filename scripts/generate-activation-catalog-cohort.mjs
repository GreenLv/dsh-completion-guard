#!/usr/bin/env node
// Regenerate the activation-catalog cohort review manifest from the installed
// target-release package closure. Per package: hash the canonical loader shape
// of its real manifest, then walk literal Node import/require edges from the
// catalog entry and record reached module file SHA-256 values. Builtins are
// supplied by Node. The reviewed study binds registry tarball identities
// separately; this script derives the closure and per-file digests only.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { fileURLToPath, pathToFileURL } from 'node:url'

const outputPath = process.argv[2] ?? 'manifests/activation-catalog-cohort.v1.json'
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
// Anchor inside the REAL (symlink-resolved) installed persistence backend so
// the pnpm store resolves every transitive package at its locked instance.
const backend = realpathSync(createRequire(join(repoRoot, 'package.json')).resolve('@deepseek-ai/dsh-session-persistence-jsonl'))
if (process.env.NODE_OPTIONS || process.execArgv.length) throw new Error('custom Node options are not qualified')

const ENTRY_PACKAGE = '@deepseek-ai/dsh-session-format-catalog'

const packages = new Map() // name -> { name, loaderShapeSha256, root }
const modules = new Map() // key -> { key, package, path, sha256, edges: Map(specifier -> targetKey) }

function manifestShape(manifest) {
  const shape = {}
  for (const key of ['name', 'type', 'main', 'exports', 'imports']) if (Object.hasOwn(manifest, key)) shape[key] = manifest[key]
  return shape
}

function registerPackage(name, resolvedFile) {
  // The public package.json subpath can be intentionally unexported. Locate
  // the nearest package scope of Node's actual resolved module instead.
  let root = dirname(resolvedFile), manifest
  for (;;) {
    try { manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); break }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    const parent = dirname(root)
    if (parent === root) throw new Error(`manifest missing for ${name}`)
    root = parent
  }
  if (manifest.name !== name) throw new Error(`manifest name mismatch for ${name}`)
  const previous = packages.get(name)
  if (previous && previous.root !== root) throw new Error(`multiple instances of ${name}`)
  if (previous) return root
  packages.set(name, { name, loaderShapeSha256: createHash('sha256').update(JSON.stringify(manifestShape(manifest))).digest('hex'), root })
  return root
}

function moduleKey(name, path) { return `${name}::${path}` }

function within(root, file) {
  const rel = relative(root, file)
  return !!rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}

// Resolve from the actual importer with Node's import conditions, not CommonJS
// resolution or a shared backend anchor. parentURL is an experimental API.
function resolveFromFile(specifier, fromFile, lane) {
  if (lane === 'require') return realpathSync(createRequire(fromFile).resolve(specifier))
  const code = "import {pathToFileURL} from 'node:url';console.log(import.meta.resolve(process.argv[1],pathToFileURL(process.argv[2])))"
  const url = new URL(execFileSync(process.execPath, ['--experimental-import-meta-resolve', '--input-type=module', '-e', code, specifier, fromFile], { encoding: 'utf8' }).trim())
  if (url.protocol !== 'file:' || url.search || url.hash) throw new Error(`unsupported module URL: ${specifier}`)
  return realpathSync(fileURLToPath(url))
}

function importsFromSource(source, file) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  if (ast.parseDiagnostics.length) throw new Error(`invalid JavaScript: ${file}`)
  const dynamic = [], imports = [], exports = [], requires = []
  function visit(node) {
    let value, bucket, lane = 'import'
    if (ts.isIdentifier(node) && node.text === 'require' && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) throw new Error(`unsupported require reference: ${file}`)
    if (ts.isImportDeclaration(node) && node.moduleSpecifier) { value = node.moduleSpecifier; bucket = imports }
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) { value = node.moduleSpecifier; bucket = exports }
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) { value = node.arguments[0]; bucket = dynamic }
    else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      value = node.arguments[0]; bucket = requires; lane = 'require'
    }
    else if (ts.isCallExpression(node) && ((ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'require')
      || (ts.isElementAccessExpression(node.expression) && node.expression.argumentExpression?.text === 'require'))) {
      throw new Error(`unsupported require call: ${file}`)
    }
    if (bucket) {
      if (!value || !ts.isStringLiteral(value)) throw new Error(`non-literal import or require: ${file}`)
      bucket.push({ specifier: value.text, lane })
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  const seen = new Set()
  return [...dynamic, ...imports, ...exports, ...requires].filter(({ specifier, lane }) => {
    const key = `${lane}:${specifier}`
    if (seen.has(key)) return false
    seen.add(key); return true
  })
}

function walkModule(packageName, path) {
  const key = moduleKey(packageName, path)
  if (modules.has(key)) return
  const root = packages.get(packageName).root
  const file = resolve(root, path)
  if (!within(root, file) || realpathSync(file) !== file) throw new Error(`escape or symlink: ${key}`)
  const bytes = readFileSync(file)
  modules.set(key, { key, package: packageName, path, sha256: createHash('sha256').update(bytes).digest('hex'), edges: new Map() })
  const source = bytes.toString('utf8')
  const packageNameForRelative = packageName
  const specifiers = importsFromSource(source, file)
  for (const { specifier, lane } of specifiers) {
    if (builtinModules.includes(specifier) || specifier.startsWith('node:')) continue
    if (specifier.startsWith('#') || specifier.startsWith('/') || specifier.includes(':')) throw new Error(`unsupported import: ${specifier}`)
    const isRelative = specifier.startsWith('.')
    const packageName = isRelative ? packageNameForRelative : specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
    const resolved = resolveFromFile(specifier, file, lane)
    const targetPackage = isRelative ? packageNameForRelative : packageName
    if (!isRelative && targetPackage === packageNameForRelative) throw new Error(`unsupported package self-import: ${key}`)
    const targetRoot = isRelative ? root : registerPackage(targetPackage, resolved)
    if (!within(targetRoot, resolved)) throw new Error(`edge escapes package: ${key} -> ${specifier}`)
    const rel = relative(targetRoot, resolved)
    if (rel.split(sep).includes('node_modules')) throw new Error(`nested module edge: ${key} -> ${specifier}`)
    if (isRelative && realpathSync(resolve(dirname(file), specifier)) !== resolved) throw new Error(`unsupported relative resolution: ${key} -> ${specifier}`)
    const targetPath = rel.split(sep).join('/')
    const targetKey = moduleKey(targetPackage, targetPath)
    const oldTarget = modules.get(key).edges.get(specifier)
    if (oldTarget && oldTarget !== targetKey) throw new Error(`different lanes for ${key} -> ${specifier}`)
    modules.get(key).edges.set(specifier, targetKey)
    walkModule(targetPackage, targetPath)
  }
}

const entryFile = resolveFromFile(ENTRY_PACKAGE, backend, 'import')
const entryRoot = registerPackage(ENTRY_PACKAGE, entryFile)
if (entryFile !== join(entryRoot, 'lib/index.js')) throw new Error('unexpected catalog entry')
walkModule(ENTRY_PACKAGE, 'lib/index.js')

const out = {
  schema: 'dsh-activation-catalog-qualification/v1',
  entry: moduleKey(ENTRY_PACKAGE, 'lib/index.js'),
  packages: [...packages.values()].map(({ name, loaderShapeSha256 }) => ({ name, loaderShapeSha256 })).sort((a, b) => a.name < b.name ? -1 : 1),
  modules: [...modules.values()].map(({ key, package: pkg, path, sha256, edges }) => ({
    key, package: pkg, path, sha256,
    edges: [...edges.entries()].map(([specifier, target]) => ({ specifier, target })),
  })).sort((a, b) => a.key < b.key ? -1 : 1),
}
writeFileSync(outputPath, JSON.stringify(out, null, 2) + '\n')
console.log('written', outputPath, 'packages:', out.packages.length, 'modules:', out.modules.length)
