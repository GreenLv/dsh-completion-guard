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
- Run the complete local deterministic matrix when freezing a candidate, after
  a cross-cutting contract change, while diagnosing CI, or when focused tests
  cannot establish the affected surface. Do not rerun it merely because commit,
  push, or another phase follows.
- The full candidate matrix is `pnpm run typecheck`, `pnpm run lint`,
  `pnpm test`, `pnpm run test:release-pack`, `pnpm run test:stats`,
  `pnpm run build`, `pnpm run pack:check`, the repository documentation audit,
  its unit test, and `git diff --check`. Require `git diff --exit-code -- dist`
  after build when generated runtime bytes are expected to be current.
- Use the required PR validation summary for mapped fast checks. Candidate CI
  runs the Ubuntu/macOS/Windows and Node.js 22/24 portability screen once on
  exact `main` candidates or manual dispatch; a tag does not rerun that matrix.
  Static, package, build, and documentation contracts run once outside the six
  independent test lanes so a failed lane can be rerun without recreating a
  matrix group.
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
- Invoke the repository-owned versioned native-acceptance entrypoint for
  portable or host-bound runs. It emits a redacted annex bound to the source
  commit and artifact digest; a handwritten command transcript is not an
  equivalent interface.

## Release identity and authorization

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
