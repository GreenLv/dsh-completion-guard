# Compatibility

The current development target is pinned, not a floating claim.

## Target

- DeepSeek Harness: `0.1.1-rc.2`
- Cordis: `4.0.1`
- Node: `>= 22`
- pnpm: `>= 11`

The DSH host is a developer preview that declares breaking changes. A source build does not establish native acceptance; each profile and platform is verified separately.

## Loader contract

The package exposes a named `apply(ctx)` function and a named `inject` array (`['sessions', 'commands']`) with no default export. Its `dsh.bundle.patch` points at `cordis.patch.yml`, which inserts the `context-guard` bundle row.

## Peer dependencies

Runtime packages are host-provided and declared as peer dependencies: `@deepseek-ai/cordis`, `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-commands`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-tools`.

## Verified surfaces

- `dsh --profile web --dump-config` and `--profile headless --dump-config` both include `context-guard`.
- A real headless boot loads the plugin (apply, `ctx.sessions` access, and listener registration succeed) and only stops at missing provider credentials.

Full task execution in a live DSH web profile (with model credentials) and Windows native acceptance are not yet verified; the slash command renders in the Web command directory and its on/off/status/diagnose subcommands produce the expected `command/run`/`command/done`. The domain loop itself (capture, matching, certification, gates) is covered by 54 unit tests with the fail-closed invariants below asserted as regressions.
