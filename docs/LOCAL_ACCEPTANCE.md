# Local Acceptance

Deterministic checks and an isolated DSH_HOME composition smoke. These establish source correctness and load correctness, not full runtime behavior.

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
