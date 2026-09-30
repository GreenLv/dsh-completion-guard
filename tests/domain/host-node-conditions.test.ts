import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { resolveHostNodeConditions } from '../../src/domain/host-node-conditions.js'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function file(path: string, text: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
function oracle(profile: boolean, conditions: Record<string, string>, args: string[], options = '') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'host-conditions-'))); roots.push(root)
  file(join(root, 'package.json'), '{"type":"module"}')
  for (const module of ['host-node-conditions', 'host-physical-fs', 'host-audit-session', 'host-dependency-audit']) {
    file(join(root, module + '.js'), ts.transpileModule(readFileSync(join(process.cwd(), 'src/domain', module + '.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText)
  }
  const runtime = join(root, 'runtime'), owner = profile ? join(root, 'profile') : runtime
  for (const path of [runtime, owner]) file(join(path, 'package.json'), '{}')
  const dep = '@host/session', parent = '@host/loop', depRoot = join(owner, 'node_modules', dep), parentRoot = join(owner, 'node_modules', parent)
  file(join(depRoot, 'package.json'), JSON.stringify({ name: dep, exports: { '.': './lib/index.js' } }))
  file(join(depRoot, 'lib/index.js'), 'module.exports = { ok: true }')
  file(join(parentRoot, 'package.json'), JSON.stringify({ name: parent, dependencies: { [dep]: '1.0.0' } }))
  file(join(parentRoot, 'lib/index.js'), 'module.exports = {}')
  file(join(parentRoot, 'lib/package.json'), JSON.stringify({ name: dep, exports: { '.': conditions } }))
  symlinkSync(join(depRoot, 'lib/index.js'), join(parentRoot, 'lib/ok.js'), 'file')
  file(join(parentRoot, 'lib/wrong.js'), 'module.exports = { ok: false }')
  const definitions = [{ root: runtime, own: !profile }, ...(profile ? [{ root: owner, own: true }] : [])]
  const setup = definitions.map(({ root: home, own }) => ({ modules: join(home, 'node_modules'), records: { '.': { url: '..', dependencies: {} }, ...(own ? { [dep]: { url: './' + dep, dependencies: {} }, [parent]: { url: './' + parent, dependencies: { [dep]: dep } } } : {}) }, reachable: own ? ['.', dep, parent] : ['.'], packages: own ? [[dep, { root: depRoot, manifest: { name: dep, exports: { '.': './lib/index.js' } }, files: ['package.json', 'lib/index.js'] }], [parent, { root: parentRoot, manifest: { name: parent }, files: ['package.json', 'lib/index.js'] }]] : [] }))
  mkdirSync(join(runtime, 'node_modules'), { recursive: true })
  file(join(root, 'graphs.json'), JSON.stringify(setup))
  file(join(parentRoot, 'lib/oracle.mjs'), `import {createRequire} from 'node:module';import{auditHostDependencyRoutes}from ${JSON.stringify(pathToFileURL(join(root, 'host-dependency-audit.js')).href)};import{hostNodeConditions}from ${JSON.stringify(pathToFileURL(join(root, 'host-node-conditions.js')).href)};import{readFileSync}from'node:fs';const graphs=JSON.parse(readFileSync(${JSON.stringify(join(root, 'graphs.json'))})).map(g=>({...g,reachable:new Set(g.reachable),packages:new Map(g.packages)}));const required=createRequire(import.meta.url)(${JSON.stringify(dep)});const imported=await import(${JSON.stringify(dep)});console.log(JSON.stringify({audit:auditHostDependencyRoutes(graphs,${JSON.stringify(owner)}),require:required.ok,import:imported.default.ok,digest:hostNodeConditions().digest}));`)
  const env: Record<string, string> = { NODE_OPTIONS: options }
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot
  return JSON.parse(execFileSync(process.execPath, [...args, join(parentRoot, 'lib/oracle.mjs')], { encoding: 'utf8', env }))
}
describe('fresh actual Node startup condition oracle', () => {
  it.each([false, true])('preserves the default positive (profile=%s)', profile => {
    expect(oracle(profile, { 'node-addons': './ok.js', default: './wrong.js' }, [])).toMatchObject({ audit: true, require: true, import: true })
  })
  it.each([false, true].flatMap(profile => [
    { profile, label: 'no addons', conditions: { 'node-addons': './ok.js', default: './wrong.js' }, args: ['--no-addons'] },
    { profile, label: 'no addons underscore', conditions: { 'node-addons': './ok.js', default: './wrong.js' }, args: ['--no_addons'] },
    { profile, label: 'custom equals', conditions: { 'fixture-active-review': './wrong.js', default: './ok.js' }, args: ['--conditions=fixture-active-review'] },
    { profile, label: 'custom separate', conditions: { 'fixture-active-review': './wrong.js', default: './ok.js' }, args: ['-C', 'fixture-active-review'] },
    { profile, label: 'require module disabled', conditions: { 'module-sync': './ok.js', default: './wrong.js' }, args: ['--no-experimental-require-module'] },
  ]))('rejects actual divergence $label (profile=$profile)', ({ profile, conditions, args }) => {
    expect(oracle(profile, conditions, args)).toMatchObject({ audit: false, require: false, import: false })
  })
  it.each(['--conditions fixture-active-review', '--conditions=fixture-active-review', '-C fixture-active-review'])('reads NODE_OPTIONS %s', options => {
    expect(oracle(false, { 'fixture-active-review': './wrong.js', default: './ok.js' }, [], options)).toMatchObject({ audit: false, require: false, import: false })
  })
  it('changes the qualification binding and refuses unmodellable loading configuration', () => {
    expect(resolveHostNodeConditions([], '', true).digest).not.toBe(resolveHostNodeConditions(['--no-addons'], '', true).digest)
    for (const option of ['--preserve_symlinks', '--preserve_symlinks_main', '--experimental_loader=custom.mjs']) expect(() => resolveHostNodeConditions([], option, true)).toThrow('host_route_custom_loader_unsupported')
    expect(resolveHostNodeConditions(['--conditions=fixture_name'], '', true).require).toContain('fixture_name')
    expect(resolveHostNodeConditions(['--conditions=fixture_name'], '', true).require).not.toContain('fixture-name')
    expect(() => resolveHostNodeConditions([], '--import=custom.mjs', true)).toThrow('host_route_custom_loader_unsupported')
    expect(() => resolveHostNodeConditions([], '--conditions="unterminated', true)).toThrow('host_route_conditions_unparseable')
  })
})

it.each([false, true])('reads the actual NODE_OPTIONS no_addons alias (profile=%s)', profile => {
  expect(oracle(profile, { 'node-addons': './ok.js', default: './wrong.js' }, [], '--no_addons')).toMatchObject({ audit: false, require: false, import: false })
})
