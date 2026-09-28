# Historical incident coverage (context-guard-incidents library)

Verification date: 2026-09-28. Base commit for every test named below:
`1e88176` lineage (post recovery-dedup, post `preEffectVeto`). This document
names its verification base; the release candidate commit is a later,
separate fact and is never referenced from packaged documentation.

## Method and verdict vocabulary

Every one of the 28 records gets its own row and one of four verdicts. A
verdict is never inherited from a file-level or family-level green run.

- `executed_pass` — the DSH adaptation of the record's failure family is
  pinned by named `it()` cases with named assertions, and those cases pass at
  the base commit. Family members may share one case; the case is named for
  each member.
- `not_applicable` — the incident surface does not exist in DSH (product
  boundary). The row must still name the positive/negative controls that pin
  the analogous invariant DSH does keep.
- `analogue_only` — the input surface exists in DSH but the original expected
  behavior is intentionally different. The row must name the tests that prove
  DSH's actual path in both directions plus the documented difference.
- `pending` — no replayable DSH evidence exists yet. The row must list the
  missing minimal events, trigger steps, and observation conditions.

## Library binding

- Private library: `context-guard-incidents` (outside this repository; no
  record content is copied here beyond sanitized summaries).
- Snapshot: 28 records under `records/`, schema `incident-corpus/v2`, IDs
  `CGI-2026-009` … `CGI-2026-045` (with gaps), observed versions 0.9.5–0.12.4.
- Snapshot digests (2026-09-28, computed over the sorted `records/*.json`):
  concatenated record bytes `sha256:92bcfbd485600adde26ec36788e85dc9b3c5d8e8e8c7579066fb7ff733f8a35a`;
  per-record digest list `sha256:cecd806d4013f9fa6abfc9aab2292ba7d01f987e5331bd5c6197a9713e859b8a`.
- The machine-readable per-case execution record (verdicts, commands, exit
  codes, base commit, input digests) is preserved in the private library's
  handoff directory, bound to the same digests. It is deliberately not part
  of this package.

## New adaptation tests added for this adjudication

1. `tests/v6-recovery-feedback.test.ts` — "a legal correction after the armed
   follow-up ends the turn safely with the work still pending" (014/023 full
   chain, see row).
2. `tests/runtime.test.ts` — "keeps the protocol correction message
   fixed-size regardless of session debt" (020/029).
3. `tests/domain/v030-manifests.test.ts` — "routes simulation variants through
   the same stateful mutation lane as the real mutation" (019/028).
4. `tests/runtime.test.ts` — "a cleanup request never carries mutation
   authority for product repair" (012).

## Per-record verdicts

| ID | Original oracle (sanitized) | DSH production path / adapter | Regression evidence (exact case + assertion) | Verdict |
| --- | --- | --- | --- | --- |
| CGI-2026-009 | A-tier high-risk action (tag/release creation) observed with no pre-action decision and no ticket | `authorizeMutationFromProjection` fail-closed chain; every stateful mutation request needs an exact pending root-owned item | `tests/runtime.test.ts` "authorizes a mutation only for the exact pending root-owned action and target" asserts `mutation_contract_item_missing` when no item exists, plus revision/action/target mismatch denials; `tests/runtime.test.ts` it.each "rejects incomplete %s root authority before mutation" denies `publish`/`push` with incomplete root targets; `tests/v081-production-entry-drift.test.ts` "charges one validation to the checkpoint entry and one to the whole publish entry, and refuses drift between entries" pins real production entries to fresh validation | executed_pass |
| CGI-2026-010 | Declared deferred disposition overrode observed authorized remaining work; disposition was not validated against its owner | `decideTurnBoundary` takes no assistant text at all; declared dispositions are bounded diagnostics only; a typed boundary needs an immutable root qualification | `tests/domain/v030-stop-boundary.test.ts` "keeps completion prose diagnostic-only and protocol decisions metamorphic"; `tests/domain/v030-stop-boundary.test.ts` "accepts user_wait only from a current immutable wait authorization"; `tests/runtime.test.ts` "steers exactly once for root persistence and yields to an active armed Goal" | executed_pass |
| CGI-2026-011 | Quoted/annotated text was treated as a root correction superseding a prior requirement | Supersession requires an explicit mechanism: identical re-statement, or an explicit rebind confirmation with a proposal id; wrapped/misplaced control is ambiguous | `tests/domain/core.test.ts` "derives distinct IDs and supersedes identical re-statements" (R001 superseded only by an identical re-statement, `supersededBy` pinned); `tests/domain/v050-confirm.test.ts` "a valid control line that is not the first line is ambiguous, never applied" and "two different proposals in one message stay ambiguous without partial effect"; `tests/domain/v061-conservative-interpretation.test.ts` "a verbatim concrete instruction supersedes an unresolved clause (review repro: clarification lane)" names the only legal supersession lane | executed_pass |
| CGI-2026-012 | Authorized cleanup scope silently continued into new product repair without separate authorization | Cleanup grants no mutation authority; a repair needs its own pending root-owned item with a matching semantic action and target | `tests/runtime.test.ts` "a cleanup request never carries mutation authority for product repair" — `authorizeMutationFromProjection` denies `modify` citing a cleanup item; `tests/domain/v062-capability-and-layers.test.ts` "only dependency_free enters the removal set" and "a clean tree or an empty worktree list never proves \"no dependants\"" bound the cleanup scope itself; `tests/v6-recovery-feedback.test.ts` "a cleanup request keeps the dependency-free condition at every budget and view state" | executed_pass |
| CGI-2026-013 | Every prompt chained a child work unit; historical items kept entering Stop gating | Units open only from delegation-marked roots; a task switch opens a sibling; stale siblings never join the current view | `tests/domain/v060-unit-closure.test.ts` "an ordinary task switch opens a sibling that never blocks the newer unit"; `tests/domain/v060-unit-closure.test.ts` "the delegation vocabulary is closed: a subagent mention without an act never opens a unit"; `tests/v6-recovery-feedback.test.ts` "a stale pending sibling-unit record does not join the current recovery rows" | executed_pass |
| CGI-2026-014 | Checkpoint gap re-triggered visible continuations far beyond one bounded correction | Checkpoint rejection arms one bounded follow-up; repeats dedup; a legal correction ends the turn safely; unfinished work is never marked complete | `tests/v6-recovery-feedback.test.ts` "invalid-proof: reminders do not repeat after a persisted continue and the same rejection" and the `failed-flush` twin (0 after 3 rejections); `tests/v6-recovery-feedback.test.ts` "a legal correction after the armed follow-up ends the turn safely with the work still pending" — full chain: reject → one injection → real successful host test → `observed` checkpoint → zero follow-ups → `handleGuardTurnStopping` returns `safe_yield_pending_preserved`, steers nothing, no certificate exists, item stays `pending`; `tests/domain/v051-host-loop.test.ts` "disarms the armed goal and stops further rounds and model calls" (real host loop: two production decisions then the bounded stop, zero further model calls) | executed_pass |
| CGI-2026-015 | Declared user_wait/deferred were judged mismatched against an observed external_wait and each produced a visible continuation | Dispositions are strictly typed against their qualification source, not lexically compared: external_wait needs a live trusted-adapter operation, user_wait needs a root wait authorization | `tests/tools/boundary-integration.test.ts` "round-trips live jobs readback through derive, boundary tool, and persisted replay" (only a real `running` operation qualifies `external_wait`); it.each "maps pinned ctx.jobs status %s to %s without parsing output text"; `tests/runtime.test.ts` "live-requalifies every external_wait job immediately before effectuation" — a completed job yields `boundary_pre_effect_failure`, never a continuation; `tests/domain/v030-stop-boundary.test.ts` "requalifies a live external operation before yielding or disarming" | executed_pass |
| CGI-2026-016 | hooks.json attached a statusMessage to every allow event and injected receipts on normal prompts | No DSH counterpart: DSH has no hooks.json surface and no statusMessage writer (`grep statusMessage src/` = 0 hits). Allow-path silence is pinned by controls. The one additional-context producer is the bounded read-only shell-workdir observation on bash/pwsh (`src/runtime.ts` workdir receipt), an evidence channel, not an allow-path status writer | Controls: `tests/v6-recovery-feedback.test.ts` "T0 stays silent; the first root carries the boundary once; …"; `tests/domain/v062-capability-and-layers.test.ts` "an ordinary business tool call gains no Guard approval requirement" and "a pending obligation can end silently without being reported as complete"; `tests/host-workdir-v070.test.ts` "records the same passive notice through the real Cordis tool waterfall" (the bounded receipt's exact scope) | not_applicable |
| CGI-2026-017 | A-tier mutations always demanded an exact ticket even though no release contract was ever adopted | Release class needs an adopted contract AND the protected release surface; non-release stateful mutations need only root authority; adoption is explicit and durable | `tests/tools/v060-release-chain.test.ts` "publishes under a real adopted contract, reserves, settles, and reconciles" (the only allow path); `tests/domain/v060-release-migration.test.ts` "a keyword, a Skill or an installation never adopts a contract" and "a contract naming an unprotectable operation is refused at adoption"; `tests/domain/review-counterexamples.test.ts` "R2: missing observed repository/ref and invented readiness must not grant" (`releasePreEffectDecision` denied) | executed_pass |
| CGI-2026-018 | Command classifier accepted any token whose basename matched git/gh, so echo/search arguments became tier-A/B actions | Whitelisted single-command parser: only the executable position is consulted; quoted/argument command words never become executables | `tests/domain/core.test.ts` "parses shell commands quote-aware (P0-2 / P1-2)" asserts `parseShellCommand('echo "ignored; pnpm test"').executables` is exactly `['echo']` and wrappers fail closed; "does not let quoted text invent an executable method (P0-2 negative)" and "does not let echo-only bash close a create requirement (P0-1 negative)" pin the denial side | executed_pass |
| CGI-2026-019 | Explicit no-side-effect variants (`npm publish --dry-run`) consumed real-mutation authorization (false deny without recourse) | DSH deliberately has no simulation lane: the dry-run spelling classifies as the same stateful `publish` action and demands the same authorization; without an adopted contract nothing is reserved and nothing runs | `tests/domain/v030-manifests.test.ts` "routes simulation variants through the same stateful mutation lane as the real mutation" (`npm publish --dry-run` → `publish`, `git push --dry-run origin main` → `push`, both `isStatefulAction`, identical to the real spellings); prose-mention control: `tests/domain/v051-instruction-semantics.test.ts` "explaining a command is not executing it (0.6.1: unresolved, closable only via the interpretation route)" asserts no `publish` obligation from the explanation probe; no-reservation side: `tests/domain/review-counterexamples.test.ts` "R2: missing observed repository/ref and invented readiness must not grant" | analogue_only |
| CGI-2026-020 | Stop correction message appended every requirement/acceptance id in the session, far beyond the 240-char budget | The real correction message is a fixed notice handed to the model by the production turn-stopping entry; its size is independent of open-item count | `tests/runtime.test.ts` "keeps the protocol correction message fixed-size regardless of session debt" — with 60 extra open items the steered message is byte-identical to the 1-item message, equals `PROTOCOL_CORRECTION_NOTICE`, ≤240 chars, and contains no item ids; packet budgets are a separate, existing surface (`tests/tools/v042-feedback.test.ts` "T08 reserves rules and next steps even after an oversized item") | executed_pass |
| CGI-2026-021 | MCP thread-read alias set matched only the short name, so the real event never bound a readback subject | No DSH counterpart: DSH has no MCP thread-read tool or alias table (`grep read_thread\\|THREAD_READ src/` = 0 hits). Subject binding happens only through structured native-observation metadata and known adapters | Controls: `tests/domain/v030-capture-targets.test.ts` "$action captures root identity and rejects adapter target substitution" (it.each); `tests/native-file-v2.test.ts` "certifies an observed edit without a Guard execution qualification or resolution call" asserts a text-only or tampered state row yields `insufficient`/`incomplete` — echoed text can never bind as state evidence | not_applicable |
| CGI-2026-022 | Reproduced supersedes CGI-2026-013 (same work-unit lifecycle family) | Same production path as CGI-2026-013 | Same three named cases as CGI-2026-013 | executed_pass |
| CGI-2026-023 | Reproduced supersedes CGI-2026-014 (checkpoint failure cascade family) | Same production path as CGI-2026-014 | Same named cases as CGI-2026-014, plus `tests/runtime.test.ts` "steers exactly once for root persistence and yields to an active armed Goal" pinning `protocol_correction_already_issued` on the second attempt at the same boundary | executed_pass |
| CGI-2026-024 | Reproduced supersedes CGI-2026-015 (disposition subclass family) | Same production path as CGI-2026-015 | Same named cases as CGI-2026-015 | executed_pass |
| CGI-2026-025 | Reproduced supersedes CGI-2026-016 (allow-path status/ receipt family) | Same product boundary as CGI-2026-016 | Same controls as CGI-2026-016 | not_applicable |
| CGI-2026-026 | Reproduced supersedes CGI-2026-017 (release machinery without adoption family) | Same production path as CGI-2026-017 | Same named cases as CGI-2026-017 | executed_pass |
| CGI-2026-027 | Reproduced supersedes CGI-2026-018 (executable-position family) | Same production path as CGI-2026-018 | Same named cases as CGI-2026-018 | executed_pass |
| CGI-2026-028 | Reproduced supersedes CGI-2026-019 (simulation classification family) | Same production path and documented difference as CGI-2026-019 | Same named cases as CGI-2026-019 | analogue_only |
| CGI-2026-029 | Reproduced supersedes CGI-2026-020 (unbounded Stop feedback family) | Same production path as CGI-2026-020 | Same named cases as CGI-2026-020 | executed_pass |
| CGI-2026-030 | Reproduced supersedes CGI-2026-021 (thread readback binding family) | Same product boundary as CGI-2026-021 | Same controls as CGI-2026-021 | not_applicable |
| CGI-2026-040 | An answered question was replayed into the recovery view after resume; the unit stayed active | Recovery injection consumes the current confirmed view: closed/answered work is not re-injected, unchanged packets dedup, re-injection needs real content change | `tests/v6-recovery-feedback.test.ts` "injects nothing for an observed ordinary closure after resume" (zero `Open task requirements` rows after an observed closure); `tests/v6-recovery-feedback.test.ts` "injects the unmet view after resume, dedups repeats, and follows real changes" (dedup + change-driven re-arm); `tests/runtime.test.ts` "does not re-arm recovery from a historical compaction summary" and "injects an unchanged packet once, dedups repeated rejections, and re-injects on new content" | executed_pass |
| CGI-2026-041 | A mixed update+cleanup request collapsed to cleanup-only and the patch was denied | Mixed requests keep every execution obligation through prepare and the authorizer; answered information ranges are not re-listed | `tests/tools/v063-host-materialization.test.ts` "a mixed request keeps its execution obligations through prepare and the authorizer" — the prepared list keeps both execution items and each commit/push obligation is denied only for the real reason (missing authority), never collapsed; `tests/domain/v063-holdout-round35.test.ts` "an agreeing pair is inherited whole" / "a conflicting pair leaves only the branch open" pin clause-level preservation | executed_pass |
| CGI-2026-042 | Ordinary host edit/commit/push forced re-authorization when the observer missed edit provenance; insufficient observation still denied | DSH never demands extra authorization for unrecognized provenance: an observed host edit prepares as `ordinary_execution_host_owned` with no qualification demand; certification without sufficient observation is impossible; a push needs its own root item and native readback | `tests/native-file-v2.test.ts` "certifies an observed edit without a Guard execution qualification or resolution call" — prepare returns `ordinary_execution_host_owned` with no `required_evidence_order`; removing/tampering the observation yields `insufficient` and `certifiable: false`; `tests/native-file-v2.test.ts` "reads back a native commit and push from fixed Git queries after persisted results" — wrong-branch binding is `incomplete`, unbound amend output is `unavailable`; `tests/host-workdir-v070.test.ts` "does not retrospectively grant old calls that lack a call-time receipt" | executed_pass |
| CGI-2026-043 | Report-level (Windows 0.12.1): repeated authorized-commit denials after real commits | Analogue surface exists (`tests/native-file-v2.test.ts` commit/push readback; `tests/domain/v051-target-identity.test.ts` refused push targets) but the record itself has no replay | Missing minimal events: (1) the root message binding commit-and-push intent, (2) the real `git commit` in both the compound and independent forms, (3) the denial event with its exact reason code per push attempt, (4) the persisted projection showing the commit evidence at denial time. Trigger steps: fresh Windows rc.2 host, current candidate, ordinary repo, one explicit authorization, edit→commit→push via both command forms. Observation conditions: full hook/session log with reason codes; no private repo content in the record; native Windows only — CI or synthetic hosts do not qualify | pending |
| CGI-2026-044 | Report-level (Windows 0.12.1): an unnecessary supersession clarification on an ordinary follow-up | Analogue surface exists (`tests/domain/v061-conservative-interpretation.test.ts` conservative supersession) but the record has no replay and its own pure probes did not reproduce | Missing minimal events: (1) the prior durable state with ≥2 unfinished requirements, (2) the exact follow-up prompt, (3) the emitted clarification event (or its absence) with reason code, (4) a current-version pure-probe run for contrast. Trigger steps: rebuild the two-open-requirement chain on a current host, send the follow-up, compare legacy-state vs pure-probe event streams. Observation conditions: durable session logs on both runs; same version/platform; the comparison, not either run alone, is the evidence | pending |
| CGI-2026-045 | Report-level (Windows 0.12.1): a generated private diagnostic control was rejected as malformed, with no successful diagnosis | No DSH analog can be named without the control grammar; the record explicitly omits the raw control and the rejecting event is unresolved | Missing minimal events: (1) the regenerated control value with its documented grammar, lifetime and wrapper, (2) the emitting tool/event identity, (3) the exact rejection event with reason code, (4) one accepted-control run for contrast. Trigger steps: on a current host invoke the diagnostic lane with a valid current control and invalid controls; capture accept/reject per input. Observation conditions: rejection captured from the session log; no real private control value archived; the accepting run must show the bounded diagnosis the record never observed | pending |

## Denominator and totals

- `executed_pass`: **19** (009, 010, 011, 012, 013, 014, 015, 017, 018, 020,
  022, 023, 024, 026, 027, 029, 040, 041, 042)
- `not_applicable` (Codex-only surface, with controls): **4** (016, 021, 025, 030)
- `analogue_only` (documented intentional difference, both directions proven): **2** (019, 028)
- `pending` (report-level, no replay conditions met): **3** (043, 044, 045)

Only the Codex Python/runtime suites of the private library were treated as
upstream evidence; no row above counts a Codex-runtime pass as a DSH pass.

## Regression suite runs used for this adjudication (base `1e88176` + the four new cases)

- Batch 1 (`tests/v6-recovery-feedback.test.ts`, `tests/runtime.test.ts`,
  `tests/domain/v030-manifests.test.ts`): 3 files, 105 passed.
- Batch 2 (the 23 remaining evidence files named in the table): 23 files,
  448 passed, 1 skipped (pre-existing platform skip), 0 failed.
- Full deterministic matrix, CI, and packaging stay governed by the candidate
  freeze record; this page pins per-case evidence only.

## Explicit gaps carried forward

1. 043–045 stay pending until a native Windows acceptance produces the
   missing minimal events listed in their rows; the pending Windows cold-open
   acceptance for 0.8.1 is the designated vehicle.
2. 019/028 remain an intentional architectural difference: DSH classifies
   simulation spellings as their real stateful mutation. If DSH ever grows a
   simulation lane, the family needs a dedicated regression before release.
3. 016/021/025/030 are Codex-product-only surfaces; they cannot regress on
   DSH and stay recorded for cross-product audits, with the controls named in
   their rows re-checked if DSH grows an allow-path status writer or an MCP
   thread-read adapter.
