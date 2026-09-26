# DSH 0.1.7-rc.2 adaptation evidence

Status: **local 0.8.0 candidate; native acceptance and publication pending**. This record follows [the development plan](DEVELOPMENT_PLAN_DSH_0_1_7_RC2.md) and its unchanged [planning inputs](dsh-0.1.7-rc.2-planning-evidence.json). It does not authorize daily-profile changes, Git push or publication.

## Identity and phase status

Baseline: `c6e14cd8aaf755e8cfb41a343c67e6e64659969c` (0.7.1), checked against remote main before editing. Upstream `dsh-v0.1.7-rc.2` resolved to `477b4f420553e8a52c2fbccc464d7561b239c443`. Existing plan/evidence files were preserved. Work is on `codex/dsh-017-rc2`. The canonical packer records the final exact commit in `release-artifact.json` and the package `gitHead`; this source document does not predict that self-referential identity.

- **P0/P1:** 46 critical package tarballs verified against SRI; tarball, executable and package-manifest SHA-256 recorded in `manifests/rc017-rc2-byte-audit.json`. Active TypeScript and JSON identities agree; only rc.2 is admitted. Both CLI profile templates compose in an isolated home. Runtime graph and installed bytes were read back without changing the supplied runtime. Populated profile-local plugin graphs remain native acceptance work.
- **P2–P5:** lifecycle ownership, V4 and flat ToolMessage reading, Jobs SessionId, shell promotion/truncation and Goal composition changes are implemented. The limitations below remain explicit.
- **P6:** current English/Chinese README and changelogs, compatibility, upgrade and API audit updated. Versioned native drivers retain their annex schema. Their injected tool traces now include V4 turn/step/advertised-call relationships and matched compaction records, checked by the published V4 restore validator with a missing-advertisement negative. This is distinct from running the driver on a frozen artifact.
- **P7:** local checks are recorded below. Local candidate commit and canonical packing were subsequently authorized by the coordinating installation task. Exact identity and reproducibility are delivered in the external artifact receipt. Remote CI and publication are not authorized by that local preparation.
- **P8:** no same-tgz macOS/Windows Web/Headless or real-model acceptance. No profile switch, push, tag, npm upload or Release is authorized by this record.

## A01–A16

“Covered” below means the listed source/composition evidence only. A pending native condition is not a pass.

| ID | Current evidence | Unfinished condition |
| --- | --- | --- |
| A01 | Exact rc.2 metadata; old/future/stable/mixed/missing/SRI negative cases; single 46-row cohort; real runtime graph and module/manifest bytes pass | Populated Web/Headless installed Guard graph and exact artifact |
| A02 | Real scoped AgentRegistry awaited registration, T0 seq=0, cancelled-signal rejection and later initializer failure rollback; real AgentLoop first request and V4 JSONL restore | Native first-request observation |
| A03 | Same-Agent disable/re-enable, existing-Agent attachment, disposal cleanup through real ToolRuntime | Native Web configuration reload; independently count all guard/listener registrations across scoped-Agent reload |
| A04 | Actual V4 header digest/restore; V3 rejected as current identity; real loop persisted restore | Native compact/restart identity on the exact artifact |
| A05 | Actual fork builder closes open turn as `forked`; no ordinary delivery from that close; existing child/session identity negatives | Full parent/child native fork certificate attempt |
| A06 | Developer/tool-registry/scheduler/subagent/plugin source negatives; existing source attribution and recovery suites | Dynamic native registry notifications and scheduled/subagent end-to-end behavior are not certified |
| A07 | Actual published bash/pwsh renderer positive/nonzero/stopped/runner-failure/truncation cases; isolated actual bash success/nonzero/cancel execution passed | PowerShell execution unavailable on this host; exact-artifact native shell still pending |
| A08 | Promotion containing PASS/exit 0 remains unknown even with trailing prose; actual bash promotion plus Jobs owner fence and completed readback passed | The original-call/job/owner/terminal/target-readback certification chain remains unavailable. A completed Jobs row alone cannot upgrade partial output; no business rerun is requested |
| A09 | Real JobsLocal same SessionId, foreign owner, mismatched Agent/session, unknown/deleted job and terminal read; throwing service remains unavailable | Native application Jobs integration on the exact artifact |
| A10 | Omitted workdir positive, wrong session/provider/path and modified module negatives; real installed policy/executor class and byte checks | Windows actual filesystem/provider behavior; remote providers remain unavailable |
| A11 | Existing native-file/PTC lineage suites now read rc.2 flat persisted tool results; outer success cannot replace failed child | Actual rc.2 native PTC/file tool execution and persistence on both platforms |
| A12 | 0.7.1 recovery/prepare/checkpoint suites retained; real V4 loop and new source shapes | Model continuation after compact/side-question is still not established |
| A13 | Real Goal/ToolRuntime and round-driver tests, flush failure and monotonic denial; no Goal service in ordinary lifecycle composition | Native adopted Goal with real-model complete success and rejection |
| A14 | Existing old-certificate eligibility and explicit V3→V4/old-host private-ledger context mismatch fail closed without changing stored bytes; no digest vectors or historical ledger rewritten | Actual DSH V3→V4 migrated session with old ledger, ordinary continuation and strict release diagnosis |
| A15 | Versioned native driver/preflight unit checks updated to the sole rc.2 cohort | Canonical artifact identity from the separate packer receipt; exact CI, both platforms and both profiles, same digest, strict-noop/parity/restart/cleanup annexes |
| A16 | Deterministic loop model stubs remain identified as stubs | Real model ordinary work, compact/resume, promoted wait and adopted Goal scenarios with independent retained results |

## Reproduction and evidence boundaries

Run the affected bundle with `node tests/run-repair-families.mjs rc017-adaptation`. Setting `DSH_RUNTIME_ROOT` to an isolated rc.2 runtime enables the otherwise explicitly skipped real graph/provider checks. `tests/rc017-native-shell.node.mjs` is a local source probe of the published bash executor and Jobs; it is not a versioned native-artifact annex and is not run on Windows.

Synthetic graph/config tests isolate injection and strict-noop from installed byte authentication. The separate actual-runtime tests check the unmocked byte gate. The shared core mirror, digest algorithm and golden vectors are unchanged. Current host identity and certificate authority never derive from historical test cohorts.

Local verification on macOS / Node 25.1.0 / pnpm 11.22.0:

- Vitest: **2605 passed, 2 Windows-only tests skipped** with the isolated runtime supplied. The skipped checks are Windows Session drive identity and exact cmd-shim execution.
- Typecheck, lint, build, release-pack tests (2), npm-stat tests (10), package inventory dry run, documentation audit and `git diff --check` passed. Lint has warnings; they are not represented as a warning-free result.
- Python: **95 passed**, including native-entrypoint/cohort, document audit and tarball-audit tamper/inventory cases.
- Published input replay: **46 tarballs / 215 JS, CJS and package-manifest files passed**.
- Local source probes: actual bash terminal/cancel/promotion/Jobs and the native-driver V4 restore positive/negative both passed. They do not constitute exact-artifact host acceptance.
- Core mirror and digest fixtures were unchanged. Repeated generated-output checks and canonical-package reproducibility are recorded by the local handoff receipts.

A passing local matrix cannot close the native and artifact conditions in this table. Candidate CI is required before spending native-platform acceptance slots; no remote dispatch was authorized here.
