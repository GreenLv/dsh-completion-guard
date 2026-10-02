# 0.8.3 bounded tail-cost repair

The patch keeps one history fold and fresh authority evaluation. It changes
selection and pure parser storage, not the trust or completion contracts.

| Input family | Previous work | Revised work | Equivalence coverage |
| --- | --- | --- | --- |
| Newly captured items | Scan all accumulated items in each fresh-only pass and fixpoint round | Visit the insertion array, preserving order | Frozen 0.8.2 oracle prefixes; index differential; legacy, rebind and explicit scope suites |
| Core root coverage | Filter all coverage for each root | Build stable source buckets once, sort each selected bucket | Core conformance and frozen adapter oracle |
| Interpreted coverage | Scan all current/historical requirements and controls per span | Group requirements and validated controls by source once | Supersession, watermark, cross-unit and negative identity suites |
| Current action bases | Recompute across projection for each item | Compute once, group by item | Deterministic 80-item count assertion and oracle |
| Clause and mask parse | Entire cache reset at entry threshold | Evict oldest individual entries at accounted storage/entry limits | Pollution, oversized admission, eviction, old capacity cliffs and option identity |
| Model-facing text | Repeated descriptive prose | Shorter tool descriptions and v6 first guidance | Schema inventory and bilingual synthetic replay budgets; existing recovery/lifecycle suites |

Parser caches bind exact immutable text, and nondefault options bypass storage,
including nonenumerable/getter options. Clause callers receive independent
arrays, paths, interpretation and qualification objects on hits and misses.
The qualification singleton exposed by the old miss path cannot be modified
through these returned records. Cache storage is capped at 8 MiB for clauses
and 4 MiB for each mask cache, plus a 32768-entry cap. Accounted bytes include
UTF-16 keys/values and conservative entry overhead; they are not measured RSS.
FIFO admission costs amortized O(1) per entry. Working sets larger than these
budgets can still miss on repeated sequential scans; this is not a universal
latency SLA. Cloning adds linear work in the returned parse size.

Core buckets are invocation-local. Existing schema, duplicate ID, source,
watermark, invalidation and unit checks still decide validity. No final
permission decision is cached. A general incremental reducer remains deferred:
it needs a separate event/authority invalidation and prefix equivalence matrix.

Token budgets use JavaScript characters and UTF-8 bytes, not a tokenizer or
model usage. The synthetic four-input replay model includes registered input
and output schema inventory, guidance, boundary, recovery, prepare discovery,
detail/rejection, correction and checkpoint outputs. It does not estimate
provider prompt-cache hits or prove fewer real model rounds. JSON fields,
protocol notices, recovery priority, detail retrieval and pagination stay intact.
Existing content digest dedup and resume/compaction reset are retained.
