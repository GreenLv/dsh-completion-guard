# dsh-context-guard

A task-contract and completion-certification layer for DeepSeek Harness (DSH).

Context Guard preserves requirements, prohibitions, acceptance criteria, later corrections, and bounded evidence. It can certify completion only when current successful evidence matches the current contract.

It is not a Goal, Todo, Memory, Compaction replacement, token-pruning tool, security sandbox, or semantic proof system.

## Status

Version 0.1.0 implements the core loop with 104 tests (85 domain/core): contract capture with concrete subjects and surfaces, conservative command-effect parsing, strict evidence matching, fail-closed completion certification, certificate re-verification on rebuild, Goal and turn-stopping gates, recovery injection, and durability handling. Native isolated real-model acceptance on macOS and Windows verified that a supported shell or PowerShell write plus an independent read can certify the matching contract before task completion.

Target: DSH `0.1.1-rc.2`.

## Design

- DSH owns Goal, Todo, Compaction, and continuation; Context Guard certifies completion.
- DSH Session events are the durable source of truth.
- Guard state is derived purely from natively persisted DSH session events (`command/run`, `user/message`, `tool/call`, `tool/result`); Context Guard appends no custom event types.
- Evidence is derived only from persisted tool results and is bounded and redacted.
- Unknown, failed, stale, or object-mismatched evidence cannot certify completion.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md), [`docs/PRIVACY.md`](docs/PRIVACY.md), [`docs/LOCAL_ACCEPTANCE.md`](docs/LOCAL_ACCEPTANCE.md), and [`docs/UPSTREAM_BASE.md`](docs/UPSTREAM_BASE.md).

## Development

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run lint
pnpm run build
pnpm pack --dry-run --json
```

The source repository is public. Package and marketplace availability are verified separately from source and native acceptance.
