/**
 * Offline qualification of the exact catalog executable closure used as the
 * multi-generation strict-validation oracle. The shipped review manifest is
 * derived from registry-integrity-checked rc.3/rc.5 archives and actual ESM
 * resolution edges. This does not qualify the surrounding SDK or native code.
 */
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { activationDigest, activationJson } from './session-activation.js'

interface ReviewedPackage { name: string; loaderShapeSha256: string }
interface ReviewedEdge { specifier: string; target: string }
interface ReviewedModule { key: string; package: string; path: string; sha256: string; edges: ReviewedEdge[] }
export interface ActivationCatalogReview {
  schema: 'dsh-activation-catalog-qualification/v1'
  entry: string
  packages: ReviewedPackage[]
  modules: ReviewedModule[]
}
export interface ActivationCatalogQualification {
  catalogFile: string
  qualificationSha256: string
  moduleCount: number
  packageCount: number
}
const HASH = /^[0-9a-f]{64}$/u
function fail(): never { throw new Error('activation_catalog_unreviewed') }
type CatalogFileIdentity = { dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string; mode: string; nlink: string }
function checkedFile(path: string): { path: string; bytes: Buffer; identity: CatalogFileIdentity } {
  const lexical = lstatSync(path, { bigint: true })
  if (lexical.isSymbolicLink()) fail()
  const physical = realpathSync(path), before = lstatSync(physical, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.ino === 0n || before.nlink < 1n) fail()
  const fd = openSync(physical, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW))
  try {
    const opened = fstatSync(fd, { bigint: true })
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
      || opened.mtimeNs !== before.mtimeNs || opened.ctimeNs !== before.ctimeNs || opened.mode !== before.mode || opened.nlink !== before.nlink) fail()
    const bytes = readFileSync(fd), final = fstatSync(fd, { bigint: true }), after = lstatSync(physical, { bigint: true })
    for (const stat of [final, after]) {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== before.dev || stat.ino !== before.ino
        || stat.size !== before.size || stat.mtimeNs !== before.mtimeNs || stat.ctimeNs !== before.ctimeNs
        || stat.mode !== before.mode || stat.nlink !== before.nlink) fail()
    }
    if (realpathSync(path) !== physical) fail()
    return { path: physical, bytes, identity: { dev: String(before.dev), ino: String(before.ino), size: String(before.size),
      mtimeNs: String(before.mtimeNs), ctimeNs: String(before.ctimeNs), mode: String(before.mode), nlink: String(before.nlink) } }
  } finally { closeSync(fd) }
}
function within(root: string, path: string): boolean {
  const offset = relative(root, path)
  return !!offset && !isAbsolute(offset) && offset !== '..' && !offset.startsWith(`..${sep}`)
}
function relativeModule(path: string): boolean {
  return !!path && !isAbsolute(path) && !path.includes('\\') && path.split('/').every(part => part && part !== '.' && part !== '..')
}
/** Call before importing either the JSONL backend or this catalog on multi-gen
 * inventories. NODE_OPTIONS/custom loaders or conditions are not qualified; NODE_PATH cannot supply an ESM dependency. */
export function assertActivationCatalogQualification(backendFile: string, review: ActivationCatalogReview): ActivationCatalogQualification {
  try {
    if (process.env.NODE_OPTIONS || process.execArgv.some(arg => /^(?:--conditions(?:=|$)|--experimental-loader(?:=|$)|--loader(?:=|$)|--import(?:=|$)|--require(?:=|$)|-r|--preserve-symlinks(?:-main)?(?:=|$))/u.test(arg))) fail()
    if (!review || review.schema !== 'dsh-activation-catalog-qualification/v1' || !Array.isArray(review.packages)
      || !Array.isArray(review.modules) || review.packages.length === 0 || review.modules.length === 0) fail()
    const packages = new Map<string, ReviewedPackage>(), modules = new Map<string, ReviewedModule>()
    for (const p of review.packages) {
      if (!p || typeof p.name !== 'string' || !/^@[^/]+\/[^/]+$/u.test(p.name) || !HASH.test(p.loaderShapeSha256)
        || packages.has(p.name)) fail()
      packages.set(p.name, p)
    }
    for (const m of review.modules) {
      if (!m || !packages.has(m.package) || !relativeModule(m.path) || m.key !== `${m.package}::${m.path}`
        || !HASH.test(m.sha256) || !Array.isArray(m.edges) || modules.has(m.key)) fail()
      modules.set(m.key, m)
    }
    const entry = modules.get(review.entry)
    if (!entry || entry.package !== '@deepseek-ai/dsh-session-format-catalog') fail()
    const roots = new Map<string, string>(), manifestDigests = new Map<string, { sha256: string; identity: CatalogFileIdentity }>()
    const packageRoot = (importer: string, name: string): string => {
      const reviewed = packages.get(name)
      if (!reviewed) fail()
      const manifestPath = createRequire(importer).resolve(`${name}/package.json`)
      // createRequire also searches NODE_PATH/global locations, while an ESM
      // import does not. Bind the result to the first package manifest in the
      // importer's ordinary node_modules ancestry, never a global fallback.
      let ancestor = dirname(realpathSync(importer)), localManifest: string | undefined
      for (;;) {
        if (basename(ancestor) !== 'node_modules') {
          const candidate = join(ancestor, 'node_modules', name, 'package.json')
          try { lstatSync(candidate); localManifest = candidate; break }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        }
        const parent = dirname(ancestor)
        if (parent === ancestor) break
        ancestor = parent
      }
      if (!localManifest || realpathSync(localManifest) !== realpathSync(manifestPath)) fail()
      const file = checkedFile(localManifest), root = dirname(file.path)
      const value = activationJson(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes)) as Record<string, unknown>
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.name !== name || typeof value.version !== 'string') fail()
      const shape: Record<string, unknown> = {}
      for (const key of ['name', 'type', 'main', 'exports', 'imports']) if (Object.hasOwn(value, key)) shape[key] = value[key]
      if (createHash('sha256').update(JSON.stringify(shape)).digest('hex') !== reviewed.loaderShapeSha256) fail()
      const previous = roots.get(name)
      if (previous && previous !== root) fail()
      const proof = { sha256: createHash('sha256').update(file.bytes).digest('hex'), identity: file.identity }
      const priorProof = manifestDigests.get(name)
      if (priorProof && activationDigest(priorProof) !== activationDigest(proof)) fail()
      roots.set(name, root); manifestDigests.set(name, proof)
      return root
    }
    const paths = new Map<string, { path: string; identity: CatalogFileIdentity }>(), pending: Array<{ node: ReviewedModule; root: string }> = []
    const root = packageRoot(realpathSync(backendFile), entry.package)
    pending.push({ node: entry, root })
    while (pending.length) {
      const { node, root: currentRoot } = pending.pop()!
      const requested = resolve(currentRoot, node.path), file = checkedFile(requested)
      if (!within(currentRoot, file.path) || requested !== file.path || createHash('sha256').update(file.bytes).digest('hex') !== node.sha256) fail()
      const previous = paths.get(node.key)
      if (previous) { if (previous.path !== file.path || activationDigest(previous.identity) !== activationDigest(file.identity)) fail(); continue }
      paths.set(node.key, { path: file.path, identity: file.identity })
      for (const edge of node.edges) {
        if (!edge || typeof edge.specifier !== 'string' || typeof edge.target !== 'string') fail()
        const target = modules.get(edge.target)
        if (!target) fail()
        if (edge.specifier.startsWith('.')) {
          const destination = realpathSync(resolve(dirname(file.path), edge.specifier))
          if (target.package !== node.package || destination !== resolve(currentRoot, target.path)) fail()
          pending.push({ node: target, root: currentRoot })
        } else {
          if (edge.specifier !== target.package && !edge.specifier.startsWith(`${target.package}/`)) fail()
          pending.push({ node: target, root: packageRoot(file.path, target.package) })
        }
      }
    }
    if (paths.size !== modules.size || roots.size !== packages.size) fail()
    const qualificationSha256 = activationDigest({ schema: review.schema,
      modules: [...paths].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, file]) => ({ key, path: file.path, identity: file.identity, sha256: modules.get(key)!.sha256 })),
      manifests: [...manifestDigests].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, proof]) => ({ name, root: roots.get(name), ...proof })),
      node: process.versions.node,
    })
    return { catalogFile: paths.get(review.entry)!.path, qualificationSha256, moduleCount: paths.size, packageCount: roots.size }
  } catch { return fail() }
}
