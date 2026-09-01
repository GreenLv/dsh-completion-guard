# Changelog

All notable changes to this project are documented here. The project is pre-1.0; release versions track the plugin lifecycle, not stabilised API promises.

## 0.3.2 - Unreleased (source candidate)

### Added

- **Two exact DSH setups are recognized.** The `0.1.1-rc.2` + dshmarket `1.36.0` and `0.1.2-alpha.2` + dshmarket `1.38.1` package sets are both checked on macOS and Windows.
- **The whole package set must match.** Every required package must appear once with the expected version and integrity. Missing, mixed, duplicate, unidentified, or unknown packages make the entire host unavailable instead of leaving part of the Guard enabled. Status now lists missing packages, and switching setups invalidates earlier completion certificates.

### Changed

- Peer dependencies accept only the two checked version sets (`0.1.1-rc.2 || 0.1.2-alpha.2`, Cordis `4.0.1 || 4.0.2`). A source comparison found no change in the DSH events, Goal calls, tool definitions, or terminal results that the Guard uses.

### Fixed

- **Release packaging now works with Windows tar.** Archive extraction uses paths relative to the temporary working directory instead of passing absolute archive paths, without changing the files placed in the package.

### Validation

- The complete 20-file suite passes 359 tests with one Windows-only skip on macOS. Native Windows matched all 34 alpha.2 package rows with no missing, extra, or duplicate entries. The packaging portability fix at `a3e77de` passed the six-job Ubuntu, macOS, and Windows CI matrix on Node.js 22 and 24.
- Still pending: a clean committed candidate containing the Windows registration and final documentation, isolated Web and Headless installation, native macOS and Windows checks of those exact package bytes, final candidate CI, tag, npm publication, GitHub Release, and public readback.

## 0.3.1 - 2026-08-31

### Fixed

- **Frozen npm artifacts now carry their exact source commit.** The release packer stages the npm file set, injects the full 40-character Git HEAD into the staged package manifest, packs twice, and fails unless both tgz files are byte-identical. It also emits a SHA-256 checksum and a machine-readable artifact record before any registry mutation.
- **The incomplete 0.3.0 publication is not promoted as a complete release.** Its npm artifact remains installable and passed native same-byte validation, but the registry omitted `gitHead`; no GitHub Release is created for `v0.3.0`. Version 0.3.1 supersedes that consumed version without moving its tag or attempting to reuse its npm identity.

### Validation

- The frozen 0.3.1 package passed native macOS and Windows lifecycle checks, was published to npm, and has a matching GitHub Release. Exact artifact and public readback evidence is recorded in [`docs/LOCAL_ACCEPTANCE.md`](docs/LOCAL_ACCEPTANCE.md).

## 0.3.0 - 2026-08-31

### Added

- **High-impact changes must match the user's exact request.** Package, file, service, and Git operations are tied to one target and an expected result. A generic successful command cannot certify a different action.
- **Changes require independent readback.** Install, apply, file editing, restart, Git, and publish operations must show both the intended effect and the resulting saved state before they can close a requirement.
- **Read-only checks and mutations use separate tools.** Looking up a target never grants permission to change it. Mutations require a current, matching root-user instruction; prohibitions and acceptance checks cannot provide that authority.
- **Bilingual npm download history.** A daily cumulative chart keeps the renamed `dsh-context-guard` and current `dsh-completion-guard` package totals separate while presenting one project-growth line. Collection reconciles npm range and point responses before publishing English and Simplified Chinese SVGs.

### Fixed

- Assistant wording no longer controls whether DSH continues a task. Only a saved wait or deferral state can end the current round without claiming completion.
- Missing, unknown, or changed DSH package identities keep the affected Guard capabilities unavailable. Direct internal Goal or session writes are reported as integrity problems but are not claimed to be preventable.
- Host-lock injection is repeatable, folded YAML integrity values are read correctly, and a fresh empty profile can be updated safely.
- Package publishing and file edits bind the expected destination before making a change and reject changed input or different resulting bytes.
- Windows actions pin both the command wrapper and the system command interpreter, then reuse those checked paths instead of searching again at execution time.
- The npm statistics publisher now rejects non-default refs before checkout, isolates read-only collection from the write-capable publication job, does not persist credentials during collection, and pins all official Actions to immutable commits.

### Changed

- **Package renamed from `dsh-context-guard` to `dsh-completion-guard`.** An unrelated DSH plugin already uses the old name. The internal Cordis bundle id stays `context-guard`, so installed profiles keep their runtime identity; all published versions of the previous npm package are deprecated and point readers to the new package.

### Validation

- Runtime source commit `4f079499509822425c80e0b5ab98d1ebc58da9d5` passed the 19-file deterministic suite on macOS (351 passed, one Windows-only capability skip) and native Windows (352 passed, no skips), including all 37 portable semantic cases and 29 digest vectors.
- Canonical pre-release artifact `72d848e313a0e35e06fd1f493215cc0338b86a79a8001a4f07156e782157fe08` from commit `a33b69326eb46fbefc56affc55e2a486695f545c` passed same-byte isolated Web/Headless installation, host-lock readback, real dshmarket restart, HTTP recovery, and cleanup on macOS and native Windows. CI run 33320743166 passed the exact commit on Ubuntu, macOS, and Windows with Node.js 22 and 24.
- A credentialed model session produced a valid evidence binding and exercised persisted typed-boundary acceptance plus same-Goal disarm readback. An intentionally over-broad prompt remained incomplete and received no false completion certificate; this bounded result is not a claim that arbitrary model instructions are semantically certifiable.
- The npm statistics suite passes 8 focused tests covering date chunking, response normalization and reconciliation, scoped package URLs, upstream failures, and preservation of the previous output set. Release packaging freezes one documentation-inclusive tarball for native-platform verification and registry publication; published checksums and registry integrity identify those exact bytes.

## 0.2.1 - 2026-08-28

### Fixed

- **Clarifications and session talk no longer pollute the contract.** Bare progression phrases (`继续`, `continue`), meta questions (`这个收尾具体要做什么`, `是不是bug`), and meta comments/objections are classified as session-layer talk and never become contract items — including as clauses inside otherwise actionable messages. Real instructions, prohibitions, and task titles are captured exactly as before; the classifier fails closed on uncertain phrasing.
- **Rejected checkpoints no longer re-inject the same recovery packet.** Recovery injection is content-deduplicated through a digest bound to the packet content, contract revision, and epoch. Resume, compaction, enablement transitions, new evidence, or a new contract revision still always re-remind.

### Added

- **`/context-guard clear`.** Supersedes every pending requirement and acceptance under a `CLEAR:<revision>` sentinel (prohibitions are retained) and bumps the contract revision, so an empty-binding checkpoint can certify and Goal completion can proceed while the guard stays enabled. The command is replayed from the log like all other state.

### Changed

- The Goal-completion gate is unchanged (no current certificate, no completion) and is now documented with its explicit remediation routes: `/context-guard off` after the user confirms completion, `/context-guard clear`, or a truthful `update_goal(action=blocked)`.

See [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) for the supported grammar and [`docs/LOCAL_ACCEPTANCE.md`](docs/LOCAL_ACCEPTANCE.md) for release evidence and platform limits.

## 0.2.0 - 2026-08-28

### Added

- **Cwd-aware evidence.** When a shell tool omits `workdir`, evidence is attributed to the session cwd, so relative file operations and pathless checks can satisfy a contract for the repository where they ran.
- **More useful checks without widening trust.** Literal `2>&1`, selected read-only inspection commands, and whitelisted PowerShell executables can now produce certifiable evidence. Compound commands, variables, file-target redirects, in-place `sed`, and non-whitelisted executables remain unsupported.
- **Process actions and diagnostics are certifiable.** Actions such as pull, install, commit, push, publish, and restart map to run evidence; deterministic `python -m unittest`, `doctest`, and `pytest` checks are recognized. Rejected checkpoint bindings now include actionable hints, and structured exit metadata is honored when DSH provides it.
- **Long sessions are easier to recover.** Informational receipts no longer become accidental tasks, `--help` is treated as inspection rather than a passing check, and oversized recovery packets fold safely while exposing evidence `outcome` and `capabilities`.

### Changed

- The command surface is defined and validated from one shipped manifest, with regression coverage for real compound shell workflows. Parsing remains fail-closed: unsupported or partially understood syntax produces no certifiable executable or operation.

See [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) for the supported grammar and [`docs/LOCAL_ACCEPTANCE.md`](docs/LOCAL_ACCEPTANCE.md) for release evidence and platform limits.

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
