# dsh-completion-guard

[简体中文](README.zh-CN.md)

An add-on for DeepSeek Harness (DSH) that keeps a task's requirements and checks them before the task is marked complete. It restores the same checklist after a resumed session and accepts only matching saved tool results as evidence.

![Task-contract clauses and bounded evidence pass through a checkpoint before a completion certificate is issued](assets/social/completion-guard-hero.png)

## Quick start

Install the published plugin into a DSH Web profile:

```sh
dsh plugin --profile web add dsh-completion-guard@0.3.1
```

Restart DSH Web, open a session, and enable the guard:

```text
/context-guard on
/context-guard status
```

Activation is opt-in by default. `status` shows whether the guard is on and how many items and evidence records remain. `off` stops protection for the current session without deleting its history. `clear` closes the current pending checklist while keeping prohibitions. `diagnose` explains why a completion check passed or failed.

### Activation modes

`activation` accepts two values:

| Value | Behavior |
| --- | --- |
| `opt-in` | Default. A session remains unprotected until `/context-guard on` is recorded in that session. |
| `always` | Starts enabled before the session log is replayed. `/context-guard off` disables the guard for that session until a later `/context-guard on`. |

To start Context Guard automatically for sessions in a DSH profile, add an ID-targeted override to that profile's `cordis.patch.yml`. For the default Web profile on macOS or Linux, this file is normally `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: context-guard
  name: dsh-completion-guard
  config:
    activation: always
```

Restart that DSH profile after changing the configuration, then run `/context-guard status` in a session to confirm that the guard is enabled. Because `always` enables the guard before replay, applying it to a profile that already has persisted sessions can cause earlier user messages in those sessions to be captured when their logs are rebuilt. Use `opt-in` when protection should begin only after an explicit per-session command.

Once enabled, Context Guard captures direct user requirements and acceptance criteria. Tool results become citable evidence only after DSH persists them. Before the model claims the whole task is complete, it must call the injected `context_guard_checkpoint` tool with matching evidence IDs; an incomplete or stale binding cannot certify completion.

## What it protects

- Saves requirements, acceptance checks, prohibitions, and later corrections without overwriting history.
- Uses only tool calls and results that DSH has saved, and stores a redacted summary rather than full output.
- Accepts evidence only when the action and result match the requested command, file, or other target.
- Rechecks completion after a session is rebuilt or resumed, and refuses to certify damaged state.
- Stops the Guard-owned Goal completion tool when no current certificate exists. Direct internal writes can be reported as integrity problems but cannot always be blocked.

## Status and compatibility

Version 0.3.1 is the current published release. Install it from [npm](https://www.npmjs.com/package/dsh-completion-guard); its [GitHub Release](https://github.com/GreenLv/dsh-completion-guard/releases/tag/v0.3.1) and exact public checks are recorded in [`docs/LOCAL_ACCEPTANCE.md`](docs/LOCAL_ACCEPTANCE.md).

Version 0.3.2 is an unreleased source candidate that recognizes two exact DSH setups: `0.1.1-rc.2` with dshmarket `1.36.0`, and `0.1.2-alpha.2` with dshmarket `1.38.1`. Every required package must match one complete setup. Missing, mixed, duplicate, or unknown packages leave the Guard unavailable instead of partly enabled. The alpha.2 setup has been checked on macOS only, so it remains unavailable on Windows. Switching setups also invalidates earlier completion certificates. See [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) for the package list and [`docs/LOCAL_ACCEPTANCE.md`](docs/LOCAL_ACCEPTANCE.md) for pending checks.

Version 0.3.0 is not recommended. Its package passed native checks, but npm did not record the required source commit, so the version cannot be repaired in place and has no GitHub Release. Use 0.3.1, which keeps the same runtime behavior and fixes that release record.

> The project was renamed from `dsh-context-guard` to `dsh-completion-guard` on 2026-08-29 because an unrelated plugin already used the old name. The internal bundle id remains `context-guard`, and the old npm package points users to this one. Supported DSH setups are listed in [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md); Node.js `>=22` and pnpm `>=11` are required.

### Earlier v0.2.x evidence

The 0.2.1 release suite contains 138 tests (105 domain/core). It attributes shell evidence to the session cwd when the tool omits `workdir`, supports literal `2>&1` diagnostics and read-only inspection commands, maps process verbs to run evidence, and exposes actionable hints when a checkpoint binding is rejected. 0.2.1 adds a session-layer capture filter so clarification questions, meta comments, and bare progression phrases (`继续`, `continue`) never become contract items; de-duplicates repeated recovery notifications; adds `/context-guard clear`; and documents how a goal completes when the guard is disabled or blocked. A macOS live Web run loaded the published profile package and certified a real `pnpm test` result.

The Windows TEMP readback verifies the `b75868e9e73d29f50530ddaba15cfaef82e03ece` source matrix and the exact-source tarball → isolated installation → dump-config → Web startup log and cleanup chain. HTTP 200 appeared only in the first-run stdout, was not persisted, and was not rerun during readback, so the HTTP response itself is not independently confirmed. A real model-session smoke remains not run.

### v0.3.1

Version 0.3.1 carries the v0.3 semantic action/target binding, independent state readback for stateful actions, typed boundaries, digest-v3 certificates, exact active-host identity, and paired optional Goal integration introduced in 0.3.0. It adds a deterministic release packer that binds the full Git HEAD inside the frozen tgz before native-platform acceptance and registry publication. The 19-file deterministic suite passed 351 tests with one Windows-only capability skip on macOS and all 352 tests without skips on native Windows for the unchanged runtime baseline. [`docs/LOCAL_ACCEPTANCE.md`](docs/LOCAL_ACCEPTANCE.md) keeps source, artifact, CI, model-session, and publication evidence scopes separate.

The release uses [`manifests/action-manifest.v1.json`](manifests/action-manifest.v1.json), [`manifests/git-command-manifest.v2.json`](manifests/git-command-manifest.v2.json), and [`manifests/supported-host.v1.json`](manifests/supported-host.v1.json). Goal integration requires the exact optional peers `@deepseek-ai/dsh-goal@0.1.1-rc.2` and `@deepseek-ai/dsh-tool-goal@0.1.1-rc.2` together. It fails closed unless the active DSH runtime/profile graph injects the exact `hostLockPackages`, platform, and profile identity. A nearest lockfile is not accepted because DSH core and profile plugins use separate package graphs. The default bundled patch deliberately contains no fabricated lock.

After installing the release into a profile, generate and verify its active identity with the packaged CLI. Use absolute paths for the actual DSH installation; the dump is an inspection artifact, not a configuration source:

```sh
DSH_RUNTIME_ROOT=/absolute/path/to/.dsh-runtime
DSH_PROFILE_ROOT=/absolute/path/to/.dsh/profiles/web
DSH_COMPOSED_DUMP=/tmp/dsh-web-composed.yml
GUARD_HOST_LOCK="$DSH_PROFILE_ROOT/node_modules/.bin/dsh-completion-guard-host-lock"

"$GUARD_HOST_LOCK" inspect --runtime-root "$DSH_RUNTIME_ROOT" --profile-root "$DSH_PROFILE_ROOT"
"$GUARD_HOST_LOCK" inject --runtime-root "$DSH_RUNTIME_ROOT" --profile-root "$DSH_PROFILE_ROOT"
dsh --profile web --dump-config > "$DSH_COMPOSED_DUMP"
"$GUARD_HOST_LOCK" verify-dump --runtime-root "$DSH_RUNTIME_ROOT" --profile-root "$DSH_PROFILE_ROOT" --dump-config "$DSH_COMPOSED_DUMP"
```

`inspect` and `inject` reject missing, duplicate, multi-version, or drifted critical packages. `verify-dump` then proves that DSH composed the same bounded tuple that was read from the active graphs. Repeat the flow after any DSH/profile/package upgrade. Until it succeeds, certification, Goal-dependent completion, and affected action capabilities remain unavailable. Release validation used fresh isolated profiles and did not overwrite the user's existing DSH profiles.

`context_guard_evidence` is read-only: it resolves targets, validates persisted effects, and performs independent state readback. Mutating install/apply/restart/publish and exact Git commit/push/pull/fetch operations use the separately named `context_guard_action` tool. A resolution is not mutation authority: the caller must identify the exact pending root-owned requirement and revision, repeat the persisted target digest, and match every action-specific identity field before any executable, HTTP request, or restart intent runs. Prohibitions and acceptance clauses never authorize mutation. Package/apply/publish authority is exact-version-only in v0.3; Git authority requires an explicit remote and canonical full ref/refspec. The presentation surface shows the canonical target and command-manifest digest before execution.

Publish targets use one canonical HTTPS registry base with no credentials, query, fragment, ambiguous path, or control characters; the same base is frozen in the root contract, npm argv, and registry readback. Create and modify resolutions freeze the expected post-write digest before effect; modify re-hashes the source bytes against the frozen pre-digest before applying the pinned unique UTF-8 replacement semantics, so either prestate drift or different post-effect bytes fail closed.

Context Guard recognizes only a small, auditable shell and PowerShell command subset. Unsupported or ambiguous syntax stays incomplete instead of being partially trusted. Compound commands, variables, non-whitelisted executables, file-target redirects, and in-place `sed` remain outside the certifiable surface. See [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) for the exact grammar and platform evidence.

## Boundaries

Context Guard certifies completion; DSH still owns Goal, Todo, Compaction, continuation, permissions, and tool execution. This plugin is not a security sandbox, semantic proof system, token-pruning tool, or replacement for those DSH facilities.

Evidence is bounded and redacted. Complete prompts, stdout, file contents, credentials, Authorization headers, URL query values, image bytes, and raw transcripts are not stored by the guard. See [`docs/PRIVACY.md`](docs/PRIVACY.md).

## Relationship to Codex Context Guard

This project ports deterministic behavior from [`GreenLv/codex-context-guard`](https://github.com/GreenLv/codex-context-guard), with v0.8.8 as its semantic baseline. The two repositories serve different runtimes:

- `codex-context-guard` is the Codex Hook/Python implementation with Codex plugin-cache and Hook lifecycle integration.
- `dsh-completion-guard` is an independent TypeScript implementation over native DSH Session events, commands, tools, and agent lifecycle.

They do not share runtime state, installers, caches, or release histories. Fixes are contributed to the repository that owns the affected runtime and are ported deliberately when the same behavior belongs in both products. See [`docs/UPSTREAM_BASE.md`](docs/UPSTREAM_BASE.md) and [`docs/PORTING_NOTES.md`](docs/PORTING_NOTES.md) for the exact reused and replaced boundaries.

## npm download history

![Combined cumulative npm download growth across dsh-context-guard and dsh-completion-guard](https://raw.githubusercontent.com/GreenLv/dsh-completion-guard/stats/npm-downloads.svg)

The cumulative chart keeps the old and new npm package totals visibly separate, marks the 2026-08-29 rename, and combines them only for the project growth line. npm download counts measure registry requests; they are not counts of unique users or confirmed installations. The workflow runs daily and can also be triggered manually.

## Documentation

- [`CHANGELOG.md`](CHANGELOG.md) — versioned user-visible changes.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — ownership, durable state, and certification pipeline.
- [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) — supported DSH versions and certifiable command subset.
- [`docs/LOCAL_ACCEPTANCE.md`](docs/LOCAL_ACCEPTANCE.md) — deterministic, isolated, native, and public-package validation scopes.
- [`docs/distribution.md`](docs/distribution.md) — verified public distribution destinations and the rename note.
- [`docs/PRIVACY.md`](docs/PRIVACY.md) — stored facts, prohibited data, and failure behavior.
- [`docs/UPSTREAM_BASE.md`](docs/UPSTREAM_BASE.md) — semantic baseline and repository authority boundary.
- [`docs/PORTING_NOTES.md`](docs/PORTING_NOTES.md) — behavior retained from Codex and DSH-specific replacements.

## Development

```sh
pnpm install --frozen-lockfile
pnpm run test:stats
pnpm run typecheck
pnpm test
pnpm run lint
pnpm run build
pnpm run pack:check
```

These commands validate a local source tree and package. CI, native-platform acceptance, npm publication, GitHub release identity, and runtime-profile installation remain separate evidence scopes.
