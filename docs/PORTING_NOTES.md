# Porting Notes

The DSH implementation ports deterministic Context Guard semantics from `GreenLv/codex-context-guard` v0.8.8 while replacing the platform layer.

| Area | Treatment |
| --- | --- |
| canonicalization, hashing, IDs | Port to TypeScript |
| contract capture and supersession | Port as pure domain functions |
| evidence and proof binding | Adapt to DSH durable tool-result events |
| recovery and stop policy | Adapt to DSH agent lifecycle |
| Codex hooks, cache manager, Python runtime | Delete from DSH runtime |
| multimodal assets, subagent provenance, rollover | Defer beyond 0.1.0 |

The DSH port now derives all guard state from natively persisted DSH session events (`command/run`, `user/message`, `tool/call`, `tool/result`, `tool/code-dispatch*`) instead of the removed custom event vocabulary, wires the completion gate to Goal interception and agent scoping, and enforces fail-closed certification. Full task execution in a live DSH web profile and Windows native acceptance remain the outstanding acceptance layers.
