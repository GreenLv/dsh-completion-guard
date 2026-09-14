/**
 * The seven unified reason-class labels (0.6.0 C12).
 *
 * Every fine-grained `reason_code` maps onto exactly one class, so a caller can
 * branch on the class while the existing codes keep their exact meaning and
 * their existing tests. The mapping table below is the frozen table; the
 * fallback for an unmapped code is `source_insufficient`, never a new class —
 * an unknown code must not silently become a different kind of failure.
 */

export type ReasonClass =
  | 'parameter_missing'
  | 'source_insufficient'
  | 'condition_unmet'
  | 'producer_capability_unavailable'
  | 'historical_gap'
  | 'integrity_failure'
  | 'policy_boundary'

/** The frozen seven class labels, in reporting order. */
export const REASON_CLASSES: readonly ReasonClass[] = [
  'parameter_missing', 'source_insufficient', 'condition_unmet', 'producer_capability_unavailable',
  'historical_gap', 'integrity_failure', 'policy_boundary',
]

export const REASON_CLASS_TABLE: Readonly<Record<string, ReasonClass>> = {
  // The caller has not supplied something only the caller can supply.
  requested_target_package_id_missing: 'parameter_missing',
  requested_target_artifact_id_missing: 'parameter_missing',
  requested_target_repository_missing: 'parameter_missing',
  requested_target_service_id_missing: 'parameter_missing',
  requested_target_registry_missing_or_invalid: 'parameter_missing',
  target_clarification_required: 'parameter_missing',
  item_not_found: 'parameter_missing',
  item_revision_mismatch: 'parameter_missing',
  unsupported_action: 'parameter_missing',
  missing_evidence: 'parameter_missing',
  action_plan_target_missing: 'parameter_missing',
  action_plan_evidence_missing: 'parameter_missing',
  binding_missing_required_facet: 'parameter_missing',
  evidence_missing: 'parameter_missing',
  proof_subject_invalid: 'parameter_missing',
  proof_source_invalid: 'parameter_missing',
  proof_evidence_invalid: 'parameter_missing',

  // The durable sources do not establish the fact.
  generic_run_non_certifiable: 'source_insufficient',
  legacy_generic_run_non_certifiable: 'source_insufficient',
  legacy_authority_unclassified: 'source_insufficient',
  inquiry_non_certifiable: 'source_insufficient',
  inquiry_awaiting_delivery: 'source_insufficient',
  answer_delivered: 'source_insufficient',
  certified: 'source_insufficient',
  semantic_action_mismatch: 'source_insufficient',
  evidence_matches_no_facet: 'source_insufficient',
  requested_target_mismatch: 'source_insufficient',
  requested_resolved_target_mismatch: 'source_insufficient',
  binding_state_cross_pairing: 'source_insufficient',
  binding_resolution_cross_pairing: 'source_insufficient',
  binding_observed_state_mismatch: 'source_insufficient',
  binding_state_observation_overlap: 'source_insufficient',
  binding_expected_transition_mismatch: 'source_insufficient',
  binding_state_closure_rejected: 'source_insufficient',
  expected_transition_mismatch: 'source_insufficient',
  non_stateful_role_manifest_invalid: 'source_insufficient',
  resolved_target_incomplete: 'source_insufficient',
  state_closure_incomplete: 'source_insufficient',
  delegated_result_bounded: 'source_insufficient',
  proof_subject_unbound: 'source_insufficient',
  proof_source_unbound: 'source_insufficient',
  proof_surface_unbound: 'source_insufficient',
  proof_role_unbound: 'source_insufficient',
  proof_operation_unbound: 'source_insufficient',
  proof_scope_subject_unbound: 'source_insufficient',
  proof_scope_digest_mismatch: 'source_insufficient',
  proof_scope_digest_invalid: 'source_insufficient',
  proof_evidence_outcome_invalid: 'source_insufficient',
  proof_evidence_constraint_failed: 'source_insufficient',

  // A declared condition or wait has not been satisfied.
  root_condition_pending: 'condition_unmet',
  prohibition_active: 'condition_unmet',
  ancestor_condition_unsatisfied: 'condition_unmet',
  ancestor_prohibition_active: 'condition_unmet',
  mutation_awaiting_root_condition: 'condition_unmet',
  mutation_awaiting_root_wait: 'condition_unmet',
  action_plan_order_mismatch: 'condition_unmet',

  // No audited producer exists in this cohort.
  adapter_unavailable: 'producer_capability_unavailable',
  host_unavailable: 'producer_capability_unavailable',
  stateful_adapter_unavailable: 'producer_capability_unavailable',
  proof_producer_capability_unavailable: 'producer_capability_unavailable',
  proof_readback_unavailable: 'producer_capability_unavailable',
  proof_external_fact_unavailable: 'producer_capability_unavailable',
  proof_external_fact_incomplete: 'producer_capability_unavailable',
  proof_source_bounded_delegation: 'producer_capability_unavailable',

  // The effect is observable but its pre-evidence is gone.
  historical_evidence_gap: 'historical_gap',
  effect_only_insufficient_state_readback: 'historical_gap',
  rebind_evidence_predates_source: 'historical_gap',
  resolution_expected_transition_missing: 'historical_gap',
  resolution_expected_transition_digest_missing: 'historical_gap',
  resolution_expected_transition_digest_mismatch: 'historical_gap',
  resolution_expected_transition_invalid: 'historical_gap',

  // Integrity / identity failures.
  integrity_invalid: 'integrity_failure',
  host_lock_unsupported: 'integrity_failure',
  certificate_missing: 'integrity_failure',
  certificate_replay_mismatch: 'integrity_failure',
  boundary_replay_mismatch: 'integrity_failure',
  proof_invalid: 'integrity_failure',
  proof_unbound: 'integrity_failure',
  proof_protocol_version_mismatch: 'integrity_failure',
  proof_digest_invalid: 'integrity_failure',
  proof_digest_mismatch: 'integrity_failure',
  proof_kind_unsupported: 'integrity_failure',
  proof_surface_unsupported: 'integrity_failure',
  proof_operation_unsupported: 'integrity_failure',
  proof_obligation_unbound: 'integrity_failure',
  proof_obligation_not_pending: 'integrity_failure',
  proof_evidence_unknown: 'integrity_failure',
  proof_evidence_wrong_epoch: 'integrity_failure',
  proof_manifest_invalid: 'integrity_failure',
  proof_obligations_missing: 'integrity_failure',
  proof_obligation_invalid: 'integrity_failure',
  proof_obligation_id_duplicate_or_invalid: 'integrity_failure',
  proof_asset_set_digest_invalid: 'integrity_failure',
  evidence_wrong_epoch: 'integrity_failure',
  evidence_outcome_not_success: 'integrity_failure',
  stale_host_lock: 'integrity_failure',
  stale_epoch: 'integrity_failure',
  stale_contract_revision: 'integrity_failure',
  stale_unit_ref: 'integrity_failure',
  stale_goal_ref: 'integrity_failure',
  legacy_certificate_in_v5_session: 'integrity_failure',
  certificate_version_unavailable: 'integrity_failure',
  mutation_integrity_unavailable: 'integrity_failure',
  item_missing_or_superseded: 'integrity_failure',
  unit_unavailable: 'integrity_failure',
  certificate_manifest_rejected: 'integrity_failure',
  session_ref_unavailable: 'integrity_failure',
  projection_durability_unavailable: 'integrity_failure',
  guard_unavailable: 'integrity_failure',
  binding_role_mismatch: 'integrity_failure',
  binding_role_order_invalid: 'integrity_failure',
  action_plan_evidence_reused: 'integrity_failure',
  action_plan_evidence_not_successful: 'integrity_failure',
  action_plan_evidence_predates_item: 'integrity_failure',
  action_plan_action_mismatch: 'integrity_failure',
  action_plan_incomplete: 'integrity_failure',
  action_plan_target_mismatch: 'integrity_failure',

  // The responsibility tier or the explicit release ticket governs this.
  release_contract_required: 'policy_boundary',
  release_operation_not_adopted: 'policy_boundary',
  release_operation_unprotectable: 'policy_boundary',
  release_operation_unrouted: 'policy_boundary',
  release_runner_opaque: 'policy_boundary',
  release_contract_expired: 'policy_boundary',
  release_expiry_unevaluable: 'policy_boundary',
  release_expiry_invalid: 'policy_boundary',
  release_operations_missing: 'policy_boundary',
  release_operation_unknown: 'policy_boundary',
  release_candidate_missing: 'policy_boundary',
  release_candidate_ref_missing: 'policy_boundary',
  release_candidate_sha_invalid: 'policy_boundary',
  release_candidate_artifact_digest_invalid: 'policy_boundary',
  release_contract_malformed: 'policy_boundary',
  release_reservation_malformed: 'policy_boundary',
  release_settlement_malformed: 'policy_boundary',
  release_subcommand_unknown: 'policy_boundary',
  release_operation_consumed: 'policy_boundary',
  release_operation_in_flight: 'policy_boundary',
  release_candidate_sha_mismatch: 'policy_boundary',
  release_candidate_ref_mismatch: 'policy_boundary',
  release_candidate_repository_mismatch: 'policy_boundary',
  release_candidate_package_mismatch: 'policy_boundary',
  release_candidate_version_mismatch: 'policy_boundary',
  release_candidate_registry_mismatch: 'policy_boundary',
  release_candidate_artifact_mismatch: 'policy_boundary',
  release_candidate_artifact_sri_mismatch: 'policy_boundary',
  release_candidate_sha_unresolved: 'policy_boundary',
  release_candidate_ref_unresolved: 'policy_boundary',
  release_candidate_repository_unresolved: 'policy_boundary',
  release_candidate_package_unresolved: 'policy_boundary',
  release_candidate_version_unresolved: 'policy_boundary',
  release_candidate_registry_unresolved: 'policy_boundary',
  release_artifact_sha256_unresolved: 'policy_boundary',
  release_artifact_sri_unresolved: 'policy_boundary',
  release_artifact_identity_required: 'policy_boundary',
  release_candidate_sha256_invalid: 'policy_boundary',
  release_candidate_sri_invalid: 'policy_boundary',
  release_candidate_field_unknown: 'policy_boundary',
  release_candidate_unobservable: 'policy_boundary',
  release_contract_revoked: 'policy_boundary',
  release_contract_revocation_unknown: 'policy_boundary',
  release_state_damaged: 'policy_boundary',
  release_readiness_unresolved: 'policy_boundary',
  release_closure_unresolved: 'policy_boundary',
  release_target_package_mismatch: 'policy_boundary',
  release_target_version_mismatch: 'policy_boundary',
  release_target_registry_mismatch: 'policy_boundary',
  release_artifact_digest_unresolved: 'policy_boundary',
  release_target_unresolved: 'policy_boundary',
  release_contract_granted: 'policy_boundary',
  release_profile_not_adopted: 'policy_boundary',
  release_reservation_not_durable: 'policy_boundary',
  release_gate_unavailable: 'policy_boundary',
  strict_proof_required: 'policy_boundary',
}

/** The seven-class label for one fine-grained reason code. */
export function reasonClassOf(reasonCode: string): ReasonClass {
  return REASON_CLASS_TABLE[reasonCode] ?? 'source_insufficient'
}
