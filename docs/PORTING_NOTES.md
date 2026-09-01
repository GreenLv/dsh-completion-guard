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

The DSH port derives guard state from native DSH session events, connects the
completion gate to Goal handling, and fails closed when it cannot verify the
host or evidence. Version 0.3.2 has passed same-package Web and Headless
lifecycle checks on macOS and Windows. This does not make the two products
interchangeable or imply full parity with Codex 0.9.5; current gaps are listed
in [`SEMANTIC_COMPATIBILITY.md`](SEMANTIC_COMPATIBILITY.md) and
[`upstream-deltas.json`](upstream-deltas.json).
