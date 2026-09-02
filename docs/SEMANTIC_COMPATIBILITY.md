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
manifests/action-manifest.v1.json
manifests/supported-host.v1.json
```

Authority rules:

- The portable conformance fixture and the digest v3 fixture are canonical in
  codex-context-guard. This repository holds byte mirrors whose SHA-256
  values are pinned in `tests/fixtures/conformance/UPSTREAM_PIN.json`; the
  vitest suite fails when any mirror drifts from its pinned hash.
- `UPSTREAM_PIN.json` records the upstream head at mirror time, the mirror
  date, and per-file hashes. Its current `canonicalCommit` is the landed
  upstream commit `b59fcfe1aaf8ead3f0438bc67dc7f725c869a473`; refresh the pin
  whenever the mirrors are re-synced.
- New protocol cases discovered on the DSH side are turned into
  platform-neutral fixture cases upstream first; host-specific expectations
  never enter the shared fixture.
- `docs/UPSTREAM_BASE.md` records the Codex v0.8.8 source used for the first
  DSH v0.1.0 port. It is a historical fact, not the current alignment claim;
  current status lives in this document and the delta ledger.

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
- Version 0.3 wires the module into checkpoint creation/replay and the
  Guard-owned Goal-complete gate. Certificates freeze the full versioned field
  table, including session and host identity, and are authoritative only after
  the tool result persists and re-derives exactly.

## Portable conformance fixture

`context_guard_semantics_v1.json` holds 37 platform-neutral cases built from the
event vocabulary `root_message`, `delegated_message`, `tool_result`,
`checkpoint_request`, `boundary_request`, `completion_request`, `compact`,
`resume`, and `goal_change`, with bounded expectations (`completed`,
`completion_allowed`, `force_continue`, `pending_preserved`, `boundary`,
`integrity`, `reason_codes`). All content is synthetic. The DSH-side portable
runner executes every mirrored case without skips and compares the bounded
result contract; it does not translate a missing capability into a pass.

## Current 0.4.0 alignment status

The semantic implementation described here is present in the DSH `0.4.0` implementation baseline `ffc6fe9e1246a815f0bb630943c59d14b6505716`. The seven package-shipped documentation files for the 0.4.0 candidate have passed their local gates. Their exact containing commit is bound by the post-commit candidate handoff rather than by this document. The shared-contract reference is the Codex `0.10.0` source at `e4fccf690bcbc2be79d0b8d42a1a269f87072120`; this covers only the named contracts, not full product parity.

The 0.4.0 implementation baseline keeps the v0.3 digest and conformance work and adds:

- Proof obligations that must name a current pending item and use evidence matching the requested kind, surface, subject, operation, and outcome.
- Bounded subject readback, scope coverage, state verification, and replayable `sessionQuery` state.
- Fail-closed rejection for tampered asset or scope digests, empty subject sets, and evidence imported from another session.
- The alpha.3 host cohort as the implementation baseline: DSH `0.1.2-alpha.3`, dshmarket `1.39.0`, and Cordis `4.0.2`.

Retained from v0.3.0:

- Digest v3 derivation, byte-mirror pinning, and 29-vector agreement.
- All-case portable semantic fixture runner implemented as a thin adapter over production derive/checkpoint/boundary/Goal/stop functions, without fixture-ID rewrites or skipped cases.
- Assistant-prose diagnostic-only stop decisions and typed boundary
  qualification/effectuation with phase-specific fault results.
- Exact semantic action/target binding, explainable checkpoint rejection, and
  resolution/effect/state role closure for all ten stateful actions.
- Exact paired optional Goal state/tool peers, supported-host/action manifests, injected active
  graph identity, unknown-host fail-closed behavior, and pre-mutation gating of
  the Guard-owned `update_goal(action=complete)` path.
- Legacy generic-run and unprovable-authority fail-closed migration behavior.

This is not a full product-parity claim. It does not copy the Codex private ledger, Hook lifecycle, cache, or installer, and it cannot prevent all trusted in-process Goal/session bypasses.

Main CI run `33540907051` passed the DSH implementation baseline. The old alpha.3 tgz from that commit remains historical exact-byte evidence: native macOS Web and Headless passed, while native Windows is `blocked` because Web did not prove a changed boot ID and Headless was not run after the stop rule applied.

The finalized documentation changes packaged bytes and supersedes the old alpha.3 tgz. The next canonical tgz must be generated from a candidate commit that contains this documentation and accepted natively as a new exact artifact; the candidate handoff binds its exact commit, and no result from the old SHA transfers. Tag, npm, GitHub Release, and public readback remain incomplete or not authorized. Historical v0.3 native and publication evidence remains valid only for its recorded versions; see [`LOCAL_ACCEPTANCE.md`](LOCAL_ACCEPTANCE.md).

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
