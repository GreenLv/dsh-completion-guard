# Historical incident coverage (context-guard-incidents library)

Verification date: 2026-09-28. Base commit: `92d4c0d` lineage (post-`preEffectVeto`).

## Library binding

- Private library: `context-guard-incidents` (outside this repository; original
  records are not copied here).
- Snapshot: 28 records under `records/`, schema `incident-corpus/v2`, IDs
  `CGI-2026-009` … `CGI-2026-045` (with gaps), observed versions 0.9.5–0.12.4.
- Snapshot digests (2026-09-28, computed over the sorted `records/*.json`):
  concatenated record bytes `sha256:92bcfbd485600adde26ec36788e85dc9b3c5d8e8e8c7579066fb7ff733f8a35a`;
  per-record digest list `sha256:cecd806d4013f9fa6abfc9aab2292ba7d01f987e5331bd5c6197a9713e859b8a`.
  The per-record digest list is preserved in the private handoff; this
  document keeps only sanitized summaries.
- Denominator: **28 records → 28 rows below**. Every row names the DSH
  production path or adapter, the regression evidence, and a verdict. Verdicts
  are strict: `covered` means the failure FAMILY has a DSH production
  counterpart with named regression evidence in this repository at the base
  commit; it never means the original Codex repro was replayed on DSH.
  Codex-only surfaces and report-level records are `pending` with the reason.

## Per-record verdicts

| ID | Original surface (Codex product) | DSH production path / adapter | Regression evidence (test files) | Verdict |
| --- | --- | --- | --- | --- |
| CGI-2026-009 | PreToolUse high-risk decision absent | `tools.guard` monotonic denial + `authorizeMutationFromProjection` fail-closed chain | `tests/v081-production-entry-drift.test.ts`, `tests/domain/v051-goal-lifecycle-composed.test.ts` | covered (family analogue) |
| CGI-2026-010 | Stop disposition mismatch allows out-of-scope defer | `decideTurnStopping` disposition semantics | `tests/runtime.test.ts`, `tests/persistence-control-v6.test.ts` | covered (family analogue) |
| CGI-2026-011 | Prior requirement wrongly superseded | `supersedeItem` / conservative interpretation | `tests/domain/v061-conservative-interpretation.test.ts`, `tests/domain/core.test.ts` | covered (family analogue) |
| CGI-2026-012 | Unapproved scope transition continued | scope/authority qualification | `tests/domain/v063-core-alignment.test.ts`, `tests/domain/v063-target-family.test.ts` | covered (family analogue) |
| CGI-2026-013 | Every prompt creates a child work unit | work-unit root/sibling closure rules | `tests/domain/v060-unit-closure.test.ts`, `tests/domain/review-counterexamples.test.ts` | covered (family analogue) |
| CGI-2026-014 | Checkpoint gap loops the turn | bounded checkpoint rejection + follow-up arm | `tests/tools/native-checkpoint-details.test.ts`, `tests/tools/v063-host-materialization.test.ts` | covered (family analogue) |
| CGI-2026-015 | user_wait/deferred vs external_wait confusion | boundary `external_wait` requalification | `tests/tools/boundary-integration.test.ts`, `tests/runtime.test.ts` | covered (family analogue) |
| CGI-2026-016 | `hooks.json` statusMessage on allow paths | No DSH counterpart: DSH has no hooks.json surface; Guard allow paths are silent by construction (no persistent status writer) | — | pending (Codex-only surface) |
| CGI-2026-017 | A-tier mutations always demand exact ticket | DSH release/mutation authority requires adopted contract only for release class; root authority otherwise | `tests/tools/v060-release-chain.test.ts`, `tests/domain/v051-goal-lifecycle-composed.test.ts` | covered (family analogue) |
| CGI-2026-018 | Command classifier accepts any token | `isRunExecutable` executable-position parsing | `tests/domain/v062-capability-and-layers.test.ts` | covered (family analogue) |
| CGI-2026-019 | `--dry-run` variants consume authorization | DSH `shell-parse` implements no dry-run classification; DSH high-risk effects are gated structurally (semantic action + target), but no dry-run lexer exists | `src/domain/shell-parse.ts` (absence) | pending (DSH counterpart absent) |
| CGI-2026-020 | Stop feedback exceeds 240 chars | recovery packet char budget + bounded titles | `tests/v6-recovery-feedback.test.ts`, `tests/tools/v042-feedback.test.ts` | covered (family analogue) |
| CGI-2026-021 | MCP thread-read alias set incomplete | No DSH counterpart: DSH has no MCP thread-read tool or alias table | — | pending (Codex-only surface) |
| CGI-2026-022 | same family as 013 | as 013 | as 013 | covered (family analogue) |
| CGI-2026-023 | same family as 014 | as 014 | as 014 | covered (family analogue) |
| CGI-2026-024 | same family as 015 | as 015 | as 015 | covered (family analogue) |
| CGI-2026-025 | same family as 016 | as 016 | — | pending (Codex-only surface) |
| CGI-2026-026 | same family as 017 | as 017 | as 017 | covered (family analogue) |
| CGI-2026-027 | same family as 018 | as 018 | as 018 | covered (family analogue) |
| CGI-2026-028 | same family as 019 | as 019 | `src/domain/shell-parse.ts` (absence) | pending (DSH counterpart absent) |
| CGI-2026-029 | same family as 020 | as 020 | as 020 | covered (family analogue) |
| CGI-2026-030 | same family as 021 | as 021 | — | pending (Codex-only surface) |
| CGI-2026-040 | Answered question stays in response debt | question/delivery lane semantics | `tests/domain/v050-incident-replay.test.ts`, `tests/domain/v051-target-identity.test.ts` | covered (family analogue) |
| CGI-2026-041 | Mixed update+cleanup collapses to cleanup-only | work-unit kind + cleanup condition preservation | `tests/domain/v063-holdout-round35.test.ts`, `tests/domain/v062-capability-and-layers.test.ts` | covered (family analogue) |
| CGI-2026-042 | Edit provenance forces authorization repetition | persisted observation/evidence inheritance | `tests/v070-observer-method.test.ts`, `tests/domain/v063-holdout-round31.test.ts` | covered (family analogue) |
| CGI-2026-043 | Windows 0.12.1 report: repeated authorized_commit prompts | Report-level record, `documented_only`, no minimal event or replay artifact; DSH native Windows runtime not exercised | — | pending (report-level; no replay condition) |
| CGI-2026-044 | Windows 0.12.1 report: unnecessary supersession | as 043 | — | pending (report-level; no replay condition) |
| CGI-2026-045 | Windows 0.12.1 report: malformed rejection text | as 043 | — | pending (report-level; no replay condition) |

## Denominator and totals

- Covered (DSH family analogue + regression evidence at base commit): **19**
- Pending — Codex-only surface, no DSH counterpart (016, 021, 025, 030): **4**
- Pending — DSH counterpart absent (019, 028 dry-run lexer): **2**
- Pending — report-level Windows records without replay conditions
  (043, 044, 045): **3**

Only the Codex Python/runtime suites of the private library were NOT treated
as DSH evidence; no row above counts a Codex-runtime pass as a DSH pass.

## Regression suite runs at the base commit (2026-09-28)

- `node tests/run-repair-families.mjs all`: 20 files, 366 passed, 3 skipped.
- core-v2 mirror/conformance + portable semantics + review/holdout rounds
  (25/31/34/35), recovery feedback, narrowed contract: 9 files, 405 passed.
- Full deterministic matrix and CI: see the candidate freeze record for this
  round; CI lanes all green including the Windows portable exact-artifact
  acceptance.

## Explicit gaps carried forward

1. Dry-run/read-only lexer classification (019/028) has no DSH counterpart;
   if DSH grows a dry-run surface, the incident family needs a regression
   before release.
2. hooks.json status messaging and MCP thread-read alias behavior (016/021/
   025/030) are Codex-product-only; they cannot regress on DSH and stay
   recorded for cross-product audits only.
3. Windows report-level records (043–045) remain pending until a native
   Windows acceptance with replayable evidence exists; the pending Windows
   cold-open acceptance for 0.8.1 is the designated vehicle.
