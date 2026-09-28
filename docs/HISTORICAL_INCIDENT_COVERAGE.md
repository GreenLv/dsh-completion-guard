# Historical incident coverage (context-guard-incidents library)

Verification date: 2026-09-28 (two evidence rounds). The adjudication round
ran its working tree on the `1e88176` lineage and the four adaptation cases it
introduced were first committed in `f4a9497`; the review-repair round added the
scope-aware auditor fix, the 040 compaction/restore chain and the 042 A–E
authorization-continuation chain on top; the third repair round fixed the
core-v2 action-evidence mismatch (a Git operation can no longer satisfy a
different same-repository action, and same-root clauses bind only their own
evidence) and made the fully observed 042 chain certify. This document therefore binds each
row to the NAMED CASE CONTENT and to the commit that first contained it — a
bare base-commit number is never the evidence. The release candidate commit is
a later, separate fact and is never referenced from packaged documentation.

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

- Historical evidence lives in the maintainer's sanitized historical
  regression set, kept outside this repository; raw records, private session
  material and machine-local mappings are never copied into public files.
  The per-record table below is a historical producer statement for a former
  28-record subset and is superseded for acceptance purposes by the current
  full-library adjudication (56 cases / 45 active — 29 Codex, 16 DSH — plus a
  frozen 16-record legacy lineage), whose per-case verdicts, execution lanes
  and candidate binding are tracked in that sanitized set.

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

Review-repair round additions:

5. `tests/v6-recovery-feedback.test.ts` — "an answered explicit question is
   not re-injected after compaction and restore while the open one stays
   current" plus the conversational-phrasing boundary control (040).
6. `tests/native-file-v2.test.ts` — the CGI-2026-042 A–E describe: one root
   commit-and-push authorization across five edit/commit shapes, with the
   fully observed chain certifying through the registered checkpoint tool (042).
7. `tests/native-file-v2.test.ts` — the action-mismatch review block: a Git
   operation cannot satisfy a different same-repository action, and a compound
   root satisfied by only one action keeps the other clause insufficient.

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
| CGI-2026-019 | Explicit no-side-effect variants (`npm publish --dry-run`) consumed real-mutation authorization (false deny without recourse) | DSH deliberately has no simulation lane: the dry-run spelling classifies as the same stateful `publish` action. The verified boundary is the classification lane; the authorization/reservation/effect behavior beyond it is governed by the named release surfaces, not asserted here | `tests/domain/v030-manifests.test.ts` "routes simulation variants through the same stateful mutation lane as the real mutation" (`npm publish --dry-run` → `publish`, `git push --dry-run origin main` → `push`, both `isStatefulAction`, identical to the real spellings); prose-mention control: `tests/domain/v051-instruction-semantics.test.ts` "explaining a command is not executing it (0.6.1: unresolved, closable only via the interpretation route)" asserts no `publish` obligation from the explanation probe; the release-side denial controls live in `tests/domain/review-counterexamples.test.ts` (R1–R3: identity kind mismatch, invented readiness, failed-without-readback all denied) | analogue_only |
| CGI-2026-020 | Stop correction message appended every requirement/acceptance id in the session, far beyond the 240-char budget | The real correction message is a fixed notice handed to the model by the production turn-stopping entry; its size is independent of open-item count | `tests/runtime.test.ts` "keeps the protocol correction message fixed-size regardless of session debt" — with 60 extra open items the steered message is byte-identical to the 1-item message, equals `PROTOCOL_CORRECTION_NOTICE`, ≤240 chars, and contains no item ids; packet budgets are a separate, existing surface (`tests/tools/v042-feedback.test.ts` "T08 reserves rules and next steps even after an oversized item") | executed_pass |
| CGI-2026-021 | MCP thread-read alias set matched only the short name, so the real event never bound a readback subject | No DSH counterpart: DSH has no MCP thread-read tool or alias table (`grep read_thread\\|THREAD_READ src/` = 0 hits). Subject binding happens only through structured native-observation metadata and known adapters | Controls: `tests/domain/v030-capture-targets.test.ts` "$action captures root identity and rejects adapter target substitution" (it.each); `tests/native-file-v2.test.ts` "certifies an observed edit without a Guard execution qualification or resolution call" asserts a text-only or tampered state row yields `insufficient`/`incomplete` — echoed text can never bind as state evidence | not_applicable |
| CGI-2026-022 | Reproduced supersedes CGI-2026-013 (same work-unit lifecycle family) | Same production path as CGI-2026-013 | Same three named cases as CGI-2026-013 | executed_pass |
| CGI-2026-023 | Reproduced supersedes CGI-2026-014 (checkpoint failure cascade family) | Same production path as CGI-2026-014 | Same named cases as CGI-2026-014, plus `tests/runtime.test.ts` "steers exactly once for root persistence and yields to an active armed Goal" pinning `protocol_correction_already_issued` on the second attempt at the same boundary | executed_pass |
| CGI-2026-024 | Reproduced supersedes CGI-2026-015 (disposition subclass family) | Same production path as CGI-2026-015 | Same named cases as CGI-2026-015 | executed_pass |
| CGI-2026-025 | Reproduced supersedes CGI-2026-016 (allow-path status/ receipt family) | Same product boundary as CGI-2026-016 | Same controls as CGI-2026-016 | not_applicable |
| CGI-2026-026 | Reproduced supersedes CGI-2026-017 (release machinery without adoption family) | Same production path as CGI-2026-017 | Same named cases as CGI-2026-017 | executed_pass |
| CGI-2026-027 | Reproduced supersedes CGI-2026-018 (executable-position family) | Same production path as CGI-2026-018 | Same named cases as CGI-2026-018 | executed_pass |
| CGI-2026-028 | Reproduced supersedes CGI-2026-019 (simulation classification family) | Same production path and verified classification boundary as CGI-2026-019 | Same named cases as CGI-2026-019 | analogue_only |
| CGI-2026-029 | Reproduced supersedes CGI-2026-020 (unbounded Stop feedback family) | Same production path as CGI-2026-020 | Same named cases as CGI-2026-020 | executed_pass |
| CGI-2026-030 | Reproduced supersedes CGI-2026-021 (thread readback binding family) | Same product boundary as CGI-2026-021 | Same controls as CGI-2026-021 | not_applicable |
| CGI-2026-040 | An answered question was replayed into the recovery view after resume; the unit stayed active | Recovery injection consumes the current confirmed view: closed/answered work is not re-injected, unchanged packets dedup, re-injection needs real content change | Full compaction/restore chain: `tests/v6-recovery-feedback.test.ts` "an answered explicit question is not re-injected after compaction and restore while the open one stays current" — question A captured and answered in its own turn, question B captured and left open, then `compaction/summary` and a strict `Session.fromRestore` into a new session; the resumed registered pre-step injects nothing containing A and the restored contract keeps A `answered` while B stays `pending`. Input boundary controls, same file: "the original conversational question phrasing stays outside the contract entirely" (the original record's bare question is conversational in DSH and never becomes an obligation) and the existing resume/dedup lane "injects nothing for an observed ordinary closure after resume", "injects the unmet view after resume, dedups repeats, and follows real changes", `tests/runtime.test.ts` "does not re-arm recovery from a historical compaction summary". The original private question texts are not reproduced; the chain uses structure-preserving sanitized fixtures, so this row is the DSH adaptation of the failure family, not a claimed precise replay of the original inputs | executed_pass |
| CGI-2026-041 | A mixed update+cleanup request collapsed to cleanup-only and the patch was denied | Mixed requests keep every execution obligation through prepare and the authorizer; answered information ranges are not re-listed | `tests/tools/v063-host-materialization.test.ts` "a mixed request keeps its execution obligations through prepare and the authorizer" — the prepared list keeps both execution items and each commit/push obligation is denied only for the real reason (missing authority), never collapsed; `tests/domain/v063-holdout-round35.test.ts` "an agreeing pair is inherited whole" / "a conflicting pair leaves only the branch open" pin clause-level preservation | executed_pass |
| CGI-2026-042 | Ordinary host edit/commit/push forced re-authorization when the observer missed edit provenance; insufficient observation still denied | Authorization identity comes from the root contract items and never re-arms; each clause is satisfiable only by observations of its OWN semantic action (`src/core-v2/session.ts` evidence-applicability gate); certification tracks the shared-core closure | `tests/native-file-v2.test.ts` CGI-2026-042 describe, it.each over the five original shapes (A python-recorded edit/direct shell commit, B observed edit/direct commit, C explicit file edit/direct commit, D python-recorded edit/commit, E recognized edit/text-only result; the Python shapes are session-recorded adaptation forms, not native Python-process runs): ONE root message authorizes modify+commit+push, all three items share `sourceMessageId`, and `authorizeMutationFromProjection` authorizes the commit and push from those same root items with no new root input in every shape. The fully observed B chain certifies through the REGISTERED `context_guard_checkpoint` tool with per-clause bindings, each citing exactly its own effect+state ids; A/C/D/E keep the edit (and, for D, the wrapper commit) insufficient and refuse any certificate naming only `current_closure_unmet`, never the push binding. Supporting surfaces: "certifies an observed edit without a Guard execution qualification or resolution call" (tampered/missing observation → `insufficient`, `certifiable: false`), "reads back a native commit and push from fixed Git queries after persisted results" (wrong branch → `incomplete`; unbound amend output → `unavailable`), `tests/host-workdir-v070.test.ts` "does not retrospectively grant old calls that lack a call-time receipt". The same file pins the action-mismatch family directly: a Git operation cannot satisfy a different same-repository action (cross observations rejected, matching actions accepted) and a compound root satisfied by only one action keeps the other clause insufficient with the closure uncertifiable | executed_pass |
| CGI-20260913-codex-archive-043 (archive 043) | Report-level (Windows 0.12.1): repeated authorized-commit denials after real commits | Analogue surface exists (`tests/native-file-v2.test.ts` commit/push readback; `tests/domain/v051-target-identity.test.ts` refused push targets) but the record itself has no replay | Missing minimal events: (1) the root message binding commit-and-push intent, (2) the real `git commit` in both the compound and independent forms, (3) the denial event with its exact reason code per push attempt, (4) the persisted projection showing the commit evidence at denial time. Trigger steps: fresh Windows rc.2 host, current candidate, ordinary repo, one explicit authorization, edit→commit→push via both command forms. Observation conditions: full hook/session log with reason codes; no private repo content in the record; native Windows only — CI or synthetic hosts do not qualify A cold/warm first-open measurement does NOT produce any of these events and is not acceptance for this record; remaining input: a dedicated native commit/push denial run (owner: coordinator native batch). | pending |
| CGI-20260913-codex-archive-044 (archive 044) | Report-level (Windows 0.12.1): an unnecessary supersession clarification on an ordinary follow-up | Analogue surface exists (`tests/domain/v061-conservative-interpretation.test.ts` conservative supersession) but the record has no replay and its own pure probes did not reproduce | Missing minimal events: (1) the prior durable state with ≥2 unfinished requirements, (2) the exact follow-up prompt, (3) the emitted clarification event (or its absence) with reason code, (4) a current-version pure-probe run for contrast. Trigger steps: rebuild the two-open-requirement chain on a current host, send the follow-up, compare legacy-state vs pure-probe event streams. Observation conditions: durable session logs on both runs; same version/platform; the comparison, not either run alone, is the evidence A cold/warm first-open measurement does not exercise this chain; remaining input: the paired legacy-state/probe run (owner: coordinator native batch). | pending |
| CGI-20260913-codex-archive-045 (archive 045) | Report-level (Windows 0.12.1): a generated private diagnostic control was rejected as malformed, with no successful diagnosis | No DSH analog can be named without the control grammar; the record explicitly omits the raw control and the rejecting event is unresolved | Missing minimal events: (1) the regenerated control value with its documented grammar, lifetime and wrapper, (2) the emitting tool/event identity, (3) the exact rejection event with reason code, (4) one accepted-control run for contrast. Trigger steps: on a current host invoke the diagnostic lane with a valid current control and invalid controls; capture accept/reject per input. Observation conditions: rejection captured from the session log; no real private control value archived; the accepting run must show the bounded diagnosis the record never observed A cold/warm first-open measurement exercises none of this; remaining input: regenerated control grammar + paired accept/reject run (owner: coordinator native batch, after the grammar is recovered). | pending |

## Denominator and totals

- `executed_pass`: **19** (009, 010, 011, 012, 013, 014, 015, 017, 018, 020,
  022, 023, 024, 026, 027, 029, 040, 041, 042)
- `not_applicable` (Codex-only surface, with controls): **4** (016, 021, 025, 030)
- `analogue_only` (documented intentional difference, both directions proven): **2** (019, 028)
- `pending` (report-level, no replay conditions met): **3** (043, 044, 045)

Only the Codex Python/runtime suites of the private library were treated as
upstream evidence; no row above counts a Codex-runtime pass as a DSH pass.

## Regression suite runs used for this adjudication

- Adjudication round (working tree at `1e88176`, cases first committed in
  `f4a9497`): batch 1 — `tests/v6-recovery-feedback.test.ts`,
  `tests/runtime.test.ts`, `tests/domain/v030-manifests.test.ts`: 3 files,
  105 passed; batch 2 — the 23 remaining evidence files named in the table:
  23 files, 448 passed, 1 skipped (pre-existing platform skip), 0 failed.
- Review-repair round: reviewer repro patches verified RED at `b1ae3b6`
  (4 negative scope cases + the full `revalidateCoreLock` entry), then GREEN
  after the scope-aware auditor fix; `tests/domain/host-dependency-audit.test.ts`
  20 passed; rc017-adaptation family 143 passed / 3 skipped; upgrade,
  target-identity and qualification families 246 passed; full matrix and CI at
  `a0bf01f` green.
- Action-mismatch repair round: reviewer patch verified RED at `a0bf01f`
  (2 failed / 2 passed), then GREEN after the evidence-applicability fix in
  `src/core-v2/session.ts`; `tests/native-file-v2.test.ts` 16 passed;
  rc017-adaptation 143 passed / 3 skipped, qualification 172, target-identity
  168, upgrade 82; mirror/conformance/portable-semantics/081 entries
  207 passed / 1 skipped. Full deterministic matrix, CI, and packaging stay
  governed by the candidate freeze record; this page pins per-case evidence
  only.

## Explicit gaps carried forward

1. 043–045 stay pending on their own listed minimal events. A cold/warm
   first-open latency measurement produces none of those events (no
   commit/push denial chain, no legacy-state clarification chain, no
   diagnostic-control grammar), so it is not an acceptance vehicle for them;
   each row names its remaining input and owner.
2. 019/028 remain an intentional architectural difference at the verified
   classification boundary: DSH classifies simulation spellings as their real
   stateful mutation. If DSH ever grows a simulation lane, the family needs a
   dedicated regression before release.
3. 016/021/025/030 are Codex-product-only surfaces; they cannot regress on
   DSH and stay recorded for cross-product audits, with the controls named in
   their rows re-checked if DSH grows an allow-path status writer or an MCP
   thread-read adapter.
