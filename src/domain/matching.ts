import { canonicalizePath } from './canonicalize.js'
import type { GuardEvidence, GuardItem, GuardProjection } from './types.js'

const STATE_VERIFICATION_CAPABILITIES = new Set([
  'filesystem-read',
  'web-fetch',
  'deterministic-check',
])

/** Capabilities that may close an explicit `verify` contract. */
const VERIFY_CAPABILITIES = new Set([
  'filesystem-read',
  'verify',
  'web-fetch',
  'deterministic-check',
])

/**
 * Whether this evidence closes the artifact/scope facet of the item: a success
 * outcome, a verifying capability, and (when the contract names them) a match
 * on the canonical subject and the surface. Both sides of the subject
 * comparison run through the shared {@link canonicalizePath}, so Windows
 * drive-letter case, separator kind, `.`/`..`, and duplicate separators are
 * treated as equal while POSIX stays case-sensitive.
 */
function stateVerificationFacetCovered(item: GuardItem, evidence: GuardEvidence): boolean {
  if (evidence.outcome !== 'success') return false
  if (!evidence.capabilities.some((capability) => STATE_VERIFICATION_CAPABILITIES.has(capability))) return false
  const { subject, surface, operation } = item.verification
  if (subject && !evidence.subjects.some((subjectValue) => canonicalizePath(subjectValue) === canonicalizePath(subject))) return false
  if (surface && !evidence.surfaces.includes(surface)) return false
  if (operation === 'create' || operation === 'write' || operation === 'modify') {
    const stateOperations = evidence.operations ?? []
    if (!stateOperations.some((entry) => (entry.op === 'read' || entry.op === 'verify') &&
      (!subject || (entry.path !== undefined && canonicalizePath(entry.path) === canonicalizePath(subject)))) &&
      !(evidence.capabilities.includes('deterministic-check') && (!subject || evidence.subjects.some((value) => canonicalizePath(value) === canonicalizePath(subject))))) return false
  }
  return true
}

function artifactFacetCovered(item: GuardItem, evidence: GuardEvidence): boolean {
  return stateVerificationFacetCovered(item, evidence)
}

function methodIdentityMatches(item: GuardItem, evidence: GuardEvidence): boolean {
  const method = item.verification.method
  if (!method || evidence.outcome !== 'success') return false
  const toolMethod = DSH_TOOL_METHODS.has(method)
  const toolMatch = toolMethod
    ? (method === 'bash' || method === 'shell')
      ? evidence.toolName === 'bash' || evidence.toolName === 'shell'
      : evidence.toolName === method
    : false
  const executableMatch = !toolMethod && (evidence.executables?.some((value) => value.toLowerCase() === method) ?? false)
  return toolMatch || executableMatch
}

export function isVerifyingCapability(evidence: GuardEvidence): boolean {
  return evidence.capabilities.some((capability) => STATE_VERIFICATION_CAPABILITIES.has(capability))
}

/**
 * Combined verification facet: success, capability, subject, surface and any
 * required method identity must all come from this one evidence.
 */
function verifyFacetCovered(item: GuardItem, evidence: GuardEvidence): boolean {
  if (evidence.outcome !== 'success') return false
  if (!evidence.capabilities.some((capability) => VERIFY_CAPABILITIES.has(capability))) return false
  const { subject, surface, method } = item.verification
  if (subject && !evidence.subjects.some((subjectValue) => canonicalizePath(subjectValue) === canonicalizePath(subject))) return false
  if (surface && !evidence.surfaces.includes(surface)) return false
  return !method || methodIdentityMatches(item, evidence)
}

/**
 * DSH tool ids that can appear as `evidence.toolName`. An explicit method that
 * names one of these is a tool constraint; anything else (pnpm, git, node, …) is
 * a shell executable that runs inside a command tool.
 */
const DSH_TOOL_METHODS = new Set([
  'bash', 'shell', 'pwsh', 'read', 'write', 'edit',
  'read_file', 'write_file', 'edit_file',
  'web_search', 'web_fetch', 'web_fetch_url',
])

/**
 * Operation compatibility: a contract operation is closed by the evidence
 * operations that produce the same effect (create/write are the same artifact
 * production family; verify is closed by a read, run, or verify check).
 */
const OPERATION_COMPATIBLE: Record<string, string[]> = {
  create: ['create', 'write'],
  write: ['create', 'write'],
  modify: ['modify', 'write', 'create'],
  read: ['read'],
  run: ['run'],
  verify: ['read', 'verify', 'run'],
}

/**
 * Whether this evidence satisfies an explicitly required tool/method facet:
 * a success outcome, the right identity (DSH tool name for tool constraints,
 * the invoked executable for executable constraints), and — when the contract
 * names a subject and/or operation — an operation performed on the same
 * canonical subject. Mentioning a file in a command (`echo guard-demo.txt`) is
 * not an operation and cannot satisfy a create requirement.
 */
/** The effect facet proves what the evidence actually did, not merely who ran it. */
function effectFacetCovered(item: GuardItem, evidence: GuardEvidence): boolean {
  if (evidence.outcome !== 'success') return false
  const { subject, surface, operation, method } = item.verification
  if (!operation) return false
  if (method && !methodIdentityMatches(item, evidence)) return false
  const compatible = OPERATION_COMPATIBLE[operation] ?? []
  const effects = evidence.operations ?? []
  if (surface === 'artifact' && subject) {
    const target = canonicalizePath(subject)
    return effects.some((entry) => compatible.includes(entry.op) && entry.path !== undefined && canonicalizePath(entry.path) === target)
  }
  if (surface === 'scope') return effects.some((entry) => compatible.includes(entry.op))
  return false
}

/** The method facet proves only the required tool or executable identity. */
function methodFacetCovered(item: GuardItem, evidence: GuardEvidence): boolean {
  if (item.verification.operation === undefined && item.verification.method) return false
  return methodIdentityMatches(item, evidence)
}

/** Whether this evidence performed the run operation on the contract subject. */
function runFacetCovered(item: GuardItem, evidence: GuardEvidence): boolean {
  if (evidence.outcome !== 'success') return false
  const operations = evidence.operations ?? []
  const { subject } = item.verification
  if (subject) {
    const target = canonicalizePath(subject)
    return operations.some((entry) => entry.op === 'run' && entry.path !== undefined && canonicalizePath(entry.path) === target)
  }
  return operations.some((entry) => entry.op === 'run')
}

/** The facets a single evidence contributes to for an item. */
export interface EvidenceFacetCoverage {
  artifact: boolean
  effect: boolean
  method: boolean
  verify: boolean
  run: boolean
}

export function evidenceCoverage(item: GuardItem, evidence: GuardEvidence): EvidenceFacetCoverage {
  return {
    artifact: artifactFacetCovered(item, evidence),
    effect: effectFacetCovered(item, evidence),
    method: methodFacetCovered(item, evidence),
    verify: verifyFacetCovered(item, evidence),
    run: runFacetCovered(item, evidence),
  }
}

/**
 * Whether a single evidence can close an enforced item on its own. This is the
 * conservative per-evidence check; the certifier additionally verifies that the
 * whole binding satisfies every required facet.
 */
export function evidenceMatchesItem(item: GuardItem, evidence: GuardEvidence): boolean {
  if (evidence.outcome !== 'success') return false
  if (!item.verification.enforced) return true
  const coverage = evidenceCoverage(item, evidence)
  return coverage.artifact || coverage.effect || coverage.method || coverage.verify || coverage.run
}

/**
 * Whether a whole binding (a set of evidence ids) satisfies the fixed v0.1
 * binding invariants:
 *
 * - run: the method (or run) evidence alone closes the contract — no extra
 *   read or unrelated deterministic-check is required.
 * - create/write/modify: BOTH a method evidence (method + operation + subject)
 *   and a state-verification evidence on the same subject are required.
 * - read: a successful read evidence matching method, read operation and
 *   subject satisfies the method side and the object side at once.
 * - verify: only explicit read/verify/deterministic-check evidence on the
 *   subject closes; unrelated scope calls cannot be spliced in.
 * - explicit method without a parsable operation fails closed.
 * - a non-enforced item (prohibition) is acknowledged by any valid success
 *   evidence.
 */
export function bindingSatisfies(projection: GuardProjection, item: GuardItem, evidenceIds: string[]): boolean {
  if (!item.verification.enforced) {
    return evidenceIds.every((id) => {
      const value = projection.evidence.get(id)
      return !!value && value.epoch === projection.epoch && value.outcome === 'success'
    })
  }
  const { method, operation } = item.verification
  if (method && operation === undefined) return false
  let artifact = false
  let effect = false
  let verify = false
  let run = false
  const stateEvidenceIds = new Set<string>()
  const effectEvidenceIds = new Set<string>()
  for (const id of evidenceIds) {
    const value = projection.evidence.get(id)
    if (!value || value.epoch !== projection.epoch) return false
    const coverage = evidenceCoverage(item, value)
    if (!coverage.artifact && !coverage.effect && !coverage.method && !coverage.verify && !coverage.run) return false
    artifact = artifact || coverage.artifact
    effect = effect || coverage.effect
    verify = verify || coverage.verify
    run = run || coverage.run
    if (coverage.artifact) stateEvidenceIds.add(id)
    if (coverage.effect) effectEvidenceIds.add(id)
  }
  switch (operation) {
    case 'run':
      return effect
    case 'read':
      return effect
    case 'create':
    case 'write':
    case 'modify': {
      // A write/edit/create evidence cannot certify its own resulting state.
      // Require distinct effect and state evidence IDs.
      const independentState = [...stateEvidenceIds].some((id) => !effectEvidenceIds.has(id))
      const independentEffect = [...effectEvidenceIds].some((id) => !stateEvidenceIds.has(id))
      return effect && independentEffect && independentState
    }
    case 'verify':
      return verify
    default:
      return artifact
  }
}
