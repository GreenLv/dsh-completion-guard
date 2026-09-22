# dsh-completion-guard

[简体中文](README.zh-CN.md)

An add-on for DeepSeek Harness (DSH) that keeps a task's requirements and checks them before the task is marked complete. It restores the same checklist after a resumed session and accepts only matching saved tool results as evidence.

> **0.7.1 release line (2026-09-22).** Verify the [published Releases](https://github.com/GreenLv/dsh-completion-guard/releases) and [npm version](https://www.npmjs.com/package/dsh-completion-guard) before installation. This release line’s shared core/v2 source mirror is pinned to an exact Codex Context Guard commit; the two products have separate runtimes and release identities. See [compatibility](docs/COMPATIBILITY.md) and [acceptance record](docs/LOCAL_ACCEPTANCE.md) for its verified scope and open gates.

![Task-contract clauses and bounded evidence pass through a checkpoint before a completion certificate is issued](assets/social/completion-guard-hero.png)

## Quick start

After confirming that npm serves `0.7.1` and the GitHub Release identifies the same accepted artifact and platform annexes, install this version:

```sh
dsh plugin --profile web add dsh-completion-guard@0.7.1
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

On Windows, run the same three subcommands through `dsh-completion-guard-host-lock.cmd` in the Web settings directory's `node_modules\.bin` directory and use Windows absolute paths. Native acceptance and publication evidence is recorded per version, bound to that version's exact bytes, in the [acceptance record](docs/LOCAL_ACCEPTANCE.md); a version's source and deterministic evidence never substitutes for its own installed-artifact claim. Other host versions and artifacts need their own native evidence. Repeat this check after changing DSH, Guard or the profile location; an ordinary market-only update does not require reinjection. The Guard stays unavailable if the active package set is missing, mixed, duplicated, or different from a checked setup.

Restart DSH Web, open a session, and enable the Guard:

```text
/context-guard on
/context-guard status
```

Activation is opt-in by default. `status` shows whether the Guard is on, its startup phase (`armed` means waiting for your first message), the active policy tier, how many checks remain, and a summary of why the rest are open. `off` stops protection for the current session without deleting its history. `clear` closes the current checklist while keeping prohibitions. `diagnose` explains why a completion check passed or failed. `migration` reports which rule set the session is under and what an upgrade or rollback would mean. `release` reports an explicitly adopted release contract, its coverage, and anything in flight.

### Ordinary work in 0.7.1

Ask DSH to edit a file or run a test as usual. The assistant performs that work with the DSH host tools. Guard records the request, observes the host's persisted call and result, and checks independent readback when the requested outcome needs it. For example, after a host edit changes a configuration file, a separate exact file read can establish the new bytes; a named test needs its own observed result. A successful tool return or the assistant's claim alone does not prove an unrelated condition or a forbidden-file constraint. `context_guard_prepare` explains what evidence is missing, and `context_guard_checkpoint` checks only the predicate that evidence establishes.

The ordinary `context_guard_action` and `context_guard_evidence` tools from 0.6.x no longer perform edits, tests, or Git effects; they return migration guidance. A new file still needs trustworthy evidence that it was absent before creation. A package-script readiness observation can identify an existing test or assessment input without forcing another edit, but it does not prove the script ran or certify arbitrary numeric output. A later request to observe long-term benefits remains future work until its own time or approval condition is met; a short “continue” advances only a concrete ready action.

## What it protects

- Saves requirements, acceptance checks, prohibitions, and later corrections without overwriting history.
- Uses only tool calls and results that DSH has saved, and stores a redacted summary rather than full output.
- Accepts evidence only when the action and result match the requested command, file, or other target.
- Rechecks completion after a session is rebuilt or resumed, and refuses to certify damaged state.
- Stops the Guard-owned Goal completion path when the current checklist has not passed. DSH internals can still bypass this path, so the plugin reports those cases rather than claiming to block every possible write.

## Status and compatibility

Version 0.7.1 retains support for exactly **DSH `0.1.5-rc.2` or `0.1.5-rc.1`** with Cordis `4.0.2`. These are the latest registered release and the verified minimum. The previous Session API, V2 event vocabulary, and every older host package set remain removed. If you are upgrading from DSH `0.1.2-rc.1`, **start a new session**: Guard does not migrate old logs, proposals or certificates, and it never deletes or reinterprets your old data.

Package discovery and npm metadata use the same newest-first exact union, `0.1.5-rc.2 || 0.1.5-rc.1`. Older versions, unregistered stable `0.1.5`, and future versions are not advertised as supported. Every admitted version must still match its complete 33-package DSH core graph; missing, mixed, or unknown graphs fail closed.

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

Read-only observation and actions that change packages, files, services, or Git state remain separate. In 0.7.1, ordinary actions use Host tools; a successful lookup never grants permission to make a change. Exact command limits and platform evidence are documented in [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md).

### When a requirement stays incomplete

“Update the plugin and check the GUI” can contain work the Guard cannot certify, and questions such as “是否有更新” are inquiries: they stay recorded with their source, but no checkpoint or rebind can machine-certify an answer — complete the investigation and report the result. The checkpoint reports a reason and one concrete next action per item. In 0.7.1, `context_guard_prepare` diagnoses the requirement and missing evidence; it is not an execution recipe for ordinary Host work.

Only use `context_guard_rebind` when the root requirement itself needs an exact, complete split. Ordinary work that lacks certification support does not need rebinding. If the action or target needs clarification, first ask the root user for an explicit instruction that includes the original clause; the proposal can reference that new item's ID. The tool returns a proposal ID and a comparison. The user applies it with the confirmation line `确认重绑定 <proposal ID>` as the first line of a reply; an explanation request or a new task after a blank line keeps its own meaning, and a new task is captured normally. A confirmation buried in a sentence, quotes, or a code block, or followed by a reversal, does nothing. Splitting a requirement into equally uncertifiable pieces returns “no certification gain” instead of asking for a pointless confirmation. Unsupported parts remain pending, and a qualified safe end does not mean all work is complete.

The default `context_guard_checkpoint` call uses `bindings: []` for diagnosis. It shows at most eight current items/constraints and ten evidence rows, within 12 KiB of plugin JSON. `pagination` reports totals and a separate `next_cursor` for each list; the first page is not the whole contract. Use `item_ids` or `evidence_ids` to focus a query, or `evidence_scope: "history"` for the complete evidence history, including rows marked unavailable. Keep the query unchanged when following a cursor; a changed contract or evidence snapshot requires a fresh query. Large rows expose `detail_id`; retrieve chunks with `detail_offset` and return the first response's `snapshot` as `detail_snapshot` on later chunks. All queries remain read-only and never shrink the certification set.

## Completion and recovery in 0.7.1

The Guard keeps each requirement, prohibition and answer obligation in its original scope. A question closes when the host records delivery of its answer; a file edit, test or readback needs its own observed result. A request to change an image needs evidence about the changed image, not just a successful tool return. An explicit proof request still uses the proof contract, and an adopted Goal-completion path still checks its required results.

The source of an action matters. A future observation, an unmet time or approval condition, insufficient evidence and a concrete ready action remain different states. A later authorization never changes an earlier Stop decision. A sourced pause, cancellation or short resume changes only the work that existed in its scope; quoted or old generic text does not become current authority on reload. Existing v5 history remains available for review, while new v6 work uses the current contract.

If an obligation is ambiguous, `context_guard_rebind` can propose an exact split, but only an explicit root-user confirmation applies it. Unsupported verification is reported as insufficient; it does not grant an action or force an edit. Use `/context-guard diagnose` and the read-only checkpoint to see the missing predicate, then complete supported work with host tools and report limitations honestly.

The 0.6.3 execution-era behavior is retained in the [0.6.3 changelog](CHANGELOG.md#063---2026-09-18) for existing installations. On 0.7.1, ordinary `context_guard_action` and `context_guard_evidence` calls only return migration guidance.

## Policy tiers

Three tiers change how much proof is required at completion. They are separate from the `opt-in` / `always` activation modes, and installing never enters the release tier.

| Tier | What it demands |
| --- | --- |
| `standard` (default) | Work must be supported by durable evidence; ordinary tools are not gated behind extra Guard approval. |
| `strict` | On top of standard, a visual or complete-scope verification you explicitly asked for must be discharged by a real readback fact, not by a tool that merely succeeded. |
| `release` | An explicitly adopted release contract checks the covered publication operation against an exact candidate and one-use reservation. The contract does not supply user authorization or host permission. |

Set the tier in the same `cordis.patch.yml` entry as `activation`:

```yaml
- id: context-guard
  name: dsh-completion-guard
  config:
    activation: always
    policy: strict
```

### Explicit release contracts

A release contract is never adopted by a keyword, loaded Skill or installation. When the user has separately authorized publication, an explicit `/context-guard release adopt` call names the covered operations and exact candidate ref, full commit, version and artifact digest. `/context-guard release` then shows its coverage and any unfinished operation. Do not reuse a historical candidate identity for a new release.

After adoption, `/context-guard release` reports the contract, its candidate, its
per-operation coverage, what has been consumed, and anything still in flight.
Each operation spends exactly one reservation, written before the effect and
settled afterwards from a trusted readback. A wrong candidate SHA, ref, artifact
digest or version, an expired ticket, a consumed ticket, a retry of a request
that is still in flight, and an opaque runner are all refused before any effect.

The retained controlled npm publication route is separate from the retired ordinary action/evidence path. Coverage is limited to operations Guard actually routes. `git tag` and GitHub Release have no Guard-owned route; a contract requiring them reports `release_operation_unrouted` rather than pretending that a host command was protected. A composite runner is opaque. `/context-guard release` reports the exact coverage. Publication still needs the user's authorization and host checks; Guard cannot control an in-process caller that bypasses its route.

## Boundaries

Context Guard certifies completion; DSH still owns Goal, Todo, Compaction, continuation, permissions, and tool execution. This plugin is not a security sandbox, semantic proof system, token-pruning tool, or replacement for those DSH facilities.

Evidence is bounded and redacted. Complete prompts, stdout, file contents, credentials, Authorization headers, URL query values, image bytes, and raw transcripts are not stored by the guard. See [`docs/PRIVACY.md`](docs/PRIVACY.md).

## Relationship to Codex Context Guard

This project began as a DSH port of deterministic behavior from [`GreenLv/codex-context-guard`](https://github.com/GreenLv/codex-context-guard) v0.8.8. That version is the historical starting point, not the current compatibility level.

Version 0.4.0 was deliberately aligned with the shared evidence rules in Codex Context Guard 0.10.0: proof must belong to work that is still open and must show the operation, target, and result the user actually requested. This is a limited behavior-level alignment, not a claim that the two products have the same features.

For 0.7.1, the shared core/v2 source files and conformance fixtures are byte-mirrored from the exact Codex Context Guard commit in `tests/fixtures/conformance/core_v2/UPSTREAM_PIN.json`. This proves source identity for those files, not complete feature or runtime parity; each product's host evidence and release remain independent. The earlier 0.6.x C01–C12 contract and DSH-authored v2 candidate are historical. The current comparison and its limits are in [`docs/SEMANTIC_COMPATIBILITY.md`](docs/SEMANTIC_COMPATIBILITY.md).

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
