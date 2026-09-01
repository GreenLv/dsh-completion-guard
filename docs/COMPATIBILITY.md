# Compatibility

The current development target is pinned, not a floating claim.

## Target

- DeepSeek Harness: `0.1.1-rc.2` with dshmarket `1.36.0`, `0.1.2-alpha.2` with dshmarket `1.38.1`, `0.1.2-alpha.2` with dshmarket `1.39.0` (the upgraded-Windows combination, registered as its own audited cohort), or `0.1.2-alpha.3` with dshmarket `1.39.0` (rc.2 and alpha.2+1.38.1 checked natively on macOS and Windows; the alpha.2+1.39.0 and alpha.3 graphs are rebuilt from the audited 2026-09-01 annex and their native acceptance is pending)
- Cordis: `4.0.1` (rc.2 cohort) / `4.0.2` (alpha.2, alpha.2+dshmarket-1.39.0, and alpha.3 cohorts)
- Node: `>= 22`
- pnpm: `>= 11`

DSH is still a developer preview and may make breaking changes. Compatibility is therefore limited to the four audited host sets in [`../manifests/supported-host.v1.json`](../manifests/supported-host.v1.json). A host set is the complete list of required packages and their exact versions. Every row must match one set; missing, mixed, duplicate, unidentified, or unknown packages leave the Guard unavailable. dshmarket is an authoritative input of each audited set: the alpha.2 runtime with dshmarket 1.39.0 is supported through its own registered cohort, while substitutions matching no registered cohort — alpha.3 rows with dshmarket 1.38.1, rc.2 rows with dshmarket 1.38.1, alpha.2 rows with dshmarket 1.36.0 — fail closed as mixed graphs, and skin-center is not a Guard lock input. The selected set is part of the host-lock digest, so changing sets invalidates earlier certificates. Platform support is registered only after the complete set is checked natively on that platform.

## Loader contract

The package exposes a named `apply(ctx)` function and a named `inject` array (`['sessions', 'commands']`) with no default export. Its `dsh.bundle.patch` points at `cordis.patch.yml`, which inserts the `context-guard` bundle row.

The plugin accepts an `activation` configuration value of `opt-in` or `always`. The default is `opt-in`; `always` initializes the projection as enabled before the persisted session log is replayed. Invalid values fail during plugin configuration instead of silently falling back. A DSH profile can select `always` with an ID-targeted `config` override in its `cordis.patch.yml`; see the README quick start for the complete example and the replay implications for existing sessions.

Version 0.3 additionally accepts `hostLockPackages`, `hostLockPlatform`, and `hostLockProfile`, generated from the active DSH runtime and profile graphs. Each critical row carries the exact resolved version and registry tarball integrity. Missing, duplicate, multi-version, or drifted identity is not inferred from a nearby lockfile and fails closed. Capabilities are evaluated separately for base/Goal, agent loop, POSIX or Windows terminal, filesystem tools, DSH CLI, plugin inventory, Web control, and jobs; a missing platform- or action-specific group disables only the dependent path. The filesystem group freezes pinned `read`/`write`/`edit` registration, closed result and presentation shapes, the `ctx.fs` local/sandbox implementation, read-before-mutation observation policy, sandbox policy, and approval provider. Consequently a missing or drifted filesystem row disables only `create`/`modify` and ordinary filesystem facts, while a valid terminal or jobs capability remains usable. The audited identity is [`../manifests/supported-host.v1.json`](../manifests/supported-host.v1.json). The packaged `dsh-completion-guard-host-lock inspect|inject|verify-dump` flow in the README is the supported generation and readback path; the default patch has no `hostLockPackages` and therefore fails closed until that flow succeeds.

## Peer dependencies

Runtime packages are host-provided and declared as peer dependencies: `@deepseek-ai/cordis`, `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-commands`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-tools`. Goal uses two exact optional peers as one capability: `@deepseek-ai/dsh-goal` owns state, and `@deepseek-ai/dsh-tool-goal` owns the audited `update_goal` name/schema/arguments. Both graph rows and the live Goal service/tool must agree. Profiles without this complete capability still load, but Goal-dependent integration is inactive. Peer ranges accept exactly the three audited cohort sets (`0.1.1-rc.2 || 0.1.2-alpha.2 || 0.1.2-alpha.3`; Cordis `4.0.1 || 4.0.2`) — never a floating range — while runtime acceptance is constrained by the exact injected host lock and its atomic cohort selection.

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

- `dsh --profile web --dump-config` and `--profile headless --dump-config` both include `context-guard`.
- A real headless boot loads the plugin (apply, `ctx.sessions` access, and listener registration succeed) and only stops at missing provider credentials.

The slash command renders in the Web command directory and its on/off/clear/status/diagnose subcommands produce the expected `command/run`/`command/done`. The v0.3 runtime baseline exercises 360 deterministic tests in 20 files, including all 37 mirrored portable semantic cases and all 29 digest vectors: macOS passed 359 tests with the one Windows-only shim test capability-skipped, while native Windows passed all 352 tests of the earlier 19-file baseline with no skips. The same canonical pre-release tgz passed isolated Web/Headless install, host-lock inspect/inject/dump/verify, real dshmarket restart readback, HTTP recovery, and cleanup on both native platforms; Headless loaded to the intentional missing-credential boundary. CI covered Ubuntu, macOS, and Windows on Node.js 22 and 24. A credentialed model session verified an accepted evidence binding and persisted typed-boundary/disarm path; an intentionally over-broad prompt remained incomplete and received no false certificate. Version 0.3.1 preserves those runtime bytes and repairs only the frozen-package provenance path after the 0.3.0 registry entry omitted `gitHead`. The final 0.3.1 tgz remains separately bound to native-platform and public registry readback, as recorded in `LOCAL_ACCEPTANCE.md`. For 0.3.2, the frozen package from commit `22cde610` passed the same-byte isolated lifecycle on native macOS and Windows, and its tag, npm publication, GitHub Release, and public downloads resolve to the same commit and bytes. Here `inspect` confirms that the active package graph is supported; pre-injection failure is proved by composed-config readback and `verify-dump`, not by expecting `inspect` to fail. Evidence and certificates are session-scoped: a later DSH session cannot import or certify evidence IDs from an earlier session, so a workflow requiring a certificate must produce its evidence and checkpoint in one session. The published 0.1.x and 0.2.x releases retain separate historical evidence. The fail-closed invariants below are asserted as regressions.

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

`context_guard_evidence` is a read-only producer for resolution, persisted-effect validation, and state readback. `context_guard_action` is the explicitly mutating surface for exact-tgz install/apply/publish, two-phase dshmarket restart, and exact Git commit/push/pull/fetch. It first flushes and replays the resolution/contract chain, then requires the exact target digest and id/revision of one current pending `root_instruction` or `root_adoption` requirement whose action and complete requested identity match this resolution; a matching pending root prohibition denies the mutation regardless of message order, while prohibitions and acceptance clauses never grant authority. Install/apply require exact package id, version, and profile; publish requires exact artifact id, version, and canonical registry (v0.3 does not authorize `latest` or ranges); push/pull/fetch require repository, remote, and canonical explicit full ref/refspec; restart requires the exact service id. Disabled, integrity-unknown, stale-host, missing, passed, superseded, clarification-required, incomplete-target, action-swapped, target-swapped, and unrebound legacy paths are rejected before executable inspection, command execution, HTTP, or intent persistence. Unknown selector, command-manifest, or Git argument keys are rejected. `install` requires package absence, while `apply` requires an existing package and a changed version/integrity. Publish executes the exact resolved tgz with `--ignore-scripts`; its registry is a canonical HTTPS base shared by capture, argv, and standard packument readback, with credentials, query, fragment, encoded separators, control characters, and ambiguous path segments rejected. Resolution and effect bind the same canonical executable realpath and version. Windows `.cmd`/`.bat` shims additionally bind the canonical `SystemRoot\\System32\\cmd.exe` realpath and version; arguments containing shell-control, expansion, quote, NUL, or newline characters are unsupported, and execution never performs a second `PATH` search or trusts a changed `ComSpec`. Modify re-hashes the source bytes against the frozen pre-digest before deriving the unique UTF-8 replacement post-digest. Restart persists an intent before POST and closes only after a restored process observes a changed boot ID. Git operations reject aliases, implicit/delete/wildcard/force refs, target substitution, and prestate drift. Commit certification additionally rejects root, merge, or substituted-parent commits; fetch certification requires its resolved pre-HEAD, post-HEAD readback, and predicate parameter to be equal. Pre-execute revalidation is a correctness gate rather than isolation from same-user concurrent tampering; any divergent post-action readback is not certified.

Every stateful resolution freezes its expected transition before effect and binds a stable digest of that payload. Checkpoint diagnostics copy this immutable payload from the resolution fact; callers cannot construct create/modify predicates from post-effect state. Create hashes the exact UTF-8 content from the closed write manifest. Modify first reads the original bytes, requires valid UTF-8 and exactly one `old_string` match, applies the pinned single replacement in memory, and hashes the resulting bytes. Restart freezes `health=healthy` as a manifest constant. A later successful effect whose independent state differs from these values remains incomplete.

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
