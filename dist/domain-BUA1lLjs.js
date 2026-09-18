import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

//#region src/domain/canonicalize.ts
function normalizeClause(text) {
	return text.trim().replace(/\s+/g, " ");
}
function isWindowsStylePath(value) {
	return /^[A-Za-z]:/.test(value) || value.startsWith("\\\\") || value.startsWith("//") || value.includes("\\");
}
/**
* Canonicalize a filesystem path for subject matching. Windows-style paths are
* normalized (drive letter, both separator kinds, `.`/`..`, duplicate
* separators) and case-folded, because Windows paths compare case-insensitively
* and treat `/` and `\` as equivalent. POSIX-style paths are normalized but
* keep their case, so a case-sensitive filesystem is never made insensitive.
* Exactly one canonicalizer is shared by contract capture and evidence
* extraction so a Windows contract subject and a Windows evidence subject match.
*/
function canonicalizePath(value) {
	if (!value) return value;
	return isWindowsStylePath(value) ? path.win32.normalize(value).toLowerCase() : path.posix.normalize(value);
}
function sha256(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}
function digestStrings(values) {
	return sha256(values.slice().sort().join("\n"));
}
const KEYS = "(?:authorization|proxy-authorization|api[-_]?key|token|cookie|set-cookie|password|secret|session[-_]?id)";
const SENSITIVE_KEYS = `("${KEYS}"|'${KEYS}'|${KEYS})`;
const HEADER_VALUE = /(authorization|proxy-authorization|cookie|set-cookie)\s*:\s*.+$/gi;
const DOUBLE_QUOTED = new RegExp(`${SENSITIVE_KEYS}\\s*[:=]\\s*"(?:\\\\.|[^"\\\\])*"`, "gi");
const SINGLE_QUOTED = new RegExp(`${SENSITIVE_KEYS}\\s*[:=]\\s*'(?:\\\\.|[^'\\\\])*'`, "gi");
const UNCLOSED_DOUBLE = new RegExp(`${SENSITIVE_KEYS}\\s*[:=]\\s*"(?:\\\\.|[^"\\\\])*\\\\?$`, "gi");
const UNCLOSED_SINGLE = new RegExp(`${SENSITIVE_KEYS}\\s*[:=]\\s*'(?:\\\\.|[^'\\\\])*\\\\?$`, "gi");
const BARE_VALUE = new RegExp(`${SENSITIVE_KEYS}\\s*[:=]\\s*[^\\s,;'"\`)\\]}]+`, "gi");
const BEARER_TOKEN = /\bbearer\s+[A-Za-z0-9._~+/=-]+/gi;
const PLAIN_KEY = /\b(?:sk|pk|ak)-[a-zA-Z0-9_-]{16,}\b/g;
function sanitizeClauseText(text) {
	let value = text;
	const label = (key) => `${key.replace(/^["']|["']$/g, "")}=<redacted>`;
	value = value.replace(BEARER_TOKEN, "bearer <redacted>");
	value = value.replace(HEADER_VALUE, (_match, key) => `${key}=<redacted>`);
	value = value.replace(DOUBLE_QUOTED, (_match, key) => label(key));
	value = value.replace(SINGLE_QUOTED, (_match, key) => label(key));
	value = value.replace(UNCLOSED_DOUBLE, (_match, key) => label(key));
	value = value.replace(UNCLOSED_SINGLE, (_match, key) => label(key));
	value = value.replace(BARE_VALUE, (_match, key) => label(key));
	value = value.replace(PLAIN_KEY, (_match) => `${_match.slice(0, 3)}-<redacted>`);
	value = value.replace(/https?:\/\/[^\s'"`，。)]+[?#][^\s'"`，。)]*/g, (match) => {
		const cut = Math.min(...["?", "#"].map((marker) => {
			const index = match.indexOf(marker);
			return index === -1 ? Infinity : index;
		}));
		return cut === Infinity ? match : `${match.slice(0, cut)}\u2026`;
	});
	return value;
}
function sanitizeUrl(value) {
	const cut = Math.min(...["?", "#"].map((marker) => {
		const index = value.indexOf(marker);
		return index === -1 ? Infinity : index;
	}));
	return cut === Infinity ? value : value.slice(0, cut);
}

//#endregion
//#region src/domain/manifest.ts
const COMMAND_SURFACE_MANIFEST = {
	fileTools: [
		"printf",
		"echo",
		"touch",
		"cat"
	],
	readTools: [
		"cat",
		"grep",
		"rg",
		"head",
		"tail",
		"wc",
		"sed"
	],
	runExecutables: [
		"node",
		"python",
		"python3",
		"pnpm",
		"npm",
		"yarn",
		"bun",
		"pytest",
		"vitest",
		"jest",
		"tsc",
		"eslint",
		"mypy",
		"ruff",
		"prettier",
		"go",
		"cargo",
		"make",
		"cmake",
		"git",
		"mvn",
		"gradle",
		"tox",
		"nox",
		"dsh"
	],
	pwshExternalExecutables: [
		"node",
		"python",
		"python3",
		"pnpm",
		"npm",
		"yarn",
		"bun",
		"pytest",
		"vitest",
		"jest",
		"tsc",
		"eslint",
		"mypy",
		"ruff",
		"prettier",
		"go",
		"cargo",
		"make",
		"cmake",
		"git",
		"mvn",
		"gradle",
		"tox",
		"nox",
		"dsh"
	],
	operationVerbs: [
		{
			op: "create",
			pattern: "创建|生成|新建|touch|\\bcreates?\\b|\\bcreated\\b|\\bcreating\\b|\\bwrite\\b|写入"
		},
		{
			op: "modify",
			pattern: "修改|编辑|更改|modif(?:y|ies|ied|ying)|\\bedit\\b|改"
		},
		{
			op: "read",
			pattern: "读取|阅读|打开|读(?![A-Za-z0-9])|\\bread\\b"
		},
		{
			op: "verify",
			pattern: "验证|确认|确保|检查|verif(?:y|ies|ied|ying)|\\bconfirm\\b|\\bconfirms\\b|\\bconfirmed\\b|\\bensure\\b"
		},
		{
			op: "run",
			pattern: "运行|执行|拉取|获取|同步|更新|下载|安装|部署|上传|提交|推送|发布|升级|重启|重新启动|重载|\\brun\\b|execute(?:d)?|\\bpull\\b|\\bfetch\\b|\\bclone\\b|\\bsync\\b|\\bupdate\\b|\\binstall\\b|\\bdeploy\\b|\\bcommit\\b|\\bpush\\b|\\brelease\\b|\\bdownload\\b|\\bupload\\b|\\brestart\\b|\\breload\\b|\\breboot\\b"
		}
	]
};
const OPERATION_ORDER = [
	"create",
	"modify",
	"read",
	"verify",
	"run"
];
/**
* Validate the manifest invariants the parsers and capture depend on:
* - every collection is non-empty, sorted-case-insensitively, and duplicate-free
* - external executables mirror the POSIX run set exactly
* - verb groups exist once, in the documented priority order, and compile
* (they compile by construction when validated, so a typo cannot silently
* widen or break the surface).
*/
function validateManifest(manifest = COMMAND_SURFACE_MANIFEST) {
	const issues = [];
	const sets = [
		["fileTools", manifest.fileTools],
		["readTools", manifest.readTools],
		["runExecutables", manifest.runExecutables],
		["pwshExternalExecutables", manifest.pwshExternalExecutables]
	];
	for (const [name, values] of sets) {
		if (!values.length) issues.push({
			path: name,
			message: "must not be empty"
		});
		const sorted = [...values].map((value) => value.toLowerCase()).sort();
		if (sorted.some((value, index) => index > 0 && value === sorted[index - 1])) issues.push({
			path: name,
			message: "contains duplicates"
		});
	}
	if (manifest.runExecutables.length !== manifest.pwshExternalExecutables.length || [...manifest.runExecutables].map((value) => value.toLowerCase()).sort().join(",") !== [...manifest.pwshExternalExecutables].map((value) => value.toLowerCase()).sort().join(",")) issues.push({
		path: "pwshExternalExecutables",
		message: "must mirror runExecutables exactly"
	});
	const seenOps = /* @__PURE__ */ new Set();
	for (const entry of manifest.operationVerbs) {
		if (seenOps.has(entry.op)) issues.push({
			path: `operationVerbs.${entry.op}`,
			message: "duplicate operation group"
		});
		seenOps.add(entry.op);
		try {
			new RegExp(entry.pattern, "i");
		} catch {
			issues.push({
				path: `operationVerbs.${entry.op}`,
				message: `uncompilable pattern: ${entry.pattern}`
			});
		}
	}
	const order = manifest.operationVerbs.map((entry) => entry.op);
	const expected = OPERATION_ORDER.filter((operation) => seenOps.has(operation));
	if (order.join(",") !== expected.join(",")) issues.push({
		path: "operationVerbs",
		message: `priority order must be ${expected.join(" → ")}`
	});
	return issues;
}

//#endregion
//#region src/domain/protocol-manifest.ts
const STOP_PROTOCOL_VERSION = "2.0.0";
const CERTIFICATE_VERSION = "1";
/**
* 0.6.0 v5-session identity (P0 §1): v2 certificates bind a work unit's
* closure instead of the whole session. Version-1 identity keeps its
* historical meaning for legacy sessions and is never silently re-read.
*/
const STOP_PROTOCOL_VERSION_V2 = "3.0.0";
const CERTIFICATE_VERSION_V2 = "2";
const ACTION_MANIFEST_VERSION = 1;
const SUPPORTED_EVIDENCE_ADAPTERS = {
	"context-guard.git.v1": "1.0.0",
	"context-guard.package.v1": "1.0.0",
	"context-guard.artifact.v1": "1.0.0",
	"context-guard.service.v2": "2.0.0",
	"context-guard.registry.v1": "1.0.0"
};
const SEMANTIC_ACTIONS = [
	"inspect_remote_updates",
	"install",
	"apply",
	"create",
	"modify",
	"test",
	"verify",
	"pull",
	"fetch",
	"commit",
	"push",
	"restart",
	"publish",
	"generic_run"
];
const STATEFUL_ACTIONS = [
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
const ACTION_MANIFEST = {
	version: ACTION_MANIFEST_VERSION,
	actions: {
		inspect_remote_updates: {
			stateful: false,
			evidenceProducer: "supported",
			resolvedTargetKeys: [
				"repository",
				"version",
				"remote"
			],
			observedStateKeys: ["upstream_oid"],
			predicateId: "pred.inspect_remote_updates.v1",
			commandManifestIds: ["git.ls_remote_exact.v2"]
		},
		install: {
			stateful: true,
			evidenceProducer: "supported",
			resolvedTargetKeys: [
				"package_id",
				"version",
				"integrity_digest",
				"profile"
			],
			observedStateKeys: [
				"package_id",
				"version",
				"integrity_digest",
				"profile"
			],
			predicateId: "pred.install.v1",
			commandManifestIds: ["dsh.plugin_add_tgz.install.v1"]
		},
		apply: {
			stateful: true,
			evidenceProducer: "supported",
			resolvedTargetKeys: [
				"package_id",
				"version",
				"integrity_digest",
				"profile"
			],
			observedStateKeys: [
				"package_id",
				"version",
				"integrity_digest",
				"profile"
			],
			predicateId: "pred.apply.v1",
			commandManifestIds: ["dsh.plugin_add_tgz.apply.v1"]
		},
		create: {
			stateful: true,
			evidenceProducer: "supported",
			resolvedTargetKeys: [
				"artifact_id",
				"scope",
				"pre_digest",
				"change_set_digest"
			],
			observedStateKeys: ["post_digest"],
			predicateId: "pred.create.v1",
			commandManifestIds: ["artifact.create.v1"]
		},
		modify: {
			stateful: true,
			evidenceProducer: "supported",
			resolvedTargetKeys: [
				"artifact_id",
				"scope",
				"pre_digest",
				"change_set_digest"
			],
			observedStateKeys: ["post_digest"],
			predicateId: "pred.modify.v1",
			commandManifestIds: ["artifact.modify.v1"]
		},
		test: {
			stateful: false,
			evidenceProducer: "supported",
			resolvedTargetKeys: ["scope", "executable"],
			observedStateKeys: [],
			predicateId: "pred.test.outcome",
			commandManifestIds: [
				"python.unittest.v1",
				"package.test.v1",
				"test.runner.v1"
			]
		},
		verify: {
			stateful: false,
			evidenceProducer: "supported",
			resolvedTargetKeys: ["scope"],
			observedStateKeys: [],
			predicateId: "pred.verify.outcome",
			commandManifestIds: ["deterministic.verify.v1"]
		},
		pull: {
			stateful: true,
			evidenceProducer: "supported",
			resolvedTargetKeys: [
				"repository",
				"remote",
				"refspec",
				"upstream_oid",
				"pre_head_oid",
				"pull_mode"
			],
			observedStateKeys: ["post_head_oid", "tracking_ref_oid"],
			predicateId: "pred.pull.v1",
			commandManifestIds: ["git.pull_ff_only_explicit.v2"]
		},
		fetch: {
			stateful: true,
			evidenceProducer: "supported",
			resolvedTargetKeys: [
				"repository",
				"remote",
				"refspec",
				"upstream_oid",
				"pre_head_oid"
			],
			observedStateKeys: ["tracking_ref_oid", "post_head_oid"],
			predicateId: "pred.fetch.v1",
			commandManifestIds: ["git.fetch_tracking_explicit.v2"]
		},
		commit: {
			stateful: true,
			evidenceProducer: "supported",
			resolvedTargetKeys: [
				"repository",
				"branch",
				"change_set_digest",
				"pre_head_oid"
			],
			observedStateKeys: ["post_head_oid", "pre_head_oid"],
			predicateId: "pred.commit.v1",
			commandManifestIds: ["git.commit_index_tree.v2"]
		},
		push: {
			stateful: true,
			evidenceProducer: "supported",
			resolvedTargetKeys: [
				"repository",
				"remote",
				"refspec",
				"local_oid"
			],
			observedStateKeys: ["remote_oid"],
			predicateId: "pred.push.v1",
			commandManifestIds: ["git.push_explicit_refs.v2"]
		},
		restart: {
			stateful: true,
			evidenceProducer: "supported",
			resolvedTargetKeys: ["service_id", "pre_generation"],
			observedStateKeys: ["new_generation", "health"],
			predicateId: "pred.restart.v1",
			commandManifestIds: ["dshmarket.restart.v1"]
		},
		publish: {
			stateful: true,
			evidenceProducer: "supported",
			resolvedTargetKeys: [
				"artifact_id",
				"version",
				"registry",
				"integrity_digest"
			],
			observedStateKeys: [
				"artifact_id",
				"version",
				"registry",
				"integrity_digest"
			],
			predicateId: "pred.publish.v1",
			commandManifestIds: ["npm.publish_tgz.v1"]
		},
		generic_run: {
			stateful: false,
			evidenceProducer: "supported",
			resolvedTargetKeys: ["scope", "executable"],
			observedStateKeys: [],
			predicateId: "pred.generic_run.outcome",
			commandManifestIds: ["generic.run.v1"]
		}
	},
	compatibility: {
		inspect_remote_updates: ["inspect_remote_updates"],
		install: ["install"],
		apply: ["apply"],
		create: ["create"],
		modify: ["modify"],
		test: ["test", "verify"],
		verify: ["verify", "test"],
		pull: ["pull"],
		fetch: ["fetch"],
		commit: ["commit"],
		push: ["push"],
		restart: ["restart"],
		publish: ["publish"],
		generic_run: ["generic_run"]
	}
};
const ORDERED_TEXT_RULES = [
	["inspect_remote_updates", /检查.{0,12}(?:远端|上游).{0,8}(?:更新|版本)|inspect.{0,12}(?:remote|upstream).{0,8}(?:update|version)/i],
	["test", /python(?:3)?\s+-m\s+(?:unittest|pytest|doctest)|\b(?:pnpm|npm|yarn|bun)\s+(?:test|tst)\b|\b(?:pytest|vitest|jest)\b/i],
	["install", /安装|\binstall\b|\bplugin\s+(?:add|install)\b/i],
	["apply", /应用|\bapply\b/i],
	["create", /创建|新建|生成|\bcreat(?:e|es|ed|ing)\b/i],
	["modify", /修改|编辑|更改|\bmodif(?:y|ies|ied|ying)\b|\bedit\b/i],
	["pull", /拉取|\bgit\s+pull\b|\bpull\b/i],
	["fetch", /抓取|\bgit\s+fetch\b|\bfetch\b/i],
	["commit", /提交|\bgit\s+commit\b|\bcommit\b/i],
	["push", /推送|\bgit\s+push\b|\bpush\b/i],
	["restart", /重启|重新启动|\brestart\b|\breload\b/i],
	["publish", /发布|\bpublish\b|\brelease\b/i],
	["verify", /验证|确认|确保|\bverif(?:y|ies|ied|ying)\b|\bconfirm\b/i]
];
function semanticActionFromText(text) {
	if (/^\s*(?:验证|校验|确认|确保|核对|verif(?:y|ies|ied|ying)\b|confirm\b)/i.test(text)) return "verify";
	for (const [action, pattern] of ORDERED_TEXT_RULES) if (pattern.test(text)) return action;
	return "generic_run";
}
function semanticActionFromCommand(command) {
	const normalized = command.trim().replace(/\s+/g, " ");
	if (/\bpython(?:3)?\s+-m\s+(?:unittest|pytest|doctest)\b|\b(?:pnpm|npm|yarn|bun)\s+(?:test|tst)\b|^(?:pytest|vitest|jest)\b/i.test(normalized)) return "test";
	if (/^git\s+pull(?:\s|$)/i.test(normalized)) return "pull";
	if (/^git\s+fetch(?:\s|$)/i.test(normalized)) return "fetch";
	if (/^git\s+commit(?:\s|$)/i.test(normalized)) return "commit";
	if (/^git\s+push(?:\s|$)/i.test(normalized)) return "push";
	if (/^dsh\s+plugin\b.*\sadd(?:\s|$)/i.test(normalized) || /^(?:pnpm|npm|yarn|bun)\s+(?:install|add)(?:\s|$)/i.test(normalized)) return "install";
	if (/^dsh\b.*\b(?:restart|reload)\b/i.test(normalized)) return "restart";
	if (/^(?:pnpm|npm|yarn|bun)\s+publish(?:\s|$)/i.test(normalized)) return "publish";
	return "generic_run";
}
function isStatefulAction(action) {
	return STATEFUL_ACTIONS.includes(action);
}
function actionCompatible(required, observed) {
	return ACTION_MANIFEST.compatibility[required].includes(observed);
}
function hasExactKeys(tuple, required) {
	if (!tuple) return required.length === 0;
	return Object.keys(tuple).length === required.length && required.every((key) => Object.hasOwn(tuple, key));
}
function validateActionTarget(action, resolved, observed) {
	const spec = ACTION_MANIFEST.actions[action];
	return hasExactKeys(resolved, spec.resolvedTargetKeys) && hasExactKeys(observed, spec.observedStateKeys);
}
const REQUESTED_IDENTITY_KEY = {
	install: "package_id",
	apply: "package_id",
	create: "artifact_id",
	modify: "artifact_id",
	pull: "repository",
	fetch: "repository",
	commit: "repository",
	push: "repository",
	restart: "service_id",
	publish: "artifact_id"
};
/** The single identity field a root instruction must name for this action. */
function requestedIdentityKey(action) {
	return REQUESTED_IDENTITY_KEY[action];
}
function stableTargetValue(value) {
	if (Array.isArray(value)) return `[${value.map(stableTargetValue).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableTargetValue(entry)}`).join(",")}}`;
	return JSON.stringify(value);
}
/**
* The 0.6.0 bounded file-choice vocabulary (C07/S03): artifact-type nouns a
* root instruction may use instead of an exact path. The assistant may pick
* the exact file INSIDE the captured scope and inside the type, and the
* choice is frozen by the resolution producer before any effect. An absent
* extension set (`file`) admits any file the producer accepts.
*/
const BOUNDED_ARTIFACT_TYPES = {
	document: new Set([
		"md",
		"markdown",
		"txt"
	]),
	readme: new Set([
		"md",
		"rst",
		"txt"
	]),
	report: new Set(["md", "txt"]),
	file: null
};
function extensionOf(path$1) {
	const base = path$1.split(/[\\/]/).pop() ?? "";
	const dot = base.lastIndexOf(".");
	return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}
function normalizeSlashes(value) {
	return value.replace(/\\/g, "/");
}
/** Whether `artifact` lives inside `scope` (or exactly at it), slash-normalized. */
function insideScope(artifact, scope) {
	if (scope === "scope" || scope === "") return false;
	const normalizedArtifact = normalizeSlashes(artifact);
	const normalizedScope = normalizeSlashes(scope).replace(/\/+$/, "");
	if (normalizedArtifact === normalizedScope) return false;
	return normalizedArtifact.startsWith(`${normalizedScope}/`);
}
/**
* Whether a bounded-choice requested target authorizes this resolved target:
* the resolved artifact must live inside the captured scope and match the
* captured type. The exact file name is the assistant's bounded decision,
* frozen by resolution — never a root-named identity substitution.
*/
function boundedArtifactChoiceMatches(action, requested, resolved) {
	if (action !== "create" && action !== "modify") return false;
	const type = requested?.artifact_type;
	const scope = requested?.scope;
	if (typeof type !== "string" || typeof scope !== "string" || !(type in BOUNDED_ARTIFACT_TYPES)) return false;
	const artifact = resolved?.artifact_id;
	if (typeof artifact !== "string" || !artifact) return false;
	if (!insideScope(artifact, scope)) return false;
	const allowed = BOUNDED_ARTIFACT_TYPES[type];
	return allowed === null || allowed.has(extensionOf(artifact));
}
/**
* Compare identities captured from the root instruction with a complete
* adapter-resolved target. Requested targets are partial by design: only
* explicitly named identities (plus the active repository scope) are frozen.
* A bounded artifact choice (scope + type, C07) matches when the resolved
* exact file is inside the scope and of the captured type.
*/
function requestedTargetMatchesResolved(action, requested, resolved) {
	if (boundedArtifactChoiceMatches(action, requested, resolved)) return true;
	const identityKey = REQUESTED_IDENTITY_KEY[action];
	if (!identityKey || !requested || !resolved || !Object.hasOwn(requested, identityKey)) return false;
	const allowed = new Set(ACTION_MANIFEST.actions[action].resolvedTargetKeys);
	return Object.entries(requested).every(([key, value]) => allowed.has(key) && Object.hasOwn(resolved, key) && stableTargetValue(value) === stableTargetValue(resolved[key]));
}
const MUTATION_AUTHORITY_KEYS = {
	install: [
		"package_id",
		"version",
		"profile"
	],
	apply: [
		"package_id",
		"version",
		"profile"
	],
	create: ["artifact_id", "scope"],
	modify: ["artifact_id", "scope"],
	restart: ["service_id"],
	commit: ["repository", "branch"],
	push: [
		"repository",
		"remote",
		"refspec"
	],
	publish: [
		"artifact_id",
		"version",
		"registry"
	],
	pull: [
		"repository",
		"remote",
		"refspec"
	],
	fetch: [
		"repository",
		"remote",
		"refspec"
	]
};
/** A mutation requires every user-selectable identity field, not a partial match. */
function requestedTargetAuthorizesMutation(action, requested, resolved) {
	if (boundedArtifactChoiceMatches(action, requested, resolved)) return true;
	const required = MUTATION_AUTHORITY_KEYS[action];
	return !!requested && required.every((key) => Object.hasOwn(requested, key)) && requestedTargetMatchesResolved(action, requested, resolved);
}
function validateActionManifest() {
	const issues = [];
	if (Object.keys(ACTION_MANIFEST.actions).length !== SEMANTIC_ACTIONS.length) issues.push("action set mismatch");
	for (const action of SEMANTIC_ACTIONS) {
		const spec = ACTION_MANIFEST.actions[action];
		if (!spec) {
			issues.push(`missing action ${action}`);
			continue;
		}
		if (!spec.predicateId || !spec.commandManifestIds.length) issues.push(`incomplete action ${action}`);
		if (isStatefulAction(action) && (!spec.stateful || !spec.resolvedTargetKeys.length || !spec.observedStateKeys.length)) issues.push(`stateful action ${action} lacks closure keys`);
	}
	return issues;
}

//#endregion
//#region src/domain/semantics.ts
/**
* 0.6.3 K1 regression probe: the 0.6.2 question rule, kept SOLELY so the fixed
* defect has a test that fails against the old reading.
*
* 0.6.2 declared a clause information as soon as a question marker appeared
* anywhere inside it (`QUESTION_SCOPE.test(masked)`). This function is that
* rule, verbatim. It is not used by any production path — the current reading
* is {@link hasQuestionScope} — and its only caller is the regression test that
* pins the difference between the two readings on the recorded defect input.
*/
function legacyQuestionReadingIsInformational(masked) {
	return QUESTION_SCOPE.test(masked);
}
/** A clause whose head verb demands a verification rather than a change. */
const ACCEPTANCE_LEAD = /^(?:验收|验证|确认|确保|核对|检查|verify|confirm|ensure|check)/i;
/**
* The contract kind a scope maps to. A prohibition and an acceptance keep their
* own lanes; everything else is a requirement. Acceptance is decided from the
* clause's own head verb, so "确保构建通过" stays an acceptance while a
* conditional or prohibition clause is never mislabelled.
*/
function kindOfScope(directive, body = "") {
	if (directive === "prohibition") return "prohibition";
	if (directive === "directive" && ACCEPTANCE_LEAD.test(body.trim())) return "acceptance";
	return "requirement";
}
/**
* Blank out inline-code spans while preserving every byte offset, so a caller
* can classify authority against masked text and still slice the original.
* Backticks are Markdown emphasis, but they are also how a log line or a
* command is quoted — and a quoted command is data, never an order.
*/
const MASK_CACHE = /* @__PURE__ */ new Map();
const MASK_CACHE_LIMIT = 64;
function maskCodeSpans(text) {
	const cached = MASK_CACHE.get(text);
	if (cached !== void 0) return cached;
	const masked = computeMaskedSpans(text);
	if (MASK_CACHE.size >= MASK_CACHE_LIMIT) MASK_CACHE.clear();
	MASK_CACHE.set(text, masked);
	return masked;
}
function computeMaskedSpans(text) {
	const characters = text.split("");
	let cursor = 0;
	while (cursor < text.length) {
		if (text[cursor] !== "`") {
			cursor += 1;
			continue;
		}
		const end = text.indexOf("`", cursor + 1);
		if (end < 0) break;
		for (let index = cursor; index <= end; index += 1) characters[index] = " ";
		cursor = end + 1;
	}
	return characters.join("");
}
/** Actions Guard can name, shared with the command-surface manifest. */
/**
* The manifest's operation verbs. Each alternative is wrapped with word
* boundaries, so an English verb never matches inside another word ("check"
* inside "change"); a Chinese alternative is left alone because a Han character
* has no word boundary to assert.
*/
const CJK_VERBS = [
	"创建",
	"生成",
	"新建",
	"写入",
	"修改",
	"编辑",
	"更改",
	"读取",
	"阅读",
	"打开",
	"验证",
	"校验",
	"确认",
	"确保",
	"检查",
	"核对",
	"运行",
	"执行",
	"拉取",
	"同步",
	"更新",
	"下载",
	"安装",
	"部署",
	"上传",
	"提交",
	"推送",
	"发布",
	"升级",
	"重启",
	"重新启动",
	"重载",
	"合并",
	"继续",
	"撤销",
	"删除"
];
/** Every CJK action word, longest first so 重新启动 wins over 新. */
const CJK_VERB_PATTERN = `(?:${[...CJK_VERBS].sort((a, b) => b.length - a.length).join("|")})`;
/** The same words as literal strings, for exact scanning without regex escapes. */
const CJK_VERB_WORDS = [...CJK_VERBS].sort((a, b) => b.length - a.length);
const ACTION_VERB_PATTERN = `(?:${COMMAND_SURFACE_MANIFEST.operationVerbs.map((entry) => entry.pattern.split("|").map((alternative) => /^[A-Za-z]/.test(alternative.trim()) ? `\\b${alternative.trim()}\\b` : alternative.trim()).join("|")).join("|")}|${CJK_VERB_PATTERN})`;
const ACTION_VERB = new RegExp(ACTION_VERB_PATTERN, "i");
/** Operation verbs beyond the guard action surface (local work and diagnosis). */
const WORK_VERB = /创建|生成|新建|写入|修改|编辑|运行|执行|编写|撰写|起草|拟定|部署|安装|升级|提交|下载|上传|拉取|同步|重启|测试|检查|验证|确认|修复|更新|清理|整理|记录|构建|编译|重构|迁移|轮换|刷新|清空|扩容|缩容|删除|回滚|发布|推送|合并|继续|恢复|还原|回滚|实现|\b(?:build|create|write|modify|change|edit|run|fix|update|install|push|publish|test|verify|check|commit|deploy|migrate|remove|delete|restart|revert|refactor|inspect|fetch|pull|implement|draft|emit|produce|log)\b/i;
/** Explanatory framings: an action named afterwards is an object, not an order. */
const EXPLAIN_VERB = /解释|说明|讲解|介绍|阐述|分析|讨论|描述|科普|什么意思|是什么意思|有什么(?:作用|影响|区别)|\bexplain\b|\bdescribe\b|\bclarify\b|\btell\b|\bhow\s+to\b|\bwhat\s+does\b|\bwhat\s+is\b|\bhow\s+does\b|\bmeaning\s+of\b/i;
/** Interrogative framings that make a scope a question rather than an order. */
/**
* Interrogative framings that make a scope a question rather than an order.
* The bare English wh-words are matched only at the START of a scope ("What
* changed in the build"), where they are genuine interrogatives; a mid-clause
* match would misread the relative clause of a real order ("Create a file
* where logs are stored") as a question — the 0.6.1 review regression.
*/
const QUESTION_SCOPE = /[？?]|是否|是不是|为什么|为何|怎么|如何|什么|哪些|哪一种|能否|可否|要不要|该不该|由谁|是谁|^\s*(?:what|how|when|where|who|which|whether|why)\b|\b(?:whether|which|why|should|could|would)\b/i;
/**
* The interrogative ending. A clause whose head is an action verb is decided by
* how it ENDS: "检查是否有更新吗？" asks about the world, while "检查是否存在
* 更新。" orders a check.
*
* 吗 and the question mark ask on their own. 呢 and 吧 do NOT: both soften a
* suggestion ("安装这个主题呢。", "安装新主题吧。"), so treating either as an
* interrogative turned a pure order into a closable information request — the
* reviewer's zero-tool counterexample. 呢 still ends a question when the clause
* carries its own interrogative content ("主题是不是需要更新呢？"); 吧 never
* does. A clause whose own opening word is a question (怎么/如何) is handled by
* {@link INFO_OPENING} and {@link QUESTION_LEAD}.
*/
const QUESTION_ENDING = /(?:吗|[？?])[。，、；;.!]*$/u;
/** The softening particles that ask only when the rest of the clause asks too. */
const SOFT_ENDING = /(?:呢|吧)[。，、；;.!]*$/u;
const QUESTION_MARKER = /[？?]|是否|是不是|为什么|为何|怎么|如何|什么|哪些|哪一种|能否|可否|要不要|该不该|由谁|是谁/u;
/** Whether the clause closes on a genuine interrogative. */
function endsOnInterrogative(masked) {
	if (QUESTION_ENDING.test(masked)) return true;
	return SOFT_ENDING.test(masked) && QUESTION_MARKER.test(masked.replace(/[呢吧][。，、；;.!]*$/u, ""));
}
/**
/**
* An English clause whose INTERROGATIVE is the object of its own action rather
* than the clause's question: "Create a file recording whether the tests
* passed", "Write a report indicating whether deployment succeeded". The
* embedded whether/if/wh-word follows the action, so the clause orders work and
* the interrogative only says WHAT the artifact must record.
*/
const ENGLISH_INTERROGATIVE_TRIGGER = /\b(?:whether|if|what|which|why|how|when|where|who)\b/i;
/**
* Whether an English clause opens with a verb that takes the interrogative as
* its OWN object and continues with `if`: "Check if the remote has new
* commits", "Verify if the build passed". The head is the verb plus the "if";
* anything else after that verb is its object clause, not a condition.
*/
function interrogativeTakesIfObject(masked) {
	if (!investigationHeadTakesIf(masked)) return false;
	const head = /^\s*(?:please\s+)?(check|verify|confirm|see|determine|inspect|review|test)\s+(?:if|whether|when|where|why|how|what|which)\b/i.exec(masked);
	const verb = firstActionVerb(masked);
	const verbOffset = head[0].search(/check|verify|confirm|see|determine|inspect|review|test/i);
	if (verbOffset < 0) return false;
	return verb < 0 || verb === verbOffset;
}
/**
* Whether the clause OPENS with an investigation verb whose object is the
* interrogative `if`/`whether`/…, whatever else the clause contains. This is the
* head-level form of {@link interrogativeTakesIfObject}, used by the condition
* splitter: a clause that starts this way is an investigation, so its `if` is not
* a condition on a separate instruction.
*/
function investigationHeadTakesIf(masked) {
	if (/^\s*(?:please\s+)?(check|verify|confirm|see|determine|inspect|review|test)\s+(?:if|whether|when|where|why|how|what|which)\b/i.exec(masked) === null) return false;
	const verb = firstActionVerb(masked);
	if (verb >= 0 && verbIsNegated(masked, verb)) return false;
	const boundary = ENGLISH_SUBORDINATE_BOUNDARY.exec(masked);
	return boundary === null || 0 < boundary.index;
}
/**
/**
* A boundary that opens an ENGLISH subordinate span: every `to <verb>` purpose
* clause, a relative pronoun, a progressive participle, and the prepositional
* or temporal openers that introduce one. A question word behind such a
* boundary belongs to the subordinate clause, so it never makes the whole
* clause a question. This is structural, not a verb list: an unknown main verb
* ("Archive /tmp/logs to show what changed", "Compress /tmp/logs to check the
* status") is still read correctly, which is what the earlier vocabulary-based
* gate could not do.
*
* The comparative is `than`, NOT `tha[nt]`: `then` is a sequencing connective,
* and reading it as a boundary made "Then check whether the disk is full." look
* like a subordinate span whose question word belonged to a purpose clause — so
* the English clause lost the investigation lane while the Chinese spelling kept
* it (hold-out 7).
*/
const ENGLISH_SUBORDINATE_BOUNDARY = /\bto\s+[a-z]+|\b(?:which|who|whom|whose|that|than)\b|\b[a-z]+ing\b|\b(?:after|before|until|unless|while|once|during|about|for|regarding|concerning)\b/i;
/**
* Whether an English interrogative word ASKS the clause, rather than sitting in
* its subordinate span. A wh-word that is followed by a subordinate boundary
* ("... recording whether the tests passed", "... to show what changed") is the
* object of that span, so the clause stays work.
*/
/**
* Whether an investigation head opens the clause rather than sitting inside a
* subordinate span. A head behind a purpose or relative boundary is that span's
* verb ("Compress /tmp/logs TO CHECK the status"), so it asks nothing (review 4).
*/
function headOpensClause(pattern, masked) {
	const match = pattern.exec(masked);
	if (match === null) return false;
	const boundary = ENGLISH_SUBORDINATE_BOUNDARY.exec(masked);
	if (boundary !== null && boundary.index < match.index) return false;
	const verb = firstActionVerb(masked);
	return verb < 0 || match.index <= verb;
}
/**
* Whether a condition marker guards the CLAUSE rather than sitting inside a
* purpose or relative span. "Create /tmp/check.sh to determine if the service is
* running" orders a creation; the `if` belongs to the purpose clause, so the
* creation is not conditional (review 4).
*/
const CJK_SUBORDINATE_BOUNDARY = /为了|用来|以便|从而|进而|用于/u;
function conditionMarkerIsClauseLevel(masked, markerIndex) {
	const english = ENGLISH_SUBORDINATE_BOUNDARY.exec(masked);
	const cjk = CJK_SUBORDINATE_BOUNDARY.exec(masked);
	const starts = [english?.index, cjk?.index].filter((index) => index !== void 0);
	if (starts.length === 0) return true;
	return Math.min(...starts) >= markerIndex;
}
function englishInterrogativeIsMatrix(masked) {
	const trigger = ENGLISH_INTERROGATIVE_TRIGGER.exec(masked);
	if (!trigger) return true;
	const boundary = ENGLISH_SUBORDINATE_BOUNDARY.exec(masked);
	return boundary === null || trigger.index <= boundary.index;
}
/**
* Request and sequencing words that may precede an instruction head without
* becoming one: "先检查是否有新版本" is still the investigation "检查是否有新
* 版本". A preface is consumed only in front of an investigation opener, so
* "先提交" stays an order. The English sequencing words are here for the same
* reason as the Chinese ones: "Then check whether the disk is full." is the
* investigation "check whether …", and leaving the preface out made the English
* clause an acceptance obligation while the Chinese spelling stayed an
* information request (review 5 follow-up / hold-out 7).
*/
const REQUEST_PREFACE = "(?:那么|然后|接着|随后|首先|先|再|也|请|麻烦|帮我|并且|并|以及|then\\b|also\\b|next\\b|first\\b|finally\\b|now\\b|please\\b|kindly\\b)?";
/** Investigation openers: how an information request about state is phrased. */
const INVESTIGATION_HEAD = "(?:看看|看一下|瞅瞅|查一下|检查|查看|确认|核对|了解|验证|check\\b|verify\\b|confirm\\b|see\\b|find\\s+out|determine\\b)";
/** The interrogative a clause can open or close on: "怎么装？", "whether …". */
const QUESTION_WORD = "(?:怎么|怎样|如何|为什么|为何|什么|哪些|哪一种|哪个|是否|是不是|能否|可否|要不要|该不该|由谁|是谁|谁|何时|什么时候|几时|多久|多少|what|how|when|where|who|whom|whose|which|whether|why)";
/** The states a question about a change asks about ("是否有更新"). */
const CHANGE_STATE = "(?:更新|升级|提交|推送|发布|安装|修改|删除|修复|完成|同步|拉取|下载|重启|生成|写入|创建|部署|添加|变更|改动|new\\s+commits?|update[sd]?|upgrade[sd]?|commit(?:s|ted)?|push(?:ed)?|publish(?:ed)?|install(?:ed)?|change[sd]?|fix(?:ed)?)";
/** Chinese question words need no word boundary; an English one does. */
const QUESTION_WORD_TAIL = "(?![A-Za-z0-9_])";
/** The same alternation as a pattern, for a caller that only needs to test. */
const QUESTION_WORD_PATTERN = new RegExp(QUESTION_WORD, "iu");
const QUESTION_LEAD = new RegExp(`^\\s*${QUESTION_WORD}${QUESTION_WORD_TAIL}`, "iu");
/**
* An investigation word, the object it investigates (if any), and a
* question about that object's state: 检查是否…, 检查一下插件是否有更新,
* check whether…. The verb states HOW the question is answered, so the clause
* asks about the world rather than ordering a change.
*/
const INVESTIGATION_THEN_QUESTION = new RegExp(`^\\s*${REQUEST_PREFACE}\\s*${INVESTIGATION_HEAD}[^。！？；，,]{0,24}?(?:是否|是不是|有没有|有没|能否|可否|要不要|该不该|为什么|为何|怎么|如何)${QUESTION_WORD_TAIL}`, "iu");
/**
* A question about a change's state: "…是否有更新", "…有没有安装成功",
* "whether the remote has new commits". The change verb is the object of the
* question, so the clause asks rather than orders.
*/
const QUESTION_ABOUT_CHANGE = new RegExp(`(?:是否|是不是|有没有|有没|能否|can\\s+you\\s+see|whether)\\s*(?:已经|已|还|仍然)?\\s*(?:有|存在|出来|成功)?\\s*${CHANGE_STATE}${QUESTION_WORD_TAIL}`, "iu");
const INVESTIGATION_OF_STATE = new RegExp(`${INVESTIGATION_HEAD}\\s*(?:一下|下)?\\s*(?:for|about|on|the|a|an|new|current|latest|有没(?:有)?|关于)?\\s*(?:for|about|on|the|a|an|new|current|latest|有没(?:有)?)?\\s*(?:for|about|on|the|a|an|new|current|latest)?\\s*(?:状态|版本|更新|变更|改动|发布|提交|结果|日志|配置|权限|依赖|端口|缓存|status|state|version|update|upgrade|release|commit|change|result|logs?|config(?:uration)?|permissions?|dependencies|port|cache)${QUESTION_WORD_TAIL}`, "iu");
/**
* An investigation whose head word IS an investigation, followed immediately by
* the interrogative: "How do I install this?" / "看看怎么弄". An investigation
* word that merely sits inside an object ("仔细检查生成的几个文件") is not the
* clause's head, and one whose object happens to be a question word is not a
* question about method.
*/
const INFO_OPENING = new RegExp(`^\\s*${REQUEST_PREFACE}\\s*${INVESTIGATION_HEAD}\\s*${QUESTION_WORD}${QUESTION_WORD_TAIL}`, "iu");
/**
* A reported question: a reporting verb hands the question to the assistant
* ("Tell me what changed in the build and why"). The clause asks, so the
* answering turn closes it — no execution obligation is created.
*/
const REPORTED_QUESTION = new RegExp(`(?:^|[^A-Za-z0-9_])(?:(?:tell|explain|describe|show)\\b|(?:解释|说明|描述|讲解|讲讲|说一下|告诉我))[^。！？；]{0,24}?${QUESTION_WORD}${QUESTION_WORD_TAIL}`, "iu");
/**
* Whether a clause asks for information rather than ordering work (0.6.3 K1).
*
* 0.6.2 treated the mere presence of a question marker anywhere in a clause as
* "the whole clause is a question", so one 是否 inside a comma-run of
* instructions ("更新插件，检查是否存在更新，安装新主题，记录变更。") turned
* every execution obligation beside it into closable information. The reading
* is now grammatical — head verb, interrogative position, negation — so a
* relative or purpose clause inside an order ("Create a file where logs are
* stored", "更新皮肤中心，看看为什么失败") is never a question, while a real
* request for an answer ("How do I install this?", "检查是否有更新吗？",
* "check whether the remote has new commits") still is.
*/
function hasQuestionScope(masked) {
	return isInformationalFragment(masked);
}
/**
* True when the fragment is a pure request for information.
*
* A fragment that names an action counts as a question only when it ENDS on
* the interrogative ("检查一下插件是否有更新吗？") or asks through the verb
* itself ("检查是否存在更新", "check whether the remote has new commits"). An
* order whose object merely contains question content ("更新皮肤中心，看看为
* 什么失败") stays an order. A fragment that names no action is information
* whenever it asks at all, which keeps "what changed in the build and why" and
* "How do I install this?" in the answerable lane.
*/
/**
* A REPORTING or EXPLANATION head: the verbs whose complement is the rest of the
* sentence ("Explain how I can install foo and restart service api.",
* "说明一下如何回滚并重新部署服务"). English reporting verbs and their Chinese
* counterparts are both closed grammatical classes.
*/
const REPORTING_HEAD = new RegExp(`^\\s*(?:${REQUEST_PREFACE}\\s*)?(?:tell|explain|describe|show|wonder|ask|know|recall|decide|determine|establish|find\\s+out|figure\\s+out)\\b|^\\s*(?:${REQUEST_PREFACE}\\s*)?(?:解释|说明|描述|讲解|讲讲|说一下|告诉我|想问|问一下|想知道|了解一下|不确定|不清楚|不清楚|不知道)`, "iu");
/**
* Whether an explanation head GOVERNS its sentence.
*
* Everything coordinated inside the sentence the explanation heads is the OBJECT
* of the explanation, however it is phrased and however long it is: a finite
* complement ("how I can install …"), a `whether` complement, an infinitive, a
* list with a long object — all of it is what the root asked to have explained.
* The scope is therefore structural: it is the SENTENCE, bounded by the sentence
* splitter, not a pattern with a window. A sentence break ends the governance, so
* a following sentence can be a real instruction ("Explain the deploy. Then
* restart service api." stays authorizable), and a question that merely stands
* beside an order ("What changed and archive the logs?") has no explanation head
* and keeps its order.
*/
function reportingHeadGoverns(masked) {
	return headOpensClause(REPORTING_HEAD, masked);
}
/**
* Whether a clause is the scope of a QUESTION — any question, not only a reported
* one: a question word ("How do I install …"), an interrogative auxiliary
* ("Can you …"), an investigation ("Check whether …") or an explanation
* ("Explain how …").
*
* A question head GOVERNS its clause: everything coordinated inside it is part of
* what the root asked, so the clause must not be split into an executable child.
* When such a clause ALSO carries an action of its own it is undecided — the
* action may be exactly what the question is about — so nothing in it is
* authority. Exported so the mutation gate and preparation consume the SAME
* qualification the reading produced instead of re-guessing scope from the split
* text, and so the rule is testable on its own.
*/
function isQuestionScopeNeedingReview(text) {
	const masked = maskCodeSpans(text);
	return governedReadingOf(masked) !== void 0 && governedClauseRestrictsExecution(masked);
}
/**
* A temporal interrogative: the clause asks WHEN, so its `when` is the question
* word, not a condition marker. A finite conditional clause states its own
* subject and verb instead ("when the tests pass").
*/
function isTemporalQuestion(masked) {
	if (!/[？?]\s*$/u.test(masked.trim())) return false;
	return /^\s*(?:when|何时|什么时候|什么时候)\s*(?:should|do|does|did|can|could|would|will|is|are|was|were|have|has|had|i|we|you|they|he|she|it|to)\b/iu.test(masked) || /^\s*(?:何时|什么时候|何时)/u.test(masked);
}
/**
* The quoted spans of a text, in every style the products accept: straight and
* curly double quotes, single quotes (opened only at a word boundary, so an
* English apostrophe never swallows a clause), and the CJK brackets 「」 and 『』.
*
* A quote OWNS its content and its punctuation: what it contains is never the
* clause's own reading or its own work, and a sentence mark inside it never ends
* the enclosing clause. `inside` is a per-code-unit map aligned with the input, so
* a scanner can ask whether an offset sits inside a quote.
*/
/** The characters after which a single quote OPENS a quotation rather than being
*  an apostrophe ("'Install foo…'", "the user's file"). */
const QUOTE_OPENING_BOUNDARY = /* @__PURE__ */ new Set(" 	\n:：,，、(（[【—");
/** Whether a single quote at the offset opens a quotation instead of an apostrophe. */
function isQuoteOpeningBoundary(text, cursor) {
	if (cursor === 0) return true;
	return QUOTE_OPENING_BOUNDARY.has(text[cursor - 1]);
}
function quotedSpans(text) {
	const inside = Array.from({ length: text.length }, () => false);
	let masked = "";
	let closer;
	for (let cursor = 0; cursor < text.length; cursor += 1) {
		const character = text[cursor];
		if (closer !== void 0) {
			inside[cursor] = true;
			masked += " ";
			if (character === closer) closer = void 0;
			continue;
		}
		const opens = character === "\"" ? "\"" : character === "“" ? "”" : character === "「" ? "」" : character === "『" ? "』" : character === "‘" ? "’" : character === "'" && isQuoteOpeningBoundary(text, cursor) ? "'" : void 0;
		if (opens !== void 0) {
			closer = opens;
			inside[cursor] = true;
			masked += " ";
			continue;
		}
		masked += character;
	}
	return {
		masked,
		inside
	};
}
/** Blank out every quoted span of the text. */
function maskQuotedSpans(text) {
	return quotedSpans(text).masked;
}
/** Whether the offset lies inside a quoted span. */
function insideQuote(masked, index) {
	return quotedSpans(masked).inside[index] === true;
}
/**
* Whether the clause's OWN span asks something, even when no governed head was
* recognised. This is the fail-closed half of the qualification: a clause whose
* question content the reader could not classify (`I wonder whether …`, a
* postposed 是否可行, a stray question mark) is still a scope that cannot host
* execution authority. Code spans, quotes and subordinate spans do not count:
* their content belongs to them, not to the clause.
*/
function clauseAsksOwnQuestion(text) {
	const own = withoutSubordinateQuestions(maskCodeSpans(maskQuotedSpans(text)));
	if (REBIND_DIRECTIVE.test(own.trim())) return false;
	if (/[？?]/u.test(own)) return true;
	const marker = GOVERNED_QUESTION_MARKER.exec(own);
	if (marker === null) return false;
	if (!/^[A-Za-z]/.test(marker[0])) return true;
	const head = own.replace(/^[\s,，、；;]*(?:(?:并且|以及|而后|然后|接着|并|且|和|与|及)|(?:and|then|but|also|next|so)\b)?[\s,]*/iu, "");
	const reported = /\b(?:wonder|wonders|wondering|ask|asks|asking|unsure|know|knows|recall|decide|decides|determine|determines|figure\s+out|find\s+out|establish|confirm|verify|check|see|not\s+sure|no\s+idea)\b/iu.test(own.slice(0, marker.index));
	return GOVERNED_QUESTION_MARKER.exec(head)?.index === 0 || INTERROGATIVE_AUXILIARY_LEAD.test(own.trim()) || reportingHeadGoverns(own) || reported;
}
/**
* Whether the clause is a DIRECTIVE: an imperative in the root's voice. The action
* must OPEN the clause once the request preface is consumed ("重启 api 服务。",
* "Then restart service api.", "请更新插件"), and the clause must not be a report
* or a third-party statement ("The technicians restart service api every night.",
* "日志显示运维人员重启 api 服务。").
*/
function opensWithDirective(masked) {
	const own = maskCodeSpans(maskQuotedSpans(masked));
	if (REBIND_DIRECTIVE.test(own.trim())) return true;
	const stripped = stripDirectivePreface(own);
	const verb = firstActionVerb(stripped);
	const fronted = verb > 0 && /^(?:(?:由|让|请|给|对|把|将|在|从|按|按照|根据|依|替|帮)[^，,。；;！!？?]*|(?:明天|今天|后天|今晚|明早|现在|马上|立即|稍后|待会儿?|之后|以后|下周|本周|最近|尽快)[^，,。；;！!？?]*)$/u.test(stripped.slice(0, verb));
	if (verb !== 0 && !fronted) return false;
	if (mainClauseTailReport(stripped) || NARRATIVE_DIRECTIVE.test(stripped)) return false;
	if (descriptivePredicate(stripped)) return false;
	return true;
}
/**
* Whether the clause's MATRIX predicate is descriptive. The test reads the clause up
* to its first English relative/interrogative marker, so a relative clause
* ("Create a file where logs are stored") is not mistaken for a copula.
*/
function descriptivePredicate(stripped) {
	const matrix = stripped.split(/[，,；;。！!？?]|\b(?:which|who|whom|whose|that|where|when|why)\b/iu)[0] ?? stripped;
	return DESCRIPTIVE_PREDICATE.test(matrix);
}
/**
* The copulas and descriptive links that turn an action-headed clause into a
* statement. Narrow on purpose: a modal or a bare verb is not one of them.
*/
const DESCRIPTIVE_PREDICATE = /(?:\p{Script=Han}|[^\p{L}])是(?:一种|一个|属于)?|(?:\p{Script=Han}|[^\p{L}])(?:属于|意味着|表示|表明|导致|会造成)|\b(?:is|are|was|were|means|causes|requires|leads\s+to)\b/iu;
/**
* The content a restatement introduces: the Y of "把 X 明确为 Y" / "record X as Y".
* Everything the restatement AUTHORIZES comes from this span, and nothing else.
*/
function restatedContentOf(text) {
	const own = maskCodeSpans(maskQuotedSpans(text));
	const marker = /(?:明确为|明确成|指定为|标记为|记为|设为|认作|重绑定为)/u.exec(own);
	if (marker !== null) {
		const restated$1 = own.slice(marker.index + marker[0].length).trim();
		return restated$1 === "" ? void 0 : restated$1;
	}
	const english = /\bas\b([\s\S]*)$/iu.exec(own);
	if (english === null) return void 0;
	const restated = (english[1] ?? "").trim();
	return restated === "" ? void 0 : restated;
}
/**
* Whether the restated content is a canonical operation SPEC: it OPENS with an
* operation the capture layer can act on (an imperative head, or a head token that
* resolves to a semantic action), without asking a question and without a
* descriptive predicate. Naming an action somewhere inside prose is not enough.
*/
function restatedContentIsOperation(content) {
	const body = content.replace(/^[\s,，、；;：:。.!！?？"'“”‘’「」『』]+/u, "").trim();
	if (body === "") return false;
	if (clauseAsksOwnQuestion(body)) return false;
	if (descriptivePredicate(body)) return false;
	if (firstActionVerb(body) === 0) return true;
	const head = semanticActionFromText(/^[A-Za-z][A-Za-z0-9_@.-]*/u.exec(body)?.[0] ?? body.slice(0, 2));
	return head !== "generic_run" && head !== void 0;
}
/** The span a restatement CLARIFIES: everything before its marker. */
function clarifiedSpanOf(text) {
	const own = maskCodeSpans(maskQuotedSpans(text));
	const marker = /(?:明确为|明确成|指定为|标记为|记为|设为|认作|重绑定为)/u.exec(own);
	if (marker !== null) {
		const clarified$1 = own.slice(0, marker.index).trim();
		return clarified$1 === "" ? void 0 : clarified$1;
	}
	const english = /\bas\b/iu.exec(own);
	if (english === null) return void 0;
	const clarified = own.slice(0, english.index).trim();
	return clarified === "" ? void 0 : clarified;
}
/** Whether the clause is an explicit re-statement of what an obligation means. */
function isRestatement(text) {
	return REBIND_DIRECTIVE.test(maskCodeSpans(maskQuotedSpans(text)).trim());
}
/**
* The closed phrasing of an explicit re-statement: the root says what an earlier
* obligation is to mean. This is a directive even though its own verb is not an
* operation ("把 X 明确为 …", "clarify X as …").
*/
const REBIND_DIRECTIVE = /^\s*(?:请|麻烦|帮我)?\s*(?:把|将)[^。！？；，,]{1,40}?(?:明确为|明确成|指定为|标记为|记为|设为|认作|重绑定为)|^\s*(?:please\s+)?(?:clarify|treat|interpret|record|rebind)\b[^.!?]{0,48}?\bas\b/iu;
/** Consume the request prefaces a directive may carry in either language. */
function stripDirectivePreface(text) {
	let body = text.replace(/^[\s,，、；;：:。.!！?？]+/u, "");
	for (let step = 0; step < 4; step += 1) {
		const next = body.replace(/^(?:那么|然后|接着|随后|首先|先|再|也|请|麻烦|帮我|帮忙|并且|并|以及|同时|顺便|而后|且|和|与|及)\s*/u, "").replace(/^(?:and|then|also|next|first|finally|now|please|kindly|but|so)\b[\s,]*/iu, "").trim();
		if (next === body) break;
		body = next;
	}
	return body;
}
/**
* Whether the clause is a PROTECTED scope: a question, an explanation, an
* investigation, a reported question, a quote, or any span whose own question
* content the head reader could not classify. A protected scope is indivisible —
* no separator opens a child of it — and nothing inside it is execution authority.
*/
function clauseIsProtected(text) {
	return governedReadingOf(maskCodeSpans(maskQuotedSpans(text))) !== void 0 || clauseAsksOwnQuestion(text);
}
/** A clause nobody has questioned: its own reading is the authorization. */
const GRANTED_QUALIFICATION = {
	status: "granted",
	reason: "plain_instruction"
};
/** A record captured before the qualification existed: never granted by default. */
const LEGACY_QUALIFICATION = {
	status: "restricted",
	reason: "legacy_missing_qualification"
};
/** The question content of a clause that is not inside a quoted code span. */
const GOVERNED_QUESTION_MARKER = /是否|有没有|有没|能否|可否|要不要|该不该|为什么|为何|怎么|怎样|如何|什么|哪些|哪一种|哪个|谁|何时|什么时候|几时|多久|多少|吗|([\p{Script=Han}])不\1|\b(?:whether|what|which|who|whom|whose|when|where|why|how)\b/iu;
/** Purpose and relative spans, which carry their own content rather than the clause's. */
const SUBORDINATE_PURPOSE_ZH = /(?:为了|用来|以便|从而|进而|用于|好让)[\s\S]*$/u;
const SUBORDINATE_PURPOSE_EN = /\b(?:showing|recording|noting|checking|to|in order to)\s+[\s\S]*$/iu;
/**
* The clause text whose question content is the CLAUSE's own rather than a
* subordinate span's object. A purpose or participial span is set aside only when
* it carries the question content itself ("打包日志以便确认哪些请求失败",
* "Create a report showing whether the tests passed") — never when the question is
* the clause's own and an infinitive follows it ("Confirm whether it is safe to
* install foo and restart service api."), where setting the span aside would drop
* the actions into the answer lane.
*/
function withoutSubordinateQuestions(masked) {
	const strip = (pattern) => {
		masked = masked.replace(pattern, (span) => GOVERNED_QUESTION_MARKER.test(span) ? "" : span);
	};
	strip(SUBORDINATE_PURPOSE_ZH);
	strip(SUBORDINATE_PURPOSE_EN);
	return masked;
}
/**
* The governed reading of a clause, or `undefined` when the clause is a plain
* statement or instruction. The head tests are the closed grammatical classes the
* earlier rounds established; nothing here looks for a state word, an actor or a
* vocabulary verb, because absence of a pattern is never evidence of anything.
*/
function governedReadingOf(masked) {
	const own = withoutSubordinateQuestions(masked);
	if (reportingHeadGoverns(own)) return {
		head: "reporting",
		...markerOf(own)
	};
	if (INVESTIGATION_HEAD_PATTERN.test(own)) {
		const head = INVESTIGATION_HEAD_PATTERN.exec(own);
		if (markerOf(own).marker !== void 0 || FIRST_COORDINATOR.test(own.slice(head[0].length))) return {
			head: "investigation",
			...markerOf(own)
		};
		return;
	}
	const condition = prefixConditionIndex(own.toLowerCase());
	const conditioned = condition !== void 0 && conditionMarkerIsClauseLevel(masked, condition) && !isTemporalQuestion(masked) ? own.slice(0, condition) : own;
	if (QUESTION_LEAD.test(conditioned) || INTERROGATIVE_AUXILIARY_LEAD.test(conditioned.trim()) || A_NOT_A_LEAD.test(conditioned) || QUESTION_WITH_SUBJECT.test(conditioned)) {
		if (INTERROGATIVE_AUXILIARY_LEAD.test(conditioned.trim()) && !QUESTION_LEAD.test(conditioned) && !/[？?]\s*$/u.test(conditioned.trim()) && !A_NOT_A_LEAD.test(conditioned) && !QUESTION_WITH_SUBJECT.test(conditioned)) return void 0;
		const own$1 = markerOf(conditioned);
		return {
			head: "question",
			marker: own$1.marker ?? 0,
			markerLength: own$1.marker === void 0 ? 1 : own$1.markerLength
		};
	}
	if (/吗[\s。！？?]*$/u.test(own.trim()) || /呢[\s。！？?]*[？?][\s。！？?]*$/u.test(own.trim())) {
		const marker$1 = GOVERNED_QUESTION_MARKER.exec(own);
		return {
			head: "question",
			marker: marker$1?.index ?? 0,
			markerLength: marker$1?.[0].length ?? 1
		};
	}
	if (!englishInterrogativeIsMatrix(conditioned)) return void 0;
	const marker = GOVERNED_QUESTION_MARKER.exec(conditioned);
	if (marker) {
		const prefix = conditioned.slice(0, marker.index);
		if (/^[A-Za-z]/.test(marker[0])) {
			if (prefix.replace(/^[\s,，、；;]*(?:and|then|but|so)\b[\s,]*/iu, "").trim() !== "") return void 0;
		} else if (/^[\s,，、；;]*(?:并且|以及|并|且|和|与|及)/u.test(prefix) && !opensWithGovernedHead(prefix.replace(/^[\s,，、；;]*(?:并且|以及|并|且|和|与|及)/u, ""))) return;
		else {
			const joined = coordinationInside(prefix);
			if (joined !== null && opensWithWork(prefix.slice(joined.index + joined[0].length)) && !/[？?]\s*$/u.test(conditioned.trim())) return void 0;
		}
		return {
			head: "question",
			marker: marker.index,
			markerLength: marker[0].length
		};
	}
}
/** The clause's own question word, when it has one. */
function markerOf(own) {
	const marker = GOVERNED_QUESTION_MARKER.exec(own);
	return marker ? {
		marker: marker.index,
		markerLength: marker[0].length
	} : { markerLength: 0 };
}
/**
* Whether a QUESTION/EXPLANATION/INVESTIGATION head governs the clause: the one
* governance predicate every layer consumes (the partitioner, the classifier, the
* reading, and — through the stored qualification — the gate and preparation).
*/
function questionHeadsClause(masked) {
	return governedReadingOf(masked) !== void 0;
}
/** Whether the clause's own reading is a governed scope. */
function clauseIsGoverned(masked) {
	return governedReadingOf(maskCodeSpans(masked)) !== void 0;
}
/** The qualification the reader records for one clause. */
function qualificationOfClause(text) {
	const masked = maskCodeSpans(text);
	const own = maskQuotedSpans(masked).trim();
	if (REBIND_DIRECTIVE.test(own)) {
		const restated = restatedContentOf(own);
		if (restated === void 0 || isRestatement(restated)) return {
			status: "restricted",
			reason: "unproven_scope"
		};
		if (qualificationOfClause(restated).status === "granted") return GRANTED_QUALIFICATION;
		return restatedContentIsOperation(restated) ? GRANTED_QUALIFICATION : {
			status: "restricted",
			reason: "unproven_scope"
		};
	}
	const reading = governedReadingOf(maskQuotedSpans(masked));
	if (reading !== void 0) return {
		status: "restricted",
		reason: "governed_scope",
		governedBy: reading.head
	};
	if (clauseAsksOwnQuestion(text)) return {
		status: "restricted",
		reason: "unproven_scope"
	};
	if (!opensWithDirective(withoutSubordinateQuestions(maskQuotedSpans(masked)))) return {
		status: "restricted",
		reason: "unproven_scope"
	};
	return GRANTED_QUALIFICATION;
}
/**
* Whether the text OPENS with an action: the piece a coordination introduces
* ("并安装依赖", "and update the README") is a predicate, while "和皮肤" joins two
* objects. The head detection is the project's own action reader, so an object
* whose name is also a work verb ("是否需要更新") is not mistaken for one.
*/
function opensWithWork(text) {
	const head = text.replace(/^[\s,，、；;：:]*(?:(?:并且|以及|而后|然后|接着|并|且|和|与|及)|(?:and|then|but|also|next|so)\b)?[\s,]*(?:一下|下|一遍|一次|个)?[\s,]*/iu, "");
	return firstActionVerb(head) === 0 || introducesActionClause(head);
}
/** An action named by the text, whatever vocabulary it comes from. */
function namesWork(text) {
	return firstActionVerb(text) >= 0 || introducesActionClause(text) || namesActionSpan(text);
}
/**
* Whether a GOVERNED clause carries work that its own question does not bound, so
* that the clause must stay undecided rather than enter the answer lane.
*
* The test is structural and vocabulary-free in the direction that matters:
*
* - a coordination AFTER the clause's own question word puts the coordinated part
*   inside the question's scope ("…是否安装 foo 并重启 api 服务"), so the whole
*   clause is undecided whatever the verbs are;
* - material BEFORE the question word that carries an action is the questioned
*   span itself ("检查一下[安装 foo 并重启 api 服务]是否安全"), so it is undecided;
* - a governed head with no question word of its own is undecided as soon as it
*   names an action ("Check the safety of installing foo and restart service
*   api.", "Explain the incident, rotate every credential").
*
* A pure question — the object list of "检查一下本地插件和皮肤是否有更新", a state
* question like "检查是否有新版本。" — carries none of these and stays answerable.
*/
function governedClauseRestrictsExecution(text) {
	const masked = maskCodeSpans(text);
	const reading = governedReadingOf(maskQuotedSpans(masked));
	if (reading === void 0) return clauseAsksOwnQuestion(text);
	const own = withoutSubordinateQuestions(masked);
	if (reading.marker === void 0) {
		if (reading.head === "reporting") return true;
		const body = headBodyOf(own);
		return namesWork(body) || coordinationInside(body) !== null;
	}
	if (reading.head === "reporting") {
		if (opensWithWork(own.slice(reading.marker + reading.markerLength)) || opensWithWork(headBodyOf(own.slice(0, reading.marker)))) return true;
	}
	const markerEnd = reading.marker + reading.markerLength;
	const tail = own.slice(markerEnd);
	const after = coordinationInside(tail);
	if (after !== null) {
		const rest = tail.slice(after.index + after[0].length).trim();
		if (!BARE_QUESTION_CONTINUATION.test(tail.trim()) && !BARE_QUESTION_CONTINUATION.test(rest)) return true;
	}
	const questioned = own.slice(0, reading.marker);
	const inside = coordinationInside(questioned);
	if (inside === null) return false;
	const left = headBodyOf(questioned.slice(0, inside.index));
	const right = questioned.slice(inside.index + inside[0].length);
	return opensWithWork(left) || opensWithWork(right);
}
/** An investigation whose complement is the declarative clause after `that`. */
const INVESTIGATION_THAT = new RegExp(`^\\s*(?:${REQUEST_PREFACE}\\s*)?(?:${INVESTIGATION_HEAD})\\s+that\\b`, "iu");
/**
* The first coordinator that really joins two parts: a leading conjunction is a
* preface ("并且检查是否存在冲突。"), and a mark with nothing after it belongs to the
* sentence rather than to a coordinated part ("检查是否存在更新；").
*/
function coordinationInside(own) {
	const pattern = new RegExp(FIRST_COORDINATOR.source, "giu");
	let match;
	while ((match = pattern.exec(own)) !== null) {
		const before = own.slice(0, match.index).trim();
		const rest = own.slice(match.index + match[0].length).trim();
		if (before !== "" && rest !== "") return match;
		if (match[0].length === 0) break;
	}
	return null;
}
/** The clause text with its own governed head removed, so the head is not read as work. */
function headBodyOf(text) {
	const head = INVESTIGATION_HEAD_PATTERN.exec(text) ?? REPORTING_HEAD.exec(text);
	return head === null ? text : text.slice(head[0].length);
}
/**
* The comma/delimiter-bounded clause the cursor sits in: the piece a governed
* reading is decided on, so a question in one clause never swallows the order in
* the clause before it.
*/
function clauseAround(masked, cursor) {
	const marks = /[，,、；;。！!？?\n\r]/gu;
	let start = 0;
	for (const match of masked.matchAll(marks)) {
		if (match.index >= cursor) break;
		start = match.index + match[0].length;
	}
	let end = masked.length;
	for (const match of masked.matchAll(marks)) if (match.index >= cursor) {
		end = match.index;
		break;
	}
	if (/^[？?！!。.]+[\s]*$/u.test(masked.slice(end))) end = masked.length;
	return masked.slice(start, end);
}
/**
* Whether the text is ONE clause: no delimiter inside it other than the sentence
* mark that closes it. A governed clause is indivisible; a run of clauses is not,
* because each piece qualifies itself.
*/
function isSingleClause(text) {
	const inner = maskQuotedSpans(text).trim().replace(/[。．.！!？?；;]+$/u, "");
	return !/[，,、；;。！!？?\n\r]/u.test(inner);
}
/**
* Whether the text OPENS with a governed head (a question, an explanation or an
* investigation that asks). Such a head governs its own sentence, so nothing
* coordinated inside that sentence opens an execution child of its own.
*/
function opensWithGovernedHead(masked) {
	const own = withoutSubordinateQuestions(masked.replace(/^[\s,，、；;]*(?:and|then|but|so)\b[\s,]*/iu, ""));
	return reportingHeadGoverns(own) || INVESTIGATION_HEAD_PATTERN.test(own) || QUESTION_LEAD.test(own) || INTERROGATIVE_AUXILIARY_LEAD.test(own.trim()) || A_NOT_A_LEAD.test(own) || QUESTION_WITH_SUBJECT.test(own);
}
/** The UTF-16 code units that may join two predicates of ONE clause. */
function isCoordinatorMark(character) {
	return character === "并" || character === "且";
}
/**
* The first coordinator inside one clause, in either language.
*/
const FIRST_COORDINATOR = /(?:^|[^A-Za-z0-9_])(?:and|then|but)\b|,|，|、|；|;|并且|以及|并|且|和|与|及/iu;
/** Whether the text OPENS with an investigation imperative. */
const INVESTIGATION_HEAD_LEAD = new RegExp(`^\\s*(?:${INVESTIGATION_HEAD})`, "iu");
/** The investigation imperatives that can head a clause. */
const INVESTIGATION_HEAD_PATTERN = new RegExp(`^\\s*(?:${REQUEST_PREFACE}\\s*)?(?:${INVESTIGATION_HEAD})`, "iu");
/**
* Whether a coordinated part after the first is an ORDERED part rather than the
* question's own continuation. A bare interrogative adverb ("and why", "为什么")
* continues the question; anything else is a second instruction, so the clause is
* not a pure information request.
*/
const BARE_QUESTION_CONTINUATION = /^[\s，,、；;：:]*(?:and\s+)?(?:why|how|what|which|who|whom|whose|when|where|whether|为什么|为何|怎么|如何|哪里|哪儿|哪些|什么|何时|谁)[.。！？!?]?$/iu;
function hasOrderedCoordination(masked) {
	return splitTextFragments(masked).slice(1).some((part) => part.text.trim() !== "" && !BARE_QUESTION_CONTINUATION.test(part.text.trim()));
}
/**
* The Chinese A-不-A question form, whose 不 is the interrogative's reduplication
* and not a negator: 需不需要, 可不可以, 对不对, 是不是, 要不要, 该不该. It heads the
* clause when nothing precedes it, and it asks about the clause it closes when it
* follows a topic ("这份文档可不可以更新？").
*/
const A_NOT_A_LEAD = /^\s*(?:那么|然后|接着|随后|首先|先|再|也|请|麻烦|帮我|帮忙|并且|并|以及)?\s*([\p{Script=Han}])不\1/u;
/** A question whose subject pronoun stands before the interrogative ("你们如何…"). */
const QUESTION_WITH_SUBJECT = /^\s*(?:那么|然后|接着|随后|首先|先|再|也|请|麻烦|帮我|并且|并|以及)?\s*(?:你们|我们|你|我|他们|她们|它们|大家|团队|咱们)\s*(?:怎么|如何|怎样|为什么|为何|什么|哪些|哪|谁)/u;
/** @deprecated Use {@link isQuestionScopeNeedingReview}: the rule is not limited to explanations. */
const isExplanationScope = isQuestionScopeNeedingReview;
/**
* Whether a coordinated part of the explanation's sentence opens with an action
* of its own. Those are exactly the parts whose membership in the explanation
* cannot be decided from the surface, so they make the sentence undecided instead
* of answerable or executable. `masked` has code spans blanked, so an action that
* only appears inside backticks contributes nothing.
*/
function explanationHasActionResidue(masked) {
	return splitTextFragments(masked).slice(1).some((part) => part.text.trim() !== "" && fragmentOrdersWorkOnItsOwn(part.text));
}
function isInformationalFragment(masked) {
	if (!englishInterrogativeIsMatrix(masked)) return false;
	if (questionHeadsClause(masked)) {
		if (explanationHasActionResidue(masked)) return false;
		if (firstActionVerb(headBodyOf(masked)) === 0) return false;
		if (hasOrderedCoordination(masked)) return false;
		if (firstActionVerb(masked) < 0 && !QUESTION_WORD_PATTERN.test(masked)) return false;
		return true;
	}
	if (interrogativeTakesIfObject(masked)) return true;
	if (INVESTIGATION_THAT.test(masked)) return true;
	if (headOpensClause(INFO_OPENING, masked)) return true;
	if (QUESTION_LEAD.test(masked)) return true;
	if (fragmentOrdersWorkOnItsOwn(masked)) return false;
	if (endsOnInterrogative(masked)) {
		if (questionCoversWholeClause(masked)) return true;
		return !executionResidueBeforeQuestion(masked);
	}
	if (headOpensClause(REPORTED_QUESTION, masked)) return true;
	if (headOpensClause(INVESTIGATION_THEN_QUESTION, masked)) return true;
	if (headOpensClause(INVESTIGATION_OF_STATE, masked)) return true;
	return !firstActionVerb(masked) && QUESTION_ABOUT_CHANGE.test(masked);
}
/** The coordinating conjunctions that open a continued fragment. */
const COORDINATED_OPENING = /^(?:(?:并且|而且|以及|而后|随后|然后|接着|并|且)|(?:and|then|also|but|however|yet)\b)/iu;
/**
* Question CONTENT: the words that make a clause ask about something, without the
* bare question mark. Punctuation says where a sentence ends; content says
* whether the clause is a question at all.
*/
const QUESTION_CONTENT = /是否|是不是|为什么|为何|怎么|如何|什么|哪些|哪一种|哪个|多少|多久|能否|可否|要不要|该不该|由谁|是谁|吗|呢|\b(?:what|which|who|whom|whose|when|where|why|how|whether)\b/iu;
/** An interrogative auxiliary that opens the fragment ("Is there any update?"). */
const INTERROGATIVE_AUXILIARY_LEAD = /^(?:is|are|was|were|do|does|did|can|could|should|would|will|has|have|had)\b/iu;
/** Chinese text, for the stray-question-mark rule. */
const HAS_HAN$1 = /[\u3400-\u9fff]/u;
/**
* Whether a fragment orders work ON ITS OWN, regardless of the mark that ends it
* and regardless of whether the splitter left a coordinating conjunction on its
* head.
*
* Two things have to hold: the fragment asks nothing (no question word and no
* interrogative auxiliary), and it carries an action head — a Chinese action
* head, a verb the vocabulary knows, or a Latin word the vocabulary does NOT
* know ("archive the logs?"). The unknown case is the one that kept escaping: a
* question word earlier in the message, or the sentence's own question mark,
* must never hand a clause with its own verb to the answer lane (review 5 F2,
* review 6 F1). A coordinated clause that is still an INVESTIGATION asks even
* behind the conjunction ("然后检查是否有新版本"), so the question forms are
* excluded first.
*/
function fragmentOrdersWorkOnItsOwn(masked) {
	const trimmed = masked.trim();
	if (!trimmed) return false;
	const opening = COORDINATED_OPENING.exec(trimmed);
	const rest = opening ? trimmed.slice(opening[0].length).replace(/^[\s，,、；;：:]+/u, "") : trimmed;
	if (!rest) return false;
	const question = QUESTION_CONTENT.exec(rest);
	if (question) {
		const before = rest.slice(0, question.index);
		if (!before.trim()) return false;
		if (!((introducesActionClause(before) || firstActionVerb(before) === 0) && !INVESTIGATION_HEAD_LEAD.test(before))) return false;
	}
	if (INTERROGATIVE_AUXILIARY_LEAD.test(rest)) return false;
	if (headOpensClause(INVESTIGATION_OF_STATE, rest)) return false;
	if (headOpensClause(INVESTIGATION_THEN_QUESTION, rest)) return false;
	if (headOpensClause(REPORTED_QUESTION, rest)) return false;
	if (headOpensClause(INFO_OPENING, rest)) return false;
	if (QUESTION_LEAD.test(rest)) return false;
	if (introducesActionClause(rest)) return true;
	if (firstActionVerb(rest) === 0) return true;
	if (HAS_HAN$1.test(rest) && /[？?]$/u.test(rest)) return true;
	return /^[A-Za-z][A-Za-z0-9_.-]*/.test(rest);
}
/** A yes/no question asks about the whole clause it closes. */
function questionCoversWholeClause(masked) {
	if (/(?:吗|呢)\s*[？?]?\s*$/u.test(masked)) return true;
	return INTERROGATIVE_AUXILIARY_LEAD.test(masked.trim());
}
/**
* The text before the clause's LAST question word, tested with the same
* structural rule that decides whether a fragment orders work of its own. This
* is the execution residue a trailing question does not govern.
*/
function executionResidueBeforeQuestion(masked) {
	const words = /什么|为什么|怎么|如何|哪些|哪一种|哪个|多少|多久|是否|是不是|能否|可否|要不要|该不该|由谁|是谁|\b(?:what|which|who|whom|whose|when|where|why|how|whether)\b/giu;
	let last;
	for (const match of masked.matchAll(words)) last = match.index;
	if (last === void 0 || last === 0) return false;
	return fragmentOrdersWorkOnItsOwn(masked.slice(0, last));
}
/** Boundaries that open a new coordinated fragment inside one clause run. */
const FRAGMENT_SEPARATORS = new Set([
	"，",
	",",
	"、",
	"；",
	";"
]);
/**
* An English coordinating conjunction used with NO punctuation. It opens the
* next fragment, so a mixed clause survives its own lack of commas.
*/
const CONJUNCT_BOUNDARY = /(?:^|[^A-Za-z0-9_])(?:and|then|but|however|yet|also)\b|(?:并且|以及|而后|随后)/iu;
/** Openings that continue a coordinated instruction list across a boundary. */
const FRAGMENT_SUBORDINATORS = [
	"但是",
	"不过",
	"然而",
	"同时",
	"并且",
	"而且",
	"以及",
	"然后",
	"接着",
	"而是",
	"但",
	"而",
	"也",
	"并",
	"且",
	"又",
	"再",
	"but",
	"and",
	"then",
	"also",
	"however",
	"yet"
];
function splitTextFragments(text, from = 0) {
	const fragments = [];
	let cursor = from;
	let start = from;
	const boundaryAt = (index) => {
		const character = text[index];
		if (FRAGMENT_SEPARATORS.has(character)) return index + 1;
		const match = CONJUNCT_BOUNDARY.exec(text.slice(index));
		if (match && match.index === 0) return index + match[0].length;
		if ((character === "并" || character === "且") && introducesActionClause(text.slice(index + 1))) return index + 1;
		if ((character === "并" || character === "且") && QUESTION_CONTENT.test(text.slice(0, index)) && !QUESTION_CONTENT.test(text.slice(index + 1))) return index + 1;
	};
	while (cursor < text.length) {
		const after = boundaryAt(cursor);
		if (after === void 0) {
			cursor += 1;
			continue;
		}
		let next = after;
		while (next < text.length && /\s/u.test(text[next])) next += 1;
		let head = next;
		for (const token of [...FRAGMENT_SUBORDINATORS].sort((left, right) => right.length - left.length)) if (text.startsWith(token, next)) {
			head = next + token.length;
			break;
		}
		pushFragment(fragments, text, start, head);
		start = head;
		cursor = head;
	}
	pushFragment(fragments, text, start, text.length);
	return fragments;
}
/**
* Record one fragment, trimmed of the separators that joined it to its
* neighbours. Trimming only moves the offset, so every character still belongs
* to exactly one fragment and a span audit keeps its exact positions.
*/
function pushFragment(fragments, text, from, to) {
	const raw = text.slice(from, to);
	const body = raw.trim().replace(/^[\s，,、；;]+/u, "").replace(/[\s，,、；;]*(?:and|then|but|however|yet|also)$/iu, "").replace(/[\s，,、；;]*(?:并且|且|并|以及|而后|随后)$/u, "").replace(/[\s，,、；;]+$/u, "");
	if (!body) return;
	fragments.push({
		text: body,
		offset: from + raw.indexOf(body)
	});
}
/**
* Whether the text after a coordinating conjunction opens a DISTINCT
* instruction: its own action head, optionally behind a connector and an
* actor. This is the rule the sentence splitter already used to decide that a
* conjunction joins two instructions rather than two objects, exposed so the
* fragment splitter cannot contradict it.
*/
function introducesActionClause(text) {
	const trimmed = text.replace(/^[\s，,、；;：:]+/u, "");
	return CROSS_CLAUSE_HEAD.test(trimmed) || DISTINCT_CLAUSE_HEAD.test(trimmed);
}
/**
* The masked text of one fragment. Fragments are trimmed, so their own reading
* is taken from their own bytes: a question ending that belongs to a LATER
* fragment ("更新插件，安装新主题，检查是否有更新吗？") never decides an
* earlier one, and the comma that joined them is not part of either.
*/
function fragmentMasked(scope, fragment) {
	return maskCodeSpans(scope.text.slice(fragment.offset, fragment.offset + fragment.text.length));
}
/** The scope a directive run is recorded from, with its own source offsets. */
function directiveScopeOf(text, masked, offset) {
	return {
		text,
		body: stripConnectors(text),
		directive: classifyPositive(text, masked),
		start: offset
	};
}
/**
* Whether a fragment states work of its own: it names a non-negated action verb
* anywhere inside it. A fragment that only names the OBJECT of the verb before
* it ("安装新主题和更新检查") is part of that instruction, not a second one,
* so the directive run stays one obligation.
*/
function bearsAction(masked) {
	for (const candidate of actionVerbMatches(masked)) if (!verbIsNegated(masked, candidate.index)) return true;
	return false;
}
/**
* Whether a fragment states work of its own OUTSIDE quoted data. The action
* vocabulary has no entry for "explain" and the pure-information route needs a
* real question, so an explanation whose only action sits inside a code span
* falls through to `unresolved` — never to `informational`, which delivery would
* auto-close. Reading the quote as a live order here would misclassify the
* clause in the other direction.
*/
function bearsLiveAction(masked) {
	return bearsAction(masked) || bearsAction(unmaskCode(masked));
}
/** The fragment with its quoted spans removed entirely, so only live words remain. */
function unmaskCode(masked) {
	return masked.replace(/`[^`]*`/g, " ");
}
/**
* Partition a directive run at its fragment boundaries (0.6.3 K1).
*
* A clause that orders work AND asks for information is two obligations, not
* one: "install the package, check whether an update exists, and write a
* report" must keep the install and the write beside a closable answer.
* Fragments that only continue the same instruction (a conjunct object list,
* an explanatory tail) are merged back, so the split is driven by the grammar
* of each fragment rather than by the punctuation between them.
*
* Returns `undefined` when the run is a single obligation, which keeps every
* ordinary instruction byte-identical to 0.6.2.
*/
function partitionClauseParts(scope, parts) {
	if (/[。！？!?；;\n\r]/u.test(parts[0].text)) return void 0;
	const informational = parts.map((part) => isInformationalFragment(fragmentMasked(scope, part)));
	if (informational.some((flag, index) => !flag && firstNegation(fragmentMasked(scope, parts[index])) !== void 0)) return;
	const work = informational.map((flag, index) => !flag && bearsLiveAction(fragmentMasked(scope, parts[index])));
	if (!work.some(Boolean) || !informational.some(Boolean)) return void 0;
	if (informational.every(Boolean)) return void 0;
	const segments = [];
	let cursor = 0;
	while (cursor < parts.length) {
		if (informational[cursor]) {
			let end$1 = cursor;
			while (end$1 + 1 < parts.length && informational[end$1 + 1]) end$1 += 1;
			const first = parts[cursor];
			const last$1 = parts[end$1];
			segments.push({
				text: scope.text.slice(first.offset, last$1.offset + last$1.text.length),
				offset: first.offset,
				informational: true
			});
			cursor = end$1 + 1;
			continue;
		}
		let start = cursor;
		while (start > 0 && !informational[start - 1] && !work[start - 1]) start -= 1;
		let end = cursor;
		while (end + 1 < parts.length && !informational[end + 1] && (work[end + 1] || !work[start])) end += 1;
		const last = parts[end];
		segments.push({
			text: scope.text.slice(parts[start].offset, last.offset + last.text.length),
			offset: parts[start].offset,
			informational: false
		});
		cursor = end + 1;
	}
	return segments.length > 1 ? segments : void 0;
}
/**
* Re-partition an informational scope (0.6.3 K1).
*
* An information span must cover a COMPLETE, execution-free information range.
* When a clause was read as information only because a question marker appeared
* somewhere inside it, the parts that order work are restored as their own
* clauses and the information scope is reduced to the fragments that really
* ask. Nothing is dropped: whatever the reading cannot positively classify
* stays `unresolved` through {@link classifyPositive}, which keeps the
* remaining obligation visible instead of swallowing it into the answer lane.
*
* Returns `undefined` when the whole scope really is a pure information
* request, which is the common case and stays byte-identical to 0.6.2.
*/
function refineInformationalScope(scope, masked) {
	const fragments = splitTextFragments(scope.text);
	if (fragments.length < 2) return void 0;
	const fragmentAsks = fragments.map((fragment) => isInformationalFragment(fragmentMasked(scope, fragment)));
	const informationalClause = isInformationalFragment(masked);
	const boundary = fragmentAsks.findIndex((asks) => asks !== informationalClause);
	if (boundary < 0) return void 0;
	const scopes = [];
	const headText = scope.text.slice(0, fragments[boundary].offset).replace(/[\s，,、；;]+$/u, "");
	if (headText.trim()) scopes.push({
		text: headText,
		body: stripConnectors(headText),
		directive: informationalClause ? "informational" : scope.directive,
		...scope.condition ? { condition: scope.condition } : {},
		start: 0
	});
	const tail = fragments[boundary];
	scopes.push(directiveScopeOf(scope.text.slice(tail.offset), masked.slice(tail.offset), tail.offset));
	return scopes;
}
const NEGATORS = [
	["不要", "zh"],
	["不用", "zh"],
	["不得", "zh"],
	["不许", "zh"],
	["不准", "zh"],
	["不能", "zh"],
	["不必", "zh"],
	["无需", "zh"],
	["毋须", "zh"],
	["勿", "zh"],
	["别", "zh"],
	["甭", "zh"],
	["不", "zh"],
	["do not", "en"],
	["does not", "en"],
	["did not", "en"],
	["don't", "en"],
	["doesn't", "en"],
	["won't", "en"],
	["can't", "en"],
	["cannot", "en"],
	["never", "en"],
	["avoid", "en"],
	["without", "en"],
	["no longer", "en"]
];
/** Characters that end one coordinated scope and may begin the next. */
const SEPARATORS = new Set([
	"，",
	",",
	"、",
	"；",
	";",
	"。",
	".",
	"！",
	"!",
	"？",
	"?",
	"：",
	":",
	"\n",
	"\r"
]);
const CONNECTORS = [
	"但是",
	"不过",
	"然而",
	"同时",
	"并且",
	"而且",
	"以及",
	"然后",
	"接着",
	"而是",
	"但",
	"而",
	"也",
	"并",
	"且",
	"又",
	"再",
	"就",
	"则"
];
const ENGLISH_CONNECTORS = [
	"but",
	"and",
	"then",
	"also",
	"however",
	"yet"
];
const CONNECTOR_PATTERN = `(?:${[...CONNECTORS].sort((a, b) => b.length - a.length).join("|")}|${ENGLISH_CONNECTORS.join("|")})`;
const CONTINUATION_AFTER_SEPARATOR = new RegExp(`^\\s*${CONNECTOR_PATTERN}`, "i");
/**
* Instruction openings that make the text after a bare conjunction its own
* clause. "并检查 GUI 效果" is a second instruction; "并在本地仓库记录" is
* handled separately as a locative, and anything else stays one object list.
*/
const CROSS_CLAUSE_HEAD = /^\s*(?:检查|查看|确认|验证|测试|运行|执行|安装|应用|更新|升级|记录|提交|推送|发布|部署|重启|重新启动|创建|新建|生成|修改|编辑|拉取|抓取|删除|回滚|清理|整理|实现|完成)/u;
/**
* Openings that make the text after a conjunction a DISTINCT instruction rather
* than the second half of one action. "并确认全部通过" completes the action
* before it, so 确认 is deliberately absent here.
*/
const DISTINCT_CLAUSE_HEAD = /^\s*(?:检查|查看|测试|验证|运行|执行|安装|应用|更新|升级|提交|推送|发布|部署|重启|重新启动|创建|新建|生成|修改|编辑|拉取|抓取|删除|回滚|清理|整理|记录|编写|撰写|实现)/u;
/**
* A place clause that follows a coordinating conjunction: the shape of "并在
* 本地仓库记录", where the conjunction joins an action to where it happens
* rather than to a second action.
*/
const LOCATIVE_CLAUSE = /^\s*在.{1,40}?(?:记录|保存|写入)$/u;
const USER_ACTOR_PATTERNS = [
	/(?:由|让|给|请)\s*(?:我|本人|我们)/,
	/(?:我|我们)(?:自己|本人)?\s*(?:来|去|会|将|要)?\s*(?:手动|亲自|自行)?\s*(?:重启|重新启动|升级|安装|更新|执行|运行|操作|完成|处理|部署|发布|推送|合并|确认|登录|审批|提供|准备|搭建|检查|验证|测试)/,
	/\bI(?:'ll| will| am going to| myself)\b/i,
	/\b(?:on my own|by myself)\b/i
];
const AGENT_ACTOR_PATTERNS = [
	/(?:由|让|请)\s*(?:你|您|助手|代理)/,
	/(?:你|您)(?:来|去|会|将|要|负责|自己)/,
	/\byou (?:should|must|need to|will|are to)\b/i
];
const OUTPUT_NOUN = /命令|脚本|指令|步骤|清单|说明|文档|模板|command|script|instructions?|checklist|snippet/i;
const OUTPUT_REQUEST = /(?:给|帮|替|为)(?:我|我们)?\s*(?:写|生成|整理|列|准备|提供|输出|来)|生成(?:一|两|几)?(?:条|个|份)|输出(?:一|个|份)?|列出|列一(?:下|个)|\b(?:provide|write|generate|outline|list|draft)\b|give\s+me/i;
const CONDITION_MARKERS = [
	["如果", "prefix"],
	["假如", "prefix"],
	["倘若", "prefix"],
	["若是", "prefix"],
	["一旦", "prefix"],
	["除非", "prefix"],
	["只有", "prefix"],
	["只要", "prefix"],
	["等到", "prefix"],
	["若", "prefix"],
	["在", "prefix"],
	["if", "prefix"],
	["unless", "prefix"],
	["once", "prefix"],
	["when", "prefix"],
	["provided that", "prefix"],
	["after", "prefix"],
	["之后", "suffix"],
	["以后", "suffix"],
	["才", "suffix"],
	["再", "suffix"]
];
const RESUME_MARKER = /(?:收到|得到|等到|等待|经)\s*.{0,12}?(?:明确|显式|最终)?\s*(?:回报|回复|答复|确认|批准|同意|授权|指示|通知)|(?:我|用户)(?:明确|最终)?\s*(?:确认|回复|回报|批准|同意|授权)(?:后再|之后|后|以后)?|after\s+(?:I|the user)\s+(?:confirm|reply|approve|authorize)|once\s+(?:I|the user)\s+(?:confirm|reply|approve)|waiting\s+for\s+(?:the\s+)?(?:user|you)/i;
/**
* The resumption event itself, without the request prefix a scope may open
* with. Used to locate the event inside a scope rather than at its start.
*/
const RESUMPTION_EVENT = /(?:收到|得到|等到|等待)\s*.{0,12}?(?:确认|回复|回报|批准|同意|授权|指示|通知)\s*(?:后再|之后|后|以后|再)|(?:我|用户)(?:明确|最终)?\s*(?:确认|回复|回报|批准|同意|授权)\s*(?:后再|之后|后|以后|再)|(?:after|once)\s+(?:I|the user)\s+(?:confirm|reply|approve|authorize)|waiting\s+for\s+(?:the\s+)?(?:user|you)/i;
/**
* A scope that OPENS with the resumption event it waits on. Anchored at the
* start and greedy, so the match runs to the end of the event itself
* ("收到我的确认后"): the condition is what the scope says after it.
*/
const RESUME_SCOPE_MARKER = /^(?:请在|请|麻烦|帮我|需要你|务必)?\s*(?:(?:收到|得到|等到|等待)\s*.{0,12}?(?:确认|回复|回报|批准|同意|授权|指示|通知)\s*(?:后再|之后|后|以后|再)|(?:我|用户)(?:明确|最终)?\s*(?:确认|回复|回报|批准|同意|授权)\s*(?:后再|之后|后|以后|再)|(?:after|once)\s+(?:I|the user)\s+(?:confirm|reply|approve|authorize)|waiting\s+for\s+(?:the\s+)?(?:user|you))/i;
const NARRATIVE_PAST = /(?:已经|已|刚刚|刚才|此前|之前)(?:经)?(?:推送|发布|提交|安装|升级|重启|合并|完成|修改|更新|删除|创建|写入)|\b(?:already|have|has|had)\s+(?:been\s+)?(?:pushed|published|committed|installed|upgraded|restarted|merged|completed|finished|modified|updated)\b/i;
/**
* Completion aspects that turn a clause into a report: a verb finished with
* 了/过/完了/好了 states what happened, so it orders nothing. A directive never
* carries them ("修改 README" is an order, "修改了 README" is a report).
*/
const NARRATIVE_ASPECT = /(?:完了|好了|过了)|(?:已经|已|刚刚|刚才|此前|之前)[\p{Script=Han}]{0,4}(?:了|过)|\b(?:was|were|has been|have been)\b/iu;
const NARRATIVE_DIRECTIVE = /请|需要你|帮我|麻烦|务必|\b(?:please|must)\b/i;
/**
* POSITIVE statement evidence (0.6.1 review): a clause with no resolvable
* action reads as a statement only when one of these structural markers is
* present — a passive (被/受到/遭到), a negator or progress marker
* ("不要"/"没有"/"尚未"/"还没"/"从未"), or an English declarative shape
* (finite aux/copula, or an article/possessive-led subject, which an
* imperative can never start with). Everything else defaults to `unresolved`:
* an unknown request ("Please sanitize these inputs", "处理这个问题") must
* never degrade to information, where the turn's answer would auto-close it —
* and no vocabulary can be complete, so the default never consults one.
*/
/**
* A completed confirmation receipt: the root reports that the event it was
* waiting for already happened. It reserves nothing, so it must not mint a
* wait, and it is not work either.
*/
const CONFIRMATION_RECEIPT = /^(?:我)?\s*(?:已|已经)?\s*(?:收到|得到|等到|等待)(?:了|过)?\s*(?:我|你|您|用户)?\s*的?\s*.{0,12}?(?:确认|回复|回报|批准|同意|授权|指示|通知)\s*(?:了|啦|过|收到)\s*[。．.!！]?$/u;
const SENTENCE_END = new Set([
	"。",
	"！",
	"？",
	"!",
	"?",
	"\n",
	"\r"
]);
/**
* An abbreviation whose own final period MAY continue the sentence: "e.g.",
* "i.e.", "cf.", "etc.", "vs.", "no.", "fig.", "approx.", the honorifics, and
* any dotted initialism ("a.m."). English abbreviations are a CLOSED class, so
* this is a protection list rather than a list of the words that may start a
* sentence — which is what the earlier repair got wrong: it decided the boundary
* from the NEXT word, so a lower-case request preface ("Install the package.
* please report what changed?") kept the run whole and the trailing question mark
* swallowed the install (review 5 F1).
*/
const ABBREVIATION_BEFORE_PERIOD = /(?:^|[^A-Za-z])(?:e\.g|i\.e|c\.f|cf|etc|vs|no|fig|eq|approx|Mr|Mrs|Ms|Dr|St|Jr|Sr|[A-Za-z]\.[A-Za-z])\.$/i;
/**
* Text that CONTINUES a sentence rather than starting one: a lower-case word, a
* digit, or a closing mark. This is the second half of the abbreviation rule —
* an abbreviation's period also ends a sentence when what follows opens a new
* one, and `etc.` at the end of a list is the ordinary case (review 6 F2).
*/
const CONTINUES_SENTENCE = /^[\p{Ll}\p{Nd}]/u;
/**
* A question opening. It is the tie-breaker for an abbreviation followed by a
* lower-case word: "e.g. the log" continues the sentence, while "etc. what
* changed?" starts a new one, because a question that follows an abbreviation
* must not be delivered with the execution range before it (review 6 F2).
*/
const QUESTION_OPENER = /^(?:what|which|who|whom|whose|when|where|why|how|whether|is|are|was|were|do|does|did|can|could|should|would|will|has|have|had|什么|为什么|怎么|如何|是否|是不是|哪|谁|哪个|哪些)/iu;
/**
* Whether an ASCII full stop at `index` ends a sentence.
*
* The 0.6.3 K1 repair found that `。`, `！` and `？` split a run while `.` did
* not, so "Install the package. What changed?" stayed ONE run, ended
* interrogatively and was read as pure information — the order was dropped and
* the record closed as answered. A period ends a sentence whenever whitespace
* and further text follow it, WHATEVER that text looks like, so no word list can
* widen the question's delivery range. Two things can keep the run whole: a
* period with no space after it (a decimal, a version number, a file name), and a
* period that belongs to an abbreviation AND is followed by a lower-case word,
* a digit or a closing mark. An abbreviation followed by a capital, a CJK
* character or an opening quote is a sentence end, because a boundary the
* reading cannot resolve must never let the sentence's own question mark decide
* an execution range it does not cover.
*/
function sentencePeriodEnd(text, index) {
	if (text[index] !== ".") return false;
	if (!/\s/u.test(text[index + 1] ?? "")) return false;
	const rest = text.slice(index + 1).replace(/^\s+/u, "");
	if (!rest) return false;
	if (!ABBREVIATION_BEFORE_PERIOD.test(text.slice(0, index + 1))) return true;
	if (QUESTION_OPENER.test(rest)) return true;
	return !CONTINUES_SENTENCE.test(rest);
}
function isWordBoundary(text, index) {
	if (index <= 0) return true;
	return !/[\p{L}\p{N}_]/u.test(text[index - 1]);
}
/**
* The first negator in `text` at or after `from`.
*
* A multi-word English negator is matched at BOTH of its words ("do not"), so a
* caller scanning for a negated verb does not have to know where the phrase
* began. `index` 0 is always a boundary; later positions are boundaries only
* when the preceding character is not a word character.
*/
function firstNegation(text, from = 0) {
	for (let cursor = from; cursor < text.length; cursor += 1) {
		const token = negatorAt(text, cursor);
		if (token) return {
			index: cursor,
			token
		};
	}
}
/** Match a negator at exactly `index`, the longest alternative winning. */
function negatorAt(text, index) {
	const lower = text.toLowerCase();
	const candidates = NEGATORS.filter(([token]) => lower.startsWith(token, index)).sort((a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0]));
	for (const [token] of candidates) {
		const bu = token.indexOf("不");
		if (bu >= 0) {
			const at = index + bu;
			if (text[at - 1] !== void 0 && text[at - 1] === text[at + 1]) continue;
		}
		if (token === "不" && /[\u3400-\u9fff]/.test(text[index + 1] ?? "")) {
			const isQuestionForm = text[index + 1] === "是" || text[index + 1] === "错";
			const opensClause = !/[\u3400-\u9fffA-Za-z0-9_]/.test(text[index - 1] ?? "");
			const joinedToAction = firstActionVerb(text, index + 1, index + 5) >= 0;
			if (isQuestionForm && !opensClause && !joinedToAction) continue;
		}
		if (token.length === 1 && /[\u3400-\u9fff]/.test(token)) {
			if (!/[\p{Script=Han}\p{L}\p{N}]/u.test(text[index + 1] ?? "")) continue;
		}
		if (/^[a-z]/.test(token)) {
			if (!isWordBoundary(text, index)) continue;
			if (/[\p{L}\p{N}_-]/u.test(text[index + token.length] ?? "")) continue;
			const after = text[index + token.length] ?? "";
			if (/[./@\\]/u.test(after) && !/\s/u.test(text[index + token.length + 1] ?? "")) continue;
		}
		return token;
	}
}
/**
* Index of the first action verb at or after `offset`.
*
* A vocabulary entry that a multi-character action immediately continues is the
* first character of that word rather than a verb of its own — the 升 of 升级,
* the 然 of 然后 — so the longer action is chosen instead. Without that rule
* "然后完成…" reads as two verbs and every condition analysis downstream anchors
* on the wrong one.
*/
function firstActionVerb(text, offset = 0, before = text.length) {
	const matches = actionVerbMatches(text, offset, before);
	return matches.length > 0 ? matches[0].index : -1;
}
/**
* Every action word in `[offset, before)`, ordered by position, with the words
* that are only a prefix of a longer action removed (the 升 of 升级, the 然 of
* 然后). The remaining candidates are the verbs an instruction can be about.
*/
function actionVerbMatches(text, offset = 0, before = text.length) {
	const span = text.slice(offset, before);
	const earliest = [];
	for (const pattern of [ACTION_VERB, WORK_VERB]) {
		const match = pattern.exec(span);
		if (match && !(match[0].length === 1 && /[A-Za-z]/.test(match[0]))) earliest.push({
			index: offset + match.index,
			length: match[0].length
		});
	}
	return earliest.sort((a, b) => a.index - b.index);
}
/**
* True when a negator's scope covers the verb starting at `index`.
*
* The negator has to be phrase-initial, so the 不 of 手动 and the 无 of 无论 are
* not read as bans; a contrast or list separator between the negator and the
* verb ends its scope ("不仅…而且运行" keeps the run positive).
*/
function verbIsNegated(text, index) {
	const ceiling = Math.min(index, 12);
	for (let back = 1; back <= ceiling; back += 1) {
		const at = index - back;
		const token = negatorAt(text, at);
		if (!token || at + token.length > index) continue;
		if (at > 0 && /[\u3400-\u9fff]/.test(text[at - 1])) continue;
		if (/[，,、；;。！!？?\n\r]/.test(text.slice(at + token.length, index))) continue;
		return true;
	}
	return false;
}
/** True when an unnegated operation verb occurs inside `[from, to)`. */
function hasPositiveVerb(text, from, to) {
	const index = firstActionVerb(text, from, to);
	if (index < 0) return false;
	return !verbIsNegated(text, index);
}
/**
* The verb a negator bans. A Chinese negator may put an adverb between itself
* and its verb ("不正式发布"), so candidate verbs are walked in order and the
* first one that is a real word rather than part of the preceding word wins.
*/
function bannedVerbIndex(text, afterNegator, before) {
	const span = text.slice(afterNegator, before);
	for (const word of CJK_VERB_WORDS) {
		const at = span.indexOf(word);
		if (at < 0) continue;
		return afterNegator + at;
	}
	const candidates = actionVerbMatches(text, afterNegator, before);
	for (const candidate of actionVerbMatches(text, 0, afterNegator)) candidates.push(candidate);
	if (candidates.length === 0) return -1;
	return candidates.map((candidate) => candidate.index).reduce((best, index) => Math.abs(index - afterNegator) < Math.abs(best - afterNegator) ? index : best);
}
/**
* A resumption condition: everything a scope says before the event that ends
* the wait ("收到我的确认后再推送" waits for the confirmation, so the push is
* not executable yet). Leading request words are not part of the condition, and
* a marker separated from the scope start by more than a clause belongs to a
* different statement.
*/
function resumptionConditionOf(scope) {
	const text = scope.text;
	if (scope.directive === "conditional") return text.replace(/^(?:请在|请|麻烦|帮我|需要你|务必)\s*/u, "").trim() || void 0;
	return leadingResumptionCondition(text, firstActionVerb(maskCodeSpans(text)) >= 0);
}
function leadingResumptionCondition(text, hasAction) {
	const masked = maskCodeSpans(text);
	const marker = RESUME_SCOPE_MARKER.exec(masked);
	if (!marker) return void 0;
	const guarded = masked.slice(marker[0].length).replace(/^[\s，,、：:]+/u, "").replace(/^(?:再|才|就|则|即)\s*/u, "").trim().replace(/[。．.!！?？]+$/u, "");
	if (guarded && /[；;。]/u.test(guarded)) return void 0;
	if (!hasAction) return void 0;
	return marker[0].replace(/^(?:请在|请|麻烦|帮我|需要你|务必)\s*/u, "").trim() || void 0;
}
/** End index of the negated span beginning at `start`. */
function negatedSpanEnd(text, start) {
	for (let cursor = start + 1; cursor < text.length; cursor += 1) {
		const character = text[cursor];
		if (character === "\n" || character === "\r") return cursor;
		if (character === "。" || character === "！" || character === "？" || character === "!" || character === "?") return cursor;
		if (character === "." && (cursor + 1 >= text.length || /\s/.test(text[cursor + 1]))) return cursor;
		if (character === "但" && text[cursor + 1] !== "是") return cursor;
		if (character === "而" && text[cursor + 1] === "是") return cursor;
		if (character === "；" || character === ";") return cursor;
		if (negatorAt(text, cursor)) return cursor;
		if (!SEPARATORS.has(character)) continue;
		const rest = text.slice(cursor + 1);
		if (CONTINUATION_AFTER_SEPARATOR.test(rest)) continue;
		if (character === "，" || character === "," || character === "、") return cursor + 1;
		if (hasPositiveVerb(text, cursor + 1, text.length)) return cursor;
	}
	return text.length;
}
/**
* Whether a run that follows a negator names an action directly ("推送、不
* 发布" → true, "任何改动" → false). Only the guard's own action surface counts:
* consultative verbs such as 完成 are deliberately absent, so "尚未完成" stays a
* statement instead of becoming a ban.
*/
function namesActionSpan(text) {
	const match = /^[^\p{Script=Han}A-Za-z]*([\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9_-]*)/u.exec(text);
	if (!match) return false;
	const head = match[1];
	for (const entry of COMMAND_SURFACE_MANIFEST.operationVerbs) if (new RegExp(`^(?:${entry.pattern})$`, "i").test(head)) return true;
	return false;
}
/**
* Split one message into scopes, in source order.
*
* The working list holds `[text, offset]` runs of the original message. A run is
* resolved into one scope as soon as a rule matches; otherwise the runner splits
* it into a head and a tail and pushes the tail back, so the split is iterative
* and no run is ever re-read out of order.
*
* A negation opens a scope covering every action it governs — the scope ends at
* a new positive verb, at a contrast, or (for a coordinated ban such as
* "不推送、不发布") at the end of the run. A separator that is *followed by a
* coordinating conjunction* also ends the current scope: "修复代码，但不推送"
* is a task plus a ban, while "更新皮肤中心并在本地仓库记录" stays one
* coordinated scope until the conjunction itself.
*/
function scopeOf(raw, options = {}) {
	const source = raw.trim();
	if (!source) return [];
	const pending = [{
		text: source,
		offset: 0
	}];
	const resolved = [];
	const emitted = /* @__PURE__ */ new Set();
	const push = (entry) => {
		const key = `${entry.offset}\u0000${entry.scope.directive}\u0000${entry.scope.text}`;
		if (emitted.has(key)) return;
		emitted.add(key);
		resolved.push(entry);
	};
	while (pending.length > 0) {
		const run = pending.pop();
		const text = run.text.trim();
		if (!text) continue;
		const inheritedCondition = run.inherited;
		const offset = run.offset + run.text.indexOf(text);
		const masked = maskCodeSpans(text);
		const conditionPrefix = prefixConditionIndex(masked.toLowerCase());
		const negation = firstNegation(masked);
		let earliestVerb = firstActionVerb(masked, conditionPrefix !== void 0 ? lastBoundaryIndex(text, conditionPrefix) : 0);
		if (earliestVerb < 0 && conditionPrefix !== void 0) {
			const tail$1 = expressionTailVerb(masked, conditionPrefix);
			if (tail$1 > conditionPrefix) earliestVerb = tail$1;
		}
		const negationIndex = negation ? negation.index : -1;
		const banScanEnd = masked.length;
		const bannedVerb = negation ? bannedVerbIndex(masked, negationIndex + negation.token.length, banScanEnd) : -1;
		const negationBansAction = negation !== void 0 && (bannedVerb >= 0 || namesActionSpan(masked.slice(negationIndex + negation.token.length, banScanEnd)));
		negation !== void 0 && bannedVerb >= 0 && /^[\s:：,，、]*$/u.test(masked.slice(negationIndex + negation.token.length, bannedVerb));
		const earliestNegation = negationBansAction ? negationIndex : -1;
		const earliestNegationToken = negationBansAction ? negation.token : "";
		const locativePrefix = conditionPrefix !== void 0 && text[conditionPrefix] === "在" && /^在.{1,24}?(?:记录|保存|写入|提交|运行|执行|测试|检查|验证|完成)/u.test(text.slice(conditionPrefix, earliestVerb));
		const temporalQuestion = conditionPrefix !== void 0 && isTemporalQuestion(masked);
		const openInvestigationComplement = conditionPrefix !== void 0 && clauseIsGoverned(masked);
		if (conditionPrefix !== void 0 && earliestNegation < 0 && !locativePrefix && !temporalQuestion && !openInvestigationComplement && !investigationHeadTakesIf(masked) && conditionMarkerIsClauseLevel(masked, conditionPrefix)) {
			const conditional = conditionSplit(text, conditionPrefix, earliestVerb, options);
			if (conditional) {
				for (const scope of conditional) push({
					scope,
					offset: offset + (scope.start ?? 0)
				});
				continue;
			}
		}
		if (earliestNegation >= 0) {
			const head$1 = text.slice(0, earliestNegation).trim();
			const end$1 = negatedSpanEnd(masked, earliestNegation);
			const banText = text.slice(earliestNegation, end$1).trim();
			const tail$1 = text.slice(end$1).replace(/^[\s。．.!！?？,，;；、]+/, "").trim();
			if (tail$1) pending.push({
				text: tail$1,
				offset: offset + end$1,
				...inheritedCondition ? { inherited: inheritedCondition } : {}
			});
			if (banText) {
				const clauseStart = conditionPrefix !== void 0 && conditionPrefix < earliestNegation ? lastBoundaryIndex(text, conditionPrefix) : -1;
				const conditionText = inheritedCondition ?? (clauseStart >= 0 ? stripConditionConnector(text.slice(clauseStart, earliestNegation)) : "");
				push({
					offset,
					scope: {
						text: banText,
						body: stripNegators(banText, earliestNegationToken) || banText,
						directive: "prohibition",
						...conditionText ? { condition: conditionText } : {}
					}
				});
				if (head$1 && (clauseStart < 0 || firstActionVerb(maskCodeSpans(head$1)) >= 0)) pending.push({
					text: head$1,
					offset
				});
			} else if (head$1) pending.push({
				text: head$1,
				offset
			});
			continue;
		}
		const end = positiveScopeEnd(masked, options);
		const head = text.slice(0, end).trim();
		const tail = text.slice(end).trim();
		if (tail) pending.push({
			text: tail,
			offset: offset + end
		});
		if (head) {
			const inherited = conditionPrefix !== void 0 && conditionPrefix < head.length && conditionMarkerIsClauseLevel(masked, conditionPrefix) ? text.slice(conditionPrefix, head.length).replace(/^[\s，,、；;：:]+/, "").trim() : "";
			push({
				offset,
				scope: {
					text: head,
					body: stripConnectors(head),
					directive: classifyPositive(head),
					...inherited ? { condition: inherited } : {}
				}
			});
		}
	}
	const seen = /* @__PURE__ */ new Set();
	return resolved.sort((a, b) => a.offset - b.offset).filter((entry) => {
		const key = `${entry.offset}\u0000${entry.scope.directive}\u0000${entry.scope.text}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	}).map((entry) => entry.scope).filter((scope) => /[\p{L}\p{N}]/u.test(scope.body) && /[\p{L}\p{N}]/u.test(scope.text)).flatMap((scope) => {
		if (isSingleClause(scope.text) && clauseIsProtected(scope.text) || opensWithGovernedHead(scope.text)) return [scope];
		const parts = splitTextFragments(scope.text);
		if (parts.length > 1) {
			const partitioned = partitionClauseParts(scope, parts);
			if (partitioned) return partitioned.flatMap((part) => {
				if (!part.informational) return [directiveScopeOf(part.text, maskCodeSpans(part.text), part.offset)];
				const information = informationScopeOf(scope, part);
				return refineInformationalScope(information, maskCodeSpans(information.text)) ?? [information];
			});
		}
		if (scope.directive !== "informational") return [scope];
		return refineInformationalScope(scope, maskCodeSpans(scope.text)) ?? [scope];
	});
}
/** The scope a partition records its information span with. */
function informationScopeOf(scope, part) {
	return {
		text: part.text,
		body: stripConnectors(part.text),
		directive: "informational",
		...scope.condition ? { condition: scope.condition } : {},
		start: part.offset
	};
}
function positiveScopeEnd(masked, options = {}) {
	const limit = masked.length;
	let cursor = 0;
	while (cursor < limit && (masked[cursor] === "，" || masked[cursor] === "," || masked[cursor] === "、" || masked[cursor] === "并" || masked[cursor] === "且" || /\s/u.test(masked[cursor]))) cursor += 1;
	while (cursor < limit) {
		const character = masked.slice(cursor, cursor + 1);
		if (SENTENCE_END.has(character) || character === "；" || character === ";" || character === "." && sentencePeriodEnd(masked, cursor)) {
			if (insideQuote(masked, cursor)) {
				cursor += 1;
				continue;
			}
			return cursor + 1;
		}
		if (opensWithGovernedHead(masked)) {
			cursor += 1;
			continue;
		}
		if (isCoordinatorMark(character) && clauseIsProtected(clauseAround(masked, cursor))) {
			cursor += 1;
			continue;
		}
		if (!(character === "，" || character === "," || character === "、" || character === "并" || character === "且")) {
			cursor += 1;
			continue;
		}
		const rest = masked.slice(cursor + 1);
		if (options.coordinationSplit === false) {
			cursor += 1;
			continue;
		}
		if (/^\s*(?:直到|直至|一直到)\s*/u.test(rest)) {
			cursor += 1;
			continue;
		}
		if (CONTINUATION_AFTER_SEPARATOR.test(rest)) return cursor + 1;
		if (/^\s*(?:由|让|请|给)\s*(?:你|您|我|本人)/u.test(rest)) return cursor + 1;
		CROSS_CLAUSE_HEAD.test(rest);
		const locative = LOCATIVE_CLAUSE.test(rest);
		const conjunctionSeparator = character === "并" || character === "且";
		const comma = character === "，" || character === ",";
		const enumeration = character === "、";
		if (comma) {
			if (!(conjunctionSeparator || CONTINUATION_AFTER_SEPARATOR.test(rest))) {
				cursor += 1;
				continue;
			}
			return cursor;
		}
		if (enumeration) {
			if (!locative) {
				cursor += 1;
				continue;
			}
			return cursor;
		}
		if (!(DISTINCT_CLAUSE_HEAD.test(rest) || locative)) {
			cursor += 1;
			continue;
		}
		return cursor;
	}
	return masked.length;
}
function conditionSplit(text, conditionPrefix, verb, options = {}) {
	const masked = maskCodeSpans(text);
	const lower = masked.toLowerCase();
	if (conditionPrefix === void 0) return suffixConditionSplit(text, lower, masked, options);
	if (verb < 0) return void 0;
	const candidates = conditionCandidates(text, lower, masked, conditionPrefix);
	if (candidates.length === 0) return void 0;
	const guardedScope = candidates[0];
	const markerIndex = guardedScope.start ?? 0;
	const guardedStart = guardedScope.start ?? 0;
	const condition = guardedScope.condition ?? "";
	if (!condition.trim() || !guardedScope.text.trim()) return void 0;
	const scopes = [];
	const clauseStart = lastBoundaryIndex(text, markerIndex);
	const lead = text.slice(0, clauseStart).trim();
	if (lead) scopes.push(...scopeOf(lead, options));
	const conditionClause = text.slice(clauseStart, guardedStart).trim();
	if (conditionClause) scopes.push({
		text: conditionClause,
		body: conditionClause,
		directive: "conditional",
		condition: condition.trim(),
		start: clauseStart
	});
	scopes.push({
		text: guardedScope.text.trim(),
		body: guardedScope.text.replace(/^[\s，,、；;：:]+/, "").replace(/^(?:才|再|就|则|即)\s*/, "").trim(),
		directive: "directive",
		condition: condition.trim(),
		start: guardedStart
	});
	return scopes;
}
/** Index just past the last clause separator at or before `index`. */
function lastBoundaryIndex(text, index) {
	let cursor = index;
	while (cursor > 0) {
		const character = text[cursor - 1];
		if (character === "在") break;
		if (character === "；" || character === ";" || character === "。" || character === "！" || character === "？" || character === "!" || character === "?" || character === "\n" || character === "\r") return cursor;
		cursor -= 1;
	}
	return 0;
}
/**
* A trailing condition marker ("…才…") needs no prefix marker when it sits
* directly before the action it guards: "收到我的明确回报后再继续".
*/
function suffixConditionSplit(text, lower, masked, options = {}) {
	const verb = firstActionVerb(masked);
	if (verb < 0) return void 0;
	const marker = /(?:之后|以后|后再|后才|再继续|才继续|再|才)/u.exec(text.slice(verb));
	if (!marker) return void 0;
	const condition = trimConditionTail(text.slice(0, verb + marker.index));
	const guarded = text.slice(verb + marker[0].length);
	if (!condition || !guarded.trim()) return void 0;
	return [{
		text: condition,
		body: condition,
		directive: "conditional",
		condition
	}, {
		text: guarded.trim(),
		body: guarded.replace(/^[\s，,、；;：:]+/, "").replace(/^(?:才|再|就|则|即)\s*/, "").trim(),
		directive: "directive",
		condition,
		start: verb + marker[0].length
	}];
}
/**
* The condition clauses inside one clause run, each paired with the action it
* guards. A marker that appears after the action's own verb but allows nothing
* before that verb is not a condition at all — "confirm" contains "if", and
* "We ship after the test passes" carries a subject the marker does not guard.
*/
function conditionCandidates(text, lower, masked, conditionPrefix) {
	const clauseStart = lastBoundaryIndex(text, conditionPrefix);
	const clause = lower.slice(clauseStart);
	const candidates = [];
	for (const [token, kind] of CONDITION_MARKERS) {
		if (kind !== "prefix" || token === "在") continue;
		const index = prefixIndexOf(clause, token);
		if (index < 0) continue;
		const absolute = clauseStart + index;
		if (firstNegation(masked.slice(absolute))) continue;
		let after = firstActionVerb(masked, absolute + token.length);
		if (after < 0) {
			const tail = expressionTailVerb(masked, absolute + token.length);
			if (tail >= absolute + token.length) after = tail;
		}
		const before = firstActionVerb(masked, clauseStart, absolute);
		if (after >= 0 && masked.slice(absolute + token.length, after).trim().length === 0) {
			candidates.push({
				markerAt: absolute,
				condition: trimConditionTail(text.slice(clauseStart, absolute)),
				guarded: text.slice(after),
				guardedAt: after
			});
			continue;
		}
		if (after < 0) {
			if (before < 0 || !/^(?:[\p{L}\p{N}]+[\s]*){0,3}[\p{L}\p{N}]+$/u.test(text.slice(clauseStart, absolute).trim())) continue;
			candidates.push({
				markerAt: absolute,
				condition: trimConditionTail(text.slice(absolute + token.length)),
				guarded: text.slice(clauseStart, absolute).trim(),
				guardedAt: clauseStart
			});
			continue;
		}
		if (absolute >= before && before >= 0) continue;
		candidates.push({
			markerAt: absolute,
			condition: trimConditionTail(text.slice(absolute + token.length, after)),
			guarded: text.slice(after),
			guardedAt: after
		});
	}
	if (candidates.length === 0) return [];
	const best = candidates.reduce((left, right) => right.markerAt < left.markerAt ? right : left);
	const guarded = {
		text: best.guarded.trim(),
		body: best.guarded.replace(/^[\s，,、；;：:]+/, "").replace(/^(?:才|再|就|则|即)\s*/, "").trim(),
		directive: "directive",
		condition: best.condition,
		start: best.guardedAt
	};
	return best.markerAt > 0 ? [guarded] : [guarded];
}
/**
* The condition a marker supplies: everything between the clause start and the
* guarded action, without the connector that introduces the ban ("除非…否则不要
* 合并" → "除非我明确说可以").
*/
function stripConditionConnector(value) {
	return value.replace(/^[\s，,、；;：:]+/, "").replace(/[\s，,、；;：:]*(?:否则|不然|then|otherwise)[\s，,、；;：]*$/i, "").trim();
}
/** Drop the temporal tail a condition marker may leave behind ("之后", "以后"). */
function trimConditionTail(value) {
	return value.replace(/[\s，,、；;：:]+$/, "").replace(/(?:之后|以后|后)$/, "").trim();
}
/**
* A known action word at the end of the clause, used when the guarded action is
* expressed as a plain Chinese verb: "若…才推送" ends in 推送, which the action
* surface does not treat as a verb because it is the object of 才. Only a closed
* vocabulary is accepted, so ordinary prose is never mistaken for an action.
*/
const BOUND_ACTION_TAIL = /(创建|生成|写入|修改|编辑|运行|执行|编写|撰写|部署|安装|升级|提交|下载|上传|拉取|同步|重启|测试|检查|验证|确认|修复|更新|清理|整理|记录|构建|编译|重构|迁移|删除|回滚|发布|推送|实现|合并|提交|回退|检查)[。．.!！?？,，;；、\s]*$/u;
function expressionTailVerb(masked, from) {
	const slice = masked.slice(from);
	const match = BOUND_ACTION_TAIL.exec(slice);
	return match ? from + match.index : -1;
}
/** Index of the first prefix condition marker, skipping a locative 在. */
function prefixConditionIndex(lower) {
	const head = lower;
	let best;
	for (const [token, kind] of CONDITION_MARKERS) {
		if (kind !== "prefix" || token === "在") continue;
		const index = prefixIndexOf(head, token);
		if (index < 0) continue;
		if (best === void 0 || index < best) best = index;
	}
	return best;
}
/**
* Word-bounded matcher per English marker, compiled once. Building the pattern
* inside the scan recompiled it for every marker of every scope, which
* dominated capture cost on long messages.
*/
const ENGLISH_MARKER_MATCHERS = /* @__PURE__ */ new Map();
function englishMarkerMatcher(token) {
	let matcher = ENGLISH_MARKER_MATCHERS.get(token);
	if (!matcher) {
		matcher = new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escapeRegExp(token)}(?![\\p{L}\\p{N}_])`, "iu");
		ENGLISH_MARKER_MATCHERS.set(token, matcher);
	}
	return matcher;
}
function prefixIndexOf(text, token) {
	if (/^[a-z]/.test(token)) {
		const match = englishMarkerMatcher(token).exec(text);
		return match ? match.index + (match[0].length - token.length) : -1;
	}
	if (token === "在") {
		const match = /在[^。！？；]{0,24}?(?:之前|以前)/.exec(text);
		return match ? match.index : -1;
	}
	return text.indexOf(token);
}
function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function stripNegators(text, matched) {
	let value = text.trim();
	value = value.replace(new RegExp(`^${CONNECTOR_PATTERN}\\s*`, "i"), "").trim();
	if (matched && value.toLowerCase().startsWith(matched.toLowerCase())) value = value.slice(matched.length);
	return stripNegatorsPrefix(value).trim();
}
function stripNegatorsPrefix(value) {
	let text = value;
	for (let guard = 0; guard < 8; guard += 1) {
		const trimmed = text.replace(/^[\s，,、；;：:]+/, "");
		let changed = trimmed !== text;
		text = trimmed;
		for (const [token] of NEGATORS) {
			if (!text.toLowerCase().startsWith(token.toLowerCase())) continue;
			if (/^[a-z]/.test(token) && /[\p{L}\p{N}_]/u.test(text[token.length] ?? "")) continue;
			text = text.slice(token.length);
			changed = true;
			break;
		}
		if (!changed) break;
	}
	return text;
}
function stripConnectors(text) {
	return text.replace(new RegExp(`^${CONNECTOR_PATTERN}\\s*`, "i"), "").trim();
}
/**
* Whether a past/aspect marker is the clause's ENTIRE predicate: the span
* extends to the end of the clause (only particles and punctuation may
* follow), so no modifier ("…的"), attributive chain, or coordinated demand
* can hide behind the report (0.6.1 review round 8: distance thresholds and
* coordinator lists cannot enumerate modifiers).
*/
function mainClauseTailReport(masked) {
	for (const pattern of [NARRATIVE_PAST, NARRATIVE_ASPECT]) {
		const match = pattern.exec(masked);
		if (!match) continue;
		if (/^[^，。；！？\s]*的/u.test(masked.slice(match.index + match[0].length))) continue;
		if (/^(?:了|过)?[。，；！？、\s.!?]*$/u.test(masked.slice(match.index + match[0].length))) return true;
	}
	return false;
}
function classifyPositive(text, preMasked) {
	const masked = preMasked ?? maskCodeSpans(text);
	if (governedClauseRestrictsExecution(masked)) return "unresolved";
	if (clauseIsGoverned(masked) && governedReadingOf(masked)?.marker !== void 0) return "informational";
	if (clauseAsksOwnQuestion(masked)) return "unresolved";
	const visibleVerb = firstActionVerb(masked);
	if (hasQuestionScope(masked)) return "informational";
	if (visibleVerb < 0) return "unresolved";
	if (interrogativeTakesIfObject(masked) && !explanationHasActionResidue(masked)) return "informational";
	if (mainClauseTailReport(masked) && !NARRATIVE_DIRECTIVE.test(masked)) return "narrative";
	if (CONFIRMATION_RECEIPT.test(masked.trim())) return "narrative";
	if (visibleVerb < 0) return "unresolved";
	const explain = EXPLAIN_VERB.exec(masked);
	if (explain && (visibleVerb < 0 || visibleVerb >= explain.index)) return "unresolved";
	if (/了[。，；！？、\s.!?]*$/u.test(masked)) return "unresolved";
	return "directive";
}
function executeeOf(text, directive) {
	if (directive !== "directive") return "unresolved";
	const masked = maskCodeSpans(text);
	if (USER_ACTOR_PATTERNS.some((pattern) => pattern.test(masked))) return "user";
	if (AGENT_ACTOR_PATTERNS.some((pattern) => pattern.test(masked))) return "agent";
	return "agent";
}
/** True when the scope asks for command/instruction TEXT rather than execution. */
function isOutputRequest(text) {
	const masked = maskCodeSpans(text);
	return OUTPUT_NOUN.test(masked) && OUTPUT_REQUEST.test(masked);
}
function dispositionOf(scope, executee) {
	if (scope.directive === "prohibition") return "prohibition";
	if (scope.directive === "unresolved") return "unresolved";
	if (scope.directive === "informational" || scope.directive === "narrative") return "informational";
	if (scope.directive === "conditional") return "conditional_wait";
	if (scope.condition) return "conditional_wait";
	if (executee === "user") return "human_actor";
	if (isOutputRequest(scope.text)) return "informational";
	return "executable_now";
}
function resumeEventOf(scope) {
	const match = RESUME_MARKER.exec(maskQuotedSpans(scope.condition ?? scope.text));
	return match ? match[0].trim() : void 0;
}
function interpret(scope) {
	const executee = executeeOf(scope.text, scope.directive);
	const resumption = scope.condition === void 0 && (scope.directive === "directive" || scope.directive === "conditional") ? resumptionConditionOf(scope) : void 0;
	const conditioned = resumption ? {
		...scope,
		condition: resumption
	} : scope;
	const qualification = qualificationOfClause(scope.text);
	const rawDisposition = dispositionOf(conditioned, executee);
	const authorityDisposition = qualification.status === "restricted" && rawDisposition === "executable_now" ? "unresolved" : rawDisposition;
	const resumeEvent = scope.directive === "directive" ? resumeEventOf(conditioned) : void 0;
	const method = scope.directive === "prohibition" ? void 0 : semanticMethod(scope.body);
	return {
		text: scope.text,
		body: scope.body,
		directive: scope.directive,
		executee,
		...conditioned.condition ? { condition: conditioned.condition } : {},
		...resumeEvent ? { resumeEvent } : {},
		immediatelyExecutable: authorityDisposition === "executable_now" && qualification.status === "granted",
		authorityDisposition,
		qualification,
		...method ? { method } : {},
		fingerprint: fingerprintOf([
			scope.text,
			scope.body,
			scope.directive,
			executee,
			authorityDisposition,
			qualification.status,
			qualification.reason,
			conditioned.condition ?? "",
			resumeEvent ?? "",
			method ?? ""
		].join("\0"))
	};
}
function semanticMethod(text) {
	const match = /(?:用|使用|通过|借助|利用|以)\s*([A-Za-z][A-Za-z0-9_-]*)/.exec(text) ?? /\b(?:via|using|use|with)\s+(?:the\s+)?([A-Za-z][A-Za-z0-9_-]*)/i.exec(text);
	return match ? match[1].toLowerCase() : void 0;
}
/**
* A short, stable identity for one interpretation: a content hash of the
* interpretation itself, so a replay of identical bytes reproduces it exactly
* and two different readings never collide.
*/
function fingerprintOf(source) {
	let hash = 2166136261;
	for (let index = 0; index < source.length; index += 1) {
		hash ^= source.charCodeAt(index);
		hash = Math.imul(hash, 16777619) >>> 0;
	}
	return `i${hash.toString(16).padStart(8, "0")}`;
}
/** Interpret one already-segmented clause. */
function interpretClause(text, options = {}) {
	const normalized = normalizeClause(text);
	const scopes = scopeOf(normalized, options);
	if (scopes.length === 0) return interpret({
		text: normalized,
		body: normalized,
		directive: "informational"
	});
	if (scopes.length === 1) return interpret(scopes[0]);
	const directive = scopes.some((scope) => scope.directive === "directive") ? "directive" : scopes.some((scope) => scope.directive === "prohibition") ? "prohibition" : scopes.some((scope) => scope.directive === "unresolved") ? "unresolved" : "informational";
	return interpret({
		text: normalized,
		body: scopes.map((scope) => scope.body).join("；"),
		directive
	});
}
/** Interpret a whole message into independent scopes, in source order. */
function interpretMessage(text, options = {}) {
	return scopeOf(normalizeClause(text), options).flatMap((scope) => splitTrailingResumption(scope)).map((scope) => interpret(scope));
}
/**
* Whether the item is an executable obligation right now. A prohibition is a
* standing constraint, a human-owned action belongs to the user, a conditional
* action waits for its condition, and an explanation is not work. None of them
* may block completion or be certified as agent work.
*
* An item without an interpretation is a legacy or fixture item created before
* this module existed; it keeps its historical executable reading.
*/
function isExecutableItem(item) {
	if (item.kind === "prohibition") return false;
	if (item.waitAuthorization !== void 0) return false;
	if (item.authorityDisposition === void 0) return true;
	if (item.authorityDisposition !== "executable_now") return false;
	return item.executee === void 0 || item.executee === "agent";
}
/**
* The ONE authority predicate the mutation gate and preparation both consume.
*
* A record holds execution authority only when the reader GRANTED it a
* qualification: a record with no qualification at all (captured before the
* qualification existed) is refused rather than read from its stored
* disposition, and a restricted record — anything a question, explanation,
* investigation, reported question or quote governs — keeps its work as an
* undecided obligation that authorizes nothing. Within a granted reading, the
* disposition still decides: a prohibition, a wait, a human actor, a condition or
* an information range is never a mutation. An `unresolved` GRANTED reading keeps
* the historical path documented for unrecognised instruction forms.
*/
function itemHoldsExecutionAuthority(item) {
	if (item.executionQualification === void 0) return false;
	if (item.executionQualification.status !== "granted") return false;
	if (item.authorityDisposition === void 0) return true;
	return item.authorityDisposition === "executable_now" || item.authorityDisposition === "unresolved";
}
/** Whether an item is an open obligation for certification purposes. */
function isOpenObligation(item) {
	return item.status === "pending" && isExecutableItem(item);
}
/**
* The action a scope names. `semanticActionFromText` maps the command surface,
* but a prohibition keeps a bare verb as its body ("不要提交并推送" → 提交并推送),
* and the closed CJK vocabulary is consulted first so such a ban is still
* recorded against the action it forbids.
*/
function semanticActionOfScope(body, source = body, isProhibition = false) {
	const masked = maskCodeSpans(source);
	const negation = isProhibition ? {
		index: 0,
		token: ""
	} : firstNegation(masked);
	if (negation) {
		const banned = bannedVerbIndex(masked, negation.index + negation.token.length, masked.length);
		if (banned >= 0) {
			const action = semanticActionFromText(CJK_VERB_WORDS.find((entry) => masked.startsWith(entry, banned)) ?? masked.slice(banned, banned + 2));
			if (action !== "generic_run") return action;
		}
	}
	return semanticActionFromText(body);
}
/**
* Split a scope whose action is stated after a resumption clause: "请先测试，
* 收到我的确认后再推送" runs the test now and reserves the push for the
* confirmation. Only a comma-separated split is used, so the earlier action
* keeps its own executable meaning and the later one waits.
*/
function splitTrailingResumption(scope) {
	if (scope.condition !== void 0 || scope.directive === "prohibition") return [scope];
	const masked = maskCodeSpans(scope.text);
	const marker = RESUMPTION_EVENT.exec(masked);
	if (!marker || marker.index === 0) return [scope];
	if (firstActionVerb(masked.slice(0, marker.index)) < 0) return [scope];
	const boundary = masked.slice(0, marker.index).search(/[，,][^，,]*$/);
	if (boundary < 0) return [scope];
	const head = scope.text.slice(0, boundary + 1).trim();
	const rest = scope.text.slice(boundary + 1).trim();
	if (!head || !rest) return [scope];
	if (firstActionVerb(maskCodeSpans(head)) < 0) return [scope];
	if (firstActionVerb(maskCodeSpans(rest)) < 0) return [scope];
	return [{
		text: head,
		body: head,
		directive: classifyPositive(head)
	}, {
		text: rest,
		body: rest,
		directive: "directive"
	}];
}
/**
* Every stateful action the clause names, in source order. A clause may order
* more than one ("安装插件，重启 DSH"); each is a separate evidence obligation
* even though the clause stays one top-level item.
*/
function statefulActionsOfScope(body) {
	const masked = maskCodeSpans(body);
	const found = [];
	const consider = (at, word) => {
		const action = semanticActionFromText(word);
		if (isStatefulAction(action)) found.push({
			at,
			action
		});
	};
	for (const word of CJK_VERB_WORDS) {
		let at = masked.indexOf(word);
		while (at >= 0) {
			consider(at, word);
			at = masked.indexOf(word, at + word.length);
		}
	}
	for (const match of masked.matchAll(/\b(?:install|apply|restart|reload|commit|push|publish|pull|fetch|create|modify|edit)\b/gi)) consider(match.index, match[0]);
	found.sort((a, b) => a.at - b.at);
	const ordered = [];
	for (const entry of found) if (ordered.at(-1) !== entry.action) ordered.push(entry.action);
	return ordered;
}
/** Actions this interpretation names, in source order (diagnostics only). */
function namedActions(text) {
	return interpretMessage(text).map((scope) => semanticActionOfScope(scope.body)).filter((action) => action !== "generic_run");
}

//#endregion
//#region src/domain/conversation.ts
/**
* Punctuation and whitespace that may surround a bare progression phrase
* without turning it into sentence content.
*/
const PUNCT = String.raw`[\s。，、；：！？．,;:!?\-*"'“”‘’()（）.…～~]`;
/**
* Session-layer phrases that acknowledge or advance the conversation without
* stating a task. Longer forms come first so the alternation consumes them
* before their prefixes. A bare whole-message acknowledgment ("当然。",
* "Of course.") is session talk: it is never captured as an obligation, so it
* can never block certification either.
*/
const PROGRESSION_SOURCE = String.raw`(?:继续执行|继续吧|请继续|继续|接着做|接着|下一步|没问题|知道了|明白了|了解|好的?|是的?|对的?|收到|可以|行|嗯+|当然|那当然|continue|go on|go ahead|keep going|proceed|okay|ok|yes|sure|right|next|of course)`;
const PROGRESSION_WHOLE = new RegExp(`^${PUNCT}*${PROGRESSION_SOURCE}${PUNCT}*$`, "i");
const PROGRESSION_LEAD = new RegExp(`^${PROGRESSION_SOURCE}${PUNCT}+`, "i");
const PROGRESSION_ANYWHERE = new RegExp(PROGRESSION_SOURCE, "gi");
/**
* Clause-leading prohibition keywords. A message that opens with one is a
* captured prohibition, never a meta comment.
*/
const PROHIBITION_LEAD = /^(?:(?:do not|don't|never)(?![A-Za-z0-9_./@\\-])|禁止|不要|不得)/i;
/**
* Question markers: a question mark, an interrogative pronoun/particle, or an
* explicit request-for-answer phrase.
*/
const QUESTION_TERMS = /[？?]|什么|为什么|怎么|如何|是否|是不是|哪|谁|啥|吗|呢|对不对|正常吗|bug吗|有问题吗|有必要|合理吗|可否|能否|能不能|请问|问一下/;
/**
* Meta-comment/objection leads (no question mark required). `不是` requires
* trailing punctuation so negated statements ("不是都要推送") stay fail-closed.
*/
const META_COMMENT_LEAD = /^(?:不是[，,。；;：:\s]|你(?:这|光|啥|怎么|什么|到底|就)|我(?:只是|就是|想|问|建议|认为|觉得)|这(?:有|什么)意义|有什么用|有什么意义)/;
/** Diagnostic/inspection verbs: mentioning them alone is never a task feature. */
const META_VERBS = /确认下|看看|看一下|想问|确认|验证|检查|查看|分析|解释|说明|排查|定位|诊断|评估|考虑|建议|讨论|复查|核对|盘点|复盘|问|看/g;
/**
* Operation verbs that indicate a real task effect. English verbs are
* word-bounded so "latest" does not contain "test". The classifier vocabulary
* is intentionally independent from the command-surface manifest.
*/
const OPERATION_VERBS = /创建|生成|新建|写入|修改|编辑|运行|执行|编写|撰写|起草|整理|总结|记录|更新|修复|改进|解决|处理|推送|发布|安装|升级|提交|下载|上传|拉取|同步|部署|重启|测试|写|\b(?:build|create|write|modify|run|fix|update|install|push|publish|test)\b/gi;
const NEGATIONS = /没有|并无|不存在|无需|不用|不需要|尚未|还未|没|未|不是/;
function excludedRanges(text) {
	const ranges = [];
	for (const pattern of [PROGRESSION_ANYWHERE, META_VERBS]) {
		pattern.lastIndex = 0;
		for (const match of text.matchAll(pattern)) {
			const start = match.index;
			ranges.push([start, start + match[0].length]);
		}
	}
	return ranges;
}
/** The negation filter is scoped to the clause (sentence or comma segment). */
function isNegatedInClause(text, verbStart) {
	const clause = text.slice(0, verbStart).split(/[。！？；.!?;，,\r\n]/).pop() ?? "";
	return NEGATIONS.test(clause);
}
function hasOperationVerb(text) {
	const excluded = excludedRanges(text);
	for (const match of text.matchAll(OPERATION_VERBS)) {
		const start = match.index;
		if (excluded.some(([from, to]) => start >= from && start < to)) continue;
		if (isNegatedInClause(text, start)) continue;
		return true;
	}
	return false;
}
function hasStrongTaskFeature(text) {
	if (extractArtifactPaths(text).length > 0) return true;
	if (extractMethod(text) !== void 0) return true;
	return hasOperationVerb(text);
}
/**
* Classify a direct user message (or one clause of it) as an actionable
* `instruction` or a session-layer `conversational` utterance. Only
* conversational results drop capture, so the classifier fails closed:
* everything it cannot confidently recognize as session-layer talk stays an
* instruction and is captured exactly as before.
*
* Order matters: progression and prohibition leads first, then strong task
* features (artifact path, explicit method, or a non-negated operation verb
* outside progression/meta spans), then the meta-question and meta-comment
* forms, and finally a progression lead over a featureless remainder.
*/
/**
* The message with every subordinate purpose span blanked out.
*
* A purpose clause is introduced by 为了/用来/以便/从而/进而/用于 or by an English
* `to <verb>`. The question words inside it belong to that span, so they must not
* be read as the message's own question. Only the span is masked, so an ordinary
* question elsewhere in the message is still seen.
*/
const SUBORDINATE_SPAN = /(?:为了|用来|以便|从而|进而|用于)[\s\S]*$|\bto\s+[a-z]+[\s\S]*$/iu;
function withoutSubordinateSpans(text) {
	return text.replace(SUBORDINATE_SPAN, "");
}
/**
* Question words that make a FRAGMENT an information request, English included.
* A bare question mark is deliberately NOT one: it belongs to the sentence, so a
* clause whose own head is an instruction keeps ordering work even when the
* sentence ends with "?".
*/
const FRAGMENT_QUESTION = /什么|为什么|怎么|如何|是否|是不是|哪|谁|啥|吗|呢|对不对|可否|能否|能不能|\b(?:what|which|who|whom|whose|when|where|why|how|whether)\b/i;
/** An interrogative auxiliary that opens the fragment ("Is it done?"). */
const QUESTION_AUXILIARY_LEAD = /^(?:is|are|was|were|do|does|did|can|could|should|would|will|has|have|had)\b/i;
/**
* English sentence heads that describe rather than order: determiners, pronouns
* and existentials. They are a closed grammatical class, so a Latin clause that
* opens with one is a statement ("The build failed"), not an unknown action.
*/
const ENGLISH_DESCRIPTIVE_HEAD = /^(?:the|a|an|this|that|these|those|it|its|they|them|their|we|our|you|your|i|my|he|she|his|her|there|here|nothing|nobody|someone|something|everyone|everything)\b/i;
/** A fragment written in Chinese, whatever Latin term it opens with. */
const HAS_HAN = /[\u3400-\u9fff]/u;
/** A request preface or coordinating conjunction that opens a continued clause. */
const SPOKEN_PREFIX = /^(?:(?:please|kindly|now|then|also|and|but|however|yet)\b[\s,]*|(?:请|麻烦|帮我|帮忙|那么|然后|接着|随后|首先|先|再|也|并且|而且|以及|而后|并|且)[\s，,]*)/i;
/**
* Whether one fragment orders work of its own.
*
* A fragment that asks nothing and still names an action is work the capture
* layer has to see. A Latin clause with its own head counts even when its verb is
* outside every vocabulary — `What changed, and archive the logs?` must keep the
* archive rather than disappear because the sentence asks a question (review 5
* F2) — while a Chinese statement that merely opens with a Latin term, and an
* English description that opens with a determiner or a pronoun, stay talk.
*/
function fragmentOrdersWork(fragment) {
	let body = fragment.trim();
	for (let step = 0; step < 3 && body; step += 1) {
		const next = body.replace(SPOKEN_PREFIX, "").trim();
		if (next === body) break;
		body = next;
	}
	if (!body) return false;
	const question = FRAGMENT_QUESTION.exec(body);
	if (question) {
		const before = body.slice(0, question.index).trim();
		if (!before) return false;
		if (/^[A-Za-z]/.test(before) && !ENGLISH_DESCRIPTIVE_HEAD.test(before)) return true;
		return actionHeadOf(before);
	}
	if (QUESTION_AUXILIARY_LEAD.test(body)) return false;
	return actionHeadOf(body);
}
/**
* The action-head test both layers share: a known operation verb, a Chinese
* action head, a Chinese clause that ends on a stray question mark, or a Latin
* head that is not a determiner/pronoun.
*/
function actionHeadOf(text) {
	if (hasOperationVerb(text)) return true;
	if (introducesActionClause(text)) return true;
	if (HAS_HAN.test(text) && /[？?]$/u.test(text)) return true;
	if (HAS_HAN.test(text)) return false;
	return /^[A-Za-z][A-Za-z0-9_.-]*/.test(text) && !ENGLISH_DESCRIPTIVE_HEAD.test(text);
}
/**
* Whether the message orders anything once its question-bearing fragments are
* set aside. A conversational verdict drops capture entirely, so it may only be
* reached when EVERY fragment either asks or says nothing: a question earlier in
* the message must not delete a later instruction (review 5 F2).
*
* The decomposition is the SEMANTIC layer's own: a fragment is split first at
* sentence punctuation and then by `splitTextFragments`, which is the same rule
* the capture path uses for coordinators and list separators. Splitting only on
* punctuation made the comma the whole difference between a kept obligation and
* a deleted one — `What changed and archive the logs?` lost the archive that
* `What changed, and archive the logs?` kept (review 6 F1).
*/
function ordersWorkBesideQuestion(text) {
	const sentences = [];
	const separators = /[，,；;。！!？?\n\r]+/gu;
	let cursor = 0;
	for (const match of text.matchAll(separators)) {
		sentences.push(text.slice(cursor, match.index + match[0].length));
		cursor = match.index + match[0].length;
	}
	if (cursor < text.length) sentences.push(text.slice(cursor));
	return sentences.filter((sentence) => sentence.trim() !== "").some((sentence) => {
		if (governedClauseRestrictsExecution(sentence)) return true;
		return splitTextFragments(sentence).some((fragment) => fragment.text.trim() !== "" && fragmentOrdersWork(fragment.text));
	});
}
function classifyUserInteraction(text) {
	const normalized = normalizeClause(text);
	if (!normalized) return "instruction";
	if (PROGRESSION_WHOLE.test(normalized)) return "conversational";
	if (PROHIBITION_LEAD.test(normalized)) return "instruction";
	if (hasStrongTaskFeature(normalized)) return "instruction";
	const questionScope = withoutSubordinateSpans(normalized);
	if (QUESTION_TERMS.test(questionScope)) {
		if (ordersWorkBesideQuestion(questionScope)) return "instruction";
		return "conversational";
	}
	if (META_COMMENT_LEAD.test(normalized)) return "conversational";
	if (PROGRESSION_LEAD.test(normalized)) return "conversational";
	return "instruction";
}
/**
* Inquiry verbs: the operation verb appears as the OBJECT of an
* investigation rather than an imperative ("是否有更新", "check whether…").
* The clause asks about state; it does not order a change.
*/
const INQUIRY_PATTERNS = [
	/(?:是否|有没有|有没|是否存在|是不是已经?|可曾|曾否)[^。！？；，,]{0,12}(?:更新|升级|提交|推送|发布|安装|修改|删除|修复|完成|同步|拉取|下载|重启|生成|写入)/,
	/(?:更新|升级|提交|推送|发布|安装|修改|删除|修复|完成|同步|拉取|下载|重启)(?:了)?(?:吗|么|没有|没)\s*[?？]?\s*$/,
	/^(?:检查|看看|查看|确认|了解|查一下|帮忙看)[^。！？；]{0,16}(?:是否|有没有|是否已经)/,
	/\b(?:is|are)\s+there\s+(?:any|an?)?\s*(?:update|updates|upgrade|commit|push|change|fix)/i,
	/\bcheck\s+(?:whether|if)\b/i,
	/\bwhether\b[^.?!]{0,24}\b(?:update|upgrade|commit|push|install|change)/i
];
/**
* Imperative leads that keep an ACTION reading even when the clause also
* contains an inquiry verb ("更新后检查" orders a change first).
*/
const ACTION_LEAD = /^(?:请\s*)?(?:更新|升级|提交|推送|发布|安装|修改|删除|修复|同步|拉取|下载|重启|生成|写入|创建|新建|运行|执行|部署)\b|^(?:please\s+)?(?:update|upgrade|commit|push|publish|install|modify|delete|fix|deploy|run|create)\b/i;
/**
* Separate intent layer (v0.5): whether the captured work is an inquiry about
* state or an ordered change. Intent NEVER drops capture or weakens
* protection — an inquiry keeps its original obligation; it only changes what
* certification support the diagnosis reports (inquiries are not machine
* certifiable by the current adapters and must not be re-bound).
*/
function classifyTaskIntent(text) {
	const normalized = normalizeClause(text);
	if (!normalized) return "action";
	if (ACTION_LEAD.test(normalized)) return "action";
	for (const pattern of INQUIRY_PATTERNS) if (pattern.test(normalized)) return "inquiry";
	return "action";
}

//#endregion
//#region src/domain/registry.ts
const MAX_REGISTRY_URL_LENGTH = 2048;
const ENCODED_SEPARATOR_OR_CONTROL = /%(?:0[0-9a-f]|1[0-9a-f]|7f|2f|5c)/i;
const ENCODED_DOT = /%2e/i;
function rawPath(value) {
	const authorityStart = value.indexOf("//");
	if (authorityStart < 0) return "";
	const afterAuthority = value.slice(authorityStart + 2);
	const slash = afterAuthority.indexOf("/");
	return slash < 0 ? "" : afterAuthority.slice(slash);
}
function hasControlOrBackslash(value) {
	return [...value].some((character) => {
		const code = character.charCodeAt(0);
		return character === "\\" || code <= 31 || code === 127;
	});
}
function safePath(path$1) {
	if (!path$1 || path$1 === "/") return true;
	if (path$1.includes("//") || ENCODED_SEPARATOR_OR_CONTROL.test(path$1) || ENCODED_DOT.test(path$1)) return false;
	return (path$1.endsWith("/") ? path$1.slice(0, -1) : path$1).split("/").slice(1).every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}
/**
* Canonical npm registry base. The canonical value is the only value persisted
* into requested/resolved/state tuples and is reused verbatim for npm argv.
*/
function canonicalRegistryBase(value, options = {}) {
	if (!value || value.length > MAX_REGISTRY_URL_LENGTH || value !== value.trim() || hasControlOrBackslash(value) || !safePath(rawPath(value))) return void 0;
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		return;
	}
	const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
	if (parsed.protocol !== "https:" && !(options.allowLoopbackHttp && parsed.protocol === "http:" && loopback)) return void 0;
	if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.hostname.endsWith(".")) return void 0;
	if (!safePath(parsed.pathname)) return void 0;
	parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/`;
	return parsed.toString();
}
/** npm's packument route preserves @ and escapes the scope separator. */
function npmEscapedPackageName(packageId) {
	return encodeURIComponent(packageId).replace(/^%40/i, "@").replace(/%2F/gi, "%2f");
}

//#endregion
//#region src/domain/spans.ts
/**
* 0.6.0 source-span helpers (C01).
*
* Spans are UTF-8 BYTE half-open intervals `[start, end)` inside the original
* root message text. All conversions go through TextEncoder byte counting —
* JavaScript string indices are never allowed to masquerade as cross-language
* positions, so a Python reader agrees with TypeScript on every boundary.
*/
const encoder = new TextEncoder();
function utf8ByteLength(text) {
	return encoder.encode(text).length;
}
/** Byte offset of `index` inside `text`: the UTF-8 length of the prefix. */
function utf8ByteOffset(text, index) {
	return utf8ByteLength(text.slice(0, index));
}
/**
* The coverage class of one captured clause: a prohibition is a constraint,
* an informational reading is a question, an adopted block stays adoption,
* and everything else is an instruction. Nothing captured is left unclassed.
*/
function spanClassOf(kind, directive, authority) {
	if (authority === "root_adoption") return "adoption";
	if (kind === "prohibition") return "constraint";
	if (directive === "informational" || directive === "narrative") return "question";
	return "instruction";
}

//#endregion
//#region src/domain/capture.ts
/**
* Whether a clause opens with an explicit ban. The lane question ("is this a
* constraint or a duty?") is answered by {@link ScopeInterpretation}; this stays
* exported because the framing/segmentation callers ask it directly.
*/
function classifyClause(text) {
	const [first] = interpretMessage(normalizeClause(text));
	return first ? kindOfScope(first.directive, first.body) : "requirement";
}
const METHOD_TOOL = "(?:bash|shell|powershell|pwsh|git|read|write|edit|node|python|python3|npm|pnpm|tsc|vitest)";
const METHOD_ALIASES = {
	powershell: "pwsh",
	python3: "python"
};
const METHOD_PATTERNS = [
	new RegExp(`(?:用|使用|通过|借助|利用|以)\\s*(${METHOD_TOOL})\\b`, "i"),
	new RegExp(`\\b(?:via|using|use|with)\\s+(?:the\\s+)?(${METHOD_TOOL})\\b`, "i"),
	new RegExp(`\\b(${METHOD_TOOL})\\s+(?:创建|写入|生成|修改|执行|运行|rename|create|write|modify)\\b`, "i")
];
/**
* Detect an explicitly named tool/method in a clause ("使用 bash 创建",
* "via bash", "bash to create"). Returns the canonical tool id (e.g. 'bash')
* or undefined when no explicit method is named.
*/
function extractMethod(text) {
	for (const pattern of METHOD_PATTERNS) {
		const match = text.match(pattern);
		if (match) {
			const raw = match[1].toLowerCase();
			return METHOD_ALIASES[raw] ?? raw;
		}
	}
}
const OPERATION_PATTERNS = COMMAND_SURFACE_MANIFEST.operationVerbs.map((entry) => [entry.op, new RegExp(entry.pattern, "i")]);
/**
* Whether a whole user message reads as an informational report (acceptance
* receipt, progress summary, pasted log) rather than a task instruction.
* Evaluation is deliberately conservative: reports are detected only when the
* shape is clearly report-like (markdown headings, bold key/value lines, list
* or table rows, evidence terms) AND no sentence opens with an imperative, and
* any question mark keeps the message a task. False positives here would drop
* real instructions, so plain short sentences are never treated as reports.
*/
function isInformationalMessage(text) {
	if (!text.trim()) return false;
	if (/[？?]|是否|是不是/.test(text)) return false;
	const lines = text.split(/\r?\n/);
	const titledLines = lines.filter((line) => /^\s{0,3}#{1,6}\s+/.test(line)).length;
	const evidenceLines = lines.filter((line) => /^\s*(?:[-*|]\s{0,2}|\*\*.+?\*\*)/.test(line)).length;
	const evidenceTerms = (text.match(/\b(?:commit|passed|failed|exit\s+code|checkpoint|verify|回执|汇总|状态|通过|全绿|验收|读回|回读)\b|✓|\b[0-9a-f]{40}\b/g) ?? []).length;
	if (!(titledLines >= 1 && evidenceTerms >= 2 || evidenceLines >= 2 && evidenceTerms >= 2 || evidenceTerms >= 4)) return false;
	const imperativeLead = /^(?:请|请你|麻烦|帮我|需要你|你看看|看一下|检查一下|分析|列出|回顾|修复|推送|安装|确认|验证|能否|能不能)/i;
	return !text.split(/(?<=[。！？；\n])|(?<=[.!?])(?=\s|$)/).some((sentence) => imperativeLead.test(sentence.trim()));
}
/**
* Detect an explicit operation/effect in a clause ("创建" → create,
* "读取" → read, "运行" → run). Returns the first operation named, or undefined
* when the clause requests no specific effect.
*/
function extractOperation(text) {
	for (const [operation, pattern] of OPERATION_PATTERNS) if (pattern.test(text)) return operation;
}
/**
* A target token, as a human writes it.
*
* A path and a bare word do not start the same way: "/work/repo" and "./repo"
* open with a separator, so a leading character class of letters, digits and
* "@" cannot match them at all, and the field silently falls back to an
* unrelated value. Paths therefore get their own branch, which requires the
* separator plus at least one more character — a lone "/" is punctuation, not
* a path.
*/
const TARGET_TAIL = "[\\p{L}\\p{N}@._/\\\\:+%?&=#\\[\\]-]";
const TARGET_TOKEN = `(?:\`[^\`]+\`|"[^"]+"|'[^']+'|${`[.~]*[\\\\/]${TARGET_TAIL}+`}|${`[\\p{L}\\p{N}@]${TARGET_TAIL}*`})`;
function unquoteTargetToken(value) {
	if (!value) return void 0;
	const trimmed = value.trim().replace(/[.,;，。；]+$/, "");
	const unquoted = /^(?:`([^`]+)`|"([^"]+)"|'([^']+)')$/.exec(trimmed);
	return (unquoted?.[1] ?? unquoted?.[2] ?? unquoted?.[3] ?? trimmed) || void 0;
}
/**
* The value of a labelled field ("repository X", "版本：1.2.3").
*
* The label must END where it ends: a label that is only a prefix of a longer
* word is skipped, so the literal word "repository" is never read as the label
* "repo" followed by the value "sitory".
*/
function labeledToken(text, labels) {
	const label = new RegExp(`(?:${labels})`, "iu");
	const after = new RegExp(`^(?:\\s*(?:[:=：]|为|是)\\s*|\\s+)(${TARGET_TOKEN})`, "iu");
	const OTHER_LABEL = /^(?:to|from|on|into|with|at|using|version|profile|registry|remote|refspec|branch|service|repository|repo|包|插件|制品|服务|仓库|版本|配置档|远端|分支|注册表)$/i;
	let cursor = 0;
	while (cursor <= text.length) {
		const match = label.exec(text.slice(cursor));
		if (!match) return void 0;
		cursor = cursor + match.index + match[0].length;
		const value = unquoteTargetToken(after.exec(text.slice(cursor))?.[1]);
		if (value && !OTHER_LABEL.test(value)) return value;
		if (cursor >= text.length) return void 0;
	}
}
/**
* Where a labelled field's VALUE sits in the text, so a value that another
* field owns can be excluded from a later bare-object reading. The object
* grammar and the field grammar overlap: "提交分支 release" names a BRANCH, and
* without this range the bare-object reader would offer "release" as the
* repository.
*/
/** Values that are another field's label or an action, never an identity candidate. */
const IDENTITY_STOP = /^(?:the|a|an|this|that|and|or|to|from|on|into|with|at|using|service|package|plugin|artifact|repository|repo|restart|reload|apply|install|包|插件|制品|服务|仓库|重启|重新启动|应用|安装|和|或|以及)$/iu;
/**
* EVERY value a label introduces in the span, normalized exactly as
* {@link labeledToken} normalizes its own result, and including a coordinated
* continuation list ("service api or worker" names two candidates).
*/
function labeledTokens(text, labels) {
	const label = new RegExp(`(?:${labels})`, "giu");
	const after = new RegExp(`^(?:\\s*(?:[:=：]|为|是)\\s*|\\s+)(${TARGET_TOKEN})`, "iu");
	const continuation = new RegExp(`^\\s*(?:or|and|或|和|以及|、|,|/)\\s*(${TARGET_TOKEN})`, "iu");
	const found = [];
	for (const match of text.matchAll(label)) {
		let cursor = match.index + match[0].length;
		let token = after.exec(text.slice(cursor));
		while (token) {
			const value = unquoteTargetToken(token[1]);
			if (value && !IDENTITY_STOP.test(value)) found.push(value);
			cursor += token[0].length;
			token = continuation.exec(text.slice(cursor));
		}
	}
	return [...new Set(found)];
}
/**
* Every identity candidate a span names for a SERVICE, across the surface forms the
* extractor accepts: the label-first form ("service api"), the verb-object form
* ("restart api service") and the noun-suffix form ("api 服务"), each with its
* coordinated continuations. The uniqueness check and the extractor therefore share
* one grammar and one normalization.
*/
function serviceCandidates(text) {
	const suffixed = [...text.matchAll(/([A-Za-z][A-Za-z0-9_-]*|\p{Script=Han}{1,6})\s*(?:服务|service)/giu)].map((match) => unquoteTargetToken(match[1])).filter((value) => value !== void 0 && !IDENTITY_STOP.test(value));
	for (const group of [
		labeledTokens(text, "service(?:_id)?|服务"),
		actionObjectTokens(text, "restart|reload|重启|重新启动", "service|服务"),
		[...new Set(suffixed)]
	]) if (group.length > 1) return group;
	return [];
}
/** Every identity candidate a span names for a PACKAGE, same grammar as the extractor. */
function packageCandidates(text) {
	const normalize = (value) => splitPackageSpec(value).packageId ?? value.trim();
	const groups = [[...new Set(labeledTokens(text, IDENTITY_LABELS.package).map(normalize))].filter((value) => value !== ""), [...new Set(actionObjectTokens(text, IDENTITY_LABELS.install, IDENTITY_LABELS.package).map(normalize))].filter((value) => value !== "")];
	for (const group of groups) if (group.length > 1) return group;
	return [];
}
function labeledTokenRange(text, labels) {
	const label = new RegExp(`(?:${labels})`, "iu");
	const after = new RegExp(`^(?:\\s*(?:[:=：]|为|是)\\s*|\\s+)(${TARGET_TOKEN})`, "iu");
	const OTHER_LABEL = /^(?:to|from|on|into|with|at|using|version|profile|registry|remote|refspec|branch|service|repository|repo|包|插件|制品|服务|仓库|版本|配置档|远端|分支|注册表)$/i;
	let cursor = 0;
	while (cursor <= text.length) {
		const match = label.exec(text.slice(cursor));
		if (!match) return void 0;
		cursor = cursor + match.index + match[0].length;
		const token = after.exec(text.slice(cursor));
		const value = unquoteTargetToken(token?.[1]);
		if (value && !OTHER_LABEL.test(value)) {
			const at = token ? cursor + token[0].indexOf(token[1]) : cursor;
			return {
				value,
				start: at,
				end: at + (token?.[1]?.length ?? value.length)
			};
		}
		if (cursor >= text.length) return void 0;
	}
}
/**
* The values a labelled field already claims. A bare-object reader must not
* re-read one of them as the object of the action.
*/
function labeledFieldValues(text) {
	const values = /* @__PURE__ */ new Set();
	for (const labels of [
		"branch|分支",
		"remote|远端",
		"refspec|引用规范"
	]) {
		const found = labeledTokenRange(text, labels);
		if (found) values.add(found.value);
	}
	return values;
}
/**
* The object a verb acts on. The verb is matched first, then — separately — an
* optional noun that has to end at a word boundary, and only the text AFTER
* that noun is the target. Matching the noun and the token in one pattern let
* the noun eat a prefix of the real word ("repository" consumed as "repo" +
* "sitory"), which captured "sitory" as a repository name.
*/
/** Fields a git instruction names BESIDES its repository. */
const GIT_SECONDARY_LABEL = "branch|分支|remote|远端|refspec|引用规范";
/**
* The repository candidates a clause names, in order. A candidate is a path or a
* Latin name that is spelled like a repository and is not a value another field
* already claims (`分支 main`, `remote origin`, `refspec refs/heads/main`). The
* current-repository deixis counts as a candidate too, so "当前仓库 与 /repo-c"
* offers two.
*
* An extension is NOT evidence of identity: a repository can be called
* `/repo-b.js`, and the root said 仓库. Filtering candidates by file extension
* made the first-object reading and the ambiguity rule contradict each other —
* `/repo-a` was accepted as a repository while `/repo-b.js` was silently dropped
* (review 6 F3). A file argument in another clause is excluded by the join rule
* instead: "提交仓库 /repo-a，运行 /tmp/script.sh" is not a coordinator list.
*/
const REPOSITORY_TOKEN_SCAN = /[/\\~][^\s，,、；;。！？!?]+|[A-Za-z][A-Za-z0-9._-]*/gu;
const CURRENT_REPOSITORY_PHRASE = /当前(?:目录|文件夹|仓库|项目|工作区)|这个仓库|该仓库|本仓库|this\s+(?:repo|repository|project)|current\s+(?:repo|repository|directory|project|workspace)/iu;
/**
* What may sit BETWEEN two candidates of the same clause when the clause offers
* them as alternatives: a coordinator, optionally followed by the field label
* again ("/repo-b 和仓库 /repo-c"). Language form must not change the
* authorization boundary, so the enumeration mark needs no surrounding space and
* a repeated label is stepped over (review 5 F3).
*/
const REPOSITORY_ALTERNATIVE_JOIN = /^\s*(?:、|,|，|与|和|及|或|and|or)?\s*(?:repository|repo|仓库)?\s*$/iu;
const REPOSITORY_ALTERNATIVE_COORDINATOR = /、|,|，|与|和|及|或|\b(?:and|or)\b/iu;
/**
* A coordinator GLUED inside one scanned token ("/repo-b和/repo-c"). Han
* characters are legal path characters, so the scan cannot exclude them; the
* token is split at a coordinator that is followed by a repository start instead.
*/
const GLUED_ALTERNATIVE = /(?:与|和|及|或)(?=[/\\~A-Za-z])/u;
function isRepositoryCandidate(value, claimed) {
	if (claimed.has(value)) return false;
	return looksLikeRepositoryName(value);
}
function repositoryCandidates(text) {
	const claimed = labeledFieldValues(text);
	const candidates = [];
	for (const match of text.matchAll(REPOSITORY_TOKEN_SCAN)) {
		const value = match[0];
		const at = match.index;
		const glued = GLUED_ALTERNATIVE.exec(value);
		if (glued) {
			const left = value.slice(0, glued.index);
			const right = value.slice(glued.index + glued[0].length);
			if (isRepositoryCandidate(left, claimed) && isRepositoryCandidate(right, claimed)) {
				candidates.push({
					value: left,
					start: at,
					end: at + left.length
				});
				candidates.push({
					value: right,
					start: at + glued.index + glued[0].length,
					end: at + value.length
				});
				continue;
			}
		}
		if (!isRepositoryCandidate(value, claimed)) continue;
		candidates.push({
			value,
			start: at,
			end: at + value.length
		});
	}
	const current = CURRENT_REPOSITORY_PHRASE.exec(text);
	if (current) candidates.push({
		value: "<current-repository>",
		start: current.index,
		end: current.index + current[0].length
	});
	return candidates.sort((left, right) => left.start - right.start);
}
/**
* Whether the clause OFFERS several repositories rather than naming one. Two
* distinct candidates that a coordinator joins are alternatives: reporting
* either one would be a guess about which repository the root meant, so the
* capture records a clarification instead. Repetitions of the same repository are
* not alternatives, and a clause that names one repository, one branch or one
* remote is unaffected.
*/
function namesSeveralRepositories(text) {
	const candidates = repositoryCandidates(text);
	if (new Set(candidates.map((candidate) => candidate.value.replace(/[\\/]+$/, ""))).size < 2) return false;
	for (let index = 1; index < candidates.length; index += 1) {
		const between = text.slice(candidates[index - 1].end, candidates[index].start);
		if (!REPOSITORY_ALTERNATIVE_JOIN.test(between)) continue;
		if (!REPOSITORY_ALTERNATIVE_COORDINATOR.test(between)) continue;
		return true;
	}
	return false;
}
function actionObjectToken(text, verbs, nouns, skipLabels) {
	return actionObjectTokens(text, verbs, nouns, skipLabels)[0];
}
/** Every object a verb of this kind introduces, in source order, normalized once. */
function actionObjectTokens(text, verbs, nouns, skipLabels) {
	const pattern = new RegExp(`(?:${verbs})`, "giu");
	const found = [];
	for (const match of text.matchAll(pattern)) {
		const token = objectTokenAfter(text, match.index + match[0].length, nouns, skipLabels);
		if (token) found.push(token);
	}
	return [...new Set(found)];
}
/** The object token that follows a verb, read exactly as the singular form does. */
function objectTokenAfter(text, from, nouns, skipLabels) {
	let cursor = from;
	if (skipLabels) {
		const secondary = new RegExp(`^\\s*(?:${skipLabels})(?![\\p{L}\\p{N}_])`, "iu").exec(text.slice(cursor));
		if (secondary) cursor += secondary[0].length;
	}
	const noun = new RegExp(`^\\s*(?:${nouns})(?![\\p{L}\\p{N}_])`, "iu").exec(text.slice(cursor));
	if (noun) cursor += noun[0].length;
	else cursor += text.slice(cursor).match(/^\s*[\p{Script=Han}]{0,2}\s*/u)?.[0].length ?? 0;
	const rest = text.slice(cursor).replace(/^\s*(?:[:=：]|为)?\s*/u, "");
	const token = unquoteTargetToken(new RegExp(`^(${TARGET_TOKEN})`, "u").exec(rest)?.[1]);
	if (!token || IDENTITY_STOP.test(token)) return void 0;
	return token;
}
/** The verbs that name each repository-facing action, for unlabelled objects. */
const GIT_OBJECT_VERB = {
	push: "push|推送",
	pull: "pull|拉取",
	fetch: "fetch|抓取|获取",
	commit: "commit|提交"
};
function splitPackageSpec(spec) {
	if (!spec) return {};
	const at = spec.lastIndexOf("@");
	if (at > 0) return {
		packageId: spec.slice(0, at),
		version: spec.slice(at + 1) || void 0
	};
	return { packageId: spec };
}
function parentScope(subject) {
	const separator = Math.max(subject.lastIndexOf("/"), subject.lastIndexOf("\\"));
	if (separator < 0) return "scope";
	if (separator === 0) return subject[0];
	if (separator === 2 && /^[A-Za-z]:[\\/]$/.test(subject.slice(0, 3))) return subject.slice(0, 3);
	return subject.slice(0, separator);
}
/**
* The artifact-type nouns the bounded file-choice vocabulary admits (C07).
* A closed list pinned by the v2 fixture: the noun must be the OBJECT of the
* action, so "更新文档" captures a bounded choice while "更新皮肤中心" stays
* a genuine clarification. The generic "文件/file" admits any file type the
* producer accepts.
*/
const BOUNDED_TYPE_NOUNS = [
	[/文档/, "document"],
	[/(?<!\w)readme(?!\w)/iu, "readme"],
	[/报告/, "report"],
	[/文件/, "file"],
	[/(?<!\w)files?(?!\w)/iu, "file"]
];
function boundedArtifactTypeOf(text) {
	const masked = text;
	for (const [pattern, type] of BOUNDED_TYPE_NOUNS) if (pattern.test(masked)) return type;
}
/** A bounded choice needs a real path scope; the 'scope' sentinel is not one. */
function scopeIsPath(subject) {
	return subject !== "scope" && subject !== "" && /[\\/]/.test(subject);
}
/**
* Whether the clause's FIRST action word is the change verb 更新/调整 (the
* object-driven modify mapping). A later 更新 inside a referenced task name
* ("把更新插件明确为 apply…") never qualifies — the head verb is what the
* clause orders.
*/
function headVerbIsChangeWord(text) {
	const candidates = [];
	for (const word of ["更新", "调整"]) {
		let at = text.indexOf(word);
		while (at >= 0) {
			candidates.push({
				at,
				word
			});
			at = text.indexOf(word, at + word.length);
		}
	}
	for (const match of text.matchAll(/\b(?:update|adjust)\b/gi)) candidates.push({
		at: match.index,
		word: match[0]
	});
	if (candidates.length === 0) return false;
	candidates.sort((a, b) => a.at - b.at);
	const head = candidates[0];
	return CJK_ACTION_WORD_AT(text, head.at) === void 0;
}
/** Any other known action word strictly before `before`, if one exists. */
function CJK_ACTION_WORD_AT(text, before) {
	const words = [
		"创建",
		"生成",
		"新建",
		"写入",
		"修改",
		"编辑",
		"更改",
		"读取",
		"运行",
		"执行",
		"安装",
		"部署",
		"上传",
		"提交",
		"推送",
		"发布",
		"升级",
		"重启",
		"重新启动",
		"合并",
		"删除",
		"下载",
		"拉取",
		"同步"
	];
	let best;
	for (const word of words) {
		const at = text.indexOf(word);
		if (at >= 0 && at < before && (best === void 0 || at < best.at)) best = {
			at,
			word
		};
	}
	for (const match of text.matchAll(/\b(?:build|create|write|modify|change|edit|run|fix|install|push|publish|commit|deploy|migrate|delete|restart|fetch|pull|update)\b/gi)) if (match.index < before && (best === void 0 || match.index < best.at)) best = {
		at: match.index,
		word: match[0]
	};
	return best?.word;
}
/**
* Whether the root named the repository explicitly rather than relying on the
* session's environment. A path is explicit; a bare word is explicit only when
* the action's own object grammar produced it ("push repo-a"), never when it is
* the ambient working directory.
*/
function repositoryNamedExplicitly(text, action, subject) {
	const labeled = labeledToken(text, IDENTITY_LABELS.repository);
	if (labeled && looksLikeRepositoryName(labeled)) return {
		repository: labeled,
		kind: "explicit_label"
	};
	if (/当前(?:目录|文件夹|仓库|项目|工作区)|这个仓库|该仓库|本仓库|this\s+(?:repo|repository|project)|current\s+(?:repo|repository|directory|project|workspace)/i.test(text)) return subject !== "scope" ? {
		repository: subject,
		kind: "explicit_current_repository"
	} : void 0;
	const claimed = labeledFieldValues(text);
	const object = actionObjectToken(text, GIT_OBJECT_VERB[action], "repository|repo|仓库", GIT_SECONDARY_LABEL);
	if (object && !claimed.has(object) && looksLikeRepositoryName(object)) return {
		repository: object,
		kind: "explicit_path"
	};
}
/**
* A branch label's value, or undefined when the "value" is prose. The Chinese
* label 分支 also introduces a possessive phrase ("分支的改动"), whose head noun
* is not a branch name.
*/
function branchName(value) {
	if (value === void 0) return void 0;
	if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) return void 0;
	return value;
}
/**
* A Latin identity label's value, or undefined when the "value" is prose. The
* Chinese labels 分支/远端 also introduce possessive or locative phrases
* ("分支的改动"), whose head noun is not a branch, remote or refspec name.
*/
function latinIdentityValue(value) {
	if (value === void 0) return void 0;
	if (/[\p{Script=Han}]/u.test(value)) return void 0;
	if (!/^[A-Za-z0-9]/.test(value)) return void 0;
	return value;
}
/**
* Whether a captured token names a repository rather than trailing prose. A
* path is unambiguous; a bare word has to be Latin-script, so 改动/变更/代码 and
* other Chinese noun phrases never become a repository identity.
*/
/** Fields a git instruction names besides its repository; never a repository. */
const GIT_TARGET_STOP_WORDS = /^(?:the|a|an|this|that|these|those|to|from|in|on|into|with|and|or|then|also|but|my|our|your|all|any|some|change|changes|changed|commit|commits|push|pushes|pull|fetch|update|updates|branch|remote|refspec|origin|upstream|main|master|develop|trunk|head|repository|repo|tags?|branch(?:es)?|远程|远端|分支|引用规范|仓库)$/i;
function looksLikeRepositoryName(value) {
	if (GIT_TARGET_STOP_WORDS.test(value)) return false;
	if (/[\\/]/.test(value) || /^[.~]/.test(value)) return true;
	if (/^[A-Za-z]:/.test(value)) return true;
	if (!/^[\p{L}\p{N}@._-]+$/u.test(value)) return false;
	return !/[\p{Script=Han}]/u.test(value);
}
/** The target capture for one action, with the source of its identity. */
/**
* Whether a span names more than one candidate for the action's identity field,
* judged WITHIN one surface form with the extractor's own grammar and normalization —
* so the enumeration cannot invent a pair by mixing forms, and cannot miss the
* label-first list ("service api or worker") the extractor actually reads.
*/
function restatedSpanAmbiguous(action, text) {
	return identityFieldLabels(action).some((labels) => fieldCandidates(action, labels, text).length > 1);
}
/**
* The label grammar of each identity field, per action. The enumerator reads a field
* with the SAME labels the extractor uses and with the same normalization, so a
* coordinated list after one label is seen as two candidates.
*/
function identityFieldLabels(action) {
	const { service, package: pkg, artifact, version, profile, registry, repository, branch, remote, refspec } = IDENTITY_LABELS;
	switch (action) {
		case "restart": return [service];
		case "install":
		case "apply": return [
			pkg,
			version,
			profile
		];
		case "publish": return [
			artifact,
			version,
			registry
		];
		case "commit":
		case "push":
		case "pull":
		case "fetch": return [
			repository,
			branch,
			remote,
			refspec
		];
		default: return [];
	}
}
/** The distinct candidates a span names for ONE identity field. */
/**
* The label grammar of every identity field, shared by the EXTRACTOR and the
* uniqueness enumeration — one definition, so the two can never drift. Latin labels
* carry a word boundary: without it a path like `/repo-a` would be read as the `repo`
* label and its next token as a second candidate.
*/
const IDENTITY_LABELS = {
	service: "(?<![\\p{Script=Latin}\\p{N}@/_.-])service(?:_id)?|服务",
	package: "(?<![\\p{Script=Latin}\\p{N}@/_.-])(?:package|plugin)|包|插件",
	artifact: "(?<![\\p{Script=Latin}\\p{N}@/_.-])(?:package|artifact)|包|制品",
	version: "(?<![\\p{Script=Latin}\\p{N}@/_.-])version|版本",
	profile: "(?<![\\p{Script=Latin}\\p{N}@/_.-])profile|配置(?:档|文件)?",
	registry: "(?<![\\p{Script=Latin}\\p{N}@/_.-])registry|注册表|仓库地址",
	repository: "(?<![\\p{Script=Latin}\\p{N}@/_.-])(?:repository|repo)|仓库",
	branch: "(?<![\\p{Script=Latin}\\p{N}@/_.-])branch|分支",
	remote: "(?<![\\p{Script=Latin}\\p{N}@/_.-])remote|远端",
	refspec: "(?<![\\p{Script=Latin}\\p{N}@/_.-])refspec|引用规范",
	install: "(?<![\\p{Script=Latin}\\p{N}@/_.-])(?:install|add|apply|安装|应用)",
	restart: "(?<![\\p{Script=Latin}\\p{N}@/_.-])(?:restart|reload|重启|重新启动)",
	publish: "(?<![\\p{Script=Latin}\\p{N}@/_.-])(?:publish|release|发布)"
};
/** Every version a package spec in the span names (`foo@1.0.0` -> `1.0.0`). */
function identitySpecVersions(text) {
	const found = [];
	const raw = [
		...labeledTokens(text, IDENTITY_LABELS.package),
		...labeledTokens(text, IDENTITY_LABELS.artifact),
		...actionObjectTokens(text, IDENTITY_LABELS.install, IDENTITY_LABELS.package),
		...actionObjectTokens(text, IDENTITY_LABELS.publish, IDENTITY_LABELS.artifact)
	];
	for (const value of raw) {
		const version = splitPackageSpec(value).version;
		if (version) found.push(version);
	}
	return found;
}
/** The identity normalizer of one field: never a blanket lowercase. */
function fieldNormalizer(labels) {
	if (labels === IDENTITY_LABELS.package || labels === IDENTITY_LABELS.artifact) return (value) => {
		const spec = splitPackageSpec(value);
		const id = spec.packageId ?? value.trim();
		return spec.version ? `${id}@${spec.version}` : id;
	};
	if (labels === IDENTITY_LABELS.registry) return (value) => canonicalRegistryBase(value) ?? value.trim();
	return (value) => value.trim();
}
function fieldCandidates(action, labels, text) {
	const normalize = fieldNormalizer(labels);
	const groups = [[...new Set(labeledTokens(text, labels).map(normalize))]];
	if (labels === IDENTITY_LABELS.version) {
		const union = [...new Set([...groups[0], ...identitySpecVersions(text).map(normalize)])];
		if (union.length > 1) return union;
		groups[0] = union;
	}
	if (labels === IDENTITY_LABELS.service) groups.push(serviceCandidates(text));
	if (labels === IDENTITY_LABELS.package) groups.push(packageCandidates(text));
	for (const group of groups) {
		const distinct = [...new Set(group.filter((value) => value !== ""))];
		if (distinct.length > 1) return distinct;
	}
	return groups[0].filter((value) => value !== "");
}
function captureRequestedTarget(action, text, subject, surface) {
	if (action === "create" || action === "modify") {
		if (surface === "artifact") return {
			target: {
				artifact_id: subject,
				scope: parentScope(subject)
			},
			source: { kind: "explicit_path" }
		};
		const artifactType = boundedArtifactTypeOf(text);
		if (artifactType && scopeIsPath(subject)) return {
			target: {
				scope: subject,
				artifact_type: artifactType
			},
			source: { kind: "explicit_path" }
		};
		return {
			target: {},
			reasonCode: "requested_target_artifact_id_missing"
		};
	}
	if (action === "install" || action === "apply") {
		const parsed = splitPackageSpec(actionObjectToken(text, IDENTITY_LABELS.install, IDENTITY_LABELS.package));
		if (!parsed.packageId) return {
			target: {},
			reasonCode: "requested_target_package_id_missing"
		};
		const profile = labeledToken(text, IDENTITY_LABELS.profile);
		const version = parsed.version ?? labeledToken(text, IDENTITY_LABELS.version);
		return {
			source: { kind: "explicit_label" },
			target: {
				package_id: parsed.packageId,
				...version ? { version } : {},
				...profile ? { profile } : {}
			}
		};
	}
	if (action === "restart") {
		const service = labeledToken(text, IDENTITY_LABELS.service) ?? actionObjectToken(text, IDENTITY_LABELS.restart, IDENTITY_LABELS.service);
		return service ? {
			target: { service_id: service },
			source: { kind: "explicit_label" }
		} : {
			target: {},
			reasonCode: "requested_target_service_id_missing"
		};
	}
	if (action === "publish") {
		const parsed = splitPackageSpec(actionObjectToken(text, IDENTITY_LABELS.publish, IDENTITY_LABELS.artifact));
		if (!parsed.packageId) return {
			target: {},
			reasonCode: "requested_target_artifact_id_missing"
		};
		const version = parsed.version ?? labeledToken(text, IDENTITY_LABELS.version);
		const registry = canonicalRegistryBase(labeledToken(text, IDENTITY_LABELS.registry) ?? "");
		if (!registry) return {
			target: {},
			reasonCode: "requested_target_registry_missing_or_invalid"
		};
		return {
			source: { kind: "explicit_label" },
			target: {
				artifact_id: parsed.packageId,
				...version ? { version } : {},
				registry
			}
		};
	}
	if (action === "pull" || action === "fetch" || action === "commit" || action === "push") {
		const branch = branchName(latinIdentityValue(labeledToken(text, IDENTITY_LABELS.branch)));
		const remote = latinIdentityValue(labeledToken(text, IDENTITY_LABELS.remote));
		const explicitRefspec = latinIdentityValue(labeledToken(text, IDENTITY_LABELS.refspec));
		const refspec = explicitRefspec !== void 0 && (/:/.test(explicitRefspec) || /^refs?\//i.test(explicitRefspec)) ? explicitRefspec : action !== "commit" && branch !== void 0 ? branch : void 0;
		const named = repositoryNamedExplicitly(text, action, subject);
		if (namesSeveralRepositories(text)) return {
			source: { kind: "environment_default" },
			reasonCode: "requested_target_repository_ambiguous",
			target: {
				...action === "commit" && branch ? { branch } : {},
				...action !== "commit" && remote ? { remote } : {},
				...action !== "commit" && refspec ? { refspec } : {}
			}
		};
		if (!named) return {
			source: { kind: "environment_default" },
			target: {
				...action === "commit" && branch ? { branch } : {},
				...action !== "commit" && remote ? { remote } : {},
				...action !== "commit" && refspec ? { refspec } : {}
			}
		};
		return {
			source: { kind: named.kind },
			target: {
				repository: named.repository,
				...action === "commit" && branch ? { branch } : {},
				...action !== "commit" && remote ? { remote } : {},
				...action !== "commit" && refspec ? { refspec } : {}
			}
		};
	}
	return {
		source: { kind: surface === "artifact" ? "explicit_path" : "environment_default" },
		target: surface === "artifact" ? {
			artifact_id: subject,
			scope: parentScope(subject)
		} : { scope: subject }
	};
}
/**
* The repository an obligation resolves to when the root wrote no repository
* at all (0.6.3 K2). The environment default is preserved so a later
* work-unit inheritance decision can evaluate it, but it is never reported as
* a resolved user selection.
*/
function environmentDefaultRepositoryTarget(action, subject) {
	if (!(action === "pull" || action === "fetch" || action === "commit" || action === "push")) return void 0;
	return scopeIsPath(subject) || subject.startsWith("/") || /^[A-Za-z]:[\\/]/.test(subject) ? { repository: subject } : void 0;
}
const EXTENSION_TAIL = new RegExp(`\\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|c|cpp|h|hpp|cs|rb|php|vue|svelte|md|mdx|json|jsonc|yml|yaml|toml|ini|cfg|sh|bash|zsh|fish|ps1|html|css|scss|less|sql|txt|lock|mod|sum|env|patch|diff|pkl|tf|hcl|proto)(?:$|[^A-Za-z0-9])`, "i");
function isArtifactCandidate(value) {
	return EXTENSION_TAIL.test(value);
}
/** Wrapped path spellings: backticks, double/single quotes, and parentheses. */
const WRAPPED_PATH = /`([^`]+)`|"([^"]+)"|'([^']+)'|\(([^()]+)\)/g;
function extractArtifactPaths(text) {
	const found = /* @__PURE__ */ new Set();
	const push = (candidate) => {
		const trimmed = candidate.trim();
		if (trimmed && isArtifactCandidate(trimmed)) found.add(trimmed);
	};
	for (const match of text.matchAll(WRAPPED_PATH)) push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? "");
	for (const token of text.split(/[\s,;，；]+/)) {
		const bare = token.replace(/^[('"]+|['")]+$/g, "").replace(/[。！？；.!?，,；:：]+$/, "");
		if (bare && !bare.includes("`") && isArtifactCandidate(bare)) found.add(bare);
	}
	return [...found];
}
function segmentClauses(text, options = {}) {
	const normalized = normalizeClause(text);
	if (!normalized) return [];
	return interpretMessage(normalized, options).filter((interpretation) => interpretation.text.trim().length > 0).map((interpretation) => ({
		kind: kindOfScope(interpretation.directive, interpretation.body),
		body: interpretation.body,
		text: interpretation.text,
		paths: extractArtifactPaths(interpretation.body),
		interpretation
	}));
}
/**
* Build a GuardItem from an already-classified clause body and a resolved
* verification subject/surface.
*
* The optional `interpretation` carries the scope reading taken from the same
* bytes. It is passed through rather than re-derived, so the obligation lane and
* the authority of one clause cannot disagree between callers.
*/
function captureItem(kind, body, sourceMessageId, id, revision, subject, surface, method, operation, interpretation) {
	const sanitized = sanitizeClauseText(body);
	const unsupportedVisual = /\bGUI\b|界面|视觉|截图|颜色|布局|视觉效果/i.test(sanitized);
	const actionText = isRestatement(sanitized) ? restatedContentOf(sanitized) ?? sanitized : sanitized;
	let semanticAction = unsupportedVisual ? "generic_run" : semanticActionOfScope(actionText, interpretation?.text ?? sanitized, kind === "prohibition");
	if (semanticAction === "generic_run" && !unsupportedVisual && interpretation?.directive === "directive" && headVerbIsChangeWord(sanitized) && boundedArtifactTypeOf(sanitized) !== void 0) semanticAction = "modify";
	const restated = isRestatement(sanitized) ? restatedContentOf(sanitized) ?? sanitized : void 0;
	const clarified = restated === void 0 ? sanitized : clarifiedSpanOf(sanitized) ?? sanitized;
	const capturedFull = captureRequestedTarget(semanticAction, clarified, subject, surface);
	const capturedTarget = capturedFull.reasonCode === void 0 && restatedSpanAmbiguous(semanticAction, clarified) ? {
		target: capturedFull.target,
		reasonCode: "requested_target_field_ambiguous"
	} : restated === void 0 ? capturedFull : (() => {
		const spanTarget = captureRequestedTarget(semanticAction, restated, subject, surface);
		const spanFields = Object.keys(spanTarget.target);
		const spanAmbiguous = restatedSpanAmbiguous(semanticAction, restated);
		const fullAmbiguous = restatedSpanAmbiguous(semanticAction, clarified);
		const inherited = !fullAmbiguous && capturedFull.reasonCode === void 0 ? Object.fromEntries(Object.entries(capturedFull.target).filter(([field$1]) => !spanFields.includes(field$1))) : {};
		const reasonCode = spanAmbiguous || spanFields.length === 0 && fullAmbiguous ? "requested_target_field_ambiguous" : spanFields.length > 0 ? spanTarget.reasonCode : Object.keys(inherited).length > 0 ? void 0 : capturedFull.reasonCode;
		return {
			target: {
				...inherited,
				...spanTarget.target
			},
			...reasonCode !== void 0 ? { reasonCode } : {},
			...spanTarget.source ?? (spanFields.length === 0 ? capturedFull.source : void 0) ? { source: spanTarget.source ?? capturedFull.source } : {}
		};
	})();
	const effectiveOperation = semanticAction === "verify" ? "verify" : operation;
	const item = {
		id,
		revision,
		kind,
		sourceMessageId,
		normalizedText: sanitized,
		textSha256: sha256(sanitized),
		status: "pending",
		verification: kind === "prohibition" ? {
			enforced: false,
			surface,
			subject
		} : {
			enforced: true,
			surface: unsupportedVisual ? "ui" : surface,
			subject,
			method,
			operation: effectiveOperation
		},
		semanticAction,
		requestedTarget: capturedTarget.target,
		...capturedTarget.reasonCode ? {
			targetCaptureStatus: "clarification_required",
			targetCaptureReasonCode: capturedTarget.reasonCode
		} : capturedTarget.source?.kind === "environment_default" && environmentDefaultRepositoryTarget(semanticAction, subject) !== void 0 ? {
			requestedTarget: {
				...environmentDefaultRepositoryTarget(semanticAction, subject),
				...capturedTarget.target
			},
			targetSource: capturedTarget.source,
			targetCaptureStatus: "clarification_required",
			targetCaptureReasonCode: "requested_target_repository_missing"
		} : {
			targetCaptureStatus: "resolved",
			...capturedTarget.source ? { targetSource: capturedTarget.source } : {}
		},
		taskKind: kind === "prohibition" ? void 0 : classifyTaskIntent(sanitized),
		authority: "root_instruction",
		...kind === "requirement" ? buildActionPlan(actionText, subject, surface, semanticAction, restated === void 0 ? void 0 : capturedFull) : {},
		...interpretation ? {
			directive: interpretation.directive,
			executee: interpretation.executee,
			authorityDisposition: interpretation.authorityDisposition,
			executionQualification: interpretation.qualification,
			...interpretation.condition ? { condition: interpretation.condition } : {},
			...interpretation.resumeEvent ? { resumeEvent: interpretation.resumeEvent } : {},
			interpretationFingerprint: interpretation.fingerprint
		} : {}
	};
	const heuristics = maskQuotedSpans(sanitized);
	if ((interpretation ? interpretation.authorityDisposition !== "executable_now" && (interpretation.resumeEvent !== void 0 || interpretation.authorityDisposition === "conditional_wait") : false) || /(?:等待|暂停|等).{0,12}(?:用户|你|您|我).{0,12}(?:选择|确认|输入)(?:.{0,8}(?:后|再)?继续)?|收到.{0,8}(?:用户|你|您|我)?的?确认.{0,8}(?:后)?再继续|\bwait for (?:the )?(?:user|your)\b|\bcontinue only after (?:the )?(?:user's?|your) confirmation\b/i.test(heuristics)) item.waitAuthorization = {
		kind: "root_explicit_wait",
		id: `wait:${id}:${sha256(sanitized).slice(0, 12)}`
	};
	else if (/(?:请选择|请决定|需要用户决定)|\b(?:please choose|user decision required)\b/i.test(heuristics)) item.waitAuthorization = {
		kind: "user_decision_item",
		id: `decision:${id}:${sha256(sanitized).slice(0, 12)}`
	};
	if (/(?:明确|允许|授权).{0,8}(?:延期|延后|移出范围)|(?:先)?延期(?:到|至).{1,24}(?:迭代|版本|里程碑|日期)|本(?:次|个)?迭代(?:暂时|暂)?不做|\b(?:explicitly )?(?:defer|remove from scope)\b|\bdefer\b.{0,24}\b(?:next iteration|milestone|release)\b|\bout of scope for (?:this|the current) iteration\b/i.test(heuristics)) item.deferAuthorization = {
		kind: "root_explicit_defer",
		id: `defer:${id}:${sha256(sanitized).slice(0, 12)}`
	};
	if (/(?:持续推进|继续推进).{0,40}(?:直到|直至).{1,80}(?:为止|完成|结束)|(?:不要|不得|别)停.{0,40}(?:直到|直至)|\b(?:keep working|continue working|do not stop|don't stop)\b.{0,80}\b(?:until|unless)\b/i.test(heuristics)) item.persistenceAuthorization = {
		kind: "root_explicit_persistence",
		id: `persist:${id}:${sha256(sanitized).slice(0, 12)}`
	};
	return item;
}
/** The stateful actions a clause names, with the target captured for each. */
function buildActionPlan(body, subject, surface, primary, inherit) {
	const actions = statefulActionsOfScope(body);
	if (actions.length === 0 && isStatefulAction(primary)) actions.push(primary);
	if (actions.length <= 1) return {};
	return { actionPlan: actions.map((action) => {
		const captured = captureRequestedTarget(action, body, subject, surface);
		const environmentDefault = captured.source?.kind === "environment_default" ? environmentDefaultRepositoryTarget(action, subject) : void 0;
		const planFields = Object.keys(captured.target);
		const inherited = inherit !== void 0 && !inherit.reasonCode ? Object.fromEntries(Object.entries(inherit.target).filter(([field$1]) => !planFields.includes(field$1))) : {};
		const reasonCode = restatedSpanAmbiguous(action, body) ? "requested_target_field_ambiguous" : captured.reasonCode ?? (planFields.length === 0 && Object.keys(inherited).length === 0 ? inherit?.reasonCode : void 0);
		if (environmentDefault !== void 0) return {
			action,
			requestedTarget: {
				...environmentDefault,
				...inherited,
				...captured.target
			},
			targetCaptureStatus: "clarification_required",
			targetCaptureReasonCode: "requested_target_repository_missing"
		};
		return {
			action,
			requestedTarget: {
				...inherited,
				...captured.target
			},
			targetCaptureStatus: reasonCode ? "clarification_required" : "resolved",
			...captured.reasonCode ? { targetCaptureReasonCode: captured.reasonCode } : {}
		};
	}) };
}
/**
* Capture one contract clause. Every captured item receives a concrete
* verification contract: a named artifact path (artifact surface) or the
* session scope (scope surface), so an unrelated file read can never close it.
*/
function captureClause(text, sourceMessageId, id, revision, scope = {}, options = {}) {
	const [interpretation] = interpretMessage(text, options);
	const kind = interpretation ? kindOfScope(interpretation.directive, interpretation.body) : "requirement";
	const body = interpretation?.body ?? text;
	const path$1 = extractArtifactPaths(sanitizeClauseText(body))[0] ?? "";
	const surface = path$1 ? "artifact" : "scope";
	const item = captureItem(kind, body, sourceMessageId, id, revision, path$1 || scope.cwd || "scope", surface, interpretation?.method ?? extractMethod(body), extractOperation(body), interpretation);
	if (interpretation) {
		const at = text.indexOf(interpretation.text);
		if (at >= 0) {
			item.rawTextSha256 = sha256(text);
			item.spans = [{
				partIndex: 0,
				start: utf8ByteOffset(text, at),
				end: utf8ByteOffset(text, at) + utf8ByteLength(interpretation.text),
				class: spanClassOf(kind, interpretation.directive, "root_instruction")
			}];
		}
	}
	return item;
}

//#endregion
//#region src/domain/reason-class.ts
const REASON_CLASS_TABLE = {
	requested_target_package_id_missing: "parameter_missing",
	requested_target_artifact_id_missing: "parameter_missing",
	requested_target_repository_missing: "parameter_missing",
	requested_target_service_id_missing: "parameter_missing",
	requested_target_registry_missing_or_invalid: "parameter_missing",
	target_clarification_required: "parameter_missing",
	item_not_found: "parameter_missing",
	item_revision_mismatch: "parameter_missing",
	unsupported_action: "parameter_missing",
	missing_evidence: "parameter_missing",
	action_plan_target_missing: "parameter_missing",
	action_plan_evidence_missing: "parameter_missing",
	binding_missing_required_facet: "parameter_missing",
	evidence_missing: "parameter_missing",
	proof_subject_invalid: "parameter_missing",
	proof_source_invalid: "parameter_missing",
	proof_evidence_invalid: "parameter_missing",
	generic_run_non_certifiable: "source_insufficient",
	legacy_generic_run_non_certifiable: "source_insufficient",
	legacy_authority_unclassified: "source_insufficient",
	inquiry_non_certifiable: "source_insufficient",
	inquiry_awaiting_delivery: "source_insufficient",
	asset_interpretation_required: "source_insufficient",
	information_non_certifiable: "source_insufficient",
	information_awaiting_delivery: "source_insufficient",
	interpretation_unresolved: "source_insufficient",
	answer_delivered: "source_insufficient",
	certified: "source_insufficient",
	semantic_action_mismatch: "source_insufficient",
	evidence_matches_no_facet: "source_insufficient",
	requested_target_mismatch: "source_insufficient",
	requested_resolved_target_mismatch: "source_insufficient",
	binding_state_cross_pairing: "source_insufficient",
	binding_resolution_cross_pairing: "source_insufficient",
	binding_observed_state_mismatch: "source_insufficient",
	binding_state_observation_overlap: "source_insufficient",
	binding_expected_transition_mismatch: "source_insufficient",
	binding_state_closure_rejected: "source_insufficient",
	expected_transition_mismatch: "source_insufficient",
	non_stateful_role_manifest_invalid: "source_insufficient",
	resolved_target_incomplete: "source_insufficient",
	state_closure_incomplete: "source_insufficient",
	delegated_result_bounded: "source_insufficient",
	proof_subject_unbound: "source_insufficient",
	proof_source_unbound: "source_insufficient",
	proof_surface_unbound: "source_insufficient",
	proof_role_unbound: "source_insufficient",
	proof_operation_unbound: "source_insufficient",
	proof_scope_subject_unbound: "source_insufficient",
	proof_scope_digest_mismatch: "source_insufficient",
	proof_scope_digest_invalid: "source_insufficient",
	proof_evidence_outcome_invalid: "source_insufficient",
	proof_evidence_constraint_failed: "source_insufficient",
	root_condition_pending: "condition_unmet",
	prohibition_active: "condition_unmet",
	ancestor_condition_unsatisfied: "condition_unmet",
	ancestor_prohibition_active: "condition_unmet",
	mutation_awaiting_root_condition: "condition_unmet",
	mutation_awaiting_root_wait: "condition_unmet",
	action_plan_order_mismatch: "condition_unmet",
	adapter_unavailable: "producer_capability_unavailable",
	host_unavailable: "producer_capability_unavailable",
	stateful_adapter_unavailable: "producer_capability_unavailable",
	proof_producer_capability_unavailable: "producer_capability_unavailable",
	proof_readback_unavailable: "producer_capability_unavailable",
	proof_external_fact_unavailable: "producer_capability_unavailable",
	proof_external_fact_incomplete: "producer_capability_unavailable",
	proof_source_bounded_delegation: "producer_capability_unavailable",
	historical_evidence_gap: "historical_gap",
	effect_already_applied: "historical_gap",
	action_already_applied: "historical_gap",
	effect_only_insufficient_state_readback: "historical_gap",
	execution_unattributable: "historical_gap",
	rebind_evidence_predates_source: "historical_gap",
	resolution_expected_transition_missing: "historical_gap",
	resolution_expected_transition_digest_missing: "historical_gap",
	resolution_expected_transition_digest_mismatch: "historical_gap",
	resolution_expected_transition_invalid: "historical_gap",
	integrity_invalid: "integrity_failure",
	host_lock_unsupported: "integrity_failure",
	certificate_missing: "integrity_failure",
	certificate_replay_mismatch: "integrity_failure",
	boundary_replay_mismatch: "integrity_failure",
	proof_invalid: "integrity_failure",
	proof_unbound: "integrity_failure",
	proof_protocol_version_mismatch: "integrity_failure",
	proof_digest_invalid: "integrity_failure",
	proof_digest_mismatch: "integrity_failure",
	proof_kind_unsupported: "integrity_failure",
	proof_surface_unsupported: "integrity_failure",
	proof_operation_unsupported: "integrity_failure",
	proof_obligation_unbound: "integrity_failure",
	proof_obligation_not_pending: "integrity_failure",
	proof_evidence_unknown: "integrity_failure",
	proof_evidence_wrong_epoch: "integrity_failure",
	proof_manifest_invalid: "integrity_failure",
	proof_obligations_missing: "integrity_failure",
	proof_obligation_invalid: "integrity_failure",
	proof_obligation_id_duplicate_or_invalid: "integrity_failure",
	proof_asset_set_digest_invalid: "integrity_failure",
	evidence_wrong_epoch: "integrity_failure",
	evidence_outcome_not_success: "integrity_failure",
	stale_host_lock: "integrity_failure",
	stale_epoch: "integrity_failure",
	stale_contract_revision: "integrity_failure",
	stale_unit_ref: "integrity_failure",
	stale_goal_ref: "integrity_failure",
	legacy_certificate_in_v5_session: "integrity_failure",
	certificate_version_unavailable: "integrity_failure",
	mutation_integrity_unavailable: "integrity_failure",
	item_missing_or_superseded: "integrity_failure",
	unit_unavailable: "integrity_failure",
	certificate_manifest_rejected: "integrity_failure",
	session_ref_unavailable: "integrity_failure",
	projection_durability_unavailable: "integrity_failure",
	interpretation_receipt_mismatch: "integrity_failure",
	guard_unavailable: "integrity_failure",
	binding_role_mismatch: "integrity_failure",
	binding_role_order_invalid: "integrity_failure",
	action_plan_evidence_reused: "integrity_failure",
	action_plan_evidence_not_successful: "integrity_failure",
	action_plan_evidence_predates_item: "integrity_failure",
	action_plan_action_mismatch: "integrity_failure",
	action_plan_incomplete: "integrity_failure",
	action_plan_target_mismatch: "integrity_failure",
	release_contract_required: "policy_boundary",
	release_operation_not_adopted: "policy_boundary",
	release_operation_unprotectable: "policy_boundary",
	release_operation_unrouted: "policy_boundary",
	release_runner_opaque: "policy_boundary",
	release_contract_expired: "policy_boundary",
	release_expiry_unevaluable: "policy_boundary",
	release_expiry_invalid: "policy_boundary",
	release_operations_missing: "policy_boundary",
	release_operation_unknown: "policy_boundary",
	release_candidate_missing: "policy_boundary",
	release_candidate_ref_missing: "policy_boundary",
	release_candidate_sha_invalid: "policy_boundary",
	release_candidate_artifact_digest_invalid: "policy_boundary",
	release_contract_malformed: "policy_boundary",
	release_reservation_malformed: "policy_boundary",
	release_settlement_malformed: "policy_boundary",
	release_subcommand_unknown: "policy_boundary",
	release_operation_consumed: "policy_boundary",
	release_operation_in_flight: "policy_boundary",
	release_candidate_sha_mismatch: "policy_boundary",
	release_candidate_ref_mismatch: "policy_boundary",
	release_candidate_repository_mismatch: "policy_boundary",
	release_candidate_package_mismatch: "policy_boundary",
	release_candidate_version_mismatch: "policy_boundary",
	release_candidate_registry_mismatch: "policy_boundary",
	release_candidate_artifact_mismatch: "policy_boundary",
	release_candidate_artifact_sri_mismatch: "policy_boundary",
	release_candidate_sha_unresolved: "policy_boundary",
	release_candidate_ref_unresolved: "policy_boundary",
	release_candidate_repository_unresolved: "policy_boundary",
	release_candidate_package_unresolved: "policy_boundary",
	release_candidate_version_unresolved: "policy_boundary",
	release_candidate_registry_unresolved: "policy_boundary",
	release_artifact_sha256_unresolved: "policy_boundary",
	release_artifact_sri_unresolved: "policy_boundary",
	release_artifact_identity_required: "policy_boundary",
	release_candidate_sha256_invalid: "policy_boundary",
	release_candidate_sri_invalid: "policy_boundary",
	release_candidate_field_unknown: "policy_boundary",
	release_candidate_unobservable: "policy_boundary",
	release_contract_revoked: "policy_boundary",
	release_contract_revocation_unknown: "policy_boundary",
	release_state_damaged: "policy_boundary",
	release_readiness_unresolved: "policy_boundary",
	release_closure_unresolved: "policy_boundary",
	release_target_package_mismatch: "policy_boundary",
	release_target_version_mismatch: "policy_boundary",
	release_target_registry_mismatch: "policy_boundary",
	release_artifact_digest_unresolved: "policy_boundary",
	release_target_unresolved: "policy_boundary",
	release_contract_granted: "policy_boundary",
	release_profile_not_adopted: "policy_boundary",
	release_reservation_not_durable: "policy_boundary",
	release_gate_unavailable: "policy_boundary",
	strict_proof_required: "policy_boundary"
};
/** The seven-class label for one fine-grained reason code. */
function reasonClassOf(reasonCode) {
	return REASON_CLASS_TABLE[reasonCode] ?? "source_insufficient";
}

//#endregion
//#region src/domain/capability-semantics.ts
/**
* Whether the item's obligation has a certification path in this cohort at
* all. A generic_run item names no concrete action: the manifest still has a
* generic entry (the guard may run and observe ordinary commands) but no
* user-level completion contract can be certified from it, so the item is
* uncertifiable while ordinary execution remains entirely permitted.
*/
function actionHasCertificationPath(action, legacyMigration) {
	if (legacyMigration) return false;
	if (action === "generic_run") return false;
	if (!isStatefulAction(action)) return true;
	return ACTION_MANIFEST.actions[action].evidenceProducer === "supported";
}
/** The capability classification of an item's own obligation contract. */
function capabilityFactOf(item) {
	const action = item.semanticAction ?? "generic_run";
	const legacyMigration = (item.legacyFlags?.length ?? 0) > 0;
	const certifiable = actionHasCertificationPath(action, legacyMigration);
	if (item.kind === "prohibition") return {
		actionSupported: false,
		certifiable: false,
		gap: "constraint",
		remedy: "none",
		blockingReasonCodes: []
	};
	if (!certifiable) return {
		actionSupported: action !== "generic_run",
		certifiable: false,
		gap: legacyMigration ? "legacy_migration_required" : "missing_adapter",
		remedy: legacyMigration ? "fresh_root_instruction" : "report_uncertified_capability_gap",
		blockingReasonCodes: []
	};
	return {
		actionSupported: true,
		certifiable: true,
		gap: "none",
		remedy: "collect_evidence",
		blockingReasonCodes: []
	};
}
/**
* `partial_failure` may be reported only from a credible structured
* per-operation result, and only for the exact declared subset. `unknown`
* stays unknown: the guard never reconstructs a per-operation verdict from
* stderr text, and never widens a declared subset into a claim about the rest.
*/
function partialFailureOf(facts) {
	const declared = facts.declaredOperationResults;
	if (!declared?.length) return void 0;
	if (facts.operationAttribution !== "declared_per_operation") return void 0;
	const failed = declared.filter((entry) => entry.outcome === "failure");
	if (!failed.length) return void 0;
	if (declared.some((entry) => entry.outcome === "unknown")) return void 0;
	return { failed };
}
/** The one-line consequence of a gap kind, shared so no lane re-invents it. */
function capabilityConsequence(gap) {
	switch (gap) {
		case "missing_adapter": return "No certification adapter exists for the exact action this obligation names. Complete the work honestly, keep the observable result, and report it as uncertified; do not claim a certificate, and do not demand that the user restate the request as some other supported action.";
		case "interpretation_unknown": return "The clause was not read as a concrete instruction. It stays recorded, non-executable, and never closes by delivery; a fresh explicit root instruction naming a concrete action supersedes it.";
		case "legacy_migration_required": return "A pre-0.5 obligation carries no concrete action. Only its own migration path replaces it: a fresh root instruction naming the action and target, followed by the rebind proposal that maps this item onto that recorded instruction.";
		case "target_missing": return "The action is supported, but an identity only the root can choose was never named. Supply exactly that field; the recorded obligation keeps its own meaning.";
		case "input_ambiguous": return "Several targets match. The root must select one before any stateful step; the guard never guesses.";
		case "historical_preevidence_missing": return "The observed effect has no recorded pre-evidence. Record the current state as a read-only fact; never repeat the action to mint the missing prestate.";
		case "operation_unattributable": return "The console could not attribute the effect to this obligation. Check the actual current state with a read-only command first, keep the obligation uncertified, never repeat the action to mint evidence, and do not assert that it never ran.";
		case "condition_pending": return "A declared condition or wait has not been released. Keep the obligation pending; do not execute it or collect effect evidence before release.";
		case "delivery_pending": return "Deliver the actual answer; the host-confirmed final response of a completed turn closes this obligation, and it certifies delivery only.";
		case "host_unavailable": return "The audited host cohort is unavailable. Restore it; keep pending work visible at a qualified safe boundary.";
		case "constraint": return "Keep this constraint enforced; it is not a completion evidence obligation.";
		case "closed": return "No further binding is needed.";
		case "none": return "Collect the matching durable evidence in its required order, then checkpoint.";
	}
}
/**
* D062-03: the applicable condition every removal-like outcome must carry.
* "Clean" or "no longer listed" never proves "no dependants", so a completed
* subset stays reported as the subset it is. These are the execution-side
* facts the guard can name but cannot observe; it states them instead of
* inventing a generic remover or promising an automatic block.
*/
const DEPENDENCY_FREE_ONLY_CONDITION = [
	"git_unique_content",
	"dirty_or_untracked_or_ignored_entries",
	"task_process_cwd",
	"open_handles_and_running_processes",
	"runtime_links_and_external_consumers",
	"recovery_basis"
];
/** Whether one candidate object may enter the automatic removal set. */
function admissibleForRemoval(status) {
	return status === "dependency_free";
}
/** Only an object proven dependency-free AND fully removed may read as done. */
function removalIsComplete(report, status) {
	return status === "dependency_free" && report.metadataRemoved === "yes" && report.contentRemoved === "yes" && report.directoryRemoved === "yes";
}
/** A partially removed object or an unknown dependant is never "no impact". */
function removalIsPartiallyKnown(report, status) {
	return status !== "dependency_free" || report.contentRemoved === "partial" || report.directoryRemoved !== "yes" || report.metadataRemoved !== "yes";
}

//#endregion
//#region src/domain/diagnostics.ts
/** Bounded, honest task-kind classification for a captured item. */
function taskKindOf(item) {
	if (item.kind === "prohibition") return "constraint";
	if (item.taskKind === "inquiry") return "inquiry";
	return "action";
}
const TARGET_FIELD_REASONS = {
	requested_target_package_id_missing: "package_id",
	requested_target_artifact_id_missing: "artifact_id",
	requested_target_repository_missing: "repository",
	requested_target_service_id_missing: "service_id",
	requested_target_registry_missing_or_invalid: "registry"
};
/**
* The evidence roles the item's OWN obligation contract requires (0.6.1,
* W060-04). A stateful change needs the full resolution/effect/state chain; a
* read-only verification (inspect, test, verify, generic readback) needs ONE
* matching fact in the `effect` role — exactly the manifest `simpleRecord`
* accepts. Asking every obligation for all three roles made prepare and
* diagnosis demand a change chain a read-only verification can never produce.
*/
function requiredEvidenceRoles(item) {
	return isStatefulAction(item.semanticAction ?? "generic_run") ? [
		"resolution",
		"effect",
		"state"
	] : ["effect"];
}
function evidenceFacets(p, item) {
	const present = /* @__PURE__ */ new Set();
	for (const evidence of p.evidence.values()) {
		if (!relevantEvidence(p, item, evidence)) continue;
		if (evidence.evidenceRole) present.add(evidence.evidenceRole);
	}
	return requiredEvidenceRoles(item).filter((facet) => !present.has(facet));
}
/**
* An ordinary shell command whose TEXT ANCHORED at command position to this
* obligation's action completed successfully, but whose effect on the
* obligation could not be attributed (0.6.1 W060-05; layered by 0.6.2
* D062-02). The signal is the same either way — the operation-attribution
* fact when the fact carries one, and the frozen parse status otherwise:
* a command whose effect cannot be attributed cannot certify an obligation.
*
* Only the pre-existing head-anchored action signal counts: the guard does
* NOT scan compound text for actions, because quoted data and short-circuit
* control flow would fabricate observations. A failed command is not a
* signal either.
*/
function unattributedExecutionOf(p, item) {
	const action = item.semanticAction;
	if (!action || action === "generic_run") return void 0;
	for (const evidence of p.evidence.values()) {
		if (evidence.outcome !== "success") continue;
		if (!(evidence.processFacts ? evidence.processFacts.operationAttribution === "unknown" : evidence.parseStatus !== void 0 && evidence.parseStatus !== "supported")) continue;
		if (![
			"bash",
			"pwsh",
			"shell"
		].includes(evidence.toolName)) continue;
		if (evidence.semanticAction !== void 0 && evidence.semanticAction !== "generic_run" && actionCompatible(action, evidence.semanticAction)) return evidence;
	}
}
/**
* The honest wording for an unattributable shell effect (0.6.2 D062-02). The
* two causes are DIFFERENT facts and must not share one sentence: a command
* that failed closed parsing was not securely parsed, while a compound runner
* whose operation layer is unknown simply has no independent per-operation
* result. Both refuse to claim execution either way, and both forbid
* re-running the action to mint evidence.
*/
function unattributedExecutionCondition(evidence) {
	return `${evidence.parseStatus === void 0 || evidence.parseStatus === "supported" ? "An ordinary shell command beginning with this action ran earlier in the session as an opaque multi-operation script, and the host declared no independent per-operation result, so whether it performed this action cannot be established" : "An ordinary shell command beginning with this action succeeded earlier in the session, but the command could not be securely parsed, so whether it performed the action cannot be established"}. Check the actual current state with a read-only command first. The obligation stays uncertified; perform the action through the guarded producer path only if the state shows it has not happened and the instruction still calls for it; never repeat an action to mint evidence, and do not assert it never ran.`;
}
/**
* The pure repair judge. It decides between: fixable from existing evidence,
* missing pre-evidence, missing a user target choice, not supported by any
* adapter, an executed-without-evidence historical gap, or nothing to do —
* and it NEVER recommends a rebind that cannot change certification.
*/
/**
* The unified diagnosis, with the frozen seven-class label attached (C12).
*
* The class is derived from whatever `reason_code` the judge decides, so a new
* branch cannot drift from the classification table.
*/
function deriveItemDiagnosis(p, item) {
	const diagnosis = judgeItemDiagnosis(p, item);
	return {
		...diagnosis,
		reason_class: reasonClassOf(diagnosis.reason_code)
	};
}
function judgeItemDiagnosis(p, item) {
	const kind = taskKindOf(item);
	const missing_facets = item.status === "pending" && kind !== "constraint" ? evidenceFacets(p, item) : [];
	const base = {
		item_id: item.id,
		item_revision: item.revision,
		contract_revision: p.contractRevision,
		task_kind: kind,
		missing_facets
	};
	/**
	* 0.6.2 D062-01: every verdict carries the shared capability fact for its own
	* gap. The per-lane override only names the gap KIND; the consequence text
	* and the reachable-remedy rules stay in one place, so a new branch cannot
	* drift into demanding user input for a capability this build lacks.
	*/
	const verdict = (override) => {
		const capability = {
			actionSupported: capabilityFactOf(item).actionSupported,
			certifiable: override.certifiable ?? false,
			gap: override.gap,
			remedy: override.remedy,
			blockingReasonCodes: override.reason_code === "missing_evidence" || override.reason_code === "certified" || override.reason_code === "answer_delivered" ? [] : [override.reason_code]
		};
		const { certifiable: _certifiable, remedy: _remedy, gap: _gap, missing_facets: overrideFacets,...rest } = override;
		return {
			...base,
			...rest,
			...overrideFacets !== void 0 ? { missing_facets: overrideFacets } : {},
			capability
		};
	};
	if (item.kind === "prohibition") return verdict({
		gap: "constraint",
		remedy: "none",
		certification: "unsupported",
		reason_code: "prohibition_active",
		repairability: "none",
		missing_fields: [],
		next_action: {
			kind: "none",
			resume_condition: capabilityConsequence("constraint")
		},
		attempt_fingerprint: fingerprint(p, item, "prohibition_active")
	});
	const action = item.semanticAction ?? "generic_run";
	if (item.status === "passed") return verdict({
		gap: "closed",
		remedy: "none",
		certifiable: true,
		certification: "supported",
		reason_code: "certified",
		repairability: "none",
		missing_fields: [],
		next_action: {
			kind: "none",
			resume_condition: capabilityConsequence("closed")
		},
		attempt_fingerprint: fingerprint(p, item, "certified")
	});
	if (item.status === "answered") return verdict({
		gap: "closed",
		remedy: "none",
		certifiable: true,
		certification: "supported",
		reason_code: "answer_delivered",
		repairability: "none",
		missing_fields: [],
		missing_facets: [],
		next_action: {
			kind: "none",
			resume_condition: "The host-confirmed final answer was delivered; no further binding needed."
		},
		attempt_fingerprint: fingerprint(p, item, "answer_delivered")
	});
	if (item.status === "pending" && item.waitAuthorization?.kind === "root_explicit_wait") return verdict({
		gap: "condition_pending",
		remedy: "await_root_input",
		certification: "unavailable",
		reason_code: "root_condition_pending",
		repairability: "user_input_required",
		missing_fields: [],
		missing_facets: [],
		next_action: {
			kind: "none",
			resume_condition: `Wait for the matching trusted root input: ${item.resumeEvent ?? item.condition ?? item.normalizedText}. ${capabilityConsequence("condition_pending")}`
		},
		attempt_fingerprint: fingerprint(p, item, "root_condition_pending")
	});
	if (kind === "inquiry") {
		const closable = p.boundaryProtocol === 5;
		if (item.asset !== void 0 && !p.interpretationFacts.some((fact) => fact.itemId === item.id)) return verdict({
			gap: "delivery_pending",
			remedy: "record_interpretation",
			certification: "unsupported",
			reason_code: "asset_interpretation_required",
			repairability: "unsupported",
			missing_fields: [],
			missing_facets: [],
			next_action: {
				kind: "report_only",
				tool: "context_guard_interpret",
				required_input: `the item ID of the interpreted attachment (${item.id})`,
				resume_condition: "Read the attachment, record it with context_guard_interpret for this item, and deliver the actual answer; the host-confirmed final response of a completed turn then closes this item. The record proves the asset was read, never that the interpretation is correct."
			},
			attempt_fingerprint: fingerprint(p, item, "asset_interpretation_required")
		});
		return verdict({
			gap: closable ? "delivery_pending" : "interpretation_unknown",
			remedy: closable ? "deliver_answer" : "report_uncertified",
			certification: "unsupported",
			reason_code: closable ? "inquiry_awaiting_delivery" : "inquiry_non_certifiable",
			repairability: "unsupported",
			missing_fields: [],
			missing_facets: [],
			next_action: {
				kind: "report_only",
				resume_condition: closable ? "Deliver the actual answer; the host-confirmed final response of a completed turn closes this item." : "Complete the investigation and report the actual answer; the item stays recorded as uncertified. No confirmation or rebind changes this."
			},
			attempt_fingerprint: fingerprint(p, item, closable ? "inquiry_awaiting_delivery" : "inquiry_non_certifiable")
		});
	}
	if (item.authorityDisposition === "informational") {
		const closable = p.boundaryProtocol === 5;
		return verdict({
			gap: closable ? "delivery_pending" : "interpretation_unknown",
			remedy: closable ? "deliver_answer" : "report_uncertified",
			certification: "unsupported",
			reason_code: closable ? "information_awaiting_delivery" : "information_non_certifiable",
			repairability: "unsupported",
			missing_fields: [],
			missing_facets: [],
			next_action: {
				kind: "report_only",
				resume_condition: closable ? "The trusted final response of this turn closes the recorded statement; it certifies the answer was delivered, never its accuracy." : "The recorded statement stays open as uncertified information; no confirmation, rebind, or execution changes this."
			},
			attempt_fingerprint: fingerprint(p, item, closable ? "information_awaiting_delivery" : "information_non_certifiable")
		});
	}
	if (item.authorityDisposition === "unresolved") return verdict({
		gap: "interpretation_unknown",
		remedy: "fresh_root_instruction",
		certification: "unsupported",
		reason_code: "interpretation_unresolved",
		repairability: "none",
		missing_fields: [],
		missing_facets: [],
		next_action: {
			kind: "report_only",
			resume_condition: capabilityConsequence("interpretation_unknown")
		},
		attempt_fingerprint: fingerprint(p, item, "interpretation_unresolved")
	});
	if (action !== "generic_run" && !item.legacyFlags?.length && item.targetCaptureStatus === "clarification_required") {
		const missingFields = item.targetCaptureReasonCode ? [TARGET_FIELD_REASONS[item.targetCaptureReasonCode] ?? item.targetCaptureReasonCode] : [];
		return verdict({
			gap: "target_missing",
			remedy: "supply_target",
			certifiable: true,
			certification: "needs_target",
			reason_code: "target_clarification_required",
			repairability: "user_input_required",
			missing_fields: missingFields,
			next_action: {
				kind: "clarify_target",
				tool: "context_guard_prepare",
				required_input: missingFields.length > 0 ? `the exact ${missingFields.join(" and ")} for this action` : "the exact target fields for this action",
				resume_condition: "A root-user instruction supplying the exact target re-enables certification."
			},
			attempt_fingerprint: fingerprint(p, item, "target_clarification_required")
		});
	}
	if (action === "generic_run" || item.legacyFlags?.length) {
		const legacyMigration = (item.legacyFlags?.length ?? 0) > 0;
		return verdict({
			gap: legacyMigration ? "legacy_migration_required" : "missing_adapter",
			remedy: legacyMigration ? "fresh_root_instruction" : "report_uncertified_capability_gap",
			certification: "unsupported",
			reason_code: "generic_run_non_certifiable",
			repairability: legacyMigration ? "historical_gap" : "unsupported",
			missing_fields: [],
			next_action: {
				kind: "report_only",
				resume_condition: capabilityConsequence(legacyMigration ? "legacy_migration_required" : "missing_adapter")
			},
			attempt_fingerprint: fingerprint(p, item, "generic_run_non_certifiable")
		});
	}
	if (p.hostStatus !== "supported") return verdict({
		gap: "host_unavailable",
		remedy: "restore_host",
		certification: "unavailable",
		reason_code: "host_unavailable",
		repairability: "unsupported",
		missing_fields: [],
		next_action: {
			kind: "restore_host",
			resume_condition: "Restore the audited host cohort; keep pending work visible at a qualified safe boundary."
		},
		attempt_fingerprint: fingerprint(p, item, "host_unavailable")
	});
	if (ACTION_MANIFEST.actions[action].evidenceProducer !== "supported") return verdict({
		gap: "missing_adapter",
		remedy: "restore_host",
		certification: "unavailable",
		reason_code: "adapter_unavailable",
		repairability: "unsupported",
		missing_fields: [],
		next_action: {
			kind: "restore_host",
			resume_condition: "The audited adapter for this action is unavailable in the installed cohort."
		},
		attempt_fingerprint: fingerprint(p, item, "adapter_unavailable")
	});
	const statefulChain = isStatefulAction(action);
	const unattributed = requiredEvidenceRoles(item).some((role) => !missing_facets.includes(role)) ? void 0 : unattributedExecutionOf(p, item);
	if (unattributed) return verdict({
		gap: "operation_unattributable",
		remedy: "readback_only",
		certification: "unsupported",
		reason_code: "execution_unattributable",
		repairability: "historical_gap",
		missing_fields: [],
		next_action: {
			kind: "report_only",
			resume_condition: unattributedExecutionCondition(unattributed)
		},
		attempt_fingerprint: fingerprint(p, item, "execution_unattributable")
	});
	if (statefulChain && missing_facets.includes("resolution") && !missing_facets.includes("effect")) return verdict({
		gap: "historical_preevidence_missing",
		remedy: "readback_only",
		certification: "unsupported",
		reason_code: "historical_evidence_gap",
		repairability: "historical_gap",
		missing_fields: [],
		next_action: {
			kind: "report_only",
			resume_condition: "Record the observed state as read-only fact; do not repeat the action to mint missing prestate evidence."
		},
		attempt_fingerprint: fingerprint(p, item, "historical_evidence_gap")
	});
	return verdict({
		gap: "none",
		remedy: "collect_evidence",
		certifiable: true,
		certification: "needs_evidence",
		reason_code: "missing_evidence",
		repairability: "agent_repairable",
		missing_fields: [],
		next_action: {
			kind: "collect_evidence",
			tool: "context_guard_prepare",
			resume_condition: statefulChain ? "Collect the matching durable evidence in resolution/effect/state order, then checkpoint." : "Collect the single matching durable verification fact, then checkpoint."
		},
		attempt_fingerprint: fingerprint(p, item, "missing_evidence")
	});
}
function fingerprint(p, item, reason) {
	return sha256(JSON.stringify([
		item.id,
		item.revision,
		p.contractRevision,
		reason,
		item.verification.subject ?? null
	]));
}
/** Legacy compact view, now derived from the single unified diagnosis. */
function itemDiagnosis(p, item) {
	const diagnosis = deriveItemDiagnosis(p, item);
	const nextStep = diagnosis.next_action.resume_condition ?? (diagnosis.next_action.kind === "collect_evidence" ? "Collect matching durable evidence, then call context_guard_checkpoint with bindings." : diagnosis.next_action.required_input) ?? "No further action needed.";
	return {
		certifiable: diagnosis.reason_code === "missing_evidence" || diagnosis.reason_code === "certified",
		reason_code: diagnosis.reason_code,
		next_step: nextStep
	};
}
const NATIVE_ADAPTERS = new Set([
	"dsh.bash.v1",
	"dsh.pwsh.v1",
	"dsh.shell.v1",
	"dsh.read.v1",
	"dsh.write.v1",
	"dsh.edit.v1",
	"dsh.web.v1"
]);
function evidenceAvailabilityReason(evidence) {
	if (evidence.delegatedSubtask) return "delegated_result_bounded";
	if (evidence.parseStatus !== "supported") return evidence.reasonCode ?? evidence.parseStatus ?? "adapter_unavailable";
	if (!evidence.adapterId || !evidence.adapterVersion || (SUPPORTED_EVIDENCE_ADAPTERS[evidence.adapterId] ?? (NATIVE_ADAPTERS.has(evidence.adapterId) ? "1.0.0" : void 0)) !== evidence.adapterVersion) return "adapter_unavailable";
	if (evidence.outcome !== "success") return "evidence_outcome_not_success";
	if (!evidence.semanticAction || evidence.semanticAction === "generic_run") return "generic_run_non_certifiable";
}
/** Shared display filter; certification remains the full domain check. */
function relevantEvidence(p, item, evidence) {
	const action = item.semanticAction;
	if (!action || action === "generic_run" || !actionCompatible(action, evidence.semanticAction ?? "generic_run") || evidence.epoch !== p.epoch || evidenceAvailabilityReason(evidence) !== void 0) return false;
	if (item.reboundFrom) {
		const source = /^m(\d+)(?::|$)/.exec(item.sourceMessageId);
		if (!source || evidence.toolResultSeq < Number(source[1])) return false;
	}
	if (isStatefulAction(action)) return requestedTargetMatchesResolved(action, item.requestedTarget, evidence.resolvedTarget);
	const value = (entry) => JSON.stringify(entry && typeof entry === "object" && "v" in entry ? entry.v : entry);
	return !!item.requestedTarget && Object.entries(item.requestedTarget).every(([key, entry]) => evidence.resolvedTarget && value(entry) === value(evidence.resolvedTarget[key]));
}
/**
* The bounded, one-phrase form of a reachable remedy (0.6.2 D062-01). The
* capability consequence above is the full explanation; a bounded page lists
* many items, so it uses this phrase and leaves the prose to the detail and
* preparation surfaces. Both come from the SAME capability fact.
*/
function capabilityRemedyPhrase(remedy) {
	switch (remedy) {
		case "none": return "No further action needed";
		case "collect_evidence": return "Collect matching evidence; then checkpoint";
		case "supply_target": return "Supply the exact target; then collect evidence";
		case "await_root_input": return "Wait for the trusted root input; keep pending";
		case "deliver_answer": return "Deliver the actual answer";
		case "record_interpretation": return "Read the attachment; record context_guard_interpret";
		case "report_uncertified": return "Report honestly; stays uncertified";
		case "report_uncertified_capability_gap": return "Report as uncertified";
		case "restore_host": return "Restore the audited host/adapter capability";
		case "readback_only": return "Read back the current state; do not re-execute";
		case "fresh_root_instruction": return "Report the actual outcome as uncertified";
	}
}

//#endregion
//#region src/domain/confirm-parse.ts
const CONFIRM_LINE_PATTERN = /^确认重绑定 (RB-[a-f0-9]{24})$/;
const REVERSAL_LEAD = /^(?:不要确认|请勿确认|取消(?:确认|刚才的)?|撤销(?:确认|刚才的)?|先不(?:要)?确认|暂不确认|先别确认|别确认)/;
/** Parse control without rewriting the follow-up's authority wrappers. */
function parseConfirmationMessage(text) {
	const lines = text.split(/\r?\n/);
	const firstIndex = lines.findIndex((line) => line.trim().length > 0);
	if (firstIndex < 0) return { kind: "none" };
	const first = lines[firstIndex].trim();
	const match = CONFIRM_LINE_PATTERN.exec(first);
	if (!match) {
		if (!/确认重绑定|RB-[a-f0-9]{24}/.test(text)) return { kind: "none" };
		if (/^(?:`{3,}|~{3,})/.test(first)) return {
			kind: "malformed",
			reason: "inside_code_fence"
		};
		if (/^(?:>|["“'『「])/.test(first)) return {
			kind: "malformed",
			reason: "quoted"
		};
		if (lines.slice(firstIndex + 1).some((line) => CONFIRM_LINE_PATTERN.test(line.trim()))) return {
			kind: "ambiguous",
			reason: "late_control_line"
		};
		return {
			kind: "malformed",
			reason: "embedded_control_text"
		};
	}
	const tail = lines.slice(firstIndex + 1);
	if (tail.some((line) => line.trim()) && tail[0].trim()) return {
		kind: "ambiguous",
		reason: "multiple_control_lines"
	};
	let fence;
	for (const raw of tail) {
		const line = raw.trim();
		const marker = /^(`{3,}|~{3,})/.exec(line)?.[1];
		if (marker) {
			if (!fence) fence = {
				marker: marker[0],
				length: marker.length
			};
			else if (marker[0] === fence.marker && marker.length >= fence.length && line === marker) fence = void 0;
			continue;
		}
		if (fence || line.startsWith(">")) continue;
		if (/确认重绑定|RB-[a-f0-9]{24}/.test(line)) return {
			kind: "ambiguous",
			reason: "multiple_control_lines"
		};
		if (REVERSAL_LEAD.test(line)) return {
			kind: "ambiguous",
			reason: "reversal_in_remainder"
		};
	}
	return {
		kind: "confirm",
		proposalId: match[1],
		remainder: tail.join("\n").trim()
	};
}
/** Whether a recorded tool/result carries the frozen v0.4.x response shape. */
function isFrozenV042RebindResponse(recorded) {
	if (!recorded || typeof recorded !== "object") return false;
	const nextStep = recorded.next_step;
	if (typeof nextStep !== "string") return false;
	return nextStep.startsWith("Root user must reply exactly: 确认重绑定 ") || nextStep === "Supply 1-8 exact consecutive clauses covering the original text, including unsupported work; the proposal must fit 8 KiB. Clarification that changes meaning requires a new root-user instruction." || nextStep === "Propose again against the current contract.";
}

//#endregion
//#region src/domain/rebind.ts
/** Whether the partition changes certification at all: a same-generic split
* is organizational at best and must not cost a user confirmation. */
function certificationGain(item, candidates) {
	const current = item.semanticAction ?? "generic_run";
	if (current !== "generic_run" && item.targetCaptureStatus === "clarification_required") return candidates.some((candidate) => {
		if (candidate.action === void 0) return false;
		if (candidate.action !== current && candidate.action !== "generic_run") return true;
		const target = candidate.requestedTarget;
		if (!target) return false;
		const key = requestedIdentityKey(candidate.action);
		if (key && Object.hasOwn(target, key)) return true;
		if ((candidate.action === "create" || candidate.action === "modify") && target.artifact_type !== void 0 && target.scope !== void 0) return true;
		return false;
	});
	if (current !== "generic_run") return true;
	return candidates.some((candidate) => candidate.action !== void 0 && candidate.action !== "generic_run");
}
function preservesIdentity(old, clarified) {
	const keys = Object.entries(old.requestedTarget ?? {}).filter(([key]) => key !== "scope");
	const unwrap = (value) => JSON.stringify(value && typeof value === "object" && "v" in value ? value.v : value);
	return keys.every(([key, value]) => unwrap(value) === unwrap(clarified.requestedTarget?.[key])) && (!old.verification.method || old.verification.method === clarified.verification.method) && (old.verification.surface !== "artifact" || old.verification.subject === clarified.verification.subject);
}
function validateProposalShape(item, args) {
	const clauses = args.clauses;
	const clarificationItemIds = args.clarification_item_ids ?? [];
	if (!item) return {
		ok: false,
		reasonCode: "item_not_found"
	};
	if (item.status !== "pending") return {
		ok: false,
		reasonCode: "item_not_pending"
	};
	if (item.kind === "prohibition" || !item.authority || item.authority === "legacy_authority_unclassified") return {
		ok: false,
		reasonCode: "unsupported_clarification"
	};
	if (!Array.isArray(clauses) || clauses.length < 1 || clauses.length > 8 || clauses.some((s) => typeof s !== "string" || !s.trim() || s.length > 2048)) return {
		ok: false,
		reasonCode: "partition_mismatch"
	};
	if (clauses.join("") !== item.normalizedText) {
		const source = boundedSource(item.normalizedText);
		return {
			ok: false,
			reasonCode: "partition_mismatch",
			...source ? { source } : {}
		};
	}
	if (clarificationItemIds.length !== 0 && clarificationItemIds.length !== clauses.length || new Set(clarificationItemIds.filter(Boolean)).size !== clarificationItemIds.filter(Boolean).length) return {
		ok: false,
		reasonCode: "partition_mismatch"
	};
}
/** Exact source partition is deliberately conservative: a proposal cannot
* invent authority or silently discard a difficult acceptance clause. */
function proposeRebind(p, args) {
	const outcome = proposeRebindOutcome(p, args);
	return outcome.ok ? outcome.proposal : void 0;
}
/** 0.5 proposer with typed failures and the no-certification-gain gate. */
function proposeRebindOutcome(p, args) {
	const item = p.items.get(args.item_id ?? "");
	const clarificationItemIds = args.clarification_item_ids ?? [];
	const shape = validateProposalShape(item, args);
	if (shape) return shape;
	for (const [index, id] of clarificationItemIds.entries()) {
		if (!id) continue;
		const clarified = p.items.get(id);
		const clause = args.clauses[index];
		if (!clarified || clarified.id === item.id || clarified.status !== "pending" || clarified.reboundFrom || clarified.revision <= item.revision || clarified.sourceMessageId === item.sourceMessageId || clarified.authority !== "root_instruction" || clarified.legacyFlags?.length || clarified.kind !== item.kind || !clarified.normalizedText.includes(clause.trim()) || !preservesIdentity(item, clarified) || /GUI|界面|视觉|截图|颜色|效果|布局/i.test(clause) && clarified.semanticAction !== "generic_run") return {
			ok: false,
			reasonCode: "unsupported_clarification"
		};
	}
	const candidates = buildCandidates(p, item, args.clauses, clarificationItemIds);
	if (!certificationGain(item, candidates)) return {
		ok: false,
		reasonCode: "no_certification_gain"
	};
	const body = proposalBody(p, item, args.clauses, clarificationItemIds, candidates);
	if (Buffer.byteLength(JSON.stringify(body), "utf8") > 8192) return {
		ok: false,
		reasonCode: "payload_too_large"
	};
	const digest$1 = sha256(JSON.stringify(body));
	const normalized = JSON.parse(JSON.stringify(body));
	return {
		ok: true,
		proposal: {
			id: `RB-${digest$1.slice(0, 24)}`,
			digest: digest$1,
			...normalized,
			status: "pending",
			protocol: "v050"
		}
	};
}
function buildCandidates(p, item, clauses, clarificationItemIds) {
	return clauses.map((clause, index) => {
		const root = p.items.get(clarificationItemIds[index] ?? "");
		const captured = root ?? captureItem(item.kind, clause, item.sourceMessageId, "candidate", item.revision, item.verification.subject ?? "scope", item.verification.surface === "artifact" ? "artifact" : "scope", item.verification.method, item.verification.operation);
		return {
			sourceText: clause,
			action: root || captured.semanticAction === item.semanticAction ? captured.semanticAction : "generic_run",
			requestedTarget: captured.requestedTarget,
			acceptance: root ? root.verification : item.verification,
			sourceMessageId: captured.sourceMessageId,
			rootItemId: root?.id ?? null,
			rootRevision: root?.revision ?? null
		};
	});
}
function proposalBody(p, item, clauses, clarificationItemIds, candidates) {
	return {
		session: p.sessionRefDigest,
		epoch: p.epoch,
		contractRevision: p.contractRevision,
		itemId: item.id,
		itemRevision: item.revision,
		sourceMessageId: item.sourceMessageId,
		originalText: item.normalizedText,
		clauses,
		clarificationItemIds,
		candidates
	};
}
/** Bounded alignment facts for a mismatched partition, budget-aware. */
function boundedSource(text) {
	const sha = sha256(text);
	if (Buffer.byteLength(text, "utf8") <= 4096) return {
		length: text.length,
		sha256: sha,
		text
	};
	return {
		length: text.length,
		sha256: sha,
		head: text.slice(0, 200),
		tail: text.slice(-200)
	};
}
/**
* Frozen v0.4.2/v0.4.3 proposer: identical semantics to the 0.4 releases,
* without the 0.5 no-gain gate or typed failures. Used ONLY to replay
* historical tool results and historical confirmations faithfully.
*/
function proposeRebindV042(p, args) {
	const item = p.items.get(args.item_id ?? "");
	const clarificationItemIds = args.clarification_item_ids ?? [];
	if (validateProposalShape(item, args)) return void 0;
	for (const [index, id] of clarificationItemIds.entries()) {
		if (!id) continue;
		const clarified = p.items.get(id);
		const clause = args.clauses[index];
		if (!clarified || clarified.id === item.id || clarified.status !== "pending" || clarified.reboundFrom || clarified.revision <= item.revision || clarified.sourceMessageId === item.sourceMessageId || clarified.authority !== "root_instruction" || clarified.legacyFlags?.length || clarified.kind !== item.kind || !clarified.normalizedText.includes(clause.trim()) || !preservesIdentity(item, clarified) || /GUI|界面|视觉|截图|颜色|效果|布局/i.test(clause) && clarified.semanticAction !== "generic_run") return void 0;
	}
	const candidates = buildCandidates(p, item, args.clauses, clarificationItemIds);
	const body = proposalBody(p, item, args.clauses, clarificationItemIds, candidates);
	if (Buffer.byteLength(JSON.stringify(body), "utf8") > 8192) return void 0;
	const digest$1 = sha256(JSON.stringify(body));
	const normalized = JSON.parse(JSON.stringify(body));
	return {
		id: `RB-${digest$1.slice(0, 24)}`,
		digest: digest$1,
		...normalized,
		status: "pending"
	};
}
/** The exact 0.4-era propose response, frozen for legacy replay validation. */
function frozenV042ProposeResponse(p, args) {
	const candidate = proposeRebindV042(p, args);
	if (!candidate) return {
		status: "rejected",
		reason_code: "source_partition_required",
		next_step: "Supply 1-8 exact consecutive clauses covering the original text, including unsupported work; the proposal must fit 8 KiB. Clarification that changes meaning requires a new root-user instruction."
	};
	return {
		status: "proposed",
		proposal: p.rebindProposals.get(candidate.id) ?? candidate,
		next_step: `Root user must reply exactly: 确认重绑定 ${candidate.id}. This changes the contract only and grants no execution permission.`
	};
}
/** Structured v0.5 replay match: semantic fields exact, display text exempt. */
function rebindResponseMatchesV050(expected, recorded) {
	if (!recorded || typeof recorded !== "object" || Array.isArray(recorded)) return false;
	const strip = (value) => {
		const { next_step: _display,...rest } = value;
		return rest;
	};
	return JSON.stringify(strip(expected)) === JSON.stringify(strip(recorded));
}
/** The 0.4-era query/withdraw responses, frozen for legacy replay validation. */
function frozenV042Response(p, args) {
	if (args.operation === "propose") return frozenV042ProposeResponse(p, args);
	const proposal = p.rebindProposals.get(args.proposal_id ?? "");
	if (!proposal) return {
		status: "rejected",
		reason_code: "proposal_not_found"
	};
	if (args.operation === "withdraw") return proposal.status === "confirmed" ? {
		status: "rejected",
		reason_code: "proposal_already_applied"
	} : {
		status: "withdrawn",
		proposal_id: proposal.id,
		digest: proposal.digest
	};
	if (args.operation !== "query") return {
		status: "rejected",
		reason_code: "invalid_rebind_operation"
	};
	return proposal.status === "pending" && (proposal.contractRevision !== p.contractRevision || proposal.epoch !== p.epoch || proposal.session !== p.sessionRefDigest) ? {
		status: "stale",
		reason_code: "proposal_contract_changed",
		proposal: {
			...proposal,
			status: "stale"
		},
		next_step: "Propose again against the current contract."
	} : {
		status: proposal.status,
		proposal
	};
}
function proposalConfirmation(p, proposal) {
	if (proposal.status === "confirmed") return {
		state: "confirmed",
		event: proposal.confirmationEvent,
		replacement_ids: proposal.replacementIds
	};
	if (proposal.status === "pending" && proposal.observedUnconfirmedEvent) return {
		state: "not_durable",
		event: proposal.observedUnconfirmedEvent
	};
	return { state: "not_received" };
}
/** Stable attempt key: item identity, exact inputs, and outcome class. Identical
* retries collapse onto it no matter how many unrelated log rows intervene. */
function rebindAttemptKey(p, args, reasonCode) {
	const item = p.items.get(args.item_id ?? "");
	const evidence = item ? [...p.evidence.values()].filter((value) => relevantEvidence(p, item, value)) : [];
	return sha256(JSON.stringify([
		p.epoch,
		p.contractRevision,
		p.hostLockDigest,
		evidence,
		args.item_id ?? null,
		args.clauses ?? null,
		args.clarification_item_ids ?? null,
		reasonCode
	]));
}
function rebindResponse(p, args) {
	if (!p.enabled || p.integrity !== "valid") return {
		status: "unknown",
		reason_code: "guard_unavailable"
	};
	if (Object.keys(args).some((key) => ![
		"operation",
		"item_id",
		"proposal_id",
		"clauses",
		"clarification_item_ids"
	].includes(key))) return {
		status: "rejected",
		reason_code: "invalid_rebind_parameters"
	};
	if (args.operation === "propose") {
		const outcome = proposeRebindOutcome(p, args);
		if (!outcome.ok) {
			const key = rebindAttemptKey(p, args, outcome.reasonCode);
			if ((p.rebindRejections.get(key) ?? 0) > 0) return {
				status: "unchanged",
				reason_code: outcome.reasonCode,
				resume_condition: "No input changed since the previous identical attempt. New related evidence, a new root instruction, or a changed target re-opens evaluation."
			};
			const response = {
				status: "rejected",
				reason_code: outcome.reasonCode
			};
			if (outcome.source) response.expected_source = outcome.source;
			response.next_step = proposeNextStep(outcome.reasonCode);
			return response;
		}
		const candidate = outcome.proposal;
		return {
			status: "proposed",
			proposal: p.rebindProposals.get(candidate.id) ?? candidate,
			next_step: `Root user must reply with the control line 确认重绑定 ${candidate.id} alone on its first line. Follow-up requests or new tasks may follow after a blank line and keep their own meaning; confirmation adds no execution permission.`
		};
	}
	if (args.operation === "query" && !args.proposal_id && args.item_id) {
		const item = p.items.get(args.item_id);
		if (!item) return {
			status: "rejected",
			reason_code: "item_not_found"
		};
		if (item.status !== "pending") return {
			status: "rejected",
			reason_code: "item_not_pending",
			item_id: item.id,
			item_status: item.status
		};
		const pendingProposal = [...p.rebindProposals.values()].find((candidate) => candidate.status === "pending" && candidate.itemId === item.id && candidate.contractRevision === p.contractRevision && candidate.epoch === p.epoch);
		return {
			status: "item_status",
			item: {
				id: item.id,
				revision: item.revision,
				kind: item.kind,
				status: item.status,
				...item.semanticAction !== void 0 ? { semantic_action: item.semanticAction } : {},
				...item.targetCaptureStatus !== void 0 ? { target_capture_status: item.targetCaptureStatus } : {}
			},
			diagnosis: deriveItemDiagnosis(p, item),
			...pendingProposal ? { pending_proposal_id: pendingProposal.id } : {}
		};
	}
	const proposal = p.rebindProposals.get(args.proposal_id ?? "");
	if (!proposal) return {
		status: "rejected",
		reason_code: "proposal_not_found"
	};
	if (args.operation === "withdraw") return proposal.status === "confirmed" ? {
		status: "rejected",
		reason_code: "proposal_already_applied"
	} : {
		status: "withdrawn",
		proposal_id: proposal.id,
		digest: proposal.digest
	};
	if (args.operation !== "query") return {
		status: "rejected",
		reason_code: "invalid_rebind_operation"
	};
	if (proposal.status === "pending" && (proposal.contractRevision !== p.contractRevision || proposal.epoch !== p.epoch || proposal.session !== p.sessionRefDigest)) return {
		status: "stale",
		reason_code: "proposal_contract_changed",
		proposal: {
			...proposal,
			status: "stale"
		},
		confirmation: { state: "not_received" },
		next_step: "Propose again against the current contract; unrelated new work makes the old proposal stale."
	};
	return {
		status: proposal.status,
		proposal,
		confirmation: proposalConfirmation(p, proposal)
	};
}
function proposeNextStep(reasonCode) {
	switch (reasonCode) {
		case "no_certification_gain": return "No certification gain: this split keeps every part generic_run. Report the work honestly instead of asking the user to confirm a relabeled proposal; a real scope change needs a new root-user instruction.";
		case "partition_mismatch": return "The clauses do not exactly cover the original text. Copy the expected source verbatim (see expected_source) and re-partition without changing any character.";
		case "payload_too_large": return "The proposal exceeds 8 KiB. Split into smaller independent proposals.";
		case "unsupported_clarification": return "This item cannot be re-bound by proposal: it needs a fresh root-user instruction or is not a re-bindable requirement.";
		case "item_not_pending": return "The item is not pending; query the checkpoint page for its current state.";
		default: return "Unknown item: query context_guard_checkpoint for the current contract items.";
	}
}
/**
* Replay validation with version dispatch (A12): structured v0.5 results
* match semantically (display text may evolve); results carrying the frozen
* 0.4 response shapes validate against the frozen 0.4 rules exactly. Anything
* else is tampered or unknown and never replays.
*/
function replayRebindResult(p, args, recorded) {
	const expected = rebindResponse(p, args);
	const legacy = isFrozenV042RebindResponse(recorded) && (() => {
		const frozen = frozenV042Response(p, args);
		return frozen !== void 0 && JSON.stringify(frozen) === JSON.stringify(recorded);
	})();
	if (!legacy && !rebindResponseMatchesV050(expected, recorded)) return;
	if (args.operation === "propose") {
		if (p.rebindProposals.get(String(recorded.proposal?.id ?? ""))) return;
		const rebuilt = legacy ? proposeRebindV042(p, args) : (() => {
			const outcome = proposeRebindOutcome(p, args);
			return outcome.ok ? outcome.proposal : void 0;
		})();
		if (rebuilt) p.rebindProposals.set(rebuilt.id, rebuilt);
		return;
	}
	if (args.operation === "withdraw") {
		const proposal = p.rebindProposals.get(args.proposal_id ?? "");
		if (proposal?.status === "pending") proposal.status = "withdrawn";
	}
}
/** Register an observed but not-yet-applied confirmation attempt (non-durable replay). */
function observeUnconfirmed(p, proposalId, eventId) {
	const proposal = p.rebindProposals.get(proposalId);
	if (proposal && proposal.status === "pending") proposal.observedUnconfirmedEvent = eventId;
}
/** Invoked only for a canonical root user message, never tool or plugin text.
* The single durable confirmation event is the atomic transaction commit:
* the confirmation validates against the state BEFORE this message, and the
* caller processes the remaining text afterwards with its own semantics. */
function confirmRebind(p, proposalId, eventId, durable) {
	if (!/^RB-[a-f0-9]{24}$/.test(proposalId)) return false;
	const proposal = p.rebindProposals.get(proposalId);
	if (!proposal) return true;
	if (!durable) {
		observeUnconfirmed(p, proposalId, eventId);
		return true;
	}
	if (proposal.status !== "pending") return true;
	const old = p.items.get(proposal.itemId);
	const repropose = proposal.protocol === "v050" ? proposeRebindOutcome(p, {
		operation: "propose",
		item_id: old?.id,
		clauses: proposal.clauses,
		clarification_item_ids: proposal.clarificationItemIds
	}) : (() => {
		const rebuilt = proposeRebindV042(p, {
			operation: "propose",
			item_id: old?.id,
			clauses: proposal.clauses,
			clarification_item_ids: proposal.clarificationItemIds
		});
		return rebuilt ? {
			ok: true,
			proposal: rebuilt
		} : { ok: false };
	})();
	if (!old || proposal.session !== p.sessionRefDigest || proposal.epoch !== p.epoch || old.status !== "pending" || old.revision !== proposal.itemRevision || p.contractRevision !== proposal.contractRevision || !(repropose.ok && repropose.proposal.digest === proposal.digest)) {
		proposal.status = "stale";
		return true;
	}
	const revision = p.contractRevision + 1;
	const replacements = proposal.clauses.map((clause, index) => {
		const clarified = p.items.get(proposal.clarificationItemIds[index] ?? "");
		if (clarified) return {
			...clarified,
			reboundFrom: {
				itemId: old.id,
				proposalId: proposal.id,
				confirmationEvent: eventId
			}
		};
		const captured = captureItem(old.kind, clause, old.sourceMessageId, `${old.kind[0].toUpperCase()}:${proposal.id}:${index + 1}`, revision, old.verification.subject ?? "scope", old.verification.surface === "artifact" ? "artifact" : "scope", old.verification.method ?? extractMethod(clause), old.verification.operation ?? extractOperation(clause));
		if (captured.semanticAction !== old.semanticAction) captured.semanticAction = "generic_run";
		return {
			...captured,
			authority: old.authority,
			reboundFrom: {
				itemId: old.id,
				proposalId: proposal.id,
				confirmationEvent: eventId
			},
			verification: {
				...captured.verification,
				...old.verification
			}
		};
	});
	if (replacements.some((item) => p.items.has(item.id) && !proposal.clarificationItemIds.includes(item.id))) {
		proposal.status = "stale";
		return true;
	}
	for (const item of replacements) p.items.set(item.id, item);
	old.status = "superseded";
	old.supersededByItems = replacements.map((item) => item.id);
	old.supersededBy = replacements[0].id;
	p.contractRevision = revision;
	proposal.status = "confirmed";
	proposal.confirmationEvent = eventId;
	proposal.replacementIds = old.supersededByItems;
	return true;
}

//#endregion
//#region src/domain/types.ts
function createProjection() {
	return {
		enabled: false,
		epoch: 0,
		contractRevision: 0,
		rebindProposals: /* @__PURE__ */ new Map(),
		items: /* @__PURE__ */ new Map(),
		evidence: /* @__PURE__ */ new Map(),
		checkpoints: [],
		boundaries: [],
		externalOperations: /* @__PURE__ */ new Map(),
		units: /* @__PURE__ */ new Map(),
		coverage: [],
		releaseContracts: [],
		releaseReservations: [],
		releaseSettlements: [],
		releaseDiagnostics: [],
		releaseStateDamaged: false,
		policy: "standard",
		trustedSelections: [],
		interpretationFacts: [],
		approvals: [],
		sessionRefDigest: "11".repeat(32),
		hostLockDigest: "22".repeat(32),
		hostStatus: "supported",
		integrityViolations: [],
		lastObservedSourceSeq: -1,
		lastGuardEventSeq: -1,
		continuationAttempts: /* @__PURE__ */ new Map(),
		persistenceCorrectionAttempts: /* @__PURE__ */ new Map(),
		noProgressClaims: /* @__PURE__ */ new Map(),
		handledControlSeqs: /* @__PURE__ */ new Set(),
		rebindRejections: /* @__PURE__ */ new Map(),
		durabilityWatermark: "unknown",
		integrity: "valid"
	};
}

//#endregion
//#region src/domain/contract-digest.ts
function stable$3(value) {
	if (Array.isArray(value)) return `[${value.map(stable$3).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stable$3(entry)}`).join(",")}}`;
	return JSON.stringify(value);
}
/** One authoritative contract identity shared by checkpoints and boundaries. */
function currentContractDigest(projection) {
	return sha256(stable$3([...projection.items.values()].sort((a, b) => a.id.localeCompare(b.id)).map((item) => [
		item.id,
		item.revision,
		item.kind,
		item.status,
		item.textSha256,
		item.semanticAction ?? null,
		item.requestedTarget ?? null
	])));
}

//#endregion
//#region src/domain/boundary.ts
/** Bounded, replay-derived qualifications that callers may cite verbatim. */
function availableBoundaryQualifications(projection) {
	const rows = [];
	for (const item of projection.items.values()) {
		if (item.status !== "pending") continue;
		if (item.waitAuthorization) rows.push({
			id: item.waitAuthorization.id,
			kind: item.waitAuthorization.kind,
			disposition: "user_wait",
			source: "root_contract",
			status: "pending"
		});
		if (item.deferAuthorization) rows.push({
			id: item.deferAuthorization.id,
			kind: item.deferAuthorization.kind,
			disposition: "deferred",
			source: "root_contract",
			status: "pending"
		});
	}
	for (const operation of projection.externalOperations.values()) {
		if (operation.epoch !== projection.epoch || operation.status !== "pending" && operation.status !== "running") continue;
		rows.push({
			id: operation.id,
			kind: "external_operation_pending",
			disposition: "external_wait",
			source: "trusted_adapter",
			status: operation.status
		});
	}
	return rows.sort((a, b) => a.id.localeCompare(b.id)).slice(0, 32);
}
function qualificationReason(projection, request) {
	const ids = new Set(request.qualificationIds);
	if (ids.size !== request.qualificationIds.length || ids.size === 0) return "boundary_qualification_ids_invalid";
	if (request.disposition === "user_wait") {
		if (request.qualificationKind !== "root_explicit_wait" && request.qualificationKind !== "user_decision_item") return "boundary_qualification_kind_mismatch";
		const known$1 = new Set([...projection.items.values()].filter((item) => item.status === "pending" && item.waitAuthorization?.kind === request.qualificationKind).map((item) => item.waitAuthorization.id));
		return request.qualificationIds.every((id) => known$1.has(id)) ? void 0 : "boundary_disposition_unqualified";
	}
	if (request.disposition === "external_wait") {
		if (request.qualificationKind !== "external_operation_pending") return "boundary_qualification_kind_mismatch";
		return request.qualificationIds.every((id) => {
			const operation = projection.externalOperations.get(id);
			return operation?.epoch === projection.epoch && (operation.status === "running" || operation.status === "pending");
		}) ? void 0 : "boundary_disposition_unqualified";
	}
	if (request.disposition === "guard_bounded_stop") {
		if (request.qualificationKind !== "guard_no_progress") return "boundary_qualification_kind_mismatch";
		const fingerprint$1 = request.qualificationIds.length === 1 ? request.qualificationIds[0] : void 0;
		if (!fingerprint$1 || fingerprint$1 !== progressFingerprint(projection)) return "boundary_disposition_unqualified";
		return (projection.noProgressClaims.get(fingerprint$1)?.size ?? 0) >= NO_PROGRESS_TURNS_BEFORE_STOP - 1 ? void 0 : "boundary_disposition_unqualified";
	}
	if (request.qualificationKind !== "root_explicit_defer") return "boundary_qualification_kind_mismatch";
	const known = new Set([...projection.items.values()].filter((item) => item.status === "pending" && item.deferAuthorization?.kind === request.qualificationKind).map((item) => item.deferAuthorization.id));
	return request.qualificationIds.every((id) => known.has(id)) ? void 0 : "boundary_disposition_unqualified";
}
function qualifyBoundary(projection, request) {
	const contractSha256 = currentContractDigest(projection);
	const reason = projection.integrity !== "valid" ? "boundary_integrity_invalid" : projection.hostStatus !== "supported" && projection.currentGoalRef ? "boundary_host_lock_unsupported" : qualificationReason(projection, request);
	const manifest = {
		protocolVersion: "1",
		disposition: request.disposition,
		qualificationKind: request.qualificationKind,
		qualificationIds: [...request.qualificationIds].sort(),
		epoch: projection.epoch,
		contractRevision: projection.contractRevision,
		contractSha256,
		goalRef: projection.currentGoalRef ?? null
	};
	const candidateSha256 = sha256(JSON.stringify(manifest));
	return {
		protocolVersion: "1",
		id: `B${projection.boundaries.length + 1}`,
		disposition: request.disposition,
		qualificationKind: request.qualificationKind,
		qualificationIds: [...request.qualificationIds],
		epoch: projection.epoch,
		contractRevision: projection.contractRevision,
		contractSha256,
		...projection.currentGoalRef ? { goalRef: { ...projection.currentGoalRef } } : {},
		candidateSha256,
		...request.callId ? { callId: request.callId } : {},
		persistedResult: reason ? "rejected" : "accepted",
		reasonCode: reason ?? "boundary_persisted_accepted"
	};
}
/**
* Reconstruct the immutable candidate against the latest replay projection.
* A persisted acceptance is not effectuation authority after any contract,
* Goal, epoch, or qualification change.
*/
function isCurrentAcceptedBoundary(projection, boundary) {
	if (boundary.persistedResult !== "accepted" || boundary.epoch !== projection.epoch || boundary.contractRevision !== projection.contractRevision || boundary.contractSha256 !== currentContractDigest(projection)) return false;
	const currentGoal = projection.currentGoalRef;
	if (boundary.goalRef ? !currentGoal || !sameRef(currentGoal, boundary.goalRef) : currentGoal !== void 0) return false;
	const reconstructed = qualifyBoundary(projection, {
		disposition: boundary.disposition,
		qualificationKind: boundary.qualificationKind,
		qualificationIds: boundary.qualificationIds,
		...boundary.callId ? { callId: boundary.callId } : {}
	});
	return reconstructed.persistedResult === "accepted" && reconstructed.candidateSha256 === boundary.candidateSha256;
}
function sameRef(state, ref) {
	return state?.id === ref.id && state.revision === ref.revision;
}
/**
* Effectuate only a replay-confirmed accepted boundary. The first disarm result
* and an independent get() must both read the same active Goal ref as disarmed.
* A failure after disarm may have taken effect is never auto-rearmed.
*/
async function effectuateBoundary(boundary, access) {
	const base = {
		boundaryId: boundary.id,
		...boundary.goalRef ? { goalRef: boundary.goalRef } : {}
	};
	if (boundary.persistedResult !== "accepted") return {
		...base,
		reasonCode: "boundary_not_accepted",
		stopAllowed: false,
		resumeRequired: false
	};
	if (access.requalify) try {
		if (!await access.requalify()) return {
			...base,
			reasonCode: "boundary_pre_effect_failure",
			stopAllowed: false,
			resumeRequired: false
		};
	} catch {
		return {
			...base,
			reasonCode: "boundary_pre_effect_failure",
			stopAllowed: false,
			resumeRequired: false
		};
	}
	if (!boundary.goalRef) return {
		...base,
		reasonCode: "boundary_no_goal_safe_yield",
		stopAllowed: true,
		resumeRequired: false
	};
	let before;
	try {
		before = await access.get();
	} catch {
		return {
			...base,
			reasonCode: "boundary_pre_effect_failure",
			stopAllowed: false,
			resumeRequired: false
		};
	}
	if (!sameRef(before, boundary.goalRef) || before?.phase !== "active") return {
		...base,
		reasonCode: "boundary_goal_ref_stale",
		stopAllowed: false,
		resumeRequired: false
	};
	if (before.activation === "disarmed") return {
		...base,
		reasonCode: "boundary_already_disarmed",
		stopAllowed: true,
		resumeRequired: false
	};
	let firstReadback;
	try {
		firstReadback = await access.disarm();
	} catch {
		return {
			...base,
			reasonCode: "boundary_post_effect_unknown",
			stopAllowed: false,
			resumeRequired: true
		};
	}
	if (!firstReadback || !sameRef(firstReadback, boundary.goalRef) || firstReadback.phase !== "active") return {
		...base,
		reasonCode: "boundary_post_effect_unknown",
		stopAllowed: false,
		resumeRequired: true
	};
	if (firstReadback.activation !== "disarmed") return {
		...base,
		reasonCode: "boundary_readback_still_armed",
		stopAllowed: false,
		resumeRequired: false
	};
	try {
		const independent = await access.get();
		if (!sameRef(independent, boundary.goalRef) || independent?.phase !== "active") return {
			...base,
			reasonCode: "boundary_post_effect_unknown",
			stopAllowed: false,
			resumeRequired: true
		};
		if (independent.activation !== "disarmed") return {
			...base,
			reasonCode: "boundary_readback_still_armed",
			stopAllowed: false,
			resumeRequired: false
		};
	} catch {
		return {
			...base,
			reasonCode: "boundary_post_effect_unknown",
			stopAllowed: false,
			resumeRequired: true
		};
	}
	return {
		...base,
		reasonCode: "boundary_effectuated",
		stopAllowed: true,
		resumeRequired: false
	};
}

//#endregion
//#region src/domain/work-unit.ts
/**
* Work-unit derivation rules (0.6.0, C04). Units are derived from the durable
* message stream — nothing is ever written to the log — so the classification
* below must stay deterministic and conservative: an ambiguous relation keeps
* the current unit rather than inventing a new one, and a mis-assigned
* obligation is recoverable through clarification, never through a silent
* unit rewrite.
*
* The rules are the frozen P0 §3 C04 decision, in evaluation order:
*
* 1. The session's first root task message opens U001.
* 2. A message explicitly linked to the current unit (item-ID reference,
*    rebind control, a direct answer while an inquiry is open) stays in it.
* 3. When the current unit has no open executable obligations left, a
*    directive-bearing message opens a new unit; the old one is switched away,
*    never retroactively closed.
* 4. While the current unit still has open work, only an EXPLICIT switch
*    marker (closed vocabulary, fixture-pinned) opens a new unit; anything
*    else stays in the current unit.
* 5. A DELEGATION-marked message opens a CHILD unit of the current unit. The
*    child's open obligations are required descendants of the parent's
*    closure (C04), so the parent cannot be certified while the delegated
*    work is open, and the delegated result itself never closes the parent.
*/
/** Explicit task-switch markers; a closed vocabulary pinned by the v2 fixture. */
const SWITCH_MARKER = new RegExp([
	"^(?:另外|此外|另一(?:件事|个任务|个话题)|换个?话题|下一个任务|新任务|下一个问题|先做(?:另一|别的))[：:，,。。\\s]",
	"^(?:now\\s+a\\s+)?(?:different|new|separate)\\s+task\\b",
	"^next\\s+task\\b",
	"^(?:on\\s+a\\s+related\\s+note|by\\s+the\\s+way)\\b"
].join("|"), "i");
/**
* Explicit delegation markers; the same closed-vocabulary discipline as the
* switch markers, pinned by the v2 fixture. Only a root message that actually
* hands work to a subagent/subtask opens a child unit — "let the subagent …",
* "delegate … to a subagent", "spawn a subagent …".
*/
const DELEGATION_MARKER = new RegExp([
	"(?:让|由|交给|委派给?|派给|安排)(?:一个)?(?:子代理|子任务|子会话|小助手)",
	"(?:子代理|子任务|子会话)(?:去|来|负责|执行|完成)",
	"\\bdelegate\\s+(?:this|it|the\\s+\\w+|\\w+)\\s+to\\s+(?:a\\s+|the\\s+)?(?:subagent|sub-agent|child\\s+agent)\\b",
	"\\b(?:spawn|dispatch|hand\\s+(?:this|it)\\s+off\\s+to)\\s+(?:a\\s+|the\\s+)?(?:subagent|sub-agent|child\\s+agent)\\b",
	"\\bsub-?agent\\s+(?:should|must|to)\\s+\\w+"
].join("|"), "i");
/**
* Whether a root message opens a new work unit rather than joining the
* current one. `directiveBearing` says the message produced (or would
* produce) requirement/acceptance work; `openWorkInCurrentUnit` is evaluated
* against the state BEFORE the message is captured.
*/
function opensNewUnit(projection, text, directiveBearing, openWorkInCurrentUnit) {
	if (!directiveBearing) return false;
	if (DELEGATION_MARKER.test(text)) return true;
	if (SWITCH_MARKER.test(text)) return true;
	return !openWorkInCurrentUnit;
}
/**
* Whether this message opens a child (delegated) unit of the current unit
* rather than a sibling. Only meaningful together with {@link opensNewUnit}.
*/
function opensChildUnit(projection, text) {
	return projection.currentUnitId !== void 0 && DELEGATION_MARKER.test(text);
}
/** An explicit reference to a contract item identity (R001/A001/P001/U001). */
const ITEM_REFERENCE = /\b([RAPU]\d{3})\b/g;
/**
* Whether the message explicitly links itself to the current unit's items.
*
* A reference counts only when it names an item that still exists as live work:
* an ID that never existed, or one already `passed`/`superseded`, is history and
* cannot pull a new instruction back into an old unit. A live item binds when it
* belongs to the current unit's lineage — the current unit, an ancestor, or a
* required descendant — while a unit-less (pre-v5) obligation is always a
* legitimate continuation target.
*/
function explicitlyLinkedToCurrentUnit(projection, text) {
	const current = projection.currentUnitId;
	const lineage = current === void 0 ? void 0 : new Set([
		current,
		...unitAncestorIds(projection, current),
		...unitDescendantIds(projection, current)
	]);
	for (const match of text.matchAll(ITEM_REFERENCE)) {
		const item = projection.items.get(match[1]);
		if (!item) continue;
		if (item.status === "passed" || item.status === "superseded") continue;
		if (lineage === void 0 || item.unitId === void 0) return true;
		if (lineage.has(item.unitId)) return true;
	}
	return false;
}
/** The next unit identity in the session's sequence. */
function nextUnitId(projection) {
	let max = 0;
	for (const unitId of projection.units.keys()) {
		const num = Number(unitId.slice(1));
		if (Number.isInteger(num) && num > max) max = num;
	}
	return `U${String(max + 1).padStart(3, "0")}`;
}
/**
* Open a work unit.
*
* A SIBLING unit (no parent) becomes current and switches the previous current
* unit away: that is a task switch, and the old unit's residual work stays
* visible but no longer blocks the new task.
*
* A CHILD unit (delegated sub-unit) does NOT become current. The parent keeps
* owning the session's certified scope, so the parent's own obligations are
* never dropped when it delegates part of the work — the child's obligations
* join the parent's closure as required descendants instead (C04). The child
* is only ever created under an existing parent; a stray parent id would
* create an orphan lineage, so it is dropped.
*/
function openUnit(projection, seq, headline, parentUnitId) {
	const unitId = nextUnitId(projection);
	const parent = parentUnitId !== void 0 && projection.units.has(parentUnitId) ? parentUnitId : void 0;
	if (parent === void 0) {
		const previous = projection.currentUnitId !== void 0 ? projection.units.get(projection.currentUnitId) : void 0;
		if (previous && previous.switchedAwayAtSeq === void 0) previous.switchedAwayAtSeq = seq;
		projection.currentUnitId = unitId;
	}
	const unit = {
		unitId,
		openedAtSeq: seq,
		rootInputRefs: [{ seq }],
		headline,
		...parent !== void 0 ? { parentUnitId: parent } : {}
	};
	projection.units.set(unitId, unit);
	return unit;
}
/** Fold one later root message into the current unit's input references. */
function foldIntoCurrentUnit(projection, seq) {
	const unit = projection.currentUnitId !== void 0 ? projection.units.get(projection.currentUnitId) : void 0;
	if (unit) unit.rootInputRefs.push({ seq });
}
/**
* The ancestors of `unitId`, nearest first. Lineage is derived from the
* derived `parentUnitId` chain; a cycle (impossible from the derivation, but
* possible in a hand-built projection) terminates instead of hanging.
*/
function unitAncestorIds(projection, unitId) {
	const ancestors = [];
	const seen = new Set([unitId]);
	let cursor = projection.units.get(unitId)?.parentUnitId;
	while (cursor !== void 0 && !seen.has(cursor)) {
		ancestors.push(cursor);
		seen.add(cursor);
		cursor = projection.units.get(cursor)?.parentUnitId;
	}
	return ancestors;
}
/**
* Every required descendant of `unitId`, in stable unit order: the units whose
* `parentUnitId` chain reaches `unitId`. The closure of a unit includes the
* open obligations of this set (C04).
*/
function unitDescendantIds(projection, unitId) {
	const descendants = [];
	const seen = new Set([unitId]);
	const queue = [unitId];
	while (queue.length > 0) {
		const current = queue.shift();
		for (const unit of projection.units.values()) {
			if (unit.parentUnitId !== current || seen.has(unit.unitId)) continue;
			seen.add(unit.unitId);
			descendants.push(unit.unitId);
			queue.push(unit.unitId);
		}
	}
	return descendants.sort();
}
/** Record one delegated round-trip inside a unit as bounded audit evidence. */
function recordDelegation(projection, unitId, ref) {
	const unit = projection.units.get(unitId);
	if (!unit) return;
	const refs = unit.delegationRefs ?? [];
	if (refs.some((entry) => entry.callId === ref.callId)) return;
	refs.push({ ...ref });
	unit.delegationRefs = refs;
}
/**
* Whether the current unit still holds open executable work — the rule-3
* handover test, evaluated BEFORE the new message's items are inserted.
*
* This is the SAME closure the certificate uses: the current unit's own open
* work plus the open work of every required descendant unit. A parent whose own
* items are all passed but whose delegated child is still open has not finished,
* so an ordinary follow-up must not be treated as a handover to a new sibling
* task — that would silently exclude the child from the certified scope.
*/
function currentUnitHasOpenWork(projection) {
	const current = projection.currentUnitId;
	if (current === void 0) return false;
	const closure = new Set([current, ...unitDescendantIds(projection, current)]);
	return [...projection.items.values()].some((item) => item.status === "pending" && item.unitId !== void 0 && closure.has(item.unitId) && item.kind !== "prohibition");
}

//#endregion
//#region src/domain/closure.ts
/**
* The single open-closure implementation (0.6.0, C02/C04/D06-03/D06-07).
*
* Before 0.6.0, checkpoint, recovery, diagnostics, and the Goal gate each
* filtered pending obligations with their own slightly different rule, and the
* answers could disagree. Every question about "what is open" now goes through
* this module:
*
* - {@link visiblePendingItems} — everything still pending, constraints first
*   in spirit: display surfaces (recovery, status, checkpoint pages) show
*   prohibitions too, because a constraint is never finished work.
* - {@link certifiableOpenItems} — the obligations a completion certificate
*   answers for: pending, not a prohibition. Prohibitions are standing
*   constraints, never counted work; `answered` items closed by a trusted
*   delivery are no longer open; `passed` and `superseded` never were.
* - {@link unitClosureItemIds} — the v5 unit closure: the certified scope of
*   one work unit, which is the unit's OWN open obligations PLUS the open
*   obligations of every required descendant unit.
* - {@link ancestorConstraints} / {@link ancestorConstraintForBinding} — the
*   ancestor units' standing constraints (prohibitions and unsatisfied
*   conditions) that stay in force for a descendant's matching obligations.
*
* Legacy sessions (no v5 boundary) have no units: they certify the whole
* session, exactly what {@link certifiableOpenItems} returns.
*/
/** Every pending item, in stable display order. Constraints stay visible. */
function visiblePendingItems(projection) {
	return [...projection.items.values()].filter((item) => item.status === "pending").sort((a, b) => a.revision - b.revision || (a.id < b.id ? -1 : 1));
}
/** The obligations a completion certificate answers for: open work, no constraints. */
function certifiableOpenItems(projection) {
	return visiblePendingItems(projection).filter((item) => item.kind !== "prohibition");
}
/**
* 0.6.3 K4: the records in the certificate's own scope that the upgrade
* eligibility check refused to inherit. They are NOT reopened as current debt
* and no business effect is repeated — they block the CURRENT conclusion until
* the root resolves them, which is what makes an old misreading stop being
* silently carried forward. The scan deliberately includes records the
* terminal filter would skip (`answered`), because that filter is exactly what
* hid the 0.6.2 mixed-request misreading.
*/
function needsReviewObligations(projection) {
	const ordering = (a, b) => a.revision - b.revision || (a.id < b.id ? -1 : 1);
	const units = projection.boundaryProtocol === 5 && projection.currentUnitId !== void 0 ? new Set([projection.currentUnitId, ...unitDescendantIds(projection, projection.currentUnitId)]) : void 0;
	return [...projection.items.values()].filter((item) => {
		if (item.needsReview === void 0) return false;
		if (item.unitId === void 0) return true;
		if (units === void 0) return false;
		return units.has(item.unitId);
	}).sort(ordering);
}
/**
* The certifiable open obligations inside one work unit's closure: the unit's
* own open work plus the open work of every required descendant unit.
*
* A delegated child unit is REQUIRED work of its parent (C04): the parent has
* not finished while the sub-unit it handed work to still has open
* obligations, so the parent's certificate must answer for them too. The
* reverse is deliberately not true — a child may be certified while unrelated
* residual work exists in an ancestor or a sibling, which is what keeps a task
* switch from being blocked by history.
*/
function unitClosureItemIds(projection, unitId) {
	if (projection.boundaryProtocol !== 5) return [];
	const inClosure = new Set([unitId, ...unitDescendantIds(projection, unitId)]);
	return certifiableOpenItems(projection).filter((item) => item.unitId !== void 0 && inClosure.has(item.unitId)).map((item) => item.id);
}
/** Whether a prohibition declares no identity at all — a blanket ban on the action. */
function isBlanketProhibition(action, requested) {
	const key = requestedIdentityKey(action);
	if (!key) return false;
	return !requested || !Object.hasOwn(requested, key);
}
/** The ancestor obligations that act as standing constraints on this unit. */
function standingAncestorConstraints(projection, unitId) {
	if (projection.boundaryProtocol !== 5) return [];
	const ancestors = unitAncestorIds(projection, unitId);
	if (ancestors.length === 0) return [];
	return visiblePendingItems(projection).filter((item) => {
		if (item.unitId === void 0 || !ancestors.includes(item.unitId)) return false;
		if (item.kind === "prohibition") return true;
		return item.authorityDisposition === "conditional_wait" || item.waitAuthorization !== void 0;
	});
}
/**
* The ancestor constraint that blocks certifying `item` against a resolved
* target, if any. This is the authoritative judge used by the certifier: the
* ancestor constraint is compared with the SAME conservative identity rule the
* mutation authorization uses, so a ban or an unsatisfied condition cannot be
* discharged by certifying a descendant obligation that resolves the target
* the ancestor constrained.
*/
function ancestorConstraintForBinding(projection, item, resolvedTarget) {
	if (item.unitId === void 0) return void 0;
	const action = item.semanticAction;
	if (!action || action === "generic_run" || !isStatefulAction(action)) return void 0;
	for (const constraint of standingAncestorConstraints(projection, item.unitId)) {
		if (constraint.id === item.id || constraint.semanticAction !== action) continue;
		if (!(constraint.kind === "prohibition" && isBlanketProhibition(action, constraint.requestedTarget) || requestedTargetMatchesResolved(action, constraint.requestedTarget, resolvedTarget))) continue;
		return {
			constraintId: constraint.id,
			constraintUnitId: constraint.unitId,
			itemId: item.id,
			kind: constraint.kind === "prohibition" ? "prohibition" : "condition",
			reasonCode: constraint.kind === "prohibition" ? "ancestor_prohibition_active" : "ancestor_condition_unsatisfied"
		};
	}
}
/**
* The closure a completion certificate must answer for right now.
*
* Legacy sessions certify the whole session. v5 sessions certify the current
* work unit's closure PLUS every pre-v5 obligation: items captured before the
* boundary carry no unit and keep their birth rules, so a unit certificate
* must never silently shrink their scope (migration table, P0 §6).
*/
function certificateClosure(projection) {
	if (projection.boundaryProtocol === 5) {
		const legacyIds = certifiableOpenItems(projection).filter((item) => item.unitId === void 0).map((item) => item.id);
		const unitIds = projection.currentUnitId !== void 0 ? unitClosureItemIds(projection, projection.currentUnitId) : [];
		return {
			unitId: projection.currentUnitId,
			itemIds: [...legacyIds, ...unitIds]
		};
	}
	return { itemIds: certifiableOpenItems(projection).map((item) => item.id) };
}

//#endregion
//#region src/domain/goal-gate.ts
function hasCurrentCertificate(projection) {
	const checkpoint = projection.checkpoints.at(-1);
	let reason;
	if (projection.integrity !== "valid") reason = "integrity_invalid";
	else if (needsReviewObligations(projection).length > 0) reason = "legacy_record_needs_review";
	else if (projection.hostStatus !== "supported") reason = "host_lock_unsupported";
	else if (!checkpoint || checkpoint.result !== "certified") reason = "certificate_missing";
	else if (checkpoint.epoch !== projection.epoch) reason = "stale_epoch";
	else if (checkpoint.sessionRefDigest !== projection.sessionRefDigest) reason = "foreign_session";
	else if (checkpoint.hostLockDigest !== projection.hostLockDigest) reason = "stale_host_lock";
	else if (checkpoint.contractRevision !== projection.contractRevision) reason = "stale_contract_revision";
	else if (projection.boundaryProtocol === 5) {
		if (checkpoint.certificateVersion !== "2") reason = "legacy_certificate_in_v5_session";
		else if (checkpoint.unitId !== projection.currentUnitId) reason = "stale_unit_ref";
	} else if (checkpoint.certificateVersion !== "1") reason = "certificate_version_unavailable";
	else if (projection.currentGoalRef ? checkpoint.goalRef?.id !== projection.currentGoalRef.id || checkpoint.goalRef.revision !== projection.currentGoalRef.revision : checkpoint.goalRef !== void 0) reason = "stale_goal_ref";
	projection.certificateStatusReason = reason;
	return reason === void 0;
}
/**
* Denies `update_goal(action=complete)` while the guard is enabled and no
* current completion certificate exists. The gate itself has no bypass; a
* workflow that genuinely finished but cannot certify (for example a contract
* polluted by session-layer talk, or evidence that lives in another session)
* has three explicit remediation routes:
*
* 1. `/context-guard off` disables the guard, so completion is no longer
*    gated. Use only after the user confirms the work is actually done.
* 2. `/context-guard clear` supersedes every pending requirement and
*    acceptance under a `CLEAR:<revision>` sentinel (prohibitions are
*    retained) and bumps the contract revision; an empty-binding checkpoint
*    can then certify while the guard stays enabled.
* 3. `update_goal(action=blocked)` records the blocker truthfully, which is
*    never denied by this gate.
*/
function goalCompletionDenial(projection, toolName, argumentsValue, configuredToolName = "update_goal") {
	if (toolName !== configuredToolName || typeof argumentsValue !== "object" || argumentsValue === null) return void 0;
	if (argumentsValue.action !== "complete") return void 0;
	if (!projection.enabled) return void 0;
	const args = argumentsValue;
	if (projection.hostStatus !== "supported") return `Context Guard denial [stale_host]: host lock is unsupported or unavailable (${projection.hostReasonCode ?? "unknown_host"}).`;
	if (!projection.currentGoalRef) return "Context Guard denial [no_goal]: no current Goal reference is available.";
	if (args.goal_id !== projection.currentGoalRef.id || args.revision !== projection.currentGoalRef.revision) return "Context Guard denial [stale_goal_ref]: update_goal must use the exact current goal_id and revision.";
	if (hasCurrentCertificate(projection)) return void 0;
	if (projection.certificateStatusReason === "stale_host_lock") return "Context Guard denial [stale_host]: the completion certificate belongs to a different host identity.";
	if (projection.certificateStatusReason === "stale_goal_ref") return "Context Guard denial [stale_goal_ref]: the completion certificate belongs to a different Goal reference.";
	return projection.integrity === "valid" ? "Context Guard denial [certificate_missing]: a current completion certificate is required." : "Context Guard denial [certificate_missing]: integrity is unknown or corrupt, so no current certificate is usable.";
}

//#endregion
//#region src/domain/stop-policy.ts
/**
* What "relevant progress" means, as one value.
*
* The inputs are the recorded state a caller could not have faked without
* changing the work itself: the epoch and contract revision, the open items and
* their blockers, the qualified evidence set, the boundary qualifications
* available right now, and the Goal's identity and activation. Deliberately
* absent: timestamps, event counts, wording, checkpoint bodies, and the Goal
* *revision* — editing a Goal's text is not progress, and treating it as such
* would let a re-statement reset the stop budget.
*/
/**
* How many times the same progress fingerprint must be observed at a turn
* boundary before Guard stops the automatic continuation.
*
* The first sighting is a baseline, not a stalled turn: it is the state a turn
* either advanced to or started from, and the host's driver owns continuation
* there. The second sighting is the first turn that produced nothing new, which
* earns the one diagnosis and correction opportunity. The third is the bounded
* stop. The count is a resource bound on repetition, never a way to declare the
* task finished.
*/
const NO_PROGRESS_TURNS_BEFORE_STOP = 3;
/** Marks the durable no-progress record; replay reads the budget from these. */
const NO_PROGRESS_RECORD_PREFIX = "Context Guard no-progress record: ";
/**
* The identity of the turn boundary a decision is taken at.
*
* Guard does not own the host's turn counter, and a retry must be recognisable
* as the same boundary rather than as a new one. The last durable event is that
* identity: it is derivable from the log alone, it is stable across a reload,
* and it only advances when the session actually records something new.
*/
function decisionBoundaryKey(projection) {
	return projection.hostTurn;
}
function progressFingerprint(projection) {
	const open = [...projection.items.values()].filter((item) => item.status === "pending").map((item) => `${item.id}:${item.revision}:${item.normalizedText}`).sort();
	const evidence = [...projection.evidence.values()].filter((row) => row.epoch === projection.epoch && row.outcome === "success").map((row) => row.id).sort();
	const qualifications = availableBoundaryQualifications(projection).map((row) => `${row.id}:${row.status}`).sort();
	return JSON.stringify({
		epoch: projection.epoch,
		contractRevision: projection.contractRevision,
		open,
		evidence,
		qualifications,
		goal: projection.currentGoalRef?.id ?? null
	});
}
const QUOTED = /["'“”‘’`].*?(?:complete|done|finished|完成|做完|搞定).*?["'“”‘’`]/i;
const EXAMPLE = /\b(?:for example|e\.g\.|such as|like saying|例如|比如|举例|作为一个例子)\b/i;
const QUESTION = /\?[ \t]*$|\b(?:should|could|would|can|will|what|how|whether)\b.*\?/i;
const TRAILING_NEGATION = /\b(?:not (?:yet |quite |fully )?(?:complete|done|finished)|isn'?t (?:complete|done|finished)|hasn'?t (?:been )?(?:completed|finished)|尚未完成|还没完成|未完成|没有完成|还未完成)\b/i;
const CONDITIONAL = /\b(?:if|unless|once|when|whenever|provided that|只要|如果|假如|一旦|除非)\b/i;
const PARTIAL_ONLY = /\b(?:step|phase|stage|milestone)\s+\d+\b|第[一二三四五六七八九十\d]+\s*(?:步|阶段|环节)|(?:第一步|第二步|第三步)/i;
const WHOLE_COMPLETION_EN = /\b(?:the )?(?:task|work|job|everything|all tasks?|all work) (?:is|are) (?:now )?(?:complete|done|finished|completed)\b|\b(?:task|work) (?:has been )?(?:completed|finished)\b|\ball (?:tasks|work|requirements) (?:have been )?(?:completed|done|met)\b/i;
const WHOLE_COMPLETION_ZH = /(?:任务|工作|所有任务|全部工作|整体)(?:已经|已)?(?:全部)?(?:完成|搞定|做完)|(?:已|已经)(?:全部|所有)?(?:完成|搞定)(?:了)?(?:全部|所有)?(?:任务|工作)?/i;
/** Bare completion confirmations, e.g. "Done." or "搞定了。" */
const BARE_COMPLETION = /^(?:done|finished|completed|all\s+done)[.!]?$|^(?:已完成|完成了|搞定了|搞定|完成|done)[。．.!！]?$/i;
/** Continuation intent following a claim makes it partial, not whole-task. */
const CONTINUATION = /接下来|下一步|然后|接着|继续|再去|最后再|还差|剩下|剩余|第二步|第三步|,\s*(?:next|then|after that|moving on)\b/i;
function looksQuotedOrExemplary(text) {
	return QUOTED.test(text) || EXAMPLE.test(text);
}
function isWholeTaskCompletionClaim(text) {
	const normalized = normalizeClause(text);
	if (!normalized) return false;
	if (QUESTION.test(normalized)) return false;
	if (TRAILING_NEGATION.test(normalized)) return false;
	if (CONDITIONAL.test(normalized)) return false;
	if (CONTINUATION.test(normalized)) return false;
	if (looksQuotedOrExemplary(normalized)) return false;
	if (PARTIAL_ONLY.test(normalized) && !WHOLE_COMPLETION_EN.test(normalized) && !WHOLE_COMPLETION_ZH.test(normalized)) return false;
	const firstLine = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? "";
	if (BARE_COMPLETION.test(normalizeTitleLine(firstLine))) return leadingBareCompletionClaim(text);
	return BARE_COMPLETION.test(normalized) || WHOLE_COMPLETION_EN.test(normalized) || WHOLE_COMPLETION_ZH.test(normalized);
}
const DECORATION_LEAD = /^\s*(?:[\p{Extended_Pictographic}\u2764\u2705\u2714\u2716\u2728\u274C\u26A0\u2611\u2612\u2713\u2717\u274E\u2B50\u2B55\u2022\u00B7\u25E6\u25AA\u25AB\u25CF\u25CB\u25A0\u25A1\u2013\u2014-]|\uFE0F|\uFE0E|\u200D)+/u;
/** Strip a leading run of decorative glyphs from a title line. */
function stripDecorationPrefix(text) {
	let value = text;
	let previous = "";
	while (value !== previous) {
		previous = value;
		value = value.replace(DECORATION_LEAD, "");
	}
	return value.replace(/^\s+/, "");
}
/**
* Normalize a title line for the bare-completion test. Markdown heading markers,
* fully-wrapping emphasis (`**…**`, `__…__`, `*…*`, `_…_`), and a leading run of
* decorative glyphs are removed ITERATIVELY until stable, because stripping one
* layer may expose another (`## ✅ **完成。**`). Blockquotes (`>`), quoted
* titles, and examples are left untouched so they still fail closed.
*/
function normalizeTitleLine(line) {
	let value = line.trim();
	if (value.startsWith(">")) return value;
	let previous = "";
	while (value !== previous) {
		previous = value;
		value = value.replace(/^#{1,6}\s+/, "").replace(/^\*\*(.+?)\*\*$/, "$1").replace(/^__(.+?)__$/, "$1").replace(/^\*(.+?)\*$/, "$1").replace(/^_(.+?)_$/, "$1");
		value = stripDecorationPrefix(value);
	}
	return value;
}
/**
* A reply whose first non-empty line is a standalone bare completion ("完成。"
* or "Done.") followed by a results summary. The whole text no longer matches
* the single-line BARE_COMPLETION anchor, but the summary must still be treated
* as a whole-task completion claim.
*/
function leadingBareCompletionClaim(text) {
	const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const first = lines[0];
	if (!first || !BARE_COMPLETION.test(normalizeTitleLine(first))) return false;
	const rest = normalizeClause(lines.slice(1).join("\n"));
	if (!rest) return true;
	if (CONTINUATION.test(rest)) return false;
	if (TRAILING_NEGATION.test(rest)) return false;
	if (CONDITIONAL.test(rest)) return false;
	if (looksQuotedOrExemplary(rest)) return false;
	if (PARTIAL_ONLY.test(rest)) return false;
	return true;
}
function classifyCompletionClaim(text) {
	const normalized = normalizeClause(text);
	if (/waiting for (?:you|the user|input|your)|please (?:review|confirm|approve)|等待(?:您|你|用户)|请(?:确认|审阅|批准)/i.test(normalized)) return "user_wait";
	if (/waiting for (?:the )?(?:result|output|response|build|test|deployment)|等待(?:结果|输出|构建|测试|部署|响应)/i.test(normalized)) return "external_wait";
	if (isWholeTaskCompletionClaim(normalized)) return "complete";
	return "report";
}
/** Assistant prose is retained only as a bounded diagnostic observation. */
function observeAssistantOutcome(text) {
	const disposition = classifyCompletionClaim(text);
	if (disposition === "complete") return {
		kind: "completion_claim",
		reasonCode: "assistant_completion_claim_observed"
	};
	if (disposition === "user_wait") return {
		kind: "user_wait_claim",
		reasonCode: "assistant_user_wait_claim_observed"
	};
	if (disposition === "external_wait") return {
		kind: "external_wait_claim",
		reasonCode: "assistant_external_wait_claim_observed"
	};
	return {
		kind: "report",
		reasonCode: "assistant_report_observed"
	};
}
/**
* Stop Protocol 2.0 decision. This function deliberately has no assistant-text
* parameter: completion wording, quotation, negation and translation cannot
* steer the protocol. A structured root persistence authorization may request
* one fallback correction; subsequent attempts safe-yield. An active, armed
* Goal remains exclusively owned by the host Goal Round Driver.
*/
function decideTurnBoundary(projection) {
	if (!projection.enabled) return {
		action: "stop",
		reason: "guard_disabled"
	};
	if (projection.integrity !== "valid") return {
		action: "stop",
		reason: "integrity_invalid_safe_yield"
	};
	if (hasCurrentCertificate(projection)) return {
		action: "stop",
		reason: "current_certificate"
	};
	const boundary = projection.boundaries.at(-1);
	if (boundary?.persistedResult === "accepted" && boundary.epoch === projection.epoch && boundary.contractRevision === projection.contractRevision) return {
		action: "stop",
		reason: "accepted_boundary_pending_effectuation"
	};
	if (projection.currentGoalPhase === "active" && projection.currentGoalActivation === "armed") {
		const fingerprint$1 = progressFingerprint(projection);
		const claims = projection.noProgressClaims.get(fingerprint$1) ?? /* @__PURE__ */ new Map();
		const hostTurn = decisionBoundaryKey(projection);
		if (hostTurn === void 0) return {
			action: "stop",
			reason: "no_progress_identity_unavailable"
		};
		const boundaryKey = String(hostTurn);
		const prior = [...claims].filter(([key]) => key !== boundaryKey).length;
		const claim = {
			fingerprint: fingerprint$1,
			boundaryKey,
			attempt: prior + 1
		};
		if (prior === 0) return {
			action: "stop",
			reason: "goal_round_driver_owns_continuation",
			noProgressClaim: claim
		};
		if (prior < NO_PROGRESS_TURNS_BEFORE_STOP - 1) return {
			action: "continue",
			reason: "no_progress_diagnosis_steer",
			noProgressClaim: claim
		};
		return {
			action: "stop",
			reason: "no_progress_bounded_disarm"
		};
	}
	if (projection.currentGoalRef) return {
		action: "stop",
		reason: projection.currentGoalPhase === "paused" ? "goal_paused_by_user_safe_yield" : "goal_not_continuable_safe_yield"
	};
	if ([...projection.items.values()].some((item) => item.status === "pending" && item.persistenceAuthorization)) {
		const key = `${projection.epoch}:${projection.contractRevision}`;
		const attempts = projection.persistenceCorrectionAttempts.get(key) ?? 0;
		if (attempts < 1) {
			projection.persistenceCorrectionAttempts.set(key, attempts + 1);
			return {
				action: "continue",
				reason: "protocol_correction_steer"
			};
		}
	}
	return {
		action: "stop",
		reason: "safe_yield_pending_preserved"
	};
}
function decideTurnStopping(projection, _assistantText, _turn, _maxAttempts) {
	return decideTurnBoundary(projection);
}
/**
* Whether the last trusted ROOT instruction asked to pause.
*
* The source filter is the contract, not a heuristic: a quoted log, a tool
* result, a plugin notice or a model message is not a `user/message` with
* `source.kind === 'user'`, so none of them can reach this function at all, and
* neither can the model's own summary of one. A negated pause ("不要暂停") is not
* a pause request, and the check is anchored to a clause head so a pause word
* mentioned inside a longer instruction is not a control request.
*/
function latestRootInstruction(events) {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event.type !== "user/message") continue;
		const data = event.data;
		if (data.source?.kind !== "user") continue;
		const text = (data.content ?? []).filter((part) => part?.type === "text").map((part) => part.text ?? "").join("\n");
		if (text.trim()) return {
			text,
			seq: event.seq ?? 0
		};
	}
}
/** Marks a root control request Guard has already carried to the host. */
const CONTROL_RECORD_PREFIX = "Context Guard control record: ";
const PAUSE_REQUEST = /(?:^|[。！？；;，,、\s])(?:请|麻烦)?\s*(?:先)?\s*(?:暂停|停一下|停一停|先停|暂时停止)(?:一下|下|吧)?\s*(?:[。！？；;，,、]|$)|\b(?:please\s+)?(?:pause|hold\s+on|stop\s+for\s+now)\b/i;
const NEGATED_PAUSE = /(?:不要|不用|别|无需|不必)\s*(?:先)?\s*(?:暂停|停)|\b(?:do\s+not|don't|never)\s+(?:pause|stop)\b/i;
function isRootPauseRequest(text) {
	if (NEGATED_PAUSE.test(text)) return false;
	return PAUSE_REQUEST.test(text);
}
function latestAssistantText(events) {
	for (let index = events.length - 1; index >= 0; index--) {
		const event = events[index];
		if (event.type !== "assistant/message") continue;
		const text = event.data.message?.content?.filter((block$1) => block$1.type === "text").map((block$1) => block$1.text ?? "").join("\n") ?? "";
		if (text.trim()) return text;
	}
	return "";
}

//#endregion
//#region src/domain/digest.ts
/**
* Digest v3 canonical manifest derivation for Context Guard certificates.
*
* This is the DSH-side implementation of the frozen cross-language digest
* contract documented in `docs/SEMANTIC_COMPATIBILITY.md`. The canonical
* fixture lives in codex-context-guard (`tests/fixtures/conformance/digest_v3`)
* and is byte-mirrored under `tests/fixtures/conformance/digest_v3` together
* with `UPSTREAM_PIN.json`; the vitest suite re-derives all 29 golden vectors
* and fails on any byte difference. Any change to the algorithm, separators,
* typed token language, allowlists, or serialization is a new digest version
* and must regenerate the vectors in both repositories.
*
* Fail-closed rules pinned here: lone surrogates are rejected before hashing,
* values are never Unicode-normalized, dynamic keys must match the snake_case
* grammar, collections reject duplicate members, canonical maps sort by
* semantic key bytes (never by encoded field bytes), and predicate digests are
* always recomputed from the actual parameter payload.
*/
var DigestError = class extends Error {};
const MAX_ENCODED_NAME_BYTES = 256;
const MAX_SEMANTIC_KEY_BYTES = 64;
const MAX_VALUE_BYTES = 4096;
const MAX_FIELDS_PER_RECORD = 128;
const MAX_PRED_PARAMS_BYTES = 4096;
const DYNAMIC_KEY_RE = /^[a-z0-9_]{1,64}$/;
const PACKAGE_NAME_RE = /^[@a-z0-9._/-]{1,128}$/;
const ENUM_TOKEN_RE = /^[a-z0-9][a-z0-9_-]*$/;
const HEX_RE = /^[0-9a-f]+$/;
const SURFACE_ENUM = [
	"artifact",
	"ui",
	"visual",
	"scope"
];
const OUTCOME_ENUM = [
	"success",
	"failure",
	"unknown",
	"durability-unknown"
];
const EVIDENCE_ROLE_ENUM = [
	"resolution",
	"effect",
	"state"
];
const PRED_PARAMS_KIND_ENUM = ["inline", "manifest"];
/** Frozen canonical key vocabulary; product manifests draw allowlists from it. */
const PRODUCT_KEY_VOCABULARY = [
	"repository",
	"remote",
	"refspec",
	"upstream_oid",
	"pre_head_oid",
	"post_head_oid",
	"tracking_ref_oid",
	"pull_mode",
	"branch",
	"change_set_digest",
	"local_oid",
	"remote_oid",
	"package_id",
	"version",
	"integrity_digest",
	"profile",
	"artifact_id",
	"scope",
	"pre_digest",
	"post_digest",
	"service_id",
	"pre_generation",
	"new_generation",
	"health",
	"registry",
	"executable",
	"expected_outcome",
	"min_matches"
];
function sha256Hex(payload) {
	return createHash("sha256").update(payload).digest("hex");
}
function isWellFormedString(value) {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 55296 || code > 57343) continue;
		if (code <= 56319 && i + 1 < value.length) {
			const next = value.charCodeAt(i + 1);
			if (next >= 56320 && next <= 57343) {
				i++;
				continue;
			}
		}
		return false;
	}
	return true;
}
function utf8(value) {
	if (!isWellFormedString(value)) throw new DigestError("string value contains unpaired surrogate code points");
	return Buffer.from(value, "utf8");
}
function expectHex(raw) {
	if (typeof raw !== "string" || raw.length === 0 || raw.length % 2 !== 0 || !HEX_RE.test(raw)) throw new DigestError(`digest token must be lowercase hex: ${String(raw)}`);
	return raw;
}
function expectEnumToken(raw) {
	if (typeof raw !== "string" || !ENUM_TOKEN_RE.test(raw)) throw new DigestError(`invalid enum token: ${String(raw)}`);
	return raw;
}
function expectInt(value, label) {
	if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new DigestError(`field ${label} must be an integer`);
	return value;
}
function expectString(value, label) {
	if (typeof value !== "string") throw new DigestError(`field ${label} must be a string`);
	return value;
}
/** Encode one typed value into its canonical token bytes. */
function typedToken(value) {
	if (typeof value === "boolean") return Buffer.from(value ? "b:1" : "b:0", "utf8");
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value)) throw new DigestError(`integer token must be a safe integer: ${String(value)}`);
		return Buffer.from(`i:${value}`, "utf8");
	}
	if (typeof value === "string") return Buffer.concat([Buffer.from("s:", "utf8"), utf8(value)]);
	if (typeof value === "object" && value !== null && "k" in value) {
		if (Object.keys(value).length !== 2 || !("v" in value)) throw new DigestError("typed token wrapper must carry exactly k and v");
		const typed = value;
		if (typed.k === "b") {
			if (typeof typed.v !== "boolean") throw new DigestError(`boolean token payload must be a boolean: ${String(typed.v)}`);
			return Buffer.from(typed.v ? "b:1" : "b:0", "utf8");
		}
		if (typed.k === "i") return Buffer.from(`i:${expectInt(typed.v, "typed.i")}`, "utf8");
		if (typed.k === "s") return Buffer.concat([Buffer.from("s:", "utf8"), utf8(expectString(typed.v, "typed.s"))]);
		if (typed.k === "e") return Buffer.from(`e:${expectEnumToken(typed.v)}`, "utf8");
		if (typed.k === "x") return Buffer.from(`x:${expectHex(typed.v)}`, "utf8");
	}
	throw new DigestError(`unsupported typed value: ${String(value)}`);
}
/**
* Encode one field: u32BE(nameLen) || name || presence || u32BE(valueLen) || value.
* The primitive performs no grammar validation on purpose (manifest builders
* enforce it); token=null encodes the absent null-domain form.
*/
function field(name, token) {
	const nameBytes = Buffer.from(name, "utf8");
	if (nameBytes.length === 0 || nameBytes.length > MAX_ENCODED_NAME_BYTES) throw new DigestError(`encoded field name must be 1..${MAX_ENCODED_NAME_BYTES} bytes: ${name}`);
	const header = Buffer.alloc(9 + nameBytes.length);
	header.writeUInt32BE(nameBytes.length, 0);
	nameBytes.copy(header, 4);
	if (token === null) {
		header.writeUInt8(0, 4 + nameBytes.length);
		header.writeUInt32BE(0, 5 + nameBytes.length);
		return header;
	}
	if (token.length > MAX_VALUE_BYTES) throw new DigestError(`field value exceeds ${MAX_VALUE_BYTES} bytes: ${name}`);
	header.writeUInt8(1, 4 + nameBytes.length);
	header.writeUInt32BE(token.length, 5 + nameBytes.length);
	return Buffer.concat([header, token]);
}
/** Presence is decided before any stringification; enc only runs when present. */
function optField(name, raw, enc) {
	if (raw === void 0 || raw === null) return field(name, null);
	return field(name, enc(raw));
}
function checkFieldCount(count) {
	if (count > MAX_FIELDS_PER_RECORD) throw new DigestError(`canonical record exceeds ${MAX_FIELDS_PER_RECORD} fields: ${count}`);
}
function byUtf8(a, b) {
	return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
/** Repeat same-name fields sorted by full typed value bytes; reject duplicates. */
function encodeSet(name, items) {
	if (new Set(items.map((item) => item.toString("hex"))).size !== items.length) throw new DigestError(`set ${name} contains duplicate members`);
	const sorted = [...items].sort(Buffer.compare);
	return Buffer.concat(sorted.map((token) => field(name, token)));
}
/** Sort by semantic key utf8 bytes (never by encoded bytes); duplicate keys fail closed. */
function encodeMapRows(entries, prefix = "") {
	const keys = entries.map(([key]) => key);
	if (new Set(keys).size !== keys.length) throw new DigestError(`duplicate semantic keys in map: ${keys.sort(byUtf8).join(",")}`);
	for (const key of keys) if (Buffer.byteLength(key, "utf8") > MAX_SEMANTIC_KEY_BYTES) throw new DigestError(`semantic key exceeds ${MAX_SEMANTIC_KEY_BYTES} bytes: ${key}`);
	const sorted = [...entries].sort((a, b) => byUtf8(a[0], b[0]));
	checkFieldCount(sorted.length);
	return Buffer.concat(sorted.map(([key, token]) => field(prefix + key, token)));
}
const PRODUCT_KEY_SET = new Set(PRODUCT_KEY_VOCABULARY);
function tupleEntries(tuple, label, allowlist = PRODUCT_KEY_SET) {
	if (tuple === void 0 || tuple === null) return [];
	if (typeof tuple !== "object") throw new DigestError(`${label} must be an object`);
	return Object.entries(tuple).map(([key, value]) => {
		if (!DYNAMIC_KEY_RE.test(key)) throw new DigestError(`${label} key must match snake_case grammar: ${key}`);
		if (!allowlist.has(key)) throw new DigestError(`${label} key is not in the frozen key vocabulary: ${key}`);
		return [key, typedToken(value)];
	});
}
const SESSION_KEYS = [
	"version",
	"id",
	"createdAt",
	"parentSession",
	"seedLength",
	"agentPreset",
	"origin",
	"delegationDepth"
];
const HOST_LOCK_KEYS = [
	"manifestVersion",
	"supportedGoalVersions",
	"capabilities",
	"packages"
];
const CAPABILITY_KEYS = ["name", "value"];
const PACKAGE_KEYS = [
	"name",
	"version",
	"integrity"
];
const FACT_KEYS = [
	"id",
	"outcome",
	"method",
	"operations",
	"executables",
	"subjects",
	"surfaces",
	"semanticAction",
	"evidenceRole",
	"resolvedTarget",
	"observedState",
	"parseStatus",
	"reasonCode",
	"adapterId",
	"adapterVersion"
];
const BINDING_COMMON_KEYS = [
	"item",
	"semanticAction",
	"requestedTarget",
	"resolvedTarget",
	"observedState",
	"predId",
	"predVersion",
	"predParamsKind",
	"resolutionEvidenceId",
	"effectEvidenceId",
	"stateEvidenceIds"
];
const BINDING_INLINE_KEYS = ["predParams", "predParamsAllowlist"];
const BINDING_MANIFEST_KEYS = [
	"predParamsRef",
	"predParamsManifest",
	"predParamsManifestAllowlist"
];
const CERTIFICATE_KEYS = [
	"stopProtocolVersion",
	"certificateVersion",
	"epoch",
	"sessionRefDigest",
	"hostLockDigest",
	"contractRevision",
	"contractSha256",
	"goalRef",
	"openDigest",
	"evidenceSha256",
	"bindingDigest"
];
const GOAL_REF_KEYS = ["id", "revision"];
/** Closed-manifest guard: unknown input fields are rejected before hashing. */
function requireExactKeys(record, allowed, label) {
	if (typeof record !== "object" || record === null || Array.isArray(record)) throw new DigestError(`${label} must be an object`);
	for (const key of Object.keys(record)) if (!allowed.includes(key)) throw new DigestError(`${label} has unknown field: ${key}`);
}
function sessionRefDigest(header) {
	requireExactKeys(header, SESSION_KEYS, "session header");
	const optionalRecord = header;
	for (const name of [
		"parentSession",
		"agentPreset",
		"origin"
	]) {
		const value = optionalRecord[name];
		if (value !== void 0 && value !== null && typeof value !== "string") throw new DigestError(`session field ${name} must be a string or absent`);
	}
	for (const name of ["seedLength", "delegationDepth"]) {
		const value = optionalRecord[name];
		if (value !== void 0 && value !== null && (typeof value !== "number" || !Number.isSafeInteger(value))) throw new DigestError(`session field ${name} must be an integer or absent`);
	}
	const parts = [Buffer.from("ccg.sessionRefDigest.v3\n", "utf8")];
	let count = 0;
	parts.push(field("formatVersion", typedToken(expectInt(header.version, "version"))));
	parts.push(field("id", typedToken(expectString(header.id, "id"))));
	parts.push(field("createdAt", typedToken(expectInt(header.createdAt, "createdAt"))));
	count += 3;
	parts.push(optField("parentSession", header.parentSession, (v) => typedToken(v)));
	parts.push(optField("seedLength", header.seedLength, (v) => typedToken(v)));
	parts.push(optField("agentPreset", header.agentPreset, (v) => typedToken(v)));
	parts.push(optField("origin", header.origin, (v) => typedToken(v)));
	parts.push(optField("delegationDepth", header.delegationDepth, (v) => typedToken(v)));
	count += 5;
	checkFieldCount(count);
	return sha256Hex(Buffer.concat(parts));
}
function hostLockDigest(manifest) {
	requireExactKeys(manifest, HOST_LOCK_KEYS, "host lock manifest");
	const parts = [Buffer.from("ccg.hostLockDigest.v3\n", "utf8")];
	let count = 0;
	parts.push(field("manifestVersion", typedToken(expectInt(manifest.manifestVersion, "manifestVersion"))));
	count += 1;
	const versions = manifest.supportedGoalVersions;
	if (!Array.isArray(versions) || versions.length === 0) throw new DigestError("supportedGoalVersions must be a non-empty list");
	if (versions.some((v) => typeof v !== "string")) throw new DigestError("supportedGoalVersions entries must be strings");
	parts.push(encodeSet("supportedGoalVersion", versions.map((v) => typedToken(v))));
	count += versions.length;
	const rawCapabilities = manifest.capabilities;
	if (rawCapabilities !== void 0 && !Array.isArray(rawCapabilities)) throw new DigestError("capabilities must be a list or absent");
	const rows = rawCapabilities ?? [];
	const seen = /* @__PURE__ */ new Set();
	const sortedRows = [...rows].sort((a, b) => {
		const byName = byUtf8(a.name, b.name);
		return byName !== 0 ? byName : Buffer.compare(typedToken(a.value), typedToken(b.value));
	});
	for (const row of sortedRows) {
		requireExactKeys(row, CAPABILITY_KEYS, "capability row");
		if (typeof row.name !== "string" || !DYNAMIC_KEY_RE.test(row.name)) throw new DigestError(`capability name must match snake_case grammar: ${String(row.name)}`);
		const token = typedToken(row.value);
		const marker = `${row.name}\u0000${token.toString("hex")}`;
		if (seen.has(marker)) throw new DigestError(`duplicate capability row: ${row.name}`);
		seen.add(marker);
		parts.push(optField(`cap:${row.name}`, token, (v) => v));
		count += 1;
	}
	const rawPackages = manifest.packages;
	if (rawPackages !== void 0 && !Array.isArray(rawPackages)) throw new DigestError("packages must be a list or absent");
	const packages = rawPackages ?? [];
	const names = packages.map((p) => expectString(p.name, "package.name"));
	if (new Set(names).size !== names.length) throw new DigestError("duplicate package rows");
	for (const pkg of [...packages].sort((a, b) => byUtf8(a.name, b.name))) {
		requireExactKeys(pkg, PACKAGE_KEYS, "package row");
		for (const label of ["version", "integrity"]) {
			const value = pkg[label];
			if (value !== void 0 && value !== null && typeof value !== "string") throw new DigestError(`package field ${label} must be a string or absent`);
		}
		if (!PACKAGE_NAME_RE.test(pkg.name)) throw new DigestError(`invalid package name: ${pkg.name}`);
		parts.push(optField(`pkg:${pkg.name}`, pkg.version, (v) => typedToken(v)));
		parts.push(optField(`integrity:${pkg.name}`, pkg.integrity, (v) => typedToken(v)));
		count += 2;
	}
	checkFieldCount(count);
	return sha256Hex(Buffer.concat(parts));
}
function evidenceFactBytes(fact, allowlist = PRODUCT_KEY_SET) {
	requireExactKeys(fact, FACT_KEYS, "evidence fact");
	if (!OUTCOME_ENUM.includes(fact.outcome)) throw new DigestError(`outcome must be a canonical enum member: ${fact.outcome}`);
	if (!EVIDENCE_ROLE_ENUM.includes(fact.evidenceRole)) throw new DigestError(`evidenceRole must be a canonical enum member: ${fact.evidenceRole}`);
	if (typeof fact.parseStatus !== "string" || !DYNAMIC_KEY_RE.test(fact.parseStatus)) throw new DigestError(`invalid parseStatus: ${fact.parseStatus}`);
	if (fact.parseStatus !== "supported" && (fact.reasonCode === void 0 || fact.reasonCode === null)) throw new DigestError("reasonCode must be present when parseStatus is not supported");
	if (!Array.isArray(fact.surfaces) || fact.surfaces.length !== 1) throw new DigestError("surfaces must carry exactly one canonical surface");
	if (!SURFACE_ENUM.includes(fact.surfaces[0])) throw new DigestError(`surface must be a canonical enum member: ${fact.surfaces[0]}`);
	const resEntries = tupleEntries(fact.resolvedTarget, "resolvedTarget", allowlist);
	const obsEntries = tupleEntries(fact.observedState, "observedState", allowlist);
	if (fact.evidenceRole === "resolution" || fact.evidenceRole === "effect") {
		if (resEntries.length === 0) throw new DigestError(`${fact.evidenceRole} fact requires a resolvedTarget`);
		if (obsEntries.length > 0) throw new DigestError(`${fact.evidenceRole} fact must not carry observedState`);
	} else if (resEntries.length === 0 || obsEntries.length === 0) throw new DigestError("state fact requires both resolvedTarget and observedState");
	const parts = [Buffer.from("ccg.evidenceFact.v3\n", "utf8")];
	let count = 0;
	parts.push(field("id", typedToken(expectString(fact.id, "id"))));
	parts.push(field("outcome", Buffer.from(`e:${fact.outcome}`, "utf8")));
	parts.push(field("method", typedToken(expectString(fact.method, "method"))));
	count += 3;
	for (const [listName, fieldName] of [
		["operations", "operation"],
		["executables", "executable"],
		["subjects", "subject"]
	]) {
		const rawValues = fact[listName];
		if (rawValues !== void 0 && !Array.isArray(rawValues)) throw new DigestError(`${listName} must be a list or absent`);
		const values = rawValues ?? [];
		if (values.some((v) => typeof v !== "string")) throw new DigestError(`${listName} entries must be strings`);
		parts.push(encodeSet(fieldName, values.map((v) => typedToken(v))));
		count += values.length;
	}
	parts.push(field("surface", typedToken(fact.surfaces[0])));
	parts.push(field("semanticAction", typedToken(expectString(fact.semanticAction, "semanticAction"))));
	parts.push(field("evidenceRole", Buffer.from(`e:${fact.evidenceRole}`, "utf8")));
	parts.push(encodeMapRows(resEntries, "res:"));
	parts.push(encodeMapRows(obsEntries, "obs:"));
	parts.push(field("parseStatus", Buffer.from(`e:${fact.parseStatus}`, "utf8")));
	count += 4 + resEntries.length + obsEntries.length;
	for (const name of [
		"reasonCode",
		"adapterId",
		"adapterVersion"
	]) {
		const value = fact[name];
		if (value !== void 0 && value !== null && typeof value !== "string") throw new DigestError(`evidence fact field ${name} must be a string or absent`);
	}
	parts.push(optField("reasonCode", fact.reasonCode, (v) => typedToken(v)));
	parts.push(optField("adapterId", fact.adapterId, (v) => typedToken(v)));
	parts.push(optField("adapterVersion", fact.adapterVersion, (v) => typedToken(v)));
	count += 3;
	checkFieldCount(count);
	return Buffer.concat(parts);
}
function evidenceFactDigest(fact, allowlist = PRODUCT_KEY_SET) {
	return sha256Hex(evidenceFactBytes(fact, allowlist));
}
function evidenceSha256Digest(facts, allowlist = PRODUCT_KEY_SET) {
	const parts = [Buffer.from("ccg.evidenceSha256.v3\n", "utf8")];
	const seen = /* @__PURE__ */ new Set();
	const sorted = [...facts].sort((a, b) => byUtf8(a.id, b.id));
	for (const fact of sorted) {
		if (seen.has(fact.id)) throw new DigestError(`duplicate evidence id: ${fact.id}`);
		seen.add(fact.id);
		parts.push(field("id", typedToken(fact.id)));
		parts.push(field("fact", typedToken({
			k: "x",
			v: evidenceFactDigest(fact, allowlist)
		})));
	}
	checkFieldCount(facts.length * 2);
	return sha256Hex(Buffer.concat(parts));
}
function resolveAllowlist(spec) {
	if (spec === void 0 || spec === null || spec === "product") return new Set(PRODUCT_KEY_VOCABULARY);
	if (Array.isArray(spec)) {
		if (spec.some((item) => typeof item !== "string")) throw new DigestError("key allowlist entries must be strings");
		return new Set(spec);
	}
	throw new DigestError(`unknown key allowlist: ${String(spec)}`);
}
function predParamsBytes(params, allowlist) {
	if (typeof params !== "object" || params === null || Array.isArray(params)) throw new DigestError("predParams must be an object");
	checkFieldCount(Object.keys(params).length);
	for (const name of Object.keys(params)) {
		if (!DYNAMIC_KEY_RE.test(name)) throw new DigestError(`predParams name must match snake_case grammar: ${name}`);
		if (!allowlist.has(name)) throw new DigestError(`predParams name is not in the frozen allowlist: ${name}`);
	}
	const parts = [Buffer.from("ccg.predParams.v3\n", "utf8")];
	for (const name of Object.keys(params).sort(byUtf8)) parts.push(field(name, typedToken(params[name])));
	const payload = Buffer.concat(parts);
	if (payload.length > MAX_PRED_PARAMS_BYTES) throw new DigestError(`predParams canonicalBytes exceed ${MAX_PRED_PARAMS_BYTES} bytes`);
	return payload;
}
function predParamsDigest(params, allowlist) {
	return sha256Hex(predParamsBytes(params, allowlist));
}
function bindingRecordBytes(binding, allowlist) {
	if (!PRED_PARAMS_KIND_ENUM.includes(binding.predParamsKind)) throw new DigestError(`predParamsKind must be a canonical enum member: ${binding.predParamsKind}`);
	let params;
	let predAllowlist;
	if (binding.predParamsKind === "inline") {
		if (typeof binding.predParams !== "object" || binding.predParams === null || Array.isArray(binding.predParams) || "ref" in binding.predParams) throw new DigestError("inline binding requires the materialized predParams payload");
		params = binding.predParams;
		predAllowlist = resolveAllowlist(binding.predParamsAllowlist);
	} else {
		if (typeof binding.predParamsManifest !== "object" || binding.predParamsManifest === null || Array.isArray(binding.predParamsManifest)) throw new DigestError("manifest binding requires the manifest entry payload");
		params = binding.predParamsManifest;
		predAllowlist = resolveAllowlist(binding.predParamsManifestAllowlist);
	}
	const branchKeys = binding.predParamsKind === "inline" ? BINDING_INLINE_KEYS : BINDING_MANIFEST_KEYS;
	requireExactKeys(binding, [...BINDING_COMMON_KEYS, ...branchKeys], "binding record");
	const payload = predParamsBytes(params, predAllowlist);
	const recomputed = sha256Hex(payload);
	const parts = [Buffer.from("ccg.binding.v3\n", "utf8")];
	let count = 0;
	parts.push(field("item", typedToken(expectString(binding.item, "item"))));
	parts.push(field("semanticAction", typedToken(expectString(binding.semanticAction, "semanticAction"))));
	count += 2;
	parts.push(encodeMapRows(tupleEntries(binding.requestedTarget, "requestedTarget", allowlist), "req:"));
	parts.push(encodeMapRows(tupleEntries(binding.resolvedTarget, "resolvedTarget", allowlist), "res:"));
	parts.push(encodeMapRows(tupleEntries(binding.observedState, "observedState", allowlist), "obs:"));
	count += Object.keys(binding.requestedTarget ?? {}).length;
	count += Object.keys(binding.resolvedTarget ?? {}).length;
	count += Object.keys(binding.observedState ?? {}).length;
	parts.push(field("predId", typedToken(expectString(binding.predId, "predId"))));
	parts.push(field("predVersion", typedToken(expectInt(binding.predVersion, "predVersion"))));
	parts.push(field("predParamsKind", Buffer.from(`e:${binding.predParamsKind}`, "utf8")));
	count += 3;
	if (binding.predParamsKind === "inline") parts.push(field("predParams", payload));
	else {
		const ref = binding.predParamsRef;
		if (typeof ref !== "string" || ref.length === 0) throw new DigestError("manifest binding requires predParamsRef");
		parts.push(field("predParamsRef", typedToken(ref)));
	}
	parts.push(field("predParamsDigest", typedToken({
		k: "x",
		v: recomputed
	})));
	count += 2;
	const resolutionId = binding.resolutionEvidenceId;
	if (resolutionId !== void 0 && resolutionId !== null && typeof resolutionId !== "string") throw new DigestError("resolutionEvidenceId must be a string or absent");
	parts.push(optField("resolutionEvidenceId", resolutionId, (v) => typedToken(v)));
	parts.push(field("effectEvidenceId", typedToken(expectString(binding.effectEvidenceId, "effectEvidenceId"))));
	count += 2;
	const rawStateIds = binding.stateEvidenceIds;
	if (rawStateIds !== void 0 && !Array.isArray(rawStateIds)) throw new DigestError("stateEvidenceIds must be a list or absent");
	const stateIds = rawStateIds ?? [];
	if (stateIds.some((v) => typeof v !== "string")) throw new DigestError("stateEvidenceIds entries must be strings");
	parts.push(encodeSet("stateEvidenceId", stateIds.map((v) => typedToken(v))));
	count += stateIds.length;
	checkFieldCount(count);
	return Buffer.concat(parts);
}
function bindingRecordDigest(binding, allowlist) {
	return sha256Hex(bindingRecordBytes(binding, allowlist));
}
function bindingDigest(records, allowlist) {
	const parts = [Buffer.from("ccg.bindingDigest.v3\n", "utf8")];
	const seen = /* @__PURE__ */ new Set();
	const rows = records.map((record) => {
		const tupleKey = JSON.stringify([record.item, record.semanticAction]);
		if (seen.has(tupleKey)) throw new DigestError(`duplicate (item, semanticAction) binding: ${record.item}/${record.semanticAction}`);
		seen.add(tupleKey);
		return {
			item: record.item,
			semanticAction: record.semanticAction,
			digest: bindingRecordDigest(record, allowlist)
		};
	});
	rows.sort((a, b) => {
		const byItem = byUtf8(a.item, b.item);
		return byItem !== 0 ? byItem : byUtf8(a.semanticAction, b.semanticAction);
	});
	for (const row of rows) parts.push(field("binding", typedToken({
		k: "x",
		v: row.digest
	})));
	checkFieldCount(records.length);
	return sha256Hex(Buffer.concat(parts));
}
function certificationDigest(certificate) {
	requireExactKeys(certificate, CERTIFICATE_KEYS, "certificate");
	const parts = [Buffer.from("ccg.certificationDigest.v3\n", "utf8")];
	let count = 0;
	parts.push(field("stopProtocolVersion", typedToken(expectString(certificate.stopProtocolVersion, "stopProtocolVersion"))));
	parts.push(field("certificateVersion", typedToken(expectString(certificate.certificateVersion, "certificateVersion"))));
	parts.push(field("epoch", typedToken(expectInt(certificate.epoch, "epoch"))));
	parts.push(field("sessionRefDigest", typedToken({
		k: "x",
		v: expectHex(certificate.sessionRefDigest)
	})));
	parts.push(field("hostLockDigest", typedToken({
		k: "x",
		v: expectHex(certificate.hostLockDigest)
	})));
	parts.push(field("contractRevision", typedToken(expectInt(certificate.contractRevision, "contractRevision"))));
	parts.push(field("contractSha256", typedToken({
		k: "x",
		v: expectHex(certificate.contractSha256)
	})));
	count += 7;
	const goalRef = certificate.goalRef;
	if (goalRef !== void 0 && goalRef !== null) {
		requireExactKeys(goalRef, GOAL_REF_KEYS, "goalRef");
		parts.push(optField("goalRefId", expectString(goalRef.id, "goalRef.id"), (v) => typedToken(v)));
		parts.push(optField("goalRefRevision", expectInt(goalRef.revision, "goalRef.revision"), (v) => typedToken(v)));
	} else {
		parts.push(optField("goalRefId", null, () => Buffer.alloc(0)));
		parts.push(optField("goalRefRevision", null, () => Buffer.alloc(0)));
	}
	count += 2;
	parts.push(field("openDigest", typedToken({
		k: "x",
		v: expectHex(certificate.openDigest)
	})));
	parts.push(field("evidenceSha256", typedToken({
		k: "x",
		v: expectHex(certificate.evidenceSha256)
	})));
	parts.push(field("bindingDigest", typedToken({
		k: "x",
		v: expectHex(certificate.bindingDigest)
	})));
	count += 3;
	checkFieldCount(count);
	return sha256Hex(Buffer.concat(parts));
}
const CERTIFICATE_V2_KEYS = [
	"stopProtocolVersion",
	"certificateVersion",
	"epoch",
	"sessionRefDigest",
	"hostLockDigest",
	"contractRevision",
	"contractSha256",
	"unitId",
	"unitClosureDigest",
	"evidenceSha256",
	"bindingDigest",
	"goalRef"
];
/**
* 0.6.0 v2 certificate field table over the new `ccg.certificationDigest.v4`
* domain (P0 §1): the certified scope is a work unit's closure instead of the
* whole session. digest_v3 domains and their golden vectors stay frozen; this
* function never re-reads a v1 record.
*/
function certificationDigestV2(certificate) {
	requireExactKeys(certificate, CERTIFICATE_V2_KEYS, "certificateV2");
	const parts = [Buffer.from("ccg.certificationDigest.v4\n", "utf8")];
	let count = 0;
	parts.push(field("stopProtocolVersion", typedToken(expectString(certificate.stopProtocolVersion, "stopProtocolVersion"))));
	parts.push(field("certificateVersion", typedToken(expectString(certificate.certificateVersion, "certificateVersion"))));
	parts.push(field("epoch", typedToken(expectInt(certificate.epoch, "epoch"))));
	parts.push(field("sessionRefDigest", typedToken({
		k: "x",
		v: expectHex(certificate.sessionRefDigest)
	})));
	parts.push(field("hostLockDigest", typedToken({
		k: "x",
		v: expectHex(certificate.hostLockDigest)
	})));
	parts.push(field("contractRevision", typedToken(expectInt(certificate.contractRevision, "contractRevision"))));
	parts.push(field("contractSha256", typedToken({
		k: "x",
		v: expectHex(certificate.contractSha256)
	})));
	count += 7;
	parts.push(field("unitId", typedToken(expectString(certificate.unitId, "unitId"))));
	parts.push(field("unitClosureDigest", typedToken({
		k: "x",
		v: expectHex(certificate.unitClosureDigest)
	})));
	parts.push(field("evidenceSha256", typedToken({
		k: "x",
		v: expectHex(certificate.evidenceSha256)
	})));
	parts.push(field("bindingDigest", typedToken({
		k: "x",
		v: expectHex(certificate.bindingDigest)
	})));
	count += 4;
	const goalRef = certificate.goalRef;
	if (goalRef !== void 0 && goalRef !== null) {
		requireExactKeys(goalRef, GOAL_REF_KEYS, "goalRef");
		parts.push(optField("goalRefId", expectString(goalRef.id, "goalRef.id"), (v) => typedToken(v)));
		parts.push(optField("goalRefRevision", expectInt(goalRef.revision, "goalRef.revision"), (v) => typedToken(v)));
	} else {
		parts.push(optField("goalRefId", null, () => Buffer.alloc(0)));
		parts.push(optField("goalRefRevision", null, () => Buffer.alloc(0)));
	}
	count += 2;
	checkFieldCount(count);
	return sha256Hex(Buffer.concat(parts));
}
/**
* Verifier-side role matrix and binding closure. Digest derivation stays
* pure; this mirrors the checks a proof verifier must run before accepting a
* binding: res: rows byte-identical across all three roles, binding.obs equal
* to the union of pairwise-disjoint state fact obs key sets, evidence ids
* pairwise distinct, each id naming the fact that plays its role, and every
* id present in the evidence set when one is supplied.
*/
function bindingStateClosure(input) {
	const { binding, resolution, effect, states } = input;
	for (const [expectedRole, fact] of [["resolution", resolution], ["effect", effect]]) {
		if (fact.evidenceRole !== expectedRole) throw new DigestError(`fact role mismatch: expected ${expectedRole}`);
		if (!fact.resolvedTarget || Object.keys(fact.resolvedTarget).length === 0) throw new DigestError(`${expectedRole} fact requires resolvedTarget`);
		if (fact.observedState && Object.keys(fact.observedState).length > 0) throw new DigestError(`${expectedRole} fact must not carry observedState`);
	}
	for (const stateFact of states) {
		if (stateFact.evidenceRole !== "state") throw new DigestError("state list must only carry state facts");
		if (!stateFact.resolvedTarget || Object.keys(stateFact.resolvedTarget).length === 0) throw new DigestError("state fact requires resolvedTarget");
		if (!stateFact.observedState || Object.keys(stateFact.observedState).length === 0) throw new DigestError("state fact requires observedState");
	}
	const bindingRes = encodeMapRows(tupleEntries(binding.resolvedTarget, "resolvedTarget", PRODUCT_KEY_SET), "res:");
	for (const fact of [
		resolution,
		effect,
		...states
	]) {
		const factRes = encodeMapRows(tupleEntries(fact.resolvedTarget, "resolvedTarget", PRODUCT_KEY_SET), "res:");
		if (Buffer.compare(factRes, bindingRes) !== 0) throw new DigestError("binding.res must equal every fact res rows byte for byte");
	}
	const merged = /* @__PURE__ */ new Map();
	for (const stateFact of states) for (const [key, token] of tupleEntries(stateFact.observedState, "observedState")) {
		if (merged.has(key)) throw new DigestError("observedState key sets must be pairwise disjoint across state facts");
		merged.set(key, token.toString("hex"));
	}
	const bindingObs = tupleEntries(binding.observedState, "observedState");
	if (bindingObs.length !== merged.size || bindingObs.some(([key, token]) => merged.get(key) !== token.toString("hex"))) throw new DigestError("binding.obs must equal the canonical union of state facts");
	const ids = [
		binding.resolutionEvidenceId,
		binding.effectEvidenceId,
		...binding.stateEvidenceIds ?? []
	].filter((id) => id !== void 0);
	if (new Set(ids).size !== ids.length) throw new DigestError("resolution/effect/state evidence ids must be pairwise distinct");
	if (binding.resolutionEvidenceId !== resolution.id) throw new DigestError("resolutionEvidenceId must name the resolution fact");
	if (binding.effectEvidenceId !== effect.id) throw new DigestError("effectEvidenceId must name the effect fact");
	const providedStateIds = states.map((fact) => fact.id);
	if (new Set(providedStateIds).size !== providedStateIds.length) throw new DigestError("duplicate state fact id");
	const stateIdSet = new Set(binding.stateEvidenceIds ?? []);
	if (stateIdSet.size !== states.length || states.some((fact) => !stateIdSet.has(fact.id))) throw new DigestError("stateEvidenceIds must name exactly the referenced state facts");
	if (input.evidenceFacts !== void 0) {
		const knownFacts = /* @__PURE__ */ new Map();
		for (const setFact of input.evidenceFacts) {
			if (knownFacts.has(setFact.id)) throw new DigestError(`duplicate evidence id in evidence set: ${setFact.id}`);
			knownFacts.set(setFact.id, setFact);
		}
		const bindContent = (fact, roleId) => {
			if (roleId === void 0) throw new DigestError(`evidence ids missing from evidenceSha256 set: ${String(fact.id)}`);
			const hashedFact = knownFacts.get(roleId);
			if (hashedFact === void 0) throw new DigestError(`evidence ids missing from evidenceSha256 set: ${roleId}`);
			if (evidenceFactDigest(fact) !== evidenceFactDigest(hashedFact)) throw new DigestError(`evidence fact ${roleId} content differs from the fact hashed into evidenceSha256`);
		};
		bindContent(resolution, binding.resolutionEvidenceId);
		bindContent(effect, binding.effectEvidenceId);
		const providedStates = /* @__PURE__ */ new Map();
		for (const stateFact of states) {
			if (providedStates.has(stateFact.id)) throw new DigestError(`duplicate state fact id: ${stateFact.id}`);
			providedStates.set(stateFact.id, stateFact);
		}
		for (const [stateId, providedFact] of providedStates) bindContent(providedFact, stateId);
	}
}

//#endregion
//#region src/domain/matching.ts
const STATE_VERIFICATION_CAPABILITIES = new Set([
	"filesystem-read",
	"web-fetch",
	"deterministic-check"
]);
/** Capabilities that may close an explicit `verify` contract. */
const VERIFY_CAPABILITIES = new Set([
	"filesystem-read",
	"verify",
	"web-fetch",
	"deterministic-check"
]);
/**
* Whether this evidence closes the artifact/scope facet of the item: a success
* outcome, a verifying capability, and (when the contract names them) a match
* on the canonical subject and the surface. Both sides of the subject
* comparison run through the shared {@link canonicalizePath}, so Windows
* drive-letter case, separator kind, `.`/`..`, and duplicate separators are
* treated as equal while POSIX stays case-sensitive.
*/
function stateVerificationFacetCovered(item, evidence) {
	if (evidence.outcome !== "success") return false;
	if (!evidence.capabilities.some((capability) => STATE_VERIFICATION_CAPABILITIES.has(capability))) return false;
	const { subject, surface, operation } = item.verification;
	if (subject && !evidence.subjects.some((subjectValue) => canonicalizePath(subjectValue) === canonicalizePath(subject))) return false;
	if (surface && !evidence.surfaces.includes(surface)) return false;
	if (operation === "create" || operation === "write" || operation === "modify") {
		if (!(evidence.operations ?? []).some((entry) => (entry.op === "read" || entry.op === "verify") && (!subject || entry.path !== void 0 && canonicalizePath(entry.path) === canonicalizePath(subject))) && !(evidence.capabilities.includes("deterministic-check") && (!subject || evidence.subjects.some((value) => canonicalizePath(value) === canonicalizePath(subject))))) return false;
	}
	return true;
}
function artifactFacetCovered(item, evidence) {
	return stateVerificationFacetCovered(item, evidence);
}
function methodIdentityMatches(item, evidence) {
	const method = item.verification.method;
	if (!method || evidence.outcome !== "success") return false;
	const toolMethod = DSH_TOOL_METHODS.has(method);
	const toolMatch = toolMethod ? method === "bash" || method === "shell" ? evidence.toolName === "bash" || evidence.toolName === "shell" : evidence.toolName === method : false;
	const executableMatch = !toolMethod && (evidence.executables?.some((value) => value.toLowerCase() === method) ?? false);
	return toolMatch || executableMatch;
}
function isVerifyingCapability(evidence) {
	return evidence.capabilities.some((capability) => STATE_VERIFICATION_CAPABILITIES.has(capability));
}
/**
* Combined verification facet: success, capability, subject, surface and any
* required method identity must all come from this one evidence.
*/
function verifyFacetCovered(item, evidence) {
	if (evidence.outcome !== "success") return false;
	if (!evidence.capabilities.some((capability) => VERIFY_CAPABILITIES.has(capability))) return false;
	const { subject, surface, method } = item.verification;
	if (subject && !evidence.subjects.some((subjectValue) => canonicalizePath(subjectValue) === canonicalizePath(subject))) return false;
	if (surface && !evidence.surfaces.includes(surface)) return false;
	return !method || methodIdentityMatches(item, evidence);
}
/**
* DSH tool ids that can appear as `evidence.toolName`. An explicit method that
* names one of these is a tool constraint; anything else (pnpm, git, node, …) is
* a shell executable that runs inside a command tool.
*/
const DSH_TOOL_METHODS = new Set([
	"bash",
	"shell",
	"pwsh",
	"read",
	"write",
	"edit",
	"read_file",
	"write_file",
	"edit_file",
	"web_search",
	"web_fetch",
	"web_fetch_url"
]);
/**
* Operation compatibility: a contract operation is closed by the evidence
* operations that produce the same effect (create/write are the same artifact
* production family; verify is closed by a read, run, or verify check).
*/
const OPERATION_COMPATIBLE = {
	create: ["create", "write"],
	write: ["create", "write"],
	modify: [
		"modify",
		"write",
		"create"
	],
	read: ["read"],
	run: ["run"],
	verify: [
		"read",
		"verify",
		"run"
	]
};
/**
* Whether this evidence satisfies an explicitly required tool/method facet:
* a success outcome, the right identity (DSH tool name for tool constraints,
* the invoked executable for executable constraints), and — when the contract
* names a subject and/or operation — an operation performed on the same
* canonical subject. Mentioning a file in a command (`echo guard-demo.txt`) is
* not an operation and cannot satisfy a create requirement.
*/
/** The effect facet proves what the evidence actually did, not merely who ran it. */
function effectFacetCovered(item, evidence) {
	if (evidence.outcome !== "success") return false;
	const { subject, surface, operation, method } = item.verification;
	if (!operation) return false;
	if (method && !methodIdentityMatches(item, evidence)) return false;
	const compatible = OPERATION_COMPATIBLE[operation] ?? [];
	const effects = evidence.operations ?? [];
	if (surface === "artifact" && subject) {
		const target = canonicalizePath(subject);
		return effects.some((entry) => compatible.includes(entry.op) && entry.path !== void 0 && canonicalizePath(entry.path) === target);
	}
	if (surface === "scope") return effects.some((entry) => compatible.includes(entry.op));
	return false;
}
/** The method facet proves only the required tool or executable identity. */
function methodFacetCovered(item, evidence) {
	if (item.verification.operation === void 0 && item.verification.method) return false;
	return methodIdentityMatches(item, evidence);
}
/** Whether this evidence performed the run operation on the contract subject. */
function runFacetCovered(item, evidence) {
	if (evidence.outcome !== "success") return false;
	const operations = evidence.operations ?? [];
	const { subject } = item.verification;
	if (subject) {
		const target = canonicalizePath(subject);
		return operations.some((entry) => entry.op === "run" && entry.path !== void 0 && canonicalizePath(entry.path) === target);
	}
	return operations.some((entry) => entry.op === "run");
}
function evidenceCoverage(item, evidence) {
	return {
		artifact: artifactFacetCovered(item, evidence),
		effect: effectFacetCovered(item, evidence),
		method: methodFacetCovered(item, evidence),
		verify: verifyFacetCovered(item, evidence),
		run: runFacetCovered(item, evidence)
	};
}
/**
* Whether a single evidence can close an enforced item on its own. This is the
* conservative per-evidence check; the certifier additionally verifies that the
* whole binding satisfies every required facet.
*/
function evidenceMatchesItem(item, evidence) {
	if (evidence.outcome !== "success") return false;
	if (!item.verification.enforced) return true;
	const coverage = evidenceCoverage(item, evidence);
	return coverage.artifact || coverage.effect || coverage.method || coverage.verify || coverage.run;
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
function bindingSatisfies(projection, item, evidenceIds) {
	if (!item.verification.enforced) return evidenceIds.every((id) => {
		const value = projection.evidence.get(id);
		return !!value && value.epoch === projection.epoch && value.outcome === "success";
	});
	const { method, operation } = item.verification;
	if (method && operation === void 0) return false;
	let artifact = false;
	let effect = false;
	let verify = false;
	let run = false;
	const stateEvidenceIds = /* @__PURE__ */ new Set();
	const effectEvidenceIds = /* @__PURE__ */ new Set();
	for (const id of evidenceIds) {
		const value = projection.evidence.get(id);
		if (!value || value.epoch !== projection.epoch) return false;
		const coverage = evidenceCoverage(item, value);
		if (!coverage.artifact && !coverage.effect && !coverage.method && !coverage.verify && !coverage.run) return false;
		artifact = artifact || coverage.artifact;
		effect = effect || coverage.effect;
		verify = verify || coverage.verify;
		run = run || coverage.run;
		if (coverage.artifact) stateEvidenceIds.add(id);
		if (coverage.effect) effectEvidenceIds.add(id);
	}
	switch (operation) {
		case "run": return effect;
		case "read": return effect;
		case "create":
		case "write":
		case "modify": {
			const independentState = [...stateEvidenceIds].some((id) => !effectEvidenceIds.has(id));
			const independentEffect = [...effectEvidenceIds].some((id) => !stateEvidenceIds.has(id));
			return effect && independentEffect && independentState;
		}
		case "verify": return verify;
		default: return artifact;
	}
}

//#endregion
//#region src/domain/recovery.ts
const DEFAULT_RECOVERY_CHAR_BUDGET = 4e3;
const MIN_RECOVERY_CHAR_BUDGET = 512;
const COMPLETION_RULE = "Supported actions certify through matching durable evidence (checkpoint). Investigations and explanations outside the supported set can be delivered honestly but stay uncertified. A qualified safe end preserves pending work; it is not completion.";
/**
* 0.6.2 D062-03: the standing condition a removal or cleanup outcome must keep.
* The guard cannot observe another process's cwd or handles, so it states the
* condition instead of inferring "no dependants" from a clean tree, an empty
* `git worktree list`, or a directory that merely looks empty. This is one
* shared wording, not an incident phrase list, and it never claims the plugin
* can block a dangerous removal on its own.
*/
const CLEANUP_CONDITION_RULE = "A removal counts only for the objects PROVEN dependency-free; report metadata, content and directory removal separately from dependency status (" + DEPENDENCY_FREE_ONLY_CONDITION.join(", ") + "), keep unknown-dependency objects and failures visible, and never repeat a blocked delete, kill a holder, or restart to force it.";
/**
* The same condition at a medium budget (0.6.2 review): shorter than the full
* rule, and still explicit that an unknown dependant forbids the claim.
*/
const CLEANUP_CONDITION_RULE_SHORT = "Removal counts only for objects PROVEN dependency-free; unknown dependants stay visible and are never deleted.";
/**
* The same condition at emergency budget (0.6.2 review). A packet with fewer
* than 1000 characters cannot carry the longer sentences AND its own rules, so
* the condition is compressed — but it is NEVER omitted: the one thing a compact
* packet must not lose is that an unknown dependant forbids a removal claim.
*/
const CLEANUP_CONDITION_RULE_COMPACT = "Removal requires proven no-dependants.";
/**
* Pick the longest form of the condition the packet's budget can actually
* afford. The caller reserves this line's length before any optional row, so
* the condition is never the text that gets clipped.
*/
function cleanupConditionFor(budget) {
	if (budget >= DEFAULT_RECOVERY_CHAR_BUDGET) return CLEANUP_CONDITION_RULE;
	if (budget >= 1e3) return CLEANUP_CONDITION_RULE_SHORT;
	return CLEANUP_CONDITION_RULE_COMPACT;
}
/**
* Whether this gap needs the cleanup condition spelled out. The condition
* belongs to every uncertifiable lane that could describe removal-like work —
* which the guard cannot identify from text — so it rides the CAPABILITY
* limitation itself, never a vocabulary of destructive verbs.
*/
function carriesCleanupCondition(gap) {
	return gap === "missing_adapter" || gap === "legacy_migration_required" || gap === "historical_preevidence_missing" || gap === "operation_unattributable" || gap === "interpretation_unknown";
}
/** One reachable-remedy phrase per remedy kind, shared by every lane. */
function remedyText(remedy, fallback) {
	switch (remedy) {
		case "collect_evidence": return "Collect matching evidence; checkpoint";
		case "readback_only": return "Read back observed state; do not re-execute";
		case "none": return "Recorded as unresolved; only a fresh explicit instruction resolves it";
		case "record_interpretation": return "Read the attachment; record context_guard_interpret; then answer";
		case "supply_target": return "Supply the exact target; then collect evidence and checkpoint";
		case "await_root_input": return "Wait for the trusted root input; keep the obligation pending";
		case "deliver_answer": return "Deliver the actual answer; a completed turn closes it";
		case "report_uncertified": return "Deliver honestly; stays uncertified unless a fresh instruction names a supported action";
		case "restore_host": return "Restore audited host/adapter capability";
		case "fresh_root_instruction": return "Report the actual outcome as uncertified; only a fresh explicit instruction reaches its migration lane";
		case "report_uncertified_capability_gap": return "Report the observable result as uncertified; this build has no adapter for the action";
	}
	return fallback;
}
/**
* An actionable one-line hint for how an open item's verification contract can
* be closed. It never weakens the contract; it only names the missing facet so
* the agent can produce the right evidence shape instead of reverse-engineering
* the guard. When `evidenceIds` is given, the hint accounts for what those
* evidence already cover.
*/
function closingHint(projection, item, evidenceIds) {
	if (item.semanticAction === "generic_run") return itemDiagnosis(projection, item).next_step;
	const verification = item.verification;
	const parts = [];
	if (evidenceIds?.length) {
		if (!evidenceIds.map((id) => projection.evidence.get(id)).filter((value) => value !== void 0).map((value) => evidenceCoverage(item, value)).some((facet) => facet.artifact || facet.effect || facet.method || facet.verify || facet.run)) parts.push("cited evidence matches no facet");
	}
	if (verification.method) parts.push(`method '${verification.method}'`);
	if (verification.subject && verification.surface === "artifact") parts.push(`subject '${verification.subject}'`);
	if (verification.subject && verification.surface === "scope") parts.push("in the scope directory");
	const operation = verification.operation;
	if (item.semanticAction && isStatefulAction(item.semanticAction)) parts.push(`needs ${item.semanticAction} resolution + effect + independent state readback with the same resolved target`);
	else if (operation === "run") parts.push("needs a scope run effect: a whitelisted executable (git/pnpm/python/dsh/...) without pipes, `;` or `&&`, e.g. `python -m unittest`");
	else if (operation === "create" || operation === "write" || operation === "modify") parts.push("needs an effect evidence AND an independent same-subject state verification (read tool or a deterministic check)");
	else if (operation === "verify") parts.push("needs a read or deterministic-check evidence on the contract subject");
	else if (operation === "read") parts.push("needs a read evidence on the contract subject");
	else parts.push("needs a state-verification evidence (read tool, or a deterministic check run in scope) matching the subject");
	return parts.join("; ");
}
function openItems(projection) {
	return [...projection.items.values()].filter((item) => item.status === "pending").sort((a, b) => a.revision - b.revision || (a.id < b.id ? -1 : 1));
}
/**
* Content identity of a rendered recovery packet, bound to the contract
* revision and epoch it was rendered from. The runtime compares digests before
* re-injecting, so a repeatedly re-armed recovery with unchanged content is
* injected once instead of looping (v0.2.1).
*/
function recoveryDigest(packet, projection) {
	const items = openItems(projection);
	const evidence = [...projection.evidence.values()].filter((row) => items.some((item) => relevantEvidence(projection, item, row)));
	return sha256(JSON.stringify({
		packet,
		revision: projection.contractRevision,
		epoch: projection.epoch,
		host: projection.hostLockDigest,
		evidence
	}));
}
function renderRecoveryPacket(projection, options = {}) {
	const budget = options.charBudget ?? DEFAULT_RECOVERY_CHAR_BUDGET;
	if (!Number.isSafeInteger(budget) || budget < MIN_RECOVERY_CHAR_BUDGET) throw new RangeError("recovery charBudget must be an integer >= 512");
	const clip = (text, size) => text.length <= size ? text : text.slice(0, size - 1) + "…";
	const items = openItems(projection).sort((a, b) => Number(b.kind === "prohibition") - Number(a.kind === "prohibition") || b.revision - a.revision || a.id.localeCompare(b.id));
	const rejected$1 = options.rejectedBindings ?? (projection.lastCheckpointRejectionRevision === projection.contractRevision ? projection.lastCheckpointRejections : []) ?? [];
	const compact = budget < 1e3;
	const COMPLETION_RULE_COMPACT = "Checkpoint required before completion. Qualified safe end preserves pending work; it is not completion.";
	const lines = [`Context Guard: ${items.length} pending; revision ${projection.contractRevision}.`, compact ? COMPLETION_RULE_COMPACT : COMPLETION_RULE];
	const completionRuleIndex = 1;
	const needsReview = needsReviewObligations(projection);
	if (needsReview.length > 0) {
		const shown$1 = needsReview.slice(0, 2).map((item) => `[${clip(item.id, 20)}] ${item.needsReview.reason}`).join("; ");
		const more = needsReview.length > 2 ? ` (+${needsReview.length - 2} more)` : "";
		lines.push(`NEEDS REVIEW: ${shown$1}${more} — a record from an earlier rule set cannot be inherited; resolve it with the root before certifying.`);
	}
	if (items.some((item) => carriesCleanupCondition(deriveItemDiagnosis(projection, item).capability.gap))) lines.push(cleanupConditionFor(budget));
	const pointer = "Details/omissions: context_guard_checkpoint (item_ids, evidence_scope=history, cursor).";
	const evidence = [...projection.evidence.values()].filter((e) => items.some((item) => relevantEvidence(projection, item, e))).sort((a, b) => b.toolResultSeq - a.toolResultSeq || a.id.localeCompare(b.id));
	const footer = (count$1, refusals$1, shown$1) => `${items.length - count$1} items folded; ${rejected$1.length - refusals$1} rejections folded; ${evidence.length - shown$1} relevant evidence rows folded. Full ledger remains enforced.`;
	const reserve = () => lines.join("\n").length + 87 + footer(0, 0, 0).length + 3;
	let remaining = budget - reserve();
	const add = (line, cap) => {
		if (remaining < 30) return false;
		const text = clip(line, Math.min(cap, remaining));
		if (!compact && remaining - (text.length + 1) < 246) {
			const current = lines[completionRuleIndex];
			if (current.length > 103) {
				remaining += current.length - 103;
				lines[completionRuleIndex] = COMPLETION_RULE_COMPACT;
			}
		}
		lines.push(text);
		remaining -= text.length + 1;
		return true;
	};
	const constraints = items.filter((item) => item.kind === "prohibition");
	const work = items.filter((item) => item.kind !== "prohibition");
	let count = 0, refusals = 0, shown = 0;
	const constraint = (item) => {
		if (add(`DO NOT [${clip(item.id, 20)}] ${clip(item.normalizedText, compact ? 18 : 100)}`, compact ? 45 : 140)) count++;
	};
	const requirement = (item) => {
		const diagnosis = deriveItemDiagnosis(projection, item);
		if (diagnosis.reason_code === "root_condition_pending") {
			if (add(`[${clip(item.id, 20)}] root_condition_pending; wait for trusted root: ${item.resumeEvent ?? item.condition ?? item.normalizedText}; do not execute before release`, compact ? 160 : 310)) count++;
			return;
		}
		const remedy = remedyText(diagnosis.capability.remedy, diagnosis.next_action.resume_condition ?? "No further action needed.");
		const body = compact ? remedy : diagnosis.next_action.resume_condition ?? remedy;
		if (add(`[${clip(item.id, 20)}] ${diagnosis.reason_code}; ${body}; ${clip(item.normalizedText, 70)}`, compact ? 110 : 310)) count++;
	};
	if (constraints[0]) constraint(constraints[0]);
	if (work[0]) requirement(work[0]);
	if (!compact) {
		for (const item of work.slice(1, 4)) requirement(item);
		for (const item of constraints.slice(1, 4)) constraint(item);
		for (const binding of rejected$1.slice(0, 4)) if (add(`rejected ${clip(binding.itemId, 30)}: ${clip(binding.reasonCode ?? binding.reason, 120)}`, 170)) refusals++;
		for (const item of work.slice(0, 4)) if (itemDiagnosis(projection, item).certifiable) add(`closing hint [${clip(item.id, 20)}]: ${closingHint(projection, item)}`, 240);
		for (const row of evidence.slice(0, 4)) if (add(`evidence ${clip(row.id, 40)} action=${row.semanticAction} role=${row.evidenceRole ?? "effect"}`, 140)) shown++;
	}
	lines.push(footer(count, refusals, shown), pointer);
	return lines.join("\n");
}

//#endregion
//#region src/domain/proof.ts
const PROOF_PROTOCOL_VERSION = "0.4.0";
const PROOF_KINDS = [
	"subject_readback",
	"scope_coverage",
	"state_verification"
];
function stable$2(value) {
	if (Array.isArray(value)) return `[${value.map(stable$2).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable$2(v)}`).join(",")}}`;
	return JSON.stringify(value);
}
function digest(value) {
	return createHash("sha256").update("ccg.proofManifest.v1\n", "utf8").update(stable$2(value), "utf8").digest("hex");
}
function validDigest(value) {
	return /^[0-9a-f]{64}$/.test(value);
}
/**
* The manifest digest root includes every integrity-bearing field, so a
* tampered asset-set digest is exactly as detectable as a tampered obligation.
*/
function proofDigest(obligations, assetSetSha256) {
	return digest({
		proofProtocolVersion: PROOF_PROTOCOL_VERSION,
		obligations: [...obligations],
		...assetSetSha256 !== void 0 ? { assetSetSha256 } : {}
	});
}
function validateProofManifest(manifest) {
	const errors = [];
	if (!manifest || typeof manifest !== "object") return ["proof_manifest_invalid"];
	const value = manifest;
	if (value.proofProtocolVersion !== PROOF_PROTOCOL_VERSION) errors.push("proof_protocol_version_mismatch");
	if (!Array.isArray(value.obligations)) errors.push("proof_obligations_missing");
	if (value.assetSetSha256 !== void 0 && (typeof value.assetSetSha256 !== "string" || !validDigest(value.assetSetSha256))) errors.push("proof_asset_set_digest_invalid");
	if (typeof value.proofSha256 !== "string" || !validDigest(value.proofSha256)) errors.push("proof_digest_invalid");
	const obligations = Array.isArray(value.obligations) ? value.obligations : [];
	const ids = /* @__PURE__ */ new Set();
	for (const raw of obligations) {
		if (!raw || typeof raw !== "object") {
			errors.push("proof_obligation_invalid");
			continue;
		}
		const obligation = raw;
		if (typeof obligation.obligationId !== "string" || ids.has(obligation.obligationId)) errors.push("proof_obligation_id_duplicate_or_invalid");
		if (typeof obligation.obligationId === "string") ids.add(obligation.obligationId);
		if (!PROOF_KINDS.includes(obligation.kind)) errors.push("proof_kind_unsupported");
		if (![
			"artifact",
			"ui",
			"visual",
			"scope"
		].includes(String(obligation.surface))) errors.push("proof_surface_unsupported");
		if (!Array.isArray(obligation.subjectIds) || obligation.subjectIds.length === 0 || obligation.subjectIds.some((id) => typeof id !== "string" || id.startsWith("codex:unsupported/"))) errors.push("proof_subject_invalid");
		if (!Array.isArray(obligation.evidenceIds) || obligation.evidenceIds.length === 0 || new Set(obligation.evidenceIds).size !== obligation.evidenceIds.length) errors.push("proof_evidence_invalid");
		const expected = obligation.expectedScopeDigest;
		const observed = obligation.observedScopeDigest;
		for (const digestValue of [expected, observed]) if (digestValue !== void 0 && (typeof digestValue !== "string" || !validDigest(digestValue))) errors.push("proof_scope_digest_invalid");
		if (expected !== void 0 && observed !== expected) errors.push("proof_scope_digest_mismatch");
		if (expected === void 0 && observed !== void 0) errors.push("proof_scope_digest_mismatch");
	}
	if (errors.length === 0) {
		const assetSet = typeof value.assetSetSha256 === "string" ? value.assetSetSha256 : void 0;
		if (value.proofSha256 !== proofDigest(obligations, assetSet)) errors.push("proof_digest_mismatch");
	}
	return [...new Set(errors)];
}
function createProofManifest(obligations, assetSetSha256) {
	const normalized = obligations.map((obligation) => ({
		obligationId: obligation.obligationId,
		kind: obligation.kind,
		surface: obligation.surface,
		subjectIds: [...obligation.subjectIds].sort(),
		evidenceIds: [...obligation.evidenceIds].sort(),
		...obligation.expectedScopeDigest ? { expectedScopeDigest: obligation.expectedScopeDigest } : {},
		...obligation.observedScopeDigest ? { observedScopeDigest: obligation.observedScopeDigest } : {}
	})).sort((a, b) => a.obligationId.localeCompare(b.obligationId));
	const manifest = {
		proofProtocolVersion: PROOF_PROTOCOL_VERSION,
		obligations: normalized,
		...assetSetSha256 !== void 0 ? { assetSetSha256 } : {},
		proofSha256: proofDigest(normalized, assetSetSha256)
	};
	const errors = validateProofManifest(manifest);
	if (errors.length) throw new Error(`proof manifest rejected: ${errors.join(",")}`);
	return manifest;
}
/**
* Bind a structurally valid proof to the actual replayed projection: every
* obligation must name a pending item, every evidence id must exist in the
* projection, and every bound evidence must satisfy the obligation's kind,
* surface, subject, and outcome constraints. An empty projection therefore
* rejects any proof, and cross-item or foreign evidence can never bind.
*/
function bindProofToProjection(projection, proof) {
	const errors = [];
	const items = projection.items;
	const evidence = projection.evidence;
	for (const obligation of proof.obligations) {
		const item = items.get(obligation.obligationId);
		if (!item) {
			errors.push("proof_obligation_unbound");
			continue;
		}
		if (item.status !== "pending") {
			errors.push("proof_obligation_not_pending");
			continue;
		}
		if (item.verification.surface !== void 0 && item.verification.surface !== obligation.surface) errors.push("proof_surface_unbound");
		const seen = /* @__PURE__ */ new Set();
		for (const evidenceId of obligation.evidenceIds) {
			const record = evidence.get(evidenceId);
			if (!record) {
				errors.push("proof_evidence_unknown");
				continue;
			}
			if (!seen.has(evidenceId)) seen.add(evidenceId);
			if (record.outcome !== "success") {
				errors.push("proof_evidence_outcome_invalid");
				continue;
			}
			if (!proofEvidenceConstraints(record, obligation)) errors.push("proof_evidence_constraint_failed");
		}
		if (obligation.kind === "scope_coverage") {
			const itemScope = item.requestedTarget?.scope;
			const itemSubject = item.verification.subject;
			if (!obligation.subjectIds.every((subject) => subject === itemScope || subject === itemSubject)) errors.push("proof_scope_subject_unbound");
		}
	}
	return [...new Set(errors)];
}
function canonicalProjection(projection) {
	return {
		epoch: projection.epoch,
		contractRevision: projection.contractRevision,
		sessionRefDigest: projection.sessionRefDigest,
		hostLockDigest: projection.hostLockDigest,
		hostStatus: projection.hostStatus,
		hostCohortId: projection.hostCohortId,
		integrity: projection.integrity,
		items: [...projection.items.values()].map(({ id, revision, kind, status, semanticAction, requestedTarget, verification }) => ({
			id,
			revision,
			kind,
			status,
			semanticAction,
			requestedTarget,
			verification
		})).sort((a, b) => a.id.localeCompare(b.id)),
		evidence: [...projection.evidence.values()].map(({ id, epoch, toolName, outcome, capabilities, subjects, surfaces: surfaces$1, operations, semanticAction, evidenceRole, resolvedTarget, observedState }) => ({
			id,
			epoch,
			toolName,
			outcome,
			capabilities,
			subjects,
			surfaces: surfaces$1,
			operations,
			semanticAction,
			evidenceRole,
			resolvedTarget,
			observedState
		})).sort((a, b) => a.id.localeCompare(b.id)),
		checkpoints: projection.checkpoints.map(({ id, certificationDigest: certificationDigest$1, result }) => ({
			id,
			certificationDigest: certificationDigest$1,
			result
		}))
	};
}
function sessionQuery(projection, proof) {
	if (proof) {
		if (validateProofManifest(proof).length) return {
			sessionRefDigest: projection.sessionRefDigest,
			epoch: projection.epoch,
			contractRevision: projection.contractRevision,
			state: "corrupt",
			reasonCode: "proof_invalid",
			cohortId: projection.hostCohortId
		};
		if (bindProofToProjection(projection, proof).length) return {
			sessionRefDigest: projection.sessionRefDigest,
			epoch: projection.epoch,
			contractRevision: projection.contractRevision,
			state: "corrupt",
			reasonCode: "proof_unbound",
			cohortId: projection.hostCohortId
		};
	}
	const state = projection.integrity === "valid" ? projection.hostStatus === "supported" ? "valid" : "unknown" : projection.integrity;
	return {
		sessionRefDigest: projection.sessionRefDigest,
		epoch: projection.epoch,
		contractRevision: projection.contractRevision,
		state,
		...proof ? { proof } : {},
		cohortId: projection.hostCohortId
	};
}
function proofEvidenceConstraints(evidence, obligation) {
	if (evidence.outcome !== "success" || evidence.surfaces.length !== 1 || evidence.surfaces[0] !== obligation.surface) return false;
	if (!obligation.subjectIds.every((subject) => evidence.subjects.includes(subject))) return false;
	if (obligation.kind === "subject_readback" && !(evidence.operations ?? []).some(({ op }) => op === "read" || op === "verify")) return false;
	if (obligation.kind === "scope_coverage" && !(evidence.operations ?? []).some(({ op }) => op === "run" || op === "verify")) return false;
	if (obligation.kind === "state_verification" && evidence.evidenceRole !== "state") return false;
	return true;
}
const PROOF_PROTOCOL_VERSION_V2 = "0.6.0";
/** The v2 digest domain; the v1 domain string is untouched. */
const PROOF_MANIFEST_DOMAIN_V2 = "ccg.proofManifest.v2";
const PROOF_KINDS_V2 = [
	"subject_readback",
	"scope_coverage",
	"state_verification",
	"input_asset_check",
	"output_visual_readback",
	"object_url_readback",
	"execution_fact",
	"external_fact"
];
const ALL_SURFACES = [
	"native_read",
	"native_write_edit",
	"shell",
	"web",
	"jobs",
	"subagent",
	"visual_capture"
];
function surfaces(supported) {
	return {
		supportedSurfaces: [...supported],
		unavailableSurfaces: ALL_SURFACES.filter((surface) => !supported.includes(surface))
	};
}
const PROOF_CAPABILITY_MATRIX = {
	subject_readback: {
		kind: "subject_readback",
		capabilities: [
			"filesystem-read",
			"verify",
			"deterministic-check"
		],
		readbackRequired: true,
		operationOnSubject: true,
		...surfaces(["native_read", "shell"])
	},
	scope_coverage: {
		kind: "scope_coverage",
		capabilities: [
			"filesystem-read",
			"verify",
			"deterministic-check",
			"web-fetch"
		],
		readbackRequired: true,
		operationOnSubject: false,
		...surfaces([
			"native_read",
			"shell",
			"web"
		])
	},
	state_verification: {
		kind: "state_verification",
		capabilities: [
			"filesystem-read",
			"web-fetch",
			"deterministic-check"
		],
		readbackRequired: true,
		requiredRole: "state",
		operationOnSubject: false,
		...surfaces(["native_read", "web"])
	},
	input_asset_check: {
		kind: "input_asset_check",
		capabilities: ["filesystem-read", "web-fetch"],
		readbackRequired: true,
		requiredRole: "resolution",
		operationOnSubject: true,
		...surfaces(["native_read", "web"])
	},
	output_visual_readback: {
		kind: "output_visual_readback",
		capabilities: ["visual-readback"],
		readbackRequired: true,
		operationOnSubject: true,
		...surfaces(["visual_capture"])
	},
	object_url_readback: {
		kind: "object_url_readback",
		capabilities: ["web-fetch"],
		readbackRequired: true,
		operationOnSubject: true,
		...surfaces(["web"])
	},
	execution_fact: {
		kind: "execution_fact",
		capabilities: [],
		readbackRequired: false,
		requiredRole: "effect",
		operationOnSubject: false,
		...surfaces([
			"shell",
			"native_write_edit",
			"native_read",
			"web",
			"jobs",
			"subagent"
		])
	},
	external_fact: {
		kind: "external_fact",
		capabilities: [],
		readbackRequired: false,
		operationOnSubject: false,
		...surfaces(["jobs", "subagent"])
	}
};
/** The host surface names a fact's tool/adapter identity maps to. */
function proofHostSurfacesOf(evidence) {
	const surface = /* @__PURE__ */ new Set();
	if (evidence.externalOperationRef) surface.add("jobs");
	if (evidence.delegatedSubtask) surface.add("subagent");
	if (evidence.capabilities.includes("visual-readback")) surface.add("visual_capture");
	if (evidence.capabilities.includes("web-fetch")) surface.add("web");
	if (new Set([
		"write",
		"edit",
		"write_file",
		"edit_file"
	]).has(evidence.toolName)) surface.add("native_write_edit");
	if (new Set([
		"read",
		"read_file",
		"web_fetch",
		"web_fetch_url",
		"web_search"
	]).has(evidence.toolName)) surface.add("native_read");
	if ([
		"bash",
		"shell",
		"pwsh"
	].includes(evidence.toolName)) surface.add("shell");
	if (evidence.capabilities.includes("filesystem-read")) surface.add("native_read");
	return [...surface].sort();
}
function digestV2(value) {
	return createHash("sha256").update(`${PROOF_MANIFEST_DOMAIN_V2}\n`, "utf8").update(stable$2(value), "utf8").digest("hex");
}
function proofDigestV2(obligations) {
	return digestV2({
		proofProtocolVersion: PROOF_PROTOCOL_VERSION_V2,
		obligations: [...obligations]
	});
}
function createProofManifestV2(obligations) {
	const normalized = obligations.map((obligation) => ({
		obligationId: obligation.obligationId,
		kind: obligation.kind,
		surface: obligation.surface,
		subjectIds: [...obligation.subjectIds].sort(),
		sourceIds: [...obligation.sourceIds].sort(),
		operation: obligation.operation,
		evidenceIds: [...obligation.evidenceIds].sort(),
		...obligation.expectedScopeDigest ? { expectedScopeDigest: obligation.expectedScopeDigest } : {},
		...obligation.observedScopeDigest ? { observedScopeDigest: obligation.observedScopeDigest } : {}
	})).sort((a, b) => a.obligationId.localeCompare(b.obligationId));
	const manifest = {
		proofProtocolVersion: PROOF_PROTOCOL_VERSION_V2,
		obligations: normalized,
		proofSha256: proofDigestV2(normalized)
	};
	const errors = validateProofManifestV2(manifest);
	if (errors.length) throw new Error(`proof v2 manifest rejected: ${errors.join(",")}`);
	return manifest;
}
function validateProofManifestV2(manifest) {
	const errors = [];
	if (!manifest || typeof manifest !== "object") return ["proof_manifest_invalid"];
	const value = manifest;
	if (value.proofProtocolVersion !== PROOF_PROTOCOL_VERSION_V2) errors.push("proof_protocol_version_mismatch");
	if (!Array.isArray(value.obligations)) errors.push("proof_obligations_missing");
	if (typeof value.proofSha256 !== "string" || !validDigest(value.proofSha256)) errors.push("proof_digest_invalid");
	const obligations = Array.isArray(value.obligations) ? value.obligations : [];
	const ids = /* @__PURE__ */ new Set();
	for (const raw of obligations) {
		if (!raw || typeof raw !== "object") {
			errors.push("proof_obligation_invalid");
			continue;
		}
		const obligation = raw;
		if (typeof obligation.obligationId !== "string" || !obligation.obligationId || ids.has(obligation.obligationId)) errors.push("proof_obligation_id_duplicate_or_invalid");
		if (typeof obligation.obligationId === "string") ids.add(obligation.obligationId);
		if (!PROOF_KINDS_V2.includes(obligation.kind)) errors.push("proof_kind_unsupported");
		if (![
			"artifact",
			"ui",
			"visual",
			"scope"
		].includes(String(obligation.surface))) errors.push("proof_surface_unsupported");
		if (![
			"create",
			"write",
			"modify",
			"read",
			"run",
			"verify"
		].includes(String(obligation.operation))) errors.push("proof_operation_unsupported");
		if (!Array.isArray(obligation.subjectIds) || obligation.subjectIds.length === 0 || obligation.subjectIds.some((id) => typeof id !== "string" || !id)) errors.push("proof_subject_invalid");
		if (!Array.isArray(obligation.sourceIds) || obligation.sourceIds.length === 0 || obligation.sourceIds.some((id) => typeof id !== "string" || !id)) errors.push("proof_source_invalid");
		if (!Array.isArray(obligation.evidenceIds) || obligation.evidenceIds.length === 0 || obligation.evidenceIds.some((id) => typeof id !== "string" || !id) || new Set(obligation.evidenceIds).size !== obligation.evidenceIds.length) errors.push("proof_evidence_invalid");
		const expected = obligation.expectedScopeDigest;
		const observed = obligation.observedScopeDigest;
		for (const digestValue of [expected, observed]) if (digestValue !== void 0 && (typeof digestValue !== "string" || !validDigest(digestValue))) errors.push("proof_scope_digest_invalid");
		if (expected !== observed) errors.push("proof_scope_digest_mismatch");
	}
	if (errors.length === 0 && value.proofSha256 !== proofDigestV2(obligations)) errors.push("proof_digest_mismatch");
	return [...new Set(errors)];
}
/**
* Why one fact cannot discharge one v2 obligation, or `undefined` when it can.
* The checks are ordered so the reported reason names the first unmet
* requirement: missing producer capability, wrong role, absent readback, wrong
* source, wrong subject, wrong operation.
*/
function proofV2Rejection(evidence, obligation) {
	const spec = PROOF_CAPABILITY_MATRIX[obligation.kind];
	if (evidence.delegatedSubtask) return "proof_source_bounded_delegation";
	if (obligation.sourceIds.length > 0 && !obligation.sourceIds.includes(evidence.toolName) && !obligation.sourceIds.includes(evidence.adapterId ?? "")) return "proof_source_unbound";
	if (evidence.outcome !== "success") return "proof_evidence_outcome_invalid";
	if (obligation.kind === "external_fact") {
		if (!evidence.externalOperationRef) return "proof_external_fact_unavailable";
		if (evidence.externalOperationRef.status !== "completed") return "proof_external_fact_incomplete";
	}
	const available = proofHostSurfacesOf(evidence);
	if (available.length === 0 || !available.some((surface) => spec.supportedSurfaces.includes(surface))) return "proof_producer_capability_unavailable";
	if (spec.capabilities.length > 0 && !spec.capabilities.some((capability) => evidence.capabilities.includes(capability))) return "proof_producer_capability_unavailable";
	if (spec.requiredRole !== void 0 && evidence.evidenceRole !== spec.requiredRole) return "proof_role_unbound";
	if (spec.readbackRequired) {
		if (!(evidence.operations ?? []).some((entry) => entry.op === "read" || entry.op === "verify")) return "proof_readback_unavailable";
		if (spec.operationOnSubject && obligation.subjectIds.length > 0) {
			const subjects = evidence.subjects;
			if (!obligation.subjectIds.every((subject) => subjects.some((value) => value === subject))) return "proof_subject_unbound";
		}
	}
	if (obligation.kind === "state_verification" && evidence.surfaces.length > 0 && !evidence.surfaces.includes(obligation.surface)) return "proof_surface_unbound";
	if (obligation.kind === "execution_fact" && !(evidence.operations ?? []).some((entry) => entry.op === obligation.operation)) return "proof_operation_unbound";
}
/**
* The subjects an item's own obligation requires. They come from the item's
* frozen verification contract and captured target — never from the proof
* manifest, which is exactly what a proof must be checked against.
*/
function requiredSubjectsOf(item) {
	const values = /* @__PURE__ */ new Set();
	const subject = item.verification.subject;
	if (typeof subject === "string" && subject.length > 0 && subject !== "scope") values.add(subject);
	const target = item.requestedTarget ?? {};
	if (item.verification.surface === "scope") {
		const scope = target.scope;
		if (typeof scope === "string" && scope.length > 0 && scope !== "scope") values.add(scope);
	}
	for (const key of [
		"artifact_id",
		"package_id",
		"service_id",
		"repository"
	]) {
		const value = target[key];
		if (typeof value === "string" && value.length > 0 && value !== "scope") values.add(value);
	}
	return [...values].sort();
}
/** The frozen coverage digest of a subject set: sorted, then hashed. */
function scopeCoverageDigest(subjects) {
	return createHash("sha256").update("ccg.proofScopeCoverage.v2\n", "utf8").update(JSON.stringify([...subjects].sort()), "utf8").digest("hex");
}
/**
* Operations a fact may perform to discharge one proof kind. `execution_fact`
* is bound to the obligation's own declared operation; the readback kinds
* accept only an actual read or verify, so a bare successful call never
* satisfies them.
*/
const KIND_OPERATIONS = {
	subject_readback: ["read", "verify"],
	scope_coverage: ["run", "verify"],
	state_verification: ["read", "verify"],
	input_asset_check: ["read", "verify"],
	output_visual_readback: ["read", "verify"],
	object_url_readback: ["read", "verify"],
	execution_fact: "declared",
	external_fact: []
};
/** Whether the fact performed an operation the kind accepts. */
function proofOperationMatches(evidence, obligation) {
	const allowed = KIND_OPERATIONS[obligation.kind];
	const operations = evidence.operations ?? [];
	if (allowed === "declared") return operations.some((entry) => entry.op === obligation.operation);
	if (allowed.length === 0) return true;
	return operations.some((entry) => allowed.includes(entry.op));
}
/**
* Bind a v2 manifest to the live projection; [] means every obligation binds.
*
* The binding is the whole chain the review demanded, in one place:
* the user's obligation (frozen subject and scope on the ITEM) → the trusted
* producer fact (qualified by the same availability rules ordinary evidence
* uses) → the declared source → the declared operation and its order relative
* to the effect → the real coverage set. Only then is the obligation
* discharged. A manifest that describes a different subject than the item
* asked about fails even when the manifest and the facts agree with each
* other.
*/
function bindProofV2ToProjection(projection, manifest) {
	const errors = [];
	for (const obligation of manifest.obligations) {
		const item = projection.items.get(obligation.obligationId);
		if (!item) {
			errors.push("proof_obligation_unbound");
			continue;
		}
		if (item.status !== "pending") {
			errors.push("proof_obligation_not_pending");
			continue;
		}
		if (item.verification.surface !== void 0 && item.verification.surface !== obligation.surface) errors.push("proof_surface_unbound");
		const required = requiredSubjectsOf(item);
		if (required.length > 0) {
			if (!obligation.subjectIds.every((subject) => required.includes(subject))) {
				errors.push("proof_subject_unbound");
				continue;
			}
			if (!required.every((subject) => obligation.subjectIds.includes(subject))) {
				errors.push("proof_scope_incomplete");
				continue;
			}
		}
		const cited = [];
		for (const evidenceId of obligation.evidenceIds) {
			const evidence = projection.evidence.get(evidenceId);
			if (!evidence) {
				errors.push("proof_evidence_unknown");
				continue;
			}
			const availability = evidenceAvailabilityReason(evidence);
			if (availability !== void 0) {
				errors.push(availability);
				continue;
			}
			if (evidence.epoch !== projection.epoch) {
				errors.push("proof_evidence_wrong_epoch");
				continue;
			}
			if (obligation.subjectIds.length > 0 && !evidence.subjects.some((subject) => obligation.subjectIds.includes(subject))) {
				errors.push("proof_subject_unbound");
				continue;
			}
			if (!proofOperationMatches(evidence, obligation)) {
				errors.push("proof_operation_unbound");
				continue;
			}
			const rejection = proofV2Rejection(evidence, obligation);
			if (rejection) {
				errors.push(rejection);
				continue;
			}
			cited.push(evidence);
		}
		if (cited.length === 0 && obligation.evidenceIds.length > 0) continue;
		if (required.length > 0 && !required.every((subject) => cited.some((fact) => fact.subjects.includes(subject)))) {
			errors.push("proof_scope_incomplete");
			continue;
		}
		if (obligation.kind === "input_asset_check") {
			const firstCheck = Math.min(...cited.map((fact) => fact.toolResultSeq));
			if ([...projection.evidence.values()].some((fact) => fact.evidenceRole === "effect" && required.some((subject) => fact.subjects.includes(subject)) && fact.toolResultSeq < firstCheck)) {
				errors.push("proof_input_check_after_effect");
				continue;
			}
		}
		if (obligation.kind === "scope_coverage") {
			const covered = [...new Set(cited.flatMap((fact) => fact.subjects))].sort();
			if (obligation.expectedScopeDigest !== void 0 && obligation.expectedScopeDigest !== scopeCoverageDigest(required)) {
				errors.push("proof_scope_digest_unbound");
				continue;
			}
			if (obligation.observedScopeDigest !== void 0 && obligation.observedScopeDigest !== scopeCoverageDigest(covered)) {
				errors.push("proof_scope_digest_unbound");
				continue;
			}
		}
	}
	return [...new Set(errors)];
}
function sessionQueryV2(projection, proof) {
	if (proof) {
		if (validateProofManifestV2(proof).length) return {
			sessionRefDigest: projection.sessionRefDigest,
			epoch: projection.epoch,
			contractRevision: projection.contractRevision,
			state: "corrupt",
			reasonCode: "proof_invalid",
			cohortId: projection.hostCohortId
		};
		if (bindProofV2ToProjection(projection, proof).length) return {
			sessionRefDigest: projection.sessionRefDigest,
			epoch: projection.epoch,
			contractRevision: projection.contractRevision,
			state: "corrupt",
			reasonCode: "proof_unbound",
			cohortId: projection.hostCohortId
		};
	}
	const state = projection.integrity === "valid" ? projection.hostStatus === "supported" ? "valid" : "unknown" : projection.integrity;
	return {
		sessionRefDigest: projection.sessionRefDigest,
		epoch: projection.epoch,
		contractRevision: projection.contractRevision,
		state,
		...proof ? { proof } : {},
		cohortId: projection.hostCohortId
	};
}
/**
* The capability report for one proof kind against the facts a cohort actually
* produced: `unavailable` with a stable reason when no producer is observable,
* never a silent pass.
*/
function proofCapabilityReport(kind, facts) {
	for (const fact of facts) {
		if (fact.outcome !== "success") continue;
		const probe = {
			obligationId: "probe",
			kind,
			surface: "artifact",
			subjectIds: fact.subjects.slice(0, 1),
			sourceIds: [],
			operation: "verify",
			evidenceIds: []
		};
		if (probe.subjectIds.length === 0) probe.subjectIds = ["probe"];
		if (proofV2Rejection(fact, probe) === void 0) return { status: "supported" };
	}
	return {
		status: "unavailable",
		reasonCode: "proof_producer_capability_unavailable"
	};
}

//#endregion
//#region src/domain/checkpoint.ts
function stable$1(value) {
	if (Array.isArray(value)) return `[${value.map(stable$1).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stable$1(entry)}`).join(",")}}`;
	return JSON.stringify(value);
}
function tuplesEqual(left, right) {
	return stable$1(left ?? {}) === stable$1(right ?? {});
}
function transitionsEqual(left, right) {
	return stable$1(left) === stable$1(right);
}
function transitionIsSelfConsistent(action, transition) {
	if (!transition?.parameters || transition.predicateId !== ACTION_MANIFEST.actions[action].predicateId || transition.version !== 1 || transition.predParamsKind !== "inline") return false;
	const recomputed = predParamsDigest(transition.parameters, resolveAllowlist("product"));
	return transition.parametersDigest === void 0 || transition.parametersDigest === recomputed;
}
function evidenceFact(evidence) {
	return {
		id: evidence.id,
		outcome: evidence.outcome,
		method: evidence.toolName,
		operations: (evidence.operations ?? []).map((entry) => entry.op),
		executables: evidence.executables ?? [],
		subjects: evidence.subjects,
		surfaces: evidence.surfaces,
		semanticAction: evidence.semanticAction ?? "generic_run",
		evidenceRole: evidence.evidenceRole ?? "effect",
		resolvedTarget: evidence.resolvedTarget ?? {},
		observedState: evidence.observedState,
		parseStatus: evidence.parseStatus ?? "adapter_unavailable",
		reasonCode: evidence.reasonCode ?? (evidence.parseStatus ? void 0 : "adapter_unavailable"),
		adapterId: evidence.adapterId,
		adapterVersion: evidence.adapterVersion
	};
}
function citedEvidence(projection, binding) {
	return binding.evidenceIds.map((id) => projection.evidence.get(id)).filter((value) => value !== void 0);
}
function evidenceProblem(projection, item, binding) {
	const missing = binding.evidenceIds.filter((id) => !projection.evidence.has(id));
	if (missing.length) return {
		itemId: item.id,
		reason: "cited evidence is missing",
		reasonCode: "evidence_missing",
		offendingEvidenceIds: missing
	};
	if (item.reboundFrom) {
		const sourceSeq = /^m(\d+)(?::|$)/.exec(item.sourceMessageId);
		const tooEarly = binding.evidenceIds.filter((id) => !sourceSeq || projection.evidence.get(id).toolResultSeq < Number(sourceSeq[1]));
		if (tooEarly.length) return {
			itemId: item.id,
			reason: "evidence predates the authoritative root clause used by this replacement",
			reasonCode: "rebind_evidence_predates_source",
			offendingEvidenceIds: tooEarly
		};
	}
	const wrongEpoch = binding.evidenceIds.filter((id) => projection.evidence.get(id)?.epoch !== projection.epoch);
	if (wrongEpoch.length) return {
		itemId: item.id,
		reason: "cited evidence belongs to a different epoch",
		reasonCode: "evidence_wrong_epoch",
		offendingEvidenceIds: wrongEpoch
	};
	const notSuccess = binding.evidenceIds.filter((id) => projection.evidence.get(id)?.outcome !== "success");
	if (notSuccess.length) return {
		itemId: item.id,
		reason: "cited evidence outcome is not success",
		reasonCode: "evidence_outcome_not_success",
		offendingEvidenceIds: notSuccess
	};
	const requiredAction = item.semanticAction ?? "generic_run";
	const compatibleWith = [requiredAction, ...(item.actionPlan ?? []).map((entry) => entry.action)];
	const facts = citedEvidence(projection, binding);
	const incompatible = facts.filter((fact) => !compatibleWith.some((action) => actionCompatible(action, fact.semanticAction ?? "generic_run")));
	if (incompatible.length) {
		const compatibleCount = facts.length - incompatible.length;
		return {
			itemId: item.id,
			reason: compatibleCount > 0 ? "binding contains evidence that matches no required facet" : "semantic action does not match the contract",
			reasonCode: compatibleCount > 0 ? "evidence_matches_no_facet" : "semantic_action_mismatch",
			offendingEvidenceIds: incompatible.map((fact) => fact.id),
			hint: compatibleCount > 0 ? `remove unrelated evidence: ${incompatible.map((fact) => fact.id).join(", ")}` : closingHint(projection, item, binding.evidenceIds)
		};
	}
	if (!isStatefulAction(requiredAction)) {
		const noFacet = facts.filter((fact) => {
			const coverage = evidenceCoverage(item, fact);
			return !coverage.artifact && !coverage.effect && !coverage.method && !coverage.verify && !coverage.run;
		});
		if (noFacet.length) return {
			itemId: item.id,
			reason: "binding contains evidence that matches no required facet",
			reasonCode: "evidence_matches_no_facet",
			offendingEvidenceIds: noFacet.map((fact) => fact.id),
			hint: `remove unrelated evidence: ${noFacet.map((fact) => fact.id).join(", ")}`
		};
	}
}
/**
* The strict-policy proof obligation (C06). Only the surfaces the USER asked
* for add a requirement, and the requirement is a real readback from the v2
* capability matrix: a visual verification needs a fact that actually observed
* the output, a complete-scope verification needs a fact that actually covered
* the scope. Standard policy does not run this, and no ordinary action gains an
* approval step.
*/
function strictProofProblem(projection, item, binding) {
	const surface = item.verification.surface;
	if (surface !== "visual" && surface !== "scope") return void 0;
	const kind = surface === "visual" ? "output_visual_readback" : "scope_coverage";
	const obligation = {
		obligationId: item.id,
		kind,
		surface,
		subjectIds: [item.verification.subject ?? item.requestedTarget?.scope ?? "scope"].filter((value) => typeof value === "string" && value.length > 0),
		sourceIds: [],
		operation: item.verification.operation ?? "verify",
		evidenceIds: binding.evidenceIds
	};
	const cited = citedEvidence(projection, binding);
	if (cited.some((fact) => fact.outcome === "success" && fact.subjects.some((subject) => obligation.subjectIds.includes(subject)) && proofV2Rejection(fact, obligation) === void 0)) return void 0;
	return {
		itemId: item.id,
		reason: `strict policy: the requested ${surface} verification needs a real readback fact from the current projection`,
		reasonCode: "strict_proof_required",
		offendingEvidenceIds: cited.map((fact) => fact.id),
		hint: closingHint(projection, item, binding.evidenceIds)
	};
}
function expectedTransitionMatches(action, transition, resolved, observed) {
	const expectedPredicate = ACTION_MANIFEST.actions[action].predicateId;
	if (transition.predicateId !== expectedPredicate || transition.version !== 1 || transition.predParamsKind !== "inline" || !transition.parameters) return false;
	const params = transition.parameters;
	const recomputed = predParamsDigest(params, resolveAllowlist("product"));
	if (transition.parametersDigest && transition.parametersDigest !== recomputed) return false;
	switch (action) {
		case "install":
		case "apply":
		case "publish": return [
			action === "publish" ? "artifact_id" : "package_id",
			"version",
			"integrity_digest",
			...action === "publish" ? ["registry"] : ["profile"]
		].every((key) => stable$1(observed[key]) === stable$1(resolved[key]) && stable$1(params[key]) === stable$1(resolved[key]));
		case "create":
		case "modify": return stable$1(observed.post_digest) === stable$1(params.post_digest);
		case "restart": return stable$1(params.pre_generation) === stable$1(resolved.pre_generation) && stable$1(observed.new_generation) !== stable$1(resolved.pre_generation) && stable$1(observed.health) === stable$1(params.health);
		case "commit": return stable$1(params.pre_head_oid) === stable$1(resolved.pre_head_oid) && stable$1(params.change_set_digest) === stable$1(resolved.change_set_digest) && stable$1(observed.pre_head_oid) === stable$1(resolved.pre_head_oid) && stable$1(observed.post_head_oid) !== stable$1(resolved.pre_head_oid);
		case "push": return stable$1(observed.remote_oid) === stable$1(resolved.local_oid) && stable$1(params.local_oid) === stable$1(resolved.local_oid);
		case "pull": return stable$1(resolved.pull_mode) === stable$1("ff-only") && stable$1(params.pull_mode) === stable$1("ff-only") && stable$1(params.upstream_oid) === stable$1(resolved.upstream_oid) && stable$1(params.pre_head_oid) === stable$1(resolved.pre_head_oid) && stable$1(observed.post_head_oid) === stable$1(resolved.upstream_oid) && stable$1(observed.tracking_ref_oid) === stable$1(resolved.upstream_oid);
		case "fetch": return stable$1(params.upstream_oid) === stable$1(resolved.upstream_oid) && stable$1(params.pre_head_oid) === stable$1(resolved.pre_head_oid) && stable$1(observed.tracking_ref_oid) === stable$1(resolved.upstream_oid) && stable$1(observed.post_head_oid) === stable$1(resolved.pre_head_oid);
		default: return true;
	}
}
function nonStatefulTransitionMatches(action, transition, resolved, observed) {
	if (transition.predicateId !== ACTION_MANIFEST.actions[action].predicateId || transition.version !== 1 || transition.predParamsKind !== "inline" || !transition.parameters) return false;
	const params = transition.parameters;
	const recomputed = predParamsDigest(params, resolveAllowlist("product"));
	if (transition.parametersDigest && transition.parametersDigest !== recomputed) return false;
	if (action === "inspect_remote_updates") return ["remote", "version"].every((key) => stable$1(params[key]) === stable$1(resolved[key])) && stable$1(params.upstream_oid) === stable$1(observed.upstream_oid);
	return stable$1(params) === stable$1({
		expected_outcome: {
			k: "e",
			v: "success"
		},
		min_matches: 1
	});
}
function richStatefulRecord(projection, item, binding) {
	const action = item.semanticAction;
	if (!action || !isStatefulAction(action)) return { rejected: {
		itemId: item.id,
		reason: "stateful certificate path received a non-stateful action",
		reasonCode: "semantic_action_mismatch"
	} };
	if (!binding.semanticAction || binding.semanticAction !== action) return { rejected: {
		itemId: item.id,
		reason: "binding semantic action differs from the contract",
		reasonCode: "semantic_action_mismatch"
	} };
	if (!tuplesEqual(binding.requestedTarget, item.requestedTarget)) return { rejected: {
		itemId: item.id,
		reason: "requested target differs from the captured contract",
		reasonCode: "requested_target_mismatch"
	} };
	if (!requestedTargetMatchesResolved(action, item.requestedTarget, binding.resolvedTarget)) return { rejected: {
		itemId: item.id,
		reason: "resolved target differs from an identity named in the root instruction",
		reasonCode: "requested_resolved_target_mismatch"
	} };
	if (ACTION_MANIFEST.actions[action].evidenceProducer !== "supported") return { rejected: {
		itemId: item.id,
		reason: "the pinned host exposes no safe independent producer for this action",
		reasonCode: "stateful_adapter_unavailable"
	} };
	if (!binding.resolutionEvidenceId || !binding.effectEvidenceId || !binding.stateEvidenceIds?.length) return { rejected: {
		itemId: item.id,
		reason: "stateful action requires distinct resolution, effect, and state evidence",
		reasonCode: "effect_only_insufficient_state_readback"
	} };
	if (!validateActionTarget(action, binding.resolvedTarget, binding.observedState)) return { rejected: {
		itemId: item.id,
		reason: "resolved target or observed state is incomplete",
		reasonCode: "state_closure_incomplete"
	} };
	const resolution = projection.evidence.get(binding.resolutionEvidenceId);
	const effect = projection.evidence.get(binding.effectEvidenceId);
	const states = binding.stateEvidenceIds.map((id) => projection.evidence.get(id)).filter((value) => value !== void 0);
	if (!resolution || !effect || states.length !== binding.stateEvidenceIds.length) return { rejected: {
		itemId: item.id,
		reason: "role evidence is missing",
		reasonCode: "evidence_missing"
	} };
	if (resolution.evidenceRole !== "resolution") return { rejected: {
		itemId: item.id,
		reason: "resolution evidence is paired to the wrong role",
		reasonCode: "binding_resolution_cross_pairing"
	} };
	if (effect.evidenceRole !== "effect" || states.some((state) => state.evidenceRole !== "state")) return { rejected: {
		itemId: item.id,
		reason: "evidence role matrix is invalid",
		reasonCode: "binding_role_mismatch"
	} };
	if (resolution.id === effect.id || states.some((state) => state.id === resolution.id || state.id === effect.id)) return { rejected: {
		itemId: item.id,
		reason: "resolution, effect, and state evidence must be distinct",
		reasonCode: "binding_role_mismatch"
	} };
	if (!(resolution.toolResultSeq < effect.toolResultSeq) || states.some((state) => !(effect.toolResultSeq < state.toolResultSeq))) return { rejected: {
		itemId: item.id,
		reason: "resolution must precede effect and independent state readback",
		reasonCode: "binding_role_order_invalid"
	} };
	if (!tuplesEqual(binding.resolvedTarget, resolution.resolvedTarget)) return { rejected: {
		itemId: item.id,
		reason: "resolution evidence is paired to a different target",
		reasonCode: "binding_resolution_cross_pairing"
	} };
	if (!tuplesEqual(binding.resolvedTarget, effect.resolvedTarget) || states.some((state) => !tuplesEqual(binding.resolvedTarget, state.resolvedTarget))) return { rejected: {
		itemId: item.id,
		reason: "effect/state evidence is paired to a different target",
		reasonCode: "binding_state_cross_pairing"
	} };
	const mergedObserved = {};
	for (const state of states) for (const [key, value] of Object.entries(state.observedState ?? {})) {
		if (Object.hasOwn(mergedObserved, key)) return { rejected: {
			itemId: item.id,
			reason: "state observations overlap",
			reasonCode: "binding_state_observation_overlap"
		} };
		mergedObserved[key] = value;
	}
	if (!tuplesEqual(binding.observedState, mergedObserved)) return { rejected: {
		itemId: item.id,
		reason: "binding observed state does not close over state facts",
		reasonCode: "binding_observed_state_mismatch"
	} };
	if (!resolution.expectedTransition?.parameters) return { rejected: {
		itemId: item.id,
		reason: "resolution fact does not freeze expected transition parameters",
		reasonCode: "resolution_expected_transition_missing"
	} };
	if (!resolution.expectedTransitionDigest) return { rejected: {
		itemId: item.id,
		reason: "resolution fact does not bind an expected transition digest",
		reasonCode: "resolution_expected_transition_digest_missing"
	} };
	if (resolution.expectedTransitionDigest !== sha256(stable$1(resolution.expectedTransition))) return { rejected: {
		itemId: item.id,
		reason: "resolution expected transition digest does not match its stable payload",
		reasonCode: "resolution_expected_transition_digest_mismatch"
	} };
	if (!transitionIsSelfConsistent(action, resolution.expectedTransition)) return { rejected: {
		itemId: item.id,
		reason: "resolution fact contains an invalid expected transition",
		reasonCode: "resolution_expected_transition_invalid"
	} };
	if (!transitionsEqual(binding.expectedTransition, resolution.expectedTransition)) return { rejected: {
		itemId: item.id,
		reason: "binding expected transition differs from the cited resolution fact",
		reasonCode: "binding_expected_transition_mismatch"
	} };
	if (!expectedTransitionMatches(action, resolution.expectedTransition, binding.resolvedTarget, binding.observedState)) return { rejected: {
		itemId: item.id,
		reason: "observed state does not satisfy the versioned expected transition",
		reasonCode: "expected_transition_mismatch"
	} };
	const record = {
		item: item.id,
		semanticAction: action,
		requestedTarget: binding.requestedTarget,
		resolvedTarget: binding.resolvedTarget,
		observedState: binding.observedState,
		predId: resolution.expectedTransition.predicateId,
		predVersion: resolution.expectedTransition.version,
		predParamsKind: "inline",
		predParams: resolution.expectedTransition.parameters,
		predParamsAllowlist: "product",
		resolutionEvidenceId: binding.resolutionEvidenceId,
		effectEvidenceId: binding.effectEvidenceId,
		stateEvidenceIds: binding.stateEvidenceIds
	};
	try {
		bindingStateClosure({
			binding: record,
			resolution: evidenceFact(resolution),
			effect: evidenceFact(effect),
			states: states.map(evidenceFact),
			evidenceFacts: citedEvidence(projection, binding).map(evidenceFact)
		});
	} catch (error) {
		return { rejected: {
			itemId: item.id,
			reason: error instanceof Error ? error.message : "state closure rejected",
			reasonCode: "binding_state_closure_rejected"
		} };
	}
	return { record };
}
function simpleRecord(projection, item, binding) {
	if (!bindingSatisfies(projection, item, binding.evidenceIds)) return { rejected: {
		itemId: item.id,
		reason: "evidence does not match the current verification contract",
		reasonCode: "binding_missing_required_facet",
		hint: closingHint(projection, item, binding.evidenceIds)
	} };
	const action = item.semanticAction ?? "generic_run";
	if (!binding.semanticAction || binding.semanticAction !== action) return { rejected: {
		itemId: item.id,
		reason: "binding semantic action differs from the contract",
		reasonCode: "semantic_action_mismatch"
	} };
	if (!tuplesEqual(binding.requestedTarget, item.requestedTarget)) return { rejected: {
		itemId: item.id,
		reason: "requested target differs from the captured contract",
		reasonCode: "requested_target_mismatch"
	} };
	if (!binding.effectEvidenceId || binding.resolutionEvidenceId || (binding.stateEvidenceIds?.length ?? 0) > 0) return { rejected: {
		itemId: item.id,
		reason: "non-stateful binding requires exactly one explicit effect role and no stateful role fields",
		reasonCode: "non_stateful_role_manifest_invalid"
	} };
	const effect = projection.evidence.get(binding.effectEvidenceId);
	if (!effect || !binding.evidenceIds.includes(effect.id)) return { rejected: {
		itemId: item.id,
		reason: "effect evidence is missing from the cited evidence set",
		reasonCode: "evidence_missing"
	} };
	if ((effect.evidenceRole ?? "effect") !== "effect") return { rejected: {
		itemId: item.id,
		reason: "non-stateful evidence is paired to a non-effect role",
		reasonCode: "binding_role_mismatch"
	} };
	if (!bindingSatisfies(projection, item, [effect.id])) return { rejected: {
		itemId: item.id,
		reason: "the explicit effect alone does not bind every required method, capability, and subject facet",
		reasonCode: "binding_missing_required_facet",
		hint: closingHint(projection, item, [effect.id])
	} };
	const effectAction = effect.semanticAction ?? "generic_run";
	const effectTarget = effect.resolvedTarget ?? {};
	const effectObserved = effect.observedState ?? {};
	if (!(Object.entries(binding.resolvedTarget ?? {}).every(([key, value]) => Object.hasOwn(effectTarget, key) && stable$1(value) === stable$1(effectTarget[key])) && Object.entries(binding.observedState ?? {}).every(([key, value]) => Object.hasOwn(effectObserved, key) && stable$1(value) === stable$1(effectObserved[key]))) || effectAction === action && (!tuplesEqual(binding.resolvedTarget, effectTarget) || !tuplesEqual(binding.observedState, effectObserved))) return { rejected: {
		itemId: item.id,
		reason: "binding target does not match the cited effect evidence",
		reasonCode: "binding_state_cross_pairing"
	} };
	if (!validateActionTarget(effectAction, effectTarget, effectObserved)) return { rejected: {
		itemId: item.id,
		reason: "cited effect violates its own closed action manifest",
		reasonCode: "resolved_target_incomplete"
	} };
	if (!validateActionTarget(action, binding.resolvedTarget, binding.observedState ?? {})) return { rejected: {
		itemId: item.id,
		reason: "effect lacks the action target required by the command manifest",
		reasonCode: "resolved_target_incomplete"
	} };
	if (!binding.expectedTransition || !nonStatefulTransitionMatches(action, binding.expectedTransition, binding.resolvedTarget, binding.observedState ?? {})) return { rejected: {
		itemId: item.id,
		reason: "non-stateful expected transition does not match the action manifest",
		reasonCode: "expected_transition_mismatch"
	} };
	return { record: {
		item: item.id,
		semanticAction: action,
		requestedTarget: binding.requestedTarget,
		resolvedTarget: binding.resolvedTarget,
		observedState: binding.observedState ?? {},
		predId: binding.expectedTransition.predicateId,
		predVersion: binding.expectedTransition.version,
		predParamsKind: "inline",
		predParams: binding.expectedTransition.parameters,
		predParamsAllowlist: "product",
		effectEvidenceId: binding.effectEvidenceId,
		stateEvidenceIds: []
	} };
}
function certifyCheckpoint(projection, bindings, id, commit = true) {
	if (projection.integrity !== "valid" || projection.hostStatus !== "supported") return {
		status: "unknown",
		contractRevision: projection.contractRevision,
		openItems: certifiableOpenItems(projection).map((item) => item.id),
		rejectedBindings: []
	};
	const rejectedBindings = [];
	const records = [];
	const referencedFacts = [];
	for (const binding of bindings) {
		const item = projection.items.get(binding.itemId);
		if (!item || item.status === "superseded") {
			rejectedBindings.push({
				itemId: binding.itemId,
				reason: "item is missing or superseded",
				reasonCode: "item_missing_or_superseded"
			});
			continue;
		}
		if (item.legacyFlags?.includes("legacy_authority_unclassified")) {
			rejectedBindings.push({
				itemId: item.id,
				reason: "legacy item authority cannot be proven",
				reasonCode: "legacy_authority_unclassified"
			});
			continue;
		}
		if (item.legacyFlags?.includes("legacy_generic_run")) {
			rejectedBindings.push({
				itemId: item.id,
				reason: "legacy generic-run item is non-certifiable until deterministic rebind",
				reasonCode: "legacy_generic_run_non_certifiable"
			});
			continue;
		}
		const ancestorBlock = ancestorConstraintForBinding(projection, item, binding.resolvedTarget);
		if (ancestorBlock) {
			rejectedBindings.push({
				itemId: item.id,
				reason: ancestorBlock.kind === "prohibition" ? `an ancestor unit (${ancestorBlock.constraintUnitId}) holds prohibition ${ancestorBlock.constraintId} on this action and target` : `an ancestor unit (${ancestorBlock.constraintUnitId}) holds the unsatisfied condition ${ancestorBlock.constraintId} that reserves this action`,
				reasonCode: ancestorBlock.reasonCode,
				hint: closingHint(projection, item)
			});
			continue;
		}
		if (item.targetCaptureStatus === "clarification_required") {
			rejectedBindings.push({
				itemId: item.id,
				reason: "the root instruction does not identify an action-specific target; clarify or explicitly rebind the item",
				reasonCode: item.targetCaptureReasonCode ?? "clarification_or_rebind_required",
				hint: closingHint(projection, item)
			});
			continue;
		}
		if (item.actionPlan && item.actionPlan.length > 0) {
			const planProblem = bindingActionPlanProblem(projection, item, binding);
			if (planProblem) {
				rejectedBindings.push(planProblem);
				continue;
			}
		}
		if (!binding.evidenceIds.length) {
			rejectedBindings.push({
				itemId: item.id,
				reason: "no evidence cited",
				reasonCode: "binding_missing_required_facet",
				hint: closingHint(projection, item)
			});
			continue;
		}
		const problem = evidenceProblem(projection, item, binding);
		if (problem) {
			rejectedBindings.push(problem);
			continue;
		}
		if (projection.policy === "strict") {
			const strictProblem = strictProofProblem(projection, item, binding);
			if (strictProblem) {
				rejectedBindings.push(strictProblem);
				continue;
			}
		}
		if ((item.semanticAction ?? "generic_run") === "generic_run") {
			rejectedBindings.push({
				itemId: item.id,
				reason: "generic run evidence cannot prove a user-level completion contract",
				reasonCode: "generic_run_non_certifiable"
			});
			continue;
		}
		const built = isStatefulAction(item.semanticAction ?? "generic_run") ? richStatefulRecord(projection, item, binding) : simpleRecord(projection, item, binding);
		if (built.rejected) {
			rejectedBindings.push(built.rejected);
			continue;
		}
		records.push(built.record);
		referencedFacts.push(...citedEvidence(projection, binding).map(evidenceFact));
	}
	const unreusable = needsReviewObligations(projection);
	if (unreusable.length > 0) return {
		status: "incomplete",
		contractRevision: projection.contractRevision,
		openItems: [...new Set([...certificateClosure(projection).itemIds, ...unreusable.map((item) => item.id)])],
		rejectedBindings: unreusable.map((item) => ({
			itemId: item.id,
			reason: `a record captured under earlier rules cannot be inherited (${item.needsReview.reason}); resolve it with the root before certifying`,
			reasonCode: "legacy_record_needs_review"
		}))
	};
	const closure = certificateClosure(projection);
	const open = closure.itemIds.filter((itemId) => !bindings.some((binding) => binding.itemId === itemId));
	if (rejectedBindings.length || open.length) return {
		status: "incomplete",
		contractRevision: projection.contractRevision,
		openItems: closure.itemIds,
		rejectedBindings
	};
	if (projection.boundaryProtocol === 5 && closure.unitId === void 0) return {
		status: "incomplete",
		contractRevision: projection.contractRevision,
		openItems: closure.itemIds,
		rejectedBindings: [{
			itemId: "*",
			reason: "no current work unit is available for a v2 certificate",
			reasonCode: "unit_unavailable"
		}]
	};
	try {
		const contractSha256 = currentContractDigest(projection);
		const openDigest = digestStrings(closure.itemIds);
		const evidenceSha256 = evidenceSha256Digest(referencedFacts);
		const bindingDigest$1 = bindingDigest(records, resolveAllowlist("product"));
		const checkpoint = projection.boundaryProtocol === 5 ? (() => {
			const certification = certificationDigestV2({
				stopProtocolVersion: STOP_PROTOCOL_VERSION_V2,
				certificateVersion: CERTIFICATE_VERSION_V2,
				epoch: projection.epoch,
				sessionRefDigest: projection.sessionRefDigest,
				hostLockDigest: projection.hostLockDigest,
				contractRevision: projection.contractRevision,
				contractSha256,
				unitId: closure.unitId,
				unitClosureDigest: openDigest,
				evidenceSha256,
				bindingDigest: bindingDigest$1,
				goalRef: projection.currentGoalRef ?? null
			});
			return {
				id,
				stopProtocolVersion: STOP_PROTOCOL_VERSION_V2,
				certificateVersion: CERTIFICATE_VERSION_V2,
				epoch: projection.epoch,
				sessionRefDigest: projection.sessionRefDigest,
				hostLockDigest: projection.hostLockDigest,
				contractRevision: projection.contractRevision,
				contractSha256,
				openDigest,
				evidenceSha256,
				bindingDigest: bindingDigest$1,
				bindings,
				...projection.currentGoalRef ? { goalRef: { ...projection.currentGoalRef } } : {},
				unitId: closure.unitId,
				unitClosureDigest: openDigest,
				certificationDigest: certification,
				result: "certified"
			};
		})() : (() => {
			const certification = certificationDigest({
				stopProtocolVersion: STOP_PROTOCOL_VERSION,
				certificateVersion: CERTIFICATE_VERSION,
				epoch: projection.epoch,
				sessionRefDigest: projection.sessionRefDigest,
				hostLockDigest: projection.hostLockDigest,
				contractRevision: projection.contractRevision,
				contractSha256,
				...projection.currentGoalRef ? { goalRef: projection.currentGoalRef } : {},
				openDigest,
				evidenceSha256,
				bindingDigest: bindingDigest$1
			});
			return {
				id,
				stopProtocolVersion: STOP_PROTOCOL_VERSION,
				certificateVersion: CERTIFICATE_VERSION,
				epoch: projection.epoch,
				sessionRefDigest: projection.sessionRefDigest,
				hostLockDigest: projection.hostLockDigest,
				contractRevision: projection.contractRevision,
				contractSha256,
				openDigest,
				evidenceSha256,
				bindingDigest: bindingDigest$1,
				bindings,
				...projection.currentGoalRef ? { goalRef: { ...projection.currentGoalRef } } : {},
				certificationDigest: certification,
				result: "certified"
			};
		})();
		if (commit) {
			projection.checkpoints.push(checkpoint);
			for (const binding of bindings) projection.items.get(binding.itemId).status = "passed";
			projection.certificateStatusReason = void 0;
		}
		return {
			status: "certified",
			contractRevision: projection.contractRevision,
			openItems: [],
			rejectedBindings: [],
			checkpoint
		};
	} catch (error) {
		return {
			status: "incomplete",
			contractRevision: projection.contractRevision,
			openItems: closure.itemIds,
			rejectedBindings: [{
				itemId: "*",
				reason: error instanceof Error ? error.message : "certificate manifest rejected",
				reasonCode: "certificate_manifest_rejected"
			}]
		};
	}
}
/**
* Per-action closure check for a multi-action clause. Each planned action needs
* a matching closure whose resolved target matches the target captured for that
* action, whose cited evidence succeeded, and whose evidence is not older than
* the item revision it is closing.
*/
function bindingActionPlanProblem(projection, item, binding) {
	const plan = item.actionPlan ?? [];
	const closures = binding.actionBindings ?? [];
	if (closures.length !== plan.length) return {
		itemId: item.id,
		reason: `the clause orders ${plan.map((entry) => entry.action).join(" + ")}; ${closures.length} action closure(s) supplied`,
		reasonCode: "action_plan_incomplete",
		hint: closingHint(projection, item)
	};
	const ordered = [...closures].sort((a, b) => a.order - b.order);
	for (const [index, planned] of plan.entries()) {
		const closure = ordered[index];
		if (!closure || closure.action !== planned.action) return {
			itemId: item.id,
			reason: `action closure ${index + 1} must be '${planned.action}' in the clause's order`,
			reasonCode: "action_plan_order_mismatch"
		};
		if (planned.targetCaptureStatus !== "resolved") return {
			itemId: item.id,
			reason: `the clause does not identify an exact target for '${planned.action}'`,
			reasonCode: planned.targetCaptureReasonCode ?? "action_plan_target_missing",
			hint: closingHint(projection, item)
		};
		if (!tuplesEqual(planned.requestedTarget, closure.resolvedTarget)) return {
			itemId: item.id,
			reason: `the closure for '${planned.action}' resolves a different target than the clause captured`,
			reasonCode: "action_plan_target_mismatch"
		};
		const reused = closure.evidenceIds.filter((id) => closures.some((other) => other !== closure && other.evidenceIds.includes(id)));
		if (reused.length > 0) return {
			itemId: item.id,
			reason: `evidence cited for '${planned.action}' also closes another action`,
			reasonCode: "action_plan_evidence_reused",
			offendingEvidenceIds: reused
		};
		if (closure.evidenceIds.length === 0) return {
			itemId: item.id,
			reason: `no evidence cited for '${planned.action}'`,
			reasonCode: "action_plan_evidence_missing"
		};
		const cited = closure.evidenceIds.map((id) => projection.evidence.get(id));
		const missing = closure.evidenceIds.filter((id) => !projection.evidence.has(id));
		if (missing.length > 0) return {
			itemId: item.id,
			reason: `cited evidence for '${planned.action}' is missing`,
			reasonCode: "evidence_missing",
			offendingEvidenceIds: missing
		};
		for (const [position, evidence] of cited.entries()) {
			if (!evidence) continue;
			if (evidence.epoch !== projection.epoch) return {
				itemId: item.id,
				reason: `evidence for '${planned.action}' belongs to another epoch`,
				reasonCode: "evidence_wrong_epoch",
				offendingEvidenceIds: [closure.evidenceIds[position]]
			};
			if (evidence.outcome !== "success") return {
				itemId: item.id,
				reason: `evidence for '${planned.action}' did not succeed`,
				reasonCode: "action_plan_evidence_not_successful",
				offendingEvidenceIds: [closure.evidenceIds[position]]
			};
			if (evidence.toolResultSeq < 0) return {
				itemId: item.id,
				reason: `evidence for '${planned.action}' predates the item`,
				reasonCode: "action_plan_evidence_predates_item",
				offendingEvidenceIds: [closure.evidenceIds[position]]
			};
			if (evidence.semanticAction && evidence.semanticAction !== planned.action) return {
				itemId: item.id,
				reason: `evidence for '${planned.action}' records '${evidence.semanticAction}'`,
				reasonCode: "action_plan_action_mismatch",
				offendingEvidenceIds: [closure.evidenceIds[position]]
			};
		}
	}
}

//#endregion
//#region src/domain/contract-segment.ts
const REFERENCE_FRAME = /(?:以下|下面|下列|附上|粘贴|提供).{0,12}(?:报告|材料|内容|记录|日志).{0,12}(?:供参考|参考|如下)|(?:for reference|pasted|attached|following).{0,16}(?:report|material|log)/i;
const INSTRUCTION_SIGNAL = /(?:请|需要|必须|务必|禁止|不要|不得|运行|执行|修改|创建|读取|验证|检查|安装|应用|拉取|抓取|获取|同步|提交|推送|发布|重启|升级|更新)|\b(?:please|must|shall|do not|run|execute|modify|create|read|verify|check|install|apply|pull|fetch|commit|push|publish|restart|upgrade|update)\b/i;
const ADOPTION_SIGNAL = /(?:按照|依照|采用|执行).{0,16}(?:下面|以下|报告|材料|第\s*([0-9一二三四五六七八九十]+)\s*节).{0,16}(?:全部执行|执行|作为验收|作为要求)|(?:把|将).{0,16}(?:上一条|前述|上述).{0,8}(?:报告|材料).{0,12}第\s*([0-9一二三四五六七八九十]+)\s*节.{0,20}(?:执行|采用)|(?:adopt|follow|apply).{0,20}(?:section\s+(\d+)|below|report)/i;
const PREVIOUS_REFERENCE_ADOPTION = /(?:把|将).{0,16}(?:上一条|前述|上述).{0,8}(?:报告|材料).{0,12}第\s*[0-9一二三四五六七八九十]+\s*节.{0,20}(?:执行|采用)|(?:adopt|follow|apply).{0,16}(?:the\s+)?(?:previous|above).{0,12}(?:report|material).{0,12}section\s+\d+/i;
function chineseNumber(value) {
	if (/^\d+$/.test(value)) return Number(value);
	return {
		一: 1,
		二: 2,
		三: 3,
		四: 4,
		五: 5,
		六: 6,
		七: 7,
		八: 8,
		九: 9,
		十: 10
	}[value];
}
function block(kind, text, authority, capture) {
	const normalized = text.trim();
	return {
		kind,
		authority,
		text: normalized,
		capture,
		blockId: `block:${sha256(`${kind}\0${normalized}`).slice(0, 16)}`
	};
}
function parseAdoptedSection(text) {
	const zh = text.match(/第\s*([0-9一二三四五六七八九十]+)\s*节/);
	if (zh) return chineseNumber(zh[1]);
	const en = text.match(/section\s+(\d+)/i);
	return en ? Number(en[1]) : void 0;
}
function sectionNumber(text) {
	const heading = text.match(/^#{1,6}\s*(?:第\s*)?([0-9一二三四五六七八九十]+)\s*(?:节|\b)/);
	return heading ? chineseNumber(heading[1]) : void 0;
}
function referencedSection(text, target) {
	if (!REFERENCE_FRAME.test(text)) return void 0;
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const selected = [];
	let active = false;
	for (const line of lines) {
		const section = sectionNumber(line.trim());
		if (section !== void 0) {
			if (active && section !== target) break;
			active = section === target;
		}
		if (active) selected.push(line);
	}
	return selected.join("\n").trim() || void 0;
}
/**
* Split a direct root-user message into authority blocks before clause capture.
* Framed reports, blockquotes and fenced code remain in the native DSH log but
* never become Guard items. Uncertain prose is captured fail-closed. Explicit
* adoption can promote only the referenced section, never the whole report by
* virtue of normative words inside the report itself.
*/
function segmentAuthorityBlocks(text, priorRootMessages = []) {
	const adoptedSection = parseAdoptedSection(text);
	if (ADOPTION_SIGNAL.test(text) && PREVIOUS_REFERENCE_ADOPTION.test(text) && adoptedSection !== void 0 && priorRootMessages.length > 0) {
		const selected = referencedSection(priorRootMessages.at(-1) ?? "", adoptedSection);
		if (selected) return [block("reference", selected, "root_adoption", true)];
	}
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const result = [];
	const adoption = ADOPTION_SIGNAL.test(text);
	const inlineAdoptedSection = adoption ? adoptedSection : void 0;
	let referenceMode = false;
	let fence = false;
	let buffer = [];
	let bufferKind = "uncertain";
	let currentSection;
	const flush = () => {
		const value = buffer.join("\n").trim();
		buffer = [];
		if (!value) return;
		if (bufferKind === "reference" && adoption && inlineAdoptedSection !== void 0 && currentSection === inlineAdoptedSection) {
			result.push(block("reference", value, "root_adoption", true));
			return;
		}
		if (bufferKind === "instruction") result.push(block("instruction", value, "root_instruction", true));
		else if (bufferKind === "uncertain") result.push(block("uncertain", value, "root_instruction", true));
		else result.push(block(bufferKind, value, "none", false));
	};
	for (const line of lines) {
		if (/^\s*```/.test(line)) {
			if (!fence) {
				flush();
				fence = true;
				bufferKind = "code";
				buffer = [line];
			} else {
				buffer.push(line);
				flush();
				fence = false;
				bufferKind = referenceMode ? "reference" : "uncertain";
			}
			continue;
		}
		if (fence) {
			buffer.push(line);
			continue;
		}
		if (/^\s*>/.test(line)) {
			if (bufferKind !== "quoted") {
				flush();
				bufferKind = "quoted";
			}
			buffer.push(line);
			continue;
		}
		if (bufferKind === "quoted") {
			flush();
			bufferKind = referenceMode ? "reference" : "uncertain";
		}
		if (REFERENCE_FRAME.test(line)) {
			flush();
			referenceMode = true;
			bufferKind = "reference";
			currentSection = void 0;
			buffer.push(line);
			continue;
		}
		if (referenceMode) {
			const nextSection = sectionNumber(line.trim());
			if (nextSection !== void 0) {
				flush();
				currentSection = nextSection;
			}
			bufferKind = "reference";
			buffer.push(line);
			continue;
		}
		if (/^\s*---+\s*$/.test(line)) {
			flush();
			continue;
		}
		if (!line.trim()) {
			flush();
			continue;
		}
		const kind = INSTRUCTION_SIGNAL.test(line) ? "instruction" : "uncertain";
		if (bufferKind !== kind) {
			flush();
			bufferKind = kind;
		}
		buffer.push(line);
	}
	flush();
	return result;
}
function authorityCaptureCounts(blocks) {
	return {
		capturedInstructionClauses: blocks.filter((entry) => entry.kind === "instruction" && entry.capture).length,
		ignoredReferenceClauses: blocks.filter((entry) => entry.kind === "reference" && !entry.capture).length,
		ignoredQuotedClauses: blocks.filter((entry) => entry.kind === "quoted").length,
		ignoredCodeClauses: blocks.filter((entry) => entry.kind === "code").length,
		capturedUncertainClauses: blocks.filter((entry) => entry.kind === "uncertain" && entry.capture).length
	};
}

//#endregion
//#region src/domain/alpha3-host.ts
/** Exact 34-row alpha.3 runtime/web graph from the 2026-09-01 annex audit. */
const ALPHA3_HOST_PACKAGES = [
	[
		"@deepseek-ai/cordis",
		"4.0.2",
		"sha512-asOnXP1TzFSFQlHb1iegDZp0z/8WD1c7YNrwJR/Tx2bzNuMXfcekE/I67Iv6SQXeLB4csxqCngzQKANP7gdw0g=="
	],
	[
		"@deepseek-ai/dsh",
		"0.1.2-alpha.3",
		"sha512-VvATzYmQ4LMJREJ9e2POKksSHRfqP3y9pghplLBaQBuw2BqfbC0mQUVsaPwxe4wlcpj+riEgn8OJB01YnpF+3A=="
	],
	[
		"@deepseek-ai/dsh-agent",
		"0.1.2-alpha.3",
		"sha512-K1Pj9wqXmXjbMv4//wbPEPzaRBIYGluLzgnym2NPZFr9uS5h1soowUWVmI0lb3iU5FIUKuCg7YYEOrGSwPtRhQ=="
	],
	[
		"@deepseek-ai/dsh-agent-loop",
		"0.1.2-alpha.3",
		"sha512-SXA7eKvcpYjexnkY3MLUbJOPaLGXrCCPI/eA1ohhYFiuRsu4y4Lt5C0CchtXWqIxlKDdW3lWapj81OpeYHTi2A=="
	],
	[
		"@deepseek-ai/dsh-attachment",
		"0.1.2-alpha.3",
		"sha512-KiJy3esEEthj2alvZLqGN6YH7Ncmia+lzJW9VWf8J9EThlmUrX9xcG6k8v/paLMyrAv2w4JKxvZCIuWZK5mIwA=="
	],
	[
		"@deepseek-ai/dsh-bash-sandbox",
		"0.1.2-alpha.3",
		"sha512-U3U6ageI0VPs9TmIqtZtztJRBCwGszSbNLHe24h1kPKDAy3UveGNUDdq89OgINJH7U1Ce213uucRcqY8tjkPfw=="
	],
	[
		"@deepseek-ai/dsh-commands",
		"0.1.2-alpha.3",
		"sha512-lXB+f7B5a1gDatCtpww5AvM2TCltb95xkHZMkAmwleBJJgx5iqtKtEelObigXZu14HtZpLdO6v/0Fvm/akOyIg=="
	],
	[
		"@deepseek-ai/dsh-fs",
		"0.1.2-alpha.3",
		"sha512-qOaZ7JRFNJYtdG2EkHpXs4yzypRZX5YHOjZ7RLe571T/eLegg9nCJIEr4gFr1LvPn2nuLdJmwTB2x4ckZkXIuw=="
	],
	[
		"@deepseek-ai/dsh-fs-local",
		"0.1.2-alpha.3",
		"sha512-QzLTaj92cJ4RrE5NTx9NaV5ZhlC0mgSLHK3Z6ePXyHFcgAPGh3dJ6pw4q3r2dC7vlDTKyBIHHCb6MLwSUU8+BA=="
	],
	[
		"@deepseek-ai/dsh-fs-observation-policy",
		"0.1.2-alpha.3",
		"sha512-HDbTSazpoRIyPwmfip5k0nT4FfboaiViJqQplAUulCDxRK0QykuMQPUdkzANEXkvMBR2meTYurR6OPE0NZKuWw=="
	],
	[
		"@deepseek-ai/dsh-fs-sandbox",
		"0.1.2-alpha.3",
		"sha512-Ady8S/1NJcVv2SHgzOWHmhFcfmfidUBN1F5d5KFywHwYzYChtjldiieJvxU7dH7opH/sdX8kxOgFoDqauE4g8w=="
	],
	[
		"@deepseek-ai/dsh-goal",
		"0.1.2-alpha.3",
		"sha512-mExFFbFDupDTwbVagDbHVGJ0jYvGiFYFocAwfGYxPQGxZRcU8d4BgFir60GhbHsKtoSLDc48IlWscTZ6CXD3CA=="
	],
	[
		"@deepseek-ai/dsh-host-plugin-inventory",
		"0.1.2-alpha.3",
		"sha512-NagByjrXyIQRLaTGFmkqZ50HpgkEKuNHvwLskMGgu5ej8ucAQKOvJ2B+iyAlbtXj4Pkr84HKIX6smqjbGJNDxA=="
	],
	[
		"@deepseek-ai/dsh-host-webserver",
		"0.1.2-alpha.3",
		"sha512-VSlbioqJZ8JSQmFnjYXr7U/R7NCfL8fo9ztiYpRTAoqrSoodaabA6hH79Mueb+gAVHOtzpNRLK8dWDkqczmDVA=="
	],
	[
		"@deepseek-ai/dsh-jobs",
		"0.1.2-alpha.3",
		"sha512-P5jS3kqNrnPktvSQLBWsAnf5Dpa20EzVo9giUQQKE6WKgPV9Z3tnRVybV2TFTU6MqGClNAqZmY8tnEMABzgA9g=="
	],
	[
		"@deepseek-ai/dsh-jobs-local",
		"0.1.2-alpha.3",
		"sha512-d77W8jURnp9pVxnU0fuYt8lDmmiJcR9FWzNwPqvk/uwjx9zwtMtkCU0WtBcyxVqVGpEmG2pU2upln1m0eCfVBA=="
	],
	[
		"@deepseek-ai/dsh-llm",
		"0.1.2-alpha.3",
		"sha512-xGedBtvxb1HJWCmVO9v3fhHqoZ1iMDQU1x7fqAhhDfjKjmLTljWC1/RdZqUFI/1a/CM1iGPSaDuPZDCMu45AtA=="
	],
	[
		"@deepseek-ai/dsh-pwsh-sandbox",
		"0.1.2-alpha.3",
		"sha512-nVYijWMJilFWGF/nJLieNyM1c4PY1CdMN0QmHQGMiE9kyL5+MR8xzqlgxQ3I3GzX9zzbN1NjLbm+t+QHaDlLUQ=="
	],
	[
		"@deepseek-ai/dsh-sandbox",
		"0.1.2-alpha.3",
		"sha512-lKM+jhpxvfY48Se+J2sewIY2QP+eGCeSAazlvOsW3VMkzoVSA7RVIJFh6/xn3t1N9wrOXawii5Ex/vGVJ44HBQ=="
	],
	[
		"@deepseek-ai/dsh-sandbox-policy",
		"0.1.2-alpha.3",
		"sha512-Lj75///rZ/5x60aM5fds3u8S4o1QTiy2/TKvqLUr+xT9CJRfk6v81LxV/SYc6DmP2pN0TKwL/50/kL44wbxzvw=="
	],
	[
		"@deepseek-ai/dsh-session",
		"0.1.2-alpha.3",
		"sha512-iwWs0FdShoiCLLVk6lSZL18vKlFuliQXqy6gnu4U34B8K3uPb+QYWHjB3PrTXcK8ZVmb0zdWeyZ9osmANWWKnw=="
	],
	[
		"@deepseek-ai/dsh-shell",
		"0.1.2-alpha.3",
		"sha512-UM+ZObnmKVEy+/d2hKUNAIctpLojpbs7isOyZ3LoWtcVnIK2kjPCPDHBeUj/3DMSzxYR7Ak9QRnNxnG5cXgvDg=="
	],
	[
		"@deepseek-ai/dsh-shell-env",
		"0.1.2-alpha.3",
		"sha512-Phgv3Zuao0jKlS++uyUlQw+7x2Zk3DFcG2qOb86JwP3WpzqgdzoKoplcc3wev3J8+RX5TkNq7Dl92UKPvynGTw=="
	],
	[
		"@deepseek-ai/dsh-subprocess-local",
		"0.1.2-alpha.3",
		"sha512-T2HPtqL17ODH5AS7E6cQKtiulJSGv7HEQmYbQKiSaR2CCiLHlXosUPuGis+yuCfBZ8GZOjwn18abkDraKOOFCg=="
	],
	[
		"@deepseek-ai/dsh-system-prompt",
		"0.1.2-alpha.3",
		"sha512-R+VVDew/0DdTypypAjkgTygh3M2yNYXNFO+DvMfdX98jgD7MSluw2iYaCFR/ax9bBNHXXHQ7eXHsIYI1a0FrPg=="
	],
	[
		"@deepseek-ai/dsh-tool-bash",
		"0.1.2-alpha.3",
		"sha512-eQ3IQ+Jz0CI2e24gx8Q8xg1MyYcE48UP/asWEBfSuM0ycmexbGLPPip/H137NbxBXx1O4Ewok8ipVLyHYx7QjQ=="
	],
	[
		"@deepseek-ai/dsh-tool-fs",
		"0.1.2-alpha.3",
		"sha512-YiY/hxBh11Lu3wKjtGxhDFYHf2ACWpUlhTM1JopJhiEdrIAsZ7wXeRHfLzvMaHJG30+vgIekbY/zY8EOGkOsww=="
	],
	[
		"@deepseek-ai/dsh-tool-goal",
		"0.1.2-alpha.3",
		"sha512-YQ1JwXIGiIDkATlrqV6CV1sbHFd95tbmNPlbsuwjKXETMcGO09iTtOoYCONBT8aIx9TSqcloM37TjDGgpEXFYQ=="
	],
	[
		"@deepseek-ai/dsh-tool-jobs",
		"0.1.2-alpha.3",
		"sha512-tsBJslgxjlv92/8guVjUEOPkr+JlC83BGiJJpHAponyPBdCF/mVy8zBO6V89yEgmjW/nRWTUwv2dZnnHtOCptQ=="
	],
	[
		"@deepseek-ai/dsh-tool-pwsh",
		"0.1.2-alpha.3",
		"sha512-QxCPtD9EcjoKuo1MZid/fkbsXHDKRpF3s1iXUuFIMsjBZs7ip/qoieL/bTpqiyHJcuhHjWver8hKkEdL/nqBdA=="
	],
	[
		"@deepseek-ai/dsh-tools",
		"0.1.2-alpha.3",
		"sha512-ffcpryQgwqAHIkN326CKqH3kueCMKXgbRU4D0Lp+Kwql97NVZrmRxI8ExERJtTju1adtowwVOXIdPjD4XyB44w=="
	],
	[
		"@deepseek-ai/dsh-user-approval",
		"0.1.2-alpha.3",
		"sha512-ulp0zA1JnzrjJVyg4DbKMR6Vxz66+ltbIXKhDQcrPgYE93woI0U2VoWiQPuvlozcWqpEvDsmsmdM3rMTxQrB0A=="
	],
	[
		"@deepseek-ai/dsh-web-app",
		"0.1.2-alpha.3",
		"sha512-ntOJ9WOU+KPOuWBRxTibM89BxiAYN20bKcp3ozn0M5A5+IHG/7QFUxcZUZCq03eVpNR59l/EgGrHdxy7r+ON9g=="
	],
	[
		"dshmarket",
		"1.39.0",
		"sha512-URuXIuuNRfX6k0Flo7CJxeA7EVLhLGYDm3Lk4BoEXW1Qlg+boX/LI8wCE8hGC0FMBftFr9j8D/ulGNTdFM67nQ=="
	]
].map(([name, version, integrity]) => ({
	name,
	version,
	integrity
}));

//#endregion
//#region src/domain/rc1-host.ts
/** Exact 34-row rc.1 runtime/web graph from the 2026-09-03 native macOS audit. */
const RC1_HOST_PACKAGES = [
	[
		"@deepseek-ai/cordis",
		"4.0.2",
		"sha512-asOnXP1TzFSFQlHb1iegDZp0z/8WD1c7YNrwJR/Tx2bzNuMXfcekE/I67Iv6SQXeLB4csxqCngzQKANP7gdw0g=="
	],
	[
		"@deepseek-ai/dsh-agent",
		"0.1.2-rc.1",
		"sha512-lfaqN34vUCWvbn1kJVHrhfJ6Dvt1HDHCm33ZCpmKkl07/5q6FxWqVv6rOdVX5QnM/9xz/uYiN0nQwUtBg4+Skg=="
	],
	[
		"@deepseek-ai/dsh-commands",
		"0.1.2-rc.1",
		"sha512-uBh4JTX7pOkFhmbWjXjVLnOQOawyccC7+DazbHrLRN6/wy4OgTRH+DaW0+ibLq+XRAO19OvBTtuoh3x/KkJx1Q=="
	],
	[
		"@deepseek-ai/dsh-goal",
		"0.1.2-rc.1",
		"sha512-djzY1oNZV5RwnOFXmDeWFbyswInV9RVWAD0qryxMznQtEDF31PUJ8BQfqs9tVrTV36V3a0neYrZP0DDvRP8ZCA=="
	],
	[
		"@deepseek-ai/dsh-llm",
		"0.1.2-rc.1",
		"sha512-7VYsha5AXsVLnsAwYJffWXz9bwUbElw8i5N8tlTSdai9Bupk3sMbsotzPf8ZbsuGAxQYErahMwQwgGEu4qZO6g=="
	],
	[
		"@deepseek-ai/dsh-session",
		"0.1.2-rc.1",
		"sha512-jRGNPTbQcvIx1F2MVmmkoiHLgpC3Btqo1wkl/3JDLlOWRVWKOuaC+5fQiMrFPOYfno6YiX/c2UvmA0td8qB92w=="
	],
	[
		"@deepseek-ai/dsh-tools",
		"0.1.2-rc.1",
		"sha512-W9kUio00s7WbM8kEwniyd4hfb3CeUxVczsjXbOcKtakfiTywNLeyRWkpx2fvwRAH2rBfg3qCgczVfS0DOw1csg=="
	],
	[
		"@deepseek-ai/dsh-tool-goal",
		"0.1.2-rc.1",
		"sha512-ooHKN6Eqy3owNS/oCDO7mR+UalEE4AxJMXou29waahIdSQsFAlk4pPApvhrwg1lpchF5CKwBPOtsVmjq2HfBKQ=="
	],
	[
		"@deepseek-ai/dsh-agent-loop",
		"0.1.2-rc.1",
		"sha512-4h16Gn/5oXLTFeorehdlKe5xmDKscR/eRsUu3cs6clKgaTrn6YvnWNB0XkYEg+AXiXbsyfl5MW5Bs4576t7vZw=="
	],
	[
		"@deepseek-ai/dsh-tool-bash",
		"0.1.2-rc.1",
		"sha512-xKc4oXVDBwM/PaicpjGdWEaJ1N14B7KPmOzdpQ7ynE4gKUnvGU/eTg18EHamdyDOidh5ox0fNUnxk0rQjVo2+Q=="
	],
	[
		"@deepseek-ai/dsh-tool-pwsh",
		"0.1.2-rc.1",
		"sha512-LaImOCdizIGkQnxzzkoaqzRWGZLsuDuqqF2adgJ3zeG0nDwan4Sz+1wYz4YSp0Gg6mJ79CYacsbYmGhYYyKY/g=="
	],
	[
		"@deepseek-ai/dsh-shell",
		"0.1.2-rc.1",
		"sha512-uFrSY0nNKzh5orGl2B0B4RfK7wTdIlwhPQc7aLA44jyjioLlqhF7PUek/NWtye2scwp3YHOw158XeOQUD8qTFg=="
	],
	[
		"@deepseek-ai/dsh-subprocess-local",
		"0.1.2-rc.1",
		"sha512-Spc/IXWvjEteGysifGr6JvCokcH8T88z0mdxIGcu9SFdgDyY8HKR+h5yq73+rbo4RYzT7+TBE43TIZy5LfmzgQ=="
	],
	[
		"@deepseek-ai/dsh-bash-sandbox",
		"0.1.2-rc.1",
		"sha512-dF9PfBWus80Juj3VjUmndbGw1/6cT1BY7BLFuXUi7SDMV1fA4iwA2c7HuvezYFGvpE/8QRZ+c5ZiRfxbWGYktw=="
	],
	[
		"@deepseek-ai/dsh-pwsh-sandbox",
		"0.1.2-rc.1",
		"sha512-QjJzrM/tJDkgvtVzYz2bmCxBzdSUo/YwI/rPBJeTwLbWBuehyhX6BueCwU6Ja1Bsdm9crz2D7rVc/DU/xrFttw=="
	],
	[
		"@deepseek-ai/dsh-shell-env",
		"0.1.2-rc.1",
		"sha512-o1VqxyHp1OrMB8aHnzYAPwuU4giUErCxBg0yr035r6f3Le36viS0sUHsnjcAsMdbaQJf/XvzbaokYDVrdVHE4A=="
	],
	[
		"@deepseek-ai/dsh",
		"0.1.2-rc.1",
		"sha512-RPq48TzxvwpdT9/7W1tbhZDBMmeK+bxDrX9cqQC27Wx/LqtgJF8PSa3b3xriU8oxtvhwYmk21w2cej3uMQrnVA=="
	],
	[
		"@deepseek-ai/dsh-host-plugin-inventory",
		"0.1.2-rc.1",
		"sha512-MyLA5XncFdfk9btv29FZSg+ojFOOsHEiPkGWAQiRw+EG/2HlVUEm/9KqPxh2jxB5eFge9GahTg2e7x3Veziadw=="
	],
	[
		"@deepseek-ai/dsh-host-webserver",
		"0.1.2-rc.1",
		"sha512-QVcaf4qnIa1t215Y8TRiRhqkEz4Lu5/F+KqvWT+4sHOiyWmZr8g1JndqlwP6MBnMQEPmp0I/EKYJ7PWMV32gkA=="
	],
	[
		"@deepseek-ai/dsh-web-app",
		"0.1.2-rc.1",
		"sha512-QGh+XWRgrsVktKD3YHw+cY/knwBESq+2TtyOGNc+V7GU3LG9qL6EPB0M8pIDjxF1jLls+M71LIVbevuFx3oZ6Q=="
	],
	[
		"@deepseek-ai/dsh-jobs",
		"0.1.2-rc.1",
		"sha512-VuNPXosjgRbEg0tp+GXsdAqkicwSk5Ynl2AezUQheJgpmw5cvWy3rLEg79B686xGc72tIA6pCW6eBbZGnKOmIg=="
	],
	[
		"@deepseek-ai/dsh-jobs-local",
		"0.1.2-rc.1",
		"sha512-bfNV6IJRG7vPWg+Rp3siRCA0BVK8rB1aqn0BG2nPKzCIA2coKqeJ8uPbEm+GuyW/naMR4uCOrrCVLyrwBuMwzg=="
	],
	[
		"@deepseek-ai/dsh-tool-jobs",
		"0.1.2-rc.1",
		"sha512-ya7E6zToAdJ+GvNeZFPx8jNx0CfI52tlp0NCGzXHeB0S74haGWCV0iFe1nyoDJg7SDiN1xc1d2nV9klOqWtd5g=="
	],
	[
		"@deepseek-ai/dsh-tool-fs",
		"0.1.2-rc.1",
		"sha512-9a1lcPGD4Z3p7OLTMkkCdwN0w7Gl96Jlypq6qopUA0WMkKai83VfeLZvramPnTJo6ezpuPXcLFWGm/2UDSlbcA=="
	],
	[
		"@deepseek-ai/dsh-fs",
		"0.1.2-rc.1",
		"sha512-BSIB2j8WvATQ1mf7wUIpHPftDwbzz246qp6aUpLGSzBWGmLBdX3O1oDhyNV1YhgPmDQlwovac2odcAb62tuDdw=="
	],
	[
		"@deepseek-ai/dsh-fs-local",
		"0.1.2-rc.1",
		"sha512-tFHHKtD11tIk3FpkWF0vBKdX05zKbwqXQW9LhreA5hErCKEsulUsQLamf+kF1D8fuKqa8Yb+yWQIfYS93cy39w=="
	],
	[
		"@deepseek-ai/dsh-fs-sandbox",
		"0.1.2-rc.1",
		"sha512-nnZnsOYLWrN2AnoB0qvQBLhh2VdU4A39AqOgWwsxnT3JrScGpvBcBMCt4fpLP9l5VjOY1qhIbLf6xd5p93C/6Q=="
	],
	[
		"@deepseek-ai/dsh-fs-observation-policy",
		"0.1.2-rc.1",
		"sha512-Uw3ErcPwQZUvXylLSf+CDjzfAza5ZVNOMkG4hIJjvgG4WBg3tqoCOY2OQk4O1DGTie4EzL4mHpAe5auwoV4JTw=="
	],
	[
		"@deepseek-ai/dsh-sandbox",
		"0.1.2-rc.1",
		"sha512-nTO350NlVo9cvKzbeILcPIRIk9ijidrv29snRjTOx7kP5aO/BI2b4KxsRCYoXg8WGAMbIkGbsmZKUD4qz7hyXQ=="
	],
	[
		"@deepseek-ai/dsh-sandbox-policy",
		"0.1.2-rc.1",
		"sha512-nLARL84X6K4DCUJsqRWINg3+1EVxsw70hbP+Yl92W/PsquQVs/UJQc55gnhYGmIMf6eJ0vQv39fziNSnAxdx5A=="
	],
	[
		"@deepseek-ai/dsh-user-approval",
		"0.1.2-rc.1",
		"sha512-oYkLE4a/TwqVNi299pUf/QP1Yku6KScdUCTUyYbjaRBcN+/pXPpHikl2aoE2thH9D0uT/Kj6T2kz+wDDcFd9Xg=="
	],
	[
		"@deepseek-ai/dsh-attachment",
		"0.1.2-rc.1",
		"sha512-QISKUjEITusLvAkqPLRn70xDUt+GjjY41pISjtPKYcZ4EGmayzhgZ3VJNYEcC+rbaF44hs2o/0VhOwHA7lyxjw=="
	],
	[
		"@deepseek-ai/dsh-system-prompt",
		"0.1.2-rc.1",
		"sha512-7W93PZKIk4CHvjZGgLIxrrEKpk+6t8nQXje1vKR5vG73dfXH0t1MJ5WWH/fngadYc7c6KzM84ihQ66tJqJqyNQ=="
	],
	[
		"dshmarket",
		"1.41.0",
		"sha512-uGhNo85g7i/+kVuFybPMjCOD1nn2ssATDSktm9Zd851qgRv39Gz8l+smpDtpBcfhlobAD3CG6l9caYkLHu4BFw=="
	]
].map(([name, version, integrity]) => ({
	name,
	version,
	integrity
}));

//#endregion
//#region src/domain/rc015-host.ts
/**
* Exact 33-row DSH 0.1.5-rc.1 core graph.
*
* Provenance: every row is the npm registry `dist.integrity` of the exact
* published tarball for the named version, read from
* `https://registry.npmjs.org/<name>/0.1.5-rc.1` (and `4.0.2` for
* `@deepseek-ai/cordis`, which is versioned independently of DSH). The single
* resolver for this graph is an isolated DSH installation plus the repository
* worktree lockfile, both installed from the public registry.
*
* This is a REGISTRY-DERIVED graph, not a natively audited one: the cohort
* carries `auditedPlatforms: []` until a native macOS/Windows host audit runs,
* and `auditProvenance: 'registry-derived-pending-native-audit'` is bound into
* the host-lock digest so a certificate can never claim a native pass this round
* did not produce. (`acceptedPlatforms` is the separate, wider gate: this cohort
* accepts evaluation on both platforms while claiming an audit on neither.)
* `dshmarket` is deliberately absent: market identity is verified independently
* by the action adapter and never participates in the core lock.
*
* The row-name set is unchanged from the historical 0.1.2-rc.1 cohort's 33
* core rows: no package entered or left the audited core graph, so a future
* reader must not infer a graph change from the version bump alone. The count
* is asserted from this list, never assumed.
*/
const RC015_HOST_PACKAGES = [
	[
		"@deepseek-ai/cordis",
		"4.0.2",
		"sha512-asOnXP1TzFSFQlHb1iegDZp0z/8WD1c7YNrwJR/Tx2bzNuMXfcekE/I67Iv6SQXeLB4csxqCngzQKANP7gdw0g=="
	],
	[
		"@deepseek-ai/dsh",
		"0.1.5-rc.1",
		"sha512-rmNmzQCg3oIc1z8xH7izRSOuy1TNzq+/NILyfM+7e8DKOyV+yBtg47WEsqR2SiIe1ATec3L/rUa1YhIcfQ2XEg=="
	],
	[
		"@deepseek-ai/dsh-agent",
		"0.1.5-rc.1",
		"sha512-obIPyTSjq1y0Yhasm3mLhK5BW6Ge0VQoRT8FBt0ooLsct2+pFAjgyd7GP3KzFaz7zaEhQJ/NNEmCaU0KOsYutg=="
	],
	[
		"@deepseek-ai/dsh-agent-loop",
		"0.1.5-rc.1",
		"sha512-FcpsiXMHR7M3UwZtC6CYzhmU9xhvbFuuEQisfUqW7c+G6oVhrX9kg8ytI50jXZempcdmVHZLyNeUcuDmgGtx7Q=="
	],
	[
		"@deepseek-ai/dsh-attachment",
		"0.1.5-rc.1",
		"sha512-uTBtB/LDlYgPI6i9Ac9jaK/bV1wN8cDTZBUkec80Yg3qMzW6K74wvBv5lPmoiXQgp4q3eOmDNEmodSS2ZxxVdg=="
	],
	[
		"@deepseek-ai/dsh-bash-sandbox",
		"0.1.5-rc.1",
		"sha512-mQ+/0Fo3LTIX+4k3m+P4y9e9IA6/BeNHrWW19U+Un4hBo5JtTwWhAaJN1nCdV6mG5tveXbIe2tpiv65GJdvt8w=="
	],
	[
		"@deepseek-ai/dsh-commands",
		"0.1.5-rc.1",
		"sha512-OMk0uVNbr2RdsItcIigp/2boGulqjei1uoQH3/DZYHB+aWWRXEYa6rk6vW3t82lnkd/6nvyQFV8eccQWZ2PQXQ=="
	],
	[
		"@deepseek-ai/dsh-fs",
		"0.1.5-rc.1",
		"sha512-F+loGiwsT09YpRONuFv0+bevEdfmbKBFjxxM8JkDOXpgwk1JXdGNSy7Kp4vXXVh3GcmYkd8VA7iB7NuVp51ytQ=="
	],
	[
		"@deepseek-ai/dsh-fs-local",
		"0.1.5-rc.1",
		"sha512-Qyqs9l+ZENq4PL7EwBpisvXcqJvCxGTrD/zH0Zj+S0eZee1kXrQjkY0gjW6dxAosGlLL7hZu0kdaD7TPxtKVcA=="
	],
	[
		"@deepseek-ai/dsh-fs-observation-policy",
		"0.1.5-rc.1",
		"sha512-TGu/2UrZS8KWr6x3sKLce7u0KoGrq5l+RK7ITd79n2WNzSCcAdzN5tsxUEo8JgfHij5S0QRgID0Q8DOx/6iQew=="
	],
	[
		"@deepseek-ai/dsh-fs-sandbox",
		"0.1.5-rc.1",
		"sha512-np+3EdQ86w609DwyaEUFGEHjSQ5i2NFypQxcM9sB+zX6DVSUR9sA2W/fmnStFJdsSzvgXYTCnJiBhlKnAXPf0g=="
	],
	[
		"@deepseek-ai/dsh-goal",
		"0.1.5-rc.1",
		"sha512-RF+cHqV0O7xkoqkhIst6NhMAwqXXAjTf7Z+H7FLHtZBvFAawU8zC7n7/tmS4P7rZYV+XYFYCDdNoI0GwPReCYA=="
	],
	[
		"@deepseek-ai/dsh-host-plugin-inventory",
		"0.1.5-rc.1",
		"sha512-xCOJ1nTW2s5etl18QhBBGpcOxiDfGxofe+4pd90/ZX+vW1vAhaHqyTYSRucOQVGyJb9zvdWCg7R3GcBYn6pUrQ=="
	],
	[
		"@deepseek-ai/dsh-host-webserver",
		"0.1.5-rc.1",
		"sha512-5kOu9kb0AuRN60/zwPTRcki801ozgnWAFwS1QtQ4ZNgCYIbAiU8gwJHY1//qEpUOuHS+26k+Tqq5/WCJmLGE6Q=="
	],
	[
		"@deepseek-ai/dsh-jobs",
		"0.1.5-rc.1",
		"sha512-0AWlZLcIpwdtV9A9fVeJ7b9jpXX0494fPL594gE/Kp1q9jHYyerIulrMHZa17kpu9W59cb1AJNPQy2xN6VDX7g=="
	],
	[
		"@deepseek-ai/dsh-jobs-local",
		"0.1.5-rc.1",
		"sha512-19sCxqUKduNO8E3YICSzOfajpBLPXbK/3p40GlxR6bGcOhxqhyH3TPdQS6UQjwNa5bUXHiW9GyB1xUWUUFGAJA=="
	],
	[
		"@deepseek-ai/dsh-llm",
		"0.1.5-rc.1",
		"sha512-KPKJFTNLjURphuF4NlS8DRK94CUYL/dKB8Hzg/22jtxAFO2paX3ifL0vhdPq9xPbcyplaF7LYlf0+3+pXFTnTg=="
	],
	[
		"@deepseek-ai/dsh-pwsh-sandbox",
		"0.1.5-rc.1",
		"sha512-QRD6PfcQuaRwUTn9EMIx15l1erRqk0erUamcAB3sxPyZOMWIFP7w2cp44Va8RGGDEUb9ZB1vRUH6cF4FAKSZRw=="
	],
	[
		"@deepseek-ai/dsh-sandbox",
		"0.1.5-rc.1",
		"sha512-xT+oTsSE7tRZVqqcj2qDZJARoK6A+Dmhf3CWPqlaFG/83Zh41kwcW2YWE4sA+vCt2pI2iqLYRw1SftSGawOtVQ=="
	],
	[
		"@deepseek-ai/dsh-sandbox-policy",
		"0.1.5-rc.1",
		"sha512-jLeny81NVsAiEWW8+MqmtkXJfu8CSFDPiuR8W4I/bZ7TNHrPTN7jPuk1/JlphkU4bq1N1a3iLvsDyHK+56ZLVA=="
	],
	[
		"@deepseek-ai/dsh-session",
		"0.1.5-rc.1",
		"sha512-0YBBrzkCbVEJolS/OpD0DZMSozmYxUTZopiG76MXInjOFBW9J4ca1a8WUjJjqelP1nJTmWGKXp92HcvNEny0Dg=="
	],
	[
		"@deepseek-ai/dsh-shell",
		"0.1.5-rc.1",
		"sha512-8V7iGmfsXDFMyftwQXemh1QLqcUysvy+bYWXr620/1B/sMn3oU8dhXvT8i4uD6VkMy2rds3XScUQ3XBl7ByMLA=="
	],
	[
		"@deepseek-ai/dsh-shell-env",
		"0.1.5-rc.1",
		"sha512-OO4AmGqqHUWRPK1PSroO/TJG3rNwoAgIMx56S3aiM7v4cUtNmUtMQ71lv9kOezcW+2VlHxfup5jhzpYIQAIiSw=="
	],
	[
		"@deepseek-ai/dsh-subprocess-local",
		"0.1.5-rc.1",
		"sha512-TKcqaIf1fJzjraXhwmSAQAqkPMvIjS0Y7b9fC4n7+G8eQpb3gaF/eJXn6Tx4OgFSDV5R/NLUqHaU/ogxTjdWhQ=="
	],
	[
		"@deepseek-ai/dsh-system-prompt",
		"0.1.5-rc.1",
		"sha512-RAdO9biQoga1vAVTQY9J7THexiOE1FOd1Nli021MQt+Zf73c83BSd2DwXb0WDilLaMeSxZPaIRRqoXpJlpmLIA=="
	],
	[
		"@deepseek-ai/dsh-tool-bash",
		"0.1.5-rc.1",
		"sha512-BfZ4R40I7AJFcjHgMkzh3unrp5S7mZT+szUUz4tkbMrAkgHfOdkIHhQ/BTgxWBuFzD18OfAMJ/RnegrBCFVKWw=="
	],
	[
		"@deepseek-ai/dsh-tool-fs",
		"0.1.5-rc.1",
		"sha512-BWLWJCJxCECFHmS8gHbnyNJlSTG+KVbVMz73Qduoo+ABeDvWj6cFVXTewAUA9jFEIS3xzJcNilsV1g5DGaEnPw=="
	],
	[
		"@deepseek-ai/dsh-tool-goal",
		"0.1.5-rc.1",
		"sha512-5NCniCOoCeXYXMZNPCmGlrOYIGjnGddTJVOCXNqqAcwxtOxHAoEHTtphaohIa/4Vy7mmRIHgO1KUii443ky1Bw=="
	],
	[
		"@deepseek-ai/dsh-tool-jobs",
		"0.1.5-rc.1",
		"sha512-SIgxnjQHl6KE+kpt7VjYCI3aw5DCeztCKGxuJzpLdqJkSoVtewp1Ofz0/Pg1R4DIIaGR8unRyqpZH8qf8uIpzA=="
	],
	[
		"@deepseek-ai/dsh-tool-pwsh",
		"0.1.5-rc.1",
		"sha512-UmWePfsJIUfFVj2UFyh8wacqxSXYrABGoBHXWjYFlfqpXt7rfJL31rOl8N1+uYypAVCxe4O2IquuJxfYAVhBLA=="
	],
	[
		"@deepseek-ai/dsh-tools",
		"0.1.5-rc.1",
		"sha512-I5AUxKTqUrC0nvRO4UcpU+f65P+nKs5BUrS2nqZehhFZ2rVxhUAJ7YdORcY6pVkBTB15nPr5gK0WPgwyfS217w=="
	],
	[
		"@deepseek-ai/dsh-user-approval",
		"0.1.5-rc.1",
		"sha512-fSxEBvHQnozIh5HV31t2BNodYzyv7iE2srna7p5k0Y/3R9c6DdoZyQZ9momcN9gloraq8HK5+cvrYHzgc4LYPQ=="
	],
	[
		"@deepseek-ai/dsh-web-app",
		"0.1.5-rc.1",
		"sha512-9V2GPqEs0A+LFJVVPt7FQK//U8oM9S0TDhl6MqO7zQftimfnH8ruQZkEZXg9zXXEWULCW0vY1DtsPjvMepA8Mw=="
	]
].map(([name, version, integrity]) => ({
	name,
	version,
	integrity
}));

//#endregion
//#region src/domain/rc015-rc2-host.ts
/** Exact npm registry identities for DSH 0.1.5-rc.2 (Cordis 4.0.2).
* Native acceptance is recorded separately; these rows are registry-derived.
*/
const RC015_RC2_HOST_PACKAGES = [
	{
		"name": "@deepseek-ai/cordis",
		"version": "4.0.2",
		"integrity": "sha512-asOnXP1TzFSFQlHb1iegDZp0z/8WD1c7YNrwJR/Tx2bzNuMXfcekE/I67Iv6SQXeLB4csxqCngzQKANP7gdw0g=="
	},
	{
		"name": "@deepseek-ai/dsh",
		"version": "0.1.5-rc.2",
		"integrity": "sha512-8Xc8hCQHcIWRmTCVU/xZdp6/qMsWMeAd2ObChKDEsfhUPJFXx6H0lgeb1DxUMD86HZrrVN+1bCvn1ppjZ/fOxw=="
	},
	{
		"name": "@deepseek-ai/dsh-agent",
		"version": "0.1.5-rc.2",
		"integrity": "sha512-SlUL1riZmVLwMUR3jo9CP/R1cxov9dHkCJDh6JQW3fSZJVCIdPygBRlAweCUDvHxAEmPpFHxE/U3NmSUbX+vQQ=="
	},
	{
		"name": "@deepseek-ai/dsh-agent-loop",
		"version": "0.1.5-rc.2",
		"integrity": "sha512-24wvqVlqFmdqJ2Bhcku/vKeNy+qWSmeEeN7lvcUB+WkhcF0/Ra2G3WwcVmnahJA4+w0AKdW3W7v+YYcO/jKJpg=="
	},
	{
		"name": "@deepseek-ai/dsh-attachment",
		"version": "0.1.5-rc.2",
		"integrity": "sha512-S6b8/WjqzGw+dMDLRXnq+tbijDGkQh38yE+zpQytX2/w/mPR3VzGj5r6McS01WwD76vXR8WFoheSCLyCAro8WQ=="
	},
	{
		"name": "@deepseek-ai/dsh-bash-sandbox",
		"version": "0.1.5-rc.2",
		"integrity": "sha512-y8vwK6jf4gPq8mG71zWure803NjfqJ66Nvzr1FTB8An+IF68hT2eU+hHJCByvP0u6FuiLPRptuX/im2CxcNo1g=="
	},
	{
		"name": "@deepseek-ai/dsh-commands",
		"version": "0.1.5-rc.2",
		"integrity": "sha512-ODc9h2Jig+Lo4XLdxqHpHjSXsBFeUCth6Y/rToor4KVRWQMedUARlq5otPyB1lYHyQh2DonNs2uf7g3mvag57A=="
	},
	{
		"name": "@deepseek-ai/dsh-fs",
		"version": "0.1.5-rc.2",
		"integrity": "sha512-6DHTquXPbpYdykGayqYaXSI9t668tDCoswH/bDezV+nwj4LxjrfY/smEtgp7nC4ubyoKf1hmjpNfUonGC9e7aA=="
	},
	{
		"name": "@deepseek-ai/dsh-fs-local",
		"version": "0.1.5-rc.2",
		"integrity": "sha512-akUTz9D/N0ruSOzytZ8SZ330SdzG75fd7DzHsJ7KJzSif/QM0Y+RpOmGMnjlJzit4HDV2A4Etn80wSzstyp82A=="
	},
	{
		"name": "@deepseek-ai/dsh-fs-observation-policy",
		"version": "0.1.5-rc.2",
		"integrity": "sha512-AntY5dfkTL8WugNGHkJxCEffaTFHqdXaYm7ZrerexnLiZQscDRRjf9zI00JwOmlFM/IrioCuLf5cERfhZN5GYw=="
	},
	{
		"name": "@deepseek-ai/dsh-fs-sandbox",
		"version": "0.1.5-rc.2",
		"integrity": "sha512-eUxNsnM+TsjGw5OleOIcAhMnFhmQ4OAZoBYeiRMSeOMuCKWEjhxUGN8S8Hg1HxPaZVeIrUV7qFsNQzhehKj7wg=="
	},
	{
		"name": "@deepseek-ai/dsh-goal",
		"version": "0.1.5-rc.2",
		"integrity": "sha512-atFJaoijwAz5yZ119f82I7jMx3tGCwXOz6qoY0Likb2c5DpumWZTJgs5L19OhKbhvEW+r2MAC4MYKaUxtrbb0Q=="
	},
	{
		"name": "@deepseek-ai/dsh-host-plugin-inventory",
		"version": "0.1.5-rc.2",
		"integrity": "sha512-U7RTRLRs+O18ru6KzUy7LvMk/IgXnkWSalogg0abfA+QU020XZi+UpwZqM567RzC7MtpxijQk8bulGunu0lifw=="
	},
	{
		"name": "@deepseek-ai/dsh-host-webserver",
		"version": "0.1.5-rc.2",
		"integrity": "sha512-lFgGm9wDrHiTBANzsdoWzdfPSjWYuDFwCoNQ4Uko57Fo5XASL2unfRHGm1xZ828rwEYuGwRvJHMOuoP/17VmlA=="
	},
	{
		"name": "@deepseek-ai/dsh-jobs",
		"version": "0.1.5-rc.2",
		"integrity": "sha512-C3rBEuWhtDBlxMeKykFvSfBwjSPxkLsvKCFq8BrFdjDmZC1lI9GooMjPZkPxXVbogVrcOBaYVtJdOYJ4+rIpQg=="
	},
	{
		"name": "@deepseek-ai/dsh-jobs-local",
		"version": "0.1.5-rc.2",
		"integrity": "sha512-PCDLSktONJ+If3QCcPlRskVLXIa8hG/l0pBIgKNllz4mb7CmYlJ5w1H9pWyrFZllMO0Wm94ZS9aP3SnUcJ8R1g=="
	},
	{
		"name": "@deepseek-ai/dsh-llm",
		"version": "0.1.5-rc.2",
		"integrity": "sha512-Z7BVsBkK24SE4EItQeow8PHms/9GP0DSTi337vTAa/RY7tNg2Snz3INcXUj6CPZfvntQr1in9op9wLI+rfNsqA=="
	},
	{
		"name": "@deepseek-ai/dsh-pwsh-sandbox",
		"version": "0.1.5-rc.2",
		"integrity": "sha512-AYTAiy8wQwVoHO47e+hnG73GvHdmg+bKy3bFnrPDANCqnRZh9TJIbkxHxtJnfpBnNCcs2fhhCo6yHtGFYl7KHg=="
	},
	{
		"name": "@deepseek-ai/dsh-sandbox",
		"version": "0.1.5-rc.2",
		"integrity": "sha512-OTOR6Jj9cey5YkhALG0TBwZ/Z3t986aczH6fLbzoIIegix+gwNaEBOqCWs+exVJ0Z2QuN/ItXzn+xHxW8Y0dcA=="
	},
	{
		"name": "@deepseek-ai/dsh-sandbox-policy",
		"version": "0.1.5-rc.2",
		"integrity": "sha512-QyQSCyLFxljkvmsVWJG0xUrYTiXr1DVOxHWURf7EHnbmvYZgg2B+nFcI58+IeUB2qbB35B1ClW5NQsKjOgDm2g=="
	},
	{
		"name": "@deepseek-ai/dsh-session",
		"version": "0.1.5-rc.2",
		"integrity": "sha512-y+klWiGAWR4m4cc4ylurA0cW63673B4N8cr2ANMimweDZAfxL4XVBC7WiD/5DT2DtIhYmVZhz/niyS/WbniUTA=="
	},
	{
		"name": "@deepseek-ai/dsh-shell",
		"version": "0.1.5-rc.2",
		"integrity": "sha512-BfmNN6X0NHN2XleW0fCbtFXedXEppeDQ2oa3WsOTuhvnBftl6QWMWWMM59weE4xXker5fzqOnoJdeBR8D9qR9Q=="
	},
	{
		"name": "@deepseek-ai/dsh-shell-env",
		"version": "0.1.5-rc.2",
		"integrity": "sha512-fFSrfhxfvVYfDxsOuV0cjAeC/PWweW+86uOJWT+2paHXOSgM6MSDe3eTd5DHRDYnjb5XutTYu32pR49cVBHMug=="
	},
	{
		"name": "@deepseek-ai/dsh-subprocess-local",
		"version": "0.1.5-rc.2",
		"integrity": "sha512-DmG3lcQlAh8bTKfeyYM44cfRyJktbLL8drXrVfOvGrFk0zSs5eTSLcfhIKLT3jFJ5CKFriHYZPLdRT6Alvyy4w=="
	},
	{
		"name": "@deepseek-ai/dsh-system-prompt",
		"version": "0.1.5-rc.2",
		"integrity": "sha512-VtmZVKqBMJ7kzskHu0jY+Jth7jSuKMG8QB3MBPzJe9M0LL4YPMWsGKt9gGky9RXolk/ugAy4YZEv1gUqouVofA=="
	},
	{
		"name": "@deepseek-ai/dsh-tool-bash",
		"version": "0.1.5-rc.2",
		"integrity": "sha512-f4LmiZkZSfJfvBcEzV4q5J83VL79l/+ncLkwnJyHzsjvJbW5qFxzCy4p5FXfY/CflG0taG14/p42UJzb9qEhrQ=="
	},
	{
		"name": "@deepseek-ai/dsh-tool-fs",
		"version": "0.1.5-rc.2",
		"integrity": "sha512-/3AUx+V1UxVfl24fm10hwRbJnHwpBkRDHniOeocGknMvASheRiKnHpnnj9EszFRLYSpe2PRFSMuyuhXgYyd3MQ=="
	},
	{
		"name": "@deepseek-ai/dsh-tool-goal",
		"version": "0.1.5-rc.2",
		"integrity": "sha512-nZ0NkUxvtAsrPAd9NMXt+4kS7WPn8xIvXCwVunKfBwbrnGnFCNmIsTQoHF44J6q9VbMeSCN2eyj07w6ej3Hf+g=="
	},
	{
		"name": "@deepseek-ai/dsh-tool-jobs",
		"version": "0.1.5-rc.2",
		"integrity": "sha512-v4y56H3FsVBF2jUJLGLHdPeKaKJxLT4Zx/oii45UmJv5t8Bp3uCTVUoq/mfSFVuFY66q6rHJwgIOKWc4ZO3ySw=="
	},
	{
		"name": "@deepseek-ai/dsh-tool-pwsh",
		"version": "0.1.5-rc.2",
		"integrity": "sha512-rnHM3Jqlr7rthwfPYysXPq6zH+K8JTDqbE+xzjkbo1WIBKBZeSGr8kPjqdCZa7eUtWhmV/RFBP1qmBgDjEZaWg=="
	},
	{
		"name": "@deepseek-ai/dsh-tools",
		"version": "0.1.5-rc.2",
		"integrity": "sha512-k2yZuJJtszaU9lzr2aBtdeFMINrkdlk4ellbtrMokA2oySVqJmAM8dv+u9RtzduD3aRRqyr2i2hWrTACz0qOrA=="
	},
	{
		"name": "@deepseek-ai/dsh-user-approval",
		"version": "0.1.5-rc.2",
		"integrity": "sha512-8UpMEnEyMo6mYEVELBo0DC2iG7aJJfFMTNkU+DKD3c5Ut7ySRDzt1iRr1qni/CzqlTIpQBAkGaG77qk4q/v1bg=="
	},
	{
		"name": "@deepseek-ai/dsh-web-app",
		"version": "0.1.5-rc.2",
		"integrity": "sha512-Ng7YVDt9txh2BlLmu6B+V677c1bihbh/rq3EOtZK4b0JWtgdNgYb1KPIED8+aK2i+FghrCrIy6X60AyJ45eOvw=="
	}
];

//#endregion
//#region src/domain/host-version.ts
/**
* DSH host version support policy.
*
* Context Guard 0.5.2 supports exactly the two registered DSH host releases:
* `0.1.5-rc.2` (latest) and `0.1.5-rc.1` (verified minimum). Package discovery,
* npm installation, and the exported support range use the same newest-first
* exact union, so an unregistered stable or future prerelease is never advertised
* merely because it sorts above the minimum.
*
* The minimum comparison remains a diagnostic layer for distinguishing an old
* host from an at-or-above-floor but unregistered host. It never substitutes for
* the exact support set or the complete 33-package host graph.
*/
/** Lowest supported DSH host version. DSH packages version independently of Cordis. */
const MIN_SUPPORTED_HOST_VERSION = "0.1.5-rc.1";
/** Latest DSH release with a registered complete host graph. */
const LATEST_SUPPORTED_HOST_VERSION = "0.1.5-rc.2";
/** Exact endpoints supported by the current release, newest first. */
const SUPPORTED_HOST_VERSIONS = [LATEST_SUPPORTED_HOST_VERSION, MIN_SUPPORTED_HOST_VERSION];
/** Exact npm range shared by package discovery and peer dependency declarations. */
const SUPPORTED_HOST_RANGE = SUPPORTED_HOST_VERSIONS.join(" || ");
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
function parseHostVersion(value) {
	const match = VERSION_PATTERN.exec(value.trim());
	if (!match) return void 0;
	const parts = [
		match[1],
		match[2],
		match[3]
	].map(Number);
	if (parts.some((part) => !Number.isSafeInteger(part) || part < 0)) return void 0;
	const prerelease = match[4] ? match[4].split(".") : [];
	if (prerelease.some((identifier) => identifier.length === 0)) return void 0;
	return {
		major: parts[0],
		minor: parts[1],
		patch: parts[2],
		prerelease
	};
}
function comparePrerelease(a, b) {
	if (a.length === 0 && b.length === 0) return 0;
	if (a.length === 0) return 1;
	if (b.length === 0) return -1;
	const length = Math.max(a.length, b.length);
	for (let index = 0; index < length; index += 1) {
		const left = a[index];
		const right = b[index];
		if (left === void 0) return -1;
		if (right === void 0) return 1;
		const leftNumeric = /^\d+$/.test(left);
		const rightNumeric = /^\d+$/.test(right);
		if (leftNumeric && rightNumeric) {
			const difference = Number(left) - Number(right);
			if (difference !== 0) return difference < 0 ? -1 : 1;
			continue;
		}
		if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
		if (left !== right) return left < right ? -1 : 1;
	}
	return 0;
}
/**
* SemVer precedence comparison, including the prerelease rules. Returns
* `undefined` for a value that is not a version this module can order, so an
* unparseable host version fails closed rather than sorting as "newer".
*/
function compareHostVersions(a, b) {
	const left = parseHostVersion(a);
	const right = parseHostVersion(b);
	if (!left || !right) return void 0;
	if (left.major !== right.major) return left.major < right.major ? -1 : 1;
	if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
	if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
	return comparePrerelease(left.prerelease, right.prerelease);
}
/** Decide the version-policy half of host support. Never a substitute for the graph lock. */
function evaluateMinimumHostVersion(version, minimum = MIN_SUPPORTED_HOST_VERSION) {
	const comparison = compareHostVersions(version, minimum);
	if (comparison === void 0) return {
		status: "unparseable",
		version,
		minimum,
		reasonCode: "host_version_unparseable"
	};
	return comparison < 0 ? {
		status: "below_minimum",
		version,
		minimum,
		reasonCode: "host_version_below_minimum"
	} : {
		status: "supported",
		version,
		minimum,
		reasonCode: "host_version_supported"
	};
}
/** Whether npm's exact public support union admits this host version. */
function satisfiesSupportedHostRange(version) {
	const normalized = version.trim();
	if (!parseHostVersion(normalized)) return false;
	return SUPPORTED_HOST_VERSIONS.some((supported) => compareHostVersions(normalized, supported) === 0);
}

//#endregion
//#region src/domain/host-lock.ts
/**
* Capability expectations shared by every registered cohort.
*
* Every row is a host contract Guard actually consumes, re-checked against the
* 0.1.5-rc.1 package surfaces: `ctx.sessions.flush()` still returns whether a
* durability listener participated; `tools.guard()` is still a monotonic
* post-policy denial; the Goal service still exposes `get`/`disarm` with a
* disarming `pause`; the `update_goal` tool is still the pinned pre-commit gate;
* `ctx.jobs.get()` still yields the `dsh.jobs.v1` status vocabulary; and
* `dsh-tool-fs` still registers `read`/`write`/`edit` with the same parameter
* and result contract (`dsh.fs-tools.v1`).
*
* What is NOT a row, because it changed rather than stayed compatible: the
* Session event API and vocabulary. Guard 0.5.1 supports only V3
* `snapshotEvents()` and refuses a session that does not expose it, so a V2
* host is rejected by the cohort's exact package rows before any capability row
* is consulted.
*/
const AUDITED_CAPABILITY_ROWS = [
	{
		name: "goal_complete_precommit_guard",
		value: {
			k: "s",
			v: "required"
		}
	},
	{
		name: "goal_disarm_readback",
		value: {
			k: "s",
			v: "required"
		}
	},
	{
		name: "session_flush_before_control",
		value: {
			k: "s",
			v: "required"
		}
	},
	{
		name: "tool_guard_monotonic",
		value: {
			k: "s",
			v: "required"
		}
	},
	{
		name: "host_capability_model",
		value: {
			k: "s",
			v: "action-platform-v1"
		}
	},
	{
		name: "external_wait_jobs_readback",
		value: {
			k: "s",
			v: "dsh.jobs.v1"
		}
	},
	{
		name: "filesystem_tool_contract",
		value: {
			k: "s",
			v: "dsh.fs-tools.v1"
		}
	},
	...SEMANTIC_ACTIONS.map((action) => ({
		name: "supported_action",
		value: {
			k: "s",
			v: action
		}
	}))
];
function defineCohort(id, supportedGoalVersions, auditedPlatforms, packages, auditProvenance = "native-audited", acceptedPlatforms = auditedPlatforms) {
	return {
		id,
		manifestVersion: 1,
		supportedGoalVersions,
		auditedPlatforms,
		acceptedPlatforms,
		auditProvenance,
		packages,
		capabilities: [
			{
				name: "host_cohort",
				value: {
					k: "s",
					v: id
				}
			},
			{
				name: "host_audit_provenance",
				value: {
					k: "s",
					v: auditProvenance
				}
			},
			...AUDITED_CAPABILITY_ROWS
		]
	};
}
/**
* alpha.2 audited package identities (second registry cohort), hoisted so the
* alpha.2 + dshmarket 1.39.0 cohort can reuse the exact natively audited rows
* with only the dshmarket identity substituted.
*/
const ALPHA2_HOST_PACKAGES = [
	{
		name: "@deepseek-ai/cordis",
		version: "4.0.2",
		integrity: "sha512-asOnXP1TzFSFQlHb1iegDZp0z/8WD1c7YNrwJR/Tx2bzNuMXfcekE/I67Iv6SQXeLB4csxqCngzQKANP7gdw0g=="
	},
	{
		name: "@deepseek-ai/dsh",
		version: "0.1.2-alpha.2",
		integrity: "sha512-4TvTC5kRKlgtSU2UTBv+cID9a2Z+6+m6mpvjXWJfVzuTkflCff6s4MsQpFJTCmwFh/k7zNWe7qFXcLYMV/5VvA=="
	},
	{
		name: "@deepseek-ai/dsh-agent",
		version: "0.1.2-alpha.2",
		integrity: "sha512-K7B5XSQ7byB/IoNGj7n+lBgHCpVPJqEPvpGoHKc1dBS8fPo2yYp/ALFag4YOfrXVP3jQ9A8di20BbvIlp79SoA=="
	},
	{
		name: "@deepseek-ai/dsh-agent-loop",
		version: "0.1.2-alpha.2",
		integrity: "sha512-UU1i+rTuQV3Q5PGY4qFlojJ0Gbthib22pida5elZlg28dd8gtY2d1U5V9q2+rKK/469CO29rkz6TWMWk0g93Jg=="
	},
	{
		name: "@deepseek-ai/dsh-attachment",
		version: "0.1.2-alpha.2",
		integrity: "sha512-+e+zQCbBi94Jnyfpq/M+/J2R/66GbMh5zqr7yVdCjvAJp8d2hxQsZ0O/oaSV+iZQIMgJz+BcwvrS1VU+XmzQWg=="
	},
	{
		name: "@deepseek-ai/dsh-bash-sandbox",
		version: "0.1.2-alpha.2",
		integrity: "sha512-y5NZT7OkKi23N2fF+x9oo1QZH8LPfTU+llL86r+iETSSk5jzh91Hp2cP5Iq5S/L3BAQDaEw2J4Dg8VjF+fnnkg=="
	},
	{
		name: "@deepseek-ai/dsh-commands",
		version: "0.1.2-alpha.2",
		integrity: "sha512-KkyNkD5V80h+xXsByGdXH8uvKo/5uflb1CSY8O8IrciuptaJdneSAmTFsjmCKAjqCTGgigk2VDw6mqPwux2JYg=="
	},
	{
		name: "@deepseek-ai/dsh-fs",
		version: "0.1.2-alpha.2",
		integrity: "sha512-wx5n0QS5rfZ2LPVocMNfuOUh0RYH/QuLoCEy+qI8U3nKmSZ8GSTASURLg+0pVxckHpLElo38U+S/lkLxRK1rpQ=="
	},
	{
		name: "@deepseek-ai/dsh-fs-local",
		version: "0.1.2-alpha.2",
		integrity: "sha512-IIpZAxGw8wr+xpZQhvuHB9JtUeE6V03e45njfFah1eRl0miaHV5CxCRlFwkMLrow5I2zCCsCPPmdEaouGxTGSA=="
	},
	{
		name: "@deepseek-ai/dsh-fs-observation-policy",
		version: "0.1.2-alpha.2",
		integrity: "sha512-oMDSB1NTnj4rIGy5JXCtbzTFDwKkU/38KIKrVs3u6b65Y5spq3kjc1ITpjqo3Ze4H8umc8wJqGke2o/ms8eIEQ=="
	},
	{
		name: "@deepseek-ai/dsh-fs-sandbox",
		version: "0.1.2-alpha.2",
		integrity: "sha512-jTnGZUov95e9OANKG+uoWAczdGlzy24aXJ+z4N4J+rMvThfj5awV3ucsmX9S4YW2peHoTV9D7BNGgBQ84LxB+w=="
	},
	{
		name: "@deepseek-ai/dsh-goal",
		version: "0.1.2-alpha.2",
		integrity: "sha512-6E+QfBezGsQ2RI0KLZc8llRpukV9ujLjCcQ2UAboYJS7FPQMs7f/QfSrfTubwpB4lrnOok0H26JT2jHUhJeQbQ=="
	},
	{
		name: "@deepseek-ai/dsh-host-plugin-inventory",
		version: "0.1.2-alpha.2",
		integrity: "sha512-qWD+fTYTq8YoNa1TbYXy/Qk7bjjS4URJMgMa3m1vnyZ+xdwtRBF47dUa7wVAVX7oGg03bl7TD1Eo7GcKP/eajA=="
	},
	{
		name: "@deepseek-ai/dsh-host-webserver",
		version: "0.1.2-alpha.2",
		integrity: "sha512-cvsfM/cm5hZk/RqdIsardfqBIVpemdmUrP4M6UgdqhJy2nG5VnokLBg7k0bc8Yi11q0vIETfQK4xiDOSOMnu7Q=="
	},
	{
		name: "@deepseek-ai/dsh-jobs",
		version: "0.1.2-alpha.2",
		integrity: "sha512-yPNlYX/ZKphjzRY7oMf5uLgfSlJ8qBp49W6qNqzhmn8moXgJcPUCNqeOkT0C3a6GQ286mmmo09eyfDLGX7+lMQ=="
	},
	{
		name: "@deepseek-ai/dsh-jobs-local",
		version: "0.1.2-alpha.2",
		integrity: "sha512-nrK4ujL6QRS6GAysgBR08vaHub4vh7/iuGtmMvcg4Bp3hZeQ4rjWnpQAuItg9E9G3OUrvfjwzwENEM1TyVcbWw=="
	},
	{
		name: "@deepseek-ai/dsh-llm",
		version: "0.1.2-alpha.2",
		integrity: "sha512-ip6yMxwHugxQm4VCbwX/FDnlTeeBM9VBkIn0+74ityQy7Z3yKREJ1Ov8Z04l4G3duRzeGRsQ4ztOFZ01oNfKIw=="
	},
	{
		name: "@deepseek-ai/dsh-pwsh-sandbox",
		version: "0.1.2-alpha.2",
		integrity: "sha512-j/gUmv+nWYzg8o+oEEIK9FKeb6L24n2u7xjpIm7DcL5YjQlRDR6FgDvR2hpUK/d4Wk+zvnaPqZaEaXfUtOzEKQ=="
	},
	{
		name: "@deepseek-ai/dsh-sandbox",
		version: "0.1.2-alpha.2",
		integrity: "sha512-InfHYn5B0MxF5QLz0AjbwPS5W0G9VtIvjEFl5o/049KzH6khGKhjqOAVZtu1Z46f1+K/dbjF50VkTdnX3pgIJA=="
	},
	{
		name: "@deepseek-ai/dsh-sandbox-policy",
		version: "0.1.2-alpha.2",
		integrity: "sha512-Af7DWZTEjF/70YWSiN0jfbZli1XRk6Bo9W61QHxfShS79I8//mOPrItEPtJRWL/RCmGNfudFglNFyyGKdaqBIg=="
	},
	{
		name: "@deepseek-ai/dsh-session",
		version: "0.1.2-alpha.2",
		integrity: "sha512-RfikXscYTDXDr7CD7C/8oGJZaH8Egclj7pmXRtd90QcB5L8RIQ7069xrHZjds8OjNrFo69qQwNK3gYLUVZy9PA=="
	},
	{
		name: "@deepseek-ai/dsh-shell",
		version: "0.1.2-alpha.2",
		integrity: "sha512-i16e+OrCJ7GZ1XDnPds081NgVs/xzIVMLECzmLnXgVDKeePgWpdEgR//PgMqKPwoBoJ8z7DTzwKiOISAtOpNzA=="
	},
	{
		name: "@deepseek-ai/dsh-shell-env",
		version: "0.1.2-alpha.2",
		integrity: "sha512-OCf1iaPC5Qg6/DMLzvq5flGVSKP2uxAhgKs+8vrRuUiKc2UXXUE4uKayzZU7S18EysLZOVjMKKyUnHFXCVRQxg=="
	},
	{
		name: "@deepseek-ai/dsh-subprocess-local",
		version: "0.1.2-alpha.2",
		integrity: "sha512-IFneyTRqvbF/1Jm9h0WwBBxwlAd3vRh3SE/sZo2DTy9lzkRUMEBmWTiJZhVCMZ7hDLE0ALnjLLnLFLkA7bCP9Q=="
	},
	{
		name: "@deepseek-ai/dsh-system-prompt",
		version: "0.1.2-alpha.2",
		integrity: "sha512-qT9PZEVMAbszsg1UVUvuovfWFS5unjy08KV0rnOc89TJCgkb2CnlknSyIQs0lXc/UiqT6ZQ59i4ClAFrXhxfxQ=="
	},
	{
		name: "@deepseek-ai/dsh-tool-bash",
		version: "0.1.2-alpha.2",
		integrity: "sha512-Vt70FCPSE3Y7++2i9dKCNrsXTqhDpeJwqo44/GZow1xJ5acY9iNkjmjfq0UrTvacLLOEVnrMMBa9LojXi2WZUA=="
	},
	{
		name: "@deepseek-ai/dsh-tool-fs",
		version: "0.1.2-alpha.2",
		integrity: "sha512-zQ+zxunJ9BXFR/kAw0Z/LO5TEy87uf1X2giE1AmM9fqbev28vd4pzLq3y8F9b0E64461ANrfD1q2wx8Gy1w47g=="
	},
	{
		name: "@deepseek-ai/dsh-tool-goal",
		version: "0.1.2-alpha.2",
		integrity: "sha512-lvp60s3JKuTzncrlKCyS3qM/jYMLZSTMXJ/xQ8A0EIDvfPp7x1C3NNez66IJXPJ5YMtW9QYsqx2YmnUKhPOrow=="
	},
	{
		name: "@deepseek-ai/dsh-tool-jobs",
		version: "0.1.2-alpha.2",
		integrity: "sha512-QYq4almnoKNDu/ncrpGLTfkT5sIdqvRTyLd61VNJTFl4rNT2G/JCoEIhDgf50Rkwcchvvk/bNNdekjlENqZjKg=="
	},
	{
		name: "@deepseek-ai/dsh-tool-pwsh",
		version: "0.1.2-alpha.2",
		integrity: "sha512-sRGAmLWxxb+gglsqoftLojnFY1HaKMcwV9itkvv7JeACn5vkZuXTI0I/gNxjvt+g/b6sXT37hmQ7bmyo3dFHuQ=="
	},
	{
		name: "@deepseek-ai/dsh-tools",
		version: "0.1.2-alpha.2",
		integrity: "sha512-trk0fkmCDp64pqdcr8u7rCcRrwNi+93FKuznTnCD+YsPGFygcSG/6n+Wsh4+9A6oI1fM4/Ecq6Baa9vq1sNhJg=="
	},
	{
		name: "@deepseek-ai/dsh-user-approval",
		version: "0.1.2-alpha.2",
		integrity: "sha512-CcV3hf2Q0NYxRbnlE+IysaUkq/hvmjlvS9OGiHpARZVY4VlidlZRmsy5g5L17vDoxirX+WBJ9Cc5VcJMcjPrUg=="
	},
	{
		name: "@deepseek-ai/dsh-web-app",
		version: "0.1.2-alpha.2",
		integrity: "sha512-+SKilM9fCCCoYr3fKT7CxNiozGsNHgvvTGhL63tKXM7/3M96dyj7zhT5ztoTgIDW9b9m8J/CaJUa4KlSeUJGFQ=="
	},
	{
		name: "dshmarket",
		version: "1.38.1",
		integrity: "sha512-Z9VleLtCXwk5OlbSJKayWtbMaKACL8JUMyb/JHpErS4N3q//GJS+cgOhhxNkZYmXxB8/lv9IbhX1CBzlMhJeJg=="
	}
];
/**
* The exact graph the Windows daily runtime realized when it upgraded
* dshmarket to 1.39.0 on an otherwise alpha.2 install — the combination whose
* rejection was Guard 0.3.2's real web_control failure. It is one audited
* whole-graph cohort: alpha.2 rows keep their native macOS/Windows audit
* identities and the dshmarket 1.39.0 identity is the authoritative row from
* the 2026-09-01 alpha.3 annex audit. Guard 0.4.0 supports this combination.
*/
const ALPHA2_DSHMARKET_139_HOST_PACKAGES = ALPHA2_HOST_PACKAGES.map((row) => row.name === "dshmarket" ? {
	name: "dshmarket",
	version: "1.39.0",
	integrity: ALPHA3_HOST_PACKAGES.find((entry) => entry.name === "dshmarket").integrity
} : row);
/**
* Historical audited host cohort registry. Every entry keeps the exact package
* identities audited natively for a past Guard release (CG-DSH-001 whole-graph
* contracts). These are historical verification facts only: since 0.5.1 the
* active support targets are `0.1.5-rc.1` and `0.1.5-rc.2`, so an installed graph from any of
* these cohorts — including previous RCs and alphas — is no longer an active
* support entry and fails closed in `evaluateHostLock`.
*/
const LEGACY_HOST_COHORTS = [
	defineCohort("dsh-0.1.1-rc.2", ["0.1.1-rc.2"], ["posix", "windows"], [
		{
			name: "@deepseek-ai/cordis",
			version: "4.0.1",
			integrity: "sha512-YBdskTU2Po1kru3GgcUWUbkTsPMA9LkSQDAY8rBkFJeajdgcQad3QPJZE26JyK99Xb6HaASvoXg2DSUTeN/0Nw=="
		},
		{
			name: "@deepseek-ai/dsh-agent",
			version: "0.1.1-rc.2",
			integrity: "sha512-cC7lnJe7JgPFcreNXxcxLMxQd78LnpVO9ZXROjZsGRQN1zGH6i/DduI892F1am85IfzzO+XTxMwwUHmfwamb0g=="
		},
		{
			name: "@deepseek-ai/dsh-commands",
			version: "0.1.1-rc.2",
			integrity: "sha512-BOIe4Sht9rmMv1a6b3GWjWBbeWr7PtHlAy41vgpaymvUUuzOapOIA648ZMGCI/crRIt72Umev2FHtSwCNSbYZg=="
		},
		{
			name: "@deepseek-ai/dsh-goal",
			version: "0.1.1-rc.2",
			integrity: "sha512-lSHTh4vfS6eRb9to/y+bjRf2+0QkNpY3tHJ29HMTewR9fJYZsEVVu4Hc+GPhPEjF7RpiD35/sKx+akijtDasyg=="
		},
		{
			name: "@deepseek-ai/dsh-llm",
			version: "0.1.1-rc.2",
			integrity: "sha512-ASJfjIdZbIXvLwi3rGo+eZb/GxMVV/WO5/XVD3B96mT8EIzrlw3+nMR6/CvmJVzcycKQ2XN0wj7jD6TasPRySA=="
		},
		{
			name: "@deepseek-ai/dsh-session",
			version: "0.1.1-rc.2",
			integrity: "sha512-4/cv6X9HPhm47eyRhCu/WZwzrtJKegk5J+0xaxcZ9i8S0smdxP57tqy8a0jkSshLQn7BzMFxneQrlYExrLrDhQ=="
		},
		{
			name: "@deepseek-ai/dsh-tools",
			version: "0.1.1-rc.2",
			integrity: "sha512-0GGL4D55MwYDepzZMOI3L0ycu5b2qr96GL0Y7snwhAnpK2Di61rbX3fJE+PB3ZrovGX0csIRdt9n3iJZDVtDrw=="
		},
		{
			name: "@deepseek-ai/dsh-tool-goal",
			version: "0.1.1-rc.2",
			integrity: "sha512-kTECpE732uwlxRJr/jBZb1BqaxZzrA7Rv4KuM3eolvhoTJ5zjyiR2YHmDmCSfuI6zmA/BEfWss7D0mLbVtJEZA=="
		},
		{
			name: "@deepseek-ai/dsh-agent-loop",
			version: "0.1.1-rc.2",
			integrity: "sha512-2uJZ6kjJ3IYLRGn6/NhiZgD576ABcbERB/nkReR9TEUMO2zWkz6OuKtVwLyFCFSni2T25Jv+clKQWt7D4MhU3A=="
		},
		{
			name: "@deepseek-ai/dsh-tool-bash",
			version: "0.1.1-rc.2",
			integrity: "sha512-YNmrKmBanj5EQn1zejjbo4UUFtg2/h3s9y0lY3vBu+dezNz4HdUlSkSZACbNUAZywyLomdhlt4rJdtdnrqyS7Q=="
		},
		{
			name: "@deepseek-ai/dsh-tool-pwsh",
			version: "0.1.1-rc.2",
			integrity: "sha512-Gr0F4VWCIIR25qWVv4mMEJnewXILHLCkZwrLfbHA2OOI7DNvvdB5wjJxhuo+ZQa8/3KJ/byQGtEBqCY9mb10Zg=="
		},
		{
			name: "@deepseek-ai/dsh-shell",
			version: "0.1.1-rc.2",
			integrity: "sha512-gEqPUxKOpOV66wvM4o8Z5FEuWmsEvYzD9OQy3cyo/kjzlx+2+KUWi22cl/YWtBs/zUtRJbdG5UqMnh8GUeO8Hg=="
		},
		{
			name: "@deepseek-ai/dsh-subprocess-local",
			version: "0.1.1-rc.2",
			integrity: "sha512-I4pyzpohZEVRQQbuEpMP0t8oKsf+XIlRo64aJVKGXI2eMcg9f9gbfhKQNYNqRGbegQL1HYpSLU6Rzyibldgwaw=="
		},
		{
			name: "@deepseek-ai/dsh-bash-sandbox",
			version: "0.1.1-rc.2",
			integrity: "sha512-bagZDMZ73C1dVDBjFCn1flNZ8aOEel4dsmDJTfmagqeYPXfIJDFKPhDc3lWjc+o6jMNfmumeUJ62dwhHkjJHKA=="
		},
		{
			name: "@deepseek-ai/dsh-pwsh-sandbox",
			version: "0.1.1-rc.2",
			integrity: "sha512-hBUTg5p8TTQifZrfstbimVlBFyUOb7JhNkWKc+n6UpTzoFRSkPAvrjGeXKDmFI6jXpL4nXzLJoaIssfYnRg7bw=="
		},
		{
			name: "@deepseek-ai/dsh-shell-env",
			version: "0.1.1-rc.2",
			integrity: "sha512-dDKKqsxsbklUpxX5ornd/SKJ2yfr/SOHOWDgeJkYvx3SMSXq8EvhCK/VEvHswXQ25rRLFWM4/Mr3htk1hn/GPA=="
		},
		{
			name: "@deepseek-ai/dsh",
			version: "0.1.1-rc.2",
			integrity: "sha512-UP1UIh6q3Gme/yXRn/QL2P8IsVlv8Shpg22TRJIZPsCRWLm4CBiA1MUvXmJAfsOEETBMLAl+xWPtFw6ICsN3wg=="
		},
		{
			name: "@deepseek-ai/dsh-host-plugin-inventory",
			version: "0.1.1-rc.2",
			integrity: "sha512-Hud9ezW0bexWfhX7C+c5rdUDX1xzbEGDzj1lGQyj/QxdrxHYHjGrJq3tLRyvN6K4FSmEdG2IBKdQGCOLVrIthA=="
		},
		{
			name: "dshmarket",
			version: "1.36.0",
			integrity: "sha512-xX8CCoXdIALaxtLosj+5qGg8r1cykW2zo1AOPJcSQepg2r4Vd2K0NmERldDqfeyFV0pCuZsUoAPe1Q/BW7De/g=="
		},
		{
			name: "@deepseek-ai/dsh-host-webserver",
			version: "0.1.1-rc.2",
			integrity: "sha512-t9MrjC65QHiiWhG9V8UZxgfE/aWYhJHHrIM0kbTvtXxg4tLGIKo/upHp7iiag65F3HTkVLrH/DUyPMi4v2ZA7g=="
		},
		{
			name: "@deepseek-ai/dsh-web-app",
			version: "0.1.1-rc.2",
			integrity: "sha512-1zGHY7qwBVlVJrzIWu+86SuBZXaVUxe2JRfffsuRvKXq2QcR/K4CoJJfZ43cDoWKu9xPvvxz7w2ezV+EdXgg1A=="
		},
		{
			name: "@deepseek-ai/dsh-jobs",
			version: "0.1.1-rc.2",
			integrity: "sha512-SXvDJMvcUrGrlzIyE7j8/lI4Pj1nDe/UOR8C05Zagp+/0R8p46n6KylySvZdPAFENV5t8WX3Fw3eOaS4No0+wQ=="
		},
		{
			name: "@deepseek-ai/dsh-jobs-local",
			version: "0.1.1-rc.2",
			integrity: "sha512-26lg7mi9RKnu8IP8SWLbY+uZenbqF2AkAZvgZaLDlw1z58NtBsbgKgh6FNC8JXEyknAwYc6auQQKF+nLTlEjCw=="
		},
		{
			name: "@deepseek-ai/dsh-tool-jobs",
			version: "0.1.1-rc.2",
			integrity: "sha512-wCU7mo2uoQcAtz7de4ZXP2es9lALsmz6XzC+KAlS2e7/yTBi9a5LL2vdSr6XhExVAuhu/6f9eM/w4EQBOxtKlw=="
		},
		{
			name: "@deepseek-ai/dsh-tool-fs",
			version: "0.1.1-rc.2",
			integrity: "sha512-llX8AWbaI3CGme/a2eeTSfy5atk8u3iJeOFzmZV/KZ0v0hMhKZIK1xQInWwC9OmSDJ/StStJe0hDPVLWbB7hVg=="
		},
		{
			name: "@deepseek-ai/dsh-fs",
			version: "0.1.1-rc.2",
			integrity: "sha512-8j+6MffvCHATLQrhAVfc9rKyunKu/O7mjjJzmdsUSdID7V4iUYMwqPamhlAyI+tfohZu/vcforKzCRIZGmCYug=="
		},
		{
			name: "@deepseek-ai/dsh-fs-local",
			version: "0.1.1-rc.2",
			integrity: "sha512-jvn1MsAMqCmt5SjRNkPjmpc+RIWrZQrBVtf/OpmKr2PaBEGqSbCkPApWDE9iSMhcuQg6k5evScOXwAsduzKOLA=="
		},
		{
			name: "@deepseek-ai/dsh-fs-sandbox",
			version: "0.1.1-rc.2",
			integrity: "sha512-PI65uLZ3ARkfVV/PXvACS1HEXggoOaXgYQzXQFdLOfm7AiHOdZWZccUAXBetpZhcNYIOKsVoLnfZkXcHByqecQ=="
		},
		{
			name: "@deepseek-ai/dsh-fs-observation-policy",
			version: "0.1.1-rc.2",
			integrity: "sha512-rlq7yu4xavkKK1Oa1/aNCOeUW7t/3OXJJOfOcZXuUgJn5f8G0AbpTDpp2CeuL1cHlKpbunGhEkKQ2N/dv7ZR9w=="
		},
		{
			name: "@deepseek-ai/dsh-sandbox",
			version: "0.1.1-rc.2",
			integrity: "sha512-rnO2RqZ+ycpwrXrXlMcrhWAICdui3ZVTjNQ8eZrOPE18hAbX3tw0nLFq26sBjMSnBfDQHNZ4VaFpt0p8qhkPWQ=="
		},
		{
			name: "@deepseek-ai/dsh-sandbox-policy",
			version: "0.1.1-rc.2",
			integrity: "sha512-cpoIUxCzpZJDTMXVt9gS+qgWEDAWf6rIe715uY1NF0ROoiEXPlmToLsHLF+4pXTW3wWWzpGVswO0bPYEKrQr3g=="
		},
		{
			name: "@deepseek-ai/dsh-user-approval",
			version: "0.1.1-rc.2",
			integrity: "sha512-SdsO4Rs+NeJFoertkVilXBACREOLfkKPJJznYKqDhJxeRo38RJ56dtj0Xd0/6rERmsQiMck4Bwdrzg1ubUqPNA=="
		},
		{
			name: "@deepseek-ai/dsh-attachment",
			version: "0.1.1-rc.2",
			integrity: "sha512-rCYAt8QsawP1yfDCU7XxNwYT/XWvyFsxYrkwhLLkdfW83QVD0CQHizSkTQE7RFX74nKUD1z3sTLfnLr7xneArw=="
		},
		{
			name: "@deepseek-ai/dsh-system-prompt",
			version: "0.1.1-rc.2",
			integrity: "sha512-on4hjAlYI5uX9q7Sf95YkMMBVe6heywtA/H50ksrIMUub8U2B98hO9iQpHhjwIO1F1vu+5pLcPvRr6yUGGmtXQ=="
		}
	]),
	defineCohort("dsh-0.1.2-alpha.2", ["0.1.2-alpha.2"], ["posix", "windows"], ALPHA2_HOST_PACKAGES),
	defineCohort("dsh-0.1.2-alpha.2-dshmarket-1.39.0", ["0.1.2-alpha.2"], ["posix", "windows"], ALPHA2_DSHMARKET_139_HOST_PACKAGES),
	defineCohort("dsh-0.1.2-alpha.3", ["0.1.2-alpha.3"], ["posix", "windows"], ALPHA3_HOST_PACKAGES),
	defineCohort("dsh-0.1.2-rc.1", ["0.1.2-rc.1"], ["posix", "windows"], RC1_HOST_PACKAGES),
	defineCohort("dsh-0.1.5-rc.1", ["0.1.5-rc.1"], [], RC015_HOST_PACKAGES, "registry-derived-pending-native-audit", ["posix", "windows"])
];
/** Baseline cohort retained for callers that need a default fixture. */
const ACTIVE_HOST_COHORT_ID = "dsh-0.1.5-rc.1";
const ACTIVE_HOST_COHORT_IDS = [ACTIVE_HOST_COHORT_ID, "dsh-0.1.5-rc.2"];
/** Core-lock/v1 separates optional market identity from the audited DSH graph.
* The active support targets are the exact registered rc.1 and rc.2 graphs:
* historical cohorts stay in `LEGACY_HOST_COHORTS` as verification data but are
* never silently re-labelled as accepted active locks, and an installed
* historical graph fails closed under `evaluateHostLock`. The version policy
* (the exact rc.2-or-rc.1 public set) and the graph lock are separate
* judgments: a host that has not been registered here is "unverified / pending
* audit", never supported by version order alone.
*/
const HOST_COHORTS = [...LEGACY_HOST_COHORTS, defineCohort("dsh-0.1.5-rc.2", ["0.1.5-rc.2"], [], RC015_RC2_HOST_PACKAGES, "registry-derived-pending-native-audit", ["posix", "windows"])].filter((cohort) => ACTIVE_HOST_COHORT_IDS.includes(cohort.id)).map((cohort) => ({
	...cohort,
	id: `${cohort.id}-core-v1`,
	manifestVersion: 2,
	packages: cohort.packages.filter((row) => row.name !== "dshmarket"),
	capabilities: [
		{
			name: "host_cohort",
			value: {
				k: "s",
				v: `${cohort.id}-core-v1`
			}
		},
		{
			name: "host_lock_policy",
			value: {
				k: "s",
				v: "dsh-core/v1"
			}
		},
		{
			name: "host_audit_provenance",
			value: {
				k: "s",
				v: cohort.auditProvenance
			}
		},
		...AUDITED_CAPABILITY_ROWS
	]
}));
/**
* Baseline fixture package identities (DSH 0.1.5-rc.1). The cohort
* is an atomic whole-graph contract (CG-DSH-001): any drifted, duplicated,
* unknown-version, unbound, OR MISSING row fails the whole lock closed
* (`host_lock_missing`); no capability inherits independence from a partially
* present graph.
*/
const EXPECTED_HOST_PACKAGES = HOST_COHORTS[0].packages;
/**
* The `@deepseek-ai/dsh` launcher version of the baseline fixture, read from the
* cohort rows rather than hardcoded, so a cohort bump cannot leave a stale
* literal behind in the target-inspection path.
*/
const ACTIVE_HOST_LAUNCHER_VERSION = EXPECTED_HOST_PACKAGES.find((row) => row.name === "@deepseek-ai/dsh")?.version;
const packageNames = (...names) => new Set(names);
const BASE_HOST_PACKAGES = packageNames("@deepseek-ai/cordis", "@deepseek-ai/dsh-agent", "@deepseek-ai/dsh-commands", "@deepseek-ai/dsh-llm", "@deepseek-ai/dsh-session", "@deepseek-ai/dsh-tools");
const GOAL_HOST_PACKAGES = packageNames("@deepseek-ai/dsh-goal", "@deepseek-ai/dsh-tool-goal");
const HOST_CAPABILITY_PACKAGE_GROUPS = {
	agent_loop: packageNames("@deepseek-ai/dsh-agent-loop"),
	terminal_posix: packageNames("@deepseek-ai/dsh-tool-bash", "@deepseek-ai/dsh-shell", "@deepseek-ai/dsh-subprocess-local", "@deepseek-ai/dsh-bash-sandbox", "@deepseek-ai/dsh-shell-env"),
	terminal_windows: packageNames("@deepseek-ai/dsh-tool-pwsh", "@deepseek-ai/dsh-shell", "@deepseek-ai/dsh-subprocess-local", "@deepseek-ai/dsh-pwsh-sandbox", "@deepseek-ai/dsh-shell-env"),
	dsh_cli: packageNames("@deepseek-ai/dsh"),
	plugin_inventory: packageNames("@deepseek-ai/dsh-host-plugin-inventory"),
	web_control: packageNames("@deepseek-ai/dsh-host-webserver", "@deepseek-ai/dsh-web-app"),
	jobs: packageNames("@deepseek-ai/dsh-jobs", "@deepseek-ai/dsh-jobs-local", "@deepseek-ai/dsh-tool-jobs"),
	filesystem: packageNames("@deepseek-ai/dsh-tool-fs", "@deepseek-ai/dsh-fs", "@deepseek-ai/dsh-fs-local", "@deepseek-ai/dsh-fs-sandbox", "@deepseek-ai/dsh-fs-observation-policy", "@deepseek-ai/dsh-sandbox", "@deepseek-ai/dsh-sandbox-policy", "@deepseek-ai/dsh-user-approval", "@deepseek-ai/dsh-attachment", "@deepseek-ai/dsh-system-prompt")
};
/**
* The host version a package graph records, for the version-policy decision.
*
* Every DSH package versions with the host, so the graph's own `dsh` row is the
* version the caller is running. A graph without that row leaves the version
* unknown, and an unknown version is not treated as supported.
*/
function hostVersionFromPackages(rows) {
	return rows.find((row) => row.name === "@deepseek-ai/dsh")?.version;
}
/**
* Atomically select the audited cohort for one supplied package graph. A
* graph matches a cohort only when every row carries version and integrity,
* each exactly equals that cohort's audited row, and the graph covers the
* complete audited cohort (missing packages fail closed); graphs that mix
* rows from different cohorts, use versions unknown to the registry, or
* target a platform the cohort was never audited on never select
* consistently.
*/
function selectHostCohort(rows, platform) {
	rows = rows.filter((row) => row.name !== "dshmarket");
	const registryNames = new Set(HOST_COHORTS.flatMap((cohort) => cohort.packages.map((row) => row.name)));
	if (rows.some((row) => !registryNames.has(row.name))) return {
		cohort: HOST_COHORTS[0],
		consistent: false,
		reasonCode: "host_cohort_unknown_package"
	};
	if (rows.length === 0) return {
		cohort: HOST_COHORTS[0],
		consistent: false,
		reasonCode: "host_cohort_unbound_identity"
	};
	const bound = rows.filter((row) => row.version !== void 0 && row.integrity !== void 0);
	const unboundCount = rows.length - bound.length;
	const versionMatches = bound.map((row) => HOST_COHORTS.filter((cohort) => cohort.packages.some((p) => p.name === row.name && p.version === row.version)));
	const identityMatches = bound.map((row, index) => versionMatches[index].filter((cohort) => cohort.packages.some((p) => p.name === row.name && p.version === row.version && p.integrity === row.integrity)));
	const candidates = HOST_COHORTS.filter((cohort) => identityMatches.every((matches) => matches.includes(cohort)));
	const consistentCohort = candidates.filter((cohort) => cohort.packages.length === rows.length && cohort.packages.every((expected) => rows.filter((row) => row.name === expected.name).length === 1))[0] ?? candidates[0];
	if (consistentCohort !== void 0 && unboundCount === 0) {
		if (platform && !consistentCohort.acceptedPlatforms.includes(platform)) return {
			cohort: consistentCohort,
			consistent: false,
			reasonCode: "host_cohort_platform_not_audited"
		};
		const suppliedCounts = /* @__PURE__ */ new Map();
		for (const row of rows) suppliedCounts.set(row.name, (suppliedCounts.get(row.name) ?? 0) + 1);
		if (!(consistentCohort.packages.every((row) => (suppliedCounts.get(row.name) ?? 0) === 1) && rows.length === consistentCohort.packages.length)) return {
			cohort: consistentCohort,
			consistent: false,
			reasonCode: "host_cohort_incomplete_graph"
		};
		return {
			cohort: consistentCohort,
			consistent: true
		};
	}
	const matchingIndices = identityMatches.flatMap((matches, index) => matches.length > 0 ? [index] : []);
	const mixtureCovered = HOST_COHORTS.filter((cohort) => matchingIndices.every((index) => identityMatches[index].includes(cohort)));
	let reasonCode;
	if (matchingIndices.length > 0 && mixtureCovered.length === 0) reasonCode = "host_cohort_mixed_graph";
	else if (bound.length > 0 && versionMatches.some((matches) => matches.length === 0)) reasonCode = "host_cohort_version_mismatch";
	else if (bound.length > 0 && identityMatches.some((matches) => matches.length === 0)) reasonCode = "host_cohort_integrity_mismatch";
	else reasonCode = "host_cohort_unbound_identity";
	return {
		cohort: [...HOST_COHORTS].sort((a, b) => {
			const scoreOf = (cohort) => identityMatches.filter((matches) => matches.includes(cohort)).length;
			return scoreOf(b) - scoreOf(a) || HOST_COHORTS.indexOf(a) - HOST_COHORTS.indexOf(b);
		})[0],
		consistent: false,
		reasonCode
	};
}
function stableRows(rows) {
	return [...rows].map((row) => ({ ...row })).sort((a, b) => a.name.localeCompare(b.name) || (a.version ?? "").localeCompare(b.version ?? "") || (a.integrity ?? "").localeCompare(b.integrity ?? ""));
}
function statusForPackages(id, rows, requiredNames, cohort) {
	const requiredPackages = [...requiredNames].sort();
	const relevant = rows.filter((row) => requiredNames.has(row.name));
	const counts = /* @__PURE__ */ new Map();
	for (const row of relevant) counts.set(row.name, (counts.get(row.name) ?? 0) + 1);
	const missingPackages = requiredPackages.filter((name) => !counts.has(name));
	const digest$1 = safeHostLockDigest(relevant, { capabilityId: id }, cohort);
	if ([...counts.values()].some((count) => count > 1)) return {
		id,
		status: "unavailable",
		digest: digest$1,
		requiredPackages,
		missingPackages,
		reasonCode: "host_capability_duplicate_package"
	};
	if (missingPackages.length > 0) return {
		id,
		status: "unavailable",
		digest: digest$1,
		requiredPackages,
		missingPackages,
		reasonCode: "host_capability_missing"
	};
	const expected = new Map(cohort.packages.map((row) => [row.name, row]));
	for (const row of relevant) {
		const pinned = expected.get(row.name);
		if (!row.version || !row.integrity) return {
			id,
			status: "unavailable",
			digest: digest$1,
			requiredPackages,
			missingPackages,
			reasonCode: "host_capability_missing"
		};
		if (row.version !== pinned.version) return {
			id,
			status: "unsupported",
			digest: digest$1,
			requiredPackages,
			missingPackages,
			reasonCode: "host_capability_version_mismatch"
		};
		if (row.integrity !== pinned.integrity) return {
			id,
			status: "unsupported",
			digest: digest$1,
			requiredPackages,
			missingPackages,
			reasonCode: "host_capability_integrity_mismatch"
		};
	}
	return {
		id,
		status: "supported",
		digest: digest$1,
		requiredPackages,
		missingPackages
	};
}
function capabilityEvaluations(rows, cohort) {
	return Object.fromEntries(Object.entries(HOST_CAPABILITY_PACKAGE_GROUPS).map(([id, packages]) => [id, statusForPackages(id, rows, packages, cohort)]));
}
function cohortForEvaluation(evaluation) {
	return HOST_COHORTS.find((cohort) => cohort.id === evaluation.cohortId) ?? HOST_COHORTS[0];
}
function evaluateHostLock(rows, context = {}) {
	const supplied = stableRows(rows.filter((row) => row.name !== "dshmarket"));
	const selection = selectHostCohort(supplied, context.platform);
	const cohort = selection.cohort;
	const capabilities = capabilityEvaluations(supplied, cohort);
	const counts = /* @__PURE__ */ new Map();
	for (const row of supplied) counts.set(row.name, (counts.get(row.name) ?? 0) + 1);
	const goalRows = [...GOAL_HOST_PACKAGES].filter((name) => counts.has(name));
	const goalAvailable = goalRows.length === GOAL_HOST_PACKAGES.size;
	const digest$1 = safeHostLockDigest(supplied, context, cohort);
	const base = statusForPackages("base", supplied, BASE_HOST_PACKAGES, cohort);
	const missingPackages = cohort.packages.map((row) => row.name).filter((name) => (counts.get(name) ?? 0) === 0).sort((a, b) => a.localeCompare(b));
	const registryNames = new Set(HOST_COHORTS.flatMap((entry) => entry.packages.map((row) => row.name)));
	const unknown = supplied.find((row) => !registryNames.has(row.name));
	const hostVersionValue = context.hostVersion ?? hostVersionFromPackages(supplied);
	const hostVersion = hostVersionValue === void 0 ? void 0 : evaluateMinimumHostVersion(hostVersionValue);
	const baseResult = {
		digest: digest$1,
		goalAvailable,
		packages: supplied,
		capabilities,
		cohortId: cohort.id,
		auditProvenance: cohort.auditProvenance,
		missingPackages,
		...hostVersion ? { hostVersion } : {},
		...context.platform ? { platform: context.platform } : {},
		...context.profileKind ? { profileKind: context.profileKind } : {}
	};
	if (unknown) return {
		...baseResult,
		status: "unsupported",
		reasonCode: "host_lock_unknown_package"
	};
	if (supplied.some((row) => (counts.get(row.name) ?? 0) > 1)) return {
		...baseResult,
		status: "unavailable",
		goalAvailable: false,
		reasonCode: "host_lock_duplicate_package"
	};
	if (goalRows.length > 0 && !goalAvailable) return {
		...baseResult,
		status: "unavailable",
		goalAvailable: false,
		reasonCode: "host_lock_goal_graph_incomplete"
	};
	if (base.status !== "supported") {
		const reasonCode = base.reasonCode === "host_capability_version_mismatch" ? "host_lock_version_mismatch" : base.reasonCode === "host_capability_integrity_mismatch" ? "host_lock_integrity_mismatch" : base.reasonCode === "host_capability_duplicate_package" ? "host_lock_duplicate_package" : "host_lock_missing";
		return {
			...baseResult,
			status: base.status,
			reasonCode
		};
	}
	if (goalAvailable) {
		const goal = statusForPackages("goal", supplied, GOAL_HOST_PACKAGES, cohort);
		if (goal.status !== "supported") return {
			...baseResult,
			status: goal.status,
			goalAvailable: false,
			reasonCode: goal.reasonCode === "host_capability_version_mismatch" ? "host_lock_version_mismatch" : goal.reasonCode === "host_capability_integrity_mismatch" ? "host_lock_integrity_mismatch" : "host_lock_missing"
		};
	}
	if (!selection.consistent) {
		const failure = {
			host_cohort_unknown_package: {
				status: "unsupported",
				reasonCode: "host_lock_unknown_package"
			},
			host_cohort_version_mismatch: {
				status: "unsupported",
				reasonCode: "host_lock_version_mismatch"
			},
			host_cohort_integrity_mismatch: {
				status: "unsupported",
				reasonCode: "host_lock_integrity_mismatch"
			},
			host_cohort_mixed_graph: {
				status: "unsupported",
				reasonCode: "host_lock_cohort_mixed_graph"
			},
			host_cohort_incomplete_graph: {
				status: "unavailable",
				reasonCode: "host_lock_missing"
			},
			host_cohort_unbound_identity: {
				status: "unsupported",
				reasonCode: "host_lock_cohort_unbound_identity"
			},
			host_cohort_platform_not_audited: {
				status: "unsupported",
				reasonCode: "host_lock_cohort_platform_not_audited"
			}
		}[selection.reasonCode ?? "host_cohort_unbound_identity"];
		return {
			...baseResult,
			status: failure.status,
			goalAvailable: false,
			reasonCode: failure.reasonCode
		};
	}
	if (hostVersion?.status === "below_minimum" || hostVersion?.status === "unparseable") return {
		...baseResult,
		status: "unsupported",
		goalAvailable: false,
		reasonCode: hostVersion.status === "below_minimum" ? "host_lock_version_below_minimum" : "host_lock_version_unparseable"
	};
	return {
		...baseResult,
		status: "supported"
	};
}
const TERMINAL_ACTIONS = new Set([
	"inspect_remote_updates",
	"install",
	"apply",
	"test",
	"verify",
	"pull",
	"fetch",
	"commit",
	"push",
	"publish",
	"generic_run"
]);
/** Evaluate only the packages needed for one effect/readback capability. */
function evaluateHostCapability(evaluation, request) {
	const platform = request.platform ?? evaluation.platform;
	const profileKind = request.profileKind ?? evaluation.profileKind;
	const groups = ["agent_loop"];
	if (TERMINAL_ACTIONS.has(request.action)) {
		if (!platform) return {
			id: `action.${request.action}`,
			status: "unavailable",
			digest: evaluation.digest,
			requiredPackages: [],
			missingPackages: [],
			reasonCode: "host_capability_context_missing"
		};
		groups.push(platform === "windows" ? "terminal_windows" : "terminal_posix");
	}
	if (request.action === "create" || request.action === "modify") groups.push("filesystem");
	if (request.action === "install" || request.action === "apply") groups.push("dsh_cli");
	if (request.action === "apply") groups.push("plugin_inventory");
	if (request.action === "restart" && profileKind === "web") groups.push("web_control");
	if (request.action === "restart" && profileKind !== "web") return {
		id: "action.restart",
		status: "unavailable",
		digest: evaluation.digest,
		requiredPackages: [],
		missingPackages: [],
		reasonCode: profileKind ? "host_capability_request_unsupported" : "host_capability_context_missing"
	};
	const required = new Set(BASE_HOST_PACKAGES);
	for (const group of groups) for (const name of HOST_CAPABILITY_PACKAGE_GROUPS[group]) required.add(name);
	const result = statusForPackages(`action.${request.action}.${platform ?? "native"}.${profileKind ?? "unknown"}`, evaluation.packages, required, cohortForEvaluation(evaluation));
	if (evaluation.status !== "supported") return {
		...result,
		status: evaluation.status,
		digest: evaluation.digest
	};
	return result;
}
/**
* Bind external_wait qualification and pre-effect requalification to the
* exact jobs service definition, local provider, and live controller graph.
* This is deliberately independent of the global/base lock so profiles that
* do not support background jobs can still use unrelated Guard actions.
*/
function evaluateExternalWaitCapability(evaluation) {
	const required = new Set(BASE_HOST_PACKAGES);
	for (const name of HOST_CAPABILITY_PACKAGE_GROUPS.jobs) required.add(name);
	const result = statusForPackages("boundary.external_wait.jobs", evaluation.packages, required, cohortForEvaluation(evaluation));
	if (evaluation.status !== "supported") return {
		...result,
		status: evaluation.status,
		digest: evaluation.digest
	};
	return result;
}
/**
* Gate automatically replayed ordinary tool results by the exact host
* capability that owns their registration and outcome surface. Tool names are
* intentionally separate from semantic actions: a `bash` result on Windows,
* or a `pwsh` result on POSIX, is not evidence from the active host stack.
*/
function evaluateToolSurfaceCapability(evaluation, surface) {
	const platform = evaluation.platform;
	if (surface !== "filesystem" && !platform) return {
		id: `tool.${surface}.unknown`,
		status: "unavailable",
		digest: evaluation.digest,
		requiredPackages: [],
		missingPackages: [],
		reasonCode: "host_capability_context_missing"
	};
	if (surface === "bash" && platform !== "posix" || surface === "pwsh" && platform !== "windows") return {
		id: `tool.${surface}.${platform}`,
		status: "unsupported",
		digest: evaluation.digest,
		requiredPackages: [],
		missingPackages: [],
		reasonCode: "host_capability_request_unsupported"
	};
	const groups = ["agent_loop"];
	if (surface === "filesystem") groups.push("filesystem");
	if (surface === "bash") groups.push("terminal_posix");
	if (surface === "pwsh") groups.push("terminal_windows");
	const required = new Set(BASE_HOST_PACKAGES);
	for (const group of groups) for (const name of HOST_CAPABILITY_PACKAGE_GROUPS[group]) required.add(name);
	const result = statusForPackages(`tool.${surface}.${platform ?? "native"}`, evaluation.packages, required, cohortForEvaluation(evaluation));
	if (evaluation.status !== "supported") return {
		...result,
		status: evaluation.status,
		digest: evaluation.digest
	};
	return result;
}
function safeHostLockDigest(packages, context = {}, cohort) {
	try {
		const capabilities = [
			...cohort.capabilities,
			...context.platform ? [{
				name: "active_platform",
				value: {
					k: "s",
					v: context.platform
				}
			}] : [],
			...context.profileKind ? [{
				name: "active_profile",
				value: {
					k: "s",
					v: context.profileKind
				}
			}] : [],
			...context.capabilityId ? [{
				name: "active_capability",
				value: {
					k: "s",
					v: context.capabilityId
				}
			}] : []
		];
		return hostLockDigest({
			manifestVersion: cohort.manifestVersion,
			supportedGoalVersions: [...cohort.supportedGoalVersions],
			capabilities,
			packages: [...packages]
		});
	} catch {
		const bounded = {
			packages: packages.map((row) => [
				String(row.name),
				row.version ?? null,
				row.integrity ?? null
			]),
			platform: context.platform ?? null,
			profileKind: context.profileKind ?? null,
			capabilityId: context.capabilityId ?? null
		};
		return createHash("sha256").update("ccg.invalidHostLockDigest.v1\n", "utf8").update(JSON.stringify(bounded), "utf8").digest("hex");
	}
}
/** Bind the injected Goal graph to the live Goal service for this agent. */
function bindLiveGoalCapability(evaluation, liveGoalAvailable) {
	if (evaluation.status !== "supported") return {
		...evaluation,
		liveGoalAvailable
	};
	if (evaluation.goalAvailable !== liveGoalAvailable) return {
		...evaluation,
		status: "unavailable",
		reasonCode: "host_lock_goal_capability_mismatch",
		liveGoalAvailable
	};
	return {
		...evaluation,
		liveGoalAvailable
	};
}
function executableDigest(identity) {
	return createHash("sha256").update("ccg.executableIdentity.v1\n", "utf8").update(JSON.stringify(identity ?? null), "utf8").digest("hex");
}
function validExecutableIdentity(identity) {
	if (!identity || ![
		"git",
		"npm",
		"pnpm",
		"dsh"
	].includes(identity.executable)) return false;
	if (!identity.version || /[\r\n\0]/.test(identity.version)) return false;
	if (!(identity.realpath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(identity.realpath)) || /[\r\n\0]/.test(identity.realpath)) return false;
	if ([identity.interpreterRealpath, identity.interpreterVersion].every((value) => value === void 0)) return true;
	return typeof identity.interpreterRealpath === "string" && /^[A-Za-z]:[\\/]/.test(identity.interpreterRealpath) && !/[\r\n\0]/.test(identity.interpreterRealpath) && typeof identity.interpreterVersion === "string" && identity.interpreterVersion.length > 0 && !/[\r\n\0]/.test(identity.interpreterVersion);
}
/** Bind resolution and effect to the exact same canonical executable tuple. */
function bindExecutableIdentity(resolution, effect) {
	if (!resolution || !effect) return {
		status: "unavailable",
		digest: executableDigest(resolution),
		reasonCode: "executable_identity_missing"
	};
	if (!validExecutableIdentity(resolution) || !validExecutableIdentity(effect)) return {
		status: "unavailable",
		digest: executableDigest(resolution),
		reasonCode: "executable_realpath_invalid"
	};
	if (resolution.executable !== effect.executable || resolution.realpath !== effect.realpath || resolution.version !== effect.version || resolution.interpreterRealpath !== effect.interpreterRealpath || resolution.interpreterVersion !== effect.interpreterVersion) return {
		status: "unsupported",
		digest: executableDigest(resolution),
		reasonCode: "executable_identity_drift"
	};
	return {
		status: "supported",
		digest: executableDigest(resolution),
		identity: { ...resolution }
	};
}
const DEFAULT_HOST_LOCK = evaluateHostLock(EXPECTED_HOST_PACKAGES);

//#endregion
//#region src/domain/shell-parse.ts
const TWO_CHAR_OPS = new Set([
	"&&",
	"||",
	">>",
	"<<",
	"<&",
	">&",
	"|&"
]);
const STATEMENT_OPS = new Set([
	"&&",
	"||",
	"|",
	"|&",
	"&",
	";",
	"\n",
	"(",
	")"
]);
/**
* Quote-aware shell tokenizer. Single quotes are literal, double quotes allow
* `\` escapes, and backslash escapes are honored outside quotes. Unterminated
* quotes mark the input as malformed.
*/
function tokenizeShell(command) {
	const tokens = [];
	let index = 0;
	let malformed = false;
	const length = command.length;
	while (index < length) {
		const char = command[index];
		if (char === "\n" || char === "\r") {
			tokens.push({
				kind: "op",
				value: "\n",
				quoted: false
			});
			index += char === "\r" && command[index + 1] === "\n" ? 2 : 1;
			continue;
		}
		if (char === " " || char === "	") {
			index += 1;
			continue;
		}
		const two = command.slice(index, index + 2);
		if (TWO_CHAR_OPS.has(two)) {
			tokens.push({
				kind: "op",
				value: two,
				quoted: false
			});
			index += 2;
			continue;
		}
		if (char === ";" || char === "|" || char === "&" || char === "(" || char === ")" || char === "<" || char === ">") {
			tokens.push({
				kind: "op",
				value: char,
				quoted: false
			});
			index += 1;
			continue;
		}
		let word = "";
		let quoted = false;
		let quote = null;
		while (index < length) {
			const current = command[index];
			if (quote === "'") {
				if (current === "'") {
					quote = null;
					index += 1;
					continue;
				}
				quoted = true;
				word += current;
				index += 1;
				continue;
			}
			if (quote === "\"") {
				if (current === "\"") {
					quote = null;
					index += 1;
					continue;
				}
				quoted = true;
				if (current === "\\" && index + 1 < length) {
					word += command[index + 1];
					index += 2;
					continue;
				}
				word += current;
				index += 1;
				continue;
			}
			if (current === "'") {
				quote = "'";
				index += 1;
				continue;
			}
			if (current === "\"") {
				quote = "\"";
				index += 1;
				continue;
			}
			if (current === "\\" && index + 1 < length) {
				word += command[index + 1];
				index += 2;
				continue;
			}
			if (current === " " || current === "	" || current === "\n" || current === "\r") break;
			if (current === ";" || current === "|" || current === "&" || current === "(" || current === ")" || current === "<" || current === ">") break;
			if (TWO_CHAR_OPS.has(command.slice(index, index + 2))) break;
			word += current;
			index += 1;
		}
		if (quote !== null) {
			malformed = true;
			break;
		}
		if (word) tokens.push({
			kind: "word",
			value: word,
			quoted
		});
	}
	return {
		tokens,
		malformed
	};
}
/** Characters that indicate non-literal paths (variables, expansion, globs). */
const DYNAMIC_PATH = /[$`~*?[\]{}]/u;
function isLiteralPath(value) {
	return value.length > 0 && !DYNAMIC_PATH.test(value);
}
/** v0.1 whitelist: single foreground simple commands only (manifest-driven). */
const SHELL_FILE_TOOLS = new Set(COMMAND_SURFACE_MANIFEST.fileTools);
/** Read-only inspection tools: every pathish argument counts as a read effect. */
const SHELL_READ_TOOLS = new Set(COMMAND_SURFACE_MANIFEST.readTools);
const SHELL_RUN_EXECUTABLES = new Set(COMMAND_SURFACE_MANIFEST.runExecutables);
/**
* Whether an executable carries run semantics (as opposed to the tiny
* file/read tool subset). Used for scope-subject attribution of a pathless
* run operation; `echo` or `cat` never becomes a subject-carrying run.
*/
function isRunExecutable(executable) {
	return SHELL_RUN_EXECUTABLES.has(executable.toLowerCase());
}
/** Looks like a filesystem path: contains a separator, or a file extension. */
function isPathish(value) {
	return /[\\/]/.test(value) || /^\.\.?(\/|$)/.test(value) || /\.(?:[A-Za-z0-9][A-Za-z0-9_-]{0,15})$/.test(value);
}
function unsupported(reason) {
	return {
		status: "unsupported",
		reason,
		executables: [],
		operations: [],
		malformed: false
	};
}
function unsupportedArgv(reason) {
	return {
		status: "unsupported",
		reason,
		argv: [],
		malformed: false
	};
}
/**
* Parse one POSIX shell command against the v0.1 supported surface: a single
* foreground simple command made of an env-assignment prefix, one whitelisted
* executable and literal arguments, with at most one `>`/`>>` redirect to a
* literal path. Compound syntax (`;`, `&&`, `||`, pipes, background, subshells,
* command substitution, heredocs, unclosed quotes, dynamic eval/source,
* variable/glob paths) makes the WHOLE command unsupported with no partial
* results.
*/
function parseShellCommand(command) {
	const { tokens, malformed } = tokenizeShell(command);
	if (malformed) return {
		status: "malformed",
		reason: "unterminated quote",
		executables: [],
		operations: [],
		malformed: true
	};
	if (tokens.length === 0) return {
		status: "supported",
		executables: [],
		operations: [],
		malformed: false
	};
	const writePaths = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token.kind === "word" && /^\d+$/.test(token.value) && tokens[index + 1]?.kind === "op" && tokens[index + 1]?.value === ">&" && tokens[index + 2]?.kind === "word" && /^\d+$/.test(tokens[index + 2].value)) {
			index += 2;
			continue;
		}
		if (token.kind === "word" && /^\d+$/.test(token.value) && tokens[index + 1]?.kind === "op" && (tokens[index + 1]?.value === ">" || tokens[index + 1]?.value === ">>")) return unsupported("file-descriptor-prefixed file redirect is not in the v0.1 subset");
		if (token.kind === "op") {
			if (token.value === ">") {
				const next = tokens[index + 1];
				if (!next || next.kind !== "word") return unsupported("redirect target is not a literal word");
				if (!isLiteralPath(next.value)) return unsupported("non-literal redirect path");
				writePaths.push(next.value);
				index += 1;
				continue;
			}
			if (token.value === ">>" || token.value === "<" || token.value === "<<" || token.value === "<&" || token.value === ">&") return unsupported(`redirect '${token.value}' is not in the v0.1 subset`);
			if (STATEMENT_OPS.has(token.value)) return unsupported(`statement operator '${token.value}' is not in the v0.1 subset`);
			return unsupported(`operator '${token.value}' is not in the v0.1 subset`);
		}
	}
	if (writePaths.length > 1) return unsupported("multiple write redirects are not in the v0.1 subset");
	const wordTokens = tokens.filter((token) => token.kind === "word");
	let executableIndex = 0;
	while (executableIndex < wordTokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(wordTokens[executableIndex].value)) executableIndex += 1;
	const executableToken = wordTokens[executableIndex];
	const executable = executableToken?.value ?? "";
	if (!executable) return unsupported("no executable");
	if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(executable)) return unsupported("executable is not a plain literal name");
	if (executableToken.quoted) return unsupported("quoted executable is not in the v0.1 subset");
	if (wordTokens.slice(0, executableIndex).map((token) => token.value).some((word) => !isLiteralPath(word))) return unsupported("dynamic environment assignment");
	const exe = executable.toLowerCase();
	if (!SHELL_FILE_TOOLS.has(exe) && !SHELL_READ_TOOLS.has(exe) && !SHELL_RUN_EXECUTABLES.has(exe)) return unsupported(`executable '${executable}' is not in the v0.1 whitelist`);
	const args = wordTokens.slice(executableIndex + 1).map((token) => token.value);
	if (args.some((arg) => !isLiteralPath(arg))) return unsupported("non-literal argument");
	const pathishArgs = args.filter((arg) => isPathish(arg));
	const operations = [];
	for (const path$1 of writePaths) operations.push({
		op: "create",
		path: path$1
	});
	if (exe === "touch") for (const path$1 of pathishArgs) operations.push({
		op: "create",
		path: path$1
	});
	else if (SHELL_READ_TOOLS.has(exe)) {
		if (exe === "sed" && args.some((arg) => /^-i($|[A-Za-z0-9])|^--in-place/.test(arg))) return unsupported("in-place sed editing is not in the v0.1 subset");
		for (const path$1 of pathishArgs) operations.push({
			op: "read",
			path: path$1
		});
	}
	operations.push({
		op: "run",
		...pathishArgs[0] !== void 0 ? { path: pathishArgs[0] } : {}
	});
	return {
		status: "supported",
		executables: [executable],
		operations,
		malformed: false
	};
}
const PWSH_CMDLETS = {
	"set-content": {
		op: "create",
		pathParams: ["-path", "-literalpath"],
		valueParams: ["-value", "-encoding"],
		switchParams: ["-nonewline"]
	},
	"add-content": {
		op: "create",
		pathParams: ["-path", "-literalpath"],
		valueParams: ["-value", "-encoding"],
		switchParams: ["-nonewline"]
	},
	"new-item": {
		op: "create",
		pathParams: ["-path"],
		valueParams: ["-value", "-itemtype"],
		switchParams: []
	},
	"out-file": {
		op: "create",
		pathParams: ["-filepath", "-literalpath"],
		valueParams: ["-encoding"],
		switchParams: ["-nonewline"]
	},
	"get-content": {
		op: "read",
		pathParams: ["-path", "-literalpath"],
		valueParams: ["-encoding"],
		switchParams: ["-raw"]
	}
};
/** PowerShell tokenizer: quoted strings (backtick-escaped) are one word. */
function tokenizePwsh(command) {
	const words = [];
	let index = 0;
	let malformed = false;
	const length = command.length;
	while (index < length) {
		const char = command[index];
		if (char === " " || char === "	" || char === "\n" || char === "\r") {
			index += 1;
			continue;
		}
		if (char === "'" || char === "\"") {
			const quote = char;
			let word$1 = "";
			let closed = false;
			index += 1;
			while (index < length) {
				const current = command[index];
				if (current === "`") {
					malformed = true;
					break;
				}
				if (current === quote) {
					closed = true;
					index += 1;
					break;
				}
				word$1 += current;
				index += 1;
			}
			if (!closed) malformed = true;
			words.push({
				value: word$1,
				quoted: true
			});
			continue;
		}
		let word = "";
		while (index < length) {
			const current = command[index];
			if (current === " " || current === "	" || current === "\n" || current === "\r") break;
			if (current === "`") malformed = true;
			word += current;
			index += 1;
			if (malformed) break;
		}
		words.push({
			value: word,
			quoted: false
		});
	}
	return {
		words,
		malformed
	};
}
/** Unsupported PowerShell structure outside quoted strings. */
function readPwshUnsupported(command) {
	let inSingle = false;
	let inDouble = false;
	let index = 0;
	while (index < command.length) {
		const char = command[index];
		if (inSingle) {
			if (char === "'") inSingle = false;
			index += 1;
			continue;
		}
		if (inDouble) {
			if (char === "`") return {
				unsupported: true,
				reason: "backtick escape"
			};
			if (char === "$") return {
				unsupported: true,
				reason: "variable or subexpression"
			};
			if (char === "\"") inDouble = false;
			index += 1;
			continue;
		}
		if (char === "'") {
			inSingle = true;
			index += 1;
			continue;
		}
		if (char === "\"") {
			inDouble = true;
			index += 1;
			continue;
		}
		if (char === "`") return {
			unsupported: true,
			reason: "backtick escape"
		};
		if (char === "$") return {
			unsupported: true,
			reason: "variable or subexpression"
		};
		if (char === "\n" || char === "\r") return {
			unsupported: true,
			reason: "unquoted newline"
		};
		if (char === "&") {
			const previous = command[index - 1] ?? "";
			const next = command[index + 1] ?? "";
			if (previous === ">" && /[0-9]/.test(next)) {
				index += 1;
				continue;
			}
			return {
				unsupported: true,
				reason: "structure character &"
			};
		}
		if (char === ";" || char === "|" || char === "{" || char === "}" || char === "(" || char === ")" || char === "[" || char === "]" || char === ",") return {
			unsupported: true,
			reason: `structure character '${char}'`
		};
		index += 1;
	}
	if (/^\s*\./.test(command)) return {
		unsupported: true,
		reason: "dot sourcing"
	};
	return { unsupported: false };
}
/** PowerShell v0.2 subset: external executables with literal arguments. */
const PWSH_EXTERNAL_EXECUTABLES = new Set(COMMAND_SURFACE_MANIFEST.pwshExternalExecutables);
/**
* Parse one PowerShell command against the v0.2 subset: a single, directly
* invoked whitelisted cmdlet (Set-Content / Add-Content / New-Item /
* Out-File / Get-Content) whose path comes from an explicit named path
* parameter, or a whitelisted external executable (git, pnpm, node, …) with
* all-literal arguments. Unquoted `N>&M` diagnostic stream duplication is
* stripped. Multi-statements (`;`), pipelines (`|`), the call operator (`&`),
* script blocks, dot sourcing, .NET/dynamic invocation,
* variable/expression/subexpression paths, positional paths, and unknown
* parameters make the WHOLE command unsupported.
*/
function parsePwshCommand(command) {
	const dynamic = readPwshUnsupported(command);
	if (dynamic.unsupported) return unsupported(`dynamic or compound PowerShell syntax (${dynamic.reason ?? "unknown"})`);
	const { words: rawWords, malformed } = tokenizePwsh(command);
	if (malformed) return {
		status: "malformed",
		reason: "unterminated quote or escape",
		executables: [],
		operations: [],
		malformed: true
	};
	const words = rawWords.filter((word) => !(word.quoted === false && /^[0-9]*>&[0-9]+$/.test(word.value)));
	if (words.length === 0) return {
		status: "supported",
		executables: [],
		operations: [],
		malformed: false
	};
	const cmdletRaw = words[0].value;
	const spec = PWSH_CMDLETS[cmdletRaw.toLowerCase()];
	const external = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(cmdletRaw) && PWSH_EXTERNAL_EXECUTABLES.has(cmdletRaw.toLowerCase());
	if (!spec && !external) return unsupported(`command '${cmdletRaw}' is not in the v0.1 whitelist`);
	if (words[0].quoted) return unsupported("quoted command name is not in the v0.1 subset");
	if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(cmdletRaw)) return unsupported("dynamic or .NET invocation is not in the v0.1 subset");
	if (external) {
		const args = words.slice(1).map((token) => token.value);
		if (args.some((arg) => !isLiteralPath(arg))) return unsupported("non-literal argument");
		const pathishArgs = args.filter((arg) => isPathish(arg));
		return {
			status: "supported",
			executables: [cmdletRaw],
			operations: [{
				op: "run",
				...pathishArgs[0] !== void 0 ? { path: pathishArgs[0] } : {}
			}],
			malformed: false
		};
	}
	const paths = [];
	let expected = null;
	for (let index = 1; index < words.length; index += 1) {
		const token = words[index];
		const low = token.value.toLowerCase();
		if (token.value.startsWith("-")) {
			if (spec.pathParams.includes(low)) {
				expected = "path";
				continue;
			}
			if (spec.valueParams.includes(low)) {
				expected = "value";
				continue;
			}
			if (spec.switchParams.includes(low)) {
				expected = null;
				continue;
			}
			return unsupported(`parameter '${token.value}' is not in the v0.1 whitelist`);
		}
		if (expected === "path") {
			if (!isLiteralPath(token.value)) return unsupported("non-literal path");
			paths.push(token.value);
			expected = null;
			continue;
		}
		if (expected === "value") {
			expected = null;
			continue;
		}
		return unsupported("positional argument is not in the v0.1 subset");
	}
	if (expected !== null) return unsupported("missing parameter value");
	const operations = [];
	for (const path$1 of paths) operations.push({
		op: spec.op,
		path: path$1
	});
	return {
		status: "supported",
		executables: [cmdletRaw],
		operations,
		malformed: false
	};
}
/**
* Return canonical argv for the same literal, single-command grammar used by
* the production capture parser. This is intentionally stricter than the
* operation parser: environment prefixes and redirects are rejected because
* a stateful command manifest must bind the executable and every argument
* directly. Callers must still validate the executable-specific argv shape.
*/
function canonicalArgvFromCommand(command, surface) {
	if (surface === "bash") {
		const parsed$1 = parseShellCommand(command);
		if (parsed$1.status !== "supported") return {
			status: parsed$1.status,
			...parsed$1.reason ? { reason: parsed$1.reason } : {},
			argv: [],
			malformed: parsed$1.malformed
		};
		const tokenized$1 = tokenizeShell(command);
		if (tokenized$1.malformed) return {
			status: "malformed",
			reason: "unterminated quote",
			argv: [],
			malformed: true
		};
		if (tokenized$1.tokens.some((token) => token.kind === "op")) return unsupportedArgv("redirects and shell operators are not allowed in a command manifest");
		const words = tokenized$1.tokens.filter((token) => token.kind === "word");
		if (words.some((word) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word.value))) return unsupportedArgv("environment assignment prefixes are not allowed in a command manifest");
		return {
			status: "supported",
			argv: words.map((word) => word.value),
			malformed: false
		};
	}
	const parsed = parsePwshCommand(command);
	if (parsed.status !== "supported") return {
		status: parsed.status,
		...parsed.reason ? { reason: parsed.reason } : {},
		argv: [],
		malformed: parsed.malformed
	};
	const dynamic = readPwshUnsupported(command);
	if (dynamic.unsupported) return unsupportedArgv(`dynamic or compound PowerShell syntax (${dynamic.reason ?? "unknown"})`);
	const tokenized = tokenizePwsh(command);
	if (tokenized.malformed) return {
		status: "malformed",
		reason: "unterminated quote or escape",
		argv: [],
		malformed: true
	};
	return {
		status: "supported",
		argv: tokenized.words.filter((word) => !(word.quoted === false && /^[0-9]*>&[0-9]+$/.test(word.value))).map((word) => word.value),
		malformed: false
	};
}

//#endregion
//#region src/domain/evidence.ts
function boundedSummary(value) {
	return value.length > 240 ? `${value.slice(0, 237)}...` : value;
}
function parseArguments$1(raw) {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}
function asRecord$2(value) {
	return typeof value === "object" && value !== null ? value : void 0;
}
function extractTextContent(content) {
	const parts = [];
	for (const block$1 of content) {
		const record = asRecord$2(block$1);
		if (!record) continue;
		if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
		if (record.type === "tool-result" && Array.isArray(record.content)) parts.push(extractTextContent(record.content));
	}
	return parts.join("\n");
}
function metaPaths(meta) {
	const record = asRecord$2(meta);
	if (!record) return [];
	if (typeof record.path === "string") return [record.path];
	if (Array.isArray(record.diffs)) return record.diffs.map((diff) => asRecord$2(diff)?.path).filter((path$1) => typeof path$1 === "string");
	return [];
}
function argsPaths(args) {
	const filePath = args.file_path;
	if (typeof filePath === "string") return [filePath];
	return [];
}
/** Resolve a relative command path reference against the command workdir. */
function resolveCommandPath(reference, cwd) {
	if (!cwd) return reference;
	if (/^[A-Za-z]:[\\/]/.test(reference) || reference.startsWith("//") || reference.startsWith("\\\\") || reference.startsWith("/") || reference.startsWith("\\")) return reference;
	return `${cwd.replace(/[\\/]+$/, "")}/${reference}`;
}
function stable(value) {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
	return JSON.stringify(value);
}
function structuredGuardMeta(meta, toolName) {
	if (toolName !== "context_guard_evidence") return void 0;
	const outer = asRecord$2(meta);
	const value = asRecord$2(outer?.contextGuard ?? outer?.context_guard);
	if (!value) return void 0;
	const action = value.semanticAction ?? value.semantic_action;
	const role = value.evidenceRole ?? value.evidence_role;
	const resolved = asRecord$2(value.resolvedTarget ?? value.resolved_target);
	const observed = asRecord$2(value.observedState ?? value.observed_state);
	const rawExpected = asRecord$2(value.expectedTransition);
	const expectedParameters = asRecord$2(rawExpected?.parameters);
	const expectedDigest = value.expectedTransitionDigest;
	const expectedTransition = rawExpected && typeof rawExpected.predicateId === "string" && rawExpected.version === 1 && rawExpected.predParamsKind === "inline" && expectedParameters && typeof expectedDigest === "string" && expectedDigest === sha256(stable(rawExpected)) ? rawExpected : void 0;
	if (typeof value.adapterId !== "string" || typeof value.adapterVersion !== "string") return void 0;
	if (SUPPORTED_EVIDENCE_ADAPTERS[value.adapterId] !== value.adapterVersion) return void 0;
	if (typeof action !== "string" || typeof role !== "string" || !resolved) return void 0;
	if (!SEMANTIC_ACTIONS.includes(action)) return void 0;
	if (![
		"resolution",
		"effect",
		"state"
	].includes(role)) return void 0;
	if (role === "state" && !observed) return void 0;
	return {
		adapterId: value.adapterId,
		adapterVersion: value.adapterVersion,
		semanticAction: action,
		evidenceRole: role,
		resolvedTarget: resolved,
		...observed ? { observedState: observed } : {},
		...expectedTransition ? {
			expectedTransition,
			expectedTransitionDigest: expectedDigest
		} : {}
	};
}
function parseStatus(details) {
	if (details.status === "supported") return { parseStatus: "supported" };
	if (details.status === "malformed") return {
		parseStatus: "malformed_quote",
		reasonCode: "malformed_quote"
	};
	if (details.reason?.includes("statement operator") || details.reason?.includes("compound")) return {
		parseStatus: "unsupported_statement_operator",
		reasonCode: "unsupported_statement_operator"
	};
	return {
		parseStatus: "unsupported_command",
		reasonCode: "unsupported_command"
	};
}
function weakResolvedTarget(action, cwd, executables) {
	if (action === "verify") return cwd ? { scope: cwd } : {};
	if (action === "test" || action === "generic_run") return {
		...cwd ? { scope: cwd } : {},
		...executables[0] ? { executable: executables[0].toLowerCase() } : {}
	};
	if ([
		"pull",
		"fetch",
		"commit",
		"push",
		"inspect_remote_updates"
	].includes(action)) return cwd ? { repository: cwd } : {};
	return cwd ? { scope: cwd } : {};
}
/**
* Analyze a shell/pwsh command against the v0.1 supported surface. Only a
* fully supported command produces executables/operations; unsupported or
* malformed syntax yields EMPTY executables and operations (fail-closed), so a
* partially understood command can never certify an operation.
*/
function analyzeCommand(command, workdir, toolName) {
	const cwd = typeof workdir === "string" ? workdir : void 0;
	const parsed = toolName === "pwsh" ? parsePwshCommand(command) : parseShellCommand(command);
	if (parsed.status !== "supported") return {
		status: parsed.status,
		reason: parsed.reason,
		executables: [],
		operations: [],
		subjects: cwd ? [cwd] : []
	};
	const operations = parsed.operations.map((entry) => {
		let path$1 = entry.path !== void 0 ? resolveCommandPath(entry.path, cwd) : void 0;
		if (path$1 === void 0 && entry.op === "run" && cwd !== void 0 && parsed.executables.some((executable) => isRunExecutable(executable))) path$1 = cwd;
		return {
			op: entry.op,
			...path$1 !== void 0 ? { path: path$1 } : {}
		};
	});
	const subjects = unique([...cwd ? [cwd] : [], ...operations.map((entry) => entry.path).filter((path$1) => path$1 !== void 0)]);
	return {
		status: parsed.status,
		reason: parsed.reason,
		executables: parsed.executables,
		operations,
		subjects
	};
}
const PERSISTENT_RESET_LINE = /^The persistent (?:bash|pwsh) shell was reset;/;
const PERSISTENT_TIMEOUT_INTRO = /^Your command timed out after \d+ seconds or experienced an OOM error\. Below is partial output:$/;
/**
* Structured terminal facts from the tool/result meta (defensive): the pinned
* shell renderers currently emit text markers only, but the underlying run
* result carries exitCode/signal, so a future harness that surfaces them in
* `meta` is trusted directly. Absent structured facts, text scanning remains
* the fallback.
*/
function structuredTerminalFacts(meta) {
	const record = asRecord$2(meta);
	if (!record) return void 0;
	const rawExit = record.exitCode ?? record.exit_code;
	const rawSignal = record.signal;
	if (rawSignal !== void 0 && rawSignal !== null) return {
		exitCode: typeof rawExit === "number" ? rawExit : void 0,
		negative: true,
		marked: true
	};
	if (typeof rawExit === "number") return {
		exitCode: rawExit,
		negative: false,
		marked: true
	};
}
/** `[exit code: N]`, `[shell exited: code N]`, `[Command finished with exit code N]`. */
const TERMINAL_EXIT_MARKER = /^\[(?:exit code|shell exited: code|command finished with exit code)\s*:?\s*(\d+)\]$/;
/** Negative markers with no exit code of their own. */
const TERMINAL_NEGATIVE_MARKER = /^\[(?:timed out[^\]]*|sandbox[^\]]*|killed by signal[^\]]*|shell killed by signal[^\]]*|shell exited|command timed out or oom|interrupted[^\]]*)\]$/;
function extractTerminalFacts(textContent) {
	const lines = textContent.split(/\r?\n/);
	let index = lines.length - 1;
	while (index >= 0 && lines[index].trim() === "") index -= 1;
	const resetStripped = index >= 0 && PERSISTENT_RESET_LINE.test(lines[index].trim());
	if (resetStripped) {
		index -= 1;
		while (index >= 0 && lines[index].trim() === "") index -= 1;
	}
	const timeoutIntroAtHead = resetStripped && lines.length > 0 && PERSISTENT_TIMEOUT_INTRO.test(lines[0].trim());
	let exitCode;
	let negative = timeoutIntroAtHead;
	let marked = timeoutIntroAtHead;
	while (index >= 0) {
		const line = lines[index].trim().toLowerCase();
		const exitMatch = line.match(TERMINAL_EXIT_MARKER);
		if (exitMatch) {
			if (exitCode === void 0) exitCode = Number(exitMatch[1]);
			marked = true;
		} else if (TERMINAL_NEGATIVE_MARKER.test(line)) {
			negative = true;
			marked = true;
		} else break;
		index -= 1;
	}
	return {
		exitCode,
		negative,
		marked
	};
}
/**
* 0.6.2 D062-02: one trusted structured producer declaration, if the host
* rendered per-operation results. Absence is the honest common case: the
* pinned DSH renderers declare a whole-result terminal marker only, so no
* per-operation producer exists and the attribution stays `unknown`.
*/
function declaredOperationResults(meta) {
	const declared = asRecord$2(asRecord$2(meta)?.contextGuardProcess)?.operationResults;
	if (!Array.isArray(declared) || declared.length === 0 || declared.length > 64) return void 0;
	const rows = [];
	for (const raw of declared) {
		const row = asRecord$2(raw);
		const action = typeof row?.action === "string" ? row.action : void 0;
		const outcome = row?.outcome;
		if (!action || outcome !== "success" && outcome !== "failure" && outcome !== "unknown") return void 0;
		rows.push({
			action,
			outcome
		});
	}
	return rows;
}
/**
* The trusted run-level declaration in `meta.contextGuardProcess`. This is the
* highest-priority source: it is the run's own statement about the process, so
* an explicit `exitCode` here outranks the generic `meta.exitCode`.
*/
function declaredStructuredTerminal(meta) {
	const record = asRecord$2(asRecord$2(meta)?.contextGuardProcess);
	if (!record) return void 0;
	const rawExit = record.exitCode ?? record.exit_code;
	const signal = record.signal;
	if (signal !== void 0 && signal !== null) return {
		...typeof rawExit === "number" ? { exitCode: rawExit } : {},
		signal: true
	};
	if (typeof rawExit === "number") return {
		exitCode: rawExit,
		signal: false
	};
}
/**
* The HISTORICAL terminal-fact rule, unchanged since 0.6.1: the generic
* structured `meta` fact, else the rendered text markers. It deliberately does
* NOT read the trusted `contextGuardProcess` run declaration — that source is
* new in 0.6.2 and reading it here would change the frozen `outcome` of
* already-recorded evidence, which is a summary input and therefore historical
* (0.6.2 review of D062-02).
*/
function legacyTerminalFacts(meta, textContent) {
	return structuredTerminalFacts(meta) ?? extractTerminalFacts(textContent);
}
/**
* The terminal facts the DERIVED layer reads, in priority order (0.6.2 D062-02
* review): the trusted run declaration first, then the generic structured fact,
* then the rendered markers. This never feeds the frozen `outcome`; it feeds
* `processFacts` only, which states its own `source` and whether it disagrees
* with the frozen reading.
*/
function resolveDeclaredTerminalFacts(meta, textContent) {
	const namespace = declaredStructuredTerminal(meta);
	if (namespace) return {
		facts: {
			exitCode: namespace.exitCode,
			negative: namespace.signal,
			marked: true
		},
		source: "run_declaration"
	};
	const structured = structuredTerminalFacts(meta);
	if (structured) return {
		facts: structured,
		source: "structured_meta"
	};
	return {
		facts: extractTerminalFacts(textContent),
		source: "rendered_markers"
	};
}
/**
* The one outcome rule for a shell result, shared by the frozen evidence field
* and the derived reading. Their different fact sources may yield different verdicts.
* The bundled DSH session shell renderers (`dsh-tool-bash` / `dsh-tool-pwsh`)
* append markers only for negative terminal facts or non-zero exits, so a
* completed foreground result with no marker is a clean success for those two
* registered tools alone; the generic `shell` alias has no verified renderer
* contract and an unclassifiable marker stays `unknown`.
*/
function shellOutcome(surface, terminal, resultError, backgrounded) {
	if (backgrounded) return "unknown";
	if (resultError || terminal.negative) return "failure";
	if (terminal.exitCode === void 0) return (surface === "bash" || surface === "pwsh") && !terminal.marked ? "success" : "unknown";
	return terminal.exitCode === 0 ? "success" : "failure";
}
/**
* The layered shell reading (0.6.2 D062-02; source priority fixed by the
* 0.6.2 review). Every field is derived from the same persisted result the
* historical `outcome` was derived from, so replay is deterministic and no
* historical fact is reinterpreted:
*
* - `hostToolReturned` is the host's own return, nothing more;
* - `declaredExitCode` is `'unknown'` unless a real fact declared it, and an
*   unmarked success is NOT a read exit code of 0;
* - `operationAttribution` stays `'unknown'` for an opaque compound runner, so
*   the last command's success can never cover an earlier failure;
* - `outcome` uses the same evaluator with independently selected facts; a
*   disagreement with the historical field is explicitly reported.
*
* SOURCE PRIORITY for the process terminal facts, highest first:
*
*   1. the trusted `contextGuardProcess` namespace — the run's OWN declaration
*      of what the process did. An explicit `exitCode` here is read as declared
*      even when the generic `meta.exitCode` says something else; the namespace
*      is the more specific statement and never loses to the generic one.
*   2. any other structured terminal fact the renderer put in `meta`
*      (`meta.exitCode` / `meta.exit_code` / `meta.signal`).
*   3. the rendered text markers of the audited renderers.
*
* A namespace declaration never overrides the frozen `outcome`, because the
* frozen value is the historical record and this batch must not rewrite it; the
* derived layer records its source and conflict flag instead of changing history.
*/
function shellProcessFacts(meta, textContent, frozenOutcome, resultError, surface, backgrounded, parseStatus$1) {
	const { facts: terminal, source } = resolveDeclaredTerminalFacts(meta, textContent);
	const declaredOperations = declaredOperationResults(meta);
	const operationAttribution = declaredOperations ? "declared_per_operation" : parseStatus$1 === "supported" && !backgrounded ? "single_operation" : "unknown";
	const outcome = shellOutcome(surface, terminal, resultError, backgrounded);
	let outcomeReason;
	if (backgrounded) outcomeReason = "backgrounded";
	else if (resultError) outcomeReason = "host_error_flag";
	else if (terminal.negative) outcomeReason = "declared_negative_marker";
	else if (terminal.exitCode !== void 0) outcomeReason = "declared_exit_code";
	else if (outcome === "success") outcomeReason = "unmarked_renderer_success";
	else if (terminal.marked) outcomeReason = "marker_unclassified";
	else outcomeReason = "text_scan_inconclusive";
	return {
		hostToolReturned: resultError ? "error" : "result",
		declaredExitCode: terminal.exitCode ?? "unknown",
		terminalMarkerRead: terminal.marked,
		outcome,
		outcomeReason,
		source,
		frozenOutcomeConflict: outcome !== frozenOutcome,
		operationAttribution,
		...declaredOperations ? { declaredOperationResults: declaredOperations } : {}
	};
}
function metaUrls(meta) {
	const record = asRecord$2(meta);
	if (!record) return [];
	if (typeof record.url === "string") return [sanitizeUrl(record.url)];
	if (Array.isArray(record.sources)) return record.sources.map((source) => asRecord$2(source)?.url).filter((url) => typeof url === "string").map((url) => sanitizeUrl(url));
	return [];
}
const DETERMINISTIC_CHECK_PATTERNS = [
	/\b(?:pnpm|npm|yarn|bun)\s+(?:test|tst|lint|check|typecheck|build)\b/,
	/\b(?:cargo|go|make|cmake|pytest|vitest|jest|eslint|tsc|mypy|ruff|prettier)\b/,
	/\b(?:mvn|gradle)\s+(?:test|check)\b/,
	/\bpython(?:3)?\s+-m\s+(?:unittest|doctest|pytest)\b/
];
/** Prefixes that only quote or print a command without running a check. */
const NON_RUNNING_PREFIXES = [/^\s*(?:echo|printf|echo\s+-e|cat|tee|true|false|:|#)\b/, /\b(?:echo|printf)\s+[^|;&]*["'][^"']*(?:test|lint|build|check)[^"']*["'][^]|;&]*$/i];
/** Discovery/version/inspection commands, not verification runs. */
const INSPECTION_COMMANDS = /\b(?:which|where|whereis|type|command\s+-v|grep|rg|cat|less|head|tail|find|ls|dir)\b|\s(?:--version|-V|-v|--help|-h)\s*$|\s(?:--version|--help)\b/i;
/** Shell constructs that mask the real exit status or detach the check. */
const MASKING_CONSTRUCTS = [
	/\|\|/,
	/;/,
	/\|/,
	/(?:^|\s)&(?!&)\s*$/,
	/(?:^|\s)&(?!&)\s*(?:disown)?/,
	/\((?:.*\s&(?!&)\s*)\)\s*$/,
	/\b(?:nohup|setsid)\b/,
	/\|\s*(?:true|:)\s*$/
];
function isDeterministicCheck(command) {
	const normalized = command.trim().replace(/\s+/g, " ");
	if (!normalized || normalized.startsWith("#")) return false;
	if (/(?:^|[\s&|;(])\s*!(?=\s*[A-Za-z0-9/_.-])/.test(normalized)) return false;
	if (NON_RUNNING_PREFIXES.some((pattern) => pattern.test(normalized))) return false;
	if (INSPECTION_COMMANDS.test(normalized)) return false;
	if (MASKING_CONSTRUCTS.some((pattern) => pattern.test(normalized))) return false;
	const withoutCd = normalized.replace(/^cd\s+[^;&|]+\s*(?:&&|;)\s*/, "");
	return DETERMINISTIC_CHECK_PATTERNS.some((pattern) => pattern.test(withoutCd));
}
function capabilityGatedSubject(subject, surface, hostLock) {
	if (!hostLock) return subject;
	const capability = evaluateToolSurfaceCapability(hostLock, surface);
	if (capability.status === "supported") return subject;
	const reasonCode = capability.reasonCode === "host_capability_request_unsupported" ? "host_tool_platform_mismatch" : capability.reasonCode === "host_capability_context_missing" ? "host_tool_platform_context_missing" : `host_${surface === "filesystem" ? "filesystem" : "terminal"}_capability_${(capability.reasonCode ?? "unavailable").replace(/^host_capability_/, "")}`;
	return {
		...subject,
		capabilities: [],
		outcome: "unknown",
		parseStatus: "adapter_unavailable",
		reasonCode
	};
}
function unique(values) {
	return [...new Set(values)];
}
/** Resolve relative artifact subjects against the session scope cwd. */
function resolveSubjectPaths(values, cwd) {
	return cwd ? values.map((value) => resolveCommandPath(value, cwd)) : values;
}
function extractToolSubject(call, result, defaultCwd, hostLock) {
	const args = parseArguments$1(call.arguments);
	if (call.name === "context_guard_external_operation") {
		const external = asRecord$2(asRecord$2(result.meta)?.contextGuardExternalOperation);
		const status = external?.status;
		if (typeof external?.id === "string" && typeof external.adapterId === "string" && (status === "running" || status === "pending" || status === "completed" || status === "failed" || status === "unknown")) return {
			capabilities: ["external-operation-readback"],
			subjects: [],
			surfaces: [],
			outcome: status === "unknown" ? "unknown" : "success",
			semanticAction: "verify",
			evidenceRole: "effect",
			resolvedTarget: { operation_id: external.id },
			parseStatus: "supported",
			adapterId: "context-guard.external-operation.v1",
			adapterVersion: "1.0.0",
			externalOperationRef: {
				id: external.id,
				epoch: 0,
				adapterId: external.adapterId,
				status
			}
		};
		return {
			capabilities: ["external-operation-readback"],
			subjects: [],
			surfaces: [],
			outcome: "unknown",
			parseStatus: "adapter_unavailable",
			reasonCode: "external_operation_unavailable"
		};
	}
	const structured = structuredGuardMeta(result.meta, call.name);
	if (call.name === "context_guard_evidence" && !structured) {
		const disposition = asRecord$2(asRecord$2(result.meta)?.contextGuardDisposition);
		return {
			capabilities: ["guard-state-readback"],
			subjects: [],
			surfaces: [],
			outcome: "unknown",
			semanticAction: typeof args.semantic_action === "string" && SEMANTIC_ACTIONS.includes(args.semantic_action) ? args.semantic_action : "generic_run",
			evidenceRole: typeof args.evidence_role === "string" && [
				"resolution",
				"effect",
				"state"
			].includes(args.evidence_role) ? args.evidence_role : "effect",
			resolvedTarget: {},
			parseStatus: "adapter_unavailable",
			reasonCode: typeof disposition?.reasonCode === "string" ? disposition.reasonCode : "adapter_unavailable",
			adapterId: "context-guard.unavailable.v1",
			adapterVersion: "1.0.0"
		};
	}
	const structuredFields = structured ? {
		semanticAction: structured.semanticAction,
		evidenceRole: structured.evidenceRole,
		resolvedTarget: structured.resolvedTarget,
		...structured.observedState ? { observedState: structured.observedState } : {},
		...structured.expectedTransition ? {
			expectedTransition: structured.expectedTransition,
			expectedTransitionDigest: structured.expectedTransitionDigest
		} : {},
		parseStatus: "supported",
		adapterId: structured.adapterId,
		adapterVersion: structured.adapterVersion
	} : {};
	if (call.name === "context_guard_evidence" && structured) {
		const artifact = typeof structured.resolvedTarget.artifact_id === "string" ? structured.resolvedTarget.artifact_id : void 0;
		const scope = typeof structured.resolvedTarget.repository === "string" ? structured.resolvedTarget.repository : typeof structured.resolvedTarget.profile === "string" ? structured.resolvedTarget.profile : typeof structured.resolvedTarget.service_id === "string" ? structured.resolvedTarget.service_id : typeof structured.resolvedTarget.registry === "string" ? structured.resolvedTarget.registry : defaultCwd;
		const subject = artifact ?? scope;
		const surface = artifact ? "artifact" : "scope";
		return {
			capabilities: [structured.evidenceRole === "state" ? "independent-state-readback" : "guard-stateful-observation"],
			subjects: subject ? [subject] : [surface],
			surfaces: [surface],
			operations: [{
				op: structured.evidenceRole === "effect" ? "run" : "read",
				...subject ? { path: subject } : {}
			}],
			...structuredFields
		};
	}
	switch (call.name) {
		case "read":
		case "read_file": {
			const subjects = unique(resolveSubjectPaths([...metaPaths(result.meta), ...argsPaths(args)], defaultCwd));
			return capabilityGatedSubject({
				capabilities: ["filesystem-read"],
				subjects,
				surfaces: ["artifact"],
				operations: subjects.map((path$1) => ({
					op: "read",
					path: path$1
				})),
				semanticAction: structured?.semanticAction ?? "verify",
				evidenceRole: structured?.evidenceRole ?? "effect",
				resolvedTarget: structured?.resolvedTarget ?? { scope: defaultCwd ?? "scope" },
				...structured?.observedState ? { observedState: structured.observedState } : {},
				parseStatus: "supported",
				adapterId: structured?.adapterId ?? "dsh.read.v1",
				adapterVersion: structured?.adapterVersion ?? "1.0.0"
			}, "filesystem", hostLock);
		}
		case "write":
		case "write_file": {
			const subjects = unique(resolveSubjectPaths([...metaPaths(result.meta), ...argsPaths(args)], defaultCwd));
			return capabilityGatedSubject({
				capabilities: ["filesystem-write"],
				subjects,
				surfaces: ["artifact"],
				operations: subjects.map((path$1) => ({
					op: "create",
					path: path$1
				})),
				semanticAction: structured?.semanticAction ?? "create",
				evidenceRole: structured?.evidenceRole ?? "effect",
				resolvedTarget: structured?.resolvedTarget ?? {
					...subjects[0] ? { artifact_id: subjects[0] } : {},
					scope: defaultCwd ?? "scope"
				},
				parseStatus: "supported",
				adapterId: structured?.adapterId ?? "dsh.write.v1",
				adapterVersion: structured?.adapterVersion ?? "1.0.0"
			}, "filesystem", hostLock);
		}
		case "edit":
		case "edit_file": {
			const subjects = unique(resolveSubjectPaths([...metaPaths(result.meta), ...argsPaths(args)], defaultCwd));
			return capabilityGatedSubject({
				capabilities: ["filesystem-edit"],
				subjects,
				surfaces: ["artifact"],
				operations: subjects.map((path$1) => ({
					op: "modify",
					path: path$1
				})),
				semanticAction: structured?.semanticAction ?? "modify",
				evidenceRole: structured?.evidenceRole ?? "effect",
				resolvedTarget: structured?.resolvedTarget ?? {
					...subjects[0] ? { artifact_id: subjects[0] } : {},
					scope: defaultCwd ?? "scope"
				},
				parseStatus: "supported",
				adapterId: structured?.adapterId ?? "dsh.edit.v1",
				adapterVersion: structured?.adapterVersion ?? "1.0.0"
			}, "filesystem", hostLock);
		}
		case "bash":
		case "shell":
		case "pwsh": {
			const command = typeof args.command === "string" ? args.command : "";
			const backgrounded = args.run_in_background === true;
			const commandDetails = analyzeCommand(command, typeof args.workdir === "string" ? args.workdir : defaultCwd, call.name);
			const commandCwd = typeof args.workdir === "string" ? args.workdir : defaultCwd;
			const action = structured?.semanticAction ?? semanticActionFromCommand(command);
			const deterministic = commandDetails.status === "supported" && !backgrounded && isDeterministicCheck(command);
			const terminal = legacyTerminalFacts(result.meta, result.textContent);
			const surface = call.name;
			const outcome = shellOutcome(surface, terminal, result.error, backgrounded);
			const processFacts = shellProcessFacts(result.meta, result.textContent, outcome, result.error, surface, backgrounded, parseStatus(commandDetails).parseStatus);
			const subject = {
				capabilities: ["shell", ...deterministic ? ["deterministic-check"] : []],
				subjects: unique(commandDetails.subjects),
				surfaces: ["scope"],
				outcome,
				processFacts,
				executables: commandDetails.executables,
				operations: commandDetails.operations,
				semanticAction: action,
				evidenceRole: structured?.evidenceRole ?? "effect",
				resolvedTarget: structured?.resolvedTarget ?? weakResolvedTarget(action, commandCwd, commandDetails.executables),
				...structured?.observedState ? { observedState: structured.observedState } : {},
				...parseStatus(commandDetails),
				adapterId: structured?.adapterId ?? `dsh.${call.name}.v1`,
				adapterVersion: structured?.adapterVersion ?? "1.0.0"
			};
			return call.name === "bash" || call.name === "pwsh" ? capabilityGatedSubject(subject, call.name, hostLock) : subject;
		}
		case "web_search":
		case "web_fetch":
		case "web_fetch_url": return {
			capabilities: ["web-fetch"],
			subjects: unique([...metaUrls(result.meta), ...typeof args.url === "string" ? [sanitizeUrl(args.url)] : []]),
			surfaces: ["ui"],
			semanticAction: structured?.semanticAction ?? semanticActionFromText(call.name),
			evidenceRole: structured?.evidenceRole ?? "effect",
			resolvedTarget: structured?.resolvedTarget ?? { scope: "web" },
			...structured?.observedState ? { observedState: structured.observedState } : {},
			parseStatus: "supported",
			adapterId: structured?.adapterId ?? "dsh.web.v1",
			adapterVersion: structured?.adapterVersion ?? "1.0.0"
		};
		default: return {
			capabilities: ["generic"],
			subjects: [],
			surfaces: [],
			...structuredFields
		};
	}
}
function evidenceFromPersistedToolResult(call, result, epoch, evidenceId, defaultCwd, hostLock) {
	const subject = extractToolSubject(call, result, defaultCwd, hostLock);
	const outcome = result.error ? "failure" : subject.outcome ?? "success";
	return {
		id: evidenceId,
		epoch,
		callId: call.callId,
		rootCallId: call.rootCallId ?? call.callId,
		toolName: call.name,
		toolResultSeq: result.seq,
		outcome,
		capabilities: subject.capabilities,
		subjects: subject.subjects,
		surfaces: subject.surfaces,
		boundedSummarySha256: sha256(boundedSummary(result.textContent)),
		...subject.executables?.length ? { executables: subject.executables } : {},
		...subject.operations?.length ? { operations: subject.operations } : {},
		...subject.semanticAction ? { semanticAction: subject.semanticAction } : {},
		...subject.evidenceRole ? { evidenceRole: subject.evidenceRole } : {},
		...subject.resolvedTarget ? { resolvedTarget: subject.resolvedTarget } : {},
		...subject.observedState ? { observedState: subject.observedState } : {},
		...subject.expectedTransition ? { expectedTransition: subject.expectedTransition } : {},
		...subject.expectedTransitionDigest ? { expectedTransitionDigest: subject.expectedTransitionDigest } : {},
		...subject.parseStatus ? { parseStatus: subject.parseStatus } : {},
		...subject.reasonCode ? { reasonCode: subject.reasonCode } : {},
		...subject.adapterId ? { adapterId: subject.adapterId } : {},
		...subject.adapterVersion ? { adapterVersion: subject.adapterVersion } : {},
		...subject.processFacts ? { processFacts: subject.processFacts.hostToolReturned === (result.error ? "error" : "result") ? subject.processFacts : {
			...subject.processFacts,
			hostToolReturned: result.error ? "error" : "result",
			...result.error ? {
				outcome: "failure",
				outcomeReason: "host_error_flag"
			} : {},
			frozenOutcomeConflict: (result.error ? "failure" : subject.processFacts.outcome) !== outcome
		} } : {},
		...subject.externalOperationRef ? { externalOperationRef: {
			...subject.externalOperationRef,
			epoch
		} } : {}
	};
}
function withDurability(evidence, confirmed) {
	if (confirmed) return evidence;
	return {
		...evidence,
		outcome: "durability-unknown"
	};
}

//#endregion
//#region src/domain/supersession.ts
function supersedeItem(items, oldId, replacement) {
	const old = items.get(oldId);
	if (!old || old.status === "superseded") return false;
	old.status = "superseded";
	old.supersededBy = replacement.id;
	items.set(replacement.id, replacement);
	return true;
}

//#endregion
//#region src/domain/delivery.ts
function assistantTextOf(data) {
	return (data?.message?.content ?? []).filter((part) => part?.type === "text").map((part) => part?.text ?? "").join("\n");
}
function integerField(data, field$1) {
	const value = data?.[field$1];
	return typeof value === "number" && Number.isSafeInteger(value) ? value : void 0;
}
/**
* Derive the trusted deliveries from the event log. Deterministic: a replay of
* identical events yields identical facts.
*/
function deriveTrustedDeliveries(events) {
	const turns = /* @__PURE__ */ new Map();
	const factsFor = (turn) => {
		let facts = turns.get(turn);
		if (!facts) {
			facts = {
				started: false,
				steps: /* @__PURE__ */ new Set(),
				assistants: [],
				ends: []
			};
			turns.set(turn, facts);
		}
		return facts;
	};
	for (const event of events) switch (event.type) {
		case "turn/start": {
			const turn = integerField(event.data, "turn");
			if (turn !== void 0) factsFor(turn).started = true;
			break;
		}
		case "step/start":
		case "step/end": {
			const turn = integerField(event.data, "turn");
			const step = integerField(event.data, "step");
			if (turn !== void 0 && step !== void 0) factsFor(turn).steps.add(step);
			break;
		}
		case "assistant/message": {
			const turn = integerField(event.data, "turn");
			const step = integerField(event.data, "step");
			if (turn === void 0 || step === void 0) break;
			const facts = factsFor(turn);
			facts.steps.add(step);
			facts.assistants.push({
				seq: event.seq,
				step,
				text: assistantTextOf(event.data),
				interrupted: event.data?.interrupted === true
			});
			break;
		}
		case "turn/end": {
			const turn = integerField(event.data, "turn");
			if (turn === void 0) break;
			const reason = event.data?.reason;
			factsFor(turn).ends.push({
				seq: event.seq,
				kind: typeof reason?.kind === "string" ? reason.kind : ""
			});
			break;
		}
		default: break;
	}
	const deliveries = [];
	for (const [turn, facts] of turns) {
		if (!facts.started) continue;
		if (facts.ends.length !== 1) continue;
		const end = facts.ends[0];
		if (end.kind !== "completed") continue;
		if (facts.steps.size === 0) continue;
		const finalStep = Math.max(...facts.steps);
		const inFinalStep = facts.assistants.filter((row) => row.step === finalStep && row.seq < end.seq && !row.interrupted && row.text.trim().length > 0);
		if (inFinalStep.length === 0) continue;
		const final = inFinalStep.reduce((left, right) => right.seq > left.seq ? right : left);
		if (facts.assistants.some((row) => row.seq > final.seq && row.seq < end.seq)) continue;
		deliveries.push({
			turn,
			turnEndSeq: end.seq,
			responseSeq: final.seq,
			responseSha256: sha256(final.text)
		});
	}
	return deliveries.sort((left, right) => left.turnEndSeq - right.turnEndSeq);
}
/**
* The information-slot items a delivery closes: obligations captured from a
* root message inside the delivered turn, in the unit that turn's input
* belonged to (or in one of that unit's delegated sub-units), whose semantic
* slot is information (an inquiry or an explanation request). Execution,
* constraints, and unknowns are never closed by delivery, and neither are
* questions from earlier messages.
*
* An ATTACHMENT obligation (one with an `asset` identity) closes through its
* CURRENT interpretation instead of its original message (0.6.1 W060-01
* review): a re-interpreted old asset would otherwise never close, because
* its root message can no longer belong to a live turn. The binding is the
* interpretation fact itself — the delivery must be the answer of the turn
* that recorded the interpretation, and the fact must exist at the delivery
* watermark. The final answer — even a real one — still never interprets
* images on the model's behalf.
*/
function informationItemIdsForDelivery(items, delivery, turnRootInputSeqs, eligibleUnitIds, interpretationFacts) {
	const closed = [];
	for (const [itemId, item] of items) {
		if (item.status !== "pending") continue;
		if (item.kind === "prohibition") continue;
		const isAssetObligation = item.asset !== void 0 && item.asset !== null;
		if (item.unitId !== void 0 && eligibleUnitIds !== void 0 && !eligibleUnitIds.has(item.unitId)) continue;
		const informationSlot = item.taskKind === "inquiry" || item.authorityDisposition === "informational" && item.kind === "requirement";
		item.asset !== void 0 && item.asset;
		if (isAssetObligation) {
			if (!(interpretationFacts ?? []).some((fact) => fact.itemId === itemId && fact.turn === delivery.turn && fact.resultSeq <= delivery.turnEndSeq)) continue;
			closed.push(itemId);
			continue;
		}
		if (informationSlot) {
			const interpretedThisTurn = (interpretationFacts ?? []).some((fact) => fact.itemId === itemId && fact.turn === delivery.turn && fact.resultSeq <= delivery.turnEndSeq);
			const sourceSeq = /^m(\d+)(?::|$)/.exec(item.sourceMessageId);
			if (!interpretedThisTurn && (!sourceSeq || !turnRootInputSeqs.has(Number(sourceSeq[1])))) continue;
			closed.push(itemId);
			continue;
		}
	}
	return closed;
}

//#endregion
//#region src/domain/host-selection.ts
/**
* The default question-tool allowlist. The real names are a host tool-bundle
* surface: native acceptance pins the audited names for the running cohort,
* and the runtime may override this list per cohort.
*/
const DEFAULT_QUESTION_TOOL_NAMES = ["question", "ask_user"];
function parseQuestionCall(rawArguments) {
	if (typeof rawArguments !== "string") return void 0;
	let args;
	try {
		args = JSON.parse(rawArguments);
	} catch {
		return;
	}
	if (!args || typeof args !== "object" || Array.isArray(args)) return void 0;
	const record = args;
	const rawOptions = record.options ?? record.choices;
	if (!Array.isArray(rawOptions) || rawOptions.length === 0) return void 0;
	const options = [];
	for (const entry of rawOptions) {
		if (typeof entry !== "string" || !entry.trim()) return void 0;
		options.push(entry.trim());
	}
	return {
		questionId: typeof record.question_id === "string" ? record.question_id : typeof record.questionId === "string" ? record.questionId : void 0,
		question: typeof record.question === "string" ? record.question : void 0,
		options
	};
}
function parseSelectionAnswer(content, options) {
	if (!Array.isArray(content)) return void 0;
	const text = content.filter((part) => !!part && typeof part === "object").filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
	if (!text.trim()) return void 0;
	const trimmed = text.trim();
	if (options.includes(trimmed)) return trimmed;
	try {
		const parsed = JSON.parse(trimmed);
		const answer = parsed.answer ?? parsed.selected ?? parsed.value;
		if (typeof answer === "string" && options.includes(answer.trim())) return answer.trim();
	} catch {}
}
function looksLikeDirectory(value) {
	return /^[~.]?(?:[\\/][^\n]*)+$/.test(value);
}
/**
* Derive the trusted selections from the durable log. Deterministic: a replay
* of identical events yields identical selections.
*/
function deriveTrustedSelections(events, options) {
	const names = new Set(options.questionToolNames);
	const pending = /* @__PURE__ */ new Map();
	const selections = [];
	for (const event of events) {
		if (event.type === "tool/call") {
			const data$1 = event.data ?? {};
			const name = String(data$1.name ?? "");
			if (!names.has(name)) continue;
			const shape = parseQuestionCall(data$1.arguments);
			if (!shape) continue;
			pending.set(String(data$1.callId ?? ""), {
				callId: String(data$1.callId ?? ""),
				seq: event.seq,
				turn: typeof data$1.turn === "number" ? data$1.turn : void 0,
				toolName: name,
				shape
			});
			continue;
		}
		if (event.type !== "tool/result") continue;
		const data = event.data ?? {};
		const callId = String(data.message?.source?.callId ?? "");
		const call = pending.get(callId);
		if (!call) continue;
		pending.delete(callId);
		if (data.error !== void 0) continue;
		const selected = parseSelectionAnswer(data.message?.content, call.shape.options);
		if (!selected) continue;
		selections.push({
			callId,
			resultSeq: event.seq,
			turn: call.turn,
			toolName: call.toolName,
			questionId: call.shape.questionId,
			question: call.shape.question,
			options: call.shape.options,
			selected,
			kind: looksLikeDirectory(selected) ? "directory" : "value"
		});
	}
	return selections;
}

//#endregion
//#region src/domain/release.ts
/**
* Explicit release adoption and single-use tickets (0.6.0 C10 / DS06-F).
*
* A release is never implicit. "release", a loaded Skill, or an installation
* never activates this profile: a root user must explicitly ADOPT a release
* contract that names the exact candidate, and every effect must then match
* that contract and spend a one-shot reservation.
*
* Three durable records carry the state machine (P0 §5), all written through
* the plugin-notice channel the host already persists:
*
* - `contract`    — the adopted scope: operations, the exact candidate, the
*                   readiness/closure references and an optional expiry.
* - `reservation` — written BEFORE any effect; the operation is `in_flight`
*                   from that moment, so a crash cannot be mistaken for "never
*                   started" and the operation is never blindly re-sent.
* - `settlement`  — written after the effect. Its outcome distinguishes a
*                   PROVEN no-effect (`not_effected`, which releases the lock)
*                   from an UNKNOWN effect (`unknown`/`failed`/`unconfirmed`,
*                   which keeps the lock until a trusted readback reconciles
*                   it) and from a `settled` release.
*
* CANDIDATE IDENTITY IS TYPED, NOT CONFLATED. A release artifact has several
* genuinely different identities — the commit it was built from, the SHA-256 of
* the exact bytes, npm's SHA-512 SRI, the package name, the version, the
* repository, the ref and the target registry. Each is a separate field and is
* compared with its own observed value read from a trusted producer. Comparing,
* say, a 64-hex SHA-256 against an SRI can never succeed, so a legitimate
* release would have been permanently refused; and accepting a model-supplied
* SHA instead of the artifact's embedded one would bind nothing. Every field
* the contract declares must be OBSERVED, so omitting evidence is a refusal,
* never a bypass.
*
* COVERAGE SURFACE (frozen wording): only the surfaces Guard itself routes can
* be protected. Operations with no Guard execution surface are refused before
* any effect, and the plugin never suggests falling back to a plain shell
* command. A trusted in-process caller that bypasses Guard entirely is a host
* trust boundary and is disclosed as such in the documentation, not pretended
* away.
*/
const RELEASE_CONTRACT_PREFIX = "Context Guard release contract v1: ";
const RELEASE_RESERVATION_PREFIX = "Context Guard release reservation v1: ";
const RELEASE_SETTLEMENT_PREFIX = "Context Guard release settlement v1: ";
const RELEASE_REVOCATION_PREFIX = "Context Guard release revocation v1: ";
const RELEASE_OPERATIONS = [
	"npm_publish",
	"git_tag",
	"github_release_create",
	"github_release_update",
	"github_release_delete",
	"composite_runner"
];
/**
* The routing table for this release. `git_tag` and the GitHub Release
* operations have no Guard-owned execution route yet; the coordinator
* explicitly approved that staged scope reduction on 2026-09-14, and the new
* route is the way each of them becomes protectable. A composite runner stays
* opaque by construction.
*/
const RELEASE_OPERATION_SURFACES = {
	npm_publish: {
		surface: "context_guard_action",
		protectable: true,
		reasonCode: "release_operation_protectable",
		attribution: "implemented"
	},
	git_tag: {
		surface: "none",
		protectable: false,
		reasonCode: "release_operation_unrouted",
		attribution: "scope_reduction"
	},
	github_release_create: {
		surface: "none",
		protectable: false,
		reasonCode: "release_operation_unrouted",
		attribution: "scope_reduction"
	},
	github_release_update: {
		surface: "none",
		protectable: false,
		reasonCode: "release_operation_unrouted",
		attribution: "scope_reduction"
	},
	github_release_delete: {
		surface: "none",
		protectable: false,
		reasonCode: "release_operation_unrouted",
		attribution: "scope_reduction"
	},
	composite_runner: {
		surface: "none",
		protectable: false,
		reasonCode: "release_runner_opaque",
		attribution: "host_boundary"
	}
};
const FULL_SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SRI = /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/;
/**
* How strongly an outcome resolves the reservation. A `settled` release is
* never downgraded by a later record, while a stronger record reconciles a
* weaker one — that is how a trusted readback recovers an earlier unconfirmed
* attempt instead of being discarded.
*/
const OUTCOME_STRENGTH = {
	not_effected: 0,
	unknown: 1,
	failed: 1,
	unconfirmed: 2,
	settled: 3
};
function asRecord$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function optionalString(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
/**
* Normalize a candidate release contract from a root adoption payload. Every
* field is validated: an unparsable or partial adoption is refused rather than
* approximated, because a half-specified contract would authorize an
* unspecified candidate.
*/
function normalizeReleaseContract(raw, adoptedBy, adoptedAtRevision = 0) {
	const errors = [];
	const value = asRecord$1(raw);
	if (!value) return { errors: ["release_contract_malformed"] };
	const operations = [];
	if (!Array.isArray(value.operations) || value.operations.length === 0) errors.push("release_operations_missing");
	else for (const entry of value.operations) {
		if (typeof entry !== "string" || !RELEASE_OPERATIONS.includes(entry)) {
			errors.push("release_operation_unknown");
			continue;
		}
		const operation = entry;
		if (!RELEASE_OPERATION_SURFACES[operation].protectable) {
			errors.push(RELEASE_OPERATION_SURFACES[operation].reasonCode);
			continue;
		}
		if (!operations.includes(operation)) operations.push(operation);
	}
	const candidate = asRecord$1(value.candidate);
	if (!candidate) errors.push("release_candidate_missing");
	const CANDIDATE_FIELDS = [
		"fullSha40",
		"ref",
		"repository",
		"packageId",
		"version",
		"artifactSha256",
		"artifactSri",
		"registry",
		"artifactDigest"
	];
	for (const key of Object.keys(candidate ?? {})) if (!CANDIDATE_FIELDS.includes(key)) errors.push("release_candidate_field_unknown");
	const fullSha40 = optionalString(candidate?.fullSha40) ?? "";
	if (!FULL_SHA40.test(fullSha40)) errors.push("release_candidate_sha_invalid");
	const ref = optionalString(candidate?.ref);
	const repository = optionalString(candidate?.repository);
	const packageId = optionalString(candidate?.packageId);
	const version = optionalString(candidate?.version);
	let artifactSha256 = optionalString(candidate?.artifactSha256);
	let artifactSri = optionalString(candidate?.artifactSri);
	const legacyDigest = optionalString(candidate?.artifactDigest);
	if (legacyDigest !== void 0) if (SHA256.test(legacyDigest)) artifactSha256 ??= legacyDigest;
	else if (SRI.test(legacyDigest)) artifactSri ??= legacyDigest;
	else errors.push("release_candidate_artifact_digest_invalid");
	const registry = optionalString(candidate?.registry);
	if (artifactSha256 !== void 0 && !SHA256.test(artifactSha256)) errors.push("release_candidate_sha256_invalid");
	if (artifactSri !== void 0 && !SRI.test(artifactSri)) errors.push("release_candidate_sri_invalid");
	const readinessRefs = Array.isArray(value.readinessRefs) ? value.readinessRefs.filter((entry) => typeof entry === "string" && entry.length > 0) : [];
	const closureCertRef = optionalString(value.closureCertRef);
	let expiresAtEpochMs;
	if (value.expiresAtEpochMs !== void 0) if (typeof value.expiresAtEpochMs !== "number" || !Number.isSafeInteger(value.expiresAtEpochMs) || value.expiresAtEpochMs <= 0) errors.push("release_expiry_invalid");
	else expiresAtEpochMs = value.expiresAtEpochMs;
	if (errors.length) return { errors: [...new Set(errors)] };
	const suppliedId = optionalString(value.contractId);
	const body = {
		operations: [...operations].sort(),
		candidate: {
			fullSha40,
			...ref ? { ref } : {},
			...repository ? { repository } : {},
			...packageId ? { packageId } : {},
			...version ? { version } : {},
			...artifactSha256 ? { artifactSha256 } : {},
			...artifactSri ? { artifactSri } : {},
			...registry ? { registry } : {}
		},
		readinessRefs: [...readinessRefs].sort(),
		...closureCertRef ? { closureCertRef } : {},
		...expiresAtEpochMs !== void 0 ? { expiresAtEpochMs } : {}
	};
	return {
		contract: {
			contractId: suppliedId ?? `rel-${sha256(JSON.stringify(body)).slice(0, 16)}`,
			adoptedBy,
			adoptedAtRevision,
			operations: operations.sort(),
			candidate: body.candidate,
			readinessRefs: body.readinessRefs,
			...closureCertRef ? { closureCertRef } : {},
			...expiresAtEpochMs !== void 0 ? { expiresAtEpochMs } : {}
		},
		errors: []
	};
}
function normalizeReservation(raw) {
	const value = asRecord$1(raw);
	if (!value) return void 0;
	const contractId = optionalString(value.contractId);
	const operation = optionalString(value.operation);
	const callId = optionalString(value.callId);
	const startedAtSeq = value.startedAtSeq;
	if (!contractId || !callId) return void 0;
	if (!operation || !RELEASE_OPERATIONS.includes(operation)) return void 0;
	if (typeof startedAtSeq !== "number" || !Number.isSafeInteger(startedAtSeq)) return void 0;
	const observedArtifactSri = optionalString(value.observedArtifactSri);
	return {
		contractId,
		operation,
		callId,
		startedAtSeq,
		status: "in_flight",
		...observedArtifactSri ? { observedArtifactSri } : {}
	};
}
const RELEASE_OUTCOMES = [
	"settled",
	"unconfirmed",
	"unknown",
	"failed",
	"not_effected"
];
function normalizeSettlement(raw) {
	const value = asRecord$1(raw);
	if (!value) return void 0;
	const contractId = optionalString(value.contractId);
	const operation = optionalString(value.operation);
	const callId = optionalString(value.callId);
	const settledAtSeq = value.settledAtSeq;
	const outcome = optionalString(value.outcome);
	if (!contractId || !callId) return void 0;
	if (!operation || !RELEASE_OPERATIONS.includes(operation)) return void 0;
	if (typeof settledAtSeq !== "number" || !Number.isSafeInteger(settledAtSeq)) return void 0;
	if (!outcome || !RELEASE_OUTCOMES.includes(outcome)) return void 0;
	const readbackRaw = asRecord$1(value.readback);
	const kind = readbackRaw?.kind;
	return {
		contractId,
		operation,
		callId,
		settledAtSeq,
		readback: readbackRaw && (kind === "npm_integrity" || kind === "git_ref" || kind === "github_release") && optionalString(readbackRaw.identity) ? {
			kind,
			identity: optionalString(readbackRaw.identity)
		} : "unavailable",
		outcome
	};
}
/** The adopted, not-revoked contract that covers an operation, newest first. */
function releaseContractFor(projection, operation, contractId) {
	const contracts = projection.releaseContracts.filter((contract) => contract.revokedAtSeq === void 0 && (contractId === void 0 || contract.contractId === contractId) && contract.operations.includes(operation));
	return contracts.length ? contracts[contracts.length - 1] : void 0;
}
/** Whether a contract was explicitly revoked by a durable root command. */
function isContractRevoked(projection, contractId) {
	return projection.releaseContracts.some((contract) => contract.contractId === contractId && contract.revokedAtSeq !== void 0);
}
/**
* The reconciled settlement per (contract, operation, callId): the strongest
* outcome wins, ties resolve to the later record. A `settled` release is never
* revoked by a later weaker record.
*/
function reconciledSettlements(projection, contractId, operation) {
	const byCall = /* @__PURE__ */ new Map();
	for (const settlement of projection.releaseSettlements) {
		if (settlement.contractId !== contractId || settlement.operation !== operation) continue;
		const existing = byCall.get(settlement.callId);
		if (!existing) {
			byCall.set(settlement.callId, settlement);
			continue;
		}
		const stronger = OUTCOME_STRENGTH[settlement.outcome] > OUTCOME_STRENGTH[existing.outcome];
		const newer = OUTCOME_STRENGTH[settlement.outcome] === OUTCOME_STRENGTH[existing.outcome] && settlement.settledAtSeq >= existing.settledAtSeq;
		if (stronger || newer) byCall.set(settlement.callId, settlement);
	}
	return [...byCall.values()];
}
/** Whether a settlement releases the one-shot lock: settled, or proven no-effect. */
function releasesLock(settlement) {
	return settlement.outcome === "settled" || settlement.outcome === "not_effected";
}
/** The in-flight (unresolved) reservation for one contract operation, if any. */
function inFlightReservation(projection, contractId, operation) {
	const settled = reconciledSettlements(projection, contractId, operation);
	for (const reservation of projection.releaseReservations) {
		if (reservation.contractId !== contractId || reservation.operation !== operation) continue;
		const resolution = settled.find((settlement) => settlement.callId === reservation.callId);
		if (!resolution || !releasesLock(resolution)) return reservation;
	}
}
/** Whether a contract operation has already been consumed by a settled effect. */
function settledOperations(projection, contractId) {
	const consumed = [];
	for (const settlement of projection.releaseSettlements) {
		if (settlement.contractId !== contractId) continue;
		if (settlement.outcome !== "settled") continue;
		if (!consumed.includes(settlement.operation)) consumed.push(settlement.operation);
	}
	return consumed.sort();
}
const CANDIDATE_FIELD_CODES = [
	{
		field: "fullSha40",
		label: "commit",
		unresolvedCode: "release_candidate_sha_unresolved",
		mismatchCode: "release_candidate_sha_mismatch"
	},
	{
		field: "ref",
		label: "ref",
		unresolvedCode: "release_candidate_ref_unresolved",
		mismatchCode: "release_candidate_ref_mismatch"
	},
	{
		field: "repository",
		label: "repository",
		unresolvedCode: "release_candidate_repository_unresolved",
		mismatchCode: "release_candidate_repository_mismatch"
	},
	{
		field: "packageId",
		label: "package",
		unresolvedCode: "release_candidate_package_unresolved",
		mismatchCode: "release_candidate_package_mismatch"
	},
	{
		field: "version",
		label: "version",
		unresolvedCode: "release_candidate_version_unresolved",
		mismatchCode: "release_candidate_version_mismatch"
	},
	{
		field: "artifactSha256",
		label: "artifact SHA-256",
		unresolvedCode: "release_artifact_sha256_unresolved",
		mismatchCode: "release_candidate_artifact_mismatch"
	},
	{
		field: "artifactSri",
		label: "artifact SRI",
		unresolvedCode: "release_artifact_sri_unresolved",
		mismatchCode: "release_candidate_artifact_sri_mismatch"
	},
	{
		field: "registry",
		label: "registry",
		unresolvedCode: "release_candidate_registry_unresolved",
		mismatchCode: "release_candidate_registry_mismatch"
	}
];
/** A readiness reference resolves to a real, already-established fact. */
function readinessResolves(projection, ref) {
	if (projection.checkpoints.some((checkpoint) => checkpoint.id === ref && checkpoint.result === "certified")) return true;
	if (projection.boundaries.some((boundary) => boundary.id === ref)) return true;
	return projection.items.get(ref)?.status === "passed";
}
/**
* The pre-effect release decision. Order matters: an unprotectable surface and
* a damaged release state are refused before expiry or candidate checks,
* because running an unprotected operation is never made acceptable by a valid
* ticket, and because unreadable release state must not authorize anything.
*/
function releasePreEffectDecision(projection, request) {
	const surface = RELEASE_OPERATION_SURFACES[request.operation];
	if (!surface.protectable) return {
		status: "denied",
		reasonCode: surface.reasonCode
	};
	if (projection.releaseStateDamaged) return {
		status: "denied",
		reasonCode: "release_state_damaged"
	};
	const contract = releaseContractFor(projection, request.operation, request.contractId);
	if (!contract) {
		if (projection.releaseContracts.some((entry) => entry.revokedAtSeq !== void 0 && entry.operations.includes(request.operation) && (request.contractId === void 0 || entry.contractId === request.contractId))) return {
			status: "denied",
			reasonCode: "release_contract_revoked"
		};
		if (request.contractId !== void 0 && isContractRevoked(projection, request.contractId)) return {
			status: "denied",
			reasonCode: "release_contract_revoked"
		};
		return {
			status: "denied",
			reasonCode: projection.releaseContracts.length === 0 ? "release_contract_required" : "release_operation_not_adopted"
		};
	}
	if (contract.expiresAtEpochMs !== void 0) {
		if (request.nowEpochMs === void 0) return {
			status: "denied",
			reasonCode: "release_expiry_unevaluable",
			contractId: contract.contractId
		};
		if (request.nowEpochMs >= contract.expiresAtEpochMs) return {
			status: "denied",
			reasonCode: "release_contract_expired",
			contractId: contract.contractId
		};
	}
	if (settledOperations(projection, contract.contractId).includes(request.operation)) return {
		status: "denied",
		reasonCode: "release_operation_consumed",
		contractId: contract.contractId
	};
	if (inFlightReservation(projection, contract.contractId, request.operation)) return {
		status: "denied",
		reasonCode: "release_operation_in_flight",
		contractId: contract.contractId
	};
	for (const ref of contract.readinessRefs) if (!readinessResolves(projection, ref)) return {
		status: "denied",
		reasonCode: "release_readiness_unresolved",
		contractId: contract.contractId
	};
	const frozen = contract.frozenClosure;
	const closure = frozen !== void 0 ? projection.checkpoints.find((checkpoint) => checkpoint.id === frozen.id) : void 0;
	if (!frozen || frozen.contractRevision !== contract.adoptedAtRevision || frozen.id !== contract.closureCertRef || !closure || closure.result !== "certified" || closure.certificationDigest !== frozen.certificationDigest || closure.epoch !== projection.epoch) return {
		status: "denied",
		reasonCode: "release_closure_unresolved",
		contractId: contract.contractId
	};
	if (contract.candidate.artifactSha256 === void 0 && contract.candidate.artifactSri === void 0) return {
		status: "denied",
		reasonCode: "release_artifact_identity_required",
		contractId: contract.contractId
	};
	const candidate = contract.candidate;
	const observedIdentity = request.observed ?? {};
	const compared = [];
	for (const entry of CANDIDATE_FIELD_CODES) {
		const declared = candidate[entry.field];
		if (typeof declared !== "string") continue;
		compared.push([entry, declared]);
	}
	for (const [entry, declared] of compared) {
		const observed = observedIdentity[entry.field];
		if (observed === void 0) return {
			status: "denied",
			reasonCode: entry.unresolvedCode,
			contractId: contract.contractId
		};
		if (observed !== declared) return {
			status: "denied",
			reasonCode: entry.mismatchCode,
			contractId: contract.contractId
		};
	}
	if (candidate.ref !== void 0 && observedIdentity.refSha !== void 0 && observedIdentity.fullSha40 !== void 0 && observedIdentity.refSha !== observedIdentity.fullSha40) return {
		status: "denied",
		reasonCode: "release_ref_commit_mismatch",
		contractId: contract.contractId
	};
	const resolved = request.resolvedTarget;
	if (resolved === void 0) return {
		status: "denied",
		reasonCode: "release_target_unresolved",
		contractId: contract.contractId
	};
	if (resolved.version === void 0) return {
		status: "denied",
		reasonCode: "release_target_unresolved",
		contractId: contract.contractId
	};
	if (candidate.packageId !== void 0 && resolved.artifact_id !== candidate.packageId) return {
		status: "denied",
		reasonCode: "release_target_package_mismatch",
		contractId: contract.contractId
	};
	if (candidate.version !== void 0 && resolved.version !== candidate.version) return {
		status: "denied",
		reasonCode: "release_target_version_mismatch",
		contractId: contract.contractId
	};
	if (candidate.registry !== void 0 && resolved.registry !== candidate.registry) return {
		status: "denied",
		reasonCode: "release_target_registry_mismatch",
		contractId: contract.contractId
	};
	return {
		status: "granted",
		reasonCode: "release_contract_granted",
		contractId: contract.contractId
	};
}
/**
* Whether a trusted readback settles the attempt: the readback must name the
* SAME artifact identity the contract froze. A registry that answers with a
* different integrity proves the wrong bytes are published, which is an
* unknown outcome for this contract, never a settlement.
*/
function readbackSettlesContract(contract, readback, reservationSri) {
	if (readback === "unavailable") return "unconfirmed";
	if (readback.kind !== "npm_integrity") return "unconfirmed";
	const expected = contract.candidate.artifactSri ?? reservationSri;
	if (expected === void 0) return "unconfirmed";
	return readback.identity === expected ? "settled" : "mismatch";
}
/**
* The reservation for one call, including revoked contracts: reconciling an
* operation that was already in flight when its contract was revoked is the
* recovery case, not an authority question.
*/
function reservationFor(projection, contractId, callId) {
	return projection.releaseReservations.find((entry) => entry.contractId === contractId && entry.callId === callId);
}
/** A contract by id, INCLUDING revoked ones, for recovery lookups. */
function contractById(projection, contractId) {
	return projection.releaseContracts.find((entry) => entry.contractId === contractId);
}
/** The coverage report for one contract: which adopted operations Guard can protect. */
function releaseCoverage(contract) {
	return [...contract.operations].sort().map((operation) => ({
		operation,
		...RELEASE_OPERATION_SURFACES[operation]
	}));
}

//#endregion
//#region src/domain/derive.ts
/**
* Audited delegation tool names (C04/DS06-B). A tool result from one of these
* is a subagent's answer: bounded evidence for the unit that asked for it, and
* never a parent completion. The real names are a host tool-bundle surface —
* native acceptance pins the audited cohort, exactly like the question-tool
* allowlist — so this list is the production default and can be overridden by
* an audited cohort.
*/
const DEFAULT_DELEGATION_TOOL_NAMES = [
	"task",
	"delegate",
	"delegate_task",
	"subagent",
	"subagent_fork",
	"spawn_agent"
];
const CAPTURE_V042_NOTICE = "Context Guard capture boundary: v0.4.2";
const PROTOCOL_V3_NOTICE = "Context Guard protocol boundary: v3.0.0";
/**
* 0.5.0 first-step boundary: written at the first real root input step (never
* at session start), before the constrained root message in the same batch.
* It implies the v3 protocol and v0.4.2 capture semantics and marks the cut
* where the 0.5 confirmation syntax becomes active; earlier notices keep
* their historical meaning for replay.
*/
const PROTOCOL_V4_NOTICE = "Context Guard protocol boundary: v4.0.0";
/**
* 0.6.0 first-step boundary: same placement discipline as v4. It cuts the
* work-unit, delivery, and certificate-v2 semantics (P0 §1): messages before
* it keep their historical rules, messages after it are captured into work
* units and close through unit-closure certificates and trusted deliveries.
* An old binary ignores this notice (plugin source, unmatched pattern), so the
* fail direction on rollback is closed, never a misread.
*/
const PROTOCOL_V5_NOTICE = "Context Guard protocol boundary: v5.0.0";
function isProtocolBoundaryNotice(event, notice = PROTOCOL_V3_NOTICE) {
	if (event.type !== "user/message") return false;
	const data = asRecord(event.data);
	const source = asRecord(data?.source);
	if (source?.kind !== "plugin" || source.plugin !== "context-guard" || source.form !== "notice") return false;
	return extractTextContent(data?.content ?? []) === notice;
}
function parseArguments(raw) {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}
function asRecord(value) {
	return typeof value === "object" && value !== null ? value : void 0;
}
/** Stable JSON, used for the release adoption digest. */
function stableJson(value) {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
	return JSON.stringify(value);
}
/**
* Bounded release diagnostic ledger (last 16 entries). A rejected record also
* marks the release state damaged: an unreadable reservation, settlement or
* contract must block release operations rather than being silently forgotten,
* and it must not touch the projection's own integrity, which governs ordinary
* work.
*/
function pushReleaseDiagnostic(projection, seq, reasonCode, damaging = false) {
	if (damaging) projection.releaseStateDamaged = true;
	if (projection.releaseDiagnostics.some((entry) => entry.seq === seq && entry.reasonCode === reasonCode)) return;
	projection.releaseDiagnostics.push({
		seq,
		reasonCode
	});
	if (projection.releaseDiagnostics.length > 16) projection.releaseDiagnostics.shift();
}
function assetReceiptMatches(receipt, asset) {
	const record = asRecord(receipt);
	return record !== void 0 && record.message_seq === asset.messageSeq && record.part_index === asset.partIndex && record.media_sha256 === asset.mediaSha256;
}
/**
* Atomically supersede one unresolved clause by its recorded interpretation
* partition (0.6.1 review round 10). Every declared sub-span becomes its own
* obligation bound to the exact sub-span: information sub-spans become
* delivery-closable informational obligations; declared-unknown and
* undeclared sub-spans become pending unresolved obligations that keep the
* clause's execution and unknown demands open. Returns the ids of the
* created information sub-items.
*/
function supersedeClauseByPartition(projection, item, receipt) {
	const extent = itemExtentOf(item);
	const information = readPartitionSpans(receipt.information_spans);
	const unknown = readPartitionSpans(receipt.unknown_spans);
	if (!information || !unknown) return [];
	for (const span of [...information, ...unknown]) if (span.start < extent.start || span.end > extent.end) return [];
	const ordered = [...information, ...unknown].sort((left, right) => left.start - right.start || left.end - right.end);
	for (let index = 1; index < ordered.length; index += 1) if (ordered[index].start < ordered[index - 1].end) return [];
	const complement = [];
	let cursor = extent.start;
	for (const span of ordered) {
		if (span.start > cursor) complement.push({
			start: cursor,
			end: span.start
		});
		cursor = Math.max(cursor, span.end);
	}
	if (cursor < extent.end) complement.push({
		start: cursor,
		end: extent.end
	});
	const partIndex = (item.spans ?? [])[0]?.partIndex ?? 0;
	const rawTextSha256 = item.rawTextSha256;
	const revisionBase = projection.contractRevision;
	const informationIds = [];
	const makeSubItem = (span, informational, offset$1) => {
		const revision = revisionBase + 1 + offset$1;
		const kind = "requirement";
		const id = `${informational ? "R" : "R"}${nextNumericId(projection.items, "R")}`;
		const sub = {
			id,
			revision,
			kind,
			sourceMessageId: item.sourceMessageId,
			normalizedText: item.normalizedText,
			textSha256: item.textSha256,
			status: "pending",
			verification: {
				enforced: false,
				surface: "scope",
				subject: item.verification.subject ?? "scope"
			},
			semanticAction: "generic_run",
			requestedTarget: { scope: item.verification.subject ?? "scope" },
			targetCaptureStatus: "resolved",
			authority: item.authority,
			taskKind: informational ? "inquiry" : "action",
			directive: informational ? "informational" : void 0,
			executee: "unresolved",
			authorityDisposition: informational ? "informational" : "unresolved",
			executionQualification: item.executionQualification?.status === "granted" ? { ...item.executionQualification } : {
				status: "restricted",
				reason: "inherited_restriction",
				...item.executionQualification?.governedBy ? { governedBy: item.executionQualification.governedBy } : {}
			},
			interpretationFingerprint: `partition:${item.id}:${span.start}:${span.end}`,
			rawTextSha256,
			spans: [{
				partIndex,
				start: span.start,
				end: span.end,
				class: "instruction"
			}],
			unitId: item.unitId,
			clarifiesItemId: item.id,
			interpretedFromUnresolved: item.id
		};
		projection.items.set(id, sub);
		projection.contractRevision = Math.max(projection.contractRevision, revision);
		return sub;
	};
	let offset = 0;
	for (const span of information) {
		informationIds.push(makeSubItem(span, true, offset).id);
		offset += 1;
	}
	for (const span of [...unknown, ...complement]) {
		makeSubItem(span, false, offset);
		offset += 1;
	}
	if (informationIds.length > 0) {
		item.status = "superseded";
		item.supersededBy = informationIds[0];
	}
	return informationIds;
}
/** The next numeric id for a prefix, shared with nextId's numbering. */
function nextNumericId(items, prefix) {
	let max = 0;
	for (const item of items.values()) {
		if (!item.id.startsWith(prefix)) continue;
		const num = Number(item.id.slice(prefix.length));
		if (Number.isInteger(num) && num > max) max = num;
	}
	return max + 1;
}
function readPartitionSpans(raw) {
	if (!Array.isArray(raw)) return void 0;
	const spans = [];
	for (const entry of raw) {
		const record = asRecord(entry);
		const start = record?.start;
		const end = record?.end;
		if (typeof start !== "number" || !Number.isSafeInteger(start) || typeof end !== "number" || !Number.isSafeInteger(end) || start >= end) return void 0;
		spans.push({
			start,
			end
		});
	}
	return spans;
}
function itemExtentOf(item) {
	const spans = item.spans ?? [];
	if (spans.length === 0) return {
		start: 0,
		end: 0
	};
	return {
		start: Math.min(...spans.map((span) => span.start)),
		end: Math.max(...spans.map((span) => span.end))
	};
}
/**
* Replay validation of a clause-kind interpretation: the CALL's partition
* (from the persisted tool/call arguments) must be present and structurally
* valid against the obligation's extent, the receipt's echoed spans must
* match the contract's spans, and the receipt's partition must EQUAL the
* call's partition. A receipt that redraws the partition — replacing a
* submitted unknown span with an information claim — is tampering.
*/
function clauseCallReceiptMatches(callInformation, callUnknown, recorded, item) {
	const spans = item.spans ?? [];
	const echoed = recorded.spans;
	if (!Array.isArray(echoed) || echoed.length !== spans.length) return false;
	if (!spans.every((span, index) => {
		const echo = asRecord(echoed[index]);
		return echo !== void 0 && echo.part_index === span.partIndex && echo.start === span.start && echo.end === span.end;
	})) return false;
	if (callInformation === void 0 || callUnknown === void 0 || callInformation.length === 0) return false;
	const extent = itemExtentOf(item);
	const allCall = [...callInformation, ...callUnknown];
	for (const span of allCall) if (span.start < extent.start || span.end > extent.end) return false;
	const orderedCall = [...allCall].sort((left, right) => left.start - right.start || left.end - right.end);
	for (let index = 1; index < orderedCall.length; index += 1) if (orderedCall[index].start < orderedCall[index - 1].end) return false;
	const receiptInformation = readPartitionSpans(recorded.information_spans);
	const receiptUnknown = readPartitionSpans(recorded.unknown_spans);
	if (receiptInformation === void 0 || receiptUnknown === void 0) return false;
	return samePartition(receiptInformation, receiptUnknown, callInformation, callUnknown);
}
function samePartition(leftInformation, leftUnknown, rightInformation, rightUnknown) {
	const normalize = (information, unknown) => {
		const ordered = [...information.map((span) => ({
			...span,
			information: true
		})), ...unknown.map((span) => ({
			...span,
			information: false
		}))].sort((left, right) => left.start - right.start || left.end - right.end);
		return JSON.stringify(ordered.map((span) => [
			span.start,
			span.end,
			span.information
		]));
	};
	return normalize(leftInformation, leftUnknown) === normalize(rightInformation, rightUnknown);
}
/**
* Whether a recorded certificate is exactly the certificate this log re-derives.
*
* The comparison is by FIELD SEMANTICS, not by JSON text: a tool output is a
* JSON object whose property order is an artifact of serialization, so
* `JSON.stringify` equality made an identical certificate replay as corrupt
* whenever the writer emitted `unit_id` before `goal_ref` (or vice versa). The
* field set is still exact — an extra, missing, or renamed field stays a
* mismatch — and values are compared by canonical encoding, so tampering is as
* detectable as before.
*/
function recordedCertificateMatches(recorded, checkpoint) {
	const value = asRecord(recorded);
	if (!value) return false;
	const goal = asRecord(value.goal_ref);
	const exact = {
		stop_protocol_version: checkpoint.stopProtocolVersion,
		certificate_version: checkpoint.certificateVersion,
		epoch: checkpoint.epoch,
		session_ref_digest: checkpoint.sessionRefDigest,
		host_lock_digest: checkpoint.hostLockDigest,
		contract_revision: checkpoint.contractRevision,
		contract_sha256: checkpoint.contractSha256,
		open_digest: checkpoint.openDigest,
		evidence_sha256: checkpoint.evidenceSha256,
		binding_digest: checkpoint.bindingDigest,
		certification_digest: checkpoint.certificationDigest,
		goal_ref: checkpoint.goalRef ?? null
	};
	if (checkpoint.unitId !== void 0) {
		exact.unit_id = checkpoint.unitId;
		exact.unit_closure_digest = checkpoint.unitClosureDigest;
	}
	const normalized = {
		...value,
		goal_ref: goal ? {
			id: goal.id,
			revision: goal.revision
		} : value.goal_ref
	};
	const expectedKeys = Object.keys(exact).sort();
	const actualKeys = Object.keys(normalized).sort();
	if (expectedKeys.length !== actualKeys.length) return false;
	return expectedKeys.every((key, index) => key === actualKeys[index] && stableJson(normalized[key]) === stableJson(exact[key]));
}
/**
* The proof binding state the log itself implies for one checkpoint call. This
* is the same computation the signing tool performs, replayed against the
* projection derived up to that call.
*/
function replayProofState(projection, proof) {
	if (proof === void 0) return {
		status: "absent",
		reason_codes: []
	};
	const structural = validateProofManifestV2(proof);
	if (structural.length) return {
		status: "invalid",
		reason_codes: [...structural].sort()
	};
	const binding = bindProofV2ToProjection(projection, proof);
	return binding.length ? {
		status: "rejected",
		reason_codes: [...binding].sort()
	} : {
		status: "bound",
		reason_codes: []
	};
}
/** Bounded set equality for reason-code lists, order-insensitive. */
function sameStringSet(recorded, expected) {
	if (!Array.isArray(recorded)) return false;
	const left = [...new Set(recorded.filter((entry) => typeof entry === "string"))].sort();
	const right = [...new Set(expected)].sort();
	return left.length === right.length && left.every((value, index) => value === right[index]);
}
/**
* Freeze the closure certificate the adopter relied on, resolved AT the
* adoption watermark. Only the checkpoints restored so far existed then, so a
* certificate that appears LATER in the log can never ratify an earlier
* adoption; an unresolvable reference is recorded as unresolved rather than
* left open for a future entry to satisfy.
*/
function freezeAdoptionClosure(projection, contract) {
	const ref = contract.closureCertRef;
	const closure = ref !== void 0 ? projection.checkpoints.find((checkpoint) => checkpoint.id === ref && checkpoint.result === "certified") : void 0;
	return closure === void 0 ? contract : {
		...contract,
		frozenClosure: {
			id: closure.id,
			certificationDigest: closure.certificationDigest,
			epoch: closure.epoch,
			contractRevision: closure.contractRevision
		}
	};
}
function restoreHistoricalCheckpoint(recorded, bindings, id) {
	const stringField = (name) => typeof recorded[name] === "string" ? recorded[name] : void 0;
	const epoch = recorded.epoch;
	const revision = recorded.contract_revision;
	const goal = asRecord(recorded.goal_ref);
	if (!Number.isSafeInteger(epoch) || !Number.isSafeInteger(revision)) return void 0;
	if ([
		"stop_protocol_version",
		"certificate_version",
		"session_ref_digest",
		"host_lock_digest",
		"contract_sha256",
		"open_digest",
		"evidence_sha256",
		"binding_digest",
		"certification_digest"
	].some((name) => !stringField(name))) return void 0;
	if (goal && (typeof goal.id !== "string" || !Number.isSafeInteger(goal.revision))) return void 0;
	if (recorded.unit_id !== void 0 && (typeof recorded.unit_id !== "string" || !stringField("unit_closure_digest"))) return void 0;
	return {
		id,
		stopProtocolVersion: stringField("stop_protocol_version"),
		certificateVersion: stringField("certificate_version"),
		epoch,
		sessionRefDigest: stringField("session_ref_digest"),
		hostLockDigest: stringField("host_lock_digest"),
		contractRevision: revision,
		contractSha256: stringField("contract_sha256"),
		openDigest: stringField("open_digest"),
		evidenceSha256: stringField("evidence_sha256"),
		bindingDigest: stringField("binding_digest"),
		bindings,
		...goal ? { goalRef: {
			id: goal.id,
			revision: goal.revision
		} } : {},
		...typeof recorded.unit_id === "string" ? {
			unitId: recorded.unit_id,
			unitClosureDigest: stringField("unit_closure_digest")
		} : {},
		certificationDigest: stringField("certification_digest"),
		result: "certified"
	};
}
function nextId(items, kind) {
	const prefix = kind === "requirement" ? "R" : kind === "acceptance" ? "A" : "P";
	let max = 0;
	for (const item of items.values()) {
		if (item.kind !== kind) continue;
		const num = Number(item.id.slice(prefix.length));
		if (Number.isInteger(num) && num > max) max = num;
	}
	return `${prefix}${String(max + 1).padStart(3, "0")}`;
}
/** Framing-only instruction clauses carry no task substance and never close. */
const FRAMING_ZH = /^(?:请)?(?:完成|执行|按|按照|遵循|满足)?(?:以下|如下|下面|下列)?(?:完整|全部)?(?:任务|要求|事项|需求|指令|说明)$/;
const FRAMING_EN = /^(?:please\s+)?(?:complete|do|perform|follow|satisfy)?\s*(?:the\s+)?(?:following|below)?\s*(?:full\s+|whole\s+)?(?:task|tasks|requirement|requirements|instruction|instructions)$/i;
function isInstructionFraming(body) {
	return FRAMING_ZH.test(body) || FRAMING_EN.test(body);
}
/** Resolve a contract artifact path against the session working directory. */
function resolveArtifact(path$1, scope) {
	if (!scope.cwd) return path$1;
	if (/^[A-Za-z]:[\\/]/.test(path$1) || path$1.startsWith("/") || path$1.startsWith("\\")) return path$1;
	return `${scope.cwd.replace(/[\\/]+$/, "")}/${path$1}`;
}
/**
* Capture one canonical root text through the authority-block segmentation.
* `prefix` keeps the historical `m<seq>` source identity; a remainder uses
* `m<seq>:r` so confirmation follow-ups stay traceable to their message.
*
* `legacy` marks a message that predates the first protocol boundary in this
* log. Capture semantics are now version-independent (see `domain/semantics.ts`),
* but a pre-boundary message keeps the historical authority relabelling rule:
* an item whose action/target could not be derived deterministically stays
* `legacy_authority_unclassified` instead of being retroactively authorized.
*/
function captureRootText(projection, text, seq, scope, legacy, priorRootMessages, prefix = `m${seq}`, coordinationSplit = true, unitId, clarification = false) {
	const blocks = segmentAuthorityBlocks(text, priorRootMessages);
	const provenance = legacy ? void 0 : {
		rawTextSha256: sha256(text),
		rawText: text
	};
	let coveredSpans = 0;
	let blockCursor = 0;
	for (const block$1 of blocks) {
		if (!block$1.capture) continue;
		let blockOffset;
		if (provenance) {
			const at = provenance.rawText.indexOf(block$1.text, blockCursor);
			if (at >= 0) {
				blockCursor = at + 1;
				blockOffset = utf8ByteOffset(provenance.rawText, at);
			}
		}
		coveredSpans += insertItems(projection, block$1.text, `${prefix}:${block$1.blockId}`, scope, block$1.authority === "root_adoption" ? "root_adoption" : "root_instruction", legacy, block$1.kind === "instruction" || block$1.authority === "root_adoption", coordinationSplit, unitId, provenance ? {
			...provenance,
			blockOffset,
			blockText: block$1.text,
			blockAuthority: block$1.authority
		} : void 0, clarification ? text : void 0);
	}
	if (provenance) {
		projection.coverage.push({
			seq,
			rawTextSha256: provenance.rawTextSha256,
			byteLength: utf8ByteLength(provenance.rawText),
			coveredSpans
		});
		if (projection.coverage.length > 16) projection.coverage.shift();
	}
	priorRootMessages.push(text);
	if (priorRootMessages.length > 16) priorRootMessages.shift();
}
/**
* Insert every independently tracked clause from one user message. Compound
* instructions are segmented and each distinct artifact path becomes its own
* item, so evidence for one file cannot close a message that also covers other
* files or embeds prohibitions.
*/
function insertItems(projection, text, sourceMessageId, scope, authority = "root_instruction", legacy = false, legacyAuthorityProven = false, coordinationSplit = true, unitId, provenance, clarificationText) {
	const before = new Set(projection.items.keys());
	let coveredSpans = 0;
	const usedOccurrences = /* @__PURE__ */ new Set();
	for (const segment of segmentClauses(text, { coordinationSplit })) {
		if (classifyUserInteraction(segment.body) === "conversational") continue;
		if (segment.kind === "requirement" && segment.paths.length === 0 && isInstructionFraming(segment.body)) continue;
		let span;
		if (provenance) {
			let at = provenance.blockText.indexOf(segment.text);
			while (at >= 0 && usedOccurrences.has(at)) at = provenance.blockText.indexOf(segment.text, at + 1);
			if (at >= 0) {
				usedOccurrences.add(at);
				const start = (provenance.blockOffset ?? 0) + utf8ByteOffset(provenance.blockText, at);
				span = {
					partIndex: 0,
					start,
					end: start + utf8ByteLength(segment.text),
					class: spanClassOf(segment.kind, segment.interpretation.directive, provenance.blockAuthority)
				};
			}
		}
		if (span) coveredSpans += 1;
		if (segment.paths.length === 0) {
			insert(projection, segment, sourceMessageId, scope.cwd || "scope", "scope", unitId, provenance ? {
				rawTextSha256: provenance.rawTextSha256,
				span
			} : void 0);
			continue;
		}
		for (const path$1 of segment.paths) insert(projection, segment, sourceMessageId, resolveArtifact(path$1, scope), "artifact", unitId, provenance ? {
			rawTextSha256: provenance.rawTextSha256,
			span
		} : void 0);
	}
	for (const [id, item] of projection.items) {
		if (before.has(id)) continue;
		if (item.kind !== "requirement" || item.waitAuthorization || item.authorityDisposition === "conditional_wait") continue;
		if (item.authorityDisposition !== void 0 && item.authorityDisposition !== "executable_now") continue;
		for (const [otherId, other] of projection.items) {
			if (otherId === id || other.status !== "pending") continue;
			if (!other.waitAuthorization || other.kind !== "requirement") continue;
			if (other.semanticAction !== item.semanticAction) continue;
			const action = item.semanticAction;
			if (!action || !isStatefulAction(action)) continue;
			if (!requestedTargetMatchesResolved(action, other.requestedTarget, item.requestedTarget)) continue;
			supersedeItem(projection.items, otherId, item);
			break;
		}
	}
	if (clarificationText) for (const [id, item] of projection.items) {
		if (before.has(id)) continue;
		if (item.kind === "prohibition" || item.status !== "pending") continue;
		if (item.authorityDisposition !== "executable_now") continue;
		if (!item.semanticAction || item.semanticAction === "generic_run") continue;
		for (const [otherId, other] of projection.items) {
			if (otherId === id || !before.has(otherId)) continue;
			if (other.status !== "pending" || other.kind === "prohibition") continue;
			if (other.waitAuthorization || other.legacyFlags?.length) continue;
			if (!(other.semanticAction === "generic_run" && (other.authorityDisposition === "executable_now" || other.authorityDisposition === "unresolved"))) continue;
			if (other.normalizedText.length < 4) continue;
			if (!clarificationText.includes(other.normalizedText)) continue;
			if (other.verification.subject !== item.verification.subject) continue;
			supersedeItem(projection.items, otherId, item);
			item.clarifiesItemId = otherId;
			break;
		}
	}
	for (let round = 0; round < 8; round += 1) {
		const unresolved = [...projection.items].filter(([id, item]) => !before.has(id) && item.targetSource?.kind === "environment_default");
		if (unresolved.length === 0) break;
		let resolvedAny = false;
		for (const [, item] of unresolved) {
			resolveInheritedGitTarget(projection, item);
			if (item.targetSource?.kind === "unit_inherited") resolvedAny = true;
		}
		if (!resolvedAny) break;
	}
	for (const [id, item] of projection.items) {
		if (before.has(id)) continue;
		if (legacy) if (legacyAuthorityProven && item.semanticAction !== void 0 && item.semanticAction !== "generic_run" && item.targetCaptureStatus === "resolved") {
			item.authority = authority;
			item.legacyFlags = void 0;
		} else {
			item.authority = "legacy_authority_unclassified";
			item.semanticAction = "generic_run";
			item.legacyFlags = ["legacy_generic_run", "legacy_authority_unclassified"];
		}
		else item.authority = authority;
	}
	return coveredSpans;
}
/** The 0.6.3 eligibility check identity for a legacy record's own reading. */
const ELIGIBILITY_CHECK_ID = "eligibility:0.6.3";
/**
* Mark one item as needing review (0.6.3 K4). Idempotent: the first reason and
* its recorded revision stay, so a reload of the same log produces the same
* fact and never re-marks or re-dates it.
*/
function markNeedsReview(item, reason, revision) {
	if (item.needsReview) return;
	item.needsReview = {
		reason,
		checkId: ELIGIBILITY_CHECK_ID,
		recordedAtRevision: revision
	};
}
/**
* Whether a record's own reading still names work of its own, which makes an
* information reading of it unsafe to inherit (0.6.3 K4, F062-01).
*
* The check re-reads the record's OWN bytes with the current scope rules and
* asks whether a comma/semicolon run of them orders anything. It never rewrites
* the record and never re-decides the historical answer: it decides only
* whether today's eligibility layer may treat that answer as a current pass.
*/
function informationReadingNamesWork(text) {
	const masked = maskCodeSpans(text);
	if (!legacyQuestionReadingIsInformational(masked)) return false;
	const scopes = interpretMessage(masked);
	if (scopes.length === 0) return false;
	return scopes.some((scope) => scope.authorityDisposition !== "informational");
}
/**
* The pure upgrade-eligibility predicate: the records in the current closure
* scope that may NOT be inherited as a current pass, with the reason that
* disqualifies each. Exported so the rule can be tested and read back directly,
* never to let a caller skip it.
*/
function legacyRecordsNeedingReview(projection) {
	return eligibilityReviewReasons(projection).map(([itemId, reason]) => ({
		itemId,
		reason
	}));
}
/**
* The eligibility findings for the current closure scope, as `[itemId, reason]`
* pairs. The scope is the current unit plus its required descendants, plus every
* unit-less (pre-v5) record, which keeps its birth rules; the selection is made
* on the RECORD's own scope and never on a terminal status, so an item already
* `answered` or `passed` inside the scope is still seen while another unit's
* record never leaks in.
*/
function eligibilityReviewReasons(projection) {
	const closureUnits = projection.boundaryProtocol === 5 && projection.currentUnitId !== void 0 ? new Set([projection.currentUnitId, ...unitDescendantIds(projection, projection.currentUnitId)]) : void 0;
	const findings = [];
	for (const item of projection.items.values()) {
		if (item.status === "superseded") continue;
		if (closureUnits !== void 0 && item.unitId !== void 0 && !closureUnits.has(item.unitId)) continue;
		if (item.needsReview) continue;
		const recordedVersion = item.stateVersion;
		if (recordedVersion !== void 0 && recordedVersion !== 1) {
			findings.push([item.id, "unknown_state_version"]);
			continue;
		}
		const informationReading = item.directive === "informational" || item.authorityDisposition === "informational" || item.taskKind === "inquiry";
		if (informationReading && informationReadingNamesWork(item.normalizedText)) {
			findings.push([item.id, "legacy_mixed_information_scope"]);
			continue;
		}
		if ((item.semanticAction === "commit" || item.semanticAction === "push" || item.semanticAction === "pull" || item.semanticAction === "fetch") && item.targetCaptureStatus === "resolved" && item.targetSource === void 0) {
			findings.push([item.id, "legacy_environment_default_target"]);
			continue;
		}
		if (item.executionQualification === void 0 && !informationReading) findings.push([item.id, "legacy_missing_execution_qualification"]);
	}
	return findings;
}
/**
* Apply the 0.6.3 eligibility pass to an already-derived projection.
*
* This is the upgrade entry: it re-checks the records a session already holds
* after an EVENT-SOURCED reading has been applied to them. It is idempotent —
* a project already marked keeps its original reason and revision — and it is
* the same function the derivation runs, so a replay and an in-place upgrade
* cannot disagree.
*/
function applyUpgradeEligibility(projection) {
	for (const [itemId, reason] of eligibilityReviewReasons(projection)) {
		const item = projection.items.get(itemId);
		if (item) markNeedsReview(item, reason, projection.contractRevision);
	}
}
/**
* The identity two repository references share when they are the same object.
* A textual path is compared with its trailing separators removed, so three
* clauses that all name /repo-b collapse onto one candidate. Comparison is
* deliberately conservative: only spellings of the same path collapse, and a
* different path stays a different candidate.
*/
function canonicalRepositoryKey(repository) {
	return repository.trim().replace(/[\\/]+$/, "");
}
/**
* The git actions whose named repository is one and the same user selection.
* "推送仓库 /work/repo" authorizes the commit of that same repository too, so a
* later short reference ("提交并推送") inherits the selection rather than
* asking again or falling back to the session directory.
*/
const GIT_TARGET_ACTIONS = [
	"commit",
	"push",
	"pull",
	"fetch"
];
/**
* Resolve a git obligation whose clause named no repository (0.6.3 K2).
*
* The session working directory is environment context, so it never becomes
* the user's choice by itself. A later "提交并推送" may instead inherit the
* repository from the SAME work unit when exactly ONE candidate holds an
* auditable user selection (an explicit name or path, a confirmed host
* selection, or a target that was itself inherited from one).
*
* A candidate has to be a POSITIVE, still-authorized work object, which is what
* an earlier round of this batch got wrong: a prohibition that names /repo-b
* forbids pushing THERE and never selects it. So a source must be a pending,
* non-legacy requirement whose disposition is `executable_now`, with no wait or
* condition and a resolved target, and candidates are compared by repository
* IDENTITY rather than per item, so three clauses naming /repo-b are one
* candidate. Two or more distinct repositories stay ambiguous and produce a
* minimal clarification request; none leaves the target missing.
*/
function resolveInheritedGitTarget(projection, item) {
	if (item.targetSource?.kind !== "environment_default") return;
	if (!item.semanticAction || !GIT_TARGET_ACTIONS.includes(item.semanticAction)) return;
	const candidates = [];
	for (const [otherId, other] of projection.items) {
		if (otherId === item.id || other.status !== "pending") continue;
		if (other.kind !== "requirement") continue;
		if (!other.semanticAction || !GIT_TARGET_ACTIONS.includes(other.semanticAction)) continue;
		if (other.authorityDisposition !== void 0 && other.authorityDisposition !== "executable_now") continue;
		if (other.waitAuthorization !== void 0) continue;
		if (other.legacyFlags?.length) continue;
		if (other.targetCaptureStatus !== "resolved") continue;
		if (other.unitId !== item.unitId) continue;
		const source = other.targetSource?.kind;
		if (source === void 0 || source === "environment_default") continue;
		if (typeof other.requestedTarget?.repository !== "string") continue;
		candidates.push(other);
	}
	const repositories = /* @__PURE__ */ new Map();
	for (const candidate of candidates) {
		const key = canonicalRepositoryKey(candidate.requestedTarget.repository);
		const group = repositories.get(key);
		if (group) group.push(candidate);
		else repositories.set(key, [candidate]);
	}
	if (repositories.size === 1) {
		const group = [...repositories.values()][0];
		const source = group[0];
		const identityField = requestedIdentityKey(item.semanticAction ?? "generic_run");
		const accepted = new Set(ACTION_MANIFEST.actions[item.semanticAction ?? "generic_run"].resolvedTargetKeys);
		const environmentDefaultIdentity = item.targetSource?.kind === "environment_default" && item.requestedTarget?.[identityField ?? ""] !== void 0;
		const merged = {};
		for (const [key, value] of Object.entries(item.requestedTarget ?? {})) {
			if (!accepted.has(key)) continue;
			if (key === identityField && environmentDefaultIdentity) continue;
			merged[key] = value;
		}
		let ambiguousField;
		for (const key of accepted) {
			if (Object.hasOwn(merged, key)) continue;
			const values = group.map((candidate) => candidate.requestedTarget?.[key]).filter((value) => value !== void 0);
			if (values.length === 0) continue;
			if (new Set(values.map((value) => key === "repository" && typeof value === "string" ? canonicalRepositoryKey(value) : JSON.stringify(value))).size > 1) {
				ambiguousField = key;
				continue;
			}
			merged[key] = values[0];
		}
		if (ambiguousField !== void 0) {
			item.requestedTarget = merged;
			item.targetCaptureStatus = "clarification_required";
			item.targetCaptureReasonCode = "requested_target_field_ambiguous";
			return;
		}
		if (identityField === void 0 || merged[identityField] === void 0) {
			item.targetCaptureStatus = "clarification_required";
			item.targetCaptureReasonCode = "requested_target_repository_missing";
			return;
		}
		item.requestedTarget = merged;
		item.targetSource = {
			kind: "unit_inherited",
			inheritedFrom: source.id
		};
		item.targetCaptureStatus = "resolved";
		delete item.targetCaptureReasonCode;
		return;
	}
	item.targetCaptureStatus = "clarification_required";
	item.targetCaptureReasonCode = repositories.size > 1 ? "requested_target_repository_ambiguous" : "requested_target_repository_missing";
}
function insert(projection, segment, sourceMessageId, subject, surface, unitId, provenance) {
	const revision = projection.contractRevision + 1;
	const id = nextId(projection.items, segment.kind);
	const method = extractMethod(segment.body);
	const operation = extractOperation(segment.body);
	const item = captureItem(segment.kind, segment.body, sourceMessageId, id, revision, subject, surface, method, operation, segment.interpretation);
	if (unitId !== void 0) item.unitId = unitId;
	resolveInheritedGitTarget(projection, item);
	if (provenance) {
		item.rawTextSha256 = provenance.rawTextSha256;
		if (provenance.span) item.spans = [provenance.span];
	}
	const duplicate = [...projection.items.values()].find((existing) => existing.kind === segment.kind && existing.status === "pending" && existing.textSha256 === item.textSha256 && existing.verification.subject === subject);
	if (duplicate) supersedeItem(projection.items, duplicate.id, item);
	else projection.items.set(id, item);
	projection.contractRevision = item.revision;
	return item;
}
/**
* Pure, deterministic re-derivation of the guard projection from the DSH
* native event log. Context Guard never writes custom session events, so every
* piece of state is derived from `command/run`, `user/message`, `tool/call`,
* `tool/result`, `tool/ptc-dispatch-start`, `tool/ptc-dispatch`, and
* `compaction/summary`.
*/
function deriveProjection(sourceEvents, config, scope, durableConfirmed, hostLock = DEFAULT_HOST_LOCK) {
	const projection = createProjection();
	projection.policy = config.policy ?? "standard";
	if (scope.sessionHeader) projection.sessionRefDigest = sessionRefDigest(scope.sessionHeader);
	projection.hostLockDigest = hostLock.digest;
	projection.hostStatus = hostLock.status;
	projection.hostReasonCode = hostLock.reasonCode;
	projection.hostCohortId = hostLock.cohortId;
	let enabled = config.activation === "always";
	let epoch = 0;
	let evidenceCounter = 0;
	let compacted = false;
	let enablementTransitioned = false;
	let lastCompactionSeq = -1;
	const pendingCalls = /* @__PURE__ */ new Map();
	const v5BoundarySeq = sourceEvents.find((event) => isProtocolBoundaryNotice(event, PROTOCOL_V5_NOTICE))?.seq;
	const v4BoundarySeq = sourceEvents.find((event) => isProtocolBoundaryNotice(event, PROTOCOL_V4_NOTICE))?.seq;
	const protocolBoundarySeq = sourceEvents.find((event) => isProtocolBoundaryNotice(event) || isProtocolBoundaryNotice(event, PROTOCOL_V4_NOTICE) || isProtocolBoundaryNotice(event, PROTOCOL_V5_NOTICE))?.seq;
	const captureBoundarySeq = sourceEvents.find((event) => isProtocolBoundaryNotice(event, CAPTURE_V042_NOTICE) || isProtocolBoundaryNotice(event, PROTOCOL_V4_NOTICE) || isProtocolBoundaryNotice(event, PROTOCOL_V5_NOTICE))?.seq;
	const priorRootMessages = [];
	let realRootInputSeen = false;
	const trustedDeliveries = (v5BoundarySeq !== void 0 ? deriveTrustedDeliveries(sourceEvents) : []).filter((delivery) => delivery.turnEndSeq > v5BoundarySeq);
	let deliveryCursor = 0;
	const reviewedItemIds = (view) => eligibilityReviewReasons(view).map(([id]) => id);
	const interpretationFacts = [];
	const applyDeliveriesUpTo = (seq) => {
		while (deliveryCursor < trustedDeliveries.length && trustedDeliveries[deliveryCursor].turnEndSeq <= seq) {
			const delivery = trustedDeliveries[deliveryCursor];
			deliveryCursor += 1;
			const inputSeqs = turnRootInputSeqs.get(delivery.turn);
			if (!inputSeqs) continue;
			const owningUnitId = turnUnitIds.get(delivery.turn);
			const eligibleUnitIds = owningUnitId === void 0 ? void 0 : new Set([owningUnitId, ...unitDescendantIds(projection, owningUnitId)]);
			const reviewItemIds = new Set(reviewedItemIds(projection));
			for (const itemId of informationItemIdsForDelivery(projection.items, delivery, inputSeqs, eligibleUnitIds, interpretationFacts)) {
				if (reviewItemIds.has(itemId)) continue;
				const item = projection.items.get(itemId);
				if (!item || item.status !== "pending") continue;
				const sourceSeq = /^m(\d+)(?::|$)/.exec(item.sourceMessageId);
				if (!sourceSeq || Number(sourceSeq[1]) <= v5BoundarySeq) continue;
				item.status = "answered";
				item.answeredBy = {
					turn: delivery.turn,
					responseSeq: delivery.responseSeq,
					responseSha256: delivery.responseSha256
				};
			}
		}
	};
	const turnRootInputSeqs = /* @__PURE__ */ new Map();
	const turnUnitIds = /* @__PURE__ */ new Map();
	let activeTurn;
	const unitSemanticsActive = () => v5BoundarySeq !== void 0 && !scope.sessionHeader?.parentSession && !scope.sessionHeader?.delegationDepth && scope.sessionHeader?.origin !== "subagent";
	for (const event of sourceEvents) {
		projection.enabled = enabled;
		projection.lastObservedSourceSeq = Math.max(projection.lastObservedSourceSeq, event.seq);
		applyDeliveriesUpTo(event.seq);
		switch (event.type) {
			case "command/run": {
				const data = asRecord(event.data);
				if (data?.name !== "context-guard") break;
				if (asRecord(data.source)?.kind !== "user") break;
				const subcommand = typeof data.args === "string" ? data.args.trim().split(/\s+/, 1)[0] : "";
				if (subcommand === "on" && !enabled) {
					enabled = true;
					epoch += 1;
					enablementTransitioned = true;
					projection.epoch = epoch;
				} else if (subcommand === "off") enabled = false;
				else if (subcommand === "clear") {
					const revision = projection.contractRevision + 1;
					for (const item of projection.items.values()) {
						if (item.kind === "prohibition" || item.status !== "pending") continue;
						item.status = "superseded";
						item.supersededBy = `CLEAR:${revision}`;
					}
					projection.contractRevision = revision;
				} else if (subcommand === "release") {
					const rest = typeof data.args === "string" ? data.args.trim().slice(7).trim() : "";
					const revoke = /^revoke(?:\s+(\S+))?$/.exec(rest);
					if (revoke) {
						const contractId = revoke[1] ?? "";
						const contract = projection.releaseContracts.find((entry) => entry.contractId === contractId);
						if (!contract) pushReleaseDiagnostic(projection, event.seq, "release_contract_revocation_unknown");
						else if (contract.revokedAtSeq === void 0) contract.revokedAtSeq = event.seq;
						break;
					}
					const match = /^adopt(?:\s+([\s\S]+))?$/.exec(rest);
					if (match) {
						const payload = parseArguments((match[1] ?? "").trim());
						const normalized = normalizeReleaseContract(payload, {
							seq: event.seq,
							digest: sha256(stableJson(payload))
						}, projection.contractRevision);
						if (!normalized.contract) for (const code of normalized.errors) pushReleaseDiagnostic(projection, event.seq, code);
						else if (!projection.releaseContracts.some((contract) => contract.contractId === normalized.contract.contractId)) projection.releaseContracts.push(freezeAdoptionClosure(projection, normalized.contract));
					} else if (rest.length > 0 && !/^status$/.test(rest)) pushReleaseDiagnostic(projection, event.seq, "release_subcommand_unknown");
				}
				break;
			}
			case "compaction/summary":
				compacted = true;
				lastCompactionSeq = event.seq;
				break;
			case "turn/start": {
				const started = asRecord(event.data);
				if (typeof started?.turn === "number" && Number.isSafeInteger(started.turn)) {
					projection.hostTurn = started.turn;
					activeTurn = started.turn;
				}
				break;
			}
			case "turn/end": {
				const ended = asRecord(event.data);
				if (typeof ended?.turn === "number" && Number.isSafeInteger(ended.turn)) activeTurn = void 0;
				break;
			}
			case "user/message": {
				if (isProtocolBoundaryNotice(event, PROTOCOL_V5_NOTICE)) {
					projection.boundaryProtocol = 5;
					break;
				}
				if (isProtocolBoundaryNotice(event) || isProtocolBoundaryNotice(event, CAPTURE_V042_NOTICE) || isProtocolBoundaryNotice(event, PROTOCOL_V4_NOTICE)) break;
				{
					const record = asRecord(event.data);
					const recordSource = asRecord(record?.source);
					const recordText = extractTextContent(record?.content ?? []);
					if (recordSource?.kind === "plugin" && recordSource.plugin === "context-guard" && recordText.startsWith(NO_PROGRESS_RECORD_PREFIX)) {
						const parsed = asRecord(parseArguments(recordText.slice(NO_PROGRESS_RECORD_PREFIX.length)));
						const fingerprint$1 = typeof parsed?.fingerprint === "string" ? parsed.fingerprint : void 0;
						const attempt = typeof parsed?.attempt === "number" && Number.isSafeInteger(parsed.attempt) && parsed.attempt > 0 ? parsed.attempt : void 0;
						const boundaryKey = typeof parsed?.boundaryKey === "string" ? parsed.boundaryKey : void 0;
						if (fingerprint$1 && attempt !== void 0 && boundaryKey !== void 0) {
							const claims = projection.noProgressClaims.get(fingerprint$1) ?? /* @__PURE__ */ new Map();
							if (!claims.has(boundaryKey)) claims.set(boundaryKey, attempt);
							projection.noProgressClaims.set(fingerprint$1, claims);
						}
						break;
					}
					if (recordSource?.kind === "plugin" && recordSource.plugin === "context-guard" && recordText.startsWith(CONTROL_RECORD_PREFIX)) {
						const parsed = asRecord(parseArguments(recordText.slice(CONTROL_RECORD_PREFIX.length)));
						const rootSeq = typeof parsed?.rootSeq === "number" && Number.isSafeInteger(parsed.rootSeq) ? parsed.rootSeq : void 0;
						if (rootSeq !== void 0) projection.handledControlSeqs.add(rootSeq);
						break;
					}
					if (recordSource?.kind === "plugin" && recordSource.plugin === "context-guard") {
						if (recordText.startsWith(RELEASE_CONTRACT_PREFIX)) {
							const payload = parseArguments(recordText.slice(RELEASE_CONTRACT_PREFIX.length));
							const adoptionSeq = typeof payload.adoptedBySeq === "number" && Number.isSafeInteger(payload.adoptedBySeq) ? payload.adoptedBySeq : event.seq;
							const normalized = normalizeReleaseContract(asRecord(payload.contract) ?? payload, {
								seq: adoptionSeq,
								digest: sha256(stableJson(payload.contract ?? null))
							}, projection.contractRevision);
							if (!normalized.contract) for (const code of normalized.errors) pushReleaseDiagnostic(projection, event.seq, code, true);
							else if (!projection.releaseContracts.some((contract) => contract.contractId === normalized.contract.contractId)) projection.releaseContracts.push(freezeAdoptionClosure(projection, normalized.contract));
							break;
						}
						if (recordText.startsWith(RELEASE_RESERVATION_PREFIX)) {
							const reservation = normalizeReservation(parseArguments(recordText.slice(RELEASE_RESERVATION_PREFIX.length)));
							if (!reservation) pushReleaseDiagnostic(projection, event.seq, "release_reservation_malformed", true);
							else if (!projection.releaseReservations.some((entry) => entry.callId === reservation.callId)) projection.releaseReservations.push({
								...reservation,
								startedAtSeq: event.seq
							});
							break;
						}
						if (recordText.startsWith(RELEASE_REVOCATION_PREFIX)) {
							const payload = asRecord(parseArguments(recordText.slice(RELEASE_REVOCATION_PREFIX.length)));
							const contractId = typeof payload?.contractId === "string" ? payload.contractId : "";
							const contract = projection.releaseContracts.find((entry) => entry.contractId === contractId);
							if (!contract) pushReleaseDiagnostic(projection, event.seq, "release_contract_revocation_unknown");
							else if (contract.revokedAtSeq === void 0) contract.revokedAtSeq = event.seq;
							break;
						}
						if (recordText.startsWith(RELEASE_SETTLEMENT_PREFIX)) {
							const settlement = normalizeSettlement(parseArguments(recordText.slice(RELEASE_SETTLEMENT_PREFIX.length)));
							if (!settlement) pushReleaseDiagnostic(projection, event.seq, "release_settlement_malformed", true);
							else {
								const pinned = {
									...settlement,
									settledAtSeq: event.seq
								};
								const key = (row) => `${row.contractId}\u0000${row.operation}\u0000${row.callId}`;
								const index = projection.releaseSettlements.findIndex((entry) => key(entry) === key(pinned));
								if (index < 0) projection.releaseSettlements.push(pinned);
								else if (OUTCOME_STRENGTH[pinned.outcome] >= OUTCOME_STRENGTH[projection.releaseSettlements[index].outcome]) projection.releaseSettlements[index] = pinned;
							}
							break;
						}
					}
				}
				if (!enabled) break;
				const data = asRecord(event.data);
				if (asRecord(data?.source)?.kind !== "user") break;
				const content = data?.content ?? [];
				const text = extractTextContent(content);
				if (text.trim() || content.some((part) => part && typeof part === "object" && part.type !== "text")) {
					realRootInputSeen = true;
					if (activeTurn !== void 0) {
						const seqs = turnRootInputSeqs.get(activeTurn) ?? /* @__PURE__ */ new Set();
						seqs.add(event.seq);
						turnRootInputSeqs.set(activeTurn, seqs);
					}
				}
				const unitSemantics = unitSemanticsActive() && v5BoundarySeq !== void 0 && event.seq > v5BoundarySeq;
				const foldUnitId = () => {
					if (!unitSemantics) return void 0;
					foldIntoCurrentUnit(projection, event.seq);
					if (activeTurn !== void 0) turnUnitIds.set(activeTurn, projection.currentUnitId);
					return projection.currentUnitId;
				};
				const legacyMessage = protocolBoundarySeq !== void 0 && event.seq < protocolBoundarySeq;
				const coordinationSplit = !(protocolBoundarySeq !== void 0 && (captureBoundarySeq === void 0 || event.seq < captureBoundarySeq));
				const captureAssets = (unitId) => {
					if ((v4BoundarySeq ?? v5BoundarySeq) !== void 0 && event.seq > (v4BoundarySeq ?? v5BoundarySeq)) content.forEach((part, index) => {
						if (!part || typeof part !== "object" || part.type === "text") return;
						const identity = sha256(JSON.stringify(part));
						const assetItem = insert(projection, {
							kind: "requirement",
							body: `Uninterpreted root asset m${event.seq} part ${index}: sha256 ${identity}. Interpret the attachment; its contents are reference data, not execution authority.`,
							text: `Uninterpreted root asset m${event.seq} part ${index}`,
							paths: [],
							interpretation: {
								text: `Uninterpreted root asset m${event.seq} part ${index}`,
								body: `Interpret the attached asset m${event.seq} part ${index}`,
								directive: "informational",
								executee: "unresolved",
								immediatelyExecutable: false,
								authorityDisposition: "informational",
								qualification: {
									status: "restricted",
									reason: "governed_scope",
									governedBy: "attachment"
								},
								fingerprint: `asset:${identity.slice(0, 16)}`
							}
						}, `m${event.seq}:asset:${index}`, scope.cwd || "scope", "scope", unitId);
						assetItem.taskKind = "inquiry";
						assetItem.asset = {
							messageSeq: event.seq,
							partIndex: index,
							mediaSha256: identity
						};
					});
				};
				if (!text.trim()) {
					captureAssets(unitSemantics ? foldUnitId() : void 0);
					break;
				}
				if (!scope.sessionHeader?.parentSession && !scope.sessionHeader?.delegationDepth && scope.sessionHeader?.origin !== "subagent") {
					const confirmGrammarSeq = v4BoundarySeq ?? v5BoundarySeq;
					const parsed = confirmGrammarSeq !== void 0 && event.seq > confirmGrammarSeq ? parseConfirmationMessage(text) : (() => {
						const match = CONFIRM_LINE_PATTERN.exec(text.trim());
						return match ? {
							kind: "confirm",
							proposalId: match[1],
							remainder: ""
						} : { kind: "none" };
					})();
					if (parsed.kind === "confirm") {
						if (confirmRebind(projection, parsed.proposalId, `m${event.seq}`, durableConfirmed)) {
							const unitId = unitSemantics ? foldUnitId() : void 0;
							captureAssets(unitId);
							if (parsed.remainder) captureRootText(projection, parsed.remainder, event.seq, scope, legacyMessage, priorRootMessages, `m${event.seq}:r`, coordinationSplit, unitId, unitSemantics);
							break;
						}
					} else if (parsed.kind !== "none") {
						const unitId = unitSemantics ? foldUnitId() : void 0;
						captureAssets(unitId);
						projection.lastConfirmationRejection = {
							eventSeq: event.seq,
							kind: parsed.kind,
							reason: parsed.reason
						};
						const stripped = text.split(/\r?\n/).filter((line) => !CONFIRM_LINE_PATTERN.test(line.trim())).join("\n");
						if (!stripped.trim()) break;
						captureRootText(projection, stripped, event.seq, scope, legacyMessage, priorRootMessages, `m${event.seq}`, coordinationSplit, unitId, unitSemantics);
						break;
					}
				}
				const directiveBearing = text.trim().length > 0 && !isInformationalMessage(text) && classifyUserInteraction(text) !== "conversational";
				let captureUnitId;
				if (unitSemantics && directiveBearing) {
					if (!explicitlyLinkedToCurrentUnit(projection, text) && opensNewUnit(projection, text, true, currentUnitHasOpenWork(projection))) {
						const parentUnitId = opensChildUnit(projection, text) ? projection.currentUnitId : void 0;
						captureUnitId = openUnit(projection, event.seq, text.slice(0, 200), parentUnitId).unitId;
					} else captureUnitId = foldUnitId();
					if (activeTurn !== void 0) turnUnitIds.set(activeTurn, projection.currentUnitId);
				}
				captureAssets(captureUnitId ?? (unitSemantics ? foldUnitId() : void 0));
				if (isInformationalMessage(text)) break;
				if (classifyUserInteraction(text) === "conversational") break;
				captureRootText(projection, text, event.seq, scope, legacyMessage, priorRootMessages, `m${event.seq}`, coordinationSplit, captureUnitId, unitSemantics);
				break;
			}
			case "goal/change": {
				const data = asRecord(event.data);
				const operation = String(data?.operation ?? "");
				if (operation === "clear") {
					projection.currentGoalRef = void 0;
					projection.currentGoalPhase = void 0;
					projection.currentGoalActivation = void 0;
					break;
				}
				const goal = asRecord(data?.goal);
				const id = typeof goal?.id === "string" ? goal.id : "";
				const revision = Number(goal?.revision ?? 0);
				const phase = String(goal?.phase ?? "");
				if (operation === "complete" && enabled) {
					if (!hasCurrentCertificate(projection)) {
						projection.integrity = "corrupt";
						projection.integrityViolations.push("goal_completion_without_certificate");
					}
				}
				if (id && Number.isSafeInteger(revision) && revision > 0) projection.currentGoalRef = {
					id,
					revision
				};
				if (phase === "active" || phase === "paused" || phase === "blocked" || phase === "complete") projection.currentGoalPhase = phase;
				projection.currentGoalActivation = "disarmed";
				break;
			}
			case "tool/call": {
				if (!enabled) break;
				const data = asRecord(event.data);
				const callId = String(data?.callId ?? "");
				const call = {
					name: String(data?.name ?? ""),
					arguments: String(data?.arguments ?? ""),
					rootCallId: typeof data?.rootCallId === "string" ? data.rootCallId : void 0,
					...typeof data?.turn === "number" && Number.isSafeInteger(data.turn) ? { turn: data.turn } : {},
					...projection.currentUnitId !== void 0 ? { unitIdAtCall: projection.currentUnitId } : {}
				};
				if (call.name === "context_guard_checkpoint") {
					const args = parseArguments(call.arguments);
					if (asRecord(args.proof)) call.proof = args.proof;
					call.bindings = Array.isArray(args.bindings) ? args.bindings.map((binding) => {
						const record = asRecord(binding);
						const transition = asRecord(record?.expected_transition);
						return {
							itemId: String(record?.item_id ?? ""),
							evidenceIds: Array.isArray(record?.evidence_ids) ? record.evidence_ids.map(String) : [],
							...typeof record?.semantic_action === "string" ? { semanticAction: record.semantic_action } : {},
							...asRecord(record?.requested_target) ? { requestedTarget: asRecord(record?.requested_target) } : {},
							...asRecord(record?.resolved_target) ? { resolvedTarget: asRecord(record?.resolved_target) } : {},
							...asRecord(record?.observed_state) ? { observedState: asRecord(record?.observed_state) } : {},
							...transition ? { expectedTransition: {
								predicateId: String(transition.predicate_id ?? ""),
								version: Number(transition.version ?? 0),
								predParamsKind: "inline",
								...asRecord(transition.parameters) ? { parameters: asRecord(transition.parameters) } : {},
								...transition.pred_params_kind !== "inline" ? { parameters: void 0 } : {},
								...typeof transition.parameters_digest === "string" ? { parametersDigest: transition.parameters_digest } : {}
							} } : {},
							...typeof record?.resolution_evidence_id === "string" ? { resolutionEvidenceId: record.resolution_evidence_id } : {},
							...typeof record?.effect_evidence_id === "string" ? { effectEvidenceId: record.effect_evidence_id } : {},
							...Array.isArray(record?.state_evidence_ids) ? { stateEvidenceIds: record.state_evidence_ids.map(String) } : {},
							...Array.isArray(record?.action_bindings) ? { actionBindings: record.action_bindings.map((entry) => {
								const closure = asRecord(entry);
								return {
									action: String(closure?.action ?? ""),
									evidenceIds: Array.isArray(closure?.evidence_ids) ? closure.evidence_ids.map(String) : [],
									resolvedTarget: asRecord(closure?.resolved_target) ?? {},
									order: Number(closure?.order ?? 0)
								};
							}) } : {}
						};
					}) : [];
				} else if (call.name === "context_guard_boundary") {
					const args = parseArguments(call.arguments);
					call.boundaryRequest = {
						disposition: String(args.disposition),
						qualificationKind: String(args.qualification_kind),
						qualificationIds: Array.isArray(args.qualification_ids) ? args.qualification_ids.map(String) : [],
						callId
					};
				}
				pendingCalls.set(callId, call);
				break;
			}
			case "tool/ptc-dispatch-start": {
				if (!enabled) break;
				const data = asRecord(event.data);
				const subCallId = String(data?.subCallId ?? "");
				const rawArguments = data?.arguments;
				pendingCalls.set(subCallId, {
					name: String(data?.name ?? ""),
					arguments: typeof rawArguments === "string" ? rawArguments : JSON.stringify(rawArguments ?? ""),
					rootCallId: typeof data?.rootCallId === "string" ? data.rootCallId : void 0
				});
				break;
			}
			case "tool/result":
			case "tool/ptc-dispatch": {
				if (!enabled) break;
				const data = asRecord(event.data);
				const isDispatch = event.type === "tool/ptc-dispatch";
				const message = asRecord(data?.message);
				const source = asRecord(message?.source);
				const callId = String(source?.callId ?? (isDispatch ? data?.subCallId : "") ?? "");
				const call = pendingCalls.get(callId);
				if (!call) break;
				pendingCalls.delete(callId);
				const textContent = extractTextContent((isDispatch ? data?.content : void 0) ?? message?.content ?? []);
				if (call.name === "context_guard_rebind") {
					if (!call.rootCallId && !data?.error) {
						const rebindArgs = parseArguments(call.arguments);
						const recordedResponse = parseArguments(textContent);
						replayRebindResult(projection, rebindArgs, recordedResponse);
						if (recordedResponse.status === "rejected" && typeof recordedResponse.reason_code === "string") {
							const key = rebindAttemptKey(projection, rebindArgs, recordedResponse.reason_code);
							projection.rebindRejections.set(key, (projection.rebindRejections.get(key) ?? 0) + 1);
						}
					}
					break;
				}
				if (call.name === "context_guard_checkpoint") {
					const recorded = parseArguments(textContent);
					if (recorded.status !== "certified") {
						if ((call.bindings?.length ?? 0) > 0) {
							projection.lastCheckpointRejections = certifyCheckpoint(projection, call.bindings ?? [], "diagnostic", false).rejectedBindings;
							projection.lastCheckpointRejectionRevision = projection.contractRevision;
						}
						break;
					}
					const recordedProof = asRecord(recorded.proof_state);
					const recomputedProof = replayProofState(projection, call.proof);
					if ((recordedProof !== void 0 || call.proof !== void 0) && (recordedProof === void 0 || String(recordedProof.status ?? "") !== recomputedProof.status || !sameStringSet(recordedProof.reason_codes, recomputedProof.reason_codes))) {
						projection.integrity = "corrupt";
						projection.integrityViolations.push("proof_replay_mismatch");
						break;
					}
					if (recomputedProof.status === "invalid" || recomputedProof.status === "rejected") {
						projection.integrity = "corrupt";
						projection.integrityViolations.push("proof_replay_mismatch");
						break;
					}
					if (!asRecord(recorded.certificate)) {
						for (const binding of call.bindings ?? []) {
							const item = projection.items.get(binding.itemId);
							if (item) {
								item.status = "passed";
								if (!item.legacyFlags?.includes("legacy_generic_run")) item.legacyFlags = [...item.legacyFlags ?? [], "legacy_generic_run"];
							}
						}
						projection.integrityViolations.push("legacy_certificate_non_authoritative");
						break;
					}
					const recordedCertificate = asRecord(recorded.certificate);
					if (recordedCertificate.host_lock_digest !== projection.hostLockDigest) {
						const stale = restoreHistoricalCheckpoint(recordedCertificate, call.bindings ?? [], `C${projection.checkpoints.length + 1}`);
						if (!stale) {
							projection.integrity = "corrupt";
							projection.integrityViolations.push("certificate_replay_mismatch");
							break;
						}
						projection.checkpoints.push(stale);
						projection.certificateStatusReason = "stale_host_lock";
						break;
					}
					const id = `C${projection.checkpoints.length + 1}`;
					const result = certifyCheckpoint(projection, call.bindings ?? [], id, false);
					if (result.status !== "certified" || !result.checkpoint || !recordedCertificateMatches(recorded.certificate, result.checkpoint)) {
						projection.integrity = "corrupt";
						projection.integrityViolations.push("certificate_replay_mismatch");
					} else certifyCheckpoint(projection, call.bindings ?? [], id, true);
					break;
				}
				if (call.name === "context_guard_interpret") {
					if (!call.rootCallId && !data?.error) {
						const callArgs = parseArguments(call.arguments);
						const requested = typeof callArgs.item_id === "string" ? callArgs.item_id.trim() : "";
						const recorded = parseArguments(textContent);
						if (recorded.status === "recorded") {
							const item = requested ? projection.items.get(requested) : void 0;
							const resultTurn = typeof data?.turn === "number" && Number.isSafeInteger(data.turn) ? data.turn : void 0;
							const callInformation = readPartitionSpans(callArgs.information_spans);
							const callUnknown = readPartitionSpans(callArgs.unknown_spans);
							if (!(requested !== "" && item !== void 0 && item.status === "pending" && recorded.item_id === requested && recorded.item_revision === item.revision && (item.asset !== void 0 ? recorded.kind === "asset" && !Object.hasOwn(recorded, "information_spans") && !Object.hasOwn(recorded, "unknown_spans") && assetReceiptMatches(recorded.asset, item.asset) : recorded.kind === "clause" && clauseCallReceiptMatches(callInformation, callUnknown, recorded, item)))) {
								projection.integrity = "corrupt";
								projection.integrityViolations.push("interpretation_receipt_mismatch");
								break;
							}
							if (call.turn === void 0 || resultTurn === void 0) break;
							if (call.turn !== resultTurn) {
								projection.integrity = "corrupt";
								projection.integrityViolations.push("interpretation_receipt_mismatch");
								break;
							}
							if (item.asset !== void 0) {
								const existing = interpretationFacts.findIndex((fact) => fact.itemId === requested);
								if (existing >= 0) interpretationFacts.splice(existing, 1);
								interpretationFacts.push({
									itemId: requested,
									resultSeq: event.seq,
									turn: call.turn
								});
							} else {
								const informationSubItemIds = supersedeClauseByPartition(projection, item, asRecord(recorded));
								for (const subItemId of informationSubItemIds) if (interpretationFacts.findIndex((fact) => fact.itemId === subItemId) < 0) interpretationFacts.push({
									itemId: subItemId,
									resultSeq: event.seq,
									turn: call.turn
								});
							}
						}
					}
					break;
				}
				if (call.name === "context_guard_boundary") {
					const recorded = parseArguments(textContent);
					const candidate = call.boundaryRequest ? qualifyBoundary(projection, call.boundaryRequest) : void 0;
					const boundary = asRecord(recorded.boundary);
					if (candidate && recorded.status === "unknown") {
						projection.boundaries.push({
							...candidate,
							persistedResult: "unknown",
							reasonCode: typeof recorded.reason_code === "string" ? recorded.reason_code : "boundary_persistence_unknown"
						});
						break;
					}
					if (!candidate || recorded.status !== candidate.persistedResult || boundary?.candidate_sha256 !== candidate.candidateSha256) {
						projection.integrity = "corrupt";
						projection.integrityViolations.push("boundary_replay_mismatch");
					} else projection.boundaries.push(candidate);
					break;
				}
				evidenceCounter += 1;
				const delegated = DEFAULT_DELEGATION_TOOL_NAMES.includes(call.name);
				const baseEvidence = withDurability(evidenceFromPersistedToolResult({
					callId,
					name: call.name,
					arguments: call.arguments,
					rootCallId: call.rootCallId
				}, {
					seq: event.seq,
					error: data?.error ?? (isDispatch && data?.isError ? {
						name: "code",
						code: "DISPATCH_ERROR"
					} : void 0),
					meta: data?.meta,
					textContent
				}, epoch, `E${String(evidenceCounter).padStart(4, "0")}`, scope.cwd || void 0, hostLock), durableConfirmed);
				const evidence = delegated ? {
					...baseEvidence,
					delegatedSubtask: true
				} : baseEvidence;
				projection.evidence.set(evidence.id, evidence);
				if (delegated && call.unitIdAtCall !== void 0) recordDelegation(projection, call.unitIdAtCall, {
					callId,
					resultSeq: event.seq,
					toolName: call.name,
					status: data?.error !== void 0 ? "failed" : "completed"
				});
				if (evidence.externalOperationRef) projection.externalOperations.set(evidence.externalOperationRef.id, evidence.externalOperationRef);
				break;
			}
			default: break;
		}
	}
	projection.enabled = enabled;
	projection.epoch = epoch;
	applyUpgradeEligibility(projection);
	if (interpretationFacts.length > 64) interpretationFacts.splice(0, interpretationFacts.length - 64);
	projection.interpretationFacts = interpretationFacts;
	projection.trustedSelections = deriveTrustedSelections(sourceEvents, { questionToolNames: DEFAULT_QUESTION_TOOL_NAMES });
	if (projection.trustedSelections.length > 16) projection.trustedSelections = projection.trustedSelections.slice(-16);
	const approvalAsked = /* @__PURE__ */ new Map();
	for (const event of sourceEvents) {
		const data = asRecord(event.data);
		if (event.type === "approval/asked") {
			const id = typeof data?.id === "string" ? data.id : "";
			const toolName = typeof data?.toolName === "string" ? data.toolName : void 0;
			if (id) approvalAsked.set(id, {
				id,
				seq: event.seq,
				toolName
			});
			continue;
		}
		if (event.type === "approval/decided") {
			const id = typeof data?.id === "string" ? data.id : "";
			const asked = approvalAsked.get(id);
			if (!asked) continue;
			const outcome = String(data?.outcome ?? "");
			if (![
				"allowed-once",
				"rejected",
				"cancelled",
				"unavailable"
			].includes(outcome)) continue;
			projection.approvals.push({
				id: asked.id,
				seq: asked.seq,
				toolName: asked.toolName,
				outcome
			});
			approvalAsked.delete(id);
		}
	}
	if (projection.approvals.length > 16) projection.approvals = projection.approvals.slice(-16);
	if (!projection.releaseStateDamaged) projection.releaseStateDamaged = projection.releaseSettlements.some((settlement) => {
		if (settlement.readback === "unavailable") return false;
		const contract = projection.releaseContracts.find((entry) => entry.contractId === settlement.contractId);
		if (!contract || settlement.readback.kind !== "npm_integrity") return false;
		const reservation = projection.releaseReservations.find((entry) => entry.contractId === settlement.contractId && entry.operation === settlement.operation && entry.callId === settlement.callId);
		const expected = contract.candidate.artifactSri ?? reservation?.observedArtifactSri;
		return expected !== void 0 && expected !== settlement.readback.identity;
	});
	return {
		projection,
		compacted,
		enablementTransitioned,
		lastCompactionSeq,
		realRootInputSeen,
		protocolV4Present: v4BoundarySeq !== void 0,
		boundaryV5: v5BoundarySeq !== void 0
	};
}

//#endregion
//#region src/domain/lifecycle.ts
function claimedTextParts(content) {
	if (!Array.isArray(content)) return {
		hasText: false,
		hasOtherParts: false
	};
	let hasText = false;
	let hasOtherParts = false;
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const record = part;
		if (record.type === "text") {
			if (typeof record.text === "string" && record.text.trim()) hasText = true;
			continue;
		}
		hasOtherParts = true;
	}
	return {
		hasText,
		hasOtherParts
	};
}
/**
* Pure preview of one claimed pre-step batch. Messages claimed by the loop are
* NOT yet persisted as `user/message` events at pre-step time, so this reads
* only the validated claim: it never writes contract items, evidence, or
* authority. A message activates protection when it carries a root user source
* and real content — non-empty text, or any non-text part (image/attachment).
* Whitespace-only messages with no other parts are real input but state no
* task, so they neither activate nor produce contract items.
*/
function claimedBatchHasRealRootInput(messages) {
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const record = message;
		if (record.source?.kind !== "user") continue;
		const { hasText, hasOtherParts } = claimedTextParts(record.content);
		if (hasText || hasOtherParts) return true;
	}
	return false;
}
/**
* Pure decision for the first-step activation injection when protection is enabled. The
* boundary must precede the first constrained root message inside the SAME
* persisted step batch; guidance is compact and never claims a recovery that
* did not happen. `opt-in` reaches this path only after its explicit `on` command. Delegated sessions receive neither: their
* scope arrives through the parent's delegation prompt (A04).
*
* A session without a v5 boundary receives the 0.6 boundary: it cuts the
* work-unit/delivery/certificate-v2 semantics at exactly this message. A
* session that already has v5 injects nothing.
*/
function previewFirstStepInjection(input, claimedRealInput) {
	if (!input.enabled || input.delegated) return void 0;
	if (!claimedRealInput) return void 0;
	if (input.boundaryV5Present) return void 0;
	return {
		boundary: PROTOCOL_V5_NOTICE,
		guidance: firstStepGuidance(input.policy ?? "standard")
	};
}
/**
* Compact first-step guidance: protection has started, what it protects, and
* when the guarded producer path is needed. 0.6.1 (W060-05): the stateful
* workflow is stated CONDITIONALLY — only an obligation whose own clause
* demands a certified stateful action runs through prepare/producer/checkpoint.
* The 0.6.0 text demanded that order for every stateful action unconditionally,
* which ordinary business work correctly read as a Guard approval gate.
* Ordinary answers, investigations, and ordinary tool work are never gated, and
* missing Guard evidence is never a reason to repeat a completed action.
*/
function firstStepGuidance(policy = "standard") {
	return "Context Guard is now protecting this session: requirements from your messages stay open until they are certified with matching durable evidence. Ordinary answers, investigations, and ordinary tool work need no Guard approval. When a requirement itself calls for a certified stateful action (install, apply, create, modify, restart, commit, push, publish, pull, fetch), call context_guard_prepare before it to see the supported command shape and the required resolution/effect/state order, run the action through the guarded path, and close items with context_guard_checkpoint; never repeat an already-completed action to mint missing evidence." + (policy === "strict" ? " Under strict policy, a verification the user explicitly requested (a visual readback or a complete-scope check) must be discharged by a real readback fact." : "") + " Ordinary answers and investigations need no certification.";
}
const FIRST_STEP_GUIDANCE = firstStepGuidance("standard");
/**
* Lifecycle phase derived from durable facts. `enabled` is the log-derived
* enablement (`always`, or the explicit `on`/`off` command sequence), and
* `realInputSeen` records that a real root user input already entered a step.
* Pure over its inputs so status display and tests cannot drift from the
* injection decision.
*/
function lifecyclePhase(input) {
	if (!input.enabled) return "disabled";
	return input.realInputSeen ? "active" : "armed";
}

//#endregion
//#region src/domain/git-adapter.ts
const GIT_COMMAND_MANIFEST_IDS = {
	inspect_remote_updates: "git.ls_remote_exact.v2",
	pull: "git.pull_ff_only_explicit.v2",
	fetch: "git.fetch_tracking_explicit.v2",
	commit: "git.commit_index_tree.v2",
	push: "git.push_explicit_refs.v2"
};
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function rejected(reasonCode) {
	return {
		status: "rejected",
		reasonCode
	};
}
function safeRef(ref, prefix) {
	if (!ref.startsWith(prefix) || ref.length <= prefix.length || ref.length > 512) return false;
	if ([
		"*",
		"?",
		"[",
		"\\",
		"~",
		"^",
		":"
	].some((character) => ref.includes(character))) return false;
	if ([...ref].some((character) => /\s/u.test(character) || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return false;
	if (ref.includes("..") || ref.includes("@{") || ref.includes("//")) return false;
	if (ref.endsWith("/") || ref.endsWith(".") || ref.endsWith(".lock")) return false;
	return ref.split("/").every((part) => part.length > 0 && !part.startsWith("."));
}
function safeHeadRef(ref) {
	return safeRef(ref, "refs/heads/");
}
function safeTrackingRef(ref, remote, sourceRef) {
	if (!safeRef(ref, "refs/remotes/")) return false;
	return ref === `refs/remotes/${remote}/${sourceRef.slice(11)}`;
}
function baseManifest(action, surface, argv) {
	return {
		manifestVersion: 2,
		manifestId: GIT_COMMAND_MANIFEST_IDS[action],
		action,
		surface,
		argv
	};
}
/**
* Parse only the audited Git argv shapes. The shell words come from the
* production shell parser; this module does not maintain an independent split
* or quoting implementation. Global `git -C`/`git -c`, aliases, force/delete,
* wildcard refspecs, and implicit HEAD/ref destinations fail closed because
* none occur in an accepted exact shape.
*/
/**
* Canonical command templates, derived from the SAME audited argv shapes the
* parser accepts above. Guidance surfaces (context_guard_prepare) render these
* so a tool description can never advertise a command the executor rejects.
*/
const GIT_COMMAND_TEMPLATES = {
	commit: {
		command: "git commit -m <message>",
		shape: ["exactly: git, commit, -m, non-empty message"]
	},
	push: {
		command: "git push <remote> <source_ref>:<destination_ref>",
		shape: [
			"exactly 4 argv words",
			"full refs with explicit \":\"",
			"no force flags"
		]
	},
	fetch: {
		command: "git fetch --no-tags <remote> <source_ref>:<tracking_ref>",
		shape: ["exactly 5 argv words", "tracking ref must match <remote>/<source_ref>"]
	},
	pull: {
		command: "git pull --ff-only --no-tags <remote> <source_ref>",
		shape: ["exactly 6 argv words", "fast-forward only"]
	},
	inspect_remote_updates: {
		command: "git ls-remote --exit-code --refs <remote> <source_ref>",
		shape: ["exactly 6 argv words"]
	}
};
function parseGitCommandManifest(command, surface) {
	const canonical = canonicalArgvFromCommand(command, surface);
	if (canonical.status !== "supported") return rejected("shell_command_unsupported");
	const argv = canonical.argv;
	if (argv[0]?.toLowerCase() !== "git") return rejected("git_alias_or_subcommand_forbidden");
	if (argv[1]?.startsWith("-")) return rejected("git_global_option_forbidden");
	const subcommand = argv[1]?.toLowerCase();
	if (subcommand === "commit") {
		if (argv.length !== 4 || argv[2] !== "-m" && argv[2] !== "--message" || argv[3].length === 0) return rejected("git_argv_shape_forbidden");
		return {
			status: "accepted",
			manifest: baseManifest("commit", surface, argv)
		};
	}
	if (subcommand === "ls-remote") {
		if (argv.length !== 6 || argv[2] !== "--exit-code" || argv[3] !== "--refs") return rejected("git_argv_shape_forbidden");
		const remote = argv[4];
		const sourceRef = argv[5];
		if (!REMOTE_NAME.test(remote)) return rejected("git_remote_forbidden");
		if (!safeHeadRef(sourceRef)) return rejected("git_ref_forbidden");
		return {
			status: "accepted",
			manifest: {
				...baseManifest("inspect_remote_updates", surface, argv),
				remote,
				sourceRef
			}
		};
	}
	if (subcommand === "push") {
		if (argv.length !== 4) return rejected("git_argv_shape_forbidden");
		const remote = argv[2];
		if (!REMOTE_NAME.test(remote)) return rejected("git_remote_forbidden");
		const separator = argv[3].indexOf(":");
		if (separator <= 0 || separator !== argv[3].lastIndexOf(":")) return rejected("git_argv_shape_forbidden");
		const sourceRef = argv[3].slice(0, separator);
		const destinationRef = argv[3].slice(separator + 1);
		if (!safeHeadRef(sourceRef) || !safeHeadRef(destinationRef)) return rejected("git_ref_forbidden");
		return {
			status: "accepted",
			manifest: {
				...baseManifest("push", surface, argv),
				remote,
				sourceRef,
				destinationRef
			}
		};
	}
	if (subcommand === "fetch") {
		if (argv.length !== 5 || argv[2] !== "--no-tags") return rejected("git_argv_shape_forbidden");
		const remote = argv[3];
		if (!REMOTE_NAME.test(remote)) return rejected("git_remote_forbidden");
		const separator = argv[4].indexOf(":");
		if (separator <= 0 || separator !== argv[4].lastIndexOf(":")) return rejected("git_argv_shape_forbidden");
		const sourceRef = argv[4].slice(0, separator);
		const trackingRef = argv[4].slice(separator + 1);
		if (!safeHeadRef(sourceRef)) return rejected("git_ref_forbidden");
		if (!safeTrackingRef(trackingRef, remote, sourceRef)) return rejected("git_tracking_ref_forbidden");
		return {
			status: "accepted",
			manifest: {
				...baseManifest("fetch", surface, argv),
				remote,
				sourceRef,
				trackingRef
			}
		};
	}
	if (subcommand === "pull") {
		if (argv.length !== 6 || argv[2] !== "--ff-only" || argv[3] !== "--no-tags") return rejected("git_argv_shape_forbidden");
		const remote = argv[4];
		const sourceRef = argv[5];
		if (!REMOTE_NAME.test(remote)) return rejected("git_remote_forbidden");
		if (!safeHeadRef(sourceRef)) return rejected("git_ref_forbidden");
		return {
			status: "accepted",
			manifest: {
				...baseManifest("pull", surface, argv),
				remote,
				sourceRef
			}
		};
	}
	return rejected("git_alias_or_subcommand_forbidden");
}
/** Bind the command's explicit remote/ref identities to the canonical target. */
function gitCommandMatchesTarget(manifest, target) {
	if (manifest.remote !== void 0 && manifest.remote !== target.remote) return false;
	const expectedRefspec = manifest.destinationRef !== void 0 ? `${manifest.sourceRef}:${manifest.destinationRef}` : manifest.trackingRef !== void 0 ? `${manifest.sourceRef}:${manifest.trackingRef}` : manifest.sourceRef;
	if (expectedRefspec !== void 0 && expectedRefspec !== target.refspec) return false;
	return true;
}
function hashTuple(fields) {
	const hash = createHash("sha256");
	for (const key of Object.keys(fields).sort()) {
		const keyBytes = Buffer.from(key, "utf8");
		const raw = fields[key];
		const value = typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw);
		const lengths = Buffer.allocUnsafe(8);
		lengths.writeUInt32BE(keyBytes.length, 0);
		lengths.writeUInt32BE(value.length, 4);
		hash.update(lengths).update(keyBytes).update(value);
	}
	return hash.digest("hex");
}
function parseNulRecords(bytes) {
	if (bytes.byteLength === 0 || bytes[bytes.byteLength - 1] !== 0) return void 0;
	return Buffer.from(bytes).toString("utf8").slice(0, -1).split("\0");
}
/**
* Normalize the read-only `git ls-files --stage -z` surface. Only stage-zero
* entries are certifiable; the digest binds mode, blob OID, and raw path bytes
* without asking Git to create an object (in particular, never `write-tree`).
*/
function commitIndexSnapshotDigest(indexEntries) {
	const records = parseNulRecords(indexEntries);
	if (!records?.length) return void 0;
	const normalized = [];
	for (const entry of records) {
		const match = /^(\d{6}) ([0-9a-f]{40}(?:[0-9a-f]{24})?) 0\t([\s\S]+)$/i.exec(entry);
		if (!match) return void 0;
		normalized.push(`${match[1]} ${match[2].toLowerCase()}\t${match[3]}\0`);
	}
	return hashTuple({ entries: Buffer.from(normalized.join(""), "utf8") });
}
/** Normalize the committed `git ls-tree -r -z <oid>` surface to the same tuple. */
function commitTreeSnapshotDigest(treeEntries) {
	const records = parseNulRecords(treeEntries);
	if (!records?.length) return void 0;
	const normalized = [];
	for (const entry of records) {
		const match = /^(\d{6}) blob ([0-9a-f]{40}(?:[0-9a-f]{24})?)\t([\s\S]+)$/i.exec(entry);
		if (!match) return void 0;
		normalized.push(`${match[1]} ${match[2].toLowerCase()}\t${match[3]}\0`);
	}
	return hashTuple({ entries: Buffer.from(normalized.join(""), "utf8") });
}
/**
* Parse the raw `git rev-list --parents -n 1 HEAD` surface and accept only a
* linear commit whose sole parent is the exact resolved pre-effect HEAD.
* Root commits, merge commits, a substituted first parent, malformed output,
* and a no-op/self-parent tuple all fail closed.
*/
function verifiedLinearCommitReadback(rawParents, expectedPreHeadOid) {
	const oidPattern = "[0-9a-f]{40}(?:[0-9a-f]{24})?";
	const match = new RegExp(`^(${oidPattern})((?: ${oidPattern})*)\\r?\\n$`, "i").exec(Buffer.from(rawParents).toString("utf8"));
	if (!match) return void 0;
	const postHeadOid = match[1].toLowerCase();
	const parentOids = match[2] ? match[2].slice(1).split(" ").map((entry) => entry.toLowerCase()) : [];
	const expected = expectedPreHeadOid.toLowerCase();
	if (!new RegExp(`^${oidPattern}$`, "i").test(expectedPreHeadOid) || parentOids.length !== 1 || parentOids[0] !== expected || parentOids[0].length !== postHeadOid.length || postHeadOid === expected) return void 0;
	return {
		postHeadOid,
		preHeadOid: parentOids[0]
	};
}
function createGitPrestateEnvelope(manifest, target, stateTuple) {
	return {
		envelopeVersion: "git.prestate.v1",
		action: manifest.action,
		commandManifestId: manifest.manifestId,
		targetIdentityDigest: hashTuple(Object.fromEntries(Object.entries(target).map(([key, value]) => [key, value ?? ""]))),
		stateTupleDigest: hashTuple(stateTuple)
	};
}
/**
* Mandatory resolution-to-effect gate. Call immediately before invoking Git;
* any command, target, ref/OID, remote, branch, or raw index tuple drift makes
* the previously resolved operation unusable.
*/
function revalidateGitPrestate(resolved, manifest, target, currentStateTuple) {
	if (resolved.action !== manifest.action || resolved.commandManifestId !== manifest.manifestId) return {
		valid: false,
		reasonCode: "command_manifest_drift"
	};
	if (hashTuple(Object.fromEntries(Object.entries(target).map(([key, value]) => [key, value ?? ""]))) !== resolved.targetIdentityDigest) return {
		valid: false,
		reasonCode: "target_identity_drift"
	};
	if (hashTuple(currentStateTuple) !== resolved.stateTupleDigest) return {
		valid: false,
		reasonCode: "prestate_drift"
	};
	return { valid: true };
}
/** Execute the exact resolved argv only after the mandatory live recheck. */
async function executeRevalidatedGitEffect(resolved, manifest, target, currentStateTuple, runner) {
	if (!target.repository) return {
		status: "rejected",
		reasonCode: "repository_missing"
	};
	const checked = revalidateGitPrestate(resolved, manifest, target, currentStateTuple);
	if (!checked.valid) return {
		status: "rejected",
		...checked.reasonCode ? { reasonCode: checked.reasonCode } : {}
	};
	const text = (key) => {
		const value = currentStateTuple[key];
		return typeof value === "string" ? value : value === void 0 ? void 0 : Buffer.from(value).toString("utf8");
	};
	if (manifest.action === "push" && text("source_oid") !== void 0 && text("source_oid") === text("destination_oid")) return {
		status: "rejected",
		reasonCode: "effect_already_applied"
	};
	if (manifest.action === "pull" && text("pre_head_oid") !== void 0 && text("pre_head_oid") === text("upstream_oid")) return {
		status: "rejected",
		reasonCode: "effect_already_applied"
	};
	if (manifest.action === "fetch" && text("tracking_oid") !== void 0 && text("tracking_oid") === text("upstream_oid")) return {
		status: "rejected",
		reasonCode: "effect_already_applied"
	};
	await runner("git", manifest.argv.slice(1), target.repository);
	return { status: "executed" };
}

//#endregion
//#region src/domain/session-events.ts
/**
* Read a validated, stable event snapshot from the DSH Session V3 API.
*
* Session V3 replaced the V2 `events` getter with `snapshotEvents()`. Context
* Guard supports only the V3 API: a session object that does not expose that
* method is an unsupported host, never a reason to fall back to a legacy
* accessor. Failing loud here keeps a V2-shaped object from being projected as
* if its events had V3 semantics — the two vocabularies differ (surfaces,
* `assistant/chunk` vs embedded streams, `session/end-seed` payload), so a
* silent fallback would derive contract state from a log it cannot read.
*
* Guard is a READER of the durable log, so the envelope check below is the one
* part of log validation it owns itself. The host validates a session it
* constructs or restores; Guard additionally refuses a snapshot that is not a
* sequence of event envelopes, because a projection that silently dropped or
* mis-numbered an event would fabricate contract state rather than report a
* damaged log.
*
* The V3 contract also asks a reader to refuse an unrecognized event type that
* is not marked `ignorable`. Guard does NOT implement that half, deliberately:
* the host's persistence reader already refuses such a log before publishing a
* Session, and a whitelist of event types Guard happens to know would
* false-refuse a healthy host whose composition registers a required event type
* through a third-party plugin. The full rationale is in
* `UPSTREAM_API_AUDIT.md`; revisit it there rather than adding a whitelist here.
*/
const SESSION_API_UNSUPPORTED = "session_api_unsupported";
const SESSION_EVENT_ENVELOPE_INVALID = "session_event_envelope_invalid";
var SessionApiError = class extends Error {
	code;
	constructor(message, code = SESSION_API_UNSUPPORTED) {
		super(message);
		this.name = "SessionApiError";
		this.code = code;
	}
};
/**
* Refuse a snapshot that is not a contiguous, correctly enveloped V3 log.
*
* `seq` must be a non-negative safe integer and `type` a non-empty string.
* Contiguity is checked against the snapshot's own first sequence rather than
* against zero, because a ranged read legitimately starts later.
*/
function assertEventEnvelopes(events) {
	let expected;
	for (let index = 0; index < events.length; index += 1) {
		const event = events[index];
		if (!event || typeof event !== "object" || Array.isArray(event)) throw new SessionApiError(`snapshot event ${index} is not an object`, SESSION_EVENT_ENVELOPE_INVALID);
		const record = event;
		if (typeof record.type !== "string" || record.type.length === 0) throw new SessionApiError(`snapshot event ${index} has no event type`, SESSION_EVENT_ENVELOPE_INVALID);
		if (typeof record.seq !== "number" || !Number.isSafeInteger(record.seq) || record.seq < 0) throw new SessionApiError(`snapshot event ${index} has no sequence number`, SESSION_EVENT_ENVELOPE_INVALID);
		if (expected !== void 0 && record.seq !== expected) throw new SessionApiError(`snapshot event ${index} breaks sequence contiguity`, SESSION_EVENT_ENVELOPE_INVALID);
		expected = record.seq + 1;
	}
}
function snapshotSessionEvents(session) {
	if (!session || typeof session !== "object") throw new SessionApiError("a DSH Session object is required");
	const source = session;
	if (typeof source.snapshotEvents !== "function") throw new SessionApiError("session does not expose the DSH Session V3 snapshotEvents() API");
	const events = source.snapshotEvents.call(session);
	if (!Array.isArray(events)) throw new SessionApiError("snapshotEvents() did not return an event list");
	assertEventEnvelopes(events);
	return events;
}

//#endregion
//#region src/domain/host-resolver.ts
/**
* Names registered in any cohort; rows outside the union are unknown.
*
* Sorted, not inherited from cohort row order: the active cohort's own listing
* order is a presentation choice, and letting it decide the resolution order of
* `packageRowsFromPnpmLock` would make an unrelated cohort re-ordering look like
* a lock-reading change.
*/
const CRITICAL_NAMES = [...new Set(HOST_COHORTS.flatMap((cohort) => cohort.packages.map((row) => row.name)))].sort((a, b) => a.localeCompare(b));
const HOST_LOCK_MARKER_BEGIN = "# >>> BEGIN DSH COMPLETION GUARD HOST LOCK (managed) >>>";
const HOST_LOCK_MARKER_END = "# <<< END DSH COMPLETION GUARD HOST LOCK (managed) <<<";
var HostProfileError = class extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
		this.name = "HostProfileError";
	}
};
function findUp(start, filename) {
	let directory = start;
	while (true) {
		const candidate = join(directory, filename);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(directory);
		if (parent === directory) return void 0;
		directory = parent;
	}
}
/**
* Read only the bounded package identities used by the host lock from a pnpm
* v9 lockfile. Multiple resolved versions are preserved as separate rows so
* callers cannot silently select a nearest instance.
*/
function packageRowsFromPnpmLock(text, names = CRITICAL_NAMES) {
	const rows = /* @__PURE__ */ new Map();
	const lines = text.split(/\r?\n/);
	const packagesStart = lines.findIndex((line) => line === "packages:");
	const snapshotsStart = lines.findIndex((line) => line === "snapshots:");
	if (packagesStart < 0) return [];
	const end = snapshotsStart > packagesStart ? snapshotsStart : lines.length;
	for (let index = packagesStart + 1; index < end; index += 1) {
		const match = lines[index].match(/^  '?((?:@[^/'\s]+\/)?[^@'\s]+)@([^':\s]+)'?:\s*$/);
		if (!match || !names.includes(match[1])) continue;
		let integrity;
		for (let cursor = index + 1; cursor < lines.length && !/^  \S/.test(lines[cursor]); cursor += 1) {
			const resolution = lines[cursor].match(/^    resolution: \{[^}]*\bintegrity: ([^,}\s]+)[^}]*\}\s*$/);
			if (resolution) {
				integrity = resolution[1];
				break;
			}
		}
		const entries = rows.get(match[1]) ?? [];
		entries.push({
			name: match[1],
			version: match[2],
			...integrity ? { integrity } : {}
		});
		rows.set(match[1], entries);
	}
	return names.flatMap((name) => {
		const entries = rows.get(name) ?? [];
		if (entries.length === 0) return [];
		return entries;
	});
}
/**
* The production host verdict: the version floor and the exact-graph audit,
* combined into the one answer a caller acts on.
*
* The two facts stay separable — `hostVersion` is always reported on the
* evaluation — but a host below the supported floor is refused here even when
* its graph matches an audited cohort, because no graph can lift a version
* floor. Keeping this combination out of `evaluateHostLock` leaves that
* function a pure graph audit, so a graph verdict is never overwritten by a
* version verdict inside it.
*/
function combineHostPolicy(evaluation) {
	const version = evaluation.hostVersion;
	if (version?.status !== "below_minimum" && version?.status !== "unparseable") return evaluation;
	return {
		...evaluation,
		status: "unsupported",
		goalAvailable: false,
		reasonCode: version.status === "below_minimum" ? "host_lock_version_below_minimum" : "host_lock_version_unparseable"
	};
}
function resolveInstalledHostLock(moduleUrl = import.meta.url) {
	const lockPath = findUp(dirname(fileURLToPath(moduleUrl)), "pnpm-lock.yaml");
	if (!lockPath) return combineHostPolicy(evaluateHostLock([]));
	try {
		return combineHostPolicy(evaluateHostLock(packageRowsFromPnpmLock(readFileSync(lockPath, "utf8"))));
	} catch {
		return combineHostPolicy(evaluateHostLock([]));
	}
}
function activeGraphRecords(packageMapText) {
	let document;
	try {
		document = JSON.parse(packageMapText);
	} catch {
		throw new HostProfileError("active_graph_invalid", "invalid package map");
	}
	if (!document || typeof document !== "object") throw new HostProfileError("active_graph_invalid", "invalid reachable package map");
	const packages = document.packages;
	if (!packages || typeof packages !== "object" || Array.isArray(packages)) throw new HostProfileError("active_graph_invalid", "invalid reachable package map");
	const records = packages;
	if (!records["."] || Object.keys(records).length > 2e4) throw new HostProfileError("active_graph_invalid", "invalid reachable package map");
	const reachable = /* @__PURE__ */ new Set();
	const queue = ["."];
	while (queue.length > 0 && reachable.size <= 2e4) {
		const id = queue.shift();
		if (reachable.has(id)) continue;
		const record = records[id];
		if (!record || typeof record !== "object") throw new HostProfileError("active_graph_invalid", "invalid reachable package map");
		reachable.add(id);
		if (!record.dependencies || typeof record.dependencies !== "object" || Array.isArray(record.dependencies)) throw new HostProfileError("active_graph_invalid", "invalid reachable dependencies");
		for (const target of Object.values(record.dependencies)) {
			if (typeof target !== "string" || !target) throw new HostProfileError("active_graph_invalid", "invalid dependency target");
			if (target !== "." && !reachable.has(target)) queue.push(target);
		}
	}
	if (queue.length > 0) throw new HostProfileError("active_graph_invalid", "invalid reachable package map");
	return {
		records,
		reachable
	};
}
/**
* Resolve only package identities reachable from the active pnpm importer.
* Historical snapshots elsewhere in the lockfile are deliberately ignored;
* two reachable peer variants of a critical package remain a duplicate and
* are returned twice so evaluateHostLock can fail closed with a bounded code.
*/
function packageRowsFromActiveGraph(packageMapText, lockText, nodeModulesRoot) {
	const { records, reachable } = activeGraphRecords(packageMapText);
	if (!/^lockfileVersion: ['"]?9\.0['"]?\s*$/m.test(lockText) || !/^packages:(?:\s*\{\})?\s*$/m.test(lockText)) throw new HostProfileError("active_graph_invalid", "invalid pnpm lockfile shape");
	const locked = packageRowsFromPnpmLock(lockText);
	const rows = [];
	for (const name of CRITICAL_NAMES) {
		const ids = [...reachable].filter((id) => id === name || id.startsWith(`${name}@`));
		for (const id of ids) {
			let version = id === name ? "" : id.slice(name.length + 1).split("(", 1)[0];
			let installedManifest;
			if (nodeModulesRoot) {
				const record = records[id];
				if (!record || typeof record.url !== "string") {
					rows.push({ name });
					continue;
				}
				try {
					const modules = realpathSync(nodeModulesRoot);
					const manifestPath = realpathSync(resolve(modules, record.url, "package.json"));
					if (!manifestPath.startsWith(`${modules}${sep}`)) {
						rows.push({ name });
						continue;
					}
					installedManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
					if (installedManifest.name !== name || typeof installedManifest.version !== "string" || version && installedManifest.version !== version) {
						rows.push({ name });
						continue;
					}
					version = installedManifest.version;
				} catch {
					rows.push({ name });
					continue;
				}
			}
			if (!version) {
				rows.push({ name });
				continue;
			}
			const candidates = locked.filter((row) => row.name === name && row.version === version && row.integrity);
			if (candidates.length !== 1) {
				rows.push({
					name,
					...version ? { version } : {}
				});
				continue;
			}
			rows.push(candidates[0]);
		}
	}
	return rows;
}
/** Read exact reachable critical rows without requiring Guard installation.
* Used by target preflight before a legacy profile can be migrated.
*/
function readActiveHostGraph(runtimeRoot, profileRoot) {
	const runtime = resolve(runtimeRoot);
	const profile = resolve(profileRoot);
	const mapPath = join(runtime, "node_modules", ".package-map.json");
	const lockPath = join(runtime, "pnpm-lock.yaml");
	const profileMapPath = join(profile, "node_modules", ".package-map.json");
	const profileLockPath = join(profile, "pnpm-lock.yaml");
	const runtimeRows = packageRowsFromActiveGraph(readFileSync(mapPath, "utf8"), readFileSync(lockPath, "utf8"), join(runtime, "node_modules"));
	const profileRows = packageRowsFromActiveGraph(readFileSync(profileMapPath, "utf8"), readFileSync(profileLockPath, "utf8"), join(profile, "node_modules"));
	const runtimeKeys = new Set(runtimeRows.map((row) => `${row.name}\u0000${row.version ?? ""}\u0000${row.integrity ?? ""}`));
	return [...runtimeRows, ...profileRows.filter((row) => !runtimeKeys.has(`${row.name}\u0000${row.version ?? ""}\u0000${row.integrity ?? ""}`))];
}
function pathPresent(path$1) {
	try {
		lstatSync(path$1);
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}
function within(root, path$1) {
	return path$1.startsWith(`${root}${sep}`);
}
/** Same static lookup order as DSH; do not load/normalize/heal a daily profile. */
function packageFromAnchor(anchor, name) {
	for (const directory of createRequire(anchor).resolve.paths(name) ?? []) {
		const candidate = join(directory, name);
		if (pathPresent(candidate)) {
			if (!existsSync(join(candidate, "package.json"))) throw new HostProfileError("target_bundle_unresolved", "invalid resolver-visible package");
			return realpathSync(candidate);
		}
	}
}
/**
* Pre-install inspection only. A fresh rc.1 Headless profile can use its two
* installation-owned bundles without a private importer. Never extend this
* absence rule to inject or runtime replay, which still call the strict reader.
*/
function inspectTargetHostGraph(runtimeRoot, profileRoot) {
	const runtime = realpathSync(runtimeRoot);
	const profile = realpathSync(profileRoot);
	const mapPath = join(profile, "node_modules", ".package-map.json");
	const lockPath = join(profile, "pnpm-lock.yaml");
	if (pathPresent(mapPath) && pathPresent(lockPath)) return {
		packages: readActiveHostGraph(runtime, profile),
		profileGraph: { state: "active_importer" }
	};
	if (pathPresent(mapPath) || pathPresent(lockPath)) throw new HostProfileError("active_graph_missing", "partial profile importer");
	if (pathPresent(join(profile, "node_modules")) || pathPresent(join(profile, ".dsh-module-fallback"))) throw new HostProfileError("target_profile_unmanaged_modules", "profile modules exist without an importer");
	const manifestPath = join(profile, "package.json");
	const manifest = readJsonObject(manifestPath, "profile_manifest_invalid");
	for (const key of [
		"dependencies",
		"devDependencies",
		"optionalDependencies",
		"peerDependencies",
		"bundledDependencies",
		"bundleDependencies"
	]) {
		const value = manifest[key];
		if (value !== void 0 && (!value || typeof value !== "object" || Object.keys(value).length !== 0 || Array.isArray(value) && !["bundledDependencies", "bundleDependencies"].includes(key))) throw new HostProfileError("target_profile_dependency_uninstalled", "profile declares dependencies without an importer");
	}
	const bundles = manifest.dsh?.profile?.bundles;
	const names = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"];
	if (!Array.isArray(bundles) || bundles.length !== names.length || bundles.some((name, index) => name !== names[index])) throw new HostProfileError("target_profile_bundles_unsupported", "not the installation-owned Headless bundle tuple");
	const modules = realpathSync(join(runtime, "node_modules"));
	const mapText = readFileSync(join(modules, ".package-map.json"), "utf8");
	const lockText = readFileSync(join(runtime, "pnpm-lock.yaml"), "utf8");
	const rows = packageRowsFromActiveGraph(mapText, lockText, modules);
	const evaluation = evaluateHostLock(rows, {
		platform: process.platform === "win32" ? "windows" : "posix",
		profileKind: "headless"
	});
	const selectedCohort = HOST_COHORTS.find((cohort) => cohort.id === evaluation.cohortId);
	if (evaluation.status !== "supported" || !selectedCohort) throw new HostProfileError("target_runtime_unsupported", "dependency-free inspection requires the active audited core cohort");
	const { records, reachable } = activeGraphRecords(mapText);
	const launcher = realpathSync(join(modules, "@deepseek-ai", "dsh"));
	const anchor = join(launcher, "package.json");
	const host = readJsonObject(anchor, "target_runtime_unsupported");
	const launcherId = [...reachable].filter((id) => id === "@deepseek-ai/dsh" || id.startsWith("@deepseek-ai/dsh@"));
	if (launcherId.length !== 1 || host.name !== "@deepseek-ai/dsh" || host.version !== selectedCohort.packages.find((row) => row.name === "@deepseek-ai/dsh")?.version || typeof records[launcherId[0]].url !== "string" || realpathSync(resolve(modules, records[launcherId[0]].url)) !== launcher || !within(modules, launcher)) throw new HostProfileError("target_runtime_unsupported", "launcher differs from the active runtime importer");
	const bundleRows = names.map((name) => {
		const packageRoot = packageFromAnchor(anchor, name);
		const ids = [...reachable].filter((id) => id === name || id.startsWith(`${name}@`));
		if (!packageRoot || !within(modules, packageRoot) || ids.length !== 1) throw new HostProfileError("target_bundle_unresolved", "bundle is not uniquely installation-owned");
		const record = records[ids[0]];
		if (typeof record.url !== "string" || realpathSync(resolve(modules, record.url)) !== packageRoot) throw new HostProfileError("target_bundle_origin_mismatch", "bundle differs from active runtime mapping");
		const installed = readJsonObject(join(packageRoot, "package.json"), "target_bundle_invalid");
		const patch = installed.dsh?.bundle?.patch;
		const locked = packageRowsFromPnpmLock(lockText, [name]).filter((row) => row.version === host.version && row.integrity);
		if (installed.name !== name || installed.version !== host.version || locked.length !== 1 || ids[0] !== name && ids[0].split("(", 1)[0] !== `${name}@${host.version}` || typeof patch !== "string" || isAbsolute(patch) || !within(packageRoot, realpathSync(resolve(packageRoot, patch))) || !statSync(resolve(packageRoot, patch)).isFile()) throw new HostProfileError("target_bundle_invalid", "bundle identity or patch is not installation-owned");
		return locked[0];
	});
	for (const name of [...CRITICAL_NAMES, ...names]) {
		const visible = packageFromAnchor(manifestPath, name);
		if (!visible) continue;
		const ids = [...reachable].filter((id) => id === name || id.startsWith(`${name}@`));
		if (ids.length !== 1 || typeof records[ids[0]].url !== "string" || !within(modules, visible) || realpathSync(resolve(modules, records[ids[0]].url)) !== visible) throw new HostProfileError("target_profile_module_shadow", "profile lookup differs from the audited installation");
	}
	return {
		packages: rows,
		profileGraph: {
			state: "dependency_free_headless",
			manifestSha256: createHash("sha256").update(readFileSync(manifestPath)).digest("hex"),
			bundles: bundleRows
		}
	};
}
/** Read and validate the actual runtime graph plus the installed profile plugin. */
function resolveActiveProfileHostLock(runtimeRoot, profileRoot, expectedPluginVersion) {
	const runtime = resolve(runtimeRoot);
	const profile = resolve(profileRoot);
	const lockPath = join(runtime, "pnpm-lock.yaml");
	const mapPath = join(runtime, "node_modules", ".package-map.json");
	const profileManifestPath = join(profile, "package.json");
	const pluginManifestPath = join(profile, "node_modules", "dsh-completion-guard", "package.json");
	const profileLockPath = join(profile, "pnpm-lock.yaml");
	const profileMapPath = join(profile, "node_modules", ".package-map.json");
	for (const path$1 of [
		lockPath,
		mapPath,
		profileLockPath,
		profileMapPath,
		profileManifestPath,
		pluginManifestPath
	]) if (!existsSync(path$1)) throw new HostProfileError("active_graph_missing", `required active graph file is missing: ${path$1}`);
	const rows = readActiveHostGraph(runtime, profile);
	const profileManifest = readJsonObject(profileManifestPath, "profile_manifest_invalid");
	const installedPlugin = readJsonObject(pluginManifestPath, "installed_plugin_invalid");
	const dependencies = profileManifest.dependencies;
	const profileConfig = profileManifest.dsh && typeof profileManifest.dsh === "object" ? profileManifest.dsh.profile : void 0;
	const bundles = profileConfig && typeof profileConfig === "object" ? profileConfig.bundles : void 0;
	if (!dependencies || typeof dependencies !== "object" || typeof dependencies["dsh-completion-guard"] !== "string" || !Array.isArray(bundles) || !bundles.includes("dsh-completion-guard")) throw new HostProfileError("profile_plugin_unbound", "profile does not bind the dsh-completion-guard dependency and bundle");
	if (installedPlugin.name !== "dsh-completion-guard" || installedPlugin.version !== expectedPluginVersion) throw new HostProfileError("profile_plugin_version_mismatch", "installed profile plugin identity does not match the generator version");
	const profileKind = bundles.includes("@deepseek-ai/dsh-web-app") || bundles.includes("dshmarket") ? "web" : "headless";
	const platform = process.platform === "win32" ? "windows" : "posix";
	const evaluation = evaluateHostLock(rows, {
		platform,
		profileKind
	});
	if (evaluation.status !== "supported") throw new HostProfileError(evaluation.reasonCode ?? "active_graph_unavailable", "active runtime graph does not match the supported host manifest");
	return {
		evaluation,
		runtimeRoot: runtime,
		profileRoot: profile,
		pluginVersion: expectedPluginVersion,
		platform,
		profileKind
	};
}
function readJsonObject(path$1, code) {
	try {
		const value = JSON.parse(readFileSync(path$1, "utf8"));
		if (value && typeof value === "object" && !Array.isArray(value)) return value;
	} catch {}
	throw new HostProfileError(code, `invalid JSON object: ${path$1}`);
}
function yamlQuote(value) {
	return JSON.stringify(value);
}
function renderManagedPatch(rows, platform, profileKind, activation, runtimeRoot, profileRoot) {
	const lines = [
		HOST_LOCK_MARKER_BEGIN,
		"- id: context-guard",
		"  name: dsh-completion-guard",
		"  config:"
	];
	lines.push("    hostLockPolicy: \"dsh-core/v1\"");
	if (runtimeRoot) lines.push(`    hostLockRuntimeRoot: ${yamlQuote(runtimeRoot)}`);
	if (profileRoot) lines.push(`    hostLockProfileRoot: ${yamlQuote(profileRoot)}`);
	if (activation) lines.push(`    activation: ${yamlQuote(activation)}`);
	lines.push(`    hostLockPlatform: ${yamlQuote(platform)}`);
	lines.push(`    hostLockProfile: ${yamlQuote(profileKind)}`);
	lines.push("    hostLockPackages:");
	for (const row of rows) {
		lines.push(`      - name: ${yamlQuote(row.name)}`);
		lines.push(`        version: ${yamlQuote(row.version ?? "")}`);
		lines.push(`        integrity: ${yamlQuote(row.integrity ?? "")}`);
	}
	lines.push(HOST_LOCK_MARKER_END);
	return `${lines.join("\n")}\n`;
}
function stripManagedPatch(text) {
	const begin = text.indexOf(HOST_LOCK_MARKER_BEGIN);
	const end = text.indexOf(HOST_LOCK_MARKER_END);
	if (begin < 0 && end < 0) return { base: text };
	if (begin < 0 || end < begin || text.indexOf(HOST_LOCK_MARKER_BEGIN, begin + 1) >= 0 || text.indexOf(HOST_LOCK_MARKER_END, end + 1) >= 0) throw new HostProfileError("profile_patch_marker_invalid", "managed host-lock marker is missing or duplicated");
	const after = end + 54;
	const prior = text.slice(begin, after);
	return {
		base: `${text.slice(0, begin).trimEnd()}\n${text.slice(after).trimStart()}`,
		prior
	};
}
function activationFromPatch(text) {
	const lines = text.split(/\r?\n/);
	const entries = lines.flatMap((line, index) => /^- id:\s*["']?context-guard["']?\s*$/.test(line) ? [index] : []).map((start) => {
		let end = lines.length;
		for (let index = start + 1; index < lines.length; index += 1) if (lines[index].startsWith("- ")) {
			end = index;
			break;
		}
		return lines.slice(start + 1, end).join("\n");
	}).filter((entry$1) => {
		const fields = entry$1.split(/\r?\n/).filter((line) => line.trim() && !line.trimStart().startsWith("#"));
		return !(fields.length === 1 && /^ {2}disabled:\s*(?:true|false)\s*(?:#.*)?$/.test(fields[0]));
	});
	if (entries.length > 1) throw new HostProfileError("profile_patch_duplicate_target", "multiple unmanaged context-guard configurations are ambiguous");
	if (entries.length === 0) return void 0;
	const entry = entries[0];
	const name = entry.match(/^\s{2}name:\s*(.+?)\s*$/m)?.[1]?.replace(/^['"]|['"]$/g, "");
	if (name && name !== "dsh-completion-guard") throw new HostProfileError("profile_patch_name_mismatch", "context-guard patch targets a different package");
	if (/^\s{4}hostLockPackages:\s*$/m.test(entry)) throw new HostProfileError("profile_patch_unmanaged_host_lock", "unmanaged hostLockPackages must be removed before managed injection");
	return (entry.match(/^\s{4}activation:\s*(.+?)\s*$/m)?.[1])?.replace(/^['"]|['"]$/g, "");
}
function activationFromManagedPatch(text) {
	const value = text.match(/^\s{4}activation:\s*(.+?)\s*$/m)?.[1];
	return value ? parseYamlScalar(value) : void 0;
}
/** Preserve template comments while replacing a sole top-level `[]` sentinel. */
function normalizeEmptyPatchBase(text) {
	const lines = text.split(/\r?\n/);
	const meaningful = lines.flatMap((line, index) => {
		const trimmed = line.trim();
		return trimmed && !trimmed.startsWith("#") ? [index] : [];
	});
	if (meaningful.length !== 1 || lines[meaningful[0]].trim() !== "[]") return text;
	return lines.filter((_line, index) => index !== meaningful[0]).join("\n");
}
/** Atomically inject a repeatable managed patch into the selected profile only. */
function injectActiveProfileHostLock(input) {
	const patchPath = join(input.profileRoot, "cordis.patch.yml");
	const stripped = stripManagedPatch(existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "");
	const base = normalizeEmptyPatchBase(stripped.base);
	const activation = activationFromPatch(base) ?? (stripped.prior ? activationFromManagedPatch(stripped.prior) : void 0);
	const managed = renderManagedPatch(input.evaluation.packages.filter((row) => row.version && row.integrity), input.platform, input.profileKind, activation, input.runtimeRoot, input.profileRoot);
	const next = `${base.trimEnd()}${base.trim() ? "\n\n" : ""}${managed}`;
	const temporary = `${patchPath}.context-guard-${process.pid}.tmp`;
	writeFileSync(temporary, next, {
		encoding: "utf8",
		flag: "wx"
	});
	renameSync(temporary, patchPath);
	return patchPath;
}
function parseYamlScalar(value) {
	const trimmed = value.trim();
	if (trimmed.startsWith("\"")) try {
		return JSON.parse(trimmed);
	} catch {
		return "";
	}
	if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'");
	return trimmed;
}
function parseYamlField(entry, index, value) {
	const indicator = value.trim();
	if (![
		">",
		">-",
		">+",
		"|",
		"|-",
		"|+"
	].includes(indicator)) return parseYamlScalar(value);
	const parts = [];
	for (let cursor = index + 1; cursor < entry.length; cursor += 1) {
		const indentation = (entry[index].match(/^\s*/)?.[0].length ?? 8) + 2;
		const blockLine = entry[cursor].match(/* @__PURE__ */ new RegExp(`^\\s{${indentation}}(.*)$`));
		if (!blockLine) break;
		parts.push(blockLine[1]);
	}
	return parts.join(indicator.startsWith(">") ? " " : "\n").trim();
}
/** Extract the bounded host tuple from DSH's composed YAML dump. */
function hostLockRowsFromComposedDump(text) {
	const lines = text.split(/\r?\n/);
	const starts = [];
	for (let index = 0; index < lines.length; index += 1) if (/^- id:\s*["']?context-guard["']?\s*$/.test(lines[index])) starts.push(index);
	if (starts.length !== 1) return [];
	const start = starts[0];
	let end = lines.length;
	for (let index = start + 1; index < lines.length; index += 1) if (lines[index].startsWith("- ")) {
		end = index;
		break;
	}
	const entry = lines.slice(start, end);
	const name = entry.find((line) => /^\s{2}name:/.test(line))?.replace(/^\s{2}name:\s*/, "");
	if (!name || parseYamlScalar(name) !== "dsh-completion-guard") return [];
	const hostIndex = entry.findIndex((line) => /^\s{4}hostLockPackages:\s*$/.test(line));
	if (hostIndex < 0) return [];
	const rows = [];
	for (let index = hostIndex + 1; index < entry.length; index += 1) {
		const nameMatch = entry[index].match(/^\s{6}- name:\s*(.+?)\s*$/);
		if (!nameMatch) {
			if (/^\s{4}\S/.test(entry[index])) break;
			continue;
		}
		const row = { name: parseYamlScalar(nameMatch[1]) };
		for (let cursor = index + 1; cursor < entry.length; cursor += 1) {
			if (/^\s{6}- name:/.test(entry[cursor]) || /^\s{4}\S/.test(entry[cursor])) break;
			const field$1 = entry[cursor].match(/^\s{8}(version|integrity):\s*(.+?)\s*$/);
			if (field$1) row[field$1[1]] = parseYamlField(entry, cursor, field$1[2]);
		}
		rows.push(row);
	}
	return rows;
}
function hostLockContextFromComposedDump(text) {
	const lines = text.split(/\r?\n/);
	const starts = lines.flatMap((line, index) => /^- id:\s*["']?context-guard["']?\s*$/.test(line) ? [index] : []);
	if (starts.length !== 1) return {};
	const start = starts[0];
	let end = lines.length;
	for (let index = start + 1; index < lines.length; index += 1) if (lines[index].startsWith("- ")) {
		end = index;
		break;
	}
	const entry = lines.slice(start, end);
	const platformValue = entry.find((line) => /^\s{4}hostLockPlatform:/.test(line))?.replace(/^\s{4}hostLockPlatform:\s*/, "");
	const profileValue = entry.find((line) => /^\s{4}hostLockProfile:/.test(line))?.replace(/^\s{4}hostLockProfile:\s*/, "");
	const platform = platformValue ? parseYamlScalar(platformValue) : void 0;
	const profileKind = profileValue ? parseYamlScalar(profileValue) : void 0;
	return {
		...platform === "posix" || platform === "windows" ? { platform } : {},
		...profileKind === "headless" || profileKind === "web" ? { profileKind } : {}
	};
}
function verifyComposedHostLockDump(text, expected, roots) {
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex((line) => /^- id:\s*["']?context-guard["']?\s*$/.test(line));
	const tail = lines.slice(start + 1);
	const end = tail.findIndex((line) => line.startsWith("- "));
	const entry = end < 0 ? tail : tail.slice(0, end);
	const settings = {};
	for (const key of [
		"hostLockPolicy",
		"hostLockRuntimeRoot",
		"hostLockProfileRoot"
	]) {
		const matches = entry.flatMap((line, index$1) => line.startsWith(`    ${key}:`) ? [index$1] : []);
		if (matches.length !== 1) throw new HostProfileError("host_lock_readback_mismatch", "composed config host lock does not match the active graph");
		const index = matches[0];
		settings[key] = parseYamlField(entry, index, entry[index].slice(entry[index].indexOf(":") + 1));
	}
	if (settings.hostLockPolicy !== "dsh-core/v1" || !isAbsolute(settings.hostLockRuntimeRoot) || !isAbsolute(settings.hostLockProfileRoot) || roots && (resolve(settings.hostLockRuntimeRoot) !== resolve(roots.runtimeRoot) || resolve(settings.hostLockProfileRoot) !== resolve(roots.profileRoot))) throw new HostProfileError("host_lock_readback_mismatch", "composed config host lock does not match the active graph");
	const context = hostLockContextFromComposedDump(text);
	const actual = evaluateHostLock(hostLockRowsFromComposedDump(text), context);
	if (actual.status !== "supported" || actual.digest !== expected.digest) throw new HostProfileError("host_lock_readback_mismatch", "composed config host lock does not match the active graph");
	return actual;
}

//#endregion
export { evidenceFromPersistedToolResult as $, proposeRebind as $n, isRestatement as $r, createProofManifestV2 as $t, lifecyclePhase as A, requestedTargetMatchesResolved as Ai, NO_PROGRESS_TURNS_BEFORE_STOP as An, canonicalRegistryBase as Ar, SUPPORTED_HOST_RANGE as At, RELEASE_OPERATIONS as B, sanitizeClauseText as Bi, progressFingerprint as Bn, clauseIsProtected as Br, authorityCaptureCounts as Bt, gitCommandMatchesTarget as C, STOP_PROTOCOL_VERSION_V2 as Ci, renderRecoveryPacket as Cn, classifyClause as Cr, evaluateHostCapability as Ct, FIRST_STEP_GUIDANCE as D, isStatefulAction as Di, isVerifyingCapability as Dn, extractOperation as Dr, selectHostCohort as Dt, verifiedLinearCommitReadback as E, boundedArtifactChoiceMatches as Ei, evidenceMatchesItem as En, extractMethod as Er, hostVersionFromPackages as Et, PROTOCOL_V4_NOTICE as F, COMMAND_SURFACE_MANIFEST as Fi, isRootPauseRequest as Fn, LEGACY_QUALIFICATION as Fr, satisfiesSupportedHostRange as Ft, inFlightReservation as G, unitDescendantIds as Gn, interpretClause as Gr, PROOF_KINDS_V2 as Gt, RELEASE_RESERVATION_PREFIX as H, sha256 as Hi, hasCurrentCertificate as Hn, governedClauseRestrictsExecution as Hr, certifyCheckpoint as Ht, PROTOCOL_V5_NOTICE as I, validateManifest as Ii, isWholeTaskCompletionClaim as In, actionVerbMatches as Ir, RC015_RC2_HOST_PACKAGES as It, releaseContractFor as J, isCurrentAcceptedBoundary as Jn, isExecutableItem as Jr, PROOF_PROTOCOL_VERSION_V2 as Jt, normalizeReleaseContract as K, availableBoundaryQualifications as Kn, interpretMessage as Kr, PROOF_MANIFEST_DOMAIN_V2 as Kt, applyUpgradeEligibility as L, canonicalizePath as Li, latestAssistantText as Ln, clarifiedSpanOf as Lr, RC015_HOST_PACKAGES as Lt, CAPTURE_V042_NOTICE as M, semanticActionFromText as Mi, decideTurnBoundary as Mn, classifyTaskIntent as Mr, compareHostVersions as Mt, DEFAULT_DELEGATION_TOOL_NAMES as N, validateActionManifest as Ni, decideTurnStopping as Nn, classifyUserInteraction as Nr, evaluateMinimumHostVersion as Nt, claimedBatchHasRealRootInput as O, requestedIdentityKey as Oi, CONTROL_RECORD_PREFIX as On, isInformationalMessage as Or, LATEST_SUPPORTED_HOST_VERSION as Ot, PROTOCOL_V3_NOTICE as P, validateActionTarget as Pi, decisionBoundaryKey as Pn, GRANTED_QUALIFICATION as Pr, parseHostVersion as Pt, supersedeItem as Q, confirmRebind as Qn, isQuestionScopeNeedingReview as Qr, createProofManifest as Qt, deriveProjection as R, digestStrings as Ri, latestRootInstruction as Rn, clauseAsksOwnQuestion as Rr, RC1_HOST_PACKAGES as Rt, executeRevalidatedGitEffect as S, STOP_PROTOCOL_VERSION as Si, recoveryDigest as Sn, captureItem as Sr, evaluateExternalWaitCapability as St, revalidateGitPrestate as T, actionCompatible as Ti, evidenceCoverage as Tn, extractArtifactPaths as Tr, evaluateToolSurfaceCapability as Tt, RELEASE_SETTLEMENT_PREFIX as U, certifiableOpenItems as Un, hasOrderedCoordination as Ur, PROOF_CAPABILITY_MATRIX as Ut, RELEASE_OPERATION_SURFACES as V, sanitizeUrl as Vi, goalCompletionDenial as Vn, explanationHasActionResidue as Vr, segmentAuthorityBlocks as Vt, contractById as W, certificateClosure as Wn, hasQuestionScope as Wr, PROOF_KINDS as Wt, releasePreEffectDecision as X, currentContractDigest as Xn, isInformationalFragment as Xr, bindProofV2ToProjection as Xt, releaseCoverage as Y, qualifyBoundary as Yn, isExplanationScope as Yr, bindProofToProjection as Yt, reservationFor as Z, createProjection as Zn, isOpenObligation as Zr, canonicalProjection as Zt, GIT_COMMAND_MANIFEST_IDS as _, BOUNDED_ARTIFACT_TYPES as _i, MIN_RECOVERY_CHAR_BUDGET as _n, capabilityFactOf as _r, HOST_CAPABILITY_PACKAGE_GROUPS as _t, injectActiveProfileHostLock as a, namedActions as ai, proofOperationMatches as an, CONFIRM_LINE_PATTERN as ar, isRunExecutable as at, commitTreeSnapshotDigest as b, SEMANTIC_ACTIONS as bi, closingHint as bn, removalIsPartiallyKnown as br, bindExecutableIdentity as bt, packageRowsFromPnpmLock as c, questionHeadsClause as ci, scopeCoverageDigest as cn, capabilityRemedyPhrase as cr, ACTIVE_HOST_COHORT_ID as ct, resolveInstalledHostLock as d, semanticActionOfScope as di, validateProofManifest as dn, itemDiagnosis as dr, ALPHA2_DSHMARKET_139_HOST_PACKAGES as dt, itemHoldsExecutionAuthority as ei, proofCapabilityReport as en, proposeRebindOutcome as er, extractTextContent as et, verifyComposedHostLockDump as f, splitTextFragments as fi, validateProofManifestV2 as fn, relevantEvidence as fr, ALPHA2_HOST_PACKAGES as ft, snapshotSessionEvents as g, ACTION_MANIFEST_VERSION as gi, DEFAULT_RECOVERY_CHAR_BUDGET as gn, capabilityConsequence as gr, GOAL_HOST_PACKAGES as gt, SessionApiError as h, ACTION_MANIFEST as hi, CLEANUP_CONDITION_RULE_SHORT as hn, admissibleForRemoval as hr, EXPECTED_HOST_PACKAGES as ht, hostLockRowsFromComposedDump as i, maskQuotedSpans as ii, proofHostSurfacesOf as in, replayRebindResult as ir, canonicalArgvFromCommand as it, previewFirstStepInjection as j, semanticActionFromCommand as ji, classifyCompletionClaim as jn, npmEscapedPackageName as jr, SUPPORTED_HOST_VERSIONS as jt, firstStepGuidance as k, requestedTargetAuthorizesMutation as ki, NO_PROGRESS_RECORD_PREFIX as kn, segmentClauses as kr, MIN_SUPPORTED_HOST_VERSION as kt, readActiveHostGraph as l, reportingHeadGoverns as li, sessionQuery as ln, deriveItemDiagnosis as lr, ACTIVE_HOST_COHORT_IDS as lt, SESSION_EVENT_ENVELOPE_INVALID as m, verbIsNegated as mi, CLEANUP_CONDITION_RULE_COMPACT as mn, actionHasCertificationPath as mr, DEFAULT_HOST_LOCK as mt, combineHostPolicy as n, legacyQuestionReadingIsInformational as ni, proofDigestV2 as nn, rebindAttemptKey as nr, isDeterministicCheck as nt, inspectTargetHostGraph as o, opensWithDirective as oi, proofV2Rejection as on, isFrozenV042RebindResponse as or, parsePwshCommand as ot, SESSION_API_UNSUPPORTED as p, statefulActionsOfScope as pi, CLEANUP_CONDITION_RULE as pn, DEPENDENCY_FREE_ONLY_CONDITION as pr, BASE_HOST_PACKAGES as pt, readbackSettlesContract as q, effectuateBoundary as qn, introducesActionClause as qr, PROOF_PROTOCOL_VERSION as qt, hostLockContextFromComposedDump as r, maskCodeSpans as ri, proofEvidenceConstraints as rn, rebindResponse as rr, withDurability as rt, packageRowsFromActiveGraph as s, qualificationOfClause as si, requiredSubjectsOf as sn, parseConfirmationMessage as sr, parseShellCommand as st, HostProfileError as t, kindOfScope as ti, proofDigest as tn, proposeRebindV042 as tr, extractToolSubject as tt, resolveActiveProfileHostLock as u, restatedContentOf as ui, sessionQueryV2 as un, evidenceAvailabilityReason as ur, ACTIVE_HOST_LAUNCHER_VERSION as ut, GIT_COMMAND_TEMPLATES as v, CERTIFICATE_VERSION as vi, carriesCleanupCondition as vn, partialFailureOf as vr, HOST_COHORTS as vt, parseGitCommandManifest as w, SUPPORTED_EVIDENCE_ADAPTERS as wi, bindingSatisfies as wn, environmentDefaultRepositoryTarget as wr, evaluateHostLock as wt, createGitPrestateEnvelope as x, STATEFUL_ACTIONS as xi, openItems as xn, captureClause as xr, bindLiveGoalCapability as xt, commitIndexSnapshotDigest as y, CERTIFICATE_VERSION_V2 as yi, cleanupConditionFor as yn, removalIsComplete as yr, LEGACY_HOST_COHORTS as yt, legacyRecordsNeedingReview as z, normalizeClause as zi, observeAssistantOutcome as zn, clauseIsGoverned as zr, ALPHA3_HOST_PACKAGES as zt };