# DSH Completion Guard 0.5.1: implementation and candidate evidence

Updated: 2026-09-11. This record describes source and deterministic test evidence for the 0.5.1 candidate. It is not a release or daily-install receipt.

## Current status

The local implementation covers P1-01—P1-04 and F01—F12 through the production entry points listed below. The real host fixture exercises normal admission, bounded stopping, and disk recovery. A follow-up regression now also checks that checkpoint and recovery retain the exact root wait after a compaction summary and strict Session restore.

The follow-up fixes recovery guidance: an outstanding root wait now takes precedence over target/evidence collection advice. It leaves execution authorization and completion certification unchanged. CI setup now installs the isolated host fixture, and the host-loop test imports file URLs directly so Windows drive letters and escaped paths are preserved.

The local candidate matrix passed (48 files, 804 passed, one Windows-only skip). Cross-platform CI, host-bound macOS/Windows acceptance and real-model behavior remain separate gates. No tag, npm publication, GitHub Release or daily-profile installation is recorded here.

## Implementation coverage

| Family | Production entry point | Evidence | State |
| --- | --- | --- | --- |
| F01 negation | `interpretMessage` → `deriveProjection` → `authorizeMutationFromProjection` | `v051-instruction-semantics` (24), `v051-target-identity` (17) | covered |
| F02 executee | same | `v051-instruction-semantics` | covered |
| F03 condition / narration | same | `v051-instruction-semantics`, `v051-resume-and-bounds` (76) | covered |
| F04 quoted / code / notice sources | `deriveProjection` source filter | `v051-instruction-semantics`, existing source tests | covered |
| F05 first input, compaction, replay | `agent/pre-step` preview + durable fold | existing T0/T1 tests | covered |
| F06 armed Goal + no progress | `decideTurnBoundary` → `handleGuardTurnStopping` → real `GoalService.disarm` | `v051-goal-lifecycle-composed` bounded-stop case | covered |
| F07 real vs fake progress | `progressFingerprint` in `decideTurnBoundary` | composed suite: repeated fingerprint stops; a changed contract revision keeps continuing and never disarms | covered |
| F08 pause / wait release | wait release and establishment ✔; activation order ✔; root pause routing ✔ (`handleGuardTurnStopping` → host `pause`) | `v051-goal-lifecycle-composed` (wait case, 4 pause cases incl. quoted/tool/negated counterexamples), `v051-activation-order`, `v051-target-identity`, `v051-resume-and-bounds` | **covered** |
| F09 flush / stale ref / readback / unsupported lock | `handleGuardTurnStopping` → `effectuateBoundary` | `v051-goal-lifecycle-composed` (10), `v051-wait-lifecycle` (4, unit double only) | covered |
| F10 completion claim vs handover | `classifyCompletionClaim`, `observeAssistantOutcome` | existing stop-policy tests | covered |
| F11 version and graph outcomes | `evaluateHostLock`, `combineHostPolicy`, CLI readback | `v051-host-version-production` (9), `v032-host-cohort` | **covered** |
| F12 paraphrase replay | `interpretMessage` + `deriveProjection` | `v051-instruction-semantics`, `v051-clause-partition` (18) | covered |
| P1-01 unified interpretation | `semantics.ts` in the capture path | the three semantics test files | covered |
| P1-02 bounded no-progress stop | `decideTurnBoundary` → `handleGuardTurnStopping` → real `GoalService.disarm`, over the real loop in `v051-host-loop` | `v051-goal-lifecycle-composed` bounded-stop case; `v051-host-loop` scenario 2; `v051-clause-partition` budget cases | **covered** |
| P1-03 durable wait + trusted release | `handleGuardTurnStopping` (automatic establishment) + `deriveProjection` (release) | `v051-goal-lifecycle-composed` wait case, `v051-activation-order`, `v051-target-identity` | **covered** |
| P1-04 version in production | see §5 | `v051-host-version-production` | covered |


## Real host and recovery evidence

`tests/domain/v051-host-loop.test.ts` uses the real AgentLoop, AgentRegistry, GoalService, SessionStore, projection registry and JSONL persistence backend from the isolated fixture. Only the model and outer I/O are simulated.

1. Normal admission observes `agent/inbox/claimed`, pre-step entry, a production round message and the deterministic model response, with no agent error.
2. Bounded stopping begins with an armed active Goal. Production spends the no-progress budget, establishes and flushes a boundary, disarms the same Goal and reads it back. Counts are sampled after the legitimate correction turn settles and stopping takes effect; subsequent round/model counts do not increase.
3. Disk recovery destroys host A, creates host B over the same temporary storage root, and reads the session with `readStoredLog(path, expectedId)`. The accepted boundary identity and candidate digest, budget keys/attempts, and pending obligation survive. Retrying the boundary returns `accepted_boundary_pending_effectuation`; a second disk read confirms no new attempt.

Scenario 3 establishes recovery and retry idempotency. It does not establish reapplication of the stop side effect after restarting the host. The running-host disarm is established separately by scenario 2.

`tests/runtime.test.ts` additionally checks the waiting obligation through recovery rendering at both 512 and 4000 characters, a compaction summary, strict Session restore, the registered checkpoint tool and the production pre-step recovery handler. The qualification, pending state and exact resume event survive; the notice does not instruct the agent to execute the reserved action. This is a deterministic hook integration test, not a real-model compaction acceptance run.

The earlier `lacks an identified message` error was caused by manually seeded fixture records missing an id. Production uses `createUserMessage`; the seed was removed and the tests now spend the budget through production. The host reader was not weakened and stored logs were not edited. Recovery of previously corrupted data was not tested either way.

## Fixture and historical-input boundaries

`tests/fixtures/host-composition/pnpm-lock.yaml` pins the DSH 0.1.5-rc.1 fixture graph separately from the root dependency graph. CI installs it using `pnpm install --ignore-workspace --frozen-lockfile`. It is a test dependency and is excluded from the npm payload.

`tests/tools/v042-rebind.test.ts` keeps historical message text and boundary notices as literal inputs; it does not derive its historical oracle from the current interpreter. Current clause behavior is tested separately.

## Validation history and current candidate

The preceding implementation batch reported 48 test files, 803 passed, one Windows-only shim skipped, clean types, lint with zero errors and 16 warnings, two release-pack tests, ten stats tests, documentation checks, and two byte-identical dist builds. Those are historical working-tree results, not evidence for the subsequent source changes or an exact commit.

The follow-up focused run passed 79 tests across runtime, diagnosis, recovery migration, checkpoint and wait lifecycle. The host-loop file independently passed all three scenarios. The existing workflow/selection/required-job checks passed 28 tests. A clean temporary fixture installation with pnpm 10.34.5 succeeded. The local host is macOS with Node 25.1.0; none of those results replaces the CI Node 22/24 matrix.

Final follow-up matrix: types clean; lint zero errors and 16 warnings; Vitest 48 files, 804 passed and one Windows-only skip; release-pack 2 passed; stats 10 passed; repository documentation audit zero errors/warnings; repository Python contracts 66 passed; reader review valid; whitespace clean. The source-only provenance-comment cleanup after that run changed no executable logic; the affected build was repeated and compared again. The bilingual changelog now records pending-confirmation recovery and the simulated-model fixture boundary. Its updated reader review binds the final four README/changelog documents; this implementation record is outside that receipt.

## Remaining acceptance and publication boundaries

- The Windows `dsh.cmd` shim is skipped on macOS. Windows CI must execute it; a skip is not a pass.
- Cross-platform CI is a portability screen. Host-bound Web/Headless lifecycle, restart, credentials and real-model behavior require their own evidence.
- CI generates and escrows one canonical tgz plus its artifact receipt for portable Windows acceptance. Later native runs must consume that same artifact; they must not repack it.
- No daily-profile install, start, restart, hot reload or write to daily DSH state has been performed by this candidate preparation.
- No source tag, npm publication or GitHub Release is authorized by this record.

## Upgrade guidance

See `README.md` and `docs/HOST_LOCK_UPGRADE.md` for installation, host-lock inspection and rollback. The host-lock tooling refuses an unaudited graph; acceptance must not inject a lock into a daily profile to bypass that refusal.

## Generated runtime identity

Two final builds are byte-identical. These are runtime file digests, not a tgz identity.

```text
3418be81c0bede17920377c4ff83c19d4ae59741d1b4dd60838bd7d1da7c4b98  dist/domain/index.d.ts
bcf77d87108ef49db8c5f86a46d95ea302dc0240ab2c49caeaf670afea846078  dist/domain/index.js
136ef69431fad50d8984a3dd7d13a39acb75c89364c116a4172cb208524c0305  dist/domain-b28rVjD6.js
e43323fe08458e41bf7be4c8da1536654d1adadc186b468b1aa6718394176e56  dist/index-Bk0D3slX.d.ts
cce7176400c8d0c9ffe504329e96f170c0882ee5d27251695ca715caf7ce5a70  dist/index.d.ts
8a23e3c80c2393836b84c4a5ff3efb94d0ea5b067c2fb64fbffa5e18a059ca8d  dist/index.js
```
