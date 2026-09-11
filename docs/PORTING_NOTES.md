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

## Current host boundary (0.5.2)

Version 0.5.2 admits exactly DSH `0.1.5-rc.2` and `0.1.5-rc.1` and keeps no path back to the
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

The DSH port derives guard state from native DSH session events, connects the
completion gate to Goal handling, and fails closed when it cannot verify the
host or evidence. Version 0.3.2 has passed same-package Web and Headless
lifecycle checks on macOS and Windows. This does not make the two products
interchangeable or imply full parity with Codex 0.9.5; current gaps are listed
in [`SEMANTIC_COMPATIBILITY.md`](SEMANTIC_COMPATIBILITY.md) and
[`upstream-deltas.json`](upstream-deltas.json).
