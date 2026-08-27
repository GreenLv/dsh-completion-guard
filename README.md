# dsh-context-guard

[简体中文](README.zh-CN.md)

A task-contract and completion-certification plugin for DeepSeek Harness (DSH). It preserves requirements, prohibitions, acceptance criteria, later corrections, and bounded evidence so a task can be certified only when current successful evidence matches the current contract.

## Quick start

Install the published plugin into a DSH Web profile:

```sh
dsh plugin --profile web add dsh-context-guard@0.1.0
```

Restart DSH Web, open a session, and enable the guard:

```text
/context-guard on
/context-guard status
```

Activation is opt-in by default. `status` reports whether the guard is enabled, the current epoch and contract revision, pending and passed item counts, the evidence count, and integrity state. `off` stops capture and gating for the session while preserving its prior history; `diagnose` returns a bounded diagnostic view.

Once enabled, Context Guard captures direct user requirements and acceptance criteria. Tool results become citable evidence only after DSH persists them. Before the model claims the whole task is complete, it must call the injected `context_guard_checkpoint` tool with matching evidence IDs; an incomplete or stale binding cannot certify completion.

## What it protects

- Captures requirement, acceptance, and prohibition clauses with stable identities and append-only supersession.
- Derives bounded, redacted evidence from persisted DSH tool calls and results.
- Requires method, operation, subject, surface, and outcome to match where the contract makes them explicit.
- Re-verifies certificates when a session is rebuilt or resumed and fails closed on integrity loss.
- Blocks Goal completion and whole-task completion claims while enabled unless a current certificate exists.

## Status and compatibility

Version 0.1.0 is available from [npm](https://www.npmjs.com/package/dsh-context-guard) and the [GitHub release](https://github.com/GreenLv/dsh-context-guard/releases/tag/v0.1.0). It targets DSH `0.1.1-rc.2`, Node.js `>=22`, and pnpm `>=11`.

The 0.1.0 source suite contains 104 tests (85 domain/core). Native isolated real-model acceptance on macOS and Windows verified that a supported shell or PowerShell write plus an independent read can certify the matching contract before task completion. The public npm package has also been installed and loaded in a real macOS Web profile; this does not claim a second public-package run on Windows.

Context Guard v0.1 intentionally recognizes only a small, auditable shell and PowerShell command subset. Unsupported or ambiguous syntax stays incomplete instead of being partially trusted. See [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) for the exact grammar and platform evidence.

## Boundaries

Context Guard certifies completion; DSH still owns Goal, Todo, Compaction, continuation, permissions, and tool execution. This plugin is not a security sandbox, semantic proof system, token-pruning tool, or replacement for those DSH facilities.

Evidence is bounded and redacted. Complete prompts, stdout, file contents, credentials, Authorization headers, URL query values, image bytes, and raw transcripts are not stored by the guard. See [`docs/PRIVACY.md`](docs/PRIVACY.md).

## Relationship to Codex Context Guard

This project ports deterministic behavior from [`GreenLv/codex-context-guard`](https://github.com/GreenLv/codex-context-guard), with v0.8.8 as its semantic baseline. The two repositories serve different runtimes:

- `codex-context-guard` is the Codex Hook/Python implementation with Codex plugin-cache and Hook lifecycle integration.
- `dsh-context-guard` is an independent TypeScript implementation over native DSH Session events, commands, tools, and agent lifecycle.

They do not share runtime state, installers, caches, or release histories. Fixes are contributed to the repository that owns the affected runtime and are ported deliberately when the same behavior belongs in both products. See [`docs/UPSTREAM_BASE.md`](docs/UPSTREAM_BASE.md) and [`docs/PORTING_NOTES.md`](docs/PORTING_NOTES.md) for the exact reused and replaced boundaries.

## Documentation

- [`CHANGELOG.md`](CHANGELOG.md) — versioned user-visible changes.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — ownership, durable state, and certification pipeline.
- [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) — supported DSH versions and certifiable command subset.
- [`docs/LOCAL_ACCEPTANCE.md`](docs/LOCAL_ACCEPTANCE.md) — deterministic, isolated, native, and public-package validation scopes.
- [`docs/PRIVACY.md`](docs/PRIVACY.md) — stored facts, prohibited data, and failure behavior.
- [`docs/UPSTREAM_BASE.md`](docs/UPSTREAM_BASE.md) — semantic baseline and repository authority boundary.
- [`docs/PORTING_NOTES.md`](docs/PORTING_NOTES.md) — behavior retained from Codex and DSH-specific replacements.

## Development

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run lint
pnpm run build
pnpm run pack:check
```

These commands validate the source and package candidate. CI, native-platform acceptance, npm publication, GitHub release identity, and runtime-profile installation remain separate evidence scopes.
