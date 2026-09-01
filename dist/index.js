import { $ as GOAL_HOST_PACKAGES, $t as COMMAND_SURFACE_MANIFEST, A as decideTurnStopping, At as classifyClause, B as isDeterministicCheck, Bt as CERTIFICATE_VERSION, C as executeRevalidatedGitEffect, Ct as bindingSatisfies, D as verifiedLinearCommitReadback, Dt as currentContractDigest, E as revalidateGitPrestate, Et as isVerifyingCapability, F as deriveProjection, Ft as segmentClauses, G as parseShellCommand, Gt as actionCompatible, H as canonicalArgvFromCommand, Ht as STATEFUL_ACTIONS, I as supersedeItem, It as canonicalRegistryBase, J as ALPHA2_DSHMARKET_139_HOST_PACKAGES, Jt as requestedTargetMatchesResolved, K as goalCompletionDenial, Kt as isStatefulAction, L as evidenceFromPersistedToolResult, Lt as npmEscapedPackageName, M as latestAssistantText, Mt as extractMethod, N as observeAssistantOutcome, Nt as extractOperation, O as classifyCompletionClaim, Ot as captureClause, P as PROTOCOL_V3_NOTICE, Pt as isInformationalMessage, Q as EXPECTED_HOST_PACKAGES, Qt as validateActionTarget, R as extractTextContent, Rt as ACTION_MANIFEST, S as createGitPrestateEnvelope, St as renderRecoveryPacket, T as parseGitCommandManifest, Tt as evidenceMatchesItem, U as isRunExecutable, Ut as STOP_PROTOCOL_VERSION, V as withDurability, Vt as SEMANTIC_ACTIONS, W as parsePwshCommand, Wt as SUPPORTED_EVIDENCE_ADAPTERS, X as BASE_HOST_PACKAGES, Xt as semanticActionFromText, Y as ALPHA2_HOST_PACKAGES, Yt as semanticActionFromCommand, Z as DEFAULT_HOST_LOCK, Zt as validateActionManifest, _ as resolveInstalledHostLock, _t as certifyCheckpoint, a as createProofManifest, an as sanitizeUrl, at as evaluateHostCapability, b as commitIndexSnapshotDigest, bt as openItems, c as sessionQuery, ct as selectHostCohort, d as hostLockContextFromComposedDump, dt as segmentAuthorityBlocks, en as validateManifest, et as HOST_CAPABILITY_PACKAGE_GROUPS, f as hostLockRowsFromComposedDump, ft as classifyUserInteraction, g as resolveActiveProfileHostLock, gt as qualifyBoundary, h as packageRowsFromPnpmLock, ht as isCurrentAcceptedBoundary, i as canonicalProjection, in as sanitizeClauseText, it as evaluateExternalWaitCapability, j as isWholeTaskCompletionClaim, jt as extractArtifactPaths, k as decideTurnBoundary, kt as captureItem, l as validateProofManifest, lt as ALPHA3_HOST_PACKAGES, m as packageRowsFromActiveGraph, mt as effectuateBoundary, n as PROOF_PROTOCOL_VERSION, nn as digestStrings, nt as bindExecutableIdentity, o as proofDigest, on as sha256, ot as evaluateHostLock, p as injectActiveProfileHostLock, pt as availableBoundaryQualifications, q as hasCurrentCertificate, qt as requestedTargetAuthorizesMutation, r as bindProofToProjection, rn as normalizeClause, rt as bindLiveGoalCapability, s as proofEvidenceConstraints, sn as createProjection, st as evaluateToolSurfaceCapability, t as PROOF_KINDS, tn as canonicalizePath, tt as HOST_COHORTS, u as HostProfileError, ut as authorityCaptureCounts, v as verifyComposedHostLockDump, vt as DEFAULT_RECOVERY_CHAR_BUDGET, w as gitCommandMatchesTarget, wt as evidenceCoverage, x as commitTreeSnapshotDigest, xt as recoveryDigest, y as GIT_COMMAND_MANIFEST_IDS, yt as closingHint, z as extractToolSubject, zt as ACTION_MANIFEST_VERSION } from "./domain-CHTQFIT8.js";
import { boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";
import { createHash } from "node:crypto";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { execFile } from "node:child_process";
import { constants, existsSync, readFileSync } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

//#region src/tools/checkpoint.ts
function targetForTool(target) {
	if (!target) return {};
	return Object.fromEntries(Object.entries(target).map(([key, value]) => {
		if (typeof value !== "object" || value === null) return [key, value];
		const raw = value.v;
		const jsonValue = raw === null || [
			"string",
			"number",
			"boolean"
		].includes(typeof raw) ? raw : String(raw);
		return [key, {
			k: value.k,
			v: jsonValue
		}];
	}));
}
function expectedParameters(action, resolved, observed) {
	if (action === "inspect_remote_updates") return {
		...pick$1(resolved, ["remote", "version"]),
		...pick$1(observed, ["upstream_oid"])
	};
	return {
		expected_outcome: {
			k: "e",
			v: "success"
		},
		min_matches: 1
	};
}
function expectedTransitionForTool(transition) {
	return {
		predicate_id: transition.predicateId,
		version: transition.version,
		pred_params_kind: transition.predParamsKind,
		...transition.parameters ? { parameters: targetForTool(transition.parameters) } : {},
		...transition.parametersDigest ? { parameters_digest: transition.parametersDigest } : {}
	};
}
function pick$1(tuple$1, keys) {
	return Object.fromEntries(keys.filter((key) => Object.hasOwn(tuple$1, key)).map((key) => [key, tuple$1[key]]));
}
function sameTuple(left, right) {
	const stable$1 = (value) => Array.isArray(value) ? `[${value.map(stable$1).join(",")}]` : value && typeof value === "object" ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stable$1(entry)}`).join(",")}}` : JSON.stringify(value);
	return stable$1(left ?? {}) === stable$1(right ?? {});
}
function evidenceForAction(projection, item) {
	return [...projection.evidence.values()].filter((evidence) => evidence.epoch === projection.epoch && evidence.outcome === "success" && evidence.semanticAction === item.semanticAction);
}
function bindingTemplate(projection, item) {
	const action = item.semanticAction;
	if (!action || action === "generic_run") return void 0;
	const evidence = evidenceForAction(projection, item);
	const effect = evidence.find((entry) => (entry.evidenceRole ?? "effect") === "effect");
	if (!effect?.resolvedTarget) return void 0;
	const resolved = effect.resolvedTarget;
	const resolution = isStatefulAction(action) ? evidence.find((entry) => entry.evidenceRole === "resolution" && sameTuple(entry.resolvedTarget, resolved)) : void 0;
	const states = isStatefulAction(action) ? evidence.filter((entry) => entry.evidenceRole === "state" && sameTuple(entry.resolvedTarget, resolved)) : [];
	if (isStatefulAction(action) && (!resolution || states.length === 0)) return void 0;
	if (isStatefulAction(action) && (!resolution?.expectedTransition?.parameters || !resolution.expectedTransitionDigest)) return void 0;
	const observed = isStatefulAction(action) ? Object.assign({}, ...states.map((entry) => entry.observedState ?? {})) : effect.observedState ?? {};
	const expectedTransition = isStatefulAction(action) ? resolution.expectedTransition : {
		predicateId: ACTION_MANIFEST.actions[action].predicateId,
		version: 1,
		predParamsKind: "inline",
		parameters: expectedParameters(action, resolved, observed)
	};
	return {
		item_id: item.id,
		evidence_ids: isStatefulAction(action) ? [
			resolution.id,
			effect.id,
			...states.map((entry) => entry.id)
		] : [effect.id],
		semantic_action: action,
		requested_target: targetForTool(item.requestedTarget),
		resolved_target: targetForTool(resolved),
		observed_state: targetForTool(observed),
		expected_transition: expectedTransitionForTool(expectedTransition),
		...isStatefulAction(action) ? {
			resolution_evidence_id: resolution.id,
			effect_evidence_id: effect.id,
			state_evidence_ids: states.map((entry) => entry.id)
		} : { effect_evidence_id: effect.id }
	};
}
function openItemForTool(projection, item) {
	const action = item.semanticAction ?? "generic_run";
	const spec = ACTION_MANIFEST.actions[action];
	const template = bindingTemplate(projection, item);
	return {
		id: item.id,
		kind: item.kind,
		semantic_action: action,
		requested_target: targetForTool(item.requestedTarget),
		certifiable: action !== "generic_run" && ACTION_MANIFEST.actions[action].evidenceProducer === "supported" && !item.legacyFlags?.length && item.targetCaptureStatus !== "clarification_required",
		producer_disposition: ACTION_MANIFEST.actions[action].evidenceProducer,
		...item.targetCaptureStatus ? { target_capture_status: item.targetCaptureStatus } : {},
		...item.targetCaptureReasonCode ? { target_capture_reason_code: item.targetCaptureReasonCode } : {},
		predicate: {
			predicate_id: spec.predicateId,
			version: 1,
			parameters_source: isStatefulAction(action) ? "resolution_evidence_expected_transition" : "versioned_action_manifest",
			resolved_target_keys: spec.resolvedTargetKeys,
			observed_state_keys: spec.observedStateKeys,
			pred_params_kind: "inline"
		},
		...template ? { binding_template: template } : {}
	};
}
function createCheckpointTool(getProjection, onRejected, prepare = async () => true) {
	return defineTool({
		name: "context_guard_checkpoint",
		description: "Request a completion certificate from existing durable evidence.",
		parameters: { bindings: {
			type: "array",
			required: true,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					item_id: {
						type: "string",
						required: true
					},
					evidence_ids: {
						type: "array",
						required: true,
						items: { type: "string" }
					},
					semantic_action: { type: "string" },
					requested_target: {
						type: "object",
						additionalProperties: true
					},
					resolved_target: {
						type: "object",
						additionalProperties: true
					},
					observed_state: {
						type: "object",
						additionalProperties: true
					},
					expected_transition: {
						type: "object",
						additionalProperties: false,
						properties: {
							predicate_id: {
								type: "string",
								required: true
							},
							version: {
								type: "integer",
								required: true
							},
							pred_params_kind: {
								type: "string",
								required: true,
								enum: ["inline"]
							},
							parameters: {
								type: "object",
								additionalProperties: true
							},
							parameters_digest: { type: "string" }
						}
					},
					resolution_evidence_id: { type: "string" },
					effect_evidence_id: { type: "string" },
					state_evidence_ids: {
						type: "array",
						items: { type: "string" }
					}
				}
			}
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					status: {
						type: "string",
						enum: [
							"certified",
							"incomplete",
							"unknown"
						]
					},
					contract_revision: { type: "integer" },
					open_items: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: true
						}
					},
					available_evidence: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								id: { type: "string" },
								call_id: { type: "string" },
								tool: { type: "string" },
								subjects: {
									type: "array",
									items: { type: "string" }
								},
								surfaces: {
									type: "array",
									items: { type: "string" }
								},
								outcome: { type: "string" },
								capabilities: {
									type: "array",
									items: { type: "string" }
								},
								operations: {
									type: "array",
									items: { type: "string" }
								},
								executables: {
									type: "array",
									items: { type: "string" }
								},
								semantic_action: { type: "string" },
								evidence_role: {
									type: "string",
									enum: [
										"resolution",
										"effect",
										"state"
									]
								},
								resolved_target: {
									type: "object",
									additionalProperties: true
								},
								observed_state: {
									type: "object",
									additionalProperties: true
								},
								expected_transition: {
									type: "object",
									additionalProperties: true
								},
								expected_transition_digest: { type: "string" },
								parse_status: { type: "string" },
								reason_code: { type: "string" },
								adapter_id: { type: "string" },
								adapter_version: { type: "string" },
								adapter_disposition: {
									type: "string",
									enum: ["citable", "unavailable"]
								}
							}
						}
					},
					available_qualifications: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								id: { type: "string" },
								kind: { type: "string" },
								disposition: { type: "string" },
								source: { type: "string" },
								status: { type: "string" }
							}
						}
					},
					rejected_bindings: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								item_id: { type: "string" },
								reason: { type: "string" },
								reason_code: { type: "string" },
								offending_evidence_ids: {
									type: "array",
									items: { type: "string" }
								},
								hint: { type: "string" }
							}
						}
					},
					certificate: {
						type: "object",
						additionalProperties: false,
						properties: {
							stop_protocol_version: { type: "string" },
							certificate_version: { type: "string" },
							epoch: { type: "integer" },
							session_ref_digest: { type: "string" },
							host_lock_digest: { type: "string" },
							contract_revision: { type: "integer" },
							contract_sha256: { type: "string" },
							open_digest: { type: "string" },
							evidence_sha256: { type: "string" },
							binding_digest: { type: "string" },
							certification_digest: { type: "string" },
							goal_ref: { oneOf: [{
								type: "object",
								additionalProperties: false,
								properties: {
									id: { type: "string" },
									revision: { type: "integer" }
								}
							}, { type: "null" }] }
						}
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value)
			}]
		},
		async execute(rawArgs) {
			const args = rawArgs;
			const durable = await prepare();
			const projection = getProjection();
			if (!durable || !projection) {
				onRejected();
				return {
					status: "unknown",
					contract_revision: 0,
					open_items: [],
					available_evidence: [],
					available_qualifications: [],
					rejected_bindings: []
				};
			}
			const result = certifyCheckpoint(projection, args.bindings.map((binding) => ({
				itemId: binding.item_id,
				evidenceIds: binding.evidence_ids,
				...binding.semantic_action ? { semanticAction: binding.semantic_action } : {},
				...binding.requested_target ? { requestedTarget: binding.requested_target } : {},
				...binding.resolved_target ? { resolvedTarget: binding.resolved_target } : {},
				...binding.observed_state ? { observedState: binding.observed_state } : {},
				...binding.expected_transition ? { expectedTransition: {
					predicateId: binding.expected_transition.predicate_id,
					version: binding.expected_transition.version,
					predParamsKind: binding.expected_transition.pred_params_kind,
					...binding.expected_transition.parameters ? { parameters: binding.expected_transition.parameters } : {},
					...binding.expected_transition.parameters_digest ? { parametersDigest: binding.expected_transition.parameters_digest } : {}
				} } : {},
				...binding.resolution_evidence_id ? { resolutionEvidenceId: binding.resolution_evidence_id } : {},
				...binding.effect_evidence_id ? { effectEvidenceId: binding.effect_evidence_id } : {},
				...binding.state_evidence_ids ? { stateEvidenceIds: binding.state_evidence_ids } : {}
			})), `C${projection.checkpoints.length + 1}`, false);
			if (!result.checkpoint) onRejected();
			const available_evidence = [...projection.evidence.values()].filter((evidence) => evidence.epoch === projection.epoch && evidence.outcome === "success").sort((a, b) => a.id < b.id ? -1 : 1).map((evidence) => ({
				id: evidence.id,
				call_id: evidence.callId,
				tool: evidence.toolName,
				subjects: evidence.subjects,
				surfaces: evidence.surfaces,
				outcome: evidence.outcome,
				capabilities: evidence.capabilities,
				operations: (evidence.operations ?? []).map((entry) => entry.op),
				executables: evidence.executables ?? [],
				semantic_action: evidence.semanticAction ?? "generic_run",
				evidence_role: evidence.evidenceRole ?? "effect",
				resolved_target: targetForTool(evidence.resolvedTarget),
				observed_state: targetForTool(evidence.observedState),
				...evidence.expectedTransition ? { expected_transition: expectedTransitionForTool(evidence.expectedTransition) } : {},
				...evidence.expectedTransitionDigest ? { expected_transition_digest: evidence.expectedTransitionDigest } : {},
				parse_status: evidence.parseStatus ?? "adapter_unavailable",
				...evidence.adapterId ? { adapter_id: evidence.adapterId } : {},
				...evidence.adapterVersion ? { adapter_version: evidence.adapterVersion } : {},
				adapter_disposition: evidence.parseStatus === "supported" ? "citable" : "unavailable",
				...evidence.reasonCode ? { reason_code: evidence.reasonCode } : {}
			}));
			return {
				status: result.status,
				contract_revision: result.contractRevision,
				open_items: result.openItems.map((id) => projection.items.get(id)).filter((item) => Boolean(item)).map((item) => openItemForTool(projection, item)),
				available_evidence,
				available_qualifications: availableBoundaryQualifications(projection).map((row) => ({
					id: row.id,
					kind: row.kind,
					disposition: row.disposition,
					source: row.source,
					status: row.status
				})),
				rejected_bindings: result.rejectedBindings.map((binding) => ({
					item_id: binding.itemId,
					reason: binding.reason,
					reason_code: binding.reasonCode,
					...binding.offendingEvidenceIds ? { offending_evidence_ids: binding.offendingEvidenceIds } : {},
					...binding.hint !== void 0 ? { hint: binding.hint } : {}
				})),
				...result.checkpoint ? { certificate: {
					stop_protocol_version: result.checkpoint.stopProtocolVersion,
					certificate_version: result.checkpoint.certificateVersion,
					epoch: result.checkpoint.epoch,
					session_ref_digest: result.checkpoint.sessionRefDigest,
					host_lock_digest: result.checkpoint.hostLockDigest,
					contract_revision: result.checkpoint.contractRevision,
					contract_sha256: result.checkpoint.contractSha256,
					open_digest: result.checkpoint.openDigest,
					evidence_sha256: result.checkpoint.evidenceSha256,
					binding_digest: result.checkpoint.bindingDigest,
					certification_digest: result.checkpoint.certificationDigest,
					goal_ref: result.checkpoint.goalRef ?? null
				} } : {}
			};
		}
	});
}

//#endregion
//#region src/tools/boundary.ts
function createBoundaryTool(getProjection, prepare, onRejected) {
	return defineTool({
		name: "context_guard_boundary",
		description: "Persist a qualified user_wait, external_wait, or deferred boundary. Free-form notes never qualify a boundary.",
		parameters: {
			disposition: {
				type: "string",
				required: true,
				enum: [
					"user_wait",
					"external_wait",
					"deferred"
				]
			},
			qualification_kind: {
				type: "string",
				required: true,
				enum: [
					"user_decision_item",
					"root_explicit_wait",
					"external_operation_pending",
					"root_explicit_defer"
				]
			},
			qualification_ids: {
				type: "array",
				required: true,
				items: { type: "string" }
			},
			note: { type: "string" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					status: {
						type: "string",
						enum: [
							"accepted",
							"rejected",
							"unknown"
						]
					},
					reason_code: { type: "string" },
					available_qualifications: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								id: { type: "string" },
								kind: { type: "string" },
								disposition: { type: "string" },
								source: { type: "string" },
								status: { type: "string" }
							}
						}
					},
					boundary: {
						type: "object",
						additionalProperties: false,
						properties: {
							id: { type: "string" },
							disposition: { type: "string" },
							qualification_kind: { type: "string" },
							qualification_ids: {
								type: "array",
								items: { type: "string" }
							},
							epoch: { type: "integer" },
							contract_revision: { type: "integer" },
							contract_sha256: { type: "string" },
							candidate_sha256: { type: "string" }
						}
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value)
			}]
		},
		async execute(args) {
			const durable = await prepare();
			const projection = getProjection();
			if (!durable || !projection) {
				onRejected();
				return {
					status: "unknown",
					reason_code: "boundary_persistence_unknown",
					available_qualifications: [],
					boundary: void 0
				};
			}
			const candidate = qualifyBoundary(projection, {
				disposition: args.disposition,
				qualificationKind: args.qualification_kind,
				qualificationIds: args.qualification_ids
			});
			if (candidate.persistedResult !== "accepted") onRejected();
			return {
				status: candidate.persistedResult,
				reason_code: candidate.reasonCode,
				available_qualifications: availableBoundaryQualifications(projection).map((row) => ({
					id: row.id,
					kind: row.kind,
					disposition: row.disposition,
					source: row.source,
					status: row.status
				})),
				boundary: {
					id: candidate.id,
					disposition: candidate.disposition,
					qualification_kind: candidate.qualificationKind,
					qualification_ids: candidate.qualificationIds,
					epoch: candidate.epoch,
					contract_revision: candidate.contractRevision,
					contract_sha256: candidate.contractSha256,
					candidate_sha256: candidate.candidateSha256
				}
			};
		}
	});
}

//#endregion
//#region src/tools/evidence.ts
const execFileAsync = promisify(execFile);
const PRODUCER_VERSION = "1.0.0";
const PRODUCER_TOOL = "context_guard_evidence";
const ACTION_TOOL = "context_guard_action";
const SUPPORTED = [
	"install",
	"apply",
	"create",
	"modify",
	"restart",
	"commit",
	"push",
	"publish",
	"pull",
	"fetch"
];
const RESTART_INTENT_PREFIX = "Context Guard restart intent v1: ";
function restartIntent(events, resolutionCallId, target) {
	for (const raw of events) {
		const event = record(raw);
		if (!event || event.type !== "user/message") continue;
		const data = record(event.data);
		const source = record(data?.source);
		if (source?.kind !== "plugin" || source.plugin !== "context-guard" || source.form !== "notice") continue;
		const content = Array.isArray(data?.content) ? data.content : [];
		const block = content.length === 1 ? record(content[0]) : void 0;
		const text = typeof block?.text === "string" ? block.text : "";
		if (!text.startsWith(RESTART_INTENT_PREFIX)) continue;
		try {
			const value = record(JSON.parse(text.slice(33)));
			if (value?.resolution_call_id === resolutionCallId && value.service_id === target.service_id && value.pre_generation === target.pre_generation) return true;
		} catch {}
	}
	return false;
}
function installedProfile(moduleUrl = import.meta.url) {
	let directory = dirname(fileURLToPath(moduleUrl));
	while (true) {
		const manifestPath = join(directory, "package.json");
		if (existsSync(manifestPath)) try {
			if (JSON.parse(readFileSync(manifestPath, "utf8")).name === "dsh-completion-guard") {
				const modules = dirname(directory);
				if (basename(modules) !== "node_modules") return void 0;
				const profilePath = dirname(modules);
				return {
					name: basename(profilePath),
					path: profilePath
				};
			}
		} catch {
			return;
		}
		const parent = dirname(directory);
		if (parent === directory) return void 0;
		directory = parent;
	}
}
function record(value) {
	return value && typeof value === "object" ? value : void 0;
}
function stable(value) {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
	return JSON.stringify(value);
}
function digest(value) {
	return createHash("sha256").update(stable(value)).digest("hex");
}
function jsonTuple(tuple$1) {
	if (!tuple$1) return {};
	return Object.fromEntries(Object.entries(tuple$1).map(([key, value]) => [key, value]));
}
function jsonExpectedTransition(transition) {
	return {
		predicateId: transition.predicateId,
		version: transition.version,
		predParamsKind: transition.predParamsKind,
		parameters: jsonTuple(transition.parameters)
	};
}
function tuple(value) {
	return record(value);
}
function adapterId(action) {
	if (["create", "modify"].includes(action)) return "context-guard.artifact.v1";
	if (["install", "apply"].includes(action)) return "context-guard.package.v1";
	if (action === "restart") return "context-guard.service.v1";
	if (action === "publish") return "context-guard.registry.v1";
	return "context-guard.git.v1";
}
function unavailable(action, role, reason) {
	return {
		status: "unavailable",
		reason_code: reason,
		semantic_action: action,
		evidence_role: role,
		resolved_target: {},
		observed_state: {},
		adapter_id: adapterId(action),
		adapter_version: PRODUCER_VERSION,
		target_digest: "",
		command_manifest_digest: ""
	};
}
function supported(action, role, resolved, observed = {}, commandManifest = {}, gitBinding, executable, expectedTransition) {
	return {
		status: "supported",
		reason_code: "producer_observation_supported",
		semantic_action: action,
		evidence_role: role,
		resolved_target: jsonTuple(resolved),
		observed_state: jsonTuple(observed),
		adapter_id: adapterId(action),
		adapter_version: PRODUCER_VERSION,
		target_digest: digest(resolved),
		command_manifest_digest: digest(commandManifest),
		...gitBinding ? { git_binding: gitBinding } : {},
		...executable ? { executable_identity: executable } : {},
		...expectedTransition ? (() => {
			const frozen = jsonExpectedTransition(expectedTransition);
			return {
				expected_transition: frozen,
				expected_transition_digest: digest(frozen)
			};
		})() : {}
	};
}
function messageMeta(event) {
	return record(record(event.data)?.meta);
}
function producerMeta(event) {
	return record(messageMeta(event)?.contextGuard);
}
function eventCallId(event) {
	const data = record(event.data);
	if (event.type === "tool/call") return typeof data?.callId === "string" ? data.callId : void 0;
	const source = record(record(data?.message)?.source);
	return typeof source?.callId === "string" ? source.callId : void 0;
}
function findResolution(events, callId, action) {
	let selector;
	let commandManifest;
	for (const raw of events) {
		const event = record(raw);
		if (!event || eventCallId(event) !== callId) continue;
		if (event.type === "tool/call") {
			const data = record(event.data);
			try {
				const args = record(JSON.parse(String(data?.arguments ?? "{}")));
				selector = record(args?.selector);
				commandManifest = record(args?.command_manifest);
			} catch {
				return;
			}
			continue;
		}
		if (event.type !== "tool/result") continue;
		const meta = producerMeta(event);
		if (meta?.semanticAction !== action || meta.evidenceRole !== "resolution" || meta.adapterVersion !== PRODUCER_VERSION || !selector || !commandManifest) return void 0;
		const target = tuple(meta.resolvedTarget);
		const rawBinding = record(meta.gitBinding);
		const rawManifest = record(rawBinding?.manifest);
		const rawPrestate = record(rawBinding?.prestate);
		const rawEnvelope = record(rawBinding?.envelope);
		const rawExecutable = record(meta.executableIdentity);
		const rawExpected = record(meta.expectedTransition);
		const expectedParameters$1 = record(rawExpected?.parameters);
		const expectedTransition = rawExpected && typeof rawExpected.predicateId === "string" && rawExpected.version === 1 && rawExpected.predParamsKind === "inline" && expectedParameters$1 ? rawExpected : void 0;
		const expectedTransitionDigest = typeof meta.expectedTransitionDigest === "string" ? meta.expectedTransitionDigest : void 0;
		const interpreterIdentityValid = rawExecutable && (rawExecutable.interpreterRealpath === void 0 && rawExecutable.interpreterVersion === void 0 || typeof rawExecutable.interpreterRealpath === "string" && typeof rawExecutable.interpreterVersion === "string");
		const executableIdentity$1 = rawExecutable && typeof rawExecutable.executable === "string" && typeof rawExecutable.realpath === "string" && typeof rawExecutable.version === "string" && interpreterIdentityValid ? rawExecutable : void 0;
		const gitBinding = rawManifest && rawPrestate && rawEnvelope ? {
			manifest: rawManifest,
			prestate: Object.fromEntries(Object.entries(rawPrestate).filter((entry) => typeof entry[1] === "string")),
			envelope: rawEnvelope
		} : void 0;
		return target && expectedTransition && expectedTransitionDigest === digest(expectedTransition) ? {
			target,
			selector,
			commandManifest,
			...gitBinding ? { gitBinding } : {},
			...executableIdentity$1 ? { executableIdentity: executableIdentity$1 } : {},
			expectedTransition,
			expectedTransitionDigest
		} : void 0;
	}
}
function findEffect(events, callId) {
	let call;
	for (const raw of events) {
		const event = record(raw);
		if (!event) continue;
		const seq = typeof event.seq === "number" ? event.seq : -1;
		if (event.type === "tool/call" && eventCallId(event) === callId) {
			const data = record(event.data);
			let args = {};
			try {
				args = record(JSON.parse(String(data?.arguments ?? "{}"))) ?? {};
			} catch {
				args = {};
			}
			call = {
				name: String(data?.name ?? ""),
				arguments: args,
				callSeq: seq,
				resultSeq: -1,
				textContent: ""
			};
		}
		if (event.type === "tool/result" && eventCallId(event) === callId && call) {
			const data = record(event.data);
			call.resultSeq = seq;
			call.error = data?.error;
			call.meta = data?.meta;
			call.textContent = extractTextContent(record(data?.message)?.content ?? []);
			return call;
		}
	}
}
function actionCallMatches(events, callId, action, resolutionCallId, target) {
	for (const raw of events) {
		const event = record(raw);
		if (!event || event.type !== "tool/call" || eventCallId(event) !== callId) continue;
		const data = record(event.data);
		if (data?.name !== ACTION_TOOL) return false;
		try {
			const args = record(JSON.parse(String(data.arguments ?? "{}")));
			return args?.semantic_action === action && args.resolution_call_id === resolutionCallId && args.target_digest === digest(target) && typeof args.contract_item_id === "string" && Number.isSafeInteger(args.contract_item_revision);
		} catch {
			return false;
		}
	}
	return false;
}
function actionResultCompleted(events, callId) {
	for (const raw of events) {
		const event = record(raw);
		if (!event || event.type !== "tool/result" || eventCallId(event) !== callId) continue;
		return record(messageMeta(event)?.contextGuardAction)?.status === "completed";
	}
	return false;
}
function plannedEffectDigest(manifest) {
	const name$1 = typeof manifest.planned_tool === "string" ? manifest.planned_tool : void 0;
	const args = record(manifest.planned_arguments);
	return name$1 && args ? digest({
		name: name$1,
		arguments: args
	}) : void 0;
}
function plannedEffect(manifest) {
	const name$1 = typeof manifest.planned_tool === "string" ? manifest.planned_tool : void 0;
	const args = record(manifest.planned_arguments);
	return name$1 && args ? {
		name: name$1,
		arguments: args,
		digest: digest({
			name: name$1,
			arguments: args
		})
	} : void 0;
}
function plannedGitManifest(action, selector, planned) {
	if (planned.name !== "bash" && planned.name !== "pwsh" || !hasExactKeys(planned.arguments, ["command", "workdir"])) return void 0;
	const repository = requireString(selector, "repository");
	const command = requireString(planned.arguments, "command");
	if (!repository || planned.arguments.workdir !== repository || !command) return void 0;
	const parsed = parseGitCommandManifest(command, planned.name);
	if (parsed.status !== "accepted" || parsed.manifest.action !== action) return void 0;
	const remote = requireString(selector, "remote");
	const refspec = requireString(selector, "refspec");
	if (!gitCommandMatchesTarget(parsed.manifest, {
		repository,
		...remote ? { remote } : {},
		...refspec ? { refspec } : {}
	})) return void 0;
	return parsed.manifest;
}
function effectDigest(effect) {
	return digest({
		name: effect.name,
		arguments: effect.arguments
	});
}
function cwdOf(agent) {
	const header = record(agent.session.header);
	return typeof header?.cwd === "string" ? header.cwd : void 0;
}
function pathOf(selector, cwd) {
	const raw = typeof selector.artifact_id === "string" ? selector.artifact_id : void 0;
	if (!raw) return void 0;
	return isAbsolute(raw) ? raw : cwd ? resolve(cwd, raw) : void 0;
}
async function fileDigest(path) {
	try {
		return createHash("sha256").update(await readFile(path)).digest("hex");
	} catch (error) {
		if (error.code === "ENOENT") return "absent";
		throw error;
	}
}
async function readJson(path) {
	try {
		return record(JSON.parse(await readFile(path, "utf8")));
	} catch {
		return;
	}
}
async function tgzIdentity(path) {
	if (!isAbsolute(path) || !path.endsWith(".tgz")) return void 0;
	const bytes = await readFile(path);
	if (bytes.length === 0 || bytes.length > 128 * 1024 * 1024) return void 0;
	const tar = await promisify(gunzip)(bytes);
	let manifest;
	for (let offset = 0; offset + 512 <= tar.length;) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const name$1 = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
		const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
		if (!/^[0-7]+$/.test(sizeText)) return void 0;
		const size = Number.parseInt(sizeText, 8);
		const bodyStart = offset + 512;
		const bodyEnd = bodyStart + size;
		if (!Number.isSafeInteger(size) || size < 0 || bodyEnd > tar.length) return void 0;
		if (name$1 === "package/package.json") {
			if (manifest || size > 1024 * 1024) return void 0;
			try {
				manifest = record(JSON.parse(tar.subarray(bodyStart, bodyEnd).toString("utf8")));
			} catch {
				return;
			}
		}
		offset = bodyStart + Math.ceil(size / 512) * 512;
	}
	if (typeof manifest?.name !== "string" || typeof manifest.version !== "string") return void 0;
	return {
		name: manifest.name,
		version: manifest.version,
		integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`
	};
}
const DSHMARKET_VERSION = "1.36.0";
const DSHMARKET_INTEGRITY = "sha512-xX8CCoXdIALaxtLosj+5qGg8r1cykW2zo1AOPJcSQepg2r4Vd2K0NmERldDqfeyFV0pCuZsUoAPe1Q/BW7De/g==";
const MARKET_SCHEMA = "dsh-market/update-api/v1";
async function marketCapabilities(roots, signal) {
	if (!roots.profile || !roots.marketOrigin) return void 0;
	const installed = await profilePackage(roots.profile.path, "dshmarket");
	if (installed?.version !== DSHMARKET_VERSION || installed.integrity !== DSHMARKET_INTEGRITY) return void 0;
	const response = await (roots.fetcher ?? fetch)(`${roots.marketOrigin}/dsh-market/api/v1/capabilities`, {
		signal,
		headers: { accept: "application/json" },
		redirect: "error"
	});
	if (!response.ok) return void 0;
	const value = record(await response.json());
	if (value?.schema !== MARKET_SCHEMA || value.apiVersion !== 1 || value.marketVersion !== DSHMARKET_VERSION || value.profile !== roots.profile.name || typeof value.bootId !== "string") return void 0;
	return value;
}
function importerLocator(text, packageId) {
	const escaped = packageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex((line) => (/* @__PURE__ */ new RegExp(`^      ['"]?${escaped}['"]?:\\s*$`)).test(line));
	if (start < 0) return void 0;
	for (let index = start + 1; index < lines.length; index += 1) {
		if (/^      \S/.test(lines[index])) break;
		const match = /^        version:\s*(.+?)\s*$/.exec(lines[index]);
		if (match) return match[1].replace(/^['"]|['"]$/g, "");
	}
}
function lockIntegrity(text, packageId, locator) {
	const escaped = `${packageId}@${locator}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex((line) => (/* @__PURE__ */ new RegExp(`^  ['"]?${escaped}['"]?:\\s*$`)).test(line));
	if (start < 0) return void 0;
	for (let index = start + 1; index < lines.length; index += 1) {
		if (/^  \S/.test(lines[index])) break;
		const match = /^    resolution: \{integrity: ([^}]+)\}\s*$/.exec(lines[index]);
		if (match) return match[1];
	}
}
async function profilePackage(profilePath, packageId) {
	const manifest = await readJson(resolve(profilePath, "node_modules", ...packageId.split("/"), "package.json"));
	if (manifest?.name !== packageId || typeof manifest.version !== "string") return void 0;
	try {
		const lock = await readFile(resolve(profilePath, "pnpm-lock.yaml"), "utf8");
		const locator = importerLocator(lock, packageId);
		const integrity = locator ? lockIntegrity(lock, packageId, locator) : void 0;
		return integrity ? {
			version: manifest.version,
			integrity
		} : void 0;
	} catch {
		return;
	}
}
async function registryIntegrity(registry, packageId, version, roots, signal) {
	const canonical = canonicalRegistryBase(registry, { allowLoopbackHttp: roots.allowLoopbackHttpRegistry });
	if (!canonical || canonical !== registry) return void 0;
	const response = await (roots.fetcher ?? fetch)(new URL(npmEscapedPackageName(packageId), canonical), {
		signal,
		headers: { accept: "application/json" },
		redirect: "error"
	});
	if (!response.ok) return void 0;
	const value = record(await response.json());
	const release = record(record(value?.versions)?.[version]);
	const dist = record(release?.dist);
	return value?.name === packageId && release?.name === packageId && release.version === version && typeof dist?.integrity === "string" ? dist.integrity : void 0;
}
function windowsBatchCommand(file, args) {
	const values = [file, ...args];
	if (values.some((value) => /[\0\r\n"%!^&|<>]/.test(value))) return void 0;
	return values.map((value) => `"${value}"`).join(" ");
}
async function windowsCommandInterpreter(signal) {
	const configured = process.env.ComSpec;
	const systemRoot = process.env.SystemRoot;
	if (!configured || !systemRoot || !isAbsolute(configured) || !isAbsolute(systemRoot) || basename(configured).toLowerCase() !== "cmd.exe" || /[\0\r\n"%!^&|<>]/.test(configured) || /[\0\r\n"%!^&|<>]/.test(systemRoot)) return void 0;
	try {
		const interpreterRealpath = await realpath(configured);
		const systemInterpreter = await realpath(resolve(systemRoot, "System32", "cmd.exe"));
		if (basename(interpreterRealpath).toLowerCase() !== "cmd.exe" || interpreterRealpath.toLowerCase() !== systemInterpreter.toLowerCase()) return void 0;
		const { stdout, stderr } = await execFileAsync(interpreterRealpath, [
			"/d",
			"/v:off",
			"/c",
			"ver"
		], {
			encoding: "utf8",
			signal,
			windowsHide: true
		});
		const interpreterVersion = `${stdout}${stderr}`.trim();
		return interpreterVersion && !/[\0\r\n]/.test(interpreterVersion) ? {
			interpreterRealpath,
			interpreterVersion
		} : void 0;
	} catch {
		return;
	}
}
async function execAuditedFile(file, args, options, interpreter) {
	if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(file)) {
		const command = windowsBatchCommand(file, args);
		if (!command || !interpreter) throw new Error("unsafe Windows batch invocation");
		return execFileAsync(interpreter.interpreterRealpath, [
			"/d",
			"/v:off",
			"/s",
			"/c",
			`"${command}"`
		], {
			...options,
			encoding: "utf8",
			windowsHide: true,
			windowsVerbatimArguments: true
		});
	}
	return execFileAsync(file, args, {
		...options,
		encoding: "utf8"
	});
}
async function runCommand(roots, identity, args, cwd, signal) {
	if (roots.commandRunner) return roots.commandRunner(identity.executable, args, cwd, signal);
	const interpreter = identity.interpreterRealpath && identity.interpreterVersion ? {
		interpreterRealpath: identity.interpreterRealpath,
		interpreterVersion: identity.interpreterVersion
	} : void 0;
	await execAuditedFile(identity.realpath, args, {
		...cwd ? { cwd } : {},
		signal,
		env: {
			...process.env,
			npm_config_cache: join(tmpdir(), "dsh-completion-guard-npm-cache")
		}
	}, interpreter);
}
function executableFor(action) {
	if ([
		"commit",
		"push",
		"pull",
		"fetch"
	].includes(action)) return "git";
	if (action === "install" || action === "apply") return "dsh";
	if (action === "publish") return "npm";
}
async function executableIdentity(executable, signal) {
	const suffixes = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
	for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) for (const suffix of suffixes) {
		const candidate = resolve(directory, `${executable}${suffix}`);
		try {
			await access(candidate, constants.X_OK);
			const canonical = await realpath(candidate);
			const interpreter = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(canonical) ? await windowsCommandInterpreter(signal) : void 0;
			if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(canonical) && !interpreter) continue;
			const { stdout, stderr } = await execAuditedFile(canonical, ["--version"], { signal }, interpreter);
			const version = `${stdout}${stderr}`.trim();
			if (version && !version.includes("\n") && !version.includes("\r")) return {
				executable,
				realpath: canonical,
				version,
				...interpreter
			};
		} catch {}
	}
}
async function executeGuardAction(action, resolution, roots, signal, executableIdentity$1, resolutionCallId, agent) {
	const target = resolution.target;
	if (action === "install" || action === "apply") {
		const tgzPath = requireString(resolution.commandManifest, "tgz_path");
		const identity = tgzPath ? await tgzIdentity(tgzPath) : void 0;
		if (!executableIdentity$1 || !tgzPath || !identity || identity.name !== target.package_id || identity.version !== target.version || identity.integrity !== target.integrity_digest || roots.profile?.name !== target.profile) return "unavailable";
		await runCommand(roots, executableIdentity$1, [
			"plugin",
			"--profile",
			roots.profile.name,
			"add",
			`file:${tgzPath}`
		], void 0, signal);
		return "completed";
	}
	if (action === "publish") {
		const tgzPath = requireString(resolution.commandManifest, "tgz_path");
		const identity = tgzPath ? await tgzIdentity(tgzPath) : void 0;
		const registry = typeof target.registry === "string" ? canonicalRegistryBase(target.registry, { allowLoopbackHttp: roots.allowLoopbackHttpRegistry }) : void 0;
		if (!executableIdentity$1 || !tgzPath || !identity || identity.name !== target.artifact_id || identity.version !== target.version || identity.integrity !== target.integrity_digest || !registry || registry !== target.registry) return "unavailable";
		await runCommand(roots, executableIdentity$1, [
			"publish",
			tgzPath,
			"--registry",
			registry,
			"--ignore-scripts"
		], void 0, signal);
		return "completed";
	}
	if (action === "restart") {
		const capabilities = await marketCapabilities(roots, signal);
		if (!capabilities || !roots.marketOrigin || !resolutionCallId || !agent) return "unavailable";
		if (capabilities.bootId !== target.pre_generation) return restartIntent(agent.session.events, resolutionCallId, target) ? "completed" : "unavailable";
		if (restartIntent(agent.session.events, resolutionCallId, target)) return "handoff_pending";
		if (!roots.persistRestartIntent || !await roots.persistRestartIntent(agent, {
			resolutionCallId,
			serviceId: String(target.service_id),
			preGeneration: String(target.pre_generation)
		})) return "unavailable";
		const response = await (roots.fetcher ?? fetch)(`${roots.marketOrigin}/dsh-market/api/v1/restart`, {
			method: "POST",
			signal,
			redirect: "error",
			headers: {
				accept: "application/json",
				"content-type": "application/json",
				origin: roots.marketOrigin
			},
			body: "{}"
		});
		if (!response.ok) return "unavailable";
		return record(await response.json())?.schema === MARKET_SCHEMA ? "handoff_pending" : "unavailable";
	}
	if (action === "commit" || action === "push" || action === "pull" || action === "fetch") {
		const binding = resolution.gitBinding;
		const repository = requireString(resolution.target, "repository");
		if (!executableIdentity$1 || !binding || !repository) return "unavailable";
		const targetIdentity = {
			repository,
			...typeof resolution.target.remote === "string" ? { remote: resolution.target.remote } : {},
			...typeof resolution.target.refspec === "string" ? { refspec: resolution.target.refspec } : {}
		};
		const current = await gitPrestate(binding.manifest, repository, signal, executableIdentity$1.realpath);
		if (!current) return "unavailable";
		if ((await executeRevalidatedGitEffect(binding.envelope, binding.manifest, targetIdentity, current, async (_file, argv, workingDirectory) => runCommand(roots, executableIdentity$1, argv, workingDirectory, signal))).status !== "executed") return "unavailable";
		if (action === "commit") {
			const commit = verifiedLinearCommitReadback(await gitBytes(repository, [
				"rev-list",
				"--parents",
				"-n",
				"1",
				"HEAD"
			], signal, executableIdentity$1.realpath), String(resolution.target.pre_head_oid ?? ""));
			const postTree = commit ? commitTreeSnapshotDigest(await gitBytes(repository, [
				"ls-tree",
				"-r",
				"-z",
				commit.postHeadOid
			], signal, executableIdentity$1.realpath)) : void 0;
			if (!commit || postTree !== resolution.target.change_set_digest) return "unavailable";
		} else if (action === "push") {
			const remoteOid = binding.manifest.remote && binding.manifest.destinationRef ? await exactRemoteOid(repository, binding.manifest.remote, binding.manifest.destinationRef, signal, executableIdentity$1.realpath) : void 0;
			if (!remoteOid || remoteOid !== resolution.target.local_oid) return "unavailable";
		} else {
			const upstream = String(resolution.target.upstream_oid ?? "");
			const trackingRef = binding.manifest.action === "fetch" ? binding.manifest.trackingRef : binding.manifest.remote && binding.manifest.sourceRef ? `refs/remotes/${binding.manifest.remote}/${binding.manifest.sourceRef.slice(11)}` : void 0;
			const tracking = trackingRef ? oid(await git(repository, [
				"rev-parse",
				"--verify",
				trackingRef
			], signal, executableIdentity$1.realpath)) : void 0;
			if (!tracking || tracking !== upstream) return "unavailable";
			if (action === "pull" && oid(await git(repository, ["rev-parse", "HEAD"], signal, executableIdentity$1.realpath)) !== upstream) return "unavailable";
			if (action === "fetch" && oid(await git(repository, ["rev-parse", "HEAD"], signal, executableIdentity$1.realpath)) !== resolution.target.pre_head_oid) return "unavailable";
		}
		return "completed";
	}
	return "unavailable";
}
async function gitBytes(repository, args, signal, file = "git") {
	const { stdout } = await execFileAsync(file, args, {
		cwd: repository,
		encoding: "buffer",
		signal,
		env: {
			...process.env,
			GIT_TERMINAL_PROMPT: "0"
		}
	});
	return Buffer.from(stdout);
}
async function git(repository, args, signal, file = "git") {
	return (await gitBytes(repository, args, signal, file)).toString("utf8").replace(/[\r\n]+$/, "");
}
function oid(value) {
	return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value) ? value.toLowerCase() : void 0;
}
async function exactRemoteOid(repository, remote, ref, signal, file = "git") {
	try {
		const line = await git(repository, [
			"ls-remote",
			"--exit-code",
			"--refs",
			remote,
			ref
		], signal, file);
		const match = /^([0-9a-f]{40}(?:[0-9a-f]{24})?)\t([^\r\n]+)$/i.exec(line);
		return match && match[2] === ref ? match[1].toLowerCase() : void 0;
	} catch {
		return;
	}
}
async function gitPrestate(manifest, repository, signal, file = "git") {
	if (manifest.action === "commit") {
		const head = oid(await git(repository, ["rev-parse", "HEAD"], signal, file));
		const branch = await git(repository, [
			"symbolic-ref",
			"--quiet",
			"HEAD"
		], signal, file);
		const index = commitIndexSnapshotDigest(await gitBytes(repository, [
			"ls-files",
			"--stage",
			"-z"
		], signal, file));
		return head && branch.startsWith("refs/heads/") && index ? {
			pre_head_oid: head,
			branch,
			index_digest: index
		} : void 0;
	}
	if (!manifest.remote || !manifest.sourceRef) return void 0;
	const upstream = await exactRemoteOid(repository, manifest.remote, manifest.sourceRef, signal, file);
	if (!upstream) return void 0;
	if (manifest.action === "push") {
		if (!manifest.destinationRef) return void 0;
		const source = oid(await git(repository, [
			"rev-parse",
			"--verify",
			manifest.sourceRef
		], signal, file));
		const destination = await exactRemoteOid(repository, manifest.remote, manifest.destinationRef, signal, file);
		return source && destination ? {
			source_oid: source,
			destination_oid: destination
		} : void 0;
	}
	if (manifest.action === "fetch") {
		if (!manifest.trackingRef) return void 0;
		const head = oid(await git(repository, ["rev-parse", "HEAD"], signal, file));
		let tracking = "absent";
		try {
			tracking = oid(await git(repository, [
				"rev-parse",
				"--verify",
				manifest.trackingRef
			], signal, file)) ?? "absent";
		} catch {}
		return head ? {
			upstream_oid: upstream,
			pre_head_oid: head,
			tracking_oid: tracking
		} : void 0;
	}
	if (manifest.action === "pull") {
		const head = oid(await git(repository, ["rev-parse", "HEAD"], signal, file));
		const trackingRef = `refs/remotes/${manifest.remote}/${manifest.sourceRef.slice(11)}`;
		let tracking = "absent";
		try {
			tracking = oid(await git(repository, [
				"rev-parse",
				"--verify",
				trackingRef
			], signal, file)) ?? "absent";
		} catch {}
		return head ? {
			upstream_oid: upstream,
			pre_head_oid: head,
			tracking_oid: tracking
		} : void 0;
	}
}
function requireString(row, key) {
	return typeof row[key] === "string" && row[key] ? row[key] : void 0;
}
function hasExactKeys(row, keys) {
	const actual = Object.keys(row).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function selectorHasOnlyCanonicalKeys(action, selector) {
	const allowed = new Set(ACTION_MANIFEST.actions[action].resolvedTargetKeys);
	return Object.keys(selector).every((key) => allowed.has(key));
}
function pickTarget(target, keys) {
	return Object.fromEntries(keys.filter((key) => Object.hasOwn(target, key)).map((key) => [key, target[key]]));
}
async function expectedTransitionForResolution(action, target, commandManifest) {
	let parameters;
	if (action === "create") {
		const plannedArguments = record(commandManifest.planned_arguments);
		const content = typeof plannedArguments?.content === "string" ? plannedArguments.content : void 0;
		if (content === void 0) return void 0;
		parameters = { post_digest: createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex") };
	} else if (action === "modify") {
		const plannedArguments = record(commandManifest.planned_arguments);
		const oldString = requireString(plannedArguments ?? {}, "old_string");
		const newString = typeof plannedArguments?.new_string === "string" ? plannedArguments.new_string : void 0;
		const artifact = typeof target.artifact_id === "string" ? target.artifact_id : void 0;
		if (!artifact || !oldString || newString === void 0) return void 0;
		let before;
		try {
			const beforeBytes = await readFile(artifact);
			const frozenPreDigest = typeof target.pre_digest === "string" ? target.pre_digest : void 0;
			if (!frozenPreDigest || createHash("sha256").update(beforeBytes).digest("hex") !== frozenPreDigest) return void 0;
			before = new TextDecoder("utf-8", { fatal: true }).decode(beforeBytes);
		} catch {
			return;
		}
		const first = before.indexOf(oldString);
		if (first < 0 || before.indexOf(oldString, first + oldString.length) >= 0) return void 0;
		const after = `${before.slice(0, first)}${newString}${before.slice(first + oldString.length)}`;
		parameters = { post_digest: createHash("sha256").update(Buffer.from(after, "utf8")).digest("hex") };
	} else if (action === "install" || action === "apply") parameters = pickTarget(target, [
		"package_id",
		"version",
		"integrity_digest",
		"profile"
	]);
	else if (action === "publish") parameters = pickTarget(target, [
		"artifact_id",
		"version",
		"registry",
		"integrity_digest"
	]);
	else if (action === "restart") parameters = {
		...pickTarget(target, ["pre_generation"]),
		health: "healthy"
	};
	else if (action === "commit") parameters = pickTarget(target, ["pre_head_oid", "change_set_digest"]);
	else if (action === "push") parameters = pickTarget(target, ["local_oid"]);
	else if (action === "pull") parameters = pickTarget(target, [
		"pull_mode",
		"upstream_oid",
		"pre_head_oid"
	]);
	else if (action === "fetch") parameters = pickTarget(target, ["upstream_oid", "pre_head_oid"]);
	else return;
	return {
		predicateId: ACTION_MANIFEST.actions[action].predicateId,
		version: 1,
		predParamsKind: "inline",
		parameters
	};
}
async function resolveTarget(action, selector, commandManifest, cwd, roots, signal, executableIdentity$1) {
	if (!selectorHasOnlyCanonicalKeys(action, selector)) return void 0;
	const planned = plannedEffectDigest(commandManifest);
	const plannedCall = plannedEffect(commandManifest);
	if (action === "install" || action === "apply") {
		const packageId = requireString(selector, "package_id");
		const profile = requireString(selector, "profile");
		const trustedProfile = roots.profile;
		const tgzPath = requireString(commandManifest, "tgz_path");
		const manifestId = action === "install" ? "dsh.plugin_add_tgz.install.v1" : "dsh.plugin_add_tgz.apply.v1";
		if (!hasExactKeys(commandManifest, ["manifest_id", "tgz_path"]) || !packageId || !profile || profile !== trustedProfile?.name || commandManifest.manifest_id !== manifestId || !ACTION_MANIFEST.actions[action].commandManifestIds.includes(manifestId) || !tgzPath) return void 0;
		const identity = await tgzIdentity(tgzPath);
		if (!identity || identity.name !== packageId || selector.version !== void 0 && selector.version !== identity.version) return void 0;
		const installed = await profilePackage(trustedProfile.path, packageId);
		if (action === "install" && installed) return void 0;
		if (action === "apply" && (!installed || installed.version === identity.version && installed.integrity === identity.integrity)) return void 0;
		return { target: {
			package_id: packageId,
			version: identity.version,
			integrity_digest: identity.integrity,
			profile
		} };
	}
	if (action === "restart") {
		const service = requireString(selector, "service_id");
		if (service !== "dsh-web" || commandManifest.manifest_id !== "dshmarket.restart.v1" || !ACTION_MANIFEST.actions.restart.commandManifestIds.includes("dshmarket.restart.v1") || Object.keys(commandManifest).length !== 1) return void 0;
		const capabilities = await marketCapabilities(roots, signal);
		const features = record(capabilities?.features);
		const restart = record(capabilities?.restart);
		if (features?.restart !== true || restart?.supported !== true || restart.managedBy !== "market") return void 0;
		return { target: {
			service_id: service,
			pre_generation: String(capabilities?.bootId)
		} };
	}
	if (action === "publish") {
		const registry = canonicalRegistryBase(requireString(selector, "registry") ?? "", { allowLoopbackHttp: roots.allowLoopbackHttpRegistry });
		const tgzPath = requireString(commandManifest, "tgz_path");
		if (!hasExactKeys(commandManifest, ["manifest_id", "tgz_path"]) || !registry || commandManifest.manifest_id !== "npm.publish_tgz.v1" || !ACTION_MANIFEST.actions.publish.commandManifestIds.includes("npm.publish_tgz.v1") || !tgzPath) return void 0;
		const identity = await tgzIdentity(tgzPath);
		if (!identity || identity.name !== selector.artifact_id || identity.version !== selector.version) return void 0;
		return { target: {
			artifact_id: identity.name,
			version: identity.version,
			registry,
			integrity_digest: identity.integrity
		} };
	}
	if (action === "create" || action === "modify") {
		if (!hasExactKeys(commandManifest, ["planned_tool", "planned_arguments"]) || !plannedCall) return void 0;
		const allowedArgs = action === "create" ? ["file_path", "content"] : [
			"file_path",
			"old_string",
			"new_string"
		];
		if (!hasExactKeys(plannedCall.arguments, allowedArgs)) return void 0;
		const artifact = pathOf(selector, cwd);
		if (!artifact || !planned) return void 0;
		const pre = await fileDigest(artifact);
		if (action === "create" && pre !== "absent") return void 0;
		if (action === "modify" && pre === "absent") return void 0;
		return { target: {
			artifact_id: artifact,
			scope: dirname(artifact),
			pre_digest: pre,
			change_set_digest: planned
		} };
	}
	const repository = requireString(selector, "repository");
	if (!repository || repository !== cwd && !isAbsolute(repository) || !plannedCall || !hasExactKeys(commandManifest, ["planned_tool", "planned_arguments"]) || executableIdentity$1?.executable !== "git") return void 0;
	const manifest = plannedGitManifest(action, selector, plannedCall);
	if (!manifest || !ACTION_MANIFEST.actions[action].commandManifestIds.includes(manifest.manifestId)) return void 0;
	const targetIdentity = {
		repository,
		...manifest.remote ? { remote: manifest.remote } : {},
		...requireString(selector, "refspec") ? { refspec: requireString(selector, "refspec") } : {}
	};
	const prestate = await gitPrestate(manifest, repository, signal, executableIdentity$1.realpath);
	if (!prestate) return void 0;
	const envelope = createGitPrestateEnvelope(manifest, targetIdentity, prestate);
	if (action === "commit") {
		if (!hasExactKeys(selector, ["repository", "branch"])) return void 0;
		const branch = requireString(selector, "branch");
		if (!branch || prestate.branch !== `refs/heads/${branch}`) return void 0;
		return {
			target: {
				repository,
				branch,
				change_set_digest: prestate.index_digest,
				pre_head_oid: prestate.pre_head_oid
			},
			gitBinding: {
				manifest,
				prestate,
				envelope
			}
		};
	}
	if (!hasExactKeys(selector, [
		"repository",
		"remote",
		"refspec"
	])) return void 0;
	const remote = requireString(selector, "remote");
	const refspec = requireString(selector, "refspec");
	if (!remote || !refspec) return void 0;
	let target;
	if (action === "push") target = {
		repository,
		remote,
		refspec,
		local_oid: prestate.source_oid
	};
	else if (action === "fetch") target = {
		repository,
		remote,
		refspec,
		upstream_oid: prestate.upstream_oid,
		pre_head_oid: prestate.pre_head_oid
	};
	else target = {
		repository,
		remote,
		refspec,
		upstream_oid: prestate.upstream_oid,
		pre_head_oid: prestate.pre_head_oid,
		pull_mode: "ff-only"
	};
	return {
		target,
		gitBinding: {
			manifest,
			prestate,
			envelope
		}
	};
}
function effectMatches(action, resolution, effect) {
	const resolvedTarget = resolution.target;
	if (action !== "create" && action !== "modify") return false;
	const expectedNames = action === "create" ? ["write", "write_file"] : ["edit", "edit_file"];
	if (effect.error !== void 0 || effect.resultSeq < effect.callSeq || !expectedNames.includes(effect.name)) return false;
	const parsed = evidenceFromPersistedToolResult({
		callId: "effect-readback",
		name: effect.name,
		arguments: JSON.stringify(effect.arguments)
	}, {
		seq: effect.resultSeq,
		error: effect.error,
		meta: effect.meta,
		textContent: effect.textContent
	}, 0, "effect-readback", typeof effect.arguments.workdir === "string" ? effect.arguments.workdir : void 0);
	if (parsed.outcome !== "success" || parsed.parseStatus !== "supported") return false;
	if (effectDigest(effect) !== resolvedTarget.change_set_digest && (action === "create" || action === "modify")) return false;
	if (effectDigest(effect) !== plannedEffectDigest(resolution.commandManifest)) return false;
	return true;
}
async function readback(action, target, roots, signal, executableIdentity$1) {
	if (action === "install" || action === "apply") {
		const packageId = typeof target.package_id === "string" ? target.package_id : void 0;
		const profile = typeof target.profile === "string" ? target.profile : void 0;
		const trustedProfile = roots.profile;
		if (!packageId || !profile || profile !== trustedProfile?.name) return void 0;
		const installed = await profilePackage(trustedProfile.path, packageId);
		return installed ? {
			package_id: packageId,
			version: installed.version,
			integrity_digest: installed.integrity,
			profile
		} : void 0;
	}
	if (action === "restart") {
		const capabilities = await marketCapabilities(roots, signal);
		if (!capabilities || capabilities.bootId === target.pre_generation) return void 0;
		return {
			new_generation: String(capabilities.bootId),
			health: "healthy"
		};
	}
	if (action === "publish") {
		const registry = typeof target.registry === "string" ? target.registry : void 0;
		const artifact = typeof target.artifact_id === "string" ? target.artifact_id : void 0;
		const version = typeof target.version === "string" ? target.version : void 0;
		if (!registry || !artifact || !version) return void 0;
		const integrity = await registryIntegrity(registry, artifact, version, roots, signal);
		return integrity ? {
			artifact_id: artifact,
			version,
			registry,
			integrity_digest: integrity
		} : void 0;
	}
	if (action === "create" || action === "modify") {
		const artifact = typeof target.artifact_id === "string" ? target.artifact_id : void 0;
		if (!artifact) return void 0;
		const post = await fileDigest(artifact);
		return post === "absent" ? void 0 : { post_digest: post };
	}
	const repository = typeof target.repository === "string" ? target.repository : void 0;
	if (!repository || executableIdentity$1?.executable !== "git") return void 0;
	if (action === "commit") {
		const commit = verifiedLinearCommitReadback(await gitBytes(repository, [
			"rev-list",
			"--parents",
			"-n",
			"1",
			"HEAD"
		], signal, executableIdentity$1.realpath), String(target.pre_head_oid ?? ""));
		const tree = commit ? commitTreeSnapshotDigest(await gitBytes(repository, [
			"ls-tree",
			"-r",
			"-z",
			commit.postHeadOid
		], signal, executableIdentity$1.realpath)) : void 0;
		return commit && tree === target.change_set_digest ? {
			post_head_oid: commit.postHeadOid,
			pre_head_oid: commit.preHeadOid
		} : void 0;
	}
	const remote = String(target.remote ?? "");
	const parsed = String(target.refspec ?? "").split(":");
	if (action === "push") {
		if (parsed.length !== 2) return void 0;
		const remoteOid = await exactRemoteOid(repository, remote, parsed[1], signal, executableIdentity$1.realpath);
		return remoteOid ? { remote_oid: remoteOid } : void 0;
	}
	const sourceRef = parsed[0];
	const trackingRef = action === "fetch" ? parsed[1] : sourceRef.startsWith("refs/heads/") ? `refs/remotes/${remote}/${sourceRef.slice(11)}` : void 0;
	if (!trackingRef) return void 0;
	const tracking = oid(await git(repository, [
		"rev-parse",
		"--verify",
		trackingRef
	], signal, executableIdentity$1.realpath));
	if (!tracking) return void 0;
	const postHead = oid(await git(repository, ["rev-parse", "HEAD"], signal, executableIdentity$1.realpath));
	if (action === "fetch") return postHead ? {
		tracking_ref_oid: tracking,
		post_head_oid: postHead
	} : void 0;
	return postHead ? {
		post_head_oid: postHead,
		tracking_ref_oid: tracking
	} : void 0;
}
function normalizedRoots(options) {
	const detectedProfile = options.profile ? void 0 : installedProfile();
	return {
		...options.profile ? { profile: {
			name: options.profile.name,
			path: resolve(options.profile.path)
		} } : detectedProfile ? { profile: detectedProfile } : {},
		...options.marketOrigin ? { marketOrigin: options.marketOrigin } : {},
		...options.fetcher ? { fetcher: options.fetcher } : {},
		...options.commandRunner ? { commandRunner: options.commandRunner } : {},
		...options.persistRestartIntent ? { persistRestartIntent: options.persistRestartIntent } : {},
		...options.hostCapability ? { hostCapability: options.hostCapability } : {},
		...options.authorizeMutation ? { authorizeMutation: options.authorizeMutation } : {},
		...options.prepareMutation ? { prepareMutation: options.prepareMutation } : {},
		...options.readExecutableIdentity ? { readExecutableIdentity: options.readExecutableIdentity } : {},
		...options.allowLoopbackHttpRegistry ? { allowLoopbackHttpRegistry: true } : {}
	};
}
function createActionTool(options = {}) {
	const roots = normalizedRoots(options);
	return defineTool({
		name: ACTION_TOOL,
		description: "Execute one explicit Guard-owned mutation after re-reading a persisted resolution and exact target digest. This tool changes package, Git, registry, or Web service state; its result echoes the bounded target and command-manifest digest.",
		parameters: {
			semantic_action: {
				type: "string",
				required: true,
				enum: [
					"install",
					"apply",
					"restart",
					"publish",
					"commit",
					"push",
					"pull",
					"fetch"
				]
			},
			resolution_call_id: {
				type: "string",
				required: true
			},
			target_digest: {
				type: "string",
				required: true
			},
			contract_item_id: {
				type: "string",
				required: true
			},
			contract_item_revision: {
				type: "number",
				required: true
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					status: {
						type: "string",
						required: true,
						enum: [
							"completed",
							"handoff_pending",
							"unavailable"
						]
					},
					reason_code: {
						type: "string",
						required: true
					},
					resolved_target: {
						type: "object",
						required: true,
						additionalProperties: true
					},
					target_digest: {
						type: "string",
						required: true
					},
					command_manifest_digest: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value)
			}],
			presentationMeta: (args, value) => ({ contextGuardAction: {
				status: value.status,
				reasonCode: value.reason_code,
				resolvedTarget: value.resolved_target,
				targetDigest: value.target_digest,
				commandManifestDigest: value.command_manifest_digest,
				contractItemId: args.contract_item_id,
				contractItemRevision: args.contract_item_revision
			} })
		},
		async execute(args, exec) {
			const action = args.semantic_action;
			const agent = exec.agent;
			const empty = {
				resolved_target: {},
				target_digest: "",
				command_manifest_digest: ""
			};
			if (!agent || ![
				"install",
				"apply",
				"restart",
				"publish",
				"commit",
				"push",
				"pull",
				"fetch"
			].includes(action)) return {
				status: "unavailable",
				reason_code: "action_adapter_unavailable",
				...empty
			};
			if (roots.hostCapability?.(action).status !== "supported" && roots.hostCapability) return {
				status: "unavailable",
				reason_code: "host_capability_unavailable",
				...empty
			};
			let durable = false;
			try {
				durable = await roots.prepareMutation?.(agent) === true;
			} catch {
				durable = false;
			}
			if (!durable) return {
				status: "unavailable",
				reason_code: "mutation_durability_unavailable",
				...empty
			};
			const resolution = findResolution(agent.session.events, args.resolution_call_id, action);
			if (!resolution) return {
				status: "unavailable",
				reason_code: "resolution_evidence_missing",
				...empty
			};
			const targetDigest = digest(resolution.target);
			const manifestDigest = digest(resolution.commandManifest);
			const identity = {
				resolved_target: jsonTuple(resolution.target),
				target_digest: targetDigest,
				command_manifest_digest: manifestDigest
			};
			if (args.target_digest !== targetDigest) return {
				status: "unavailable",
				reason_code: "target_digest_mismatch",
				...identity
			};
			let authorization;
			try {
				authorization = roots.authorizeMutation?.({
					action,
					contractItemId: args.contract_item_id,
					contractItemRevision: args.contract_item_revision,
					resolvedTarget: resolution.target
				});
			} catch {
				authorization = void 0;
			}
			if (authorization?.status !== "authorized") return {
				status: "unavailable",
				reason_code: authorization?.reasonCode ?? "mutation_authority_unavailable",
				...identity
			};
			const executable = executableFor(action);
			let currentExecutable;
			if (executable) {
				currentExecutable = await (roots.readExecutableIdentity ?? executableIdentity)(executable, exec.signal);
				if (bindExecutableIdentity(resolution.executableIdentity, currentExecutable).status !== "supported") return {
					status: "unavailable",
					reason_code: "executable_identity_drift",
					...identity
				};
			}
			try {
				const status = await executeGuardAction(action, resolution, roots, exec.signal, currentExecutable, args.resolution_call_id, agent);
				return {
					status,
					reason_code: status === "completed" ? "action_completed" : status === "handoff_pending" ? "restart_handoff_pending" : "action_execution_failed",
					...identity
				};
			} catch {
				return {
					status: "unavailable",
					reason_code: "action_execution_failed",
					...identity
				};
			}
		}
	});
}
function createEvidenceTool(options = {}) {
	const roots = normalizedRoots(options);
	return defineTool({
		name: PRODUCER_TOOL,
		description: "Create one trusted stateful resolution/effect/state fact from the live resource and persisted DSH tool events. Unsupported adapters fail closed.",
		parameters: {
			semantic_action: {
				type: "string",
				required: true,
				enum: [
					"install",
					"apply",
					"create",
					"modify",
					"restart",
					"commit",
					"push",
					"publish",
					"pull",
					"fetch"
				]
			},
			evidence_role: {
				type: "string",
				required: true,
				enum: [
					"resolution",
					"effect",
					"state"
				]
			},
			selector: {
				type: "object",
				additionalProperties: false,
				properties: {
					artifact_id: { type: "string" },
					package_id: { type: "string" },
					version: { type: "string" },
					profile: { type: "string" },
					registry: { type: "string" },
					service_id: { type: "string" },
					repository: { type: "string" },
					branch: { type: "string" },
					remote: { type: "string" },
					refspec: { type: "string" }
				}
			},
			command_manifest: {
				type: "object",
				additionalProperties: false,
				properties: {
					manifest_id: { type: "string" },
					tgz_path: { type: "string" },
					planned_tool: { type: "string" },
					planned_arguments: {
						type: "object",
						additionalProperties: false,
						properties: {
							file_path: { type: "string" },
							content: { type: "string" },
							old_string: { type: "string" },
							new_string: { type: "string" },
							command: { type: "string" },
							workdir: { type: "string" }
						}
					}
				}
			},
			resolution_call_id: { type: "string" },
			effect_call_id: { type: "string" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					status: {
						type: "string",
						required: true,
						enum: ["supported", "unavailable"]
					},
					reason_code: {
						type: "string",
						required: true
					},
					semantic_action: {
						type: "string",
						required: true
					},
					evidence_role: {
						type: "string",
						required: true,
						enum: [
							"resolution",
							"effect",
							"state"
						]
					},
					resolved_target: {
						type: "object",
						required: true,
						additionalProperties: true
					},
					observed_state: {
						type: "object",
						required: true,
						additionalProperties: true
					},
					adapter_id: {
						type: "string",
						required: true
					},
					adapter_version: {
						type: "string",
						required: true
					},
					target_digest: {
						type: "string",
						required: true
					},
					command_manifest_digest: {
						type: "string",
						required: true
					},
					expected_transition: {
						type: "object",
						additionalProperties: false,
						properties: {
							predicateId: {
								type: "string",
								required: true
							},
							version: {
								type: "number",
								required: true
							},
							predParamsKind: {
								type: "string",
								required: true,
								enum: ["inline"]
							},
							parameters: {
								type: "object",
								required: true,
								additionalProperties: true
							}
						}
					},
					expected_transition_digest: { type: "string" },
					git_binding: {
						type: "object",
						additionalProperties: true
					},
					executable_identity: {
						type: "object",
						additionalProperties: false,
						properties: {
							executable: {
								type: "string",
								required: true
							},
							realpath: {
								type: "string",
								required: true
							},
							version: {
								type: "string",
								required: true
							},
							interpreterRealpath: { type: "string" },
							interpreterVersion: { type: "string" }
						}
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value)
			}],
			presentationMeta: (_args, value) => {
				if (value.status !== "supported") return { contextGuardDisposition: {
					status: value.status,
					reasonCode: value.reason_code
				} };
				return { contextGuard: {
					adapterId: value.adapter_id,
					adapterVersion: value.adapter_version,
					semanticAction: value.semantic_action,
					evidenceRole: value.evidence_role,
					resolvedTarget: value.resolved_target,
					targetDigest: value.target_digest,
					commandManifestDigest: value.command_manifest_digest,
					...value.expected_transition ? {
						expectedTransition: value.expected_transition,
						expectedTransitionDigest: value.expected_transition_digest
					} : {},
					...value.git_binding ? { gitBinding: value.git_binding } : {},
					...value.executable_identity ? { executableIdentity: value.executable_identity } : {},
					...value.evidence_role === "state" ? { observedState: value.observed_state } : {}
				} };
			}
		},
		async execute(args, exec) {
			const action = args.semantic_action;
			const role = args.evidence_role;
			if (!SUPPORTED.includes(action)) return unavailable(action, role, "adapter_unavailable_for_pinned_host");
			if (roots.hostCapability?.(action).status !== "supported" && roots.hostCapability) return unavailable(action, role, "host_capability_unavailable");
			const agent = exec.agent;
			if (!agent) return unavailable(action, role, "producer_agent_unavailable");
			try {
				if (role === "resolution") {
					const executable$1 = executableFor(action);
					const executableBinding = executable$1 ? await (roots.readExecutableIdentity ?? executableIdentity)(executable$1, exec.signal) : void 0;
					if (executable$1 && !executableBinding) return unavailable(action, role, "executable_identity_unavailable");
					const resolved = await resolveTarget(action, record(args.selector) ?? {}, record(args.command_manifest) ?? {}, cwdOf(agent), roots, exec.signal, executableBinding);
					if (!resolved) return unavailable(action, role, "resolution_unavailable");
					const gitBinding = resolved.gitBinding ? JSON.parse(JSON.stringify(resolved.gitBinding)) : void 0;
					const commandManifest = record(args.command_manifest) ?? {};
					const expectedTransition = await expectedTransitionForResolution(action, resolved.target, commandManifest);
					if (!expectedTransition) return unavailable(action, role, "expected_transition_unavailable");
					return supported(action, role, resolved.target, {}, commandManifest, gitBinding, executableBinding, expectedTransition);
				}
				if (!args.resolution_call_id) return unavailable(action, role, "producer_reference_missing");
				const resolution = findResolution(agent.session.events, args.resolution_call_id, action);
				if (!resolution) return unavailable(action, role, "persisted_effect_mismatch");
				const executable = executableFor(action);
				let currentExecutable;
				if (executable) {
					currentExecutable = await (roots.readExecutableIdentity ?? executableIdentity)(executable, exec.signal);
					if (bindExecutableIdentity(resolution.executableIdentity, currentExecutable).status !== "supported") return unavailable(action, role, "executable_identity_drift");
				}
				const ownedEffect = [
					"install",
					"apply",
					"restart",
					"publish",
					"commit",
					"push",
					"pull",
					"fetch"
				].includes(action);
				if (!args.effect_call_id) return unavailable(action, role, "producer_reference_missing");
				if (ownedEffect) {
					const actionCall = actionCallMatches(agent.session.events, args.effect_call_id, action, args.resolution_call_id, resolution.target);
					if (!(action === "restart" ? actionCall && restartIntent(agent.session.events, args.resolution_call_id, resolution.target) && (await marketCapabilities(roots, exec.signal))?.bootId !== resolution.target.pre_generation : actionCall && actionResultCompleted(agent.session.events, args.effect_call_id))) return unavailable(action, role, "persisted_effect_mismatch");
					if (role === "effect") return supported(action, role, resolution.target, {}, resolution.commandManifest, void 0, currentExecutable);
				} else {
					const effect = findEffect(agent.session.events, args.effect_call_id);
					if (!effect || !effectMatches(action, resolution, effect)) return unavailable(action, role, "persisted_effect_mismatch");
					if (role === "effect") return supported(action, role, resolution.target, {}, resolution.commandManifest, void 0, currentExecutable);
				}
				const observed = await readback(action, resolution.target, roots, exec.signal, currentExecutable);
				return observed ? supported(action, role, resolution.target, observed, resolution.commandManifest, void 0, currentExecutable) : unavailable(action, role, "independent_readback_unavailable");
			} catch {
				return unavailable(action, role, "adapter_readback_failed");
			}
		}
	});
}

//#endregion
//#region src/tools/external-operation.ts
function createExternalOperationTool(read, capability) {
	return defineTool({
		name: "context_guard_external_operation",
		description: "Read a live background operation from the pinned jobs capability and mint a bounded external-wait qualification. Text output never controls status.",
		parameters: { operation_id: {
			type: "string",
			required: true
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					status: {
						type: "string",
						required: true,
						enum: [
							"running",
							"pending",
							"completed",
							"failed",
							"unknown"
						]
					},
					operation_id: {
						type: "string",
						required: true
					},
					reason_code: {
						type: "string",
						required: true
					},
					adapter_id: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value)
			}],
			presentationMeta: (_args, value) => {
				return { contextGuardExternalOperation: {
					id: value.operation_id,
					status: value.status,
					adapterId: value.adapter_id
				} };
			}
		},
		execute(args, exec) {
			if (capability().status !== "supported") return Promise.resolve({
				status: "unknown",
				operation_id: args.operation_id,
				reason_code: "host_jobs_capability_unavailable",
				adapter_id: "dsh.jobs.v1"
			});
			const snapshot = read(args.operation_id, exec.agent);
			return Promise.resolve(snapshot ? {
				status: snapshot.status,
				operation_id: snapshot.id,
				reason_code: "external_operation_readback",
				adapter_id: snapshot.adapterId
			} : {
				status: "unknown",
				operation_id: args.operation_id,
				reason_code: "external_operation_unavailable",
				adapter_id: "dsh.jobs.v1"
			});
		}
	});
}

//#endregion
//#region src/commands/context-guard.ts
function pendingCount(projection) {
	return [...projection.items.values()].filter((item) => item.status === "pending").length;
}
function createContextGuardCommand(projectionFor, setEnabled, clearContract) {
	return {
		name: "context-guard",
		description: "Enable, disable, clear, inspect, or diagnose Context Guard for this session.",
		recordInput: true,
		input: { hint: "on|off|clear|status|diagnose" },
		handler: ({ agent, rawInput }) => {
			const projection = projectionFor(agent);
			const [subcommand] = rawInput.trim().split(/\s+/, 1);
			const resolved = subcommand || "status";
			if (resolved === "on") {
				setEnabled(agent, true);
				return {
					kind: "success",
					text: "Context Guard enabled."
				};
			}
			if (resolved === "off") {
				setEnabled(agent, false);
				return {
					kind: "success",
					text: "Context Guard disabled; history retained."
				};
			}
			if (resolved === "clear") {
				const before = pendingCount(projection);
				clearContract(agent);
				const after = pendingCount(projectionFor(agent));
				return {
					kind: "success",
					text: `Context Guard contract cleared: ${before - after} requirement/acceptance item(s) superseded; ${after} pending remain (prohibitions retained).`
				};
			}
			if (resolved !== "status" && resolved !== "diagnose") return {
				kind: "error",
				text: "Usage: /context-guard on|off|clear|status|diagnose"
			};
			const passed = [...projection.items.values()].filter((item) => item.status === "passed").length;
			const response = {
				enabled: projection.enabled,
				epoch: projection.epoch,
				contract_revision: projection.contractRevision,
				pending: pendingCount(projection),
				passed,
				evidence: projection.evidence.size,
				integrity: projection.integrity,
				last_source_seq: projection.lastObservedSourceSeq
			};
			return {
				kind: "success",
				text: JSON.stringify(response)
			};
		}
	};
}

//#endregion
//#region node_modules/.pnpm/@deepseek-ai+cosmokit@1.8.2/node_modules/@deepseek-ai/cosmokit/lib/index.js
/** Return true when a value is `null` or `undefined`. */
function isNullable(value) {
	return value === null || value === void 0;
}
/** Return true for non-array object values. */
function isPlainObject(data) {
	return data && typeof data === "object" && !Array.isArray(data);
}
/** Filter object entries and return a new object. */
function filterKeys(object, filter) {
	return Object.fromEntries(Object.entries(object).filter(([key, value]) => filter(key, value)));
}
/** Map object values while preserving the original key set. */
function mapValues(object, transform) {
	return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, transform(value, key)]));
}
/** Pick selected keys from an object, optionally including `undefined` values. */
function pick(source, keys, forced) {
	if (!keys) return { ...source };
	const result = {};
	for (const key of keys) if (forced || source[key] !== void 0) result[key] = source[key];
	return result;
}
/** Test values using `instanceof` with a `toStringTag` fallback. */
function is(type, value) {
	if (arguments.length === 1) return (value$1) => is(type, value$1);
	return type in globalThis && value instanceof globalThis[type] || Object.prototype.toString.call(value).slice(8, -1) === type;
}
function isArrayBufferLike(value) {
	return is("ArrayBuffer", value) || is("SharedArrayBuffer", value);
}
function isArrayBufferSource(value) {
	return isArrayBufferLike(value) || ArrayBuffer.isView(value);
}
/** Binary source detection and base64/hex conversion helpers. */
var Binary;
(function(Binary$1) {
	Binary$1.is = isArrayBufferLike;
	Binary$1.isSource = isArrayBufferSource;
	function fromSource(source) {
		if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
		else return source;
	}
	Binary$1.fromSource = fromSource;
	function toBase64(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("base64");
		let binary = "";
		const bytes = new Uint8Array(source);
		for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
		return btoa(binary);
	}
	Binary$1.toBase64 = toBase64;
	function fromBase64(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "base64"));
		return Uint8Array.from(atob(source), (c) => c.charCodeAt(0));
	}
	Binary$1.fromBase64 = fromBase64;
	function toHex(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("hex");
		return Array.from(new Uint8Array(source), (byte) => byte.toString(16).padStart(2, "0")).join("");
	}
	Binary$1.toHex = toHex;
	function fromHex(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "hex"));
		const hex = source.length % 2 === 0 ? source : source.slice(0, source.length - 1);
		const buffer = [];
		for (let i = 0; i < hex.length; i += 2) buffer.push(parseInt(`${hex[i]}${hex[i + 1]}`, 16));
		return Uint8Array.from(buffer).buffer;
	}
	Binary$1.fromHex = fromHex;
})(Binary || (Binary = {}));
/** Decode a base64 string into binary data. */
const base64ToArrayBuffer = Binary.fromBase64;
/** Encode binary data as base64. */
const arrayBufferToBase64 = Binary.toBase64;
/** Decode a hex string into binary data. */
const hexToArrayBuffer = Binary.fromHex;
/** Encode binary data as hex. */
const arrayBufferToHex = Binary.toHex;
/** Deep-clone common JavaScript values while preserving prototypes and cycles. */
function clone(source, refs = /* @__PURE__ */ new Map()) {
	if (!source || typeof source !== "object") return source;
	if (is("Date", source)) return new Date(source.valueOf());
	if (is("RegExp", source)) return new RegExp(source.source, source.flags);
	if (isArrayBufferLike(source)) return source.slice(0);
	if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
	const cached = refs.get(source);
	if (cached) return cached;
	if (Array.isArray(source)) {
		const result$1 = [];
		refs.set(source, result$1);
		source.forEach((value, index) => {
			result$1[index] = Reflect.apply(clone, null, [value, refs]);
		});
		return result$1;
	}
	const result = Object.create(Object.getPrototypeOf(source));
	refs.set(source, result);
	for (const key of Reflect.ownKeys(source)) {
		const descriptor = { ...Reflect.getOwnPropertyDescriptor(source, key) };
		if ("value" in descriptor) descriptor.value = Reflect.apply(clone, null, [descriptor.value, refs]);
		Reflect.defineProperty(result, key, descriptor);
	}
	return result;
}
/** Deeply compare arrays, dates, regexps, buffers, and plain object fields. */
function deepEqual(a, b, strict) {
	if (a === b) return true;
	if (!strict && isNullable(a) && isNullable(b)) return true;
	if (typeof a !== typeof b) return false;
	if (typeof a !== "object") return false;
	if (!a || !b) return false;
	function check(test, then) {
		return test(a) ? test(b) ? then(a, b) : false : test(b) ? false : void 0;
	}
	return check(Array.isArray, (a$1, b$1) => a$1.length === b$1.length && a$1.every((item, index) => deepEqual(item, b$1[index]))) ?? check(is("Date"), (a$1, b$1) => a$1.valueOf() === b$1.valueOf()) ?? check(is("RegExp"), (a$1, b$1) => a$1.source === b$1.source && a$1.flags === b$1.flags) ?? check(isArrayBufferLike, (a$1, b$1) => {
		if (a$1.byteLength !== b$1.byteLength) return false;
		const viewA = new Uint8Array(a$1);
		const viewB = new Uint8Array(b$1);
		for (let i = 0; i < viewA.length; i++) if (viewA[i] !== viewB[i]) return false;
		return true;
	}) ?? Object.keys({
		...a,
		...b
	}).every((key) => deepEqual(a[key], b[key], strict));
}
/** Time constants plus parsing and formatting helpers. */
var Time;
(function(Time$1) {
	Time$1.millisecond = 1;
	Time$1.second = 1e3;
	Time$1.minute = Time$1.second * 60;
	Time$1.hour = Time$1.minute * 60;
	Time$1.day = Time$1.hour * 24;
	Time$1.week = Time$1.day * 7;
	let timezoneOffset = (/* @__PURE__ */ new Date()).getTimezoneOffset();
	function setTimezoneOffset(offset) {
		timezoneOffset = offset;
	}
	Time$1.setTimezoneOffset = setTimezoneOffset;
	function getTimezoneOffset() {
		return timezoneOffset;
	}
	Time$1.getTimezoneOffset = getTimezoneOffset;
	function getDateNumber(date = /* @__PURE__ */ new Date(), offset) {
		if (typeof date === "number") date = new Date(date);
		if (offset === void 0) offset = timezoneOffset;
		return Math.floor((date.valueOf() / Time$1.minute - offset) / 1440);
	}
	Time$1.getDateNumber = getDateNumber;
	function fromDateNumber(value, offset) {
		const date = new Date(value * Time$1.day);
		if (offset === void 0) offset = timezoneOffset;
		return new Date(+date + offset * Time$1.minute);
	}
	Time$1.fromDateNumber = fromDateNumber;
	const numeric = /\d+(?:\.\d+)?/.source;
	const timeRegExp = /* @__PURE__ */ new RegExp(`^${[
		"w(?:eek(?:s)?)?",
		"d(?:ay(?:s)?)?",
		"h(?:our(?:s)?)?",
		"m(?:in(?:ute)?(?:s)?)?",
		"s(?:ec(?:ond)?(?:s)?)?"
	].map((unit) => `(${numeric}${unit})?`).join("")}$`);
	function parseTime(source) {
		const capture = timeRegExp.exec(source);
		if (!capture) return 0;
		return (parseFloat(capture[1]) * Time$1.week || 0) + (parseFloat(capture[2]) * Time$1.day || 0) + (parseFloat(capture[3]) * Time$1.hour || 0) + (parseFloat(capture[4]) * Time$1.minute || 0) + (parseFloat(capture[5]) * Time$1.second || 0);
	}
	Time$1.parseTime = parseTime;
	function parseDate(date) {
		const parsed = parseTime(date);
		if (parsed) date = Date.now() + parsed;
		else if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).toLocaleDateString()}-${date}`;
		else if (/^\d{1,2}-\d{1,2}-\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).getFullYear()}-${date}`;
		return date ? new Date(date) : /* @__PURE__ */ new Date();
	}
	Time$1.parseDate = parseDate;
	function format(ms) {
		const abs = Math.abs(ms);
		if (abs >= Time$1.day - Time$1.hour / 2) return Math.round(ms / Time$1.day) + "d";
		else if (abs >= Time$1.hour - Time$1.minute / 2) return Math.round(ms / Time$1.hour) + "h";
		else if (abs >= Time$1.minute - Time$1.second / 2) return Math.round(ms / Time$1.minute) + "m";
		else if (abs >= Time$1.second) return Math.round(ms / Time$1.second) + "s";
		return ms + "ms";
	}
	Time$1.format = format;
	function toDigits(source, length = 2) {
		return source.toString().padStart(length, "0");
	}
	Time$1.toDigits = toDigits;
	function template(template$1, time = /* @__PURE__ */ new Date()) {
		return template$1.replace("yyyy", time.getFullYear().toString()).replace("yy", time.getFullYear().toString().slice(2)).replace("MM", toDigits(time.getMonth() + 1)).replace("dd", toDigits(time.getDate())).replace("hh", toDigits(time.getHours())).replace("mm", toDigits(time.getMinutes())).replace("ss", toDigits(time.getSeconds())).replace("SSS", toDigits(time.getMilliseconds(), 3));
	}
	Time$1.template = template;
})(Time || (Time = {}));

//#endregion
//#region node_modules/.pnpm/@deepseek-ai+schemastery@3.18.1/node_modules/@deepseek-ai/schemastery/lib/index.mjs
const kSchema = Symbol.for("schemastery");
const kValidationError = Symbol.for("ValidationError");
globalThis.__schemastery_index__ ??= 0;
globalThis.__schemastery_refs__ = void 0;
var ValidationError = class extends TypeError {
	options;
	name = "ValidationError";
	constructor(message, options) {
		let prefix = "$";
		for (const segment of options.path || []) if (typeof segment === "string") prefix += "." + segment;
		else if (typeof segment === "number") prefix += "[" + segment + "]";
		else if (typeof segment === "symbol") prefix += `[Symbol(${segment.toString()})]`;
		if (prefix.startsWith(".")) prefix = prefix.slice(1);
		super((prefix === "$" ? "" : `${prefix} `) + message);
		this.options = options;
	}
	static is(error) {
		return !!error?.[kValidationError];
	}
};
Object.defineProperty(ValidationError.prototype, kValidationError, { value: true });
const Schema = function(options) {
	const schema = function(data, options$1 = {}) {
		return Schema.resolve(data, schema, options$1)[0];
	};
	if (options.refs) {
		const refs = mapValues(options.refs, (options$1) => new Schema(options$1));
		const getRef = (uid) => refs[uid];
		for (const key in refs) {
			const options$1 = refs[key];
			options$1.sKey = getRef(options$1.sKey);
			options$1.inner = getRef(options$1.inner);
			options$1.list = options$1.list && options$1.list.map(getRef);
			options$1.dict = options$1.dict && mapValues(options$1.dict, getRef);
		}
		return refs[options.uid];
	}
	Object.assign(schema, options);
	if (typeof schema.callback === "string") try {
		schema.callback = new Function("return " + schema.callback)();
	} catch {}
	Object.defineProperty(schema, "uid", { value: globalThis.__schemastery_index__++ });
	Object.setPrototypeOf(schema, Schema.prototype);
	schema.meta ||= {};
	schema.toString = schema.toString.bind(schema);
	return schema;
};
Schema.prototype = Object.create(Function.prototype);
Schema.prototype[kSchema] = true;
Object.defineProperty(Schema.prototype, "~standard", { get() {
	return {
		version: 1,
		vendor: "schemastery",
		validate: (value) => {
			try {
				return { value: Schema.resolve(value, this, {})[0] };
			} catch (error) {
				if (ValidationError.is(error)) return { issues: [{
					message: error.message,
					path: error.options.path
				}] };
				throw error;
			}
		}
	};
} });
Schema.ValidationError = ValidationError;
Schema.prototype.toJSON = function toJSON() {
	if (globalThis.__schemastery_refs__) {
		globalThis.__schemastery_refs__[this.uid] ??= JSON.parse(JSON.stringify({ ...this }));
		return this.uid;
	}
	globalThis.__schemastery_refs__ = { [this.uid]: { ...this } };
	globalThis.__schemastery_refs__[this.uid] = JSON.parse(JSON.stringify({ ...this }));
	const result = {
		uid: this.uid,
		refs: globalThis.__schemastery_refs__
	};
	globalThis.__schemastery_refs__ = void 0;
	return result;
};
Schema.prototype.set = function set(key, value) {
	this.dict[key] = value;
	return this;
};
Schema.prototype.push = function push(value) {
	this.list.push(value);
	return this;
};
function mergeDesc(original, messages) {
	const result = typeof original === "string" ? { "": original } : { ...original };
	for (const locale in messages) {
		const value = messages[locale];
		if (value?.$description || value?.$desc) result[locale] = value.$description || value.$desc;
		else if (typeof value === "string") result[locale] = value;
	}
	return result;
}
function getInner(value) {
	return value?.$value ?? value?.$inner;
}
function extractKeys(data) {
	return filterKeys(data ?? {}, (key) => !key.startsWith("$"));
}
Schema.prototype.i18n = function i18n(messages) {
	const schema = Schema(this);
	const desc = mergeDesc(schema.meta.description, messages);
	if (Object.keys(desc).length) schema.meta.description = desc;
	if (schema.dict) schema.dict = mapValues(schema.dict, (inner, key) => {
		return inner.i18n(mapValues(messages, (data) => getInner(data)?.[key] ?? data?.[key]));
	});
	if (schema.list) schema.list = schema.list.map((inner, index) => {
		return inner.i18n(mapValues(messages, (data = {}) => {
			if (Array.isArray(getInner(data))) return getInner(data)[index];
			if (Array.isArray(data)) return data[index];
			return extractKeys(data);
		}));
	});
	if (schema.inner) schema.inner = schema.inner.i18n(mapValues(messages, (data) => {
		if (getInner(data)) return getInner(data);
		return extractKeys(data);
	}));
	if (schema.sKey) schema.sKey = schema.sKey.i18n(mapValues(messages, (data) => data?.$key));
	return schema;
};
Schema.prototype.extra = function extra(key, value) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
};
for (const key of [
	"required",
	"disabled",
	"collapse",
	"hidden",
	"loose"
]) Object.assign(Schema.prototype, { [key](value = true) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
} });
Schema.prototype.deprecated = function deprecated() {
	const schema = Schema(this);
	schema.meta.badges ||= [];
	schema.meta.badges.push({
		text: "deprecated",
		type: "danger"
	});
	return schema;
};
Schema.prototype.experimental = function experimental() {
	const schema = Schema(this);
	schema.meta.badges ||= [];
	schema.meta.badges.push({
		text: "experimental",
		type: "warning"
	});
	return schema;
};
Schema.prototype.pattern = function pattern(regexp) {
	const schema = Schema(this);
	const pattern$1 = pick(regexp, ["source", "flags"]);
	schema.meta = {
		...schema.meta,
		pattern: pattern$1
	};
	return schema;
};
Schema.prototype.simplify = function simplify(value) {
	if (deepEqual(value, this.meta.default, this.type === "dict")) return null;
	if (isNullable(value)) return value;
	if (this.type === "object" || this.type === "dict") {
		const result = {};
		for (const key in value) {
			const item = (this.type === "object" ? this.dict[key] : this.inner)?.simplify(value[key]);
			if (this.type === "dict" || !isNullable(item)) result[key] = item;
		}
		if (deepEqual(result, this.meta.default, this.type === "dict")) return null;
		return result;
	} else if (this.type === "array" || this.type === "tuple") {
		const result = [];
		value.forEach((value$1, index) => {
			const schema = this.type === "array" ? this.inner : this.list[index];
			const item = schema ? schema.simplify(value$1) : value$1;
			result.push(item);
		});
		return result;
	} else if (this.type === "intersect") {
		const result = {};
		for (const item of this.list) Object.assign(result, item.simplify(value));
		return result;
	} else if (this.type === "union") for (const schema of this.list) try {
		Schema.resolve(value, schema, {});
		return schema.simplify(value);
	} catch {}
	return value;
};
Schema.prototype.toString = function toString(inline) {
	return formatters[this.type]?.(this, inline) ?? `Schema<${this.type}>`;
};
Schema.prototype.role = function role(role$1, extra) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		role: role$1,
		extra
	};
	return schema;
};
for (const key of [
	"default",
	"link",
	"comment",
	"description",
	"max",
	"min",
	"step"
]) Object.assign(Schema.prototype, { [key](value) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
} });
const resolvers = {};
Schema.extend = function extend(type, resolve$1) {
	resolvers[type] = resolve$1;
};
Schema.resolve = function resolve$1(data, schema, options = {}, strict = false) {
	if (!schema) return [data];
	if (options.ignore?.(data, schema)) return [data];
	if (isNullable(data) && schema.type !== "lazy") {
		if (schema.meta.required) throw new ValidationError(`missing required value`, options);
		let current = schema;
		let fallback = schema.meta.default;
		while (current?.type === "intersect" && isNullable(fallback)) {
			current = current.list[0];
			fallback = current?.meta.default;
		}
		if (isNullable(fallback)) return [data];
		data = clone(fallback);
	}
	const callback = resolvers[schema.type];
	if (!callback) throw new ValidationError(`unsupported type "${schema.type}"`, options);
	try {
		return callback(data, schema, options, strict);
	} catch (error) {
		if (!schema.meta.loose) throw error;
		return [schema.meta.default];
	}
};
Schema.from = function from(source) {
	if (isNullable(source)) return Schema.any();
	else if ([
		"string",
		"number",
		"boolean"
	].includes(typeof source)) return Schema.const(source).required();
	else if (source[kSchema]) return source;
	else if (typeof source === "function") switch (source) {
		case String: return Schema.string().required();
		case Number: return Schema.number().required();
		case Boolean: return Schema.boolean().required();
		case Function: return Schema.function().required();
		default: return Schema.is(source).required();
	}
	else throw new TypeError(`cannot infer schema from ${source}`);
};
Schema.lazy = function lazy(builder) {
	const toJSON = () => {
		if (!schema.inner[kSchema]) {
			schema.inner = schema.builder();
			schema.inner.meta = {
				...schema.meta,
				...schema.inner.meta
			};
		}
		return schema.inner.toJSON();
	};
	const schema = new Schema({
		type: "lazy",
		builder,
		inner: { toJSON }
	});
	return schema;
};
Schema.natural = function natural() {
	return Schema.number().step(1).min(0);
};
Schema.percent = function percent() {
	return Schema.number().step(.01).min(0).max(1).role("slider");
};
Schema.date = function date() {
	return Schema.union([Schema.is(Date), Schema.transform(Schema.string().role("datetime"), (value, options) => {
		const date$1 = new Date(value);
		if (isNaN(+date$1)) throw new ValidationError(`invalid date "${value}"`, options);
		return date$1;
	}, true)]);
};
Schema.regExp = function regExp(flag = "") {
	return Schema.union([Schema.is(RegExp), Schema.transform(Schema.string().role("regexp", { flag }), (value, options) => {
		try {
			return new RegExp(value, flag);
		} catch (e) {
			throw new ValidationError(e.message, options);
		}
	}, true)]);
};
Schema.arrayBuffer = function arrayBuffer(encoding) {
	return Schema.union([
		Schema.is(ArrayBuffer),
		Schema.is(SharedArrayBuffer),
		Schema.transform(Schema.any(), (value, options) => {
			if (Binary.isSource(value)) return Binary.fromSource(value);
			throw new ValidationError(`expected ArrayBufferSource but got ${value}`, options);
		}, true),
		...encoding ? [Schema.transform(Schema.string(), (value, options) => {
			try {
				return encoding === "base64" ? Binary.fromBase64(value) : Binary.fromHex(value);
			} catch (e) {
				throw new ValidationError(e.message, options);
			}
		}, true)] : []
	]);
};
Schema.extend("lazy", (data, schema, options, strict) => {
	if (!schema.inner[kSchema]) {
		schema.inner = schema.builder();
		schema.inner.meta = {
			...schema.meta,
			...schema.inner.meta
		};
	}
	return Schema.resolve(data, schema.inner, options, strict);
});
Schema.extend("any", (data) => {
	return [data];
});
Schema.extend("never", (data, _, options) => {
	throw new ValidationError(`expected nullable but got ${data}`, options);
});
Schema.extend("const", (data, { value }, options) => {
	if (deepEqual(data, value)) return [value];
	throw new ValidationError(`expected ${value} but got ${data}`, options);
});
function checkWithinRange(data, meta, description, options, skipMin = false) {
	const { max = Infinity, min = -Infinity } = meta;
	if (data > max) throw new ValidationError(`expected ${description} <= ${max} but got ${data}`, options);
	if (data < min && !skipMin) throw new ValidationError(`expected ${description} >= ${min} but got ${data}`, options);
}
Schema.extend("string", (data, { meta }, options) => {
	if (typeof data !== "string") throw new ValidationError(`expected string but got ${data}`, options);
	if (meta.pattern) {
		const regexp = new RegExp(meta.pattern.source, meta.pattern.flags);
		if (!regexp.test(data)) throw new ValidationError(`expect string to match regexp ${regexp}`, options);
	}
	checkWithinRange(data.length, meta, "string length", options);
	return [data];
});
function decimalShift(data, digits) {
	const str = data.toString();
	if (str.includes("e")) return data * Math.pow(10, digits);
	const index = str.indexOf(".");
	if (index === -1) return data * Math.pow(10, digits);
	const frac = str.slice(index + 1);
	const integer = str.slice(0, index);
	if (frac.length <= digits) return +(integer + frac.padEnd(digits, "0"));
	return +(integer + frac.slice(0, digits) + "." + frac.slice(digits));
}
function isMultipleOf(data, min, step) {
	step = Math.abs(step);
	if (!/^\d+\.\d+$/.test(step.toString())) return (data - min) % step === 0;
	const index = step.toString().indexOf(".");
	const digits = step.toString().slice(index + 1).length;
	return Math.abs(decimalShift(data, digits) - decimalShift(min, digits)) % decimalShift(step, digits) === 0;
}
Schema.extend("number", (data, { meta }, options) => {
	if (typeof data !== "number") throw new ValidationError(`expected number but got ${data}`, options);
	checkWithinRange(data, meta, "number", options);
	const { step } = meta;
	if (step && !isMultipleOf(data, meta.min ?? 0, step)) throw new ValidationError(`expected number multiple of ${step} but got ${data}`, options);
	return [data];
});
Schema.extend("boolean", (data, _, options) => {
	if (typeof data === "boolean") return [data];
	throw new ValidationError(`expected boolean but got ${data}`, options);
});
Schema.extend("bitset", (data, { bits, meta }, options) => {
	let value = 0, keys = [];
	if (typeof data === "number") {
		value = data;
		for (const key in bits) if (data & bits[key]) keys.push(key);
	} else if (Array.isArray(data)) {
		keys = data;
		for (const key of keys) {
			if (typeof key !== "string") throw new ValidationError(`expected string but got ${key}`, options);
			if (key in bits) value |= bits[key];
		}
	} else throw new ValidationError(`expected number or array but got ${data}`, options);
	if (value === meta.default) return [value];
	return [value, keys];
});
Schema.extend("function", (data, _, options) => {
	if (typeof data === "function") return [data];
	throw new ValidationError(`expected function but got ${data}`, options);
});
Schema.extend("is", (data, { constructor }, options) => {
	if (typeof constructor === "function") {
		if (data instanceof constructor) return [data];
		throw new ValidationError(`expected ${constructor.name} but got ${data}`, options);
	} else {
		if (isNullable(data)) throw new ValidationError(`expected ${constructor} but got ${data}`, options);
		let prototype = Object.getPrototypeOf(data);
		while (prototype) {
			if (prototype.constructor?.name === constructor) return [data];
			prototype = Object.getPrototypeOf(prototype);
		}
		throw new ValidationError(`expected ${constructor} but got ${data}`, options);
	}
});
function property(data, key, schema, options) {
	try {
		const [value, adapted] = Schema.resolve(data[key], schema, {
			...options,
			path: [...options.path || [], key]
		});
		if (adapted !== void 0) data[key] = adapted;
		return value;
	} catch (e) {
		if (!options?.autofix) throw e;
		delete data[key];
		return schema.meta.default;
	}
}
Schema.extend("array", (data, { inner, meta }, options) => {
	if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
	checkWithinRange(data.length, meta, "array length", options, !isNullable(inner.meta.default));
	return [data.map((_, index) => property(data, index, inner, options))];
});
Schema.extend("dict", (data, { inner, sKey }, options, strict) => {
	if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
	const result = {};
	for (const key in data) {
		let rKey;
		try {
			rKey = Schema.resolve(key, sKey, options)[0];
		} catch (error) {
			if (strict) continue;
			throw error;
		}
		result[rKey] = property(data, key, inner, options);
		data[rKey] = data[key];
		if (key !== rKey) delete data[key];
	}
	return [result];
});
Schema.extend("tuple", (data, { list }, options, strict) => {
	if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
	const result = list.map((inner, index) => property(data, index, inner, options));
	if (strict) return [result];
	result.push(...data.slice(list.length));
	return [result];
});
function merge(result, data) {
	for (const key in data) {
		if (key in result) continue;
		result[key] = data[key];
	}
}
Schema.extend("object", (data, { dict }, options, strict) => {
	if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
	const result = {};
	for (const key in dict) {
		const value = property(data, key, dict[key], options);
		if (!isNullable(value) || key in data) result[key] = value;
	}
	if (!strict) merge(result, data);
	return [result];
});
Schema.extend("union", (data, { list, toString }, options, strict) => {
	const messages = [];
	for (const inner of list) try {
		return Schema.resolve(data, inner, options, strict);
	} catch (error) {
		messages.push(error);
	}
	throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
});
Schema.extend("intersect", (data, { list, toString }, options, strict) => {
	if (!list.length) return [data];
	let result;
	for (const inner of list) {
		const value = Schema.resolve(data, inner, options, true)[0];
		if (isNullable(value)) continue;
		if (isNullable(result)) result = value;
		else if (typeof result !== typeof value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
		else if (typeof value === "object") merge(result ??= {}, value);
		else if (result !== value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
	}
	if (!strict && isPlainObject(data)) merge(result, data);
	return [result];
});
Schema.extend("transform", (data, { inner, callback, preserve }, options) => {
	const [result, adapted = data] = Schema.resolve(data, inner, options, true);
	if (preserve) return [callback(result)];
	else return [callback(result), callback(adapted)];
});
const formatters = {};
function defineMethod(name$1, keys, format) {
	formatters[name$1] = format;
	Object.assign(Schema, { [name$1](...args) {
		const schema = new Schema({ type: name$1 });
		keys.forEach((key, index) => {
			switch (key) {
				case "sKey":
					schema.sKey = args[index] ?? Schema.string();
					break;
				case "inner":
					schema.inner = Schema.from(args[index]);
					break;
				case "list":
					schema.list = args[index].map(Schema.from);
					break;
				case "dict":
					schema.dict = mapValues(args[index], Schema.from);
					break;
				case "bits":
					schema.bits = {};
					for (const key$1 in args[index]) {
						if (typeof args[index][key$1] !== "number") continue;
						schema.bits[key$1] = args[index][key$1];
					}
					break;
				case "callback": {
					const callback = schema.callback = args[index];
					callback["toJSON"] ||= () => callback.toString();
					break;
				}
				case "constructor": {
					const constructor = schema.constructor = args[index];
					if (typeof constructor === "function") constructor["toJSON"] ||= () => constructor["name"];
					break;
				}
				default: schema[key] = args[index];
			}
		});
		if (name$1 === "object" || name$1 === "dict") schema.meta.default = {};
		else if (name$1 === "array" || name$1 === "tuple") schema.meta.default = [];
		else if (name$1 === "bitset") schema.meta.default = 0;
		return schema;
	} });
}
defineMethod("is", ["constructor"], ({ constructor }) => {
	if (typeof constructor === "function") return constructor.name;
	else return constructor;
});
defineMethod("any", [], () => "any");
defineMethod("never", [], () => "never");
defineMethod("const", ["value"], ({ value }) => typeof value === "string" ? JSON.stringify(value) : value);
defineMethod("string", [], () => "string");
defineMethod("number", [], () => "number");
defineMethod("boolean", [], () => "boolean");
defineMethod("bitset", ["bits"], () => "bitset");
defineMethod("function", [], () => "function");
defineMethod("array", ["inner"], ({ inner }) => `${inner.toString(true)}[]`);
defineMethod("dict", ["inner", "sKey"], ({ inner, sKey }) => `{ [key: ${sKey.toString()}]: ${inner.toString()} }`);
defineMethod("tuple", ["list"], ({ list }) => `[${list.map((inner) => inner.toString()).join(", ")}]`);
defineMethod("object", ["dict"], ({ dict }) => {
	if (Object.keys(dict).length === 0) return "{}";
	return `{ ${Object.entries(dict).map(([key, inner]) => {
		return `${key}${inner.meta.required ? "" : "?"}: ${inner.toString()}`;
	}).join(", ")} }`;
});
defineMethod("union", ["list"], ({ list }, inline) => {
	const result = list.map(({ toString: format }) => format()).join(" | ");
	return inline ? `(${result})` : result;
});
defineMethod("intersect", ["list"], ({ list }) => {
	return `${list.map((inner) => inner.toString(true)).join(" & ")}`;
});
defineMethod("transform", [
	"inner",
	"callback",
	"preserve"
], ({ inner }, isInner) => inner.toString(isInner));

//#endregion
//#region src/config.ts
const Config = Schema.object({
	activation: Schema.string().default("opt-in"),
	hostLockPlatform: Schema.string(),
	hostLockProfile: Schema.string(),
	hostLockPackages: Schema.array(Schema.object({
		name: Schema.string().required(),
		version: Schema.string(),
		integrity: Schema.string()
	}))
});
function resolveConfig(config) {
	const activation = config.activation ?? "opt-in";
	if (activation !== "opt-in" && activation !== "always") throw new TypeError(`activation must be "opt-in" or "always", received ${JSON.stringify(activation)}`);
	let hostLockPackages;
	if (config.hostLockPackages !== void 0) {
		if (!Array.isArray(config.hostLockPackages)) throw new TypeError("hostLockPackages must be an array");
		hostLockPackages = config.hostLockPackages.map((entry) => {
			if (!entry || typeof entry !== "object") throw new TypeError("hostLockPackages entries must be objects");
			const row = entry;
			if (typeof row.name !== "string" || !row.name) throw new TypeError("hostLockPackages.name must be a non-empty string");
			if (row.version !== void 0 && typeof row.version !== "string") throw new TypeError("hostLockPackages.version must be a string");
			if (row.integrity !== void 0 && typeof row.integrity !== "string") throw new TypeError("hostLockPackages.integrity must be a string");
			return {
				name: row.name,
				...row.version ? { version: row.version } : {},
				...row.integrity ? { integrity: row.integrity } : {}
			};
		});
	}
	if (config.hostLockPlatform !== void 0 && config.hostLockPlatform !== "posix" && config.hostLockPlatform !== "windows") throw new TypeError("hostLockPlatform must be \"posix\" or \"windows\"");
	if (config.hostLockProfile !== void 0 && config.hostLockProfile !== "headless" && config.hostLockProfile !== "web") throw new TypeError("hostLockProfile must be \"headless\" or \"web\"");
	const hasHostRows = hostLockPackages !== void 0;
	if (hasHostRows !== (config.hostLockPlatform !== void 0) || hasHostRows !== (config.hostLockProfile !== void 0)) throw new TypeError("hostLockPackages, hostLockPlatform, and hostLockProfile must be injected together");
	return {
		activation,
		...hostLockPackages ? { hostLockPackages } : {},
		...config.hostLockPlatform ? { hostLockPlatform: config.hostLockPlatform } : {},
		...config.hostLockProfile ? { hostLockProfile: config.hostLockProfile } : {}
	};
}

//#endregion
//#region src/runtime.ts
const name = "context-guard";
const inject = ["sessions", "commands"];
/**
* Bind an explicit mutation to one live root-owned contract item. Resolution
* evidence is intentionally not authority: every effect rechecks the current
* projection immediately before any command, HTTP request, or durable intent.
*/
function authorizeMutationFromProjection(projection, request) {
	if (!projection.enabled) return {
		status: "denied",
		reasonCode: "mutation_guard_disabled"
	};
	if (projection.integrity !== "valid") return {
		status: "denied",
		reasonCode: "mutation_integrity_unavailable"
	};
	if (projection.hostStatus !== "supported") return {
		status: "denied",
		reasonCode: "mutation_host_lock_unavailable"
	};
	const item = projection.items.get(request.contractItemId);
	if (!item) return {
		status: "denied",
		reasonCode: "mutation_contract_item_missing"
	};
	if (!Number.isSafeInteger(request.contractItemRevision) || item.revision !== request.contractItemRevision) return {
		status: "denied",
		reasonCode: "mutation_contract_item_revision_mismatch"
	};
	if (item.status !== "pending") return {
		status: "denied",
		reasonCode: "mutation_contract_item_not_pending"
	};
	if (item.kind !== "requirement" || item.verification.enforced !== true) return {
		status: "denied",
		reasonCode: "mutation_contract_item_not_authorizing"
	};
	if (item.authority !== "root_instruction" && item.authority !== "root_adoption") return {
		status: "denied",
		reasonCode: "mutation_root_authority_unavailable"
	};
	if (item.legacyFlags?.length) return {
		status: "denied",
		reasonCode: "mutation_legacy_rebind_required"
	};
	if (item.semanticAction !== request.action) return {
		status: "denied",
		reasonCode: "mutation_semantic_action_mismatch"
	};
	if (item.targetCaptureStatus !== "resolved") return {
		status: "denied",
		reasonCode: "mutation_target_clarification_required"
	};
	if (!requestedTargetAuthorizesMutation(request.action, item.requestedTarget, request.resolvedTarget)) return {
		status: "denied",
		reasonCode: "mutation_requested_target_mismatch"
	};
	if ([...projection.items.values()].some((candidate) => candidate.status === "pending" && candidate.kind === "prohibition" && (candidate.authority === "root_instruction" || candidate.authority === "root_adoption") && !candidate.legacyFlags?.length && candidate.semanticAction === request.action && requestedTargetMatchesResolved(request.action, candidate.requestedTarget, request.resolvedTarget))) return {
		status: "denied",
		reasonCode: "mutation_conflicting_prohibition"
	};
	return {
		status: "authorized",
		reasonCode: "mutation_root_contract_authorized"
	};
}
const PROTOCOL_CORRECTION_NOTICE = "Context Guard protocol correction: root-authorized work remains pending; continue with tools or obtain a typed boundary.";
/** Production Stop boundary: durable replay first, then immutable/live checks. */
async function handleGuardTurnStopping(agent, runtime, access$1) {
	const durable = await access$1.flush();
	runtime.setDurability(durable);
	runtime.sync();
	if (!durable) return "boundary_flush_failed";
	const decision = decideTurnBoundary(runtime.projection);
	if (decision.action === "continue") {
		agent.steer(createUserMessage({
			content: [{
				type: "text",
				text: PROTOCOL_CORRECTION_NOTICE
			}],
			source: {
				kind: "plugin",
				plugin: "context-guard",
				form: "notice",
				summary: boundContextSummary("requesting the one allowed protocol correction step")
			}
		}));
		return decision.reason ?? "protocol_correction_steer";
	}
	if (decision.reason !== "accepted_boundary_pending_effectuation") return decision.reason ?? "safe_yield_pending_preserved";
	const boundary = runtime.projection.boundaries.at(-1);
	if (!boundary || !isCurrentAcceptedBoundary(runtime.projection, boundary)) return "boundary_candidate_stale";
	if (boundary.goalRef && (!access$1.goalAccess || !access$1.hostSupported)) {
		runtime.projection.integrity = "unknown";
		runtime.projection.integrityViolations.push("boundary_host_lock_unsupported");
		return "boundary_host_lock_unsupported";
	}
	const requalify = boundary.disposition === "external_wait" ? async () => access$1.externalWaitCapability?.status === "supported" && boundary.qualificationIds.every((id) => {
		const row = access$1.readExternalOperation(id);
		return row?.status === "running" || row?.status === "pending";
	}) : void 0;
	const effect = await effectuateBoundary(boundary, {
		...access$1.goalAccess ?? {
			get: async () => void 0,
			disarm: async () => void 0
		},
		...requalify ? { requalify } : {}
	});
	if (effect.resumeRequired) {
		runtime.projection.integrity = "unknown";
		runtime.projection.integrityViolations.push(effect.reasonCode);
	}
	return effect.reasonCode;
}
function createHostCapabilityEvaluator(hostLock) {
	return (action) => evaluateHostCapability(hostLock, { action });
}
function sessionHeaderForDigest(session) {
	const raw = session.header;
	if (!raw || typeof raw.version !== "number" || typeof raw.id !== "string" || typeof raw.createdAt !== "number") return void 0;
	return {
		version: raw.version,
		id: raw.id,
		createdAt: raw.createdAt,
		...typeof raw.parentSession === "string" ? { parentSession: raw.parentSession } : {},
		...typeof raw.seedLength === "number" ? { seedLength: raw.seedLength } : {},
		...typeof raw.agentPreset === "string" ? { agentPreset: raw.agentPreset } : {},
		...typeof raw.origin === "string" ? { origin: raw.origin } : {},
		...typeof raw.delegationDepth === "number" ? { delegationDepth: raw.delegationDepth } : {}
	};
}
function createRuntime(agent, config, hostLock = DEFAULT_HOST_LOCK, readGoalState) {
	const projection = createProjection();
	const session = agent.session;
	let pendingRecovery = false;
	let durabilityConfirmed = false;
	let observedEpoch = -1;
	let observedCompactionSeq = -1;
	const continuationAttempts = projection.continuationAttempts;
	const persistenceCorrectionAttempts = projection.persistenceCorrectionAttempts;
	const rebuild = () => {
		const header = session.header;
		const priorRecoveryDigest = projection.lastRecoveryDigest;
		const derived = deriveProjection(session.events, { activation: config.activation }, {
			cwd: typeof header?.cwd === "string" ? header.cwd : "",
			sessionHeader: sessionHeaderForDigest(session)
		}, durabilityConfirmed, hostLock);
		Object.assign(projection, derived.projection);
		if (readGoalState) try {
			const state = normalizeGoalState(readGoalState());
			if (state && projection.currentGoalRef?.id === state.id && projection.currentGoalRef.revision === state.revision) {
				projection.currentGoalPhase = state.phase;
				projection.currentGoalActivation = state.activation;
			}
		} catch {
			projection.integrity = "unknown";
			projection.integrityViolations.push("goal_readback_unavailable");
		}
		projection.continuationAttempts = continuationAttempts;
		projection.persistenceCorrectionAttempts = persistenceCorrectionAttempts;
		projection.lastRecoveryDigest = priorRecoveryDigest;
		if (observedEpoch >= 0 && derived.projection.epoch > observedEpoch) {
			pendingRecovery = true;
			projection.lastRecoveryDigest = void 0;
		}
		observedEpoch = derived.projection.epoch;
		if (derived.lastCompactionSeq > observedCompactionSeq) {
			pendingRecovery = true;
			observedCompactionSeq = derived.lastCompactionSeq;
		}
	};
	const sync = () => {
		rebuild();
	};
	const setEnabled = (_enabled) => {
		rebuild();
	};
	const setDurability = (confirmed) => {
		durabilityConfirmed = confirmed;
	};
	const markRecoveryNeeded = () => {
		pendingRecovery = true;
	};
	const consumeRecovery = () => {
		const was = pendingRecovery;
		pendingRecovery = false;
		return was;
	};
	rebuild();
	return {
		projection,
		session,
		sync,
		setEnabled,
		setDurability,
		markRecoveryNeeded,
		consumeRecovery
	};
}
function apply(ctx, rawConfig = {}) {
	const config = resolveConfig(rawConfig);
	const installedHostLock = evaluateHostLock(config.hostLockPackages ?? [], {
		platform: config.hostLockPlatform,
		profileKind: config.hostLockProfile
	});
	const runtimes = /* @__PURE__ */ new Map();
	const hostLocks = /* @__PURE__ */ new Map();
	const registeredAgents = /* @__PURE__ */ new WeakSet();
	const ensure = (agent) => {
		let runtime = runtimes.get(agent);
		if (!runtime) {
			const goals = optionalGoalService(ctx, agent);
			const agentHostLock = bindLiveGoalCapability(installedHostLock, Boolean(goals) && hasPinnedUpdateGoalTool(agent));
			runtime = createRuntime(agent, config, agentHostLock, goals ? () => goals.get(agent) : void 0);
			runtimes.set(agent, runtime);
			hostLocks.set(agent, agentHostLock);
		}
		return runtime;
	};
	ctx.commands.register(createContextGuardCommand((agent) => ensure(agent).projection, (agent, enabled) => ensure(agent).setEnabled(enabled), (agent) => ensure(agent).sync()));
	ctx.on("agent/session-start", ({ agent, source }) => {
		ensureProtocolBoundary(agent);
		const runtime = ensure(agent);
		runtime.sync();
		if (source === "resume" || source === "compact") {
			runtime.projection.lastRecoveryDigest = void 0;
			runtime.markRecoveryNeeded();
		}
		if (registeredAgents.has(agent)) return;
		registeredAgents.add(agent);
		agent.ctx.tools.register(createCheckpointTool(() => runtime.projection, () => runtime.markRecoveryNeeded(), async () => {
			const durable = await ctx.sessions.flush(agent.session);
			runtime.setDurability(durable);
			runtime.sync();
			return durable;
		}));
		agent.ctx.tools.register(createBoundaryTool(() => runtime.projection, async () => {
			const durable = await ctx.sessions.flush(agent.session);
			runtime.setDurability(durable);
			runtime.sync();
			return durable;
		}, () => runtime.markRecoveryNeeded()));
		const evidenceOptions = {
			hostCapability: createHostCapabilityEvaluator(hostLocks.get(agent) ?? installedHostLock),
			prepareMutation: async (toolAgent) => {
				if (toolAgent.session !== agent.session) return false;
				const durable = await ctx.sessions.flush(agent.session);
				runtime.setDurability(durable);
				runtime.sync();
				return durable;
			},
			authorizeMutation: (request) => {
				runtime.sync();
				return authorizeMutationFromProjection(runtime.projection, request);
			},
			marketOrigin: optionalMarketOrigin(ctx, agent),
			persistRestartIntent: async (toolAgent, intent) => {
				const session = toolAgent.session;
				session.append.bind(session)("user/message", createUserMessage({
					content: [{
						type: "text",
						text: `${RESTART_INTENT_PREFIX}${JSON.stringify({
							resolution_call_id: intent.resolutionCallId,
							service_id: intent.serviceId,
							pre_generation: intent.preGeneration
						})}`
					}],
					source: {
						kind: "plugin",
						plugin: "context-guard",
						form: "notice",
						summary: boundContextSummary("persisting a restart handoff intent")
					}
				}), { surfaceOp: "append" });
				const durable = await ctx.sessions.flush(session);
				runtime.setDurability(durable);
				runtime.sync();
				return durable;
			}
		};
		agent.ctx.tools.register(createEvidenceTool(evidenceOptions));
		agent.ctx.tools.register(createActionTool(evidenceOptions));
		agent.ctx.tools.register(createExternalOperationTool((id, toolAgent) => readExternalOperation(ctx, toolAgent, id), () => evaluateExternalWaitCapability(hostLocks.get(agent) ?? installedHostLock)));
		agent.ctx.tools.guard((exec) => goalCompletionDenial(runtime.projection, exec.name, exec.arguments));
	});
	ctx.on("agent/pre-step", async ({ agent }, next) => {
		const durability = await ctx.sessions.flush(agent.session);
		const runtime = ensure(agent);
		runtime.setDurability(durability);
		runtime.sync();
		const decision = await next();
		if (decision.kind === "enter" && runtime.projection.enabled && runtime.consumeRecovery()) {
			const recovery = renderRecoveryPacket(runtime.projection, { charBudget: 4e3 });
			const digest$1 = recovery ? recoveryDigest(recovery, runtime.projection) : void 0;
			if (recovery && digest$1 !== runtime.projection.lastRecoveryDigest) {
				runtime.projection.lastRecoveryDigest = digest$1;
				decision.messages = [...decision.messages, createUserMessage({
					content: [{
						type: "text",
						text: `Open task requirements (recovered after compaction or resume):\n${recovery}`
					}],
					source: {
						kind: "plugin",
						plugin: "context-guard",
						form: "notice",
						summary: boundContextSummary("recovering open task requirements")
					}
				})];
			}
		}
		return decision;
	});
	ctx.on("agent/turn-stopping", async ({ agent }) => {
		const runtime = ensure(agent);
		const goals = optionalGoalService(ctx, agent);
		await handleGuardTurnStopping(agent, runtime, {
			flush: () => ctx.sessions.flush(agent.session),
			hostSupported: runtime.projection.hostStatus === "supported",
			externalWaitCapability: evaluateExternalWaitCapability(hostLocks.get(agent) ?? installedHostLock),
			...goals ? { goalAccess: {
				get: async () => normalizeGoalState(await goals.get(agent)),
				disarm: async () => normalizeGoalState(await goals.disarm(agent))
			} } : {},
			readExternalOperation: (id) => readExternalOperation(ctx, agent, id)
		});
	});
}
function readExternalOperation(ctx, agent, id) {
	if (!agent || !id) return void 0;
	for (const owner of [agent.ctx, ctx]) try {
		const service = owner.get?.("jobs") ?? owner.jobs;
		if (!service || typeof service !== "object") continue;
		const row = typeof service.get === "function" ? service.get(id, agent) : void 0;
		if (!row) return void 0;
		const raw = String(row.status ?? "unknown");
		return {
			id,
			status: raw === "running" ? "running" : raw === "stopping" ? "pending" : raw === "completed" ? "completed" : raw === "killed" || raw === "failed" ? "failed" : "unknown",
			adapterId: "dsh.jobs.v1"
		};
	} catch {
		return;
	}
}
function optionalMarketOrigin(ctx, agent) {
	for (const owner of [agent.ctx, ctx]) try {
		const service = owner.get?.("webServer");
		if (!service || service.host !== "127.0.0.1" && service.host !== "::1" || typeof service.port !== "number" || !Number.isInteger(service.port) || service.port < 1 || service.port > 65535) continue;
		return `http://${service.host === "::1" ? "[::1]" : "127.0.0.1"}:${service.port}`;
	} catch {}
}
function ensureProtocolBoundary(agent) {
	if (agent.session.events.some((event) => {
		if (event.type !== "user/message" || !event.data || typeof event.data !== "object") return false;
		const data = event.data;
		const source = data.source && typeof data.source === "object" ? data.source : void 0;
		const content = Array.isArray(data.content) ? data.content : [];
		return (content.length === 1 && content[0] && typeof content[0] === "object" ? content[0].text : void 0) === PROTOCOL_V3_NOTICE && source?.kind === "plugin" && source.plugin === "context-guard" && source.form === "notice";
	})) return;
	agent.session.append.bind(agent.session)("user/message", createUserMessage({
		content: [{
			type: "text",
			text: PROTOCOL_V3_NOTICE
		}],
		source: {
			kind: "plugin",
			plugin: "context-guard",
			form: "notice",
			summary: boundContextSummary("Context Guard upgraded its replay contract to v3")
		}
	}), { surfaceOp: "append" });
}
function hasPinnedUpdateGoalTool(agent) {
	try {
		const tool = agent.ctx.tools?.get?.("update_goal", agent);
		if (!tool || typeof tool !== "object") return false;
		const row = tool;
		if (row.name !== "update_goal" || typeof row.execute !== "function") return false;
		const parameters = row.parameters;
		if (!parameters || parameters.type !== "object" || !parameters.properties || typeof parameters.properties !== "object") return false;
		const fields = parameters.properties;
		const requiredNames = parameters.required;
		if (!Array.isArray(requiredNames) || JSON.stringify([...requiredNames].sort()) !== JSON.stringify([
			"action",
			"goal_id",
			"revision"
		])) return false;
		if (JSON.stringify(Object.keys(fields).sort()) !== JSON.stringify([
			"action",
			"blocked_reason",
			"goal_id",
			"max_goal_rounds",
			"objective",
			"revision"
		])) return false;
		const required = (name$1, type) => {
			const field = fields[name$1];
			return Boolean(field && typeof field === "object" && field.type === type && requiredNames.includes(name$1));
		};
		const action = fields.action;
		return required("goal_id", "string") && required("revision", "number") && required("action", "string") && Array.isArray(action?.enum) && JSON.stringify(action.enum) === JSON.stringify([
			"edit",
			"pause",
			"resume",
			"complete",
			"blocked"
		]);
	} catch {
		return false;
	}
}
function optionalGoalService(ctx, agent) {
	for (const owner of [agent.ctx, ctx]) try {
		const service = owner.get?.("goals");
		if (service && typeof service.get === "function" && typeof service.disarm === "function") return service;
	} catch {}
}
function normalizeGoalState(value) {
	if (!value || typeof value !== "object") return void 0;
	const record$1 = value;
	const goal = record$1.goal && typeof record$1.goal === "object" ? record$1.goal : record$1;
	const id = goal.id;
	const revision = goal.revision;
	const phase = goal.phase;
	const activation = record$1.activation ?? goal.activation;
	if (typeof id !== "string" || typeof revision !== "number") return void 0;
	if (![
		"active",
		"paused",
		"blocked",
		"complete"
	].includes(String(phase))) return void 0;
	if (activation !== "armed" && activation !== "disarmed") return void 0;
	return {
		id,
		revision,
		phase,
		activation
	};
}

//#endregion
export { ACTION_MANIFEST, ACTION_MANIFEST_VERSION, ALPHA2_DSHMARKET_139_HOST_PACKAGES, ALPHA2_HOST_PACKAGES, ALPHA3_HOST_PACKAGES, BASE_HOST_PACKAGES, CERTIFICATE_VERSION, COMMAND_SURFACE_MANIFEST, Config, DEFAULT_HOST_LOCK, DEFAULT_RECOVERY_CHAR_BUDGET, EXPECTED_HOST_PACKAGES, GIT_COMMAND_MANIFEST_IDS, GOAL_HOST_PACKAGES, HOST_CAPABILITY_PACKAGE_GROUPS, HOST_COHORTS, HostProfileError, PROOF_KINDS, PROOF_PROTOCOL_VERSION, PROTOCOL_V3_NOTICE, SEMANTIC_ACTIONS, STATEFUL_ACTIONS, STOP_PROTOCOL_VERSION, SUPPORTED_EVIDENCE_ADAPTERS, actionCompatible, apply, authorityCaptureCounts, availableBoundaryQualifications, bindExecutableIdentity, bindLiveGoalCapability, bindProofToProjection, bindingSatisfies, canonicalArgvFromCommand, canonicalProjection, canonicalizePath, captureClause, captureItem, certifyCheckpoint, classifyClause, classifyCompletionClaim, classifyUserInteraction, closingHint, commitIndexSnapshotDigest, commitTreeSnapshotDigest, createGitPrestateEnvelope, createProjection, createProofManifest, currentContractDigest, decideTurnBoundary, decideTurnStopping, deriveProjection, digestStrings, effectuateBoundary, evaluateExternalWaitCapability, evaluateHostCapability, evaluateHostLock, evaluateToolSurfaceCapability, evidenceCoverage, evidenceFromPersistedToolResult, evidenceMatchesItem, executeRevalidatedGitEffect, extractArtifactPaths, extractMethod, extractOperation, extractTextContent, extractToolSubject, gitCommandMatchesTarget, goalCompletionDenial, hasCurrentCertificate, hostLockContextFromComposedDump, hostLockRowsFromComposedDump, inject, injectActiveProfileHostLock, isCurrentAcceptedBoundary, isDeterministicCheck, isInformationalMessage, isRunExecutable, isStatefulAction, isVerifyingCapability, isWholeTaskCompletionClaim, latestAssistantText, name, normalizeClause, observeAssistantOutcome, openItems, packageRowsFromActiveGraph, packageRowsFromPnpmLock, parseGitCommandManifest, parsePwshCommand, parseShellCommand, proofDigest, proofEvidenceConstraints, qualifyBoundary, recoveryDigest, renderRecoveryPacket, requestedTargetAuthorizesMutation, requestedTargetMatchesResolved, resolveActiveProfileHostLock, resolveInstalledHostLock, revalidateGitPrestate, sanitizeClauseText, sanitizeUrl, segmentAuthorityBlocks, segmentClauses, selectHostCohort, semanticActionFromCommand, semanticActionFromText, sessionQuery, sha256, supersedeItem, validateActionManifest, validateActionTarget, validateManifest, validateProofManifest, verifiedLinearCommitReadback, verifyComposedHostLockDump, withDurability };