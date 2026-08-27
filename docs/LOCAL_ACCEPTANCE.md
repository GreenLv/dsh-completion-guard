# Local Acceptance

Deterministic checks and an isolated DSH_HOME composition smoke. These establish source correctness and load correctness, not full runtime behavior.

## 0.1.1 source candidate (2026-08-27, Unreleased)

The candidate was built on macOS from branch
`codex/0.1.1-bash-success-evidence`. The tested runtime domain bundle is
`dist/domain-DEXOzCqH.js` with SHA-256
`e8ad974b8263a2a25c7ef08ca3839097d3312c10d450b8520163c623e54881f9`.
The exact pre-commit source-tree and tgz digests are recorded in the generated
candidate manifest rather than embedded here: this document is itself part of
the npm archive, so embedding that archive's digest would change the digest.

Verified for this candidate:

- `pnpm install --frozen-lockfile`, typecheck, lint, all 106 tests, build, and
  package-content validation completed successfully on macOS.
- The candidate tgz composed into fresh isolated `web` and `headless` profiles.
  Both installed packages read back as `0.1.1`; a second identical add reported
  `Already up to date`, and hashes of the profile manifests, lockfile, composed
  patch files, and installed package manifest did not change.
- The 0.1.1 domain runtime replayed a completed real DSH Web log captured with
  `activation: always` and confirmed durability. Its foreground `bash`
  `pnpm typecheck` result contained ordinary stderr output and no
  `[exit code: 0]` marker; replay derived successful scope evidence and issued a
  certificate for all four matching open items with no rejected bindings.

Evidence boundary:

- The macOS Web result is a candidate-runtime replay of a genuine closed Web
  log, combined with isolated Web composition. It is not a claim that the
  unpublished candidate was installed into the user's live Web profile.
- No native Windows 0.1.1 real-model run has been performed. The published
  0.1.0 PowerShell acceptance below remains historical evidence and does not
  establish 0.1.1 Windows acceptance. The 0.1.1 release gate therefore remains
  open until that Windows run is completed.

## Deterministic checks

```sh
pnpm install
pnpm run typecheck   # tsc --noEmit
pnpm test            # vitest
pnpm run lint        # oxlint
pnpm run build       # tsdown
pnpm pack --dry-run --json
```

## Isolated profile composition (macOS, no real ~/.dsh)

```sh
export DSH_HOME=/tmp/dsh-context-guard-smoke
DSH=/path/to/dsh
"$DSH" plugin --profile web add "file:/abs/path/to/dsh-context-guard"
"$DSH" --profile web --dump-config | grep context-guard
"$DSH" plugin --profile headless add "file:/abs/path/to/dsh-context-guard"
"$DSH" --profile headless --dump-config | grep context-guard
```

Verified result: both profiles contain `id: context-guard, name: dsh-context-guard` in the composed tree.

## Native load

A real headless boot loads the plugin and advances to the model call; it stops at `MISSING_CREDENTIAL` when no provider key is configured. That is the expected boundary for a load check and is unrelated to plugin correctness.

## Verified

- Web UI command rendering and the `/context-guard on|off|status|diagnose` subcommands produce the expected `command/run`/`command/done` (round-5 isolated profile); `/context-guard diagnose` was re-verified in round-8.
- A complete macOS headless task in an isolated profile created one artifact,
  read it back as durable evidence, rejected an incomplete first binding, then
  certified the complete requirement and acceptance set before `turn/end`.

## Native platform acceptance

- macOS: an isolated real-model headless task used a supported POSIX shell
  write and an independent read, then persisted a certified checkpoint before
  the completed turn.
- Windows: an isolated real-model task used
  `pwsh Set-Content -LiteralPath` and an independent read, then persisted a
  certified checkpoint before the completed turn.

Both final-SHA runs used clean public checkouts and isolated `DSH_HOME`
directories. They establish native behavior for the bounded v0.1 command
subset; they do not claim support for shell or PowerShell syntax outside the
subset documented in `COMPATIBILITY.md`.

## Public-package profile readback

On macOS, the published `dsh-context-guard@0.1.0` npm package was installed into a real DSH Web profile through the pinned `codex-sync` plugin reconciler. A second dry run was a strict no-op; direct package and bundle readback reported version `0.1.0`; `dsh --profile web --dump-config` included the `context-guard` bundle; and the restarted Web command directory exposed `/context-guard`, whose `status` subcommand returned a valid projection summary.

This verifies public-package consumption and real-profile loading on macOS. It does not replace the isolated model-task evidence above and does not claim a second Windows run from the public npm package.
