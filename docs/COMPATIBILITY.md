# Compatibility

Compatibility is pinned to exact host package sets. A nearby version or a partial package match is not treated as supported.

## Current 0.4.0 release baseline

- Plugin: `dsh-completion-guard` `0.4.0`
- DeepSeek Harness: `0.1.2-alpha.3`
- dshmarket: `1.39.0`
- Cordis: `4.0.2`
- Node: `>= 22`
- pnpm: `>= 11`

DSH is still a developer preview and may make breaking changes. Version 0.4.0 therefore makes no floating alpha compatibility claim.

## 0.4.1-rc.1 prerelease candidate

- Plugin: `dsh-completion-guard` `0.4.1-rc.1` prerelease candidate
- DeepSeek Harness: `0.1.2-rc.1`
- dshmarket: `1.41.0`
- Cordis: `4.0.2`
- Audited platforms: native macOS/posix runtime, plus the native Windows rc.1 host graph verified on the live Windows host (host-lock inspect/inject, composed-config verify-dump, cold Web boot)
- Evidence boundary: host-graph audits are source/runtime-level evidence and do not replace the cross-platform exact-artifact acceptance of one frozen package; unregistered host cohorts keep failing closed

DSH rc.1 replaces the public `Session.events` getter with `snapshotEvents()` and `eventAt()`. The candidate uses `snapshotEvents()` when present and retains `events` only for older registered cohorts. The underlying Guard-consumed event vocabulary, flush path, Goal disarm, and `update_goal` contract remain unchanged by the focused upstream source audit.

## Upstream adaptation policy

Version 0.4.0 remains frozen on the alpha.3 setup above. Alpha.4 and later alpha releases are not new adaptation targets. Compatibility work resumes with the first DeepSeek Harness RC published after alpha.3; follow the upstream [tags page](https://github.com/deepseek-ai/deepseek-harness/tags) for that milestone.

## Platform and release evidence

- **Source and CI:** the release commit must pass the repository matrix and the Ubuntu, macOS, and Windows Node.js 22/24 CI jobs.
- **Exact package:** the repository packer emits one deterministic 26-file tgz with its full source commit in `gitHead`. That same SHA-256 must be used on both native platforms and published to npm without repacking.
- **Native scope:** macOS and Windows acceptance separately cover isolated Web and Headless installation, complete host-lock readback, repeated injection, Web restart and recovery, intentional Headless credential failure, daily-profile preservation, and scoped cleanup.
- **Public identity:** the annotated tag, npm manifest and downloaded tgz, GitHub Release target, checksum, and platform annexes must all resolve to the same release commit and package bytes.
- **Daily profiles:** upgrading a user's daily DSH profile is a separate action and is not implied by release acceptance.

## Historical compatibility cohorts

- DSH `0.1.1-rc.2` + dshmarket `1.36.0` + Cordis `4.0.1` is a retained, published-line cohort.
- DSH `0.1.2-alpha.2` + dshmarket `1.38.1` + Cordis `4.0.2` is the published 0.3.2 cohort checked natively on macOS and Windows.
- DSH `0.1.2-alpha.2` + dshmarket `1.39.0` + Cordis `4.0.2` remains a deterministic compatibility cohort. It is no longer a native 0.4.0 release blocker.

## Rejection rules

The five exact host sets are recorded in [`../manifests/supported-host.v1.json`](../manifests/supported-host.v1.json). Each set is a complete list of required packages and versions. Every row must match one set.

Missing, mixed, duplicate, unidentified, unknown, or integrity-drifted rows leave the Guard unavailable. Unregistered substitutions such as alpha.3 with dshmarket `1.38.1` are rejected as mixed graphs. dshmarket is an authoritative lock input; skin-center is not.

The selected set is part of the host-lock digest. Changing sets invalidates earlier certificates, and a platform is marked supported only after its complete set passes native checks there.

## Evidence links

- Candidate and historical-artifact evidence: [`LOCAL_ACCEPTANCE.md`](LOCAL_ACCEPTANCE.md)
- Shared Codex/DSH semantic scope: [`SEMANTIC_COMPATIBILITY.md`](SEMANTIC_COMPATIBILITY.md)
- Exact host identities: [`../manifests/supported-host.v1.json`](../manifests/supported-host.v1.json)

## Loader contract

The package exposes a named `apply(ctx)` function and a named `inject` array (`['sessions', 'commands']`) with no default export. Its `dsh.bundle.patch` points at `cordis.patch.yml`, which inserts the `context-guard` bundle row.

The plugin accepts an `activation` configuration value of `opt-in` or `always`. The default is `opt-in`; `always` initializes the projection as enabled before the persisted session log is replayed. Invalid values fail during plugin configuration instead of silently falling back. A DSH profile can select `always` with an ID-targeted `config` override in its `cordis.patch.yml`; see the README quick start for the complete example and the replay implications for existing sessions.

### Host-lock setup

Before the Guard can certify work, generate and verify the host lock from the active DSH runtime and profile. Use the packaged `dsh-completion-guard-host-lock inspect|inject|verify-dump` flow in the README. The default patch has no `hostLockPackages`, so the Guard fails closed until this flow succeeds.

Version 0.3 accepts the generated `hostLockPackages`, `hostLockPlatform`, and `hostLockProfile` values. Each critical package row records the exact resolved version and registry tarball integrity. The Guard does not infer a missing identity from a nearby lockfile: missing, duplicate, multi-version, or drifted rows fail closed. The audited identities are defined in [`../manifests/supported-host.v1.json`](../manifests/supported-host.v1.json).

### Capability groups

The host lock evaluates these groups independently:

- base and Goal;
- agent loop;
- POSIX or Windows terminal;
- filesystem tools;
- DSH CLI;
- plugin inventory;
- Web control; and
- jobs.

A missing platform- or action-specific group disables only the path that depends on it. For example, a valid terminal or jobs group remains usable when the filesystem group is unavailable.

The filesystem group has a narrower contract of its own. It freezes the registered `read`, `write`, and `edit` tools; their closed result and presentation shapes; the local or sandbox `ctx.fs` implementation; the read-before-mutation observation policy; the sandbox policy; and the approval provider. A missing or drifted filesystem row disables `create`, `modify`, and ordinary filesystem facts without disabling unrelated capability groups.

## Peer dependencies

The ordinary runtime packages are host-provided peers:

- `@deepseek-ai/cordis`;
- `@deepseek-ai/dsh-agent`;
- `@deepseek-ai/dsh-commands`;
- `@deepseek-ai/dsh-llm`;
- `@deepseek-ai/dsh-session`; and
- `@deepseek-ai/dsh-tools`.

Goal support uses two exact optional peers as one capability. `@deepseek-ai/dsh-goal` owns Goal state, while `@deepseek-ai/dsh-tool-goal` owns the audited `update_goal` name, schema, and arguments. Both host-graph rows and the live Goal service and tool must agree. A profile without this complete pair can still load, but Goal-dependent integration stays inactive.

Peer ranges accept only the registered DSH version lines: `0.1.1-rc.2 || 0.1.2-alpha.2 || 0.1.2-alpha.3 || 0.1.2-rc.1`, with Cordis `4.0.1 || 4.0.2`. These are not floating support claims. Runtime acceptance still requires an exact injected host lock and atomic selection of one complete cohort.

## Terminal outcome contract

The pinned DSH `bash` and `pwsh` renderers append terminal markers for sandbox
denial, timeout, signal termination, and non-zero exit. A completed foreground
result with none of those markers is the renderer's representation of a clean
exit; it does not append `[exit code: 0]`. Version 0.1.1 therefore accepts an
unmarked completed foreground `bash` result as successful evidence, matching the
existing `pwsh` behavior.

This does not make arbitrary shell text authoritative. A result-level error or
negative terminal marker wins over output text; background commands remain
unknown; and the generic `shell` alias remains unknown without an explicit exit
marker because no pinned host renderer contract has been verified for it.
Outcome classification also remains separate from command certification:
unsupported or malformed syntax produces no executable or operation facts and
no certifying subject/capability combination, so it cannot close a contract even
when the host execution itself succeeded.

Replay also binds the ordinary tool name to the active host surface: `bash`
requires the exact POSIX terminal group and `pwsh` the exact Windows group.
The opposite-platform name is `adapter_unavailable`, not a portable alias.
Likewise, ordinary `read`, `write`, and `edit` results require the exact
filesystem capability group. Base-lock support alone is insufficient; the
bounded fact retains an explicit host-capability reason code, carries no
certifying capability, and has unknown outcome.

## Verified surfaces

### Current visible behavior

- `dsh --profile web --dump-config` and `--profile headless --dump-config` both include `context-guard`.
- A real Headless boot loads the plugin: `apply`, `ctx.sessions` access, and listener registration succeed before the run reaches the intentional missing-provider-credentials boundary.
- The slash command appears in the Web command directory. Its `on`, `off`, `clear`, `status`, and `diagnose` subcommands produce the expected `command/run` and `command/done` events.

`inspect` reports whether the active package graph matches a supported cohort, so it can correctly return `supported` before injection. Pre-injection failure is established by reading the composed configuration and by `verify-dump`, which rejects missing or mismatched injected host-lock data.

Evidence and certificates are session-scoped. A later DSH session cannot import or certify evidence IDs from an earlier session. Any workflow that needs a certificate must therefore produce its evidence and checkpoint in the same session.

### Historical 0.3.x evidence

- **0.3.0 runtime baseline:** 20 files exercise 360 deterministic tests, including all 37 mirrored portable semantic cases and all 29 digest vectors. macOS passed 359 tests with one Windows-only shim test capability-skipped; native Windows passed all 352 tests in the earlier 19-file baseline with no skips.
- **0.3.0 native and CI evidence:** the same canonical pre-release tgz passed isolated Web and Headless installation, host-lock inspect/inject/dump/verify, real dshmarket restart readback, HTTP recovery, and cleanup on native macOS and Windows. Headless reached the intentional missing-credential boundary. CI covered Ubuntu, macOS, and Windows on Node.js 22 and 24.
- **0.3.0 model-session evidence:** a credentialed session verified one accepted evidence binding and persisted typed-boundary/disarm path. A deliberately over-broad prompt remained incomplete and received no false certificate.
- **0.3.1 provenance repair:** 0.3.1 preserves the 0.3.0 runtime bytes and repairs only the frozen-package provenance path after the 0.3.0 registry entry omitted `gitHead`. Its final tgz is separately bound to native-platform and public-registry readback.
- **0.3.2 completed release:** the frozen package from commit `22cde610` passed the same-byte isolated lifecycle on native macOS and Windows. Its tag, npm publication, GitHub Release, and public downloads resolve to the same commit and bytes.

Exact commands, artifact identities, and platform limits for these releases are recorded in [`LOCAL_ACCEPTANCE.md`](LOCAL_ACCEPTANCE.md). The published 0.1.x and 0.2.x lines retain their own historical evidence there. The fail-closed invariants below remain covered as regressions.

## Session-layer capture filter and goal completion (v0.2.1)

Not every direct user message becomes a contract item. Informational reports
(receipts, pasted summaries) were already excluded; v0.2.1 additionally drops
session-layer utterances: bare progression/acknowledgement phrases (`继续`,
`好的`, `continue`), meta questions (`这个收尾具体要做什么`, `是不是bug`),
and meta comments or objections without a task feature. The filter also runs
per clause, so a conversational opener inside an otherwise actionable message
(`好的。请修改 src/a.ts`) no longer adds a phantom scope requirement. The
classifier fails closed: an artifact path, an explicit method, or a
non-negated operation verb always keeps the message captured, and uncertain
phrasing stays a captured requirement. Old sessions replay unchanged — a
contract already polluted by such messages remains historical state and is
remediated explicitly (below), not by re-derivation.

`update_goal(action=complete)` stays denied while the guard is enabled without
a current completion certificate. The remediation routes are explicit:
`/context-guard off` disables gating (use only after the user confirms the
work is actually done), `/context-guard clear` supersedes pending
requirements/acceptances under a `CLEAR:<revision>` sentinel (prohibitions are
retained) so an empty-binding checkpoint can certify while the guard stays
enabled, and `update_goal(action=blocked)` records the blocker truthfully.
Recovery packet injection is content-deduplicated: an unchanged packet is
injected once per re-arm, while resume, compaction, an enablement transition,
new evidence, or a new contract revision always re-remind.

## v0.3 semantic action and binding contract

[`../manifests/action-manifest.v1.json`](../manifests/action-manifest.v1.json) freezes the action vocabulary, compatibility matrix, required target/state keys, expected-transition predicates, and accepted structured evidence adapter versions. `generic_run` is not a wildcard and cannot certify another semantic action.

The full `STATEFUL_ACTIONS` set is `install | apply | create | modify | restart | commit | push | publish | pull | fetch`. Each requires distinct resolution/effect/state evidence IDs, exact same-target closure, independent state readback, and a versioned expected-transition payload. An effect-only success is incomplete. Old v0.2 scope-run certificates are retained as `legacy_generic_run` audit facts and do not become current v0.3 authority; unprovable legacy authority is also non-certifiable.

### Read-only resolution and explicit mutation

`context_guard_evidence` is read-only. It resolves the current target, checks a persisted effect, and reads the resulting state. `context_guard_action` is the explicitly mutating surface for exact-tgz install, apply, and publish; two-phase dshmarket restart; and exact Git commit, push, pull, and fetch.

The normal flow is: resolve the current target, match that resolution to one authorized pending requirement, perform the exact action, and independently read the state back. A successful effect without matching state evidence remains incomplete.

### Authorization and early rejection

Before mutation, `context_guard_action` flushes and replays the resolution and contract chain. It then requires the exact target digest plus the id and revision of one current pending `root_instruction` or `root_adoption` requirement. The requirement's action and complete requested identity must match the resolution.

A matching pending root prohibition denies the mutation regardless of message order. Prohibitions and acceptance clauses never grant authority.

The action is rejected before executable inspection, command execution, HTTP, or intent persistence when the requirement is disabled, integrity-unknown, stale-host, missing, already passed, superseded, clarification-required, incomplete-target, action-swapped, target-swapped, or an unrebound legacy item. Unknown selector, command-manifest, or Git argument keys are also rejected.

### Package operations

- `install` requires the exact package id, version, and profile, and the package must be absent.
- `apply` requires the exact package id, version, and profile, plus an existing package with a changed version or integrity.
- `publish` requires the exact artifact id, version, and canonical registry. Version 0.3 does not authorize `latest` or a version range.

Publish executes the exact resolved tgz with `--ignore-scripts`. Capture, argv, and standard packument readback use the same canonical HTTPS registry base. Registries containing credentials, a query, fragment, encoded separator, control character, or ambiguous path segment are rejected.

The resolution and effect bind the same canonical executable realpath and version.

### Git operations

Push, pull, and fetch require the exact repository, remote, and canonical explicit full ref or refspec. Git aliases, implicit refs, deletion refs, wildcards, force refs, target substitution, and prestate drift are rejected.

Commit certification additionally rejects root commits, merge commits, and substituted parents. Fetch certification requires its resolved pre-HEAD, post-HEAD readback, and predicate parameter to be equal.

### File creation and modification

Create and modify bind to the frozen target and expected transition described below. For modify, the Guard re-hashes the source bytes against the frozen pre-digest before deriving the unique UTF-8 replacement post-digest.

### Restart

Restart requires the exact service id. It persists an intent before POST and closes only after the restored process reports a changed boot ID.

### Windows command shims

Windows `.cmd` and `.bat` actions also bind the canonical `SystemRoot\\System32\\cmd.exe` realpath and version. Arguments containing shell control, expansion, quotes, NUL, or newline characters are unsupported. Execution never performs a second `PATH` search or trusts a changed `ComSpec`.

### Concurrency limit

Pre-execute revalidation is a correctness check, not isolation from another process running as the same user. Any divergent post-action readback is not certified.

### Expected transitions and readback

Every stateful resolution freezes its expected transition before the effect and binds a stable digest of that payload. Checkpoint diagnostics copy the immutable payload from the resolution fact. Callers cannot construct create or modify predicates from post-effect state.

- **Create:** hash the exact UTF-8 content from the closed write manifest.
- **Modify:** read the original bytes, require valid UTF-8 and exactly one `old_string` match, apply the pinned single replacement in memory, and hash the resulting bytes.
- **Restart:** freeze `health=healthy` as a manifest constant.

After the action, independent state readback must match the frozen transition. A successful effect with different state remains incomplete.

## Legacy v0.2 command parsing subset

Context Guard v0.2 is **not** a general Bash or PowerShell static analyzer. Only
the small, auditable grammar below can produce `executable`, `operation` and
`subject`; any other command parses as `unsupported` (unterminated quotes parse
as `malformed`) with EMPTY executables and operations, so unrecognized syntax
can never certify an operation. False negatives are preferred over false
positives: an uncertain command keeps its item incomplete.

The enumerations that define this surface (tools, executables, clause verbs)
are declared once in `src/domain/manifest.ts`; the parsers and the contract
capture read from that single data source, which test-time validation keeps
non-empty and duplicate-free with the documented verb priority order. The
manifest ships with the package and is not runtime-writable: widening the
surface lowers the evidence bar, so it changes only through a release.

### Supported POSIX shell (single foreground simple command)

- `printf … > literal-path`
- `echo … > literal-path`
- `touch literal-path`
- read-only inspection tools (`cat`, `grep`, `rg`, `head`, `tail`, `wc`,
  `sed` without in-place flags): every pathish argument counts as a read effect
  (v0.2)
- one whitelisted executable run directly, e.g. `node script.js`,
  `python tool.py`, `pnpm test`, `git pull`,
  `dsh plugin --profile web add dsh-dream-skin@0.3.1`
- a leading simple environment-assignment prefix, e.g. `CI=1 pnpm test`
  (wrappers such as `env`, `nohup`, `time`, `command` are not supported)
- diagnostic stream duplication (`2>&1`, `1>&2`, `N>&M`) in any position
  (v0.2); it is a pure fd copy with no filesystem effect

Literal paths only: no variables, globs, `~` expansion or command substitution.

### Unsupported → fail-closed (whole command, no partial results)

- unquoted LF/CRLF command boundaries, `;`, `&&`, `||`, pipelines (`|`), background (`&`), parentheses/subshells
- `$(…)`, backtick command substitution, heredoc/here-string (`<<`, `<<<`)
- unterminated quotes, dynamic `eval`/`source`/`.`-sourcing
- non-literal (variable/glob) redirect targets or arguments
- `>>`, `<`, file-target fd redirects (`2>`, `2>>`) and all other redirections
  beyond a single `>` or an `N>&M` stream copy
- in-place `sed -i`/`sed --in-place` editing
- executables outside the v0.2 whitelist

### Supported PowerShell (single directly invoked command)

- the v0.1 cmdlet set: `Set-Content`, `Add-Content`, `New-Item`, `Out-File`,
  `Get-Content` with the exact documented parameters
- v0.2: a whitelisted external executable (`git`, `pnpm`, `npm`, `node`,
  `python`, `tsc`, `vitest`, `pytest`, … – the same run-executable set as the
  POSIX side) invoked directly with all-literal arguments, e.g.
  `git push origin main`, `pnpm add pkg@1.0.0`; its run effect carries the
  first pathish argument
- v0.2: unquoted `N>&M` stream duplication is stripped everywhere (a quoted
  `"2>&1"` remains an ordinary value)

Requirements: the command must be unquoted at the command position; the path
must come from the explicit named path parameter (cmdlets) or be a literal
argument (external executables); a quoted path is one token (spaces allowed);
permitted value parameters (`-Value`, `-Encoding`, and `-ItemType`
where listed above) never contribute subjects;
`-WhatIf` and `-Confirm` are unsupported because they can avoid or defer the
claimed effect; positional paths, variables, expressions, `Join-Path`,
subexpressions, pipelines, `;`, script blocks, `&`, dot sourcing, `Copy-Item`,
`Move-Item`, `Rename-Item` and `.NET WriteAllText` are unsupported and fail the
WHOLE command.

### Subject resolution (v0.2)

Evidence artifact subjects are resolved against the call's `workdir`; when the
shell tool carries none (the macOS persistent bash/pwsh tools expose only
`command`), the session scope cwd is used as the default, so relative paths and
scope-run attribution match the contract subject derived from the same cwd. A
pathless `run` operation of a whitelisted executable is attributed to that cwd,
which is what closes a scope `run` contract; builtins (`echo`, `cat`, …) never
become a subject-carrying run.

### Binding invariants

- `run`: the successful method evidence (method + operation + subject) alone
  closes the contract; no extra read or unrelated deterministic-check is needed.
- `create`/`write`/`modify`: require one successful effect evidence matching
  operation and subject, plus an independent successful state-verification
  evidence on the same subject. When an explicit method is present, that method
  identity must be carried by the effect evidence itself; without an explicit
  method, any compatible effect evidence may satisfy the effect facet.
- `read`: a successful read evidence matching method, read operation and
  subject satisfies the method side and the object side at once.
- `verify`: one evidence must simultaneously provide success, an explicit
  read/verify/deterministic-check capability, the canonical subject and surface,
  and any required method identity; separate method and verification evidence
  cannot be spliced together.
- an explicit method whose operation cannot be parsed fails closed.
- prohibitions keep their existing semantics.
