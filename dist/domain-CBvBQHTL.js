import { createHash } from "node:crypto";
import * as path from "node:path";
import { dirname, join, resolve, sep } from "node:path";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

//#region src/domain/types.ts
function createProjection() {
	return {
		enabled: false,
		epoch: 0,
		contractRevision: 0,
		items: /* @__PURE__ */ new Map(),
		evidence: /* @__PURE__ */ new Map(),
		checkpoints: [],
		boundaries: [],
		externalOperations: /* @__PURE__ */ new Map(),
		sessionRefDigest: "11".repeat(32),
		hostLockDigest: "22".repeat(32),
		hostStatus: "supported",
		integrityViolations: [],
		lastObservedSourceSeq: -1,
		lastGuardEventSeq: -1,
		continuationAttempts: /* @__PURE__ */ new Map(),
		persistenceCorrectionAttempts: /* @__PURE__ */ new Map(),
		integrity: "valid"
	};
}

//#endregion
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
const ACTION_MANIFEST_VERSION = 1;
const SUPPORTED_EVIDENCE_ADAPTERS = {
	"context-guard.git.v1": "1.0.0",
	"context-guard.package.v1": "1.0.0",
	"context-guard.artifact.v1": "1.0.0",
	"context-guard.service.v1": "1.0.0",
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
	if (/^\s*(?:验证|确认|确保|verif(?:y|ies|ied|ying)\b|confirm\b)/i.test(text)) return "verify";
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
function stableTargetValue(value) {
	if (Array.isArray(value)) return `[${value.map(stableTargetValue).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableTargetValue(entry)}`).join(",")}}`;
	return JSON.stringify(value);
}
/**
* Compare identities captured from the root instruction with a complete
* adapter-resolved target. Requested targets are partial by design: only
* explicitly named identities (plus the active repository scope) are frozen.
*/
function requestedTargetMatchesResolved(action, requested, resolved) {
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
//#region src/domain/capture.ts
const CLAUSE_PATTERNS = [["prohibition", /^(?:(?:do not|don't|never)(?![A-Za-z0-9_./@\\-])|禁止|不要|不得)\s*(.+)$/i], ["acceptance", /^(?:verify|confirm|ensure|验收|确认|确保)\s*(.+)$/i]];
function classifyClause(text) {
	const normalizedText = normalizeClause(text);
	for (const [kind, pattern] of CLAUSE_PATTERNS) {
		const match = normalizedText.match(pattern);
		if (match) return {
			kind,
			body: normalizeClause(match[1].replace(/^[:：,，\s]+/, ""))
		};
	}
	return {
		kind: "requirement",
		body: normalizedText
	};
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
const TARGET_TOKEN = "(?:`[^`]+`|\"[^\"]+\"|'[^']+'|[\\p{L}\\p{N}@][\\p{L}\\p{N}@._/\\\\:+%?&=#\\[\\]-]*)";
function unquoteTargetToken(value) {
	if (!value) return void 0;
	const trimmed = value.trim().replace(/[.,;，。；]+$/, "");
	const unquoted = /^(?:`([^`]+)`|"([^"]+)"|'([^']+)')$/.exec(trimmed);
	return (unquoted?.[1] ?? unquoted?.[2] ?? unquoted?.[3] ?? trimmed) || void 0;
}
function labeledToken(text, labels) {
	return unquoteTargetToken(new RegExp(`(?:${labels})\\s*(?:[:=：]|为|是)?\\s*(${TARGET_TOKEN})`, "iu").exec(text)?.[1]);
}
function actionObjectToken(text, verbs, nouns) {
	const token = unquoteTargetToken(new RegExp(`(?:${verbs})\\s*(?:(?:${nouns})\\s*)?(?:[:=：]|为)?\\s*(${TARGET_TOKEN})`, "iu").exec(text)?.[1]);
	if (!token || /^(?:the|a|an|this|that|to|from|in|on|into|with|package|plugin|artifact|service|repository|repo|包|插件|制品|服务|仓库)$/i.test(token)) return void 0;
	return token;
}
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
function captureRequestedTarget(action, text, subject, surface) {
	if (action === "create" || action === "modify") {
		if (surface !== "artifact") return {
			target: {},
			reasonCode: "requested_target_artifact_id_missing"
		};
		return { target: {
			artifact_id: subject,
			scope: parentScope(subject)
		} };
	}
	if (action === "install" || action === "apply") {
		const parsed = splitPackageSpec(actionObjectToken(text, action === "install" ? "install|add|安装" : "apply|应用", "package|plugin|包|插件"));
		if (!parsed.packageId) return {
			target: {},
			reasonCode: "requested_target_package_id_missing"
		};
		const profile = labeledToken(text, "profile|配置(?:档|文件)?");
		const version = parsed.version ?? labeledToken(text, "version|版本");
		return { target: {
			package_id: parsed.packageId,
			...version ? { version } : {},
			...profile ? { profile } : {}
		} };
	}
	if (action === "restart") {
		const service = labeledToken(text, "service(?:_id)?|服务") ?? actionObjectToken(text, "restart|reload|重启|重新启动", "service|服务");
		return service ? { target: { service_id: service } } : {
			target: {},
			reasonCode: "requested_target_service_id_missing"
		};
	}
	if (action === "publish") {
		const parsed = splitPackageSpec(actionObjectToken(text, "publish|release|发布", "package|artifact|包|制品"));
		if (!parsed.packageId) return {
			target: {},
			reasonCode: "requested_target_artifact_id_missing"
		};
		const version = parsed.version ?? labeledToken(text, "version|版本");
		const registry = canonicalRegistryBase(labeledToken(text, "registry|注册表|仓库地址") ?? "");
		if (!registry) return {
			target: {},
			reasonCode: "requested_target_registry_missing_or_invalid"
		};
		return { target: {
			artifact_id: parsed.packageId,
			...version ? { version } : {},
			registry
		} };
	}
	if (action === "pull" || action === "fetch" || action === "commit" || action === "push") {
		const repository = labeledToken(text, "repository|repo|仓库") ?? (subject !== "scope" ? subject : void 0);
		if (!repository) return {
			target: {},
			reasonCode: "requested_target_repository_missing"
		};
		const branch = labeledToken(text, "branch|分支");
		const remote = labeledToken(text, "remote|远端");
		const refspec = labeledToken(text, "refspec|引用规范") ?? (action !== "commit" ? branch : void 0);
		return { target: {
			repository,
			...action === "commit" && branch ? { branch } : {},
			...action !== "commit" && remote ? { remote } : {},
			...action !== "commit" && refspec ? { refspec } : {}
		} };
	}
	return { target: surface === "artifact" ? {
		artifact_id: subject,
		scope: parentScope(subject)
	} : { scope: subject } };
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
function segmentClauses(text) {
	const normalized = normalizeClause(text);
	if (!normalized) return [];
	const parts = normalized.split(/(?<=[。！？；])|(?<=[.!?])(?=\s|$)|(?<=(?:^|[\s。！？；.!?，,；:]))(?=(?:(?:do not|don't|never)(?![A-Za-z0-9_./@\\-])|禁止|不要|不得))/i).map((part) => part.trim()).filter(Boolean);
	const segments = [];
	for (const part of parts) {
		const { kind, body } = classifyClause(part);
		segments.push({
			kind,
			body,
			paths: extractArtifactPaths(body)
		});
	}
	return segments;
}
/**
* Build a GuardItem from an already-classified clause body and a resolved
* verification subject/surface.
*/
function captureItem(kind, body, sourceMessageId, id, revision, subject, surface, method, operation) {
	const sanitized = sanitizeClauseText(body);
	const semanticAction = semanticActionFromText(sanitized);
	const capturedTarget = captureRequestedTarget(semanticAction, sanitized, subject, surface);
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
			surface,
			subject,
			method,
			operation: effectiveOperation
		},
		semanticAction,
		requestedTarget: capturedTarget.target,
		targetCaptureStatus: capturedTarget.reasonCode ? "clarification_required" : "resolved",
		...capturedTarget.reasonCode ? { targetCaptureReasonCode: capturedTarget.reasonCode } : {},
		authority: "root_instruction"
	};
	if (/(?:等待|暂停|等).{0,12}(?:用户|你|您|我).{0,12}(?:选择|确认|输入)(?:.{0,8}(?:后|再)?继续)?|收到.{0,8}(?:用户|你|您|我)?的?确认.{0,8}(?:后)?再继续|\bwait for (?:the )?(?:user|your)\b|\bcontinue only after (?:the )?(?:user's?|your) confirmation\b/i.test(sanitized)) item.waitAuthorization = {
		kind: "root_explicit_wait",
		id: `wait:${id}:${sha256(sanitized).slice(0, 12)}`
	};
	else if (/(?:请选择|请决定|需要用户决定)|\b(?:please choose|user decision required)\b/i.test(sanitized)) item.waitAuthorization = {
		kind: "user_decision_item",
		id: `decision:${id}:${sha256(sanitized).slice(0, 12)}`
	};
	if (/(?:明确|允许|授权).{0,8}(?:延期|延后|移出范围)|(?:先)?延期(?:到|至).{1,24}(?:迭代|版本|里程碑|日期)|本(?:次|个)?迭代(?:暂时|暂)?不做|\b(?:explicitly )?(?:defer|remove from scope)\b|\bdefer\b.{0,24}\b(?:next iteration|milestone|release)\b|\bout of scope for (?:this|the current) iteration\b/i.test(sanitized)) item.deferAuthorization = {
		kind: "root_explicit_defer",
		id: `defer:${id}:${sha256(sanitized).slice(0, 12)}`
	};
	if (/(?:持续推进|继续推进).{0,40}(?:直到|直至).{1,80}(?:为止|完成|结束)|(?:不要|不得|别)停.{0,40}(?:直到|直至)|\b(?:keep working|continue working|do not stop|don't stop)\b.{0,80}\b(?:until|unless)\b/i.test(sanitized)) item.persistenceAuthorization = {
		kind: "root_explicit_persistence",
		id: `persist:${id}:${sha256(sanitized).slice(0, 12)}`
	};
	return item;
}
/**
* Capture one contract clause. Every captured item receives a concrete
* verification contract: a named artifact path (artifact surface) or the
* session scope (scope surface), so an unrelated file read can never close it.
*/
function captureClause(text, sourceMessageId, id, revision, scope = {}) {
	const { kind, body } = classifyClause(text);
	const path$1 = extractArtifactPaths(sanitizeClauseText(body))[0] ?? "";
	const surface = path$1 ? "artifact" : "scope";
	return captureItem(kind, body, sourceMessageId, id, revision, path$1 || scope.cwd || "scope", surface, extractMethod(body), extractOperation(body));
}

//#endregion
//#region src/domain/contract-digest.ts
function stable$2(value) {
	if (Array.isArray(value)) return `[${value.map(stable$2).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stable$2(entry)}`).join(",")}}`;
	return JSON.stringify(value);
}
/** One authoritative contract identity shared by checkpoints and boundaries. */
function currentContractDigest(projection) {
	return sha256(stable$2([...projection.items.values()].sort((a, b) => a.id.localeCompare(b.id)).map((item) => [
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
const MAX_RECOVERY_ITEMS = 8;
const MAX_RECOVERY_EVIDENCE = 20;
const MORE_ITEMS_RULE = (remaining) => `…(${remaining} more open items; the full list is in the checkpoint tool response)`;
const MORE_EVIDENCE_RULE = (remaining) => `…(${remaining} more evidence rows)`;
const COMPLETION_RULE = "Obtain a Context Guard checkpoint from matching durable evidence before claiming completion.";
/**
* An actionable one-line hint for how an open item's verification contract can
* be closed. It never weakens the contract; it only names the missing facet so
* the agent can produce the right evidence shape instead of reverse-engineering
* the guard. When `evidenceIds` is given, the hint accounts for what those
* evidence already cover.
*/
function closingHint(projection, item, evidenceIds) {
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
function openItems$1(projection) {
	return [...projection.items.values()].filter((item) => item.status === "pending").sort((a, b) => a.revision - b.revision || (a.id < b.id ? -1 : 1));
}
/**
* Content identity of a rendered recovery packet, bound to the contract
* revision and epoch it was rendered from. The runtime compares digests before
* re-injecting, so a repeatedly re-armed recovery with unchanged content is
* injected once instead of looping (v0.2.1).
*/
function recoveryDigest(packet, projection) {
	return sha256(JSON.stringify({
		packet,
		revision: projection.contractRevision,
		epoch: projection.epoch
	}));
}
function renderRecoveryPacket(projection, options = {}) {
	const budget = options.charBudget ?? DEFAULT_RECOVERY_CHAR_BUDGET;
	const lines = [];
	let used = 0;
	const push = (line) => {
		if (used + line.length + 1 > budget) return false;
		lines.push(line);
		used += line.length + 1;
		return true;
	};
	const items = openItems$1(projection);
	const listedIds = /* @__PURE__ */ new Set();
	const pushItems = (list, render) => {
		let count = 0;
		for (const item of list) {
			if (count >= MAX_RECOVERY_ITEMS) {
				push(MORE_ITEMS_RULE(list.length - count));
				return true;
			}
			if (!push(render(item))) return false;
			listedIds.add(item.id);
			count += 1;
		}
		return true;
	};
	const requirementItems = items.filter((item) => item.kind === "requirement");
	const compact = budget < 512;
	const itemDiagnostic = (item) => {
		if (compact) return `[${item.id}] ${item.normalizedText}`;
		const action = item.semanticAction ?? "generic_run";
		const spec = ACTION_MANIFEST.actions[action];
		return `[${item.id}] ${item.normalizedText} action=${action} requested=${JSON.stringify(item.requestedTarget ?? {})} predicate=${spec.predicateId}@1 params=inline(resolved:${spec.resolvedTargetKeys.join(",") || "-"};observed:${spec.observedStateKeys.join(",") || "-"})`;
	};
	if (!pushItems(requirementItems, itemDiagnostic)) return finalize();
	if (!pushItems(items.filter((item) => item.kind === "prohibition"), (item) => `[${item.id}] DO NOT ${item.normalizedText}`)) return finalize();
	if (!pushItems(items.filter((item) => item.kind === "acceptance"), (item) => `VERIFY ${itemDiagnostic(item)}`)) return finalize();
	const citableEvidence = [...projection.evidence.values()].filter((evidence) => evidence.epoch === projection.epoch && evidence.outcome === "success").sort((a, b) => a.id < b.id ? -1 : 1);
	let evidenceCount = 0;
	for (const evidence of citableEvidence) {
		if (evidenceCount >= MAX_RECOVERY_EVIDENCE) {
			push(MORE_EVIDENCE_RULE(citableEvidence.length - evidenceCount));
			break;
		}
		if (!push([
			`evidence ${evidence.id}`,
			`tool=${evidence.toolName}`,
			`action=${evidence.semanticAction ?? "generic_run"}`,
			`role=${evidence.evidenceRole ?? "effect"}`,
			`resolved=${JSON.stringify(evidence.resolvedTarget ?? {})}`,
			`observed=${JSON.stringify(evidence.observedState ?? {})}`,
			`adapter=${evidence.adapterId ?? "-"}@${evidence.adapterVersion ?? "-"}`,
			`ops=${(evidence.operations ?? []).map((entry) => entry.op).join(",") || "-"}`,
			`executables=${(evidence.executables ?? []).join(",") || "-"}`,
			`parse=${evidence.parseStatus ?? "adapter_unavailable"}`
		].join(" "))) return finalize();
		evidenceCount += 1;
	}
	for (const item of [...projection.items.values()].filter((item$1) => item$1.status === "superseded")) if (item.supersededBy && !push(`[${item.id} -> ${item.supersededBy}]`)) return finalize();
	for (const binding of options.rejectedBindings ?? []) {
		const offending = binding.offendingEvidenceIds?.length ? ` offending=${binding.offendingEvidenceIds.join(",")}` : "";
		const reason = binding.reasonCode ? binding.reasonCode : binding.reason;
		if (!push(`rejected ${binding.itemId}: ${reason}${offending}`)) return finalize();
	}
	for (const item of items) {
		if (item.kind === "prohibition" || !listedIds.has(item.id)) continue;
		push(`closing hint [${item.id}]: ${closingHint(projection, item)}`);
	}
	push(COMPLETION_RULE);
	return finalize();
	function finalize() {
		return lines.join("\n");
	}
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
	const facts = citedEvidence(projection, binding);
	const incompatible = facts.filter((fact) => !actionCompatible(requiredAction, fact.semanticAction ?? "generic_run"));
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
		openItems: openItems(projection),
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
		if (item.targetCaptureStatus === "clarification_required") {
			rejectedBindings.push({
				itemId: item.id,
				reason: "the root instruction does not identify an action-specific target; clarify or explicitly rebind the item",
				reasonCode: item.targetCaptureReasonCode ?? "clarification_or_rebind_required",
				hint: closingHint(projection, item)
			});
			continue;
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
	const open = openItems(projection).filter((itemId) => !bindings.some((binding) => binding.itemId === itemId));
	if (rejectedBindings.length || open.length) return {
		status: "incomplete",
		contractRevision: projection.contractRevision,
		openItems: openItems(projection),
		rejectedBindings
	};
	try {
		const contractSha256 = currentContractDigest(projection);
		const openDigest = digestStrings(openItems(projection));
		const evidenceSha256 = evidenceSha256Digest(referencedFacts);
		const bindingDigest$1 = bindingDigest(records, resolveAllowlist("product"));
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
		const checkpoint = {
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
			openItems: openItems(projection),
			rejectedBindings: [{
				itemId: "*",
				reason: error instanceof Error ? error.message : "certificate manifest rejected",
				reasonCode: "certificate_manifest_rejected"
			}]
		};
	}
}
function openItems(projection) {
	return [...projection.items.values()].filter((item) => item.status === "pending" && item.kind !== "prohibition").map((item) => item.id);
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
//#region src/domain/conversation.ts
/**
* Punctuation and whitespace that may surround a bare progression phrase
* without turning it into sentence content.
*/
const PUNCT = String.raw`[\s。，、；：！？．,;:!?\-*"'“”‘’()（）.…～~]`;
/**
* Session-layer phrases that acknowledge or advance the conversation without
* stating a task. Longer forms come first so the alternation consumes them
* before their prefixes.
*/
const PROGRESSION_SOURCE = String.raw`(?:继续执行|继续吧|请继续|继续|接着做|接着|下一步|没问题|知道了|明白了|了解|好的?|是的?|对的?|收到|可以|行|嗯+|continue|go on|go ahead|keep going|proceed|okay|ok|yes|sure|right|next)`;
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
function classifyUserInteraction(text) {
	const normalized = normalizeClause(text);
	if (!normalized) return "instruction";
	if (PROGRESSION_WHOLE.test(normalized)) return "conversational";
	if (PROHIBITION_LEAD.test(normalized)) return "instruction";
	if (hasStrongTaskFeature(normalized)) return "instruction";
	if (QUESTION_TERMS.test(normalized)) return "conversational";
	if (META_COMMENT_LEAD.test(normalized)) return "conversational";
	if (PROGRESSION_LEAD.test(normalized)) return "conversational";
	return "instruction";
}

//#endregion
//#region src/domain/contract-segment.ts
const REFERENCE_FRAME = /(?:以下|下面|下列|附上|粘贴|提供).{0,12}(?:报告|材料|内容|记录|日志).{0,12}(?:供参考|参考|如下)|(?:for reference|pasted|attached|following).{0,16}(?:report|material|log)/i;
const INSTRUCTION_SIGNAL = /(?:请|需要|必须|务必|禁止|不要|不得|运行|执行|修改|创建|读取|验证|检查|安装|拉取|提交|推送|发布|重启)|\b(?:please|must|shall|do not|run|execute|modify|create|read|verify|check|install|pull|commit|push|publish|restart)\b/i;
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
//#region src/domain/host-lock.ts
const SUPPORTED_HOST_MANIFEST = {
	manifestVersion: 1,
	supportedGoalVersions: ["0.1.1-rc.2"],
	capabilities: [
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
	]
};
/**
* Audited package identities. This is a catalogue, not one indivisible lock:
* evaluateHostLock requires only BASE_HOST_PACKAGES globally and evaluates the
* remaining action/platform groups independently.
*/
const EXPECTED_HOST_PACKAGES = [
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
];
const packageNames = (...names) => new Set(names);
const BASE_HOST_PACKAGES = packageNames("@deepseek-ai/cordis", "@deepseek-ai/dsh-agent", "@deepseek-ai/dsh-commands", "@deepseek-ai/dsh-llm", "@deepseek-ai/dsh-session", "@deepseek-ai/dsh-tools");
const GOAL_HOST_PACKAGES = packageNames("@deepseek-ai/dsh-goal", "@deepseek-ai/dsh-tool-goal");
const HOST_CAPABILITY_PACKAGE_GROUPS = {
	agent_loop: packageNames("@deepseek-ai/dsh-agent-loop"),
	terminal_posix: packageNames("@deepseek-ai/dsh-tool-bash", "@deepseek-ai/dsh-shell", "@deepseek-ai/dsh-subprocess-local", "@deepseek-ai/dsh-bash-sandbox", "@deepseek-ai/dsh-shell-env"),
	terminal_windows: packageNames("@deepseek-ai/dsh-tool-pwsh", "@deepseek-ai/dsh-shell", "@deepseek-ai/dsh-subprocess-local", "@deepseek-ai/dsh-pwsh-sandbox", "@deepseek-ai/dsh-shell-env"),
	dsh_cli: packageNames("@deepseek-ai/dsh"),
	plugin_inventory: packageNames("@deepseek-ai/dsh-host-plugin-inventory"),
	web_control: packageNames("dshmarket", "@deepseek-ai/dsh-host-webserver", "@deepseek-ai/dsh-web-app"),
	jobs: packageNames("@deepseek-ai/dsh-jobs", "@deepseek-ai/dsh-jobs-local", "@deepseek-ai/dsh-tool-jobs"),
	filesystem: packageNames("@deepseek-ai/dsh-tool-fs", "@deepseek-ai/dsh-fs", "@deepseek-ai/dsh-fs-local", "@deepseek-ai/dsh-fs-sandbox", "@deepseek-ai/dsh-fs-observation-policy", "@deepseek-ai/dsh-sandbox", "@deepseek-ai/dsh-sandbox-policy", "@deepseek-ai/dsh-user-approval", "@deepseek-ai/dsh-attachment", "@deepseek-ai/dsh-system-prompt")
};
function stableRows(rows) {
	return [...rows].map((row) => ({ ...row })).sort((a, b) => a.name.localeCompare(b.name) || (a.version ?? "").localeCompare(b.version ?? "") || (a.integrity ?? "").localeCompare(b.integrity ?? ""));
}
function statusForPackages(id, rows, requiredNames) {
	const requiredPackages = [...requiredNames].sort();
	const relevant = rows.filter((row) => requiredNames.has(row.name));
	const counts = /* @__PURE__ */ new Map();
	for (const row of relevant) counts.set(row.name, (counts.get(row.name) ?? 0) + 1);
	const missingPackages = requiredPackages.filter((name) => !counts.has(name));
	const digest = safeHostLockDigest(relevant, { capabilityId: id });
	if ([...counts.values()].some((count) => count > 1)) return {
		id,
		status: "unavailable",
		digest,
		requiredPackages,
		missingPackages,
		reasonCode: "host_capability_duplicate_package"
	};
	if (missingPackages.length > 0) return {
		id,
		status: "unavailable",
		digest,
		requiredPackages,
		missingPackages,
		reasonCode: "host_capability_missing"
	};
	const expected = new Map(EXPECTED_HOST_PACKAGES.map((row) => [row.name, row]));
	for (const row of relevant) {
		const pinned = expected.get(row.name);
		if (!row.version || !row.integrity) return {
			id,
			status: "unavailable",
			digest,
			requiredPackages,
			missingPackages,
			reasonCode: "host_capability_missing"
		};
		if (row.version !== pinned.version) return {
			id,
			status: "unsupported",
			digest,
			requiredPackages,
			missingPackages,
			reasonCode: "host_capability_version_mismatch"
		};
		if (row.integrity !== pinned.integrity) return {
			id,
			status: "unsupported",
			digest,
			requiredPackages,
			missingPackages,
			reasonCode: "host_capability_integrity_mismatch"
		};
	}
	return {
		id,
		status: "supported",
		digest,
		requiredPackages,
		missingPackages
	};
}
function capabilityEvaluations(rows) {
	return Object.fromEntries(Object.entries(HOST_CAPABILITY_PACKAGE_GROUPS).map(([id, packages]) => [id, statusForPackages(id, rows, packages)]));
}
function evaluateHostLock(rows, context = {}) {
	const supplied = stableRows(rows);
	const capabilities = capabilityEvaluations(supplied);
	const counts = /* @__PURE__ */ new Map();
	for (const row of supplied) counts.set(row.name, (counts.get(row.name) ?? 0) + 1);
	const goalRows = [...GOAL_HOST_PACKAGES].filter((name) => counts.has(name));
	const goalAvailable = goalRows.length === GOAL_HOST_PACKAGES.size;
	const digest = safeHostLockDigest(supplied, context);
	const base = statusForPackages("base", supplied, BASE_HOST_PACKAGES);
	const baseDuplicate = supplied.find((row) => BASE_HOST_PACKAGES.has(row.name) && (counts.get(row.name) ?? 0) > 1);
	const goalDuplicate = supplied.find((row) => GOAL_HOST_PACKAGES.has(row.name) && (counts.get(row.name) ?? 0) > 1);
	const expectedNames = new Set(EXPECTED_HOST_PACKAGES.map((row) => row.name));
	const unknown = supplied.find((row) => !expectedNames.has(row.name));
	const baseResult = {
		digest,
		goalAvailable,
		packages: supplied,
		capabilities,
		...context.platform ? { platform: context.platform } : {},
		...context.profileKind ? { profileKind: context.profileKind } : {}
	};
	if (unknown) return {
		...baseResult,
		status: "unsupported",
		reasonCode: "host_lock_unknown_package"
	};
	if (baseDuplicate || goalDuplicate) return {
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
		const goal = statusForPackages("goal", supplied, GOAL_HOST_PACKAGES);
		if (goal.status !== "supported") return {
			...baseResult,
			status: goal.status,
			goalAvailable: false,
			reasonCode: goal.reasonCode === "host_capability_version_mismatch" ? "host_lock_version_mismatch" : goal.reasonCode === "host_capability_integrity_mismatch" ? "host_lock_integrity_mismatch" : "host_lock_missing"
		};
	}
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
	if ((request.action === "apply" || request.action === "restart") && profileKind === "web") groups.push("web_control");
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
	const result = statusForPackages(`action.${request.action}.${platform ?? "native"}.${profileKind ?? "unknown"}`, evaluation.packages, required);
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
	const result = statusForPackages("boundary.external_wait.jobs", evaluation.packages, required);
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
	const result = statusForPackages(`tool.${surface}.${platform ?? "native"}`, evaluation.packages, required);
	if (evaluation.status !== "supported") return {
		...result,
		status: evaluation.status,
		digest: evaluation.digest
	};
	return result;
}
function safeHostLockDigest(packages, context = {}) {
	try {
		const capabilities = [
			...SUPPORTED_HOST_MANIFEST.capabilities ?? [],
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
			...SUPPORTED_HOST_MANIFEST,
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
const DEFAULT_HOST_LOCK = evaluateHostLock(EXPECTED_HOST_PACKAGES.filter((row) => BASE_HOST_PACKAGES.has(row.name)));

//#endregion
//#region src/domain/goal-gate.ts
function hasCurrentCertificate(projection) {
	const checkpoint = projection.checkpoints.at(-1);
	let reason;
	if (projection.integrity !== "valid") reason = "integrity_invalid";
	else if (projection.hostStatus !== "supported") reason = "host_lock_unsupported";
	else if (!checkpoint || checkpoint.result !== "certified") reason = "certificate_missing";
	else if (checkpoint.epoch !== projection.epoch) reason = "stale_epoch";
	else if (checkpoint.sessionRefDigest !== projection.sessionRefDigest) reason = "foreign_session";
	else if (checkpoint.hostLockDigest !== projection.hostLockDigest) reason = "stale_host_lock";
	else if (checkpoint.contractRevision !== projection.contractRevision) reason = "stale_contract_revision";
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
function asRecord$1(value) {
	return typeof value === "object" && value !== null ? value : void 0;
}
function extractTextContent(content) {
	const parts = [];
	for (const block$1 of content) {
		const record = asRecord$1(block$1);
		if (!record) continue;
		if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
		if (record.type === "tool-result" && Array.isArray(record.content)) parts.push(extractTextContent(record.content));
	}
	return parts.join("\n");
}
function metaPaths(meta) {
	const record = asRecord$1(meta);
	if (!record) return [];
	if (typeof record.path === "string") return [record.path];
	if (Array.isArray(record.diffs)) return record.diffs.map((diff) => asRecord$1(diff)?.path).filter((path$1) => typeof path$1 === "string");
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
	const outer = asRecord$1(meta);
	const value = asRecord$1(outer?.contextGuard ?? outer?.context_guard);
	if (!value) return void 0;
	const action = value.semanticAction ?? value.semantic_action;
	const role = value.evidenceRole ?? value.evidence_role;
	const resolved = asRecord$1(value.resolvedTarget ?? value.resolved_target);
	const observed = asRecord$1(value.observedState ?? value.observed_state);
	const rawExpected = asRecord$1(value.expectedTransition);
	const expectedParameters = asRecord$1(rawExpected?.parameters);
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
	const record = asRecord$1(meta);
	if (!record) return void 0;
	const rawExit = record.exitCode ?? record.exit_code;
	const rawSignal = record.signal;
	if (rawSignal !== void 0 && rawSignal !== null) return {
		exitCode: typeof rawExit === "number" ? rawExit : void 0,
		negative: true
	};
	if (typeof rawExit === "number") return {
		exitCode: rawExit,
		negative: false
	};
}
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
	while (index >= 0) {
		const line = lines[index].trim();
		const exitMatch = line.match(/^\[(?:exit code|shell exited: code)\s*:?\s*(\d+)\]$/);
		const negativeLine = /^\[(?:timed out|sandbox[^\]]*|killed by signal[^\]]*|shell killed by signal[^\]]*|shell exited|interrupted[^\]]*)[^\]]*\]$/i.test(line);
		if (exitMatch) {
			if (exitCode === void 0) exitCode = Number(exitMatch[1]);
		} else if (negativeLine) negative = true;
		else break;
		index -= 1;
	}
	return {
		exitCode,
		negative
	};
}
function metaUrls(meta) {
	const record = asRecord$1(meta);
	if (!record) return [];
	if (typeof record.url === "string") return [sanitizeUrl(record.url)];
	if (Array.isArray(record.sources)) return record.sources.map((source) => asRecord$1(source)?.url).filter((url) => typeof url === "string").map((url) => sanitizeUrl(url));
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
		const external = asRecord$1(asRecord$1(result.meta)?.contextGuardExternalOperation);
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
		const disposition = asRecord$1(asRecord$1(result.meta)?.contextGuardDisposition);
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
			const terminal = structuredTerminalFacts(result.meta) ?? extractTerminalFacts(result.textContent);
			const backgrounded = args.run_in_background === true;
			const commandDetails = analyzeCommand(command, typeof args.workdir === "string" ? args.workdir : defaultCwd, call.name);
			const commandCwd = typeof args.workdir === "string" ? args.workdir : defaultCwd;
			const action = structured?.semanticAction ?? semanticActionFromCommand(command);
			const deterministic = commandDetails.status === "supported" && !backgrounded && isDeterministicCheck(command);
			const outcome = backgrounded ? "unknown" : result.error || terminal.negative ? "failure" : terminal.exitCode === void 0 ? call.name === "bash" || call.name === "pwsh" ? "success" : "unknown" : terminal.exitCode === 0 ? "success" : "failure";
			const subject = {
				capabilities: ["shell", ...deterministic ? ["deterministic-check"] : []],
				subjects: unique(commandDetails.subjects),
				surfaces: ["scope"],
				outcome,
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
//#region src/domain/derive.ts
const PROTOCOL_V3_NOTICE = "Context Guard protocol boundary: v3.0.0";
function isProtocolBoundaryNotice(event) {
	if (event.type !== "user/message") return false;
	const data = asRecord(event.data);
	const source = asRecord(data?.source);
	if (source?.kind !== "plugin" || source.plugin !== "context-guard" || source.form !== "notice") return false;
	return extractTextContent(data?.content ?? []) === PROTOCOL_V3_NOTICE;
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
	const normalized = {
		...value,
		goal_ref: goal ? {
			id: goal.id,
			revision: goal.revision
		} : value.goal_ref
	};
	return JSON.stringify(normalized) === JSON.stringify(exact);
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
* Insert every independently tracked clause from one user message. Compound
* instructions are segmented and each distinct artifact path becomes its own
* item, so evidence for one file cannot close a message that also covers other
* files or embeds prohibitions.
*/
function insertItems(projection, text, sourceMessageId, scope, authority = "root_instruction", legacy = false, legacyAuthorityProven = false) {
	const before = new Set(projection.items.keys());
	for (const segment of segmentClauses(text)) {
		if (classifyUserInteraction(segment.body) === "conversational") continue;
		if (segment.kind === "requirement" && segment.paths.length === 0 && isInstructionFraming(segment.body)) continue;
		if (segment.kind === "prohibition" || segment.paths.length === 0) {
			insert(projection, segment.kind, segment.body, sourceMessageId, scope.cwd || "scope", "scope");
			continue;
		}
		for (const path$1 of segment.paths) insert(projection, segment.kind, segment.body, sourceMessageId, resolveArtifact(path$1, scope), "artifact");
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
}
function insert(projection, kind, body, sourceMessageId, subject, surface) {
	const revision = projection.contractRevision + 1;
	const id = nextId(projection.items, kind);
	const item = captureItem(kind, body, sourceMessageId, id, revision, subject, surface, extractMethod(body), extractOperation(body));
	const duplicate = [...projection.items.values()].find((existing) => existing.kind === kind && existing.status === "pending" && existing.textSha256 === item.textSha256 && existing.verification.subject === subject);
	if (duplicate) supersedeItem(projection.items, duplicate.id, item);
	else projection.items.set(id, item);
	projection.contractRevision = item.revision;
}
/**
* Pure, deterministic re-derivation of the guard projection from the DSH
* native event log. Context Guard never writes custom session events, so every
* piece of state is derived from `command/run`, `user/message`, `tool/call`,
* `tool/result`, `tool/code-dispatch-start`, `tool/code-dispatch`, and
* `compaction/summary`.
*/
function deriveProjection(sourceEvents, config, scope, durableConfirmed, hostLock = DEFAULT_HOST_LOCK) {
	const projection = createProjection();
	if (scope.sessionHeader) projection.sessionRefDigest = sessionRefDigest(scope.sessionHeader);
	projection.hostLockDigest = hostLock.digest;
	projection.hostStatus = hostLock.status;
	projection.hostReasonCode = hostLock.reasonCode;
	let enabled = config.activation === "always";
	let epoch = 0;
	let evidenceCounter = 0;
	let compacted = false;
	let enablementTransitioned = false;
	let lastCompactionSeq = -1;
	const pendingCalls = /* @__PURE__ */ new Map();
	const protocolBoundarySeq = sourceEvents.find(isProtocolBoundaryNotice)?.seq;
	const priorRootMessages = [];
	for (const event of sourceEvents) {
		projection.lastObservedSourceSeq = Math.max(projection.lastObservedSourceSeq, event.seq);
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
				}
				break;
			}
			case "compaction/summary":
				compacted = true;
				lastCompactionSeq = event.seq;
				break;
			case "user/message": {
				if (isProtocolBoundaryNotice(event)) break;
				if (!enabled) break;
				const data = asRecord(event.data);
				if (asRecord(data?.source)?.kind !== "user") break;
				const text = extractTextContent(data?.content ?? []);
				if (!text.trim()) break;
				if (isInformationalMessage(text)) break;
				if (classifyUserInteraction(text) === "conversational") break;
				const blocks = segmentAuthorityBlocks(text, priorRootMessages);
				for (const block$1 of blocks) {
					if (!block$1.capture) continue;
					insertItems(projection, block$1.text, `m${event.seq}:${block$1.blockId}`, scope, block$1.authority === "root_adoption" ? "root_adoption" : "root_instruction", protocolBoundarySeq !== void 0 && event.seq < protocolBoundarySeq, block$1.kind === "instruction" || block$1.authority === "root_adoption");
				}
				priorRootMessages.push(text);
				if (priorRootMessages.length > 16) priorRootMessages.shift();
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
					rootCallId: typeof data?.rootCallId === "string" ? data.rootCallId : void 0
				};
				if (call.name === "context_guard_checkpoint") {
					const args = parseArguments(call.arguments);
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
							...Array.isArray(record?.state_evidence_ids) ? { stateEvidenceIds: record.state_evidence_ids.map(String) } : {}
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
			case "tool/code-dispatch-start": {
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
			case "tool/code-dispatch": {
				if (!enabled) break;
				const data = asRecord(event.data);
				const isDispatch = event.type === "tool/code-dispatch";
				const message = asRecord(data?.message);
				const source = asRecord(message?.source);
				const callId = String(source?.callId ?? (isDispatch ? data?.subCallId : "") ?? "");
				const call = pendingCalls.get(callId);
				if (!call) break;
				pendingCalls.delete(callId);
				const textContent = extractTextContent((isDispatch ? data?.content : void 0) ?? message?.content ?? []);
				if (call.name === "context_guard_checkpoint") {
					const recorded = parseArguments(textContent);
					if (recorded.status !== "certified") break;
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
				const evidence = withDurability(evidenceFromPersistedToolResult({
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
				projection.evidence.set(evidence.id, evidence);
				if (evidence.externalOperationRef) projection.externalOperations.set(evidence.externalOperationRef.id, evidence.externalOperationRef);
				break;
			}
			default: break;
		}
	}
	projection.enabled = enabled;
	projection.epoch = epoch;
	return {
		projection,
		compacted,
		enablementTransitioned,
		lastCompactionSeq
	};
}

//#endregion
//#region src/domain/stop-policy.ts
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
	if (projection.currentGoalPhase === "active" && projection.currentGoalActivation === "armed") return {
		action: "stop",
		reason: "goal_round_driver_owns_continuation"
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
	await runner("git", manifest.argv.slice(1), target.repository);
	return { status: "executed" };
}

//#endregion
//#region src/domain/host-resolver.ts
const CRITICAL_NAMES = EXPECTED_HOST_PACKAGES.map((row) => row.name);
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
function packageRowsFromPnpmLock(text) {
	const rows = /* @__PURE__ */ new Map();
	const lines = text.split(/\r?\n/);
	const packagesStart = lines.findIndex((line) => line === "packages:");
	const snapshotsStart = lines.findIndex((line) => line === "snapshots:");
	if (packagesStart < 0) return [];
	const end = snapshotsStart > packagesStart ? snapshotsStart : lines.length;
	for (let index = packagesStart + 1; index < end; index += 1) {
		const match = lines[index].match(/^  '?((?:@[^/'\s]+\/)?[^@'\s]+)@([^':\s]+)'?:\s*$/);
		if (!match || !CRITICAL_NAMES.includes(match[1])) continue;
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
	return CRITICAL_NAMES.flatMap((name) => {
		const entries = rows.get(name) ?? [];
		if (entries.length === 0) return [];
		return entries;
	});
}
function resolveInstalledHostLock(moduleUrl = import.meta.url) {
	const lockPath = findUp(dirname(fileURLToPath(moduleUrl)), "pnpm-lock.yaml");
	if (!lockPath) return evaluateHostLock([]);
	try {
		return evaluateHostLock(packageRowsFromPnpmLock(readFileSync(lockPath, "utf8")));
	} catch {
		return evaluateHostLock([]);
	}
}
/**
* Resolve only package identities reachable from the active pnpm importer.
* Historical snapshots elsewhere in the lockfile are deliberately ignored;
* two reachable peer variants of a critical package remain a duplicate and
* are returned twice so evaluateHostLock can fail closed with a bounded code.
*/
function packageRowsFromActiveGraph(packageMapText, lockText, nodeModulesRoot) {
	let document;
	try {
		document = JSON.parse(packageMapText);
	} catch {
		return [];
	}
	if (!document || typeof document !== "object") return [];
	const packages = document.packages;
	if (!packages || typeof packages !== "object" || Array.isArray(packages)) return [];
	const records = packages;
	if (!records["."] || Object.keys(records).length > 2e4) return [];
	const reachable = /* @__PURE__ */ new Set();
	const queue = ["."];
	while (queue.length > 0 && reachable.size <= 2e4) {
		const id = queue.shift();
		if (reachable.has(id)) continue;
		const record = records[id];
		if (!record || typeof record !== "object") return [];
		reachable.add(id);
		if (!record.dependencies || typeof record.dependencies !== "object" || Array.isArray(record.dependencies)) continue;
		for (const target of Object.values(record.dependencies)) if (typeof target === "string" && target !== "." && !reachable.has(target)) queue.push(target);
	}
	if (queue.length > 0) return [];
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
					const modules = resolve(nodeModulesRoot);
					const manifestPath = resolve(modules, record.url, "package.json");
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
	const runtimeRows = packageRowsFromActiveGraph(readFileSync(mapPath, "utf8"), readFileSync(lockPath, "utf8"), join(runtime, "node_modules"));
	const profileRows = packageRowsFromActiveGraph(readFileSync(profileMapPath, "utf8"), readFileSync(profileLockPath, "utf8"), join(profile, "node_modules"));
	const profileManifest = readJsonObject(profileManifestPath, "profile_manifest_invalid");
	const installedPlugin = readJsonObject(pluginManifestPath, "installed_plugin_invalid");
	const dependencies = profileManifest.dependencies;
	const profileConfig = profileManifest.dsh && typeof profileManifest.dsh === "object" ? profileManifest.dsh.profile : void 0;
	const bundles = profileConfig && typeof profileConfig === "object" ? profileConfig.bundles : void 0;
	if (!dependencies || typeof dependencies !== "object" || typeof dependencies["dsh-completion-guard"] !== "string" || !Array.isArray(bundles) || !bundles.includes("dsh-completion-guard")) throw new HostProfileError("profile_plugin_unbound", "profile does not bind the dsh-completion-guard dependency and bundle");
	if (installedPlugin.name !== "dsh-completion-guard" || installedPlugin.version !== expectedPluginVersion) throw new HostProfileError("profile_plugin_version_mismatch", "installed profile plugin identity does not match the generator version");
	const profileKind = bundles.includes("@deepseek-ai/dsh-web-app") || bundles.includes("dshmarket") ? "web" : "headless";
	const platform = process.platform === "win32" ? "windows" : "posix";
	const runtimeKeys = new Set(runtimeRows.map((row) => `${row.name}\u0000${row.version ?? ""}\u0000${row.integrity ?? ""}`));
	const evaluation = evaluateHostLock([...runtimeRows, ...profileRows.filter((row) => !runtimeKeys.has(`${row.name}\u0000${row.version ?? ""}\u0000${row.integrity ?? ""}`))], {
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
function renderManagedPatch(rows, platform, profileKind, activation) {
	const lines = [
		HOST_LOCK_MARKER_BEGIN,
		"- id: context-guard",
		"  name: dsh-completion-guard",
		"  config:"
	];
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
	const starts = lines.flatMap((line, index) => /^- id:\s*["']?context-guard["']?\s*$/.test(line) ? [index] : []);
	if (starts.length > 1) throw new HostProfileError("profile_patch_duplicate_target", "multiple unmanaged context-guard patches are ambiguous");
	if (starts.length === 0) return void 0;
	const start = starts[0];
	let end = lines.length;
	for (let index = start + 1; index < lines.length; index += 1) if (lines[index].startsWith("- ")) {
		end = index;
		break;
	}
	const entry = lines.slice(start + 1, end).join("\n");
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
	const managed = renderManagedPatch(input.evaluation.packages.filter((row) => row.version && row.integrity), input.platform, input.profileKind, activation);
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
		const blockLine = entry[cursor].match(/^\s{10}(.*)$/);
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
function verifyComposedHostLockDump(text, expected) {
	const context = hostLockContextFromComposedDump(text);
	const actual = evaluateHostLock(hostLockRowsFromComposedDump(text), context);
	if (actual.status !== "supported" || actual.digest !== expected.digest) throw new HostProfileError("host_lock_readback_mismatch", "composed config host lock does not match the active graph");
	return actual;
}

//#endregion
export { classifyUserInteraction as $, extractToolSubject as A, STOP_PROTOCOL_VERSION as At, DEFAULT_HOST_LOCK as B, COMMAND_SURFACE_MANIFEST as Bt, latestAssistantText as C, canonicalRegistryBase as Ct, supersedeItem as D, CERTIFICATE_VERSION as Dt, deriveProjection as E, ACTION_MANIFEST_VERSION as Et, parsePwshCommand as F, requestedTargetMatchesResolved as Ft, bindExecutableIdentity as G, sanitizeClauseText as Gt, GOAL_HOST_PACKAGES as H, canonicalizePath as Ht, parseShellCommand as I, semanticActionFromCommand as It, evaluateHostCapability as J, createProjection as Jt, bindLiveGoalCapability as K, sanitizeUrl as Kt, goalCompletionDenial as L, semanticActionFromText as Lt, withDurability as M, actionCompatible as Mt, canonicalArgvFromCommand as N, isStatefulAction as Nt, evidenceFromPersistedToolResult as O, SEMANTIC_ACTIONS as Ot, isRunExecutable as P, requestedTargetAuthorizesMutation as Pt, segmentAuthorityBlocks as Q, hasCurrentCertificate as R, validateActionManifest as Rt, isWholeTaskCompletionClaim as S, segmentClauses as St, PROTOCOL_V3_NOTICE as T, ACTION_MANIFEST as Tt, HOST_CAPABILITY_PACKAGE_GROUPS as U, digestStrings as Ut, EXPECTED_HOST_PACKAGES as V, validateManifest as Vt, SUPPORTED_HOST_MANIFEST as W, normalizeClause as Wt, evaluateToolSurfaceCapability as X, evaluateHostLock as Y, authorityCaptureCounts as Z, revalidateGitPrestate as _, classifyClause as _t, packageRowsFromActiveGraph as a, DEFAULT_RECOVERY_CHAR_BUDGET as at, decideTurnBoundary as b, extractOperation as bt, resolveInstalledHostLock as c, recoveryDigest as ct, commitIndexSnapshotDigest as d, evidenceCoverage as dt, availableBoundaryQualifications as et, commitTreeSnapshotDigest as f, evidenceMatchesItem as ft, parseGitCommandManifest as g, captureItem as gt, gitCommandMatchesTarget as h, captureClause as ht, injectActiveProfileHostLock as i, certifyCheckpoint as it, isDeterministicCheck as j, SUPPORTED_EVIDENCE_ADAPTERS as jt, extractTextContent as k, STATEFUL_ACTIONS as kt, verifyComposedHostLockDump as l, renderRecoveryPacket as lt, executeRevalidatedGitEffect as m, currentContractDigest as mt, hostLockContextFromComposedDump as n, isCurrentAcceptedBoundary as nt, packageRowsFromPnpmLock as o, closingHint as ot, createGitPrestateEnvelope as p, isVerifyingCapability as pt, evaluateExternalWaitCapability as q, sha256 as qt, hostLockRowsFromComposedDump as r, qualifyBoundary as rt, resolveActiveProfileHostLock as s, openItems$1 as st, HostProfileError as t, effectuateBoundary as tt, GIT_COMMAND_MANIFEST_IDS as u, bindingSatisfies as ut, verifiedLinearCommitReadback as v, extractArtifactPaths as vt, observeAssistantOutcome as w, npmEscapedPackageName as wt, decideTurnStopping as x, isInformationalMessage as xt, classifyCompletionClaim as y, extractMethod as yt, BASE_HOST_PACKAGES as z, validateActionTarget as zt };