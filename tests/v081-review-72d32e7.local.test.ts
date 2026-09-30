import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION, Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { createRuntime, apply, handleGuardTurnStopping, revalidateCoreLock } from '../src/runtime.js'
import { readActiveHostGraph } from '../src/domain/host-resolver.js'
import { createHostAuditSession, type HostAuditSession } from '../src/domain/host-audit-session.js'
import { DEFAULT_HOST_LOCK, evaluateHostLock, EXPECTED_HOST_PACKAGES, type HostLockEvaluation } from '../src/domain/host-lock.js'

// This family isolates the host-lock validation BOUNDARY: how many full
// validations one attach, one resume, one plain sync, and two adjacent
// security-sensitive entries perform, and that a host mutated between two
// consecutive authorized entries is refused by the second one. Published-byte
// integrity against the real rc.2 tarballs stays with v080-rc017-host.test.ts;
// here the byte-audit manifest is narrowed to one synthetic audited module per
// package so the byte-hash, export, route and symlink checks run for real.
const { AUDITED_MODULE_TEXT, canonicalManifest } = vi.hoisted(() => ({
  AUDITED_MODULE_TEXT: 'export const auditedModule = true\n',
  canonicalManifest: (name: string, version: string) => JSON.stringify({
    name, version, exports: { '.': { types: './index.d.ts', default: './lib/index.js' }, ...(name === '@deepseek-ai/dsh' ? { './lib/*': './lib/*' } : {}) },
  }),
}))
vi.mock('../manifests/rc020-rc2-byte-audit.json', async (original) => {
  const { createHash } = await import('node:crypto')
  const auditedModuleDigest = createHash('sha256').update(AUDITED_MODULE_TEXT).digest('hex')
  const source = await original<{ default: { packages: Array<Record<string, unknown>> } }>()
  return { default: { ...source.default, packages: source.default.packages.map((p) => ({
    ...p, sha256: '0'.repeat(64), tarball: '',
    // The published audit hashes package.json too: the manifest the JSON
    // parsers read and the bytes the digest check reads are the same file.
    modules: {
      'package.json': createHash('sha256').update(canonicalManifest(p.name as string, p.version as string)).digest('hex'),
      'lib/index.js': auditedModuleDigest,
    },
  })) } }
})

const temporaryRoots: string[] = []
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * A synthetic but fully exercised rc.2-shaped host: the complete audited
 * cohort reachable from the runtime importer, junction symlinks for the native
 * bare route, real hashed module bytes, and a profile half with its own
 * importer. Returns the rows the graph produces so callers pin the expected
 * lock digest.
 */
function makeHost() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'v081-entry-validation-')))
  temporaryRoots.push(root)
  const runtimeRoot = join(root, 'runtime')
  const profileRoot = join(root, 'profile')
  const modulesRoot = join(runtimeRoot, 'node_modules')
  mkdirSync(modulesRoot, { recursive: true })
  const packages: Record<string, { url: string; dependencies: Record<string, string> }> = {
    '.': { url: '..', dependencies: {} },
  }
  for (const [index, row] of EXPECTED_HOST_PACKAGES.entries()) {
    const id = `${row.name}@${row.version}`
    const relative = `./active/package-${index}`
    packages['.'].dependencies[row.name] = id
    packages[id] = { url: relative, dependencies: {} }
    const packageRoot = join(modulesRoot, relative)
    mkdirSync(packageRoot, { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), canonicalManifest(row.name, row.version!))
    mkdirSync(join(packageRoot, 'lib'), { recursive: true })
    writeFileSync(join(packageRoot, 'lib', 'index.js'), AUDITED_MODULE_TEXT)
  }
  mkdirSync(join(modulesRoot, '@deepseek-ai'), { recursive: true })
  for (const row of EXPECTED_HOST_PACKAGES) {
    symlinkSync(join(modulesRoot, packages[`${row.name}@${row.version}`].url), join(modulesRoot, row.name), 'junction')
  }
  writeFileSync(join(runtimeRoot, 'package.json'), '{}')
  const lockYaml = [
    "lockfileVersion: '9.0'", '', 'packages:',
    ...EXPECTED_HOST_PACKAGES.flatMap((row) => [
      `  '${row.name}@${row.version}':`,
      `    resolution: {integrity: ${row.integrity}}`,
      '',
    ]),
    'snapshots:', '',
  ].join('\n')
  writeFileSync(join(runtimeRoot, 'pnpm-lock.yaml'), lockYaml)
  writeFileSync(join(modulesRoot, '.package-map.json'), JSON.stringify({ packages }))
  // The profile half carries its own importer with a mapped, byte-identical
  // critical copy, so the audits walk both graphs and the profile's native
  // route check is exercised exactly like a real plugin profile.
  const profileModules = join(profileRoot, 'node_modules')
  const sessionIndex = EXPECTED_HOST_PACKAGES.findIndex((row) => row.name === '@deepseek-ai/dsh-session')
  const sessionRow = EXPECTED_HOST_PACKAGES[sessionIndex]
  const sessionCopy = join(profileModules, '.pnpm', 'session', 'node_modules', '@deepseek-ai', 'dsh-session')
  mkdirSync(sessionCopy, { recursive: true })
  cpSync(join(modulesRoot, `./active/package-${sessionIndex}`), sessionCopy, { recursive: true })
  // The native search route for the plugin importer must reach the mapped
  // copy: the bare junction is the legitimate profile route.
  mkdirSync(join(profileModules, '@deepseek-ai'), { recursive: true })
  symlinkSync(sessionCopy, join(profileModules, '@deepseek-ai', 'dsh-session'), 'junction')
  mkdirSync(join(profileModules, 'plugin'), { recursive: true })
  writeFileSync(join(profileModules, 'plugin', 'package.json'), JSON.stringify({
    name: 'plugin', version: '1.0.0',
    dependencies: { '@deepseek-ai/dsh-session': sessionRow.version },
  }))
  writeFileSync(join(profileRoot, 'package.json'), '{}')
  writeFileSync(join(profileRoot, 'pnpm-lock.yaml'), [
    "lockfileVersion: '9.0'", '', 'packages:',
    `  '${sessionRow.name}@${sessionRow.version}':`,
    `    resolution: {integrity: ${sessionRow.integrity}}`,
    '', 'snapshots:', '',
  ].join('\n'))
  writeFileSync(join(profileModules, '.package-map.json'), JSON.stringify({ packages: {
    '.': { url: '..', dependencies: { plugin: 'plugin' } },
    plugin: { url: './plugin', dependencies: { '@deepseek-ai/dsh-session': `${sessionRow.name}@${sessionRow.version}` } },
    [`${sessionRow.name}@${sessionRow.version}`]: { url: './.pnpm/session/node_modules/@deepseek-ai/dsh-session', dependencies: {} },
  } }))
  const rows = readActiveHostGraph(runtimeRoot, profileRoot)
  const config = {
    activation: 'always' as const,
    hostLockPolicy: 'dsh-core/v1',
    hostLockRuntimeRoot: runtimeRoot,
    hostLockProfileRoot: profileRoot,
    hostLockPlatform: 'posix' as const,
    hostLockProfile: 'headless' as const,
  }
  return { root, runtimeRoot, profileRoot, packages, rows, config }
}

/** The expected lock for the fixture: same rows, same digest composition. */
function expectedLockFor(host: ReturnType<typeof makeHost>): HostLockEvaluation {
  return evaluateHostLock(host.rows, { platform: 'posix', profileKind: 'headless' })
}



describe('independent full audit for both Node loading lanes',()=>{
 it.each(['nested-import','require-default'])('refuses %s at revalidateCoreLock',kind=>{
  const host=makeHost(),dep='@deepseek-ai/dsh-session',row=EXPECTED_HOST_PACKAGES.find(p=>p.name===dep)!,id=`${row.name}@${row.version}`
  const consumer=join(host.runtimeRoot,'node_modules','consumer'),lib=join(consumer,'lib')
  mkdirSync(lib,{recursive:true});writeFileSync(join(consumer,'package.json'),JSON.stringify({name:'consumer',version:'1.0.0',type:'module',main:'./lib/index.js',dependencies:{[dep]:row.version}}))
  writeFileSync(join(lib,'index.js'),'export const consumer=true');writeFileSync(join(lib,'wrong.js'),'export const wrong=true')
  host.packages['.'].dependencies.consumer='consumer';host.packages.consumer={url:'./consumer',dependencies:{[dep]:id}}
  writeFileSync(join(host.runtimeRoot,'node_modules','.package-map.json'),JSON.stringify({packages:host.packages}))
  host.rows=readActiveHostGraph(host.runtimeRoot,host.profileRoot);const expected=expectedLockFor(host)
  expect(revalidateCoreLock(host.config,expected).status).toBe('supported')
  const wanted=realpathSync(join(host.runtimeRoot,'node_modules',dep,'lib/index.js'));symlinkSync(wanted,join(lib,'ok.js'),'file')
  const dot=kind==='nested-import'?{node:{import:'./wrong.js'},default:'./ok.js'}:{require:'./ok.js',default:'./wrong.js'}
  writeFileSync(join(lib,'package.json'),JSON.stringify({name:dep,exports:{'.':dot}}))
  writeFileSync(join(lib,'oracle.mjs'),`console.log(JSON.stringify({resolved:import.meta.resolve('${dep}'),loadedWrong:(await import('${dep}')).wrong===true,loadedOk:(await import('${dep}')).ok===true}))`)
  const code="import {createRequire} from 'node:module';console.log(JSON.stringify({resolved:createRequire(process.argv[1]).resolve(process.argv[2])}))"
  const cjs=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',code,join(lib,'index.js'),dep],{encoding:'utf8'}))
  const esm=JSON.parse(execFileSync(process.execPath,[join(lib,'oracle.mjs')],{encoding:'utf8'}))
  expect(cjs.resolved).toBe(wanted);expect(new URL(esm.resolved).pathname).toContain('/wrong.js');expect(esm.loadedWrong).toBe(true)
  expect(readActiveHostGraph(host.runtimeRoot,host.profileRoot)).toEqual(host.rows)
  const verdict=revalidateCoreLock(host.config,expected)
  console.log(JSON.stringify({case:kind,level:'revalidateCoreLock',node:process.version,cjsTarget:'authenticated',esmTarget:'wrong',status:verdict.status}))
  expect(verdict.status).not.toBe('supported')
 })
})
