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
