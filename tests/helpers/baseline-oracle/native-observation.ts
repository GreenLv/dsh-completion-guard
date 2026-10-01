// FROZEN BASELINE ORACLE (CG-083-V1): exact 913a4c7a6f0f600f4146ef4af694d3af6e477ef2 copy of src/domain/native-observation.ts. Do not edit except wholesale replacement.
import { createHash } from 'node:crypto'
import type { GuardEvidence } from './types.js'

/** DSH-specific, versioned identity for a host effect and a later observer. */
export const NATIVE_OBSERVATION_SCHEMA = 'dsh.native-observation/v1'
export const NATIVE_OBSERVATION_SCHEMA_V2 = 'dsh.native-observation/v2'

function sha(domain: string, value: string): string {
  return createHash('sha256').update(`${domain}\n${value}`, 'utf8').digest('hex')
}

export function nativeObservationDigest(effect: GuardEvidence, state: GuardEvidence): string {
  // Arrays avoid object-key serialization ambiguity. Each field is sourced from
  // the durable host log, not from a checkpoint tool argument.
  return sha('dsh.native-observation.v1', JSON.stringify([
    effect.id, effect.callId, effect.toolName, effect.toolResultSeq,
    effect.outcome, effect.subjects, effect.resolvedTarget ?? null, effect.processFacts?.outcome ?? null,
    state.id, state.callId, state.toolName, state.toolResultSeq,
    state.outcome, state.causedByCallId ?? null, state.subjects,
    state.resolvedTarget ?? null, state.observedState ?? null,
    state.nativeGitParentOid ?? null, state.nativeGitTreeOid ?? null,
  ]))
}

export function nativeObservationDigestV2(effect: GuardEvidence, state: GuardEvidence, rootLocatorIdentity: string): string {
  return sha('dsh.native-observation.v2-root-locator', JSON.stringify([
    rootLocatorIdentity, nativeObservationDigest(effect, state),
    state.nativeCanonicalPath ?? null, state.nativeCanonicalBase ?? null,
  ]))
}

export function nativeBindingDigest(legacyBindingDigest: string, observationDigests: readonly string[]): string {
  return sha('dsh.binding-digest.v4', JSON.stringify([legacyBindingDigest, [...observationDigests].sort()]))
}

export function nativeCertificationDigest(legacyCertificationDigest: string, bindingDigest: string, observationDigests: readonly string[]): string {
  return sha('dsh.certification-digest.v5', JSON.stringify([
    NATIVE_OBSERVATION_SCHEMA, legacyCertificationDigest, bindingDigest, [...observationDigests].sort(),
  ]))
}

/** V6 root capture identity is a separate domain; historical v3 bytes remain stable. */
export function locatorCertificationDigest(baseCertificationDigest: string, bindingDigest: string, observationDigests: readonly string[], rootLocatorIdentity: string): string {
  return sha('dsh.certification-digest.v6-root-locator', JSON.stringify([
    NATIVE_OBSERVATION_SCHEMA_V2, rootLocatorIdentity, baseCertificationDigest, bindingDigest, [...observationDigests].sort(),
  ]))
}
