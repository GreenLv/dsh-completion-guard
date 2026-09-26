# Porting Notes

The DSH implementation started from `GreenLv/codex-context-guard` v0.8.8 and
replaced the Codex platform layer. That version is provenance, not the current
compatibility claim. Shared behavior now advances through pinned conformance
fixtures and an explicit delta ledger.

| Area | Treatment |
| --- | --- |
| canonicalization, hashing, IDs | Port to TypeScript |
| contract capture and supersession | Port as pure domain functions |
| evidence and proof binding | Adapt to DSH durable tool-result events |
| recovery and stop policy | Adapt to DSH agent lifecycle |
| Codex hooks, cache manager, Python runtime | Delete from DSH runtime |
| portable protocol and digest fixtures | Mirror exact upstream bytes and verify their hashes |
| product-specific or newer Codex behavior | Record explicitly in the delta ledger before porting |

## Current host boundary (0.8.0)

Version 0.8.0 supports only DSH `0.1.7-rc.2`, Cordis `4.0.4` and the exact 46-package core graph. It reads Session V4 and flat ToolMessage results, awaits scoped Agent creation and checks Jobs against the same SessionId. Mapped package bytes and actual critical dependency paths must agree. The [compatibility guide](COMPATIBILITY.md) defines the current contract.

## Historical host boundary (0.6.0)

Version 0.6.0 admits exactly DSH `0.1.5-rc.2` and `0.1.5-rc.1` and keeps no path back to the
older host or ahead to an unregistered host. Concretely:

- Session history is read only through the DSH Session V3 `snapshotEvents()`
  API. The V2 `events` getter is gone, and a session that does not expose the
  V3 API is refused instead of being treated as an empty log.
- Dispatch evidence comes from the current `tool/ptc-dispatch-start` and
  `tool/ptc-dispatch` vocabulary. The retired `tool/code-dispatch*` names are
  ignored, so an old log cannot mint evidence under the new protocol.
- A V3 `system/message` is a plugin-sourced surface node, never root
  authority, and a compaction checkpoint message stays plugin context.
- Guard never resumes a Goal the user paused: its Goal access surface has no
  resume entry point, and turn stopping yields while a Goal is paused, blocked,
  completed, or not yet read back.

The host identifier is the exact 33-row DSH core graph. The rc.1 verified-minimum
and rc.2 latest cohorts are registry-derived, and that
provenance is bound into the host-lock digest rather than inferred from a
version number.


## 0.6.0 shared-semantics port

The 0.6.0 line implements the C01–C12 contract from the shared DSH 0.6.0 /
Codex 0.14.0 plan. What was ported as shared semantics, and what was deliberately
replaced with a DSH-native mechanism:

| Shared requirement | DSH treatment |
| --- | --- |
| Root-input spans and coverage | Implemented over the original message bytes with `TextEncoder`, so offsets are UTF-8 byte offsets — never UTF-16 string indices |
| One interpretation view and one open set | Implemented as pure domain modules (`closure.ts`, `diagnostics.ts`); Codex's ledger is not copied |
| Trusted answer delivery | Bound to the DSH host's own `assistant/message` / `turn/end` structure; Codex maps the same criterion onto its own events |
| Work units with required descendants | Units are derived from the DSH message stream and are never persisted; Codex keeps its own work-unit state |
| Trusted user selection | Read from paired `tool/call` + `tool/result` round-trips of the host's question tool; the tool names are an audited cohort surface |
| Proof capability matrix | Shared kinds and subject/source/operation binding; the host surfaces are DSH-native (`native_read`, `shell`, `web`, `jobs`, `subagent`, `visual_capture`) |
| Explicit release tickets | A DSH-native reservation/settlement record in the plugin-notice channel plus a gate inside the Guard-owned action tool; Codex reuses its own release adapter and `PreToolUse` hook |
| Reason classes and migration report | Shared seven-class vocabulary and rule-set semantics; the record shapes are DSH-native |

Three porting decisions are worth stating explicitly, because the obvious
alternative would have been wrong:

- **No new session event types.** Delivery, units, selections, and approvals are
  derived facts. Only the release contract, reservation, and settlement need
  durable records, and those ride the plugin-notice `user/message` channel the
  host already persists and reloads.
- **The v1 proof manifest and digest domains are frozen.** The v2 kinds live in
  a new domain (`ccg.proofManifest.v2`), so an old record is read by the old
  rules and no golden vector changes. A port that widened `ccg.proofManifest.v1`
  would have silently rewritten another repository's parity contract.
- **Delegation is not a parent completion.** A subagent's result is recorded and
  marked bounded. This is deliberately weaker than treating a successful
  delegation as evidence, because the parent task's own work is not what the
  subagent did.

The DSH port derives guard state from native DSH session events, connects the
completion gate to Goal handling, and fails closed when it cannot verify the
host or evidence. Version 0.3.2 has passed same-package Web and Headless
lifecycle checks on macOS and Windows. This does not make the two products
interchangeable or imply full parity with Codex 0.9.5; current gaps are listed
in [`SEMANTIC_COMPATIBILITY.md`](SEMANTIC_COMPATIBILITY.md) and
[`upstream-deltas.json`](upstream-deltas.json).
