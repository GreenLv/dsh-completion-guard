# dsh-completion-guard

[简体中文](README.zh-CN.md)

An add-on for DeepSeek Harness (DSH) that keeps a task's requirements and checks them before the task is marked complete. It restores the same checklist after a resumed session and accepts only matching saved tool results as evidence.

![Task-contract clauses and bounded evidence pass through a checkpoint before a completion certificate is issued](assets/social/completion-guard-hero.png)

## Quick start

Install the published **0.5.1** release into the DSH Web environment:

```sh
dsh plugin --profile web add dsh-completion-guard@0.5.1
```

**Upgrade and restart DSH before running the host-lock checks below.** The lock records the package versions and installation directories DSH actually uses. A lock generated before an upgrade describes the old packages and will fail against the new runtime. `inject` writes to `<profile>/cordis.patch.yml`, so back up that file first.

Check that each command's JSON output says `status: "supported"`. `inspect`, `inject` and `verify-dump` can exit with code `0` even when their verdict is `unsupported`; a successful shell exit alone is insufficient.

```sh
DSH_RUNTIME_ROOT=/absolute/path/to/.dsh-runtime
DSH_PROFILE_ROOT=/absolute/path/to/.dsh/profiles/web
GUARD_HOST_LOCK="$DSH_PROFILE_ROOT/node_modules/.bin/dsh-completion-guard-host-lock"

"$GUARD_HOST_LOCK" inspect --runtime-root "$DSH_RUNTIME_ROOT" --profile-root "$DSH_PROFILE_ROOT"
"$GUARD_HOST_LOCK" inject --runtime-root "$DSH_RUNTIME_ROOT" --profile-root "$DSH_PROFILE_ROOT"
dsh --profile web --dump-config | "$GUARD_HOST_LOCK" verify-dump --runtime-root "$DSH_RUNTIME_ROOT" --profile-root "$DSH_PROFILE_ROOT" --dump-config -
```

On Windows, run the same three subcommands through `dsh-completion-guard-host-lock.cmd` in the Web settings directory's `node_modules\.bin` directory and use Windows absolute paths. The published 0.5.1 package passed separate macOS and Windows native acceptance on DSH `0.1.5-rc.2`; see the [acceptance record](docs/LOCAL_ACCEPTANCE.md). Other host versions and artifacts need their own native evidence. Repeat this check after changing DSH, Guard or the profile location; an ordinary market-only update does not require reinjection. The Guard stays unavailable if the active package set is missing, mixed, duplicated, or different from a checked setup.

Restart DSH Web, open a session, and enable the Guard:

```text
/context-guard on
/context-guard status
```

Activation is opt-in by default. `status` shows whether the Guard is on, its startup phase (`armed` means waiting for your first message), and how many checks remain. `off` stops protection for the current session without deleting its history. `clear` closes the current checklist while keeping prohibitions. `diagnose` explains why a completion check passed or failed.

## What it protects

- Saves requirements, acceptance checks, prohibitions, and later corrections without overwriting history.
- Uses only tool calls and results that DSH has saved, and stores a redacted summary rather than full output.
- Accepts evidence only when the action and result match the requested command, file, or other target.
- Rechecks completion after a session is rebuilt or resumed, and refuses to certify damaged state.
- Stops the Guard-owned Goal completion path when the current checklist has not passed. DSH internals can still bypass this path, so the plugin reports those cases rather than claiming to block every possible write.

## Status and compatibility

Version 0.5.1 supports **DSH >= 0.1.5-rc.1** with Cordis `4.0.2`, and has no backward compatibility: the previous Session API, the V2 event vocabulary, and every older host package set were removed rather than kept behind a fallback. `0.1.5-rc.1` is the version this release was built and tested against, not a ceiling. If you are upgrading from DSH `0.1.2-rc.1`, **start a new session**: Guard does not migrate old logs, proposals or certificates, and it never deletes or reinterprets your old data.

The version range and the host check are separate. The range `>=0.1.5-rc.1` refuses anything older, including `0.1.4` and `0.1.5-alpha.9`. Whether a specific installed host actually works is decided by the exact 33-package DSH core graph: a graph that is not registered is reported as unverified, never as supported. Alpha and older RC sets stay recorded as historical identities only, so a runtime built from one of them is reported as unsupported instead of certified.

The registered host sets are **DSH `0.1.5-rc.1` and `0.1.5-rc.2`**, each with its own exact 33-package graph. Their identities come from published npm tarballs; mixed versions fail the host check. Registry identity and native acceptance are separate: use the annex for the exact Guard artifact, host version and platform to establish a native pass. See the [compatibility guide](docs/COMPATIBILITY.md) for version rules and host-lock provenance.

Restart is a separate capability. Current DSH does not supply independently verified bindings for market's loaded instance, so the Guard market restart adapter is unavailable. A requested restart remains pending; core protection and unrelated operations continue. Installing or applying a package on disk does not prove that a running process or UI has adopted it.

Upgrading the core lock requires fresh inspection and injection from the actual runtime and profile. Old certificates are not relabelled as evidence for the new lock. See the [upgrade guide](docs/HOST_LOCK_UPGRADE.md) and [compatibility guide](docs/COMPATIBILITY.md).

Choose a published version from [npm](https://www.npmjs.com/package/dsh-completion-guard) and verify its commit, checksum and native annexes on the [GitHub Release](https://github.com/GreenLv/dsh-completion-guard/releases/latest). The historical 0.4.2 release targets DSH `0.1.2-rc.1` with market 1.41 and does not contain this decoupling. A source version, CI, same-byte native acceptance and publication are separate states; see [acceptance scope](docs/LOCAL_ACCEPTANCE.md).

The project was renamed from `dsh-context-guard` on 2026-08-29; its internal bundle id is still `context-guard`. Migration preserves sessions, activation and disabled settings. Do not load both package names in one profile. Node.js `>=22` and pnpm `>=11` are required.

## Activation modes

Context Guard has two activation modes:

- `opt-in` (default): protection is off when a session starts. Run `/context-guard on` in that session to turn it on, and `/context-guard off` to turn it off again. This changes only the current session.
- `always`: DSH sessions are protected automatically from the first real message. A brand-new session stays completely empty — the Guard writes nothing into it — so you can still pick the DSH session mode (standard, minimal, or a custom preset) before sending anything. The moment your first real message enters a step, protection begins in that same step and ahead of your message: the first task, including its first file changes, is covered. A first message that only carries an image or an attachment starts protection too and leaves an unresolved asset item until its meaning is clarified; a blank message starts nothing. Running `/context-guard off` turns protection off for that session until you run `on` again.

These modes only control Guard protection. They are not the DSH session mode (for example, the standard or minimal mode) that a session starts with. Because the Guard no longer writes into sessions before the first message, a session's DSH mode can be selected while the session is still new. `/context-guard on` and `/context-guard off` turn Guard protection on or off; they never change the DSH session mode.

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

Once enabled, the Guard saves direct user requirements and acceptance checks. A saved tool result counts only when it matches the requested command, file, or other target. A machine-certified completion requires the Guard's checkpoint; missing, stale, or mismatched evidence leaves the task uncertified. Investigations and explanations outside the supported evidence rules can still end with an honest answer, without a completion certificate.

Read-only evidence collection and actions that change packages, files, services, or Git state use separate tools. A successful lookup never grants permission to make a change. Exact command limits and platform evidence are documented in [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md).

### When a requirement stays incomplete

“Update the plugin and check the GUI” can contain work the Guard cannot certify, and questions such as “是否有更新” are inquiries: they stay recorded with their source, but no checkpoint or rebind can machine-certify an answer — complete the investigation and report the result. The checkpoint reports a reason and one concrete next action per item, and `context_guard_prepare` (read-only) shows, before a stateful action, the supported command shape, the required resolution/effect/state evidence order, and the exact missing target fields.

Use `context_guard_rebind` to propose an exact, complete split of the old text. If the action or target needs clarification, first ask the root user for an explicit instruction that includes the original clause; the proposal can reference that new item's ID. The tool returns a proposal ID and a comparison. The user applies it with the confirmation line `确认重绑定 <proposal ID>` as the first line of a reply; an explanation request or a new task after a blank line keeps its own meaning, and a new task is captured normally. A confirmation buried in a sentence, quotes, or a code block, or followed by a reversal, does nothing. Splitting a requirement into equally uncertifiable pieces returns “no certification gain” instead of asking for a pointless confirmation. Unsupported parts remain pending, and a qualified safe end does not mean all work is complete.

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
