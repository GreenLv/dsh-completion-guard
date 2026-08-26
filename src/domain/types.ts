export type GuardItemKind = 'requirement' | 'acceptance' | 'prohibition'
export type GuardItemStatus = 'pending' | 'passed' | 'superseded'
export type GuardIntegrity = 'valid' | 'unknown' | 'corrupt'
export type EvidenceOutcome = 'success' | 'failure' | 'unknown'
export type GuardOperation = 'create' | 'write' | 'modify' | 'read' | 'run' | 'verify'

export interface VerificationContract {
  subject?: string
  surface?: 'artifact' | 'ui' | 'visual' | 'scope'
  enforced: boolean
  /** Explicitly-required tool/method (e.g. 'bash'); when set, a successful
   * evidence from that tool must be present in addition to artifact/scope
   * coverage before the item can close. */
  method?: string
  /** Explicitly-required operation/effect (e.g. 'create', 'read'). When set
   * alongside `method`, the method evidence must have performed that operation
   * on the same canonical subject — mentioning the file is not enough. */
  operation?: GuardOperation
}

export interface GuardItem {
  id: string
  revision: number
  kind: GuardItemKind
  sourceMessageId: string
  normalizedText: string
  textSha256: string
  status: GuardItemStatus
  supersededBy?: string
  verification: VerificationContract
}

export interface GuardEvidence {
  id: string
  epoch: number
  callId: string
  rootCallId: string
  toolName: string
  toolResultSeq: number
  outcome: EvidenceOutcome
  capabilities: string[]
  subjects: string[]
  surfaces: Array<'artifact' | 'ui' | 'visual' | 'scope'>
  boundedSummarySha256: string
  /** Executables invoked by a shell-tool command (e.g. 'pnpm', 'git'); present
   * only for command evidence, so an executable-method constraint ("使用 pnpm")
   * can be verified against the command that actually ran. */
  executables?: string[]
  /** Operations with their paths, parsed from the evidence's command or tool
   * payload (quote-aware). A subject mention alone proves nothing; the evidence
   * must show the requested operation on the target. */
  operations?: Array<{ op: GuardOperation; path?: string }>
}

export interface EvidenceBinding {
  itemId: string
  evidenceIds: string[]
}

export interface GuardCheckpoint {
  id: string
  epoch: number
  contractRevision: number
  openDigest: string
  bindingDigest: string
  bindings: EvidenceBinding[]
  result: 'certified' | 'incomplete' | 'unknown'
}

export interface GuardProjection {
  enabled: boolean
  epoch: number
  contractRevision: number
  items: Map<string, GuardItem>
  evidence: Map<string, GuardEvidence>
  checkpoints: GuardCheckpoint[]
  lastObservedSourceSeq: number
  lastGuardEventSeq: number
  lastRecoveryDigest?: string
  continuationAttempts: Map<number, number>
  integrity: GuardIntegrity
}

export function createProjection(): GuardProjection {
  return {
    enabled: false,
    epoch: 0,
    contractRevision: 0,
    items: new Map(),
    evidence: new Map(),
    checkpoints: [],
    lastObservedSourceSeq: -1,
    lastGuardEventSeq: -1,
    continuationAttempts: new Map(),
    integrity: 'valid',
  }
}

export interface DeriveScope {
  /** Session working directory; used as the scope subject for captured clauses. */
  cwd?: string
}

export interface DeriveConfig {
  activation: 'opt-in' | 'always'
}

export interface DeriveResult {
  projection: GuardProjection
  /** True when the log contains a compaction summary the agent must recover from. */
  compacted: boolean
  /** True when an off→on enablement transition was derived in this log. */
  enablementTransitioned: boolean
  /** Sequence of the last compaction summary in the log, or -1 when none. */
  lastCompactionSeq: number
}

export interface DerivedEnvelope {
  seq: number
  type: string
  data?: unknown
}
