# dsh-completion-guard

[简体中文](README.zh-CN.md)

An add-on for DeepSeek Harness (DSH) that keeps a task's requirements and checks them before the task is marked complete. It restores the same checklist after a resumed session and accepts only matching saved tool results as evidence.

![Task-contract clauses and bounded evidence pass through a checkpoint before a completion certificate is issued](assets/social/completion-guard-hero.png)

## Quick start

These instructions target 0.4.3. Until that version is published, use the accepted candidate archive in place of the package name below; the published 0.4.2 does not support the new core-lock workflow.

Install the plugin into the DSH Web environment:

```sh
dsh plugin --profile web add dsh-completion-guard
```

Before restarting DSH, record and verify the DSH program directory and the Web settings directory. Replace the example paths with the absolute paths on your machine:

```sh
DSH_RUNTIME_ROOT=/absolute/path/to/.dsh-runtime
DSH_PROFILE_ROOT=/absolute/path/to/.dsh/profiles/web
GUARD_HOST_LOCK="$DSH_PROFILE_ROOT/node_modules/.bin/dsh-completion-guard-host-lock"

"$GUARD_HOST_LOCK" inspect --runtime-root "$DSH_RUNTIME_ROOT" --profile-root "$DSH_PROFILE_ROOT"
"$GUARD_HOST_LOCK" inject --runtime-root "$DSH_RUNTIME_ROOT" --profile-root "$DSH_PROFILE_ROOT"
dsh --profile web --dump-config | "$GUARD_HOST_LOCK" verify-dump --runtime-root "$DSH_RUNTIME_ROOT" --profile-root "$DSH_PROFILE_ROOT" --dump-config -
```

On Windows, run the same three subcommands through `dsh-completion-guard-host-lock.cmd` in the Web settings directory's `node_modules\.bin` directory and use Windows absolute paths. Repeat this check after changing DSH, Guard or the profile location; an ordinary market-only update does not require reinjection. The Guard stays unavailable if the active package set is missing, mixed, duplicated, or different from a checked setup.

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

The 0.4.3 line checks the exact DSH core separately from optional dshmarket. An ordinary market upgrade does not require a Guard release or core-lock reinjection. If a plugin changes the resolved core dependencies, certification still fails closed. Headless does not need market installed.

Restart is a separate capability. Current DSH does not supply independently verified bindings for market's loaded instance, so the Guard market restart adapter is unavailable. A requested restart remains pending; core protection and unrelated operations continue. Installing or applying a package on disk does not prove that a running process or UI has adopted it.

Upgrading the core lock requires fresh inspection and injection from the actual runtime and profile. Old certificates are not relabelled as evidence for the new lock. See the [upgrade guide](docs/HOST_LOCK_UPGRADE.md) and [compatibility guide](docs/COMPATIBILITY.md).

Choose a published version from [npm](https://www.npmjs.com/package/dsh-completion-guard) and verify its commit, checksum and native annexes on the [GitHub Release](https://github.com/GreenLv/dsh-completion-guard/releases/latest). The historical 0.4.2 release targets rc.1 with market 1.41 and does not contain this decoupling. A source version, CI, same-byte native acceptance and publication are separate states; see [acceptance scope](docs/LOCAL_ACCEPTANCE.md).

The project was renamed from `dsh-context-guard` on 2026-08-29; its internal bundle id is still `context-guard`. Migration preserves sessions, activation and disabled settings. Do not load both package names in one profile. Node.js `>=22` and pnpm `>=11` are required.

## Activation modes

Context Guard has two activation modes:

- `opt-in` (default): protection is off when a session starts. Run `/context-guard on` in that session to turn it on, and `/context-guard off` to turn it off again. This changes only the current session.
- `always`: DSH sessions are protected automatically. Running `/context-guard off` turns protection off only for that session; other sessions start with protection on.

These modes only control Guard protection. They are not the DSH session mode (for example, the standard or minimal mode) that a session starts with. With `always`, the Guard loads before each DSH session starts. DSH currently cannot switch a session's mode after the session has started, so a session protected this way keeps the DSH session mode it started with. `/context-guard on` and `/context-guard off` turn Guard protection on or off; they never change the DSH session mode.

To make DSH sessions start with protection on, add this entry to the `cordis.patch.yml` used by the way you start DSH:

```yaml
- id: context-guard
  name: dsh-completion-guard
  config:
    activation: always
```

DSH can run with a **Web** interface in a browser, or **Headless** without a browser interface from a terminal or an automated task. These two ways of running DSH use separate settings files. Edit the file for the one you use, or edit both if you use both:

| System | How you use DSH | Default path |
| --- | --- | --- |
| macOS / Linux | Web | `$HOME/.dsh/profiles/web/cordis.patch.yml` |
| macOS / Linux | Headless | `$HOME/.dsh/profiles/headless/cordis.patch.yml` |
| Windows | Web | `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` |
| Windows | Headless | `%USERPROFILE%\.dsh\profiles\headless\cordis.patch.yml` |

If you set a custom `DSH_HOME`, use that directory instead of `$HOME/.dsh` or `%USERPROFILE%\.dsh`.

You can also paste this prompt into DSH and let it make the change:

> Set `dsh-completion-guard` to `always` mode. Find the `cordis.patch.yml` used by the way I am currently running DSH (Web interface or Headless), back it up first, and only set `activation: always` on the entry with `id: context-guard`. Do not change any other settings or restart DSH. When finished, show me the file path and the exact diff.

After the change, restart DSH.

## How completion is checked

Once enabled, the Guard saves direct user requirements and acceptance checks. A saved tool result counts only when it matches the requested command, file, or other target. Before claiming the whole task complete, the model must pass the Guard's checkpoint; missing, stale, or mismatched evidence leaves the task open.

Read-only evidence collection and actions that change packages, files, services, or Git state use separate tools. A successful lookup never grants permission to make a change. Exact command limits and platform evidence are documented in [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md).

### When a requirement stays incomplete

“Update the plugin and check the GUI” can contain work the Guard cannot certify. The checkpoint reports a reason and a next step for each item. A `generic_run_non_certifiable` result means that changing the binding or running another ordinary command cannot close that item.

Use `context_guard_rebind` to propose an exact, complete split of the old text. If the action or target needs clarification, first ask the root user for an explicit instruction that includes the original clause; the proposal can reference that new item's ID. The tool returns a proposal ID and a comparison. Only the user's exact reply `确认重绑定 <proposal ID>` applies it. Quoted text, tool output, and model confirmation flags do not count. Unsupported parts remain pending, and a qualified safe end does not mean all work is complete.

The default `context_guard_checkpoint` call uses `bindings: []` for diagnosis. It shows at most eight current items/constraints and ten evidence rows, within 12 KiB of plugin JSON. `pagination` reports totals and a separate `next_cursor` for each list; the first page is not the whole contract. Use `item_ids` or `evidence_ids` to focus a query, or `evidence_scope: "history"` for the complete evidence history, including rows marked unavailable. Keep the query unchanged when following a cursor; a changed contract or evidence snapshot requires a fresh query. Large rows expose `detail_id`; retrieve chunks with `detail_offset` and return the first response's `snapshot` as `detail_snapshot` on later chunks. All queries remain read-only and never shrink the certification set.

## Boundaries

Context Guard certifies completion; DSH still owns Goal, Todo, Compaction, continuation, permissions, and tool execution. This plugin is not a security sandbox, semantic proof system, token-pruning tool, or replacement for those DSH facilities.

Evidence is bounded and redacted. Complete prompts, stdout, file contents, credentials, Authorization headers, URL query values, image bytes, and raw transcripts are not stored by the guard. See [`docs/PRIVACY.md`](docs/PRIVACY.md).

## Relationship to Codex Context Guard

This project began as a DSH port of deterministic behavior from [`GreenLv/codex-context-guard`](https://github.com/GreenLv/codex-context-guard) v0.8.8. That version is the historical starting point, not the current compatibility level.

Version 0.4.0 was deliberately aligned with the shared evidence rules in Codex Context Guard 0.10.0: proof must belong to work that is still open and must show the operation, target, and result the user actually requested. This is a limited behavior-level alignment, not a claim that the two products have the same features.

Codex Context Guard 0.11.0 was released afterward. DSH 0.4.0 already has native checks for exact mutation targets, typed waits, and quoted text, but it does not yet include the full 0.11.0 authorization-ticket, work-unit, supersession, or incident-benchmark changes. The plain-language comparison and dated delta ledger are in [`docs/SEMANTIC_COMPATIBILITY.md`](docs/SEMANTIC_COMPATIBILITY.md).

The two repositories serve different runtimes:

- `codex-context-guard` is the Codex Hook/Python implementation with Codex plugin-cache and Hook lifecycle integration.
- `dsh-completion-guard` is an independent TypeScript implementation over native DSH Session events, commands, tools, and agent lifecycle.

They do not share runtime state, installers, caches, or release histories. Fixes are contributed to the repository that owns the affected runtime and are ported deliberately when the same behavior belongs in both products. See [`docs/UPSTREAM_BASE.md`](docs/UPSTREAM_BASE.md) and [`docs/PORTING_NOTES.md`](docs/PORTING_NOTES.md) for the exact reused and replaced boundaries.

## npm download history

![Combined cumulative npm download growth across dsh-context-guard and dsh-completion-guard](https://raw.githubusercontent.com/GreenLv/dsh-completion-guard/stats/npm-downloads.svg)

The cumulative chart keeps the old and new npm package totals visibly separate, marks the 2026-08-29 rename, and combines them only for the project growth line. npm download counts measure registry requests; they are not counts of unique users or confirmed installations.

History starts on the first public npm release day, 2026-08-26; its real first-day count is retained even when nonzero. The vertical axis starts at zero. Date labels share one fixed day interval and centered anchors; the caption always gives the exact coverage end.

The daily workflow publishes through the last day whose counts are unchanged in checks at least 12 hours apart and at least two UTC calendar days old. The API availability date is shown separately; this observation rule is not an npm guarantee that counts will never change. See the [source data](https://raw.githubusercontent.com/GreenLv/dsh-completion-guard/stats/npm-downloads.json).

## Documentation

- [`CHANGELOG.md`](CHANGELOG.md) — versioned user-visible changes.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — ownership, durable state, and certification pipeline.
- [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) — supported DSH versions and certifiable command subset.
- [`docs/LOCAL_ACCEPTANCE.md`](docs/LOCAL_ACCEPTANCE.md) — deterministic, isolated, native, and public-package validation scopes.
- [`docs/distribution.md`](docs/distribution.md) — verified public distribution destinations and the rename note.
- [`docs/PRIVACY.md`](docs/PRIVACY.md) — stored facts, prohibited data, and failure behavior.
- [`docs/UPSTREAM_BASE.md`](docs/UPSTREAM_BASE.md) — historical starting point and repository authority boundary.
- [`docs/SEMANTIC_COMPATIBILITY.md`](docs/SEMANTIC_COMPATIBILITY.md) — current shared behavior and known gaps.
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

These commands validate a local source tree and package. CI, native-platform acceptance, npm publication, GitHub release identity, and installation in a live DSH environment remain separate evidence scopes.
