# Changelog

All notable changes to this project are documented here. The project is pre-1.0; release versions track the plugin lifecycle, not stabilised API promises.

## 0.8.0

- Target only DSH `0.1.7-rc.2` / Cordis `4.0.4`. Check all 46 critical package identities, published implementation bytes and actual dependency resolution paths; remove historical hosts from production selection.
- Install and dispose tools, guards and listeners through awaited `agent/created`, including existing Agents on enablement. Use Session V4 and Jobs SessionId ownership.
- Keep shell promotion and incomplete output uncertified. Persist Stop boundaries as Guard notices instead of fabricating tool events outside a turn.
- Read-only prepare discovery and checkpoint pagination now continue after their own persisted observations; changed contract items or business state still invalidate old cursors.
- Preserve 0.7.1 recovery feedback and independent proof, Goal and release gates. Upgrade requires a new host lock and restart; old certificates are not re-signed.

Upgrade DSH before installing 0.8.0, then regenerate the host lock for each profile. Follow the [upgrade guide](docs/HOST_LOCK_UPGRADE.md). The [source-stage evidence snapshot](docs/DSH_0_1_7_RC2_ACCEPTANCE.md) records development checks and their limits; exact-artifact acceptance is recorded separately in Release attachments.

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

Repairs execution authority, target identity, preparation consistency and legacy
record eligibility. For publication status and same-artifact native evidence, use
[the versioned release](https://github.com/GreenLv/dsh-completion-guard/releases/tag/v0.6.3).
[Local acceptance](docs/LOCAL_ACCEPTANCE.md) records the source checks.

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

This is a source release candidate. Local checks and remaining CI,
native T06, exact-artifact and publication gates are recorded in
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

## 0.6.0 third repair round after targeted review (2026-09-14)

Two findings from the targeted review of `fcc3813`, both fixed.

- **A certificate minted after adoption can no longer ratify the adoption.** The
  closure check compared the certificate's revision with the revision frozen at
  adoption, which a later log entry could satisfy: adopting a contract that
  named a certificate that did not exist yet, then producing that certificate
  afterwards, was granted. The adoption now resolves and freezes the closure
  certificate's IDENTITY (its certification digest, epoch and revision) at the
  adoption watermark, and the gate requires exactly that certificate. An
  unresolvable reference is recorded as unresolved rather than left open for a
  future entry to satisfy. A later release obligation still does not invalidate
  the frozen candidate closure. The frozen certificate must also match the
  candidate revision at adoption; a certificate already stale before adoption
  is refused.
- **Invalid adoption input no longer poisons a valid contract.** A root
  `/context-guard release adopt` with a malformed payload was treated as damaged
  persisted state, so one typo permanently blocked every later publication. A
  root command the user typed badly is a usage diagnostic; only an unreadable
  persisted reservation, settlement or contract record marks the release state
  damaged. A malformed plugin-notice record still fails closed.

New regression cases: a certificate minted after adoption is refused (with the
projection still valid), a certificate that existed at adoption is frozen by
identity and survives a later obligation,
and invalid/mistyped adopt input leaves a valid contract usable.

## 0.6.0 second repair round after follow-up review (2026-09-14)

A follow-up review of the repair commit found five remaining defects in the new
wiring. All five reproduced and are fixed. The reviewer's counterexamples are
kept as permanent regression cases in the suites they belong to.

### Fixed

- **Adding the v5 boundary no longer answers a pre-v5 question.** Deliveries were
  only gated by the watermark of their own turn; appending the boundary at the
  end of a v4 log therefore made an old turn's answer retroactively close an
  obligation the old rules had left open. A delivery now counts only when its
  turn ended AFTER the boundary, and only obligations captured after the
  boundary can be closed by one.
- **The real publish producer now observes everything the contract names.** The
  trusted reader fills the registry from the canonicalized resolution (it was
  simply missing, so any contract naming a registry could never be granted), and
  the ref is resolved by the runtime from the ADOPTED CONTRACT with the audited
  git executable — a closed, reachable path, instead of a command-manifest field
  the publish manifest schema rejects. A ref that resolves to a commit different
  from the artifact's embedded `gitHead` is refused.
- **A new release instruction no longer invalidates the certificate it needs.**
  The closure check demanded the CURRENT contract revision, so capturing the
  publish obligation invalidated the very certificate the release was about to
  use, and certifying afterwards required the publish to be complete first. The
  contract now freezes the candidate scope's revision at adoption and requires
  the closure certificate to be the one that certified exactly that revision.
  A later obligation does not re-validate a moved candidate, and a certificate
  minted after adoption is still refused.
- **Read-only release queries no longer poison the release state.** `release
  status` (and an omitted verb) is a read-only command; an unknown verb is a
  usage diagnostic. Only an unreadable persisted record marks the release state
  damaged, so a plain query can no longer block every future publication
  irreversibly.
- **There is now a callable trusted recovery entry.** `context_guard_release`
  reads the release state and, for `reconcile`, reads the external identity
  through the same audited registry adapter the publish path uses and settles
  the reservation only when the readback names the bytes the contract — or the
  reservation's recorded SRI — froze. It never re-sends a release, and it works
  after a restart and for a revoked-but-in-flight attempt, because revocation
  withdraws future authority rather than the duty to reconcile an effect that
  may already have happened. A contract that froze only the byte SHA-256 stays
  reconcilable and can still DETECT a mismatched readback.
- **A presented proof is now part of the persisted contract.** The checkpoint
  call records its `proof` manifest, and the replay re-binds it at that call's
  own watermark and requires the recorded proof state to match what the log
  implies. A tampered or omitted proof — with a result that still claims it was
  bound — now fails closed with `proof_replay_mismatch` instead of restoring a
  valid certificate. Signing, persistence and replay use the same call argument,
  and the Goal gate consumes only a certificate whose proof still binds.

### Verification

- The reviewer's five follow-up counterexamples pass and remain as regression
  cases: pre-v5 delivery, read-only status, the frozen candidate closure, the
  observed registry, and persisted proof tampering.
- New: `tests/tools/v060-release-chain.test.ts` — the acceptance the review asked
  for. One test drives a real root publish instruction, a real certified
  preparation closure, a real contract adoption, a real tgz and resolution
  through the registered evidence tool, and then the registered action tool
  consulting the RUNTIME's own release gate: it reserves, executes once, leaves
  the attempt in flight, reconciles it through the registered recovery tool, and
  refuses the replay as a consumed ticket. Only the npm executor and the
  registry HTTP client are replaced; the authorization gate, records, producers
  and replay are production code. Two further cases cover the revoked-but-in-
  flight restart recovery and a mismatching readback.
- The proof suite gained the missing-proof, Goal-consumption and
  accurate-evidence-boundary cases.

### Evidence boundary

The release chain test pins the audited host cohort through an explicit
`RuntimeExecutorSeams.hostLock` acceptance seam, because the host-lock
migration revalidation reads real filesystem roots. That replaces ONLY the
host-lock evaluation; the release gate, the reservation and settlement records,
the evidence producers and the replay are the production ones, and the host lock
keeps its own suites and native acceptance.

## 0.6.0 repairs after concentrated review (2026-09-14)

A concentrated review of the `0dce898` candidate produced fifteen targeted
counterexamples; all fifteen reproduced a real defect. This section records the
repair. The stable finding numbers (`F01`–`F08`, `R1`–`R15`) are the reviewer's.

### Fixed

- **F01 certificate replay was timing-dependent.** Deliveries were applied after
  the whole log was replayed, so a checkpoint recorded in a later turn was
  re-verified while the delivered answer still looked open, and the v5 rule set
  was applied to the whole log rather than from the boundary onwards. Delivery
  is now applied at the watermark of the turn that produced it and the rule mode
  switches at the boundary event, which makes a projection equal to the
  projection of its own prefix. Certificate comparison is also field-semantic
  now: identical certificates replay identically regardless of JSON property
  order, while an extra, missing, or tampered field still fails.
- **F02 delivery accepted late and non-final answers.** The final answer must
  appear before the turn's own `turn/end`, must sit in the highest step the host
  actually entered, and the turn must have exactly one completed end and a
  recorded start. Late text, an intermediate step, a repeated or abnormal end,
  and an aborted turn all deliver nothing.
- **F03 the switch test ignored descendants, and an item reference crashed.**
  The handover test now uses the same closure as the certificate, so a parent
  with a pending delegated child is not treated as finished, and the item-ID
  pattern is a global capture that distinguishes live lineage references from
  unknown or historical IDs.
- **F04 release identity was not really bound.** A candidate now has separate,
  named identities — commit, ref, repository, package, version, artifact
  SHA-256, npm SRI, registry — and each is compared with its own observed value
  read from a trusted producer (the exact tgz bytes and the local repository),
  never with a model-supplied string. Readiness and closure references must
  resolve to real certified facts, the resolved target must be the artifact the
  contract names, and a contract that names no artifact digest is refused
  outright so omitting one cannot be a bypass. A registry readback that names
  different bytes is not a settlement.
- **F05 an unknown effect could be re-sent, and a late readback was discarded.**
  Outcomes are distinguished: `not_effected` is a proven pre-effect refusal and
  releases the one-shot lock, while `failed`/`unknown`/`unconfirmed` keep it and
  refuse a re-send. Settlements are reconciled rather than de-duplicated, so a
  trusted readback settles an earlier unconfirmed attempt, and a settled release
  is never downgraded. Damaged release state now blocks release operations
  (`release_state_damaged`) without touching ordinary work.
- **F06 adoption reported an error and revocation did not exist.** The public
  command validates and reports exactly what the durable root command adopts,
  and `/context-guard release revoke <contract_id>` records a durable revocation
  that keeps the audit trail, denies the next effect, and still shows an
  in-flight reservation whose readback is owed.
- **F07 proof could be satisfied about the wrong subject.** Binding now runs the
  whole chain: the item's own frozen subject and scope, the fact's qualification
  under the ordinary evidence rules, the declared source, the declared operation
  for every kind, the order of an input check before the effect, and the real
  coverage set behind a declared scope digest. A manifest and a fact that agree
  with each other but not with the user's obligation are rejected.
- **F08 the proof entry was not reachable from production.** The v2 binder is now
  wired into `context_guard_checkpoint` (an optional `proof` manifest is bound
  before any certificate and its state is reported), the v2 fixture evaluates
  each release probe at its own point in the log, mints real closure
  certificates, and carries a real read fact for S09, and a dedicated
  production-chain suite drives producer → persisted log → derive → checkpoint →
  replay.

### Scope rulings (coordinator, 2026-09-14)

Two scope facts were decided once, and both are recorded as fact rather than as
a general parity claim:

1. **The v2 shared fixture stays a DSH-authored candidate and cross-language
   parity stays open.** The upstream repository has not frozen a v2
   specification, so there is nothing to mirror. The plan's shared gate is
   therefore recorded as a cross-repository pending item owned by the upstream.
2. **The release profile's protectable surface is `npm_publish` only.** The
   `git_tag` and GitHub Release routes are NOT claimed to be blocked by the
   host: the plugin reports them as `release_operation_unrouted` with
   `attribution: scope_reduction`, because building the Guard-owned route is the
   work that would make them protectable. Only a composite runner is reported as
   an opaque host boundary. The coverage table is machine-readable so this
   distinction cannot be lost in prose.

The plugin therefore does not claim "C01–C12 core alignment" with Codex Context
Guard, and it does not claim a complete release coverage surface.

### Verification

The reviewer's fifteen counterexamples are kept as
`tests/domain/review-counterexamples.test.ts` and now pass; the expectations
that the repair deliberately changed are marked in place with the reason. New
coverage: `tests/domain/v060-proof-production-chain.test.ts` (the proof entry
through real tool registration), the rewritten release/migration suite (26
cases, including a real certified closure and every identity refusal), and the
extended v2 fixture (S09 proof binding, per-timeline release probes, and the
scope-attribution table).

## 0.6.0 - 2026-09-14

This release makes ordinary DSH work enter, execute, deliver, and resume under
one set of rules. It also closes the substantive gaps against the shared
Context Guard semantics. Everything before the new protocol boundary keeps its
old meaning; nothing is re-read or re-labelled.

### Added

- **Answer delivery is tracked separately from execution certification.** A
  question or explanation is closed only by the host's own evidence: an
  `assistant/message` in the turn's final step, with no interrupted marker,
  followed by `turn/end` with `reason.kind: "completed"`. A status summary, a
  draft, an intermediate reply, another turn's answer, a subagent's answer, or
  an aborted turn never closes anything. `answered` means "the answer was
  handed over" — never that it was right, complete, or executed.
- **Work units with a required-descendant closure.** Tasks are grouped into
  derived units. A delegation-marked instruction opens a child unit whose open
  work is required by the parent's closure, so delegating a sub-task can never
  drop the parent's own work; an ordinary task switch opens a sibling that does
  not block the newer task. A subagent's result is bounded evidence: it is
  recorded and visible, and it never closes a parent obligation.
- **Ancestor constraints stay in force.** A prohibition or an unsatisfied
  condition the root declared in an earlier unit continues to govern the same
  action and target in a later one, and the certifier refuses those bindings
  before examining evidence.
- **Proof v2 with a real capability matrix.** Five new proof kinds — input
  asset check, output visual readback, object/URL readback, execution fact, and
  external fact — each bind a current subject, a declared source, and a real
  operation. A successful tool call is only ever an execution fact: a browser
  call that merely returned cannot prove an image was looked at, an input asset
  check must be a prior-state fact, and a delegated subagent result is never a
  proof source. When the installed host exposes no producer, the result is
  `unavailable`, never a silent pass. The old three-kind manifest and its digest
  domain are unchanged and remain readable.
- **Explicit release tickets.** A release contract is adopted only by an
  explicit root command. Once adopted, each operation spends one reservation,
  written before the effect and settled afterwards from a trusted readback.
  Wrong candidate SHA, ref, artifact digest or version, an expired or
  unevaluable ticket, a consumed ticket, a replay, an operation that is already
  in flight, an unresolved target, and an opaque runner are all refused before
  any effect. A "release" keyword, a loaded Skill, or an installation never
  adopts a contract.
- **A strict proof tier.** On top of the default `standard` tier, a visual or
  complete-scope verification the user explicitly asked for must be discharged
  by a real readback fact. Strict adds no approval step to ordinary actions, and
  installing never enters the `release` tier.
- **One diagnosis language.** Every incomplete item now reports one of seven
  classes — parameter missing, source insufficient, condition unmet, producer
  capability unavailable, historical gap, integrity failure, policy boundary —
  next to its exact reason code. `/context-guard migration` reports which rule
  set is in force, which obligations keep their pre-0.6.0 rules, and what a
  rollback requires.
- **A host-neutral v2 conformance fixture** covering S01–S12 through the real
  derive/delivery/closure/Goal chains. Every expectation is compared against a
  value computed from the events and the production projection alone; the runner
  never reads an expectation to decide an actual result.

### Changed

- A document "update" or "modify" is decided by the object, not by the verb:
  a recognized document noun becomes a bounded `modify` the assistant may
  resolve to an exact file inside the captured scope and type, while an
  unrecognized object keeps its honest unresolved reading instead of being
  forced into an action.
- A trusted answer from the host's own question tool now narrows where a
  bounded file choice may land, and is recorded separately from sandbox
  approvals. Pasted or restated answer text forms nothing.
- A later root instruction that contains a pending generic obligation verbatim
  supersedes it atomically, keeping both revisions. Explanations, prohibitions
  and waits never delete an obligation by similar wording.
- `/context-guard status` reports the active policy tier, the reason-class
  histogram, the migration facts, and the release state.

### Fixed

- The first step of a session now sees the input persisted in that same step,
  and a failed durability flush reports an explicit unavailability instead of
  serving a stale projection.
- The v2 conformance runner computes `interpreted`, `closure`, `delivery`,
  `turn_bound` and the correction decision from production state instead of from
  the fixture's own expectations.
- A malformed release record is reported as a bounded diagnostic and never
  marks the whole session corrupt, so damaged release state cannot block
  unrelated ordinary work.

### Migration and rollback

- The 0.6.0 semantics start at the new `Context Guard protocol boundary:
  v5.0.0` notice, written at the first real root-input step of a new session.
  An older binary ignores that notice, so a rollback fails closed instead of
  misreading new records.
- A session that never wrote the boundary keeps the previous whole-session
  contract, version-1 certificates, and its old digest domains.
- A session that wrote it keeps pre-boundary obligations under their birth
  rules while new work uses units, delivery and version-2 certificates.
- Rolling back to 0.5.x requires restoring a 0.5.x state snapshot. Replaying a
  0.6.0 log with 0.5.x fails closed with `certificate_replay_mismatch`; never
  migrate new-schema data down by hand.

### Not yet established

- **Cross-language parity and the canonical mirror are not done.** The
  upstream `codex-context-guard` repository has not landed a frozen v2 fixture,
  so the v2 file here is explicitly a DSH-authored *candidate*
  (`2.0.0-candidate.1`, `status: "dsh-candidate"`). `UPSTREAM_PIN.json` still
  pins the unchanged v1 mirrors and is not refreshed by this release.
- The `release` tier protects only surfaces Guard itself routes. Publishing an
  npm artifact through the Guard-owned action tool is protected; `git tag`, the
  GitHub Release operations, and any composite runner have no interception
  point in this host and are refused before effect rather than pretended to be
  covered. A trusted in-process caller that bypasses Guard entirely is a host
  trust boundary, documented rather than denied.
- After a publish, the settlement stays `unconfirmed` unless the registry
  readback producer answers; an unconfirmed operation is never re-sent.
- Deterministic tests, CI, native macOS/Windows acceptance, publication and
  installation are separate evidence scopes. This release records source and
  deterministic evidence; native acceptance and publication follow separately.

## 0.5.3 - 2026-09-14

### Fixed

- Preparation succeeds when the host capability check has no reason code. Real tool-registry regressions cover the previously invalid nested optional field.
- Git preparation lists the required inputs and call sequence. Missing evidence inputs identify their exact fields; producer-computed Git identities are no longer presented as missing user targets. Execution and certification checks remain unchanged.

### Planned

- Track answer delivery separately from execution certification. The design and remaining semantic coverage are recorded in [next-version repair notes](https://github.com/GreenLv/dsh-completion-guard/blob/d11009d8f755ecee7d288cff18250c7b372cfd2a/docs/NEXT_VERSION_REPAIR_NOTES.md); question closure is not changed by this patch.

## 0.5.2 - 2026-09-11

### Changed

- Publish the exact DSH support union `0.1.5-rc.2 || 0.1.5-rc.1` in top-level `engines.dsh`, nested `dsh.engines.dsh`, and all seven DSH peer dependencies. These are the latest registered host and the verified minimum; older, stable `0.1.5`, and future versions are no longer advertised by npm or plugin markets.
- Export the same newest-first support set and range from the domain entry. The minimum-version comparison remains diagnostic, while actual support still requires one complete registered 33-package host graph.
- Package version is `0.5.2`; the version was confirmed unused on npm before preparation.

### Unchanged

- Runtime task capture, evidence, certification, host graphs, Cordis range, and the rc.1 development baseline are unchanged from 0.5.1.

### Evidence boundary

- The metadata and source-policy regressions are part of this candidate. CI, exact-artifact native acceptance, publication, and live market refresh remain separate evidence.

## 0.5.1 - 2026-09-10

### Changed

- **Support DSH >= 0.1.5-rc.1, with no backward compatibility.** The DSH Session V2 API, the V2 event vocabulary, and every older host package set were removed rather than kept behind a fallback. A session object that does not expose the V3 `snapshotEvents()` API is refused loudly instead of being projected as an empty log, and a header that is not session format 3 is refused instead of being hashed as a guessed identity. `0.1.5-rc.1` is the version this release was built and tested against; it is the baseline, not a ceiling. Upgrading from DSH `0.1.2-rc.1` means starting a **new session**; old logs, proposals and certificates are never migrated, promoted, or deleted.
- **The support policy is a range, and the host check is still an exact graph.** `peerDependencies` publish `>=0.1.5-rc.1` (Cordis `^4.0.2`), so `0.1.4`, `0.1.5-alpha.9` and anything older are refused. Because npm resolves a prerelease from a range only when its `major.minor.patch` tuple matches the bound, `0.1.5-rc.2` and `0.1.5` resolve while `0.1.6-rc.1` and `0.2.0-rc.1` do not; that limitation is documented and tested rather than hidden behind a wildcard. A newer host that is not a registered cohort is still reported as unverified, so the range never substitutes for the graph lock.
- **Register separate exact host sets for DSH 0.1.5-rc.1 and 0.1.5-rc.2.** Each set contains 33 core packages bound to their published npm identities; mixing rows from different versions is refused. The registry-derived provenance stays in the host-lock digest, while native acceptance is recorded separately for each exact artifact and platform. Older host sets remain historical and unsupported. `dshmarket` is checked independently by the action adapter.
- **Guard never restarts a Goal the user stopped.** When a current Goal is paused, blocked, completed, or its phase has not been read back, turn stopping yields with `goal_paused_by_user_safe_yield` / `goal_not_continuable_safe_yield` instead of spending the one allowed correction steer. Guard's Goal access surface has no resume entry point at all: it can only disarm at an accepted boundary, and only a human `resume` re-arms a goal.
- **Terminal marker classification was re-verified against the shipped 0.1.5-rc.1 renderers.** The two session renderers registered by `@deepseek-ai/dsh-base` append markers only for negative facts and non-zero exits — unchanged between host versions — so an unmarked completed foreground result remains a clean success for those two names under a supported host lock. The out-of-bundle persistent renderer added `[Command finished with exit code N]` and `[Command timed out or OOM]`; both are now classified explicitly, so such a result is read by its own marker instead of falling through to the unmarked rule.
- **The renamed PTC dispatch events are the only dispatch vocabulary.** `tool/ptc-dispatch-start` and `tool/ptc-dispatch` replaced `tool/code-dispatch-start` and `tool/code-dispatch`; the retired names are ignored and produce no evidence.
- Package version is `0.5.1`, verified unused on npm before it was written.
- Pending root confirmations remain explicit after checkpoint and recovery: the saved resume condition is shown before target or evidence-collection advice, and the reserved action stays blocked.

### Unchanged

- The 29 byte-mirrored digest-v3 cross-language vectors are byte-identical: the V3 session identity feeds the inherited-prefix length into the existing `seedLength` digest token, and V3's `isSeeded` marker was deliberately left out of the shared digest domain so a host upgrade cannot silently change another repository's parity contract.
- The 0.5.0 confirmation, prepare, diagnosis and no-certification-gain behaviours, the first-message protection boundary, and durable-evidence-only certification.

### Not yet established

- At candidate preparation, deterministic tests cover a real host loop with a simulated model, including stopping and disk recovery. Cross-platform CI, native application acceptance, real-model behaviour and publication still require separate evidence.

## 0.5.0 - 2026-09-10

### Changed

- **`always` mode now protects from your first message instead of writing into brand-new sessions.** A freshly created session stays completely empty: the Guard no longer appends context messages when the session starts, so the session still looks new and a DSH session mode (standard, minimal, or a custom preset) can be chosen before anything is sent. Protection begins in the same step as the first real user message, ahead of that message — the first task, including its first file changes, is covered. A first message that only carries an image or an attachment also starts protection; a blank message starts nothing and creates no empty contract.
- **A confirmation can carry follow-up text in the same reply.** The confirmation line `确认重绑定 <proposal ID>` may stand alone as the first line; an explanation request or a new task after a blank line keeps its own meaning, and a new task is captured like any other instruction. A confirmation buried inside a sentence, inside quotes, inside a code block, or followed by a reversal such as "先不要确认", does nothing — a reply either confirms cleanly or stays pending, never partially.
- **Useless rebind confirmations are refused up front.** Splitting one uncertifiable requirement into clauses that are all equally uncertifiable returns "no certification gain" instead of producing a proposal that would spend a user confirmation without improving certification.
- **Diagnosis names what is possible before what is missing.** Checkpoint, recovery, rebind, and status share one diagnosis per item: what kind of work it is, whether the current adapters can certify it, which target fields or evidence facets are missing, and one concrete next action. Questions such as "是否有更新" stay recorded with their source but report honestly that they cannot be machine-certified — finish them and report the answer — instead of being pushed into a rebind loop. Repeating an identical rejected attempt returns the same stable "unchanged" answer instead of a fresh rejection each time.

### Added

- **`context_guard_prepare` (read-only).** Before a stateful action it reports the supported command shape (from the same audited parser the executor uses), the required resolution/effect/state evidence order, reusable evidence references, the host capability verdict, and the exact missing target fields. It performs no action, and a guessed or default target is never treated as user authority.
- **An action that already happened without its prestate evidence is reported as a historical gap**: the observed state can be read back, and repeating the action to mint missing evidence is explicitly not suggested.

### Compatibility

- Recognize pnpm hoisted installations when checking a dependency-free Headless profile. Bare package-name entries now work alongside versioned entries; installed versions, lockfile integrity, unique identities, and actual package locations remain mandatory.
- The supported DSH target is exactly `0.1.2-rc.1` (with Cordis `4.0.2`). The active host allowlist contains that one audited core graph; alpha and older RC package sets are recorded as historical identities only, and an installed graph from those sets fails closed instead of certifying. npm peer dependencies accept only `0.1.2-rc.1`.
- Sessions created before this version keep their stored messages, proposals, and certificates under their historical rules. The first message this version writes into such a session carries an explicit protocol boundary marking the cut; duties and certificates from before the cut are never reinterpreted. Upgrading does not remove previously injected messages.

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

### Added

- **DSH alpha.3 is the 0.4.0 implementation baseline.** Version 0.4.0 targets DSH `0.1.2-alpha.3` with dshmarket `1.39.0` and Cordis `4.0.2`.
- **Evidence must prove the unfinished work the user actually requested.** Reading or checking another target cannot close the item. Evidence from another session, evidence for the wrong action or target, and evidence that does not show the required result are rejected.
- **Changed or damaged proof records cannot be reused.** If the recorded files, task scope, or saved state no longer match, the proof becomes invalid and the work stays open. The Guard keeps only the bounded facts needed for this check, not raw private logs or file contents.
- **Stage disposition.** The stopped 0.3.3 compatibility candidate is recorded as `superseded_before_candidate`; no 0.3.3 source, artifact, installation, native acceptance, commit, tag, or release existed.

### Changed

- **Compatibility adaptation pauses after alpha.3.** Version 0.4.0 stays frozen on the DSH alpha.3 setup. Alpha.4 and later alpha releases are not new adaptation targets; work resumes with the first upstream RC published after alpha.3. Upstream milestones are listed on the [DeepSeek Harness tags page](https://github.com/deepseek-ai/deepseek-harness/tags).

### Validation

- The release commit passes the repository matrix and CI on Ubuntu, macOS, and Windows with Node.js 22 and 24. One frozen 26-file tgz is used for native macOS and Windows acceptance and npm publication; the GitHub Release carries its checksum and platform annexes.
- Earlier 0.4.0 candidate packages remain historical evidence only. Results never transfer to changed package bytes; see [`docs/LOCAL_ACCEPTANCE.md`](docs/LOCAL_ACCEPTANCE.md).

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
