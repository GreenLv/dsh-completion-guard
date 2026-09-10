# Compatibility

Compatibility is pinned to exact host package sets. A nearby version or a partial package match is not treated as supported.

## 0.5.1 support policy

Version 0.5.1 supports **DSH >= 0.1.5-rc.1** and nothing older. There is no
backward compatibility: the previous Session V2 API, the V2 event vocabulary,
and every older host cohort were removed rather than kept behind a fallback.
`0.1.5-rc.1` is the version this release was implemented and tested against; it
is the baseline, not a ceiling.

Two separate judgments decide whether a host is usable, and neither replaces the
other:

1. **Version policy** — `src/domain/host-version.ts` orders host versions with
   the SemVer prerelease rules. `peerDependencies` publish the range
   `>=0.1.5-rc.1`; because a range cannot express "every future prerelease at
   any base", the range is the conservative install-time statement and the
   module is the explicit decision path. `0.1.4` and `0.1.5-alpha.9` are
   refused. `0.1.6-rc.1` and `0.2.0-rc.1` order above the bound but do not
   resolve from the published range and are not registered cohorts.
2. **Host identity** — the exact 33-row DSH core graph must match one registered
   cohort row for row. A newer host that has not been registered is reported as
   unverified, never as supported: the version range alone never admits a graph.

If you are upgrading from a profile that ran DSH 0.1.2-rc.1, start a **new
session**. Guard does not migrate V2 logs, proposals, or certificates, and old
user data is never deleted or reinterpreted.

### The 0.1.5-rc.1 cohort is registry-derived, not natively audited

The active cohort `dsh-0.1.5-rc.1-core-v1` carries the exact npm registry
`dist.integrity` of every published 0.1.5-rc.1 tarball, so the graph lock can
certify the bytes. No native macOS or Windows host has loaded this graph in the
0.5.1 implementation round, so the cohort records
`auditProvenance: registry-derived-pending-native-audit` with an empty
`auditedPlatforms` list, while `acceptedPlatforms` still contains `posix` and
`windows` so the graph can be evaluated. The provenance value is bound into
`hostLockDigest`, so a certificate issued against it can never be presented as
a native pass. Read the native gate as **not run**, not as passed.

Every older cohort — `0.1.1-rc.2`, `0.1.2-alpha.2`, the alpha.2 + dshmarket
1.39.0 combination, `0.1.2-alpha.3`, and `0.1.2-rc.1` — stays in the shipped
manifest and source registry as a historical identity so previously accepted
annexes stay verifiable. An installed runtime built from one of them fails
closed (`host_lock_version_mismatch`). No floating range and no alpha support is
claimed.

## 0.4.3 core-lock policy

`dsh-core/v1` uses manifest version 2 and four exact 33-package DSH core graphs, retaining the previously audited DSH and Cordis versions. Market is not a core row. Its transitive dependencies remain part of active-graph traversal, so replacing or duplicating a core dependency still blocks certification. No floating DSH version range is introduced.

The package keeps the same Codex semantic fixtures and digest-v3 encoder. The new manifest/cohort/policy values create a different host identity; an old injected lock requires fresh inspection and injection, and an old certificate stays historical. See [migration](HOST_LOCK_UPGRADE.md). Package version alone does not establish CI, native acceptance or publication.

## Recorded 0.4.0 release baseline

- Plugin: `dsh-completion-guard` `0.4.0`
- DeepSeek Harness: `0.1.2-alpha.3`
- dshmarket: `1.39.0`
- Cordis: `4.0.2`
- Node: `>= 22`
- pnpm: `>= 11`

DSH is still a developer preview and may make breaking changes. Version 0.4.0 therefore makes no floating alpha compatibility claim.

## Published 0.4.1-rc.1 prerelease (`next`)

- Plugin: `dsh-completion-guard` `0.4.1-rc.1` prerelease
- DeepSeek Harness: `0.1.2-rc.1`
- dshmarket: `1.41.0`
- Cordis: `4.0.2`
- Audited platforms: native macOS/posix runtime, plus the native Windows rc.1 host graph verified on the live Windows host (host-lock inspect/inject, composed-config verify-dump, cold Web boot)
- Evidence boundary: host-graph audits are source/runtime-level evidence and do not replace the cross-platform exact-artifact acceptance of one frozen package; unregistered host cohorts keep failing closed

DSH rc.1 replaces the public `Session.events` getter with `snapshotEvents()` and `eventAt()`. The 0.4.1-rc.1 candidate used `snapshotEvents()` when present and retained `events` for older registered cohorts. **Superseded by 0.5.1**, which supports only the Session V3 API and refuses a session that does not expose `snapshotEvents()`; the historical fallback no longer exists in the shipped plugin. The flush path, Goal disarm, and `update_goal` contract noted here still hold.

## Upstream adaptation policy

Version 0.5.1 targets DSH >= `0.1.5-rc.1` with `0.1.5-rc.1` as the implemented and tested baseline; alpha releases are observed for trend only and are never adaptation or validation targets. A newer upstream tag does not establish support by itself: support starts when that exact RC or release is added as its own registered cohort with source, CI, and native acceptance. The upstream [tags page](https://github.com/deepseek-ai/deepseek-harness/tags) tracks later releases. The host-side API differences that this adaptation had to absorb are listed in the repository's upstream API audit (`UPSTREAM_API_AUDIT.md` at the repository root), which is a maintainer document and is not part of the published package.

## Platform and release evidence

- **Source and CI:** the release commit must pass the repository matrix and the Ubuntu, macOS, and Windows Node.js 22/24 CI jobs.
- **Exact package:** the repository packer emits one deterministic tgz with the declared package inventory with its full source commit in `gitHead`. That same SHA-256 must be used on both native platforms and published to npm without repacking.
- **Native scope:** macOS and Windows acceptance separately cover isolated Web and Headless installation, complete host-lock readback, repeated injection, Web restart and recovery, intentional Headless credential failure, daily-profile preservation, and scoped cleanup.
- **Public identity:** the annotated tag, npm manifest and downloaded tgz, GitHub Release target, checksum, and platform annexes must all resolve to the same release commit and package bytes.
- **Daily profiles:** upgrading a user's daily DSH profile is a separate action and is not implied by release acceptance.

## Historical compatibility cohorts

These are verification records, not support entries. An installed runtime built
from any of them fails closed under the 0.5.1 policy.

- DSH `0.1.1-rc.2` + dshmarket `1.36.0` + Cordis `4.0.1` is a retained, published-line cohort.
- DSH `0.1.2-alpha.2` + dshmarket `1.38.1` + Cordis `4.0.2` is the published 0.3.2 cohort checked natively on macOS and Windows.
- DSH `0.1.2-alpha.2` + dshmarket `1.39.0` + Cordis `4.0.2` remains a deterministic compatibility cohort. It is no longer a native 0.4.0 release blocker.
- DSH `0.1.2-alpha.3` + dshmarket `1.39.0` + Cordis `4.0.2` is the recorded 0.4.0 release baseline.
- DSH `0.1.2-rc.1` + dshmarket `1.41.0` + Cordis `4.0.2` is the 0.4.1-rc.1 / 0.5.0 cohort, checked natively on macOS and Windows.
- DSH `0.1.5-rc.1` + Cordis `4.0.2` is the **active** 0.5.1 cohort, with no dshmarket row.

## Rejection rules

Current core graphs and original historical cohorts are recorded separately in [`../manifests/supported-host.v1.json`](../manifests/supported-host.v1.json). All core rows must match one complete graph. Missing, mixed, duplicate, unknown or integrity-drifted core rows reject certification.

Market versions do not select a core cohort. Market restart has its own protocol and loaded-instance checks; an unavailable adapter does not disable the core or erase pending restart work. Changing the actual core graph changes its digest and invalidates earlier certificates.

## Evidence links

- Candidate and historical-artifact evidence: [`LOCAL_ACCEPTANCE.md`](LOCAL_ACCEPTANCE.md)
- Shared Codex/DSH semantic scope: [`SEMANTIC_COMPATIBILITY.md`](SEMANTIC_COMPATIBILITY.md)
- Exact host identities: [`../manifests/supported-host.v1.json`](../manifests/supported-host.v1.json)

## Loader contract

The package exposes a named `apply(ctx)` function and a named `inject` array (`['sessions', 'commands']`) with no default export. Its `dsh.bundle.patch` points at `cordis.patch.yml`, which inserts the `context-guard` bundle row.

The plugin accepts an `activation` configuration value of `opt-in` or `always`. The default is `opt-in`; `always` means every session is protected automatically from its first real user message. Since 0.5.0, session start writes nothing into the session log: the versioned protocol boundary and first-step guidance are delivered inside the same step batch as — and ahead of — the first real user message, so a new session stays blank (`seq === 0`) and a DSH preset can be selected before anything is sent. An explicit `off` suppresses `always` in that session until the next `on`. Invalid values fail during plugin configuration instead of silently falling back. A DSH profile can select `always` with an ID-targeted `config` override in its `cordis.patch.yml`; see the README quick start for the complete example.

### Host-lock setup

Before the Guard can certify work, generate and verify the host lock from the active DSH runtime and profile. Use the packaged `dsh-completion-guard-host-lock inspect|inject|verify-dump` flow in the README. The default patch has no `hostLockPackages`, so the Guard fails closed until this flow succeeds.

Version 0.4.3 injects `hostLockPolicy: dsh-core/v1`, the runtime/profile source roots, `hostLockPackages`, `hostLockPlatform`, and `hostLockProfile` together. Replay rechecks those actual graph sources; legacy configuration without the policy and roots reports `host_lock_migration_required`. Each critical package row records the exact resolved version and registry tarball integrity. The Guard does not infer a missing identity from a nearby lockfile: missing, duplicate, multi-version, or drifted rows fail closed. The audited identities are defined in [`../manifests/supported-host.v1.json`](../manifests/supported-host.v1.json).

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

Action-specific checks select their required groups only after the complete core graph is valid. An invalid core graph blocks certification; a missing optional market adapter blocks only its dependent operation.

The filesystem group has a narrower contract of its own. It freezes the registered `read`, `write`, and `edit` tools; their closed result and presentation shapes; the local or sandbox `ctx.fs` implementation; the read-before-mutation observation policy; the sandbox policy; and the approval provider. A missing or drifted filesystem core row keeps the core lock unavailable.

## Peer dependencies

The ordinary runtime packages are host-provided peers:

- `@deepseek-ai/cordis`;
- `@deepseek-ai/dsh-agent`;
- `@deepseek-ai/dsh-commands`;
- `@deepseek-ai/dsh-llm`;
- `@deepseek-ai/dsh-session`; and
- `@deepseek-ai/dsh-tools`.

Goal support uses two exact optional peers as one capability. `@deepseek-ai/dsh-goal` owns Goal state, while `@deepseek-ai/dsh-tool-goal` owns the audited `update_goal` name, schema, and arguments. Both host-graph rows and the live Goal service and tool must agree. A profile without this complete pair can still load, but Goal-dependent integration stays inactive.

Version 0.5.1 publishes one range per DSH package: `>=0.1.5-rc.1`, with Cordis `^4.0.2` (Cordis is versioned independently and unchanged at `4.0.2`). The range is the floor of the support policy, never a claim that any graph above it works: runtime acceptance still requires an exact injected host lock and atomic selection of one complete registered cohort.

Two npm facts are worth stating plainly, because a bare `>=` reads stronger than it is:

- A version carrying a prerelease resolves from `>=0.1.5-rc.1` only when its
  `major.minor.patch` tuple is `0.1.5`. So `0.1.5-rc.2` and `0.1.5` resolve,
  while `0.1.6-rc.1` and `0.2.0-rc.1` do not. Later `x.y.z` releases resolve
  normally.
- The development dependencies pin the exact `0.1.5-rc.1` packages this release
  actually verified, so the tested baseline is recorded even though the peer
  range is wider.

Historical peer declarations belong to their own release sections above and are
not part of the 0.5.1 contract.

## Terminal outcome contract

The pinned DSH `bash` and `pwsh` renderers append terminal markers for sandbox
denial, timeout, signal termination, and non-zero exit. A completed foreground
result with none of those markers is the renderer's representation of a clean
exit; it does not append `[exit code: 0]`. Version 0.1.1 therefore accepts an
unmarked completed foreground `bash` result as successful evidence, matching the
existing `pwsh` behavior.

Version 0.5.1 re-checked that rule against the shipped 0.1.5-rc.1 renderer
sources. The two session renderers registered by `@deepseek-ai/dsh-base`
(`dsh-tool-bash`, `dsh-tool-pwsh`) append a marker only for negative facts and
non-zero exits in both host versions, so an unmarked completed foreground
result stays a clean success **for those two names under a supported host
lock**. The out-of-bundle persistent renderer gained two markers in 0.1.5-rc.1 —
`[Command finished with exit code N]` and `[Command timed out or OOM]` — and
both are now classified explicitly, so a persistent result is read by its own
marker instead of falling through to the unmarked rule. That package is not in
the registered cohort, so such a host also fails the whole graph lock closed.

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

### Previously verified runtime behavior

These observations belong to the historical native records linked below. Each new core-lock artifact requires fresh native acceptance.

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
relevant evidence, or a new contract revision triggers reevaluation. In 0.4.2, unrelated historical success does not repeat unchanged refusal guidance; every actual recovery still receives a current summary.

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
- `apply` requires the exact package id, version, and profile, plus an existing package with a changed version or integrity. It executes through the DSH CLI and verifies disk package identity. It does not prove a live process, UI or restart outcome; those requirements remain separate.
- `publish` requires the exact artifact id, version, and canonical registry. Version 0.3 does not authorize `latest` or a version range.

Publish executes the exact resolved tgz with `--ignore-scripts`. Capture, argv, and standard packument readback use the same canonical HTTPS registry base. Registries containing credentials, a query, fragment, encoded separator, control character, or ambiguous path segment are rejected.

The resolution and effect bind the same canonical executable realpath and version.

### Git operations

Push, pull, and fetch require the exact repository, remote, and canonical explicit full ref or refspec. Git aliases, implicit refs, deletion refs, wildcards, force refs, target substitution, and prestate drift are rejected.

Commit certification additionally rejects root commits, merge commits, and substituted parents. Fetch certification requires its resolved pre-HEAD, post-HEAD readback, and predicate parameter to be equal.

### File creation and modification

Create and modify bind to the frozen target and expected transition described below. For modify, the Guard re-hashes the source bytes against the frozen pre-digest before deriving the unique UTF-8 replacement post-digest.

### Restart

Restart requires an exact service, compatible protocol and a trusted binding from the host to the loaded provider, profile, loopback origin, package identity and process generation. HTTP capability claims and disk manifests alone do not establish that binding. Current DSH provides no production verifier, so the market restart adapter is unavailable even when the core lock is supported.

The version-2 service adapter binds provider and instance digests into its generation string. A persisted intent permits the intended new instance only for the same provider; arbitrary process drift, provider replacement and old version-1 credentials cannot close the action. This pre-execute check is not isolation against a concurrently malicious same-user process. Native direct market restart checks are not evidence that Guard can certify a market restart.

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
