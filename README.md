# dsh-context-guard

A task-contract and completion-certification layer for DeepSeek Harness (DSH).

Context Guard preserves requirements, prohibitions, acceptance criteria, later corrections, and bounded evidence. It can certify completion only when current successful evidence matches the current contract.

It is not a Goal, Todo, Memory, Compaction replacement, token-pruning tool, security sandbox, or semantic proof system.

## Status

Pre-1.0 development. The core loop is implemented and covered by 41 tests: contract capture (always with a concrete subject/surface), evidence extraction and strict matching, fail-closed completion certification (empty evidence bindings and unrelated evidence are rejected), certification re-verification on rebuild, the Goal-completion gate, the turn-stopping gate, recovery injection, and durability handling. The plugin loads in a real DSH headless profile; full task execution in a live DSH web profile and Windows acceptance are not yet verified.

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

No remote publication or market registration is implied by local development.
