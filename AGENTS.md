# DSH Completion Guard repository instructions

These instructions apply to agents maintaining this repository. User
instructions and platform approval boundaries remain authoritative. They do not
change the installed plugin runtime or grant release authority.

## Product and repository boundary

- This repository owns the `dsh-completion-guard` implementation, committed
  `dist/`, manifests, host-lock tooling, package metadata, documentation,
  tests, CI, tags, npm identity, and GitHub Releases.
- Keep Codex Context Guard as an independently versioned upstream semantic
  source. Bind mirrored fixtures to the exact upstream commit and hashes; do
  not infer feature, runtime, or release equivalence between the products.
- Preserve fail-closed behavior for authority, evidence, target identity,
  executable identity, expected transitions, host locks, boundaries, and
  completion certificates.
- Preserve unrelated work and keep one mutation owner per candidate
  worktree/branch, shared remote ref, tag, package version, and release.
  Disjoint worktrees may progress independently. Other agents may perform
  independent read-only review or platform-owned validation.

## Change-driven validation

- Inspect the exact diff before selecting checks. During a repair loop, run the
  smallest reproducer and owning Vitest file first. For schema, digest, or
  mirror changes, close the affected input family with portable conformance and
  cross-language parity before running the full matrix.
- The full deterministic candidate checks are `pnpm run typecheck`, `pnpm run lint`,
  `pnpm test`, `pnpm run test:release-pack`, `pnpm run test:stats`,
  `pnpm run build`, `pnpm run pack:check`, the repository documentation audit,
  its unit test, and `git diff --check`. Require `git diff --exit-code -- dist`
  after build when generated runtime bytes are expected to be current.
- At freeze, run these checks once on a representative platform. Passing exact
  candidate CI may supply equivalent checks rather than repeating them locally;
  preserve required exact-commit CI and rerun any check whose relevant inputs
  or execution environment differ. Cross-cutting changes and unknown coverage
  retain the broader checks; use focused reproductions during repair.
- Use the required PR validation summary for mapped fast checks. Candidate CI
  runs the full suite on Ubuntu/Node 24.9.0 (the exact minimum supported
  runtime) and the platform smoke group on all remaining Ubuntu/macOS/Windows
  and Node 24.9.0/24.x combinations. The selector
  expands all six lanes to the full suite for sensitive or unknown inputs;
  manual dispatch always requests the full matrix. Static, package, build and
  documentation contracts run once outside those lanes. Each selected lane is
  required; a tag does not rerun the matrix.
- Use GitHub candidate CI as the portability screen before spending a
  native-platform slot. CI never substitutes for native Web,
  Headless, shell-shim, restart, credential, or application acceptance.
- Reuse evidence only when its exact commit or artifact subject and all relevant
  inputs remain unchanged. Rerun the failed gate and downstream invalidated
  gates, not unrelated successful gates.
- npm artifact identity follows the `package.json` package inventory: `bin/`,
  `dist/`, `cordis.patch.yml`, packaged README/LICENSE/changelog/docs, and
  `manifests/` plus npm's mandatory manifest files. Changes under `.github/`,
  `scripts/`, `tests/`, `AGENTS.md`, or `validation-map.json` are repository/CI
  changes and do not change the package payload inventory. However, the
  canonical packer injects the exact `gitHead`, so repacking from any different
  commit still creates a new artifact identity. Changing `package.json`,
  generated runtime, or any listed package byte changes the payload itself.

## Coordination and reader quality

- For repeated implementation/review handbacks, use the failure-family closure
  mode of `multi-repository-development-orchestration` when available, including
  in this single repository. Otherwise apply the same local rule: a claimed fix
  followed by another violation of the same invariant needs a shared-cause and
  entry/field matrix review before another freeze recommendation. Batch findings,
  retain unaffected passing evidence, and continue once the finite agreed gates
  pass; new reproducible contract failures remain blockers.
- Use `node tests/run-repair-families.mjs --list` to select the affected named
  bundle; see `tests/repair-families.md` for production paths and coverage limits.
  These bundles do not replace the full candidate matrix at freeze.

- Keep a single coordinating owner and one writer per candidate worktree.
  An authorized external harness may implement a complete batch and return
  its diff and evidence for concentrated acceptance; do not add another review
  merely because ownership changed. Repair affected findings without replaying
  unchanged accepted work.
- Pause related monitoring for missing authorization, login or manual handback;
  an unavailable channel needs a concrete resume event, not repeated polling.
- Ordinary releases do not automatically require a 32-cell performance study or
  real-model workload. Select these when the changed risk or a task contract
  requires them. Before formal performance measurement, bind representative
  scenarios and subjects, practical absolute and relative tolerance, sample and
  noise handling, and the decision for incomplete observations. Prior failures,
  limitations and explicitly adopted task contracts retain their meaning.
- Review important README, install/upgrade and release prose for human
  readability before publication. Explain useful actions and results before
  internal terms, preserve necessary technical precision in references, and
  fix actual comprehension failures. Valid links are not readability evidence.
- One user confirmation may cover an exact prepared action list. Each release
  action still uses its required checks and host approval. Exact tickets apply
  only to an explicitly selected or adopted ticketed contract; never silently
  downgrade one. Preserve covered authorization and recheck actual scope changes.

## Candidate and artifact freeze

- Finalize the version, both changelogs, packaged README/docs, manifests,
  package file list, and committed `dist/` before freezing a release candidate.
  Any later change to a file shipped by npm creates new package bytes and
  invalidates prior exact-artifact acceptance.
- Generate release bytes only from a clean repository root with:

```text
node scripts/release-pack.mjs --source . --output-dir <outside-repository-dir>
```

- Treat the emitted tgz, `SHA256SUMS.txt`, and `release-artifact.json` as one
  frozen set. The artifact must embed the exact full Git HEAD and repeated packs
  must be byte-identical. Never repack on Windows, macOS, CI, or immediately
  before publication.
- Native macOS and Windows exact-artifact runs must use the same frozen tgz and
  separately establish install, strict second no-op, package parity, host-lock
  readback, required Web/Headless lifecycle, cleanup, and any explicitly
  required real-model boundary. Keep capability skips visible.
- Desktop adopts `dsh-desktop-bound/v2` layered no-op acceptance: install Guard
  alone, then immediately repeat its add and require every tracked file plus the
  Guard package tree to be byte-identical (`single_package_strict_noop`). Only
  after that gate, add the inert update fixture and repeat the multi-package add
  (`multi_package_semantic_noop`). In that second gate only object-key order in
  `node_modules/.modules.yaml` may differ; complete values, array order and types
  must match under the observed strict JSON format. Duplicate keys, invalid or
  unsupported JSON/YAML, other tracked byte changes and Guard tree changes fail.
  Never normalize or restore installed metadata, retry to obtain a pass, or
  relabel historical Desktop v1 strict failures as v2 passes. pnpm 11.7.0's
  asynchronous hoisted-location insertion is a known host serialization limit;
  this contract does not patch or establish a fix in the signed host.
- Invoke the repository-owned versioned native-acceptance entrypoint for
  portable or host-bound runs. It emits a redacted annex bound to the source
  commit and artifact digest; a handwritten command transcript is not an
  equivalent interface.
- Add `--preflight` to the intended native command before expensive execution.
  It checks source/artifact identity, tool availability, declared host cohorts,
  result paths, and same-invocation child/process-query access without installing
  packages or starting hosts. A denied capability must use the normal platform
  approval path; a successful check in another shell is not transferable.
  This does not establish restricted-child access, loaded instances, credentials, target
  dependency graphs or real-model behavior; the actual run still checks those
  applicable surfaces. Store `--output` and any `--transfer-receipt` at distinct,
  unused paths outside the source checkout and disposable fixtures. Missing
  parents are created; existing results are preserved. Remove `--preflight`
  to run acceptance. Recover a missing transfer from those files before rerunning.
  With `--transfer-receipt`, a private `*.transfer-intent.json` binds the
  original subject and transport before execution. `--recover-transfer` reads
  that intent, the existing `--output`, exact source and tgz, and writes only
  the missing receipt; it never reruns acceptance or turns a failed native
  result into a passing one. Old runs without an intent cannot use this recovery.
  A timed-out child or uncertain
  process cleanup leaves the owned fixture and an explicit failed cleanup state;
  diagnose ownership and quiescence before any retry or disposal. For any
  repeated failed native run, first retain and diagnose the original failure;
  record the changed input or demonstrated corrected external condition before
  starting a new run. A fresh output path alone is not a correction.

## Release identity and authorization

- When a release changes supported DSH versions, verify the published npm
  manifest and the consuming market's compatibility response separately. The
  market may display an installed version beside cached `latest` metadata from
  an older release. Read its cache version/range and the actual discovery API
  result before claiming the card is current. A package-only audit is not UI
  acceptance. If npm is correct, repair only the affected cache through the
  supported route (or a backed-up, scoped cache update), preserve other entries,
  and honor user-owned restart boundaries; do not republish for stale cache.
  Record disk-cache repair, running-process readback and rendered-card evidence
  separately, with pending restart or mirror propagation explicit.
- Keep implementation, deterministic tests, CI, native source acceptance,
  exact-artifact acceptance, credentialed behavior, main, tag, npm publication,
  GitHub Release, and public readback as separate facts and permissions.
- Publish the already accepted tgz. Read back the annotated tag target, npm
  version, embedded `gitHead`, registry integrity, downloaded tgz bytes, GitHub
  Release target, and clean repository state.
- Never move a published tag, reuse a consumed npm version, weaken a failed
  identity gate after publication, or describe an incomplete publication as a
  complete release. Repair with a new version while preserving the historical
  tag and package facts.
- Do not commit credentials, raw transcripts, local absolute paths, temporary
  proof/annex files, runtime profiles, caches, or private session state.
