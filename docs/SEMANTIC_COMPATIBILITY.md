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
```

Authority rules:

- The portable conformance fixture and the digest v3 fixture are canonical in
  codex-context-guard. This repository holds byte mirrors whose SHA-256
  values are pinned in `tests/fixtures/conformance/UPSTREAM_PIN.json`; the
  vitest suite fails when any mirror drifts from its pinned hash.
- `UPSTREAM_PIN.json` records the upstream head at mirror time, the mirror
  date, and per-file hashes. The canonical files were created in an upstream
  working tree pending commit, so `canonicalCommit` is `pending` until the
  upstream commit that lands them exists; refresh the pin when re-syncing.
- New protocol cases discovered on the DSH side are turned into
  platform-neutral fixture cases upstream first; host-specific expectations
  never enter the shared fixture.
- `docs/UPSTREAM_BASE.md` records the historical v0.1.0 baseline. It is a
  historical fact, not a claim that DSH implements Codex protocol versions;
  current alignment status lives in this document and the delta ledger.

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
- The module is not yet wired into the runtime projection, checkpoint, or
  Goal complete paths. Wiring it into the certificate flow is v0.3.0 work and
  will follow the repository's versioning contract.

## Portable conformance fixture

`context_guard_semantics_v1.json` holds platform-neutral cases built from the
event vocabulary `root_message`, `delegated_message`, `tool_result`,
`checkpoint_request`, `boundary_request`, `completion_request`, `compact`,
`resume`, and `goal_change`, with bounded expectations (`completed`,
`completion_allowed`, `force_continue`, `pending_preserved`, `boundary`,
`integrity`, `reason_codes`). All content is synthetic. DSH currently mirrors
the fixture; a DSH-side interpreter that replays the cases against the DSH
runtime is part of the v0.3.0 work and must not report skipped capabilities
as passes.

## Current alignment status (honest boundaries)

Implemented on the DSH side today:

- Digest v3 derivation and golden-vector agreement (deterministic tests).
- Byte-mirror integrity against `UPSTREAM_PIN.json`.

Planned for v0.3.0 and recorded as `not-implemented` in the delta ledger:
stop policy split (assistant prose diagnostic-only, safe-yield), the
`context_guard_boundary` tool with post-commit disarm, checkpoint evidence
diagnostics, semantic action and target binding with minimal state readback,
Goal capability gating with the supported-version manifest, and command
permission hardening. These are alignment targets, not shipped behavior; no
completion or parity claim covers them yet.

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
