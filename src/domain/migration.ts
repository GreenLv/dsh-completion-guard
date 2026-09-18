import { certificateClosure, certifiableOpenItems } from './closure.js'
import { CERTIFICATE_VERSION, CERTIFICATE_VERSION_V2, STOP_PROTOCOL_VERSION, STOP_PROTOCOL_VERSION_V2 } from './protocol-manifest.js'
import type { GuardProjection } from './types.js'

/**
 * Migration, rollback and preserved-identity facts (0.6.0 C12 / DS06-G).
 *
 * The 0.6.0 semantics are cut by the v5 protocol boundary, and the boundary is
 * a fact about the log, not a mode switch: a session that never wrote one is a
 * legacy session and keeps its whole-session contract, its version-1
 * certificates and its old digest domains. Nothing here re-interprets history.
 *
 * The report is derived state for diagnostics and for the operator-facing
 * migration and rollback instructions. It states three things honestly:
 *
 * 1. which rule set is actually in force (and therefore which certificate
 *    version a new certificate will carry);
 * 2. which obligations still carry their pre-v5 birth rules;
 * 3. that a rollback to 0.5.x REQUIRES restoring an old state snapshot — the
 *    new binary's v5 records are not readable by 0.5.x, and the fail-closed
 *    direction is a replay mismatch, never a silent downgrade.
 */

export interface MigrationReport {
  /** The rule set in force for NEW work in this session. */
  ruleMode: 'v6' | 'v5' | 'legacy-v4'
  /** The certificate version a new certificate in this session will carry. */
  certificateVersion: string
  /** The Stop protocol identity that goes with that certificate version. */
  stopProtocolVersion: string
  /** Whether the certified scope is the current unit closure (v5) or the session. */
  unitClosure: boolean
  /** The unit whose closure would be certified, when one exists. */
  currentUnitId?: string
  /** Pre-v5 obligations, which keep their birth rules and are never re-read. */
  legacyItemIds: string[]
  /** The v5 obligations currently in the certified scope. */
  unitClosureItemIds: string[]
  /** Digest domains that stay frozen and must never be rewritten by a migration. */
  preservedDigestDomains: string[]
  /** Old certificate versions that remain readable as history only. */
  historyOnlyCertificateVersions: string[]
  /** True when a rollback to the previous release needs an old state snapshot. */
  rollbackRequiresStateSnapshot: boolean
  /** The exact rollback instruction, for the operator surface. */
  rollbackInstruction: string
  reasonCodes: string[]
}

/** The frozen digest domains: a migration never rewrites any of them. */
export const PRESERVED_DIGEST_DOMAINS: readonly string[] = [
  'ccg.sessionRefDigest.v3', 'ccg.hostLockDigest.v3', 'ccg.evidenceFact.v3', 'ccg.evidenceSha256.v3',
  'ccg.predParams.v3', 'ccg.binding.v3', 'ccg.bindingDigest.v3', 'ccg.certificationDigest.v3',
  'ccg.locator.v1', 'ccg.proofManifest.v1',
]

export function migrationReport(projection: GuardProjection): MigrationReport {
  const v6 = projection.boundaryProtocol === 6
  const v5 = projection.boundaryProtocol !== undefined && projection.boundaryProtocol >= 5
  const legacyItemIds = certifiableOpenItems(projection)
    .filter((item) => item.unitId === undefined)
    .map((item) => item.id)
  const closure = v5 ? certificateClosure(projection) : { itemIds: [] }
  const reasonCodes: string[] = []
  if (!v5) reasonCodes.push('legacy_session_keeps_v4_contract')
  if (v5 && legacyItemIds.length > 0) reasonCodes.push('pre_v5_obligations_retained_in_closure')
  if (v6) reasonCodes.push('v6_ordinary_host_facts_and_legacy_review')
  if (v6 && projection.coreV2Reason) reasonCodes.push(`core_v2_${projection.coreV2Reason}`)
  return {
    ruleMode: v6 ? 'v6' : v5 ? 'v5' : 'legacy-v4',
    certificateVersion: v5 ? CERTIFICATE_VERSION_V2 : CERTIFICATE_VERSION,
    stopProtocolVersion: v5 ? STOP_PROTOCOL_VERSION_V2 : STOP_PROTOCOL_VERSION,
    unitClosure: v5,
    ...(v5 && projection.currentUnitId !== undefined ? { currentUnitId: projection.currentUnitId } : {}),
    legacyItemIds,
    unitClosureItemIds: [...closure.itemIds],
    preservedDigestDomains: [...PRESERVED_DIGEST_DOMAINS],
    historyOnlyCertificateVersions: v5 ? [CERTIFICATE_VERSION] : [],
    // Without the boundary there is nothing new to roll back: the session is
    // already running the historical contract.
    rollbackRequiresStateSnapshot: v5,
    rollbackInstruction: v6
      ? 'Restore a pre-v6 state snapshot before running 0.6.x. The v6 boundary, native-observation digest and migration review must not be read as v5 current authority or downgraded by hand.'
      : v5
      ? 'Restore the 0.5.x state snapshot before starting the older binary. Replaying a v5 log with 0.5.x fails closed with certificate_replay_mismatch; never migrate new-schema data down by hand.'
      : 'No rollback action is required for this session: it has not written a v5 boundary.',
    reasonCodes,
  }
}
