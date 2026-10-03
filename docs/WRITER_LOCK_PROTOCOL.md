# Private-ledger writer lock

This document describes the current 0.8.4 protocol (Revision 3.2). It replaces the generation, slot/intent and earlier arbitration designs recorded in Git history. Those earlier designs are not operational instructions.

## Purpose and limits

Only one writer may append to a ledger root at a time. A crashed same-host writer with a complete owner record must be recoverable. Unknown owners, foreign hosts and PIDs that cannot be proved dead are refused. Only ESRCH proves death; PID reuse can delay recovery but must not authorize eviction of a live process.

The protocol targets local filesystems supporting exclusive creation, hard links, append and atomic same-directory rename. Its arbitration model assumes that one complete record write with O_APPEND is ordered with other appends, and a subsequent read observes that order. This is a filesystem assumption, not evidence of native Windows or macOS acceptance; those platforms must be validated separately. A filesystem without hard-link support cannot use this admission path.

## Files and authority

| File | Role |
| --- | --- |
| `.writer.lock` | Complete v2-shaped owner record; excludes older writers. |
| `pending.<nonce>.json` | Unique preparation file; has no admission authority. |
| `arbitration.log` | Ordered claim, release and eviction records; replay determines the current holder. |
| `arbitration.log.compact` | Temporary replacement written by the current holder during compaction. |

A record identifies its nonce, PID and hostname. Pending filenames are unique per attempt and are not reused by the protocol. The ledger contents and shared anchors remain separate from these coordination files.

## Admission

1. Inspect pending records. Delete only complete records whose creator is provably dead on this host. Leave live, foreign and unparseable pending files untouched; they do not block admission.
2. Classify `.writer.lock`. Unknown, foreign or live owners refuse admission. Adopt a complete same-host dead record without modifying or deleting it. If no barrier exists, preparation and publication below are required.
3. Replay the arbitration log. Refuse a live or foreign holder. For a provably dead holder, append an eviction naming that holder's nonce, then retry classification.
4. If a barrier is needed, create a unique pending file with O_EXCL, write the complete owner record and fsync it. Publish it with `link(pending, .writer.lock)`. A successful link exposes the complete inode atomically; EEXIST loses publication and causes reclassification. Never publish an empty preparation file.
5. Append a claim and read the log back. Enter only when replay identifies this attempt's nonce as holder. An unsuccessful claimant removes only its own published barrier after matching its nonce, and its own pending file. An adopted barrier stays untouched.

The barrier and claim use the same nonce. No process automatically removes an observed dead barrier to make room for a replacement.

## Replay and linearization

Replay starts with no holder. A claim grants ownership only when the slot is empty. Release and eviction clear the holder only when their expected previous nonce matches the current holder. An eviction is submitted only after a same-host ESRCH check. A delayed eviction of D therefore cannot remove a later holder B.

Under the append-order assumptions, a successful claim takes effect at its position in the log. Its readback confirms admission; it does not authorize replacing a live holder. Losing claims remain ineffective in that replay order.

Unparseable lines are skipped. Appenders prepend a newline when the observed file does not end at a line boundary. The protocol never truncates the log during tail repair. The parser also accepts a complete final JSON record without a newline; incomplete pending files have no role in this replay.

## Release and compaction

Release appends a record naming the writer's own nonce. It then removes only a barrier it published itself, after matching that nonce, and removes its own pending filename. Adopted barriers remain.

Above the record threshold, the current writer compacts immediately after verified admission, before returning the held lock. The replacement contains the current holder's baseline claim. Compaction occurs during that holder's tenure, not after release. Concurrent stale claims and evictions cannot change that live holder under the admission rules. Readers see either the preceding log or the replacement, with the same holder. Do not move compaction after barrier removal or replace the baseline with a released owner.

## Crash recovery and older versions

| Crash point or state | Subsequent behavior |
| --- | --- |
| Before pending write, or during partial write | Only an inert pending file remains; other writers can proceed. Unparseable leftovers remain on disk. |
| Complete pending, before link | No barrier was published; a dead creator's complete pending record may be collected. |
| After link, before claim | The barrier contains a complete dead owner; a later writer adopts it and claims the empty slot. |
| After claim | A later writer adopts the barrier, evicts the provably dead log holder and retries admission. |
| Old writer holds `.writer.lock` | The new writer refuses while its owner is live or unknown. |
| New writer holds or adopts `.writer.lock` | Old writers fail exclusive creation and refuse. |

An adopted dead barrier continues to exclude older writers after the new writer releases. Returning to the older protocol requires an explicit maintenance window: stop every Guard process using that ledger root, verify exclusive access, then remove the stale barrier. Never delete a lock in a running shared profile based on its age alone. Unknown locks left by older versions require the same controlled investigation; they are not automatically recovered.

## Regression evidence

The concurrency suite exercises simultaneous child processes, stale evictions, live-holder exclusion, compaction during tenure and both upgrade directions. Deterministic production-child checkpoints cover pending before write, partial write, before link and after link before claim. Each checkpoint checks live-creator safety, kills and waits for that process, then requires subsequent appends to recover with a continuous ledger chain.

These tests establish the tested source behaviors. Candidate CI and native exact-artifact acceptance remain separate gates. No finite test suite constitutes a proof for arbitrary filesystems, external file mutation or power-loss durability.
