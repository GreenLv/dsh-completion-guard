import type { GuardEvidence, GuardItem } from './types.js'

export function evidenceMatchesItem(item: GuardItem, evidence: GuardEvidence): boolean {
  if (evidence.outcome !== 'success') return false
  const { subject, surface } = item.verification
  if (item.verification.enforced) {
    // An enforced contract must be closed by capable evidence on the exact
    // subject and surface — never by an unrelated file read or stray command.
    if (!isVerifyingCapability(evidence)) return false
    if (!subject || !evidence.subjects.includes(subject)) return false
    if (!surface || !evidence.surfaces.includes(surface)) return false
  }
  return true
}

const VERIFYING_CAPABILITIES = new Set([
  'filesystem-read',
  'filesystem-edit',
  'web-fetch',
  'deterministic-check',
])

export function isVerifyingCapability(evidence: GuardEvidence): boolean {
  return evidence.capabilities.some((capability) => VERIFYING_CAPABILITIES.has(capability))
}
