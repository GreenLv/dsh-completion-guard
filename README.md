# dsh-completion-guard

[简体中文](README.zh-CN.md)

An add-on for DeepSeek Harness (DSH) that keeps a task's requirements and checks them before the task is marked complete. It restores the same checklist after a resumed session and accepts only matching saved tool results as evidence.

![Task-contract clauses and bounded evidence pass through a checkpoint before a completion certificate is issued](assets/social/completion-guard-hero.png)

## Quick start

Install the published plugin into a DSH Web profile:

```sh
dsh plugin --profile web add dsh-completion-guard@0.3.1
```

Before restarting DSH, record and verify the active runtime and profile. Replace the example paths with the absolute paths on your machine:

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

On Windows, run the same three subcommands through `dsh-completion-guard-host-lock.cmd` in the profile's `node_modules\.bin` directory and use Windows absolute paths. Repeat this check after a DSH, profile, or package upgrade. The Guard stays unavailable if the active package set is missing, mixed, duplicated, or different from a checked setup.

Restart DSH Web, open a session, and enable the Guard:

```text
/context-guard on
/context-guard status
```

Activation is opt-in by default. `status` shows whether the Guard is on and how many checks remain. `off` stops protection for the current session without deleting its history. `clear` closes the current checklist while keeping prohibitions. `diagnose` explains why a completion check passed or failed.

## What it protects

- Saves requirements, acceptance checks, prohibitions, and later corrections without overwriting history.
- Uses only tool calls and results that DSH has saved, and stores a redacted summary rather than full output.
- Accepts evidence only when the action and result match the requested command, file, or other target.
- Rechecks completion after a session is rebuilt or resumed, and refuses to certify damaged state.
- Stops the Guard-owned Goal completion path when the current checklist has not passed. DSH internals can still bypass this path, so the plugin reports those cases rather than claiming to block every possible write.

## Status and compatibility

Version 0.3.1 is the current published release. Install it from [npm](https://www.npmjs.com/package/dsh-completion-guard); its [GitHub Release](https://github.com/GreenLv/dsh-completion-guard/releases/tag/v0.3.1) and exact public checks are recorded in [`docs/LOCAL_ACCEPTANCE.md`](docs/LOCAL_ACCEPTANCE.md).

Version 0.3.2 is an unreleased source candidate. It recognizes the exact DSH `0.1.1-rc.2` and `0.1.2-alpha.2` package sets checked on macOS and Windows. See [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) for the package sets and [`docs/LOCAL_ACCEPTANCE.md`](docs/LOCAL_ACCEPTANCE.md) for the remaining release checks.

Version 0.3.0 is not recommended. Its package passed native checks, but npm did not record the required source commit, so the version cannot be repaired in place and has no GitHub Release. Use 0.3.1, which keeps the same runtime behavior and fixes that release record.

> The project was renamed from `dsh-context-guard` to `dsh-completion-guard` on 2026-08-29 because an unrelated plugin already used the old name. The internal bundle id remains `context-guard`, and the old npm package points users to this one. Supported DSH setups are listed in [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md); Node.js `>=22` and pnpm `>=11` are required.

## Activation modes

The default `opt-in` mode protects a session only after `/context-guard on`. To enable the Guard automatically for a DSH profile, add this override to that profile's `cordis.patch.yml`:

```yaml
- id: context-guard
  name: dsh-completion-guard
  config:
    activation: always
```

Restart the profile, then run `/context-guard status`. In `always` mode, rebuilding an existing session can also capture earlier user messages from its saved log. Keep `opt-in` if protection should start only after an explicit command.

## How completion is checked

Once enabled, the Guard saves direct user requirements and acceptance checks. A saved tool result counts only when it matches the requested command, file, or other target. Before claiming the whole task complete, the model must pass the Guard's checkpoint; missing, stale, or mismatched evidence leaves the task open.

Read-only evidence collection and actions that change packages, files, services, or Git state use separate tools. A successful lookup never grants permission to make a change. Exact command limits and platform evidence are documented in [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md).

## Boundaries

Context Guard certifies completion; DSH still owns Goal, Todo, Compaction, continuation, permissions, and tool execution. This plugin is not a security sandbox, semantic proof system, token-pruning tool, or replacement for those DSH facilities.

Evidence is bounded and redacted. Complete prompts, stdout, file contents, credentials, Authorization headers, URL query values, image bytes, and raw transcripts are not stored by the guard. See [`docs/PRIVACY.md`](docs/PRIVACY.md).

## Relationship to Codex Context Guard

This project ports deterministic behavior from [`GreenLv/codex-context-guard`](https://github.com/GreenLv/codex-context-guard), with v0.8.8 as its semantic baseline. The two repositories serve different runtimes:

- `codex-context-guard` is the Codex Hook/Python implementation with Codex plugin-cache and Hook lifecycle integration.
- `dsh-completion-guard` is an independent TypeScript implementation over native DSH Session events, commands, tools, and agent lifecycle.

They do not share runtime state, installers, caches, or release histories. Fixes are contributed to the repository that owns the affected runtime and are ported deliberately when the same behavior belongs in both products. See [`docs/UPSTREAM_BASE.md`](docs/UPSTREAM_BASE.md) and [`docs/PORTING_NOTES.md`](docs/PORTING_NOTES.md) for the exact reused and replaced boundaries.

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
