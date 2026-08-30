import { createHash } from 'node:crypto'
import { canonicalArgvFromCommand, type CanonicalCommandSurface } from './shell-parse.js'

export type GitAdapterAction = 'inspect_remote_updates' | 'pull' | 'fetch' | 'commit' | 'push'

export const GIT_COMMAND_MANIFEST_IDS: {
  readonly inspect_remote_updates: 'git.ls_remote_exact.v2'
  readonly pull: 'git.pull_ff_only_explicit.v2'
  readonly fetch: 'git.fetch_tracking_explicit.v2'
  readonly commit: 'git.commit_index_tree.v2'
  readonly push: 'git.push_explicit_refs.v2'
} = {
  inspect_remote_updates: 'git.ls_remote_exact.v2',
  pull: 'git.pull_ff_only_explicit.v2',
  fetch: 'git.fetch_tracking_explicit.v2',
  commit: 'git.commit_index_tree.v2',
  push: 'git.push_explicit_refs.v2',
}

export interface GitCommandManifest {
  manifestVersion: 2
  manifestId: (typeof GIT_COMMAND_MANIFEST_IDS)[GitAdapterAction]
  action: GitAdapterAction
  surface: CanonicalCommandSurface
  argv: string[]
  remote?: string
  sourceRef?: string
  destinationRef?: string
  trackingRef?: string
}

export interface GitCommandRejected {
  status: 'rejected'
  reasonCode:
    | 'shell_command_unsupported'
    | 'git_global_option_forbidden'
    | 'git_alias_or_subcommand_forbidden'
    | 'git_argv_shape_forbidden'
    | 'git_remote_forbidden'
    | 'git_ref_forbidden'
    | 'git_tracking_ref_forbidden'
}

export interface GitCommandAccepted {
  status: 'accepted'
  manifest: GitCommandManifest
}

export type GitCommandParseResult = GitCommandAccepted | GitCommandRejected

export interface GitTargetIdentity {
  repository: string
  remote?: string
  /** Canonical v3 target key; explicit identities remain separate in the command manifest. */
  refspec?: string
}

export interface GitPrestateEnvelope {
  envelopeVersion: 'git.prestate.v1'
  action: GitAdapterAction
  commandManifestId: string
  targetIdentityDigest: string
  stateTupleDigest: string
}

export interface GitPrestateCheck {
  valid: boolean
  reasonCode?: 'command_manifest_drift' | 'target_identity_drift' | 'prestate_drift'
}

export interface GitEffectRunner {
  (file: 'git', argv: string[], repository: string): Promise<void>
}

export interface GitEffectExecution {
  status: 'executed' | 'rejected'
  reasonCode?: GitPrestateCheck['reasonCode'] | 'repository_missing'
}

export interface LinearCommitReadback {
  /** Commit reached after the guarded effect. */
  postHeadOid: string
  /** The sole parent parsed from the post-commit object. */
  preHeadOid: string
}

const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
function rejected(reasonCode: GitCommandRejected['reasonCode']): GitCommandRejected {
  return { status: 'rejected', reasonCode }
}

function safeRef(ref: string, prefix: 'refs/heads/' | 'refs/remotes/'): boolean {
  if (!ref.startsWith(prefix) || ref.length <= prefix.length || ref.length > 512) return false
  if (['*', '?', '[', '\\', '~', '^', ':'].some((character) => ref.includes(character))) return false
  if ([...ref].some((character) => /\s/u.test(character) || character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) return false
  if (ref.includes('..') || ref.includes('@{') || ref.includes('//')) return false
  if (ref.endsWith('/') || ref.endsWith('.') || ref.endsWith('.lock')) return false
  return ref.split('/').every((part) => part.length > 0 && !part.startsWith('.'))
}

function safeHeadRef(ref: string): boolean {
  return safeRef(ref, 'refs/heads/')
}

function safeTrackingRef(ref: string, remote: string, sourceRef: string): boolean {
  if (!safeRef(ref, 'refs/remotes/')) return false
  return ref === `refs/remotes/${remote}/${sourceRef.slice('refs/heads/'.length)}`
}

function baseManifest(
  action: GitAdapterAction,
  surface: CanonicalCommandSurface,
  argv: string[],
): GitCommandManifest {
  return { manifestVersion: 2, manifestId: GIT_COMMAND_MANIFEST_IDS[action], action, surface, argv }
}

/**
 * Parse only the audited Git argv shapes. The shell words come from the
 * production shell parser; this module does not maintain an independent split
 * or quoting implementation. Global `git -C`/`git -c`, aliases, force/delete,
 * wildcard refspecs, and implicit HEAD/ref destinations fail closed because
 * none occur in an accepted exact shape.
 */
export function parseGitCommandManifest(command: string, surface: CanonicalCommandSurface): GitCommandParseResult {
  const canonical = canonicalArgvFromCommand(command, surface)
  if (canonical.status !== 'supported') return rejected('shell_command_unsupported')
  const argv = canonical.argv
  if (argv[0]?.toLowerCase() !== 'git') return rejected('git_alias_or_subcommand_forbidden')
  if (argv[1]?.startsWith('-')) return rejected('git_global_option_forbidden')
  const subcommand = argv[1]?.toLowerCase()

  if (subcommand === 'commit') {
    if (argv.length !== 4 || (argv[2] !== '-m' && argv[2] !== '--message') || argv[3].length === 0) {
      return rejected('git_argv_shape_forbidden')
    }
    return { status: 'accepted', manifest: baseManifest('commit', surface, argv) }
  }

  if (subcommand === 'ls-remote') {
    if (argv.length !== 6 || argv[2] !== '--exit-code' || argv[3] !== '--refs') {
      return rejected('git_argv_shape_forbidden')
    }
    const remote = argv[4]
    const sourceRef = argv[5]
    if (!REMOTE_NAME.test(remote)) return rejected('git_remote_forbidden')
    if (!safeHeadRef(sourceRef)) return rejected('git_ref_forbidden')
    return {
      status: 'accepted',
      manifest: { ...baseManifest('inspect_remote_updates', surface, argv), remote, sourceRef },
    }
  }

  if (subcommand === 'push') {
    if (argv.length !== 4) return rejected('git_argv_shape_forbidden')
    const remote = argv[2]
    if (!REMOTE_NAME.test(remote)) return rejected('git_remote_forbidden')
    const separator = argv[3].indexOf(':')
    if (separator <= 0 || separator !== argv[3].lastIndexOf(':')) return rejected('git_argv_shape_forbidden')
    const sourceRef = argv[3].slice(0, separator)
    const destinationRef = argv[3].slice(separator + 1)
    if (!safeHeadRef(sourceRef) || !safeHeadRef(destinationRef)) return rejected('git_ref_forbidden')
    return {
      status: 'accepted',
      manifest: { ...baseManifest('push', surface, argv), remote, sourceRef, destinationRef },
    }
  }

  if (subcommand === 'fetch') {
    if (argv.length !== 5 || argv[2] !== '--no-tags') return rejected('git_argv_shape_forbidden')
    const remote = argv[3]
    if (!REMOTE_NAME.test(remote)) return rejected('git_remote_forbidden')
    const separator = argv[4].indexOf(':')
    if (separator <= 0 || separator !== argv[4].lastIndexOf(':')) return rejected('git_argv_shape_forbidden')
    const sourceRef = argv[4].slice(0, separator)
    const trackingRef = argv[4].slice(separator + 1)
    if (!safeHeadRef(sourceRef)) return rejected('git_ref_forbidden')
    if (!safeTrackingRef(trackingRef, remote, sourceRef)) return rejected('git_tracking_ref_forbidden')
    return {
      status: 'accepted',
      manifest: { ...baseManifest('fetch', surface, argv), remote, sourceRef, trackingRef },
    }
  }

  if (subcommand === 'pull') {
    if (argv.length !== 6 || argv[2] !== '--ff-only' || argv[3] !== '--no-tags') {
      return rejected('git_argv_shape_forbidden')
    }
    const remote = argv[4]
    const sourceRef = argv[5]
    if (!REMOTE_NAME.test(remote)) return rejected('git_remote_forbidden')
    if (!safeHeadRef(sourceRef)) return rejected('git_ref_forbidden')
    return {
      status: 'accepted',
      manifest: { ...baseManifest('pull', surface, argv), remote, sourceRef },
    }
  }

  return rejected('git_alias_or_subcommand_forbidden')
}

/** Bind the command's explicit remote/ref identities to the canonical target. */
export function gitCommandMatchesTarget(manifest: GitCommandManifest, target: GitTargetIdentity): boolean {
  if (manifest.remote !== undefined && manifest.remote !== target.remote) return false
  const expectedRefspec = manifest.destinationRef !== undefined
    ? `${manifest.sourceRef}:${manifest.destinationRef}`
    : manifest.trackingRef !== undefined
      ? `${manifest.sourceRef}:${manifest.trackingRef}`
      : manifest.sourceRef
  if (expectedRefspec !== undefined && expectedRefspec !== target.refspec) return false
  return true
}

function hashTuple(fields: Readonly<Record<string, string | Uint8Array>>): string {
  const hash = createHash('sha256')
  for (const key of Object.keys(fields).sort()) {
    const keyBytes = Buffer.from(key, 'utf8')
    const raw = fields[key]
    const value = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : Buffer.from(raw)
    const lengths = Buffer.allocUnsafe(8)
    lengths.writeUInt32BE(keyBytes.length, 0)
    lengths.writeUInt32BE(value.length, 4)
    hash.update(lengths).update(keyBytes).update(value)
  }
  return hash.digest('hex')
}

function parseNulRecords(bytes: Uint8Array): string[] | undefined {
  if (bytes.byteLength === 0 || bytes[bytes.byteLength - 1] !== 0) return undefined
  return Buffer.from(bytes).toString('utf8').slice(0, -1).split('\0')
}

/**
 * Normalize the read-only `git ls-files --stage -z` surface. Only stage-zero
 * entries are certifiable; the digest binds mode, blob OID, and raw path bytes
 * without asking Git to create an object (in particular, never `write-tree`).
 */
export function commitIndexSnapshotDigest(indexEntries: Uint8Array): string | undefined {
  const records = parseNulRecords(indexEntries)
  if (!records?.length) return undefined
  const normalized: string[] = []
  for (const entry of records) {
    const match = /^(\d{6}) ([0-9a-f]{40}(?:[0-9a-f]{24})?) 0\t([\s\S]+)$/i.exec(entry)
    if (!match) return undefined
    normalized.push(`${match[1]} ${match[2].toLowerCase()}\t${match[3]}\0`)
  }
  return hashTuple({ entries: Buffer.from(normalized.join(''), 'utf8') })
}

/** Normalize the committed `git ls-tree -r -z <oid>` surface to the same tuple. */
export function commitTreeSnapshotDigest(treeEntries: Uint8Array): string | undefined {
  const records = parseNulRecords(treeEntries)
  if (!records?.length) return undefined
  const normalized: string[] = []
  for (const entry of records) {
    const match = /^(\d{6}) blob ([0-9a-f]{40}(?:[0-9a-f]{24})?)\t([\s\S]+)$/i.exec(entry)
    if (!match) return undefined
    normalized.push(`${match[1]} ${match[2].toLowerCase()}\t${match[3]}\0`)
  }
  return hashTuple({ entries: Buffer.from(normalized.join(''), 'utf8') })
}

/**
 * Parse the raw `git rev-list --parents -n 1 HEAD` surface and accept only a
 * linear commit whose sole parent is the exact resolved pre-effect HEAD.
 * Root commits, merge commits, a substituted first parent, malformed output,
 * and a no-op/self-parent tuple all fail closed.
 */
export function verifiedLinearCommitReadback(
  rawParents: Uint8Array,
  expectedPreHeadOid: string,
): LinearCommitReadback | undefined {
  const oidPattern = '[0-9a-f]{40}(?:[0-9a-f]{24})?'
  const match = new RegExp(`^(${oidPattern})((?: ${oidPattern})*)\\r?\\n$`, 'i')
    .exec(Buffer.from(rawParents).toString('utf8'))
  if (!match) return undefined
  const postHeadOid = match[1].toLowerCase()
  const parentOids = match[2] ? match[2].slice(1).split(' ').map((entry) => entry.toLowerCase()) : []
  const expected = expectedPreHeadOid.toLowerCase()
  if (!new RegExp(`^${oidPattern}$`, 'i').test(expectedPreHeadOid)
    || parentOids.length !== 1
    || parentOids[0] !== expected
    || parentOids[0].length !== postHeadOid.length
    || postHeadOid === expected) return undefined
  return { postHeadOid, preHeadOid: parentOids[0] }
}

export function createGitPrestateEnvelope(
  manifest: GitCommandManifest,
  target: GitTargetIdentity,
  stateTuple: Readonly<Record<string, string | Uint8Array>>,
): GitPrestateEnvelope {
  return {
    envelopeVersion: 'git.prestate.v1',
    action: manifest.action,
    commandManifestId: manifest.manifestId,
    targetIdentityDigest: hashTuple(Object.fromEntries(Object.entries(target).map(([key, value]) => [key, value ?? '']))),
    stateTupleDigest: hashTuple(stateTuple),
  }
}

/**
 * Mandatory resolution-to-effect gate. Call immediately before invoking Git;
 * any command, target, ref/OID, remote, branch, or raw index tuple drift makes
 * the previously resolved operation unusable.
 */
export function revalidateGitPrestate(
  resolved: GitPrestateEnvelope,
  manifest: GitCommandManifest,
  target: GitTargetIdentity,
  currentStateTuple: Readonly<Record<string, string | Uint8Array>>,
): GitPrestateCheck {
  if (resolved.action !== manifest.action || resolved.commandManifestId !== manifest.manifestId) {
    return { valid: false, reasonCode: 'command_manifest_drift' }
  }
  const currentTarget = hashTuple(Object.fromEntries(Object.entries(target).map(([key, value]) => [key, value ?? ''])))
  if (currentTarget !== resolved.targetIdentityDigest) return { valid: false, reasonCode: 'target_identity_drift' }
  if (hashTuple(currentStateTuple) !== resolved.stateTupleDigest) return { valid: false, reasonCode: 'prestate_drift' }
  return { valid: true }
}

/** Execute the exact resolved argv only after the mandatory live recheck. */
export async function executeRevalidatedGitEffect(
  resolved: GitPrestateEnvelope,
  manifest: GitCommandManifest,
  target: GitTargetIdentity,
  currentStateTuple: Readonly<Record<string, string | Uint8Array>>,
  runner: GitEffectRunner,
): Promise<GitEffectExecution> {
  if (!target.repository) return { status: 'rejected', reasonCode: 'repository_missing' }
  const checked = revalidateGitPrestate(resolved, manifest, target, currentStateTuple)
  if (!checked.valid) return { status: 'rejected', ...(checked.reasonCode ? { reasonCode: checked.reasonCode } : {}) }
  await runner('git', manifest.argv.slice(1), target.repository)
  return { status: 'executed' }
}
