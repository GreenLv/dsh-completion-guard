# Private-ledger writer lock: generation protocol

Status: normative implementation contract for `src/domain/private-ledger.ts` (0.8.3, F1/R2 repair round). Written before the implementation; the concurrency tests assert these transitions.

## 1. Requirement

Appends to the provider-invisible ledger are serialized per ledger root. A writer that crashed while holding the lock must not block future appends forever (BUG-01), and no recovery step may ever remove or move a lock file created by another live actor (R2). The protocol must rely only on portable primitives: `mkdir`, exclusive file creation (`O_EXCL`), unlink of one's OWN file, recursive directory removal, and pid liveness probes. PID reuse is treated conservatively: a recorded pid that answers alive is never recovered, so recovery may be delayed but never steals.

## 2. Directory layout

```
<ledger-root>/
  gen-<NNNNNNNN>/            generation directory, N = fixed-width counter
    .writer.lock             owner record {version, nonce, pid, hostname, created_at}
  session-anchors.v1.jsonl   (unchanged)
  <session>.jsonl            (unchanged)
```

The active generation is the generation directory with the LARGEST N that exists (`currentGeneration()` reads the root listing and takes the max). There is no pointer file and no rename in the protocol.

## 3. State machine

Actors: a writer process W; any number of would-be writers/recoverers (they are the same code path — recovery is not a separate role).

- `S0 empty` — no generation directory. `acquire()` mkdirs `gen-00000001` (atomic; concurrent creators: losers observe EEXIST and re-read current), then goes to `A`.
- `A acquire` — in the current generation G: `open('.writer.lock', O_WRONLY|O_CREAT|O_EXCL)`.
  - Success → write own owner record (nonce, pid, host), fsync → `V`.
  - `EEXIST` → read the lock record:
    - own nonce (possible after a retry that re-enters the same generation — see `V` fail path) → treat as failed re-entrant acquire, `V`.
    - record of a live owner, or a non-empty unknown/legacy/foreign-host/unparsable record, or a pid-liveness answer other than ESRCH → report `refused` (fail closed, diagnostics via `writerLockState`). No file is modified.
    - ZERO-LENGTH lock file → the creator died between O_EXCL creation and its owner-record write (F1 concurrency matrix observed this window). Treat as recoverable: go to `R`. Safety is NOT weakened by the possibility that the creator is still mid-write: a live acquirer never enters its critical section before `V`, and `V` compares against the current generation, so a premature advance makes the mid-write acquirer release its own file and retry in the new generation. The mid-write file itself is abandoned, never mutated.
    - record of a provably dead owner (same host, `kill(pid,0)` answers ESRCH) → `R`.
- `R recover` — mkdir `gen-N+1` (the next number after the current max; atomic, concurrent recoverers: exactly one creator succeeds, the rest proceed — see `V`'s re-read). This is the ONLY mutation recovery performs. The dead lock in `gen-N` is abandoned in place: it is never renamed, never unlinked. After the mkdir (whether it created the directory or lost the race to another recoverer), go to `A` (the re-read in `A`/`V` selects `gen-N+1`, which is empty, so the O_EXCL acquire succeeds or races fairly with other writers).
- `V verify` — after acquiring in G, re-read the current generation `G'`:
  - `G' == G` → linearization point passed: enter the critical section holding `HeldLock {dir: G, nonce}`.
  - `G' > G` → another actor advanced the generation between this actor's acquire and verify. Remove the actor's OWN lock file in G (nonce-conditional unlink: read the file, unlink only if the content still carries the actor's own nonce — a foreign file is never unlinked) and return to `A`.
  - `G' < G` → impossible (generations are created, never removed while current); treated as `G' == G` fail-closed is NOT needed because `currentGeneration()` takes the max; if the directory was pruned mid-flight (see §5) the actor re-reads and loops via `A`.
- `release(H)` — read `G/.writer.lock`; unlink only if the record still carries `H.nonce`. Conditional on content, and the only unlink in the protocol that targets a file the actor itself created.

## 4. Linearization and mutual-exclusion argument

Invariant I1: at most one lock file with live-owner content exists across all generations at any instant, and its generation is the current generation.

Proof sketch:
- A lock file gets live content only inside `A` in generation G, by an actor that then must pass `V` with `G' == G` before its critical section.
- `G' > G` can only be produced by `R` (a mkdir of a higher generation). `R` is reached only after observing generation G's lock content as dead (or the generation being absent), i.e. at a moment when NO live-content lock existed in G. An actor W holding G's lock has live content, so any concurrent `R` observation refuses and never advances. Hence a generation cannot advance while a live-content lock exists in it; when it advances, no live lock remains anywhere.
- Two concurrent recoverers both observing the dead lock both mkdir `gen-N+1`: mkdir is atomic, one succeeds; both then converge on the new current generation through `A`/`V`. Neither touches the dead file. (This closes the F1 race: the previous design moved/unlinked a PATHNAME that could have been re-populated by another actor between check and act; here recovery creates a NEW namespace and never mutates the old one.)

Invariant I2 (crash recovery / BUG-01): a crashed writer leaves its lock file with dead content in the then-current generation. The next acquirer observes EEXIST with dead content and advances the generation; the abandoned file never blocks anyone because acquisitions always target the current (new) generation. Recovery needs no separate lock, no quarantine rename, and no unlink of any file the recovering actor did not create.

Termination/liveness: every `V`-fail retry strictly moves the actor to a higher generation; a generation stops advancing once an actor holds its lock with live content (I1), so the retry loop reaches `V` success in finitely many steps. `R` cannot recurse: after one mkdir the new current generation is empty and ordinary `A` applies.

## 5. Bounded garbage (pruning)

Dead locks accumulate one file per crash inside old generation directories. The holder of the CURRENT generation's lock (inside its verified critical section) may recursively remove generation directories with N < current. Safety: by I1, a non-current generation cannot contain a live-content lock (it would have prevented the advance), so pruning cannot evict an active writer; a straggler that acquired but not yet verified holds live content, which likewise blocks any advance. A crash during pruning leaves the current generation intact (pruning never touches it).

## 6. Diagnostics and manual recovery

`writerLockState(root)` reports the current generation's lock: `absent` / `held` / `abandoned_recoverable` (same-host dead pid, ESRCH only) / `unknown_owner` (legacy empty file, foreign host, live pid incl. possible PID reuse, unparsable). Unknown owners still refuse fail-closed; a `gen-NNNNNNNN` directory itself is the recovery artifact and needs no manual action. The legacy root-level `.writer.lock` / `.writer.lock.stale` files from earlier versions are ignored by the protocol (and are not consulted by `writerLockState`).

## 7. Test obligations

The concurrency suite must (a) run four REAL child processes released simultaneously by a shared start barrier, (b) cover: writer-crash recovery, recovery-lock-holder death (a recoverer dying between mkdir and acquire), double recoverer, plain acquire/release interleave, PID reuse (live pid recorded), unknown/foreign owners, and (c) assert the final ledger chain is unique and contiguous. A deterministic counterexample for the PREVIOUS scheme (check-then-rename) is kept in the suite history via the protocol document reference, not as a live regression of removed code.


---

# Revision 2 (round 3): slot + pending + evict-intent protocol

The generation protocol above is RETIRED. Two real interleavings defeated it (both reproduced with production appends and real child processes in the round-3 review):

- L1: a recoverer that observed generation G1's owner dead paused; another writer legally advanced to G2 and entered its critical section; the paused recoverer then created G3 from a FRESH max-generation read and its prune deleted G2 while B still held it. The protocol's check (G1) and action (mkdir after re-reading the max) were not the same epoch.
- L2: a recoverer observed a ZERO-LENGTH lock (creator paused between O_EXCL and the owner-record write); while it was paused the creator finished writing, passed verification and entered its critical section; the recoverer's zero-byte observation then advanced the generation and evicted a live holder. Zero bytes do not prove death, and "fixed oldN+1" does not help: a delayed recoverer acts after the holder's verification regardless of how many times the holder verified.

Root cause: with a fixed slot name, EVERY recovery action (unlink/rename/rmtree) re-resolves the pathname at action time, so an observation made earlier can evict a DIFFERENT, live holder. No number of re-reads closes this — the pause can sit between the last read and the act.

## Revised state machine

Resources (all in the ledger root; no subdirectories, no generations):

- `slot.json` — THE holder. Present = exactly one writer is inside its critical section; its content is a hard link to a complete owner record `{version:3, nonce, pid, hostname, created_at}`. Invariant S1: while present, slot.json's CONTENT NEVER CHANGES (it is a hard link to a file the holder wrote before linking and never modifies afterwards); the holder identity changes only through full removal (holder release or verified recovery) followed by a new `link()`.
- `pending.<nonce>.json` — a candidate's own owner record, created O_EXCL, written, fsynced, then hard-linked to `slot.json` (atomic EEXIST admission) and unlinked again by its creator. A pending file carries NO authority.
- `evict-intent` — the recovery handshake, created O_EXCL; content records the creating recoverer `{nonce, pid, hostname, created_at}` and the dead nonce being evicted.

Writer critical-section entry: create pending → write owner → fsync → `link(pending, slot.json)`:
- success → holder (unlink the pending link is optional bookkeeping; the file itself is kept as the pending record and unlinked at release);
- EEXIST → read slot owner: live or not-provably-dead → remove own pending, refuse (fail closed); provably dead → recovery handshake below.

Recovery of a provably dead slot owner (same host, `kill(pid,0)` answers ESRCH):
1. Create `evict-intent` O_EXCL. Loser of the creation reads the winner's record: live creator → refuse this round (the creator will finish); dead creator → adoption: unlink the intent (idempotent; ENOENT harmless), recreate own intent, continue.
2. WITH the intent in place, read `slot.json` and finalize ONLY if its nonce equals the dead nonce being evicted: unlink `slot.json`, remove the dead holder's `pending.<deadNonce>.json` by name (identity-safe), remove the intent. If the slot's nonce differs (a new live holder linked meanwhile, or the slot was already recovered and re-linked), remove the intent and abort — the stale observation must not evict anyone.
3. Progress: a recoverer that dies holding the intent leaves a file whose creator is provably dead; the next actor adopts per step 1. A live creator always finishes (finalize or abort removes the intent).

Why this is race-free (linearization argument):

- Entry is `link()` with EEXIST: while slot.json exists, no second holder can be created; L1's "advance past a live writer" has no analogue — there is no generation to advance to, and the only mutation of the slot by a non-holder (recovery) is gated behind the intent handshake.
- A delayed recoverer cannot evict a live holder: its finalize step compares the slot's CURRENT nonce with the observed dead nonce and aborts on mismatch; between that read and the unlink the content cannot change (S1: content is immutable while present; the only way it changes is removal, which only this finalize performs once the nonce matches — a concurrent finalize of the SAME dead nonce is idempotent, second unlink gets ENOENT), and a NEW holder cannot appear between the read and the unlink because linking requires the slot to be absent and the intent's presence forbids... even if a writer races a link in its own check-then-link window, the link itself fails EEXIST while the dead slot is present; a link that SUCCEEDS implies the slot was absent, which implies the earlier finalize already removed it and this recoverer's read could not have observed the dead nonce after that point. The read and the dead slot's removal are therefore ordered: whoever reads the dead nonce removes exactly the dead holder.
- Zero-byte / mid-creation states carry no authority: a pending file is never linked by anyone but its creator, and a creator that dies leaves a pending file whose pid is provably dead — GC removes it BY NAME (identity-safe). There is no observable "empty lock" that could be mistaken for a holder: the slot only ever appears atomically via link of a complete record.
- Release: read slot.json; unlink it only if the record's nonce equals the releaser's own nonce; then remove the releaser's pending file by name.

## Legacy root locks (L3)

Version-2 and earlier writers kept a root-level `.writer.lock`. The v3 protocol never removes or rewrites legacy files, but their PRESENCE refuses acquisition: an empty/unparsable/foreign-host record reports `unknown_owner` (operator removes the file to finish the upgrade — it carries no ledger data), a same-host record whose pid answers alive reports `held`. Either way v3 writers refuse the shared write area while a legacy lock exists, so old and new writers never share the write section unsafely.

## Test obligations (round 3)

Deterministic, real-process interleavings must cover: (a) a recoverer whose dead observation is stale by the time it acts — it must abort and the live writer must finish; (b) a candidate paused in the pending phase must never enter while another writer holds, and must not be evicted; (c) kill inside the critical section, then recovery; (d) barrier-released multi-process contention with a unique contiguous chain; (e) legacy root locks refuse (empty, live v2, foreign) with bytes untouched; (f) a getter-bearing (accessor) snapshot is NOT eligible for the projection fast path (see F2).


---

# Revision 3 (round 4): arbitration log with optimistic concurrency control

Revision 2's evict-intent was defeated by the same root cause as generations and rename: a recovery action applied to a REUSED PATHNAME on the basis of an EARLIER observation. Deterministic round-4 counterexamples: (S1) A observes an intent creator dead, pauses; the real creator B adopts, finalizes, links a new slot and enters its critical section; A's delayed intent-removal deletes B's live intent and A's slot-unlink then deletes B's live slot — the read of slot.json and the unlink are two operations on a pathname that other actors mutate in between. (S2) the intent file itself is created empty (O_EXCL) before its record is written; a crash in that window wedges automatic recovery forever. No protocol built from "observe pathname state, then act on the pathname" can close these: the pause can always sit between observation and action, and no amount of re-reading helps.

## Linearization through an append-only arbitration log

The round-4 protocol removes pathname mutation from the mutual-exclusion path entirely. All authority decisions are RECORDS appended to one file, `arbitration.log`, with these atomicity assumptions (the same class of assumptions the protocol already makes for O_EXCL and fsync):

- A1: a single `write()` of a complete record to a file opened O_APPEND is placed atomically at the end of the file on the local filesystems in scope (ext4/APFS/NTFS), so concurrent appends interleave whole records.
- A2: a read of the whole file after one's own append returns a total order of records that includes every earlier append and one's own.

Every record is one JSON line `{v:3, op, nonce, pid, hostname, created_at, prev?}`:

- `claim {prev}` — prev is the nonce of the holder the claimant OBSERVED (or null for an empty slot). Effective in the replay ONLY if the replay's current holder equals `prev`; otherwise the record is stored but has no effect. This is an optimistic CAS: the observation travels inside the action, and the total order of the log adjudicates it.
- `release {prev}` — effective only if the current holder equals `prev` (the releaser's own nonce).
- `evict {prev}` — effective only if the current holder equals `prev`. The actor appends it only after an ESRCH liveness probe of the recorded holder returned "does not exist". ESRCH is a fact about the pid at probe time; a later pid reuse concerns a DIFFERENT process and cannot resurrect the dead holder, so the eviction remains correct.

Replay rule (deterministic, total order by file offset): `holder := null`; for each record in order — claim: if `holder?.nonce === prev` (or `prev === null && holder === null`) then `holder := {nonce, pid, hostname, created_at}` else no effect; release: if `holder?.nonce === prev` then `holder := null`; evict: if `holder?.nonce === prev` then `holder := null`.

## Protocol

Admission (writer W):
1. Legacy gate (L3): if a root-level `.writer.lock` exists in v2 form with a live same-host pid — or in any unparseable/foreign/anonymous form — REFUSE. A structured v2 record whose pid answers ESRCH is removed by name (the v2 writer is gone; v2 had no self-recovery, so removing a provably dead v2 lock is the migration step) and acquisition continues.
2. Create the v2-COMPATIBLE lock `​.writer.lock` O_EXCL and write a version-2-shaped owner record with the claimant's pid. This is the bidirectional upgrade barrier: a live v2 writer refuses because the file exists; a v3 writer refuses while a live/unknown v2 record exists. The file is held for the whole critical section and removed at release (or left behind on crash, where step 1's ESRCH rule recovers it).
3. Append `claim {prev: observedHolder}` where observedHolder is read BEFORE the append; read the log back (A2) and replay. If the replay's current holder is W's own nonce → W is inside the critical section. If not (the optimistic CAS lost — someone else claimed, recovered or evicted first) → remove W's own `.writer.lock` (nonce-conditional) and REFUSE (or retry from 1; callers treat refusal as contention).

Release: append `release {prev: own nonce}`, read back, verify the holder is gone; remove the v2 `.writer.lock` (nonce-conditional).

Recovery: admission's replay shows a current holder whose pid answers ESRCH → append `evict {prev: that nonce}` → read back → retry the claim with the new observed holder. The eviction is a LOG RECORD, not a pathname deletion: L1's delayed recoverer appends `evict {prev: D}` after B already holds — the replay evaluates it against the CURRENT holder B, does not match, and the record has no effect. B is never touched. L2's paused candidate has no log record at all before its link-equivalent (its claim simply lands whenever it lands and is adjudicated by the same rule); there is no empty-file window because an append is a single complete record (S2).

## Why the counterexamples are structurally impossible

- No pathname in the mutual-exclusion path is ever removed or replaced on the basis of an earlier observation. The only pathname action is the v2-compat `.writer.lock`, whose lifecycle (create O_EXCL / remove own by nonce / remove a provably dead v2 record) is itself bidirectionally verified (S3).
- Every authority decision is the replay of a TOTAL ORDER of append records; an actor's observation is carried inside its record (`prev`) and adjudicated at that record's position in the order. A pause between observation and action moves the record's position and therefore its verdict — the loser exits instead of evicting.
- A crash at ANY point leaves at most a suffix of complete records (A1) or a torn last line, which the replay ignores (a line that does not parse terminates the replay). The next actor's evict recovers a dead holder's claim (BUG-01); an empty-file wedge cannot exist (S2).

## Bounded growth

On release, a holder whose log exceeds a record cap writes a compaction file containing only its own baseline claim and renames it over the log. The rename window can drop a concurrent claim — the dropped writer's read-back then shows it is not the holder and it exits: fail-closed, never two holders.

## v2/v3 bidirectional matrix (S3)

| order | outcome |
| --- | --- |
| v3 holds → v2 appends | v2's O_EXCL on `.writer.lock` fails (v3 created and holds it) → v2 refuses |
| v2 holds → v3 appends | v3 reads a structured v2 record with a live pid → refuses |
| v2 crashes → v3 appends | v2 record pid answers ESRCH → v3 removes it by name and proceeds (the migration step) |
| v3 crashes → v2 appends | v2 refuses on the leftover file (as v2 always did; the operator/v3 cleans it) — upgrade direction only |


---

# Revision 3.1 (round-5 corrections to the arbitration log)

Round-4 deterministic counterexamples showed three races in the Revision 3 protocol's PERIPHERY (the log itself was sound): (L4.1) the legacy-barrier recovery unlinked `.writer.lock` by pathname on a stale dead-owner observation, deleting another writer's live barrier and then claiming over it; (L4.2) the torn-tail repair truncated the log between a concurrent writer's append and its read-back, revoking an already-granted claim; (L4.3) release-time compaction renamed a compacted log over a concurrent writer's already-granted claim and re-installed the released holder. Corrections, all confined to the periphery:

1. **Claims require an EMPTY slot.** The replay grants `claim` only when the current holder is null. A claim naming a holder that is still present is recorded but INEFFECTIVE, and the claimant exits fail-closed on its read-back. The direct-claim-over-a-live-holder path is therefore closed by the replay itself, independent of any barrier state.
2. **Legacy barriers are adopted, never removed.** A `.writer.lock` left by a crashed v2 writer is a complete admission obstacle for v2 writers; the v3 protocol neither needs to remove it nor may (any removal by pathname is a TOCTOU). Admission classifies the file: legacy/unparseable/foreign → refuse; live pid → refuse; provably dead pid (ESRCH, same host) → ADOPT — leave the file untouched and proceed to the log claim. The adopted file keeps blocking v2 writers for the whole tenure; the holder's release does not remove it (it never owned it). A dead v2 lock therefore persists and keeps new v2 writers refused until an operator removes it after verifying that no Guard process runs — the explicit, verifiable exclusive-migration constraint for mixed fleets. v3 writers are unaffected: every later admission re-adopts the same dead record.
3. **No truncation.** The torn-tail repair (truncate to validBytes) is removed: a truncate could revoke a concurrently appended, already-granted claim. Instead the replay SKIPS unparseable lines and continues with later complete records (a torn record never took effect, so skipping revokes nothing), and an appender whose log does not end at a record boundary prepends a newline before its record so later records stay line-aligned. The residual race on the end-of-file check can only misalign a record with an ACTIVE holder — the log replay then refuses that claimant (fail-closed) — and can never revoke the active holder or admit two holders.
4. **Compaction only inside the tenure.** Release-time compaction is removed. While a writer holds, no concurrent record can be effective (claims need an empty slot; evicts need a dead holder, which the live holder is not; other writers refuse without appending), so the holder may compact the log to a state-equivalent baseline (its own claim) with the rename window unable to drop an effective record or change the holder. Readers see the old or the new file; both replay to the same holder.

Admission now reads: classify the legacy barrier (refuse on unknown/live/foreign; adopt on provably dead) → read the log holder (refuse on live/foreign; append evict on provably dead → re-read) → append claim → read back → enter only if the holder is oneself; otherwise remove only a barrier one created oneself (nonce-conditional) and exit fail-closed. Release: append release → remove only one's own created barrier (an adopted file stays). Every pathname removal in the protocol is therefore nonce-conditional on a file the actor created in the same critical section; no removal is ever performed on the basis of an observation of somebody else's file.
