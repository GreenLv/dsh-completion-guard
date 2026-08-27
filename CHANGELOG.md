# Changelog

All notable changes to this project are documented here. The project is pre-1.0; release versions track the plugin lifecycle, not stabilised API promises.

## 0.2.0 - Unreleased

### Added

- **Cwd-attributed subject resolution (F1).** Evidence artifact subjects are resolved against the call `workdir`; when the shell tool carries none (the macOS persistent bash/pwsh tools expose only `command`), the session scope cwd is used as the default. Relative `read`/`write`/`edit`/shell paths now match the contract subject derived from the same cwd, and a pathless `run` of a whitelisted executable is attributed to that cwd. This closes the macOS dead-end where a scope contract could never be satisfied, without lowering any fail-closed boundary.
- **Certifiable command-surface growth (F2).** `N>&M` diagnostic stream duplication (`2>&1`) is accepted in the POSIX shell and stripped unquoted in PowerShell; read-only inspection tools (`grep`, `rg`, `head`, `tail`, `wc`, `sed` without in-place flags) produce read effects in the POSIX shell; PowerShell accepts whitelisted external executables (`git`, `pnpm`, `npm`, `node`, `python`, `tsc`, `vitest`, `pytest`, `dsh`, …) with all-literal arguments, mirroring the POSIX run-executable set (which includes `dsh` for plugin-market CLI runs). Compound syntax, file-target fd redirects, in-place `sed`, variables and non-whitelisted executables remain fail-closed.
- **Process-verb contract mapping (F3).** Task-level actions — 拉取/获取/同步/更新/下载/安装/部署/上传/提交/推送/发布/升级 and `pull`/`fetch`/`clone`/`sync`/`update`/`install`/`deploy`/`commit`/`push`/`release`/`download`/`upload` — now map captured clauses to the `run` operation, so a successful run in scope closes them (previously an operation-less clause defaulted to the state-verification facet and could not be closed by the work evidence itself).

### Changed

- `parseShellCommand`/`parsePwshCommand` keep the same fail-closed philosophy: an unrecognized or partially understood command still yields EMPTY executables and operations.

## 0.1.2 - 2026-08-27

### Fixed

- The clean-success contract now covers the persistent shell renderers' full terminal vocabulary. `[shell exited: code N]`, `[shell killed by signal: S]`, `[shell exited]`, and the persistent timeout report (`Your command timed out after N seconds or experienced an OOM error. Below is partial output:`) are recognised as terminal facts even when followed by their prose reset line (`The persistent bash shell was reset; ...`), so those results can no longer certify as clean success. A clean result that merely echoes the reset prose remains a clean success, and the 0.1.1 session-renderer markers are unchanged.

## 0.1.1 - 2026-08-27

### Fixed

- Completed foreground `bash` results from the pinned DSH renderer now count as successful evidence when no error, timeout, sandbox denial, signal, interruption, or non-zero exit marker is present. Background execution and the unverified generic `shell` alias remain fail-closed, and unsupported command syntax still cannot certify a contract.

## 0.1.0 - 2026-08-27

Initial task-contract and completion-certification plugin for DeepSeek Harness.

### Added

- Contract capture from direct human messages (requirement / acceptance / prohibition), each with a concrete verification subject and surface.
- Bounded evidence derived only from persisted `tool/call` + `tool/result` pairs (capability, subject, surface, bounded summary hash).
- Fail-closed completion certification: empty evidence bindings, missing or stale evidence, and unrelated evidence are rejected.
- Goal-completion gate (`update_goal complete` requires a current certificate while enabled) and turn-stopping gate with a continuation-attempt cap.
- Recovery packet injection after compaction or resume.

### Changed

- Initial enablement comes from the effective `activation` configuration; all later persisted Guard state is derived from native DSH session events (`command/run`, `user/message`, `tool/call`, `tool/result`). Context Guard no longer appends custom `context-guard/*` event types, which the current persistence layer would refuse to reload — resuming a guarded session no longer depends on an upstream event-registration seam.
- Capture sanitizes credentials, bearer tokens, and URL query strings before persisting normalized clause text, matching the privacy contract.
- Exit-code evidence uses the last recorded marker, so an echoed fake `[exit code: 0]` can no longer mask a real trailing failure; echoed or backgrounded check commands no longer count as deterministic verification.
- Replay re-verifies certificates: certification is recomputed from the re-derived evidence, and a certificate that no longer re-derives marks the projection `corrupt` (fail closed).

### Fixed

- Two captured requirements in one scan no longer collide on the same identifier and revision; identical re-statements supersede the earlier capture under a new revision.
- The Goal-completion gate no longer fires while the guard is disabled.
- Bare completion confirmations (`Done.`, `搞定了。`) now trigger the gate, and step-level claims followed by continuation intent are no longer treated as whole-task completion.
- Code-mode dispatch roots are carried through evidence instead of being pinned to the inner call id.

### Release materials

- Full Apache-2.0 license text, CI workflow, and this changelog; the npm package now includes `docs/`.
