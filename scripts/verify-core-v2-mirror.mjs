#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { execFileSync } from 'node:child_process'

const repositoryRoot = resolve(import.meta.dirname, '..')
const fixtureRoot = 'tests/fixtures/conformance/core_v2'
const args = process.argv.slice(2)
const expectedSources = new Set([
  'assets/core-intent-v2.json', 'assets/core-observation-v2.schema.json',
  'docs/CORE_V2_WIRE.md', 'docs/CORE_V2_HOST_CAPABILITIES.md',
  'scripts/cg_core_v2.py', 'scripts/cg_core_v2_schema.py',
  'tests/fixtures/conformance/core_v2/independent-oracle.json',
  'tests/fixtures/conformance/core_v2/events.json',
  'tests/fixtures/conformance/core_v2/observation.schema.json',
  'docs/CORE_ALIGNMENT_CONTRACT_V2.md',
])
const expectedMirrors = new Set([
  'tests/fixtures/conformance/core_v2/core-intent-v2.json', 'src/core-v2/intent.json',
  'tests/fixtures/conformance/core_v2/core-observation-v2.schema.json',
  'tests/fixtures/conformance/core_v2/observation.schema.json', 'src/core-v2/observation.schema.json',
  'tests/fixtures/conformance/core_v2/independent-oracle.json',
  'tests/fixtures/conformance/core_v2/events.json',
])
const expectedSourceMirrors = new Map([
  ['assets/core-intent-v2.json', ['tests/fixtures/conformance/core_v2/core-intent-v2.json', 'src/core-v2/intent.json']],
  ['assets/core-observation-v2.schema.json', ['tests/fixtures/conformance/core_v2/core-observation-v2.schema.json',
    'tests/fixtures/conformance/core_v2/observation.schema.json', 'src/core-v2/observation.schema.json']],
  ['docs/CORE_V2_WIRE.md', []], ['docs/CORE_V2_HOST_CAPABILITIES.md', []],
  ['scripts/cg_core_v2.py', []], ['scripts/cg_core_v2_schema.py', []],
  ['tests/fixtures/conformance/core_v2/independent-oracle.json', ['tests/fixtures/conformance/core_v2/independent-oracle.json']],
  ['tests/fixtures/conformance/core_v2/events.json', ['tests/fixtures/conformance/core_v2/events.json']],
  ['tests/fixtures/conformance/core_v2/observation.schema.json', ['tests/fixtures/conformance/core_v2/observation.schema.json']],
  ['docs/CORE_ALIGNMENT_CONTRACT_V2.md', []],
])

function valueFor(flag) {
  const index = args.indexOf(flag)
  if (index === -1) return null
  if (index + 1 >= args.length || args[index + 1].startsWith('--')) throw new Error(`missing value for ${flag}`)
  return args[index + 1]
}

function relativePath(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`invalid relative path: ${String(path)}`)
  }
  return path
}

function bytesAt(root, path) {
  const parts = relativePath(path).split('/')
  const full = resolve(root, ...parts)
  if (!full.startsWith(`${root}${sep}`)) throw new Error(`path escapes repository: ${path}`)
  let partPath = root
  for (const part of parts) {
    partPath = resolve(partPath, part)
    if (lstatSync(partPath).isSymbolicLink()) throw new Error(`symlink in mirror path: ${path}`)
  }
  if (!lstatSync(full).isFile()) throw new Error(`nonregular mirror path: ${path}`)
  return readFileSync(full)
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function checkHash(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`invalid SHA-256 for ${label}`)
}

const manifestPath = valueFor('--manifest') ?? `${fixtureRoot}/UPSTREAM_PIN.json`
const upstreamRepo = valueFor('--upstream-repo')
const requireCommit = args.includes('--require-commit')
const manifest = JSON.parse(bytesAt(repositoryRoot, manifestPath).toString('utf8'))
if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('empty core/v2 mirror manifest')
if (manifest.status !== 'commit-bound-source-mirror' || !/^[0-9a-f]{40}$/.test(manifest.canonical_commit ?? '')) {
  throw new Error('core/v2 mirror requires a real full upstream commit')
}
if (manifest.pinVersion !== '2' || manifest.upstream?.canonical_commit !== manifest.canonical_commit ||
    manifest.legacy_v1_pin_path !== 'tests/fixtures/conformance/UPSTREAM_PIN.json') {
  throw new Error('core/v2 pin identity fields disagree')
}
if (requireCommit) {
  if (!upstreamRepo) throw new Error('--upstream-repo is required with --require-commit')
}

const seenSource = new Set()
const seenMirror = new Map()
let mirrorCount = 0
for (const entry of manifest.files) {
  const sourcePath = relativePath(entry.source_path)
  if (seenSource.has(sourcePath)) throw new Error(`duplicate upstream source: ${sourcePath}`)
  seenSource.add(sourcePath)
  checkHash(entry.sha256, sourcePath)
  if (entry.role !== 'mirrored' && entry.role !== 'reference_identity') throw new Error(`invalid role: ${sourcePath}`)
  if (!Array.isArray(entry.mirrors) || (entry.role === 'mirrored' && entry.mirrors.length === 0) ||
      (entry.role === 'reference_identity' && entry.mirrors.length !== 0)) throw new Error(`invalid mirrors: ${sourcePath}`)
  const expectedForSource = expectedSourceMirrors.get(sourcePath)
  if (!expectedForSource || entry.role !== (expectedForSource.length ? 'mirrored' : 'reference_identity') ||
      entry.mirrors.length !== expectedForSource.length ||
      entry.mirrors.some((mirror, index) => mirror.path !== expectedForSource[index])) {
    throw new Error(`source-to-mirror mapping differs from contract: ${sourcePath}`)
  }
  for (const mirror of entry.mirrors) {
    const path = relativePath(mirror.path)
    if (seenMirror.has(path) && seenMirror.get(path) !== entry.sha256) throw new Error(`conflicting mirror: ${path}`)
    seenMirror.set(path, entry.sha256)
    checkHash(mirror.sha256, path)
    if (mirror.sha256 !== entry.sha256) throw new Error(`mirror declaration differs from source: ${path}`)
    if (digest(bytesAt(repositoryRoot, path)) !== entry.sha256) throw new Error(`local mirror byte mismatch: ${path}`)
    mirrorCount += 1
  }
  if (upstreamRepo) {
    const upstreamRoot = resolve(upstreamRepo)
    const bytes = execFileSync('git', ['show', `${manifest.canonical_commit}:${sourcePath}`], {
      cwd: upstreamRoot, maxBuffer: 16 * 1024 * 1024,
    })
    if (digest(bytes) !== entry.sha256) throw new Error(`upstream byte mismatch: ${sourcePath}`)
  }
}

if (seenSource.size !== expectedSources.size || [...seenSource].some((path) => !expectedSources.has(path)) ||
    seenMirror.size !== expectedMirrors.size || [...seenMirror.keys()].some((path) => !expectedMirrors.has(path))) {
  throw new Error('core/v2 source or mirror inventory differs from the shared contract')
}

process.stdout.write(JSON.stringify({ status: manifest.status, canonical_commit: manifest.canonical_commit ?? null,
  sources: seenSource.size, mirrors: mirrorCount, upstream_checked: Boolean(upstreamRepo) }) + '\n')
