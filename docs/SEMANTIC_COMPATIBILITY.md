# Semantic Compatibility

`dsh-completion-guard` adapts the Context Guard protocol semantics whose
canonical owner is `codex-context-guard`. The two products keep separate
runtimes, persistence, lifecycle, and scheduling; what they share is a
testable semantic contract tracked by a machine-readable delta ledger and
byte-mirrored conformance fixtures. This document describes the shared assets
from the DSH side and their current implementation status. It does not claim
full feature parity with the Codex product.

## Shared assets in this repository

```text
docs/upstream-deltas.json
tests/fixtures/conformance/UPSTREAM_PIN.json
tests/fixtures/conformance/context_guard_semantics_v1.json
tests/fixtures/conformance/context_guard_semantics_v1.schema.json
tests/fixtures/conformance/digest_v3/cases.json
tests/fixtures/conformance/digest_v3/expected.json
src/domain/digest.ts
manifests/action-manifest.v1.json
manifests/supported-host.v1.json
```

Authority rules:

- The portable conformance fixture and the digest v3 fixture are canonical in
  codex-context-guard. This repository holds byte mirrors whose SHA-256
  values are pinned in `tests/fixtures/conformance/UPSTREAM_PIN.json`; the
  vitest suite fails when any mirror drifts from its pinned hash.
- `UPSTREAM_PIN.json` records the upstream head at mirror time, the mirror
  date, and per-file hashes. Its current `canonicalCommit` is the landed
  upstream commit `b59fcfe1aaf8ead3f0438bc67dc7f725c869a473`; refresh the pin
  whenever the mirrors are re-synced.
- New protocol cases discovered on the DSH side are turned into
  platform-neutral fixture cases upstream first; host-specific expectations
  never enter the shared fixture.
- `docs/UPSTREAM_BASE.md` records the Codex v0.8.8 source used for the first
  DSH v0.1.0 port. It is a historical fact, not the current alignment claim;
  current status lives in this document and the delta ledger.

## 0.7.0 core/v2 source mirror

`tests/fixtures/conformance/core_v2/UPSTREAM_PIN.json` separately binds ten
shared core/v2 upstream source files to Codex Context Guard commit
`20b938d5728d9d6a27386268a79ceeb2be5c39ce` and records eight mirror
entries, including the packaged runtime JSON copies. The mirror validator checks
the committed upstream file bytes and local copies. The earlier v1/digest pin
above remains byte-for-byte unchanged. This is a shared source and conformance
identity; complete product behavior, installed state and release acceptance are
separate claims.

## 0.6.3 core-alignment delta

The 0.6.2 core-alignment review reproduced three domain defects — a question
marker swallowing a mixed request, the session directory promoted to a resolved
request target, and preparation returning a recipe the execution gate refuses —
and a fourth consequence: records an earlier version closed as answered were
inherited as current passes. 0.6.3 repairs the source readings rather than the
endpoint checks:

| Capability | 0.6.3 disposition | Evidence |
| --- | --- | --- |
| information scope is complete and execution-free | implemented (DSH side) | `tests/domain/v063-core-alignment.test.ts`, `tests/domain/v063-holdout.test.ts` |
| requested target has an auditable source | implemented (DSH side) | `tests/domain/v063-core-alignment.test.ts` (K2), `tests/domain/v051-target-identity.test.ts` |
| prepare and execution share one compatibility judgement | implemented (DSH side) | `src/domain/compatibility.ts`, `tests/domain/v063-core-alignment.test.ts` (K3) |
| earlier answered records are re-checked before terminal filtering | implemented (DSH side) | `tests/domain/v063-core-alignment.test.ts` (K4), `tests/domain/v063-holdout.test.ts` |
| mixed-request obligation projection equals Codex | **not measured** | `tests/fixtures/cross-end/core_alignment_0_6_3.json` records it `not-applicable` |
| cross-repository follow-up reference equals Codex | **not measured** | Codex exposes no equivalent target-source entry point |
| prepare/execute consistency equals Codex | **not measured** | Codex has no equivalent prepare surface; recorded `not-applicable` |

`docs/upstream-deltas.json` carries the same statements in the machine-readable
ledger (refreshed 2026-09-16 for the 0.6.3 target; the Codex-side release
comparison it names is unchanged), and
`tests/fixtures/cross-end/core_alignment_0_6_3.json` is the case-level record. The `trusted-answer-delivery` entry was downgraded from `aligned` to
`partial-equivalent`: the recorded Codex reply-only judgement returns false for
the mixed inputs where DSH's delivery judgement would close the information
range, so the two ends do not agree on that family.

## Digest v3

Certificate, boundary, and evidence manifests bind to versioned canonical
digests. The derivation contract is frozen as digest version 3 (typed token
value language, length-prefixed fields with an explicit presence byte,
semantic-key-ordered canonical collections, closed per-manifest allowlists
with domain separators). The full contract, the golden-vector gate, and the
fail-closed edges are documented in the upstream
`docs/SEMANTIC_COMPATIBILITY.md`; the fixtures are byte mirrors here.

DSH-side facts:

- `src/domain/digest.ts` re-derives the complete digest contract in
  TypeScript, including the verifier-side role matrix and binding closure.
- `tests/domain/digest-v3.test.ts` runs all 29 golden vectors from the byte
  mirror and asserts byte-identical agreement with the upstream-generated
  `expected.json`, plus the fail-closed negatives (semantic-key sorting, the
  two collision layers, lone surrogates, NFC vs NFD, duplicate members,
  camelCase rejection, surface cardinality, frozen length boundaries, and
  cross-paired evidence rejection).
- The upstream gate command
  (`python scripts/reference_digest_encoder.py --check ...`) stays the
  canonical check; the mirrored fixtures make both implementations answer to
  the same bytes.
- Version 0.3 wires the module into checkpoint creation/replay and the
  Guard-owned Goal-complete gate. Certificates freeze the full versioned field
  table, including session and host identity, and are authoritative only after
  the tool result persists and re-derives exactly.

## Portable conformance fixture

`context_guard_semantics_v1.json` holds 37 platform-neutral cases built from the
event vocabulary `root_message`, `delegated_message`, `tool_result`,
`checkpoint_request`, `boundary_request`, `completion_request`, `compact`,
`resume`, and `goal_change`, with bounded expectations (`completed`,
`completion_allowed`, `force_continue`, `pending_preserved`, `boundary`,
`integrity`, `reason_codes`). All content is synthetic. The DSH-side portable
runner executes every mirrored case without skips and compares the bounded
result contract; it does not translate a missing capability into a pass.

## 0.5.1 host adaptation note (2026-09-10)

The DSH host moved from Session format 0 to format 3 under Guard 0.5.1. That is
a host-side change, and one part of it touches a shared asset: the
session-identity digest input.

DSH Session V3 moved the fork-inherited prefix length out of the session header
(`seedLength`) onto the Session itself (`inheritedEventCount`). Guard feeds that
same durable value into the existing `seedLength` token and leaves the
`ccg.sessionRefDigest.v3` domain unchanged, so **every byte-mirrored digest
vector still reproduces identically** and no re-mirror is required. V3's
`header.isSeeded` marker was deliberately left out of the shared domain: an
absent optional field still encodes a presence-0 row, so adding it would change
every digest and silently invalidate the pinned parity evidence. The decision,
its root cause, and its impact boundary are recorded in
[`upstream-deltas.json`](upstream-deltas.json).

Everything else in the host adaptation is host-specific and stays out of the
shared fixture: the V2→V3 event vocabulary, the required `surfaceOp` metadata,
the renamed PTC dispatch events, the terminal renderer markers of 0.1.5-rc.1,
and the registry-derived host cohort. The maintainer document
`UPSTREAM_API_AUDIT.md` at the repository root records those differences; it is
not part of the published package.

## Recorded 0.4.0 alignment status (2026-09-03)

The semantic implementation described here entered the DSH `0.4.0` line from implementation baseline `ffc6fe9e1246a815f0bb630943c59d14b6505716`. The shared-contract reference is the Codex `0.10.0` source at `e4fccf690bcbc2be79d0b8d42a1a269f87072120`; this covers only the named contracts, not full product parity. Exact release commit, artifact, native-platform, and publication identities are recorded outside this semantic document because each is a separate evidence scope.

In plain language, 0.4.0 aligned the rule that evidence must prove the exact unfinished operation and target. It did not copy every Codex feature, and it did not include changes introduced later in Codex 0.11.0.

| Behavior | DSH 0.4.0 status |
| --- | --- |
| Evidence proves the requested operation, target, and result for a current open item | aligned with Codex 0.10.0 |
| Waiting or deferral must have a saved, typed reason | implemented in the DSH boundary model; live external work is rechecked before yielding |
| Quoted or reference text must not create executable requirements | implemented; Codex 0.11.0's more specific correction-target rules still need a separate regression review |
| A mutation needs a current root-user instruction naming the action and exact target | implemented through DSH's native `context_guard_action` path |
| A high-risk publication needs a one-shot ticket bound to the exact candidate | not implemented |
| Cleanup and completion stay inside an explicit work unit | not implemented |
| The four new 0.11.0 incident families and protocol-specific benchmark runners | not implemented; DSH currently consumes the reviewed portable fixture layer only |
| Codex Hook cache, `PreToolUse` wiring, and installer recovery | not applicable to the DSH host; equivalent behavior must use DSH-native tools and lifecycle events |

The 0.4.0 implementation baseline keeps the v0.3 digest and conformance work and adds:

- Proof obligations that must name a current pending item and use evidence matching the requested kind, surface, subject, operation, and outcome.
- Bounded subject readback, scope coverage, state verification, and replayable `sessionQuery` state.
- Fail-closed rejection for tampered asset or scope digests, empty subject sets, and evidence imported from another session.
- The alpha.3 host cohort as the implementation baseline: DSH `0.1.2-alpha.3`, dshmarket `1.39.0`, and Cordis `4.0.2`.

Retained from v0.3.0:

- Digest v3 derivation, byte-mirror pinning, and 29-vector agreement.
- All-case portable semantic fixture runner implemented as a thin adapter over production derive/checkpoint/boundary/Goal/stop functions, without fixture-ID rewrites or skipped cases.
- Assistant-prose diagnostic-only stop decisions and typed boundary
  qualification/effectuation with phase-specific fault results.
- Exact semantic action/target binding, explainable checkpoint rejection, and
  resolution/effect/state role closure for all ten stateful actions.
- Exact paired optional Goal state/tool peers, supported-host/action manifests, injected active
  graph identity, unknown-host fail-closed behavior, and pre-mutation gating of
  the Guard-owned `update_goal(action=complete)` path.
- Legacy generic-run and unprovable-authority fail-closed migration behavior.

This is not a full product-parity claim. It does not copy the Codex private ledger, Hook lifecycle, cache, or installer, and it cannot prevent all trusted in-process Goal/session bypasses.

Main CI run `33540907051` passed the implementation baseline. The exact 0.4.0 package later passed same-byte native macOS and Windows acceptance and was published from annotated tag `v0.4.0`; exact release and public-readback identities are recorded in [`LOCAL_ACCEPTANCE.md`](LOCAL_ACCEPTANCE.md). Historical candidate results remain bound to their recorded SHA-256 values and never transfer to changed bytes.

## Follow-up identified against Codex 0.11.0

DSH needs a deliberate follow-up, not a line-for-line port. The highest-value shared gap is execution-time authorization for public release identities. DSH already routes supported mutations through `context_guard_action`, so the next design should extend that native path with a one-shot authorization record bound to the exact candidate and input instead of copying the Codex `PreToolUse` Hook.

Work-unit scope and correction attribution are also shared semantic gaps and should gain portable regression cases before implementation. Stop-disposition handling is partly equivalent already, so it should be compared with the 0.11.0 cases before code is changed. Codex cache repair, Hook trust, and plugin installation remain Codex-only. Incident-corpus tooling may remain owned by Codex, while reviewed platform-neutral cases continue to be mirrored here.

## 0.4.2 and 0.4.3 product boundaries

The 0.4.2 release retained these exact mirrored fixtures and the recorded upstream pin. Its DSH-native rebinding, bounded checkpoint output, and recovery changes do not establish parity with later Codex releases. `upstream-deltas.json` is a dated comparison snapshot (refreshed 2026-09-16 for the 0.6.3 target; originally the 2026-09-03 audit): its `currentRelease` fields name the releases compared then, not a live latest-version lookup. Refreshing that comparison requires a separate upstream audit; it does not happen merely because either product releases a newer version.

The 0.4.3 core policy changes DSH-specific manifest values, not the shared digest-v3 encoding or byte-mirrored fixtures. Core manifest version 2 and `dsh-core/v1` produce a fresh identity after actual-graph inspection. Legacy cohorts remain historical inputs. Market service adapter `context-guard.service.v2` uses version `2.0.0`; old restart credentials cannot become new-instance credentials. Package apply remains a disk-state operation, and unavailable restart work remains pending.

## 0.6.0 shared contract status (2026-09-14)

Version 0.6.0 implements the C01–C12 contract that the DSH 0.6.0 development
plan shares with a planned Codex Context Guard 0.14.0. The table below states
what this repository actually implements and which part of it is proven by
production-chain tests. It is not a parity claim: the two products still have
separate runtimes, persistence, lifecycle, and scheduling, and the shared
artifacts are not mirrored (see below).

| Contract | DSH 0.6.0 implementation | Production-chain evidence |
| --- | --- | --- |
| C01 source spans | UTF-8 byte half-open spans of the original root text, bound to the message digest; per-message coverage records | `tests/domain/v060-bounded-choice-spans.test.ts` |
| C02 one interpretation | Four semantic slots plus a coverage view; the open set has one implementation in `domain/closure.ts` | `tests/domain/v050-diagnosis.test.ts`, `v060-portable-v2.test.ts` |
| C03 delivery | Trusted delivery over the host's own turn structure, separate from execution certification | `tests/domain/v060-units-delivery.test.ts`, S01/S02/S08 cases |
| C04 units and closure | Derived units, delegation lineage, required descendants, ancestor constraints, and a v2 unit-closure certificate | `tests/domain/v060-unit-closure.test.ts`, `v030-certificate.test.ts` |
| C05 conditions and Stop | Per-action conditions and immediate-work judgement; unchanged waiting and bounded-correction budgets | `tests/domain/v051-wait-lifecycle.test.ts`, `v051-goal-lifecycle-composed.test.ts` |
| C06 responsibility tiers | `standard` / `strict` / `release`, orthogonal to activation; strict demands the proof the user asked for and adds no ordinary approval | `tests/domain/v060-strict-policy.test.ts` |
| C07 targets and identity | Trusted question round-trips, bounded file choice, path/type scope, separate sandbox approvals | `tests/domain/v060-selection-clarification.test.ts`, `v051-target-identity.test.ts` |
| C08 clarification | Atomic verbatim supersession with both revisions kept; evidence invalidation only on a real change | `tests/domain/v060-selection-clarification.test.ts` |
| C09 proof | v2 manifest, capability matrix, subject/source/operation binding, explicit unavailability; a presented proof is persisted with the checkpoint call and re-bound at replay, so a tampered or omitted proof cannot restore a certificate | `tests/domain/v060-proof-v2.test.ts`, `v060-proof-production-chain.test.ts` |
| C10 explicit release | Contracts (with the candidate revision AND the closure certificate's identity frozen at adoption), reservations carrying the observed SRI, reconciled settlements, named candidate identities read from trusted producers, a callable trusted recovery entry, pre-effect refusals, and an honest coverage surface | `tests/domain/v060-release-migration.test.ts`, `tests/tools/v060-release-chain.test.ts`, `tests/tools/evidence.test.ts` |
| C11 fresh projection | Every public read/control entry flushes, re-snapshots, and re-derives; a failed flush reports unavailability | `tests/tools/prepare-fresh-projection.test.ts`, `tests/flush.test.ts` |
| C12 migration and diagnosis | Seven-class reason mapping, rule-set report, preserved identities, rollback precondition | `tests/domain/v060-release-migration.test.ts`, `v042-recovery-migration.test.ts` |

### Scope rulings and protocol difference table (2026-09-14)

A concentrated review of the `0dce898` candidate found eight defect families and
asked for two scope decisions. Both were decided by the coordinator on
2026-09-14 and are recorded here as facts, not as a parity claim:

1. **The v2 fixture stays a DSH-authored candidate; cross-language parity stays
   open.** The upstream has not frozen a v2 specification, so the shared gate is
   recorded as a cross-repository pending item owned by `codex-context-guard`.
   Nothing here claims C01–C12 alignment with that product.
2. **The release profile's protectable surface is `npm_publish` only.** The
   `git_tag` and GitHub Release operations are reported as
   `release_operation_unrouted` with `attribution: scope_reduction` — the gap is
   the missing Guard-owned route, which a later release can add — and only a
   composite runner is reported as an opaque host boundary. The coverage table
   is machine-readable precisely so this distinction cannot be flattened into
   "the host does not support it".

| Difference | Value here | Reason |
| --- | --- | --- |
| Action manifest version | stays `1` | The new preparation fields live in the `actionPreparation()` descriptor (plugin output), not in `ActionSpec`; no shipped manifest byte changed. |
| Boundary protocol | stays `1` | No unit-attribution field was needed; adding one would change every boundary digest without adding a guarantee. |
| Release `ref` observability | a contract that declares `ref` requires an observed ref | `npm_publish` observes the tgz and, when the contract names a ref, the local repository's own answer; a declared-but-unobserved `ref` is refused as unresolved rather than skipped. |
| Release artifact identity | three named identities, never conflated | The commit (`gitHead`), the byte SHA-256 and the npm SRI are different facts; the legacy `artifactDigest` alias is split by its own shape. |
| `git_tag` / GitHub Release / composite runner | refused before any effect | Approved scope reduction for the first two (no Guard route yet); opaque host boundary for the third. |

### P0 deviation record (2026-09-14)

The P0 specification's identity table assigned new protocol numbers to every
surface it lists. Two of them are deliberately NOT changed here, and recording
that is more honest than bumping a version without a semantic change:

| P0 item | P0 value | 0.6.0 actual | Reason |
| --- | --- | --- | --- |
| Action manifest version | `2` | stays `1` | The new action description fields live in the `actionPreparation()` descriptor, which is plugin output generated per action, not an added `ActionSpec` wire field. The shipped `manifests/action-manifest.v1.json` is byte-aligned with `ACTION_MANIFEST.actions` by a test, and no field of it changed. Bumping the number alone would create a new identity for identical bytes and invalidate a mirror for nothing. |
| Boundary protocol | `2` | stays `1` | The planned "unit attribution" fields were not needed: a boundary already names the exact obligations it covers through `qualificationIds`, and C04's closure never consults boundary ownership. Adding a field would change every boundary candidate digest and break old-boundary replay without buying a semantic guarantee, so the record shape is unchanged. |

Everything else in the P0 identity table is implemented as specified: the
`v5.0.0` session boundary, Stop protocol `3.0.0`, certificate version `2`,
proof protocol `0.6.0` in the new `ccg.proofManifest.v2` domain, the
`ccg.certificationDigest.v4` field table, unchanged adapter identities, and the
three new release-record prefixes. Every v3 digest domain and the 29 mirrored
golden vectors are byte-identical.

### Unfinished shared artifacts

Two shared artifacts are deliberately incomplete, and neither is described here
as done:

- **The v2 fixture is a DSH-authored candidate, not a mirror.** The upstream
  repository `GreenLv/codex-context-guard` was at
  `ce667adefd716f829fb1fb070b3089e789ed74c3` with no frozen v2 fixture when this
  candidate was prepared (verified by a live `ls-remote` read of `refs/heads/main`,
  and by the local checkout's contents). `tests/fixtures/conformance/context_guard_semantics_v2.candidate.json`
  therefore carries `fixtureVersion: 2.0.0-candidate.1` and `status:
  "dsh-candidate"`, and a test asserts that identity. `UPSTREAM_PIN.json` still
  pins only the unchanged v1 mirrors and is not refreshed by this release.
- **Cross-language parity is not established.** The Python and TypeScript
  projections have not been compared on the v2 input family, because the
  reference implementation for that family does not exist upstream yet. The
  digest-v3 vectors remain the only byte-level cross-language agreement
  evidence, and they are unchanged.

0.6.2 adds one more explicitly incomplete shared artifact, and describes it the
same way:

- **D062-04 uses measured, bounded cross-end cases.** Contract and proof
  recordings are supplemented by `codex-0.13.9.lifecycle.json`: the recorder
  creates disposable synthetic prompt ledgers through Codex's own entrypoints,
  then exercises silent pending, missing-proof correction, user wait and the
  same opaque mixed-result command used by DSH. These are function-level
  lifecycle checks, not native application acceptance or full product parity.
  See [the result contract](CROSS_END_RESULT_CONTRACT.md). No upstream mirror,
  digest domain or pin changes.
- **Deferred capability:** an explicit distinction between action-event and
  state-outcome obligations needs a separate public contract; it is not added
  by 0.6.2. The existing v2 mirror and release-producer gaps above remain open.

The consequence is stated plainly: this repository does not claim "C01–C12
core alignment" with Codex Context Guard. It claims that its own C01–C12
implementation is present and covered by production-chain tests, and that the
shared spec/fixture freeze, the mirror, and the cross-language comparison are
open items owned by the upstream.

## S01–S12 coverage in this repository

The v2 candidate carries 25 cases across every family. Each case runs through
the production derive/delivery/closure/Goal chains, and the runner computes its
actual values from the events and the projection only — it never reads an
expectation to decide a result, and it has no branch on a case id or family.
Coverage by family:

| Family | Cases |
| --- | --- |
| S01 delivered questions | delivered question closes; execution with a trailing question stays open |
| S02 same-prefix variants | execution tail stays open; negation keeps the constraint |
| S03 update/modify objects | document update becomes a bounded modify; a non-file object stays honestly unresolved |
| S04 conditions | conditional wait stays pending; a future-tense push stays evidence-gated |
| S05 first step | the persisted requirement is stable across messages |
| S06 trusted selection | the paired directory answer and the separate approval record |
| S07 clarification | verbatim refinement supersedes; an independent task switches unit |
| S08 delivery and delegation | aborted turn never delivers; delegation opens a required descendant; the Goal gate demands a certificate |
| S09 proof | requested visual proof cannot be faked; a readback obligation stays open |
| S10 policy | release and strict never block ordinary work; the tier does not imply a contract |
| S11 release | no contract, unprotectable adoption, in-flight operation, and consumed ticket |
| S12 migration | a legacy session and a v5 session each report their own rule set |

Negative coverage lives beside it: the independence suite corrupts every
expectation field and asserts that the actual result is unchanged while the
comparison reports the mismatch, and separately detects wrong interpretation,
closure, delivery count, turn binding, delivery surface, open items, reason
codes, goal gate, correction, selection/approval/supersession counters, reason
classes, release state, and migration facts.

## Validation boundaries

- `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm
  lint && pnpm build` covers deterministic tests and build health on this
  machine. That is not native platform acceptance: Web/Headless profile load,
  real checkpoint/boundary/Goal round flows, and macOS/Windows native
  acceptance are separate records and are not claimed here.
- Deterministic test evidence never substitutes for npm/GitHub Release
  identity readback or the identity migration gates recorded in the plan for
  the v0.3.0 release.
- The delta ledger separates source facts, plan status, implementation
  status, deterministic tests, native platform acceptance, and release
  readback; keep all six aligned when a capability moves.

## 0.6.3 narrowed execution qualification (DSH-side)

The DSH side now decides EXECUTION QUALIFICATION once per clause, before any
partition: a clause whose own reading is a question, an explanation, an
investigation, a reported question or a quoted scope is `restricted`, and one that
asks nothing is `granted`. The qualification is stored on the item
(`executionQualification`), inherited by every partition child, and consumed by
both the mutation gate and `context_guard_prepare`; a record captured before the
qualification exists is refused rather than read from its stored disposition and
is flagged `legacy_missing_execution_qualification` by the upgrade check. The
same-clause "prove the complement closed" rules of the earlier 0.6.3 revisions are
removed, so there is exactly one authorization path.

What this means for cross-end work: a question and a coordinated action in ONE
clause is an UNDECIDED obligation on the DSH side, where earlier revisions recorded
the action as an order. The machine-readable ledger
`tests/fixtures/cross-end/core_alignment_0_6_3.json` records that reading at
revision 4; the Codex side is unchanged, both ends still refuse to let an answer
close the install, and no feature, runtime or release equivalence may be inferred
from the shared fixture. See [CONTRACT_REVISION_0_6_3.md](CONTRACT_REVISION_0_6_3.md).
