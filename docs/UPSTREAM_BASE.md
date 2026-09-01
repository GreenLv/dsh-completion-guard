# Upstream Base

This repository ports deterministic semantics from an existing Codex product; it is a new, independently owned repository with a fresh history.

## Historical starting point

- Repository: `https://github.com/GreenLv/codex-context-guard`
- Version: `v0.8.8`
- Tag object: `827602ca96653a53c00e9fae088bb46003509dc6`
- Peeled source commit: `e661370442183913b717ec2535609377bbb8664a`
- License: Apache-2.0
- Key contracts: private state schema 7, Proof protocol 1.0.0, Stop protocol 1.1.0

These values identify the source used for the first DSH port. They do not say
that current DSH behavior stops at Codex v0.8.8 or fully matches a later Codex
release. Current shared behavior and remaining gaps are tracked in
[`SEMANTIC_COMPATIBILITY.md`](SEMANTIC_COMPATIBILITY.md),
[`upstream-deltas.json`](upstream-deltas.json), and the pinned conformance
fixtures.

## Reused vs replaced

Reused as behavior: canonicalization, hashing, stable identity, requirement/acceptance/prohibition capture, append-only supersession, evidence outcome classification, subject/surface matching, proof and stop semantics, recovery priority, completion classification.

Replaced: the Codex Hook runtime, Python subprocess, plugin cache installer, and `PLUGIN_DATA` state path. The DSH runtime is TypeScript over the Session event log; it does not use the Codex Hooks bridge.

## Not copied

Codex installer/manager code, Hook cache lifecycle, private runtime data, transcripts, credentials, and commit history are intentionally absent.
