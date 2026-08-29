import { createHash } from "node:crypto";
import * as path from "node:path";

//#region src/domain/types.ts
function createProjection() {
	return {
		enabled: false,
		epoch: 0,
		contractRevision: 0,
		items: /* @__PURE__ */ new Map(),
		evidence: /* @__PURE__ */ new Map(),
		checkpoints: [],
		lastObservedSourceSeq: -1,
		lastGuardEventSeq: -1,
		continuationAttempts: /* @__PURE__ */ new Map(),
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
	return {
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
			operation
		}
	};
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
	if (operation === "run") parts.push("needs a scope run effect: a whitelisted executable (git/pnpm/python/dsh/...) without pipes, `;` or `&&`, e.g. `python -m unittest`");
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
	if (!pushItems(items.filter((item) => item.kind === "requirement"), (item) => `[${item.id}] ${item.normalizedText}`)) return finalize();
	if (!pushItems(items.filter((item) => item.kind === "prohibition"), (item) => `[${item.id}] DO NOT ${item.normalizedText}`)) return finalize();
	if (!pushItems(items.filter((item) => item.kind === "acceptance"), (item) => `[${item.id}] VERIFY ${item.normalizedText}`)) return finalize();
	const citableEvidence = [...projection.evidence.values()].filter((evidence) => evidence.epoch === projection.epoch && evidence.outcome === "success").sort((a, b) => a.id < b.id ? -1 : 1);
	let evidenceCount = 0;
	for (const evidence of citableEvidence) {
		if (evidenceCount >= MAX_RECOVERY_EVIDENCE) {
			push(MORE_EVIDENCE_RULE(citableEvidence.length - evidenceCount));
			break;
		}
		if (!push(`evidence ${evidence.id} ${evidence.toolName} ${evidence.subjects.join(",") || "-"} ${evidence.surfaces.join(",")}`)) return finalize();
		evidenceCount += 1;
	}
	for (const item of [...projection.items.values()].filter((item$1) => item$1.status === "superseded")) if (item.supersededBy && !push(`[${item.id} -> ${item.supersededBy}]`)) return finalize();
	for (const binding of options.rejectedBindings ?? []) if (!push(`rejected ${binding.itemId}: ${binding.reason}`)) return finalize();
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
function certifyCheckpoint(projection, bindings, id) {
	if (projection.integrity !== "valid") return {
		status: "unknown",
		contractRevision: projection.contractRevision,
		openItems: openItems(projection),
		rejectedBindings: []
	};
	const rejectedBindings = [];
	for (const binding of bindings) {
		const item = projection.items.get(binding.itemId);
		if (!item || item.status === "superseded") {
			rejectedBindings.push({
				itemId: binding.itemId,
				reason: "item is missing or superseded"
			});
			continue;
		}
		if (!binding.evidenceIds.length) {
			rejectedBindings.push({
				itemId: binding.itemId,
				reason: "no evidence cited",
				hint: closingHint(projection, item)
			});
			continue;
		}
		if (!bindingSatisfies(projection, item, binding.evidenceIds)) {
			rejectedBindings.push({
				itemId: binding.itemId,
				reason: "evidence does not match the current verification contract",
				hint: closingHint(projection, item, binding.evidenceIds)
			});
			continue;
		}
	}
	const open = openItems(projection).filter((itemId) => !bindings.some((binding) => binding.itemId === itemId));
	if (rejectedBindings.length || open.length) return {
		status: "incomplete",
		contractRevision: projection.contractRevision,
		openItems: openItems(projection),
		rejectedBindings
	};
	const openDigest = digestStrings(openItems(projection));
	const bindingDigest = sha256(JSON.stringify(bindings));
	const checkpoint = {
		id,
		epoch: projection.epoch,
		contractRevision: projection.contractRevision,
		openDigest,
		bindingDigest,
		bindings,
		result: "certified"
	};
	projection.checkpoints.push(checkpoint);
	for (const binding of bindings) projection.items.get(binding.itemId).status = "passed";
	return {
		status: "certified",
		contractRevision: projection.contractRevision,
		openItems: [],
		rejectedBindings: [],
		checkpoint
	};
}
function openItems(projection) {
	return [...projection.items.values()].filter((item) => item.status === "pending" && item.kind !== "prohibition").map((item) => item.id);
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
	for (const block of content) {
		const record = asRecord$1(block);
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
function unique(values) {
	return [...new Set(values)];
}
/** Resolve relative artifact subjects against the session scope cwd. */
function resolveSubjectPaths(values, cwd) {
	return cwd ? values.map((value) => resolveCommandPath(value, cwd)) : values;
}
function extractToolSubject(call, result, defaultCwd) {
	const args = parseArguments$1(call.arguments);
	switch (call.name) {
		case "read":
		case "read_file": {
			const subjects = unique(resolveSubjectPaths([...metaPaths(result.meta), ...argsPaths(args)], defaultCwd));
			return {
				capabilities: ["filesystem-read"],
				subjects,
				surfaces: ["artifact"],
				operations: subjects.map((path$1) => ({
					op: "read",
					path: path$1
				}))
			};
		}
		case "write":
		case "write_file": {
			const subjects = unique(resolveSubjectPaths([...metaPaths(result.meta), ...argsPaths(args)], defaultCwd));
			return {
				capabilities: ["filesystem-write"],
				subjects,
				surfaces: ["artifact"],
				operations: subjects.map((path$1) => ({
					op: "create",
					path: path$1
				}))
			};
		}
		case "edit":
		case "edit_file": {
			const subjects = unique(resolveSubjectPaths([...metaPaths(result.meta), ...argsPaths(args)], defaultCwd));
			return {
				capabilities: ["filesystem-edit"],
				subjects,
				surfaces: ["artifact"],
				operations: subjects.map((path$1) => ({
					op: "modify",
					path: path$1
				}))
			};
		}
		case "bash":
		case "shell":
		case "pwsh": {
			const command = typeof args.command === "string" ? args.command : "";
			const terminal = structuredTerminalFacts(result.meta) ?? extractTerminalFacts(result.textContent);
			const backgrounded = args.run_in_background === true;
			const commandDetails = analyzeCommand(command, typeof args.workdir === "string" ? args.workdir : defaultCwd, call.name);
			const deterministic = commandDetails.status === "supported" && !backgrounded && isDeterministicCheck(command);
			const outcome = backgrounded ? "unknown" : result.error || terminal.negative ? "failure" : terminal.exitCode === void 0 ? call.name === "bash" || call.name === "pwsh" ? "success" : "unknown" : terminal.exitCode === 0 ? "success" : "failure";
			return {
				capabilities: ["shell", ...deterministic ? ["deterministic-check"] : []],
				subjects: unique(commandDetails.subjects),
				surfaces: ["scope"],
				outcome,
				executables: commandDetails.executables,
				operations: commandDetails.operations
			};
		}
		case "web_search":
		case "web_fetch":
		case "web_fetch_url": return {
			capabilities: ["web-fetch"],
			subjects: unique([...metaUrls(result.meta), ...typeof args.url === "string" ? [sanitizeUrl(args.url)] : []]),
			surfaces: ["ui"]
		};
		default: return {
			capabilities: ["generic"],
			subjects: [],
			surfaces: []
		};
	}
}
function evidenceFromPersistedToolResult(call, result, epoch, evidenceId, defaultCwd) {
	const subject = extractToolSubject(call, result, defaultCwd);
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
		...subject.operations?.length ? { operations: subject.operations } : {}
	};
}
function withDurability(evidence, confirmed) {
	if (confirmed) return evidence;
	return {
		...evidence,
		outcome: "unknown"
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
function insertItems(projection, text, sourceMessageId, scope) {
	for (const segment of segmentClauses(text)) {
		if (classifyUserInteraction(segment.body) === "conversational") continue;
		if (segment.kind === "requirement" && segment.paths.length === 0 && isInstructionFraming(segment.body)) continue;
		if (segment.kind === "prohibition" || segment.paths.length === 0) {
			insert(projection, segment.kind, segment.body, sourceMessageId, scope.cwd || "scope", "scope");
			continue;
		}
		for (const path$1 of segment.paths) insert(projection, segment.kind, segment.body, sourceMessageId, resolveArtifact(path$1, scope), "artifact");
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
function deriveProjection(sourceEvents, config, scope, durableConfirmed) {
	const projection = createProjection();
	let enabled = config.activation === "always";
	let epoch = 0;
	let evidenceCounter = 0;
	let compacted = false;
	let enablementTransitioned = false;
	let lastCompactionSeq = -1;
	const pendingCalls = /* @__PURE__ */ new Map();
	for (const event of sourceEvents) {
		projection.lastObservedSourceSeq = Math.max(projection.lastObservedSourceSeq, event.seq);
		switch (event.type) {
			case "command/run": {
				const data = asRecord(event.data);
				if (data?.name !== "context-guard") break;
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
				if (!enabled) break;
				const data = asRecord(event.data);
				if (asRecord(data?.source)?.kind !== "user") break;
				const text = extractTextContent(data?.content ?? []);
				if (!text.trim()) break;
				if (isInformationalMessage(text)) break;
				if (classifyUserInteraction(text) === "conversational") break;
				insertItems(projection, text, `m${event.seq}`, scope);
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
						return {
							itemId: String(record?.item_id ?? ""),
							evidenceIds: Array.isArray(record?.evidence_ids) ? record.evidence_ids.map(String) : []
						};
					}) : [];
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
					if (parseArguments(textContent).status !== "certified") break;
					if (certifyCheckpoint(projection, call.bindings ?? [], `C${projection.checkpoints.length + 1}`).status !== "certified") projection.integrity = "corrupt";
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
				}, epoch, `E${String(evidenceCounter).padStart(4, "0")}`, scope.cwd || void 0), durableConfirmed);
				projection.evidence.set(evidence.id, evidence);
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
//#region src/domain/goal-gate.ts
function hasCurrentCertificate(projection) {
	const checkpoint = projection.checkpoints.at(-1);
	return projection.integrity === "valid" && checkpoint?.result === "certified" && checkpoint.epoch === projection.epoch && checkpoint.contractRevision === projection.contractRevision;
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
	if (hasCurrentCertificate(projection)) return void 0;
	return projection.integrity === "valid" ? "Context Guard requires a current completion certificate before Goal completion." : "Context Guard integrity is unknown or corrupt; Goal completion is denied.";
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
function decideTurnStopping(projection, assistantText, turn, maxAttempts) {
	if (!projection.enabled) return { action: "stop" };
	if (!isWholeTaskCompletionClaim(assistantText)) return { action: "stop" };
	if (hasCurrentCertificate(projection)) return { action: "stop" };
	const attempts = projection.continuationAttempts.get(turn) ?? 0;
	if (attempts >= maxAttempts) return {
		action: "stop",
		reason: "continuation attempt limit reached"
	};
	projection.continuationAttempts.set(turn, attempts + 1);
	return {
		action: "continue",
		reason: "whole-task completion claimed without a current certificate"
	};
}
function latestAssistantText(events) {
	for (let index = events.length - 1; index >= 0; index--) {
		const event = events[index];
		if (event.type !== "assistant/message") continue;
		const text = event.data.message?.content?.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n") ?? "";
		if (text.trim()) return text;
	}
	return "";
}

//#endregion
export { classifyClause as A, normalizeClause as B, renderRecoveryPacket as C, isVerifyingCapability as D, evidenceMatchesItem as E, segmentClauses as F, sanitizeUrl as H, COMMAND_SURFACE_MANIFEST as I, validateManifest as L, extractMethod as M, extractOperation as N, captureClause as O, isInformationalMessage as P, canonicalizePath as R, recoveryDigest as S, evidenceCoverage as T, sha256 as U, sanitizeClauseText as V, createProjection as W, classifyUserInteraction as _, goalCompletionDenial as a, closingHint as b, supersedeItem as c, extractToolSubject as d, isDeterministicCheck as f, parseShellCommand as g, parsePwshCommand as h, latestAssistantText as i, extractArtifactPaths as j, captureItem as k, evidenceFromPersistedToolResult as l, isRunExecutable as m, decideTurnStopping as n, hasCurrentCertificate as o, withDurability as p, isWholeTaskCompletionClaim as r, deriveProjection as s, classifyCompletionClaim as t, extractTextContent as u, certifyCheckpoint as v, bindingSatisfies as w, openItems$1 as x, DEFAULT_RECOVERY_CHAR_BUDGET as y, digestStrings as z };