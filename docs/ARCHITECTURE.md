# Architecture

Context Guard separates DSH-owned execution from Guard-owned certification.

## Responsibility boundary

| Module | Owns |
| --- | --- |
| DSH Goal | Persisted objective, automatic goal rounds, pause/resume/block/complete |
| DSH Todo | Lightweight current plan display |
| DSH Compaction | Model-visible history reduction without corrupting tool-call structure |
| Context Guard | Per-item task contract, revisions, evidence binding, and completion certificate |

Context Guard does not own Goal, Todo, Compaction, or continuation. It intervenes when completion is claimed without a valid certificate.

## Durable state model

The effective plugin configuration and the DSH Session append-only log are the inputs to the rebuildable Guard projection. Context Guard **appends no custom session event types**: the persisted event vocabulary is harness-owned and the current persistence layer refuses unknown event types. The `activation` configuration supplies the initial enablement state, while all later session state is derived from the natively persisted events DSH already writes:

- effective plugin configuration — initial enablement (`opt-in` starts disabled; `always` starts enabled before log replay);
- `command/run` — later enablement (`/context-guard on|off|clear`) and epoch transitions;
- `user/message` — captured contract clauses;
- `tool/call` + `tool/result` — bounded evidence and completion-certificate attempts.

The in-memory `GuardProjection` is a rebuildable cache: `deriveProjection` applies the effective activation configuration, replays the native log deterministically, recomputes every contract, evidence, and certificate, and flags `corrupt` when a recorded certificate no longer re-derives from the evidence in the log. The projection and its evidence are session-scoped: a new DSH session starts a new projection and cannot import, look up, or certify evidence IDs from another session. A completed workflow that needs a certificate must therefore produce its evidence and call `context_guard_checkpoint` in the same session. Under `always`, replay begins enabled; changing an existing profile from `opt-in` to `always` can therefore bring earlier persisted user messages into the derived contract. A recorded `/context-guard off` disables capture from that point until a later `on`. A recorded `/context-guard clear` supersedes every pending requirement and acceptance under a `CLEAR:<revision>` sentinel (prohibitions are retained) and bumps the contract revision, so a fresh empty-binding checkpoint can certify while the guard stays enabled. Captured contracts always carry a concrete subject/surface, so no unrelated evidence can close a requirement.

## Synchronization

The runtime rebuilds the projection from the log before each step. Before evidence is produced, the runtime awaits `ctx.sessions.flush(session)`; if no durability listener participated, evidence is demoted to `unknown`, which fails closed.

Evidence is produced only from persisted `tool/call` + `tool/result` pairs. Guard never inserts context between a Code Mode sub-call and its durable result.

## Domain pipeline

1. `classifyUserInteraction` drops session-layer utterances before capture: bare progression/acknowledgement phrases (`继续`, `continue`), meta questions (`这个收尾具体要做什么`, `是不是bug`), and meta comments/objections. The classifier fails closed — an artifact path, an explicit method, or a non-negated operation verb always keeps the message (or the individual clause inside a mixed message) a captured instruction.
2. `classifyClause` / `captureClause` classify the remaining direct human message into requirement, acceptance, or prohibition.
3. `evidenceFromPersistedToolResult` maps a persisted tool result to bounded evidence with capability, subject, and surface, using the tool's structured `meta` and parsed arguments.
4. `evidenceMatchesItem` requires a verifying capability (filesystem-read, filesystem-edit, web-fetch, deterministic-check) and a matching subject/surface before an enforced item can close.
5. `certifyCheckpoint` binds evidence to items and emits a certificate bound to epoch, contract revision, and digests.
6. `goalCompletionDenial` rejects `update_goal(action=complete)` without a current certificate. The gate has no bypass; the documented remediation routes are `/context-guard off` (only after the user confirms the work is done), `/context-guard clear` (supersedes pending requirements/acceptances so a fresh checkpoint can certify), or a truthful `update_goal(action=blocked)`.
7. `decideTurnStopping` steers a turn that claims whole-task completion without a certificate, capped per turn.
8. `renderRecoveryPacket` re-injects open requirements after compaction, resume, enable, rejection, or integrity loss. Injection is content-deduplicated: a re-armed packet with unchanged content is injected once, while resume, compaction, an enablement transition, new evidence, or a new contract revision change or forget the digest and always re-remind.
