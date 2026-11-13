# Changelog

[简体中文](CHANGELOG.zh-CN.md)

Each entry describes what changed in that version and what users needed to do when upgrading. See [installation and first load](docs/GETTING_STARTED.md) for current instructions and [acceptance records](docs/LOCAL_ACCEPTANCE.md) for version-specific checks.

<details>
<summary>Version index</summary>

[0.13.1](#0131) · [0.13.0](#0130) · [0.12.1](#0121) · [0.12.0](#0120) · [0.11.0](#0110) · [0.10.0](#0100) · [0.9.0](#090) · [0.8.4](#084) · [0.8.3](#083) · [0.8.2](#082) · [0.8.1](#081) · [0.8.0](#080) · [0.7.1](#071---2026-09-22) · [0.7.0](#070---2026-09-21) · [0.6.3](#063---2026-09-18) · [0.6.2](#062---2026-09-16) · [0.6.1](#061-2026-09-15) · [0.6.0](#060---2026-09-14) · [0.5.3](#053---2026-09-14) · [0.5.2](#052---2026-09-11) · [0.5.1](#051---2026-09-10) · [0.5.0](#050---2026-09-10) · [0.4.3](#043---2026-09-08) · [0.4.2](#042---2026-09-07) · [0.4.1-rc.1](#041-rc1---2026-09-04) · [0.4.0](#040---2026-09-02) · [0.3.2](#032---2026-09-01) · [0.3.1](#031---2026-08-31) · [0.3.0](#030---2026-08-31) · [0.2.1](#021---2026-08-28) · [0.2.0](#020---2026-08-28) · [0.1.2](#012---2026-08-27) · [0.1.1](#011---2026-08-27) · [0.1.0](#010---2026-08-27)

</details>

## 0.13.1

Guard adapts to DSH `0.2.2-rc.2` and raises the minimum DSH version to `0.2.2-rc.2`. The `0.2.2-rc.1` host is now below the admission floor: upgrade DSH first, then install this Guard version. Sessions, modes and evidence recorded by earlier Guard versions remain migratable under the existing contract.

- **Upgrade DSH first.** The minimum versions are DSH `0.2.2-rc.2`, Node.js `24.9.0` and Cordis `4.1.0`. Every `0.2.2-rc.1` and `0.2.1` host refuses at the version gate. Later versions still need to pass the host checks. [Compatibility](docs/COMPATIBILITY.md#0131-dsh-022-rc2) explains which host and Desktop packages were reviewed.
- **Use complete, saved tool results.** Guard reads every event in a committed session batch and waits for the host to confirm the full batch is saved before accepting its evidence. It also reads rc.2 error codes for denied tools, working-directory access failures and background jobs, so those failures cannot prove that a required action succeeded. Regressions exercise these paths through the installed SDK.
- **Reviewed host graph.** The default audited cohort is `dsh-0.2.2-rc.2-core-v1`: the same 51 audited packages at rc.2 versions (Cordis stays at 4.1.0), with every tarball re-verified against the registry. The rc.2 macOS arm64 Desktop build was verified against the official update feed (vendor signature and signed ASAR header match); the Windows rc.2 Desktop distribution identity row is registered from the acquired official installer and signed carrier (the official feed itself still served the previous build at acquisition time); native acceptance is recorded separately for the exact source commit and package.
- **Known dependency risks.** The rc.2 host packages carry Zod 4.6.6; Undici stays at 8.11.2. The three temporary Undici exceptions include this version by direct maintainer authorization (2026-11-13) with the expiry unchanged: **2026-11-30**. No other risk is accepted, and the affected host code still carries the disclosed risks, including a possible TLS 1.2 process crash. See the [dependency advisories](docs/DEPENDENCY_SCAN.md).

- **Keep evidence with the current request.** When a task resumes and repeats the same request, a superseded request no longer consumes the newer test result or file observation. Earlier requirements and their evidence remain in history; an interrupted call still cannot count as a successful result.

The [acceptance record](docs/LOCAL_ACCEPTANCE.md) separates the reviewed host identities and CI from platform runs on the exact package.
## 0.13.0

Guard works with DSH's new tool execution and session interfaces in `0.2.2-rc.1`. It checks each tool step in a batch and waits for the host to finish recording the results before using them as evidence.

- **Upgrade DSH and Node.js first.** The minimum versions are DSH `0.2.2-rc.1`, Node.js `24.9.0` and Cordis `4.1.0`. Earlier DSH versions, including `0.2.1`, are below the minimum. Later versions still need to pass the host checks. [Compatibility](docs/COMPATIBILITY.md#0130-dsh-022-rc1) explains which host and Desktop packages were reviewed.
- **Keep existing session modes.** The migration tool now accepts verified `0.12.x` installations as a source. Stop the processes writing session data and save the old package, mode sources and session inventory before replacing DSH or Guard. Rebuild and verify the host lock, then adopt and verify the old modes before restarting. Follow the [installation guide](docs/GETTING_STARTED.md) and [migration guide](docs/ACTIVATION_MIGRATION.md).
- **Known dependency risks.** DSH still ships Undici 8.11.2 and Zod 4.4.3. The three temporary Undici exceptions for 0.13.0 expire after **2026-11-30**. The affected host code still carries the disclosed risks, including a possible TLS 1.2 process crash. See the [dependency advisories](docs/DEPENDENCY_SCAN.md).

The [acceptance record](docs/LOCAL_ACCEPTANCE.md) separates the reviewed host identities and CI from platform runs on the exact package.

[Original detailed entry](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.md#0130).

## 0.12.1

When an old session has several saved log files, migration now verifies every retained generation. A damaged older log blocks migration even if the newest one opens.

- The migration tool uses DSH's read-only reader to check session identity and where a fork inherits its history. It preserves the original paths and files. The reviewed backends support both plain JSONL and zstd.
- This release kept DSH `0.2.1-rc.3` as the minimum, with rc.5 and Cordis 4.0.5 as the reviewed defaults. The three disclosed Undici risks stayed present and were accepted for this release through **2026-11-30**. See the [migration guide](docs/ACTIVATION_MIGRATION.md) and [dependency advisories](docs/DEPENDENCY_SCAN.md).

[Original detailed entry](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.md#0121).

## 0.12.0

A filename such as `verify.pdf` no longer creates a verification task on its own. Guard still reads instructions next to complete filenames, paths and link destinations.

- **Migration checks the files on disk.** The tool compares the official session list with the physical logs in the supplied directory, so hidden sessions and unreadable layouts can stop the upgrade. Check that this is the directory DSH actually uses. Regenerate older receipts that lack the inventory proof. The tool now accepts verified `0.11.x` installations. See the [migration guide](docs/ACTIVATION_MIGRATION.md).
- **DSH rc.5 became the reviewed default.** This release still accepts qualified hosts from `0.2.1-rc.3`. The rc.5 audit found the same executable bytes across the 47 packages Guard uses. The official Desktop distributions were checked separately on macOS arm64 and Windows x64. [Compatibility](docs/COMPATIBILITY.md#0120-dsh-021-rc3) describes the scope of those checks.
- **Known dependency risks.** The reviewed DSH hosts still ship the affected Undici and Zod versions. The three temporary Undici exceptions for this release ran through **2026-11-30**. See the [dependency advisories](docs/DEPENDENCY_SCAN.md).

Maintainers can recover a missing transfer receipt from a saved run. Failed or interrupted setup preserves the test environment for cleanup diagnosis. CI selects platform test depth from the files changed, and the native Web and Headless checks can exercise a route change while the host is running.

[Original detailed entry](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.md#0120).

## 0.11.0

Guard tightened checks around package publication and file access. It also fixed several errors in how it reads a session's current directory, configuration and instructions.

- **Publication checks use the same package identity throughout.** Guard rejects tarballs with ambiguous manifests or unsupported entries and checks the complete file before authorizing publication. It also limits how long it will wait and how much it will read when checking npm afterward. An uncertain readback leaves the original attempt open for reconciliation.
- **Relative paths use the directory of the original call.** Guard protects its private storage even when Bash or PowerShell uses an explicit working directory. Later directory changes cannot move an earlier file check to a different file. URL credentials and documented GitHub token formats are redacted before storage.
- **Session and configuration fixes.** “请分别执行” no longer becomes a false prohibition. Ordinary forks are treated as independent sessions. An interrupted write to one session's index entry leaves completed entries readable. Host-lock injection preserves existing entries in JSON-shaped patch files, and long configuration dumps reach pipes in full.
- **Upgrade to DSH `0.2.1-rc.3` or later for this release.** The migration tool understands rc.3's persistence interface and accepts verified `0.10.x` installations. See [host compatibility](docs/COMPATIBILITY.md#0110-dsh-021-rc3-historical-for-this-release) and the [migration guide](docs/ACTIVATION_MIGRATION.md).
- **Dependency advisory checks became required in CI.** Unaccepted high or critical advisories block the gate. A scan failure also blocks it. This release had three temporary Undici exceptions through **2026-11-05**. See the [dependency advisories](docs/DEPENDENCY_SCAN.md).

[Original detailed entry](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.md#0110).

## 0.10.0

Switching working directories no longer changes which file or test an earlier result refers to. If the directory changes while a command is running and its result depends on that directory, Guard leaves the result unconfirmed.

- DSH can signal that a background job is done, failed or was stopped. Guard uses matching records for jobs owned by this session to resolve a wait. A job's status alone cannot verify cleanup or the result the user requested.
- Guard preserves experimental DSH `plugin:` records while ignoring them for task tracking. Receiving a Team inbox message or a subagent result does not complete the parent's task.
- **Upgrade to DSH `0.2.1-rc.2` or later for this release.** Preserve the old modes and settings, rebuild and verify each profile's host lock, and verify migrated modes before restarting. Migration now accepts verified `0.9.x` installations. The [compatibility record](docs/COMPATIBILITY.md#0100-dsh-021-rc2) also covers separate checks for files bundled with Desktop.

[Original detailed entry](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.md#0100).

## 0.9.0

New sessions start protection automatically with the first message or attachment when `activation` is left out. To keep manual activation, set `activation: opt-in`.

- **Keep old sessions on their original modes.** Stop session writers before upgrading and follow the [migration guide](docs/ACTIVATION_MIGRATION.md). It explains how to save the old modes, rebuild the host lock and verify the migration before startup. History and valid old certificates are preserved.
- **History can still take time to load.** Guard can reuse a completed check once it establishes that the history is unchanged and the result is safe to reuse. DSH still loads the history, so “载入历史” can appear even on a later visit.
- If the official reader refuses an old format, you can [migrate an explicitly selected set of readable sessions](docs/ACTIVATION_MIGRATION.md). Excluded sessions keep their original logs and stay pending. `selected_complete` covers only the selected sessions.

[Original detailed entry](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.md#090).

## 0.8.4

The official Desktop app can now load Guard alongside the official plugin market (`dshmarket`). Earlier versions could reject that profile as a conflict.

Installing or removing the market changes the Desktop profile. Rebuild its host lock with `inspect` and `inject`, generate a fresh configuration with `dump-desktop`, and check it with `verify-dump`. Guard's market and Desktop restart limits still apply. See [Desktop setup](docs/HOST_LOCK_UPGRADE.md#official-desktop-profile).

[Original detailed entry](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.md#084).

## 0.8.3

When a completion check has enough evidence for one item but the task still has work open, Guard now shows what remains. Invalid check parameters return a useful error instead of interrupting the turn.

- Guard reduces repeated parsing and host checks when processing a long session. It can reuse the saved view when the host's event history is provably unchanged. Loading time still depends on the history and host.
- A test must run in the directory the user asked for. A pass in its parent directory does not count. Failed, backgrounded or truncated Git results also leave commit or push unconfirmed.
- An interrupted private record write is easier to recover from. [Writer-lock instructions](docs/WRITER_LOCK_PROTOCOL.md) describe the controlled downgrade procedure.
- Desktop acceptance checks repeated installation in two steps. Installing Guard again by itself must leave the files byte-identical. With the multi-package test, only JSON object-key order may change in `.modules.yaml`. See the [acceptance record](docs/LOCAL_ACCEPTANCE.md).

[Original detailed entry](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.md#083).

## 0.8.2

The official Desktop app gets its own host lock. Guard verifies the signed app archive and the profile it actually loads. Desktop setup adds `dump-desktop` to check the composed configuration before booting. Web and Headless keep their own setup paths.

- **Upgrade to DSH `0.2.0-rc.2` or later for this release.** Rebuild and verify each profile's lock after upgrading. See [compatibility](docs/COMPATIBILITY.md#082090-dsh-020-rc2-and-official-desktop).
- If later output obscures a shell exit marker, or the marker is malformed, Guard leaves the result unconfirmed.

[Original detailed entry](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.md#082).

## 0.8.1

Guard reduces repeat host audits during session startup and replay. Checks that certify completion or allow publication still inspect the current host.

**Upgrade to DSH `0.2.0-rc.1` or later for this release.** Cordis must meet its separate `4.0.4` minimum and pass qualification. Rebuild and verify the host lock before restarting. This release adds a way to rebuild the lock for later compatible packages after checking the official archives and changed interfaces. See the [host-lock guide](docs/HOST_LOCK_UPGRADE.md).

[Original detailed entry](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.md#081).

## 0.8.0

Guard adapts to DSH `0.1.7-rc.2` and Cordis `4.0.4`. Upgrade DSH before installing this release and regenerate each profile's host lock before restarting.

- Completion guidance for Goals now points to specific file readbacks or foreground test results the plugin can verify.
- Incomplete shell output stays uncertified. Read-only discovery and completion queries can continue across pages when their own observations have left the task unchanged.
- The [source-stage record](https://github.com/GreenLv/dsh-completion-guard/blob/563f144bf8568793da5017b9ff71395a33dcd265/docs/DSH_0_1_7_RC2_ACCEPTANCE.md) covers development checks. Native checks belong to the corresponding release artifact.

[Original detailed entry](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.md#080).

## 0.7.1 - 2026-09-22

### Changes

- Recovery now reports the same current results as prepare and checkpoint. A completed test is not presented as missing evidence, and ordinary work is not sent through target clarification or rebinding merely because it cannot be certified.
- Recovery retains verifiable current prohibitions and unreleased user waits when current results are unavailable, prioritizes them in short messages, and reports omitted rows. Long boundaries link to read-only details that retain their full text; historical sibling tasks do not become current restrictions.
- Recovery preserves the dependency-free cleanup condition. A partial deletion or unknown dependency cannot be presented as complete cleanup. Contract updates are identified as updates instead of being mislabeled as compaction or resume.
- Prepare distinguishes a recorded wait from a currently applicable wait and checks the requested item revision even when the completion state is unknown. Prepare and checkpoint preserve a prohibition's meaning when its compliance state cannot be verified.

### Upgrade and limits

The supported DSH versions remain `0.1.5-rc.2 || 0.1.5-rc.1`. Restart DSH after updating the plugin. Existing history is retained; explicit proof, adopted Goal and release checks remain separate. Some combined natural-language wait clauses remain unrecognized, and this patch does not establish that a model will continue correctly after answering a side question during compaction. See the [acceptance record](docs/LOCAL_ACCEPTANCE.md) for source checks and exact-artifact evidence boundaries.

## 0.7.0 - 2026-09-21

### Highlights

- Ordinary edits, tests and Git operations use the host’s tools. Guard keeps the requirement, observes persisted results and exact readback, and certifies only the matching completed predicate.
- Stop distinguishes a ready current action from a future observation or insufficient evidence. A short resume can advance a ready action once; an older generic task or prose-derived wait is not promoted during recovery.
- Goal completion protection requires explicit `/context-guard on` adoption in new v6 sessions; a later failed required outcome prevents an older certificate from completing the current Goal. Adopted release contracts and explicit proof requirements retain their independent checks.

### Changes

- The core/v2 consumer mirrors the exact shared source and conformance files pinned to Codex Context Guard commit `cb415cbe374d452e4a0c71e9e292d20e31f23b0e`. The old v1 pin and v5 history stay intact; the mirror is a shared-source identity, not full product equivalence.
- Ordinary `context_guard_action` and `context_guard_evidence` calls now return migration guidance. DSH Host tools perform file, test and Git effects; read-only file, Git and package-script observations supply only facts needed for the named completion predicate. A ready input is not proof that the test ran or that a user-set time or approval condition has passed.
- A relative file request retains its root-time Session location; exact filesystem readback identifies the file. A real Host edit of a forbidden file remains a violation even when an allowed edit also succeeded. A trustworthy pre-effect absence is still required before claiming creation.
- Separate edits, tests, readbacks and delivered answers remain separate obligations. A short resume or cancellation changes only work in its sourced scope, while future observation and old generic entries cannot become current authority on reload. Default feedback reports an already satisfied ordinary result without asking for a legacy binding again.
- A present request to explain a future observation can close on its own trusted answer. Its source and condition remain attached across clause splitting and recovery; a quoted or conditional explanation does not become a new present instruction, and a separately requested test still needs its own result.
- Supported foreground `npm test` or `pnpm test` results can satisfy an ordinary run-and-report request after exact Host renderer and terminal checks. A request to make tests pass still needs a pass; other package-script numeric results and unknown exit status remain uncertified. Explicit proof, adopted Goal completion and applicable release contracts retain their own checks.
- Foreground renderer auditing now recognizes the official Windows DSH rc.2 hoisted package-map layout as well as pnpm's versioned layout. It still requires one reachable package, an exact supported version, a contained physical module and matching implementation bytes; this source fix does not itself establish Windows native acceptance.

- Host observation notices are delivered after the full tool-result batch, so they do not interrupt pending calls. Adopted release and restart control records use a separate private durable ledger; keep that ledger with its session when preserving state. Missing or damaged records leave protected operations unresolved instead of making a consumed operation available again.

### Validation

Candidate `583035bd90b8ee589d01b12487a057b655d43e41` passed the complete local deterministic matrix, candidate CI and 34 macOS native gates with cleanup on its exact clean-source tgz. That native run skipped real-model requests; Windows exact-artifact and complete model acceptance were not performed for those tgz bytes. These are historical results for those bytes once packaged documentation or source changes. Publication requires deterministic, CI, native-platform and model acceptance for the final exact tgz. Tag, npm package and GitHub Release publication follow that acceptance; public readback and daily installation are separate later steps; see the [acceptance record](docs/LOCAL_ACCEPTANCE.md).

## 0.6.3 - 2026-09-18

Guard checks which operation the user authorized and which target it applies to. Preparation and execution now agree on the required inputs and on which older records can still be used. See the [release and native reports](https://github.com/GreenLv/dsh-completion-guard/releases/tag/v0.6.3) and the [source checks](docs/LOCAL_ACCEPTANCE.md).

### Changes

- **Execution requires an independently recognized instruction.** Questions,
  explanations, reported or quoted commands cannot grant execution authority.
  Mixed requests whose action remains inside that scope stay unresolved and
  cannot be closed by an ordinary answer. Write an independent instruction as
  another sentence or semicolon-separated clause. Stored execution qualification
  is inherited without promotion and consumed by both prepare and execution.
  See the [contract revision](docs/CONTRACT_REVISION_0_6_3.md) for the intentional
  compatibility change.
- **The session working directory is no longer a target selection.** An
  obligation's target now carries its provenance: an explicit name or path, a
  phrase that selects the current repository, a trusted host selection, or a
  unique selection inherited from another obligation of the same work unit. A
  git action whose clause names no repository keeps that directory as
  environment context only, so it stays a target clarification instead of
  authorizing a mutation the root never chose. Several equally sourced
  candidates stay ambiguous; a different repository is still refused.
- **Preparation and execution answer the same compatibility question.**
  `context_guard_prepare` evaluates the current item, action, revision and
  target through the judgement the mutation gate enforces, reports
  `incompatible` with the item's own action when the assumption is not what the
  obligation records, and only ever returns a caller-named recipe labelled
  `recipe_only`. A caller-supplied target that differs from the item's is
  reported as a proposal, not as authority.
- **Records captured under earlier rules are not inherited as passes.** An
  upgrade eligibility check runs before any terminal filtering and covers
  records the open-closure computation skips, including ones already
  `answered`. A record whose own text still orders work, or whose git target has
  no auditable source, is marked `needs_review`: its historical status is
  preserved, nothing is re-executed, and the record blocks new certificates and
  Goal completion instead of producing a warning. Unknown state versions are
  reported rather than assumed compatible.
- Codex alignment is restated honestly. A new recording executes the installed
  Codex module's own reply-only delivery judge on twelve shared inputs
  (`tests/fixtures/cross-end/codex-0.13.9.shape.json`), and the cross-end ledger
  records each family's measured disposition. On this batch Codex refuses to
  close all twelve, so the mixed-request and pure-question families are
  `not-aligned` in the direction that matters, and the
  `trusted-answer-delivery` claim is downgraded from `aligned`.
- **Target uniqueness includes every identity field.** Candidate lists preserve
  case where identity is case-sensitive, and package specs contribute both name
  and version. Ordinary capture, restatements and every action-plan entry reject
  conflicting choices. Restatements bind the new action and target together;
  only omitted fields with unique sources can be inherited.

### Upgrade and validation

Write an intended action as an independent instruction when it shares a question
or explanation's scope. Legacy records without execution qualification require
review; no historical action is replayed. The exact supported DSH versions remain
`0.1.5-rc.2 || 0.1.5-rc.1`.

The final source suite passed 2140 tests with one skip. Historical repair rounds,
contract changes and evidence limits are retained in
[local acceptance](docs/LOCAL_ACCEPTANCE.md). These checks do not replace the
exact-artifact native annexes attached to the versioned Release.

## 0.6.2 - 2026-09-16

### Changes

- Ordinary tasks without a certification adapter now report the capability
  limit without asking the user to restate the request or rebind it as another
  action. Prepare, checkpoint, recovery and status share the same diagnosis.
- Shell evidence distinguishes the historical outcome from declared process
  results and operation attribution. Checkpoint exposes the source and conflict
  flag. Existing outcome rules and digest inputs remain unchanged; opaque
  compound commands do not gain per-operation success from their final exit.
- Recovery retains the dependency-free removal condition even at the smallest
  supported budget. Metadata, content, directory and dependency status remain
  separate; this adds no removal executor or automatic safety gate.
- Bounded Codex comparisons now include disposable prompt-ledger lifecycle
  cases for pending, user wait, missing-proof correction and identical mixed
  results. These are function-level measurements, not native acceptance or
  full product parity. See [the result contract](docs/CROSS_END_RESULT_CONTRACT.md).
- Retired duplicate repair notes and the superseded 0.6.1 planning document;
  historical citations point to their exact Git snapshot. Current limitations
  remain in the semantic compatibility document and release plan.

### Validation

At preparation, this entry recorded a source release candidate. Its local checks and then-pending CI, native T06, exact-artifact and publication gates are recorded in
[local acceptance](docs/LOCAL_ACCEPTANCE.md) and the
[release plan](https://github.com/GreenLv/dsh-completion-guard/blob/784b5452b0da366a351dff6490fa46eeed2839a9/docs/RELEASE_PLAN_0_6_2.md).

## 0.6.1 (2026-09-15)

Repairs attachment handling, conservative request interpretation, discovery pagination and evidence guidance after the Windows 0.6.0 review.

- **Attachments can be answered without inventing an execution action (W060-01).** Each asset needs an explicit `context_guard_interpret` record and a completed answer from the interpreting turn. This also lets a later turn handle an old attachment. Replay checks the item, revision, asset identity and call/result turn pair. Contradictions corrupt the projection; missing turn association records nothing. Asset receipts cannot carry clause partition fields. The record is the model's interpretation declaration, not independent proof of visual accuracy.
- **Unknown requests stay pending (W060-02).** Unrecognized clauses no longer default to execution. Explanation and mixed requests can use `context_guard_interpret` with `information_spans` and `unknown_spans`. The tool checks bounds and overlap; replay requires the receipt to match the submitted partition. Information children close with that turn's answer. Unknown and undeclared regions stay pending. Semantic classification remains the model's responsibility. Root clarification, confirmed rebind and clear remain available. Ordinary acknowledgments such as “当然。” are conversation, not obligations.
- **Discovery is paginated (W060-03).** `context_guard_prepare` lists eight items per page in stable order, with a revision-bound cursor and an explicit `semantic_action` filter. Follow `next_cursor` to traverse the applicable current-unit set; restart discovery when the revision changes. Historical items remain accessible by ID.
- **Read-only checks require one effect-role fact (W060-04).** Prepare and diagnosis now agree with the certifier. Stateful work still requires resolution, effect and state evidence; a read-only check no longer reports a missing historical prestate.
- **Unattributable shell effects remain uncertified (W060-05).** A matching command-head signal produces `execution_unattributable`, asking for read-only inspection without asserting that the action ran or did not run. Compound text is not scanned for proof. Guarded push, pull and fetch refuse an already-applied ref state before invoking the runner, reporting `action_already_applied` rather than minting replacement evidence. Ordinary work does not require additional Guard approval.

### Compatibility and validation scope

The new interpretation records and reasons are additive. Attachment capture text retains its 0.6.0 bytes; an old log without interpretation records keeps pending attachments. Source checks, CI, frozen-artifact acceptance and native Web/Headless acceptance are separate results recorded in [LOCAL_ACCEPTANCE](docs/LOCAL_ACCEPTANCE.md). The local test-host cleanup now disposes persistence hosts explicitly to prevent FileHandle garbage-collection errors. No platform or publication result is implied by this changelog.

## 0.6.0 - 2026-09-14

Guard started tracking answers, delegated work and resumed tasks as separate parts of a conversation. A delivered answer closes its answer item. A delegated result can support the parent's checklist, and the parent still has to close its own work.

- A saved result needs to match the requested action and target. Requests to check an image, file, URL or external state need evidence from the corresponding source. When the host cannot supply it, Guard reports the gap.
- Earlier prohibitions still apply to the affected work. Resume uses recorded requirements and results, including open work from required subtasks.
- An explicitly adopted release contract binds each covered operation to the exact candidate. Guard records the attempt before the effect and checks the result afterward.
- This release adopted selected shared Context Guard behavior and kept the earlier history readable. The linked original entry records the repair rounds for this version and the limits of each check.

[Original detailed entry](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.md#060---2026-09-14).

## 0.5.3 - 2026-09-14

Preparation now works when the host reports a capability without an explanation code. For Git actions it lists the inputs and their order, distinguishing details Guard reads from targets you need to provide.

[Original detailed entry](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.md#053---2026-09-14).

## 0.5.2 - 2026-09-11

The package now declares support only for DSH `0.1.5-rc.1` and `0.1.5-rc.2`, the two host versions this release recognizes. Guard still checks the full host package set. Task tracking and completion checks are unchanged from 0.5.1.

[Original detailed entry](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.md#052---2026-09-11).

## 0.5.1 - 2026-09-10

Guard switches to DSH's version 3 session format. If you are upgrading from DSH `0.1.2-rc.1`, start a new session. Keep the old logs, proposals and certificates for reference.

- The package requires DSH `0.1.5-rc.1` or later. The runtime checks the exact registered package sets for rc.1 and rc.2. A version that satisfies npm can still fail the runtime check.
- Guard reads the new tool-dispatch events and recognizes the persistent shell's exit, timeout and out-of-memory markers.
- When a user has paused a Goal, Guard leaves it paused. Pending user confirmations still appear on recovery before advice about gathering evidence.

[Original detailed entry](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.md#051---2026-09-10).

## 0.5.0 - 2026-09-10

In `always` mode, Guard starts with the first real message or attachment. You can choose the DSH preset while the new session is still empty, and Guard covers work from the first step.

- `context_guard_prepare` shows what a supported action needs before it runs. It can point out evidence missing from a past action without asking you to repeat the action.
- A rebind confirmation can be followed by a new request after a blank line. Guard declines a proposed split when none of the new parts would be easier to certify.
- This release targets DSH `0.1.2-rc.1` and Cordis `4.0.2`. It can inspect hoisted package installs in Headless. Old records keep the rules they were written under.

[Original detailed entry](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.md#050---2026-09-10).

## 0.4.3 - 2026-09-08

- Separate the exact DSH core lock from optional market versions. Recheck the active core graph during replay; changed, missing or duplicate core dependencies still fail closed.
- Version the core-lock policy and market service adapter explicitly. Preserve historical records while requiring fresh lock migration and new restart credentials.
- Require a trusted loaded-instance binding for market restart. Current DSH lacks this binding, so only that adapter remains unavailable; requested restart work is never silently completed.
- Select native acceptance targets explicitly, inspect supplied daily targets read-only, and test Headless without installing market.
- Recognize dependency-free DSH `0.1.2-rc.1` Headless profiles during read-only pre-install checks. Verify their installation-owned bundles without creating profile files; installed profiles still require intact package maps and locks.
- Reconcile the historical 0.4.2 release labels and document installation versus runtime acceptance.

## 0.4.2 - 2026-09-07

- Explain when a task cannot be certified and what the user can clarify. Generic command success still cannot prove an update or a GUI result.
- Add `context_guard_rebind`: propose a complete split of an old requirement, optionally link a later explicit root-user clarification, then replace it only after the user's exact confirmation. Old sources, unsupported remainders, and one-to-many relationships remain visible; the proposal grants no execution permission.
- Bound checkpoint pages to 12 KiB and focus default evidence on the current action and target. Item, evidence, and history queries have independent continuation cursors; the full contract is still checked.
- Reserve recovery space for current constraints, refusal reasons, next steps, and completion rules. Unrelated evidence no longer repeats the same guidance; compact and resume still recover the current state.
- Add an isolated host-bound native entrypoint with nonempty tool calls and lifecycle checks. Acceptance is bound to the exact candidate and package; see [acceptance scope](docs/LOCAL_ACCEPTANCE.md).

- Align npm chart date labels with centered anchors and a fixed day interval, preserve real first-day downloads, and distinguish repeat-checked coverage from API availability.

## 0.4.1-rc.1 - 2026-09-04

- Add the exact DSH `0.1.2-rc.1` + dshmarket `1.41.0` host cohort for macOS/posix and Windows. The Windows host graph was audited on the native Windows rc.1 runtime; host-graph audits do not replace the cross-platform exact-artifact acceptance of one frozen package.
- Read session history through the rc.1 `snapshotEvents()` API while retaining the legacy `events` path for previously audited DSH cohorts.

## 0.4.0 - 2026-09-02

Guard checks that proof belongs to the unfinished work you actually requested. Results from another session, action or target leave the item open. A changed file or damaged record can invalidate proof you already supplied.

This version targets DSH `0.1.2-alpha.3`, dshmarket `1.39.0` and Cordis `4.0.2`. The release used the same frozen package for native macOS and Windows checks and npm publication. See the [acceptance records](docs/LOCAL_ACCEPTANCE.md).

[Original detailed entry](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.md#040---2026-09-02).

## 0.3.2 - 2026-09-01

### Added

- **Two exact DSH setups are recognized.** The `0.1.1-rc.2` + dshmarket `1.36.0` and `0.1.2-alpha.2` + dshmarket `1.38.1` package sets are both checked on macOS and Windows.
- **The whole package set must match.** Every required package must appear once with the expected version and integrity. Missing, mixed, duplicate, unidentified, or unknown packages make the entire host unavailable instead of leaving part of the Guard enabled. Status now lists missing packages, and switching setups invalidates earlier completion certificates.

### Changed

- Peer dependencies accept only the two checked version sets (`0.1.1-rc.2 || 0.1.2-alpha.2`, Cordis `4.0.1 || 4.0.2`). A source comparison found no change in the DSH events, Goal calls, tool definitions, or terminal results that the Guard uses.

### Fixed

- **Release packaging now works with Windows tar.** Archive extraction uses paths relative to the temporary working directory instead of passing absolute archive paths, without changing the files placed in the package.

### Validation

- Candidate commit `22cde610` passed the six-job Ubuntu, macOS, and Windows CI matrix on Node.js 22 and 24. The complete 20-file suite passes 359 tests with one Windows-only skip on macOS, and native Windows matched all 34 alpha.2 package rows with no missing, extra, or duplicate entries.
- The frozen 26-file package (181157 bytes, SHA-256 `feb7fc29799820e08dfe6d2bdb94823e745df9b5aa7c34d46262e5df30dabac4`) passed the same-byte isolated Web and Headless lifecycle on native macOS and Windows. The annotated tag, npm package, GitHub Release, and downloaded public bytes all resolve to the same commit and artifact; see [`docs/LOCAL_ACCEPTANCE.md`](docs/LOCAL_ACCEPTANCE.md).

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
